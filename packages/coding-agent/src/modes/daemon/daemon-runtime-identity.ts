import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url);
const SOURCE_RUNTIME_PATHS = [
	"package.json",
	"tsconfig*.json",
	"prime-agent-runtime/pyproject.toml",
	"prime-agent-runtime/src/**",
	":(glob)packages/*/package.json",
	":(glob)packages/*/src/**",
] as const;

function gitText(root: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function gitPaths(root: string, args: readonly string[]): string[] {
	return execFileSync("git", ["-C", root, ...args, "-z", "--", ...SOURCE_RUNTIME_PATHS], {
		maxBuffer: GIT_MAX_BUFFER_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	})
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
}

/** Fingerprint executable workspace source while ignoring docs, tests, and other non-runtime checkout churn. */
export function computeSourceBuildId(root: string): string {
	const requestedRoot = resolve(root);
	try {
		const repositoryRoot = gitText(requestedRoot, ["rev-parse", "--show-toplevel"]).trim();
		const trackedPaths = gitPaths(repositoryRoot, ["ls-files"]);
		const untrackedPaths = gitPaths(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]);
		const sourcePaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();
		if (sourcePaths.length === 0) {
			throw new Error("git found no tracked Prime Agent runtime source");
		}
		const sourceHash = createHash("sha256");
		sourceHash.update("prime-agent-source-v1\0");
		let hashedPathCount = 0;
		for (const path of sourcePaths) {
			let contents: Buffer;
			try {
				contents = readFileSync(join(repositoryRoot, path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !trackedPaths.includes(path)) {
					throw error;
				}
				continue;
			}
			sourceHash.update(path);
			sourceHash.update("\0");
			sourceHash.update(contents);
			sourceHash.update("\0");
			hashedPathCount += 1;
		}
		if (hashedPathCount === 0) {
			throw new Error("git found no Prime Agent runtime source in the worktree");
		}
		return `source-v1:${sourceHash.digest("hex")}`;
	} catch (error) {
		throw new Error(`Cannot fingerprint Prime Agent source from ${requestedRoot}: ${String(error)}`, {
			cause: error,
		});
	}
}

function collectBundleJavaScriptFiles(root: string, directory = root, files: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectBundleJavaScriptFiles(root, path, files);
		} else if (entry.isFile() && entry.name.endsWith(".js")) {
			files.push(relative(root, path));
		}
	}
	return files;
}

function readEmbeddedBundleBuildId(bundleRoot: string): string | undefined {
	const entrypoint = join(bundleRoot, "cli.js");
	let descriptor: number | undefined;
	try {
		descriptor = openSync(entrypoint, "r");
		const buffer = Buffer.alloc(4096);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		return buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.match(/^\/\/ prime-agent-bundle-build-id: (bundle-v1:[a-f0-9]{64})$/m)?.[1];
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** Fingerprint an executable JavaScript bundle closure or a compiled single-file binary. */
export function computeBundleBuildId(bundlePath: string): string {
	const root = resolve(bundlePath);
	try {
		if (statSync(root).isFile()) {
			const hash = createHash("sha256");
			hash.update("prime-agent-bundle-v1\0compiled-executable\0");
			hash.update(readFileSync(root));
			return `bundle-v1:${hash.digest("hex")}`;
		}
		const embeddedBuildId = readEmbeddedBundleBuildId(root);
		if (embeddedBuildId) return embeddedBuildId;
		const files = collectBundleJavaScriptFiles(root).sort();
		if (files.length === 0) {
			throw new Error("bundle contains no JavaScript files");
		}
		const hash = createHash("sha256");
		hash.update("prime-agent-bundle-v1\0");
		for (const path of files) {
			hash.update(path.split(sep).join("/"));
			hash.update("\0");
			hash.update(readFileSync(join(root, path)));
			hash.update("\0");
		}
		return `bundle-v1:${hash.digest("hex")}`;
	} catch (error) {
		throw new Error(`Cannot fingerprint Prime Agent bundle at ${root}: ${String(error)}`, { cause: error });
	}
}

function findBundleDirectory(modulePath: string): string | undefined {
	let directory = dirname(resolve(modulePath));
	while (true) {
		const parent = dirname(directory);
		if (basename(directory) === "bundle" && basename(parent) === "dist") {
			return directory;
		}
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

export function computeRuntimeBuildId(entrypointPath: string): string {
	const entrypoint = realpathSync(resolve(entrypointPath));
	const bundleDirectory = findBundleDirectory(entrypoint);
	return bundleDirectory ? computeBundleBuildId(bundleDirectory) : computeSourceBuildId(dirname(entrypoint));
}

let cachedRuntimeBuildId: string | undefined;

function getRuntimeBuildId(): string {
	const entrypoint = process.argv[1];
	const injectedBuildId =
		typeof __PI_BUILD_ID__ === "string" && /^bundle-v1:[a-f0-9]{64}$/.test(__PI_BUILD_ID__)
			? __PI_BUILD_ID__
			: undefined;
	cachedRuntimeBuildId ??=
		injectedBuildId ??
		(isBunBinary
			? computeBundleBuildId(realpathSync(process.execPath))
			: computeRuntimeBuildId(entrypoint ?? RUNTIME_MODULE_PATH));
	return cachedRuntimeBuildId;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	return {
		buildId: getRuntimeBuildId(),
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}
