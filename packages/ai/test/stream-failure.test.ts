import { afterEach, describe, expect, test } from "vitest";
import { setLogSink } from "../src/log.js";
import type { AssistantMessage } from "../src/types.js";
import {
	classifyStreamFailure,
	extractStreamFailureInfo,
	formatStreamFailureMessage,
	recordStreamFailure,
	StreamFailureError,
	streamFailureFromStopReason,
} from "../src/utils/stream-failure.js";

afterEach(() => setLogSink(undefined));

function makeOutput(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 0,
		...overrides,
	};
}

describe("classifyStreamFailure", () => {
	test.each([
		["overloaded_error", undefined, "overloaded"],
		[undefined, 529, "overloaded"],
		["rate_limit_error", undefined, "rate_limit"],
		[undefined, 429, "rate_limit"],
		["refusal", undefined, "refusal"],
		["sensitive", undefined, "safety"],
		["SAFETY", undefined, "safety"],
		["PROHIBITED_CONTENT", undefined, "safety"],
		["content_filter", undefined, "safety"],
		["guardrail_intervened", undefined, "safety"],
		["authentication_error", undefined, "auth"],
		["invalid_request_error", undefined, "invalid_request"],
		["api_error", undefined, "server_error"],
		[undefined, 503, "server_error"],
		["something_else", undefined, "unknown"],
	])("classifies %s / %s as %s", (type, status, expected) => {
		expect(classifyStreamFailure(type, status)).toBe(expected);
	});
});

describe("streamFailureFromStopReason", () => {
	test("preserves the raw stop reason instead of a generic message", () => {
		const error = streamFailureFromStopReason("refusal", { requestId: "req_abc" });
		expect(error.message).toBe("Model refused to respond (refusal) [request_id: req_abc]");
		expect(error.info).toMatchObject({ kind: "refusal", providerErrorType: "refusal", requestId: "req_abc" });
	});

	test("maps Gemini safety finish reasons", () => {
		expect(streamFailureFromStopReason("SAFETY").info.kind).toBe("safety");
		expect(streamFailureFromStopReason("MALFORMED_FUNCTION_CALL").info.kind).toBe("malformed_response");
	});

	test("still explains a missing stop reason", () => {
		const error = streamFailureFromStopReason(undefined);
		expect(error.info.kind).toBe("unknown");
		expect(error.message).toContain("no stop reason");
	});
});

describe("extractStreamFailureInfo", () => {
	test("passes through StreamFailureError info", () => {
		const info = { kind: "overloaded" as const, requestId: "req_1" };
		expect(extractStreamFailureInfo(new StreamFailureError("x", info))).toBe(info);
	});

	test("extracts status, nested error type, and request id from SDK-shaped errors", () => {
		const sdkError = Object.assign(new Error("529 overloaded"), {
			status: 529,
			error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
			requestID: "req_sdk",
		});
		expect(extractStreamFailureInfo(sdkError)).toMatchObject({
			kind: "overloaded",
			providerErrorType: "overloaded_error",
			status: 529,
			requestId: "req_sdk",
		});
	});

	test("distinguishes Anthropic subscription usage exhaustion from a generic 429", () => {
		const exhausted = Object.assign(new Error("429 usage exhausted"), {
			status: 429,
			error: {
				type: "error",
				error: {
					type: "rate_limit_error",
					message: "This request would exceed your account's rate limit. Please try again later.",
				},
			},
			headers: new Headers({
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "1787018400",
				"retry-after": "261858",
				"request-id": "req_usage",
			}),
		});
		expect(extractStreamFailureInfo(exhausted)).toMatchObject({
			kind: "usage_limit",
			providerErrorType: "rate_limit_error",
			status: 429,
			requestId: "req_usage",
			retryAfterMs: 261_858_000,
			resetAt: 1_787_018_400_000,
		});

		const generic429 = Object.assign(new Error("429 burst limit"), {
			status: 429,
			error: { type: "rate_limit_error", message: "Too many requests" },
		});
		expect(extractStreamFailureInfo(generic429).kind).toBe("rate_limit");
	});

	test("extracts AWS SDK request id and exception name", () => {
		const awsError = Object.assign(new Error("throttled"), {
			name: "ThrottlingException",
			$metadata: { requestId: "aws_req" },
		});
		expect(extractStreamFailureInfo(awsError)).toMatchObject({ requestId: "aws_req" });
	});

	test("falls back to classifying the message text", () => {
		expect(extractStreamFailureInfo(new Error("provider overloaded, retry later")).kind).toBe("overloaded");
		expect(extractStreamFailureInfo("not an error").kind).toBe("unknown");
	});
});

describe("formatStreamFailureMessage", () => {
	test("condenses a classified SDK error to a one-liner instead of the raw payload", () => {
		const sdkError = Object.assign(
			new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
			{
				status: 401,
				error: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
				requestID: "req_1",
			},
		);
		expect(formatStreamFailureMessage(sdkError)).toBe(
			"Provider authentication failed (authentication_error, 401): invalid x-api-key [request_id: req_1]",
		);
	});

	test("formats Anthropic usage exhaustion with its reset time", () => {
		const exhausted = Object.assign(new Error("429 usage exhausted"), {
			status: 429,
			error: {
				type: "error",
				error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
			},
			headers: new Headers({
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "1787018400",
				"retry-after": "261858",
			}),
		});
		expect(formatStreamFailureMessage(exhausted)).toBe(
			"Provider usage limit reached (rate_limit_error, 429); resets at 2026-08-18T02:00:00.000Z: This request would exceed your account's rate limit.",
		);
	});

	test("passes unrecognized errors through verbatim", () => {
		expect(formatStreamFailureMessage(new Error("fetch failed"))).toBe("fetch failed");
		expect(formatStreamFailureMessage(new Error("Request was aborted"))).toBe("Request was aborted");
	});

	test("uses the StreamFailureError message as-is", () => {
		const error = streamFailureFromStopReason("refusal");
		expect(formatStreamFailureMessage(error)).toBe(error.message);
	});
});

describe("recordStreamFailure", () => {
	const model = { provider: "anthropic", id: "claude-fable-5", api: "anthropic-messages" };

	test("appends a structured diagnostic and logs one entry", () => {
		const logged: Record<string, unknown>[] = [];
		setLogSink((entry) => logged.push(entry));

		const output = makeOutput({ errorMessage: "Provider overloaded (overloaded_error) [request_id: req_9]" });
		recordStreamFailure(model, output, new StreamFailureError("x", { kind: "overloaded", requestId: "req_9" }));

		expect(output.diagnostics).toHaveLength(1);
		expect(output.diagnostics?.[0]).toMatchObject({
			type: "provider_stream_failure",
			details: { kind: "overloaded", requestId: "req_9" },
		});
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			level: "error",
			component: "ai.provider",
			provider: "anthropic",
			model: "claude-fable-5",
			kind: "overloaded",
			requestId: "req_9",
		});
	});

	test("does nothing for user aborts", () => {
		const logged: unknown[] = [];
		setLogSink((entry) => logged.push(entry));
		const output = makeOutput({ stopReason: "aborted" });
		recordStreamFailure(model, output, new Error("Request was aborted"));
		expect(output.diagnostics).toBeUndefined();
		expect(logged).toEqual([]);
	});
});
