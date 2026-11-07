import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";

export const AIM_EXTERNAL_CREDENTIAL_PROTOCOL = "aimgr-credential-v1";
export const AIM_CREDENTIAL_BINDING_CUSTOM_TYPE = "aimgr_credential_binding_v1";

const HELPER_TIMEOUT_MS = 45_000;
const FRESHNESS_FLOOR_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const SAFE_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

const HELPER_ERROR_CODES = new Set([
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
]);

export type AimCredentialProvider = "openai-codex" | "anthropic";

export interface AimExternalCredentialDescriptor {
	type: "external";
	source: "aimgr";
	protocol: typeof AIM_EXTERNAL_CREDENTIAL_PROTOCOL;
	executable: string;
	args: string[];
	binding: string;
	expectedIdentityFingerprint: string;
}

export interface AimCredentialBinding {
	provider: string;
	source: "aimgr";
	binding: string;
	identityFingerprint: string;
}

export interface AimResolvedCredential extends AimCredentialBinding {
	accessToken: string;
	expiresAt: number;
	valueFingerprint: string;
}

interface HelperRequest {
	schemaVersion: 1;
	operation: "resolve";
	provider: string;
	binding: string;
	expectedIdentityFingerprint: string;
}

interface HelperSuccess {
	schemaVersion: 1;
	ok: true;
	provider: string;
	binding: string;
	identityFingerprint: string;
	credentialVersion: number;
	accessToken: string;
	expiresAt: number;
}

const SAFE_ERROR_MESSAGES: Record<string, string> = {
	helper_unavailable: "AIM credential helper is unavailable. Run aim prime status and repair the installation.",
	helper_untrusted: "AIM credential helper is not trusted. Reinstall the managed provider with aim prime use.",
	helper_timeout: "AIM credential helper timed out. Run aim prime status, then retry.",
	protocol_mismatch: "AIM credential helper protocol mismatch. Update AIM and Prime Agent, then retry.",
	unknown_label: "AIM credential binding is unknown. Select the credential again, then retry.",
	provider_mismatch: "AIM credential provider does not match this session.",
	credential_incomplete: "AIM credential is incomplete. Run aim prime status for its repair action.",
	credential_expired: "AIM credential is not fresh enough. Run aim prime status, then retry.",
	reauth_required: "AIM credential requires reauthentication. Run aim prime status for its reauth action.",
	lease_busy: "AIM credential refresh is already in progress. Retry after it completes.",
	coordination_unavailable: "AIM credential coordination is unavailable. Run aim prime status, then retry.",
	identity_conflict: "AIM credential identity does not match this session binding.",
	no_eligible_account: "No eligible AIM credential is available.",
};

export class AimExternalCredentialError extends Error {
	constructor(readonly code: string) {
		super(SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.protocol_mismatch);
		this.name = "AimExternalCredentialError";
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

export function isAimExternalCredentialDescriptor(value: unknown): value is AimExternalCredentialDescriptor {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, [
			"type",
			"source",
			"protocol",
			"executable",
			"args",
			"binding",
			"expectedIdentityFingerprint",
		]) &&
		value.type === "external" &&
		value.source === "aimgr" &&
		value.protocol === AIM_EXTERNAL_CREDENTIAL_PROTOCOL &&
		isNonEmptyString(value.executable) &&
		isAbsolute(value.executable) &&
		Array.isArray(value.args) &&
		value.args.length <= 32 &&
		value.args.every((arg) => typeof arg === "string" && Buffer.byteLength(arg) <= 4096) &&
		isNonEmptyString(value.binding) &&
		isNonEmptyString(value.expectedIdentityFingerprint)
	);
}

function isAimCredentialBinding(value: unknown): value is AimCredentialBinding {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["provider", "source", "binding", "identityFingerprint"]) &&
		isNonEmptyString(value.provider) &&
		value.source === "aimgr" &&
		isNonEmptyString(value.binding) &&
		isNonEmptyString(value.identityFingerprint)
	);
}

/** Fold legacy and v1 binding records in append order; later records win. */
export function foldAimCredentialBindings(entries: readonly unknown[]): Map<string, AimCredentialBinding> {
	const bindings = new Map<string, AimCredentialBinding>();
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const value =
			entry.type === "custom" && entry.customType === AIM_CREDENTIAL_BINDING_CUSTOM_TYPE
				? entry.data
				: entry.type === "credential_binding"
					? {
							provider: entry.provider,
							source: entry.source,
							binding: entry.binding,
							identityFingerprint: entry.identityFingerprint,
						}
					: undefined;
		if (isAimCredentialBinding(value)) bindings.set(value.provider, { ...value });
	}
	return bindings;
}

/** Build the minimal environment allowed for any AIM-owned child process. */
export function buildAimHelperEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Apply AIM helper ownership and parent-directory trust rules to an executable. */
export function assertTrustedAimExecutable(executable: string): void {
	let executableStat: ReturnType<typeof statSync>;
	try {
		const linkStat = lstatSync(executable);
		if (linkStat.isSymbolicLink()) throw new AimExternalCredentialError("helper_untrusted");
		executableStat = statSync(executable);
	} catch (error) {
		if (error instanceof AimExternalCredentialError) throw error;
		throw new AimExternalCredentialError("helper_unavailable");
	}
	if (!executableStat.isFile()) throw new AimExternalCredentialError("helper_untrusted");
	if (typeof process.getuid === "function" && executableStat.uid !== process.getuid()) {
		throw new AimExternalCredentialError("helper_untrusted");
	}
	if ((executableStat.mode & 0o022) !== 0) throw new AimExternalCredentialError("helper_untrusted");

	const root = parse(executable).root;
	let current = dirname(executable);
	while (true) {
		try {
			const linkStat = lstatSync(current);
			if (linkStat.isSymbolicLink() && linkStat.uid !== 0) {
				throw new AimExternalCredentialError("helper_untrusted");
			}
			const currentStat = statSync(current);
			if (!currentStat.isDirectory() || (currentStat.mode & 0o022) !== 0) {
				throw new AimExternalCredentialError("helper_untrusted");
			}
		} catch (error) {
			if (error instanceof AimExternalCredentialError) throw error;
			throw new AimExternalCredentialError("helper_untrusted");
		}
		if (current === root) break;
		current = dirname(current);
	}
}

function parseHelperSuccess(value: unknown, request: HelperRequest, now: number): HelperSuccess {
	if (
		!isRecord(value) ||
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
		throw new AimExternalCredentialError("protocol_mismatch");
	}
	if (value.provider !== request.provider) throw new AimExternalCredentialError("provider_mismatch");
	if (value.binding !== request.binding) throw new AimExternalCredentialError("protocol_mismatch");
	if (value.identityFingerprint !== request.expectedIdentityFingerprint) {
		throw new AimExternalCredentialError("identity_conflict");
	}
	if ((value.expiresAt as number) <= now + FRESHNESS_FLOOR_MS) {
		throw new AimExternalCredentialError("credential_expired");
	}
	return value as unknown as HelperSuccess;
}

function parseHelperResponse(stdout: string, exitCode: number | null, request: HelperRequest): HelperSuccess {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new AimExternalCredentialError("protocol_mismatch");
	}
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.ok !== "boolean") {
		throw new AimExternalCredentialError("protocol_mismatch");
	}
	if (value.ok) {
		if (exitCode !== 0) throw new AimExternalCredentialError("protocol_mismatch");
		return parseHelperSuccess(value, request, Date.now());
	}
	if (
		exitCode === 0 ||
		!hasExactKeys(value, [
			"schemaVersion",
			"ok",
			"code",
			"message",
			...(value.action === undefined ? [] : ["action"]),
		]) ||
		!isNonEmptyString(value.code) ||
		!HELPER_ERROR_CODES.has(value.code) ||
		!isNonEmptyString(value.message) ||
		(value.action !== undefined && typeof value.action !== "string")
	) {
		throw new AimExternalCredentialError("protocol_mismatch");
	}
	throw new AimExternalCredentialError(value.code);
}

async function resolveWithHelper(
	descriptor: AimExternalCredentialDescriptor,
	binding: AimCredentialBinding,
): Promise<AimResolvedCredential> {
	assertTrustedAimExecutable(descriptor.executable);
	const request: HelperRequest = {
		schemaVersion: 1,
		operation: "resolve",
		provider: binding.provider,
		binding: binding.binding,
		expectedIdentityFingerprint: binding.identityFingerprint,
	};
	const input = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new AimExternalCredentialError("protocol_mismatch");

	const response = await new Promise<HelperSuccess>((resolve, reject) => {
		let child: ChildProcessWithoutNullStreams;
		let stdout = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const finish = (error?: AimExternalCredentialError, value?: HelperSuccess) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else if (value) resolve(value);
			else reject(new AimExternalCredentialError("protocol_mismatch"));
		};
		const terminate = (error: AimExternalCredentialError) => {
			if (settled) return;
			child?.kill("SIGKILL");
			finish(error);
		};
		const timeout = setTimeout(() => terminate(new AimExternalCredentialError("helper_timeout")), HELPER_TIMEOUT_MS);
		try {
			child = spawn(descriptor.executable, descriptor.args, {
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: buildAimHelperEnvironment(),
			});
		} catch {
			finish(new AimExternalCredentialError("helper_unavailable"));
			return;
		}
		child.once("error", () => finish(new AimExternalCredentialError("helper_unavailable")));
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > MAX_STDOUT_BYTES) terminate(new AimExternalCredentialError("protocol_mismatch"));
			else stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_STDERR_BYTES) terminate(new AimExternalCredentialError("protocol_mismatch"));
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			try {
				finish(undefined, parseHelperResponse(stdout.trim(), exitCode, request));
			} catch (error) {
				finish(
					error instanceof AimExternalCredentialError
						? error
						: new AimExternalCredentialError("protocol_mismatch"),
				);
			}
		});
		child.stdin.end(input);
	});

	return Object.freeze({
		...binding,
		accessToken: response.accessToken,
		expiresAt: response.expiresAt,
		valueFingerprint: createHash("sha256").update(response.accessToken).digest("hex"),
	});
}

/** One root session tree's immutable helper descriptors and mutable nonsecret bindings. */
export class AimExternalAuthSession {
	private readonly descriptors = new Map<string, AimExternalCredentialDescriptor>();
	private readonly bindings = new Map<string, AimCredentialBinding>();
	private readonly resolved = new Map<string, AimResolvedCredential>();
	private readonly resolving = new Map<string, Promise<AimResolvedCredential>>();
	private readonly persistedProviders: Set<string>;

	constructor(
		credentials: Readonly<Record<string, unknown>>,
		persisted: ReadonlyMap<string, AimCredentialBinding>,
		private readonly persistInitialBinding: (binding: AimCredentialBinding) => void,
	) {
		this.persistedProviders = new Set(persisted.keys());
		for (const [provider, value] of Object.entries(credentials)) {
			if (!isRecord(value) || value.type !== "external") continue;
			if (!isAimExternalCredentialDescriptor(value)) {
				throw new AimExternalCredentialError("protocol_mismatch");
			}
			const descriptor = Object.freeze({ ...value, args: Object.freeze([...value.args]) as unknown as string[] });
			this.descriptors.set(provider, descriptor);
			this.bindings.set(
				provider,
				persisted.get(provider) ?? {
					provider,
					source: "aimgr",
					binding: descriptor.binding,
					identityFingerprint: descriptor.expectedIdentityFingerprint,
				},
			);
		}
	}

	isManaged(provider: string): boolean {
		return this.descriptors.has(provider);
	}

	getBindings(): AimCredentialBinding[] {
		return [...this.bindings.values()].map((binding) => ({ ...binding }));
	}

	getBinding(provider: string): AimCredentialBinding | undefined {
		const binding = this.bindings.get(provider);
		return binding ? { ...binding } : undefined;
	}

	getResolved(provider: string): AimResolvedCredential | undefined {
		return this.resolved.get(provider);
	}

	async getAccess(provider: string): Promise<AimResolvedCredential | undefined> {
		const binding = this.bindings.get(provider);
		if (!binding) return undefined;
		const cached = this.resolved.get(provider);
		if (
			cached &&
			cached.binding === binding.binding &&
			cached.identityFingerprint === binding.identityFingerprint &&
			Date.now() < cached.expiresAt - FRESHNESS_FLOOR_MS
		) {
			return cached;
		}
		const existing = this.resolving.get(provider);
		if (existing) return existing;
		const descriptor = this.descriptors.get(provider);
		if (!descriptor) return undefined;
		const pending = resolveWithHelper(descriptor, binding);
		this.resolving.set(provider, pending);
		try {
			const value = await pending;
			if (this.bindings.get(provider)?.binding === binding.binding) {
				if (!this.persistedProviders.has(provider)) {
					this.persistInitialBinding({ ...binding });
					this.persistedProviders.add(provider);
				}
				this.resolved.set(provider, value);
			}
			return value;
		} finally {
			if (this.resolving.get(provider) === pending) this.resolving.delete(provider);
		}
	}

	prepareHandoff(provider: string, binding: string, identityFingerprint: string): Promise<AimResolvedCredential> {
		const descriptor = this.descriptors.get(provider);
		if (!descriptor) throw new AimExternalCredentialError("provider_mismatch");
		return resolveWithHelper(descriptor, { provider, source: "aimgr", binding, identityFingerprint });
	}

	commitHandoff(resolved: AimResolvedCredential): void {
		if (!this.descriptors.has(resolved.provider)) throw new AimExternalCredentialError("provider_mismatch");
		const binding: AimCredentialBinding = {
			provider: resolved.provider,
			source: "aimgr",
			binding: resolved.binding,
			identityFingerprint: resolved.identityFingerprint,
		};
		this.bindings.set(resolved.provider, binding);
		this.resolved.set(resolved.provider, resolved);
	}
}
