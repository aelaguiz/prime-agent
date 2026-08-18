---
title: Fix /usage with mixed AIM helper installations
date: 2026-08-18
status: resolved
owners: [Prime Agent]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** `/usage` shows `Provider usage unavailable` for every AIM-managed account even when AIM has valid usage windows.
- **Impact:** Users cannot see provider quota from Prime Agent after one provider was installed by a different AIM checkout.
- **Most likely cause:** `InteractiveMode.handleUsageCommand` refuses to query AIM unless every session binding resolves to the exact same helper path.
- **Next action:** None; the mixed-helper path is fixed and verified.
- **Status:** Resolved.

<!-- bugs:block:analysis -->
## Bug North Star

`/usage` must show valid account usage for each AIM-managed session binding regardless of whether other providers were installed from a different trusted AIM executable. One unavailable helper must not hide healthy providers.

## Bug Summary

The current handler builds a set of AIM helper paths for all bindings and proceeds only when the set has exactly one member. A mixed installation therefore sets one global `usageUnavailable` flag and skips every status query. The resulting message is false for healthy accounts.

## Evidence

1. The current local session binds Codex account `growth`; AIM reports a healthy 168-hour usage window.
2. Local managed descriptors resolve Codex/Anthropic and xAI to two trusted AIM executable paths.
3. Applying the handler's exact predicate produces no selected executable, so no AIM status process starts.
4. Source comparison shows the fast-label commits did not change `/usage`; the unanimity predicate predates them.
5. A direct trusted-helper query returns the expected account usage, ruling out missing quota data.

## Investigation

The failure owner is `InteractiveMode.handleUsageCommand`. `queryAimAccountUsage` already validates and queries one exact helper safely. The UI layer incorrectly treats helper-path unanimity as a prerequisite for all providers instead of routing each provider through its own trusted helper.

## Scope and Simplicity Contract

- **Human-authorized corrected behavior:** Make `/usage` work as before and remove the unnecessary mixed-binary/path gate; test it.
- **Smallest sufficient fix:** Resolve the helper per AIM binding, query each distinct helper once, and render availability per binding.
- **Initial minimal convergence closure:** Replace the global all-helpers-must-match branch in the sole `/usage` handler and update its focused tests. No competing `/usage` owner exists.
- **Scope freeze:** Frozen before implementation edits.
- **Enough proof:** A regression with two valid, different helpers; focused test file; repository check; live no-inference source smoke.
- **Do not build:** No generic binary-version framework, helper fallback chain, daemon protocol change, auth migration, or provider request.
- **Accepted residual risk:** An individual missing, untrusted, timed-out, or invalid helper still renders unavailable for only its bindings.

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Add a regression proving two provider bindings with different trusted helpers both render usage.
2. Replace global executable unanimity with a deduplicated per-helper query map.
3. Preserve the existing unique-installed-helper fallback for a persisted AIM binding whose provider has switched to native auth.
4. Run the focused test and `npm run check`.
5. Smoke-test the fixed source against the real mixed-helper installation without sending a model prompt.

<!-- bugs:block:implementation -->
## Implementation and Verification

### Implementation

- Replaced the global all-helper-path unanimity gate with a per-binding helper route.
- Deduplicated queries by trusted executable so providers installed from the same AIM checkout still share one status call.
- Scoped query failures to only the bindings owned by the failed helper.
- Preserved the unique installed-helper fallback for persisted AIM bindings whose provider has since switched to native auth.
- Added the user-visible changelog entry and a mixed-helper regression.

### Verification

- The new regression failed before the fix with both providers reported unavailable, then passed after the fix.
- All five focused `/usage` account-scope tests pass.
- `npm run check` passes, including formatting, type checking, installer rendering, and browser smoke checks.
- A source-mode TUI smoke against the real local mixed installation rendered healthy Claude and Codex windows, including Codex `growth` at 46% used, with zero session tokens and no model prompt.
- The full `interactive-mode-status.test.ts` run retains three unrelated pre-existing session-switch catalog failures; the same three failed in the before-fix run, while the new `/usage` regression changed from failing to passing.
