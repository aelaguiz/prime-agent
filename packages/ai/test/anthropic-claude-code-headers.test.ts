import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

function getHeader(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, name: string): string | null {
	if (input instanceof Request) return input.headers.get(name);
	return new Headers(init?.headers).get(name);
}

function createAnthropicResponse(): Response {
	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-fable-5-1",
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Anthropic Claude Code compatibility headers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the minimum Claude Code version accepted by Claude Fable 5.1", async () => {
		let userAgent: string | null = null;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			userAgent = getHeader(input, init, "user-agent");
			return createAnthropicResponse();
		});

		const stream = streamSimple(
			getModel("anthropic", "claude-fable-5-1"),
			{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-oat-test", reasoning: "xhigh" },
		);
		await stream.result();

		expect(userAgent).toBe("claude-cli/2.1.251");
	});
});
