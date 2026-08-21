import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeBundleBuildId,
	computeRuntimeBuildId,
	computeSourceBuildId,
	getDaemonRuntimeIdentity,
} from "../src/modes/daemon/daemon-runtime-identity.js";
import { assertDaemonWorkerRuntimeIdentity } from "../src/modes/daemon/daemon-supervisor.js";

function run(command: string, args: readonly string[], cwd: string): string {
	return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

describe("daemon runtime identity", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const path of cleanups.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("changes for runtime source edits but ignores docs and tests", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-source-identity-"));
		cleanups.push(root);
		run("git", ["init", "-q"], root);
		run("git", ["config", "user.email", "test@example.invalid"], root);
		run("git", ["config", "user.name", "Prime Test"], root);
		mkdirSync(join(root, "packages", "coding-agent", "src"), { recursive: true });
		mkdirSync(join(root, "prime-agent-runtime", "src"), { recursive: true });
		mkdirSync(join(root, "prime-agent-runtime", "test"), { recursive: true });
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "packages", "coding-agent", "src", "tracked.ts"), "one\n");
		writeFileSync(join(root, "packages", "coding-agent", "tsconfig.examples.json"), '{"one":true}\n');
		writeFileSync(join(root, "prime-agent-runtime", "src", "runtime.py"), "one\n");
		writeFileSync(join(root, "prime-agent-runtime", "test", "test_runtime.py"), "one\n");
		writeFileSync(join(root, "docs", "note.md"), "one\n");
		run("git", ["add", "."], root);
		run("git", ["commit", "-qm", "initial"], root);

		const clean = computeSourceBuildId(root);
		expect(computeSourceBuildId(root)).toBe(clean);
		expect(clean).toMatch(/^source-v1:/);

		writeFileSync(join(root, "docs", "note.md"), "two\n");
		run("git", ["add", "docs/note.md"], root);
		run("git", ["commit", "-qm", "docs only"], root);
		writeFileSync(join(root, "untracked-test-note.md"), "ignored\n");
		writeFileSync(join(root, "packages", "coding-agent", "tsconfig.examples.json"), '{"two":true}\n');
		writeFileSync(join(root, "prime-agent-runtime", "test", "test_runtime.py"), "two\n");
		expect(computeSourceBuildId(root)).toBe(clean);

		writeFileSync(join(root, "packages", "coding-agent", "src", "tracked.ts"), "two\n");
		const tracked = computeSourceBuildId(root);
		expect(tracked).not.toBe(clean);
		expect(computeSourceBuildId(root)).toBe(tracked);
		run("git", ["add", "packages/coding-agent/src/tracked.ts"], root);
		expect(computeSourceBuildId(root)).toBe(tracked);

		writeFileSync(join(root, "packages", "coding-agent", "src", "untracked.ts"), "one\n");
		const untracked = computeSourceBuildId(root);
		expect(untracked).not.toBe(tracked);
		run("git", ["add", "packages/coding-agent/src/untracked.ts"], root);
		expect(computeSourceBuildId(root)).toBe(untracked);
		writeFileSync(join(root, "packages", "coding-agent", "src", "untracked.ts"), "two\n");
		expect(computeSourceBuildId(root)).not.toBe(untracked);

		rmSync(join(root, "packages", "coding-agent", "src", "tracked.ts"));
		const deleted = computeSourceBuildId(root);
		run("git", ["add", "-u"], root);
		expect(computeSourceBuildId(root)).toBe(deleted);
	});

	it("hashes bundle JavaScript path-independently and ignores non-executable assets", () => {
		const first = mkdtempSync(join(tmpdir(), "prime-bundle-identity-a-"));
		const second = mkdtempSync(join(tmpdir(), "prime-bundle-identity-b-"));
		cleanups.push(first, second);
		for (const root of [first, second]) {
			mkdirSync(join(root, "chunks"));
			writeFileSync(join(root, "cli.js"), "import './chunks/runtime.js';\n");
			writeFileSync(join(root, "chunks", "runtime.js"), "export const runtime = 1;\n");
		}
		writeFileSync(join(first, "cli.js.map"), "first source map\n");
		writeFileSync(join(second, "cli.js.map"), "different source map\n");

		const baseline = computeBundleBuildId(first);
		expect(baseline).toBe(computeBundleBuildId(second));
		expect(baseline).toMatch(/^bundle-v1:/);
		writeFileSync(join(second, "chunks", "runtime.js"), "export const runtime = 2;\n");
		expect(computeBundleBuildId(second)).not.toBe(baseline);
		expect(baseline).not.toMatch(/^source-v1:/);

		const firstExecutable = join(first, "prime-a");
		const secondExecutable = join(second, "prime-b");
		writeFileSync(firstExecutable, "compiled executable bytes\n");
		writeFileSync(secondExecutable, "compiled executable bytes\n");
		const executableBaseline = computeBundleBuildId(firstExecutable);
		expect(computeBundleBuildId(secondExecutable)).toBe(executableBaseline);
		writeFileSync(secondExecutable, "changed compiled executable bytes\n");
		expect(computeBundleBuildId(secondExecutable)).not.toBe(executableBaseline);
	});

	it("uses the entrypoint's embedded closure identity instead of retained chunks", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-embedded-bundle-identity-"));
		cleanups.push(root);
		const embedded = `bundle-v1:${"a".repeat(64)}`;
		writeFileSync(join(root, "cli.js"), `// prime-agent-bundle-build-id: ${embedded}\nexport {};\n`);
		writeFileSync(join(root, "retained-old-chunk.js"), "export const old = 1;\n");

		expect(computeBundleBuildId(root)).toBe(embedded);
		writeFileSync(join(root, "retained-old-chunk.js"), "export const old = 2;\n");
		expect(computeBundleBuildId(root)).toBe(embedded);
	});

	it("resolves an installed entrypoint symlink to its actual bundle closure", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-installed-identity-"));
		cleanups.push(root);
		const bundle = join(root, "dist", "bundle");
		const bin = join(root, "bin");
		mkdirSync(bundle, { recursive: true });
		mkdirSync(bin);
		writeFileSync(join(bundle, "cli.js"), "export const cli = true;\n");
		writeFileSync(join(bundle, "chunk.js"), "export const chunk = true;\n");
		const linkedEntrypoint = join(bin, "prime-agent");
		symlinkSync(join(bundle, "cli.js"), linkedEntrypoint);

		expect(computeRuntimeBuildId(linkedEntrypoint)).toBe(computeBundleBuildId(bundle));
	});

	it("ignores a spoofed launcher build variable", () => {
		const first = getDaemonRuntimeIdentity({
			PRIME_AGENT_BUILD_ID: "spoof-one",
			PRIME_AGENT_LAUNCHER_PATH: "/tmp/launcher-one",
		});
		const second = getDaemonRuntimeIdentity({
			PRIME_AGENT_BUILD_ID: "spoof-two",
			PRIME_AGENT_LAUNCHER_PATH: "/tmp/launcher-two",
		});
		expect(first.buildId).toBe(second.buildId);
		expect(first.buildId).not.toBe("spoof-one");
		expect(second.buildId).not.toBe("spoof-two");
	});

	it("allows rolling supervisor restarts across build IDs", () => {
		expect(() =>
			assertDaemonWorkerRuntimeIdentity(
				{ buildId: "worker-build", executablePath: "/worker" },
				{ buildId: "supervisor-build", executablePath: "/supervisor" },
			),
		).not.toThrow();
		expect(() =>
			assertDaemonWorkerRuntimeIdentity(undefined, {
				buildId: "supervisor-build",
				executablePath: "/supervisor",
			}),
		).toThrow("worker=missing");
	});

	it("fails loudly when required source or bundle inputs cannot be read", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-missing-identity-"));
		cleanups.push(root);
		const emptyBundle = join(root, "bundle");
		mkdirSync(emptyBundle);
		expect(() => computeSourceBuildId(root)).toThrow("Cannot fingerprint Prime Agent source");
		expect(() => computeBundleBuildId(emptyBundle)).toThrow("bundle contains no JavaScript files");
	});
});
