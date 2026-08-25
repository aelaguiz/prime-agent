import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isDaemonSessionSummary } from "../../cli/daemon-launch.js";
import { VERSION } from "../../config.js";
import { formatAgentCronJob } from "../../core/cron-jobs.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { AgentConnectionHeartbeat, AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { DAEMON_GET_TIMEOUT_MS, type DaemonBridge } from "./daemon-bridge.js";
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
	TRANSCRIPT_DEFAULT_MAX_CHARS,
	truncate,
} from "./render.js";

const PENDING_QUESTION_TIMEOUT_MS = 5_000;
const STATUS_DEFAULT_MAX_ROWS = 30;
const STATUS_MAX_SAVED_ROWS = 20;
const DETAIL_QUESTION_MAX_CHARS = 2_000;
const DETAIL_QUEUE_ITEM_MAX_CHARS = 120;
const DETAIL_CHILD_ROWS = 10;
const TRANSCRIPT_MAX_CHARS_LIMIT = 20_000;
const SESSION_PARAM_DESCRIPTION = "Session selector: activeSessionId, sessionId, id suffix, or session name";

export interface McpServeToolContext {
	bridge: DaemonBridge;
	host: string;
}

export function registerMcpServeTools(server: McpServer, context: McpServeToolContext): void {
	registerStatusTool(server, context);
	registerSessionDetailTool(server, context);
	registerTranscriptTool(server, context);
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
				"queued messages, RLM children, heartbeats, and the full pending question.",
			inputSchema: { session: z.string().describe(SESSION_PARAM_DESCRIPTION) },
		},
		async ({ session }) =>
			runTool(async () => {
				const bridge = context.bridge;
				const state = await bridge.command<SessionSummary>(
					{ type: "get_state", activeSessionId: session },
					DAEMON_GET_TIMEOUT_MS,
				);
				const [stats, queue, children, lastAssistantText, heartbeats] = await Promise.all([
					optional(() =>
						bridge.command<SessionStats>(
							{ type: "get_session_stats", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					optional(() =>
						bridge.command<{ steering: string[]; followUp: string[] }>(
							{ type: "get_queue", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					optional(() =>
						bridge.command<{ children: AgentConnectionRlmChildAgentSnapshot[] }>(
							{ type: "get_rlm_children", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					optional(() =>
						bridge.command<{ text?: string }>(
							{ type: "get_last_assistant_text", activeSessionId: session },
							DAEMON_GET_TIMEOUT_MS,
						),
					),
					optional(() =>
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
						...(question ? { question } : {}),
					}),
					structuredContent: {
						session: derived,
						sessionFile: state.sessionFile,
						...(stats ? { stats } : {}),
						...(queue ? { queue } : {}),
						children: childList,
						heartbeats: heartbeats?.heartbeats ?? [],
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
				"Page further back by passing the returned next_before as before.",
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

interface SessionDetail {
	derived: DerivedSession;
	state: SessionSummary;
	stats?: SessionStats;
	queue?: { steering: string[]; followUp: string[] };
	children: readonly AgentConnectionRlmChildAgentSnapshot[];
	heartbeats: readonly AgentConnectionHeartbeat[];
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
	if (detail.question) {
		lines.push("last assistant message:", truncate(detail.question, DETAIL_QUESTION_MAX_CHARS));
	}
	return lines.join("\n");
}

async function listSessions(bridge: DaemonBridge, all: boolean): Promise<SessionSummary[]> {
	const data = await bridge.command<{ sessions?: unknown }>({ type: "list", all }, DAEMON_GET_TIMEOUT_MS);
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

/** Optional detail: an unsupported or failing getter must not fail the whole tool call. */
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
