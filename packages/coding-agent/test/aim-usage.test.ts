import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAimAccountUsage, queryAimAccountUsage } from "../src/core/aim-usage.js";
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

const temporaryDirectories: string[] = [];

function trustedTemporaryDirectory(): string {
	const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".aim-usage-"));
	temporaryDirectories.push(directory);
	return directory;
}

function writeExecutable(directory: string, source: string): string {
	const executable = join(directory, "fake-aim");
	writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
	chmodSync(executable, 0o700);
	return executable;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AIM /usage support", () => {
	it("registers a plain-text usage command", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")).toMatchObject({
			description: expect.stringContaining("account"),
		});
		expect(resolveBuiltinSlashCommandName("usage")).toBe("usage");
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
		const executable = writeExecutable(
			trustedTemporaryDirectory(),
			`process.stdout.write(${JSON.stringify(JSON.stringify(status))});`,
		);
		await expect(queryAimAccountUsage(executable)).resolves.toEqual(parseAimAccountUsage(JSON.stringify(status)));
	});

	it("rejects an executable beneath an untrusted writable parent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-aim-usage-untrusted-"));
		temporaryDirectories.push(directory);
		chmodSync(directory, 0o777);
		const executable = writeExecutable(directory, `process.stdout.write(${JSON.stringify(JSON.stringify(status))});`);
		await expect(queryAimAccountUsage(executable)).rejects.toMatchObject({ code: "helper_untrusted" });
	});

	it("strips ambient secrets from the AIM status child", async () => {
		const secretKey = "PRIME_AIM_USAGE_TEST_SECRET";
		const previous = process.env[secretKey];
		process.env[secretKey] = "must-not-reach-child";
		try {
			const executable = writeExecutable(
				trustedTemporaryDirectory(),
				`const output = ${JSON.stringify(status)};
output.accounts[0].label = process.env.${secretKey} === undefined ? "office" : "leaked";
process.stdout.write(JSON.stringify(output));`,
			);
			await expect(queryAimAccountUsage(executable)).resolves.toEqual(parseAimAccountUsage(JSON.stringify(status)));
		} finally {
			if (previous === undefined) delete process.env[secretKey];
			else process.env[secretKey] = previous;
		}
	});

	it("hard-stops a status child at the promised deadline", async () => {
		const directory = trustedTemporaryDirectory();
		const pidPath = join(directory, "child.pid");
		const executable = writeExecutable(
			directory,
			`process.on("SIGTERM", () => {});
import("node:fs").then(({ writeFileSync }) => {
  writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  setInterval(() => {}, 1_000);
});`,
		);
		const startedAt = Date.now();
		await expect(queryAimAccountUsage(executable, 500)).rejects.toThrow("timed out");
		expect(Date.now() - startedAt).toBeLessThan(1_200);
		await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
		const pid = Number(readFileSync(pidPath, "utf8"));
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1_000 });
	});

	it("byte-bounds status output before parsing it", async () => {
		const executable = writeExecutable(
			trustedTemporaryDirectory(),
			`process.stdout.write(Buffer.alloc(2_000_001, "x"));`,
		);
		await expect(queryAimAccountUsage(executable)).rejects.toThrow("too large");
	});
});
