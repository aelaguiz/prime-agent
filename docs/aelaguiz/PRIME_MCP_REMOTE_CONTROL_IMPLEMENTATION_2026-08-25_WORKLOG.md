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
