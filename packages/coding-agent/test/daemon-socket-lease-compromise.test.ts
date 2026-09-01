import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acquireDaemonSocketPathLease,
	assertSocketLease,
	cleanupDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("daemon socket path lease", () => {
	// The durable guard has no mtime refresh or stale-owner timer. Compromise is
	// detected synchronously at the exact mutation/bind assertion sites.
	it("detects a removed durable guard synchronously", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-socket-lease-"));
		const socketPath = join(dir, "daemon.sock");

		const lease = await acquireDaemonSocketPathLease(socketPath);
		expect(lease).toBeDefined();
		if (!lease) return;

		// Simulate out-of-band removal of the exact guard inode.
		rmSync(`${socketPath}.lock`, { recursive: true, force: true });

		expect(lease.compromisedError).toBeDefined();
		await lease.release().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);

	it("fails startup and skips cleanup once the lease is compromised", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-socket-lease-"));
		const socketPath = join(dir, "daemon.sock");

		const lease = await acquireDaemonSocketPathLease(socketPath);
		expect(lease).toBeDefined();
		if (!lease) return;

		rmSync(`${socketPath}.lock`, { recursive: true, force: true });

		await expect(prepareDaemonSocketPath(socketPath, lease)).rejects.toThrow(/compromised/);
		expect(() => assertSocketLease(socketPath, lease)).toThrow(/compromised/);
		// The same synchronous assertion is the supervisor's final bind/listen fence.
		// Cleanup must not unlink a path a successor may already own, and must not throw.
		expect(() => cleanupDaemonSocketPath(socketPath, undefined, lease)).not.toThrow();

		await lease.release().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);
});
