---
title: Claude usage exhaustion fail-fast implementation worklog
date: 2026-08-15
status: complete
plan: ./CLAUDE_USAGE_EXHAUSTION_FAIL_FAST_PLAN_2026-08-15.md
---

# Worklog

## Scope lock

Implementation is limited to the frozen plan: AIM-admitted Anthropic request retry options, shared usage-limit classification/reset metadata, AgentSession terminal retry policy, targeted tests, and affected changelogs. No AIM repository, automatic rotation, polling, daemon protocol, settings, or stream watchdog work is authorized.

## Pre-existing workspace state

The checkout was detached at `3c6c129da067` with unrelated modifications in generated models, kernel/daemon files, daemon/kernel tests, and `packages/coding-agent/CHANGELOG.md`, plus an existing untracked `docs/` tree. Those changes are not owned by this implementation. The pre-existing coding-agent changelog addition was `Fixed concurrent IPython kernels contending on one global SQLite history database.` and must be preserved.

## Progress

- [x] Live provider behavior verified against an exhausted AIM-managed Fable account without retaining credentials or probe files.
- [x] Canonical plan written, audited, and scope-frozen.
- [x] Phase 1 — fail fast and classify usage exhaustion.
- [x] Phase 2 — terminal retry policy, changelogs, and proof.

## Evidence ledger

- `packages/ai`: `test/stream-failure.test.ts` — 29/29 passed.
- `packages/coding-agent`: `test/aim-request-admission.test.ts` and `test/suite/agent-session-retry-events.test.ts` — 34/34 passed.
- Targeted Biome check across all eight changed TypeScript files — passed with no fixes.
- `git diff --check` across owned code/test/changelog paths — passed.
- Live source canary against exhausted AIM account `cfo` — returned terminal `usage_limit` HTTP 429 in 584 ms with reset `2026-08-18T02:00:00.000Z`; no credential or script retained.
- The shared dirty checkout's first `npm run check` reached `tsgo` but exposed an unrelated pre-existing mock-type omission in `packages/coding-agent/test/daemon-supervisor-monitor.test.ts:691`.
- After the user-authorized one-line mock type correction, its targeted 48-test file passed and the active checkout completed the full `npm run check`: Biome, `tsgo --noEmit`, installer render, and browser smoke.
- A clean detached worktree at `3c6c129da067` containing only this implementation also completed the full `npm run check`. The proof worktree was removed; the daemon correction remains isolated with its pre-existing parallel patch rather than being folded into this usage-limit change.

## Self-audit

- **Authorized:** AIM-admitted Anthropic requests now force SDK retries to zero in both normal and `completeSimple` constructors.
- **Authorized:** Anthropic unified rejection becomes terminal `usage_limit`, with retry delay/reset metadata and a reset-aware persisted message.
- **Authorized:** Generic 429 remains `rate_limit` and retains existing retry behavior.
- **Frozen-convergence-required:** Compaction, refinement, branch summarization, and daemon summarization are covered through their existing `completeSimpleWithRequestAdmission` owner; no caller-specific branches were added.
- **Out of scope preserved:** no AIM repo changes, automatic rotation, polling, settings, daemon protocol, or stream watchdog.
- **Unauthorized built scope:** none found.
