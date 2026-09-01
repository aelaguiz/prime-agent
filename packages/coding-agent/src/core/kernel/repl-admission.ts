import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isExactProcessStartId } from "../session-lease.js";
import {
	getKernelVenvPythonPath,
	resolveWindowsJobBootstrapPythonPath,
	resolveWindowsJobHelperPath,
} from "./bootstrap.js";

export const WINDOWS_PERSISTENT_REPL_PROTOCOL_VERSION = 1;
const WINDOWS_PERSISTENT_REPL_CONTROL_MAX_BYTES = 16 * 1024;

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

/**
 * Resolve the configured REPL interpreter without starting Python. Import/site
 * readiness is proved only by the admitted target's protocol handshake.
 */
export function resolveReplPythonWithoutExecution(configuredPython?: string): string {
	const configured = configuredPython ?? process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (configured !== undefined && (!configured || configured.includes("\0"))) {
		throw new Error("Configured kernel Python path is empty or contains NUL");
	}
	// Deliberately syntax-only. The admitted gate performs the first target
	// access/chdir after its exact durable enrollment has been acknowledged.
	return configured === undefined ? getKernelVenvPythonPath() : path.resolve(expandHome(configured));
}

export interface WindowsPersistentReplExpectedIdentity {
	admissionGeneration: string;
	targetToken: string;
}

export interface WindowsPersistentReplTargetIdentity extends WindowsPersistentReplExpectedIdentity {
	targetPid: number;
	processStartId: string;
}

export type WindowsPersistentReplFrame =
	| (WindowsPersistentReplTargetIdentity & {
			type: "target-pending";
			jobContained: true;
	  })
	| (WindowsPersistentReplTargetIdentity & { type: "target-released" })
	| (WindowsPersistentReplTargetIdentity & {
			type: "target-done";
			exitCode: number;
			leaderDead: true;
			jobEmpty: true;
			jobTerminationAttempted: boolean;
			jobTerminationSucceeded: boolean;
			taskkillFallbackAttempted: boolean;
	  })
	| (WindowsPersistentReplExpectedIdentity & {
			type: "error";
			stage: string;
			message: string;
	  });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function hasExpectedAdmissionIdentity(
	value: Record<string, unknown>,
	expected: WindowsPersistentReplExpectedIdentity,
): boolean {
	return (
		value.primeAgentWindowsRepl === WINDOWS_PERSISTENT_REPL_PROTOCOL_VERSION &&
		value.admissionGeneration === expected.admissionGeneration &&
		value.targetToken === expected.targetToken
	);
}

function parseTargetIdentity(
	value: Record<string, unknown>,
	expected: WindowsPersistentReplExpectedIdentity,
): WindowsPersistentReplTargetIdentity | undefined {
	if (
		!hasExpectedAdmissionIdentity(value, expected) ||
		typeof value.targetPid !== "number" ||
		!Number.isSafeInteger(value.targetPid) ||
		value.targetPid <= 0 ||
		typeof value.processStartId !== "string" ||
		!isExactProcessStartId(value.processStartId)
	) {
		return undefined;
	}
	return {
		admissionGeneration: expected.admissionGeneration,
		targetToken: expected.targetToken,
		targetPid: value.targetPid,
		processStartId: value.processStartId,
	};
}

/** Strict parser for the helper-only persistent REPL authority stream. */
export function parseWindowsPersistentReplFrame(
	line: string,
	expected: WindowsPersistentReplExpectedIdentity,
): WindowsPersistentReplFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Windows persistent REPL helper emitted invalid JSON", { cause: error });
	}
	if (!isRecord(value) || !hasExpectedAdmissionIdentity(value, expected) || typeof value.type !== "string") {
		throw new Error("Windows persistent REPL helper emitted a stale or unbound frame");
	}
	const baseKeys = ["primeAgentWindowsRepl", "type", "admissionGeneration", "targetToken"];
	if (value.type === "error") {
		if (
			!hasExactKeys(value, [...baseKeys, "stage", "message"]) ||
			typeof value.stage !== "string" ||
			!value.stage ||
			typeof value.message !== "string" ||
			!value.message
		) {
			throw new Error("Windows persistent REPL helper emitted an invalid error frame");
		}
		return {
			type: "error",
			admissionGeneration: expected.admissionGeneration,
			targetToken: expected.targetToken,
			stage: value.stage,
			message: value.message,
		};
	}
	const identity = parseTargetIdentity(value, expected);
	if (!identity) throw new Error("Windows persistent REPL helper emitted an invalid target identity");
	const identityKeys = [...baseKeys, "targetPid", "processStartId"];
	if (value.type === "target-pending") {
		if (!hasExactKeys(value, [...identityKeys, "jobContained"]) || value.jobContained !== true) {
			throw new Error("Windows persistent REPL helper emitted an invalid suspended-target frame");
		}
		return { type: "target-pending", ...identity, jobContained: true };
	}
	if (value.type === "target-released") {
		if (!hasExactKeys(value, identityKeys)) {
			throw new Error("Windows persistent REPL helper emitted an invalid release frame");
		}
		return { type: "target-released", ...identity };
	}
	if (value.type === "target-done") {
		const proofBooleans = [
			"jobTerminationAttempted",
			"jobTerminationSucceeded",
			"taskkillFallbackAttempted",
		] as const;
		if (
			!hasExactKeys(value, [...identityKeys, "exitCode", "leaderDead", "jobEmpty", ...proofBooleans]) ||
			typeof value.exitCode !== "number" ||
			!Number.isSafeInteger(value.exitCode) ||
			value.leaderDead !== true ||
			value.jobEmpty !== true ||
			proofBooleans.some((key) => typeof value[key] !== "boolean")
		) {
			throw new Error("Windows persistent REPL helper emitted an invalid Job cleanup frame");
		}
		return {
			type: "target-done",
			...identity,
			exitCode: value.exitCode,
			leaderDead: true,
			jobEmpty: true,
			jobTerminationAttempted: value.jobTerminationAttempted as boolean,
			jobTerminationSucceeded: value.jobTerminationSucceeded as boolean,
			taskkillFallbackAttempted: value.taskkillFallbackAttempted as boolean,
		};
	}
	throw new Error(`Windows persistent REPL helper emitted unknown frame type ${value.type}`);
}

type WindowsPersistentReplFrameType = WindowsPersistentReplFrame["type"];

/** Stateful reader: one pending -> released? -> done identity, with bound errors. */
export class WindowsPersistentReplFrameStream {
	private readonly decoder = new StringDecoder("utf8");
	private buffered = "";
	private bytesSeen = 0;
	private phase: "awaiting-pending" | "suspended" | "running" | "done" = "awaiting-pending";
	private target?: WindowsPersistentReplTargetIdentity;
	private readonly frames: WindowsPersistentReplFrame[] = [];
	private readonly waiters = new Set<{
		types: Set<WindowsPersistentReplFrameType>;
		resolve: (frame: WindowsPersistentReplFrame) => void;
		reject: (error: Error) => void;
		timer?: ReturnType<typeof setTimeout>;
	}>();
	private failure?: Error;

	constructor(
		private readonly output: Readable,
		private readonly expected: WindowsPersistentReplExpectedIdentity,
	) {
		output.on("data", this.onData);
		output.once("error", this.onError);
		output.once("end", this.onEnd);
	}

	async next(
		types: readonly WindowsPersistentReplFrameType[],
		timeoutMs: number,
	): Promise<WindowsPersistentReplFrame> {
		if (this.failure) throw this.failure;
		const accepted = new Set(types);
		const index = this.frames.findIndex((frame) => accepted.has(frame.type));
		if (index >= 0) return this.frames.splice(index, 1)[0]!;
		return new Promise<WindowsPersistentReplFrame>((resolve, reject) => {
			const waiter: {
				types: Set<WindowsPersistentReplFrameType>;
				resolve: (frame: WindowsPersistentReplFrame) => void;
				reject: (error: Error) => void;
				timer?: ReturnType<typeof setTimeout>;
			} = { types: accepted, resolve, reject };
			if (timeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Windows persistent REPL control timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				waiter.timer.unref?.();
			}
			this.waiters.add(waiter);
		});
	}

	destroy(): void {
		this.output.off("data", this.onData);
		this.output.off("error", this.onError);
		this.output.off("end", this.onEnd);
		this.output.destroy();
		this.fail(new Error("Windows persistent REPL control stream closed"));
	}

	private readonly onData = (chunk: Buffer) => {
		this.bytesSeen += chunk.length;
		if (this.bytesSeen > WINDOWS_PERSISTENT_REPL_CONTROL_MAX_BYTES) {
			this.fail(new Error("Windows persistent REPL control stream exceeded its bound"));
			return;
		}
		this.buffered += this.decoder.write(chunk);
		let newline = this.buffered.indexOf("\n");
		while (newline >= 0 && !this.failure) {
			const line = this.buffered.slice(0, newline).replace(/\r$/, "");
			this.buffered = this.buffered.slice(newline + 1);
			try {
				this.accept(parseWindowsPersistentReplFrame(line, this.expected));
			} catch (error) {
				this.fail(error);
				return;
			}
			newline = this.buffered.indexOf("\n");
		}
	};

	private readonly onError = (error: Error) => this.fail(error);
	private readonly onEnd = () => {
		this.buffered += this.decoder.end();
		if (this.buffered) {
			try {
				this.accept(parseWindowsPersistentReplFrame(this.buffered.replace(/\r$/, ""), this.expected));
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
		if (this.phase !== "done") this.fail(new Error("Windows persistent REPL helper ended before Job proof"));
	};

	private accept(frame: WindowsPersistentReplFrame): void {
		if (frame.type !== "error") {
			if (frame.type === "target-pending") {
				if (this.phase !== "awaiting-pending") throw new Error("Windows target-pending frame is out of sequence");
				this.target = frame;
				this.phase = "suspended";
			} else {
				if (
					!this.target ||
					frame.targetPid !== this.target.targetPid ||
					frame.processStartId !== this.target.processStartId
				) {
					throw new Error("Windows persistent REPL helper changed target identity");
				}
				if (frame.type === "target-released") {
					if (this.phase !== "suspended") throw new Error("Windows target release is out of sequence");
					this.phase = "running";
				} else {
					if (this.phase !== "suspended" && this.phase !== "running") {
						throw new Error("Windows target Job proof is out of sequence");
					}
					this.phase = "done";
				}
			}
		}
		const waiter = [...this.waiters].find((candidate) => candidate.types.has(frame.type));
		if (waiter) {
			this.waiters.delete(waiter);
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(frame);
		} else {
			this.frames.push(frame);
		}
	}

	private fail(error: unknown): void {
		if (this.failure) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		for (const waiter of this.waiters) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.reject(this.failure);
		}
		this.waiters.clear();
	}
}

export const WINDOWS_PERSISTENT_REPL_CONTROL_INPUT_FD = 3;
export const WINDOWS_PERSISTENT_REPL_CONTROL_OUTPUT_FD = 4;

export interface WindowsPersistentReplHelperLaunch {
	python: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface WindowsPersistentReplHelperLaunchOptions {
	/** Internal test seam. Production always uses the install-owned default venv. */
	trustedVenvDir?: string;
	/** Internal test seam for exercising launch data on non-Windows hosts. */
	platform?: NodeJS.Platform;
}

/**
 * Prepare a site-free bundled helper launch. Control is the exact spawned
 * child's anonymous fd3/fd4 pair; no rendezvous name or second connector exists.
 */
export async function prepareWindowsPersistentReplHelperLaunch(
	options: WindowsPersistentReplHelperLaunchOptions = {},
): Promise<WindowsPersistentReplHelperLaunch> {
	if ((options.platform ?? process.platform) !== "win32") {
		throw new Error("Windows persistent REPL helper launch is only available on Windows");
	}
	if (
		options.trustedVenvDir !== undefined &&
		(!options.trustedVenvDir || options.trustedVenvDir.includes("\0") || !path.isAbsolute(options.trustedVenvDir))
	) {
		throw new Error("Trusted Windows Job helper venv must be an absolute path without NUL");
	}
	const helper = await resolveWindowsJobHelperPath();
	const python = resolveWindowsJobBootstrapPythonPath(options.trustedVenvDir);
	return {
		python,
		args: ["-I", "-S", "-X", "utf8", helper, "--persistent-repl"],
		cwd: path.dirname(helper),
		env: {
			SystemRoot: "C:\\Windows",
			WINDIR: "C:\\Windows",
			PATH: "C:\\Windows\\System32",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			NoDefaultCurrentDirectoryInExePath: "1",
		},
	};
}

export function writeWindowsPersistentReplControl(input: Writable, value: Record<string, unknown>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (input.destroyed) {
			reject(new Error("Windows persistent REPL helper control input is closed"));
			return;
		}
		input.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
