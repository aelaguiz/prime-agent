# Prime Agent upstream 0.8.0 integration implementation-audit ledger

Plan: `docs/aelaguiz/PRIME_AGENT_UPSTREAM_0_8_0_INTEGRATION_PLAN_2026-08-22.md`
Implementation log: `docs/aelaguiz/PRIME_AGENT_UPSTREAM_0_8_0_INTEGRATION_PLAN_2026-08-22_IMPLEMENTATION_LOG.md`

## Final verdict

**PASS — no unresolved implementation finding at Prime Agent merge commit
`666a754eed008312a1c8995662ac68a27e2bb1ce` (tree
`ed41e3571ab5ea26ec16f3a415b2608eeb7237ef`).**

The audited tree is a genuine two-parent merge whose first parent is the fork
plan commit and whose second parent is the exact official upstream pin. The
audit found no correctness, security, protocol, lineage, release-metadata, or
fork-preservation defect that requires reopening implementation. The branch may
advance to PR and Linux CI. It may not be merged until that full CI matrix is
green and Amir gives the separate approval required by `AGENTS.md` and the
canonical plan.

## Audit contract

This was the plan's separate read-only implementation audit. It inspected code,
tests, generated/release artifacts, Git ancestry, and existing verification
receipts. It did not run tests, builds, lint, formatting, generators, canaries,
or CI, and it did not modify production code. Local test/check/canary results in
the implementation log were accepted as prior execution context and checked
for coverage, not rerun during the audit.

No child reviewers were used because the active session policy prohibited
sub-agent delegation unless explicitly requested. Audit coverage was therefore
owned end-to-end by the root reviewer.

## Frozen audit target

| Item | Audited value |
| --- | --- |
| Feature branch | `integrate/upstream-0.8.0-20260822` |
| Audited commit | `666a754eed008312a1c8995662ac68a27e2bb1ce` |
| Audited tree | `ed41e3571ab5ea26ec16f3a415b2608eeb7237ef` |
| First parent | `dd3794195a01f7099d9f5a36f1826db4b4b6b139` |
| Second parent | `e319a66d7351c75abe7f040d02d9a8d6e25028e9` |
| Frozen fork pin | `7e7bb45cdfaddc1fa051678714147ae1534698d9` |
| Frozen upstream pin | `e319a66d7351c75abe7f040d02d9a8d6e25028e9` |
| Merge base | `bb61ca21c3e27a5d2af7fab3ab662789a5e478d2` |
| Frozen upstream range | 16 commits, 90 files |
| Merge result | 97 files, 6,041 insertions, 888 deletions |
| Final tree deviations from upstream range | 24 paths, all classified below |

Read-only ancestry checks confirmed that both frozen lineages are ancestors of
the audited merge. The merge commit has exactly the two parents above; it is not
a squash, rebase, or synthetic file copy.

## Findings

There are no open or closed `IMP-*` findings from this audit pass. No source
repair was required.

## Non-finding observations and required follow-through

| ID | Observation | Classification | Required follow-through |
| --- | --- | --- | --- |
| OBS-001 | The plan's saved Python invocation named `test.test_mcp`, but the repository/CI command is `uv run python -m unittest discover -s test`. | Plan-command drift; no code defect | Correct the canonical plan and retain the green 98-test receipt under the canonical command. |
| OBS-002 | A public CLI invocation written as `./prime-agent.sh --no-env --daemon-socket <socket> shutdown` is parsed as a model prompt, not an exact-socket daemon-control command. The isolated smoke was cleaned up through the source daemon client and one exact, verified supervisor PID. | Plan cleanup-command drift; no product regression established | Correct the plan so it never presents that unsupported public invocation as exact-socket cleanup. Keep cleanup scoped to the unique socket/process identity. |
| OBS-003 | `PRIME_AGENT_CODING_AGENT_DIR` alone cannot retarget an already-owned AIM Prime target: AIM intentionally preserves the persisted target path and reports `pathConflict`. The successful canaries used an isolated AIM `--home` plus a private copy of non-secret AIM configuration. | Isolation-procedure drift; expected AIM ownership behavior | Correct the plan's canary procedure to require an isolated AIM home and verify `pathConflict: false` before installation. |
| OBS-004 | macOS cannot exercise all Linux forkserver/process paths; the local supervisor group retained eight platform skips and the kernel group retained two. | Known platform proof gap | Require the complete Linux process, kernel, coding-agent, runtime, build/check, and aggregate CI jobs to succeed on the exact PR head. |
| OBS-005 | The first canary attempt installed two descriptors into the default target because of OBS-003. Both were immediately uninstalled; redacted status then showed neither installed and no path conflict. No account reauthentication, logout, rotation, live session mutation, or token inspection occurred. | Recovered operator deviation; no residual state found | Preserve the redacted receipt in the implementation log and use only the corrected isolated-home procedure going forward. |

These observations do not waive any plan exit criterion. OBS-004 remains a hard
remote gate, and the PR remains unmergeable until it is closed by successful
Linux CI.

## Scope manifest and coverage

| Audit area | Files and symbols inspected | Audit result |
| --- | --- | --- |
| Lineage and merge structure | merge parents/tree, ancestry checks, frozen fork/upstream/base refs, upstream-range and parent diffs | Both lineages are present exactly; no ancestry shortcut. |
| Six textual conflicts | `models.generated.ts`; `fork-server-script.ts`; `fork-server.ts`; kernel `index.ts`; `daemon-protocol.ts`; `subagent-summary-line.test.ts` at base/fork/upstream/final states | Each conflict composes both lineages; no whole-file `ours`/`theirs` shortcut remains. |
| 24 semantic overlaps | released changelogs; generated models; OpenAI/Codex providers/tests; agent session/refinement; kernel/forkserver; connection/daemon; interactive UI and overlapping tests | Every final deviation from official upstream was classified as fork preservation, deliberate composition, regenerated data, or a composed regression test. |
| Daemon protocol | schema constants/ID, capability union, command types, compatibility map, client pre-write checks, reconnect resend checks, daemon handlers/tests | Protocol 7/schema 23 is the AIM + ACP union. AIM retains revision-15 floor; ACP retains revision-22 floor. Both commands are capability gated before a wire write, including after reconnect. No stale schema-21/22 ID remains. |
| Kernel and forkserver | request-handle API, embedded Python protocol, SIGCHLD fencing, parent watchdog, direct/fork starts, liveness, graceful/forced cleanup, generation fences, exit file and journal paths | Forked control is handle/request-ID based. Direct kernels alone use child handles and `JPY_PARENT_PID`; forked env removes it. Exit evidence, conservative orphan state, history isolation, and stale-generation fences survive. |
| ACP MCP security/lifecycle | ACP validation, ACP owner UUID, admission/replace/rollback, daemon client/session ownership, manager separation, kernel runtime config, detach/close/failure cleanup, Python credential source | Names, duplicate fields, headers, env, URL scheme, and embedded credentials are validated. ACP values remain connection/session scoped, never borrow stored OAuth by name, and are cleared before transport release. No session/recovery persistence path was found. |
| Refinement and continuation | typed `Agent.continue`, goal continuation/quiescence, refine planning/apply, `session_before_refine`, outcome persistence/rendering, compaction continuation | Typed preconditions and descendant quiescence are retained. Every built-in refinement completion goes through `completeSimpleWithRequestAdmission`; apply remains serialized and outcomes durable. |
| Provider/model behavior | Fast-mode predicate and pricing, OpenAI/Codex request shaping, Codex request IDs/failure typing, xAI subscription overlay, model registry rebinding | Fast mode is restricted to eligible GPT-5.4/5.5/5.6 OpenAI API-key or Codex rails. GPT-5.6 priority pricing is 2x (GPT-5.5 remains 2.5x). Fork request-admission/failure identity and xAI subscription behavior remain. |
| Generated alias/catalog | merged generator, generated alias, `requestModelId`, type fields, model registry discovery, compaction threshold call sites | `gpt-5.6-sol-1m` resolves provider requests to `gpt-5.6-sol`, exposes a 1,000,000-token context, and compacts at 900,000. Generated output is source-backed, not hand-edited. |
| UI and session state | elapsed timer anchors/restoration, MCP provider refresh, service-tier events/toggle, bordered agents tile, priority/`FAST OFF` rendering, durable refinement cards | Upstream timer/refinement/agents UX and fork session-local effort/priority alarm coexist. Session switches fence queued Fast toggles. |
| MCP OAuth | protected-resource discovery, issuer/resource binding, redirect policy, endpoint-bound stored credentials, user-server provider refresh | Discovery validates HTTPS metadata and exact protected-resource binding; stored tokens remain endpoint-bound. User OAuth providers are re-registered after refresh and removed when configuration is removed. |
| Supervisor/heartbeat | failed-worker filtering, recovery and compatibility paths, peer publication queue, lifecycle evidence | Failed/stopping workers are not misreported as ready; upstream heartbeat filtering coexists with fork recovery/routing and diagnostic evidence. |
| Release metadata | package and lock versions/ranges, upstream changelogs, fragment workflow/helper/release script, fork fragments | Root/workspaces/internal ranges agree at 0.8.0. Released changelogs are byte-identical to upstream. Fork-only AI/coding-agent notes are fragments; upstream catalog fragment is retained. |
| Side doors and cruft | conflict markers, whitespace, focused/skipped tests, temporary debug markers, new casts/imports/process calls, deletions, secret-like additions | No conflict residue, `.only`, debugger, unauthorized deletion, or production secret literal was found. New broad casts/process control are confined to tests or existing intentional runtime boundaries. Expected release logging and two documented kernel TODOs are not integration residue. |
| Primary checkout preservation | primary status and SHA-256 of `docs/bugs/uv-only-system-kernel-bootstrap.md` | File remains untracked and unchanged at SHA-256 `7c3673c958717e12b705d0745e992177a081dd6bb9133cfd4351df64010df92c`; it is absent from the feature branch. |

## Conflict-resolution audit

| Conflict | Final contract | Audit disposition |
| --- | --- | --- |
| Generated models | Generated twice from the merged generator; official refreshed catalog plus fork aliases/metadata | Conforming. Deterministic prior hash: `801b803fce7386addeea1990c4b579e7c588b8d986caec81fdda87c19f8d24d7`. |
| Forkserver script | Owner watchdog, request-ID child handles, SIGCHLD register/fork fence, atomic exit evidence, bounded dead history, history disabled | Conforming. Request IDs cannot alias recycled PIDs; live entries are never evicted. |
| Forkserver host | Handle-only fork control, bounded stderr, scrubbed launch environment, conservative liveness/error behavior | Conforming. Fork PID is informational/journal-only. |
| Kernel manager | Direct parent PID watch; fork parent watch; generation/ownership fences; exit/lifecycle/journal evidence; no raw fork-PID signaling | Conforming. Unknown fork kill/liveness outcomes fail conservatively. |
| Daemon protocol | Protocol 7/schema 23 digest ID and exact capability union | Conforming. Historical floors remain command-specific. |
| Subagent tile test | Upstream bordered tile plus fork priority callback, red `FAST OFF`, narrow/focus/count behavior | Conforming. Production tile and tests represent the union. |

## Acceptance reconciliation

| Upstream change | Static implementation evidence reviewed | Existing execution receipt or remaining gate |
| --- | --- | --- |
| Changelog fragments | Workflow, helper, release aggregation, direct-child fragments | Local release-state/static checks green; changelog PR job required. |
| Dim queue header | Interactive rendering path retained | UI group: 277 passed. |
| Owner-death/handle kernels | Parent watchdog, request handles, liveness and exit evidence composed | Kernel/forkserver/process groups green; Linux process/kernel CI required. |
| Session-scoped ACP MCP | Validation, ownership, cleanup, runtime credential source | Daemon/ACP group: 322 passed; Python runtime: 98 passed. |
| Bordered agents tile | Tile production code plus priority/FAST callback | UI group: 277 passed. |
| Fast API-key mode | Eligibility and provider pricing paths | AI group: 121 passed; fork auth/model group: 195 passed. |
| Descendant goal quiescence | Goal hook and recursive quiescence barrier | Agent/session/queue groups green. |
| Typed continue errors | `AgentContinueError` preconditions and queue fallback | Agent core: 35 passed. |
| Elapsed timer continuity | Transcript timestamp recovery and first-run anchor | UI/status group green. |
| `session_before_refine` | Extension event, skip/replacement, admitted fallback planner | Refinement groups: 122 passed plus session suite 156 passed. |
| Durable refinement outcomes | Persisted custom message and render paths | Refinement/UI receipts green. |
| MCP protected-resource OAuth | HTTPS/resource/issuer/endpoint validation | AI OAuth group included in 121 passed. |
| Failed-worker heartbeat filter | Ready/live classification and catalog path | Supervisor/process and daemon groups green; Linux CI required. |
| MCP refresh after add | UI service calls manager refresh/reload | MCP manager/services tests included in green UI/daemon groups. |
| 0.8.0 release | Package/lock versions and immutable changelogs | Root repository check green; CI build/check required. |
| Refreshed model catalog | Generator-backed output and model/provider deltas | Two identical generator hashes; AI/model groups green. |

## Test and check context accepted by this audit

The audit reviewed the implementation log's exact command/result receipts. It
did not execute them again.

| Proof surface | Accepted result |
| --- | --- |
| Frozen fork baseline | 955 passed; 9 known failures reproduced before merge and later closed. |
| Conflict-focused regressions | 77 passed, 2 platform skips. |
| Composed protocol/forkserver regressions | 37 passed, 1 platform skip. |
| Agent core | 35 passed. |
| AI upstream group | 121 passed. |
| xAI focused repair | 22 passed. |
| Daemon/ACP group | 322 passed. |
| Interactive/UI group | 277 passed. |
| Upstream kernel group | 31 passed, 2 platform skips. |
| Session suite group | 156 passed. |
| Fork AIM/auth/model group | 195 passed. |
| Fork refinement group | 122 passed. |
| Daemon core group | 178 passed. |
| Daemon process group | 6 passed. |
| Supervisor process group | 10 passed, 8 platform skips. |
| Final composed kernel/process group | 32 passed. |
| Kernel-heavy group | 13 passed. |
| Python runtime | 98 passed with `uv run python -m unittest discover -s test`. |
| Root check | `npx npm@11.10.1 run check` passed; Biome checked 964 files without changes. Commit hook repeated the green check. |
| Static tree checks | No unmerged paths, conflict markers, or whitespace errors; released changelogs match upstream. |
| Isolated source smoke | Merged `--help` and TUI startup passed; exact temporary tmux/socket/process/state removed. |
| AIM-managed Codex canary | Isolated target, `openai-codex/gpt-5.6-sol`, exact completion marker `AIM_CODEX_OK`, exit 0. |
| AIM-managed Claude canary | Isolated target, `anthropic/claude-fable-5`, exact completion marker `AIM_CLAUDE_OK`, exit 0. |
| Canary cleanup | Temporary descriptors absent, auth keys empty, exact daemon sockets stopped, canary root removed; no reauth/logout/rotation. |

## Architecture-quality lenses

| Lens | Result | Notes |
| --- | --- | --- |
| Requirement carry-through | Pass | Every upstream commit and every fork preservation invariant has a static anchor and proof surface. |
| Correctness | Pass | Conflict resolutions preserve both sides' observable behavior; no contradictory state transition found. |
| Concurrency and lifecycle | Pass | Generation fencing, request-handle identity, SIGCHLD ordering, owner cleanup, refine serialization, and session-switch fencing were traced. |
| Backward compatibility | Pass | Protocol version remains 7; new commands are capability/revision gated with historical floors. |
| Security and privacy | Pass | ACP credentials stay scoped; OAuth endpoints/resources are bound; no credential value is logged/persisted by new paths; crash projection remains privacy-reduced. |
| Data and persistence | Pass | Released changelogs are immutable; refinement outcomes are durable; ACP config is deliberately non-durable; orphan/exit evidence is conservative. |
| Failure behavior | Pass | Unknown liveness/signal outcomes fail closed; daemon capability failures occur before write; failed refinement/ACP admission cleans or rolls back ownership. |
| Observability | Pass | Fork and daemon lifecycle evidence survives without turning unconfirmed outcomes into false success. |
| Maintainability | Pass | New unions and model aliases retain single typed/generated sources of truth. Test-only casts do not leak into product APIs. |
| Scope discipline | Pass | No unrelated feature, AIM source change, release, publish, tag, deployment, or live-session mutation is in the branch. |
| Verification quality | Pass with external gate | Local targeted proof is broad and canaries are end-to-end; Linux CI remains mandatory for platform-specific and full-suite coverage. |

## Side-door and deletion ledger

| Surface | Required state | Audited state |
| --- | --- | --- |
| Raw forked-kernel PID signaling | Absent | Absent from product fork control; request handles own kill/liveness. |
| Generated model hand editing | Absent | Generated artifact is reproducible from merged generator. |
| Stale daemon schema IDs | Absent | No schema-21/22 constant/ID assumption remains in current source/tests. |
| Unguarded AIM/ACP daemon writes | Absent | Both command families are checked before initial and reconnect writes. |
| ACP secrets in session/recovery state | Absent | No persistence path found; release occurs on failure, close, detach, and process shutdown. |
| Duplicate released notes | Absent | Released changelogs equal official upstream; fork additions live only in new fragments. |
| Focused tests/debug residue | Absent | No `.only`, debugger, or temporary debug addition found. |
| Unauthorized deletions | Absent | Branch introduces files and composes changes; no path deletion was found. |
| Primary untracked bug doc | Untouched | Unchanged hash, untracked only in primary checkout, absent from branch. |

## Unproven and platform-dependent items

- GitHub Actions has not yet run on the feature branch. The build/check job,
  package test jobs, three coding-agent shards, process smoke, kernel job,
  Python runtime job, changelog-fragment job, contributor-trust gate, and
  aggregate `build-check-test` job remain unproven remotely.
- macOS platform skips cannot establish Linux forkserver, process-group, or
  kernel behavior. They are not accepted as passes; successful Linux CI is the
  closure condition.
- The audited commit will acquire documentation-only descendants for this
  ledger and plan/log corrections. If source, protocol, kernel, credentials,
  generated models, release metadata, or tests change after this audit, the
  affected local proof and a new read-only audit pass are required.
- Remote heads must be fetched again before push. If official upstream moved,
  the canonical plan requires a new inventory/pin before claiming “latest.” If
  `origin/main` moved, it must be semantically merged and affected proof rerun.

## Repository-state integrity

At audit intake the integration worktree had one pre-existing unstaged change:
the implementation log being updated with already-completed execution
receipts. The audit made no production or test edit. The audit ledger itself is
the only artifact created by this pass. The primary checkout remained on
`main`, with its unrelated untracked bug document unchanged.

## Pass history

### 2026-08-23 — implementation audit pass 1

- Target: merge commit `666a754eed008312a1c8995662ac68a27e2bb1ce`.
- Scope: complete upstream range classification, six conflict resolutions, 24
  semantic overlaps, high-risk call flows, release/generated state, side doors,
  and existing proof reconciliation.
- Findings: none.
- Observations: five non-code follow-through items recorded above; Linux CI is
  the only blocking proof gap before merge approval.
- Disposition: **PASS to Phase 5 (remote refresh, draft PR, and CI); do not
  merge.**
