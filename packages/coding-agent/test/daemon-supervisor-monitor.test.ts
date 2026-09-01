import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as orphanProcessModule from "../src/core/orphan-process-journal.js";
import { initializeOrphanProcessJournal } from "../src/core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	isExactProcessStartId,
	matchesExactProcessIdentity,
} from "../src/core/session-lease.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { CommandRecoveryJournal } from "../src/modes/daemon/command-recovery-journal.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonAttachResult,
	failure,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSocketPathLease, normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";
import { DaemonSupervisor, DaemonWorkerRuntimeIdentityError } from "../src/modes/daemon/daemon-supervisor.js";
import {
	canonicalDaemonWorkerSocketPath,
	defaultDaemonWorkerDescriptorDir,
} from "../src/modes/daemon/daemon-worker-cleanup.js";
import {
	DaemonWorkerAuthenticationError,
	DaemonWorkerClient,
	DaemonWorkerProbeTimeoutError,
} from "../src/modes/daemon/daemon-worker-client.js";
import {
	DAEMON_WORKER_STARTUP_GATE_COMMIT,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";
import type { PrivateFrame } from "../src/modes/session-worker/private-framing.js";
import * as childProcessModule from "../src/utils/child-process.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";
import { createDeferred } from "./suite/scheduling.js";

const workerLaunchTestState = vi.hoisted(() => ({
	capture: false,
	forceMissingProcessStartId: false,
	processStartIdMissesRemaining: 0,
	forcedProcessStartId: undefined as string | undefined,
	processIdentityAuthority: undefined as
		| ((pid: number, expectedProcessStartId?: string) => "exact-live" | "exact-dead" | "retained")
		| undefined,
	exactIdentityMatch: undefined as ((pid: number, expectedProcessStartId: string) => boolean) | undefined,
	assertExactSupervisorOwner: undefined as ((...args: unknown[]) => Promise<string>) | undefined,
	assertLegacySupervisorOwner: undefined as ((...args: unknown[]) => Promise<string>) | undefined,
	fixtureMode: "worker" as "worker" | "close-gate" | "rollback-gate" | "successful-gate" | "supervisor",
	gateMarkerPath: "",
	tsxCliPath: "",
	cliEntrypoint: "",
	spawnFailureCode: undefined as string | undefined,
	observeProcessStartId: undefined as ((pid: number) => string | undefined) | undefined,
	spawned: [] as Array<{
		child: ChildProcess;
		args: readonly string[];
		options: SpawnOptions;
		processStartId?: string;
	}>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
	};
	return {
		...actual,
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
			const failureCode = workerLaunchTestState.spawnFailureCode;
			if (failureCode) {
				// Node's failed-spawn shape: no pid, stdio undefined, "error" then "close".
				const failing = Object.assign(new EventEmitter(), {
					pid: undefined,
					stdio: undefined,
					stderr: undefined,
					unref: () => {},
				}) as unknown as ChildProcess;
				process.nextTick(() => {
					failing.emit(
						"error",
						Object.assign(new Error(`spawn ${command} ${failureCode}`), { code: failureCode }),
					);
					failing.emit("close", null, null);
				});
				return failing;
			}
			const child = actual.spawn(command, args, options);
			if (workerLaunchTestState.capture) {
				const token =
					typeof options.argv0 === "string" && options.argv0.startsWith("prime-agent-owner-token=")
						? `token:${options.argv0.slice("prime-agent-owner-token=".length)}`
						: undefined;
				const observed = child.pid ? workerLaunchTestState.observeProcessStartId?.(child.pid) : undefined;
				workerLaunchTestState.spawned.push({
					child,
					args,
					options,
					...((observed ?? (process.platform === "darwin" ? token : undefined))
						? { processStartId: observed ?? token }
						: {}),
				});
			}
			return child;
		},
	};
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			if (!workerLaunchTestState.capture) {
				return (actual.createCliSubprocessLaunchSpec as (args: readonly string[]) => unknown)(args);
			}
			if (workerLaunchTestState.fixtureMode === "supervisor") {
				return {
					command: process.execPath,
					args: ["--eval", "setInterval(() => {}, 1000)", "--", ...args],
				};
			}
			if (workerLaunchTestState.fixtureMode === "rollback-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				const commitMarker = JSON.stringify(DAEMON_WORKER_STARTUP_GATE_COMMIT);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); if (marker === ${commitMarker}) { fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000); }`,
						"--",
						...args,
					],
				};
			}
			if (workerLaunchTestState.fixtureMode === "close-gate") {
				return {
					command: process.execPath,
					args: ["--eval", 'require("node:fs").closeSync(3)'],
				};
			}
			if (workerLaunchTestState.fixtureMode === "successful-gate") {
				const markerPath = JSON.stringify(workerLaunchTestState.gateMarkerPath);
				return {
					command: process.execPath,
					args: [
						"--eval",
						`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000);`,
					],
				};
			}
			return {
				command: process.execPath,
				args: [workerLaunchTestState.tsxCliPath, workerLaunchTestState.cliEntrypoint, ...args],
			};
		},
	};
});

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		getProcessStartId(pid: number): string | undefined;
		classifyProcessIdentityAuthority(
			pid: number,
			expectedProcessStartId?: string,
			options?: unknown,
		): "exact-live" | "exact-dead" | "retained";
		matchesExactProcessIdentity(pid: number, expectedProcessStartId: string, options?: unknown): boolean;
	};
	return {
		...actual,
		classifyProcessIdentityAuthority(pid: number, expectedProcessStartId?: string, options?: unknown) {
			return (
				workerLaunchTestState.processIdentityAuthority?.(pid, expectedProcessStartId) ??
				actual.classifyProcessIdentityAuthority(pid, expectedProcessStartId, options)
			);
		},
		matchesExactProcessIdentity(pid: number, expectedProcessStartId: string, options?: unknown): boolean {
			return (
				workerLaunchTestState.exactIdentityMatch?.(pid, expectedProcessStartId) ??
				actual.matchesExactProcessIdentity(pid, expectedProcessStartId, options)
			);
		},
		getProcessStartId(pid: number): string | undefined {
			if (workerLaunchTestState.forcedProcessStartId !== undefined) {
				return workerLaunchTestState.forcedProcessStartId;
			}
			if (pid !== process.pid && workerLaunchTestState.processStartIdMissesRemaining > 0) {
				workerLaunchTestState.processStartIdMissesRemaining--;
				return undefined;
			}
			return workerLaunchTestState.forceMissingProcessStartId && pid !== process.pid
				? undefined
				: actual.getProcessStartId(pid);
		},
	};
});

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		assertDaemonSupervisorOwnerCurrent(...args: unknown[]): Promise<string>;
		assertDaemonSupervisorOwnerCurrentForWorkerAuthentication(...args: unknown[]): Promise<string>;
	};
	return {
		...actual,
		assertDaemonSupervisorOwnerCurrent(...args: unknown[]): Promise<string> {
			return (
				workerLaunchTestState.assertExactSupervisorOwner?.(...args) ??
				actual.assertDaemonSupervisorOwnerCurrent(...args)
			);
		},
		assertDaemonSupervisorOwnerCurrentForWorkerAuthentication(...args: unknown[]): Promise<string> {
			return (
				workerLaunchTestState.assertLegacySupervisorOwner?.(...args) ??
				actual.assertDaemonSupervisorOwnerCurrentForWorkerAuthentication(...args)
			);
		},
	};
});

workerLaunchTestState.observeProcessStartId = getProcessStartId;

const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousSupervisorRegistryDir = process.env[supervisorRegistryDirEnv];
const supervisorRegistryDirs = new Set<string>();

interface SupervisorMonitorHarness {
	options: { worker: object };
	clients: Set<{ authenticated: boolean }>;
	supervisorClaims: Map<object, object>;
	shuttingDown: boolean;
	supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	canConnectToSupervisor: (socketPath: string) => Promise<boolean>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	scheduleSupervisorAvailabilityCheck: (socketPath: string, delayMs: number) => void;
}

interface DeferredRecoveryWorker {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		lifecycle: "ready" | "recovering";
		lastError?: string;
		stopRequestedAt?: string;
	};
	client?: object;
	snapshotCache: Map<string, DaemonAttachResult>;
	incomingTranscriptActiveSessionIds: Set<string>;
	transcriptCaches: Map<string, { markFailed(error: Error): void }>;
	duplicateIncomingTranscriptChunkIndexes: Map<string, number>;
	snapshotTransferFrames: Map<string, never>;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
}

interface DeferredRecoveryHarness {
	workers: Map<string, DeferredRecoveryWorker>;
	shuttingDown: boolean;
	assertRecoveryAllowed: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	recoverWorker: ReturnType<typeof vi.fn>;
	handleWorkerClose(worker: DeferredRecoveryWorker, client: object, error: Error): Promise<void>;
	deferWorkerRecovery(worker: DeferredRecoveryWorker, error: Error): void;
}

function recoveryDeniedError(code: "supervisor_recovery_cancelled" | "supervisor_generation_stale"): Error {
	return Object.assign(new Error(code), { code });
}

async function waitForCapturedChildClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

async function waitForExactChildProcessStartId(pid: number): Promise<string> {
	const deadline = Date.now() + 2000;
	do {
		const processStartId = getProcessStartId(pid);
		if (processStartId && isExactProcessStartId(processStartId)) return processStartId;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	} while (Date.now() < deadline);
	throw new Error(`Could not observe exact process identity for ${pid}`);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

function createExistingLaunchWorker(root: string, descriptorDir: string) {
	const workerId = "existing-worker";
	const now = new Date().toISOString();
	const orphanProcessJournalPath = join(descriptorDir, `${workerId}.orphans.jsonl`);
	writeFileSync(orphanProcessJournalPath, "");
	return {
		descriptor: {
			version: 1 as const,
			workerId,
			pid: 999_999,
			processStartId: undefined as string | undefined,
			socketPath: canonicalDaemonWorkerSocketPath(join(root, "supervisor.sock"), workerId),
			recoveryJournalPath: join(descriptorDir, `${workerId}.recovery.jsonl`),
			orphanProcessJournalPath,
			orphanProcessJournalGeneration: undefined as string | undefined,
			supervisorSocketPath: join(root, "supervisor.sock"),
			authenticationToken: "existing-worker-token",
			rootActiveSessionId: "existing-root-session",
			createdAt: now,
			updatedAt: now,
			lifecycle: "recovering" as const,
			stopRequestedAt: undefined as string | undefined,
			createCommand: { type: "create" as const, config: { cwd: root, agentDir: root } },
			consecutiveFailures: 0,
		},
		descriptorPath: join(descriptorDir, `${workerId}.json`),
		summaries: new Map<string, SessionSummary>(),
		snapshotCache: new Map<string, DaemonAttachResult>(),
		transcriptCaches: new Map<string, never>(),
		incomingTranscriptActiveSessionIds: new Set<string>(),
		duplicateIncomingTranscriptChunkIndexes: new Map<string, number>(),
		snapshotTransferFrames: new Map<string, never>(),
		snapshotLoads: new Map<string, Promise<DaemonAttachResult>>(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

function createSupervisorSnapshotState() {
	return {
		clients: new Set<object>(),
		sessionInputPauses: new Map(),
		pendingReplacementSnapshots: new WeakMap<object, Map<string, unknown>>(),
		pendingRosterChanged: new Set<string>(),
		publishedRosterIds: new Set<string>(),
		pendingRosterRemoved: new Set<string>(),
		rosterPushScheduled: false,
	};
}

const recoveryEligibilityInvalidations: Array<{
	name: string;
	invalidate(supervisor: DeferredRecoveryHarness, worker: DeferredRecoveryWorker): void;
}> = [
	{
		name: "the worker reconnects",
		invalidate: (_supervisor, worker) => {
			worker.client = {};
		},
	},
	{
		name: "the worker is stopped",
		invalidate: (_supervisor, worker) => {
			worker.intentionalStop = true;
			worker.descriptor.stopRequestedAt = new Date().toISOString();
		},
	},
	{
		name: "the worker is replaced",
		invalidate: (supervisor, worker) => supervisor.workers.set(worker.descriptor.workerId, { ...worker }),
	},
	{
		name: "supervisor cleanup begins",
		invalidate: (supervisor) => {
			supervisor.shuttingDown = true;
		},
	},
	{
		name: "another recovery begins",
		invalidate: (_supervisor, worker) => {
			worker.recovery = Promise.resolve();
		},
	},
];

function createHarness(canConnect: () => Promise<boolean>): SupervisorMonitorHarness {
	const registryDir = mkdtempSync(join(tmpdir(), "prime-supervisor-registry-test-"));
	supervisorRegistryDirs.add(registryDir);
	process.env[supervisorRegistryDirEnv] = registryDir;
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		clients: new Set<{ authenticated: boolean }>(),
		supervisorClaims: new Map<object, object>(),
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		launchReplacementSupervisor: vi.fn(async () => undefined),
	}) as SupervisorMonitorHarness;
}

describe("daemon worker supervisor monitoring", () => {
	afterEach(async () => {
		for (const { child, processStartId } of workerLaunchTestState.spawned) {
			if (
				child.pid &&
				processStartId &&
				child.exitCode === null &&
				child.signalCode === null &&
				matchesExactProcessIdentity(child.pid, processStartId)
			) {
				const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
				child.kill("SIGKILL");
				await closed;
			}
		}
		workerLaunchTestState.capture = false;
		workerLaunchTestState.forceMissingProcessStartId = false;
		workerLaunchTestState.processStartIdMissesRemaining = 0;
		workerLaunchTestState.forcedProcessStartId = undefined;
		workerLaunchTestState.processIdentityAuthority = undefined;
		workerLaunchTestState.exactIdentityMatch = undefined;
		workerLaunchTestState.assertExactSupervisorOwner = undefined;
		workerLaunchTestState.assertLegacySupervisorOwner = undefined;
		workerLaunchTestState.fixtureMode = "worker";
		workerLaunchTestState.gateMarkerPath = "";
		workerLaunchTestState.tsxCliPath = "";
		workerLaunchTestState.cliEntrypoint = "";
		workerLaunchTestState.spawnFailureCode = undefined;
		workerLaunchTestState.spawned.length = 0;
		vi.useRealTimers();
		for (const registryDir of supervisorRegistryDirs) {
			rmSync(registryDir, { recursive: true, force: true });
		}
		supervisorRegistryDirs.clear();
		if (previousSupervisorRegistryDir === undefined) {
			delete process.env[supervisorRegistryDirEnv];
		} else {
			process.env[supervisorRegistryDirEnv] = previousSupervisorRegistryDir;
		}
	});

	it("launches worker-led replacement supervisors with an exact argv0 owner token", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-worker-supervisor-owner-token-"));
		const registryDir = join(root, "registry");
		mkdirSync(registryDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		process.env[supervisorRegistryDirEnv] = registryDir;
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "supervisor";
		const canConnectToSupervisor = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			supervisorLaunchInProgress: false,
			shuttingDown: false,
			options: { worker: {}, defaultSessionConfig: { cwd: root, agentDir: root } },
			canConnectToSupervisor,
			log: vi.fn(),
		}) as {
			launchReplacementSupervisor(socketPath: string): Promise<void>;
		};

		await daemon.launchReplacementSupervisor(join(root, "supervisor.sock"));

		expect(workerLaunchTestState.spawned).toHaveLength(1);
		const { child, options } = workerLaunchTestState.spawned[0]!;
		const argv0 = options.argv0;
		expect(argv0).toMatch(/^prime-agent-owner-token=[0-9a-f]{64}$/);
		if (!child.pid || typeof argv0 !== "string") throw new Error("Replacement supervisor spawn was incomplete");
		const processStartId = `token:${argv0.slice("prime-agent-owner-token=".length)}`;
		const deadline = Date.now() + 2_000;
		while (!matchesExactProcessIdentity(child.pid, processStartId) && Date.now() < deadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(matchesExactProcessIdentity(child.pid, processStartId)).toBe(true);
	});

	it("schedules recovery when the sole supervisor fails a fence check", async () => {
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = "/tmp/supervisor.sock";
		try {
			const daemon = new AgentDaemon("/tmp/worker.sock", {
				defaultSessionConfig: { agentDir: "/tmp/agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "token" },
			});
			const socket = Object.assign(new EventEmitter(), {
				destroyed: false,
				write: vi.fn(() => true),
				end: vi.fn(function (this: EventEmitter) {
					this.emit("close");
				}),
			}) as unknown as Socket;
			const internals = daemon as unknown as {
				clients: Set<DaemonSocketClient>;
				supervisorClaims: Map<DaemonSocketClient, object>;
				handleConnection(socket: Socket): void;
				checkSupervisorFences(): Promise<void>;
				assertSupervisorClaimCurrent: ReturnType<typeof vi.fn>;
				scheduleSupervisorAvailabilityCheck: ReturnType<typeof vi.fn>;
			};
			internals.handleConnection(socket);
			const client = [...internals.clients][0]!;
			client.authenticated = true;
			client.authenticationRole = "supervisor";
			internals.supervisorClaims.set(client, {
				claim: {},
				ownerFingerprint: "old",
			});
			internals.assertSupervisorClaimCurrent = vi.fn(async () => {
				throw new Error("stale fence");
			});
			internals.scheduleSupervisorAvailabilityCheck = vi.fn();

			await internals.checkSupervisorFences();

			expect(internals.supervisorClaims.has(client)).toBe(false);
			expect(client.authenticated).toBe(true);
			expect(internals.scheduleSupervisorAvailabilityCheck).toHaveBeenCalledOnce();
			expect(internals.scheduleSupervisorAvailabilityCheck).toHaveBeenCalledWith(
				normalizeSocketPath("/tmp/supervisor.sock"),
				100,
			);
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
		}
	});

	it("does not revoke a newer same-client claim when an older periodic fence fails", async () => {
		const assertionReached = createDeferred<void>();
		const assertionGate = createDeferred<void>();
		const client = {
			authenticated: true,
			socket: { destroyed: false, end: vi.fn() },
		} as unknown as DaemonSocketClient;
		const oldClaim = { claim: {}, ownerFingerprint: "old" };
		const newerClaim = { claim: {}, ownerFingerprint: "new" };
		const transaction = {
			id: Symbol("update-restart"),
			owner: client,
			abort: new AbortController(),
			phase: "prepared",
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map([[client, oldClaim]]),
			updateRestart: transaction,
			shuttingDown: false,
			scheduleSupervisorFenceCheck: vi.fn(),
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionReached.resolve();
				await assertionGate.promise;
				throw new Error("stale fence");
			}),
		}) as unknown as {
			supervisorClaims: Map<DaemonSocketClient, object>;
			updateRestart: object;
			checkSupervisorFences(): Promise<void>;
		};

		const check = daemon.checkSupervisorFences();
		await assertionReached.promise;
		daemon.supervisorClaims.set(client, newerClaim);
		assertionGate.resolve();
		await check;

		expect(daemon.supervisorClaims.get(client)).toBe(newerClaim);
		expect(daemon.updateRestart).toBe(transaction);
		expect(client.socket.end).not.toHaveBeenCalled();
	});

	it("does not revoke a newer same-client claim when an older command fence fails", async () => {
		const assertionReached = createDeferred<void>();
		const assertionGate = createDeferred<void>();
		const client = {
			id: "supervisor",
			authenticated: true,
			socket: { destroyed: false, write: vi.fn(() => true), end: vi.fn() },
			attachedActiveSessionIds: new Set(),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as unknown as DaemonSocketClient;
		const oldClaim = { claim: {}, ownerFingerprint: "old" };
		const newerClaim = { claim: {}, ownerFingerprint: "new" };
		const transaction = {
			id: Symbol("update-restart"),
			owner: client,
			abort: new AbortController(),
			phase: "prepared",
		};
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map([[client, oldClaim]]),
			peerClaims: new Map(),
			updateRestart: transaction,
			handleWorkerCommand: vi.fn(async () => undefined),
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionReached.resolve();
				await assertionGate.promise;
				throw new Error("stale fence");
			}),
		}) as unknown as {
			supervisorClaims: Map<DaemonSocketClient, object>;
			updateRestart: object;
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		const command = daemon.handleLine(
			client,
			JSON.stringify({ type: "worker_subscribe", activeSessionId: "active-1" }),
		);
		await assertionReached.promise;
		daemon.supervisorClaims.set(client, newerClaim);
		assertionGate.resolve();
		await command;

		expect(daemon.supervisorClaims.get(client)).toBe(newerClaim);
		expect(daemon.updateRestart).toBe(transaction);
		expect(client.socket.end).not.toHaveBeenCalled();
	});

	it("revokes an old supervisor before ending its socket when a replacement authenticates", async () => {
		let markOldAssertionReached = () => {};
		const oldAssertionReached = new Promise<void>((resolve) => {
			markOldAssertionReached = resolve;
		});
		let releaseOldAssertion = () => {};
		const oldAssertionGate = new Promise<void>((resolve) => {
			releaseOldAssertion = resolve;
		});
		let assertionCount = 0;
		const handleWorkerCommand = vi.fn(async () => undefined);
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			options: { worker: { authenticationToken: "token" } },
			supervisorClaims: new Map(),
			peerClaims: new Map(),
			clients: new Set(),
			sessions: new Map(),
			cronStore: { list: () => [] },
			rosterReporter: {
				lastComposed: new Map(),
				lastComposedJson: new Map(),
				queuedChildren: new Map(),
				removedAgentIds: new Map(),
				snapshotPending: false,
			},
			shuttingDown: false,
			clearSupervisorAvailabilityCheck: vi.fn(),
			scheduleSupervisorFenceCheck: vi.fn(),
			handleWorkerCommand,
			assertSupervisorClaimCurrent: vi.fn(async () => {
				assertionCount++;
				if (assertionCount === 2) {
					markOldAssertionReached();
					await oldAssertionGate;
				}
				return `fingerprint-${assertionCount}`;
			}),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};
		const makeClient = () =>
			({
				id: "supervisor",
				authenticated: false,
				socket: { destroyed: false, write: vi.fn(() => true), end: vi.fn() },
				attachedActiveSessionIds: new Set(),
				detachInput: vi.fn(),
				supportsExtensionUi: false,
				capabilities: new Set(),
			}) as unknown as DaemonSocketClient;
		const auth = (generation: string) =>
			JSON.stringify({
				type: "worker_auth",
				token: "token",
				supervisorGeneration: generation,
				supervisorPid: 123,
				supervisorAuthorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:123",
				supervisorSocketPath: "/tmp/supervisor.sock",
			});
		const oldClient = makeClient();
		const replacementClient = makeClient();

		await daemon.handleLine(oldClient, auth("old"));
		const staleCommand = daemon.handleLine(
			oldClient,
			JSON.stringify({ type: "worker_subscribe", activeSessionId: "active-1" }),
		);
		await oldAssertionReached;
		await daemon.handleLine(replacementClient, auth("replacement"));

		expect(oldClient.authenticated).toBe(true);
		expect(oldClient.socket.end).toHaveBeenCalledOnce();
		releaseOldAssertion();
		await staleCommand;
		expect(handleWorkerCommand).not.toHaveBeenCalled();
	});

	it("routes mixed-version worker authentication through the correct authority namespace", async () => {
		const makeClient = () =>
			({
				id: "supervisor",
				authenticated: false,
				socket: { destroyed: false, write: vi.fn(() => true), end: vi.fn() },
				attachedActiveSessionIds: new Set(),
				detachInput: vi.fn(),
				supportsExtensionUi: false,
				capabilities: new Set(),
			}) as unknown as DaemonSocketClient;
		const makeDaemon = () =>
			Object.assign(Object.create(AgentDaemon.prototype), {
				options: { worker: { authenticationToken: "token" } },
				supervisorClaims: new Map(),
				shuttingDown: false,
				clearSupervisorAvailabilityCheck: vi.fn(),
				scheduleSupervisorFenceCheck: vi.fn(),
			}) as unknown as { handleLine(client: DaemonSocketClient, line: string): Promise<void> };
		const auth = (identity: Record<string, string>) =>
			JSON.stringify({
				type: "worker_auth",
				token: "token",
				supervisorGeneration: "generation",
				supervisorPid: 123,
				supervisorSocketPath: "/tmp/supervisor.sock",
				...identity,
			});
		const lastResponse = (client: DaemonSocketClient) => {
			const write = client.socket.write as unknown as ReturnType<typeof vi.fn>;
			const payload = write.mock.calls.at(-1)?.[0];
			return JSON.parse(String(payload).trim()) as { success: boolean; error?: string };
		};

		const exact = vi.fn(async () => "exact-fingerprint");
		const legacy = vi.fn(async () => "legacy-fingerprint");
		workerLaunchTestState.assertExactSupervisorOwner = exact;
		workerLaunchTestState.assertLegacySupervisorOwner = legacy;

		const oldLinuxClient = makeClient();
		await makeDaemon().handleLine(oldLinuxClient, auth({ supervisorProcessStartId: "proc:123" }));
		expect(oldLinuxClient.authenticated).toBe(true);
		expect(legacy).toHaveBeenCalledOnce();
		expect(exact).not.toHaveBeenCalled();
		expect(lastResponse(oldLinuxClient)).toMatchObject({ success: true });

		const windowsClient = makeClient();
		await makeDaemon().handleLine(
			windowsClient,
			auth({ supervisorProcessStartId: "win:123", supervisorAuthorityProcessStartId: "win:123" }),
		);
		expect(windowsClient.authenticated).toBe(true);
		expect(exact).toHaveBeenCalledOnce();
		expect(lastResponse(windowsClient)).toMatchObject({ success: true });

		workerLaunchTestState.assertLegacySupervisorOwner = vi.fn(async () => {
			throw new Error("Darwin legacy identity is not boot-qualified");
		});
		const oldDarwinClient = makeClient();
		await makeDaemon().handleLine(oldDarwinClient, auth({ supervisorProcessStartId: "ps:Mon Jan 01 00:00:00 2026" }));
		expect(oldDarwinClient.authenticated).toBe(false);
		expect(lastResponse(oldDarwinClient)).toMatchObject({
			success: false,
			error: "worker_auth_version_incompatible",
		});

		workerLaunchTestState.assertExactSupervisorOwner = vi.fn(async () => {
			throw new Error("stale owner generation");
		});
		const staleClient = makeClient();
		await makeDaemon().handleLine(
			staleClient,
			auth({ supervisorAuthorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:123" }),
		);
		expect(workerLaunchTestState.assertExactSupervisorOwner).toHaveBeenCalledOnce();
		expect(lastResponse(staleClient)).toMatchObject({ success: false, error: "supervisor_generation_stale" });
	});

	it("projects new supervisor authority only into byte-compatible old-worker authentication", () => {
		const claimFor = (authorityProcessStartId: string) => {
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				generation: "generation",
				socketPath: "/tmp/supervisor.sock",
				ownership: {
					record: {
						version: 1,
						role: "supervisor",
						pid: 123,
						authorityProcessStartId,
					},
				},
			}) as unknown as {
				supervisorAuthenticationClaim(): {
					supervisorProcessStartId?: string;
					supervisorAuthorityProcessStartId: string;
				};
			};
			return supervisor.supervisorAuthenticationClaim();
		};
		const linux = "proc:11111111-1111-1111-1111-111111111111:123";
		expect(claimFor(linux)).toMatchObject({
			supervisorProcessStartId: "proc:123",
			supervisorAuthorityProcessStartId: linux,
		});
		expect(claimFor("win:123")).toMatchObject({
			supervisorProcessStartId: "win:123",
			supervisorAuthorityProcessStartId: "win:123",
		});
		const tokenClaim = claimFor(`token:${"a".repeat(64)}`);
		expect(tokenClaim.supervisorAuthorityProcessStartId).toBe(`token:${"a".repeat(64)}`);
		expect(tokenClaim.supervisorProcessStartId).toBeUndefined();
	});

	it.each([
		{
			name: "first post-spawn ownership check",
			assertionCall: 3,
			expectedAssertions: 6,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{
			name: "pre-publication ownership check",
			assertionCall: 4,
			expectedAssertions: 7,
			error: recoveryDeniedError("supervisor_generation_stale"),
		},
		{
			name: "descriptor persistence",
			persistFailure: true,
			expectedAssertions: 7,
			error: new Error("descriptor persistence failed"),
		},
	] as const)("keeps workers gated after $name fails", async (scenario) => {
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-launch-gate-test-"));
		const gateMarkerPath = join(root, "committed-gate");
		workerLaunchTestState.gateMarkerPath = gateMarkerPath;
		const descriptorDir = join(root, "descriptors");
		const registryDir = join(root, "registry");
		mkdirSync(descriptorDir, { recursive: true });
		mkdirSync(registryDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		process.env[supervisorRegistryDirEnv] = registryDir;
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if ("assertionCall" in scenario && assertionCount === scenario.assertionCall) {
					throw scenario.error;
				}
			}),
			...("persistFailure" in scenario
				? {
						persistWorker: vi.fn(() => {
							throw scenario.error;
						}),
					}
				: {}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			scenario.error,
		);

		expect(assertionCount).toBe(scenario.expectedAssertions);
		expect(workerLaunchTestState.spawned).toHaveLength(1);
		const { child, args, options } = workerLaunchTestState.spawned[0]!;
		expect(options.argv0).toMatch(/^prime-agent-owner-token=[0-9a-f]{64}$/);
		const socketFlagIndex = args.indexOf("--daemon-socket");
		expect(socketFlagIndex).toBeGreaterThanOrEqual(0);
		const workerSocketPath = args[socketFlagIndex + 1];
		expect(workerSocketPath).toBeDefined();

		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(existsSync(gateMarkerPath)).toBe(false);
		expect(existsSync(workerSocketPath!)).toBe(false);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(readdirSync(registryDir)).toEqual([]);
		expect(workers.size).toBe(0);
	});

	it("never publishes or releases a worker whose exact platform identity cannot be observed", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-missing-worker-identity-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.forceMissingProcessStartId = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		workerLaunchTestState.gateMarkerPath = join(root, "committed-gate");
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toThrow(
			"exact process identity could not be observed",
		);
		expect(existsSync(workerLaunchTestState.gateMarkerPath)).toBe(false);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(workers.size).toBe(0);
		expect(workerLaunchTestState.spawned).toHaveLength(1);
		const failedChild = workerLaunchTestState.spawned[0]?.child;
		if (!failedChild) throw new Error("Identity-timeout child was not captured");
		await waitForCapturedChildClose(failedChild);
		expect(failedChild.exitCode !== null || failedChild.signalCode !== null).toBe(true);
		expect(workerLaunchTestState.spawned).toHaveLength(1);
	});
	it("rolls back promptly when the child closes its startup gate before commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-closed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "close-gate";
		let assertionCount = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => {
				assertionCount++;
				if (assertionCount === 3) {
					const child = workerLaunchTestState.spawned.at(-1)?.child;
					if (!child) {
						throw new Error("Worker child was not captured");
					}
					await waitForCapturedChildClose(child);
				}
			}),
			connectWorker,
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		const timeoutError = new Error("startup gate rejection timed out");
		const result = await Promise.race([
			supervisor
				.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })
				.then(() => ({ value: "resolved" as const, error: undefined }))
				.catch((error: unknown) => ({ value: "rejected" as const, error })),
			new Promise<{ value: "timed-out"; error: Error }>((resolveTimeout) =>
				setTimeout(() => resolveTimeout({ value: "timed-out", error: timeoutError }), 1000),
			),
		]);

		expect(result.value).toBe("rejected");
		expect(result.error).not.toBe(timeoutError);
		expect(result.error).toBeInstanceOf(Error);
		expect(connectWorker).not.toHaveBeenCalled();
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("fails the create with the spawn error when the worker process cannot be spawned", async () => {
		workerLaunchTestState.spawnFailureCode = "EMFILE";
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-spawn-failure-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toThrow(
			/EMFILE.*resident session workers.*ulimit -n/s,
		);
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.includes(".orphans.jsonl"))).toEqual([]);

		workerLaunchTestState.spawnFailureCode = "ENOENT";
		const enoentFailure = await supervisor
			.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })
			.then(() => undefined)
			.catch((error: Error) => error);
		expect(enoentFailure?.message).toContain("ENOENT");
		expect(enoentFailure?.message).not.toContain("ulimit");
		expect(readdirSync(descriptorDir).filter((name) => name.includes(".orphans.jsonl"))).toEqual([]);
	});

	it("cleans a worker descriptor published just before persistence reports failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-post-publish-failure-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		workerLaunchTestState.gateMarkerPath = join(root, "committed-gate");
		const persistenceError = new Error("directory fsync failed after descriptor publication");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") throw new Error("Could not access worker persistence");
		const workers = new Map<string, unknown>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {}),
			persistWorker: vi.fn(function (this: object, worker: object, mutationGuard?: object) {
				Reflect.apply(persistWorker, this, [worker, mutationGuard]);
				throw persistenceError;
			}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			persistenceError,
		);
		expect(workers.size).toBe(0);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(readdirSync(descriptorDir).filter((name) => name.includes(".orphans.jsonl"))).toEqual([]);
	});

	it("keeps a published failed-launch descriptor resident when cleanup proof is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-post-publish-retain-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "rollback-gate";
		workerLaunchTestState.gateMarkerPath = join(root, "committed-gate");
		const persistenceError = new Error("post-publication failure with malformed journal");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") throw new Error("Could not access worker persistence");
		const workers = new Map<
			string,
			{
				descriptor: DaemonWorkerDescriptor;
				authorityBlockedReason?: string;
			}
		>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			assertRecoveryAllowed: vi.fn(async () => {}),
			persistWorker: vi.fn(function (
				this: object,
				worker: { descriptor: DaemonWorkerDescriptor },
				mutationGuard?: object,
			) {
				Reflect.apply(persistWorker, this, [worker, mutationGuard]);
				if (!worker.descriptor.orphanProcessJournalPath) throw new Error("Missing orphan journal fixture path");
				writeFileSync(worker.descriptor.orphanProcessJournalPath, "{malformed}\n");
				throw persistenceError;
			}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			persistenceError,
		);
		expect(workers.size).toBe(1);
		const retained = [...workers.values()][0];
		if (!retained) throw new Error("Retained failed launch was not registered");
		const descriptorPath = readdirSync(descriptorDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => join(descriptorDir, name))[0];
		if (!descriptorPath) throw new Error("Retained descriptor was not durable");
		const durable = JSON.parse(readFileSync(descriptorPath, "utf8")) as DaemonWorkerDescriptor;
		expect(retained.descriptor).toEqual(durable);
		expect(retained.descriptor.stopRequestedAt).toBeTruthy();
		expect(retained.descriptor.lifecycle).toBe("stopping");
		expect(retained.authorityBlockedReason).toBeUndefined();
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".orphans.jsonl"))).toHaveLength(1);
	});

	it("durably binds a legacy orphan generation before cancellation and retries safely", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-generation-test-"));
		const descriptorDir = join(root, "descriptors");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const cancellation = new Error("cancel after legacy upgrade");
		let assertions = 0;
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => {
				assertions++;
				if (assertions === 2) throw cancellation;
			}),
			log: vi.fn(),
		}) as {
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: ReturnType<typeof createExistingLaunchWorker>,
			): Promise<unknown>;
		};

		await expect(
			supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing),
		).rejects.toBe(cancellation);
		const durable = JSON.parse(readFileSync(existing.descriptorPath, "utf8")) as {
			orphanProcessJournalGeneration?: string;
		};
		expect(durable.orphanProcessJournalGeneration).toBeTruthy();
		expect(existing.descriptor.orphanProcessJournalGeneration).toBe(durable.orphanProcessJournalGeneration);
		expect(readFileSync(existing.descriptor.orphanProcessJournalPath, "utf8")).toContain(
			durable.orphanProcessJournalGeneration,
		);

		workerLaunchTestState.spawnFailureCode = "ENOENT";
		await expect(
			supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing),
		).rejects.toThrow("ENOENT");
		expect(existing.descriptor.orphanProcessJournalGeneration).toBe(durable.orphanProcessJournalGeneration);
	});

	it("commits the startup marker after durable worker publication", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-committed-gate-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.processStartIdMissesRemaining = 2;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async (worker: { descriptor: { rootActiveSessionId: string } }) => {
			await waitForFile(markerPath);
			return {
				request: vi.fn(async () => ({
					success: true,
					data: {
						id: worker.descriptor.rootActiveSessionId,
						activeSessionId: worker.descriptor.rootActiveSessionId,
						sessionId: "session-committed-gate",
						cwd: root,
					},
				})),
			};
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			subscribeWorker: vi.fn(async () => undefined),
			refreshWorkerSummaries: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<{
				descriptor: { lifecycle: string; processStartId?: string; authorityProcessStartId?: string };
			}>;
		};

		const worker = await supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } });

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(workers.size).toBe(1);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		const spawned = workerLaunchTestState.spawned.at(-1);
		const child = spawned?.child;
		if (!child?.pid || !spawned) {
			throw new Error("Worker child was not captured");
		}
		const observedProcessStartId = getProcessStartId(child.pid);
		expect(worker.descriptor.authorityProcessStartId).toBe(observedProcessStartId);
		expect(worker.descriptor.authorityProcessStartId).toMatch(
			process.platform === "darwin" ? /^token:[0-9a-f]{64}$/ : /^(?:proc|win):/,
		);
		expect(worker.descriptor.processStartId).toBe(process.platform === "win32" ? observedProcessStartId : undefined);
		if (process.platform === "darwin" && typeof spawned.options.argv0 === "string") {
			expect(worker.descriptor.authorityProcessStartId).toBe(
				`token:${spawned.options.argv0.slice("prime-agent-owner-token=".length)}`,
			);
		}
		const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		if (
			!worker.descriptor.authorityProcessStartId ||
			!matchesExactProcessIdentity(child.pid, worker.descriptor.authorityProcessStartId)
		) {
			throw new Error("Worker identity changed before test teardown");
		}
		child.kill("SIGKILL");
		await closed;
	});

	it("rolls back a published worker when shutdown admission and rollback persistence fail", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-cancelled-launch-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const rollbackPersistenceError = new Error("rollback persistence failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const workers = new Map<string, unknown>();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object, mutationGuard?: object) {
				persistenceCalls++;
				if (persistenceCalls >= 2) {
					throw rollbackPersistenceError;
				}
				Reflect.apply(persistWorker, this, [worker, mutationGuard]);
			}),
			log: vi.fn(),
		}) as {
			launchWorker(command: { type: "create"; config: { cwd: string; agentDir: string } }): Promise<unknown>;
		};

		await expect(supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } })).rejects.toBe(
			cancellation,
		);

		expect(readFileSync(markerPath, "utf8")).toBe("start\n");
		expect(connectWorker).toHaveBeenCalledOnce();
		expect(persistenceCalls).toBeGreaterThanOrEqual(2);
		expect(workers.size).toBe(1);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		expect(readdirSync(descriptorDir).filter((name) => name.endsWith(".orphans.jsonl"))).toHaveLength(1);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("defers an eligible existing recovery when descriptor restoration fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-restore-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const restorationError = new Error("descriptor restoration failed");
		const persistWorker = Reflect.get(DaemonSupervisor.prototype, "persistWorker");
		if (typeof persistWorker !== "function") {
			throw new Error("Could not access worker persistence");
		}
		let persistenceCalls = 0;
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const previousDescriptor = existing.descriptor;
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			persistWorker: vi.fn(function (this: object, worker: object, mutationGuard?: object) {
				persistenceCalls++;
				if (persistenceCalls === 4) {
					throw restorationError;
				}
				Reflect.apply(persistWorker, this, [worker, mutationGuard]);
			}),
			deferWorkerRecovery,
			log: vi.fn(),
		}) as {
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
		};

		await expect(
			supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing),
		).rejects.toBe(cancellation);

		expect(persistenceCalls).toBe(4);
		expect(existing.descriptor).not.toBe(previousDescriptor);
		expect(existing.descriptor.orphanProcessJournalGeneration).toBeTruthy();
		expect(workers.get(existing.descriptor.workerId)).toBe(existing);
		expect(deferWorkerRecovery).toHaveBeenCalledOnce();
		expect(deferWorkerRecovery).toHaveBeenCalledWith(existing, cancellation);
		const child = workerLaunchTestState.spawned.at(-1)?.child;
		expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
	});

	it("does not restore an existing recovery invalidated during rollback", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-existing-stop-race-test-"));
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "successful-gate";
		workerLaunchTestState.gateMarkerPath = markerPath;
		const cancellation = recoveryDeniedError("supervisor_recovery_cancelled");
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const workers = new Map<string, object>([[existing.descriptor.workerId, existing]]);
		const deferWorkerRecovery = vi.fn();
		const stopWorker = Reflect.get(DaemonSupervisor.prototype, "stopWorker");
		if (typeof stopWorker !== "function") {
			throw new Error("Could not access worker shutdown");
		}
		let markRollbackStarted = () => {};
		const rollbackStarted = new Promise<void>((resolveStarted) => {
			markRollbackStarted = resolveStarted;
		});
		let releaseRollback = () => {};
		const rollbackRelease = new Promise<void>((resolveRelease) => {
			releaseRollback = resolveRelease;
		});
		const controlledStopWorker = vi.fn(async function (
			this: object,
			worker: object,
			removeDescriptor: boolean,
			force = false,
			archiveSession = false,
			recoveryCleanup = false,
			directChild?: object,
		) {
			if (recoveryCleanup) {
				markRollbackStarted();
				await rollbackRelease;
				return;
			}
			await Reflect.apply(stopWorker, this, [
				worker,
				removeDescriptor,
				force,
				archiveSession,
				recoveryCleanup,
				directChild,
			]);
		});
		const connectWorker = vi.fn(async () => {
			await waitForFile(markerPath);
			throw cancellation;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir,
			socketPath: join(root, "supervisor.sock"),
			workers,
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker,
			stopWorker: controlledStopWorker,
			deferWorkerRecovery,
			log: vi.fn(),
		}) as {
			shuttingDown: boolean;
			launchWorker(
				command: { type: "create"; config: { cwd: string; agentDir: string } },
				existing: object,
			): Promise<unknown>;
			stopWorker(
				worker: object,
				removeDescriptor: boolean,
				force: boolean,
				archiveSession?: boolean,
				recoveryCleanup?: boolean,
				directChild?: { child: ChildProcess; closed: Promise<void> },
			): Promise<void>;
		};

		const launchResult = supervisor
			.launchWorker({ type: "create", config: { cwd: root, agentDir: root } }, existing)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await rollbackStarted;
		supervisor.shuttingDown = true;
		const launchedChild = workerLaunchTestState.spawned.at(-1)?.child;
		if (!launchedChild) throw new Error("Could not find launched worker before shutdown");
		const launchedChildClosed = new Promise<void>((resolveClose) =>
			launchedChild.once("close", () => resolveClose()),
		);
		releaseRollback();
		expect(await launchResult).toBe(cancellation);
		await supervisor.stopWorker(existing, true, true, false, false, {
			child: launchedChild,
			closed: launchedChildClosed,
		});

		expect(existing.stopRevision).toBe(1);
		expect(existing.descriptor.stopRequestedAt).toBeDefined();
		expect(workers.size).toBe(0);
		expect(existsSync(existing.descriptorPath)).toBe(false);
		expect(deferWorkerRecovery).not.toHaveBeenCalled();
	});

	it("relaunches supervisors with an exact argv0 owner token", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-restart-owner-token-"));
		supervisorRegistryDirs.add(root);
		workerLaunchTestState.capture = true;
		workerLaunchTestState.fixtureMode = "supervisor";
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers: new Map(),
			clients: new Set(),
			catalog: { stop: vi.fn(async () => undefined) },
			socketPath: join(root, "supervisor.sock"),
			defaultSessionConfig: { cwd: root, agentDir: root },
			snapshotCacheRoot: join(root, "cache"),
			ownsSocketPath: false,
			log: vi.fn(),
		}) as {
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};

		try {
			await expect(supervisor.shutdown(0, false, true)).rejects.toThrow("exit 0");
			expect(workerLaunchTestState.spawned).toHaveLength(1);
			const { child, options } = workerLaunchTestState.spawned[0]!;
			const argv0 = options.argv0;
			expect(argv0).toMatch(/^prime-agent-owner-token=[0-9a-f]{64}$/);
			if (!child.pid || typeof argv0 !== "string") throw new Error("Replacement supervisor spawn was incomplete");
			const processStartId = `token:${argv0.slice("prime-agent-owner-token=".length)}`;
			const deadline = Date.now() + 2_000;
			while (!matchesExactProcessIdentity(child.pid, processStartId) && Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}
			expect(matchesExactProcessIdentity(child.pid, processStartId)).toBe(true);
		} finally {
			exit.mockRestore();
		}
	});

	it("attempts every shutdown cleanup step before exiting", async () => {
		const cleanupSocket = vi.fn(() => {
			throw new Error("daemon socket cleanup failed");
		});
		const leaseRelease = vi.fn(async () => {
			throw new Error("lease cleanup failed");
		});
		const ownershipRelease = vi.fn(async () => undefined);
		const log = vi.fn();
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		type ShutdownHarness = {
			socketLease?: { release(): Promise<void> };
			ownership?: { release(): Promise<void> };
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers: new Map(),
			clients: new Set(),
			catalog: { stop: vi.fn(async () => undefined) },
			cleanupSocket,
			snapshotCacheRoot: "\0",
			socketLease: { release: leaseRelease },
			ownership: { release: ownershipRelease },
			log,
		}) as ShutdownHarness;

		try {
			await expect(supervisor.shutdown(42, false)).rejects.toThrow("exit 42");
			expect(cleanupSocket).toHaveBeenCalledOnce();
			expect(leaseRelease).toHaveBeenCalledOnce();
			expect(ownershipRelease).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("supervisor cache"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon socket lock"));
			expect(supervisor.socketLease).toBeUndefined();
			expect(supervisor.ownership).toBeUndefined();
			expect(exit).toHaveBeenCalledWith(42);
		} finally {
			exit.mockRestore();
		}
	});

	it("completes shutdown without awaiting an unsignalable worker finalizer", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-shutdown-finalization-test-"));
		supervisorRegistryDirs.add(root);
		const worker = {
			descriptor: {
				workerId: "worker-shutdown-finalization",
				pid: 111_123,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 1,
			stopFinalization: new Promise<void>(() => {}),
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		workerLaunchTestState.exactIdentityMatch = () => false;
		const catalogStop = vi.fn(async () => undefined);
		const log = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			signalCleanupHandlers: [],
			workers,
			clients: new Set(),
			persistWorkerStopTombstone: vi.fn(),
			hasPersistedWorkerDescriptors: vi.fn(() => true),
			catalog: { stop: catalogStop },
			cleanupSocket: vi.fn(),
			snapshotCacheRoot: join(root, "cache"),
			log,
		}) as {
			shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
		};

		try {
			const shutdown = supervisor.shutdown(0, true, false, true).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(2000);
			await expect(shutdown).resolves.toEqual(new Error("exit 0"));

			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(killSpy).not.toHaveBeenCalled();
			expect(catalogStop).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("remains tombstoned for recovery"));
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			exit.mockRestore();
			killSpy.mockRestore();
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("fences the startup socket and leaves resource cleanup to the startup failure path after lease compromise", () => {
		const cleanupSupervisorResources = vi.fn(async () => {});
		const fenceSupervisorSocket = vi.fn();
		let leaseFailure: Error | undefined;
		const lease = new DaemonSocketPathLease("/tmp/daemon.sock", {
			assertCurrent() {
				if (leaseFailure) throw leaseFailure;
			},
			release() {},
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			startupComplete: false,
			socketLease: lease,
			cleanupSupervisorResources,
			fenceSupervisorSocket,
			log: vi.fn(),
		}) as {
			shuttingDown: boolean;
			assertSocketLeaseHeld(): void;
			handleSocketLeaseCompromised(error: Error): void;
		};
		lease.onCompromised((error) => supervisor.handleSocketLeaseCompromised(error));

		leaseFailure = new Error("lock refresh failed");
		expect(() => lease.assertSocketLease()).toThrow(leaseFailure);

		expect(supervisor.shuttingDown).toBe(true);
		expect(fenceSupervisorSocket).toHaveBeenCalledOnce();
		expect(cleanupSupervisorResources).not.toHaveBeenCalled();
		expect(() => supervisor.assertSocketLeaseHeld()).toThrow(/lease was compromised/);
	});

	it("relinquishes supervisor resources after socket lease compromise even when logging fails", async () => {
		const cleanupSupervisorResources = vi.fn(async () => {});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: false,
			startupComplete: true,
			cleanupSupervisorResources,
			fenceSupervisorSocket: vi.fn(),
			log: vi.fn(() => {
				throw new Error("log failed");
			}),
			reportCleanupFailure: vi.fn(),
		}) as {
			shuttingDown: boolean;
			handleSocketLeaseCompromised(error: Error): void;
		};
		let leaseFailure: Error | undefined;
		const lease = new DaemonSocketPathLease("/tmp/daemon.sock", {
			assertCurrent() {
				if (leaseFailure) throw leaseFailure;
			},
			release() {},
		});
		lease.onCompromised((error) => supervisor.handleSocketLeaseCompromised(error));

		try {
			leaseFailure = new Error("lock refresh failed");
			expect(() => lease.assertSocketLease()).toThrow(leaseFailure);
			await Promise.resolve();

			expect(supervisor.shuttingDown).toBe(true);
			expect(cleanupSupervisorResources).toHaveBeenCalledOnce();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("rejects commands immediately after the supervisor is fenced", async () => {
		const writes: string[] = [];
		const client = {
			id: "client-fenced",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const handleCommand = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			shuttingDown: true,
			generation: "fenced-generation",
			socketPath: "/tmp/fenced.sock",
			handleCommand,
		}) as {
			handleLine(target: DaemonSocketClient, line: string): Promise<void>;
		};

		await supervisor.handleLine(
			client,
			JSON.stringify(createDaemonCommandEnvelope({ type: "list" }, "command-fenced", "client-fenced")),
		);

		expect(writes.join(" ")).toContain("is shutting down");
		expect(handleCommand).not.toHaveBeenCalled();
	});

	it("does not poll a healthy supervisor after the startup check", async () => {
		vi.useFakeTimers();
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 1500);
		await vi.advanceTimersByTimeAsync(1500);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(daemon.supervisorMonitorTimer).toBeUndefined();
	});

	it("skips socket probes while an authenticated supervisor connection is active", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);
		daemon.clients.add({ authenticated: true });
		daemon.supervisorClaims.set({}, {});

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.runAllTimersAsync();

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
	});

	it("retries when shutdown admission lookup fails", async () => {
		vi.useFakeTimers();
		let resolveProbe: () => void = () => undefined;
		const probeCompleted = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const daemon = createHarness(async () => {
			resolveProbe();
			return true;
		});
		const registryDir = process.env[supervisorRegistryDirEnv];
		if (!registryDir) throw new Error("Supervisor registry test directory was not set");
		rmSync(registryDir, { recursive: true, force: true });
		writeFileSync(registryDir, "not a directory");

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.advanceTimersByTimeAsync(0);
		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
		expect(daemon.supervisorMonitorTimer).toBeDefined();

		rmSync(registryDir, { force: true });
		mkdirSync(registryDir, { recursive: true });
		await vi.advanceTimersByTimeAsync(5000);
		await probeCompleted;
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
	});

	it("recovers exactly once after shutdown admission clears", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-deferred-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-deferred-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		supervisor.deferWorkerRecovery(worker, new Error("duplicate close"));
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("resumes deferred recovery after a concurrent recovery is denied", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-concurrent-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-concurrent-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let admissionActive = true;
		const assertRecoveryAllowed = vi.fn(async () => {
			if (admissionActive) {
				throw recoveryDeniedError("supervisor_recovery_cancelled");
			}
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		let startConcurrentRecovery: () => void = () => undefined;
		const concurrentRecoveryBarrier = new Promise<void>((resolve) => {
			startConcurrentRecovery = resolve;
		});
		const concurrentRecovery = (async () => {
			await concurrentRecoveryBarrier;
			await expect(assertRecoveryAllowed()).rejects.toMatchObject({ code: "supervisor_recovery_cancelled" });
		})().finally(() => {
			worker.recovery = undefined;
		});
		worker.recovery = concurrentRecovery;

		await vi.advanceTimersByTimeAsync(5000);
		expect(worker.deferredRecovery).toBe(deferredRecovery);
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();

		startConcurrentRecovery();
		await concurrentRecovery;
		expect(worker.recovery).toBeUndefined();
		admissionActive = false;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(assertRecoveryAllowed).toHaveBeenCalledTimes(3);
		expect(worker.descriptor.lifecycle).toBe("recovering");
		expect(worker.descriptor.lastError).toBe("worker disconnected");
		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledOnce();
		expect(worker.deferredRecovery).toBeUndefined();
	});

	it("cancels deferred recovery permanently after ownership loss", async () => {
		vi.useFakeTimers();
		const client = {};
		const worker: DeferredRecoveryWorker = {
			descriptor: {
				workerId: "worker-stale-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-stale-recovery",
				lifecycle: "ready",
			},
			client,
			snapshotCache: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			transcriptCaches: new Map(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map<string, never>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		let stale = false;
		const assertRecoveryAllowed = vi.fn(async () => {
			throw recoveryDeniedError(stale ? "supervisor_generation_stale" : "supervisor_recovery_cancelled");
		});
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			...createSupervisorSnapshotState(),
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed,
			persistWorker,
			recoverWorker,
		}) as DeferredRecoveryHarness;

		await supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
		const deferredRecovery = worker.deferredRecovery;
		expect(deferredRecovery).toBeDefined();
		stale = true;
		await vi.advanceTimersByTimeAsync(5000);
		await deferredRecovery;

		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.descriptor.lastError).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();
		expect(worker.deferredRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(recoverWorker).not.toHaveBeenCalled();
	});

	it.each(recoveryEligibilityInvalidations)(
		"does not recover when $name during the ownership assertion",
		async ({ invalidate }) => {
			const client = {};
			const worker: DeferredRecoveryWorker = {
				descriptor: {
					workerId: "worker-eligibility-race",
					pid: process.pid,
					rootActiveSessionId: "active-eligibility-race",
					lifecycle: "ready",
				},
				client,
				snapshotCache: new Map(),
				incomingTranscriptActiveSessionIds: new Set(),
				transcriptCaches: new Map(),
				duplicateIncomingTranscriptChunkIndexes: new Map(),
				snapshotTransferFrames: new Map<string, never>(),
				intentionalStop: false,
				stopRevision: 0,
			};
			let resolveAssertion: () => void = () => undefined;
			const assertion = new Promise<void>((resolve) => {
				resolveAssertion = resolve;
			});
			const persistWorker = vi.fn();
			const recoverWorker = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				...createSupervisorSnapshotState(),
				workers: new Map([[worker.descriptor.workerId, worker]]),
				shuttingDown: false,
				assertRecoveryAllowed: vi.fn(() => assertion),
				persistWorker,
				recoverWorker,
			}) as DeferredRecoveryHarness;

			const handling = supervisor.handleWorkerClose(worker, client, new Error("worker disconnected"));
			invalidate(supervisor, worker);
			resolveAssertion();
			await handling;

			expect(worker.descriptor.lifecycle).toBe("ready");
			expect(worker.descriptor.lastError).toBeUndefined();
			expect(persistWorker).not.toHaveBeenCalled();
			expect(recoverWorker).not.toHaveBeenCalled();
		},
	);

	it("clears an intentional-stop tombstone before retrying a worker", async () => {
		type RetryWorker = {
			descriptor: {
				workerId: string;
				rootActiveSessionId: string;
				rootSessionId: string;
				lifecycle: "ready" | "recovering";
				consecutiveFailures: number;
				stopRequestedAt?: string;
				archiveOnStop?: boolean;
			};
			intentionalStop: boolean;
			summaries: Map<string, SessionSummary>;
		};
		type RetryHarness = {
			workers: Map<string, RetryWorker>;
			persistWorker: ReturnType<typeof vi.fn>;
			recoverWorker: ReturnType<typeof vi.fn>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "retry_worker"; activeSessionId: string },
			): Promise<unknown>;
		};
		const worker: RetryWorker = {
			descriptor: {
				workerId: "worker-1",
				rootActiveSessionId: "active-1",
				rootSessionId: "session-1",
				lifecycle: "ready",
				consecutiveFailures: 2,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			summaries: new Map(),
		};
		const persistWorker = vi.fn(() => {
			expect(worker.intentionalStop).toBe(false);
			expect(worker.descriptor.stopRequestedAt).toBeUndefined();
			expect(worker.descriptor.archiveOnStop).toBeUndefined();
			expect(worker.descriptor.lifecycle).toBe("recovering");
			expect(worker.descriptor.consecutiveFailures).toBe(0);
		});
		const recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			persistWorker,
			recoverWorker,
			assertWorkerAccessibleToClient: vi.fn(),
		}) as RetryHarness;

		await supervisor.handleCommand({} as DaemonSocketClient, {
			type: "retry_worker",
			activeSessionId: worker.descriptor.rootSessionId,
		});

		expect(persistWorker).toHaveBeenCalledOnce();
		expect(recoverWorker).toHaveBeenCalledWith(worker);
		expect(persistWorker.mock.invocationCallOrder[0]).toBeLessThan(recoverWorker.mock.invocationCallOrder[0]!);
	});

	it("rejects retry while the worker is actively stopping", async () => {
		type RetryWorker = {
			descriptor: {
				workerId: string;
				rootActiveSessionId: string;
				rootSessionId: string;
				lifecycle: "ready";
				consecutiveFailures: number;
				stopRequestedAt: string;
				archiveOnStop: boolean;
			};
			intentionalStop: boolean;
			summaries: Map<string, SessionSummary>;
		};
		type RetryHarness = {
			stopWorker(worker: RetryWorker, removeDescriptor: boolean): Promise<void>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "retry_worker"; activeSessionId: string },
			): Promise<unknown>;
		};
		const worker: RetryWorker = {
			descriptor: {
				workerId: "worker-stopping",
				rootActiveSessionId: "active-stopping",
				rootSessionId: "session-stopping",
				lifecycle: "ready",
				consecutiveFailures: 2,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			summaries: new Map(),
		};
		const stopStarted = createDeferred<void>();
		const releaseStop = createDeferred<void>();
		const persistWorker = vi.fn();
		const recoverWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			workerStopCounts: new Map(),
			stopWorkerUntracked: vi.fn(async () => {
				stopStarted.resolve();
				await releaseStop.promise;
			}),
			persistWorker,
			recoverWorker,
			assertWorkerAccessibleToClient: vi.fn(),
		}) as RetryHarness;

		const stopping = supervisor.stopWorker(worker, true);
		await stopStarted.promise;
		await expect(
			supervisor.handleCommand({} as DaemonSocketClient, {
				type: "retry_worker",
				activeSessionId: worker.descriptor.rootSessionId,
			}),
		).rejects.toThrow("Session worker is stopping; retry after it finishes");

		expect(worker.intentionalStop).toBe(true);
		expect(worker.descriptor.stopRequestedAt).toBeDefined();
		expect(worker.descriptor.archiveOnStop).toBe(true);
		expect(persistWorker).not.toHaveBeenCalled();
		expect(recoverWorker).not.toHaveBeenCalled();
		releaseStop.resolve();
		await stopping;
	});

	it("rejects a worker with no runtime identity before authentication without entering adoption recovery", async () => {
		type AdoptionWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				socketPath: string;
				authenticationToken: string;
				rootActiveSessionId: string;
				lifecycle: "recovering" | "failed";
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
		};
		const worker: AdoptionWorker = {
			descriptor: {
				workerId: "worker-build-mismatch-adoption",
				pid: process.pid,
				socketPath: "/tmp/worker-build-mismatch.sock",
				authenticationToken: "token",
				rootActiveSessionId: "active-build-mismatch",
				lifecycle: "recovering",
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const connect = vi.spyOn(DaemonWorkerClient.prototype, "connect").mockResolvedValue();
		const waitForHello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockResolvedValue({
			type: "daemon_hello",
		} as Awaited<ReturnType<DaemonWorkerClient["waitForHello"]>>);
		const authenticate = vi.spyOn(DaemonWorkerClient.prototype, "authenticateWorker").mockResolvedValue({
			id: undefined,
			type: "response",
			command: "worker_auth",
			success: true,
		});
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close").mockImplementation(() => undefined);
		const recoverWorker = vi.fn(async () => undefined);
		const subscribeWorker = vi.fn(async () => undefined);
		const refreshWorkerSummaries = vi.fn(async () => undefined);
		const persistWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			assertRecoveryAllowed: vi.fn(async () => undefined),
			recoverWorker,
			subscribeWorker,
			refreshWorkerSummaries,
			persistWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(worker: AdoptionWorker): Promise<void>;
		};

		try {
			await supervisor.adoptOrRecoverWorker(worker);

			expect(connect).toHaveBeenCalledOnce();
			expect(waitForHello).toHaveBeenCalledOnce();
			expect(authenticate).not.toHaveBeenCalled();
			expect(subscribeWorker).not.toHaveBeenCalled();
			expect(refreshWorkerSummaries).not.toHaveBeenCalled();
			expect(recoverWorker).not.toHaveBeenCalled();
			expect(worker.descriptor.lifecycle).toBe("failed");
			expect(worker.descriptor.lastError).toContain("worker=missing");
			expect(persistWorker).toHaveBeenCalledOnce();
		} finally {
			close.mockRestore();
			authenticate.mockRestore();
			waitForHello.mockRestore();
			connect.mockRestore();
		}
	});

	it("never kills or relaunches a live worker after a runtime identity rejection", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle: "recovering" | "failed";
				consecutiveFailures: number;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-build-mismatch-recovery",
				pid: process.pid,
				rootActiveSessionId: "active-build-mismatch",
				createCommand: { type: "create" },
				lifecycle: "recovering",
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const mismatch = new DaemonWorkerRuntimeIdentityError(undefined, {
			buildId: "supervisor-build",
			executablePath: "/node",
		});
		const connectWorker = vi.fn(async () => {
			throw mismatch;
		});
		const recoverUncertainWorkerOperations = vi.fn(async () => undefined);
		const launchWorker = vi.fn(async () => worker);
		const persistWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker,
			recoverUncertainWorkerOperations,
			launchWorker,
			persistWorker,
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => undefined),
		}) as {
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(connectWorker).toHaveBeenCalledOnce();
		expect(recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
		expect(worker.descriptor.lastError).toContain("worker=missing");
		expect(worker.descriptor.consecutiveFailures).toBe(0);
		expect(persistWorker).toHaveBeenCalledOnce();
	});

	it("keeps a root kill registration through a synchronous shutdown event until exact cleanup", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-root-kill",
				pid: 123_456,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:456",
				rootActiveSessionId: "root-active",
				lifecycle: "ready" as const,
			},
			summaries: new Map<string, SessionSummary>([
				[
					"root-active",
					{ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" } as SessionSummary,
				],
			]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const deleteWorkerDescriptor = vi.fn();
		const stopWorkerUntracked = vi.fn(async (target: typeof worker, removeDescriptor: boolean) => {
			// The root-kill ownership and this exact stop are both active here.
			expect(supervisor.workerStopCounts.get(target)).toBe(2);
			expect(workers.get(target.descriptor.workerId)).toBe(target);
			workers.delete(target.descriptor.workerId);
			if (removeDescriptor) deleteWorkerDescriptor(target);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			workerStopCounts: new Map(),
			clients: new Set(),
			shuttingDown: false,
			streamReconstructor: { observe: vi.fn() },
			invalidateWorkerSnapshot: vi.fn(),
			refreshWorkerSummaries: vi.fn(async () => undefined),
			persistWorkerStopTombstone: vi.fn(),
			deleteWorkerDescriptor,
			broadcastHeartbeatsChanged: vi.fn(),
			findWorkerForClient: vi.fn(async () => ({
				worker,
				summary: worker.summaries.get("root-active"),
			})),
			forwardToWorker: vi.fn(async () => {
				supervisor.handleWorkerFrame(worker, {
					header: { kind: "outbound", outboundType: "session_closed", activeSessionId: "root-active" },
					payload: Buffer.from(JSON.stringify({ type: "session_closed", reason: "shutdown" })),
				});
				// The event arrives before the forwarded kill resolves.
				expect(workers.get(worker.descriptor.workerId)).toBe(worker);
				expect(deleteWorkerDescriptor).not.toHaveBeenCalled();
				return success(undefined, "kill");
			}),
			stopWorkerUntracked,
		}) as {
			workers: typeof workers;
			workerStopCounts: Map<typeof worker, number>;
			handleCommand(
				client: DaemonSocketClient,
				command: { type: "kill"; activeSessionId: string },
			): Promise<unknown>;
			handleWorkerFrame(target: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};

		await expect(
			supervisor.handleCommand({} as DaemonSocketClient, { type: "kill", activeSessionId: "root-active" }),
		).resolves.toEqual(success(undefined, "kill"));
		expect(stopWorkerUntracked).toHaveBeenCalledWith(worker, true, false, true, false, undefined);
		expect(workers.has(worker.descriptor.workerId)).toBe(false);
		expect(deleteWorkerDescriptor).toHaveBeenCalledWith(worker);
		expect(supervisor.workerStopCounts.has(worker)).toBe(false);
	});

	it("defers root-session shutdown deletion to proof-gated finalization", () => {
		const worker = {
			descriptor: {
				workerId: "worker-root-shutdown",
				rootActiveSessionId: "root-active",
			},
			summaries: new Map<string, SessionSummary>([
				[
					"root-active",
					{ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" } as SessionSummary,
				],
			]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			incomingTranscriptActiveSessionIds: new Set<string>(),
			duplicateIncomingTranscriptChunkIndexes: new Map<string, number>(),
			client: { close: vi.fn() },
			intentionalStop: false,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const persistWorkerStopTombstone = vi.fn();
		const scheduleWorkerStopFinalization = vi.fn();
		const deleteWorkerDescriptor = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			workerStopCounts: new Map(),
			clients: new Set(),
			streamReconstructor: { observe: vi.fn() },
			invalidateWorkerSnapshot: vi.fn(),
			invalidateWorkerSessionInputPauses: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			persistWorkerStopTombstone,
			scheduleWorkerStopFinalization,
			deleteWorkerDescriptor,
		}) as {
			handleWorkerFrame(target: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};

		supervisor.handleWorkerFrame(worker, {
			header: { kind: "outbound", outboundType: "session_closed", activeSessionId: "root-active" },
			payload: Buffer.from(JSON.stringify({ type: "session_closed", reason: "shutdown" })),
		});

		expect(persistWorkerStopTombstone).toHaveBeenCalledWith(worker);
		expect(scheduleWorkerStopFinalization).toHaveBeenCalledWith(worker);
		expect(deleteWorkerDescriptor).not.toHaveBeenCalled();
		expect(workers.get(worker.descriptor.workerId)).toBe(worker);
	});

	it("cancels an in-flight recovery after an intentional stop tombstone", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				stopRequestedAt?: string;
			};
			intentionalStop: boolean;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: { workerId: "worker-1", pid: process.pid, rootActiveSessionId: "active-1" },
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt = new Date().toISOString();
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(worker.recovery).toBeUndefined();
	});

	it("fails closed after pid reuse without fresh runtime context", async () => {
		vi.useFakeTimers();
		workerLaunchTestState.processIdentityAuthority = () => "exact-dead";
		workerLaunchTestState.exactIdentityMatch = () => false;
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				authorityProcessStartId: string;
				rootActiveSessionId: string;
				ownerClientId?: string;
				lifecycle?: string;
				consecutiveFailures: number;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-reused-pid",
				pid: process.pid,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:2185",
				rootActiveSessionId: "active-1",
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(),
			processIdentity: vi.fn(() => "replaced"),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(supervisor.connectWorker).not.toHaveBeenCalled();
		expect(supervisor.recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker);
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
		expect(supervisor.persistWorker).toHaveBeenCalledWith(worker);
	});

	it("rejects create reuse when a failed worker cannot be safely reclaimed", async () => {
		const worker = {
			descriptor: {
				workerId: "failed-unreclaimed",
				rootActiveSessionId: "active-failed",
				lifecycle: "failed",
			},
		};
		const supervisor = Object.create(DaemonSupervisor.prototype) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/failed.jsonl")).rejects.toThrow(
			/failed worker/,
		);
	});

	it("waits for worker recovery before reusing a saved session", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const recovery = createDeferred<void>();
		const worker = {
			descriptor: {
				workerId: "recovering-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "recovering",
			},
			client: undefined as object | undefined,
			summaries: new Map<string, SessionSummary>(),
			recovery: recovery.promise,
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		let settled = false;
		const reused = supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl").finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		worker.descriptor.lifecycle = "ready";
		worker.client = {};
		worker.summaries.set(root.activeSessionId, root as SessionSummary);
		seedSupervisorRoster(supervisor, worker);
		recovery.resolve();

		await expect(reused).resolves.toBe(worker);
	});

	it("starts recovery before reusing a persisted recovering worker", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "persisted-recovering-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "recovering",
			},
			client: undefined as object | undefined,
			summaries: new Map<string, SessionSummary>(),
			intentionalStop: false,
		};
		const recoverWorker = vi.fn(async () => {
			worker.descriptor.lifecycle = "ready";
			worker.client = {};
			worker.summaries.set(root.activeSessionId, root as SessionSummary);
			seedSupervisorRoster(supervisor, worker);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			recoverWorker,
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).resolves.toBe(worker);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("starts recovery for a disconnected worker still marked ready", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "disconnected-ready-worker",
				rootActiveSessionId: root.activeSessionId,
				lifecycle: "ready",
			},
			client: undefined as object | undefined,
			summaries: new Map([[root.activeSessionId, root as SessionSummary]]),
			intentionalStop: false,
		};
		const recoverWorker = vi.fn(async () => {
			worker.client = {};
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			recoverWorker,
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};
		seedSupervisorRoster(supervisor, worker);

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).resolves.toBe(worker);
		expect(recoverWorker).toHaveBeenCalledOnce();
	});

	it("rejects recovered workers whose assigned root is still missing", async () => {
		const worker = {
			descriptor: {
				workerId: "rootless-worker",
				rootActiveSessionId: "active-root",
				lifecycle: "ready",
			},
			client: {},
			summaries: new Map<string, SessionSummary>(),
			recovery: Promise.resolve(),
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
		}) as {
			reuseWorkerForCreate(
				target: typeof worker,
				ownerClientId: undefined,
				sessionPath: string,
			): Promise<typeof worker>;
		};

		await expect(supervisor.reuseWorkerForCreate(worker, undefined, "/tmp/session.jsonl")).rejects.toThrow(
			"assigned root session is missing",
		);
	});

	it("preserves cached summaries when recovery omits the assigned root", async () => {
		const root = { id: "active-root", activeSessionId: "active-root", sessionId: "session-root", cwd: "/tmp" };
		const worker = {
			descriptor: {
				workerId: "root-omitting-worker",
				rootActiveSessionId: root.activeSessionId,
			},
			client: {
				request: vi.fn(async () =>
					success(undefined, "list", {
						sessions: [{ id: "other", activeSessionId: "other", sessionId: "session-other", cwd: "/tmp" }],
					}),
				),
			},
			summaries: new Map([[root.activeSessionId, root as SessionSummary]]),
			intentionalStop: false,
		};
		const supervisor = Object.create(DaemonSupervisor.prototype) as {
			refreshWorkerSummaries(target: typeof worker, recovery: boolean): Promise<void>;
		};

		await expect(supervisor.refreshWorkerSummaries(worker, true)).rejects.toThrow(
			"Session worker omitted its root session during recovery",
		);
		expect(worker.summaries.get(root.activeSessionId)).toBe(root);
	});

	it("ignores conflicting paths on workers unrelated to a session lookup", () => {
		const unrelated = {
			descriptor: {
				workerId: "unrelated",
				sessionFile: "/tmp/unrelated-a.jsonl",
				createCommand: { type: "create" as const, sessionPath: "/tmp/unrelated-b.jsonl" },
			},
			summaries: new Map(),
		};
		const target = {
			descriptor: {
				workerId: "target",
				sessionFile: "/tmp/target.jsonl",
				createCommand: { type: "create" as const, sessionPath: "/tmp/target.jsonl" },
			},
			summaries: new Map(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([
				[unrelated.descriptor.workerId, unrelated],
				[target.descriptor.workerId, target],
			]),
		}) as {
			findWorkerBySessionFile(sessionFile: string): typeof target | undefined;
		};

		expect(supervisor.findWorkerBySessionFile("/tmp/target.jsonl")).toBe(target);
	});

	it("reclaims a dead failed resident so a fresh create can reopen its session", async () => {
		const worker = {
			descriptor: { workerId: "failed-resident", pid: 42, lifecycle: "failed" as const },
			intentionalStop: false,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const recoverUncertainWorkerOperations = vi.fn(async () => {});
		const deleteWorkerDescriptor = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			sessionInputPauses: new Map(),
			processIdentity: vi.fn(() => "gone"),
			persistWorkerStopTombstone: vi.fn((target: typeof worker) => {
				target.intentionalStop = true;
			}),
			invalidateWorkerSessionInputPauses: vi.fn(),
			recoverUncertainWorkerOperations,
			deleteWorkerDescriptor,
		}) as {
			reclaimStaleWorkerRegistration(target: typeof worker): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
		expect(recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, true);
		expect(deleteWorkerDescriptor).toHaveBeenCalledWith(worker);
		expect(workers.has(worker.descriptor.workerId)).toBe(false);
	});

	it("retains a stale failed resident when strict cleanup cannot be proved", async () => {
		const worker = {
			descriptor: {
				workerId: "failed-resident-unverified",
				pid: 42,
				processStartId: "missing-start",
				lifecycle: "failed" as const,
			},
			intentionalStop: false,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const cleanupFailure = new Error("child process cleanup is unverified");
		const recoverUncertainWorkerOperations = vi.fn(async () => {
			throw cleanupFailure;
		});
		const deleteWorkerDescriptor = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			sessionInputPauses: new Map(),
			processIdentity: vi.fn(() => "gone"),
			persistWorkerStopTombstone: vi.fn((target: typeof worker) => {
				target.intentionalStop = true;
			}),
			invalidateWorkerSessionInputPauses: vi.fn(),
			recoverUncertainWorkerOperations,
			deleteWorkerDescriptor,
		}) as {
			reclaimStaleWorkerRegistration(target: typeof worker): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).rejects.toBe(cleanupFailure);
		expect(deleteWorkerDescriptor).not.toHaveBeenCalled();
		expect(workers.get(worker.descriptor.workerId)).toBe(worker);
	});

	it("stops only an identity-verified failed resident when a fresh create arrives", async () => {
		const worker = {
			descriptor: {
				workerId: "failed-live-resident",
				pid: 42,
				// Historical exact old-field records remain compatible.
				processStartId: `token:${"a".repeat(64)}`,
				lifecycle: "failed" as const,
			},
			intentionalStop: false,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			processIdentity: vi.fn(() => "current"),
			stopWorker,
		}) as {
			reclaimStaleWorkerRegistration(target: typeof worker, freshCreate?: boolean): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
		expect(stopWorker).not.toHaveBeenCalled();
		await expect(supervisor.reclaimStaleWorkerRegistration(worker, true)).resolves.toBe(true);
		expect(stopWorker).toHaveBeenCalledWith(worker, true, true);
	});

	it("retains a live worker with a numeric bare-proc legacy identity", async () => {
		vi.useFakeTimers();
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId?: string;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle?: string;
				consecutiveFailures: number;
				lastFailureAt?: string;
				lastError?: string;
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
			client?: { close(): void };
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			persistWorker: ReturnType<typeof vi.fn>;
			broadcastHeartbeatsChanged: ReturnType<typeof vi.fn>;
			log: ReturnType<typeof vi.fn>;
			assertRecoveryAllowed: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-unknown-identity",
				pid: process.pid,
				processStartId: "proc:42",
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(async () => {
				throw new Error("worker socket unavailable");
			}),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.runAllTimersAsync();
		await recovery;

		expect(supervisor.connectWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("failed");
	});

	it("continues startup recovery after live workers time out during adoption", async () => {
		type AdoptionWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId?: string;
				rootActiveSessionId: string;
				lifecycle?: string;
				consecutiveFailures: number;
				lastError?: string;
			};
		};
		const processStartId = getProcessStartId(process.pid);
		expect(processStartId).toBeDefined();
		const workers: AdoptionWorker[] = ["slow-verified", "slow-unverified", "healthy"].map((workerId) => ({
			descriptor: {
				workerId,
				pid: process.pid,
				...(workerId === "slow-unverified" ? {} : { processStartId: processStartId! }),
				rootActiveSessionId: `${workerId}-active`,
				consecutiveFailures: 0,
			},
		}));
		const pendingRecovery = new Promise<void>(() => {});
		const recoverWorker = vi.fn(() => pendingRecovery);
		const persistWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => {}),
			connectWorker: vi.fn(async () => {}),
			subscribeWorker: vi.fn(async () => {}),
			refreshWorkerSummaries: vi.fn(async (worker: AdoptionWorker) => {
				if (worker.descriptor.workerId.startsWith("slow")) {
					throw new DaemonWorkerProbeTimeoutError("Timed out waiting for daemon worker response to list");
				}
			}),
			recoverWorker,
			persistWorker,
			broadcastHeartbeatsChanged: vi.fn(),
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(worker: AdoptionWorker): Promise<void>;
		};

		await expect(
			Promise.all(workers.map((worker) => supervisor.adoptOrRecoverWorker(worker))),
		).resolves.toBeDefined();

		expect(recoverWorker).toHaveBeenCalledTimes(2);
		expect(workers.map((worker) => worker.descriptor.lifecycle)).toEqual(["recovering", "recovering", "ready"]);
		expect(persistWorker).toHaveBeenCalledTimes(3);
	});

	it("preserves authentication rejection outside the probe-timeout recovery path", async () => {
		const processStartId = getProcessStartId(process.pid);
		expect(processStartId).toBeDefined();
		const worker = {
			descriptor: {
				workerId: "worker-auth-rejected",
				pid: process.pid,
				processStartId: processStartId!,
				rootActiveSessionId: "active-auth",
				consecutiveFailures: 0,
				socketPath: "/tmp/worker-auth-rejected.sock",
				authenticationToken: "stale-token",
			},
			client: undefined,
		};
		const authError = new DaemonWorkerAuthenticationError(
			"Timed out connecting to daemon session worker: invalid token",
		);
		const connect = vi.spyOn(DaemonWorkerClient.prototype, "connect").mockResolvedValue(undefined);
		const hello = vi.spyOn(DaemonWorkerClient.prototype, "waitForHello").mockResolvedValue({} as never);
		const authenticate = vi.spyOn(DaemonWorkerClient.prototype, "authenticateWorker").mockRejectedValue(authError);
		const close = vi.spyOn(DaemonWorkerClient.prototype, "close").mockImplementation(() => undefined);
		const recoverWorker = vi.fn(async () => undefined);
		const persistWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			supervisorAuthenticationClaim: vi.fn(() => ({
				supervisorGeneration: "generation",
				supervisorPid: process.pid,
				supervisorSocketPath: "/tmp/supervisor.sock",
			})),
			recoverWorker,
			persistWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: typeof worker): Promise<void>;
		};

		try {
			await supervisor.adoptOrRecoverWorker(worker);

			expect(authenticate).toHaveBeenCalledOnce();
			expect(recoverWorker).toHaveBeenCalledWith(worker);
			expect(persistWorker).not.toHaveBeenCalled();
			expect(worker.descriptor).not.toHaveProperty("lifecycle", "recovering");
		} finally {
			connect.mockRestore();
			hello.mockRestore();
			authenticate.mockRestore();
			close.mockRestore();
		}
	});

	it("parks an unresponsive worker failed after the bounded probe rounds", () => {
		const worker = {
			descriptor: { workerId: "worker-stuck", pid: process.pid, rootActiveSessionId: "active-1" },
			deferredRecoveryRounds: 10,
		};
		const persistWorker = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			persistWorker,
			markWorkerRosterEntries: vi.fn(),
			log: vi.fn(),
		}) as { deferWorkerRecovery(target: typeof worker, error: Error): void };

		supervisor.deferWorkerRecovery(worker, new Error("still silent"));

		expect(worker.descriptor).toMatchObject({ lifecycle: "failed" });
		expect((worker as { deferredRecovery?: unknown }).deferredRecovery).toBeUndefined();
		expect(persistWorker).toHaveBeenCalled();
	});

	it.each([
		{ name: "verified", hasProcessIdentity: true, error: "Timed out waiting for daemon worker hello" },
		{ name: "identity-unavailable", hasProcessIdentity: false, error: "worker socket unavailable" },
	])("defers recovery without replacing a live $name worker", async ({ hasProcessIdentity, error }) => {
		vi.useFakeTimers();
		const processStartId = hasProcessIdentity ? getProcessStartId(process.pid) : undefined;
		if (hasProcessIdentity) expect(processStartId).toBeDefined();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId?: string;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
				lifecycle?: string;
				consecutiveFailures: number;
			};
			intentionalStop: boolean;
			stopRevision: number;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: `worker-${hasProcessIdentity ? "verified" : "unknown"}-identity`,
				pid: process.pid,
				...(processStartId ? { processStartId } : {}),
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(async () => {
				throw hasProcessIdentity ? new DaemonWorkerProbeTimeoutError(error) : new Error(error);
			}),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
			persistWorker: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			deferWorkerRecovery: vi.fn(),
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as {
			recoverWorker(target: RecoveryWorker): Promise<void>;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			deferWorkerRecovery: ReturnType<typeof vi.fn>;
		};

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(6250);
		await recovery;

		expect(supervisor.connectWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverUncertainWorkerOperations).not.toHaveBeenCalled();
		expect(supervisor.launchWorker).not.toHaveBeenCalled();
		expect(supervisor.deferWorkerRecovery).toHaveBeenCalledWith(worker, expect.any(Error));
		expect(worker.descriptor.lifecycle).toBe("recovering");
	});

	it("reports a stop-tombstoned worker as stopping, not ready", () => {
		const worker = {
			descriptor: {
				workerId: "worker-tombstoned",
				pid: process.pid,
				lifecycle: "ready" as const,
				stopRequestedAt: new Date().toISOString(),
			},
			client: {},
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("stopping");
	});

	it("never reports a disconnected worker as ready", () => {
		const worker = {
			descriptor: { workerId: "worker-disconnected", pid: process.pid, lifecycle: "ready" as const },
			client: undefined,
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("recovering");
	});

	it("reports a connected ready worker as ready", () => {
		const worker = {
			descriptor: { workerId: "worker-live", pid: process.pid, lifecycle: "ready" as const },
			client: {},
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {}) as {
			effectiveWorkerState(target: object): string;
		};

		expect(supervisor.effectiveWorkerState(worker)).toBe("ready");
	});

	it("keeps stopping workers listed with an honest state for busy-daemon checks", async () => {
		const makeWorker = (workerId: string, stopRequestedAt?: string) => ({
			descriptor: {
				workerId,
				pid: process.pid,
				rootActiveSessionId: `${workerId}-active`,
				lifecycle: "ready" as const,
				...(stopRequestedAt ? { stopRequestedAt } : {}),
			},
			client: {},
			intentionalStop: false,
			summaries: new Map([
				[
					`${workerId}-active`,
					{
						id: `${workerId}-active`,
						activeSessionId: `${workerId}-active`,
						sessionId: `${workerId}-session`,
						cwd: "/tmp",
					} as unknown as SessionSummary,
				],
			]),
		});
		const liveWorker = makeWorker("worker-live");
		const stoppingWorker = makeWorker("worker-stopping", new Date().toISOString());
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([
				[liveWorker.descriptor.workerId, liveWorker],
				[stoppingWorker.descriptor.workerId, stoppingWorker],
			]),
			clients: new Set(),
			refreshWorkerSummaries: vi.fn(async () => {}),
			log: vi.fn(),
		}) as {
			handleList(
				client: object,
				command: { id: string; type: "list" },
			): Promise<{
				success: boolean;
				data?: { sessions: Array<{ activeSessionId?: string; id: string; workerState?: string }> };
			}>;
		};
		seedSupervisorRoster(supervisor, liveWorker, stoppingWorker);

		const response = await supervisor.handleList({}, { id: "list-1", type: "list" });

		expect(response.success).toBe(true);
		const sessions = response.data?.sessions ?? [];
		expect(sessions.map((session) => [session.activeSessionId ?? session.id, session.workerState]).sort()).toEqual([
			["worker-live-active", "ready"],
			["worker-stopping-active", "stopping"],
		]);
	});

	it("adopts a tombstoned worker through identity-aware stop handling", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-stop",
				pid: 111_123,
				processStartId: "proc:123",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			stopWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		try {
			await supervisor.adoptOrRecoverWorker(worker);

			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, true);
		} finally {
			killSpy.mockRestore();
		}
	});

	it("persists exact authority after authentication before an adoption stop", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-legacy",
				pid: process.pid,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: false,
			} as { processStartId?: string; authorityProcessStartId?: string },
		};
		const stopOrder: string[] = [];
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker: vi.fn(async () => {
				stopOrder.push("connect");
			}),
			upgradeAuthenticatedWorkerProcessAuthority: vi.fn(async () => {
				worker.descriptor.authorityProcessStartId = getProcessStartId(process.pid);
				stopOrder.push("persist");
				return true;
			}),
			stopWorker: vi.fn(async () => {
				stopOrder.push("stop");
			}),
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};

		await supervisor.adoptOrRecoverWorker(worker);

		const observedIdentity = getProcessStartId(process.pid);
		expect(worker.descriptor.authorityProcessStartId).toBe(observedIdentity);
		expect(worker.descriptor.processStartId).toBeUndefined();
		expect(stopOrder).toEqual(["connect", "persist", "stop"]);
	});

	it("keeps an unverifiable identity untrusted when the adoption connect fails", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-adopted-unverified",
				pid: process.pid,
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: false,
			} as { processStartId?: string; authorityProcessStartId?: string },
		};
		const persistWorker = vi.fn();
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			assertRecoveryAllowed: vi.fn(async () => undefined),
			connectWorker: vi.fn(async () => {
				throw new Error("connect refused");
			}),
			persistWorker,
			stopWorker,
			log: vi.fn(),
		}) as {
			adoptOrRecoverWorker(target: object): Promise<void>;
		};

		await supervisor.adoptOrRecoverWorker(worker);

		// The pid could belong to anything; never adopt an identity the socket
		// handshake did not confirm.
		expect(worker.descriptor.processStartId).toBeUndefined();
		expect(worker.descriptor.authorityProcessStartId).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
	});

	it("finalizes a timed-out stop once the worker process dies", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-timed-out-stop",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockImplementation(() => alive);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;
			expect(finalization).toBeDefined();

			await vi.advanceTimersByTimeAsync(500);
			expect(stopWorker).not.toHaveBeenCalled();

			alive = false;
			await vi.advanceTimersByTimeAsync(500);
			await finalization;

			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
			expect(worker.stopFinalization).toBeUndefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("escalates a stuck stop to SIGKILL before finalizing", async () => {
		const identity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", identity.argument], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) throw new Error("Could not start exact-identity test process");
		const childProcessStartId = await waitForExactChildProcessStartId(child.pid);
		const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-stuck-stop",
				pid: child.pid,
				authorityProcessStartId: childProcessStartId,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
				archiveOnStop: true,
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") alive = false;
		});
		workerLaunchTestState.processIdentityAuthority = () => (alive ? "exact-live" : "exact-dead");
		workerLaunchTestState.exactIdentityMatch = () => alive;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(10_000);
			await finalization;

			expect(killSpy).toHaveBeenCalledWith(worker.descriptor.pid, "SIGKILL");
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, true);
		} finally {
			aliveSpy.mockRestore();
			killSpy.mockRestore();
			workerLaunchTestState.exactIdentityMatch = undefined;
			workerLaunchTestState.processIdentityAuthority = undefined;
			if (matchesExactProcessIdentity(child.pid, childProcessStartId)) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			await childClosed;
		}
	});

	it("never follows a relaunched worker pid after a retry rescinds the stop", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-relaunched",
				pid: 111_111,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
			},
			intentionalStop: true,
			stopRevision: 3,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			// An explicit retry rescinds the stop and relaunches with a new pid
			// while the old process is still wedged.
			await vi.advanceTimersByTimeAsync(1000);
			worker.descriptor.stopRequestedAt = undefined;
			worker.intentionalStop = false;
			worker.stopRevision = 4;
			worker.descriptor.pid = 222_222;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The healthy relaunched worker must never be signalled or stopped.
			expect(killSpy).not.toHaveBeenCalledWith(222_222, "SIGKILL");
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("treats a recycled pid as gone instead of killing its new owner", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-recycled-pid",
				pid: 111_112,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:100",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		// The pid is alive, but it now belongs to an unrelated process.
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		workerLaunchTestState.processIdentityAuthority = () => "exact-dead";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The original worker is gone, so the stop is finalized without ever
			// signalling the unrelated pid owner.
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("aborts stale stop cleanup when the worker was relaunched during an await", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-relaunched-during-stop",
				pid: 111_115,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			reclaimStoppedWorkerCronLock: vi.fn(),
			// Archival yields, and a retry relaunches the worker meanwhile.
			finalizeArchivedWorkerStop: vi.fn(async () => {
				worker.descriptor.pid = 222_222;
				worker.descriptor.stopRequestedAt = undefined;
			}),
			deleteWorkerDescriptor: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as unknown as {
			stopWorker(
				target: object,
				removeDescriptor: boolean,
				force?: boolean,
				archiveSession?: boolean,
			): Promise<void>;
			deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.stopWorker(worker, true, true, true)).rejects.toThrow("was relaunched during stop");

			// The relaunched worker's registration and descriptor must survive.
			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(supervisor.deleteWorkerDescriptor).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("aborts stale stop cleanup when the stop is rescinded before the relaunch lands", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-rescinded-during-stop",
				pid: 111_120,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
				archiveOnStop: true,
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			reclaimStoppedWorkerCronLock: vi.fn(),
			// A retry rescinds the tombstone while archival yields, before
			// recoverWorker has assigned the successor pid.
			finalizeArchivedWorkerStop: vi.fn(async () => {
				worker.descriptor.stopRequestedAt = undefined;
			}),
			deleteWorkerDescriptor: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as unknown as {
			stopWorker(
				target: object,
				removeDescriptor: boolean,
				force?: boolean,
				archiveSession?: boolean,
			): Promise<void>;
			deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.stopWorker(worker, true, true, true)).rejects.toThrow("was relaunched during stop");

			// The revived registration and descriptor must survive for recovery.
			expect(workers.has(worker.descriptor.workerId)).toBe(true);
			expect(supervisor.deleteWorkerDescriptor).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("never signals an identity-less worker pid during a forced stop", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-force-missing-identity",
				pid: 111_122,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			summaries: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: true,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			persistWorker: vi.fn(),
			persistWorkerStopTombstone: vi.fn(),
			scheduleWorkerStopFinalization: vi.fn(),
			broadcastHeartbeatsChanged: vi.fn(),
		}) as unknown as {
			stopWorker(target: object, removeDescriptor: boolean, force?: boolean): Promise<void>;
			scheduleWorkerStopFinalization: ReturnType<typeof vi.fn>;
		};
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			const stopping = supervisor.stopWorker(worker, true, true).then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(2000);

			const error = await stopping;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("Session worker worker-force-missing-identity did not stop");
			expect(killSpy).not.toHaveBeenCalled();
			expect(supervisor.scheduleWorkerStopFinalization).toHaveBeenCalledWith(worker);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("re-verifies identity at SIGKILL time even within the throttle window", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-kill-window-recycle",
				pid: 111_118,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:118",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		// The worker is current on the throttled polls, but the pid is recycled
		// by the time the SIGKILL deadline arrives.
		let recycled = false;
		workerLaunchTestState.processIdentityAuthority = () => (recycled ? "exact-dead" : "exact-live");
		workerLaunchTestState.exactIdentityMatch = () => !recycled;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			await vi.advanceTimersByTimeAsync(4900);
			recycled = true;
			await vi.advanceTimersByTimeAsync(2000);

			// The fresh check at signal time sees the recycled pid and holds fire.
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("retries SIGKILL after a transient identity outage at the deadline", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-kill-retry",
				pid: 111_119,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:119",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		let alive = true;
		let identityObservable = false;
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") alive = false;
		});
		workerLaunchTestState.processIdentityAuthority = () =>
			!alive ? "exact-dead" : identityObservable ? "exact-live" : "retained";
		workerLaunchTestState.exactIdentityMatch = () => alive && identityObservable;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(8000);
			expect(killSpy).not.toHaveBeenCalled();

			// ...but once identity is observable again, escalation still fires.
			identityObservable = true;
			await vi.advanceTimersByTimeAsync(5000);
			await finalization;
			expect(killSpy).toHaveBeenCalledWith(worker.descriptor.pid, "SIGKILL");
			expect(stopWorker).toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("keeps waiting when process identity is transiently unobservable", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-unknown-identity-stop",
				pid: 111_114,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:114",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		// Identity observation fails transiently (e.g. ps unavailable).
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);

			await vi.advanceTimersByTimeAsync(20_000);

			// The possibly-live worker is neither signalled nor cleaned up.
			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
			expect(worker.stopFinalization).toBeDefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("never SIGKILLs an identity-less worker pid", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-missing-identity",
				pid: 111_121,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		const killSpy = vi.spyOn(childProcessModule, "signalProcessGroupOrProcess").mockImplementation(() => {});
		workerLaunchTestState.processIdentityAuthority = () => "retained";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			supervisor.scheduleWorkerStopFinalization(worker);

			await vi.advanceTimersByTimeAsync(20_000);

			expect(killSpy).not.toHaveBeenCalled();
			expect(stopWorker).not.toHaveBeenCalled();
			expect(worker.stopFinalization).toBeDefined();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
			killSpy.mockRestore();
		}
	});

	it("retries finalization after a transient cleanup failure", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-transient-cleanup",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi
			.fn(async () => {
				workers.delete(worker.descriptor.workerId);
			})
			.mockImplementationOnce(async () => {
				throw new Error("archive temporarily unavailable");
			});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			await vi.advanceTimersByTimeAsync(20_000);
			await finalization;

			// The first attempt failed transiently; the registration is still
			// cleaned up by a retry instead of being stranded forever.
			expect(stopWorker).toHaveBeenCalledTimes(2);
			expect(workers.size).toBe(0);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("leaves a rescinded stop to the retry flow instead of finalizing it", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-rescinded-stop",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString() as string | undefined,
			},
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		let alive = true;
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			scheduleWorkerStopFinalization(target: object): void;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockImplementation(() => alive);
		try {
			supervisor.scheduleWorkerStopFinalization(worker);
			const finalization = worker.stopFinalization;

			// An explicit retry revives the worker while its process is exiting.
			worker.descriptor.stopRequestedAt = undefined;
			worker.intentionalStop = false;
			alive = false;
			await vi.advanceTimersByTimeAsync(500);
			await finalization;

			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("reclaims a stale tombstoned registration whose process is gone", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-stale-registration",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("reclaims a stale registration with a distinguishable replacement generation by another process", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-recycled-registration",
				pid: 111_113,
				authorityProcessStartId: "proc:11111111-1111-1111-1111-111111111111:113",
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		// The pid is alive, but a distinguishable generation owns it now.
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(true);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		workerLaunchTestState.processIdentityAuthority = () => "exact-dead";
		workerLaunchTestState.exactIdentityMatch = () => false;
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(true);
			expect(stopWorker).toHaveBeenCalledWith(worker, true, true, false);
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("waits for an in-flight stop finalization instead of stopping twice", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-finalizing",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		let releaseFinalization!: () => void;
		worker.stopFinalization = new Promise<void>((resolveFinalization) => {
			releaseFinalization = () => {
				workers.delete(worker.descriptor.workerId);
				resolveFinalization();
			};
		});
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};

		const childProcessModule = await import("../src/utils/child-process.js");
		const existsSpy = vi.spyOn(childProcessModule, "processIdExists").mockReturnValue(false);
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const reclaim = supervisor.reclaimStaleWorkerRegistration(worker);
			releaseFinalization();

			// The reclaim defers to the finalizer's cleanup instead of duplicating it.
			await expect(reclaim).resolves.toBe(true);
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
			aliveSpy.mockRestore();
		}
	});

	it("fails resume honestly when confirmed-dead cleanup outlasts the bounded wait", async () => {
		vi.useFakeTimers();
		const worker = {
			descriptor: {
				workerId: "worker-slow-cleanup",
				pid: 111_117,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			// Cleanup hangs past the bounded reclaim wait.
			stopWorker: vi.fn(() => new Promise<void>(() => {})),
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const reclaim = supervisor.reclaimStaleWorkerRegistration(worker);
			const outcome = reclaim.then(
				() => "reused",
				() => "failed",
			);
			await vi.advanceTimersByTimeAsync(60_000);

			// The dead registration is never handed back to the resume path.
			await expect(outcome).resolves.toBe("failed");
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("shares one stop between concurrent resume reclaims", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-concurrent-reclaim",
				pid: 111_116,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
			stopFinalization: undefined as Promise<void> | undefined,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(worker.descriptor.workerId);
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			shuttingDown: false,
			stopWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(false);
		try {
			const results = await Promise.all([
				supervisor.reclaimStaleWorkerRegistration(worker),
				supervisor.reclaimStaleWorkerRegistration(worker),
			]);

			expect(results).toEqual([true, true]);
			// Both concurrent resumes share the single-flighted finalizer stop.
			expect(stopWorker).toHaveBeenCalledTimes(1);
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("does not reclaim a stopping worker whose process is still alive", async () => {
		const worker = {
			descriptor: {
				workerId: "worker-still-alive",
				pid: process.pid,
				rootActiveSessionId: "active-1",
				stopRequestedAt: new Date().toISOString(),
			},
			client: undefined,
			recovery: undefined,
			intentionalStop: true,
			stopRevision: 0,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};
		const childProcessModule = await import("../src/utils/child-process.js");
		const aliveSpy = vi.spyOn(childProcessModule, "isProcessAlive").mockReturnValue(true);
		try {
			await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
			expect(stopWorker).not.toHaveBeenCalled();
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("does not reclaim a healthy connected worker", async () => {
		const worker = {
			descriptor: { workerId: "worker-healthy", pid: process.pid, rootActiveSessionId: "active-1" },
			client: {},
			recovery: undefined,
			intentionalStop: false,
			stopRevision: 0,
		};
		const stopWorker = vi.fn(async () => {});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		}) as {
			reclaimStaleWorkerRegistration(target: object): Promise<boolean>;
		};

		await expect(supervisor.reclaimStaleWorkerRegistration(worker)).resolves.toBe(false);
		expect(stopWorker).not.toHaveBeenCalled();
	});

	it("ignores malformed persisted worker descriptors", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-test-"));
		try {
			writeFileSync(
				join(descriptorDir, "malformed.json"),
				`${JSON.stringify({
					version: 1,
					supervisorSocketPath: "/tmp/supervisor.sock",
					workerId: "worker-1",
					rootActiveSessionId: "active-1",
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(0);
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("merges persisted host settings into fresh runtime defaults", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-config-merge-"));
		const descriptorDir = join(root, "workers");
		const socketPath = join(root, "supervisor.sock");
		const agentDir = join(root, "agent");
		mkdirSync(descriptorDir, { recursive: true });
		writeFileSync(
			join(descriptorDir, "supervisor-config"),
			JSON.stringify({
				version: 1,
				socketPath: `${root}//supervisor.sock`,
				defaultSessionConfig: { agentDir, cwd: "/persisted/cwd", telemetryDisabled: true },
			}),
		);

		try {
			const supervisor = new DaemonSupervisor(socketPath, {
				descriptorDir,
				defaultSessionConfig: {
					agentDir,
					cwd: "/fresh/cwd",
					provider: "fresh-provider",
					model: "fresh-model",
					apiKey: "fresh-key",
				},
			});
			const config = (supervisor as unknown as { defaultSessionConfig: Record<string, unknown> })
				.defaultSessionConfig;

			expect(config).toMatchObject({
				agentDir,
				cwd: "/persisted/cwd",
				telemetryDisabled: true,
				provider: "fresh-provider",
				model: "fresh-model",
				apiKey: "fresh-key",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("migrates v1 descriptors by lifting only safe host policy fields", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-v1-migration-"));
		const descriptorPath = join(descriptorDir, "worker-v1.json");
		try {
			writeFileSync(
				descriptorPath,
				`${JSON.stringify({
					version: 1,
					workerId: "worker-v1",
					pid: 42,
					socketPath: canonicalDaemonWorkerSocketPath("/tmp/supervisor.sock", "worker-v1"),
					recoveryJournalPath: join(descriptorDir, "worker-v1.recovery.jsonl"),
					supervisorSocketPath: "/tmp/supervisor.sock",
					authenticationToken: "local-token",
					rootActiveSessionId: "active-v1",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					lifecycle: "ready",
					createCommand: {
						type: "create",
						config: {
							sessionDir: "/safe/sessions",
							telemetryDisabled: true,
							apiKey: "secret-api-key",
							extensionFlagValues: { providerSecretKey: "secret-provider-key" },
						},
						launchEnv: { PROVIDER_TOKEN: "secret-env" },
					},
					launchEnv: { PROVIDER_TOKEN: "secret-top-level-env" },
					consecutiveFailures: 0,
				})}\n`,
			);
			const workers = new Map<string, { descriptor: Record<string, unknown> }>();
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers,
				log: vi.fn(),
			}) as {
				loadWorkerDescriptors(): void;
				persistWorker(target: unknown): void;
			};

			supervisor.loadWorkerDescriptors();

			const migrated = JSON.parse(readFileSync(descriptorPath, "utf8"));
			expect(migrated).toMatchObject({
				version: 2,
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
				createCommand: { type: "create" },
			});
			expect(JSON.stringify(migrated)).not.toContain("secret-");
			const runtimeWorker = workers.get("worker-v1");
			expect(runtimeWorker?.descriptor).toMatchObject({
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
			});
			if (!runtimeWorker) throw new Error("missing migrated worker");
			runtimeWorker.descriptor.lifecycle = "failed";
			runtimeWorker.descriptor.lastError = "secret-runtime-diagnostic";
			supervisor.persistWorker(runtimeWorker);
			expect(runtimeWorker.descriptor.lastError).toBe("secret-runtime-diagnostic");
			expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({
				lastError: "Waiting for a client with fresh runtime context",
			});
			expect(readFileSync(descriptorPath, "utf8")).not.toContain("secret-runtime-diagnostic");
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("adopts a legacy lexical-hash worker root through physical supervisor socket identity", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-root-"));
		const agentDir = join(root, "agent");
		const physicalSocketDir = join(root, "physical-sockets");
		const lexicalSocketDir = join(root, "socket-alias");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(physicalSocketDir, { recursive: true });
		symlinkSync(physicalSocketDir, lexicalSocketDir, "dir");
		const lexicalSupervisorSocket = join(lexicalSocketDir, "supervisor.sock");
		const physicalSupervisorSocket = normalizeSocketPath(lexicalSupervisorSocket);
		const legacyKey = createHash("sha256").update(resolve(lexicalSupervisorSocket)).digest("hex").slice(0, 12);
		const legacyDir = join(agentDir, "daemon-workers", legacyKey);
		const canonicalDir = defaultDaemonWorkerDescriptorDir(agentDir, lexicalSupervisorSocket);
		expect(legacyDir).not.toBe(canonicalDir);
		mkdirSync(legacyDir, { recursive: true });
		mkdirSync(canonicalDir, { recursive: true });
		const now = new Date().toISOString();
		const workerId = "worker-legacy";
		const orphanPath = join(legacyDir, `${workerId}.orphans.jsonl`);
		const orphanAuthority = initializeOrphanProcessJournal(orphanPath);
		const descriptorPath = join(legacyDir, `${workerId}.json`);
		writeFileSync(
			descriptorPath,
			`${JSON.stringify({
				version: 2,
				workerId,
				pid: 999_999,
				socketPath: join(physicalSocketDir, `worker-${legacyKey}-${workerId.slice(0, 12)}.sock`),
				recoveryJournalPath: join(legacyDir, `${workerId}.recovery.jsonl`),
				orphanProcessJournalPath: orphanPath,
				orphanProcessJournalGeneration: orphanAuthority.generation,
				supervisorSocketPath: lexicalSupervisorSocket,
				authenticationToken: "token-legacy",
				rootActiveSessionId: "active-legacy",
				createdAt: now,
				updatedAt: now,
				lifecycle: "ready",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			})}\n`,
		);
		const workers = new Map<string, { descriptorPath: string; descriptor: DaemonWorkerDescriptor }>();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			descriptorDir: canonicalDir,
			defaultSessionConfig: { agentDir },
			socketPath: physicalSupervisorSocket,
			workers,
			log: vi.fn(),
		}) as { loadWorkerDescriptors(): void };

		try {
			supervisor.loadWorkerDescriptors();
			expect(workers.get(workerId)?.descriptorPath).toBe(descriptorPath);
			expect(workers.get(workerId)?.descriptor.supervisorSocketPath).toBe(lexicalSupervisorSocket);
			expect(readdirSync(canonicalDir).filter((name) => name.endsWith(".json"))).toEqual([]);
			expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({
				workerId,
				supervisorSocketPath: lexicalSupervisorSocket,
				lifecycle: "recovering",
			});

			const exact = `token:${"a".repeat(64)}`;
			const oldOnly = {
				...JSON.parse(readFileSync(descriptorPath, "utf8")),
				processStartId: exact,
			};
			delete oldOnly.authorityProcessStartId;
			writeFileSync(descriptorPath, `${JSON.stringify(oldOnly)}\n`);
			const duplicatePath = join(canonicalDir, `${workerId}.json`);
			for (const authorityProcessStartId of [exact, `token:${"b".repeat(64)}`]) {
				const duplicate = { ...oldOnly, authorityProcessStartId };
				delete duplicate.processStartId;
				writeFileSync(duplicatePath, `${JSON.stringify(duplicate)}\n`);
				const oldBytes = readFileSync(descriptorPath);
				const duplicateBytes = readFileSync(duplicatePath);
				const splitWorkers = new Map();
				const splitSupervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
					descriptorDir: canonicalDir,
					defaultSessionConfig: { agentDir },
					socketPath: physicalSupervisorSocket,
					workers: splitWorkers,
					log: vi.fn(),
				}) as { loadWorkerDescriptors(): void };
				expect(() => splitSupervisor.loadWorkerDescriptors()).toThrow("Split worker authority");
				expect(splitWorkers.size).toBe(0);
				expect(readFileSync(descriptorPath)).toEqual(oldBytes);
				expect(readFileSync(duplicatePath)).toEqual(duplicateBytes);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("adopts persisted worker descriptors recorded with a non-canonical supervisor socket path", () => {
		if (process.platform === "win32") {
			return;
		}
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-heal-"));
		try {
			const now = new Date().toISOString();
			writeFileSync(
				join(descriptorDir, "worker-1.json"),
				`${JSON.stringify({
					version: 2,
					workerId: "worker-1",
					pid: 999_999,
					socketPath: join(descriptorDir, "worker-1.sock"),
					recoveryJournalPath: join(descriptorDir, "worker-1.recovery.jsonl"),
					supervisorSocketPath: "/tmp//supervisor.sock",
					authenticationToken: "token-1",
					rootActiveSessionId: "active-1",
					createdAt: now,
					updatedAt: now,
					lifecycle: "ready",
					sessionDir: "/safe/sessions",
					telemetryDisabled: true,
					createCommand: {
						type: "create",
						config: { cwd: descriptorDir, agentDir: descriptorDir, apiKey: "secret-api-key" },
						launchEnv: { PROVIDER_TOKEN: "secret-command-env" },
					},
					launchEnv: { PROVIDER_TOKEN: "secret-worker-env" },
					consecutiveFailures: 0,
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(1);
			const loaded = supervisor.workers.get("worker-1") as {
				descriptor: Record<string, unknown>;
			};
			expect(loaded.descriptor).toMatchObject({
				version: 2,
				supervisorSocketPath: normalizeSocketPath("/tmp/supervisor.sock"),
				sessionDir: "/safe/sessions",
				telemetryDisabled: true,
			});
			expect(JSON.stringify(loaded.descriptor)).not.toContain("secret-");
			const persisted = readFileSync(join(descriptorDir, "worker-1.json"), "utf8");
			expect(persisted).not.toContain("secret-");
			expect(JSON.parse(persisted)).toMatchObject({
				version: 2,
				supervisorSocketPath: normalizeSocketPath("/tmp/supervisor.sock"),
			});
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("derives the same worker descriptor namespace for equivalent socket path spellings", () => {
		if (process.platform === "win32") {
			return;
		}
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-namespace-"));
		try {
			const canonical = new DaemonSupervisor(join(root, "supervisor.sock"), {
				defaultSessionConfig: { cwd: root, agentDir: root },
			}) as unknown as { descriptorDir: string };
			const doubled = new DaemonSupervisor(`${root}//supervisor.sock`, {
				defaultSessionConfig: { cwd: root, agentDir: root },
			}) as unknown as { descriptorDir: string };

			expect(doubled.descriptorDir).toBe(canonical.descriptorDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("seeds compact attach streaming from the in-flight assistant message", async () => {
		const assistant = (text: string): AgentMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const activeSessionId = "active-1";
		const finalizedMessage = assistant("finalized");
		const streamingMessage = assistant("in flight");
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "working",
			isSessionActive: true,
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: true,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			streamingMessage,
		};
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [finalizedMessage] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			client: {},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed },
			syncWorkerExtensionUi: vi.fn(async () => {}),
		}) as {
			attachClient(
				client: {
					id: string;
					capabilities: Set<string>;
					supportsExtensionUi: boolean;
					attachedActiveSessionIds: Set<string>;
				},
				command: { type: "attach"; activeSessionId: string },
			): Promise<unknown>;
		};
		seedSupervisorRoster(supervisor, worker);

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		expect(seed).toHaveBeenCalledWith(activeSessionId, streamingMessage);
	});

	it("reconstructs a client-owned recovery command from fresh attach context", async () => {
		const activeSessionId = "active-owned-recovery";
		const worker = {
			descriptor: {
				workerId: "worker-owned-recovery",
				ownerClientId: "client-1",
				rootActiveSessionId: activeSessionId,
				lifecycle: "failed",
				consecutiveFailures: 1,
				telemetryDisabled: true,
				createCommand: { type: "create" as const, sessionPath: "/tmp/session.jsonl" },
			},
			summaries: new Map(),
			intentionalStop: false,
			stopRevision: 0,
			launchEnv: undefined as Record<string, string> | undefined,
			transientCreateCommand: undefined as Record<string, unknown> | undefined,
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const recoverWorker = vi.fn(async () => {
			throw new Error("stop after reconstruction");
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			protocolClientIds: new WeakMap(),
			persistWorker: vi.fn(),
			recoverWorker,
		}) as {
			attachClient(
				attachClient: typeof client,
				command: {
					type: "attach";
					activeSessionId: string;
					recoveryConfig: { cwd: string };
					launchEnv: Record<string, string>;
					env: Record<string, string>;
				},
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient(client, {
				type: "attach",
				activeSessionId,
				recoveryConfig: { cwd: "/tmp/fresh-owner" },
				launchEnv: { OWNER_SECRET: "fresh" },
				env: { HERDR_PANE_ID: "pane-1" },
			}),
		).rejects.toThrow("stop after reconstruction");
		expect(worker.transientCreateCommand).toEqual({
			type: "create",
			sessionPath: "/tmp/session.jsonl",
			config: { cwd: "/tmp/fresh-owner", telemetryDisabled: true },
			env: { HERDR_PANE_ID: "pane-1" },
			launchEnv: { OWNER_SECRET: "fresh" },
			lifecycle: "client_owned",
		});
		expect(worker.launchEnv).toEqual({ OWNER_SECRET: "fresh" });
		expect(recoverWorker).toHaveBeenCalledWith(worker);
	});

	it("rejects an opted-out attach to a telemetry-enabled worker", async () => {
		const activeSessionId = "active-telemetry-enabled";
		const summary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-telemetry-enabled",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		} satisfies SessionSummary;
		const worker = {
			descriptor: {
				workerId: "worker-telemetry-enabled",
				lifecycle: "ready",
				pid: 1234,
				createCommand: { type: "create", config: {} },
			},
			summaries: new Map([[activeSessionId, summary]]),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
		}) as {
			attachClient(
				attachClient: typeof client,
				command: { type: "attach"; activeSessionId: string; telemetryDisabled?: true },
			): Promise<unknown>;
		};
		seedSupervisorRoster(supervisor, worker);

		await expect(
			supervisor.attachClient(client, { type: "attach", activeSessionId, telemetryDisabled: true }),
		).rejects.toThrow("Cannot attach to this active agent while telemetry is disabled");
		expect(client.attachedActiveSessionIds).toEqual(new Set());
	});

	it("routes startup worker connections through the bounded adoption semaphore", async () => {
		const run = vi.fn(async () => {
			throw new Error("startup connection was gated");
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			startupWorkerConnectionSemaphore: { run },
		}) as {
			connectWorker(worker: { descriptor: { socketPath: string } }, timeoutMs: number): Promise<unknown>;
		};

		await expect(supervisor.connectWorker({ descriptor: { socketPath: "/tmp/worker.sock" } }, 100)).rejects.toThrow(
			"startup connection was gated",
		);
		expect(run).toHaveBeenCalledOnce();
	});

	it("reports a known descriptor as recovering instead of an unknown session", async () => {
		const activeSessionId = "recovering-root-active";
		const worker = {
			descriptor: {
				workerId: "recovering-worker",
				rootActiveSessionId: activeSessionId,
				rootSessionId: "recovering-root-session",
				lifecycle: "recovering",
				pid: 1234,
				createCommand: { type: "create", config: {} },
			},
			summaries: new Map(),
		};
		const client = { id: "client-1" };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			protocolClientIds: new WeakMap(),
			refreshWorkerSummaries: vi.fn(async () => undefined),
		}) as {
			findWorkerForClient(findClient: typeof client, selector: string): Promise<unknown>;
		};

		await expect(supervisor.findWorkerForClient(client, activeSessionId)).rejects.toThrow(
			"Session worker is recovering",
		);
	});

	it("does not reveal an owned session's telemetry policy to another client", async () => {
		const activeSessionId = "private-owned-active";
		const worker = {
			descriptor: {
				workerId: "private-owned-worker",
				ownerClientId: "owner-client",
				rootActiveSessionId: activeSessionId,
				lifecycle: "ready",
				pid: 1234,
				createCommand: { type: "create", config: {} },
			},
		};
		const client = {
			id: "other-client",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			protocolClientIds: new Map(),
		}) as {
			attachClient(
				attachClient: typeof client,
				command: { type: "attach"; activeSessionId: string; telemetryDisabled?: true },
			): Promise<unknown>;
		};

		await expect(
			supervisor.attachClient(client, { type: "attach", activeSessionId, telemetryDisabled: true }),
		).rejects.toThrow(`Unknown active session: ${activeSessionId}`);
	});

	it("catches up only after worker events are skipped behind a backpressured write", async () => {
		const activeSessionId = "active-backpressure";
		const writes: string[] = [];
		const write = vi.fn((data: unknown) => {
			writes.push(String(data));
			return false;
		});
		const client = {
			id: "client-1",
			socket: { destroyed: false, write },
			attachedActiveSessionIds: new Set([activeSessionId]),
			catchupActiveSessionIds: new Set<string>(),
			backpressured: false,
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as unknown as DaemonSocketClient;
		const worker = {
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			duplicateIncomingTranscriptChunkIndexes: new Map(),
			snapshotTransferFrames: new Map(),
		};
		const catchUpClient = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set([client]),
			streamReconstructor: { observe: vi.fn() },
			catchUpClient,
			invalidateWorkerSnapshot: vi.fn(),
		}) as {
			handleWorkerFrame(residentWorker: typeof worker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		const frame = (error: string, extensionPath: string): PrivateFrame<DaemonWorkerFrameHeader> => ({
			header: { kind: "outbound", outboundType: "extension_error", activeSessionId },
			payload: Buffer.from(
				`${JSON.stringify({ type: "extension_error", activeSessionId, extensionPath, event: "load", error })}\n`,
			),
		});

		supervisor.handleWorkerFrame(worker, frame("first", "x".repeat(1024 * 1024)));

		expect(client.backpressured).toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain('"error":"first"');

		supervisor.handleWorkerFrame(worker, frame("skipped", "/tmp/extension.ts"));

		expect(writes).toHaveLength(1);
		expect(client.catchupActiveSessionIds).toEqual(new Set([activeSessionId]));
		expect(catchUpClient).not.toHaveBeenCalled();
	});

	it("subscribes to worker updates with chunked snapshots", async () => {
		type SubscriptionWorker = {
			client: { requestWorker: (command: unknown) => Promise<{ success: boolean }> };
		};
		const requestWorker = vi.fn(async () => ({ success: true }));
		const worker: SubscriptionWorker = { client: { requestWorker } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set(),
		}) as {
			subscribeWorker(worker: SubscriptionWorker, activeSessionId: string): Promise<void>;
		};

		await supervisor.subscribeWorker(worker, "active-1");

		expect(requestWorker).toHaveBeenCalledWith({
			type: "worker_subscribe",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi: false,
		});
	});

	it("does not retain an attachment when snapshot loading fails", async () => {
		type AttachClient = {
			id: string;
			capabilities: Set<string>;
			supportsExtensionUi: boolean;
			attachedActiveSessionIds: Set<string>;
		};
		const activeSessionId = "active-failed-attach";
		const summary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "session-failed-attach",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		} satisfies SessionSummary;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			client: {
				request: vi.fn(async () => {
					throw new Error("snapshot failed");
				}),
			},
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			incomingTranscriptActiveSessionIds: new Set(),
			snapshotTransferFrames: new Map(),
			snapshotLoads: new Map(),
		};
		const client: AttachClient = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
		}) as {
			attachClient(client: AttachClient, command: { type: "attach"; activeSessionId: string }): Promise<unknown>;
		};
		seedSupervisorRoster(supervisor, worker);

		await expect(supervisor.attachClient(client, { type: "attach", activeSessionId })).rejects.toThrow(
			"snapshot failed",
		);
		expect(client.attachedActiveSessionIds).toEqual(new Set());
	});

	it.each(["malformed", "unreadable", "missing"] as const)(
		"blocks supervisor recovery when strict orphan authority is %s",
		async (authorityState) => {
			const root = mkdtempSync(join(tmpdir(), "prime-supervisor-strict-authority-"));
			const orphanProcessJournalPath = join(root, "worker.orphans.jsonl");
			const recoveryJournalPath = join(root, "worker.recovery.jsonl");
			const descriptorPath = join(root, "worker.json");
			writeFileSync(descriptorPath, "descriptor\n");
			writeFileSync(recoveryJournalPath, "recovery\n");
			if (authorityState === "malformed") {
				writeFileSync(orphanProcessJournalPath, "{not-json}\n");
			} else if (authorityState === "unreadable") {
				mkdirSync(orphanProcessJournalPath);
			}
			const worker = {
				descriptor: {
					workerId: "strict-authority-worker",
					pid: 2_000_000_000,
					processStartId: "missing-process",
					rootActiveSessionId: "root-active",
					recoveryJournalPath,
					orphanProcessJournalPath,
				},
				descriptorPath,
			};
			const markInterrupted = vi.fn(async () => undefined);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				catalog: { markInterrupted },
				assertRecoveryAllowed: vi.fn(async () => undefined),
			}) as {
				recoverUncertainWorkerOperations(target: typeof worker, requireWorkerDeath: boolean): Promise<void>;
			};

			try {
				await expect(supervisor.recoverUncertainWorkerOperations(worker, true)).rejects.toThrow(
					"child process cleanup is unverified",
				);
				expect(markInterrupted).not.toHaveBeenCalled();
				expect(existsSync(descriptorPath)).toBe(true);
				expect(existsSync(recoveryJournalPath)).toBe(true);
				expect(existsSync(orphanProcessJournalPath)).toBe(authorityState !== "missing");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects Windows PID-only orphan authority before supervisor recovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-windows-authority-"));
		const orphanProcessJournalPath = join(root, "worker.orphans.jsonl");
		const recoveryJournalPath = join(root, "worker.recovery.jsonl");
		writeFileSync(
			orphanProcessJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: 2_000_000_001,
				ownerPid: 2_000_000_002,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		const worker = {
			descriptor: {
				workerId: "windows-pid-only-worker",
				pid: 2_000_000_000,
				rootActiveSessionId: "root-active",
				recoveryJournalPath,
				orphanProcessJournalPath,
			},
		};
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const markInterrupted = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			catalog: { markInterrupted },
			assertRecoveryAllowed: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			recoverUncertainWorkerOperations(target: typeof worker, requireWorkerDeath: boolean): Promise<void>;
		};

		try {
			await expect(supervisor.recoverUncertainWorkerOperations(worker, false)).rejects.toThrow(
				"child process cleanup is unverified",
			);
			expect(markInterrupted).not.toHaveBeenCalled();
			expect(readFileSync(orphanProcessJournalPath, "utf8")).toContain('"active":true');
		} finally {
			platform.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reaps prior-generation orphan trees before marking recovery operations interrupted", async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-prior-generation-"));
		const orphanProcessJournalPath = join(root, "worker.orphans.jsonl");
		const recoveryJournalPath = join(root, "worker.recovery.jsonl");
		const childIdentity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", childIdentity.argument], {
			detached: true,
			stdio: "ignore",
		});
		const childPid = child.pid;
		if (!childPid) throw new Error("Prior-generation fixture did not start");
		const childStartId = await waitForExactChildProcessStartId(childPid);
		writeFileSync(
			orphanProcessJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: 2_000_000_002,
				processStartId: childStartId,
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		new WorkerRecoveryJournal(recoveryJournalPath).record({
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: "/tmp/root.jsonl",
			busy: true,
			operation: "model_stream",
		});
		const worker = {
			descriptor: {
				workerId: "prior-generation-worker",
				pid: 2_000_000_000,
				rootActiveSessionId: "root-active",
				recoveryJournalPath,
				orphanProcessJournalPath,
			},
		};
		const markInterrupted = vi.fn(async () => undefined);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			catalog: { markInterrupted },
			assertRecoveryAllowed: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as {
			recoverUncertainWorkerOperations(target: typeof worker, requireWorkerDeath: boolean): Promise<void>;
		};

		try {
			await expect(supervisor.recoverUncertainWorkerOperations(worker, false)).resolves.toBeUndefined();
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/root.jsonl", "root-active", ["model_stream"]);
			await new Promise<void>((resolveClose) => {
				if (child.exitCode !== null || child.signalCode !== null) resolveClose();
				else child.once("close", () => resolveClose());
			});
		} finally {
			if (matchesExactProcessIdentity(childPid, childStartId)) {
				try {
					process.kill(-childPid, "SIGKILL");
				} catch {
					// Already reaped.
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not launch a replacement after strict recovery cleanup fails", async () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-replacement-gate-"));
		const orphanProcessJournalPath = join(root, "worker.orphans.jsonl");
		const recoveryJournalPath = join(root, "worker.recovery.jsonl");
		const descriptorPath = join(root, "worker.json");
		writeFileSync(orphanProcessJournalPath, "{not-json}\n");
		writeFileSync(recoveryJournalPath, "recovery\n");
		writeFileSync(descriptorPath, "descriptor\n");
		const worker = {
			descriptor: {
				workerId: "replacement-gated-worker",
				pid: 2_000_000_000,
				processStartId: "missing-process",
				rootActiveSessionId: "root-active",
				rootSessionId: "root-session",
				socketPath: join(root, "worker.sock"),
				recoveryJournalPath,
				orphanProcessJournalPath,
				ownerClientId: "owner-client",
				lifecycle: "recovering" as const,
				consecutiveFailures: 0,
			},
			descriptorPath,
			intentionalStop: false,
			stopRevision: 0,
			transientCreateCommand: { type: "create" as const, config: {} },
			launchEnv: {},
		};
		const launchWorker = vi.fn(async () => worker);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			socketPath: join(root, "supervisor.sock"),
			catalog: { markInterrupted: vi.fn(async () => undefined) },
			assertRecoveryAllowed: vi.fn(async () => undefined),
			launchWorker,
			persistWorker: vi.fn(),
			log: vi.fn(),
		}) as {
			recoverWorker(target: typeof worker): Promise<void>;
		};

		try {
			const recovery = supervisor.recoverWorker(worker);
			await vi.runAllTimersAsync();
			await recovery;
			expect(launchWorker).not.toHaveBeenCalled();
			expect(worker.descriptor.lifecycle).toBe("failed");
			expect(worker.descriptor.consecutiveFailures).toBe(3);
			for (const path of [descriptorPath, recoveryJournalPath, orphanProcessJournalPath]) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains resident and durable stop artifacts when a failed group remains live", async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-stop-proof-"));
		const descriptorPath = join(root, "worker.json");
		const recoveryJournalPath = join(root, "worker.recovery.jsonl");
		const orphanProcessJournalPath = join(root, "worker.orphans.jsonl");
		writeFileSync(descriptorPath, "descriptor\n");
		writeFileSync(recoveryJournalPath, "recovery\n");
		const childIdentity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", childIdentity.argument], {
			detached: true,
			stdio: "ignore",
		});
		const childPid = child.pid;
		if (!childPid) throw new Error("Live-group fixture did not start");
		const childStartId = await waitForExactChildProcessStartId(childPid);
		writeFileSync(
			orphanProcessJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: childPid,
				ownerPid: 2_000_000_002,
				processStartId: "mismatched-process-identity",
				active: true,
				recordedAt: new Date().toISOString(),
			})}\n`,
		);
		const worker = {
			descriptor: {
				workerId: "forced-stop-proof-worker",
				pid: 2_000_000_000,
				processStartId: "missing-process",
				rootActiveSessionId: "root-active",
				lifecycle: "ready" as const,
				recoveryJournalPath,
				orphanProcessJournalPath,
			},
			descriptorPath,
			summaries: new Map<string, SessionSummary>(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
			snapshotGenerations: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const workers = new Map([[worker.descriptor.workerId, worker]]);
		const deleteWorkerDescriptor = vi.fn(async () => false);
		const scheduleWorkerStopFinalization = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers,
			workerStopCounts: new Map(),
			shuttingDown: false,
			processIdentity: vi.fn(() => "gone"),
			persistWorkerStopTombstone: vi.fn((target: typeof worker) => {
				target.intentionalStop = true;
				(target.descriptor as typeof target.descriptor & { stopRequestedAt?: string }).stopRequestedAt =
					new Date().toISOString();
			}),
			scheduleWorkerStopFinalization,
			deleteWorkerDescriptor,
			invalidateWorkerSessionInputPauses: vi.fn(),
		}) as {
			stopWorker(target: typeof worker, removeDescriptor: boolean, force: boolean): Promise<void>;
		};

		try {
			await expect(supervisor.stopWorker(worker, true, true)).rejects.toThrow(
				"recovery authority could not be removed",
			);
			expect(workers.get(worker.descriptor.workerId)).toBe(worker);
			expect(deleteWorkerDescriptor).toHaveBeenCalledWith(worker, expect.anything());
			expect(scheduleWorkerStopFinalization).toHaveBeenCalledWith(worker);
			for (const path of [descriptorPath, recoveryJournalPath]) {
				expect(existsSync(path)).toBe(true);
			}
			expect(existsSync(orphanProcessJournalPath)).toBe(true);
		} finally {
			if (matchesExactProcessIdentity(childPid, childStartId)) {
				try {
					process.kill(-childPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks each busy worker session interrupted independently", async () => {
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				recoveryJournalPath: string;
				orphanProcessJournalPath: string;
				orphanProcessJournalGeneration: string;
			};
		};
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-recovery-test-"));
		const journalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		const orphanProcessJournalGeneration = initializeOrphanProcessJournal(orphanJournalPath).generation;
		const journal = new WorkerRecoveryJournal(journalPath);
		journal.record({
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: "/tmp/root.jsonl",
			busy: true,
			operation: "model_stream",
		});
		journal.record({
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			busy: true,
			operation: "tool_execution",
		});
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-1",
				pid: process.pid,
				rootActiveSessionId: "root-active",
				recoveryJournalPath: journalPath,
				orphanProcessJournalPath: orphanJournalPath,
				orphanProcessJournalGeneration,
			},
		};
		const markInterrupted = vi.fn(async () => undefined);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			catalog: { start: vi.fn(async () => undefined), markInterrupted },
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as {
			recoverUncertainWorkerOperations(worker: RecoveryWorker): Promise<void>;
		};

		try {
			await supervisor.recoverUncertainWorkerOperations(worker);
			expect(kill).not.toHaveBeenCalled();
			expect(markInterrupted).toHaveBeenCalledTimes(2);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/root.jsonl", "root-active", ["model_stream"]);
			expect(markInterrupted).toHaveBeenCalledWith("/tmp/child.jsonl", "child-active", ["tool_execution"]);
		} finally {
			kill.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ name: "identity-bearing", hasProcessIdentity: true },
		{ name: "PID-only", hasProcessIdentity: false },
	])("retains a $name orphan journal when cleanup cannot be verified", async ({ hasProcessIdentity }) => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-orphan-retry-test-"));
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		const workerPid = 987_653;
		const orphanPid = process.pid;
		const processStartId = hasProcessIdentity ? getProcessStartId(orphanPid) : undefined;
		if (hasProcessIdentity) expect(processStartId).toBeDefined();
		writeFileSync(
			orphanJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: orphanPid,
				ownerPid: workerPid,
				...(processStartId ? { processStartId } : {}),
				active: true,
				recordedAt: new Date().toISOString(),
			})}
`,
		);
		const worker = {
			descriptor: {
				workerId: "worker-orphan-retry",
				pid: workerPid,
				rootActiveSessionId: "root-active",
				recoveryJournalPath: join(root, "worker.recovery.jsonl"),
				orphanProcessJournalPath: orphanJournalPath,
			},
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			catalog: { start: vi.fn(async () => undefined), markInterrupted: vi.fn(async () => undefined) },
			log: vi.fn(),
			assertRecoveryAllowed: vi.fn(async () => undefined),
		}) as {
			recoverUncertainWorkerOperations(target: typeof worker): Promise<void>;
		};
		const reap = vi.spyOn(orphanProcessModule, "reapOrphanProcessAuthority").mockResolvedValue(false);

		try {
			await expect(supervisor.recoverUncertainWorkerOperations(worker)).rejects.toThrow(
				"child process cleanup is unverified",
			);
			expect(reap).toHaveBeenCalledWith(
				orphanJournalPath,
				expect.objectContaining({ additionalCandidates: [{ pid: workerPid }] }),
			);
			expect(existsSync(orphanJournalPath)).toBe(true);
		} finally {
			reap.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips catalog startup when recovery has no interrupted operations", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-empty-recovery-test-"));
		const worker = {
			descriptor: {
				workerId: "worker-empty-recovery",
				pid: 987_654,
				rootActiveSessionId: "root-active",
				recoveryJournalPath: join(root, "worker.recovery.jsonl"),
			},
		};
		const catalogStart = vi.fn(async () => {
			throw new Error("catalog unavailable");
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			catalog: { start: catalogStart, markInterrupted: vi.fn() },
			assertRecoveryAllowed: vi.fn(async () => undefined),
		}) as {
			recoverUncertainWorkerOperations(target: typeof worker): Promise<void>;
		};

		try {
			await expect(supervisor.recoverUncertainWorkerOperations(worker)).resolves.toBeUndefined();
			expect(catalogStart).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not mark interrupted operations when catalog startup fails after cleanup proof", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-catalog-readiness-test-"));
		const recoveryJournalPath = join(root, "worker.recovery.jsonl");
		const orphanJournalPath = join(root, "worker.orphans.jsonl");
		const workerPid = 987_654;
		new WorkerRecoveryJournal(recoveryJournalPath).record({
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: "/tmp/root.jsonl",
			busy: true,
			operation: "model_stream",
		});
		writeFileSync(
			orphanJournalPath,
			`${JSON.stringify({
				version: 1,
				pid: process.pid,
				ownerPid: workerPid,
				processStartId: getProcessStartId(process.pid),
				active: true,
				recordedAt: new Date().toISOString(),
			})}
`,
		);
		const worker = {
			descriptor: {
				workerId: "worker-catalog-blocked",
				pid: workerPid,
				rootActiveSessionId: "root-active",
				recoveryJournalPath,
				orphanProcessJournalPath: orphanJournalPath,
			},
			intentionalStop: false,
		};
		const catalogError = new Error("Timed out starting daemon catalog");
		const reap = vi.spyOn(orphanProcessModule, "reapOrphanProcessAuthority").mockResolvedValue(true);
		const markInterrupted = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			catalog: {
				start: vi.fn(async () => {
					throw catalogError;
				}),
				markInterrupted,
			},
			assertRecoveryAllowed: vi.fn(async () => {}),
		}) as {
			recoverUncertainWorkerOperations(target: typeof worker): Promise<void>;
		};

		try {
			await expect(supervisor.recoverUncertainWorkerOperations(worker)).rejects.toThrow(catalogError);
			expect(reap).toHaveBeenCalledOnce();
			expect(markInterrupted).not.toHaveBeenCalled();
			expect(existsSync(orphanJournalPath)).toBe(true);
		} finally {
			reap.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ name: "malformed data", data: undefined, error: /invalid update manifest/ },
		{
			name: "missing root disposition",
			data: { formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION, createdAt: "now", sessions: [] },
			error: /root disposition/,
		},
	])("cancels a prepare acknowledgement with $name", async ({ data, error }) => {
		const client = {
			requestWorker: vi.fn(async ({ type }: { type: string }) =>
				type === "worker_prepare_update" ? { success: true, data } : { success: true },
			),
			close: vi.fn(),
		};
		const worker = {
			descriptor: { workerId: "worker", lifecycle: "ready", rootActiveSessionId: "root" },
			client,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["worker", worker]]),
		}) as { prepareUpdateRestartFenced(): Promise<unknown> };
		await expect(supervisor.prepareUpdateRestartFenced()).rejects.toThrow(error);
		expect(client.requestWorker).toHaveBeenCalledWith({ type: "worker_cancel_update" }, 5000);
	});

	it("accepts an explicitly discarded empty root", async () => {
		const client = {
			requestWorker: vi.fn(async ({ type }: { type: string }) =>
				type === "worker_prepare_update"
					? {
							success: true,
							data: {
								formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
								createdAt: "now",
								sessions: [],
								discardedActiveSessionIds: ["root"],
							},
						}
					: { success: true },
			),
		};
		const worker = {
			descriptor: { workerId: "worker", lifecycle: "ready", rootActiveSessionId: "root" },
			client,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["worker", worker]]),
			validateAndPersistUpdateManifest: vi.fn(),
			stopWorker: vi.fn(async () => undefined),
		}) as { prepareUpdateRestartFenced(): Promise<{ discardedActiveSessionIds?: string[] }> };
		await expect(supervisor.prepareUpdateRestartFenced()).resolves.toMatchObject({
			discardedActiveSessionIds: ["root"],
		});
	});

	it("replays completed journaled mutations during restart preparation without taking a mutation lease", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-command-replay-"));
		const commandJournal = new CommandRecoveryJournal(join(root, "commands.jsonl"));
		const response = success("command-1", "kill");
		commandJournal.begin("client-1", "command-1", "kill");
		commandJournal.recordResult("client-1", "command-1", response);
		const writes: string[] = [];
		const client = {
			id: "socket-client",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const mutationDrain = { begin: vi.fn(), end: vi.fn() };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			workers: new Map(),
			protocolClientIds: new WeakMap(),
			commandJournal,
			mutationDrain,
			updateRestartPhase: "fencing",
			assertCurrentOwnership: vi.fn(async () => undefined),
			cancelOwnedWorkerCleanup: vi.fn(),
			handleCommand: vi.fn(async () => {
				throw new Error("completed command was dispatched again");
			}),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		try {
			await supervisor.handleLine(
				client,
				JSON.stringify(
					createDaemonCommandEnvelope({ type: "kill", activeSessionId: "session-1" }, "command-1", "client-1"),
				),
			);
			expect(writes).toEqual([`${JSON.stringify(response)}\n`]);
			expect(mutationDrain.begin).not.toHaveBeenCalled();
			expect(mutationDrain.end).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects genuinely new mutations during restart preparation without journaling or leasing them", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-command-reject-"));
		const commandJournal = new CommandRecoveryJournal(join(root, "commands.jsonl"));
		const writes: string[] = [];
		const client = {
			id: "socket-client",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const mutationDrain = { begin: vi.fn(), end: vi.fn() };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			workers: new Map(),
			protocolClientIds: new WeakMap(),
			commandJournal,
			mutationDrain,
			updateRestartPhase: "fencing",
			assertCurrentOwnership: vi.fn(async () => undefined),
			cancelOwnedWorkerCleanup: vi.fn(),
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		try {
			await supervisor.handleLine(
				client,
				JSON.stringify(
					createDaemonCommandEnvelope({ type: "kill", activeSessionId: "session-1" }, "command-2", "client-1"),
				),
			);
			expect(writes.join(" ")).toContain("Daemon is preparing an update restart");
			expect(commandJournal.lookup("client-1", "command-2")).toBeUndefined();
			expect(mutationDrain.begin).not.toHaveBeenCalled();
			expect(mutationDrain.end).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fences and drains a mutation admitted at the first drain boundary before worker prepare", async () => {
		const mutationDrain = new MutationDrainLatch();
		const firstDrain = createDeferred();
		const originalWaitForDrain = mutationDrain.waitForDrain.bind(mutationDrain);
		vi.spyOn(mutationDrain, "waitForDrain").mockImplementationOnce(async (...args) => {
			await originalWaitForDrain(...args);
			mutationDrain.begin();
			firstDrain.resolve();
		});
		mutationDrain.begin(); // The prepare command itself remains in flight at the supervisor boundary.
		const prepareFenced = vi.fn(async () => ({
			formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
			createdAt: "now",
			sessions: [],
		}));
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			mutationDrain,
			workers: new Map(),
			prepareUpdateRestartFenced: prepareFenced,
		}) as {
			updateRestartPhase?: "draining" | "fencing" | "prepared";
			prepareUpdateRestart(): Promise<unknown>;
		};

		const prepare = supervisor.prepareUpdateRestart();
		await firstDrain.promise;
		await Promise.resolve();

		expect(supervisor.updateRestartPhase).toBe("fencing");
		expect(prepareFenced).not.toHaveBeenCalled();

		mutationDrain.end();
		await prepare;
		expect(prepareFenced).toHaveBeenCalledOnce();
		mutationDrain.end();
	});

	it("limits abort admission to mutation drain", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-update-drain-unit-"));
		const commandJournal = new CommandRecoveryJournal(join(root, "commands.jsonl"));
		const writes: string[] = [];
		const client = {
			id: "socket-client",
			socket: {
				destroyed: false,
				write: vi.fn((chunk: string) => {
					writes.push(chunk);
					return true;
				}),
			},
		} as unknown as DaemonSocketClient;
		const handleCommand = vi.fn(async (_client: DaemonSocketClient, command: { id?: string; type: string }) =>
			failure(command.id, command.type, "handled abort"),
		);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			workers: new Map(),
			protocolClientIds: new WeakMap(),
			commandJournal,
			mutationDrain: { begin: vi.fn(), end: vi.fn() },
			updateRestartPhase: "draining",
			assertCurrentOwnership: vi.fn(async () => undefined),
			cancelOwnedWorkerCleanup: vi.fn(),
			handleCommand,
		}) as unknown as {
			updateRestartPhase: "draining" | "fencing";
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};
		try {
			await supervisor.handleLine(
				client,
				JSON.stringify(createDaemonCommandEnvelope({ type: "abort", activeSessionId: "missing" }, "a", "c")),
			);
			expect(writes.join(" ")).toContain("handled abort");
			expect(handleCommand).toHaveBeenCalledOnce();
			writes.length = 0;
			supervisor.updateRestartPhase = "fencing";
			await supervisor.handleLine(
				client,
				JSON.stringify(createDaemonCommandEnvelope({ type: "abort", activeSessionId: "missing" }, "b", "c")),
			);
			expect(writes.join(" ")).toContain("Daemon is preparing an update restart");
			expect(handleCommand).toHaveBeenCalledOnce();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps legacy descriptor identity reads out of process-authority decisions", () => {
		const source = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-supervisor.ts"), "utf8");
		const unexpected = source
			.split("\n")
			.map((line, index) => ({ line: index + 1, text: line.trim() }))
			.filter(({ text }) => text.includes("worker.descriptor.processStartId"))
			.filter(
				({ text }) =>
					!text.includes("delete worker.descriptor.processStartId") &&
					!text.includes("const previousLegacy =") &&
					!/worker\.descriptor\.processStartId\s*=(?!=)/.test(text),
			);
		expect(unexpected).toEqual([]);
	});

	it("rejects update prepare when a resident worker is recovering or disconnected", async () => {
		const requestWorker = vi.fn();
		const worker = {
			descriptor: { workerId: "resident-1", lifecycle: "recovering" },
			client: undefined,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([["resident-1", worker]]),
		}) as {
			prepareUpdateRestartFenced(): Promise<unknown>;
		};

		await expect(supervisor.prepareUpdateRestartFenced()).rejects.toThrow(/resident-1.*recovering.*disconnected/);
		expect(requestWorker).not.toHaveBeenCalled();
	});
});
