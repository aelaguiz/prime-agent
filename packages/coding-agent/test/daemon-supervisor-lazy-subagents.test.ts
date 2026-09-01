import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	assertAgentFamilyReach,
	sessionNameReservationKey,
} from "../src/core/agent-messages.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	openingWorkers: Map<string, Promise<WorkerFixture>>;
	start(): Promise<void>;
	cleanupSupervisorResources(): Promise<void>;
	refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
	findSummaryInWorker(worker: WorkerFixture, selector: string): SessionSummary | undefined;
	createOrReuseWorker(
		clientId: string,
		command: {
			type: "create";
			name?: string;
			sessionPath?: string;
			lifecycle?: "client_owned";
			config?: { cwd?: string; sessionDir?: string };
		},
	): Promise<WorkerFixture>;
	rlmSpawnLedger(sessionDir?: string): {
		ledgerPath: string;
		edges?: RlmSpawnLedger["edges"];
		appendRenameByChildPath?: ReturnType<typeof vi.fn>;
		appendDeleteByChildPath?: ReturnType<typeof vi.fn>;
	};
	resolveCreateSessionsDir(
		command: { type: "create"; config?: { sessionDir?: string } },
		config: { agentDir?: string; sessionDir?: string },
		existing?: WorkerFixture,
	): string;
	withSessionNameReservation<T>(
		input: { name: string; depth: number; parentSessionPath?: string; sessionDir?: string },
		action: () => Promise<T>,
	): Promise<T>;
	assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void>;
	assertSavedSiblingNameAvailable(
		siblings: Array<Record<string, unknown>>,
		target: Record<string, unknown>,
		name: string,
	): void;
	familyCatalogEntry(summary: SessionSummary): AgentFamilyCatalogEntry;
	handleCommand(client: object, command: Record<string, unknown>): Promise<unknown>;
	seedRosterLedger(): Promise<void>;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "ready" | "starting" | "stopping" | "recovering";
		rootActiveSessionId: string;
		rootSessionId: string;
		sessionDir?: string;
		sessionFile?: string;
		pid: number;
		authenticationToken: string;
		ownerClientId?: string;
		createCommand: { config: { cwd: string; sessionDir?: string }; sessionPath?: string };
	};
	client: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function worker(workerId: string, summaries: SessionSummary[] = []): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root-active`,
			rootSessionId: `${workerId}-root-session`,
			pid: 1,
			authenticationToken: `${workerId}-token`,
			createCommand: { config: { cwd: "/tmp/project" } },
		},
		client: {
			request: vi.fn(),
			requestWorker: vi.fn(),
		},
		summaries: new Map(summaries.map((entry) => [entry.activeSessionId ?? entry.id, entry])),
	};
}

describe("daemon supervisor passive subagent topology", () => {
	it("finds a child summary by its displayed session ID suffix", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-suffix-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const child = summary({
			id: "bbbb6666777788889999cccc",
			activeSessionId: "bbbb6666777788889999cccc",
			sessionId: "aaaa6666777788889999dddd",
		});
		const resident = worker("first", [child]);
		seedSupervisorRoster(supervisor, resident);

		expect(supervisor.findSummaryInWorker(resident, "88889999cccc")).toEqual({ ...child, rosterStatus: "idle" });
	});

	it("rejects an explicit root name that collides with a saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});
		await supervisor.seedRosterLedger();

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "duplicate-root" }),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("rejects a forked root name that collides with another saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-forked-root-name-"));
		tempDirs.push(directory);
		const sourceManager = SessionManager.create(directory, join(directory, "sessions"));
		sourceManager.newSession({ rlmDepth: 0 });
		sourceManager.flushNow();
		const sourcePath = sourceManager.getSessionFile();
		if (!sourcePath) throw new Error("Missing source session path");
		const forkedManager = SessionManager.forkFrom(sourcePath, directory, join(directory, "sessions"));
		const forkedPath = forkedManager.getSessionFile();
		if (!forkedPath) throw new Error("Missing forked session path");
		const forkedInfo = await readSessionInfo(forkedPath);
		if (!forkedInfo) throw new Error("Missing forked session info");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => [forkedInfo]),
				list: vi.fn(async () => [
					{
						id: "other-root",
						name: "duplicate-root",
						path: join(directory, "other.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
						rlmDepth: 0,
					},
				]),
			},
		});
		await supervisor.seedRosterLedger();

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(forkedPath, "duplicate-root")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("normalizes explicit root names before supervisor validation and launch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-normalized-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});
		await supervisor.seedRosterLedger();

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "  duplicate-root  " }),
		).rejects.toThrow('Agent name "duplicate-root" is unavailable');
		await expect(supervisor.createOrReuseWorker("client", { type: "create", name: "   " })).rejects.toThrow(
			"Session name cannot be empty",
		);
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("checks inactive root renames against every saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-root-rename-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		const duplicatePath = join(directory, "duplicate.jsonl");
		const target = {
			id: "target",
			path: targetPath,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const duplicate = { ...target, id: "duplicate", path: duplicatePath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => [target]),
			catalog: {
				list: vi.fn(async () => [target, duplicate]),
			},
		});
		await supervisor.seedRosterLedger();

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(targetPath, "taken")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("retains a legacy child's parent edge when its depth is unknown", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-family-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const parentPath = join(directory, "parent.jsonl");
		const child = supervisor.familyCatalogEntry(
			summary({
				id: "legacy-child-active",
				sessionId: "legacy-child",
				parentSessionPath: parentPath,
			}),
		);
		const parent = supervisor.familyCatalogEntry(
			summary({ id: "parent-active", sessionId: "parent", sessionFile: parentPath, rlmDepth: 0 }),
		);
		const unrelated = supervisor.familyCatalogEntry(
			summary({ id: "unrelated-active", sessionId: "unrelated", rlmDepth: 0 }),
		);
		const forkedRoot = supervisor.familyCatalogEntry(
			summary({
				id: "forked-root-active",
				sessionId: "forked-root",
				parentSessionPath: parentPath,
				rlmDepth: 0,
			}),
		);

		expect(child).toMatchObject({ depth: 1, parentSessionPath: parent.sessionPath });
		expect(forkedRoot).not.toHaveProperty("parentSessionPath");
		expect(() => assertAgentFamilyReach(child, parent)).not.toThrow();
		expect(() => assertAgentFamilyReach(child, unrelated)).toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
	});

	it("compares legacy and modern saved siblings at one neutral depth", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-sibling-name-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const base = {
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const target = { ...base, id: "target", path: join(directory, "target.jsonl"), parentSessionPath, rlmDepth: 1 };
		const legacy = { ...base, id: "legacy", path: join(directory, "legacy.jsonl"), parentSessionPath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;

		expect(() => supervisor.assertSavedSiblingNameAvailable([target, legacy], target, "taken")).toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);
	});

	it("publishes an opening reservation before named create validation awaits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-named-create-race-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseSiblings!: () => void;
		const siblingGate = new Promise<void>((resolve) => {
			releaseSiblings = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		const launchWorker = vi.fn(async () => resident);
		Object.assign(supervisor, {
			catalog: {
				resolve: vi.fn(async () => sessionPath),
				siblings: vi.fn(async () => {
					await siblingGate;
					return [];
				}),
				list: vi.fn(async () => []),
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", { type: "create", name: "named", sessionPath });
		const starting = worker("starting");
		starting.descriptor.lifecycle = "starting";
		starting.descriptor.createCommand = { config: { cwd: "/tmp/project" }, sessionPath };
		supervisor.workers.set(starting.descriptor.workerId, starting);
		const second = supervisor.createOrReuseWorker("client", { type: "create", sessionPath });
		releaseSiblings();
		expect(await Promise.all([first, second])).toEqual([resident, resident]);
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("enforces session ownership when joining an in-flight open", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-owner-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return resident;
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const sameOwner = supervisor.createOrReuseWorker("owner", create);
		const otherClient = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(sameOwner).resolves.toBe(resident),
			expect(otherClient).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseLaunch();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("rejoins an open registered while reclaiming a stale worker registration", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-reclaim-rejoin-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseReclaim!: () => void;
		const reclaimGate = new Promise<void>((resolve) => {
			releaseReclaim = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const stale = worker("stale");
		stale.descriptor.createCommand = { config: { cwd: directory }, sessionPath };
		supervisor.workers.set(stale.descriptor.workerId, stale);
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => resident);
		const reclaimStaleWorkerRegistration = vi.fn(async () => {
			await reclaimGate;
			supervisor.workers.delete(stale.descriptor.workerId);
			return true;
		});
		Object.assign(supervisor, { launchWorker, reclaimStaleWorkerRegistration });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const second = supervisor.createOrReuseWorker("owner", create);
		const intruder = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(second).resolves.toBe(resident),
			expect(intruder).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseReclaim();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("propagates an in-flight open failure to joiners", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-failure-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn(async () => {
			await launchGate;
			throw new Error("launch exploded");
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const joiner = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).rejects.toThrow("launch exploded"),
			expect(joiner).rejects.toThrow("launch exploded"),
		]);
		releaseLaunch();
		await expectations;
	});

	it("routes a saved-session rename to the canonical target owner instead of the caller worker", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-cross-worker-saved-rename-"));
		tempDirs.push(directory);
		const sourcePath = join(directory, "source.jsonl");
		const targetPath = join(directory, "target.jsonl");
		const targetAlias = join(directory, "target-alias.jsonl");
		writeFileSync(sourcePath, "{}\n");
		writeFileSync(targetPath, "{}\n");
		symlinkSync(targetPath, targetAlias);
		const sourceSummary = summary({
			id: "source-active",
			activeSessionId: "source-active",
			sessionId: "source-session",
			sessionFile: sourcePath,
			rlmDepth: 0,
		});
		const targetSummary = summary({
			id: "target-active",
			activeSessionId: "target-active",
			sessionId: "target-session",
			sessionFile: targetPath,
			rlmDepth: 0,
		});
		const sourceWorker = worker("source", [sourceSummary]);
		const targetWorker = worker("target", [targetSummary]);
		sourceWorker.descriptor.sessionDir = directory;
		targetWorker.descriptor.sessionDir = directory;
		targetWorker.client.request.mockResolvedValue(success(undefined, "rename_saved_session", targetSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("source", sourceWorker);
		supervisor.workers.set("target", targetWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });

		await expect(
			supervisor.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{
					type: "rename_saved_session",
					activeSessionId: "source-active",
					sessionPath: targetAlias,
					name: "target-renamed",
				},
			),
		).resolves.toMatchObject({ success: true });
		expect(sourceWorker.client.request).not.toHaveBeenCalled();
		expect(targetWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "rename_saved_session",
				activeSessionId: "target-active",
				sessionPath: realpathSync(targetPath),
			}),
			expect.any(Number),
		);

		targetWorker.client.request.mockClear();
		await expect(
			supervisor.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{
					type: "delete_saved_session",
					activeSessionId: "source-active",
					sessionPath: targetAlias,
				},
			),
		).resolves.toMatchObject({ success: true });
		expect(sourceWorker.client.request).not.toHaveBeenCalled();
		expect(targetWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "delete_saved_session",
				activeSessionId: "target-active",
				sessionPath: realpathSync(targetPath),
			}),
			expect.any(Number),
		);
	});

	it("routes a passive saved-session target through the resident root while preserving its canonical path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-saved-mutation-"));
		tempDirs.push(directory);
		const rootPath = join(directory, "root.jsonl");
		const childPath = join(directory, "child.jsonl");
		writeFileSync(rootPath, "{}\n");
		writeFileSync(childPath, "{}\n");
		const rootSummary = summary({
			id: "root-active",
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: rootPath,
			rlmDepth: 0,
		});
		const passiveSummary = summary({
			id: "passive-row",
			sessionId: "passive-session",
			sessionFile: childPath,
			parentSessionPath: rootPath,
			rlmDepth: 1,
		});
		const owner = worker("owner", [rootSummary, passiveSummary]);
		owner.descriptor.rootActiveSessionId = rootSummary.activeSessionId!;
		owner.descriptor.sessionDir = directory;
		owner.client.request.mockResolvedValue(success(undefined, "delete_saved_session", { ok: true }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("owner", owner);

		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: childPath }),
		).resolves.toMatchObject({ success: true });
		expect(owner.client.request).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "delete_saved_session",
				activeSessionId: "root-active",
				sessionPath: canonicalSessionPath(childPath),
			}),
			expect.any(Number),
		);
	});

	it("coalesces passive attach hydration by canonical path and adopts the resident active id", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-attach-race-"));
		tempDirs.push(directory);
		const rootPath = join(directory, "root.jsonl");
		const childPath = join(directory, "child.jsonl");
		writeFileSync(rootPath, "{}\n");
		writeFileSync(childPath, "{}\n");
		const rootSummary = summary({
			id: "root-active",
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: rootPath,
			rlmDepth: 0,
		});
		const passiveSummary = summary({
			id: "passive-row",
			sessionId: "passive-session",
			sessionFile: childPath,
			parentSessionPath: rootPath,
			rlmDepth: 1,
		});
		const hydratedSummary = summary({
			...passiveSummary,
			id: "hydrated-active",
			activeSessionId: "hydrated-active",
			messageCount: 0,
		});
		const owner = worker("owner", [rootSummary, passiveSummary]);
		owner.descriptor.rootActiveSessionId = "root-active";
		owner.descriptor.sessionDir = directory;
		Object.assign(owner, {
			snapshotLoads: new Map(),
			snapshotCache: new Map(),
			transcriptCaches: new Map(),
		});
		let releaseCreate!: () => void;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		let hydrated = false;
		owner.client.request.mockImplementation(
			async (command: { type: string; activeSessionId?: string; sessionPath?: string }) => {
				if (command.type === "list") {
					return success(undefined, "list", {
						sessions: [rootSummary, hydrated ? hydratedSummary : passiveSummary],
					});
				}
				if (command.type === "create") {
					markCreateStarted();
					await createGate;
					hydrated = true;
					return success(undefined, "create", hydratedSummary);
				}
				if (command.type !== "attach") throw new Error(`unexpected command ${command.type}`);
				return success(undefined, "attach", {
					protocol: { name: "prime-agent-daemon", version: 7 },
					activeSessionId: "hydrated-active",
					snapshot: {
						activeSessionId: "hydrated-active",
						summary: hydratedSummary,
						state: {},
						messages: [],
						lastEventSequence: 0,
					},
					replay: { status: "complete", toSequence: 0 },
					lastEventSequence: 0,
					client: { id: "worker-client", capabilities: [] },
				});
			},
		);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			refreshWorkerSummaries: vi.fn(async () => {
				owner.summaries = new Map(
					[rootSummary, hydrated ? hydratedSummary : passiveSummary].map((entry) => [
						entry.activeSessionId ?? entry.id,
						entry,
					]),
				);
			}),
		});
		supervisor.workers.set("owner", owner);
		const client = (id: string) => ({
			id,
			attachedActiveSessionIds: new Set<string>(),
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
		});

		const firstClient = client("first");
		const secondClient = client("second");
		const first = supervisor.handleCommand(firstClient, {
			type: "attach",
			activeSessionId: "passive-row",
		});
		await createStarted;
		const second = supervisor.handleCommand(secondClient, {
			type: "attach",
			activeSessionId: "passive-row",
		});
		await Promise.resolve();
		let workerCommands = owner.client.request.mock.calls.map(([command]) => command as { type: string });
		expect(workerCommands.filter((command) => command.type === "create")).toEqual([
			expect.objectContaining({ type: "create", sessionPath: childPath }),
		]);
		expect(workerCommands.filter((command) => command.type === "attach")).toEqual([]);
		releaseCreate();
		await expect(Promise.all([first, second])).resolves.toEqual([
			expect.objectContaining({ data: expect.objectContaining({ activeSessionId: "hydrated-active" }) }),
			expect.objectContaining({ data: expect.objectContaining({ activeSessionId: "hydrated-active" }) }),
		]);
		workerCommands = owner.client.request.mock.calls.map(([command]) => command as { type: string });
		expect(workerCommands.filter((command) => command.type === "attach")).toEqual([
			expect.objectContaining({ type: "attach", activeSessionId: "hydrated-active" }),
		]);
		expect(firstClient.attachedActiveSessionIds).toEqual(new Set(["hydrated-active"]));
		expect(secondClient.attachedActiveSessionIds).toEqual(new Set(["hydrated-active"]));
	});

	it("routes an a2a send to a passive target by canonical path so the worker can hydrate it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-a2a-"));
		tempDirs.push(directory);
		const rootPath = join(directory, "root.jsonl");
		const childPath = join(directory, "child.jsonl");
		writeFileSync(rootPath, "{}\n");
		writeFileSync(childPath, "{}\n");
		const rootSummary = summary({
			id: "root-active",
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: rootPath,
			rlmDepth: 0,
		});
		const passiveSummary = summary({
			id: "passive-row",
			sessionId: "passive-session",
			sessionFile: childPath,
			parentSessionPath: rootPath,
			rlmDepth: 1,
		});
		const owner = worker("owner", [rootSummary, passiveSummary]);
		owner.descriptor.rootActiveSessionId = "root-active";
		owner.descriptor.sessionDir = directory;
		owner.client.requestWorker.mockResolvedValue(success(undefined, "send_message", { delivered: true }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("owner", owner);

		await expect(
			supervisor.handleCommand(
				{ id: "agent-client", attachedActiveSessionIds: new Set<string>() },
				{
					type: "send_message",
					fromActiveSessionId: "root-active",
					targetActiveSessionId: "passive-row",
					message: "wake and handle this",
					agentOrigin: true,
				},
			),
		).resolves.toMatchObject({ success: true });
		expect(owner.client.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: canonicalSessionPath(childPath),
				sender: expect.objectContaining({ activeSessionId: "root-active" }),
			}),
			expect.any(Number),
		);
	});

	it("forwards an id-less active-target delete and never falls back to the offline catalog", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-idless-active-delete-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		writeFileSync(targetPath, "{}\n");
		const targetSummary = summary({
			id: "target-active",
			activeSessionId: "target-active",
			sessionId: "target-session",
			sessionFile: targetPath,
			rlmDepth: 0,
		});
		const targetWorker = worker("target", [targetSummary]);
		targetWorker.descriptor.sessionDir = directory;
		targetWorker.client.request.mockResolvedValue(success(undefined, "delete_saved_session", { ok: false }));
		const deleteOffline = vi.fn();
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("target", targetWorker);
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: targetPath }),
		).resolves.toMatchObject({ success: true });
		expect(deleteOffline).not.toHaveBeenCalled();
		expect(targetWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "delete_saved_session", activeSessionId: "target-active" }),
			expect.any(Number),
		);
	});

	it("routes an active-context offline delete through the authorized source worker", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-source-worker-offline-delete-"));
		tempDirs.push(directory);
		const sourcePath = join(directory, "source.jsonl");
		const targetPath = join(directory, "offline-target.jsonl");
		writeFileSync(sourcePath, "{}\n");
		writeFileSync(targetPath, "{}\n");
		const sourceSummary = summary({
			id: "source-active",
			activeSessionId: "source-active",
			sessionId: "source-session",
			sessionFile: sourcePath,
			rlmDepth: 0,
		});
		const sourceWorker = worker("source", [sourceSummary]);
		sourceWorker.descriptor.sessionDir = directory;
		sourceWorker.client.request.mockResolvedValue(
			success(undefined, "delete_saved_session", { ok: true, method: "trash" }),
		);
		const deleteOffline = vi.fn();
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("source", sourceWorker);
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		await expect(
			supervisor.handleCommand(
				{ id: "client", attachedActiveSessionIds: new Set<string>() },
				{
					type: "delete_saved_session",
					activeSessionId: "source-active",
					sessionPath: targetPath,
				},
			),
		).resolves.toMatchObject({ success: true });
		expect(deleteOffline).not.toHaveBeenCalled();
		expect(sourceWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "delete_saved_session",
				activeSessionId: "source-active",
				sessionPath: canonicalSessionPath(targetPath),
			}),
			expect.any(Number),
		);
	});

	it("rejects saved-session mutations while the target owner is stopping or recovering", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-unavailable-target-delete-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		writeFileSync(targetPath, "{}\n");
		const targetSummary = summary({
			id: "target-active",
			activeSessionId: "target-active",
			sessionId: "target-session",
			sessionFile: targetPath,
		});
		const targetWorker = worker("target", [targetSummary]);
		targetWorker.descriptor.sessionDir = directory;
		const deleteOffline = vi.fn();
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("target", targetWorker);
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		for (const lifecycle of ["stopping", "recovering"] as const) {
			targetWorker.descriptor.lifecycle = lifecycle;
			await expect(
				supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: targetPath }),
			).rejects.toThrow(lifecycle);
		}
		expect(deleteOffline).not.toHaveBeenCalled();
		expect(targetWorker.client.request).not.toHaveBeenCalled();
	});

	it("waits for a pending opener before routing a target mutation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-open-mutate-race-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		writeFileSync(targetPath, "{}\n");
		const targetSummary = summary({
			id: "target-active",
			activeSessionId: "target-active",
			sessionId: "target-session",
			sessionFile: targetPath,
		});
		const targetWorker = worker("target", [targetSummary]);
		targetWorker.descriptor.sessionDir = directory;
		targetWorker.client.request.mockResolvedValue(success(undefined, "delete_saved_session", { ok: false }));
		let finishOpening!: () => void;
		const opening = new Promise<WorkerFixture>((resolveOpening) => {
			finishOpening = () => {
				resolveOpening(targetWorker);
			};
		});
		const deleteOffline = vi.fn();
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.openingWorkers.set(canonicalSessionPath(targetPath), opening);
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		const mutation = supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: targetPath });
		await Promise.resolve();
		expect(deleteOffline).not.toHaveBeenCalled();
		expect(targetWorker.client.request).not.toHaveBeenCalled();
		supervisor.workers.set("target", targetWorker);
		finishOpening();
		await expect(mutation).resolves.toMatchObject({ success: true });
		expect(deleteOffline).not.toHaveBeenCalled();
		expect(targetWorker.client.request).toHaveBeenCalledOnce();
	});

	it("propagates a target opener failure instead of mutating offline", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-open-mutate-failure-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		writeFileSync(targetPath, "{}\n");
		let rejectOpening!: (error: Error) => void;
		const opening = new Promise<WorkerFixture>((_resolveOpening, reject) => {
			rejectOpening = reject;
		});
		const deleteOffline = vi.fn();
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.openingWorkers.set(canonicalSessionPath(targetPath), opening);
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		const mutation = supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: targetPath });
		rejectOpening(new Error("opener failed"));
		await expect(mutation).rejects.toThrow("opener failed");
		expect(deleteOffline).not.toHaveBeenCalled();
	});

	it("keeps create/open behind an in-flight canonical target mutation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-mutate-open-race-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		const targetAlias = join(directory, "target-alias.jsonl");
		writeFileSync(targetPath, "{}\n");
		symlinkSync(targetPath, targetAlias);
		let releaseDelete!: () => void;
		const deleteGate = new Promise<void>((resolveDelete) => {
			releaseDelete = resolveDelete;
		});
		let markFileRemoved!: () => void;
		const fileRemoved = new Promise<void>((resolveRemoved) => {
			markFileRemoved = resolveRemoved;
		});
		const deleteOffline = vi.fn(async () => {
			rmSync(targetPath);
			markFileRemoved();
			await deleteGate;
			return { ok: true as const, method: "trash" as const };
		});
		const appendDeleteByChildPath = vi.fn(async () => {});
		const launched = worker("opened");
		const launchWorker = vi.fn(async () => launched);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: { delete: deleteOffline },
			rlmSpawnLedger: vi.fn(() => ({ appendDeleteByChildPath })),
			launchWorker,
		});

		const mutation = supervisor.handleCommand(
			{},
			{ type: "delete_saved_session", sessionPath: targetAlias, cwd: directory, sessionDir: directory },
		);
		await fileRemoved;
		const open = supervisor.createOrReuseWorker("client", { type: "create", sessionPath: targetAlias });
		await Promise.resolve();
		expect(launchWorker).not.toHaveBeenCalled();
		releaseDelete();
		await expect(mutation).resolves.toMatchObject({ success: true });
		await expect(open).resolves.toBe(launched);
		expect(appendDeleteByChildPath).toHaveBeenCalledOnce();
		expect(launchWorker).toHaveBeenCalledWith(
			expect.objectContaining({ config: expect.objectContaining({ sessionDir: directory }) }),
			undefined,
			undefined,
		);
	});

	it("scopes ledgers, catalogs, names, and deletes to each worker sessions directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-directory-scope-"));
		tempDirs.push(directory);
		const sessionsA = join(directory, "sessions-a");
		const sessionsB = join(directory, "sessions-b");
		mkdirSync(sessionsA, { recursive: true });
		mkdirSync(sessionsB, { recursive: true });
		const pathA = join(sessionsA, "a.jsonl");
		const pathB = join(sessionsB, "b.jsonl");
		writeFileSync(pathA, "{}\n");
		writeFileSync(pathB, "{}\n");
		const summaryA = summary({
			id: "a-active",
			activeSessionId: "a-active",
			sessionId: "a-session",
			sessionName: "shared-name",
			sessionFile: pathA,
			cwd: sessionsA,
			rlmDepth: 0,
		});
		const summaryB = summary({
			id: "b-active",
			activeSessionId: "b-active",
			sessionId: "b-session",
			sessionName: "other-name",
			sessionFile: pathB,
			cwd: sessionsB,
			rlmDepth: 0,
		});
		const workerA = worker("a", [summaryA]);
		workerA.descriptor.rootActiveSessionId = "a-active";
		workerA.descriptor.sessionDir = sessionsA;
		const workerB = worker("b", [summaryB]);
		workerB.descriptor.rootActiveSessionId = "b-active";
		workerB.descriptor.sessionDir = sessionsB;
		workerB.client.request.mockResolvedValue(success(undefined, "rename_saved_session", summaryB));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsA },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("a", workerA);
		supervisor.workers.set("b", workerB);

		const ledgerA = supervisor.rlmSpawnLedger(sessionsA);
		const ledgerB = supervisor.rlmSpawnLedger(sessionsB);
		expect(ledgerA.ledgerPath).not.toBe(ledgerB.ledgerPath);
		expect(supervisor.rlmSpawnLedger(sessionsA)).toBe(ledgerA);

		const list = vi.fn(async () => []);
		const deleteOffline = vi
			.fn()
			.mockResolvedValueOnce({ ok: false as const, error: "permission denied" })
			.mockResolvedValueOnce({ ok: true as const, method: "trash" as const })
			.mockResolvedValueOnce({ ok: true as const, method: "unlink" as const });
		const appendDeleteByChildPath = vi.fn(async () => {});
		const ledgerForDirectory = vi.fn(() => ({ appendDeleteByChildPath }));
		Object.assign(supervisor, {
			catalog: { list, delete: deleteOffline },
			rlmSpawnLedger: ledgerForDirectory,
		});
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				type: "list_saved_sessions",
				activeSessionId: "b-active",
				scope: "current",
			}),
		).resolves.toMatchObject({ success: true });
		expect(list).toHaveBeenCalledWith(sessionsB, sessionsB, undefined);

		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				activeSessionId: "b-active",
				sessionPath: pathB,
				name: "shared-name",
			}),
		).resolves.toMatchObject({ success: true });
		expect(list).toHaveBeenCalledWith(undefined, sessionsB);
		expect(workerB.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "rename_saved_session", activeSessionId: "b-active" }),
			expect.any(Number),
		);
		summaryB.sessionName = "shared-name";
		await expect(
			supervisor.createOrReuseWorker("client", {
				type: "create",
				sessionPath: "shared-name",
				config: { sessionDir: sessionsB },
			}),
		).resolves.toBe(workerB);

		const failedPath = join(sessionsB, "failed.jsonl");
		const missingPath = join(sessionsB, "already-missing.jsonl");
		await expect(
			supervisor.handleCommand(client, {
				type: "delete_saved_session",
				cwd: sessionsB,
				sessionDir: sessionsB,
				sessionPath: failedPath,
			}),
		).resolves.toMatchObject({ success: true, data: { ok: false } });
		expect(appendDeleteByChildPath).not.toHaveBeenCalled();
		await expect(
			supervisor.handleCommand(client, {
				type: "delete_saved_session",
				cwd: sessionsB,
				sessionDir: sessionsB,
				sessionPath: missingPath,
			}),
		).resolves.toMatchObject({ success: true, data: { ok: true } });
		expect(ledgerForDirectory).toHaveBeenLastCalledWith(sessionsB);
		expect(appendDeleteByChildPath).toHaveBeenCalledWith(canonicalSessionPath(missingPath), "user");

		appendDeleteByChildPath.mockRejectedValueOnce(new Error("ledger append failed"));
		await expect(
			supervisor.handleCommand(client, {
				type: "delete_saved_session",
				cwd: sessionsB,
				sessionDir: sessionsB,
				sessionPath: join(sessionsB, "physically-removed.jsonl"),
			}),
		).rejects.toThrow("ledger append failed");
		expect(deleteOffline).toHaveBeenCalledTimes(3);
	});

	it("uses the authoritative ledger for an old-v7 missing-child delete retry", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-missing-delete-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const childPath = join(directory, "session-artifacts", "parent", "sub-child", "child.jsonl");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		await ledger.appendSpawn({
			childId: "sub-child",
			parent: join(sessionsDir, "parent.jsonl"),
			child: childPath,
			depth: 1,
			name: "child",
		});
		const deleteOffline = vi.fn(async () => ({ ok: true as const, method: "missing" as const }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: childPath }),
		).resolves.toMatchObject({ success: true, data: { ok: true } });
		expect(deleteOffline).toHaveBeenCalledWith(canonicalSessionPath(childPath));
		await expect(ledger.edges(true)).resolves.toEqual([
			expect.objectContaining({ childId: "sub-child", deleted: "user" }),
		]);
	});

	it("does not report old-v7 missing-child success without an authoritative tombstone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-missing-tombstone-"));
		tempDirs.push(directory);
		const sessionsDir = join(directory, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const childPath = join(directory, "session-artifacts", "parent", "sub-child", "child.jsonl");
		const edge = {
			childId: "sub-child",
			parent: join(sessionsDir, "parent.jsonl"),
			child: canonicalSessionPath(childPath),
			depth: 1,
			name: "child",
		};
		await new RlmSpawnLedger(directory, sessionsDir).appendSpawn(edge);
		const deleteOffline = vi.fn(async () => ({ ok: true as const, method: "missing" as const }));
		const appendDeleteByChildPath = vi.fn(async () => {});
		const edgeByChildPath = vi.fn(async () => edge);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsDir },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: { delete: deleteOffline },
			rlmSpawnLedger: () => ({ appendDeleteByChildPath, edgeByChildPath }),
		});

		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: childPath }),
		).rejects.toThrow("did not tombstone child session");
		expect(deleteOffline).toHaveBeenCalledOnce();
		expect(appendDeleteByChildPath).toHaveBeenCalledOnce();
	});

	it("fails old-v7 missing-child deletion closed but keeps default-root deletion idempotent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-missing-closed-"));
		tempDirs.push(directory);
		const sessionsA = join(directory, "sessions-a");
		const sessionsB = join(directory, "sessions-b");
		mkdirSync(sessionsA, { recursive: true });
		mkdirSync(sessionsB, { recursive: true });
		const deleteOffline = vi.fn(async () => ({ ok: true as const, method: "missing" as const }));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsA },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, { catalog: { delete: deleteOffline } });

		const missingRoot = join(sessionsA, "missing-root.jsonl");
		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: missingRoot }),
		).resolves.toMatchObject({ success: true, data: { ok: true } });

		const absentChild = join(directory, "session-artifacts", "absent", "child.jsonl");
		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: absentChild }),
		).rejects.toThrow("No authoritative RLM ledger");

		const ambiguousChild = join(directory, "session-artifacts", "ambiguous", "child.jsonl");
		for (const [index, sessionsDir] of [sessionsA, sessionsB].entries()) {
			await new RlmSpawnLedger(directory, sessionsDir).appendSpawn({
				childId: `sub-${index}`,
				parent: join(sessionsDir, "parent.jsonl"),
				child: ambiguousChild,
				depth: 1,
				name: `child-${index}`,
			});
		}
		await expect(
			supervisor.handleCommand({}, { type: "delete_saved_session", sessionPath: ambiguousChild }),
		).rejects.toThrow("Multiple authoritative RLM ledgers");
		expect(deleteOffline).toHaveBeenCalledOnce();
	});

	it("keeps a custom worker sessions directory across recovery and rejects drift", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-worker-directory-restart-"));
		tempDirs.push(directory);
		const defaultSessions = join(directory, "default-sessions");
		const customSessions = join(directory, "custom-sessions");
		const driftedSessions = join(directory, "drifted-sessions");
		mkdirSync(defaultSessions, { recursive: true });
		mkdirSync(customSessions, { recursive: true });
		mkdirSync(driftedSessions, { recursive: true });
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: defaultSessions },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const restarted = worker("restarted");
		restarted.descriptor.sessionDir = customSessions;

		expect(
			supervisor.resolveCreateSessionsDir(
				{ type: "create" },
				{ agentDir: directory, sessionDir: defaultSessions },
				restarted,
			),
		).toBe(customSessions);
		expect(() =>
			supervisor.resolveCreateSessionsDir(
				{ type: "create", config: { sessionDir: driftedSessions } },
				{ agentDir: directory, sessionDir: driftedSessions },
				restarted,
			),
		).toThrow("refusing drift");
	});

	it("scopes concurrent supervisor name reservations by sessions directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-directory-reservation-"));
		tempDirs.push(directory);
		const sessionsA = join(directory, "sessions-a");
		const sessionsB = join(directory, "sessions-b");
		mkdirSync(sessionsA, { recursive: true });
		mkdirSync(sessionsB, { recursive: true });
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsA },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const input = { name: "same-root-name", depth: 0 };
		const first = supervisor.withSessionNameReservation({ ...input, sessionDir: sessionsA }, () => firstGate);
		await Promise.resolve();

		await expect(
			supervisor.withSessionNameReservation({ ...input, sessionDir: sessionsB }, async () => "reserved-b"),
		).resolves.toBe("reserved-b");
		await expect(
			supervisor.withSessionNameReservation({ ...input, sessionDir: sessionsA }, async () => "duplicate-a"),
		).rejects.toThrow("already exists at depth 0");
		releaseFirst();
		await expect(first).resolves.toBeUndefined();
	});

	it("uses injective structural session name reservation keys", () => {
		expect(sessionNameReservationKey({ name: "b:c", depth: 1, parentSessionPath: "/a" })).not.toBe(
			sessionNameReservationKey({ name: "c", depth: 1, parentSessionPath: "/a:b" }),
		);
		expect(sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" })).toBe(
			sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" }),
		);
	});

	it("holds a root rename reservation until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-rename-race-"));
		tempDirs.push(directory);
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			rlmDepth: 0,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			rlmDepth: 0,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") return success(undefined, "list", { sessions: [firstSummary] });
			await renameGate;
			return success(undefined, "rename", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		seedSupervisorRoster(supervisor, firstWorker, secondWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename",
			activeSessionId: "first-active",
			name: "shared-root",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename",
				activeSessionId: "second-active",
				name: "shared-root",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("allows only a resident worker token to rename a client-owned session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-worker-rename-"));
		tempDirs.push(directory);
		const ownedSummary = summary({
			id: "owned-active",
			activeSessionId: "owned-active",
			sessionId: "owned-session",
			rlmDepth: 0,
		});
		const ownedWorker = worker("owned", [ownedSummary]);
		ownedWorker.descriptor.ownerClientId = "interactive-client";
		ownedWorker.client.request.mockResolvedValue(success(undefined, "set_session_name"));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("owned", ownedWorker);
		seedSupervisorRoster(supervisor, ownedWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });
		const workerClient = { id: "daemon-client:worker", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(workerClient, {
				type: "set_session_name",
				activeSessionId: "owned-active",
				name: "renamed-by-worker",
				workerToken: "owned-token",
			}),
		).resolves.toMatchObject({ success: true });
		expect(ownedWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name", activeSessionId: "owned-active" }),
			expect.any(Number),
		);

		ownedWorker.client.request.mockClear();
		for (const workerToken of [undefined, "foreign-token"]) {
			await expect(
				supervisor.handleCommand(workerClient, {
					type: "set_session_name",
					activeSessionId: "owned-active",
					name: "unauthorized",
					...(workerToken ? { workerToken } : {}),
				}),
			).rejects.toThrow("Unknown active session: owned-active");
		}
		expect(ownedWorker.client.request).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name" }),
			expect.any(Number),
		);
	});

	it("serializes active saved-session renames until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-active-saved-rename-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			sessionFile: firstPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			sessionFile: secondPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.client.request.mockImplementation(async () => {
			await renameGate;
			return success(undefined, "rename_saved_session", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename_saved_session", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		seedSupervisorRoster(supervisor, firstWorker, secondWorker);
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => []),
				list: vi.fn(async () => []),
			},
		});
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			activeSessionId: "first-active",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename_saved_session" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				activeSessionId: "second-active",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("serializes same-scope inactive renames across catalog validation and commit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-rename-race-"));
		tempDirs.push(directory);
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const parentSessionPath = join(directory, "parent.jsonl");
		const saved = [firstPath, secondPath].map((path, index) => ({
			id: `saved-${index}`,
			path,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		}));
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const rename = vi.fn(async () => renameGate);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => saved),
			rlmSpawnLedger: vi.fn(() => ({ appendRenameByChildPath: vi.fn(async () => {}) })),
			catalog: {
				rename,
			},
		});
		const client = {};

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("reserves named child creates by parent scope until worker launch completes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-create-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const child = (id: string) => ({
			id,
			path: join(directory, `${id}.jsonl`),
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		});
		const firstChild = child("first-child");
		const secondChild = child("second-child");
		let releaseLaunch: () => void = () => {};
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const launched = worker("opened");
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return launched;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async (path: string) => [path === firstChild.path ? firstChild : secondChild]),
			catalog: {
				resolve: vi.fn(async (path: string) => path),
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", {
			type: "create",
			name: "shared-child",
			sessionPath: firstChild.path,
		});
		await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledOnce());
		await expect(
			supervisor.createOrReuseWorker("client", {
				type: "create",
				name: "shared-child",
				sessionPath: secondChild.path,
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseLaunch();
		await expect(first).resolves.toBe(launched);
	});

	it("scopes authenticated peer queries by sessions directory and excludes disconnected workers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-peers-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const sessionsA = join(directory, "sessions-a");
		const sessionsB = join(directory, "sessions-b");
		mkdirSync(sessionsA, { recursive: true });
		mkdirSync(sessionsB, { recursive: true });
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory, sessionDir: sessionsB },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const client = new DaemonClient(socketPath);
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();

		const passive = summary({
			id: "passive-session",
			sessionId: "passive-session",
			sessionFile: join(directory, "passive.jsonl"),
			sessionName: "passive-worker",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const firstRoot = summary({
			id: "first-root-active",
			activeSessionId: "first-root-active",
			sessionId: "first-root-session",
			runtimeKind: "top-level",
		});
		const secondRoot = summary({
			id: "second-root-active",
			activeSessionId: "second-root-active",
			sessionId: "second-root-session",
		});
		const sameDirectoryRoot = summary({
			id: "same-directory-root-active",
			activeSessionId: "same-directory-root-active",
			sessionId: "same-directory-root-session",
			runtimeKind: "top-level",
		});
		const disconnectedRoot = summary({
			id: "disconnected-root-active",
			activeSessionId: "disconnected-root-active",
			sessionId: "disconnected-root-session",
		});
		const first = worker("first", [firstRoot, passive]);
		first.descriptor.sessionDir = sessionsA;
		const second = worker("second", [secondRoot]);
		second.descriptor.sessionDir = sessionsB;
		const sameDirectory = worker("same-directory", [sameDirectoryRoot]);
		sameDirectory.descriptor.sessionDir = sessionsB;
		const disconnected = worker("disconnected", [disconnectedRoot]);
		disconnected.descriptor.sessionDir = sessionsB;
		Object.assign(disconnected, { client: undefined });

		try {
			await supervisor.start();
			supervisor.workers.set("first", first);
			supervisor.workers.set("second", second);
			supervisor.workers.set("same-directory", sameDirectory);
			supervisor.workers.set("disconnected", disconnected);
			seedSupervisorRoster(supervisor, first, second, disconnected);
			await client.connect();

			await expect(
				client.request({ type: "list_agent_peers", workerToken: "invalid-token" }),
			).resolves.toMatchObject({
				success: false,
				error: "Worker authentication failed",
			});
			const response = await client.request({
				type: "list_agent_peers",
				workerToken: second.descriptor.authenticationToken,
			});
			expect(response).toMatchObject({
				success: true,
				data: {
					peers: [
						expect.objectContaining({
							activeSessionId: "same-directory-root-active",
							sessionId: "same-directory-root-session",
							runtimeKind: "top-level",
						}),
					],
				},
			});
		} finally {
			client.close();
			supervisor.workers.clear();
			await supervisor.cleanupSupervisorResources();
		}
	});
});
