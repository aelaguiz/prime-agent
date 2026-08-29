---
title: Add a TUI hotkey that stops and archives the current Prime Agent
date: 2026-08-28
status: active
owners:
  - aelaguiz
reviewers:
  - Prime Agent self-audit
fallback_policy: Keep the TUI attached and show a visible error if the existing stop/archive request is not acknowledged.
related:
  - packages/coding-agent/src/core/keybindings.ts
  - packages/coding-agent/src/modes/interactive/interactive-mode.ts
  - packages/coding-agent/src/modes/agent-connection/types.ts
  - packages/coding-agent/docs/long-running-agents.md
---

# TL;DR

Add configurable `Ctrl+X` behavior inside the active chat TUI. With an empty editor, one press asks the current connection to stop and archive the agent, waits for acknowledgement, and then exits the TUI. `Ctrl+D` remains the detach-and-exit workflow that leaves a resident agent running. The implementation reuses the existing daemon `kill` command and process-local session lifecycle; it does not change daemon code, daemon protocol, or service behavior.

# North Star

**Claim:** A user who is finished with the agent can press `Ctrl+X` from its chat TUI and leave no resident worker behind, while preserving the transcript as archived state.

**In scope**

- A canonical, configurable `app.session.stop` action with default `Ctrl+X`.
- Active-chat TUI handling, expected-close suppression, and failure-visible behavior.
- Connection-adapter implementations that reuse existing lifecycle primitives.
- In-product and written documentation that clearly distinguishes `Ctrl+X` from `Ctrl+D`.
- Focused regressions, full repository validation, branch publication, merge into the fork's local/remote `main`, and verification of the source-linked installation.

**Out of scope**

- New daemon commands, capabilities, events, response fields, or supervisor behavior.
- Changing `Ctrl+D`, shell EOF semantics, terminal drivers, or process signal handling.
- Deleting transcripts or session artifacts.
- Stopping all agents or the daemon.
- Redesigning Agents View lifecycle controls.

**Definition of done**

1. `Ctrl+X` in an active chat with an empty editor stops and archives that current agent, then exits only after the lifecycle request succeeds.
2. A draft prompt blocks the action with a visible instruction so unsent input is not lost.
3. Resident daemon sessions reuse the existing `kill` command; client-owned no-session workers reuse `complete_owned_session`; process-local persisted sessions record `archived` before disposal.
4. The shortcut is configurable, appears in TUI help and lifecycle documentation, and extensions cannot intercept its effective binding.
5. Focused tests and the repository-mandated `npm run check` pass; the feature branch and merged `main` are pushed; the installed `prime-agent` command resolves to the merged fork and passes a smoke check.

<!-- lilarch:block:requirements -->
# Requirements

- **R1 — One-step finished workflow:** With no draft in the editor, `app.session.stop` must begin stop/archive immediately. No shell command or Agents View round trip is required.
- **R2 — Distinct exit contracts:** `app.exit` / `Ctrl+D` must continue to detach and leave a resident agent running. `app.session.stop` / `Ctrl+X` must terminate the current agent before the TUI exits.
- **R3 — Preserve unsent input:** When the editor contains any text, `Ctrl+X` must not stop the agent or discard the draft; it must tell the user to clear or stash the prompt first.
- **R4 — Acknowledged shutdown:** The TUI must wait for the connection's stop/archive operation. On failure it must stay open, clear its in-progress guard, and render the error.
- **R5 — Idempotent interaction:** Repeated `Ctrl+X` input while a stop is pending must issue at most one lifecycle request.
- **R6 — Expected closure is not an error:** The connection-closed event caused by the requested stop must not render a misleading daemon failure in the TUI.
- **R7 — Existing lifecycle primitives only:** Resident daemon sessions use `kill`; owned no-session workers use `complete_owned_session`; process-local sessions append `archived` and then follow normal disposal.
- **R8 — Configurable and reserved:** The action must live in the canonical keybinding registry, default to `Ctrl+X`, honor `keybindings.json`, and be reserved from extension shortcut override in the editor.
- **R9 — Discoverable workflow:** Quick help, `/hotkeys`, keybinding reference, and long-running-agent guidance must say `Ctrl+X` stops/archives while `Ctrl+D` only detaches.
- **R10 — No daemon changes:** The final diff must contain no file under `packages/coding-agent/src/modes/daemon/` and no daemon-protocol edit.

**Defaults**

- Binding: `Ctrl+X` in the active chat editor.
- Safety gate: editor must be exactly empty, matching the existing `Ctrl+D` empty-editor convention.
- Confirmation: none; the transcript is archived rather than deleted, and Agents View already stops a running selected agent on its first `Ctrl+X` lifecycle action.
- Success behavior: no resume hint, because the session was intentionally archived.

**Non-requirements**

- No new setting, feature flag, compatibility shim, modal, daemon restart, or telemetry event.
- No attempt to archive an in-memory `--no-session` transcript that does not exist.
- No deletion/deactivation pass after archival.

<!-- /lilarch:block:requirements -->

# Scope and Simplicity Contract

- **Human-authorized outcome and anchors:** The user explicitly requested a plan, implementation, proof, branch push, merge into `/Users/aelaguiz/workspace/prime-agent`, and installation; they explicitly constrained the fix to the TUI with no daemon change.
- **Smallest sufficient solution:** Add one canonical action, one connection method implemented by the existing adapters, one guarded TUI handler, and concise workflow documentation.
- **Initial minimal convergence closure:** Reserve the new editor-global action from extension interception and cover both connection adapters. Omitting either would make the same visible TUI control nondeterministic across supported transports.
- **Scope freeze:** Frozen before implementation to the source, test, documentation, changelog, and delivery surfaces in the call-site audit. Adjacent daemon retirement work is not part of this feature.
- **Enough proof:** Focused tests prove key resolution, draft protection, one-request behavior, error recovery, daemon command selection, process-local archival, expected help copy, and extension conflict protection; `npm run check` proves repository integration.
- **Do-not-build boundary:** No daemon/protocol change, agent-manager abstraction, generic lifecycle rewrite, confirmation framework, or broad keybinding refactor.
- **Accepted residual risk:** A terminal/process crash during the acknowledged stop can still interrupt the UI handoff; existing daemon stop tombstones/finalization remain responsible for recovery. `--no-session` workers stop but have no transcript to archive.

<!-- arch_skill:block:research_grounding -->
# Research Grounding

Repository source is sufficient; no external research is required.

- `interactive-mode.ts` currently maps `app.exit` to `shutdown()`, which disposes the client connection. For resident sessions that is a detach, not a worker stop.
- `daemon-agent-connection.ts` already owns transport-specific commands and currently sends `detach` on normal disposal or `complete_owned_session` for client-owned no-session workers.
- The existing daemon protocol already exposes `kill`. The daemon worker closes a killed session through its graceful lifecycle, archives non-empty persisted sessions, aborts active work, cancels scheduled jobs, disposes runtime resources, and acknowledges the request.
- The supervisor already treats a root `kill` as an intentional archived worker stop with durable finalization. This feature only calls that existing behavior.
- `in-process-agent-connection.ts` has direct access to the current session and its `SessionManager`, which already supports `appendSessionState({ status: "archived" })`.
- `keybindings.ts` already assigns `Ctrl+X` to context-specific actions in Agents View and the model picker, so using the same physical key for the active-chat `app.session.stop` action preserves the established context-scoped convention.

<!-- /arch_skill:block:research_grounding -->

<!-- arch_skill:block:current_architecture -->
# Current Architecture

1. The active chat editor recognizes canonical app actions, but it has no stop-current-agent action.
2. `Ctrl+D` calls the shared TUI shutdown path. The daemon adapter then sends `detach`, leaving the resident worker active.
3. A user can stop an agent from Agents View or with `prime-agent stop <agent>`, both of which use the existing daemon `kill` path.
4. The TUI consumes an intentional daemon `session_closed` notification as a generic connection error because it cannot currently identify a user-requested stop.
5. The public lifecycle docs explain detach and CLI stop separately but provide no direct finished-from-chat workflow.

<!-- /arch_skill:block:current_architecture -->

<!-- arch_skill:block:target_architecture -->
# Target Architecture

1. The canonical keybinding registry defines editor-global `app.session.stop`, default `Ctrl+X`, and extension conflict protection.
2. Interactive Mode rejects the action while a draft exists; otherwise it sets a single-flight stop guard and shows progress.
3. The `AgentConnection` boundary exposes `stop()`. The daemon adapter selects the already-supported `kill` or `complete_owned_session` command, while the in-process adapter records `archived` for a persisted session.
4. Interactive Mode suppresses the expected close error while its own stop is pending. A failed stop resets the guard and leaves the TUI usable.
5. After acknowledgement, the normal shutdown path drains terminal input, tears down the UI, disposes the connection, runs shutdown callbacks, omits the stale resume hint, and exits successfully.
6. Quick help and lifecycle docs present the operator choice directly: `Ctrl+D` leaves work running; `Ctrl+X` stops and archives it.

<!-- /arch_skill:block:target_architecture -->

<!-- arch_skill:block:call_site_audit -->
# Call-Site Audit

| Surface | Current owner/callers | Planned change |
|---|---|---|
| Canonical app actions | `packages/coding-agent/src/core/keybindings.ts` | Add configurable `app.session.stop` with default `ctrl+x` and a compatibility alias. |
| Extension shortcut arbitration | `packages/coding-agent/src/core/extensions/runner.ts` | Reserve the effective editor-global stop binding. |
| Active chat input/lifecycle | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Register the action; guard drafts/repeats; wait for stop; suppress expected close; make shutdown optionally omit the resume hint; update quick/full help. |
| Connection contract | `packages/coding-agent/src/modes/agent-connection/types.ts` | Add the transport-neutral `stop(): Promise<void>` contract. |
| Resident/owned transport | `packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts` | Send existing `kill` for resident sessions or existing `complete_owned_session` for owned no-session workers. |
| Process-local transport | `packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts` | Persist `archived` when a session file exists; normal TUI shutdown performs disposal. |
| TUI lifecycle docs | `packages/coding-agent/README.md`, `packages/coding-agent/docs/keybindings.md`, `packages/coding-agent/docs/usage.md`, `packages/coding-agent/docs/long-running-agents.md` | State the `Ctrl+X` stop/archive versus `Ctrl+D` detach distinction. |
| Focused regressions | `packages/coding-agent/test/interactive-mode-startup.test.ts`, `agent-connection-daemon.test.ts`, `agent-connection-in-process.test.ts`, `extensions-runner.test.ts` | Prove the visible workflow and adapter routing without running a real provider or changing daemon tests. |
| Release note | `packages/coding-agent/.changes/tui-stop-and-archive-hotkey.md` | Add one past-tense user-visible line. |
| Plan/proof ledger | This document and its derived `_WORKLOG.md` | Record scope, commands, results, commit hashes, push/merge state, and installation smoke evidence. |

No file under `packages/coding-agent/src/modes/daemon/` or daemon protocol is an implementation surface.

<!-- /arch_skill:block:call_site_audit -->

<!-- arch_skill:block:phase_plan -->
# Phase Plan

## Phase 1 — Add the transport-neutral TUI stop lifecycle

1. Add and reserve the configurable `app.session.stop` action with default `Ctrl+X`.
2. Add `AgentConnection.stop()` and implement it with existing daemon commands plus process-local archival.
3. Register the Interactive Mode handler with draft protection, single-flight state, expected-close suppression, failure recovery, and success-only shutdown.
4. Add focused adapter and interaction regressions.

## Phase 2 — Make the workflow discoverable and ship the fork

1. Update quick/full in-TUI help and the canonical lifecycle/keybinding documentation.
2. Add the coding-agent changelog fragment and focused extension-conflict proof.
3. Run every modified test file from `packages/coding-agent`, then the root `npm run check`, and record exact results.
4. Commit only frozen-scope files, push `feat/tui-stop-and-exit`, fast-forward the dirty-but-nonoverlapping main workspace, push `origin/main`, and verify the installed source-linked command resolves to the merged commit.

<!-- /arch_skill:block:phase_plan -->

<!-- lilarch:block:plan_audit -->
# Plan Audit

**Verdict: PASS — scope signed off and ready for finish mode.**

- The behavior is entirely initiated and coordinated by the TUI/client boundary; the daemon and protocol remain unchanged.
- Reusing `kill` preserves the repository's existing graceful archive, abort, descendant, schedule, tombstone, and worker-finalization semantics instead of duplicating them.
- Draft protection and success-only exit prevent the two material user-loss cases: discarded unsent text and a false belief that a failed stop succeeded.
- The single competing input owner—extension shortcuts—is included in the minimal convergence closure. Other `Ctrl+X` actions remain context-specific and unchanged.
- Both supported connection adapters implement the same contract; no runtime-type check leaks into Interactive Mode.
- Two phases are sufficient, every task maps to an authorized requirement, and no unresolved product decision remains.

**Frozen implementation scope:** only the source, tests, docs, changelog fragment, plan, and worklog named above. No daemon source, protocol, supervisor, package-lock, generated artifact, unrelated cleanup, release build, or credential operation may be added.

<!-- /lilarch:block:plan_audit -->

<!-- arch_skill:block:implementation_audit -->
# Implementation Audit

**Verdict: VERIFIED — implementation is complete; publication, merge, and installation proof remain.**

- `app.session.stop` is canonical, configurable, editor-scoped, defaults to `Ctrl+X`, and is protected from extension interception.
- Interactive Mode preserves drafts, coalesces repeated presses, waits for `AgentConnection.stop()`, suppresses the requested close event, exits only on success, and keeps failures visible/retryable.
- Resident and owned daemon connections reuse `kill` and `complete_owned_session`; process-local persisted sessions record `archived` and dispose. No daemon or protocol source changed.
- Quick/full TUI help and lifecycle documentation clearly distinguish `Ctrl+X` stop/archive from `Ctrl+D` detach.
- Focused verification passed 141 tests across four files. The final root `npm run check` passed Biome over 971 files with no fixes, TypeScript, installer render, and browser smoke.
- `git diff --check` passed and the daemon-source diff audit was empty.

Implementation evidence: [worklog](./TUI_STOP_AND_ARCHIVE_HOTKEY_PLAN_2026-08-28_WORKLOG.md). Delivery evidence will be appended after the authorized push, main-workspace merge, and installed-command smoke check.

<!-- /arch_skill:block:implementation_audit -->
