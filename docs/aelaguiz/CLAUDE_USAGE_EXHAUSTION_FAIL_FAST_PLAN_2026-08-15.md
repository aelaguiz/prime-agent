---
title: Claude usage exhaustion must fail fast in AIM-managed Prime sessions
date: 2026-08-15
status: complete
owners:
  - aelaguiz
reviewers:
  - Prime Agent self-audit
fallback_policy: Hard cutover for AIM-managed Anthropic requests; no hidden provider retry fallback.
related:
  - Prime session 019ffac1-bdd2-76eb-9cf4-668c50f568d7
  - packages/coding-agent/src/core/sdk.ts
  - packages/ai/src/utils/stream-failure.ts
---

# TL;DR

A verified exhausted Claude Fable account returns HTTP 429 with `rate_limit_error`, `anthropic-ratelimit-unified-status: rejected`, an exact reset timestamp, and a `Retry-After` measured in days. Anthropic's SDK obeys `x-should-retry: true` and sleeps for that entire delay before Prime sees an error, leaving the session visibly "working." For AIM-managed Anthropic requests, Prime will disable SDK retries, classify the verified long-window exhaustion signature as `usage_limit`, show the reset time, and stop retrying the same exhausted account. AIM account selection and manual rotation remain unchanged.

# North Star

**Claim:** When an AIM-managed Claude account has exhausted a subscription usage window, Prime returns a clear terminal error within seconds rather than remaining in an invisible provider retry sleep.

**In scope**

- Normal agent streams and admitted `completeSimple` side paths using AIM-managed Anthropic credentials.
- Structured recognition of Anthropic unified usage rejection.
- Reset-time propagation and a clear persisted/user-visible error.
- Preventing agent-level retries against the same exhausted credential.
- Targeted regression tests and affected package changelogs.

**Out of scope**

- Automatic AIM credential rotation or helper-protocol changes.
- Polling AIM usage before each request.
- Redis quota state, monitoring daemons, heartbeats, or provider proxies.
- Generic SSE inactivity watchdogs.
- Changing unmanaged/native Anthropic retry behavior.
- Treating every HTTP 429 as subscription exhaustion.

**Definition of done**

1. Every AIM-admitted Anthropic call passes `maxRetries: 0` to the provider SDK, including normal agent and `completeSimple` paths.
2. The captured exhaustion response shape becomes `provider_stream_failure.kind = usage_limit`, retains reset/retry metadata, and renders a clear reset-aware message.
3. AgentSession does not retry `usage_limit`; generic `rate_limit` remains retryable.
4. Targeted tests and `npm run check` pass.
5. The implementation adds no AIM mutation, automatic account switch, polling loop, or daemon protocol change.

<!-- lilarch:block:requirements -->
# Requirements

- **R1 — AIM boundary:** Only requests admitted through an AIM-managed Anthropic binding must force Anthropic SDK retries to zero. Other providers and unmanaged Anthropic retain their configured behavior.
- **R2 — Complete call-site coverage:** Apply R1 to both `createAgentSession` streaming and `ModelRegistry.completeSimpleWithRequestAdmission`; compaction, refinement, branch summarization, and daemon summarization flow through the latter.
- **R3 — Exact exhaustion classification:** Upgrade a failure from `rate_limit` to `usage_limit` only when the response is HTTP 429/rate-limited and `anthropic-ratelimit-unified-status` equals `rejected`.
- **R4 — Actionable metadata:** Persist `retryAfterMs` and `resetAt` when the verified numeric Anthropic headers are present. Format reset timestamps in stable UTC ISO form.
- **R5 — No pointless loop:** `usage_limit` is terminal at AgentSession; do not spend the normal 2/4/8-second retry sequence on the same account.
- **R6 — Preserve transient behavior:** A generic 429 without the unified rejection signature remains `rate_limit` and remains eligible for existing agent-level retry.
- **R7 — No implicit failover:** Do not advance, rotate, or mutate the AIM binding automatically. Existing `aim prime resume <session> --rotate` remains the operator recovery path.
- **R8 — Secret-free proof:** Tests use a response fixture derived from the safe status/header/body shape, never a real credential or paid provider request.

**Defaults**

- AIM-managed Anthropic SDK retry count: `0`, not configurable upward inside Prime.
- Exhausted usage error: terminal, reset-aware when the header exists.
- Unmanaged Anthropic and all non-Anthropic providers: unchanged.

**Non-requirements**

- No new settings, feature flags, compatibility shims, wire events, or status panels.
- No attempt to infer usage exhaustion from silence, elapsed time, or cached AIM usage.
- No new automatic recovery behavior.

<!-- /lilarch:block:requirements -->

# Scope and Simplicity Contract

- **Human-authorized outcome and anchors:** The user asked for a full on-disk plan, implementation, and proof that exhausted Claude usage no longer leaves Prime silently working. The live `cfo` Fable probe is the authoritative response-shape anchor.
- **Smallest sufficient solution:** Remove the hidden Anthropic SDK retry layer only at the AIM admission boundary, preserve and format the already-returned provider error, and make that exact failure terminal.
- **Initial minimal convergence closure:** Cover the second admitted provider constructor in `ModelRegistry.completeSimpleWithRequestAdmission`; leaving it unchanged would preserve the same hidden-wait contract in compaction/refinement/summarization side paths.
- **Scope freeze:** Frozen before implementation to the files and behavior named in the call-site audit and phase plan below. Newly discovered adjacent behavior requires subtraction or a new human decision.
- **Enough proof:** One AIM request-options test covering normal and `completeSimple` calls; stream-failure extraction/formatting tests using the captured response; one AgentSession retry-policy test; full repository check.
- **Do-not-build boundary:** No AIM changes, automatic rotation, polling, runtime fallback, provider watchdog, daemon protocol, or broad telemetry.
- **Accepted residual risk:** Native/unmanaged Anthropic requests still use the SDK's configured retry behavior. A 200 response whose SSE body stops producing bytes remains a separate transport-stall problem and must not be mislabeled as usage exhaustion.

<!-- arch_skill:block:research_grounding -->
# Research Grounding

## Live evidence captured 2026-08-15

AIM fresh status reported account `cfo` with Fable usage at 100% and `authState: usage_limited`. A minimal Claude CLI request exited in 3.45 seconds with: `You've reached your Fable 5 limit.` A direct request with the same Claude Code OAuth request shape returned in 0.37 seconds with:

- HTTP `429`
- body error type `rate_limit_error`
- `x-should-retry: true`
- `anthropic-ratelimit-unified-status: rejected`
- `anthropic-ratelimit-unified-7d_oi-status: rejected`
- `anthropic-ratelimit-unified-reset: 1787018400`
- `retry-after: 261858`

The installed Anthropic SDK remained pending after two seconds with defaults, while the identical SDK request with `maxRetries: 0` rejected in 220 ms and preserved status, error type, retry delay, and unified status. Temporary probe files and in-memory credential references were removed.

## Source evidence

- `node_modules/@anthropic-ai/sdk/src/client.ts:837-896` retries HTTP 429, honors `x-should-retry`, parses `Retry-After`, and performs an unbounded `sleep(timeoutMillis)`.
- `packages/ai/src/providers/anthropic.ts:484-533` awaits the SDK response before emitting Prime's first provider `start` event.
- `packages/ai/src/utils/stream-failure.ts` already extracts Anthropic SDK-shaped error status/body/headers but currently collapses all 429s to `rate_limit` and does not retain reset metadata.
- `packages/coding-agent/src/core/sdk.ts:448-476` knows whether the request was AIM-admitted and owns normal stream options.
- `packages/coding-agent/src/core/model-registry.ts:1384-1411` independently constructs admitted options for `completeSimple` callers.
- `packages/coding-agent/src/core/agent-session.ts:10009-10039` currently retries every non-excluded structured stream failure.

No external research is required; the live provider response, installed SDK source, and repository call graph are direct evidence.
<!-- /arch_skill:block:research_grounding -->

<!-- arch_skill:block:current_architecture -->
# Current Architecture

1. AIM resolves and admits an exact Anthropic credential but does not see model responses.
2. Prime constructs provider options in two places: `sdk.ts` for normal agent streams and `model-registry.ts` for `completeSimple` side requests.
3. Anthropic's SDK owns two hidden retries by default. On exhausted usage it obeys the provider's multi-hour/day `Retry-After` before returning control.
4. Prime's generic stream-failure layer can classify the eventual 429 but lacks the unified rejection/reset distinction.
5. AgentSession treats the eventual error as retryable and calls the same exhausted account again.
<!-- /arch_skill:block:current_architecture -->

<!-- arch_skill:block:target_architecture -->
# Target Architecture

1. AIM admission remains credential-only and unchanged.
2. Both AIM-admitted Anthropic request constructors force provider `maxRetries` to zero through one small shared AIM-boundary helper.
3. Anthropic immediately returns its typed SDK error to Prime.
4. The shared stream-failure extractor recognizes the verified unified rejection header, records `usage_limit`, `retryAfterMs`, and `resetAt`, and formats a stable reset-aware message.
5. AgentSession treats `usage_limit` as terminal. Generic 429s retain the existing visible agent-level retry policy.
6. Manual AIM rotation remains outside the request path.
<!-- /arch_skill:block:target_architecture -->

<!-- arch_skill:block:call_site_audit -->
# Call-Site Audit

| Surface | Current owner/callers | Planned change |
|---|---|---|
| Normal agent stream | `packages/coding-agent/src/core/sdk.ts` | Apply AIM-managed Anthropic retry override when `admission` exists. |
| Side-door completion | `packages/coding-agent/src/core/model-registry.ts`; used by compaction, branch summarization, refinement, and daemon summarization | Apply the same override through the shared helper. |
| AIM admission type/semantics | `packages/coding-agent/src/core/aim-external-auth.ts` | Host the narrow request-option helper; do not change helper protocol or credential behavior. |
| Provider failure extraction | `packages/ai/src/utils/stream-failure.ts` | Add `usage_limit` plus reset/retry extraction and message formatting. |
| Anthropic terminal catch | `packages/ai/src/providers/anthropic.ts` | No new branch required; existing catch/record flow consumes the enriched shared classification. |
| Agent retry policy | `packages/coding-agent/src/core/agent-session.ts` | Exclude structured `usage_limit` from retries. |
| Request-option regression | `packages/coding-agent/test/aim-request-admission.test.ts` | Assert both admitted Anthropic call paths receive zero retries. |
| Failure fixture regression | `packages/ai/test/stream-failure.test.ts` | Assert exact exhaustion signature, metadata, message, and generic-429 distinction. |
| Retry regression | `packages/coding-agent/test/suite/agent-session-retry-events.test.ts` | Assert one call and no retry event for `usage_limit`. |
| Release notes | `packages/ai/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md` | Add one user-visible Unreleased bullet per affected package without disturbing existing entries. |

No daemon command, event, response shape, or protocol capability changes.
<!-- /arch_skill:block:call_site_audit -->

<!-- arch_skill:block:phase_plan -->
# Phase Plan

## Phase 1 — Fail fast and preserve the provider's usage-limit truth

1. Add a narrowly named AIM admission helper that returns zero SDK retries only for admitted Anthropic requests.
2. Use it in both normal stream and `completeSimple` request constructors.
3. Extend shared stream-failure information with `usage_limit`, `retryAfterMs`, and `resetAt`.
4. Recognize only the verified 429/rate-limit plus unified-rejected signature and render the reset in UTC.
5. Add/update focused AIM admission and stream-failure tests.

## Phase 2 — Stop the same-account loop and prove integration

1. Make AgentSession decline automatic retry for structured `usage_limit` while preserving generic rate-limit retries.
2. Add the focused AgentSession regression.
3. Update affected Unreleased changelogs.
4. Run each modified test file from its package root, then run repository `npm run check` with full output.
5. Record exact proof and self-audit in the worklog and implementation-audit block.
<!-- /arch_skill:block:phase_plan -->

<!-- lilarch:block:plan_audit -->
# Plan Audit

**Verdict: PASS — ready for finish mode.**

- The plan uses the provider's observed structured signal instead of guessing from elapsed time or cached usage.
- The single competing admitted request constructor is included in the pre-freeze convergence closure; no unrelated provider paths are pulled in.
- Disabling SDK retries at the AIM-managed Anthropic boundary is smaller and safer than a fetch wrapper or AIM protocol extension. Existing agent retry policy remains authoritative for transient failures.
- `usage_limit` must be distinct from generic `rate_limit`; otherwise Prime either keeps retrying exhausted accounts or incorrectly suppresses transient 429 recovery.
- The proof surface is behavior-led and bounded. It does not add repo-policing tests, provider calls, or a monitoring harness.
- Every phase item maps to the user-authorized outcome or the frozen same-contract closure.
- Residual SSE and unmanaged-provider risks are explicit and not silently incorporated.

**Frozen implementation scope:** the exact source, test, and changelog surfaces in the call-site table. No automatic rotation, AIM repository edits, settings, daemon protocol, or stream watchdog may be added during finish mode.
<!-- /lilarch:block:plan_audit -->

<!-- arch_skill:block:implementation_audit -->
# Implementation Audit

**Verdict: COMPLETE — the frozen scope is implemented and proved.**

- AIM-admitted Anthropic normal and `completeSimple` request constructors both force `maxRetries: 0`; configured retries remain unchanged outside that exact boundary.
- The live provider's structured unified rejection is classified as `usage_limit`, with numeric retry/reset headers persisted and the reset rendered in UTC.
- AgentSession performs one provider call and no automatic retry for structured usage exhaustion; fixture coverage confirms a headerless generic 429 stays `rate_limit`.
- Targeted tests passed 63/63. A live exhausted-account canary returned the new terminal message in 584 ms rather than entering the provider's multi-day retry sleep.
- A clean detached worktree containing only this implementation passed the complete `npm run check` pipeline: Biome, TypeScript, installer render, and browser smoke. After a user-authorized one-line mock type correction in the unrelated parallel daemon patch, the active checkout passed the same complete pipeline.
- No AIM mutation, automatic failover, polling, new setting, daemon protocol, watchdog, compatibility shim, or unrelated cleanup was added.
- Existing unrelated workspace changes, including the concurrent-IPython changelog bullet, were preserved.

Implementation evidence: [worklog](./CLAUDE_USAGE_EXHAUSTION_FAIL_FAST_PLAN_2026-08-15_WORKLOG.md).
<!-- /arch_skill:block:implementation_audit -->
