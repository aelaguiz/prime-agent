---
title: "Prime Agent - Deep Crash and Restart Observability - Architecture Plan"
date: 2026-08-20
status: complete
fallback_policy: forbidden
owners: [Prime Agent maintainers]
reviewers: [local implementation audit]
doc_type: architectural_change
related:
  - packages/coding-agent/docs/daemon.md
  - packages/coding-agent/docs/development.md
---

# TL;DR

- **Outcome:** Every Prime Agent Node process, daemon supervisor, session worker, daemon catalog, update-restart coordinator, owned session worker, IPython kernel, and kernel fork server leaves durable, correlated evidence for starts, exits, fatal failures, signals, and restart attempts.
- **Problem:** Fatal coverage begins too late for early CLI failures, the detached supervisor has no general fatal handler, worker recovery records only a final summary, and kernel/fork-server exit diagnostics live only in memory. SIGKILL/native failures can leave no terminal record from the dying process.
- **Approach:** Install a dependency-light process lifecycle recorder before `cli-main.ts` loads; write bounded JSONL events plus privacy-reduced Node diagnostic reports; carry parent/launch correlation into Prime-owned child processes; add explicit parent-observed lifecycle events around daemon and kernel supervision.
- **Plan:** First prove the early fatal recorder in a real child process, then cover every Prime-owned restart boundary and kernel death path, then surface the log locations and run focused process/kernel/daemon tests plus `npm run check`.
- **Non-negotiables:** No secrets or full environment dumps in JSONL. No daemon wire change. No recovery-policy change. Logging is synchronous and best-effort at fatal boundaries. Instrumentation must not hide or convert a crash into continued execution.

<!-- arch_skill:block:planning_passes:start -->
<!--
arch_skill:planning_passes
deep_dive_pass_1: done 2026-08-20
external_research_grounding: done 2026-08-20 (official Node contracts cross-checked against installed @types/node; live Serper search unavailable)
deep_dive_pass_2: done 2026-08-20
recommended_flow: deep dive -> external research grounding -> deep dive again -> phase plan -> implement
note: This block tracks stage order only. It never overrides readiness blockers caused by unresolved decisions.
-->
<!-- arch_skill:block:planning_passes:end -->

# 0) Holistic North Star

## 0.1 The claim (falsifiable)

After this change, a forced early JavaScript exception, an unhandled rejection, a normal or signaled process exit, a detached daemon/session-worker failure, an IPython process exit, a fork-server death, and every Prime-managed recovery/relaunch attempt produce parseable, time-correlated evidence under `~/.prime/agent/logs/processes/` and `~/.prime/agent/logs/crash-reports/`. A test can prove each catchable case without provider access.

The only unavoidable no-final-write case is an uncatchable termination such as `SIGKILL`, host power loss, or some native crashes. Those cases must still be diagnosable from the process start/heartbeat record and, when a Prime parent exists, a parent-observed child exit/disconnect record.

## 0.2 In scope

- Install lifecycle logging before the heavy Node and Bun CLI module graphs load.
- Persist per-process start, context, heartbeat, signal, clean completion, exit, uncaught exception, and unhandled rejection events.
- Correlate processes with a per-process instance ID, parent instance ID, PID/PPID, role, launch trigger, daemon socket, worker/session identity when available, version, uptime, memory, and resource usage.
- Write bounded, allowlisted Node diagnostic reports for catchable JavaScript fatalities with environment, command arguments, opaque messages, and arbitrary user text omitted. Enable automatic native-fatal reports only for daemon-worker, catalog, and update-coordinator roles whose argv is prompt-free.
- Record Prime-owned child launch/close/recovery events for daemon supervisors, daemon session workers, daemon catalogs, update-restart coordinators, owned RPC workers, IPython kernels, and kernel fork servers.
- Preserve bounded stderr byte/line summaries for unexpected kernel/fork-server exits; keep raw stderr only in the existing in-memory startup error path.
- Add focused deterministic process and kernel tests, plus run relevant existing daemon/recovery tests.
- Document exact diagnostic locations and add a coding-agent changelog entry.

## 0.3 Out of scope

- Changing when Prime Agent restarts, how many retries it performs, or whether a dead IPython kernel is automatically recreated.
- Adding remote telemetry, crash uploads, Sentry, a new CLI command, a log viewer, or daemon protocol fields/capabilities.
- Capturing `SIGKILL` inside the killed process, preventing operating-system OOM kills, or promising a final event after host power loss.
- Logging user prompts, full argv, full environment variables, auth material, provider payloads, or Python namespace contents.
- Refactoring unrelated process management, session journals, recovery semantics, or the pre-existing kernel bootstrap changes in the worktree.

## 0.4 Definition of done (acceptance evidence)

- A real child process that throws before `cli-main.ts` loads exits nonzero and leaves a JSONL fatal event with projected stack-frame locations, role, PID, process instance ID, resource snapshot, and crash-report path.
- A real child process with an unhandled rejection leaves projected rejection frame locations and exits nonzero instead of continuing.
- Signal and clean-exit fixtures leave one correlated lifecycle record without breaking existing signal behavior.
- A fake Python interpreter exiting with a sentinel code/stderr leaves a persistent `kernel_process_exit` or `kernel_start_failed` event with code 42 and a nonzero, privacy-projected stderr byte/line summary; the raw sentinel is absent from lifecycle files.
- Prime-managed daemon, worker, catalog, update coordinator, owned-worker, kernel, and fork-server start/restart call sites emit launch triggers or parent-observed lifecycle events.
- Every produced lifecycle-log line parses as JSON.
- Catchable JavaScript crash reports use an allowlist and omit environment variables, command arguments, error messages, and arbitrary user text.
- Focused tests pass and root `npm run check` reports no errors, warnings, or infos.

### Scope and Simplicity Contract

- Human-authorized outcome: Deeply instrument and log all Prime Agent crashes and restarts so unexplained crashes leave enough durable information to debug.
- Authorization anchors: User request on 2026-08-20 to build the full plan, test plan, implementation, and tests directly on the existing `main` checkout.
- Smallest sufficient solution: One early process-lifecycle SSOT plus explicit instrumentation at existing supervisor/kernel boundaries; no new service, protocol, uploader, or UI.
- Initial minimal convergence closure: Replace daemon-worker-only fatal ownership with the shared early recorder while retaining daemon-local contextual logging; correlate all existing Prime-owned subprocess launch/recovery paths; persist currently volatile kernel/fork-server death evidence.
- Scope sign-off: Approved for local implementation by the original request on 2026-08-20; no later adjacent surfaces may enter without a human decision.
- Enough proof: Real fatal/rejection/signal/Bun-role fixtures, deterministic direct and forked-kernel death coverage, daemon/worker/catalog/coordinator/owned-worker process tests, and `npm run check`.
- Do not build: Remote crash collection, a log database, log query CLI, protocol changes, automatic kernel recovery, or generalized subprocess instrumentation for arbitrary shell/provider commands.
- Residual risk accepted by this plan: An unparented client/owned worker killed by `SIGKILL` or a native failure cannot write its own final cause; its unmatched start/heartbeat is the evidence boundary. Automatic native reports are limited to daemon-worker, catalog, and update-coordinator roles whose argv contains only internal flags, identifiers, and paths.

## 0.5 Key invariants (fix immediately if violated)

- Fatal instrumentation observes uncaught exceptions without owning them. For unhandled rejections or signals, it preserves any later role owner; only when no other owner exists does it restore Node's default fatal/terminal result.
- Lifecycle JSONL never includes full argv, full environment, prompts, provider payloads, raw error messages/stderr, tokens, or auth values.
- All lifecycle lines are standalone valid JSON; each process writes only its own bounded file, so crash evidence never depends on unsafe cross-process rotation.
- Fatal writes do not depend on async flushing, the daemon socket, provider code, or the shared `pi-ai` log sink.
- Process and crash-report logging is best-effort and must never become the crash cause.
- Existing daemon/session/kernel shutdown and recovery behavior is preserved.
- No second competing lifecycle format or restart registry is introduced.

# 1) Key Design Considerations (what matters most)

## 1.1 Priorities (ranked)

1. Capture privacy-projected stack locations/stderr size, signal/exit status, and parent-observed cause before teardown destroys them.
2. Correlate one failure across CLI, supervisor, worker, catalog, update coordinator, and kernel process boundaries.
3. Start coverage early enough to include dynamic-import and detached-supervisor failures.
4. Avoid secret leakage and avoid changing crash/shutdown semantics.
5. Keep disk use bounded and the implementation dependency-light.

## 1.2 Constraints

- Node `exit` handlers can only perform synchronous work; fatal evidence must use synchronous file writes.
- `SIGKILL`, power loss, and some native failures cannot run JavaScript cleanup.
- Detached supervisors and coordinators often have ignored stdio; stderr alone is not evidence.
- Multiple processes run concurrently, so each process must own a unique JSONL file; no crash evidence may depend on racing a shared rotate/rename sequence.
- Bun-compiled releases may not expose all `process.report` features; diagnostic reports must be feature-detected.
- Existing worker/session restart protocol and compatibility maps must remain unchanged.

## 1.3 Architectural principles (rules we will enforce)

- `core/process-lifecycle.ts` owns lifecycle schema, correlation, privacy reduction, report writing, and fatal handlers.
- Existing supervisors own domain-specific restart decisions and emit facts into the shared recorder.
- The dying process records what it knows; the parent records what only the parent can observe.
- The logger records stable identifiers and privacy-projected diagnostics, not arbitrary runtime objects or opaque text.
- New child processes inherit only explicit lineage/launch metadata, never an environment dump in the event.
- Per-process JSONL files are the operational source; crash-report files are deep evidence referenced by fatal events. Parent/child instance IDs join the files without a shared rotating writer.

## 1.4 Known tradeoffs (explicit)

- Synchronous fatal writes can add milliseconds during a crash; correctness of evidence is more important than crash-path latency.
- A 60-second unref'ed heartbeat adds bounded per-process log volume but makes uncatchable exits and memory growth diagnosable.
- Native failures cannot receive a custom allowlisted report. Automatic Node reports are enabled only for daemon-worker, catalog, and update-coordinator roles whose argv cannot contain a user prompt; supervisor, client, and owned-worker native failures use parent/owner-observed exits and heartbeats as the privacy-safe boundary.
- Parent and child may both report one failure from different viewpoints. Correlation IDs make this useful, not duplication to suppress.
- Async forked-kernel shutdown, kill, and dispose wait boundedly for Python wait status. `disposeSync()` cannot await the reaper and records only expected shutdown intent before host exit.

# 2) Problem Statement (existing architecture + why change)

## 2.1 Baseline before implementation

- `core/logging.ts` installs a shared `agent.jsonl` sink only after `main()` begins.
- `daemon-mode.ts` installs uncaught-exception and unhandled-rejection handlers only for daemon worker processes and writes to a per-socket daemon log.
- `daemon-supervisor.ts` captures worker stderr and performs worker recovery, but has no general fatal handler and logs only selected recovery summaries.
- `daemon-launch.ts` reads fresh daemon-log tails for startup failures.
- `KernelManager` keeps a kernel stderr string and marks unexpected exits, but the evidence is volatile and can disappear after cleanup or a later restart.
- `fork-server.ts` keeps only a 4 KiB in-memory stderr tail.
- Update restart has a durable status file, but ordinary launches, fatal exits, and cross-process lineage do not share one event format.

## 2.2 What was broken / missing before implementation (concrete)

- A crash while importing `cli-main.ts` or before `installFileLogSink()` leaves no persistent client record.
- A detached supervisor fatal after startup can disappear because its stdio is ignored and it lacks fatal handlers.
- Unhandled rejections are not covered consistently across roles.
- Worker recovery lacks per-attempt start/result facts and old/new PID correlation.
- Kernel and fork-server exit code, signal, role, and stderr evidence are not persisted.
- Clean exits, signals, starts, and restarts cannot be reconstructed from one timeline.
- An uncatchable child death needs a parent record; not every existing spawn/close boundary records one durably.

## 2.3 Constraints implied by the problem

- Coverage must begin from `cli.ts`, before heavy dynamic imports.
- The recorder cannot depend on the main logging sink it is meant to diagnose.
- Restart instrumentation must sit in existing process owners rather than infer intent later from PID gaps.
- Crash detail must be bounded and privacy-reduced by construction.

# 3) Research Grounding (external + internal “ground truth”)

<!-- arch_skill:block:research_grounding:start -->
## 3.1 External anchors (papers, systems, prior art)

- Node.js Process API (`uncaughtExceptionMonitor`, `unhandledRejection`, `beforeExit`, `exit`, signal events) — adopt `uncaughtExceptionMonitor` for observation without replacing the default uncaught-exception exit; explicitly terminate after recording an unhandled rejection because adding a listener otherwise changes Node's fatal default. URL: https://nodejs.org/api/process.html
- Node.js Diagnostic Report API — adopt feature-detected `process.report.getReport()` snapshots for catchable JavaScript fatal evidence, then persist only an allowlisted runtime/resource projection. Enable automatic fatal reports only for prompt-free daemon-worker, catalog, and update-coordinator roles, with environment exclusion; never enable signal-triggered reports. URL: https://nodejs.org/api/report.html
- Node.js Child Process API — adopt both child `error` and `close`/`exit` observations because spawn failure and post-spawn termination are distinct facts. URL: https://nodejs.org/api/child_process.html
- Installed `node_modules/@types/node/process.d.ts` — confirms the shipped Node contract includes `reportOnFatalError`, `reportOnUncaughtException`, `excludeEnv`, and `writeReport/getReport`. Live Serper fetch was unavailable; no unverified external behavior is required by the design.

## 3.2 Internal ground truth (code as spec)

- Authoritative behavior anchors:
  - `packages/coding-agent/src/cli.ts` — first supported-Node entrypoint and earliest safe installation point.
  - `packages/coding-agent/src/cli-main.ts` — owns heavy dynamic imports and top-level CLI execution.
  - `packages/coding-agent/src/config.ts` — canonical agent/log directory helpers and bounded append primitive.
  - `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts` — canonical daemon-worker launch, close, recovery, stop, and supervisor relaunch owner.
  - `packages/coding-agent/src/core/kernel/index.ts` — canonical IPython process start, exit, shutdown, kill, and restart owner.
- Canonical owner path to add: `packages/coding-agent/src/core/process-lifecycle.ts` — lifecycle schema, early fatal handlers, report redaction, correlation, heartbeat, and JSONL append.
- Adjacent same-contract surfaces included in the initial closure:
  - `daemon-launch.ts`, `daemon-command.ts`, `daemon-update-restart.ts`, `owned-session-worker.ts`, `daemon-catalog-process.ts`, `daemon-mode.ts`, and `daemon-supervisor.ts` because each launches or relaunches a Prime Agent process.
  - `kernel/index.ts` and `kernel/fork-server.ts` because they own the non-Node process deaths/restarts that currently lose evidence.
  - `logging.ts`, `development.md`, and `CHANGELOG.md` because they own log context/discovery and current user/developer truth.
- Compatibility posture: preserve all public CLI, daemon wire, session, shutdown, and retry contracts. New files/events are local diagnostics only.
- Existing patterns to reuse:
  - `appendRotatingLog()` for sync, best-effort bounded writes.
  - Per-socket daemon logs for human-readable local context.
  - Worker descriptors/recovery journal for recovery truth; lifecycle events reference but do not replace them.
  - Real-process Vitest fixtures using isolated `ENV_AGENT_DIR` and `tsx`.
- Duplicate/drifting paths:
  - Daemon-worker-only fatal handlers are a partial owner. The early recorder becomes universal; daemon-local handlers may retain contextual human-readable output but cannot be the only durable record.
  - Kernel/fork-server in-memory stderr tails are volatile. They remain useful for immediate errors; lifecycle events durably retain only bounded byte/line summaries so Python/user text is not copied.
- Behavior-preservation signals:
  - Existing daemon launch, supervisor monitor/process, owned-worker, update-restart, kernel startup/shutdown, and fork-server tests.
  - Root formatting/lint/type checks via `npm run check`.

## 3.3 Decision gaps that must be resolved before implementation

None. The user explicitly authorized the outcome and direct local implementation. The repo establishes the existing retry semantics, log directory, and process owners. The plan preserves those contracts.
<!-- arch_skill:block:research_grounding:end -->

# 4) Baseline Architecture (before implementation)

<!-- arch_skill:block:current_architecture:start -->
## 4.1 On-disk structure

- `logs/agent.jsonl`: shared structured provider/agent sink installed from `main()`.
- `logs/client-errors.log`: selected daemon-launch/open failures.
- `logs/<socket>.<hash>.log`: daemon/supervisor human-readable diagnostics and worker stderr.
- Update-restart status/manifests and worker descriptors/journals: durable recovery state, not a universal lifecycle log.
- No per-process lifecycle directory and no crash-report directory.

## 4.2 Control paths (runtime)

1. `cli.ts` checks Node, imports `cli-main.ts`, then awaits `runCli()` with no persistent early fatal boundary.
2. Client startup can detach a daemon supervisor through `daemon-launch.ts`.
3. The supervisor launches catalog and per-root daemon workers; workers can launch a replacement supervisor; update and explicit restart paths can replace the supervisor.
4. Session runtimes launch IPython directly or through a Python fork server.
5. Worker, client, and kernel signals/shutdown are handled by separate owners with different evidence behavior.

## 4.3 Object model + key abstractions

- `DaemonSupervisor` owns `ResidentWorker` descriptors and recovery retries.
- `AgentDaemon` owns sessions inside one worker process.
- `DaemonCatalogClient` owns its IPC helper process.
- `KernelManager` owns direct or forked kernel PIDs and volatile stderr.
- `ForkServer` owns the warm Python template and its volatile stderr.
- `appendRotatingLog()` is the only dependency-light sync persistence primitive suitable for fatal paths.

## 4.4 Observability + failure behavior today

- Handled daemon errors are usually logged, but coverage and formats differ by role.
- Early CLI and detached supervisor fatals can vanish.
- A worker stderr line can reach the daemon log, but worker process exit/restart attempts are not a complete correlated timeline.
- Kernel/fork-server failures can be surfaced to one caller yet leave no durable evidence after cleanup.
- Signals and normal exits are not universally indexed.

## 4.5 UI surfaces (ASCII mockups, if UI work)

No UI change.
<!-- arch_skill:block:current_architecture:end -->

# 5) Target Architecture (to-be)

<!-- arch_skill:block:target_architecture:start -->
## 5.1 On-disk structure (future)

```text
~/.prime/agent/logs/
├── processes/                    # one bounded JSONL file per process instance
│   └── <processInstanceId>.jsonl
├── crash-reports/                # bounded Node diagnostic reports
│   └── crash-<time>-<pid>-<instance>.json
├── agent.jsonl                   # existing agent/provider structured log
├── client-errors.log             # existing client launch failures
└── <socket>.<hash>.log           # existing daemon/supervisor readable log
```

## 5.2 Control paths (future)

1. `cli.ts` dynamically imports the dependency-light lifecycle module, installs it, then imports `cli-main.ts`.
2. Installation writes `process_start`, configures redacted reports, and registers fatal/signal/exit handlers plus an unref'ed heartbeat.
3. Every Prime-owned child launch receives explicit parent instance and launch-trigger metadata.
4. Existing owners emit domain events: worker launch/close/recovery, supervisor relaunch, catalog exit, update coordinator exit, kernel/fork-server start/exit/restart.
5. Fatal events synchronously append JSONL and reference a deeper crash report. Default/established termination still occurs.
6. A parent-observed child event closes the evidence gap when the child cannot write its own final event.

## 5.3 Object model + abstractions (future)

- `ProcessLifecycleEvent`: timestamp, event name, process instance ID, pid/ppid, role, version, uptime, context, resource snapshot, and bounded event-specific fields.
- `ProcessLifecycleContext`: mutable late-bound mode/socket/session/worker correlation fields; no arbitrary secrets.
- `ProcessLaunchContext`: parent process instance ID, trigger, and bounded identifiers encoded into internal environment variables and removed after child startup.
- `LifecycleError`: normalized name/message/stack/code/cause/aggregate data with depth and size caps.
- `CrashReportWriter`: feature-detected Node report snapshot, privacy reduction, atomic file write, retention pruning.

## 5.4 Invariants and boundaries

- Canonical owner: `core/process-lifecycle.ts`.
- Compatibility: additive local diagnostics; public and daemon contracts are unchanged.
- Each process JSONL file is size-bounded and single-writer. Stale process files and crash reports are pruned by age/count with best-effort, idempotent cleanup; failures are swallowed.
- Event details are normalized and capped before stringify.
- Full argv/environment are never copied into lifecycle events. JavaScript crash reports remove them.
- Existing per-daemon logs remain; they are not replaced or parsed as lifecycle truth.
- No new fallback or retry behavior.

## 5.5 UI surfaces (ASCII mockups, if UI work)

No UI change. Developer docs list the exact paths.
<!-- arch_skill:block:target_architecture:end -->

# 6) Call-Site Audit (exhaustive change inventory)

<!-- arch_skill:block:call_site_audit:start -->
## 6.1 Change map (table)

| Area | File | Symbol / Call site | Current behavior | Required change | Why | New API / contract | Tests impacted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Log paths | `src/config.ts` | log helpers | No lifecycle/report path | Add per-process lifecycle directory/file and crash-report directory helpers | One discoverable canonical location | Local path helpers | `config.test.ts` if needed |
| Lifecycle SSOT | `src/core/process-lifecycle.ts` | new | Missing | Add schema, sync writer, privacy caps, reports, handlers, context, lineage, heartbeat | Universal evidence owner | Internal TypeScript API | New process lifecycle test |
| Earliest Node entry | `src/cli.ts` | supported branch | Imports `cli-main` directly | Install recorder before heavy import; record completion/rejection | Close early-start blind spot | No CLI change | New real-process test, stdout cleanliness |
| Earliest Bun entry | `src/bun/cli.ts` | top-level imports | Loads Bedrock registration before `cli.ts` | Install recorder before Bedrock/CLI dynamic imports | Cover compiled/runtime Bun startup | No CLI change | Compile/type check |
| Shared context | `src/core/logging.ts` | `setLogContext` | Context only reaches `agent.jsonl` | Also merge safe fields into lifecycle context | Correlate mode changes | Internal call only | Lifecycle unit/process test |
| Cold daemon | `src/cli/daemon-launch.ts` | detached spawn | Fresh daemon-log tail only | Carry launch lineage and record spawn/startup failure/success | Reconstruct daemon birth | Lifecycle event calls | `daemon-launch.test.ts` |
| Explicit daemon start | `src/cli/daemon-command.ts` | `runStart` | Detached spawn without lineage | Add explicit launch trigger and parent observation | Cover manual starts | Lifecycle event calls | Existing daemon command tests/check |
| Update coordinator | `src/cli/daemon-update-restart.ts` | coordinator spawn | Status file only | Carry lineage; record spawn/exit/terminal phase | Cover restart controller crash | Lifecycle event calls | `4606-update-restart-coordinator.test.ts` |
| Owned worker | `src/cli/owned-session-worker.ts` | `spawnWorker`/recovery loop | Exit affects frontend but no durable timeline | Record launch/close/recovery and carry lineage | Cover isolated RPC restarts | Lifecycle event calls | `owned-session-worker*.test.ts` |
| Catalog | `src/modes/daemon/daemon-catalog-process.ts` | `spawnCatalog`/`handleClose` | Parent gets Error only | Carry lineage and record start/close/restart | Cover catalog helper death | Lifecycle event calls | Catalog tests/check |
| Worker daemon | `src/modes/daemon/daemon-mode.ts` | constructor/start/replacement supervisor/fatal handlers | Contextual daemon log; partial fatal owner | Set lifecycle context; record replacement supervisor launch/result; preserve contextual fatal output | Correlate worker and self-heal | Lifecycle event calls | Supervisor monitor/process tests |
| Supervisor | `src/modes/daemon/daemon-supervisor.ts` | start/launchWorker/handleWorkerClose/recoverWorker/shutdown relaunch | Selected readable logs only | Set context; record worker launch/close/attempt/result and supervisor relaunch | Main restart owner | Lifecycle event calls | Supervisor monitor/process tests |
| Kernel | `src/core/kernel/index.ts` | start/exit/forked liveness/shutdown/restart/kill | Volatile stderr only | Record process lifecycle, bounded stderr, explicit restart result | Persist Python failure evidence | Lifecycle event calls | `kernel-startup.test.ts`, kernel shutdown tests |
| Fork server | `src/core/kernel/fork-server.ts` | start/process exit/markDead/dispose | Volatile 4 KiB stderr | Record template start/ready/exit/death with tail | Persist warm-template failures | Lifecycle event calls | `kernel-fork-server.test.ts` |
| Diagnostic discovery | `src/modes/agent-connection/daemon-agent-connection.ts` and `docs/development.md` | diagnostic context/debugging | Points to daemon or agent log only | Include lifecycle/crash-report locations where concise | Make evidence findable | Text only | Existing connection tests/check |
| Tests | `test/process-lifecycle-process.test.ts`, fixture, `test/kernel-startup.test.ts` | new/extended | Gaps listed above | Add fatal/rejection/signal/exit/report/kernel persistence proof | Prevent regression | Test-only | Run directly |
| Changelog | `packages/coding-agent/CHANGELOG.md` | Unreleased | No entry | Add one user-visible bullet | Release truth | Documentation | Read full Unreleased first |

## 6.2 Migration notes

- Canonical owner path: `src/core/process-lifecycle.ts`.
- Deprecated APIs: none.
- Delete list: no public deletion. Remove only redundant fatal-only logic if the shared handler makes it a competing owner; preserve daemon-readable contextual logging.
- Adjacent surfaces: every Prime-owned process launch/relaunch listed above is included; arbitrary shell, provider, auth, package-manager, tmux, clipboard, and `gh` children are excluded.
- Compatibility posture: preserve existing behavior; no daemon schema/version/capability change.
- Live docs/comments: update `docs/development.md` and any touched fatal-handler comments that would otherwise claim daemon-only coverage.
- Behavior-preservation signals: existing targeted daemon, worker, update, owned-worker, and kernel tests plus root check.

## Pattern Consolidation Sweep (anti-blinders; scoped by plan)

| Area | File / Symbol | Pattern to adopt | Why (drift prevented) | Proposed scope |
| --- | --- | --- | --- | --- |
| Prime Node children | Listed Prime-owned spawn sites | Parent instance + launch trigger | Start/restart timeline stays correlated | include |
| Python process owners | Kernel and fork server | Parent-observed start/exit with stderr tail | Non-Node crash evidence persists | include |
| Arbitrary subprocesses | bash/auth/provider/package tools | Generic child logging | Would expose command data and expand beyond Prime restarts | exclude |
| Automatic dead-kernel replacement | `IpythonKernelProvisioner` | New recovery policy | Behavior change, not observability | exclude |
<!-- arch_skill:block:call_site_audit:end -->

# 7) Depth-First Phased Implementation Plan (authoritative)

<!-- arch_skill:block:phase_plan:start -->
> Rule: depth-first implementation protects the approved destination while proving the path early. The destination map is the human-authorized outcome plus the initial minimal convergence closure recorded before implementation and any later explicit human approval. The expansion map only sequences that approved breadth; workers and reviewers cannot add callers, variants, modes, guarantees, proof categories, or adjacent cleanup. Section 7 chooses the first working slice through the canonical owner path and highest-risk seam, then advances through already-authorized axes. Phase boundaries are proof gates, and phase count follows real dependency, proof, reversibility, migration, or user-review boundaries. `Work` is explanatory; `Checklist (must all be done)` and `Exit criteria (all required)` hold every required obligation. Refactors and consolidations preserve behavior with proportionate evidence. Prefer prompt, grounding, and native capability before new agent tooling. No fallback or runtime shim exists without explicit approval and removal work. Prefer focused programmatic checks, defer manual/UI verification to finalization, and avoid deletion proofs, visual constants, doc gates, keyword/absence gates, and repo-shape policing.

## Phase 1 — Prove the early fatal evidence seam

- **Goal:** A failure before the heavy CLI graph loads leaves durable, privacy-reduced evidence without changing normal crash semantics.
- **Work:** Add the lifecycle SSOT, log/report paths, early installation, and real-process proof.
- **Checklist (must all be done):**
  - [x] Add single-writer per-process JSONL event normalization, safe error serialization, process/resource context, and best-effort sync persistence.
  - [x] Add process instance/parent/launch correlation and late-bound context.
  - [x] Add uncaught exception, unhandled rejection, signal, before-exit, exit, completion/rejection, and heartbeat recording.
  - [x] Add privacy-reduced JavaScript diagnostic reports with retention; enable automatic native-fatal reports only for prompt-free daemon-worker, catalog, and update-coordinator roles.
  - [x] Install before importing `cli-main.ts`; install in the Bun entry before Bedrock/CLI dynamic imports; preserve the Node version guard.
  - [x] Add a real-process fixture/test for throw, rejection, signal, clean exit, parseable JSONL, and report redaction.
- **Verification (required proof):** Run the new process-lifecycle test and `stdout-cleanliness.test.ts`.
- **Docs/comments (propagation; only if needed):** Comment only the fatal-semantics and privacy boundaries.
- **Exit criteria (all required):**
  - [x] Early fatal and rejection fixtures exit nonzero, persist projected frame locations, and omit raw sentinel text.
  - [x] Signal behavior remains terminal and leaves a signal record.
  - [x] Every per-process lifecycle line parses, no two process instances share a file, and JavaScript reports omit env/argv data.
  - [x] Normal CLI help/stdout remains unchanged.
- **Rollback:** Remove the early installer and new module/path helpers; no data migration or wire rollback is needed.

## Phase 2 — Cover every Prime-owned restart boundary

- **Goal:** Parent and child facts reconstruct daemon, worker, catalog, coordinator, owned-worker, kernel, and fork-server restarts.
- **Work:** Thread the lifecycle event/lineage API through existing owners without changing their decisions.
- **Checklist (must all be done):**
  - [x] Instrument cold/manual daemon and update-coordinator launches.
  - [x] Instrument supervisor context, worker launch/close/recovery attempts/results, and supervisor relaunch.
  - [x] Instrument worker-daemon replacement-supervisor launch and retain contextual daemon logging.
  - [x] Instrument catalog and owned-worker child launch/close/recovery.
  - [x] Instrument direct/forked kernel start/ready/exit/start-failure/shutdown/restart/kill with privacy-projected stderr summaries.
  - [x] Instrument fork-server start/ready/exit/death/dispose with privacy-projected shared-stderr summaries.
  - [x] Carry only explicit nonsecret launch identifiers through child environments.
- **Verification (required proof):** Run the extended kernel-startup test and existing daemon-launch, daemon-supervisor-monitor, owned-session-worker, update-restart coordinator, and fork-server tests that cover touched behavior.
- **Docs/comments (propagation; only if needed):** Update comments that currently describe daemon-local or volatile diagnostics as the only evidence.
- **Exit criteria (all required):**
  - [x] Every in-scope launch/relaunch owner emits a launch trigger or parent-observed event.
  - [x] Every in-scope child exit owner records exit/spawn failure and correlation identifiers.
  - [x] Worker recovery records each attempt and terminal result without changing retry count or timing.
  - [x] Kernel exit code and privacy-projected stderr size persist after manager cleanup; raw sentinel text does not.
  - [x] Existing daemon/session/kernel behavior tests remain green.
- **Rollback:** Remove event calls and lineage metadata; existing recovery behavior remains intact.

## Phase 3 — Make diagnostics discoverable and validate the whole change

- **Goal:** Developers know exactly where evidence lives and the final diff is type-safe, formatted, and internally consistent.
- **Work:** Update developer docs/changelog, reconcile plan/worklog truth, run focused proof and repository checks, then audit implementation against this plan.
- **Checklist (must all be done):**
  - [x] Document lifecycle JSONL, crash reports, existing daemon logs, privacy posture, and the SIGKILL limitation.
  - [x] Add one non-duplicative Unreleased changelog bullet while preserving pre-existing worktree edits.
  - [x] Run every created/modified test file.
  - [x] Run focused existing tests for touched process owners.
  - [x] Run root `npm run check` and fix all reported errors, warnings, and infos.
  - [x] Audit the final diff against Sections 0, 5, 6, 7, and 8.
- **Verification (required proof):** Captured command results in the worklog and a clean implementation-audit block.
- **Docs/comments (propagation; only if needed):** `packages/coding-agent/docs/development.md` and `packages/coding-agent/CHANGELOG.md`.
- **Exit criteria (all required):**
  - [x] Documentation names exact paths and limits.
  - [x] All modified tests pass.
  - [x] `npm run check` passes cleanly.
  - [x] Audit finds no missing in-scope launch/fatal/kernel boundary and no behavior change.
- **Rollback:** Documentation and changelog revert with instrumentation; no protocol or stored-state migration exists.
<!-- arch_skill:block:phase_plan:end -->

# 8) Verification Strategy (common-sense; evidence planning)

## 8.1 Unit tests (contracts)

- Error/cause normalization is bounded, JSON-safe, and omits opaque messages while retaining validated frame locations.
- Role/launch-context inference never serializes full argv or environment.
- Crash-report privacy reduction uses an explicit allowlist and omits environment variables, command arguments, error messages, and arbitrary text.
- Retention pruning is bounded and best-effort.
- Kernel event fields include session ID, PID, launch mode, expected/unexpected state, code/signal, and projected stderr byte/line counts.

## 8.2 Integration tests (flows)

- Real process: `process_start -> uncaught_exception -> process_exit` with projected frame locations/report and no sentinel text persisted.
- Real process: `process_start -> unhandled_rejection -> nonzero exit`.
- Real process signal: signal event followed by actual termination, not continued execution.
- Fake Python exits 42 before ports: caller error still contains stderr while lifecycle JSONL retains code 42 plus stderr size, not the raw sentinel.
- Existing daemon launch: spawn errors and early exits retain fresh daemon-tail behavior while lifecycle adds correlation.
- Existing supervisor/worker recovery tests: retry semantics and session survival remain unchanged.

## 8.3 E2E / device tests (realistic)

No device test. The realistic process proof is one isolated source CLI/fixture with `ENV_AGENT_DIR` pointed at a temp directory. Do not use real providers, API keys, or paid tokens.

Focused command set from `packages/coding-agent`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/process-lifecycle-process.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-startup.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-launch.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-supervisor-monitor.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/owned-session-worker.test.ts test/owned-session-worker-process.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-fork-server.test.ts
```

Run relevant update-coordinator coverage if that file changes, then from repo root:

```bash
npm run check
```

## 8.4 Fault-injection matrix

| Boundary | Injection | Required durable evidence | Automated proof |
| --- | --- | --- | --- |
| Early application import | Dynamically import a missing module after lifecycle installation | `process_start`, `uncaught_exception`, report path, nonzero `process_exit` | `process-lifecycle-process.test.ts` |
| JavaScript fatal | Throw a sentinel error on the next turn | Projected frame locations, resources, report, process identity, exit; no raw sentinel | `process-lifecycle-process.test.ts` |
| Default unhandled rejection | Reject with a sentinel under Node default mode | `unhandled_rejection`, correlated uncaught/exit, nonzero result | `process-lifecycle-process.test.ts` |
| Explicit nonfatal rejection mode | Run with `--unhandled-rejections=warn` | Rejection evidence without converting the process to fatal | `process-lifecycle-process.test.ts` |
| Signal before a role owner loads | Send `SIGTERM` to the lifecycle fixture | Signal record and native terminal result | `process-lifecycle-process.test.ts` |
| Signal after a role owner loads | Add a later owner that exits 77, then send `SIGTERM` | Signal record and unchanged owner-selected code 77 | `process-lifecycle-process.test.ts` |
| Clean process | Return after marking completion | Start, completion, before-exit/exit, parseable single-writer file | `process-lifecycle-process.test.ts` |
| Privacy | Put secrets, prompt text, provider payloads, argv, and opaque error/cause text into fixtures | No raw fixture text in lifecycle JSONL or catchable diagnostic report | `process-lifecycle-process.test.ts` |
| Cold daemon spawn | Missing cwd / spawn error | Parent launch ID, spawn error, launch result, existing client error | `daemon-launch.test.ts` plus lifecycle code review |
| Cold daemon early exit | Child exits before socket readiness | Parent-observed code/signal and fresh daemon-log attribution | `daemon-launch.test.ts` plus lifecycle code review |
| Manual daemon start | Explicit detached start | Launch lineage, ready/timeout, parent-observed early exit | `daemon-command.test.ts` plus lifecycle code review |
| Native detached worker/catalog/coordinator failure | Node fatal/native report in a prompt-free internal role | `native-crash-<processInstanceId>.json`, env excluded, last heartbeat/parent close | Structural configuration; destructive OOM injection is not a routine test |
| Supervisor replacement | Restart or worker-led replacement supervisor | Attempt, new child ID/PID, ready/spawned/failed result | Focused `daemon-supervisor-process.test.ts` replacement cases |
| Worker spawn failure | Invalid/missing worker launch | Spawn error, failed launch result, unchanged supervisor behavior | Focused `daemon-supervisor-process.test.ts` spawn-error case |
| Worker unexpected death | Kill resident worker, then let supervisor recover | Child close, scheduled attempts, attempt outcomes, old worker identity, new launch identity | Focused supervisor process/adoption cases and monitor tests |
| Owned RPC worker death | Kill/reject isolated worker while frontend remains | Close plus each retry delay/attempt/result | `owned-session-worker-process.test.ts` |
| Catalog death and lazy recovery | Kill catalog child, issue next request | Exit/close, recovery attempt, replacement launch, ready result | `daemon-catalog-lifecycle-process.test.ts` |
| Update coordinator spawn failure | Invalid coordinator cwd | Spawn error and result without killing updater | `4606-update-restart-coordinator.test.ts` |
| Update coordinator outlives updater | Real custom-socket update restart | Coordinator lineage, phase/result, exact successor socket | `4606-update-restart-coordinator.test.ts` with worker-role env removed in nested Prime sessions |
| Direct IPython startup death | Fake Python writes sentinel stderr and exits 42 | Direct launch ID/PID, unexpected exit 42, projected stderr size, start failure; raw stderr only in the caller error | `kernel-startup.test.ts` |
| Fork-server/forked-kernel death | Missing interpreter or reaped forked child on Linux | Server start/error/exit/death, replacement lineage, per-kernel code/signal status, shared-stderr scope, direct fallback | `kernel-fork-server.test.ts` on Linux plus lifecycle code review |
| Kernel restart/kill/shutdown | Existing manager calls | Request/result phase, expected intent, exit observation when available | Existing kernel shutdown/startup tests plus lifecycle code review |
| `SIGKILL`/host loss | Kill a child without cleanup | Last heartbeat and parent-observed close; no false in-process final cause | Real supervisor/owned-worker process cases |
| Log write failure | Unwritable lifecycle directory | Fatal stderr fallback names intended lifecycle path; process still terminates | Structural review; filesystem failure is separately acceptable residual evidence loss |

# 9) Rollout / Ops / Telemetry

## 9.1 Rollout plan

- Additive local rollout. No migration and no feature flag.
- Existing logs remain in place. New lifecycle events begin on the next process start.
- Old crash reports are pruned only inside the new crash-report directory.

## 9.2 Telemetry changes

- No remote telemetry or uploads.
- Local-only `logs/processes/<processInstanceId>.jsonl` and `logs/crash-reports/` are the new operational evidence.
- Each single-writer process JSONL is size-rotated. Stale process files and crash reports are bounded by retention. Heartbeats are unref'ed and periodic.

## 9.3 Operational runbook

1. Start with `~/.prime/agent/logs/processes/` and use `rg`/JSON tooling to filter all `*.jsonl` files by `processInstanceId`, `pid`, `parentProcessInstanceId`, `role`, `workerId`, `activeSessionId`, or socket.
2. For a fatal event, open its `reportPath`; for daemon context, also inspect the referenced per-socket log.
3. For a missing final event, find the latest heartbeat and the parent-observed child close/disconnect. An unmatched start with no parent close means `SIGKILL`, host loss, or a native failure outside JavaScript evidence.
4. Correlate worker replacement by old/new PID and launch trigger; correlate kernel replacement by session ID and kernel instance.

# 10) Decision Log (append-only)

## 2026-08-20 - User-authorized direct implementation on main

- **Context:** The normal repository workflow prefers feature branches, while the user explicitly requested implementation directly in the existing directory on `main`.
- **Options:** Create a branch; stop for confirmation; honor the explicit direct-main request.
- **Decision:** Honor the explicit request and modify the existing `main` worktree without committing or overwriting unrelated changes.
- **Consequences:** Track touched files precisely. Preserve the pre-existing kernel-bootstrap and changelog edits. Do not use stash/reset/checkout/clean.
- **Follow-ups:** Report pre-existing changes separately in the final summary.

## 2026-08-20 - Initial convergence closure (planning-derived): universal lifecycle ownership

- **Changed contract:** Prime Agent crash/restart evidence becomes durable and correlated across process roles.
- **Competing live paths:** Daemon-worker fatal handlers, per-socket readable logs, update status, and volatile kernel/fork-server tails each own only part of the evidence.
- **Minimal closure:** Add one early lifecycle SSOT; emit domain facts from every existing Prime-owned process owner; retain specialized logs/journals as supporting evidence rather than parallel lifecycle schemas.
- **Why narrower is split-brained:** Instrumenting only the supervisor still misses early clients and kernels; instrumenting only the dying process still misses `SIGKILL`; instrumenting only child exits cannot explain restart intent.
- **Sign-off effect:** Sections 0, 5, 6, and 7 include the exact Prime-owned launch/restart surfaces before implementation.

## 2026-08-20 - Limit automatic native-fatal reports to safe internal roles

- **Context:** Node automatic fatal reports can capture out-of-memory/native failures but include the process command line. Supervisor, client, and owned-worker argv can contain API keys or user prompts.
- **Options:** Disable automatic reports everywhere; enable everywhere with environment exclusion; enable only internal daemon roles with prompt-free argv.
- **Decision:** Enable `reportOnFatalError` only for daemon worker, daemon catalog, and update-restart coordinator roles. Supervisor argv can contain API keys or system prompts, so it uses heartbeat and child/owner observations instead. Exclude environment variables and leave signal/uncaught automatic reports disabled because the shared recorder owns those catchable paths.
- **Consequences:** Long-lived detached native failures gain reports without copying prompt-bearing argv. Supervisor and client native failures remain diagnosable from heartbeats and parent/owner observations.

## 2026-08-20 - Use single-writer per-process lifecycle files

- **Context:** Existing shared rotating logs use unsynchronized `stat/rm/rename/append` across supervisor, workers, and clients. A crash recorder cannot rely on that race-prone rotation path.
- **Options:** One shared lifecycle JSONL; per-process files plus correlation IDs; a new database/locking service.
- **Decision:** Write `logs/processes/<processInstanceId>.jsonl`, preallocate child instance IDs at launch, and join files with parent/child IDs. Keep the existing shared agent/daemon logs as supporting evidence.
- **Consequences:** Crash evidence has one writer and safe local rotation. Investigation scans a directory rather than one file. Stale files are pruned best-effort without touching recently heartbeating files.
- **Follow-ups:** The developer runbook gives the exact `rg`/JSON workflow.

## 2026-08-20 - Intent-derived: preserve restart behavior

- **Blocker:** Whether to also add automatic dead-kernel recreation and change worker recovery policy.
- **Consulted:** Section 0, TL;DR, and Phase 2.
- **Intent says:** The requested outcome is enough information to debug crashes and restarts, not new recovery behavior.
- **Decision:** Instrument existing recovery paths only. Automatic kernel replacement and retry-policy changes remain out of scope.
- **Consequences:** Lower behavior risk and focused tests; any recovery-policy change requires separate human authorization.


## 2026-08-20 - Project opaque diagnostics at the persistence boundary

- **Context:** Error messages and Python stderr can contain prompts, provider payloads, code, or other opaque user text. Token-pattern replacement cannot prove their absence.
- **Options:** Persist bounded raw tails; apply heuristic token redaction; persist only structural summaries and validated frame locations.
- **Decision:** Lifecycle JSONL stores byte/line counts for opaque messages/stderr and validated project/dependency/`node:` frame locations. Catchable JavaScript reports use an explicit runtime/resource allowlist. Raw Python stderr remains only in the existing in-memory caller error.
- **Consequences:** Durable evidence retains timing, identity, status, resource, location, and text-size facts without copying opaque user data. Investigators use the immediate caller error or existing specialized logs when raw local text is required.

## 2026-08-20 - Keep Node lifecycle identity out of Python environments

- **Context:** A Node parent already carries lifecycle environment variables, so merely avoiding a new launch helper still leaks Node identity into direct kernels, the Python fork server, and forked descendants.
- **Decision:** Strip all lifecycle identity/trigger/context variables after merging the Python child environment. Preallocate logical child IDs in the Node owner instead.
- **Consequences:** Node lineage remains joinable without a Python descendant reusing a Node process identity.

## 2026-08-20 - Report forked-kernel wait status through the fork server

- **Context:** A forked kernel is not a Node child, and PID polling only proves absence; it cannot distinguish exit code from signal.
- **Decision:** Each fork request supplies a private status path. The Python parent blocks `SIGCHLD` across fork registration, reaps the child, and atomically writes PID/code/signal. The Node owner reads it before temporary-directory cleanup.
- **Consequences:** Linux forked-kernel events gain exact wait status when available. A missing status file degrades to the existing PID-missing observation without changing fallback or restart behavior.


# 11) Implementation Audit

## 11.1 Verdict

**APPROVED — 2026-08-20.** A clean read-only reviewer found four blockers in the first final pass. All four were repaired and the same reviewer approved the bounded recheck with no remaining blocker.

## 11.2 Closed blockers

1. Disabled raw automatic native reports for daemon supervisors because manual-start argv can contain API keys or system prompts. Prompt-free daemon-worker, catalog, and update-coordinator roles remain eligible.
2. Unified owned RPC close classification with the recovery decision, including code-zero exits with pending commands.
3. Made async forked-kernel disposal wait boundedly for Python wait status before removing the status directory. `disposeSync()` remains explicitly best-effort.
4. Added explicit unexpected/reason classification to cold, manual, and worker-led parent observations of supervisor exits.

## 11.3 Final proof and residual limitations

- All created/modified focused process, kernel, daemon, supervisor, catalog, coordinator, and owned-worker tests passed. The process-stress worker spawn-error case also passed under its explicit tag.
- Final `npm run check` passed with no Biome fixes, type failures, installer failures, or browser-smoke failures.
- A real Linux forked-kernel exit-status round trip is structurally implemented but not executable on the macOS development host; Linux fork-server tests validate gating/fallback and the embedded status protocol's syntax/markers.
- Synchronous host-exit cleanup cannot await the Python reaper. Uncatchable `SIGKILL`, host loss, and some native failures still rely on heartbeat plus parent/owner observations as stated in Section 0.
- No daemon wire shape, capability, retry count, adoption rule, or automatic kernel-recovery policy changed.
