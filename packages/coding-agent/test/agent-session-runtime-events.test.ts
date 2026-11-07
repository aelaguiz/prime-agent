import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AIM_CREDENTIAL_BINDING_CUSTOM_TYPE } from "../src/core/aim-external-auth.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionFactory } from "../src/index.js";

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.unstubAllEnvs();
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("releases a replacement lease when current-session teardown fails", async () => {
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		vi.stubEnv(SESSION_LEASE_OWNER_ID_ENV, "runtime-events");
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		runtimeHost.setBeforeSessionInvalidate(() => {
			throw new Error("teardown failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("teardown failed");
		runtimeHost.setBeforeSessionInvalidate(undefined);
		const leaseRoot = join(runtimeHost.services.agentDir, "session-leases");
		expect(readdirSync(leaseRoot).filter((entry) => entry.endsWith(".lock"))).toHaveLength(1);
	});

	describe("AIM credential handoff", () => {
		const request = {
			provider: "anthropic",
			expectedModel: "claude-test",
			expectedBinding: "session-bound",
			expectedIdentityFingerprint: "identity-session",
			requestedBinding: "handoff-bound",
			requestedIdentityFingerprint: "identity-handoff",
		} as const;

		function createAimHandoffRuntime(options: { busy?: boolean; binding?: string } = {}) {
			const phases: string[] = [];
			let currentBinding: {
				provider: "anthropic";
				source: "aimgr";
				binding: string;
				identityFingerprint: string;
			} = {
				provider: "anthropic" as const,
				source: "aimgr" as const,
				binding: options.binding ?? request.expectedBinding,
				identityFingerprint: request.expectedIdentityFingerprint,
			};
			const release = vi.fn(() => phases.push("release"));
			const sessionManager = {
				appendCustomEntryWithRollback: vi.fn(() => {
					phases.push("append");
					phases.push("flush");
					return "binding-entry";
				}),
			};
			const authStorage = {
				getAimCredentialBinding: vi.fn(() => currentBinding),
				prepareAimCredentialHandoff: vi.fn(
					async (provider: string, binding: string, identityFingerprint: string) => {
						phases.push("prepare");
						return {
							provider,
							source: "aimgr",
							binding,
							identityFingerprint,
							credentialVersion: 8,
							accessToken: "prepared-secret",
							expiresAt: Date.now() + 60 * 60 * 1000,
						};
					},
				),
				commitAimCredentialHandoff: vi.fn(
					(resolved: { provider: "anthropic"; binding: string; identityFingerprint: string }) => {
						phases.push("commit");
						currentBinding = {
							provider: resolved.provider,
							source: "aimgr",
							binding: resolved.binding,
							identityFingerprint: resolved.identityFingerprint,
						};
					},
				),
			};
			const session = {
				setSubagentRuntimeHost: vi.fn(),
				acquireQueuedWorkPause: vi.fn(() => {
					phases.push("pause");
					return { release };
				}),
				model: { provider: "anthropic", id: request.expectedModel },
				isSessionActive: options.busy ?? false,
				hasRunningRlmChildren: vi.fn(() => false),
				sessionManager,
				sessionId: "session-identity",
			};
			const services = { authStorage };
			const runtime = new AgentSessionRuntime(session as never, services as never, vi.fn() as never);

			return { runtime, session, services, sessionManager, authStorage, phases };
		}

		it.each([
			["busy", { busy: true }, "Session tree must be completely idle"],
			["stale", { binding: "stale-binding" }, "Session credential binding changed"],
		] as const)("rejects a %s session before resolving or persisting", async (_name, options, message) => {
			const { runtime, authStorage, sessionManager, phases } = createAimHandoffRuntime(options);

			await expect(runtime.handoffAimCredential(request, () => [runtime])).rejects.toThrow(message);

			expect(authStorage.prepareAimCredentialHandoff).not.toHaveBeenCalled();
			expect(sessionManager.appendCustomEntryWithRollback).not.toHaveBeenCalled();
			expect(authStorage.commitAimCredentialHandoff).not.toHaveBeenCalled();
			expect(phases).toEqual(["pause", "release"]);
		});

		it("keeps runtime identity and durably appends the idle handoff before publishing it in memory", async () => {
			const { runtime, session, services, sessionManager, authStorage, phases } = createAimHandoffRuntime();
			await runtime.handoffAimCredential(request, () => [runtime]);
			expect(runtime.session).toBe(session);
			expect(runtime.services).toBe(services);
			expect(sessionManager.appendCustomEntryWithRollback).toHaveBeenCalledWith(AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, {
				provider: "anthropic",
				source: "aimgr",
				binding: "handoff-bound",
				identityFingerprint: "identity-handoff",
			});
			expect(JSON.stringify(sessionManager.appendCustomEntryWithRollback.mock.calls)).not.toContain(
				"prepared-secret",
			);
			expect(phases).toEqual(["pause", "prepare", "append", "flush", "commit", "release"]);
			expect(authStorage.getAimCredentialBinding()).toMatchObject({ binding: "handoff-bound" });
		});

		it("does not publish the prepared credential when the durable flush fails", async () => {
			const { runtime, sessionManager, authStorage, phases } = createAimHandoffRuntime();
			sessionManager.appendCustomEntryWithRollback.mockImplementation(() => {
				phases.push("append");
				phases.push("flush");
				throw new Error("durable write failed");
			});

			await expect(runtime.handoffAimCredential(request, () => [runtime])).rejects.toThrow("durable write failed");

			expect(authStorage.commitAimCredentialHandoff).not.toHaveBeenCalled();
			expect(authStorage.getAimCredentialBinding()).toMatchObject({ binding: "session-bound" });
			expect(phases).toEqual(["pause", "prepare", "append", "flush", "release"]);
		});
	});
});
