import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

const lifecycleEnvironment = vi.hoisted(() => {
	const priorAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
	const priorForkServer = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
	const base = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
	const agentDir = `${base}/prime-agent-kernel-lifecycle-${process.pid}-${Math.random().toString(16).slice(2)}`;
	process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
	process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
	return { agentDir, priorAgentDir, priorForkServer };
});

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			readFileSync(path);
			return;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForLifecycleCondition(predicate: (events: Record<string, unknown>[]) => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const events = readLifecycleEvents();
		if (predicate(events)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Timed out waiting for lifecycle condition");
}

function readLifecycleEvents(): Record<string, unknown>[] {
	const directory = join(lifecycleEnvironment.agentDir, "logs", "processes");
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
	if (lifecycleEnvironment.priorForkServer === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
	else process.env.PRIME_AGENT_KERNEL_FORKSERVER = lifecycleEnvironment.priorForkServer;
});

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake kernel died before binding" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		const events = readLifecycleEvents();
		expect(JSON.stringify(events)).not.toContain("fake kernel died before binding");
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "kernel_process_exit",
				details: expect.objectContaining({
					launchMode: "direct",
					expected: false,
					code: 42,
					stderrTail: expect.objectContaining({ redacted: true, byteLength: expect.any(Number) }),
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
					stderrTail: expect.objectContaining({ redacted: true, byteLength: expect.any(Number) }),
				}),
			}),
		);
	});

	it.runIf(process.platform !== "win32")(
		"records the observed exit after killing a starting direct kernel",
		async () => {
			const python = join(tempDir, "python");
			const pidPath = join(tempDir, "kernel.pid");
			writeExecutable(python, ["#!/bin/sh", `echo $$ > ${JSON.stringify(pidPath)}`, "sleep 30", ""].join("\n"));
			const manager = new KernelManager({ python, cwd: tempDir });
			const start = manager.start();
			const startFailure = expect(start).rejects.toThrow();
			await waitForFile(pidPath);

			await manager.kill();
			await startFailure;
			await waitForLifecycleCondition((events) =>
				events.some(
					(record) =>
						record.event === "kernel_process_exit" &&
						(record.details as { expected?: boolean }).expected === true,
				),
			);

			const events = readLifecycleEvents();
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

	it("does not pass Node lifecycle identity through a direct Python kernel environment", async () => {
		const python = join(tempDir, "python");
		const environmentPath = join(tempDir, "kernel-environment.txt");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				`printf '%s\n' "$PRIME_AGENT_INTERNAL_PROCESS_INSTANCE_ID" "$PRIME_AGENT_INTERNAL_PARENT_PROCESS_INSTANCE_ID" "$PRIME_AGENT_INTERNAL_PROCESS_LAUNCH_TRIGGER" "$PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_CONTEXT" "$PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_ROLE" > ${JSON.stringify(environmentPath)}`,
				"exit 42",
				"",
			].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({
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

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before resolving ports/);
			expect(readFileSync(environmentPath, "utf8")).toBe("\n\n\n\n\n");
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("disables shared IPython history for direct kernel launches", async () => {
		const python = join(tempDir, "python");
		const argvPath = join(tempDir, "kernel-argv.txt");
		writeExecutable(
			python,
			["#!/bin/sh", `printf '%s\n' "$@" > ${JSON.stringify(argvPath)}`, "exit 42", ""].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before resolving ports/);
			const argv = readFileSync(argvPath, "utf8").trim().split("\n");
			expect(argv.slice(0, 4)).toEqual(["-m", "ipykernel_launcher", "--HistoryManager.enabled=False", "-f"]);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});
});
