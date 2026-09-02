import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { type AuthorityMutationGuard, acquireAuthorityMutationGuard } from "./authority-mutation-guard.js";
import { recordProcessLifecycle } from "./process-lifecycle.js";

export { AuthorityGuardCompromisedError } from "./authority-mutation-guard.js";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";
export const PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX = "prime-agent-owner-token=";
const PORTABLE_PROCESS_IDENTITY_HINT_PREFIX = "ps:lstart:";
export const PORTABLE_PROCESS_IDENTITY_HINT_MAX_PAYLOAD_BYTES = 1_024;

/** Canonicalizes producer-valid diagnostic identity hints; hints are never signal authority. */
export function normalizePortableProcessIdentityHint(value: string): string | undefined {
	if (!value.startsWith(PORTABLE_PROCESS_IDENTITY_HINT_PREFIX)) return undefined;
	const payload = value.slice(PORTABLE_PROCESS_IDENTITY_HINT_PREFIX.length);
	if (!payload || /[^\x20-\x7e]/.test(payload)) return undefined;
	const payloadBytes = Buffer.from(payload, "utf8");
	if (
		payloadBytes.length > PORTABLE_PROCESS_IDENTITY_HINT_MAX_PAYLOAD_BYTES ||
		new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes) !== payload
	) {
		return undefined;
	}
	const normalized = payload.replace(/^[ \t\f\v]+|[ \t\f\v]+$/g, "").replace(/[ \t\f\v]+/g, " ");
	return normalized && normalized === payload ? `${PORTABLE_PROCESS_IDENTITY_HINT_PREFIX}${normalized}` : undefined;
}

/** Retains bounded old-schema process evidence without promoting it to signal authority. */
export function normalizeRetainedLegacyProcessStartId(value: string): string | undefined {
	if (value.startsWith("proc:")) {
		const ticks = value.slice("proc:".length);
		return isCanonicalUint64ProcessStartTicks(ticks) ? `proc:${ticks}` : undefined;
	}
	if (!value.startsWith("ps:")) return undefined;
	const payload = value.slice("ps:".length);
	if (!payload || /[\x00-\x1f\x7f-\x9f]/.test(payload)) return undefined;
	const bytes = Buffer.from(payload, "utf8");
	return bytes.length <= PORTABLE_PROCESS_IDENTITY_HINT_MAX_PAYLOAD_BYTES &&
		new TextDecoder("utf-8", { fatal: true }).decode(bytes) === payload
		? value
		: undefined;
}

/**
 * Creates one parent-held capability and the argv marker its gated child must
 * keep for its full lifetime. The marker is exact only when observed as its own
 * delimiter-bounded argv token.
 */
export function createProcessIdentityOwnerToken(): { argument: string; processStartId: string } {
	const token = randomBytes(32).toString("hex");
	return {
		argument: `${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${token}`,
		processStartId: `token:${token}`,
	};
}

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	/** Optional pre-move projection; new exact identity lives in authorityProcessStartId. */
	processStartId?: string;
	/** Diagnostic only; this hint never proves identity equality or mismatch. */
	processIdentityHint?: string;
	authorityProcessStartId?: string;
	authorityProcessIdentityHint?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;

	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(
			activeSessionId
				? `Session is already active in ${activeSessionId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

export class SessionLeaseOwnershipLostError extends Error {
	readonly code = "session_lease_lost" as const;

	constructor(readonly sessionPath: string) {
		super(`Session lease ownership was lost: ${sessionPath}`);
		this.name = "SessionLeaseOwnershipLostError";
	}
}

const sessionLeaseBrand = Symbol("SessionLease.authority");

interface SessionLeaseState {
	readonly self: SessionLease;
	readonly sessionPath: string;
	readonly directory: string;
	readonly expectedOwner: Readonly<SessionLeaseOwner>;
	released: boolean;
	lost: boolean;
}

export class SessionLease {
	readonly #state: SessionLeaseState;

	private constructor(sessionPath: string, directory: string, expectedOwner: SessionLeaseOwner, brand: symbol) {
		if (brand !== sessionLeaseBrand) throw new Error("SessionLease can only be created by acquisition");
		this.#state = {
			self: this,
			sessionPath,
			directory,
			expectedOwner: Object.freeze({ ...expectedOwner }),
			released: false,
			lost: false,
		};
	}

	get sessionPath(): string {
		return this.#state.sessionPath;
	}

	static acquire(
		sessionPath: string | undefined,
		agentDir: string,
		environment: NodeJS.ProcessEnv = process.env,
	): SessionLease | undefined {
		if (!sessionPath || !leasesEnabled(environment)) return undefined;
		const canonicalPath = canonicalSessionPath(sessionPath);
		const root = join(agentDir, "session-leases");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const directory = leaseDirectory(agentDir, canonicalPath);

		return withLeaseGuard(directory, (guard) => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const token = randomUUID();
				const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
				const currentIdentity = getCurrentProcessIdentityObservation();
				if (currentIdentity.status !== "present-exact" && currentIdentity.status !== "present-coarse") {
					throw new Error(`Session lease exact-identity probe unavailable (${currentIdentity.status})`);
				}
				const exactLegacyProjection =
					currentIdentity.status === "present-exact" ? projectLegacyProcessStartId(currentIdentity.id) : undefined;
				const owner: SessionLeaseOwner = {
					version: 1,
					token,
					pid: process.pid,
					...(exactLegacyProjection !== undefined ? { processStartId: exactLegacyProjection } : {}),
					...(currentIdentity.status === "present-exact" ? { authorityProcessStartId: currentIdentity.id } : {}),
					...(currentIdentity.status === "present-coarse"
						? { authorityProcessIdentityHint: currentIdentity.hint }
						: {}),
					activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
					sessionPath: canonicalPath,
					createdAt: new Date().toISOString(),
				};
				mkdirSync(candidateDirectory, { mode: 0o700 });
				writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
					mode: 0o600,
				});
				try {
					if (existsSync(directory)) throw Object.assign(new Error("Session lease exists"), { code: "EEXIST" });
					guard.assertCurrent();
					renameSync(candidateDirectory, directory);
					return new SessionLease(canonicalPath, directory, owner, sessionLeaseBrand);
				} catch (error) {
					rmSync(candidateDirectory, { recursive: true, force: true });
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
					const existingOwner = readLeaseOwner(directory);
					if (!existingOwner || !reclaimExactDeadLease(directory, existingOwner, guard)) {
						throw new SessionAlreadyActiveError(canonicalPath, existingOwner?.activeSessionId);
					}
				}
			}

			const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
			if (existsSync(directory)) throw new SessionAlreadyActiveError(canonicalPath, owner?.activeSessionId);
			throw new Error(`Could not acquire session lease: ${canonicalPath}`);
		});
	}

	release(): void {
		const state = this.#state;
		if (state.self !== this) throw new TypeError("Invalid SessionLease receiver");
		if (state.released) return;
		if (state.lost) throw new SessionLeaseOwnershipLostError(state.sessionPath);
		try {
			withLeaseGuard(state.directory, (guard) => {
				const owner = readLeaseOwner(state.directory);
				if (!owner || !matchesExpectedSessionLeaseOwner(state, owner) || !isSessionLeaseSelfOwnedCurrent(owner)) {
					throw new SessionLeaseOwnershipLostError(state.sessionPath);
				}
				const finalOwner = readLeaseOwner(state.directory);
				if (!finalOwner || !matchesExpectedSessionLeaseOwner(state, finalOwner)) {
					throw new SessionLeaseOwnershipLostError(state.sessionPath);
				}
				guard.assertCurrent();
				rmSync(state.directory, { recursive: true, force: true });
			});
			state.released = true;
		} catch (error) {
			state.lost = true;
			throw error;
		}
	}
}

function matchesExpectedSessionLeaseOwner(state: SessionLeaseState, owner: Readonly<SessionLeaseOwner>): boolean {
	return owner.sessionPath === state.sessionPath && sameSessionLeaseAuthority(owner, state.expectedOwner);
}

function isSessionLeaseSelfOwnedCurrent(owner: Readonly<SessionLeaseOwner>): boolean {
	const identity = sessionLeaseProcessIdentity(owner);
	if (identity.pid !== process.pid) return false;
	if (identity.processStartId) {
		return isExactProcessStartId(identity.processStartId)
			? matchesExactProcessIdentity(identity.pid, identity.processStartId)
			: false;
	}
	if (identity.processIdentityHint) {
		const observation = observeProcessIdentity(identity.pid);
		return observation.status === "present-coarse" || observation.status === "present-exact";
	}
	return false;
}

function leasesEnabled(environment: NodeJS.ProcessEnv): boolean {
	const value = environment[SESSION_LEASES_ENABLED_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function hasConsistentLeaseOwnerIdentity(owner: Partial<SessionLeaseOwner>): boolean {
	const legacyStart = owner.processStartId;
	const legacyHint = owner.processIdentityHint;
	const authorityStart = owner.authorityProcessStartId;
	const authorityHint = owner.authorityProcessIdentityHint;
	if (legacyStart !== undefined && legacyHint !== undefined) return false;
	if (authorityStart !== undefined && authorityHint !== undefined) return false;
	if (legacyHint !== undefined && normalizePortableProcessIdentityHint(legacyHint) !== legacyHint) return false;
	if (authorityStart !== undefined) {
		if (!isExactProcessStartId(authorityStart) || legacyHint !== undefined) return false;
		if (legacyStart !== undefined && projectLegacyProcessStartId(authorityStart) !== legacyStart) return false;
	}
	if (authorityHint !== undefined) {
		if (normalizePortableProcessIdentityHint(authorityHint) !== authorityHint || legacyStart !== undefined)
			return false;
		if (legacyHint !== undefined && legacyHint !== authorityHint) return false;
	}
	return true;
}

function readLeaseOwner(directory: string): SessionLeaseOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			parsed.token.length === 0 ||
			!Number.isInteger(parsed.pid) ||
			(parsed.pid ?? 0) <= 0 ||
			(parsed.processStartId !== undefined &&
				(typeof parsed.processStartId !== "string" || parsed.processStartId.length === 0)) ||
			(parsed.processIdentityHint !== undefined &&
				(typeof parsed.processIdentityHint !== "string" || parsed.processIdentityHint.length === 0)) ||
			(parsed.authorityProcessStartId !== undefined &&
				(typeof parsed.authorityProcessStartId !== "string" || parsed.authorityProcessStartId.length === 0)) ||
			(parsed.authorityProcessIdentityHint !== undefined &&
				(typeof parsed.authorityProcessIdentityHint !== "string" ||
					parsed.authorityProcessIdentityHint.length === 0)) ||
			!hasConsistentLeaseOwnerIdentity(parsed) ||
			(parsed.activeSessionId !== undefined && typeof parsed.activeSessionId !== "string") ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return undefined;
		}
		return parsed as SessionLeaseOwner;
	} catch {
		return undefined;
	}
}

function sameSessionLeaseAuthority(left: Readonly<SessionLeaseOwner>, right: Readonly<SessionLeaseOwner>): boolean {
	return (
		left.version === right.version &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.processIdentityHint === right.processIdentityHint &&
		left.authorityProcessStartId === right.authorityProcessStartId &&
		left.authorityProcessIdentityHint === right.authorityProcessIdentityHint &&
		left.activeSessionId === right.activeSessionId &&
		left.sessionPath === right.sessionPath &&
		left.createdAt === right.createdAt
	);
}

function sessionLeaseProcessIdentity(owner: Readonly<SessionLeaseOwner>): {
	pid: number;
	processStartId?: string;
	processIdentityHint?: string;
} {
	return {
		pid: owner.pid,
		...(owner.authorityProcessStartId
			? { processStartId: owner.authorityProcessStartId }
			: owner.processStartId
				? { processStartId: owner.processStartId }
				: {}),
		...(owner.authorityProcessIdentityHint
			? { processIdentityHint: owner.authorityProcessIdentityHint }
			: owner.processIdentityHint
				? { processIdentityHint: owner.processIdentityHint }
				: {}),
	};
}

const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 2_000;
const PROCESS_IDENTITY_PROBE_MAX_BUFFER = 16 * 1024;

interface ProcessQueryOptions {
	encoding: "utf8";
	stdio: ["ignore", "pipe", "ignore"];
	timeout: number;
	maxBuffer: number;
	killSignal: "SIGKILL";
	shell: false;
	cwd: string;
	env: NodeJS.ProcessEnv;
	windowsHide: true;
}

type ProcessQuery = (command: string, args: string[], options: ProcessQueryOptions) => string;
type ProcessKillProbe = (pid: number, signal: 0) => void;
type ProcStatReader = (path: string, maxBytes: number) => string | Buffer;
type PathExistsProbe = (path: string) => boolean;

/**
 * A process observation keeps liveness separate from identity quality. Only
 * `present-exact` carries a contract-exact durable PID-reuse discriminator.
 * Linux uses boot-qualified `/proc` start ticks at USER_HZ granularity and
 * assumes the same host and PID namespace; it is not a globally unique nonce
 * or held process handle. Capability markers and Windows start data follow
 * their platform contracts. Coarse hints are diagnostic and never authority.
 */
export type ProcessIdentityObservation =
	| { status: "absent" }
	| { status: "present-exact"; id: string }
	| { status: "present-coarse"; hint: string }
	| { status: "present-unknown" }
	| { status: "probe-uncertain" };

export function supportsExactProcessIdentityPlatform(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "linux" || platform === "darwin" || platform === "win32";
}

/** Injectable seams keep platform probes deterministic in focused tests. */
export interface ProcessIdentityObservationOptions {
	platform?: NodeJS.Platform;
	processKill?: ProcessKillProbe;
	readProcStat?: ProcStatReader;
	readProcBootId?: ProcStatReader;
	query?: ProcessQuery;
	pathExists?: PathExistsProbe;
	windowsSystemRoot?: string;
}

class ProcessIdentityOutputTooLargeError extends Error {}

function runProcessQuery(command: string, args: string[], options: ProcessQueryOptions): string {
	return execFileSync(command, args, options);
}

function boundedProcessQuery(
	query: ProcessQuery,
	command: string,
	args: string[],
	options: ProcessQueryOptions,
): string {
	const startedAt = Date.now();
	let outcome = "success";
	try {
		const output = query(command, args, options);
		if (Buffer.byteLength(output) > PROCESS_IDENTITY_PROBE_MAX_BUFFER) {
			outcome = "output_too_large";
			throw new ProcessIdentityOutputTooLargeError(
				`Process identity query exceeds ${PROCESS_IDENTITY_PROBE_MAX_BUFFER} bytes`,
			);
		}
		return output;
	} catch (error) {
		if (outcome === "success") outcome = "error";
		throw error;
	} finally {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= 100) {
			const pidFlagIndex = args.indexOf("-p");
			const targetPid = pidFlagIndex >= 0 ? Number(args[pidFlagIndex + 1]) : undefined;
			recordProcessLifecycle("process_identity_query_timing", {
				platform: process.platform,
				executable: basename(command),
				probe: args.includes("command=") ? "command" : args.includes("lstart=") ? "start_time" : "other",
				...(Number.isInteger(targetPid) ? { targetPid } : {}),
				elapsedMs,
				timeoutMs: options.timeout,
				outcome,
			});
		}
	}
}

function defaultProcessKillProbe(pid: number, signal: 0): void {
	process.kill(pid, signal);
}

export function readLinuxProcessIdentityFile(path: string, maxBytes: number): Buffer {
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const descriptor = openSync(path, constants.O_RDONLY | noFollow);
	try {
		if (!fstatSync(descriptor).isFile()) {
			throw Object.assign(new Error(`Process identity path is not a regular file: ${path}`), { code: "EINVAL" });
		}
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let totalBytesRead = 0;
		while (totalBytesRead < buffer.length) {
			const bytesRead = readSync(descriptor, buffer, totalBytesRead, buffer.length - totalBytesRead, null);
			if (bytesRead === 0) break;
			totalBytesRead += bytesRead;
		}
		if (totalBytesRead > maxBytes) {
			throw new ProcessIdentityOutputTooLargeError(`Process identity file exceeds ${maxBytes} bytes`);
		}
		return Buffer.from(buffer.subarray(0, totalBytesRead));
	} finally {
		closeSync(descriptor);
	}
}

function strictAsciiIdentityText(value: string | Buffer, maxBytes: number): string {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
	if (bytes.length > maxBytes) {
		throw new ProcessIdentityOutputTooLargeError(`Process identity data exceeds ${maxBytes} bytes`);
	}
	if (bytes.some((byte) => byte > 0x7f)) throw new Error("Process identity data is not strict ASCII");
	return bytes.toString("ascii");
}

function processQueryOptions(cwd: string, environment: NodeJS.ProcessEnv): ProcessQueryOptions {
	return {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
		maxBuffer: PROCESS_IDENTITY_PROBE_MAX_BUFFER,
		killSignal: "SIGKILL",
		shell: false,
		cwd,
		env: environment,
		windowsHide: true,
	};
}

function resolveWindowsSystemRoot(candidate?: string): string {
	if (candidate && /^[A-Za-z]:[\\/]/.test(candidate) && win32.isAbsolute(candidate)) {
		return win32.normalize(candidate);
	}
	return "C:\\Windows";
}

function windowsPowerShellPath(systemRoot: string): string {
	return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsProcessQueryOptions(systemRoot: string): ProcessQueryOptions {
	return processQueryOptions(win32.parse(systemRoot).root, {
		SystemRoot: systemRoot,
		WINDIR: systemRoot,
		NoDefaultCurrentDirectoryInExePath: "1",
	});
}

function posixProcessQueryOptions(): ProcessQueryOptions {
	return processQueryOptions("/", { LC_ALL: "C" });
}

function legacyProcessQueryOptions(): ProcessQueryOptions {
	return {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
		maxBuffer: PROCESS_IDENTITY_PROBE_MAX_BUFFER,
		killSignal: "SIGKILL",
		shell: false,
		cwd: process.cwd(),
		env: process.env,
		windowsHide: true,
	};
}

function queryWindowsProcessStartId(pid: number, query: ProcessQuery, systemRoot: string): string | undefined {
	const startTicks = boundedProcessQuery(
		query,
		windowsPowerShellPath(systemRoot),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		],
		windowsProcessQueryOptions(systemRoot),
	).trim();
	return /^(?:0|[1-9]\d{0,31})$/.test(startTicks) ? `win:${startTicks}` : undefined;
}

/** Compatibility wrapper. It returns only a validated exact Windows identity. */
export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		return queryWindowsProcessStartId(pid, query, resolveWindowsSystemRoot());
	} catch {
		return undefined;
	}
}

type PidPresence = "absent" | "present" | "uncertain";

function probePidPresence(pid: number, processKill: ProcessKillProbe): PidPresence {
	try {
		processKill(pid, 0);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "present";
		return "uncertain";
	}
}

function presenceObservation(presence: PidPresence): ProcessIdentityObservation {
	if (presence === "absent") return { status: "absent" };
	if (presence === "present") return { status: "present-unknown" };
	return { status: "probe-uncertain" };
}

function isProcessQueryTimeout(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const queryError = error as NodeJS.ErrnoException & { killed?: boolean };
	return queryError.code === "ETIMEDOUT" || queryError.killed === true;
}

function uncertainQueryObservation(
	pid: number,
	processKill: ProcessKillProbe,
	error?: unknown,
): ProcessIdentityObservation {
	const presence = probePidPresence(pid, processKill);
	if (presence !== "present") return presenceObservation(presence);
	return isProcessQueryTimeout(error) || error instanceof ProcessIdentityOutputTooLargeError
		? { status: "probe-uncertain" }
		: { status: "present-unknown" };
}

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let cachedLinuxBootId: string | undefined;

function parseLinuxBootId(value: string | Buffer, maxBytes: number): string | undefined {
	const text = strictAsciiIdentityText(value, maxBytes);
	const bootId = text.endsWith("\n") ? text.slice(0, -1) : text;
	return LINUX_BOOT_ID_PATTERN.test(bootId) && (text === bootId || text === `${bootId}\n`) ? bootId : undefined;
}

function readCachedLinuxBootId(_path: string, maxBytes: number): string {
	if (cachedLinuxBootId !== undefined) return cachedLinuxBootId;
	const parsed = parseLinuxBootId(readLinuxProcessIdentityFile(LINUX_BOOT_ID_PATH, maxBytes), maxBytes);
	if (parsed === undefined) throw new Error("Invalid Linux boot ID");
	cachedLinuxBootId = parsed;
	return parsed;
}

function parseLinuxProcessStartTicks(pid: number, value: string | Buffer, maxBytes: number): string | undefined {
	let bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
	if (bytes.length > maxBytes) {
		throw new ProcessIdentityOutputTooLargeError(`Process identity data exceeds ${maxBytes} bytes`);
	}
	if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, bytes.length - 1);
	const prefix = Buffer.from(`${pid} (`, "ascii");
	if (bytes.length < prefix.length || !bytes.subarray(0, prefix.length).equals(prefix)) return undefined;
	const commandEnd = bytes.lastIndexOf(Buffer.from(") ", "ascii"));
	if (commandEnd < prefix.length) return undefined;
	const tailBytes = bytes.subarray(commandEnd + 2);
	if (tailBytes.some((byte) => byte > 0x7f || byte < 0x20 || byte === 0x7f)) return undefined;
	const fields = tailBytes.toString("ascii").split(" ");
	if (fields.length < 20 || fields.some((field) => field.length === 0)) return undefined;
	const startTicks = fields[19];
	return startTicks !== undefined && isCanonicalUint64ProcessStartTicks(startTicks) ? startTicks : undefined;
}

function linuxIdentityFailure(pid: number, processKill: ProcessKillProbe): ProcessIdentityObservation {
	return presenceObservation(probePidPresence(pid, processKill));
}

function observeLinuxProcessIdentity(
	pid: number,
	readProcStat: ProcStatReader,
	readProcBootId: ProcStatReader,
	processKill: ProcessKillProbe,
): ProcessIdentityObservation {
	let bootId: string | undefined;
	try {
		bootId = parseLinuxBootId(
			readProcBootId(LINUX_BOOT_ID_PATH, PROCESS_IDENTITY_PROBE_MAX_BUFFER),
			PROCESS_IDENTITY_PROBE_MAX_BUFFER,
		);
	} catch {
		return linuxIdentityFailure(pid, processKill);
	}
	if (bootId === undefined) return linuxIdentityFailure(pid, processKill);

	let startTicks: string | undefined;
	try {
		startTicks = parseLinuxProcessStartTicks(
			pid,
			readProcStat(`/proc/${pid}/stat`, PROCESS_IDENTITY_PROBE_MAX_BUFFER),
			PROCESS_IDENTITY_PROBE_MAX_BUFFER,
		);
	} catch {
		return linuxIdentityFailure(pid, processKill);
	}
	if (startTicks === undefined) return linuxIdentityFailure(pid, processKill);
	return { status: "present-exact", id: `proc:${bootId}:${startTicks}` };
}

function observeWindowsProcessIdentity(
	pid: number,
	query: ProcessQuery,
	processKill: ProcessKillProbe,
	windowsSystemRoot?: string,
): ProcessIdentityObservation {
	try {
		const id = queryWindowsProcessStartId(pid, query, resolveWindowsSystemRoot(windowsSystemRoot));
		return id ? { status: "present-exact", id } : uncertainQueryObservation(pid, processKill);
	} catch (error) {
		return uncertainQueryObservation(pid, processKill, error);
	}
}

function resolvePosixPsPath(pathExists: PathExistsProbe): string | undefined {
	return pathExists("/bin/ps") ? "/bin/ps" : pathExists("/usr/bin/ps") ? "/usr/bin/ps" : undefined;
}

function observePortableProcessIdentityWithPath(
	pid: number,
	psPath: string,
	query: ProcessQuery,
	processKill: ProcessKillProbe,
): ProcessIdentityObservation {
	try {
		const rawOutput = boundedProcessQuery(
			query,
			psPath,
			["-p", String(pid), "-o", "lstart="],
			posixProcessQueryOptions(),
		);
		const output = rawOutput.endsWith("\n") ? rawOutput.slice(0, -1) : rawOutput;
		if (
			!output ||
			output.includes("\0") ||
			output.includes("\r") ||
			output.includes("\n") ||
			Buffer.byteLength(output) > 1_024
		) {
			return uncertainQueryObservation(pid, processKill);
		}
		const normalized = output.replace(/^[ \t\f\v]+|[ \t\f\v]+$/g, "").replace(/[ \t\f\v]+/g, " ");
		const hint = normalizePortableProcessIdentityHint(`ps:lstart:${normalized}`);
		return hint ? { status: "present-coarse", hint } : uncertainQueryObservation(pid, processKill);
	} catch (error) {
		return uncertainQueryObservation(pid, processKill, error);
	}
}

function processIdentityOwnerTokenFromCommand(command: string): string | null | undefined {
	let markerCount = 0;
	let markerIndex = command.indexOf(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX);
	while (markerIndex >= 0) {
		markerCount += 1;
		markerIndex = command.indexOf(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX, markerIndex + 1);
	}
	if (markerCount === 0) return undefined;

	const markerPattern = new RegExp(
		String.raw`(?:^|\s)${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}([0-9a-f]{64})(?=$|\s)`,
		"g",
	);
	const matches = [...command.matchAll(markerPattern)];
	const token = matches[0]?.[1];
	return markerCount === 1 && matches.length === 1 && token ? token : null;
}

function observeDarwinProcessIdentity(
	pid: number,
	query: ProcessQuery,
	processKill: ProcessKillProbe,
	pathExists: PathExistsProbe,
): ProcessIdentityObservation {
	const psPath = resolvePosixPsPath(pathExists);
	if (!psPath) return { status: "probe-uncertain" };
	try {
		const command = boundedProcessQuery(
			query,
			psPath,
			["-ww", "-o", "command=", "-p", String(pid)],
			posixProcessQueryOptions(),
		);
		if (command.includes("\0")) return { status: "present-unknown" };
		const token = processIdentityOwnerTokenFromCommand(command);
		if (token === null) return { status: "present-unknown" };
		if (token !== undefined) return { status: "present-exact", id: `token:${token}` };
	} catch (error) {
		return uncertainQueryObservation(pid, processKill, error);
	}
	return observePortableProcessIdentityWithPath(pid, psPath, query, processKill);
}

function observePortableProcessIdentity(
	pid: number,
	query: ProcessQuery,
	processKill: ProcessKillProbe,
	pathExists: PathExistsProbe,
): ProcessIdentityObservation {
	const psPath = resolvePosixPsPath(pathExists);
	return psPath
		? observePortableProcessIdentityWithPath(pid, psPath, query, processKill)
		: { status: "probe-uncertain" };
}

/**
 * Identity probes are hot on an idle fleet: every fence check, command
 * admission, and ownership pass asks again. The own-process identity cannot
 * change while the process runs, so it is memoized for its lifetime; a foreign
 * PID is memoized for a short TTL. Every hit still re-probes presence with
 * `kill(pid, 0)` so a dead PID is never reported alive, and a hit is refused
 * whenever trusting it would prove a mismatch against the expected identity.
 */
const PROCESS_IDENTITY_CACHE_TTL_MS = 5_000;
const PROCESS_IDENTITY_CACHE_MAX_ENTRIES = 512;
const PROCESS_IDENTITY_CACHE_EVICT_AGE_MS = 60_000;

interface ProcessIdentityCacheEntry {
	observation: ProcessIdentityObservation;
	observedAtMs: number;
}

const processIdentityCache = new Map<number, ProcessIdentityCacheEntry>();
let currentProcessIdentityObservation: ProcessIdentityObservation | undefined;

/** Only the default probe path is memoized; injected seams always probe fresh. */
function usesDefaultProcessIdentityProbes(options: ProcessIdentityObservationOptions): boolean {
	return (
		options.platform === undefined &&
		options.processKill === undefined &&
		options.readProcStat === undefined &&
		options.readProcBootId === undefined &&
		options.query === undefined &&
		options.pathExists === undefined &&
		options.windowsSystemRoot === undefined
	);
}

function processIdentityCacheHitUsable(
	observation: ProcessIdentityObservation,
	expectedProcessStartId: string | undefined,
): boolean {
	// A cached exact identity may confirm an expectation but never disprove one:
	// `exact-dead` always costs a fresh probe, never stale bytes.
	if (observation.status === "absent") return false;
	if (observation.status !== "present-exact") return true;
	if (expectedProcessStartId === undefined || !isExactProcessStartId(expectedProcessStartId)) return true;
	return observation.id === expectedProcessStartId;
}

function rememberProcessIdentity(pid: number, observation: ProcessIdentityObservation, nowMs: number): void {
	// Absence is one `kill()` away and a reused PID must never inherit it.
	if (observation.status === "absent") return;
	processIdentityCache.delete(pid);
	processIdentityCache.set(pid, { observation, observedAtMs: nowMs });
	if (processIdentityCache.size <= PROCESS_IDENTITY_CACHE_MAX_ENTRIES) return;
	for (const [cachedPid, entry] of processIdentityCache) {
		if (nowMs - entry.observedAtMs >= PROCESS_IDENTITY_CACHE_EVICT_AGE_MS) processIdentityCache.delete(cachedPid);
	}
	for (const cachedPid of processIdentityCache.keys()) {
		if (processIdentityCache.size <= PROCESS_IDENTITY_CACHE_MAX_ENTRIES) break;
		processIdentityCache.delete(cachedPid);
	}
}

function observeMemoizedProcessIdentity(
	pid: number,
	options: ProcessIdentityObservationOptions,
	expectedProcessStartId?: string,
): ProcessIdentityObservation {
	if (!Number.isInteger(pid) || pid <= 0) return { status: "probe-uncertain" };
	if (!usesDefaultProcessIdentityProbes(options)) return observeProcessIdentityUncached(pid, options);
	if (pid === process.pid) {
		// This PID and its argv0 capability token cannot change while it runs.
		if (
			currentProcessIdentityObservation?.status === "present-exact" ||
			currentProcessIdentityObservation?.status === "present-coarse"
		) {
			return currentProcessIdentityObservation;
		}
		currentProcessIdentityObservation = observeProcessIdentityUncached(pid, options);
		return currentProcessIdentityObservation;
	}
	const nowMs = Date.now();
	const cached = processIdentityCache.get(pid);
	if (
		cached !== undefined &&
		nowMs - cached.observedAtMs < PROCESS_IDENTITY_CACHE_TTL_MS &&
		processIdentityCacheHitUsable(cached.observation, expectedProcessStartId)
	) {
		// A hit still proves liveness; ESRCH invalidates before any caller sees it.
		const presence = probePidPresence(pid, defaultProcessKillProbe);
		if (presence === "present") return cached.observation;
		processIdentityCache.delete(pid);
		return presenceObservation(presence);
	}
	const observation = observeProcessIdentityUncached(pid, options);
	rememberProcessIdentity(pid, observation, nowMs);
	return observation;
}

/** Observe whether a PID exists and, when possible, its durable start identity. */
export function observeProcessIdentity(
	pid: number,
	options: ProcessIdentityObservationOptions = {},
): ProcessIdentityObservation {
	return observeMemoizedProcessIdentity(pid, options);
}

function observeProcessIdentityUncached(
	pid: number,
	options: ProcessIdentityObservationOptions,
): ProcessIdentityObservation {
	if (!Number.isInteger(pid) || pid <= 0) return { status: "probe-uncertain" };
	const processKill = options.processKill ?? defaultProcessKillProbe;
	const presence = probePidPresence(pid, processKill);
	if (presence !== "present") return presenceObservation(presence);

	const platform = options.platform ?? process.platform;
	if (platform === "linux") {
		return observeLinuxProcessIdentity(
			pid,
			options.readProcStat ?? readLinuxProcessIdentityFile,
			options.readProcBootId ?? readCachedLinuxBootId,
			processKill,
		);
	}
	if (platform === "win32") {
		return observeWindowsProcessIdentity(
			pid,
			options.query ?? runProcessQuery,
			processKill,
			options.windowsSystemRoot,
		);
	}
	if (platform === "darwin") {
		return observeDarwinProcessIdentity(
			pid,
			options.query ?? runProcessQuery,
			processKill,
			options.pathExists ?? existsSync,
		);
	}
	return observePortableProcessIdentity(
		pid,
		options.query ?? runProcessQuery,
		processKill,
		options.pathExists ?? existsSync,
	);
}

const QUALIFIED_LINUX_PROCESS_START_ID_PATTERN =
	/^proc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9]\d{0,19})$/;
const WINDOWS_PROCESS_START_ID_PATTERN = /^win:(?:0|[1-9]\d{0,31})$/;
const UINT64_MAX_DECIMAL = "18446744073709551615";

export function isCanonicalUint64ProcessStartTicks(value: string): boolean {
	return (
		/^(?:0|[1-9]\d{0,19})$/.test(value) && (value.length < UINT64_MAX_DECIMAL.length || value <= UINT64_MAX_DECIMAL)
	);
}
const TOKEN_PROCESS_START_ID_PATTERN = /^token:[0-9a-f]{64}$/;

export function isExactProcessStartId(value: string): boolean {
	// Legacy `proc:<ticks>`, `ps:`, and `ps:lstart:` values are migration
	// evidence only. Linux exactness is qualified by one validated boot UUID.
	const linux = QUALIFIED_LINUX_PROCESS_START_ID_PATTERN.exec(value);
	return (
		(linux?.[2] !== undefined && isCanonicalUint64ProcessStartTicks(linux[2])) ||
		WINDOWS_PROCESS_START_ID_PATTERN.test(value) ||
		TOKEN_PROCESS_START_ID_PATTERN.test(value)
	);
}

/** Project exact authority into a byte-compatible pre-boot-qualification field. */
export function projectLegacyProcessStartId(exactId: string): string | undefined {
	if (!isExactProcessStartId(exactId)) return undefined;
	const linux = QUALIFIED_LINUX_PROCESS_START_ID_PATTERN.exec(exactId);
	if (linux) return `proc:${linux[2]}`;
	if (WINDOWS_PROCESS_START_ID_PATTERN.test(exactId)) return exactId;
	// A token capability contains no portable timestamp that an old reader can verify.
	return undefined;
}

/**
 * Authority reclamation is deliberately tri-state. Only observed PID absence
 * or a positively different pair of exact identities proves death. Every
 * coarse, unknown, malformed, or uncertain observation retains authority.
 */
export type ProcessIdentityAuthority = "exact-live" | "exact-dead" | "retained";

export function classifyProcessIdentityAuthority(
	pid: number,
	expectedProcessStartId?: string,
	options: ProcessIdentityObservationOptions = {},
): ProcessIdentityAuthority {
	const observation = observeMemoizedProcessIdentity(pid, options, expectedProcessStartId);
	if (observation.status === "absent") return "exact-dead";
	if (
		observation.status === "present-exact" &&
		expectedProcessStartId !== undefined &&
		isExactProcessStartId(expectedProcessStartId)
	) {
		return observation.id === expectedProcessStartId ? "exact-live" : "exact-dead";
	}
	return "retained";
}

/** Conservative compatibility wrapper over the authority reducer. */
export function isProcessIdentityCurrent(
	pid: number,
	expectedProcessStartId?: string,
	options: ProcessIdentityObservationOptions = {},
): boolean {
	return classifyProcessIdentityAuthority(pid, expectedProcessStartId, options) !== "exact-dead";
}

/** Strict capability check for gated admission and signal authorization. */
export function matchesExactProcessIdentity(
	pid: number,
	expectedProcessStartId: string,
	options: ProcessIdentityObservationOptions = {},
): boolean {
	if (!isExactProcessStartId(expectedProcessStartId)) return false;
	const observation = observeMemoizedProcessIdentity(pid, options, expectedProcessStartId);
	return observation.status === "present-exact" && observation.id === expectedProcessStartId;
}

/** Compatibility wrapper. Coarse hints and uncertain probes are not start IDs. */
export function getProcessStartId(pid: number): string | undefined {
	const observation = observeProcessIdentity(pid);
	return observation.status === "present-exact" ? observation.id : undefined;
}

/**
 * Produce the byte-compatible identity used by the pre-move reader. On Darwin
 * and BSD this intentionally preserves the raw internal spacing from
 * `ps -o lstart=` and uses the old `ps:` prefix.
 */
export function getLegacyProcessStartId(
	pid: number,
	options: ProcessIdentityObservationOptions = {},
): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		try {
			const systemRoot = resolveWindowsSystemRoot(options.windowsSystemRoot);
			const startTicks = boundedProcessQuery(
				options.query ?? runProcessQuery,
				windowsPowerShellPath(systemRoot),
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
				],
				legacyProcessQueryOptions(),
			).trim();
			return /^(?:0|[1-9]\d{0,31})$/.test(startTicks) ? `win:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (platform === "linux") {
		try {
			const startTicks = parseLinuxProcessStartTicks(
				pid,
				(options.readProcStat ?? readLinuxProcessIdentityFile)(
					`/proc/${pid}/stat`,
					PROCESS_IDENTITY_PROBE_MAX_BUFFER,
				),
				PROCESS_IDENTITY_PROBE_MAX_BUFFER,
			);
			if (startTicks !== undefined) return `proc:${startTicks}`;
		} catch {
			// Fall through to the portable old-reader bridge.
		}
	}
	const psPath = resolvePosixPsPath(options.pathExists ?? existsSync);
	if (!psPath) return undefined;
	try {
		const output = boundedProcessQuery(
			options.query ?? runProcessQuery,
			psPath,
			["-p", String(pid), "-o", "lstart="],
			legacyProcessQueryOptions(),
		).trim();
		return output && !output.includes("\n") && !output.includes("\0") ? `ps:${output}` : undefined;
	} catch {
		return undefined;
	}
}

function getCurrentProcessIdentityObservation(): ProcessIdentityObservation {
	return observeMemoizedProcessIdentity(process.pid, {});
}

function withLeaseGuard<T>(directory: string, action: (guard: AuthorityMutationGuard) => T): T {
	const observation = getCurrentProcessIdentityObservation();
	if (observation.status !== "present-exact" && observation.status !== "present-coarse") {
		throw new Error(`Process exact-identity probe unavailable (${observation.status})`);
	}
	const held = acquireAuthorityMutationGuard({
		authorityPath: directory,
		lockfilePath: `${directory}.guard`,
		attempts: 100,
		retryMs: 10,
		identity:
			observation.status === "present-exact"
				? { processStartId: observation.id }
				: { processIdentityHint: observation.hint },
		classifyOwner: (owner) =>
			classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
		failureMessage: `Could not coordinate session lease: ${directory}`,
	});
	let result: T | undefined;
	let failure: unknown;
	try {
		held.assertCurrent();
		result = action(held);
		held.assertCurrent();
	} catch (error) {
		failure = error;
	}
	try {
		held.release();
	} catch (error) {
		failure ??= error;
	}
	if (failure) throw failure;
	return result as T;
}

function reclaimExactDeadLease(directory: string, expected: SessionLeaseOwner, guard: AuthorityMutationGuard): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	const current = readLeaseOwner(directory);
	if (!current || !sameSessionLeaseAuthority(current, expected)) return false;
	const identity = sessionLeaseProcessIdentity(current);
	if (classifyProcessIdentityAuthority(identity.pid, identity.processStartId) !== "exact-dead") return false;
	const immediateOwner = readLeaseOwner(directory);
	if (!immediateOwner || !sameSessionLeaseAuthority(immediateOwner, current)) return false;
	try {
		// Fresh token/identity/scope and death proof immediately precede rename.
		guard.assertCurrent();
		renameSync(directory, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	rmSync(stalePath, { recursive: true, force: true });
	return true;
}

export function acquireSessionLease(
	sessionPath: string | undefined,
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): SessionLease | undefined {
	return SessionLease.acquire(sessionPath, agentDir, environment);
}
