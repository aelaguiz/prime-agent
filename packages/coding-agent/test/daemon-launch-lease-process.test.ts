import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(import.meta.dirname, "fixtures/daemon-launch-lease-contender.ts");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolveMessage, rejectMessage) => {
		const onMessage = (message: unknown): void => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
			cleanup();
			resolveMessage(message as Record<string, unknown>);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			rejectMessage(new Error(`lease contender exited before ${type} (code=${code}, signal=${signal})`));
		};
		const cleanup = (): void => {
			child.off("message", onMessage);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.on("exit", onExit);
	});
}

describe("daemon launch lease process election", () => {
	it("elects exactly one leader across simultaneous frontend processes", async () => {
		const directory = mkdtempSync(join(import.meta.dirname, ".launch-lease-process-"));
		temporaryDirectories.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const barrierPath = join(directory, "start");
		const releasePath = join(directory, "release");
		const contenders = Array.from({ length: 8 }, () => {
			const child = spawn(process.execPath, [tsxPath, fixturePath, socketPath, barrierPath, releasePath], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			children.push(child);
			return child;
		});
		const exits = contenders.map((child) => once(child, "exit"));
		await Promise.all(contenders.map((child) => waitForMessage(child, "ready")));
		const acquired = contenders.map((child) => waitForMessage(child, "acquired"));
		writeFileSync(barrierPath, "start\n");
		const results = await Promise.all(acquired);
		expect(results.filter((result) => result.leader === true)).toHaveLength(1);
		writeFileSync(releasePath, "release\n");
		await Promise.all(exits);
		expect(contenders.every((child) => child.exitCode === 0)).toBe(true);
	});
});
