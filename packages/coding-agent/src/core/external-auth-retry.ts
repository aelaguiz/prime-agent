import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	appendAssistantMessageDiagnostic,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, ResolvedRequestAuth } from "./model-registry.js";

type SuccessfulRequestAuth = Extract<ResolvedRequestAuth, { ok: true }>;

function createAdapterFailure(model: Model<Api>, error: unknown, premature = false): AssistantMessageEvent {
	const status =
		error && typeof error === "object"
			? typeof (error as { status?: unknown }).status === "number"
				? (error as { status: number }).status
				: typeof (error as { statusCode?: unknown }).statusCode === "number"
					? (error as { statusCode: number }).statusCode
					: undefined
			: undefined;
	const kind = status === 401 || status === 403 ? "auth" : "unknown";
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			kind === "auth"
				? `Provider authentication failed (${status})`
				: premature
					? "Provider stream ended without a terminal event"
					: "Provider stream failed before completion",
		timestamp: Date.now(),
	};
	appendAssistantMessageDiagnostic(message, {
		type: "provider_stream_failure",
		timestamp: Date.now(),
		details: { kind, ...(status === undefined ? {} : { status }) },
	});
	return { type: "error", reason: "error", error: message };
}

async function* normalizeAttempt(
	createStream: () => AssistantMessageEventStream,
	model: Model<Api>,
): AsyncGenerator<AssistantMessageEvent> {
	let terminal = false;
	try {
		for await (const event of createStream()) {
			if (event.type === "done" || event.type === "error") terminal = true;
			yield event;
		}
	} catch (error) {
		terminal = true;
		yield createAdapterFailure(model, error);
	}
	if (!terminal) yield createAdapterFailure(model, undefined, true);
}

function isStructured401Or403(message: AssistantMessage): boolean {
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
	const details = failure?.details;
	if (!details || details.kind !== "auth") return false;
	const status = typeof details.status === "string" ? Number(details.status) : details.status;
	return status === 401 || status === 403;
}

function appendRetryDiagnostic(message: AssistantMessage, outcome: "changed" | "unchanged_or_failed"): void {
	appendAssistantMessageDiagnostic(message, {
		type: "external_auth_retry",
		timestamp: Date.now(),
		details: { outcome },
	});
}

export async function completeSimpleWithExternalAuthRetry(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	modelRegistry: ModelRegistry,
	resolvedAuth?: SuccessfulRequestAuth,
): Promise<AssistantMessage> {
	const requestOptions = options ?? {};
	const auth = resolvedAuth ?? (await modelRegistry.getApiKeyAndHeaders(model));
	if (!auth.ok) {
		const event = createAdapterFailure(model, undefined);
		if (event.type !== "error") throw new Error(auth.error);
		event.error.errorMessage = auth.error;
		return event.error;
	}
	return streamWithExternalAuthRetry(model, context, requestOptions, modelRegistry, auth).result();
}

/**
 * Retry one structured pre-output 401/403 for an exact external auth source.
 * The helper's credential version stays private and changed access is required.
 */
export function streamWithExternalAuthRetry(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	modelRegistry: ModelRegistry,
	initialAuth: SuccessfulRequestAuth,
): AssistantMessageEventStream {
	if (
		initialAuth.sourceToken?.source === "external" &&
		Object.keys(options.headers ?? {}).some((name) => ["authorization", "x-api-key"].includes(name.toLowerCase()))
	) {
		throw new Error(`Request authentication headers cannot override AIM-managed credentials for "${model.provider}"`);
	}

	const createStream = (auth: SuccessfulRequestAuth) =>
		streamSimple(model, context, {
			...options,
			apiKey: auth.apiKey,
			headers: options.headers || auth.headers ? { ...auth.headers, ...options.headers } : undefined,
		});

	const sourceToken = initialAuth.sourceToken;
	if (sourceToken?.source !== "external") {
		return createStream(initialAuth);
	}

	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			const buffered: AssistantMessageEvent[] = [];
			let sawProviderOutput = false;
			for await (const event of normalizeAttempt(() => createStream(initialAuth), model)) {
				if (event.type === "start" && !sawProviderOutput) {
					buffered.push(event);
					continue;
				}
				if (event.type === "error" && !sawProviderOutput && isStructured401Or403(event.error)) {
					const refreshed = await modelRegistry.retryExternalAuth(model, sourceToken);
					if (!refreshed.ok) {
						event.error.errorMessage = refreshed.error;
						appendRetryDiagnostic(event.error, "unchanged_or_failed");
						output.push(event);
						return;
					}

					for await (const retryEvent of normalizeAttempt(() => createStream(refreshed), model)) {
						if (retryEvent.type === "done") appendRetryDiagnostic(retryEvent.message, "changed");
						if (retryEvent.type === "error") appendRetryDiagnostic(retryEvent.error, "changed");
						output.push(retryEvent);
					}
					output.end();
					return;
				}

				if (!sawProviderOutput) {
					sawProviderOutput = true;
					for (const bufferedEvent of buffered) output.push(bufferedEvent);
					buffered.length = 0;
				}
				output.push(event);
			}
			for (const bufferedEvent of buffered) output.push(bufferedEvent);
			output.end();
		} catch (error) {
			output.push(createAdapterFailure(model, error));
			output.end();
		}
	})();
	return output;
}
