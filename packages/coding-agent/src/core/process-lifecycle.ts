import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROCESS_INSTANCE_ENV = "PRIME_AGENT_INTERNAL_PROCESS_INSTANCE_ID";
const PARENT_PROCESS_INSTANCE_ENV = "PRIME_AGENT_INTERNAL_PARENT_PROCESS_INSTANCE_ID";
const PROCESS_LAUNCH_TRIGGER_ENV = "PRIME_AGENT_INTERNAL_PROCESS_LAUNCH_TRIGGER";
const PROCESS_CONTEXT_ENV = "PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_CONTEXT";
const PROCESS_ROLE_ENV = "PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_ROLE";
const AGENT_DIR_ENV = "PRIME_AGENT_CODING_AGENT_DIR";

const MAX_PROCESS_LOG_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_STRING_LENGTH = 32 * 1024;
const MAX_REPORT_STRING_LENGTH = 64 * 1024;
const MAX_OBJECT_DEPTH = 8;
const MAX_OBJECT_ENTRIES = 100;
const MAX_ARRAY_ENTRIES = 100;
const PROCESS_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CRASH_REPORTS = 20;
const HEARTBEAT_INTERVAL_MS = 60_000;
const NATIVE_REPORT_ROLES = new Set(["daemon-worker", "daemon-catalog", "update-restart-coordinator"]);

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type LifecycleSignal = (typeof SIGNALS)[number];

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProcessLifecycleContext = Record<string, unknown>;

export interface ProcessLifecycleLaunchOptions {
	role: string;
	trigger: string;
	context?: Record<string, string | number | boolean | undefined>;
}

export interface ProcessLifecycleLaunch {
	childProcessInstanceId: string;
	environment: NodeJS.ProcessEnv;
}

interface ProcessLifecycleState {
	installed: boolean;
	sequence: number;
	completed: boolean;
	fatalObserved: boolean;
	droppedEvents: number;
	context: Record<string, JsonValue | undefined>;
	heartbeat?: NodeJS.Timeout;
	dispose?: () => void;
	lastRejection?: { reason: unknown; reportPath?: string };
}

interface SanitizeOptions {
	maxStringLength: number;
}

interface WriteEventOptions {
	includeResources?: boolean;
}

function safeIdentifier(value: string | undefined): string | undefined {
	return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

// Keep this independent from config.ts so failures in the main module graph are still recordable.
function getEarlyAgentDir(): string {
	const configured = process.env[AGENT_DIR_ENV];
	return configured ? expandHome(configured) : join(homedir(), ".prime", "agent");
}

const inheritedProcessInstanceId = safeIdentifier(process.env[PROCESS_INSTANCE_ENV]);
const inheritedParentProcessInstanceId = safeIdentifier(process.env[PARENT_PROCESS_INSTANCE_ENV]);
const inheritedLaunchTrigger = process.env[PROCESS_LAUNCH_TRIGGER_ENV]?.slice(0, 256);
const inheritedRole = process.env[PROCESS_ROLE_ENV]?.slice(0, 128);
const inheritedContext = parseInheritedContext(process.env[PROCESS_CONTEXT_ENV]);

for (const name of [
	PROCESS_INSTANCE_ENV,
	PARENT_PROCESS_INSTANCE_ENV,
	PROCESS_LAUNCH_TRIGGER_ENV,
	PROCESS_CONTEXT_ENV,
	PROCESS_ROLE_ENV,
]) {
	delete process.env[name];
}

const processInstanceId = inheritedProcessInstanceId ?? randomUUID();
const parentProcessInstanceId = inheritedParentProcessInstanceId;
const processLogPath = join(getEarlyAgentDir(), "logs", "processes", `${processInstanceId}.jsonl`);
const state: ProcessLifecycleState = {
	installed: false,
	sequence: 0,
	completed: false,
	fatalObserved: false,
	droppedEvents: 0,
	context: {
		role: inheritedRole ?? inferProcessRole(),
		...inheritedContext,
	},
};

function parseInheritedContext(value: string | undefined): ProcessLifecycleContext {
	if (!value || value.length > 4096) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const context: ProcessLifecycleContext = {};
		for (const [key, entry] of Object.entries(parsed)) {
			if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
			if (typeof entry === "string") context[key] = redactSensitiveText(entry).slice(0, 1024);
			else if (typeof entry === "number" && Number.isFinite(entry)) context[key] = entry;
			else if (typeof entry === "boolean") context[key] = entry;
		}
		return context;
	} catch {
		return {};
	}
}

function inferProcessRole(): string {
	if (process.env.PRIME_AGENT_INTERNAL_DAEMON_CATALOG === "1") return "daemon-catalog";
	if (process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER === "1") return "daemon-worker";
	if (process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER === "1") return "owned-session-worker";
	if (process.argv.includes("--internal-update-restart-coordinator")) return "update-restart-coordinator";
	const modeIndex = process.argv.indexOf("--mode");
	if (modeIndex >= 0 && process.argv[modeIndex + 1] === "daemon") return "daemon-supervisor";
	return process.versions.bun ? "bun-client" : "client";
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/\b(?:sk|sk-ant|ghp|github_pat|xox[baprs])[-_][a-zA-Z0-9_-]{12,}\b/g, "<redacted-token>")
		.replace(/\bAIza[a-zA-Z0-9_-]{20,}\b/g, "<redacted-token>")
		.replace(
			/\b(api[-_ ]?key|authorization|token|access[-_ ]?token|refresh[-_ ]?token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi,
			"$1=<redacted>",
		);
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		[
			"args",
			"argv",
			"authorization",
			"commandline",
			"content",
			"cookie",
			"env",
			"environment",
			"environmentvariables",
			"input",
			"payload",
			"prompt",
			"requestbody",
			"responsebody",
			"setcookie",
			"token",
		].includes(normalized) ||
		normalized.endsWith("prompt") ||
		normalized.endsWith("payload") ||
		normalized.endsWith("content") ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("authtoken") ||
		normalized.endsWith("bearertoken") ||
		normalized.endsWith("accesstoken") ||
		normalized.endsWith("refreshtoken") ||
		normalized.endsWith("clientsecret") ||
		normalized.endsWith("password") ||
		normalized.endsWith("credential") ||
		normalized.endsWith("credentials")
	);
}

function summarizeOpaqueText(value: string): JsonValue {
	return {
		redacted: true,
		byteLength: Buffer.byteLength(value),
		lineCount: value.length === 0 ? 0 : value.split("\n").length,
	};
}

function projectStackFrames(stack: string | undefined): JsonValue {
	if (!stack) return [];
	const frames: string[] = [];
	for (const line of stack.split("\n").slice(1, 33)) {
		const match = line.match(/((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/);
		if (!match) continue;
		let location = match[1].replace(/^file:\/\//, "").replaceAll("\\", "/");
		const projectMarker = location.lastIndexOf("/prime-agent/");
		const sourcePackageMarker = location.lastIndexOf("/packages/coding-agent/");
		const dependencyMarker = location.lastIndexOf("/node_modules/");
		if (projectMarker >= 0) location = location.slice(projectMarker + 1);
		else if (sourcePackageMarker >= 0) location = `prime-agent/${location.slice(sourcePackageMarker + 1)}`;
		else if (dependencyMarker >= 0) location = location.slice(dependencyMarker + 1);
		else if (!location.startsWith("node:")) location = "<external>";
		if (!/^(?:<external>|node:|prime-agent\/|node_modules\/)[a-zA-Z0-9_@./:+-]*$/.test(location)) {
			location = "<external>";
		}
		frames.push(`${location}:${match[2]}:${match[3]}`);
	}
	return frames;
}

function isOpaqueTextKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return ["errormessage", "message", "rejection", "stderr", "stderrtail"].includes(normalized);
}

function sanitizeValue(
	value: unknown,
	options: SanitizeOptions,
	seen: WeakSet<object> = new WeakSet(),
	depth = 0,
	key?: string,
): JsonValue {
	if (key && shouldRedactKey(key)) return "<redacted>";
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		if (key?.toLowerCase() === "stack") return projectStackFrames(value);
		if (key && isOpaqueTextKey(key)) return summarizeOpaqueText(value);
		const redacted = redactSensitiveText(value);
		return redacted.length > options.maxStringLength
			? `${redacted.slice(0, options.maxStringLength)}…<truncated>`
			: redacted;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "boolean") return value;
	if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value);
	if (depth >= MAX_OBJECT_DEPTH) return "<max-depth>";
	if (seen.has(value)) return "<circular>";
	seen.add(value);
	if (value instanceof Error) {
		try {
			const candidate = value as Error & { code?: unknown };
			const prototypeName = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)
				?.constructor?.name;
			const rawCode = candidate.code;
			const rawCause = value.cause;
			const cause =
				rawCause instanceof Error
					? rawCause
					: rawCause === undefined
						? null
						: { name: typeof rawCause, nonErrorCause: true };
			return sanitizeValue(
				{
					name:
						typeof prototypeName === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(prototypeName)
							? prototypeName
							: "Error",
					stackFrames: projectStackFrames(value.stack),
					code:
						typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode)
							? rawCode
							: typeof rawCode === "number" && Number.isFinite(rawCode)
								? rawCode
								: null,
					cause,
				},
				options,
				seen,
				depth + 1,
			);
		} catch {
			return { name: "Error", projectionFailed: true };
		}
	}
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => sanitizeValue(entry, options, seen, depth + 1));
	}
	const result: Record<string, JsonValue> = {};
	for (const [entryKey, entry] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
		result[entryKey] = sanitizeValue(entry, options, seen, depth + 1, entryKey);
	}
	return result;
}

function normalizeError(error: unknown): JsonValue {
	try {
		if (error instanceof Error) {
			return sanitizeValue(error, { maxStringLength: MAX_EVENT_STRING_LENGTH });
		}
		return { name: typeof error, nonErrorThrown: true };
	} catch {
		return { name: "unknown", projectionFailed: true };
	}
}

function safeCwd(): string {
	try {
		return redactSensitiveText(process.cwd());
	} catch {
		return "<cwd-unavailable>";
	}
}

function safeErrorName(error: unknown): string {
	try {
		const name = error instanceof Error ? error.name : typeof error;
		return /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) ? name : "unknown";
	} catch {
		return "unknown";
	}
}

function safeRuntimeErrorMessage(error: unknown): string {
	try {
		return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(
			0,
			MAX_EVENT_STRING_LENGTH,
		);
	} catch {
		return "<error-unavailable>";
	}
}

function processResources(): JsonValue {
	try {
		return sanitizeValue(
			{
				memoryUsage: process.memoryUsage(),
				resourceUsage: process.resourceUsage?.(),
			},
			{ maxStringLength: MAX_EVENT_STRING_LENGTH },
		);
	} catch (error) {
		return normalizeError(error);
	}
}

function rotateOwnProcessLog(): void {
	try {
		if (!existsSync(processLogPath) || statSync(processLogPath).size <= MAX_PROCESS_LOG_BYTES) return;
		rmSync(`${processLogPath}.old`, { force: true });
		renameSync(processLogPath, `${processLogPath}.old`);
	} catch {
		// The active process remains able to append when rotation is unavailable.
	}
}

function appendEventLine(line: string): boolean {
	try {
		mkdirSync(dirname(processLogPath), { recursive: true, mode: 0o700 });
		rotateOwnProcessLog();
		appendFileSync(processLogPath, `${line}\n`, { mode: 0o600 });
		return true;
	} catch {
		state.droppedEvents += 1;
		return false;
	}
}

function eventBase(event: string, includeResources: boolean): Record<string, JsonValue> {
	return {
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		sequence: ++state.sequence,
		event,
		processInstanceId,
		...(parentProcessInstanceId ? { parentProcessInstanceId } : {}),
		...(inheritedLaunchTrigger ? { launchTrigger: inheritedLaunchTrigger } : {}),
		pid: process.pid,
		ppid: process.ppid,
		platform: process.platform,
		architecture: process.arch,
		runtime: process.versions.bun ? "bun" : "node",
		runtimeVersion: process.versions.bun ?? process.version,
		uptimeMs: Math.round(process.uptime() * 1000),
		cwd: safeCwd(),
		context: sanitizeValue(state.context, { maxStringLength: MAX_EVENT_STRING_LENGTH }),
		...(state.droppedEvents > 0 ? { priorDroppedEvents: state.droppedEvents } : {}),
		...(includeResources ? { resources: processResources() } : {}),
	};
}

function writeEvent(event: string, details: unknown = {}, options: WriteEventOptions = {}): boolean {
	try {
		const record = {
			...eventBase(event, options.includeResources ?? false),
			details: sanitizeValue(details, { maxStringLength: MAX_EVENT_STRING_LENGTH }),
		};
		const written = appendEventLine(JSON.stringify(record));
		if (written) state.droppedEvents = 0;
		return written;
	} catch (error) {
		const fallback = JSON.stringify({
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			sequence: ++state.sequence,
			event: "lifecycle_record_failed",
			processInstanceId,
			pid: process.pid,
			originalEvent: event,
			errorName: safeErrorName(error),
		});
		return appendEventLine(fallback);
	}
}

function pruneStaleProcessLogs(): void {
	const directory = dirname(processLogPath);
	try {
		const cutoff = Date.now() - PROCESS_LOG_RETENTION_MS;
		for (const name of readdirSync(directory)) {
			if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.old")) continue;
			const path = join(directory, name);
			if (path === processLogPath || path === `${processLogPath}.old`) continue;
			if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
		}
	} catch {
		// Retention is best-effort and never blocks startup.
	}
}

function pruneCrashReports(directory: string): void {
	try {
		const reports = readdirSync(directory)
			.filter((name) => name.endsWith(".json"))
			.map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
			.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const report of reports.slice(MAX_CRASH_REPORTS)) rmSync(join(directory, report.name), { force: true });
	} catch {
		// Retention is best-effort and never blocks fatal reporting.
	}
}

function configureAutomaticNativeCrashReports(): boolean {
	const role = state.context.role;
	if (typeof role !== "string" || !NATIVE_REPORT_ROLES.has(role) || !process.report) return false;
	try {
		const directory = join(getEarlyAgentDir(), "logs", "crash-reports");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		process.report.directory = directory;
		process.report.filename = `native-crash-${processInstanceId}.json`;
		process.report.excludeEnv = true;
		process.report.reportOnSignal = false;
		process.report.reportOnUncaughtException = false;
		process.report.reportOnFatalError = true;
		pruneCrashReports(directory);
		return true;
	} catch {
		return false;
	}
}

function projectDiagnosticReport(report: unknown): JsonValue {
	try {
		if (!report || typeof report !== "object") return {};
		const source = report as Record<string, unknown>;
		const header =
			source.header && typeof source.header === "object" ? (source.header as Record<string, unknown>) : {};
		return sanitizeValue(
			{
				header: {
					reportVersion: header.reportVersion,
					event: header.event,
					trigger: header.trigger,
					dumpEventTime: header.dumpEventTime,
					processId: header.processId,
					threadId: header.threadId,
					nodejsVersion: header.nodejsVersion,
					wordSize: header.wordSize,
					arch: header.arch,
					platform: header.platform,
					componentVersions: header.componentVersions,
					release: header.release,
					osName: header.osName,
					osRelease: header.osRelease,
					osVersion: header.osVersion,
					osMachine: header.osMachine,
				},
				javascriptHeap: source.javascriptHeap,
				resourceUsage: source.resourceUsage,
				uvthreadResourceUsage: source.uvthreadResourceUsage,
				nativeStack: source.nativeStack,
				userLimits: source.userLimits,
			},
			{ maxStringLength: MAX_REPORT_STRING_LENGTH },
		);
	} catch {
		return { projectionFailed: true };
	}
}

function writeCrashReport(error: unknown, kind: string): string | undefined {
	const getReport = process.report?.getReport;
	if (!getReport) return undefined;
	try {
		const directory = join(getEarlyAgentDir(), "logs", "crash-reports");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(
			directory,
			`crash-${safeTimestamp}-${process.pid}-${processInstanceId}-${state.sequence + 1}.json`,
		);
		const tempPath = `${path}.tmp`;
		const report = projectDiagnosticReport(getReport.call(process.report));
		const document = {
			schemaVersion: 1,
			kind,
			processInstanceId,
			parentProcessInstanceId,
			role: state.context.role,
			createdAt: new Date().toISOString(),
			error: normalizeError(error),
			report,
		};
		writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
		pruneCrashReports(directory);
		return path;
	} catch {
		return undefined;
	}
}

function writeFatalEvent(event: string, error: unknown, details: Record<string, unknown> = {}): string | undefined {
	state.fatalObserved = true;
	const reportPath = writeCrashReport(error, event);
	const written = writeEvent(
		event,
		{
			...details,
			error: normalizeError(error),
			reportPath,
		},
		{ includeResources: true },
	);
	if (!written) {
		try {
			process.stderr.write(`Prime Agent could not persist ${event} to ${processLogPath}: ${safeErrorName(error)}\n`);
		} catch {
			// No additional fallback is safe at a fatal boundary.
		}
	}
	return reportPath;
}

function onUncaughtExceptionMonitor(error: Error, origin: NodeJS.UncaughtExceptionOrigin): void {
	const prior = state.lastRejection;
	if (prior?.reason === error) {
		writeEvent(
			"uncaught_exception",
			{ origin, error: normalizeError(error), reportPath: prior.reportPath, followsUnhandledRejection: true },
			{ includeResources: true },
		);
		return;
	}
	writeFatalEvent("uncaught_exception", error, { origin });
}

type UnhandledRejectionMode = "strict" | "throw" | "warn" | "warn-with-error-code" | "none";

function unhandledRejectionMode(): UnhandledRejectionMode {
	const options = `${process.execArgv.join(" ")} ${process.env.NODE_OPTIONS ?? ""}`;
	const configuredMode = options.match(
		/--unhandled-rejections(?:=|\s+)(strict|throw|warn-with-error-code|warn|none)/,
	)?.[1];
	return (configuredMode as UnhandledRejectionMode | undefined) ?? "throw";
}

function onUnhandledRejection(reason: unknown): void {
	const mode = unhandledRejectionMode();
	const ownsDefaultBehavior = process.listenerCount("unhandledRejection") === 1;
	const fatal = ownsDefaultBehavior && (mode === "strict" || mode === "throw");
	const reportPath = fatal
		? writeFatalEvent("unhandled_rejection", reason)
		: writeCrashReport(reason, "unhandled_rejection");
	if (!fatal) {
		writeEvent(
			"unhandled_rejection",
			{ error: normalizeError(reason), reportPath, fatal: false, mode },
			{ includeResources: true },
		);
	}
	state.lastRejection = { reason, reportPath };
	if (fatal) {
		process.removeListener("unhandledRejection", onUnhandledRejection);
		setImmediate(() => {
			throw reason instanceof Error ? reason : new Error(safeRuntimeErrorMessage(reason));
		});
	} else if (ownsDefaultBehavior && mode === "warn-with-error-code" && !process.exitCode) {
		process.exitCode = 1;
	}
}

const signalHandlers = new Map<LifecycleSignal, () => void>();

function installSignalHandler(signal: LifecycleSignal): void {
	const handler = () => {
		writeEvent("signal_received", { signal }, { includeResources: true });
		const otherListeners = process.listeners(signal).filter((listener) => listener !== handler);
		if (otherListeners.length === 0) {
			process.removeListener(signal, handler);
			process.kill(process.pid, signal);
		}
	};
	signalHandlers.set(signal, handler);
	process.on(signal, handler);
}

function onBeforeExit(code: number): void {
	writeEvent("process_before_exit", { code }, { includeResources: true });
}

function onExit(code: number): void {
	writeEvent(
		"process_exit",
		{ code, completed: state.completed, fatalObserved: state.fatalObserved },
		{ includeResources: true },
	);
}

export function installProcessLifecycle(context: ProcessLifecycleContext = {}): () => void {
	setProcessLifecycleContext(context);
	if (state.installed) return state.dispose ?? (() => {});
	state.installed = true;

	const nativeCrashReportsEnabled = configureAutomaticNativeCrashReports();
	writeEvent("process_start", { nativeCrashReportsEnabled }, { includeResources: true });
	process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
	process.on("unhandledRejection", onUnhandledRejection);
	process.on("beforeExit", onBeforeExit);
	process.on("exit", onExit);
	for (const signal of SIGNALS) installSignalHandler(signal);

	state.heartbeat = setInterval(() => {
		writeEvent("process_heartbeat", {}, { includeResources: true });
	}, HEARTBEAT_INTERVAL_MS);
	state.heartbeat.unref();
	setImmediate(pruneStaleProcessLogs).unref();

	state.dispose = () => {
		if (!state.installed) return;
		state.installed = false;
		if (state.heartbeat) clearInterval(state.heartbeat);
		state.heartbeat = undefined;
		process.removeListener("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
		process.removeListener("unhandledRejection", onUnhandledRejection);
		process.removeListener("beforeExit", onBeforeExit);
		process.removeListener("exit", onExit);
		for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
		signalHandlers.clear();
	};
	return state.dispose;
}

export function setProcessLifecycleContext(context: ProcessLifecycleContext): void {
	try {
		const sanitized = sanitizeValue(context, { maxStringLength: MAX_EVENT_STRING_LENGTH });
		if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return;
		state.context = { ...state.context, ...sanitized };
		if (state.installed) writeEvent("process_context_updated", { changedKeys: Object.keys(context) });
	} catch {
		// Logging context is best-effort and must never fail the caller.
	}
}

export function recordProcessLifecycle(event: string, details: unknown = {}): void {
	writeEvent(event, details);
}

export function markProcessLifecycleCompleted(details: unknown = {}): void {
	if (state.completed) return;
	state.completed = true;
	writeEvent("process_completed", details, { includeResources: true });
}

export function getProcessLifecycleInfo(): {
	processInstanceId: string;
	parentProcessInstanceId?: string;
	processLogPath: string;
} {
	return { processInstanceId, parentProcessInstanceId, processLogPath };
}

export function createObservedProcessInstanceId(): string {
	return randomUUID();
}

export function withoutProcessLifecycleEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	try {
		const isolatedEnvironment = { ...environment };
		delete isolatedEnvironment[PROCESS_INSTANCE_ENV];
		delete isolatedEnvironment[PARENT_PROCESS_INSTANCE_ENV];
		delete isolatedEnvironment[PROCESS_LAUNCH_TRIGGER_ENV];
		delete isolatedEnvironment[PROCESS_CONTEXT_ENV];
		delete isolatedEnvironment[PROCESS_ROLE_ENV];
		return isolatedEnvironment;
	} catch {
		return {};
	}
}

export function prepareProcessLifecycleLaunch(
	environment: NodeJS.ProcessEnv,
	options: ProcessLifecycleLaunchOptions,
): ProcessLifecycleLaunch {
	const childProcessInstanceId = randomUUID();
	let serializedContext = "{}";
	try {
		const context = sanitizeValue(options.context ?? {}, { maxStringLength: 1024 });
		const candidate = JSON.stringify(context);
		if (candidate.length <= 4096) serializedContext = candidate;
	} catch {
		// Child launch must never fail because optional lifecycle context is malformed.
	}
	return {
		childProcessInstanceId,
		environment: {
			...environment,
			[PROCESS_INSTANCE_ENV]: childProcessInstanceId,
			[PARENT_PROCESS_INSTANCE_ENV]: processInstanceId,
			[PROCESS_LAUNCH_TRIGGER_ENV]: options.trigger.slice(0, 256),
			[PROCESS_ROLE_ENV]: options.role.slice(0, 128),
			[PROCESS_CONTEXT_ENV]: serializedContext,
		},
	};
}
