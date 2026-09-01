/**
 * Daemon launch/readiness helpers.
 *
 * This module stays light on imports so clients can start a cold daemon before
 * the heavy main module graph loads. main.ts reuses the same memoized promise.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { appendRotatingLog, expandTildePath, getClientErrorLogPath, getDaemonLogPath, VERSION } from "../config.js";
import { ORPHAN_PROCESS_JOURNAL_ENV, ORPHAN_PROCESS_JOURNAL_GENERATION_ENV } from "../core/orphan-process-journal.js";
import { prepareProcessLifecycleLaunch, recordProcessLifecycle } from "../core/process-lifecycle.js";
import {
	classifyProcessIdentityAuthority,
	createProcessIdentityOwnerToken,
	matchesExactProcessIdentity,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../core/session-lease.js";
import { DaemonClient, type DaemonHello } from "../modes/daemon/daemon-client.js";
import { tryAcquireDaemonLaunchLease } from "../modes/daemon/daemon-launch-lease.js";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	parseDaemonSupervisorHelloIdentity,
} from "../modes/daemon/daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "../modes/daemon/daemon-runtime-identity.js";
import { isSessionSummaryBusy, type SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
} from "../modes/daemon/daemon-worker-protocol.js";
import { isHelpCommandRequest, PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec, formatCurrentCliCommand } from "./subprocess-launch.js";

const DAEMON_STARTUP_TIMEOUT_MS = 120_000;
const DAEMON_STARTUP_EXIT_GRACE_MS = 2_000;
const DAEMON_STARTUP_LOG_TAIL_BYTES = 4 * 1024;

export function isDaemonSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const summary = value as { activeSessionId?: unknown; id?: unknown };
	return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Daemon replacement used to be silent (no crash, no log), so a daemon dying
// out from under another window looked "random". Trace the decisions to the
// client-errors log so replacements are attributable after the fact.
function logDaemonLaunch(message: string): void {
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] daemon-launch: ${message}`);
}

interface DaemonStartupTrace {
	id: string;
	startedAt: number;
	logOffset: number;
}

function startupTraceDetails(
	trace: DaemonStartupTrace,
	phase: string,
	lastProbe: DaemonVersionProbe["status"],
	leaseWaitStartedAt?: number,
): string {
	const elapsedMs = Date.now() - trace.startedAt;
	const lease = leaseWaitStartedAt
		? `launchLease=contended:${Date.now() - leaseWaitStartedAt}ms`
		: "launchLease=acquired-or-not-needed";
	return `trace=${trace.id} phase=${phase} elapsedMs=${elapsedMs} clientPid=${process.pid} lastProbe=${lastProbe} ${lease}`;
}

async function canConnectToDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

type DaemonVersionProbe =
	| { status: "absent" }
	| { status: "current"; hello: DaemonHello }
	| { status: "stale"; hello: DaemonHello }
	| { status: "unresponsive" };

function isCurrentDaemonHello(hello: DaemonHello): boolean {
	return (
		hello.protocol.version === DAEMON_PROTOCOL_VERSION &&
		hello.schemaId === DAEMON_SCHEMA_ID &&
		hello.appVersion === VERSION
	);
}

/** Connect to a running daemon and check whether its wire contract and app version match this client. */
export async function probeDaemonVersion(socketPath: string, helloTimeoutMs = 2000): Promise<DaemonVersionProbe> {
	let client: DaemonClient | undefined;
	for (const timeoutMs of [250, 2000]) {
		const candidate = new DaemonClient(socketPath);
		try {
			await candidate.connect(timeoutMs);
			client = candidate;
			break;
		} catch {
			candidate.close();
		}
	}
	if (!client) {
		return { status: "absent" };
	}
	try {
		const hello = await client.waitForHello(helloTimeoutMs);
		const current = isCurrentDaemonHello(hello);
		if (!current) {
			logDaemonLaunch(
				`running daemon on ${socketPath} differs from this client (connecting anyway): daemon v${hello.appVersion}/proto${hello.protocol.version}` +
					`/schema ${hello.schemaId ?? "legacy"}/build ${hello.runtime?.buildId ?? "unknown"} vs client ` +
					`v${VERSION}/proto${DAEMON_PROTOCOL_VERSION}/schema ${DAEMON_SCHEMA_ID}`,
			);
		}
		// Version/build differences never block or replace a healthy daemon in this
		// fork: dev-tree clients change constantly and the operator prefers
		// connecting across drift over restart prompts. A real wire-contract break
		// is accepted and diagnosed from the log line above.
		return { status: "current", hello };
	} catch {
		// The supervisor accepts connections before startup and worker adoption finish.
		return { status: "unresponsive" };
	} finally {
		client.close();
	}
}

export async function listActiveDaemonSessionSummaries(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<SessionSummary[]> {
	return (await queryActiveDaemonSessions(client, options)).sessions;
}

async function queryActiveDaemonSessions(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<{ sessions: SessionSummary[]; busyClientOwnedSessionCount: number }> {
	const response = await client.request({ type: "list", includeClientOwned: options.includeClientOwned });
	if (!response.success) {
		throw new Error(response.error);
	}
	const data = response.data;
	if (!data || typeof data !== "object" || !("sessions" in data)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	const sessions = (data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	if (!sessions.every(isDaemonSessionSummary)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	const busyClientOwnedSessionCount = (data as { busyClientOwnedSessionCount?: unknown }).busyClientOwnedSessionCount;
	if (
		busyClientOwnedSessionCount !== undefined &&
		(typeof busyClientOwnedSessionCount !== "number" ||
			!Number.isInteger(busyClientOwnedSessionCount) ||
			busyClientOwnedSessionCount < 0)
	) {
		throw new Error("Daemon returned an invalid client-owned session count");
	}
	return { sessions, busyClientOwnedSessionCount: busyClientOwnedSessionCount ?? 0 };
}

/** Thrown when a reachable daemon never completes its handshake. */
export class DaemonHandshakeUnavailableError extends Error {
	constructor(
		readonly socketPath: string,
		cause?: Error,
	) {
		super(
			`A Prime Agent daemon is reachable but did not become ready. ${cause?.message ?? "The daemon handshake timed out."} ` +
				`Socket: ${socketPath}. Daemon log: ${getDaemonLogPath(socketPath)}.`,
			{ cause },
		);
		this.name = "DaemonHandshakeUnavailableError";
	}
}

/** Thrown when a stale-version daemon can't be replaced. The message is user-facing. */
export class StaleDaemonError extends Error {
	constructor(
		readonly socketPath: string,
		hello?: DaemonHello,
	) {
		const daemonIdentity = hello
			? `Daemon: v${hello.appVersion ?? "unknown"}, protocol ${hello.protocol.version}, schema ${hello.schemaId ?? "legacy"}, ` +
				`build ${hello.runtime?.buildId ?? "unknown"}, PID ${hello.supervisorPid ?? "unknown"}, ` +
				`executable ${hello.runtime?.launcherPath ?? hello.runtime?.entrypointPath ?? hello.runtime?.executablePath ?? "unknown"}`
			: `Daemon: unknown build on ${socketPath}`;
		const client = getDaemonRuntimeIdentity();
		super(
			`An incompatible Prime Agent daemon is running.\n\n${daemonIdentity}\n` +
				`Client: v${VERSION}, protocol ${DAEMON_PROTOCOL_VERSION}, schema ${DAEMON_SCHEMA_ID}, build ${client.buildId}, ` +
				`executable ${client.launcherPath ?? client.entrypointPath ?? client.executablePath}\n\n` +
				"Prime Agent left the existing daemon running to protect active work. Continue with the build that started it, " +
				"or retry after its sessions are idle.",
		);
		this.name = "StaleDaemonError";
	}
}

interface DaemonProcessIdentity {
	pid: number;
	processStartId?: string;
}

const PROCESS_START_ID_POLL_INTERVAL_MS = 1000;

function hasProcessIdentityExited(identity: DaemonProcessIdentity | undefined, verifyProcessStartId = true): boolean {
	if (!identity) {
		return true;
	}
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (!identity.processStartId || !verifyProcessStartId) {
		return false;
	}
	return classifyProcessIdentityAuthority(identity.pid, identity.processStartId) === "exact-dead";
}

async function waitForDaemonGone(
	socketPath: string,
	timeoutMs = 5000,
	requireSocketCleanup = false,
	expectedIdentity?: DaemonProcessIdentity,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let nextProcessStartIdPollAt = 0;
	const hasExpectedProcessExited = (forceStartIdPoll = false) => {
		const now = Date.now();
		const verifyProcessStartId = forceStartIdPoll || now >= nextProcessStartIdPollAt;
		if (verifyProcessStartId) {
			nextProcessStartIdPollAt = now + PROCESS_START_ID_POLL_INTERVAL_MS;
		}
		return hasProcessIdentityExited(expectedIdentity, verifyProcessStartId);
	};
	while (Date.now() < deadline) {
		if (
			!(await canConnectToDaemon(socketPath, 250)) &&
			(!requireSocketCleanup || process.platform === "win32" || !existsSync(socketPath)) &&
			hasExpectedProcessExited()
		) {
			return true;
		}
		await delay(25);
	}
	// A daemon can exit without removing its Unix socket (for example, after a crash
	// during shutdown). Once the cleanup grace has elapsed, a non-listening socket
	// is safe for the replacement daemon's guarded startup path to reclaim.
	return requireSocketCleanup && !(await canConnectToDaemon(socketPath, 250)) && hasExpectedProcessExited(true);
}

export function processIdentityFromDaemonHello(hello: DaemonHello | undefined): DaemonProcessIdentity | undefined {
	if (!hello) throw new Error("Daemon did not provide a verifiable hello");
	const pid = hello.supervisorPid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		throw new Error("Daemon hello contains an invalid supervisor PID");
	}
	const identity = parseDaemonSupervisorHelloIdentity(hello);
	if (identity.status === "invalid") {
		throw new Error(`Daemon hello contains an invalid supervisor process identity: ${identity.reason}`);
	}
	return identity.status === "exact" ? { pid, processStartId: identity.authorityProcessStartId } : { pid };
}

export async function shutdownConnectedDaemonAndWait(
	client: DaemonClient,
	socketPath: string,
	timeoutMs = 5000,
	hello: DaemonHello | undefined = client.hello,
): Promise<boolean> {
	let shutdownAccepted = false;
	let expectedIdentity: DaemonProcessIdentity | undefined;
	try {
		expectedIdentity = processIdentityFromDaemonHello(hello);
		if (
			expectedIdentity?.processStartId &&
			!matchesExactProcessIdentity(expectedIdentity.pid, expectedIdentity.processStartId)
		) {
			throw new Error("Daemon hello exact supervisor identity is not current");
		}
		const response = await client.request({ type: "shutdown" }).catch(() => undefined);
		shutdownAccepted = response?.success === true;
	} catch {
		// A connect failure isn't treated as "gone"; waitForDaemonGone is the source of truth.
	} finally {
		client.close();
	}
	return waitForDaemonGone(socketPath, timeoutMs, shutdownAccepted, expectedIdentity);
}

export async function shutdownDaemonAndWait(socketPath: string, timeoutMs = 5000): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(2000).catch(() => undefined);
		return await shutdownConnectedDaemonAndWait(client, socketPath, timeoutMs, hello);
	} catch {
		client.close();
		return waitForDaemonGone(socketPath, timeoutMs);
	}
}

// activeSessions is undefined when the daemon is reachable but its sessions couldn't
// be listed — callers must treat that as "possibly busy", not idle.
export type RunningDaemonProbe =
	| { reachable: false }
	| { reachable: true; activeSessions?: SessionSummary[]; busyClientOwnedSessionCount?: number };

export function isSessionBusy(summary: SessionSummary): boolean {
	return isSessionSummaryBusy(summary);
}

export async function probeRunningDaemonSessions(socketPath: string): Promise<RunningDaemonProbe> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
		return {
			reachable: true,
			activeSessions: result.sessions.filter((summary) => summary.activeSessionId !== undefined),
			...(result.busyClientOwnedSessionCount > 0
				? { busyClientOwnedSessionCount: result.busyClientOwnedSessionCount }
				: {}),
		};
	} catch {
		return { reachable: true };
	} finally {
		client.close();
	}
}

// Idle-but-loaded sessions reload from disk on the fresh daemon, so only a busy
// session blocks replacing a stale daemon.
type StaleDaemonDisposition = "current" | "stopped" | "busy";

async function shutdownStaleDaemonIfNotBusy(socketPath: string): Promise<StaleDaemonDisposition> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return (await waitForDaemonGone(socketPath)) ? "stopped" : "busy";
	}

	let loadedSessionCount = 0;
	let hasBusySessions = true;
	try {
		const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
		loadedSessionCount = result.sessions.length;
		hasBusySessions =
			result.busyClientOwnedSessionCount !== 0 || result.sessions.some((summary) => isSessionBusy(summary));
	} catch {
		// An unresponsive daemon is not safe to replace.
	}

	const hello = client.hello;
	if (hello && isCurrentDaemonHello(hello)) {
		client.close();
		logDaemonLaunch(`daemon on ${socketPath} finished starting while staleness was being checked; reusing it`);
		return "current";
	}
	if (hasBusySessions) {
		client.close();
		logDaemonLaunch(`refusing to replace stale daemon on ${socketPath}: busy session(s) present`);
		return "busy";
	}
	logDaemonLaunch(
		`replacing stale daemon on ${socketPath} (idle): ${loadedSessionCount} loaded session(s) will reload`,
	);
	return (await shutdownConnectedDaemonAndWait(client, socketPath, 5000, hello)) ? "stopped" : "busy";
}

async function ensureDaemonRunningAsLeader(
	socketPath: string,
	spawnCwd: string | undefined,
	deadline: number,
	trace: DaemonStartupTrace,
): Promise<void> {
	let probe = await probeDaemonVersion(socketPath);
	logDaemonLaunch(startupTraceDetails(trace, "leader_probe", probe.status));
	if (probe.status === "unresponsive") {
		const remainingStartupMs = Math.max(1, deadline - Date.now());
		logDaemonLaunch(
			`${startupTraceDetails(trace, "waiting_for_daemon_hello", probe.status)} remainingMs=${remainingStartupMs}`,
		);
		probe = await probeDaemonVersion(socketPath, remainingStartupMs);
	}
	if (probe.status === "current") {
		logDaemonLaunch(
			`${startupTraceDetails(trace, "ready", probe.status)} daemonPid=${probe.hello.supervisorPid ?? "unknown"} ` +
				`generation=${probe.hello.supervisorGeneration ?? "unknown"} build=${probe.hello.runtime?.buildId ?? "unknown"}`,
		);
		return;
	}
	if (probe.status === "unresponsive") {
		throw new Error(
			`Prime Agent daemon on ${socketPath} accepted connections but did not finish startup within ${DAEMON_STARTUP_TIMEOUT_MS / 1000} seconds. ` +
				`It was left running to avoid interrupting active work. ` +
				startupTraceDetails(trace, "hello_timeout", probe.status) +
				readDaemonLogTail(socketPath, trace.logOffset),
		);
	}
	if (probe.status === "stale") {
		const disposition = await shutdownStaleDaemonIfNotBusy(socketPath);
		if (disposition === "current") return;
		if (disposition === "busy") throw new StaleDaemonError(socketPath, probe.hello);
	}

	// Strip inherited daemon worker/supervisor role env vars so the spawned
	// daemon supervisor does not inherit worker-mode behavior. Without this,
	// a CLI running inside a daemon worker (e.g. a test spawned by the Prime
	// Agent daemon) would launch the supervisor in worker mode, which listens
	// on the socket but never sends the daemon_hello handshake.
	const env = createCliSubprocessEnv();
	delete env[DAEMON_WORKER_ROLE_ENV];
	delete env[DAEMON_WORKER_TOKEN_ENV];
	delete env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	delete env[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
	delete env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
	delete env[ORPHAN_PROCESS_JOURNAL_ENV];
	delete env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	delete env[SESSION_LEASES_ENABLED_ENV];
	delete env[SESSION_LEASE_OWNER_ID_ENV];

	const logOffset = currentDaemonLogSize(socketPath);
	const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", socketPath]);
	const ownerIdentity = createProcessIdentityOwnerToken();
	const trigger = "ensure_daemon_running";
	const preparedLaunch = prepareProcessLifecycleLaunch(env, {
		role: "daemon-supervisor",
		trigger,
		context: { socketPath },
	});
	recordProcessLifecycle("daemon_supervisor_launch", {
		phase: "attempt",
		childProcessInstanceId: preparedLaunch.childProcessInstanceId,
		trigger,
		socketPath,
	});
	logDaemonLaunch(
		`${startupTraceDetails(trace, "spawning_supervisor", probe.status)} command=${formatCurrentCliCommand([
			"--mode",
			"daemon",
			"--daemon-socket",
			socketPath,
		])} executable=${JSON.stringify(launch.command)} args=${JSON.stringify(launch.args)}`,
	);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(launch.command, launch.args, {
			argv0: ownerIdentity.argument,
			cwd: spawnCwd ?? process.cwd(),
			detached: true,
			env: preparedLaunch.environment,
			// A pipe would tie the daemon's stderr to this short-lived CLI
			// (EPIPE once it exits); crash details come from the daemon log,
			// which the supervisor writes to before rethrowing startup errors.
			stdio: "ignore",
		});
	} catch (error) {
		recordProcessLifecycle("daemon_supervisor_spawn_error", {
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			trigger,
			socketPath,
			errorMessage: error instanceof Error ? error.message : String(error),
			...((error as NodeJS.ErrnoException).code ? { errorCode: (error as NodeJS.ErrnoException).code } : {}),
		});
		throw error;
	}
	child.once("spawn", () => {
		recordProcessLifecycle("daemon_supervisor_launch", {
			phase: "spawned",
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			childPid: child.pid,
			trigger,
			socketPath,
		});
	});
	let childFailure:
		| { type: "error"; error: Error }
		| { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
		| undefined;
	child.once("error", (error) => {
		recordProcessLifecycle("daemon_supervisor_spawn_error", {
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			childPid: child.pid,
			trigger,
			socketPath,
			errorMessage: error.message,
			...((error as NodeJS.ErrnoException).code ? { errorCode: (error as NodeJS.ErrnoException).code } : {}),
		});
		childFailure ??= { type: "error", error };
	});
	child.once("exit", (code, signal) => {
		recordProcessLifecycle("daemon_supervisor_exit", {
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			childPid: child.pid,
			trigger,
			socketPath,
			expected: false,
			reason: "startup-exit",
			code,
			signal,
		});
		childFailure ??= { type: "exit", code, signal };
	});
	child.unref();

	const throwIfFailed = () => {
		if (!childFailure) {
			return;
		}
		const logTail = readDaemonLogTail(socketPath, logOffset);
		recordProcessLifecycle("daemon_supervisor_launch_result", {
			status: childFailure.type === "error" ? "spawn_error" : "early_exit",
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			childPid: child.pid,
			trigger,
			socketPath,
			...(childFailure.type === "error"
				? { errorMessage: childFailure.error.message }
				: { code: childFailure.code, signal: childFailure.signal }),
		});
		if (childFailure.type === "error") {
			throw new Error(`Failed to spawn Prime Agent daemon: ${childFailure.error.message}.${logTail}`);
		}
		const signal = childFailure.signal ? `, signal ${childFailure.signal}` : "";
		throw new Error(
			`Prime Agent daemon exited during startup (code ${childFailure.code ?? "unknown"}${signal}).${logTail}`,
		);
	};

	// A child exit is not immediately fatal: it may have lost the socket to an
	// older launcher that does not participate in the shared launch lease.
	let exitDeadline: number | undefined;
	while (Date.now() < Math.min(deadline, exitDeadline ?? Number.POSITIVE_INFINITY)) {
		const started = await probeDaemonVersion(socketPath);
		if (started.status === "current") {
			recordProcessLifecycle("daemon_supervisor_launch_result", {
				status: "ready",
				childProcessInstanceId: preparedLaunch.childProcessInstanceId,
				childPid: child.pid,
				trigger,
				socketPath,
			});
			logDaemonLaunch(
				`${startupTraceDetails(trace, "ready", started.status)} daemonPid=${started.hello.supervisorPid ?? "unknown"} ` +
					`generation=${started.hello.supervisorGeneration ?? "unknown"} build=${started.hello.runtime?.buildId ?? "unknown"}`,
			);
			return;
		}
		if (childFailure) exitDeadline ??= Date.now() + DAEMON_STARTUP_EXIT_GRACE_MS;
		await delay(25);
	}

	throwIfFailed();
	recordProcessLifecycle("daemon_supervisor_launch_result", {
		status: "timeout",
		childProcessInstanceId: preparedLaunch.childProcessInstanceId,
		childPid: child.pid,
		trigger,
		socketPath,
	});
	throw new Error(
		`Timed out waiting for daemon to start on ${socketPath}. ` +
			startupTraceDetails(trace, "spawn_timeout", "absent") +
			readDaemonLogTail(socketPath, logOffset),
	);
}

async function ensureDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	const startedAt = Date.now();
	const trace: DaemonStartupTrace = {
		id: randomUUID().slice(0, 8),
		startedAt,
		logOffset: currentDaemonLogSize(socketPath),
	};
	const deadline = startedAt + DAEMON_STARTUP_TIMEOUT_MS;
	let lastProbe = await probeDaemonVersion(socketPath);
	const clientRuntime = getDaemonRuntimeIdentity();
	logDaemonLaunch(
		`${startupTraceDetails(trace, "initial_probe", lastProbe.status)} clientVersion=${VERSION} ` +
			`clientBuild=${clientRuntime.buildId} ` +
			`clientExecutable=${JSON.stringify(clientRuntime.launcherPath ?? clientRuntime.entrypointPath ?? clientRuntime.executablePath)}`,
	);
	if (lastProbe.status === "current") {
		logDaemonLaunch(
			`${startupTraceDetails(trace, "ready", lastProbe.status)} daemonPid=${lastProbe.hello.supervisorPid ?? "unknown"} ` +
				`generation=${lastProbe.hello.supervisorGeneration ?? "unknown"} build=${lastProbe.hello.runtime?.buildId ?? "unknown"}`,
		);
		return;
	}
	let leaseWaitStartedAt: number | undefined;
	let lastLoggedProbeStatus: DaemonVersionProbe["status"] = lastProbe.status;

	while (Date.now() < deadline) {
		const lease = tryAcquireDaemonLaunchLease(socketPath);
		if (lease) {
			try {
				logDaemonLaunch(
					`${startupTraceDetails(trace, "launch_lease_acquired", lastProbe.status, leaseWaitStartedAt)}`,
				);
				return await ensureDaemonRunningAsLeader(socketPath, spawnCwd, deadline, trace);
			} finally {
				lease.release();
			}
		}
		if (leaseWaitStartedAt === undefined) {
			leaseWaitStartedAt = Date.now();
			logDaemonLaunch(startupTraceDetails(trace, "waiting_for_launch_lease", lastProbe.status, leaseWaitStartedAt));
		}
		await delay(250);
		lastProbe = await probeDaemonVersion(socketPath);
		if (lastProbe.status !== lastLoggedProbeStatus) {
			lastLoggedProbeStatus = lastProbe.status;
			logDaemonLaunch(startupTraceDetails(trace, "probe_transition", lastProbe.status, leaseWaitStartedAt));
		}
		if (lastProbe.status === "current") {
			logDaemonLaunch(
				`${startupTraceDetails(trace, "ready", lastProbe.status, leaseWaitStartedAt)} ` +
					`daemonPid=${lastProbe.hello.supervisorPid ?? "unknown"} ` +
					`generation=${lastProbe.hello.supervisorGeneration ?? "unknown"} ` +
					`build=${lastProbe.hello.runtime?.buildId ?? "unknown"}`,
			);
			return;
		}
	}

	if (lastProbe.status === "unresponsive") {
		throw new Error(
			`Timed out waiting for the running Prime Agent daemon on ${socketPath} to finish startup. ` +
				startupTraceDetails(trace, "follower_hello_timeout", lastProbe.status, leaseWaitStartedAt) +
				readDaemonLogTail(socketPath, trace.logOffset),
		);
	}
	if (lastProbe.status === "stale") {
		throw new StaleDaemonError(socketPath, lastProbe.hello);
	}
	throw new Error(
		`Timed out waiting for the elected Prime Agent daemon launcher on ${socketPath}. ` +
			startupTraceDetails(trace, "launch_lease_timeout", lastProbe.status, leaseWaitStartedAt) +
			readDaemonLogTail(socketPath, trace.logOffset),
	);
}

function currentDaemonLogSize(socketPath: string): number {
	try {
		return statSync(getDaemonLogPath(socketPath)).size;
	} catch {
		return 0;
	}
}

/** Reads only log content written after `offset`, so stale content from earlier daemon runs is not misattributed to this startup attempt. */
function readDaemonLogTail(socketPath: string, offset: number): string {
	const logPath = getDaemonLogPath(socketPath);
	let tail = "";
	try {
		const content = readFileSync(logPath);
		// A rotation may have shrunk the file below the pre-spawn byte offset.
		tail = content
			.subarray(content.length < offset ? 0 : offset)
			.subarray(-DAEMON_STARTUP_LOG_TAIL_BYTES)
			.toString("utf8")
			.trim();
	} catch {
		// Missing log means the daemon crashed before logging was set up.
	}
	return tail ? ` Recent daemon log (${logPath}):\n${tail}` : ` The daemon wrote nothing new to its log (${logPath}).`;
}

const ensurePromises = new Map<string, Promise<void>>();

/**
 * Ensure a current-version daemon is listening on socketPath, spawning one if
 * needed. Memoized per socket so the early kick from cli.ts and the await in
 * main.ts share one probe/spawn; failed attempts are forgotten so a later call
 * retries (and surfaces the real error at its await site).
 */
export function ensureInteractiveDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	let promise = ensurePromises.get(socketPath);
	if (!promise) {
		promise = ensureDaemonRunning(socketPath, spawnCwd);
		ensurePromises.set(socketPath, promise);
		const clear = () => {
			if (ensurePromises.get(socketPath) === promise) {
				ensurePromises.delete(socketPath);
			}
		};
		promise.then(clear, clear);
	}
	return promise;
}

const EARLY_LAUNCH_EXCLUDED_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const EARLY_LAUNCH_VALUE_FLAGS = new Set([
	"--mode",
	"--daemon-socket",
	"--provider",
	"--model",
	"--api-key",
	"--cwd",
	"--system-prompt",
	"--append-system-prompt",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
	"--goal",
	"--goal-token-budget",
]);

function findFirstEarlyLaunchPositional(args: readonly string[]): { index: number; value: string } | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			return args[index + 1] === undefined ? undefined : { index: index + 1, value: args[index + 1]! };
		}
		if (EARLY_LAUNCH_VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			if (args[index + 1] && !args[index + 1]!.startsWith("-")) {
				index++;
			}
			continue;
		}
		if (!arg.startsWith("-")) {
			return { index, value: arg };
		}
	}
	return undefined;
}

export function shouldStartDaemonEarly(args: readonly string[], startupBenchmark: boolean): boolean {
	if (startupBenchmark) {
		return false;
	}
	const modeIndex = args.indexOf("--mode");
	if (modeIndex !== -1 && args[modeIndex + 1] === "daemon") {
		return false;
	}
	if (args.some((arg) => EARLY_LAUNCH_EXCLUDED_FLAGS.has(arg))) {
		return false;
	}
	if (args.includes("--print") || args.includes("-p")) {
		return true;
	}
	const firstPositional = findFirstEarlyLaunchPositional(args);
	const isHelpCommand =
		firstPositional?.value === "help" && isHelpCommandRequest(args.slice(firstPositional.index + 1));
	if (
		firstPositional &&
		(REMOVED_COMMAND_NAMES.has(firstPositional.value) ||
			(PUBLIC_COMMAND_NAMES.has(firstPositional.value) &&
				firstPositional.value !== "agents" &&
				(firstPositional.value !== "help" || isHelpCommand)))
	) {
		return false;
	}
	return true;
}

export function maybeStartDaemonEarly(args: readonly string[]): void {
	const benchmarkFlag = (process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase();
	const startupBenchmark = benchmarkFlag === "1" || benchmarkFlag === "true" || benchmarkFlag === "yes";
	if (!shouldStartDaemonEarly(args, startupBenchmark)) {
		return;
	}
	const socketIndex = args.indexOf("--daemon-socket");
	const rawSocketPath =
		socketIndex !== -1 && args[socketIndex + 1] ? (args[socketIndex + 1] as string) : defaultDaemonSocketPath();
	const cwdIndex = args.indexOf("--cwd");
	const cwdArg = cwdIndex !== -1 ? args[cwdIndex + 1] : undefined;
	const spawnCwd = cwdArg ? resolve(expandTildePath(cwdArg)) : undefined;
	if (spawnCwd && !existsSync(spawnCwd)) {
		return;
	}
	const operationalSocketPath =
		process.platform === "win32"
			? normalizeSocketPath(rawSocketPath, spawnCwd)
			: resolve(spawnCwd ?? process.cwd(), expandTildePath(rawSocketPath));
	void ensureInteractiveDaemonRunning(operationalSocketPath, spawnCwd);
}
