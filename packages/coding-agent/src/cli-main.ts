import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";
import { PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX } from "./core/session-lease.js";

export function processTitleForArgv0(argv0: string): string {
	if (!argv0.startsWith(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX)) return APP_NAME;
	const token = argv0.slice(PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX.length);
	return /^[0-9a-f]{64}$/.test(token)
		? `${APP_NAME} ${PROCESS_IDENTITY_OWNER_TOKEN_ARGUMENT_PREFIX}${token}`
		: APP_NAME;
}

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = processTitleForArgv0(process.argv0);
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await main(process.argv.slice(2));
		} finally {
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}
