import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listActiveDaemonSessionSummaries } from "../src/cli/daemon-launch.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const children = new Set<ChildProcess>();
const processGroupChildren = new Set<ChildProcess>();
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

function isolatedCliEnv(agentDir: string, registryDir: string, tempDir: string, fakeBinDir: string): NodeJS.ProcessEnv {
	const env = isolatedDaemonEnv(agentDir, registryDir);
	env.TMPDIR = tempDir;
	env.PATH = `${fakeBinDir}:${env.PATH ?? ""}`;
	env.TERM = "xterm-256color";
	delete env.CI;
	return env;
}

function writeIsolatedSs(fakeBinDir: string, daemons: Array<{ pid: number; socketPath: string }>): void {
	mkdirSync(fakeBinDir, { recursive: true });
	const listeners = daemons
		.map(({ pid, socketPath }) => `u_str LISTEN 0 128 ${socketPath} 0 * 0 users:(("prime-agent",pid=${pid},fd=3))`)
		.join("\n");
	const scriptPath = join(fakeBinDir, "ss");
	writeFileSync(scriptPath, `#!/bin/sh\ncat <<'EOF'\n${listeners}\nEOF\n`);
	chmodSync(scriptPath, 0o755);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
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

async function waitForOwnerAttachment(
	client: DaemonClient,
	activeSessionId: string,
	cli: ChildProcess,
	readOutput: () => string,
): Promise<SessionSummary> {
	const deadline = Date.now() + 20_000;
	let lastSummary: SessionSummary | undefined;
	while (Date.now() < deadline) {
		if (cli.exitCode !== null || cli.signalCode !== null) {
			throw new Error(
				`PTY CLI exited before attaching (code ${cli.exitCode}, signal ${cli.signalCode}): ${readOutput()}`,
			);
		}
		const response = await client.request({ type: "get_state", activeSessionId });
		if (response.success) {
			lastSummary = requireSummary(response.data);
			if (lastSummary.attachedClients > 0) return lastSummary;
		}
		await delay(50);
	}
	throw new Error(`PTY CLI did not attach to owner; last summary: ${JSON.stringify(lastSummary)}; ${readOutput()}`);
}

afterEach(async () => {
	for (const child of processGroupChildren) {
		signalProcessGroup(child, "SIGTERM");
		await waitForExit(child).catch(() => {
			signalProcessGroup(child, "SIGKILL");
		});
	}
	processGroupChildren.clear();
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

describe.skipIf(process.platform !== "darwin")("cross-daemon resume routing CLI process boundary", () => {
	it("routes a real implicit-socket path resume to its owning daemon", async () => {
		const root = mkdtempSync("/tmp/pa-cross-resume-");
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const registryDir = join(root, "registry");
		const isolatedTmp = join(root, "tmp");
		const defaultSocketDir = join(
			isolatedTmp,
			`prime-agent-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
		);
		const defaultSocket = join(defaultSocketDir, "daemon.sock");
		const ownerSocket = join(root, "owner.sock");
		const fakeBinDir = join(root, "bin");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(defaultSocketDir, { recursive: true });

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
		expect(createdSummary.attachedClients).toBe(0);
		if (!defaultDaemon.child.pid || !ownerDaemon.child.pid) throw new Error("Supervisor PID unavailable");
		writeIsolatedSs(fakeBinDir, [
			{ pid: defaultDaemon.child.pid, socketPath: defaultSocket },
			{ pid: ownerDaemon.child.pid, socketPath: ownerSocket },
		]);

		let cliOutput = "";
		const cli = spawn(
			"/usr/bin/script",
			["-q", "/dev/null", process.execPath, tsxPath, cliPath, "--resume", sessionFile, "--offline"],
			{
				cwd: projectDir,
				env: isolatedCliEnv(agentDir, registryDir, isolatedTmp, fakeBinDir),
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		processGroupChildren.add(cli);
		const capture = (chunk: Buffer) => {
			cliOutput = (cliOutput + chunk.toString("utf8")).slice(-16_000);
		};
		cli.stdout?.on("data", capture);
		cli.stderr?.on("data", capture);

		const attached = await waitForOwnerAttachment(
			ownerDaemon.client,
			createdSummary.activeSessionId,
			cli,
			() => cliOutput,
		);
		expect(attached.sessionFile).toBe(sessionFile);
		const defaultSessions = await listActiveDaemonSessionSummaries(defaultDaemon.client, {
			includeClientOwned: true,
		});
		expect(defaultSessions.filter((summary) => summary.activeSessionId)).toEqual([]);

		signalProcessGroup(cli, "SIGTERM");
		await waitForExit(cli);
		processGroupChildren.delete(cli);
		await defaultDaemon.client.request({ type: "shutdown" });
		defaultDaemon.client.close();
		await ownerDaemon.client.request({ type: "shutdown" });
		ownerDaemon.client.close();
		await Promise.all([waitForExit(defaultDaemon.child), waitForExit(ownerDaemon.child)]);
		children.delete(defaultDaemon.child);
		children.delete(ownerDaemon.child);
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
	}, 40_000);
});
