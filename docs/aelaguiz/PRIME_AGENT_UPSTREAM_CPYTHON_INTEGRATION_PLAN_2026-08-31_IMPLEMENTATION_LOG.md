# Prime Agent Upstream CPython Integration — Implementation Log

Plan: `docs/aelaguiz/PRIME_AGENT_UPSTREAM_CPYTHON_INTEGRATION_PLAN_2026-08-31.md`
Audit log: none (cold plan review approved in session)
Active scope: whole approved plan through PR creation
Scope contract anchor: plan §4.1 (user authorization 2026-08-31)
Scope status: approved
Last updated: 2026-09-01
Current checkpoint: v0.8.1 integration committed as `6425ab4d4`; v0.9.1 (`81ae3cb34`) conflicts resolved; repository check and AIM canaries green; merge commit and PR publication pending

## Resume Snapshot

- Current state: real no-commit merge started in the isolated worktree; predicted 22 conflicts reproduced and are split across four non-overlapping native implementers.
- Next useful move: integrate worker returns, resolve any remaining unmerged paths, inspect all 27 text-clean overlaps, then run focused proof.
- Do not redo unless stale: ref/divergence/conflict inventory; pins match the approved plan.
- Known blockers: local npm 11.5.1 is below the repository lock-generation requirement; use npm 11.10+ only for lock work. Fork baseline has a known stale Sol `xhigh` test expectation while source says `max`.
- Native children active: `runtime-implementer` (`sub-a437962c`), `daemon-implementer` (`sub-f5e0922b`), `generated-model-implementer` (`sub-6b03ba0c`), `ui-mcp-implementer` (`sub-3e129265`). Resume exact implementer for accepted repairs; use fresh critics for independent review.
- Pre-dispatch repository state: new worktree clean except copied plan and this log; original worktree retains only the plan.

## Scope Ledger

| Item | Plan anchor | Scope disposition | Status | Code anchor | Proof | Review |
|---|---|---|---|---|---|---|
| Test plan | §11 | authorized | complete | plan §11 | structure check | cold plan review approved before test-plan addition; implementation review pending |
| Lineage-preserving merge | §1, §10 Phase 1 | authorized | conflict-free, uncommitted | MERGE_HEAD present; all 22 conflicts resolved/staged | `git diff --diff-filter=U` empty | full overlap/final review pending |
| CPython/process cutover | §8, §10 Phase 2 | authorized | in progress | ReplKernelManager lifecycle/repair + legacy deletes staged | 270 final Python tests + old snapshot restore + 17 real-runtime Node tests pass | review pending |
| Daemon/fork/generated/UI composition | §9, §10 Phase 3 | authorized | in progress | generated/model and UI/MCP slices resolved | 149 generated/model + 612 UI/TUI assertions and MCP E2E pass | generated and UI/MCP critics approved |
| Full proof and PR | §10 Phases 4–5, §11 | authorized | pending | — | — | — |

## Code Read Ledger

| Area | Files/symbols read | Why relevant | Fresh until | Notes |
|---|---|---|---|---|
| Plan and repository instructions | plan, root `AGENTS.md`, prior integration docs | binding scope and local rules | plan/instructions change | exact refs already mapped in planning pass |

## Proof Freshness Ledger

| Proof | Scope covered | Result/context | Fresh until | Rerun trigger |
|---|---|---|---|---|
| Baseline focused tests | stale Sol expectation plus daemon stop/MCP render | expected 2 failures in `sdk-thinking-defaults`; 46 other assertions passed | any baseline source/dependency change | compare candidate focused run |
| Old snapshot fixture | fork v1 per-name dill payload with scalar/container/module/function/class | created outside user state at `/tmp/prime-agent-upstream-cpython-old-snapshot-ec626e8fa`; dill SHA-256 `6cdc5b8c…` | fixture or restore contract changes | candidate restore smoke |
| Pinned model artifact | exact upstream generated seed plus owner-emitted Sol 1M block | deterministic transformation SHA-256 `72feddbb40…`; removing block restores seed `fd3c13075f…` | generator source or upstream pin changes | rerun alias/model tests; live full regeneration externally drifting |
| Dependency install | final merged npm lock | `npx --yes npm@11.19.0 ci` passed; 430 packages; 3 audit findings reported, no automatic changes | lock/manifests change | rerun clean install/CI |
| Generated/model focused tests | Sol/default/model resolver/registry/compaction/supports-xhigh + atomic bundle path | 149 passed, 2 skipped; hashes unchanged | owned model/generator/manifest/bundle paths change | remote CI still owns build-dependent runnable bundle case |
| Python runtime suite | `prime-agent-runtime` protocol/bash/MCP/Windows tests | final `uv lock --check` + `uv run --locked ...`: 270/270 passed | runtime source/pyproject/uv.lock changes | rerun after runtime repair |
| Old snapshot candidate restore | fork-v1 fixture through `python -m rlm.repl` protocol 3 | restored all six names; behavior result `(42, 8, 18)`; clean shutdown | snapshot/repl runtime changes | rerun after runtime repair |
| Node real-runtime proof | REPL state/parent-watchdog/MCP shutdown/bootstrap | 3 files/9 kernel-heavy + bootstrap 8/8 passed | kernel/runtime/bootstrap changes | fresh runtime critic pending |
| Interactive/TUI/MCP focused proof | interactive/settings/queue/ACP/Ctrl-X/Mermaid/public command/TUI markdown/MCP | 612 TypeScript/TUI assertions passed + one real MCP E2E pass; later identical E2E hit known 5s daemon-catalog startup timeout | UI/MCP/test-config/docs or daemon startup changes | rerun after daemon integration; fresh UI critic pending |
| Daemon/RLM focused proof | schema/client/mode/supervisor/recovery/eviction/ledger/routing/process | 526 focused assertions + 4 isolated process cases passed; parallel load failures reproduced green serially | daemon/RLM/routing paths change | rerun MCP E2E and final daemon smoke; fresh critic pending |
| Post-composition MCP E2E | real daemon + MCP HTTP/client with clean RLM/internal env | 1/1 passed in 60.43s | daemon/MCP/owned-worker/process paths change | remote process smoke still required |
| Final local static/type gate | Biome/tsgo/installer/browser + conflict/deletion/dependency scans | `npm run check` pass, no fixes; no unmerged/unstaged/markers/forbidden runtime/legacy files | any tracked code/doc/config change | rerun before commit if changed |
| Source CLI smoke | isolated source launcher version/help/MCP help | pass: 0.8.1, command registry, MCP trusted-network and both socket options; no service-tier option | launcher/CLI/manifest changes | remote build/bundle smoke remains |
| Ref verification | fork/upstream/base/divergence | pass: `ec626e8fa651da782e13ca4441fdc8a7255b1172`, `9f5edc192cfe3d4737205a2f551d2b6b6e34fe09`, `e319a66d7351c75abe7f040d02d9a8d6e25028e9`, 70/41 | either remote ref moves | next fetch |
| Plan structure | dedicated test plan and scope authorization | pass | plan changes | substantive plan edit |

## Continuous Review Ledger

| Finding | Source | Status | Repair anchor | Notes |
|---|---|---|---|---|
| IMP-RT-1 strict forced-cleanup authority | runtime critics + repair | repaired, final recheck pending | generation-bound exact-death journal + offline maintenance fence + canonical owned child | 77 focused + 176 supervisor + 103 kernel + 272 Python + full process proof green |
| IMP-RT-2 current shell-escape guidance | runtime critic + fresh recheck | closed | current docs/skill templates + `builtin-skills.test.ts` | 23/23 tests pass; recheck approved managed `bash()` vs supported interactive `!command` |
| IMP-RT-3 missing EOF/unexpected-exit proof | runtime critic + fresh recheck | closed | `test_repl.py` + `repl-kernel-startup.test.ts` | direct protocol/no-replay/single-repair/restore/lifecycle assertions independently approved |
| IMP-UI-1 root README `rlm()` result contract | UI/MCP critic + fresh recheck | closed | `README.md` admission-handle/asynchronous-results wording | independent recheck approved full UI/MCP/docs slice |
| IMP-DAEMON-1 saved-session target-path ownership | daemon final critic | open: passive owner/open barrier incomplete | daemon lifecycle/ledger owners | fresh read-only review |
| IMP-DAEMON-2 per-create session directory/ledger authority | daemon final critic | approved, contingent on side-door closure | daemon lifecycle/ledger owners | fresh read-only review |
| IMP-DAEMON-3 failed RLM tombstone display split-brain | daemon final critic | approved, contingent on side-door closure | daemon lifecycle/ledger owners | fresh read-only review |
| IMP-DAEMON-4 file delete tombstone ordering | daemon final critic | ordering approved; routed tombstone verification open | daemon lifecycle/ledger owners | fresh read-only review |
| IMP-DAEMON-5 incomplete subagent quiescence guard | daemon final critic | approved, contingent on side-door closure | daemon lifecycle/ledger owners | fresh read-only review |
| IMP-DAEMON-6 family/name directory scope | daemon final critic | approved, contingent on side-door closure | daemon lifecycle/ledger owners | fresh read-only review |

## Side Doors And Deletes

| Surface | Expected state | Current state | Status | Anchor |
|---|---|---|---|---|
| ZMQ/forkserver/IPython runtime | deleted/replaced | pre-merge live | pending | plan §7–8 |
| eager peer sync | deleted/replaced by pull peers | pre-merge live | pending | plan §7, §9.1 |
| CLI service tier | absent; `/fast` retained | absent at fork tip | pending post-merge proof | plan §5, §9.3 |

## Decision Carry-Through

| Decision | Owner | Plan carry-through | Code carry-through | Status |
|---|---|---|---|---|
| Sol default is `max` | final fork source | §5, §9.3, §11 | pending stale-test repair | approved |
| daemon schema union is revision 24 | protocol owner | §9.1 | pending | approved |
| no IPython compatibility runtime | ReplKernelManager/rlm.repl | §2, §8 | pending | approved |

## Pass Notes

### 2026-08-31 — Intake and worktree

- Intent: add a dedicated test plan, isolate implementation, preserve exact merge topology.
- Changed: canonical plan updated; integration worktree and implementation log created.
- Read: plan-implement doctrine, repo instructions, approved plan.
- Proof: refs/divergence unchanged after fetch; upstream tag collision bypassed with an explicit `upstream main` fetch.
- Review: cold plan review had approved prior plan; no implementation review yet.
- Next: bounded baseline and no-commit merge.

### 2026-08-31 — Merge dispatch

- Intent: execute the actual lineage-preserving merge and resolve by canonical owner.
- Changed: MERGE_HEAD created; upstream automatic changes applied; 22 conflicts match the approved plan.
- Read: root Git/testing rules; full conflict inventory.
- Proof: baseline focused run had exactly two known Sol `xhigh` expectation failures; daemon-stop-confirm and MCP render files passed (46 passing assertions total).
- Review: four clean native implementers received non-overlapping file ownership and no-stage/no-commit constraints.
- Next: integrate each return, inspect shared state, and close remaining conflicts without broad staging.

### 2026-08-31 — Generated/model slice closed

- Intent: compose release manifests, dependencies, generated catalog, fork defaults, and bundle publication.
- Changed: v0.8.1 manifest/lock union, pinned upstream catalog plus owner-emitted Sol 1M alias, merged generator, zeromq removal, MCP/Mermaid retention, stale Sol test repair.
- Proof: deterministic pinned transformation; two stable npm lock runs; uv lock check; 149 focused assertions passed, two skipped; atomic bundle publication case passed. Runnable bundle entrypoint stays for remote build/CI because local build is forbidden.
- Review: parent spot-checked manifest, lock, generator markers, exact one-block generated diff, and worker receipts.
- Next: preserve proof until an owned path changes; fresh generated-artifact critic approved with no blocking findings.

### 2026-08-31 — Runtime/process slice closed

- Intent: replace IPython/ZMQ/forkserver with CPython while retaining fork lifecycle and process safety.
- Changed: ReplKernelManager lifecycle/env/stderr/repair/no-replay port; orphan/daemon-ps composition; legacy source/test deletion; targeted regressions.
- Proof: final 270 Python tests, 101 initial focused assertions, 17 real-runtime Node assertions, old snapshot restore/execution, scoped Biome and diff checks all pass.
- Review: parent spot-checked the ReplKernelManager upstream delta, lifecycle symbols, exact deletes, and marker-free files; fresh independent runtime critic next.
- Next: retain proof until kernel/runtime/process files change.

### 2026-08-31 — Generated slice independent review

- Finding status: no blocking findings.
- Verdict: approve for plan §§9.3–9.4 and TP-01/TP-08/TP-11.
- Proof remains fresh until generator/catalog/manifests/locks/default/model/bundle paths change.

### 2026-08-31 — Interactive/TUI/MCP slice closed

- Intent: compose upstream derived UI state/Mermaid/ACP behavior with fork Ctrl-X, usage, FAST OFF, effort, MCP, test config, and current docs.
- Changed: resolved interactive/startup/vitest conflicts; MCP state/render/empty resume hardening; public daemon-socket alias proof; evergreen docs and resolved bug status.
- Proof: 612 focused TypeScript/TUI assertions and one full real MCP E2E passed; a later identical E2E hit the pre-scenario 5s daemon-catalog startup timeout and is assigned to daemon ownership.
- Review: parent spot-checked marker-free files, exact tool surface, test config, scoped diff; fresh independent UI/MCP critic next.
- Next: rerun MCP E2E after daemon slice and preserve proof until UI/MCP paths change.

### 2026-08-31 — Daemon/RLM slice closed

- Intent: compose schema/client/supervisor/session behavior and fork recovery/routing/ledger contracts.
- Changed: schema 24/digest/capability union; on-demand peers; eager-sync deletion; spawn/lifecycle/rename/exact-once/cross-daemon composition; targeted compatibility/routing tests.
- Proof: 526 focused assertions and four isolated real-process cases passed; parallel shared-host overload failures all passed serially without source changes; scoped Biome/diff/marker checks pass.
- Review: parent spot-checked schema constant/digest/min revision/capability, both hello consumers, eager-sync absence, marker-free files; fresh independent daemon critic next.
- Next: rerun MCP E2E after conflict closure, then full static/check and final review.

### 2026-08-31 — Runtime independent review blockers

- Verdict: not approved.
- Opened: IMP-RT-1 strict forced cleanup, IMP-RT-2 stale kernel shell-escape instructions, IMP-RT-3 missing EOF/unexpected-exit regressions.
- Scope: all three are authorized by plan §8 and TP-02–TP-05.
- Next: two bounded repair workers; rerun focused proof; fresh replacement critic.

### 2026-08-31 — IMP-RT-2 repair

- Changed: three current Python instruction surfaces now use `await bash(...)`; supported interactive `!command` docs remain.
- Proof: `builtin-skills.test.ts` 23/23, scoped Biome/diff/static scans pass.
- Review: parent spot-checked exact diffs; fresh combined runtime recheck will close the finding.

### 2026-08-31 — IMP-UI-1 repair

- Changed: root README now says `rlm()` returns an admission-time child handle and answers arrive asynchronously through messages/files.
- Proof: direct contract comparison with AgentSession/current prompt/runtime docs; diff check passes.
- Review: fresh final docs/contract recheck required before approval.

### 2026-08-31 — Text-clean overlap review

- Coverage: 27/27 Appendix B text-clean overlaps reviewed against base/fork/upstream/current.
- Result: 26 approve; TC-1 blocks `owned-session-worker.ts` orphan cleanup.
- Disposition: authorized extension of existing IMP-RT-1, not new scope.
- Required repair: strict all-generation candidates, preserve journal on parse/identity/kill uncertainty, clear only when every tree is proved gone, focused owned-worker regression.

### 2026-08-31 — UI/MCP fresh recheck

- IMP-UI-1: closed.
- Verdict: approve full repaired UI/MCP/docs slice; no remaining authorized blockers.
- Proof remains fresh until README, interactive/TUI/MCP/current-doc paths change.

### 2026-08-31 — IMP-RT-1 / IMP-RT-3 repair completion

- Changed: canonical strict orphan candidate authorization/reap/death proof shared by daemon and owned-session cleanup; all-generation re-read before journal clear; whole-group termination; EOF and ready-runtime unexpected-exit regressions.
- Proof: initial 43 Node + 96 Python, then 36 daemon/orphan + 5 owned-session + 8 owned-session process assertions passed; scoped Biome/diff checks pass.
- Review: parent spot-checked canonical helper/callers/tests; fresh runtime replacement critic required to close IMP-RT-1/2/3 and TC-1.

### 2026-08-31 — Runtime fresh recheck #1

- IMP-RT-2: closed/approved.
- IMP-RT-3: closed/approved.
- IMP-RT-1/TC-1: remains open with three same-contract side doors:
  1. daemon supervisor recovery/reclaim/forced-stop still uses permissive current-generation cleanup and deletes authority artifacts;
  2. owned-session exit/finalizer callers ignore strict-helper failure and may restart/delete recovery authority;
  3. strict cleanup treats a missing authority journal as vacuously clean.
- Required repair: one canonical strict all-generation owner; propagate uncertainty through every destructive caller; initialize authority at launch and fail closed on later ENOENT; caller-level regression proof.

### 2026-08-31 — Daemon/RLM independent review

- Verdict: blocked with five in-scope composition defects.
- Findings: target-path ownership routing; per-create directory/ledger authority; display-vs-ledger delete split-brain; physical-delete/tombstone ordering; incomplete subagent busy projection.
- Repair sequencing: wait for active strict-cleanup edit on `daemon-supervisor.ts`, then assign one daemon owner to avoid concurrent same-file edits.

### 2026-08-31 — Daemon blocker repair design

- Independent read-only design confirmed all five findings and a narrow owner map.
- IMP-DAEMON-1: canonical-path mutation reservation; opener/owner recheck; forward to target summary, never caller identity; fail on stopping/recovering owner; detached commands carry directory context with wire-compatible fallback.
- IMP-DAEMON-2: active list uses owner descriptor directory; supervisor ledger instances keyed per sessions directory; thread target/create directory through catalog/name/ledger operations.
- IMP-DAEMON-3: retain display-first/delete-ledger ordering but a live ledger edge coerces stale display `deleted` to visible terminal/retryable state.
- IMP-DAEMON-4: append saved-session tombstone only after physical delete reports success; missing file remains successful/idempotent repair.
- IMP-DAEMON-5: use existing authoritative `isActiveSessionBusy()` projection, including recursive RLM descendants, with existing TOCTOU recheck.
- Sequencing rule: do not let mutation routing reclaim or treat strict-cleanup uncertainty as offline.

### 2026-08-31 — IMP-RT-1 strict-authority repair #2

- Added: explicit authority initialization and one `reapOrphanProcessAuthority()` SSOT with strict all-generation read/re-read and exact tree-death proof.
- Routed: daemon CLI stop/tombstone, supervisor recovery/reclaim/stop/finalization, and owned-session exit/finalizer/restart gating.
- Failure contract: missing/malformed/unreadable/PID-only/identity/kill/group uncertainty retains descriptor, recovery, and orphan authority and blocks replacement/destructive cleanup.
- Proof: 191/191 across seven affected Vitest files; scoped Biome and diff checks pass.
- Parent review: production diffs spot-checked and staged; final fresh review waits until daemon routing edits settle.

### 2026-08-31 — IMP-DAEMON-1..5 repair

- Added canonical target-path mutation reservation and opener/owner/source/detached routing; active-context offline operations preserve source-worker bookkeeping.
- Made active catalogs and supervisor ledgers explicit per resolved sessions directory; descriptor stores resolved directory.
- Made live ledger edges override stale display deletion projection, physical saved-file success precede tombstones, and RLM child deletion use recursive authoritative busy projection.
- Protocol remains v7/schema revision 24; compatible optional detached mutation context changes source-shape ID to `protocol-7-schema-24-cf403cedeb44`.
- Proof: 261/261 across daemon mode/protocol/supervisor/ledger/saved-catalog files; scoped Biome and diff checks pass.
- Parent review: production diffs and active-context source follow-up spot-checked and staged; fresh daemon and runtime reviews required.

### 2026-08-31 — Post-daemon focused proof

- `npm run check`: pass, no fixes.
- Nine exact daemon/runtime unit files: 407/407 pass.
- Owned-session real-process file: 9/9 pass.
- Daemon-supervisor process file first full run: 8 pass, 2 cleanup-timing failures, 8 skipped. Both failing cases immediately passed in isolated reruns (top-level depth and adopted-worker shutdown). No test-owned process remained afterward. Full-file clean rerun remains required before commit; do not count first full run as green.

### 2026-08-31 — Daemon fresh recheck #1

- IMP-DAEMON-1: closed.
- IMP-DAEMON-3 projection rule: code shape approved, contingent on correct directory ledger.
- Remaining blockers:
  1. worker `rlmSpawnLedger()` still keys startup defaults instead of resolved per-create directory;
  2. old-v7 missing nested-child retry guesses `dirname(child)` and can report success without tombstoning the real edge;
  3. root family/name scope mixes per-directory catalogs with global peers/reservations;
  4. RLM child delete lacks a fence that blocks work admission through async persistence/close.
- Protocol source-shape ID `protocol-7-schema-24-cf403cedeb44` independently recomputed correct.

### 2026-08-31 — Runtime final recheck #2

- IMP-RT-2 and IMP-RT-3: closed.
- IMP-RT-1/TC-1 remains blocked:
  1. strict cleanup drops `active:false` after signal delivery without exact tree-death proof; TS/Python writers can recreate a missing journal and erase the authority gap;
  2. CLI exact-dead tombstone deletion is not mutually exclusive with supervisor `retry_worker`/relaunch;
  3. owned-session current child uses a POSIX-only side path and is absent from canonical authority on Windows/setup failure.
- TP-04 remains open only on process-retirement authority; TP-05 remains open.

### 2026-08-31 — Daemon process harness proof repair

- Diagnosis: repeated full-file failures came from test teardown clearing ownership sets and deleting temp state before owned process exit; isolated behavior was green and no production process remained.
- Test-only repair: snapshot owned children/PIDs, TERM/CONT, await exact exit, bounded KILL fallback, then remove temp state. Adapted the relevant idea from later upstream `87e154ad7` without cherry-pick or production change.
- Proof: full `daemon-supervisor-process.test.ts` 10 passed / 8 skipped in 30.72s; zero captured identities or test temp roots remained; scoped Biome/diff pass.
- Disposition: process-proof checkbox may count green unless later daemon/runtime edits invalidate it.

### 2026-08-31 — Runtime authority repair design #3

- Journal owner: monotonic initialized authority generation; post-init writers never create; signal delivery is not retirement; strict read/re-read retains unproved identities until exact tree death. Legacy false records remain unproved hints, not authority erasure.
- CLI/supervisor exclusion: extend cross-platform supervisor ownership registry with scoped offline-maintenance lease; live supervisor means CLI skips/delegates, CLI-first lease blocks startup/retry until exact cleanup; do not use disruptive global shutdown admission.
- Owned worker: capture PID/start identity at spawn and pass current child as canonical `additionalCandidate` on every platform; remove POSIX side reaper; replacement/finalizer cannot clear or respawn before proof.
- Implementation sequence: wait for daemon authority repair, then re-read supervisor files and apply the smallest compatible record/generation protocol plus exact regressions.

### 2026-08-31 — Daemon authority repair #2

- Worker ledger binds immutably to resolved root create directory; recovery/drift/list/family/passivation use the same directory.
- Old-v7 missing nested delete uses bounded, meta/hash-validated unique ledger discovery; wrong/absent/ambiguous authority fails closed; tombstone is verified.
- Peer list, active/saved catalogs, name reuse/validation, and in-flight reservation use one per-ledger-directory family scope.
- Reference-counted RLM family deletion fence covers direct/descendant selectors and all work admission through persistence and close, with busy/error release.
- Proof: 272 focused + 175 related = 447/447; tsgo, scoped Biome, and diff check pass.
- Parent spot-check: production owner diffs reviewed and staged; fresh daemon critic still required after runtime authority edits.

### 2026-09-01 — IMP-RT-1 / TC-1 authority repair #3 implemented

- Journal authority: v2 files now start with a durable random generation header and global monotonic sequence; TS and Python writers share an exclusive append lock, never create configured authority, reject replacement/gaps/torn tails, and append retirement only after exact identity/tree death. Legacy-v1 inactive records remain non-erasing hints, and unbound descriptors cannot adopt a v2 replacement.
- Lifecycle: daemon and owned recovery descriptors persist the generation; generic CLI/shell/helper children scrub it, while only daemon workers and their REPL children receive the bound pair. Kernel, detached-shell, and Python bash writers use explicit enroll/retire transitions.
- Cleanup fencing: exact-dead CLI tombstone cleanup holds a renewable socket+descriptor-directory offline-maintenance lease through final rechecks and unlink; same-scope supervisor acquisition and global shutdown admission are mutually exclusive with it. Supervisor deletion now propagates clear failure and retains its in-memory/durable recovery owner.
- Owned worker: every spawned child is captured immediately as a PID/start-id `additionalCandidate` on all platforms; missing identity fails closed, and recovery/finalization keeps authority until canonical cleanup proves death.
- Proof: 73 exact journal/ownership/CLI/owned/real-REPL tests, 102 supervisor-monitor tests, 103 kernel/tool tests, 10 daemon-supervisor process tests (8 stress-gated), and all 271 Python runtime tests passed. Root `tsgo --noEmit`, scoped Biome, `uv lock --check`, `py_compile`, and `git diff --check` passed.
- Preserved unrelated state: four daemon-mode passive-family expectations still fail against the pre-existing unstaged daemon ledger/directory work (`discovers a non-resident child`, `reports failed passive children`, `validates a requested passive child name`, `rehydrates a legacy passive subagent`). This repair did not alter that family-routing block.

### 2026-08-31 — Passive-family fixture closure

- Root cause: `makePersistedRlmDaemonFixture()` inherited this RLM child process's `RLM_DEPTH=1`, contradicting hard-coded child/grandchild depths; production supervisor already scrubs the variable.
- Test-only fix: root session explicitly uses `{ rlmDepth: 0 }`.
- Proof: four formerly failing cases pass 4/4 under adversarial `RLM_DEPTH=1`; full `daemon-mode.test.ts` passes 187/187 with internal env scrubbed.
- No production ledger/directory/family behavior changed.


### 2026-09-01 — Runtime authority parent spot-check edge closure

- Cross-runtime append lock: TS and Python now publish the same atomically hard-linked JSON lock record (`ownerPid`, exact `processStartId`, random `token`, creation/expiry). An expired lock is reclaimed only when its exact owner is proven gone, with a final token recheck; live, uncertain, malformed, fresh, or replaced locks remain fail-closed. Added live-owner and crashed-owner regressions in both runtimes.
- Legacy upgrade transaction: supervisor recovery persists a prepared generation in the existing durable descriptor from inside the journal lock before appending the v2 header. Descriptor-first interruption, cancellation, torn upgrade retry, and later spawn failure reuse the same generation; an unbound descriptor still cannot adopt an existing v2 file.
- Owned-worker spawn identity: the frontend now awaits the ChildProcess `spawn`/`error` result before reading PID/start identity, installs the PID candidate before start-id lookup or stdio setup, and retains that candidate on setup uncertainty. Added delayed-spawn coverage and reran the real owned-worker process suite.
- Old-supervisor fence: each offline-maintenance lease is backed by a valid, exact-identity `*.owner` compatibility record with `purpose: offline-maintenance`; renewal/release owns both records. New supervisor acquisition recognizes the compatibility owner, waits boundedly for release, and still permits unrelated scopes. Tests prove the owner-only fence works after the new lease directory is hidden.
- Proof: 77 focused authority/ownership/CLI/owned/REPL tests, 176 daemon protocol/supervisor tests, 103 kernel/tool tests, daemon-supervisor process 10 passed / 8 stress-gated, and all 272 Python tests pass. Root `tsgo --noEmit`, scoped Biome, `uv lock --check`, `py_compile`, and `git diff --check` pass.

### 2026-08-31 — Runtime authority implementation #3

- Added generation-bound v2 authority with strict sequence/state reduction, cross-runtime append serialization, no-create configured writers, exact-death retirement, legacy-v1 conservative reduction, and strict same-generation cleanup/clear.
- Added renewable scoped offline-maintenance ownership visible to old and new supervisor ownership scanners; same-scope startup/retry excluded, unrelated scopes available, global shutdown remains mutually exclusive.
- Owned frontend waits for actual spawn, captures PID/start identity before setup, and passes current child through canonical cross-platform cleanup.
- Parent edge closure: expired dead append locks recover by exact owner identity; legacy upgrade persists descriptor generation before header/failure boundary; maintenance publishes old-compatible owner; supervisor acquisition waits boundedly.
- Proof: 77 authority/ownership/CLI/owned/REPL + 176 daemon + 103 kernel/tool; daemon process 10 pass/8 gated; Python 272/272; tsgo/Biome/uv-lock/py_compile/diff pass. No test process remained.
- Parent spot-check: journal/lease/upgrade/spawn owners reviewed and all 24 changed files staged. Fresh independent runtime/process and daemon reviews required.

### 2026-08-31 — Daemon final recheck #2

- Closed/approved shapes: immutable sessionDir binding, live-edge display authority, physical-delete ordering, recursive busy predicate, per-directory family/name/peer scope, protocol/schema/exact-once routing.
- Remaining authorized side doors:
  1. passive target summaries route to nonresident IDs and worker hydrate/open lacks a canonical-path mutation barrier;
  2. RLM deletion fence is command-local, bypassed by Python/direct/cancellation cleanup, and can release before asynchronous cleanup settles;
  3. worker-routed nested delete lacks authoritative edge preflight/post-tombstone verification;
  4. concurrent first ledger writers can duplicate/omit meta and make later old-v7 discovery reject unique authority.

### 2026-08-31 — ACP kernel environment diagnosis

- One kernel-heavy failure loaded `agent_message` from the main checkout via the managed venv's editable path; that old IPython implementation printed its MIME dict under direct CPython.
- Control with this worktree's `prime-agent-runtime/src` plus bundled `skills/agent-message/src` yields clean JSON stdout and one structured `sentAgentMessages` event.
- Disposition: environment contamination, no production/test extraction change. Final kernel run must put all target worktree skill sources first on `PYTHONPATH`.

### 2026-08-31 — Runtime final recheck #3

- Reopened IMP-RT-1/TC-1 for host-side `AgentSession.executeBash`: user shell starts before durable enrollment; Windows host cleanup uses `taskkill`/leader liveness rather than atomic non-breakaway Job containment and exact job-empty proof.
- Reopened maintenance/shutdown lease durability: 5s event-loop renewal can expire during a 10s synchronous Windows cleanup; identity observation uncertainty is currently reclaimed rather than retained.
- Reopened TP-11 prompt wording only: CPython Windows `bash()` is Job-contained and refuses unsafe spawn; `taskkill` is fallback, not the primary contract.

### 2026-08-31 — Adversarial process-authority review #2

- FAIL findings accepted for repair/strict disposition:
  1. POSIX legacy PID-only candidates are signaled despite identity uncertainty; must retain unless PID+group are absent.
  2. TS/Python stale append-lock token check then pathname unlink has a replacement TOCTOU; needs per-token exclusive reclaim arbitration and cross-runtime contention proof.
  3. Live exact lease owners can be stolen on wall-clock expiry/event-loop stalls; exact live or uncertain identity must retain authority and lock compromise must block commit.
  4. New maintenance/shutdown claims are not mirrored into the pre-move legacy registry.
  5. process identity helpers are PATH-resolved, unbounded, env-leaking, and macOS identity is coarse; use absolute bounded scrubbed observation and fail closed where exactness unavailable.
  6. REPL, legacy owned worker, and Python BashHandle support setup have pre-enrollment/pre-commit execution windows.
  7. cleanup clears orphan authority before durable cleanup state/artifact deletion; crash loses proof.
  8. asynchronous worker registration failure leaks initialized header-only journal/candidates.
  9. force cleanup lacks tombstone cleanup's canonical descriptor-path validation/reread.
- Windows Job mocks remain local static proof; real Windows containment stays a required CI gate.

### 2026-09-01 — TP-04 Bash pre-release gate closed; REPL/owned gating paused

- BashHandle now starts pump, report, and watch threads before the POSIX gate byte or Windows Job resume. Any setup/thread-start failure aborts containment, joins started observers, waits for exact death, and retires authority only after proof. A constructor decision event prevents observer teardown races.
- Added POSIX failpoints for each of the three `Thread.start()` positions plus Windows ordering and third-thread failure proof. Markers never ran before commit; Windows never resumed after setup failure.
- Proof: focused `test_bash.py` 60/60; full Python runtime 274/274; `py_compile` and scoped `git diff --check` pass.
- Unclaimed dependency state: tokenized persistent pre-exec wrappers are present in `repl-manager.ts` and `owned-session-worker.ts`, with target/setup marker tests in their focused suites. On macOS, host-side `enrollOrphanProcess()` still fails before append because the journal write lock requires an exact identity for the ordinary host writer, which is intentionally only `ps:` coarse. Focused REPL proof therefore remains blocked at `acquireJournalWriteLock()`; no target marker ran. The journal owner must land coarse-writer fail-closed lock handling before this slice can resume and be claimed.


### 2026-09-01 — Daemon final recheck #2 side-door closure implemented

- Passive mutation/open: worker routing now uses a resident root/source active context while preserving the passive target's canonical session path; attach, reattach, and A2A hydrate by canonical path, attach coalesces that load, and the returned resident active ID becomes supervisor cache/client identity. Worker rename/delete and create/hydrate/passivate share canonical-path mutation/open barriers, including failure propagation for a selector lookup that raced a mutation.
- Deletion lifecycle: `SubagentRuntimeHost.withRlmSubagentDeletion` owns a ref-counted family fence. Direct Python deletion, inactive daemon deletion, cancellation/revocation, nested active-run cleanup, recursive close, artifact cleanup, busy skips, and error paths keep one admission boundary through actual cleanup. A running-child Python delete may return accepted while the nested cleanup holder remains fenced.
- Worker-routed nested deletion: the worker requires a unique ledger child edge whose parent chain reaches the resident worker context before physical deletion, then verifies the exact child/parent edge is tombstoned. Missing/wrong-parent authority fails closed; an existing tombstone stays idempotent; root deletion behavior is unchanged.
- Ledger metadata: append recovers an empty crashed-first-writer file, fsyncs ownership metadata before data, accepts only canonically identical duplicate ownership metadata at the correct hashed path, and fails reads/discovery/appends closed on zero, conflicting, or path-mismatched metadata.
- Changed owners: `src/core/{agent-session,rlm-runtime}.ts`, `src/modes/daemon/{daemon-mode,daemon-supervisor,rlm-ledger}.ts`, and their exact recursion/daemon/supervisor/ledger tests.
- Proof: exact daemon/supervisor/ledger files 254/254; related reattach/input-pause 10/10; direct Python lifecycle targets 2/2. Full recursion was 111/111 before the final two focused additions; a later full rerun passed 111 cases and was blocked only by a concurrent out-of-scope generated-JS newline defect in `repl-manager.ts`. Scoped Biome and staged+unstaged diff checks pass.
- Static proof/blocker: scoped Biome and staged+unstaged diff checks pass. Root `tsgo --noEmit` passed once after concurrent shell fan-in, then a later out-of-scope edit reopened seven errors in `daemon-supervisor-ownership.ts` (one import/local conflict and missing `getProcessStartId` references); parent owns the composed rerun. The separate out-of-scope `repl-manager.ts` generated-JS newline blocker remains for the parent's recursion rerun. No protocol/schema change and no staging performed.

### 2026-09-01 — Daemon worker cleanup proof and failed-launch authority hardening

- Added an internal optional cleanup proof (`cleanup-proven` → `journal-cleared`) without changing daemon schema revision 24 or worker protocol 7. Malformed optional proof is stripped and treated as cleanup-required; matching proof is bound to the worker token, exact/coarse identity quality and hint, PID, canonical artifact paths, root/owner/session authority, and durable stop intent.
- Added the shared `daemon-worker-cleanup.ts` owner for canonical/no-follow descriptor and artifact validation, atomic descriptor write + file/directory fsync, fresh owner/descriptor/fingerprint checks before every signal and destructive mutation, journal-inode binding around reaping, strict journal clear, socket/recovery removal, and descriptor-last deletion. Interrupted cleanup resumes from durable proof; a changed authority discards or invalidates proof and re-proves; missing journals are accepted only with matching durable proof.
- Routed supervisor stop/reclaim/rollback and `daemon-ps --force`/exact-dead tombstone cleanup through the same proof-backed helper. PID-only or coarse-live identities never authorize a signal. Exact-different/absent leaders count as retired only when the applicable tree/group proof is empty. Windows cleanup remains retained without real job/tree-empty proof.
- Hardened launch failure handling for synchronous/asynchronous spawn errors and post-publication persistence failures. Pre-registration cleanup keeps the journal until socket/recovery residue is gone, then clears it last. Startup sweep removes only canonical exact-dead candidate/claim/temp residue and unreferenced header-only journals, with fresh supervisor ownership and inode checks before each unlink. Main journal locks stay under the journal protocol’s token-claim arbitration; live, malformed, replaced, symlinked, or ambiguous residue is retained.
- Tests added/updated: crash interruption after stop-tombstone/proof/journal/socket/recovery phases; missing-journal with/without proof; changed-field re-proof; authority replacement before both signals and each mutation; malformed proof; canonical/symlink/fake/real Unix-socket policy; exact-dead/live startup residue; ownership and inode replacement races; failed launch before/after descriptor publication; daemon force PID-reuse/PID-only/group retention behavior.
- Proof: `daemon-worker-cleanup`, `daemon-ps`, `daemon-protocol`, and `daemon-supervisor-monitor` pass 187/187 together; six adjacent supervisor eviction/lazy, daemon-mode/session-list, ownership, and orphan-journal suites pass 314/314. Scoped Biome is clean. Root `tsgo --noEmit` passes on the composed worktree after the concurrent gate owner repaired its final tuple-index errors.
- External composed blocker: the lease/registry owner repaired the real-process fixture's missing exact supervisor identity and then isolated its registry per `agentDir`; depth-zero create passes in 2.6s and a later create reaches its unrelated passive-attach assertion without lock contention. A targeted client-owned real-process cleanup reached process death and descriptor removal, then failed only when the final shutdown request closed its client before a response. A full process rerun is still pending for the remaining shutdown-close, passive, and adoption assertions. No process remained after the diagnostic runs.
- Scope hygiene: no edits to ownership/session-lease, orphan-journal, contained/autonomous, or owned-session-worker owners; no staging, reset, commit, or external agent launch.


### 2026-09-01 — Daemon real-process cleanup/adoption follow-through

- Classified the initial scrubbed process failures instead of treating them as cleanup regressions. Explicit shutdown/restart can close the socket with the matching durable `daemon_closing` reason before the request promise receives its success frame; process tests now accept either the success response or the exact expected `shutdown` / `update` close reason, then continue to verify socket/process/artifact outcomes. The duplicate-path shutdown, empty restart, and explicit archive shutdown cases pass 3/3 under a scrubbed environment.
- Repaired passive attach through the existing host-owned open path. A passive match is re-read under the shared saved-session-path mutation barrier, must remain uniquely owned by the same resident worker, and is opened with that worker summary's exact declared session-file spelling before attach is forwarded to the returned resident active ID. The canonical path remains the comparison and reservation authority; retaining the owner-declared spelling avoids `/var` versus `/private/var` duplicate active/passive rows on macOS. Concurrent passive attaches share one open authority rather than creating a second path owner.
- Strengthened process harness readiness: replacement adoption waits for the exact original worker PID set instead of treating a socket that accepted during `DaemonSupervisor.start()` as fully adopted, and restart resync waits for both `session_resynced` and connected status.
- Hardened worker process identity at spawn: every worker receives a parent-held delimiter-bounded argv0 owner token, and the descriptor persists that exact `token:` start identity instead of accepting a coarse or missing Darwin observation. The launch monitor asserts the marker shape; the real-process case asserts the descriptor token is exact and observable on the live worker PID.
- Exact passive regression passes in both the supervisor unit test and scrubbed real-process test. The five cleanup/protocol/CLI/supervisor/lazy suites pass 221/221 (the original cleanup-focused four remain 187/187).
- Remaining composed dependency at this checkpoint: descriptors load and adoption runs, but each worker rejects replacement `worker_auth` as `supervisor_generation_stale`. The hidden cause was exposed once and then the instrumentation was reverted: worker-side `assertDaemonSupervisorOwnerCurrent` reports the replacement generation's registry record missing or replaced in the exact custom registry. That also explains the adopted client-owned disposal failure: `dispose()` cannot deliver `complete_owned_session` through the rejected replacement, so its worker remains alive. The lease/registry owner is repairing that owner-current check; this slice does not edit ownership or lease code.

### 2026-09-01 — Daemon cleanup proof final process closure

- Closed both alternate supervisor-launch side doors without weakening remote worker authentication. Worker-led recovery in `daemon-mode.ts` and explicit restart/update in `daemon-supervisor.ts` each create a fresh 256-bit `createProcessIdentityOwnerToken()` immediately before spawn and pass it only through `argv0`. Normal args and environment remain token-free.
- Added generated-token, spawn-option, and live process-observation regressions for both replacement paths. Real-process restart/adoption also requires the replacement supervisor's hello identity to be a live matching `token:<64 hex>` identity. Worker descriptors likewise require an exact live parent-issued token identity.
- Replacement readiness requires equality with the original worker PID set. With exact replacement ownership restored, isolated worker adoption, adopted client-owned disposal, and chunked snapshot restart/resync all pass. Resync requires both `session_resynced` and connected status.
- Expected shutdown/update socket-close ordering is accepted only for the exact matching durable close reason. Shutdown proof now also waits for the advertised supervisor PID to exit, preventing detached process writers from racing test-directory removal.
- Preserved daemon schema revision 24 and protocol version 7.
- Final proof: the full scrubbed `daemon-supervisor-process.test.ts` passes 10/10 enabled cases with 8 stress cases skipped; the five cleanup/protocol/CLI/supervisor/lazy suites pass 223/223; the other five adjacent daemon/orphan suites pass 292/292; and the exact ownership reclaimer regression passes 1/1 alone. Root `npx tsgo --noEmit`, scoped Biome, and `git diff --check` pass. No matching daemon or fixture test process remains.
- Composed adjacent note: the six-file parallel run passes 320/321. Its only failure is the ownership-owned concurrency test `lets one of two exact-dead reclaimers publish a successor that the other cannot remove`, where `canonicalGuard` can still exist immediately after `winnerExit`; the same case passes alone 1/1. This file and guard-release timing remain outside the cleanup slice and were reported to its owner and the parent.


### 2026-09-01 — Final upstream v0.9.1 update and ship boundary

- Preserved the completed fork-first/upstream-second v0.8.1 merge as `6425ab4d4a618115349a0288467898d00fc99bc4` with parents `ec626e8fa651da782e13ca4441fdc8a7255b1172` and `9f5edc192cfe3d4737205a2f551d2b6b6e34fe09`.
- Fetched official v0.9.1 at `81ae3cb34d27d38ee37f9e205a1e73694993b344` and merged its 20 additional commits normally on top. Conflict resolution retained the CPython runtime and exact-authority work while adding upstream roster push, direct session transport, saved-catalog loading, update relaunch, snapshot, trace-flush, and startup/recovery fixes.
- Final daemon wire remains protocol 7 and advances to schema revision 26, ID `protocol-7-schema-26-fac530c4c6dd`.
- Startup-pragmatism cut: existing focused green receipts were accepted. No more duplicate focused suites or optional fixture work will run. The remaining validation is one repository-required `npm run check`, Git ancestry, and PR CI for native Windows.
- Deployment limits: process-authority state is local to one host and PID namespace; Linux observational identity is boot-qualified but not a held pidfd; exact-authority lifecycle support is Linux, Windows, and macOS. Native Windows Job behavior remains a CI requirement.
- Final repository validation: `npm run check` passed on v0.9.1 (Biome, `tsgo`, installer render, browser smoke).
- Real AIM launch canaries used the current source tree and isolated agent/socket directories. `aim prime run codex` selected `gpt-5.6-sol` and returned `AIM_CANARY_OK`; `aim prime run claude` selected `claude-fable-5-1` and returned `AIM_CANARY_OK`. Both isolated daemons shut down cleanly.
