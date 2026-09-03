import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type ActiveOrphanProcessCandidate,
	enrollOrphanProcess,
	initializeOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	readActiveOrphanProcessCandidates,
	retireOrphanProcess,
} from "../src/core/orphan-process-journal.js";
import { observeProcessIdentity } from "../src/core/session-lease.js";

/**
 * Counts real reads of one journal file. `vi.spyOn` cannot redefine an ESM
 * builtin export, so `node:fs` is wrapped instead: every descriptor opened on
 * the journal pathname is tracked, and only reads against the journal path or
 * one of those descriptors is counted. Lock-file and claim-file reads, which
 * the append protocol still performs, are deliberately not counted.
 */
const journalReads = vi.hoisted(() => ({
	path: undefined as string | undefined,
	descriptors: new Set<number>(),
	count: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const openSync = ((target: unknown, ...rest: unknown[]) => {
		const descriptor = (actual.openSync as (...args: unknown[]) => number)(target, ...rest);
		if (typeof target === "string" && target === journalReads.path) journalReads.descriptors.add(descriptor);
		return descriptor;
	}) as typeof actual.openSync;
	const closeSync = ((descriptor: number) => {
		journalReads.descriptors.delete(descriptor);
		return actual.closeSync(descriptor);
	}) as typeof actual.closeSync;
	const readFileSync = ((target: unknown, ...rest: unknown[]) => {
		const isJournal =
			typeof target === "number" ? journalReads.descriptors.has(target) : target === journalReads.path;
		if (isJournal) journalReads.count += 1;
		return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
	}) as typeof actual.readFileSync;
	const readSync = ((descriptor: number, ...rest: unknown[]) => {
		if (journalReads.descriptors.has(descriptor)) journalReads.count += 1;
		return (actual.readSync as (...args: unknown[]) => number)(descriptor, ...rest);
	}) as typeof actual.readSync;
	const patched = { ...actual, openSync, closeSync, readFileSync, readSync };
	return { ...patched, default: patched };
});

const SYNTHETIC_PAIRS = 1_000;
const SYNTHETIC_LIVE = 5;
const SYNTHETIC_RECORDS = SYNTHETIC_PAIRS * 2 + SYNTHETIC_LIVE;
const THROUGHPUT_CYCLES = 200;
const THROUGHPUT_BATCH = 25;

const temporaryDirectories: string[] = [];
const spawnedChildren: Array<ChildProcess & { pid: number }> = [];
const originalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
const originalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];

afterAll(() => {
	for (const child of spawnedChildren.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	if (originalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalPath;
	if (originalGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = originalGeneration;
	journalReads.path = undefined;
	journalReads.descriptors.clear();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** One installed authority pre-loaded with `pairs * 2 + live` valid v2 records. */
function installJournal(label: string, pairs: number, live: number): string {
	const directory = mkdtempSync(join(tmpdir(), `prime-orphan-perf-${label}-`));
	temporaryDirectories.push(directory);
	const path = join(directory, "orphans.jsonl");
	const authority = initializeOrphanProcessJournal(path);
	let sequence = 0;
	const line = (pid: number, state: "enrolled" | "retired") => {
		sequence += 1;
		return JSON.stringify({
			version: 2,
			type: "process",
			generation: authority.generation,
			sequence,
			pid,
			ownerPid: process.pid,
			processStartId: `ps:lstart:synthetic-${String(pid).padStart(10, "0")}`,
			state,
			recordedAt: "2026-09-01T00:00:00.000Z",
		});
	};
	const lines: string[] = [];
	for (let index = 0; index < pairs; index += 1) {
		const pid = 800_000 + index;
		lines.push(line(pid, "enrolled"), line(pid, "retired"));
	}
	for (let index = 0; index < live; index += 1) lines.push(line(900_000 + index, "enrolled"));
	if (lines.length > 0) appendFileSync(path, `${lines.join("\n")}\n`);
	expect(sequence).toBe(pairs * 2 + live);
	process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
	process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
	journalReads.path = path;
	journalReads.descriptors.clear();
	return path;
}

function journalRecordCount(path: string): number {
	return readFileSync(path, "utf8").trimEnd().split("\n").length - 1;
}

/** A detached group leader with no children, so its group empties when it dies. */
function spawnDetachedSleeper(): ChildProcess & { pid: number } {
	const child = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
	child.unref();
	if (!child.pid) throw new Error("sleeper pid unavailable");
	const sleeper = child as ChildProcess & { pid: number };
	spawnedChildren.push(sleeper);
	return sleeper;
}

async function stopDetachedSleeper(child: ChildProcess & { pid: number }): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
	child.kill("SIGKILL");
	await exited;
}

/** One full enroll plus retire of a real detached child, timing only those calls. */
async function measureEnrollRetireMs(): Promise<number> {
	const child = spawnDetachedSleeper();
	warmIdentity(child.pid);
	const enrollStart = performance.now();
	const candidate = enrollOrphanProcess(child.pid);
	let elapsed = performance.now() - enrollStart;
	await stopDetachedSleeper(child);
	const retireStart = performance.now();
	expect(retireOrphanProcess(candidate)).toBe(true);
	return elapsed + (performance.now() - retireStart);
}

/** Warms the identity memo so the timed region never forks `/bin/ps`. */
function warmIdentity(pid: number): void {
	const observation = observeProcessIdentity(pid);
	if (observation.status !== "present-exact" && observation.status !== "present-coarse") {
		throw new Error(`sleeper ${pid} has no usable process identity: ${observation.status}`);
	}
}

describe.skipIf(process.platform === "win32")("orphan process journal append cost", () => {
	it("enrolls and retires against a 2,000-record journal without reading it", async () => {
		// Reference: the identical operation on an empty authority. Both cycles pay
		// the same six guard-protocol fsyncs, so the difference between them is the
		// entire cost of the journal's size, which is what must not scale.
		installJournal("reference", 0, 0);
		await measureEnrollRetireMs();
		const referenceSamples: number[] = [];
		for (let sample = 0; sample < 3; sample += 1) referenceSamples.push(await measureEnrollRetireMs());
		const referenceMs = referenceSamples.sort((left, right) => left - right)[1] as number;

		const path = installJournal("noread", SYNTHETIC_PAIRS, SYNTHETIC_LIVE);
		const beforeBytes = statSync(path).size;
		expect(journalRecordCount(path)).toBe(SYNTHETIC_RECORDS);
		expect(beforeBytes).toBeGreaterThan(256 * 1024);

		// One cold enroll loads the reduction; the file is never read again.
		const warmChild = spawnDetachedSleeper();
		warmIdentity(warmChild.pid);
		const warmCandidate = enrollOrphanProcess(warmChild.pid);
		expect(journalReads.count).toBeGreaterThan(0);

		const measuredChild = spawnDetachedSleeper();
		warmIdentity(measuredChild.pid);
		journalReads.count = 0;
		const enrollStart = performance.now();
		const candidate = enrollOrphanProcess(measuredChild.pid);
		const enrollMs = performance.now() - enrollStart;
		const readsAfterEnroll = journalReads.count;

		await stopDetachedSleeper(measuredChild);
		const retireStart = performance.now();
		expect(retireOrphanProcess(candidate)).toBe(true);
		const retireMs = performance.now() - retireStart;

		const measuredReads = journalReads.count;
		const measuredMs = enrollMs + retireMs;
		expect(readsAfterEnroll).toBe(0);
		expect(measuredReads).toBe(0);
		// A 2,005-record, 460 KB journal must add well under 50 ms over the empty
		// one; the absolute ceiling only catches a return to O(journal) work.
		expect(measuredMs - referenceMs).toBeLessThan(50);
		expect(measuredMs).toBeLessThan(250);

		// The retire compacted the log; a fresh strict read of the file must still
		// return exactly the live set this process holds in memory.
		const afterBytes = statSync(path).size;
		expect(afterBytes).toBeLessThan(beforeBytes / 100);
		expect(journalRecordCount(path)).toBe(SYNTHETIC_LIVE + 1);
		const recovered = readActiveOrphanProcessCandidates(path);
		expect(recovered).toHaveLength(SYNTHETIC_LIVE + 1);
		expect(recovered).toContainEqual(warmCandidate);
		expect(recovered.some((entry) => entry.pid === candidate.pid)).toBe(false);

		console.log(
			`[after] ${SYNTHETIC_RECORDS}-record journal (${beforeBytes} B): enroll ${enrollMs.toFixed(
				2,
			)} ms + retire ${retireMs.toFixed(2)} ms = ${measuredMs.toFixed(2)} ms, ` +
				`empty-journal reference ${referenceMs.toFixed(2)} ms, size-attributable ${(
					measuredMs - referenceMs
				).toFixed(2)} ms, journal reads ${measuredReads}, ` +
				`compacted to ${afterBytes} B / ${journalRecordCount(path)} records`,
		);
	}, 120_000);

	it("sustains 200 enroll and retire cycles on that journal", async () => {
		const path = installJournal("throughput", SYNTHETIC_PAIRS, SYNTHETIC_LIVE);
		const beforeBytes = statSync(path).size;
		let elapsedMs = 0;
		let completed = 0;

		for (let start = 0; start < THROUGHPUT_CYCLES; start += THROUGHPUT_BATCH) {
			const size = Math.min(THROUGHPUT_BATCH, THROUGHPUT_CYCLES - start);
			const children = Array.from({ length: size }, () => spawnDetachedSleeper());
			for (const child of children) warmIdentity(child.pid);

			const candidates: ActiveOrphanProcessCandidate[] = [];
			const enrollStart = performance.now();
			for (const child of children) candidates.push(enrollOrphanProcess(child.pid));
			elapsedMs += performance.now() - enrollStart;

			for (const child of children) await stopDetachedSleeper(child);

			const retireStart = performance.now();
			for (const candidate of candidates) {
				if (retireOrphanProcess(candidate)) completed += 1;
			}
			elapsedMs += performance.now() - retireStart;
		}

		expect(completed).toBe(THROUGHPUT_CYCLES);
		expect(readActiveOrphanProcessCandidates(path)).toHaveLength(SYNTHETIC_LIVE);
		console.log(
			`[after] ${THROUGHPUT_CYCLES} enroll+retire cycles on a ${beforeBytes} B / ${SYNTHETIC_RECORDS}-record ` +
				`journal: ${elapsedMs.toFixed(1)} ms total, ${(elapsedMs / THROUGHPUT_CYCLES).toFixed(3)} ms per cycle, ` +
				`journal ends at ${statSync(path).size} B / ${journalRecordCount(path)} records`,
		);
	}, 300_000);
});
