import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import {
	deriveFleet,
	deriveSession,
	deriveSessionState,
	renderFleetStatus,
	renderMessage,
	renderSessionLine,
	renderTranscript,
	STALLED_AFTER_MS,
	selectFleetRows,
} from "../src/modes/mcp-serve/render.js";

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "01a03930-0000-0000-0000-0000000000a1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "01a03930-0000-0000-0000-0000000000a1",
		activeSessionId: "aaaabbbbccc1",
		cwd: "/Users/test/workspace/repo",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		workerState: "ready",
		lastActivityAt: new Date(NOW - 60_000).toISOString(),
		...overrides,
	};
}

function ago(ms: number): string {
	return new Date(NOW - ms).toISOString();
}

describe("mcp-serve session state derivation", () => {
	it("marks rows without a live worker inactive", () => {
		expect(deriveSessionState(summary({ workerState: undefined, activeSessionId: undefined }), NOW)).toBe("inactive");
		expect(deriveSessionState(summary({ lifecycle: "archived" }), NOW)).toBe("inactive");
		expect(deriveSessionState(summary({ lifecycle: "draft" }), NOW)).toBe("inactive");
	});

	it("keeps live RLM children out of the inactive bucket even without an activeSessionId", () => {
		const child = summary({ activeSessionId: undefined, rlmDepth: 1, parentActiveSessionId: "aaaabbbbccc1" });
		expect(deriveSessionState(child, NOW)).toBe("idle");
	});

	it("puts a failed or recovering worker ahead of every activity signal", () => {
		expect(
			deriveSessionState(summary({ workerState: "failed", activity: "working", taskState: "needs_input" }), NOW),
		).toBe("worker_failed");
		expect(deriveSessionState(summary({ workerState: "recovering", isStreaming: true }), NOW)).toBe("worker_failed");
	});

	it("puts working ahead of waiting_on_user", () => {
		expect(deriveSessionState(summary({ activity: "working", taskState: "needs_input" }), NOW)).toBe("working");
	});

	it("treats every activity signal as working", () => {
		expect(deriveSessionState(summary({ activity: "working" }), NOW)).toBe("working");
		expect(deriveSessionState(summary({ isStreaming: true }), NOW)).toBe("working");
		expect(deriveSessionState(summary({ isRunningTools: true }), NOW)).toBe("working");
		expect(deriveSessionState(summary({ isBashRunning: true }), NOW)).toBe("working");
		expect(deriveSessionState(summary({ hasRunningRlmChildren: true }), NOW)).toBe("working");
	});

	it("reports an idle session that needs input as waiting_on_user", () => {
		expect(
			deriveSessionState(summary({ taskState: "needs_input", lastActivityAt: ago(STALLED_AFTER_MS * 2) }), NOW),
		).toBe("waiting_on_user");
	});

	it("calls an idle root session stalled only past the staleness boundary", () => {
		expect(deriveSessionState(summary({ lastActivityAt: ago(STALLED_AFTER_MS) }), NOW)).toBe("idle");
		expect(deriveSessionState(summary({ lastActivityAt: ago(STALLED_AFTER_MS + 1) }), NOW)).toBe("stalled");
	});

	it("never calls a judged session or an RLM child stalled", () => {
		expect(
			deriveSessionState(summary({ taskState: "completed", lastActivityAt: ago(STALLED_AFTER_MS * 4) }), NOW),
		).toBe("idle");
		expect(deriveSessionState(summary({ rlmDepth: 1, lastActivityAt: ago(STALLED_AFTER_MS * 4) }), NOW)).toBe("idle");
	});

	it("carries raw evidence and the recap next to the verdict", () => {
		const derived = deriveSession(
			summary({
				sessionName: "worker",
				summary: "ran the tests",
				taskState: "needs_input",
				attachedClients: 2,
				hasActiveHeartbeat: true,
				lastActivityAt: ago(5 * 60_000),
			}),
			NOW,
			3,
		);
		expect(derived).toMatchObject({
			state: "waiting_on_user",
			session: "aaaabbbbccc1",
			name: "worker",
			minutesSinceActivity: 5,
			attachedClients: 2,
			hasActiveHeartbeat: true,
			childCount: 3,
			workerState: "ready",
			recap: { summary: "ran the tests", taskState: "needs_input" },
		});
	});

	it("falls back to the summary id as the selector", () => {
		const derived = deriveSession(summary({ activeSessionId: undefined, rlmDepth: 1 }), NOW, 0);
		expect(derived.session).toBe("01a03930-0000-0000-0000-0000000000a1");
		expect(derived.displayId).toBe("0000000000a1");
	});
});

describe("mcp-serve fleet selection", () => {
	const fleet = [
		summary({ id: "p1", sessionId: "p1", activeSessionId: "parent1", sessionName: "parent", activity: "working" }),
		summary({
			id: "c1",
			sessionId: "c1",
			activeSessionId: undefined,
			sessionName: "child-1",
			rlmDepth: 1,
			parentActiveSessionId: "parent1",
			lastActivityAt: ago(STALLED_AFTER_MS * 3),
		}),
		summary({
			id: "c2",
			sessionId: "c2",
			activeSessionId: undefined,
			sessionName: "child-2",
			rlmDepth: 1,
			parentActiveSessionId: "parent1",
		}),
		summary({ id: "f1", sessionId: "f1", activeSessionId: "failed1", sessionName: "broken", workerState: "failed" }),
		summary({
			id: "s1",
			sessionId: "s1",
			activeSessionId: undefined,
			workerState: undefined,
			sessionName: "saved-1",
		}),
		summary({
			id: "s2",
			sessionId: "s2",
			activeSessionId: undefined,
			workerState: undefined,
			sessionName: "saved-2",
			lastActivityAt: ago(STALLED_AFTER_MS * 10),
		}),
	];

	it("sorts needs-attention first, then by idle time", () => {
		expect(deriveFleet(fleet, NOW).map((session) => session.state)).toEqual([
			"worker_failed",
			"working",
			"idle",
			"idle",
			"inactive",
			"inactive",
		]);
	});

	it("hides RLM children but still counts them on the parent", () => {
		const selection = selectFleetRows(deriveFleet(fleet, NOW), {
			includeChildren: false,
			maxRows: 30,
			maxInactiveRows: 20,
		});
		expect(selection.rows.map((session) => session.name)).toEqual(["broken", "parent", "saved-1", "saved-2"]);
		expect(selection.rows.find((session) => session.name === "parent")?.childCount).toBe(2);
		expect(selection.totals.hiddenChildren).toBe(2);
		expect(selection.counts).toMatchObject({ worker_failed: 1, working: 1, inactive: 2, idle: 0 });
	});

	it("includes children on request", () => {
		const selection = selectFleetRows(deriveFleet(fleet, NOW), {
			includeChildren: true,
			maxRows: 30,
			maxInactiveRows: 20,
		});
		expect(selection.rows).toHaveLength(6);
		expect(selection.totals.hiddenChildren).toBe(0);
	});

	it("caps saved rows and total rows, and counts what it suppressed", () => {
		const selection = selectFleetRows(deriveFleet(fleet, NOW), {
			includeChildren: false,
			maxRows: 2,
			maxInactiveRows: 1,
		});
		expect(selection.rows.map((session) => session.name)).toEqual(["broken", "parent"]);
		expect(selection.totals).toMatchObject({ inactive: 2, inactiveShown: 1, shown: 2, suppressed: 2 });
		expect(selection.suppressedCounts.inactive).toBe(2);
	});
});

describe("mcp-serve fleet rendering", () => {
	const daemon = { socketPath: "/tmp/daemon.sock", appVersion: "0.8.0", protocolVersion: 7 };

	it("renders a header, the pending question, and the collapse line", () => {
		const sessions = deriveFleet(
			[
				summary({
					id: "w1",
					sessionId: "w1",
					activeSessionId: "wait1",
					sessionName: "asker",
					taskState: "needs_input",
				}),
				summary({ id: "w2", sessionId: "w2", activeSessionId: "work2", sessionName: "busy", activity: "working" }),
			],
			NOW,
		);
		const selection = selectFleetRows(sessions, { includeChildren: false, maxRows: 1, maxInactiveRows: 20 });
		const text = renderFleetStatus({
			host: "testhost",
			daemon,
			selection,
			pendingQuestions: new Map([["wait1", "Which branch should I use?"]]),
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe("testhost: 1 of 2 sessions (1 waiting_on_user, 1 working) · daemon 0.8.0, protocol 7");
		expect(lines[1]).toContain("[waiting_on_user] asker");
		expect(lines[2]).toBe("    Q: Which branch should I use?");
		expect(lines[3]).toBe("+1 more: 1 working");
	});

	it("reports hidden children and capped saved rows in the header", () => {
		const selection = selectFleetRows(
			deriveFleet(
				[
					summary({ id: "p", sessionId: "p", activeSessionId: "parent", sessionName: "parent" }),
					summary({
						id: "c",
						sessionId: "c",
						activeSessionId: undefined,
						rlmDepth: 1,
						parentActiveSessionId: "parent",
					}),
					summary({ id: "s1", sessionId: "s1", activeSessionId: undefined, workerState: undefined }),
					summary({ id: "s2", sessionId: "s2", activeSessionId: undefined, workerState: undefined }),
				],
				NOW,
			),
			{ includeChildren: false, maxRows: 30, maxInactiveRows: 1 },
		);
		const header = renderFleetStatus({ host: "testhost", daemon, selection, pendingQuestions: new Map() }).split(
			"\n",
		)[0]!;
		expect(header).toContain("1 child hidden");
		expect(header).toContain("1 of 2 saved shown");
	});

	it("bounds a session line and keeps the evidence", () => {
		const line = renderSessionLine(
			deriveSession(
				summary({
					sessionName: "long-runner",
					model: {
						id: "claude-opus-5",
						name: "Opus",
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl: "https://example.invalid",
						reasoning: true,
						input: ["text"],
						cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
						contextWindow: 1,
						maxTokens: 1,
					},
					isBashRunning: true,
					summary: "x".repeat(400),
				}),
				NOW,
				0,
			),
		);
		expect(line.length).toBeLessThanOrEqual(200);
		expect(line).toContain("[working] long-runner");
		expect(line).toContain("anthropic/claude-opus-5");
		expect(line).toContain("bash");
	});

	it("says so when there is nothing to show", () => {
		const selection = selectFleetRows([], { includeChildren: false, maxRows: 30, maxInactiveRows: 20 });
		expect(
			renderFleetStatus({ host: "testhost", daemon, selection, pendingQuestions: new Map() }).split("\n")[1],
		).toBe("No sessions.");
	});
});

describe("mcp-serve message rendering", () => {
	it("renders a user message", () => {
		expect(renderMessage({ role: "user", content: "hello there", timestamp: 1 }, 200)).toBe("[user] hello there");
	});

	it("renders assistant text, thinking, and tool calls", () => {
		const message = fauxAssistantMessage([
			fauxText("running the tests"),
			fauxThinking("pick the right file"),
			fauxToolCall("bash", { command: "npm test" }),
		]);
		const rendered = renderMessage(message, 200);
		expect(rendered).toContain("[assistant] running the tests");
		expect(rendered).toContain("pick the right file");
		expect(rendered).toContain('-> bash({"command":"npm test"})');
	});

	it("renders tool results, including errors and images", () => {
		expect(
			renderMessage(
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 1,
				},
				200,
			),
		).toBe("[toolResult:read] file body");
		expect(
			renderMessage(
				{
					role: "toolResult",
					toolCallId: "2",
					toolName: "screenshot",
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					isError: true,
					timestamp: 1,
				},
				200,
			),
		).toBe("[toolResult:screenshot error] [image]");
	});

	it("renders bash, custom, branch, and compaction messages", () => {
		expect(
			renderMessage(
				{
					role: "bashExecution",
					command: "ls",
					output: "file.txt",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
				200,
			),
		).toBe("[bash] ls -> file.txt");
		expect(
			renderMessage(
				{ role: "custom", customType: "prime-agent.note", content: "heads up", display: true, timestamp: 1 },
				200,
			),
		).toBe("[custom:prime-agent.note] heads up");
		expect(renderMessage({ role: "branchSummary", summary: "branched", fromId: "x", timestamp: 1 }, 200)).toBe(
			"[branchSummary] branched",
		);
		expect(
			renderMessage({ role: "compactionSummary", summary: "compacted", tokensBefore: 10, timestamp: 1 }, 200),
		).toBe("[compactionSummary] compacted");
	});

	it("bounds message text", () => {
		const rendered = renderMessage({ role: "user", content: "x".repeat(500), timestamp: 1 }, 50);
		expect(rendered.length).toBeLessThanOrEqual(58);
		expect(rendered.endsWith("\u2026")).toBe(true);
	});
});

describe("mcp-serve transcript rendering", () => {
	const messages = Array.from({ length: 10 }, (_, index) => ({
		role: "user" as const,
		content: `message ${index} ${"y".repeat(40)}`,
		timestamp: index,
	}));

	it("renders the newest messages last and marks the truncation", () => {
		const window = renderTranscript(messages, { maxChars: 200 });
		expect(window.total).toBe(10);
		expect(window.lastIndex).toBe(9);
		expect(window.firstIndex).toBeGreaterThan(0);
		const lines = window.text.split("\n");
		expect(lines[0]).toBe(`[truncated: showing messages ${window.firstIndex}-9 of 10]`);
		expect(lines.at(-1)).toContain("#9 [user] message 9");
		expect(window.nextBefore).toBe(window.firstIndex);
	});

	it("pages backwards with the returned cursor", () => {
		const first = renderTranscript(messages, { maxChars: 200 });
		const older = renderTranscript(messages, { maxChars: 200, before: first.nextBefore });
		expect(older.lastIndex).toBe(first.firstIndex - 1);
		expect(older.text).not.toContain(`#${first.firstIndex} `);
	});

	it("renders a whole short transcript without a marker", () => {
		const window = renderTranscript(messages.slice(0, 2), { maxChars: 4000 });
		expect(window.text.startsWith("#0 ")).toBe(true);
		expect(window.nextBefore).toBeUndefined();
	});

	it("handles an empty transcript", () => {
		expect(renderTranscript([], {})).toMatchObject({ text: "[no messages]", total: 0 });
	});
});
