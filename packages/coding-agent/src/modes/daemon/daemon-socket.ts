import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireAuthorityMutationGuard, type HeldAuthorityMutationGuard } from "../../core/authority-mutation-guard.js";
import { classifyProcessIdentityAuthority, observeProcessIdentity } from "../../core/session-lease.js";
import { normalizePhysicalFilesystemPath, normalizeSocketPath } from "../../utils/daemon-socket-path.js";

export { normalizePhysicalFilesystemPath, normalizeSocketPath } from "../../utils/daemon-socket-path.js";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;

export class DaemonSocketPathLease {
	private released = false;

	constructor(
		readonly socketPath: string,
		private readonly guard: HeldAuthorityMutationGuard,
	) {}

	assertSocketLease(): void {
		if (this.released) throw new Error(`Daemon socket lease is not active: ${this.socketPath}`);
		this.guard.assertCurrent();
	}

	get compromisedError(): Error | undefined {
		try {
			this.assertSocketLease();
			return undefined;
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}

	async release(): Promise<void> {
		if (this.released) return;
		try {
			this.guard.release();
		} finally {
			this.released = true;
		}
	}
}

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") return "\\\\.\\pipe\\prime-agent-daemon";
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	ensureDefaultDaemonSocketDir(physicalSocketPath);
	if (process.platform === "win32") return undefined;
	const observation = observeProcessIdentity(process.pid);
	if (observation.status !== "present-exact" && observation.status !== "present-coarse") {
		throw new Error(`Cannot establish current process identity (${observation.status})`);
	}
	const guard = acquireAuthorityMutationGuard({
		authorityPath: physicalSocketPath,
		lockfilePath: `${physicalSocketPath}.lock`,
		attempts: 2,
		retryMs: 0,
		identity:
			observation.status === "present-exact"
				? { processStartId: observation.id }
				: { processIdentityHint: observation.hint },
		classifyOwner: (owner) =>
			classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
		failureMessage: `Daemon socket path is already owned: ${physicalSocketPath}`,
	});
	return new DaemonSocketPathLease(physicalSocketPath, guard);
}

export function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	if (lease.socketPath !== physicalSocketPath) {
		throw new Error(`Daemon socket lease does not match ${physicalSocketPath}`);
	}
	lease.assertSocketLease();
}

export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	ensureDefaultDaemonSocketDir(physicalSocketPath);
	if (process.platform === "win32") return;

	if (lease) {
		assertSocketLease(physicalSocketPath, lease);
		await prepareUnixDaemonSocketPath(physicalSocketPath, lease);
		return;
	}
	if (existsSync(physicalSocketPath) && (await canConnectToUnixSocket(physicalSocketPath))) {
		throw new Error(`Daemon socket already in use: ${physicalSocketPath}`);
	}
	const ownedLease = await acquireDaemonSocketPathLease(physicalSocketPath);
	if (!ownedLease) throw new Error(`Could not acquire daemon socket lease: ${physicalSocketPath}`);
	try {
		assertSocketLease(physicalSocketPath, ownedLease);
		await prepareUnixDaemonSocketPath(physicalSocketPath, ownedLease);
	} finally {
		await ownedLease.release();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string, lease: DaemonSocketPathLease): Promise<void> {
	if (!existsSync(socketPath)) return;

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isSocket()) throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) throw new Error(`Daemon socket already in use: ${socketPath}`);
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) return;
		const currentIdentity = readDaemonSocketIdentity(socketPath);
		if (!currentIdentity || !sameSocketIdentity(currentIdentity, staleIdentity)) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) throw new Error(`Daemon socket already in use: ${socketPath}`);
	}

	assertSocketLease(socketPath, lease);
	quarantineAndRemoveSocket(socketPath, staleIdentity, lease);
}

export function restrictDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): void {
	if (process.platform === "win32") return;
	const physicalSocketPath = normalizeSocketPath(socketPath);
	if (lease) assertSocketLease(physicalSocketPath, lease);
	chmodSync(physicalSocketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") return undefined;
	return readDaemonSocketIdentity(normalizeSocketPath(socketPath));
}

export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") return;
	const physicalSocketPath = normalizeSocketPath(socketPath);
	if (lease) {
		try {
			assertSocketLease(physicalSocketPath, lease);
			const identity = expectedIdentity ?? readDaemonSocketIdentity(physicalSocketPath);
			if (identity) quarantineAndRemoveSocket(physicalSocketPath, identity, lease);
		} catch {
			// Cleanup is best effort. Exact lease or inode uncertainty retains the path.
		}
		return;
	}

	let ownedLease: DaemonSocketPathLease | undefined;
	try {
		ownedLease = acquireDaemonSocketPathLeaseSync(physicalSocketPath);
		const identity = expectedIdentity ?? readDaemonSocketIdentity(physicalSocketPath);
		if (identity) quarantineAndRemoveSocket(physicalSocketPath, identity, ownedLease);
	} catch {
		// Another durable owner, malformed legacy authority, or an unsafe path all overblock cleanup.
	} finally {
		void ownedLease?.release().catch(() => undefined);
	}
}

function acquireDaemonSocketPathLeaseSync(socketPath: string): DaemonSocketPathLease {
	const observation = observeProcessIdentity(process.pid);
	if (observation.status !== "present-exact" && observation.status !== "present-coarse") {
		throw new Error(`Cannot establish current process identity (${observation.status})`);
	}
	const guard = acquireAuthorityMutationGuard({
		authorityPath: socketPath,
		lockfilePath: `${socketPath}.lock`,
		attempts: 2,
		retryMs: 0,
		identity:
			observation.status === "present-exact"
				? { processStartId: observation.id }
				: { processIdentityHint: observation.hint },
		classifyOwner: (owner) =>
			classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
		failureMessage: `Daemon socket path is already owned: ${socketPath}`,
	});
	return new DaemonSocketPathLease(socketPath, guard);
}

function quarantineAndRemoveSocket(
	socketPath: string,
	expectedIdentity: DaemonSocketIdentity,
	lease: DaemonSocketPathLease,
): void {
	const current = readDaemonSocketIdentity(socketPath);
	if (!current) return;
	if (!sameSocketIdentity(current, expectedIdentity)) {
		throw new Error(`Daemon socket changed ownership before cleanup: ${socketPath}`);
	}
	const quarantinePath = `${socketPath}.quarantine-${process.pid}-${randomUUID()}`;
	assertSocketLease(socketPath, lease);
	try {
		renameSync(socketPath, quarantinePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let quarantined: DaemonSocketIdentity | undefined;
	try {
		quarantined = readDaemonSocketIdentity(quarantinePath);
	} catch (error) {
		restoreQuarantinedSocketIfPathIsFree(socketPath, quarantinePath, lease);
		throw error;
	}
	if (!quarantined || !sameSocketIdentity(quarantined, expectedIdentity)) {
		// A replacement overtook the pre-rename check. Never unlink it. Restore it
		// when the authority path is still free; otherwise retain the quarantine.
		restoreQuarantinedSocketIfPathIsFree(socketPath, quarantinePath, lease);
		throw new Error(`Daemon socket changed ownership during cleanup: ${socketPath}`);
	}
	const immediate = readDaemonSocketIdentity(quarantinePath);
	if (!immediate || !sameSocketIdentity(immediate, expectedIdentity)) {
		throw new Error(`Daemon socket quarantine changed before cleanup: ${socketPath}`);
	}
	assertSocketLease(socketPath, lease);
	unlinkSync(quarantinePath);
}

function restoreQuarantinedSocketIfPathIsFree(
	socketPath: string,
	quarantinePath: string,
	lease: DaemonSocketPathLease,
): void {
	if (existsSync(socketPath) || !existsSync(quarantinePath)) return;
	assertSocketLease(socketPath, lease);
	renameSync(quarantinePath, socketPath);
}

function readDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	try {
		const stat = lstatSync(socketPath);
		if (!stat.isSocket()) throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
		return { dev: stat.dev, ino: stat.ino };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function sameSocketIdentity(left: DaemonSocketIdentity, right: DaemonSocketIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function defaultDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`);
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32") return;
	const physicalDefaultDir = normalizePhysicalFilesystemPath(defaultDaemonSocketDir());
	if (normalizePhysicalFilesystemPath(dirname(socketPath)) !== physicalDefaultDir) return;

	if (!existsSync(defaultDaemonSocketDir())) {
		mkdirSync(defaultDaemonSocketDir(), { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}
	const stat = lstatSync(defaultDaemonSocketDir());
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${defaultDaemonSocketDir()}`);
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${defaultDaemonSocketDir()}`);
	}
	chmodSync(defaultDaemonSocketDir(), DAEMON_SOCKET_DIR_MODE);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const finish = (canConnect: boolean) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};
		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
