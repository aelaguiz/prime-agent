# Prime Agent Remote Control MCP — Plan (2026-08-25)

**Goal:** From any MCP client on the tailnet, see and drive every prime agent session on each of
Amir's machines: fleet status ("how's everything going?"), per-session inspection, message
injection/steering, interrupting, starting/resuming/restarting/killing sessions, and taking work over.

**Non-goals (explicit):** auth, TLS, public exposure, multi-tenant anything, a web dashboard,
push notifications, a cross-machine aggregator service.

**Research grounding (same dir):**
- `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25_RESEARCH_DAEMON.md` — full daemon architecture inventory (549 lines, from source).
- `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25_RESEARCH_USAGE.md` — mined usage patterns from 728 real session transcripts.
- Repo: `/Users/aelaguiz/workspace/prime-agent` (fork of PrimeIntellect-ai/prime-agent, v0.8.0 base).

---

## 1. The startup-pragmatism frame (read this first)

This plan was deliberately shrunk. The design leans on one decisive fact: **the fork's daemon
already exposes everything needed** — 91 commands over a Unix socket (`prime-agent.daemon` protocol
v7 / schema 23), including session listing with LLM-generated status recaps, message injection,
steering, abort, create/resume/kill, bash execution, and heartbeat management. The protocol header
comment even anticipates this exact work: *"a future gateway can wrap or proxy this local transport."*

So the whole feature is: **one thin translator process per machine** — MCP Streamable HTTP on one
side, existing daemon Unix socket on the other. Zero daemon-side changes. Zero new protocol.

### Decisions made now (all two-way doors)

| Decision | Choice | Why |
|---|---|---|
| Where it lives | New `packages/coding-agent/src/modes/mcp-serve/` + `pi mcp-serve` CLI verb | Ships inside the fork; versions in lockstep with the daemon it talks to |
| Transport | MCP Streamable HTTP, stateless mode, path `/mcp`, default port `7717`, bind `0.0.0.0` | Max client compatibility (Claude Desktop/Code, mcp_bridge, Cursor, anything current); tailnet is the security boundary |
| Auth | None | Tailnet-only by explicit user decision |
| Fleet model | One server per machine; consumer configures N connectors (`http://<tailscale-name>:7717/mcp`) | Deletes an entire aggregator service; "which machine" becomes client-side naming |
| Read model | Poll-based request/response tools only | Most MCP clients handle plain tools well and streaming/notifications poorly |
| Daemon access | Stateless `DaemonClient` request/response using read-only getters (`list`, `get_messages`, `get_last_assistant_text`, `get_state`, ...) | **Avoids the entire attach/snapshot/replay/cursor/extension-UI machinery** (worker1 gotchas 4-8). No event mirroring state to maintain |
| Turn completion | `prompt` (admission ack) + client polls `status` | Remote MCP clients must not hold multi-minute requests |
| Daemon discovery | Default socket only (`$TMPDIR/prime-agent-<uid>/daemon.sock`) | That is where all real sessions live today; `daemon ps`-style multi-socket discovery is deferred until a real non-default-socket use appears |

### Cut list (not built, on purpose)

- Auth/OAuth/TLS/rate limiting/audit logging — tailnet boundary, single user.
- Cross-machine aggregator or registry — per-machine servers + client-side naming.
- Live event streaming, MCP resources/subscriptions, push notifications — polling tools.
- Persistent session attach + event cursor tracking — read getters are sufficient.
- Extension-UI dialog handling — we never attach, so TUI/dialog ownership is untouched.
- New daemon commands or protocol capabilities — v1 needs none.
- Web dashboard — his MCP clients are the dashboard.
- Multi-daemon socket discovery — deferred, YAGNI until observed.

---

## 2. Grounding facts the design respects (from daemon source research)

Condensed from `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25_RESEARCH_DAEMON.md`; that file has file paths and line refs.

1. **Topology:** one supervisor daemon per machine on a 0600 Unix socket
   (`$TMPDIR/prime-agent-<uid>/daemon.sock`), one worker process per root session (RLM children live
   inside the parent's worker), a catalog child for disk scans. The TUI is just another client.
2. **`list` already answers "how's everything going".** `SessionSummary` carries: name, cwd, model,
   `activity: working|idle`, `isStreaming/isCompacting/isBashRunning/isRunningTools`,
   `hasRunningRlmChildren`, `lastActivityAt`, `attachedClients`, parent/child linkage, worker state
   (`starting|ready|recovering|stopping|failed`), plus a daemon-side LLM summarizer (qwen3-30b via
   prime-inference, 25s sweep) that produces a <=12-word `summary` recap and a
   `taskState: completed|needs_input` verdict. The MCP server mostly reformats this.
3. **All control ops exist as daemon commands:** `prompt` (with `queueIfBusy`), `steer` (interrupt
   the streaming turn with a new instruction), `follow_up` (queue for after the turn), `abort`,
   `abort_bash`, `create` (new session or resume via `sessionPath`), `kill`, `retry_worker`,
   `execute_bash_and_wait`, `get_queue`/`clear_queue`, `cancel_rlm_child`, heartbeat/cron CRUD,
   `start_side_question` (ask the session's model off-transcript without touching the session),
   `send_message` (agent-to-agent inbox delivery), `compact`, `set_model`.
4. **Read getters need no attach:** `get_messages`, `get_last_assistant_text`, `get_state`,
   `get_session_stats`, `get_session_header` are plain request/response — a stateless client can
   read any session's transcript without subscribing to event streams.
5. **Two id namespaces:** durable `sessionId` (uuidv7 = `~/.prime/agent/sessions/<id>.jsonl` filename)
   vs ephemeral `activeSessionId` (live worker binding; changes across eviction/resume). Tools accept
   either and resolve: control needs `activeSessionId`; resume needs the session file. Idle workers
   get evicted, so an "inactive" session is normal and resumable (`create {sessionPath}`);
   `session_already_active` errors carry the live id to use instead.
6. **Multiple clients per session are first-class.** No takeover lock exists; TUI + MCP + agents-view
   can all inject into one session, interleaved through the admission queue. "Taking over" is
   therefore just: interrupt + send message (optionally from the phone while the desk TUI stays open).
7. **Version skew is handled by construction:** the MCP server ships in the same package as the
   daemon and checks `daemon_hello` (protocol 7, schemaId) on connect; a mismatch is reported in
   `status` output rather than hidden. `DaemonClient` provides auto-reconnect and mutation idempotency
   (`enableRequestRecovery` + command journal + `ack_result`) for free — reuse, don't reimplement.
8. **Prompt semantics:** `prompt` acks *admission*, not completion. A busy session queues it
   (`queueIfBusy`). This matches remote use: fire the message, poll `status`.
9. **No HTTP/TCP surface exists anywhere in the repo today**, and no MCP server code — only
   client-side MCP (`core/mcp/`, `packages/ai/src/mcp/`). This is new but small code.
10. **Daemon self-update churn is normal** (`daemon_closing {reason:"update"}`): sessions restore
    from a manifest after restart. The MCP server must simply reconnect-and-retry, never declare
    sessions dead on socket loss.

---

## 3. Architecture

```
[Claude Desktop / Claude mobile via desktop / Claude Code / another prime session via mcp_bridge]
        |  MCP over Streamable HTTP  (tailnet, no auth)
        v
 http://amirs-mac-studio:7717/mcp     http://m3:7717/mcp      http://<machine3>:7717/mcp
        |                                   |                        |
   pi mcp-serve                        pi mcp-serve             pi mcp-serve
        |  DaemonClient (JSONL over unix socket, existing protocol v7)
        v
   daemon supervisor  ->  session workers (all live sessions, incl. RLM children)
```

- **Process:** `pi mcp-serve [--port 7717] [--bind 0.0.0.0] [--daemon-socket <path>]`.
  Single Node process. On each MCP tool call it ensures a connected `DaemonClient` (auto-reconnect,
  lazily launches the daemon via the existing `ensureInteractiveDaemonRunning` path if none is
  running) and translates one tool call -> one-or-few daemon commands -> compact JSON + text result.
- **Statelessness:** no per-session attach, no event cursors, no in-memory session mirror. The only
  state is the socket connection and a tiny cache of the last `list` result (optional, can be none).
- **Output shape:** every tool returns a short human-readable text block first (MCP clients render
  text well, and Amir reads these on a phone) plus a `structuredContent` JSON payload for
  programmatic consumers. Transcript-ish payloads are char-bounded with explicit truncation markers.
- **Errors:** daemon errors pass through verbatim with the failed command name. Socket-down =>
  one retry after reconnect, then a clear "daemon unreachable on <socket>" tool error.

---

## 4. What you actually do (mined from 728 transcripts; 506 messages across 55 sessions sampled)

Full data: `PRIME_MCP_REMOTE_CONTROL_PLAN_2026-08-25_RESEARCH_USAGE.md`. The load-bearing findings:

- **You run a fleet, not a chat.** 10-30 concurrent sessions/day, median session ~16h wall-clock,
  33% run >24h, round-robined by hand. "wya" was pasted into 3 sessions within 4 minutes. The MCP's
  core product is the fleet table, not any single session view.
- **Message categories:** ~56% mid-thread work direction; 7% pasted external (GPT-Pro) review
  verdicts; 5% status pings ("where we at", "wya", "still going?", "you stuck?"); 5% blunt steering
  corrections; 4% merge/CI coordination ("merged 33 you do 23"); 4% "ramp up on <issue/PR/old
  thread id>" kickoffs; 3% one-word nudges ("continue", "go"); 2% rate-limit resumes ("we got rate
  limited pick it back up" — 11 in sample, near-daily).
- **Stalls are the #1 pain.** 20/51 sessions show a >8h gap then a manual nudge. Common causes you
  diagnose by hand today: provider rate limits, frozen IPython kernel, daemon restarts, foreground
  lockups. After a daemon restart you bulk-paste a canned recovery prompt to several sessions at once.
- **Pending questions get lost.** Agents block on a question you never saw; verbatim pain: "What's
  the question? This is a wall of text. Just tell me what the question is."
- **Takeover pattern exists already:** start a fresh session with "ramp up on prime agent thread
  <old-id>, figure out where it was" (8 occurrences). Takeover = new session + reference, not some
  special session-transfer mechanism. The MCP needs zero takeover machinery beyond start+send.
- **You distrust self-reported status:** "it may be lying don't trust just a cursory look",
  "Don't just check your status." The status tool must lead with *evidence* (real event timestamps,
  tool activity, worker state), with the LLM recap as a garnish only.
- **Heartbeats are your anti-stall insurance** (37% of sessions) and they accumulate cruft
  ("clear out the 20 paused heartbeats") — fleet-wide heartbeat listing/GC is currently impossible.
- **Three machines on the tailnet:** `amirs-mac-studio` (agents user), `amirs-m3-max-new`,
  `amirs-m3-36gb`. Sessions are local to each machine's `~/.prime`; cross-machine reach today is
  manual ssh. Per-machine MCP servers + three connectors fits this exactly.

---

## 5. Tool surface

Design rules: every tool takes an optional `session` selector (activeSessionId | sessionId prefix |
session name — resolved via `list`/catalog); every response leads with compact human-readable text
(phone-readable), then `structuredContent` JSON. All payloads char-capped with truncation markers.

### Phase 1 — the nine tools that cover ~90% of observed behavior

| # | Tool | Covers (usage rank) | Daemon commands used |
|---|------|--------------------|----------------------|
| 1 | `status` | Fleet poll "how's everything going?" (#1), stall detection (#3, #12), pending questions (#4) | `list {all:false}` (+ optional `get_last_assistant_text` per idle session) |
| 2 | `session_detail` | Drill into one session; "what's the question?"; artifact paths | `get_session_header`, `get_state`, `get_messages` (tail), `get_queue`, `get_rlm_children`, `heartbeat_get` |
| 3 | `transcript` | Reading recent output; forensics on wandering sessions | `get_messages` (bounded window, compact rendering) |
| 4 | `send` | Free-text steer (#2), nudge/continue (#3), approvals (#4), review paste (#7), merge notify (#9), bulk recovery (#6 — accepts a list of sessions) | `prompt {queueIfBusy}` / `steer` / `follow_up` per `mode` param (`auto`\|`steer`\|`follow_up`) |
| 5 | `interrupt` | Hard stop, scope abort (#11) | `abort` (+ `abort_bash`/`abort_compaction` via `what` param) |
| 6 | `start_session` | "Ramp up on X" kickoff + takeover-by-reference (#5) | `create {config:{cwd,...}, name?}` then `prompt` |
| 7 | `resume_session` | Reviving evicted/old sessions by id/name | `create {sessionPath}`; on `session_already_active` returns the live session instead |
| 8 | `restart_session` | Wedged worker / frozen kernel / "I had to restart prime agent" (#12) | `retry_worker` if workerState=failed, else `kill` + `create {sessionPath}` (+ optional recovery prompt) |
| 9 | `kill_session` | Killing runaway/done sessions | `kill` |

Notes:
- `status` is **evidence-first**: per session it reports name, cwd, model, machine hostname,
  `working|waiting_on_user|stalled|worker_failed|inactive` (derived from `activity`, `isStreaming`,
  `isRunningTools`, `hasRunningRlmChildren`, `workerState`, `lastActivityAt` staleness), minutes
  since last activity, attached client count, RLM child count, heartbeat presence, then the LLM
  recap (`summary`/`taskState`) clearly labeled as heuristic, and for `waiting_on_user` sessions a
  one-line tail of the last assistant message (the pending question). Sorted: needs-attention first.
- `send` with a list of session ids IS the broadcast/recover-all feature (a for-loop, not a feature).
- Review-paste, merge-notify, canned recovery, "ramp up" templates: all just `send`/`start_session`
  text composed client-side. **No template registry, no special tools.**
- Takeover = `interrupt` + `send`, or `start_session` referencing the old thread. No lock machinery;
  the daemon already supports concurrent clients per session.

### Phase 2 — three tools that earn their keep from the evidence

| Tool | Covers | Daemon commands |
|---|---|---|
| `heartbeats` | Fleet-wide heartbeat list + pause/resume/clear GC ("20 paused heartbeats") (#8) | `heartbeats_list`, `heartbeat_manage`, `heartbeat_get`/`heartbeat_set` |
| `ask_session` | Ask a session's model "where were we / what do you need?" **without touching its transcript** — status-skepticism answered off-band | `start_side_question` |
| `run_bash` | Evidence gathering in a session's worker (git status, log tails) — "go look and make sure you're actually doing something" | `execute_bash_and_wait` (or `transient:true` to stay out of context) |

### Explicitly not built (and why that's safe)

- **Rate-limit auto-resume**: heartbeats already cover it ("just try again on a heartbeat"); if it
  still hurts after MCP ships, it's a daemon feature, not an MCP feature. Noted, not built.
- **Pending-question extraction NLP**: last-assistant-text tail + `taskState` is 90% of the value.
- **PR/CI status, merge webhooks, collision detection**: `status` shows cwd + session names; GitHub
  state lives in GitHub clients he already has. `send` covers "37 is merged".
- **Artifact registry / cf-share integration**: `transcript` + `run_bash` retrieve any path on demand.
- **Push notifications**: consumer-side polling ("how's everything going" is a pull question). If
  push is ever wanted, it's a separate tiny notifier, not MCP surface.
---

## 6. Implementation plan

### New code (all additive; no daemon/protocol changes)

```
packages/coding-agent/src/modes/mcp-serve/
  mcp-serve-mode.ts        # entry: parse flags, start HTTP listener (or stdio), wire tools
  daemon-bridge.ts         # DaemonClient lifecycle: connect, hello/version check,
                           #   enableRequestRecovery + enableAutoReconnect, lazy daemon launch
                           #   (reuse ensureInteractiveDaemonRunning), session-selector resolution
  tools.ts                 # the 9 (then 12) tool definitions: zod schemas + handlers
  render.ts                # SessionSummary/AgentMessage -> compact text + JSON (char caps,
                           #   staleness derivation, needs-attention sort)
packages/coding-agent/src/cli/   # register `mcp-serve` verb (follow daemon-launch.ts pattern)
scripts/install-mcp-serve.sh     # launchd plist install (label works.earendil.pi-mcp, KeepAlive,
                                 #   port 7717), mirroring existing install script conventions
```

- Dependency: `@modelcontextprotocol/sdk` (official TS SDK; server + `StreamableHTTPServerTransport`
  in stateless mode). Respect the repo's 7-day `min-release-age` rule when installing.
- `--stdio` flag: same tool registry over stdio transport, nearly free with the SDK. Gives an
  escape hatch for stdio-only clients (`ssh <machine> pi mcp-serve --stdio` even works remotely).
- Estimated size: ~700-900 lines total. The hard 20% is `render.ts` (making `status` genuinely
  phone-glanceable) and selector resolution in `daemon-bridge.ts`.

### Behavior details that matter

1. **Session selector resolution**: accept activeSessionId, sessionId (or unique prefix), or
   session name. Resolve against `list {all:true}`; ambiguous -> error listing candidates. Control
   commands use the resolved `activeSessionId`; if the session is inactive, tools that need a live
   worker either auto-resume (`resume_session` semantics, only for `send` with `revive:true`) or
   return "inactive — use resume_session".
2. **`send` mode=auto**: if session streaming -> `prompt {queueIfBusy:true, streamingBehavior:
   "followUp"}` (delivered after turn); explicit `steer` interrupts the turn now; explicit
   `follow_up` always queues. Response reports admission ("delivered" vs "queued behind N").
3. **Timeouts**: per-tool-call daemon request timeout ~15s except `execute_bash_and_wait` (120s cap,
   configurable per call). Never expose `prompt_and_wait` (remote clients must not hold turns open).
4. **Daemon churn**: on `daemon_closing`/socket loss, reconnect with backoff and retry the command
   once; `DaemonClient` request recovery + `ack_result` journaling handles mutation idempotency.
   Never treat `reason:"update"` as sessions-dead. Never spawn a competing daemon (launch-lease path
   already guarantees this).
5. **Do not attach**: never send `attach`; never advertise `extension_ui` (avoids stealing dialog
   ownership from the TUI); never send client env. Read getters + control commands only.
6. **Summarizer absence tolerated**: if `summary`/`taskState` are missing (no prime-inference auth),
   `status` still works from raw activity fields.

### Tests (deliberately small)

One suite test file under `packages/coding-agent/test/suite/` using the existing harness + faux
provider: boot a daemon on a temp socket, start mcp-serve on an ephemeral port, drive it with the
MCP SDK client: `status` -> `start_session` -> `send` -> `transcript` -> `interrupt` ->
`kill_session`. That single end-to-end path is the whole regression net. No mocks of the daemon
protocol (the real daemon is the cheap, honest fixture). Per repo rules the test must be run and
green before commit; `npm run check` clean.

### Phases

| Phase | Content | Estimate |
|---|---|---|
| 1 | 9 tools, Streamable HTTP + `--stdio`, selector resolution, e2e suite test, manual `pi mcp-serve` run proven from a second machine over tailnet | 1-2 days |
| 2 | `heartbeats`, `ask_session`, `run_bash`; launchd install script; rollout to all 3 machines via `$amir-publish` flow; connector setup on your actual clients | ~1 day |
| 3 (only if wanted after real use) | candidates observed but deferred: rate-limit auto-resume, push notifier, `daemon ps` multi-socket discovery, cross-machine status aggregation tool | not scheduled |

---

## 7. Deployment & client compatibility

### Server side
- Each machine: `pi mcp-serve` under launchd (KeepAlive), port **7717**, bind `0.0.0.0`, no auth.
  Tailnet + machine-local firewall is the entire security story, per explicit decision.
- Endpoints: `http://amirs-mac-studio:7717/mcp`, `http://amirs-m3-max-new:7717/mcp`,
  `http://amirs-m3-36gb:7717/mcp`. Connector display names carry the machine ("prime-studio",
  "prime-m3max", "prime-m336") so tools are attributable at a glance; `status` also embeds hostname.

### What can consume it (honest compatibility map)
- **Works out of the box (runs on a tailnet device):** Claude Desktop / Claude Code / codex CLI /
  Cursor / any local MCP client on your Macs; your own prime agent sessions via `mcp_bridge`
  (cross-machine fleet queries from inside a session become possible — nice side effect);
  on-device iOS/Android MCP clients while the Tailscale VPN is up.
- **Does NOT reach it:** cloud-executed connectors — claude.ai web/mobile connectors and ChatGPT
  connectors run from the vendor's cloud, not your device, so a tailnet-only URL is invisible to
  them. If you ever want claude.ai-on-phone access, the one-liner escape hatch is
  `tailscale funnel 7717` (makes it public+unauthenticated — your call, later, explicitly out of
  scope now).

---

## 8. Risks & rigor still owed

- **Genuinely destructive ops are shallow**: sessions are durable JSONL on disk; `kill_session` is
  resumable, `clear`-type ops are not exposed in v1. No one-way doors in the tool surface. The
  sharpest tool is `send` itself (a remote message can direct an agent to do anything an agent can
  do) — which is the entire point, and the sender is you.
- **Rigor owed — the e2e test path**: prompt admission, selector ambiguity, and daemon-churn
  reconnect are the three spots where silent wrongness would cost real work; the single suite test
  covers the first two, and reconnect gets a manual daemon-restart-while-connected check during
  Phase 1 (not an automated harness).
- **Upstream merge risk**: all code is additive (new mode dir + one CLI verb + one dependency);
  conflict surface with upstream 0.8.x merges is near zero.
- **Version skew**: mcp-serve and daemon ship from the same install; after self-update the daemon
  and a still-running old mcp-serve could briefly disagree — hello schemaId check surfaces this in
  `status` ("daemon vX / mcp vY — restart mcp-serve") instead of failing silently. launchd restart
  covers it in practice.
- **Open port on the tailnet**: any tailnet device (and any process on your own machines) can drive
  your agents unauthenticated. Accepted explicitly. Revisit only if the tailnet ever grows
  teammates/devices you don't fully trust.

## 9. Decided defaults (change at review if you care)

1. Port **7717**, path `/mcp`, bind `0.0.0.0`. 2. Tool names as in §5 (`status`, `send`, ...).
3. Server name = `prime-agent@<hostname>`. 4. Phase 1 excludes heartbeat tools (Phase 2). 5. Char
caps: status row ~200 chars/session; transcript default 4,000 chars/page. 6. New code lives in
`packages/coding-agent` (not a new package). 7. No goal-skill integration (goals are driven by
`send`, same as in person).

**Recommendation:** approve Phase 1 as scoped; it ships in 1-2 days and every later idea gets
cheaper to judge once the fleet table is on your phone.
