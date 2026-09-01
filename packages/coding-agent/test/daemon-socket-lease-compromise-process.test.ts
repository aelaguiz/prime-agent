import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	matchesExactProcessIdentity,
	observeProcessIdentity,
} from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxLoaderPath = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");
const children = new Set<ChildProcess>();
const childProcessStartIds = new Map<number, string>();
const workerProcessStartIds = new Map<number, string>();
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
		const processStartId = child.pid ? childProcessStartIds.get(child.pid) : undefined;
		if (
			child.exitCode === null &&
			child.signalCode === null &&
			child.pid &&
			processStartId &&
			matchesExactProcessIdentity(child.pid, processStartId)
		) {
			child.kill("SIGTERM");
		}
		await waitForExit(child).catch(() => undefined);
	}
	children.clear();
	childProcessStartIds.clear();
	for (const [pid, processStartId] of workerProcessStartIds) {
		if (!matchesExactProcessIdentity(pid, processStartId)) continue;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			if (matchesExactProcessIdentity(pid, processStartId)) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// Already gone.
				}
			}
		}
		await waitForProcessGone(pid).catch(() => undefined);
	}
	workerProcessStartIds.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("live daemon socket lease compromise", () => {
	it("keeps read-only access alive after out-of-band socket guard removal", async () => {
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

		const supervisorIdentity = createProcessIdentityOwnerToken();
		const supervisor = spawn(
			process.execPath,
			["--import", tsxLoaderPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				argv0: supervisorIdentity.argument,
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
		const ownerRegistry = join(root, "supervisor-owners");
		const ownerPath = readdirSync(ownerRegistry, { recursive: true })
			.map(String)
			.find((value) => value.endsWith("owner.json"));
		expect(ownerPath).toBeDefined();
		const ownerRecord = JSON.parse(readFileSync(join(ownerRegistry, ownerPath!), "utf8")) as {
			pid?: number;
		};
		expect(ownerRecord.pid).toBe(supervisor.pid);
		expect(observeProcessIdentity(supervisor.pid!)).toEqual({
			status: "present-exact",
			id: supervisorIdentity.processStartId,
		});
		childProcessStartIds.set(supervisor.pid!, supervisorIdentity.processStartId);
		const created = await firstClient.request(
			{
				type: "create",
				sessionPath: sessionFile,
				config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
			},
			40_000,
		);
		if (!created.success) {
			throw new Error(created.error);
		}
		const createdSummary = requireSummary(created.data);
		if (!createdSummary.workerPid || !createdSummary.activeSessionId) {
			throw new Error("Resident session did not expose its process identity");
		}
		const workerProcessStartId = getProcessStartId(createdSummary.workerPid);
		expect(workerProcessStartId).toBeDefined();
		workerProcessStartIds.set(createdSummary.workerPid, workerProcessStartId!);

		// Simulate out-of-band removal. The durable guard has no stale-time
		// callback, so this must not crash an otherwise idle control plane.
		rmSync(`${socketPath}.lock`, { recursive: true, force: true });

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
		replacementClient.close();
		// Graceful shutdown performs persistence and therefore must not run after
		// lease compromise. End the fixture out of band instead.
		expect(matchesExactProcessIdentity(supervisor.pid!, supervisorIdentity.processStartId)).toBe(true);
		supervisor.kill("SIGKILL");
		await waitForExit(supervisor);
		children.delete(supervisor);
		childProcessStartIds.delete(supervisor.pid!);
		if (matchesExactProcessIdentity(createdSummary.workerPid, workerProcessStartId!)) {
			try {
				process.kill(-createdSummary.workerPid, "SIGKILL");
			} catch {
				if (matchesExactProcessIdentity(createdSummary.workerPid, workerProcessStartId!)) {
					process.kill(createdSummary.workerPid, "SIGKILL");
				}
			}
		}
		await waitForProcessGone(createdSummary.workerPid);
		workerProcessStartIds.delete(createdSummary.workerPid);
	}, 45_000);
});
