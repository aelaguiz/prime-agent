import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS,
	ExternalCredentialClient,
	type ExternalCredentialDescriptor,
	ExternalCredentialError,
} from "../src/core/external-credential-client.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const helperFixture = join(fixtureDir, "fixtures", "external-credential-helper.mjs");

interface HelperState {
	callCount?: number;
	delayMs?: number;
	responses: Array<Record<string, unknown>>;
}

describe("ExternalCredentialClient", () => {
	let tempDir: string;
	let helperPath: string;
	let statePath: string;
	let requestLogPath: string;
	let descriptor: ExternalCredentialDescriptor;
	let now: number;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-external-helper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true, mode: 0o700 });
		helperPath = join(tempDir, "fake-helper.mjs");
		statePath = join(tempDir, "state.json");
		requestLogPath = join(tempDir, "requests.jsonl");
		copyFileSync(helperFixture, helperPath);
		chmodSync(helperPath, 0o700);
		writeFileSync(requestLogPath, "");
		now = 1_800_000_000_000;
		descriptor = {
			type: "external",
			source: "aimgr",
			protocol: "aimgr-credential-v1",
			executable: helperPath,
			args: [statePath, requestLogPath],
			binding: "pro3",
			expectedIdentityFingerprint: "identity-pro3",
		};
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function success(accessToken: string, credentialVersion: number, expiresAt: number) {
		return {
			schemaVersion: 1,
			ok: true,
			provider: "openai-codex",
			binding: "pro3",
			identityFingerprint: "identity-pro3",
			credentialVersion,
			accessToken,
			expiresAt,
		};
	}

	function writeState(state: HelperState): void {
		writeFileSync(statePath, JSON.stringify(state));
	}

	function readRequests(): Array<Record<string, unknown>> {
		const content = readFileSync(requestLogPath, "utf8").trim();
		return content ? content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
	}

	it("invokes the exact executable with the frozen protocol and caches until expiry skew", async () => {
		writeState({
			responses: [
				success("fixture-access-one", 41, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000),
				success("fixture-access-two", 42, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 180_000),
			],
		});
		const client = new ExternalCredentialClient({ now: () => now });

		const first = await client.resolve(descriptor, "openai-codex");
		const cached = await client.resolve(descriptor, "openai-codex");
		expect(first.accessToken).toBe("fixture-access-one");
		expect(cached.valueFingerprint).toBe(first.valueFingerprint);
		expect(readRequests()).toEqual([
			{
				schemaVersion: 1,
				operation: "resolve",
				provider: "openai-codex",
				binding: "pro3",
				expectedIdentityFingerprint: "identity-pro3",
			},
		]);

		now += 60_000;
		const refreshed = await client.resolve(descriptor, "openai-codex");
		expect(refreshed.accessToken).toBe("fixture-access-two");
		expect(readRequests()).toHaveLength(2);
	});

	it("coalesces concurrent resolves for the same provider and binding", async () => {
		writeState({
			delayMs: 50,
			responses: [success("fixture-coalesced-access", 7, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000)],
		});
		const client = new ExternalCredentialClient({ now: () => now });

		const [first, second] = await Promise.all([
			client.resolve(descriptor, "openai-codex"),
			client.resolve(descriptor, "openai-codex"),
		]);
		expect(first.valueFingerprint).toBe(second.valueFingerprint);
		expect(readRequests()).toHaveLength(1);
	});

	it("invalidates only the rejected value and privately forwards its credential version", async () => {
		writeState({
			responses: [
				success("fixture-rejected-access", 41, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000),
				success("fixture-replacement-access", 42, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 120_000),
			],
		});
		const client = new ExternalCredentialClient({ now: () => now });
		const first = await client.resolve(descriptor, "openai-codex");

		expect(
			client.invalidate({
				provider: "openai-codex",
				source: "external",
				identityFingerprint: first.identityFingerprint,
				valueFingerprint: first.valueFingerprint,
			}),
		).toBe(true);
		const second = await client.resolve(descriptor, "openai-codex");
		expect(second.accessToken).toBe("fixture-replacement-access");
		expect(second).not.toHaveProperty("credentialVersion");
		expect(readRequests()[1]).toMatchObject({ rejectedCredentialVersion: 41 });
	});

	it("arbitrates an expiry refresh overlapping a 401 rejection without recaching stale access", async () => {
		const responses = [
			success("fixture-stale", 51, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000),
			success("fixture-new", 52, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 120_000),
		];
		writeState({ responses });
		const client = new ExternalCredentialClient({ now: () => now, maxCacheMs: 10 });
		const stale = await client.resolve(descriptor, "openai-codex");
		writeState({ callCount: 1, delayMs: 100, responses });
		now += 11;
		const expiryRefresh = client.resolve(descriptor, "openai-codex");
		while (readRequests().length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
		const rejectionRefresh = client.resolveAfterRejection(descriptor, {
			provider: "openai-codex",
			source: "external",
			identityFingerprint: stale.identityFingerprint,
			valueFingerprint: stale.valueFingerprint,
		});
		const [expiryResult, rejectionResult] = await Promise.all([expiryRefresh, rejectionRefresh]);
		expect(expiryResult.accessToken).toBe("fixture-new");
		expect(rejectionResult?.valueFingerprint).toBe(expiryResult.valueFingerprint);
		expect((await client.resolve(descriptor, "openai-codex")).accessToken).toBe("fixture-new");
		expect(readRequests()).toHaveLength(2);
	});

	it("shares one unchanged rejection flight across simultaneous waiters", async () => {
		const responses = [
			success("fixture-unchanged", 70, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000),
			success("fixture-unchanged", 71, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000),
		];
		writeState({ responses });
		const client = new ExternalCredentialClient({ now: () => now });
		const rejected = await client.resolve(descriptor, "openai-codex");
		writeState({ callCount: 1, delayMs: 100, responses });
		const sourceToken = {
			provider: "openai-codex",
			source: "external" as const,
			identityFingerprint: rejected.identityFingerprint,
			valueFingerprint: rejected.valueFingerprint,
		};
		const [first, second] = await Promise.all([
			client.resolveAfterRejection(descriptor, sourceToken),
			client.resolveAfterRejection(descriptor, sourceToken),
		]);
		expect(first?.valueFingerprint).toBe(rejected.valueFingerprint);
		expect(second?.valueFingerprint).toBe(rejected.valueFingerprint);
		expect(readRequests()).toHaveLength(2);
		expect(readRequests()[1]).toMatchObject({ rejectedCredentialVersion: 70 });
	});

	it("rejects a helper response that completes after its runtime generation is cleared", async () => {
		writeState({
			delayMs: 75,
			responses: [success("fixture-old-generation", 61, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000)],
		});
		const client = new ExternalCredentialClient({ now: () => now });
		const pending = client.resolve(descriptor, "openai-codex");
		while (readRequests().length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		client.clear();
		await expect(pending).rejects.toMatchObject({ code: "coordination_unavailable" });
	});

	it("enforces the outer deadline and bounded stdout", async () => {
		writeState({
			delayMs: 100,
			responses: [success("fixture-delayed-access", 1, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000)],
		});
		const timeoutClient = new ExternalCredentialClient({ now: () => now, timeoutMs: 10 });
		await expect(timeoutClient.resolve(descriptor, "openai-codex")).rejects.toMatchObject({
			code: "helper_timeout",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		writeState({
			responses: [success("x".repeat(70 * 1024), 2, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000)],
		});
		const boundedClient = new ExternalCredentialClient({ now: () => now });
		await expect(boundedClient.resolve(descriptor, "openai-codex")).rejects.toMatchObject({
			code: "protocol_mismatch",
		});
	});

	it("rejects a writable helper executable before spawning", async () => {
		writeState({
			responses: [success("fixture-never-spawned", 1, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 60_000)],
		});
		chmodSync(helperPath, 0o722);
		const client = new ExternalCredentialClient({ now: () => now });
		await expect(client.resolve(descriptor, "openai-codex")).rejects.toMatchObject({
			code: "helper_untrusted",
		});
		expect(readRequests()).toHaveLength(0);
	});

	it("maps helper failures to fixed value-free errors", async () => {
		writeState({
			responses: [
				{
					schemaVersion: 1,
					ok: false,
					code: "reauth_required",
					message: "fixture-access-must-not-escape",
					action: "ignored",
				},
			],
		});
		const client = new ExternalCredentialClient({ now: () => now });

		const error = await client.resolve(descriptor, "openai-codex").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ExternalCredentialError);
		expect((error as ExternalCredentialError).code).toBe("reauth_required");
		expect((error as Error).message).not.toContain("fixture-access-must-not-escape");
	});

	it("fails closed on identity mismatch and credentials inside the five-minute floor", async () => {
		writeState({
			responses: [
				{
					...success("fixture-wrong-identity", 1, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS + 1),
					identityFingerprint: "different-identity",
				},
			],
		});
		const identityClient = new ExternalCredentialClient({ now: () => now });
		await expect(identityClient.resolve(descriptor, "openai-codex")).rejects.toMatchObject({
			code: "identity_conflict",
		});

		writeFileSync(requestLogPath, "");
		writeState({
			responses: [success("fixture-too-stale", 2, now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS)],
		});
		const staleClient = new ExternalCredentialClient({ now: () => now });
		await expect(staleClient.resolve(descriptor, "openai-codex")).rejects.toMatchObject({
			code: "credential_expired",
		});
	});
});
