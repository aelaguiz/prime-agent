import { closeSync, readFileSync } from "node:fs";
import type { AgentSessionMessageDeliveryMode, AgentSessionMessageSender } from "../../core/agent-messages.js";
import type { IdleEvictionMinutes } from "../../core/session-action-store.js";
import {
	isExactProcessStartId,
	normalizePortableProcessIdentityHint,
	normalizeRetainedLegacyProcessStartId,
	projectLegacyProcessStartId,
} from "../../core/session-lease.js";

export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";

import type { WorkerRosterEntry } from "./agent-roster.js";
import type { DaemonClientCapability, DaemonCommand, DaemonOutbound } from "./daemon-protocol.js";

export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_INSTANCE_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
export type DaemonWorkerLifecycle = "starting" | "ready" | "recovering" | "stopping" | "failed";
export type DaemonWorkerCleanupState = "cleanup-proven" | "journal-cleared";

/** Durable crash-recovery proof for one immutable worker cleanup authority. */
export interface DaemonWorkerCleanupProof {
	version: 1;
	state: DaemonWorkerCleanupState;
	token: string;
	authorityFingerprint: string;
	provenAt: string;
}

// Worker->supervisor roster frames live outside the client-facing DaemonOutbound schema.
export type DaemonWorkerRosterOutbound =
	| {
			type: "roster_delta";
			entries: WorkerRosterEntry[];
			removedAgentIds?: string[];
			snapshot?: true;
	  }
	| { type: "roster_heartbeat" };

/** Advertised by new workers in the worker_auth response; absent on legacy workers. */
export const DAEMON_WORKER_ROSTER_CAPABILITY = "agent_roster";

/** Advertised in the worker_auth response by workers that accept peer transport grants. */
export const DAEMON_WORKER_PEER_TRANSPORT_CAPABILITY = "peer_transport";

/** Idle keepalive cadence for worker->supervisor roster frames; the supervisor staleness threshold derives from it. */
export const ROSTER_HEARTBEAT_INTERVAL_MS = 15_000;

export type DaemonWorkerFrameHeader =
	| {
			kind: "command";
			requestId: string;
			commandType: string;
	  }
	| {
			kind: "outbound";
			requestId?: string;
			outboundType: DaemonOutbound["type"] | DaemonWorkerRosterOutbound["type"];
			activeSessionId?: string;
			snapshotId?: string;
			sessionEventType?: string;
			payloadEncoding?: "jsonl" | "assistant-delta";
			snapshotPurpose?: "attach" | "replacement" | "catchup";
	  };

export type DaemonCreateCommand = Extract<DaemonCommand, { type: "create" }>;

export interface DurableDaemonCreateCommand {
	type: "create";
	sessionPath?: string;
	noSession?: boolean;
}

export function durableDaemonCreateCommand(command: DaemonCreateCommand): DurableDaemonCreateCommand {
	return {
		type: "create",
		...(command.sessionPath !== undefined ? { sessionPath: command.sessionPath } : {}),
		...(command.noSession !== undefined ? { noSession: command.noSession } : {}),
	};
}

/**
 * A single-use, worker-memory-only admission for one direct peer, scoped to one active-session
 * slot (stable across switch_session/new_session/fork) of one worker incarnation. The session pin
 * is a routing/accident guard, not a privilege boundary: ticket holders already hold supervisor
 * access, which can attach to, switch, or kill any session.
 */
export interface DaemonWorkerPeerGrant {
	grantId: string;
	token: string;
	expiresAt: string;
	purpose: "session_client";
	workerInstanceId: string;
	activeSessionId: string;
	issuerGeneration: string;
}

/** Commands a direct peer may send before it holds an authenticated session role. */
export type DaemonPeerCommand = {
	id?: string;
	type: "peer_auth";
	grantId: string;
	token: string;
	workerInstanceId: string;
	purpose: "session_client";
};

export type DaemonPeerCommandBody = Omit<DaemonPeerCommand, "id">;

export type DaemonWorkerCommand =
	| {
			id?: string;
			type: "worker_auth";
			token: string;
			workerInstanceId?: string;
			supervisorGeneration: string;
			supervisorPid: number;
			/** Legacy pre-move projection; never new exact signal authority. */
			supervisorProcessStartId?: string;
			supervisorAuthorityProcessStartId?: string;
			supervisorSocketPath: string;
	  }
	| {
			id?: string;
			type: "worker_subscribe";
			activeSessionId: string;
			capabilities?: readonly DaemonClientCapability[];
			supportsExtensionUi?: boolean;
	  }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| { id?: string; type: "worker_register_peer_transport"; grant: DaemonWorkerPeerGrant }
	| { id?: string; type: "worker_archive_and_shutdown" }
	| {
			id?: string;
			type: "worker_passivate_idle_children";
			idleEvictionMinutes: IdleEvictionMinutes;
			now: number;
			limit: number;
	  }
	| {
			id?: string;
			type: "worker_deliver_message";
			targetActiveSessionId: string;
			message: string;
			sender: AgentSessionMessageSender;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "worker_prepare_update" }
	| { id?: string; type: "worker_commit_update" }
	| { id?: string; type: "worker_cancel_update" };

export type DaemonWorkerCommandBody = DaemonWorkerCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export interface DaemonWorkerDescriptor {
	version: 1 | 2;
	workerId: string;
	pid: number;
	/** Legacy pre-move projection; retained for mixed-version readers only. */
	processStartId?: string;
	/** Legacy diagnostic hint; never process identity authority. */
	processIdentityHint?: string;
	/** Exact new-reader process identity used for authority and signalling. */
	authorityProcessStartId?: string;
	/** New-reader diagnostic hint used only when exact identity was unavailable. */
	authorityProcessIdentityHint?: string;
	socketPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath?: string;
	orphanProcessJournalGeneration?: string;
	supervisorSocketPath: string;
	authenticationToken: string;
	workerInstanceId?: string;
	rootActiveSessionId: string;
	/** Stable protocol client that owns this worker. Omitted for resident sessions. */
	ownerClientId?: string;
	rootSessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	telemetryDisabled?: true;
	createdAt: string;
	updatedAt: string;
	lifecycle: DaemonWorkerLifecycle;
	createCommand: DurableDaemonCreateCommand;
	consecutiveFailures: number;
	/** Durable intent written before root termination so replacement supervisors never recover it. */
	stopRequestedAt?: string;
	/** Complete the root's archived lifecycle state after its process has stopped. */
	archiveOnStop?: boolean;
	/** Optional internal cleanup proof. This is not part of daemon wire protocol v7. */
	cleanup?: DaemonWorkerCleanupProof;
	lastFailureAt?: string;
	lastError?: string;
}

const DAEMON_WORKER_CLEANUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DAEMON_WORKER_AUTHORITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DAEMON_WORKER_LIFECYCLES: ReadonlySet<DaemonWorkerLifecycle> = new Set([
	"starting",
	"ready",
	"recovering",
	"stopping",
	"failed",
]);

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidTimestamp(value: unknown): value is string {
	return isNonemptyString(value) && Number.isFinite(Date.parse(value));
}

export function isDaemonWorkerCleanupProof(value: unknown): value is DaemonWorkerCleanupProof {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const cleanup = value as Partial<DaemonWorkerCleanupProof>;
	return (
		cleanup.version === 1 &&
		(cleanup.state === "cleanup-proven" || cleanup.state === "journal-cleared") &&
		typeof cleanup.token === "string" &&
		DAEMON_WORKER_CLEANUP_TOKEN_PATTERN.test(cleanup.token) &&
		typeof cleanup.authorityFingerprint === "string" &&
		DAEMON_WORKER_AUTHORITY_FINGERPRINT_PATTERN.test(cleanup.authorityFingerprint) &&
		isValidTimestamp(cleanup.provenAt) &&
		Object.keys(cleanup).length === 5 &&
		Object.keys(cleanup).every((key) =>
			["version", "state", "token", "authorityFingerprint", "provenAt"].includes(key),
		)
	);
}

/** Prefer exact new-reader authority; legacy projection is retention-only fallback. */
export function daemonWorkerProcessAuthority(descriptor: Readonly<DaemonWorkerDescriptor>): string | undefined {
	// New writes use the authority namespace. Exact values written by the prior
	// schema (notably win:/token: and interim qualified Linux IDs) remain valid;
	// bare proc:/ps: projections reduce to retained and can never authorize signal.
	return descriptor.authorityProcessStartId ?? descriptor.processStartId;
}

function isLegacyProcessIdentityProjection(value: string): boolean {
	return isExactProcessStartId(value) || normalizeRetainedLegacyProcessStartId(value) === value;
}

export function daemonSignalSafeLegacyProcessStartId(
	exact: string | undefined,
	legacy: string | undefined,
): string | undefined {
	return exact?.startsWith("win:") && (legacy === undefined || legacy === exact) ? exact : undefined;
}

export function hasConsistentDaemonProcessIdentityProjection(
	legacy: string | undefined,
	exact: string | undefined,
): boolean {
	if (exact === undefined) {
		return legacy === undefined || isExactProcessStartId(legacy) || isLegacyProcessIdentityProjection(legacy);
	}
	if (!isExactProcessStartId(exact)) return false;
	if (legacy === undefined) return true;
	const projected = projectLegacyProcessStartId(exact);
	return projected !== undefined && legacy === projected;
}

function hasConsistentDaemonWorkerIdentityNamespaces(descriptor: Partial<DaemonWorkerDescriptor>): boolean {
	const legacyStart = descriptor.processStartId;
	const legacyHint = descriptor.processIdentityHint;
	const authorityStart = descriptor.authorityProcessStartId;
	const authorityHint = descriptor.authorityProcessIdentityHint;
	if (legacyStart !== undefined && legacyHint !== undefined) return false;
	if (authorityStart !== undefined && authorityHint !== undefined) return false;
	if (legacyHint !== undefined && normalizePortableProcessIdentityHint(legacyHint) !== legacyHint) return false;
	if (authorityStart !== undefined && legacyHint !== undefined) return false;
	if (authorityHint !== undefined) {
		if (normalizePortableProcessIdentityHint(authorityHint) !== authorityHint || legacyStart !== undefined)
			return false;
		if (legacyHint !== undefined && legacyHint !== authorityHint) return false;
	}
	return true;
}

/** Shared structural validator. Cleanup callers add canonical-layout and inode checks. */
export function isDaemonWorkerDescriptor(value: unknown): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	const createCommand = descriptor.createCommand as Partial<DurableDaemonCreateCommand> | undefined;
	return (
		(descriptor.version === 1 || descriptor.version === 2) &&
		isNonemptyString(descriptor.workerId) &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || isNonemptyString(descriptor.processStartId)) &&
		(descriptor.processIdentityHint === undefined || isNonemptyString(descriptor.processIdentityHint)) &&
		(descriptor.authorityProcessStartId === undefined || isNonemptyString(descriptor.authorityProcessStartId)) &&
		(descriptor.authorityProcessIdentityHint === undefined ||
			isNonemptyString(descriptor.authorityProcessIdentityHint)) &&
		hasConsistentDaemonWorkerIdentityNamespaces(descriptor) &&
		hasConsistentDaemonProcessIdentityProjection(descriptor.processStartId, descriptor.authorityProcessStartId) &&
		isNonemptyString(descriptor.socketPath) &&
		isNonemptyString(descriptor.recoveryJournalPath) &&
		(descriptor.orphanProcessJournalPath === undefined || isNonemptyString(descriptor.orphanProcessJournalPath)) &&
		(descriptor.orphanProcessJournalGeneration === undefined ||
			isNonemptyString(descriptor.orphanProcessJournalGeneration)) &&
		isNonemptyString(descriptor.supervisorSocketPath) &&
		isNonemptyString(descriptor.authenticationToken) &&
		isNonemptyString(descriptor.rootActiveSessionId) &&
		(descriptor.ownerClientId === undefined || isNonemptyString(descriptor.ownerClientId)) &&
		(descriptor.rootSessionId === undefined || isNonemptyString(descriptor.rootSessionId)) &&
		(descriptor.sessionFile === undefined || isNonemptyString(descriptor.sessionFile)) &&
		(descriptor.sessionDir === undefined || isNonemptyString(descriptor.sessionDir)) &&
		(descriptor.telemetryDisabled === undefined || descriptor.telemetryDisabled === true) &&
		isValidTimestamp(descriptor.createdAt) &&
		isValidTimestamp(descriptor.updatedAt) &&
		typeof descriptor.lifecycle === "string" &&
		DAEMON_WORKER_LIFECYCLES.has(descriptor.lifecycle as DaemonWorkerLifecycle) &&
		createCommand !== undefined &&
		createCommand.type === "create" &&
		(createCommand.sessionPath === undefined || isNonemptyString(createCommand.sessionPath)) &&
		(createCommand.noSession === undefined || typeof createCommand.noSession === "boolean") &&
		Number.isInteger(descriptor.consecutiveFailures) &&
		(descriptor.consecutiveFailures ?? -1) >= 0 &&
		(descriptor.stopRequestedAt === undefined || isValidTimestamp(descriptor.stopRequestedAt)) &&
		(descriptor.archiveOnStop === undefined || typeof descriptor.archiveOnStop === "boolean") &&
		(descriptor.cleanup === undefined || isDaemonWorkerCleanupProof(descriptor.cleanup)) &&
		(descriptor.lastFailureAt === undefined || isValidTimestamp(descriptor.lastFailureAt)) &&
		(descriptor.lastError === undefined || typeof descriptor.lastError === "string")
	);
}

/** Parses durable descriptor authority while treating malformed optional cleanup proof as absent. */
export function parseDaemonWorkerDescriptor(value: unknown): DaemonWorkerDescriptor | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = { ...(value as Record<string, unknown>) };
	if (
		candidate.authorityProcessStartId === undefined &&
		typeof candidate.processStartId === "string" &&
		isExactProcessStartId(candidate.processStartId) &&
		!candidate.processStartId.startsWith("win:")
	) {
		const exact = candidate.processStartId;
		candidate.authorityProcessStartId = exact;
		const legacy = projectLegacyProcessStartId(exact);
		if (legacy === undefined) delete candidate.processStartId;
		else candidate.processStartId = legacy;
	}
	if (candidate.cleanup !== undefined && !isDaemonWorkerCleanupProof(candidate.cleanup)) {
		delete candidate.cleanup;
	}
	return isDaemonWorkerDescriptor(candidate) ? candidate : undefined;
}

export function durableDaemonWorkerDescriptor(descriptor: DaemonWorkerDescriptor): DaemonWorkerDescriptor {
	const versionOneCreateCommand = descriptor.createCommand as unknown as { config?: unknown };
	const versionOneConfig =
		descriptor.version === 1 &&
		typeof versionOneCreateCommand.config === "object" &&
		versionOneCreateCommand.config !== null
			? (versionOneCreateCommand.config as Record<string, unknown>)
			: undefined;
	const sessionDir =
		descriptor.sessionDir ??
		(typeof versionOneConfig?.sessionDir === "string" ? versionOneConfig.sessionDir : undefined);
	const telemetryDisabled = descriptor.telemetryDisabled === true || versionOneConfig?.telemetryDisabled === true;
	const legacyProcessStartId = descriptor.authorityProcessStartId
		? daemonSignalSafeLegacyProcessStartId(descriptor.authorityProcessStartId, descriptor.processStartId)
		: descriptor.processStartId;
	return {
		version: 2,
		workerId: descriptor.workerId,
		pid: descriptor.pid,
		...(legacyProcessStartId !== undefined ? { processStartId: legacyProcessStartId } : {}),
		...(descriptor.processIdentityHint !== undefined ? { processIdentityHint: descriptor.processIdentityHint } : {}),
		...(descriptor.authorityProcessStartId !== undefined
			? { authorityProcessStartId: descriptor.authorityProcessStartId }
			: {}),
		...(descriptor.authorityProcessIdentityHint !== undefined
			? { authorityProcessIdentityHint: descriptor.authorityProcessIdentityHint }
			: {}),
		socketPath: descriptor.socketPath,
		recoveryJournalPath: descriptor.recoveryJournalPath,
		...(descriptor.orphanProcessJournalPath !== undefined
			? { orphanProcessJournalPath: descriptor.orphanProcessJournalPath }
			: {}),
		...(descriptor.orphanProcessJournalGeneration !== undefined
			? { orphanProcessJournalGeneration: descriptor.orphanProcessJournalGeneration }
			: {}),
		supervisorSocketPath: descriptor.supervisorSocketPath,
		authenticationToken: descriptor.authenticationToken,
		...(descriptor.workerInstanceId !== undefined ? { workerInstanceId: descriptor.workerInstanceId } : {}),
		rootActiveSessionId: descriptor.rootActiveSessionId,
		...(descriptor.ownerClientId !== undefined ? { ownerClientId: descriptor.ownerClientId } : {}),
		...(descriptor.rootSessionId !== undefined ? { rootSessionId: descriptor.rootSessionId } : {}),
		...(descriptor.sessionFile !== undefined ? { sessionFile: descriptor.sessionFile } : {}),
		...(sessionDir !== undefined ? { sessionDir } : {}),
		...(telemetryDisabled ? { telemetryDisabled: true as const } : {}),
		createdAt: descriptor.createdAt,
		updatedAt: descriptor.updatedAt,
		lifecycle: descriptor.lifecycle,
		createCommand: durableDaemonCreateCommand(descriptor.createCommand),
		consecutiveFailures: descriptor.consecutiveFailures,
		...(descriptor.stopRequestedAt !== undefined ? { stopRequestedAt: descriptor.stopRequestedAt } : {}),
		...(descriptor.archiveOnStop !== undefined ? { archiveOnStop: descriptor.archiveOnStop } : {}),
		...(isDaemonWorkerCleanupProof(descriptor.cleanup)
			? {
					cleanup: {
						version: descriptor.cleanup.version,
						state: descriptor.cleanup.state,
						token: descriptor.cleanup.token,
						authorityFingerprint: descriptor.cleanup.authorityFingerprint,
						provenAt: descriptor.cleanup.provenAt,
					},
				}
			: {}),
		...(descriptor.lastFailureAt !== undefined ? { lastFailureAt: descriptor.lastFailureAt } : {}),
		...(descriptor.lifecycle === "failed" ? { lastError: "Waiting for a client with fresh runtime context" } : {}),
	};
}

export function isDaemonWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}

export function waitForDaemonWorkerStartupGate(environment: NodeJS.ProcessEnv = process.env): void {
	const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	if (rawFd === undefined) {
		return;
	}
	delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	const fd = Number(rawFd);
	if (!Number.isInteger(fd) || fd < 3) {
		throw new Error("Daemon session worker has an invalid startup gate");
	}
	let marker: string;
	try {
		marker = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (marker !== DAEMON_WORKER_STARTUP_GATE_COMMIT) {
		throw new Error("Daemon session worker startup was cancelled");
	}
}

export function daemonWorkerInstanceId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	return environment[DAEMON_WORKER_INSTANCE_ID_ENV] || undefined;
}

export function requireDaemonWorkerAuthenticationToken(environment: NodeJS.ProcessEnv = process.env): string {
	const token = environment[DAEMON_WORKER_TOKEN_ENV];
	if (!token) {
		throw new Error("Daemon session worker is missing its authentication token");
	}
	return token;
}

export function isDaemonWorkerFrameHeader(value: unknown): value is DaemonWorkerFrameHeader {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "command") {
		return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
	}
	return (
		candidate.kind === "outbound" &&
		typeof candidate.outboundType === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
		(candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
		(candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
		(candidate.snapshotPurpose === undefined ||
			candidate.snapshotPurpose === "attach" ||
			candidate.snapshotPurpose === "replacement" ||
			candidate.snapshotPurpose === "catchup") &&
		(candidate.payloadEncoding === undefined ||
			candidate.payloadEncoding === "jsonl" ||
			candidate.payloadEncoding === "assistant-delta")
	);
}
