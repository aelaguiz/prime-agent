import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessLifecycleInfo, prepareProcessLifecycleLaunch } from "../src/core/process-lifecycle.js";

const fixturePath = resolve(__dirname, "fixtures/process-lifecycle-child.ts");
const cliPath = resolve(__dirname, "../src/cli.ts");
const blockCliMainRegisterPath = resolve(__dirname, "fixtures/register-block-cli-main.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

interface LifecycleRecord {
	event: string;
	processInstanceId: string;
	cwd?: string;
	parentProcessInstanceId?: string;
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

function tempAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-process-lifecycle-test-"));
	tempDirs.push(directory);
	return directory;
}

function spawnFixture(
	agentDir: string,
	action: string,
	extraArgs: string[] = [],
	environment: NodeJS.ProcessEnv = {},
): ChildProcess {
	const child = spawn(process.execPath, ["--import", "tsx", fixturePath, action, ...extraArgs], {
		env: {
			...process.env,
			...environment,
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_TEST_REPORT_SECRET: "prime-report-env-secret",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	}
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for lifecycle fixture")), 10_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForStdout(child: ChildProcess, expected: string): Promise<void> {
	return new Promise((resolveReady, reject) => {
		let stdout = "";
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.includes(expected)) {
				clearTimeout(timeout);
				resolveReady();
			}
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function readLifecycleRecords(agentDir: string): LifecycleRecord[] {
	const directory = join(agentDir, "logs", "processes");
	if (!existsSync(directory)) return [];
	const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
	return files.flatMap((name) =>
		readFileSync(join(directory, name), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LifecycleRecord),
	);
}

async function waitForLifecycleEvent(agentDir: string, name: string): Promise<LifecycleRecord> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const record = readLifecycleRecords(agentDir).find((candidate) => candidate.event === name);
		if (record) return record;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Timed out waiting for lifecycle event ${name}`);
}

function event(records: LifecycleRecord[], name: string): LifecycleRecord {
	const record = records.find((candidate) => candidate.event === name);
	if (!record) throw new Error(`Missing lifecycle event ${name}`);
	return record;
}

describe("process lifecycle crash evidence", () => {
	it("persists an uncaught exception and a privacy-reduced diagnostic report", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "throw", ["prime-report-argv-secret"]);

		const result = await waitForExit(child);
		expect(result.code).toBe(1);
		const records = readLifecycleRecords(agentDir);
		event(records, "process_start");
		const fatal = event(records, "uncaught_exception");
		event(records, "process_exit");
		const reportPath = (fatal.details as { reportPath?: string }).reportPath;
		expect(reportPath).toBeTruthy();
		expect(existsSync(reportPath!)).toBe(true);
		const report = readFileSync(reportPath!, "utf8");
		expect(JSON.stringify(records)).not.toContain("prime-error-secret");
		expect(JSON.stringify(records)).not.toContain("prime-lifecycle-throw-sentinel");
		expect(report).not.toContain("prime-lifecycle-throw-sentinel");
		expect(report).not.toContain("prime-report-env-secret");
		expect(report).not.toContain("prime-report-argv-secret");
		expect(report).not.toContain("prime-error-secret");
		expect(report).not.toContain("sk-ant-abcdefghijklmnopqrstuv");
		expect(report).not.toContain("prime-cause-opaque-secret");
		expect(report).not.toContain("prime-cause-payload-opaque-secret");
		expect(JSON.stringify(records)).not.toContain("prime-cause-payload-opaque-secret");
	});

	it("persists an unhandled rejection and preserves the default fatal result", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "reject");

		const result = await waitForExit(child);
		expect(result.code).toBe(1);
		const records = readLifecycleRecords(agentDir);
		const fatal = event(records, "unhandled_rejection");
		expect(JSON.stringify(fatal)).not.toContain("prime-lifecycle-rejection-sentinel");
		expect(JSON.stringify(fatal)).toContain("process-lifecycle-child.ts");
		event(records, "process_exit");
	});

	it("preserves later fatal owners for uncaught exceptions and rejections", async () => {
		for (const [action, expectedCode, expectedEvent] of [
			["throw-owner", 79, "uncaught_exception"],
			["reject-owner", 80, "unhandled_rejection"],
		] as const) {
			const agentDir = tempAgentDir();
			const child = spawnFixture(agentDir, action);
			const result = await waitForExit(child);
			expect(result.code).toBe(expectedCode);
			event(readLifecycleRecords(agentDir), expectedEvent);
		}
	});

	it("preserves an explicit nonfatal Node unhandled-rejection mode", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "reject", [], { NODE_OPTIONS: "--unhandled-rejections=warn" });

		const result = await waitForExit(child);
		expect(result.code).toBe(0);
		const records = readLifecycleRecords(agentDir);
		event(records, "unhandled_rejection");
		event(records, "process_exit");
	});

	it("records safely after the process working directory is deleted", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "missing-cwd");

		const result = await waitForExit(child);
		expect(result.code).toBe(0);
		const records = readLifecycleRecords(agentDir);
		expect(event(records, "missing_cwd_fixture_event").cwd).toBe("<cwd-unavailable>");
	});

	it("never lets malformed diagnostic values crash the recorder", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "malformed-details");

		const result = await waitForExit(child);
		expect(result.code).toBe(0);
		const records = readLifecycleRecords(agentDir);
		event(records, "lifecycle_record_failed");
		event(records, "process_completed");
	});

	it("redacts sensitive keys in context and ordinary event details", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "sensitive");

		const result = await waitForExit(child);
		expect(result.code).toBe(0);
		const serialized = JSON.stringify(readLifecycleRecords(agentDir));
		for (const secret of [
			"prime-context-opaque-secret",
			"prime-details-opaque-secret",
			"prime-nested-opaque-secret",
			"prime-prompt-opaque-secret",
			"prime-provider-payload-opaque-secret",
			"prime-error-message-opaque-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain("<redacted>");
	});

	it("preserves Node warn-with-error-code rejection semantics", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "reject", [], {
			NODE_OPTIONS: "--unhandled-rejections=warn-with-error-code",
		});

		const result = await waitForExit(child);
		expect(result.code).toBe(1);
		const rejection = event(readLifecycleRecords(agentDir), "unhandled_rejection");
		expect(rejection.details as { fatal?: boolean; mode?: string }).toMatchObject({
			fatal: false,
			mode: "warn-with-error-code",
		});
	});

	it.runIf(bunAvailable && process.platform !== "win32")(
		"preserves an inherited internal role through the Bun entrypoint",
		async () => {
			const agentDir = tempAgentDir();
			const child = spawn("bun", ["src/bun/cli.ts"], {
				cwd: resolve(__dirname, ".."),
				env: {
					...process.env,
					PRIME_AGENT_CODING_AGENT_DIR: agentDir,
					PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "1",
				},
				stdio: "ignore",
			});
			children.add(child);
			const start = await waitForLifecycleEvent(agentDir, "process_start");
			child.kill("SIGKILL");
			await waitForExit(child);
			children.delete(child);

			expect(start.context?.role).toBe("daemon-catalog");
		},
	);

	it("captures an actual CLI failure before cli-main loads", async () => {
		const agentDir = tempAgentDir();
		const environment = { ...process.env };
		for (const name of [
			"PRIME_AGENT_INTERNAL_DAEMON_CATALOG",
			"PRIME_AGENT_INTERNAL_DAEMON_WORKER",
			"PRIME_AGENT_INTERNAL_OWNED_WORKER",
		]) {
			delete environment[name];
		}
		const child = spawn(process.execPath, ["--import", "tsx", "--import", blockCliMainRegisterPath, cliPath], {
			env: {
				...environment,
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);

		const result = await waitForExit(child);
		expect(result.code).toBe(1);
		const records = readLifecycleRecords(agentDir);
		const start = event(records, "process_start");
		expect(start.context?.role).toBe("client");
		const fatal = JSON.stringify(event(records, "uncaught_exception"));
		expect(fatal).not.toContain("prime-cli-main-import-failure-sentinel");
		expect(fatal).toContain("block-cli-main-loader.mjs");
	});

	it.runIf(process.platform !== "win32")("records SIGTERM without suppressing termination", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "signal");
		await waitForStdout(child, "ready");

		child.kill("SIGTERM");
		const result = await waitForExit(child);
		expect(result).toEqual({ code: null, signal: "SIGTERM" });
		const records = readLifecycleRecords(agentDir);
		expect((event(records, "signal_received").details as { signal?: string }).signal).toBe("SIGTERM");
	});

	it.runIf(process.platform !== "win32")("preserves a later role owner's signal result", async () => {
		const agentDir = tempAgentDir();
		const child = spawnFixture(agentDir, "signal-owner");
		await waitForStdout(child, "ready");

		child.kill("SIGTERM");
		const result = await waitForExit(child);
		expect(result.code).toBe(77);
		const records = readLifecycleRecords(agentDir);
		expect((event(records, "signal_received").details as { signal?: string }).signal).toBe("SIGTERM");
	});

	it("records clean completion and one file per preallocated process instance", async () => {
		const agentDir = tempAgentDir();
		const launch = prepareProcessLifecycleLaunch(process.env, {
			role: "prepared-test-child",
			trigger: "process-lifecycle-test",
			context: { fixture: true, credential: "prime-launch-context-opaque-secret" },
		});
		const child = spawnFixture(agentDir, "clean", [], launch.environment);

		const result = await waitForExit(child);
		expect(result.code).toBe(0);
		const processLog = join(agentDir, "logs", "processes", `${launch.childProcessInstanceId}.jsonl`);
		expect(existsSync(processLog)).toBe(true);
		const records = readLifecycleRecords(agentDir);
		expect(JSON.stringify(records)).not.toContain("prime-launch-context-opaque-secret");
		const start = event(records, "process_start");
		expect(start.processInstanceId).toBe(launch.childProcessInstanceId);
		expect(start.parentProcessInstanceId).toBe(getProcessLifecycleInfo().processInstanceId);
		expect(start.context?.role).toBe("prepared-test-child");
		event(records, "process_completed");
		event(records, "process_exit");
	});
});
