import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installProcessLifecycle,
	markProcessLifecycleCompleted,
	recordProcessLifecycle,
	setProcessLifecycleContext,
} from "../../src/core/process-lifecycle.js";

const action = process.argv[2];
installProcessLifecycle({ ...(action === "clean" ? {} : { role: "lifecycle-test-fixture" }), fixtureAction: action });

switch (action) {
	case "throw":
		setImmediate(() => {
			throw new Error("prime-lifecycle-throw-sentinel apiKey=prime-error-secret sk-ant-abcdefghijklmnopqrstuv", {
				cause: {
					clientSecret: "prime-cause-opaque-secret",
					value: "prime-cause-payload-opaque-secret",
				},
			});
		});
		break;
	case "reject":
		void Promise.reject(new Error("prime-lifecycle-rejection-sentinel"));
		break;
	case "reject-owner":
		process.on("unhandledRejection", () => process.exit(80));
		void Promise.reject(new Error("prime-lifecycle-owned-rejection-sentinel"));
		break;
	case "throw-owner":
		process.on("uncaughtException", () => process.exit(79));
		setImmediate(() => {
			throw new Error("prime-lifecycle-owned-throw-sentinel");
		});
		break;
	case "signal":
		process.stdout.write("ready\n");
		setInterval(() => undefined, 1000);
		break;
	case "signal-owner":
		process.on("SIGTERM", () => process.exit(77));
		process.stdout.write("ready\n");
		setInterval(() => undefined, 1000);
		break;
	case "missing-cwd": {
		const deletedCwd = mkdtempSync(join(tmpdir(), "prime-lifecycle-deleted-cwd-"));
		process.chdir(deletedCwd);
		rmSync(deletedCwd, { recursive: true, force: true });
		recordProcessLifecycle("missing_cwd_fixture_event");
		process.chdir(tmpdir());
		markProcessLifecycleCompleted({ result: "missing-cwd-survived" });
		break;
	}
	case "malformed-details": {
		const malformed = new Proxy<Record<string, unknown>>(
			{},
			{
				ownKeys: () => {
					throw new Error("malformed lifecycle details");
				},
			},
		);
		setProcessLifecycleContext(malformed);
		recordProcessLifecycle("malformed_fixture_event", malformed);
		markProcessLifecycleCompleted({ result: "malformed-details-survived" });
		break;
	}
	case "sensitive":
		setProcessLifecycleContext({ OPENAI_API_KEY: "prime-context-opaque-secret" });
		recordProcessLifecycle("sensitive_fixture_event", {
			password: "prime-details-opaque-secret",
			prompt: "prime-prompt-opaque-secret",
			providerPayload: { output: "prime-provider-payload-opaque-secret" },
			errorMessage: "prime-error-message-opaque-secret",
			nested: { authToken: "prime-nested-opaque-secret" },
		});
		markProcessLifecycleCompleted({ result: "sensitive-fixture-complete" });
		break;
	case "clean":
		markProcessLifecycleCompleted({ result: "fixture-complete" });
		break;
	default:
		throw new Error(`Unknown lifecycle fixture action: ${String(action)}`);
}
