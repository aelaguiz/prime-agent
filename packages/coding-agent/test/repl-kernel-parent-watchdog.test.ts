import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { PassThrough, Readable, type Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import {
	parseWindowsPersistentReplFrame,
	prepareWindowsPersistentReplHelperLaunch,
	resolveReplPythonWithoutExecution,
	WINDOWS_PERSISTENT_REPL_CONTROL_INPUT_FD,
	WINDOWS_PERSISTENT_REPL_CONTROL_OUTPUT_FD,
	WindowsPersistentReplFrameStream,
} from "../src/core/kernel/repl-admission.js";
import { parseGatedTargetPendingFrame, REPL_PROCESS_STARTUP_GATE_SOURCE } from "../src/core/kernel/repl-manager.js";
import {
	createKernelLineage,
	enrollOrphanProcess,
	initializeOrphanProcessJournal,
	KERNEL_ADMISSION_GENERATION_ENV,
	KERNEL_ADMISSION_PROTOCOL_ENV,
	KERNEL_LINEAGE_ENV,
	type KernelAdmissionLineage,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	reapKernelOrphanProcesses,
	retireOrphanProcess,
} from "../src/core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	isExactProcessStartId,
	observeProcessIdentity,
} from "../src/core/session-lease.js";

function requireExactProcessIdentity(pid: number): string {
	const observation = observeProcessIdentity(pid);
	if (observation.status !== "present-exact") {
		throw new Error(`Process ${pid} did not expose exact teardown authority`);
	}
	return observation.id;
}

function signalExactTestProcess(pid: number, exactId: string, signal: NodeJS.Signals, group = false): boolean {
	const observation = observeProcessIdentity(pid);
	if (observation.status === "absent") return false;
	if (observation.status !== "present-exact" || observation.id !== exactId) {
		throw new Error(
			`Retained cleanup artifact: ${JSON.stringify({ pid, exactId, reason: "exact identity mismatch or unavailable" })}`,
		);
	}
	process.kill(group ? -pid : pid, signal);
	return true;
}

function clearInheritedProcessTestEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("RLM_") || name.startsWith("PRIME_AGENT_INTERNAL_")) delete process.env[name];
	}
}

clearInheritedProcessTestEnvironment();

let tempDir = "";
const savedJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
const savedJournalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];

function writeFakePython(script: string[]): string {
	const python = join(tempDir, "python");
	writeFileSync(python, script.join("\n"));
	chmodSync(python, 0o755);
	return python;
}

async function waitForFile(path: string): Promise<void> {
	await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 5000, interval: 25 });
}

async function readOneJsonLine(stream: Readable, timeoutMessage: string): Promise<Record<string, unknown>> {
	return new Promise((resolveLine, rejectLine) => {
		let buffered = "";
		const timeout = setTimeout(() => rejectLine(new Error(timeoutMessage)), 5_000);
		stream.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			resolveLine(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
		});
		stream.once("error", rejectLine);
	});
}

interface JournalAuthorityRecord {
	version: 2;
	type: "authority";
	generation: string;
	sequence: 0;
	createdAt: string;
}

interface JournalProcessRecord {
	version: 2;
	type: "process";
	generation: string;
	sequence: number;
	pid: number;
	ownerPid: number;
	kernelPid?: number;
	processStartId?: string;
	authorityProcessStartId?: string;
	state: "enrolled" | "retired";
	recordedAt: string;
}

type JournalRecord = JournalAuthorityRecord | JournalProcessRecord;

function configureOrphanProcessJournal(path: string) {
	const authority = initializeOrphanProcessJournal(path);
	process.env[ORPHAN_PROCESS_JOURNAL_ENV] = authority.path;
	process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
	return authority;
}

function readJournalRecords(path: string): JournalRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JournalRecord);
}

function readJournalProcessRecords(path: string): JournalProcessRecord[] {
	return readJournalRecords(path).filter((record): record is JournalProcessRecord => record.type === "process");
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe("repl kernel parent watchdog", () => {
	beforeEach(() => {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-"));
	});

	afterEach(() => {
		try {
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
				tempDir = "";
			}
		} finally {
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_ENV, savedJournalPath);
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_GENERATION_ENV, savedJournalGeneration);
		}
	});

	it("keeps the embedded admission identity grammar aligned with the shared parser", () => {
		const validatorSource = REPL_PROCESS_STARTUP_GATE_SOURCE.match(
			/function isCanonicalExactStartId\(value\) \{[\s\S]*?\n\}/,
		)?.[0];
		expect(validatorSource).toBeDefined();
		const values = [
			`proc:11111111-2222-3333-4444-555555555555:0`,
			`proc:11111111-2222-3333-4444-555555555555:18446744073709551615`,
			`proc:11111111-2222-3333-4444-555555555555:00123`,
			`proc:11111111-2222-3333-4444-555555555555:18446744073709551616`,
			`proc:11111111-2222-3333-4444-555555555555:${"1".repeat(21)}`,
			"proc:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE:1",
			"win:0",
			`win:${"1".repeat(32)}`,
			"win:000123",
			`win:${"1".repeat(33)}`,
			"win:１２３",
			`token:${"a".repeat(64)}`,
			`token:${"A".repeat(64)}`,
		];
		for (const value of values) {
			const embedded = runInNewContext(`${validatorSource}; isCanonicalExactStartId(value)`, { value }) as boolean;
			expect(embedded, value).toBe(isExactProcessStartId(value));
		}
	});

	it("resolves a configured interpreter without executing its startup loader", () => {
		const marker = join(tempDir, "configured-python-probe-marker");
		const python = writeFakePython(["#!/bin/sh", `echo probe > ${JSON.stringify(marker)}`, "exit 0", ""]);
		expect(resolveReplPythonWithoutExecution(python)).toBe(python);
		expect(existsSync(marker)).toBe(false);
	});

	it("normalizes a missing managed runtime path without filesystem access", () => {
		const savedPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		const savedVenv = process.env.PRIME_AGENT_KERNEL_VENV;
		const missingVenv = join(tempDir, "missing-managed-venv");
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_VENV = missingVenv;
		try {
			expect(resolveReplPythonWithoutExecution()).toBe(
				join(missingVenv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
			);
			expect(existsSync(missingVenv)).toBe(false);
		} finally {
			restoreEnvironmentVariable("PRIME_AGENT_KERNEL_PYTHON", savedPython);
			restoreEnvironmentVariable("PRIME_AGENT_KERNEL_VENV", savedVenv);
		}
	});

	it("uses exact anonymous fd3/fd4 helper control and ignores mutable helper venv env", async () => {
		const savedPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		const savedVenv = process.env.PRIME_AGENT_KERNEL_VENV;
		const trustedVenv = join(tempDir, "trusted-install-kernel-venv");
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(tempDir, "attacker-python.exe");
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "attacker-venv");
		try {
			const launch = await prepareWindowsPersistentReplHelperLaunch({
				platform: "win32",
				trustedVenvDir: trustedVenv,
			});
			expect(launch.python).toBe(join(trustedVenv, "Scripts", "python.exe"));
			expect(launch.args.slice(0, 4)).toEqual(["-I", "-S", "-X", "utf8"]);
			expect(launch.args.at(-1)).toBe("--persistent-repl");
			expect(launch.args).toHaveLength(6);
			expect(launch.args.join(" ")).not.toMatch(/\\\.\\pipe|prime-agent-repl-/i);
			expect(launch.env.SystemRoot).toBe("C:\\Windows");
			expect(launch.env.PATH).toBe("C:\\Windows\\System32");
			expect(WINDOWS_PERSISTENT_REPL_CONTROL_INPUT_FD).toBe(3);
			expect(WINDOWS_PERSISTENT_REPL_CONTROL_OUTPUT_FD).toBe(4);

			const admissionSource = readFileSync(resolve(__dirname, "../src/core/kernel/repl-admission.ts"), "utf8");
			expect(admissionSource).not.toContain('from "node:net"');
			expect(admissionSource).not.toContain("createServer(");
			expect(admissionSource).not.toContain(String.raw`\\.\pipe`);
		} finally {
			restoreEnvironmentVariable("PRIME_AGENT_KERNEL_PYTHON", savedPython);
			restoreEnvironmentVariable("PRIME_AGENT_KERNEL_VENV", savedVenv);
		}
	});

	it("rejects a stale generation or target token in the admission control frame", () => {
		const first = createProcessIdentityOwnerToken();
		const successor = createProcessIdentityOwnerToken();
		const firstGeneration = randomUUID();
		const successorGeneration = randomUUID();
		const targetPid = process.pid;
		const line = JSON.stringify({
			primeAgentStartupGate: 2,
			type: "target-pending",
			admissionGeneration: firstGeneration,
			targetToken: first.argument,
			targetPid,
		});
		expect(
			parseGatedTargetPendingFrame(line, {
				targetPid,
				admissionGeneration: firstGeneration,
				targetToken: first.argument,
			}),
		).toEqual({
			targetPid,
			admissionGeneration: firstGeneration,
			targetToken: first.argument,
		});
		expect(() =>
			parseGatedTargetPendingFrame(line, {
				targetPid,
				admissionGeneration: successorGeneration,
				targetToken: successor.argument,
			}),
		).toThrow(/stale or invalid admission frame/);
	});

	it("binds Windows persistent helper frames to one admission and exact target state order", async () => {
		const expected = {
			admissionGeneration: "12345678-1234-4234-8234-123456789abc",
			targetToken: `prime-agent-owner-token=${"a".repeat(64)}`,
		};
		const successor = {
			admissionGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			targetToken: `prime-agent-owner-token=${"b".repeat(64)}`,
		};
		const identity = { targetPid: 4242, processStartId: "win:638000000000000011" };
		const pending = {
			primeAgentWindowsRepl: 1,
			type: "target-pending",
			...expected,
			...identity,
			jobContained: true,
		};
		expect(() => parseWindowsPersistentReplFrame(JSON.stringify(pending), successor)).toThrow(
			/stale or unbound frame/,
		);
		expect(() =>
			parseWindowsPersistentReplFrame(
				JSON.stringify({ ...pending, processStartId: "ps:lstart:coarse-only" }),
				expected,
			),
		).toThrow(/invalid target identity/);

		expect(() =>
			parseWindowsPersistentReplFrame(
				JSON.stringify({
					primeAgentWindowsRepl: 1,
					type: "target-done",
					...expected,
					...identity,
					exitCode: 1,
					leaderDead: true,
					jobEmpty: false,
					jobTerminationAttempted: true,
					jobTerminationSucceeded: true,
					taskkillFallbackAttempted: false,
				}),
				expected,
			),
		).toThrow(/invalid Job cleanup frame/);

		const output = new PassThrough();
		const frames = new WindowsPersistentReplFrameStream(output, expected);
		const pendingFrame = frames.next(["target-pending"], 1000);
		output.write(`${JSON.stringify(pending)}\n`);
		await expect(pendingFrame).resolves.toMatchObject({ type: "target-pending", ...identity });

		const releasedFrame = frames.next(["target-released"], 1000);
		output.write(
			`${JSON.stringify({
				primeAgentWindowsRepl: 1,
				type: "target-released",
				...expected,
				...identity,
			})}\n`,
		);
		await expect(releasedFrame).resolves.toMatchObject({ type: "target-released", ...identity });

		const doneFrame = frames.next(["target-done"], 1000);
		output.end(
			`${JSON.stringify({
				primeAgentWindowsRepl: 1,
				type: "target-done",
				...expected,
				...identity,
				exitCode: 0,
				leaderDead: true,
				jobEmpty: true,
				jobTerminationAttempted: false,
				jobTerminationSucceeded: false,
				taskkillFallbackAttempted: false,
			})}\n`,
		);
		await expect(doneFrame).resolves.toMatchObject({
			type: "target-done",
			...identity,
			leaderDead: true,
			jobEmpty: true,
		});
	});

	it("retains one Windows authority promise across a host timeout and later positive proof", async () => {
		const manager = new ReplKernelManager({ python: process.execPath });
		let resolveProof!: (value: boolean) => void;
		const doneProof = new Promise<boolean>((resolve) => {
			resolveProof = resolve;
		});
		const control = {
			child: new EventEmitter() as ChildProcess,
			expected: {
				admissionGeneration: "12345678-1234-4234-8234-123456789abc",
				targetToken: `prime-agent-owner-token=${"a".repeat(64)}`,
			},
			target: {
				type: "target-pending" as const,
				admissionGeneration: "12345678-1234-4234-8234-123456789abc",
				targetToken: `prime-agent-owner-token=${"a".repeat(64)}`,
				targetPid: 4242,
				processStartId: "win:638000000000000011",
				jobContained: true as const,
			},
			lineage: {
				admissionGeneration: "12345678-1234-4234-8234-123456789abc",
				kernelLineage: "b".repeat(64),
				kernelPid: 4242,
				kernelProcessStartId: "win:638000000000000011",
			},
			input: new PassThrough(),
			frames: {} as WindowsPersistentReplFrameStream,
			closeControl: vi.fn(),
			doneProof,
			terminationRequested: true,
		};
		const internals = manager as unknown as {
			windowsPersistentReplControl?: typeof control;
			waitForWindowsPersistentReplProof(value: typeof control, timeoutMs: number): Promise<boolean>;
		};
		internals.windowsPersistentReplControl = control;

		await expect(internals.waitForWindowsPersistentReplProof(control, 1)).resolves.toBe(false);
		expect(internals.windowsPersistentReplControl).toBe(control);
		expect(control.closeControl).not.toHaveBeenCalled();

		resolveProof(true);
		await expect(internals.waitForWindowsPersistentReplProof(control, 100)).resolves.toBe(true);
		expect(internals.windowsPersistentReplControl).toBe(control);
		expect(control.closeControl).not.toHaveBeenCalled();
	});

	it("fails before spawning target code when no durable journal authority is configured", async () => {
		const marker = join(tempDir, "no-journal-target-ran");
		const python = writeFakePython(["#!/bin/sh", `echo ran > ${JSON.stringify(marker)}`, "exit 0", ""]);
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		try {
			await expect(manager.start()).rejects.toThrow(/explicit durable orphan process journal authority/);
			expect(existsSync(marker)).toBe(false);
			expect((manager as unknown as { child?: ChildProcess }).child).toBeUndefined();
		} finally {
			await manager.shutdown();
		}
	});

	it("fails unsupported exact-identity platforms before spawning a kernel", async () => {
		configureOrphanProcessJournal(join(tempDir, "unsupported-platform-orphans.jsonl"));
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		const manager = new ReplKernelManager({ python: "/syntactic/python", cwd: tempDir });
		try {
			Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
			await expect(manager.start()).rejects.toThrow(
				"Kernel admission exact-identity probe unavailable: unsupported platform freebsd",
			);
			expect((manager as unknown as { child?: ChildProcess }).child).toBeUndefined();
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
			await manager.shutdown();
		}
	});

	it.runIf(process.platform === "win32")(
		"Windows CI: admits the exact persistent target before release and retires it from held-Job proof",
		async () => {
			const journalPath = join(tempDir, "windows-repl-orphans.jsonl");
			configureOrphanProcessJournal(journalPath);
			const siteDir = join(tempDir, "site");
			const markerPath = join(tempDir, "windows-target-admission.json");
			mkdirSync(siteDir);
			writeFileSync(
				join(siteDir, "sitecustomize.py"),
				[
					"import json, os",
					`with open(os.environ[${JSON.stringify(ORPHAN_PROCESS_JOURNAL_ENV)}], encoding="utf-8") as journal:`,
					"    records = [json.loads(line) for line in journal if line.strip()]",
					`with open(${JSON.stringify(markerPath)}, "w", encoding="utf-8") as marker:`,
					'    json.dump({"pid": os.getpid(), "records": records}, marker)',
					"",
				].join("\n"),
			);
			const python = resolveReplPythonWithoutExecution();
			const manager = new ReplKernelManager({
				python,
				cwd: tempDir,
				env: { PYTHONPATH: [siteDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
			});
			let targetPid = 0;

			try {
				await manager.start();
				const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
					pid: number;
					records: JournalRecord[];
				};
				targetPid = marker.pid;
				expect(marker.records).toContainEqual(
					expect.objectContaining({ pid: targetPid, ownerPid: process.pid, state: "enrolled" }),
				);
				await expect(manager.execute("40 + 2")).resolves.toMatchObject({ status: "ok", result: "42" });
			} finally {
				await manager.shutdown();
			}

			await vi.waitFor(() => {
				const records = readJournalProcessRecords(journalPath).filter((record) => record.pid === targetPid);
				expect(records.map((record) => record.state)).toEqual(["enrolled", "retired"]);
			});
		},
		30_000,
	);

	it.runIf(process.platform !== "win32")(
		"checks and smoke-runs the same-PID exec gate with one exact argv token",
		async () => {
			const syntax = spawnSync(process.execPath, ["--check"], {
				input: REPL_PROCESS_STARTUP_GATE_SOURCE,
				encoding: "utf8",
			});
			expect(syntax.status, syntax.stderr).toBe(0);
			expect(REPL_PROCESS_STARTUP_GATE_SOURCE).not.toContain("\0");
			expect(REPL_PROCESS_STARTUP_GATE_SOURCE).toContain(String.raw`includes("\0")`);
			expect(REPL_PROCESS_STARTUP_GATE_SOURCE).toContain(String.raw` + "\n"`);
			expect(REPL_PROCESS_STARTUP_GATE_SOURCE).not.toContain("prime-agent-owner-token=");
			const pendingWrite = REPL_PROCESS_STARTUP_GATE_SOURCE.indexOf("writeSync(controlFd");
			const acknowledgedAccess = REPL_PROCESS_STARTUP_GATE_SOURCE.indexOf("accessSync(launch.command");
			const acknowledgedChdir = REPL_PROCESS_STARTUP_GATE_SOURCE.indexOf("process.chdir(launch.cwd)");
			expect(pendingWrite).toBeGreaterThan(0);
			expect(acknowledgedAccess).toBeGreaterThan(pendingWrite);
			expect(acknowledgedChdir).toBeGreaterThan(pendingWrite);

			const targetScript = join(tempDir, "same-pid-target.mjs");
			writeFileSync(
				targetScript,
				[
					`const prefix = "prime-agent-" + "owner-token=";`,
					`const tokens = process.argv.filter((value) => value.startsWith(prefix));`,
					`process.stdout.write(JSON.stringify({ pid: process.pid, tokens, argv: process.argv }) + "\\n");`,
					`process.exit(23);`,
					"",
				].join("\n"),
			);
			const targetIdentity = createProcessIdentityOwnerToken();
			const admissionGeneration = randomUUID();
			const kernelLineage = createKernelLineage();
			const child = spawn(
				process.execPath,
				["-e", REPL_PROCESS_STARTUP_GATE_SOURCE, targetIdentity.argument, admissionGeneration],
				{
					detached: true,
					stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
				},
			);
			const childStdio = child.stdio as Array<Readable | Writable | null | undefined>;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
			const control = childStdio[5];
			expect(control).toBeInstanceOf(Readable);
			const pending = new Promise<Record<string, unknown>>((resolvePending, rejectPending) => {
				let buffered = "";
				const timeout = setTimeout(() => rejectPending(new Error("Kernel gate smoke timed out")), 5000);
				(control as Readable).on("data", (chunk: Buffer) => {
					buffered += chunk.toString("utf8");
					const newline = buffered.indexOf("\n");
					if (newline < 0) return;
					clearTimeout(timeout);
					resolvePending(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
				});
				(control as Readable).once("error", rejectPending);
			});
			try {
				(childStdio[4] as Writable).end(
					JSON.stringify({
						primeAgentStartupGate: 2,
						admissionGeneration,
						targetToken: targetIdentity.argument,
						kernelLineage,
						command: process.execPath,
						args: [targetScript],
						cwd: tempDir,
						env: {
							PRIME_AGENT_INTERNAL_REPL_TARGET_TOKEN: "attacker-cannot-override-argv",
							[KERNEL_ADMISSION_PROTOCOL_ENV]: "2",
							[KERNEL_ADMISSION_GENERATION_ENV]: admissionGeneration,
							[KERNEL_LINEAGE_ENV]: kernelLineage,
						},
					}),
				);
				const frame = await pending;
				expect(frame).toEqual({
					primeAgentStartupGate: 2,
					type: "target-pending",
					admissionGeneration,
					targetToken: targetIdentity.argument,
					targetPid: child.pid,
				});
				expect(stdout).toHaveLength(0);
				const command = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "command="], {
					encoding: "utf8",
				}).stdout;
				expect(command.split("prime-agent-owner-token=")).toHaveLength(2);
				const gateIdentity = observeProcessIdentity(child.pid!);
				expect(gateIdentity.status).toBe("present-exact");
				if (gateIdentity.status !== "present-exact") throw new Error("exact gate identity unavailable");

				(childStdio[3] as Writable).end(
					`${JSON.stringify({
						primeAgentStartupGate: 2,
						type: "target-ack",
						admissionGeneration,
						targetToken: targetIdentity.argument,
						targetPid: child.pid,
						kernelLineage,
						kernelProcessStartId: gateIdentity.id,
					})}
`,
				);
				const exit =
					child.exitCode !== null || child.signalCode !== null
						? { code: child.exitCode, signal: child.signalCode }
						: await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
								child.once("exit", (code, signal) => resolveExit({ code, signal })),
							);
				expect(exit).toEqual({ code: 23, signal: null });
				const target = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
					pid: number;
					tokens: string[];
					argv: string[];
				};
				expect(target.pid).toBe(child.pid);
				expect(target.tokens).toEqual([targetIdentity.argument]);
				expect(target.argv.filter((value) => value === targetIdentity.argument)).toHaveLength(1);
				expect(Buffer.concat(stderr).toString("utf8")).toBe("");
			} finally {
				if (child.pid) signalExactTestProcess(child.pid, targetIdentity.processStartId, "SIGKILL", true);
				if (child.exitCode === null && child.signalCode === null) {
					await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
				}
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"fails an old bare-proc acknowledgement before target code can run",
		async () => {
			const marker = join(tempDir, "mixed-version-target-ran");
			const targetScript = join(tempDir, "mixed-version-target.mjs");
			writeFileSync(
				targetScript,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
			);
			const targetIdentity = createProcessIdentityOwnerToken();
			const admissionGeneration = randomUUID();
			const kernelLineage = createKernelLineage();
			const child = spawn(
				process.execPath,
				["-e", REPL_PROCESS_STARTUP_GATE_SOURCE, targetIdentity.argument, admissionGeneration],
				{ detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"] },
			);
			const stdio = child.stdio as Array<Readable | Writable | null | undefined>;
			const stderr: Buffer[] = [];
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
			try {
				(stdio[4] as Writable).end(
					JSON.stringify({
						primeAgentStartupGate: 2,
						admissionGeneration,
						targetToken: targetIdentity.argument,
						kernelLineage,
						command: process.execPath,
						args: [targetScript],
						cwd: tempDir,
						env: {
							[KERNEL_ADMISSION_PROTOCOL_ENV]: "2",
							[KERNEL_ADMISSION_GENERATION_ENV]: admissionGeneration,
							[KERNEL_LINEAGE_ENV]: kernelLineage,
						},
					}),
				);
				const pending = await readOneJsonLine(stdio[5] as Readable, "mixed-version gate timed out");
				(stdio[3] as Writable).end(
					`${JSON.stringify({
						primeAgentStartupGate: 1,
						type: "target-ack",
						admissionGeneration,
						targetToken: targetIdentity.argument,
						targetPid: pending.targetPid,
						kernelProcessStartId: "proc:123",
					})}\n`,
				);
				const exit = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
				expect(exit).toBe(125);
				expect(Buffer.concat(stderr).toString("utf8")).toContain(
					"admission protocol/version or exact identity mismatch",
				);
				expect(existsSync(marker)).toBe(false);
			} finally {
				if (child.exitCode === null && child.signalCode === null && child.pid) {
					signalExactTestProcess(child.pid, targetIdentity.processStartId, "SIGKILL", true);
				}
			}
		},
	);

	it("spawn sets PRIME_AGENT_KERNEL_OWNER_PID and journals the kernel pid", async () => {
		const envDump = join(tempDir, "kernel-env");
		const python = writeFakePython(["#!/bin/sh", `env > "${envDump}"`, "exit 42", ""]);
		const journalPath = join(tempDir, "orphans.jsonl");
		const authority = configureOrphanProcessJournal(journalPath);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before ready/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const childEnvironment = readFileSync(envDump, "utf8");
		const ownerPidMatch = childEnvironment.match(/^PRIME_AGENT_KERNEL_OWNER_PID=(\d+)$/m);
		const ownerPid = Number(ownerPidMatch?.[1]);
		// The admitted gate becomes the target in place; bash descendants remain
		// scoped to this host and to that exact target PID.
		expect(ownerPid).toBe(process.pid);
		expect(childEnvironment).toContain(`${ORPHAN_PROCESS_JOURNAL_ENV}=${authority.path}`);
		expect(childEnvironment).toContain(`${ORPHAN_PROCESS_JOURNAL_GENERATION_ENV}=${authority.generation}`);

		// The self-exit event supplies exact-death proof, so it appends the
		// matching retirement after the enrollment.
		await vi.waitFor(() => {
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(3);
			expect(records[0]).toMatchObject({
				version: 2,
				type: "authority",
				generation: authority.generation,
				sequence: 0,
			});
			const processes = readJournalProcessRecords(journalPath);
			expect(processes).toHaveLength(2);
			const [enrollment, retirement] = processes;
			expect(enrollment).toMatchObject({
				version: 2,
				type: "process",
				generation: authority.generation,
				sequence: 1,
				ownerPid: process.pid,
				state: "enrolled",
			});
			expect(enrollment?.pid).toBeGreaterThan(0);
			expect(enrollment?.pid).not.toBe(ownerPid);
			const enrollmentIdentity = enrollment?.authorityProcessStartId ?? enrollment?.processStartId ?? "";
			expect(isExactProcessStartId(enrollmentIdentity)).toBe(true);
			expect(retirement).toMatchObject({
				version: 2,
				type: "process",
				generation: authority.generation,
				sequence: 2,
				pid: enrollment?.pid,
				ownerPid: process.pid,
				state: "retired",
			});
			expect(retirement?.authorityProcessStartId ?? retirement?.processStartId).toBe(enrollmentIdentity);
		});
	});

	it.runIf(process.platform !== "win32")(
		"releases configured target code only after its exact gate identity is durably enrolled",
		async () => {
			const journalPath = join(tempDir, "orphans.jsonl");
			const authority = configureOrphanProcessJournal(journalPath);
			const markerPath = join(tempDir, "target-journal.jsonl");
			const pidPath = join(tempDir, "target.pid");
			const ownerPidPath = join(tempDir, "target-owner.pid");
			const python = writeFakePython([
				"#!/bin/sh",
				`cat "$${ORPHAN_PROCESS_JOURNAL_ENV}" > ${JSON.stringify(markerPath)}`,
				`echo $$ > ${JSON.stringify(pidPath)}`,
				`echo $PPID > ${JSON.stringify(ownerPidPath)}`,
				`echo '{"event":"ready","protocol":4,"python":"gated-test"}'`,
				"IFS= read -r _request || exit 0",
				"exit 0",
				"",
			]);
			const manager = new ReplKernelManager({ python, cwd: tempDir });

			try {
				await manager.start();
				const targetPid = Number(readFileSync(pidPath, "utf8").trim());
				const ownerPid = Number(readFileSync(ownerPidPath, "utf8").trim());
				expect(ownerPid).toBe(process.pid);
				expect(targetPid).not.toBe(ownerPid);
				const records = readFileSync(markerPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as JournalRecord);
				expect(records[0]).toMatchObject({
					version: 2,
					type: "authority",
					generation: authority.generation,
					sequence: 0,
				});
				const enrollment = records[1] as JournalProcessRecord;
				expect(enrollment).toMatchObject({
					version: 2,
					type: "process",
					generation: authority.generation,
					sequence: 1,
					pid: targetPid,
					ownerPid: process.pid,
					state: "enrolled",
				});
				const enrollmentIdentity = enrollment.authorityProcessStartId ?? enrollment.processStartId ?? "";
				expect(isExactProcessStartId(enrollmentIdentity)).toBe(true);
				const observed = observeProcessIdentity(targetPid);
				expect(observed.status).toBe("present-exact");
				if (observed.status === "present-exact") {
					expect(enrollmentIdentity).toBe(observed.id);
				}
			} finally {
				await manager.shutdown();
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"kills the gated child without running or replacing target code when enrollment fails",
		async () => {
			const journalPath = join(tempDir, "orphans.jsonl");
			configureOrphanProcessJournal(journalPath);
			writeFileSync(journalPath, "{not-json}\n", { flag: "a" });
			const markerPath = join(tempDir, "target-ran");
			const python = writeFakePython(["#!/bin/sh", `echo ran > ${JSON.stringify(markerPath)}`, "exit 0", ""]);
			const manager = new ReplKernelManager({ python, cwd: tempDir });

			try {
				await expect(manager.start()).rejects.toThrow(/orphan process journal/i);
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
				expect(existsSync(markerPath)).toBe(false);
				const internals = manager as unknown as {
					child?: ChildProcess;
					pendingGatedStartupChild?: unknown;
				};
				expect(internals.child).toBeUndefined();
				expect(internals.pendingGatedStartupChild).toBeUndefined();
				expect(readFileSync(journalPath, "utf8")).toContain("{not-json}");
			} finally {
				await manager.shutdown();
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"death before acknowledgement runs no target and a stale acknowledgement cannot release its successor",
		async () => {
			const target = join(tempDir, "admission-target");
			writeFileSync(target, '#!/bin/sh\nprintf "%s" "$$" > "$1"\n');
			chmodSync(target, 0o755);
			const children: Array<{ child: ChildProcess; exactId: string }> = [];
			const startPausedGate = async (marker: string) => {
				const identity = createProcessIdentityOwnerToken();
				const admissionGeneration = randomUUID();
				const kernelLineage = createKernelLineage();
				const child = spawn(
					process.execPath,
					["-e", REPL_PROCESS_STARTUP_GATE_SOURCE, identity.argument, admissionGeneration],
					{ detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe"] },
				);
				children.push({ child, exactId: identity.processStartId });
				const stdio = child.stdio as Array<Readable | Writable | null | undefined>;
				const frame = new Promise<Record<string, unknown>>((resolveFrame, rejectFrame) => {
					let buffered = "";
					const timeout = setTimeout(() => rejectFrame(new Error("Admission frame timed out")), 5000);
					(stdio[5] as Readable).on("data", (chunk: Buffer) => {
						buffered += chunk.toString("utf8");
						const newline = buffered.indexOf("\n");
						if (newline < 0) return;
						clearTimeout(timeout);
						resolveFrame(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
					});
					child.once("error", rejectFrame);
				});
				(stdio[4] as Writable).end(
					JSON.stringify({
						primeAgentStartupGate: 2,
						admissionGeneration,
						targetToken: identity.argument,
						kernelLineage,
						command: target,
						args: [marker],
						cwd: tempDir,
						env: {
							[KERNEL_ADMISSION_PROTOCOL_ENV]: "2",
							[KERNEL_ADMISSION_GENERATION_ENV]: admissionGeneration,
							[KERNEL_LINEAGE_ENV]: kernelLineage,
						},
					}),
				);
				await frame;
				return { child, stdio, identity, admissionGeneration, kernelLineage };
			};
			const waitForExit = (child: ChildProcess) =>
				child.exitCode !== null || child.signalCode !== null
					? Promise.resolve()
					: new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

			try {
				const markerA = join(tempDir, "target-a-ran");
				const first = await startPausedGate(markerA);
				signalExactTestProcess(first.child.pid!, first.identity.processStartId, "SIGKILL", true);
				await waitForExit(first.child);
				expect(existsSync(markerA)).toBe(false);

				const markerB = join(tempDir, "target-b-ran");
				const successor = await startPausedGate(markerB);
				expect(successor.identity.argument).not.toBe(first.identity.argument);
				expect(successor.admissionGeneration).not.toBe(first.admissionGeneration);
				const successorIdentity = observeProcessIdentity(successor.child.pid!);
				expect(successorIdentity.status).toBe("present-exact");
				if (successorIdentity.status !== "present-exact") throw new Error("exact successor identity unavailable");
				(successor.stdio[3] as Writable).end(
					`${JSON.stringify({
						primeAgentStartupGate: 2,
						type: "target-ack",
						admissionGeneration: first.admissionGeneration,
						targetToken: first.identity.argument,
						targetPid: successor.child.pid,
						kernelLineage: first.kernelLineage,
						kernelProcessStartId: successorIdentity.id,
					})}\n`,
				);
				await waitForExit(successor.child);
				expect(successor.child.exitCode).toBe(125);
				expect(existsSync(markerB)).toBe(false);

				const markerC = join(tempDir, "target-c-ran");
				const admitted = await startPausedGate(markerC);
				const admittedIdentity = observeProcessIdentity(admitted.child.pid!);
				expect(admittedIdentity.status).toBe("present-exact");
				if (admittedIdentity.status !== "present-exact") throw new Error("exact admitted identity unavailable");
				(admitted.stdio[3] as Writable).end(
					`${JSON.stringify({
						primeAgentStartupGate: 2,
						type: "target-ack",
						admissionGeneration: admitted.admissionGeneration,
						targetToken: admitted.identity.argument,
						targetPid: admitted.child.pid,
						kernelLineage: admitted.kernelLineage,
						kernelProcessStartId: admittedIdentity.id,
					})}\n`,
				);
				await waitForExit(admitted.child);
				expect(existsSync(markerA)).toBe(false);
				expect(existsSync(markerB)).toBe(false);
				expect(Number(readFileSync(markerC, "utf8"))).toBe(admitted.child.pid);
			} finally {
				for (const { child, exactId } of children) {
					if (child.pid) signalExactTestProcess(child.pid, exactId, "SIGKILL", true);
				}
			}
		},
	);

	it("does not signal or retire a bare child without exact authority", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		const authority = configureOrphanProcessJournal(journalPath);
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const kill = vi.fn(() => false);
		const internals = manager as unknown as {
			child?: { pid?: number; kill(signal: string): boolean };
			cleanupResources(): void;
		};

		try {
			internals.child = { pid: 999999, kill };
			internals.cleanupResources();

			expect(kill).not.toHaveBeenCalled();
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				version: 2,
				type: "authority",
				generation: authority.generation,
				sequence: 0,
			});
			expect(readJournalProcessRecords(journalPath)).toEqual([]);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("does not signal a reused PID with a different exact identity", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		const authority = configureOrphanProcessJournal(journalPath);
		const candidate = { pid: process.pid, processStartId: `token:${"f".repeat(64)}` };
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const kill = vi.fn(() => true);
		const internals = manager as unknown as {
			child?: { pid?: number; kill(signal: string): boolean };
			kernelOrphanCandidates: Map<number, typeof candidate>;
			cleanupResources(signal?: NodeJS.Signals): void;
		};

		try {
			internals.kernelOrphanCandidates.set(candidate.pid, candidate);
			internals.child = { pid: candidate.pid, kill };
			internals.cleanupResources("SIGKILL");

			expect(kill).not.toHaveBeenCalled();
			expect(internals.kernelOrphanCandidates.get(candidate.pid)).toEqual(candidate);
			expect(retireOrphanProcess(candidate)).toBe(false);
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				version: 2,
				type: "authority",
				generation: authority.generation,
				sequence: 0,
			});
			expect(readJournalProcessRecords(journalPath)).toEqual([]);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("a stale doStart resumed after prior-cleanup await never touches the new kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		configureOrphanProcessJournal(journalPath);
		const python = writeFakePython(["#!/bin/sh", "exit 42", ""]);
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		let releaseCleanup: (ready: boolean) => void = () => {};
		let cleanupEntered: () => void = () => {};
		const entered = new Promise<void>((resolveEntered) => {
			cleanupEntered = resolveEntered;
		});
		const internals = manager as unknown as {
			state: string;
			child?: { pid?: number; kill(signal: string): boolean };
			kernelPidsAwaitingDescendantCleanup: Map<string, KernelAdmissionLineage>;
			retireCleanupProvenKernelAuthorities(): Promise<boolean>;
		};
		const retainedLineage: KernelAdmissionLineage = {
			admissionGeneration: "12345678-1234-4234-8234-123456789abc",
			kernelLineage: "c".repeat(64),
			kernelPid: 999_999,
			kernelProcessStartId: "proc:11111111-2222-3333-4444-555555555555:1",
		};
		internals.kernelPidsAwaitingDescendantCleanup.set(retainedLineage.kernelLineage, retainedLineage);
		internals.retireCleanupProvenKernelAuthorities = () => {
			cleanupEntered();
			return new Promise<boolean>((resolveCleanup) => {
				releaseCleanup = resolveCleanup;
			});
		};
		const killB = vi.fn(() => true);
		const childB = { pid: 222222, kill: killB };

		try {
			const staleStart = manager.start();
			await entered;

			await manager.kill();
			internals.state = "running";
			internals.child = childB;

			releaseCleanup(true);
			await expect(staleStart).resolves.toBeUndefined();

			expect(internals.state).toBe("running");
			expect(internals.child).toBe(childB);
			expect(killB).not.toHaveBeenCalled();
			const records = readJournalProcessRecords(journalPath);
			expect(records.some((record) => record.pid === childB.pid)).toBe(false);
		} finally {
			internals.child = undefined;
			internals.state = "idle";
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("a shutdown superseded by a concurrent kill reports not-owner so recovery cannot resurrect to idle", async () => {
		const manager = new ReplKernelManager({ python: "/nonexistent-python", cwd: tmpdir() });
		const internals = manager as unknown as {
			state: string;
			child: unknown;
			writeLine: (request: Record<string, unknown>) => Promise<void>;
			shutdown(): Promise<boolean>;
			kill(): Promise<void>;
		};
		internals.state = "running";
		// A live child handle keeps waitForKernelExit parked so the send actually blocks the shutdown.
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: () => true,
			pid: undefined,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		internals.child = child;
		let releaseSend: () => void = () => {};
		internals.writeLine = () =>
			new Promise<void>((resolve) => {
				releaseSend = resolve;
			});
		const shutdownResult = internals.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 10)); // park in the stdin write
		await internals.kill(); // concurrent teardown wins ownership
		releaseSend();
		child.emit("exit", 0, null);
		expect(await shutdownResult).toBe(false); // recovery must not set idle
		expect(internals.state).toBe("shutdown");
	});

	it("a stale shutdown parked in its stdin-write await never cleans up a successor kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		configureOrphanProcessJournal(journalPath);
		let releaseSend: () => void = () => {};
		const parkedSend = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const killA = vi.fn(() => true);
		const killB = vi.fn(() => true);
		const childA = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: killA,
			pid: 111111,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		const childB = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: killB,
			pid: 222222,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			child?: unknown;
			writeLine: (request: Record<string, unknown>) => Promise<void>;
			startPromise?: Promise<void>;
		};

		try {
			// Kernel A is running with a stdin write that parks forever until
			// released — shutdown() will suspend inside its await window after
			// having synchronously set state = "shutdown".
			internals.state = "running";
			internals.child = childA;
			internals.writeLine = () => parkedSend;
			const staleShutdown = manager.shutdown();

			// While A's shutdown is parked, a concurrent teardown reclaims A and a
			// new start brings up kernel B.
			await manager.kill();
			internals.state = "running";
			internals.child = childB;
			const startPromiseB = Promise.resolve();
			internals.startPromise = startPromiseB;

			// A's stale shutdown resumes: it must not clean up B or clear B's start.
			releaseSend();
			await staleShutdown;

			expect(internals.state).toBe("running");
			expect(internals.child).toBe(childB);
			expect(killB).not.toHaveBeenCalled();
			expect(internals.startPromise).toBe(startPromiseB);
			// A has no exact candidate, so teardown cannot signal it; B still must
			// never gain a journal transition from A's stale shutdown.
			expect(killA).not.toHaveBeenCalled();
			const records = readJournalProcessRecords(journalPath);
			expect(records.some((record) => record.pid === childB.pid)).toBe(false);
		} finally {
			internals.child = undefined;
			internals.startPromise = undefined;
			internals.state = "idle";
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(process.cwd(), "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const replPython = resolveReplPython();
const describeIf = replPython && process.platform !== "win32" ? describe : describe.skip;

describeIf("repl runtime outlives-owner watchdog (real runtime)", { tags: ["kernel-heavy"] }, () => {
	it("holds malicious sitecustomize and its journaled bash child until exact enrollment acknowledgement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-sitecustomize-gate-"));
		const journalPath = join(dir, "orphans.jsonl");
		const markerPath = join(dir, "sitecustomize-marker.json");
		const bashMarkerPath = join(dir, "sitecustomize-bash-marker");
		const siteDir = join(dir, "site");
		mkdirSync(siteDir);
		writeFileSync(
			join(siteDir, "sitecustomize.py"),
			[
				"import builtins, json, os, shlex",
				"from rlm import bash",
				`command = "printf '%s' $$ > " + shlex.quote(os.environ["PRIME_AGENT_TEST_BASH_MARKER"]) + "; exec sleep 120"`,
				"handle = bash(command)",
				"builtins._prime_agent_malicious_site_handle = handle",
				`journal_path = os.environ["${ORPHAN_PROCESS_JOURNAL_ENV}"]`,
				`marker_path = os.environ["PRIME_AGENT_TEST_SITECUSTOMIZE_MARKER"]`,
				"with open(journal_path, encoding='utf-8') as journal:",
				"    records = [json.loads(line) for line in journal if line.strip()]",
				"with open(marker_path, 'w', encoding='utf-8') as marker:",
				"    json.dump({'pid': os.getpid(), 'owner_pid': os.getppid(), 'bash_pid': handle.pid, 'records': records}, marker)",
				"",
			].join("\n"),
		);
		const authority = configureOrphanProcessJournal(journalPath);
		const targetIdentity = createProcessIdentityOwnerToken();
		const bashIdentity = createProcessIdentityOwnerToken();
		const admissionGeneration = randomUUID();
		const kernelLineage = createKernelLineage();
		let lineage: KernelAdmissionLineage | undefined;
		const targetEnvironment = {
			...process.env,
			PYTHONPATH: [siteDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
			PRIME_AGENT_TEST_SITECUSTOMIZE_MARKER: markerPath,
			PRIME_AGENT_TEST_BASH_MARKER: bashMarkerPath,
			PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
			PRIME_AGENT_BASH_COMMAND_PREFIX: `: # ${bashIdentity.argument} `,
			[ORPHAN_PROCESS_JOURNAL_ENV]: authority.path,
			[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV]: authority.generation,
			[KERNEL_ADMISSION_PROTOCOL_ENV]: "2",
			[KERNEL_ADMISSION_GENERATION_ENV]: admissionGeneration,
			[KERNEL_LINEAGE_ENV]: kernelLineage,
		};
		const child = spawn(
			process.execPath,
			["-e", REPL_PROCESS_STARTUP_GATE_SOURCE, targetIdentity.argument, admissionGeneration],
			{ detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"] },
		);
		const stdio = child.stdio as Array<Readable | Writable | null | undefined>;
		const targetStderr: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => targetStderr.push(Buffer.from(chunk)));
		let control = "";
		const pending = new Promise<Record<string, unknown>>((resolvePending, rejectPending) => {
			const timeout = setTimeout(() => rejectPending(new Error("Sitecustomize gate timed out")), 5000);
			(stdio[5] as Readable).on("data", (chunk: Buffer) => {
				control += chunk.toString("utf8");
				const newline = control.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timeout);
				resolvePending(JSON.parse(control.slice(0, newline)) as Record<string, unknown>);
			});
			child.once("error", rejectPending);
		});
		let bashPid = 0;

		try {
			(stdio[4] as Writable).end(
				JSON.stringify({
					primeAgentStartupGate: 2,
					admissionGeneration,
					targetToken: targetIdentity.argument,
					kernelLineage,
					command: replPython,
					args: ["-m", "rlm.repl"],
					cwd: dir,
					env: targetEnvironment,
				}),
			);
			const frame = await pending;
			expect(frame).toMatchObject({
				type: "target-pending",
				targetPid: child.pid,
				admissionGeneration,
				targetToken: targetIdentity.argument,
			});
			expect(existsSync(markerPath)).toBe(false);
			expect(existsSync(bashMarkerPath)).toBe(false);

			const targetProcessIdentity = observeProcessIdentity(child.pid!);
			expect(targetProcessIdentity.status).toBe("present-exact");
			if (targetProcessIdentity.status !== "present-exact") throw new Error("exact gate identity unavailable");
			lineage = {
				admissionGeneration,
				kernelLineage,
				kernelPid: child.pid!,
				kernelProcessStartId: targetProcessIdentity.id,
			};
			const targetCandidate = enrollOrphanProcess(
				child.pid!,
				lineage.kernelPid,
				lineage.kernelProcessStartId,
				lineage,
			);
			if (process.platform === "darwin") {
				expect(targetCandidate.processStartId).toBe(targetIdentity.processStartId);
			}
			expect(existsSync(markerPath)).toBe(false);
			(stdio[3] as Writable).end(
				`${JSON.stringify({
					primeAgentStartupGate: 2,
					type: "target-ack",
					admissionGeneration,
					targetToken: targetIdentity.argument,
					targetPid: child.pid,
					kernelLineage,
					kernelProcessStartId: lineage.kernelProcessStartId,
				})}
`,
			);

			try {
				await waitForFile(markerPath);
				await waitForFile(bashMarkerPath);
			} catch (error) {
				throw new Error(
					`Malicious sitecustomize did not complete. stderr:\n${Buffer.concat(targetStderr).toString("utf8")}`,
					{
						cause: error,
					},
				);
			}
			const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
				pid: number;
				owner_pid: number;
				bash_pid: number;
				records: JournalRecord[];
			};
			bashPid = marker.bash_pid;
			expect(marker.pid).toBe(child.pid);
			expect(marker.owner_pid).toBe(process.pid);
			expect(marker.records).toContainEqual(
				expect.objectContaining({
					type: "process",
					pid: marker.pid,
					ownerPid: process.pid,
					state: "enrolled",
				}),
			);
			expect(marker.records).toContainEqual(
				expect.objectContaining({
					type: "process",
					pid: bashPid,
					ownerPid: process.pid,
					kernelPid: marker.pid,
					state: "enrolled",
				}),
			);
		} finally {
			if (child.pid) signalExactTestProcess(child.pid, targetIdentity.processStartId, "SIGKILL", true);
			if (lineage) reapKernelOrphanProcesses(lineage);
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
			}
			if (bashPid > 0) {
				await vi.waitFor(() => expect(() => process.kill(bashPid, 0)).toThrow(), { timeout: 5000, interval: 25 });
			}
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_ENV, savedJournalPath);
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_GENERATION_ENV, savedJournalGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reaps an immediately orphaned sitecustomize bash child before one replacement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-sitecustomize-repair-"));
		const journalPath = join(dir, "orphans.jsonl");
		const siteDir = join(dir, "site");
		const countPath = join(dir, "site-count");
		const bashPidPath = join(dir, "old-bash.pid");
		const overlapPath = join(dir, "replacement-overlap");
		mkdirSync(siteDir);
		writeFileSync(
			join(siteDir, "sitecustomize.py"),
			[
				"import os",
				`count_path = ${JSON.stringify(countPath)}`,
				`bash_pid_path = ${JSON.stringify(bashPidPath)}`,
				`overlap_path = ${JSON.stringify(overlapPath)}`,
				"try:",
				"    count = int(open(count_path, encoding='utf-8').read())",
				"except (FileNotFoundError, ValueError):",
				"    count = 0",
				"with open(count_path, 'w', encoding='utf-8') as count_file:",
				"    count_file.write(str(count + 1))",
				"if count == 0:",
				"    from rlm import bash",
				"    handle = bash('exec sleep 120')",
				"    with open(bash_pid_path, 'w', encoding='utf-8') as pid_file:",
				"        pid_file.write(str(handle.pid))",
				"    os._exit(42)",
				"old_pid = int(open(bash_pid_path, encoding='utf-8').read())",
				"try:",
				"    os.kill(old_pid, 0)",
				"    overlap = 'alive'",
				"except ProcessLookupError:",
				"    overlap = 'dead'",
				"with open(overlap_path, 'w', encoding='utf-8') as overlap_file:",
				"    overlap_file.write(overlap)",
				"",
			].join("\n"),
		);
		configureOrphanProcessJournal(journalPath);
		const runtimeSource = resolve(__dirname, "..", "..", "..", "prime-agent-runtime", "src");
		const manager = new ReplKernelManager({
			python: replPython!,
			cwd: dir,
			env: { PYTHONPATH: [siteDir, runtimeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
		});

		try {
			await expect(manager.start()).rejects.toThrow(/Kernel exited before ready/);
			const oldBashPid = Number(readFileSync(bashPidPath, "utf8"));
			expect(oldBashPid).toBeGreaterThan(0);

			await manager.start();
			expect(readFileSync(overlapPath, "utf8")).toBe("dead");
			expect(readFileSync(countPath, "utf8")).toBe("2");
			const processRecords = readJournalProcessRecords(journalPath);
			expect(processRecords).toContainEqual(
				expect.objectContaining({ pid: oldBashPid, kernelPid: expect.any(Number), state: "enrolled" }),
			);
			expect(processRecords).toContainEqual(
				expect.objectContaining({ pid: oldBashPid, kernelPid: expect.any(Number), state: "retired" }),
			);
		} finally {
			await manager.shutdown();
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_ENV, savedJournalPath);
			restoreEnvironmentVariable(ORPHAN_PROCESS_JOURNAL_GENERATION_ENV, savedJournalGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("runtime exits after its owner is SIGKILLed (stdin EOF watchdog)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-int-"));
		const pidFile = join(dir, "runtime.pid");
		const ownerIdentity = createProcessIdentityOwnerToken();
		const runtimeIdentity = createProcessIdentityOwnerToken();
		// The owner must be a separate killable process; it replicates the
		// manager's exact spawn line: piped stdin, so owner death delivers EOF.
		const ownerScript = [
			`const { spawn } = require("node:child_process");`,
			`const { writeFileSync } = require("node:fs");`,
			`const k = spawn(${JSON.stringify(replPython)}, ["-m", "rlm.repl", ${JSON.stringify(runtimeIdentity.argument)}], {`,
			`  env: { ...process.env, PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },`,
			`  stdio: ["pipe", "ignore", "ignore"],`,
			`});`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(k.pid));`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const owner = spawn(process.execPath, ["-e", ownerScript, ownerIdentity.argument], {
			stdio: ["ignore", "ignore", "inherit"],
		});
		let runtimePid = 0;
		let runtimeExactId: string | undefined;
		let ownerExactId: string | undefined;

		try {
			await vi.waitFor(
				() => {
					runtimePid = Number(readFileSync(pidFile, "utf8"));
					expect(runtimePid).toBeGreaterThan(0);
					expect(() => process.kill(runtimePid, 0)).not.toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);

			runtimeExactId = requireExactProcessIdentity(runtimePid);
			ownerExactId = requireExactProcessIdentity(owner.pid!);
			signalExactTestProcess(owner.pid!, ownerExactId, "SIGKILL");

			await vi.waitFor(
				() => {
					expect(() => process.kill(runtimePid, 0)).toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);
		} finally {
			if (runtimePid > 0 && runtimeExactId) signalExactTestProcess(runtimePid, runtimeExactId, "SIGKILL");
			if (owner.pid && ownerExactId) signalExactTestProcess(owner.pid, ownerExactId, "SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("runtime exits after owner death even while a non-yielding cell holds the loop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-busy-"));
		const pidFile = join(dir, "runtime.pid");
		const busyFile = join(dir, "busy.marker");
		const ownerIdentity = createProcessIdentityOwnerToken();
		const runtimeIdentity = createProcessIdentityOwnerToken();
		// The cell marks the file, then spins synchronously: the asyncio loop is
		// monopolized, so the stdin-EOF shutdown can never run — only the
		// watchdog thread can take the runtime down.
		const busyRequest = JSON.stringify({
			type: "execute",
			id: "busy-cell",
			code: `open(${JSON.stringify(busyFile)}, "w").write("busy")\nwhile True: pass`,
		});
		const ownerScript = [
			`const { spawn } = require("node:child_process");`,
			`const { writeFileSync } = require("node:fs");`,
			`const k = spawn(${JSON.stringify(replPython)}, ["-m", "rlm.repl", ${JSON.stringify(runtimeIdentity.argument)}], {`,
			`  env: { ...process.env, PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },`,
			`  stdio: ["pipe", "ignore", "ignore"],`,
			`});`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(k.pid));`,
			`k.stdin.write(${JSON.stringify(`${busyRequest}\n`)});`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const owner = spawn(process.execPath, ["-e", ownerScript, ownerIdentity.argument], {
			stdio: ["ignore", "ignore", "inherit"],
		});
		let runtimePid = 0;
		let runtimeExactId: string | undefined;
		let ownerExactId: string | undefined;

		try {
			await vi.waitFor(
				() => {
					runtimePid = Number(readFileSync(pidFile, "utf8"));
					expect(runtimePid).toBeGreaterThan(0);
					expect(() => process.kill(runtimePid, 0)).not.toThrow();
					// The marker proves the busy cell has entered its spin.
					expect(existsSync(busyFile)).toBe(true);
				},
				{ timeout: 20_000, interval: 500 },
			);

			runtimeExactId = requireExactProcessIdentity(runtimePid);
			ownerExactId = requireExactProcessIdentity(owner.pid!);
			signalExactTestProcess(owner.pid!, ownerExactId, "SIGKILL");

			await vi.waitFor(
				() => {
					expect(() => process.kill(runtimePid, 0)).toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);
		} finally {
			if (runtimePid > 0 && runtimeExactId) signalExactTestProcess(runtimePid, runtimeExactId, "SIGKILL");
			if (owner.pid && ownerExactId) signalExactTestProcess(owner.pid, ownerExactId, "SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
