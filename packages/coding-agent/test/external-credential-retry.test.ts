import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type Model,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthStorageData } from "../src/core/auth-storage.js";
import { completeSimpleWithExternalAuthRetry, streamWithExternalAuthRetry } from "../src/core/external-auth-retry.js";
import { initializeExternalCredentialSession } from "../src/core/external-auth-session.js";
import {
	type ExternalCredentialDescriptor,
	fingerprintCredentialValue,
} from "../src/core/external-credential-client.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const helperFixture = join(testDir, "fixtures", "external-credential-helper.mjs");
const originalFetch = global.fetch;

function codexToken(suffix: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
		"utf8",
	).toString("base64url");
	return `fixture.${payload}.${suffix}`;
}

function codexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_fixture",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "response_fixture",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					total_tokens: 7,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
}

describe("external credential authentication retry", () => {
	let tempDir: string;
	let helperPath: string;
	let statePath: string;
	let requestLogPath: string;
	let authPath: string;
	let descriptor: ExternalCredentialDescriptor;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-external-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true, mode: 0o700 });
		helperPath = join(tempDir, "fake-helper.mjs");
		statePath = join(tempDir, "state.json");
		requestLogPath = join(tempDir, "requests.jsonl");
		authPath = join(tempDir, "auth.json");
		copyFileSync(helperFixture, helperPath);
		chmodSync(helperPath, 0o700);
		writeFileSync(requestLogPath, "");
		descriptor = {
			type: "external",
			source: "aimgr",
			protocol: "aimgr-credential-v1",
			executable: helperPath,
			args: [statePath, requestLogPath],
			binding: "pro3",
			expectedIdentityFingerprint: "identity-pro3",
		};
		const data: AuthStorageData = { "openai-codex": descriptor };
		writeFileSync(authPath, JSON.stringify(data));
	});

	afterEach(() => {
		global.fetch = originalFetch;
		unregisterApiProviders("external-retry-adapter-test");
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function helperSuccess(accessToken: string, credentialVersion: number): Record<string, unknown> {
		return {
			schemaVersion: 1,
			ok: true,
			provider: "openai-codex",
			binding: "pro3",
			identityFingerprint: "identity-pro3",
			credentialVersion,
			accessToken,
			expiresAt: Date.now() + 10 * 60 * 1000,
		};
	}

	function writeHelperResponses(responses: Array<Record<string, unknown>>): void {
		writeFileSync(statePath, JSON.stringify({ responses }));
	}

	function readHelperRequests(): Array<Record<string, unknown>> {
		const content = readFileSync(requestLogPath, "utf8").trim();
		return content ? content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
	}

	function model(): Model<"openai-codex-responses"> {
		return {
			...getModel("openai-codex", "gpt-5.4"),
			baseUrl: "https://provider.fixture",
		};
	}

	async function requestAuth(selectedModel: Model<Api>) {
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		const registry = ModelRegistry.inMemory(storage);
		const auth = await registry.getApiKeyAndHeaders(selectedModel);
		if (!auth.ok) throw new Error(auth.error);
		return { registry, auth };
	}

	it("resolves rotating command-backed key and headers exactly once per completion request", async () => {
		const adapterApi = "external-retry-adapter" as Api;
		const adapterStream = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = {
					role: "assistant" as const,
					content: [],
					api: adapterApi,
					provider: "rotating",
					model: "rotating-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error" as const,
					errorMessage: "fixture terminal",
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: message });
				stream.end(message);
			});
			return stream;
		};
		registerApiProvider(
			{ api: adapterApi, stream: adapterStream, streamSimple: adapterStream },
			"external-retry-adapter-test",
		);
		const keyCounter = join(tempDir, "key-counter");
		const headerCounter = join(tempDir, "header-counter");
		writeFileSync(keyCounter, "0");
		writeFileSync(headerCounter, "0");
		const rotatingCommand = (path: string, prefix: string) =>
			`!sh -c 'count=$(cat "${path}"); count=$((count + 1)); echo "$count" > "${path}"; echo "${prefix}-$count"'`;
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					rotating: {
						baseUrl: "https://provider.fixture",
						api: adapterApi,
						apiKey: rotatingCommand(keyCounter, "key"),
						headers: { "x-rotating-header": rotatingCommand(headerCounter, "header") },
						models: [
							{
								id: "rotating-model",
								name: "Rotating",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		const selectedModel = registry.getAll().find((candidate) => candidate.provider === "rotating")!;
		const auth = await registry.getApiKeyAndHeaders(selectedModel);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth).toMatchObject({ apiKey: "key-1", headers: { "x-rotating-header": "header-1" } });

		await completeSimpleWithExternalAuthRetry(
			selectedModel,
			{ messages: [{ role: "user", content: "single resolution", timestamp: Date.now() }] },
			{},
			registry,
			auth,
		);
		expect(readFileSync(keyCounter, "utf8").trim()).toBe("1");
		expect(readFileSync(headerCounter, "utf8").trim()).toBe("1");
	});

	it("reacquires and retries exactly once when the access fingerprint changes", async () => {
		const rejectedToken = codexToken("rejected");
		const acceptedToken = codexToken("accepted");
		writeHelperResponses([helperSuccess(rejectedToken, 41), helperSuccess(acceptedToken, 42)]);
		let providerCalls = 0;
		global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			providerCalls++;
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			if (providerCalls === 1) {
				expect(headers.get("Authorization")).toBe(`Bearer ${rejectedToken}`);
				return new Response(JSON.stringify({ error: { message: "credential rejected" } }), { status: 401 });
			}
			expect(headers.get("Authorization")).toBe(`Bearer ${acceptedToken}`);
			return new Response(codexSse("credential retry succeeded"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;

		const selectedModel = model();
		const { registry, auth } = await requestAuth(selectedModel);
		const context: Context = {
			messages: [{ role: "user", content: "exercise external auth", timestamp: Date.now() }],
		};
		const message = await streamWithExternalAuthRetry(
			selectedModel,
			context,
			{ transport: "sse", maxRetries: 0 },
			registry,
			auth,
		).result();
		expect(message.stopReason).toBe("stop");
		expect(message.diagnostics).toContainEqual(
			expect.objectContaining({ type: "external_auth_retry", details: { outcome: "changed" } }),
		);
		expect(providerCalls).toBe(2);
		expect(readHelperRequests()[1]).toMatchObject({ rejectedCredentialVersion: 41 });
	});

	it("does not retry when only credentialVersion changes", async () => {
		const unchangedToken = codexToken("unchanged");
		writeHelperResponses([helperSuccess(unchangedToken, 11), helperSuccess(unchangedToken, 12)]);
		let providerCalls = 0;
		global.fetch = vi.fn(async () => {
			providerCalls++;
			return new Response(JSON.stringify({ error: { message: "credential rejected" } }), { status: 403 });
		}) as typeof fetch;

		const selectedModel = model();
		const { registry, auth } = await requestAuth(selectedModel);
		const message = await streamWithExternalAuthRetry(
			selectedModel,
			{ messages: [{ role: "user", content: "reject unchanged auth", timestamp: Date.now() }] },
			{ transport: "sse", maxRetries: 0 },
			registry,
			auth,
		).result();
		expect(providerCalls).toBe(1);
		expect(readHelperRequests()).toHaveLength(2);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("External credential did not change after authentication rejection.");
		expect(message.diagnostics).toContainEqual(
			expect.objectContaining({ type: "external_auth_retry", details: { outcome: "unchanged_or_failed" } }),
		);
	});

	it("retries a thrown numeric auth failure and terminates a premature retry stream", async () => {
		const firstToken = codexToken("adapter-first");
		const secondToken = codexToken("adapter-second");
		writeHelperResponses([helperSuccess(firstToken, 31), helperSuccess(secondToken, 32)]);
		const adapterApi = "external-retry-adapter" as Api;
		let providerCalls = 0;
		const adapterStream = () => {
			providerCalls++;
			if (providerCalls === 1) {
				throw Object.assign(new Error("rate limit wording must not hide numeric auth"), { status: 401 });
			}
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		registerApiProvider(
			{ api: adapterApi, stream: adapterStream, streamSimple: adapterStream },
			"external-retry-adapter-test",
		);
		const selectedModel = { ...model(), api: adapterApi } as Model<Api>;
		const { registry, auth } = await requestAuth(selectedModel);
		const message = await streamWithExternalAuthRetry(
			selectedModel,
			{ messages: [{ role: "user", content: "adapter guards", timestamp: Date.now() }] },
			{},
			registry,
			auth,
		).result();
		expect(providerCalls).toBe(2);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider stream ended without a terminal event");
		expect(message.diagnostics).toContainEqual(
			expect.objectContaining({ type: "external_auth_retry", details: { outcome: "changed" } }),
		);
	});

	it("emits the existing terminal auth_stale shape for the final rejected value without persisting fingerprints", async () => {
		const firstToken = codexToken("terminal-first");
		const secondToken = codexToken("terminal-second");
		writeHelperResponses([helperSuccess(firstToken, 21), helperSuccess(secondToken, 22)]);
		let providerCalls = 0;
		global.fetch = vi.fn(async () => {
			providerCalls++;
			return new Response(JSON.stringify({ error: { message: "credential rejected" } }), { status: 401 });
		}) as typeof fetch;
		const events: Array<Record<string, unknown>> = [];
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const manager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage: storage,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }),
			sessionManager: manager,
			model: model(),
			noTools: "all",
		});
		const unsubscribe = session.subscribe((event) => events.push(event as unknown as Record<string, unknown>));
		try {
			await session.prompt("terminal managed auth rejection");
		} finally {
			unsubscribe();
			await session.disposeAsync();
		}

		expect(providerCalls).toBe(2);
		expect(readHelperRequests()).toHaveLength(2);
		const stale = events.find((event) => event.type === "auth_stale");
		expect(stale).toMatchObject({
			type: "auth_stale",
			provider: "openai-codex",
			sourceTokens: [
				expect.objectContaining({
					provider: "openai-codex",
					source: "external",
					valueFingerprint: fingerprintCredentialValue(secondToken),
				}),
			],
		});
		expect(JSON.stringify(stale)).not.toContain("credentialVersion");
		const persisted = JSON.stringify(manager.getEntries());
		expect(persisted).not.toContain("valueFingerprint");
		expect(persisted).not.toContain("credentialVersion");
		expect(persisted).not.toContain(firstToken);
		expect(persisted).not.toContain(secondToken);
	});
});
