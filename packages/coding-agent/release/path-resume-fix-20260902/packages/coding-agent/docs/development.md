# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Prime Agent requires Node.js 22.8.0 or newer.

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
```

Run from source:

```bash
/path/to/prime-agent/prime-agent.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

Prime Agent is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-prime-agent-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public Prime Agent install path.

## Local Configuration

User configuration lives under `~/.prime/agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.prime/agent/` in the project root. Override the user config directory with `PRIME_AGENT_CODING_AGENT_DIR` and the session directory with `PRIME_AGENT_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
PRIME_AGENT_CODING_AGENT_DIR=/tmp/prime-agent-dev /path/to/prime-agent/prime-agent.sh
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

Prime Agent runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

## Debugging

The hidden `/debug` command writes `~/.prime/agent/prime-agent-debug.log` with rendered TUI lines, their visible widths, and the current agent messages.

Runtime diagnostics live under `~/.prime/agent/logs/`:

- `processes/<processInstanceId>.jsonl` records one process's start, heartbeat, signals, fatal failures, exit, and Prime-owned child/restart events. Join files by `processInstanceId`, `parentProcessInstanceId`, and child process instance IDs.
- `crash-reports/` contains privacy-reduced Node diagnostic reports referenced by catchable JavaScript fatal events. Reports use an allowlisted runtime/resource projection; environment variables, command arguments, error messages, and user text are omitted. Prompt-free daemon-worker, catalog, and update-coordinator roles also enable Node native-fatal reports with environment exclusion. Supervisors, clients, and owned workers do not because their argv can contain user text or credentials.
- Persisted error and Python stderr text is projected to byte/line counts. JavaScript stacks retain only validated project, dependency, or `node:` frame locations. Raw stderr remains available only to the current in-memory startup error path.
- Python REPL disposal snapshots state when requested, then asks the CPython runtime to close MCP connections and stop managed `bash()` process groups. It waits boundedly for process exit, then terminates the child and reaps any journaled process groups as a fallback.
- `agent.jsonl`, per-socket daemon logs, and `client-errors.log` retain the existing agent/provider, daemon, and client launch context.

Search all process timelines with `rg 'daemon_worker_close|kernel_process_exit|uncaught_exception' ~/.prime/agent/logs/processes`. A process killed by `SIGKILL`, host loss, or a native failure cannot write its own final event; use its last heartbeat and the parent-observed child exit instead. Process logs older than 14 days are removed best-effort, each active process log rotates at 5 MiB, and the newest 20 crash reports are retained.

Useful service commands:

```bash
prime-agent status
prime-agent doctor
prime-agent doctor --fix
prime-agent shutdown
```

## Validation

After code changes, run the repository check from the root:

```bash
npm run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.
