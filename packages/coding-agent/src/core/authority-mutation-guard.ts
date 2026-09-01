import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
	isExactProcessStartId,
	normalizePortableProcessIdentityHint,
	normalizeRetainedLegacyProcessStartId,
} from "./session-lease.js";

const GUARD_RECORD_MAX_BYTES = 16 * 1024;
const guardWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface AuthorityMutationGuard {
	assertCurrent(): void;
}

export interface AuthorityGuardProcessIdentity {
	processStartId?: string;
	processIdentityHint?: string;
}

interface AuthorityGuardOwnerRecord extends AuthorityGuardProcessIdentity {
	version: 1;
	type: "authority-mutation-guard";
	token: string;
	pid: number;
	authorityPath: string;
	createdAt: string;
}

interface OpenGuardFile {
	descriptor: number;
	device: bigint;
	inode: bigint;
	raw: string;
}

interface OpenGuardOwner extends OpenGuardFile {
	record: AuthorityGuardOwnerRecord;
}

/** Deterministic synchronous seams for guard-reclamation race tests only. */
export interface AuthorityMutationGuardTestHooks {
	afterReclaimClaim?: () => void;
	beforeReclaimUnlink?: () => void;
}

export interface AcquireAuthorityMutationGuardOptions {
	authorityPath: string;
	lockfilePath: string;
	attempts: number;
	retryMs: number;
	identity: AuthorityGuardProcessIdentity;
	classifyOwner: (owner: Readonly<{ pid: number; processStartId?: string }>) => "exact-dead" | "retained";
	failureMessage: string;
	testHooks?: Readonly<AuthorityMutationGuardTestHooks>;
}

export interface HeldAuthorityMutationGuard extends AuthorityMutationGuard {
	release(): void;
}

export class AuthorityGuardContentionError extends Error {
	readonly code = "authority_guard_contended" as const;
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "AuthorityGuardContentionError";
		this.cause = cause;
	}
}

export class AuthorityGuardCompromisedError extends Error {
	readonly code = "authority_guard_compromised" as const;
	readonly cause: unknown;

	constructor(
		readonly authorityPath: string,
		cause: unknown,
	) {
		super(`Authority guard was compromised: ${authorityPath}`);
		this.name = "AuthorityGuardCompromisedError";
		this.cause = cause;
	}
}

function noFollowFlag(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function writeAllSync(descriptor: number, value: string): void {
	const bytes = Buffer.from(value);
	let offset = 0;
	while (offset < bytes.length) {
		offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
	}
}

function readBoundedDescriptor(descriptor: number): string {
	const buffer = Buffer.allocUnsafe(GUARD_RECORD_MAX_BYTES + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > GUARD_RECORD_MAX_BYTES) throw new Error("Authority guard record is too large");
	return buffer.toString("utf8", 0, offset);
}

function sameInode(
	left: Readonly<{ dev: bigint; ino: bigint }>,
	right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isAuthorityGuardOwnerRecord(value: unknown): value is AuthorityGuardOwnerRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AuthorityGuardOwnerRecord>;
	return (
		record.version === 1 &&
		record.type === "authority-mutation-guard" &&
		typeof record.token === "string" &&
		/^[0-9a-f]{64}$/.test(record.token) &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		(record.processStartId === undefined ||
			(typeof record.processStartId === "string" &&
				(isExactProcessStartId(record.processStartId) ||
					normalizeRetainedLegacyProcessStartId(record.processStartId) !== undefined))) &&
		(record.processIdentityHint === undefined ||
			(typeof record.processIdentityHint === "string" &&
				normalizePortableProcessIdentityHint(record.processIdentityHint) === record.processIdentityHint)) &&
		!(record.processStartId && record.processIdentityHint) &&
		typeof record.authorityPath === "string" &&
		typeof record.createdAt === "string"
	);
}

function openPinnedGuardFile(path: string): OpenGuardFile | undefined {
	let descriptor: number | undefined;
	try {
		const pathStat = lstatSync(path, { bigint: true });
		if (pathStat.isSymbolicLink() || !pathStat.isFile()) return undefined;
		descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
		const fileStat = fstatSync(descriptor, { bigint: true });
		const currentPathStat = lstatSync(path, { bigint: true });
		if (
			!fileStat.isFile() ||
			currentPathStat.isSymbolicLink() ||
			!currentPathStat.isFile() ||
			!sameInode(fileStat, currentPathStat)
		) {
			throw new Error("Authority guard path changed while opening");
		}
		return {
			descriptor,
			device: fileStat.dev,
			inode: fileStat.ino,
			raw: readBoundedDescriptor(descriptor),
		};
	} catch {
		if (descriptor !== undefined) closeSync(descriptor);
		return undefined;
	}
}

function openCanonicalGuardOwner(lockfilePath: string, authorityPath: string): OpenGuardOwner | undefined {
	const opened = openPinnedGuardFile(lockfilePath);
	if (!opened) return undefined;
	try {
		const parsed = JSON.parse(opened.raw) as unknown;
		if (!isAuthorityGuardOwnerRecord(parsed) || resolve(parsed.authorityPath) !== authorityPath) {
			throw new Error("Invalid authority guard owner");
		}
		return { ...opened, record: parsed };
	} catch {
		closeSync(opened.descriptor);
		return undefined;
	}
}

function closeOpenGuardOwner(owner: OpenGuardOwner | undefined): void {
	if (owner) closeSync(owner.descriptor);
}

function fsyncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch {
		// Some platforms do not permit fsync on directories. The record itself is
		// still fsynced before publication.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Remove a guard only after exact owner death. The deterministic hard-link
 * claim elects exactly one reclaimer and pins the verified inode. A leftover
 * claim from a crashed reclaimer deliberately retains the canonical guard.
 */
function reclaimExactDeadGuard(options: AcquireAuthorityMutationGuardOptions): boolean {
	const authorityPath = resolve(options.authorityPath);
	const lockfilePath = resolve(options.lockfilePath);
	const opened = openCanonicalGuardOwner(lockfilePath, authorityPath);
	if (!opened) return false;
	const claimPath = `${lockfilePath}.reclaim-${opened.record.token}`;
	let claimLinked = false;
	try {
		if (options.classifyOwner(opened.record) !== "exact-dead") return false;
		try {
			linkSync(lockfilePath, claimPath);
			claimLinked = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return true;
			if (code === "EEXIST") {
				// Another reclaimer owns this deterministic claim. Never inspect or
				// clean its claim, and never progress toward canonical unlink.
				return false;
			}
			return false;
		}

		options.testHooks?.afterReclaimClaim?.();
		options.testHooks?.beforeReclaimUnlink?.();

		// Pin and read both paths immediately before unlink. Exact raw-record and
		// bigint inode equality makes an overtaking replacement fail closed. Once
		// this claim exists, no cooperating successor can publish until this owner
		// unlinks canonical, and no other reclaimer is allowed to reach that unlink.
		const claim = openPinnedGuardFile(claimPath);
		const canonical = openPinnedGuardFile(lockfilePath);
		try {
			if (
				!claim ||
				!canonical ||
				claim.device !== opened.device ||
				claim.inode !== opened.inode ||
				claim.raw !== opened.raw ||
				canonical.device !== opened.device ||
				canonical.inode !== opened.inode ||
				canonical.raw !== opened.raw ||
				claim.device !== canonical.device ||
				claim.inode !== canonical.inode ||
				claim.raw !== canonical.raw
			) {
				return false;
			}
			try {
				unlinkSync(lockfilePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
			fsyncDirectory(dirname(lockfilePath));
			return true;
		} finally {
			if (canonical) closeSync(canonical.descriptor);
			if (claim) closeSync(claim.descriptor);
		}
	} finally {
		closeOpenGuardOwner(opened);
		if (claimLinked) {
			try {
				safeUnlink(claimPath);
				fsyncDirectory(dirname(lockfilePath));
			} catch {
				// A leftover claim safely overblocks reclamation of this exact token.
			}
		}
	}
}

function publishGuard(
	lockfilePath: string,
	rawOwner: string,
	token: string,
): { descriptor: number; device: bigint; inode: bigint } {
	const publicationPath = `${lockfilePath}.publish-${token}`;
	let descriptor: number | undefined;
	let published = false;
	try {
		descriptor = openSync(
			publicationPath,
			constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
			0o600,
		);
		writeAllSync(descriptor, rawOwner);
		fsyncSync(descriptor);
		if (process.platform !== "win32") chmodSync(publicationPath, 0o600);
		const publicationStat = fstatSync(descriptor, { bigint: true });
		linkSync(publicationPath, lockfilePath);
		published = true;
		const canonicalStat = lstatSync(lockfilePath, { bigint: true });
		if (
			canonicalStat.isSymbolicLink() ||
			!canonicalStat.isFile() ||
			!sameInode(publicationStat, canonicalStat) ||
			readBoundedDescriptor(descriptor) !== rawOwner
		) {
			throw new Error("Could not publish canonical authority guard owner");
		}
		safeUnlink(publicationPath);
		fsyncDirectory(dirname(lockfilePath));
		return { descriptor, device: publicationStat.dev, inode: publicationStat.ino };
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (published) {
			try {
				const canonical = lstatSync(lockfilePath, { bigint: true });
				const publication = lstatSync(publicationPath, { bigint: true });
				if (sameInode(canonical, publication)) safeUnlink(lockfilePath);
			} catch {}
		}
		try {
			safeUnlink(publicationPath);
		} catch {}
		throw error;
	}
}

export function acquireAuthorityMutationGuard(
	options: AcquireAuthorityMutationGuardOptions,
): HeldAuthorityMutationGuard {
	const authorityPath = resolve(options.authorityPath);
	const lockfilePath = resolve(options.lockfilePath);
	const attempts = Math.max(1, Math.trunc(options.attempts));
	const retryMs = Math.max(0, Math.trunc(options.retryMs));
	const token = randomBytes(32).toString("hex");
	const owner: AuthorityGuardOwnerRecord = {
		version: 1,
		type: "authority-mutation-guard",
		token,
		pid: process.pid,
		...(options.identity.processStartId ? { processStartId: options.identity.processStartId } : {}),
		...(options.identity.processIdentityHint ? { processIdentityHint: options.identity.processIdentityHint } : {}),
		authorityPath,
		createdAt: new Date().toISOString(),
	};
	const rawOwner = `${JSON.stringify(owner)}\n`;
	let lastError: unknown;
	let held: { descriptor: number; device: bigint; inode: bigint } | undefined;

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			held = publishGuard(lockfilePath, rawOwner, token);
			break;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (reclaimExactDeadGuard({ ...options, authorityPath, lockfilePath })) continue;
			if (attempt === attempts - 1) break;
			Atomics.wait(guardWaitBuffer, 0, 0, retryMs);
		}
	}
	if (!held) throw new AuthorityGuardContentionError(options.failureMessage, lastError);

	let active = true;
	let compromised: AuthorityGuardCompromisedError | undefined;
	const assertFilesystemCurrent = (): void => {
		if (compromised) throw compromised;
		try {
			if (!active) throw new Error("Authority guard is not active");
			const opened = fstatSync(held.descriptor, { bigint: true });
			const canonical = lstatSync(lockfilePath, { bigint: true });
			if (
				!opened.isFile() ||
				opened.dev !== held.device ||
				opened.ino !== held.inode ||
				canonical.isSymbolicLink() ||
				!canonical.isFile() ||
				canonical.dev !== held.device ||
				canonical.ino !== held.inode ||
				readBoundedDescriptor(held.descriptor) !== rawOwner
			) {
				throw new Error("Authority guard inode or owner record changed");
			}
		} catch (error) {
			compromised = new AuthorityGuardCompromisedError(authorityPath, error);
			throw compromised;
		}
	};

	return {
		assertCurrent(): void {
			assertFilesystemCurrent();
		},
		release(): void {
			if (!active) return;
			const releasePath = `${lockfilePath}.release-${token}`;
			let releaseLinked = false;
			try {
				assertFilesystemCurrent();
				linkSync(lockfilePath, releasePath);
				releaseLinked = true;
				const linked = lstatSync(releasePath, { bigint: true });
				const canonical = lstatSync(lockfilePath, { bigint: true });
				if (
					linked.isSymbolicLink() ||
					!linked.isFile() ||
					linked.dev !== held.device ||
					linked.ino !== held.inode ||
					!sameInode(linked, canonical) ||
					readBoundedDescriptor(held.descriptor) !== rawOwner
				) {
					throw new Error("Authority guard changed before release");
				}
				unlinkSync(lockfilePath);
				fsyncDirectory(dirname(lockfilePath));
			} catch (error) {
				compromised =
					error instanceof AuthorityGuardCompromisedError
						? error
						: new AuthorityGuardCompromisedError(authorityPath, error);
				throw compromised;
			} finally {
				active = false;
				closeSync(held.descriptor);
				if (releaseLinked) {
					try {
						safeUnlink(releasePath);
						fsyncDirectory(dirname(lockfilePath));
					} catch {}
				}
			}
		},
	};
}
