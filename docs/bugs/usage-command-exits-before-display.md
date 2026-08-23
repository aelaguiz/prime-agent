---
title: "Interactive /usage can terminate before its result is readable"
date: 2026-08-23
status: resolved
owners: [prime-agent]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** The user reports that invoking `/usage` in Prime Agent immediately exits before the usage result can be read.
- **Impact:** Account, provider, token, cost, and context telemetry is inaccessible through its documented interactive command, and the active client may be lost.
- **Most likely cause:** Confirmed. `/usage` is an async editor callback whose rejected promise is not observed by the editor. Its session RPCs and rendering sit outside an error boundary, so a rejection becomes fatal under Node 22.
- **Resolution:** `/usage` now owns an error boundary across its complete stats, state, AIM, formatting, and rendering operation, converting failures into a readable transcript error instead of an unhandled rejection.
- **Status:** Resolved and locally verified; commit and push are the remaining delivery steps.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

Invoking `/usage` must leave the interactive Prime Agent client alive and keep a readable result or explicit error in the transcript, regardless of whether AIM or a usage RPC is available.

## Bug Summary

The report is specific to the interactive `/usage` command. The current command first reads session stats and connection state, optionally invokes one or more AIM helpers, formats account and session telemetry, and appends the result to the local chat. The ordinary installed path succeeds in controlled TUI reproductions, so the investigation must cover the failure boundary that only appears under an unavailable/racing dependency as well as the possibility that a later transcript resync removes local-only output.

## Evidence

- `~/.local/bin/prime-agent` executes this checkout's bundled `packages/coding-agent/dist/bundle/cli.js`; its reported version is `0.8.0`.
- The active default daemon reports the same version, protocol 7, schema 23, and current bundle identity.
- A controlled 80x24 tmux run from this checkout invoked `/usage`, rendered both bound AIM accounts plus session totals, and remained alive.
- The same installed-client reproduction remained alive with fullscreen enabled.
- A second controlled 80x24 run from `~/workspace/aimgr` also rendered `/usage` and remained alive, including while a daemon bash command was active.
- The latest AIM CLI completes `aim status --json` successfully on this machine.
- No crash report or client error corresponding to the current controlled `/usage` invocations was written. The only same-day client crash with `EPIPE` was an unrelated JSON-mode process whose stdout consumer closed during the earlier installation work.
- `InteractiveMode.setupEditorSubmitHandler()` assigns an `async` callback to `Editor.onSubmit`.
- `Editor.onSubmit` is typed as returning `void`, and `Editor.submitValue()` invokes it without awaiting or attaching a rejection handler.
- The `/usage` branch directly awaits `handleUsageCommand()`.
- `handleUsageCommand()` catches AIM-helper query failures, but its initial `getSessionStats()` and `getState()` RPCs, auth-storage lookup, formatting, and rendering are outside an error boundary.
- An isolated Node 22.19 process that submits an async failing callback through the TUI input exits 1 with the callback error as an unhandled rejection.
- An isolated Node 22.19 process that invokes the current `handleUsageCommand()` with a rejecting `getSessionStats()` RPC exits 1 at `interactive-mode.ts:9260`.
- Resuming the largest local persisted session (839 assistant messages, five compactions, and 188k live context tokens) still renders `/usage` and remains alive. Its persisted assistant usage fields are structurally complete.
- Local command output is not persisted in the session transcript. A later `session_resynced` or other full transcript rebuild clears it, although no such resync occurred in the controlled runs.

## Investigation

The happy path is healthy in both relevant working directories, terminal modes, and a large historical session, which rules out unconditional command parsing, AIM status schema, current bundle installation, persisted usage shape, and ordinary rendering failures. The process probes confirm the literal reported exit path: the TUI discards an async submit rejection, and Node 22 terminates. `/usage` has a command-specific hole because AIM subprocess failures are contained but the prerequisite session RPC and rendering path are not. The narrow owner is therefore `handleUsageCommand()`: it must convert its own failures into an explicit transcript error. A generic editor callback redesign is unnecessary for this bug, and local-output persistence remains out of scope because no resync disappearance reproduced.

## Ranked Hypotheses

1. **Confirmed — unobserved rejected `/usage` submit:** A usage-specific RPC or formatter rejects; `Editor.submitValue()` discards the async callback promise; Node terminates on the unhandled rejection.
2. **Not reproduced and out of scope — local output is cleared by transcript resync:** `/usage` remained visible in every controlled run, including a large resumed session; no resync occurred after its result.
3. **Currently contradicted — current AIM status helper exits the interactive client:** Direct AIM status and two exact installed-client runs succeed, and the helper is a separate child process whose failures are caught.
4. **Currently contradicted — unconditional `/usage` parser or renderer regression:** Normal and fullscreen TUI runs both retain the rendered result and stay alive.

## Scope and Simplicity Contract

- **Human-authorized corrected behavior:** `/usage` remains readable and must not exit Prime Agent; fix it elegantly, test it, commit it, and push it to the fork's `origin`.
- **Smallest sufficient fix:** Catch failures across the complete `handleUsageCommand()` operation and render one explicit `Unable to load usage: <reason>` error; retain the existing per-helper unavailable rendering for ordinary AIM subprocess failures.
- **Initial minimal convergence closure:** `none`. `/usage` is the only evidenced command contract and can own the error boundary without changing the generic editor callback API or transcript persistence.
- **Scope sign-off:** Signed off on 2026-08-23 before implementation.
- **Enough proof:** A focused regression must fail on the current code, pass after the fix, prove a rejected stats RPC resolves through a visible error, and preserve the existing success cases. Then run the focused test plus `npm run check`, followed by controlled source/dist TUI `/usage` runs that remain alive.
- **Do not build:** No provider fallback, swallowed RPC errors, daemon protocol change, generic transcript redesign, unrelated local-command persistence work, dependency change, or test weakening.
- **Accepted residual risk:** A simultaneous transcript resync can still remove any local-only command output; that separate behavior did not reproduce and is not required to stop the reported process exit.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Add a focused regression proving a rejected usage stats RPC becomes a readable error rather than a rejected command promise.
2. Wrap the complete usage operation at its command owner without changing the existing AIM-helper unavailable behavior.
3. Run the focused usage tests, `npm run check`, and controlled source/dist TUI reproductions.
4. Commit only the owned bug, test, changelog, and implementation files; push `origin/main`; verify the exact remote head and CI.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

- Added a command-local `try`/`catch` around the complete `/usage` operation. Existing per-AIM-helper degradation is unchanged; unexpected failures now render `Unable to load usage: <reason>` through the standard TUI error component.
- Added `test/interactive-mode-usage.test.ts`. Before the implementation it failed because `handleUsageCommand()` rejected with `usage RPC failed`; after the implementation the same promise resolves and `showError()` receives the readable failure.
- Focused verification passed: `interactive-mode-usage.test.ts`, `aim-usage.test.ts`, and `interactive-mode-status.test.ts` — 181 tests total.
- Full repository verification passed: `npm run check` (Biome, TypeScript, installer rendering, and browser smoke checks).
- A source client launched through `./prime-agent.sh --offline`, connected to the resident daemon, rendered both Claude and Codex AIM account usage plus session totals, and remained alive after `/usage`.
- The installed dist client had already passed the same live happy-path checks before implementation; the changed failure path is covered directly at source because repository policy forbids a local production build during this workflow.
<!-- /bugs:block:implementation -->
