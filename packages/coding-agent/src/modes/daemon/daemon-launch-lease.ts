import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AuthorityMutationGuard, acquireAuthorityMutationGuard } from "../../core/authority-mutation-guard.js";
import {
	classifyProcessIdentityAuthority,
	isExactProcessStartId,
	matchesExactProcessIdentity,
	normalizePortableProcessIdentityHint,
	observeProcessIdentity,
	projectLegacyProcessStartId,
} from "../../core/session-lease.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "./daemon-socket.js";

interface DaemonLaunchLeaseRecord {
	version: 1;
	token: string;
	ownerPid: number;
	ownerProcessStartId?: string;
	ownerAuthorityProcessStartId?: string;
	ownerProcessIdentityHint?: string;
	socketPath: string;
}

export class DaemonLaunchLeaseOwnershipLostError extends Error {
	readonly code = "daemon_launch_lease_lost" as const;

	constructor(readonly socketPath: string) {
		super(`Daemon launch lease ownership was lost: ${socketPath}`);
		this.name = "DaemonLaunchLeaseOwnershipLostError";
	}
}

export class DaemonLaunchLease {
	private released = false;
	private lostError?: Error;
	private readonly record: DaemonLaunchLeaseRecord;
	private readonly directories: string[];

	constructor(
		readonly socketPath: string,
		directory: string,
		token: string,
		compatibilityDirectories: string[] = [],
	) {
		this.directories = [directory, ...compatibilityDirectories];
		const current = readLeaseRecord(directory);
		this.record =
			current?.token === token
				? current
				: ({ version: 1, token, ownerPid: process.pid, socketPath } satisfies DaemonLaunchLeaseRecord);
	}

	release(): void {
		if (this.released) return;
		if (this.lostError) throw this.lostError;
		const releasedDirectories: string[] = [];
		try {
			for (const directory of this.directories) {
				withLaunchLeaseGuard(directory, (guard) => {
					const current = readLeaseRecord(directory);
					if (!current || !sameLaunchLeaseAuthority(current, this.record) || !isSelfOwnedLaunchLease(current)) {
						throw new DaemonLaunchLeaseOwnershipLostError(this.socketPath);
					}
					const releasedDirectory = `${directory}.released-${process.pid}-${this.record.token}`;
					try {
						const reread = readLeaseRecord(directory);
						if (!reread || !sameLaunchLeaseAuthority(reread, this.record)) {
							throw new DaemonLaunchLeaseOwnershipLostError(this.socketPath);
						}
						guard.assertCurrent();
						renameSync(directory, releasedDirectory);
						releasedDirectories.push(releasedDirectory);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							throw new DaemonLaunchLeaseOwnershipLostError(this.socketPath);
						}
						const reread = readLeaseRecord(directory);
						if (!reread || !sameLaunchLeaseAuthority(reread, this.record)) {
							throw new DaemonLaunchLeaseOwnershipLostError(this.socketPath);
						}
						guard.assertCurrent();
						writeFileSync(join(directory, "released"), `${this.record.token}\n`, {
							flag: "wx",
							mode: 0o600,
						});
					}
				});
			}
			this.released = true;
		} catch (error) {
			this.lostError = error instanceof Error ? error : new DaemonLaunchLeaseOwnershipLostError(this.socketPath);
			throw this.lostError;
		} finally {
			for (const releasedDirectory of releasedDirectories) {
				rmSync(releasedDirectory, { recursive: true, force: true });
			}
		}
	}
}

/**
 * Elect one frontend process to classify, replace, or launch a daemon. The
 * daemon's lifetime socket lease remains the final singleton authority; this
 * short lease prevents reconnecting clients from spawning a herd first.
 */
function launchLeaseLivenessProcessStartId(record: DaemonLaunchLeaseRecord): string | undefined {
	return (
		record.ownerAuthorityProcessStartId ??
		(record.ownerProcessStartId && isExactProcessStartId(record.ownerProcessStartId)
			? record.ownerProcessStartId
			: undefined)
	);
}

function rawDaemonLaunchLeaseDirectory(socketPath: string): string {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	const parent = process.platform === "win32" ? defaultDaemonSocketDir() : dirname(socketPath);
	return join(parent, `.supervisor-launch-${key}.lock`);
}

function legacyLexicalLaunchLeaseDirectories(
	requestedSocketPath: string,
	physicalSocketPath: string,
	canonicalDirectory: string,
): string[] {
	if (process.platform === "win32") return [];
	const candidates = new Set<string>([requestedSocketPath]);
	if (process.platform === "darwin") {
		if (physicalSocketPath.startsWith("/private/var/")) candidates.add(physicalSocketPath.slice("/private".length));
		if (physicalSocketPath.startsWith("/private/tmp/")) candidates.add(physicalSocketPath.slice("/private".length));
	}
	return [...candidates]
		.map(rawDaemonLaunchLeaseDirectory)
		.filter(
			(directory, index, directories) =>
				directory !== canonicalDirectory && directories.indexOf(directory) === index,
		);
}

function launchLeaseSocketMatches(record: DaemonLaunchLeaseRecord, socketPath: string): boolean {
	try {
		return normalizeSocketPath(record.socketPath) === socketPath;
	} catch {
		return false;
	}
}

function reclaimLegacyLaunchLeaseDirectory(directory: string, socketPath: string): boolean {
	let staleDirectory: string | undefined;
	try {
		return withLaunchLeaseGuard(directory, (guard) => {
			if (!readDirectoryPresence(directory)) return true;
			const existing = readLeaseRecord(directory);
			if (existing) {
				if (!launchLeaseSocketMatches(existing, socketPath)) return false;
				if (
					!hasMatchingReleaseMarker(directory, existing.token) &&
					classifyProcessIdentityAuthority(existing.ownerPid, launchLeaseLivenessProcessStartId(existing)) !==
						"exact-dead"
				) {
					return false;
				}
				const reread = readLeaseRecord(directory);
				if (!reread || !sameLaunchLeaseRecord(reread, existing)) return false;
			} else {
				if (existsSync(join(directory, "lease.json"))) return false;
				const legacyPid = readLegacyLeasePid(directory);
				if (
					legacyPid === undefined ||
					classifyProcessIdentityAuthority(legacyPid) !== "exact-dead" ||
					readLegacyLeasePid(directory) !== legacyPid
				) {
					return false;
				}
			}
			let before: ReturnType<typeof lstatSync>;
			try {
				before = lstatSync(directory, { bigint: true });
			} catch {
				return !readDirectoryPresence(directory);
			}
			if (!before.isDirectory() || before.isSymbolicLink()) return false;
			guard.assertCurrent();
			const after = lstatSync(directory, { bigint: true });
			if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
				return false;
			}
			staleDirectory = `${directory}.stale-${process.pid}-${randomUUID()}`;
			renameSync(directory, staleDirectory);
			return true;
		});
	} catch {
		return false;
	} finally {
		if (staleDirectory) rmSync(staleDirectory, { recursive: true, force: true });
	}
}

function reserveLegacyLaunchLeaseDirectory(directory: string, record: DaemonLaunchLeaseRecord): boolean {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (readDirectoryPresence(directory) && !reclaimLegacyLaunchLeaseDirectory(directory, record.socketPath)) {
			return false;
		}
		const candidate = `${directory}.candidate-${process.pid}-${record.token}-${attempt}`;
		mkdirSync(candidate, { recursive: true, mode: 0o700 });
		writeFileSync(join(candidate, "pid"), `${process.pid}\n`, { mode: 0o600 });
		writeFileSync(join(candidate, "lease.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		try {
			renameSync(candidate, directory);
			return true;
		} catch (error) {
			rmSync(candidate, { recursive: true, force: true });
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") return false;
		}
	}
	return false;
}

function removeOwnedLaunchLeaseDirectory(
	directory: string,
	record: DaemonLaunchLeaseRecord,
	guard: AuthorityMutationGuard,
): void {
	const current = readLeaseRecord(directory);
	if (!current || !sameLaunchLeaseAuthority(current, record)) return;
	guard.assertCurrent();
	const removed = `${directory}.released-${process.pid}-${record.token}`;
	let renamed = false;
	try {
		renameSync(directory, removed);
		renamed = true;
	} finally {
		if (renamed) rmSync(removed, { recursive: true, force: true });
	}
}

export function tryAcquireDaemonLaunchLease(socketPath: string): DaemonLaunchLease | undefined {
	const requestedSocketPath = socketPath;
	socketPath = normalizeSocketPath(socketPath);
	const directory = daemonLaunchLeaseDirectory(socketPath);
	const compatibilityDirectories = legacyLexicalLaunchLeaseDirectories(requestedSocketPath, socketPath, directory);
	const staleDirectories: string[] = [];
	try {
		return withLaunchLeaseGuard(directory, (guard) => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const token = randomUUID();
				const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
				const observation = observeProcessIdentity(process.pid);
				if (observation.status !== "present-exact" && observation.status !== "present-coarse") return undefined;
				const authorityProcessStartId = observation.status === "present-exact" ? observation.id : undefined;
				const legacyProcessStartId = authorityProcessStartId
					? projectLegacyProcessStartId(authorityProcessStartId)
					: undefined;
				const record: DaemonLaunchLeaseRecord = {
					version: 1,
					token,
					ownerPid: process.pid,
					...(legacyProcessStartId ? { ownerProcessStartId: legacyProcessStartId } : {}),
					...(authorityProcessStartId ? { ownerAuthorityProcessStartId: authorityProcessStartId } : {}),
					...(observation.status === "present-coarse" ? { ownerProcessIdentityHint: observation.hint } : {}),
					socketPath,
				};
				mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
				writeFileSync(join(candidateDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
				writeFileSync(join(candidateDirectory, "lease.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
				try {
					if (readDirectoryPresence(directory)) {
						throw Object.assign(new Error("Daemon launch lease exists"), { code: "EEXIST" });
					}
					guard.assertCurrent();
					renameSync(candidateDirectory, directory);
					const reservedCompatibilityDirectories: string[] = [];
					for (const compatibilityDirectory of compatibilityDirectories) {
						if (reserveLegacyLaunchLeaseDirectory(compatibilityDirectory, record)) {
							reservedCompatibilityDirectories.push(compatibilityDirectory);
							continue;
						}
						for (const reservedDirectory of reservedCompatibilityDirectories) {
							withLaunchLeaseGuard(reservedDirectory, (reservedGuard) =>
								removeOwnedLaunchLeaseDirectory(reservedDirectory, record, reservedGuard),
							);
						}
						removeOwnedLaunchLeaseDirectory(directory, record, guard);
						return undefined;
					}
					return new DaemonLaunchLease(socketPath, directory, record.token, reservedCompatibilityDirectories);
				} catch (error) {
					rmSync(candidateDirectory, { recursive: true, force: true });
					if (!isDaemonLaunchLeaseContentionError(error, directory, socketPath)) throw error;
				}

				const existing = readLeaseRecord(directory);
				if (existing) {
					if (!launchLeaseSocketMatches(existing, socketPath)) return undefined;
					if (!hasMatchingReleaseMarker(directory, existing.token)) {
						const authority = classifyProcessIdentityAuthority(
							existing.ownerPid,
							launchLeaseLivenessProcessStartId(existing),
						);
						if (authority !== "exact-dead") return undefined;
					}
					const reread = readLeaseRecord(directory);
					if (
						!reread ||
						!sameLaunchLeaseRecord(reread, existing) ||
						(!hasMatchingReleaseMarker(directory, reread.token) &&
							classifyProcessIdentityAuthority(reread.ownerPid, launchLeaseLivenessProcessStartId(reread)) !==
								"exact-dead")
					) {
						return undefined;
					}
					const immediate = readLeaseRecord(directory);
					if (!immediate || !sameLaunchLeaseRecord(immediate, reread)) return undefined;
				} else {
					// A present malformed structured record is relevant authority, never
					// a legacy absence proof.
					if (existsSync(join(directory, "lease.json"))) return undefined;
					const legacyPid = readLegacyLeasePid(directory);
					// A legacy PID-only directory is reclaimable only after observed absence.
					if (
						legacyPid === undefined ||
						classifyProcessIdentityAuthority(legacyPid) !== "exact-dead" ||
						readLegacyLeasePid(directory) !== legacyPid
					) {
						return undefined;
					}
				}
				const staleDirectory = `${directory}.stale-${process.pid}-${token}`;
				guard.assertCurrent();
				renameSync(directory, staleDirectory);
				staleDirectories.push(staleDirectory);
			}
			return undefined;
		});
	} finally {
		for (const directory of staleDirectories) rmSync(directory, { recursive: true, force: true });
	}
}

export function isDaemonLaunchLeaseContentionError(error: unknown, directory: string, socketPath: string): boolean {
	socketPath = normalizeSocketPath(socketPath);
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EEXIST" || code === "ENOTEMPTY") return true;
	if (code !== "EPERM" && code !== "EACCES") return false;
	const record = readLeaseRecord(directory);
	if (record) return launchLeaseSocketMatches(record, socketPath);
	try {
		const legacyPid = Number(readFileSync(join(directory, "pid"), "utf8").trim());
		return Number.isInteger(legacyPid) && legacyPid > 0;
	} catch {
		return false;
	}
}

export function daemonLaunchLeaseDirectory(socketPath: string): string {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	const key = createHash("sha256").update(physicalSocketPath).digest("hex").slice(0, 12);
	const parent = process.platform === "win32" ? defaultDaemonSocketDir() : dirname(physicalSocketPath);
	return join(parent, `.supervisor-launch-${key}.lock`);
}

function readLeaseRecord(directory: string): DaemonLaunchLeaseRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(join(directory, "lease.json"), "utf8")) as Partial<DaemonLaunchLeaseRecord>;
		if (
			value.version !== 1 ||
			typeof value.token !== "string" ||
			typeof value.ownerPid !== "number" ||
			!Number.isInteger(value.ownerPid) ||
			value.ownerPid <= 0 ||
			typeof value.socketPath !== "string" ||
			(value.ownerProcessStartId !== undefined && typeof value.ownerProcessStartId !== "string") ||
			(value.ownerAuthorityProcessStartId !== undefined &&
				(typeof value.ownerAuthorityProcessStartId !== "string" ||
					!isExactProcessStartId(value.ownerAuthorityProcessStartId) ||
					(value.ownerProcessStartId !== undefined &&
						value.ownerProcessStartId !== projectLegacyProcessStartId(value.ownerAuthorityProcessStartId)))) ||
			(value.ownerProcessIdentityHint !== undefined &&
				(typeof value.ownerProcessIdentityHint !== "string" ||
					normalizePortableProcessIdentityHint(value.ownerProcessIdentityHint) !==
						value.ownerProcessIdentityHint)) ||
			(value.ownerProcessStartId !== undefined && value.ownerProcessIdentityHint !== undefined) ||
			(value.ownerAuthorityProcessStartId !== undefined && value.ownerProcessIdentityHint !== undefined)
		) {
			return undefined;
		}
		normalizeSocketPath(value.socketPath);
		return value as DaemonLaunchLeaseRecord;
	} catch {
		return undefined;
	}
}

function readDirectoryPresence(directory: string): boolean {
	return existsSync(directory);
}

function readLegacyLeasePid(directory: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(directory, "pid"), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function hasMatchingReleaseMarker(directory: string, token: string): boolean {
	try {
		return readFileSync(join(directory, "released"), "utf8").trim() === token;
	} catch {
		return false;
	}
}

function isSelfOwnedLaunchLease(record: DaemonLaunchLeaseRecord): boolean {
	if (record.ownerPid !== process.pid) return false;
	if (record.ownerAuthorityProcessStartId) {
		return matchesExactProcessIdentity(record.ownerPid, record.ownerAuthorityProcessStartId);
	}
	// Legacy-only start IDs never authorize a new-reader mutation.
	if (record.ownerProcessStartId) return false;
	if (record.ownerProcessIdentityHint) {
		const observation = observeProcessIdentity(record.ownerPid);
		return observation.status === "present-coarse" || observation.status === "present-exact";
	}
	return false;
}

function sameLaunchLeaseAuthority(left: DaemonLaunchLeaseRecord, right: DaemonLaunchLeaseRecord): boolean {
	return (
		left.version === right.version &&
		left.token === right.token &&
		left.ownerPid === right.ownerPid &&
		left.ownerProcessStartId === right.ownerProcessStartId &&
		left.ownerAuthorityProcessStartId === right.ownerAuthorityProcessStartId &&
		left.ownerProcessIdentityHint === right.ownerProcessIdentityHint &&
		left.socketPath === right.socketPath
	);
}

function sameLaunchLeaseRecord(left: DaemonLaunchLeaseRecord, right: DaemonLaunchLeaseRecord): boolean {
	return sameLaunchLeaseAuthority(left, right);
}

function withLaunchLeaseGuard<T>(directory: string, action: (guard: AuthorityMutationGuard) => T): T {
	const observation = observeProcessIdentity(process.pid);
	if (observation.status !== "present-exact" && observation.status !== "present-coarse") {
		throw new Error(`Cannot establish current process identity (${observation.status})`);
	}
	const held = acquireAuthorityMutationGuard({
		authorityPath: directory,
		lockfilePath: `${directory}.guard`,
		attempts: 100,
		retryMs: 10,
		identity:
			observation.status === "present-exact"
				? { processStartId: observation.id }
				: { processIdentityHint: observation.hint },
		classifyOwner: (owner) =>
			classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
		failureMessage: `Could not coordinate daemon launch lease: ${directory}`,
	});
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
