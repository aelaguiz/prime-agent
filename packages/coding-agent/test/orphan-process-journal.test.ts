import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bindOrUpgradeOrphanProcessJournalAuthority,
	clearOrphanProcessJournal,
	enrollOrphanProcess,
	initializeOrphanProcessJournal,
	isOrphanProcessCandidateExactDead,
	isOrphanProcessGroupAlive,
	isOrphanProcessIdentityCurrent,
	isOrphanProcessTreeAlive,
	type KernelAdmissionLineage,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	parseOrphanProcessJournalAppendLockRecord,
	readActiveOrphanProcessCandidates,
	readActiveOrphanProcesses,
	readOrphanProcessJournalAppendLock,
	readStrictEmptyOrphanProcessJournalAuthority,
	reapKernelOrphanProcesses,
	reapOrphanProcessAuthority,
	reapOrphanProcessCandidate,
	retireOrphanProcess,
	retireOrphanProcessAfterHeldWindowsJobEmpty,
	shouldReapOrphanProcess,
} from "../src/core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	isExactProcessStartId,
	observeProcessIdentity,
	projectLegacyProcessStartId,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];
const spawnedProcessAuthorities = new Map<number, string>();
const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../..");
const pythonExecutable = join(repositoryRoot, "prime-agent-runtime/.venv/bin/python");
const pythonWriter = join(testDirectory, "fixtures/orphan-journal-python-writer.py");

const LINUX_BOOT_A = "11111111-2222-3333-4444-555555555555";
const LINUX_BOOT_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const exactProc = (ticks: string, bootId = LINUX_BOOT_A) => `proc:${bootId}:${ticks}`;
const safeJournalLegacyProjection = (exactId: string) => {
	const legacy = projectLegacyProcessStartId(exactId);
	return legacy === exactId ? legacy : undefined;
};
const legacyFieldCouldAuthorizeDirectEquality = (stored: unknown, observed: string) =>
	typeof stored === "string" && /^(?:(?:proc|win):\d+|token:[a-f0-9]{64})$/.test(stored) && stored === observed;
type Frozen849c92114V1Record = {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
};

function readFrozen849c92114V1Records(
	contents: string,
	ownerPid: number,
): Array<{ pid: number; processStartId: string }> {
	const latest = new Map<number, Frozen849c92114V1Record>();
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as Partial<Frozen849c92114V1Record>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as Frozen849c92114V1Record);
			}
		} catch {
			// Exact 849c92114 behavior ignored malformed lines.
		}
	}
	return [...latest.values()]
		.filter(
			(record): record is Frozen849c92114V1Record & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

function testKernelLineage(
	kernelPid: number,
	kernelProcessStartId = exactProc("1"),
	kernelLineage = "a".repeat(64),
): KernelAdmissionLineage {
	return {
		admissionGeneration: "12345678-1234-4234-8234-123456789abc",
		kernelLineage,
		kernelPid,
		kernelProcessStartId,
	};
}

function spawnExactDetachedChild(): ChildProcess & { pid: number } {
	const identity = createProcessIdentityOwnerToken();
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", identity.argument], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (!child.pid) throw new Error("child pid unavailable");
	const observation = observeProcessIdentity(child.pid);
	if (observation.status !== "present-exact") throw new Error("child exact teardown authority unavailable");
	spawnedProcessAuthorities.set(child.pid, observation.id);
	spawnedChildren.push(child);
	return child as ChildProcess & { pid: number };
}

function killTestProcessGroup(pid: number): void {
	const exactId = spawnedProcessAuthorities.get(pid);
	const observation = observeProcessIdentity(pid);
	if (observation.status === "absent") return;
	if (!exactId || observation.status !== "present-exact" || observation.id !== exactId) {
		throw new Error(`Retained cleanup artifact for pid ${pid}: exact identity mismatch or unavailable`);
	}
	process.kill(-pid, "SIGKILL");
}

async function stopDetachedChild(child: ChildProcess & { pid: number }): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	killTestProcessGroup(child.pid);
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, 2_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function validLockRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const expired = new Date(Date.now() - 60_000).toISOString();
	return {
		version: 1,
		ownerPid: 2_000_000_000,
		processStartId: "proc:1",
		token: "a".repeat(64),
		createdAt: expired,
		expiresAt: expired,
		...overrides,
	};
}

function runPythonWriter(
	path: string,
	generation: string,
	count: number,
	readyPath = "-",
): { process: ChildProcess; complete: Promise<string> } {
	const writerIdentity = createProcessIdentityOwnerToken();
	const child = spawn(
		pythonExecutable,
		[pythonWriter, path, generation, String(count), readyPath, writerIdentity.argument],
		{
			env: {
				...process.env,
				PYTHONPATH: join(repositoryRoot, "prime-agent-runtime/src"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const complete = new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`Python journal writer exited ${code}: ${stderr}`));
		});
	});
	return { process: child, complete };
}

async function waitForPath(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
const originalJournalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];

afterEach(() => {
	if (originalJournalPath === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournalPath;
	}
	if (originalJournalGeneration === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = originalJournalGeneration;
	}
	for (const child of spawnedChildren.splice(0)) {
		if (child.pid && child.exitCode === null && child.signalCode === null) killTestProcessGroup(child.pid);
	}
	spawnedProcessAuthorities.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("orphan process journal", () => {
	it("requires initialized authority for strict cleanup while tolerant diagnostics allow a missing file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");

		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/ENOENT/);
		await expect(reapOrphanProcessAuthority(path)).resolves.toBe(false);

		initializeOrphanProcessJournal(path);
		expect(readActiveOrphanProcessCandidates(path)).toEqual([]);
		await expect(reapOrphanProcessAuthority(path)).resolves.toBe(true);
	});

	it("reads a strict empty generation while holding the canonical writer lock", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-strict-read-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		let observedLock = false;

		const result = readStrictEmptyOrphanProcessJournalAuthority(path, {
			whileLocked: () => {
				observedLock = existsSync(`${path}.append.lock`);
			},
		});

		expect(observedLock).toBe(true);
		expect(result).toMatchObject({ generation: authority.generation });
		expect(existsSync(`${path}.append.lock`)).toBe(false);
	});

	it("keeps a canonical successor that appears after journal quarantine", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-successor-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const original = initializeOrphanProcessJournal(path);
		let successorGeneration: string | undefined;

		const cleared = clearOrphanProcessJournal(path, original.generation, undefined, {
			afterQuarantine: () => {
				expect(existsSync(`${path}.append.lock`)).toBe(true);
				successorGeneration = initializeOrphanProcessJournal(path).generation;
			},
		});

		expect(cleared).toBe(false);
		expect(successorGeneration).toBeTruthy();
		expect(readStrictEmptyOrphanProcessJournalAuthority(path).generation).toBe(successorGeneration);
		expect(readdirSync(directory).filter((name) => name.includes(".quarantine-"))).toEqual([]);
	});

	it("keeps bare-PID signal primitives private to the canonical reaper", () => {
		const source = readFileSync(join(testDirectory, "../src/core/orphan-process-journal.ts"), "utf8");
		expect(source).not.toMatch(
			/export function (?:signalOrphanProcessGroup|killOrphanProcessGroup|killOrphanProcess)\(/,
		);
	});

	it("rejects orphan enrollment when the expected process identity changed", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-identity-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		const before = readFileSync(path, "utf8");

		expect(() => enrollOrphanProcess(process.pid, undefined, "impossible-process-identity")).toThrow(
			`Process identity changed before orphan enrollment for pid ${process.pid}`,
		);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("enrolls in one generation and retires only after exact tree death", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;

		const child = spawnExactDetachedChild();
		expect(child.pid).toBeTypeOf("number");
		const lineage = testKernelLineage(process.pid);
		const candidate = enrollOrphanProcess(child.pid!, undefined, undefined, lineage);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([candidate]);
		expect(retireOrphanProcess(candidate)).toBe(false);

		killTestProcessGroup(child.pid!);
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(retireOrphanProcess(candidate)).toBe(true);
		expect(readActiveOrphanProcesses(path, process.pid)).toEqual([]);
		const transitions = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown> & { sequence: number });
		expect(transitions.map((record) => record.sequence)).toEqual([0, 1, 2]);
		for (const record of transitions.slice(1)) {
			if (candidate.processStartId && isExactProcessStartId(candidate.processStartId)) {
				expect(record.authorityProcessStartId).toBe(candidate.processStartId);
				expect(record.processStartId).toBe(safeJournalLegacyProjection(candidate.processStartId));
			} else {
				expect(record.authorityProcessStartId).toBeUndefined();
				expect(record.processStartId).toBe(candidate.processStartId);
			}
			expect(record.kernelAuthorityProcessStartId).toBe(lineage.kernelProcessStartId);
			expect(record.kernelProcessStartId).toBe(safeJournalLegacyProjection(lineage.kernelProcessStartId));
			expect(legacyFieldCouldAuthorizeDirectEquality(record.kernelProcessStartId, "proc:1")).toBe(false);
		}
		expect(clearOrphanProcessJournal(path, authority.generation)).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("retains only byte-bounded historical generic ps hints without authorizing signals", () => {
		const retained = ["ps:historical-value", "ps:lstart:Mon Sep 1 03:00:00 2026", `ps:${"é".repeat(512)}`];
		const rejected = [
			"ps:",
			"ps:tab\tvalue",
			"ps:c1\u0085value",
			"ps:line\nvalue",
			"ps:nul\0value",
			`ps:${"é".repeat(513)}`,
			`ps:${"a".repeat(1_025)}`,
			"ps:\ud800",
		];
		for (const [index, value] of [...retained, ...rejected].entries()) {
			const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-coarse-retention-"));
			tempDirs.push(directory);
			const path = join(directory, "orphans.jsonl");
			writeFileSync(
				path,
				`${JSON.stringify({
					version: 1,
					pid: 1_000 + index,
					ownerPid: process.pid,
					processStartId: value,
					active: true,
					recordedAt: new Date().toISOString(),
				})}\n`,
			);
			if (index < retained.length) {
				const candidates = readActiveOrphanProcessCandidates(path);
				expect(candidates).toHaveLength(1);
				expect(shouldReapOrphanProcess(candidates[0]!)).toBe(false);
			} else {
				expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/unrecognized complete record/);
			}
		}
	});

	it("the frozen 849c92114 v1 reader structurally ignores v2 authority without signaling", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-v1-reader-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		const child = spawnExactDetachedChild();
		enrollOrphanProcess(child.pid);
		const before = readFileSync(path, "utf8");
		const frozenRecords = readFrozen849c92114V1Records(before, process.pid);
		expect(frozenRecords).toEqual([]);
		const signal = vi.fn((_pid: number, _signal: NodeJS.Signals) => true);
		for (const record of frozenRecords) signal(record.pid, "SIGKILL");
		expect(signal).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(before);
		await stopDetachedChild(child);
	});

	it("keeps active records from every owner generation and tolerates a truncated final append", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const base = { version: 1, pid: process.pid, recordedAt: new Date().toISOString() };
		appendFileSync(
			path,
			`${JSON.stringify({ ...base, ownerPid: 101, processStartId: "ps:generation-a", active: true })}\n`,
		);
		appendFileSync(
			path,
			`${JSON.stringify({
				...base,
				ownerPid: 202,
				kernelPid: 303,
				processStartId: "ps:generation-b",
				active: true,
			})}\n`,
		);
		appendFileSync(path, '{"version":1,"pid":');

		expect(readActiveOrphanProcessCandidates(path)).toEqual([
			{ pid: process.pid, processStartId: "ps:generation-a" },
			{ pid: process.pid, kernelPid: 303, processStartId: "ps:generation-b" },
		]);

		// A legacy inactive hint cannot erase either owner generation.
		writeFileSync(
			path,
			[
				JSON.stringify({ ...base, ownerPid: 101, processStartId: "ps:generation-a", active: true }),
				JSON.stringify({ ...base, ownerPid: 202, processStartId: "ps:generation-b", active: true }),
				JSON.stringify({ ...base, ownerPid: 202, active: false }),
				"",
			].join("\n"),
		);
		expect(readActiveOrphanProcessCandidates(path)).toEqual([
			{ pid: process.pid, processStartId: "ps:generation-a" },
			{ pid: process.pid, processStartId: "ps:generation-b" },
		]);
	});

	it("upgrades only exact-dead legacy authority and keeps inactive hints enrolled", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const legacy = {
			version: 1,
			pid: 2_000_000_000,
			ownerPid: 2_000_000_001,
			processStartId: "proc:1",
			recordedAt: new Date(0).toISOString(),
		};
		writeFileSync(
			path,
			`${JSON.stringify({ ...legacy, active: true })}\n${JSON.stringify({ ...legacy, active: false })}\n`,
		);
		const authority = bindOrUpgradeOrphanProcessJournalAuthority(path, undefined);
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sequence?: number; type?: string });
		expect(records.at(-1)).toMatchObject({ type: "authority", sequence: 0 });
		expect(readActiveOrphanProcessCandidates(path)).toEqual([
			{ pid: legacy.pid, processStartId: legacy.processStartId },
		]);
		expect(clearOrphanProcessJournal(path, authority.generation)).toBe(true);
	});

	it("fails closed on generation replacement and never recreates a configured authority", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		expect(() => bindOrUpgradeOrphanProcessJournalAuthority(path, undefined)).toThrow(
			/expected generation legacy-v1/,
		);
		await expect(reapOrphanProcessAuthority(path, { expectedGeneration: undefined })).resolves.toBe(false);
		expect(clearOrphanProcessJournal(path, undefined)).toBe(false);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = "";
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = "";
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/Incomplete orphan process journal authority/);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		rmSync(path, { force: true });
		const replacement = initializeOrphanProcessJournal(path);
		expect(replacement.generation).not.toBe(authority.generation);
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/expected generation/);
		expect(readFileSync(path, "utf8")).toContain(replacement.generation);

		rmSync(path, { force: true });
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/ENOENT/);
		expect(existsSync(path)).toBe(false);
	});

	it("retries descriptor-first legacy generation binding without adopting v2", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-upgrade-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		writeFileSync(path, "");
		let preparedGeneration: string | undefined;
		expect(() =>
			bindOrUpgradeOrphanProcessJournalAuthority(path, undefined, (generation) => {
				preparedGeneration = generation;
				throw new Error("descriptor persistence interrupted");
			}),
		).toThrow("descriptor persistence interrupted");
		expect(preparedGeneration).toBeTruthy();
		expect(readFileSync(path, "utf8")).toBe("");
		writeFileSync(path, `{"version":2,"type":"authority","generation":"${preparedGeneration}","sequence":`);
		const rebound = bindOrUpgradeOrphanProcessJournalAuthority(path, preparedGeneration);
		expect(rebound.generation).toBe(preparedGeneration);
		expect(readFileSync(path, "utf8")).toContain(preparedGeneration);
	});

	it("reclaims only an expired lock whose owner is exact-dead and accepts staged UUID tokens", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-lock-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		const lockPath = `${path}.append.lock`;
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		const currentIdentity = observeProcessIdentity(process.pid);
		const identityFields =
			currentIdentity.status === "present-exact"
				? { processStartId: currentIdentity.id }
				: currentIdentity.status === "present-coarse"
					? { processIdentityHint: currentIdentity.hint }
					: {};
		writeFileSync(
			lockPath,
			`${JSON.stringify(
				validLockRecord({
					ownerPid: process.pid,
					...identityFields,
					processStartId: "processStartId" in identityFields ? identityFields.processStartId : undefined,
					token: "b".repeat(64),
				}),
			)}\n`,
		);
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/Cannot acquire orphan process journal lock/);
		expect(readFileSync(lockPath, "utf8")).toContain("b".repeat(64));

		writeFileSync(
			lockPath,
			`${JSON.stringify(
				validLockRecord({ ownerPid: process.pid, processStartId: undefined, token: "f".repeat(64) }),
			)}\n`,
		);
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/Cannot acquire orphan process journal lock/);
		expect(readFileSync(lockPath, "utf8")).toContain("f".repeat(64));

		writeFileSync(
			lockPath,
			`${JSON.stringify(validLockRecord({ token: "123e4567-e89b-42d3-a456-426614174000" }))}\n`,
		);
		expect(() => enrollOrphanProcess(process.pid)).not.toThrow();
		expect(existsSync(lockPath)).toBe(false);
		const claimsPath = `${lockPath}.claims`;
		expect(lstatSync(claimsPath).isDirectory()).toBe(true);
		expect(lstatSync(claimsPath).mode & 0o777).toBe(0o700);
	});

	it("exports one strict exact, legacy, and historical-coarse append-lock parser", () => {
		const valid = [
			validLockRecord(),
			validLockRecord({ processStartId: `token:${"b".repeat(64)}` }),
			validLockRecord({ processStartId: undefined, processIdentityHint: "ps:historical-value" }),
		];
		for (const record of valid) {
			expect(parseOrphanProcessJournalAppendLockRecord(Buffer.from(JSON.stringify(record))).status).toBe("valid");
		}
		for (const record of [
			validLockRecord({ processIdentityHint: "ps:conflict" }),
			validLockRecord({ extra: true }),
			validLockRecord({ createdAt: "2026-01-01T00:00:00Zjunk" }),
			validLockRecord({ token: "B".repeat(64) }),
		]) {
			expect(parseOrphanProcessJournalAppendLockRecord(Buffer.from(JSON.stringify(record)))).toEqual({
				status: "invalid",
			});
		}
		expect(parseOrphanProcessJournalAppendLockRecord(Buffer.from([0xff]))).toEqual({ status: "invalid" });
	});

	it("exposes a stable read-only tri-state append-lock snapshot", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-lock-read-"));
		tempDirs.push(directory);
		const lockPath = join(directory, "orphans.jsonl.append.lock");
		expect(readOrphanProcessJournalAppendLock(lockPath)).toEqual({ status: "absent" });
		writeFileSync(lockPath, Buffer.from([0xff]));
		expect(readOrphanProcessJournalAppendLock(lockPath)).toEqual({ status: "present-invalid" });
		writeFileSync(lockPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
		expect(readOrphanProcessJournalAppendLock(lockPath)).toEqual({ status: "present-invalid" });
		rmSync(lockPath);
		symlinkSync(join(directory, "missing-target"), lockPath);
		expect(readOrphanProcessJournalAppendLock(lockPath)).toEqual({ status: "present-invalid" });
		rmSync(lockPath);
		const bytes = Buffer.from(`${JSON.stringify(validLockRecord({ token: "a".repeat(64) }))}\n`);
		writeFileSync(lockPath, bytes);
		const read = readOrphanProcessJournalAppendLock(lockPath);
		expect(read.status).toBe("valid");
		if (read.status !== "valid") throw new Error("valid append-lock snapshot unavailable");
		expect(read.bytes).toEqual(bytes);
		expect(read.size).toBe(BigInt(bytes.length));
		expect(read.device).toBeTypeOf("bigint");
		expect(read.inode).toBeTypeOf("bigint");
		expect(Object.isFrozen(read.record)).toBe(true);
	});

	it("pins an invalid UTF-8 append lock without appending or unlinking", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-lock-invalid-utf8-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		const before = readFileSync(path);
		const lockPath = `${path}.append.lock`;
		const invalidBytes = Buffer.from([0x7b, 0xff, 0x7d]);
		writeFileSync(lockPath, invalidBytes);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		expect(() => enrollOrphanProcess(process.pid)).toThrow(/Cannot acquire orphan process journal lock/);
		expect(readFileSync(path)).toEqual(before);
		expect(readFileSync(lockPath)).toEqual(invalidBytes);
	});

	it("uses full-record token claims for replacement and release-vs-reclaimer races", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-lock-race-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const lockPath = `${path}.append.lock`;
		writeFileSync(path, "");

		const replacement = validLockRecord({ token: "c".repeat(64) });
		expect(() =>
			bindOrUpgradeOrphanProcessJournalAuthority(path, undefined, () => {
				const replacementPath = `${lockPath}.replacement`;
				writeFileSync(replacementPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
				renameSync(replacementPath, lockPath);
				throw new Error("stop after replacement");
			}),
		).toThrow("stop after replacement");
		expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(replacement);

		let staleReplacement: Record<string, unknown> | undefined;
		expect(() =>
			bindOrUpgradeOrphanProcessJournalAuthority(path, undefined, () => {
				const heldRecord = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
				const staleAt = new Date(Date.now() - 60_000).toISOString();
				staleReplacement = {
					...heldRecord,
					ownerPid: 2_000_000_000,
					createdAt: staleAt,
					expiresAt: staleAt,
				};
				writeFileSync(lockPath, `${JSON.stringify(staleReplacement)}\n`);
				throw new Error("stop after release race");
			}),
		).toThrow("stop after release race");
		expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(staleReplacement);
		expect(() => bindOrUpgradeOrphanProcessJournalAuthority(path, undefined)).not.toThrow();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("fails closed for malformed tokens, claim symlinks/modes/inodes, and abandoned claims", () => {
		const scenarios = [
			"malformed-token",
			"overlong-token",
			"uppercase-token",
			"claims-symlink",
			"claims-mode",
			"marker-symlink",
			"abandoned",
		] as const;
		for (const scenario of scenarios) {
			const directory = mkdtempSync(join(tmpdir(), `prime-orphan-journal-${scenario}-`));
			tempDirs.push(directory);
			const path = join(directory, "orphans.jsonl");
			const authority = initializeOrphanProcessJournal(path);
			const lockPath = `${path}.append.lock`;
			const token =
				scenario === "malformed-token"
					? "../escape"
					: scenario === "overlong-token"
						? "d".repeat(65)
						: scenario === "uppercase-token"
							? "D".repeat(64)
							: "d".repeat(64);
			writeFileSync(lockPath, `${JSON.stringify(validLockRecord({ token }))}\n`);
			const claimsPath = `${lockPath}.claims`;
			if (scenario === "claims-symlink") {
				const target = join(directory, "claim-target");
				mkdirSync(target, { mode: 0o700 });
				symlinkSync(target, claimsPath);
			} else if (scenario === "claims-mode") {
				mkdirSync(claimsPath, { mode: 0o755 });
				chmodSync(claimsPath, 0o755);
			} else if (scenario === "marker-symlink" || scenario === "abandoned") {
				mkdirSync(claimsPath, { mode: 0o700 });
				chmodSync(claimsPath, 0o700);
				const markerPath = join(claimsPath, token);
				if (scenario === "marker-symlink") symlinkSync("/dev/null", markerPath);
				else writeFileSync(markerPath, "abandoned\n", { mode: 0o600 });
			}
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
			process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
			expect(() => enrollOrphanProcess(process.pid)).toThrow(/Cannot acquire orphan process journal lock/);
			expect(existsSync(lockPath)).toBe(true);
			if (!scenario.endsWith("token")) expect(existsSync(claimsPath)).toBe(true);
			if (scenario === "abandoned") {
				expect(readFileSync(join(claimsPath, token), "utf8")).toBe("abandoned\n");
			}
		}
	}, 10_000);

	it("never treats candidate artifacts as canonical deletion authority", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-candidate-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		const lockPath = `${path}.append.lock`;
		const artifact = `${lockPath}.candidate-1-${"e".repeat(64)}`;
		writeFileSync(artifact, `${JSON.stringify(validLockRecord({ token: "e".repeat(64) }))}\n`);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		expect(() => enrollOrphanProcess(process.pid)).not.toThrow();
		expect(readFileSync(artifact, "utf8")).toContain("e".repeat(64));
		expect(existsSync(lockPath)).toBe(false);
	});

	it("rejects complete transition gaps but tolerates only a torn final append", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const base = { version: 1, pid: process.pid, ownerPid: process.pid, recordedAt: new Date().toISOString() };
		writeFileSync(path, `${JSON.stringify({ ...base, active: false })}\n`);
		expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/without prior enrollment/);
		writeFileSync(path, `${JSON.stringify({ ...base, active: true })}\n{"version":`);
		expect(readActiveOrphanProcessCandidates(path)).toHaveLength(1);
	});

	it("rejects non-monotonic v2 records and retains a torn authority", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 2,
				type: "process",
				generation: authority.generation,
				sequence: 2,
				pid: process.pid,
				ownerPid: process.pid,
				processStartId: "proc:1",
				state: "enrolled",
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/non-monotonic process sequence/);
		await expect(reapOrphanProcessAuthority(path, { expectedGeneration: authority.generation })).resolves.toBe(false);
		expect(clearOrphanProcessJournal(path, authority.generation)).toBe(false);

		writeFileSync(path, `${readFileSync(path, "utf8").split("\n")[0]}\n{"version":2`);
		expect(readActiveOrphanProcessCandidates(path)).toEqual([]);
		await expect(reapOrphanProcessAuthority(path, { expectedGeneration: authority.generation })).resolves.toBe(false);
		expect(clearOrphanProcessJournal(path, authority.generation)).toBe(false);
	});

	it("retains noncanonical stored exact identities without signaling", async () => {
		for (const authorityProcessStartId of [
			`proc:${LINUX_BOOT_A}:00123`,
			"win:000123",
			`proc:${LINUX_BOOT_A}:18446744073709551616`,
		]) {
			const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-noncanonical-id-"));
			tempDirs.push(directory);
			const path = join(directory, "orphans.jsonl");
			const authority = initializeOrphanProcessJournal(path);
			appendFileSync(
				path,
				`${JSON.stringify({
					version: 2,
					type: "process",
					sequence: 1,
					pid: process.pid,
					ownerPid: process.pid,
					authorityProcessStartId,
					state: "enrolled",
					createdAt: new Date().toISOString(),
				})}\n`,
			);
			const signalSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				await expect(reapOrphanProcessAuthority(path, { expectedGeneration: authority.generation })).resolves.toBe(
					false,
				);
				expect(signalSpy).not.toHaveBeenCalled();
			} finally {
				signalSpy.mockRestore();
			}
			expect(clearOrphanProcessJournal(path, authority.generation)).toBe(false);
			expect(existsSync(path)).toBe(true);
		}
	});

	it("rejects invalid UTF-8 bytes without signaling or clearing authority", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-invalid-utf8-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		appendFileSync(path, Buffer.from([0xff, 0x0a]));
		expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/invalid UTF-8/);
		expect(() => readStrictEmptyOrphanProcessJournalAuthority(path)).toThrow(/invalid UTF-8/);
		const signalSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			await expect(reapOrphanProcessAuthority(path, { expectedGeneration: authority.generation })).resolves.toBe(
				false,
			);
			expect(signalSpy).not.toHaveBeenCalled();
		} finally {
			signalSpy.mockRestore();
		}
		expect(clearOrphanProcessJournal(path, authority.generation)).toBe(false);
		expect(existsSync(path)).toBe(true);
	});

	it("fails the strict cleanup view on malformed complete records", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const valid = {
			version: 1,
			pid: process.pid,
			ownerPid: process.pid,
			processStartId: "proc:1",
			active: true,
			recordedAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, kernelPid: -1 })}\n`);

		// Best-effort per-owner reaping ignores the malformed line; tombstone
		// deletion refuses to treat a partially valid journal as complete truth.
		expect(readActiveOrphanProcesses(path, process.pid)).toHaveLength(1);
		expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/Invalid orphan process journal/);
	});

	it("round-trips a qualified Linux dual-field enrollment and retirement", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-dual-roundtrip-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		const enrollment = {
			version: 2,
			type: "process",
			generation: authority.generation,
			sequence: 1,
			pid: 101,
			ownerPid: 202,
			kernelPid: 303,
			kernelProcessStartId: "proc:10",
			kernelAuthorityProcessStartId: exactProc("10"),
			admissionGeneration: "12345678-1234-4234-8234-123456789abc",
			kernelLineage: "a".repeat(64),
			processStartId: "proc:11",
			authorityProcessStartId: exactProc("11"),
			state: "enrolled",
			recordedAt: new Date().toISOString(),
		};
		appendFileSync(
			path,
			`${JSON.stringify(enrollment)}\n${JSON.stringify({ ...enrollment, sequence: 2, state: "retired" })}\n`,
		);
		expect(readActiveOrphanProcessCandidates(path)).toEqual([]);
	});

	it("rejects conflicting rolling-reader and exact authority identities", () => {
		for (const conflictingKernel of [false, true]) {
			const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-dual-identity-"));
			tempDirs.push(directory);
			const path = join(directory, "orphans.jsonl");
			const authority = initializeOrphanProcessJournal(path);
			const record = {
				version: 2,
				type: "process",
				generation: authority.generation,
				sequence: 1,
				pid: 101,
				ownerPid: 202,
				processStartId: conflictingKernel ? "proc:10" : "proc:11",
				authorityProcessStartId: exactProc("10"),
				...(conflictingKernel
					? {
							kernelPid: 303,
							kernelProcessStartId: "proc:11",
							kernelAuthorityProcessStartId: exactProc("10"),
						}
					: {}),
				state: "enrolled",
				recordedAt: new Date().toISOString(),
			};
			appendFileSync(path, `${JSON.stringify(record)}\n`);
			expect(() => readActiveOrphanProcessCandidates(path)).toThrow(/Invalid orphan process journal/);
		}
	});

	it("reaps only a fresh exact match for the full admitted kernel lineage", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(path);
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;

		const child = spawnExactDetachedChild();
		const missingLineageChild = spawnExactDetachedChild();
		const reusedKernelPidChild = spawnExactDetachedChild();
		const childIdentity = observeProcessIdentity(child.pid);
		const missingIdentity = observeProcessIdentity(missingLineageChild.pid);
		const reusedIdentity = observeProcessIdentity(reusedKernelPidChild.pid);
		expect(childIdentity.status).toBe("present-exact");
		expect(missingIdentity.status).toBe("present-exact");
		expect(reusedIdentity.status).toBe("present-exact");
		if (
			childIdentity.status !== "present-exact" ||
			missingIdentity.status !== "present-exact" ||
			reusedIdentity.status !== "present-exact"
		) {
			throw new Error("exact child identity unavailable");
		}
		const lineage = testKernelLineage(999_999, exactProc("2"));
		enrollOrphanProcess(child.pid, lineage.kernelPid, childIdentity.id, lineage);
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 2,
				type: "process",
				generation: authority.generation,
				sequence: 2,
				pid: missingLineageChild.pid,
				ownerPid: process.pid,
				kernelPid: lineage.kernelPid,
				processStartId: missingIdentity.id,
				state: "enrolled",
				recordedAt: new Date().toISOString(),
			})}
`,
		);
		const reusedLineage = { ...lineage, kernelProcessStartId: exactProc("2", LINUX_BOOT_B) };
		enrollOrphanProcess(reusedKernelPidChild.pid, reusedLineage.kernelPid, reusedIdentity.id, reusedLineage);

		reapKernelOrphanProcesses(lineage);
		reapKernelOrphanProcesses(lineage);
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(child.signalCode).toBe("SIGKILL");
		expect(missingLineageChild.exitCode).toBeNull();
		expect(missingLineageChild.signalCode).toBeNull();
		expect(reusedKernelPidChild.exitCode).toBeNull();
		expect(reusedKernelPidChild.signalCode).toBeNull();
		const remaining = readActiveOrphanProcesses(path, process.pid);
		expect(remaining.find((orphan) => orphan.pid === missingLineageChild.pid)).toMatchObject({
			pid: missingLineageChild.pid,
			kernelPid: lineage.kernelPid,
		});
		expect(remaining.find((orphan) => orphan.pid === reusedKernelPidChild.pid)).toMatchObject(reusedLineage);
	});

	it("keeps bare anchors sticky beside enriched records and treats inactive as a hint", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const appendRecord = (record: Record<string, unknown>) => {
			appendFileSync(path, `${JSON.stringify(record)}\n`);
		};
		const base = { version: 1, pid: process.pid, ownerPid: process.pid, recordedAt: new Date().toISOString() };

		appendRecord({ ...base, active: true });
		appendRecord({ ...base, active: true, processStartId: "proc:123" });
		appendRecord({ ...base, active: false });
		const active = readActiveOrphanProcesses(path, process.pid);
		expect(active).toEqual([{ pid: process.pid }, { pid: process.pid, processStartId: "proc:123" }]);
		expect(active.every((candidate) => !isOrphanProcessIdentityCurrent(candidate))).toBe(true);
	});

	it("never signals bare or coarse candidates and requires PID plus group absence to clear", async () => {
		const calls: number[] = [];
		const presentEperm = {
			platform: "linux" as const,
			processKill: (pid: number, _signal: 0) => {
				calls.push(pid);
				const error = new Error("denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			},
			readProcStat: () => {
				const error = new Error("denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			},
		};
		await expect(reapOrphanProcessAuthority("/missing", { probeOptions: presentEperm })).resolves.toBe(false);
		await expect(reapOrphanProcessCandidate({ pid: 101 }, undefined, presentEperm)).resolves.toBe(false);
		await expect(
			reapOrphanProcessCandidate({ pid: 101, processStartId: "ps:lstart:hint" }, undefined, presentEperm),
		).resolves.toBe(false);
		expect(isOrphanProcessCandidateExactDead({ pid: 101 }, presentEperm)).toBe(false);
		expect(isOrphanProcessCandidateExactDead({ pid: 101, processStartId: "ps:lstart:hint" }, presentEperm)).toBe(
			false,
		);
		expect(shouldReapOrphanProcess({ pid: 101 })).toBe(false);
		expect(shouldReapOrphanProcess({ pid: 101, processStartId: "ps:lstart:hint" })).toBe(false);
		expect(shouldReapOrphanProcess({ pid: 101, processStartId: "proc:10" }, presentEperm)).toBe(false);
		expect(calls.every((pid) => Math.abs(pid) === 101)).toBe(true);

		const absent = (groupCode: "ESRCH" | "EPERM" | "EIO") => ({
			platform: "linux" as const,
			processKill: (pid: number, _signal: 0) => {
				const error = new Error("probe") as NodeJS.ErrnoException;
				error.code = pid < 0 ? groupCode : "ESRCH";
				throw error;
			},
		});
		expect(isOrphanProcessCandidateExactDead({ pid: 102 }, absent("ESRCH"))).toBe(true);
		await expect(
			reapOrphanProcessCandidate({ pid: 102, processStartId: "proc:10" }, undefined, absent("EPERM")),
		).resolves.toBe(false);
		expect(isOrphanProcessCandidateExactDead({ pid: 102 }, absent("EPERM"))).toBe(false);
		expect(isOrphanProcessCandidateExactDead({ pid: 102 }, absent("EIO"))).toBe(false);
		expect(isOrphanProcessCandidateExactDead({ pid: 102 }, { ...absent("ESRCH"), platform: "win32" })).toBe(false);
	});

	it("uses reboot-qualified identity and tri-state group proof for exact candidates", async () => {
		const linuxStat = (pid: number, start: string) => `${pid} (node) S ${[...Array(18).fill("0"), start].join(" ")}`;
		const probes = (start: string, groupCode?: "ESRCH" | "EPERM" | "EIO", bootId: string | Error = LINUX_BOOT_A) => ({
			platform: "linux" as const,
			processKill: (pid: number, _signal: 0) => {
				if (pid > 0) return;
				if (!groupCode) return;
				const error = new Error("group") as NodeJS.ErrnoException;
				error.code = groupCode;
				throw error;
			},
			readProcStat: (path: string) => linuxStat(Number(path.split("/").at(-2)), start),
			readProcBootId: () => {
				if (bootId instanceof Error) throw bootId;
				return bootId;
			},
		});
		const exact = { pid: 103, processStartId: exactProc("10") };
		expect(shouldReapOrphanProcess(exact, probes("10"))).toBe(true);
		// Same PID/ticks after reboot cannot authorize a signal.
		expect(shouldReapOrphanProcess(exact, probes("10", undefined, LINUX_BOOT_B))).toBe(false);
		const signalSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			await expect(
				reapOrphanProcessCandidate(exact, undefined, probes("10", undefined, LINUX_BOOT_B)),
			).resolves.toBe(false);
			expect(signalSpy).not.toHaveBeenCalled();
		} finally {
			signalSpy.mockRestore();
		}
		expect(isOrphanProcessCandidateExactDead(exact, probes("10", "ESRCH", LINUX_BOOT_B))).toBe(true);
		expect(isOrphanProcessCandidateExactDead(exact, probes("11", "ESRCH"))).toBe(true);
		expect(isOrphanProcessCandidateExactDead(exact, probes("11", "EPERM"))).toBe(false);
		expect(isOrphanProcessCandidateExactDead(exact, probes("11", "EIO"))).toBe(false);
		expect(isOrphanProcessCandidateExactDead(exact, probes("10", "ESRCH"))).toBe(false);
		// Failure to read boot identity retains authority even when the group is absent.
		expect(isOrphanProcessCandidateExactDead(exact, probes("10", "ESRCH", new Error("boot")))).toBe(false);
	});

	it("win32 reapers ignore identity-free records", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		const child = spawnExactDetachedChild();
		const childPid = child.pid;
		expect(childPid).toBeTypeOf("number");
		const kernelPid = 999_999;
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: process.pid,
				kernelPid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(shouldReapOrphanProcess({ pid: childPid!, kernelPid })).toBe(false);
			// The kernel's kill-on-close job already reaped the tree; a bare-pid
			// taskkill could only hit a reused pid, so the reaper must skip it.
			reapKernelOrphanProcesses(testKernelLineage(kernelPid));
		} finally {
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		}

		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		await stopDetachedChild(child);
	});

	it("retains every Windows active candidate without same-operation held-Job proof", async () => {
		const absentWindows = {
			platform: "win32" as const,
			processKill: (_pid: number, _signal: 0) => {
				const error = new Error("absent") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			},
		};
		const exact = { pid: 2_000_000_000, processStartId: "win:1" };
		const coarse = { pid: 2_000_000_000, processStartId: "ps:lstart:hint" };
		expect(isOrphanProcessCandidateExactDead(exact, absentWindows)).toBe(false);
		expect(isOrphanProcessCandidateExactDead(coarse, absentWindows)).toBe(false);
		expect(isOrphanProcessGroupAlive(exact.pid, absentWindows)).toBe(true);
		expect(isOrphanProcessTreeAlive(exact.pid, absentWindows)).toBe(true);
		await expect(reapOrphanProcessCandidate(exact, undefined, absentWindows)).resolves.toBe(false);

		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(retireOrphanProcess(exact)).toBe(false);
			expect(retireOrphanProcessAfterHeldWindowsJobEmpty(exact)).toBe(true);
			expect(retireOrphanProcessAfterHeldWindowsJobEmpty(coarse)).toBe(true);
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("reports authority reaped only when every sticky anchor is cleanup-proven", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-sticky-authority-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		const base = {
			version: 1,
			pid: 2_000_000_000,
			ownerPid: process.pid,
			active: true,
			recordedAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(base)}\n${JSON.stringify({ ...base, processStartId: "proc:1" })}\n`);
		const probes = (groupCode: "ESRCH" | "EPERM") => ({
			platform: "linux" as const,
			processKill: (pid: number, _signal: 0) => {
				const error = new Error("probe") as NodeJS.ErrnoException;
				error.code = pid < 0 ? groupCode : "ESRCH";
				throw error;
			},
		});
		await expect(reapOrphanProcessAuthority(path, { probeOptions: probes("EPERM") })).resolves.toBe(false);
		await expect(reapOrphanProcessAuthority(path, { probeOptions: probes("ESRCH") })).resolves.toBe(true);
	});

	it("re-reduces sticky anchors under the append lock before unlink", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-clear-reduce-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				pid: 2_000_000_000,
				ownerPid: process.pid,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		const absent = {
			platform: "linux" as const,
			processKill: (_pid: number, _signal: 0) => {
				const error = new Error("absent") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			},
		};
		const groupEperm = {
			...absent,
			processKill: (pid: number, _signal: 0) => {
				const error = new Error("probe") as NodeJS.ErrnoException;
				error.code = pid < 0 ? "EPERM" : "ESRCH";
				throw error;
			},
		};
		expect(clearOrphanProcessJournal(path, undefined, groupEperm)).toBe(false);
		expect(existsSync(path)).toBe(true);
		expect(clearOrphanProcessJournal(path, undefined, absent)).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("serializes real TS/Python and Python/TS appends with unique monotonic sequences", async () => {
		const runRound = async (pythonFirst: boolean) => {
			const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-cross-runtime-"));
			tempDirs.push(directory);
			const path = join(directory, "orphans.jsonl");
			const authority = initializeOrphanProcessJournal(path);
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;
			process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
			const readyPath = join(directory, "python-ready");
			const tsChildren: Array<ChildProcess & { pid: number }> = [];
			let python: ReturnType<typeof runPythonWriter>;

			if (pythonFirst) {
				python = runPythonWriter(path, authority.generation, 6, readyPath);
				await waitForPath(readyPath);
			} else {
				const first = spawnExactDetachedChild();
				tsChildren.push(first);
				enrollOrphanProcess(first.pid);
				python = runPythonWriter(path, authority.generation, 6);
			}
			while (tsChildren.length < 6) {
				const child = spawnExactDetachedChild();
				tsChildren.push(child);
				enrollOrphanProcess(child.pid);
				await new Promise((resolve) => setTimeout(resolve, 3));
			}
			await python.complete;
			const records = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type: string;
							sequence: number;
							pid?: number;
							ownerPid?: number;
							processStartId?: string;
							authorityProcessStartId?: string;
							kernelProcessStartId?: string;
							kernelAuthorityProcessStartId?: string;
						},
				)
				.filter((record) => record.type === "process");
			expect(records).toHaveLength(12);
			expect(records.map((record) => record.sequence)).toEqual([...Array(12)].map((_, index) => index + 1));
			expect(new Set(records.map((record) => record.pid)).size).toBe(12);
			expect(new Set(records.map((record) => record.ownerPid)).size).toBe(2);
			expect(records[0]?.ownerPid === process.pid).toBe(!pythonFirst);
			for (const record of records) {
				expect(record.authorityProcessStartId).toBeTypeOf("string");
				if (record.authorityProcessStartId === undefined) throw new Error("missing exact authority identity");
				expect(safeJournalLegacyProjection(record.authorityProcessStartId)).toBe(record.processStartId);
				if (record.kernelAuthorityProcessStartId !== undefined) {
					expect(safeJournalLegacyProjection(record.kernelAuthorityProcessStartId)).toBe(
						record.kernelProcessStartId,
					);
				}
			}
			expect(readActiveOrphanProcessCandidates(path)).toHaveLength(12);
			for (const child of tsChildren) await stopDetachedChild(child);
		};

		await runRound(false);
		await runRound(true);
	}, 30_000);
});
