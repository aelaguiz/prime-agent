import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { DaemonClient } from "../../src/modes/daemon/daemon-client.js";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../tsconfig.json");
const fauxExtensionPath = resolve(__dirname, "../fixtures/service-tier-faux-extension.ts");
const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const tempRoots = new Set<string>();

afterEach(async () => {
	const exits: Array<Promise<void>> = [];
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			exits.push(new Promise((resolveExit) => child.once("exit", () => resolveExit())));
			child.kill("SIGKILL");
		}
	}
	await Promise.all(exits);
	children.clear();
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 5000);
		} catch {
			// The process may have exited before publishing its socket.
		} finally {
			client.close();
		}
		for (let attempt = 0; attempt < 50 && existsSync(socketPath); attempt++) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	daemonSockets.clear();
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	tempRoots.clear();
});

function sessionFilesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sessionFilesUnder(path);
		return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
	});
}

describe("public CLI service tier propagation", () => {
	it("crosses the real supervisor/worker path into the provider request and saved session", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-service-tier-process-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const socketPath = join(root, "daemon.sock");
		const requestLogPath = join(root, "provider-request.json");
		mkdirSync(agentDir, { recursive: true });
		daemonSockets.add(socketPath);

		let stdout = "";
		let stderr = "";
		const child = spawn(
			process.execPath,
			[
				tsxPath,
				cliPath,
				"--mode",
				"json",
				"--daemon-socket",
				socketPath,
				"--session-dir",
				sessionDir,
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.6-sol",
				"--thinking",
				"xhigh",
				"--service-tier",
				"priority",
				"--extension",
				fauxExtensionPath,
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--offline",
				"Report the service tier",
			],
			{
				env: {
					...process.env,
					TSX_TSCONFIG_PATH: repoTsconfigPath,
					[ENV_AGENT_DIR]: agentDir,
					PI_SKIP_VERSION_CHECK: "1",
					PRIME_AGENT_TEST_SERVICE_TIER_REQUEST_LOG: requestLogPath,
					PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
					PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined,
					PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: undefined,
					PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: undefined,
					PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: undefined,
					PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: undefined,
					RLM_DEPTH: undefined,
					RLM_MAX_DEPTH: undefined,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		children.add(child);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.stdin?.end("");

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
				20_000,
			);
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				resolveExit({ code, signal: signal as NodeJS.Signals | null });
			});
		});
		children.delete(child);
		expect(exit, `stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual({ code: 0, signal: null });
		expect(stdout).toContain("SERVICE_TIER_PROCESS_OK");
		expect(existsSync(socketPath)).toBe(true);
		expect(JSON.parse(readFileSync(requestLogPath, "utf8"))).toMatchObject({
			model: "gpt-5.6-sol",
			provider: "openai-codex",
			serviceTier: "priority",
		});

		const sessionFiles = sessionFilesUnder(sessionDir);
		expect(sessionFiles).toHaveLength(1);
		const entries = readFileSync(sessionFiles[0]!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries).toContainEqual(expect.objectContaining({ type: "service_tier_change", serviceTier: "priority" }));
	}, 30_000);
});
