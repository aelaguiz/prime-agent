import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";

export const EXTERNAL_CREDENTIAL_PROTOCOL = "aimgr-credential-v1";
export const EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS = 5 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 45_000;
const TERMINATION_GRACE_MS = 250;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const SAFE_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

export const EXTERNAL_CREDENTIAL_ERROR_CODES = [
	"helper_unavailable",
	"helper_untrusted",
	"helper_timeout",
	"protocol_mismatch",
	"unknown_label",
	"provider_mismatch",
	"credential_incomplete",
	"credential_expired",
	"reauth_required",
	"lease_busy",
	"coordination_unavailable",
	"identity_conflict",
	"no_eligible_account",
] as const;

export type ExternalCredentialErrorCode = (typeof EXTERNAL_CREDENTIAL_ERROR_CODES)[number];

export interface ExternalCredentialDescriptor {
	type: "external";
	source: string;
	protocol: string;
	executable: string;
	args: string[];
	binding: string;
	expectedIdentityFingerprint: string;
}

export interface CredentialBinding {
	provider: string;
	source: string;
	binding: string;
	identityFingerprint: string;
}

export interface AuthSourceToken {
	provider: string;
	source: "external";
	identityFingerprint: string;
	valueFingerprint: string;
}

export interface ResolvedExternalAccess extends CredentialBinding {
	accessToken: string;
	expiresAt: number;
	valueFingerprint: string;
}

export interface ExternalCredentialRequest {
	schemaVersion: 1;
	operation: "resolve";
	provider: string;
	binding: string;
	expectedIdentityFingerprint: string;
	rejectedCredentialVersion?: number;
}

export interface ExternalCredentialSuccess {
	schemaVersion: 1;
	ok: true;
	provider: string;
	binding: string;
	identityFingerprint: string;
	credentialVersion: number;
	accessToken: string;
	expiresAt: number;
}

export interface ExternalCredentialFailure {
	schemaVersion: 1;
	ok: false;
	code: ExternalCredentialErrorCode;
	message: string;
	action?: string;
}

export type ExternalCredentialResponse = ExternalCredentialSuccess | ExternalCredentialFailure;

interface CachedExternalAccess {
	resolved: ResolvedExternalAccess;
	credentialVersion: number;
	cacheUntil: number;
}

interface CredentialHistoryEntry {
	key: string;
	credentialVersion: number;
}

const MAX_CREDENTIAL_HISTORY_ENTRIES = 64;

export interface ExternalCredentialClientOptions {
	now?: () => number;
	timeoutMs?: number;
	maxCacheMs?: number;
}

const ERROR_MESSAGES: Record<ExternalCredentialErrorCode, string> = {
	helper_unavailable: 'External credential helper is unavailable. Run "aim prime status" and repair the installation.',
	helper_untrusted:
		'External credential helper path is not trusted. Reinstall the managed provider with "aim prime use".',
	helper_timeout: 'External credential helper timed out. Run "aim prime status", then retry.',
	protocol_mismatch:
		'External credential helper protocol mismatch. Update AIM and Prime Agent, then run "aim prime status".',
	unknown_label: 'External credential binding is unknown. Select it again with "aim prime use" and start a new root.',
	provider_mismatch:
		'External credential provider mismatch. Run "aim prime status" and repair the managed provider selection.',
	credential_incomplete:
		'External credential is incomplete. Run "aim prime status" and follow its account repair action.',
	credential_expired: 'External credential is not fresh enough. Run "aim prime status", then retry.',
	reauth_required:
		'External credential requires reauthentication. Run "aim prime status" and follow its reauth action.',
	lease_busy: "External credential refresh is already in progress. Wait for the AIM operation, then retry.",
	coordination_unavailable:
		'External credential coordination is unavailable. Restore AIM coordination, verify with "aim prime status", then retry.',
	identity_conflict:
		'External credential identity conflicts with this session. Restore its AIM binding or run "aim prime use" and start a new root.',
	no_eligible_account: 'No eligible external credential account is available. Select one with "aim prime use".',
};

const ERROR_CODE_SET = new Set<string>(EXTERNAL_CREDENTIAL_ERROR_CODES);

export class ExternalCredentialError extends Error {
	constructor(readonly code: ExternalCredentialErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "ExternalCredentialError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isExternalCredentialDescriptor(value: unknown): value is ExternalCredentialDescriptor {
	if (!isRecord(value) || value.type !== "external") return false;
	if (
		!hasExactKeys(value, [
			"type",
			"source",
			"protocol",
			"executable",
			"args",
			"binding",
			"expectedIdentityFingerprint",
		])
	) {
		return false;
	}
	return (
		isNonEmptyString(value.source) &&
		isNonEmptyString(value.protocol) &&
		isNonEmptyString(value.executable) &&
		isAbsolute(value.executable) &&
		Array.isArray(value.args) &&
		value.args.every((arg) => typeof arg === "string") &&
		isNonEmptyString(value.binding) &&
		isNonEmptyString(value.expectedIdentityFingerprint)
	);
}

export function validateExternalCredentialDescriptor(value: unknown): ExternalCredentialDescriptor {
	if (!isExternalCredentialDescriptor(value)) {
		throw new ExternalCredentialError("protocol_mismatch");
	}
	return Object.freeze({
		...value,
		args: Object.freeze([...value.args]) as string[],
	});
}

export function fingerprintCredentialValue(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function buildSafeEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function assertTrustedExecutable(executable: string): void {
	if (!isAbsolute(executable)) {
		throw new ExternalCredentialError("helper_untrusted");
	}

	let executableStat: ReturnType<typeof statSync>;
	try {
		const linkStat = lstatSync(executable);
		if (linkStat.isSymbolicLink()) {
			throw new ExternalCredentialError("helper_untrusted");
		}
		executableStat = statSync(executable);
	} catch (error) {
		if (error instanceof ExternalCredentialError) throw error;
		throw new ExternalCredentialError("helper_unavailable");
	}

	if (!executableStat.isFile()) {
		throw new ExternalCredentialError("helper_untrusted");
	}
	if (typeof process.getuid === "function" && executableStat.uid !== process.getuid()) {
		throw new ExternalCredentialError("helper_untrusted");
	}
	if ((executableStat.mode & 0o022) !== 0) {
		throw new ExternalCredentialError("helper_untrusted");
	}

	const root = parse(executable).root;
	let current = dirname(executable);
	while (true) {
		let currentStat: ReturnType<typeof statSync>;
		try {
			const linkStat = lstatSync(current);
			if (linkStat.isSymbolicLink() && linkStat.uid !== 0) {
				throw new ExternalCredentialError("helper_untrusted");
			}
			currentStat = statSync(current);
		} catch (error) {
			if (error instanceof ExternalCredentialError) throw error;
			throw new ExternalCredentialError("helper_untrusted");
		}
		if (!currentStat.isDirectory() || (currentStat.mode & 0o022) !== 0) {
			throw new ExternalCredentialError("helper_untrusted");
		}
		if (current === root) break;
		current = dirname(current);
	}
}

function parseSuccessResponse(
	value: Record<string, unknown>,
	request: ExternalCredentialRequest,
	now: number,
): ExternalCredentialSuccess {
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"ok",
			"provider",
			"binding",
			"identityFingerprint",
			"credentialVersion",
			"accessToken",
			"expiresAt",
		]) ||
		value.schemaVersion !== 1 ||
		value.ok !== true ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.binding) ||
		!isNonEmptyString(value.identityFingerprint) ||
		!Number.isSafeInteger(value.credentialVersion) ||
		(value.credentialVersion as number) < 0 ||
		!isNonEmptyString(value.accessToken) ||
		!Number.isSafeInteger(value.expiresAt)
	) {
		throw new ExternalCredentialError("protocol_mismatch");
	}
	if (value.provider !== request.provider) {
		throw new ExternalCredentialError("provider_mismatch");
	}
	if (value.binding !== request.binding) {
		throw new ExternalCredentialError("protocol_mismatch");
	}
	if (value.identityFingerprint !== request.expectedIdentityFingerprint) {
		throw new ExternalCredentialError("identity_conflict");
	}

	if ((value.expiresAt as number) <= now + EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS) {
		throw new ExternalCredentialError("credential_expired");
	}

	return value as unknown as ExternalCredentialSuccess;
}

function parseHelperResponse(
	stdout: string,
	exitCode: number | null,
	request: ExternalCredentialRequest,
	now: number,
): ExternalCredentialSuccess {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new ExternalCredentialError("protocol_mismatch");
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.ok !== "boolean") {
		throw new ExternalCredentialError("protocol_mismatch");
	}

	if (parsed.ok) {
		if (exitCode !== 0) throw new ExternalCredentialError("protocol_mismatch");
		return parseSuccessResponse(parsed, request, now);
	}

	if (
		exitCode === 0 ||
		!hasExactKeys(parsed, [
			"schemaVersion",
			"ok",
			"code",
			"message",
			...(parsed.action === undefined ? [] : ["action"]),
		]) ||
		!isNonEmptyString(parsed.code) ||
		!ERROR_CODE_SET.has(parsed.code) ||
		!isNonEmptyString(parsed.message) ||
		(parsed.action !== undefined && typeof parsed.action !== "string")
	) {
		throw new ExternalCredentialError("protocol_mismatch");
	}
	throw new ExternalCredentialError(parsed.code as ExternalCredentialErrorCode);
}

function executeHelper(
	descriptor: ExternalCredentialDescriptor,
	request: ExternalCredentialRequest,
	timeoutMs: number,
	now: () => number,
): Promise<ExternalCredentialSuccess> {
	assertTrustedExecutable(descriptor.executable);
	const input = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
		throw new ExternalCredentialError("protocol_mismatch");
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcessWithoutNullStreams;

		const finish = (error?: ExternalCredentialError, response?: ExternalCredentialSuccess) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			if (error) reject(error);
			else if (response) resolve(response);
			else reject(new ExternalCredentialError("protocol_mismatch"));
		};

		const terminate = (error: ExternalCredentialError) => {
			if (settled) return;
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.kill("SIGTERM");
			finish(error);
			killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
		};

		const timeoutTimer = setTimeout(() => terminate(new ExternalCredentialError("helper_timeout")), timeoutMs);

		try {
			child = spawn(descriptor.executable, descriptor.args, {
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: buildSafeEnvironment(),
			});
		} catch {
			finish(new ExternalCredentialError("helper_unavailable"));
			return;
		}

		child.once("error", () => finish(new ExternalCredentialError("helper_unavailable")));
		// A helper may reject or exit before consuming the full request; its close
		// status/response remains authoritative instead of an unhandled EPIPE.
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				terminate(new ExternalCredentialError("protocol_mismatch"));
				return;
			}
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_STDERR_BYTES) {
				terminate(new ExternalCredentialError("protocol_mismatch"));
			}
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			try {
				finish(undefined, parseHelperResponse(stdout.trim(), exitCode, request, now()));
			} catch (error) {
				finish(error instanceof ExternalCredentialError ? error : new ExternalCredentialError("protocol_mismatch"));
			}
		});
		child.stdin.end(input);
	});
}

export class ExternalCredentialClient {
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly maxCacheMs: number;
	private readonly cache = new Map<string, CachedExternalAccess>();
	private readonly inFlight = new Map<string, Promise<ResolvedExternalAccess>>();
	private readonly rejectedVersions = new Map<string, number>();
	private readonly credentialHistory = new Map<string, CredentialHistoryEntry>();
	private readonly rejectionInFlight = new Map<string, Promise<ResolvedExternalAccess | undefined>>();
	private generation = 0;

	constructor(options: ExternalCredentialClientOptions = {}) {
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxCacheMs = options.maxCacheMs ?? Number.POSITIVE_INFINITY;
	}

	clear(): void {
		this.generation += 1;
		this.cache.clear();
		this.inFlight.clear();
		this.rejectedVersions.clear();
		this.credentialHistory.clear();
		this.rejectionInFlight.clear();
	}

	private key(
		descriptor: ExternalCredentialDescriptor,
		provider: string,
		binding: string,
		expectedIdentityFingerprint: string,
	): string {
		return JSON.stringify([
			descriptor.source,
			descriptor.protocol,
			descriptor.executable,
			descriptor.args,
			provider,
			binding,
			expectedIdentityFingerprint,
		]);
	}

	private historyKey(sourceToken: AuthSourceToken): string {
		return JSON.stringify([sourceToken.provider, sourceToken.identityFingerprint, sourceToken.valueFingerprint]);
	}

	private rememberCredential(sourceToken: AuthSourceToken, key: string, credentialVersion: number): void {
		const historyKey = this.historyKey(sourceToken);
		this.credentialHistory.delete(historyKey);
		this.credentialHistory.set(historyKey, { key, credentialVersion });
		while (this.credentialHistory.size > MAX_CREDENTIAL_HISTORY_ENTRIES) {
			const oldest = this.credentialHistory.keys().next().value;
			if (oldest === undefined) break;
			this.credentialHistory.delete(oldest);
		}
	}

	private getFreshCached(key: string): CachedExternalAccess | undefined {
		const cached = this.cache.get(key);
		if (!cached) return undefined;
		if (this.now() < cached.cacheUntil) return cached;
		this.cache.delete(key);
		return undefined;
	}

	private getOrStartResolution(
		descriptor: ExternalCredentialDescriptor,
		provider: string,
		binding: string,
		expectedIdentityFingerprint: string,
		key: string,
	): Promise<ResolvedExternalAccess> {
		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const generation = this.generation;
		const rejectedCredentialVersion = this.rejectedVersions.get(key);
		const pending = (async () => {
			const request: ExternalCredentialRequest = {
				schemaVersion: 1,
				operation: "resolve",
				provider,
				binding,
				expectedIdentityFingerprint,
				...(rejectedCredentialVersion === undefined ? {} : { rejectedCredentialVersion }),
			};
			const response = await executeHelper(descriptor, request, this.timeoutMs, this.now);
			if (generation !== this.generation) {
				throw new ExternalCredentialError("coordination_unavailable");
			}
			const resolved = Object.freeze({
				provider,
				source: descriptor.source,
				binding,
				identityFingerprint: response.identityFingerprint,
				accessToken: response.accessToken,
				expiresAt: response.expiresAt,
				valueFingerprint: fingerprintCredentialValue(response.accessToken),
			}) as ResolvedExternalAccess;
			this.cache.set(key, {
				resolved,
				credentialVersion: response.credentialVersion,
				cacheUntil: Math.min(
					response.expiresAt - EXTERNAL_CREDENTIAL_FRESHNESS_FLOOR_MS,
					this.now() + this.maxCacheMs,
				),
			});
			this.rememberCredential(
				{
					provider,
					source: "external",
					identityFingerprint: resolved.identityFingerprint,
					valueFingerprint: resolved.valueFingerprint,
				},
				key,
				response.credentialVersion,
			);
			this.rejectedVersions.delete(key);
			return resolved;
		})();
		this.inFlight.set(key, pending);
		const cleanup = () => {
			if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
		};
		void pending.then(cleanup, cleanup);
		return pending;
	}

	async resolve(
		descriptorValue: ExternalCredentialDescriptor,
		provider: string,
		binding = descriptorValue.binding,
		expectedIdentityFingerprint = descriptorValue.expectedIdentityFingerprint,
	): Promise<ResolvedExternalAccess> {
		const descriptor = validateExternalCredentialDescriptor(descriptorValue);
		if (descriptor.protocol !== EXTERNAL_CREDENTIAL_PROTOCOL) {
			throw new ExternalCredentialError("protocol_mismatch");
		}
		const key = this.key(descriptor, provider, binding, expectedIdentityFingerprint);
		const cached = this.getFreshCached(key);
		if (cached) return cached.resolved;
		return this.getOrStartResolution(descriptor, provider, binding, expectedIdentityFingerprint, key);
	}

	invalidate(sourceToken: AuthSourceToken): boolean {
		const history = this.credentialHistory.get(this.historyKey(sourceToken));
		if (!history) return false;
		const cached = this.cache.get(history.key);
		if (cached?.resolved.valueFingerprint === sourceToken.valueFingerprint) {
			this.cache.delete(history.key);
		}
		this.rejectedVersions.set(history.key, history.credentialVersion);
		return true;
	}

	private async performResolveAfterRejection(
		descriptor: ExternalCredentialDescriptor,
		sourceToken: AuthSourceToken,
		binding: string,
		expectedIdentityFingerprint: string,
		key: string,
		history: CredentialHistoryEntry,
	): Promise<ResolvedExternalAccess | undefined> {
		const cached = this.getFreshCached(key);
		if (cached && cached.resolved.valueFingerprint !== sourceToken.valueFingerprint) return cached.resolved;
		if (cached) this.cache.delete(key);
		this.rejectedVersions.set(key, history.credentialVersion);

		const newerInFlight = this.inFlight.get(key);
		if (newerInFlight) {
			const candidate = await newerInFlight;
			if (candidate.valueFingerprint !== sourceToken.valueFingerprint) return candidate;
			this.cache.delete(key);
			this.rejectedVersions.set(key, history.credentialVersion);
		}
		return this.getOrStartResolution(descriptor, sourceToken.provider, binding, expectedIdentityFingerprint, key);
	}

	async resolveAfterRejection(
		descriptorValue: ExternalCredentialDescriptor,
		sourceToken: AuthSourceToken,
		binding = descriptorValue.binding,
		expectedIdentityFingerprint = descriptorValue.expectedIdentityFingerprint,
	): Promise<ResolvedExternalAccess | undefined> {
		const descriptor = validateExternalCredentialDescriptor(descriptorValue);
		if (descriptor.protocol !== EXTERNAL_CREDENTIAL_PROTOCOL) {
			throw new ExternalCredentialError("protocol_mismatch");
		}
		const key = this.key(descriptor, sourceToken.provider, binding, expectedIdentityFingerprint);
		const rejectionKey = this.historyKey(sourceToken);
		const existing = this.rejectionInFlight.get(rejectionKey);
		if (existing) return existing;
		const history = this.credentialHistory.get(rejectionKey);
		if (!history || history.key !== key) return undefined;

		const pending = this.performResolveAfterRejection(
			descriptor,
			sourceToken,
			binding,
			expectedIdentityFingerprint,
			key,
			history,
		);
		this.rejectionInFlight.set(rejectionKey, pending);
		const cleanup = () => {
			if (this.rejectionInFlight.get(rejectionKey) === pending) this.rejectionInFlight.delete(rejectionKey);
		};
		void pending.then(cleanup, cleanup);
		return pending;
	}
}
