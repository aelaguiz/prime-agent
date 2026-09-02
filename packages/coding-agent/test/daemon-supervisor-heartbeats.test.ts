import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	workers: Map<string, unknown>;
	clients: Set<unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering" | "failed", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		// Both catalogs are current, so the second list costs no worker RPC at all.
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("serves current workers from the catalog and refreshes only the stale one", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		await supervisor.handleCommand({} as DaemonSocketClient, { id: "list-1", type: "heartbeats_list" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);

		supervisor.handleWorkerFrame(second, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const refreshed = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(refreshed).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
		expect(supervisor.forwardToWorker).toHaveBeenLastCalledWith(
			second,
			expect.objectContaining({ type: "heartbeats_list" }),
			5000,
		);
	});

	it("shares one in-flight refresh across concurrent client requests", async () => {
		const supervisor = createSupervisorHarness();
		const target = worker("ready");
		supervisor.workers.set("target", target);
		const gate = new Promise<void>((resolve) => setTimeout(resolve, 20));
		supervisor.forwardToWorker = vi.fn(async (_target, command) => {
			await gate;
			return success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] });
		});

		const first = supervisor.handleCommand({} as DaemonSocketClient, { id: "list-a", type: "heartbeats_list" });
		const second = supervisor.handleCommand({} as DaemonSocketClient, { id: "list-b", type: "heartbeats_list" });
		const responses = await Promise.all([first, second]);

		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		for (const [index, response] of responses.entries()) {
			expect(response).toMatchObject({
				id: index === 0 ? "list-a" : "list-b",
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
		}
	});

	it("returns a worker failure instead of a partial catalog", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("keeps a worker stale and serves its last snapshot when the refresh fails", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-stale",
			type: "heartbeats_list",
		});

		// The refresh was attempted and failed: the worker stays stale so the next
		// request retries, and the client still gets the last known catalog.
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
		expect(target.heartbeatSnapshotStale).toBe(true);
		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
	});

	it("fails rather than returning a partial catalog without a cached snapshot", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.workers.set("recovering", worker("recovering", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: false,
			error: "Cannot list heartbeats while session worker is recovering",
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("skips terminally failed workers without blocking healthy heartbeats", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("healthy", worker("ready"));
		supervisor.workers.set("failed", worker("failed", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-failed-worker",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("routes management by cached job ownership after a session unloads", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1", activeSessionId: "unloaded-session" } }],
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, {
				heartbeat: { id: "heartbeat-1", activeSessionId: "unloaded-session", status: "cancelled" },
			}),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: "unloaded-session",
			jobId: "heartbeat-1",
			action: "stop",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeat_manage", jobId: "heartbeat-1" }),
		);
		expect(target.heartbeatSnapshot).toEqual([]);
	});

	it("keeps a worker stale when a heartbeat change lands mid-refresh", async () => {
		const supervisor = createSupervisorHarness();
		const target = { ...worker("ready"), heartbeatSnapshotStale: false };
		supervisor.workers.set("target", target);
		let calls = 0;
		supervisor.forwardToWorker = vi.fn(async (_target, command) => {
			calls += 1;
			if (calls === 1) {
				// The worker changed after it computed this reply: the change is not in it.
				supervisor.handleWorkerFrame(target, {
					header: { kind: "outbound", outboundType: "heartbeats_changed" },
					payload: Buffer.alloc(0),
				});
			}
			return success(command.id, command.type, {
				heartbeats: [{ job: { id: calls === 1 ? "heartbeat-1" : "heartbeat-2" } }],
			});
		});

		const first = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(first).toMatchObject({ success: true, data: { heartbeats: [{ job: { id: "heartbeat-1" } }] } });
		expect(target.heartbeatSnapshotStale).toBe(true);

		const second = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(second).toMatchObject({ success: true, data: { heartbeats: [{ job: { id: "heartbeat-2" } }] } });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
		expect(target.heartbeatSnapshotStale).toBe(false);
	});

	it("collapses a burst of worker heartbeat changes into one client broadcast", () => {
		const supervisor = createSupervisorHarness();
		const writes: string[] = [];
		supervisor.clients.add({
			socket: {
				destroyed: false,
				write: (line: unknown) => {
					writes.push(String(line));
					return true;
				},
			},
		});
		const target = worker("ready");
		supervisor.workers.set("target", target);
		const changed = () =>
			supervisor.handleWorkerFrame(target, {
				header: { kind: "outbound", outboundType: "heartbeats_changed" },
				payload: Buffer.alloc(0),
			});
		vi.useFakeTimers();

		for (let index = 0; index < 5; index++) {
			changed();
		}
		expect(writes).toHaveLength(0);

		vi.advanceTimersByTime(1_000);
		expect(writes.filter((line) => line.includes("heartbeats_changed"))).toHaveLength(1);

		changed();
		vi.advanceTimersByTime(1_000);
		expect(writes.filter((line) => line.includes("heartbeats_changed"))).toHaveLength(2);
	});
});
