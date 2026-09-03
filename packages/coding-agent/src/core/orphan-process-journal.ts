import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	isExactProcessStartId,
	matchesExactProcessIdentity,
	normalizeRetainedLegacyProcessStartId,
	observeProcessIdentity,
	type ProcessIdentityObservationOptions,
	projectLegacyProcessStartId,
} from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";
export const ORPHAN_PROCESS_JOURNAL_GENERATION_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL_GENERATION";
export const KERNEL_ADMISSION_GENERATION_ENV = "PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_GENERATION";
export const KERNEL_ADMISSION_PROTOCOL_ENV = "PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_PROTOCOL";
export const KERNEL_LINEAGE_ENV = "PRIME_AGENT_INTERNAL_KERNEL_LINEAGE";
export const KERNEL_PID_ENV = "PRIME_AGENT_INTERNAL_KERNEL_PID";
export const KERNEL_PROCESS_START_ID_ENV = "PRIME_AGENT_INTERNAL_KERNEL_PROCESS_START_ID";

const KERNEL_ADMISSION_GENERATION_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const KERNEL_LINEAGE_PATTERN = /^[0-9a-f]{64}$/;

/** One admission authority, bound to the exact kernel identity it released. */
export interface KernelAdmissionLineage {
	admissionGeneration: string;
	kernelLineage: string;
	kernelPid: number;
	kernelProcessStartId: string;
}

export function createKernelLineage(): string {
	return randomBytes(32).toString("hex");
}

interface LegacyOrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

interface OrphanProcessJournalHeader {
	version: 2;
	type: "authority";
	generation: string;
	sequence: 0;
	createdAt: string;
}

interface OrphanProcessJournalRecord {
	version: 2;
	type: "process";
	generation: string;
	sequence: number;
	pid: number;
	ownerPid: number;
	kernelPid?: number;
	/** Rolling-reader projection only; new readers prefer kernelAuthorityProcessStartId. */
	kernelProcessStartId?: string;
	kernelAuthorityProcessStartId?: string;
	admissionGeneration?: string;
	kernelLineage?: string;
	/** Rolling-reader projection only; new readers prefer authorityProcessStartId. */
	processStartId?: string;
	authorityProcessStartId?: string;
	state: "enrolled" | "retired";
	recordedAt: string;
}

export function withoutOrphanProcessJournalAuthority(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...source };
	delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
	delete environment[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	delete environment[KERNEL_ADMISSION_GENERATION_ENV];
	delete environment[KERNEL_ADMISSION_PROTOCOL_ENV];
	delete environment[KERNEL_LINEAGE_ENV];
	delete environment[KERNEL_PID_ENV];
	delete environment[KERNEL_PROCESS_START_ID_ENV];
	return environment;
}

export interface OrphanProcessJournalAuthority {
	path: string;
	generation: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	kernelProcessStartId?: string;
	admissionGeneration?: string;
	kernelLineage?: string;
	/** Missing only on identity-free legacy-v1 records. */
	processStartId?: string;
}

export type ActiveOrphanProcessCandidate = ActiveOrphanProcess;

interface JournalSnapshot {
	generation?: string;
	sequence?: number;
	candidates: Array<ActiveOrphanProcessCandidate & { ownerPid: number }>;
	hasTruncatedTail: boolean;
	device?: number;
	inode?: number;
	size?: number;
}

function invalidJournalError(path: string, detail?: string, cause?: unknown): Error {
	const suffix = detail ? `: ${detail}` : "";
	return new Error(`Invalid orphan process journal ${path}${suffix}`, cause === undefined ? undefined : { cause });
}

function writeAllSync(descriptor: number, contents: string): void {
	const buffer = Buffer.from(contents, "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
		if (written <= 0) throw new Error("Short write while appending orphan process authority");
		offset += written;
	}
}

const JOURNAL_WRITE_LOCK_SUFFIX = ".append.lock";
const JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX = ".claims";
const JOURNAL_WRITE_LOCK_VERSION = 1;
const JOURNAL_WRITE_LOCK_TIMEOUT_MS = 1_000;
const JOURNAL_WRITE_LOCK_LEASE_MS = 5_000;
const JOURNAL_WRITE_LOCK_MAX_BYTES = 16 * 1024;
const JOURNAL_WRITE_LOCK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const LEGACY_JOURNAL_WRITE_LOCK_TOKEN_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_ISO_TIMESTAMP_PATTERN = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/;
const journalLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const WINDOWS_SYSTEM32 = `${WINDOWS_SYSTEM_ROOT}\\System32`;
const WINDOWS_TASKKILL_PATH = `${WINDOWS_SYSTEM32}\\taskkill.exe`;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const ORPHAN_JOURNAL_STRICT_MAX_BYTES = 64 * 1024 * 1024;
// Compaction thresholds. A retire rewrites the live set once the append log has
// outgrown either bound; an enroll never rewrites, so a spawn stays O(1).
const ORPHAN_JOURNAL_COMPACT_MIN_BYTES = 256 * 1024;
const ORPHAN_JOURNAL_COMPACT_MIN_RECORDS = 512;
const JOURNAL_MEMORY_INDEX_MAX_PATHS = 16;

export interface OrphanProcessJournalAppendLockRecord {
	version: 1;
	ownerPid: number;
	/** Exact identity only in newly written records. Historical `ps:` values stay non-authorizing. */
	processStartId?: string;
	processIdentityHint?: string;
	token: string;
	createdAt: string;
	expiresAt: string;
}

type JournalWriteLockRecord = OrphanProcessJournalAppendLockRecord;

export type OrphanProcessJournalAppendLockParseResult =
	| { status: "valid"; record: Readonly<OrphanProcessJournalAppendLockRecord> }
	| { status: "invalid" };

export type OrphanProcessJournalAppendLockReadResult =
	| { status: "absent" }
	| { status: "present-invalid" }
	| {
			status: "valid";
			record: Readonly<OrphanProcessJournalAppendLockRecord>;
			bytes: Buffer;
			device: bigint;
			inode: bigint;
			size: bigint;
	  };

interface JournalWriteLock {
	path: string;
	record: JournalWriteLockRecord;
}

interface CanonicalJournalWriteLock {
	descriptor: number;
	device: number;
	inode: number;
	record: JournalWriteLockRecord;
}

interface JournalWriteLockCandidate {
	descriptor: number;
	path: string;
	record: JournalWriteLockRecord;
}

interface JournalWriteLockRemovalClaim {
	descriptor: number;
	path: string;
	device: number;
	inode: number;
}

function newJournalWriteLockToken(): string {
	return randomBytes(32).toString("hex");
}

function isAcceptedJournalWriteLockToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(JOURNAL_WRITE_LOCK_TOKEN_PATTERN.test(value) || LEGACY_JOURNAL_WRITE_LOCK_TOKEN_PATTERN.test(value))
	);
}

function isExactProcessIdentity(value: string | undefined): value is string {
	return value !== undefined && isExactProcessStartId(value);
}

export function hasExactKernelAdmissionLineage(
	value: ActiveOrphanProcessCandidate,
): value is ActiveOrphanProcessCandidate & KernelAdmissionLineage {
	return (
		isPositivePid(value.kernelPid) &&
		isExactProcessIdentity(value.kernelProcessStartId) &&
		typeof value.admissionGeneration === "string" &&
		KERNEL_ADMISSION_GENERATION_PATTERN.test(value.admissionGeneration) &&
		typeof value.kernelLineage === "string" &&
		KERNEL_LINEAGE_PATTERN.test(value.kernelLineage)
	);
}

export function matchesKernelAdmissionLineage(
	candidate: ActiveOrphanProcessCandidate,
	lineage: KernelAdmissionLineage,
): boolean {
	return (
		hasExactKernelAdmissionLineage(candidate) &&
		candidate.kernelPid === lineage.kernelPid &&
		candidate.kernelProcessStartId === lineage.kernelProcessStartId &&
		candidate.admissionGeneration === lineage.admissionGeneration &&
		candidate.kernelLineage === lineage.kernelLineage
	);
}

function candidateLineageFields(candidate: Partial<KernelAdmissionLineage>): Partial<KernelAdmissionLineage> {
	return {
		...(candidate.kernelPid !== undefined ? { kernelPid: candidate.kernelPid } : {}),
		...(candidate.kernelProcessStartId !== undefined ? { kernelProcessStartId: candidate.kernelProcessStartId } : {}),
		...(candidate.admissionGeneration !== undefined ? { admissionGeneration: candidate.admissionGeneration } : {}),
		...(candidate.kernelLineage !== undefined ? { kernelLineage: candidate.kernelLineage } : {}),
	};
}

function recordIdentityFields(
	processStartId: string | undefined,
	legacyField: "processStartId" | "kernelProcessStartId",
	authorityField: "authorityProcessStartId" | "kernelAuthorityProcessStartId",
): Record<string, string> {
	if (!processStartId) return {};
	if (!isExactProcessIdentity(processStartId)) return { [legacyField]: processStartId };
	const legacy = projectLegacyProcessStartId(processStartId);
	// Only byte-identical exact identities are safe for a same-merge intermediate
	// signal-bearing reader. Qualified Linux and token authority stay new-field-only.
	return {
		...(legacy === processStartId ? { [legacyField]: legacy } : {}),
		[authorityField]: processStartId,
	};
}

function hasConsistentRollingIdentity(legacy: string | undefined, authority: string | undefined): boolean {
	return authority === undefined || legacy === undefined || projectLegacyProcessStartId(authority) === legacy;
}

function journalCandidateLineageFields(
	candidate: Partial<KernelAdmissionLineage>,
): Pick<
	OrphanProcessJournalRecord,
	"kernelPid" | "kernelProcessStartId" | "kernelAuthorityProcessStartId" | "admissionGeneration" | "kernelLineage"
> {
	return {
		...(candidate.kernelPid !== undefined ? { kernelPid: candidate.kernelPid } : {}),
		...recordIdentityFields(candidate.kernelProcessStartId, "kernelProcessStartId", "kernelAuthorityProcessStartId"),
		...(candidate.admissionGeneration !== undefined ? { admissionGeneration: candidate.admissionGeneration } : {}),
		...(candidate.kernelLineage !== undefined ? { kernelLineage: candidate.kernelLineage } : {}),
	};
}

function isLegacyProcessIdentity(value: string | undefined): value is string {
	return value?.startsWith("proc:") === true && normalizeRetainedLegacyProcessStartId(value) === value;
}

function isCoarseProcessIdentity(value: string | undefined): value is string {
	return value?.startsWith("ps:") === true && normalizeRetainedLegacyProcessStartId(value) === value;
}

function isJournalWriteLockTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = UTC_ISO_TIMESTAMP_PATTERN.exec(value);
	if (!match) return false;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	const date = new Date(timestamp);
	return (
		date.getUTCFullYear() === Number(match[1]) &&
		date.getUTCMonth() + 1 === Number(match[2]) &&
		date.getUTCDate() === Number(match[3]) &&
		date.getUTCHours() === Number(match[4]) &&
		date.getUTCMinutes() === Number(match[5]) &&
		date.getUTCSeconds() === Number(match[6])
	);
}

function isJournalWriteLockRecord(value: unknown): value is JournalWriteLockRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<JournalWriteLockRecord>;
	const allowedKeys = new Set([
		"version",
		"ownerPid",
		"processStartId",
		"processIdentityHint",
		"token",
		"createdAt",
		"expiresAt",
	]);
	if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
	if (record.processStartId !== undefined && record.processIdentityHint !== undefined) return false;
	if (
		record.processStartId !== undefined &&
		!isExactProcessIdentity(record.processStartId) &&
		!isLegacyProcessIdentity(record.processStartId) &&
		!isCoarseProcessIdentity(record.processStartId)
	) {
		return false;
	}
	if (record.processIdentityHint !== undefined && !isCoarseProcessIdentity(record.processIdentityHint)) {
		return false;
	}
	return (
		record.version === JOURNAL_WRITE_LOCK_VERSION &&
		isPositivePid(record.ownerPid) &&
		isAcceptedJournalWriteLockToken(record.token) &&
		isJournalWriteLockTimestamp(record.createdAt) &&
		isJournalWriteLockTimestamp(record.expiresAt)
	);
}

export function parseOrphanProcessJournalAppendLockRecord(
	bytes: Uint8Array,
): OrphanProcessJournalAppendLockParseResult {
	try {
		if (bytes.byteLength > JOURNAL_WRITE_LOCK_MAX_BYTES) return { status: "invalid" };
		const parsed = JSON.parse(decodeJournalUtf8Strict("append lock", bytes)) as unknown;
		if (!isJournalWriteLockRecord(parsed)) return { status: "invalid" };
		return { status: "valid", record: Object.freeze({ ...parsed }) };
	} catch {
		return { status: "invalid" };
	}
}

/** Read-only, no-follow append-lock snapshot with stable inode, size, and complete bytes. */
export function readOrphanProcessJournalAppendLock(path: string): OrphanProcessJournalAppendLockReadResult {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "present-invalid" };
		try {
			lstatSync(path);
			return { status: "present-invalid" };
		} catch (presenceError) {
			return (presenceError as NodeJS.ErrnoException).code === "ENOENT"
				? { status: "absent" }
				: { status: "present-invalid" };
		}
	}
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || opened.size > BigInt(JOURNAL_WRITE_LOCK_MAX_BYTES)) return { status: "present-invalid" };
		const bytes = readDescriptorExactly(descriptor, opened.size, JOURNAL_WRITE_LOCK_MAX_BYTES);
		const parsed = parseOrphanProcessJournalAppendLockRecord(bytes);
		if (parsed.status !== "valid") return { status: "present-invalid" };
		const current = lstatSync(path, { bigint: true });
		const confirmed = fstatSync(descriptor, { bigint: true });
		if (
			current.isSymbolicLink() ||
			!current.isFile() ||
			!confirmed.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			current.size !== opened.size ||
			confirmed.dev !== opened.dev ||
			confirmed.ino !== opened.ino ||
			confirmed.size !== opened.size ||
			!readDescriptorExactly(descriptor, opened.size, JOURNAL_WRITE_LOCK_MAX_BYTES).equals(bytes)
		) {
			return { status: "present-invalid" };
		}
		return {
			status: "valid",
			record: parsed.record,
			bytes: Buffer.from(bytes),
			device: opened.dev,
			inode: opened.ino,
			size: opened.size,
		};
	} catch {
		return { status: "present-invalid" };
	} finally {
		closeSync(descriptor);
	}
}

function sameJournalWriteLockRecord(left: JournalWriteLockRecord, right: JournalWriteLockRecord): boolean {
	return (
		left.version === right.version &&
		left.ownerPid === right.ownerPid &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.token === right.token &&
		left.createdAt === right.createdAt &&
		left.expiresAt === right.expiresAt
	);
}

function noFollowFlag(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function readBoundedDescriptor(descriptor: number, maxBytes: number): Buffer {
	const buffer = Buffer.allocUnsafe(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error("Orphan process journal lock record is too large");
	return buffer.subarray(0, offset);
}

function readDescriptorExactly(descriptor: number, size: bigint, maxBytes: number): Buffer {
	if (size < 0n || size > BigInt(maxBytes)) throw new Error("Orphan process journal is too large");
	const expectedBytes = Number(size);
	const buffer = Buffer.allocUnsafe(expectedBytes);
	let offset = 0;
	while (offset < expectedBytes) {
		const bytesRead = readSync(descriptor, buffer, offset, expectedBytes - offset, offset);
		if (bytesRead === 0) throw new Error("Orphan process journal ended during exact read");
		offset += bytesRead;
	}
	return buffer;
}

function pathMatchesOpenDescriptor(path: string, descriptor: number): boolean {
	try {
		const opened = fstatSync(descriptor);
		const current = lstatSync(path);
		return (
			opened.isFile() &&
			!current.isSymbolicLink() &&
			current.isFile() &&
			opened.dev === current.dev &&
			opened.ino === current.ino
		);
	} catch {
		return false;
	}
}

function openCanonicalJournalWriteLock(path: string): CanonicalJournalWriteLock | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || !pathMatchesOpenDescriptor(path, descriptor)) throw new Error("non-canonical lock");
		const parsed = parseOrphanProcessJournalAppendLockRecord(
			readBoundedDescriptor(descriptor, JOURNAL_WRITE_LOCK_MAX_BYTES),
		);
		if (parsed.status !== "valid") throw new Error("invalid lock record");
		return { descriptor, device: stat.dev, inode: stat.ino, record: { ...parsed.record } };
	} catch {
		if (descriptor !== undefined) closeSync(descriptor);
		return undefined;
	}
}

function closeCanonicalJournalWriteLock(lock: CanonicalJournalWriteLock | undefined): void {
	if (lock !== undefined) closeSync(lock.descriptor);
}

function readJournalWriteLockRecord(path: string): JournalWriteLockRecord | undefined {
	const lock = openCanonicalJournalWriteLock(path);
	try {
		return lock?.record;
	} finally {
		closeCanonicalJournalWriteLock(lock);
	}
}

function journalWriteLockOwnerIsExactDead(record: JournalWriteLockRecord): boolean {
	const observation = observeProcessIdentity(record.ownerPid);
	if (observation.status === "absent") return true;
	return (
		isExactProcessIdentity(record.processStartId) &&
		observation.status === "present-exact" &&
		observation.id !== record.processStartId
	);
}

function processIdentityRecordFields(): Pick<JournalWriteLockRecord, "processStartId" | "processIdentityHint"> {
	const observation = observeProcessIdentity(process.pid);
	if (observation.status === "present-exact") return { processStartId: observation.id };
	if (observation.status === "present-coarse") return { processIdentityHint: observation.hint };
	return {};
}

function assertSecureClaimsDirectory(path: string): { device: number; inode: number } {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (
		stat.isSymbolicLink() ||
		!stat.isDirectory() ||
		(process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
	) {
		throw new Error(`Unsafe orphan process journal lock claims directory ${path}`);
	}
	return { device: stat.dev, inode: stat.ino };
}

function sameDirectoryIdentity(path: string, expected: { device: number; inode: number }): boolean {
	try {
		const current = lstatSync(path);
		return (
			!current.isSymbolicLink() &&
			current.isDirectory() &&
			current.dev === expected.device &&
			current.ino === expected.inode &&
			(process.platform === "win32" || (current.mode & 0o777) === 0o700)
		);
	} catch {
		return false;
	}
}

function claimJournalWriteLockRemoval(
	lockPath: string,
	oldRecord: JournalWriteLockRecord,
): JournalWriteLockRemovalClaim | undefined {
	if (!isAcceptedJournalWriteLockToken(oldRecord.token)) return undefined;
	const claimsPath = `${lockPath}${JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX}`;
	let claimsIdentity: { device: number; inode: number };
	try {
		claimsIdentity = assertSecureClaimsDirectory(claimsPath);
	} catch {
		return undefined;
	}
	const claimPath = join(claimsPath, oldRecord.token);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			claimPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
			0o600,
		);
		if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		const marker = {
			version: 1,
			type: "journal-lock-removal-claim",
			lockRecord: oldRecord,
			claimer: {
				ownerPid: process.pid,
				...processIdentityRecordFields(),
				token: newJournalWriteLockToken(),
				createdAt: new Date().toISOString(),
			},
		};
		writeAllSync(descriptor, `${JSON.stringify(marker)}\n`);
		fsyncSync(descriptor);
		const stat = fstatSync(descriptor);
		if (
			!stat.isFile() ||
			(process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
			!sameDirectoryIdentity(claimsPath, claimsIdentity) ||
			!pathMatchesOpenDescriptor(claimPath, descriptor)
		) {
			throw new Error(`Unsafe orphan process journal lock removal claim ${claimPath}`);
		}
		return { descriptor, path: claimPath, device: stat.dev, inode: stat.ino };
	} catch {
		if (descriptor !== undefined) {
			try {
				if (pathMatchesOpenDescriptor(claimPath, descriptor)) unlinkSync(claimPath);
			} catch {
				// Never remove a path that no longer resolves to our exclusive marker.
			}
			closeSync(descriptor);
		}
		return undefined;
	}
}

function releaseJournalWriteLockRemovalClaim(claim: JournalWriteLockRemovalClaim): void {
	try {
		const opened = fstatSync(claim.descriptor);
		const current = lstatSync(claim.path);
		if (
			opened.dev === claim.device &&
			opened.ino === claim.inode &&
			!current.isSymbolicLink() &&
			current.isFile() &&
			current.dev === claim.device &&
			current.ino === claim.inode
		) {
			unlinkSync(claim.path);
		}
	} catch {
		// An abandoned or replaced claim fails closed; never unlink its pathname.
	} finally {
		closeSync(claim.descriptor);
	}
}

function safelyRemoveOwnCandidate(candidate: JournalWriteLockCandidate): void {
	try {
		if (pathMatchesOpenDescriptor(candidate.path, candidate.descriptor)) unlinkSync(candidate.path);
	} catch {
		// A replaced candidate path is not ours. Candidate residue is inert.
	} finally {
		closeSync(candidate.descriptor);
	}
}

function createJournalWriteLockCandidate(lockPath: string): JournalWriteLockCandidate {
	const token = newJournalWriteLockToken();
	const now = Date.now();
	const record: JournalWriteLockRecord = {
		version: JOURNAL_WRITE_LOCK_VERSION,
		ownerPid: process.pid,
		...processIdentityRecordFields(),
		token,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + JOURNAL_WRITE_LOCK_LEASE_MS).toISOString(),
	};
	const path = `${lockPath}.candidate-${process.pid}-${token}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
		if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		writeAllSync(descriptor, `${JSON.stringify(record)}\n`);
		fsyncSync(descriptor);
		return { descriptor, path, record };
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				if (pathMatchesOpenDescriptor(path, descriptor)) unlinkSync(path);
			} catch {
				// Candidate cleanup never grants authority over another inode.
			}
			closeSync(descriptor);
		}
		throw error;
	}
}

type JournalWriteLockReclaimResult = "not-reclaimed" | "reclaimed" | "acquired";

function reclaimExpiredDeadJournalWriteLock(
	path: string,
	candidate: JournalWriteLockCandidate,
): JournalWriteLockReclaimResult {
	const observed = readJournalWriteLockRecord(path);
	if (!observed || Date.parse(observed.expiresAt) > Date.now() || !journalWriteLockOwnerIsExactDead(observed)) {
		return "not-reclaimed";
	}
	const claim = claimJournalWriteLockRemoval(path, observed);
	if (!claim) return "not-reclaimed";
	try {
		const confirmed = openCanonicalJournalWriteLock(path);
		if (!confirmed) return "not-reclaimed";
		try {
			if (
				!sameJournalWriteLockRecord(confirmed.record, observed) ||
				Date.parse(confirmed.record.expiresAt) > Date.now() ||
				!journalWriteLockOwnerIsExactDead(confirmed.record) ||
				!pathMatchesOpenDescriptor(path, confirmed.descriptor)
			) {
				return "not-reclaimed";
			}
			unlinkSync(path);
			try {
				linkSync(candidate.path, path);
				return "acquired";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return "reclaimed";
				throw error;
			}
		} finally {
			closeCanonicalJournalWriteLock(confirmed);
		}
	} finally {
		releaseJournalWriteLockRemovalClaim(claim);
	}
}

function acquireJournalWriteLock(path: string): JournalWriteLock {
	const lockPath = `${path}${JOURNAL_WRITE_LOCK_SUFFIX}`;
	try {
		assertSecureClaimsDirectory(`${lockPath}${JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX}`);
	} catch (error) {
		throw new Error(`Cannot acquire orphan process journal lock ${lockPath}`, { cause: error });
	}
	const deadline = Date.now() + JOURNAL_WRITE_LOCK_TIMEOUT_MS;
	const candidate = createJournalWriteLockCandidate(lockPath);
	try {
		while (true) {
			try {
				linkSync(candidate.path, lockPath);
				safelyRemoveOwnCandidate(candidate);
				return { path: lockPath, record: candidate.record };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const reclaimed = reclaimExpiredDeadJournalWriteLock(lockPath, candidate);
				if (reclaimed === "acquired") {
					safelyRemoveOwnCandidate(candidate);
					return { path: lockPath, record: candidate.record };
				}
				if (Date.now() >= deadline) {
					throw new Error(`Cannot acquire orphan process journal lock ${lockPath}`, { cause: error });
				}
				Atomics.wait(journalLockWaitBuffer, 0, 0, 10);
			}
		}
	} catch (error) {
		safelyRemoveOwnCandidate(candidate);
		if (error instanceof Error && error.message.startsWith("Cannot acquire orphan process journal lock")) {
			throw error;
		}
		throw new Error(`Cannot acquire orphan process journal lock ${lockPath}`, { cause: error });
	}
}

function releaseJournalWriteLock(lock: JournalWriteLock): void {
	const claim = claimJournalWriteLockRemoval(lock.path, lock.record);
	if (!claim) return;
	try {
		const current = openCanonicalJournalWriteLock(lock.path);
		if (!current) return;
		try {
			if (
				sameJournalWriteLockRecord(current.record, lock.record) &&
				pathMatchesOpenDescriptor(lock.path, current.descriptor)
			) {
				unlinkSync(lock.path);
			}
		} finally {
			closeCanonicalJournalWriteLock(current);
		}
	} catch {
		// A missing, malformed, or replaced lock must not authorize deletion.
	} finally {
		releaseJournalWriteLockRemovalClaim(claim);
	}
}

function withJournalWriteLock<T>(path: string, action: () => T): T {
	const lock = acquireJournalWriteLock(path);
	try {
		return action();
	} finally {
		releaseJournalWriteLock(lock);
	}
}

function openedPathIsCurrent(descriptor: number, path: string): boolean {
	const opened = fstatSync(descriptor);
	const current = lstatSync(path);
	return opened.dev === current.dev && opened.ino === current.ino && opened.size === current.size;
}

function isPositivePid(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

function isLegacyOrphanProcessRecord(value: unknown): value is LegacyOrphanProcessRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<LegacyOrphanProcessRecord>;
	return (
		record.version === 1 &&
		isPositivePid(record.pid) &&
		isPositivePid(record.ownerPid) &&
		(record.kernelPid === undefined || isPositivePid(record.kernelPid)) &&
		(record.processStartId === undefined ||
			(typeof record.processStartId === "string" &&
				(isExactProcessStartId(record.processStartId) ||
					isLegacyProcessIdentity(record.processStartId) ||
					isCoarseProcessIdentity(record.processStartId)))) &&
		typeof record.active === "boolean" &&
		typeof record.recordedAt === "string"
	);
}

function isOrphanProcessJournalHeader(value: unknown): value is OrphanProcessJournalHeader {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<OrphanProcessJournalHeader>;
	return (
		record.version === 2 &&
		record.type === "authority" &&
		typeof record.generation === "string" &&
		record.generation.length > 0 &&
		record.sequence === 0 &&
		typeof record.createdAt === "string"
	);
}

function isOrphanProcessJournalRecord(value: unknown): value is OrphanProcessJournalRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<OrphanProcessJournalRecord>;
	return (
		record.version === 2 &&
		record.type === "process" &&
		typeof record.generation === "string" &&
		record.generation.length > 0 &&
		isPositivePid(record.sequence) &&
		isPositivePid(record.pid) &&
		isPositivePid(record.ownerPid) &&
		(record.kernelPid === undefined || isPositivePid(record.kernelPid)) &&
		(record.kernelProcessStartId === undefined ||
			(typeof record.kernelProcessStartId === "string" && record.kernelProcessStartId.length > 0)) &&
		(record.kernelAuthorityProcessStartId === undefined ||
			isExactProcessIdentity(record.kernelAuthorityProcessStartId)) &&
		hasConsistentRollingIdentity(record.kernelProcessStartId, record.kernelAuthorityProcessStartId) &&
		(record.admissionGeneration === undefined ||
			(typeof record.admissionGeneration === "string" &&
				KERNEL_ADMISSION_GENERATION_PATTERN.test(record.admissionGeneration))) &&
		(record.kernelLineage === undefined ||
			(typeof record.kernelLineage === "string" && KERNEL_LINEAGE_PATTERN.test(record.kernelLineage))) &&
		(record.processStartId === undefined ||
			(typeof record.processStartId === "string" && record.processStartId.length > 0)) &&
		(record.authorityProcessStartId === undefined || isExactProcessIdentity(record.authorityProcessStartId)) &&
		hasConsistentRollingIdentity(record.processStartId, record.authorityProcessStartId) &&
		(record.processStartId !== undefined || record.authorityProcessStartId !== undefined) &&
		(record.state === "enrolled" || record.state === "retired") &&
		typeof record.recordedAt === "string"
	);
}

function candidateKey(ownerPid: number, candidate: ActiveOrphanProcessCandidate): string {
	return JSON.stringify([
		ownerPid,
		candidate.pid,
		candidate.processStartId ?? null,
		candidate.kernelPid ?? null,
		candidate.kernelProcessStartId ?? null,
		candidate.admissionGeneration ?? null,
		candidate.kernelLineage ?? null,
	]);
}

/** One reduced live record: the candidate view plus the v2 record that created it. */
interface JournalLiveEntry {
	candidate: ActiveOrphanProcessCandidate & { ownerPid: number };
	/** Absent only for legacy-v1 anchors, which compaction refuses to rewrite. */
	record?: OrphanProcessJournalRecord;
}

interface JournalReduction {
	generation?: string;
	sequence?: number;
	live: Map<string, JournalLiveEntry>;
	hasTruncatedTail: boolean;
	/** Any legacy-v1 line at all. Such a file is never rewritten by compaction. */
	hasLegacyRecords: boolean;
	/** Verbatim header line, so compaction reproduces the exact v2 header bytes. */
	headerLine?: string;
}

/** The single projection from a stored v2 record to its reduced candidate. */
function journalRecordCandidate(
	record: OrphanProcessJournalRecord,
): ActiveOrphanProcessCandidate & { ownerPid: number } {
	const kernelProcessStartId = record.kernelAuthorityProcessStartId ?? record.kernelProcessStartId;
	const processStartId = record.authorityProcessStartId ?? record.processStartId;
	return {
		ownerPid: record.ownerPid,
		pid: record.pid,
		...(record.kernelPid !== undefined ? { kernelPid: record.kernelPid } : {}),
		...(kernelProcessStartId !== undefined ? { kernelProcessStartId } : {}),
		...(record.admissionGeneration !== undefined ? { admissionGeneration: record.admissionGeneration } : {}),
		...(record.kernelLineage !== undefined ? { kernelLineage: record.kernelLineage } : {}),
		...(processStartId !== undefined ? { processStartId } : {}),
	};
}

function reduceJournalContents(path: string, contents: string, failOnInvalidRecord: boolean): JournalReduction {
	const lines = contents.split("\n");
	const hasTruncatedTail = contents.length > 0 && !contents.endsWith("\n");
	const live = new Map<string, JournalLiveEntry>();
	let generation: string | undefined;
	let sequence: number | undefined;
	let headerLine: string | undefined;
	let hasLegacyRecords = false;
	let headerSeen = false;

	for (const [index, line] of lines.entries()) {
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			if (failOnInvalidRecord && !(hasTruncatedTail && index === lines.length - 1)) {
				throw invalidJournalError(path, "malformed complete record", error);
			}
			continue;
		}

		if (isLegacyOrphanProcessRecord(parsed)) {
			if (headerSeen) {
				if (failOnInvalidRecord) throw invalidJournalError(path, "legacy record after generation header");
				continue;
			}
			hasLegacyRecords = true;
			if (!parsed.active) {
				const hasPriorEnrollment = [...live.values()].some(
					(entry) => entry.candidate.ownerPid === parsed.ownerPid && entry.candidate.pid === parsed.pid,
				);
				if (!hasPriorEnrollment && failOnInvalidRecord) {
					throw invalidJournalError(path, "legacy retirement hint without prior enrollment");
				}
				// Legacy-v1 `active:false` only proves that a signal was delivered. It
				// is a cleanup hint, never exact-death authority, so it cannot erase.
				continue;
			}
			const candidate: ActiveOrphanProcessCandidate & { ownerPid: number } = {
				ownerPid: parsed.ownerPid,
				pid: parsed.pid,
				...(parsed.kernelPid !== undefined ? { kernelPid: parsed.kernelPid } : {}),
				...(parsed.processStartId ? { processStartId: parsed.processStartId } : {}),
			};
			live.set(candidateKey(parsed.ownerPid, candidate), { candidate });
			continue;
		}

		if (isOrphanProcessJournalHeader(parsed)) {
			if (headerSeen) {
				if (failOnInvalidRecord) throw invalidJournalError(path, "duplicate generation header");
				continue;
			}
			headerSeen = true;
			headerLine = line;
			generation = parsed.generation;
			sequence = parsed.sequence;
			continue;
		}

		if (isOrphanProcessJournalRecord(parsed)) {
			if (!headerSeen || parsed.generation !== generation) {
				if (failOnInvalidRecord) throw invalidJournalError(path, "generation mismatch or missing header");
				continue;
			}
			if (sequence === undefined || parsed.sequence !== sequence + 1) {
				if (failOnInvalidRecord) throw invalidJournalError(path, "non-monotonic process sequence");
				continue;
			}
			sequence = parsed.sequence;
			const candidate = journalRecordCandidate(parsed);
			const key = candidateKey(parsed.ownerPid, candidate);
			if (parsed.state === "enrolled") {
				if (live.has(key) && failOnInvalidRecord) {
					throw invalidJournalError(path, "duplicate enrollment without retirement");
				}
				live.set(key, { candidate, record: parsed });
			} else if (!live.delete(key) && failOnInvalidRecord) {
				throw invalidJournalError(path, "retirement without matching enrollment");
			}
			continue;
		}

		if (failOnInvalidRecord) throw invalidJournalError(path, "unrecognized complete record");
	}

	return { generation, sequence, live, hasTruncatedTail, hasLegacyRecords, headerLine };
}

function parseJournalContents(
	path: string,
	contents: string,
	failOnInvalidRecord: boolean,
): Omit<JournalSnapshot, "device" | "inode" | "size"> {
	const reduction = reduceJournalContents(path, contents, failOnInvalidRecord);
	return {
		generation: reduction.generation,
		sequence: reduction.sequence,
		candidates: [...reduction.live.values()].map((entry) => entry.candidate),
		hasTruncatedTail: reduction.hasTruncatedTail,
	};
}

function decodeJournalUtf8Strict(path: string, bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (error) {
		throw invalidJournalError(path, "invalid UTF-8", error);
	}
}

function readJournalUtf8Strict(path: string, descriptor: number): string {
	return decodeJournalUtf8Strict(path, readFileSync(descriptor));
}

function readJournalSnapshot(path: string, failOnInvalidRecord: boolean, allowMissing: boolean): JournalSnapshot {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { candidates: [], hasTruncatedTail: false };
		}
		throw error;
	}
	try {
		const contents = readJournalUtf8Strict(path, descriptor);
		const parsed = parseJournalContents(path, contents, failOnInvalidRecord);
		const stat = fstatSync(descriptor);
		return { ...parsed, device: stat.dev, inode: stat.ino, size: stat.size };
	} finally {
		closeSync(descriptor);
	}
}

function assertExpectedGeneration(
	path: string,
	actual: string | undefined,
	expected: string | undefined,
	requireBinding = expected !== undefined,
): void {
	if (requireBinding && actual !== expected) {
		throw invalidJournalError(path, `expected generation ${expected ?? "legacy-v1"}, found ${actual ?? "legacy-v1"}`);
	}
}

interface JournalIdentity {
	device: bigint;
	inode: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

/**
 * One process's reduced view of a journal, loaded once and then advanced by
 * every append this process makes. Disk stays the authority: the index is only
 * reused when the open descriptor and the pathname still name the same inode
 * with exactly the bytes and timestamps this process last observed, so any
 * other writer, truncation, or replacement forces a full re-read.
 */
interface JournalMemoryIndex extends JournalIdentity {
	generation: string;
	sequence: number;
	live: Map<string, JournalLiveEntry>;
	headerLine: string;
	/** False once a legacy-v1 anchor is present; compaction cannot re-emit those. */
	compactable: boolean;
}

const journalMemoryIndexes = new Map<string, JournalMemoryIndex>();
const journalCompactionDisabled = new Set<string>();

function forgetJournalMemoryIndex(path: string): void {
	journalMemoryIndexes.delete(path);
}

function rememberJournalMemoryIndex(path: string, index: JournalMemoryIndex): void {
	journalMemoryIndexes.delete(path);
	journalMemoryIndexes.set(path, index);
	for (const oldest of journalMemoryIndexes.keys()) {
		if (journalMemoryIndexes.size <= JOURNAL_MEMORY_INDEX_MAX_PATHS) break;
		journalMemoryIndexes.delete(oldest);
	}
}

/** Exact same-inode proof for the open descriptor and the pathname together. */
function currentJournalIdentity(descriptor: number, path: string): JournalIdentity {
	const opened = fstatSync(descriptor, { bigint: true });
	const current = lstatSync(path, { bigint: true });
	if (
		!opened.isFile() ||
		current.isSymbolicLink() ||
		!current.isFile() ||
		opened.dev !== current.dev ||
		opened.ino !== current.ino ||
		opened.size !== current.size
	) {
		throw invalidJournalError(path, "authority was replaced");
	}
	return {
		device: opened.dev,
		inode: opened.ino,
		size: opened.size,
		mtimeNs: opened.mtimeNs,
		ctimeNs: opened.ctimeNs,
	};
}

function sameJournalIdentity(left: JournalIdentity, right: JournalIdentity): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function applyJournalIdentity(index: JournalMemoryIndex, identity: JournalIdentity): void {
	index.device = identity.device;
	index.inode = identity.inode;
	index.size = identity.size;
	index.mtimeNs = identity.mtimeNs;
	index.ctimeNs = identity.ctimeNs;
}

/** Reuses the in-memory reduction, or rebuilds it from one full strict read. */
function loadJournalMemoryIndex(
	path: string,
	descriptor: number,
	expectedGeneration: string,
	identity: JournalIdentity,
): JournalMemoryIndex {
	const cached = journalMemoryIndexes.get(path);
	if (cached !== undefined && cached.generation === expectedGeneration && sameJournalIdentity(cached, identity)) {
		return cached;
	}
	const reduction = reduceJournalContents(path, readJournalUtf8Strict(path, descriptor), true);
	assertExpectedGeneration(path, reduction.generation, expectedGeneration);
	if (reduction.hasTruncatedTail) throw invalidJournalError(path, "cannot append after a torn final record");
	if (reduction.sequence === undefined || reduction.generation === undefined || reduction.headerLine === undefined) {
		throw invalidJournalError(path, "missing generation sequence");
	}
	const index: JournalMemoryIndex = {
		generation: reduction.generation,
		sequence: reduction.sequence,
		live: reduction.live,
		headerLine: reduction.headerLine,
		compactable: !reduction.hasLegacyRecords,
		...identity,
	};
	rememberJournalMemoryIndex(path, index);
	return index;
}

/** Best-effort durability for the compaction rename; the rename itself is atomic. */
function syncJournalDirectory(path: string): void {
	if (process.platform === "win32") return;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(dirname(path), constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch {
		// A directory that refuses fsync still leaves the rename atomic.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * Rewrites the journal from the in-memory live set: the verbatim header, then
 * one enrolled record per live candidate renumbered from 1. Output goes to a
 * private 0600 temp file that is fsynced and renamed over the authority, so a
 * crash at any point leaves either the complete previous log or the complete
 * compacted one. Called only from the retire path, under the append lock, after
 * the retirement record is already durable.
 */
function compactJournalAuthority(path: string, index: JournalMemoryIndex): void {
	if (!index.compactable || journalCompactionDisabled.has(path)) return;
	if (index.size < BigInt(ORPHAN_JOURNAL_COMPACT_MIN_BYTES) && index.sequence < ORPHAN_JOURNAL_COMPACT_MIN_RECORDS) {
		return;
	}
	// Rewriting a log that is mostly still live buys nothing and costs a full write.
	if (index.live.size * 2 > index.sequence) return;
	const compacted = new Map<string, JournalLiveEntry>();
	const lines: string[] = [index.headerLine];
	for (const [key, entry] of index.live) {
		if (entry.record === undefined) return;
		const record: OrphanProcessJournalRecord = { ...entry.record, sequence: lines.length };
		lines.push(JSON.stringify(record));
		compacted.set(key, { candidate: entry.candidate, record });
	}
	const temporaryPath = `${path}.compact-${process.pid}-${randomUUID()}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
			0o600,
		);
		if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
		writeAllSync(descriptor, `${lines.join("\n")}\n`);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, path);
		syncJournalDirectory(path);
		const reopened = openSync(path, constants.O_RDONLY | noFollowFlag());
		try {
			applyJournalIdentity(index, currentJournalIdentity(reopened, path));
		} finally {
			closeSync(reopened);
		}
		index.sequence = lines.length - 1;
		index.live = compacted;
	} catch {
		// The retirement is already durable in whichever file survived. Never retry.
		journalCompactionDisabled.add(path);
		forgetJournalMemoryIndex(path);
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// An unclosable descriptor is inert.
			}
		}
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Temp residue is inert; it is never canonical authority.
		}
	}
}

interface AppendJournalRecordOptions {
	/** Retire-only: rewrite the live set once the log outgrows the thresholds. */
	compactWhenLarge?: boolean;
}

function appendRecordToExistingAuthority(
	path: string,
	expectedGeneration: string,
	record: Omit<OrphanProcessJournalRecord, "sequence">,
	options: AppendJournalRecordOptions = {},
): void {
	withJournalWriteLock(path, () => {
		const descriptor = openSync(path, constants.O_RDWR | constants.O_APPEND);
		try {
			const identity = currentJournalIdentity(descriptor, path);
			const index = loadJournalMemoryIndex(path, descriptor, expectedGeneration, identity);
			const sequencedRecord: OrphanProcessJournalRecord = { ...record, sequence: index.sequence + 1 };
			const candidate = journalRecordCandidate(sequencedRecord);
			const key = candidateKey(record.ownerPid, candidate);
			if ((record.state === "enrolled") === index.live.has(key)) {
				throw invalidJournalError(path, `invalid ${record.state} transition`);
			}
			const line = `${JSON.stringify(sequencedRecord)}\n`;
			let appended: JournalIdentity;
			try {
				writeAllSync(descriptor, line);
				fsyncSync(descriptor);
				appended = currentJournalIdentity(descriptor, path);
			} catch (error) {
				forgetJournalMemoryIndex(path);
				throw error;
			}
			// One exclusive fsynced append: the only durable state is old bytes plus
			// exactly this record on the same inode. Anything else re-reads next time.
			if (
				appended.device !== identity.device ||
				appended.inode !== identity.inode ||
				appended.size !== identity.size + BigInt(Buffer.byteLength(line, "utf8"))
			) {
				forgetJournalMemoryIndex(path);
				throw invalidJournalError(path, "authority changed after append");
			}
			index.sequence = sequencedRecord.sequence;
			if (record.state === "enrolled") index.live.set(key, { candidate, record: sequencedRecord });
			else index.live.delete(key);
			applyJournalIdentity(index, appended);
			rememberJournalMemoryIndex(path, index);
			if (options.compactWhenLarge) compactJournalAuthority(path, index);
		} finally {
			closeSync(descriptor);
		}
	});
}

/** Creates and fsyncs an immutable random generation header before launch. */
export function initializeOrphanProcessJournal(path: string): OrphanProcessJournalAuthority {
	forgetJournalMemoryIndex(path);
	const generation = randomUUID();
	const header: OrphanProcessJournalHeader = {
		version: 2,
		type: "authority",
		generation,
		sequence: 0,
		createdAt: new Date().toISOString(),
	};
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeAllSync(descriptor, `${JSON.stringify(header)}\n`);
		fsyncSync(descriptor);
		if (!openedPathIsCurrent(descriptor, path))
			throw invalidJournalError(path, "authority was replaced during initialization");
	} catch (error) {
		let removePartial = false;
		try {
			removePartial = openedPathIsCurrent(descriptor, path);
		} catch {
			// A replaced path is not ours to remove.
		}
		closeSync(descriptor);
		if (removePartial) rmSync(path, { force: true });
		throw error;
	}
	closeSync(descriptor);
	return { path, generation };
}

/** Strictly reads an existing authority without creating or repairing it. */
export function readOrphanProcessJournalAuthority(path: string): OrphanProcessJournalAuthority | undefined {
	const snapshot = readJournalSnapshot(path, true, false);
	return snapshot.generation ? { path, generation: snapshot.generation } : undefined;
}

export interface StrictOrphanProcessJournalReadTestHooks {
	/** Deterministic assertion seam; the canonical append lock is held here. */
	whileLocked?: () => void;
}

/**
 * Reads one existing v2 generation while holding the journal's canonical
 * append lock. This never creates, repairs, truncates, or upgrades authority.
 * Callers use it only after the strict reducer proved that no active records
 * remain, so a legacy descriptor can bind to the exact header already on disk.
 */
export function readStrictEmptyOrphanProcessJournalAuthority(
	path: string,
	testHooks?: Readonly<StrictOrphanProcessJournalReadTestHooks>,
): OrphanProcessJournalAuthority {
	return withJournalWriteLock(path, () => {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
			const opened = fstatSync(descriptor, { bigint: true });
			const authorityBytes = readDescriptorExactly(descriptor, opened.size, ORPHAN_JOURNAL_STRICT_MAX_BYTES);
			const contents = decodeJournalUtf8Strict(path, authorityBytes);
			const current = lstatSync(path, { bigint: true });
			if (
				!opened.isFile() ||
				current.isSymbolicLink() ||
				!current.isFile() ||
				opened.dev !== current.dev ||
				opened.ino !== current.ino ||
				opened.size !== current.size
			) {
				throw invalidJournalError(path, "authority changed during strict generation read");
			}
			const firstLine = contents.split("\n").find((line) => line.length > 0);
			if (!firstLine) throw invalidJournalError(path, "missing generation header");
			const header = JSON.parse(firstLine) as unknown;
			if (
				!isOrphanProcessJournalHeader(header) ||
				!isJournalWriteLockTimestamp(header.createdAt) ||
				Object.keys(header).sort().join(",") !== "createdAt,generation,sequence,type,version"
			) {
				throw invalidJournalError(path, "generation header is not the exact v2 schema");
			}
			const snapshot = parseJournalContents(path, contents, true);
			if (
				snapshot.hasTruncatedTail ||
				snapshot.generation !== header.generation ||
				snapshot.candidates.length !== 0
			) {
				throw invalidJournalError(path, "authority is truncated, replaced, or still active");
			}
			testHooks?.whileLocked?.();
			const confirmed = lstatSync(path, { bigint: true });
			if (
				confirmed.isSymbolicLink() ||
				!confirmed.isFile() ||
				confirmed.dev !== opened.dev ||
				confirmed.ino !== opened.ino ||
				confirmed.size !== opened.size ||
				!readDescriptorExactly(descriptor, opened.size, ORPHAN_JOURNAL_STRICT_MAX_BYTES).equals(authorityBytes)
			) {
				throw invalidJournalError(path, "authority changed before strict generation read completed");
			}
			return { path, generation: header.generation };
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Invalid orphan process journal")) throw error;
			throw invalidJournalError(path, "strict generation read failed", error);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	});
}

/**
 * Binds a launch to an existing generation. Legacy-v1 files may be upgraded only
 * after every recorded process identity/tree is proven dead.
 */
export function bindOrUpgradeOrphanProcessJournalAuthority(
	path: string,
	expectedGeneration?: string,
	beforeLegacyUpgrade?: (generation: string) => void,
): OrphanProcessJournalAuthority {
	return withJournalWriteLock(path, () => {
		forgetJournalMemoryIndex(path);
		const descriptor = openSync(path, constants.O_RDWR | constants.O_APPEND);
		try {
			let contents = readJournalUtf8Strict(path, descriptor);
			let snapshot = parseJournalContents(path, contents, true);
			if (snapshot.hasTruncatedTail) {
				if (expectedGeneration === undefined) throw invalidJournalError(path, "cannot bind a torn authority");
				const finalNewline = contents.lastIndexOf("\n");
				const tornTail = contents.slice(finalNewline + 1);
				const expectedHeaderPrefix = `{"version":2,"type":"authority","generation":"${expectedGeneration}"`;
				if (snapshot.generation !== expectedGeneration && !tornTail.startsWith(expectedHeaderPrefix)) {
					throw invalidJournalError(path, "cannot bind an ambiguous torn authority");
				}
				contents = finalNewline < 0 ? "" : contents.slice(0, finalNewline + 1);
				ftruncateSync(descriptor, Buffer.byteLength(contents));
				fsyncSync(descriptor);
				snapshot = parseJournalContents(path, contents, true);
			}
			if (!openedPathIsCurrent(descriptor, path)) throw invalidJournalError(path, "authority was replaced");
			if (snapshot.generation !== undefined) {
				assertExpectedGeneration(path, snapshot.generation, expectedGeneration, true);
				return { path, generation: snapshot.generation };
			}
			if (!snapshot.candidates.every((candidate) => isOrphanProcessCandidateExactDead(candidate))) {
				throw invalidJournalError(path, "legacy authority still has live or unverifiable candidates");
			}
			const generation = expectedGeneration ?? randomUUID();
			// The caller can durably bind its descriptor before the v2 header is
			// appended. A crash on either side is retryable: descriptor-first legacy
			// binding reuses expectedGeneration, while header-first is forbidden.
			beforeLegacyUpgrade?.(generation);
			const header: OrphanProcessJournalHeader = {
				version: 2,
				type: "authority",
				generation,
				sequence: 0,
				createdAt: new Date().toISOString(),
			};
			writeAllSync(descriptor, `${JSON.stringify(header)}\n`);
			fsyncSync(descriptor);
			if (!openedPathIsCurrent(descriptor, path)) throw invalidJournalError(path, "authority was replaced");
			const confirmed = readJournalSnapshot(path, true, false);
			assertExpectedGeneration(path, confirmed.generation, generation);
			if (confirmed.hasTruncatedTail || confirmed.sequence !== 0) {
				throw invalidJournalError(path, "authority changed during upgrade");
			}
			return { path, generation };
		} finally {
			closeSync(descriptor);
		}
	});
}

function configuredJournalAuthority(): OrphanProcessJournalAuthority | undefined {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	const generation = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	if (path === undefined && generation === undefined) return undefined;
	if (!path || !generation) {
		throw new Error("Incomplete orphan process journal authority environment");
	}
	return { path, generation };
}

/** Enrolls a process identity in the configured authority before it can escape cleanup. */
export function enrollOrphanProcess(
	pid: number,
	kernelPid?: number,
	expectedProcessStartId?: string,
	lineage?: KernelAdmissionLineage,
): ActiveOrphanProcessCandidate {
	const boundKernelPid = lineage?.kernelPid ?? kernelPid;
	if (
		!isPositivePid(pid) ||
		(boundKernelPid !== undefined && !isPositivePid(boundKernelPid)) ||
		(kernelPid !== undefined && lineage !== undefined && kernelPid !== lineage.kernelPid) ||
		(lineage !== undefined && !hasExactKernelAdmissionLineage({ pid, ...lineage }))
	) {
		throw new Error(`Invalid orphan process enrollment pid or kernel lineage for ${pid}`);
	}
	const identity = observeProcessIdentity(pid);
	if (
		expectedProcessStartId !== undefined &&
		(!isExactProcessIdentity(expectedProcessStartId) ||
			identity.status !== "present-exact" ||
			identity.id !== expectedProcessStartId)
	) {
		throw new Error(`Process identity changed before orphan enrollment for pid ${pid}`);
	}
	const processStartId =
		expectedProcessStartId ??
		(identity.status === "present-exact"
			? identity.id
			: identity.status === "present-coarse"
				? identity.hint
				: undefined);
	const candidate: ActiveOrphanProcessCandidate = {
		pid,
		...(boundKernelPid !== undefined ? { kernelPid: boundKernelPid } : {}),
		...(lineage !== undefined ? candidateLineageFields(lineage) : {}),
		...(processStartId ? { processStartId } : {}),
	};
	const authority = configuredJournalAuthority();
	if (!authority) return candidate;
	if (!processStartId) {
		throw new Error(`Cannot establish processStartId for enrolled process ${pid}`);
	}
	appendRecordToExistingAuthority(authority.path, authority.generation, {
		version: 2,
		type: "process",
		generation: authority.generation,
		pid,
		ownerPid: process.pid,
		...journalCandidateLineageFields(candidate),
		...recordIdentityFields(processStartId, "processStartId", "authorityProcessStartId"),
		state: "enrolled",
		recordedAt: new Date().toISOString(),
	});
	return candidate;
}

interface OrphanProcessCleanupProof {
	type: "held-windows-job-empty";
	pid: number;
	kernelPid?: number;
	kernelProcessStartId?: string;
	admissionGeneration?: string;
	kernelLineage?: string;
	processStartId?: string;
}

function heldWindowsJobEmptyProof(candidate: ActiveOrphanProcessCandidate): OrphanProcessCleanupProof {
	return {
		type: "held-windows-job-empty",
		pid: candidate.pid,
		...candidateLineageFields(candidate),
		...(candidate.processStartId !== undefined ? { processStartId: candidate.processStartId } : {}),
	};
}

function appendOrphanProcessRetirement(
	candidate: ActiveOrphanProcessCandidate,
	proof?: OrphanProcessCleanupProof,
): boolean {
	if (!orphanProcessCandidateCleanupProven(candidate, {}, proof)) return false;
	const authority = configuredJournalAuthority();
	if (!authority) return true;
	if (!candidate.processStartId) return false;
	appendRecordToExistingAuthority(
		authority.path,
		authority.generation,
		{
			version: 2,
			type: "process",
			generation: authority.generation,
			pid: candidate.pid,
			ownerPid: process.pid,
			...journalCandidateLineageFields(candidate),
			...recordIdentityFields(candidate.processStartId, "processStartId", "authorityProcessStartId"),
			state: "retired",
			recordedAt: new Date().toISOString(),
		},
		{ compactWhenLarge: true },
	);
	return true;
}

/** Appends retirement only after generic cleanup probes prove the candidate tree gone. */
export function retireOrphanProcess(candidate: ActiveOrphanProcessCandidate): boolean {
	return appendOrphanProcessRetirement(candidate);
}

/**
 * Live Windows owner attestation. Call only after the held Job for this exact
 * candidate reports zero active processes in the same cleanup operation.
 * Leader exit or successful `taskkill /T` delivery is not this proof.
 */
export function retireOrphanProcessAfterHeldWindowsJobEmpty(candidate: ActiveOrphanProcessCandidate): boolean {
	if (process.platform !== "win32") return false;
	return appendOrphanProcessRetirement(candidate, heldWindowsJobEmptyProof(candidate));
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	return readJournalSnapshot(path, false, true)
		.candidates.filter((record) => record.ownerPid === ownerPid)
		.map(({ ownerPid: _ownerPid, ...candidate }) => candidate);
}

/** Strict cleanup view: every active identity across generations, including legacy unverifiable ones. */
export function readActiveOrphanProcessCandidates(path: string): ActiveOrphanProcessCandidate[] {
	return readJournalSnapshot(path, true, false).candidates.map(({ ownerPid: _ownerPid, ...candidate }) => candidate);
}

export type OrphanProcessProbeOptions = ProcessIdentityObservationOptions;

type ProcessPresence = "absent" | "present" | "uncertain" | "unsupported";

function orphanProcessGroupPresence(pid: number, options: OrphanProcessProbeOptions = {}): ProcessPresence {
	const platform = options.platform ?? process.platform;
	if (platform === "win32" || !Number.isInteger(pid) || pid <= 0) return "unsupported";
	const processKill = options.processKill ?? ((target: number, signal: 0) => process.kill(target, signal));
	try {
		processKill(-pid, 0);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "present";
		return "uncertain";
	}
}

function matchesHeldWindowsJobEmptyProof(
	orphan: ActiveOrphanProcessCandidate,
	proof: OrphanProcessCleanupProof | undefined,
): boolean {
	return (
		proof?.type === "held-windows-job-empty" &&
		proof.pid === orphan.pid &&
		proof.kernelPid === orphan.kernelPid &&
		proof.kernelProcessStartId === orphan.kernelProcessStartId &&
		proof.admissionGeneration === orphan.admissionGeneration &&
		proof.kernelLineage === orphan.kernelLineage &&
		proof.processStartId === orphan.processStartId
	);
}

function orphanProcessCandidateCleanupProven(
	orphan: ActiveOrphanProcessCandidate,
	options: OrphanProcessProbeOptions = {},
	proof?: OrphanProcessCleanupProof,
): boolean {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return matchesHeldWindowsJobEmptyProof(orphan, proof);
	const identity = observeProcessIdentity(orphan.pid, options);
	const exactIdentity = isExactProcessIdentity(orphan.processStartId);
	if (!exactIdentity) {
		return identity.status === "absent" && orphanProcessGroupPresence(orphan.pid, options) === "absent";
	}
	const originalLeaderGone =
		identity.status === "absent" || (identity.status === "present-exact" && identity.id !== orphan.processStartId);
	if (!originalLeaderGone) return false;
	const group = orphanProcessGroupPresence(orphan.pid, options);
	return group === "absent";
}

export function isOrphanProcessIdentityCurrent(
	orphan: ActiveOrphanProcess,
	options: OrphanProcessProbeOptions = {},
): boolean {
	return (
		isExactProcessIdentity(orphan.processStartId) &&
		matchesExactProcessIdentity(orphan.pid, orphan.processStartId, options)
	);
}

/** True unless the POSIX process group is freshly proven absent. */
export function isOrphanProcessGroupAlive(pid: number, options: OrphanProcessProbeOptions = {}): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	return orphanProcessGroupPresence(pid, options) !== "absent";
}

/** True unless both the leader and its POSIX group are freshly proven absent. */
export function isOrphanProcessTreeAlive(pid: number, options: OrphanProcessProbeOptions = {}): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const group = orphanProcessGroupPresence(pid, options);
	if (group !== "absent") return true;
	return observeProcessIdentity(pid, options).status !== "absent";
}

/** Signal authority exists only for a durable identity that freshly matches. */
export function shouldReapOrphanProcess(orphan: ActiveOrphanProcess, options: OrphanProcessProbeOptions = {}): boolean {
	return (
		isExactProcessIdentity(orphan.processStartId) &&
		matchesExactProcessIdentity(orphan.pid, orphan.processStartId, options)
	);
}

/** Compatibility name: true means cleanup-proven; non-exact POSIX anchors require PID and group absence. */
export function isOrphanProcessCandidateExactDead(
	orphan: ActiveOrphanProcessCandidate,
	options: OrphanProcessProbeOptions = {},
): boolean {
	return orphanProcessCandidateCleanupProven(orphan, options);
}

function isOrphanProcessCandidateAuthorized(
	orphan: ActiveOrphanProcessCandidate,
	options: OrphanProcessProbeOptions = {},
	callerHasAuthority = true,
): boolean {
	return callerHasAuthority && shouldReapOrphanProcess(orphan, options);
}

async function waitForOrphanProcessCandidateExit(
	orphan: ActiveOrphanProcessCandidate,
	timeoutMs: number,
	options: OrphanProcessProbeOptions = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!orphanProcessCandidateCleanupProven(orphan, options) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return orphanProcessCandidateCleanupProven(orphan, options);
}

function signalExactOrphanProcess(
	orphan: ActiveOrphanProcessCandidate,
	signal: NodeJS.Signals,
	options: OrphanProcessProbeOptions = {},
): boolean {
	if (!isOrphanProcessCandidateAuthorized(orphan, options)) return false;
	if ((options.platform ?? process.platform) === "win32") return killOrphanProcess(orphan.pid);
	if (signalOrphanProcessGroup(orphan.pid, signal)) return true;
	// A leader outside the expected group can still be signaled, but only after
	// another strict match immediately before the leader-pid fallback.
	if (!isOrphanProcessCandidateAuthorized(orphan, options)) return false;
	try {
		process.kill(orphan.pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** Reap one strict-view candidate and prove its recorded process tree is gone. */
export async function reapOrphanProcessCandidate(
	orphan: ActiveOrphanProcessCandidate,
	beforeKill?: () => Promise<void>,
	probeOptions: OrphanProcessProbeOptions = {},
): Promise<boolean> {
	if (orphanProcessCandidateCleanupProven(orphan, probeOptions)) return true;
	if (!isOrphanProcessCandidateAuthorized(orphan, probeOptions)) return false;
	await beforeKill?.();
	if (orphanProcessCandidateCleanupProven(orphan, probeOptions)) return true;
	if (!isOrphanProcessCandidateAuthorized(orphan, probeOptions)) return false;
	if ((probeOptions.platform ?? process.platform) === "win32") {
		// This nonblocking bounded taskkill can request cleanup, but only the live
		// Job owner can later attest tree-empty and retire the record.
		if (!isOrphanProcessCandidateAuthorized(orphan, probeOptions)) return false;
		await requestWindowsProcessTreeKill(orphan.pid);
		return false;
	}

	signalExactOrphanProcess(orphan, "SIGTERM", probeOptions);
	if (await waitForOrphanProcessCandidateExit(orphan, 500, probeOptions)) return true;
	await beforeKill?.();
	if (orphanProcessCandidateCleanupProven(orphan, probeOptions)) return true;
	if (!isOrphanProcessCandidateAuthorized(orphan, probeOptions)) return false;
	const signaled = signalExactOrphanProcess(orphan, "SIGKILL", probeOptions);
	if (!signaled && !orphanProcessCandidateCleanupProven(orphan, probeOptions)) return false;
	return waitForOrphanProcessCandidateExit(orphan, 1000, probeOptions);
}

export interface ReapOrphanProcessAuthorityOptions {
	additionalCandidates?: readonly ActiveOrphanProcessCandidate[];
	beforeKill?: () => Promise<void>;
	expectedGeneration?: string;
	probeOptions?: OrphanProcessProbeOptions;
}

/** Reaps all candidates, then strict-rereads the same generation before reporting proof. */
export async function reapOrphanProcessAuthority(
	path: string,
	options: ReapOrphanProcessAuthorityOptions = {},
): Promise<boolean> {
	let initial: JournalSnapshot;
	try {
		initial = readJournalSnapshot(path, true, false);
		assertExpectedGeneration(
			path,
			initial.generation,
			options.expectedGeneration,
			Object.hasOwn(options, "expectedGeneration"),
		);
		if (initial.hasTruncatedTail) return false;
	} catch {
		return false;
	}
	const additionalCandidates = [...(options.additionalCandidates ?? [])];
	for (const candidate of [...additionalCandidates, ...initial.candidates]) {
		await reapOrphanProcessCandidate(candidate, options.beforeKill, options.probeOptions);
	}
	try {
		const confirmed = readJournalSnapshot(path, true, false);
		assertExpectedGeneration(
			path,
			confirmed.generation,
			options.expectedGeneration,
			Object.hasOwn(options, "expectedGeneration"),
		);
		if (confirmed.hasTruncatedTail || confirmed.generation !== initial.generation) return false;
		return [...additionalCandidates, ...confirmed.candidates].every((candidate) =>
			orphanProcessCandidateCleanupProven(candidate, options.probeOptions),
		);
	} catch {
		return false;
	}
}

export interface ClearOrphanProcessJournalTestHooks {
	/** Runs after canonical authority was moved, while the append lock is held. */
	afterQuarantine?: (quarantinePath: string) => void;
}

/**
 * Strictly revalidates the expected authority and exact death, then atomically
 * moves canonical authority to a unique same-directory quarantine. The moved
 * inode and complete bytes are pinned before only the quarantine path is
 * deleted. A canonical successor that appears after the move is untouched.
 */
export function clearOrphanProcessJournal(
	path: string,
	expectedGeneration?: string,
	probeOptions: OrphanProcessProbeOptions = {},
	testHooks?: Readonly<ClearOrphanProcessJournalTestHooks>,
): boolean {
	try {
		return withJournalWriteLock(path, () => {
			forgetJournalMemoryIndex(path);
			let descriptor: number | undefined;
			let quarantinedDescriptor: number | undefined;
			const quarantinePath = `${path}.quarantine-${process.pid}-${randomUUID()}`;
			try {
				descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
				const opened = fstatSync(descriptor, { bigint: true });
				if (!opened.isFile()) return false;
				const contents = readDescriptorExactly(descriptor, opened.size, ORPHAN_JOURNAL_STRICT_MAX_BYTES);
				const snapshot = parseJournalContents(path, decodeJournalUtf8Strict(path, contents), true);
				assertExpectedGeneration(path, snapshot.generation, expectedGeneration, true);
				if (
					snapshot.hasTruncatedTail ||
					!snapshot.candidates.every((candidate) => orphanProcessCandidateCleanupProven(candidate, probeOptions))
				) {
					return false;
				}
				const canonical = lstatSync(path, { bigint: true });
				if (
					canonical.isSymbolicLink() ||
					!canonical.isFile() ||
					canonical.dev !== opened.dev ||
					canonical.ino !== opened.ino ||
					canonical.size !== opened.size
				) {
					return false;
				}
				renameSync(path, quarantinePath);
				testHooks?.afterQuarantine?.(quarantinePath);
				quarantinedDescriptor = openSync(quarantinePath, constants.O_RDONLY | noFollowFlag());
				const quarantined = fstatSync(quarantinedDescriptor, { bigint: true });
				const quarantinedPath = lstatSync(quarantinePath, { bigint: true });
				if (
					!quarantined.isFile() ||
					quarantinedPath.isSymbolicLink() ||
					!quarantinedPath.isFile() ||
					quarantined.dev !== opened.dev ||
					quarantined.ino !== opened.ino ||
					quarantined.size !== opened.size ||
					quarantinedPath.dev !== opened.dev ||
					quarantinedPath.ino !== opened.ino ||
					quarantinedPath.size !== opened.size ||
					!readDescriptorExactly(quarantinedDescriptor, quarantined.size, ORPHAN_JOURNAL_STRICT_MAX_BYTES).equals(
						contents,
					)
				) {
					return false;
				}
				unlinkSync(quarantinePath);
				try {
					lstatSync(path);
					return false;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "ENOENT";
				}
			} catch {
				return false;
			} finally {
				if (quarantinedDescriptor !== undefined) closeSync(quarantinedDescriptor);
				if (descriptor !== undefined) closeSync(descriptor);
			}
		});
	} catch {
		return false;
	}
}

// Kills only bash() children bound to one exact admitted kernel lineage.
// Legacy or partial lineage records remain sticky evidence for global recovery.
export function reapKernelOrphanProcesses(lineage: KernelAdmissionLineage): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !hasExactKernelAdmissionLineage({ pid: lineage.kernelPid, ...lineage })) return;
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return;
	}
	for (const orphan of orphans) {
		if (!matchesKernelAdmissionLineage(orphan, lineage) || orphan.pid === lineage.kernelPid) continue;
		// Signal authority requires both exact lineage selection and a fresh exact
		// process identity match immediately before the signal.
		signalExactOrphanProcess(orphan, "SIGKILL");
	}
}

/** Signal only the authorized POSIX process group, never a possibly reused leader pid. */
function signalOrphanProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

function killOrphanProcessGroup(pid: number): boolean {
	return signalOrphanProcessGroup(pid, "SIGKILL");
}

function windowsTaskkillEnvironment(): NodeJS.ProcessEnv {
	return {
		SystemRoot: WINDOWS_SYSTEM_ROOT,
		WINDIR: WINDOWS_SYSTEM_ROOT,
		NoDefaultCurrentDirectoryInExePath: "1",
	};
}

function windowsTaskkillArguments(pid: number): string[] {
	return ["/F", "/T", "/PID", String(pid)];
}

async function requestWindowsProcessTreeKill(pid: number): Promise<boolean> {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		const child = spawn(WINDOWS_TASKKILL_PATH, windowsTaskkillArguments(pid), {
			stdio: "ignore",
			timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
			killSignal: "SIGKILL",
			env: windowsTaskkillEnvironment(),
			cwd: WINDOWS_SYSTEM32,
			shell: false,
			windowsHide: true,
		});
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (delivered: boolean) => {
				if (settled) return;
				settled = true;
				resolve(delivered);
			};
			child.once("error", () => finish(false));
			child.once("close", (code) => finish(code === 0));
		});
	} catch {
		return false;
	}
}

function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		const result = spawnSync(WINDOWS_TASKKILL_PATH, windowsTaskkillArguments(pid), {
			stdio: "ignore",
			timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
			killSignal: "SIGKILL",
			env: windowsTaskkillEnvironment(),
			cwd: WINDOWS_SYSTEM32,
			shell: false,
			windowsHide: true,
		});
		// Status zero proves only taskkill accepted/delivered /T, never tree-empty.
		return result.status === 0;
	}
	return killOrphanProcessGroup(pid);
}
