import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAimAccountUsage, queryAimAccountUsage, resolveAimUsageBindings } from "../src/core/aim-usage.js";
import { BUILTIN_SLASH_COMMANDS, resolveBuiltinSlashCommandName } from "../src/core/slash-commands.js";

const status = {
	accounts: [
		{
			label: "office",
			provider: "openai-codex",
			usage: {
				ok: true,
				plan: "pro",
				windows: [{ label: "168h", usedPercent: 31, resetAt: 1_786_316_276_000 }],
				limitReached: false,
				stale: false,
			},
		},
	],
};

describe("AIM /usage support", () => {
	it("registers a plain-text usage command", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")).toMatchObject({
			description: expect.stringContaining("account"),
		});
		expect(resolveBuiltinSlashCommandName("usage")).toBe("usage");
	});

	it("shows the selected AIM account before the first request pins the root", () => {
		expect(
			resolveAimUsageBindings(undefined, "openai-codex", {
				source: "aimgr",
				binding: "office",
			}),
		).toEqual([{ provider: "openai-codex", source: "aimgr", binding: "office" }]);
		expect(
			resolveAimUsageBindings([{ provider: "openai-codex", source: "aimgr", binding: "pinned" }], "openai-codex", {
				source: "aimgr",
				binding: "new-default",
			}),
		).toEqual([{ provider: "openai-codex", source: "aimgr", binding: "pinned" }]);
	});

	it("keeps only the non-secret account usage fields", () => {
		const parsed = parseAimAccountUsage(
			JSON.stringify({
				...status,
				secret: "must-not-survive",
				accounts: [{ ...status.accounts[0], credential: { access: "must-not-survive" } }],
			}),
		);
		expect(parsed).toEqual([
			{
				provider: "openai-codex",
				label: "office",
				ok: true,
				plan: "pro",
				windows: [{ label: "168h", usedPercent: 31, resetAt: 1_786_316_276_000 }],
				limitReached: false,
				stale: false,
			},
		]);
		expect(JSON.stringify(parsed)).not.toContain("must-not-survive");
	});

	it("queries AIM through the exact executable without a shell", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-aim-usage-"));
		const executable = join(dir, "fake-aim");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(status))});
`,
		);
		chmodSync(executable, 0o700);
		await expect(queryAimAccountUsage(executable)).resolves.toEqual(parseAimAccountUsage(JSON.stringify(status)));
	});
});
