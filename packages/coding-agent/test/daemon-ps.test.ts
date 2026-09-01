import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyTrackedWorkerLiveness,
	cleanupExactDeadWorkerTombstone,
	type DaemonInfo,
	daemonHelloExactProcessAuthority,
	evaluateShutdownQuietPeriod,
	findMatchingDaemonListenerObservation,
	forceStopTrackedWorker,
	mergeDiscoveredDaemonProcesses,
	parseLsofListeners,
	parseLsofSocketOperationCandidates,
	parsePrimeAgentProcessIds,
	parsePsEtimes,
	parseSsListeners,
	planReap,
	planShutdownAll,
	planShutdownConfirmation,
	sortDaemons,
	trackedWorkerSocketPaths,
	verifyHelloSupervisorPid,
} from "../src/cli/daemon-ps.js";
import { initializeOrphanProcessJournal } from "../src/core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	isExactProcessStartId,
	matchesExactProcessIdentity,
} from "../src/core/session-lease.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";
import { enumerateCanonicalDaemonWorkerDescriptors } from "../src/modes/daemon/daemon-worker-cleanup.js";
import {
	type DaemonWorkerDescriptor,
	durableDaemonWorkerDescriptor,
} from "../src/modes/daemon/daemon-worker-protocol.js";

interface TrackedWorkerFixture {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath: string;
	socketPath: string;
}

function createTrackedWorkerFixture(
	root: string,
	options: { pid: number; processStartId?: string; workerId?: string },
): TrackedWorkerFixture {
	const workerId = options.workerId ?? "tracked-worker";
	const supervisorSocketPath = join(root, "daemon.sock");
	const descriptorKey = createHash("sha256")
		.update(normalizeSocketPath(supervisorSocketPath))
		.digest("hex")
		.slice(0, 12);
	const descriptorDirectory = join(root, "daemon-workers", descriptorKey);
	mkdirSync(descriptorDirectory, { recursive: true });
	const descriptorPath = join(descriptorDirectory, `${workerId}.json`);
	const recoveryJournalPath = join(descriptorDirectory, `${workerId}.recovery.jsonl`);
	const orphanProcessJournalPath = join(descriptorDirectory, `${workerId}.orphans.jsonl`);
	const socketPath = join(defaultDaemonSocketDir(), `worker-${descriptorKey}-${workerId.slice(0, 12)}.sock`);
	const orphanProcessJournalGeneration = initializeOrphanProcessJournal(orphanProcessJournalPath).generation;
	const descriptor = durableDaemonWorkerDescriptor({
		version: 2,
		workerId,
		pid: options.pid,
		...(options.processStartId && isExactProcessStartId(options.processStartId)
			? { authorityProcessStartId: options.processStartId }
			: options.processStartId
				? { processStartId: options.processStartId }
				: {}),
		socketPath,
		recoveryJournalPath,
		orphanProcessJournalPath,
		orphanProcessJournalGeneration,
		supervisorSocketPath,
		authenticationToken: "test-token",
		rootActiveSessionId: "active-test",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lifecycle: "failed",
		createCommand: { type: "create" },
		consecutiveFailures: 0,
	});
	writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
	writeFileSync(recoveryJournalPath, "recovery\n");
	return { descriptor, descriptorPath, recoveryJournalPath, orphanProcessJournalPath, socketPath };
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(message);
}

function killTestProcessTree(pid: number | undefined, processStartId: string | undefined): void {
	if (!pid || !processStartId || !matchesExactProcessIdentity(pid, processStartId)) return;
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch {
		// Fall back for Windows and for a process that is not a group leader.
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

describe("parseSsListeners", () => {
	const stdout = [
		"Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
		'u_str LISTEN 0      511    /tmp/custom.sock 10147608 * 0 users:(("prime-agent",pid=1234,fd=22))',
		'u_str LISTEN 0      511    /tmp/prime-agent-1000/daemon.sock 79453846 * 0 users:(("prime-agent",pid=5678,fd=24))',
		'u_str LISTEN 0      4096   /run/dbus/system_bus_socket 123 * 0 users:(("dbus-daemon",pid=900,fd=3))',
		'u_str ESTAB  0      0      /tmp/other.sock 456 * 0 users:(("prime-agent",pid=4321,fd=9))',
		"",
	].join("\n");

	it("extracts socket + pid for prime-agent LISTEN sockets only", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons).toEqual([
			{ pid: 1234, socketPath: normalizeSocketPath("/tmp/custom.sock"), connectPath: resolve("/tmp/custom.sock") },
			{
				pid: 5678,
				socketPath: normalizeSocketPath("/tmp/prime-agent-1000/daemon.sock"),
				connectPath: resolve("/tmp/prime-agent-1000/daemon.sock"),
			},
		]);
	});

	it("ignores sockets owned by other processes and non-LISTEN states", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons.some((daemon) => daemon.socketPath.includes("dbus"))).toBe(false);
		expect(daemons.some((daemon) => daemon.pid === 4321)).toBe(false);
	});

	it("honors a different app name", () => {
		expect(parseSsListeners(stdout, "pi")).toEqual([]);
	});
});

describe("parseLsofListeners", () => {
	it("keeps Darwin path-only lsof evidence as an operation candidate, never a listener", () => {
		const stdout = ["p1234", "f7", "n/tmp/a.sock", "f8", "n->0x123", ""].join("\n");
		expect(parseLsofListeners(stdout)).toEqual([]);
		expect(parseLsofSocketOperationCandidates(stdout)).toEqual([
			{
				socketPath: normalizeSocketPath("/tmp/a.sock"),
				connectPath: resolve("/tmp/a.sock"),
			},
		]);
	});

	it("keeps only bound LISTEN descriptors and rejects connected endpoints", () => {
		const stdout = [
			"p1234",
			"f10",
			"n/tmp/a.sock",
			"TST=LISTEN",
			"f11",
			"n/tmp/a.sock->/tmp/client.sock",
			"TST=CONNECTED",
			"p5678",
			"f12",
			"TST=LISTEN",
			"n/tmp/b.sock",
			"f13",
			"n/tmp/connected-only.sock",
			"TST=CONNECTED",
			"",
		].join("\n");
		expect(parseLsofListeners(stdout)).toEqual([
			{ pid: 1234, socketPath: normalizeSocketPath("/tmp/a.sock"), connectPath: resolve("/tmp/a.sock") },
			{ pid: 5678, socketPath: normalizeSocketPath("/tmp/b.sock"), connectPath: resolve("/tmp/b.sock") },
		]);
	});
});

describe("parsePrimeAgentProcessIds", () => {
	it("finds process.title names even when lsof reports the executable as node", () => {
		const stdout = [
			"  123 node prime-agent --mode daemon",
			"  456 prime-agent prime-agent",
			"  789 /usr/local/bin/prime-agent prime-agent",
			"  900 node unrelated.js",
			"",
		].join("\n");
		expect(parsePrimeAgentProcessIds(stdout, "prime-agent")).toEqual([123, 456, 789]);
	});
});

describe("mergeDiscoveredDaemonProcesses", () => {
	it("keeps process-title discoveries when lsof by name returned only a partial set", () => {
		expect(
			mergeDiscoveredDaemonProcesses(
				[
					{ pid: 123, socketPath: "/tmp/by-name.sock" },
					{ pid: 456, socketPath: "/tmp/shared.sock" },
				],
				[
					{ pid: 456, socketPath: "/tmp/shared.sock" },
					{ pid: 789, socketPath: "/tmp/by-pid.sock" },
				],
			),
		).toEqual([
			{ pid: 123, socketPath: normalizeSocketPath("/tmp/by-name.sock") },
			{ pid: 456, socketPath: normalizeSocketPath("/tmp/shared.sock") },
			{ pid: 789, socketPath: normalizeSocketPath("/tmp/by-pid.sock") },
		]);
	});
});

describe("daemon hello signal authority", () => {
	it.each([
		[
			"qualified Linux authority-only",
			{ supervisorAuthorityProcessStartId: "proc:00000000-0000-4000-8000-000000000000:11" },
			"proc:00000000-0000-4000-8000-000000000000:11",
		],
		[
			"token authority-only",
			{ supervisorAuthorityProcessStartId: `token:${"6".repeat(64)}` },
			`token:${"6".repeat(64)}`,
		],
		[
			"Windows exact dual",
			{ supervisorProcessStartId: "win:11", supervisorAuthorityProcessStartId: "win:11" },
			"win:11",
		],
		["historical exact old field", { supervisorProcessStartId: "win:11" }, "win:11"],
		["legacy-only", { supervisorProcessStartId: "proc:11" }, undefined],
		["malformed authority", { supervisorAuthorityProcessStartId: "token:bad" }, undefined],
		[
			"conflicting dual",
			{ supervisorProcessStartId: "proc:11", supervisorAuthorityProcessStartId: `token:${"7".repeat(64)}` },
			undefined,
		],
	])("maps %s without promoting compatibility evidence", (_name, hello, expected) => {
		expect(daemonHelloExactProcessAuthority(hello)).toBe(expected);
	});
});

describe("verified listener identity", () => {
	const observed = {
		pid: 42,
		socketPath: normalizeSocketPath("/tmp/verified-listener.sock"),
		exactStartId: "proc:00000000-0000-4000-8000-000000000000:100",
		socketIdentity: { dev: 1, ino: 2 },
	};

	it("rejects PID reuse between discovery and the signal recheck", () => {
		expect(
			findMatchingDaemonListenerObservation(observed, [
				{ ...observed, exactStartId: "proc:00000000-0000-4000-8000-000000000000:101" },
			]),
		).toBeUndefined();
	});

	it("rejects socket replacement between discovery and signal or unlink", () => {
		expect(
			findMatchingDaemonListenerObservation(observed, [
				{ ...observed, socketIdentity: { dev: observed.socketIdentity.dev, ino: 3 } },
			]),
		).toBeUndefined();
	});
});

describe("physical daemon discovery identity", () => {
	it.runIf(process.platform !== "win32")("deduplicates listeners reported through symlinked parents", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ps-alias-"));
		const physicalParent = join(root, "physical");
		const aliasParent = join(root, "alias");
		mkdirSync(physicalParent);
		symlinkSync(physicalParent, aliasParent, "dir");
		try {
			const merged = mergeDiscoveredDaemonProcesses(
				[{ pid: 123, socketPath: join(aliasParent, "daemon.sock") }],
				[{ pid: 123, socketPath: join(physicalParent, "daemon.sock") }],
			);
			expect(merged).toEqual([{ pid: 123, socketPath: normalizeSocketPath(join(physicalParent, "daemon.sock")) }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("evaluateShutdownQuietPeriod", () => {
	it("requires a full quiet period independently of the convergence window", () => {
		expect(evaluateShutdownQuietPeriod(10_500, 10_000)).toBe("waiting");
		expect(evaluateShutdownQuietPeriod(11_000, 10_000)).toBe("complete");
	});
});

describe("verifyHelloSupervisorPid", () => {
	it("accepts the hello pid only while its process identity still matches", () => {
		const processStartId = getProcessStartId(process.pid);
		expect(verifyHelloSupervisorPid(process.pid, processStartId)).toBe(
			processStartId && isExactProcessStartId(processStartId) ? process.pid : undefined,
		);
		if (processStartId) {
			expect(verifyHelloSupervisorPid(process.pid, `${processStartId}-stale`)).toBeUndefined();
		}
		expect(verifyHelloSupervisorPid(process.pid, "ps:Mon Jan  1 00:00:00 2024")).toBeUndefined();
	});
});

describe("tracked worker generic-stop exclusion", () => {
	it("derives and excludes a worker socket even when its descriptor is malformed", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-malformed-worker-inventory-"));
		const descriptorKey = "0123456789ab";
		const workerId = "malformed-worker";
		const directory = join(root, "daemon-workers", descriptorKey);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, `${workerId}.json`), "{not-json");
		try {
			const inventory = enumerateCanonicalDaemonWorkerDescriptors(root);
			expect(inventory.descriptors).toEqual([]);
			const evidence = inventory.retained.find((entry) => entry.path.endsWith(`${workerId}.json`));
			expect(evidence?.socketPath).toBeDefined();
			expect(trackedWorkerSocketPaths(inventory).has(normalizeSocketPath(evidence!.socketPath!))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("tracked worker persistent state", () => {
	it("distinguishes exact-dead, live, and uncertain process identities", () => {
		expect(classifyTrackedWorkerLiveness(false, undefined, undefined)).toBe("exact-dead");
		const exactA = "proc:00000000-0000-4000-8000-000000000000:100";
		const exactB = "proc:00000000-0000-4000-8000-000000000000:101";
		expect(classifyTrackedWorkerLiveness(true, exactA, exactB)).toBe("exact-dead");
		expect(classifyTrackedWorkerLiveness(true, exactA, exactA)).toBe("live");
		expect(classifyTrackedWorkerLiveness(true, undefined, exactA)).toBe("uncertain");
		expect(classifyTrackedWorkerLiveness(true, exactA, undefined)).toBe("uncertain");
		expect(classifyTrackedWorkerLiveness(true, "proc:100", exactA)).toBe("uncertain");
	});

	it("cleans only exact-dead tombstones with canonical artifacts and durable journal proof", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-dead-worker-"));
		let socketPath: string | undefined;
		try {
			const fixture = createTrackedWorkerFixture(root, {
				workerId: "dead-worker",
				pid: 2_000_000_000,
				processStartId: "proc:1",
			});
			socketPath = fixture.socketPath;
			expect(
				await cleanupExactDeadWorkerTombstone(fixture.descriptorPath, fixture.descriptor.workerId, root),
			).toEqual({
				skipped: "worker is not stop-tombstoned",
			});

			fixture.descriptor.stopRequestedAt = new Date(1).toISOString();
			writeFileSync(fixture.descriptorPath, `${JSON.stringify(fixture.descriptor)}\n`);
			mkdirSync(dirname(socketPath), { recursive: true });
			writeFileSync(socketPath, "not a unix socket\n");
			const fakeSocket = await cleanupExactDeadWorkerTombstone(
				fixture.descriptorPath,
				fixture.descriptor.workerId,
				root,
			);
			expect(fakeSocket).toMatchObject({ skipped: expect.stringContaining("not a socket") });
			expect(existsSync(socketPath)).toBe(true);

			rmSync(socketPath);
			expect(
				await cleanupExactDeadWorkerTombstone(fixture.descriptorPath, fixture.descriptor.workerId, root),
			).toEqual({
				reaped: "removed exact-dead worker tombstone dead-worker",
			});
			for (const path of [
				fixture.descriptorPath,
				fixture.socketPath,
				fixture.recoveryJournalPath,
				fixture.orphanProcessJournalPath,
			]) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (socketPath) rmSync(socketPath, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("forced tracked worker cleanup", () => {
	it.each(["malformed", "unreadable", "missing"] as const)(
		"retains every worker artifact when the all-generation journal is %s",
		async (journalState) => {
			const root = mkdtempSync(join(tmpdir(), "prime-forced-worker-journal-"));
			try {
				const fixture = createTrackedWorkerFixture(root, { pid: 2_000_000_000, processStartId: "dead" });
				if (journalState === "malformed") {
					writeFileSync(fixture.orphanProcessJournalPath, "{not-json}\n");
				} else {
					rmSync(fixture.orphanProcessJournalPath);
					if (journalState === "unreadable") {
						mkdirSync(fixture.orphanProcessJournalPath);
					}
				}

				const failures = await forceStopTrackedWorker(
					fixture.descriptor,
					fixture.descriptorPath,
					async () => {},
					root,
				);
				expect(failures.join("\n")).toContain("could not safely stop and clean worker");
				for (const path of [fixture.descriptorPath, fixture.recoveryJournalPath]) {
					expect(existsSync(path)).toBe(true);
				}
				expect(existsSync(fixture.orphanProcessJournalPath)).toBe(journalState !== "missing");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"reaps an active child from a prior worker generation before deletion",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "prime-forced-worker-generation-"));
			const childIdentity = createProcessIdentityOwnerToken();
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", childIdentity.argument], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			const childPid = child.pid;
			let childProcessStartId: string | undefined;
			try {
				expect(childPid).toBeTypeOf("number");
				childProcessStartId = getProcessStartId(childPid!);
				expect(childProcessStartId).toBeDefined();
				const fixture = createTrackedWorkerFixture(root, { pid: 2_000_000_000, processStartId: "proc:1" });
				writeFileSync(
					fixture.orphanProcessJournalPath,
					`${readFileSync(fixture.orphanProcessJournalPath, "utf8")}${JSON.stringify({
						version: 2,
						type: "process",
						generation: fixture.descriptor.orphanProcessJournalGeneration,
						sequence: 1,
						pid: childPid,
						ownerPid: fixture.descriptor.pid - 1,
						processStartId: childProcessStartId!,
						state: "enrolled",
						recordedAt: new Date().toISOString(),
					})}\n`,
				);

				await expect(
					forceStopTrackedWorker(fixture.descriptor, fixture.descriptorPath, async () => {}, root),
				).resolves.toEqual([]);
				await waitForCondition(
					() => !processExists(childPid!),
					`Prior-generation child ${childPid} survived cleanup`,
				);
				for (const path of [
					fixture.descriptorPath,
					fixture.recoveryJournalPath,
					fixture.orphanProcessJournalPath,
					fixture.socketPath,
				]) {
					expect(existsSync(path)).toBe(false);
				}
			} finally {
				killTestProcessTree(childPid, childProcessStartId);
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("refuses artifact deletion for a Windows pid-only child record", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-forced-worker-win-pid-"));
		const childIdentity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", childIdentity.argument], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const childPid = child.pid;
		const childProcessStartId = childPid ? getProcessStartId(childPid) : undefined;
		expect(childProcessStartId).toBeDefined();
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			expect(childPid).toBeTypeOf("number");
			const fixture = createTrackedWorkerFixture(root, { pid: 2_000_000_000, processStartId: "dead" });
			writeFileSync(
				fixture.orphanProcessJournalPath,
				`${JSON.stringify({
					version: 1,
					pid: childPid,
					ownerPid: fixture.descriptor.pid,
					active: true,
					recordedAt: new Date().toISOString(),
				})}\n`,
			);
			Object.defineProperty(process, "platform", { value: "win32" });

			const failures = await forceStopTrackedWorker(
				fixture.descriptor,
				fixture.descriptorPath,
				async () => {},
				root,
			);
			expect(failures.join("\n")).toContain("could not safely stop and clean worker");
			for (const path of [fixture.descriptorPath, fixture.recoveryJournalPath, fixture.orphanProcessJournalPath]) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
			killTestProcessTree(childPid, childProcessStartId);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")(
		"retains authority when the exact leader exits before a TERM-resistant descendant",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "prime-forced-worker-tree-"));
			const descendantPidPath = join(root, "descendant.pid");
			const descendantReadyPath = join(root, "descendant.ready");
			const descendantTermPath = join(root, "descendant.term");
			const descendantIdentity = createProcessIdentityOwnerToken();
			const descendantCode = [
				'const fs = require("node:fs");',
				`process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(descendantTermPath)}, "seen"));`,
				`fs.writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
				"setInterval(() => {}, 1000);",
			].join("\n");
			const leaderCode = [
				'const { spawn } = require("node:child_process");',
				'const fs = require("node:fs");',
				'process.on("SIGTERM", () => process.exit(0));',
				`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { argv0: process.env.DESC_IDENTITY_ARGUMENT, stdio: "ignore" });`,
				`fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
				"setInterval(() => {}, 1000);",
			].join("\n");
			const leaderIdentity = createProcessIdentityOwnerToken();
			const leader = spawn(process.execPath, ["-e", leaderCode], {
				argv0: leaderIdentity.argument,
				detached: true,
				env: { ...process.env, DESC_IDENTITY_ARGUMENT: descendantIdentity.argument },
				stdio: "ignore",
			});
			leader.unref();
			const leaderPid = leader.pid;
			let descendantPid: number | undefined;
			let leaderProcessStartId: string | undefined;
			let descendantProcessStartId: string | undefined;
			try {
				expect(leaderPid).toBeTypeOf("number");
				await waitForCondition(
					() => existsSync(descendantPidPath) && existsSync(descendantReadyPath),
					"Timed out waiting for the TERM-resistant descendant",
				);
				descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
				expect(descendantPid).toBeGreaterThan(0);
				descendantProcessStartId = getProcessStartId(descendantPid);
				expect(descendantProcessStartId).toBeDefined();
				leaderProcessStartId = getProcessStartId(leaderPid!);
				expect(leaderProcessStartId).toBeDefined();
				const fixture = createTrackedWorkerFixture(root, {
					pid: leaderPid!,
					processStartId: leaderProcessStartId,
				});

				const failures = await forceStopTrackedWorker(
					fixture.descriptor,
					fixture.descriptorPath,
					async () => {},
					root,
				);
				expect(failures.join("\n")).toContain("disposition is unproved");
				expect(existsSync(descendantTermPath)).toBe(true);
				expect(processExists(descendantPid!)).toBe(true);
				for (const path of [
					fixture.descriptorPath,
					fixture.recoveryJournalPath,
					fixture.orphanProcessJournalPath,
				]) {
					expect(existsSync(path)).toBe(true);
				}
			} finally {
				killTestProcessTree(leaderPid, leaderProcessStartId);
				killTestProcessTree(descendantPid, descendantProcessStartId);
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

describe("parsePsEtimes", () => {
	it("maps pid to elapsed seconds", () => {
		const uptimes = parsePsEtimes("  1234  86400\n  5678      42\n");
		expect(uptimes.get(1234)).toBe(86400);
		expect(uptimes.get(5678)).toBe(42);
		expect(uptimes.size).toBe(2);
	});
});

describe("sortDaemons", () => {
	it("orders default first, then by status, then socket", () => {
		const daemons: DaemonInfo[] = [
			makeDaemon({ socketPath: "/tmp/z.sock", status: "orphan-file" }),
			makeDaemon({ socketPath: "/tmp/a.sock", status: "stale" }),
			makeDaemon({ socketPath: "/tmp/default.sock", status: "current", isDefault: true }),
			makeDaemon({ socketPath: "/tmp/b.sock", status: "current" }),
			makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" }),
		];
		expect(sortDaemons(daemons).map((daemon) => daemon.socketPath)).toEqual([
			"/tmp/default.sock",
			"/tmp/b.sock",
			"/tmp/a.sock",
			"/tmp/c.sock",
			"/tmp/z.sock",
		]);
	});
});

describe("planReap", () => {
	it("never touches the default daemon or daemons with live sessions", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "stale", isDefault: true, sessionCount: 0, pid: 1 }),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["skip", "skip"]);
	});

	it("removes orphan files and stops reachable idle non-default daemons", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/idle.sock", status: "current", sessionCount: 0, pid: 5 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			false,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "remove-file"]);
	});

	it("removes a stale default socket file but never stops a live default daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "orphan-file", isDefault: true }),
				makeDaemon({ socketPath: "/tmp/live-default.sock", status: "current", isDefault: true, sessionCount: 0 }),
			],
			true,
		);
		expect(plan[0]!.kind).toBe("remove-file");
		expect(plan[1]!.kind).toBe("skip");
	});

	it("only kills unreachable daemons with --force", () => {
		const daemon = makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 });
		const skipped = planReap([daemon], false)[0]!;
		expect(skipped.kind).toBe("skip");
		expect(skipped.kind === "skip" ? skipped.reason : "").toContain("prime-agent shutdown --force");
		expect(planReap([daemon], true)[0]!.kind).toBe("kill");
	});

	it("refuses to kill a pid that backs more than one discovered daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/listening.sock", status: "current", sessionCount: 4, pid: 99 }),
				makeDaemon({ socketPath: "/tmp/phantom.sock", status: "unreachable", pid: 99 }),
			],
			true,
		);
		const phantom = plan.find((action) => action.daemon.socketPath === "/tmp/phantom.sock");
		expect(phantom?.kind).toBe("skip");
		expect(phantom && phantom.kind === "skip" ? phantom.reason : "").toContain("also backs another daemon");
	});
});

describe("planShutdownAll", () => {
	it("targets every service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({
					socketPath: "/tmp/default.sock",
					status: "current",
					isDefault: true,
					sessionCount: 0,
					pid: 1,
				}),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
				makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "shutdown", "kill", "remove-file"]);
	});

	it("does not skip services with actionable authority when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({ socketPath: "/tmp/a.sock", status: "stale", pid: 9 }),
				makeDaemon({ socketPath: "/tmp/b.sock", status: "unreachable", pid: 10 }),
			],
			true,
		);
		expect(plan.some((action) => action.kind === "skip")).toBe(false);
	});

	it("retains an unverified Darwin endpoint even when forced", () => {
		const daemon = makeDaemon({
			socketPath: "/private/tmp/candidate.sock",
			status: "unreachable",
			hasUnverifiedEndpointCandidate: true,
		});
		expect(planShutdownAll([daemon], true)[0]).toMatchObject({
			kind: "skip",
			reason: "unverified endpoint candidate; retained",
		});
	});

	it("removes the socket file for an unreachable daemon with no pid", () => {
		const plan = planShutdownAll([makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" })], false);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("requires force for unreachable tracked workers", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/worker-only.sock",
			status: "unreachable",
			hasTrackedWorkers: true,
		});
		expect(planShutdownAll([daemon], false)[0]!.kind).toBe("skip");
		expect(planShutdownAll([daemon], true)[0]!.kind).toBe("remove-file");
	});
});

describe("planShutdownConfirmation", () => {
	it("never prompts when JSON output was requested", () => {
		expect(planShutdownConfirmation(1, true, false, true)).toBe("json-error");
	});

	it("prompts only for non-JSON shutdown at a TTY", () => {
		expect(planShutdownConfirmation(1, false, false, true)).toBe("prompt");
		expect(planShutdownConfirmation(1, false, false, false)).toBe("tty-error");
		expect(planShutdownConfirmation(1, true, true, true)).toBe("none");
		expect(planShutdownConfirmation(0, false, false, true)).toBe("none");
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
