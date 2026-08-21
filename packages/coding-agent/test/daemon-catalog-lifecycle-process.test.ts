import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(__dirname, "fixtures/daemon-catalog-lifecycle-child.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

interface LifecycleRecord {
	event: string;
	context?: { role?: string };
	details?: Record<string, unknown>;
}

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function readRecords(agentDir: string): LifecycleRecord[] {
	const directory = join(agentDir, "logs", "processes");
	return readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) =>
			readFileSync(join(directory, name), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as LifecycleRecord),
		);
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error("Timed out waiting for catalog lifecycle fixture")),
			20_000,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectExit(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

describe("daemon catalog lifecycle evidence", () => {
	it.runIf(process.platform !== "win32")("records an unexpected death and lazy recovery", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-catalog-lifecycle-test-"));
		tempDirs.push(agentDir);
		const environment = { ...process.env };
		delete environment.PRIME_AGENT_INTERNAL_DAEMON_WORKER;
		const child = spawn(process.execPath, [tsxPath, fixturePath], {
			env: {
				...environment,
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);

		const result = await waitForExit(child);
		expect(result).toEqual({ code: 0, signal: null });
		const records = readRecords(agentDir);
		const parentRecords = records.filter((record) => record.context?.role === "daemon-catalog-test-parent");
		expect(parentRecords).toContainEqual(
			expect.objectContaining({
				event: "daemon_catalog_exit",
				details: expect.objectContaining({ expected: false, signal: "SIGKILL" }),
			}),
		);
		expect(parentRecords).toContainEqual(expect.objectContaining({ event: "daemon_catalog_recovery_attempt" }));
		expect(parentRecords).toContainEqual(
			expect.objectContaining({
				event: "daemon_catalog_recovery_result",
				details: expect.objectContaining({ status: "ready" }),
			}),
		);
		expect(parentRecords).toContainEqual(
			expect.objectContaining({
				event: "daemon_catalog_exit",
				details: expect.objectContaining({ expected: true, code: 0 }),
			}),
		);
	});
});
