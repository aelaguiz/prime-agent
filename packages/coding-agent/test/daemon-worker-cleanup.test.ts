import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeOrphanProcessJournal } from "../src/core/orphan-process-journal.js";
import { createProcessIdentityOwnerToken } from "../src/core/session-lease.js";
import {
	acquireDaemonWorkerMutationGuard,
	canonicalDaemonWorkerSocketPath,
	cleanupDaemonWorkerArtifacts,
	cleanupFailedDaemonWorkerLaunchAuthority,
	type DaemonWorkerCleanupAuthorityPhase,
	defaultDaemonWorkerDescriptorDir,
	enumerateCanonicalDaemonWorkerDescriptors,
	fsyncDirectory,
	persistDaemonWorkerDescriptorAtomically,
	sweepFailedDaemonWorkerLaunchArtifacts,
} from "../src/modes/daemon/daemon-worker-cleanup.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

interface CleanupFixture {
	root: string;
	descriptorDir: string;
	descriptorPath: string;
	recoveryPath: string;
	orphanPath: string;
	socketPath: string;
	descriptor: DaemonWorkerDescriptor;
}

const fixtureRoots = new Set<string>();
const fixtureSocketPaths = new Set<string>();
const testProcessIds = new Set<number>();

function createCleanupFixture(
	options: { stopped?: boolean; pid?: number; processStartId?: string } = {},
): CleanupFixture {
	const root = mkdtempSync(join(tmpdir(), "prime-worker-cleanup-"));
	fixtureRoots.add(root);
	mkdirSync(join(root, "daemon-workers"), { recursive: true });
	const supervisorSocketPath = join(root, "daemon.sock");
	const descriptorDir = defaultDaemonWorkerDescriptorDir(root, supervisorSocketPath);
	mkdirSync(descriptorDir, { recursive: true });
	const workerId = `worker-${randomUUID()}`;
	const descriptorPath = join(descriptorDir, `${workerId}.json`);
	const recoveryPath = join(descriptorDir, `${workerId}.recovery.jsonl`);
	const orphanPath = join(descriptorDir, `${workerId}.orphans.jsonl`);
	const socketPath = canonicalDaemonWorkerSocketPath(supervisorSocketPath, workerId);
	fixtureSocketPaths.add(socketPath);
	const authority = initializeOrphanProcessJournal(orphanPath);
	writeFileSync(recoveryPath, "recovery\n");
	const descriptor: DaemonWorkerDescriptor = {
		version: 2,
		workerId,
		pid: options.pid ?? 2_000_000_000,
		processStartId: options.processStartId ?? "proc:1",
		socketPath,
		recoveryJournalPath: recoveryPath,
		orphanProcessJournalPath: orphanPath,
		orphanProcessJournalGeneration: authority.generation,
		supervisorSocketPath,
		authenticationToken: randomBytes(32).toString("base64url"),
		rootActiveSessionId: `active-${workerId}`,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lifecycle: options.stopped === false ? "failed" : "stopping",
		createCommand: { type: "create" },
		consecutiveFailures: 0,
		...(options.stopped === false ? {} : { stopRequestedAt: new Date(1).toISOString() }),
	};
	persistDaemonWorkerDescriptorAtomically(descriptorPath, descriptor);
	return { root, descriptorDir, descriptorPath, recoveryPath, orphanPath, socketPath, descriptor };
}

function readDescriptor(path: string): DaemonWorkerDescriptor {
	return JSON.parse(readFileSync(path, "utf8")) as DaemonWorkerDescriptor;
}

function replaceDescriptorUncooperatively(path: string, descriptor: DaemonWorkerDescriptor): void {
	const replacementPath = `${path}.test-replacement-${randomUUID()}`;
	writeFileSync(replacementPath, `${JSON.stringify(descriptor)}\n`);
	renameSync(replacementPath, path);
}

function cleanupOptions(fixture: CleanupFixture) {
	return {
		descriptorPath: fixture.descriptorPath,
		expectedWorkerId: fixture.descriptor.workerId,
		expectedDescriptor: fixture.descriptor,
		layout: { agentDir: fixture.root },
		assertAuthority: async (_phase: DaemonWorkerCleanupAuthorityPhase) => {},
		observeSocket: async () => "unreachable" as const,
	};
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

function killTestProcess(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

afterEach(() => {
	for (const pid of testProcessIds) killTestProcess(pid);
	testProcessIds.clear();
	for (const socketPath of fixtureSocketPaths) rmSync(socketPath, { force: true });
	fixtureSocketPaths.clear();
	for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
	fixtureRoots.clear();
});

describe("durable daemon worker cleanup proof", () => {
	it("resumes after interruption immediately after the durable stop tombstone", async () => {
		const fixture = createCleanupFixture({ stopped: false });
		const crash = new Error("crash after stop tombstone");
		await expect(
			cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				ensureStopTombstone: true,
				afterDurablePhase: (phase) => {
					if (phase === "stop-tombstoned") throw crash;
				},
			}),
		).rejects.toBe(crash);
		const tombstoned = readDescriptor(fixture.descriptorPath);
		expect(tombstoned.stopRequestedAt).toBeTruthy();
		expect(tombstoned.cleanup).toBeUndefined();

		fixture.descriptor = tombstoned;
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(fixture))).resolves.toMatchObject({ status: "cleaned" });
	});

	it.each([
		{ phase: "cleanup-proven" as const, journalExists: true, recoveryExists: true },
		{ phase: "journal-cleared" as const, journalExists: false, recoveryExists: true },
		{ phase: "socket-removed" as const, journalExists: false, recoveryExists: true },
		{ phase: "recovery-removed" as const, journalExists: false, recoveryExists: false },
	])("converges after a crash at $phase and leaves the descriptor last", async (expected) => {
		const fixture = createCleanupFixture();
		const crash = new Error(`crash after ${expected.phase}`);
		await expect(
			cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				afterDurablePhase: (phase) => {
					if (phase === expected.phase) throw crash;
				},
			}),
		).rejects.toBe(crash);

		expect(existsSync(fixture.descriptorPath)).toBe(true);
		expect(existsSync(fixture.orphanPath)).toBe(expected.journalExists);
		expect(existsSync(fixture.recoveryPath)).toBe(expected.recoveryExists);
		const interrupted = readDescriptor(fixture.descriptorPath);
		expect(interrupted.cleanup?.state).toBe(
			expected.phase === "cleanup-proven" ? "cleanup-proven" : "journal-cleared",
		);

		fixture.descriptor = interrupted;
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(fixture))).resolves.toEqual({
			status: "cleaned",
			workerId: fixture.descriptor.workerId,
		});
		expect(existsSync(fixture.descriptorPath)).toBe(false);
	});

	it("retains a missing journal without proof but continues from matching cleanup proof", async () => {
		const noProof = createCleanupFixture();
		rmSync(noProof.orphanPath);
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(noProof))).resolves.toMatchObject({
			status: "retained",
			reason: expect.stringContaining("missing without durable cleanup proof"),
		});
		expect(existsSync(noProof.descriptorPath)).toBe(true);
		expect(existsSync(noProof.recoveryPath)).toBe(true);

		const withProof = createCleanupFixture();
		const crash = new Error("crash after proof");
		await expect(
			cleanupDaemonWorkerArtifacts({
				...cleanupOptions(withProof),
				afterDurablePhase: (phase) => {
					if (phase === "cleanup-proven") throw crash;
				},
			}),
		).rejects.toBe(crash);
		rmSync(withProof.orphanPath);
		withProof.descriptor = readDescriptor(withProof.descriptorPath);
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(withProof))).resolves.toMatchObject({
			status: "cleaned",
		});
	});

	it("treats a malformed optional proof as cleanup-required descriptor state", async () => {
		const fixture = createCleanupFixture();
		const malformed = {
			...fixture.descriptor,
			cleanup: {
				version: 1,
				state: "cleanup-proven",
				token: "invalid",
				authorityFingerprint: "invalid",
				provenAt: "invalid",
			},
		};
		writeFileSync(fixture.descriptorPath, `${JSON.stringify(malformed)}\n`);
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(fixture))).resolves.toMatchObject({ status: "cleaned" });
	});

	it("retains conflicting token and ps identity projections without signaling or cleanup", async () => {
		const fixture = createCleanupFixture();
		const conflicting = {
			...fixture.descriptor,
			processStartId: "ps:Mon Jan 01 00:00:00 2026",
			authorityProcessStartId: `token:${"a".repeat(64)}`,
		};
		replaceDescriptorUncooperatively(fixture.descriptorPath, conflicting);
		const processKill = vi.fn();
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			expectedDescriptor: conflicting,
			probeOptions: { processKill },
		});
		expect(result).toMatchObject({ status: "retained" });
		expect(processKill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		expect(existsSync(fixture.descriptorPath)).toBe(true);
		expect(existsSync(fixture.recoveryPath)).toBe(true);
	});

	it("invalidates a changed-field proof and persists a fresh proof before retrying", async () => {
		const fixture = createCleanupFixture();
		const firstCrash = new Error("first proof");
		await expect(
			cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				afterDurablePhase: (phase) => {
					if (phase === "cleanup-proven") throw firstCrash;
				},
			}),
		).rejects.toBe(firstCrash);
		const first = readDescriptor(fixture.descriptorPath);
		const firstToken = first.cleanup?.token;
		const changed = { ...first, pid: first.pid - 1 };
		persistDaemonWorkerDescriptorAtomically(fixture.descriptorPath, changed);
		fixture.descriptor = changed;

		const secondCrash = new Error("second proof");
		await expect(
			cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				afterDurablePhase: (phase) => {
					if (phase === "cleanup-proven") throw secondCrash;
				},
			}),
		).rejects.toBe(secondCrash);
		const second = readDescriptor(fixture.descriptorPath);
		expect(second.cleanup?.token).toBeTruthy();
		expect(second.cleanup?.token).not.toBe(firstToken);
		expect(second.cleanup?.authorityFingerprint).not.toBe(first.cleanup?.authorityFingerprint);
	});

	it("does not persist a stop tombstone after descriptor replacement", async () => {
		const fixture = createCleanupFixture({ stopped: false });
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			ensureStopTombstone: true,
			assertAuthority: async (phase) => {
				if (phase !== "persist-stop-tombstone") return;
				const current = readDescriptor(fixture.descriptorPath);
				replaceDescriptorUncooperatively(fixture.descriptorPath, {
					...current,
					authenticationToken: randomBytes(32).toString("base64url"),
				});
			},
		});
		expect(result).toMatchObject({ status: "retained", reason: expect.stringContaining("changed") });
		expect(readDescriptor(fixture.descriptorPath).stopRequestedAt).toBeUndefined();
		expect(existsSync(fixture.orphanPath)).toBe(true);
		expect(existsSync(fixture.recoveryPath)).toBe(true);
	});

	it.each([
		"persist-cleanup-proof",
		"clear-journal",
		"persist-journal-cleared",
		"unlink-socket",
		"unlink-recovery",
		"unlink-descriptor",
	] as const)("aborts the %s mutation when the descriptor is replaced", async (targetPhase) => {
		const fixture = createCleanupFixture();
		let replaced = false;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			assertAuthority: async (phase) => {
				if (phase !== targetPhase || replaced) return;
				replaced = true;
				const current = readDescriptor(fixture.descriptorPath);
				replaceDescriptorUncooperatively(fixture.descriptorPath, {
					...current,
					authenticationToken: randomBytes(32).toString("base64url"),
				});
			},
		});
		expect(result).toMatchObject({ status: "retained", reason: expect.stringContaining("changed") });
		expect(existsSync(fixture.descriptorPath)).toBe(true);
		if (targetPhase === "persist-cleanup-proof" || targetPhase === "clear-journal") {
			expect(existsSync(fixture.orphanPath)).toBe(true);
		}
		if (targetPhase !== "unlink-descriptor") {
			expect(existsSync(fixture.recoveryPath)).toBe(true);
		}
	});

	it("never unlinks a canonical successor that appears after the final descriptor check", async () => {
		const fixture = createCleanupFixture();
		const successor = {
			...fixture.descriptor,
			authenticationToken: randomBytes(32).toString("base64url"),
		};
		let installed = false;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			testHooks: {
				fsyncQuarantineDirectory: (artifact, directory, platform) => {
					if (artifact === "descriptor" && !installed) {
						installed = true;
						replaceDescriptorUncooperatively(fixture.descriptorPath, successor);
					}
					fsyncDirectory(directory, platform);
				},
			},
		});

		expect(installed).toBe(true);
		expect(result).toMatchObject({ status: "retained", reason: expect.stringContaining("reappeared") });
		expect(readDescriptor(fixture.descriptorPath)).toEqual(successor);
	});

	it("keeps a successor and quarantine when descriptor fsync fails", async () => {
		const fixture = createCleanupFixture();
		const successor = {
			...fixture.descriptor,
			authenticationToken: randomBytes(32).toString("base64url"),
		};
		let injected = false;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			testHooks: {
				fsyncQuarantineDirectory: (artifact, directory, platform) => {
					if (artifact === "descriptor" && !injected) {
						injected = true;
						replaceDescriptorUncooperatively(fixture.descriptorPath, successor);
						throw new Error("injected descriptor directory fsync failure");
					}
					fsyncDirectory(directory, platform);
				},
			},
		});

		expect(result).toMatchObject({ status: "retained", reason: expect.stringContaining("quarantine durability") });
		expect(readDescriptor(fixture.descriptorPath)).toEqual(successor);
		expect(readdirSync(fixture.descriptorDir).some((name) => name.includes(".json.quarantine-"))).toBe(true);
	});

	it("restores durable descriptor authority after post-unlink directory fsync failure", async () => {
		const fixture = createCleanupFixture();
		let descriptorFsyncs = 0;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			testHooks: {
				fsyncQuarantineDirectory: (artifact, directory, platform) => {
					if (artifact === "descriptor" && ++descriptorFsyncs === 2) {
						throw new Error("injected post-unlink descriptor fsync failure");
					}
					fsyncDirectory(directory, platform);
				},
			},
		});

		expect(descriptorFsyncs).toBe(2);
		expect(result).toMatchObject({
			status: "retained",
			reason: expect.stringContaining("authority was restored without replacement"),
		});
		expect(readDescriptor(fixture.descriptorPath)).toMatchObject({
			workerId: fixture.descriptor.workerId,
			stopRequestedAt: fixture.descriptor.stopRequestedAt,
			cleanup: { state: "journal-cleared" },
		});
		expect(readdirSync(fixture.descriptorDir).some((name) => name.includes(".json.quarantine-"))).toBe(false);
	});
	it("serializes two cleanup callers under one durable worker mutation guard", async () => {
		const fixture = createCleanupFixture();
		let enteredResolve!: () => void;
		let releaseResolve!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		let held = false;
		const options = {
			...cleanupOptions(fixture),
			assertAuthority: async (phase: DaemonWorkerCleanupAuthorityPhase) => {
				if (phase === "prove" && !held) {
					held = true;
					enteredResolve();
					await release;
				}
			},
		};
		const first = cleanupDaemonWorkerArtifacts(options);
		await entered;
		const second = cleanupDaemonWorkerArtifacts(cleanupOptions(fixture));
		releaseResolve();
		const results = await Promise.all([first, second]);

		expect(results.filter((result) => result.status === "cleaned")).toHaveLength(1);
		expect(results.filter((result) => result.status === "retained")).toHaveLength(1);
		expect(existsSync(fixture.descriptorPath)).toBe(false);
	});

	it("uses a caller-held worker mutation guard without releasing it", async () => {
		const fixture = createCleanupFixture();
		const guard = await acquireDaemonWorkerMutationGuard(fixture.descriptorPath);
		try {
			const result = await cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				mutationGuard: guard,
			});
			expect(result).toMatchObject({ status: "cleaned" });
			expect(() => guard.assertCurrent()).not.toThrow();
		} finally {
			guard.release();
		}
	});
	it("binds and cleans a legacy descriptor generation only after exact death", async () => {
		const fixture = createCleanupFixture();
		const legacy = { ...fixture.descriptor, orphanProcessJournalGeneration: undefined };
		persistDaemonWorkerDescriptorAtomically(fixture.descriptorPath, legacy);

		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			expectedDescriptor: legacy,
		});

		expect(result).toMatchObject({ status: "cleaned", workerId: fixture.descriptor.workerId });
		expect(existsSync(fixture.descriptorPath)).toBe(false);
	});

	it("pins the descriptor-recorded socket parent instead of ambient TMPDIR", async () => {
		const fixture = createCleanupFixture();
		const recordedSocketDir = join(fixture.root, "recorded-worker-sockets");
		mkdirSync(recordedSocketDir, { recursive: true });
		const recorded = {
			...fixture.descriptor,
			socketPath: join(recordedSocketDir, fixture.socketPath.split("/").at(-1)!),
		};
		persistDaemonWorkerDescriptorAtomically(fixture.descriptorPath, recorded);
		const previousTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = join(fixture.root, "ambient-tmp-does-not-exist");
		try {
			const result = await cleanupDaemonWorkerArtifacts({
				...cleanupOptions(fixture),
				expectedDescriptor: recorded,
			});
			expect(result).toMatchObject({ status: "cleaned" });
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpdir;
		}
	});

	it("separates exact Windows root death from descendant success and uncertainty", async () => {
		const makeWindowsFixture = (uncertainDescendant: boolean) => {
			const fixture = createCleanupFixture({ processStartId: "win:1" });
			const descendantPid = 1_900_000_000;
			const descriptor = {
				...fixture.descriptor,
				socketPath: canonicalDaemonWorkerSocketPath(
					fixture.descriptor.supervisorSocketPath,
					fixture.descriptor.workerId,
					"win32",
				),
			};
			persistDaemonWorkerDescriptorAtomically(fixture.descriptorPath, descriptor);
			if (uncertainDescendant)
				appendFileSync(
					fixture.orphanPath,
					`${JSON.stringify({
						version: 2,
						type: "process",
						generation: descriptor.orphanProcessJournalGeneration,
						sequence: 1,
						pid: descendantPid,
						ownerPid: process.pid,
						processStartId: "win:2",
						state: "enrolled",
						recordedAt: new Date().toISOString(),
					})}\n`,
				);
			const processKill = (pid: number, _signal: 0) => {
				const code = uncertainDescendant && pid === descendantPid ? "EPERM" : "ESRCH";
				throw Object.assign(new Error(code), { code });
			};
			return { fixture, descriptor, processKill };
		};

		const dead = makeWindowsFixture(false);
		const cleaned = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(dead.fixture),
			expectedDescriptor: dead.descriptor,
			layout: { agentDir: dead.fixture.root, platform: "win32" },
			probeOptions: { processKill: dead.processKill },
		});
		expect(cleaned).toMatchObject({ status: "cleaned" });

		const uncertain = makeWindowsFixture(true);
		const retained = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(uncertain.fixture),
			expectedDescriptor: uncertain.descriptor,
			layout: { agentDir: uncertain.fixture.root, platform: "win32" },
			probeOptions: {
				processKill: uncertain.processKill,
				query: () => {
					throw Object.assign(new Error("uncertain"), { code: "EPERM" });
				},
			},
		});
		expect(retained).toMatchObject({
			status: "retained",
			reason: expect.stringContaining("root or active descendant disposition is unproved"),
		});
		expect(existsSync(uncertain.fixture.descriptorPath)).toBe(true);
	});
	it("retains all authority when the descriptor directory is replaced mid-cleanup", async () => {
		const fixture = createCleanupFixture();
		const movedDirectory = `${fixture.descriptorDir}.replaced`;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			assertAuthority: async (phase) => {
				if (phase !== "persist-cleanup-proof" || existsSync(movedDirectory)) return;
				renameSync(fixture.descriptorDir, movedDirectory);
				mkdirSync(fixture.descriptorDir, { recursive: true });
			},
		});
		expect(result).toMatchObject({ status: "retained", reason: expect.stringContaining("changed") });
		expect(existsSync(join(movedDirectory, `${fixture.descriptor.workerId}.json`))).toBe(true);
		expect(existsSync(join(movedDirectory, `${fixture.descriptor.workerId}.orphans.jsonl`))).toBe(true);
		expect(existsSync(join(movedDirectory, `${fixture.descriptor.workerId}.recovery.jsonl`))).toBe(true);
	});
});

describe("strict worker signal authority", () => {
	it.each([1, 2])("does not deliver signal %s after descriptor replacement", async (replaceOnSignal) => {
		const root = mkdtempSync(join(tmpdir(), "prime-worker-signal-"));
		fixtureRoots.add(root);
		const readyPath = join(root, "ready");
		const identity = createProcessIdentityOwnerToken();
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`,
				"--",
				identity.argument,
			],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
		if (!child.pid) throw new Error("Signal fixture did not start");
		testProcessIds.add(child.pid);
		await waitForFile(readyPath);
		const fixture = createCleanupFixture({ pid: child.pid, processStartId: identity.processStartId });
		let signalChecks = 0;
		const result = await cleanupDaemonWorkerArtifacts({
			...cleanupOptions(fixture),
			assertAuthority: async (phase) => {
				if (phase !== "signal") return;
				signalChecks++;
				if (signalChecks !== replaceOnSignal) return;
				const current = readDescriptor(fixture.descriptorPath);
				replaceDescriptorUncooperatively(fixture.descriptorPath, {
					...current,
					authenticationToken: randomBytes(32).toString("base64url"),
				});
			},
		});
		expect(result).toMatchObject({ status: "retained" });
		expect(processExists(child.pid)).toBe(true);
	});
});

describe("canonical cleanup artifacts", () => {
	it.runIf(process.platform !== "win32")("removes an unreachable canonical Unix socket after proof", async () => {
		const fixture = createCleanupFixture();
		mkdirSync(dirname(fixture.socketPath), { recursive: true });
		const socketCreator = spawnSync(
			process.execPath,
			[
				"-e",
				`const {createServer}=require("node:net"); const server=createServer(); server.listen(${JSON.stringify(
					fixture.socketPath,
				)},()=>process.kill(process.pid,"SIGKILL"));`,
			],
			{ stdio: "ignore" },
		);
		expect(socketCreator.signal).toBe("SIGKILL");
		expect(existsSync(fixture.socketPath)).toBe(true);

		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(fixture))).resolves.toMatchObject({ status: "cleaned" });
		expect(existsSync(fixture.socketPath)).toBe(false);
	});

	it("leaves noncanonical, symlinked, and fake-socket artifacts untouched", async () => {
		const noncanonical = createCleanupFixture();
		const victim = join(noncanonical.root, "victim");
		writeFileSync(victim, "keep\n");
		noncanonical.descriptor.recoveryJournalPath = victim;
		persistDaemonWorkerDescriptorAtomically(noncanonical.descriptorPath, noncanonical.descriptor);
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(noncanonical))).resolves.toMatchObject({
			status: "retained",
			reason: expect.stringContaining("journal authority is not canonical"),
		});
		expect(readFileSync(victim, "utf8")).toBe("keep\n");

		const symlinked = createCleanupFixture();
		const symlinkVictim = join(symlinked.root, "symlink-victim");
		writeFileSync(symlinkVictim, "keep\n");
		rmSync(symlinked.recoveryPath);
		symlinkSync(symlinkVictim, symlinked.recoveryPath);
		await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(symlinked))).resolves.toMatchObject({
			status: "retained",
			reason: expect.stringContaining("not a regular file"),
		});
		expect(readFileSync(symlinkVictim, "utf8")).toBe("keep\n");

		if (process.platform !== "win32") {
			const fakeSocket = createCleanupFixture();
			mkdirSync(dirname(fakeSocket.socketPath), { recursive: true });
			writeFileSync(fakeSocket.socketPath, "keep\n");
			await expect(cleanupDaemonWorkerArtifacts(cleanupOptions(fakeSocket))).resolves.toMatchObject({
				status: "retained",
				reason: expect.stringContaining("not a socket"),
			});
			expect(readFileSync(fakeSocket.socketPath, "utf8")).toBe("keep\n");
			rmSync(fakeSocket.socketPath, { force: true });
		}
	});

	it("retains a valid descriptor stored under an unrelated scope key", () => {
		const fixture = createCleanupFixture();
		const mismatchedDir = join(dirname(fixture.descriptorDir), "aaaaaaaaaaaa");
		mkdirSync(mismatchedDir, { recursive: true });
		const mismatchedDescriptorPath = join(mismatchedDir, `${fixture.descriptor.workerId}.json`);
		const mismatchedOrphanPath = join(mismatchedDir, `${fixture.descriptor.workerId}.orphans.jsonl`);
		const mismatchedRecoveryPath = join(mismatchedDir, `${fixture.descriptor.workerId}.recovery.jsonl`);
		const authority = initializeOrphanProcessJournal(mismatchedOrphanPath);
		writeFileSync(mismatchedRecoveryPath, "recovery\n");
		persistDaemonWorkerDescriptorAtomically(mismatchedDescriptorPath, {
			...fixture.descriptor,
			orphanProcessJournalPath: mismatchedOrphanPath,
			orphanProcessJournalGeneration: authority.generation,
			recoveryJournalPath: mismatchedRecoveryPath,
		});

		const inventory = enumerateCanonicalDaemonWorkerDescriptors(fixture.root);
		expect(inventory.descriptors.map((item) => item.descriptorPath)).not.toContain(mismatchedDescriptorPath);
		expect(inventory.retained).toContainEqual(
			expect.objectContaining({
				path: mismatchedDescriptorPath,
				reason: expect.stringContaining("scope key"),
			}),
		);
	});
});

describe("failed-launch artifact cleanup", () => {
	it("clears the created journal generation and recovery residue only while no descriptor exists", async () => {
		const fixture = createCleanupFixture();
		rmSync(fixture.descriptorPath);
		await expect(
			cleanupFailedDaemonWorkerLaunchAuthority({
				orphanProcessJournalPath: fixture.orphanPath,
				orphanProcessJournalGeneration: fixture.descriptor.orphanProcessJournalGeneration!,
				artifacts: {
					descriptorDirectory: fixture.descriptorDir,
					workerId: fixture.descriptor.workerId,
					supervisorSocketPath: fixture.descriptor.supervisorSocketPath,
					descriptorPath: fixture.descriptorPath,
					recoveryJournalPath: fixture.recoveryPath,
					socketPath: fixture.socketPath,
				},
				assertAuthority: async () => {},
			}),
		).resolves.toBe(true);
		expect(existsSync(fixture.orphanPath)).toBe(false);
		expect(existsSync(fixture.recoveryPath)).toBe(false);
	});

	it("retains the launch journal when ownership changes before its clear", async () => {
		const fixture = createCleanupFixture();
		rmSync(fixture.descriptorPath);
		let assertions = 0;
		await expect(
			cleanupFailedDaemonWorkerLaunchAuthority({
				orphanProcessJournalPath: fixture.orphanPath,
				orphanProcessJournalGeneration: fixture.descriptor.orphanProcessJournalGeneration!,
				artifacts: {
					descriptorDirectory: fixture.descriptorDir,
					workerId: fixture.descriptor.workerId,
					supervisorSocketPath: fixture.descriptor.supervisorSocketPath,
					descriptorPath: fixture.descriptorPath,
					recoveryJournalPath: fixture.recoveryPath,
					socketPath: fixture.socketPath,
				},
				assertAuthority: async () => {
					assertions++;
					if (assertions === 2) throw new Error("ownership changed");
				},
			}),
		).resolves.toBe(false);
		expect(existsSync(fixture.orphanPath)).toBe(true);
		expect(existsSync(fixture.recoveryPath)).toBe(true);
	});

	it("does not clear launch authority when a descriptor needs proof-backed cleanup", async () => {
		const fixture = createCleanupFixture();
		await expect(
			cleanupFailedDaemonWorkerLaunchAuthority({
				orphanProcessJournalPath: fixture.orphanPath,
				orphanProcessJournalGeneration: fixture.descriptor.orphanProcessJournalGeneration!,
				artifacts: {
					descriptorDirectory: fixture.descriptorDir,
					workerId: fixture.descriptor.workerId,
					supervisorSocketPath: fixture.descriptor.supervisorSocketPath,
					descriptorPath: fixture.descriptorPath,
					recoveryJournalPath: fixture.recoveryPath,
					socketPath: fixture.socketPath,
				},
			}),
		).resolves.toBe(false);
		expect(existsSync(fixture.descriptorPath)).toBe(true);
		expect(existsSync(fixture.orphanPath)).toBe(true);
	});
});

describe("failed-launch artifact sweep", () => {
	it("does not unlink startup residue replaced after its validated read", async () => {
		const fixture = createCleanupFixture();
		const unreferenced = join(fixture.descriptorDir, "replaced.orphans.jsonl");
		initializeOrphanProcessJournal(unreferenced);
		let replaced = false;
		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir, undefined, async () => {
			if (replaced) return;
			replaced = true;
			rmSync(unreferenced);
			initializeOrphanProcessJournal(unreferenced);
		});
		expect(result.retained).toContain(unreferenced);
		expect(existsSync(unreferenced)).toBe(true);
	});

	it("never sweeps a worker artifact that arrives after the guarded snapshot", async () => {
		const fixture = createCleanupFixture();
		const initial = join(fixture.descriptorDir, "initial.orphans.jsonl");
		const arrived = join(fixture.descriptorDir, "arrived.orphans.jsonl");
		initializeOrphanProcessJournal(initial);
		let created = false;
		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir, undefined, undefined, {
			afterArtifactQuarantine: (_artifact, canonicalPath) => {
				if (canonicalPath === initial && !created) {
					created = true;
					initializeOrphanProcessJournal(arrived);
				}
			},
		});

		expect(created).toBe(true);
		expect(result.removed).toContain(initial);
		expect(result.removed).not.toContain(arrived);
		expect(existsSync(arrived)).toBe(true);
	});
	it("retains startup residue and propagates ownership loss before unlink", async () => {
		const fixture = createCleanupFixture();
		const unreferenced = join(fixture.descriptorDir, "ownership-lost.orphans.jsonl");
		initializeOrphanProcessJournal(unreferenced);
		const ownershipError = new Error("ownership changed");
		await expect(
			sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir, undefined, async () => {
				throw ownershipError;
			}),
		).rejects.toBe(ownershipError);
		expect(existsSync(unreferenced)).toBe(true);
	});

	it("removes only unreferenced header-only journals", async () => {
		const fixture = createCleanupFixture();
		const unreferenced = join(fixture.descriptorDir, "unreferenced.orphans.jsonl");
		initializeOrphanProcessJournal(unreferenced);
		const malformed = join(fixture.descriptorDir, "malformed.orphans.jsonl");
		writeFileSync(malformed, "{bad}\n");
		const orphanedRecovery = join(fixture.descriptorDir, "orphaned.recovery.jsonl");
		writeFileSync(orphanedRecovery, "retain\n");
		const crossReferenced = join(fixture.descriptorDir, "cross-referenced.orphans.jsonl");
		initializeOrphanProcessJournal(crossReferenced);
		persistDaemonWorkerDescriptorAtomically(fixture.descriptorPath, {
			...fixture.descriptor,
			orphanProcessJournalPath: crossReferenced,
		});

		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir);
		expect(result.removed).toContain(unreferenced);
		expect(existsSync(unreferenced)).toBe(false);
		expect(existsSync(fixture.orphanPath)).toBe(true);
		expect(existsSync(malformed)).toBe(true);
		expect(result.retained).toContain(orphanedRecovery);
		expect(existsSync(orphanedRecovery)).toBe(true);
		expect(result.removed).not.toContain(crossReferenced);
		expect(existsSync(crossReferenced)).toBe(true);
	});

	it("preserves malformed append-lock candidates byte-for-byte", async () => {
		const fixture = createCleanupFixture();
		const base = {
			version: 1,
			ownerPid: 2_000_000_000,
			processStartId: "proc:1",
			token: "a".repeat(64),
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-01-01T00:00:01.000Z",
		};
		const malformedBytes = [
			Buffer.from(JSON.stringify({ ...base, processIdentityHint: "ps:lstart:conflict" })),
			Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
			Buffer.from(JSON.stringify({ ...base, createdAt: "2026-13-01T00:00:00.000Z" })),
			Buffer.from(JSON.stringify({ ...base, token: "invalid" })),
			Buffer.from(JSON.stringify({ ...base, processStartId: `ps:${"x".repeat(1_025)}` })),
		];
		const artifacts = malformedBytes.map((bytes, index) => {
			const path = `${fixture.orphanPath}.append.lock.candidate-${base.ownerPid}-${index}`;
			writeFileSync(path, bytes);
			const stat = lstatSync(path, { bigint: true });
			return { path, bytes, device: stat.dev, inode: stat.ino };
		});

		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir);
		for (const artifact of artifacts) {
			expect(result.retained).toContain(artifact.path);
			expect(readFileSync(artifact.path)).toEqual(artifact.bytes);
			const stat = lstatSync(artifact.path, { bigint: true });
			expect(stat.dev).toBe(artifact.device);
			expect(stat.ino).toBe(artifact.inode);
		}
	});

	it("removes exact-dead candidate and claim residue but retains live-owner candidates", async () => {
		const fixture = createCleanupFixture();
		const deadToken = randomBytes(32).toString("hex");
		const deadRecord = {
			version: 1,
			ownerPid: 2_000_000_000,
			processStartId: "proc:1",
			token: deadToken,
			createdAt: new Date(0).toISOString(),
			expiresAt: new Date(1).toISOString(),
		};
		const candidate = `${fixture.orphanPath}.append.lock.candidate-${deadRecord.ownerPid}-${deadToken}`;
		writeFileSync(candidate, `${JSON.stringify(deadRecord)}\n`);

		const liveIdentity = createProcessIdentityOwnerToken();
		const liveToken = randomBytes(32).toString("hex");
		const liveCandidate = `${fixture.orphanPath}.append.lock.candidate-${process.pid}-${liveToken}`;
		writeFileSync(
			liveCandidate,
			`${JSON.stringify({
				...deadRecord,
				ownerPid: process.pid,
				processStartId: liveIdentity.processStartId,
				token: liveToken,
			})}\n`,
		);

		const claimsDir = `${fixture.orphanPath}.append.lock.claims`;
		mkdirSync(claimsDir, { mode: 0o700 });
		const claim = join(claimsDir, deadToken);
		writeFileSync(
			claim,
			`${JSON.stringify({
				version: 1,
				type: "journal-lock-removal-claim",
				lockRecord: deadRecord,
				claimer: {
					ownerPid: 2_000_000_000,
					processStartId: "proc:1",
					token: randomBytes(32).toString("hex"),
					createdAt: new Date(0).toISOString(),
				},
			})}\n`,
		);

		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir);
		expect(result.removed).toContain(candidate);
		expect(result.removed).toContain(claim);
		expect(existsSync(liveCandidate)).toBe(true);
		expect(readdirSync(fixture.descriptorDir)).toContain(basenameForTest(liveCandidate));
	});

	it("removes exact-dead descriptor temps but leaves journal locks to claim arbitration", async () => {
		const fixture = createCleanupFixture();
		const deadToken = randomBytes(32).toString("hex");
		const deadRecord = {
			version: 1,
			ownerPid: 2_000_000_000,
			token: deadToken,
			createdAt: new Date(0).toISOString(),
			expiresAt: new Date(1).toISOString(),
		};
		const deadTemp = join(fixture.descriptorDir, `dead-worker.json.${deadRecord.ownerPid}.tmp`);
		writeFileSync(deadTemp, "partial\n");
		const deadLock = `${fixture.orphanPath}.append.lock`;
		writeFileSync(deadLock, `${JSON.stringify(deadRecord)}\n`);

		const liveToken = randomBytes(32).toString("hex");
		const liveTemp = join(fixture.descriptorDir, `live-worker.json.${process.pid}.tmp`);
		writeFileSync(liveTemp, "partial\n");
		const liveLock = join(fixture.descriptorDir, "live-worker.orphans.jsonl.append.lock");
		writeFileSync(
			liveLock,
			`${JSON.stringify({
				...deadRecord,
				ownerPid: process.pid,
				token: liveToken,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			})}\n`,
		);

		const result = await sweepFailedDaemonWorkerLaunchArtifacts(fixture.descriptorDir);
		expect(result.removed).toContain(deadTemp);
		expect(result.removed).not.toContain(deadLock);
		expect(result.retained).toEqual(expect.arrayContaining([deadLock, liveTemp, liveLock]));
		expect(existsSync(deadLock)).toBe(true);
		expect(existsSync(liveTemp)).toBe(true);
		expect(existsSync(liveLock)).toBe(true);
	});
});

function basenameForTest(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
