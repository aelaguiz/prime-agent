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
	"automatic_failover_disabled",
]);

export type AimCredentialProvider = "openai-codex" | "anthropic";
export type AimCredentialAdvanceReason = "usage_limit_reached";

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

export interface AimCredentialHelperRoute {
	protocol: typeof AIM_EXTERNAL_CREDENTIAL_PROTOCOL;
	executable: string;
	args: string[];
}

/** Secret-free session journal record sufficient to resolve a binding after restart. */
export interface AimPersistedCredentialBinding extends AimCredentialBinding {
	helper: AimCredentialHelperRoute;
}

export interface AimCredentialSessionState {
	bindings: Map<string, AimCredentialBinding>;
	helpers: Map<string, AimCredentialHelperRoute>;
}

export interface AimResolvedCredential extends AimCredentialBinding {
	accessToken: string;
	expiresAt: number;
	valueFingerprint: string;
}

/** Opaque process-local identity for credential-affine provider transports. */
export interface AimCredentialRequestAdmission {
	transportAuthIdentity: string;
}

/**
 * AIM-managed Anthropic requests must fail back to Prime immediately instead of
 * sleeping inside the provider SDK for a subscription-window Retry-After.
 */
export function getAimAdmittedProviderMaxRetries(
	provider: string,
	admission: AimCredentialRequestAdmission | undefined,
	configuredMaxRetries: number | undefined,
): number | undefined {
	return provider === "anthropic" && admission ? 0 : configuredMaxRetries;
}

interface ResolvingCredential {
	generation: number;
	promise: Promise<AimResolvedCredential>;
}

interface HelperResolveRequest {
	schemaVersion: 1;
	operation: "resolve";
	provider: string;
	binding: string;
	expectedIdentityFingerprint: string;
}

interface HelperAdvanceRequest {
	schemaVersion: 1;
	operation: "advance";
	provider: "openai-codex";
	binding: string;
	expectedIdentityFingerprint: string;
	reason: AimCredentialAdvanceReason;
}

type HelperRequest = HelperResolveRequest | HelperAdvanceRequest;

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
	automatic_failover_disabled: "Automatic AIM credential failover is disabled for this credential pool.",
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

function isAimCredentialHelperRoute(value: unknown): value is AimCredentialHelperRoute {
	if (!isRecord(value)) return false;
	return (
		hasExactKeys(value, ["protocol", "executable", "args"]) &&
		value.protocol === AIM_EXTERNAL_CREDENTIAL_PROTOCOL &&
		isNonEmptyString(value.executable) &&
		isAbsolute(value.executable) &&
		Array.isArray(value.args) &&
		value.args.length <= 32 &&
		value.args.every((arg) => typeof arg === "string" && Buffer.byteLength(arg) <= 4096)
	);
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
		isAimCredentialHelperRoute({
			protocol: value.protocol,
			executable: value.executable,
			args: value.args,
		}) &&
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

function parseAimPersistedCredentialBinding(
	value: unknown,
): { binding: AimCredentialBinding; helper?: AimCredentialHelperRoute } | undefined {
	if (!isRecord(value)) return undefined;
	const expectedKeys = ["provider", "source", "binding", "identityFingerprint"];
	if (value.helper !== undefined) expectedKeys.push("helper");
	if (!hasExactKeys(value, expectedKeys)) return undefined;
	const binding = {
		provider: value.provider,
		source: value.source,
		binding: value.binding,
		identityFingerprint: value.identityFingerprint,
	};
	if (!isAimCredentialBinding(binding)) return undefined;
	if (value.helper === undefined) return { binding };
	if (!isAimCredentialHelperRoute(value.helper)) return undefined;
	return {
		binding,
		helper: {
			protocol: value.helper.protocol,
			executable: value.helper.executable,
			args: [...value.helper.args],
		},
	};
}

/** Fold legacy and v1 records in append order; later bindings and helper routes win independently. */
export function foldAimCredentialSessionState(entries: readonly unknown[]): AimCredentialSessionState {
	const bindings = new Map<string, AimCredentialBinding>();
	const helpers = new Map<string, AimCredentialHelperRoute>();
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
		const parsed = parseAimPersistedCredentialBinding(value);
		if (!parsed) continue;
		bindings.set(parsed.binding.provider, { ...parsed.binding });
		if (parsed.helper) helpers.set(parsed.binding.provider, parsed.helper);
	}
	return { bindings, helpers };
}

/** Fold only the secret-free provider binding tuples used by UI and compatibility callers. */
export function foldAimCredentialBindings(entries: readonly unknown[]): Map<string, AimCredentialBinding> {
	return foldAimCredentialSessionState(entries).bindings;
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
	if (request.operation === "resolve") {
		if (value.binding !== request.binding) throw new AimExternalCredentialError("protocol_mismatch");
		if (value.identityFingerprint !== request.expectedIdentityFingerprint) {
			throw new AimExternalCredentialError("identity_conflict");
		}
	} else if (value.binding === request.binding) {
		throw new AimExternalCredentialError("no_eligible_account");
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
	request: HelperRequest,
): Promise<AimResolvedCredential> {
	assertTrustedAimExecutable(descriptor.executable);
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
		provider: response.provider,
		source: "aimgr" as const,
		binding: response.binding,
		identityFingerprint: response.identityFingerprint,
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
	private readonly generations = new Map<string, number>();
	private readonly resolving = new Map<string, ResolvingCredential>();
	private readonly handoffs = new Map<string, Promise<AimResolvedCredential>>();
	private readonly persistedHelperProviders: Set<string>;

	constructor(
		credentials: Readonly<Record<string, unknown>>,
		persisted: AimCredentialSessionState,
		private readonly persistBinding: (binding: AimPersistedCredentialBinding) => void,
	) {
		this.persistedHelperProviders = new Set(persisted.helpers.keys());
		for (const [provider, value] of Object.entries(credentials)) {
			if (!isRecord(value) || value.type !== "external") continue;
			if (!isAimExternalCredentialDescriptor(value)) {
				throw new AimExternalCredentialError("protocol_mismatch");
			}
			const descriptor = Object.freeze({ ...value, args: Object.freeze([...value.args]) as unknown as string[] });
			this.descriptors.set(provider, descriptor);
			this.bindings.set(
				provider,
				persisted.bindings.get(provider) ?? {
					provider,
					source: "aimgr",
					binding: descriptor.binding,
					identityFingerprint: descriptor.expectedIdentityFingerprint,
				},
			);
			this.generations.set(provider, 0);
		}
		for (const [provider, helper] of persisted.helpers) {
			if (this.descriptors.has(provider)) continue;
			const binding = persisted.bindings.get(provider);
			if (!binding) continue;
			this.descriptors.set(provider, {
				type: "external",
				source: "aimgr",
				protocol: helper.protocol,
				executable: helper.executable,
				args: [...helper.args],
				binding: binding.binding,
				expectedIdentityFingerprint: binding.identityFingerprint,
			});
			this.bindings.set(provider, { ...binding });
			this.generations.set(provider, 0);
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

	getExecutable(provider?: string): string | undefined {
		if (provider !== undefined) return this.descriptors.get(provider)?.executable;
		const executables = new Set([...this.descriptors.values()].map((descriptor) => descriptor.executable));
		return executables.size === 1 ? executables.values().next().value : undefined;
	}

	getResolved(provider: string): AimResolvedCredential | undefined {
		return this.resolved.get(provider);
	}

	private getGeneration(provider: string): number {
		return this.generations.get(provider) ?? 0;
	}

	private getTransportAuthIdentity(provider: string, credential: AimResolvedCredential): string {
		return createHash("sha256")
			.update(provider)
			.update("\0")
			.update(String(this.getGeneration(provider)))
			.update("\0")
			.update(credential.valueFingerprint)
			.digest("hex");
	}

	private persistedBinding(provider: string, binding: AimCredentialBinding): AimPersistedCredentialBinding {
		const descriptor = this.descriptors.get(provider);
		if (!descriptor) throw new AimExternalCredentialError("provider_mismatch");
		return {
			...binding,
			helper: {
				protocol: descriptor.protocol,
				executable: descriptor.executable,
				args: [...descriptor.args],
			},
		};
	}

	private async waitForHandoff(provider: string): Promise<void> {
		try {
			await this.handoffs.get(provider);
		} catch {
			// The initiating handoff observes the failure. Request waiters retry A.
		}
	}

	async getAccess(provider: string): Promise<AimResolvedCredential | undefined> {
		while (true) {
			await this.waitForHandoff(provider);
			const generation = this.getGeneration(provider);
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

			const descriptor = this.descriptors.get(provider);
			if (!descriptor) return undefined;
			const existing = this.resolving.get(provider);
			const resolving =
				existing?.generation === generation
					? existing
					: {
							generation,
							promise: resolveWithHelper(descriptor, {
								schemaVersion: 1,
								operation: "resolve",
								provider,
								binding: binding.binding,
								expectedIdentityFingerprint: binding.identityFingerprint,
							}),
						};
			if (resolving !== existing) this.resolving.set(provider, resolving);

			let value: AimResolvedCredential;
			try {
				value = await resolving.promise;
			} catch (error) {
				if (this.getGeneration(provider) !== generation || this.handoffs.has(provider)) {
					await this.waitForHandoff(provider);
					continue;
				}
				throw error;
			} finally {
				if (this.resolving.get(provider) === resolving) this.resolving.delete(provider);
			}

			const current = this.bindings.get(provider);
			if (
				this.getGeneration(provider) !== generation ||
				this.handoffs.has(provider) ||
				current?.binding !== binding.binding ||
				current.identityFingerprint !== binding.identityFingerprint
			) {
				continue;
			}
			if (!this.persistedHelperProviders.has(provider)) {
				this.persistBinding(this.persistedBinding(provider, binding));
				this.persistedHelperProviders.add(provider);
			}
			this.resolved.set(provider, value);
			return value;
		}
	}

	async admitRequest<TResolved, TResult>(
		provider: string,
		resolve: () => Promise<TResolved>,
		admit: (resolved: TResolved, admission: AimCredentialRequestAdmission) => TResult,
	): Promise<TResult> {
		while (true) {
			await this.waitForHandoff(provider);
			const generation = this.getGeneration(provider);
			const resolved = await resolve();
			if (this.getGeneration(provider) !== generation || this.handoffs.has(provider)) continue;

			const credential = this.resolved.get(provider);
			const binding = this.bindings.get(provider);
			if (
				!credential ||
				!binding ||
				credential.binding !== binding.binding ||
				credential.identityFingerprint !== binding.identityFingerprint
			) {
				throw new AimExternalCredentialError("protocol_mismatch");
			}
			return admit(resolved, { transportAuthIdentity: this.getTransportAuthIdentity(provider, credential) });
		}
	}

	private async runHandoffRequest(
		provider: string,
		descriptor: AimExternalCredentialDescriptor,
		request: HelperRequest,
		beforePublish: (binding: AimPersistedCredentialBinding) => void,
	): Promise<AimResolvedCredential> {
		const existing = this.handoffs.get(provider);
		if (existing) return existing;

		let pending: Promise<AimResolvedCredential>;
		pending = (async () => {
			const resolved = await resolveWithHelper(descriptor, request);
			const binding: AimCredentialBinding = {
				provider,
				source: "aimgr",
				binding: resolved.binding,
				identityFingerprint: resolved.identityFingerprint,
			};
			beforePublish(this.persistedBinding(provider, binding));
			this.bindings.set(provider, binding);
			this.resolved.set(provider, resolved);
			this.persistedHelperProviders.add(provider);
			this.generations.set(provider, this.getGeneration(provider) + 1);
			return resolved;
		})();
		this.handoffs.set(provider, pending);
		try {
			return await pending;
		} finally {
			if (this.handoffs.get(provider) === pending) this.handoffs.delete(provider);
		}
	}

	async handoff(
		provider: string,
		binding: string,
		identityFingerprint: string,
		beforePublish: (binding: AimPersistedCredentialBinding) => void,
	): Promise<AimResolvedCredential> {
		const descriptor = this.descriptors.get(provider);
		if (!descriptor) throw new AimExternalCredentialError("provider_mismatch");
		return this.runHandoffRequest(
			provider,
			descriptor,
			{
				schemaVersion: 1,
				operation: "resolve",
				provider,
				binding,
				expectedIdentityFingerprint: identityFingerprint,
			},
			beforePublish,
		);
	}

	async advance(
		provider: "openai-codex",
		expectedTransportAuthIdentity: string,
		reason: AimCredentialAdvanceReason,
		beforePublish: (binding: AimPersistedCredentialBinding) => void,
	): Promise<AimResolvedCredential> {
		const existing = this.handoffs.get(provider);
		if (existing) return existing;

		const current = await this.getAccess(provider);
		if (!current) throw new AimExternalCredentialError("credential_incomplete");
		const joined = this.handoffs.get(provider);
		if (joined) return joined;
		if (this.getTransportAuthIdentity(provider, current) !== expectedTransportAuthIdentity) return current;

		const descriptor = this.descriptors.get(provider);
		const binding = this.bindings.get(provider);
		if (!descriptor || !binding) throw new AimExternalCredentialError("provider_mismatch");
		return this.runHandoffRequest(
			provider,
			descriptor,
			{
				schemaVersion: 1,
				operation: "advance",
				provider,
				binding: binding.binding,
				expectedIdentityFingerprint: binding.identityFingerprint,
				reason,
			},
			beforePublish,
		);
	}

	/** Advance after an unopened provider failure using the root journal owner captured at session start. */
	async advanceRequest(
		provider: "openai-codex",
		expectedTransportAuthIdentity: string,
		reason: AimCredentialAdvanceReason,
	): Promise<AimResolvedCredential> {
		return this.advance(provider, expectedTransportAuthIdentity, reason, this.persistBinding);
	}
}
