import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

describe("normalizeSocketPath", () => {
	it("normalizes equivalent Unix spellings", () => {
		if (process.platform === "win32") return;
		expect(normalizeSocketPath("/a//b.sock/")).toBe("/a/b.sock");
	});

	it.runIf(process.platform !== "win32")("resolves a real symlinked parent before appending a missing suffix", () => {
		const root = mkdtempSync(join(tmpdir(), "pa-socket-physical-"));
		const physicalParent = join(root, "physical");
		const aliasParent = join(root, "alias");
		mkdirSync(physicalParent);
		symlinkSync(physicalParent, aliasParent, "dir");
		try {
			expect(normalizeSocketPath(join(aliasParent, "missing", "daemon.sock"))).toBe(
				join(realpathSync(physicalParent), "missing", "daemon.sock"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")("rejects a broken symlink as unresolved socket authority", () => {
		const root = mkdtempSync(join(tmpdir(), "pa-socket-broken-alias-"));
		const brokenParent = join(root, "broken");
		symlinkSync(join(root, "missing-target"), brokenParent, "dir");
		try {
			expect(() => normalizeSocketPath(join(brokenParent, "daemon.sock"))).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("defaultDaemonSocketPath", () => {
	it("uses a fixed Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-daemon");
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains an old proper-lock directory even when no socket path exists", async () => {
		if (process.platform === "win32") return;

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		try {
			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/already owned/i);
			expect(existsSync(`${socketPath}.lock`)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")("does not steal a durable lease through an alias or old mtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "pa-socket-alias-lease-"));
		const physicalParent = join(root, "physical");
		const aliasParent = join(root, "alias");
		mkdirSync(physicalParent);
		symlinkSync(physicalParent, aliasParent, "dir");
		const physicalSocketPath = join(physicalParent, "daemon.sock");
		const aliasSocketPath = join(aliasParent, "daemon.sock");
		const lease = await acquireDaemonSocketPathLease(aliasSocketPath);
		expect(lease?.socketPath).toBe(normalizeSocketPath(physicalSocketPath));
		try {
			utimesSync(`${physicalSocketPath}.lock`, new Date(0), new Date(0));
			await expect(acquireDaemonSocketPathLease(physicalSocketPath)).rejects.toThrow(/already owned/i);
		} finally {
			await lease?.release();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
