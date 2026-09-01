import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsJobHelperPath } from "../src/core/kernel/bootstrap.js";
import * as orphanJournal from "../src/core/orphan-process-journal.js";
import {
	initializeOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
} from "../src/core/orphan-process-journal.js";
import { createProcessIdentityOwnerToken, isExactProcessStartId } from "../src/core/session-lease.js";
import {
	createWindowsJobHelperEnvironment,
	parseWindowsJobFrame,
	prepareWindowsJobHelperLaunch,
	WindowsJobFrameValidator,
	windowsJobFramesProveExactDeath,
} from "../src/utils/contained-shell.js";
import {
	enrollTrackedDetachedChildPid,
	type TrackedDetachedChildEnrollment,
	untrackDetachedChildPid,
	untrackDetachedChildPidAfterHeldWindowsJobEmpty,
} from "../src/utils/shell.js";

const NONCE = "a".repeat(64);
const START_ID = "win:638000000000000000";

function readyRecord(nonce = NONCE, pid = 4242, processStartId = START_ID) {
	return {
		primeAgentWindowsJob: 1,
		type: "ready",
		nonce,
		pid,
		processStartId,
		jobContained: true,
	};
}

function doneRecord(nonce = NONCE, pid = 4242, processStartId = START_ID) {
	return {
		primeAgentWindowsJob: 1,
		type: "done",
		nonce,
		pid,
		processStartId,
		exitCode: 0,
		leaderDead: true,
		jobEmpty: true,
		jobTerminationAttempted: true,
		jobTerminationSucceeded: false,
		taskkillFallbackAttempted: true,
	};
}

describe("Windows host process containment protocol", () => {
	it("accepts only exact nonce-bound ready and exact-death done fixtures", () => {
		const ready = parseWindowsJobFrame(JSON.stringify(readyRecord()), NONCE);
		expect(ready).toMatchObject({ type: "ready", nonce: NONCE, pid: 4242, jobContained: true });
		expect(() => parseWindowsJobFrame(JSON.stringify({ ...readyRecord(), nonce: "b".repeat(64) }), NONCE)).toThrow(
			"nonce mismatch",
		);
		expect(() => parseWindowsJobFrame(JSON.stringify({ ...readyRecord(), primeAgentWindowsJob: 2 }), NONCE)).toThrow(
			"unsupported protocol version",
		);
		expect(() => parseWindowsJobFrame(JSON.stringify({ ...readyRecord(), jobContained: false }), NONCE)).toThrow(
			"malformed ready proof",
		);
		expect(() => parseWindowsJobFrame(JSON.stringify({ ...readyRecord(), extraAuthority: true }), NONCE)).toThrow(
			"malformed ready proof",
		);

		const done = parseWindowsJobFrame(JSON.stringify(doneRecord()), NONCE);
		expect(done).toMatchObject({ type: "done", nonce: NONCE, leaderDead: true, jobEmpty: true });
		expect(ready).toBeDefined();
		expect(done).toBeDefined();
		expect(windowsJobFramesProveExactDeath(done!, ready!)).toBe(true);
		expect(
			windowsJobFramesProveExactDeath(
				parseWindowsJobFrame(JSON.stringify(doneRecord("b".repeat(64))), "b".repeat(64))!,
				ready!,
			),
		).toBe(false);

		const taskkillWithoutJobProof = parseWindowsJobFrame(JSON.stringify({ ...doneRecord(), jobEmpty: false }), NONCE);
		expect(taskkillWithoutJobProof).toBeDefined();
		expect(windowsJobFramesProveExactDeath(taskkillWithoutJobProof!, ready!)).toBe(false);
	});

	it("uses the central canonical Windows identity grammar for authority frames", () => {
		for (const processStartId of ["win:0", `win:${"1".repeat(32)}`]) {
			expect(isExactProcessStartId(processStartId)).toBe(true);
			expect(parseWindowsJobFrame(JSON.stringify(readyRecord(NONCE, 4242, processStartId)), NONCE)).toBeDefined();
		}
		for (const processStartId of ["win:000123", `win:${"1".repeat(33)}`, "win:１２３", "win:"]) {
			expect(isExactProcessStartId(processStartId)).toBe(false);
			expect(() => parseWindowsJobFrame(JSON.stringify(readyRecord(NONCE, 4242, processStartId)), NONCE)).toThrow(
				"malformed ready proof",
			);
			expect(() => parseWindowsJobFrame(JSON.stringify(doneRecord(NONCE, 4242, processStartId)), NONCE)).toThrow(
				"malformed done proof",
			);
		}
	});

	it("rejects forged, duplicate, wrong-PID, and out-of-order authority transitions", () => {
		const ready = parseWindowsJobFrame(JSON.stringify(readyRecord()), NONCE)!;
		const released = parseWindowsJobFrame(
			JSON.stringify({
				primeAgentWindowsJob: 1,
				type: "released",
				nonce: NONCE,
				pid: 4242,
				processStartId: START_ID,
			}),
			NONCE,
		)!;
		const done = parseWindowsJobFrame(JSON.stringify(doneRecord()), NONCE)!;
		if (released.type !== "released") throw new Error("fixture did not parse as released");

		const normal = new WindowsJobFrameValidator(NONCE);
		normal.accept(ready);
		expect(() => normal.accept(released)).toThrow("released out of sequence");
		normal.noteReleaseRequested();
		expect(() => normal.accept({ ...released, pid: 4243 })).toThrow("wrong process");
		normal.accept(released);
		normal.accept(done);
		expect(() => normal.accept(done)).toThrow("terminal proof");

		// A terminate written after release stays ordered behind it on the same pipe.
		const releaseThenTerminate = new WindowsJobFrameValidator(NONCE);
		releaseThenTerminate.accept(ready);
		releaseThenTerminate.noteReleaseRequested();
		releaseThenTerminate.noteTerminationRequested();
		releaseThenTerminate.accept(released);
		releaseThenTerminate.accept(done);

		const noRelease = new WindowsJobFrameValidator(NONCE);
		noRelease.accept(ready);
		noRelease.noteReleaseRequested();
		expect(() => noRelease.accept(done)).toThrow("before release");

		const setupFailure = new WindowsJobFrameValidator(NONCE);
		setupFailure.accept(
			parseWindowsJobFrame(
				JSON.stringify({
					primeAgentWindowsJob: 1,
					type: "error",
					nonce: NONCE,
					stage: "containment",
					message: "failed",
				}),
				NONCE,
			)!,
		);
		setupFailure.accept(
			parseWindowsJobFrame(
				JSON.stringify({
					primeAgentWindowsJob: 1,
					type: "setup-done",
					nonce: NONCE,
					pid: 4242,
					leaderDead: true,
					jobEmpty: true,
					jobTerminationAttempted: true,
					jobTerminationSucceeded: true,
					taskkillFallbackAttempted: false,
				}),
				NONCE,
			)!,
		);
	});

	it("resolves the exact standalone helper and never imports the rlm package bootstrap", async () => {
		const helper = await resolveWindowsJobHelperPath();
		const source = readFileSync(helper, "utf8");

		expect(helper.replaceAll("\\", "/")).toMatch(/prime-agent-runtime\/src\/rlm\/_winjob\.py$/);
		expect(source).toContain('if __name__ == "__main__":');
		expect(source).not.toMatch(/^\s*(?:from|import)\s+rlm\b/m);
		const createJob = source.indexOf("self.job = create_job()", source.indexOf("def run(self)"));
		const suspendedTarget = source.indexOf("self.proc = spawn_in_job(", createJob);
		const ready = source.indexOf('"ready",', suspendedTarget);
		const resume = source.indexOf("if not self.proc.resume()", ready);
		expect(createJob).toBeGreaterThan(0);
		expect(suspendedTarget).toBeGreaterThan(createJob);
		expect(ready).toBeGreaterThan(suspendedTarget);
		expect(resume).toBeGreaterThan(ready);
	});

	it("treats a configured interpreter as data and scrubs all site/loader/authority routing", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-windows-helper-launch-"));
		const configuredPython = join(root, "configured-python.exe");
		const marker = join(root, "executed.txt");
		const previousPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		writeFileSync(configuredPython, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\n`);
		chmodSync(configuredPython, 0o700);
		process.env.PRIME_AGENT_KERNEL_PYTHON = configuredPython;
		try {
			const launch = await prepareWindowsJobHelperLaunch({
				SystemRoot: "C:\\Windows",
				PATH: `${root};C:\\Windows\\System32`,
				ComSpec: join(root, "cmd.exe"),
				PYTHONPATH: root,
				PYTHONHOME: root,
				PYTHONSTARTUP: marker,
				VIRTUAL_ENV: root,
				LD_PRELOAD: marker,
				DYLD_INSERT_LIBRARIES: marker,
				PRIME_AGENT_ORPHAN_PROCESS_JOURNAL: marker,
				PRIME_AGENT_ORPHAN_PROCESS_JOURNAL_GENERATION: "forged",
			});

			expect(launch.python).not.toBe(configuredPython);
			expect(launch.python.replaceAll("\\", "/")).toMatch(/kernel-venv\/Scripts\/python\.exe$/);
			expect(launch.args.slice(0, 4)).toEqual(["-I", "-S", "-X", "utf8"]);
			expect(launch.args.at(-1)).toBe(launch.helper);
			expect(launch.cwd).toBe(join(launch.helper, ".."));
			expect(existsSync(marker)).toBe(false);
			expect(launch.env).toEqual({
				SystemRoot: "C:\\Windows",
				WINDIR: "C:\\Windows",
				PATH: "C:\\Windows\\System32",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				NoDefaultCurrentDirectoryInExePath: "1",
			});
			expect(Object.keys(launch.env).some((key) => key.toUpperCase().startsWith("PYTHON"))).toBe(false);
		} finally {
			if (previousPython === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
			else process.env.PRIME_AGENT_KERNEL_PYTHON = previousPython;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses a canonical bounded Windows helper environment without inherited user routing", () => {
		expect(
			createWindowsJobHelperEnvironment({
				systemroot: "D:\\Windows\\",
				Path: "C:\\attacker",
				COMSPEC: "C:\\attacker\\cmd.exe",
			}),
		).toEqual({
			SystemRoot: "C:\\Windows",
			WINDIR: "C:\\Windows",
			PATH: "C:\\Windows\\System32",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			NoDefaultCurrentDirectoryInExePath: "1",
		});
	});

	it("retires the captured Windows enrollment only through explicit held-Job proof", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-windows-untrack-"));
		const journalPath = join(root, "orphans.jsonl");
		const previousPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const previousGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		const previousTitle = process.title;
		let platform: ReturnType<typeof vi.spyOn> | undefined;
		let enrollment: TrackedDetachedChildEnrollment | undefined;
		try {
			if (process.platform === "darwin") process.title = createProcessIdentityOwnerToken().argument;
			const authority = initializeOrphanProcessJournal(journalPath);
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = authority.path;
			process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
			enrollment = enrollTrackedDetachedChildPid(process.pid, () => {});
			expect(isExactProcessStartId(enrollment.processStartId)).toBe(true);
			expect(Object.isFrozen(enrollment)).toBe(true);

			platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			expect(untrackDetachedChildPid(enrollment)).toBe(false);
			expect(untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollment)).toBe(true);
			const states = readFileSync(journalPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string; state?: string })
				.filter((record) => record.type === "process")
				.map((record) => record.state);
			expect(states).toEqual(["enrolled", "retired"]);
		} finally {
			if (platform && enrollment) {
				try {
					untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollment);
				} catch {
					// Best-effort test-state cleanup; the assertion retains the original failure.
				}
			}
			platform?.mockRestore();
			process.title = previousTitle;
			if (previousPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousPath;
			if (previousGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = previousGeneration;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a late A proof cannot retire or delete PID-reused enrollment B", () => {
		const pid = 4242;
		const candidateA = { pid, processStartId: "win:638000000000000001" };
		const candidateB = { pid, processStartId: "win:638000000000000002" };
		const enroll = vi
			.spyOn(orphanJournal, "enrollOrphanProcess")
			.mockReturnValueOnce(candidateA)
			.mockReturnValueOnce(candidateB);
		const retire = vi.spyOn(orphanJournal, "retireOrphanProcessAfterHeldWindowsJobEmpty").mockReturnValue(true);
		let enrollmentA: TrackedDetachedChildEnrollment | undefined;
		let enrollmentB: TrackedDetachedChildEnrollment | undefined;
		try {
			enrollmentA = enrollTrackedDetachedChildPid(pid, () => {});
			enrollmentB = enrollTrackedDetachedChildPid(pid, () => {});

			expect(untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollmentA)).toBe(true);
			expect(retire).toHaveBeenNthCalledWith(1, candidateA);
			expect(untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollmentB)).toBe(true);
			expect(retire).toHaveBeenNthCalledWith(2, candidateB);
		} finally {
			if (enrollmentA) untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollmentA);
			if (enrollmentB) untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollmentB);
			retire.mockRestore();
			enroll.mockRestore();
		}
	});

	it("uses only canonical bounded taskkill after Job termination failure", async () => {
		const source = readFileSync(await resolveWindowsJobHelperPath(), "utf8");
		const terminate = source.indexOf("terminate(self.job)");
		const fallbackGuard = source.indexOf("if not self.cleanup_termination_succeeded:", terminate);
		const taskkill = source.indexOf("self.taskkill_tree(pid)", fallbackGuard);
		const proof = source.indexOf('"jobEmpty": self.wait_job_empty(max(0.0, timeout))', taskkill);

		expect(terminate).toBeGreaterThan(0);
		expect(fallbackGuard).toBeGreaterThan(terminate);
		expect(taskkill).toBeGreaterThan(fallbackGuard);
		expect(proof).toBeGreaterThan(taskkill);
		expect(source).toContain('self.system32_path("taskkill.exe")');
		expect(source).toContain("shell=False");
		expect(source).toContain("taskkill/TerminateJobObject delivery is never proof.");
	});
});
