# Prime Agent Remote Control MCP — Implementation Plan (2026-08-25)

Executes the approved design: `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25.md` (same directory).
API ground truth (exact signatures, line refs): `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25_RESEARCH_APIS.md`.
Daemon architecture reference: `..._RESEARCH_DAEMON.md`. Usage evidence: `..._RESEARCH_USAGE.md`.

**Workspace:** worktree `/Users/aelaguiz/workspace/prime-agent-worktrees/mcp-serve`,
branch `feat/mcp-serve` off main `b6c37e628`. All work happens here. Do not touch the main checkout.

**Deliverable:** `pi mcp-serve` — a per-machine MCP server (Streamable HTTP, stateless, port 7717,
no auth, tailnet-trusted) exposing 9 tools over the existing daemon Unix-socket protocol.
Zero daemon/protocol changes.

---

## 0. Ground rules (binding on all implementers)

1. Obey repo `AGENTS.md`. The rules that bite here:
   - No inline imports (`await import(...)`, `import("pkg").Type`). Top-level imports only.
   - No `any` unless truly necessary. Check `node_modules` for external types instead of guessing.
   - Sparse comments — only where there is real ambiguity.
   - After code changes: `npm run check` from repo root (biome + tsgo). Fix ALL errors/warnings/infos.
   - NEVER run `npm run dev`, `npm run build`, or bare `npm test`.
   - Run individual test files from `packages/coding-agent`:
     `npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts`
   - Any test file you create or modify MUST be run and iterated to green.
   - Suite tests use `test/suite/harness.ts` + faux provider; never real provider APIs or keys.
2. **No daemon protocol changes.** v1 needs none (verified). If you believe you need one, stop and
   report back instead of adding it — that is a design change requiring approval.
3. Run the server during development via tsx (no build):
   `cd packages/coding-agent && npx tsx src/cli.ts mcp-serve --port 7717`
4. Commit per milestone with plain technical messages (no emojis). Do not push, do not open a PR,
   and never merge — PR creation happens at the end, merge only on Amir's explicit approval.
5. Report back after each milestone (see §6 oversight protocol).

### One-time setup (M0)

```bash
cd /Users/aelaguiz/workspace/prime-agent-worktrees/mcp-serve
npm install                                   # worktree has no node_modules yet
npm install @modelcontextprotocol/sdk -w packages/coding-agent
# 1.30.0 (2026-07-27) clears the 7-day min-release-age rule; requires npm >= 11.10
npm install zod@^3.25.76 -w packages/coding-agent
# The SDK's tool-schema layer needs zod; it was only a hoisted peer install before (approved M1)
npm run check                                 # must be green BEFORE any code is written (baseline)
```

Note: `@modelcontextprotocol/sdk` gets bundled by esbuild automatically (only
zeromq/koffi/undici/photon/clipboard are externalized in `scripts/bundle.mjs`). It depends on `zod`
(already used in the monorepo); import zod as the SDK's tool-schema layer expects.

---

## 1. Files to create / modify

```
NEW  packages/coding-agent/src/modes/mcp-serve/mcp-serve-mode.ts   # runMcpServe entry: flags, transports, lifecycle
NEW  packages/coding-agent/src/modes/mcp-serve/daemon-bridge.ts    # DaemonClient lifecycle + typed command helpers
NEW  packages/coding-agent/src/modes/mcp-serve/tools.ts            # 9 tool registrations (zod schemas + handlers)
NEW  packages/coding-agent/src/modes/mcp-serve/render.ts           # SessionSummary/AgentMessage -> text; state derivation
MOD  packages/coding-agent/src/cli/command-registry.ts             # CommandSpec { path: ["mcp-serve"], ... }
MOD  packages/coding-agent/src/cli/public-command.ts               # case "mcp-serve" -> parse flags -> runMcpServe
MOD  packages/coding-agent/package.json                            # dependency
NEW  packages/coding-agent/test/mcp-serve-render.test.ts           # unit: state derivation + rendering
NEW  packages/coding-agent/test/mcp-serve-e2e.test.ts              # integration: real daemon + real HTTP MCP client
```

Verb wiring facts (from RESEARCH_APIS §3): adding the `CommandSpec` auto-registers help text and
membership in `PUBLIC_COMMAND_NAMES` (which correctly skips early-daemon-launch for the verb — we
call `ensureInteractiveDaemonRunning` ourselves). `--port/--bind/--stdio` are parsed verb-locally in
`public-command.ts` (public-command verbs never reach `parseArgs`), so `src/cli/args.ts` is untouched.
`--daemon-socket <path>` is normalized with `normalizeSocketPath` exactly like `daemon-command.ts` does.

---

## 2. Component specs

### 2.1 `daemon-bridge.ts`

One class, `DaemonBridge`, owning a single `DaemonClient`:

```ts
const socketPath = options.daemonSocket ?? defaultDaemonSocketPath();
const client = new DaemonClient(socketPath);
client.enableAutoReconnect({ recoverDaemon: () => ensureInteractiveDaemonRunning(socketPath) });
await ensureInteractiveDaemonRunning(socketPath);   // lazily boots/refreshes the daemon
await client.connect();
const hello = await client.waitForHello();
```

- `async command<T>(body: DaemonCommandBody, timeoutMs = 15_000): Promise<T>` — wraps
  `client.request`, throws a descriptive Error on `success: false` that includes `command`,
  `error`, and `errorInfo.code` verbatim (tool handlers surface it as MCP tool error text).
- `hello` accessor for `status` to report daemon version/schemaId (and note skew vs own `VERSION`).
- Session selectors: **pass through raw**. Every per-session command's `activeSessionId` field
  already accepts exact activeSessionId, sessionId, sessionName, or id-suffix server-side
  (supervisor `findWorker`/`matchWorkers`), erroring with `Ambiguous active session` /
  `Unknown active session`. Do NOT build client-side resolution for live sessions. For
  `resume_session` only, pass the selector as `create.sessionPath` (daemon resolves live-first,
  then catalog by id-prefix/name; file paths detected via `looksLikeSessionPath` semantics).
- On `session_already_active` errorInfo: not an error for our tools — return the live
  `activeSessionId` it carries as a successful resume result.
- Do not send `attach`, client env, or advertise `extension_ui` anywhere. Read getters only.

### 2.2 `render.ts`

Pure functions, no I/O — this is the unit-testable core.

**State derivation** (`deriveSessionState(s: SessionSummary, now: number)`):

| Derived state | Rule (first match wins) |
|---|---|
| `inactive` | `lifecycle !== "live"` or no `workerState` (saved-only row) |
| `worker_failed` | `workerState === "failed"` or `"recovering"` |
| `working` | `activity === "working"` or `isStreaming` or `isRunningTools` or `isBashRunning` or `hasRunningRlmChildren` |
| `waiting_on_user` | idle and `taskState === "needs_input"` |
| `stalled` | idle root session (`rlmDepth` 0 or absent), no `taskState`, `lastActivityAt` older than 30 min |
| `idle` | everything else live |

Corrections made during M1 against the live fleet, approved 2026-08-25:
- Liveness is `workerState`, not `activeSessionId`. The supervisor stamps `workerState` on every
  summary it publishes from a live worker (`publicSummary`) and `summaryForInactiveSession` never
  sets it. RLM child sessions are live but carry no `activeSessionId` of their own (48 of 96 rows on
  this machine), so that field cannot stand in for liveness.
- A session selector is `activeSessionId ?? id`, matching `matchWorkers` / `findSummaryInWorker`.
- An RLM child (`rlmDepth > 0`) never classifies `stalled`; it falls through to `idle`. A child
  answers its parent and never owns a user verdict.

Always emit raw evidence next to the verdict: `minutes_since_activity`, `workerState`,
`attachedClients`, `isStreaming/isRunningTools/isBashRunning`, child count. The LLM recap
(`summary`, `taskState`) is included but labeled `recap` — heuristic garnish, never the sole basis
(usage evidence: Amir explicitly distrusts self-reported status).

**Renderers:**
- `renderFleetStatus(sessions, hello, hostname)` — sorted needs-attention-first
  (worker_failed, waiting_on_user, stalled, working, idle, inactive), one line per session:
  `[state] name (cwd-basename) model · 12m ago · 2 children · ♥ · "recap…"`. For `waiting_on_user`
  sessions append a `Q:` line with the last-assistant-text tail (~200 chars) — this is the
  pending-question surfacing. Header line: hostname, daemon appVersion/protocol, session counts.
- `renderMessage(m: AgentMessage, caps)` — copy the exhaustive role switch from
  `messageText()` in `src/core/agent-observe.ts` L146 (handles user/assistant/toolResult/
  bashExecution/custom/branchSummary/compactionSummary; content blocks text/thinking/image/toolCall).
  Compact form: role tag + text; toolCalls as `-> toolName(args…120ch)`; images as `[image]`.
- `renderTranscript(messages, {maxChars, page})` — newest-last window with explicit
  `[truncated: showing messages N-M of T]` marker.
- All output char-capped: status row ~200 chars/session; transcript default 4,000 chars/page.

### 2.3 `tools.ts` — the nine tools

Register on an `McpServer` (SDK `server/mcp.js`). Every tool returns
`{ content: [{ type: "text", text }], structuredContent }` — text first (phone-readable), JSON for
programmatic clients. Every handler catches daemon errors and returns them as `isError: true` tool
results with the daemon's message verbatim (never a thrown 500).

Common param: `session: string` — "activeSessionId | sessionId | id-suffix | session name"
(passed through; see §2.1).

| Tool | Input schema (zod) | Daemon commands | Output (structured) |
|---|---|---|---|
| `status` | `{ all?: boolean, include_children?: boolean, max_rows?: number }` (defaults: false, false, 30) | `list {all}`; for each `waiting_on_user` session `get_last_assistant_text` (parallel, best-effort, 5s timeout each) | `{ host, daemon: {version, protocol, schemaId, skew}, sessions: DerivedSession[], counts, totals }` |
| `session_detail` | `{ session: string }` | `get_state`, `get_session_stats`, `get_queue`, `get_rlm_children`, `get_last_assistant_text`, `heartbeats_list {activeSessionId}` | full detail incl. pending question (untruncated last assistant text up to 2,000 chars), queued messages, children, heartbeats, token/cost stats |
| `transcript` | `{ session: string, max_chars?: number (default 4000), before?: number }` | `get_messages` | rendered window + paging cursor (`before` = message index) |
| `send` | `{ sessions: string[], message: string, mode?: "auto"\|"steer"\|"follow_up" (default auto) }` | per session: mode auto -> `prompt {message, queueIfBusy: true}`; steer -> `steer {message}`; follow_up -> `follow_up {message}` | per-session `{ session, delivered: "accepted"\|"queued"\|"error", error? }` |
| `interrupt` | `{ session: string, what?: "turn"\|"bash"\|"compaction" (default turn) }` | `abort` / `abort_bash` / `abort_compaction` | ack |
| `start_session` | `{ cwd: string, prompt: string, name?: string, model?: string }` | `create {config:{cwd, model?}, name?}` then `prompt {activeSessionId, message, queueIfBusy: true}` | new session's SessionSummary essentials |
| `resume_session` | `{ session: string, message?: string }` | `create {sessionPath: selector}`; treat `session_already_active` as success; optional follow-up `prompt` | live session essentials + `was_already_active` |
| `restart_session` | `{ session: string, recovery_message?: string }` | `get_state`; if `workerState === "failed"` -> `retry_worker`; else `kill` then `create {sessionPath: <sessionFile from state>}`; then optional `prompt` with recovery_message | old/new activeSessionId + what path was taken |
| `kill_session` | `{ session: string }` | `kill` | ack (notes the session file remains resumable) |

`status` payload rules (approved 2026-08-25, after the M1 fleet measurement showed 96 rows / ~15 KB):
- `include_children: false` (default) hides `rlmDepth > 0` rows. Child counts are computed BEFORE
  filtering, so a parent still reports `N children`.
- `max_rows` (default 30) applies AFTER the needs-attention sort. Suppressed rows collapse into one
  trailing line, `+N more: x working, y idle, z inactive`; `structuredContent` carries the full counts.
- `all: true` adds saved rows, capped at the 20 most recently modified; the header reports the total
  saved count. Live rows are never capped by that rule.

Notes:
- `send.sessions` as an array IS the broadcast/recover-all feature. Report per-session outcomes;
  one failure must not abort the rest.
- `prompt` success = **admission**, not completion (protocol fact). `send`'s text output must say
  "delivered/queued — poll status for progress", so remote clients aren't misled.
- `queueIfBusy` defaults to false for plain prompts — always pass `true` explicitly.
- `restart_session` must read `get_state` FIRST and capture `sessionFile` before `kill` (the row
  disappears from the live list after kill).
- `execute`-style long ops: per-call `timeoutMs` on `DaemonBridge.command` — 15s default,
  30s for `create` (worker spawn), 10s for getters.

### 2.4 `mcp-serve-mode.ts`

```
export async function runMcpServe(options: { port: number; bind: string; stdio: boolean; daemonSocket?: string }): Promise<void>
```

- Build one `DaemonBridge`; fail fast with a clear message if the daemon can't be reached/started.
- **HTTP (default):** `node:http` server on `bind:port`, path `/mcp` — no Express.
  Stateless Streamable HTTP per SDK docs: for each POST, construct a fresh `McpServer` (cheap: tool
  registration closures over the shared bridge) + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`,
  `await server.connect(transport)`, `await transport.handleRequest(req, res, parsedBody)`, and clean
  both up on `res.close`. GET/DELETE to `/mcp` return 405 (stateless mode has no SSE stream / no
  session to delete). Anything else: 404. No auth, no TLS, no origin checks — tailnet-trusted by
  explicit decision.
- **`--stdio`:** same tool registry, one `McpServer` + `StdioServerTransport`. All logging to stderr
  only (stdout is the protocol channel).
- Server identity: name `prime-agent`, version = package `VERSION`; instructions string mentions the
  machine hostname so multi-connector clients can tell servers apart.
- Lifecycle: SIGINT/SIGTERM -> close HTTP server + `client.close()` -> exit 0. Startup prints one
  line: `mcp-serve listening on http://<bind>:<port>/mcp (daemon: <socketPath>, <appVersion>)`.

### 2.5 CLI wiring

- `command-registry.ts`: `{ path: ["mcp-serve"], usage: "mcp-serve [--port <n>] [--bind <addr>] [--stdio] [--daemon-socket <path>]", summary: "Serve MCP remote-control for this machine's prime agent sessions" }` (match existing CommandSpec shape exactly).
- `public-command.ts`: `case "mcp-serve"` in `runPublicCommand` — verb-local flag loop (copy the
  `parseDaemonClientCommand` style): `--port` int (default 7717), `--bind` string (default
  `0.0.0.0`), `--stdio` boolean, `--socket|--daemon-socket` normalized. Then
  `await runMcpServe(...)` (top-level static import per AGENTS.md) — the promise intentionally
  never resolves while serving; return `HANDLED`.

---

## 3. Milestones

Sequential, one implementer, commit + report after each. Estimates are working-time, not deadlines.

### M0 — Baseline (30 min)
`npm install`, add SDK dep, `npm run check` green BEFORE changes. Commit lockfile/package.json.
**Accept:** check green; `npx tsx src/cli.ts status` works in the worktree (proves toolchain).

### M1 — Vertical slice: `status` end-to-end (0.5 day)
CLI verb + `runMcpServe` HTTP transport + `DaemonBridge` + `render.ts` state derivation + `status`
tool only.
**Accept:** with a live daemon on this machine, an MCP SDK client (`StreamableHTTPClientTransport`)
against `http://127.0.0.1:7717/mcp` lists tools and calls `status`; output shows real sessions with
derived states; `npm run check` green. Include the client snippet used in the milestone report.

### M2 — Read tools (0.5 day)
`session_detail`, `transcript`; full `renderMessage` (all 7 roles); paging.
**Accept:** transcript of a real long session renders bounded and legible; unit test
`mcp-serve-render.test.ts` covers state derivation table (each rule + precedence) and message
rendering per role, run green.

### M3 — Control tools (0.5-1 day)
`send` (3 modes + multi-session), `interrupt`, `start_session`, `resume_session`,
`restart_session`, `kill_session`.
**Accept:** manual sequence against a throwaway daemon socket (NOT the default socket — do not
disturb live sessions): start_session -> send -> transcript shows the reply (faux/offline daemon
acceptable: `--offline` + `PI_OFFLINE=1` env as in `daemon-supervisor-process.test.ts`) -> interrupt
-> restart_session -> kill_session. `npm run check` green.

### M4 — E2E suite test + hardening (0.5 day)
`test/mcp-serve-e2e.test.ts` modeled on `test/daemon-supervisor-process.test.ts`: spawn a real
daemon on a unique tmp socket (tsx, `--mode daemon --daemon-socket <tmp> --offline`, `PI_OFFLINE:
"1"`, isolated `ENV_AGENT_DIR` temp dir), start mcp-serve in-process on an ephemeral port pointing
at that socket, drive it with the real MCP SDK HTTP client:
`tools/list -> status (empty) -> start_session -> status (1 session) -> send -> transcript ->
interrupt -> kill_session -> status`. Teardown: shutdown command + SIGTERM, per the existing pattern.
**Accept:** e2e + render tests green via the per-file vitest command; `npm run check` green; daemon
churn behavior manually proven once: kill the daemon while mcp-serve is up -> next `status` call
recovers (auto-reconnect + ensure) and reports rather than crashing.

### M5 — Phase 2 tools + deploy assets (only after M1-M4 review passes)
`heartbeats` (`heartbeats_list` fleet-wide / `heartbeat_manage` pause|resume|stop),
`ask_session` (`start_side_question` + `onMessage` wait for terminal `side_question_event`, 120s cap),
`run_bash` (`execute_bash_and_wait`, 120s default cap, `transient` param), plus
`scripts/install-mcp-serve.sh` (launchd plist, KeepAlive, port 7717, logs to
`~/.prime/agent/logs/mcp-serve.log`).
**Accept:** heartbeat list shows real fleet data; ask_session answers on a live session without
touching its transcript (verify message count unchanged); install script idempotent
(install/uninstall) and reviewed but NOT deployed to other machines yet (rollout is a separate,
explicitly-approved step).

---

## 4. Testing policy

- **Unit (`mcp-serve-render.test.ts`):** pure-function tests for every row of the state-derivation
  table (including precedence: failed beats working beats waiting_on_user), staleness boundary
  (30 min), char caps/truncation markers, and one render case per message role. No processes.
- **E2E (`mcp-serve-e2e.test.ts`):** the single honest integration path (M4). The real daemon is the
  fixture — no mocks of the daemon protocol. Keep it under ~60s wall clock. If it needs the
  `test:process`-style exclusion from `test:ci` (like `daemon-supervisor-process.test.ts`), follow
  that existing convention rather than inventing a new lane.
- **What we deliberately do NOT test:** MCP SDK internals, HTTP edge cases, concurrent-client
  fuzzing, reconnect race matrices. One manual daemon-restart check in M4 covers churn. This is a
  single-user tailnet tool; the e2e path plus render units is the whole regression net.
- Run commands (from `packages/coding-agent`):
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-render.test.ts`
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp-serve-e2e.test.ts`

## 5. Manual acceptance (Amir-facing, after M4)

1. On this machine: `npx tsx src/cli.ts mcp-serve` against the REAL default daemon socket;
   `status` from an MCP client shows the live fleet with sane derived states.
2. From a second tailnet machine: connect an MCP client to `http://<this-host>:7717/mcp`,
   run `status`, `send` a nudge to a real (sacrificial) session, watch it react, `transcript` it.
3. Claude Desktop (or preferred client) connector configured against one machine; the "how's
   everything going?" question answered by `status` in one call, glanceable on a phone-sized pane.

## 6. Execution & oversight protocol

- **Implementer:** one Opus 5 child (`anthropic/claude-opus-5`) working in the worktree,
  milestones strictly in order, commit per milestone (`git add` only its own files; never
  `git add -A` — docs live alongside), then message the parent:
  milestone id, what was done, commands run + results (verbatim tails), files touched, open
  questions. Blockers -> stop and report; no design changes without approval (esp. Ground rule 2).
- **Overseer (parent):** after each milestone report — read the full diff (`git diff HEAD~1`),
  check it against this plan + AGENTS.md style rules, run `npm run check` and the milestone's tests
  independently, and only then green-light the next milestone. After M4: independent fresh Opus 5
  code review (cynical pass: correctness of daemon command usage vs RESEARCH_APIS, error paths,
  payload caps, no protocol drift), plus the §5 manual acceptance.
- **Done =** M1-M4 accepted + §5 passed + review findings resolved + PR opened (not merged) with
  the plan docs linked. Merge waits for Amir's explicit approval of the exact PR.

## 7. Known landmines (read before coding)

1. `queueIfBusy` defaults FALSE for plain `prompt` — always pass `true` or busy sessions error.
2. `prompt` success = admission, not completion. Never block a tool call on turn completion.
3. `restart_session`: capture `sessionFile` via `get_state` BEFORE `kill`.
4. `session_already_active` is a SUCCESS path for resume (errorInfo carries the live id).
5. Never `attach`, never send client env, never advertise `extension_ui` — read getters only;
   otherwise you can steal dialog ownership from the TUI or bind identity onto cron sessions.
6. `daemon_closing {reason:"update"}` / socket loss ≠ sessions dead. Auto-reconnect handles it;
   tools retry once after reconnect, then surface a clean "daemon unreachable" error.
7. Never spawn a daemon yourself — only `ensureInteractiveDaemonRunning` (launch-lease elects one).
8. stdout discipline in `--stdio` mode: all logs to stderr.
9. E2E tests: unique tmp socket per test + shutdown in afterEach/finally — leaked daemons pollute
   the machine (the existing process test shows the exact pattern).
10. Biome enforces tab indentation + organized imports; let `npm run check --write` fix formatting
    rather than fighting it.
