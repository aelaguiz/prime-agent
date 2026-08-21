# Prime Agent upstream-main integration plan

**Status:** Ready for implementation  
**Date:** 2026-08-15  
**Owner:** Amir / Prime Agent fork maintainers  
**Fork repository:** `/Users/aelaguiz/workspace/prime-agent-deploy-20260812`  
**AIM contract repository:** `/Users/aelaguiz/workspace/aimgr`  
**Reviewed fork head:** `00efe79dc4484160cc5bd61cf69609936fe6bd39`  
**Pinned upstream head:** `97b994c3d7c45ca1ae635190e91e9e58ddf2577c` (`upstream/main`, Prime Agent `0.7.2`)  
**Fork point:** `d1b072686d6b7b1b7d2ad773541e33aba1f578d9`  
**Latest upstream release in scope:** `v0.7.2` at `83a0f9f9566219551fcb6ffaf7f519a815749a58`  
**Target integration branch:** `integrate/upstream-main-20260815` from the reviewed fork head  
**Estimated implementation:** 2–3 focused engineering days plus one day of staged host soak

> This is the canonical implementation, proof, cutover, and rollback plan. It deliberately treats Prime and AIM as one runtime contract while keeping their source repositories and credential ownership separate.

---

## TL;DR

### Outcome

Merge the reviewed fork lineage into pinned upstream `main`, retain every working AIM, xAI, Anthropic, daemon, and session-restoration capability, adopt upstream's worker-recovery and RLM durability improvements, include the already-started local kernel/peer-sync reliability fixes as separately proven commits, and deploy one byte-identical bundle across Amir's machines without losing or replaying any live session.

### Problem

The fork is only three commits ahead of its fork point but twenty-six commits behind upstream. Upstream has the post-freeze worker lifecycle, stop finalization, stale-registration reclaim, root-kill race repair, durable RLM ledger, queue editing, resume restoration, and terminal fixes the fleet needs. The fork contains AIM session affinity, safe credential handoff, Codex one-shot recovery, `/usage`, exact runtime identity, native xAI subscription OAuth, Grok 4.6, and Anthropic exhaustion fail-fast behavior that upstream does not have. Both lineages change the daemon protocol and several high-traffic auth/session files. A textual merge alone can compile while silently breaking account affinity, request admission, model rails, or post-crash recovery.

### Approach

1. Preserve immutable inputs and do all integration in a clean worktree.
2. Merge the pinned upstream commit into the reviewed fork lineage; do not merge the older divergent `origin/main` implementation by file choice.
3. Resolve daemon, auth, model, session, and generated-catalog changes semantically from one explicit contract ledger.
4. Close two known integration gaps while the affected surfaces are open:
   - pass AIM credential-generation identity end-to-end into Codex transport cache/continuation scoping;
   - support current AIM-managed `xai` without breaking native `/login xai` or API-key xAI.
5. Land the uncommitted SQLite-history and daemon peer-sync reliability work as separate reviewable commits, never as a dirty-tree sweep.
6. Prove behavior with targeted Prime and AIM tests, full static checks, isolated daemon/session canaries, and controlled crash/resume drills.
7. Deploy by exact bundle hash: isolated local canary, idle Mac Studio, then coordinated local and `home` cutovers with transcript-preserving rollback.

### Non-negotiables

- No session transcript, branch, working-directory file, subagent lineage, AIM binding, or credential identity is discarded.
- No interrupted prompt, tool call, build, test, deploy, GitHub action, or mutation is replayed during restoration.
- No credential is printed, copied into Git, persisted in a transcript, or proactively rotated.
- Existing Codex, Claude, and Grok AIM behavior is preserved; native xAI remains available when AIM management is disabled.
- Anthropic unified usage exhaustion remains terminal and fast; generic 429s remain retryable; automatic Claude rotation is still out of scope.
- Busy supervisors are never replaced as an incidental install side effect. Every live-host cutover has an explicit inventory, go/no-go gate, coordinator, and rollback bundle.
- `packages/ai/src/models.generated.ts` is never hand-edited. Update the generator/source inputs and regenerate deterministically.
- The shared dirty checkout is evidence, not an integration workspace. Only named, owned changes may cross into the clean branch.

---

## 1. North Star

### Claim

After the upgrade, a user can start, run, rotate, resume, crash, recover, queue, and delegate a Prime Agent session through AIM on Codex, Claude, or Grok and observe the same account/model/session identity before and after daemon or worker failure—while gaining upstream `0.7.2` behavior and without hidden long retries, stale worker wedges, cross-account transport continuation, or shared IPython history contention.

### Observable done state

1. **Ancestry:** the final branch contains both `00efe79dc` and pinned upstream `97b994c3d` as ancestors, with an auditable merge commit.
2. **AIM continuity:** secret-free provider bindings persist per root tree; descendants inherit them; `aim prime use/run/resume/status/uninstall` and hidden handoff work for supported providers; AIM's credential helper remains the only source of managed tokens.
3. **Provider correctness:** managed Codex, managed Claude, managed Grok, native xAI OAuth, and xAI API-key paths use their intended request rail and do not reshape one another.
4. **Failure correctness:** Codex exhaustion gets only the existing safe one-shot AIM recovery; Anthropic unified exhaustion fails fast with reset metadata and never auto-rotates; generic transport/rate failures retain upstream retry policy.
5. **Recovery correctness:** timed-out stops finish in the background, stale registrations are reclaimable, root cleanup ownership survives races, durable RLM mutations reconcile after supervisor restart, and null assistant content cannot crash transcript rendering.
6. **Kernel correctness:** forked and direct IPython kernels do not contend on shared `history.sqlite`; blocked peer synchronization cannot stall the supervisor control plane.
7. **Deployment correctness:** local, `home`, and Mac Studio run one verified bundle hash after staged cutover; all pre-existing sessions remain resumable; obsolete compatibility shims are retired only after proof.

### In scope

- Merge/upstream conflict resolution and preservation of the three fork-only commits.
- Upstream worker lifecycle, stale-registration, RLM ledger, queue/resume/model discovery, dependency, and terminal changes.
- Current Prime↔AIM external credential contract, including AIM-managed xAI now present in AIM `b8771d37cb933cea5d52f0d34d9fe6413b2e33eb`.
- Existing dirty kernel-history and daemon peer-sync fixes, landed separately after exact-diff preservation and focused proof.
- Generator-based reconciliation of the model catalog.
- Tests, source/build validation, deployment, rollback, and evergreen documentation.

### Out of scope

- Automatic Claude rotation, proactive usage polling, a provider proxy, an SSE inactivity watchdog, or a quota-monitoring daemon.
- A new kernel watchdog/automatic dead-kernel restart beyond the concrete history/peer-sync fixes already under development.
- Changing AIM's Redis account-selection policy, leases, account inventory, or credentials.
- Rewriting Prime's daemon architecture, replacing append-only session JSONL, or inventing another protocol layer.
- Releasing/tagging a public `0.7.3`, force-pushing shared history, or deleting old branches/worktrees during integration.
- Folding AIM's unrelated dirty scheduled-routine work into Prime. It is an external compatibility consumer and canary only.

### Acceptance evidence

- Git ancestry and range-diff receipts.
- A preservation-ledger checklist tied to named tests and live probes.
- Targeted Prime package test receipts, targeted AIM contract test receipts, `npm run check`, and `git diff --check`.
- A deterministic generated-model diff from the generator, not a hand patch.
- Source and bundle manifests plus build IDs for every host.
- Before/after session inventories and exact resume receipts for representative root trees with subagents.
- Controlled worker-stop/reclaim and supervisor-restart receipts.
- Provider canaries that return known non-secret sentinels and record provider/model/binding fingerprints only.
- A rollback drill or dry-run showing the prior wrapper/bundle can regain control without modifying transcripts or AIM state.

---

## 2. Code-grounded baseline

### 2.1 Git lineage and divergence

| Lineage | Commit | Meaning |
|---|---:|---|
| Fork point | `d1b072686` | Common ancestor; package version `0.7.1` |
| Fork feature 1 | `3c4f91d1f` | AIM-backed session restoration, request admission, handoff, `/usage`, Codex recovery, build identity |
| Fork feature 2 | `3c6c129da` | Native xAI device OAuth, Responses remap, Grok 4.6, live model rebind |
| Fork feature 3 | `00efe79dc` | AIM Anthropic zero hidden retries and terminal structured usage exhaustion |
| Upstream release | `83a0f9f95` | `v0.7.2` |
| Pinned upstream main | `97b994c3d` | Nineteen commits after `v0.7.2`; reviewed integration target |
| AIM consumer | `b8771d37c` | Current AIM code and deployed wrappers reviewed with this plan |

`git rev-list --left-right --count` showed three fork-only commits and twenty-six upstream-only commits. Upstream changes 124 files (approximately `+9,733/-1,886`). Eighteen paths overlap the fork commits. The committed-tree merge simulation predicted six textual conflicts:

- `packages/ai/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`
- `packages/coding-agent/test/daemon-protocol.test.ts`
- `packages/coding-agent/test/daemon-supervisor-monitor.test.ts`

Textual conflicts are not the full risk. `agent-session.ts`, `sdk.ts`, `daemon-mode.ts`, `daemon-supervisor.ts`, `interactive-mode.ts`, `auth-storage.ts`, and provider transports can auto-merge while violating cross-file invariants.

### 2.2 Do not merge the wrong fork lineage

Local `origin` is `git@github.com:aelaguiz/prime-agent.git`; official upstream is `git@github.com:PrimeIntellect-ai/prime-agent.git`. `origin/main` contains an older divergent credential-broker/xAI history. It is not the integration source of truth and must not be merged or preferred wholesale. The clean branch starts at `00efe79dc`, merges the pinned `upstream/main`, then becomes the candidate for the fork's canonical `main` through an ordinary reviewed PR/merge. Preserve ancestry; do not rebase or recreate the three fork commits.

### 2.3 Working-tree preservation boundary

The shared checkout currently contains modified source/tests and an unrelated untracked document. The relevant uncommitted reliability changes are:

- `packages/coding-agent/src/core/kernel/index.ts`
- `packages/coding-agent/src/core/kernel/fork-server-script.ts`
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`
- `packages/coding-agent/test/ipython-bootstrap.test.ts`
- `packages/coding-agent/test/kernel-fork-server.test.ts`
- `packages/coding-agent/test/kernel-startup.test.ts`
- `packages/coding-agent/test/daemon-supervisor-lazy-subagents.test.ts`
- `packages/coding-agent/test/daemon-supervisor-monitor.test.ts`

The current `packages/ai/src/models.generated.ts`, changelog edits, and `docs/PRIME_AGENT_THINKING_LEVEL_STATUS_COLOR_2026-08-13.md` have separate provenance and must not be swept into this branch. Before implementation, capture the exact relevant diffs and their `git diff --check` output in an artifact outside the clean worktree; then import only reviewed patches or commits. Never stash/pop the whole shared tree as an integration mechanism.

### 2.4 Deployed fleet baseline to preserve

| Host | Current source/install evidence | Transitional state |
|---|---|---|
| Local Mac | `/Users/aelaguiz/workspace/prime-agent-deploy-20260812`; source `00efe79dc`; installed candidate `bundle-v1:3b8c87c66843bfbebcd4fcf97e689d554bd907b3c0094a2d10fe116092d4c48f`; wrapper `~/.local/bin/prime-agent` | Compatibility client under `~/.local/share/prime-agent/compat/6146/`; resident sessions must be re-inventoried at cutover |
| `home` | `/home/aelaguiz/workspace/prime-agent-session-handoff-20260810`; source `00efe79dc`; protected supervisor `bundle-v1:765cb18a7d6c00b114a5f46ca5095d77f8cf1f89c6f579d525c7b4f921157a77` | Compatibility client under `~/.local/share/prime-agent/compat/765cb18a/`; temporary pristine/launcher assets preserve rolling compatibility |
| Mac Studio | `/Users/agents/workspace/prime-agent`; source `3c6c129da0670197959e77c076bc1ae266926668`; `bundle-v1:6146e71ce631a6375c1ff5d2d66017a52d0c3fd9793f1de95c477064165c1d6b` | Last observed with zero Prime sessions; must be rechecked before using it as the first host canary |

These are historical verified receipts, not permission to assume current process/session state. Phase 0 must refresh them. Compatibility directories are rollback/protection assets until no live client, supervisor, or worker references them.

### 2.5 Upstream value to adopt

The following upstream stack is directly relevant and should remain semantically intact:

| Commit | Required behavior |
|---:|---|
| `2857e2346` | Truthful `stopping` / `recovering` worker lifecycle and fail-fast command routing |
| `e9ef57774` | Background stop finalization, safe escalation through `SIGKILL`, zombie handling, PID-generation checks, cleanup retries |
| `14d6e7491` | `reclaimStaleWorkerRegistration()` repairs stale registrations during resume |
| `7787f0741` | Preserves exact root-kill cleanup ownership through supervisor races |
| `97b994c3d` | Supervisor-owned durable RLM spawn/rename/delete ledger and reconciliation |
| `1ae59498f` | Null assistant content no longer crashes transcript rendering |

Also adopt upstream queue mutation/preservation, restored CLI `/resume` and `--resume`, Codex model discovery, reasoning metadata, Qwen 3.8 Max, agent sorting, Ghostty/fullscreen mouse/link fixes, TypeScript/dependency updates, and all release/changelog changes between the pinned refs unless a named fork invariant requires composition.

Upstream does **not** contain a substantive IPython hang fix. Its kernel changes are host-request scaffolding, not a watchdog, automatic restart, ZMQ inactivity recovery, or SQLite-contention repair. Do not claim the merge alone solves kernel hangs.

### 2.6 Internal evidence anchors

Use these as intent and operational evidence, not as substitutes for final-code proof:

- `docs/aelaguiz/CLAUDE_USAGE_EXHAUSTION_FAIL_FAST_PLAN_2026-08-15.md`
- `docs/aelaguiz/CLAUDE_USAGE_EXHAUSTION_FAIL_FAST_PLAN_2026-08-15_WORKLOG.md`
- `packages/coding-agent/src/core/aim-external-auth.ts`
- `packages/coding-agent/src/core/auth-storage.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/ai/src/providers/openai-codex-responses.ts`
- `packages/ai/src/utils/oauth/xai.ts`
- `packages/ai/src/providers/openai-responses.ts`
- `packages/ai/src/utils/stream-failure.ts`
- `packages/coding-agent/src/modes/daemon/{daemon-protocol,daemon-mode,daemon-supervisor,rlm-ledger}.ts`
- `packages/coding-agent/src/cli/{daemon-launch,daemon-update-restart,daemon-ps,public-command,daemon-command}.ts`
- AIM: `src/pi/{harness-auth,harness-target,prime-target}.js`, `src/credentials/credential-helper.js`, `src/status/redis-view.js`, `src/routines/run.js`, and corresponding tests/runbooks.

No external web research is required for this merge. The decisive truth is the two reviewed repositories, immutable commits, existing tests, and live deployment receipts.

---

## 3. Current architecture and failure model

### 3.1 Provider/session path

```text
aim prime use/run/resume
  -> AIM chooses provider account from Redis and writes a secret-free
     external descriptor into Prime's auth.json
  -> Prime invokes the trusted AIM helper over newline-delimited JSON
  -> helper resolves an ephemeral token + credential generation
  -> Prime atomically admits the request against that generation
  -> provider transport opens
  -> root session journals the provider binding; descendants inherit it

manual --rotate / hidden handoff
  -> AIM proves the requested account identity
  -> Prime daemon validates root/model/old binding/old fingerprint
  -> binding journal flushes durably
  -> new generation becomes visible without rebuilding the session tree
```

The credential protocol is exactly `aimgr-credential-v1`. Persisted descriptors and session entries are secret-free. Helper executable path, owner/mode trust, identity fingerprint, request/response schema, timeouts, byte limits, and error allowlist are security and compatibility boundaries—not incidental implementation details.

### 3.2 Failure policy by provider

- **AIM Codex:** one automatic advance only for an AIM-admitted, unopened, zero-semantic-output terminal `usage_limit_reached` 429. Never reuse a prior account's Responses/WebSocket continuation after generation changes. The generic AgentSession retry loop must not add retries.
- **AIM Claude:** disable Anthropic SDK retries only after AIM admission. Classify only Anthropic unified-status `rejected` plus `rate_limit_error` as `usage_limit`; persist `retryAfterMs` and millisecond `resetAt`; display exact UTC reset; do not auto-advance.
- **Generic 429/transient errors:** preserve ordinary retry behavior.
- **xAI:** native stored OAuth currently reshapes xAI models to Responses and may inject Grok 4.6; API keys remain on the generated API-key rail. AIM has since gained an `xai` target, creating a new dual-owner contract that Prime's current provider allowlists do not yet fully support.

### 3.3 Daemon/session path

```text
CLI/runtime build identity
  -> daemon launch compatibility gate (protocol + schema ID + app version; build is diagnostic)
  -> supervisor owns worker registrations and root-tree routing
  -> workers own AgentSession runtimes and kernels
  -> JSONL session journals remain durable truth
  -> upstream RLM ledger adds supervisor-owned mutation intent/reconciliation
```

The fork uses daemon protocol 7, schema revision 15, ID `protocol-7-schema-15-610272005198`, and capability `aim_credential_handoff`. Upstream uses protocol 7, schema revision 16, ID `protocol-7-schema-16-1bcb9e7f1a49`. Selecting either file would erase the other's commands/capabilities. The combined target must allocate revision 17 and a newly generated schema ID after both surfaces are composed.

### 3.4 Known reliability gaps

1. Pre-upstream workers can remain in ambiguous stop/recovery states and stale registrations can block resume.
2. RLM mutations are not durable across a supervisor crash in the fork.
3. Direct and fork-server IPython kernels can share `history.sqlite`, creating concurrent SQLite contention; the local patch disables history at bootstrap in both paths.
4. Daemon peer synchronization can await slow/dead workers on the control path; the local patch makes it non-blocking and coalesces bursts.
5. AIM request admission exposes `transportAuthIdentity`, while the Codex provider currently reads `options.metadata.aimCredentialCacheKey`; existing tests prove the two halves separately, not the end-to-end bridge. This can leave transport continuation scoped only by decoded account ID.
6. AIM now installs/manages an `xai` external descriptor, but Prime's `AimCredentialProvider` and hidden daemon provider validation still allow only `openai-codex | anthropic`.

---

## 4. Target architecture and decisions

### 4.1 Integration topology

Use a normal two-parent merge in a new worktree rooted at `00efe79dc`:

```text
d1b072686
  ├─ fork: 3c4f91d1f -> 3c6c129da -> 00efe79dc ─┐
  └─ upstream: ... -> 83a0f9f95 -> ... -> 97b994c3d ─┴─ integration merge
```

This intentionally differs from replaying the three patches onto upstream. A merge keeps the reviewed feature commits immutable and visible, gives future upstream merges the correct merge base, and proves both exact heads are ancestors. Use per-commit diffs during conflict resolution to obtain the sequencing benefit of a replay without discarding lineage.

Do not update the pinned upstream SHA during implementation. A newer upstream head requires a brief delta review and an explicit plan amendment before it enters the branch.

### 4.2 One auth owner per active request

The final runtime recognizes these mutually exclusive active sources:

| Provider path | Credential owner | Model/catalog owner | Retry/failover owner |
|---|---|---|---|
| AIM `openai-codex` | AIM helper + root binding | merged Prime Codex catalog/discovery | Codex transport + one narrow AIM advance |
| AIM `anthropic` | AIM helper + root binding | Prime Anthropic catalog | Prime structured failure classifier; no AIM advance |
| AIM `xai` | AIM helper + root binding | Prime subscription xAI transform | ordinary provider policy; manual AIM handoff only |
| Native xAI OAuth | Prime `auth.json` OAuth | same subscription xAI transform | native refresh/provider policy |
| xAI API key/env/runtime key | user/runtime | generated API-key xAI catalog | ordinary provider policy |

There is no Redis client in Prime, no bearer token in session JSONL, and no second xAI model table. Refactor/rename the current OAuth-only `applyXaiOAuthModels()` into a shared subscription-model transform, or wrap it with one canonical function, and invoke it when the authoritative active source is either native xAI OAuth or an AIM external xAI descriptor. Keep API-key/runtime/env users on the generated rail. Add Grok 4.6 only when absent, and preserve the existing Responses request shape and encrypted reasoning replay.

### 4.3 Complete xAI AIM support, not a partial allowlist

Close the current asymmetry in both repositories in one bounded companion change:

- Prime: extend manual handoff provider typing, daemon command validation, schema, runtime request validation, persisted binding/snapshot exposure, and managed-source model refresh/rebind to `xai`.
- AIM: make `aim prime resume <session> --rotate` select a different eligible xAI identity instead of falling through the current Codex/Claude selection branch; keep the private seven-argument handoff call and exact identity checks.
- Keep helper `advance` and automatic unopened-request recovery **Codex-only**. xAI handoff is operator-requested, idle-tree-safe rotation—not automatic quota failover.
- Keep `--grok off` / uninstall semantics: removing AIM's xAI descriptor restores native OAuth/API-key resolution without changing those credentials.
- Update the existing “xAI AIM noninterference” test from “AIM never manages xAI” to the actual invariant: each active source selects one rail, and xAI changes never reshape AIM Codex/Anthropic models.

### 4.4 One typed credential-generation bridge

Replace the ad-hoc split between coding-agent `transportAuthIdentity` and AI-provider `metadata.aimCredentialCacheKey` with one typed field or one explicit SDK boundary mapping. Required behavior:

1. request admission returns a process-local opaque generation identity;
2. normal stream and all `completeSimple` paths carry it to the provider options;
3. Codex Responses/WebSocket caches, `previous_response_id`, and SSE fallback keys include it;
4. the value is never serialized to session history, diagnostics, daemon wire, or logs;
5. generation changes invalidate continuation even when decoded account ID is unchanged;
6. non-AIM and non-Codex providers ignore it.

Add an end-to-end test through the coding-agent SDK into the real Codex transport option builder. Do not accept separate unit tests that manually inject each half.

### 4.5 Combined daemon schema

Final daemon wire target:

- `DAEMON_PROTOCOL_VERSION = 7`
- `DAEMON_SCHEMA_REVISION = 17`
- a newly generated schema ID derived from the final revision-17 wire shape
- upstream queue mutation capability/commands and truthful stopping semantics
- fork `aim_credential_handoff` capability and `handoff_aim_credential` command
- upstream RLM ledger-backed topology and mutation ordering

Compatibility is capability-led:

| Peer | Schema/capability | Expected behavior |
|---|---|---|
| Old fork worker | rev 15 + AIM cap | AIM handoff allowed; queue mutation rejected before write |
| Upstream worker | rev 16 + queue/stopping caps | queue allowed; AIM handoff rejected before write |
| Merged worker | rev 17 + both caps | both allowed |

Keep AIM command minimum schema 15 **plus** required `aim_credential_handoff`; keep queue mutation minimum schema 15 plus its distinct capability; truthful stopping remains revision 16 behavior. The unique capability prevents unrelated schema-15 peers from being mistaken as compatible.

### 4.6 Supervisor and RLM ownership

Compose, do not choose between, these invariants:

- missing worker runtime identity fails before authentication;
- protocol, schema ID, and app version protect CLI/daemon reuse; exact runtime identity remains diagnostic, and rolling worker adoption accepts wire-compatible build differences;
- identity rejection never kills or relaunches a live worker;
- upstream stop tombstones, stop counters, background finalizers, PID/start-generation checks, root-kill ownership, and `stopping`/`recovering` reporting remain authoritative;
- stale worker registration reclaim runs during resume before declaring a session blocked;
- supervisor RLM ledger is the authority for sibling/name/spawn/rename/delete intent;
- child create and passive hydration share the root's `AuthStorage`, then publish runtime/session, durably append/flush ledger intent, and only then return admission;
- a hydrated/passivated descendant rejoins the root credential object without replacing ledger topology with session-header traversal.

### 4.7 Kernel and peer-sync reliability

Land the existing dirty work by intent, not by raw diff:

- Disable persistent IPython history in both direct and fork-server bootstrap while retaining in-memory `input_hist_raw` and Prime's own active-execution/last-cell source attribution. Do not touch host-request comms, disposal waits, or ACP/RLM APIs.
- Add peer-sync coalescing so event bursts do not launch redundant fan-out.
- Preserve upstream's deliberate `await syncAgentPeers()` barriers after startup/create/launch/adopt/recover where completion means peers are published. Make only event-driven cleanup/broadcast paths fire-and-forget, with surfaced diagnostics and a subsequent coalesced run. A blanket `void` conversion is rejected.

These are narrow mitigations for proven contention/control-plane stalls. They do not justify claiming automatic kernel recovery or general stream-watchdog coverage.

### 4.8 Versioning and generated artifacts

- Preserve upstream package version `0.7.2` and its release boundary exactly once.
- Put fork integration bullets under current `[Unreleased]`; do not mint a tag or public release in this plan.
- Keep upstream `OPENAI_CODEX_CLIENT_VERSION = "0.147.0"` catalog-discovery behavior; do not restore the old package `VERSION` substitution.
- Preserve the dirty generated-model diff only as catalog-intent evidence. Merge the generator/tooling first, update a generator/source input only if required, regenerate once from the merged tree, and inspect deterministic output. Never patch `models.generated.ts` directly.
- Build ID, not package version alone, distinguishes this custom `0.7.2` runtime from official upstream and prior local bundles.

---

## 5. Preservation ledger

Every row is a blocking acceptance requirement. “Preserved” means exercised through the merged code path, not merely present as a symbol.

### 5.1 AIM credential and session invariants

- [ ] External descriptor exact shape remains `{type:"external", source:"aimgr", protocol, executable, args, binding, expectedIdentityFingerprint}` with no unknown keys.
- [ ] Protocol remains `aimgr-credential-v1`; session entry remains `aimgr_credential_binding_v1`; legacy binding records remain readable.
- [ ] Helper is an absolute directly executable path with owner/non-writable trust checks; no shell; minimal env; 45-second timeout; 8 KiB request, 64 KiB stdout, 8 KiB stderr bounds.
- [ ] Helper resolve works for managed Codex/Claude/Grok; helper automatic advance remains Codex-only with `usage_limit_reached`.
- [ ] Root binding wins over global auth, survives restart and descriptor rebinding, and is shared by descendants without persisting a token.
- [ ] Request admission is atomic against one credential generation for normal streams and every `completeSimple` side path: compaction, branch/split summaries, refinement/review, daemon summaries.
- [ ] Existing admitted work may finish across manual handoff; new work sees the new generation.
- [ ] Manual handoff is root-only, idle-tree-safe, same provider/model, old/new identity-checked, append-and-flush-before-publish, race/coalescing safe, and non-rebuilding.
- [ ] `AgentConnectionState.credentialBindings` remains optional for older peers and secret-free.
- [ ] A binding journal entry alone still does not make an otherwise empty session user content.

### 5.2 AIM CLI and extension invariants

- [ ] `aim prime use/run/resume/status/uninstall` preserve their public behavior and provider/model mapping.
- [ ] Plain resume never rotates. `--rotate` changes only an eligible same-provider identity, then resumes the exact root.
- [ ] `prime-agent __aim-handoff-credential` stays private/absent from public help, JSON-only, root-scoped, and secret-free.
- [ ] `PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_SESSION_DIR`, legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, `PRIME_AGENT_LAUNCHER_PATH`, launcher-only `--dist`, and `--no-env` remain compatible with AIM wrappers and routines.
- [ ] AIM session-title/footer extension APIs still work: custom entries, session ID/name, widget/title, and session/input/agent/shutdown events.
- [ ] `/usage` remains a real command, reports the exact session AIM label rather than pool data, is bounded/sanitized, and has explicit unavailable/stale/unmanaged states for all managed providers.
- [ ] Prime never acquires Redis ownership; AIM remains authoritative for account inventory, leases, status, and token resolution.

### 5.3 Codex invariants

- [ ] One automatic AIM advance only for unopened, no-semantic-output `usage_limit_reached` 429.
- [ ] No retry after semantic output, no second automatic advance, no generic AgentSession retry, and safe unavailable diagnostics.
- [ ] Nested WS/SSE/HTTP provider metadata survives normalization.
- [ ] WS continuation, SSE fallback, and previous response identity are scoped by session plus AIM credential generation end-to-end.
- [ ] Upstream Codex model discovery and reasoning metadata remain functional with client version `0.147.0`.

### 5.4 Claude invariants

- [ ] AIM-admitted Anthropic streams and side paths use SDK `maxRetries: 0`; unmanaged Anthropic retains configured retries.
- [ ] Only structured unified `rejected` + Anthropic rate-limit errors become terminal `usage_limit`; generic 429 remains `rate_limit` and retryable.
- [ ] `retryAfterMs` is milliseconds; `resetAt` is epoch milliseconds; headers are case-insensitive; UI renders stable UTC ISO.
- [ ] `usage_limit` is persisted/diagnosed and bypasses AgentSession 2/4/8-second retries.
- [ ] No automatic Claude account rotation, preflight poll, silence inference, or SSE watchdog is introduced.

### 5.5 xAI invariants

- [ ] Native device OAuth retains RFC 8628 pending/slow-down/deadline/cancel/error behavior and safe refresh-token rotation.
- [ ] Native subscription and AIM-managed subscription use the same Responses model transform; API key/env/runtime key remains on generated API-key rail.
- [ ] Grok 4.6 appears for subscription sources, not because the generated file was hand-edited.
- [ ] Responses requests preserve encrypted reasoning replay and all request-shape fields used by live-session rebind detection.
- [ ] Auth/catalog refresh rebinds the live model when request shape changes, reclamps thinking, and preserves object identity when shape is unchanged.
- [ ] xAI source changes do not replace or reshape AIM Codex/Anthropic descriptors.
- [ ] Manual AIM Grok rotation is end-to-end; automatic xAI advance remains absent.

### 5.6 Daemon/kernel invariants

- [ ] Protocol version, schema ID, app version, and command capabilities govern daemon admission; source/bundle build and launcher identities remain diagnostic while intentional rolling-worker adoption stays wire-safe.
- [ ] Queue edit/preservation, restored resume, truthful stopping/recovering states, stale-registration reclaim, root-kill ownership, and durable RLM ledger all pass together with AIM handoff.
- [ ] Daemon reap remains tombstone/canonical-path/dead-worker safe; snapshot transfer IDs remain unique/idempotent.
- [ ] Null assistant content renders without a crash.
- [ ] Direct and forked kernels have persistent history disabled without losing Prime's in-memory cell/source behavior.
- [ ] Peer-sync bursts coalesce without weakening required create/recover publication barriers.

---

## 6. Call-site audit before editing

The implementer must mark each row reviewed against the final merge diff. This is the antidote to clean textual merges that break distributed contracts.

| Contract | Prime source/tests to inspect | AIM/external consumer to inspect | Required final ownership |
|---|---|---|---|
| External descriptor + helper protocol | `core/aim-external-auth.ts`, `core/auth-storage.ts`, `auth-storage.test.ts` | `targets/harness-auth.js`, `cli/commands/credential-helper.js`, `credentials/harness-access.js` | AIM resolves; Prime validates/admit/pins |
| Session binding journal | `agent-session-runtime.ts`, `main.ts`, `session-manager.ts`, connection snapshots/types | `prime-sessions.js`, session identity extension | Root JSONL secret-free truth |
| Request admission | `sdk.ts`, `model-registry.ts`, all summary/refinement call sites, `aim-request-admission.test.ts` | helper resolve/identity generation | Prime atomic admission |
| Codex generation cache | `sdk.ts`, `openai-codex-responses.ts`, their tests | AIM credential generation | One typed process-local key |
| Codex auto advance | `sdk.ts`, `agent-session.ts`, `interactive-mode.ts` | AIM helper `advance` and Redis eligibility | Codex-only, one shot |
| Claude exhaustion | `stream-failure.ts`, `sdk.ts`, `model-registry.ts`, `agent-session.ts` | AIM external Anthropic descriptor | Prime classification, no rotation |
| xAI source precedence | `auth-storage.ts`, `model-registry.ts`, `oauth/xai.ts`, provider request builder | `prime-grok-use.test.js`, xAI target/status/login | One active source, shared subscription transform |
| Live model rebind | `agent-session.ts`, in-process connection, daemon mode, interactive mode | managed provider changes | Catalog refresh before state refresh |
| Hidden handoff CLI | `public-command.ts`, `daemon-command.ts`, protocol/mode/supervisor | `prime.js` resume/rotate | Private JSON bridge |
| Daemon schema/capability | protocol, client, worker protocol, supervisor forwarding | installed old clients/workers | Revision 17 + capability gates |
| Runtime identity | `daemon-runtime-identity.ts`, launch, supervisor, shell launcher | AIM configured launcher/wrappers | Closure-scoped diagnostic build identity; wire contract fences reuse |
| Worker recovery | supervisor, child-process utilities, ps/orphan journal | AIM exact-session resume | Upstream lifecycle authority |
| RLM mutation | `rlm-ledger.ts`, daemon mode/supervisor, ACP APIs | agent/extension consumers | Supervisor ledger authority |
| Queue/resume | agent session, daemon mode, interactive mode, public CLI | AIM resume path | Upstream UX + pinned auth |
| Kernel bootstrap | kernel index/fork script/bootstrap | RLM host request and IPython skills | No SQLite history; comms intact |
| Peer synchronization | daemon supervisor + lazy-subagent/monitor tests | agent messaging/observation | Coalesced with explicit barriers |
| `/usage` | `aim-usage.ts`, interactive/slash commands | `aim status --json` | Exact binding, sanitized bounds |
| Generated models | generator/source inputs + snapshot | explicit AIM provider/model mapping | Generated artifact only |
| Session identity extension | extension runner/event APIs | AIM installed JS extension | Backward-compatible events/context |
| Routine launch | owned worker frontend and launcher/env handling | uncommitted `src/routines/run.js` + tests | Compatibility canary; no source coupling |

### Cross-package search checklist

Before declaring a resolution complete, search the final tree for:

- daemon schema revision/ID/capability literals and min-revision gates;
- `AimCredentialProvider`, external-descriptor narrowing, provider validation, and Codex/Anthropic two-way conditionals;
- `transportAuthIdentity`, `aimCredentialCacheKey`, `previous_response_id`, and credential-generation cache keys;
- every `completeSimple`/summary/refinement call that resolves a model or API key;
- every model catalog refresh and `modelRequestShapeChanged` field;
- every `syncAgentPeers()` await/void call;
- direct and fork-server IPython history initialization;
- every hard-coded provider/model branch in AIM `prime` commands, usage/status, and tests;
- direct edits to `models.generated.ts` (final result must show none outside generator output).

---

## 7. Conflict-resolution specification

### 7.1 `daemon-protocol.ts` and protocol tests — P0

Do not accept ours/theirs. Rebuild the final union from the two behavior sets. Allocate schema revision 17 only after the wire shape is final and regenerate its ID. Retain queue command/capability, stopping state, AIM handoff command/capability, upstream RLM-related messages, compatibility minima, and secret-free validation. Add mixed-version fixtures described in section 10.

### 7.2 `daemon-supervisor.ts` and monitor/process/lazy tests — P0

This file may mostly auto-merge and remains the highest-risk review. Start from upstream lifecycle ownership, then layer fork runtime-identity and AIM forwarding invariants. Explicitly trace:

1. worker hello/auth and missing identity;
2. create/adopt/recover routing;
3. timed stop through background finalization/escalation;
4. root kill and exact cleanup owner;
5. stale registration reclaim;
6. queue/AIM command forwarding capability gates;
7. RLM ledger reconciliation;
8. peer-sync barriers/coalescing.

Retain both sides' tests even where the textual conflict is merely adjacent fixture setup. Adapt fixtures to upstream stop APIs rather than weakening assertions.

### 7.3 `daemon-mode.ts` — P0 semantic auto-merge

Keep upstream `RlmSpawnLedger` append/flush and registry seeding. Keep the root shared `AuthStorage` on explicit child creation and passive hydration. Keep root-tree handoff validation. Ensure ledger durability and auth sharing are orthogonal: topology comes from ledger; credential affinity comes from the root auth object.

### 7.4 `model-registry.ts` — P0/P1

Keep upstream Codex discovery constant/imports and fork AIM admission/retry/auth guidance. Replace the OAuth-only xAI check with authoritative source selection for native or AIM subscription. Ensure normal model enumeration and `completeSimple` both admit credentials and carry the generation identity. Re-run source-precedence and live-rebind tests after regeneration.

### 7.5 `sdk.ts`, `agent-session.ts`, `interactive-mode.ts`, `main.ts` — P0 semantic auto-merges

Audit as one flow:

- SDK creates streams with admitted credentials and typed generation identity;
- AgentSession distinguishes Codex one-shot recovery, Claude terminal exhaustion, upstream queue mutation, and generic retry;
- interactive mode keeps `/usage`, xAI catalog refresh/rebind, upstream resume/queue editing, and credential-recovery messages;
- main creates one root AIM auth session and preserves upstream startup/resume semantics.

No provider condition may use an “else means Claude” or “not Codex means Anthropic” assumption after xAI support.

### 7.6 `packages/ai` provider surfaces — P1

Keep Codex nested failure truth, no internal usage-limit WS retry, and generation-scoped continuation. Keep xAI OAuth, Responses encrypted reasoning, and API-key separation. Keep structured Anthropic failure metadata. If upstream expanded provider option types or request-shape fields, update the shared typed bridge and rebind comparison rather than casting around them.

### 7.7 Changelogs/version — P1

Preserve upstream `0.7.2` sections verbatim and once. Put AIM restoration, xAI subscription/AIM support, Claude fail-fast, worker/kernel reliability integration, and combined daemon schema notes under `[Unreleased]`. Do not imply upstream supplied AIM or kernel fixes.

### 7.8 Generated model catalog — P1

Do not apply the dirty generated-file patch. Compare it to the merged generator's output to identify desired catalog freshness, then either:

- regenerate with the existing merged generator/source of truth; or
- make the smallest generator/source-input change required and regenerate.

The xAI subscription-only Grok 4.6 behavior belongs in the runtime subscription transform even if a future upstream generated catalog also contains 4.6, with “add if absent” preventing duplication.

### 7.9 Kernel and peer WIP — P1

Transplant in two separate commits after the upstream merge is semantically stable:

1. `fix(kernel): disable shared IPython history persistence`
2. `fix(daemon): coalesce peer synchronization safely`

Do not include the unrelated generated catalog, changelog, thinking-level doc, or test-mock changes unless they independently belong to one of these commits and are proven.

---

## 8. Implementation phases

### Phase 0 — Freeze inputs and create the clean integration lane

**Goal:** make every input recoverable without touching the dirty shared checkout or live daemons.

**Steps**

1. Record exact refs, remote URLs, package versions, `git status --short`, worktree list, and the pinned upstream commit.
2. Export the relevant dirty kernel/peer-sync diffs and untracked-file hashes to a dated artifact directory. Do not stash, reset, or stage the shared tree.
3. Record current wrapper targets, launcher paths, source/bundle build IDs, daemon sockets/PIDs, active session IDs, worker states, and attached clients on local, `home`, and Mac Studio. Redact tokens; record only AIM label and safe identity fingerprints.
4. Confirm the known prior bundles and rollback launchers remain byte-addressable. Copy no credential files.
5. Create `integrate/upstream-main-20260815` from `00efe79dc` in a new worktree outside the deployment checkout.
6. Fetch refs without updating the pinned SHA. Verify the worktree is clean and both refs resolve to the reviewed objects.
7. Create a worklog beside this plan for commands, decisions, proof receipts, and deviations.

**Exit gate**

- Clean worktree at exact fork head.
- Dirty WIP preserved outside it by diff/hash.
- Live fleet unchanged.
- Rollback bundle/launcher identities recorded.

**Estimated time:** 45–75 minutes.

### Phase 1 — Merge upstream and compose the base architecture

**Goal:** create the two-parent integration commit with upstream behavior intact and explicit conflict resolutions.

**Steps**

1. Merge `97b994c3d` with `--no-commit` so the whole semantic diff can be inspected before creating the merge commit.
2. Resolve the six textual conflict files using section 7, never file-side selection.
3. Set combined daemon schema revision 17; defer the schema ID final value until the wire union is complete.
4. Preserve upstream worker lifecycle/RLM ledger and fork runtime identity/AIM handoff across all semantic auto-merges.
5. Preserve upstream `OPENAI_CODEX_CLIENT_VERSION = "0.147.0"` and dependency/version changes.
6. Preserve upstream `0.7.2` changelog sections and place fork bullets under `[Unreleased]`.
7. Run cross-package searches from section 6 and inspect every common path plus downstream call sites.
8. Generate the final schema ID through the repository's existing mechanism or update the checked constant from the final serialized wire-shape digest; add an assertion that catches stale IDs.
9. Run type/static checks allowed at this stage; do not paper over errors with broad casts or delete tests.
10. Commit the merge only when both input refs are ancestors and the working diff contains no unresolved marker.

**Files most likely touched**

- Both changelogs
- `packages/coding-agent/src/core/{model-registry,sdk,agent-session,auth-storage,agent-session-runtime}.ts`
- `packages/coding-agent/src/modes/daemon/{daemon-protocol,daemon-mode,daemon-supervisor,daemon-client,rlm-ledger}.ts`
- `packages/coding-agent/src/modes/{interactive-mode,agent-connection/*}.ts`
- corresponding daemon/model/session tests

**Exit gate**

- `git merge-base --is-ancestor 00efe79dc HEAD` and `git merge-base --is-ancestor 97b994c3d HEAD` both succeed.
- Schema 17 contains both capabilities and no copied stale schema ID.
- No release-boundary duplication.
- Upstream recovery/RLM paths and fork AIM paths are visibly present in final call flow.

**Estimated time:** 4–6 hours.

### Phase 2 — Close credential-generation and AIM-managed xAI gaps

**Goal:** make all current AIM provider contracts real end to end, not test-only fragments.

**Prime steps**

1. Define one typed opaque request-admission generation field across coding-agent and AI provider options; map it once at the SDK boundary.
2. Thread it through normal stream and every `completeSimple` path and consume it in Codex transport continuation/cache identity.
3. Add an end-to-end transport-generation test that changes AIM generation while keeping session/account shape otherwise stable and proves no continuation reuse.
4. Extend `AimCredentialProvider` and manual handoff request parsing/validation to `xai`; preserve helper automatic-advance typing as Codex-only.
5. Refactor the xAI subscription-model transform so native OAuth and AIM external xAI use the same Responses catalog and Grok 4.6 injection; leave API-key/env/runtime-key paths generated/unmodified.
6. Ensure catalog refresh and live-session rebind react to switching between AIM xAI, native OAuth, and API key without touching Codex/Anthropic descriptors.
7. Add a direct request-builder regression for `reasoning.encrypted_content` and expand `modelRequestShapeChanged` for any upstream-added shape field.
8. Extend `/usage`, connection snapshots, and daemon handoff fixtures to managed xAI without exposing tokens.

**AIM companion steps**

1. Replace the Codex-vs-Claude rotation branch with an explicit provider map including xAI/Grok.
2. Reuse existing eligibility/identity resolution and private handoff; do not add helper automatic `advance` for xAI.
3. Update CLI help/error text so supported provider behavior is exact.
4. Add `prime-grok` resume/rotate tests proving plain resume pins and explicit rotate changes only the xAI binding.
5. Keep any unrelated dirty routine work unstaged; only the reviewed xAI handoff companion patch enters AIM history.

**Exit gate**

- Managed Grok can resolve, run, persist, resume, and manually rotate.
- Native xAI OAuth and xAI API-key paths still select their distinct rails.
- Codex continuation cache changes on every AIM credential generation.
- Claude/Codex policy remains unchanged.

**Estimated time:** 4–6 hours.

### Phase 3 — Land kernel-history and peer-sync reliability patches

**Goal:** incorporate the relevant local reliability work without weakening upstream recovery ordering.

**Kernel commit**

1. Apply persistent-history disablement to direct kernel bootstrap.
2. Apply equivalent disablement to fork-server-created kernels.
3. Preserve in-memory history and active-execution/last-cell source attribution.
4. Add/repair focused direct, fork, and startup regressions.

**Peer-sync commit**

1. Start from upstream call-site await/void choices.
2. Add a single-flight/coalescing state machine with bounded diagnostics and guaranteed trailing synchronization after a burst.
3. Keep awaited publication barriers for create/adopt/recover/list paths whose return contract depends on peer visibility.
4. Make only non-critical event/broadcast triggers fire-and-forget.
5. Prove a blocked peer does not wedge unrelated control traffic and that a burst cannot publish stale topology after create/recovery returns.

**Exit gate**

- Two separate commits with narrow diffs.
- Direct/fork history tests pass.
- Coalescing and required-order tests pass.
- No unrelated dirty file entered either commit.

**Estimated time:** 3–5 hours.

### Phase 4 — Regenerate, prove, and audit the integrated source

**Goal:** prove the composed contracts at source level before building or touching a host install.

**Steps**

1. Reconcile generator/source inputs, regenerate `packages/ai/src/models.generated.ts` once, and save the command/source revision/output hash in the worklog.
2. Review the generated delta by provider/model rather than line count; confirm no direct hand edit.
3. Run the targeted test matrix in section 10 with explicit authorization required by repository instructions.
4. Run `npm run check`, targeted Biome if needed, and `git diff --check` from the clean worktree's native environment.
5. Run targeted AIM contract tests in its own native environment, with any Redis integration tests isolated under a test prefix/instance.
6. Inspect `git diff` from merge base and from each phase commit. Confirm no token, home-specific auth file, generated build artifact, dirty routine work, or compatibility shim entered Git.
7. Perform one findings-first integration review against the preservation ledger. Repair once and rerun only affected proof plus the final static gate.
8. Record remaining known non-goals accurately: no SSE watchdog, no automatic kernel restart, no automatic Claude/Grok advance.

**Exit gate**

- All blocking rows in the source proof matrix pass.
- Full static check passes.
- Generated catalog is reproducible.
- Review has no P0/P1 finding and no open preservation-ledger row.

**Estimated time:** 4–6 hours.

### Phase 5 — Build one immutable candidate and run isolated canaries

**Goal:** prove the actual installed artifact, not just source.

**Steps**

1. Obtain explicit build/install authorization because repository instructions prohibit broad build commands by default.
2. Build through the repository's documented packaging/install path from a clean, committed candidate worktree. Do not build from the dirty shared checkout.
3. Produce a full file manifest, bundle closure hash/build ID, source commit, Node/npm versions, and launcher hash. Verify repeated packaging from the same source yields the same manifest or explain deterministic exceptions before continuing.
4. Record the exact companion AIM commit and its targeted test receipt. Develop it in a clean AIM worktree from `b8771d37c`; do not reset, switch, or sweep the shared AIM checkout containing scheduled-routine WIP.
5. Install Prime under a new dated candidate directory without repointing the live wrapper. Keep the AIM companion worktree/install candidate separate and immutable.

6. Run with isolated `HOME`, agent/session dirs, daemon socket, and `--no-env`. Exercise help/version, daemon launch/status/stop, new session, resume, queue edit, one RLM spawn/rename/delete/restart reconciliation, direct/fork kernel, and provider-mocked failure paths.

7. Run secret-bearing provider canaries only through installed AIM descriptors/helpers; output a fixed sentinel and safe provider/model/binding metadata, never the token.

8. Verify an old client/new daemon and new client/old daemon reject unsupported commands before write while capability-compatible commands behave as section 4.5 specifies.

9. Retain the candidate directory and manifest as the exact deployment input. No host rebuilds.

**Exit gate**

- Candidate build ID is fixed and isolated canaries pass.
- Source and dist manifests are saved.
- Rollback artifact remains intact.
- No live daemon/session changed.

**Estimated time:** 2–4 hours.

### Phase 6 — Stage on the idle Mac Studio

**Goal:** use the host with zero resident Prime sessions as the first real AIM/Redis/provider integration canary.

**Steps**

1. Re-inventory Mac Studio sessions/processes and stop if it is no longer idle; do not assume the earlier zero-session snapshot remains true.
2. Copy or check out the exact candidate, verify file manifests byte-for-byte, and preserve the old `bundle-v1:6146e71c…` launcher/bundle.
3. Verify AIM wrapper resolution, configured secret-free Codex/Claude/xAI descriptors, Redis connectivity, launcher path, and build identity.
4. Repoint Prime transactionally and start the new daemon. Then install/repoint the exact tested AIM companion commit. This order keeps old AIM behavior compatible during the short transition and does not let new AIM call xAI handoff against old Prime.
5. Run Codex, Claude, and managed Grok fixed-sentinel canaries, including a disposable Grok plain-resume/manual-rotate check.
6. Run one disposable root/subagent tree: persist bindings, restart supervisor, resume, spawn/rename/delete through the RLM ledger, and exercise queue edit.
7. Run controlled worker lifecycle drills on disposable sessions: timed stop finalization, stale-registration reclaim, and root-kill cleanup ownership. Do not use resident production sessions.
8. Soak for 2–4 hours while checking daemon logs for protocol mismatches, unhandled rejections, stuck `stopping`, peer-sync failures, helper leakage, or repeated kernel SQLite errors.
9. Roll back immediately on any P0 session/auth/daemon issue; preserve evidence and do not rotate credentials.

**Exit gate**

- Exact candidate hash active.
- Three provider canaries pass.
- Disposable crash/recovery/RLM/queue path passes.
- Host soak is clean.

**Estimated time:** 4–6 elapsed hours; about 90 minutes active.

### Phase 7 — Coordinated local and `home` cutover

**Goal:** upgrade busy fleets without losing session identity or blindly replaying work.

**Preflight per host**

1. Inventory every root/child, status, worker PID/start identity, attached client, current model, secret-free AIM binding/fingerprint, transcript path/hash/size, cwd, Git branch/status, and daemon/client/build ID.
2. Classify roots as idle, streaming, compacting, running a tool/build/test, or already dead. No cutover begins while a tree is executing or when ownership is ambiguous.
3. Preserve the existing wrapper, launcher, dist, compatibility directory, daemon socket metadata, and candidate rollback command.
4. Verify the candidate manifest byte-for-byte and AIM helper/Redis health.
5. Ask for one explicit exact-host cutover go after presenting the inventory and expected interruption. Do not combine local and `home` approval.

**Transactional cutover per host**

1. Quiesce prompt admission; let already-admitted work finish. Do not replay it.
2. Use the daemon update/restart coordinator and upstream stopping/finalization behavior where compatible. If an old protected supervisor cannot coordinate, reattach/migrate exact idle sessions using the already proven build-scoped procedure; never broad-kill.
3. Repoint the Prime wrapper atomically only after the new supervisor is healthy and exact build identity is visible.
4. Install/repoint the exact tested AIM companion commit without discarding host-local AIM configuration or unrelated scheduled-routine work. On the dirty local AIM checkout, either land the routine owner’s work first or cherry-pick/apply only the companion commit after an overlap check; never reset or replace the checkout with a clean tree that lacks live routine functionality.
5. Resume representative roots **without `--rotate`**. Confirm same session ID, transcript, cwd, branch, root binding, descendants, and no duplicated last prompt/tool call.
6. Verify previously repaired sessions and at least one tree for each managed provider. Exercise a manual rotate only on a disposable idle tree with explicit test intent.
7. Keep the prior supervisor/bundle available through the soak. Do not delete compatibility assets yet.
8. Soak local for at least 4 hours and `home` for at least 12 hours because `home` has the larger resident population.

**Failure rule**

If any session fails identity/transcript/binding verification, stop the cutover, restore the prior wrapper/bundle for that host, leave JSONL/AIM/Redis state untouched, and investigate from the exact failure receipt. Do not compensate by starting a fresh logical session.

**Exit gate**

- All pre-existing sessions remain present/resumable and representative trees resume exactly.
- Candidate build ID is the only build accepting new work.
- No credential changed except a deliberately tested manual handoff.
- Host soak is clean.

**Estimated time:** one day elapsed; 2–4 hours active depending on resident session count.

### Phase 8 — Publish the canonical fork and retire temporary compatibility

**Goal:** make the reviewed integration the durable fork baseline and remove only proven-obsolete transition assets.

**Steps**

1. Update the integration worklog with final commit, test receipts, manifest/build ID, host status, and any deviations.
2. Create a reviewed PR from `integrate/upstream-main-20260815` into the fork's canonical branch. Do not force-push or directly replace shared refs.
3. Verify the PR merge retains both exact input refs as ancestors and all phase commits.
4. Update evergreen provider/daemon/deployment docs with only current behavior; archive or delete point-in-time notes only through a separate docs-cleanup decision.
5. After all old supervisors have naturally exited and no process/wrapper references them, inventory compatibility/pristine directories. Remove obsolete assets only with explicit destructive approval and after the rollback retention window.
6. Keep at least the immediately previous known-good bundle and manifest for seven days.
7. Re-run a short post-merge provider/resume canary from the canonical branch artifact; do not rebuild a different artifact and call it equivalent.

**Exit gate**

- Canonical fork includes pinned upstream and every custom capability.
- All target hosts run the reviewed artifact.
- Compatibility state is documented and no longer required for active sessions.
- Plan/worklog accurately record what shipped and what remains out of scope.

**Estimated time:** 1–2 hours active plus the seven-day rollback retention window.

---

## 9. Proof strategy

### Proof principles

- Run through each project's own environment and normal command interface.
- Use targeted files/cases; never run a live fleet-wide daemon process test.
- Require explicit authorization before repository tests/builds, per repo instructions.
- Mock protocol/error edge cases; use live credentials only for bounded sentinel canaries.
- Prefer state and identity assertions over timing alone.
- A passing compile does not satisfy a behavioral ledger row.
- Every failure repair reruns the smallest affected proof and then the final static gate.

### New or strengthened regressions required by this integration

1. **Schema 17 mixed-version matrix:** old fork, upstream rev-16, and merged worker capability behavior.
2. **AIM + ledger topology:** root handoff sees resident descendants, rejects a subagent target, and a passivated/re-hydrated child rejoins root `AuthStorage` while ledger remains topology authority.
3. **Credential-generation E2E:** coding-agent admission changes the real Codex provider cache/continuation key and forbids prior continuation reuse.
4. **Managed xAI source matrix:** AIM external xAI and native OAuth use Responses/Grok 4.6; API key/env/runtime key use generated rail; Codex/Anthropic models remain unchanged.
5. **Managed Grok manual rotation:** AIM selects a new xAI identity; Prime validates and journals it; plain resume remains pinned; automatic advance is never called.
6. **xAI request replay:** Responses request includes `reasoning.encrypted_content` and rebind detects every request-shaping upstream field.
7. **Peer-sync ordering:** bursts coalesce; blocked non-critical peers do not wedge the control plane; create/recover cannot return before required peer publication.
8. **IPython history:** direct and fork-server kernels disable persistent SQLite history while retaining in-memory cell/source state.
9. **Lifecycle composition:** runtime-identity rejection, timed-stop finalization, stale reclaim, root-kill ownership, and RLM ledger reconciliation pass in one final-tree suite.

---

## 10. Targeted validation matrix

Commands below are examples for the implementation worklog. Resolve exact package-local invocation from the final tree. Do not replace them with broad `npm test`.

### 10.1 Prime coding-agent: AIM/auth/session

Run from `packages/coding-agent` with `npx vitest --run`:

- `test/auth-storage.test.ts`
- `test/aim-request-admission.test.ts`
- `test/aim-usage.test.ts`
- `test/agent-session-runtime-events.test.ts`
- `test/agent-connection-snapshot.test.ts`
- `test/agent-connection-daemon.test.ts`
- `test/daemon-session-summarizer.test.ts`
- `test/interactive-mode-status.test.ts`
- `test/slash-commands.test.ts`
- `test/suite/agent-session-retry-events.test.ts`

**Assertions:** secret-free restart affinity; all side-door admissions; append/flush/publish ordering; exact `/usage`; Codex one-shot policy; Claude terminal policy; managed xAI binding exposure.

### 10.2 Prime coding-agent: daemon wire/lifecycle/RLM

- `test/daemon-protocol.test.ts`
- `test/daemon-client.test.ts`
- `test/daemon-command.test.ts`
- `test/public-command.test.ts`
- `test/daemon-runtime-identity.test.ts`
- `test/daemon-launch.test.ts`
- `test/daemon-ps.test.ts`
- focused cases in `test/daemon-supervisor-monitor.test.ts`
- focused cases in `test/daemon-supervisor-process.test.ts`
- `test/daemon-supervisor-lazy-subagents.test.ts`
- focused cases in `test/daemon-mode.test.ts`
- `test/rlm-ledger.test.ts`
- `test/acp-rlm-subagents.test.ts`
- `test/4602-snapshot-transfer-idempotency.test.ts`

**Assertions:** schema/capability matrix; no write before compatibility check; build identity; truthful stopping/recovering; background finalization; reclaim; root cleanup; ledger durability; shared AIM auth on child hydration; safe reap/idempotent snapshots.

### 10.3 Prime coding-agent: model/provider integration

- `test/model-registry.test.ts`
- `test/678-agent-session-model-rebind.test.ts`
- `test/xai-aim-noninterference.test.ts`
- `test/agent-session-runtime-model-fallback.test.ts`
- any upstream Codex model-discovery regression tied to client version `0.147.0`

**Assertions:** source precedence, Grok 4.6 subscription visibility, API-key separation, request-shape rebind, Codex discovery, no cross-provider reshaping.

### 10.4 Prime coding-agent: kernel/peer sync

- `test/ipython-bootstrap.test.ts`
- `test/kernel-startup.test.ts`
- `test/kernel-fork-server.test.ts`
- `test/kernel-bootstrap.test.ts`
- `test/acp-kernel-features.test.ts` focused RLM/kernel cases
- upstream host-request contract regression in its final path
- new peer-sync coalescing and publication-order cases in monitor/lazy-subagent suites

**Assertions:** no persistent SQLite history in either path; in-memory source retained; host-request/RLM comm intact; coalescing does not weaken ordering.

### 10.5 Prime AI package

Run from `packages/ai` with `npx vitest --run`:

- `test/openai-codex-stream.test.ts`
- `test/openai-codex-cache-affinity-e2e.test.ts`
- `test/openai-responses-cache-affinity-e2e.test.ts`
- `test/stream-failure.test.ts`
- `test/xai-oauth.test.ts`
- `test/openai-responses-reasoning-replay-e2e.test.ts`
- new xAI encrypted-reasoning/request-rail regression if not covered by the preceding file

**Assertions:** nested provider truth; no usage-limit WS retry; generation cache isolation; structured Anthropic metadata; OAuth correctness; xAI reasoning replay.

### 10.6 AIM contract repository

Run targeted files with `node --test` from `/Users/aelaguiz/workspace/aimgr`:

- `test/pi/prime-target.test.js`
- `test/pi/prime-grok-use.test.js`
- `test/pi/session-identity-extension.test.js`
- `test/cli/credential-helper.test.js`
- `test/credentials/harness-access.test.js`
- `test/targets/harness-auth.test.js`
- `test/coordination/redis-credential-lease.test.js`
- `test/coordination/redis-store.test.js`
- `test/coordination/xai-attach.test.js`
- `test/status/xai-redis-view.test.js`
- `test/routines/routine-run.test.js` as a compatibility consumer, even if its source remains uncommitted/unrelated

Also run `npm run lint`. Redis-backed tests must use isolated test keys and must not mutate live `aimgr:v1:` records.

### 10.7 Final static/source gate

From the clean Prime worktree:

```bash
npm run check
git diff --check
git status --short
git merge-base --is-ancestor 00efe79dc4484160cc5bd61cf69609936fe6bd39 HEAD
git merge-base --is-ancestor 97b994c3d7c45ca1ae635190e91e9e58ddf2577c HEAD
```

Because `npm run check` includes a formatter with `--write`, inspect and commit only expected formatting changes, then rerun until clean. Save command, exit status, duration, and final commit in the worklog.

### 10.8 Isolated/live acceptance canaries

| Canary | Required result |
|---|---|
| Managed Codex new root | sentinel response; exact AIM label; no secret output |
| Managed Claude new root | sentinel response; exact AIM label |
| Managed Grok new root | sentinel response on subscription Responses rail; Grok 4.6 visible |
| Native xAI OAuth/API key | each remains on its intended rail when AIM xAI is disabled |
| Plain resume | exact root/session/transcript/binding; no rotation |
| Manual rotate | idle disposable Codex/Claude/Grok root retains tree/history and changes only binding |
| Exhausted Claude | structured terminal `usage_limit` in under 5 seconds when a controlled exhausted account is available; otherwise mocked source proof remains blocking |
| Generic 429 | ordinary retry path preserved |
| Worker stop/reclaim | no permanent stopped/stopping registration; exact session resumes |
| Supervisor restart + RLM | spawn/rename/delete intent reconciles; sibling/name state correct |
| Queue edit/resume | upstream mutation/preservation works with AIM-bound session |
| Kernel direct/fork | no shared `history.sqlite` creation/lock; source attribution works |
| Mixed build | unsupported attachment/command fails before write; live worker is not killed |

Do not use a resident user session for destructive lifecycle canaries. Never interpret silence as quota exhaustion; require the structured provider signature.

---

## 11. Deployment proof and rollback

### 11.1 Per-host deployment receipt

Record this table before and after each cutover:

| Field | Before | Candidate/after |
|---|---|---|
| Host / user | | |
| Source path / commit | | |
| Wrapper resolved path/hash | | |
| Launcher path/hash | | |
| App version | | |
| Runtime source ID | | |
| Bundle build ID | | |
| Daemon PID/start ID/socket | | |
| Root/child/attached counts | | |
| Representative session IDs | | |
| Provider/model/safe binding labels | | |
| Dist manifest hash | | |
| Canary results | | |
| Rollback command/artifact | | |

No receipt may contain an access token, refresh token, API key, Redis credential record, or raw auth file.

### 11.2 Transaction boundaries

A host cutover has three checkpoints:

1. **Prepared:** candidate and rollback artifacts verified; wrapper unchanged; old daemon authoritative.
2. **Activated:** new wrapper/supervisor healthy; representative exact resumes pass; rollback still retained.
3. **Committed:** host soak passes and new build accepts new work; old compatibility no longer receives clients but remains retained.

Never delete the prior artifact in the same transaction that activates the candidate.

### 11.3 Rollback procedure

1. Stop new prompt admission. Let admitted calls finish or explicitly abort only with operator authorization.
2. Capture new daemon/worker state and failure evidence.
3. Restore the prior wrapper/launcher atomically and start/attach through the prior exact client/bundle.
4. Leave session JSONL, RLM ledger, AIM descriptors, AIM bindings, Redis state, cwd files, and branches untouched.
5. Resume exact representative roots without `--rotate`; verify transcript tail and no duplicate prompt/tool call.
6. If prior code cannot understand a new optional RLM ledger artifact, leave it in place and allow prior code to ignore it; never “downgrade” or delete session data blindly.
7. Mark the candidate build blocked, repair in the clean worktree, and repeat isolated/Mac Studio stages before another busy-host attempt.

### 11.4 Immediate rollback triggers

- Any missing/truncated/duplicated session transcript or replayed mutation.
- Binding/fingerprint drift on plain resume.
- Token or secret appears in JSONL, logs, diagnostics, process arguments, or proof artifact.
- Live worker killed/relaunched after identity rejection.
- Session permanently stuck in stopping/recovering or stale registration not reclaimable.
- RLM topology/name differs after supervisor restart.
- Managed provider selects the wrong request rail or reuses prior-account continuation.
- Generic 429 becomes terminal, or Anthropic unified exhaustion sleeps/retries.
- Repeated IPython SQLite locking or peer-sync control-plane wedge under the acceptance drill.

---

## 12. Risk register

| Risk | Likelihood | Impact | Prevention / proof |
|---|---|---|---|
| Clean auto-merge drops a distributed AIM invariant | High | Critical | Call-site audit, preservation ledger, E2E admission/handoff tests |
| Schema collision accepts an incompatible peer | Medium | Critical | Revision 17, unique schema ID, capability minima, mixed-version tests |
| Supervisor composition kills/relaunches live worker | Medium | Critical | Identity/lifecycle combined tests; disposable lifecycle drill first |
| Managed xAI and native OAuth create split catalog truth | High | High | One subscription transform; source matrix; live rebind tests |
| Codex prior-account continuation leaks across generation | Medium | High | One typed generation bridge and E2E cache-affinity test |
| Anthropic terminal exhaustion regresses into multi-day SDK wait | Medium | High | AIM-only `maxRetries:0` tests + controlled under-5-second canary |
| Peer-sync patch weakens required ordering | High if raw-applied | High | Preserve upstream awaits; coalescing + publication-order regression |
| Dirty generated catalog contaminates merge | High | Medium | Clean worktree, generator-only regeneration, provenance review |
| New `0.7.2` client collides with old custom `0.7.2` | Medium | High | Protocol + schema ID + app-version admission and command capability gates; build/launcher identity in diagnostics |
| Busy-host install strands sessions | Medium | Critical | Per-host inventory/go; update coordinator; exact resume; retained rollback |
| AIM routine/extension consumer breaks silently | Medium | Medium | Targeted AIM extension/routine compatibility tests and Mac Studio canary |
| Redis outage is mistaken for provider exhaustion | Low | High | Prime never queries Redis; helper bounded/fail-closed; structured signatures |
| Merge is credited with fixing all kernel hangs | Medium | Medium | Scope language and explicit non-goals; separate history/peer commits |
| Future upstream fetch changes target midstream | Medium | Medium | Pinned SHA; amendment required for ref update |

---

## 13. Decision log

| Decision | Chosen | Rejected / why |
|---|---|---|
| Integration history | Two-parent merge of pinned upstream into reviewed fork head | Rebase/cherry-pick replay loses immutable fork ancestry and future merge-base clarity |
| Workspace | New clean worktree | Dirty checkout, stash/pop, or deployment tree risk unrelated loss/contamination |
| Upstream ref | Pin `97b994c3d` | Moving `upstream/main` makes proof non-repeatable |
| Fork source | `00efe79dc` three-commit lineage | Divergent older `origin/main` can reintroduce obsolete broker/xAI behavior |
| Daemon schema | Compose into rev 17 with both caps | Choosing fork rev 15 or upstream rev 16 deletes behavior |
| Compatibility | Protocol + schema ID + app version, with per-command capability/minimum-revision gates; build identity is diagnostic | Version-only checks are ambiguous; exact build matching needlessly replaces wire-compatible live daemons |
| xAI AIM gap | Close end to end, including manual rotate | Partial Prime allowlist or misleading AIM help leaves a broken contract |
| xAI catalog | One subscription transform for native/AIM | Duplicate model table or generated-file hand patch will drift |
| Automatic failover | Codex-only existing one shot | Claude/Grok auto-rotation is unproven scope expansion |
| Anthropic retry | Zero SDK retries only after AIM admission | Global retry disable changes unmanaged semantics |
| Codex cache scope | One typed generation field | Ad-hoc metadata/options halves leave an untested side door |
| Supervisor recovery | Upstream lifecycle/ledger as base authority, compose fork identity/AIM | Reimplementing upstream stack adds risk and code |
| Peer sync | Coalesce while retaining required awaits | Blanket fire-and-forget can return before topology publication |
| Kernel fix | Disable persistent history in direct + fork paths | Watchdog/restart framework is unnecessary for the proven SQLite vector |
| Models | Regenerate from merged generator/source | Direct edits violate repo policy and cannot be reproduced |
| Deployment | One immutable artifact, idle host first, then per-host coordinated cutover | Host rebuilds and broad daemon restart cannot prove identity/session safety |
| Credentials | Preserve identities; rotate only explicit disposable canary | Proactive rotation is unrelated and disruptive |
| Release | Stay upstream `0.7.2` + custom build ID, Unreleased fork notes | Minting/tagging `0.7.3` is separate release work |

---

## 14. Definition of done

The upgrade is complete only when all of the following are true:

- [ ] Final canonical fork history contains exact fork head `00efe79dc` and pinned upstream `97b994c3d` as ancestors.
- [ ] All preservation-ledger rows are checked with a named receipt.
- [ ] Schema revision 17 and its generated ID represent queue, stopping, AIM, and RLM surfaces together.
- [ ] Credential-generation identity reaches Codex transport end to end.
- [ ] AIM-managed Grok works through new, run, persisted resume, and explicit manual rotate while native xAI/API-key paths remain correct.
- [ ] Codex one-shot recovery and Claude terminal exhaustion retain their distinct policies.
- [ ] Upstream worker recovery/RLM ledger and fork build/session safety pass together.
- [ ] Direct/fork IPython history and peer-sync patches are committed separately and pass focused regressions.
- [ ] Generated models have deterministic generator provenance and no direct edit.
- [ ] Targeted Prime and AIM suites plus `npm run check` and `git diff --check` pass on final commit.
- [ ] One immutable bundle passes isolated and Mac Studio canaries, then local and `home` exact-session cutovers.
- [ ] Pre-existing sessions, branches, worktree files, transcripts, subagents, bindings, and attached-client expectations remain intact; no interrupted work was replayed.
- [ ] No credentials were exposed or proactively rotated.
- [ ] Previous bundles remain available through the retention window; transitional compatibility is retired only after no live reference remains.
- [ ] Worklog, changelogs, provider docs, daemon compatibility docs, and host receipts describe the final truth without claiming out-of-scope fixes.

---

## 15. Handoff notes for the implementer

Start with **Phase 0 only**. Do not begin the merge from the current shared checkout. The first two artifacts to produce are:

1. a non-secret fleet/build/session inventory; and
2. an exact preserved patch/hash bundle for the relevant kernel/peer WIP.

Then create the clean branch/worktree at `00efe79dc`, verify pinned `97b994c3d`, and open the worklog. If either ref or the dirty-file ownership differs from this plan, stop and amend the evidence table before editing.

The highest-value review question throughout implementation is:

> Can the final code prove the same root session, credential generation, worker identity, and durable topology on both sides of failure or handoff—without another subsystem silently choosing a different owner?
