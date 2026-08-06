import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, type AuthStorageData, ManagedAuthConflictError } from "../src/core/auth-storage.js";
import {
	initializeExternalCredentialSession,
	inspectExternalCredentialSession,
	snapshotExternalCredentialDescriptors,
	stageExternalCredentialDescriptors,
} from "../src/core/external-auth-session.js";
import type { ExternalCredentialDescriptor } from "../src/core/external-credential-client.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { buildSessionTreeFromFlatNodes } from "../src/modes/agent-connection/daemon-agent-connection.js";
import {
	createAgentConnectionSessionTree,
	createAgentConnectionState,
	sanitizeAgentConnectionSessionTreeFlatNodes,
	sanitizeAgentConnectionSessionTreeLeafId,
} from "../src/modes/agent-connection/snapshot.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const helperFixture = join(testDir, "fixtures", "external-credential-helper.mjs");

interface HelperFiles {
	statePath: string;
	requestLogPath: string;
}

describe("external credential sessions", () => {
	let tempDir: string;
	let helperPath: string;
	let authPath: string;
	let sessionsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-external-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true, mode: 0o700 });
		helperPath = join(tempDir, "fake-helper.mjs");
		authPath = join(tempDir, "auth.json");
		sessionsDir = join(tempDir, "sessions");
		mkdirSync(sessionsDir, { mode: 0o700 });
		copyFileSync(helperFixture, helperPath);
		chmodSync(helperPath, 0o700);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function helperFiles(name: string): HelperFiles {
		const files = {
			statePath: join(tempDir, `${name}-state.json`),
			requestLogPath: join(tempDir, `${name}-requests.jsonl`),
		};
		writeFileSync(files.requestLogPath, "");
		return files;
	}

	function descriptor(binding: string, identityFingerprint: string, files: HelperFiles): ExternalCredentialDescriptor {
		return {
			type: "external",
			source: "aimgr",
			protocol: "aimgr-credential-v1",
			executable: helperPath,
			args: [files.statePath, files.requestLogPath],
			binding,
			expectedIdentityFingerprint: identityFingerprint,
		};
	}

	function writeAuth(value: ExternalCredentialDescriptor): void {
		const data: AuthStorageData = { "openai-codex": value };
		writeFileSync(authPath, JSON.stringify(data));
	}

	function writeSuccess(
		files: HelperFiles,
		binding: string,
		identityFingerprint: string,
		accessToken: string,
		credentialVersion = 1,
	): void {
		writeFileSync(
			files.statePath,
			JSON.stringify({
				responses: [
					{
						schemaVersion: 1,
						ok: true,
						provider: "openai-codex",
						binding,
						identityFingerprint,
						credentialVersion,
						accessToken,
						expiresAt: Date.now() + 10 * 60 * 1000,
					},
				],
			}),
		);
	}

	function readRequests(files: HelperFiles): Array<Record<string, unknown>> {
		const content = readFileSync(files.requestLogPath, "utf8").trim();
		return content ? content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
	}

	it("persists only the exact non-context binding and restores it after restart", async () => {
		const pro3 = helperFiles("pro3");
		writeSuccess(pro3, "pro3", "identity-pro3", "fixture-secret-pro3");
		writeAuth(descriptor("pro3", "identity-pro3", pro3));
		const manager = SessionManager.create(tempDir, sessionsDir);
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, manager);

		expect(manager.getCredentialBindings().has("openai-codex")).toBe(false);
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(await storage.getApiKey("openai-codex")).toBe("fixture-secret-pro3");
		expect(manager.getCredentialBindings().get("openai-codex")?.binding).toBe("pro3");
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const serialized = readFileSync(sessionFile!, "utf8");
		expect(serialized).toContain('"type":"credential_binding"');
		expect(serialized).toContain('"binding":"pro3"');
		expect(serialized).not.toContain("fixture-secret-pro3");

		const globalDefault = helperFiles("global-default");
		writeSuccess(globalDefault, "pro3", "identity-pro3", "fixture-secret-global");
		writeAuth(descriptor("pro4", "identity-pro3", globalDefault));
		const restarted = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(restarted, SessionManager.open(sessionFile!));
		expect(await restarted.getApiKey("openai-codex")).toBe("fixture-secret-global");
		expect(readRequests(globalDefault)[0]).toMatchObject({ binding: "pro3" });
	});

	it("resumes and forks a persisted pro3 binding after the installed default moves to pro4", async () => {
		const files = helperFiles("moved-default");
		writeFileSync(
			files.statePath,
			JSON.stringify({
				responses: [
					{
						schemaVersion: 1,
						ok: true,
						provider: "openai-codex",
						binding: "pro3",
						identityFingerprint: "identity-pro3",
						credentialVersion: 1,
						accessToken: "fixture-resume-pro3",
						expiresAt: Date.now() + 600_000,
					},
					{
						schemaVersion: 1,
						ok: true,
						provider: "openai-codex",
						binding: "pro3",
						identityFingerprint: "identity-pro3",
						credentialVersion: 1,
						accessToken: "fixture-fork-pro3",
						expiresAt: Date.now() + 600_000,
					},
				],
			}),
		);
		writeAuth(descriptor("pro4", "identity-pro4", files));
		const original = SessionManager.create(tempDir, sessionsDir);
		original.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		const codex = getModel("openai-codex", "gpt-5.4");
		const leafId = original.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "root reply" }],
			api: codex.api,
			provider: codex.provider,
			model: codex.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		original.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-pro3",
		});
		const originalFile = original.getSessionFile()!;
		const resumed = SessionManager.open(originalFile, sessionsDir);
		const resumedStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		expect(resumed.getCredentialBindings().get("openai-codex")?.binding).toBe("pro3");
		initializeExternalCredentialSession(resumedStorage, resumed);
		expect(await resumedStorage.getApiKey("openai-codex")).toBe("fixture-resume-pro3");

		const forkFile = original.createBranchedSession(leafId)!;
		const fork = SessionManager.open(forkFile, sessionsDir);
		const forkStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		expect(fork.getCredentialBindings().get("openai-codex")?.binding).toBe("pro3");
		initializeExternalCredentialSession(forkStorage, fork);
		expect(await forkStorage.getApiKey("openai-codex")).toBe("fixture-fork-pro3");
		expect(readRequests(files)).toEqual([
			expect.objectContaining({ binding: "pro3", expectedIdentityFingerprint: "identity-pro3" }),
			expect.objectContaining({ binding: "pro3", expectedIdentityFingerprint: "identity-pro3" }),
		]);
	});

	it("uses installed descriptor authority when a persisted binding keeps the same label", async () => {
		const files = helperFiles("same-label-new-identity");
		writeSuccess(files, "pro3", "identity-new", "fixture-new-identity");
		writeAuth(descriptor("pro3", "identity-new", files));
		const manager = SessionManager.inMemory(tempDir);
		manager.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-old",
		});
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, manager);
		expect(await storage.getApiKey("openai-codex")).toBe("fixture-new-identity");
		expect(readRequests(files)[0]).toMatchObject({ binding: "pro3", expectedIdentityFingerprint: "identity-new" });
	});

	it("lets a descendant inherit the loaded root descriptor before that provider is first resolved", async () => {
		const rootDefault = helperFiles("descendant-root-default");
		writeSuccess(rootDefault, "pro3", "identity-pro3", "fixture-descendant-pro3");
		writeAuth(descriptor("pro3", "identity-pro3", rootDefault));
		const rootStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const rootManager = SessionManager.inMemory(tempDir);
		initializeExternalCredentialSession(rootStorage, rootManager);

		const changedGlobal = helperFiles("descendant-changed-global");
		writeSuccess(changedGlobal, "pro4", "identity-pro4", "fixture-descendant-pro4");
		writeAuth(descriptor("pro4", "identity-pro4", changedGlobal));

		const childStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		stageExternalCredentialDescriptors(childStorage, snapshotExternalCredentialDescriptors(rootStorage));
		const childManager = SessionManager.inMemory(tempDir);
		initializeExternalCredentialSession(childStorage, childManager, (binding) => {
			rootManager.appendCredentialBinding(binding);
		});
		expect(await childStorage.getApiKey("openai-codex")).toBe("fixture-descendant-pro3");
		expect(childManager.getCredentialBindings().get("openai-codex")?.binding).toBe("pro3");
		expect(rootManager.getCredentialBindings().get("openai-codex")?.binding).toBe("pro3");
		expect(readRequests(rootDefault)).toHaveLength(1);
		expect(readRequests(changedGlobal)).toEqual([]);
	});

	it("keeps concurrent roots isolated across a global descriptor update", async () => {
		const pro3 = helperFiles("root-pro3");
		writeSuccess(pro3, "pro3", "identity-pro3", "fixture-root-pro3");
		writeAuth(descriptor("pro3", "identity-pro3", pro3));
		const rootOneStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const rootOneManager = SessionManager.inMemory(tempDir);
		initializeExternalCredentialSession(rootOneStorage, rootOneManager);

		const pro4 = helperFiles("root-pro4");
		writeSuccess(pro4, "pro4", "identity-pro4", "fixture-root-pro4");
		writeAuth(descriptor("pro4", "identity-pro4", pro4));
		rootOneStorage.reload();
		const rootTwoStorage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const rootTwoManager = SessionManager.inMemory(tempDir);
		initializeExternalCredentialSession(rootTwoStorage, rootTwoManager);

		const [rootOneKey, rootTwoKey] = await Promise.all([
			rootOneStorage.getApiKey("openai-codex"),
			rootTwoStorage.getApiKey("openai-codex"),
		]);
		expect(rootOneKey).toBe("fixture-root-pro3");
		expect(rootTwoKey).toBe("fixture-root-pro4");
		expect(readRequests(pro3)[0]).toMatchObject({ binding: "pro3" });
		expect(readRequests(pro4)[0]).toMatchObject({ binding: "pro4" });
	});

	it("fails closed when root-boundary auth reload is malformed", () => {
		writeFileSync(authPath, "{not-json");
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		expect(() => initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir))).toThrow();
		expect(storage.getAuthStatus("openai-codex")).toEqual({ configured: false });
	});

	it("fails closed when persisted and installed binding authorities have different sources", () => {
		const files = helperFiles("source-conflict");
		const installed = { ...descriptor("pro3", "identity-new", files), source: "other-authority" };
		writeAuth(installed);
		const manager = SessionManager.inMemory(tempDir);
		manager.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-old",
		});
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		expect(() => initializeExternalCredentialSession(storage, manager)).toThrow(
			"External credential identity conflicts with this session.",
		);
		expect(readRequests(files)).toEqual([]);
	});

	it("lets UI inspection show the session label without executing the helper", async () => {
		const files = helperFiles("inspection");
		writeSuccess(files, "pro3", "identity-pro3", "fixture-never-resolved");
		writeAuth(descriptor("pro4", "identity-pro3", files));
		const manager = SessionManager.inMemory(tempDir);
		manager.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-pro3",
		});
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		inspectExternalCredentialSession(storage, manager);
		const registry = ModelRegistry.inMemory(storage);
		expect(registry.getProviderAuthStatus("openai-codex")).toEqual({
			configured: true,
			source: "external",
			label: "pro3",
		});
		expect(await registry.getApiKeyForProvider("openai-codex")).toBeUndefined();
		expect(readRequests(files)).toEqual([]);
	});

	it("does not overwrite a concurrent AIM install during native OAuth refresh", async () => {
		const providerId = `oauth-same-${Date.now()}-${Math.random()}`;
		registerOAuthProvider({
			id: providerId,
			name: "OAuth same",
			async login() {
				throw new Error("unused");
			},
			async refreshToken(credentials) {
				return { ...credentials, access: "refreshed", expires: Date.now() + 60_000 };
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});
		writeFileSync(
			authPath,
			JSON.stringify({
				[providerId]: { type: "oauth", refresh: "refresh", access: "expired", expires: Date.now() - 1 },
			}),
		);
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		const files = helperFiles("same-provider-install");
		const installed = descriptor("installed", "identity-installed", files);
		writeFileSync(authPath, JSON.stringify({ [providerId]: installed }));

		await expect(storage.getApiKey(providerId)).rejects.toBeInstanceOf(ManagedAuthConflictError);
		expect(JSON.parse(readFileSync(authPath, "utf8"))[providerId]).toEqual(installed);
	});

	it("merges only the refreshed provider while retaining a concurrent AIM update on disk", async () => {
		const providerId = `oauth-other-${Date.now()}-${Math.random()}`;
		registerOAuthProvider({
			id: providerId,
			name: "OAuth other",
			async login() {
				throw new Error("unused");
			},
			async refreshToken(credentials) {
				return { ...credentials, access: "refreshed", expires: Date.now() + 60_000 };
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});
		const oldFiles = helperFiles("old-other");
		const newFiles = helperFiles("new-other");
		const oldExternal = descriptor("old", "identity-old", oldFiles);
		const newExternal = descriptor("new", "identity-new", newFiles);
		const expired = { type: "oauth", refresh: "refresh", access: "expired", expires: Date.now() - 1 };
		writeFileSync(authPath, JSON.stringify({ [providerId]: expired, "openai-codex": oldExternal }));
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		writeFileSync(authPath, JSON.stringify({ [providerId]: expired, "openai-codex": newExternal }));

		expect(await storage.getApiKey(providerId)).toBe("Bearer refreshed");
		const disk = JSON.parse(readFileSync(authPath, "utf8"));
		expect(disk["openai-codex"]).toEqual(newExternal);
		expect(disk[providerId].access).toBe("refreshed");
		expect(storage.getExternalDescriptor("openai-codex")?.binding).toBe("old");
	});

	it("deep-clones and freezes credentials on ingest and every public read", () => {
		const files = helperFiles("descriptor-copy");
		writeAuth(descriptor("pro3", "identity-pro3", files));
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const first = storage.getExternalDescriptor("openai-codex")!;
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.args)).toBe(true);
		expect(() => first.args.push("mutated")).toThrow();
		expect(() => {
			first.binding = "mutated";
		}).toThrow();
		const second = storage.getExternalDescriptor("openai-codex")!;
		expect(second).not.toBe(first);
		expect(second.binding).toBe("pro3");

		writeFileSync(
			authPath,
			JSON.stringify({
				prime: { type: "api_key", key: "secret", primeTeam: { teamId: "team", name: "Team" } },
			}),
		);
		const nested = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		const credential = nested.get("prime")!;
		const all = nested.getAll();
		expect(Object.isFrozen(credential)).toBe(true);
		expect(Object.isFrozen((credential as { primeTeam: object }).primeTeam)).toBe(true);
		expect(Object.isFrozen(all)).toBe(true);
		expect(Object.isFrozen(all.prime)).toBe(true);
		expect(Object.isFrozen((all.prime as { primeTeam: object }).primeTeam)).toBe(true);
	});

	it("blocks native mutations and ignores native fallback for a managed provider", async () => {
		const files = helperFiles("managed-guards");
		writeSuccess(files, "pro3", "identity-pro3", "fixture-managed-access");
		writeAuth(descriptor("pro3", "identity-pro3", files));
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		storage.setFallbackResolver(() => "fixture-fallback-must-not-win");
		expect(() => storage.setRuntimeApiKey("openai-codex", "fixture-runtime")).toThrow("managed by AIM");
		expect(() => storage.set("openai-codex", { type: "api_key", key: "fixture-native" })).toThrow("managed by AIM");
		expect(() => storage.remove("openai-codex")).toThrow("managed by AIM");
		expect(() => storage.logout("openai-codex")).toThrow("managed by AIM");
		expect(await storage.getApiKey("openai-codex")).toBe("fixture-managed-access");
	});

	it("rejects managed authentication header overrides without exposing their values", async () => {
		const files = helperFiles("managed-header-guard");
		writeSuccess(files, "pro3", "identity-pro3", "fixture-managed-header-access");
		writeAuth(descriptor("pro3", "identity-pro3", files));
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		const registry = ModelRegistry.inMemory(storage);
		const codex = getModel("openai-codex", "gpt-5.4");
		expect(codex).toBeDefined();
		const auth = await registry.getApiKeyAndHeaders({
			...codex!,
			headers: { ...codex!.headers, Authorization: "fixture-override-must-not-escape" },
		});
		expect(auth.ok).toBe(false);
		if (!auth.ok) {
			expect(auth.error).toContain("cannot override AIM-managed credentials");
			expect(auth.error).not.toContain("fixture-override-must-not-escape");
		}
	});

	it("rejects sharing managed runtime state across root sessions", () => {
		const files = helperFiles("shared-root-state");
		writeSuccess(files, "pro3", "identity-pro3", "fixture-shared-root");
		writeAuth(descriptor("pro3", "identity-pro3", files));
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir));
		expect(() => initializeExternalCredentialSession(storage, SessionManager.inMemory(tempDir))).toThrow(
			"cannot be shared across root session runtimes",
		);
	});

	it("rejects mismatched SDK auth owners before session initialization", async () => {
		const first = AuthStorage.inMemory();
		const second = AuthStorage.inMemory();
		await expect(
			createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage: first,
				modelRegistry: ModelRegistry.inMemory(second),
				sessionManager: SessionManager.inMemory(tempDir),
			}),
		).rejects.toThrow("share the same AuthStorage instance");
	});

	it("exposes the pinned account label without exposing its identity fingerprint", () => {
		const manager = SessionManager.inMemory(tempDir);
		manager.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-must-stay-worker-only",
		});
		const session = {
			sessionManager: manager,
			model: undefined,
			thinkingLevel: "medium",
			serviceTier: "auto",
			getAvailableThinkingLevels: () => [],
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			steeringMode: "all",
			followUpMode: "all",
			sessionFile: manager.getSessionFile(),
			sessionId: manager.getSessionId(),
			sessionName: undefined,
			autoCompactionEnabled: true,
			messages: [],
			getSessionActionSnapshot: () => ({ actions: [] }),
			goalState: { status: "idle" },
			scopedModels: [],
			getActiveToolNames: () => [],
			getContextUsage: () => undefined,
		};
		const state = createAgentConnectionState({ session } as any);
		expect(state.credentialBindings).toEqual([{ provider: "openai-codex", source: "aimgr", binding: "pro3" }]);
		expect(JSON.stringify(state)).not.toContain("identity-must-stay-worker-only");
	});

	it("keeps binding fingerprints out of the existing daemon/client session tree shape", () => {
		const manager = SessionManager.inMemory(tempDir);
		manager.appendCredentialBinding({
			provider: "openai-codex",
			source: "aimgr",
			binding: "pro3",
			identityFingerprint: "identity-must-stay-worker-only",
		});
		manager.appendMessage({ role: "user", content: "visible", timestamp: Date.now() });
		const serialized = JSON.stringify(createAgentConnectionSessionTree(manager.getTree()));
		expect(serialized).toContain("visible");
		expect(serialized).not.toContain("credential_binding");
		expect(serialized).not.toContain("identity-must-stay-worker-only");
	});

	it("canonically relinks old and new daemon tree payloads around raw binding entries", () => {
		const raw = [
			{
				entry: {
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "2026-01-01",
					message: { role: "user", content: "root", timestamp: 1 },
				},
			},
			{
				entry: {
					type: "credential_binding",
					id: "binding",
					parentId: "root",
					timestamp: "2026-01-02",
					provider: "openai-codex",
					source: "aimgr",
					binding: "pro3",
					identityFingerprint: "private",
				},
			},
			{
				entry: {
					type: "message",
					id: "child",
					parentId: "binding",
					timestamp: "2026-01-03",
					message: {
						role: "assistant",
						content: [],
						api: "faux",
						provider: "faux",
						model: "faux",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				},
			},
		] as any;
		const sanitized = sanitizeAgentConnectionSessionTreeFlatNodes(raw);
		expect(sanitized.map((node) => node.entry.id)).toEqual(["root", "child"]);
		expect(sanitized[1]!.entry.parentId).toBe("root");
		expect(sanitizeAgentConnectionSessionTreeLeafId("binding", raw)).toBe("root");
		const oldDaemonTree = buildSessionTreeFromFlatNodes(raw);
		const newDaemonTree = buildSessionTreeFromFlatNodes(sanitized);
		expect(oldDaemonTree).toEqual(newDaemonTree);
		expect(JSON.stringify(oldDaemonTree)).not.toContain("credential_binding");
		expect(JSON.stringify(oldDaemonTree)).not.toContain("private");
	});

	it("keeps bindings outside context and preserves them when forking before the original entry", () => {
		const manager = SessionManager.inMemory(tempDir);
		const firstMessageId = manager.appendMessage({ role: "user", content: "before binding", timestamp: Date.now() });
		manager.appendCredentialBinding({
			provider: "anthropic",
			source: "aimgr",
			binding: "fable",
			identityFingerprint: "identity-fable",
		});
		expect(manager.getLeafId()).toBe(firstMessageId);
		expect(manager.buildSessionContext().messages).toHaveLength(1);
		manager.createBranchedSession(firstMessageId);
		expect(manager.getCredentialBindings().get("anthropic")?.binding).toBe("fable");
		expect(manager.getLeafId()).toBe(firstMessageId);
		expect(manager.buildSessionContext().messages).toHaveLength(1);
	});
});
