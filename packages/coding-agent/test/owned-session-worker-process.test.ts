import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapOrphanProcessCandidate } from "../src/core/orphan-process-journal.js";
import {
	isExactProcessStartId,
	matchesExactProcessIdentity,
	observeProcessIdentity,
} from "../src/core/session-lease.js";

const fixturePath = resolve(__dirname, "fixtures/owned-session-worker-fixture.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerProcesses = new Map<number, string>();
const frontendProcesses = new Map<number, string>();

async function trackExactProcess(targets: Map<number, string>, pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const observation = observeProcessIdentity(pid);
		if (observation.status === "absent") return;
		if (observation.status === "present-exact" && isExactProcessStartId(observation.id)) {
			targets.set(pid, observation.id);
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	let command = "unavailable";
	try {
		command = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {}
	throw new Error(`Test process ${pid} did not expose an exact identity while live: ${command}`);
}

function signalTrackedExactProcess(targets: Map<number, string>, pid: number, signal: NodeJS.Signals): boolean {
	const exactId = targets.get(pid);
	const observation = observeProcessIdentity(pid);
	if (observation.status === "absent") return false;
	if (!exactId || observation.status !== "present-exact" || observation.id !== exactId) {
		throw new Error(
			`Retained cleanup artifact: ${JSON.stringify({ pid, exactId, reason: "exact identity mismatch or unavailable" })}`,
		);
	}
	process.kill(pid, signal);
	return true;
}

async function reapTrackedProcesses(targets: Map<number, string>): Promise<string[]> {
	const retained: string[] = [];
	for (const [pid, exactId] of targets) {
		const observation = observeProcessIdentity(pid);
		if (observation.status === "absent") continue;
		if (observation.status !== "present-exact" || observation.id !== exactId) {
			retained.push(JSON.stringify({ pid, exactId, reason: "exact identity mismatch or unavailable" }));
			continue;
		}
		await reapOrphanProcessCandidate({ pid, processStartId: exactId });
		if (!matchesExactProcessIdentity(pid, exactId)) continue;
		try {
			// The canonical reaper cannot signal a non-group-leader test fixture.
			// This raw fallback remains authorized by the fresh exact match above.
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	targets.clear();
	return retained;
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
			await trackExactProcess(frontendProcesses, child.pid);
			signalTrackedExactProcess(frontendProcesses, child.pid, "SIGKILL");
		}
	}
	children.clear();
	const retained = [
		...(await reapTrackedProcesses(frontendProcesses)),
		...(await reapTrackedProcesses(workerProcesses)),
	];
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	if (retained.length > 0) {
		throw new Error(`Retained cleanup artifacts: ${retained.join(", ")}`);
	}
});

function spawnFrontend(
	args: string[],
	pidPath: string,
	keepAlive = false,
	environment: NodeJS.ProcessEnv = {},
): ChildProcess {
	const cleanEnvironment = { ...process.env };
	for (const name of Object.keys(cleanEnvironment)) {
		if (name.startsWith("RLM_") || name.startsWith("PRIME_AGENT_INTERNAL_")) delete cleanEnvironment[name];
	}
	const processIdentityOwnerToken = randomBytes(32).toString("hex");
	const child = spawn(
		process.execPath,
		[tsxPath, fixturePath, ...args, `prime-agent-owner-token=${processIdentityOwnerToken}`],
		{
			argv0: `${process.execPath} prime-agent-owner-token=${processIdentityOwnerToken}`,
			env: {
				...cleanEnvironment,
				...environment,
				PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
				PRIME_AGENT_TEST_OWNED_PID_PATH: pidPath,
				...(keepAlive ? { PRIME_AGENT_TEST_KEEP_ALIVE: "1" } : {}),
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.add(child);
	return child;
}

function readLifecycleRecords(agentDir: string): Array<Record<string, unknown>> {
	const directory = join(agentDir, "logs", "processes");
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) =>
				readFileSync(join(directory, name), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>),
			);
	} catch {
		return [];
	}
}

async function waitForWorkerPid(path: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				await trackExactProcess(workerProcesses, pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned worker did not publish its pid");
}

async function waitForReplacementWorkerPid(path: string, previousPid: number): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) {
				await trackExactProcess(workerProcesses, pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned replacement worker did not publish its pid");
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	}
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for frontend exit")), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				workerProcesses.delete(pid);
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Owned worker ${pid} remained alive`);
}

describe("owned session worker processes", () => {
	it("runs target module setup only after the exact gate owner is durably enrolled", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-preexec-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["-p", "hello"], pidPath, true);
		const workerPid = await waitForWorkerPid(pidPath);
		const gatePid = Number(readFileSync(`${pidPath}.ppid`, "utf8").trim());
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		expect(workerPid).not.toBe(gatePid);
		expect(gatePid).not.toBe(frontendPid);
		const journalPath = readFileSync(`${pidPath}.orphan-path`, "utf8").trim();
		const records = readFileSync(journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(records[0]).toMatchObject({ version: 2, type: "authority", sequence: 0 });
		expect(records[1]).toMatchObject({
			version: 2,
			type: "process",
			sequence: 1,
			pid: gatePid,
			ownerPid: frontendPid,
			state: "enrolled",
		});
		expect(isExactProcessStartId(String(records[1]?.authorityProcessStartId))).toBe(true);

		signalTrackedExactProcess(workerProcesses, workerPid, "SIGTERM");
		await waitForExit(frontend);
		children.delete(frontend);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(gatePid);
	});

	it("does not run or replace target setup when the parent commit failpoint fires", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-precommit-failure-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const agentDir = join(root, "agent");
		const frontend = spawnFrontend(["-p", "hello"], pidPath, false, {
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_TEST_FAIL_OWNED_STARTUP_COMMIT: "1",
		});
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit.code).not.toBe(0);
		expect(existsSync(pidPath)).toBe(false);
		const lifecycle = readLifecycleRecords(agentDir);
		const spawned = lifecycle.filter(
			(record) =>
				record.event === "owned_session_worker_launch" &&
				(record.details as { phase?: string } | undefined)?.phase === "spawned",
		);
		expect(spawned).toHaveLength(1);
		expect(lifecycle).toContainEqual(
			expect.objectContaining({
				event: "owned_session_worker_spawn_error",
				details: expect.objectContaining({ cleanupVerified: true }),
			}),
		);
	});
	it("routes every headless surface through its real worker profile", async () => {
		const cases: Array<[string[], string | undefined, string, boolean?]> = [
			[["-p", "hello"], undefined, "print"],
			[[], "hello", "print", false],
			[["--mode", "json"], "", "json"],
			[["--mode", "rpc"], `${JSON.stringify({ id: "state", type: "get_state" })}\n`, "rpc"],
			[["--no-session"], undefined, "interactive-ephemeral", true],
		];
		for (const [args, stdin, profile, tty] of cases) {
			const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-routing-"));
			tempDirs.push(root);
			const pidPath = join(root, "worker.pid");
			const frontend = spawnFrontend(
				args,
				pidPath,
				tty === false,
				tty === undefined ? {} : { PRIME_AGENT_TEST_STDIN_TTY: tty ? "1" : "0" },
			);
			if (stdin !== undefined) frontend.stdin?.write(stdin);
			const workerPid = await waitForWorkerPid(pidPath);
			expect(readFileSync(`${pidPath}.profile`, "utf8").trim()).toBe(profile);
			frontend.stdin?.end();
			if (tty === false) signalTrackedExactProcess(workerProcesses, workerPid, "SIGKILL");
			await waitForExit(frontend);
			children.delete(frontend);
			await waitForProcessGone(workerPid);
		}
	});

	it("keeps RPC framing in the frontend and exits its worker on stdin EOF", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath);
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("correlates overlapping anonymous RPC commands without exposing internal ids", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_REVERSE_RPC_RESPONSES: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(
			`${JSON.stringify({ type: "get_state", marker: "first" })}\n${JSON.stringify({ type: "get_state", marker: "second" })}\n`,
		);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "second" })}\n${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "first" })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("drops malformed worker output instead of corrupting public RPC JSONL", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_INVALID_RPC_OUTPUT: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("does not fabricate a recovery response for response-less acknowledgements", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const agentDir = join(root, "agent");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_TEST_CRASH_ON_ACK: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const workerPid = await waitForWorkerPid(pidPath);
		const workerGatePid = Number(readFileSync(`${pidPath}.ppid`, "utf8").trim());
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result", commandId: "command-1" })}\n`);
		const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid);
		const replacementGatePid = Number(readFileSync(`${pidPath}.ppid`, "utf8").trim());
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		const lifecycle = readLifecycleRecords(agentDir);
		const crashed = lifecycle.find(
			(record) =>
				record.event === "owned_session_worker_close" &&
				(record.details as { childPid?: number } | undefined)?.childPid === workerGatePid,
		);
		expect(crashed).toEqual(
			expect.objectContaining({
				details: expect.objectContaining({ code: 1, expected: false, reason: "unexpected" }),
			}),
		);
		const crashedDetails = crashed?.details as { childProcessInstanceId?: string } | undefined;
		const recovered = lifecycle.find(
			(record) =>
				record.event === "owned_session_worker_recovery_result" &&
				(record.details as { childPid?: number; status?: string } | undefined)?.childPid === replacementGatePid,
		);
		expect(recovered).toEqual(
			expect.objectContaining({ details: expect.objectContaining({ attempt: 1, status: "spawned" }) }),
		);
		const recoveredDetails = recovered?.details as { childProcessInstanceId?: string } | undefined;
		expect(recoveredDetails?.childProcessInstanceId).toEqual(expect.any(String));
		expect(recoveredDetails?.childProcessInstanceId).not.toBe(crashedDetails?.childProcessInstanceId);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(replacementPid);
	});

	it("blocks RPC restart and retains recovery authority when cleanup proof fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-cleanup-gate-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const agentDir = join(root, "agent");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_TEST_CRASH_ON_ACK: "1",
			PRIME_AGENT_TEST_CORRUPT_ORPHAN_JOURNAL_ON_CRASH: "1",
		});
		const workerPid = await waitForWorkerPid(pidPath);
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result", commandId: "command-1" })}\n`);

		const deadline = Date.now() + 10_000;
		let cleanupFailed = false;
		while (Date.now() < deadline) {
			cleanupFailed = readLifecycleRecords(agentDir).some(
				(record) =>
					record.event === "owned_session_worker_recovery_result" &&
					(record.details as { status?: string } | undefined)?.status === "cleanup_failed",
			);
			if (cleanupFailed) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(cleanupFailed).toBe(true);
		expect(Number(readFileSync(pidPath, "utf8").trim())).toBe(workerPid);
		frontend.stdin?.end();
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		const recoveryDescriptorPath = readFileSync(`${pidPath}.recovery-path`, "utf8").trim();
		const orphanProcessJournalPath = readFileSync(`${pidPath}.orphan-path`, "utf8").trim();
		expect(exit).toEqual({ code: 1, signal: null });
		expect(existsSync(recoveryDescriptorPath)).toBe(true);
		expect(readFileSync(orphanProcessJournalPath, "utf8")).toBe("{not-json}\n");
		rmSync(recoveryDescriptorPath, { force: true });
		rmSync(orphanProcessJournalPath, { force: true });
		await waitForProcessGone(workerPid);
	});

	it("fails pending RPC commands when stdin closes before the worker crashes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_CRASH_ON_COMMAND: "get_state",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("fails pending RPC commands when the worker exits successfully without responding", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const agentDir = join(root, "agent");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_TEST_EXIT_ZERO_ON_COMMAND: "get_state",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const workerGatePid = Number(readFileSync(`${pidPath}.ppid`, "utf8").trim());
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		expect(readLifecycleRecords(agentDir)).toContainEqual(
			expect.objectContaining({
				event: "owned_session_worker_close",
				details: expect.objectContaining({
					childPid: workerGatePid,
					code: 0,
					expected: false,
					reason: "pending-rpc-commands",
				}),
			}),
		);
		await waitForProcessGone(workerPid);
	});

	it("terminates the owned worker when its frontend is killed", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["-p", "hello"], pidPath, true);
		const workerPid = await waitForWorkerPid(pidPath);
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		const gatePid = Number(readFileSync(`${pidPath}.ppid`, "utf8").trim());
		await trackExactProcess(frontendProcesses, frontendPid);
		expect(gatePid).not.toBe(frontendPid);

		signalTrackedExactProcess(frontendProcesses, frontendPid, "SIGKILL");
		await waitForExit(frontend);
		children.delete(frontend);
		frontendProcesses.delete(frontendPid);
		const terminationDeadline = Date.now() + 5000;
		while (!existsSync(`${pidPath}.terminated`) && Date.now() < terminationDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(existsSync(`${pidPath}.terminated`)).toBe(true);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(gatePid);
	});
});
