import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	processStartId: string;
}

export interface ActiveOrphanProcessCandidate {
	pid: number;
	processStartId?: string;
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		const descriptor = openSync(path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

function readLatestOrphanProcessRecords(path: string, failOnInvalidRecord: boolean): OrphanProcessRecord[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<string, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				Number.isInteger(record.ownerPid) &&
				(record.ownerPid ?? 0) > 0 &&
				(record.processStartId === undefined || typeof record.processStartId === "string") &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(`${record.ownerPid}:${record.pid}`, record as OrphanProcessRecord);
			} else if (failOnInvalidRecord) {
				throw new Error("invalid orphan process record");
			}
		} catch (error) {
			if (failOnInvalidRecord) {
				throw new Error(`Invalid orphan process journal ${path}`, { cause: error });
			}
			// A crash can truncate only the final append; ordinary process reaping stays best-effort.
		}
	}
	return [...latest.values()];
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	return readLatestOrphanProcessRecords(path, false)
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.ownerPid === ownerPid && record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

/** Strict cleanup view: every active identity across worker generations, including unverifiable ones. */
export function readActiveOrphanProcessCandidates(path: string): ActiveOrphanProcessCandidate[] {
	return readLatestOrphanProcessRecords(path, true)
		.filter((record) => record.active)
		.map((record) => ({
			pid: record.pid,
			...(record.processStartId ? { processStartId: record.processStartId } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return getProcessStartId(orphan.pid) === orphan.processStartId;
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}
