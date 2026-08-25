# Prime MCP Remote Control — Implementation Worklog

Plan: `PRIME_MCP_REMOTE_CONTROL_IMPLEMENTATION_2026-08-25.md`.
Worktree: `/Users/aelaguiz/workspace/prime-agent-worktrees/mcp-serve`, branch `feat/mcp-serve`.

## M0 — Baseline (2026-08-25)

Commands:

- `npm install` (worktree had no node_modules) — exit 0.
- `npm install @modelcontextprotocol/sdk -w packages/coding-agent` — exit 0, resolved `1.30.0`
  (satisfies the `.npmrc` `min-release-age=7` rule; npm 11.18.0, node v26.6.0).
- `npm run check` (repo root, before any code) — exit 0:
  `Checked 964 files in 479ms. No fixes applied.` + installer render check + browser smoke.
- `npx tsx src/cli.ts status` from `packages/coding-agent` — prints the daemon table
  (default socket, pid 25649, version 0.8.0, status current, 98 sessions), proving the worktree
  toolchain runs the CLI from source.

Files touched: `package-lock.json`, `packages/coding-agent/package.json`, this worklog.

Decisions: none beyond the plan. The plan docs in `docs/aelaguiz/` are left untracked; the parent
owns committing them.

## M1 — Vertical slice: `status` end-to-end (2026-08-25)

Built:

- `src/modes/mcp-serve/daemon-bridge.ts` — one `DaemonClient` with `enableAutoReconnect`
  (`recoverDaemon: ensureInteractiveDaemonRunning`), `command<T>()` that throws `DaemonCommandError`
  with the daemon's verbatim message + `errorInfo.code`, and one bounded recover-and-retry for
  transport failures (never for a daemon `success: false`). No attach, no client env, no
  `extension_ui`.
- `src/modes/mcp-serve/render.ts` — `deriveSessionState`, `deriveSession`, `deriveFleet`
  (child counts from parent linkage, needs-attention-first sort), `renderFleetStatus`,
  `renderSessionLine`, char caps.
- `src/modes/mcp-serve/tools.ts` — `status` tool (`{ all?: boolean }`), `list {all}` plus
  best-effort parallel `get_last_assistant_text` (5s each) for `waiting_on_user` rows.
- `src/modes/mcp-serve/mcp-serve-mode.ts` — `runMcpServe`: stateless Streamable HTTP on
  `node:http` at `/mcp` (fresh `McpServer` + transport per POST, cleaned up on `res.close`),
  405 for GET/DELETE, 404 elsewhere, 4 MiB body cap, `--stdio` variant with stderr-only logging,
  SIGINT/SIGTERM shutdown.
- CLI: `CommandSpec` in `src/cli/command-registry.ts`, `case "mcp-serve"` plus a verb-local flag
  parser in `src/cli/public-command.ts` (`--port`, `--bind`, `--stdio`, `--socket|--daemon-socket`
  via `normalizeSocketPath`).

Commands and results:

- `npm run check` (repo root) — exit 0, `Checked 968 files in 570ms. No fixes applied.`
- `npx tsx src/cli.ts help mcp-serve` — renders usage, description, and the four options.
- `npx tsx src/cli.ts mcp-serve --port 7717 --bind 127.0.0.1` against the real default daemon,
  driven by an MCP SDK `StreamableHTTPClientTransport` client: `tools/list` -> `status`;
  `status` returned 96 real sessions, text 14,917 chars, longest line 200 chars, no tool error.
- SIGTERM to the serving process: port released, exit code 0.

Correction found against live data (plan §2.2 state table): the plan derives `inactive` from
`lifecycle !== "live" || !activeSessionId`. On this machine 48 of 96 rows in the LIVE list are RLM
child sessions that legitimately have no `activeSessionId` (`daemon-supervisor.ts` uses
`summary.activeSessionId ?? summary.id` everywhere), so that rule marked live child agents
`inactive`. The row is now classified `inactive` only when `lifecycle !== "live"` or `workerState`
is absent — the supervisor stamps `workerState` on every summary it publishes from a live worker
(`publicSummary`), and `summaryForInactiveSession` never sets it. Session selectors follow the same
convention: `activeSessionId ?? id`.

Open questions raised with the parent: RLM children dominate the fleet view (48 of 96 rows, all
`stalled` by the plan's rule and therefore sorted above working sessions), and the full status text
is ~15 KB.

Files touched: `src/modes/mcp-serve/{daemon-bridge,render,tools,mcp-serve-mode}.ts`,
`src/cli/command-registry.ts`, `src/cli/public-command.ts`, `package.json` (zod), this worklog.

## M2 — Read tools (2026-08-25)

Built (plus the approved status payload rules from the M1 gate):

- `render.ts`: `selectFleetRows` (hide `rlmDepth > 0` rows unless asked, child counts computed
  BEFORE filtering, saved-row cap, `max_rows` cap with a `+N more: ...` collapse line and full
  counts), header now reports shown/total, hidden children, and saved-row capping;
  `rlmDepth > 0` never classifies `stalled`; `renderMessage` for all seven roles (user, assistant
  with tool calls, toolResult incl. error/image, bashExecution, custom, branchSummary,
  compactionSummary); `renderTranscript` newest-last window with an explicit truncation marker and
  a `nextBefore` paging cursor; `truncate` for newline-preserving blocks.
- `tools.ts`: `status` gains `include_children` and `max_rows`; new `session_detail`
  (`get_state` required, then best-effort `get_session_stats`, `get_queue`, `get_rlm_children`,
  `get_last_assistant_text`, `heartbeats_list` in parallel) and `transcript`
  (`get_messages` + window + paging cursor).
- `test/mcp-serve-render.test.ts`: 27 unit tests over the state table (every rule and precedence),
  the 30-minute boundary, selector fallback, selection/caps, header and collapse rendering, one
  case per message role, and transcript paging.

Commands and results:

- `npm run check` — exit 0, `Checked 969 files in 550ms. No fixes applied.`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-render.test.ts` — 27 passed.
- Live smoke against the real daemon through the MCP SDK HTTP client: `status` now renders 26 rows
  (74 children hidden, 7.6 KB), `session_detail` returns stats/children/heartbeats/last assistant
  message, `transcript` pages backwards with `next_before`, and an unknown selector returns
  `isError: true` with the daemon's own wording (`get_state failed: Unknown active session: ...`).

Decisions: `totals.suppressed` counts every row not rendered (row cap plus saved cap) and
`suppressedCounts` matches it, so the `+N more` line never disagrees with the counts.
Polish: child counts are singular/plural correct, and the context percentage is rounded.

Files touched: `src/modes/mcp-serve/{render,tools}.ts`, `test/mcp-serve-render.test.ts`,
`docs/aelaguiz/PRIME_MCP_REMOTE_CONTROL_IMPLEMENTATION_2026-08-25.md` (§0/§2.2/§2.3 updated to the
approved reality), this worklog.

## M3 — Control tools (2026-08-25)

Built:

- Approved M2 follow-ups: `transcript` clips each message at 25% of the page budget (300-char
  floor) and appends `[message truncated - fetch alone with before=<index+1>, max_chars=20000]`;
  `session_detail` reports a `notes:` line naming each section whose getter failed, instead of
  hiding it.
- `send` (multi-session, modes auto/steer/follow_up, per-session `accepted|queued|error`, one
  failure never stops the others), `interrupt` (turn/bash/compaction), `start_session`,
  `resume_session`, `restart_session`, `kill_session`.

Commands and results:

- `npm run check` — exit 0.
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-render.test.ts` — 29 passed
  (two new transcript sub-cap tests).
- Manual sequence against a THROWAWAY daemon socket and isolated agent dir
  (`--mode daemon --daemon-socket /tmp/prime-mcpserve-m3-*.sock --offline`, `PI_OFFLINE=1`,
  `PRIME_AGENT_CODING_AGENT_DIR` under `/tmp`), `mcp-serve` on port 7719 pointed at that socket:
  status (empty) -> start_session -> status -> send (auto to a busy session + an unknown session)
  -> send steer -> send follow_up -> session_detail -> transcript -> interrupt turn -> interrupt
  bash -> restart_session -> status -> resume_session (already live) -> kill_session -> status
  (empty) -> resume_session by sessionId with a message -> status. All tools returned
  `isError=false` except the deliberately unknown selector, which returned the daemon's own
  wording. Throwaway daemon, worker, sockets, and temp dirs removed afterwards.

Corrections found by running it:

1. `queueIfBusy: true` is NOT enough to queue onto a session that is already streaming.
   `agent-session.ts` rejects any visible-queue prompt without `streamingBehavior`
   ("Agent is already processing. Specify streamingBehavior ..."). `send mode=auto` now retries the
   rejected prompt once with `streamingBehavior: "followUp"` and reports `queued`. No pre-check, so
   there is no race window.
2. A `create` response carries the worker's own summary without the supervisor's fields
   (`workerState`), so a freshly started session rendered as `inactive`. `start_session` and
   `resume_session` now re-read `get_state` for the authoritative row.
3. `resume_session` on a live session succeeded but reported `was_already_active: false`, because
   the supervisor silently reuses the live worker. It now probes `get_state` first and reports the
   live session honestly; the `session_already_active` error path is still handled.

Environment note for M4: this machine's agent shells export `PRIME_AGENT_INTERNAL_DAEMON_WORKER`
and `RLM_*`. A daemon spawned with an inherited environment starts as a WORKER and never sends a
public hello. The e2e test must strip `PRIME_AGENT_INTERNAL_*` (and `RLM_*`) from the child env.

Files touched: `src/modes/mcp-serve/{render,tools}.ts`, `test/mcp-serve-render.test.ts`, worklog.

## M4 — E2E suite test + hardening (2026-08-25)

Built:

- `mcp-serve-mode.ts` split: `startMcpServe({ port, bind, daemonSocket })` starts the HTTP server and
  returns a handle (`port`, `socketPath`, `daemonVersion`, `close()`); `runMcpServe` keeps the signal
  handling and the startup log. Port 0 binds an ephemeral port, which is what the test uses.
- `test/mcp-serve-e2e.test.ts`: spawns a real daemon on a unique tmp socket via tsx
  (`--mode daemon --daemon-socket <tmp> --offline`, `PI_OFFLINE=1`, isolated `ENV_AGENT_DIR`),
  starts mcp-serve in-process on an ephemeral port against that socket, and drives it with the real
  MCP SDK `StreamableHTTPClientTransport`: tools/list (all nine, in order) -> status (empty) ->
  start_session -> status (1 session, not `inactive`) -> send (real + unknown selector) ->
  session_detail -> transcript -> interrupt -> kill_session -> status (empty) -> unknown selector
  returns `isError`. Teardown closes the server, sends `shutdown {force: true}`, SIGTERMs the child,
  waits for exit, and removes temp dirs with retries.
- The spawned daemon environment strips `PRIME_AGENT_INTERNAL_*` and `RLM_*`; without that the child
  starts as a session worker and never completes the public handshake.
- Lane convention followed rather than invented: `test:ci` now excludes `test/mcp-serve-e2e.test.ts`
  alongside `test/daemon-supervisor-process.test.ts`, and `test:process` runs both. CI already runs
  `npm run test:process` as its own job.

Commands and results:

- `npm run check` — exit 0, `Checked 970 files in 603ms. No fixes applied.`
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-e2e.test.ts` — 1 passed
  (~2.6s; three consecutive runs green, no leftover sockets, processes, or temp dirs).
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-render.test.ts` — 29 passed.
- Daemon-churn proof, throwaway socket: `status` green, daemon pid 62434, `kill -9 62434`, process
  confirmed gone, next `status` call returned `isError=false` with correct output, and the socket was
  then held by a NEW daemon pid 67473 (respawned through `ensureInteractiveDaemonRunning` from the
  bridge recovery path). No crash in the mcp-serve log.

Note for future process work on this machine: the CLI rewrites `process.title` to `prime-agent`, so
`pgrep -f` on daemon arguments finds nothing. Identify a daemon by its socket
(`lsof -nP -U | grep <socket>`) instead.

Files touched: `src/modes/mcp-serve/mcp-serve-mode.ts`, `test/mcp-serve-e2e.test.ts`, `package.json`
(test lanes), this worklog.

## M4b — Review hardening (2026-08-25)

Independent review: `/tmp/prime-mcp-research/review-m4.md` (verdict: fix-then-ship, P0 = 2, P1 = 4,
P2 = 12). Fixed everything the parent triaged; P2-4 (export a sentinel from `agent-session.ts`) and
P2-12 (hidden-children state counts) were declined by the parent.

- **P0-1 / P2-3 / P2-7 (`tools.ts`)**: the supervisor refuses to route a session command to a worker
  without a live client, so `get_state` fails on exactly the sessions that need repair. New
  `readSessionSummary` falls back to the row from `list` (`publicSummary` keeps `workerState` and
  `sessionFile` there), with `matchesSessionSelector` mirroring `matchWorkers`. `restart_session`
  now reaches `retry_worker`, and takes it for `recovering` as well as `failed` — matching what
  `status` reported. `kill_session` re-checks after a failed kill and reports the stop honestly when
  the supervisor stopped an unresponsive worker anyway.
- **P0-2 / P2-11 (`daemon-bridge.ts`)**: a mutating command is never retried. A client-side timeout
  does not cancel daemon work (worker requests run up to 24h) and a retry carries a fresh wire id, so
  the daemon's idempotency journal would miss it and the session would receive the command twice.
  `DaemonCapabilityUnavailableError` is non-retryable too. Read-only commands keep recover-and-retry.
- **P1-1 / P1-2 (`daemon-bridge.ts`)**: `recover()` is single-flight, waits up to 2s for the client's
  own reconnect loop to win before calling `reconnect()` itself, and re-arms `enableAutoReconnect`
  (the client clears its reconnect options for good after one expired 60s window).
- **P1-3 / P1-4 (`test/mcp-serve-e2e.test.ts`)**: `session_detail` now asserts `notes` is empty and
  `stats`/`heartbeats` are present, which proves all five optional getters answered on a real daemon.
  The flow gained `restart_session` on the healthy session (asserts the `kill_and_resume` path, the
  new id, and the retained session file), `resume_session` from the retained file after
  `kill_session` (the `create {sessionPath}` path), a transcript check that survives both, and a
  resume of a live session asserting `was_already_active`. No failed-worker fixture was built: the
  `retry_worker` path stays covered by code shape only.
- **P2-1**: `list {all: true}` uses the 30s catalog timeout the shipped CLI callers use.
- **P2-2**: `session_detail` and `transcript` descriptions point at `resume_session` for rows that
  `status --all` shows but that have no live worker.
- **P2-5**: a failed post-create prompt no longer hides the session identity; `start_session`,
  `resume_session`, and `restart_session` report `Started <selector> ... Prompt failed: <message>`.
- **P2-6**: `interrupt` says `Sent interrupt (turn) to <session>` instead of claiming an effect.
- **P2-8 / P2-9 / P2-10 (`mcp-serve-mode.ts`)**: an oversized body is drained and discarded so the
  caller reads the 400 (hard ceiling 16 MiB, then the socket is dropped); the three voided promises
  in the HTTP path have catches; `--stdio` exits when the client closes the pipe, and the shutdown
  helper removes its signal listeners.

Commands and results:

- `npm run check` — exit 0, `Checked 970 files in 545ms. No fixes applied.`
- `test/mcp-serve-render.test.ts` — 29 passed.
- `test/mcp-serve-e2e.test.ts` — 3 consecutive runs passed (4.0s, 3.9s, 4.0s).
- Manual proof of P2-8: a 5 MiB body returns
  `400 {"jsonrpc":"2.0","error":{"code":-32700,"message":"Request body exceeds 4194304 bytes"},"id":null}`
  (before the fix the client saw a broken pipe); a 20 MiB body is dropped at the drain ceiling; a
  normal `status` call on the same server still works.
- Manual proof of P2-10: an MCP stdio client saw all nine tools and the child process exited on
  client close.

Files touched: `src/modes/mcp-serve/{daemon-bridge,tools,mcp-serve-mode}.ts`,
`test/mcp-serve-e2e.test.ts`, this worklog.

## M4c — Re-check fixes (2026-08-25)

Re-check verified all six M4b fixes as genuinely fixed and found four regressions introduced by that
commit. All four fixed as proposed.

- **NEW-1 (`tools.ts`)**: the `list` fallback now mirrors `matchWorkers`' RESOLUTION rules, not just its
  predicate. `resolveSessionSummary` filters exact matches (activeSessionId ?? id, sessionId,
  sessionName) first and only falls back to id-suffix matches when there is no exact hit, and throws
  `Ambiguous active session "<selector>"` on more than one candidate. Before this, an ambiguous suffix
  could make `restart_session` kill and resume an arbitrary session.
- **NEW-2 (`tools.ts`)**: `kill_session` only tells the "the daemon stopped it anyway" story for a
  session that existed BEFORE the kill and is provably gone after it. A selector that never resolved now
  reports the daemon's error. If the post-kill re-read itself fails, the original kill error is reported
  rather than a guessed success.
- **NEW-3 (`daemon-bridge.ts`)**: recovery now runs for every command type; only the re-send is declined
  for mutating commands. A client that only sends mutations heals the connection and re-arms
  auto-reconnect again, with the no-double-delivery guarantee unchanged.
- **NEW-4 (`tools.ts`)**: when both `get_state` and `list` fail, `readSessionSummary` throws
  `Cannot read session "<selector>": <list error> (state read: <state error>)` instead of letting a
  daemon outage be reported as an unknown session.

Added coverage (not requested, but this is the destructive path the reviewer flagged):
`resolveSessionSummary` is exported and unit-tested for exact-beats-suffix, suffix-only, ambiguity, and
no-match; the e2e test asserts `kill_session` on an unknown selector returns `isError`.

Commands and results:

- `npm run check` — exit 0, `Checked 970 files in 616ms. No fixes applied.`
- `test/mcp-serve-render.test.ts` — 33 passed (29 + 4 new).
- `test/mcp-serve-e2e.test.ts` — 2 consecutive runs passed (4.43s, 4.37s).

Files touched: `src/modes/mcp-serve/{daemon-bridge,tools}.ts`, `test/mcp-serve-render.test.ts`,
`test/mcp-serve-e2e.test.ts`, this worklog.
