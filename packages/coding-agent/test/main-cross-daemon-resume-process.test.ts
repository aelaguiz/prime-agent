import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { findActiveDaemonSessionAcrossDaemons } from "../src/main.js";
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
	if (child.exitCode !== null || child.signalCode !== null) return;
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
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		}
		await delay(25);
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

function isolatedDaemonEnv(agentDir: string, registryDir: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.startsWith("PRIME_AGENT_INTERNAL_") || name.startsWith("RLM_")) delete env[name];
	}
	env[ENV_AGENT_DIR] = agentDir;
	env.PI_OFFLINE = "1";
	env.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR = registryDir;
	env.TSX_TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
	return env;
}

async function connectEventually(socketPath: string, child: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`Supervisor exited before readiness (code ${child.exitCode}, signal ${child.signalCode})`);
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

async function startDaemon(
	socketPath: string,
	projectDir: string,
	agentDir: string,
	registryDir: string,
): Promise<{ child: ChildProcess; client: DaemonClient }> {
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd: projectDir,
			env: isolatedDaemonEnv(agentDir, registryDir),
			stdio: "ignore",
		},
	);
	children.add(child);
	return { child, client: await connectEventually(socketPath, child) };
}

function requireSummary(data: unknown): SessionSummary {
	if (!data || typeof data !== "object") throw new Error("Missing daemon session summary");
	return data as SessionSummary;
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
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
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("cross-daemon resume routing process boundary", () => {
	it("routes an implicit-socket saved-session resume to its owning daemon", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-cross-daemon-resume-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const registryDir = join(root, "supervisor-owners");
		const defaultSocket = join(root, "default.sock");
		const ownerSocket = join(root, "owner.sock");
		mkdirSync(projectDir, { recursive: true });

		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "cross-daemon resume fixture", timestamp: 1 });
		sessionManager.flushNow();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");

		const defaultDaemon = await startDaemon(defaultSocket, projectDir, agentDir, registryDir);
		const ownerDaemon = await startDaemon(ownerSocket, projectDir, agentDir, registryDir);
		const created = await ownerDaemon.client.request({
			type: "create",
			sessionPath: sessionFile,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!created.success) throw new Error(created.error);
		const createdSummary = requireSummary(created.data);
		if (!createdSummary.workerPid || !createdSummary.activeSessionId) {
			throw new Error("Resident session did not expose its process identity");
		}
		workerPids.add(createdSummary.workerPid);

		const location = await findActiveDaemonSessionAcrossDaemons(defaultSocket, createdSummary.sessionId, {
			discoverSocketPaths: async () => [defaultSocket, ownerSocket],
		});
		expect(location).toMatchObject({
			socketPath: ownerSocket,
			summary: { activeSessionId: createdSummary.activeSessionId, sessionId: createdSummary.sessionId },
		});
		if (!location) throw new Error("Owning daemon was not resolved");

		const routedClient = new DaemonClient(location.socketPath);
		await routedClient.connect();
		const connection = await DaemonAgentConnection.attach(routedClient, location.summary.activeSessionId!, {
			closeClientOnDispose: false,
			recoverDaemon: async () => {},
		});
		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: "cross-daemon resume fixture" }),
		);
		await connection.dispose();
		routedClient.close();

		await defaultDaemon.client.request({ type: "shutdown" });
		defaultDaemon.client.close();
		await ownerDaemon.client.request({ type: "shutdown" });
		ownerDaemon.client.close();
		await Promise.all([waitForExit(defaultDaemon.child), waitForExit(ownerDaemon.child)]);
		children.delete(defaultDaemon.child);
		children.delete(ownerDaemon.child);
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
	}, 30_000);
});
