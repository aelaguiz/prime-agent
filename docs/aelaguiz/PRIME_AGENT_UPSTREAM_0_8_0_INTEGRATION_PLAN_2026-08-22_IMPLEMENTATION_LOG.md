# Prime Agent Upstream 0.8.0 Integration Implementation Log

Plan: <code>docs/aelaguiz/PRIME_AGENT_UPSTREAM_0_8_0_INTEGRATION_PLAN_2026-08-22.md</code>
Audit log: none yet; create the matching plan-audit ledger for Phase 4 findings/verdict
Active scope: whole approved plan through local deterministic proof, isolated AIM-managed Claude/Codex canaries, draft PR, and CI; stop before merge approval
Scope contract anchor: plan Sections 1, 6-9, and the 2026-08-23 execution-boundary/canary approval
Scope status: approved
Last updated: 2026-08-23
Current checkpoint: the pinned upstream tree is semantically composed in the uncommitted two-parent merge on <code>integrate/upstream-0.8.0-20260822</code>; all deterministic local checks are green; next freeze the merge commit, then run isolated source/TUI and AIM Claude/Codex canaries

## Resume Snapshot

- Current state: exact fork/upstream/AIMGR pins remain frozen; all six predicted conflicts are resolved; all 24 overlapping paths are audited; released 0.8.0 changelogs are upstream-identical; generated models are reproducible; the post-repair TypeScript/Python matrix and root check are green; the merge is intentionally still uncommitted while this log is finalized.
- Next useful move: explicitly stage reviewed paths, inspect the complete staged merge, create the two-parent merge commit, and record its identity before isolated runtime canaries.
- Do not redo unless stale: frozen refs, dependency bootstrap, six conflict resolutions, 24-path audit, model generation, local deterministic matrix, root check.
- Known blockers: none.
- Native children used or useful next: none; repository/session policy does not authorize subagent fanout for this run.
- Pre/post-dispatch repository-state check: not applicable; no children.

## Scope Ledger

| Item | Plan anchor | Scope disposition | Status | Code anchor | Proof | Review |
| --- | --- | --- | --- | --- | --- | --- |
| Freeze exact fork/upstream/AIMGR inputs | Sections 2-3, Phase 0 | authorized | complete | Git refs below | fetch/rev-list receipts | direct |
| Baseline fork contracts | Phase 0 | authorized | complete | existing fork tests | 955 passed; 9 reproduced baseline failures in three files | direct |
| Two-parent upstream merge | Phase 1 | authorized | composed, commit pending | six conflicts/24 overlaps | no unmerged paths or conflict markers | direct |
| Protocol 7/schema 23 union | Section 6.1 | authorized | complete | daemon protocol and connections | digest/schema/capability tests | direct |
| Kernel/forkserver composition | Sections 6.2-6.4 | authorized | complete | kernel owner/forkserver | focused, adjacent, heavy, and Python runtime tests | direct |
| Generated model/catalog union | Section 6.5 | authorized | complete | model generator/output | two identical generation hashes plus model/provider tests | direct |
| UI/changelog/version composition | Sections 6.6 and 8 | authorized | complete | summary tile/fragments/manifests | UI tests, upstream-identical released changelogs, version inspection | direct |
| Focused local proof and check | Phases 2-3 | authorized | complete | package tests/root check | all selected post-repair tests green; <code>npm run check</code> green | direct |
| AIM Claude/Codex canaries | Phase 3, 2026-08-23 approval | authorized | pending | AIM descriptor/helper to merged source | pending | direct |
| Implementation audit, draft PR, CI | Phases 4-6 | authorized | pending | audit/PR/checks | pending | direct |
| Merge into origin/main | Phase 7 | later human approval required | blocked by approval gate | PR merge | green receipts required | explicit Amir approval |

## Code Read Ledger

| Area | Files/symbols read | Why relevant | Fresh until | Notes |
| --- | --- | --- | --- | --- |
| Repo policy | <code>AGENTS.md</code> | commands, protocol, git, PR, changelog rules | file changes | full read |
| Canonical plan | complete plan | implementation contract | plan changes | full read |
| AIM target path | AIMGR README; <code>harness-target.js</code>; <code>prime-agent.js</code>; <code>paths.js</code> | real canary owner and isolation | AIMGR changes | AIMGR at pin below |
| Conflict code | all six conflict files at merge base, fork pin, upstream pin, and composed worktree | semantic resolution | relevant source change | full reads before edits |
| Semantic overlap | all 24 paths listed below, with diffs against both parents and merged call-flow neighbors | catch silent auto-merge loss | relevant source change | full grouped audit complete |
| New upstream ACP MCP | <code>acp-mcp-types.ts</code>, <code>acp-mcp.ts</code>, <code>acp-mcp.test.ts</code> | security, ownership, persistence, runtime composition | relevant source change | full read |
| Changelog machinery | workflow, release script, fragment helper, contribution contract | immutable release and fragment validation | relevant source change | full read |

## Six Textual Conflict Resolutions

| Conflict path | Composed disposition | Proof |
| --- | --- | --- |
| <code>packages/ai/src/models.generated.ts</code> | Never hand-edited. Seeded from upstream and regenerated from the merged generator twice; preserves live upstream catalog plus fork aliases/metadata. | both runs SHA-256 <code>801b803fce7386addeea1990c4b579e7c588b8d986caec81fdda87c19f8d24d7</code>; 1,262 tool-capable and 985 reasoning models; 14 OpenAI Codex and 105 Prime Inference models |
| <code>packages/coding-agent/src/core/kernel/fork-server-script.ts</code> | Composed request-ID child registry, parent watchdog/handle, SIGCHLD registration fence, atomic exit evidence, bounded dead-history pruning, and disabled IPython history. | forkserver protocol, watchdog, shutdown, startup, shell, socket, journal, and Python runtime tests |
| <code>packages/coding-agent/src/core/kernel/fork-server.ts</code> | Composed handle-based control with lifecycle lineage, bounded stderr, scrubbed environment, exit metadata, and conservative unknown liveness. | focused real-stub protocol test and adjacent process/kernel matrix |
| <code>packages/coding-agent/src/core/kernel/index.ts</code> | Composed generation/ownership fences, direct-kernel <code>JPY_PARENT_PID</code>, explicit removal for forked kernels, orphan journal state, exit evidence, and no raw-PID control for forked kernels. | shutdown/startup/heavy kernel and process-lifecycle tests |
| <code>packages/coding-agent/src/modes/daemon/daemon-protocol.ts</code> | Protocol 7/schema 23 union with digest-derived ID <code>protocol-7-schema-23-633d151dce99</code>; retains AIM revision-15 floor and ACP revision-22 floor, both capability-gated commands, and all response/event shapes. | daemon protocol exact-schema/capability tests and daemon/connection matrix |
| <code>packages/coding-agent/test/subagent-summary-line.test.ts</code> | Tests upstream bordered <code>agents</code> tile together with fork priority label, bold red <code>FAST OFF</code>, narrow-width, focus, and count styling. | UI group 277/277 and conflict-focused group green |

## 24-Path Semantic Overlap Audit

| Area | Paths | Composed disposition |
| --- | --- | --- |
| Release/generated data | <code>packages/ai/CHANGELOG.md</code>; <code>packages/ai/src/models.generated.ts</code>; <code>packages/coding-agent/CHANGELOG.md</code> | Released changelogs restored byte-identically to upstream; fork-only notes moved to direct-child fragments; generated catalog rebuilt reproducibly from the merged generator. |
| Provider/model transport | <code>packages/ai/src/providers/openai-codex-responses.ts</code>; <code>packages/ai/src/providers/openai-responses.ts</code>; <code>packages/ai/test/openai-codex-stream.test.ts</code> | Upstream GPT-5.6 priority multiplier 2x survives together with fork Codex transport failure classification, credential-generation fencing, and the 1M request alias. |
| Agent session/refinement | <code>packages/coding-agent/src/core/agent-session.ts</code>; <code>packages/coding-agent/src/core/refinement/refinement.ts</code> | Typed continuation errors, goal quiescence, <code>session_before_refine</code>, and durable outcomes coexist with fork request admission, per-model compaction, credential/model rebinding, and AIM exhaustion policy. |
| Kernel/forkserver | <code>packages/coding-agent/src/core/kernel/fork-server-script.ts</code>; <code>packages/coding-agent/src/core/kernel/fork-server.ts</code>; <code>packages/coding-agent/src/core/kernel/index.ts</code> | Request handles and owner-death semantics are composed with exit files, lifecycle evidence, orphan recovery, generation fences, history isolation, and shell recovery. |
| Connection/daemon | <code>packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts</code>; <code>in-process-agent-connection.ts</code>; <code>types.ts</code>; <code>packages/coding-agent/src/modes/daemon/daemon-mode.ts</code>; <code>daemon-protocol.ts</code>; <code>daemon-supervisor.ts</code> | ACP MCP replacement/capability gating and owner release coexist with AIM credential handoff and provider-scoped routing. ACP and AIM owner IDs remain separate; failed workers are omitted from heartbeat catalogs without deleting recovery evidence. |
| Interactive UI | <code>packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts</code>; <code>packages/coding-agent/src/modes/interactive/interactive-mode.ts</code> | Elapsed timer, refinement loader/outcomes, queue styling, and bordered agents tile coexist with session-local model/effort state, <code>FAST OFF</code>, AIM usage, and recovery UI. |
| Overlapping tests | <code>packages/coding-agent/test/daemon-mode.test.ts</code>; <code>daemon-protocol.test.ts</code>; <code>interactive-mode-effort-command.test.ts</code>; <code>interactive-mode-status.test.ts</code>; <code>subagent-summary-line.test.ts</code> | Both lineages' assertions retained or deliberately refreshed where the regenerated live catalog changed valid product truth; new composed protocol/forkserver regressions added. |

## Upstream Acceptance Map

| Commit | Disposition | Integration evidence |
| --- | --- | --- |
| <code>b5807b6f</code> changelog fragments | present and adapted | workflow/helper/release machinery retained; immutable 0.8.0 sections plus fork fragments |
| <code>a3af021c</code> queue header | present | interactive UI matrix green |
| <code>addfc23f</code> owner-death/handle kernel control | present and composed | all kernel/forkserver conflict contracts and matrices green |
| <code>c75a637b</code> session-scoped ACP MCP | present and composed | ACP ownership/capability/runtime tests green; no credential persistence |
| <code>bb3ac37f</code> bordered agents tile | present and composed | combined tile/priority/FAST tests green |
| <code>848081ed</code> API-key Fast mode/GPT-5.6 2x | present and composed | provider and effort/status tests green |
| <code>e51d2266</code> descendant quiescence | present and composed | goal and session queue/compaction tests green |
| <code>35103cb4</code> typed continuation errors | present | agent core and session tests green |
| <code>48b6478e</code> elapsed timer | present and composed | status matrix green |
| <code>108eff32</code> <code>session_before_refine</code> | present and composed | refinement/extension tests green with model-registry admission retained |
| <code>274cbb84</code> refinement loader/outcomes | present and composed | refinement outcome/print/UI tests green |
| <code>8c749fb9</code> MCP OAuth discovery | present and composed | MCP OAuth tests green with endpoint binding retained |
| <code>34b294f8</code> heartbeat failure filtering | present and composed | heartbeat/daemon/recovery tests green |
| <code>a3d86fbe</code> MCP provider refresh | present and composed | MCP manager/interactive service tests green |
| <code>8d7deeab</code> release 0.8.0 | present and adapted | root, lock, agent, AI, coding-agent, and TUI versions agree at 0.8.0 |
| <code>e319a66d</code> regenerated model catalog | present and regenerated | deterministic output hash and provider/model matrices green |

## Proof Freshness Ledger

| Proof | Scope covered | Result/context | Fresh until | Rerun trigger |
| --- | --- | --- | --- | --- |
| Fork/upstream refresh | ancestry/inventory | fork <code>7e7bb45</code>; upstream <code>e319a66</code>; base <code>bb61ca2</code>; 42/16 | next fetch | remote update |
| AIMGR refresh | canary integration owner | fast-forwarded cleanly to <code>82dbab6888a0e2ac9c37bece538c86696c80d14b</code> | AIMGR update | remote/local change |
| Dependency bootstrap | whole workspace | npm 11.10.1 <code>ci</code> passed; lock SHA-256 unchanged at <code>bc551f046cf328665bda542e017a66f44dda84b315468b3fa31d6bbcf5e10abb</code> | lock or Node change | dependency/lock change |
| Frozen-fork baseline | selected fork contracts | 955 passed; 9 failures reproduced before merge (4 model-registry, 3 interactive replacement, 2 process stack fixtures) | source merge | completed comparison |
| Conflict-focused regression | composed protocol/kernel/UI conflicts | 8 files; 77 passed, 2 skipped | relevant change | conflict path change |
| New composed protocol/forkserver regression | schema/capability floors and real exit-file protocol | 2 files; 37 passed, 1 skipped | relevant change | protocol/forkserver change |
| Agent core | typed continue behavior | 2 files; 35 passed | relevant change | agent core change |
| AI upstream group | provider/OAuth/catalog changes | 7 files; 121 passed | relevant change | AI source change |
| xAI focused repair | catalog-present Grok 4.6 subscription thinking map | 1 file; 22 passed | relevant change | xAI/model change |
| Coding upstream daemon/ACP group | daemon, connection, ACP MCP | 7 files; 322 passed | relevant change | daemon/ACP change |
| Coding upstream UI group | interactive/refinement/summary | 8 files; 277 passed | relevant change | UI/session change |
| Coding upstream kernel group | owner death, startup/shutdown | 3 files; 31 passed, 2 skipped | relevant change | kernel change |
| Coding upstream suite group | queue/compaction/refinement | 4 files; 156 passed | relevant change | session/refinement change |
| Fork auth/model group | AIM/provider/model preservation | 8 files; 195 passed | relevant change | auth/model change |
| Fork refinement group | admitted model calls and outcomes | 6 files; 122 passed | relevant change | refinement change |
| Fork daemon core group | compatibility/reuse/recovery | 8 files; 178 passed | relevant change | daemon change |
| Fork daemon process group | process/routing/lease regressions | 5 files; 6 passed | relevant change | daemon process change |
| Supervisor process group | subprocess recovery paths | 10 passed, 8 platform skips | relevant change | supervisor/process change |
| Final composed kernel/process group | handle, startup, shell, socket, journal, crash rendering | 6 files; 32 passed | relevant change | kernel/process change |
| Kernel-heavy group | long-running kernel behavior | 3 files; 13 passed | relevant change | kernel change |
| Python runtime canonical CI command | MCP runtime | <code>uv run python -m unittest discover -s test</code>; 98 passed | Python runtime change | runtime source/test change |
| Static tree checks | conflict/whitespace/generated release state | no unmerged paths, conflict markers, or diff-check errors; released changelogs upstream-identical | tree change | any edit |
| Root repository check | formatting, TypeScript, installer, browser smoke | <code>npx npm@11.10.1 run check</code> passed; Biome checked 964 files with no fixes | tree change | any edit |

## Continuous Review Ledger

| Finding | Source | Status | Repair anchor | Resolution |
| --- | --- | --- | --- | --- |
| ACP test runtime omitted fork auth service | post-merge test | resolved | <code>test/acp-mcp.test.ts</code> | Added a secret-free <code>authStorage.getAimCredentialBindings</code> stub matching production runtime composition; affected 322-test group green. |
| Live catalog made Grok 4.6 API-key expectations stale and exposed a sparse subscription thinking map | baseline/post-merge comparison | resolved | <code>xai.ts</code>, xAI OAuth/model-registry tests | API-key rail now expected on completions; catalog-present subscription Grok 4.6 is overlaid with off/minimal disabled plus low/medium/high/xhigh; focused and 195-test groups green. |
| Replacement-session fixture lacked registry rebinding and aborted provider refresh | frozen baseline | resolved | <code>interactive-mode-status.test.ts</code> | Added the production-shaped no-op rebind method to the fake; exact 173-test file and 277-test UI group green. |
| Crash sanitizer recognized only a literal <code>/prime-agent/</code> checkout name | frozen baseline | resolved | <code>process-lifecycle.ts</code> | Normalize separators and anchor privacy-safe projection at <code>/packages/coding-agent/</code>; exact 13-test lifecycle file and final 32-test group green. |
| Saved plan used non-existent Python module path <code>test.test_mcp</code> | command execution | resolved as plan-command drift | implementation record | Repository CI is authoritative: <code>uv run python -m unittest discover -s test</code>; all 98 runtime tests passed. |
| Generated catalog differs from both frozen parents | generator review | accepted | merged generator and generated output | Live-source delta is expected and reproducible: versus upstream +112/-75 lines, versus fork +424/-264; two consecutive hashes match. |

## Side Doors And Deletes

| Surface | Expected state | Current state | Status | Anchor |
| --- | --- | --- | --- | --- |
| Raw PID control for forked kernels | removed from forked control path | handle-only control; raw PID retained only where direct-child ownership permits it | conforming | Section 6.4 |
| Direct generated-model edits | none | none; generated twice from merged source | conforming | Section 6.5 |
| Fork direct release notes | migrated only for fork-only additions | two direct-child fragments; all released changelogs match upstream | conforming | Section 8 |
| ACP environment/bearer persistence | none | session-scoped validation/owner cleanup; no recovery/session credential persistence | conforming | Sections 6.1 and 7 |
| Existing untracked uv bug doc | untouched in primary checkout | SHA-256 <code>7c3673c958717e12b705d0745e992177a081dd6bb9133cfd4351df64010df92c</code> | conforming | Section 2.3 |
| Live/default AIM/Prime state in canaries | never used | canaries pending; unique temporary paths required | authorized constraint | Phase 3 canaries |

## Decision Carry-Through

| Decision | Owner | Plan carry-through | Code carry-through | Status |
| --- | --- | --- | --- | --- |
| Two-parent merge; no squash/rebase | Amir/plan | Sections 2 and 13 | exact pinned upstream merge in progress | approved |
| Protocol 7/schema 23 union | Amir/plan | Section 6.1 | both capabilities/commands with historical floors | complete |
| Handle-based kernel control plus fork diagnostics | Amir/plan | Sections 6.2-6.4 | composed handle, watchdog, exit, journal, lifecycle paths | complete |
| Generator-only model reconciliation | repo policy/plan | Section 6.5 | deterministic generated artifact | complete |
| Real AIM Claude/Codex canaries | Amir, 2026-08-23 | execution boundary and Phase 3 | pending | approved |
| Stop before merge for proof approval | repo policy/plan | Phase 7 | no origin/main mutation | active gate |

## Frozen Inputs

- Fork: <code>7e7bb45cdfaddc1fa051678714147ae1534698d9</code>
- Upstream: <code>e319a66d7351c75abe7f040d02d9a8d6e25028e9</code>
- Merge base: <code>bb61ca21c3e27a5d2af7fab3ab662789a5e478d2</code>
- AIMGR: <code>82dbab6888a0e2ac9c37bece538c86696c80d14b</code>
- Plan commit: <code>dd3794195a01f7099d9f5a36f1826db4b4b6b139</code>
- Node: 22.19.0
- npm lane: 11.10.1 through <code>npx</code>

## Pass Notes

### 2026-08-23 - Intake and freeze

- Intent: execute the complete signed migration through CI, with the newly authorized AIM Claude/Codex canaries, stopping before merge.
- Changed: updated and committed the canonical plan on the integration branch; fast-forwarded clean AIMGR main; created an isolated Prime Agent worktree.
- Proof: remote pins unchanged; documentation pre-commit check green; dependency bootstrap preserved the lockfile byte-for-byte.
- Review: scope boundary is defensible; primary checkout and unrelated untracked bug document remained untouched.

### 2026-08-23 - Frozen-fork baseline

- Intent: establish regression truth before applying upstream.
- Changed: no source edits.
- Proof: 955 tests passed across 32 files. Nine tests failed in three files and were reproduced before the merge: four Grok 4.6 catalog assertions, two source-map stack fixture assertions, and three replacement-session command-refresh assertions.
- Review: failures were classified as baseline evidence and carried into the post-merge comparison rather than attributed to upstream.

### 2026-08-23 - Two-lineage semantic composition

- Intent: integrate the complete pinned upstream range while preserving all fork runtime contracts.
- Changed: resolved all six textual conflicts; composed schema 23; combined owner-death/handle kernel control with fork diagnostics/recovery; regenerated models; preserved the bordered agents tile plus priority/FAST status; restored immutable upstream 0.8.0 changelogs and moved fork notes to fragments.
- Read: every conflict at base/fork/upstream/composed states, all 24 overlap paths, new ACP MCP implementation/tests, release machinery, and affected call-flow neighbors.
- Proof: no unmerged paths or conflict residue; deterministic generated-model hash; released changelogs byte-identical to upstream.
- Review: no whole-file conflict shortcut was used; AIM/ACP owners and historical protocol floors remain separate.

### 2026-08-23 - Deterministic verification and baseline repair

- Intent: prove the merged behavior and resolve every baseline comparison item.
- Changed: repaired the ACP test harness, Grok 4.6 subscription overlay, replacement-session fake, and worktree-independent privacy-safe crash projection; added exact schema/capability and forkserver exit-file regressions.
- Proof: all focused, upstream-changed, fork-preservation, kernel-heavy, and Python runtime groups listed above are green; the three frozen-fork failure groups are now green; root check passed with no formatter edits.
- Review: the failed Python module invocation was plan-command drift, replaced by the repository CI command; no code failure was hidden or waived.
- Next: explicitly stage and inspect the merge, commit with exact two-parent ancestry, then run isolated source/TUI and AIM-managed Claude/Codex canaries.
