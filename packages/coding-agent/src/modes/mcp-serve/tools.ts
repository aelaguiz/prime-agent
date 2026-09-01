import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isDaemonSessionSummary } from "../../cli/daemon-launch.js";
import { VERSION } from "../../config.js";
import { formatAgentCronJob } from "../../core/cron-jobs.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { AgentConnectionHeartbeat, AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import { matchesSessionIdSuffix } from "../daemon/daemon-session-id.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import {
	DAEMON_CATALOG_TIMEOUT_MS,
	DAEMON_CREATE_TIMEOUT_MS,
	DAEMON_GET_TIMEOUT_MS,
	type DaemonBridge,
	type DaemonCommandBody,
	DaemonCommandError,
} from "./daemon-bridge.js";
import {
	clip,
	type DaemonStatusInfo,
	type DerivedSession,
	deriveFleet,
	deriveSession,
	renderFleetStatus,
	renderSessionLine,
	renderTranscript,
	selectFleetRows,
	sessionSelector,
	TRANSCRIPT_DEFAULT_MAX_CHARS,
	TRANSCRIPT_MAX_CHARS_LIMIT,
	truncate,
} from "./render.js";

const PENDING_QUESTION_TIMEOUT_MS = 5_000;
const STATUS_DEFAULT_MAX_ROWS = 30;
const STATUS_MAX_SAVED_ROWS = 20;
const DETAIL_QUESTION_MAX_CHARS = 2_000;
const DETAIL_QUEUE_ITEM_MAX_CHARS = 120;
const DETAIL_CHILD_ROWS = 10;
const SESSION_PARAM_DESCRIPTION = "Session selector: activeSessionId, sessionId, id suffix, or session name";

type DaemonCreateCommand = Extract<DaemonCommandBody, { type: "create" }>;

export interface McpServeToolContext {
	bridge: DaemonBridge;
	host: string;
}

export function registerMcpServeTools(server: McpServer, context: McpServeToolContext): void {
	registerStatusTool(server, context);
	registerSessionDetailTool(server, context);
	registerTranscriptTool(server, context);
	registerSendTool(server, context);
	registerInterruptTool(server, context);
	registerStartSessionTool(server, context);
	registerResumeSessionTool(server, context);
	registerRestartSessionTool(server, context);
	registerKillSessionTool(server, context);
}

function registerStatusTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"status",
		{
			title: "Fleet status",
			description:
				"Fleet overview for this machine: every agent session with a derived state " +
				"(worker_failed, waiting_on_user, stalled, working, idle, inactive), the evidence behind it, " +
				"and the pending question for sessions waiting on a user. Start here.",
			inputSchema: {
				all: z.boolean().optional().describe("Include saved sessions that are not running (default: false)"),
				include_children: z
					.boolean()
					.optional()
					.describe("Include RLM child sessions as their own rows (default: false)"),
				max_rows: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe(`Maximum session rows to render (default: ${STATUS_DEFAULT_MAX_ROWS})`),
			},
		},
		async ({ all, include_children, max_rows }) =>
			runTool(async () => {
				const sessions = await listSessions(context.bridge, all === true);
				const selection = selectFleetRows(deriveFleet(sessions, Date.now()), {
					includeChildren: include_children === true,
					maxRows: max_rows ?? STATUS_DEFAULT_MAX_ROWS,
					maxInactiveRows: STATUS_MAX_SAVED_ROWS,
				});
				const pendingQuestions = await loadPendingQuestions(context.bridge, selection.rows);
				const daemon = daemonStatusInfo(context.bridge);
				return {
					text: renderFleetStatus({ host: context.host, daemon, selection, pendingQuestions }),
					structuredContent: {
						host: context.host,
						daemon,
						counts: selection.counts,
						totals: selection.totals,
						sessions: selection.rows.map((session) => {
							const question = pendingQuestions.get(session.session);
							return question ? { ...session, pendingQuestion: question } : session;
						}),
					},
				};
			}),
	);
}

function registerSessionDetailTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"session_detail",
		{
			title: "Session detail",
			description:
				"Everything known about one session: derived state and evidence, token and cost stats, " +
				"queued messages, RLM children, heartbeats, and the full pending question. " +
				"Needs a running session; bring an inactive one back with resume_session first.",
			inputSchema: { session: z.string().describe(SESSION_PARAM_DESCRIPTION) },
		},
		async ({ session }) =>
			runTool(async () => {
				const bridge = context.bridge;
				const state = await readSessionSummary(bridge, session);
				if (!state) {
					throw new Error(`Unknown active session: ${session}`);
				}
				const notes: string[] = [];
				const [stats, queue, children, lastAssistantText, heartbeats] = await Promise.all([
					attempt(notes, "stats", () =>
						bridge.command<SessionStats>(
							{ type: "get_session_stats", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					attempt(notes, "queue", () =>
						bridge.command<{ steering: string[]; followUp: string[] }>(
							{ type: "get_queue", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					attempt(notes, "children", () =>
						bridge.command<{ children: AgentConnectionRlmChildAgentSnapshot[] }>(
							{ type: "get_rlm_children", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					attempt(notes, "last assistant message", () =>
						bridge.command<{ text?: string }>(
							{ type: "get_last_assistant_text", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					attempt(notes, "heartbeats", () =>
						bridge.command<{ heartbeats: AgentConnectionHeartbeat[] }>(
							{ type: "heartbeats_list", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
				]);
				const childList = children?.children ?? [];
				const derived = deriveSession(state, Date.now(), childList.length);
				const question = lastAssistantText?.text;
				return {
					text: renderSessionDetail({
						derived,
						state,
						...(stats ? { stats } : {}),
						...(queue ? { queue } : {}),
						children: childList,
						heartbeats: heartbeats?.heartbeats ?? [],
						notes,
						...(question ? { question } : {}),
					}),
					structuredContent: {
						session: derived,
						sessionFile: state.sessionFile,
						...(stats ? { stats } : {}),
						...(queue ? { queue } : {}),
						children: childList,
						heartbeats: heartbeats?.heartbeats ?? [],
						notes,
						...(question ? { lastAssistantText: truncate(question, DETAIL_QUESTION_MAX_CHARS) } : {}),
					},
				};
			}),
	);
}

function registerTranscriptTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"transcript",
		{
			title: "Session transcript",
			description:
				"Recent messages of one session, newest last, bounded by a character budget. " +
				"Page further back by passing the returned next_before as before. " +
				"Needs a running session; bring an inactive one back with resume_session first.",
			inputSchema: {
				session: z.string().describe(SESSION_PARAM_DESCRIPTION),
				max_chars: z
					.number()
					.int()
					.min(200)
					.max(TRANSCRIPT_MAX_CHARS_LIMIT)
					.optional()
					.describe(`Character budget for the window (default: ${TRANSCRIPT_DEFAULT_MAX_CHARS})`),
				before: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Render the messages before this message index (paging cursor)"),
			},
		},
		async ({ session, max_chars, before }) =>
			runTool(async () => {
				const data = await context.bridge.command<{ messages?: unknown }>(
					{ type: "get_messages", activeSessionId: session },
					DAEMON_GET_TIMEOUT_MS,
				);
				const messages = (Array.isArray(data.messages) ? data.messages : []) as AgentMessage[];
				const window = renderTranscript(messages, {
					maxChars: max_chars ?? TRANSCRIPT_DEFAULT_MAX_CHARS,
					...(before === undefined ? {} : { before }),
				});
				return {
					text: window.text,
					structuredContent: {
						session,
						text: window.text,
						first_index: window.firstIndex,
						last_index: window.lastIndex,
						total: window.total,
						...(window.nextBefore === undefined ? {} : { next_before: window.nextBefore }),
					},
				};
			}),
	);
}

function registerSendTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"send",
		{
			title: "Send a message to sessions",
			description:
				"Deliver a message to one or more sessions. auto prompts (queueing when busy), steer interrupts " +
				"the current turn, follow_up queues after it. Success means the message was admitted, not that " +
				"the agent finished; poll status for progress.",
			inputSchema: {
				sessions: z.array(z.string()).min(1).describe(`Session selectors. ${SESSION_PARAM_DESCRIPTION}`),
				message: z.string().min(1).describe("Message text to deliver"),
				mode: z.enum(["auto", "steer", "follow_up"]).optional().describe("Delivery mode (default: auto)"),
			},
		},
		async ({ sessions, message, mode }) =>
			runTool(async () => {
				const delivery = mode ?? "auto";
				const results = await Promise.all(
					sessions.map((session) => sendToSession(context.bridge, session, message, delivery)),
				);
				const lines = results.map((result) =>
					result.delivered === "error"
						? `[error] ${result.session}: ${result.error ?? "unknown error"}`
						: `[${result.delivered}] ${result.session}`,
				);
				lines.push(`mode ${delivery}: admitted, not completed - poll status for progress.`);
				return { text: lines.join("\n"), structuredContent: { mode: delivery, results } };
			}),
	);
}

function registerInterruptTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"interrupt",
		{
			title: "Interrupt a session",
			description: "Stop the current turn, a running bash command, or an in-flight compaction.",
			inputSchema: {
				session: z.string().describe(SESSION_PARAM_DESCRIPTION),
				what: z.enum(["turn", "bash", "compaction"]).optional().describe("What to interrupt (default: turn)"),
			},
		},
		async ({ session, what }) =>
			runTool(async () => {
				const target = what ?? "turn";
				const command = target === "bash" ? "abort_bash" : target === "compaction" ? "abort_compaction" : "abort";
				await context.bridge.command({ type: command, activeSessionId: session });
				return {
					text: `Sent interrupt (${target}) to ${session}. Poll status to see whether it stopped.`,
					structuredContent: { session, what: target, command },
				};
			}),
	);
}

function registerStartSessionTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"start_session",
		{
			title: "Start a session",
			description: "Create a resident session in a working directory and send it a first prompt.",
			inputSchema: {
				cwd: z.string().describe("Absolute working directory for the new session"),
				prompt: z.string().min(1).describe("First message for the new session"),
				name: z.string().optional().describe("Session name"),
				model: z.string().optional().describe("Model selector, e.g. anthropic/claude-opus-5"),
			},
		},
		async ({ cwd, prompt, name, model }) =>
			runTool(async () => {
				const summary = await createSession(context.bridge, {
					type: "create",
					config: { cwd, ...(model ? { model } : {}) },
					...(name ? { name } : {}),
				});
				const session = sessionSelector(summary);
				const outcome = await deliverPromptOutcome(context.bridge, session, prompt);
				const derived = deriveSession(await refreshState(context.bridge, session, summary), Date.now(), 0);
				return {
					text: `Started ${session}\n${renderSessionLine(derived)}\n${renderDelivery("Prompt", outcome)}`,
					structuredContent: { session: derived, ...deliveryContent("promptDelivered", outcome) },
				};
			}),
	);
}

function registerResumeSessionTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"resume_session",
		{
			title: "Resume a session",
			description:
				"Bring a saved session back up, or reuse it when it is already running, and optionally send a message.",
			inputSchema: {
				session: z.string().describe(`${SESSION_PARAM_DESCRIPTION}, or a session file path`),
				message: z.string().optional().describe("Message to send once the session is live"),
			},
		},
		async ({ session, message }) =>
			runTool(async () => {
				const resumed = await resumeSession(context.bridge, session);
				const outcome = message ? await deliverPromptOutcome(context.bridge, resumed.session, message) : undefined;
				const lines = [
					resumed.wasAlreadyActive ? `${resumed.session} was already running.` : `Resumed ${resumed.session}.`,
				];
				if (resumed.summary) {
					lines.push(renderSessionLine(deriveSession(resumed.summary, Date.now(), 0)));
				}
				if (outcome) {
					lines.push(renderDelivery("Message", outcome));
				}
				return {
					text: lines.join("\n"),
					structuredContent: {
						session: resumed.session,
						was_already_active: resumed.wasAlreadyActive,
						...(resumed.summary ? { summary: deriveSession(resumed.summary, Date.now(), 0) } : {}),
						...(outcome ? deliveryContent("messageDelivered", outcome) : {}),
					},
				};
			}),
	);
}

function registerRestartSessionTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"restart_session",
		{
			title: "Restart a session",
			description:
				"Recover a session: retry a failed worker, or stop and resume it from its session file. " +
				"The transcript is preserved either way.",
			inputSchema: {
				session: z.string().describe(SESSION_PARAM_DESCRIPTION),
				recovery_message: z.string().optional().describe("Message to send once the session is back"),
			},
		},
		async ({ session, recovery_message }) =>
			runTool(async () => {
				const bridge = context.bridge;
				// Read the session file BEFORE the kill: the row leaves the live list afterwards.
				const state = await readSessionSummary(bridge, session);
				if (!state) {
					throw new Error(`Unknown active session: ${session}`);
				}
				const previousSession = sessionSelector(state);
				let path: "retry_worker" | "kill_and_resume";
				let summary: SessionSummary | undefined;
				let nextSession: string;
				// A recovering worker is reported as worker_failed by status, so it takes the
				// same repair path the caller was told about.
				if (state.workerState === "failed" || state.workerState === "recovering") {
					path = "retry_worker";
					await bridge.command({ type: "retry_worker", activeSessionId: previousSession });
					nextSession = previousSession;
				} else {
					if (!state.sessionFile) {
						throw new Error(`Session ${previousSession} has no session file, so it cannot be restarted.`);
					}
					path = "kill_and_resume";
					await bridge.command({ type: "kill", activeSessionId: previousSession });
					const resumed = await resumeSession(bridge, state.sessionFile);
					summary = resumed.summary;
					nextSession = resumed.session;
				}
				const outcome = recovery_message
					? await deliverPromptOutcome(bridge, nextSession, recovery_message)
					: undefined;
				const lines = [
					path === "retry_worker"
						? `Retried the failed worker for ${previousSession}.`
						: `Stopped ${previousSession} and resumed it as ${nextSession}.`,
				];
				if (summary) {
					lines.push(renderSessionLine(deriveSession(summary, Date.now(), 0)));
				}
				if (outcome) {
					lines.push(renderDelivery("Recovery message", outcome));
				}
				return {
					text: lines.join("\n"),
					structuredContent: {
						path,
						previous_session: previousSession,
						session: nextSession,
						session_file: state.sessionFile,
						...(summary ? { summary: deriveSession(summary, Date.now(), 0) } : {}),
						...(outcome ? deliveryContent("recoveryMessageDelivered", outcome) : {}),
					},
				};
			}),
	);
}

function registerKillSessionTool(server: McpServer, context: McpServeToolContext): void {
	server.registerTool(
		"kill_session",
		{
			title: "Stop a session",
			description: "Stop a running session. Its session file stays on disk and can be resumed later.",
			inputSchema: { session: z.string().describe(SESSION_PARAM_DESCRIPTION) },
		},
		async ({ session }) =>
			runTool(async () => {
				const bridge = context.bridge;
				const state = await readSessionSummary(bridge, session);
				let note = "";
				try {
					await bridge.command({ type: "kill", activeSessionId: session });
				} catch (error) {
					// The supervisor refuses to route a command to a failed worker but still
					// stops it, so an error here can mean the session is already gone. That
					// story only holds for a session that existed before the kill and is
					// provably gone after it; anything else is a real failure.
					if (!state) {
						throw error;
					}
					let remaining: SessionSummary | undefined;
					try {
						remaining = await readSessionSummary(bridge, session);
					} catch {
						// The stop cannot be confirmed, so report the original failure.
						throw error;
					}
					if (remaining) {
						throw error;
					}
					note = " The worker was not answering, so the daemon stopped it directly.";
				}
				return {
					text:
						`Stopped ${session}.${note}` +
						(state?.sessionFile
							? ` Session file kept at ${state.sessionFile}; resume_session brings it back.`
							: ""),
					structuredContent: {
						session,
						...(state?.sessionFile ? { session_file: state.sessionFile } : {}),
						...(note ? { note: note.trim() } : {}),
					},
				};
			}),
	);
}

interface SendResult {
	session: string;
	delivered: "accepted" | "queued" | "error";
	error?: string;
}

/** One failing session must never stop delivery to the rest. */
async function sendToSession(
	bridge: DaemonBridge,
	session: string,
	message: string,
	mode: "auto" | "steer" | "follow_up",
): Promise<SendResult> {
	try {
		if (mode === "auto") {
			return { session, delivered: await deliverPrompt(bridge, session, message) };
		}
		await bridge.command({ type: mode === "steer" ? "steer" : "follow_up", activeSessionId: session, message });
		return { session, delivered: "queued" };
	} catch (error) {
		return { session, delivered: "error", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A plain prompt is rejected by a session that is already streaming, whatever
 * `queueIfBusy` says: the session only queues visible work when the command
 * carries a streaming behavior (`agent-session.ts`, "Specify streamingBehavior").
 * Retrying on that rejection queues the message and reports it honestly, without
 * a pre-check that a busy session could invalidate between the two calls.
 */
async function deliverPrompt(bridge: DaemonBridge, session: string, message: string): Promise<"accepted" | "queued"> {
	try {
		await bridge.command({ type: "prompt", activeSessionId: session, message, queueIfBusy: true });
		return "accepted";
	} catch (error) {
		if (!(error instanceof DaemonCommandError) || !error.daemonMessage.includes("Specify streamingBehavior")) {
			throw error;
		}
		await bridge.command({
			type: "prompt",
			activeSessionId: session,
			message,
			queueIfBusy: true,
			streamingBehavior: "followUp",
		});
		return "queued";
	}
}

/**
 * The session already exists once the prompt is attempted, so a prompt failure must
 * not hide its identity: a caller that only saw the error would create another one.
 */
async function deliverPromptOutcome(
	bridge: DaemonBridge,
	session: string,
	message: string,
): Promise<{ delivered: "accepted" | "queued" } | { error: string }> {
	try {
		return { delivered: await deliverPrompt(bridge, session, message) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function renderDelivery(label: string, outcome: { delivered: "accepted" | "queued" } | { error: string }): string {
	return "error" in outcome
		? `${label} failed: ${outcome.error}`
		: `${label} ${outcome.delivered} - admitted, not completed. Poll status for progress.`;
}

function deliveryContent(
	key: string,
	outcome: { delivered: "accepted" | "queued" } | { error: string },
): Record<string, string> {
	return "error" in outcome ? { [`${key}Error`]: outcome.error } : { [key]: outcome.delivered };
}

async function createSession(bridge: DaemonBridge, command: DaemonCreateCommand): Promise<SessionSummary> {
	const data = await bridge.command<unknown>(command, DAEMON_CREATE_TIMEOUT_MS);
	if (!isDaemonSessionSummary(data)) {
		throw new Error("The daemon did not return a session for the create command.");
	}
	return data;
}

/**
 * Resume is idempotent: a session that is already live is the answer, whether the
 * daemon reports that up front (get_state finds a live worker) or as a
 * `session_already_active` error while opening its file.
 */
async function resumeSession(
	bridge: DaemonBridge,
	selector: string,
): Promise<{ session: string; wasAlreadyActive: boolean; summary?: SessionSummary }> {
	const live = await optional(() => readSessionSummary(bridge, selector));
	if (live) {
		return { session: sessionSelector(live), wasAlreadyActive: true, summary: live };
	}
	try {
		const summary = await createSession(bridge, { type: "create", sessionPath: selector });
		const session = sessionSelector(summary);
		return { session, wasAlreadyActive: false, summary: await refreshState(bridge, session, summary) };
	} catch (error) {
		if (error instanceof DaemonCommandError && error.errorInfo?.code === "session_already_active") {
			return { session: error.errorInfo.activeSessionId ?? selector, wasAlreadyActive: true };
		}
		throw error;
	}
}

/**
 * A create response carries the worker's own summary, which has no supervisor
 * fields yet (`workerState`, `attachedClients`). Re-reading state gives the same
 * row every other tool sees.
 */
async function refreshState(bridge: DaemonBridge, session: string, fallback: SessionSummary): Promise<SessionSummary> {
	const state = await optional(() => readSessionSummary(bridge, session));
	return state ?? fallback;
}

interface SessionDetail {
	derived: DerivedSession;
	state: SessionSummary;
	stats?: SessionStats;
	queue?: { steering: string[]; followUp: string[] };
	children: readonly AgentConnectionRlmChildAgentSnapshot[];
	heartbeats: readonly AgentConnectionHeartbeat[];
	notes: readonly string[];
	question?: string;
}

function renderSessionDetail(detail: SessionDetail): string {
	const lines = [renderSessionLine(detail.derived), `cwd: ${detail.state.cwd}`];
	lines.push(
		`selector: ${detail.derived.session} · session id: ${detail.derived.sessionId}` +
			(detail.state.sessionFile ? ` · file: ${detail.state.sessionFile}` : ""),
	);
	if (detail.stats) {
		const { tokens, cost, contextUsage } = detail.stats;
		const context =
			contextUsage?.percent === null || contextUsage === undefined
				? undefined
				: `context ${Math.round(contextUsage.percent)}% of ${contextUsage.contextWindow}`;
		lines.push(
			[
				`messages ${detail.stats.totalMessages} (user ${detail.stats.userMessages}, assistant ${detail.stats.assistantMessages}, tools ${detail.stats.toolCalls})`,
				`tokens ${tokens.input} in / ${tokens.output} out / ${tokens.cacheRead} cache read`,
				`cost $${cost.toFixed(4)}`,
				context,
			]
				.filter((part): part is string => part !== undefined)
				.join(" · "),
		);
	}
	if (detail.queue && (detail.queue.steering.length > 0 || detail.queue.followUp.length > 0)) {
		lines.push(`queue: ${detail.queue.steering.length} steering, ${detail.queue.followUp.length} follow-up`);
		for (const message of [...detail.queue.steering, ...detail.queue.followUp]) {
			lines.push(`  - ${clip(message, DETAIL_QUEUE_ITEM_MAX_CHARS)}`);
		}
	}
	if (detail.children.length > 0) {
		lines.push(`children: ${detail.children.length}`);
		for (const child of detail.children.slice(0, DETAIL_CHILD_ROWS)) {
			const facts = [
				child.status,
				child.model,
				child.sessionName === child.label ? undefined : child.sessionName,
				child.recap ?? child.answerPreview,
			]
				.filter((fact): fact is string => fact !== undefined)
				.join(" · ");
			lines.push(`  - ${clip(`${child.label} · ${facts}`, 160)}`);
		}
		if (detail.children.length > DETAIL_CHILD_ROWS) {
			lines.push(`  +${detail.children.length - DETAIL_CHILD_ROWS} more children`);
		}
	}
	if (detail.heartbeats.length > 0) {
		lines.push(`heartbeats: ${detail.heartbeats.length}`);
		for (const heartbeat of detail.heartbeats) {
			lines.push(`  - ${clip(formatAgentCronJob(heartbeat.job), 200)}`);
		}
	}
	if (detail.notes.length > 0) {
		lines.push(`notes: ${detail.notes.join("; ")}`);
	}
	if (detail.question) {
		lines.push("last assistant message:", truncate(detail.question, DETAIL_QUESTION_MAX_CHARS));
	}
	return lines.join("\n");
}

/**
 * Worker `get_state` is the freshest session-owned view, but only the supervisor
 * list carries authoritative residency fields such as workerState and attached
 * clients. Merge both without allowing a raw worker row to erase stamped fields.
 * Failed/recovering workers cannot answer `get_state`, so their list row remains
 * sufficient for restart and stop operations.
 */
async function readSessionSummary(bridge: DaemonBridge, selector: string): Promise<SessionSummary | undefined> {
	let publicState: SessionSummary | undefined;
	let listError: unknown;
	try {
		publicState = resolveSessionSummary(await listSessions(bridge, false), selector);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Ambiguous active session")) {
			throw error;
		}
		listError = error;
	}

	if (publicState?.workerState === "failed" || publicState?.workerState === "recovering") {
		return publicState;
	}

	let sessionState: SessionSummary | undefined;
	let stateError: unknown;
	try {
		sessionState = await bridge.command<SessionSummary>(
			{ type: "get_state", activeSessionId: selector },
			DAEMON_GET_TIMEOUT_MS,
		);
	} catch (error) {
		stateError = error;
	}

	if (sessionState && publicState) {
		return {
			...sessionState,
			attachedClients: publicState.attachedClients,
			...(publicState.workerState ? { workerState: publicState.workerState } : {}),
			...(publicState.workerPid !== undefined ? { workerPid: publicState.workerPid } : {}),
		};
	}
	if (publicState) return publicState;
	if (sessionState) return sessionState;
	if (listError) {
		throw new Error(
			`Cannot read session "${selector}": ${errorMessage(listError)} (state read: ${errorMessage(stateError)})`,
		);
	}
	return undefined;
}

/**
 * Applies `matchWorkers`' resolution rules, not just its predicate: an exact hit
 * anywhere in the fleet beats every suffix hit, and an ambiguous selector is an
 * error rather than an arbitrary row — otherwise a destructive tool could act on
 * the wrong session.
 */
export function resolveSessionSummary(
	sessions: readonly SessionSummary[],
	selector: string,
): SessionSummary | undefined {
	const exact = sessions.filter((summary) => matchesSessionSelectorExactly(summary, selector));
	const candidates = exact.length > 0 ? exact : sessions.filter((summary) => matchesSessionIdTail(summary, selector));
	if (candidates.length > 1) {
		throw new Error(`Ambiguous active session "${selector}"`);
	}
	return candidates[0];
}

function matchesSessionSelectorExactly(summary: SessionSummary, selector: string): boolean {
	return (
		sessionSelector(summary) === selector ||
		summary.sessionId === selector ||
		summary.sessionName === selector ||
		summary.sessionFile === selector
	);
}

function matchesSessionIdTail(summary: SessionSummary, selector: string): boolean {
	return (
		matchesSessionIdSuffix(sessionSelector(summary), selector) || matchesSessionIdSuffix(summary.sessionId, selector)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listSessions(bridge: DaemonBridge, all: boolean): Promise<SessionSummary[]> {
	// `all` makes the supervisor scan every saved session in its catalog process.
	const data = await bridge.command<{ sessions?: unknown }>(
		{ type: "list", all },
		all ? DAEMON_CATALOG_TIMEOUT_MS : DAEMON_GET_TIMEOUT_MS,
	);
	const sessions = Array.isArray(data.sessions) ? data.sessions : [];
	return sessions.filter(isDaemonSessionSummary);
}

/** Best effort: a session that cannot answer in time is reported without its question. */
async function loadPendingQuestions(
	bridge: DaemonBridge,
	sessions: readonly DerivedSession[],
): Promise<ReadonlyMap<string, string>> {
	const waiting = sessions.filter((session) => session.state === "waiting_on_user");
	const entries = await Promise.all(
		waiting.map(async (session): Promise<[string, string] | undefined> => {
			const data = await optional(() =>
				bridge.command<{ text?: string }>(
					{ type: "get_last_assistant_text", activeSessionId: session.session },
					PENDING_QUESTION_TIMEOUT_MS,
				),
			);
			return data?.text ? [session.session, data.text] : undefined;
		}),
	);
	return new Map(entries.filter((entry): entry is [string, string] => entry !== undefined));
}

export function daemonStatusInfo(bridge: DaemonBridge): DaemonStatusInfo {
	const hello = bridge.hello;
	return {
		socketPath: bridge.socketPath,
		...(hello?.appVersion ? { appVersion: hello.appVersion } : {}),
		protocolVersion: hello?.protocol.version ?? 0,
		...(hello?.schemaId ? { schemaId: hello.schemaId } : {}),
		...(hello?.appVersion && hello.appVersion !== VERSION ? { versionSkew: `mcp-serve runs ${VERSION}` } : {}),
	};
}

/**
 * Optional detail: an unsupported or failing getter must not fail the whole tool
 * call, but its absence is reported rather than hidden — a missing section is
 * usually daemon capability or version skew.
 */
async function attempt<T>(notes: string[], label: string, run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		notes.push(`${label} unavailable: ${clip(error instanceof Error ? error.message : String(error), 120)}`);
		return undefined;
	}
}

async function optional<T>(run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch {
		return undefined;
	}
}

async function runTool(
	run: () => Promise<{ text: string; structuredContent: Record<string, unknown> }>,
): Promise<CallToolResult> {
	try {
		const result = await run();
		return {
			content: [{ type: "text", text: result.text }],
			structuredContent: result.structuredContent,
		};
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		};
	}
}
