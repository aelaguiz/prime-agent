---
title: "Daemon fleet lags and session starts time out under parallel load"
date: 2026-09-01
status: resolved
owners: [coding-agent]
reviewers: []
related: [docs/bugs/daemon-worker-timeout-recovery-storm.md]
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** On `amir-m5` with ~14 resident root workers, `aim prime run` and `aim prime resume` take 50 to 160 seconds or time out. Prompts inside a live session wait 10 to 20 seconds before they are accepted. The whole fleet feels laggy, and abandoned sessions accumulate because the operator detaches from locked-up sessions and starts new ones.
- **Impact:** Prime is unusable at the operator's normal parallelism. Every new session makes the next one slower.
- **Root cause (measured on amir-m5, reproduced and fixed on an isolated fleet here):** Every read-only authority check (worker fence poll every 250 ms per worker, worker command admission on every relayed command, supervisor ownership assertion on every journaled command, and the shutdown-admission read on every worker launch step) is serialized through one global filesystem mutation lock per registry directory, and there are two registry directories. The lock's contention path is expensive: every 10 ms retry performs a full publish attempt with fsync plus a synchronous `/bin/ps` spawn to classify the current holder. With N workers the lock is permanently oversubscribed, and every process's event loop is blocked in `execFileSync`/`fsyncSync` while it spins.
- **Next action:** Recycle the 12 pre-fix workers on amir-m5 (stop and resume) when convenient; they still run the old bundle and spin on the lock among themselves, so prompts inside those sessions stay slow until then. New sessions are already fast.
- **Status:** resolved (deployed on amir-m5 2026-09-01 23:10Z, proven on the live daemon)
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

Starting, resuming, and prompting a Prime session through AIM must be fast at 15 or more resident workers, and adding a worker must not slow the others down.

## Evidence from amir-m5 (instrumented build, 2026-09-01 22:18Z to 22:38Z)

Source: `~/.prime/agent/logs/processes/*.jsonl` (`daemon_registry_guard_timing`, only emitted when a guard took at least 100 ms or was contended) and `~/.prime/agent/logs/daemon.sock.a9cccd67.log`.

| Metric | Value |
| --- | --- |
| Slow guard acquisitions in 20 minutes | 1,550 (902 supervisor, 648 worker) |
| Wait to acquire (`acquireMs`), p50 / p90 / p99 / max | 1,962 / 8,715 / 23,298 / 41,717 ms |
| Work done under the guard (`actionMs`), p50 / max | 3 / 24 ms |
| Cumulative wait in that window | 5,548 s |
| Contention retries per acquisition, p50 / max | 19 / 290 (each retry sleeps 10 ms, so retries cost ~120 ms each under load) |
| Worker fence checks over 100 ms, p50 / p90 / p99 / max | 2,788 / 9,813 / 25,867 / 34,913 ms (n=655) |
| Session creates | 49,084 ms and 92,322 ms completed; 140,558 ms and 161,655 ms failed with the client gone |

Registry directories per acquisition: 2 (`~/.prime/supervisor-owners` plus the legacy `$TMPDIR/prime-agent-<uid>/supervisor-owners` mirror), acquired serially.

## Code anchors

- `packages/coding-agent/src/modes/daemon/daemon-supervisor-ownership.ts`
  - `withRegistryGuards` acquires `.guard` in every registry dir with `attempts: 1`, then retries up to 500 times with a 10 ms async sleep. Each retry re-runs the full publish attempt.
  - `assertDaemonSupervisorOwnerCurrent`, `assertDaemonSupervisorOwnerCurrentForWorkerAuthentication`, `DaemonSupervisorOwnership.assertCurrent`, and `isDaemonShutdownAdmissionActive` are reads that take the mutation guard.
- `packages/coding-agent/src/core/authority-mutation-guard.ts`
  - `publishGuard` creates a temp file, writes, `fsyncSync`, `chmodSync`, hard-links it as the canonical guard (EEXIST when held), then unlinks and fsyncs the directory. On EEXIST `reclaimExactDeadGuard` opens and parses the holder record and calls `classifyOwner`.
- `packages/coding-agent/src/core/session-lease.ts`
  - `observeDarwinProcessIdentity` runs `/bin/ps -ww -o command= -p <pid>` synchronously. `classifyProcessIdentityAuthority` and `matchesExactProcessIdentity` call it. `currentProcessIdentityFields` in the ownership module calls it uncached for the current pid on every guard acquisition.
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts`
  - `SUPERVISOR_FENCE_POLL_MS = 250`. `checkSupervisorFences` runs `assertSupervisorClaimCurrent` for the bound supervisor claim, then reschedules. `handleLine` runs the same check before admitting every supervisor-origin command.
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`
  - `handleLine` calls `assertCurrentOwnership` after every journaled command. `assertRecoveryAllowed` (ownership assertion plus shutdown-admission read) runs at every stage of a worker launch.

## Ranked hypotheses

1. **Global registry lock oversubscribed by read-only checks, with an expensive contention path.** Explains the measured 2 to 40 s acquisitions, the 50 to 160 s creates (a launch performs many serialized acquisitions), the 10 to 20 s prompt admission (supervisor assertion plus worker admission in series), and the accumulation feedback loop (more workers means more pollers). Supported by the amir-m5 numbers above. Not yet reproduced in isolation.
2. **`ps` spawn storm burns CPU and blocks event loops even without lock contention.** N workers polling every 250 ms each spawn at least two `ps` processes per poll. Contributes to the laggy feel; must be measured with fleet CPU sampling.
3. **Something else in worker startup is slow on its own** (tsx module load, provider discovery, session hydration, roster refresh). The amir-m5 deep trace claimed 1.1 s of real work in a 49 s create, but that was one run. The harness prints every startup phase so this is measured, not assumed.

## Reproduction plan

`scripts/bench-daemon-fleet.ts` spawns one isolated supervisor (own socket, agent dir, and registry dir, offline), creates N root sessions one at a time, probes a relayed `get_state` command in a loop, samples fleet CPU, then reads the instrumentation already in the codebase (worker startup phases, runtime create phases, registry guard timing, fence check timing) and prints a report. Run it before and after any fix with the same N.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Reproduction on this machine (Amirs-M3-Max-2, idle, source lane, 15 workers)

`node_modules/.bin/tsx --tsconfig tsconfig.json scripts/bench-daemon-fleet.ts --workers 15 --duration 20`

| Metric | Before | After |
| --- | --- | --- |
| Create latency, 1st worker to 15th | 1,254 ms rising to 12,090 ms | 879 ms to 890 ms, flat |
| Create with 15 workers resident | 12,350 ms | 1,058 ms |
| Relayed `get_state` probe, p50 / p99 | 1,358 / 3,137 ms | 15 / 69 ms |
| Slow registry guard acquisitions during the run | 1,502 (690 s cumulative wait, 6 s of guarded work) | 0 |
| Worker fence checks over 100 ms | 2,362 (p50 366 ms, max 5,622 ms) | 0 |
| Worker command admissions over 100 ms | 74 (p50 776 ms) | 0 |

The 15th worker's 11.7 s launch before the fix was spent almost entirely in the phases that take the guard directly or through worker admission: `persisting_descriptor` 2,032 ms, `preparing_process` 1,576 ms, `root_subscribed` 1,541 ms, `roster_refreshed` 1,440 ms, `ready` 1,207 ms, `worker_auth_completed` 868 ms. After the fix the largest launch phase is `root_session_created` at 138 ms median. Hypothesis 3 (slow real work in worker startup) is refuted: real work per launch is under 300 ms in the source lane.

Fleet CPU on an idle 16-worker fleet stayed at about 28% with the fence poll at 250 ms and at 1,000 ms, so the poll cadence was left unchanged.

## Fix

Read-only authority checks no longer take the registry mutation guard. Records are published by atomic rename, so a reader sees a whole old or new copy of each file; a bounded re-read (3 attempts, 25 ms apart) rides through a mirror write in flight instead of reporting a false loss. Changed in `packages/coding-agent/src/modes/daemon/daemon-supervisor-ownership.ts`:

- `withConsistentRegistryRead` (new helper) replaces `withRegistryGuards` in `assertDaemonSupervisorOwnerCurrent`, `assertDaemonSupervisorOwnerCurrentForWorkerAuthentication`, and `DaemonSupervisorOwnership.assertCurrent`.
- `isDaemonShutdownAdmissionActive` answers from a plain read when no admission exists or the admission's process is live, and takes the guard only to reclaim an admission left by an exactly dead process.

Mutations (acquire, phase update, release, startup fences, shutdown admission, offline maintenance) still take the guard unchanged.

Not changed, noted for later: the guard's contention path still performs a full publish attempt with fsync and a `ps` spawn on every 10 ms retry, and the supervisor still spawns `ps` for its own pid on every journaled command. Neither showed up as a cost once reads stopped contending.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation

- `packages/coding-agent/src/modes/daemon/daemon-supervisor-ownership.ts`: lock-free read helper and the four call sites above.
- `packages/coding-agent/test/daemon-supervisor-ownership.test.ts`: `verifies authority without waiting for a held registry guard` holds the canonical guard path and requires both the supervisor's own assertion and the worker fence check to resolve promptly.
- `scripts/bench-daemon-fleet.ts`: the reproduction and verification harness.
- The amir-m5 hotfix and instrumentation (root-authority guard on roster-discovered identity, 120 s cold-start budgets, correlated startup traces, slow-path timings) are ported in the preceding commit; the timings above come from that instrumentation.

## Deployment on amir-m5 (2026-09-01)

Built from adc4c4e78, packed with `scripts/pack-prime-agent-release.mjs`, installed with `npm install -g --prefix ~/.prime/installs/lock-free-reads-20260901-1805`, and switched in by re-pointing `/opt/homebrew/bin/prime-agent` at the new bundle so the old package directory stayed intact for the still-running workers. The supervisor was replaced with the worker-preserving `restart` wire command (the fork removed the `daemon restart` CLI, so it was sent through the product's own `DaemonClient` from the built dist). The successor (build 6d9f6fc3) adopted all 12 workers and was serving 36 s after the request.

Live measurement on that daemon with 13 old workers resident and the operator working on the box, one real interactive start (`prime-agent --provider anthropic --model claude-fable-5-1` in tmux):

| Step | Time |
| --- | --- |
| Client probe to daemon ready | 287 ms |
| Daemon create (worker spawn to root session ready) | 1,987 ms |
| Wall clock from client launch to the create logged complete | 3,166 ms |

Earlier the same day on the same daemon, creates took 49,084 ms and 92,322 ms and two failed past 140 s. The first create right after the restart still took 38 s while the new supervisor was refreshing the 12 adopted old workers through their contended admission path; the measurement above was taken once that settled.

Since the new supervisor started it has logged two slow registry-guard acquisitions; every other slow acquisition on the box comes from the pre-fix workers.
<!-- /bugs:block:implementation -->
