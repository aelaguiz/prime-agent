import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProcessStartId } from "../../core/session-lease.js";
import { defaultDaemonSocketDir } from "./daemon-socket.js";

interface DaemonLaunchLeaseRecord {
	version: 1;
	token: string;
	ownerPid: number;
	ownerProcessStartId?: string;
	socketPath: string;
}

export class DaemonLaunchLease {
	private released = false;

	constructor(
		readonly socketPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {}

	release(): void {
		if (this.released) return;
		this.released = true;
		const record = readLeaseRecord(this.directory);
		if (record?.token !== this.token) return;
		const releasedDirectory = `${this.directory}.released-${process.pid}-${this.token}`;
		try {
			renameSync(this.directory, releasedDirectory);
			rmSync(releasedDirectory, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			try {
				// If moving the directory is transiently blocked, publish a token-bound
				// release marker so another process can reclaim it even while this PID lives.
				writeFileSync(join(this.directory, "released"), `${this.token}\n`, {
					flag: "wx",
					mode: 0o600,
				});
			} catch {
				// A filesystem that permits neither rename nor marker creation cannot
				// safely transfer ownership. The daemon socket lease remains authoritative.
			}
		}
	}
}

/**
 * Elect one frontend process to classify, replace, or launch a daemon. The
 * daemon's lifetime socket lease remains the final singleton authority; this
 * short lease prevents reconnecting clients from spawning a herd first.
 */
export function tryAcquireDaemonLaunchLease(socketPath: string): DaemonLaunchLease | undefined {
	const directory = daemonLaunchLeaseDirectory(socketPath);
	for (let attempt = 0; attempt < 3; attempt++) {
		const token = randomUUID();
		const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
		const ownerProcessStartId = getProcessStartId(process.pid);
		const record: DaemonLaunchLeaseRecord = {
			version: 1,
			token,
			ownerPid: process.pid,
			...(ownerProcessStartId ? { ownerProcessStartId } : {}),
			socketPath,
		};
		mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(join(candidateDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
		writeFileSync(join(candidateDirectory, "lease.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		try {
			renameSync(candidateDirectory, directory);
			return new DaemonLaunchLease(socketPath, directory, token);
		} catch (error) {
			rmSync(candidateDirectory, { recursive: true, force: true });
			if (!isDaemonLaunchLeaseContentionError(error, directory, socketPath)) throw error;
		}

		if (isLeaseOwnerAlive(directory)) return undefined;
		const staleDirectory = `${directory}.stale-${process.pid}-${token}`;
		try {
			renameSync(directory, staleDirectory);
			rmSync(staleDirectory, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return undefined;
}

export function isDaemonLaunchLeaseContentionError(error: unknown, directory: string, socketPath: string): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EEXIST" || code === "ENOTEMPTY") return true;
	if (code !== "EPERM" && code !== "EACCES") return false;
	const record = readLeaseRecord(directory);
	if (record) return record.socketPath === socketPath;
	try {
		const legacyPid = Number(readFileSync(join(directory, "pid"), "utf8").trim());
		return Number.isInteger(legacyPid) && legacyPid > 0;
	} catch {
		return false;
	}
}

export function daemonLaunchLeaseDirectory(socketPath: string): string {
	const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
	const parent = process.platform === "win32" ? defaultDaemonSocketDir() : dirname(socketPath);
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
			(value.ownerProcessStartId !== undefined && typeof value.ownerProcessStartId !== "string")
		) {
			return undefined;
		}
		return value as DaemonLaunchLeaseRecord;
	} catch {
		return undefined;
	}
}

function isLeaseOwnerAlive(directory: string): boolean {
	const record = readLeaseRecord(directory);
	if (record) {
		try {
			if (readFileSync(join(directory, "released"), "utf8").trim() === record.token) return false;
		} catch {
			// No valid release marker: the recorded process identity still owns the lease.
		}
		return isProcessIdentityAlive(record.ownerPid, record.ownerProcessStartId);
	}
	try {
		const legacyPid = Number(readFileSync(join(directory, "pid"), "utf8").trim());
		return Number.isInteger(legacyPid) && legacyPid > 0 && isProcessIdentityAlive(legacyPid);
	} catch {
		return false;
	}
}

function isProcessIdentityAlive(pid: number, expectedStartId?: string): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
	if (!expectedStartId) return true;
	const currentStartId = getProcessStartId(pid);
	return currentStartId === undefined || currentStartId === expectedStartId;
}
