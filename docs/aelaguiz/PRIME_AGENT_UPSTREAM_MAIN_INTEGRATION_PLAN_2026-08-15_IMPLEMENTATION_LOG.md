# Prime Agent upstream-main integration implementation log

Plan: `docs/aelaguiz/PRIME_AGENT_UPSTREAM_MAIN_INTEGRATION_PLAN_2026-08-15.md`  
Audit log: `docs/aelaguiz/PRIME_AGENT_UPSTREAM_MAIN_INTEGRATION_PLAN_2026-08-15_PLAN_AUDIT.md`  
Active scope: Plan phases 0–4: isolated source integration, companion AIM source patch, targeted proof, and final static check.  
Stop boundary: Do not push, merge to the canonical fork, repoint a wrapper, build/install a deploy bundle, contact a live daemon, rotate a credential, or run a host cutover.  
Scope contract: Plan sections 1, 4, 5, 7, and 8; user authorization on 2026-08-15 to implement in a separate worktree.  
Scope status: Frozen.  
Current checkpoint: source integration approved by final audit at `16d292e23`; pinned upstream merge is `3df1906eb` with parents `00efe79dc` and `97b994c3d`.

## Resume Snapshot

- Current state: Prime source integration and AIM companion source are complete; final independent repair verification is PASS and targeted proof is green.
- Next useful move: present the source-only branches and receipts for user review; do not push/install/cut over without explicit approval.
- Do not redo unless stale: immutable-input capture, merge/conflict resolution, managed-provider bridge, RLM durability repair, kernel/peer reliability commits, model-generator inspection, and targeted test matrix.
- Known blockers: None in source. Push/canonical merge/deploy build/install/live cutover remain deliberately blocked by the user review gate.
- Native children: AIM companion worker completed `0f340e7`; final integration auditor returned PASS at Prime `16d292e23`.
- Repository state before this ledger update: Prime and AIM companion worktrees clean; original dirty Prime/AIM checkouts untouched.

## Scope Ledger

| Item | Plan anchor | Disposition | Status | Code anchor | Proof | Review |
|---|---|---|---|---|---|---|
| Preserve immutable inputs and isolate work | Phase 0 | authorized | complete | worktree + preflight artifact | refs/hash receipt | self-checked |
| Merge pinned upstream with fork | Phase 1 | authorized | complete | `3df1906eb` | exact two-parent ancestry + checks | self-checked |
| Compose daemon schema/lifecycle/RLM/AIM | §§4.5–4.6, 7 | authorized | complete | `11dde8c4a`, `8f6c93a2d`, `bcf6bc716` | protocol/mixed-worker/RLM/daemon matrix | independent PASS |
| Close credential-generation bridge | §4.4, Phase 2 | frozen-convergence-required | complete | `11dde8c4a`, `321b28861` | real coding-agent→Codex same-account handoff isolation | independent PASS |
| Close AIM-managed xAI contract | §§4.2–4.3, Phase 2 | frozen-convergence-required | complete | Prime `11dde8c4a`; AIM `0f340e7` | source matrix + 34 AIM tests | independent PASS |
| Land kernel history fix | §4.7, Phase 3 | authorized | complete | `f1e201877` | direct/fork launch tests | self-checked |
| Land safe peer-sync coalescing | §4.7, Phase 3 | authorized | complete | `5c85ee9a3` | burst coalescing + supervisor matrix | independent PASS |
| Source proof and final check | Phase 4, §10 | authorized | complete | HEAD + receipts below | 571 targeted tests across Prime/AIM + repeated `npm run check` | independent PASS |
| Build/push/install/cutover | Phases 5–8 | out-of-scope for this pass | blocked by user stop boundary | — | — | — |

## Code Read Ledger

| Area | Files/symbols read | Why relevant | Fresh until | Notes |
|---|---|---|---|---|
| Fork contracts | three fork commits and preservation ledger | exact custom behavior | fork/source changes | mapped by source review |
| Upstream recovery | daemon supervisor/mode/protocol/RLM ledger commits | merge authority | upstream pin changes | pinned SHA |
| AIM consumer | `aimgr` CLI/helper/target/session sources | external compatibility | AIM source changes | dirty checkout read-only |
| Reliability WIP | kernel/fork-server/supervisor + tests | authorized local fixes | original WIP changes | binary patch SHA recorded |

## Proof Freshness Ledger

| Proof | Scope | Result | Fresh until | Rerun trigger |
|---|---|---|---|---|
| Merge ancestry | `3df1906eb` | parents exactly `00efe79dc` + `97b994c3d` | history edit | immutable |
| Static gate | Prime HEAD through `16d292e23` | `npm run check` passed repeatedly; installer/browser checks included | source edit | rerun after ledger commit |
| Coding-agent target matrix | Prime `16d292e23` | 13 files, 494/494 passed | affected source/test edit | current |
| AI provider matrix | Prime HEAD | Codex/xAI/Anthropic: 43/43 passed | AI source/test edit | current |
| AIM companion matrix | AIM `0f340e7` | 34/34 passed; clean worktree | AIM source/test edit | current |
| Model generator inspection | Prime `2aaf51363` input | live output 1,222 vs 1,163 models, SHA-256 `1b10ea7dcdff7b4437dcb013bcac567663008a10e2f9c2bd55b789de64439300`; 15 providers changed | generator/source change | inspected and reverted as unrelated live-catalog churn |
| `git diff --check` | Prime/AIM | passed | source/doc edit | rerun after ledger commit |

## Continuous Review Ledger

| Finding | Source | Disposition | Status | Repair anchor | Notes |
|---|---|---|---|---|---|
| IMP-001 transport admission/cache identity split | source mapping | frozen-convergence-required | closed | Prime `11dde8c4a`, `321b28861` | typed process-local field survives simple-option normalization; same-session/same-account two-generation Codex proof |
| IMP-002 AIM xAI provider/handoff asymmetry | Prime↔AIM mapping | frozen-convergence-required | closed | Prime `11dde8c4a`; AIM `0f340e7` | xAI manual handoff; automatic advance remains Codex-only |
| IMP-003 dirty peer-sync patch may weaken upstream barriers | merge review | authorized | closed | `5c85ee9a3` | dirty-bit coalescing preserves all awaited/fire-and-forget caller semantics |
| IMP-004 mixed-version worker admission | integration auditor | required | closed | `11dde8c4a` | target worker hello checked before transport write; rev-15/rev-16/rev-17 matrix |
| IMP-005 RLM ledger writes failed open | integration auditor | required | closed | `8f6c93a2d`, `bcf6bc716`, `16d292e23` | exact append promises awaited; spawn/rename rollback; delete-first authority; routed saved-catalog side doors closed |

## Side Doors and Deletes

| Surface | Expected state | Current state | Status | Anchor |
|---|---|---|---|---|
| Direct/fork IPython history | both disabled | implemented and tested | complete | `f1e201877` |
| Codex generation key | one typed path | process-local `transportAuthIdentity` | complete | `11dde8c4a` |
| xAI subscription transform | native + AIM share owner | shared subscription transform; API-key rail unchanged | complete | `11dde8c4a` |
| Old schema sides | one rev-17 union | schema 17 with AIM handoff + queue mutation and per-worker gates | complete | `11dde8c4a` |

## Pass Notes

### 2026-08-15 — isolated intake

- Intent: establish a clean source-only implementation lane.
- Changed: created integration worktree/branch; copied canonical plan; created logs.
- Read: current Prime/AIM status, worktree list, exact refs, relevant dirty WIP.
- Proof: ref objects exist; WIP binary patch and hashes saved; original checkouts unchanged.
- Review: stop boundary explicitly excludes push/build/install/live-host work.
- Next: semantic upstream merge.

### 2026-08-15 — pinned merge and semantic integration

- Merged pinned upstream as `3df1906eb` with exact fork/upstream parents; retained upstream `0.7.2`, fork AIM/xAI/Claude behavior, protocol revision 17, and upstream recovery/RLM surfaces.
- Closed managed-provider gaps in `11dde8c4a`: typed Codex transport identity, mixed-worker compatibility admission, AIM-managed xAI subscription shaping, and xAI daemon handoff. `321b28861` closes the final simple-option normalization side door.
- Added AIM companion commit `0f340e7` in `/Users/aelaguiz/workspace/aimgr-xai-handoff-20260815`; no push or install occurred.

### 2026-08-15 — auditor blocker repairs

- `8f6c93a2d` + `bcf6bc716`: RLM topology writes now fail closed. Persisted spawn waits for the exact ledger promise, rename rolls back on ledger failure, delete makes the ledger tombstone authoritative before metadata teardown, and ephemeral in-memory roots retain their non-durable behavior.
- Final audit found the active-context saved-catalog route bypassed those worker guarantees; `16d292e23` closes both routed rename/delete side doors and adds failure-injection regressions through commands carrying `activeSessionId`.
- `5c85ee9a3`: peer synchronization uses one active pass plus a dirty follow-up instead of serializing every burst; existing callers retain their own awaited or fire-and-forget semantics.
- `f1e201877`: direct and forked IPython kernels disable shared history persistence; both launch paths have focused tests.
- `45de43503`, `a3c715972`, `47f5643a6`: repaired merge-era fixtures and strengthened pre-write worker compatibility proof.

### 2026-08-15 — source proof and generator decision

- Built package outputs only inside the clean committed integration worktree to make internal workspace exports testable; no release pack, wrapper repoint, install, daemon contact, or live cutover occurred.
- The build's live generator produced 1,222 models versus 1,163 at HEAD across 15 providers (SHA-256 `1b10ea7dcdff7b4437dcb013bcac567663008a10e2f9c2bd55b789de64439300`). This broad catalog churn was unrelated to the pinned integration, so `models.generated.ts` was restored; xAI Grok 4.6 remains owned by the add-if-absent subscription transform.
- Final targeted proof before ledger update: coding-agent 494/494 at `16d292e23`, AI provider 43/43 (plus the 6-test coding-agent admission suite rerun after `321b28861`), and AIM companion 34/34. Repeated `npm run check` passed, including installer and browser smoke checks.
- Final independent verdict: PASS with no remaining blocker after bounded verification of `16d292e23`.
- Original dirty Prime/AIM checkouts and live sessions remain untouched. No source branch was pushed.


### 2026-08-15 — approved live Codex canary

- AIM reported the existing managed `openai-codex` binding `qa` installed and ready; no credential rebinding or rotation was performed.
- The first ordinary worktree CLI attempt contacted the protected local supervisor, received the expected mixed-build refusal with seven busy sessions, and made no mutation; no supervisor or session was stopped.
- Retried through an isolated owned-worker process from this worktree with `--print --no-session --offline`, `openai-codex/gpt-5.6-sol`, low reasoning, and all tools/resources disabled. The real provider returned exactly `PRIME_CODEX_CANARY_OK`.
- The temporary working directory was removed. No Prime session was saved, no install/release bundle was produced, and both integration branches remained unpushed.
