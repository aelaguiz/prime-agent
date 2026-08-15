import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AIM_CREDENTIAL_BINDING_CUSTOM_TYPE,
	AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
	getAimAdmittedProviderMaxRetries,
} from "../src/core/aim-external-auth.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AIM provider request admission", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		while (unregisters.length > 0) unregisters.pop()?.();
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	it("preserves configured retries outside AIM-admitted Anthropic requests", () => {
		const admission = { transportAuthIdentity: "identity" };
		expect(getAimAdmittedProviderMaxRetries("anthropic", undefined, 2)).toBe(2);
		expect(getAimAdmittedProviderMaxRetries("openai-codex", admission, 2)).toBe(2);
		expect(getAimAdmittedProviderMaxRetries("anthropic", admission, 2)).toBe(0);
	});

	it("disables hidden SDK retries for AIM-admitted Anthropic normal and side-door requests", async () => {
		const tempDir = join(tmpdir(), `pi-aim-admission-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const trustedHelperDir = join(
			process.cwd(),
			`.aim-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(trustedHelperDir, { mode: 0o700 });
		cleanupPaths.push(tempDir, trustedHelperDir);

		const helperPath = join(tempDir, "resolve-helper.mjs");
		const helperExecutable = join(trustedHelperDir, "resolve-credential");
		writeFileSync(
			helperExecutable,
			`#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"')}" "$@"\n`,
			{
				mode: 0o700,
			},
		);
		writeFileSync(
			helperPath,
			`let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.binding,
  identityFingerprint: request.expectedIdentityFingerprint,
  credentialVersion: 1,
  accessToken: "admitted-secret",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
		);
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "claude-bound",
				expectedIdentityFingerprint: "identity-claude",
			} as never,
		});
		authStorage.startAimExternalSession([], () => undefined);

		const faux = registerFauxProvider({ provider: "anthropic" });
		unregisters.push(() => faux.unregister());
		let observedTransportAuthIdentity: string | undefined;
		let observedMaxRetries: number | undefined;
		faux.setResponses([
			(_context, options) => {
				observedTransportAuthIdentity = (options as SimpleStreamOptions & { transportAuthIdentity?: string })
					.transportAuthIdentity;
				observedMaxRetries = options?.maxRetries;
				return fauxAssistantMessage("admitted");
			},
		]);

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			noTools: "all",
		});
		try {
			await session.prompt("hello");
			expect(observedTransportAuthIdentity).toMatch(/^[a-f0-9]{64}$/);
			expect(observedMaxRetries).toBe(0);

			observedTransportAuthIdentity = undefined;
			observedMaxRetries = undefined;
			faux.setResponses([
				(_context, options) => {
					observedTransportAuthIdentity = (options as SimpleStreamOptions & { transportAuthIdentity?: string })
						.transportAuthIdentity;
					observedMaxRetries = options?.maxRetries;
					return fauxAssistantMessage("side-door admitted");
				},
			]);
			await session.modelRegistry.completeSimpleWithRequestAdmission(
				faux.getModel(),
				{ systemPrompt: "side-door", messages: [] },
				{ maxTokens: 8 },
			);
			expect(observedTransportAuthIdentity).toMatch(/^[a-f0-9]{64}$/);
			expect(observedMaxRetries).toBe(0);
		} finally {
			await session.disposeAsync();
		}
	});

	it("starts a fresh Codex continuation after a same-session AIM credential handoff", async () => {
		const tempDir = join(tmpdir(), `pi-aim-codex-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const trustedHelperDir = join(
			process.cwd(),
			`.aim-helper-codex-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(trustedHelperDir, { mode: 0o700 });
		cleanupPaths.push(tempDir, trustedHelperDir);

		const helperPath = join(tempDir, "resolve-helper.mjs");
		const helperExecutable = join(trustedHelperDir, "resolve-credential");
		writeFileSync(
			helperExecutable,
			`#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"')}" "$@"\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			helperPath,
			`let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const payload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: request.binding },
})).toString("base64url");
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.binding,
  identityFingerprint: request.expectedIdentityFingerprint,
  credentialVersion: request.binding === "codex-a" ? 1 : 2,
  accessToken: "aaa." + payload + ".bbb",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
		);

		const connectedAccounts: string[] = [];
		const sentBodies: Array<Record<string, unknown>> = [];
		let connectionCount = 0;
		class GenerationWebSocket {
			static OPEN = 1;
			readonly connectionNumber = ++connectionCount;
			readyState = GenerationWebSocket.OPEN;
			private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
				if (protocols && typeof protocols === "object" && !Array.isArray(protocols)) {
					connectedAccounts.push(protocols.headers?.["chatgpt-account-id"] ?? "");
				}
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data) as Record<string, unknown>);
				const suffix = String(this.connectionNumber);
				const events = [
					{ type: "response.created", response: { id: `resp_${suffix}` } },
					{
						type: "response.output_item.added",
						item: { type: "message", id: `msg_${suffix}`, role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: `reply-${suffix}` },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: `msg_${suffix}`,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: `reply-${suffix}` }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: `resp_${suffix}`,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = GenerationWebSocket as unknown as typeof WebSocket;
		const authStorage = AuthStorage.inMemory({
			"openai-codex": {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "codex-a",
				expectedIdentityFingerprint: "identity-a",
			} as never,
		});
		authStorage.startAimExternalSession([], () => undefined);
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		};
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setTransport("websocket-cached");
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir: tempDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			model,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			noTools: "all",
		});
		try {
			await session.prompt("first");
			await authStorage.handoffAimCredential("openai-codex", "codex-b", "identity-b", () => undefined);
			await session.prompt("second");

			expect(connectionCount).toBe(2);
			expect(connectedAccounts).toEqual(["codex-a", "codex-b"]);
			expect(sentBodies).toHaveLength(2);
			expect(sentBodies[1]?.previous_response_id).toBeUndefined();
		} finally {
			await session.disposeAsync();
			globalThis.WebSocket = originalWebSocket;
		}
	});

	it("recovers a pinned AIM binding after global provider auth changes", async () => {
		const tempDir = join(tmpdir(), `pi-aim-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const trustedHelperDir = join(
			process.cwd(),
			`.aim-helper-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(trustedHelperDir, { mode: 0o700 });
		cleanupPaths.push(tempDir, trustedHelperDir);

		const helperPath = join(tempDir, "restart-helper.mjs");
		const helperExecutable = join(trustedHelperDir, "resolve-credential");
		writeFileSync(
			helperExecutable,
			`#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"')}" "$@"\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			helperPath,
			`let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.binding,
  identityFingerprint: request.expectedIdentityFingerprint,
  credentialVersion: 1,
  accessToken: "session-secret",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
		);

		const persistedEntries: unknown[] = [];
		const initial = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "cfo",
				expectedIdentityFingerprint: "identity-cfo",
			} as never,
		});
		initial.startAimExternalSession([], (binding) => {
			persistedEntries.push({
				type: "custom",
				customType: AIM_CREDENTIAL_BINDING_CUSTOM_TYPE,
				data: binding,
			});
		});
		expect(await initial.getApiKey("anthropic")).toBe("session-secret");
		expect(persistedEntries).toHaveLength(1);

		// A daemon restart must use the session's durable AIM route even if a
		// different terminal removed or replaced the global provider entry.
		const restarted = AuthStorage.inMemory({});
		restarted.startAimExternalSession(persistedEntries, () => undefined);
		expect(restarted.getAimCredentialBinding("anthropic")).toMatchObject({
			binding: "cfo",
			identityFingerprint: "identity-cfo",
		});
		expect(restarted.getAimExecutable("anthropic")).toBe(helperExecutable);
		expect(await restarted.getApiKey("anthropic")).toBe("session-secret");
	});

	it("advances and retries once for an exact unopened Codex usage exhaustion", async () => {
		const tempDir = join(tmpdir(), `pi-aim-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const trustedHelperDir = join(
			process.cwd(),
			`.aim-helper-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(trustedHelperDir, { mode: 0o700 });
		cleanupPaths.push(tempDir, trustedHelperDir);

		const requestLog = join(tempDir, "requests.jsonl");
		const helperPath = join(tempDir, "advance-helper.mjs");
		const helperExecutable = join(trustedHelperDir, "resolve-credential");
		writeFileSync(
			helperExecutable,
			`#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"')}" "$@"\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			helperPath,
			`import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
const advanced = request.operation === "advance";
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: advanced ? "codex-next" : request.binding,
  identityFingerprint: advanced ? "identity-next" : request.expectedIdentityFingerprint,
  credentialVersion: advanced ? 2 : 1,
  accessToken: advanced ? "next-secret" : "first-secret",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
		);

		const persisted: string[] = [];
		const authStorage = AuthStorage.inMemory({
			"openai-codex": {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "codex-first",
				expectedIdentityFingerprint: "identity-first",
			} as never,
		});
		authStorage.startAimExternalSession([], (binding) => persisted.push(binding.binding));

		const faux = registerFauxProvider({ provider: "openai-codex" });
		unregisters.push(() => faux.unregister());
		const exhausted: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider rate limit exceeded" }),
			content: [],
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind: "rate_limit", providerErrorType: "usage_limit_reached", status: 429 },
				},
			],
		};
		const observedApiKeys: Array<string | undefined> = [];
		faux.setResponses([
			(_context, options) => {
				observedApiKeys.push(options?.apiKey);
				return exhausted;
			},
			(_context, options) => {
				observedApiKeys.push(options?.apiKey);
				return fauxAssistantMessage("recovered");
			},
		]);

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			noTools: "all",
		});
		try {
			await session.prompt("hello");
			const final = session.messages.at(-1);
			expect(final).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(final?.role === "assistant" ? final.content : []).toContainEqual({ type: "text", text: "recovered" });
			expect(final?.role === "assistant" ? final.diagnostics : []).toContainEqual(
				expect.objectContaining({
					type: "aim_credential_failover",
					details: { fromBinding: "codex-first", toBinding: "codex-next" },
				}),
			);
			expect(observedApiKeys).toEqual(["first-secret", "next-secret"]);
			expect(persisted).toEqual(["codex-first", "codex-next"]);
			expect(
				readFileSync(requestLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).operation),
			).toEqual(["resolve", "advance"]);
		} finally {
			await session.disposeAsync();
		}
	});

	it("refuses unsafe retries and stops after one exact cross-binding retry", async () => {
		const tempDir = join(tmpdir(), `pi-aim-refusal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const trustedHelperDir = join(
			process.cwd(),
			`.aim-helper-refusal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(trustedHelperDir, { mode: 0o700 });
		cleanupPaths.push(tempDir, trustedHelperDir);

		const requestLog = join(tempDir, "requests.jsonl");
		const helperPath = join(tempDir, "refusal-helper.mjs");
		const helperExecutable = join(trustedHelperDir, "resolve-credential");
		writeFileSync(
			helperExecutable,
			`#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/").replace(/"/g, '\\"')}" "$@"\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			helperPath,
			`import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.operation === "advance" ? "unexpected-next" : request.binding,
  identityFingerprint: request.operation === "advance" ? "unexpected-identity" : request.expectedIdentityFingerprint,
  credentialVersion: 1,
  accessToken: "first-secret",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
		);

		const authStorage = AuthStorage.inMemory({
			"openai-codex": {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "codex-first",
				expectedIdentityFingerprint: "identity-first",
			} as never,
		});
		authStorage.startAimExternalSession([], () => undefined);

		const faux = registerFauxProvider({ provider: "openai-codex" });
		unregisters.push(() => faux.unregister());
		const generic429: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider rate limit exceeded" }),
			content: [],
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind: "rate_limit", providerErrorType: "rate_limit_exceeded", status: 429 },
				},
			],
		};
		const afterOutput: AssistantMessage = {
			...fauxAssistantMessage("partial", {
				stopReason: "error",
				errorMessage: "Provider rate limit exceeded",
			}),
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind: "rate_limit", providerErrorType: "usage_limit_reached", status: 429 },
				},
			],
		};
		const unopenedExact: AssistantMessage = {
			...generic429,
			diagnostics: [
				{
					type: "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind: "rate_limit", providerErrorType: "usage_limit_reached", status: 429 },
				},
			],
		};
		faux.setResponses([generic429, afterOutput, unopenedExact, unopenedExact]);

		const settingsManager = SettingsManager.inMemory();
		settingsManager.setRetryEnabled(false);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir: tempDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			noTools: "all",
		});
		try {
			await session.prompt("generic");
			await session.prompt("after output");
			expect(
				readFileSync(requestLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).operation),
			).toEqual(["resolve"]);
			settingsManager.setRetryEnabled(true);
			await session.prompt("one exact retry");
			expect(
				readFileSync(requestLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).operation),
			).toEqual(["resolve", "advance"]);
			expect(faux.state.callCount).toBe(4);
		} finally {
			await session.disposeAsync();
		}
	});
});
