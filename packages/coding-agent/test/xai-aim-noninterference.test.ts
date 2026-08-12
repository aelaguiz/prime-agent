import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, ManagedAuthConflictError } from "../src/core/auth-storage.js";
import { EXTERNAL_CREDENTIAL_PROTOCOL } from "../src/core/external-credential-client.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("xAI OAuth does not interfere with AIM-managed providers", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function isolatedRegistry(storage: AuthStorage): ModelRegistry {
		const dir = mkdtempSync(join(tmpdir(), "prime-xai-aim-"));
		tempDirs.push(dir);
		return ModelRegistry.create(storage, join(dir, "models.json"));
	}

	it("lists xAI as a built-in OAuth provider", () => {
		expect(getOAuthProviders().some((provider) => provider.id === "xai")).toBe(true);
	});

	it("lets native xAI OAuth be stored while AIM-managed Anthropic stays exclusive", () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: "/usr/bin/true",
				args: ["credential-helper"],
				binding: "pro1",
				expectedIdentityFingerprint: "anthropic-identity",
			},
		});

		expect(() =>
			storage.set("anthropic", {
				type: "oauth",
				access: "should-not-write",
				refresh: "should-not-write",
				expires: Date.now() + 3600_000,
			}),
		).toThrow(ManagedAuthConflictError);

		storage.set("xai", {
			type: "oauth",
			access: "xai-access",
			refresh: "xai-refresh",
			expires: Date.now() + 3600_000,
		});

		const xai = storage.get("xai");
		expect(xai?.type).toBe("oauth");
		expect(storage.get("anthropic")?.type).toBe("external");
		expect(storage.getAuthStatus("xai")).toEqual({ configured: true, source: "stored" });
		expect(storage.getAuthStatus("anthropic").source).toBe("external");
	});

	it("remaps xAI under stored OAuth without changing AIM-managed Anthropic catalog ownership", () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: "/usr/bin/true",
				args: ["credential-helper"],
				binding: "pro1",
				expectedIdentityFingerprint: "anthropic-identity",
			},
			xai: {
				type: "oauth",
				access: "xai-access",
				refresh: "xai-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const registry = isolatedRegistry(storage);
		const xaiModels = registry.getAll().filter((model) => model.provider === "xai");
		expect(xaiModels.length).toBeGreaterThan(0);
		expect(xaiModels.every((model) => model.api === "openai-responses")).toBe(true);
		expect(xaiModels.some((model) => model.id === "grok-4.6")).toBe(true);
		expect(storage.isExternalAuthManaged("anthropic")).toBe(true);
		expect(storage.isExternalAuthManaged("xai")).toBe(false);
	});
});
