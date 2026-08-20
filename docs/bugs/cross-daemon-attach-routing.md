---
title: Cross-daemon attach cannot open an already-active saved session
date: 2026-08-08
status: resolved
owners: [coding-agent]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** `prime-agent attach <saved-session-id>` only checks the current build-scoped daemon, while `--resume` reports that the same saved session is already active under an unreachable-looking runtime ID.
- **Impact:** A live resident agent can keep working with zero attached clients, but the operator must discover and pass its owning daemon socket manually.
- **Most likely cause:** explicit attach routes through one `defaultDaemonSocketPath()` and `get_state` treats the selector only as an active runtime ID; it neither resolves a saved session ID nor searches other discovered daemon sockets.
- **Next action:** use the repaired short attach command; no further implementation work remains.
- **Status:** resolved.
<!-- bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

`prime-agent attach <agent>` opens the one already-running local agent selected by active ID, saved session ID, or unambiguous name, regardless of which locally discoverable Prime daemon owns it. It never starts, resumes, replaces, or stops a daemon while resolving an explicit attach.

## Bug summary

Prime daemons are build-scoped, so compatible and stale builds can coexist on different Unix sockets. A saved session may therefore be leased by a live worker owned by a non-default daemon. The current command rewrites `attach <agent>` to `--resume <agent>`, but startup probes only the current default socket with `get_state(activeSessionId: selector)`. A saved session ID fails that lookup; another daemon is never considered.

The visible failure is internally contradictory but accurate at two different layers:

1. the current daemon cannot find the target runtime to attach;
2. attempting to resume the JSONL fails because the cross-process lease identifies its live owner.

## Evidence


- A saved session can be leased by a live worker owned by a non-default daemon while the default daemon reports no matching active runtime.
- `handlePublicCommand()` rewrites `attach` into `--resume` plus `attachAgent` in `packages/coding-agent/src/cli/public-command.ts`.
- Before this fix, `findActiveDaemonSessionSummary()` sent one `get_state` request to one socket.
- `discoverDaemons()` already exposes reachable current and stale daemon sockets without mutating them.

## Scope and simplicity contract

- **Human-authorized corrected behavior:** the normal short command `prime-agent attach <saved-or-active-session-id>` must locate and attach the existing live runtime across local Prime daemon sockets.
- **Smallest sufficient fix:** resolve the selector against active summaries on the default daemon first, then other reachable daemons; return the owning socket and active summary to existing interactive attach startup.
- **Initial minimal convergence closure:** use the same selector matching for default-daemon and cross-daemon explicit attach so saved IDs, active IDs, and unambiguous names do not diverge. No other attach/resume owner exists that must be migrated.
- **Scope freeze:** frozen before implementation at explicit interactive attach target resolution and its focused proof.
- **Enough proof:** tests show default-first resolution, cross-daemon saved-ID resolution, active-ID/name matching, ambiguity rejection, and no daemon lifecycle command; run the focused test and repository check.
- **Do not build:** no daemon aggregation UI, daemon migration, worker adoption, socket aliases, resume behavior change, shutdown/restart fallback, protocol command, or persistent global daemon registry.
- **Accepted residual risk:** a daemon whose protocol cannot answer existing `list`/`get_state` primitives cannot be attached by a newer client; resolution must fail clearly without mutating it.
<!-- bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Candidate fix plan

1. Add a small attach-target owner that resolves an explicit selector to `{ socketPath, summary }` using existing read-only daemon commands and discovered sockets.
2. Match structured active summary fields only: active runtime ID, saved session ID, exact name, supported ID suffix, and canonical session path.
3. Route explicit attach startup through the located socket while preserving the existing direct-attach path and no-daemon-start guarantee.
4. Add focused regression tests and an unreleased changelog entry.
5. Classify protocol impact and run required verification.
<!-- bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation

- `packages/coding-agent/src/main.ts` now resolves active runtime IDs, saved session IDs, exact names, supported ID suffixes, and canonical session paths from active daemon summaries.
- Explicit attach checks the default daemon first, then read-only discovers and queries other reachable local Prime daemons only when needed.
- Startup carries the located daemon socket into the existing interactive attach connection instead of resuming, starting, replacing, or stopping any daemon.
- An explicit `--daemon-socket` remains exact and does not widen into global discovery.
- `packages/coding-agent/test/main-interactive-routing.test.ts` covers selector resolution, default-daemon short-circuiting, cross-daemon saved-session routing, and ambiguity rejection.
- `packages/coding-agent/CHANGELOG.md` records the user-visible fix.

## Verification

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/main-interactive-routing.test.ts` from `packages/coding-agent`: 58 passed.
- `npm run check` from the repository root: passed with no warnings or fixes on the final run.
- A read-only fixture resolves a saved session to its active runtime on a non-default daemon without starting, resuming, replacing, or stopping any daemon.
- `git diff --check`: passed.

## Protocol classification

Backward-compatible with no wire-shape change. The fix uses existing `daemon_hello`, `list`, `get_state`, and `attach` contracts and adds no command, event, response field, capability, protocol bump, or schema revision.
<!-- bugs:block:implementation -->
