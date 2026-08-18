import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, foldAimCredentialBindings } from "../src/core/aim-external-auth.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createSessionManager } from "../src/main.js";

describe("fork credential binding reset", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parses repeatable provider resets only with --fork", () => {
		const parsed = parseArgs([
			"--fork",
			"session-id",
			"--reset-credential-binding",
			"openai-codex",
			"--reset-credential-binding",
			"anthropic",
		]);
		expect(parsed.resetCredentialBindings).toEqual(["openai-codex", "anthropic"]);
		expect(parsed.diagnostics).toEqual([]);

		const invalid = parseArgs(["--reset-credential-binding", "openai-codex"]);
		expect(invalid.diagnostics).toContainEqual({
			type: "error",
			message: "--reset-credential-binding requires --fork",
		});
	});

	it("copies conversation context while resetting only the selected provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-credential-reset-"));
		tempDirs.push(root);
		const sessions = join(root, "sessions");
		const source = SessionManager.create(root, sessions);
		source.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Continue this exact conversation" }],
			timestamp: Date.now(),
		});
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Saved answer" }],
			api: "openai-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
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
		source.appendCustomEntryWithRollback(AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, {
			provider: "openai-codex",
			source: "aimgr",
			binding: "limited",
			identityFingerprint: "codex-identity",
		});
		source.appendCustomEntryWithRollback(AIM_CREDENTIAL_BINDING_CUSTOM_TYPE, {
			provider: "anthropic",
			source: "aimgr",
			binding: "keep",
			identityFingerprint: "anthropic-identity",
		});
		source.flushNow();

		const sourceFile = source.getSessionFile()!;
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const fork = await createSessionManager(
			parseArgs(["--fork", sourceFile, "--session-dir", sessions, "--reset-credential-binding", "openai-codex"]),
			root,
			sessions,
		);

		expect(readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
		expect(fork.getHeader()?.parentSession).toBe(sourceFile);
		const forkBindings = foldAimCredentialBindings(fork.getEntries());
		expect(forkBindings.has("openai-codex")).toBe(false);
		expect(forkBindings.get("anthropic")?.binding).toBe("keep");
		expect(fork.buildSessionContext().messages).toEqual([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "assistant" }),
		]);
		expect(readFileSync(fork.getSessionFile()!, "utf8")).not.toContain('"binding":"limited"');
	});
});
