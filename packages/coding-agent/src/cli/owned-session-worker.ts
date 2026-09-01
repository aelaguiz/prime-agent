import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { AgentSession } from "../core/agent-session.js";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import {
	type ActiveOrphanProcessCandidate,
	clearOrphanProcessJournal,
	enrollOrphanProcess,
	initializeOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	reapOrphanProcessAuthority,
	reapOrphanProcessCandidate,
	shouldReapOrphanProcess,
} from "../core/orphan-process-journal.js";
import {
	prepareProcessLifecycleLaunch,
	recordProcessLifecycle,
	setProcessLifecycleContext,
} from "../core/process-lifecycle.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	supportsExactProcessIdentityPlatform,
} from "../core/session-lease.js";
import { DAEMON_WORKER_STARTUP_GATE_COMMIT } from "../modes/daemon/daemon-worker-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.js";
import { isHelpCommandRequest, PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";
import { type CliSubprocessLaunchSpec, createCliSubprocessLaunchSpec } from "./subprocess-launch.js";

const OWNED_WORKER_ENV = "PRIME_AGENT_INTERNAL_OWNED_WORKER";
const OWNED_RECOVERY_DESCRIPTOR_ENV = "PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR";
const OWNED_PROFILE_ENV = "PRIME_AGENT_INTERNAL_OWNED_PROFILE";
const OWNED_OWNER_PID_ENV = "PRIME_AGENT_INTERNAL_OWNED_OWNER_PID";
const OWNED_WORKER_STARTUP_GATE_FD = 4;
const OWNED_WORKER_STARTUP_CONFIG_FD = 5;
const OWNED_WORKER_STARTUP_CONTROL_FD = 6;
const OWNED_WORKER_STARTUP_CONTROL_VERSION = 1;
const OWNED_WORKER_STARTUP_CONTROL_MAX_BYTES = 8 * 1024;

/** Exact source passed to Node `-e`; String.raw preserves its JS escapes. */
export const OWNED_WORKER_STARTUP_GATE_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const { accessSync, closeSync, constants: fsConstants, readFileSync, writeSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const gateFd = ${OWNED_WORKER_STARTUP_GATE_FD};
const configFd = ${OWNED_WORKER_STARTUP_CONFIG_FD};
const controlFd = ${OWNED_WORKER_STARTUP_CONTROL_FD};
const expectedMarker = ${JSON.stringify(DAEMON_WORKER_STARTUP_GATE_COMMIT)};
const controlVersion = ${OWNED_WORKER_STARTUP_CONTROL_VERSION};
const ownerEnvironmentName = ${JSON.stringify(OWNED_OWNER_PID_ENV)};
const ownerMarker = process.argv[1];
if (
  typeof ownerMarker !== "string"
  || ownerMarker.length !== 88
  || ownerMarker[23] !== "="
  || !/^[a-f0-9]{64}$/.test(ownerMarker.slice(24))
) {
  process.stderr.write("prime-agent owned worker admission: invalid owner token\n");
  process.exit(125);
}
let child;
let targetSettled = false;
let targetExitCode = 1;
let cleanupSignal;
const forwardedSignals = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGHUP", "SIGINT", "SIGTERM"];
function diagnostic(message) {
  try { writeSync(2, "prime-agent owned worker admission: " + message + "\n"); } catch {}
}
function normalizedExitCode(code, signal, error) {
  if (error) return error && error.code === "ENOENT" ? 127 : 126;
  if (Number.isInteger(code) && code >= 0) return code;
  const signalNumber = typeof signal === "string" ? osConstants.signals[signal] : undefined;
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}
function terminateContainedGroup(signal) {
  if (process.platform === "win32") {
    if (!targetSettled && child) {
      cleanupSignal = signal;
      try { child.kill(signal); } catch {}
      return;
    }
    process.exit(targetExitCode);
  }
  cleanupSignal = signal;
  if (!targetSettled) {
    try { child?.kill(signal); } catch {}
    return;
  }
  for (const forwarded of forwardedSignals) process.removeAllListeners(forwarded);
  try { process.kill(-process.pid, "SIGKILL"); }
  catch (error) {
    diagnostic("group cleanup failed after " + signal + ": " + error.message);
    process.exit(targetExitCode);
  }
}
let parentDeathObserved = false;
function forceAbandonForParentDeath() {
  try { if (child?.connected) child.disconnect(); } catch {}
  if (process.platform !== "win32") {
    try { process.kill(-process.pid, "SIGKILL"); } catch {}
    return;
  }
  try { child?.kill("SIGKILL"); } catch {}
  process.exit(137);
}
function abandonForParentDeath() {
  if (parentDeathObserved || targetSettled || !child) {
    forceAbandonForParentDeath();
    return;
  }
  parentDeathObserved = true;
  cleanupSignal = "SIGTERM";
  try { child.kill("SIGTERM"); } catch { forceAbandonForParentDeath(); return; }
  const timer = setTimeout(forceAbandonForParentDeath, 5000);
  timer.unref?.();
}
function finishTarget(code, signal, error) {
  if (targetSettled) return;
  targetSettled = true;
  targetExitCode = normalizedExitCode(code, signal, error);
  const message = error instanceof Error ? error.message : (error === undefined ? undefined : String(error));
  const frame = {
    primeAgentStartupGate: controlVersion,
    type: "target-exit",
    exitCode: targetExitCode,
    signal: typeof signal === "string" ? signal : null,
    ...(message !== undefined ? { message } : {}),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  };
  try { writeSync(controlFd, JSON.stringify(frame) + "\n"); }
  catch (controlError) {
    diagnostic("control write failed: " + controlError.message);
    abandonForParentDeath();
    return;
  }
  try { closeSync(controlFd); } catch {}
  if (cleanupSignal) terminateContainedGroup(cleanupSignal);
}
for (const signal of forwardedSignals) {
  process.on(signal, () => terminateContainedGroup(signal));
}
process.once("disconnect", abandonForParentDeath);
const originalParentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== originalParentPid) abandonForParentDeath();
}, 100);
let launch;
try {
  launch = JSON.parse(readFileSync(configFd, "utf8"));
} catch (error) {
  diagnostic("invalid startup configuration: " + error.message);
  process.exit(125);
}
const marker = readFileSync(gateFd, "utf8");
if (marker !== expectedMarker) process.exit(125);
const validLaunch = launch && typeof launch === "object"
  && typeof launch.command === "string" && launch.command.length > 0 && !launch.command.includes("\0")
  && Array.isArray(launch.args) && launch.args.every((value) => typeof value === "string" && !value.includes("\0"))
  && launch.argv0 === launch.command + " " + ownerMarker
  && typeof launch.cwd === "string" && launch.cwd.length > 0 && !launch.cwd.includes("\0")
  && launch.env && typeof launch.env === "object" && !Array.isArray(launch.env)
  && Object.entries(launch.env).every(([key, value]) =>
    key.length > 0 && !key.includes("=") && !key.includes("\0")
    && typeof value === "string" && !value.includes("\0"));
if (!validLaunch) {
  diagnostic("invalid startup configuration");
  process.exit(125);
}
try { accessSync(launch.command, fsConstants.X_OK); }
catch (error) {
  diagnostic(String(error && error.code ? error.code : "spawn failed"));
  process.exit(127);
}
launch.env[ownerEnvironmentName] = String(process.pid);
try {
  child = spawn(launch.command, launch.args, {
    argv0: launch.argv0,
    cwd: launch.cwd,
    env: launch.env,
    shell: false,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
} catch (error) {
  finishTarget(null, null, error);
}
if (child) {
  child.once("error", (error) => finishTarget(null, null, error));
  child.once("exit", (code, signal) => finishTarget(code, signal));
}
`;

interface OwnedWorkerGateLaunch {
	command: string;
	args: string[];
	argv0: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

interface OwnedWorkerTargetExit {
	exitCode: number;
	signal: NodeJS.Signals | null;
	error?: NodeJS.ErrnoException;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwnedWorkerTargetExit(payload: string, overflow: boolean): OwnedWorkerTargetExit {
	if (overflow) throw new Error("Owned worker startup control frame exceeded its bound");
	const lines = payload
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) throw new Error("Owned worker startup wrapper omitted its exact target status");
	let value: unknown;
	try {
		value = JSON.parse(lines[0]!);
	} catch (error) {
		throw new Error("Owned worker startup wrapper emitted an invalid target status", { cause: error });
	}
	if (
		!isRecord(value) ||
		value.primeAgentStartupGate !== OWNED_WORKER_STARTUP_CONTROL_VERSION ||
		value.type !== "target-exit" ||
		!Number.isInteger(value.exitCode) ||
		(value.exitCode as number) < 0 ||
		(value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(value.signal))) ||
		(value.message !== undefined && typeof value.message !== "string") ||
		(value.code !== undefined && typeof value.code !== "string")
	) {
		throw new Error("Owned worker startup wrapper emitted an invalid target status");
	}
	let error: NodeJS.ErrnoException | undefined;
	if (value.message !== undefined) {
		error = new Error(value.message as string) as NodeJS.ErrnoException;
		if (typeof value.code === "string") error.code = value.code;
	}
	return {
		exitCode: value.exitCode as number,
		signal: value.signal as NodeJS.Signals | null,
		...(error ? { error } : {}),
	};
}

function observeOwnedWorkerTargetExit(child: ChildProcess): Promise<OwnedWorkerTargetExit> {
	const control = (child.stdio as Array<Readable | Writable | null | undefined>)[OWNED_WORKER_STARTUP_CONTROL_FD];
	if (!(control instanceof Readable)) {
		return Promise.reject(new Error("Owned worker startup control pipe is unavailable"));
	}
	const decoder = new StringDecoder("utf8");
	let payload = "";
	let overflow = false;
	return new Promise<OwnedWorkerTargetExit>((resolveExit, rejectExit) => {
		control.on("data", (chunk: Buffer) => {
			if (overflow) return;
			payload += decoder.write(chunk);
			if (Buffer.byteLength(payload) > OWNED_WORKER_STARTUP_CONTROL_MAX_BYTES) {
				overflow = true;
				payload = payload.slice(-OWNED_WORKER_STARTUP_CONTROL_MAX_BYTES);
			}
		});
		control.once("error", rejectExit);
		control.once("end", () => {
			try {
				payload += decoder.end();
				resolveExit(parseOwnedWorkerTargetExit(payload, overflow));
			} catch (error) {
				rejectExit(error);
			}
		});
	});
}

function minimalOwnedWorkerGateEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
		if (source[name] !== undefined) environment[name] = source[name];
	}
	return environment;
}

function writeAndCloseOwnedWorkerStartupPipe(pipe: Writable, value: string): Promise<void> {
	return new Promise((resolveWrite, rejectWrite) => {
		let settled = false;
		const finish = (error?: Error | null) => {
			if (settled) return;
			settled = true;
			pipe.off("error", onError);
			if (error) rejectWrite(error);
			else resolveWrite();
		};
		const onError = (error: Error) => finish(error);
		pipe.once("error", onError);
		pipe.end(value, (error?: Error | null) => finish(error));
	});
}

function waitForOwnedWrapperExit(
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise<boolean>((resolveExit) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveExit(exited);
		};
		const timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
		exit.then(
			() => finish(true),
			() => finish(true),
		);
	});
}

let closeOwnerWatch: (() => void) | undefined;

export type OwnedSessionWorkerProfile = "print" | "json" | "rpc" | "interactive-ephemeral";

export interface OwnedSessionWorkerFrontendOptions {
	beforeWorkerStartupCommit?: () => void | Promise<void>;
}

export function isOwnedSessionWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[OWNED_WORKER_ENV] === "1";
}

interface OwnedSessionRecoveryDescriptor {
	version: 1;
	profile: OwnedSessionWorkerProfile;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	orphanProcessJournalGeneration?: string;
	updatedAt: string;
}

const NON_SESSION_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);

const NON_SESSION_COMMANDS = new Set([...PUBLIC_COMMAND_NAMES, ...REMOVED_COMMAND_NAMES]);

function valueAfter(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

function hasNonSessionOperation(args: readonly string[]): boolean {
	if (args.some((arg) => NON_SESSION_FLAGS.has(arg) || arg.startsWith("--export="))) {
		return true;
	}
	const first = args[0];
	if (first === "help") {
		return isHelpCommandRequest(args.slice(1));
	}
	return first !== undefined && NON_SESSION_COMMANDS.has(first);
}

function isStartupBenchmark(environment: NodeJS.ProcessEnv): boolean {
	const value = environment.PI_STARTUP_BENCHMARK?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function classifyOwnedSessionWorkerInvocation(
	args: readonly string[],
	stdinIsTTY: boolean | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): OwnedSessionWorkerProfile | undefined {
	if (isOwnedSessionWorkerProcess(environment) || hasNonSessionOperation(args)) {
		return undefined;
	}

	const mode = valueAfter(args, "--mode");
	if (mode === "daemon") {
		return undefined;
	}
	if (mode === "rpc") {
		return "rpc";
	}
	if (mode === "json") {
		return "json";
	}
	if (args.includes("--print") || args.includes("-p") || stdinIsTTY === false) {
		return "print";
	}
	if (args.includes("--no-session") || isStartupBenchmark(environment)) {
		return "interactive-ephemeral";
	}
	return undefined;
}

export type OwnedWorkerLaunchSpec = CliSubprocessLaunchSpec;

export function createOwnedWorkerLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
): OwnedWorkerLaunchSpec {
	return createCliSubprocessLaunchSpec(args, executable, execArgs, entrypoint);
}

function readOwnedRecoveryDescriptor(path: string): OwnedSessionRecoveryDescriptor | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnedSessionRecoveryDescriptor>;
		if (
			value.version === 1 &&
			typeof value.sessionId === "string" &&
			typeof value.cwd === "string" &&
			(value.sessionFile === undefined || typeof value.sessionFile === "string") &&
			(value.orphanProcessJournalGeneration === undefined ||
				typeof value.orphanProcessJournalGeneration === "string")
		) {
			return value as OwnedSessionRecoveryDescriptor;
		}
	} catch {
		// The worker may have stopped before creating a recoverable session.
	}
	return undefined;
}

function writeOwnedRecoveryDescriptor(path: string, profile: OwnedSessionWorkerProfile, session: AgentSession): void {
	const orphanProcessJournalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	if (!orphanProcessJournalGeneration) {
		throw new Error("Owned session worker is missing orphan process generation authority");
	}
	const descriptor: OwnedSessionRecoveryDescriptor = {
		version: 1,
		profile,
		sessionId: session.sessionId,
		...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
		cwd: session.sessionManager.getCwd(),
		orphanProcessJournalGeneration,
		updatedAt: new Date().toISOString(),
	};
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
}

export function installOwnedSessionRecoveryTracking(runtime: AgentSessionRuntime): void {
	const path = process.env[OWNED_RECOVERY_DESCRIPTOR_ENV];
	const profile = process.env[OWNED_PROFILE_ENV] as OwnedSessionWorkerProfile | undefined;
	if (!path || !profile) {
		return;
	}
	let unsubscribeSession: (() => void) | undefined;
	const bind = (session: AgentSession) => {
		unsubscribeSession?.();
		setProcessLifecycleContext({
			ownedWorkerProfile: profile,
			sessionId: session.sessionId,
		});
		writeOwnedRecoveryDescriptor(path, profile, session);
		let lastSessionFile = session.sessionFile;
		unsubscribeSession = session.subscribe((event) => {
			if (event.type !== "message_start" && event.type !== "session_info_changed") {
				return;
			}
			if (session.sessionFile !== lastSessionFile) {
				lastSessionFile = session.sessionFile;
				writeOwnedRecoveryDescriptor(path, profile, session);
			}
		});
	};
	bind(runtime.session);
	runtime.onSessionReplaced(bind);
}

export function createRpcRecoveryArgs(args: readonly string[], sessionPath: string): string[] {
	const recovered: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--resume" || arg === "-r" || arg === "--fork") {
			index++;
			continue;
		}
		if (arg.startsWith("--resume=")) {
			continue;
		}
		if (arg === "--continue" || arg === "-c") {
			continue;
		}
		recovered.push(arg);
	}
	return [...recovered, "--resume", sessionPath];
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
	if (signal === "SIGHUP") {
		return 129;
	}
	if (signal === "SIGINT") {
		return 130;
	}
	if (signal === "SIGTERM") {
		return 143;
	}
	return 1;
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill(signal);
	}
}

export async function reapOwnedWorkerResources(
	worker: ActiveOrphanProcessCandidate | undefined,
	orphanProcessJournalPath: string,
	expectedGeneration?: string,
): Promise<boolean> {
	return reapOrphanProcessAuthority(orphanProcessJournalPath, {
		expectedGeneration,
		...(worker ? { additionalCandidates: [worker] } : {}),
	});
}

async function stopOwnedWorkerWithoutRetiring(
	current: { child: ChildProcess; candidate?: ActiveOrphanProcessCandidate } | undefined,
): Promise<void> {
	if (!current) return;
	if (current.candidate) await reapOrphanProcessCandidate(current.candidate);
	// Without an exact candidate, pipe closure and durable authority own cleanup;
	// the wrapper handle alone is not signal authorization.
}

export function awaitOwnedWorkerSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolveSpawn, rejectSpawn) => {
		const cleanup = () => {
			child.off("spawn", onSpawn);
			child.off("error", onError);
		};
		const onSpawn = () => {
			cleanup();
			resolveSpawn();
		};
		const onError = (error: Error) => {
			cleanup();
			rejectSpawn(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

export async function runOwnedSessionWorkerFrontend(
	args: readonly string[],
	profile: OwnedSessionWorkerProfile,
	options: OwnedSessionWorkerFrontendOptions = {},
): Promise<number> {
	const interactive = profile === "interactive-ephemeral";
	const recoveryDescriptorPath = join(tmpdir(), `prime-agent-owned-${process.pid}-${randomUUID().slice(0, 12)}.json`);
	const orphanProcessJournalPath = `${recoveryDescriptorPath}.orphans.jsonl`;
	const orphanProcessAuthority = initializeOrphanProcessJournal(orphanProcessJournalPath);
	let currentChild: { child: ChildProcess; candidate?: ActiveOrphanProcessCandidate } | undefined;
	let terminating = false;
	let terminationSignal: NodeJS.Signals | undefined;
	let stdinEnded = false;
	let currentRpcInput: NodeJS.WritableStream | undefined;
	let currentRpcOutput: NodeJS.ReadableStream | undefined;
	let rpcStdoutPaused = false;
	let detachRpcInput: (() => void) | undefined;
	let detachRpcOutput: (() => void) | undefined;
	const bufferedRpcInput: string[] = [];
	const pendingRpcCommands = new Map<string, { publicId?: string; command: string }>();
	const anonymousRpcIdPrefix = `prime-agent-owned-${randomUUID()}`;
	let anonymousRpcCommandId = 0;

	const prepareRpcInput = (line: string): string => {
		try {
			const command = JSON.parse(line) as { id?: unknown; type?: unknown } | null;
			if (
				!command ||
				Array.isArray(command) ||
				typeof command.type !== "string" ||
				command.type === "extension_ui_response" ||
				command.type === "ack_result"
			) {
				return `${line}\n`;
			}
			const publicId = typeof command.id === "string" ? command.id : undefined;
			const internalId = publicId ?? `${anonymousRpcIdPrefix}-${++anonymousRpcCommandId}`;
			pendingRpcCommands.set(internalId, { publicId, command: command.type });
			return publicId !== undefined ? `${line}\n` : serializeJsonLine({ ...command, id: internalId });
		} catch {
			// The worker preserves the existing parse-error response contract.
			return `${line}\n`;
		}
	};
	const observeRpcOutput = (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return;
		}
		const response = parsed as { id?: unknown; type?: unknown; command?: unknown };
		const id = typeof response.id === "string" ? response.id : undefined;
		const pending = id !== undefined ? pendingRpcCommands.get(id) : undefined;
		let framed = `${line}\n`;
		if (response.type === "response" && pending?.publicId === undefined) {
			const { id: _internalId, ...publicResponse } = response;
			framed = serializeJsonLine(publicResponse);
		}
		if (!process.stdout.write(framed) && !rpcStdoutPaused) {
			rpcStdoutPaused = true;
			currentRpcOutput?.pause();
			process.stdout.once("drain", () => {
				rpcStdoutPaused = false;
				currentRpcOutput?.resume();
			});
		}
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		if (id !== undefined && pending?.command === response.command) {
			pendingRpcCommands.delete(id);
		}
	};
	const failPendingRpcCommands = () => {
		for (const pending of pendingRpcCommands.values()) {
			process.stdout.write(
				serializeJsonLine({
					...(pending.publicId !== undefined ? { id: pending.publicId } : {}),
					type: "response",
					command: pending.command,
					success: false,
					error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
				}),
			);
		}
		pendingRpcCommands.clear();
	};

	if (profile === "rpc") {
		detachRpcInput = attachJsonlLineReader(process.stdin, (line) => {
			const framed = prepareRpcInput(line);
			const input = currentRpcInput;
			if (input?.writable) {
				if (!input.write(framed)) {
					process.stdin.pause();
					input.once("drain", () => {
						if (currentRpcInput === input && !stdinEnded) {
							process.stdin.resume();
						}
					});
				}
			} else {
				bufferedRpcInput.push(framed);
			}
		});
		process.stdin.once("end", () => {
			stdinEnded = true;
			currentRpcInput?.end();
		});
	}

	const spawnWorker = async (
		workerArgs: readonly string[],
		trigger: string,
		recoveryAttemptNumber?: number,
	): Promise<{
		child: ChildProcess;
		childProcessInstanceId: string;
		targetExit: Promise<OwnedWorkerTargetExit>;
		wrapperExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	}> => {
		if (!supportsExactProcessIdentityPlatform()) {
			throw new Error(
				`Owned session worker exact-identity probe unavailable: unsupported platform ${process.platform}`,
			);
		}
		const launch = createOwnedWorkerLaunchSpec(workerArgs);
		const bridgeStdin = profile === "rpc" || process.stdin.isTTY !== true;
		const stdio: StdioOptions = interactive
			? ["inherit", "inherit", "inherit", "ipc", "pipe", "pipe", "pipe"]
			: [bridgeStdin ? "pipe" : "inherit", "pipe", "pipe", "ipc", "pipe", "pipe", "pipe"];
		const workerEnvironment = {
			...process.env,
			[OWNED_WORKER_ENV]: "1",
			[OWNED_RECOVERY_DESCRIPTOR_ENV]: recoveryDescriptorPath,
			[OWNED_PROFILE_ENV]: profile,
			[OWNED_OWNER_PID_ENV]: String(process.pid),
			[ORPHAN_PROCESS_JOURNAL_ENV]: orphanProcessJournalPath,
			[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV]: orphanProcessAuthority.generation,
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: `owned-${randomUUID()}`,
		};
		const preparedLaunch = prepareProcessLifecycleLaunch(workerEnvironment, {
			role: "owned-session-worker",
			trigger,
			context: { ownedWorkerProfile: profile, recoveryAttempt: recoveryAttemptNumber },
		});
		recordProcessLifecycle("owned_session_worker_launch", {
			phase: "attempt",
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			trigger,
			ownedWorkerProfile: profile,
			recoveryAttempt: recoveryAttemptNumber,
		});
		const ownerIdentity = createProcessIdentityOwnerToken();
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, ["-e", OWNED_WORKER_STARTUP_GATE_SOURCE, ownerIdentity.argument], {
				cwd: process.cwd(),
				detached: process.platform !== "win32",
				env: minimalOwnedWorkerGateEnvironment(process.env),
				stdio,
			});
			await awaitOwnedWorkerSpawn(child);
		} catch (error) {
			recordProcessLifecycle("owned_session_worker_spawn_error", {
				childProcessInstanceId: preparedLaunch.childProcessInstanceId,
				trigger,
				ownedWorkerProfile: profile,
				recoveryAttempt: recoveryAttemptNumber,
				errorMessage: error instanceof Error ? error.message : String(error),
				...((error as NodeJS.ErrnoException).code ? { errorCode: (error as NodeJS.ErrnoException).code } : {}),
			});
			throw error;
		}
		const childPid = child.pid;
		currentChild = {
			child,
			...(childPid !== undefined ? { candidate: { pid: childPid } } : {}),
		};
		const childProcessStartId = childPid === undefined ? undefined : getProcessStartId(childPid);
		if (childPid !== undefined && childProcessStartId !== undefined) {
			currentChild.candidate = { pid: childPid, processStartId: childProcessStartId };
		}
		recordProcessLifecycle("owned_session_worker_launch", {
			phase: "spawned",
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			childPid,
			childProcessStartId,
			trigger,
			ownedWorkerProfile: profile,
			recoveryAttempt: recoveryAttemptNumber,
		});
		const wrapperExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolveExit, rejectExit) => {
				child.once("error", rejectExit);
				child.once("close", (code, signal) => resolveExit({ code, signal }));
			},
		);
		wrapperExit.catch(() => undefined);
		const targetExit = observeOwnedWorkerTargetExit(child);
		targetExit.catch(() => undefined);
		const childStdio = child.stdio as Array<Readable | Writable | null | undefined>;
		const startupGate = childStdio[OWNED_WORKER_STARTUP_GATE_FD];
		const startupConfig = childStdio[OWNED_WORKER_STARTUP_CONFIG_FD];
		let childInput: Writable | undefined;
		let childOutput: Readable | undefined;
		let childError: Readable | undefined;
		try {
			if (childPid === undefined || childProcessStartId === undefined) {
				throw new Error("Owned session worker exact-identity probe unavailable");
			}
			const enrolled = enrollOrphanProcess(childPid);
			if (
				enrolled.processStartId !== childProcessStartId ||
				(process.platform === "darwin" && enrolled.processStartId !== ownerIdentity.processStartId)
			) {
				throw new Error("Owned session worker process identity changed before enrollment");
			}
			currentChild.candidate = enrolled;
			if (
				!(startupGate instanceof Writable) ||
				!(startupConfig instanceof Writable) ||
				!(childStdio[OWNED_WORKER_STARTUP_CONTROL_FD] instanceof Readable)
			) {
				throw new Error("Owned session worker startup gate could not be established");
			}
			if (terminating) throw new Error("Owned session worker launch was cancelled");
			if (!interactive) {
				childInput = child.stdin ?? undefined;
				childOutput = child.stdout ?? undefined;
				childError = child.stderr ?? undefined;
				if ((bridgeStdin && !childInput) || !childOutput || !childError) {
					throw new Error("Owned session worker did not expose bridged stdio");
				}
				childError.pipe(process.stderr, { end: false });
				if (profile === "rpc") {
					if (!childInput) throw new Error("Owned RPC worker did not expose stdin");
					currentRpcInput = childInput;
					currentRpcOutput = childOutput;
					if (rpcStdoutPaused) childOutput.pause();
					detachRpcOutput = attachJsonlLineReader(childOutput, observeRpcOutput);
					for (const buffered of bufferedRpcInput.splice(0)) childInput.write(buffered);
					if (stdinEnded) childInput.end();
				} else {
					if (childInput) process.stdin.pipe(childInput);
					childOutput.pipe(process.stdout, { end: false });
				}
			}
			const gatedLaunch: OwnedWorkerGateLaunch = {
				command: launch.command,
				args: launch.args,
				argv0: `${launch.command} ${ownerIdentity.argument}`,
				cwd: process.cwd(),
				env: preparedLaunch.environment,
			};
			await options.beforeWorkerStartupCommit?.();
			await writeAndCloseOwnedWorkerStartupPipe(startupConfig, JSON.stringify(gatedLaunch));
			await writeAndCloseOwnedWorkerStartupPipe(startupGate, DAEMON_WORKER_STARTUP_GATE_COMMIT);
		} catch (error) {
			startupGate?.destroy();
			startupConfig?.destroy();
			childStdio[OWNED_WORKER_STARTUP_CONTROL_FD]?.destroy();
			detachRpcOutput?.();
			detachRpcOutput = undefined;
			currentRpcInput = undefined;
			currentRpcOutput = undefined;
			if (childInput) process.stdin.unpipe(childInput);
			childOutput?.unpipe(process.stdout);
			childError?.unpipe(process.stderr);
			const exactCandidate = currentChild?.child === child ? currentChild.candidate : undefined;
			if (exactCandidate && shouldReapOrphanProcess(exactCandidate)) {
				try {
					if (process.platform !== "win32" && childPid === exactCandidate.pid) {
						process.kill(-exactCandidate.pid, "SIGKILL");
					} else if (process.platform === "win32") {
						child.kill("SIGKILL");
					}
				} catch {
					// The freshly matched gated group may already have observed pipe closure and exited.
				}
			}
			await waitForOwnedWrapperExit(wrapperExit, 5000);
			const cleanupVerified = await reapOwnedWorkerResources(
				currentChild?.candidate,
				orphanProcessJournalPath,
				orphanProcessAuthority.generation,
			);
			if (cleanupVerified) {
				await wrapperExit.catch(() => undefined);
				if (currentChild?.child === child) currentChild = undefined;
			}
			recordProcessLifecycle("owned_session_worker_spawn_error", {
				childProcessInstanceId: preparedLaunch.childProcessInstanceId,
				childPid,
				trigger,
				ownedWorkerProfile: profile,
				recoveryAttempt: recoveryAttemptNumber,
				errorMessage: error instanceof Error ? error.message : String(error),
				cleanupVerified,
			});
			throw error;
		}
		return {
			child,
			childProcessInstanceId: preparedLaunch.childProcessInstanceId,
			targetExit,
			wrapperExit,
		};
	};

	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	const signalHandlers = signals.map((signal) => {
		const handler = () => {
			terminating = true;
			terminationSignal ??= signal;
			if (currentChild) {
				forwardSignal(currentChild.child, signal);
			}
		};
		process.on(signal, handler);
		return { signal, handler };
	});

	const previousJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	const previousJournalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
	process.env[ORPHAN_PROCESS_JOURNAL_ENV] = orphanProcessJournalPath;
	process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = orphanProcessAuthority.generation;
	try {
		let workerArgs = [...args];
		let recoveryAttempt = 0;
		let pendingRecoveryAttempt: number | undefined;
		while (true) {
			if (terminating) {
				return exitCodeForSignal(terminationSignal ?? null);
			}
			const workerStartedAt = Date.now();
			const trigger = pendingRecoveryAttempt === undefined ? "owned_frontend_start" : "rpc_recovery";
			const spawned = await spawnWorker(workerArgs, trigger, pendingRecoveryAttempt);
			const { child, childProcessInstanceId } = spawned;
			const launchedRecoveryAttempt = pendingRecoveryAttempt;
			pendingRecoveryAttempt = undefined;
			if (launchedRecoveryAttempt !== undefined) {
				recordProcessLifecycle("owned_session_worker_recovery_result", {
					status: "spawned",
					attempt: launchedRecoveryAttempt,
					childProcessInstanceId,
					childPid: child.pid,
					ownedWorkerProfile: profile,
				});
			}
			const workerPid = child.pid;
			let closed: OwnedWorkerTargetExit;
			try {
				closed = await spawned.targetExit;
			} catch (error) {
				recordProcessLifecycle("owned_session_worker_spawn_error", {
					childProcessInstanceId,
					childPid: child.pid,
					trigger,
					ownedWorkerProfile: profile,
					recoveryAttempt: launchedRecoveryAttempt,
					errorMessage: error instanceof Error ? error.message : String(error),
					...((error as NodeJS.ErrnoException).code ? { errorCode: (error as NodeJS.ErrnoException).code } : {}),
				});
				if (launchedRecoveryAttempt !== undefined) {
					recordProcessLifecycle("owned_session_worker_recovery_result", {
						status: "spawn_error",
						attempt: launchedRecoveryAttempt,
						childProcessInstanceId,
						childPid: child.pid,
						ownedWorkerProfile: profile,
					});
				}
				throw error;
			}
			const normalizedCode = closed.exitCode;
			const pendingRpcCrash = profile === "rpc" && pendingRpcCommands.size > 0;
			const unexpected =
				!terminating &&
				(normalizedCode !== 0 || closed.signal !== null || closed.error !== undefined || pendingRpcCrash);
			const rpcCrashed = profile === "rpc" && unexpected;
			recordProcessLifecycle("owned_session_worker_close", {
				childProcessInstanceId,
				childPid: child.pid,
				trigger,
				ownedWorkerProfile: profile,
				recoveryAttempt: launchedRecoveryAttempt,
				expected: !unexpected,
				reason: terminating
					? "frontend-termination"
					: pendingRpcCrash
						? "pending-rpc-commands"
						: unexpected
							? "unexpected"
							: "completed",
				code: closed.exitCode,
				signal: closed.signal,
				...(closed.error ? { errorMessage: closed.error.message, errorCode: closed.error.code } : {}),
			});
			const exit = { code: normalizedCode, signal: closed.signal, rpcCrashed };
			currentRpcInput = undefined;
			currentRpcOutput = undefined;
			if (profile === "rpc" && !stdinEnded) {
				process.stdin.resume();
			}
			detachRpcOutput?.();
			detachRpcOutput = undefined;
			if (!interactive && profile !== "rpc" && child.stdin) {
				process.stdin.unpipe(child.stdin);
			}
			const cleanupVerified = await reapOwnedWorkerResources(
				currentChild?.candidate,
				orphanProcessJournalPath,
				orphanProcessAuthority.generation,
			);
			if (cleanupVerified) {
				await spawned.wrapperExit;
				if (currentChild?.child === child) currentChild = undefined;
			}
			const workerExitCode = rpcCrashed && exit.code === 0 ? 1 : exit.code;
			if (Date.now() - workerStartedAt >= 60_000) {
				recoveryAttempt = 0;
			}
			if (rpcCrashed) {
				failPendingRpcCommands();
			}
			if (!cleanupVerified) {
				await stopOwnedWorkerWithoutRetiring(currentChild);
				await waitForOwnedWrapperExit(spawned.wrapperExit, 5000);
				recordProcessLifecycle("owned_session_worker_recovery_result", {
					status: "cleanup_failed",
					attempts: recoveryAttempt,
					childProcessInstanceId,
					childPid: workerPid,
					ownedWorkerProfile: profile,
				});
				return terminationSignal ? exitCodeForSignal(terminationSignal) : workerExitCode || 1;
			}
			const shouldRecover = rpcCrashed && !stdinEnded && recoveryAttempt < 3;
			if (!shouldRecover) {
				if (rpcCrashed) {
					recordProcessLifecycle("owned_session_worker_recovery_result", {
						status: stdinEnded ? "stdin_ended" : "exhausted",
						attempts: recoveryAttempt,
						childProcessInstanceId,
						childPid: workerPid,
						ownedWorkerProfile: profile,
					});
				}
				return terminationSignal ? exitCodeForSignal(terminationSignal) : workerExitCode;
			}
			const descriptor = readOwnedRecoveryDescriptor(recoveryDescriptorPath);
			if (
				!descriptor?.sessionFile ||
				descriptor.orphanProcessJournalGeneration !== orphanProcessAuthority.generation
			) {
				recordProcessLifecycle("owned_session_worker_recovery_result", {
					status: "missing_session",
					attempts: recoveryAttempt,
					childProcessInstanceId,
					childPid: workerPid,
					ownedWorkerProfile: profile,
				});
				return terminationSignal ? exitCodeForSignal(terminationSignal) : workerExitCode;
			}
			workerArgs = createRpcRecoveryArgs(args, descriptor.sessionFile);
			const retryDelay = [250, 1000, 5000][recoveryAttempt] ?? 5000;
			recoveryAttempt++;
			pendingRecoveryAttempt = recoveryAttempt;
			recordProcessLifecycle("owned_session_worker_recovery_attempt", {
				attempt: recoveryAttempt,
				delayMs: retryDelay,
				previousChildProcessInstanceId: childProcessInstanceId,
				previousChildPid: workerPid,
				ownedWorkerProfile: profile,
				sessionId: descriptor.sessionId,
			});
			await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
			if (terminating) {
				recordProcessLifecycle("owned_session_worker_recovery_result", {
					status: "cancelled",
					attempt: recoveryAttempt,
					ownedWorkerProfile: profile,
					sessionId: descriptor.sessionId,
				});
				return exitCodeForSignal(terminationSignal ?? null);
			}
		}
	} finally {
		try {
			for (const { signal, handler } of signalHandlers) process.off(signal, handler);
			detachRpcInput?.();
			detachRpcOutput?.();
			const finalCleanupVerified = await reapOwnedWorkerResources(
				currentChild?.candidate,
				orphanProcessJournalPath,
				orphanProcessAuthority.generation,
			);
			if (finalCleanupVerified) {
				if (clearOrphanProcessJournal(orphanProcessJournalPath, orphanProcessAuthority.generation)) {
					rmSync(recoveryDescriptorPath, { force: true });
				}
			} else {
				await stopOwnedWorkerWithoutRetiring(currentChild);
			}
		} finally {
			if (previousJournalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousJournalPath;
			if (previousJournalGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = previousJournalGeneration;
		}
	}
}

export async function maybeRunOwnedSessionWorkerFrontend(
	args: readonly string[],
	forceLegacyFrontend = false,
	options: OwnedSessionWorkerFrontendOptions = {},
): Promise<boolean> {
	if (!forceLegacyFrontend && process.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND !== "1") {
		return false;
	}
	const profile = classifyOwnedSessionWorkerInvocation(args, process.stdin.isTTY);
	if (!profile) {
		return false;
	}
	process.exitCode = await runOwnedSessionWorkerFrontend(args, profile, options);
	return true;
}

export function installOwnedSessionWorkerOwnerWatch(): void {
	if (!isOwnedSessionWorkerProcess()) return;
	const ownerPid = Number(process.env[OWNED_OWNER_PID_ENV]);
	if (!process.channel && (!Number.isInteger(ownerPid) || ownerPid <= 0)) {
		throw new Error("Owned session worker is missing its owner channel");
	}

	let ownerGone = false;
	let ownerPoll: ReturnType<typeof setInterval> | undefined;
	const terminate = () => {
		if (ownerGone) return;
		ownerGone = true;
		if (ownerPoll) clearInterval(ownerPoll);
		closeOwnerWatch = undefined;
		const forceTimer = setTimeout(() => {
			if (process.platform !== "win32") {
				try {
					process.kill(-process.pid, "SIGKILL");
					return;
				} catch {
					// Fall through to terminating only this process.
				}
			}
			process.exit(143);
		}, 5000);
		forceTimer.unref();
		process.kill(process.pid, "SIGTERM");
	};
	if (process.channel) {
		process.once("disconnect", terminate);
		process.channel.unref();
	} else {
		ownerPoll = setInterval(() => {
			if (process.ppid !== ownerPid) terminate();
		}, 100);
		ownerPoll.unref();
		if (process.ppid !== ownerPid) terminate();
	}
	closeOwnerWatch = () => {
		if (ownerGone) return;
		ownerGone = true;
		if (ownerPoll) clearInterval(ownerPoll);
		process.off("disconnect", terminate);
		if (process.connected) process.disconnect();
		closeOwnerWatch = undefined;
	};
}

export function closeOwnedSessionWorkerOwnerWatch(): void {
	closeOwnerWatch?.();
}
