import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, AIM_EXTERNAL_CREDENTIAL_PROTOCOL } from "../src/core/aim-external-auth.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearConfigValueCache } from "../src/core/resolve-config-value.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;
	let trustedHelperDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (trustedHelperDir && existsSync(trustedHelperDir)) {
			rmSync(trustedHelperDir, { recursive: true, force: true });
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("prime inference falls back to Prime CLI config when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime cli config changes are picked up without reload", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
		});

		test("prime inference marks current Prime CLI auth stale", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.markAuthStale("prime-inference")).toBe(true);

			expect(authStorage.hasAuth("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
		});

		test("changed Prime CLI key no longer matches stale auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		test("prime inference uses Prime CLI auth over stored auth", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime inference uses environment auth over Prime CLI and stored auth", async () => {
			const originalPrimeApiKey = process.env.PRIME_API_KEY;
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_API_KEY = "env-prime-key";
			delete process.env.PRIME_TEAM_ID;
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(
					primeConfigPath,
					JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team", team_name: "CLI Research" }),
				);
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: { teamId: "stored-team", name: "Stored Research" },
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("env-prime-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "environment",
					label: "PRIME_API_KEY",
				});
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeApiKey === undefined) {
					delete process.env.PRIME_API_KEY;
				} else {
					process.env.PRIME_API_KEY = originalPrimeApiKey;
				}
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference provider headers use selected Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "cli-team",
					team_name: "CLI Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
			expect(authStorage.getPrimeInferenceTeamSelection()).toEqual({
				teamId: "cli-team",
				name: "CLI Research",
				role: "admin",
			});
		});

		test("prime inference legacy personal selection suppresses Prime CLI team fallback without Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference legacy personal selection suppresses Prime CLI team with Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference environment team overrides legacy personal selection", () => {
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_TEAM_ID = "env-team";
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: null,
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference missing Agent team selection falls back to Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
		});

		test("prime inference provider header changes are picked up without reload", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-1" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-2" }));
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-2" });
		});

		test("setPrimeInferenceApiKey creates Prime CLI config", async () => {
			const primeConfigPath = join(tempDir, "prime", "config.json");
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(statSync(primeConfigPath).mode & 0o777).toBe(0o600);
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI team selection", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "old-prime-key",
					team_id: "old-team",
					team_name: "Old Team",
					team_role: "admin",
				}),
			);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(config.team_role).toBeUndefined();
		});

		test("setPrimeInferenceApiKey preserves Prime CLI team selection for the same key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey migrates legacy team selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("setPrimeInferenceApiKey migrates legacy personal selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
		});

		test("setPrimeInferenceApiKey removes legacy Prime Agent credential after Prime CLI save", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const agentAuth = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(agentAuth["prime-inference"]).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey throws when Prime CLI config cannot be written", () => {
			const primeConfigPath = join(tempDir, "prime-config-dir");
			mkdirSync(primeConfigPath);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(() => authStorage.setPrimeInferenceApiKey("new-prime-key")).toThrow();
			expect(authStorage.drainErrors()).toHaveLength(1);
		});

		test("setPrimeInferenceApiKey preserves team selection when Prime CLI config is disabled", () => {
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.get("prime-inference")).toEqual({
				type: "api_key",
				key: "new-prime-key",
				primeTeam: { teamId: "team-1", name: "Research" },
			});
		});

		test("logout clears Prime CLI credentials when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.logout("prime-inference");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBeUndefined();
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
		});

		test("setPrimeInferenceTeamSelection writes Prime CLI config", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceTeamSelection({ teamId: "team-1", name: "Research", role: "admin" });

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("AIM external credentials", () => {
		test("finds only a unique installed AIM executable when the session provider descriptor is absent", () => {
			const helperExecutable = join(tempDir, "aim-helper");
			const descriptor = {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: helperExecutable,
				args: ["credential-helper"],
				binding: "codex-account",
				expectedIdentityFingerprint: "identity-codex",
			};
			writeAuthJson({
				"openai-codex": descriptor,
				anthropic: { type: "oauth", access: "native", refresh: "native", expires: Date.now() + 60_000 },
			});

			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.getAimExecutable("anthropic")).toBeUndefined();
			expect(authStorage.getAimExecutable()).toBe(helperExecutable);

			writeAuthJson({
				"openai-codex": descriptor,
				anthropic: {
					...descriptor,
					executable: join(tempDir, "different-aim-helper"),
					binding: "claude-account",
					expectedIdentityFingerprint: "identity-claude",
				},
			});
			const conflictingAuthStorage = AuthStorage.create(authJsonPath);
			expect(conflictingAuthStorage.getAimExecutable()).toBeUndefined();
		});

		test("rechecks stale resolution, coalesces handoff, and lets an admitted generation finish", async () => {
			const helperPath = join(tempDir, "generation-helper.mjs");
			const requestLogPath = join(tempDir, "generation-requests.jsonl");
			trustedHelperDir = join(
				process.cwd(),
				`.aim-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(trustedHelperDir, { mode: 0o700 });
			const helperExecutable = join(trustedHelperDir, "resolve-credential");
			writeFileSync(helperExecutable, `#!/bin/sh\nexec "${toShPath(process.execPath)}" "$@"\n`, {
				mode: 0o700,
			});
			writeFileSync(
				helperPath,
				`import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.argv[2], JSON.stringify(request) + "\\n");
if (request.binding === "session-bound") await new Promise((resolve) => setTimeout(resolve, 150));
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.binding,
  identityFingerprint: request.expectedIdentityFingerprint,
  credentialVersion: 1,
  accessToken: "generation-secret:" + request.binding,
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
			);
			writeAuthJson({
				anthropic: {
					type: "external",
					source: "aimgr",
					protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
					executable: helperExecutable,
					args: [helperPath, requestLogPath],
					binding: "descriptor-default",
					expectedIdentityFingerprint: "identity-default",
				},
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.startAimExternalSession(
				[
					{
						type: "custom",
						customType: AIM_CREDENTIAL_BINDING_CUSTOM_TYPE,
						data: {
							provider: "anthropic",
							source: "aimgr",
							binding: "session-bound",
							identityFingerprint: "identity-session",
						},
					},
				],
				vi.fn(),
			);

			const racingAdmission = authStorage.withProviderRequestAdmission(
				"anthropic",
				() => authStorage.getApiKeyWithSourceToken("anthropic"),
				(auth, admission) => ({ apiKey: auth.apiKey, transportAuthIdentity: admission?.transportAuthIdentity }),
			);
			await vi.waitFor(() => {
				expect(readFileSync(requestLogPath, "utf8")).toContain('"binding":"session-bound"');
			});

			const firstPublish = vi.fn();
			const joinedPublish = vi.fn();
			const firstHandoff = authStorage.handoffAimCredential(
				"anthropic",
				"handoff-bound",
				"identity-handoff",
				firstPublish,
			);
			const joinedHandoff = authStorage.handoffAimCredential(
				"anthropic",
				"handoff-bound",
				"identity-handoff",
				joinedPublish,
			);
			await Promise.all([firstHandoff, joinedHandoff]);

			expect(firstPublish).toHaveBeenCalledTimes(1);
			expect(joinedPublish).not.toHaveBeenCalled();
			await expect(racingAdmission).resolves.toMatchObject({ apiKey: "generation-secret:handoff-bound" });
			const loggedBindings = readFileSync(requestLogPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { binding: string }).binding);
			expect(loggedBindings).toEqual(["session-bound", "handoff-bound"]);

			let finishAdmittedRequest!: () => void;
			const admittedFinish = new Promise<void>((resolve) => {
				finishAdmittedRequest = resolve;
			});
			const admitted = await authStorage.withProviderRequestAdmission(
				"anthropic",
				() => authStorage.getApiKeyWithSourceToken("anthropic"),
				(auth, admission) => ({
					apiKey: auth.apiKey,
					transportAuthIdentity: admission?.transportAuthIdentity,
					finish: admittedFinish,
				}),
			);
			await authStorage.handoffAimCredential("anthropic", "third-bound", "identity-third", vi.fn());
			expect(admitted.apiKey).toBe("generation-secret:handoff-bound");
			finishAdmittedRequest();
			await expect(admitted.finish).resolves.toBeUndefined();
			const nextAdmission = await authStorage.withProviderRequestAdmission(
				"anthropic",
				() => authStorage.getApiKeyWithSourceToken("anthropic"),
				(auth, admission) => ({ apiKey: auth.apiKey, transportAuthIdentity: admission?.transportAuthIdentity }),
			);
			expect(nextAdmission.apiKey).toBe("generation-secret:third-bound");
			expect(nextAdmission.transportAuthIdentity).not.toBe(admitted.transportAuthIdentity);
		});

		test("coalesces exact Codex advance and adopts the current generation for a stale failure", async () => {
			const helperPath = join(tempDir, "advance-helper.mjs");
			const requestLogPath = join(tempDir, "advance-requests.jsonl");
			trustedHelperDir = join(
				process.cwd(),
				`.aim-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(trustedHelperDir, { mode: 0o700 });
			const helperExecutable = join(trustedHelperDir, "advance-credential");
			writeFileSync(helperExecutable, `#!/bin/sh\nexec "${toShPath(process.execPath)}" "$@"\n`, {
				mode: 0o700,
			});
			writeFileSync(
				helperPath,
				`import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.argv[2], JSON.stringify(request) + "\\n");
const advanced = request.operation === "advance";
if (advanced) await new Promise((resolve) => setTimeout(resolve, 25));
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: advanced ? "automatic-bound" : request.binding,
  identityFingerprint: advanced ? "identity-automatic" : request.expectedIdentityFingerprint,
  credentialVersion: advanced ? 2 : 1,
  accessToken: advanced ? "automatic-secret" : "initial-secret",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));
`,
			);
			writeAuthJson({
				"openai-codex": {
					type: "external",
					source: "aimgr",
					protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
					executable: helperExecutable,
					args: [helperPath, requestLogPath],
					binding: "codex-bound",
					expectedIdentityFingerprint: "identity-codex",
				},
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.startAimExternalSession([], vi.fn());
			const admitted = await authStorage.withProviderRequestAdmission(
				"openai-codex",
				() => authStorage.getApiKeyWithSourceToken("openai-codex"),
				(auth, admission) => ({ apiKey: auth.apiKey, transportAuthIdentity: admission?.transportAuthIdentity }),
			);
			expect(admitted.apiKey).toBe("initial-secret");
			expect(admitted.transportAuthIdentity).toBeTruthy();

			const firstPublish = vi.fn();
			const joinedPublish = vi.fn();
			const firstAdvance = authStorage.advanceAimCredential(
				"openai-codex",
				admitted.transportAuthIdentity!,
				"usage_limit_reached",
				firstPublish,
			);
			const joinedAdvance = authStorage.advanceAimCredential(
				"openai-codex",
				admitted.transportAuthIdentity!,
				"usage_limit_reached",
				joinedPublish,
			);
			const [first, joined] = await Promise.all([firstAdvance, joinedAdvance]);
			expect(first.binding).toBe("automatic-bound");
			expect(joined.binding).toBe("automatic-bound");
			expect(firstPublish).toHaveBeenCalledTimes(1);
			expect(joinedPublish).not.toHaveBeenCalled();

			const stalePublish = vi.fn();
			const adopted = await authStorage.advanceAimCredential(
				"openai-codex",
				admitted.transportAuthIdentity!,
				"usage_limit_reached",
				stalePublish,
			);
			expect(adopted.binding).toBe("automatic-bound");
			expect(stalePublish).not.toHaveBeenCalled();
			expect(
				readFileSync(requestLogPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([
				{
					schemaVersion: 1,
					operation: "resolve",
					provider: "openai-codex",
					binding: "codex-bound",
					expectedIdentityFingerprint: "identity-codex",
				},
				{
					schemaVersion: 1,
					operation: "advance",
					provider: "openai-codex",
					binding: "codex-bound",
					expectedIdentityFingerprint: "identity-codex",
					reason: "usage_limit_reached",
				},
			]);
		});

		test("strictly resolves the pinned session binding and commits a handoff without persisting secrets", async () => {
			const helperPath = join(tempDir, "aim-credential-helper.mjs");
			const requestLogPath = join(tempDir, "aim-credential-requests.jsonl");
			trustedHelperDir = join(
				process.cwd(),
				`.aim-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(trustedHelperDir, { mode: 0o700 });
			const helperExecutable = join(trustedHelperDir, "resolve-credential");
			writeFileSync(helperExecutable, `#!/bin/sh\nexec "${toShPath(process.execPath)}" "$@"\n`, {
				mode: 0o700,
			});
			writeFileSync(
				helperPath,
				`import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.argv[2], JSON.stringify(request) + "\\n");
const response = {
  schemaVersion: 1,
  ok: true,
  provider: request.provider,
  binding: request.binding,
  identityFingerprint: request.expectedIdentityFingerprint,
  credentialVersion: 7,
  accessToken: "aim-test-secret:" + request.binding,
  expiresAt: Date.now() + 60 * 60 * 1000,
};
if (request.binding === "invalid-response") response.unexpected = true;
process.stdout.write(JSON.stringify(response));
`,
			);
			writeAuthJson({
				anthropic: {
					type: "external",
					source: "aimgr",
					protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
					executable: helperExecutable,
					args: [helperPath, requestLogPath],
					binding: "descriptor-default",
					expectedIdentityFingerprint: "identity-default",
				},
			});

			authStorage = AuthStorage.create(authJsonPath);
			const persistInitialBinding = vi.fn();
			authStorage.startAimExternalSession(
				[
					{
						type: "custom",
						customType: AIM_CREDENTIAL_BINDING_CUSTOM_TYPE,
						data: {
							provider: "anthropic",
							source: "aimgr",
							binding: "session-bound",
							identityFingerprint: "identity-session",
						},
					},
				],
				persistInitialBinding,
			);

			expect(authStorage.getAimCredentialBinding("anthropic")).toEqual({
				provider: "anthropic",
				source: "aimgr",
				binding: "session-bound",
				identityFingerprint: "identity-session",
			});
			expect(authStorage.getAimCredentialBindings()).toEqual([
				{
					provider: "anthropic",
					source: "aimgr",
					binding: "session-bound",
					identityFingerprint: "identity-session",
				},
			]);
			expect(authStorage.getAimExecutable("anthropic")).toBe(helperExecutable);
			expect(authStorage.getAimExecutable("openai-codex")).toBeUndefined();
			const initialAccess = await authStorage.getApiKeyWithSourceToken("anthropic");
			expect(initialAccess?.apiKey).toBe("aim-test-secret:session-bound");
			expect(JSON.stringify(initialAccess?.sourceToken)).not.toContain("aim-test-secret");
			expect(persistInitialBinding).toHaveBeenCalledOnce();
			expect(persistInitialBinding).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "anthropic",
					binding: "session-bound",
					helper: expect.objectContaining({ executable: helperExecutable }),
				}),
			);
			expect(JSON.stringify(persistInitialBinding.mock.calls)).not.toContain("aim-test-secret");

			await expect(
				authStorage.handoffAimCredential("anthropic", "invalid-response", "identity-invalid", vi.fn()),
			).rejects.toMatchObject({ code: "protocol_mismatch" });
			expect(authStorage.getAimCredentialBinding("anthropic")?.binding).toBe("session-bound");

			const handoffPhases: string[] = [];
			await authStorage.handoffAimCredential("anthropic", "handoff-bound", "identity-handoff", () => {
				handoffPhases.push("append");
				expect(authStorage.getAimCredentialBinding("anthropic")?.binding).toBe("session-bound");
			});
			handoffPhases.push("returned");
			expect(handoffPhases).toEqual(["append", "returned"]);

			expect(authStorage.getAimCredentialBinding("anthropic")).toEqual({
				provider: "anthropic",
				source: "aimgr",
				binding: "handoff-bound",
				identityFingerprint: "identity-handoff",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("aim-test-secret:handoff-bound");

			const initialPersistencePhases: string[] = [];
			const defaultAuthStorage = AuthStorage.create(authJsonPath);
			defaultAuthStorage.startAimExternalSession([], (binding) => {
				initialPersistencePhases.push("persist-binding");
				expect(binding).toMatchObject({
					provider: "anthropic",
					source: "aimgr",
					binding: "descriptor-default",
					identityFingerprint: "identity-default",
					helper: { executable: helperExecutable },
				});
				expect(JSON.stringify(binding)).not.toContain("aim-test-secret");
				const loggedRequests = readFileSync(requestLogPath, "utf8").trim().split("\n");
				expect(JSON.parse(loggedRequests.at(-1) ?? "{}")).toMatchObject({
					binding: "descriptor-default",
				});
			});
			const defaultAccessPromise = defaultAuthStorage.getApiKey("anthropic");
			expect(initialPersistencePhases).toEqual([]);
			await expect(defaultAccessPromise).resolves.toBe("aim-test-secret:descriptor-default");
			initialPersistencePhases.push("token-returned");
			expect(initialPersistencePhases).toEqual(["persist-binding", "token-returned"]);

			expect(
				readFileSync(requestLogPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([
				{
					schemaVersion: 1,
					operation: "resolve",
					provider: "anthropic",
					binding: "session-bound",
					expectedIdentityFingerprint: "identity-session",
				},
				{
					schemaVersion: 1,
					operation: "resolve",
					provider: "anthropic",
					binding: "invalid-response",
					expectedIdentityFingerprint: "identity-invalid",
				},
				{
					schemaVersion: 1,
					operation: "resolve",
					provider: "anthropic",
					binding: "handoff-bound",
					expectedIdentityFingerprint: "identity-handoff",
				},
				{
					schemaVersion: 1,
					operation: "resolve",
					provider: "anthropic",
					binding: "descriptor-default",
					expectedIdentityFingerprint: "identity-default",
				},
			]);

			const persistedAuth = readFileSync(authJsonPath, "utf8");
			expect(persistedAuth).not.toContain("aim-test-secret");
			expect(persistedAuth).not.toContain("session-bound");
			expect(persistedAuth).not.toContain("handoff-bound");
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("removeVerified deletes from disk and memory", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.removeVerified("mcp:remote");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(updated["mcp:remote"]).toBeUndefined();
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect((updated.openai as { key: string }).key).toBe("openai-key");
		});

		test("removeVerified throws while the credential may still exist on disk", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			expect(() => authStorage.removeVerified("mcp:remote")).toThrow();
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
