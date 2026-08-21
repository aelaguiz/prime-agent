import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";
import { computeBundleBuildId } from "../src/modes/daemon/daemon-runtime-identity.js";

const packageDir = join(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(() => {
	for (const child of childProcesses.splice(0)) child.kill("SIGKILL");
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function publish(entrypoint: string, outdir: string, failBeforeEntrypoint = false): void {
	execFileSync(process.execPath, ["scripts/bundle.mjs"], {
		cwd: packageDir,
		env: {
			...process.env,
			PRIME_AGENT_BUNDLE_ENTRYPOINT: entrypoint,
			PRIME_AGENT_BUNDLE_OUTDIR: outdir,
			...(failBeforeEntrypoint ? { PRIME_AGENT_BUNDLE_FAIL_BEFORE_ENTRYPOINT: "1" } : {}),
		},
		stdio: "pipe",
		timeout: 60_000,
	});
}

async function waitForOutput(output: () => string, expected: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!output().includes(expected) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(output()).toContain(expected);
}

describe("bundle publication", () => {
	it("keeps generation A live while generation B publishes and failed B leaves A visible", async () => {
		const root = mkdtempSync(join(packageDir, "dist", "bundle-generations-"));
		temporaryDirectories.push(root);
		const sourceDir = join(root, "source");
		const outdir = join(root, "published");
		const sourceEntrypoint = join(sourceDir, "cli.js");
		const lazySource = join(sourceDir, "lazy.js");
		const triggerPath = join(root, "trigger");
		mkdirSync(sourceDir);
		writeFileSync(
			sourceEntrypoint,
			`import { existsSync } from "node:fs";\nconsole.log("READY:A");\nwhile (!existsSync(${JSON.stringify(triggerPath)})) await new Promise((resolve) => setTimeout(resolve, 10));\nconsole.log((await import("./lazy.js")).value);\n`,
			{ flag: "wx" },
		);
		writeFileSync(lazySource, 'export const value = "LATE:A";\n');
		publish(sourceEntrypoint, outdir);
		const generationAEntrypoint = readFileSync(join(outdir, "cli.js"));
		const generationAIdentity = computeBundleBuildId(outdir);

		const oldProcess = spawn(process.execPath, [join(outdir, "cli.js")], { stdio: ["ignore", "pipe", "pipe"] });
		childProcesses.push(oldProcess);
		let oldOutput = "";
		oldProcess.stdout?.on("data", (chunk: Buffer) => {
			oldOutput += chunk.toString("utf8");
		});
		await waitForOutput(() => oldOutput, "READY:A");

		writeFileSync(
			sourceEntrypoint,
			`import { existsSync } from "node:fs";\nconsole.log("READY:B");\nwhile (!existsSync(${JSON.stringify(triggerPath)})) await new Promise((resolve) => setTimeout(resolve, 10));\nconsole.log((await import("./lazy.js")).value);\n`,
		);
		writeFileSync(lazySource, 'export const value = "LATE:B";\n');
		const filesBeforeFailedPublish = new Set(readdirSync(outdir));
		expect(() => publish(sourceEntrypoint, outdir, true)).toThrow();
		expect(readFileSync(join(outdir, "cli.js"))).toEqual(generationAEntrypoint);
		expect(computeBundleBuildId(outdir)).toBe(generationAIdentity);
		expect(readdirSync(outdir).some((name) => !filesBeforeFailedPublish.has(name))).toBe(true);

		publish(sourceEntrypoint, outdir);
		const generationBIdentity = computeBundleBuildId(outdir);
		expect(generationBIdentity).not.toBe(generationAIdentity);
		writeFileSync(triggerPath, "go\n");
		await once(oldProcess, "exit");
		expect(oldOutput).toContain("LATE:A");

		const current = spawnSync(process.execPath, [join(outdir, "cli.js")], { encoding: "utf8" });
		expect(current.status).toBe(0);
		expect(current.stdout).toContain("READY:B");
		expect(current.stdout).toContain("LATE:B");
		expect(readdirSync(outdir).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("publishes the production CLI as an executable runnable entrypoint", () => {
		const outdir = mkdtempSync(join(packageDir, "dist", "bundle-publication-"));
		temporaryDirectories.push(outdir);
		publish(join(packageDir, "dist", "cli.js"), outdir);

		const entrypoint = join(outdir, "cli.js");
		expect(statSync(entrypoint).mode & 0o111).not.toBe(0);
		const version = spawnSync(process.execPath, [entrypoint, "--version"], { encoding: "utf8" });
		expect(version.status).toBe(0);
		expect(`${version.stdout}${version.stderr}`.trim()).toBe(VERSION);
	});
});
