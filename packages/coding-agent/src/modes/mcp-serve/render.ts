import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentTaskState } from "../../core/session-manager.js";
import { formatSessionDisplayId } from "../daemon/daemon-session-id.js";
import type { SessionLifecycle, SessionSummary } from "../daemon/daemon-session-list.js";

export type DerivedSessionState = "worker_failed" | "working" | "waiting_on_user" | "stalled" | "idle" | "inactive";

/** An idle session with no completion verdict is called stalled after this long. */
export const STALLED_AFTER_MS = 30 * 60 * 1000;

/** Needs-attention first: the order a fleet view should read in. */
const STATE_SEQUENCE: readonly DerivedSessionState[] = [
	"worker_failed",
	"waiting_on_user",
	"stalled",
	"working",
	"idle",
	"inactive",
];

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

export type FleetStateCounts = Record<DerivedSessionState, number>;

export interface FleetTotals {
	/** Rows the daemon returned, before any filtering. */
	sessions: number;
	/** RLM child rows removed by `include_children: false`. */
	hiddenChildren: number;
	/** Inactive rows available after child filtering. */
	inactive: number;
	/** Inactive rows kept after the saved-row cap. */
	inactiveShown: number;
	shown: number;
	suppressed: number;
}

export interface FleetSelection {
	rows: DerivedSession[];
	/** Per-state counts of every row the caller could have seen (after child filtering). */
	counts: FleetStateCounts;
	suppressedCounts: FleetStateCounts;
	totals: FleetTotals;
}

export interface FleetSelectionOptions {
	includeChildren: boolean;
	maxRows: number;
	maxInactiveRows: number;
}

export interface FleetStatus {
	host: string;
	daemon: DaemonStatusInfo;
	selection: FleetSelection;
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
	// An RLM child answers its parent and never owns a user-facing verdict, so a
	// long-idle child is parked rather than stalled.
	const isChild = (summary.rlmDepth ?? 0) > 0;
	if (!isChild && summary.taskState === undefined && idleMs !== undefined && idleMs > STALLED_AFTER_MS) {
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
			const stateDelta = stateRank(left.derived.state) - stateRank(right.derived.state);
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

/**
 * Apply the payload rules to an already-sorted fleet: drop RLM children unless
 * asked for, cap saved rows, then cap total rows. Child counts are taken from
 * the unfiltered rows so a parent still reports every child it owns.
 */
export function selectFleetRows(sessions: readonly DerivedSession[], options: FleetSelectionOptions): FleetSelection {
	const candidates = options.includeChildren
		? [...sessions]
		: sessions.filter((session) => (session.rlmDepth ?? 0) === 0);
	const hiddenChildren = sessions.length - candidates.length;

	const capped: DerivedSession[] = [];
	const dropped: DerivedSession[] = [];
	let inactive = 0;
	let inactiveShown = 0;
	for (const session of candidates) {
		if (session.state !== "inactive") {
			capped.push(session);
			continue;
		}
		inactive++;
		if (inactiveShown < options.maxInactiveRows) {
			inactiveShown++;
			capped.push(session);
		} else {
			dropped.push(session);
		}
	}

	const rows = capped.slice(0, Math.max(0, options.maxRows));
	return {
		rows,
		counts: countStates(candidates),
		suppressedCounts: countStates([...capped.slice(rows.length), ...dropped]),
		totals: {
			sessions: sessions.length,
			hiddenChildren,
			inactive,
			inactiveShown,
			shown: rows.length,
			suppressed: candidates.length - rows.length,
		},
	};
}

export function renderFleetStatus(status: FleetStatus): string {
	const { rows, suppressedCounts, totals } = status.selection;
	const lines = [renderFleetHeader(status)];
	if (rows.length === 0) {
		lines.push("No sessions.");
		return lines.join("\n");
	}
	for (const session of rows) {
		lines.push(renderSessionLine(session));
		const question = status.pendingQuestions.get(session.session);
		if (session.state === "waiting_on_user" && question) {
			lines.push(`${PENDING_QUESTION_PREFIX}${tail(question, PENDING_QUESTION_MAX_CHARS)}`);
		}
	}
	if (totals.suppressed > 0) {
		lines.push(`+${totals.suppressed} more: ${formatStateCounts(suppressedCounts) || "none"}`);
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
		session.childCount > 0 ? `${session.childCount} ${session.childCount === 1 ? "child" : "children"}` : undefined,
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
	const { counts, totals } = status.selection;
	const breakdown = formatStateCounts(counts);
	const scope = [
		totals.hiddenChildren > 0
			? `${totals.hiddenChildren} ${totals.hiddenChildren === 1 ? "child" : "children"} hidden`
			: undefined,
		totals.inactive > totals.inactiveShown ? `${totals.inactiveShown} of ${totals.inactive} saved shown` : undefined,
	].filter((part): part is string => part !== undefined);
	const daemon = [
		`daemon ${status.daemon.appVersion ?? "unknown"}`,
		`protocol ${status.daemon.protocolVersion}`,
		status.daemon.schemaId ? `schema ${status.daemon.schemaId}` : undefined,
		status.daemon.versionSkew,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	const scopeSuffix = scope.length > 0 ? ` · ${scope.join(" · ")}` : "";
	return `${status.host}: ${totals.shown} of ${totalCount(counts)} sessions (${breakdown || "none"})${scopeSuffix} · ${daemon}`;
}

function stateRank(state: DerivedSessionState): number {
	return STATE_SEQUENCE.indexOf(state);
}

function totalCount(counts: FleetStateCounts): number {
	return STATE_SEQUENCE.reduce((sum, state) => sum + counts[state], 0);
}

function countStates(sessions: readonly DerivedSession[]): FleetStateCounts {
	const counts: FleetStateCounts = {
		worker_failed: 0,
		waiting_on_user: 0,
		stalled: 0,
		working: 0,
		idle: 0,
		inactive: 0,
	};
	for (const session of sessions) {
		counts[session.state]++;
	}
	return counts;
}

function formatStateCounts(counts: FleetStateCounts): string {
	return STATE_SEQUENCE.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`)
		.join(", ");
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

/** Length-bounded but newline-preserving, for multi-line blocks. */
export function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

export function tail(text: string, maxChars: number): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	return collapsed.length <= maxChars ? collapsed : `\u2026${collapsed.slice(-(maxChars - 1))}`;
}

export interface TranscriptWindow {
	text: string;
	firstIndex: number;
	lastIndex: number;
	total: number;
	/** Pass as `before` to page one window further back; absent at the start of the transcript. */
	nextBefore?: number;
}

export const TRANSCRIPT_DEFAULT_MAX_CHARS = 4000;
export const TRANSCRIPT_MAX_CHARS_LIMIT = 20_000;

const TOOL_CALL_ARGUMENTS_MAX_CHARS = 120;
/** One message may spend at most this share of a page, so a page always shows several. */
const TRANSCRIPT_MESSAGE_SHARE = 0.25;
const TRANSCRIPT_MESSAGE_MIN_CHARS = 300;

/** Compact one-message rendering; covers every role the coding agent can persist. */
export function renderMessage(message: AgentMessage, maxChars: number): string {
	return renderMessageEntry(message, maxChars).text;
}

function renderMessageEntry(message: AgentMessage, maxChars: number): { text: string; truncated: boolean } {
	const full = renderMessageText(message);
	return full.length <= maxChars
		? { text: full, truncated: false }
		: { text: `${full.slice(0, Math.max(0, maxChars - 1))}\u2026`, truncated: true };
}

function renderMessageText(message: AgentMessage): string {
	const maxChars = Number.MAX_SAFE_INTEGER;
	switch (message.role) {
		case "user":
			return `[user] ${clip(contentText(message.content), maxChars)}`;
		case "assistant": {
			const text = clip(contentText(message.content), maxChars);
			const calls = message.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map((block) => `\n  -> ${formatToolCall(block)}`)
				.join("");
			return `[assistant] ${text}${calls}`;
		}
		case "toolResult":
			return `[toolResult:${message.toolName}${message.isError ? " error" : ""}] ${clip(contentText(message.content), maxChars)}`;
		case "bashExecution":
			return `[bash] ${clip([message.command, message.output].filter(Boolean).join(" -> "), maxChars)}`;
		case "custom":
			return `[custom:${message.customType}] ${clip(contentText(message.content), maxChars)}`;
		case "branchSummary":
			return `[branchSummary] ${clip(message.summary, maxChars)}`;
		case "compactionSummary":
			return `[compactionSummary] ${clip(message.summary, maxChars)}`;
		default: {
			const exhaustive: never = message;
			return `[unknown] ${clip(JSON.stringify(exhaustive), maxChars)}`;
		}
	}
}

/**
 * Newest-last window ending just before `before` (default: the end of the
 * transcript), grown backwards until the character budget is spent.
 */
export function renderTranscript(
	messages: readonly AgentMessage[],
	options: { maxChars?: number; before?: number } = {},
): TranscriptWindow {
	const maxChars = options.maxChars ?? TRANSCRIPT_DEFAULT_MAX_CHARS;
	const total = messages.length;
	const end = Math.min(options.before ?? total, total);
	if (total === 0 || end <= 0) {
		return { text: "[no messages]", firstIndex: 0, lastIndex: 0, total };
	}

	const messageMaxChars = Math.max(TRANSCRIPT_MESSAGE_MIN_CHARS, Math.floor(maxChars * TRANSCRIPT_MESSAGE_SHARE));
	const rendered: string[] = [];
	let used = 0;
	let firstIndex = end - 1;
	for (let index = end - 1; index >= 0; index--) {
		const entry = renderMessageEntry(messages[index]!, messageMaxChars);
		const marker = entry.truncated
			? ` [message truncated - fetch alone with before=${index + 1}, max_chars=${TRANSCRIPT_MAX_CHARS_LIMIT}]`
			: "";
		const line = `#${index} ${entry.text}${marker}`;
		if (rendered.length > 0 && used + line.length > maxChars) {
			break;
		}
		rendered.push(line);
		used += line.length + 1;
		firstIndex = index;
	}
	rendered.reverse();

	const lastIndex = end - 1;
	const lines =
		firstIndex > 0 || lastIndex < total - 1
			? [`[truncated: showing messages ${firstIndex}-${lastIndex} of ${total}]`, ...rendered]
			: rendered;
	return {
		text: lines.join("\n"),
		firstIndex,
		lastIndex,
		total,
		...(firstIndex > 0 ? { nextBefore: firstIndex } : {}),
	};
}

type MessageContent = string | readonly (TextContent | ThinkingContent | ImageContent | ToolCall)[];

function contentText(content: MessageContent): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.thinking;
				case "image":
					return "[image]";
				case "toolCall":
					return `[tool_call:${block.name}]`;
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join("\n");
}

function formatToolCall(call: ToolCall): string {
	// `ipython` remains the external tool name after the CPython cutover. Show the
	// cell itself instead of wrapping it in JSON so remote transcripts match the
	// model-facing Python REPL surface without leaking an internal runtime name.
	const argumentsText =
		call.name === "ipython" && typeof call.arguments.code === "string"
			? call.arguments.code
			: formatToolArguments(call.arguments);
	return `${call.name}(${clip(argumentsText, TOOL_CALL_ARGUMENTS_MAX_CHARS)})`;
}

function formatToolArguments(args: Record<string, unknown>): string {
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return "[unserializable]";
	}
}
