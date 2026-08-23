---
title: "Prime Agent - Upstream 0.8.0 Integration and Local Validation Plan"
date: 2026-08-22
last_updated: 2026-08-23
status: active
fallback_policy: forbidden
owners: [Amir, Prime Agent fork maintainers]
reviewers: []
doc_type: migration
related:
  - docs/aelaguiz/PRIME_AGENT_UPSTREAM_MAIN_INTEGRATION_PLAN_2026-08-15.md
  - docs/aelaguiz/PRIME_AGENT_UPSTREAM_MAIN_INTEGRATION_PLAN_2026-08-15_IMPLEMENTATION_LOG.md
  - docs/aelaguiz/PRIME_AGENT_UPSTREAM_MAIN_INTEGRATION_PLAN_2026-08-15_PLAN_AUDIT.md
  - docs/DEEP_CRASH_AND_RESTART_OBSERVABILITY_2026-08-20.md
  - docs/bugs/daemon-worker-timeout-recovery-storm.md
  - docs/bugs/ipython-shell-channel-wedge.md
  - docs/bugs/cross-daemon-attach-routing.md
---

# TL;DR

## Outcome

Integrate the latest reviewed official Prime Agent upstream snapshot into Amir's fork with a lineage-preserving two-parent merge, retain every fork-only AIM/provider/session/daemon/kernel contract, run focused local tests and an isolated source smoke test, require the complete GitHub Actions matrix to pass, and then merge the reviewed pull request into <code>origin/main</code> with an ordinary merge commit.

The plan is pinned to the evidence available on 2026-08-22:

- Fork: <code>origin/main</code> at <code>7e7bb45cdfaddc1fa051678714147ae1534698d9</code>.
- Official upstream: <code>PrimeIntellect-ai/prime-agent</code> <code>main</code> at <code>e319a66d7351c75abe7f040d02d9a8d6e25028e9</code>.
- Merge base: <code>bb61ca21c3e27a5d2af7fab3ab662789a5e478d2</code>.
- Divergence: the fork is 42 commits ahead of the merge base; upstream is 16 commits ahead.
- Upstream release in the range: version 0.8.0 at commit <code>8d7deeab5861bf9d77bde3d8511046a5c799818d</code>, followed by one generated model-catalog refresh.
- Upstream range size: 90 files, 5,615 insertions, and 752 deletions.
- Predicted textual conflicts: six files.
- Semantically overlapping paths: 24 files, including several paths that Git predicts will auto-merge.

The implementation must refresh both remote heads immediately before work starts. If official upstream has advanced beyond the pin above, stop, inventory the new delta, update this same plan, and establish a new immutable upstream pin before merging. “Latest upstream” must be demonstrated by a fetch receipt, not assumed from this document's date.

## Why this needs a migration plan

This is not a safe “take theirs” merge. Upstream replaces raw PID control for forked kernels, adds parent-death handling and ACP-scoped MCP servers, introduces a second daemon capability, changes refinement and continuation flows, adopts changelog fragments, releases 0.8.0, and regenerates the live model catalog. The fork independently changes the same kernel, daemon, model, provider, session, and UI surfaces for AIM credential ownership, durable crash diagnostics, worker recovery, cross-daemon routing, xAI subscriptions, Claude exhaustion, session-local effort, the GPT-5.6 Sol 1M alias, and the red <code>FAST OFF</code> alarm.

A textual merge can compile while losing one side's behavior. The implementation therefore uses explicit composition contracts, preservation tests, a separate read-only implementation audit, and a PR/CI gate.

## Execution boundary

This artifact was initially the requested plan. On 2026-08-23, Amir explicitly authorized full implementation, local testing, and real AIM-managed Claude and Codex validation. That approval authorizes the implementation phases, a feature branch, a draft PR, CI, and the bounded canaries defined below. It does not authorize publishing packages, installing a release, reauthenticating or logging out accounts, rotating a live session, or merging the pull request. Work stops again at the merge-approval gate required by the repository's <code>AGENTS.md</code>: the PR may be merged only after Amir explicitly approves the green result.

# 1. North Star

## 1.1 Falsifiable claim

After the integration, <code>origin/main</code> contains the exact reviewed upstream head as an ancestor and exhibits every behavior introduced by the 16 upstream commits, while all fork-only provider, credential, session, daemon, process-lifecycle, and kernel guarantees continue to pass their existing regression tests. A local source run uses isolated state without paid provider calls, and the repository's complete Linux CI build/check/test matrix is green before merge.

## 1.2 Observable done state

1. <strong>Ancestry:</strong> both the fork pin and upstream pin are ancestors of the final <code>origin/main</code>; the upstream commits were merged, not copied by squash, cherry-pick, or file replacement.
2. <strong>Upstream completeness:</strong> every commit in Section 3 has an implementation path and a passing acceptance test or CI job.
3. <strong>Fork preservation:</strong> every invariant in Section 4 is still represented in code and covered by focused tests.
4. <strong>Protocol correctness:</strong> the merged daemon advertises both AIM credential handoff and ACP MCP server capabilities under a new schema revision, with old/new peer compatibility tests.
5. <strong>Kernel correctness:</strong> parent death and PID reuse are handled through upstream's parent/handle design without losing the fork's exit-status files, process-lifecycle events, history isolation, shell-channel recovery, or stale-generation fencing.
6. <strong>Generated catalog correctness:</strong> <code>models.generated.ts</code> is produced only by the merged generator, contains upstream's refreshed catalog and the fork's GPT-5.6 Sol 1M alias, and does not restore retired routes.
7. <strong>Release metadata correctness:</strong> package versions are 0.8.0, upstream's 0.8.0 changelog sections remain byte-for-byte immutable, fork-only unreleased notes survive as changelog fragments, and no duplicate release notes remain.
8. <strong>Local proof:</strong> all named focused tests pass, <code>npm run check</code> has no errors/warnings/infos, <code>git diff --check</code> passes, and an isolated source/TUI/daemon smoke test leaves no process behind.
9. <strong>Remote proof:</strong> the PR's build/check job, package test jobs, process smoke, kernel job, runtime Python job, changelog-fragment job, and aggregate <code>build-check-test</code> job all succeed rather than skip.
10. <strong>Merge discipline:</strong> Amir reviews the proof receipts and explicitly approves merge; the PR is merged with the merge-commit strategy; no package publish, tag, deployment, or live-host cutover occurs.

## 1.3 In scope

- Official upstream <code>main</code> through the refreshed immutable pin.
- All 16 upstream commits currently between the merge base and <code>e319a66d</code>.
- A two-parent merge into a feature branch based on the then-current fork <code>origin/main</code>.
- Six predicted textual conflicts and all 24 paths changed by both lineages.
- Semantic review of new upstream-only paths whose behavior crosses fork-owned auth, daemon, kernel, MCP, and session boundaries.
- Daemon schema/capability composition.
- Kernel/forkserver lifecycle composition.
- Generator-based model catalog reconciliation.
- Changelog-fragment migration and version/lockfile reconciliation.
- Focused local tests, root static checks, an isolated local smoke test, a separate implementation audit, draft PR, complete CI, review follow-through, explicit approval, and merge into <code>origin/main</code>.
- One short real completion through the merged Prime source and AIM's external credential helper for each of managed OpenAI Codex and managed Anthropic Claude, using isolated Prime config/session/daemon paths and current AIM Redis authority.

## 1.4 Out of scope

- Publishing npm packages, creating or moving a version tag, creating a GitHub release, running release scripts, or deploying/installing a bundle.
- Restarting or replacing live Prime Agent daemons, AIM-managed sessions, or agents on any machine.
- Provider testing beyond the two bounded AIM-managed Claude/Codex completions, or any direct use, display, copy, export, or persistence of bearer/refresh credentials.
- Reauthentication, logout, account deletion, account rotation, live-root handoff, or mutation of existing Prime sessions during canary testing.
- Rewriting the daemon architecture, kernel architecture, model generator, or release system beyond what the two lineages require to compose.
- Adding unrelated features, refactoring unaffected files, repairing unrelated dirty work, or changing AIM itself.
- Editing or staging the pre-existing untracked <code>docs/bugs/uv-only-system-kernel-bootstrap.md</code>.
- Contributing changes back to the official upstream repository.

## 1.5 Non-negotiables

- Never use <code>ours</code> or <code>theirs</code> as a whole-file conflict strategy on an overlapping source or test file.
- Never hand-edit <code>packages/ai/src/models.generated.ts</code>; fix or compose <code>packages/ai/scripts/generate-models.ts</code> and regenerate.
- Never weaken AIM credential ownership, copy credentials into transcripts/session files, or expose secrets in test output.
- Never signal a forked kernel by raw PID from Node after the upstream handle protocol is available.
- Never mark an orphan-journal process inactive without confirmed signal delivery or observed exit.
- Never remove the fork's history-disable setting, exit-status evidence, process-lifecycle logs, or generation fencing while adding upstream watchdogs.
- Never send a daemon command until its capability has been negotiated.
- Never reuse a live/default daemon socket or tmux session during smoke testing.
- Never print, inspect, copy, or log AIM-managed access/refresh tokens; prove the boundary through redacted status, exit state, and the model's fixed response only.
- Never run a real canary against the default Prime agent/session directory or daemon socket, and always uninstall the temporary target descriptors after proof.
- Never run locally forbidden broad commands: <code>npm run dev</code>, <code>npm run build</code>, or <code>npm test</code>.
- Run every created or modified test file explicitly from its package root.
- Use npm 11.10 or newer before dependency installation or lockfile work so <code>min-release-age=7</code> is enforced.
- Never use <code>git stash</code>, <code>git reset --hard</code>, <code>git checkout .</code>, <code>git clean</code>, <code>git add .</code>, or <code>git add -A</code>.
- Do not force-push shared history.
- Do not merge the PR without a new explicit approval after all local and CI evidence is available.

# 2. Research Grounding

<!-- project_flow:block:research_grounding:start -->

## 2.1 Repository identity

| Role | Repository/ref | Reviewed value |
|---|---|---|
| Fork remote | <code>git@github.com:aelaguiz/prime-agent.git</code> | <code>origin</code> |
| Fork branch | <code>origin/main</code> | <code>7e7bb45cdfaddc1fa051678714147ae1534698d9</code> |
| Official source | <code>https://github.com/PrimeIntellect-ai/prime-agent.git</code> | fetched into <code>refs/remotes/upstream/main</code> for analysis |
| Official branch | <code>upstream/main</code> | <code>e319a66d7351c75abe7f040d02d9a8d6e25028e9</code> |
| Merge base | both branches | <code>bb61ca21c3e27a5d2af7fab3ab662789a5e478d2</code> |
| Fork-only count | merge base to fork | 42 commits |
| Upstream-only count | merge base to upstream | 16 commits |
| Current fork version | root and workspaces | 0.7.4 |
| Target version | upstream release state | 0.8.0 |

The local repository currently has only <code>origin</code> configured. The analysis fetched the official branch directly without modifying remote configuration. Implementation should add a conventional read-only/fetch upstream remote after verifying its URL.

## 2.2 Lineage shape and target

~~~text
                                     42 fork commits
                                   /------------------> 7e7bb45 (fork pin)
bb61ca2 (merge base) ---------------+
                                   \------------------> e319a66 (upstream pin)
                                     16 upstream commits

target feature branch:

fork pin -- optional plan commit -- M -----------------> integration fixes, if any
                                  /
                         upstream pin
~~~

The target must retain this parent relationship. A squash merge from the feature branch into <code>origin/main</code> would discard the upstream ancestry and is therefore forbidden for this migration.

## 2.3 Current checkout preservation

The reviewed checkout is otherwise clean, but contains one pre-existing untracked user file:

- Path: <code>docs/bugs/uv-only-system-kernel-bootstrap.md</code>
- Size: 80 lines
- SHA-256: <code>7c3673c958717e12b705d0745e992177a081dd6bb9133cfd4351df64010df92c</code>

Implementation must happen in a separate worktree. The file above must remain unmodified and untracked unless Amir separately asks to include it.

## 2.4 Toolchain state

| Tool | Current value | Requirement/action |
|---|---|---|
| Node | 22.19.0 | satisfies repository minimum 22.8 |
| npm | 11.5.1 | insufficient for <code>min-release-age</code>; provision npm 11.10+ |
| uv | 0.9.2 | available |
| Python | 3.14.3 | runtime requires 3.11+ |
| git | 2.50.1 Apple | available |
| GitHub CLI | 2.74.2 | available |
| tmux | 3.5a | available |

The current npm emits an “Unknown project config min-release-age” warning. No dependency installation or lockfile-affecting operation may be accepted until the integration worktree reports npm 11.10 or newer.

## 2.5 Internal anchors

- The prior upstream integration plan and its implementation/audit logs establish the fork's lineage-preserving merge pattern and AIM preservation contract.
- <code>AGENTS.md</code>, the package manifests, <code>.github/workflows/ci.yml</code>, and the official upstream versions of those files are the operational sources of truth.
- The current fork and exact fetched upstream Git objects are the code sources of truth; old plan descriptions are subordinate when they disagree with current code.
- The crash/restart architecture plan and the three linked bug documents explain why process-lifecycle, worker recovery, cross-daemon routing, and shell-channel behavior are preservation requirements.
- <code>git merge-tree</code> supplies the six predicted textual conflicts; the merge-base path intersection supplies the 24 semantic overlaps.
- No unresolved product choice remains for planning. A newly advanced upstream head is a mandatory re-grounding event, not an implementation-time guess.

<!-- project_flow:block:research_grounding:end -->

# Current Architecture

<!-- project_flow:block:current_architecture:start -->

- The fork and official upstream share merge base <code>bb61ca2</code> and then diverge across 42 fork commits and 16 upstream commits.
- The fork owns AIM credential admission/handoff, provider-specific recovery and OAuth behavior, daemon recovery/routing, process diagnostics, and additional kernel lifecycle protections.
- Upstream owns the 0.8.0 release line, changelog fragments, parent-death/handle-based kernel control, ACP MCP, Fast-mode expansion, continuation/refinement/status changes, OAuth discovery, heartbeat filtering, and the newest model snapshot.
- Both lineages modify the daemon schema, kernel parent/child boundaries, agent-session orchestration, provider rails, interactive status, and release metadata. There is no single side whose complete file can be selected safely for those domains.

<!-- project_flow:block:current_architecture:end -->

# Target Architecture

<!-- project_flow:block:target_architecture:start -->

- One fork mainline contains the official upstream head as an ancestor through a two-parent merge.
- Daemon protocol 7/schema 23 is the negotiated union of AIM credential handoff and ACP MCP server capabilities.
- Forked kernel control is request-handle based; parent death, orphan recovery, generation fencing, exit-status files, lifecycle logs, and history isolation operate together.
- Agent-session/refinement/provider flows use upstream's new behavior while retaining fork-owned request admission and credential identity.
- Generated model data has one source of truth: the merged generator.
- Released 0.8.0 changelogs remain immutable; fork-only work continues through fragments.
- Local targeted proof and Linux CI are complementary gates, followed by a reviewable merge-commit PR and explicit approval.

<!-- project_flow:block:target_architecture:end -->

# 3. Upstream change inventory and acceptance map

The following table is the complete reviewed upstream range, oldest first. The final implementation log must record each row as present, deliberately adapted, or blocked; “implicitly included by merge” is not enough for the high-risk rows.

| Commit | Upstream change | Integration concern | Required proof |
|---|---|---|---|
| <code>b5807b6f</code> | Changelog fragments and CI enforcement | Fork has unreleased notes in direct changelogs | Immutable 0.8.0 sections plus fork-only fragments; changelog CI green |
| <code>a3af021c</code> | Dim queue-browse header | Interactive mode overlaps | Focused interactive rendering/service tests |
| <code>addfc23f</code> | Kernels and forkserver exit with owner; handle-based fork control and orphan journal | Direct conflicts with fork lifecycle diagnostics and kernel recovery | Parent watchdog, handle protocol, shutdown/startup, lifecycle, and orphan-journal tests |
| <code>c75a637b</code> | Session-scoped ACP MCP programs | Adds daemon capability/schema and runtime MCP ownership | ACP MCP, MCP manager, agent-connection, protocol, and Python runtime tests |
| <code>bb3ac37f</code> | Bordered subagents summary tile | Fork adds fourth priority-label callback and <code>FAST OFF</code> line | Combined width/focus/count/priority rendering tests |
| <code>848081ed</code> | Fast mode for OpenAI API-key GPT-5.4/5.5/5.6; GPT-5.6 multiplier 2x | Provider files and interactive effort paths overlap | AI fast-mode/provider tests plus coding effort/FAST OFF tests |
| <code>e51d2266</code> | Hold goal continuation until descendant work settles | Agent session overlaps heavily | Goal quiescence and session queue/compaction tests |
| <code>35103cb4</code> | Typed <code>Agent.continue</code> precondition errors | Agent and agent-session error handling | Agent core unit/e2e tests and continuation regression checks |
| <code>48b6478e</code> | Preserve elapsed timer across session re-entry | Interactive status overlap | Status test proving timestamp anchoring |
| <code>108eff32</code> | <code>session_before_refine</code> hook | Fork replaced direct completion with admitted model-registry calls | Extension/refinement tests plus AIM request-admission tests |
| <code>274cbb84</code> | Refinement loader and durable outcome messages | Same refinement/session/UI surfaces | Refinement outcome, print, status, queue, and compaction tests |
| <code>8c749fb9</code> | MCP protected-resource OAuth discovery | Security-sensitive OAuth behavior | AI MCP OAuth tests plus fork endpoint-binding preservation |
| <code>34b294f8</code> | Skip failed workers in heartbeat catalog | Supervisor is heavily fork-modified | Heartbeat, monitor, process, recovery, and compatibility tests |
| <code>a3d86fbe</code> | Refresh MCP providers after add | Fork has MCP credential invalidation and endpoint binding | MCP manager and interactive services tests |
| <code>8d7deeab</code> | Prepare release 0.8.0 | Fork is still 0.7.4 with unreleased work | Root/workspace/lock versions agree at 0.8.0; release sections immutable |
| <code>e319a66d</code> | Regenerate live model catalog | Direct conflict with generated file and fork-only alias | Generator-only reconciliation, catalog delta review, model tests |

# 4. Fork preservation ledger

The fork is not merely a downstream patch stack; it contains runtime contracts relied on by AIM and existing sessions. Each row is a release blocker.

| Domain | Fork contract that must survive | Primary proof surfaces |
|---|---|---|
| AIM credential ownership | AIM remains the source of managed credentials; daemon-restored sessions retain provider-scoped route and generation identity; unsupported peers fail before a handoff write | <code>aim-request-admission</code>, <code>credential-binding-reset</code>, daemon protocol/connection tests |
| AIM daemon wire feature | <code>aim_credential_handoff</code> and <code>handoff_aim_credential</code> remain capability-gated and compatible with revision-21 peers | daemon protocol and worker compatibility tests |
| Codex request identity | Credential-generation identity remains part of request admission and transport/continuation scoping | OpenAI Codex stream and AIM admission tests |
| xAI noninterference | AIM-managed xAI, native SuperGrok OAuth, and API-key xAI remain distinct; login/rebinding does not reshape the wrong rail | <code>xai-aim-noninterference</code>, <code>xai-oauth</code>, auth/model tests |
| Anthropic exhaustion | Subscription usage exhaustion fails fast with reset metadata; generic transient 429 behavior remains retryable | stream-failure and agent-session retry tests |
| Model alias/compaction | <code>gpt-5.6-sol-1m</code> sends <code>gpt-5.6-sol</code>, declares 1M context, and compacts at 900,000 tokens | model registry/resolver, compaction, thinking tests |
| Effort and fast status | Effort selections stay session-local; fork defaults remain; <code>FAST OFF</code> remains bold red for all fast-capable models | effort command, status, subagent-summary, 4620 regressions |
| Daemon reuse/recovery | Wire-compatible daemons are reused; backpressure and no-hello errors do not kill or falsely replace the daemon; failed recovery does not storm | daemon mode/client/supervisor/process regression tests |
| Cross-daemon routing | Attach/resume finds the owning local background service and preserves normalized socket identity | cross-daemon process and daemon client tests |
| Lease compromise | Async daemon/session lock refresh cannot terminate the legitimate owner when the lock is replaced | daemon socket lease compromise tests |
| Process observability | Starts, exits, crashes, signals, restarts, kernel/forkserver lineage, bounded stderr evidence, and privacy projection remain intact | process-lifecycle and daemon catalog/process tests |
| Kernel history and exit evidence | Forked kernel history stays disabled; exit code/signal files remain atomic and observable | forkserver, startup, shutdown, lifecycle tests |
| Kernel shell recovery | Long-lived IPython shell replies are drained and disconnected/wedged shell channels recover correctly | kernel shell-channel/socket tests |
| Kernel bootstrap | Managed Python remains acceptable under uv system-only configuration | kernel startup/bootstrap tests; do not absorb the unrelated untracked bug doc |
| MCP security | Stored credentials remain endpoint-bound; <code>mcp add</code> invalidates name-bound credentials; no ACP configuration reuses persistent OAuth tokens across endpoints | MCP OAuth, MCP manager, ACP MCP tests |

# 5. Merge footprint

## 5.1 Predicted textual conflicts

Read all six files in full at the three relevant versions (merge base, fork pin, upstream pin) before resolving them:

1. <code>packages/ai/src/models.generated.ts</code>
2. <code>packages/coding-agent/src/core/kernel/fork-server-script.ts</code>
3. <code>packages/coding-agent/src/core/kernel/fork-server.ts</code>
4. <code>packages/coding-agent/src/core/kernel/index.ts</code>
5. <code>packages/coding-agent/src/modes/daemon/daemon-protocol.ts</code>
6. <code>packages/coding-agent/test/subagent-summary-line.test.ts</code>

## 5.2 Paths changed by both lineages

Git predicts that 18 of these 24 paths will auto-merge. Every path below still requires semantic inspection:

### Release and generated data

- <code>packages/ai/CHANGELOG.md</code>
- <code>packages/ai/src/models.generated.ts</code>
- <code>packages/coding-agent/CHANGELOG.md</code>

### Provider/model transport

- <code>packages/ai/src/providers/openai-codex-responses.ts</code>
- <code>packages/ai/src/providers/openai-responses.ts</code>
- <code>packages/ai/test/openai-codex-stream.test.ts</code>

### Agent session and refinement

- <code>packages/coding-agent/src/core/agent-session.ts</code>
- <code>packages/coding-agent/src/core/refinement/refinement.ts</code>

### Kernel/forkserver

- <code>packages/coding-agent/src/core/kernel/fork-server-script.ts</code>
- <code>packages/coding-agent/src/core/kernel/fork-server.ts</code>
- <code>packages/coding-agent/src/core/kernel/index.ts</code>

### Connection and daemon

- <code>packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts</code>
- <code>packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts</code>
- <code>packages/coding-agent/src/modes/agent-connection/types.ts</code>
- <code>packages/coding-agent/src/modes/daemon/daemon-mode.ts</code>
- <code>packages/coding-agent/src/modes/daemon/daemon-protocol.ts</code>
- <code>packages/coding-agent/src/modes/daemon/daemon-supervisor.ts</code>

### Interactive UI

- <code>packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts</code>
- <code>packages/coding-agent/src/modes/interactive/interactive-mode.ts</code>

### Overlapping tests

- <code>packages/coding-agent/test/daemon-mode.test.ts</code>
- <code>packages/coding-agent/test/daemon-protocol.test.ts</code>
- <code>packages/coding-agent/test/interactive-mode-effort-command.test.ts</code>
- <code>packages/coding-agent/test/interactive-mode-status.test.ts</code>
- <code>packages/coding-agent/test/subagent-summary-line.test.ts</code>

# 6. Required conflict-resolution contracts

## 6.1 Daemon protocol: compose revision 21 and revision 22 into revision 23

### Inputs

- Fork: protocol 7, schema revision 21, schema ID <code>protocol-7-schema-21-a3a50d3924f1</code>, capability <code>aim_credential_handoff</code>, command <code>handoff_aim_credential</code>.
- Upstream: protocol 7, schema revision 22, schema ID <code>protocol-7-schema-22-4d515169dc6b</code>, capability <code>acp_mcp_servers</code>, command <code>replace_acp_mcp_servers</code>.

### Target

- Keep protocol version 7.
- Set current schema revision to 23 because the merged schema is neither lineage's revision.
- Generate the new schema ID through the repository's schema digest test; do not invent or copy a digest.
- Advertise both capabilities in default/current capability sets.
- Preserve both commands and every response/event shape.
- Keep AIM handoff's historical compatibility floor and capability requirement.
- Keep ACP MCP's introducing floor at schema revision 22 with capability <code>acp_mcp_servers</code>; the current revision being 23 does not rewrite historical compatibility.
- Update daemon mode, daemon connection, in-process connection, supervisor/worker forwarding, and compatibility maps together.

### Required compatibility matrix

| Client | Daemon | Expected behavior |
|---|---|---|
| Fork revision 21, AIM capability only | Combined revision 23 | AIM handoff works; ACP MCP is not assumed |
| Upstream revision 22, ACP capability only | Combined revision 23 | ACP MCP works; AIM handoff is not assumed |
| Combined revision 23 | Fork revision 21 | AIM works; ACP command is rejected locally before write |
| Combined revision 23 | Upstream revision 22 | ACP works; AIM command is rejected locally before write |
| Combined revision 23 | Combined revision 23 | Both features work |
| Any peer without required capability | Any compatible peer | Command is not written to the wire; startup/attach still works |

### Release blockers

- A whole-file choice of revision 21 or 22.
- Reusing either old schema ID.
- Making ACP MCP or AIM handoff part of startup without a capability gate.
- Treating ACP owner IDs as AIM auth-owner IDs.
- Persisting ACP stdio environment or bearer values into sessions/recovery state.

## 6.2 Python forkserver script: owner watchdog plus fork diagnostics

### Preserve from the fork

- Spawn requests carry an <code>exitPath</code>.
- Child exit code/signal is written atomically for Node-side diagnostics.
- IPython persistent history remains disabled with <code>--HistoryManager.enabled=False</code>.
- Exit-path tracking and reaping integrate with the fork's process-lifecycle evidence.

### Adopt from upstream

- A watchdog thread exits the forkserver when its owning Node parent dies.
- Forked kernels receive a parent handle so ipykernel's parent-death behavior is armed.
- Child control uses fork-request IDs/handles rather than raw PID signaling from Node.
- The child registry and PID-to-ID mapping never evict a live entry when bounded history is pruned.
- SIGCHLD is blocked across fork registration so a fast child cannot be reaped before it is registered.
- Reaping and liveness correctly distinguish live, exited, and unknown states.

### Composed design

The child registry entry owns request ID, PID, exit path, and terminal state. The reaper both updates handle-visible liveness and writes the fork's exit-status evidence. A late/abandoned spawn is killed through the forkserver request ID. History remains disabled even though upstream initializes IPython with an empty argument list. Tests must cover a small registry history bound while live children remain addressable.

## 6.3 Node forkserver client: handle control plus durable lifecycle evidence

### Preserve from the fork

- Process instance/parent lineage and launch-trigger logging.
- Bounded forkserver stderr evidence.
- Environment scrubbing through <code>withoutProcessLifecycleEnvironment</code>.
- Per-kernel exit path and restart/failure diagnostics.
- Replacement logic that cannot let stale callbacks delete a successor.

### Adopt from upstream

- <code>ForkedKernelHandle</code> with request-ID-based <code>kill</code> and <code>isAlive</code>.
- Timeout results represented as unknown rather than false.
- Race-safe request/response handling.
- Active/inactive orphan-process journal records.
- Test-only history-bound control.

### Composed design

<code>forkKernel</code> returns a handle and the fork exit-path metadata needed by the kernel owner. Node stores the handle, not merely the PID, for control. Process-lifecycle logs and orphan-journal entries are complementary: the former explains launches/exits/restarts; the latter gives the supervisor a recovery inventory. An inactive journal entry is written only after a confirmed forkserver kill response or observed child exit.

## 6.4 Kernel owner: generation-safe parent death and recovery

### Required direct-kernel behavior

- Build the child environment through the fork's lifecycle scrubber.
- Add <code>JPY_PARENT_PID</code> pointing at the owning Node process.
- Register the PID as active in the orphan journal.
- Keep process-lifecycle launch/exit/startup-failure evidence.
- Mark inactive only after a delivered signal or observed process exit.

### Required forked-kernel behavior

- Store and use <code>ForkedKernelHandle</code> for liveness and shutdown.
- Preserve the fork's exit-path code/signal reporting.
- Keep persistent IPython history disabled.
- Preserve shell-channel drain/disconnect recovery.
- Treat handle timeouts as unknown; do not assume the process is dead and start a duplicate.

### Required shared behavior

- Add upstream's start-generation and ownership fencing so stale startup/shutdown work cannot mutate a successor.
- Keep the fork's process instance IDs, snapshots, recovery logs, startup budgets, and bounded diagnostics associated with the same generation.
- A shutdown result reports whether this generation actually owned and stopped the process.
- No raw <code>process.kill</code> is used to control a forked kernel.

## 6.5 Generated model catalog

### Target behavior

- Preserve upstream's post-0.8.0 catalog snapshot.
- Preserve the fork's <code>gpt-5.6-sol-1m</code> alias, <code>requestModelId: gpt-5.6-sol</code>, 1M declared context, and 900,000-token compaction threshold.
- Preserve fork generator policies that exclude retired/private/raw routes and annotate current thinking levels.
- Preserve upstream's Fast-mode pricing change and provider metadata.

### Resolution sequence

1. Resolve the generated-file conflict to the upstream snapshot only as the generator's seed, not as the final hand-authored result.
2. Compose and fully inspect <code>packages/ai/scripts/generate-models.ts</code>; all custom fields and aliases must be emitted by this source.
3. From <code>packages/ai</code>, run <code>npm run generate-models</code> with the merged generator.
4. Compare the output to both the pinned upstream snapshot and the pre-merge fork snapshot. Classify every provider/model addition, deletion, and metadata change.
5. Run the generator a second time immediately and compare hashes. If live catalogs changed between runs, or the second output is not stable, stop and record the source drift instead of hand-editing.
6. Fix generator/input logic only, regenerate, and rerun model/compaction/provider tests.

Any unrelated live catalog change beyond the pinned upstream snapshot must be called out in the PR as generator-derived drift. If it is broad or unexplained, re-pin upstream or split the catalog refresh; do not hide it in conflict resolution.

## 6.6 Subagent summary tile and priority alarm

### Target

- Adopt upstream's three-line bordered <code>agents</code> tile.
- Preserve running/idle/inactive color and count semantics.
- Preserve selected/focused/open hints and right alignment.
- Preserve ANSI-safe truncation, background fill, and maximum-width guarantees.
- Preserve the fork's fourth constructor callback/priority label and its <code>FAST OFF</code> information line above the tile.
- Keep narrow-terminal behavior legible; no line may exceed the requested width after ANSI stripping.

### Test merge

Combine the fork's priority-label/narrow-width cases with upstream's border, focus, count, selection, ANSI, and width cases. Do not choose either conflicting test file wholesale.

# 7. Call-Site Audit of Auto-Merged and Upstream-Only Flows

<!-- project_flow:block:call_site_audit:start -->

## 7.1 Agent session, goal continuation, typed errors, and timers

Read the complete merged call flow, not only conflict hunks:

1. <strong>Goal continuation:</strong> a parent that ended after delegation remains quiescent while descendant work is unsettled and resumes exactly once after settlement.
2. <strong>Typed continuation errors:</strong> <code>AgentContinueError</code> codes replace message matching without masking unrelated provider/session errors.
3. <strong>Elapsed timer:</strong> re-entry uses the in-flight user/agent message timestamp and never resets an active timer to zero.
4. <strong>Fork request shape:</strong> saved-session and fork rebinding retain provider-scoped credential identity.
5. <strong>Compaction:</strong> per-model thresholds and post-compaction continuation behavior survive.
6. <strong>AIM admission:</strong> compaction, summaries, refinement, and ordinary turns continue to use model-registry request admission.
7. <strong>Retry policy:</strong> AIM usage-limit and Anthropic exhaustion rules remain distinct from transient errors.
8. <strong>ACP settlement:</strong> prompt completion and queue semantics continue to report failures rather than false clean completion.

## 7.2 Refinement hook and durable outcomes

- Upstream's <code>session_before_refine</code> hook may provide, replace, or skip a proposal.
- Hook-supplied proposals pass through normal normalization and apply-time validation.
- Rollback bypasses the hook exactly as upstream specifies.
- Every fallback model call continues through the fork's <code>ModelRegistry</code> request-admission path; no raw API key/header call is reintroduced.
- User-issued refinement exposes a live loader and writes one durable refinement outcome message with expandable diffs.
- Failed/unpersisted outcomes preserve upstream's status semantics without leaking credential data.

## 7.3 ACP session-scoped MCP

- Adopt upstream's stdio and HTTP ACP MCP configuration types, validation, runtime plumbing, and transport cleanup.
- ACP servers are scoped to the ACP session/owner lease and released on detach, failure, replacement, or shutdown.
- A session-scoped server may shadow a persistent same-name server only for that session.
- Persistent stored OAuth credentials are not silently applied to a session-scoped URL.
- Stdio environments are allowlisted/scrubbed and are never serialized into session recovery state.
- Daemon forwarding is guarded by <code>acp_mcp_servers</code>.
- In-process and daemon connections expose the same supported behavior.
- AIM credential owner/generation state remains a separate concern.

## 7.4 Fast mode and provider rails

- OpenAI API-key <code>openai-responses</code> GPT-5.4, GPT-5.5, and GPT-5.6 support priority service tier.
- GPT-5.6 uses the upstream 2x priority-cost multiplier, not 2.5x.
- Codex subscription and API-key transports retain their separate authentication/continuation behavior.
- AIM-managed Codex generation identity still scopes request admission and continuations.
- <code>/fast</code> persistence and service-tier behavior remain model-capability gated.
- The red <code>FAST OFF</code> alarm appears for newly fast-capable API-key models too.
- Session-local effort and fork-specific default thinking levels remain unchanged.

## 7.5 MCP OAuth and refresh

- Adopt protected-resource metadata discovery, including path-scoped/resource-bound refresh.
- Preserve endpoint binding for newly issued and refreshed credentials.
- Legacy unbound credentials remain untrusted until relogin; do not infer a binding.
- <code>mcp add</code> invalidates the stored credential for that name before the new endpoint can use it.
- MCP providers refresh immediately after add/update so the connection can be used without restarting.
- ACP session-scoped configuration never borrows persistent credentials by name.

## 7.6 Heartbeat catalog and recovery

- Exclude terminally failed workers from the global heartbeat catalog as upstream requires.
- Disconnected but non-terminal workers still fail closed.
- Preserve fork worker-recovery retries, backpressure handling, no-hello classification, compatible-daemon reuse, failed-state evidence, and anti-storm behavior.
- A failed worker must not make the entire Agents View heartbeat refresh fail.
- Filtering must not erase the worker from recovery/process-lifecycle diagnostics.

## 7.7 Release tooling, package versions, and repository rules

- Adopt upstream's <code>.changes</code> directories, README files, changelog-fragment workflow, fragment aggregation library, release script, CONTRIBUTING updates, and updated <code>AGENTS.md</code>.
- Do not run <code>release:patch</code>, <code>release:minor</code>, <code>release:major</code>, publish, or tag commands.
- Accept upstream's 0.8.0 root/workspace versions and synchronized internal dependency ranges.
- Verify the root lockfile reports version 0.8.0 for the root and all published workspaces.
- Do not introduce a dependency update beyond the pinned upstream lockfile unless separately reviewed under the seven-day policy.

<!-- project_flow:block:call_site_audit:end -->

# 8. Changelog migration specification

The fork's current <code>[Unreleased]</code> blocks are a mixture of:

1. entries already present at the merge base and now correctly released in upstream's immutable 0.8.0 sections; and
2. fork-only entries added after the merge base that still need future-release fragments.

Taking all current unreleased bullets would duplicate already-released 0.8.0 notes. Taking upstream changelogs without fragments would erase fork-only notes.

## 8.1 Required resolution

1. Preserve upstream's released <code>## [0.8.0] - 2026-08-21</code> sections exactly.
2. Use <code>git diff bb61ca2..7e7bb45 -- packages/ai/CHANGELOG.md packages/coding-agent/CHANGELOG.md</code> as the authoritative source of fork-only additions.
3. Create exactly one integration fragment per affected package:
   - <code>packages/ai/.changes/fork-upstream-0-8-0.md</code>
   - <code>packages/coding-agent/.changes/fork-upstream-0-8-0.md</code>
4. Put each user-visible entry on one plain past-tense bullet line, with no Added/Fixed subsection headings.
5. Do not copy the merge-base entries that upstream already folded into 0.8.0.
6. Preserve upstream's existing <code>packages/ai/.changes/regenerate-model-catalog.md</code>.
7. Do not create a new agent fragment for <code>AgentContinueError</code>; that source change is already documented in upstream's immutable agent 0.8.0 changelog. Apply the PR's explicit <code>no-changelog</code> label to satisfy the downstream integration edge case, and explain the exception in the PR body.

## 8.2 Fork-only AI bullets to preserve

- GPT-5.6 Sol 1M Codex alias.
- xAI SuperGrok/X Premium device-code OAuth and Responses rail rebinding, including Grok 4.6.
- Anthropic subscription usage-exhaustion classification and reset metadata.

The endpoint-binding bullet is already in upstream 0.8.0 and must not be duplicated in the new fragment.

## 8.3 Fork-only coding-agent bullets to preserve

- Worker RPC backpressure/recovery-storm/no-hello/live-chunk fixes.
- Reuse of wire-compatible daemons.
- Durable process/kernel crash, signal, restart, and diagnostic logs.
- Managed Python acceptance under uv system-only configuration.
- Daemon/session lockfile compromise handling.
- Cross-daemon attach discovery.
- Long-lived IPython shell-channel recovery.
- AIM <code>/usage</code> trusted-executable handling.
- Bold red <code>FAST OFF</code> alarm.
- Provider-scoped credential rebinding on fork.
- Per-model compaction threshold and GPT-5.6 Sol 1M threshold.
- Session-local effort and fork default effort levels.
- xAI subscription login/live-session rebinding.
- Restored daemon AIM credential route.
- AIM-managed Claude usage-limit fail-fast behavior.

The 15 entries already present at the merge base are released by upstream 0.8.0 and must not be copied into the new fragment.

# 9. Granular implementation plan

<!-- project_flow:block:phase_plan:start -->

## Phase 0 - Refresh, freeze, isolate, and baseline

### Objective

Create a clean, reproducible integration environment without touching the reviewed checkout or live Prime Agent state.

### Steps

- [ ] Verify the current checkout status and re-check the untracked bug document hash. Stop if any new tracked modification exists.
- [ ] Verify <code>origin</code> still points to <code>git@github.com:aelaguiz/prime-agent.git</code>.
- [ ] Add <code>upstream</code> only if absent, using <code>https://github.com/PrimeIntellect-ai/prime-agent.git</code>; if present, verify its URL rather than overwriting it.
- [ ] Fetch and prune <code>origin</code> and <code>upstream</code>, including tags.
- [ ] Record new exact fork head, upstream head, merge base, divergence counts, commit inventory, diff stat, overlapping paths, and <code>git merge-tree</code> conflicts in the implementation log.
- [ ] If upstream is not <code>e319a66d</code>, perform a delta review, update Sections 2-8 and the test matrix, and obtain a new plan-ready state before proceeding.
- [ ] If <code>origin/main</code> advanced, inspect its new commits and update the fork pin/preservation ledger.
- [ ] Create feature branch <code>integrate/upstream-0.8.0-20260822</code> from the refreshed fork pin in a new worktree such as <code>/Users/aelaguiz/workspace/prime-agent-upstream-0.8.0-20260822</code>. If either name/path already exists, choose a new explicit suffix; do not delete or reuse unknown work.
- [ ] Add this canonical plan file to the feature branch as a scoped documentation commit before source integration.
- [ ] Provision npm 11.10 or newer and record <code>node --version</code>, <code>npm --version</code>, <code>uv --version</code>, and <code>python3 --version</code>.
- [ ] Run <code>npm ci</code> in the clean worktree with the refreshed npm. Confirm it does not change <code>package-lock.json</code>.
- [ ] Record a baseline <code>git status --short --branch</code>.

### Reference command sequence

~~~sh
PA_REPO=/Users/aelaguiz/workspace/prime-agent
PA_WORKTREE=/Users/aelaguiz/workspace/prime-agent-upstream-0.8.0-20260822
PA_BRANCH=integrate/upstream-0.8.0-20260822

cd "$PA_REPO"
git status --short --branch
git remote -v
git fetch --prune origin main
git fetch --prune --tags upstream main
git rev-parse origin/main upstream/main
git merge-base origin/main upstream/main
git rev-list --left-right --count origin/main...upstream/main
test ! -e "$PA_WORKTREE"
git worktree add "$PA_WORKTREE" -b "$PA_BRANCH" origin/main
~~~

Do not put secrets, live provider variables, or default daemon paths into the implementation log.

### Baseline fork-contract tests

Run these from their package roots before merging. They establish whether a later failure is introduced by integration.

From <code>packages/ai</code>:

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/openai-codex-stream.test.ts test/mcp-oauth.test.ts test/supports-xhigh.test.ts test/stream-failure.test.ts test/xai-oauth.test.ts
~~~

From <code>packages/coding-agent</code>:

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/aim-request-admission.test.ts test/aim-usage.test.ts test/auth-storage.test.ts test/credential-binding-reset.test.ts test/xai-aim-noninterference.test.ts test/model-registry.test.ts test/model-resolver.test.ts test/sdk-thinking-defaults.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-mode.test.ts test/daemon-protocol.test.ts test/daemon-client.test.ts test/daemon-launch.test.ts test/daemon-supervisor-heartbeats.test.ts test/daemon-supervisor-monitor.test.ts test/daemon-worker-client-compatibility.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-fork-server.test.ts test/kernel-startup.test.ts test/kernel-shutdown.test.ts test/kernel-shell-channel.test.ts test/orphan-process-journal.test.ts test/process-lifecycle-process.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-effort-command.test.ts test/interactive-mode-status.test.ts test/subagent-summary-line.test.ts test/suite/agent-session-compaction.test.ts test/suite/agent-session-retry-events.test.ts test/suite/regressions/4620-fast-mode-settings.test.ts
~~~

Record pre-existing failures exactly. Do not “fix” a baseline failure inside the upstream merge without classifying it and updating scope.

### Exit criteria

- Fresh refs and environment are recorded.
- The new worktree is clean and isolated.
- npm 11.10+ is active and <code>npm ci</code> leaves the lockfile unchanged.
- Baseline preservation tests are green or any pre-existing failure is documented and explicitly dispositioned.

## Phase 1 - Start the lineage-preserving merge and resolve all composition points

### Objective

Create one two-parent merge candidate that contains the complete upstream range and the fork's semantic contracts.

### Steps

- [ ] From the feature worktree, create the merge with <code>git merge --no-ff --no-commit UPSTREAM_PIN</code>.
- [ ] Verify the unresolved set matches the predicted six files. If it differs, stop and update the conflict map.
- [ ] For each conflict, open the complete merge-base, fork, upstream, and working-tree files before editing.
- [ ] Resolve the daemon protocol to revision 23 with both capabilities and a digest-derived schema ID.
- [ ] Resolve Python forkserver, Node forkserver, and kernel owner as the composed design in Section 6.
- [ ] Resolve the generated catalog through the generator sequence, never by manual line editing.
- [ ] Resolve the subagent-summary test by combining both behavior sets.
- [ ] Replace direct fork <code>[Unreleased]</code> additions with the two fragments in Section 8 while retaining immutable upstream 0.8.0 sections.
- [ ] Inspect all 24 overlapping paths and every new high-risk call site in Section 7.
- [ ] Add or adjust focused tests for any composed behavior not already covered.
- [ ] Search the entire worktree for conflict markers.
- [ ] Stage only explicit reviewed paths. Never stage the whole repository.
- [ ] Before committing, inspect the staged diff and verify no user/unrelated files are included.
- [ ] Commit the merge. Record both parents and the resulting tree hash.

### Merge verification commands

~~~sh
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>)' .
git diff --check
git status --short
git diff --cached --stat
git diff --cached
~~~

After committing:

~~~sh
git show --no-patch --format='%H%n%P%n%s' HEAD
git merge-base --is-ancestor "$PA_FORK_PIN" HEAD
git merge-base --is-ancestor "$PA_UPSTREAM_PIN" HEAD
~~~

### Exit criteria

- There are no unresolved conflicts or conflict markers.
- The merge commit has the expected fork-side and upstream parents.
- Both immutable pins are ancestors.
- All six explicit conflict contracts and 24 overlap audits are logged.
- Released changelogs, fragments, versions, lockfile, and generator output are coherent.

## Phase 2 - Focused upstream and preservation test matrix

### Objective

Exercise every upstream-changed test file plus the fork regression surfaces most likely to be affected by semantic composition.

### Rules

- Run from each package root.
- Use the repository-approved specific-file Vitest invocation.
- Do not use <code>npm test</code>, <code>npm run build</code>, or <code>npm run dev</code> locally.
- If a test file is changed during integration, rerun that exact file after every relevant fix.
- Suite tests must use their faux provider/harness only.
- Do not provide real API keys or paid tokens.
- Capture full output for failures and final green receipts.

### Agent core: upstream typed continuation errors

From <code>packages/agent</code>:

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent.test.ts test/e2e.test.ts
~~~

### AI: Fast mode, OAuth, Codex transport, and catalog preservation

From <code>packages/ai</code>:

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/fast-mode.test.ts test/mcp-oauth.test.ts test/openai-codex-stream.test.ts test/supports-xhigh.test.ts test/stream-failure.test.ts test/xai-oauth.test.ts test/prime-inference-models.test.ts
~~~

### Coding agent: every upstream-changed unit/suite test

From <code>packages/coding-agent</code>:

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/acp-mcp.test.ts test/agent-connection-daemon.test.ts test/agent-session-services.test.ts test/daemon-mode.test.ts test/daemon-protocol.test.ts test/daemon-supervisor-heartbeats.test.ts test/goal-continuation-quiescence.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-effort-command.test.ts test/interactive-mode-services.test.ts test/interactive-mode-status.test.ts test/mcp-manager.test.ts test/print-mode.test.ts test/refinement-outcome-message.test.ts test/subagent-summary-line.test.ts test/system-prompt.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-fork-server-protocol.test.ts test/kernel-parent-watchdog.test.ts test/kernel-shutdown.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-compaction.test.ts test/suite/agent-session-queue.test.ts test/suite/agent-session-refine-extension.test.ts test/suite/regressions/4620-fast-mode-settings.test.ts
~~~

### Coding agent: fork auth/model/refinement preservation

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/aim-request-admission.test.ts test/aim-usage.test.ts test/auth-storage.test.ts test/credential-binding-reset.test.ts test/xai-aim-noninterference.test.ts test/model-registry.test.ts test/model-resolver.test.ts test/sdk-thinking-defaults.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/refinement.test.ts test/suite/agent-session-refine-skill.test.ts test/suite/agent-session-compaction-continuation.test.ts test/suite/agent-session-retry-events.test.ts test/suite/regressions/4620-fast-mode-child-agents.test.ts test/suite/regressions/4620-fast-mode-empty-resume.test.ts
~~~

### Coding agent: fork daemon/recovery/lease preservation

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-client.test.ts test/daemon-client-env.test.ts test/daemon-launch.test.ts test/daemon-launch-lease-process.test.ts test/daemon-runtime-identity.test.ts test/daemon-runtime-lease.test.ts test/daemon-supervisor-monitor.test.ts test/daemon-worker-client-compatibility.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-socket-lease-compromise.test.ts test/daemon-socket-lease-compromise-process.test.ts test/main-cross-daemon-resume-process.test.ts test/daemon-catalog-process.test.ts test/daemon-catalog-lifecycle-process.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run test/daemon-supervisor-process.test.ts
~~~

### Coding agent: composed kernel/process lifecycle preservation

~~~sh
npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-fork-server.test.ts test/kernel-startup.test.ts test/kernel-shell-channel.test.ts test/kernel-socket-closure.test.ts test/orphan-process-journal.test.ts test/process-lifecycle-process.test.ts

npx tsx ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism --tagsFilter kernel-heavy test/acp-kernel-features.test.ts test/kernel-mcp-shutdown.test.ts test/kernel-state-roundtrip.test.ts
~~~

Platform note: some real forkserver behavior is unavailable or skipped on macOS. A local skip is not a pass for Linux-only parent/fork behavior; the PR's Linux coding-agent kernel and process jobs remain mandatory.

### Python runtime MCP

From <code>prime-agent-runtime</code>:

~~~sh
uv run python -m unittest test.test_mcp
~~~

If merged runtime support changes shared MCP primitives beyond <code>test_mcp.py</code>, also run the exact affected runtime files, such as <code>test.test_mcp_base</code>; the full runtime suite remains a CI gate.

### Failure handling

For every failure:

1. Save the exact command and complete output.
2. Classify it as pre-existing, upstream regression, fork-preservation regression, composition bug, platform skip, or environment failure.
3. Fix only implementation/composition failures in scope.
4. Rerun the failing file and its adjacent contract group.
5. Record the final green receipt and commit the repair as a focused follow-up if the merge commit has already been created.

### Exit criteria

- Every upstream-changed test file listed above passes locally where supported.
- Every fork preservation group passes.
- Every changed test file has an explicit final pass receipt.
- Platform skips are enumerated and mapped to mandatory Linux CI jobs.

## Phase 3 - Static validation, generated-output verification, and local isolated smoke

### Objective

Prove repository consistency and a real source launch without touching live state.

### Static and generated checks

- [ ] Run the model generator twice as described in Section 6.5 and record hashes/provider counts/delta classification.
- [ ] Run <code>npm run check</code> once from repository root and capture full output.
- [ ] Inspect any formatting writes from <code>npm run check</code>; stage only intended files and rerun until the output is clean.
- [ ] Run <code>git diff --check</code>.
- [ ] Verify package versions/internal ranges/lockfile are all 0.8.0.
- [ ] Verify every changed package with source changes has one new integration fragment or a documented upstream fragment.
- [ ] Verify no released changelog section differs from the pinned upstream version except historical content that predated the merge base.
- [ ] Verify the generated file differs only as explained by the merged generator and reviewed live snapshot.
- [ ] Verify no forbidden broad local command was run.

### Isolated source smoke

Use only application-specific temporary directories. Do not redefine the shell's <code>HOME</code>, do not use the default Prime Agent daemon socket, and do not kill any pre-existing tmux session.

~~~sh
PA_SMOKE_ROOT=$(mktemp -d /tmp/prime-agent-upstream-080.XXXXXX)
PA_SMOKE_SOCKET="$PA_SMOKE_ROOT/daemon.sock"
PA_SMOKE_TMUX="prime-agent-upstream-080-$PPID"

mkdir -p "$PA_SMOKE_ROOT/agent" "$PA_SMOKE_ROOT/sessions" "$PA_SMOKE_ROOT/supervisor"

env PRIME_AGENT_CODING_AGENT_DIR="$PA_SMOKE_ROOT/agent" PRIME_AGENT_SESSION_DIR="$PA_SMOKE_ROOT/sessions" PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR="$PA_SMOKE_ROOT/supervisor" ./prime-agent.sh --no-env --daemon-socket "$PA_SMOKE_SOCKET" --help

tmux new-session -d -s "$PA_SMOKE_TMUX" -x 80 -y 24
tmux send-keys -t "$PA_SMOKE_TMUX" "cd /Users/aelaguiz/workspace/prime-agent-upstream-0.8.0-20260822 && env PRIME_AGENT_CODING_AGENT_DIR=$PA_SMOKE_ROOT/agent PRIME_AGENT_SESSION_DIR=$PA_SMOKE_ROOT/sessions PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=$PA_SMOKE_ROOT/supervisor ./prime-agent.sh --no-env --daemon-socket $PA_SMOKE_SOCKET" Enter
tmux capture-pane -t "$PA_SMOKE_TMUX" -p
~~~

The operator should use short, non-blocking waits between tmux operations, capture the startup screen, exercise only no-provider navigation/status paths, and then exit cleanly. This no-provider smoke is separate from the two explicitly authorized AIM canaries below. The bordered agents tile, <code>FAST OFF</code>, refinement, and ACP behavior are proven through deterministic tests rather than a live model.

Cleanup is limited to the exact unique test identities:

~~~sh
tmux kill-session -t "$PA_SMOKE_TMUX"
env PRIME_AGENT_CODING_AGENT_DIR="$PA_SMOKE_ROOT/agent" PRIME_AGENT_SESSION_DIR="$PA_SMOKE_ROOT/sessions" PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR="$PA_SMOKE_ROOT/supervisor" ./prime-agent.sh --no-env --daemon-socket "$PA_SMOKE_SOCKET" shutdown
~~~

Before removing temporary files, verify no process still references <code>PA_SMOKE_ROOT</code>. Use a recoverable or explicit exact-path cleanup operation only; never use a broad variable, glob, workspace root, or home directory.

### Smoke acceptance

- Source <code>--help</code> starts and reports the merged CLI/version surface.
- The TUI starts at 80x24 using the unique config/session/supervisor/socket paths.
- No credential is requested or used.
- The unique daemon can be listed/shut down without affecting existing daemons.
- The unique tmux session and daemon exit; no PID remains for the smoke root.
- No live/default Prime Agent state changed.

### AIM-managed Claude and Codex canaries

The 2026-08-23 authorization permits exactly one short successful completion per provider after deterministic tests and static checks are green.

1. Create a second unique temporary Prime agent directory, session directory, supervisor registry, and daemon socket. Do not redefine <code>HOME</code>; AIM must continue to read its current Redis configuration and account authority.
2. Point <code>PRIME_AGENT_CODING_AGENT_DIR</code> at that temporary agent directory and run current AIMGR from <code>/Users/aelaguiz/workspace/aimgr</code>.
3. Install both temporary descriptors with <code>aim prime use --codex auto --claude fable</code>. Record only the redacted receipt and selected non-secret labels/identity fingerprints.
4. Run <code>aim prime status</code> against the same temporary agent directory and prove both providers are externally managed with Redis coordination available.
5. Launch the merged Prime source directly, not a previously installed bundle, in print mode with the temporary paths:
   - Codex: provider <code>openai-codex</code>, model <code>gpt-5.6-sol</code>, fixed prompt requesting exactly <code>AIM_CODEX_OK</code>.
   - Claude: provider <code>anthropic</code>, model <code>claude-fable-5</code>, fixed prompt requesting exactly <code>AIM_CLAUDE_OK</code>.
6. Give each process a bounded outer timeout. A successful proof requires exit status zero, the exact fixed response, no helper/auth/protocol error, no token-shaped output, and no surviving helper/Prime/kernel/daemon process under the temporary paths.
7. If a selected account is provider-exhausted or policy-blocked, record the typed provider result, select another eligible AIM label through the normal <code>aim prime use</code> owner, and retry only until one successful completion is obtained. Do not reauthenticate, log out, or change live roots.
8. Run <code>aim prime uninstall --provider openai-codex</code> and <code>aim prime uninstall --provider anthropic</code> against the temporary agent directory, confirm the temporary <code>auth.json</code> contains neither managed descriptor, and preserve only redacted evidence.

The canary is a release blocker: reaching the provider with valid auth but receiving a quota/policy error is useful diagnosis, not a successful Claude/Codex completion.

## Phase 4 - Separate read-only implementation audit

### Objective

Perform a fresh audit after implementation and local verification. This pass identifies findings only; it does not modify code. Any finding reopens the appropriate earlier phase, followed by another audit.

### Audit checklist

- [ ] Verify both frozen pins are ancestors of <code>HEAD</code>.
- [ ] Compare the final tree against upstream for every file in the 16-commit range and explain every fork-side deviation.
- [ ] Re-run <code>git merge-tree</code> conceptually against the frozen inputs and confirm all predicted conflicts are represented in the final resolution.
- [ ] Inspect all 24 overlapping paths in full.
- [ ] Search for old schema revision/ID assumptions, incomplete capability maps, unguarded new commands, and missing peer-matrix cases.
- [ ] Verify schema revision 23's ID is generated by the digest test.
- [ ] Search kernel code for raw PID signaling of forked kernels.
- [ ] Trace every direct and forked kernel start/stop/exit path, journal write, generation transition, exit-status write, and lifecycle event.
- [ ] Verify <code>HistoryManager.enabled=False</code> remains active for forked/direct paths where required.
- [ ] Trace ACP MCP ownership through validation, connection, daemon, kernel runtime, replacement, detach, and failure cleanup.
- [ ] Trace every refinement model call through request admission.
- [ ] Trace goal continuation, typed error handling, timer timestamp selection, and MCP refresh.
- [ ] Verify Fast-mode capability and 2x pricing across API-key/Codex/AIM rails.
- [ ] Verify <code>gpt-5.6-sol-1m</code>, request-model ID, context, and compaction threshold in generated output and source generator.
- [ ] Compare current changelog fragments to only the fork additions after the merge base; search for duplicated base/0.8.0 bullets.
- [ ] Verify all package/lock versions and internal dependency ranges.
- [ ] Search for conflict markers, temporary debug code, skipped/focused tests, broad <code>any</code>, dynamic imports, and secret-like values.
- [ ] Confirm the pre-existing untracked bug document is unchanged in the original worktree and absent from the branch unless separately authorized.
- [ ] Reconcile every acceptance item with a named local receipt or CI gate.

### Suggested read-only searches

~~~sh
git merge-base --is-ancestor "$PA_FORK_PIN" HEAD
git merge-base --is-ancestor "$PA_UPSTREAM_PIN" HEAD
rg -n 'DAEMON_SCHEMA_REVISION|DAEMON_SCHEMA_ID|aim_credential_handoff|acp_mcp_servers|handoff_aim_credential|replace_acp_mcp_servers' packages/coding-agent/src packages/coding-agent/test
rg -n 'process\.kill|ForkedKernelHandle|HistoryManager\.enabled=False|JPY_PARENT_PID|exitPath|orphan' packages/coding-agent/src/core/kernel packages/coding-agent/test
rg -n 'gpt-5\.6-sol-1m|requestModelId|compactionThreshold' packages/ai/scripts packages/ai/src packages/coding-agent/src packages/coding-agent/test
rg -n '^(<<<<<<<|=======|>>>>>>>)' .
git diff --check
~~~

### Audit result format

Append a dated implementation-audit block to this document containing:

- audited commit;
- frozen fork/upstream pins;
- findings ordered by severity with file/line evidence;
- acceptance items proven;
- tests/checks reviewed;
- unproven or platform-dependent items;
- disposition: pass, or reopen named phase.

### Exit criteria

- The audit reports no unresolved correctness, security, protocol, lineage, release-metadata, or preservation finding.
- Any reopened phase has been repaired, retested, and re-audited in a new read-only pass.

## Phase 5 - Synchronize the feature branch and open the draft PR

### Objective

Move the locally proven integration into a reviewable remote branch without merging it.

### Steps

- [ ] Fetch <code>origin/main</code> again.
- [ ] If <code>origin/main</code> advanced, read the new commits, merge the latest <code>origin/main</code> into the feature branch, resolve semantically, and rerun the smallest affected local matrix plus <code>npm run check</code>. Do not rebase away the upstream merge ancestry.
- [ ] Verify the branch is ahead only by the plan, upstream merge, and intentional integration fixes.
- [ ] Review every commit and complete diff.
- [ ] Push the named feature branch without force.
- [ ] Open a draft PR targeting <code>aelaguiz/prime-agent:main</code>.
- [ ] Use a technical PR description containing exact pins, merge base, upstream commit ledger, six conflict resolutions, 24-path semantic audit, schema-23 decision, model/changelog strategy, local test receipts, platform skips, and rollback.
- [ ] Apply the <code>no-changelog</code> label with a PR-body explanation that the agent-core source delta is already documented in immutable upstream 0.8.0; retain and manually audit the fork-only AI/coding-agent fragments despite the global workflow opt-out.
- [ ] Mark the PR ready only after local evidence and the separate implementation audit pass.

### Suggested commit structure

1. <code>docs: plan Prime Agent upstream 0.8.0 integration</code>
2. <code>Merge official upstream main at UPSTREAM_PIN</code> as the two-parent merge commit containing semantic conflict resolution.
3. Focused follow-up commits only if tests expose a composition defect, for example protocol/kernel/refinement fixes; do not mix unrelated cleanup.

The exact structure may vary if Git requires test adjustments inside the merge commit, but upstream ancestry and reviewable intent must remain obvious.

### Exit criteria

- Draft PR exists against the correct fork <code>main</code>.
- Remote branch matches the locally tested commit.
- No force push, publish, tag, release, deployment, or merge occurred.

## Phase 6 - Full CI and review follow-through

### Required GitHub checks

The PR is not green until all of these succeed:

- Changelog fragment.
- Contributor trust, with downstream jobs actually allowed to run.
- Build and check: <code>npm ci</code>, <code>npm run build</code>, <code>npm run check</code>.
- Agent core tests.
- AI tests.
- TUI tests.
- Coding-agent shards 1/3, 2/3, and 3/3.
- Coding-agent process smoke.
- Coding-agent kernel.
- Runtime Python.
- Aggregate <code>build-check-test</code>.

The repository forbids broad build/test commands locally; CI is the mandatory full-suite and Linux proof surface. A skipped job is not equivalent to success. If contributor trust prevents the jobs from running, obtain the required repository vouch/authorization rather than declaring the PR tested.

The changelog job may report success through the explicit <code>no-changelog</code> label. That exception is necessary because this downstream integration changes <code>packages/agent/src</code> with behavior already released and documented in upstream 0.8.0; creating an agent fragment would duplicate it in the next release. The AI and coding-agent fork-only fragments remain mandatory by this plan and must be reviewed manually even though the label short-circuits workflow enforcement.

### Review loop

- [ ] Inspect every failure from its full log.
- [ ] Reproduce with the narrowest permitted local test when possible.
- [ ] Fix only in-scope composition defects.
- [ ] Run the modified test file and adjacent contract group locally.
- [ ] Run root <code>npm run check</code> after code changes.
- [ ] Push the focused repair, wait for the complete CI matrix again, and update the implementation log.
- [ ] Address every review comment; resolve a thread only when the code/evidence actually answers it.
- [ ] Repeat the read-only implementation audit if a repair touches protocol, kernel, credentials, generated models, release metadata, or another high-risk contract.

### Exit criteria

- All required checks succeed on the exact PR head.
- Review findings are closed with evidence.
- Local receipts and audit correspond to the same commit.
- The PR remains unmerged pending explicit approval.

## Phase 7 - Explicit approval, merge into origin/main, and verify

### Approval gate

Present Amir with:

- exact PR URL and head SHA;
- fork/upstream pins and merge commit parents;
- local targeted-test totals/results;
- root check result;
- isolated smoke result;
- implementation-audit result;
- complete CI job list and conclusion;
- known platform skips/remaining risks;
- rollback method.

Do not merge until Amir explicitly says to merge the green PR. The original request for a plan is not that final approval.

### Merge method

- Use GitHub's ordinary merge-commit strategy.
- Do not squash or rebase-merge.
- Do not force-push <code>main</code>.
- Do not tag, publish, or deploy.

### Post-merge verification

After GitHub reports success:

~~~sh
git fetch --prune origin main
git rev-parse origin/main
git merge-base --is-ancestor "$PA_FORK_PIN" origin/main
git merge-base --is-ancestor "$PA_UPSTREAM_PIN" origin/main
git log --first-parent --oneline -n 12 origin/main
~~~

Also verify:

- the PR merge commit is on <code>origin/main</code>;
- the complete CI result still corresponds to the merged tree;
- released changelogs/fragments and package versions are present;
- no feature branch or worktree is deleted during the verification window;
- no daemon/session/release/deployment action was triggered.

The local primary checkout may be fast-forwarded only if doing so does not overwrite its pre-existing untracked document. Verify status first and use a non-destructive fast-forward; otherwise leave it alone and report that manual synchronization is pending.

<!-- project_flow:block:phase_plan:end -->

# 10. Validation coverage matrix

| Contract | Local deterministic proof | Full/remote proof |
|---|---|---|
| Upstream ancestry | <code>merge-base --is-ancestor</code> for both pins | post-merge remote ancestry |
| Changelog fragments | direct fragment/released-section review | changelog-fragment workflow |
| Version 0.8.0 | package/lock inspection | build/check |
| Kernel parent death | parent-watchdog and startup tests | Linux kernel job |
| Fork handle/PID reuse | forkserver protocol, shutdown, orphan tests | process + kernel jobs |
| Fork lifecycle evidence | process lifecycle, forkserver/startup tests | coding-agent shards/process |
| ACP MCP | ACP MCP, connection, protocol, runtime MCP tests | coding-agent shards + runtime |
| Fast API-key mode | AI fast mode/OpenAI stream tests | AI + coding-agent suites |
| Goal quiescence | goal continuation and queue/compaction tests | coding-agent shards |
| Typed continue errors | agent unit/e2e | agent-core job |
| Timer continuity | interactive status | coding-agent shards |
| Refinement hook/outcomes | refine extension/outcome/admission tests | coding-agent shards |
| MCP OAuth discovery | AI MCP OAuth | AI job |
| Failed-worker heartbeat | heartbeat/monitor/process tests | coding-agent process/shards |
| MCP provider refresh | MCP manager/services | coding-agent shards |
| Model catalog/alias | generator twice, model/compaction tests | build regeneration + AI/coding jobs |
| AIM credential continuity | AIM admission/rebind/protocol tests | coding-agent shards |
| xAI/Claude fork behavior | xAI/auth/stream/retry tests | AI + coding-agent suites |
| UI composition | subagent summary/effort/status | TUI + coding-agent tests |
| Real source startup | isolated no-provider tmux smoke | build/check/browser smoke |

# 11. Risk register

| Risk | Likelihood | Impact | Mitigation / stop condition |
|---|---|---|---|
| Upstream advances after this plan | Medium | High | Fetch immediately; update pin, inventory, conflicts, and plan before merge |
| Auto-merge silently drops a fork contract | High | High | Full 24-path audit, preservation ledger, targeted regressions, separate audit |
| Schema 21/22 union is mislabeled or ungated | High | Critical | Revision 23, digest test, five-way compatibility matrix, pre-write capability checks |
| Raw PID race returns through a fork diagnostic path | Medium | Critical | Handle-only fork control, search audit, watchdog/orphan/process tests |
| Parent watchdog removes exit evidence/history isolation | Medium | High | Explicit composed forkserver design and assertions |
| Stale start/shutdown mutates a successor kernel | Medium | Critical | Generation/ownership fencing and startup/shutdown race tests |
| ACP MCP leaks env/token or survives detach | Medium | Critical | Session owner lease, scrubbed env, no persistent OAuth reuse, failure cleanup tests |
| Refinement bypasses AIM request admission | Medium | Critical | Trace every completion call and run AIM admission plus extension tests |
| Model generator introduces unexplained live drift | High | High | Upstream seed, two runs/hashes, provider delta review, stop on instability |
| Fork-only notes are duplicated or erased | High | Medium | Merge-base diff classification and one fragment per affected package |
| npm 11.5 ignores release-age policy | Certain in current shell | Medium | Require npm 11.10+ before <code>npm ci</code>; record version |
| macOS skips Linux forkserver behavior | High | High | Mandatory Linux process/kernel CI, no skip-as-pass |
| Smoke test attaches to a live daemon | Low | Critical | Unique agent/session/supervisor/socket/tmux identities and exact cleanup |
| PR CI is skipped by trust gate | Medium | High | Require actual success, obtain vouch/authorization |
| Squash merge loses upstream ancestry | Medium | High | Merge-commit-only rule and post-merge ancestor checks |
| Main advances during review | Medium | Medium | Merge latest main into feature, rerun affected proof, re-audit high-risk changes |

# 12. Rollback and recovery

## 12.1 Before push

The integration is isolated in a named worktree/feature branch, so <code>origin/main</code> and live runtime state remain unchanged. On a failed attempt:

1. Preserve the implementation log and failing receipts.
2. If a merge is still in progress, abort it only inside the exact integration worktree.
3. Do not reset or clean the primary checkout.
4. Recreate a fresh explicitly named worktree/branch from the frozen fork pin if the attempt is not trustworthy.
5. Do not delete the failed worktree/branch until the useful evidence is preserved and Amir approves cleanup.

## 12.2 After push but before merge

- Close or leave the draft PR with a technical explanation.
- Keep <code>origin/main</code> untouched.
- Push corrections as ordinary commits; no force push.
- If the selected upstream pin is wrong, close the PR and create a fresh branch/PR with a corrected plan and ancestry.

## 12.3 After merge

Because this plan does not deploy, rollback is source-control-only:

1. Open a normal revert PR against the integration/PR merge commit.
2. Use a merge-aware revert that preserves history; never reset or force-push <code>main</code>.
3. Run the same relevant targeted tests, root check, audit, and CI.
4. Obtain explicit approval and merge the revert PR normally.
5. Do not delete changelog/history evidence or rewrite released upstream ancestry.

If packages have somehow been published or software deployed, that is an out-of-scope state change and requires a separate release/deployment rollback plan rather than improvising here.

# 13. Decision log

| Decision | Rationale |
|---|---|
| Merge official upstream rather than cherry-pick 16 commits | Preserves provenance, guarantees complete ancestry, and simplifies future upstream merges |
| Pin exact SHAs and refresh at execution time | “Latest” is time-sensitive; exact evidence prevents racing a moving branch |
| Use a separate worktree | Protects the user's untracked document and avoids contaminating the reviewed checkout |
| Use daemon schema revision 23 | The union of independent schema 21 and 22 additions is a new schema |
| Preserve protocol version 7 | Both features are optional/capability-gated and do not require a protocol-version break |
| Compose kernel handle control with lifecycle/exit evidence | Upstream fixes ownership/PID races; fork evidence and recovery behavior remain valuable and non-conflicting |
| Regenerate models from source | Repository rules forbid direct edits and the fork alias must remain reproducible |
| Preserve 0.8.0 changelogs; migrate only fork additions after the merge base | Avoids both duplicate released entries and loss of fork-only release notes |
| Use local focused tests plus complete CI | Repository rules forbid broad local build/test commands; Linux CI covers platform-specific full suites |
| Use no-provider isolated smoke | Proves the local source/runtime boundary without spending tokens or risking credential/session state |
| Add one AIM-managed Claude and one Codex completion | Explicitly approved by Amir on 2026-08-23; proves the merged external-helper path end to end without reauth, logout, or live-session mutation |
| Open a draft PR and require explicit merge approval | Matches repository governance and creates review/CI evidence |
| Merge with merge-commit strategy | Squash/rebase merge would lose official upstream ancestry |
| Do not publish, deploy, tag, or restart live daemons | User requested local testing and source merge only |

# 14. Implementation log template

Append entries here during execution; do not replace plan requirements with an external scratchpad.

## YYYY-MM-DD - Phase N - title

- Operator:
- Feature branch/worktree:
- Starting fork pin:
- Starting upstream pin:
- Current commit:
- Files inspected:
- Decisions applied:
- Commands run:
- Test/check results:
- Generated catalog hash/count/delta:
- Findings or deviations:
- Evidence paths/PR links:
- Phase exit status:
- Next authorized step:

# 15. Definition of done checklist

- [ ] The refreshed latest official upstream pin is recorded and this plan reflects any delta from <code>e319a66d</code>.
- [ ] The refreshed fork pin and merge base are recorded.
- [ ] Integration occurred in a separate clean worktree with npm 11.10+.
- [ ] Baseline fork preservation tests are recorded.
- [ ] A two-parent merge commit contains the exact official upstream pin.
- [ ] All six textual conflicts are semantically composed.
- [ ] All 24 overlapping paths are fully audited.
- [ ] Daemon protocol 7/schema 23 exposes both capability-gated features with a digest-derived ID.
- [ ] Kernel parent/watchdog/handle/orphan behavior and fork lifecycle/history/exit evidence coexist.
- [ ] ACP MCP ownership, validation, cleanup, and secret boundaries pass.
- [ ] Fast mode, goal continuation, typed errors, elapsed timer, refinement hooks/outcomes, OAuth discovery, heartbeat filtering, and MCP refresh pass.
- [ ] The model generator reproducibly emits upstream catalog state plus fork alias/compaction behavior.
- [ ] Upstream 0.8.0 changelog sections are immutable and only fork additions after the merge base are in new fragments.
- [ ] Root/workspace/internal dependency/lock versions agree at 0.8.0.
- [ ] Every upstream-changed test file and every named preservation group passes locally where supported.
- [ ] Root <code>npm run check</code> and <code>git diff --check</code> pass.
- [ ] The isolated no-provider source/TUI/daemon smoke passes and leaves no process/state behind.
- [ ] One isolated AIM-managed Codex completion returns exactly <code>AIM_CODEX_OK</code>, and one isolated AIM-managed Claude completion returns exactly <code>AIM_CLAUDE_OK</code>; temporary descriptors and processes are cleaned up without account reauthentication/logout or live-session mutation.
- [ ] A separate read-only implementation audit reports no open finding.
- [ ] The draft PR contains exact pins, conflict decisions, proof, risks, and rollback.
- [ ] Every required GitHub Actions job succeeds on the exact PR head.
- [ ] Amir explicitly approves merge after reviewing the green receipts.
- [ ] The PR is merged with an ordinary merge commit, not squash/rebase.
- [ ] Final <code>origin/main</code> contains both frozen pins as ancestors.
- [ ] The original untracked bug document remains unchanged.
- [ ] No package was published, no tag/release was created, no live daemon/session was restarted, and no deployment occurred.

Until every applicable item above is checked, the upstream integration is not complete.
