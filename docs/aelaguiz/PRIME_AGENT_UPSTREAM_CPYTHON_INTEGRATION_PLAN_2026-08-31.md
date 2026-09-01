# Prime Agent Upstream `main` / CPython Integration Plan

**Status:** Implemented through upstream v0.9.1; final validation and PR publication pending
**Repository:** `/Users/aelaguiz/workspace/prime-agent`
**Fork remote:** `origin` (`git@github.com:aelaguiz/prime-agent.git`)
**Official remote:** `upstream` (`https://github.com/PrimeIntellect-ai/prime-agent.git`)
**Prepared:** 2026-08-31
**Estimated execution:** 2–4 engineering days plus remote CI

## 1. Executive decision

Merge the exact official upstream tip into the fork with a normal two-parent Git merge. Use the upstream implementation as the default resolution, then reapply only fork contracts that still make sense on the new architecture.

The centerpiece is a **hard cutover** from the old IPython/Jupyter/ZMQ/forkserver stack to upstream's long-lived CPython JSON-lines subprocess:

```text
TypeScript `ipython` tool (public name retained)
  -> ReplKernelManager
  -> python -m rlm.repl
  -> JSONL requests/replies over stdin/stdout
  -> rlm.bash for managed shell work
```

Do not keep a parallel legacy kernel, an IPython compatibility shim, or the forkserver. Port the fork's still-valid crash evidence, process identity, orphan cleanup, and recovery guarantees into `ReplKernelManager`, `rlm.repl`, and the new bash/orphan paths.

### Pinned integration graph

| Ref | Commit | Role |
|---|---|---|
| merge base | `e319a66d7351c75abe7f040d02d9a8d6e25028e9` | last common official history |
| `origin/main` | `ec626e8fa651da782e13ca4441fdc8a7255b1172` | fork first parent / preservation baseline |
| `upstream/main` | `9f5edc192cfe3d4737205a2f551d2b6b6e34fe09` | exact official target |

- Divergence: **70 fork-only commits / 41 upstream-only commits**.
- Upstream delta: **248 files, +17,189 / -11,858**.
- The range includes the v0.8.1 release commit `514633727` plus **34 later commits** through the reviewed tip.
- Fork delta: **191 files, +23,524 / -910**.
- Same-path overlap: **49 paths**.
- Non-mutating ort merge simulation: **17 content conflicts + 5 modify/delete conflicts = 22 unmerged paths**; 27 same-path overlaps merge textually but still require semantic review.
- Patch-equivalence check: all 41 upstream patches are new to the fork.

> **Final upstream update (2026-09-01):** upstream moved to v0.9.1 at `81ae3cb34d27d38ee37f9e205a1e73694993b344` while implementation was finishing. The completed v0.8.1 integration was preserved as merge `6425ab4d4a618115349a0288467898d00fc99bc4`, then the 20 additional official commits were merged normally on top. This avoids rebuilding or squashing the reviewed integration.

`9f5edc192cfe3d4737205a2f551d2b6b6e34fe09` is the initial review pin, not permission to ignore a later official tip. At implementation start, fetch both remotes. If `upstream/main` moved, update this ledger, recompute merge base/divergence/conflicts, and reapprove the changed scope before merging.

## 2. North Star and done state

A successful result is a fork commit whose first parent is the reviewed fork tip and whose second parent is the reviewed official upstream tip, with all official behavior present, fork behavior intentionally preserved or explicitly retired, and no live ZMQ/IPython runtime path.

### Required outcomes

1. **Exact ancestry:** the result contains both pinned tips as ancestors and retains a reviewable two-parent merge commit. It is never squashed, rebased, or reconstructed from cherry-picks.
2. **Complete upstream coverage:** every commit in `e319a66d7351c75abe7f040d02d9a8d6e25028e9..9f5edc192cfe3d4737205a2f551d2b6b6e34fe09` is accounted for in the 41-commit ledger below and its behavior is either proven or explicitly superseded by the same upstream architecture.
3. **One runtime:** `ReplKernelManager` and `python -m rlm.repl` are the only code-execution runtime. `rlm.bash` owns managed shell subprocesses.
4. **Fork continuity:** AIM auth/routing/usage, xAI auth, fork defaults and aliases, daemon recovery/routing, RLM topology, crash evidence, MCP serve, Ctrl-X archive, source launching, atomic bundle publication, and fork CI remain supported.
5. **Composed daemon protocol:** the fork AIM/ACP and peer surfaces coexist with upstream roster/direct transport under final **schema revision 26** and schema ID `protocol-7-schema-26-fac530c4c6dd`. Older incompatible schemas are not treated as current.
6. **Generated truth is owned:** model catalog comes from the merged generator; lockfile comes from resolved manifests; schema ID comes from the schema descriptor. No generated file is resolved by hand.
7. **Release truth:** root and workspace manifests/lock metadata land at upstream v0.8.1, post-release upstream fragments remain, and published changelog sections are not rewritten.
8. **Proof:** focused local tests, `npm run check`, clean source-mode smoke tests, full required GitHub CI, and ancestry/static audits pass.

### Non-goals

- Preserve `zeromq`, ipykernel, Jupyter wire framing, forkserver, shell-channel recovery, IPython history, `%%bash`, `%cd`, `%env`, `%pip`, or `!command` execution.
- Rename the public TypeScript tool/transcript label `ipython`; upstream intentionally retains the external name while replacing the engine.
- Preserve running in-memory old workers across upgrade. The rollout drains/restarts them.
- Reintroduce the fork's explicitly reverted CLI `--service-tier` surface. Existing session `/fast` behavior remains in scope.
- Redesign AIM, MCP serve, daemon storage, model selection, or the TUI beyond what composition requires.
- Rewrite dated historical plans/worklogs. Only evergreen docs and directly misleading bug status are updated.
- Publish packages, deploy, install globally, or call paid model providers without separate approval.
- Pull unrelated live catalog drift or commits beyond the reviewed upstream pin into this integration.

## 3. Architectural ownership after the merge

| Concern | Single owner | Boundary rule |
|---|---|---|
| TypeScript kernel lifecycle | `packages/coding-agent/src/core/kernel/repl-manager.ts` | Spawns, observes, repairs, snapshots, interrupts, and shuts down one CPython child. No ZMQ/Jupyter side door. |
| Python protocol and namespace | `prime-agent-runtime/src/rlm/repl.py` | Stdout is protocol-only. User output is framed. Requests are serial and host calls are correlated. |
| Shell/process execution from Python | `prime-agent-runtime/src/rlm/bash.py` and `_winjob.py` | Async handles by default; bounded output; POSIX process groups / Windows jobs; kernel-scoped cleanup. |
| Orphan authority | `orphan-process-journal.ts` + daemon cleanup | Journal/identity checks decide reaping. Lifecycle telemetry supplies evidence but is not kill authority. |
| Agent-message admission / RLM projection | `AgentSession` | Capacity, queue choice, child snapshots, activity wakeups, and quiescence have one owner. |
| Worker lifecycle | daemon supervisor | Launch/recovery/ownership/eviction/spawn errors live here; daemon mode handles admitted commands. |
| Saved RLM topology | `rlm-ledger.ts` and its daemon callers | One parser and one canonical edge view; malformed optional fields do not revive invalid topology. |
| Model catalog | `packages/ai/scripts/generate-models.ts` | `models.generated.ts` is output only. Fork aliases are generator rules, not manual entries. |
| Dependencies | workspace `package.json` files | `package-lock.json` is regenerated/audited output. |
| Daemon compatibility | protocol descriptors + capabilities | Schema revision/ID describes the full union; optional commands are capability-gated. |
| Interactive projections | current session/catalog/queue/heartbeat state | No shadow `connectionModels`, content, queue-selection, or heartbeat truth. |

## 4. Constraints and implementation policy

- Read every affected file in full at base, fork tip, upstream tip, and merge result before wide edits. Conflict hunks are not enough.
- Start from the fork tip and merge the official tip. Disable stale rerere and use `zdiff3` markers.
- Use explicit commit hashes when restoring a side of a conflict; do not rely on ambiguous “ours/theirs” language.
- Keep `MERGE_HEAD` present while resolving and proving the merge. Commit only after focused proof is green.
- Local repository rules prohibit `npm run build` and broad unscoped Vitest runs. Run only named test files/groups locally; rely on GitHub CI for full build and complete matrix.
- Root `npm run check` is required. It can rewrite formatting, so review its diff.
- Use npm **>= 11.10.0** for lock regeneration. The observed local npm 11.5.1 is below the repository's minimum-release-age requirement.
- Keep test, daemon, lifecycle, and agent directories isolated. Never aim destructive cleanup at real `~/.prime-agent` state.
- Never terminate unrelated processes by basename. Reap only identity-verified process trees owned by the candidate.
- Do not treat a clean textual merge as evidence. Every one of the 49 overlapping paths has a review obligation in Appendix B.
- Do not update `CHANGELOG.md` released sections directly. Keep or add package `.changes/*.md` fragments as the repository requires.

### 4.1 Scope and execution authorization

- **Human authorization:** on 2026-08-31 the user explicitly approved the full plan, asked for a test plan inside this artifact, authorized implementation in an isolated Prime Agent worktree, and requested a pull request back to the fork.
- **Active scope:** the complete integration boundary in Sections 1–10, including all 41 upstream commits, all 49 overlap reviews, the 22 conflict resolutions, the CPython cutover, fork-preservation ledger, generated artifacts, docs, tests, and PR follow-through.
- **Initial convergence closure:** the owner moves, caller migrations, delete list, schema-24 composition, generated-owner regeneration, and side-door closures already named in this plan. No newly discovered adjacent product behavior is authorized automatically.
- **Stop boundary:** a reviewable PR to `aelaguiz/prime-agent` `main` with required CI green or with any external CI blocker stated precisely. Do not merge the PR, publish packages, deploy, install globally, or run paid-provider canaries without separate approval.
- **First-parent constraint:** copy this plan into the integration worktree and include it in the two-parent merge commit. Do not create a plan-only commit before the merge.

## 5. Fork preservation ledger

Preservation means preserving the user/system contract, not freezing the old implementation. If an upstream owner replaces a fork owner, move the contract to the new owner and delete the superseded path.

| Fork contract | Canonical owners after integration | Required posture | Proof |
|---|---|---|---|
| AIM account selection, credential handoff, request admission, and auth reset | `src/core/aim-external-auth.ts`, `auth-storage.ts`, `model-registry.ts`, `agent-session.ts`, daemon client/mode/protocol | Preserve the exact `aimgr-credential-v1` descriptor and owner-only absolute helper execution: no shell, allowlisted env, timeout/byte caps, strict provider/binding/identity/freshness, and no token persistence. Journal binding wins resume; descendants share root auth; snapshots remain secret-free. Preserve one generation-atomic request identity through side requests and the one allowed unopened Codex continuation retry. Keep root-only private handoff capability-gated and models derived on read. Keep `--reset-credential-binding <provider>` fork-only and remove only the selected binding/helper on copied sessions. | `aim-request-admission`, `credential-binding-reset`, `auth-storage`, `model-registry`, Codex stream/failure tests, regression 678, daemon compatibility tests |
| AIM usage and Claude exhaustion behavior | `src/core/aim-usage.ts`, interactive status/usage code, AI stream-failure code | Query the selected account through distinct trusted helper executables, dedupe and bound responses, parse only non-secret fields, and show helper failures in TUI. Preserve exact reset metadata and fail-fast exhaustion classification; AIM Anthropic gets no hidden SDK retry, non-AIM policy is unchanged, and there is no Claude/xAI auto-rotation. | `aim-usage`, `interactive-mode-usage`, stream-failure tests |
| xAI OAuth and AIM non-interference | `packages/ai/src/utils/oauth/xai.ts`, coding-agent auth/model owners | Preserve RFC8628 HTTPS/poll/slow-down/deadline/abort/refresh and revoked-token relogin guidance. Stored OAuth/AIM xAI uses Responses and normalized Grok reasoning; API-key xAI is unchanged. Rebind only xAI and prove unrelated AIM credentials/models remain untouched. | `xai-oauth`, `xai-aim-noninterference`, `auth-storage`, regression 678 |
| Fork model defaults and aliases | `packages/ai/scripts/generate-models.ts`, `defaults.ts`, `model-resolver.ts`, `model-registry.ts`, compaction | Preserve Sol at `max` (the final fork source; repair the stale xhigh SDK test), Fable 5 / Opus 5 at `xhigh`, Grok 4.6 behavior, `gpt-5.6-sol-1m -> gpt-5.6-sol`, 900K compaction, and FAST OFF. Do not synthesize retired Google Generative AI Gemini 2.0 aliases or filter legitimate live/Vertex IDs. Retire only the reverted CLI `--service-tier`; keep existing session `/fast` semantics. | generator/idempotence audit, model resolver/registry, compaction, SDK-thinking, status/subagent tests |
| Daemon routing, recovery, leases, and stale-daemon safety | daemon command/client/mode/protocol/supervisor, launch lease, session resolver | Compose upstream recovery-before-reuse, pending-open ownership, empty eviction, and spawn errors with fork cross-daemon routing, anti-storm recovery, lock/identity fencing, and exact path/session resolution. Preserve fork drift policy: reuse any daemon with a recognizable hello despite app/protocol/schema/build drift, diagnose unsupported commands at capability boundaries, leave reachable no-hello endpoints untouched, and spawn only when absent. Internal supervisor/worker adoption stays exact-identity. Preserve canonical path lookup and ambiguity errors. | daemon process, monitor, lazy-subagent, launch-lease, socket-compromise, runtime-identity, cross-daemon tests |
| Daemon stop confirmation | `src/cli/daemon-stop-confirm.ts` (`promptYesNo`) | EOF or closed readline settles exactly once as “No”; it never hangs, double-settles, or turns a closed prompt into destructive consent. This gates rollout/rollback stops. | `test/daemon-stop-confirm.test.ts` |
| RLM ledger and saved-session topology | `agent-session.ts`, `daemon-mode.ts`, `rlm-ledger.ts`, session list | Use upstream `AgentSession` child projection/on-demand peers and unified legacy parser while retaining fork fail-closed write-before-memory publication, create/delete ordering across failure/restart, routed-path protection, capability rejection before wire write, rename/delete edges, and no duplicate delivery. | recursion, daemon-mode, rlm-ledger, snapshot-transfer, session-list tests |
| Durable crash evidence and process identity | `src/core/process-lifecycle.ts`, CLI/Bun/logging/daemon/owned worker owners, new `ReplKernelManager` hooks | Preserve the dependency-light SSOT for bounded per-process JSONL starts, heartbeats, signals, expected exits, fatals, parent-observed crashes, and recovery attempts. Keep sync best-effort fatal writes, allowlisted fields, and no argv/env/prompts/tokens/raw stderr. Port kernel-generic evidence to the CPython child; delete forkserver/ZMQ-only mechanics and policy. | process-lifecycle/catalog/owned-worker/supervisor process tests plus new REPL lifecycle/start-failure cases |
| Conservative orphan cleanup | `orphan-process-journal.ts`, `daemon-ps.ts`, owned worker, `rlm.bash` | Union strict all-generation tombstone parsing and PID-reuse fencing with upstream kernel PID, process-group/job containment, per-kernel bash reaping, and PID-only safety. | orphan journal, daemon-ps, kernel-bash, Windows job tests |
| MCP remote control | `src/modes/mcp-serve/*`, command registry, daemon bridge/protocol | Keep HTTP POST `/mcp` and stdio, default `0.0.0.0:7717`, `--daemon-socket` plus current `--socket`, trusted-network warning/bounds, and exact status/detail/transcript/send/interrupt/start/resume/restart/kill tool set. Adapt to schema 24, on-demand session state, empty-session eviction, and CPython output; connect recognizable daemons, spawn only absent, never replace unavailable. | `mcp-serve-render`, real `mcp-serve-e2e`, `test:process` |
| TUI fork behavior | interactive mode, keybindings, connection/extension controller | Preserve Ctrl-X stop-and-archive, usage error display, FAST OFF signal, scoped effort, and narrow-width priority while taking upstream queue, message-count, heartbeat, and Mermaid ownership. | startup/status/usage/queue, connection, extension-controller, subagent-summary tests |
| Source launcher, bundle publication, and fork CI | `prime-agent.sh`, `scripts/bundle.mjs`, package scripts, workflows | Retain content-hashed atomic bundle publication, source checkout launch, process/MCP split, global test isolation, and fork CI; update runtime dependency and test names. | bundle publication, source smoke, process/kernel jobs, required GitHub checks |

## 6. Complete upstream commit ledger (41/41)

This is the acceptance ledger for the reviewed upstream range. “Primary proof” names the minimum direct check; the full verification matrix later remains mandatory.

| Commit | Date | Area | Required integration result | Primary proof |
|---|---|---|---|---|
| `a44b07ee9` | 2026-08-24 | UI rendering | Keep upstream multiline-string highlighting in expanded Python cells. | UI rendering tests |
| `9e49b73dd` | 2026-08-24 | RLM defaults | Adopt default RLM maximum depth 2 without changing fork model defaults. | recursion and prompt tests |
| `a9b5d88b5` | 2026-08-24 | AI / ACP | Adopt Chat reasoning-detail replay and ACP terminal quiescence/lineage fixes. | AI completions + ACP suite |
| `06860844e` | 2026-08-24 | Docs | Carry the upstream README update. | doc diff + root check |
| `9bc005574` | 2026-08-25 | Model catalog | Adopt first refreshed catalog/generator behavior and test fixture changes. | generator + model/provider tests |
| `b5ee2f81a` | 2026-08-25 | ACP output | Preserve assistant-message boundaries across autonomous ACP turns. | ACP event tests |
| `514633727` | 2026-08-26 | Release 0.8.1 | Adopt v0.8.1 package versions, lock metadata, and immutable changelog sections. | manifest/lock/changelog audit |
| `0940833b7` | 2026-08-26 | Runtime / bash | Adopt async `bash()` handles, process-tree containment, and orphan-journal integration. | runtime bash + orphan tests |
| `61eb64748` | 2026-08-27 | CPython cutover | Adopt `python -m rlm.repl`, JSONL stdio, native snapshots, prompt/skill/docs cutover, and delete ZMQ/forkserver. | REPL/runtime/kernel suites |
| `bc0fa7606` | 2026-08-26 | Agent messaging | Carry root-sibling messaging coverage. | daemon messaging tests |
| `0fa717d4f` | 2026-08-28 | Model catalog | Adopt second live-catalog refresh and provider expectations. | generator + Fireworks/Prime tests |
| `90343dca0` | 2026-08-28 | Daemon rename | Trust supervisor-authorized session renames in worker mode. | daemon mode tests |
| `8c4ab8f5d` | 2026-08-28 | Session paths | Use the centralized session-path predicate. | daemon command/resolver tests |
| `378e32d58` | 2026-08-28 | Cleanup | Remove test-only config cache reset APIs; adapt fork tests to public seams. | auth/model-registry tests |
| `0f6a38854` | 2026-08-28 | Interactive state | Derive content state from `messageCount` instead of a shadow flag. | startup/status/recap tests |
| `d90062b60` | 2026-08-28 | Interactive models | Derive available connection models on read. | status/model-selection tests |
| `5e0e288a8` | 2026-08-28 | Runtime cleanup | Remove obsolete kernel host-request seams; retain only behavior required by the new dispatcher. | host-request/REPL tests |
| `809027134` | 2026-08-28 | Runtime / bash | Keep ordered foreground-output completion sentinels. | Python bash tests |
| `ceb418049` | 2026-08-28 | Agent messaging | Centralize agent-message admission in `AgentSession` and add on-demand supervisor peers. | agent-session/daemon/roster tests |
| `af14f066c` | 2026-08-28 | Host bridge | Use dispatcher-owned host-reply envelopes and typed routing. | goal/REPL/runtime tests |
| `d60fab8a7` | 2026-08-28 | REPL resilience | Adopt corrupt-frame repair, single-owner shutdown, and bounded snapshot-dispose behavior. | protocol-corruption/start-stop/state tests |
| `80bf72c88` | 2026-08-29 | Agent messaging | Prevent retries after a remote agent message was delivered. | daemon messaging tests |
| `056014620` | 2026-08-29 | Cleanup | Remove test-only parser/feature-hint seams. | model resolver + hint tests |
| `ee8fd6996` | 2026-08-29 | Worker recovery | Wait for worker recovery before reusing a session. | supervisor recovery tests |
| `bab124212` | 2026-08-29 | Interactive queue | Single-source interactive queue state and selection/edit behavior. | queue/side-question tests |
| `c0334a176` | 2026-08-29 | RLM snapshots | Use one projection for child snapshots across session and daemon views. | recursion/session-list tests |
| `dfffea271` | 2026-08-29 | RLM registry | Unify legacy RLM registry parsing. | ledger/daemon tests |
| `9db2722ed` | 2026-08-29 | Telemetry cleanup | Remove the `NODE_ENV=test` telemetry branch and set test policy explicitly. | telemetry + config tests |
| `18fe5d5b6` | 2026-08-29 | UI cleanup | Delete unreachable selector auto-cancel timers. | selector/interactive tests |
| `85c236d5f` | 2026-08-29 | Heartbeats | Derive scoped heartbeats at render time. | heartbeat/status/subagent tests |
| `dab03c00c` | 2026-08-29 | RLM quiescence | Wake quiescence on activity changes instead of polling; preserve post-compaction idle behavior. | recursion/queue/compaction tests |
| `853041ec8` | 2026-08-29 | Bash lifecycle | Give every in-flight user bash command its own abort controller. | bash persistence/provisioner tests |
| `8ca525558` | 2026-08-29 | AI cleanup | Delete unused overflow-pattern export. | AI type/check coverage |
| `bcf69db50` | 2026-08-29 | Cleanup | Remove the test-only daemon lookup seam from `main.ts`; retain fork routing through production seams. | routing/process tests |
| `6322b7bb9` | 2026-08-29 | Daemon close | Await in-flight bash completion during daemon close. | daemon close tests |
| `5b6c0e94e` | 2026-08-29 | Session ownership | Enforce session ownership when joining an in-flight open. | supervisor lazy-subagent tests |
| `a903d4b67` | 2026-08-30 | Repository metadata | Carry contributor vouch metadata and fragment. | tree/changelog check |
| `c382f0985` | 2026-08-30 | Terminal UX | Render Mermaid diagrams inline and retain TUI markdown transform hooks/settings. | streaming/settings/TUI tests |
| `c718bf3c3` | 2026-08-31 | Prompt doctrine | Tell agents to use managed `bash()` instead of blocking subprocess calls. | system prompt tests |
| `cbc0f7d7d` | 2026-08-31 | Empty sessions | Report honest empty-session status and evict detached empty sessions. | session-list/eviction tests |
| `9f5edc192` | 2026-08-31 | Spawn errors | Surface the real worker spawn error, including EMFILE-style failures. | daemon error/supervisor tests |

## 7. Explicit merge-conflict contract (22 paths)

The merge simulation produced these exact conflicts. Resolve each according to the stated owner; never make a bulk “take ours” or “take theirs” choice across this list.

| Conflict | Area | Required resolution |
|---|---|---|
| `package-lock.json` | Dependency/release | After manifests are final, use the upstream lock only as a transient seed and regenerate with npm >=11.10. The lock must contain upstream `grok-mermaid`, fork `@modelcontextprotocol/sdk` and `zod`, no `zeromq`, and synchronized 0.8.1 workspace versions. Do not hand-merge lock hunks. |
| `packages/ai/src/models.generated.ts` | Generated catalog | Resolve `generate-models.ts` first, preserving the fork `gpt-5.6-sol-1m` alias/requestModelId/900K threshold and all upstream catalog policies. Use the upstream generated file only as a transient seed, then regenerate. Never hand-edit this file; classify any live-catalog drift. |
| `packages/coding-agent/package.json` | Manifest | Use upstream v0.8.1 metadata and CPython dependencies (remove `zeromq`), add upstream `grok-mermaid`, retain fork MCP SDK/zod and process-test split, and point kernel tests at `repl-kernel-*` files. |
| `packages/coding-agent/scripts/bundle.mjs` | Bundle publication | Retain the fork atomic content-hashed publication/build-id flow, but remove `zeromq` from externals and keep upstream dependency changes. Re-run bundle publication tests. |
| `packages/coding-agent/src/cli/daemon-command.ts` | CLI/daemon | Combine upstream `looksLikeSessionPath` centralization with fork AIM credential handoff and lifecycle instrumentation. Preserve exact start/timeout behavior and capability checks. |
| `packages/coding-agent/src/cli/daemon-ps.ts` | Process cleanup | Compose upstream kernel-bash tree reaping/PID-only safety with fork strict cross-generation tombstone parsing, canonical-path checks, identity re-probes, and exact-dead cleanup. |
| `packages/coding-agent/src/core/kernel/fork-server-script.ts` | Deleted runtime | Accept upstream deletion. Do not restore the forkserver. Move any still-valid crash-evidence contract to `ReplKernelManager`/`rlm.repl`; retire forkserver-only behavior and tests. |
| `packages/coding-agent/src/core/kernel/fork-server.ts` | Deleted runtime | Accept upstream deletion. Preserve no raw-PID/reuse mistakes through the direct child handle, owner watchdog, orphan journal, and process-lifecycle events in the new runtime. |
| `packages/coding-agent/src/core/kernel/index.ts` | Kernel owner | Resolve to upstream exports (`ReplKernelManager` + shared types). Port fork process-lifecycle observations into `repl-manager.ts`; do not carry ZMQ, Jupyter framing, shell-channel recovery, or forkserver code. |
| `packages/coding-agent/src/core/orphan-process-journal.ts` | Process ownership | Union upstream `kernelPid`, PID-optional records, process-group/Windows tree kills, and per-kernel reaping with fork strict all-generation parsing and conservative tombstone cleanup. |
| `packages/coding-agent/src/modes/daemon/daemon-mode.ts` | Daemon worker | Use upstream centralized agent-message admission, peer lookup, delivered-message semantics, RLM projections, bash-close behavior, and empty-session state while reapplying AIM handoff, usage, routed ledger, stale-daemon reuse, recovery, and lifecycle evidence. |
| `packages/coding-agent/src/modes/daemon/daemon-protocol.ts` | Wire protocol | Create combined schema revision 24 with a digest-derived ID. Retain AIM capability/command and add upstream `list_agent_peers`; capability-gate the peer command to disambiguate the two incompatible revision-23 lineages. Update every compatibility map/test. |
| `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts` | Supervisor | Compose upstream on-demand peer roster, recovery-before-reuse, pending-open ownership, empty-session eviction, and spawn errors with fork anti-storm recovery, lifecycle events, lock/identity fencing, and AIM forwarding. |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | TUI | Adopt upstream queue/messageCount/model/heartbeat/Mermaid changes and preserve fork Ctrl-X stop/archive, `/usage` error display, FAST OFF signal, and session-local effort/default behavior. |
| `packages/coding-agent/test/daemon-supervisor-monitor.test.ts` | Test composition | Keep both upstream recovery/spawn/pending-open cases and fork lifecycle/anti-storm/identity cases; refactor shared fixtures instead of choosing one side. |
| `packages/coding-agent/test/interactive-mode-startup.test.ts` | Test composition | Keep upstream message-count/empty-state startup cases and fork Ctrl-X/FAST/status/startup stability cases. |
| `packages/coding-agent/test/ipython-bootstrap.test.ts` | Test migration | Convert fork environment/bootstrap stability assertions to `ReplKernelManager`; remove ipykernel/magic expectations and retain Python-skill/host-bridge proof. |
| `packages/coding-agent/test/kernel-fork-server-protocol.test.ts` | Deleted test | Delete. Port only general PID identity/lifecycle invariants to REPL/orphan-journal tests; do not keep forkserver protocol coverage. |
| `packages/coding-agent/test/kernel-fork-server.test.ts` | Deleted test | Delete. Replace forkserver diagnostics assertions with direct REPL process-lifecycle tests. |
| `packages/coding-agent/test/kernel-startup.test.ts` | Deleted test | Delete as an old owner test, but port fork lifecycle/start-failure/privacy assertions into `repl-kernel-startup.test.ts` or a focused new REPL lifecycle test. |
| `packages/coding-agent/test/main-interactive-routing.test.ts` | Test migration | Adopt upstream removal of the test-only daemon lookup seam. Keep fork cross-daemon/path-resume behavior through production-path unit/process tests (`main-cross-daemon-resume-process.test.ts`). |
| `packages/coding-agent/vitest.config.ts` | Test config | Keep fork `globalSetup`, add upstream `DO_NOT_TRACK=1`, and update the kernel-heavy description to Python REPL while retaining both tag filters. |

### Silent stale paths Git will not resolve for us

The ordinary merge keeps several fork-only paths because upstream never saw them, even though their owners disappear. Handle them explicitly:

- Delete `packages/coding-agent/test/kernel-shell-channel.test.ts`. Its ZMQ shell-channel wedge cannot exist in `rlm.repl`; protocol corruption/repair tests own the remaining failure intent.
- Delete stale eager-peer-sync fields, calls, methods, and coalescing tests from fork commit `5c85ee9a3`. Upstream on-demand `list_agent_peers` replaces that architecture; preserve adjacent lifecycle records only.
- Remove the now-dead `findActiveDaemonSessionSummaryForInteractiveStartup` seam left by the clean `main.ts` merge. Preserve real `findActiveDaemonSessionAcrossDaemons` behavior and process-level cross-daemon tests.
- Remove obsolete live guidance from `packages/coding-agent/docs/development.md` and fork change fragments that claim Jupyter/ipykernel/forkserver or default RLM depth 1.
- Accept upstream deletion of `scripts/boot-bench.mjs` and all old kernel owner tests. Do not replace them with a compatibility harness.
## 8. CPython cutover contract

### 8.1 Adopt upstream runtime without a compatibility fork

Take these upstream owners as the baseline:

- `packages/coding-agent/src/core/kernel/repl-manager.ts` and `shared.ts`.
- `packages/coding-agent/src/core/tools/ipython.ts`, retaining the public tool name but using ordinary Python execution.
- `prime-agent-runtime/src/rlm/repl.py`, `repl.md`, `bash.py`, and `_winjob.py`.
- Upstream `prime-agent-runtime/pyproject.toml` and generated `uv.lock`, with IPython/ipykernel/nest-asyncio removed and runtime packaging kept reproducible. Treat `pyproject.toml` as owner: run `uv lock --check`; if deliberate dependency composition makes it stale, run one explicit `uv lock`, then require `uv lock --check` and a clean second pass.
- Updated bootstrap, boot gate, snapshots, prompt, skill, compaction, ACP, daemon-session, UI rendering, docs, install, and test paths from `61eb64748` and its follow-ups.

Required semantics:

1. Spawn the configured Python as `python -m rlm.repl`; use the managed environment selected by bootstrap and honor `PRIME_AGENT_KERNEL_PYTHON`.
2. Send one JSON request per stdin line. Keep stdout protocol-only. Frame user stdout/stderr, results, errors, background output, host requests, and shutdown deterministically.
3. Serialize execute/snapshot/restore/interrupt/shutdown operations. A protocol-corrupt frame fails the affected request, restores the last good snapshot into one bounded replacement, reboots live handles, and cannot overwrite the good snapshot from an unrestored kernel.
4. Preserve the fork's transport-neutral no-blind-retry guarantee: if a stdio write or reply boundary leaves execution uncertain, fail the request explicitly, mark/repair the child, and never replay the cell automatically. Add a partial-write regression rather than porting ZMQ pump mechanics.
5. Wrap host-handler payloads under `data.result`; handler-returned keys must not overwrite reply status or correlation metadata.
6. Make `input()` observe EOF so user code cannot consume JSONL protocol frames. Preserve background output separately from the active cell and route typed rich display through `rlm.emit`.
7. Use native top-level `await`, persistent globals, detached asyncio tasks during a live session, dill state snapshots, and the upstream unpicklable-value policy. A plain pre-cutover dill snapshot is a migration smoke case; IPython-only objects and live tasks are not guaranteed across restart.
8. Treat `%%bash`, other magics, and shell escapes as Python syntax errors. Update prompts/skills/examples to use `await bash(...)`, handle polling, or the agent's managed shell interface.
9. Keep display parsing for historical/transcript Python cells where upstream retains it. Do not mistake `ipython-cell-code.ts` UI parsing for a runtime-magic path.

### 8.2 Port fork lifecycle guarantees to the new owner

The fork's lifecycle work is still valuable, but the implementation belongs in `ReplKernelManager`, not in a resurrected `KernelManager` or forkserver.

- Scrub inherited lifecycle-correlation environment variables before spawning the Python child.
- Create one process instance ID per child and retain the fork event contract (`kernel_process_start`, `kernel_process_ready`, `kernel_process_exit`, `kernel_start_failed`, `kernel_kill`) with `launchMode: "direct"`; optionally add `transport: "rlm-repl-stdio"`. Record repair attempt/outcome with bounded/private detail.
- Keep stderr as a bounded UTF-8 tail. Never persist environment values, prompts, provider secrets, or arbitrary user output in lifecycle evidence.
- Hold and signal the direct child/process-group handle. Never infer authority from an unverified raw PID.
- Make shutdown/dispose idempotent. Serialize repair versus teardown. Bound snapshot and drain timeouts. Do not double-report close/exit.
- Preserve current process-lifecycle fixtures and move only kernel-generic cases into focused `repl-kernel-startup`/repair tests. Delete forkserver event vocabulary that has no new-runtime meaning.

### 8.3 Compose bash and orphan ownership

Use upstream `rlm.bash` exactly as the kernel-side execution architecture. Do not conflate it with host/daemon `AgentSession.executeBash`: the former owns Python-started process trees; the latter keeps its own abort-controller set and close/passivation wait.

- async handle by default; explicit await/tail/poll/kill; bounded retained output;
- ordered completion sentinel so post-exit background output remains visible only on the handle;
- one abort controller per in-flight user bash operation;
- POSIX group containment and Windows job/tree containment;
- kernel PID recorded in the orphan journal; per-kernel bash reaping at shutdown; daemon-close waits on in-flight bash promises.

Merge the fork's strict tombstone view with upstream's richer record:

- parse every journal generation, dedupe by owner/process identity, and preserve strict invalid-record behavior before tombstone deletion;
- accept upstream optional `processStartId`/PID-only records but use the most conservative kill policy available;
- re-probe identity immediately before kill; on Windows, refuse unsafe PID-only cleanup when start identity cannot be proved;
- kill a process group/tree only when the record, owner, and platform policy authorize it;
- keep truncated-tail tolerance without turning malformed records into authority.

### 8.4 Runtime acceptance cases

The new runtime is not complete until these cases pass:

- expression, statement, exception, stdout/stderr, rich repr, imports, persistent globals, and top-level await;
- host request/reply, malicious/colliding handler keys, skill calls, and graceful MCP host shutdown;
- snapshot/restore, unpicklable values, restore failure, snapshot timeout, and simple old dill fixture;
- interrupt, parent death, startup failure, unexpected exit, protocol corruption, partial/failed request writes with no replay, repair, repeated shutdown, and lifecycle privacy;
- concurrent bash handles, large/truncated output, background output ordering, timeout, kill, process-tree cleanup, abort-all, daemon close, and Windows job behavior;
- isolated custom Python environment with no dependency on system ipykernel;
- static absence of production imports/usages of `zeromq`, `jupyter_client`, `ipykernel`, `fork-server`, and old `KernelManager` ownership.
## 9. Cross-cutting composition contracts

### 9.1 Daemon schema revision 24

Both lineages independently use revision 23:

- fork revision 23: AIM credential handoff plus connection-owned ACP MCP behavior;
- upstream revision 23: on-demand `list_agent_peers`.

Their schema IDs differ. Neither can describe the merged command union.

Required repair:

1. Add both command/capability surfaces to the merged descriptor.
2. Set the existing exported `DAEMON_SCHEMA_REVISION = 24`; do not introduce a parallel constant. Require supervisor and daemon-mode worker hello advertisements to import/use it.
3. Recompute the 12-character schema digest with the exact algorithm used by `daemon-protocol.test.ts`; do not invent the ID.
4. Set `AGENT_PEER_LIST_COMMAND.minSchemaRevision = 24` and advertise/check an explicit peer-list capability. This prevents a merged client from sending it to the fork's incompatible revision-23 daemon.
5. Retain and capability-gate AIM credential handoff and ACP MCP ownership.
6. Keep unknown legacy worker commands fail-fast. Remove eager `worker_sync_agent_peers` broadcast state completely.
7. Test old fork client -> new daemon, new client -> old fork daemon, new client -> old official revision-23 daemon, stale daemon restart, mixed worker/supervisor startup, and MCP bridge handshake. Optional features may degrade only at the documented capability boundary.

### 9.2 Supervisor and daemon-mode synthesis

Resolve onto upstream's current control flow, then reapply fork contracts at their narrow boundaries:

- `AgentSession` admits messages and decides direct versus queued delivery. Supervisor provides authenticated peer data on demand.
- A possible-success remote send is never retried; timeouts after send surface an error to avoid duplicate delivery.
- Worker reuse awaits recovery; overlapping starts coalesce; every pending-open join rechecks session ownership.
- Spawn waits for `spawn` or `error` before touching stdio. Preserve the real EMFILE/ENFILE error and one-line CLI hint.
- Empty unnamed sessions can be evicted after last detach, but on-disk drafts remain. Heartbeat, cron, client-owned, and admitted-mutation cases keep upstream exemptions.
- MCP-created empty sessions need an explicit detach/resume regression so upstream eviction does not erase or strand the fork workflow.
- Supervisor lifecycle hooks, launch leases, stale-version reuse, lock compromise checks, exact socket/catalog identity, cross-daemon routing, and anti-storm recovery remain.
- Worker-approved rename uses upstream `setStateSessionNameForCommand`, but the fork ledger append remains durable: roll back the in-memory name if append fails.
- Daemon close waits on tracked in-flight bash promises and process cleanup; it does not poll shadow state.

### 9.3 Models, auth, and generated catalog

1. Merge `packages/ai/scripts/generate-models.ts` before touching generated output.
2. Carry all upstream routing/catalog rules, including Cloudflare gateway cleanup, Qwen mapping fixes, private `dev/` Prime filtering, Fireworks/Prime refreshes, and current pricing/limits.
3. Reapply fork generator rules for `gpt-5.6-sol-1m`, `requestModelId: "gpt-5.6-sol"`, and 900K compaction. Preserve the final-tree thinking defaults: Sol `max`, Fable 5/Opus 5 `xhigh`; update the stale SDK test that still expects Sol `xhigh`. Keep retired Google Generative AI Gemini 2.0 aliases unsynthesized without filtering legitimate live/Vertex IDs.
4. Use upstream's `models.generated.ts` only as a transient, conflict-free seed because the generator imports the existing catalog. Then run `npm --prefix packages/ai run generate-models` from the merged owner. Do not hand-edit the seed. Run the generator a second time and require no diff.
5. Diff generated output against both tips. Any unrelated live-catalog churn is a blocker: refresh the official pin if upstream has moved, or split that churn into a separately approved change. Never silently fold it into this merge.
6. Remove exported test-only cache reset/parser/randomness seams as upstream does. Adapt fork auth tests to public state seams; do not weaken isolation to make them pass.
7. Keep interactive models derived from the live catalog on every read. Reapply only the fork's best-effort post-auth `getState()` refresh of live/scoped model and effort.
8. Prove the intentional CLI `--service-tier` revert remains absent while existing session `/fast` behavior stays green.

### 9.4 Dependencies, versions, bundle, and lockfile

Resolve manifests first:

- root and `agent`, `ai`, `coding-agent`, and `tui` versions/internal ranges: upstream `0.8.1` / `^0.8.1`;
- add upstream exact `grok-mermaid: 0.2.3`;
- retain fork `@modelcontextprotocol/sdk` and direct `zod` used by MCP serve;
- remove direct/transitive `zeromq` ownership from coding-agent;
- keep fork process/kernel test scripts, `globalSetup`, source launcher, and two-pass content-addressed bundle publication; update test names and remove `zeromq` from bundle externals.

Use upstream's lockfile only as a transient seed after all manifest conflicts are resolved. Then regenerate `package-lock.json` from those manifests with npm >=11.10, preferably `npm install --package-lock-only --ignore-scripts`. Audit workspace versions, dependency presence/absence, integrity, and idempotence. Do not hand-merge lock chunks.

### 9.5 Interactive and MCP composition

- Take upstream single-source queue selection, `messageCount` content state, derived model list, derived heartbeat rows, ACP message boundaries, multiline-cell highlight, and Mermaid modes (`off`, `final`, `streaming`).
- Reapply fork Ctrl-X stop/archive, usage error display, FAST OFF, session-scoped thinking/effort, and narrow-width priority without creating new shadow state.
- Keep MCP serve render/start/resume/interrupt/kill behavior. Adapt transcript rendering to CPython outputs while retaining the external `ipython` tool label.
- Test exact-width Mermaid transforms, oversized/partial fallback, queued duplicate-text editing, heartbeat refresh deadlines, fresh empty sessions, and MCP empty detach/resume.
## 10. Ordered implementation plan

### Phase 0 — Freeze evidence and create an isolated integration lane

- [ ] Save this plan and verify the only pre-existing worktree change is intentional.
- [ ] `git fetch --prune --tags origin` and `git fetch --prune --tags upstream`.
- [ ] Recompute both tips, merge base, divergence, 41-hash list, changed-path intersection, and a non-mutating `git merge-tree --write-tree --messages` receipt.
- [ ] If either tip differs from the pins above, update Sections 1, 6, 7, and Appendix B before continuing.
- [ ] Record Node/npm/uv/Python/Git versions. Provision npm >=11.10 before lock work.
- [ ] Create a backup ref at the fork tip and a dedicated integration branch/worktree whose first parent is the fork tip. Do not stash or overwrite unrelated local changes.
- [ ] Copy this untracked plan into the integration worktree and include it in the eventual merge commit. Do not create a plan-only commit before the merge, because that would make the reviewed fork tip no longer the merge commit's direct first parent.
- [ ] Run a bounded fork baseline: AIM/model/auth, daemon protocol/recovery/routing, lifecycle/orphan, MCP serve, Ctrl-X/status, bundle publication, and current kernel smoke files. Record the known stale Sol SDK expectation (`xhigh` test versus final source `max`) as baseline debt, not integration fallout.
- [ ] From the old runtime, capture one non-secret snapshot fixture containing scalars, containers, a module import, function, and class. Store it outside real user state and keep it through rollout verification.

**Exit gate:** refs and merge simulation match the plan; baseline failures are classified before integration; isolated paths cannot touch live daemon/session state.

### Phase 1 — Create the lineage-preserving merge and make the tree structurally coherent

Start from the pinned fork tip:

```bash
git -c rerere.enabled=false -c merge.conflictStyle=zdiff3 \
  merge --no-ff --no-commit 9f5edc192cfe3d4737205a2f551d2b6b6e34fe09
```

- [ ] Resolve all 22 conflicts according to Section 7.
- [ ] Accept intentional upstream deletes before adapting callers. Delete the silent stale paths in Section 7.
- [ ] Establish v0.8.1 root/workspace manifests, dependency union, test-script names, upstream `prime-agent-runtime/pyproject.toml`/`uv.lock`, and the CPython file layout. Do not regenerate the npm lock or model catalog until their owners are final.
- [ ] Establish protocol revision 24 and command/capability union early so daemon/MCP callers target one contract.
- [ ] Review every text-clean overlap in Appendix B against base/fork/upstream, not only the synthetic result.
- [ ] Require `git ls-files -u` and `git diff --name-only --diff-filter=U` to return nothing; run `git diff --check` and a conflict-marker scan.

**Exit gate:** no unmerged paths; imports and package scripts point at one coherent CPython/daemon architecture; no generated artifact is treated as authoritative yet.

### Phase 2 — Finish the CPython, lifecycle, and process-ownership cutover

- [ ] Take upstream `ReplKernelManager` and all follow-up fixes as a unit.
- [ ] Port direct-process lifecycle events, environment scrubbing, 32-KiB bounded stderr/redaction, expected-exit and repair evidence into that manager.
- [ ] Preserve no-blind-retry semantics for uncertain stdio writes; repair from the last safe snapshot without replaying the cell.
- [ ] Compose `orphan-process-journal.ts`, `daemon-ps.ts`, owned worker, `rlm.bash`, and daemon close according to Section 8.
- [ ] Verify provisioner forwards `commandPrefix`/`shellPath` into `PRIME_AGENT_BASH_*`, bootstrap schema is 9, and override Python must import protocol-v3 `rlm.repl`.
- [ ] Migrate general old startup/lifecycle tests to `repl-kernel-*`; delete ZMQ/forkserver/history/shell-channel tests and assertions.
- [ ] Migrate bundled Python skills and prompts to host requests, `rlm.emit`, and managed `bash()`. Audit executable/current-doc surfaces for magic or blocking-subprocess guidance.
- [ ] Validate runtime packaging with `uv lock --check`; if the merged `pyproject.toml` truly requires regeneration, run `uv lock` once and recheck. Run Python tests with `uv run --locked` and require no lock diff afterward.
- [ ] Run the runtime-focused proof set before touching unrelated merge fallout.

**Exit gate:** the complete CPython/host/bash/snapshot/repair/lifecycle suite is green; production has no old-runtime owner or dependency; the old snapshot fixture restores supported values.

### Phase 3 — Compose daemon, fork features, generated artifacts, and UI

- [ ] Finish `AgentSession`, daemon mode/protocol/supervisor/session-list/ledger composition, including schema-24 compatibility and removal of eager peer sync.
- [ ] Prove cross-daemon resume, stale-daemon recovery, pending-open ownership, spawn failures, empty-session eviction, rename rollback, exact-once remote messaging, EOF-safe daemon stop confirmation, and MCP empty-session resume.
- [ ] Finish AIM/xAI/model/default/refinement/compaction composition at one provider-request boundary. Check for double auth resolution or stale model caches.
- [ ] Merge the model generator, regenerate `models.generated.ts`, rerun the generator for idempotence, and classify any live drift.
- [ ] Regenerate `package-lock.json` from final manifests with npm >=11.10. Audit 0.8.1 workspace ranges, MCP/zod/Mermaid presence, and zeromq absence.
- [ ] Finish TUI queue/message/heartbeat/model/Mermaid composition while retaining Ctrl-X, usage, FAST OFF, and effort behavior.
- [ ] Preserve fork bundle/source launcher and CI lanes; update kernel/process/MCP lists to current filenames.
- [ ] Update evergreen docs, skill docs, current bug status, and change fragments. Keep v0.8.1 released changelog text immutable and dated plans historical.

**Exit gate:** every fork-preservation ledger row has direct proof; generated owners reproduce their outputs; daemon and UI have no duplicate state owner.

### Phase 4 — Verify the whole result and create the merge commit

- [ ] Run the focused local matrix in Section 11. Fix causes, not assertions.
- [ ] Run `npm run check`; review any formatter edits and rerun the affected focused tests.
- [ ] Run static/deletion/generated/ancestry-preflight checks.
- [ ] Run source-mode smokes under isolated state: CLI help/version, bootstrap/protocol import, daemon create/list/attach/rename/stop, root-sibling exact-once message, depth-2 child, path/cross-daemon resume, empty detach/resume, MCP serve, and bundle entrypoint.
- [ ] Exercise UI behaviors through deterministic tests. Run any paid-provider/AIM live canary only after explicit authorization.
- [ ] Inspect the full staged merge and its `--remerge-diff`. Confirm no secret, local state path, or unrelated live catalog change entered the tree.
- [ ] Create one merge commit that records base, fork tip, upstream tip, CPython replacement, schema-24 composition, fork contracts, deletions, and proof. Keep follow-up audit repairs as ordinary commits if needed.

**Exit gate:** local allowed proof is green; merge commit has parents `(fork tip, upstream tip)` in that order; worktree is clean.

### Phase 5 — Independent audit, PR, remote CI, and merge policy

- [ ] Run a fresh read-only implementation audit against this plan. The reviewer must inspect all 49 overlap paths, delete side doors, generated artifacts, daemon compatibility, runtime ownership, and fork ledger—not just the visible conflict files.
- [ ] Repair blocking findings and rerun the narrowest affected proof.
- [ ] Push the integration branch normally and open/update a PR to the fork `main`. Include pins, merge topology, conflict strategy, runtime migration, schema revision, preservation table, test receipts, and rollback plan.
- [ ] Require all official/fork checks: build/check, agent-core, AI, TUI, all three coding-agent CI shards, process smoke (daemon + MCP), kernel, runtime Python, aggregate, and changelog fragment policy.
- [ ] Do not squash. Merge or fast-forward the already-created two-parent merge commit so official ancestry remains visible.
- [ ] After remote green, rerun ancestry and clean-tree audit against the actual PR head SHA.

**Exit gate:** audit approves, remote CI is green, PR head contains both reviewed tips, and no merge strategy can discard the official parent.
## 11. Test plan

### 11.1 Objectives and test strategy

The test plan proves behavior at the owner boundary first, then at integration seams, then through the repository's remote full matrix. It is risk-based: runtime/process/protocol behavior gets direct failure-path coverage; fork-preservation behavior gets targeted regressions; broad compatibility comes from CI.

Testing must answer five questions:

1. Did the official upstream tip land completely and retain visible ancestry?
2. Is CPython/`rlm.repl` the only execution runtime, including failure, repair, snapshot, and process-tree behavior?
3. Do daemon schema 24, recovery, saved-session, and messaging paths compose both lineages without duplicate state or delivery?
4. Do AIM/xAI/models/MCP/TUI/bundle fork contracts still work at their real owner boundaries?
5. Are generated artifacts, docs, packaging, and remote CI reproducible and clean?

### 11.2 Test environments and isolation

| Environment | Purpose | Required isolation |
|---|---|---|
| Pinned fork baseline (`ec626e8fa`) | Distinguish pre-existing failures from integration regressions; capture old snapshot fixture | temporary agent/session/socket/lifecycle roots; no real credentials |
| Integration worktree on macOS | Focused TypeScript/Python tests, static checks, generated artifacts, source/bundle smoke | worktree-local dependencies where practical; temporary HOME-equivalent state; exact PID/process-tree ownership |
| GitHub Actions Linux | Full build/check and complete workspace test matrix | clean checkout and `npm ci`; workflow-owned temporary state |
| Windows-specific unit/mocked paths | Validate job objects, `taskkill /T`, PID-only refusal, and path handling | no real unrelated process termination |
| Optional live provider canary | Only if separately approved after deterministic proof | named temporary account, bounded request, no auth mutation outside the canary |

Test fixtures:

- a non-secret old-IPython `kernel-state.dill/.json` fixture with scalars, containers, import, function, and class;
- malformed/truncated/reused-PID orphan-journal records;
- fork revision-23, official revision-23, and merged revision-24 daemon hello/command fixtures;
- fake AIM helpers for valid, stale, mismatched, timeout, oversized, usage-exhausted, and mixed-helper cases;
- isolated MCP HTTP/stdio daemon sessions, including an empty detached draft;
- deterministic model catalogs for generator assertions, with live drift classified separately.

### 11.3 Entry criteria and execution order

Entry criteria:

- refs, merge base, conflict inventory, and worktree branch match Section 1;
- baseline failures are recorded, including the stale Sol `xhigh` expectation against final source `max`;
- npm >=11.10, Node 22, uv, Python, and Git versions are recorded;
- no test points at real `~/.prime-agent`, real daemon sockets, or unrelated processes.

Execution order:

1. Run baseline fork regressions and capture the old snapshot fixture.
2. Resolve and statically audit the merge before generated output.
3. Run runtime/kernel tests immediately after the CPython slice.
4. Run daemon/protocol/process tests after schema and supervisor composition.
5. Run fork auth/model/MCP/TUI/bundle tests after feature composition.
6. Regenerate/check model, npm, and uv locks; run `npm run check`.
7. Run isolated source/bundle smokes and ancestry checks.
8. Push the PR and require the full clean GitHub matrix.

A failing step blocks later broader proof when it invalidates the same owner. Independent lanes may continue only when their proof remains fresh.

### 11.4 Test-case traceability matrix

| ID | Behavior under test | Main cases | Required evidence |
|---|---|---|---|
| TP-01 | Git topology and release truth | exact pins, 41 ancestors, parent order, v0.8.1 workspace ranges, immutable released changelog | ancestry commands, commit ledger, manifest/lock audit |
| TP-02 | CPython execution protocol | expression/statement/error, stdout/stderr, repr, persistent globals, top-level await, `input()` EOF, `rlm.emit`, background output | runtime Python suite; focused `repl-kernel-execute`/bootstrap/skill tests |
| TP-03 | Snapshot and repair | old simple dill restore, unpicklable values, size policy, corrupt frame, failed/partial write without replay, restore failure, bounded replacement/shutdown | state-roundtrip, protocol-corruption, startup/shutdown/abort tests plus fixture smoke |
| TP-04 | Managed bash | async handle, poll/tail/await/kill, ordered marker, truncation, timeout, concurrent abort-all, daemon close, POSIX tree and Windows job cleanup | Python bash/winjob, kernel-bash, provisioner, agent-session bash-persistence tests |
| TP-05 | Lifecycle and orphan safety | env scrub, bounded/redacted stderr, start/ready/exit/failure/kill, repair evidence, truncated journal, PID reuse, exact-dead and PID-only policies | lifecycle process, orphan journal, daemon-ps, owned-worker tests |
| TP-06 | Daemon schema compatibility | revision 24/digest, both hello consumers, peer min 24/capability, AIM handoff, old fork/old official/new combinations, unknown command rejection | protocol, worker-client compatibility, daemon mode, MCP handshake tests |
| TP-07 | Daemon/RLM recovery | recovery-before-reuse, pending-open ownership, coalesced starts, cross-daemon/path resume, stale hello reuse, no-hello untouched, empty eviction, rename rollback, exact-once remote message, EOF stop confirmation | supervisor monitor/lazy/eviction, session-list, ledger, routing/process, daemon-stop-confirm tests |
| TP-08 | Fork auth and model contracts | AIM descriptor/security/generation atomicity/usage/exhaustion/reset; xAI flow/non-interference; Sol alias 1M/900K/max, Fable/Opus xhigh, `/fast`, no CLI service tier, no retired Gemini synthesis | AIM/auth/xAI/Codex/model/compaction/SDK-thinking/status tests; generator audit |
| TP-09 | ACP and interactive behavior | reasoning-detail replay, assistant boundaries, terminal quiescence, queue duplicate edit, messageCount, derived models/heartbeats, multiline highlight, Mermaid modes, Ctrl-X archive, usage errors, FAST OFF | ACP, startup/status/streaming/queue/settings/heartbeat/connection/extension tests |
| TP-10 | MCP remote control | HTTP/stdio, bounded input/render, exact tool set, stale daemon connect, start/resume/restart/interrupt/kill, empty detach/resume, CPython transcript output | MCP render and real E2E in process lane |
| TP-11 | Packaging, docs, and launch | no zeromq/ipykernel/forkserver runtime, runtime uv lock, MCP/zod/Mermaid deps, atomic bundle fallback, source launcher any cwd, current prompt/skill/docs | static scans, lock checks, bundle publication, source/bundle smoke, doc review |
| TP-12 | Broad regression | build/check, agent-core, AI, TUI, three coding-agent shards, process, kernel, runtime Python, changelog policy | required GitHub checks on exact PR head |

### 11.5 Failure handling and exit criteria

For each failure, record the failing command/check, owner path, whether it reproduces on the pinned fork, and the smallest invalidated proof set. Do not weaken assertions, retry deterministic failures, or add compatibility machinery outside the approved boundary. A flaky retry requires evidence that the owner code is not responsible.

Test execution is complete only when:

- TP-01 through TP-12 have current evidence or an explicit external blocker;
- all focused local proof allowed by repo policy is green;
- generated files and locks are idempotent and unchanged after tests;
- source/bundle smokes use isolated state and leave no owned processes;
- required GitHub checks are green on the exact PR head;
- the implementation audit has no open authorized blocker.

### 11.6 Local focused proof (allowed on this repository)

Run exact files or bounded package lanes from the owning package root. For coding-agent Vitest, use `npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts`. Do **not** run bare `npm test`, bare `npm run test`, bare `npx vitest run`, or local `npm run build`.

| Area | Required local proof |
|---|---|
| Python runtime | `cd prime-agent-runtime && uv lock --check && uv run --locked python -m unittest discover -s test`; require no `uv.lock` diff afterward |
| REPL kernel | `repl-kernel-execute`, `abort`, `protocol-corruption`, `shutdown`, `startup`, `state-roundtrip`, `parent-watchdog`, `mcp-shutdown`, plus `ipython-bootstrap`, `ipython-provisioner`, `kernel-bootstrap`, bash-shell, goal, agent-message, attach-image, snapshot, and system-prompt files |
| Daemon / RLM | `agent-session-concurrent`, recursion/compaction/queue, `daemon-protocol`, mode, session-list, supervisor lazy/monitor/eviction, daemon errors, worker compatibility, RLM ledger, heartbeat, exact-once messaging, and regressions 4519/4602/4685 |
| Fork process safety | bounded `test:process` retaining daemon supervisor + MCP E2E; launch-lease, catalog lifecycle, socket compromise, runtime identity, cross-daemon resume, lifecycle, bundle publication |
| Auth / models | AIM request/usage, credential reset, auth storage, xAI OAuth/non-interference, regression 678, model registry/resolver, compaction, SDK thinking/defaults, generator idempotence, AI Fireworks/Prime/OpenAI/cross-provider/stream-failure files |
| Interactive / ACP / MCP | startup/status/usage/streaming, queue edit/selection, settings/Mermaid, heartbeat, subagent summary, ACP events/mode, connection/extension stop-and-archive, MCP render/E2E |
| Repository static | `npm run check`, `git diff --check`, conflict-marker/dependency/legacy-runtime scans, generated idempotence, version/lock audit |

Representative syntax for a bounded Node lane:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism \
  test/repl-kernel-execute.test.ts \
  test/repl-kernel-protocol-corruption.test.ts \
  test/repl-kernel-startup.test.ts \
  test/ipython-bootstrap.test.ts \
  test/orphan-process-journal.test.ts
```

Split long lists into coherent invocations to keep failures legible. Do not substitute a broad local suite.

### 11.7 Static and generated acceptance

Require all of the following:

- no `git ls-files -u`, unresolved markers, whitespace errors, or unexplained files;
- no production/package import of `zeromq`, Jupyter client, ipykernel, forkserver, or the old manager;
- no current prompt/skill/doc instruction to execute magics or blocking `subprocess.run`, `Popen`, or `os.system`; historical changelog and display-parser mentions are classified, not blindly deleted;
- old forkserver/shell-channel tests and `scripts/boot-bench.mjs` are absent;
- eager `syncAgentPeers` and dead main lookup seam are absent;
- protocol revision is 24, schema digest test passes, peer min revision is 24, and capability matrix is complete;
- root/workspaces and npm lock agree on 0.8.1; runtime `pyproject.toml`/`uv.lock` agree and omit IPython; MCP SDK, zod, and `grok-mermaid` exist; zeromq does not;
- model generator's second run and npm lockfile's second package-lock-only run are clean; `uv lock --check` passes and runtime tests leave `uv.lock` unchanged;
- Sol 1M alias/request ID/900K threshold and final thinking defaults exist; retired Google Generative AI Gemini 2.0 aliases remain unsynthesized without filtering live/Vertex IDs; upstream private-Prime and Qwen rules exist; CLI `--service-tier` remains absent while session `/fast` tests pass;
- source launcher and bundle do not reference deleted runtime artifacts;
- every upstream commit hash in Section 6 is an ancestor of the candidate.

### 11.8 Remote required CI

GitHub is the authority for the full build and broad suites:

1. Contributor trust / changelog fragment policy.
2. Build and check.
3. Agent-core tests.
4. AI tests.
5. TUI tests.
6. Coding-agent CI shards 1/3, 2/3, and 3/3.
7. Coding-agent process smoke, including retained MCP E2E.
8. Coding-agent kernel lane.
9. Runtime Python unittest lane.
10. Aggregate `build-check-test` gate and any fork-required workflow checks.

A retry is not a fix. Classify flake versus deterministic failure from logs and repair the owner before rerunning.

### 11.9 Ancestry and merge receipt

After the merge commit, let `M=$(git rev-parse HEAD)` and require:

```bash
git rev-list --parents -n 1 "$M"
git merge-base --is-ancestor ec626e8fa651da782e13ca4441fdc8a7255b1172 "$M"
git merge-base --is-ancestor 9f5edc192cfe3d4737205a2f551d2b6b6e34fe09 "$M"
git show --pretty=raw --no-patch "$M"
git show --remerge-diff --stat "$M"
git status --short --branch
```

The first command must show `M`, then fork tip, then upstream tip. Both ancestry commands must exit 0. The remerge diff is the primary receipt for deliberate human changes beyond Git's automatic merge.

## 12. Acceptance matrix

| Requirement | Evidence required before completion |
|---|---|
| Exact official tip integrated | two-parent merge receipt and upstream ancestry exit 0 |
| All 41 upstream commits covered | Section 6 checklist reviewed; focused/CI proof mapped; no skipped hash |
| CPython replacement complete | runtime/kernel suites; bootstrap schema 9; static legacy absence; simple old snapshot restore |
| Bash/process safety complete | Python bash + host bash + orphan + daemon-close + Windows containment proof |
| Daemon protocols composed | schema-24 digest/capability/old-new compatibility matrix green |
| Fork auth/model behavior preserved | AIM/xAI/request admission/default/alias/compaction tests green |
| Fork daemon/RLM behavior preserved | routing/recovery/lease/identity/ledger/exact-once/eviction tests green |
| MCP/TUI/bundle behavior preserved | MCP E2E/render, Ctrl-X/status/queue/Mermaid, bundle/source smoke green |
| Generated/release truth correct | owner regeneration clean; v0.8.1 manifest/lock audit; changelog policy green |
| No architecture side door | independent implementation audit approves all overlap/delete/static surfaces |
| Shippable branch | `npm run check`, all required remote CI, clean worktree, no secrets/unrelated drift |
## 13. Rollout and rollback

### Rollout

1. **Pre-upgrade:** finish or gracefully stop active fork sessions that matter. Capture a non-secret pre-cutover snapshot. Do not force-kill a daemon while host bash work is active.
2. **Atomic candidate:** deliver the Node CLI/bundle and matching `prime-agent-runtime` together. Never pair an old daemon with the protocol-v3 Python runtime or a new CLI with an unidentified schema-23 daemon.
3. **Bootstrap:** let schema 9 rebuild the managed kernel venv without ipykernel. Validate any `PRIME_AGENT_KERNEL_PYTHON` override by importing `rlm.repl`, checking protocol 3, and confirming `rlm.bash`/`rlm.emit`.
4. **Isolated canary:** use temporary agent/session/socket/lifecycle roots. Prove daemon, REPL, messaging, depth 2, resume, MCP, and bundle behavior before touching real user state.
5. **Session canary:** resume the captured old snapshot and inspect representative supported names. Keep the original artifact until this succeeds.
6. **Live enablement:** restart real daemons cleanly, then monitor bounded lifecycle evidence for start failures, repair loops, orphan-cleanup refusals, EMFILE hints, and protocol mismatch. Provider-backed canaries require explicit approval.

### Rollback

- Before public merge: delete the integration branch/worktree; the backup ref and `origin/main` pin remain intact.
- After public merge: stop new daemons gracefully, preserve candidate logs/snapshots, revert the merge with first-parent semantics (`git revert -m 1 <merge>`), and reinstall the prior fork bundle/runtime together. Do not rewrite shared history by reset/force-push.
- Restore the pre-upgrade snapshot only with the prior runtime. A snapshot written or normalized by the CPython runtime is not promised to downgrade to IPython.
- There is no database migration. Session JSONL and daemon catalogs remain in place; rollback must not run broad orphan cleanup against uncertain identity records.

## 14. Risk register

| Risk | Consequence | Mitigation / stop condition |
|---|---|---|
| Official `upstream/main` advances | plan no longer covers the exact requested tip | Refetch and recompute ledger/merge-tree before merge; stop until new commits/conflicts are folded in. |
| Live catalog changes during regeneration | unrelated model churn contaminates integration | Compare against both pins; refresh official pin or split for approval; never accept silently. |
| Straight merge deletes fork lifecycle safety | crashes become opaque or Python inherits wrong lineage | Port events/env scrub/32-KiB stderr to `ReplKernelManager`; lifecycle privacy/start/exit/repair tests gate. |
| ZMQ compatibility code survives | two runtimes and unowned recovery semantics | hard deletion/static gate; no shim; migrate only transport-neutral guarantees. |
| Uncertain stdio request is retried | a user cell can execute twice | fail explicitly, repair, never replay; partial-write regression. |
| Two incompatible schema-23 meanings collide | commands reach a daemon that cannot understand them | revision 24, new digest, peer min 24 + capability, old/new matrix. |
| Clean auto-merge combines two state owners | subtle queue/model/message/recovery races | Appendix B file-by-file review and direct concurrency/regression tests. |
| Empty-session eviction breaks MCP | empty remote-controlled draft becomes stranded | client-owned exemption audit plus MCP detach/resume E2E. |
| Lock generated by npm 11.5.1 | minimum-release-age policy or lock drift fails | provision npm >=11.10 before regeneration; CI `npm ci` is authoritative. |
| macOS-only local proof misses Linux/Windows process behavior | orphan/job containment regresses | runtime Python tests plus remote CI; retain Windows job/taskkill unit coverage and platform build checks. |
| Old snapshot contains IPython-only state | resume loses unsupported objects | document hard boundary, prove simple fixture, retain pre-upgrade artifact, never claim full IPython object compatibility. |
| Live AIM/provider canary changes auth or incurs cost | external side effect outside plan | deterministic isolated proof by default; require explicit approval and named temporary account for live calls. |

## 15. Documentation and research disposition

The exact upstream source and commit history are the authoritative design for this task. External web research would be weaker and can drift, so none is required.

Update current surfaces only:

- root and coding-agent README/runtime/architecture/quickstart/usage/skills/MCP/development docs;
- prompt and bundled skill guidance;
- the dated IPython shell-channel bug with a concise “resolved by CPython cutover” status;
- package change fragments and PR body.

Keep dated plans/worklogs and released changelog sections as historical evidence. Do not leave an evergreen document that tells users to install ipykernel, use magics, or diagnose the removed forkserver.

## Appendix A — Integration command skeleton

This is an execution aid, not a substitute for the phase gates:

```bash
# Refresh and verify pins
git fetch --prune --tags origin
git fetch --prune --tags upstream
test "$(git rev-parse origin/main)" = ec626e8fa651da782e13ca4441fdc8a7255b1172
test "$(git rev-parse upstream/main)" = 9f5edc192cfe3d4737205a2f551d2b6b6e34fe09
test "$(git merge-base origin/main upstream/main)" = e319a66d7351c75abe7f040d02d9a8d6e25028e9

git branch backup/pre-upstream-ec626e8fa ec626e8fa651da782e13ca4441fdc8a7255b1172
git switch -c integrate/upstream-9f5edc192 ec626e8fa651da782e13ca4441fdc8a7255b1172

git -c rerere.enabled=false -c merge.conflictStyle=zdiff3 \
  merge --no-ff --no-commit 9f5edc192cfe3d4737205a2f551d2b6b6e34fe09

# After deliberate resolution
test -z "$(git ls-files -u)"
test -z "$(git diff --name-only --diff-filter=U)"
git diff --check

# Generated owners, after source/manifests are final
npm --prefix packages/ai run generate-models
npm install --package-lock-only --ignore-scripts
(cd prime-agent-runtime && uv lock --check)

# Required local static check; full build/test stays on GitHub CI
npm run check
```

If the refreshed official tip differs, do not run the equality assertions and then ignore them. Update this plan first.

## Appendix B — Every same-path overlap (49/49)

| Class | Path | Required semantic review |
|---|---|---|
| conflict | `package-lock.json` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/ai/scripts/generate-models.ts` | Merge upstream live-catalog routing/private-model rules with the fork Sol 1M alias and generator-emitted `requestModelId`/`compactionThreshold`; regenerate once source is final. |
| conflict | `packages/ai/src/models.generated.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/README.md` | Keep upstream CPython/`bash()` language and fork Ctrl-X/AIM-visible behavior; remove live ipykernel guidance. |
| text-clean overlap | `packages/coding-agent/docs/long-running-agents.md` | Keep upstream Python REPL ownership language plus fork Ctrl-X/archive behavior. |
| text-clean overlap | `packages/coding-agent/docs/providers.md` | Carry upstream catalog/provider changes and fork AIM/xAI provider setup without duplicate or stale routes. |
| text-clean overlap | `packages/coding-agent/docs/quickstart.md` | Adopt upstream `bash()`/CPython examples; retain fork-specific supported CLI behavior only. |
| text-clean overlap | `packages/coding-agent/docs/usage.md` | Adopt upstream runtime wording and keep fork usage/stop controls. |
| conflict | `packages/coding-agent/package.json` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/scripts/bundle.mjs` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/src/cli/command-registry.ts` | Keep upstream command/help changes and fork `mcp-serve` command registration. |
| conflict | `packages/coding-agent/src/cli/daemon-command.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/src/cli/daemon-ps.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/src/cli/owned-session-worker.ts` | Combine upstream bash orphan-journal environment with fork process-lifecycle lineage and recovery. |
| text-clean overlap | `packages/coding-agent/src/core/agent-session.ts` | Adopt upstream host-reply, message admission, child snapshot, activity/quiescence, depth-2 and bash-abort ownership; preserve AIM request admission/retry and fork ledger semantics. |
| text-clean overlap | `packages/coding-agent/src/core/compaction/compaction.ts` | Adopt CPython naming/state behavior while preserving fork per-model compaction thresholds and AIM request identity. |
| text-clean overlap | `packages/coding-agent/src/core/kernel/bootstrap.ts` | Adopt schema 9/current-runtime checks and remove ipykernel/nest-asyncio; preserve fork uv system-only acceptance behavior. |
| conflict | `packages/coding-agent/src/core/kernel/fork-server-script.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/src/core/kernel/fork-server.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/src/core/kernel/index.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/src/core/model-registry.ts` | Remove upstream test-only reset API while retaining AIM-managed provider/model binding and post-auth refresh. |
| text-clean overlap | `packages/coding-agent/src/core/model-resolver.ts` | Adopt upstream catalog/default changes and private parser cleanup; retain fork alias/default/provider resolution. |
| conflict | `packages/coding-agent/src/core/orphan-process-journal.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/src/core/refinement/refinement.ts` | Use CPython host bridge and upstream refinement path while preserving fork model-registry request admission. |
| text-clean overlap | `packages/coding-agent/src/main.ts` | Adopt upstream spawn-error reporting and remove only the injected daemon-lookup fake; retain production cross-daemon/path routing and AIM startup. |
| conflict | `packages/coding-agent/src/modes/daemon/daemon-mode.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/src/modes/daemon/daemon-protocol.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/src/modes/daemon/rlm-ledger.ts` | Adopt unified legacy parsing without reopening fork fail-closed topology or routed-saved-session side doors. |
| conflict | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/test/auth-storage.test.ts` | Rewrite around removed cache reset without weakening AIM/xAI isolation. |
| text-clean overlap | `packages/coding-agent/test/compaction.test.ts` | Carry CPython state semantics and fork per-model threshold assertions. |
| text-clean overlap | `packages/coding-agent/test/daemon-mode.test.ts` | Preserve both upstream messaging/rename/snapshot/single-send/bash-close coverage and fork AIM/recovery/routing/lifecycle coverage. |
| conflict | `packages/coding-agent/test/daemon-supervisor-monitor.test.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/test/interactive-mode-startup.test.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/test/interactive-mode-status.test.ts` | Cover upstream messageCount/model/heartbeat derivation and fork FAST OFF/effort/usage status. |
| conflict | `packages/coding-agent/test/ipython-bootstrap.test.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/test/kernel-bootstrap.test.ts` | Replace ipykernel expectations with current `rlm.repl` checks while retaining fork managed-uv/system-interpreter regression coverage. |
| conflict | `packages/coding-agent/test/kernel-fork-server-protocol.test.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/test/kernel-fork-server.test.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/test/kernel-startup.test.ts` | See the explicit conflict-resolution contract above. |
| conflict | `packages/coding-agent/test/main-interactive-routing.test.ts` | See the explicit conflict-resolution contract above. |
| text-clean overlap | `packages/coding-agent/test/model-registry.test.ts` | Use public state seams after cache-reset deletion and retain AIM binding/default tests. |
| text-clean overlap | `packages/coding-agent/test/model-resolver.test.ts` | Adopt live catalog/private parser expectations plus Sol 1M and fork defaults. |
| text-clean overlap | `packages/coding-agent/test/rlm-ledger.test.ts` | Combine unified parser cases with fork fail-closed ordering/side-door cases. |
| text-clean overlap | `packages/coding-agent/test/subagent-summary-line.test.ts` | Combine upstream heartbeat render derivation with fork FAST OFF/priority/narrow-width behavior. |
| text-clean overlap | `packages/coding-agent/test/suite/acp-mode.test.ts` | Carry ACP terminal quiescence/reasoning boundaries and fork model/auth routing. |
| text-clean overlap | `packages/coding-agent/test/suite/regressions/4602-snapshot-transfer-idempotency.test.ts` | Preserve upstream centralized peer/message behavior and fork snapshot transfer invariants. |
| conflict | `packages/coding-agent/vitest.config.ts` | See the explicit conflict-resolution contract above. |
