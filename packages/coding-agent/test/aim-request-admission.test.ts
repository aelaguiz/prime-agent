import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	registerFauxProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, AIM_EXTERNAL_CREDENTIAL_PROTOCOL } from "../src/core/aim-external-auth.js";
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

	it("passes the admitted credential identity into normal and side-door stream constructors", async () => {
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
			"openai-codex": {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: [helperPath],
				binding: "codex-bound",
				expectedIdentityFingerprint: "identity-codex",
			} as never,
		});
		authStorage.startAimExternalSession([], () => undefined);

		const faux = registerFauxProvider({ provider: "openai-codex" });
		unregisters.push(() => faux.unregister());
		let observedTransportAuthIdentity: string | undefined;
		faux.setResponses([
			(_context, options) => {
				observedTransportAuthIdentity = (options as SimpleStreamOptions & { transportAuthIdentity?: string })
					.transportAuthIdentity;
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

			observedTransportAuthIdentity = undefined;
			faux.setResponses([
				(_context, options) => {
					observedTransportAuthIdentity = (options as SimpleStreamOptions & { transportAuthIdentity?: string })
						.transportAuthIdentity;
					return fauxAssistantMessage("side-door admitted");
				},
			]);
			await session.modelRegistry.completeSimpleWithRequestAdmission(
				faux.getModel(),
				{ systemPrompt: "side-door", messages: [] },
				{ maxTokens: 8 },
			);
			expect(observedTransportAuthIdentity).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await session.disposeAsync();
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
