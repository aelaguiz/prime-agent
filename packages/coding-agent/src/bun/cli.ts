#!/usr/bin/env node
import { restoreSandboxEnv } from "./restore-sandbox-env.js";

restoreSandboxEnv();

const { installProcessLifecycle } = await import("../core/process-lifecycle.js");
installProcessLifecycle();

const { APP_NAME } = await import("../config.js");
process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

await import("./register-bedrock.js");
await import("../cli.js");
