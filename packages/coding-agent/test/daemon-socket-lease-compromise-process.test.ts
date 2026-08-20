import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const tempDirs: string[] = [];

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for supervisor exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
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
				return;
			}
		}
		await delay(25);
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(25);
		}
	}
	throw new Error(`Timed out waiting for supervisor: ${String(lastError)}`);
}

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function requireSessionList(responseData: unknown): SessionSummary[] {
	if (!responseData || typeof responseData !== "object" || !("sessions" in responseData)) {
		throw new Error("Missing daemon session list");
	}
	const sessions = (responseData as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Invalid daemon session list");
	}
	return sessions as SessionSummary[];
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
		await waitForExit(child).catch(() => undefined);
	}
	children.clear();
	for (const pid of workerPids) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
		await waitForProcessGone(pid).catch(() => undefined);
	}
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("live daemon socket lease compromise", () => {
	it("keeps the same resident session listable and attachable after its socket lease is stolen", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-live-lock-compromise-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "live lock-compromise fixture", timestamp: 1 });
		sessionManager.flushNow();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const supervisor = spawn(
			process.execPath,
			[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: join(root, "supervisor-owners"),
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: "ignore",
			},
		);
		children.add(supervisor);

		const firstClient = await connectEventually(socketPath, supervisor);
		const created = await firstClient.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}
		const createdSummary = requireSummary(created.data);
		if (!createdSummary.workerPid || !createdSummary.activeSessionId) {
			throw new Error("Resident session did not expose its process identity");
		}
		workerPids.add(createdSummary.workerPid);

		// Simulate a contender judging the supervisor's long-lived socket lock stale.
		rmSync(`${socketPath}.lock`, { recursive: true, force: true });
		await delay(2_000);

		// Probe 1: the original control connection and resident worker remain alive.
		expect(supervisor.exitCode).toBeNull();
		const listed = await firstClient.request({ type: "list" });
		if (!listed.success) {
			throw new Error(listed.error);
		}
		expect(requireSessionList(listed.data)).toContainEqual(
			expect.objectContaining({
				activeSessionId: createdSummary.activeSessionId,
				workerPid: createdSummary.workerPid,
			}),
		);

		// Probe 2: a fresh client can reconnect and attach to the same session snapshot.
		firstClient.close();
		const replacementClient = await connectEventually(socketPath, supervisor);
		const connection = await DaemonAgentConnection.attach(replacementClient, createdSummary.activeSessionId, {
			closeClientOnDispose: false,
			recoverDaemon: async () => {},
		});
		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: "live lock-compromise fixture" }),
		);
		await connection.dispose();
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForExit(supervisor);
		children.delete(supervisor);
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
	}, 30_000);
});
