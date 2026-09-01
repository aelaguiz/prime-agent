import { accessSync, constants, existsSync, lstatSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { getBinDir } from "../config.js";
import {
	type ActiveOrphanProcessCandidate,
	enrollOrphanProcess,
	retireOrphanProcess,
	retireOrphanProcessAfterHeldWindowsJobEmpty,
	withoutOrphanProcessJournalAuthority,
} from "../core/orphan-process-journal.js";
import { isExactProcessStartId } from "../core/session-lease.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

// Ambient ProgramFiles and PATH values must not select executable code that
// runs before the Windows Job admission protocol exists.
const WINDOWS_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

const POSIX_PATH_SCAN_MAX_ENTRIES = 256;
const POSIX_PATH_ENTRY_MAX_BYTES = 4 * 1024;

function isExecutableRegularFile(path: string): boolean {
	try {
		const link = lstatSync(path);
		if (!link.isFile() && !link.isSymbolicLink()) return false;
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve bash from PATH as bounded filesystem data without executing a helper. */
function findBashOnPath(pathValue = process.env.PATH ?? ""): string | null {
	const entries = pathValue.split(delimiter).slice(0, POSIX_PATH_SCAN_MAX_ENTRIES);
	for (const entry of entries) {
		if (Buffer.byteLength(entry, "utf8") > POSIX_PATH_ENTRY_MAX_BYTES) continue;
		const candidate = resolve(entry || ".", "bash");
		if (isExecutableRegularFile(candidate)) return candidate;
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in canonical locations only
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to /bin/sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		for (const path of WINDOWS_GIT_BASH_PATHS) {
			if (existsSync(path)) return { shell: path, args: ["-c"] };
		}
		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				"  2. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${WINDOWS_GIT_BASH_PATHS.map((path) => `  ${path}`).join("\n")}`,
		);
	}

	// POSIX resolution is data-only: no `which`, shell, loader, or other helper
	// may run before the selected shell itself enters process containment.
	if (existsSync("/bin/bash") && isExecutableRegularFile("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "/bin/sh", args: ["-c"] };
}

/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the canonical Git Bash install paths,
 * never PATH (a repo-controlled PATH/where.exe must not pick the kernel shell).
 * undefined = no shell found: kernel startup must not fail, bash() raises its
 * teaching error.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	for (const path of WINDOWS_GIT_BASH_PATHS) {
		if (existsSync(path)) {
			return path;
		}
	}
	return undefined;
}

export function getShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(source).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = source[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return withoutOrphanProcessJournalAuthority({
		...source,
		[pathKey]: updatedPath,
	});
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const TRACKED_DETACHED_CHILD_ENROLLMENT = Symbol("tracked-detached-child-enrollment");

type ExactTrackedCandidate = ActiveOrphanProcessCandidate & { processStartId: string };

/** Immutable capability for one exact enrollment. A PID alone is never authority. */
export interface TrackedDetachedChildEnrollment {
	readonly pid: number;
	readonly kernelPid?: number;
	readonly processStartId: string;
	readonly [TRACKED_DETACHED_CHILD_ENROLLMENT]: true;
}

interface TrackedDetachedChild {
	candidate: ExactTrackedCandidate;
	requestTermination: () => void;
}

// Object-identity keys preserve concurrent/late enrollments even when Windows
// has already reused the numeric PID for a different exact process identity.
const trackedDetachedChildren = new Map<TrackedDetachedChildEnrollment, TrackedDetachedChild>();

function isExactTrackedIdentity(value: string | undefined): value is string {
	return typeof value === "string" && isExactProcessStartId(value);
}

/**
 * Enroll a newly spawned, still-gated child and return the sole immutable
 * capability that can retire this exact journal candidate.
 */
export function enrollTrackedDetachedChildPid(
	pid: number,
	requestTermination: () => void,
	expectedProcessStartId?: string,
): TrackedDetachedChildEnrollment {
	const observed = enrollOrphanProcess(pid, undefined, expectedProcessStartId);
	if (!isExactTrackedIdentity(observed.processStartId)) {
		throw new Error(`Cannot track detached child ${pid} without an exact process identity`);
	}
	const candidate = Object.freeze({ ...observed, processStartId: observed.processStartId });
	const enrollment: TrackedDetachedChildEnrollment = Object.freeze({
		pid: candidate.pid,
		...(candidate.kernelPid !== undefined ? { kernelPid: candidate.kernelPid } : {}),
		processStartId: candidate.processStartId,
		[TRACKED_DETACHED_CHILD_ENROLLMENT]: true as const,
	});
	trackedDetachedChildren.set(enrollment, { candidate, requestTermination });
	return enrollment;
}

export function untrackDetachedChildPid(enrollment: TrackedDetachedChildEnrollment): boolean {
	const tracked = trackedDetachedChildren.get(enrollment);
	if (!tracked) return true;
	if (!retireOrphanProcess(tracked.candidate)) return false;
	trackedDetachedChildren.delete(enrollment);
	return true;
}

/**
 * Retire only the captured candidate covered by this live owner's exact
 * empty-Job proof. Generic Windows exits retain their journal record.
 */
export function untrackDetachedChildPidAfterHeldWindowsJobEmpty(enrollment: TrackedDetachedChildEnrollment): boolean {
	const tracked = trackedDetachedChildren.get(enrollment);
	if (!tracked) return true;
	if (!retireOrphanProcessAfterHeldWindowsJobEmpty(tracked.candidate)) return false;
	trackedDetachedChildren.delete(enrollment);
	return true;
}

export function killTrackedDetachedChildren(): void {
	for (const [enrollment, tracked] of trackedDetachedChildren) {
		tracked.requestTermination();
		try {
			if (retireOrphanProcess(tracked.candidate)) trackedDetachedChildren.delete(enrollment);
		} catch {
			// Shutdown signaling must continue; canonical cleanup retains the record.
		}
	}
}
