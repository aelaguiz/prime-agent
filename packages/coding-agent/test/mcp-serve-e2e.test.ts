import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { type RunningMcpServe, startMcpServe } from "../src/modes/mcp-serve/mcp-serve-mode.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const servers = new Set<RunningMcpServe>();

afterEach(async () => {
	for (const server of servers) {
		await server.close().catch(() => undefined);
	}
	servers.clear();
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown", force: true }, 5000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) {
		// A worker can still be flushing logs; retries keep teardown from masking a real failure.
		rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolveExit) => {
		const timeout = setTimeout(resolveExit, 5000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

/**
 * A shell inside a Prime Agent session exports the worker-role and RLM variables.
 * A daemon that inherits them starts as a session worker and never speaks the
 * public protocol, so the handshake times out. Strip them for the child.
 */
function daemonEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PRIME_AGENT_INTERNAL_") || key.startsWith("RLM_")) {
			continue;
		}
		environment[key] = value;
	}
	environment[ENV_AGENT_DIR] = agentDir;
	environment.PI_OFFLINE = "1";
	environment.TSX_TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
	return environment;
}

function spawnDaemon(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{ cwd, env: daemonEnvironment(agentDir), stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	return child;
}

async function waitForDaemon(socketPath: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`Daemon exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			client.close();
			return;
		} catch {
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}
	throw new Error("Timed out waiting for the daemon to accept the public handshake");
}

interface ToolCall {
	isError: boolean;
	text: string;
	structured: Record<string, unknown>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCall> {
	const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
	const block = result.content.find((entry) => entry.type === "text");
	return {
		isError: result.isError === true,
		text: block && block.type === "text" ? block.text : "",
		structured: (result.structuredContent ?? {}) as Record<string, unknown>,
	};
}

function sessions(call: ToolCall): Array<Record<string, unknown>> {
	const value = call.structured.sessions;
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

describe("mcp-serve end to end", () => {
	it("drives a real daemon through the MCP HTTP transport", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-mcp-serve-e2e-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(tmpdir(), `prime-mcp-serve-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const daemon = spawnDaemon(agentDir, socketPath, projectDir);
		await waitForDaemon(socketPath, daemon);

		const server = await startMcpServe({ port: 0, bind: "127.0.0.1", daemonSocket: socketPath });
		servers.add(server);
		expect(server.socketPath).toBe(socketPath);

		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
		const client = new Client({ name: "mcp-serve-e2e", version: "0.0.0" });
		await client.connect(transport);
		try {
			const tools = (await client.listTools()).tools.map((tool) => tool.name);
			expect(tools).toEqual([
				"status",
				"session_detail",
				"transcript",
				"send",
				"interrupt",
				"start_session",
				"resume_session",
				"restart_session",
				"kill_session",
			]);

			const empty = await callTool(client, "status", {});
			expect(empty.isError).toBe(false);
			expect(sessions(empty)).toHaveLength(0);
			expect(empty.text).toContain("No sessions.");

			const started = await callTool(client, "start_session", {
				cwd: projectDir,
				prompt: "first task",
				name: "e2e-demo",
			});
			expect(started.isError).toBe(false);
			const startedSession = started.structured.session as Record<string, unknown>;
			const selector = String(startedSession.session);
			expect(selector).not.toHaveLength(0);
			expect(startedSession.name).toBe("e2e-demo");
			expect(startedSession.state).not.toBe("inactive");

			const listed = await callTool(client, "status", {});
			expect(sessions(listed)).toHaveLength(1);
			expect(sessions(listed)[0]).toMatchObject({ session: selector, name: "e2e-demo" });

			const sent = await callTool(client, "send", {
				sessions: [selector, "no-such-session"],
				message: "second task",
			});
			expect(sent.isError).toBe(false);
			const results = sent.structured.results as Array<Record<string, unknown>>;
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ session: selector });
			expect(["accepted", "queued"]).toContain(results[0]?.delivered);
			expect(results[1]).toMatchObject({ session: "no-such-session", delivered: "error" });
			expect(String(results[1]?.error)).toContain("no-such-session");

			const detail = await callTool(client, "session_detail", { session: selector });
			expect(detail.isError).toBe(false);
			expect(detail.text).toContain(projectDir);
			// Every optional getter must have answered: `notes` only holds failures.
			expect(detail.structured.notes).toEqual([]);
			expect(detail.structured.stats).toBeDefined();
			expect(detail.structured.heartbeats).toEqual([]);

			const transcript = await callTool(client, "transcript", { session: selector, max_chars: 2000 });
			expect(transcript.isError).toBe(false);
			expect(transcript.text).toContain("first task");
			expect(transcript.structured.total).toBeGreaterThan(0);

			const interrupted = await callTool(client, "interrupt", { session: selector });
			expect(interrupted.isError).toBe(false);
			expect(interrupted.text).toContain(selector);

			// A healthy session restarts through the kill-and-resume path. The failed-worker
			// path (retry_worker) has no fixture here and is covered by code shape only.
			const restarted = await callTool(client, "restart_session", { session: selector });
			expect(restarted.isError).toBe(false);
			expect(restarted.structured.path).toBe("kill_and_resume");
			expect(restarted.structured.previous_session).toBe(selector);
			const restartedSelector = String(restarted.structured.session);
			expect(restartedSelector).not.toBe(selector);
			const sessionFile = String(restarted.structured.session_file);
			expect(sessionFile).toContain(agentDir);
			expect(sessions(await callTool(client, "status", {}))).toHaveLength(1);

			const killed = await callTool(client, "kill_session", { session: restartedSelector });
			expect(killed.isError).toBe(false);
			expect(killed.text).toContain("resume_session");
			expect(killed.structured.session_file).toBe(sessionFile);

			const afterKill = await callTool(client, "status", {});
			expect(sessions(afterKill)).toHaveLength(0);

			// Resuming the retained file exercises create-with-sessionPath.
			const resumed = await callTool(client, "resume_session", { session: sessionFile });
			expect(resumed.isError).toBe(false);
			expect(resumed.structured.was_already_active).toBe(false);
			const resumedSelector = String(resumed.structured.session);
			const afterResume = await callTool(client, "status", {});
			expect(sessions(afterResume)).toHaveLength(1);
			expect(sessions(afterResume)[0]).toMatchObject({ session: resumedSelector, name: "e2e-demo" });

			// The transcript survived the restart and the resume.
			const resumedTranscript = await callTool(client, "transcript", { session: resumedSelector });
			expect(resumedTranscript.text).toContain("first task");

			// A live session resumes to itself instead of being opened twice.
			const already = await callTool(client, "resume_session", { session: resumedSelector });
			expect(already.structured.was_already_active).toBe(true);
			expect(already.structured.session).toBe(resumedSelector);

			expect((await callTool(client, "kill_session", { session: resumedSelector })).isError).toBe(false);
			expect(sessions(await callTool(client, "status", {}))).toHaveLength(0);

			const unknown = await callTool(client, "session_detail", { session: "no-such-session" });
			expect(unknown.isError).toBe(true);
			expect(unknown.text).toContain("no-such-session");

			// A selector that never resolved must never be reported as stopped.
			const killUnknown = await callTool(client, "kill_session", { session: "no-such-session" });
			expect(killUnknown.isError).toBe(true);
			expect(killUnknown.text).toContain("no-such-session");
		} finally {
			await client.close();
		}
	}, 90_000);
});
