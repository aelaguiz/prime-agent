import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { AIM_EXTERNAL_CREDENTIAL_PROTOCOL } from "../src/core/aim-external-auth.js";
import { AuthStorage } from "../src/core/auth-storage.js";
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

	it("lets native xAI OAuth be stored while an AIM Anthropic descriptor stays managed", () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: "/usr/bin/true",
				args: ["credential-helper"],
				binding: "pro1",
				expectedIdentityFingerprint: "anthropic-identity",
			} as never,
		});
		storage.startAimExternalSession([], () => undefined);

		storage.set("xai", {
			type: "oauth",
			access: "xai-access",
			refresh: "xai-refresh",
			expires: Date.now() + 3600_000,
		});

		const xai = storage.get("xai");
		expect(xai?.type).toBe("oauth");
		expect(storage.getAimCredentialBinding("anthropic")?.source).toBe("aimgr");
		expect(storage.getAimCredentialBinding("xai")).toBeUndefined();
		expect(storage.getAuthStatus("xai")).toEqual({ configured: true, source: "stored" });
		expect(storage.hasAuth("anthropic")).toBe(true);
	});

	it("remaps xAI under stored OAuth without taking over AIM-managed Anthropic", () => {
		const storage = AuthStorage.inMemory({
			anthropic: {
				type: "external",
				source: "aimgr",
				protocol: AIM_EXTERNAL_CREDENTIAL_PROTOCOL,
				executable: "/usr/bin/true",
				args: ["credential-helper"],
				binding: "pro1",
				expectedIdentityFingerprint: "anthropic-identity",
			} as never,
			xai: {
				type: "oauth",
				access: "xai-access",
				refresh: "xai-refresh",
				expires: Date.now() + 3600_000,
			},
		});
		storage.startAimExternalSession([], () => undefined);

		const registry = isolatedRegistry(storage);
		const xaiModels = registry.getAll().filter((model) => model.provider === "xai");
		expect(xaiModels.length).toBeGreaterThan(0);
		expect(xaiModels.every((model) => model.api === "openai-responses")).toBe(true);
		expect(xaiModels.some((model) => model.id === "grok-4.6")).toBe(true);
		expect(storage.getAimCredentialBinding("anthropic")?.binding).toBe("pro1");
		expect(storage.getAimCredentialBinding("xai")).toBeUndefined();
	});
});
