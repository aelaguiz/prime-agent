import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isDaemonSessionSummary } from "../../cli/daemon-launch.js";
import { VERSION } from "../../config.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { DAEMON_GET_TIMEOUT_MS, type DaemonBridge } from "./daemon-bridge.js";
import { type DaemonStatusInfo, type DerivedSession, deriveFleet, renderFleetStatus } from "./render.js";

const PENDING_QUESTION_TIMEOUT_MS = 5_000;

export interface McpServeToolContext {
	bridge: DaemonBridge;
	host: string;
}

export function registerMcpServeTools(server: McpServer, context: McpServeToolContext): void {
	registerStatusTool(server, context);
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
			},
		},
		async ({ all }) =>
			runTool(async () => {
				const sessions = await listSessions(context.bridge, all === true);
				const derived = deriveFleet(sessions, Date.now());
				const pendingQuestions = await loadPendingQuestions(context.bridge, derived);
				const daemon = daemonStatusInfo(context.bridge);
				const status = { host: context.host, daemon, sessions: derived, pendingQuestions };
				return {
					text: renderFleetStatus(status),
					structuredContent: {
						host: context.host,
						daemon,
						sessions: derived.map((session) => {
							const question = pendingQuestions.get(session.session);
							return question ? { ...session, pendingQuestion: question } : session;
						}),
					},
				};
			}),
	);
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
			try {
				const data = await bridge.command<{ text?: string }>(
					{ type: "get_last_assistant_text", activeSessionId: session.session },
					PENDING_QUESTION_TIMEOUT_MS,
				);
				return data.text ? [session.session, data.text] : undefined;
			} catch {
				return undefined;
			}
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
