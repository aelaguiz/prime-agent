---
title: "IPython shell channel wedges long-lived Prime Agent sessions"
date: 2026-08-08
status: closed
owners: [coding-agent]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

> **Historical record:** The CPython cutover removed the Jupyter/IPython/ZeroMQ shell-channel runtime described below. Current Python REPL execution uses the CPython JSON-lines stdio protocol, so this failure mode and its fork-server-era diagnostics no longer apply.

- **Symptom (legacy runtime):** A harmless IPython call could remain in `tool_execution_start` forever while Prime reported the session as working.
- **Impact:** Long-lived home-server sessions stopped making progress and required a kernel or worker restart.
- **Cause:** The removed `KernelManager` consumed one shell reply during startup and did not continuously drain later `execute_reply` traffic.
- **Resolution:** Closed by the CPython runtime cutover; no current action remains. The implementation notes below document the 2026-08-08 fix for the retired runtime.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

A disconnected or backpressured Jupyter shell channel must never leave a Prime Agent IPython tool call pending forever. Completed shell replies must be consumed continuously, and uncertain delivery must fail loudly without replaying the cell.

## Bug Summary

`KernelManager.probeReady()` reads `kernel_info_reply` from the Jupyter shell Dealer during startup. After that, `executeInner()` only sends on the shell channel and completion depends on IOPub publishing `status: idle`; no shell receive loop remains. Dealer sends use the ZeroMQ defaults `immediate=false` and `sendTimeout=-1`, so a request can be accepted into a disconnected queue without reaching the kernel.

## Evidence


- A long-lived worker retained IOPub and control connections while its shell Dealer had no established TCP connection.
- Recovery state ended at `tool_execution_start` and the pending cell was absent from IPython history, so delivery was uncertain.
- `KernelManager.probeReady()` was the only shell receive call; later execution waited on an unbounded send and IOPub-only completion.
- The source still had ZeroMQ defaults `immediate=false` and `sendTimeout=-1` before this fix.

## Investigation

System CPU and memory pressure were disproven for the active incident. Historical disk-full and worker heap-OOM incidents are separate contributors, not the active shell failure. A second session stuck in compaction is also a separate unbounded lifecycle path and is not part of this fix.

## Scope and Simplicity Contract

- **Human-authorized corrected behavior:** Prevent this IPython shell-channel failure from wedging home-server Prime sessions; validate, deploy to home, restart Prime, and preserve resumability of the affected transcript.
- **Smallest sufficient fix:** Configure the shell Dealer to avoid queuing to disconnected peers, bound shell send time, continuously drain shell replies after startup, and reject an active execution on a shell transport disconnect or receive failure.
- **Initial minimal convergence closure:** The shell Dealer construction, lifetime receive pump, disconnect handling, cleanup, and directly targeted kernel tests. No daemon protocol change is required.
- **Scope freeze:** Frozen before implementation on 2026-08-08.
- **Enough proof:** Deterministic tests for reply draining and disconnect rejection; a normal real-kernel round trip proving configured socket options and ordinary execution; the focused kernel tests; full repository `npm run check`; built bundle identity verification on home after deployment.
- **Do not build:** No cell replay, no high-volume live reproduction, no compaction watchdog, no daemon protocol change, and no broad lifecycle refactor.
- **Accepted residual risk:** This fix does not address the independently observed compaction wedge or historical Node heap exhaustion.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Construct the shell Dealer with immediate delivery semantics and a finite send timeout.
2. Start a lifetime shell receive pump after `probeReady()` and continuously consume replies.
3. Monitor shell disconnects and reject any active execution with an explicit uncertain-outcome error; never replay it.
4. Reset the receive pump and monitor listener during normal cleanup.
5. Add deterministic unit coverage and a normal real-kernel configuration/round-trip check.
6. Run focused tests and the repository check, rebuild the dist bundle, deploy the exact changed artifacts to home, then perform the explicitly authorized full Prime Agent restart.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

### Implemented

- The shell Dealer now uses `immediate: true` and a 5-second send timeout.
- A lifetime shell receive pump starts after readiness and consumes every shell reply while IOPub remains the execution-result authority.
- Shell disconnects, receive failures, and send failures reject the active execution with an explicit uncertain-outcome error that instructs the caller to restart the kernel rather than replay the cell.
- Cleanup removes the disconnect listener and resets the shell pump reference.
- Added `test/kernel-shell-channel.test.ts` for deterministic reply draining, disconnect rejection, send-failure rejection, and one normal real-kernel round trip.

### Verified


- Deterministic shell-channel tests cover reply draining, disconnect rejection, and send-failure rejection.
- A real-kernel test verifies bounded immediate sends and a normal execution round trip when a kernel runtime is available.
- Focused kernel tests and the repository static gate are the required candidate proof.

### Follow-up

The independently observed compaction wedge still needs a separate timeout and recovery design. It was outside this fix's frozen scope.
<!-- /bugs:block:implementation -->
