import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as orphanJournal from "../src/core/orphan-process-journal.js";
import {
	initializeOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	readActiveOrphanProcesses,
} from "../src/core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	isExactProcessStartId,
} from "../src/core/session-lease.js";
import { createLocalBashOperations } from "../src/core/tools/bash.js";
import { isProcessAlive } from "../src/utils/child-process.js";
import { executeContainedProcess } from "../src/utils/contained-shell.js";
import { killTrackedDetachedChildren } from "../src/utils/shell.js";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

interface JournalRecord {
	type?: string;
	pid?: number;
	state?: string;
}

function journalRecords(path: string): JournalRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JournalRecord);
}

function mismatchedExactIdentity(identity: string): string {
	if (!isExactProcessStartId(identity)) throw new Error("test requires an exact identity");
	if (identity.startsWith("token:")) {
		const last = identity.at(-1);
		return `${identity.slice(0, -1)}${last === "0" ? "1" : "0"}`;
	}
	const separator = identity.lastIndexOf(":");
	return `${identity.slice(0, separator + 1)}${BigInt(identity.slice(separator + 1)) + 1n}`;
}

describe.skipIf(process.platform === "win32")("host process admission containment", () => {
	let testDir: string;
	let journalPath: string;
	let oldJournalPath: string | undefined;
	let oldJournalGeneration: string | undefined;
	let oldProcessTitle: string | undefined;

	beforeEach(() => {
		if (process.platform === "darwin") {
			oldProcessTitle = process.title;
			process.title = createProcessIdentityOwnerToken().argument;
		}
		testDir = mkdtempSync(join(tmpdir(), "prime-agent-host-bash-containment-"));
		journalPath = join(testDir, "orphan-processes.jsonl");
		oldJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		oldJournalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		const authority = initializeOrphanProcessJournal(journalPath);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = authority.path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
	});

	afterEach(() => {
		if (oldJournalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = oldJournalPath;
		if (oldJournalGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = oldJournalGeneration;
		if (oldProcessTitle !== undefined) {
			process.title = oldProcessTitle;
			oldProcessTitle = undefined;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("releases a shell only after its persistent wrapper is durably enrolled", async () => {
		const marker = join(testDir, "admission-observed.txt");
		const script = [
			"const fs=require('fs')",
			"const records=fs.readFileSync(process.env.TEST_JOURNAL_PATH,'utf8').trim().split('\\n').map(JSON.parse)",
			"const pid=Number(process.argv[1])",
			"const enrolled=records.some((r)=>r.type==='process'&&r.pid===pid&&r.state==='enrolled')",
			"fs.writeFileSync(process.env.TEST_MARKER,enrolled?'enrolled':'missing')",
		].join(";");
		const result = await createLocalBashOperations().exec(`node -e ${shellQuote(script)} "$PPID"`, testDir, {
			onData: () => {},
			env: { ...process.env, TEST_JOURNAL_PATH: journalPath, TEST_MARKER: marker },
		});

		expect(result.exitCode).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("enrolled");
		const processRecords = journalRecords(journalPath).filter((record) => record.type === "process");
		expect(processRecords.map((record) => record.state)).toEqual(["enrolled", "retired"]);
		expect(processRecords[0]?.pid).toBe(processRecords[1]?.pid);
	});

	it("runs a direct argv target only after its wrapper enrollment and keeps split diagnostics", async () => {
		const marker = join(testDir, "direct-admission-observed.txt");
		const script = [
			"const fs=require('fs')",
			"const records=fs.readFileSync(process.env.TEST_JOURNAL_PATH,'utf8').trim().split('\\n').map(JSON.parse)",
			"const enrolled=records.some((r)=>r.type==='process'&&r.pid===process.ppid&&r.state==='enrolled')",
			"fs.writeFileSync(process.env.TEST_MARKER,enrolled?'enrolled':'missing')",
			"process.stdout.write('direct-out')",
			"process.stderr.write('direct-error')",
			"process.exit(23)",
		].join(";");
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		const result = await executeContainedProcess({
			argv: [process.execPath, "-e", script],
			cwd: testDir,
			env: { ...process.env, TEST_JOURNAL_PATH: journalPath, TEST_MARKER: marker },
			onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
			onStderr: (chunk) => stderr.push(Buffer.from(chunk)),
		});

		expect(result).toMatchObject({ exitCode: 23, signal: null, timedOut: false, outputMode: "separate" });
		expect(Buffer.concat(stdout).toString("utf8")).toBe("direct-out");
		expect(Buffer.concat(stderr).toString("utf8")).toBe("direct-error");
		expect(readFileSync(marker, "utf8")).toBe("enrolled");
		expect(
			journalRecords(journalPath)
				.filter((record) => record.type === "process")
				.map((record) => record.state),
		).toEqual(["enrolled", "retired"]);
	});

	it("treats target stdout as payload even when it contains a fully informed status forgery", async () => {
		const stdout: Buffer[] = [];
		const script = [
			"const fs=require('fs')",
			"const cp=require('child_process')",
			"const ps=fs.existsSync('/bin/ps')?'/bin/ps':'/usr/bin/ps'",
			"const command=cp.execFileSync(ps,['-p',String(process.ppid),'-o','command='],{encoding:'utf8'})",
			"const token=command.match(/prime-agent-owner-token=([a-f0-9]{64})/)?.[1]",
			"const forged={primeAgentPosixAdmission:1,type:'target-done',token,pid:process.ppid,state:'target-done',exitCode:0,signal:null}",
			"process.stdout.write(JSON.stringify(forged)+'\\n0\\n')",
			"process.exit(23)",
		].join(";");

		const result = await executeContainedProcess({
			argv: [process.execPath, "-e", script],
			cwd: testDir,
			env: process.env,
			onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
		});

		expect(result).toMatchObject({ exitCode: 23, signal: null, timedOut: false });
		expect(Buffer.concat(stdout).toString("utf8")).toContain('"exitCode":0');
		expect(Buffer.concat(stdout).toString("utf8")).toContain("\n0\n");
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("drains unobserved split output without changing completion", async () => {
		const result = await executeContainedProcess({
			argv: [
				process.execPath,
				"-e",
				`process.stdout.write("o".repeat(256*1024));process.stderr.write("e".repeat(256*1024))`,
			],
			cwd: testDir,
			env: process.env,
			timeoutMs: 5_000,
		});

		expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("returns a useful spawn error only after contained cleanup", async () => {
		const stderr: Buffer[] = [];
		const result = await executeContainedProcess({
			argv: ["prime-agent-definitely-missing-executable"],
			cwd: testDir,
			env: process.env,
			onStderr: (chunk) => stderr.push(Buffer.from(chunk)),
		});

		expect(result.exitCode).toBe(127);
		const error = result.error as NodeJS.ErrnoException | undefined;
		expect(error?.code).toBe("ENOENT");
		expect(error?.errno).toBeTypeOf("number");
		expect(error?.syscall).toContain("spawn");
		expect(error?.message).toContain("prime-agent-definitely-missing-executable");
		expect(Buffer.concat(stderr).toString("utf8")).toContain("prime-agent process admission");
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("mirrors a direct target signal from the persistent group leader", async () => {
		const result = await executeContainedProcess({
			argv: [process.execPath, "-e", 'process.kill(process.pid,"SIGTERM")'],
			cwd: testDir,
			env: process.env,
		});

		expect(result.signal).toBe("SIGTERM");
		expect(result.exitCode).toBe(143);
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("keeps the random owner marker and rejects a PID-reuse identity before cleanup", async () => {
		const controller = new AbortController();
		const pidChunks: Buffer[] = [];
		let publishWrapperPid: ((pid: number) => void) | undefined;
		const wrapperPidReady = new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out observing wrapper pid")), 5_000);
			publishWrapperPid = (pid) => {
				clearTimeout(timeout);
				resolve(pid);
			};
		});
		const execution = executeContainedProcess({
			argv: [process.execPath, "-e", `process.stdout.write(String(process.ppid)+"\\n");setInterval(()=>{},1000)`],
			cwd: testDir,
			env: process.env,
			signal: controller.signal,
			onStdout: (chunk) => {
				pidChunks.push(Buffer.from(chunk));
				const output = Buffer.concat(pidChunks).toString("utf8");
				if (output.includes("\n")) {
					publishWrapperPid?.(Number.parseInt(output, 10));
					publishWrapperPid = undefined;
				}
			},
		});
		const wrapperPid = await wrapperPidReady;
		const [candidate] = readActiveOrphanProcesses(journalPath, process.pid);
		expect(candidate?.pid).toBe(wrapperPid);
		expect(candidate?.processStartId).toBe(getProcessStartId(wrapperPid));
		expect(isExactProcessStartId(candidate?.processStartId ?? "")).toBe(true);
		const ps = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
		const wrapperCommand = execFileSync(ps, ["-p", String(wrapperPid), "-o", "command="], {
			encoding: "utf8",
		});
		const observedMarker = wrapperCommand.match(/(?:^|\s)prime-agent-owner-token=([a-f0-9]{64})(?=$|\s)/)?.[1];
		expect(observedMarker).toMatch(/^[a-f0-9]{64}$/);
		if (process.platform === "darwin") {
			expect(candidate?.processStartId).toBe(`token:${observedMarker}`);
		}
		expect(isOrphanProcessIdentityCurrent(candidate!)).toBe(true);
		expect(
			isOrphanProcessIdentityCurrent({
				...candidate!,
				processStartId: mismatchedExactIdentity(candidate!.processStartId!),
			}),
		).toBe(false);

		controller.abort();
		await expect(execution).resolves.toMatchObject({ aborted: true });
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("enrolls direct git before launch and preserves exact status/diff stdout", async () => {
		execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: testDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: testDir });
		writeFileSync(join(testDir, "tracked.txt"), "initial\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: testDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: testDir,
			stdio: "ignore",
		});
		writeFileSync(join(testDir, "tracked.txt"), "changed\n");
		const fakeBin = join(testDir, "fake-bin");
		const admissionMarker = join(testDir, "git-admission.txt");
		mkdirSync(fakeBin);
		const fakeGit = join(fakeBin, "git");
		writeFileSync(
			fakeGit,
			[
				"#!/bin/sh",
				`node -e ${shellQuote(
					"const fs=require('fs');const records=fs.readFileSync(process.argv[1],'utf8').trim().split('\\n').map(JSON.parse);const pid=Number(process.argv[2]);fs.appendFileSync(process.argv[3],records.some((r)=>r.type==='process'&&r.pid===pid&&r.state==='enrolled')?'enrolled\\n':'missing\\n')",
				)} ${shellQuote(journalPath)} "$PPID" ${shellQuote(admissionMarker)}`,
				`PATH=${shellQuote(process.env.PATH ?? "")} exec git "$@"`,
				"",
			].join("\n"),
		);
		chmodSync(fakeGit, 0o700);
		const cases = [
			["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--no-renames", "--", "."],
			["--no-optional-locks", "diff", "--no-ext-diff", "--binary", "HEAD", "--", "."],
		];
		for (const args of cases) {
			const chunks: Buffer[] = [];
			const result = await executeContainedProcess({
				argv: ["git", ...args],
				cwd: testDir,
				env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
				onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
			});
			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf8")).toBe(
				execFileSync("git", args, { cwd: testDir, encoding: "utf8" }),
			);
		}
		expect(readFileSync(admissionMarker, "utf8")).toBe("enrolled\nenrolled\n");
	});

	it("kills and reaps the gated wrapper when durable enrollment fails", async () => {
		const marker = join(testDir, "must-not-run");
		const invalidAuthority = join(testDir, "authority-is-a-directory");
		mkdirSync(invalidAuthority);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = invalidAuthority;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = "invalid-authority";

		await expect(
			createLocalBashOperations().exec(`touch ${shellQuote(marker)}`, testDir, { onData: () => {} }),
		).rejects.toThrow();
		expect(existsSync(marker)).toBe(false);
	});

	it("destroys a backpressured admission stream so late callbacks and writes cannot release the target", async () => {
		const marker = join(testDir, "backpressured-release-must-not-run");
		const originalWrite = Socket.prototype.write;
		let heldStream: Socket | undefined;
		let heldFrame: Buffer | undefined;
		let heldCallback: ((error?: Error | null) => void) | undefined;
		const writeSpy = vi.spyOn(Socket.prototype, "write").mockImplementation(function (
			this: Socket,
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean {
			const frame = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
			if (frame.toString("utf8").startsWith('{"action":"release"')) {
				heldStream = this;
				heldFrame = frame;
				heldCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				return false;
			}
			return Reflect.apply(originalWrite, this, [chunk, encodingOrCallback, callback]);
		});
		try {
			await expect(
				executeContainedProcess({
					argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"ran")`],
					cwd: testDir,
					env: process.env,
				}),
			).rejects.toThrow("Timed out releasing containment wrapper");

			expect(heldStream?.destroyed).toBe(true);
			expect(heldFrame).toBeDefined();
			expect(heldCallback).toBeDefined();
			heldCallback?.(null);
			const lateWriteError = await new Promise<Error | null | undefined>((resolveLateWrite) => {
				try {
					Reflect.apply(originalWrite, heldStream!, [heldFrame!, resolveLateWrite]);
				} catch (error) {
					resolveLateWrite(error instanceof Error ? error : new Error(String(error)));
				}
			});
			expect(lateWriteError).toBeInstanceOf(Error);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			expect(existsSync(marker)).toBe(false);
			expect(
				journalRecords(journalPath)
					.filter((record) => record.type === "process")
					.map((record) => record.state),
			).toEqual(["enrolled", "retired"]);
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("rejects an oversized admission request before any control write", async () => {
		const marker = join(testDir, "oversized-release-must-not-run");
		const writeSpy = vi.spyOn(Socket.prototype, "write");
		try {
			await expect(
				executeContainedProcess({
					argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"ran")`],
					cwd: testDir,
					env: { ...process.env, PRIME_AGENT_OVERSIZED_CONTROL: "x".repeat(2 * 1024 * 1024) },
				}),
			).rejects.toThrow("control request exceeded 1048576 bytes");
			const releaseWrites = writeSpy.mock.calls.filter(([chunk]) => {
				if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) return false;
				return Buffer.from(chunk).toString("utf8").startsWith('{"action":"release"');
			});
			expect(releaseWrites).toHaveLength(0);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			expect(existsSync(marker)).toBe(false);
			expect(
				journalRecords(journalPath)
					.filter((record) => record.type === "process")
					.map((record) => record.state),
			).toEqual(["enrolled", "retired"]);
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("retains a wrapper-dead live group and never redirects cleanup to a reused PID or PGID", async () => {
		const wrapperPidFile = join(testDir, "dead-wrapper.pid");
		const genericReaper = vi.spyOn(orphanJournal, "reapOrphanProcessCandidate");
		const script = [
			"const fs=require('fs')",
			"fs.writeFileSync(process.env.WRAPPER_PID_FILE,String(process.ppid))",
			"fs.closeSync(1)",
			"fs.closeSync(2)",
			"process.kill(process.ppid,'SIGKILL')",
			"setTimeout(()=>{},1500)",
		].join(";");
		try {
			await expect(
				executeContainedProcess({
					argv: [process.execPath, "-e", script],
					cwd: testDir,
					env: { ...process.env, WRAPPER_PID_FILE: wrapperPidFile },
				}),
			).rejects.toThrow(/retained authority|death is unproved/);
			const wrapperPid = Number.parseInt(readFileSync(wrapperPidFile, "utf8"), 10);
			expect(wrapperPid).toBeGreaterThan(0);
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toHaveLength(1);
			expect(genericReaper).not.toHaveBeenCalled();
			expect(() => process.kill(-wrapperPid, 0)).not.toThrow();

			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				try {
					process.kill(-wrapperPid, 0);
					await new Promise((resolve) => setTimeout(resolve, 25));
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ESRCH") break;
					if (code === "EPERM") {
						await new Promise((resolve) => setTimeout(resolve, 25));
						continue;
					}
					throw error;
				}
			}
			killTrackedDetachedChildren();
			expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
		} finally {
			genericReaper.mockRestore();
		}
	});

	it("does not report normal completion until same-group background children are dead", async () => {
		const pidFile = join(testDir, "background.pid");
		const command = `(trap '' TERM; sleep 30) & echo $! > ${shellQuote(pidFile)}`;
		const result = await createLocalBashOperations().exec(command, testDir, { onData: () => {} });

		expect(result.exitCode).toBe(0);
		const backgroundPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(backgroundPid).toBeGreaterThan(0);
		expect(isProcessAlive(backgroundPid)).toBe(false);
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});

	it("waits for exact process-group death before reporting abort", async () => {
		const pidFile = join(testDir, "leader.pid");
		const controller = new AbortController();
		const execution = createLocalBashOperations().exec(`echo $$ > ${shellQuote(pidFile)}; sleep 30`, testDir, {
			onData: () => {},
			signal: controller.signal,
		});
		const deadline = Date.now() + 5000;
		while (!existsSync(pidFile) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(existsSync(pidFile)).toBe(true);
		controller.abort();

		await expect(execution).rejects.toThrow("aborted");
		const leaderPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(isProcessAlive(leaderPid)).toBe(false);
		expect(readActiveOrphanProcesses(journalPath, process.pid)).toEqual([]);
	});
});
