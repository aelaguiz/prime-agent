import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PUBLIC_COMMAND_NAMES } from "../src/cli/command-registry.js";
import {
	awaitOwnedWorkerSpawn,
	classifyOwnedSessionWorkerInvocation,
	createOwnedWorkerLaunchSpec,
	createRpcRecoveryArgs,
	isOwnedSessionWorkerProcess,
	OWNED_WORKER_STARTUP_GATE_SOURCE,
	reapOwnedWorkerResources,
} from "../src/cli/owned-session-worker.js";
import { initializeOrphanProcessJournal } from "../src/core/orphan-process-journal.js";
import { createProcessIdentityOwnerToken, observeProcessIdentity } from "../src/core/session-lease.js";

describe("owned session worker CLI routing", () => {
	it("checks and spawns the exact persistent owned-worker wrapper source", async () => {
		const syntax = spawnSync(process.execPath, ["--check"], {
			input: OWNED_WORKER_STARTUP_GATE_SOURCE,
			encoding: "utf8",
		});
		expect(syntax.status, syntax.stderr).toBe(0);
		expect(OWNED_WORKER_STARTUP_GATE_SOURCE).not.toContain("\0");
		expect(OWNED_WORKER_STARTUP_GATE_SOURCE).toContain(String.raw`includes("\0")`);
		expect(OWNED_WORKER_STARTUP_GATE_SOURCE).toContain(String.raw` + "\n"`);

		const ownerIdentity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", OWNED_WORKER_STARTUP_GATE_SOURCE, ownerIdentity.argument], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc", "pipe", "pipe", "pipe"],
		});
		const childStdio = child.stdio as Array<Readable | Writable | null | undefined>;
		let exactChildId: string | undefined;
		let cleanupError: Error | undefined;
		const stdout: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
		const control = childStdio[6];
		expect(control).toBeInstanceOf(Readable);
		let controlPayload = "";
		const controlDone = new Promise<void>((resolveControl, rejectControl) => {
			const timeout = setTimeout(() => rejectControl(new Error("Owned wrapper smoke timed out")), 5000);
			(control as Readable).on("data", (chunk: Buffer) => {
				controlPayload += chunk.toString("utf8");
			});
			(control as Readable).once("end", () => {
				clearTimeout(timeout);
				resolveControl();
			});
		});
		try {
			const observation = observeProcessIdentity(child.pid!);
			if (observation.status !== "present-exact")
				throw new Error("Owned wrapper exact teardown authority unavailable");
			exactChildId = observation.id;
			(childStdio[5] as Writable).end(
				JSON.stringify({
					command: process.execPath,
					args: ["-e", 'process.stdout.write("owned-wrapper-smoke\\n");process.exit(31)'],
					argv0: `${process.execPath} ${ownerIdentity.argument}`,
					cwd: process.cwd(),
					env: {},
				}),
			);
			(childStdio[4] as Writable).end("start\n");
			await controlDone;
			expect(JSON.parse(controlPayload)).toMatchObject({
				primeAgentStartupGate: 1,
				type: "target-exit",
				exitCode: 31,
				signal: null,
			});
			await vi.waitFor(() => expect(Buffer.concat(stdout).toString("utf8")).toBe("owned-wrapper-smoke\n"));
			expect(() => process.kill(child.pid!, 0)).not.toThrow();
		} finally {
			if (child.pid && exactChildId) {
				const observation = observeProcessIdentity(child.pid);
				if (observation.status !== "absent") {
					if (observation.status !== "present-exact" || observation.id !== exactChildId) {
						cleanupError = new Error("Retained owned-wrapper cleanup artifact after exact identity mismatch");
					} else {
						process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
					}
				}
			}
			if (!cleanupError) {
				await new Promise<void>((resolveExit) => {
					if (child.exitCode !== null || child.signalCode !== null) resolveExit();
					else child.once("exit", () => resolveExit());
				});
			}
		}
		if (cleanupError) throw cleanupError;
	});

	it("leaves resident interactive and non-session operations in the frontend", () => {
		expect(classifyOwnedSessionWorkerInvocation([], true, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--mode", "daemon"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--help"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--version"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--list-models"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--export", "session.jsonl"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["help"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["help", "me", "fix", "this"], false, {})).toBe("print");
		expect(classifyOwnedSessionWorkerInvocation(["daemon", "list"], false, {})).toBeUndefined();
		for (const command of PUBLIC_COMMAND_NAMES) {
			expect(classifyOwnedSessionWorkerInvocation([command], false, {})).toBeUndefined();
		}
	});

	it("does not recursively route an owned worker", () => {
		expect(isOwnedSessionWorkerProcess({ PRIME_AGENT_INTERNAL_OWNED_WORKER: "1" })).toBe(true);
		expect(isOwnedSessionWorkerProcess({})).toBe(false);
		expect(
			classifyOwnedSessionWorkerInvocation(["--mode", "rpc"], true, {
				PRIME_AGENT_INTERNAL_OWNED_WORKER: "1",
			}),
		).toBeUndefined();
	});

	it("preserves the current runtime flags and CLI entrypoint", () => {
		expect(createOwnedWorkerLaunchSpec(["--mode", "rpc"], "/node", ["--loader", "tsx"], "/cli.ts")).toEqual({
			command: "/node",
			args: ["--loader", "tsx", "/cli.ts", "--mode", "rpc"],
		});
	});

	it("waits for a delayed spawn event before accepting worker identity", async () => {
		const child = new EventEmitter() as unknown as ChildProcess;
		Object.defineProperty(child, "pid", { configurable: true, value: undefined, writable: true });
		let settled = false;
		const waiting = awaitOwnedWorkerSpawn(child).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		Object.defineProperty(child, "pid", { configurable: true, value: 42_424, writable: true });
		child.emit("spawn");
		await waiting;
		expect(settled).toBe(true);
		expect(child.pid).toBe(42_424);
	});

	it("retains an unverifiable prior-generation orphan journal", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-orphans-"));
		const journalPath = join(root, "orphans.jsonl");
		const contents = `${JSON.stringify({
			version: 1,
			pid: 2_000_000_001,
			ownerPid: 2_000_000_002,
			active: true,
			recordedAt: new Date(0).toISOString(),
		})}
`;
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			writeFileSync(journalPath, contents);
			await expect(reapOwnedWorkerResources({ pid: 2_000_000_000 }, journalPath)).resolves.toBe(false);
			expect(existsSync(journalPath)).toBe(true);
			expect(readFileSync(journalPath, "utf8")).toBe(contents);
		} finally {
			platform.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an injected PID-reuse identity in the production owned cleanup path", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-pid-reuse-"));
		const journalPath = join(root, "orphans.jsonl");
		initializeOrphanProcessJournal(journalPath);
		const identity = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", identity.argument], {
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		await awaitOwnedWorkerSpawn(child);
		const live = observeProcessIdentity(child.pid!);
		if (live.status !== "present-exact") throw new Error("Exact teardown authority unavailable");
		const zeroToken = `token:${"0".repeat(64)}`;
		const reusedIdentity = live.id === zeroToken ? `token:${"1".repeat(64)}` : zeroToken;
		let cleanupError: Error | undefined;
		try {
			await expect(
				reapOwnedWorkerResources({ pid: child.pid!, processStartId: reusedIdentity }, journalPath),
			).resolves.toBe(false);
			expect(() => process.kill(child.pid!, 0)).not.toThrow();
		} finally {
			const current = observeProcessIdentity(child.pid!);
			if (current.status !== "absent") {
				if (current.status !== "present-exact" || current.id !== live.id) {
					cleanupError = new Error("Retained PID-reuse test artifact after exact identity mismatch");
				} else {
					process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL");
					await new Promise<void>((resolve) => child.once("exit", () => resolve()));
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
		if (cleanupError) throw cleanupError;
	});

	it("fails closed when owned cleanup authority is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-missing-orphans-"));
		try {
			await expect(reapOwnedWorkerResources(undefined, join(root, "missing.jsonl"))).resolves.toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restarts RPC against the exact persisted session without changing public flags", () => {
		expect(
			createRpcRecoveryArgs(
				["--mode", "rpc", "--continue", "--resume", "/old.jsonl", "--model", "openai/gpt-5"],
				"/current.jsonl",
			),
		).toEqual(["--mode", "rpc", "--model", "openai/gpt-5", "--resume", "/current.jsonl"]);
	});
});
