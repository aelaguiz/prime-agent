import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	AuthorityGuardCompromisedError,
	AuthorityGuardContentionError,
	type AuthorityMutationGuard,
	acquireAuthorityMutationGuard,
	type HeldAuthorityMutationGuard,
} from "../../core/authority-mutation-guard.js";
import {
	classifyProcessIdentityAuthority,
	getLegacyProcessStartId,
	isExactProcessStartId,
	matchesExactProcessIdentity,
	normalizePortableProcessIdentityHint,
	observeProcessIdentity,
	type ProcessIdentityAuthority,
	projectLegacyProcessStartId,
} from "../../core/session-lease.js";
import { normalizePhysicalFilesystemPath } from "../../utils/daemon-socket-path.js";
import { parseDaemonSupervisorHelloIdentity } from "./daemon-protocol.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "./daemon-socket.js";

const DAEMON_SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

const OWNER_VERSION = 1;
// Guarded actions are synchronous and short. Bounded retries wait for a
// current owner to release; elapsed time never authorizes reclamation.
const REGISTRY_LOCK_RETRIES = 500;
const REGISTRY_LOCK_RETRY_MS = 10;
const STARTUP_FENCE_POLL_MS = 250;
const SHUTDOWN_ADMISSION_FILE_NAME = "shutdown-admission.json";
// New readers never authorize reclamation from time. The fixed maximum keeps
// pre-move readers from expiring a live projection after a clock jump.
const COMPATIBILITY_METADATA_EXPIRY = "+275760-09-13T00:00:00.000Z";
const SHUTDOWN_ADMISSION_REFRESH_MS = 1000;
const SHUTDOWN_ADMISSION_WAIT_MS = 50;
const OFFLINE_MAINTENANCE_DIRECTORY_NAME = "offline-maintenance";
const OFFLINE_MAINTENANCE_REFRESH_MS = 1000;
const OFFLINE_MAINTENANCE_ACQUIRE_WAIT_MS = 5500;
const OFFLINE_MAINTENANCE_ACQUIRE_POLL_MS = 50;

type DaemonSupervisorOwnerPhase = "starting" | "owner" | "stopping";

interface ProcessIdentity {
	pid: number;
	processStartId?: string;
	/** Diagnostic only; never compare this as an exact identity. */
	processIdentityHint?: string;
}

interface MirroredRegistryAuthority {
	/** New bridge records require a copy in every configured registry. */
	mirrorRequired?: true;
}

interface DaemonSupervisorOwnerRecord extends ProcessIdentity, MirroredRegistryAuthority {
	authorityProcessStartId?: string;
	authorityProcessIdentityHint?: string;
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	appVersion: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
	updatedAt: string;
	purpose?: "offline-maintenance";
	offlineMaintenanceExpiresAt?: string;
}

interface DaemonShutdownAdmissionRecord extends ProcessIdentity, MirroredRegistryAuthority {
	version: 1;
	token: string;
	/** Exact new-reader identity while the old projection intentionally omits it. */
	authorityProcessStartId?: string;
	authorityProcessIdentityHint?: string;
	purpose?: "offline-maintenance";
	socketPath?: string;
	descriptorDir?: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

export interface DaemonOfflineMaintenanceScope {
	socketPath: string;
	descriptorDir: string;
}

interface DaemonOfflineMaintenanceRecord
	extends ProcessIdentity,
		DaemonOfflineMaintenanceScope,
		MirroredRegistryAuthority {
	version: 1;
	role: "offline-maintenance";
	token: string;
	authorityProcessStartId?: string;
	authorityProcessIdentityHint?: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	compatibilityOwnerGeneration: string;
}

interface DaemonSupervisorOwnerScope {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
}

interface DaemonStartupFenceRecord extends ProcessIdentity, MirroredRegistryAuthority {
	version: 1;
	token: string;
	ownerToken: string;
	/** Exact new-reader identity paired with the old reader's required `ps:` projection. */
	authorityProcessStartId?: string;
	authorityProcessIdentityHint?: string;
	socketPath: string;
	supervisorGeneration: string;
	createdAt: string;
}

interface DaemonSupervisorHelloIdentity {
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorAuthorityProcessStartId?: string;
	supervisorSocketPath?: string;
}

interface AcquireDaemonSupervisorOwnershipOptions {
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	generation: string;
	appVersion: string;
	registryDir?: string;
	/** Test/migration override. Explicit registryDir alone preserves single-registry behavior. */
	legacyRegistryDir?: string;
	offlineMaintenanceWaitMs?: number;
}

class DaemonSupervisorAlreadyRunningError extends Error {
	readonly code = "daemon_supervisor_already_running" as const;

	constructor(readonly owner: DaemonSupervisorOwnerRecord) {
		super(`Daemon supervisor ${owner.generation} already owns ${owner.socketPath}`);
		this.name = "DaemonSupervisorAlreadyRunningError";
	}
}

class DaemonSupervisorOwnershipLostError extends Error {
	readonly code = "supervisor_generation_stale" as const;

	constructor(generation: string, details: { socketPath?: string; registryDir?: string } = {}) {
		const context = [
			details.socketPath ? `socket: ${details.socketPath}` : undefined,
			details.registryDir ? `registry: ${details.registryDir}` : undefined,
		].filter((part) => part !== undefined);
		super(
			`Daemon supervisor generation ${generation} no longer owns its registry entry ` +
				`(record on disk is missing or was replaced)${context.length > 0 ? `; ${context.join("; ")}` : ""}; ` +
				"restart the daemon to recover — sessions are preserved",
		);
		this.name = "DaemonSupervisorOwnershipLostError";
	}
}

class DaemonShutdownAdmissionError extends Error {
	readonly code = "daemon_shutdown_in_progress" as const;

	constructor(message = "Daemon shutdown is in progress") {
		super(message);
		this.name = "DaemonShutdownAdmissionError";
	}
}

export class DaemonOfflineMaintenanceError extends Error {
	readonly code = "daemon_offline_maintenance_in_progress" as const;

	constructor(scope: DaemonOfflineMaintenanceScope) {
		super(`Daemon offline maintenance owns ${scope.socketPath} / ${scope.descriptorDir}`);
		this.name = "DaemonOfflineMaintenanceError";
	}
}

export type RegistryMutationGuard = AuthorityMutationGuard;

/**
 * Owns a lease-renew loop safely: the unref()'d interval, single-flight
 * refresh dedup shared by timer-fired and direct calls, and permanent loss.
 */
class RenewableRegistryRecord {
	private stopped = false;
	private lostError?: Error;
	private refreshPromise?: Promise<void>;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly registryDirs: readonly string[],
		refreshMs: number,
		private readonly renewUnderGuard: (guard: RegistryMutationGuard) => void,
		private readonly createLostError: () => Error,
	) {
		this.refreshTimer = setInterval(() => {
			void this.assertOrRenew().catch(() => undefined);
		}, refreshMs);
		this.refreshTimer.unref();
	}

	async assertOrRenew(): Promise<void> {
		if (this.stopped) throw this.createLostError();
		this.assertAvailable();
		this.refreshPromise ??= this.performRenew().finally(() => {
			this.refreshPromise = undefined;
		});
		await this.refreshPromise;
	}

	assertAvailable(): void {
		if (this.lostError) throw this.lostError;
	}

	lose(error: unknown): never {
		const lost = error instanceof Error ? error : this.createLostError();
		this.lostError ??= lost;
		clearInterval(this.refreshTimer);
		throw this.lostError;
	}

	private async performRenew(): Promise<void> {
		try {
			await withRegistryGuards(this.registryDirs, (guard) => {
				// stop() may have completed while this call waited on the guards.
				if (this.stopped) throw this.createLostError();
				this.assertAvailable();
				this.renewUnderGuard(guard);
			});
		} catch (error) {
			// A release overtaking a queued renew rejects that renew but is not
			// authority loss. Release still performs its own guarded preflight.
			if (this.stopped && !(error instanceof AuthorityGuardCompromisedError)) throw error;
			this.lose(error);
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearInterval(this.refreshTimer);
		await this.refreshPromise?.catch(() => undefined);
	}
}

class DaemonSupervisorOwnership {
	private released = false;
	private lostError?: Error;

	constructor(
		readonly record: DaemonSupervisorOwnerRecord,
		private readonly registryDirs: readonly string[],
		private readonly primaryRegistryDir: string,
	) {}

	async assertCurrent(): Promise<void> {
		this.assertAvailable();
		try {
			await withRegistryGuards(this.registryDirs, () => {
				requireOwnerCopies(this.registryDirs, this.record);
				assertSelfOwnedAuthority(this.record, () => this.ownershipLostError());
			});
		} catch (error) {
			this.lose(error);
		}
	}

	private ownershipLostError(): DaemonSupervisorOwnershipLostError {
		return new DaemonSupervisorOwnershipLostError(this.record.generation, {
			socketPath: this.record.socketPath,
			registryDir: this.registryDirs.join(","),
		});
	}

	private assertAvailable(): void {
		if (this.released || this.lostError) throw this.lostError ?? this.ownershipLostError();
	}

	private lose(error: unknown): never {
		this.lostError ??= error instanceof AuthorityGuardCompromisedError ? error : this.ownershipLostError();
		throw this.lostError;
	}

	async updatePhase(phase: DaemonSupervisorOwnerPhase): Promise<void> {
		this.assertAvailable();
		try {
			const updated = await mutateDaemonSupervisorOwner(
				this.record,
				(owner) => {
					owner.phase = phase;
				},
				this.registryDirs,
				this.primaryRegistryDir,
			);
			this.record.phase = phase;
			this.record.updatedAt = updated.updatedAt;
		} catch (error) {
			this.lose(error);
		}
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.assertAvailable();
		const releasedDirectories: string[] = [];
		try {
			await withRegistryGuards(this.registryDirs, (guard) => {
				requireOwnerCopies(this.registryDirs, this.record);
				assertSelfOwnedAuthority(this.record, () => this.ownershipLostError());
				for (const registryDir of releaseRegistryDirs(this.registryDirs, this.primaryRegistryDir)) {
					const directory = ownerDirectoryPath(registryDir, this.record.generation);
					const current = requireOwnerRecord(directory);
					if (!sameOwnerAuthority(current, this.record)) throw this.ownershipLostError();
					const releasedDirectory = `${directory}.released-${randomUUID()}`;
					guard.assertCurrent();
					renameSync(directory, releasedDirectory);
					releasedDirectories.push(releasedDirectory);
				}
			});
			this.released = true;
		} catch (error) {
			this.lose(error);
		} finally {
			for (const directory of releasedDirectories) rmSync(directory, { recursive: true, force: true });
		}
	}
}

class DaemonShutdownAdmission {
	private released = false;
	private readonly renewal: RenewableRegistryRecord;

	constructor(
		private readonly record: DaemonShutdownAdmissionRecord,
		private readonly registryDirs: readonly string[],
		private readonly primaryRegistryDir: string,
	) {
		this.renewal = new RenewableRegistryRecord(
			registryDirs,
			SHUTDOWN_ADMISSION_REFRESH_MS,
			(guard) => this.renewUnderGuard(guard),
			() => new DaemonShutdownAdmissionError("Daemon shutdown admission was lost"),
		);
	}

	async assertOrRenew(): Promise<void> {
		if (this.released) throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		await this.renewal.assertOrRenew();
	}

	private renewUnderGuard(guard: RegistryMutationGuard): void {
		requireShutdownAdmissionCopies(this.registryDirs, this.record);
		assertSelfOwnedAuthority(
			shutdownAdmissionIdentity(this.record),
			() => new DaemonShutdownAdmissionError("Daemon shutdown admission was lost"),
		);
		const now = Date.now();
		const updatedAt = new Date(now).toISOString();
		for (const registryDir of publicationRegistryDirs(this.registryDirs, this.primaryRegistryDir)) {
			const next: DaemonShutdownAdmissionRecord = {
				...this.record,
				updatedAt,
				expiresAt: COMPATIBILITY_METADATA_EXPIRY,
			};
			const path = shutdownAdmissionPath(registryDir);
			writeJsonAtomically(path, next, guard, () => {
				const current = readShutdownAdmission(path);
				if (!current || !sameShutdownAdmissionAuthority(current, this.record)) {
					throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
				}
			});
		}
		this.record.updatedAt = updatedAt;
		this.record.expiresAt = COMPATIBILITY_METADATA_EXPIRY;
	}

	async release(): Promise<void> {
		if (this.released) return;
		await this.renewal.stop();
		this.renewal.assertAvailable();
		try {
			await withRegistryGuards(this.registryDirs, (guard) => {
				requireShutdownAdmissionCopies(this.registryDirs, this.record);
				assertSelfOwnedAuthority(
					shutdownAdmissionIdentity(this.record),
					() => new DaemonShutdownAdmissionError("Daemon shutdown admission was lost"),
				);
				for (const registryDir of releaseRegistryDirs(this.registryDirs, this.primaryRegistryDir)) {
					const path = shutdownAdmissionPath(registryDir);
					const current = readShutdownAdmission(path);
					if (!current || !sameShutdownAdmissionAuthority(current, this.record)) {
						throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
					}
					guard.assertCurrent();
					rmSync(path, { force: true });
				}
			});
			this.released = true;
		} catch (error) {
			this.renewal.lose(error);
		}
	}
}

export class DaemonOfflineMaintenanceLease {
	private released = false;
	private readonly renewal: RenewableRegistryRecord;
	private readonly registryDirs: readonly string[];
	private readonly primaryRegistryDir: string;

	constructor(
		private readonly record: DaemonOfflineMaintenanceRecord,
		registryDirs: readonly string[] | string,
		_recordPath?: string,
		primaryRegistryDir?: string,
	) {
		this.registryDirs = typeof registryDirs === "string" ? canonicalRegistryDirs([registryDirs]) : registryDirs;
		this.primaryRegistryDir = canonicalizeFilesystemPath(primaryRegistryDir ?? this.registryDirs[0]!);
		this.renewal = new RenewableRegistryRecord(
			this.registryDirs,
			OFFLINE_MAINTENANCE_REFRESH_MS,
			(guard) => this.renewUnderGuard(guard),
			() => new DaemonOfflineMaintenanceError(record),
		);
	}

	async assertOrRenew(): Promise<void> {
		if (this.released) throw new DaemonOfflineMaintenanceError(this.record);
		await this.renewal.assertOrRenew();
	}

	private renewUnderGuard(guard: RegistryMutationGuard): void {
		requireOfflineMaintenanceCopies(this.registryDirs, this.record);
		assertSelfOwnedAuthority(this.record, () => new DaemonOfflineMaintenanceError(this.record));
		const now = Date.now();
		const updatedAt = new Date(now).toISOString();
		for (const registryDir of publicationRegistryDirs(this.registryDirs, this.primaryRegistryDir)) {
			const next: DaemonOfflineMaintenanceRecord = {
				...this.record,
				updatedAt,
				expiresAt: COMPATIBILITY_METADATA_EXPIRY,
			};
			const path = offlineMaintenancePath(offlineMaintenanceDirectory(registryDir), next.token);
			const ownerDirectory = ownerDirectoryPath(registryDir, next.compatibilityOwnerGeneration);
			const sentinelPath = shutdownAdmissionPath(registryDir);
			const previousCompatibilityOwner = offlineMaintenanceCompatibilityOwner(this.record);
			const previousSentinel = offlineMaintenanceShutdownSentinel(this.record);
			writeJsonAtomically(path, next, guard, () => {
				const current = readOfflineMaintenanceRecord(path);
				const currentCompatibilityOwner = readOwnerRecord(ownerDirectory);
				const currentSentinel = readShutdownAdmission(sentinelPath);
				if (
					!current ||
					!sameOfflineMaintenanceAuthority(current, this.record) ||
					current.updatedAt !== this.record.updatedAt ||
					!currentCompatibilityOwner ||
					!sameOwnerRecord(currentCompatibilityOwner, previousCompatibilityOwner) ||
					!currentSentinel ||
					!sameShutdownAdmissionRecord(currentSentinel, previousSentinel)
				) {
					throw new DaemonOfflineMaintenanceError(this.record);
				}
			});
			const compatibilityOwner = offlineMaintenanceCompatibilityOwner(next);
			writeOwnerRecord(
				ownerDirectory,
				compatibilityOwner,
				guard,
				() => {
					const current = readOwnerRecord(ownerDirectory);
					const currentMaintenance = readOfflineMaintenanceRecord(path);
					const currentSentinel = readShutdownAdmission(sentinelPath);
					if (
						!current ||
						!sameOwnerRecord(current, previousCompatibilityOwner) ||
						!currentMaintenance ||
						!sameOfflineMaintenanceRecord(currentMaintenance, next) ||
						!currentSentinel ||
						!sameShutdownAdmissionRecord(currentSentinel, previousSentinel)
					) {
						throw new DaemonOfflineMaintenanceError(this.record);
					}
				},
				registryDir !== this.primaryRegistryDir,
			);
			const sentinel = offlineMaintenanceShutdownSentinel(next);
			writeJsonAtomically(sentinelPath, sentinel, guard, () => {
				const currentSentinel = readShutdownAdmission(sentinelPath);
				const currentMaintenance = readOfflineMaintenanceRecord(path);
				const currentOwner = readOwnerRecord(ownerDirectory);
				if (
					!currentSentinel ||
					!sameShutdownAdmissionRecord(currentSentinel, previousSentinel) ||
					!currentMaintenance ||
					!sameOfflineMaintenanceRecord(currentMaintenance, next) ||
					!currentOwner ||
					!sameOwnerRecord(currentOwner, compatibilityOwner)
				) {
					throw new DaemonOfflineMaintenanceError(this.record);
				}
			});
		}
		this.record.updatedAt = updatedAt;
		this.record.expiresAt = COMPATIBILITY_METADATA_EXPIRY;
	}

	async release(): Promise<void> {
		if (this.released) return;
		await this.renewal.stop();
		this.renewal.assertAvailable();
		const releasedDirectories: string[] = [];
		try {
			await withRegistryGuards(this.registryDirs, (guard) => {
				requireOfflineMaintenanceCopies(this.registryDirs, this.record);
				assertSelfOwnedAuthority(this.record, () => new DaemonOfflineMaintenanceError(this.record));
				for (const registryDir of releaseRegistryDirs(this.registryDirs, this.primaryRegistryDir)) {
					const path = offlineMaintenancePath(offlineMaintenanceDirectory(registryDir), this.record.token);
					const sentinelPath = shutdownAdmissionPath(registryDir);
					const current = readOfflineMaintenanceRecord(path);
					const expectedSentinel = offlineMaintenanceShutdownSentinel(this.record);
					const sentinel = readShutdownAdmission(sentinelPath);
					if (
						!current ||
						!sameOfflineMaintenanceRecord(current, this.record) ||
						!sentinel ||
						!sameShutdownAdmissionRecord(sentinel, expectedSentinel)
					) {
						throw new DaemonOfflineMaintenanceError(this.record);
					}
					guard.assertCurrent();
					rmSync(path, { force: true });

					const ownerDirectory = ownerDirectoryPath(registryDir, this.record.compatibilityOwnerGeneration);
					const compatibilityOwner = readOwnerRecord(ownerDirectory);
					if (
						!compatibilityOwner ||
						!sameOwnerRecord(compatibilityOwner, offlineMaintenanceCompatibilityOwner(this.record))
					) {
						throw new DaemonOfflineMaintenanceError(this.record);
					}
					const releasedDirectory = `${ownerDirectory}.released-${randomUUID()}`;
					guard.assertCurrent();
					renameSync(ownerDirectory, releasedDirectory);
					releasedDirectories.push(releasedDirectory);

					const finalSentinel = readShutdownAdmission(sentinelPath);
					if (!finalSentinel || !sameShutdownAdmissionRecord(finalSentinel, expectedSentinel)) {
						throw new DaemonOfflineMaintenanceError(this.record);
					}
					guard.assertCurrent();
					rmSync(sentinelPath, { force: true });
				}
			});
			this.released = true;
		} catch (error) {
			this.renewal.lose(error);
		} finally {
			for (const directory of releasedDirectories) rmSync(directory, { recursive: true, force: true });
		}
	}
}

/**
 * The registry is durable authority state and must be global per user so
 * ownerConflicts sees every daemon on the box; it deliberately lives outside
 * $TMPDIR (whose files macOS dirhelper deletes after 3 days) and outside the
 * per-invocation agent dir.
 */
function defaultDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV] ?? join(homedir(), ".prime", "supervisor-owners");
}

/** Pre-move registry location. New builds guard, scan, and mirror it for one release. */
function legacyDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	return environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV]
		? undefined
		: resolve(defaultDaemonSocketDir(), "supervisor-owners");
}

function configuredRegistryDirs(primary?: string, legacyOverride?: string): string[] {
	const paths = [primary ?? defaultDaemonSupervisorRegistryDir()];
	const legacy = legacyOverride ?? (primary === undefined ? legacyDaemonSupervisorRegistryDir() : undefined);
	if (legacy) paths.push(legacy);
	return canonicalRegistryDirs(paths);
}

function canonicalRegistryDirs(paths: readonly string[]): string[] {
	const canonical = new Set<string>();
	for (const path of paths) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		canonical.add(canonicalizeFilesystemPath(path));
	}
	return [...canonical].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function publicationRegistryDirs(registryDirs: readonly string[], primaryRegistryDir: string): string[] {
	return [
		...registryDirs.filter((registryDir) => registryDir !== primaryRegistryDir),
		...registryDirs.filter((registryDir) => registryDir === primaryRegistryDir),
	];
}

function releaseRegistryDirs(registryDirs: readonly string[], primaryRegistryDir: string): string[] {
	return [
		...registryDirs.filter((registryDir) => registryDir === primaryRegistryDir),
		...registryDirs.filter((registryDir) => registryDir !== primaryRegistryDir),
	];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" && value !== null && "then" in value) ||
		(typeof value === "function" && "then" in value)
	);
}

/** Acquire canonical registry guards in one global order and release in reverse. */
export async function withRegistryGuards<T>(
	registryDirs: readonly string[],
	action: (guard: RegistryMutationGuard) => T,
	...invalidAsyncAction: T extends PromiseLike<unknown> ? [never] : []
): Promise<T> {
	void invalidAsyncAction;
	const directories = canonicalRegistryDirs(registryDirs);
	if (directories.length === 0) throw new Error("At least one registry guard is required");
	const identity = currentProcessIdentityFields();
	const held: HeldAuthorityMutationGuard[] = [];
	let active = true;
	const guard: RegistryMutationGuard = {
		assertCurrent(): void {
			if (!active) throw new Error("Registry guard is not active");
			for (const current of held) current.assertCurrent();
		},
	};
	let result: T | undefined;
	let failure: unknown;
	try {
		for (const registryDir of directories) {
			let current: HeldAuthorityMutationGuard | undefined;
			for (let attempt = 0; attempt <= REGISTRY_LOCK_RETRIES; attempt++) {
				try {
					current = acquireAuthorityMutationGuard({
						authorityPath: registryDir,
						lockfilePath: resolve(registryDir, ".guard"),
						attempts: 1,
						retryMs: REGISTRY_LOCK_RETRY_MS,
						identity,
						classifyOwner: (owner) =>
							classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead"
								? "exact-dead"
								: "retained",
						failureMessage: `Could not coordinate daemon supervisor registry: ${registryDir}`,
					});
					break;
				} catch (error) {
					if (!(error instanceof AuthorityGuardContentionError) || attempt === REGISTRY_LOCK_RETRIES) throw error;
					await delay(REGISTRY_LOCK_RETRY_MS);
				}
			}
			if (!current) throw new Error(`Could not coordinate daemon supervisor registry: ${registryDir}`);
			held.push(current);
			guard.assertCurrent();
		}
		result = action(guard);
		if (isPromiseLike(result)) throw new Error("Registry guard actions must be synchronous");
		guard.assertCurrent();
	} catch (error) {
		failure = error;
	} finally {
		active = false;
		for (const current of held.reverse()) {
			try {
				current.release();
			} catch (error) {
				failure ??= error;
			}
		}
	}
	if (failure) throw failure;
	return result as T;
}

async function mutateDaemonSupervisorOwner(
	expected: DaemonSupervisorOwnerRecord,
	mutation: (owner: DaemonSupervisorOwnerRecord) => void,
	registryDirs: readonly string[],
	primaryRegistryDir: string,
): Promise<DaemonSupervisorOwnerRecord> {
	return withRegistryGuards(registryDirs, (guard) => {
		requireOwnerCopies(registryDirs, expected);
		assertSelfOwnedAuthority(
			expected,
			() => new DaemonSupervisorOwnershipLostError(expected.generation, { socketPath: expected.socketPath }),
		);
		const next = { ...expected };
		mutation(next);
		next.updatedAt = new Date().toISOString();
		if (!isDaemonSupervisorOwnerRecord(next) || !sameOwnerAuthority(next, expected)) {
			throw new Error(`Invalid mutation for daemon supervisor owner ${expected.generation}`);
		}
		for (const registryDir of publicationRegistryDirs(registryDirs, primaryRegistryDir)) {
			const directory = ownerDirectoryPath(registryDir, expected.generation);
			const validateCurrent = () => {
				const current = readOwnerRecord(directory);
				if (!current || !sameOwnerAuthority(current, expected)) {
					throw new DaemonSupervisorOwnershipLostError(expected.generation, {
						socketPath: expected.socketPath,
						registryDir,
					});
				}
			};
			// Rewrite the scope too so a live legacy lexical record migrates to the
			// physical identity during its next guarded phase mutation.
			writeOwnerScope(directory, next, guard, validateCurrent);
			writeOwnerRecord(directory, next, guard, validateCurrent, registryDir !== primaryRegistryDir);
		}
		return next;
	});
}

export async function acquireDaemonSupervisorOwnership(
	options: AcquireDaemonSupervisorOwnershipOptions,
): Promise<DaemonSupervisorOwnership> {
	const registryDirs = configuredRegistryDirs(options.registryDir, options.legacyRegistryDir);
	const primaryRegistryDir = canonicalizeFilesystemPath(options.registryDir ?? defaultDaemonSupervisorRegistryDir());
	const token = randomUUID();
	const identity = currentProcessIdentityFields();
	if (!identity.processStartId || !isExactProcessStartId(identity.processStartId)) {
		throw Object.assign(new Error("Daemon supervisor launch requires an exact process identity capability"), {
			code: "daemon_supervisor_exact_identity_required" as const,
		});
	}
	const now = new Date().toISOString();
	const record = ownerDiskProjection(
		{
			version: OWNER_VERSION,
			role: "supervisor",
			token,
			generation: options.generation,
			pid: process.pid,
			...identity,
			...(registryDirs.length > 1 ? { mirrorRequired: true as const } : {}),
			socketPath: normalizeSocketPath(options.socketPath),
			descriptorDir: canonicalizeFilesystemPath(options.descriptorDir),
			agentDir: canonicalizeFilesystemPath(options.agentDir),
			appVersion: options.appVersion,
			phase: "starting",
			createdAt: now,
			updatedAt: now,
		},
		registryDirs.length > 1,
	);
	const requestedMaintenanceWait = options.offlineMaintenanceWaitMs ?? OFFLINE_MAINTENANCE_ACQUIRE_WAIT_MS;
	if (!Number.isFinite(requestedMaintenanceWait) || requestedMaintenanceWait < 0) {
		throw new Error("offlineMaintenanceWaitMs must be a non-negative finite number");
	}

	const candidates = registryDirs.map((registryDir) => {
		const candidate = resolve(registryDir, `.candidate-${process.pid}-${token}`);
		mkdirSync(candidate, { mode: 0o700 });
		writeOwnerScope(candidate, record);
		writeOwnerRecord(candidate, record, undefined, undefined, registryDir !== primaryRegistryDir);
		return { registryDir, candidate, target: ownerDirectoryPath(registryDir, record.generation) };
	});
	const publicationCandidates = publicationRegistryDirs(registryDirs, primaryRegistryDir).map(
		(registryDir) => candidates.find((candidate) => candidate.registryDir === registryDir)!,
	);
	const staleDirectories: string[] = [];
	const maintenanceDeadline = Date.now() + requestedMaintenanceWait;
	let published = false;
	try {
		while (true) {
			try {
				await withRegistryGuards(registryDirs, (guard) => {
					for (const registryDir of registryDirs) {
						const admission = readRetainedShutdownAdmission(registryDir, guard);
						if (admission && shutdownAdmissionConflictsWithScope(admission, record)) {
							if (isOfflineMaintenanceShutdownSentinel(admission)) {
								throw new DaemonOfflineMaintenanceError(admission);
							}
							throw new DaemonShutdownAdmissionError();
						}
						const maintenance = findConflictingRetainedOfflineMaintenance(registryDir, record, guard);
						if (maintenance) throw new DaemonOfflineMaintenanceError(maintenance);
						scanOwnerConflicts(registryDir, record, guard, staleDirectories);
					}
					for (const { target } of candidates) {
						if (existsSync(target)) {
							const current = readOwnerRecordForScope(target, () => true);
							if (current && isOfflineMaintenanceCompatibilityOwner(current)) {
								throw new DaemonOfflineMaintenanceError(current);
							}
							throw new DaemonSupervisorAlreadyRunningError(current ?? record);
						}
					}
					for (const { candidate, target } of publicationCandidates) {
						// Canonical absence and the uncompromised guard immediately precede publish.
						if (existsSync(target)) throw new DaemonSupervisorAlreadyRunningError(requireOwnerRecord(target));
						guard.assertCurrent();
						renameSync(candidate, target);
					}
					published = true;
				});
				break;
			} catch (error) {
				if (!(error instanceof DaemonOfflineMaintenanceError) || Date.now() >= maintenanceDeadline) throw error;
				await delay(OFFLINE_MAINTENANCE_ACQUIRE_POLL_MS);
			}
		}
	} finally {
		// Never claim success after a partial mirror. Any already-published copy
		// remains ordinary live authority and safely blocks a later contender.
		for (const { candidate } of candidates) rmSync(candidate, { recursive: true, force: true });
		for (const directory of staleDirectories) rmSync(directory, { recursive: true, force: true });
	}
	if (!published) throw new DaemonSupervisorOwnershipLostError(record.generation);
	return new DaemonSupervisorOwnership(record, registryDirs, primaryRegistryDir);
}

export async function acquireDaemonOfflineMaintenanceLease(
	scope: DaemonOfflineMaintenanceScope,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<DaemonOfflineMaintenanceLease | undefined> {
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	const primaryRegistryDir = canonicalizeFilesystemPath(registryDir ?? defaultDaemonSupervisorRegistryDir());
	const normalizedScope = normalizeOfflineMaintenanceScope(scope);
	const identity = currentProcessIdentityFields();
	const now = Date.now();
	const token = randomUUID();
	const record: DaemonOfflineMaintenanceRecord = {
		version: OWNER_VERSION,
		role: "offline-maintenance",
		token,
		pid: process.pid,
		...canonicalProcessIdentityProjection({ pid: process.pid, ...identity }),
		...(registryDirs.length > 1 ? { mirrorRequired: true as const } : {}),
		...normalizedScope,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		expiresAt: COMPATIBILITY_METADATA_EXPIRY,
		compatibilityOwnerGeneration: `offline-maintenance-${token}`,
	};
	const candidates = registryDirs.map((currentRegistryDir) => {
		const candidate = resolve(currentRegistryDir, `.candidate-maintenance-${process.pid}-${token}`);
		mkdirSync(candidate, { mode: 0o700 });
		const owner = offlineMaintenanceCompatibilityOwner(record);
		writeOwnerScope(candidate, owner);
		writeOwnerRecord(candidate, owner, undefined, undefined, currentRegistryDir !== primaryRegistryDir);
		return {
			registryDir: currentRegistryDir,
			candidate,
			target: ownerDirectoryPath(currentRegistryDir, record.compatibilityOwnerGeneration),
		};
	});
	const publicationCandidates = publicationRegistryDirs(registryDirs, primaryRegistryDir).map(
		(currentRegistryDir) => candidates.find((candidate) => candidate.registryDir === currentRegistryDir)!,
	);
	const staleDirectories: string[] = [];
	let acquired = false;
	try {
		await withRegistryGuards(registryDirs, (guard) => {
			for (const currentRegistryDir of registryDirs) {
				if (readRetainedShutdownAdmission(currentRegistryDir, guard)) return;
				if (hasConflictingRetainedOwner(currentRegistryDir, normalizedScope, guard, staleDirectories)) return;
				if (findConflictingRetainedOfflineMaintenance(currentRegistryDir, normalizedScope, guard)) return;
			}
			for (const { target } of candidates) {
				if (existsSync(target)) return;
			}
			for (const { registryDir: currentRegistryDir, candidate, target } of publicationCandidates) {
				if (existsSync(target)) return;
				guard.assertCurrent();
				renameSync(candidate, target);
				const directory = offlineMaintenanceDirectory(currentRegistryDir);
				guard.assertCurrent();
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const path = offlineMaintenancePath(directory, record.token);
				const copy: DaemonOfflineMaintenanceRecord = {
					...record,
					expiresAt: COMPATIBILITY_METADATA_EXPIRY,
				};
				writeJsonAtomically(path, copy, guard, () => {
					if (existsSync(path)) throw new DaemonOfflineMaintenanceError(record);
				});
				const sentinelPath = shutdownAdmissionPath(currentRegistryDir);
				const sentinel = offlineMaintenanceShutdownSentinel(copy);
				writeJsonAtomically(sentinelPath, sentinel, guard, () => {
					const currentMaintenance = readOfflineMaintenanceRecord(path);
					if (
						existsSync(sentinelPath) ||
						!currentMaintenance ||
						!sameOfflineMaintenanceRecord(currentMaintenance, copy)
					) {
						throw new DaemonOfflineMaintenanceError(record);
					}
				});
			}
			acquired = true;
		});
	} finally {
		for (const { candidate } of candidates) rmSync(candidate, { recursive: true, force: true });
		for (const directory of staleDirectories) rmSync(directory, { recursive: true, force: true });
	}
	return acquired ? new DaemonOfflineMaintenanceLease(record, registryDirs, undefined, primaryRegistryDir) : undefined;
}

export async function assertDaemonSupervisorOwnerCurrent(
	owner: {
		generation: string;
		pid: number;
		processStartId?: string;
		socketPath: string;
	},
	validatedFingerprint?: string,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<string> {
	void validatedFingerprint; // Fingerprints are diagnostics, never cached authorization.
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	try {
		return await withRegistryGuards(registryDirs, () => {
			const copies: DaemonSupervisorOwnerRecord[] = [];
			for (const currentRegistryDir of registryDirs) {
				const directory = ownerDirectoryPath(currentRegistryDir, owner.generation);
				if (!existsSync(directory)) continue;
				copies.push(requireOwnerRecord(directory));
			}
			const current = copies[0];
			const currentIdentity = current ? ownerProcessIdentity(current) : undefined;
			if (
				!current ||
				!currentIdentity ||
				copies.some((copy) => !sameOwnerRecord(copy, current)) ||
				(current.mirrorRequired === true && copies.length !== registryDirs.length) ||
				currentIdentity.pid !== owner.pid ||
				currentIdentity.processStartId !== owner.processStartId ||
				current.socketPath !== normalizeSocketPath(owner.socketPath) ||
				typeof currentIdentity.processStartId !== "string" ||
				!isExactProcessStartId(currentIdentity.processStartId) ||
				!matchesExactProcessIdentity(currentIdentity.pid, currentIdentity.processStartId)
			) {
				throw new DaemonSupervisorOwnershipLostError(owner.generation, {
					socketPath: owner.socketPath,
					registryDir: registryDirs.join(","),
				});
			}
			return ownerRecordFingerprint(current);
		});
	} catch (error) {
		if (error instanceof AuthorityGuardCompromisedError || error instanceof DaemonSupervisorOwnershipLostError) {
			throw error;
		}
		throw new DaemonSupervisorOwnershipLostError(owner.generation, {
			socketPath: owner.socketPath,
			registryDir: registryDirs.join(","),
		});
	}
}

export type DaemonSupervisorWorkerAuthenticationReceipt = string & {
	readonly __daemonSupervisorWorkerAuthenticationReceipt: unique symbol;
};

/**
 * Validate a legacy supervisor claim for worker authentication only.
 * The receipt is not process identity and must never authorize signal,
 * reclamation, or registry mutation.
 */
export async function assertDaemonSupervisorOwnerCurrentForWorkerAuthentication(
	claim: {
		supervisorGeneration: string;
		supervisorOwnerToken?: string;
		supervisorPid: number;
		supervisorProcessStartId: string;
		supervisorSocketPath: string;
	},
	validatedFingerprint?: string,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<DaemonSupervisorWorkerAuthenticationReceipt> {
	void validatedFingerprint;
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	try {
		return await withRegistryGuards(registryDirs, () => {
			const copies: DaemonSupervisorOwnerRecord[] = [];
			for (const currentRegistryDir of registryDirs) {
				const directory = ownerDirectoryPath(currentRegistryDir, claim.supervisorGeneration);
				if (existsSync(directory)) copies.push(requireOwnerRecord(directory));
			}
			const current = copies[0];
			const normalizedSocketPath = normalizeSocketPath(claim.supervisorSocketPath);
			const legacyProcessStartId = current ? daemonSupervisorOwnerCompatibilityProcessStartId(current) : undefined;
			if (
				!current ||
				copies.some((copy) => !sameOwnerRecord(copy, current)) ||
				(current.mirrorRequired === true && copies.length !== registryDirs.length) ||
				current.pid !== claim.supervisorPid ||
				current.socketPath !== normalizedSocketPath ||
				legacyProcessStartId !== claim.supervisorProcessStartId ||
				(claim.supervisorOwnerToken !== undefined && current.token !== claim.supervisorOwnerToken)
			) {
				throw new DaemonSupervisorOwnershipLostError(claim.supervisorGeneration, {
					socketPath: claim.supervisorSocketPath,
					registryDir: registryDirs.join(","),
				});
			}
			const beforeFingerprint = ownerRecordFingerprint(current);
			const observation = observeProcessIdentity(current.pid);
			const afterObservation = observeProcessIdentity(current.pid);
			const observationMatches =
				observation.status === "present-exact" &&
				afterObservation.status === "present-exact" &&
				afterObservation.id === observation.id &&
				(observation.id === claim.supervisorProcessStartId ||
					projectLegacyProcessStartId(observation.id) === claim.supervisorProcessStartId);
			const rereadCopies = registryDirs.flatMap((currentRegistryDir) => {
				const directory = ownerDirectoryPath(currentRegistryDir, claim.supervisorGeneration);
				return existsSync(directory) ? [requireOwnerRecord(directory)] : [];
			});
			const reread = rereadCopies[0];
			if (
				!observationMatches ||
				!reread ||
				rereadCopies.some((copy) => !sameOwnerRecord(copy, reread)) ||
				ownerRecordFingerprint(reread) !== beforeFingerprint
			) {
				throw new DaemonSupervisorOwnershipLostError(claim.supervisorGeneration, {
					socketPath: claim.supervisorSocketPath,
					registryDir: registryDirs.join(","),
				});
			}
			return beforeFingerprint as DaemonSupervisorWorkerAuthenticationReceipt;
		});
	} catch (error) {
		if (error instanceof AuthorityGuardCompromisedError || error instanceof DaemonSupervisorOwnershipLostError) {
			throw error;
		}
		throw new DaemonSupervisorOwnershipLostError(claim.supervisorGeneration, {
			socketPath: claim.supervisorSocketPath,
			registryDir: registryDirs.join(","),
		});
	}
}

export async function acquireDaemonShutdownAdmission(
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<DaemonShutdownAdmission> {
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	const primaryRegistryDir = canonicalizeFilesystemPath(registryDir ?? defaultDaemonSupervisorRegistryDir());
	const identity = currentProcessIdentityFields();
	while (true) {
		let acquired: DaemonShutdownAdmissionRecord | undefined;
		await withRegistryGuards(registryDirs, (guard) => {
			for (const currentRegistryDir of registryDirs) {
				if (
					readRetainedShutdownAdmission(currentRegistryDir, guard) ||
					hasRetainedOfflineMaintenance(currentRegistryDir, guard)
				) {
					return;
				}
			}
			const now = Date.now();
			const base: DaemonShutdownAdmissionRecord = {
				version: OWNER_VERSION,
				token: randomUUID(),
				pid: process.pid,
				...projectedAuthorityIdentity({ pid: process.pid, ...identity }),
				...(registryDirs.length > 1 ? { mirrorRequired: true as const } : {}),
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				expiresAt: COMPATIBILITY_METADATA_EXPIRY,
			};
			for (const currentRegistryDir of publicationRegistryDirs(registryDirs, primaryRegistryDir)) {
				const path = shutdownAdmissionPath(currentRegistryDir);
				const copy: DaemonShutdownAdmissionRecord = {
					...base,
					expiresAt: COMPATIBILITY_METADATA_EXPIRY,
				};
				writeJsonAtomically(path, copy, guard, () => {
					if (existsSync(path)) throw new DaemonShutdownAdmissionError();
				});
			}
			acquired = base;
		});
		if (acquired) return new DaemonShutdownAdmission(acquired, registryDirs, primaryRegistryDir);
		await delay(SHUTDOWN_ADMISSION_WAIT_MS);
	}
}

export async function isDaemonShutdownAdmissionActive(
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<boolean> {
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	return withRegistryGuards(registryDirs, (guard) =>
		registryDirs.some((currentRegistryDir) => readRetainedShutdownAdmission(currentRegistryDir, guard) !== undefined),
	);
}

function legacyOwnerIdentityMatchesForFence(owner: DaemonSupervisorOwnerRecord): boolean {
	const legacyStart = owner.processStartId;
	const legacyHint = owner.processIdentityHint;
	const before = observeProcessIdentity(owner.pid);
	let matches = false;
	if (before.status === "present-exact" && legacyStart) {
		matches = before.id === legacyStart || projectLegacyProcessStartId(before.id) === legacyStart;
	} else if (before.status === "present-coarse") {
		matches =
			legacyHint === before.hint ||
			(legacyStart !== undefined && getLegacyProcessStartId(owner.pid) === legacyStart);
	}
	const after = observeProcessIdentity(owner.pid);
	return (
		matches &&
		((before.status === "present-exact" && after.status === "present-exact" && before.id === after.id) ||
			(before.status === "present-coarse" && after.status === "present-coarse" && before.hint === after.hint))
	);
}

export async function persistDaemonStartupFenceFromOwner(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<void> {
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	const primaryRegistryDir = canonicalizeFilesystemPath(registryDir ?? defaultDaemonSupervisorRegistryDir());
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const helloIdentity = parseDaemonSupervisorHelloIdentity(hello);
	if (helloIdentity.status === "invalid") {
		throw new Error(`Daemon supervisor hello identity is invalid: ${helloIdentity.reason}`);
	}
	const fenceDirectories = registryDirs.map((currentRegistryDir) => {
		const directory = resolve(currentRegistryDir, "startup-fences");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		return directory;
	});
	const fencePaths = fenceDirectories.map((directory) => startupFencePath(directory, normalizedSocketPath));
	const publicationIndexes = publicationRegistryDirs(registryDirs, primaryRegistryDir).map((currentRegistryDir) =>
		registryDirs.indexOf(currentRegistryDir),
	);
	const staleDirectories: string[] = [];
	try {
		await withRegistryGuards(registryDirs, (guard) => {
			const retainedOwners: DaemonSupervisorOwnerRecord[] = [];
			for (const currentRegistryDir of registryDirs) {
				for (const directory of listOwnerDirectories(currentRegistryDir)) {
					const owner = readOwnerRecordForScope(directory, (scope) => scope.socketPath === normalizedSocketPath);
					if (!owner || owner.socketPath !== normalizedSocketPath) continue;
					if (ownerProcessAuthority(owner) === "exact-dead") {
						reclaimOwnerDirectory(directory, owner, guard, staleDirectories);
						continue;
					}
					retainedOwners.push(owner);
				}
			}
			for (const retained of retainedOwners) {
				if (
					retained.mirrorRequired === true &&
					retainedOwners.filter((candidate) => sameOwnerRecord(candidate, retained)).length !== registryDirs.length
				) {
					throw new Error(`Daemon supervisor owner mirror is incomplete for ${socketPath}`);
				}
			}
			const matchingOwners = dedupeOwnerCopies(retainedOwners);
			if (matchingOwners.length === 0) throw new Error(`Daemon supervisor owner does not match ${socketPath}`);
			if (matchingOwners.length > 1) throw new Error(`Multiple daemon supervisor owners match ${socketPath}`);
			const owner = matchingOwners[0]!;
			const ownerIdentity = ownerProcessIdentity(owner);
			const helloSocketPath = hello.supervisorSocketPath;
			let identityCurrent = false;
			if (typeof ownerIdentity.processStartId === "string" && isExactProcessStartId(ownerIdentity.processStartId)) {
				identityCurrent = matchesExactProcessIdentity(ownerIdentity.pid, ownerIdentity.processStartId);
			} else {
				// Fence-only compatibility: this overblocking artifact conveys no
				// signal/reclaim/mutation authority.
				identityCurrent = legacyOwnerIdentityMatchesForFence(owner);
			}
			if (
				!Number.isInteger(hello.supervisorPid) ||
				hello.supervisorPid !== owner.pid ||
				hello.supervisorGeneration !== owner.generation ||
				hello.supervisorOwnerToken !== owner.token ||
				typeof helloSocketPath !== "string" ||
				normalizeSocketPath(helloSocketPath) !== owner.socketPath ||
				(daemonSupervisorOwnerAuthorityProcessStartId(owner)
					? helloIdentity.status !== "exact" ||
						helloIdentity.authorityProcessStartId !== daemonSupervisorOwnerAuthorityProcessStartId(owner) ||
						helloIdentity.legacyProcessStartId !== daemonSupervisorOwnerLegacyProcessStartId(owner)
					: helloIdentity.status !== "legacy-only" ||
						helloIdentity.legacyProcessStartId !== owner.processStartId) ||
				!identityCurrent
			) {
				throw new Error(`Daemon supervisor hello does not match its durable owner for ${socketPath}`);
			}
			const record: DaemonStartupFenceRecord = {
				version: OWNER_VERSION,
				token: randomUUID(),
				ownerToken: owner.token,
				pid: owner.pid,
				...canonicalProcessIdentityProjection(ownerIdentity),
				...(registryDirs.length > 1 ? { mirrorRequired: true as const } : {}),
				socketPath: owner.socketPath,
				supervisorGeneration: owner.generation,
				createdAt: new Date().toISOString(),
			};
			const existing = fenceDirectories.map((directory) =>
				readStartupFenceEvidence(directory, normalizedSocketPath),
			);
			for (const copies of existing) {
				const first = copies[0]?.record;
				if (first && copies.some((copy) => !sameStartupFence(copy.record, first))) {
					throw new Error(`Daemon startup fence aliases do not match ${socketPath}`);
				}
			}
			const tempPaths = fencePaths.map((path) => `${path}.${process.pid}.${randomUUID()}.tmp`);
			try {
				for (const tempPath of tempPaths) {
					writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
				}
				for (let index = 0; index < fenceDirectories.length; index++) {
					const current = readStartupFenceEvidence(fenceDirectories[index]!, normalizedSocketPath);
					if (!sameStartupFenceEvidence(current, existing[index]!)) {
						throw new Error(`Daemon startup fence changed for ${socketPath}`);
					}
				}
				const currentOwnerCopies = registryDirs.flatMap((currentRegistryDir) => {
					const directory = ownerDirectoryPath(currentRegistryDir, owner.generation);
					if (!existsSync(directory)) return [];
					return [requireOwnerRecord(directory)];
				});
				if (
					currentOwnerCopies.length === 0 ||
					currentOwnerCopies.some((currentOwner) => !sameOwnerRecord(currentOwner, owner)) ||
					(owner.mirrorRequired === true && currentOwnerCopies.length !== registryDirs.length)
				) {
					throw new Error(`Daemon supervisor owner changed for ${socketPath}`);
				}
				for (const index of publicationIndexes) {
					guard.assertCurrent();
					renameSync(tempPaths[index]!, fencePaths[index]!);
					for (const legacy of existing[index]!) {
						if (legacy.path === fencePaths[index]) continue;
						const immediate = readStartupFence(legacy.path);
						if (!immediate || !sameStartupFence(immediate, legacy.record)) {
							throw new Error(`Daemon startup fence alias changed for ${socketPath}`);
						}
						guard.assertCurrent();
						rmSync(legacy.path, { force: true });
					}
				}
			} finally {
				for (const tempPath of tempPaths) rmSync(tempPath, { force: true });
			}
		});
	} finally {
		for (const directory of staleDirectories) rmSync(directory, { recursive: true, force: true });
	}
}

export async function waitForDaemonStartupFence(
	socketPath: string,
	timeoutMs = 10_000,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<void> {
	const registryDirs = configuredRegistryDirs(registryDir, legacyRegistryDir);
	const primaryRegistryDir = canonicalizeFilesystemPath(registryDir ?? defaultDaemonSupervisorRegistryDir());
	const fenceDirectories = registryDirs.map((currentRegistryDir) => resolve(currentRegistryDir, "startup-fences"));
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const observed = fenceDirectories.map((directory) => readStartupFenceEvidence(directory, normalizedSocketPath));
		const present = observed.flatMap((copies) => copies.map((copy) => copy.record));
		if (present.length === 0) return;
		const fence = present[0]!;
		if (
			present.some((record) => record.socketPath !== normalizedSocketPath) ||
			present.some((record) => !sameStartupFence(record, fence))
		) {
			throw new Error(`Daemon startup fence copies do not match ${socketPath}`);
		}
		if (
			fence.mirrorRequired === true &&
			observed.filter((copies) => copies.length > 0).length !== registryDirs.length
		) {
			throw new Error(`Daemon startup fence mirror is incomplete for ${socketPath}`);
		}
		if (present.every((record) => startupFenceAuthority(record) === "exact-dead")) {
			const cleared = await withRegistryGuards(registryDirs, (guard) => {
				const current = fenceDirectories.map((directory) =>
					readStartupFenceEvidence(directory, normalizedSocketPath),
				);
				if (current.some((copies, index) => !sameStartupFenceEvidence(copies, observed[index]!))) return false;
				const currentRecords = current.flatMap((copies) => copies.map((copy) => copy.record));
				if (
					currentRecords.some((record) => startupFenceAuthority(record) !== "exact-dead") ||
					(fence.mirrorRequired === true &&
						current.filter((copies) => copies.length > 0).length !== registryDirs.length)
				) {
					return false;
				}
				for (const currentRegistryDir of releaseRegistryDirs(registryDirs, primaryRegistryDir)) {
					const index = registryDirs.indexOf(currentRegistryDir);
					for (const evidence of current[index]!) {
						const immediate = readStartupFence(evidence.path);
						if (!immediate || !sameStartupFence(immediate, evidence.record)) return false;
						guard.assertCurrent();
						rmSync(evidence.path, { force: true });
					}
				}
				return true;
			});
			if (cleared) return;
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for predecessor daemon process ${fence.pid} to exit`);
		}
		await delay(STARTUP_FENCE_POLL_MS);
	}
}

function processAuthority(identity: ProcessIdentity): ProcessIdentityAuthority {
	return classifyProcessIdentityAuthority(identity.pid, identity.processStartId);
}

function authorityExtendedProcessIdentity(
	record: ProcessIdentity & { authorityProcessStartId?: string; authorityProcessIdentityHint?: string },
): ProcessIdentity {
	const hasAuthorityExtension =
		typeof record.authorityProcessStartId === "string" || typeof record.authorityProcessIdentityHint === "string";
	if (hasAuthorityExtension) {
		return {
			pid: record.pid,
			...(record.authorityProcessStartId ? { processStartId: record.authorityProcessStartId } : {}),
			...(record.authorityProcessIdentityHint ? { processIdentityHint: record.authorityProcessIdentityHint } : {}),
		};
	}
	return {
		pid: record.pid,
		...(record.processStartId ? { processStartId: record.processStartId } : {}),
		...(record.processIdentityHint ? { processIdentityHint: record.processIdentityHint } : {}),
	};
}

function processIdentityNamespacesAreValid(record: {
	processStartId?: unknown;
	processIdentityHint?: unknown;
	authorityProcessStartId?: unknown;
	authorityProcessIdentityHint?: unknown;
}): boolean {
	const legacyStart = record.processStartId;
	const legacyHint = record.processIdentityHint;
	const authorityStart = record.authorityProcessStartId;
	const authorityHint = record.authorityProcessIdentityHint;
	if (legacyStart !== undefined && typeof legacyStart !== "string") return false;
	if (
		legacyHint !== undefined &&
		(typeof legacyHint !== "string" || normalizePortableProcessIdentityHint(legacyHint) !== legacyHint)
	)
		return false;
	if (authorityStart !== undefined && typeof authorityStart !== "string") return false;
	if (
		authorityHint !== undefined &&
		(typeof authorityHint !== "string" || normalizePortableProcessIdentityHint(authorityHint) !== authorityHint)
	)
		return false;
	if (legacyStart !== undefined && legacyHint !== undefined) return false;
	if (authorityStart !== undefined && authorityHint !== undefined) return false;
	if (authorityStart !== undefined) {
		if (!isExactProcessStartId(authorityStart)) return false;
		if (legacyHint !== undefined) return false;
		const projection = projectLegacyProcessStartId(authorityStart);
		return legacyStart === undefined || (projection !== undefined && legacyStart === projection);
	}
	if (authorityHint !== undefined) {
		return legacyStart === undefined && (legacyHint === undefined || legacyHint === authorityHint);
	}
	return true;
}

function shutdownAdmissionIdentity(record: DaemonShutdownAdmissionRecord): ProcessIdentity {
	return authorityExtendedProcessIdentity(record);
}

function shutdownAdmissionAuthority(record: DaemonShutdownAdmissionRecord): ProcessIdentityAuthority {
	return processAuthority(shutdownAdmissionIdentity(record));
}

function startupFenceIdentity(record: DaemonStartupFenceRecord): ProcessIdentity {
	return authorityExtendedProcessIdentity(record);
}

function startupFenceAuthority(record: DaemonStartupFenceRecord): ProcessIdentityAuthority {
	return processAuthority(startupFenceIdentity(record));
}

function canonicalProcessIdentityProjection(
	identity: ProcessIdentity,
): Pick<
	DaemonSupervisorOwnerRecord,
	"processStartId" | "processIdentityHint" | "authorityProcessStartId" | "authorityProcessIdentityHint"
> {
	if (identity.processStartId && isExactProcessStartId(identity.processStartId)) {
		const legacyProcessStartId = projectLegacyProcessStartId(identity.processStartId);
		return {
			...(legacyProcessStartId ? { processStartId: legacyProcessStartId } : {}),
			authorityProcessStartId: identity.processStartId,
		};
	}
	if (identity.processStartId) return { processStartId: identity.processStartId };
	if (identity.processIdentityHint) {
		return {
			processIdentityHint: identity.processIdentityHint,
			authorityProcessIdentityHint: identity.processIdentityHint,
		};
	}
	return {};
}

function projectedAuthorityIdentity(
	identity: ProcessIdentity,
): Pick<DaemonShutdownAdmissionRecord, "authorityProcessStartId" | "authorityProcessIdentityHint"> {
	return {
		...(identity.processStartId && isExactProcessStartId(identity.processStartId)
			? { authorityProcessStartId: identity.processStartId }
			: {}),
		...(identity.processIdentityHint ? { authorityProcessIdentityHint: identity.processIdentityHint } : {}),
	};
}

function currentProcessIdentityFields(): Pick<ProcessIdentity, "processStartId" | "processIdentityHint"> {
	const observation = observeProcessIdentity(process.pid);
	if (observation.status === "present-exact") return { processStartId: observation.id };
	if (observation.status === "present-coarse") return { processIdentityHint: observation.hint };
	throw new Error(`Cannot establish current process identity (${observation.status})`);
}

function assertSelfOwnedAuthority(identity: ProcessIdentity, createError: () => Error): void {
	identity = authorityExtendedProcessIdentity(identity);
	if (identity.pid !== process.pid) throw createError();
	if (typeof identity.processStartId === "string") {
		if (!isExactProcessStartId(identity.processStartId)) throw createError();
		if (!matchesExactProcessIdentity(identity.pid, identity.processStartId)) throw createError();
		return;
	}
	// A coarse macOS record cannot be exact-matched. The holder may still
	// operate it because the guarded canonical token was checked and this PID is
	// the current process. Contenders never use this self-only authorization.
	if (typeof identity.processIdentityHint === "string") {
		const observation = observeProcessIdentity(identity.pid);
		if (observation.status === "present-coarse" || observation.status === "present-exact") return;
	}
	throw createError();
}

function canonicalizeFilesystemPath(path: string): string {
	return normalizePhysicalFilesystemPath(path);
}

function normalizeStoredSocketPath(path: string): string {
	if (process.platform !== "win32" && !isAbsolute(path)) {
		throw new Error(`Stored daemon socket path is not absolute: ${path}`);
	}
	return normalizeSocketPath(path);
}

function normalizeStoredFilesystemPath(path: string): string {
	if (!isAbsolute(path)) throw new Error(`Stored daemon filesystem path is not absolute: ${path}`);
	return canonicalizeFilesystemPath(path);
}

function normalizeOwnerRecord(record: DaemonSupervisorOwnerRecord): DaemonSupervisorOwnerRecord {
	return {
		...record,
		socketPath: normalizeStoredSocketPath(record.socketPath),
		descriptorDir: normalizeStoredFilesystemPath(record.descriptorDir),
		agentDir: normalizeStoredFilesystemPath(record.agentDir),
	};
}

function normalizeOwnerScope(scope: DaemonSupervisorOwnerScope): DaemonSupervisorOwnerScope {
	return {
		...scope,
		socketPath: normalizeStoredSocketPath(scope.socketPath),
		descriptorDir: normalizeStoredFilesystemPath(scope.descriptorDir),
	};
}

function normalizeOfflineMaintenanceRecord(record: DaemonOfflineMaintenanceRecord): DaemonOfflineMaintenanceRecord {
	return {
		...record,
		socketPath: normalizeStoredSocketPath(record.socketPath),
		descriptorDir: normalizeStoredFilesystemPath(record.descriptorDir),
	};
}

function normalizeStartupFence(record: DaemonStartupFenceRecord): DaemonStartupFenceRecord {
	return { ...record, socketPath: normalizeStoredSocketPath(record.socketPath) };
}

function normalizeShutdownAdmission(record: DaemonShutdownAdmissionRecord): DaemonShutdownAdmissionRecord {
	if (!isOfflineMaintenanceShutdownSentinel(record)) return record;
	return {
		...record,
		socketPath: normalizeStoredSocketPath(record.socketPath),
		descriptorDir: normalizeStoredFilesystemPath(record.descriptorDir),
	};
}

function normalizeOfflineMaintenanceScope(scope: DaemonOfflineMaintenanceScope): DaemonOfflineMaintenanceScope {
	return {
		socketPath: normalizeSocketPath(scope.socketPath),
		descriptorDir: canonicalizeFilesystemPath(scope.descriptorDir),
	};
}

function offlineMaintenanceConflicts(
	left: DaemonOfflineMaintenanceScope,
	right: DaemonOfflineMaintenanceScope,
): boolean {
	return left.socketPath === right.socketPath || left.descriptorDir === right.descriptorDir;
}

function ownerConflicts(left: DaemonSupervisorOwnerScope, right: DaemonSupervisorOwnerScope): boolean {
	return offlineMaintenanceConflicts(left, right);
}

function offlineMaintenanceCompatibilityOwner(record: DaemonOfflineMaintenanceRecord): DaemonSupervisorOwnerRecord {
	return {
		version: OWNER_VERSION,
		role: "supervisor",
		token: record.token,
		generation: record.compatibilityOwnerGeneration,
		pid: record.pid,
		...canonicalProcessIdentityProjection(authorityExtendedProcessIdentity(record)),
		...(record.mirrorRequired ? { mirrorRequired: true as const } : {}),
		socketPath: record.socketPath,
		descriptorDir: record.descriptorDir,
		agentDir: record.descriptorDir,
		appVersion: "offline-maintenance",
		phase: "owner",
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		// Old scanners treat this as an ordinary non-expiring supervisor owner.
		purpose: "offline-maintenance",
	};
}

function isOfflineMaintenanceCompatibilityOwner(record: DaemonSupervisorOwnerRecord): boolean {
	return record.purpose === "offline-maintenance" && record.appVersion === "offline-maintenance";
}

function offlineMaintenanceShutdownSentinel(record: DaemonOfflineMaintenanceRecord): DaemonShutdownAdmissionRecord {
	return {
		version: OWNER_VERSION,
		token: record.token,
		pid: record.pid,
		...canonicalProcessIdentityProjection(authorityExtendedProcessIdentity(record)),
		...(record.mirrorRequired ? { mirrorRequired: true as const } : {}),
		purpose: "offline-maintenance",
		socketPath: record.socketPath,
		descriptorDir: record.descriptorDir,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		expiresAt: COMPATIBILITY_METADATA_EXPIRY,
	};
}

function isOfflineMaintenanceShutdownSentinel(
	record: DaemonShutdownAdmissionRecord,
): record is DaemonShutdownAdmissionRecord & DaemonOfflineMaintenanceScope & { purpose: "offline-maintenance" } {
	return (
		record.purpose === "offline-maintenance" &&
		typeof record.socketPath === "string" &&
		typeof record.descriptorDir === "string"
	);
}

function shutdownAdmissionConflictsWithScope(
	record: DaemonShutdownAdmissionRecord,
	scope: DaemonOfflineMaintenanceScope,
): boolean {
	return !isOfflineMaintenanceShutdownSentinel(record) || offlineMaintenanceConflicts(record, scope);
}

function offlineMaintenanceDirectory(registryDir: string): string {
	return resolve(registryDir, OFFLINE_MAINTENANCE_DIRECTORY_NAME);
}

function offlineMaintenancePath(directory: string, token: string): string {
	return resolve(directory, `${token}.json`);
}

function reclaimOwnerDirectory(
	directory: string,
	expected: DaemonSupervisorOwnerRecord,
	guard: RegistryMutationGuard,
	staleDirectories: string[],
): boolean {
	const current = readOwnerRecord(directory);
	if (!current || !sameOwnerRecord(current, expected) || ownerProcessAuthority(current) !== "exact-dead") return false;
	const immediate = readOwnerRecord(directory);
	if (!immediate || !sameOwnerRecord(immediate, current)) return false;
	const staleDirectory = `${directory}.stale-${randomUUID()}`;
	guard.assertCurrent();
	renameSync(directory, staleDirectory);
	staleDirectories.push(staleDirectory);
	return true;
}

function scanOwnerConflicts(
	registryDir: string,
	scope: DaemonSupervisorOwnerScope,
	guard: RegistryMutationGuard,
	staleDirectories: string[],
): void {
	for (const directory of listOwnerDirectories(registryDir)) {
		const owner = readOwnerRecordForScope(directory, (candidate) => ownerConflicts(candidate, scope));
		if (!owner || !ownerConflicts(owner, scope)) continue;
		if (ownerProcessAuthority(owner) === "exact-dead") {
			if (!reclaimOwnerDirectory(directory, owner, guard, staleDirectories)) {
				throw new DaemonSupervisorAlreadyRunningError(owner);
			}
			continue;
		}
		if (isOfflineMaintenanceCompatibilityOwner(owner)) throw new DaemonOfflineMaintenanceError(owner);
		throw new DaemonSupervisorAlreadyRunningError(owner);
	}
}

function hasConflictingRetainedOwner(
	registryDir: string,
	scope: DaemonOfflineMaintenanceScope,
	guard: RegistryMutationGuard,
	staleDirectories: string[],
): boolean {
	for (const directory of listOwnerDirectories(registryDir)) {
		const owner = readOwnerRecordForScope(directory, (candidate) => offlineMaintenanceConflicts(candidate, scope));
		if (!owner || !offlineMaintenanceConflicts(owner, scope)) continue;
		if (ownerProcessAuthority(owner) === "exact-dead") {
			if (!reclaimOwnerDirectory(directory, owner, guard, staleDirectories)) return true;
			continue;
		}
		return true;
	}
	return false;
}

function removeExactDeadOfflineMaintenance(
	path: string,
	expected: DaemonOfflineMaintenanceRecord,
	guard: RegistryMutationGuard,
): boolean {
	const current = readOfflineMaintenanceRecord(path);
	if (!current || !sameOfflineMaintenanceRecord(current, expected) || processAuthority(current) !== "exact-dead") {
		return false;
	}
	const immediate = readOfflineMaintenanceRecord(path);
	if (!immediate || !sameOfflineMaintenanceRecord(immediate, current)) return false;
	guard.assertCurrent();
	rmSync(path, { force: true });
	return true;
}

function findConflictingRetainedOfflineMaintenance(
	registryDir: string,
	scope: DaemonOfflineMaintenanceScope,
	guard: RegistryMutationGuard,
): DaemonOfflineMaintenanceRecord | undefined {
	const directory = offlineMaintenanceDirectory(registryDir);
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const path = resolve(directory, entry);
		const record = readOfflineMaintenanceRecord(path);
		if (!record) throw new Error(`Invalid daemon offline maintenance record: ${path}`);
		if (processAuthority(authorityExtendedProcessIdentity(record)) === "exact-dead") {
			if (!removeExactDeadOfflineMaintenance(path, record, guard)) {
				throw new Error(`Daemon offline maintenance authority changed: ${path}`);
			}
			continue;
		}
		if (offlineMaintenanceConflicts(record, scope)) return record;
	}
	return undefined;
}

function hasRetainedOfflineMaintenance(registryDir: string, guard: RegistryMutationGuard): boolean {
	const directory = offlineMaintenanceDirectory(registryDir);
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
		else throw error;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const path = resolve(directory, entry);
		const record = readOfflineMaintenanceRecord(path);
		if (!record) throw new Error(`Invalid daemon offline maintenance record: ${path}`);
		if (processAuthority(authorityExtendedProcessIdentity(record)) === "exact-dead") {
			if (!removeExactDeadOfflineMaintenance(path, record, guard)) return true;
			continue;
		}
		return true;
	}
	for (const ownerDirectory of listOwnerDirectories(registryDir)) {
		const owner = readOwnerRecordForScope(ownerDirectory, () => true);
		if (!owner || !isOfflineMaintenanceCompatibilityOwner(owner)) continue;
		if (ownerProcessAuthority(owner) !== "exact-dead") return true;
	}
	return false;
}

function dedupeOwnerCopies(records: readonly DaemonSupervisorOwnerRecord[]): DaemonSupervisorOwnerRecord[] {
	const result: DaemonSupervisorOwnerRecord[] = [];
	for (const record of records) {
		if (!result.some((existing) => sameOwnerRecord(existing, record))) result.push(record);
	}
	return result;
}

function readOfflineMaintenanceRecord(path: string): DaemonOfflineMaintenanceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") return undefined;
		const record = value as Partial<DaemonOfflineMaintenanceRecord>;
		if (
			record.version !== OWNER_VERSION ||
			record.role !== "offline-maintenance" ||
			typeof record.token !== "string" ||
			record.token.length === 0 ||
			!Number.isInteger(record.pid) ||
			(record.pid ?? 0) <= 0 ||
			(record.processStartId !== undefined && typeof record.processStartId !== "string") ||
			(record.processIdentityHint !== undefined && typeof record.processIdentityHint !== "string") ||
			(record.authorityProcessStartId !== undefined && typeof record.authorityProcessStartId !== "string") ||
			(record.authorityProcessIdentityHint !== undefined &&
				typeof record.authorityProcessIdentityHint !== "string") ||
			!processIdentityNamespacesAreValid(record) ||
			(record.mirrorRequired !== undefined && record.mirrorRequired !== true) ||
			typeof record.socketPath !== "string" ||
			typeof record.descriptorDir !== "string" ||
			typeof record.createdAt !== "string" ||
			typeof record.updatedAt !== "string" ||
			typeof record.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(record.expiresAt)) ||
			typeof record.compatibilityOwnerGeneration !== "string" ||
			!/^[A-Za-z0-9._-]+$/.test(record.compatibilityOwnerGeneration)
		) {
			return undefined;
		}
		return normalizeOfflineMaintenanceRecord(record as DaemonOfflineMaintenanceRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

function ownerProcessIdentity(record: DaemonSupervisorOwnerRecord): ProcessIdentity {
	return authorityExtendedProcessIdentity(record);
}

export function daemonSupervisorOwnerAuthorityProcessStartId(record: DaemonSupervisorOwnerRecord): string | undefined {
	const processStartId = ownerProcessIdentity(record).processStartId;
	return processStartId && isExactProcessStartId(processStartId) ? processStartId : undefined;
}

export function daemonSupervisorOwnerLegacyProcessStartId(record: DaemonSupervisorOwnerRecord): string | undefined {
	const authority = daemonSupervisorOwnerAuthorityProcessStartId(record);
	if (!authority) return undefined;
	const projection = projectLegacyProcessStartId(authority);
	// Signal-bearing legacy hello/auth fields may carry only a byte-identical
	// exact identity (currently Windows). Linux/token must be omitted.
	return projection === authority ? projection : undefined;
}

export function daemonSupervisorOwnerCompatibilityProcessStartId(
	record: DaemonSupervisorOwnerRecord,
): string | undefined {
	const authority = daemonSupervisorOwnerAuthorityProcessStartId(record);
	return authority ? projectLegacyProcessStartId(authority) : record.processStartId;
}

function ownerProcessAuthority(record: DaemonSupervisorOwnerRecord): ProcessIdentityAuthority {
	return processAuthority(ownerProcessIdentity(record));
}

function ownerDiskProjection(record: DaemonSupervisorOwnerRecord, legacySafe: boolean): DaemonSupervisorOwnerRecord {
	void legacySafe;
	const {
		processStartId: _processStartId,
		processIdentityHint: _processIdentityHint,
		authorityProcessStartId: _authorityProcessStartId,
		authorityProcessIdentityHint: _authorityProcessIdentityHint,
		...rest
	} = record;
	return {
		...rest,
		...canonicalProcessIdentityProjection(ownerProcessIdentity(record)),
	};
}

function sameOwnerAuthority(left: DaemonSupervisorOwnerRecord, right: DaemonSupervisorOwnerRecord): boolean {
	const leftIdentity = ownerProcessIdentity(left);
	const rightIdentity = ownerProcessIdentity(right);
	return (
		left.version === right.version &&
		left.role === right.role &&
		left.token === right.token &&
		left.generation === right.generation &&
		leftIdentity.pid === rightIdentity.pid &&
		leftIdentity.processStartId === rightIdentity.processStartId &&
		leftIdentity.processIdentityHint === rightIdentity.processIdentityHint &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.authorityProcessStartId === right.authorityProcessStartId &&
		left.authorityProcessIdentityHint === right.authorityProcessIdentityHint &&
		left.mirrorRequired === right.mirrorRequired &&
		left.socketPath === right.socketPath &&
		left.descriptorDir === right.descriptorDir &&
		left.agentDir === right.agentDir &&
		left.appVersion === right.appVersion &&
		left.createdAt === right.createdAt &&
		left.purpose === right.purpose
	);
}

function sameOwnerRecord(left: DaemonSupervisorOwnerRecord, right: DaemonSupervisorOwnerRecord): boolean {
	return (
		sameOwnerAuthority(left, right) &&
		left.phase === right.phase &&
		left.updatedAt === right.updatedAt &&
		left.offlineMaintenanceExpiresAt === right.offlineMaintenanceExpiresAt
	);
}

function sameOfflineMaintenanceAuthority(
	left: DaemonOfflineMaintenanceRecord,
	right: DaemonOfflineMaintenanceRecord,
): boolean {
	return (
		left.version === right.version &&
		left.role === right.role &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.authorityProcessStartId === right.authorityProcessStartId &&
		left.authorityProcessIdentityHint === right.authorityProcessIdentityHint &&
		left.mirrorRequired === right.mirrorRequired &&
		left.socketPath === right.socketPath &&
		left.descriptorDir === right.descriptorDir &&
		left.createdAt === right.createdAt &&
		left.compatibilityOwnerGeneration === right.compatibilityOwnerGeneration
	);
}

function sameOfflineMaintenanceRecord(
	left: DaemonOfflineMaintenanceRecord,
	right: DaemonOfflineMaintenanceRecord,
): boolean {
	return (
		sameOfflineMaintenanceAuthority(left, right) &&
		left.updatedAt === right.updatedAt &&
		left.expiresAt === right.expiresAt
	);
}

function sameShutdownAdmissionAuthority(
	left: DaemonShutdownAdmissionRecord,
	right: DaemonShutdownAdmissionRecord,
): boolean {
	return (
		left.version === right.version &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.authorityProcessStartId === right.authorityProcessStartId &&
		left.authorityProcessIdentityHint === right.authorityProcessIdentityHint &&
		left.mirrorRequired === right.mirrorRequired &&
		left.purpose === right.purpose &&
		left.socketPath === right.socketPath &&
		left.descriptorDir === right.descriptorDir &&
		left.createdAt === right.createdAt
	);
}

function sameShutdownAdmissionRecord(
	left: DaemonShutdownAdmissionRecord,
	right: DaemonShutdownAdmissionRecord,
): boolean {
	return (
		sameShutdownAdmissionAuthority(left, right) &&
		left.updatedAt === right.updatedAt &&
		left.expiresAt === right.expiresAt
	);
}

function requireOwnerCopies(
	registryDirs: readonly string[],
	expected: DaemonSupervisorOwnerRecord,
): DaemonSupervisorOwnerRecord[] {
	const copies = registryDirs.map((registryDir) =>
		requireOwnerRecord(ownerDirectoryPath(registryDir, expected.generation)),
	);
	if (copies.some((copy) => !sameOwnerRecord(copy, expected))) {
		throw new DaemonSupervisorOwnershipLostError(expected.generation, { socketPath: expected.socketPath });
	}
	return copies;
}

function requireShutdownAdmissionCopies(
	registryDirs: readonly string[],
	expected: DaemonShutdownAdmissionRecord,
): DaemonShutdownAdmissionRecord[] {
	const copies = registryDirs.map((registryDir) => readShutdownAdmission(shutdownAdmissionPath(registryDir)));
	if (
		copies.some(
			(copy) => !copy || !sameShutdownAdmissionAuthority(copy, expected) || copy.updatedAt !== expected.updatedAt,
		)
	) {
		throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
	}
	return copies as DaemonShutdownAdmissionRecord[];
}

function requireOfflineMaintenanceCopies(
	registryDirs: readonly string[],
	expected: DaemonOfflineMaintenanceRecord,
): DaemonOfflineMaintenanceRecord[] {
	const expectedOwner = offlineMaintenanceCompatibilityOwner(expected);
	const expectedSentinel = offlineMaintenanceShutdownSentinel(expected);
	const copies = registryDirs.map((registryDir) => {
		const path = offlineMaintenancePath(offlineMaintenanceDirectory(registryDir), expected.token);
		const record = readOfflineMaintenanceRecord(path);
		const owner = readOwnerRecord(ownerDirectoryPath(registryDir, expected.compatibilityOwnerGeneration));
		const sentinel = readShutdownAdmission(shutdownAdmissionPath(registryDir));
		if (
			!record ||
			!owner ||
			!sentinel ||
			!sameOfflineMaintenanceAuthority(record, expected) ||
			record.updatedAt !== expected.updatedAt ||
			!sameOwnerRecord(owner, expectedOwner) ||
			!sameShutdownAdmissionRecord(sentinel, expectedSentinel)
		) {
			throw new DaemonOfflineMaintenanceError(expected);
		}
		return record;
	});
	return copies;
}

function ownerRecordFingerprint(record: DaemonSupervisorOwnerRecord): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function listOwnerDirectories(registryDir: string): string[] {
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => resolve(registryDir, name));
}

function ownerDirectoryPath(registryDir: string, generation: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) {
		throw new Error(`Invalid daemon supervisor generation: ${generation}`);
	}
	return resolve(registryDir, `${generation}.owner`);
}

function requireOwnerRecord(directory: string): DaemonSupervisorOwnerRecord {
	const owner = readOwnerRecord(directory);
	if (!owner) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return owner;
}

function readOwnerRecordForScope(
	directory: string,
	isRelevant: (scope: DaemonSupervisorOwnerScope) => boolean,
): DaemonSupervisorOwnerRecord | undefined {
	const owner = readOwnerRecordFile(directory);
	const scope = readOwnerScope(directory);
	if (owner && scope && sameOwnerScope(owner, scope)) return owner;
	// Missing/malformed or split owner/scope authority is never absence. Valid
	// unrelated evidence may stay available, but either relevant view blocks.
	if (!owner || !scope || isRelevant(owner) || isRelevant(scope)) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return undefined;
}

function readOwnerRecordFile(directory: string): DaemonSupervisorOwnerRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "owner.json"), "utf8")) as unknown;
		if (!isDaemonSupervisorOwnerRecord(value)) return undefined;
		return ownerDirectoryPath(dirname(directory), value.generation) === directory
			? normalizeOwnerRecord(value)
			: undefined;
	} catch {
		return undefined;
	}
}

function readOwnerRecord(directory: string): DaemonSupervisorOwnerRecord | undefined {
	const owner = readOwnerRecordFile(directory);
	const scope = readOwnerScope(directory);
	return owner && scope && sameOwnerScope(owner, scope) ? owner : undefined;
}

function sameOwnerScope(owner: DaemonSupervisorOwnerRecord, scope: DaemonSupervisorOwnerScope): boolean {
	return (
		owner.version === scope.version &&
		owner.role === scope.role &&
		owner.token === scope.token &&
		owner.generation === scope.generation &&
		owner.socketPath === scope.socketPath &&
		owner.descriptorDir === scope.descriptorDir
	);
}

function ownerCompatibilityProjectionIsBound(record: Partial<DaemonSupervisorOwnerRecord>): boolean {
	return processIdentityNamespacesAreValid(record);
}

function isDaemonSupervisorOwnerRecord(value: unknown): value is DaemonSupervisorOwnerRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Partial<DaemonSupervisorOwnerRecord>;
	return (
		record.version === OWNER_VERSION &&
		record.role === "supervisor" &&
		typeof record.token === "string" &&
		typeof record.generation === "string" &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		(record.processStartId === undefined || typeof record.processStartId === "string") &&
		(record.processIdentityHint === undefined || typeof record.processIdentityHint === "string") &&
		(record.authorityProcessStartId === undefined || typeof record.authorityProcessStartId === "string") &&
		(record.authorityProcessIdentityHint === undefined || typeof record.authorityProcessIdentityHint === "string") &&
		(record.mirrorRequired === undefined || record.mirrorRequired === true) &&
		typeof record.socketPath === "string" &&
		typeof record.descriptorDir === "string" &&
		typeof record.agentDir === "string" &&
		typeof record.appVersion === "string" &&
		(record.phase === "starting" || record.phase === "owner" || record.phase === "stopping") &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string" &&
		(record.purpose === undefined || record.purpose === "offline-maintenance") &&
		(record.offlineMaintenanceExpiresAt === undefined ||
			(typeof record.offlineMaintenanceExpiresAt === "string" &&
				Number.isFinite(Date.parse(record.offlineMaintenanceExpiresAt)))) &&
		ownerCompatibilityProjectionIsBound(record)
	);
}

function readOwnerScope(directory: string): DaemonSupervisorOwnerScope | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "scope.json"), "utf8")) as unknown;
		if (!isDaemonSupervisorOwnerScope(value)) {
			return undefined;
		}
		return ownerDirectoryPath(dirname(directory), value.generation) === directory
			? normalizeOwnerScope(value)
			: undefined;
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerScope(value: unknown): value is DaemonSupervisorOwnerScope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const scope = value as Partial<DaemonSupervisorOwnerScope>;
	return (
		scope.version === OWNER_VERSION &&
		scope.role === "supervisor" &&
		typeof scope.token === "string" &&
		typeof scope.generation === "string" &&
		typeof scope.socketPath === "string" &&
		typeof scope.descriptorDir === "string"
	);
}

function writeOwnerScope(
	directory: string,
	owner: DaemonSupervisorOwnerRecord,
	guard?: RegistryMutationGuard,
	validateCurrent?: () => void,
): void {
	const scope: DaemonSupervisorOwnerScope = {
		version: owner.version,
		role: owner.role,
		token: owner.token,
		generation: owner.generation,
		socketPath: owner.socketPath,
		descriptorDir: owner.descriptorDir,
	};
	writeJsonAtomically(resolve(directory, "scope.json"), scope, guard, validateCurrent);
}

function writeOwnerRecord(
	directory: string,
	record: DaemonSupervisorOwnerRecord,
	guard?: RegistryMutationGuard,
	validateCurrent?: () => void,
	legacySafe = false,
): void {
	writeJsonAtomically(
		resolve(directory, "owner.json"),
		ownerDiskProjection(record, legacySafe),
		guard,
		validateCurrent,
	);
}

function sameStartupFence(left: DaemonStartupFenceRecord, right: DaemonStartupFenceRecord): boolean {
	return (
		left.version === right.version &&
		left.token === right.token &&
		left.ownerToken === right.ownerToken &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.authorityProcessStartId === right.authorityProcessStartId &&
		left.authorityProcessIdentityHint === right.authorityProcessIdentityHint &&
		left.mirrorRequired === right.mirrorRequired &&
		left.socketPath === right.socketPath &&
		left.supervisorGeneration === right.supervisorGeneration &&
		left.createdAt === right.createdAt
	);
}

interface StartupFenceEvidence {
	path: string;
	record: DaemonStartupFenceRecord;
}

function readStartupFenceEvidence(directory: string, socketPath: string): StartupFenceEvidence[] {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const canonicalPath = startupFencePath(directory, normalizedSocketPath);
	const evidence: StartupFenceEvidence[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = resolve(directory, name);
		const record = readStartupFence(path);
		if (!record) continue;
		if (record.socketPath === normalizedSocketPath) {
			evidence.push({ path, record });
		} else if (path === canonicalPath) {
			throw new Error(`Daemon startup fence hash does not match its socket path: ${path}`);
		}
	}
	return evidence.sort((left, right) => left.path.localeCompare(right.path));
}

function sameStartupFenceEvidence(
	left: readonly StartupFenceEvidence[],
	right: readonly StartupFenceEvidence[],
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(evidence, index) =>
				evidence.path === right[index]?.path && sameStartupFence(evidence.record, right[index]!.record),
		)
	);
}

function readStartupFence(path: string): DaemonStartupFenceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		const fence = value as Partial<DaemonStartupFenceRecord>;
		if (
			fence.version !== OWNER_VERSION ||
			typeof fence.token !== "string" ||
			typeof fence.ownerToken !== "string" ||
			!Number.isInteger(fence.pid) ||
			(fence.pid ?? 0) <= 0 ||
			(fence.processStartId !== undefined && typeof fence.processStartId !== "string") ||
			(fence.processIdentityHint !== undefined && typeof fence.processIdentityHint !== "string") ||
			(fence.authorityProcessStartId !== undefined && typeof fence.authorityProcessStartId !== "string") ||
			(fence.authorityProcessIdentityHint !== undefined && typeof fence.authorityProcessIdentityHint !== "string") ||
			!processIdentityNamespacesAreValid(fence) ||
			(fence.mirrorRequired !== undefined && fence.mirrorRequired !== true) ||
			typeof fence.socketPath !== "string" ||
			typeof fence.supervisorGeneration !== "string" ||
			typeof fence.createdAt !== "string"
		) {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		return normalizeStartupFence(fence as DaemonStartupFenceRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function readRetainedShutdownAdmission(
	registryDir: string,
	guard: RegistryMutationGuard,
): DaemonShutdownAdmissionRecord | undefined {
	const path = shutdownAdmissionPath(registryDir);
	const admission = readShutdownAdmission(path);
	if (!admission) return undefined;
	if (shutdownAdmissionAuthority(admission) !== "exact-dead") return admission;
	const current = readShutdownAdmission(path);
	if (
		!current ||
		!sameShutdownAdmissionRecord(current, admission) ||
		shutdownAdmissionAuthority(current) !== "exact-dead"
	) {
		return current;
	}
	const immediate = readShutdownAdmission(path);
	if (!immediate || !sameShutdownAdmissionRecord(immediate, current)) return immediate;
	guard.assertCurrent();
	rmSync(path, { force: true });
	return undefined;
}

function readShutdownAdmission(path: string): DaemonShutdownAdmissionRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		const admission = value as Partial<DaemonShutdownAdmissionRecord>;
		if (
			admission.version !== OWNER_VERSION ||
			typeof admission.token !== "string" ||
			!Number.isInteger(admission.pid) ||
			(admission.pid ?? 0) <= 0 ||
			(admission.processStartId !== undefined && typeof admission.processStartId !== "string") ||
			(admission.processIdentityHint !== undefined && typeof admission.processIdentityHint !== "string") ||
			(admission.authorityProcessStartId !== undefined && typeof admission.authorityProcessStartId !== "string") ||
			(admission.authorityProcessIdentityHint !== undefined &&
				typeof admission.authorityProcessIdentityHint !== "string") ||
			!processIdentityNamespacesAreValid(admission) ||
			(admission.mirrorRequired !== undefined && admission.mirrorRequired !== true) ||
			(admission.purpose !== undefined && admission.purpose !== "offline-maintenance") ||
			(admission.socketPath !== undefined && typeof admission.socketPath !== "string") ||
			(admission.descriptorDir !== undefined && typeof admission.descriptorDir !== "string") ||
			(admission.purpose === "offline-maintenance" &&
				(typeof admission.socketPath !== "string" || typeof admission.descriptorDir !== "string")) ||
			(admission.purpose === undefined &&
				(admission.socketPath !== undefined || admission.descriptorDir !== undefined)) ||
			typeof admission.createdAt !== "string" ||
			typeof admission.updatedAt !== "string" ||
			typeof admission.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(admission.expiresAt))
		) {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		return normalizeShutdownAdmission(admission as DaemonShutdownAdmissionRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function writeJsonAtomically(
	path: string,
	value: unknown,
	guard?: RegistryMutationGuard,
	validateCurrent?: () => void,
): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		// Re-read token/identity/scope after temp preparation, then check the
		// guard immediately before the canonical rename.
		validateCurrent?.();
		guard?.assertCurrent();
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function startupFencePath(directory: string, socketPath: string): string {
	const key = createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex");
	return resolve(directory, `${key}.json`);
}

function shutdownAdmissionPath(registryDir: string): string {
	return resolve(registryDir, SHUTDOWN_ADMISSION_FILE_NAME);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
