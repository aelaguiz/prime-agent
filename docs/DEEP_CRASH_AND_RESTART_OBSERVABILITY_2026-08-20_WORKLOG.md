---
title: "Prime Agent - Deep Crash and Restart Observability - Worklog"
date: 2026-08-20
status: complete
plan: docs/DEEP_CRASH_AND_RESTART_OBSERVABILITY_2026-08-20.md
---

# Implementation status

- Phase 1: COMPLETE
- Phase 2: COMPLETE
- Phase 3: COMPLETE

# Scope ledger

- Authorized: lifecycle SSOT, early Node/Bun installation, Prime-owned daemon/worker/catalog/coordinator/owned-worker/kernel/fork-server boundaries, focused tests, developer docs, changelog.
- Approved convergence required: universal fatal ownership and durable kernel/fork-server evidence.
- Out of scope: automatic recovery changes, remote telemetry, arbitrary subprocess logging, daemon protocol changes.
- Pre-existing work preserved: `packages/coding-agent/src/core/kernel/bootstrap.ts`, `packages/coding-agent/test/kernel-bootstrap.test.ts`, `docs/bugs/uv-only-system-kernel-bootstrap.md`, and the first current Unreleased changelog bullet.

# Evidence log

## 2026-08-20 — Planning complete

- Read process, daemon, worker, update, owned-worker, kernel, fork-server, logging, and test ownership surfaces.
- Three read-only audits completed: lifecycle topology, observability gaps, and deterministic test seams.
- Chosen storage changed from a shared rotating lifecycle file to one single-writer file per process instance after the audit identified existing shared-rotation races.
- External live search was unavailable because Serper is not configured. Node process/report contracts were grounded against installed `@types/node` and official API URLs.

# Files changed by this implementation

- `docs/DEEP_CRASH_AND_RESTART_OBSERVABILITY_2026-08-20.md`
- `docs/DEEP_CRASH_AND_RESTART_OBSERVABILITY_2026-08-20_WORKLOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/docs/development.md`
- `packages/coding-agent/src/bun/cli.ts`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/cli/daemon-command.ts`
- `packages/coding-agent/src/cli/daemon-launch.ts`
- `packages/coding-agent/src/cli/daemon-update-restart.ts`
- `packages/coding-agent/src/cli/owned-session-worker.ts`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/core/kernel/fork-server-script.ts`
- `packages/coding-agent/src/core/kernel/fork-server.ts`
- `packages/coding-agent/src/core/kernel/index.ts`
- `packages/coding-agent/src/core/logging.ts`
- `packages/coding-agent/src/core/process-lifecycle.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts`
- `packages/coding-agent/src/modes/daemon/daemon-catalog-process.ts`
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts`
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`
- `packages/coding-agent/test/daemon-catalog-lifecycle-process.test.ts`
- `packages/coding-agent/test/daemon-supervisor-process.test.ts`
- `packages/coding-agent/test/fixtures/block-cli-main-loader.mjs`
- `packages/coding-agent/test/fixtures/daemon-catalog-lifecycle-child.ts`
- `packages/coding-agent/test/fixtures/process-lifecycle-child.ts`
- `packages/coding-agent/test/fixtures/register-block-cli-main.mjs`
- `packages/coding-agent/test/global-setup.ts`
- `packages/coding-agent/test/kernel-fork-server.test.ts`
- `packages/coding-agent/test/kernel-startup.test.ts`
- `packages/coding-agent/test/owned-session-worker-process.test.ts`
- `packages/coding-agent/test/process-lifecycle-process.test.ts`
- `packages/coding-agent/vitest.config.ts`

## 2026-08-20 — Phase 1 proof

- Added the early, dependency-light lifecycle recorder and single-writer per-process storage.
- Added privacy-reduced Node diagnostic reports for catchable JavaScript fatal events.
- Added early Node and Bun entry installation and lifecycle context propagation from the existing structured logger.
- `test/process-lifecycle-process.test.ts`: PASS (5 tests).
- `test/stdout-cleanliness.test.ts`: PASS (2 tests).
- Intermediate root `npm run check`: PASS. Biome formatted one new file; type, installer, and browser smoke checks passed.
- `packages/coding-agent/src/core/process-lifecycle.ts`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/bun/cli.ts`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/core/logging.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/test/fixtures/process-lifecycle-child.ts`
- `packages/coding-agent/test/process-lifecycle-process.test.ts`

## 2026-08-20 — Phase 2 lifecycle coverage complete

- Instrumented daemon supervisor, daemon worker, catalog, update coordinator, owned session worker, direct/forked kernels, and the fork server without changing retry, adoption, signal, shutdown, or daemon protocol policy.
- Added parent/child instance lineage, launch triggers, actual `spawn`-event facts, exit/connection-close classification, adoption/recovery attempts and results, kernel restart IDs, and fork-server replacement IDs.
- Forked kernels now use an atomic Python reaper status file to report exit code or signal to the Node owner. Direct and forked Python processes receive parent-observed logical IDs but no Node lifecycle identity environment variables.
- Fixed direct-kernel cleanup so its retained per-launch observation records terminal status even after manager fields are cleared or a later launch begins.
- Added explicit clean-completion events for deliberate daemon supervisor, daemon worker, and catalog shutdowns.

## 2026-08-20 — Adversarial review fixes

- Made lifecycle exports and fatal projection best-effort/no-throw for deleted cwd, hostile getters/proxies, malformed causes, and fallback writes.
- Preserved Node default, `warn`, `warn-with-error-code`, later rejection-owner, default signal, and later signal-owner semantics.
- Removed the Bun entrypoint role override; a real Bun child proved an inherited `daemon-catalog` role remains intact.
- Replaced durable opaque error/stderr text with byte/line summaries and validated stack-frame locations. Catchable crash reports now use a runtime/resource allowlist. Prompt, provider-payload, argv, environment, auth, raw error, and raw stderr sentinels are absent from lifecycle JSONL/reports.
- Scoped fork-server stderr as shared server evidence rather than attributing it to one forked kernel.
- Added per-Vitest-run agent-directory isolation and removed inherited internal daemon-worker identity from the test process.

## 2026-08-20 — Focused proof

- `test/process-lifecycle-process.test.ts`: PASS (13), including real early CLI failure, Bun role preservation, privacy, malformed input, deleted cwd, rejection modes, and signals.
- Kernel lifecycle batch: PASS (29), one existing MCP test skipped by its own gate. `kernel-startup.test.ts`: PASS (4); `kernel-fork-server.test.ts`: PASS (6).
- Daemon launch/mode/catalog/owned-worker batch: PASS (257).
- Supervisor monitor/ownership/admission batch: PASS (103).
- `daemon-supervisor-process.test.ts`: PASS (10), eight process-stress tests skipped by the default tag filter; the worker spawn-error process-stress case passed separately.
- `owned-session-worker-process.test.ts`: PASS (8), including crash/relaunch lineage.
- `daemon-catalog-lifecycle-process.test.ts`: PASS, including `SIGKILL`, lazy recovery, and expected shutdown.
- `4606-update-restart-coordinator.test.ts`: PASS (5) with inherited internal worker-role variables removed.
- Intermediate `npx tsgo --noEmit`: PASS after the final lifecycle API and process-owner edits.

## 2026-08-20 — Final repository check

- First final `npm run check` found four incorrect lifecycle constant names in the new Python-environment stripping helper. The helper and its regression test were corrected to strip all five actual internal lifecycle variables, including role.
- `test/kernel-startup.test.ts`: PASS (4) after the correction.
- `npx tsgo --noEmit`: PASS after the correction.
- Final root `npm run check`: PASS. Type, installer render, and browser smoke checks passed.
- A final spawn-truth pass moved direct-kernel and fork-server start facts plus owned-worker recovery success facts onto actual child `spawn` events; asynchronous spawn errors can no longer coexist with a false spawned result.
- Non-Error `Error.cause` values are now reduced to type-only metadata, closing the last arbitrary-cause text path.
- `test/process-lifecycle-process.test.ts`, `test/kernel-startup.test.ts`, `test/kernel-fork-server.test.ts`, and `test/owned-session-worker-process.test.ts` all passed again after those corrections.
- Root `npm run check` passed again after the corrections; Biome formatted one changed file, and type, installer render, and browser smoke checks passed.

## 2026-08-20 — Independent implementation audit approved

- The first final read-only audit found four blockers: supervisor native-report argv privacy, code-zero/pending owned-RPC misclassification, missing async forked-dispose wait status, and unclassified supervisor exit observations.
- Repaired all four and reran the affected owned-worker, kernel, daemon launch/command/mode, and type checks.
- The same reviewer completed a bounded current-code recheck and returned **APPROVED** with no remaining blocker.
- Final root `npm run check`: PASS with no Biome fixes. Type, installer render, and browser smoke checks passed.
- Residuals are documented in plan Section 11: synchronous host-exit cleanup cannot await fork status, and a real forked wait-status round trip requires Linux.
