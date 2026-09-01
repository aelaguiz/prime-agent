import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureInteractiveDaemonRunning,
	probeDaemonVersion,
	probeRunningDaemonSessions,
	processIdentityFromDaemonHello,
	shouldStartDaemonEarly,
	shutdownDaemonAndWait,
} from "../src/cli/daemon-launch.js";
import { ENV_AGENT_DIR, getDaemonLogPath, VERSION } from "../src/config.js";
import { PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX } from "../src/core/session-lease.js";
import {
	daemonLaunchLeaseDirectory,
	isDaemonLaunchLeaseContentionError,
	tryAcquireDaemonLaunchLease,
} from "../src/modes/daemon/daemon-launch-lease.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";
import * as daemonRuntimeIdentity from "../src/modes/daemon/daemon-runtime-identity.js";
import { getDaemonRuntimeIdentity } from "../src/modes/daemon/daemon-runtime-identity.js";

interface FakeDaemonOptions {
	/** Sessions returned for a `list` command. */
	sessions?: Array<Record<string, unknown>>;
	busyClientOwnedSessionCount?: number;
	/** When true, the `list` command responds with a failure. */
	failList?: boolean;
	/** When false, the server ignores `shutdown` and stays up. */
	respondToShutdown?: boolean;
	protocolVersion?: number;
	appVersion?: string;
	schemaId?: string;
	buildId?: string | null;
	firstSchemaId?: string;
	serverCapabilities?: string[];
	sendHello?: boolean;
	shouldSendHello?: (connectionIndex: number) => boolean;
	onConnection?: (connectionIndex: number) => void;
	onCommand?: (command: { type: string }) => void;
	helloIdentity?: Record<string, unknown>;
}

interface FakeDaemon {
	socketPath: string;
	close: () => Promise<void>;
}

function send(socket: Socket, message: unknown): void {
	socket.write(`${JSON.stringify(message)}\n`);
}

async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-"));
	const socketPath = join(dir, "d.sock");
	const detectedRuntime = options.buildId === null ? undefined : getDaemonRuntimeIdentity();
	let connectionIndex = 0;
	const server: Server = createServer((socket) => {
		const currentConnectionIndex = connectionIndex++;
		options.onConnection?.(currentConnectionIndex);
		socket.on("error", () => undefined);
		if (options.sendHello !== false && (options.shouldSendHello?.(currentConnectionIndex) ?? true)) {
			send(socket, {
				type: "daemon_hello",
				supervisorPid: 2_000_000_000,
				supervisorProcessStartId: "proc:1",
				socketPath,
				protocol: { name: "prime-agent.daemon", version: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION },
				appVersion: options.appVersion ?? VERSION,
				schemaId:
					currentConnectionIndex === 0 && options.firstSchemaId
						? options.firstSchemaId
						: (options.schemaId ?? DAEMON_SCHEMA_ID),
				...(detectedRuntime
					? {
							runtime: {
								...detectedRuntime,
								buildId: options.buildId ?? detectedRuntime.buildId,
							},
						}
					: {}),
				clientId: "fake-client",
				serverCapabilities: options.serverCapabilities ?? [],
				...options.helloIdentity,
			});
		}
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) {
					continue;
				}
				const wire = JSON.parse(line) as {
					type: string;
					id: string;
					command?: { type: string; id: string };
				};
				const command = wire.type === "command" && wire.command ? wire.command : wire;
				options.onCommand?.(command);
				if (command.type === "list") {
					send(socket, {
						type: "response",
						command: "list",
						id: wire.id,
						...(options.failList
							? { success: false, error: "list failed" }
							: {
									success: true,
									data: {
										sessions: options.sessions ?? [],
										busyClientOwnedSessionCount: options.busyClientOwnedSessionCount ?? 0,
									},
								}),
					});
				} else if (command.type === "shutdown") {
					if (options.respondToShutdown === false) {
						continue;
					}
					send(socket, { type: "response", command: "shutdown", id: wire.id, success: true });
					server.close();
					socket.end();
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				const finish = () => {
					rmSync(dir, { recursive: true, force: true });
					resolve();
				};
				if (server.listening) server.close(finish);
				else finish();
			}),
	};
}

async function startCrashingDaemon(): Promise<FakeDaemon> {
	const dir = mkdtempSync(join(tmpdir(), "pa-launch-crash-"));
	const socketPath = join(dir, "d.sock");
	const child = spawn(
		process.execPath,
		[
			"-e",
			`const { createServer } = require("node:net");
const socketPath = process.argv[1];
const send = (socket, message) => socket.write(JSON.stringify(message) + "\\n");
const server = createServer((socket) => {
	send(socket, {
		type: "daemon_hello",
		supervisorPid: process.pid,
		supervisorProcessStartId: "proc:1",
		socketPath,
		protocol: { name: "prime-agent.daemon", version: ${DAEMON_PROTOCOL_VERSION} },
		schemaId: ${JSON.stringify(DAEMON_SCHEMA_ID)},
	});
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\\n");
		if (newline === -1) return;
		const wire = JSON.parse(buffer.slice(0, newline));
		const command = wire.command ?? wire;
		if (command.type !== "shutdown") return;
		send(socket, { type: "response", command: "shutdown", id: wire.id ?? command.id, success: true });
		socket.end(() => process.kill(process.pid, "SIGKILL"));
	});
});
server.listen(socketPath, () => process.stdout.write("ready\\n"));`,
			socketPath,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("error", reject);
		child.once("exit", (code, signal) => reject(new Error(`Daemon exited before listening: ${code ?? signal}`)));
	});
	return {
		socketPath,
		close: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await new Promise<void>((resolve) => child.once("close", () => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("probeRunningDaemonSessions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("reports unreachable when no daemon is running", async () => {
		const result = await probeRunningDaemonSessions(join(tmpdir(), "pa-launch-missing.sock"));
		expect(result).toEqual({ reachable: false });
	});

	it("returns only sessions that have an activeSessionId", async () => {
		const daemon = await startFakeDaemon({
			sessions: [
				{ id: "a", activeSessionId: "a", isStreaming: true },
				{ id: "b" }, // saved-only, no activeSessionId
				{ id: "c", activeSessionId: "c", isStreaming: false },
			],
		});
		cleanups.push(daemon.close);
		const result = await probeRunningDaemonSessions(daemon.socketPath);
		expect(result.reachable).toBe(true);
		expect(result.reachable ? result.activeSessions?.map((session) => session.activeSessionId) : undefined).toEqual([
			"a",
			"c",
		]);
	});

	it("returns an empty list when the daemon is reachable but idle", async () => {
		const daemon = await startFakeDaemon({ sessions: [] });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true, activeSessions: [] });
	});

	it("leaves activeSessions undefined when reachable but the list fails", async () => {
		const daemon = await startFakeDaemon({ failList: true });
		cleanups.push(daemon.close);
		expect(await probeRunningDaemonSessions(daemon.socketPath)).toEqual({ reachable: true });
	});
});

describe("shouldStartDaemonEarly", () => {
	it.each([
		["interactive", []],
		["print", ["--print", "hello"]],
		["json", ["--mode", "json", "hello"]],
		["rpc", ["--mode", "rpc"]],
		["no-session", ["--no-session"]],
	])("starts early for the %s client", (_label, args) => {
		expect(shouldStartDaemonEarly(args, false)).toBe(true);
	});

	it.each([
		["daemon process", ["--mode", "daemon"]],
		["help", ["--help"]],
		["version", ["--version"]],
		["model listing", ["--list-models"]],
		["management command after global flags", ["--daemon-socket", "/tmp/prime.sock", "status"]],
		["startup benchmark", []],
	])("does not start early for %s", (label, args) => {
		expect(shouldStartDaemonEarly(args, label === "startup benchmark")).toBe(false);
	});
});

describe("ensureInteractiveDaemonRunning", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("reuses a busy pre-session-action daemon across wire-version drift", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: 3,
			appVersion: VERSION,
			sessions: [{ id: "active-1", activeSessionId: "active-1", isStreaming: true }],
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).resolves.toBeUndefined();
		expect(commands).not.toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it.each([
		["missing", null],
		["different source", "source-v1:different-runtime-build"],
		["different bundle", "bundle-v1:different-runtime-build"],
	])("reuses a wire-compatible daemon with a %s runtime build identity", async (_label, buildId) => {
		const daemon = await startFakeDaemon({ buildId });
		cleanups.push(daemon.close);

		await expect(probeDaemonVersion(daemon.socketPath)).resolves.toMatchObject({ status: "current" });
	});

	it("keeps a reachable no-hello endpoint out of the stale-daemon path", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			sendHello: false,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(probeDaemonVersion(daemon.socketPath)).resolves.toMatchObject({ status: "unavailable" });
		expect(commands).toEqual([]);
	});

	it("serializes daemon launch leadership for one socket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-lease-"));
		const socketPath = join(dir, "d.sock");
		try {
			const leader = tryAcquireDaemonLaunchLease(socketPath);
			expect(leader).toBeDefined();
			expect(tryAcquireDaemonLaunchLease(socketPath)).toBeUndefined();
			leader?.release();
			const successor = tryAcquireDaemonLaunchLease(socketPath);
			expect(successor).toBeDefined();
			successor?.release();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")("uses one launch key for physical socket aliases", () => {
		const root = mkdtempSync(join(tmpdir(), "pa-launch-alias-"));
		const physicalParent = join(root, "physical");
		const aliasParent = join(root, "alias");
		mkdirSync(physicalParent);
		symlinkSync(physicalParent, aliasParent, "dir");
		const physicalSocketPath = join(physicalParent, "d.sock");
		const aliasSocketPath = join(aliasParent, "d.sock");
		try {
			expect(daemonLaunchLeaseDirectory(aliasSocketPath)).toBe(daemonLaunchLeaseDirectory(physicalSocketPath));
			const leader = tryAcquireDaemonLaunchLease(aliasSocketPath);
			expect(leader).toBeDefined();
			expect(tryAcquireDaemonLaunchLease(physicalSocketPath)).toBeUndefined();
			leader?.release();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims an exact-dead non-empty launch guard before electing a leader", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-crashed-guard-"));
		const socketPath = join(dir, "d.sock");
		try {
			const leaseDirectory = daemonLaunchLeaseDirectory(socketPath);
			const fixture = join(dir, "crashed-launch-guard.mts");
			const entered = join(dir, "entered");
			const helperUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/authority-mutation-guard.ts")).href;
			const identityUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-lease.ts")).href;
			writeFileSync(
				fixture,
				`import { writeFileSync } from "node:fs";
import { acquireAuthorityMutationGuard } from ${JSON.stringify(helperUrl)};
import { classifyProcessIdentityAuthority, observeProcessIdentity } from ${JSON.stringify(identityUrl)};
const [directory, entered] = process.argv.slice(2);
const observed = observeProcessIdentity(process.pid);
if (observed.status !== "present-exact" && observed.status !== "present-coarse") throw new Error("identity");
acquireAuthorityMutationGuard({
  authorityPath: directory,
  lockfilePath: directory + ".guard",
  attempts: 1,
  retryMs: 1,
  identity: observed.status === "present-exact" ? { processStartId: observed.id } : { processIdentityHint: observed.hint },
  classifyOwner: (owner) => classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
  failureMessage: "blocked",
});
writeFileSync(entered, "entered");
process.exit(0);
`,
			);
			const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
			const child = spawn(process.execPath, [tsxPath, fixture, leaseDirectory, entered], { stdio: "ignore" });
			await once(child, "exit");
			expect(existsSync(entered)).toBe(true);
			const abandoned = JSON.parse(readFileSync(`${leaseDirectory}.guard`, "utf8")) as {
				token: string;
			};

			const leader = tryAcquireDaemonLaunchLease(socketPath);
			expect(leader).toBeDefined();
			expect(existsSync(`${leaseDirectory}.guard`)).toBe(false);
			const successor = JSON.parse(readFileSync(join(leaseDirectory, "lease.json"), "utf8")) as {
				ownerPid: number;
				token: string;
			};
			expect(successor).toMatchObject({ ownerPid: process.pid });
			expect(successor.token).not.toBe(abandoned.token);
			leader?.release();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats Windows access-denied rename as contention only for a valid matching lease", () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-contention-"));
		const socketPath = join(dir, "d.sock");
		try {
			const leader = tryAcquireDaemonLaunchLease(socketPath);
			expect(leader).toBeDefined();
			const leaseDirectory = daemonLaunchLeaseDirectory(socketPath);
			const accessDenied = Object.assign(new Error("access denied"), { code: "EACCES" });
			const operationNotPermitted = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			expect(isDaemonLaunchLeaseContentionError(accessDenied, leaseDirectory, socketPath)).toBe(true);
			expect(isDaemonLaunchLeaseContentionError(operationNotPermitted, leaseDirectory, socketPath)).toBe(true);
			expect(isDaemonLaunchLeaseContentionError(accessDenied, leaseDirectory, `${socketPath}.other`)).toBe(false);
			expect(isDaemonLaunchLeaseContentionError(accessDenied, join(dir, "missing.lock"), socketPath)).toBe(false);
			expect(
				isDaemonLaunchLeaseContentionError(
					Object.assign(new Error("I/O error"), { code: "EIO" }),
					leaseDirectory,
					socketPath,
				),
			).toBe(false);
			leader?.release();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows lease reclamation when directory release is blocked", () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-release-"));
		const socketPath = join(dir, "d.sock");
		try {
			const leader = tryAcquireDaemonLaunchLease(socketPath);
			expect(leader).toBeDefined();
			const leaseDirectory = daemonLaunchLeaseDirectory(socketPath);
			const record = JSON.parse(readFileSync(join(leaseDirectory, "lease.json"), "utf8")) as { token: string };
			const blockedRelease = `${leaseDirectory}.released-${process.pid}-${record.token}`;
			mkdirSync(blockedRelease, { recursive: true });
			writeFileSync(join(blockedRelease, "occupied"), "occupied\n");

			leader?.release();
			expect(readFileSync(join(leaseDirectory, "released"), "utf8").trim()).toBe(record.token);
			const successor = tryAcquireDaemonLaunchLease(socketPath);
			expect(successor).toBeDefined();
			successor?.release();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fingerprint local source when the daemon wire contract matches", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			buildId: "source-v1:daemon-build",
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);
		const identity = vi.spyOn(daemonRuntimeIdentity, "getDaemonRuntimeIdentity").mockImplementation(() => {
			throw new Error("local identity unavailable");
		});
		try {
			await expect(probeDaemonVersion(daemon.socketPath)).resolves.toMatchObject({ status: "current" });
			expect(identity).not.toHaveBeenCalled();
			expect(commands).toEqual([]);
		} finally {
			identity.mockRestore();
		}
	});

	it.each([
		["source", "source-v1:busy-old-runtime-build"],
		["bundle", "bundle-v1:busy-old-runtime-build"],
	])("keeps a busy wire-compatible daemon running across a %s build mismatch", async (_label, buildId) => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: DAEMON_SCHEMA_ID,
			buildId,
			busyClientOwnedSessionCount: 1,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).resolves.toBeUndefined();
		expect(commands).not.toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("keeps an idle version-mismatched daemon instead of starting a successor", async () => {
		const commands: string[] = [];
		const stale = await startFakeDaemon({
			appVersion: "0.0.0-stale",
			buildId: "idle-old-runtime-build",
			sessions: [],
			onCommand: (command) => commands.push(command.type),
		});
		const entrypoint = join(dirname(stale.socketPath), "replacement-crashes.mjs");
		writeFileSync(entrypoint, "process.exit(7);\n");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(stale.socketPath)).resolves.toBeUndefined();
			expect(commands.filter((command) => command === "list" || command === "shutdown")).toEqual([]);
			await expect(probeDaemonVersion(stale.socketPath)).resolves.toMatchObject({ status: "current" });
		} finally {
			process.argv[1] = originalEntrypoint;
			await stale.close();
		}
	});

	it("does not treat a live daemon as absent when cold startup delays the first connection", async () => {
		const daemon = await startFakeDaemon({
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			appVersion: VERSION,
			schemaId: DAEMON_SCHEMA_ID,
		});
		cleanups.push(daemon.close);

		const probe = probeDaemonVersion(daemon.socketPath);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

		await expect(probe).resolves.toMatchObject({ status: "current" });
	});

	it("launches the supervisor with an exact owner argv0 capability", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-owner-argv0-"));
		const entrypoint = join(dir, "capture-argv0.mjs");
		const proofPath = join(dir, "argv0.txt");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		writeFileSync(
			entrypoint,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(proofPath)}, process.argv0); process.exit(29);`,
		);
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(/exited during startup \(code 29\)/);
			const argv0 = readFileSync(proofPath, "utf8");
			expect(argv0.startsWith(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX)).toBe(true);
			expect(argv0.slice(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("classifies a connected daemon without hello as unresponsive", async () => {
		const daemon = await startFakeDaemon({ shouldSendHello: () => false });
		cleanups.push(daemon.close);

		await expect(probeDaemonVersion(daemon.socketPath, 10)).resolves.toEqual({ status: "unresponsive" });
	});

	it("reuses a daemon that becomes current inside the startup window", async () => {
		vi.useFakeTimers();
		let resolveFirstConnection = () => {};
		let resolveSecondConnection = () => {};
		const firstConnection = new Promise<void>((resolve) => {
			resolveFirstConnection = resolve;
		});
		const secondConnection = new Promise<void>((resolve) => {
			resolveSecondConnection = resolve;
		});
		const daemon = await startFakeDaemon({
			appVersion: VERSION,
			shouldSendHello: (connectionIndex) => connectionIndex > 0,
			onConnection: (connectionIndex) => {
				if (connectionIndex === 0) resolveFirstConnection();
				if (connectionIndex === 1) resolveSecondConnection();
			},
		});
		cleanups.push(daemon.close);

		try {
			const ensuring = ensureInteractiveDaemonRunning(daemon.socketPath);
			await firstConnection;
			await vi.advanceTimersByTimeAsync(2000);
			await secondConnection;
			await expect(ensuring).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a connected unresponsive daemon running after the startup window", async () => {
		vi.useFakeTimers();
		const connections: Array<() => void> = [];
		const connected = [0, 1].map(
			(index) =>
				new Promise<void>((resolve) => {
					connections[index] = resolve;
				}),
		);
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			shouldSendHello: () => false,
			onConnection: (connectionIndex) => connections[connectionIndex]?.(),
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		try {
			const ensuring = ensureInteractiveDaemonRunning(daemon.socketPath);
			const rejected = expect(ensuring).rejects.toThrow(/accepted connections but did not finish startup/);
			await connected[0];
			await vi.advanceTimersByTimeAsync(2000);
			await connected[1];
			await vi.advanceTimersByTimeAsync(30_000);
			await rejected;
			expect(commands).not.toContain("list");
			expect(commands).not.toContain("shutdown");
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels replacement when a stale-looking daemon becomes current", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			appVersion: VERSION,
			firstSchemaId: "stale-schema",
			schemaId: DAEMON_SCHEMA_ID,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);

		await expect(ensureInteractiveDaemonRunning(daemon.socketPath)).resolves.toBeUndefined();
		expect(commands).toContain("list");
		expect(commands).not.toContain("shutdown");
	});

	it("fails fast with the daemon log tail when the spawned daemon exits during startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-crash-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		const logPath = getDaemonLogPath(socketPath);
		mkdirSync(dirname(logPath), { recursive: true });
		const script = `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(logPath)}, "supervisor: fatal startup failure\\n"); process.exit(23);`;
		writeFileSync(entrypoint, script);
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;
		const startedAt = Date.now();

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/Prime Agent daemon exited during startup \(code 23\)\.[\s\S]*fatal startup failure/,
			);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the missing daemon log when the daemon crashes before logging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-silent-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/exited during startup \(code 7\)\. The daemon wrote nothing to its log/,
			);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces a spawn error when the child never emits exit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-spawn-error-"));
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath, join(dir, "missing-cwd"))).rejects.toThrow(
				/Failed to spawn Prime Agent daemon: .*ENOENT/,
			);
		} finally {
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("succeeds when the spawned child loses the race to an already-serving daemon", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-race-"));
		const entrypoint = join(dir, "loser.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;
		const server: Server = createServer((socket) => {
			socket.on("error", () => undefined);
			send(socket, {
				type: "daemon_hello",
				socketPath,
				protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
				appVersion: VERSION,
				schemaId: DAEMON_SCHEMA_ID,
				runtime: getDaemonRuntimeIdentity(),
				clientId: "fake-client",
				serverCapabilities: [],
			});
		});

		try {
			const ensurePromise = ensureInteractiveDaemonRunning(socketPath);
			// Let the child exit first, then bring up the winning daemon inside
			// the exit grace window.
			await new Promise((resolve) => setTimeout(resolve, 300));
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			await expect(ensurePromise).resolves.toBeUndefined();
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not attribute a previous run's log to a daemon that crashed before logging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-launch-startup-stale-"));
		const entrypoint = join(dir, "crash.mjs");
		const socketPath = join(dir, "d.sock");
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
		const logPath = getDaemonLogPath(socketPath);
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "supervisor: error from an earlier run in /tmp/\u00fcml\u00e4ut-p\u00e4th\n");
		writeFileSync(entrypoint, "process.exit(7);");
		const originalEntrypoint = process.argv[1]!;
		process.argv[1] = entrypoint;

		try {
			await expect(ensureInteractiveDaemonRunning(socketPath)).rejects.toThrow(
				/exited during startup \(code 7\)\. The daemon wrote nothing to its log/,
			);
		} finally {
			process.argv[1] = originalEntrypoint;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("daemon hello shutdown identity", () => {
	const base = { supervisorPid: 42 } as const;
	it.each([
		[
			"qualified Linux authority-only",
			{ ...base, supervisorAuthorityProcessStartId: "proc:00000000-0000-4000-8000-000000000000:11" },
			{ pid: 42, processStartId: "proc:00000000-0000-4000-8000-000000000000:11" },
		],
		[
			"token authority-only",
			{ ...base, supervisorAuthorityProcessStartId: `token:${"8".repeat(64)}` },
			{ pid: 42, processStartId: `token:${"8".repeat(64)}` },
		],
		[
			"Windows exact dual",
			{ ...base, supervisorProcessStartId: "win:11", supervisorAuthorityProcessStartId: "win:11" },
			{ pid: 42, processStartId: "win:11" },
		],
		[
			"historical exact old field",
			{ ...base, supervisorProcessStartId: "win:11" },
			{ pid: 42, processStartId: "win:11" },
		],
		["legacy-only", { ...base, supervisorProcessStartId: "proc:11" }, { pid: 42 }],
	])("maps %s with authority separation", (_name, hello, expected) => {
		expect(processIdentityFromDaemonHello(hello as never)).toEqual(expected);
	});
	it.each([
		["malformed", { ...base, supervisorAuthorityProcessStartId: "token:bad" }],
		[
			"conflicting",
			{ ...base, supervisorProcessStartId: "proc:11", supervisorAuthorityProcessStartId: `token:${"9".repeat(64)}` },
		],
	])("rejects %s authority", (_name, hello) => {
		expect(() => processIdentityFromDaemonHello(hello as never)).toThrow(/invalid supervisor process identity/);
	});
});

describe("shutdownDaemonAndWait", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((fn) => fn()));
	});

	it("returns true immediately when no daemon is running", async () => {
		expect(await shutdownDaemonAndWait(join(tmpdir(), "pa-launch-missing2.sock"))).toBe(true);
	});

	it("stops a running daemon and returns true", async () => {
		const daemon = await startFakeDaemon({ sessions: [{ id: "a", activeSessionId: "a", isStreaming: false }] });
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath)).toBe(true);
	});

	it("does not send shutdown when a reachable endpoint provides no hello", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			sendHello: false,
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 50)).toBe(false);
		expect(commands).not.toContain("shutdown");
	});

	it("does not send shutdown for a hello with no valid supervisor PID", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			helloIdentity: { supervisorPid: undefined },
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 50)).toBe(false);
		expect(commands).not.toContain("shutdown");
	});

	it("does not send shutdown for a recycled exact supervisor identity", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			helloIdentity: {
				supervisorPid: process.pid,
				supervisorProcessStartId: undefined,
				supervisorAuthorityProcessStartId: `token:${"f".repeat(64)}`,
			},
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 50)).toBe(false);
		expect(commands).not.toContain("shutdown");
	});

	it("does not send shutdown for a conflicting dual supervisor identity", async () => {
		const commands: string[] = [];
		const daemon = await startFakeDaemon({
			helloIdentity: {
				supervisorPid: process.pid,
				supervisorProcessStartId: "proc:11",
				supervisorAuthorityProcessStartId: `token:${"1".repeat(64)}`,
			},
			onCommand: (command) => commands.push(command.type),
		});
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 50)).toBe(false);
		expect(commands).not.toContain("shutdown");
	});

	it("accepts an exited daemon that leaves a stale socket behind", async () => {
		if (process.platform === "win32") {
			return;
		}

		const daemon = await startCrashingDaemon();
		cleanups.push(daemon.close);
		expect(await shutdownDaemonAndWait(daemon.socketPath, 100)).toBe(true);
		expect(existsSync(daemon.socketPath)).toBe(true);
	});
});
