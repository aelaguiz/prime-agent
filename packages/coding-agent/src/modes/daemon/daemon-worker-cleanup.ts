import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	AuthorityGuardContentionError,
	type AuthorityMutationGuard,
	acquireAuthorityMutationGuard,
	type HeldAuthorityMutationGuard,
} from "../../core/authority-mutation-guard.js";
import {
	type ActiveOrphanProcessCandidate,
	clearOrphanProcessJournal,
	isOrphanProcessCandidateExactDead,
	type OrphanProcessJournalAppendLockRecord,
	type OrphanProcessProbeOptions,
	parseOrphanProcessJournalAppendLockRecord,
	readOrphanProcessJournalAppendLock,
	readStrictEmptyOrphanProcessJournalAuthority,
	reapOrphanProcessAuthority,
} from "../../core/orphan-process-journal.js";
import {
	classifyProcessIdentityAuthority,
	isExactProcessStartId,
	observeProcessIdentity,
	type ProcessIdentityObservationOptions,
} from "../../core/session-lease.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "./daemon-socket.js";
import {
	type DaemonWorkerCleanupProof,
	type DaemonWorkerDescriptor,
	daemonWorkerProcessAuthority,
	durableDaemonWorkerDescriptor,
	parseDaemonWorkerDescriptor,
} from "./daemon-worker-protocol.js";

const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const MAX_RECOVERY_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_SWEEP_ARTIFACT_BYTES = 16 * 1024;
const CLEANUP_TOKEN_BYTES = 32;
const WORKER_MUTATION_GUARD_RETRIES = 100;
const WORKER_MUTATION_GUARD_RETRY_MS = 10;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

export type DaemonWorkerCleanupAuthorityPhase =
	| "persist-stop-tombstone"
	| "discard-stale-proof"
	| "signal"
	| "prove"
	| "persist-cleanup-proof"
	| "clear-journal"
	| "persist-journal-cleared"
	| "unlink-socket"
	| "unlink-recovery"
	| "unlink-descriptor";

export interface DaemonWorkerCleanupLayout {
	agentDir?: string;
	descriptorDir?: string;
	supervisorSocketPath?: string;
	platform?: NodeJS.Platform;
}

export interface CanonicalDaemonWorkerDescriptor {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	descriptorDirectory: string;
	device: bigint;
	inode: bigint;
	size: bigint;
	contents: string;
}

export type CanonicalDaemonWorkerDescriptorResult =
	| { ok: true; value: CanonicalDaemonWorkerDescriptor }
	| { ok: false; reason: string };

export type DaemonWorkerSocketObservation = "reachable" | "unreachable" | "uncertain";

export type DaemonWorkerQuarantinedArtifact =
	| "descriptor"
	| "socket"
	| "recovery"
	| "failed-socket"
	| "failed-recovery"
	| "sweep";

export interface DaemonWorkerCleanupTestHooks {
	/** Runs after canonical -> quarantine rename and before moved-inode validation. */
	afterArtifactQuarantine?: (
		artifact: DaemonWorkerQuarantinedArtifact,
		canonicalPath: string,
		quarantinePath: string,
	) => void;
	/** Deterministic durability-failure seam scoped to quarantined artifact fsyncs. */
	fsyncQuarantineDirectory?: (
		artifact: DaemonWorkerQuarantinedArtifact,
		directory: string,
		platform: NodeJS.Platform,
	) => void;
}

export interface DaemonWorkerCleanupOptions {
	descriptorPath: string;
	expectedWorkerId: string;
	expectedDescriptor?: DaemonWorkerDescriptor;
	layout: DaemonWorkerCleanupLayout;
	ensureStopTombstone?: boolean;
	assertAuthority: (phase: DaemonWorkerCleanupAuthorityPhase) => Promise<void>;
	observeSocket?: (socketPath: string) => Promise<DaemonWorkerSocketObservation>;
	probeOptions?: OrphanProcessProbeOptions;
	testHooks?: Readonly<DaemonWorkerCleanupTestHooks>;
	/** Existing canonical guard held by a wider launch/rollback transaction. */
	mutationGuard?: HeldAuthorityMutationGuard;
	afterDurablePhase?: (
		phase: "stop-tombstoned" | "cleanup-proven" | "journal-cleared" | "socket-removed" | "recovery-removed",
	) => void;
}

export type DaemonWorkerCleanupResult =
	| { status: "cleaned"; workerId: string }
	| { status: "retained"; reason: string; journalPath?: string };

class CleanupRetainedError extends Error {
	constructor(
		message: string,
		readonly journalPath?: string,
	) {
		super(message);
	}
}

function cleanupToken(): string {
	return randomBytes(CLEANUP_TOKEN_BYTES).toString("base64url");
}

function daemonWorkerGuardIdentity(): { processStartId?: string; processIdentityHint?: string } {
	const observation = observeProcessIdentity(process.pid);
	if (observation.status === "present-exact") return { processStartId: observation.id };
	if (observation.status === "present-coarse") return { processIdentityHint: observation.hint };
	throw new Error(`Cannot establish daemon worker mutation-guard owner identity (${observation.status})`);
}

export function daemonWorkerMutationGuardPath(descriptorPath: string): string {
	return `${resolve(descriptorPath)}.mutation.guard`;
}

function acquireDaemonWorkerMutationGuardOnce(descriptorPath: string): HeldAuthorityMutationGuard {
	const authorityPath = resolve(descriptorPath);
	return acquireAuthorityMutationGuard({
		authorityPath,
		lockfilePath: daemonWorkerMutationGuardPath(authorityPath),
		attempts: 1,
		retryMs: WORKER_MUTATION_GUARD_RETRY_MS,
		identity: daemonWorkerGuardIdentity(),
		classifyOwner: (owner) =>
			classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
		failureMessage: `Could not coordinate daemon worker authority: ${authorityPath}`,
	});
}

export async function acquireDaemonWorkerMutationGuard(descriptorPath: string): Promise<HeldAuthorityMutationGuard> {
	let lastError: unknown;
	for (let attempt = 0; attempt < WORKER_MUTATION_GUARD_RETRIES; attempt++) {
		try {
			return acquireDaemonWorkerMutationGuardOnce(descriptorPath);
		} catch (error) {
			lastError = error;
			if (!(error instanceof AuthorityGuardContentionError) || attempt === WORKER_MUTATION_GUARD_RETRIES - 1) {
				throw error;
			}
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, WORKER_MUTATION_GUARD_RETRY_MS));
		}
	}
	throw lastError;
}

function withDaemonWorkerMutationGuardSync<T>(descriptorPath: string, action: (guard: AuthorityMutationGuard) => T): T {
	const held = acquireDaemonWorkerMutationGuardOnce(descriptorPath);
	let result: T | undefined;
	let failure: unknown;
	try {
		held.assertCurrent();
		result = action(held);
		held.assertCurrent();
	} catch (error) {
		failure = error;
	}
	try {
		held.release();
	} catch (error) {
		failure ??= error;
	}
	if (failure) throw failure;
	return result as T;
}

function descriptorKey(socketPath: string): string {
	return createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex").slice(0, 12);
}

/** Pre-physical-normalization key retained only to recognize upgrade-era worker authority. */
function legacyDescriptorKey(socketPath: string, platform: NodeJS.Platform = process.platform): string {
	const lexicalIdentity = platform === "win32" ? socketPath.toLowerCase() : resolve(socketPath);
	return createHash("sha256").update(lexicalIdentity).digest("hex").slice(0, 12);
}

function legacyDaemonWorkerSocketPath(
	supervisorSocketPath: string,
	workerId: string,
	platform: NodeJS.Platform,
): string {
	const key = legacyDescriptorKey(supervisorSocketPath, platform);
	return platform === "win32"
		? `\\\\.\\pipe\\prime-agent-worker-${key}-${workerId.slice(0, 12)}`
		: join(defaultDaemonSocketDir(), `worker-${key}-${workerId.slice(0, 12)}.sock`);
}

export function defaultDaemonWorkerDescriptorDir(agentDir: string, supervisorSocketPath: string): string {
	return join(resolve(agentDir), "daemon-workers", descriptorKey(supervisorSocketPath));
}

export function canonicalDaemonWorkerSocketPath(
	supervisorSocketPath: string,
	workerId: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const key = descriptorKey(supervisorSocketPath);
	if (platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-worker-${key}-${workerId.slice(0, 12)}`;
	}
	return join(defaultDaemonSocketDir(), `worker-${key}-${workerId.slice(0, 12)}.sock`);
}

function noFollowFlag(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function pathIsMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertDirectory(path: string, label: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		throw new Error(`${label} is unavailable: ${path}`, { cause: error });
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${label} is not a real directory: ${path}`);
	}
}

function directoryIdentityNoFollow(path: string, label: string): FileIdentity {
	assertDirectory(path, label);
	const stat = lstatSync(path, { bigint: true });
	return { device: stat.dev, inode: stat.ino };
}

function assertDirectoryIdentity(path: string, expected: FileIdentity, label: string): void {
	const current = directoryIdentityNoFollow(path, label);
	if (current.device !== expected.device || current.inode !== expected.inode) {
		throw new Error(`${label} identity changed: ${path}`);
	}
}

function assertOptionalDirectory(path: string, label: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`${label} is not a real directory: ${path}`);
		}
	} catch (error) {
		if (!pathIsMissing(error)) throw error;
	}
}

function assertOptionalRegularFile(path: string, label: string): "missing" | "present" {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`${label} is not a regular file: ${path}`);
		}
		return "present";
	} catch (error) {
		if (pathIsMissing(error)) return "missing";
		throw error;
	}
}

interface FileIdentity {
	device: bigint;
	inode: bigint;
}

interface RegularFileRecord extends FileIdentity {
	size: bigint;
	mode: bigint;
	contents: Buffer;
}

interface SocketRecord extends FileIdentity {
	mode: bigint;
}

function readExactBytes(descriptor: number, size: bigint, maxBytes: number): Buffer {
	if (size < 0n || size > BigInt(maxBytes)) throw new Error("Artifact is too large for exact validation");
	const length = Number(size);
	const contents = Buffer.allocUnsafe(length);
	let offset = 0;
	while (offset < length) {
		const bytesRead = readSync(descriptor, contents, offset, length - offset, offset);
		if (bytesRead === 0) throw new Error("Artifact ended during exact validation");
		offset += bytesRead;
	}
	return contents;
}

function regularFileIdentityNoFollow(path: string): FileIdentity {
	const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		const current = lstatSync(path, { bigint: true });
		if (
			!opened.isFile() ||
			current.isSymbolicLink() ||
			!current.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino
		) {
			throw new Error(`File identity is unsafe or changed: ${path}`);
		}
		return { device: opened.dev, inode: opened.ino };
	} finally {
		closeSync(descriptor);
	}
}

function captureRegularFileRecord(path: string, maxBytes: number): RegularFileRecord {
	const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (!opened.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
		const contents = readExactBytes(descriptor, opened.size, maxBytes);
		const current = lstatSync(path, { bigint: true });
		if (
			current.isSymbolicLink() ||
			!current.isFile() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			current.size !== opened.size ||
			current.mode !== opened.mode
		) {
			throw new Error(`Artifact changed while it was captured: ${path}`);
		}
		return {
			device: opened.dev,
			inode: opened.ino,
			size: opened.size,
			mode: opened.mode,
			contents,
		};
	} finally {
		closeSync(descriptor);
	}
}

function sameRegularFileRecord(path: string, expected: RegularFileRecord, maxBytes: number): boolean {
	try {
		const current = captureRegularFileRecord(path, maxBytes);
		return (
			current.device === expected.device &&
			current.inode === expected.inode &&
			current.size === expected.size &&
			current.mode === expected.mode &&
			current.contents.equals(expected.contents)
		);
	} catch {
		return false;
	}
}

function assertRegularFileIdentity(path: string, expected: FileIdentity): void {
	const current = regularFileIdentityNoFollow(path);
	if (current.device !== expected.device || current.inode !== expected.inode) {
		throw new Error(`File identity changed: ${path}`);
	}
}

function assertOptionalSocket(path: string, platform: NodeJS.Platform): "missing" | "present" {
	if (platform === "win32") return "missing";
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isSocket()) {
			throw new Error(`Worker socket artifact is not a socket: ${path}`);
		}
		return "present";
	} catch (error) {
		if (pathIsMissing(error)) return "missing";
		throw error;
	}
}

function socketIdentityNoFollow(path: string): SocketRecord {
	const stat = lstatSync(path, { bigint: true });
	if (stat.isSymbolicLink() || !stat.isSocket()) {
		throw new Error(`Worker socket artifact is not a socket: ${path}`);
	}
	return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}

function sameSocketRecord(path: string, expected: SocketRecord): boolean {
	try {
		const current = socketIdentityNoFollow(path);
		return current.device === expected.device && current.inode === expected.inode && current.mode === expected.mode;
	} catch {
		return false;
	}
}

function readRegularFileNoFollow(
	path: string,
	maxBytes: number,
): { contents: string; device: bigint; inode: bigint; size: bigint } {
	const record = captureRegularFileRecord(path, maxBytes);
	return {
		contents: record.contents.toString("utf8"),
		device: record.device,
		inode: record.inode,
		size: record.size,
	};
}

function canonicalSessionPathsAreSafe(descriptor: DaemonWorkerDescriptor): boolean {
	const sessionDir = descriptor.sessionDir;
	if (sessionDir !== undefined) {
		if (!isAbsolute(sessionDir) || resolve(sessionDir) !== sessionDir) return false;
		assertOptionalDirectory(sessionDir, "Worker sessions directory");
	}
	const sessionFile = descriptor.sessionFile ?? descriptor.createCommand.sessionPath;
	if (sessionFile !== undefined) {
		if (!isAbsolute(sessionFile) || resolve(sessionFile) !== sessionFile) return false;
		if (sessionDir !== undefined) {
			const fromSessionDir = relative(sessionDir, sessionFile);
			if (
				fromSessionDir === ".." ||
				fromSessionDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
				isAbsolute(fromSessionDir)
			) {
				return false;
			}
		}
		assertOptionalRegularFile(sessionFile, "Worker session file");
	}
	return true;
}

export function readCanonicalDaemonWorkerDescriptor(
	descriptorPath: string,
	layout: DaemonWorkerCleanupLayout,
): CanonicalDaemonWorkerDescriptorResult {
	try {
		const canonicalDescriptorPath = resolve(descriptorPath);
		if (canonicalDescriptorPath !== descriptorPath) {
			return { ok: false, reason: "worker descriptor path is not canonical" };
		}
		const opened = readRegularFileNoFollow(descriptorPath, MAX_DESCRIPTOR_BYTES);
		const parsed = parseDaemonWorkerDescriptor(JSON.parse(opened.contents));
		if (!parsed) {
			return { ok: false, reason: "worker descriptor is invalid" };
		}
		const descriptor = parsed;
		if (!WORKER_ID_PATTERN.test(descriptor.workerId) || basename(descriptor.workerId) !== descriptor.workerId) {
			return { ok: false, reason: "worker id is not canonical" };
		}
		const platform = layout.platform ?? process.platform;
		const expectedDescriptorDirectory = resolve(
			layout.descriptorDir ??
				(layout.agentDir
					? defaultDaemonWorkerDescriptorDir(layout.agentDir, descriptor.supervisorSocketPath)
					: dirname(descriptorPath)),
		);
		if (descriptorPath !== join(expectedDescriptorDirectory, `${descriptor.workerId}.json`)) {
			return { ok: false, reason: "worker descriptor path is not canonical" };
		}
		if (
			layout.supervisorSocketPath !== undefined &&
			normalizeSocketPath(descriptor.supervisorSocketPath) !== normalizeSocketPath(layout.supervisorSocketPath)
		) {
			return { ok: false, reason: "worker supervisor socket changed" };
		}
		if (layout.agentDir !== undefined && layout.descriptorDir === undefined) {
			const agentDir = resolve(layout.agentDir);
			assertDirectory(agentDir, "Agent directory");
			assertDirectory(join(agentDir, "daemon-workers"), "Daemon worker directory");
		}
		assertDirectory(expectedDescriptorDirectory, "Worker descriptor directory");
		const expectedRecoveryPath = join(expectedDescriptorDirectory, `${descriptor.workerId}.recovery.jsonl`);
		const expectedOrphanPath = join(expectedDescriptorDirectory, `${descriptor.workerId}.orphans.jsonl`);
		if (
			descriptor.recoveryJournalPath !== expectedRecoveryPath ||
			descriptor.orphanProcessJournalPath !== expectedOrphanPath
		) {
			return { ok: false, reason: "worker journal authority is not canonical" };
		}
		const generatedSocketPath = canonicalDaemonWorkerSocketPath(
			descriptor.supervisorSocketPath,
			descriptor.workerId,
			platform,
		);
		const legacyGeneratedSocketPath = legacyDaemonWorkerSocketPath(
			descriptor.supervisorSocketPath,
			descriptor.workerId,
			platform,
		);
		if (platform === "win32") {
			if (
				normalizeSocketPath(descriptor.socketPath) !== normalizeSocketPath(generatedSocketPath) &&
				normalizeSocketPath(descriptor.socketPath) !== normalizeSocketPath(legacyGeneratedSocketPath)
			) {
				return { ok: false, reason: "worker socket path is not canonical" };
			}
		} else {
			if (
				!isAbsolute(descriptor.socketPath) ||
				resolve(descriptor.socketPath) !== descriptor.socketPath ||
				(basename(descriptor.socketPath) !== basename(generatedSocketPath) &&
					basename(descriptor.socketPath) !== basename(legacyGeneratedSocketPath))
			) {
				return { ok: false, reason: "worker socket path is not canonical" };
			}
			// Cleanup authority belongs to the descriptor's recorded socket parent,
			// not this process's ambient TMPDIR. Pinning happens again for mutation.
			assertDirectory(dirname(descriptor.socketPath), "Worker socket directory");
		}
		assertOptionalRegularFile(descriptor.recoveryJournalPath, "Worker recovery journal");
		assertOptionalRegularFile(descriptor.orphanProcessJournalPath, "Worker orphan journal");
		assertOptionalSocket(descriptor.socketPath, platform);
		if (!canonicalSessionPathsAreSafe(descriptor)) {
			return { ok: false, reason: "worker session paths are not canonical" };
		}
		return {
			ok: true,
			value: {
				descriptor,
				descriptorPath,
				descriptorDirectory: expectedDescriptorDirectory,
				device: opened.device,
				inode: opened.inode,
				size: opened.size,
				contents: opened.contents,
			},
		};
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export interface RetainedDaemonWorkerDescriptorEvidence {
	path: string;
	socketPath?: string;
	reason: string;
}

export interface EnumeratedDaemonWorkerDescriptors {
	descriptors: CanonicalDaemonWorkerDescriptor[];
	retained: RetainedDaemonWorkerDescriptorEvidence[];
}

function safelyDerivedWorkerSocketPath(
	descriptorPath: string,
	descriptorKeyName: string,
	workerId: string,
): string | undefined {
	if (!/^[0-9a-f]{12}$/.test(descriptorKeyName) || !WORKER_ID_PATTERN.test(workerId)) return undefined;
	const expectedBasename = `worker-${descriptorKeyName}-${workerId.slice(0, 12)}.sock`;
	try {
		const opened = readRegularFileNoFollow(descriptorPath, MAX_DESCRIPTOR_BYTES);
		const value = JSON.parse(opened.contents) as Record<string, unknown>;
		if (typeof value.socketPath === "string") {
			if (process.platform === "win32") {
				const expectedPipe = `\\\\.\\pipe\\prime-agent-worker-${descriptorKeyName}-${workerId.slice(0, 12)}`;
				if (normalizeSocketPath(value.socketPath) === normalizeSocketPath(expectedPipe)) return value.socketPath;
			} else if (
				isAbsolute(value.socketPath) &&
				resolve(value.socketPath) === value.socketPath &&
				basename(value.socketPath) === expectedBasename
			) {
				return normalizeSocketPath(value.socketPath);
			}
		}
	} catch {
		// The filename still derives the standard worker socket below.
	}
	return process.platform === "win32"
		? `\\\\.\\pipe\\prime-agent-worker-${descriptorKeyName}-${workerId.slice(0, 12)}`
		: normalizeSocketPath(join(defaultDaemonSocketDir(), expectedBasename));
}

/**
 * Strict no-follow inventory shared by daemon-ps. Malformed descriptor evidence
 * remains structured so generic listener cleanup can exclude any worker socket
 * derivable without trusting malformed JSON and can report unresolved roots.
 */
export function enumerateCanonicalDaemonWorkerDescriptors(agentDir: string): EnumeratedDaemonWorkerDescriptors {
	const descriptors: CanonicalDaemonWorkerDescriptor[] = [];
	const retained: RetainedDaemonWorkerDescriptorEvidence[] = [];
	const root = join(resolve(agentDir), "daemon-workers");
	let directoryNames: string[];
	try {
		const rootStat = lstatSync(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			return { descriptors, retained: [{ path: root, reason: "daemon worker root is not a real directory" }] };
		}
		directoryNames = readdirSync(root).sort();
	} catch (error) {
		if (pathIsMissing(error)) return { descriptors, retained };
		return { descriptors, retained: [{ path: root, reason: `daemon worker root is unavailable: ${String(error)}` }] };
	}
	for (const directoryName of directoryNames) {
		if (directoryName === "snapshot-cache") continue;
		const directory = join(root, directoryName);
		let names: string[];
		try {
			const stat = lstatSync(directory);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				if (/^[0-9a-f]{12}$/.test(directoryName)) {
					retained.push({ path: directory, reason: "worker descriptor scope is not a real directory" });
				}
				continue;
			}
			names = readdirSync(directory).sort();
		} catch (error) {
			retained.push({ path: directory, reason: `worker descriptor scope is unavailable: ${String(error)}` });
			continue;
		}
		for (const name of names) {
			const descriptorMatch = /^(?<workerId>[A-Za-z0-9._-]{1,256})\.json$/.exec(name);
			const quarantineMatch = /^(?<workerId>[A-Za-z0-9._-]{1,256})\.json\.quarantine-/.exec(name);
			if (!descriptorMatch?.groups && !quarantineMatch?.groups) continue;
			const workerId = (descriptorMatch?.groups?.workerId ?? quarantineMatch?.groups?.workerId)!;
			const path = join(directory, name);
			const socketPath = safelyDerivedWorkerSocketPath(path, directoryName, workerId);
			if (quarantineMatch) {
				retained.push({
					path,
					...(socketPath ? { socketPath } : {}),
					reason: "quarantined worker authority remains",
				});
				continue;
			}
			const result = readCanonicalDaemonWorkerDescriptor(path, { descriptorDir: directory });
			if (result.ok) {
				const physicalKey = descriptorKey(result.value.descriptor.supervisorSocketPath);
				const legacyKey = legacyDescriptorKey(result.value.descriptor.supervisorSocketPath);
				if (directoryName === physicalKey || directoryName === legacyKey) {
					descriptors.push(result.value);
				} else {
					retained.push({
						path,
						socketPath: normalizeSocketPath(result.value.descriptor.socketPath),
						reason: "worker descriptor scope key does not match its recorded supervisor socket",
					});
				}
			} else retained.push({ path, ...(socketPath ? { socketPath } : {}), reason: result.reason });
		}
	}
	return { descriptors, retained };
}

function processIdentityQuality(processStartId: string | undefined): "missing" | "exact" | "coarse" | "unknown" {
	if (processStartId === undefined) return "missing";
	if (isExactProcessStartId(processStartId)) return "exact";
	if (processStartId.startsWith("ps:")) return "coarse";
	return "unknown";
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function daemonWorkerImmutableAuthorityFingerprint(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
): string {
	return fingerprint({
		version: 1,
		descriptorPath: resolve(descriptorPath),
		workerId: descriptor.workerId,
		authenticationToken: descriptor.authenticationToken,
		pid: descriptor.pid,
		legacyProcessIdentity: {
			quality: processIdentityQuality(descriptor.processStartId),
			startId: descriptor.processStartId ?? null,
			diagnosticHint: descriptor.processIdentityHint ?? null,
		},
		authorityProcessIdentity: {
			quality: processIdentityQuality(descriptor.authorityProcessStartId),
			startId: descriptor.authorityProcessStartId ?? null,
			diagnosticHint: descriptor.authorityProcessIdentityHint ?? null,
		},
		socketPath: normalizeSocketPath(descriptor.socketPath),
		recoveryJournalPath: descriptor.recoveryJournalPath,
		orphanProcessJournalPath: descriptor.orphanProcessJournalPath ?? null,
		orphanProcessJournalGeneration: descriptor.orphanProcessJournalGeneration ?? null,
		supervisorSocketPath: normalizeSocketPath(descriptor.supervisorSocketPath),
		rootActiveSessionId: descriptor.rootActiveSessionId,
		ownerClientId: descriptor.ownerClientId ?? null,
		rootSessionId: descriptor.rootSessionId ?? null,
		sessionFile: descriptor.sessionFile ?? null,
		sessionDir: descriptor.sessionDir ?? null,
	});
}

export function daemonWorkerCleanupAuthorityFingerprint(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
): string {
	return fingerprint({
		version: 1,
		immutable: daemonWorkerImmutableAuthorityFingerprint(descriptor, descriptorPath),
		stopRequestedAt: descriptor.stopRequestedAt ?? null,
		archiveOnStop: descriptor.archiveOnStop === true,
	});
}

export function clearMismatchedDaemonWorkerCleanupProof(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
): void {
	if (
		descriptor.cleanup !== undefined &&
		descriptor.cleanup.authorityFingerprint !== daemonWorkerCleanupAuthorityFingerprint(descriptor, descriptorPath)
	) {
		delete descriptor.cleanup;
	}
}

export function fsyncDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (platform !== "win32" || (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR")) throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function persistDaemonWorkerDescriptorUnderGuard(
	descriptorPath: string,
	descriptor: DaemonWorkerDescriptor,
	platform: NodeJS.Platform,
	guard: AuthorityMutationGuard,
): void {
	const directory = dirname(descriptorPath);
	assertDirectory(directory, "Worker descriptor directory");
	const tempPath = `${descriptorPath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
	let tempCreated = false;
	let tempIdentity: FileIdentity | undefined;
	try {
		guard.assertCurrent();
		const file = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
			0o600,
		);
		tempCreated = true;
		const opened = fstatSync(file, { bigint: true });
		if (!opened.isFile()) throw new Error(`Worker descriptor temp is not a regular file: ${tempPath}`);
		tempIdentity = { device: opened.dev, inode: opened.ino };
		try {
			writeFileSync(
				file,
				`${JSON.stringify(durableDaemonWorkerDescriptor(descriptor), null, 2)}
`,
				"utf8",
			);
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		assertRegularFileIdentity(tempPath, tempIdentity);
		chmodSync(tempPath, 0o600);
		assertRegularFileIdentity(tempPath, tempIdentity);
		guard.assertCurrent();
		renameSync(tempPath, descriptorPath);
		tempCreated = false;
		guard.assertCurrent();
		fsyncDirectory(directory, platform);
		guard.assertCurrent();
	} finally {
		if (tempCreated && tempIdentity) {
			const quarantinePath = `${tempPath}.quarantine-${randomUUID()}`;
			try {
				guard.assertCurrent();
				renameSync(tempPath, quarantinePath);
				const quarantined = regularFileIdentityNoFollow(quarantinePath);
				if (quarantined.device === tempIdentity.device && quarantined.inode === tempIdentity.inode) {
					unlinkSync(quarantinePath);
					fsyncDirectory(directory, platform);
				}
			} catch {
				// A moved mismatch or failed quarantine remains evidence. Never unlink
				// the canonical/temp path after its identity check.
			}
		}
	}
}

export function persistDaemonWorkerDescriptorAtomically(
	descriptorPath: string,
	descriptor: DaemonWorkerDescriptor,
	platform: NodeJS.Platform = process.platform,
	mutationGuard?: AuthorityMutationGuard,
): void {
	if (mutationGuard) {
		mutationGuard.assertCurrent();
		persistDaemonWorkerDescriptorUnderGuard(descriptorPath, descriptor, platform, mutationGuard);
		mutationGuard.assertCurrent();
		return;
	}
	withDaemonWorkerMutationGuardSync(descriptorPath, (guard) =>
		persistDaemonWorkerDescriptorUnderGuard(descriptorPath, descriptor, platform, guard),
	);
}

export async function observeDaemonWorkerSocket(
	socketPath: string,
	timeoutMs = 250,
): Promise<DaemonWorkerSocketObservation> {
	return new Promise((resolveObservation) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (observation: DaemonWorkerSocketObservation) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolveObservation(observation);
		};
		const timer = setTimeout(() => finish("uncertain"), timeoutMs);
		socket.once("connect", () => finish("reachable"));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "unreachable" : "uncertain");
		});
	});
}

function requireCanonical(
	descriptorPath: string,
	layout: DaemonWorkerCleanupLayout,
	journalPath?: string,
): CanonicalDaemonWorkerDescriptor {
	const result = readCanonicalDaemonWorkerDescriptor(descriptorPath, layout);
	if (!result.ok) throw new CleanupRetainedError(result.reason, journalPath);
	return result.value;
}

function proofMatches(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
	state?: DaemonWorkerCleanupProof["state"],
): descriptor is DaemonWorkerDescriptor & { cleanup: DaemonWorkerCleanupProof } {
	return (
		descriptor.cleanup !== undefined &&
		descriptor.cleanup.authorityFingerprint === daemonWorkerCleanupAuthorityFingerprint(descriptor, descriptorPath) &&
		(state === undefined || descriptor.cleanup.state === state)
	);
}

async function assertAuthorityAndRead(
	options: DaemonWorkerCleanupOptions,
	phase: DaemonWorkerCleanupAuthorityPhase,
	expectedFingerprint: string,
	expectedCleanupToken?: string,
	assertStableDirectory?: () => void,
): Promise<CanonicalDaemonWorkerDescriptor> {
	try {
		await options.assertAuthority(phase);
	} catch (error) {
		throw new CleanupRetainedError(`worker cleanup authority was lost: ${String(error)}`);
	}
	assertStableDirectory?.();
	const current = requireCanonical(options.descriptorPath, options.layout);
	assertStableDirectory?.();
	if (
		current.descriptor.workerId !== options.expectedWorkerId ||
		daemonWorkerCleanupAuthorityFingerprint(current.descriptor, current.descriptorPath) !== expectedFingerprint ||
		(expectedCleanupToken !== undefined && current.descriptor.cleanup?.token !== expectedCleanupToken)
	) {
		throw new CleanupRetainedError("worker descriptor or cleanup token changed");
	}
	return current;
}

function currentDescriptorAfterAtomicWrite(
	options: DaemonWorkerCleanupOptions,
	expectedFingerprint: string,
	expectedCleanupToken?: string,
	assertStableDirectory?: () => void,
): CanonicalDaemonWorkerDescriptor {
	assertStableDirectory?.();
	const current = requireCanonical(options.descriptorPath, options.layout);
	assertStableDirectory?.();
	if (
		current.descriptor.workerId !== options.expectedWorkerId ||
		daemonWorkerCleanupAuthorityFingerprint(current.descriptor, current.descriptorPath) !== expectedFingerprint ||
		(expectedCleanupToken !== undefined && current.descriptor.cleanup?.token !== expectedCleanupToken)
	) {
		throw new CleanupRetainedError("worker cleanup proof did not survive its durable reread");
	}
	return current;
}

function rootCandidate(descriptor: DaemonWorkerDescriptor): ActiveOrphanProcessCandidate {
	const processStartId = daemonWorkerProcessAuthority(descriptor);
	return {
		pid: descriptor.pid,
		...(processStartId !== undefined ? { processStartId } : {}),
	};
}

export function daemonWorkerLegacyBindableAuthorityFingerprint(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
): string {
	return daemonWorkerImmutableAuthorityFingerprint(
		{ ...descriptor, orphanProcessJournalGeneration: undefined },
		descriptorPath,
	);
}

function workerRootCleanupProven(
	descriptor: DaemonWorkerDescriptor,
	platform: NodeJS.Platform,
	probeOptions?: OrphanProcessProbeOptions,
): boolean {
	const root = rootCandidate(descriptor);
	const effectiveProbeOptions = { ...probeOptions, platform };
	if (platform === "win32") {
		return (
			isExactProcessStartId(root.processStartId ?? "") &&
			classifyProcessIdentityAuthority(root.pid, root.processStartId, effectiveProbeOptions) === "exact-dead"
		);
	}
	return isOrphanProcessCandidateExactDead(root, effectiveProbeOptions);
}

async function requireSocketUnreachable(
	descriptor: DaemonWorkerDescriptor,
	options: DaemonWorkerCleanupOptions,
): Promise<void> {
	const observation = await (options.observeSocket ?? observeDaemonWorkerSocket)(descriptor.socketPath);
	if (observation !== "unreachable") {
		throw new CleanupRetainedError(`worker socket is ${observation}`);
	}
}

function ensureArtifactAbsent(path: string, label: string): void {
	try {
		lstatSync(path);
		throw new CleanupRetainedError(`${label} reappeared during cleanup`);
	} catch (error) {
		if (error instanceof CleanupRetainedError) throw error;
		if (!pathIsMissing(error)) throw new CleanupRetainedError(`${label} could not be verified absent`);
	}
}

function removeEmptyOrphanJournalClaimsDirectory(
	orphanPath: string,
	mutationGuard: AuthorityMutationGuard,
	platform: NodeJS.Platform = process.platform,
): void {
	const claimsPath = `${orphanPath}.append.lock.claims`;
	try {
		const stat = lstatSync(claimsPath, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new CleanupRetainedError(`Worker orphan journal claims path is not a real directory: ${claimsPath}`);
		}
		const claimsIdentity: FileIdentity = { device: stat.dev, inode: stat.ino };
		if (readdirSync(claimsPath).length !== 0) {
			throw new CleanupRetainedError(`Worker orphan journal claims remain: ${claimsPath}`);
		}
		mutationGuard.assertCurrent();
		assertDirectoryIdentity(claimsPath, claimsIdentity, "Worker orphan journal claims directory");
		const quarantinePath = `${claimsPath}.quarantine-${process.pid}-${randomUUID()}`;
		renameSync(claimsPath, quarantinePath);
		mutationGuard.assertCurrent();
		assertDirectoryIdentity(quarantinePath, claimsIdentity, "Quarantined worker orphan journal claims directory");
		if (readdirSync(quarantinePath).length !== 0) {
			throw new CleanupRetainedError(`Quarantined worker orphan journal claims changed: ${quarantinePath}`);
		}
		rmdirSync(quarantinePath);
		fsyncDirectory(dirname(claimsPath), platform);
		mutationGuard.assertCurrent();
		if (pathExistsNoFollow(claimsPath)) {
			throw new CleanupRetainedError(`Worker orphan journal claims reappeared: ${claimsPath}`);
		}
	} catch (error) {
		if (pathIsMissing(error)) return;
		throw error;
	}
}

function ensureOrphanJournalSupportAbsent(orphanPath: string): void {
	const directory = dirname(orphanPath);
	const prefix = `${basename(orphanPath)}.append.lock`;
	const quarantinePrefix = `${basename(orphanPath)}.quarantine-`;
	const residue = readdirSync(directory).filter(
		(name) =>
			name === prefix ||
			name.startsWith(`${prefix}.candidate-`) ||
			name === `${prefix}.claims` ||
			name.startsWith(`${prefix}.claims.quarantine-`) ||
			name.startsWith(quarantinePrefix),
	);
	if (residue.length > 0) {
		throw new CleanupRetainedError(`Worker orphan journal lock residue remains: ${residue.join(", ")}`);
	}
}

interface QuarantineArtifactOptions {
	artifact: DaemonWorkerQuarantinedArtifact;
	canonicalPath: string;
	record: RegularFileRecord | SocketRecord;
	maxBytes?: number;
	platform: NodeJS.Platform;
	guard: AuthorityMutationGuard;
	revalidateBeforeRename: () => Promise<void>;
	revalidateAfterRename: () => Promise<void>;
	testHooks?: Readonly<DaemonWorkerCleanupTestHooks>;
	restoreDescriptor?: boolean;
}

function regularArtifactRecord(record: RegularFileRecord | SocketRecord): record is RegularFileRecord {
	return "contents" in record;
}

function movedArtifactMatches(
	path: string,
	record: RegularFileRecord | SocketRecord,
	maxBytes: number | undefined,
): boolean {
	return regularArtifactRecord(record)
		? sameRegularFileRecord(path, record, maxBytes ?? MAX_RECOVERY_ARTIFACT_BYTES)
		: sameSocketRecord(path, record);
}

function pathExistsNoFollow(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (pathIsMissing(error)) return false;
		throw error;
	}
}

async function restoreDescriptorNoReplace(
	canonicalPath: string,
	quarantinePath: string,
	record: RegularFileRecord,
	platform: NodeJS.Platform,
	guard: AuthorityMutationGuard,
	revalidate: () => Promise<void>,
): Promise<boolean> {
	await revalidate();
	guard.assertCurrent();
	if (pathExistsNoFollow(canonicalPath)) return false;
	try {
		if (sameRegularFileRecord(quarantinePath, record, MAX_DESCRIPTOR_BYTES)) {
			// link(2) is a no-replace publication. It can never overwrite a
			// canonical successor that appeared after the absence check.
			linkSync(quarantinePath, canonicalPath);
			if (!sameRegularFileRecord(canonicalPath, record, MAX_DESCRIPTOR_BYTES)) {
				throw new Error("Linked descriptor restoration did not preserve exact authority");
			}
		} else {
			const descriptor = openSync(
				canonicalPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
				0o600,
			);
			let opened: ReturnType<typeof fstatSync> | undefined;
			try {
				writeFileSync(descriptor, record.contents);
				fsyncSync(descriptor);
				opened = fstatSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			if (!opened?.isFile()) throw new Error("Restored descriptor is not a regular file");
			chmodSync(canonicalPath, 0o600);
			const restored = captureRegularFileRecord(canonicalPath, MAX_DESCRIPTOR_BYTES);
			if (!restored.contents.equals(record.contents) || restored.size !== record.size) {
				throw new Error("Copied descriptor restoration did not preserve complete authority bytes");
			}
		}
		guard.assertCurrent();
		fsyncDirectory(dirname(canonicalPath), platform);
		guard.assertCurrent();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function restoreQuarantinePathNoReplace(
	canonicalPath: string,
	quarantinePath: string,
	platform: NodeJS.Platform,
	guard: AuthorityMutationGuard,
): boolean {
	guard.assertCurrent();
	if (pathExistsNoFollow(canonicalPath)) return false;
	try {
		const quarantined = lstatSync(quarantinePath, { bigint: true });
		if (quarantined.isSymbolicLink()) return false;
		linkSync(quarantinePath, canonicalPath);
		const restored = lstatSync(canonicalPath, { bigint: true });
		if (
			restored.isSymbolicLink() ||
			restored.dev !== quarantined.dev ||
			restored.ino !== quarantined.ino ||
			restored.size !== quarantined.size
		) {
			return false;
		}
		fsyncDirectory(dirname(canonicalPath), platform);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		return false;
	}
}

async function quarantineAndRemoveArtifact(options: QuarantineArtifactOptions): Promise<void> {
	const quarantinePath = `${options.canonicalPath}.quarantine-${process.pid}-${randomUUID()}`;
	await options.revalidateBeforeRename();
	options.guard.assertCurrent();
	try {
		renameSync(options.canonicalPath, quarantinePath);
	} catch (error) {
		throw new CleanupRetainedError(`worker ${options.artifact} could not be moved to quarantine: ${String(error)}`);
	}
	options.testHooks?.afterArtifactQuarantine?.(options.artifact, options.canonicalPath, quarantinePath);
	try {
		await options.revalidateAfterRename();
		options.guard.assertCurrent();
	} catch (error) {
		restoreQuarantinePathNoReplace(options.canonicalPath, quarantinePath, options.platform, options.guard);
		throw error;
	}
	if (!movedArtifactMatches(quarantinePath, options.record, options.maxBytes)) {
		restoreQuarantinePathNoReplace(options.canonicalPath, quarantinePath, options.platform, options.guard);
		throw new CleanupRetainedError(
			`worker ${options.artifact} quarantine does not match the captured inode and complete record`,
		);
	}
	const canonicalReappeared = pathExistsNoFollow(options.canonicalPath);
	const fsyncQuarantineDirectory = () =>
		(
			options.testHooks?.fsyncQuarantineDirectory ??
			((_artifact: DaemonWorkerQuarantinedArtifact, directory: string, platform: NodeJS.Platform) =>
				fsyncDirectory(directory, platform))
		)(options.artifact, dirname(options.canonicalPath), options.platform);
	try {
		fsyncQuarantineDirectory();
	} catch (error) {
		if (options.restoreDescriptor && regularArtifactRecord(options.record)) {
			const restored = await restoreDescriptorNoReplace(
				options.canonicalPath,
				quarantinePath,
				options.record,
				options.platform,
				options.guard,
				options.revalidateAfterRename,
			).catch(() => false);
			throw new CleanupRetainedError(
				restored
					? "worker descriptor quarantine durability failed; authority was restored without replacement"
					: "worker descriptor quarantine durability failed; quarantined authority remains blocked",
			);
		}
		throw new CleanupRetainedError(`worker ${options.artifact} quarantine durability failed: ${String(error)}`);
	}
	options.guard.assertCurrent();
	if (!movedArtifactMatches(quarantinePath, options.record, options.maxBytes)) {
		throw new CleanupRetainedError(`worker ${options.artifact} quarantine changed before deletion`);
	}
	unlinkSync(quarantinePath);
	try {
		fsyncQuarantineDirectory();
	} catch (error) {
		if (options.restoreDescriptor && regularArtifactRecord(options.record)) {
			const restored = await restoreDescriptorNoReplace(
				options.canonicalPath,
				quarantinePath,
				options.record,
				options.platform,
				options.guard,
				options.revalidateAfterRename,
			).catch(() => false);
			throw new CleanupRetainedError(
				restored
					? "worker descriptor deletion durability failed; authority was restored without replacement"
					: "worker descriptor deletion durability failed; canonical authority is blocked",
			);
		}
		throw new CleanupRetainedError(`worker ${options.artifact} deletion durability failed: ${String(error)}`);
	}
	options.guard.assertCurrent();
	if (canonicalReappeared || pathExistsNoFollow(options.canonicalPath)) {
		throw new CleanupRetainedError(`worker ${options.artifact} canonical path reappeared during quarantine`);
	}
}

async function cleanupDaemonWorkerArtifactsWithGuard(
	options: DaemonWorkerCleanupOptions,
	mutationGuard: HeldAuthorityMutationGuard,
): Promise<DaemonWorkerCleanupResult> {
	let journalPath: string | undefined;
	let injectedInterruption: unknown;
	const descriptorDirectory = dirname(options.descriptorPath);
	const descriptorDirectoryIdentity = directoryIdentityNoFollow(descriptorDirectory, "Worker descriptor directory");
	const platform = options.layout.platform ?? process.platform;
	let socketDirectory: string | undefined;
	let socketDirectoryIdentity: FileIdentity | undefined;
	const assertStableDirectory = () => {
		try {
			mutationGuard.assertCurrent();
			assertDirectoryIdentity(descriptorDirectory, descriptorDirectoryIdentity, "Worker descriptor directory");
			if (socketDirectory && socketDirectoryIdentity) {
				assertDirectoryIdentity(socketDirectory, socketDirectoryIdentity, "Worker socket directory");
			}
		} catch (error) {
			if (error instanceof CleanupRetainedError) throw error;
			throw new CleanupRetainedError(
				`worker artifact directory or mutation guard changed: ${String(error)}`,
				journalPath,
			);
		}
	};
	const requireCurrent = (expectedJournalPath?: string) => {
		assertStableDirectory();
		const current = requireCanonical(options.descriptorPath, options.layout, expectedJournalPath);
		assertStableDirectory();
		return current;
	};
	const afterDurablePhase = (
		phase: "stop-tombstoned" | "cleanup-proven" | "journal-cleared" | "socket-removed" | "recovery-removed",
	) => {
		try {
			options.afterDurablePhase?.(phase);
		} catch (error) {
			injectedInterruption = error;
			throw error;
		}
	};
	try {
		mutationGuard.assertCurrent();
		let current = requireCurrent();
		journalPath = current.descriptor.orphanProcessJournalPath;
		if (platform !== "win32") {
			const recordedSocketPath = normalizeSocketPath(current.descriptor.socketPath);
			socketDirectory = dirname(recordedSocketPath);
			socketDirectoryIdentity = directoryIdentityNoFollow(socketDirectory, "Worker socket directory");
			assertStableDirectory();
		}
		if (
			current.descriptor.workerId !== options.expectedWorkerId ||
			(options.expectedDescriptor !== undefined &&
				daemonWorkerImmutableAuthorityFingerprint(current.descriptor, current.descriptorPath) !==
					daemonWorkerImmutableAuthorityFingerprint(options.expectedDescriptor, current.descriptorPath))
		) {
			throw new CleanupRetainedError("worker descriptor changed before cleanup", journalPath);
		}

		if (current.descriptor.stopRequestedAt === undefined) {
			if (!options.ensureStopTombstone) {
				throw new CleanupRetainedError("worker is not stop-tombstoned", journalPath);
			}
			try {
				await options.assertAuthority("persist-stop-tombstone");
			} catch (error) {
				throw new CleanupRetainedError(`worker cleanup authority was lost: ${String(error)}`, journalPath);
			}
			const beforeTombstone = requireCurrent(journalPath);
			if (
				daemonWorkerImmutableAuthorityFingerprint(beforeTombstone.descriptor, beforeTombstone.descriptorPath) !==
				daemonWorkerImmutableAuthorityFingerprint(current.descriptor, current.descriptorPath)
			) {
				throw new CleanupRetainedError("worker descriptor changed before stop tombstone", journalPath);
			}
			const tombstoned: DaemonWorkerDescriptor = {
				...beforeTombstone.descriptor,
				stopRequestedAt: new Date().toISOString(),
				lifecycle: "stopping",
				cleanup: undefined,
			};
			assertStableDirectory();
			persistDaemonWorkerDescriptorAtomically(
				beforeTombstone.descriptorPath,
				tombstoned,
				options.layout.platform,
				mutationGuard,
			);
			assertStableDirectory();
			current = requireCurrent(journalPath);
			afterDurablePhase("stop-tombstoned");
		}

		let authorityFingerprint = daemonWorkerCleanupAuthorityFingerprint(current.descriptor, current.descriptorPath);
		if (current.descriptor.cleanup && !proofMatches(current.descriptor, current.descriptorPath)) {
			await assertAuthorityAndRead(
				options,
				"discard-stale-proof",
				authorityFingerprint,
				undefined,
				assertStableDirectory,
			);
			const withoutProof = { ...current.descriptor, cleanup: undefined };
			assertStableDirectory();
			persistDaemonWorkerDescriptorAtomically(
				current.descriptorPath,
				withoutProof,
				options.layout.platform,
				mutationGuard,
			);
			assertStableDirectory();
			current = currentDescriptorAfterAtomicWrite(options, authorityFingerprint, undefined, assertStableDirectory);
		}
		let matchingProof = proofMatches(current.descriptor, current.descriptorPath)
			? current.descriptor.cleanup
			: undefined;
		const orphanPath = current.descriptor.orphanProcessJournalPath;
		if (!orphanPath) {
			throw new CleanupRetainedError("worker orphan journal path is incomplete", journalPath);
		}
		const journalPresence = assertOptionalRegularFile(orphanPath, "Worker orphan journal");
		let journalIdentity = journalPresence === "present" ? regularFileIdentityNoFollow(orphanPath) : undefined;
		if (journalPresence === "missing" && matchingProof === undefined) {
			throw new CleanupRetainedError("worker orphan journal is missing without durable cleanup proof", journalPath);
		}

		const proveWorkerAndJournalDisposition = async (
			expectedGeneration: string | undefined,
			proofToken: string | undefined,
		): Promise<void> => {
			await assertAuthorityAndRead(options, "prove", authorityFingerprint, proofToken, assertStableDirectory);
			const effectiveProbeOptions = { ...options.probeOptions, platform };
			const proved = await reapOrphanProcessAuthority(orphanPath, {
				...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
				// Windows descendant retirement requires its own held-Job proof. The
				// descriptor root is instead classified exactly and independently below.
				...(platform === "win32" ? {} : { additionalCandidates: [rootCandidate(current.descriptor)] }),
				beforeKill: async () => {
					await assertAuthorityAndRead(options, "signal", authorityFingerprint, proofToken, assertStableDirectory);
					assertRegularFileIdentity(orphanPath, journalIdentity!);
				},
				probeOptions: effectiveProbeOptions,
			});
			await assertAuthorityAndRead(options, "prove", authorityFingerprint, proofToken, assertStableDirectory);
			assertRegularFileIdentity(orphanPath, journalIdentity!);
			if (!proved || !workerRootCleanupProven(current.descriptor, platform, effectiveProbeOptions)) {
				throw new CleanupRetainedError("worker root or active descendant disposition is unproved", journalPath);
			}
		};

		let orphanGeneration = current.descriptor.orphanProcessJournalGeneration;
		if (orphanGeneration === undefined) {
			if (journalPresence !== "present" || !journalIdentity) {
				throw new CleanupRetainedError("legacy worker orphan journal is missing", journalPath);
			}
			// Do not bind a legacy descriptor until the exact root/group and all
			// recorded descendants are proven gone. The strict reader below holds
			// the journal writer lock and accepts only an existing exact v2 header.
			await proveWorkerAndJournalDisposition(undefined, matchingProof?.token);
			const legacyAuthorityFingerprint = daemonWorkerLegacyBindableAuthorityFingerprint(
				current.descriptor,
				current.descriptorPath,
			);
			const strictAuthority = readStrictEmptyOrphanProcessJournalAuthority(orphanPath);
			if (strictAuthority.path !== orphanPath) {
				throw new CleanupRetainedError("legacy worker journal path changed during generation bind", journalPath);
			}
			await assertAuthorityAndRead(
				options,
				"persist-cleanup-proof",
				authorityFingerprint,
				matchingProof?.token,
				assertStableDirectory,
			);
			assertRegularFileIdentity(orphanPath, journalIdentity);
			const beforeUpgrade = requireCurrent(journalPath);
			if (
				daemonWorkerLegacyBindableAuthorityFingerprint(beforeUpgrade.descriptor, beforeUpgrade.descriptorPath) !==
					legacyAuthorityFingerprint ||
				beforeUpgrade.descriptor.orphanProcessJournalPath !== orphanPath
			) {
				throw new CleanupRetainedError("legacy worker descriptor changed before generation bind", journalPath);
			}
			const upgraded: DaemonWorkerDescriptor = {
				...beforeUpgrade.descriptor,
				orphanProcessJournalGeneration: strictAuthority.generation,
				cleanup: undefined,
				updatedAt: new Date().toISOString(),
			};
			persistDaemonWorkerDescriptorAtomically(
				beforeUpgrade.descriptorPath,
				upgraded,
				options.layout.platform,
				mutationGuard,
			);
			current = requireCurrent(journalPath);
			if (
				current.descriptor.orphanProcessJournalGeneration !== strictAuthority.generation ||
				daemonWorkerLegacyBindableAuthorityFingerprint(current.descriptor, current.descriptorPath) !==
					legacyAuthorityFingerprint
			) {
				throw new CleanupRetainedError("legacy worker generation bind did not survive durable reread", journalPath);
			}
			orphanGeneration = strictAuthority.generation;
			authorityFingerprint = daemonWorkerCleanupAuthorityFingerprint(current.descriptor, current.descriptorPath);
			matchingProof = undefined;
			journalIdentity = regularFileIdentityNoFollow(orphanPath);
		}

		if (journalPresence === "present") {
			const proofToken = matchingProof?.token;
			await proveWorkerAndJournalDisposition(orphanGeneration, proofToken);
			await requireSocketUnreachable(current.descriptor, options);
			await assertAuthorityAndRead(
				options,
				"persist-cleanup-proof",
				authorityFingerprint,
				proofToken,
				assertStableDirectory,
			);
			const token = cleanupToken();
			const cleanup: DaemonWorkerCleanupProof = {
				version: 1,
				state: "cleanup-proven",
				token,
				authorityFingerprint,
				provenAt: new Date().toISOString(),
			};
			assertStableDirectory();
			persistDaemonWorkerDescriptorAtomically(
				current.descriptorPath,
				{ ...current.descriptor, cleanup },
				options.layout.platform,
				mutationGuard,
			);
			assertStableDirectory();
			current = currentDescriptorAfterAtomicWrite(options, authorityFingerprint, token, assertStableDirectory);
			matchingProof = current.descriptor.cleanup;
			afterDurablePhase("cleanup-proven");
		} else {
			if (!orphanGeneration) {
				throw new CleanupRetainedError("worker orphan journal generation is incomplete", journalPath);
			}
			await requireSocketUnreachable(current.descriptor, options);
		}

		if (!matchingProof || !proofMatches(current.descriptor, current.descriptorPath)) {
			throw new CleanupRetainedError("worker cleanup proof is missing or stale", journalPath);
		}
		if (existsSync(orphanPath)) {
			current = await assertAuthorityAndRead(
				options,
				"clear-journal",
				authorityFingerprint,
				matchingProof.token,
				assertStableDirectory,
			);
			assertOptionalRegularFile(orphanPath, "Worker orphan journal");
			if (journalIdentity) assertRegularFileIdentity(orphanPath, journalIdentity);
			if (!clearOrphanProcessJournal(orphanPath, orphanGeneration, options.probeOptions)) {
				throw new CleanupRetainedError("worker orphan journal could not be strictly cleared", journalPath);
			}
			fsyncDirectory(dirname(orphanPath), options.layout.platform);
			assertStableDirectory();
			ensureArtifactAbsent(orphanPath, "Worker orphan journal");
		}

		current = await assertAuthorityAndRead(
			options,
			"clear-journal",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		removeEmptyOrphanJournalClaimsDirectory(orphanPath, mutationGuard, options.layout.platform);
		assertStableDirectory();
		ensureOrphanJournalSupportAbsent(orphanPath);
		current = await assertAuthorityAndRead(
			options,
			"persist-journal-cleared",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		const journalClearedProof: DaemonWorkerCleanupProof = {
			...matchingProof,
			state: "journal-cleared",
		};
		assertStableDirectory();
		persistDaemonWorkerDescriptorAtomically(
			current.descriptorPath,
			{ ...current.descriptor, cleanup: journalClearedProof },
			options.layout.platform,
			mutationGuard,
		);
		assertStableDirectory();
		current = currentDescriptorAfterAtomicWrite(
			options,
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		afterDurablePhase("journal-cleared");

		current = await assertAuthorityAndRead(
			options,
			"unlink-socket",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		await requireSocketUnreachable(current.descriptor, options);
		current = await assertAuthorityAndRead(
			options,
			"unlink-socket",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		if (assertOptionalSocket(current.descriptor.socketPath, platform) === "present") {
			const socketRecord = socketIdentityNoFollow(current.descriptor.socketPath);
			await quarantineAndRemoveArtifact({
				artifact: "socket",
				canonicalPath: current.descriptor.socketPath,
				record: socketRecord,
				platform,
				guard: mutationGuard,
				testHooks: options.testHooks,
				revalidateBeforeRename: async () => {
					current = await assertAuthorityAndRead(
						options,
						"unlink-socket",
						authorityFingerprint,
						matchingProof!.token,
						assertStableDirectory,
					);
					await requireSocketUnreachable(current.descriptor, options);
				},
				revalidateAfterRename: async () => {
					await assertAuthorityAndRead(
						options,
						"unlink-socket",
						authorityFingerprint,
						matchingProof!.token,
						assertStableDirectory,
					);
				},
			});
		}
		afterDurablePhase("socket-removed");

		current = await assertAuthorityAndRead(
			options,
			"unlink-recovery",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		if (assertOptionalRegularFile(current.descriptor.recoveryJournalPath, "Worker recovery journal") === "present") {
			const recoveryRecord = captureRegularFileRecord(
				current.descriptor.recoveryJournalPath,
				MAX_RECOVERY_ARTIFACT_BYTES,
			);
			await quarantineAndRemoveArtifact({
				artifact: "recovery",
				canonicalPath: current.descriptor.recoveryJournalPath,
				record: recoveryRecord,
				maxBytes: MAX_RECOVERY_ARTIFACT_BYTES,
				platform,
				guard: mutationGuard,
				testHooks: options.testHooks,
				revalidateBeforeRename: async () => {
					current = await assertAuthorityAndRead(
						options,
						"unlink-recovery",
						authorityFingerprint,
						matchingProof!.token,
						assertStableDirectory,
					);
				},
				revalidateAfterRename: async () => {
					await assertAuthorityAndRead(
						options,
						"unlink-recovery",
						authorityFingerprint,
						matchingProof!.token,
						assertStableDirectory,
					);
				},
			});
		}
		afterDurablePhase("recovery-removed");

		current = await assertAuthorityAndRead(
			options,
			"unlink-descriptor",
			authorityFingerprint,
			matchingProof.token,
			assertStableDirectory,
		);
		ensureArtifactAbsent(orphanPath, "Worker orphan journal");
		ensureArtifactAbsent(current.descriptor.recoveryJournalPath, "Worker recovery journal");
		assertStableDirectory();
		const descriptorRecord = captureRegularFileRecord(current.descriptorPath, MAX_DESCRIPTOR_BYTES);
		if (
			descriptorRecord.device !== current.device ||
			descriptorRecord.inode !== current.inode ||
			descriptorRecord.size !== current.size ||
			descriptorRecord.contents.toString("utf8") !== current.contents
		) {
			throw new CleanupRetainedError("worker descriptor changed before quarantine", journalPath);
		}
		await quarantineAndRemoveArtifact({
			artifact: "descriptor",
			canonicalPath: current.descriptorPath,
			record: descriptorRecord,
			maxBytes: MAX_DESCRIPTOR_BYTES,
			platform,
			guard: mutationGuard,
			testHooks: options.testHooks,
			restoreDescriptor: true,
			revalidateBeforeRename: async () => {
				current = await assertAuthorityAndRead(
					options,
					"unlink-descriptor",
					authorityFingerprint,
					matchingProof!.token,
					assertStableDirectory,
				);
			},
			revalidateAfterRename: async () => {
				try {
					await options.assertAuthority("unlink-descriptor");
				} catch (error) {
					throw new CleanupRetainedError(`worker cleanup authority was lost: ${String(error)}`, journalPath);
				}
				assertStableDirectory();
			},
		});

		return { status: "cleaned", workerId: options.expectedWorkerId };
	} catch (error) {
		if (error === injectedInterruption) throw error;
		return {
			status: "retained",
			reason: error instanceof Error ? error.message : String(error),
			...(error instanceof CleanupRetainedError && error.journalPath
				? { journalPath: error.journalPath }
				: journalPath
					? { journalPath }
					: {}),
		};
	}
}

export async function cleanupDaemonWorkerArtifacts(
	options: DaemonWorkerCleanupOptions,
): Promise<DaemonWorkerCleanupResult> {
	if (options.mutationGuard) {
		options.mutationGuard.assertCurrent();
		const result = await cleanupDaemonWorkerArtifactsWithGuard(options, options.mutationGuard);
		options.mutationGuard.assertCurrent();
		return result;
	}
	let mutationGuard: HeldAuthorityMutationGuard;
	try {
		mutationGuard = await acquireDaemonWorkerMutationGuard(options.descriptorPath);
	} catch (error) {
		return {
			status: "retained",
			reason: `worker mutation guard could not be acquired: ${String(error)}`,
		};
	}
	let result: DaemonWorkerCleanupResult | undefined;
	let failure: unknown;
	try {
		mutationGuard.assertCurrent();
		result = await cleanupDaemonWorkerArtifactsWithGuard(options, mutationGuard);
		mutationGuard.assertCurrent();
	} catch (error) {
		failure = error;
	}
	let releaseFailure: unknown;
	try {
		mutationGuard.release();
	} catch (error) {
		releaseFailure = error;
	}
	if (failure && result === undefined) throw failure;
	if (failure || releaseFailure) {
		if (result?.status === "retained") return result;
		return {
			status: "retained",
			reason: `worker mutation guard was not preserved through cleanup: ${String(failure ?? releaseFailure)}`,
		};
	}
	return result!;
}
export interface FailedDaemonWorkerLaunchArtifacts {
	descriptorDirectory: string;
	workerId: string;
	supervisorSocketPath: string;
	descriptorPath: string;
	recoveryJournalPath: string;
	socketPath: string;
}

export interface FailedDaemonWorkerLaunchCleanupOptions {
	orphanProcessJournalPath: string;
	orphanProcessJournalGeneration: string;
	candidate?: ActiveOrphanProcessCandidate;
	artifacts?: FailedDaemonWorkerLaunchArtifacts;
	assertAuthority?: () => Promise<void>;
	observeSocket?: (socketPath: string) => Promise<DaemonWorkerSocketObservation>;
	probeOptions?: OrphanProcessProbeOptions;
	platform?: NodeJS.Platform;
	testHooks?: Readonly<DaemonWorkerCleanupTestHooks>;
	/** Existing canonical guard held by a wider launch/rollback transaction. */
	mutationGuard?: HeldAuthorityMutationGuard;
}

function assertFailedLaunchArtifactsCanonical(
	options: FailedDaemonWorkerLaunchCleanupOptions,
): FailedDaemonWorkerLaunchArtifacts | undefined {
	const artifacts = options.artifacts;
	if (!artifacts) return undefined;
	const directory = resolve(artifacts.descriptorDirectory);
	if (
		!WORKER_ID_PATTERN.test(artifacts.workerId) ||
		basename(artifacts.workerId) !== artifacts.workerId ||
		resolve(options.orphanProcessJournalPath) !== options.orphanProcessJournalPath ||
		options.orphanProcessJournalPath !== join(directory, `${artifacts.workerId}.orphans.jsonl`) ||
		artifacts.descriptorPath !== join(directory, `${artifacts.workerId}.json`) ||
		artifacts.recoveryJournalPath !== join(directory, `${artifacts.workerId}.recovery.jsonl`) ||
		artifacts.socketPath !==
			canonicalDaemonWorkerSocketPath(
				artifacts.supervisorSocketPath,
				artifacts.workerId,
				options.platform ?? process.platform,
			)
	) {
		throw new Error("Failed worker launch artifacts are not canonical");
	}
	assertDirectory(directory, "Worker descriptor directory");
	return artifacts;
}

function ensureFailedLaunchDescriptorAbsent(artifacts: FailedDaemonWorkerLaunchArtifacts): void {
	if (assertOptionalRegularFile(artifacts.descriptorPath, "Failed worker descriptor") !== "missing") {
		throw new Error("Failed worker descriptor exists; proof-backed descriptor cleanup is required");
	}
}

/** Clears only the known, just-created launch generation after exact child close/death proof. */
async function cleanupFailedDaemonWorkerLaunchAuthorityWithGuard(
	options: FailedDaemonWorkerLaunchCleanupOptions,
	mutationGuard: HeldAuthorityMutationGuard,
): Promise<boolean> {
	try {
		const artifacts = assertFailedLaunchArtifactsCanonical(options);
		const descriptorDirectory = dirname(options.orphanProcessJournalPath);
		const descriptorDirectoryIdentity = directoryIdentityNoFollow(descriptorDirectory, "Worker descriptor directory");
		const socketDirectory = artifacts ? dirname(artifacts.socketPath) : undefined;
		const socketDirectoryIdentity =
			socketDirectory && (options.platform ?? process.platform) !== "win32"
				? directoryIdentityNoFollow(socketDirectory, "Worker socket directory")
				: undefined;
		const assertStableDirectories = () => {
			mutationGuard.assertCurrent();
			assertDirectoryIdentity(descriptorDirectory, descriptorDirectoryIdentity, "Worker descriptor directory");
			if (socketDirectory && socketDirectoryIdentity) {
				assertDirectoryIdentity(socketDirectory, socketDirectoryIdentity, "Worker socket directory");
			}
		};
		const revalidateAuthority = async () => {
			assertStableDirectories();
			await options.assertAuthority?.();
			assertStableDirectories();
		};
		await revalidateAuthority();
		if (artifacts) ensureFailedLaunchDescriptorAbsent(artifacts);
		const journalIdentity = regularFileIdentityNoFollow(options.orphanProcessJournalPath);
		const platform = options.platform ?? process.platform;
		const effectiveProbeOptions = { ...options.probeOptions, platform };
		const proved = await reapOrphanProcessAuthority(options.orphanProcessJournalPath, {
			expectedGeneration: options.orphanProcessJournalGeneration,
			...(options.candidate && platform !== "win32" ? { additionalCandidates: [options.candidate] } : {}),
			beforeKill: async () => {
				await revalidateAuthority();
				assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
			},
			probeOptions: effectiveProbeOptions,
		});
		if (!proved) return false;
		assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
		if (options.candidate) {
			const rootDead =
				platform === "win32"
					? isExactProcessStartId(options.candidate.processStartId ?? "") &&
						classifyProcessIdentityAuthority(
							options.candidate.pid,
							options.candidate.processStartId,
							effectiveProbeOptions,
						) === "exact-dead"
					: isOrphanProcessCandidateExactDead(options.candidate, effectiveProbeOptions);
			if (!rootDead) return false;
		}

		if (artifacts) {
			ensureFailedLaunchDescriptorAbsent(artifacts);
			const socketPresence = assertOptionalSocket(artifacts.socketPath, platform);
			if (socketPresence === "present") {
				const observation = await (options.observeSocket ?? observeDaemonWorkerSocket)(artifacts.socketPath);
				if (observation !== "unreachable") return false;
				const socketRecord = socketIdentityNoFollow(artifacts.socketPath);
				await quarantineAndRemoveArtifact({
					artifact: "failed-socket",
					canonicalPath: artifacts.socketPath,
					record: socketRecord,
					platform,
					guard: mutationGuard,
					testHooks: options.testHooks,
					revalidateBeforeRename: async () => {
						await revalidateAuthority();
						ensureFailedLaunchDescriptorAbsent(artifacts);
						assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
					},
					revalidateAfterRename: async () => {
						await revalidateAuthority();
						ensureFailedLaunchDescriptorAbsent(artifacts);
						assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
					},
				});
			}

			if (assertOptionalRegularFile(artifacts.recoveryJournalPath, "Failed worker recovery journal") === "present") {
				const recoveryRecord = captureRegularFileRecord(artifacts.recoveryJournalPath, MAX_RECOVERY_ARTIFACT_BYTES);
				await quarantineAndRemoveArtifact({
					artifact: "failed-recovery",
					canonicalPath: artifacts.recoveryJournalPath,
					record: recoveryRecord,
					maxBytes: MAX_RECOVERY_ARTIFACT_BYTES,
					platform,
					guard: mutationGuard,
					testHooks: options.testHooks,
					revalidateBeforeRename: async () => {
						await revalidateAuthority();
						ensureFailedLaunchDescriptorAbsent(artifacts);
						assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
					},
					revalidateAfterRename: async () => {
						await revalidateAuthority();
						ensureFailedLaunchDescriptorAbsent(artifacts);
						assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
					},
				});
			}
		}

		await revalidateAuthority();
		if (artifacts) ensureFailedLaunchDescriptorAbsent(artifacts);
		assertRegularFileIdentity(options.orphanProcessJournalPath, journalIdentity);
		if (
			!clearOrphanProcessJournal(
				options.orphanProcessJournalPath,
				options.orphanProcessJournalGeneration,
				effectiveProbeOptions,
			)
		) {
			return false;
		}
		fsyncDirectory(dirname(options.orphanProcessJournalPath), options.platform);
		assertStableDirectories();
		ensureArtifactAbsent(options.orphanProcessJournalPath, "Failed worker orphan journal");
		await revalidateAuthority();
		if (artifacts) ensureFailedLaunchDescriptorAbsent(artifacts);
		removeEmptyOrphanJournalClaimsDirectory(options.orphanProcessJournalPath, mutationGuard, options.platform);
		assertStableDirectories();
		ensureOrphanJournalSupportAbsent(options.orphanProcessJournalPath);
		return true;
	} catch {
		return false;
	}
}

export async function cleanupFailedDaemonWorkerLaunchAuthority(
	options: FailedDaemonWorkerLaunchCleanupOptions,
): Promise<boolean> {
	if (options.mutationGuard) {
		try {
			options.mutationGuard.assertCurrent();
			const result = await cleanupFailedDaemonWorkerLaunchAuthorityWithGuard(options, options.mutationGuard);
			options.mutationGuard.assertCurrent();
			return result;
		} catch {
			return false;
		}
	}
	const descriptorPath =
		options.artifacts?.descriptorPath ??
		(options.orphanProcessJournalPath.endsWith(".orphans.jsonl")
			? `${options.orphanProcessJournalPath.slice(0, -".orphans.jsonl".length)}.json`
			: undefined);
	if (!descriptorPath) return false;
	let mutationGuard: HeldAuthorityMutationGuard;
	try {
		mutationGuard = await acquireDaemonWorkerMutationGuard(descriptorPath);
	} catch {
		return false;
	}
	let result = false;
	try {
		mutationGuard.assertCurrent();
		result = await cleanupFailedDaemonWorkerLaunchAuthorityWithGuard(options, mutationGuard);
		mutationGuard.assertCurrent();
	} catch {
		result = false;
	}
	try {
		mutationGuard.release();
	} catch {
		return false;
	}
	return result;
}
function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonicalJournalLockRecord(value: unknown): Readonly<OrphanProcessJournalAppendLockRecord> | undefined {
	let bytes: Buffer;
	try {
		bytes = Buffer.from(JSON.stringify(value), "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseOrphanProcessJournalAppendLockRecord(bytes);
	return parsed.status === "valid" ? parsed.record : undefined;
}

function artifactOwnerIsExactDead(
	owner: { ownerPid: number; processStartId?: string; processIdentityHint?: string },
	probeOptions?: ProcessIdentityObservationOptions,
): boolean {
	return classifyProcessIdentityAuthority(owner.ownerPid, owner.processStartId, probeOptions) === "exact-dead";
}

function parseSingleJsonLine(path: string): { value: unknown; identity: FileIdentity } {
	const opened = readRegularFileNoFollow(path, MAX_SWEEP_ARTIFACT_BYTES);
	if (!opened.contents.endsWith("\n") || opened.contents.trim().split("\n").length !== 1) {
		throw new Error(`Artifact is not one complete JSON record: ${path}`);
	}
	return {
		value: JSON.parse(opened.contents),
		identity: { device: opened.device, inode: opened.inode },
	};
}

function headerOnlyOrphanJournalIdentity(path: string): FileIdentity | undefined {
	try {
		const parsed = parseSingleJsonLine(path);
		const value = parsed.value as Record<string, unknown>;
		return value.version === 2 &&
			value.type === "authority" &&
			typeof value.generation === "string" &&
			value.generation.length > 0 &&
			value.sequence === 0 &&
			validTimestamp(value.createdAt) &&
			Object.keys(value).every((key) => ["version", "type", "generation", "sequence", "createdAt"].includes(key))
			? parsed.identity
			: undefined;
	} catch {
		return undefined;
	}
}

function journalLockArtifactOwner(name: string, record: Readonly<OrphanProcessJournalAppendLockRecord>): boolean {
	const marker = ".orphans.jsonl.append.lock.candidate-";
	const markerIndex = name.indexOf(marker);
	if (markerIndex < 1) return false;
	const workerId = name.slice(0, markerIndex);
	const suffix = name.slice(markerIndex + marker.length);
	return (
		WORKER_ID_PATTERN.test(workerId) &&
		basename(workerId) === workerId &&
		suffix === `${record.ownerPid}-${record.token}`
	);
}

function descriptorTempOwnerPid(name: string): number | undefined {
	const match = /^(?<workerId>[A-Za-z0-9._-]{1,256})\.json\.(?<pid>[1-9][0-9]*)(?:\.[0-9a-f]{32})?\.tmp$/.exec(name);
	if (!match?.groups) return undefined;
	const pid = Number(match.groups.pid);
	return Number.isSafeInteger(pid) ? pid : undefined;
}

function sweepArtifactWorkerId(name: string): string | undefined {
	const match = /^(?<workerId>[A-Za-z0-9._-]{1,256})(?:\.json(?:$|\.)|\.(?:orphans|recovery)\.jsonl(?:$|\.))/.exec(
		name,
	);
	const workerId = match?.groups?.workerId;
	return workerId && WORKER_ID_PATTERN.test(workerId) && basename(workerId) === workerId ? workerId : undefined;
}

export interface DaemonWorkerLaunchArtifactSweepResult {
	removed: string[];
	retained: string[];
}

/** Conservative startup sweep for inert crash residue from failed pre-registration launches. */
async function sweepFailedDaemonWorkerLaunchArtifactsWithGuards(
	descriptorDirectory: string,
	names: readonly string[],
	probeOptions: ProcessIdentityObservationOptions | undefined,
	assertAuthority: (() => Promise<void>) | undefined,
	mutationGuard: AuthorityMutationGuard,
	testHooks?: Readonly<DaemonWorkerCleanupTestHooks>,
): Promise<DaemonWorkerLaunchArtifactSweepResult> {
	const removed: string[] = [];
	const retained: string[] = [];
	const sweepDirectoryIdentity = directoryIdentityNoFollow(descriptorDirectory, "Worker descriptor directory");
	let authorityFailure: unknown;
	const revalidateAuthority = async () => {
		try {
			mutationGuard.assertCurrent();
			assertDirectoryIdentity(descriptorDirectory, sweepDirectoryIdentity, "Worker descriptor directory");
			await assertAuthority?.();
			assertDirectoryIdentity(descriptorDirectory, sweepDirectoryIdentity, "Worker descriptor directory");
		} catch (error) {
			authorityFailure = error;
			throw error;
		}
	};
	const retainOrRethrow = (error: unknown, path: string) => {
		if (error === authorityFailure) throw error;
		retained.push(path);
	};
	const descriptorNames = names.filter((name) => name.endsWith(".json"));
	const descriptorStems = new Set(descriptorNames.map((name) => name.slice(0, -5)));
	const referencedArtifactPaths = new Set<string>();
	for (const name of descriptorNames) {
		try {
			const value = JSON.parse(
				readRegularFileNoFollow(join(descriptorDirectory, name), MAX_DESCRIPTOR_BYTES).contents,
			) as Record<string, unknown>;
			for (const field of ["orphanProcessJournalPath", "recoveryJournalPath"] as const) {
				const referencedPath = value[field];
				if (typeof referencedPath !== "string") continue;
				referencedArtifactPaths.add(resolve(referencedPath));
				try {
					referencedArtifactPaths.add(realpathSync(referencedPath));
				} catch {
					// A missing reference still blocks cleanup at its declared path.
				}
			}
		} catch {
			// The descriptor stem below remains a conservative same-worker reference.
		}
	}

	for (const name of names) {
		const ownerPid = descriptorTempOwnerPid(name);
		if (ownerPid === undefined) continue;
		const path = join(descriptorDirectory, name);
		try {
			assertOptionalRegularFile(path, "Worker descriptor temp file");
			const record = captureRegularFileRecord(path, MAX_SWEEP_ARTIFACT_BYTES);
			if (!artifactOwnerIsExactDead({ ownerPid }, probeOptions)) throw new Error("temp owner retained");
			await quarantineAndRemoveArtifact({
				artifact: "sweep",
				canonicalPath: path,
				record,
				maxBytes: MAX_SWEEP_ARTIFACT_BYTES,
				platform: process.platform,
				guard: mutationGuard,
				testHooks,
				revalidateBeforeRename: revalidateAuthority,
				revalidateAfterRename: revalidateAuthority,
			});
			removed.push(path);
		} catch (error) {
			retainOrRethrow(error, path);
		}
	}

	for (const name of names) {
		if (name.endsWith(".orphans.jsonl.append.lock") && !name.includes(".candidate-")) {
			retained.push(join(descriptorDirectory, name));
		}
	}

	for (const name of names) {
		if (!name.includes(".orphans.jsonl.append.lock.candidate-")) continue;
		const path = join(descriptorDirectory, name);
		try {
			const parsed = readOrphanProcessJournalAppendLock(path);
			if (
				parsed.status !== "valid" ||
				!journalLockArtifactOwner(name, parsed.record) ||
				!artifactOwnerIsExactDead(parsed.record, probeOptions)
			) {
				throw new Error("owner retained");
			}
			const artifactRecord = captureRegularFileRecord(path, MAX_SWEEP_ARTIFACT_BYTES);
			if (
				artifactRecord.device !== parsed.device ||
				artifactRecord.inode !== parsed.inode ||
				artifactRecord.size !== parsed.size ||
				!artifactRecord.contents.equals(parsed.bytes)
			) {
				throw new Error("candidate changed before quarantine");
			}
			await quarantineAndRemoveArtifact({
				artifact: "sweep",
				canonicalPath: path,
				record: artifactRecord,
				maxBytes: MAX_SWEEP_ARTIFACT_BYTES,
				platform: process.platform,
				guard: mutationGuard,
				testHooks,
				revalidateBeforeRename: revalidateAuthority,
				revalidateAfterRename: revalidateAuthority,
			});
			removed.push(path);
		} catch (error) {
			retainOrRethrow(error, path);
		}
	}

	for (const name of names.filter((candidate) => candidate.endsWith(".orphans.jsonl.append.lock.claims"))) {
		const claimsPath = join(descriptorDirectory, name);
		try {
			const claimsIdentity = directoryIdentityNoFollow(claimsPath, "Journal lock claims directory");
			for (const claimName of readdirSync(claimsPath)) {
				const claimPath = join(claimsPath, claimName);
				try {
					const parsed = parseSingleJsonLine(claimPath);
					const marker = parsed.value as Record<string, unknown>;
					const lockRecord = canonicalJournalLockRecord(marker.lockRecord);
					const claimer = marker.claimer as Record<string, unknown> | undefined;
					const claimerHasOnlyCanonicalKeys =
						claimer !== undefined &&
						Object.keys(claimer).every((key) =>
							["ownerPid", "processStartId", "processIdentityHint", "token", "createdAt"].includes(key),
						);
					const claimerRecord =
						claimer && claimerHasOnlyCanonicalKeys
							? canonicalJournalLockRecord({
									version: 1,
									...claimer,
									expiresAt: claimer.createdAt,
								})
							: undefined;
					if (
						marker.version !== 1 ||
						marker.type !== "journal-lock-removal-claim" ||
						!lockRecord ||
						claimName !== lockRecord.token ||
						!claimerRecord ||
						!artifactOwnerIsExactDead(claimerRecord, probeOptions)
					) {
						throw new Error("claim owner retained");
					}
					const claimRecord = captureRegularFileRecord(claimPath, MAX_SWEEP_ARTIFACT_BYTES);
					if (claimRecord.device !== parsed.identity.device || claimRecord.inode !== parsed.identity.inode) {
						throw new Error("claim changed before quarantine");
					}
					await quarantineAndRemoveArtifact({
						artifact: "sweep",
						canonicalPath: claimPath,
						record: claimRecord,
						maxBytes: MAX_SWEEP_ARTIFACT_BYTES,
						platform: process.platform,
						guard: mutationGuard,
						testHooks,
						revalidateBeforeRename: revalidateAuthority,
						revalidateAfterRename: revalidateAuthority,
					});
					removed.push(claimPath);
				} catch (error) {
					retainOrRethrow(error, claimPath);
				}
			}
			if (readdirSync(claimsPath).length === 0) {
				await revalidateAuthority();
				assertDirectoryIdentity(claimsPath, claimsIdentity, "Journal lock claims directory");
				const quarantinePath = `${claimsPath}.quarantine-${process.pid}-${randomUUID()}`;
				renameSync(claimsPath, quarantinePath);
				await revalidateAuthority();
				assertDirectoryIdentity(quarantinePath, claimsIdentity, "Quarantined journal lock claims directory");
				if (readdirSync(quarantinePath).length !== 0) throw new Error("quarantined claims directory changed");
				rmdirSync(quarantinePath);
				fsyncDirectory(descriptorDirectory);
				assertDirectoryIdentity(descriptorDirectory, sweepDirectoryIdentity, "Worker descriptor directory");
				if (pathExistsNoFollow(claimsPath)) throw new Error("claims directory reappeared during quarantine");
				removed.push(claimsPath);
			}
		} catch (error) {
			retainOrRethrow(error, claimsPath);
		}
	}

	const refreshedNames = readdirSync(descriptorDirectory);
	for (const name of names.filter((candidate) => candidate.endsWith(".orphans.jsonl"))) {
		const workerId = name.slice(0, -".orphans.jsonl".length);
		const path = join(descriptorDirectory, name);
		const supportPrefix = `${name}.append.lock`;
		const headerIdentity = headerOnlyOrphanJournalIdentity(path);
		if (
			descriptorStems.has(workerId) ||
			referencedArtifactPaths.has(resolve(path)) ||
			refreshedNames.some((candidate) => candidate.startsWith(supportPrefix)) ||
			!WORKER_ID_PATTERN.test(workerId) ||
			headerIdentity === undefined
		) {
			retained.push(path);
			continue;
		}
		try {
			const headerRecord = captureRegularFileRecord(path, MAX_SWEEP_ARTIFACT_BYTES);
			if (headerRecord.device !== headerIdentity.device || headerRecord.inode !== headerIdentity.inode) {
				throw new Error("header-only journal changed before quarantine");
			}
			await quarantineAndRemoveArtifact({
				artifact: "sweep",
				canonicalPath: path,
				record: headerRecord,
				maxBytes: MAX_SWEEP_ARTIFACT_BYTES,
				platform: process.platform,
				guard: mutationGuard,
				testHooks,
				revalidateBeforeRename: revalidateAuthority,
				revalidateAfterRename: revalidateAuthority,
			});
			removed.push(path);
		} catch (error) {
			retainOrRethrow(error, path);
		}
	}
	for (const name of names.filter((candidate) => candidate.endsWith(".recovery.jsonl"))) {
		const workerId = name.slice(0, -".recovery.jsonl".length);
		if (!descriptorStems.has(workerId)) retained.push(join(descriptorDirectory, name));
	}
	return { removed, retained: [...new Set(retained)] };
}

export async function sweepFailedDaemonWorkerLaunchArtifacts(
	descriptorDirectory: string,
	probeOptions?: ProcessIdentityObservationOptions,
	assertAuthority?: () => Promise<void>,
	testHooks?: Readonly<DaemonWorkerCleanupTestHooks>,
): Promise<DaemonWorkerLaunchArtifactSweepResult> {
	const canonicalDirectory = resolve(descriptorDirectory);
	if (canonicalDirectory !== descriptorDirectory) {
		throw new Error(`Worker descriptor directory is not canonical: ${descriptorDirectory}`);
	}
	const names = readdirSync(descriptorDirectory).sort();
	const descriptorPaths = [
		...new Set(
			names
				.map(sweepArtifactWorkerId)
				.filter((workerId): workerId is string => workerId !== undefined)
				.map((workerId) => join(descriptorDirectory, `${workerId}.json`)),
		),
	].sort();
	const held: HeldAuthorityMutationGuard[] = [];
	let result: DaemonWorkerLaunchArtifactSweepResult | undefined;
	let failure: unknown;
	try {
		for (const descriptorPath of descriptorPaths) {
			const guard = await acquireDaemonWorkerMutationGuard(descriptorPath);
			held.push(guard);
			for (const current of held) current.assertCurrent();
		}
		const compositeGuard: AuthorityMutationGuard = {
			assertCurrent(): void {
				for (const guard of held) guard.assertCurrent();
			},
		};
		const guardedDescriptorPaths = new Set(descriptorPaths);
		const snapshotNames = readdirSync(descriptorDirectory).sort();
		const unguardedWorkerArtifact = snapshotNames.find((name) => {
			const workerId = sweepArtifactWorkerId(name);
			return workerId !== undefined && !guardedDescriptorPaths.has(join(descriptorDirectory, `${workerId}.json`));
		});
		if (unguardedWorkerArtifact) {
			throw new Error(`Worker artifact appeared before its mutation guard was held: ${unguardedWorkerArtifact}`);
		}
		result = await sweepFailedDaemonWorkerLaunchArtifactsWithGuards(
			descriptorDirectory,
			snapshotNames,
			probeOptions,
			assertAuthority,
			compositeGuard,
			testHooks,
		);
		compositeGuard.assertCurrent();
	} catch (error) {
		failure = error;
	}
	for (const guard of held.reverse()) {
		try {
			guard.release();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure) throw failure;
	return result!;
}
