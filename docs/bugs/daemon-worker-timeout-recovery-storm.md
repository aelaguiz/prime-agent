---
title: "Worker RPC backpressure crashes the daemon and rebuilds break recovery"
date: 2026-08-21
status: verified
owners: [coding-agent]
reviewers: [daemon-incident-concurrency-review, daemon-incident-bundle-review]
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** On `amir-m5`, a worker RPC timeout terminated the supervisor. Repeated successor launches then struggled to adopt the resident workers, clients reported incompatible or unknown daemons/sessions, and an in-place bundle rebuild left live processes pointing at deleted hashed chunks.
- **Impact:** One unresponsive worker can take down the shared supervisor. Recovery can create a process storm and temporarily or permanently strand otherwise live sessions. A later lazy import can fail after a rebuild even when protocol compatibility is unchanged.
- **Most likely causes:** `DaemonWorkerClient.requestWire()` hides its timed response promise behind an awaited socket write; a stalled write lets that inner rejection become unhandled. Recovery launch is coordinated only after each client has spawned a full supervisor. A connected socket with no ready `daemon_hello` is mislabeled stale/incompatible. The bundle build deletes the live split-module closure before publishing its replacement.
- **Next action:** Commit and deploy the verified fix, then use the correlated lifecycle records for any future worker timeout.
- **Status:** Implemented, verified by focused and process tests, and independently approved by concurrency and bundle reviewers.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

A slow or blocked worker must remain an isolated worker failure. Every client must converge on one recovering supervisor without destructive takeover or false incompatibility. Rebuilding a wire-compatible source or bundle must not invalidate code that a live supervisor or worker can still load.

## Human-Authorized Corrected Behavior

- Preserve active sessions across source and bundle build fingerprint changes.
- Keep build IDs diagnostic only. Daemon admission remains strict on protocol version, schema ID, and app version.
- A reachable socket that has not sent a valid `daemon_hello` is starting or unresponsive, not incompatible. Never spawn or shut down a second daemon behind that reachable endpoint.
- Contain worker RPC timeouts at the worker client. Do not weaken fatal unhandled-rejection policy.
- Preserve current command, recovery, shutdown, signal, and wire semantics.
- Keep the fix local, privacy-safe, and directly testable.

## Incident Evidence

All remote inspection was read-only. No remote process, socket, session, or runtime file was changed.

- `~/.prime/agent/logs/processes/ab7c5c6c-4f6a-4474-8fea-49ab6be7d014.jsonl` records supervisor PID 3855 ending at `2026-08-21T12:48:45.008Z` with `fatalObserved: true`, exit code 1, an `unhandled_rejection`, and the matching `uncaught_exception` rethrow. The stack starts at the worker-response timeout callback in the deployed bundle.
- The same signature then killed successor PIDs 32080, 66249, and 80899. This is repeatable supervisor failure, not one external signal or OOM.
- Before PID 3855 exited, `agent.jsonl` recorded 24 caught `heartbeats_list` worker timeouts at `12:46:46Z`. Earlier `list` timeouts were also logged and contained. The retained privacy-safe lifecycle record does not include the fatal command name, so the exact fatal RPC and worker remain unknown.
- PID 32080 adopted 22 workers immediately and reconnected the remaining three after retries. While it recovered, 24 competing supervisor processes loaded and waited on the durable socket lock, then exited `ELOCKED` together after the lock retry window.
- After PID 32080 crashed, PID 35597 attempted all persisted workers concurrently. Every worker initially timed out waiting for hello, demonstrating a recovery-load amplification path. Later supervisors recovered most workers again.
- From `12:48Z` through `13:07Z`, lifecycle records contain 100 replacement supervisor starts: 49 `ELOCKED`, 46 shutdown-admission failures, three timeout fatalities, one graceful SIGTERM, and one survivor. Client logs contain 521 no-recognizable-hello classifications and 141 busy-replacement refusals.
- The successor intentionally listens before worker adoption completes and withholds `daemon_hello` until `markReady()`. The launcher currently converts that expected no-hello interval into `stale`, which produces `Daemon: unknown build` and the false user-facing incompatibility error.
- `packages/coding-agent/scripts/bundle.mjs` recursively deletes `dist/bundle` and then writes a split ESM graph. Live provider, highlighter, validator, and extension paths use late `import()`, so an old loaded module can request a hashed file that the rebuild has deleted. The old chunk names are now absent, but no retained Prime or macOS log contains `ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`, or an equivalent module-load error; this is a proven filesystem-lifetime defect, not the evidenced cause of PID 3855's crash.

## Confirmed Root Causes

### 1. Hidden unhandled rejection in the worker transport

`packages/coding-agent/src/modes/daemon/daemon-worker-client.ts` creates and arms the response promise, then awaits `PrivateFramedChannel.send()`, and returns the response promise only after the socket write callback fires. Under backpressure the write callback can remain pending beyond the response deadline. The caller owns only the outer async promise; the inner timed promise has no handler and its rejection is fatal under the repository's intentional unhandled-rejection policy.

The narrow owner is `DaemonWorkerClient.requestWire()`. Global heartbeat and list fanouts already catch their returned worker requests and must keep their current fail-closed/cached behavior.

### 2. Recovery launch herd and adoption pressure

`ensureInteractiveDaemonRunning()` is memoized only inside one process. After a crash, every connected CLI can independently observe an absent socket and spawn a full supervisor. The supervisor's socket lease prevents two durable owners, but election happens after each child loads the bundle. The losing children wait and fail, consuming CPU and memory during the exact worker-adoption window. Startup also adopts every descriptor concurrently, so recovery pressure scales directly with resident worker count.

### 3. No-hello is misclassified as wire incompatibility

`probeDaemonVersion()` returns `stale` for every handshake failure after a successful socket connection. A recovering supervisor deliberately accepts connections before it is ready and sends hello only after adoption. No protocol, schema, app version, or build identity was received, so incompatibility is unsupported. The stale path can query/shut down the wrong endpoint or end with `StaleDaemonError: Daemon: unknown build`.

### 4. The split bundle is destroyed in place

`bundle.mjs` removes the complete old output before esbuild writes the new split closure. Already-running processes retain old module URLs and can load some chunks lazily hours later. Reusing daemons across build IDs makes this filesystem lifetime contract mandatory: every old referenced chunk must remain available until its process exits, and the new entrypoint must never be partially published.

### 5. Recovery-state selectors report a false absence

While a descriptor is known but its summary refresh is still recovering, `findWorker()` searches only refreshed summaries. Commands for the descriptor's root active/session ID therefore report `Unknown active session` instead of the truthful worker state. Reconnect loops retry either error, but the false absence obscures the real recovery condition and makes final diagnostics misleading.

## Ruled-Out Primary Causes

- The per-worker `Promise.all` heartbeat/list catches do not leak their returned rejections on current main.
- A pure response timeout after a completed socket write is contained by existing callers. The fatal window requires the lower-level send to remain pending while its hidden response promise rejects.
- The lifecycle handler did not invent the failure. It persisted the original unhandled rejection and preserved the configured fatal Node behavior.
- Build fingerprint inequality is not a wire incompatibility and must not be restored as a replacement trigger.
- Provider-specific missing-module retries would load new code into an old graph and are not safe.

## Scope and Simplicity Contract

- **Smallest sufficient fix:** Return the one worker response promise immediately; handle send failure as a side path; serialize cross-process supervisor launch/recheck; classify no-hello separately and wait boundedly; bound only startup/recovery handshake pressure; surface known descriptor recovery state; and publish split bundle outputs additively with the new `cli.js` last.
- **Initial minimal convergence closure:** Include source and bundle build mismatches, no-hello startup, cross-process recovery election, worker-adoption pressure, and retained old hashed chunks because they are competing paths through the same supervisor recovery contract. Exclude package-manager update transaction redesign and provider-specific fallbacks.
- **Scope freeze:** Frozen from the user's direct implementation request on 2026-08-21.
- **Enough proof:** Low-level blocked-send regression, launch/no-hello regressions, recovery-state regression, focused daemon suites, a two-generation bundle lifetime smoke, `npm run check`, and `git diff --check`.
- **Do not build:** No protocol command/event/response change, no build-ID admission check, no fatal-policy downgrade, no blind stale-daemon shutdown, no stable unhashed chunk names, no provider retry shim, and no broad update-coordinator rewrite.
- **Accepted residual risk:** An explicit `npm run clean` or external package-manager replacement can still delete a live installed artifact. Regular `npm run build` becomes safe. Changed content-addressed chunks accumulate on repeated local builds until the next clean/prepublish build performed with no resident process; this bounded-release/unbounded-development disk tradeoff preserves arbitrarily long live sessions. Fully transactional global package replacement remains a separate deployment change.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Make `DaemonWorkerClient.requestWire()` return its timed response promise before waiting on transport write completion. Settle send errors through the same pending entry exactly once. Add a stalled-write regression that proves the caller rejects on time without `unhandledRejection`.
2. Add a cross-process launch lease around the absent/stale recheck and spawn path. Re-probe after acquiring it so losing clients join the winner rather than load competing supervisors.
3. Add a distinct no-hello probe state. Wait for the reachable owner up to the existing bounded startup period; if it never greets, return a handshake diagnostic without `list`, `shutdown`, or replacement.
4. Bound concurrent startup/recovery worker handshakes with the existing semaphore primitive while leaving per-worker retry delays concurrent. When a selector matches a known accessible root descriptor with no summary, report `Session worker is <state>` rather than `Unknown active session`.
5. Build the complete split bundle in memory. Publish content-hashed outputs into `dist/bundle` without deleting prior chunks, then atomically rename the completed `cli.js` entrypoint last. Embed a closure-scoped identity in that entrypoint so retained chunks and failed candidates cannot change the active build identity. Keep the current split/lazy architecture and its memory/startup profile.
6. Reconcile the build-identity integration doc and changelog with the protocol/schema/app-version admission rule. Run focused tests, the two-generation bundle smoke, `npm run check`, and `git diff --check`.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

Implemented on 2026-08-21:

- `DaemonWorkerClient.requestWire()` now returns the timed response promise before transport send completion and settles a send error through the same pending request.
- CLI recovery uses the same identity-fenced, cross-platform launch directory as worker-driven supervisor recovery. The elected client re-probes under the lease and holds it until a valid current hello or a bounded failure. A token-bound release marker permits safe reclamation if directory rename is blocked.
- A connected no-hello endpoint has a distinct unavailable state and is never queried, shut down, or replaced as incompatible.
- Startup worker connection/authentication attempts use an eight-permit semaphore. Other adoption and retry behavior is unchanged.
- Root descriptors that are known but not summarized report their effective worker lifecycle instead of false absence.
- The split bundle is built in memory, publishes every completed output atomically, retains prior content-hashed chunks, and renames `cli.js` last. Its embedded build ID fingerprints only the active generated closure, so retained or failed candidate chunks do not affect diagnostics or startup work.

Proof passed:

- `test/daemon-worker-client-compatibility.test.ts`: stalled transport send rejects at the response deadline with the caller already owning the rejection.
- `test/daemon-launch.test.ts`: no-hello classification, one-socket launch lease, Windows access-denied contention validation, blocked-release reclamation, compatible-build reuse, real incompatibility replacement, and startup failure diagnostics.
- `test/daemon-launch-lease-process.test.ts`: eight simultaneous frontend processes elect exactly one launch leader through the shared filesystem lease.
- `test/daemon-client.test.ts`: raw reconnect continues past a reachable replacement that delays hello.
- `test/daemon-supervisor-monitor.test.ts`: startup connection gate and recovering-descriptor diagnostics.
- `test/bundle-publication.test.ts`: a real generated generation A remains live and completes its late import after generation B publication; fault injection before the B entrypoint leaves A runnable with the same identity; fresh execution sees B; the production entrypoint remains executable and runnable.
- `test/daemon-supervisor-process.test.ts -t "isolates a root, streams a chunked snapshot, and adopts the same worker after restart"`: real supervisor restart/adoption.
- Seven focused files: 170 tests passed.
- `npm run check` passed with no warnings or infos from project checks.
- `git diff --check` passed.
- Independent concurrency and bundle/identity reviews both returned `APPROVED` after their blocking findings were fixed and re-reviewed.
<!-- /bugs:block:implementation -->
