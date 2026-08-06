import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const PRIME_AGENT_BUILD_ID_ENV = "PRIME_AGENT_BUILD_ID";
export const PRIME_AGENT_EXPECTED_BUILD_ID_ENV = "PRIME_AGENT_INTERNAL_EXPECTED_BUILD_ID";
export const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

function bundledBuildId(): string | undefined {
	return typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	return {
		buildId: environment[PRIME_AGENT_BUILD_ID_ENV] ?? bundledBuildId() ?? `release-${VERSION}`,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}

export function assertExpectedDaemonBuildIdentity(environment: NodeJS.ProcessEnv = process.env): void {
	const expected = environment[PRIME_AGENT_EXPECTED_BUILD_ID_ENV];
	if (!expected) return;
	const actual = getDaemonRuntimeIdentity(environment).buildId;
	if (actual !== expected) {
		throw new Error(`Refusing daemon ownership for build ${actual}; expected ${expected}`);
	}
}

/** Recompute dirty source truth before spawning a worker; never trust an inherited source BUILD_ID. */
export function recomputeSourceBuildId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	if (!launcher) return undefined;
	const root = dirname(resolve(launcher));
	const helper = join(root, "scripts", "source-build-id.mjs");
	if (!existsSync(helper)) {
		throw new Error(`Cannot attest source worker build: missing ${helper}`);
	}
	const result = spawnSync(process.execPath, [helper, root], { encoding: "utf8", timeout: 10_000 });
	const buildId = result.stdout.trim();
	if (result.status !== 0 || !buildId) {
		const detail =
			result.error?.message || result.stderr.trim() || result.signal || `exit ${result.status ?? "unknown"}`;
		throw new Error(`Cannot attest source worker build: ${detail}`);
	}
	return buildId;
}
