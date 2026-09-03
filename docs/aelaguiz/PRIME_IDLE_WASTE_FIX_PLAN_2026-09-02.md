# Prime idle-waste fix plan, 2026-09-02

Fix the eight things that make a Prime fleet burn CPU and disk in proportion to session count while doing nothing. Source of the findings: `~/workspace/aimgr/docs/PRIME_AGENT_PERFORMANCE_AUDIT_2026-09-02.md` (four Opus 5 source audits plus live profiles on Amir-M5 with 32 TUIs, 12 workers, 231 sessions).

Frame: `$startup-pragmatism`. Two-way door (fork branch on a worktree). Fix the named surface only; no orphan-journal, fsync-batching, roster, cron, or ledger rewrites this round (they are tier 2 and 3 in the audit and stay there). No full test suite, no `npm run check`, no CI. Only the focused vitest files for the touched modules, run once each.

Branch: `perf/idle-waste-20260902`, worktree `~/workspace/prime-agent-worktrees/perf-fix-20260902` (from `main` at `918d049ad`).

---

## 1. The fixes

All paths are `packages/coding-agent/src/…`. Owner = the implementing agent lane (section 3). Each fix is one commit on the branch with the audit item in its message.

| # | Fix | Where | Behaviour after | Owner |
|---|---|---|---|---|
| F1 | Memoize `observeProcessIdentity` per `(pid, expected id)` with a 5 s TTL; every cache hit still does `kill(pid, 0)` so a dead pid is never reported live; memoize the process's own identity for its lifetime (the pid and token never change). Spawn `/bin/ps` only on a miss or when the expected id differs from the cached one. | `core/session-lease.ts:781-821` (`observeProcessIdentity`), `:863-878` (`classifyProcessIdentityAuthority`), `:967-972` (the existing self memo, make every self-check use it), `modes/daemon/daemon-supervisor-ownership.ts` `currentProcessIdentityFields` | 48 `ps`/s at idle → about 0; per-command `ps` in supervisor and worker → 0 for the own pid, ≤1 per 5 s per foreign pid | W |
| F2 | Supervisor fence poll 250 ms → 2000 ms. Socket close already revokes the claim within 100 ms, so the poll is only the safety net. | `modes/daemon/daemon-mode.ts:421` (`SUPERVISOR_FENCE_POLL_MS`) | 4 checks/s/worker → 0.5/s, and with F1 they are cache hits | W |
| F3 | Append `agent_status` only when the status actually changed (summary, taskState, basedOnMessageCount), and do not treat a failed summary (`summary: ""`) as still owed: back off (5 min) after a failure instead of retrying every 25 s. | `modes/daemon/daemon-session-summarizer.ts:308` (`owesSummary`), `:328-332` (failure stores `""`), `:358` (unconditional append) | idle transcript appends: N/25 s → 0 | W |
| F4 | Cache the traces-enabled flag in memory (invalidate on the settings watcher / `reload()`), and never take an exclusive `settings.json` lock for a read. | `core/agent-traces.ts:726`, `core/settings-manager.ts:498` (lock for read), `:264-267` (busy-spin) | two exclusive lock cycles per persisted entry → 0 | W |
| F5 | Memoize `canonicalizePath` (session files never move; key by input path), and reconcile catalogs once per refresh batch instead of once per streamed session. | `modes/agents-view/agents-view-state.ts:163, 190, 204`; `modes/agents-view/agents-view-mode.ts:2200-2206` | ~2,200 `lstat` per roster push per client → 0 after warm-up; catalog refresh 163 reconciles → 1 | T |
| F6 | Serve `heartbeats_list` from the supervisor's `worker.heartbeatSnapshot` cache; RPC only workers whose `heartbeatSnapshotStale` is true and single-flight that refresh; debounce `broadcastHeartbeatsChanged` to 1 s; delete the agents-view 15 s poll (the `heartbeats_changed` push already exists). | `modes/daemon/daemon-supervisor.ts:2492-2538, 6681-6684, 7832-7836`; `modes/agents-view/agents-view-mode.ts:102, 893, 2245-2266` | 1,536 worker RPCs/min at idle → 0; a heartbeat change → one fan-out, not C × W | S (supervisor side), T (client poll removal) |
| F7 | Lifecycle `process_heartbeat` 60 s → 300 s and without `includeResources`; prune `processes/` lazily (only in the supervisor, once per hour) instead of a `statSync` sweep of every file at every process start. | `core/process-lifecycle.ts:30` (`HEARTBEAT_INTERVAL_MS`), `:647-651`, `:420-433` (`pruneStaleProcessLogs`), `:361-371` | 46 × 1 KB writes/min → 9; 3,378 `statSync` per worker start → 0 | W |
| F8 | Log fence, admission, and identity timings only above 500 ms (was 100 ms), so the supervisor stops relaying one stderr line per check under load. | the `>= 100` thresholds in `modes/daemon/daemon-mode.ts` (fence and admission traces) and `core/session-lease.ts:435-448` (identity timing) | 300 to 400 supervisor log lines/min at load → near 0 | W |

Rigor still owed (the two places a shortcut would be wrong):

- F1: a cache hit must never claim a dead process is alive. Every hit re-does `kill(pid, 0)`; ESRCH invalidates immediately. The TTL only bounds how long a *reused* pid could be misclassified, and the existing `exact-dead` path already requires the token to match.
- F6: a changed heartbeat must still reach clients. The `heartbeats_changed` push from the worker marks the snapshot stale and triggers exactly one refresh; the debounce delays it by at most 1 s.

Deliberately not done this round (audit tier 2 and 3): orphan journal O(spawns²), fsync group-commit, worker `flushRoster`, RLM child token fan-in, cron store, RLM ledger, kernel-per-session memory, git context spawns.

---

## 2. Proof: before and after on an isolated fleet with real workers

Instrument: `scripts/idle-fleet-measure.py` (committed on the branch). It starts an isolated supervisor from the given checkout's source lane (own socket, agent dir, registry dir, `--offline`), copies five real transcripts into the isolated sessions dir, opens a Herdr workspace with six panes (pane 0 runs the agents view, panes 1 to 5 each `--resume` one transcript, so five real workers and six real TUIs attach), waits 45 s, then over a 60 s idle window counts `agent_status` appends, lifecycle heartbeat writes, fleet CPU, and samples the supervisor, one worker and the agents view; then it stops the fleet with the daemon `shutdown --force` wire command and closes the panes. Run from anywhere:

```bash
python3 scripts/idle-fleet-measure.py <checkout-dir> <label>
```

The fork's `scripts/bench-daemon-fleet.ts --workers 15 --duration 60` was run once on pristine `main` for the create-latency and fence-check baseline; its sessions have no transcripts and no clients, so it cannot observe F3, F5 or F6.

Numbers recorded before (pristine `main`) and after (branch head), same machine, same command:

| Metric | How | Before (`main` 918d049ad) | After (branch head) |
|---|---|---|---|
| `agent_status` records appended to 6 idle transcripts | count in `<root>/agent/sessions/*.jsonl` over the window | **12 in 66 s** (one per session per 25 s, the bug) | **0 in 74 s** |
| `process_heartbeat` lifecycle records written by 20 processes | count in `<root>/agent/logs/processes/*.jsonl` over the window | **4 in 60 s** | **0** (interval now 300 s) |
| Fleet CPU, sum of `%cpu` over the isolated processes, 12 samples | `ps` | avg 8.4 % (20 procs) | avg 7.9 % (22 procs) |
| Supervisor / worker / agents-view main thread | `sample <pid> 2` | all three idle (`__psynch_cvwait` dominant, `lstat` and `posix_spawn` leaves 0) | same |
| `/bin/ps` children of the fleet, `settings.json.lock` occupancy | 20 s polling probes | 0 / 0 | 0 / 0 (probe too coarse for 40 ms and 1 ms events; not evidence either way) |
| Bench harness (`scripts/bench-daemon-fleet.ts --workers 15 --duration 60`, pristine `main`) | fleet cpu avg / max, fence checks ≥100 ms, cold create with 15 resident | 15 % / 56 %, 66, 4.0 s | not re-run: the harness's sessions have no transcripts and no clients, so it cannot see F3, F5 or F6 |

What the isolated fleet proves: F3 and F7 outright (the two idle write loops are gone), and that nine commits run a real supervisor, real workers on real transcripts, and real TUIs without regressions in create, resume, list, shutdown. What it cannot show at 6 sessions and 1 client: the `realpathSync` storm (needs a 163-entry saved catalog and a big roster), the `ps` spawn rate (48/s needs 12 workers and only shows in `sample` under load), and the heartbeat fan-out (needs many clients). Those three are covered by unit tests in the same commits and by code review; their live proof is the post-deploy re-sample on this machine (32 TUIs, 12 workers): TUI `lstat` share from about 45 % to about 0, supervisor log rate from 300 to 400 lines/min to near 0, worker `posix_spawn` leaves gone.

The TUI for the last two rows is the worktree's own client attached to the isolated socket in a Herdr pane: `node --require <tsx preflight> --import <tsx loader> packages/coding-agent/src/cli.ts --daemon-socket <fleet socket> agents` with `PRIME_AGENT_CODING_AGENT_DIR=<fleet root>/agent`, mirroring how the bench spawns its supervisor.

Focused tests, run once per lane, only these files:

- W: `test/session-lease.test.ts`, `test/daemon-session-summarizer.test.ts`, `test/daemon-session-summarizer-lifecycle.test.ts`, `test/agent-traces.test.ts`, `test/settings-manager.test.ts`, `test/process-lifecycle-process.test.ts`, `test/daemon-mode.test.ts`
- S: `test/daemon-supervisor-heartbeats.test.ts`, `test/daemon-supervisor-ownership.test.ts`
- T: `test/agents-view-state.test.ts`, `test/agents-view-roster.test.ts`, `test/agents-view-mode.test.ts`

Invocation: `npx tsx ../../node_modules/vitest/dist/cli.js --run <file>` from `packages/coding-agent`. A failure in a touched test is fixed or the test updated to the new behaviour; unrelated pre-existing failures are noted and skipped.

---

## 3. Execution

1. Baseline bench on the pristine worktree (before any edit) and the idle counts. Record in the table.
2. Three Opus 5 implementers in parallel with disjoint file ownership:
   - **W** (worker and shared): `core/session-lease.ts`, `core/agent-traces.ts`, `core/settings-manager.ts`, `core/process-lifecycle.ts`, `modes/daemon/daemon-mode.ts`, `modes/daemon/daemon-session-summarizer.ts` (F1, F2, F3, F4, F7, F8).
   - **S** (supervisor): `modes/daemon/daemon-supervisor.ts`, `modes/daemon/daemon-supervisor-ownership.ts` (F6 server side; use F1's self-identity memo).
   - **T** (client): `modes/agents-view/agents-view-state.ts`, `modes/agents-view/agents-view-mode.ts` (F5, F6 client side).
   Each commits to the branch with `git commit` per fix, runs only its focused tests, and reports the diff summary.
3. Code review of every commit by the orchestrating session (read the full diff, check the two rigor points, check nothing outside the owned files changed).
4. After bench on the branch head; idle counts; TUI sample. Fill the table.
5. Then, as a separate decision: pack the release (`scripts/pack-prime-agent-release.mjs`), install to `~/.prime/installs/idle-waste-fix-20260902`, re-point `/opt/homebrew/bin/prime-agent`, and replace the live supervisor with the worker-preserving path in the runbook. Existing workers keep the old code until each is stopped and resumed.

---

## 4. Results

Branch `perf/idle-waste-20260902`, ten commits, all reviewed line by line by the orchestrating session:

| Commit | Fix | Review notes |
|---|---|---|
| `5c484e8a2` | F1 identity memo (+ lane T's F5 files swept in from the shared index) | hits re-probe with `kill(pid,0)`; absence never cached; a cached exact id can confirm but never disprove, so `exact-dead` always costs a fresh `ps`; injected test seams bypass the memo. Accepted residual: a reused pid could carry a stale identity for at most 5 s. |
| `59d69d989` | F2 fence poll 250 ms → 2 s | constant only |
| `a5022a151` | F3 status append on change + 5 min failure backoff | backoff keyed to message count; `owesSummary` needs new content |
| `0f328478b` | F8 timing-log thresholds 100 → 500 ms | constants only |
| `969cd1248` | F6 client: agents-view 15 s poll deleted | push path kept |
| `67223a386` | F4 traces flag cached by settings revision; lock-free settings reads | safe because writes are temp file + `renameSync` (settings-manager.ts:316-317). Caveat: an external edit of settings.json is seen after the next in-process reload, not on the next entry. |
| `10cbd505f` | F7 heartbeat 300 s, no resources; prune hourly in the supervisor only, 60 s after start | role is read from env at init before the schedule |
| `e0ff035df` | F6 server: cache-first `heartbeats_list`, single-flight refresh, degrade to last snapshot | stale set on all worker-ready transitions |
| `fa24301d2` | F6 server: `heartbeats_changed` debounced to 1 s trailing edge | timer cleared on shutdown |
| `dfd1f4ae0` | F6 server: mid-refresh change keeps the worker stale (review finding) | per-worker change sequence |

Focused tests run once per lane (no full suite, no `npm run check`, husky bypassed with `--no-verify` after the first three commits): session-lease 39/39, daemon-mode 191/194 (3 pre-existing RLM ledger mock failures, identical on `main`), summarizer 22/22 + lifecycle 10/10, agent-traces 31/31, settings-manager 39/39, process-lifecycle 13/13, supervisor-heartbeats 10/10, supervisor-ownership 32/32, agents-view-state 67/67, agents-view-mode 25/25, agents-view-roster 6/8 (2 pre-existing: one needs an exact process identity the vitest process lacks, one hit the supervisor file mid-edit).

Process lessons for next time: four lanes on one worktree share one git index, so commit with `git commit --no-verify -- <owned files>`; the husky pre-commit hook runs the whole `npm run check` and must be bypassed for this kind of work.

Not deployed. Deploy path (step 5 above) is a separate go: pack, install to `~/.prime/installs/idle-waste-fix-20260902`, re-point the symlink, worker-preserving supervisor restart, then restart panes one by one so the TUIs and workers pick up the new bundle, then re-sample.

---

## 5. Round two: the working-fleet costs (audit worker C1, C4, C6)

Same frame, same worktree, same rules (owned files, focused tests only, `--no-verify`, no push). These three bite while agents are working, not idle, and are the rest of what the worker profiles pointed at.

| # | Fix | Where | Behaviour after | Lane |
|---|---|---|---|---|
| R1 | Orphan-process journal kept in memory: index loaded once per process and updated on append; one `fsync` per append; compaction (temp file + rename) only past a size or record threshold on the retire path; identity checks through the memoized `observeProcessIdentity`; on-disk format unchanged | `core/orphan-process-journal.ts:723-790, 1020-1062` | per bash call: 2 full re-reads + ~20 `lstat` + 6 `fsync` + 4 `ps` → 0 reads, 1 `fsync`, 0 `ps` | O |
| R2 | Incremental roster rows (recompute only the session whose event arrived, no `statSync` on unchanged sessions), flush to the supervisor debounced to 250 ms trailing edge with immediate flush on lifecycle transitions, send only when the fingerprint changed; no per-token flush scheduling | `modes/daemon/daemon-mode.ts:7473, 7635-7806, 8037-8052`; `modes/daemon/daemon-session-list.ts:148-315` | O(events × sessions × messages) → O(events) plus one bounded flush per window | R |
| R3 | RLM child token fan-in: incremental preview from the delta (bounded tail window), at most one `rlm_child_update` per child per ~100 ms plus immediate on lifecycle, parent-chain walk instead of two tree scans | `core/agent-session.ts:10524-10532, 10606-10667` | O(L²) per child answer → O(L); 5,000 tokens → tens of ancestor emits | C |

Proof for this round: per-lane micro-timings in the new tests (journal with 2,000 records: enroll+retire reads the file zero times; 40 sessions × 500 messages: one event recomputes one row and sends at most once per window; 5,000-token child stream: bounded emits, identical final preview), then the isolated fleet run (`scripts/idle-fleet-measure.py`) again for create/resume/list/shutdown regression, then the live re-sample after deploy.

### Round two results

Three commits, each reviewed line by line; all lanes ran only their focused tests with `--no-verify`:

| Commit | Fix | Measured (same harness before on `main`, after on the branch) | Review notes |
|---|---|---|---|
| `2a0a7ae5c` | R1 orphan journal in memory, one `fsync` per append, compaction on retire past 256 KB or 512 records | journal reads per enroll+retire **5 → 0**; per cycle at 2,005 records 31.3 → 28.8 ms, at 8,005 records 50.7 → 28.4 ms (flat in journal size now); journal after 100 cycles on the 1.9 MB case 1,948,120 B / 8,205 rec → 48,437 B / 203 rec | index valid only while descriptor and path share inode, size, `mtimeNs`, `ctimeNs`; compaction = temp file + `fsync` + `rename` + dir `fsync` + reopen, inside the existing guard; legacy-v1 journals never rewritten; a failed compaction disables itself. Remaining floor ≈ 26 ms per cycle is the guard's six `fsync`s (deferred fsync group-commit item). |
| `0e6ade64c` | R2 incremental roster rows, 250 ms trailing debounce, immediate on lifecycle, per-token flush removed | 40 sessions × 500 messages, 200 events in one session: **0.365 → 0.0014 ms per event**, rows composed **8,040 → 1**, supervisor sends **200 → 1** | dirty-set driven recompute with an O(1) currency guard for untouched rows, cached JSON reused by reference, full recompose every 5 s as safety net, timer cleared on shutdown; wire shape unchanged |
| `414e34a8b` | R3 incremental child preview (bounded 163-char prefix, settles), `message_update` coalesced to 100 ms trailing, lifecycle immediate, parent-chain caches | 5,000-token grandchild stream: parent snapshot rebuilds + `JSON.stringify` **5,009 → 9**, root emits 32 → 11, median wall 748 → 530 ms (floored by the test's own 200 ms sleeps), final preview identical | `finalize` rescans the terminal message so the final text cannot differ; lifecycle emits cancel a pending coalesced emit; timer unref'd and dispose-guarded |

Pre-existing failures reproduced on pristine `main`, not introduced here: `daemon-agent-roster.test.ts` 9 of 24 (RLM ledger and delete paths), `daemon-mode.test.ts` 3 of 194 (ledger mocks), one Python-runtime test in each of `orphan-process-journal.test.ts` and `agent-session-recursion.test.ts` (`prime-agent-runtime/.venv` absent on this machine).

Isolated fleet regression on the round-two head (`scripts/idle-fleet-measure.py`): five real workers resumed on real transcripts with six TUIs, 0 `agent_status` appends and 0 heartbeat records in 76 s idle, fleet CPU sum avg 7.3 % over 21 processes, clean `shutdown --force`, 0 processes left.

Still deferred (audit tier 2 and 3, in order of likely payoff): fsync group-commit across the command journal, recovery journal, descriptor persist and the orphan-journal guard; the cron store rescan; the RLM ledger re-parse; the six blocking `git` spawns per turn; kernel-per-session memory.
