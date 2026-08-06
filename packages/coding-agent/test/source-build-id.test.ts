import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertExpectedDaemonBuildIdentity,
	PRIME_AGENT_BUILD_ID_ENV,
	PRIME_AGENT_EXPECTED_BUILD_ID_ENV,
	PRIME_AGENT_LAUNCHER_PATH_ENV,
	recomputeSourceBuildId,
} from "../src/modes/daemon/daemon-runtime-identity.js";
import { assertDaemonWorkerRuntimeIdentity } from "../src/modes/daemon/daemon-supervisor.js";

const helper = resolve(import.meta.dirname, "../../../scripts/source-build-id.mjs");

function run(command: string, args: string[], cwd: string): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
	return result.stdout.trim();
}

describe("source build identity", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("rejects new and recovered workers whose source build differs from the supervisor", () => {
		const supervisor = { buildId: "H1", executablePath: "/node" };
		expect(() =>
			assertDaemonWorkerRuntimeIdentity({ buildId: "H1", executablePath: "/node" }, supervisor),
		).not.toThrow();
		expect(() => assertDaemonWorkerRuntimeIdentity({ buildId: "H2", executablePath: "/node" }, supervisor)).toThrow(
			"worker=H2, supervisor=H1",
		);
		expect(() => assertDaemonWorkerRuntimeIdentity(undefined, supervisor)).toThrow("worker=missing");
		expect(() =>
			assertExpectedDaemonBuildIdentity({
				[PRIME_AGENT_BUILD_ID_ENV]: "H1",
				[PRIME_AGENT_EXPECTED_BUILD_ID_ENV]: "H1",
			}),
		).not.toThrow();
		expect(() =>
			assertExpectedDaemonBuildIdentity({
				[PRIME_AGENT_BUILD_ID_ENV]: "H2",
				[PRIME_AGENT_EXPECTED_BUILD_ID_ENV]: "H1",
			}),
		).toThrow("Refusing daemon ownership for build H2; expected H1");
	});

	it("fails closed when a source launcher cannot recompute its worker identity", () => {
		root = join(tmpdir(), `prime-source-build-id-missing-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
		const launcher = join(root, "prime-agent.sh");
		writeFileSync(launcher, "#!/bin/sh\n");
		expect(() => recomputeSourceBuildId({ [PRIME_AGENT_LAUNCHER_PATH_ENV]: launcher })).toThrow(
			"Cannot attest source worker build: missing",
		);
	});

	it("keeps clean builds stable and changes across tracked and untracked dirty source edits", () => {
		root = join(tmpdir(), `prime-source-build-id-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
		run("git", ["init", "-q"], root);
		run("git", ["config", "user.email", "test@example.invalid"], root);
		run("git", ["config", "user.name", "Prime Test"], root);
		writeFileSync(join(root, "tracked.ts"), "one\n");
		writeFileSync(join(root, "prime-agent.sh"), "#!/bin/sh\n");
		mkdirSync(join(root, "scripts"));
		copyFileSync(helper, join(root, "scripts", "source-build-id.mjs"));
		run("git", ["add", "."], root);
		run("git", ["commit", "-qm", "initial"], root);

		const environment = { [PRIME_AGENT_LAUNCHER_PATH_ENV]: join(root, "prime-agent.sh") };
		const clean = run(process.execPath, [helper, root], root);
		expect(clean).not.toContain("-dirty.");
		expect(run(process.execPath, [helper, root], root)).toBe(clean);
		expect(recomputeSourceBuildId(environment)).toBe(clean);

		writeFileSync(join(root, "tracked.ts"), "two\n");
		const trackedDirty = run(process.execPath, [helper, root], root);
		expect(recomputeSourceBuildId(environment)).toBe(trackedDirty);
		expect(() =>
			assertDaemonWorkerRuntimeIdentity(
				{ buildId: trackedDirty, executablePath: "/node" },
				{ buildId: clean, executablePath: "/node" },
			),
		).toThrow(`worker=${trackedDirty}, supervisor=${clean}`);
		expect(trackedDirty).not.toBe(clean);
		expect(run(process.execPath, [helper, root], root)).toBe(trackedDirty);
		writeFileSync(join(root, "tracked.ts"), "three\n");
		const trackedDirtyAgain = run(process.execPath, [helper, root], root);
		expect(trackedDirtyAgain).not.toBe(trackedDirty);

		writeFileSync(join(root, "new.ts"), "new one\n");
		const untrackedOne = run(process.execPath, [helper, root], root);
		writeFileSync(join(root, "new.ts"), "new two\n");
		const untrackedTwo = run(process.execPath, [helper, root], root);
		expect(untrackedOne).not.toBe(trackedDirtyAgain);
		expect(untrackedTwo).not.toBe(untrackedOne);
		expect(readFileSync(join(root, "new.ts"), "utf8")).toBe("new two\n");
	});
});
