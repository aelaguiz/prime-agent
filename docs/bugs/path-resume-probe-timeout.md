---
title: Saved-session path resumes fail during slow daemon worker refresh
date: 2026-08-21
status: resolved
owners: [coding-agent]
reviewers: []
related: [docs/bugs/cross-daemon-attach-routing.md]
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** `prime-agent --resume /absolute/session.jsonl` intermittently exits with a 3-second `get_state` timeout before opening the saved session.
- **Impact:** AIM scheduled routines finish their credential pin but fail before admitting the real prompt when daemon workers are recovering or slow.
- **Most likely cause:** path resumes now probe the daemon with `get_state(path)` using a 3-second client timeout, while a miss makes the supervisor refresh every worker with a 5-second budget.
- **Next action:** no implementation work remains.
- **Status:** resolved.
<!-- bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

An explicit saved-session path resumes its active daemon owner when one exists and otherwise opens the saved session normally, even while unrelated daemon workers are slow to refresh.

## Bug summary

AIM first creates a short print-mode pin session, then launches the interactive routine with `--resume <session-file>`. Commit `710873bad` made every path resume probe the daemon fleet. The probe sends `get_state` with a 3-second timeout. The supervisor does not match session paths in its initial worker lookup, so it refreshes every worker; each refresh may take 5 seconds. A slow worker therefore makes the client exit before the supervisor can return `Unknown active session` and allow the saved-session path to continue.

## Evidence

- AIM manual receipt `community-sweep--2026-08-21T08-15-0500--manual-336dfca5-47a4-4230-a600-ec651d3508c1.json` records `admittedAt: null` and interactive exit code 1.
- The daemon logged `Unknown active session: ...01a02475...jsonl` after the client-side lookup budget had expired.
- `findActiveDaemonSessionSummary()` uses a 3-second `get_state` request; `DaemonSupervisor.refreshWorkerSummaries()` allows 5 seconds per worker.
- A later `reddit-sweep` completed under the same code when its path lookup returned within three seconds, proving the failure is latency-sensitive rather than a dead daemon.

## Investigation

The prompt, AIM credential binding, Herdr workspace creation, and pin session all completed. The failure begins only when the interactive process resumes the pin session by absolute path. Before `710873bad`, normal path resumes skipped active-daemon probing. The new cross-daemon path test covers a healthy active owner but not an inactive saved path while another worker refresh is slow.

## Scope and simplicity contract

- **Human-authorized corrected behavior:** fix and push the path-resume regression that blocks AIM routine prompt admission.
- **Smallest sufficient fix:** use the existing daemon `list` response for absolute-path selectors instead of the 3-second `get_state(path)` request; preserve existing ID/name lookup behavior.
- **Initial minimal convergence closure:** update the one active-session lookup owner and its focused tests; no competing path-resume lookup needs migration.
- **Scope sign-off:** signed off before implementation at path-selector daemon lookup, focused regression proof, bug doc, and changelog only.
- **Enough proof:** focused routing tests, the cross-daemon path-resume process test, repository check, and `git diff --check` pass.
- **Do not build:** no daemon restart fallback, timeout inflation, protocol change, AIM runner change, worker-lifecycle refactor, or unrelated cleanup.
- **Accepted residual risk:** a daemon that cannot answer its existing 30-second list request still fails loudly rather than risking split ownership.
<!-- bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Candidate fix plan

1. Resolve path selectors from active daemon session lists before using `get_state`.
2. Keep active-ID, saved-ID, name, and suffix lookup unchanged.
3. Add focused proof that a path selector never enters the 3-second `get_state` lane.
4. Run the focused unit and process tests plus `npm run check`.
5. Record the verified outcome and protocol classification.
<!-- bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation

- `findActiveDaemonSessionSummary()` now routes absolute-path selectors directly through the existing active-session list query.
- ID, saved-ID, name, and suffix selectors keep the existing `get_state`-first behavior.
- The list command's normal 30-second client budget now exceeds the supervisor's 5-second worker refresh budget, so unrelated slow workers cannot trigger the former 3-second path-resume failure.
- `main-interactive-routing.test.ts` proves a session path never enters the `get_state` lane.
- `CHANGELOG.md` records the user-visible fix.

## Verification

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/main-interactive-routing.test.ts`: 64 passed.
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/main-cross-daemon-resume-process.test.ts`: 1 passed.
- `npm run check`: passed; Biome checked 948 files with no fixes, TypeScript emitted no errors, and installer/browser smoke checks passed.
- `git diff --check`: passed.

## Protocol classification

Backward-compatible with no wire-shape change. The fix uses the existing `list` command and session summary fields.
<!-- bugs:block:implementation -->
