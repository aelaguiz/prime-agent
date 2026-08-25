import { basename } from "node:path";
import type { AgentTaskState } from "../../core/session-manager.js";
import { formatSessionDisplayId } from "../daemon/daemon-session-id.js";
import type { SessionLifecycle, SessionSummary } from "../daemon/daemon-session-list.js";

export type DerivedSessionState = "worker_failed" | "working" | "waiting_on_user" | "stalled" | "idle" | "inactive";

/** An idle session with no completion verdict is called stalled after this long. */
export const STALLED_AFTER_MS = 30 * 60 * 1000;

const STATE_ORDER: Record<DerivedSessionState, number> = {
	worker_failed: 0,
	waiting_on_user: 1,
	stalled: 2,
	working: 3,
	idle: 4,
	inactive: 5,
};

const STATUS_LINE_MAX_CHARS = 200;
const RECAP_MAX_CHARS = 90;
const PENDING_QUESTION_PREFIX = "    Q: ";
const PENDING_QUESTION_MAX_CHARS = STATUS_LINE_MAX_CHARS - PENDING_QUESTION_PREFIX.length;

/**
 * A session summary plus a derived verdict and the raw evidence behind it. The
 * agent's own recap is kept separate because it is self-reported and can lag or
 * lie; the observable fields are what a state verdict is built from.
 */
export interface DerivedSession {
	state: DerivedSessionState;
	/** Selector to pass back into the other tools. */
	session: string;
	displayId: string;
	activeSessionId?: string;
	sessionId: string;
	name?: string;
	cwd: string;
	model?: string;
	lifecycle: SessionLifecycle;
	minutesSinceActivity?: number;
	lastActivityAt?: string;
	workerState?: SessionSummary["workerState"];
	attachedClients: number;
	messageCount: number;
	isStreaming: boolean;
	isRunningTools: boolean;
	isBashRunning: boolean;
	hasRunningRlmChildren: boolean;
	hasActiveHeartbeat: boolean;
	childCount: number;
	rlmDepth?: number;
	parentActiveSessionId?: string;
	recap: { summary?: string; taskState?: AgentTaskState };
}

export interface DaemonStatusInfo {
	socketPath: string;
	appVersion?: string;
	protocolVersion: number;
	schemaId?: string;
	/** Set when the daemon runs a different build than this process. */
	versionSkew?: string;
}

export interface FleetStatus {
	host: string;
	daemon: DaemonStatusInfo;
	sessions: DerivedSession[];
	/** Last assistant text per `DerivedSession.session`, for sessions waiting on a user. */
	pendingQuestions: ReadonlyMap<string, string>;
}

export function deriveSessionState(summary: SessionSummary, now: number): DerivedSessionState {
	// Only rows backed by a live session worker carry workerState (the supervisor
	// stamps it on every summary it publishes), so its absence marks a saved-only
	// row. An RLM child session is live but has no activeSessionId of its own, so
	// that field cannot stand in for liveness here.
	if (summary.lifecycle !== "live" || summary.workerState === undefined) {
		return "inactive";
	}
	if (summary.workerState === "failed" || summary.workerState === "recovering") {
		return "worker_failed";
	}
	if (
		summary.activity === "working" ||
		summary.isStreaming ||
		summary.isRunningTools === true ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true
	) {
		return "working";
	}
	if (summary.taskState === "needs_input") {
		return "waiting_on_user";
	}
	const idleMs = millisecondsSince(summary.lastActivityAt, now);
	if (summary.taskState === undefined && idleMs !== undefined && idleMs > STALLED_AFTER_MS) {
		return "stalled";
	}
	return "idle";
}

export function deriveSession(summary: SessionSummary, now: number, childCount: number): DerivedSession {
	const idleMs = millisecondsSince(summary.lastActivityAt, now);
	return {
		state: deriveSessionState(summary, now),
		session: sessionSelector(summary),
		displayId: formatSessionDisplayId(summary.id),
		...(summary.activeSessionId ? { activeSessionId: summary.activeSessionId } : {}),
		sessionId: summary.sessionId,
		...(summary.sessionName ? { name: summary.sessionName } : {}),
		cwd: summary.cwd,
		...(summary.model ? { model: `${summary.model.provider}/${summary.model.id}` } : {}),
		lifecycle: summary.lifecycle,
		...(idleMs === undefined ? {} : { minutesSinceActivity: Math.floor(idleMs / 60_000) }),
		...(summary.lastActivityAt ? { lastActivityAt: summary.lastActivityAt } : {}),
		...(summary.workerState ? { workerState: summary.workerState } : {}),
		attachedClients: summary.attachedClients,
		messageCount: summary.messageCount,
		isStreaming: summary.isStreaming,
		isRunningTools: summary.isRunningTools === true,
		isBashRunning: summary.isBashRunning === true,
		hasRunningRlmChildren: summary.hasRunningRlmChildren === true,
		hasActiveHeartbeat: summary.hasActiveHeartbeat === true,
		childCount,
		...(summary.rlmDepth === undefined ? {} : { rlmDepth: summary.rlmDepth }),
		...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
		recap: {
			...(summary.summary ? { summary: summary.summary } : {}),
			...(summary.taskState ? { taskState: summary.taskState } : {}),
		},
	};
}

/** Derive every row, count RLM children from parent linkage, and sort needs-attention first. */
export function deriveFleet(sessions: readonly SessionSummary[], now: number): DerivedSession[] {
	const childCounts = new Map<string, number>();
	for (const summary of sessions) {
		const parent = summary.parentActiveSessionId;
		if (parent) {
			childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
		}
	}
	return sessions
		.map((summary, index) => ({
			derived: deriveSession(summary, now, childCounts.get(sessionSelector(summary)) ?? 0),
			index,
		}))
		.sort((left, right) => {
			const stateDelta = STATE_ORDER[left.derived.state] - STATE_ORDER[right.derived.state];
			if (stateDelta !== 0) {
				return stateDelta;
			}
			const idleDelta =
				(left.derived.minutesSinceActivity ?? Number.MAX_SAFE_INTEGER) -
				(right.derived.minutesSinceActivity ?? Number.MAX_SAFE_INTEGER);
			return idleDelta || left.index - right.index;
		})
		.map(({ derived }) => derived);
}

export function renderFleetStatus(status: FleetStatus): string {
	const lines = [renderFleetHeader(status)];
	if (status.sessions.length === 0) {
		lines.push("No sessions.");
		return lines.join("\n");
	}
	for (const session of status.sessions) {
		lines.push(renderSessionLine(session));
		const question = status.pendingQuestions.get(session.session);
		if (session.state === "waiting_on_user" && question) {
			lines.push(`${PENDING_QUESTION_PREFIX}${tail(question, PENDING_QUESTION_MAX_CHARS)}`);
		}
	}
	return lines.join("\n");
}

export function renderSessionLine(session: DerivedSession): string {
	const parts = [session.name ?? session.displayId, `(${basename(session.cwd) || session.cwd})`];
	if (session.name) {
		parts.push(session.displayId);
	}
	if (session.model) {
		parts.push(session.model);
	}
	const facts = [
		formatAge(session.minutesSinceActivity),
		session.childCount > 0 ? `${session.childCount} children` : undefined,
		session.hasActiveHeartbeat ? "heartbeat" : undefined,
		session.attachedClients > 0 ? `${session.attachedClients} attached` : undefined,
		session.isStreaming ? "streaming" : undefined,
		session.isRunningTools ? "tools" : undefined,
		session.isBashRunning ? "bash" : undefined,
		session.workerState && session.workerState !== "ready" ? `worker ${session.workerState}` : undefined,
		session.recap.summary ? `"${clip(session.recap.summary, RECAP_MAX_CHARS)}"` : undefined,
	].filter((fact): fact is string => fact !== undefined);
	return clip(`[${session.state}] ${[...parts, ...facts].join(" · ")}`, STATUS_LINE_MAX_CHARS);
}

function renderFleetHeader(status: FleetStatus): string {
	const counts = new Map<DerivedSessionState, number>();
	for (const session of status.sessions) {
		counts.set(session.state, (counts.get(session.state) ?? 0) + 1);
	}
	const breakdown = [...counts.entries()]
		.sort((left, right) => STATE_ORDER[left[0]] - STATE_ORDER[right[0]])
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	const daemon = [
		`daemon ${status.daemon.appVersion ?? "unknown"}`,
		`protocol ${status.daemon.protocolVersion}`,
		status.daemon.schemaId ? `schema ${status.daemon.schemaId}` : undefined,
		status.daemon.versionSkew,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	return `${status.host}: ${status.sessions.length} sessions (${breakdown || "none"}) · ${daemon}`;
}

function formatAge(minutes: number | undefined): string | undefined {
	if (minutes === undefined) {
		return undefined;
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** The daemon resolves a session by its activeSessionId, falling back to the summary id. */
export function sessionSelector(summary: SessionSummary): string {
	return summary.activeSessionId ?? summary.id;
}

function millisecondsSince(timestamp: string | undefined, now: number): number | undefined {
	if (!timestamp) {
		return undefined;
	}
	const parsed = new Date(timestamp).getTime();
	return Number.isNaN(parsed) ? undefined : Math.max(0, now - parsed);
}

export function clip(text: string, maxChars: number): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

export function tail(text: string, maxChars: number): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	return collapsed.length <= maxChars ? collapsed : `\u2026${collapsed.slice(-(maxChars - 1))}`;
}
