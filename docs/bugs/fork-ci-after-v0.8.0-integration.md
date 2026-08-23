---
title: "Fork CI fails after the Prime Agent v0.8.0 integration"
date: 2026-08-23
status: verifying
owners: [prime-agent]
reviewers: []
related:
  - https://github.com/aelaguiz/prime-agent/actions/runs/32657250978
  - https://github.com/aelaguiz/prime-agent/actions/runs/32657250958
  - https://github.com/aelaguiz/prime-agent/actions/runs/32659113077
  - https://github.com/aelaguiz/prime-agent/actions/runs/32659113044
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** The first repair makes the fork release workflow and nine of eleven CI jobs green, but two loaded Linux process tests still fail after their behavior assertions: one on an `ENOTEMPTY` teardown race and one on a fixed 10-second child-exit deadline.
- **Impact:** The fork still lacks a completely green integration signal after the v0.8.0 merge even though all original ACP, fixture-contract, check, and release-ownership failures are fixed.
- **Most likely cause:** Detached recovery processes can flush their last lifecycle record after the daemon socket and workers have closed, while the deliberately blocked real CLI process can take more than the ordinary fixture deadline to compile in a loaded shard.
- **Next action:** Verify bounded process cleanup and the targeted extended loader deadline locally, rerun exact shard 1 plus repository checks, then push and monitor both workflows through completion.
- **Status:** Verifying.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

An exact push of fork `main` must complete its ordinary CI and release workflows without weakening tests, hiding failures, bypassing checks, or requiring unavailable upstream-only repository configuration.

## Bug Summary

Fork commit `8685f1d024fd06bf14777e902d9a123d5aa3082c` builds and type-checks successfully in GitHub Actions. The coding-agent kernel shard and every other package test job pass, but all three ordinary coding-agent shards fail. The release workflow builds and checks successfully, then fails before packing because `PRIME_AGENT_DOWNLOAD_BASE_URL` is empty. These failures have recurred across several fork commits and are not transient runner startup failures.

## Evidence

- Fork CI run `32657250978` failed on exact head `8685f1d0`; `Build and check`, `Test (coding-agent kernel)`, `Test (coding-agent process smoke)`, `Test (ai)`, `Test (runtime python)`, `Test (tui)`, and `Test (agent-core)` all passed.
- Coding-agent shard 1 reported 29 failures across four files. Direct failures include a stale in-process session double without `rebindModelsFromRegistry()`, test models whose missing `id` reaches `supportsFastMode()`, and a process-lifecycle fixture timeout. Twenty-three ACP-feature cases collapse to a shared ACP `RequestError: Internal error`.
- Coding-agent shard 2 reported two ACP canonical-cwd cases failing with the same ACP `RequestError: Internal error`.
- Coding-agent shard 3 reported nine failures across four files. Six ACP-mode cases plus the RLM ACP case collapse to the same internal error. Direct failures identify an uncommented empty catch at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:7838` and an update-restart assertion whose client is unexpectedly absent.
- Release run `32657250958` passed checkout, dependency installation, build, and check. `Pack production release` then evaluated `test -n "$PRIME_AGENT_DOWNLOAD_BASE_URL"` with `PRIME_AGENT_DOWNLOAD_BASE_URL` empty and exited 1.
- The release workflow sources that value from repository variable `R2_PUBLIC_BASE_URL` in `.github/workflows/build-binaries.yml`.
- A protocol-level local probe printed the hidden ACP error data: `{ "details": "Cannot read properties of undefined (reading 'authStorage')" }`.
- The local update-restart failure logged the same exception at `createAgentConnectionState()` before its client-membership assertion, proving it shares the ACP fixture cause rather than exposing a separate restart regression.
- `createAgentConnectionState()` has projected AIM credential bindings from `runtime.services.authStorage` since fork commit `3c4f91d1`; current production runtimes own that service, but the failing ACP and update-restart test constructors provide only `session` and lifecycle methods.
- `test/agent-connection-in-process.test.ts` reproduces independently because its fake session omits `rebindModelsFromRegistry()`, which the current catalog refresh contract calls after fetching.
- `test/interactive-mode-startup.test.ts` reproduces independently because its fake connection model omits the required `id`; `supportsFastMode()` evaluates `model.id.startsWith(...)`.
- `test/no-silent-catch.test.ts` reproduces independently. The catch is intentionally best-effort and its surrounding prose says the next state event reconciles the snapshot, but the required explanation is outside rather than inside the catch body.
- `test/process-lifecycle-process.test.ts` passes all 13 tests alone in 1.50 seconds. No process-lifecycle change is justified unless the repaired shard reproduces the timeout.
- The fork currently defines no Actions variables or secret names for the inherited R2 workflow. The checked-in workflow is byte-equivalent to upstream's publishing workflow and the fork's recent release runs have no successful publication path.
- Replacement release run `32659113044` passes on exact repair head `40c6099e`: build/check succeeds and fork-owned pack/upload/publish steps are correctly skipped.
- Replacement CI run `32659113077` clears every original ACP and stale-double failure. Nine of eleven constituent jobs pass, including coding-agent shards 2 and 3; only process smoke and coding-agent shard 1 remain red.
- Process-smoke behavior passes, including snapshot streaming and same-worker adoption, before `afterEach` fails removing `/tmp/prime-daemon-supervisor-test-*/agent` with `ENOTEMPTY`. That is the same detached lifecycle-writer cleanup race reproduced locally in ENG-4600 after all behavior assertions pass.
- Coding-agent shard 1 passes 1,482 tests (26 skipped); only `captures an actual CLI failure before cli-main loads` reaches its fixed 10-second `waitForExit()` deadline. The full file passes locally in roughly 1.5 seconds, identifying CI shard load rather than a changed lifecycle result.

## Investigation

The failure set is concentrated in coding-agent test contracts and one release ownership boundary. Build and type-check success rule out a repository-wide compile regression. The hidden ACP error and update-restart log converge on one missing runtime service in partial test hosts; production construction remains intact and should not gain an optional fallback. The catalog and startup failures are invalid partial fixtures, not reasons to make required production fields optional. The empty catch is already documented as safe best-effort behavior and needs only the locally enforced explanation. The release workflow belongs to upstream's R2 channel: fork pushes should retain build/check validation but must not claim production/beta publication or enter the publish job.

## Ranked Hypotheses

1. **Confirmed — stale snapshot-bearing runtime fixtures:** ACP and update-restart fixtures omit `services.authStorage`; snapshot construction throws before the behavior under test.
2. **Confirmed — two additional stale test doubles:** The in-process session double omits `rebindModelsFromRegistry()` and the startup connection-model fixture omits `id`.
3. **Confirmed — locally enforced explanatory-comment violation:** The empty catch is intentional but its safety rationale is not inside the catch body as the invariant requires.
4. **Confirmed — fork release ownership mismatch:** The inherited upstream workflow asserts publish intent without the upstream repository's R2 configuration.
5. **Confirmed — bounded process-harness assumptions are too narrow under load:** The replacement Linux run exposes an OS-level directory removal race after successful daemon assertions and a deliberately blocked real-process fixture exceeding its ordinary 10-second deadline.

## Scope and Simplicity Contract

- **Human-authorized corrected behavior:** Make the fork's current `main` GitHub CI workflows pass, push the necessary fixes to `origin/main`, and continue through replacement runs until they pass.
- **Smallest sufficient fix:** Supply the existing harness auth storage in the five partial runtime fixtures; add the current catalog-rebind method and required model ID to their direct test doubles; put the existing best-effort rationale inside the empty catch; and make upstream publication intent conditional on the canonical upstream repository while retaining fork build/check validation.
- **Initial minimal convergence closure:** The shared runtime fixture contract spans ACP mode, ACP features, ACP RLM, canonical-cwd, and update-restart tests and must move together because they all call the same snapshot owner. The two independent direct fixtures, one catch body, and release-context/publish-job gates are the only additional owners. No production daemon/session protocol or behavior changes.
- **Scope sign-off:** Signed off before implementation on 2026-08-23. The replacement run confirms the deferred process timeout and teardown race, authorizing only bounded harness cleanup and a test-specific loader deadline; production lifecycle behavior remains out of scope.
- **Enough proof:** Every previously failing focused test passes locally; `npm run check` passes with full output; a pushed exact head receives successful `CI` and `Release Prime Agent` conclusions on the fork.
- **Do not build:** No test disabling, reduced matrix coverage, behavioral-operation retries, swallowed errors, compatibility fallbacks, dependency downgrade, daemon behavior expansion, or unrelated upstream cleanup.
- **Accepted residual risk:** Platform-only behavior not exercised by the focused local macOS runs remains owned by the complete Linux GitHub matrix.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Add `services.authStorage` from the real harness/session registry to all five snapshot-bearing partial runtimes.
2. Complete the direct in-process session and startup model fixtures with the current required members.
3. Add the explanatory safety comment inside the intentional best-effort catch.
4. Keep fork release build/check active, but set publication intent only for `PrimeIntellect-ai/prime-agent` and skip the publication job when neither channel is selected.
5. Run every modified/failing test file, then all three exact CI shards and the required repository check.
6. Commit only owned files, push `main`, and monitor both fork workflows through completion; repeat only for newly evidenced in-scope failures.
7. Give detached fixture writers a bounded teardown window and extend only the deliberately loader-blocked real-process case to 20 seconds, then repeat its focused tests and exact shard 1.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

- Added the harness/session registry's real `authStorage` to the five partial runtime fixtures that construct connection snapshots.
- Completed the direct catalog and startup doubles with `rebindModelsFromRegistry()` and the required model `id`.
- Moved the existing best-effort state-refresh rationale into the intentional catch body.
- Kept release build/check validation active on every repository, while restricting publication intent and the `publish` job to `PrimeIntellect-ai/prime-agent`.
- Focused verification passes: 9 files and 133 tests, including every previously failing file plus the process-lifecycle regression.
- Exact coding-agent shard 2 passes with 1,782 tests (14 skipped); shard 3 passes with 1,272 tests (16 skipped).
- Exact shard 1 clears all original failures and passes 1,483 tests (25 skipped), then encounters an unrelated Darwin-only `ENOTEMPTY` cleanup race in ENG-4600 after its behavior assertions complete. The isolated rerun reproduces only that teardown race; the same regression passed on the prior Linux Actions run, so the authoritative replacement Linux matrix remains the scoped proof rather than expanding this fix into supervisor cleanup behavior.
- Repository-wide `npm run check` passes with no formatter changes, including TypeScript, installer rendering, and browser smoke checks. The release workflow also parses as YAML; local `actionlint` reports only inherited workflow/tool-version findings, not the new repository gate.
- Pushed repair commit `40c6099e` makes replacement release run `32659113044` green and clears every original coding-agent failure in replacement CI run `32659113077`.
- The replacement CI run narrows the remaining failures to post-assertion `ENOTEMPTY` cleanup in process smoke and a 10-second real-process loader deadline in shard 1. The follow-up keeps all behavior assertions intact while adding bounded filesystem retries and extending only that intentionally blocked loader case.
- Follow-up focused verification passes: process lifecycle 13/13, process smoke 10/10 applicable tests (8 platform/tag skips), and ENG-4600 supervisor singleton 15/15, including the teardown path that previously reproduced `ENOTEMPTY` locally.
- Exact coding-agent shard 1 now passes 114 files with 1,484 tests passed and 25 skipped. Repository-wide `npm run check` also passes again with no formatter changes.
<!-- /bugs:block:implementation -->
