// Kernel client for the REPL runtime: the kernel is a JSON-lines subprocess
// (`python -m rlm.repl`) — requests on stdin, events on stdout, stderr kept as
// a diagnostics tail. The protocol is documented in prime-agent-runtime/src/rlm/repl.md.
import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { v4 as uuid } from "uuid";
import {
	type ActiveOrphanProcessCandidate,
	createKernelLineage,
	enrollOrphanProcess,
	isOrphanProcessCandidateExactDead,
	KERNEL_ADMISSION_GENERATION_ENV,
	KERNEL_ADMISSION_PROTOCOL_ENV,
	KERNEL_LINEAGE_ENV,
	KERNEL_PID_ENV,
	KERNEL_PROCESS_START_ID_ENV,
	type KernelAdmissionLineage,
	matchesKernelAdmissionLineage,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	readActiveOrphanProcesses,
	reapKernelOrphanProcesses,
	retireOrphanProcess,
	retireOrphanProcessAfterHeldWindowsJobEmpty,
	shouldReapOrphanProcess,
} from "../orphan-process-journal.js";
import {
	createObservedProcessInstanceId,
	recordProcessLifecycle,
	withoutProcessLifecycleEnvironment,
} from "../process-lifecycle.js";
import {
	createProcessIdentityOwnerToken,
	isExactProcessStartId,
	observeProcessIdentity,
	supportsExactProcessIdentityPlatform,
} from "../session-lease.js";
import {
	prepareWindowsPersistentReplHelperLaunch,
	resolveReplPythonWithoutExecution,
	WINDOWS_PERSISTENT_REPL_CONTROL_INPUT_FD,
	WINDOWS_PERSISTENT_REPL_CONTROL_OUTPUT_FD,
	WINDOWS_PERSISTENT_REPL_PROTOCOL_VERSION,
	type WindowsPersistentReplExpectedIdentity,
	WindowsPersistentReplFrameStream,
	type WindowsPersistentReplTargetIdentity,
	writeWindowsPersistentReplControl,
} from "./repl-admission.js";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	createDeferred,
	createKernelStartupAbortError,
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_SNAPSHOT_DEBOUNCE_MS,
	DIFF_DISPLAY_MIME,
	type ExecuteOptions,
	type ExecuteResult,
	errorMessage,
	HOST_REQUEST_SHUTDOWN_TIMEOUT_MS,
	installSignalHandlersOnce,
	isRecord,
	KERNEL_ABORT_GRACE_MS,
	KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
	KERNEL_BUSY_REUSE_WAIT_MS,
	KERNEL_SHUTDOWN_TIMEOUT_MS,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelDiffDisplay,
	type KernelManagerOptions,
	type KernelSentAgentMessage,
	type KernelShutdownOptions,
	type KernelStartOptions,
	liveKernels,
	MAX_ATTACHMENT_DATA_CHARS,
	MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
	parseAttachmentDisplay,
	parseDiffDisplay,
	parseSentAgentMessage,
	raceStartupWithAbort,
	SNAPSHOT_EXECUTION_TIMEOUT_MS,
} from "./shared.js";
import {
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	type RestoreResult,
	type SnapshotResult,
} from "./state-snapshot.js";

const REPL_PROTOCOL_VERSION = 4;
const READY_TIMEOUT_MS = 30_000;
const REPAIR_STEP_TIMEOUT_MS = 30_000;
// Runtime-minted host-request ids never repeat; the bound only guards a
// misbehaving runtime from growing the dedup set forever.
const MAX_HANDLED_HOST_REQUEST_IDS = 1024;
// Cap for unattributed background output buffered between and during cells.
const MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024;
const KERNEL_STDERR_TAIL_MAX_BYTES = 32 * 1024;
// Match the runtime's largest framed control payload. A delimiter-free target
// line beyond this point is protocol corruption, never an unbounded host buffer.
export const REPL_PROTOCOL_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const KERNEL_REQUEST_UNCERTAIN_OUTCOME_MESSAGE =
	"The Python cell may or may not have run; it was not replayed. The kernel is being repaired from the last safe snapshot.";

const PROCESS_STARTUP_ACK_FD = 3;
const PROCESS_STARTUP_CONFIG_FD = 4;
const PROCESS_STARTUP_CONTROL_FD = 5;
const PROCESS_STARTUP_CONTROL_VERSION = 2;
const PROCESS_STARTUP_CONTROL_MAX_BYTES = 8 * 1024;

/**
 * Exact trusted source passed to host Node `-e`. The process reports its own
 * PID, waits for a generation/token-bound acknowledgement, then replaces
 * itself with Python. String.raw preserves generated JS escapes.
 */
export const REPL_PROCESS_STARTUP_GATE_SOURCE = String.raw`
"use strict";
const { accessSync, closeSync, constants: fsConstants, readFileSync, writeSync } = require("node:fs");
const ackFd = ${PROCESS_STARTUP_ACK_FD};
const configFd = ${PROCESS_STARTUP_CONFIG_FD};
const controlFd = ${PROCESS_STARTUP_CONTROL_FD};
const controlVersion = ${PROCESS_STARTUP_CONTROL_VERSION};
const targetToken = process.argv[1];
const admissionGeneration = process.argv[2];
const expectedTokenPrefix = "prime-agent-" + "owner-token=";
function diagnostic(message) {
  try { writeSync(2, "prime-agent kernel admission: " + message + "\n"); } catch {}
}
function fail(message, code = 125) {
  diagnostic(message);
  process.exit(code);
}
if (
  typeof targetToken !== "string"
  || targetToken.length !== expectedTokenPrefix.length + 64
  || !targetToken.startsWith(expectedTokenPrefix)
  || !/^[a-f0-9]{64}$/.test(targetToken.slice(expectedTokenPrefix.length))
) fail("invalid target token");
if (
  typeof admissionGeneration !== "string"
  || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(admissionGeneration)
) fail("invalid admission generation");
if (process.platform === "win32") {
  fail("the POSIX same-process REPL admission gate cannot run on Windows");
}
if (typeof process.execve !== "function") fail("host Node does not provide same-process execve admission");
let launch;
try {
  launch = JSON.parse(readFileSync(configFd, "utf8"));
} catch (error) {
  fail("invalid startup configuration: " + error.message);
}
const tokenPrefix = targetToken.slice(0, targetToken.length - 64);
const validLaunch = launch && typeof launch === "object" && !Array.isArray(launch)
  && launch.primeAgentStartupGate === controlVersion
  && launch.admissionGeneration === admissionGeneration
  && launch.targetToken === targetToken
  && typeof launch.kernelLineage === "string" && /^[a-f0-9]{64}$/.test(launch.kernelLineage)
  && typeof launch.command === "string" && launch.command.length > 0 && !launch.command.includes("\0")
  && !launch.command.includes(targetToken) && !launch.command.includes(tokenPrefix)
  && Array.isArray(launch.args) && launch.args.every((value) =>
    typeof value === "string" && !value.includes("\0")
    && !value.includes(targetToken) && !value.includes(tokenPrefix))
  && typeof launch.cwd === "string" && launch.cwd.length > 0 && !launch.cwd.includes("\0")
  && launch.env && typeof launch.env === "object" && !Array.isArray(launch.env)
  && launch.env[${JSON.stringify(KERNEL_ADMISSION_GENERATION_ENV)}] === admissionGeneration
  && launch.env[${JSON.stringify(KERNEL_ADMISSION_PROTOCOL_ENV)}] === String(controlVersion)
  && launch.env[${JSON.stringify(KERNEL_LINEAGE_ENV)}] === launch.kernelLineage
  && launch.env[${JSON.stringify(KERNEL_PID_ENV)}] === undefined
  && launch.env[${JSON.stringify(KERNEL_PROCESS_START_ID_ENV)}] === undefined
  && Object.entries(launch.env).every(([key, value]) =>
    key.length > 0 && !key.includes("=") && !key.includes("\0")
    && !key.includes(targetToken)
    && typeof value === "string" && !value.includes("\0")
    && !value.includes(targetToken));
if (!validLaunch) fail("invalid or unbound startup configuration");
const pending = {
  primeAgentStartupGate: controlVersion,
  type: "target-pending",
  admissionGeneration,
  targetToken,
  targetPid: process.pid,
};
try {
  writeSync(controlFd, JSON.stringify(pending) + "\n");
} catch (error) {
  fail("control write failed: " + error.message);
}
let ack;
try {
  ack = JSON.parse(readFileSync(ackFd, "utf8"));
} catch (error) {
  fail("invalid admission acknowledgement: " + error.message);
}
const ackKeys = ack && typeof ack === "object" && !Array.isArray(ack)
  ? Object.keys(ack).sort().join(",")
  : "";
function isCanonicalExactStartId(value) {
  if (typeof value !== "string") return false;
  if (/^token:[0-9a-f]{64}$/.test(value)) return true;
  if (/^win:(?:0|[1-9][0-9]{0,31})$/.test(value)) return true;
  const linux = /^proc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,19})$/.exec(value);
  if (!linux) return false;
  const ticks = linux[1];
  const maximum = "18446744073709551615";
  return ticks.length < maximum.length || ticks <= maximum;
}
if (
  ackKeys !== "admissionGeneration,kernelLineage,kernelProcessStartId,primeAgentStartupGate,targetPid,targetToken,type"
  || ack.primeAgentStartupGate !== controlVersion
  || ack.type !== "target-ack"
  || ack.admissionGeneration !== admissionGeneration
  || ack.targetToken !== targetToken
  || ack.targetPid !== process.pid
  || ack.kernelLineage !== launch.kernelLineage
  || !isCanonicalExactStartId(ack.kernelProcessStartId)
) fail("admission protocol/version or exact identity mismatch");
launch.env[${JSON.stringify(KERNEL_ADMISSION_GENERATION_ENV)}] = admissionGeneration;
launch.env[${JSON.stringify(KERNEL_LINEAGE_ENV)}] = launch.kernelLineage;
launch.env[${JSON.stringify(KERNEL_PID_ENV)}] = String(process.pid);
launch.env[${JSON.stringify(KERNEL_PROCESS_START_ID_ENV)}] = ack.kernelProcessStartId;
try { closeSync(ackFd); } catch {}
try { closeSync(configFd); } catch {}
try { closeSync(controlFd); } catch {}
// Target path traversal and cwd access happen only after the host durably
// enrolled this exact pending process and returned its bound acknowledgement.
try {
  accessSync(launch.command, fsConstants.X_OK);
  process.chdir(launch.cwd);
} catch (error) {
  fail("target preparation failed: " + error.message, error && error.code === "ENOENT" ? 127 : 126);
}
try {
  process.execve(launch.command, [launch.command, ...launch.args, targetToken], launch.env);
} catch (error) {
  fail("target exec failed: " + error.message, error && error.code === "ENOENT" ? 127 : 126);
}
fail("target exec returned unexpectedly", 126);
`;

interface GatedProcessLaunch {
	primeAgentStartupGate: number;
	admissionGeneration: string;
	targetToken: string;
	kernelLineage: string;
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

interface GatedTargetPending {
	targetPid: number;
	admissionGeneration: string;
	targetToken: string;
}

const WINDOWS_REPL_ADMISSION_TIMEOUT_MS = 30_000;
const WINDOWS_REPL_CLEANUP_TIMEOUT_MS = 10_000;

interface WindowsPersistentReplControl {
	child: ChildProcess;
	expected: WindowsPersistentReplExpectedIdentity;
	target: WindowsPersistentReplTargetIdentity;
	lineage: KernelAdmissionLineage;
	input: Writable;
	frames: WindowsPersistentReplFrameStream;
	closeControl: () => void;
	doneProof: Promise<boolean>;
	terminationRequested: boolean;
}

export function parseGatedTargetPendingFrame(line: string, expected: GatedTargetPending): GatedTargetPending {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Kernel startup gate emitted an invalid admission frame", { cause: error });
	}
	if (
		!isRecord(value) ||
		value.primeAgentStartupGate !== PROCESS_STARTUP_CONTROL_VERSION ||
		value.type !== "target-pending" ||
		value.targetPid !== expected.targetPid ||
		value.admissionGeneration !== expected.admissionGeneration ||
		value.targetToken !== expected.targetToken ||
		Object.keys(value).sort().join(",") !== "admissionGeneration,primeAgentStartupGate,targetPid,targetToken,type"
	) {
		throw new Error("Kernel startup gate emitted a stale or invalid admission frame");
	}
	return expected;
}

function observeGatedTargetPending(child: ChildProcess, expected: GatedTargetPending): Promise<GatedTargetPending> {
	const control = (child.stdio as Array<Readable | Writable | null | undefined> | undefined)?.[
		PROCESS_STARTUP_CONTROL_FD
	];
	if (!(control instanceof Readable)) {
		return Promise.reject(new Error("Kernel startup control pipe is unavailable"));
	}
	const decoder = new StringDecoder("utf8");
	let buffered = "";
	let bytesSeen = 0;
	let settled = false;
	return new Promise<GatedTargetPending>((resolvePending, rejectPending) => {
		const cleanup = () => {
			control.off("data", onData);
			control.off("error", fail);
			control.off("end", onEnd);
			child.off("error", onChildError);
			child.off("exit", onChildExit);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPending(error instanceof Error ? error : new Error(String(error)));
		};
		const onChildError = (error: Error) => fail(error);
		const onChildExit = () => fail(new Error("Kernel startup gate exited before admission"));
		const onEnd = () => fail(new Error("Kernel startup gate closed before admission"));
		const onData = (chunk: Buffer) => {
			if (settled) return;
			bytesSeen += chunk.length;
			if (bytesSeen > PROCESS_STARTUP_CONTROL_MAX_BYTES) {
				fail(new Error("Kernel startup admission frame exceeded its bound"));
				return;
			}
			buffered += decoder.write(chunk);
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline).trim();
			const trailing = buffered.slice(newline + 1).trim();
			if (!line || trailing) {
				fail(new Error("Kernel startup gate repeated or malformed its admission frame"));
				return;
			}
			try {
				const pending = parseGatedTargetPendingFrame(line, expected);
				settled = true;
				cleanup();
				resolvePending(pending);
			} catch (error) {
				fail(error);
			}
		};
		control.on("data", onData);
		control.once("error", fail);
		control.once("end", onEnd);
		child.once("error", onChildError);
		child.once("exit", onChildExit);
	});
}

function minimalStartupGateEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
		if (source[name] !== undefined) environment[name] = source[name];
	}
	return environment;
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
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

function writeAndCloseStartupPipe(pipe: Writable, value: string): Promise<void> {
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

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	if (typeof child.once !== "function" || typeof child.off !== "function") return Promise.resolve(false);
	return new Promise((resolveExit) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			child.off("exit", onExit);
			globalThis.clearTimeout(timeout);
			resolveExit(exited);
		};
		const onExit = () => finish(true);
		const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
		child.once("exit", onExit);
	});
}

async function waitForOrphanCandidateDeath(
	candidate: ActiveOrphanProcessCandidate,
	timeoutMs: number,
): Promise<boolean> {
	if (process.platform === "win32") return false;
	const deadline = Date.now() + timeoutMs;
	while (!isOrphanProcessCandidateExactDead(candidate) && Date.now() < deadline) {
		await new Promise<void>((resolveDelay) => {
			const timer = globalThis.setTimeout(resolveDelay, 25);
			timer.unref?.();
		});
	}
	return isOrphanProcessCandidateExactDead(candidate);
}

type KernelRepairReason = "protocol-corruption" | "request-write-failed" | "unexpected-exit" | "child-process-error";

function boundedUtf8Tail(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function lifecycleError(error: unknown): { name: string; message: string; code?: string | number } {
	if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
	const code = (error as NodeJS.ErrnoException).code;
	return { name: error.name, message: error.message, ...(code !== undefined ? { code } : {}) };
}

function createUncertainRequestError(reason: string, cause?: unknown): Error {
	return new Error(
		`${reason}. ${KERNEL_REQUEST_UNCERTAIN_OUTCOME_MESSAGE}`,
		cause === undefined ? undefined : { cause },
	);
}

interface KernelProcessObservation {
	details: Record<string, unknown>;
	expected: boolean;
	recorded: boolean;
	stderrTail: string;
}

/** ExecuteResult plus the raw fields of the request's `done` event (state ops). */
interface InternalExecuteResult extends ExecuteResult {
	doneFields?: Record<string, unknown>;
}

interface ActiveExecution {
	requestId: string;
	/** Source of the cell currently executing; surfaced to rlm.run spawns. */
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	diffs: KernelDiffDisplay[];
	attachments: KernelAttachment[];
	sentAgentMessages: KernelSentAgentMessage[];
	/** Stream text without this execution's id: user threads, other cells' leftovers, raw fd writes. */
	backgroundOutput: string;
	backgroundOutputTruncated: boolean;
	error?: ExecuteResult["error"];
	status: ExecuteResult["status"];
	doneFields?: Record<string, unknown>;
	settled: boolean;
	resolve: (result: InternalExecuteResult) => void;
	reject: (error: Error) => void;
}

// Complete event vocabulary of protocol version 2 (see prime-agent-runtime/src/rlm/repl.md).
// The version handshake is exact, so an unknown kind is corruption, not a newer runtime.
const PROTOCOL_EVENT_KINDS = new Set([
	"ready",
	"stdout",
	"stderr",
	"result",
	"display",
	"host_request",
	"error",
	"done",
]);

/**
 * Reason a JSON object still isn't a valid protocol frame, or undefined.
 * `done` and `host_request` route strictly by non-empty string id (the runtime
 * mints uuid hex ids and echoes the host's uuids); silently dropping an id-less
 * one would leave the awaiting request unsettled forever.
 */
function invalidProtocolFrameReason(event: Record<string, unknown>): string | undefined {
	if (typeof event.event !== "string" || !PROTOCOL_EVENT_KINDS.has(event.event)) {
		return "unknown protocol event";
	}
	if (
		(event.event === "done" || event.event === "host_request") &&
		(typeof event.id !== "string" || event.id === "")
	) {
		return `${event.event} frame without id`;
	}
	return undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (isRecord(entry) && typeof entry.name === "string") {
			return [{ name: entry.name, reason: typeof entry.reason === "string" ? entry.reason : "" }];
		}
		return [];
	});
}

function trackedOrphanCandidateKey(candidate: ActiveOrphanProcessCandidate): string {
	return JSON.stringify([
		candidate.pid,
		candidate.processStartId ?? null,
		candidate.kernelPid ?? null,
		candidate.kernelProcessStartId ?? null,
		candidate.admissionGeneration ?? null,
		candidate.kernelLineage ?? null,
	]);
}

export class ReplKernelManager {
	private readonly options: Pick<
		KernelManagerOptions,
		"python" | "cwd" | "env" | "sessionId" | "hostHandlers" | "pythonSkills" | "snapshot" | "bootstrapCode"
	>;
	private readonly session = uuid();
	private readonly handledHostRequestIds = new Set<string>();
	private child?: ChildProcess;
	private readyDeferred?: ReturnType<typeof createDeferred<number>>;
	private kernelInstanceId?: string;
	private kernelChildProcessInstanceId?: string;
	private kernelProcessPid?: number;
	private kernelProcessGroupPid?: number;
	private kernelAdmissionLineage?: KernelAdmissionLineage;
	private readonly kernelOrphanCandidates = new Map<string, ActiveOrphanProcessCandidate>();
	/** Old exact kernel lineages whose separately-sessioned journal children must be gone before replacement. */
	private readonly kernelPidsAwaitingDescendantCleanup = new Map<string, KernelAdmissionLineage>();
	/** Windows targets cannot retire on leader exit; only a bound held-Job-empty frame removes this requirement. */
	private readonly windowsTargetsAwaitingJobEmptyProof = new Map<string, KernelAdmissionLineage>();
	/** Bound held-Job-empty attestations retained until every matching journal authority retires. */
	private readonly windowsHeldJobEmptyProofs = new Map<string, KernelAdmissionLineage>();
	private windowsPersistentReplControl?: WindowsPersistentReplControl;
	private pendingGatedStartupChild?: {
		child: ChildProcess;
		candidate: ActiveOrphanProcessCandidate;
		observation: KernelProcessObservation;
	};
	private kernelLaunchStartedAt?: number;
	private kernelExit?: { code: number | null; signal: NodeJS.Signals | null };
	private kernelObservation?: KernelProcessObservation;
	private nextLaunchTrigger: "kernel-start" | "kernel-restart" | "kernel-repair" = "kernel-start";
	private kernelStderr = "";
	/** Serializes execute() calls — the runtime runs one request at a time. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly activeExecutionIdleWaiters = new Set<() => void>();
	private readonly lateSentAgentMessageHandlers = new Map<string, (message: KernelSentAgentMessage) => void>();
	/** Resolvers for done events outside the active execution (the shutdown reply). */
	private readonly pendingDoneWaiters = new Map<string, () => void>();
	// Source of the most recently started cell, retained after it finishes so
	// rlm.run spawns from detached asyncio tasks (cell already idle) can still
	// attribute their spawning program.
	private lastCellCode?: string;
	/** Unattributed stream text that arrived between cells; surfaced on the next execution. */
	private pendingBackgroundOutput = "";
	private pendingBackgroundOutputTruncated = false;
	private readonly inFlightHostRequests = new Set<Promise<void>>();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	/** Bumped by every teardown so a stale in-flight doStart can never touch a newer kernel. */
	private startGeneration = 0;
	/** Generation whose graceful shutdown() owns the teardown, so the exit handler must not run it. */
	private gracefulShutdownGeneration?: number;
	private gracefulShutdownPromise?: Promise<boolean>;
	/** Memoized so concurrent callers all await the same in-flight startup. */
	private startPromise?: Promise<void>;
	/** Pending debounced auto-snapshot, if one has been scheduled. */
	private snapshotTimer?: ReturnType<typeof globalThis.setTimeout>;
	/** While the final dispose snapshot is flushing, new external executions are rejected. */
	private flushingSnapshotForDispose = false;
	/** In-flight final snapshot flush; concurrent teardowns join it instead of re-flushing. */
	private snapshotFlushForDispose?: Promise<void>;
	/** Repairs a child whose dedicated protocol stream emitted an invalid frame. */
	private protocolRepairPromise?: Promise<void>;
	private protocolRepairOwner?: { superseded: boolean };
	/** Corruption seen while still "starting" (e.g. ready and garbage in one chunk) fails that start. */
	private startupProtocolError?: Error;
	/** A repair discarded its kernel: the next fresh start must re-run the runtime bootstrap. */
	private pendingRebootstrap = false;
	/** Restore the saved namespace on that fresh start too (false when the snapshot itself is the declared culprit). */
	private pendingRestore = false;
	private rebootstrapPromise?: Promise<boolean>;
	private teardownInFlight = 0;

	constructor(options: KernelManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			hostHandlers: options.hostHandlers,
			pythonSkills: options.pythonSkills,
			snapshot: options.snapshot,
			bootstrapCode: options.bootstrapCode,
		};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	private appendKernelDiagnostic(message: string): void {
		this.kernelStderr = boundedUtf8Tail(
			`${this.kernelStderr}[kernel] ${message.endsWith("\n") ? message : `${message}\n`}`,
			KERNEL_STDERR_TAIL_MAX_BYTES,
		);
	}

	private kernelLifecycleDetails(
		details: Record<string, unknown> = {},
		includeStderrTail = false,
	): Record<string, unknown> {
		const stderrTail = includeStderrTail ? boundedUtf8Tail(this.kernelStderr, KERNEL_STDERR_TAIL_MAX_BYTES) : "";
		return {
			sessionId: this.options.sessionId ?? this.session,
			...(this.kernelInstanceId ? { kernelInstanceId: this.kernelInstanceId } : {}),
			launchMode: "direct",
			transport: "rlm-repl-stdio",
			...(this.kernelProcessPid !== undefined ? { pid: this.kernelProcessPid } : {}),
			...(this.kernelChildProcessInstanceId
				? { childProcessInstanceId: this.kernelChildProcessInstanceId, childLifecycleSelfLogged: false }
				: {}),
			...details,
			...(stderrTail ? { stderrTail } : {}),
		};
	}

	private beginKernelProcessObservation(): KernelProcessObservation {
		const observation: KernelProcessObservation = {
			details: this.kernelLifecycleDetails(),
			expected: false,
			recorded: false,
			stderrTail: "",
		};
		this.kernelObservation = observation;
		return observation;
	}

	private markKernelExitExpected(): void {
		if (this.kernelObservation) this.kernelObservation.expected = true;
	}

	private recordKernelProcessExit(
		code: number | null,
		signal: NodeJS.Signals | null,
		observationSource: string,
		observation: KernelProcessObservation | undefined = this.kernelObservation,
	): void {
		if (!observation || observation.recorded) return;
		observation.recorded = true;
		if (this.kernelObservation === observation) this.kernelExit = { code, signal };
		recordProcessLifecycle("kernel_process_exit", {
			...observation.details,
			expected: observation.expected,
			code,
			signal,
			observation: observationSource,
			...(!observation.expected && observation.stderrTail ? { stderrTail: observation.stderrTail } : {}),
		});
	}

	private recordKernelStartFailure(error: unknown): void {
		recordProcessLifecycle(
			"kernel_start_failed",
			this.kernelLifecycleDetails(
				{
					error: lifecycleError(error),
					code: this.kernelExit?.code,
					signal: this.kernelExit?.signal,
					durationMs:
						this.kernelLaunchStartedAt === undefined ? undefined : Date.now() - this.kernelLaunchStartedAt,
				},
				true,
			),
		);
	}

	async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) {
			throw createKernelStartupAbortError();
		}
		if (!this.startPromise) {
			const startPromise = this.doStart({ onBootstrapProgress: options.onBootstrapProgress }).catch((error) => {
				// Teardown clears the memoized promise before its startup rejection can
				// arrive. Record that failure unless a newer start already owns the slot.
				if (this.startPromise === startPromise || this.startPromise === undefined) {
					this.recordKernelStartFailure(error);
				}
				// Only clear our own memoization: a stale start must not evict a newer one.
				if (this.startPromise === startPromise) this.startPromise = undefined;
				throw error;
			});
			this.startPromise = startPromise;
		}
		return raceStartupWithAbort(this.startPromise, options.signal);
	}

	private async reapPendingGatedStartupChild(): Promise<boolean> {
		const pending = this.pendingGatedStartupChild;
		if (!pending) return true;
		return this.abortGatedChildAndProveDeath(pending.child, pending.candidate, pending.observation);
	}

	private findTrackedKernelCandidate(
		pid: number,
		lineage: KernelAdmissionLineage | undefined = this.kernelAdmissionLineage,
	): ActiveOrphanProcessCandidate | undefined {
		return [...this.kernelOrphanCandidates.values()].find(
			(candidate) =>
				candidate.pid === pid && (lineage === undefined || matchesKernelAdmissionLineage(candidate, lineage)),
		);
	}

	private trackKernelJournalChildren(lineage: KernelAdmissionLineage, includeKernel = false): boolean {
		const journalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		if (!journalPath) return true;
		try {
			const active = readActiveOrphanProcesses(journalPath, process.pid);
			if (includeKernel) {
				for (const [key, candidate] of this.kernelOrphanCandidates) {
					if (matchesKernelAdmissionLineage(candidate, lineage)) {
						this.kernelOrphanCandidates.delete(key);
					}
				}
			}
			for (const orphan of active) {
				if (!matchesKernelAdmissionLineage(orphan, lineage)) continue;
				if (!includeKernel && orphan.pid === lineage.kernelPid) continue;
				this.kernelOrphanCandidates.set(trackedOrphanCandidateKey(orphan), orphan);
			}
			return true;
		} catch (error) {
			this.appendKernelDiagnostic(`failed to read kernel child authority: ${String(error)}`);
			return false;
		}
	}

	private retireWindowsHeldJobAuthorities(lineage: KernelAdmissionLineage): boolean {
		// The validated helper frame proves its still-held outer Job is empty. Read
		// after that proof so an immediately dying target cannot publish a final
		// separately-sessioned bash child behind this scan.
		if (!this.trackKernelJournalChildren(lineage, true)) return false;
		const authorities = [...this.kernelOrphanCandidates.values()].filter((candidate) =>
			matchesKernelAdmissionLineage(candidate, lineage),
		);
		const target = authorities.find((candidate) => candidate.pid === lineage.kernelPid);
		if (target?.processStartId !== undefined && target.processStartId !== lineage.kernelProcessStartId) {
			this.appendKernelDiagnostic(`held Windows Job proof changed target identity for ${lineage.kernelPid}`);
			return false;
		}
		for (const candidate of authorities) {
			try {
				if (!retireOrphanProcessAfterHeldWindowsJobEmpty(candidate)) return false;
			} catch (error) {
				this.appendKernelDiagnostic(`failed to retire held-Job kernel authority: ${String(error)}`);
				return false;
			}
			this.kernelOrphanCandidates.delete(trackedOrphanCandidateKey(candidate));
		}
		// A final strict read catches a concurrent journal append. Job-empty means
		// no legitimate target descendant can publish after this point.
		if (!this.trackKernelJournalChildren(lineage, true)) return false;
		if (
			[...this.kernelOrphanCandidates.values()].some((candidate) =>
				matchesKernelAdmissionLineage(candidate, lineage),
			)
		) {
			return false;
		}
		this.kernelPidsAwaitingDescendantCleanup.delete(lineage.kernelLineage);
		this.windowsHeldJobEmptyProofs.delete(lineage.kernelLineage);
		this.windowsTargetsAwaitingJobEmptyProof.delete(lineage.kernelLineage);
		return true;
	}

	private async retireCleanupProvenKernelAuthorities(): Promise<boolean> {
		// Windows leader death, helper exit, and signal delivery never prove tree
		// death. Retry journal retirement only from a retained, bound held-Job-empty
		// attestation; a target without one blocks replacement.
		for (const lineage of this.windowsHeldJobEmptyProofs.values()) {
			if (!this.retireWindowsHeldJobAuthorities(lineage)) return false;
		}
		if (this.windowsTargetsAwaitingJobEmptyProof.size > 0) return false;
		for (const lineage of this.kernelPidsAwaitingDescendantCleanup.values()) {
			reapKernelOrphanProcesses(lineage);
		}
		// First prove every already-known target or descendant identity gone. A
		// target must be dead before the final journal scan, so it cannot publish a
		// late separately-sessioned bash child behind the scan.
		for (const [key, candidate] of [...this.kernelOrphanCandidates]) {
			if (!(await waitForOrphanCandidateDeath(candidate, 5000))) return false;
			if (!this.kernelOrphanCandidates.has(key)) continue;
			try {
				if (!retireOrphanProcess(candidate)) return false;
			} catch (error) {
				this.appendKernelDiagnostic(`failed to retire prior kernel authority: ${String(error)}`);
				return false;
			}
			this.kernelOrphanCandidates.delete(key);
		}

		for (const [lineageKey, lineage] of [...this.kernelPidsAwaitingDescendantCleanup]) {
			if (!this.trackKernelJournalChildren(lineage)) return false;
			reapKernelOrphanProcesses(lineage);
			for (const [key, candidate] of [...this.kernelOrphanCandidates]) {
				if (!matchesKernelAdmissionLineage(candidate, lineage) || candidate.pid === lineage.kernelPid) continue;
				if (!(await waitForOrphanCandidateDeath(candidate, 5000))) return false;
				if (!this.kernelOrphanCandidates.has(key)) continue;
				try {
					if (!retireOrphanProcess(candidate)) return false;
				} catch (error) {
					this.appendKernelDiagnostic(`failed to retire kernel child authority: ${String(error)}`);
					return false;
				}
				this.kernelOrphanCandidates.delete(key);
			}
			// Re-read after all deaths and retirements. Any new exact-lineage record
			// means the cleanup boundary raced; partial/legacy evidence stays durable
			// for global recovery and is never selected by a reused PID alone.
			if (!this.trackKernelJournalChildren(lineage)) return false;
			if (
				[...this.kernelOrphanCandidates.values()].some((candidate) =>
					matchesKernelAdmissionLineage(candidate, lineage),
				)
			) {
				reapKernelOrphanProcesses(lineage);
				return false;
			}
			this.kernelPidsAwaitingDescendantCleanup.delete(lineageKey);
		}
		return true;
	}

	private async abortGatedChildAndProveDeath(
		child: ChildProcess,
		candidate: ActiveOrphanProcessCandidate,
		observation: KernelProcessObservation,
	): Promise<boolean> {
		observation.expected = true;
		child.stdio?.[PROCESS_STARTUP_ACK_FD]?.destroy();
		child.stdio?.[PROCESS_STARTUP_CONFIG_FD]?.destroy();
		(child.stdio as Array<Readable | Writable | null | undefined>)[PROCESS_STARTUP_CONTROL_FD]?.destroy();
		child.stdin?.destroy();
		if (shouldReapOrphanProcess(candidate)) {
			try {
				if (process.platform !== "win32" && child.pid === candidate.pid) {
					process.kill(-candidate.pid, "SIGKILL");
				} else if (process.platform === "win32") {
					child.kill("SIGKILL");
				}
			} catch {
				// The freshly matched exact child may already have observed gate EOF and exited.
			}
		}
		await waitForChildExit(child, 5000);
		const exactDead = isOrphanProcessCandidateExactDead(candidate);
		if (!exactDead) {
			this.pendingGatedStartupChild = { child, candidate, observation };
			return false;
		}
		this.recordKernelProcessExit(child.exitCode, child.signalCode, "startup-gate-cleanup", observation);
		const candidateKey = trackedOrphanCandidateKey(candidate);
		const trackedCandidate = this.kernelOrphanCandidates.get(candidateKey);
		if (trackedCandidate) {
			try {
				if (retireOrphanProcess(candidate)) this.kernelOrphanCandidates.delete(candidateKey);
			} catch (error) {
				this.appendKernelDiagnostic(`failed to retire gated kernel authority: ${String(error)}`);
			}
		}
		if (this.pendingGatedStartupChild?.child === child) this.pendingGatedStartupChild = undefined;
		if (this.child === child) this.child = undefined;
		if (this.kernelProcessGroupPid === candidate.pid) this.kernelProcessGroupPid = undefined;
		child.stdout?.destroy();
		child.stderr?.destroy();
		return true;
	}

	private windowsControlRecord(
		control: WindowsPersistentReplControl,
		type: "target-ack" | "terminate",
	): Record<string, unknown> {
		return {
			version: WINDOWS_PERSISTENT_REPL_PROTOCOL_VERSION,
			type,
			admissionGeneration: control.expected.admissionGeneration,
			targetToken: control.expected.targetToken,
			targetPid: control.target.targetPid,
			processStartId: control.target.processStartId,
		};
	}

	private async requestWindowsPersistentReplTermination(control: WindowsPersistentReplControl): Promise<void> {
		if (control.terminationRequested) return;
		control.terminationRequested = true;
		try {
			await writeWindowsPersistentReplControl(control.input, this.windowsControlRecord(control, "terminate"));
		} catch (error) {
			this.appendKernelDiagnostic(`failed to request held-Job REPL termination: ${String(error)}`);
		}
	}

	private observeWindowsPersistentReplDone(
		control: Omit<WindowsPersistentReplControl, "doneProof">,
		observation: KernelProcessObservation,
	): Promise<boolean> {
		return (async () => {
			try {
				while (true) {
					const frame = await control.frames.next(["target-done"], 0);
					if (frame.type !== "target-done") continue;
					if (frame.leaderDead) {
						this.recordKernelProcessExit(frame.exitCode, null, "held-windows-job-accounting", observation);
					}
					const proof = frame.leaderDead && frame.jobEmpty;
					if (!proof) {
						this.appendKernelDiagnostic(
							`Windows Job cleanup retained uncertainty for ${frame.targetPid}: ` +
								`leaderDead=${frame.leaderDead}, jobEmpty=${frame.jobEmpty}`,
						);
						return false;
					}
					this.windowsHeldJobEmptyProofs.set(control.lineage.kernelLineage, control.lineage);
					this.retireWindowsHeldJobAuthorities(control.lineage);
					return true;
				}
			} catch (error) {
				this.appendKernelDiagnostic(`Windows persistent REPL proof stream failed: ${String(error)}`);
				return false;
			}
		})();
	}

	private async waitForWindowsPersistentReplProof(
		control: WindowsPersistentReplControl,
		timeoutMs = WINDOWS_REPL_CLEANUP_TIMEOUT_MS,
	): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				control.doneProof,
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async doStartWindowsPersistentRepl(options: {
		generation: number;
		launchTrigger: "kernel-start" | "kernel-restart" | "kernel-repair";
		python: string;
		environment: NodeJS.ProcessEnv;
		targetIdentity: ReturnType<typeof createProcessIdentityOwnerToken>;
		admissionGeneration: string;
		kernelLineage: string;
	}): Promise<void> {
		const expected: WindowsPersistentReplExpectedIdentity = {
			admissionGeneration: options.admissionGeneration,
			targetToken: options.targetIdentity.argument,
		};
		let launch: Awaited<ReturnType<typeof prepareWindowsPersistentReplHelperLaunch>> | undefined;
		let child: ChildProcess | undefined;
		let controlInput: Writable | undefined;
		let frames: WindowsPersistentReplFrameStream | undefined;
		let control: WindowsPersistentReplControl | undefined;
		let candidate: ActiveOrphanProcessCandidate | undefined;
		let observation: KernelProcessObservation | undefined;
		try {
			launch = await prepareWindowsPersistentReplHelperLaunch();
			if (this.startStale(options.generation)) throw new Error("Kernel start superseded");
			child = spawn(launch.python, launch.args, {
				cwd: launch.cwd,
				env: launch.env,
				detached: false,
				shell: false,
				// fd0/1/2 are the target data plane. Anonymous fd3/fd4 are the
				// exact helper's authority plane and are excluded from target HANDLE_LIST.
				stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.child = child;
			await waitForChildSpawn(child);
			if (!child.pid) throw new Error("Windows persistent REPL helper did not expose a pid");
			if (this.startStale(options.generation)) throw new Error("Kernel was disposed during startup");

			const helperStdio = child.stdio as Array<Readable | Writable | null | undefined>;
			const input = helperStdio[WINDOWS_PERSISTENT_REPL_CONTROL_INPUT_FD];
			const output = helperStdio[WINDOWS_PERSISTENT_REPL_CONTROL_OUTPUT_FD];
			if (!(input instanceof Writable) || !(output instanceof Readable)) {
				throw new Error("Windows persistent REPL helper anonymous control pipes are unavailable");
			}
			controlInput = input;
			frames = new WindowsPersistentReplFrameStream(output, expected);

			await writeWindowsPersistentReplControl(controlInput, {
				version: WINDOWS_PERSISTENT_REPL_PROTOCOL_VERSION,
				admissionGeneration: expected.admissionGeneration,
				targetToken: expected.targetToken,
				ownerPid: process.pid,
				argv: [options.python, "-m", "rlm.repl"],
				cwd: this.options.cwd ?? process.cwd(),
				env: options.environment,
			});
			const pendingFrame = await frames.next(["target-pending", "error"], WINDOWS_REPL_ADMISSION_TIMEOUT_MS);
			if (pendingFrame.type === "error") {
				throw new Error(`Windows persistent REPL helper ${pendingFrame.stage}: ${pendingFrame.message}`);
			}
			if (pendingFrame.type !== "target-pending") {
				throw new Error("Windows persistent REPL helper omitted its suspended target identity");
			}
			if (this.startStale(options.generation)) throw new Error("Kernel start superseded");

			const lineage: KernelAdmissionLineage = {
				admissionGeneration: options.admissionGeneration,
				kernelLineage: options.kernelLineage,
				kernelPid: pendingFrame.targetPid,
				kernelProcessStartId: pendingFrame.processStartId,
			};
			this.kernelProcessPid = pendingFrame.targetPid;
			this.kernelAdmissionLineage = lineage;
			this.windowsTargetsAwaitingJobEmptyProof.set(lineage.kernelLineage, lineage);
			observation = this.beginKernelProcessObservation();

			const partialControl: Omit<WindowsPersistentReplControl, "doneProof"> = {
				child,
				expected,
				target: pendingFrame,
				lineage,
				input: controlInput,
				frames,
				closeControl: () => {
					controlInput?.destroy();
					frames?.destroy();
				},
				terminationRequested: false,
			};
			const doneProof = this.observeWindowsPersistentReplDone(partialControl, observation);
			control = { ...partialControl, doneProof };
			this.windowsPersistentReplControl = control;
			this.readyDeferred = createDeferred<number>();
			this.startupProtocolError = undefined;
			this.wireChild(child, observation, control);

			candidate = enrollOrphanProcess(
				pendingFrame.targetPid,
				lineage.kernelPid,
				pendingFrame.processStartId,
				lineage,
			);
			this.kernelOrphanCandidates.set(trackedOrphanCandidateKey(candidate), candidate);
			if (
				!candidate.processStartId ||
				!isExactProcessStartId(candidate.processStartId) ||
				candidate.processStartId !== pendingFrame.processStartId
			) {
				throw new Error("Windows persistent REPL identity changed before durable enrollment");
			}
			recordProcessLifecycle("kernel_process_start", { ...observation.details, trigger: options.launchTrigger });

			await writeWindowsPersistentReplControl(controlInput, this.windowsControlRecord(control, "target-ack"));
			const released = await frames.next(["target-released", "error"], WINDOWS_REPL_ADMISSION_TIMEOUT_MS);
			if (released.type === "error") {
				throw new Error(`Windows persistent REPL helper ${released.stage}: ${released.message}`);
			}
			if (released.type !== "target-released") {
				throw new Error("Windows persistent REPL helper did not confirm target release");
			}

			const protocol = await this.waitForReady(child);
			if (this.startStale(options.generation)) throw new Error("Kernel start superseded");
			if (this.startupProtocolError) throw this.startupProtocolError;
			if (protocol !== REPL_PROTOCOL_VERSION) {
				throw new Error(
					`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION}. ` +
						"Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent.",
				);
			}
			this.state = "running";
			recordProcessLifecycle(
				"kernel_process_ready",
				this.kernelLifecycleDetails({
					durationMs: Date.now() - (this.kernelLaunchStartedAt ?? Date.now()),
				}),
			);
		} catch (error) {
			if (observation) observation.expected = true;
			let exactJobEmpty = false;
			if (control) {
				await this.requestWindowsPersistentReplTermination(control);
				child?.stdin?.destroy();
				// A host timeout is not an authority result. Keep this exact helper,
				// Job, process handle, and fd3/fd4 stream alive for the next cleanup try.
				exactJobEmpty = await this.waitForWindowsPersistentReplProof(control);
			} else {
				controlInput?.destroy();
				frames?.destroy();
				if (child) {
					try {
						child.kill("SIGKILL");
					} catch {
						// No target identity was published; helper exit closes any setup Job.
					}
					await waitForChildExit(child, WINDOWS_REPL_CLEANUP_TIMEOUT_MS);
				}
			}
			const cleanupLineage = control?.lineage ?? this.kernelAdmissionLineage;
			if (cleanupLineage !== undefined) {
				this.kernelPidsAwaitingDescendantCleanup.set(cleanupLineage.kernelLineage, cleanupLineage);
				if (exactJobEmpty) await this.retireCleanupProvenKernelAuthorities();
			}
			if (exactJobEmpty && control) {
				control.closeControl();
				if (this.windowsPersistentReplControl === control) this.windowsPersistentReplControl = undefined;
			}
			if (this.child === child) this.child = undefined;
			liveKernels.delete(this);
			if (!this.startStale(options.generation)) this.state = "idle";
			throw error;
		}
	}

	private async doStart(_startOptions: KernelStartOptions): Promise<void> {
		if (this.state !== "idle") return;
		const retainedWindowsControl = this.windowsPersistentReplControl;
		if (retainedWindowsControl) {
			await this.requestWindowsPersistentReplTermination(retainedWindowsControl);
			if (!(await this.waitForWindowsPersistentReplProof(retainedWindowsControl))) {
				throw new Error("Prior Windows kernel cleanup is not yet proven; refusing to start a replacement");
			}
			if (!(await this.retireCleanupProvenKernelAuthorities())) {
				throw new Error("Prior Windows kernel authority is not yet retired; refusing to start a replacement");
			}
			retainedWindowsControl.closeControl();
			if (this.windowsPersistentReplControl === retainedWindowsControl) {
				this.windowsPersistentReplControl = undefined;
			}
		}
		if (this.pendingGatedStartupChild && !(await this.reapPendingGatedStartupChild())) {
			throw new Error("Prior gated kernel cleanup is not yet proven; refusing to start a replacement");
		}
		if (
			(this.kernelOrphanCandidates.size > 0 || this.kernelPidsAwaitingDescendantCleanup.size > 0) &&
			!(await this.retireCleanupProvenKernelAuthorities())
		) {
			throw new Error("Prior kernel cleanup is not yet proven; refusing to start a replacement");
		}
		if (this.state !== "idle") return;
		const generation = ++this.startGeneration;
		this.state = "starting";
		const launchTrigger = this.nextLaunchTrigger;
		this.nextLaunchTrigger = "kernel-start";
		this.kernelInstanceId = uuid();
		this.kernelChildProcessInstanceId = undefined;
		this.kernelProcessPid = undefined;
		this.kernelProcessGroupPid = undefined;
		this.kernelAdmissionLineage = undefined;
		this.kernelExit = undefined;
		this.kernelObservation = undefined;
		this.kernelLaunchStartedAt = Date.now();
		this.kernelStderr = "";
		installSignalHandlersOnce();
		// Tracked from the moment startup begins so session cleanup and signal
		// handlers can dispose a kernel that is still booting.
		liveKernels.add(this);

		let python: string;
		try {
			// Admission must never execute a configured interpreter as a readiness
			// probe. Installation remains a separate bootstrap lane.
			python = resolveReplPythonWithoutExecution(this.options.python);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			this.options.python = python;
		} catch (error) {
			if (this.startStale(generation)) throw error; // never touch a newer start's state
			liveKernels.delete(this);
			if ((this.state as string) !== "shutdown") this.state = "idle";
			throw error;
		}

		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel was disposed during startup");
		}

		this.kernelChildProcessInstanceId = createObservedProcessInstanceId();
		const environment = withoutProcessLifecycleEnvironment({ ...process.env, ...this.options.env });
		delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
		delete environment[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		delete environment[KERNEL_ADMISSION_GENERATION_ENV];
		delete environment[KERNEL_LINEAGE_ENV];
		delete environment[KERNEL_PID_ENV];
		delete environment[KERNEL_PROCESS_START_ID_ENV];
		const journalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const journalGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		if (!journalPath || !journalGeneration) {
			liveKernels.delete(this);
			this.state = "idle";
			throw new Error("Kernel admission requires an explicit durable orphan process journal authority");
		}
		if (!supportsExactProcessIdentityPlatform()) {
			liveKernels.delete(this);
			this.state = "idle";
			throw new Error(`Kernel admission exact-identity probe unavailable: unsupported platform ${process.platform}`);
		}
		environment[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		environment[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = journalGeneration;
		environment.PRIME_AGENT_KERNEL_OWNER_PID = String(process.pid);
		// bash() puts this parent-issued marker in each gated shell argv. On
		// macOS it upgrades lstart from a coarse hint to an exact journal identity.
		// Keep the trailing space: `ps` escapes the following newline as `\012`,
		// while the identity parser requires an actual delimiter after the token.
		const bashOwnerIdentity = createProcessIdentityOwnerToken();
		const configuredBashPrefix = environment.PRIME_AGENT_BASH_COMMAND_PREFIX;
		environment.PRIME_AGENT_BASH_COMMAND_PREFIX = [`: # ${bashOwnerIdentity.argument} `, configuredBashPrefix]
			.filter((value): value is string => Boolean(value))
			.join("\n");

		const targetIdentity = createProcessIdentityOwnerToken();
		const admissionGeneration = uuid();
		const kernelLineage = createKernelLineage();
		environment[KERNEL_ADMISSION_GENERATION_ENV] = admissionGeneration;
		environment[KERNEL_ADMISSION_PROTOCOL_ENV] = String(PROCESS_STARTUP_CONTROL_VERSION);
		environment[KERNEL_LINEAGE_ENV] = kernelLineage;
		if (process.platform === "win32") {
			await this.doStartWindowsPersistentRepl({
				generation,
				launchTrigger,
				python,
				environment,
				targetIdentity,
				admissionGeneration,
				kernelLineage,
			});
			return;
		}
		let child: ChildProcess;
		try {
			child = spawn(
				process.execPath,
				["-e", REPL_PROCESS_STARTUP_GATE_SOURCE, targetIdentity.argument, admissionGeneration],
				{
					detached: true,
					env: minimalStartupGateEnvironment(process.env),
					stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
				},
			);
			this.child = child;
			await waitForChildSpawn(child);
			if (this.startStale(generation)) throw new Error("Kernel was disposed during startup");
		} catch (error) {
			liveKernels.delete(this);
			if (!this.startStale(generation)) this.state = "idle";
			throw error;
		}
		if (!child.pid) {
			child.stdio?.[PROCESS_STARTUP_ACK_FD]?.destroy();
			child.stdio?.[PROCESS_STARTUP_CONFIG_FD]?.destroy();
			(child.stdio as Array<Readable | Writable | null | undefined>)[PROCESS_STARTUP_CONTROL_FD]?.destroy();
			child.kill("SIGKILL");
			await waitForChildExit(child, 5000);
			if (child.exitCode === null && child.signalCode === null) {
				throw new Error("Gated kernel has no pid and its cleanup could not be proven");
			}
			this.child = undefined;
			liveKernels.delete(this);
			if (!this.startStale(generation)) this.state = "idle";
			throw new Error("Failed to obtain gated kernel pid");
		}

		this.kernelProcessPid = child.pid;
		this.kernelProcessGroupPid = child.pid;
		let candidate: ActiveOrphanProcessCandidate = { pid: child.pid };
		const observation = this.beginKernelProcessObservation();
		recordProcessLifecycle("kernel_process_start", { ...observation.details, trigger: launchTrigger });
		try {
			if (!(child.stdio[PROCESS_STARTUP_ACK_FD] instanceof Writable)) {
				throw new Error("Failed to create kernel startup acknowledgement pipe");
			}
			if (!(child.stdio[PROCESS_STARTUP_CONFIG_FD] instanceof Writable)) {
				throw new Error("Failed to create kernel startup configuration pipe");
			}
			if (
				!(
					(child.stdio as Array<Readable | Writable | null | undefined>)[PROCESS_STARTUP_CONTROL_FD] instanceof
					Readable
				)
			) {
				throw new Error("Failed to create kernel startup control pipe");
			}
		} catch (error) {
			const exactDead = await this.abortGatedChildAndProveDeath(child, candidate, observation);
			liveKernels.delete(this);
			if (!this.startStale(generation)) this.state = "idle";
			if (!exactDead) {
				this.appendKernelDiagnostic("gated kernel cleanup remains under durable orphan authority");
			}
			throw error;
		}

		const pendingExpected: GatedTargetPending = {
			targetPid: child.pid,
			admissionGeneration,
			targetToken: targetIdentity.argument,
		};
		const pending = observeGatedTargetPending(child, pendingExpected);
		// A concurrent teardown can destroy the pipes before the main startup
		// path reaches its await; keep that gate rejection handled in the interim.
		pending.catch(() => undefined);
		const gatedLaunch: GatedProcessLaunch = {
			primeAgentStartupGate: PROCESS_STARTUP_CONTROL_VERSION,
			admissionGeneration,
			targetToken: targetIdentity.argument,
			kernelLineage,
			command: python,
			args: ["-m", "rlm.repl"],
			cwd: this.options.cwd ?? process.cwd(),
			env: environment,
		};

		try {
			await writeAndCloseStartupPipe(
				child.stdio[PROCESS_STARTUP_CONFIG_FD] as Writable,
				JSON.stringify(gatedLaunch),
			);
			const targetPending = await pending;
			if (this.startStale(generation)) throw new Error("Kernel start superseded");

			// This is the exact future Python PID. The gate cannot exec until the
			// durable enrollment below completes and its exact acknowledgement arrives.
			const targetProcessIdentity = observeProcessIdentity(targetPending.targetPid);
			if (targetProcessIdentity.status !== "present-exact") {
				throw new Error("Kernel admission exact-identity probe unavailable for gated process");
			}
			if (process.platform === "darwin" && targetProcessIdentity.id !== targetIdentity.processStartId) {
				throw new Error("Gated kernel identity changed before target admission");
			}
			const lineage: KernelAdmissionLineage = {
				admissionGeneration,
				kernelLineage,
				kernelPid: targetPending.targetPid,
				kernelProcessStartId: targetProcessIdentity.id,
			};
			this.kernelAdmissionLineage = lineage;
			candidate = enrollOrphanProcess(
				targetPending.targetPid,
				lineage.kernelPid,
				lineage.kernelProcessStartId,
				lineage,
			);
			this.kernelOrphanCandidates.set(trackedOrphanCandidateKey(candidate), candidate);
			if (!candidate.processStartId || !isExactProcessStartId(candidate.processStartId)) {
				throw new Error("Kernel admission exact-identity probe unavailable for gated process");
			}

			this.readyDeferred = createDeferred<number>();
			this.startupProtocolError = undefined;
			this.wireChild(child, observation);
			await writeAndCloseStartupPipe(
				child.stdio[PROCESS_STARTUP_ACK_FD] as Writable,
				`${JSON.stringify({
					primeAgentStartupGate: PROCESS_STARTUP_CONTROL_VERSION,
					type: "target-ack",
					admissionGeneration,
					targetToken: targetIdentity.argument,
					targetPid: targetPending.targetPid,
					kernelLineage: lineage.kernelLineage,
					kernelProcessStartId: lineage.kernelProcessStartId,
				})}\n`,
			);

			const protocol = await this.waitForReady(child);
			if (this.startStale(generation)) throw new Error("Kernel start superseded");
			// Ready and a corrupt frame can share one stdout chunk: ready resolved the
			// deferred synchronously before the corruption was parsed, so the rejection
			// in failProtocolFrame was a no-op. Never mark such a child running.
			if (this.startupProtocolError) throw this.startupProtocolError;
			if (protocol !== REPL_PROTOCOL_VERSION) {
				throw new Error(
					`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION}. ` +
						"Update prime-agent-runtime in the kernel Python (PRIME_AGENT_KERNEL_PYTHON) to match this prime-agent.",
				);
			}
		} catch (error) {
			if (this.startStale(generation)) {
				throw new Error("Kernel was disposed during startup", { cause: error });
			}
			const canRetryStartup = (this.state as string) !== "shutdown";
			const performedCleanup = await this.shutdown();
			const exactDead = await this.abortGatedChildAndProveDeath(child, candidate, observation);
			if (!exactDead) {
				this.appendKernelDiagnostic("gated kernel cleanup remains under durable orphan authority");
			}
			if (performedCleanup && canRetryStartup) this.state = "idle";
			throw error;
		}

		this.state = "running";
		recordProcessLifecycle(
			"kernel_process_ready",
			this.kernelLifecycleDetails({
				durationMs: Date.now() - (this.kernelLaunchStartedAt ?? Date.now()),
			}),
		);
	}

	/** True when a teardown (or newer start) superseded the start that captured `generation`. */
	private startStale(generation: number): boolean {
		return generation !== this.startGeneration;
	}

	private wireChild(
		child: ChildProcess,
		observation: KernelProcessObservation = this.kernelObservation ?? this.beginKernelProcessObservation(),
		windowsControl?: WindowsPersistentReplControl,
	): void {
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		let pendingProtocolBytes = 0;
		child.stdout?.on("data", (buf: Buffer) => {
			if (this.child !== child) return;
			let byteOffset = 0;
			while (byteOffset < buf.length) {
				const newlineOffset = buf.indexOf(0x0a, byteOffset);
				const segmentEnd = newlineOffset < 0 ? buf.length : newlineOffset;
				pendingProtocolBytes += segmentEnd - byteOffset;
				if (pendingProtocolBytes > REPL_PROTOCOL_MAX_PENDING_BYTES) {
					this.failProtocolFrame(child, "protocol line exceeded its raw byte bound");
					return;
				}
				if (newlineOffset < 0) break;
				pendingProtocolBytes = 0;
				byteOffset = newlineOffset + 1;
			}
			buffered += decoder.write(buf);
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line.trim()) continue;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					this.failProtocolFrame(child, `unparseable protocol line: ${line.slice(0, 200)}`);
					return;
				}
				if (!isRecord(event)) {
					this.failProtocolFrame(child, `non-object protocol line: ${line.slice(0, 200)}`);
					return;
				}
				const invalidReason = invalidProtocolFrameReason(event);
				if (invalidReason) {
					this.failProtocolFrame(child, `${invalidReason}: ${line.slice(0, 200)}`);
					return;
				}
				this.handleEvent(event);
			}
		});

		child.stderr?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			observation.stderrTail = boundedUtf8Tail(`${observation.stderrTail}${text}`, KERNEL_STDERR_TAIL_MAX_BYTES);
			if (this.kernelObservation === observation) {
				this.kernelStderr = boundedUtf8Tail(`${this.kernelStderr}${text}`, KERNEL_STDERR_TAIL_MAX_BYTES);
			}
		});

		child.on("error", (err) => {
			if (this.child !== child) return;
			this.appendKernelDiagnostic(`child process error: ${err.message}`);
			if (this.state === "starting") {
				this.startupProtocolError = err;
				this.readyDeferred?.reject(err);
				return;
			}
			if (this.state === "running" && this.teardownInFlight === 0) {
				this.rejectActiveExecution(
					createUncertainRequestError("The Python kernel process reported a transport error", err),
				);
				this.beginKernelRepair(child, "child-process-error", err);
				return;
			}
			this.state = "shutdown";
			liveKernels.delete(this);
			this.cleanupResources();
		});

		child.on("exit", (code, signal) => {
			if (windowsControl) {
				// A helper exit is never tree-death proof. Drain the private authority
				// stream first; only a bound held-Job-empty frame can unblock repair.
				void windowsControl.doneProof.then(() => {
					windowsControl.closeControl();
					this.handleKernelChildExit(
						child,
						observation,
						this.kernelExit?.code ?? code,
						this.kernelExit?.signal ?? signal,
						"windows-helper-exit",
						false,
					);
				});
				return;
			}
			this.handleKernelChildExit(child, observation, code, signal, "child-process-exit");
		});
	}

	private handleKernelChildExit(
		child: ChildProcess,
		observation: KernelProcessObservation,
		code: number | null,
		signal: NodeJS.Signals | null,
		observationSource: string,
		recordObservedExit = true,
	): void {
		if (recordObservedExit) this.recordKernelProcessExit(code, signal, observationSource, observation);
		const candidate = child.pid === undefined ? undefined : this.findTrackedKernelCandidate(child.pid);
		if (candidate) {
			try {
				if (retireOrphanProcess(candidate)) {
					this.kernelOrphanCandidates.delete(trackedOrphanCandidateKey(candidate));
				}
			} catch (error) {
				this.appendKernelDiagnostic(`failed to retire kernel process authority: ${String(error)}`);
			}
		}
		if (this.child !== child) return;
		const unexpected = !observation.expected;
		if (unexpected) this.appendKernelDiagnostic(`unexpected exit code=${code} signal=${signal}`);
		if (unexpected && this.state === "starting") {
			this.kernelExit = { code, signal };
			const tail = this.kernelStderr.slice(-1024);
			const startupError = new Error(`Kernel exited before ready. stderr:\n${tail || "(empty)"}`);
			this.startupProtocolError = startupError;
			this.readyDeferred?.reject(startupError);
			return;
		}
		if (unexpected && this.state === "running" && this.teardownInFlight === 0) {
			this.rejectActiveExecution(
				createUncertainRequestError(`The Python kernel exited unexpectedly (code=${code}, signal=${signal})`),
			);
			this.beginKernelRepair(child, "unexpected-exit");
			return;
		}
		this.state = "shutdown";
		liveKernels.delete(this);
		// This exit is part of an in-flight graceful shutdown(): that call owns the
		// teardown and runs cleanupResources itself. Cleaning up here would bump the
		// generation and misread the owning shutdown as superseded.
		if (this.gracefulShutdownGeneration === this.startGeneration) return;
		this.cleanupResources();
	}

	private failProtocolFrame(child: ChildProcess, diagnostic: string): void {
		if (this.child !== child) return;
		this.appendKernelDiagnostic(diagnostic);
		const error =
			this.state === "running"
				? createUncertainRequestError(`Kernel protocol error: ${diagnostic}`)
				: new Error(`Kernel protocol error: ${diagnostic}`);
		if (this.state === "starting") this.startupProtocolError = error;
		this.readyDeferred?.reject(error);
		this.rejectActiveExecution(error);
		if (this.teardownInFlight > 0 || this.state !== "running") return;
		this.beginKernelRepair(child, "protocol-corruption");
	}

	private beginKernelRepair(child: ChildProcess, reason: KernelRepairReason, failure?: unknown): void {
		if (this.child !== child || this.state !== "running" || this.teardownInFlight > 0) return;
		if (this.protocolRepairOwner) {
			// A repair's own replacement failed: discard it instead of respawn-looping.
			this.appendKernelDiagnostic(`replacement kernel failed during ${reason} repair; giving up`);
			this.protocolRepairOwner.superseded = true;
			// performRestore clears pendingRestore, so it still being set means the
			// failure struck at or before the restore phase. The snapshot stays the
			// prime suspect and is not retried automatically.
			const snapshotSuspect = this.pendingRestore;
			this.killChildToIdle();
			if (snapshotSuspect) this.pendingRestore = false;
			return;
		}

		const owner = { superseded: false };
		const repairAttemptId = uuid();
		const previousKernelInstanceId = this.kernelInstanceId;
		this.protocolRepairOwner = owner;
		recordProcessLifecycle(
			"kernel_repair",
			this.kernelLifecycleDetails({
				phase: "requested",
				reason,
				repairAttemptId,
				previousKernelInstanceId,
				...(failure === undefined ? {} : { error: lifecycleError(failure) }),
			}),
		);
		const repair = this.repairProtocolChild(child, owner);
		this.protocolRepairPromise = repair;
		void repair.then(
			() => {
				const phase =
					this.state === "running" && !owner.superseded
						? "completed"
						: this.state === "shutdown"
							? "superseded"
							: "failed";
				recordProcessLifecycle(
					"kernel_repair",
					this.kernelLifecycleDetails({ phase, reason, repairAttemptId, previousKernelInstanceId }),
				);
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
			(repairError) => {
				this.appendKernelDiagnostic(`kernel repair failed: ${errorMessage(repairError)}`);
				recordProcessLifecycle(
					"kernel_repair",
					this.kernelLifecycleDetails({
						phase: "failed",
						reason,
						repairAttemptId,
						previousKernelInstanceId,
						error: lifecycleError(repairError),
					}),
				);
				if (this.protocolRepairPromise === repair) this.protocolRepairPromise = undefined;
				if (this.protocolRepairOwner === owner) this.protocolRepairOwner = undefined;
			},
		);
	}

	private async repairProtocolChild(child: ChildProcess, owner: { superseded: boolean }): Promise<void> {
		if (this.child !== child || this.state === "shutdown") return;
		const windowsControl =
			this.windowsPersistentReplControl?.child === child ? this.windowsPersistentReplControl : undefined;
		this.killChildToIdle();
		if (windowsControl) {
			const exactJobEmpty = await this.waitForWindowsPersistentReplProof(windowsControl);
			if (
				!exactJobEmpty ||
				!(await this.retireCleanupProvenKernelAuthorities()) ||
				owner.superseded ||
				(this.state as string) === "shutdown"
			) {
				return;
			}
		}

		const start = this.start();
		try {
			await start;
		} catch (error) {
			this.finishFailedProtocolRepair(owner, error);
			return;
		}
		// doStart performs an async prior-authority proof before it claims a new
		// generation, so capture only after this exact replacement is running.
		const generation = this.startGeneration;
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}

		const restored = await this.performRestore(true);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (this.options.snapshot && restored === null) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair restore failed; discarding replacement kernel");
			this.killChildToIdle();
			// The snapshot is the declared culprit; the lazy path must not retry it.
			this.pendingRestore = false;
			return;
		}

		// Restore revives only the user namespace; live handles (rlm, bash, skills)
		// come from the runtime bootstrap, so a repaired kernel must re-run it.
		if (!this.options.bootstrapCode) return;
		const bootstrapped = await this.bootstrapRepairedKernel(this.options.bootstrapCode);
		if (this.startStale(generation) || (this.state as string) !== "running") {
			this.finishFailedProtocolRepair(owner);
			return;
		}
		if (!bootstrapped) {
			if (owner.superseded || this.protocolRepairOwner !== owner) return;
			this.appendKernelDiagnostic("protocol repair bootstrap failed; discarding replacement kernel");
			this.killChildToIdle();
		}
	}

	/** Bounded bootstrap of a repaired kernel; false when it failed. Never throws. */
	private async bootstrapRepairedKernel(code: string): Promise<boolean> {
		try {
			const r = await this.enqueueRequest(
				{ type: "execute", code },
				code,
				{ internal: true, protocolRepair: true },
				REPAIR_STEP_TIMEOUT_MS,
			);
			if (r.status !== "ok") {
				this.appendKernelDiagnostic(
					`protocol repair bootstrap ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return false;
			}
			this.pendingRebootstrap = false;
			return true;
		} catch (error) {
			this.appendKernelDiagnostic(`protocol repair bootstrap error: ${errorMessage(error)}`);
			return false;
		}
	}

	/**
	 * A fresh kernel started after a discarded repair has none of the runtime
	 * bootstrap's live handles (rlm, bash, skills) and an empty namespace:
	 * reprovision (restore, then bootstrap) before any user request. A failed
	 * re-bootstrap discards the kernel again instead of serving user code on an
	 * unprovisioned namespace.
	 */
	private async ensureKernelRebootstrapped(signal?: AbortSignal): Promise<void> {
		const code = this.options.bootstrapCode;
		const needsRestore = Boolean(this.options.snapshot) && this.pendingRestore;
		const needsBootstrap = Boolean(code) && this.pendingRebootstrap;
		// An in-flight repair owns its kernel's restore/bootstrap sequence, and
		// a teardown's final snapshot must never trigger reprovisioning.
		if (
			(!needsRestore && !needsBootstrap) ||
			this.protocolRepairPromise ||
			this.teardownInFlight > 0 ||
			this.state !== "running"
		) {
			return;
		}
		let task = this.rebootstrapPromise;
		if (!task) {
			const started = this.reprovisionFreshKernel(code);
			task = started;
			this.rebootstrapPromise = started;
			void started.finally(() => {
				if (this.rebootstrapPromise === started) this.rebootstrapPromise = undefined;
			});
		}
		// An aborted request never executes, so it may skip the wait; race the
		// signal like waitForProtocolRepair does instead of riding out the
		// bootstrap bound after a mid-wait abort.
		if (signal) {
			if (signal.aborted) return;
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([task, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			if (signal.aborted) return;
		}
		const ok = await task; // bounded by REPAIR_STEP_TIMEOUT_MS
		if (!ok) throw new Error("Kernel bootstrap failed after protocol repair");
	}

	/** Restore (one-shot, best-effort) then bootstrap the lazily started fresh kernel. */
	private async reprovisionFreshKernel(code: string | undefined): Promise<boolean> {
		if (this.options.snapshot && this.pendingRestore) {
			await this.performRestore(true); // clears pendingRestore on success
			// Corrupted during the restore: the spawned repair owns the kernel now.
			if (this.protocolRepairPromise || this.state !== "running") return false;
			// One attempt per discard: a clean restore failure falls back to an
			// empty namespace (ordinary startup semantics), never a retry loop.
			this.pendingRestore = false;
		}
		if (!code || !this.pendingRebootstrap) return true;
		const ok = await this.bootstrapRepairedKernel(code);
		if (!ok && this.state === "running") this.killChildToIdle();
		return ok;
	}

	/** Kill the current child and settle at clean idle, so the next start spawns fresh. */
	private killChildToIdle(): void {
		this.markKernelExitExpected();
		this.nextLaunchTrigger = "kernel-repair";
		// The discarded kernel carried the runtime bootstrap and (possibly) the
		// restored namespace; a lazily started replacement must reprovision both.
		this.pendingRebootstrap = true;
		this.pendingRestore = true;
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources("SIGKILL");
		this.state = "idle";
	}

	private finishFailedProtocolRepair(owner: { superseded: boolean }, error?: unknown): void {
		if (error) this.appendKernelDiagnostic(`protocol repair start failed: ${errorMessage(error)}`);
		if (owner.superseded || this.protocolRepairOwner !== owner) return;
		if (this.state === "shutdown") this.state = "idle";
	}

	private supersedeProtocolRepair(): void {
		if (this.protocolRepairOwner) this.protocolRepairOwner.superseded = true;
	}

	/** Wait until no protocol repair is pending; resolves early when the signal aborts. */
	private async waitForProtocolRepair(signal?: AbortSignal): Promise<void> {
		while (this.protocolRepairPromise && !signal?.aborted) {
			const repair = this.protocolRepairPromise;
			if (!signal) {
				await repair;
				continue;
			}
			let onAbort: () => void = () => {};
			const aborted = new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([repair, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	private async waitForReady(child: ChildProcess): Promise<number> {
		const ready = this.readyDeferred;
		if (!ready) throw new Error("Kernel ready state is missing");
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		let onExit: (() => void) | undefined;
		try {
			return await new Promise<number>((resolve, reject) => {
				ready.promise.then(resolve, reject);
				onExit = () => {
					const tail = this.kernelStderr.slice(-1024);
					reject(new Error(`Kernel exited before ready. stderr:\n${tail || "(empty)"}`));
				};
				if (child.exitCode !== null || child.signalCode !== null) {
					onExit();
					return;
				}
				child.once("exit", onExit);
				timeout = globalThis.setTimeout(() => {
					const tail = this.kernelStderr.slice(-1024);
					reject(
						new Error(
							`Kernel did not become ready within ${READY_TIMEOUT_MS}ms. stderr tail:\n${tail || "(empty)"}`,
						),
					);
				}, READY_TIMEOUT_MS);
				timeout.unref?.();
			});
		} finally {
			if (timeout) globalThis.clearTimeout(timeout);
			if (onExit) child.removeListener("exit", onExit);
		}
	}

	/** Write one JSON-lines request frame; resolves when the OS accepted the bytes. */
	private writeLine(request: Record<string, unknown>): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) {
			return Promise.reject(new Error("Kernel stdin is not connected"));
		}
		return new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(request)}\n`, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.event;
		if (type === "ready") {
			this.readyDeferred?.resolve(typeof event.protocol === "number" ? event.protocol : -1);
			return;
		}
		if (type === "host_request") {
			if (typeof event.id === "string") this.startHostRequest(event.id, event.data);
			return;
		}

		const id = typeof event.id === "string" ? event.id : undefined;
		const execution = this.activeExecution;
		if (!execution || id !== execution.requestId) {
			if (type === "display" && isRecord(event.data)) {
				this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME]);
			} else if (type === "stdout" || type === "stderr") {
				// Unowned output (null id, or another cell's id): never merge it into
				// the active cell's streams; buffer it as background output instead.
				this.appendBackgroundOutput(typeof event.text === "string" ? event.text : "");
			} else if (type === "done" && id) {
				const waiter = this.pendingDoneWaiters.get(id);
				this.pendingDoneWaiters.delete(id);
				waiter?.();
			} else if (type === "error" && id === undefined) {
				this.appendKernelDiagnostic(`protocol error: ${String(event.evalue ?? "")}`);
			}
			return;
		}

		if (execution.settled && type === "display" && isRecord(event.data)) {
			if (this.dispatchLateSentAgentMessage(id, event.data[AGENT_MESSAGE_DISPLAY_MIME])) {
				return;
			}
		}
		if (type === "stdout" || type === "stderr") {
			const text = typeof event.text === "string" ? event.text : "";
			if (type === "stdout") {
				if (execution.stdout.length < execution.maxChars) {
					execution.stdout += text;
					if (execution.stdout.length > execution.maxChars) {
						execution.stdout = execution.stdout.slice(0, execution.maxChars);
						execution.stdoutTruncated = true;
					}
				}
			} else {
				if (execution.stderr.length < execution.maxChars) {
					execution.stderr += text;
					if (execution.stderr.length > execution.maxChars) {
						execution.stderr = execution.stderr.slice(0, execution.maxChars);
						execution.stderrTruncated = true;
					}
				}
			}
			execution.opts.onStream?.(text, type);
		} else if (type === "result") {
			if (typeof event.text === "string") execution.result = event.text;
		} else if (type === "display") {
			const data = isRecord(event.data) ? event.data : {};
			const diff = parseDiffDisplay(data[DIFF_DISPLAY_MIME]);
			if (diff) execution.diffs.push(diff);
			const attachment = parseAttachmentDisplay(data[ATTACHMENT_DISPLAY_MIME]);
			if (attachment === "oversized") {
				execution.stderr += `${execution.stderr ? "\n" : ""}attachment dropped: exceeds ${MAX_ATTACHMENT_DATA_CHARS} base64 chars`;
				execution.status = "error";
			} else if (attachment) {
				execution.attachments.push(attachment);
			}
			const sentAgentMessage = parseSentAgentMessage(data[AGENT_MESSAGE_DISPLAY_MIME]);
			if (sentAgentMessage) execution.sentAgentMessages.push(sentAgentMessage);
		} else if (type === "error") {
			execution.error = {
				ename: typeof event.ename === "string" ? event.ename : "Error",
				evalue: typeof event.evalue === "string" ? event.evalue : "",
				traceback: asStringArray(event.traceback),
			};
			execution.status = "error";
		} else if (type === "done") {
			execution.doneFields = event;
			if (event.status !== "ok" && execution.status === "ok") {
				execution.status = "error";
				// State requests report failures as a done reason without an error event.
				if (!execution.error && typeof event.reason === "string") {
					execution.error = { ename: "KernelError", evalue: event.reason, traceback: [] };
				}
			}
			this.finishActiveExecution(execution);
		}
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		await this.waitForProtocolRepair(opts.signal);
		const result = await this.enqueueExecute(code, opts);
		// Refresh the on-disk snapshot after real work so a later resume (or a
		// crash before graceful shutdown) revives the most recent namespace.
		if (result.status === "ok") {
			this.scheduleSnapshot();
		}
		return result;
	}

	/** Queue and run a cell, serializing against all other executions. */
	private async enqueueExecute(
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		return this.enqueueRequest({ type: "execute", code }, code, opts, executionTimeoutMs);
	}

	/** Queue one protocol request (execute or state op) behind every other request. */
	private async enqueueRequest(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		executionTimeoutMs?: number,
	): Promise<InternalExecuteResult> {
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		await this.start({ signal: opts.signal });
		if ((this.state as string) === "shutdown") {
			throw new Error("Kernel has been shut down");
		}
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}
		if (!opts.protocolRepair) await this.ensureKernelRebootstrapped(opts.signal);
		// Aborted while waiting on the re-bootstrap: settle now instead of parking
		// on the queue slot behind the still-running bootstrap.
		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
		}
		// Re-check: a final flush may have started while this request awaited the
		// lazy re-bootstrap; admitting it now would splice it between the flush's
		// captured queue and the final snapshot, unbounding the teardown.
		if (this.flushingSnapshotForDispose && !opts.internal) {
			throw new Error("Kernel is shutting down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		let executionTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		try {
			await this.waitForActiveExecutionToClearForReuse(opts.signal);
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			// A repair started while this request was queued or busy-waiting: release
			// the slot so the repair's own restore can run, then requeue behind it.
			if (this.protocolRepairPromise && !opts.protocolRepair) {
				resolveNext();
				await this.waitForProtocolRepair(opts.signal);
				return this.enqueueRequest(requestFields, code, opts, executionTimeoutMs);
			}
			if (executionTimeoutMs === undefined) {
				return await this.executeInner(requestFields, code, opts, started);
			}

			const controller = new AbortController();
			executionTimeout = globalThis.setTimeout(() => controller.abort(), executionTimeoutMs);
			executionTimeout.unref?.();
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			return await this.executeInner(requestFields, code, { ...opts, signal }, started);
		} finally {
			if (executionTimeout) globalThis.clearTimeout(executionTimeout);
			resolveNext();
		}
	}

	private async executeInner(
		requestFields: Record<string, unknown> & { type: string },
		code: string,
		opts: ExecuteOptions,
		started: number,
	): Promise<InternalExecuteResult> {
		const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const requestId = uuid();

		if (opts.signal?.aborted) {
			return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
		}
		if (this.activeExecution) {
			throw new Error("Kernel already has an active execution");
		}

		const result = createDeferred<InternalExecuteResult>();
		const execution: ActiveExecution = {
			requestId,
			code,
			started,
			maxChars,
			opts,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			diffs: [],
			attachments: [],
			sentAgentMessages: [],
			backgroundOutput: this.pendingBackgroundOutput,
			backgroundOutputTruncated: this.pendingBackgroundOutputTruncated,
			status: "ok",
			settled: false,
			resolve: result.resolve,
			reject: result.reject,
		};
		this.pendingBackgroundOutput = "";
		this.pendingBackgroundOutputTruncated = false;
		let abortTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		const clearAbortTimer = () => {
			if (abortTimer) {
				globalThis.clearTimeout(abortTimer);
				abortTimer = undefined;
			}
		};
		const forceAbort = () => {
			if (this.activeExecution !== execution) {
				return;
			}
			execution.status = "aborted";
			// The execution stays active until its done event arrives; clearing it
			// early would let a new cell race the interrupted one (see busy-after-interrupt).
			this.resolveExecution(execution, { clearActive: false });
		};
		const onAbort = () => {
			void this.interrupt().catch(() => undefined);
			clearAbortTimer();
			abortTimer = globalThis.setTimeout(forceAbort, KERNEL_ABORT_GRACE_MS);
			if (abortTimer && typeof abortTimer === "object" && "unref" in abortTimer) {
				abortTimer.unref();
			}
		};

		try {
			this.activeExecution = execution;
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts.signal?.aborted) {
				onAbort();
			}
			if (!opts.internal) {
				this.lastCellCode = code;
			}
			try {
				const child = this.child;
				const sendPromise = this.writeLine({ ...requestFields, id: requestId }).catch((error: unknown) => {
					if (child && this.activeExecution === execution) {
						const uncertainError = createUncertainRequestError(
							"Writing the request to the Python kernel failed",
							error,
						);
						this.rejectActiveExecution(uncertainError);
						this.beginKernelRepair(child, "request-write-failed", error);
						throw uncertainError;
					}
					throw error instanceof Error ? error : new Error(String(error));
				});
				sendPromise.catch(() => undefined);
				await Promise.race([sendPromise, result.promise.then(() => undefined)]);
				if (this.activeExecution === execution && execution.status !== "aborted") {
					await sendPromise;
				}
			} catch (error) {
				if (this.activeExecution === execution) {
					this.activeExecution = undefined;
					this.notifyActiveExecutionIdle();
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
			return await result.promise;
		} finally {
			clearAbortTimer();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	private appendBackgroundOutput(text: string): void {
		if (!text) return;
		const execution = this.activeExecution;
		if (execution) {
			if (execution.backgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutputTruncated = true;
				return;
			}
			execution.backgroundOutput += text;
			if (execution.backgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
				execution.backgroundOutput = execution.backgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
				execution.backgroundOutputTruncated = true;
			}
			return;
		}
		if (this.pendingBackgroundOutput.length >= MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutputTruncated = true;
			return;
		}
		this.pendingBackgroundOutput += text;
		if (this.pendingBackgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
			this.pendingBackgroundOutput = this.pendingBackgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS);
			this.pendingBackgroundOutputTruncated = true;
		}
	}

	private finishActiveExecution(execution: ActiveExecution): void {
		if (this.activeExecution !== execution) {
			return;
		}
		this.resolveExecution(execution, { clearActive: true });
	}

	private resolveExecution(execution: ActiveExecution, options: { clearActive: boolean }): void {
		const didClearActive = options.clearActive && this.activeExecution === execution;
		if (options.clearActive && this.activeExecution === execution) {
			this.activeExecution = undefined;
		}
		if (!execution.settled) {
			execution.settled = true;
			if (execution.opts.onLateSentAgentMessage) {
				this.registerLateSentAgentMessageHandler(execution.requestId, execution.opts.onLateSentAgentMessage);
			}

			let stdout = execution.stdout;
			let stderr = execution.stderr;
			let result = execution.result;
			let status = execution.status;
			if (execution.stdoutTruncated) stdout += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (execution.stderrTruncated) stderr += `\n[... output truncated at ${execution.maxChars} chars ...]`;
			if (result !== undefined && result.length > execution.maxChars) {
				result = `${result.slice(0, execution.maxChars)}\n[... output truncated at ${execution.maxChars} chars ...]`;
			}

			if (execution.opts.signal?.aborted) status = "aborted";

			let backgroundOutput = execution.backgroundOutput;
			if (execution.backgroundOutputTruncated) {
				backgroundOutput += `\n[... background output truncated at ${MAX_BACKGROUND_OUTPUT_CHARS} chars ...]`;
			}

			execution.resolve({
				stdout,
				stderr,
				result,
				diffs: execution.diffs.length > 0 ? execution.diffs : undefined,
				attachments: execution.attachments.length > 0 ? execution.attachments : undefined,
				sentAgentMessages: execution.sentAgentMessages.length > 0 ? execution.sentAgentMessages : undefined,
				backgroundOutput: backgroundOutput.length > 0 ? backgroundOutput : undefined,
				error: execution.error,
				status,
				durationMs: Date.now() - execution.started,
				doneFields: execution.doneFields,
			});
		}
		if (didClearActive) {
			this.notifyActiveExecutionIdle();
		}
	}

	private dispatchLateSentAgentMessage(requestId: string | undefined, value: unknown): boolean {
		const sentAgentMessage = parseSentAgentMessage(value);
		if (!sentAgentMessage || !requestId) {
			return false;
		}
		const handler = this.lateSentAgentMessageHandlers.get(requestId);
		if (!handler) {
			return false;
		}
		this.lateSentAgentMessageHandlers.delete(requestId);
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		handler(sentAgentMessage);
		return true;
	}

	private registerLateSentAgentMessageHandler(
		requestId: string,
		handler: (message: KernelSentAgentMessage) => void,
	): void {
		this.lateSentAgentMessageHandlers.set(requestId, handler);
		while (this.lateSentAgentMessageHandlers.size > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS) {
			const oldestRequestId = this.lateSentAgentMessageHandlers.keys().next().value;
			if (oldestRequestId === undefined) {
				break;
			}
			this.lateSentAgentMessageHandlers.delete(oldestRequestId);
		}
	}

	private rejectActiveExecution(error: Error): void {
		const execution = this.activeExecution;
		if (!execution) {
			return;
		}
		this.activeExecution = undefined;
		execution.reject(error);
		this.notifyActiveExecutionIdle();
	}

	private notifyActiveExecutionIdle(): void {
		for (const resolve of this.activeExecutionIdleWaiters) {
			resolve();
		}
		this.activeExecutionIdleWaiters.clear();
	}

	private waitForActiveExecutionToClear(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
		if (!this.activeExecution) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const finish = (cleared: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeout) {
					globalThis.clearTimeout(timeout);
				}
				this.activeExecutionIdleWaiters.delete(onIdle);
				signal?.removeEventListener("abort", onAbort);
				resolve(cleared);
			};
			const onIdle = () => finish(true);
			const onAbort = () => finish(false);
			this.activeExecutionIdleWaiters.add(onIdle);
			signal?.addEventListener("abort", onAbort, { once: true });
			timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});
	}

	private async waitForActiveExecutionToClearForReuse(signal?: AbortSignal): Promise<void> {
		const started = Date.now();
		while (this.activeExecution && Date.now() - started < KERNEL_BUSY_REUSE_WAIT_MS) {
			if ((this.state as string) === "shutdown") {
				throw new Error("Kernel has been shut down");
			}
			void this.interrupt().catch(() => undefined);
			const remaining = KERNEL_BUSY_REUSE_WAIT_MS - (Date.now() - started);
			const cleared = await this.waitForActiveExecutionToClear(
				signal,
				Math.max(1, Math.min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS, remaining)),
			);
			if (cleared || signal?.aborted) {
				return;
			}
		}
		if (this.activeExecution) {
			throw new KernelBusyAfterInterruptError();
		}
	}

	private startHostRequest(requestId: string, data: unknown): void {
		if (this.handledHostRequestIds.has(requestId)) {
			return;
		}
		this.handledHostRequestIds.add(requestId);
		while (this.handledHostRequestIds.size > MAX_HANDLED_HOST_REQUEST_IDS) {
			const oldest = this.handledHostRequestIds.values().next().value;
			if (oldest === undefined) break;
			this.handledHostRequestIds.delete(oldest);
		}

		const task = (async () => {
			try {
				const result = await this.handleHostRequest(data);
				try {
					await this.writeLine({ type: "host_reply", id: requestId, data: { status: "ok", result } });
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request ok reply for ${requestId}: ${errorMessage(replyError)}`,
					);
				}
			} catch (error) {
				this.appendKernelDiagnostic(`host request failed for ${requestId}: ${errorMessage(error)}`);
				try {
					await this.writeLine({
						type: "host_reply",
						id: requestId,
						data: { status: "error", error: errorMessage(error) },
					});
				} catch (replyError) {
					this.appendKernelDiagnostic(
						`failed to send host request error reply for ${requestId}: ${errorMessage(replyError)}`,
					);
				}
			}
		})();
		this.inFlightHostRequests.add(task);
		void task.finally(() => {
			this.inFlightHostRequests.delete(task);
		});
	}

	private async handleHostRequest(data: unknown): Promise<Record<string, unknown>> {
		if (!isRecord(data)) {
			throw new Error("host request payload must be an object");
		}
		if (typeof data.type !== "string" || data.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}

		const handler = this.options.hostHandlers?.[data.type];
		if (!handler) {
			throw new Error(`host request type "${data.type}" is not available in this session`);
		}
		// Tag the request with the cell that triggered it. A blocking call is still
		// the in-flight execution; detached spawns (asyncio.create_task) fire after
		// the scheduling cell goes idle, so fall back to that last cell's source.
		const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
		return handler({ ...data, cellSourceCode });
	}

	private async interrupt(): Promise<void> {
		const requestId = this.activeExecution?.requestId;
		if (!requestId) return;
		await this.writeLine({ type: "interrupt", id: requestId });
	}

	private cleanupResources(killSignal: NodeJS.Signals = "SIGTERM"): void {
		this.startGeneration++; // any teardown invalidates in-flight starts
		this.clearSnapshotTimer();
		this.lateSentAgentMessageHandlers.clear();
		this.pendingDoneWaiters.clear();
		// Stale pre-teardown background output must not surface after a restart.
		this.pendingBackgroundOutput = "";
		this.pendingBackgroundOutputTruncated = false;
		this.rejectActiveExecution(new Error("Kernel has been shut down"));
		const child = this.child;
		const windowsControl =
			child && this.windowsPersistentReplControl?.child === child ? this.windowsPersistentReplControl : undefined;
		this.child = undefined;
		this.readyDeferred = undefined;
		if (child) {
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (!windowsControl) {
				const childStdio = (child.stdio ?? []) as Array<Readable | Writable | null | undefined>;
				for (let fd = PROCESS_STARTUP_ACK_FD; fd <= PROCESS_STARTUP_CONTROL_FD; fd++) {
					childStdio[fd]?.destroy();
				}
			}
			const pid = child.pid;
			const groupPid = this.kernelProcessGroupPid;
			const lineage = this.kernelAdmissionLineage ?? windowsControl?.lineage;
			const exactCandidate = pid !== undefined ? this.findTrackedKernelCandidate(pid, lineage) : undefined;
			this.kernelProcessGroupPid = undefined;
			this.kernelAdmissionLineage = undefined;
			if (lineage !== undefined) {
				this.kernelPidsAwaitingDescendantCleanup.set(lineage.kernelLineage, lineage);
				this.trackKernelJournalChildren(lineage);
			}
			if (windowsControl) {
				// Keep the helper alive with its Job handle until it returns bound
				// accounting proof. The caller applies a bounded hard-kill fallback.
				void this.requestWindowsPersistentReplTermination(windowsControl);
			} else if (exactCandidate && shouldReapOrphanProcess(exactCandidate)) {
				try {
					if (process.platform !== "win32" && pid !== undefined && groupPid === pid) {
						process.kill(-groupPid, killSignal);
					} else if (process.platform === "win32") {
						child.kill(killSignal);
					}
				} catch {
					// The freshly matched exact kernel has already exited.
				}
			}
			// A killed/crashed target cannot run its own shutdown hook. Admission
			// stores its exact PID before exec, so separately-sessioned journal
			// children can be selected now and death-proved before replacement.
			if (lineage !== undefined) reapKernelOrphanProcesses(lineage);
		}
		// Retain an unproved Windows helper authority across host wait timeouts.
		// Its positive done proof or parent death is the only close boundary.
		this.startPromise = undefined;
	}

	private async waitForKernelExit(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}

	private async waitForHostRequestsToSettle(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) {
				timeout.unref();
			}
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) {
			globalThis.clearTimeout(timeout);
		}
		if (result === "timeout") {
			this.appendKernelDiagnostic(
				`timed out waiting ${timeoutMs}ms for ${tasks.length} host request task(s) during shutdown`,
			);
		}
	}

	/** Resolves true when this call performed the cleanup (false: a concurrent teardown won; a joiner's options are ignored - the first caller's policy wins). */
	async shutdown(opts: KernelShutdownOptions = {}): Promise<boolean> {
		const inFlightShutdown = this.gracefulShutdownPromise;
		if (inFlightShutdown) {
			await inFlightShutdown;
			return false;
		}

		this.teardownInFlight++;
		this.supersedeProtocolRepair();
		const operation = this.performShutdown(opts);
		this.gracefulShutdownPromise = operation;
		try {
			return await operation;
		} finally {
			this.teardownInFlight--;
			if (this.gracefulShutdownPromise === operation) this.gracefulShutdownPromise = undefined;
		}
	}

	private async performShutdown(opts: KernelShutdownOptions): Promise<boolean> {
		if (this.state === "shutdown") {
			liveKernels.delete(this);
			if (this.gracefulShutdownGeneration === this.startGeneration) return false;
			this.cleanupResources();
			return true;
		}
		// Captured before any await: teardowns and newer starts bump the counter.
		const generation = this.startGeneration;
		if (opts.snapshot) {
			await this.flushSnapshotForDispose();
			if (this.startStale(generation)) return false;
		}
		// Protocol shutdown first: the runtime closes MCP servers and kills live bash() process groups a bare hard-kill would leak.
		const protocolShutdownAvailable = this.state === "running";
		this.markKernelExitExpected();
		recordProcessLifecycle(
			"kernel_shutdown",
			this.kernelLifecycleDetails({ expected: true, trigger: "shutdown", snapshot: opts.snapshot === true }),
		);
		this.state = "shutdown";
		liveKernels.delete(this);
		this.gracefulShutdownGeneration = generation;

		let shutdownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
		let doneWaiterId: string | undefined;
		let performedCleanup = false;
		try {
			if (opts.drainHostRequests) {
				const inFlightHostRequests = [...this.inFlightHostRequests];
				if (inFlightHostRequests.length > 0) {
					await this.waitForHostRequestsToSettle(inFlightHostRequests, HOST_REQUEST_SHUTDOWN_TIMEOUT_MS);
				}
			}
			if (
				protocolShutdownAvailable &&
				!this.startStale(generation) &&
				this.child?.stdin &&
				!this.child.stdin.destroyed
			) {
				const requestId = uuid();
				doneWaiterId = requestId;
				const doneReply = new Promise<void>((resolve) => {
					this.pendingDoneWaiters.set(requestId, resolve);
				});
				const shutdownDeadline = new Promise<never>((_resolve, reject) => {
					shutdownTimer = globalThis.setTimeout(
						() => reject(new Error(`Kernel did not shut down within ${KERNEL_SHUTDOWN_TIMEOUT_MS}ms`)),
						KERNEL_SHUTDOWN_TIMEOUT_MS,
					);
					shutdownTimer.unref?.();
				});
				const send = this.writeLine({ type: "shutdown", id: requestId });
				send.catch(() => undefined);
				const kernelExit = this.waitForKernelExit();
				const gracefulReply = Promise.all([send, doneReply]);
				gracefulReply.catch(() => undefined);
				await Promise.race([send, gracefulReply, kernelExit, shutdownDeadline]);
				if (this.startStale(generation)) return false;
				await Promise.race([kernelExit, shutdownDeadline]);
			}
		} catch (error) {
			this.appendKernelDiagnostic(
				`graceful shutdown failed (killing instead): ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (shutdownTimer) globalThis.clearTimeout(shutdownTimer);
			if (doneWaiterId) this.pendingDoneWaiters.delete(doneWaiterId);
			if (this.gracefulShutdownGeneration === generation) this.gracefulShutdownGeneration = undefined;
			if (!this.startStale(generation)) {
				const cleanupChild = this.child;
				const windowsControl =
					cleanupChild && this.windowsPersistentReplControl?.child === cleanupChild
						? this.windowsPersistentReplControl
						: undefined;
				const cleanupTracked =
					cleanupChild?.pid !== undefined && this.findTrackedKernelCandidate(cleanupChild.pid) !== undefined;
				this.cleanupResources();
				performedCleanup = true;
				let exactWindowsJobEmpty = false;
				if (windowsControl) {
					exactWindowsJobEmpty = await this.waitForWindowsPersistentReplProof(windowsControl);
					// Timeout retains the same helper/Job authority for a later retry.
				}
				const cleanupExited =
					cleanupChild && (windowsControl || cleanupTracked) ? await waitForChildExit(cleanupChild, 5000) : false;
				if ((windowsControl && exactWindowsJobEmpty) || (!windowsControl && cleanupExited)) {
					await this.retireCleanupProvenKernelAuthorities();
				}
			}
		}

		return performedCleanup;
	}

	async restart(): Promise<void> {
		// A final dispose flush owns the queue tail. Taking a slot now and joining
		// the in-flight shutdown would deadlock: the flush's snapshot waits on our
		// slot while we wait on the flush's shutdown.
		if (this.flushingSnapshotForDispose) {
			throw new Error("Kernel is shutting down");
		}
		const restartAttemptId = uuid();
		const previousKernelInstanceId = this.kernelInstanceId;
		recordProcessLifecycle(
			"kernel_restart",
			this.kernelLifecycleDetails({ phase: "requested", restartAttemptId, previousKernelInstanceId }),
		);
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		try {
			const performedCleanup = await this.shutdown();
			if (!performedCleanup) {
				recordProcessLifecycle(
					"kernel_restart",
					this.kernelLifecycleDetails({
						phase: "superseded",
						restartAttemptId,
						previousKernelInstanceId,
					}),
				);
				return;
			}
			this.state = "idle";
			this.nextLaunchTrigger = "kernel-restart";
			await this.start();
			recordProcessLifecycle(
				"kernel_restart",
				this.kernelLifecycleDetails({ phase: "completed", restartAttemptId, previousKernelInstanceId }),
			);
		} catch (error) {
			recordProcessLifecycle(
				"kernel_restart",
				this.kernelLifecycleDetails({
					phase: "failed",
					restartAttemptId,
					previousKernelInstanceId,
					error: lifecycleError(error),
				}),
			);
			throw error;
		} finally {
			resolveNext();
		}
	}

	async kill(): Promise<void> {
		this.supersedeProtocolRepair();
		this.markKernelExitExpected();
		recordProcessLifecycle("kernel_kill", this.kernelLifecycleDetails({ expected: true, signal: "SIGKILL" }));
		this.state = "shutdown";
		liveKernels.delete(this);
		const cleanupChild = this.child;
		const windowsControl =
			cleanupChild && this.windowsPersistentReplControl?.child === cleanupChild
				? this.windowsPersistentReplControl
				: undefined;
		const cleanupTracked =
			cleanupChild?.pid !== undefined && this.findTrackedKernelCandidate(cleanupChild.pid) !== undefined;
		this.cleanupResources("SIGKILL");
		let exactWindowsJobEmpty = false;
		if (windowsControl) {
			exactWindowsJobEmpty = await this.waitForWindowsPersistentReplProof(windowsControl);
			// Timeout retains the same helper/Job authority for a later retry.
		}
		const cleanupExited =
			cleanupChild && (windowsControl || cleanupTracked) ? await waitForChildExit(cleanupChild, 5000) : false;
		if ((windowsControl && exactWindowsJobEmpty) || (!windowsControl && cleanupExited)) {
			await this.retireCleanupProvenKernelAuthorities();
		}
	}

	/**
	 * Serialize the user namespace to disk (best-effort, per-variable). No-op when
	 * the kernel isn't running or no snapshot target was configured. Never throws.
	 */
	async snapshotState(): Promise<SnapshotResult | null> {
		return this.captureSnapshot();
	}

	/** Persist the namespace, then remove variables above the per-variable cap. */
	async pruneOversizedVariables(): Promise<SnapshotResult | null> {
		return this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS, pruneOversized: true });
	}

	private async captureSnapshot(
		options: { executionTimeoutMs?: number; pruneOversized?: boolean } = {},
	): Promise<SnapshotResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg || !this.isRunning) return null;
		try {
			const r = await this.enqueueRequest(
				{
					type: "snapshot",
					path: cfg.path,
					manifest_path: cfg.manifestPath,
					max_bytes: cfg.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
					max_variable_bytes: cfg.maxVariableBytes ?? DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
					prune_oversized: options.pruneOversized ?? false,
				},
				"",
				{ internal: true },
				options.executionTimeoutMs,
			);
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(
					`state snapshot ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return null;
			}
			const pruned = asStringArray(r.doneFields.pruned);
			return {
				saved: asStringArray(r.doneFields.saved),
				skipped: asReasonArray(r.doneFields.skipped),
				pruned: pruned.length > 0 ? pruned : undefined,
				bytes: typeof r.doneFields.bytes === "number" ? r.doneFields.bytes : 0,
				path: cfg.path,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state snapshot error: ${errorMessage(error)}`);
			return null;
		}
	}

	/**
	 * Revive a previously snapshotted namespace into the kernel. Call right after
	 * start() and before the runtime bootstrap, which then refreshes live handles
	 * (rlm, skills) over anything restored. Never throws.
	 */
	async restoreState(): Promise<RestoreResult | null> {
		return this.performRestore(false);
	}

	/** Repair restores bypass the repair gate and are bounded so a stalled kernel cannot wedge it. */
	private async performRestore(protocolRepair: boolean): Promise<RestoreResult | null> {
		const cfg = this.options.snapshot;
		if (!cfg) return null;
		try {
			const r = await this.enqueueRequest(
				{ type: "restore", path: cfg.path },
				"",
				{ internal: true, protocolRepair },
				protocolRepair ? REPAIR_STEP_TIMEOUT_MS : undefined,
			);
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(
					`state restore ${r.status === "aborted" ? "timed out" : "failed"}: ${r.error?.evalue ?? r.stderr}`,
				);
				return null;
			}
			this.pendingRestore = false;
			return {
				restored: asStringArray(r.doneFields.restored),
				failed: asReasonArray(r.doneFields.failed),
				path: cfg.path,
			};
		} catch (error) {
			this.appendKernelDiagnostic(`state restore error: ${errorMessage(error)}`);
			return null;
		}
	}

	/** Live user-defined top-level names, or null if the kernel isn't running. Never throws. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.isRunning) return null;
		try {
			const r = await this.enqueueRequest({ type: "list_names" }, "", { internal: true, signal });
			if (r.status !== "ok" || !r.doneFields) {
				this.appendKernelDiagnostic(`namespace listing failed: ${r.error?.evalue ?? r.stderr}`);
				return null;
			}
			return asStringArray(r.doneFields.names);
		} catch (error) {
			this.appendKernelDiagnostic(`namespace listing error: ${errorMessage(error)}`);
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const cfg = this.options.snapshot;
		if (!cfg) return;
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = globalThis.setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		}, cfg.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		if (this.snapshotTimer && typeof this.snapshotTimer === "object" && "unref" in this.snapshotTimer) {
			this.snapshotTimer.unref();
		}
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}

	private flushSnapshotForDispose(): Promise<void> {
		// Concurrent teardowns (dispose vs a signal-handler shutdown) join one flush:
		// a second flusher would clear the execution guard while the first is still
		// snapshotting and enqueue a duplicate final snapshot behind it.
		this.snapshotFlushForDispose ??= this.runSnapshotFlushForDispose().finally(() => {
			this.snapshotFlushForDispose = undefined;
		});
		return this.snapshotFlushForDispose;
	}

	private async runSnapshotFlushForDispose(): Promise<void> {
		if (!this.options.snapshot || !this.isRunning) return;
		// A kernel that never restored the saved namespace must not overwrite it:
		// the on-disk snapshot is strictly fresher than this namespace.
		if (this.pendingRestore) return;
		// Block new external executions so none can splice ahead of the final snapshot and stall dispose.
		this.flushingSnapshotForDispose = true;
		try {
			const pendingExecutions = this.executionQueue;
			if (this.activeExecution) void this.interrupt().catch(() => undefined);
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			const queueSettled = await Promise.race([
				pendingExecutions.then(() => true),
				new Promise<false>((resolve) => {
					timeout = globalThis.setTimeout(() => resolve(false), SNAPSHOT_EXECUTION_TIMEOUT_MS);
					timeout.unref?.();
				}),
			]);
			if (timeout) globalThis.clearTimeout(timeout);
			if (!queueSettled) return;
			await this.captureSnapshot({ executionTimeoutMs: SNAPSHOT_EXECUTION_TIMEOUT_MS });
		} finally {
			// Reset: a superseding start() can revive this kernel for new work.
			this.flushingSnapshotForDispose = false;
		}
	}

	/** Synchronous best-effort cleanup. Safe to call from `process.on('exit')`. */
	disposeSync(): void {
		this.supersedeProtocolRepair();
		if (this.state !== "shutdown" && this.kernelInstanceId) {
			this.markKernelExitExpected();
			recordProcessLifecycle(
				"kernel_shutdown",
				this.kernelLifecycleDetails({ expected: true, trigger: "dispose-sync", snapshot: false }),
			);
		}
		this.state = "shutdown";
		liveKernels.delete(this);
		this.cleanupResources();
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}
