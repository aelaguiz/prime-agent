import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

interface ShellLike extends AsyncIterable<Buffer[]> {
	close(): void;
	events: {
		off(event: string, listener: () => void): unknown;
	};
	send?(frames: Buffer[]): Promise<void>;
	immediate?: boolean;
	sendTimeout?: number;
}

interface KernelInternals {
	state: "idle" | "starting" | "running" | "shutdown";
	connection?: { key: string };
	shell?: ShellLike;
	shellPumpPromise?: Promise<void>;
	activeExecution?: unknown;
	start(): Promise<void>;
	startShellPump(): void;
	handleShellDisconnect(): void;
}

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((path): path is string => Boolean(path));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

function createFakeShell(frames: Buffer[][] = []): ShellLike {
	return {
		async *[Symbol.asyncIterator](): AsyncIterator<Buffer[]> {
			for (const message of frames) {
				yield message;
			}
		},
		close: vi.fn(),
		events: { off: vi.fn() },
		send: vi.fn(async () => undefined),
	};
}

describe("KernelManager shell channel", () => {
	it("continuously drains shell replies after startup", async () => {
		const manager = new KernelManager({});
		const internals = manager as unknown as KernelInternals;
		internals.state = "running";
		internals.shell = createFakeShell([[Buffer.from("reply-1")], [Buffer.from("reply-2")]]);

		internals.startShellPump();
		const pump = internals.shellPumpPromise;
		expect(pump).toBeInstanceOf(Promise);
		await pump;
		expect(internals.shellPumpPromise).toBeUndefined();

		manager.disposeSync();
	});

	it("fails an in-flight execution when the shell transport disconnects", async () => {
		const manager = new KernelManager({});
		const internals = manager as unknown as KernelInternals;
		const shell = createFakeShell();
		const send = shell.send;
		if (!send) throw new Error("fake shell send is missing");
		internals.state = "running";
		internals.connection = { key: "" };
		internals.shell = shell;
		internals.start = async () => undefined;

		const execution = manager.execute("side_effect()", { maxOutputChars: 1000 });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(internals.activeExecution).toBeDefined();

		internals.handleShellDisconnect();
		await expect(execution).rejects.toThrow(
			"The cell may or may not have run; restart the IPython kernel before retrying.",
		);
		expect(internals.activeExecution).toBeUndefined();

		manager.disposeSync();
	});

	it("reports an uncertain outcome when shell send fails", async () => {
		const manager = new KernelManager({});
		const internals = manager as unknown as KernelInternals;
		const shell = createFakeShell();
		shell.send = vi.fn(async () => {
			throw new Error("send timed out");
		});
		internals.state = "running";
		internals.connection = { key: "" };
		internals.shell = shell;
		internals.start = async () => undefined;

		await expect(manager.execute("side_effect()", { maxOutputChars: 1000 })).rejects.toThrow(
			"Kernel shell send failed: send timed out. The cell may or may not have run",
		);
		expect(internals.activeExecution).toBeUndefined();

		manager.disposeSync();
	});
});

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("KernelManager shell channel (real kernel)", () => {
	it("uses bounded immediate sends while preserving normal execution", async () => {
		const manager = new KernelManager({ python: python as string });
		const internals = manager as unknown as KernelInternals;
		try {
			await manager.start();
			expect(internals.shell?.immediate).toBe(true);
			expect(internals.shell?.sendTimeout).toBe(5000);
			const pump = internals.shellPumpPromise;
			expect(pump).toBeInstanceOf(Promise);

			const result = await manager.execute("print('shell-pump-ok')");
			expect(result.status).toBe("ok");
			expect(result.stdout.trim()).toBe("shell-pump-ok");
			expect(internals.shellPumpPromise).toBe(pump);
		} finally {
			await manager.dispose();
		}
	}, 30_000);
});
