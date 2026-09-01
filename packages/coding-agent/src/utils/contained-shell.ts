import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { resolveWindowsJobBootstrapPythonPath, resolveWindowsJobHelperPath } from "../core/kernel/bootstrap.js";
import {
	type ActiveOrphanProcessCandidate,
	isOrphanProcessCandidateExactDead,
	withoutOrphanProcessJournalAuthority,
} from "../core/orphan-process-journal.js";
import {
	createProcessIdentityOwnerToken,
	getProcessStartId,
	isExactProcessStartId,
	supportsExactProcessIdentityPlatform,
} from "../core/session-lease.js";
import { waitForChildProcess } from "./child-process.js";
import {
	enrollTrackedDetachedChildPid,
	untrackDetachedChildPid,
	untrackDetachedChildPidAfterHeldWindowsJobEmpty,
} from "./shell.js";

const POSIX_CLEANUP_TIMEOUT_MS = 5_000;
const POSIX_CONTROL_PROTOCOL_VERSION = 1;
const POSIX_CONTROL_MAX_BYTES = 8 * 1024;
const POSIX_CONTROL_WRITE_MAX_BYTES = 1024 * 1024;
const WINDOWS_PROTOCOL_VERSION = 1;
const WINDOWS_ADMISSION_TIMEOUT_MS = 15_000;
const WINDOWS_CLEANUP_TIMEOUT_MS = 15_000;
const WINDOWS_HELPER_EXIT_TIMEOUT_MS = 2_000;
const WINDOWS_PROTOCOL_TAIL_BYTES = 8 * 1024;

export interface ContainedProcessExecutionOptions {
	/** Executable plus arguments. argv[0] does not run until containment is durably enrolled. */
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ContainedProcessExecutionResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
	timedOut: boolean;
	aborted: boolean;
	/** The canonical Windows Job runner merges child stdout and stderr into stdout. */
	outputMode: "separate" | "merged";
}

export interface ContainedShellExecutionOptions {
	shell: string;
	args: string[];
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

interface WindowsReadyFrame {
	primeAgentWindowsJob: 1;
	type: "ready";
	nonce: string;
	pid: number;
	processStartId: string;
	jobContained: true;
}

interface WindowsReleasedFrame {
	primeAgentWindowsJob: 1;
	type: "released";
	nonce: string;
	pid: number;
	processStartId: string;
}

interface WindowsDoneFrame {
	primeAgentWindowsJob: 1;
	type: "done";
	nonce: string;
	pid: number;
	processStartId: string;
	exitCode: number;
	leaderDead: boolean;
	jobEmpty: boolean;
	jobTerminationAttempted: boolean;
	jobTerminationSucceeded: boolean;
	taskkillFallbackAttempted: boolean;
}

interface WindowsSetupDoneFrame {
	primeAgentWindowsJob: 1;
	type: "setup-done";
	nonce: string;
	pid: number;
	leaderDead: boolean;
	jobEmpty: boolean;
	jobTerminationAttempted: boolean;
	jobTerminationSucceeded: boolean;
	taskkillFallbackAttempted: boolean;
}

interface WindowsErrorFrame {
	primeAgentWindowsJob: 1;
	type: "error";
	nonce: string;
	stage: string;
	message: string;
}

export type WindowsJobFrame =
	| WindowsReadyFrame
	| WindowsReleasedFrame
	| WindowsDoneFrame
	| WindowsSetupDoneFrame
	| WindowsErrorFrame;

type WindowsJobFrameType = WindowsJobFrame["type"];
type WindowsJobProtocolPhase = "awaiting-ready" | "suspended" | "running" | "done";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

function isWindowsStartId(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("win:") && isExactProcessStartId(value);
}

function isWindowsProtocolNonce(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidWindowsFrame(message: string): Error {
	return new Error(`Invalid Windows process containment authority frame: ${message}`);
}

/**
 * Parse only the nonce-bound native-helper protocol. Non-protocol stderr stays
 * diagnostic text; malformed or foreign authority frames fail the protocol.
 */
export function parseWindowsJobFrame(line: string, expectedNonce: string): WindowsJobFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || !("primeAgentWindowsJob" in value)) return undefined;
	if (value.primeAgentWindowsJob !== WINDOWS_PROTOCOL_VERSION) {
		throw invalidWindowsFrame("unsupported protocol version");
	}
	if (!isWindowsProtocolNonce(expectedNonce) || value.nonce !== expectedNonce) {
		throw invalidWindowsFrame("nonce mismatch");
	}
	if (value.type === "ready") {
		if (
			hasExactKeys(value, ["primeAgentWindowsJob", "type", "nonce", "pid", "processStartId", "jobContained"]) &&
			isPositiveInteger(value.pid) &&
			isWindowsStartId(value.processStartId) &&
			value.jobContained === true
		) {
			return value as unknown as WindowsReadyFrame;
		}
		throw invalidWindowsFrame("malformed ready proof");
	}
	if (value.type === "released") {
		if (
			hasExactKeys(value, ["primeAgentWindowsJob", "type", "nonce", "pid", "processStartId"]) &&
			isPositiveInteger(value.pid) &&
			isWindowsStartId(value.processStartId)
		) {
			return value as unknown as WindowsReleasedFrame;
		}
		throw invalidWindowsFrame("malformed release proof");
	}
	if (value.type === "done") {
		if (
			hasExactKeys(value, [
				"primeAgentWindowsJob",
				"type",
				"nonce",
				"pid",
				"processStartId",
				"exitCode",
				"leaderDead",
				"jobEmpty",
				"jobTerminationAttempted",
				"jobTerminationSucceeded",
				"taskkillFallbackAttempted",
			]) &&
			isPositiveInteger(value.pid) &&
			isWindowsStartId(value.processStartId) &&
			Number.isInteger(value.exitCode) &&
			typeof value.leaderDead === "boolean" &&
			typeof value.jobEmpty === "boolean" &&
			typeof value.jobTerminationAttempted === "boolean" &&
			typeof value.jobTerminationSucceeded === "boolean" &&
			typeof value.taskkillFallbackAttempted === "boolean"
		) {
			return value as unknown as WindowsDoneFrame;
		}
		throw invalidWindowsFrame("malformed done proof");
	}
	if (value.type === "setup-done") {
		if (
			hasExactKeys(value, [
				"primeAgentWindowsJob",
				"type",
				"nonce",
				"pid",
				"leaderDead",
				"jobEmpty",
				"jobTerminationAttempted",
				"jobTerminationSucceeded",
				"taskkillFallbackAttempted",
			]) &&
			isPositiveInteger(value.pid) &&
			typeof value.leaderDead === "boolean" &&
			typeof value.jobEmpty === "boolean" &&
			typeof value.jobTerminationAttempted === "boolean" &&
			typeof value.jobTerminationSucceeded === "boolean" &&
			typeof value.taskkillFallbackAttempted === "boolean"
		) {
			return value as unknown as WindowsSetupDoneFrame;
		}
		throw invalidWindowsFrame("malformed setup cleanup proof");
	}
	if (value.type === "error") {
		if (
			hasExactKeys(value, ["primeAgentWindowsJob", "type", "nonce", "stage", "message"]) &&
			typeof value.stage === "string" &&
			typeof value.message === "string"
		) {
			return value as unknown as WindowsErrorFrame;
		}
		throw invalidWindowsFrame("malformed error frame");
	}
	throw invalidWindowsFrame("unknown frame type");
}

/** Enforces one exact ready -> released -> done authority stream per request. */
export class WindowsJobFrameValidator {
	private phase: WindowsJobProtocolPhase = "awaiting-ready";
	private ready: WindowsReadyFrame | undefined;
	private releaseRequested = false;
	private terminationRequested = false;
	private errorSeen = false;

	constructor(readonly nonce: string) {
		if (!isWindowsProtocolNonce(nonce))
			throw new Error("Windows process containment nonce must be 64 hex characters");
	}

	noteReleaseRequested(): void {
		if (this.phase !== "suspended" || this.releaseRequested || this.terminationRequested) {
			throw new Error("Windows process containment release was requested out of sequence");
		}
		this.releaseRequested = true;
	}

	noteTerminationRequested(): void {
		if (this.phase !== "done") this.terminationRequested = true;
	}

	accept(frame: WindowsJobFrame): void {
		if (frame.nonce !== this.nonce) throw invalidWindowsFrame("nonce changed during request");
		if (this.phase === "done") throw invalidWindowsFrame("frame arrived after terminal proof");
		if (frame.type === "error") {
			if (this.errorSeen) throw invalidWindowsFrame("duplicate error frame");
			this.errorSeen = true;
			return;
		}
		if (frame.type === "ready") {
			if (this.phase !== "awaiting-ready" || this.ready) throw invalidWindowsFrame("ready out of sequence");
			this.ready = frame;
			this.phase = "suspended";
			return;
		}
		if (frame.type === "released") {
			if (this.phase !== "suspended" || !this.releaseRequested || !this.matchesReady(frame)) {
				throw invalidWindowsFrame("released out of sequence or for the wrong process");
			}
			this.phase = "running";
			return;
		}
		if (frame.type === "setup-done") {
			if (this.phase !== "awaiting-ready" || (!this.errorSeen && !this.terminationRequested)) {
				throw invalidWindowsFrame("setup cleanup proof out of sequence");
			}
			this.phase = "done";
			return;
		}
		if (this.ready) {
			if (!this.matchesReady(frame)) throw invalidWindowsFrame("done proof names the wrong process");
			if (this.phase !== "running" && !this.errorSeen && !this.terminationRequested) {
				throw invalidWindowsFrame("done arrived before release");
			}
		} else if (this.phase !== "awaiting-ready" || (!this.errorSeen && !this.terminationRequested)) {
			throw invalidWindowsFrame("done arrived without a ready proof");
		}
		this.phase = "done";
	}

	private matchesReady(frame: WindowsReleasedFrame | WindowsDoneFrame): boolean {
		return frame.pid === this.ready?.pid && frame.processStartId === this.ready.processStartId;
	}
}

interface FrameWaiter {
	types: ReadonlySet<WindowsJobFrameType>;
	resolve: (frame: WindowsJobFrame) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

class WindowsJobFrameQueue {
	private readonly decoder = new StringDecoder("utf8");
	private readonly validator: WindowsJobFrameValidator;
	private pending = "";
	private frames: WindowsJobFrame[] = [];
	private waiters: FrameWaiter[] = [];
	private closedError: Error | undefined;
	private fatalError: Error | undefined;
	private diagnosticTail = "";

	constructor(private readonly nonce: string) {
		this.validator = new WindowsJobFrameValidator(nonce);
	}

	noteReleaseRequested(): void {
		this.validator.noteReleaseRequested();
	}

	noteTerminationRequested(): void {
		this.validator.noteTerminationRequested();
	}

	push(chunk: Buffer): void {
		if (this.fatalError) return;
		this.pending += this.decoder.write(chunk);
		this.consumeLines();
	}

	end(): void {
		if (this.fatalError) return;
		this.pending += this.decoder.end();
		if (this.pending) this.consumeLine(this.pending);
		this.pending = "";
	}

	close(error: Error): void {
		if (this.fatalError) return;
		this.closedError ??= error;
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(this.withDiagnostics(error));
		}
	}

	async next(types: readonly WindowsJobFrameType[], timeoutMs: number): Promise<WindowsJobFrame> {
		if (this.fatalError) throw this.withDiagnostics(this.fatalError);
		const accepted = new Set(types);
		const existing = this.frames.findIndex((frame) => accepted.has(frame.type));
		if (existing >= 0) return this.frames.splice(existing, 1)[0]!;
		if (this.closedError) throw this.withDiagnostics(this.closedError);
		return new Promise<WindowsJobFrame>((resolve, reject) => {
			const waiter: FrameWaiter = {
				types: accepted,
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(
						this.withDiagnostics(
							new Error(`Windows process containment protocol timed out after ${timeoutMs}ms`),
						),
					);
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	private consumeLines(): void {
		while (!this.fatalError) {
			const newline = this.pending.indexOf("\n");
			if (newline < 0) return;
			const line = this.pending.slice(0, newline).replace(/\r$/, "");
			this.pending = this.pending.slice(newline + 1);
			this.consumeLine(line);
		}
	}

	private consumeLine(line: string): void {
		try {
			const frame = parseWindowsJobFrame(line, this.nonce);
			if (!frame) {
				this.diagnosticTail = `${this.diagnosticTail}${line}\n`.slice(-WINDOWS_PROTOCOL_TAIL_BYTES);
				return;
			}
			this.validator.accept(frame);
			const waiterIndex = this.waiters.findIndex((waiter) => waiter.types.has(frame.type));
			if (waiterIndex < 0) {
				this.frames.push(frame);
				return;
			}
			const [waiter] = this.waiters.splice(waiterIndex, 1);
			clearTimeout(waiter!.timer);
			waiter!.resolve(frame);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error): void {
		if (this.fatalError) return;
		this.fatalError = error;
		this.frames = [];
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(this.withDiagnostics(error));
		}
	}

	private withDiagnostics(error: Error): Error {
		const diagnostic = this.diagnosticTail.trim();
		return diagnostic ? new Error(`${error.message}: ${diagnostic}`, { cause: error }) : error;
	}
}

function assertProcessRequest(options: ContainedProcessExecutionOptions): void {
	const [executable] = options.argv;
	if (!executable || options.argv.some((value) => typeof value !== "string" || value.includes("\0"))) {
		throw new Error("Contained process requires a non-empty, NUL-free argv");
	}
}

/**
 * One intentionally narrow bridge to the process-identity API. Only native
 * proc:/win: identities and parent-held token: capabilities are exact;
 * portable ps: timestamps are coarse hints.
 */
type ExactProcessCandidate = ActiveOrphanProcessCandidate & { processStartId: string };

function exactCandidate(pid: number): ExactProcessCandidate {
	const processStartId = getProcessStartId(pid);
	if (!processStartId || !isExactProcessStartId(processStartId)) {
		throw new Error(`Gated process exact-identity probe unavailable for pid ${pid}`);
	}
	return { pid, processStartId };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

type PosixControlAction = "release" | "cleanup";
type PosixReleaseState = "not-requested" | "writing" | "delivered" | "failed";

interface ActivePosixControlWrite {
	id: number;
	timer: NodeJS.Timeout;
	onError: (error: Error) => void;
	reject: (error: Error) => void;
}

/** One non-queueing writer for the wrapper's private admission stream. */
class PosixControlWriter {
	private readonly stdin: Writable | null;
	private releaseState: PosixReleaseState = "not-requested";
	private terminalError: Error | undefined;
	private active: ActivePosixControlWrite | undefined;
	private nextWriteId = 0;

	constructor(child: ChildProcess) {
		this.stdin = child.stdin;
	}

	get hasPendingWrite(): boolean {
		return this.active !== undefined;
	}

	get isTerminal(): boolean {
		return this.terminalError !== undefined;
	}

	get isWritable(): boolean {
		return (
			this.terminalError === undefined && this.stdin !== null && !this.stdin.destroyed && !this.stdin.writableEnded
		);
	}

	write(
		value: Record<string, unknown>,
		action: PosixControlAction,
		timeoutMs: number,
		timeoutMessage: string,
	): Promise<void> {
		if (this.terminalError) return Promise.reject(this.terminalError);
		if (this.active) {
			const error = new Error("POSIX process containment control writes cannot be queued");
			this.terminate(error);
			return Promise.reject(error);
		}
		if (action === "release" && this.releaseState !== "not-requested") {
			const error = new Error("POSIX process containment release was requested out of sequence");
			this.terminate(error);
			return Promise.reject(error);
		}

		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(value);
		} catch (error) {
			const terminal = error instanceof Error ? error : new Error(String(error));
			this.terminate(terminal);
			return Promise.reject(terminal);
		}
		if (serialized === undefined) {
			const error = new Error("POSIX process containment control request could not be serialized");
			this.terminate(error);
			return Promise.reject(error);
		}
		const frame = Buffer.from(`${serialized}\n`, "utf8");
		if (frame.byteLength > POSIX_CONTROL_WRITE_MAX_BYTES) {
			const error = new Error(
				`POSIX process containment control request exceeded ${POSIX_CONTROL_WRITE_MAX_BYTES} bytes`,
			);
			this.terminate(error);
			return Promise.reject(error);
		}

		const stdin = this.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) {
			const error = new Error("POSIX process containment wrapper control pipe is closed");
			this.terminate(error);
			return Promise.reject(error);
		}
		if (action === "release") this.releaseState = "writing";

		return new Promise<void>((resolveWrite, rejectWrite) => {
			const id = ++this.nextWriteId;
			const onError = (error: Error) => {
				if (this.active?.id !== id) return;
				this.terminate(error);
			};
			const active: ActivePosixControlWrite = {
				id,
				timer: setTimeout(() => {
					if (this.active?.id !== id) return;
					this.terminate(new Error(timeoutMessage));
				}, timeoutMs),
				onError,
				reject: rejectWrite,
			};
			this.active = active;
			stdin.once("error", onError);
			try {
				stdin.write(frame, (error?: Error | null) => {
					if (this.active?.id !== id) return;
					if (error) {
						this.terminate(error);
						return;
					}
					clearTimeout(active.timer);
					stdin.off("error", onError);
					this.active = undefined;
					if (action === "release") this.releaseState = "delivered";
					resolveWrite();
				});
			} catch (error) {
				this.terminate(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	terminate(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		if (this.releaseState === "writing") this.releaseState = "failed";
		const active = this.active;
		this.active = undefined;
		if (active) {
			clearTimeout(active.timer);
			this.stdin?.off("error", active.onError);
		}
		if (this.stdin && !this.stdin.destroyed) this.stdin.destroy(error);
		active?.reject(error);
	}

	close(): void {
		if (this.active) {
			this.terminate(new Error("POSIX process containment control stream closed with a pending write"));
			return;
		}
		if (this.stdin && !this.stdin.destroyed) this.stdin.destroy();
	}
}

function posixWrapperStillOwnsControl(
	child: ChildProcess,
	candidate: ActiveOrphanProcessCandidate,
	control: PosixControlWriter,
): boolean {
	return child.pid === candidate.pid && child.exitCode === null && child.signalCode === null && control.isWritable;
}

async function waitForPosixExactDeath(candidate: ActiveOrphanProcessCandidate, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!isOrphanProcessCandidateExactDead(candidate) && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	return isOrphanProcessCandidateExactDead(candidate);
}

async function requestPosixWrapperCleanup(
	child: ChildProcess,
	candidate: ActiveOrphanProcessCandidate,
	completion: Promise<number | null>,
	controlToken: string,
	control: PosixControlWriter,
): Promise<boolean> {
	// Never put cleanup behind a backpressured release. Destroying this exact
	// private pipe makes an incomplete frame inert; a complete release is
	// followed by EOF, which makes the wrapper kill its process group.
	if (control.hasPendingWrite) {
		control.terminate(new Error(`Containment wrapper ${candidate.pid} was terminated during a control write`));
	}

	// The private pipe names the original ChildProcess even if its numeric PID is
	// later reused. Never redirect cleanup through the generic PID/PGID reaper.
	if (!posixWrapperStillOwnsControl(child, candidate, control)) {
		const hostDeliveredEof = control.isTerminal;
		try {
			await withTimeout(
				completion,
				POSIX_CLEANUP_TIMEOUT_MS,
				`Timed out observing dead containment wrapper ${candidate.pid}`,
			);
		} catch {
			return false;
		}
		// A host-terminated stream delivered EOF cleanup. A stream closed by an
		// unexpectedly dead wrapper cannot provide that proof; retain any live group.
		return hostDeliveredEof
			? waitForPosixExactDeath(candidate, POSIX_CLEANUP_TIMEOUT_MS)
			: isOrphanProcessCandidateExactDead(candidate);
	}

	try {
		await control.write(
			{
				action: "cleanup",
				token: controlToken,
				pid: candidate.pid,
				state: "cleanup-requested",
			},
			"cleanup",
			POSIX_CLEANUP_TIMEOUT_MS,
			`Timed out requesting containment-wrapper cleanup for ${candidate.pid}`,
		);
	} catch {
		// write() already destroyed the exact stream. The wrapper now sees EOF,
		// which is cleanup both before and after release.
	}
	try {
		await withTimeout(completion, POSIX_CLEANUP_TIMEOUT_MS, `Timed out reaping containment wrapper ${candidate.pid}`);
	} catch (error) {
		control.terminate(error instanceof Error ? error : new Error(String(error)));
		return false;
	}
	return waitForPosixExactDeath(candidate, POSIX_CLEANUP_TIMEOUT_MS);
}

interface PosixTargetDoneFrame {
	primeAgentPosixAdmission: 1;
	type: "target-done";
	token: string;
	pid: number;
	state: "target-done";
	exitCode: number;
	signal: NodeJS.Signals | null;
	message?: string;
	code?: string;
	errno?: number;
	path?: string;
	syscall?: string;
}

interface PosixTargetDone {
	exitCode: number;
	signal: NodeJS.Signals | null;
	error?: Error;
}

function parsePosixTargetDoneFrame(
	payload: string,
	overflow: boolean,
	expectedPid: number,
	expectedToken: string,
): PosixTargetDone | undefined {
	if (overflow) throw new Error("POSIX process admission control frame exceeded its bound");
	const lines = payload
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	if (lines.length !== 1) throw new Error("POSIX process admission emitted multiple control frames");
	let value: unknown;
	try {
		value = JSON.parse(lines[0]!);
	} catch (error) {
		throw new Error("POSIX process admission emitted an invalid control frame", { cause: error });
	}
	if (!isRecord(value)) throw new Error("POSIX process admission emitted an invalid control frame");
	const optionalKeys = ["message", "code", "errno", "path", "syscall"].filter((key) => value[key] !== undefined);
	if (
		!hasExactKeys(value, [
			"primeAgentPosixAdmission",
			"type",
			"token",
			"pid",
			"state",
			"exitCode",
			"signal",
			...optionalKeys,
		]) ||
		value.primeAgentPosixAdmission !== POSIX_CONTROL_PROTOCOL_VERSION ||
		value.type !== "target-done" ||
		value.token !== expectedToken ||
		value.pid !== expectedPid ||
		value.state !== "target-done" ||
		!Number.isInteger(value.exitCode) ||
		(value.exitCode as number) < 0 ||
		(value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(value.signal))) ||
		(value.message !== undefined && typeof value.message !== "string") ||
		(value.code !== undefined && typeof value.code !== "string") ||
		(value.errno !== undefined && !Number.isInteger(value.errno)) ||
		(value.path !== undefined && typeof value.path !== "string") ||
		(value.syscall !== undefined && typeof value.syscall !== "string") ||
		(value.message === undefined &&
			(value.code !== undefined ||
				value.errno !== undefined ||
				value.path !== undefined ||
				value.syscall !== undefined))
	) {
		throw new Error("POSIX process admission emitted an invalid control frame");
	}
	const frame = value as unknown as PosixTargetDoneFrame;
	let error: NodeJS.ErrnoException | undefined;
	if (frame.message !== undefined) {
		error = new Error(frame.message) as NodeJS.ErrnoException;
		if (frame.code !== undefined) error.code = frame.code;
		if (frame.errno !== undefined) error.errno = frame.errno;
		if (frame.path !== undefined) error.path = frame.path;
		if (frame.syscall !== undefined) error.syscall = frame.syscall;
	}
	return { exitCode: frame.exitCode, signal: frame.signal, error };
}

function observePosixAdmissionControl(child: ChildProcess, controlToken: string): Promise<PosixTargetDone | undefined> {
	const control = child.stdio[3] as Readable | null | undefined;
	const pid = child.pid;
	if (!control || !pid) return Promise.reject(new Error("POSIX process admission control pipe is unavailable"));
	let payload = "";
	let overflow = false;
	const decoder = new StringDecoder("utf8");
	return new Promise<PosixTargetDone | undefined>((resolveControl, reject) => {
		control.on("data", (chunk: Buffer) => {
			if (overflow) return;
			payload += decoder.write(chunk);
			if (Buffer.byteLength(payload) > POSIX_CONTROL_MAX_BYTES) {
				overflow = true;
				payload = payload.slice(-POSIX_CONTROL_MAX_BYTES);
			}
		});
		control.once("error", (error) => reject(error));
		control.once("end", () => {
			try {
				payload += decoder.end();
				resolveControl(parsePosixTargetDoneFrame(payload, overflow, pid, controlToken));
			} catch (error) {
				reject(error);
			}
		});
	});
}

/**
 * Trusted persistent group leader. Its argv token stays observable for exact
 * portable identity, the target request arrives only after enrollment, and it
 * remains alive after target exit until host-side group-death proof completes.
 * This is lifecycle containment, not a same-user sandbox: deliberate wrapper
 * termination or setsid/setpgid escape by target code is outside the contract.
 */
const POSIX_ADMISSION_WRAPPER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { closeSync, writeSync } = require("node:fs");
const { constants } = require("node:os");
const marker = process.argv[1];
if (
  typeof marker !== "string"
  || marker.length !== 88
  || marker[23] !== "="
  || !/^[a-f0-9]{64}$/.test(marker.slice(24))
) {
  process.stderr.write("prime-agent process admission: invalid owner token\n");
  process.exit(125);
}
const controlToken = marker.slice(24);
process.title = marker;
let input = "";
let released = false;
let cleanupRequested = false;
let targetSettled = false;
function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function failBeforeRelease(message, code = 125) {
  if (released || cleanupRequested) {
    requestCleanup("control failure after release");
    return;
  }
  process.stderr.write("prime-agent process admission: " + message + "\n", () => process.exit(code));
}
function requestCleanup(context) {
  if (cleanupRequested) return;
  cleanupRequested = true;
  process.stdin.pause();
  const kill = () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      try { writeSync(2, "prime-agent process " + context + ": " + error.message + "\n"); } catch {}
      setTimeout(kill, 20);
    }
  };
  kill();
}
function finishTarget(code, signal, error) {
  if (targetSettled) return;
  targetSettled = true;
  const signalNumber = typeof signal === "string" ? constants.signals[signal] : undefined;
  const exitCode = error
    ? (error?.code === "ENOENT" ? 127 : 126)
    : (Number.isInteger(code) && code >= 0
      ? code
      : (Number.isInteger(signalNumber) ? 128 + signalNumber : 1));
  const message = error instanceof Error ? error.message : (error === undefined ? undefined : String(error));
  const frame = {
    primeAgentPosixAdmission: 1,
    type: "target-done",
    token: controlToken,
    pid: process.pid,
    state: "target-done",
    exitCode,
    signal: typeof signal === "string" ? signal : null,
    ...(message !== undefined ? { message } : {}),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}),
    ...(typeof error?.path === "string" ? { path: error.path } : {}),
    ...(typeof error?.syscall === "string" ? { syscall: error.syscall } : {}),
  };
  try {
    if (message !== undefined) writeSync(2, "prime-agent process admission: " + message + "\n");
    writeSync(3, JSON.stringify(frame) + "\n");
  } catch (controlError) {
    try { writeSync(2, "prime-agent process admission control: " + controlError.message + "\n"); } catch {}
  } finally {
    try { closeSync(3); } catch {}
  }
}
function validTargetRequest(request) {
  return request && typeof request === "object" && !Array.isArray(request)
    && sameKeys(request, ["action", "token", "pid", "argv", "cwd", "env"])
    && request.action === "release"
    && request.token === controlToken
    && request.pid === process.pid
    && Array.isArray(request.argv) && request.argv.length > 0
    && request.argv.every((value) => typeof value === "string" && !value.includes("\0"))
    && request.argv[0].length > 0
    && typeof request.cwd === "string" && request.cwd.length > 0 && !request.cwd.includes("\0")
    && request.env && typeof request.env === "object" && !Array.isArray(request.env)
    && Object.entries(request.env).every(([key, value]) =>
      key.length > 0 && !key.includes("=") && !key.includes("\0")
      && typeof value === "string" && !value.includes("\0"));
}
function validCleanupRequest(request) {
  return request && typeof request === "object" && !Array.isArray(request)
    && sameKeys(request, ["action", "token", "pid", "state"])
    && request.action === "cleanup"
    && request.token === controlToken
    && request.pid === process.pid
    && request.state === "cleanup-requested";
}
function launchTarget(request) {
  let child;
  try {
    child = spawn(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: request.env,
      detached: false,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (error) {
    finishTarget(null, null, error);
    return;
  }
  child.once("error", (error) => finishTarget(null, null, error));
  child.once("exit", (code, signal) => finishTarget(code, signal));
}
function acceptControl(payload) {
  let request;
  try {
    request = JSON.parse(payload);
  } catch (error) {
    failBeforeRelease("invalid request: " + error.message);
    return;
  }
  if (validCleanupRequest(request)) {
    requestCleanup("cleanup request");
    return;
  }
  if (!released && validTargetRequest(request)) {
    released = true;
    launchTarget(request);
    return;
  }
  failBeforeRelease("invalid or out-of-sequence request");
}
for (const name of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGUSR1", "SIGUSR2"]) {
  try { process.on(name, () => {}); } catch {}
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (cleanupRequested) return;
  input += chunk;
  if (input.length > 16 * 1024 * 1024) {
    failBeforeRelease("request too large");
    return;
  }
  while (!cleanupRequested) {
    const delimiter = input.indexOf("\n");
    if (delimiter < 0) return;
    const payload = input.slice(0, delimiter);
    input = input.slice(delimiter + 1);
    acceptControl(payload);
  }
});
process.stdin.on("error", (error) => {
  if (released) requestCleanup("control stream failure");
  else failBeforeRelease(error.message);
});
process.stdin.on("end", () => {
  if (released) requestCleanup("parent disconnected");
  else failBeforeRelease("admission request stream ended");
});
`;

async function executePosixContainedProcess(
	options: ContainedProcessExecutionOptions,
): Promise<ContainedProcessExecutionResult> {
	assertProcessRequest(options);
	const ownerIdentity = createProcessIdentityOwnerToken();
	const controlToken = ownerIdentity.argument.slice("prime-agent-owner-token=".length);
	if (!/^[a-f0-9]{64}$/.test(controlToken)) {
		throw new Error("POSIX process containment owner token is invalid");
	}
	const child = spawn(process.execPath, ["-e", POSIX_ADMISSION_WRAPPER_SOURCE, ownerIdentity.argument], {
		cwd: dirname(process.execPath),
		detached: true,
		// The trusted admission wrapper gets no caller-controlled loader/startup hooks.
		env: { PATH: "/usr/bin:/bin" },
		stdio: ["pipe", "pipe", "pipe", "pipe"],
	});
	if (options.onStdout) child.stdout?.on("data", options.onStdout);
	else child.stdout?.resume();
	if (options.onStderr) child.stderr?.on("data", options.onStderr);
	else child.stderr?.resume();
	child.stdin?.on("error", () => {});
	const controlWriter = new PosixControlWriter(child);
	const completion = waitForChildProcess(child);

	const pid = child.pid;
	if (!pid) {
		const error = new Error("Process admission wrapper did not expose a process id");
		controlWriter.terminate(error);
		await completion;
		throw error;
	}
	const controlCompletion = observePosixAdmissionControl(child, controlToken).then(
		(targetDone) => ({ targetDone }),
		(protocolError: unknown) => ({
			protocolError: protocolError instanceof Error ? protocolError : new Error(String(protocolError)),
		}),
	);

	let observed: ExactProcessCandidate | undefined;
	let enrollment: ReturnType<typeof enrollTrackedDetachedChildPid> | undefined;
	let cleanupPromise: Promise<boolean> | undefined;
	const cleanupCandidate = (): ActiveOrphanProcessCandidate => enrollment ?? observed ?? { pid };
	const requestTermination = () => {
		cleanupPromise ??= requestPosixWrapperCleanup(child, cleanupCandidate(), completion, controlToken, controlWriter);
	};
	try {
		observed = exactCandidate(pid);
		if (observed.processStartId.startsWith("token:") && observed.processStartId !== ownerIdentity.processStartId) {
			throw new Error(`Gated process owner token changed before enrollment: ${pid}`);
		}
		enrollment = enrollTrackedDetachedChildPid(pid, requestTermination, observed.processStartId);
		if (enrollment.processStartId !== observed.processStartId) {
			throw new Error(`Gated process identity changed before enrollment: ${pid}`);
		}
	} catch (error) {
		requestTermination();
		const exactDead = await cleanupPromise;
		if (exactDead) {
			await withTimeout(
				controlCompletion,
				POSIX_CLEANUP_TIMEOUT_MS,
				`Timed out draining containment-wrapper control for ${pid}`,
			).catch(() => undefined);
		}
		if (!exactDead && !enrollment) {
			throw new Error(`Failed process enrollment left no durable authority and death is unproved for ${pid}`, {
				cause: error,
			});
		}
		throw error;
	}

	let timedOut = false;
	let aborted = options.signal?.aborted === true;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const onAbort = () => {
		aborted = true;
		requestTermination();
	};
	if (options.signal) {
		if (aborted) requestTermination();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			requestTermination();
		}, options.timeoutMs);
	}

	const retireAfterExactDeath = (exactDead: boolean) => {
		if (!exactDead) return;
		try {
			untrackDetachedChildPid(enrollment!);
		} catch {
			// Exact process-group death is known, but journal retirement uncertainty stays durable.
		}
	};
	try {
		if (!aborted) {
			await controlWriter.write(
				{
					action: "release",
					token: controlToken,
					pid,
					argv: options.argv,
					cwd: options.cwd,
					env: options.env,
				},
				"release",
				POSIX_CLEANUP_TIMEOUT_MS,
				`Timed out releasing containment wrapper ${pid}`,
			);
		}
		const control = await controlCompletion;
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		if ("protocolError" in control) throw control.protocolError;
		if (!control.targetDone && !timedOut && !aborted) {
			// FD 3 can close just before the child exit event. Let an unexpectedly
			// dead wrapper become observable before deciding whether its stdin still
			// carries private cleanup authority.
			await withTimeout(completion, 25, `Containment wrapper ${pid} is still running`).catch(() => undefined);
		}
		requestTermination();
		const cleanup = cleanupPromise;
		if (!cleanup) throw new Error(`Process cleanup did not start for ${pid}`);
		const exactDead = await cleanup;
		retireAfterExactDeath(exactDead);
		if (!exactDead) {
			throw new Error(`Process-group cleanup retained authority for ${pid}; exact wrapper/group death is unproved`);
		}
		const wrapperExitCode = await completion;
		if (!control.targetDone && !timedOut && !aborted) {
			throw new Error(`Process admission wrapper exited without target status for ${pid}`);
		}
		return {
			exitCode: control.targetDone ? control.targetDone.exitCode : wrapperExitCode,
			signal: control.targetDone ? control.targetDone.signal : child.signalCode,
			error: control.targetDone?.error,
			timedOut,
			aborted,
			outputMode: "separate",
		};
	} catch (error) {
		requestTermination();
		const cleanup = cleanupPromise;
		if (!cleanup) throw new Error(`Process cleanup did not start for ${pid}`, { cause: error });
		retireAfterExactDeath(await cleanup);
		throw error;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		controlWriter.close();
	}
}

/** Minimal bootstrap environment: no inherited Python, loader, shell, or authority routing. */
export function createWindowsJobHelperEnvironment(_source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const systemRoot = "C:\\Windows";
	const system32 = win32.join(systemRoot, "System32");
	return {
		SystemRoot: systemRoot,
		WINDIR: systemRoot,
		PATH: system32,
		ComSpec: win32.join(system32, "cmd.exe"),
		NoDefaultCurrentDirectoryInExePath: "1",
	};
}

export interface WindowsJobHelperLaunch {
	python: string;
	helper: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Resolve the launch as data only. This performs no Python execution probe. */
export async function prepareWindowsJobHelperLaunch(
	source: NodeJS.ProcessEnv = process.env,
): Promise<WindowsJobHelperLaunch> {
	const helper = await resolveWindowsJobHelperPath();
	return {
		python: resolveWindowsJobBootstrapPythonPath(),
		helper,
		args: ["-I", "-S", "-X", "utf8", helper],
		cwd: dirname(helper),
		env: createWindowsJobHelperEnvironment(source),
	};
}

function writeWindowsControl(child: ChildProcess, value: Record<string, unknown>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const stdin = child.stdin;
		if (!stdin || stdin.destroyed) {
			reject(new Error("Windows process containment helper control pipe is closed"));
			return;
		}
		stdin.write(`${JSON.stringify(value)}\n`, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function waitForWindowsDone(queue: WindowsJobFrameQueue): Promise<{
	done: WindowsDoneFrame;
	error?: WindowsErrorFrame;
}> {
	let helperError: WindowsErrorFrame | undefined;
	while (true) {
		const frame = await queue.next(["done", "error"], WINDOWS_CLEANUP_TIMEOUT_MS);
		if (frame.type === "error") {
			helperError ??= frame;
			continue;
		}
		if (frame.type === "done") return { done: frame, error: helperError };
	}
}

export function windowsJobFramesProveExactDeath(done: WindowsJobFrame, ready: WindowsJobFrame): boolean {
	return (
		done.type === "done" &&
		ready.type === "ready" &&
		done.nonce === ready.nonce &&
		done.pid === ready.pid &&
		done.processStartId === ready.processStartId &&
		done.leaderDead &&
		done.jobEmpty
	);
}

async function forceStopWindowsHelper(child: ChildProcess, completion: Promise<number | null>): Promise<void> {
	try {
		child.kill();
	} catch {
		// A completed helper has already closed its kill-on-close Job handle.
	}
	try {
		await withTimeout(
			completion,
			WINDOWS_HELPER_EXIT_TIMEOUT_MS,
			"Windows process containment helper did not exit after direct termination",
		);
	} catch {
		// The enrolled process identity remains active in the durable journal.
	}
}

async function executeWindowsContainedProcess(
	options: ContainedProcessExecutionOptions,
): Promise<ContainedProcessExecutionResult> {
	assertProcessRequest(options);
	const launch = await prepareWindowsJobHelperLaunch();
	const nonce = randomBytes(32).toString("hex");
	const helper = spawn(launch.python, launch.args, {
		cwd: launch.cwd,
		env: launch.env,
		detached: false,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	helper.stdin?.on("error", () => {});
	// _winjob deliberately sends the child's stdout and stderr through one pipe.
	if (options.onStdout) helper.stdout?.on("data", options.onStdout);
	else helper.stdout?.resume();
	const frames = new WindowsJobFrameQueue(nonce);
	helper.stderr?.on("data", (chunk: Buffer) => frames.push(chunk));
	helper.stderr?.once("end", () => frames.end());
	const helperCompletion = waitForChildProcess(helper);
	helperCompletion.then(
		(code) => frames.close(new Error(`Windows process containment helper exited before proof (code ${code})`)),
		(error: unknown) => frames.close(error instanceof Error ? error : new Error(String(error))),
	);

	let ready: WindowsReadyFrame | undefined;
	let enrollment: ReturnType<typeof enrollTrackedDetachedChildPid> | undefined;
	let released = false;
	let helperSettled = false;
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	let terminationRequested = false;
	const requestTermination = () => {
		if (terminationRequested) return;
		terminationRequested = true;
		frames.noteTerminationRequested();
		void writeWindowsControl(helper, {
			action: "terminate",
			nonce,
			...(ready ? { pid: ready.pid, processStartId: ready.processStartId } : {}),
		}).catch(() => undefined);
	};
	const onAbort = () => requestTermination();

	try {
		await writeWindowsControl(helper, {
			version: WINDOWS_PROTOCOL_VERSION,
			nonce,
			ownerPid: process.pid,
			argv: options.argv,
			cwd: options.cwd,
			env: options.env,
		});
		const admission = await frames.next(["ready", "error"], WINDOWS_ADMISSION_TIMEOUT_MS);
		if (admission.type === "error") {
			throw new Error(`Windows process containment failed during ${admission.stage}: ${admission.message}`);
		}
		if (admission.type !== "ready") throw new Error("Windows process containment helper omitted its ready proof");
		ready = admission;
		enrollment = enrollTrackedDetachedChildPid(ready.pid, requestTermination, ready.processStartId);
		if (enrollment.processStartId !== ready.processStartId) {
			throw new Error(`Windows process identity changed before enrollment: ${ready.pid}`);
		}

		if (options.signal) {
			if (options.signal.aborted) requestTermination();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (!options.signal?.aborted) {
			frames.noteReleaseRequested();
			await writeWindowsControl(helper, {
				action: "release",
				nonce,
				pid: ready.pid,
				processStartId: ready.processStartId,
			});
			const release = await frames.next(["released", "error"], WINDOWS_ADMISSION_TIMEOUT_MS);
			if (release.type === "error") {
				throw new Error(`Windows process containment failed during ${release.stage}: ${release.message}`);
			}
			if (
				release.type !== "released" ||
				release.pid !== ready.pid ||
				release.processStartId !== ready.processStartId
			) {
				throw new Error("Windows process containment helper released the wrong process identity");
			}
			released = true;
			if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					requestTermination();
				}, options.timeoutMs);
			}
		}

		const settled = await waitForWindowsDone(frames);
		const helperExitCode = await withTimeout(
			helperCompletion,
			WINDOWS_CLEANUP_TIMEOUT_MS,
			"Windows process containment helper did not exit after reporting cleanup",
		);
		const exactDead = windowsJobFramesProveExactDeath(settled.done, ready);
		helperSettled = true;
		if (exactDead) {
			try {
				untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollment!);
			} catch {
				// The exact Job/leader death proof is valid; failed journal retirement remains active.
			}
		}
		if (settled.error) {
			throw new Error(`Windows process containment failed during ${settled.error.stage}: ${settled.error.message}`);
		}
		if (!exactDead) {
			throw new Error(
				`Windows process containment cleanup retained uncertainty for process ${ready.pid}: ` +
					`leaderDead=${settled.done.leaderDead}, jobEmpty=${settled.done.jobEmpty}`,
			);
		}
		if (helperExitCode !== 0) {
			throw new Error(`Windows process containment helper exited with code ${helperExitCode}`);
		}
		return {
			exitCode: settled.done.exitCode,
			signal: null,
			timedOut,
			aborted: options.signal?.aborted === true,
			outputMode: "merged",
		};
	} catch (error) {
		if (helperSettled) throw error;
		requestTermination();
		if (ready) {
			try {
				const settled = await waitForWindowsDone(frames);
				await withTimeout(
					helperCompletion,
					WINDOWS_CLEANUP_TIMEOUT_MS,
					"Windows process containment helper did not exit during failed admission cleanup",
				);
				if (enrollment && windowsJobFramesProveExactDeath(settled.done, ready)) {
					try {
						untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollment);
					} catch {
						// Retirement uncertainty remains in the journal.
					}
				}
			} catch {
				await forceStopWindowsHelper(helper, helperCompletion);
			}
		} else {
			try {
				const setup = await frames.next(["setup-done", "done"], WINDOWS_CLEANUP_TIMEOUT_MS);
				await withTimeout(
					helperCompletion,
					WINDOWS_CLEANUP_TIMEOUT_MS,
					"Windows process containment helper did not exit after setup cleanup",
				);
				if ((setup.type !== "setup-done" && setup.type !== "done") || !setup.leaderDead || !setup.jobEmpty) {
					throw new Error("Windows process containment setup cleanup did not prove an empty Job");
				}
			} catch {
				// Atomic spawn failure means no target exists; otherwise helper exit
				// closes the canonical kill-on-close Job as the final authority.
				await forceStopWindowsHelper(helper, helperCompletion);
			}
		}
		throw error;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		if (!released) helper.stdin?.end();
		else helper.stdin?.destroy();
	}
}

export async function executeContainedProcess(
	options: ContainedProcessExecutionOptions,
): Promise<ContainedProcessExecutionResult> {
	if (!supportsExactProcessIdentityPlatform()) {
		throw new Error(`Contained process exact-identity probe unavailable: unsupported platform ${process.platform}`);
	}
	const containedOptions = {
		...options,
		cwd: resolve(options.cwd),
		env: withoutOrphanProcessJournalAuthority(options.env),
	};
	return process.platform === "win32"
		? executeWindowsContainedProcess(containedOptions)
		: executePosixContainedProcess(containedOptions);
}

/** Thin command-shell adapter over the canonical argv containment primitive. */
export async function executeContainedShell(
	options: ContainedShellExecutionOptions,
): Promise<{ exitCode: number | null }> {
	const result = await executeContainedProcess({
		argv: [options.shell, ...options.args, options.command],
		cwd: options.cwd,
		env: options.env,
		onStdout: options.onData,
		onStderr: options.onData,
		signal: options.signal,
		timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
	});
	if (result.aborted) throw new Error("aborted");
	if (result.timedOut) throw new Error(`timeout:${options.timeout}`);
	if (result.error) throw result.error;
	return { exitCode: result.exitCode };
}
