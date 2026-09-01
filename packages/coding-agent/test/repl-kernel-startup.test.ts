import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { installTestOrphanProcessJournal } from "./orphan-process-journal-test-helper.js";

function clearInheritedProcessTestEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("RLM_") || name.startsWith("PRIME_AGENT_INTERNAL_")) delete process.env[name];
	}
}

clearInheritedProcessTestEnvironment();

const lifecycleEnvironment = vi.hoisted(() => {
	const priorAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
	const base = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
	const agentDir = `${base}/prime-agent-repl-lifecycle-${process.pid}-${Math.random().toString(16).slice(2)}`;
	process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
	return { agentDir, priorAgentDir };
});

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForLifecycleCondition(
	startIndex: number,
	predicate: (events: Record<string, unknown>[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const events = readLifecycleEvents().slice(startIndex);
		if (predicate(events)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Timed out waiting for lifecycle condition");
}

function readLifecycleEvents(): Record<string, unknown>[] {
	const directory = join(lifecycleEnvironment.agentDir, "logs", "processes");
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) =>
			readFileSync(join(directory, name), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		);
}

afterAll(() => {
	rmSync(lifecycleEnvironment.agentDir, { recursive: true, force: true });
	if (lifecycleEnvironment.priorAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
	else process.env.PRIME_AGENT_CODING_AGENT_DIR = lifecycleEnvironment.priorAgentDir;
});

describe("ReplKernelManager startup", () => {
	let restoreJournal = () => {};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-startup-"));
		restoreJournal = installTestOrphanProcessJournal(tempDir);
	});

	afterEach(() => {
		restoreJournal();
		restoreJournal = () => {};
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces an early exit and records bounded private failure evidence", async () => {
		const eventStart = readLifecycleEvents().length;
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/usr/bin/env node",
				'process.stderr.write("private-prefix-" + "x".repeat(40_000) + "fake runtime died before ready\\n");',
				"process.exit(42);",
				"",
			].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*fake runtime died before ready/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const events = readLifecycleEvents().slice(eventStart);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("private-prefix");
		expect(serialized).not.toContain("fake runtime died before ready");
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_process_exit",
				details: expect.objectContaining({
					launchMode: "direct",
					transport: "rlm-repl-stdio",
					expected: false,
					code: 42,
					stderrTail: expect.objectContaining({
						redacted: true,
						byteLength: 32 * 1024,
					}),
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_start_failed",
				details: expect.objectContaining({
					launchMode: "direct",
					code: 42,
					childProcessInstanceId: expect.any(String),
					stderrTail: expect.objectContaining({ redacted: true, byteLength: 32 * 1024 }),
				}),
			}),
		);
	});

	it("fails an old protocol-3 runtime before sending user code", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			["#!/bin/sh", `echo '{"event":"ready","protocol":3,"python":"3.13.0"}'`, "exec sleep 60", ""].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/speaks protocol 3, expected 4/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("fails the admitted target without running it when the configured interpreter path is absent", async () => {
		const eventStart = readLifecycleEvents().length;
		const python = join(tempDir, "does-not-exist");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			// Resolution is lexical. The admitted gate performs the first target
			// access only after durable enrollment and returns the conventional 127.
			await expect(manager.start()).rejects.toThrow(/Kernel exited before ready/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const failure = readLifecycleEvents()
			.slice(eventStart)
			.find((event) => event.event === "kernel_start_failed");
		expect(failure).toEqual(
			expect.objectContaining({
				details: expect.objectContaining({
					launchMode: "direct",
					code: 127,
					childProcessInstanceId: expect.any(String),
				}),
			}),
		);
	});

	it("times out a runtime that never sends ready", async () => {
		vi.useFakeTimers();
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "exec sleep 120", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			let settled = false;
			const startPromise = manager.start();
			void startPromise.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const expectation = expect(startPromise).rejects.toThrow(/did not become ready within 30000ms/);
			const internals = manager as unknown as { readyDeferred?: unknown };
			await vi.waitFor(() => expect(internals.readyDeferred).toBeDefined());
			await vi.advanceTimersByTimeAsync(30_000);
			// Cleanup creates bounded death-proof timers after the ready deadline;
			// keep advancing until the exact child exit settles the startup.
			await vi.waitFor(() => expect(settled).toBe(true));
			await expectation;
		} finally {
			vi.useRealTimers();
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it.runIf(process.platform !== "win32")(
		"scrubs lifecycle identity and records an expected exit when a starting kernel is killed",
		async () => {
			const eventStart = readLifecycleEvents().length;
			const python = join(tempDir, "python");
			const environmentPath = join(tempDir, "kernel-environment.txt");
			const pidPath = join(tempDir, "kernel.pid");
			writeExecutable(
				python,
				[
					"#!/bin/sh",
					`printf '%s\\n' "$PRIME_AGENT_INTERNAL_PROCESS_INSTANCE_ID" "$PRIME_AGENT_INTERNAL_PARENT_PROCESS_INSTANCE_ID" "$PRIME_AGENT_INTERNAL_PROCESS_LAUNCH_TRIGGER" "$PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_CONTEXT" "$PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_ROLE" > ${JSON.stringify(environmentPath)}`,
					`echo $$ > ${JSON.stringify(pidPath)}`,
					// Keep the admission token in the shell's argv while it waits.
					"sleep 30",
					"",
				].join("\n"),
			);
			const manager = new ReplKernelManager({
				python,
				cwd: tempDir,
				env: {
					PRIME_AGENT_INTERNAL_PROCESS_INSTANCE_ID: "must-not-reach-python",
					PRIME_AGENT_INTERNAL_PARENT_PROCESS_INSTANCE_ID: "must-not-reach-python",
					PRIME_AGENT_INTERNAL_PROCESS_LAUNCH_TRIGGER: "must-not-reach-python",
					PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_CONTEXT: "must-not-reach-python",
					PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_ROLE: "must-not-reach-python",
				},
			});
			const start = manager.start();
			const startFailure = expect(start).rejects.toThrow();
			await waitForFile(pidPath);

			await manager.kill();
			await startFailure;
			await waitForLifecycleCondition(eventStart, (events) =>
				events.some(
					(record) =>
						record.event === "kernel_process_exit" &&
						(record.details as { expected?: boolean }).expected === true,
				),
			);

			expect(readFileSync(environmentPath, "utf8")).toBe("\n\n\n\n\n");
			const events = readLifecycleEvents().slice(eventStart);
			expect(events).toContainEqual(
				expect.objectContaining({
					event: "kernel_kill",
					details: expect.objectContaining({ launchMode: "direct", expected: true, signal: "SIGKILL" }),
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					event: "kernel_process_exit",
					details: expect.objectContaining({ launchMode: "direct", expected: true, signal: "SIGKILL" }),
				}),
			);
		},
	);

	it("records a bounded protocol repair attempt and outcome", async () => {
		const eventStart = readLifecycleEvents().length;
		const python = join(tempDir, "python");
		const countPath = join(tempDir, "spawn-count");
		writeExecutable(
			python,
			`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const count = fs.existsSync(${JSON.stringify(countPath)}) ? Number(fs.readFileSync(${JSON.stringify(countPath)}, "utf8")) + 1 : 1;
fs.writeFileSync(${JSON.stringify(countPath)}, String(count));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 4, python: process.version });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute" && request.code === "corrupt" && count === 1) {
    process.stdout.write("BROKEN-private-protocol-value\\n");
    return;
  }
  emit({ event: "done", id: request.id, status: "ok" });
  if (request.type === "shutdown") process.exit(0);
});
`,
		);
		const manager = new ReplKernelManager({ python, cwd: tempDir });
		try {
			await expect(manager.execute("corrupt")).rejects.toThrow(/may or may not have run; it was not replayed/);
			await expect(manager.execute("1 + 1")).resolves.toMatchObject({ status: "ok" });
			expect(readFileSync(countPath, "utf8")).toBe("2");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const events = readLifecycleEvents().slice(eventStart);
		expect(JSON.stringify(events)).not.toContain("private-protocol-value");
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_repair",
				details: expect.objectContaining({ phase: "requested", reason: "protocol-corruption" }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_repair",
				details: expect.objectContaining({ phase: "completed", reason: "protocol-corruption" }),
			}),
		);
		const childIds = events
			.filter((event) => event.event === "kernel_process_start")
			.map((event) => (event.details as { childProcessInstanceId?: string }).childProcessInstanceId);
		expect(new Set(childIds).size).toBe(2);
	});

	it("repairs an unexpected ready-runtime exit once without replaying the active cell", async () => {
		const eventStart = readLifecycleEvents().length;
		const python = join(tempDir, "python");
		const spawnCountPath = join(tempDir, "spawn-count");
		const requestLogPath = join(tempDir, "requests.log");
		const crashMarkerPath = join(tempDir, "crash-marker");
		const snapshotPath = join(tempDir, "kernel-state.json");
		const manifestPath = join(tempDir, "kernel-state-manifest.json");
		writeExecutable(
			python,
			`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const spawnCount = fs.existsSync(${JSON.stringify(spawnCountPath)})
  ? Number(fs.readFileSync(${JSON.stringify(spawnCountPath)}, "utf8")) + 1
  : 1;
fs.writeFileSync(${JSON.stringify(spawnCountPath)}, String(spawnCount));
const log = (entry) => fs.appendFileSync(${JSON.stringify(requestLogPath)}, entry + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let state = {};
emit({ event: "ready", protocol: 4, python: process.version });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    log(spawnCount + ":execute:" + request.code);
    if (request.code === "seed") state.safe = 41;
    if (request.code === "crash" && spawnCount === 1) {
      fs.appendFileSync(${JSON.stringify(crashMarkerPath)}, "ran\\n");
      process.exit(42);
    }
    if (request.code === "safe") emit({ event: "result", id: request.id, text: String(state.safe) });
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "snapshot") {
    log(spawnCount + ":snapshot");
    fs.writeFileSync(request.path, JSON.stringify(state));
    fs.writeFileSync(request.manifest_path, "{}");
    emit({ event: "done", id: request.id, status: "ok", saved: Object.keys(state), skipped: [], bytes: 2 });
    return;
  }
  if (request.type === "restore") {
    log(spawnCount + ":restore");
    state = JSON.parse(fs.readFileSync(request.path, "utf8"));
    emit({ event: "done", id: request.id, status: "ok", restored: Object.keys(state), failed: [] });
    return;
  }
  emit({ event: "done", id: request.id, status: "ok" });
  if (request.type === "shutdown") process.exit(0);
});
`,
		);
		const manager = new ReplKernelManager({
			python,
			cwd: tempDir,
			snapshot: { path: snapshotPath, manifestPath, debounceMs: 60_000 },
		});
		try {
			await expect(manager.execute("seed")).resolves.toMatchObject({ status: "ok" });
			await expect(manager.snapshotState()).resolves.toMatchObject({ saved: ["safe"] });
			await expect(manager.execute("crash")).rejects.toThrow(
				/exited unexpectedly[\s\S]*may or may not have run; it was not replayed/,
			);
			await expect(manager.execute("safe")).resolves.toMatchObject({ status: "ok", result: "41" });
		} finally {
			await manager.shutdown({ drainHostRequests: true });
		}

		expect(readFileSync(spawnCountPath, "utf8")).toBe("2");
		expect(readFileSync(crashMarkerPath, "utf8").trim().split("\n")).toEqual(["ran"]);
		const requests = readFileSync(requestLogPath, "utf8").trim().split("\n");
		expect(requests.filter((entry) => entry.endsWith(":execute:crash"))).toHaveLength(1);
		expect(requests.filter((entry) => entry.endsWith(":restore"))).toHaveLength(1);

		const events = readLifecycleEvents().slice(eventStart);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_process_exit",
				details: expect.objectContaining({ expected: false, code: 42 }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_repair",
				details: expect.objectContaining({ phase: "requested", reason: "unexpected-exit" }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_repair",
				details: expect.objectContaining({ phase: "completed", reason: "unexpected-exit" }),
			}),
		);
		const childIds = events
			.filter((event) => event.event === "kernel_process_start")
			.map((event) => (event.details as { childProcessInstanceId?: string }).childProcessInstanceId);
		expect(childIds).toHaveLength(2);
		expect(new Set(childIds).size).toBe(2);
	}, 30_000);
});
