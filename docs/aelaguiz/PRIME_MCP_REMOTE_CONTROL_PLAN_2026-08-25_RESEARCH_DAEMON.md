# Prime Agent Daemon / Session-Control Architecture — Research Inventory

Source repo: /Users/aelaguiz/workspace/prime-agent (read-only research)
Written incrementally by worker1. Sections appended as completed.

## 1. Daemon topology

Three process roles, all launched from the same CLI binary (role selected via env vars / `--mode daemon`):

1. **Supervisor** — `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts` (`class DaemonSupervisor`, ~6000 lines).
   The public daemon. Listens on a Unix domain socket, speaks the JSONL `prime-agent.daemon` protocol to clients,
   owns the worker registry, event fan-out, replay cache, cron/heartbeat scheduling, agent-message routing, and
   update/restart orchestration. Entry: CLI arg `--mode daemon --daemon-socket <path>` (`daemon-mode.ts` /
   `runDaemonCatalogProcess` dispatch in main).
2. **Session workers** — one OS process per *root* session (an interactive session plus all of its RLM child
   sessions live inside one worker). Role env: `PRIME_AGENT_INTERNAL_DAEMON_WORKER=1`
   (`DAEMON_WORKER_ROLE_ENV` in `daemon-worker-protocol.ts`). Each worker listens on its own private socket
   (`workerSocketPath(supervisorSocket, workerId)`), authenticated by a per-worker random 32-byte token
   (`DAEMON_WORKER_TOKEN_ENV`), startup-gated via an inherited fd (`DAEMON_WORKER_STARTUP_GATE_FD_ENV`,
   commit marker `"start\n"`). Supervisor<->worker wire is a private framed protocol
   (`DaemonWorkerCommand` / `DaemonWorkerFrameHeader` in `daemon-worker-protocol.ts`), NOT the public protocol.
3. **Catalog process** — `daemon-catalog-process.ts`, role env `PRIME_AGENT_INTERNAL_DAEMON_CATALOG=1`.
   A child of the supervisor using Node IPC (`process.send`). Offloads disk-heavy saved-session work:
   commands `list`, `resolve`, `rename`, `delete`, `archive`, `mark_interrupted`, `shutdown`
   (type `CatalogRequest`), streaming `progress` and `session` rows back per request id.

### Socket paths
- Default supervisor socket: `join(tmpdir(), 'prime-agent-<uid>')/daemon.sock`
  (`defaultDaemonSocketPath()` / `defaultDaemonSocketDir()` in `daemon-socket.ts`). Windows: `\\.\pipe\prime-agent-daemon`.
- Socket dir mode 0o700, socket mode 0o600 (`restrictDaemonSocketPath`). Owned-by-current-uid asserted.
- Socket identity = `{dev, ino}` of the lstat (`getDaemonSocketIdentity`); used to avoid unlinking a successor's socket.
- Path lease: `proper-lockfile` lock on the socket path held for the supervisor's lifetime
  (`acquireDaemonSocketPathLease`, stale 5s, update 1s); `markCompromised` if stolen.
- `normalizeSocketPath()` in `src/utils/daemon-socket-path.ts` gives the lexical identity (lowercased on win32, resolved elsewhere).

### Start / autolaunch (`src/cli/daemon-launch.ts`)
- Clients call `ensureInteractiveDaemonRunning(socketPath, spawnCwd)` (memoized per socket). Flow:
  `probeDaemonVersion()` -> connect + `waitForHello(2000)`; a daemon is **current** only if
  `hello.protocol.version === DAEMON_PROTOCOL_VERSION && hello.schemaId === DAEMON_SCHEMA_ID && hello.appVersion === VERSION`.
- If stale: `shutdownStaleDaemonIfNotBusy()` — replaces the daemon only when no session is busy
  (`isSessionSummaryBusy`) and `busyClientOwnedSessionCount === 0`; otherwise throws `StaleDaemonError`
  and leaves the old daemon running to protect work.
- Launch election: `tryAcquireDaemonLaunchLease(socketPath)` (`daemon-launch-lease.ts`) so concurrent CLIs
  elect one leader to spawn. Leader spawns detached: `spawn(cli, ['--mode','daemon','--daemon-socket', path], {detached:true, stdio:'ignore'})`,
  after stripping all `PRIME_AGENT_INTERNAL_*` worker-role env vars. Startup timeout 30s (`DAEMON_STARTUP_TIMEOUT_MS`).
- `maybeStartDaemonEarly(args)` pre-warms the daemon during CLI startup for most invocations.
- Daemon log: `getDaemonLogPath(socketPath)` (under `~/.prime/agent/logs/...`); launch failures append a log tail to the thrown error.

### Worker lifecycle / crash / restart
- `DaemonWorkerLifecycle = "starting" | "ready" | "recovering" | "stopping" | "failed"` (`daemon-worker-protocol.ts`).
- Each worker has a durable JSON descriptor (`DaemonWorkerDescriptor`, version 2) persisted under the supervisor's
  descriptor dir (`<workerId>.json`): pid, processStartId, socketPath, recoveryJournalPath, authenticationToken,
  rootActiveSessionId, ownerClientId (client-owned sessions), sessionFile, lifecycle, createCommand,
  consecutiveFailures, stopRequestedAt, archiveOnStop, lastError.
- On worker disconnect (`handleWorkerClose`): mark `recovering`, then `recoverWorker()` retries with delays
  `WORKER_RETRY_DELAYS_MS = [250, 1000, 5000]` (3 attempts): first try reconnect to the still-live pid (verified via
  processStartId identity), else relaunch the process from the durable create command. Exhaustion -> lifecycle `failed`.
- Client-owned (`lifecycle: "client_owned"`) workers whose process died wait as `failed` /
  "Waiting for the owning client to reconnect"; a reattach carrying `recoveryConfig`
  (fresh `AgentSessionRuntimeConfig`, never persisted) revives them (`owned_session_recovery_context` capability).
- Uncertain in-flight work on recovery: `recoverUncertainWorkerOperations` + catalog `mark_interrupted` appends a
  `prime-agent.worker_recovery` custom message ("<prime_agent_worker_interrupted>") into the session JSONL.
- Supervisor replacement/adoption: on start a new supervisor reads descriptors and **adopts** live workers
  (connect + `worker_auth` with supervisorGeneration/pid/startId) rather than killing them
  (`daemon-supervisor-ownership.ts`: `acquireDaemonSupervisorOwnership`, startup fence, durable owner token).
  `daemon_hello` carries `supervisorGeneration`, `supervisorPid`, `supervisorOwnerToken`, `supervisorProcessStartId`.
- Idle eviction: resident workers can be passivated after idle timeout (`IDLE_EVICTION_*` constants,
  `worker_passivate_idle_children`, `canEvictWorker`); sweep every 1-5 min; per-worker child passivation cap 2.
- Update restart: `prepare_update_restart` drains mutations (80s drain / 100s prepare deadline), writes a
  `DaemonUpdateRestartManifest` (`getDaemonUpdateRestartManifestPath()`), then `restart`; the new supervisor
  restores sessions from the manifest (see section 8).

### Other daemon-side ledgers
- `CommandRecoveryJournal` (`command-recovery-journal.ts`): per-client mutation idempotency journal so a client
  reconnect can learn a mutating command's fate (`command_result_uncertain` error + `ack_result` command).
- `WorkerRecoveryJournal` (`worker-recovery-journal.ts`): per-worker uncertain-operation journal.
- `RlmSpawnLedger` (`rlm-ledger.ts`): persisted RLM parent/child spawn tree used to rebuild child rosters.
- Cron jobs: `AgentCronJobStore` at `getCronJobsPath()`, plus per-session `SESSION_SCHEDULED_JOBS_FILENAME` artifacts.

## 2. Protocol surface (`daemon-protocol.ts`)

Constants: `DAEMON_PROTOCOL_NAME = "prime-agent.daemon"`, `DAEMON_PROTOCOL_VERSION = 7`,
`DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION = 7`, `DAEMON_SCHEMA_REVISION = 23`,
`DAEMON_SCHEMA_ID = "protocol-7-schema-23-633d151dce99"`. Wire = newline-delimited JSON over the Unix socket
(JSONL; `attachJsonlLineReader`/`serializeJsonLine` in `src/modes/rpc/jsonl.ts`).

### Envelopes
- Command: `DaemonCommandEnvelope { type:"command", id, protocol:{name,version}, clientId?, command }`
  (`createDaemonCommandEnvelope`). Bare `DaemonCommand` objects are also accepted (`DaemonCommandWire`).
  `salvageDaemonCommandId()` lets the daemon return a correlatable failure even for unparseable lines.
- Event: `DaemonEventEnvelope { type:"event", id, protocol, activeSessionId?, sequence?, cursor?, emittedAt, event }`.
  `DaemonEventMeta.cursor = { generation, sequence }` (`DaemonEventCursor`); event id is `"<activeSessionId>:<sequence>"`.
- Responses correlate by `id`: `DaemonResponse = { id?, type:"response", command, success:true, data? } |
  { ..., success:false, error, errorInfo? }`. `DaemonErrorInfo` codes: `missing_session_cwd`,
  `session_import_file_not_found`, `session_already_active`, `command_result_uncertain`.

### Capability negotiation
- Client capabilities (`DaemonClientCapability`): `attach_snapshot`, `event_sequence`, `extension_ui`,
  `slim_attach`, `chunked_snapshot`, `client_owned_sessions`. Defaults: `attach_snapshot`+`event_sequence`.
- Server capabilities (`DaemonServerCapability`) = all client caps plus: `delete_rlm_subagent`,
  `heartbeat_catalog`, `heartbeat_management`, `model_catalog`, `side_question_transcript`, `transient_bash`,
  `session_input_admission`, `prompt_admission_cancellation`, `aim_credential_handoff`, `queue_message_mutation`,
  `authoritative_child_roster`, `owned_session_recovery_context`, `rlm_quiescence_barrier`, `session_input_pause`,
  `owned_prompt_cancellation`, `acp_mcp_servers`.
- Advertised in `daemon_hello.serverCapabilities`; per-command gating table `DAEMON_COMMAND_COMPATIBILITY`
  (`{minProtocol, minSchemaRevision?, capability?}` per command) checked via `meetsDaemonCommandCompatibility()` /
  `getDaemonCommandCompatibilities()` (some field-level requirements, e.g. `prompt.admissionId` needs
  `prompt_admission_cancellation`, `wait_for_headless_completion.waitForRlmQuiescence` needs `rlm_quiescence_barrier`).
- Client capabilities are sent on `attach`/`reattach` (`DaemonAttachClientMetadata.capabilities`); the hello returns
  the accepted set in `DaemonAttachResult.client.capabilities`.

### Full DaemonCommand union (91 commands; exact `type` strings)
Session catalog / lifecycle:
- `list` — list live sessions (`all?`, `cwd?`, `sessionDir?`, `includeClientOwned?`) -> `{sessions: SessionSummary[], busyClientOwnedSessionCount}`.
- `list_saved_sessions` — stream saved sessions (by activeSessionId scope or by cwd/sessionDir); progress via `session_list_progress`/`session_list_item`.
- `create` — start a new worker/session (`sessionPath?` resume, `continueRecent?`, `noSession?`, `name?`, `config?: AgentSessionRuntimeConfig`, `runtimeMetadata?`, `lifecycle?: "resident"|"client_owned"`, + client env & launch env).
- `attach` — subscribe this connection to a session's event stream (with `DaemonAttachClientMetadata`: clientId, capabilities, resumeCursor, telemetryDisabled, recoveryConfig).
- `reattach` — atomically switch this connection's subscription from one activeSessionId to another.
- `detach` — unsubscribe from a session (or all).
- `complete_owned_session` — finish a client-owned session (archive path for RLM children etc.).
- `promote_owned_session` — convert a client-owned worker to resident (survives owner disconnect).
- `kill` — stop the session's worker (session_closed reason "killed").
- `rename` — rename a live session.
- `new_session` — replace the worker's session with a fresh one (optional `parentSession`).
- `switch_session` — load a different saved session file into this worker (`sessionPath`, `cwdOverride?`).
- `fork` — fork the session at a transcript entry (`entryId`, `position?: "before"|"at"`).
- `reload` — reload the session from disk.
- `rename_saved_session` / `delete_saved_session` — mutate saved session files by path.
- `import_jsonl` / `export_html` / `export_jsonl` — transcript import/export.
- `set_session_name` — set name (worker-token gated variant for internal callers).
- `set_session_entry_label` — label a transcript entry.

Prompting / input:
- `prompt` — deliver a user prompt (message + `content?`/`images?`, `streamingBehavior?: "steer"|"followUp"`, `queueIfBusy?`, `expandPromptTemplates?`, `source?`, `agentMessageId?`, `customMessage?`, `admissionId?`); returns after admission, not completion.
- `prompt_and_wait` — same, but response resolves when the agent finishes the turn.
- `cancel_prompt_admission` — cancel a queued-but-unowned prompt by `admissionId` (`cancelOwned?` also cancels owned-but-undelivered) -> `DaemonPromptAdmissionCancellationResult {status: "cancelled"|"owned"|"unknown"}`.
- `steer` — interrupt/steer the streaming agent with a new message (queue key, prefixMessages).
- `follow_up` — enqueue a message for after the current turn.
- `resume_queue` — resume delivery of the paused queued lane.
- `restore_next_turn` / `restore_actions` — restore queued messages / action-store snapshot (update-restart plumbing).
- `append_custom_message` — append a custom transcript message without prompting.
- `mutate_queued_message` — edit/remove a queued message (`lane: QueuedMessageLane`, `index`, `expectedText`, `mutation`).
- `get_queue` / `clear_queue` / `abort_and_clear_queue` — inspect or clear queued lanes (latter also aborts).
- `acquire_session_input_pause` / `release_session_input_pause` — daemon-held input pause lease (`leaseKey`/`pauseId`).

Abort / waiting:
- `abort` — interrupt the current agent turn.
- `abort_bash` / `abort_compaction` / `abort_branch_summary` / `abort_retry` / `abort_side_question` — abort the named background activity.
- `wait_for_idle` — resolve when the session is idle.
- `wait_for_headless_completion` — resolve when a headless run completes (`waitForRlmQuiescence?` also waits for RLM children).

Agent-to-agent messaging:
- `send_message` — deliver text to another session (`targetActiveSessionId`, `fromActiveSessionId?`, `agentOrigin?`, `deliveryMode?`).
- `agent_messages_status` / `agent_messages_pause` / `agent_messages_resume` / `agent_messages_clear` — inbox controls.

Side questions & bash:
- `start_side_question` — off-transcript Q&A against the session's model (`sideQuestionId`, `question`, `previousTurns?` w/ `side_question_transcript` cap).
- `execute_bash` — run bash in the worker (`excludeFromContext?`, `transient?` + `runId?` w/ `transient_bash` cap); results stream as session events (bash_start/bash_end).
- `execute_bash_and_wait` — bash with the result in the command response (`DaemonBashResult`).

RLM children:
- `cancel_rlm_child` — cancel a running RLM child (`childId`).
- `delete_rlm_subagent` — delete a child's saved spec/session (cap `delete_rlm_subagent`).
- `get_rlm_children` — authoritative child roster (cap `authoritative_child_roster`).
- `get_rlm_max_depth_status` / `set_rlm_max_depth` — spawn-depth limits (schema >= 11).

Read-only getters (all take `activeSessionId`):
- `get_session_header`, `get_state`, `get_connection_state`, `get_messages`, `get_session_stats`,
  `get_context_tree`, `get_commands`, `get_resource_snapshot`, `get_model_catalog` (cap `model_catalog`),
  `get_available_models`, `get_session_context`, `get_session_tree`, `get_user_messages_for_forking`,
  `get_last_assistant_text`, `get_system_prompt`, `get_tool_definition`.

Model / runtime knobs:
- `set_model`, `cycle_model`, `set_scoped_models`, `set_thinking_level`, `cycle_thinking_level`,
  `set_service_tier`, `set_transport`, `set_steering_mode`, `set_follow_up_mode`,
  `set_auto_compaction`, `set_auto_retry`.
- `compact` — compact context (`customInstructions?`); `refine` — continual-harness refinement (`instructions?`, `rollbackId?`, `global?`).
- `navigate_tree` — move the session tree position (`targetId`, optional summarize/label).
- `handoff_aim_credential` — capability-gated AIM credential handoff (provider `openai-codex|anthropic|xai`, expected/requested binding + identity fingerprint).
- `replace_acp_mcp_servers` — connection-owner-scoped ACP MCP server replacement (cap `acp_mcp_servers`, schema >= 22).

Cron / heartbeats:
- `cron_list` (`includeInactive?`), `cron_add` (`schedule`, `prompt`, `promoteOwnedSession?`), `cron_cancel` (`jobId`).
- `heartbeats_list` (cap `heartbeat_catalog`), `heartbeat_manage` (`jobId`, `action`; cap `heartbeat_management`),
  `heartbeat_get`, `heartbeat_set` (`schedule`, `prompt`, `deliveryMode?`, `promoteOwnedSession?`), `heartbeat_update` (`action`).

Daemon lifecycle / plumbing:
- `ack_result` — acknowledge a recovered mutating-command result (`commandId`) so the recovery journal can drop it.
- `extension_ui_response` — answer an `extension_ui_request` (`requestId`, `response: {value}|{confirmed}|{cancelled:true}`).
- `prepare_update_restart` — fence + drain + write the update-restart manifest.
- `retry_worker` — retry recovery of a failed worker.
- `restart` — restart the daemon (used after prepare_update_restart).
- `shutdown` — stop the daemon (`force?`).

`isDaemonMutatingCommand()`: everything except the read-only set (`READ_ONLY_DAEMON_COMMANDS`: ack_result, list,
list_saved_sessions, attach, reattach, agent_messages_status, wait_for_idle, and all `get_*`/`cron_list`/
`heartbeats_list`/`heartbeat_get`) is treated as mutating and journaled for reconnect recovery.
`UPDATE_RESTART_DRAIN_COMMANDS` (still allowed during update fence): extension_ui_response, abort, abort_bash,
abort_branch_summary, abort_compaction, abort_retry.

### DaemonOutbound (server->client event union)
- `response` — command result (above).
- `session_list_progress` / `session_list_item` (`DaemonRequestProgress`) — streaming saved-session list rows (`DaemonSavedSessionInfo`).
- `daemon_hello` — handshake: socketPath, protocol, schemaId, schemaRevision, appVersion, runtime (`DaemonRuntimeIdentity`: buildId/executablePath/entrypointPath/launcherPath), supervisorGeneration, supervisorPid, supervisorOwnerToken, supervisorProcessStartId, supervisorSocketPath, clientId, serverCapabilities.
- `daemon_closing` — `reason: "shutdown"|"update"`.
- `heartbeats_changed` — heartbeat catalog invalidation ping.
- `session_event` — the main stream: `{activeSessionId, event: AgentConnectionSessionEvent, meta?}` (sequenced).
- `side_question_event` — side-question stream deltas.
- `session_status` — status/recap line updates (sequenced).
- `session_replaced` — session content replaced (new state+messages, `snapshotFollows?`).
- `session_resynced` — full `DaemonSessionSnapshot` push after a worker-side resync.
- `session_attached` — legacy attach confirmation (state+messages+snapshot+replay).
- `session_snapshot_begin` / `session_snapshot_chunk` / `session_snapshot_end` / `session_snapshot_failed` —
  chunked snapshot transfer (cap `chunked_snapshot`; purpose `"attach"|"replacement"|"resync"`, chunk target `SNAPSHOT_TARGET_CHUNK_BYTES`).
- `session_detached` — this connection was detached from the session.
- `session_closed` — `{reason: DaemonSessionClosedReason = "killed"|"shutdown"|"completed"|"replaced"|"update"}`.
- `extension_ui_request` — worker extension asks the UI something (`id`, `method`, `payload`); dialog methods = `select|confirm|input|editor` (`isDaemonDialogExtensionUiRequest`).
- `extension_error` — extension failure surfaced to the client.

## 3. Session visibility

### Listing live sessions
- Command `{type:"list", all?, cwd?, sessionDir?, includeClientOwned?}` -> `{ sessions: SessionSummary[], busyClientOwnedSessionCount }`.
  Helper: `listActiveDaemonSessionSummaries(client, {includeClientOwned})` in `src/cli/daemon-launch.ts`.
- `daemon ps` (`src/cli/daemon-ps.ts`) discovers **every** daemon on the machine, not just the default socket:
  (a) OS listening-socket scan (`ss -lxp` on Linux, `lsof -nP -F pn -U -a -c prime-agent` on macOS,
  parsers `parseSsListeners`/`parseLsofListeners`) merged with (b) a sweep of the default socket dir for orphaned
  socket files. Each socket is probed with `daemon_hello` + `list`. `DaemonStatus = "current"|"stale"|"unreachable"|"orphan-file"`.
  `DaemonInfo` rows: socketPath, pid, uptimeSeconds, version, protocolVersion, schemaId, buildId, executablePath, sessionCount, status, isDefault, hasTrackedWorkers.

### `SessionSummary` (`daemon-session-list.ts`) — the roster row shape
Fields: `id` (= activeSessionId for live rows), `lifecycle: "draft"|"live"|"archived"`,
`activity: "working"|"idle"`, `isSessionActive`, `hasActiveHeartbeat?`, `hasRegisteredHeartbeat?`,
`hasRegisteredCronJob?`, `lastActivityAt?`, `runtimeKind?: "top-level"|"subagent"`, `rlmDepth?`,
`activeSessionId?` (absent for inactive/saved-only rows), `sessionId`, `sessionFile?`, `sessionName?`, `cwd`,
`model?`, `thinkingLevel?`, `isStreaming`, `isCompacting`, `isBashRunning?`, `hasRunningRlmChildren?`,
`isRunningTools?`, `attachedClients`, `messageCount`, `unfinishedActionCount?`,
`sessionActions: SessionActionSnapshot`, `streamingMessage?`, `created?`, `modified?`, `firstMessage?`,
`parentActiveSessionId?`, `parentSessionId?`, `parentSessionPath?`, `rlmChildId?`, `repliedSinceTask?`,
`rlmParentNodeId?`, `spawnCode?` (spawn cell source, capped 4000 chars), `modelFallbackMessage?`,
`diagnostics?`, `summary?` (one-line background recap), `taskState?` ("completed"/"needs_input" verdict when idle),
`workerState?: "starting"|"ready"|"recovering"|"stopping"|"failed"`, `workerPid?` (diagnostic only).
- `classifySessionRosterStatus(summary)` -> `"running"|"idle"|"inactive"`; `isSessionSummaryBusy` = `isSessionActive || hasRunningRlmChildren`.
- Only `lifecycle === "live"` rows show in the agents view; `draft` = no message yet, `archived` = ctrl+x'd, resume-only.

### `DaemonSessionSnapshot` (attach payload, `daemon-protocol.ts`)
`{ activeSessionId, summary: SessionSummary, state: AgentConnectionState, messages: AgentMessage[],
  sessionContext?, sessionTree?: {tree, leafId}, lastEventSequence, lastEventCursor?,
  parent?: {activeSessionId?, sessionId?, nodeId?, childId?}, children?: AgentConnectionRlmChildAgentSnapshot[] }`.

### Saved sessions
- On disk: flat `~/.prime/agent/sessions/<uuidv7-sessionId>.jsonl` (`getSessionsDir()` in `src/config.ts` = `<agentDir>/sessions`;
  `getSessionFilePath(sessionDir, sessionId)` in `core/session-manager.ts`). First JSONL line is a header
  `{type:"session", id, cwd, ...}`; cwd filtering reads headers (`findMostRecentSessionForCwd`). Per-session artifacts
  live at `~/.prime/agent/session-artifacts/<sessionId>/` (`getSessionArtifactPath`).
- Mapping saved -> live: `buildSessionList(activeSessions, savedSessions, scheduledJobs)` joins by
  `resolve(sessionFile)`; a saved row that matches a live worker's sessionFile becomes the live summary; unmatched
  saved files become inactive summaries (`summaryForInactiveSession`, no `activeSessionId`). The `list` command
  and `list_saved_sessions` both go through the **catalog child process** for disk scans.
- `list_saved_sessions` streams `DaemonSavedSessionInfo` rows: `{path, id, cwd, name?, state?, parentSessionPath?,
  rlmDepth?, created, modified, messageCount, firstMessage, allMessagesText, agentStatus?}` via
  `session_list_item` progress events (client wrapper `listDaemonSavedSessions` in `saved-session-catalog.ts`).

### Session summarizer (`daemon-session-summarizer.ts`)
- Daemon-side background status generator for the agents dashboard. Sweeps every 25s (`SWEEP_INTERVAL_MS`),
  debounces turn_end bursts 2s (`SETTLE_DEBOUNCE_MS`).
- Model: `prime-inference` / `qwen/qwen3-30b-a3b-instruct-2507` (skipped if no configured auth —
  `resolveSummaryModel`). Context: last 8 messages, 600 chars each, max 400 output tokens.
- Prompt (`AGENT_STATUS_SYSTEM_PROMPT`) yields `<recap>` (<=12-word present-tense line) + `<status>`
  NEEDS_INPUT|COMPLETED. Parsed by `parseAgentStatusResponse`; idle defaults to `needs_input` when unsure.
- Results land on `SessionSummary.summary` + `SessionSummary.taskState` and are pushed as `session_status`
  events (`{activeSessionId, recap}`) — an MCP adapter gets these for free by watching the stream.

## 4. Control operations available today (exact command names + constraints)

All of these already exist on the daemon socket; an MCP server would simply proxy them.

- **Send a user message**: `prompt` (fire-and-ack: response returns once the session *accepts* the prompt, not
  when the turn ends) or `prompt_and_wait` (response resolves at turn completion — request timeouts matter:
  DaemonClient default request timeout is 30s, so callers pass a long timeoutMs; supervisor->worker requests
  allow up to 24h, `WORKER_REQUEST_TIMEOUT_MS`). `queueIfBusy` defaults to true when `streamingBehavior` is set
  (`daemon-mode.ts` ~L4185). Optional `admissionId` (unique per session) makes the pre-ownership admission
  cancellable via `cancel_prompt_admission` (`cancelOwned:true` also cancels an owned-but-undelivered prompt;
  result `status: "cancelled"|"owned"|"unknown"`).
- **Steer (interrupt with new instruction)**: `steer` — delivered into the streaming turn; `follow_up` — queued
  for after the turn. Both support `queueKey`, `content`/`images`, `prefixMessages`, `expandPromptTemplates:false`
  for verbatim restore. Queue inspection/mutation: `get_queue`, `mutate_queued_message` (optimistic
  `expectedText` check), `clear_queue`, `abort_and_clear_queue`, `resume_queue`.
- **Abort / interrupt**: `abort` (current turn), `abort_bash`, `abort_compaction`, `abort_branch_summary`,
  `abort_retry`, `abort_side_question`, `cancel_rlm_child` (childId).
- **Start a new session**: `create` (new worker; `config: AgentSessionRuntimeConfig` carries cwd, model, tools,
  sessionDir, telemetryDisabled, etc.; `lifecycle: "resident"` (default) vs `"client_owned"`). `new_session`
  replaces the session inside an existing worker.
- **Resume a saved session**: `create` with `sessionPath` (absolute .jsonl path or a selector resolved by the
  catalog: session-id prefix or session name — `resolveCatalogSessionMatch`), or `continueRecent:true`.
  If the file is already active in a worker, `create` reuses/errors with `session_already_active` +
  `activeSessionId` in errorInfo (so a client can attach instead). `switch_session` swaps a live worker to a
  different saved file.
- **Kill / restart**: `kill` (stops the worker; watchers get `session_closed {reason:"killed"}`),
  `retry_worker` (re-run recovery for a `failed` worker), `restart` (whole daemon), `shutdown {force?}`.
  `prepare_update_restart` + `restart` = coordinated self-update.
- **Attach / takeover / follow output**: `attach` (any number of clients can attach to the same session; each gets
  the full sequenced `session_event` stream — there is no exclusive takeover concept for resident sessions),
  `reattach` (switch this connection to another session), `detach`. Client-owned sessions are the exception:
  they have an `ownerClientId` and other clients don't see them in `list` unless `includeClientOwned:true`;
  `promote_owned_session` converts to resident.
- **Heartbeats / cron**: `heartbeat_get` / `heartbeat_set {schedule, prompt, deliveryMode?, promoteOwnedSession?}` /
  `heartbeat_update {action}` / `heartbeats_list` / `heartbeat_manage {jobId, action}`; generic cron:
  `cron_list`, `cron_add {schedule, prompt}`, `cron_cancel {jobId}`. `heartbeats_changed` event invalidates catalogs.
- **Bash**: `execute_bash {command, excludeFromContext?, transient?, runId?}` (events stream via session_event
  bash_start/bash_end; transient bash is never recorded to the session and echoes runId — cap `transient_bash`),
  `execute_bash_and_wait` (result in the response, `DaemonBashResult`), `abort_bash`.
- **Goal commands**: none in the daemon protocol. Goals are session-internal (the `goal` skill / `--goal` CLI
  flags); an MCP adapter would drive goals by prompting the session, not via a daemon command.
- **Agent messaging**: `send_message {targetActiveSessionId, message, fromActiveSessionId?, deliveryMode?}` —
  note revision 13+ narrows *agent-origin* reach to the nuclear family (parent/siblings/children,
  `assertAgentFamilyReach` in `core/agent-messages.ts`); public clients (no `agentOrigin`) are unrestricted.
- **Model/runtime knobs**: `set_model`, `set_thinking_level`, `set_service_tier`, `set_transport`,
  `set_steering_mode`/`set_follow_up_mode` (queue modes), `set_auto_compaction`, `set_auto_retry`, `compact`,
  `refine`, `fork`, `navigate_tree`, `export_html`/`export_jsonl`/`import_jsonl`.
- **Input pause (fence)**: `acquire_session_input_pause {leaseKey}` -> pauseId; `release_session_input_pause
  {pauseId}`. While held, the daemon rejects competing session input; the pause is invalidated if the holding
  connection drops (watchers see "fence was invalidated" close).
- **Side questions**: `start_side_question {sideQuestionId, question, previousTurns?}` — ask the session's model
  off-transcript; answers stream via `side_question_event`.

## 5. Headless attach path (`src/modes/agent-connection/daemon-agent-connection.ts`)

### Factories / lifecycle
- `static DaemonAgentConnection.attach(client: DaemonClient, activeSessionId, options?): Promise<DaemonAgentConnection>`
  — the only static factory. Wraps `new DaemonAgentConnection(...)` + `await connection.attach()`; disposes on failure.
- Higher-level composition: `createDaemonClientConnection()` in `src/main.ts` (~L1075): `new DaemonClient(socketPath)`
  -> `client.connect()` -> resolve the target summary (by activeSessionId, by sessionFile match via
  `findActiveDaemonSessionSummaryForSessionFile`, or `create`) -> `DaemonAgentConnection.attach(client, id, {...})`.
  The agents-view mode (`src/modes/agents-view/agents-view-mode.ts` L333/L356/L2062) attaches to arbitrary
  sessions the same way — that is exactly the pattern an MCP adapter should copy.
- `DaemonAgentConnectionOptions`: `closeClientOnDispose?`, `recoverDaemon?` (async supervisor revival; enables
  request recovery), `reconnectTimeoutMs?`, `snapshotTimeoutMs?`, `sendClientEnv?` (primary interactive client only —
  watchers MUST NOT send env; attach env is adopt-if-absent), `supportsExtensionUi?`, `ownedSession?`,
  `ownedSessionRecoveryConfig?`, `telemetryDisabled?`.
- The connection implements the generic `AgentConnection` interface (same one InteractiveMode uses in-process),
  so everything the TUI can do headlessly is available: `prompt/steer/followUp/abort/executeBash/getMessages/
  getState/subscribe/...`.

### watchSession (secondary read/watch connections)
- `watchSession(activeSessionId)` (~L1418) opens a **second `DaemonAgentConnection` on the same shared
  `DaemonClient` socket** with `{closeClientOnDispose:false}`; returns
  `{getMessages, getCommands, subscribe, getToolDefinition, close}` or `undefined` if the session is unknown/exited.
  Each connection filters the shared JSONL stream by its own `activeSessionId`
  (`isMessageForActiveSession`). One socket can therefore multiplex many session subscriptions.

### Event flow / replay cursor
- On `attach`, the command carries `resumeCursor: {activeSessionId, generation, sequence}` when the connection has
  seen events before. Attach result includes a full `DaemonSessionSnapshot` + `DaemonReplayInfo` +
  `lastEventSequence/lastEventCursor`. With `chunked_snapshot`, message history arrives as
  `session_snapshot_begin/chunk/end` frames assembled client-side (`waitForSnapshot`, bounded by `snapshotTimeoutMs`).
- Live events are dropped when stale: `isStaleSequencedMessage` discards events whose cursor generation is retired
  or whose sequence <= last seen. `observeEventCursor` tracks `{generation, sequence}` monotonically.
- `session_event` payloads are `AgentConnectionSessionEvent` (message_start/update/end, tool events, bash_start/end,
  agent_start/end, rlm_child_update, refine_*, etc.). Note `message_update` is slimmed on the wire
  (`slimSessionEventForWire` in `daemon-extension-binding.ts` drops the nested `assistantMessageEvent.partial` copy).

### Could an MCP adapter mirror output and inject input this way? YES.
This is the intended headless surface: attach with default caps (`attach_snapshot`,`event_sequence`,`slim_attach`,
`chunked_snapshot`, optionally `extension_ui`), read the snapshot for history, subscribe for live deltas, and issue
`prompt`/`steer`/`abort`/etc. through the same connection. No TTY is involved anywhere; the TUI is just one client.

### Multiple simultaneous clients on one session
- Fully supported and normal (TUI + agents-view watcher + subagent viewers all attach concurrently). The worker
  keeps `state.clients: Set<DaemonSocketClient>`; every sequenced event is **broadcast to all attached clients**
  (`broadcastToSession`). `SessionSummary.attachedClients` reports the count.
- There is no input lock by default: any attached client may prompt/steer/abort; commands interleave through the
  session's admission queue. The only exclusivity mechanisms are (a) `acquire_session_input_pause` leases and
  (b) client-owned sessions (ownerClientId-scoped; other clients cannot create-over them and they are hidden from
  default `list`).
- Extension UI dialogs (`extension_ui_request`) go to **all** clients that advertised `extension_ui`; the first
  `extension_ui_response` for a requestId wins (the worker resolves and deletes the pending entry); if no attached
  client supports extension_ui the dialog immediately resolves to its fallback value (see
  `hasExtensionUiClientForMethod` in `daemon-extension-binding.ts`).

## 6. Existing HTTP/TCP surface and MCP-server code in the repo

- **No TCP or HTTP control surface exists.** Every `createServer` in the codebase is a Unix-domain `node:net`
  server: the supervisor socket (`daemon-supervisor.ts`), each worker's private socket (`daemon-mode.ts`), and the
  Python fork-server (`src/core/kernel/fork-server.ts`, tmpdir socket). The only `node:http` server is the
  short-lived localhost OAuth callback listener in `packages/ai/src/mcp/oauth.ts` (MCP client auth), not a control API.
- **No MCP server implementation anywhere.** `packages/coding-agent/src/core/mcp/` (`mcp-manager.ts`,
  `mcp-command.ts`, `acp-mcp-types.ts`) and `packages/ai/src/mcp/` (`catalog.ts`, `oauth.ts`) are all
  client-side: connecting the agent *to* configured MCP servers (`mcpServers` setting). No
  `@modelcontextprotocol/sdk` server import exists in the repo.
- Existing machine-facing modes that are adjacent but NOT MCP:
  - **ACP mode** (`src/modes/acp/acp-mode.ts`): Agent Client Protocol (JSON-RPC over stdio via
    `@agentclientprotocol/sdk`) — used by editors; one session per process invocation; can forward MCP server
    configs into the session (`resolveAcpMcpServers`, `replace_acp_mcp_servers` daemon command).
  - **RPC mode** (`src/modes/rpc/rpc-mode.ts` + `rpc-client.ts`): legacy JSONL-over-stdio control of a single
    in-process session.
  - The daemon protocol header comment explicitly anticipates this work: "This is the transport used by
    DaemonAgentConnection today, not the final remote gateway protocol... a future gateway can wrap or proxy this
    local transport without leaking transport details back into InteractiveMode."
- Conclusion for the plan: an MCP server must be new code that acts as a **daemon protocol client** (DaemonClient +
  DaemonAgentConnection, or raw JSONL) over the Unix socket; nothing needs to change in the daemon to get full
  visibility + control, and socket security (0600, uid-owned dir) already scopes access to the local user.

## 7. Reconnect semantics (what a long-lived client must handle)

### Event ordering
- Each session has its own monotonic `sequence` starting at attach-time state, plus an `eventGeneration` string
  (regenerated when the event stream identity changes, e.g. session replaced/worker relaunched). The cursor
  `{generation, sequence}` rides on `DaemonEventMeta` / the event envelope; event id = `"<activeSessionId>:<seq>"`.
- Clients dedupe: drop events whose generation is retired or whose sequence <= the last seen for the current
  generation (`isStaleSequencedMessage`). New generation => retire old (`observeEventCursor`).

### DaemonReplayStatus and the real replay story
- `DaemonReplayStatus = "complete" | "partial" | "unavailable"` — but **the daemon never actually replays missed
  events, and never returns "partial"**. `createDaemonReplayInfo()` (daemon-protocol.ts ~L1221) returns:
  - `complete` — no resumeCursor supplied, or resumeSequence === lastEventSequence (client is exactly current);
  - `unavailable` with `reason` `event_generation_changed` | `resume_cursor_ahead_of_session` |
    `event_replay_not_available` (client is behind — there is no event buffer to backfill from);
  - plus `resume_cursor_session_mismatch` from the worker attach path (`daemon-mode.ts` ~L5090) when the cursor
    belongs to a different session.
- Consequence: **catch-up is snapshot-based, not event-based.** On (re)attach the client always receives a full
  `DaemonSessionSnapshot` (possibly chunked). If `replay.status !== "complete"`, discard local incremental state
  and rebuild from the snapshot; then resume dedupe from `snapshot.lastEventCursor`.
- `DaemonEventMeta.replayed?: boolean` exists in the shape but replay is not produced today.

### Client-side reconnect machinery (reuse rather than reimplement)
- `DaemonClient.enableRequestRecovery()` — on socket loss, in-flight requests are parked (`awaitingReconnect`)
  instead of rejected; after the next `daemon_hello`, their **stable envelopes (same command id) are re-sent**.
  The supervisor's `CommandRecoveryJournal` dedupes mutating commands by `(clientId, commandId)` idempotency key,
  answers with the recorded result, or returns `errorInfo.code === "command_result_uncertain"` when the outcome
  is unknown; clients confirm consumption with `ack_result {commandId}` (sent automatically by DaemonClient for
  mutating commands).
- `DaemonClient.enableAutoReconnect({recoverDaemon, timeoutMs, onStatus})` — reconnect loop with exponential
  backoff (100ms*2^n capped 2s, default overall 60s `DEFAULT_RECONNECT_TIMEOUT_MS`).
- `DaemonAgentConnection` layers on top: on close it (a) treats `daemon_closing {reason:"shutdown"}` as terminal;
  (b) for `reason:"update"` or `session_closed {reason:"update"}` enters `reconnectAfterUpdate()` — waits for the
  restarted daemon, re-attaches, emits `session_resynced`; (c) otherwise if `options.recoverDaemon` is set,
  loops: `recoverDaemon()` -> `connect` -> `waitForHello` -> `attach()` -> `getInitialSnapshot()` -> emit
  `session_resynced` + `connection_status connected`. Session input pauses are invalidated on any drop.
- Update restart end-to-end: `prepare_update_restart` fences mutations (drain timeout 80s, prepare deadline 100s),
  persists `DaemonUpdateRestartManifest` (per session: sessionFile, cwd, config, clientEnv, queue
  {actions,nextTurn}, shouldResume, wasStreaming/wasCompacting/wasBashRunning/hadRunningRlmChildren/
  hadAcceptedPromptInFlight flags), daemon restarts, new supervisor restores sessions and clients re-attach;
  clients may also push state back via `restore_next_turn` / `restore_actions`.
- Supervisor identity: a reconnecting client should compare `daemon_hello.supervisorGeneration` /
  `supervisorProcessStartId`; a changed generation means a replaced supervisor (workers were adopted, event
  generations may have rotated).
- See also `docs/STABILIZE_DAEMON_CRASH_RESUME_AND_RESPAWN_2026-08-21.md`: worker RPC timeouts are command
  failures (never supervisor-fatal); concurrent clients elect ONE replacement daemon via the launch lease;
  "reachable but no hello" must be treated as *unavailable*, never stale/replaceable; a recovering worker is
  uncertain, not absent — retry against the same daemon, never create a duplicate session.

## 8. Gotchas for a naive MCP adapter

1. **`prompt` acks acceptance, not completion.** The success response fires at preflight-accept
   (`preflightResult(didSucceed)` in `daemon-mode.ts` prompt handler); the turn then streams via events. If the
   session rejects it you get "Prompt was not accepted by the session." Use `prompt_and_wait` (with a long
   per-request timeout — DaemonClient default is 30s) or `wait_for_idle`/`wait_for_headless_completion` to block.
2. **Admission queueing:** a busy session queues prompts when `queueIfBusy` (default true when
   `streamingBehavior` set). A queued prompt can sit indefinitely; use `admissionId` + `cancel_prompt_admission`
   for cancellable delivery, `get_queue`/`clear_queue` to inspect. Also: agent-message inbox pause
   (`agent_messages_pause`) and daemon-held `session_input_pause` leases can make input *rejected*, not queued.
3. **`needs_input` / `summary` are heuristic and optional.** `SessionSummary.taskState` and `summary` come from
   the cheap qwen3-30b summarizer over prime-inference; if that provider has no auth they are simply absent.
   Idle+unsure defaults to `needs_input`. Do not treat them as ground truth for "waiting on user".
4. **Extension UI requests.** If your client advertises `extension_ui` (attach `supportsExtensionUi` defaults to
   true in DaemonAgentConnection!), dialog requests (`select|confirm|input|editor`) will be routed to you and
   a `confirm` you never answer blocks the extension until its own timeout (some dialogs have none). If NO
   attached client supports extension_ui, dialogs auto-resolve to fallbacks (confirm=false, select/input=
   undefined) — i.e. permission-style confirms silently deny. An MCP adapter should either answer
   `extension_ui_response` or attach with `supportsExtensionUi:false` and let a human client own dialogs.
   Non-dialog UI methods (notify, setStatus, setWidget, setTitle...) also arrive as extension_ui_request and
   need no response.
5. **Update/restart queue:** on self-update the daemon emits `daemon_closing {reason:"update"}` and
   `session_closed {reason:"update"}`; sessions are NOT dead — they come back after restart via the manifest.
   A naive adapter that treats this as terminal will drop live sessions. Reconnect and re-attach instead.
6. **Replay never backfills.** Any gap => `replay.status:"unavailable"` and you must rebuild from the attach
   snapshot (Section 7). Never assume contiguous event delivery across reconnects.
7. **Chunked snapshots:** with `chunked_snapshot`, attach returns `snapshotStream` and messages arrive as
   snapshot_begin/chunk/end frames you must assemble (or omit the capability to get inline messages — costly for
   big sessions). With `slim_attach`, top-level `state`/`messages` on the attach result are omitted.
8. **Watchers must not send env.** `attach` env is adopt-if-absent; only the primary interactive client sends
   `collectDaemonClientEnv()`. A watcher sending env could bind identity onto env-less (cron-created) sessions.
9. **Idle eviction / passivation:** resident workers can be evicted after idle timeout (unless pinned by an
   active heartbeat or registered cron). A session you saw in `list` may later be `inactive` (no activeSessionId);
   resume = `create {sessionPath}`. Conversely `session_already_active` (errorInfo carries the live
   `activeSessionId`) means attach instead of create.
10. **Client-owned sessions** (RLM children of external processes, `lifecycle:"client_owned"`): hidden from
    `list` unless `includeClientOwned:true`; owner disconnect gives a 30s grace (`OWNED_WORKER_DISCONNECT_GRACE_MS`)
    then the worker stops/fails ("Waiting for the owning client to reconnect"); disposal completes them.
    Don't surface them as controllable sessions unless you handle owner semantics.
11. **Mutating-command journal:** every mutating command sent in an envelope is journaled per
    (clientId, commandId); a raw JSONL implementation should send `ack_result` after consuming results
    (DaemonClient does this automatically) and be ready for `command_result_uncertain` after reconnect.
12. **Version skew:** the daemon refuses nothing on attach for schema drift — instead commands are gated by
    `DAEMON_COMMAND_COMPATIBILITY` against hello (protocol/schemaRevision/serverCapabilities). Check
    `hello.schemaId`/`appVersion`; a stale daemon stays running while sessions are busy (StaleDaemonError policy),
    so an adapter must tolerate older daemons and use `meetsDaemonCommandCompatibility` before sending.
13. **telemetryDisabled is a hard gate:** attaching with `telemetryDisabled:true` to a telemetry-enabled worker
    (or vice versa creating) is rejected; carried on attach/reattach/create (schema >= 14).
14. **Two id namespaces:** `activeSessionId` (per live worker binding, changes across passivation/resume) vs
    `sessionId` (durable uuidv7, = jsonl filename). Track sessions durably by sessionId/sessionFile, control the
    live one by activeSessionId. `workerPid` is diagnostic only.
15. **`message_update` events are slimmed on the wire** (no nested `assistantMessageEvent.partial`); read
    `event.message` for the partial assistant message.
16. **`list` returns only live sessions by default; `all:true` merges saved (inactive) sessions** (optionally
    cwd-filtered) via the catalog child process (`handleList`, daemon-supervisor.ts ~L2208). `list` also
    fire-and-forgets a refresh of every worker's summaries, so results can be one refresh stale.
    `list_saved_sessions` streams progress rows — surface them incrementally for big session dirs.
17. **One socket, many subscriptions:** you can attach many sessions over a single DaemonClient (watchSession
    pattern) — but all share one JSONL pipe; a huge attach snapshot stalls other traffic on that socket.
    Consider a second DaemonClient for bulk attaches.
18. **RLM child sessions are separate activeSessionIds** hosted in the parent's worker; parent events include
    `rlm_child_update`; authoritative roster via `get_rlm_children` (sequence-tagged to avoid stale roster
    regressions). Child event streams require their own attach.

## Top 10 facts the plan must respect

1. **The daemon already exposes everything needed** over `/tmp/prime-agent-<uid>/daemon.sock` (0600) speaking
   JSONL `prime-agent.daemon` protocol v7 / schema 23; the MCP server should be a pure client of it
   (`DaemonClient` + `DaemonAgentConnection`), adding zero daemon-side commands. The protocol header explicitly
   plans for such a gateway.
2. **There is no MCP server, HTTP, or TCP surface in the repo today** — all servers are Unix sockets; core/mcp
   is client-side only. The MCP server is new code; remote reach requires its own transport decision.
3. **Discovery must handle multiple daemons**: default socket + arbitrary `--daemon-socket` paths; reuse the
   `daemon ps` discovery approach (`ss -lxp`/`lsof` + default-dir sweep + hello probe) in `src/cli/daemon-ps.ts`.
4. **Version/capability gating is mandatory**: check `daemon_hello` (protocol.version, schemaRevision, schemaId,
   serverCapabilities) and gate commands with `DAEMON_COMMAND_COMPATIBILITY` /
   `meetsDaemonCommandCompatibility`; stale daemons keep running and must still be introspectable.
5. **Attach is snapshot + live stream; replay is never backfilled.** Maintain `{generation, sequence}` cursors,
   dedupe stale events, and rebuild from the snapshot whenever `replay.status !== "complete"` or the generation
   changes. Handle chunked snapshots if the capability is advertised.
6. **Multiple clients per session are first-class** — mirror + inject is exactly the agents-view pattern
   (`DaemonAgentConnection.attach` / `watchSession`); there is no takeover/lock, only `session_input_pause`
   leases and client-owned sessions. `attachedClients` counts you.
7. **`prompt` = admission ack; completion arrives via events** (`agent_end`, `wait_for_idle`,
   `prompt_and_wait`, `wait_for_headless_completion {waitForRlmQuiescence}`). Long-running command responses need
   long client-side timeouts (supervisor->worker allows 24h).
8. **Decide the extension-UI stance up front**: advertise `extension_ui` and answer `extension_ui_response`, or
   attach with `supportsExtensionUi:false`; otherwise permission-style confirms silently resolve to `false` or hang.
9. **Sessions are durable as `~/.prime/agent/sessions/<sessionId>.jsonl`;** `activeSessionId` is ephemeral
   (worker binding). Idle workers get evicted; resume via `create {sessionPath}` and treat
   `session_already_active` (errorInfo.activeSessionId) as "attach instead". Worker lifecycle
   ("starting|ready|recovering|stopping|failed") and `retry_worker` must be surfaced, not hidden.
10. **Survive daemon churn**: `daemon_closing {reason:"update"|"shutdown"}`, supervisorGeneration changes,
    worker recovery ([250ms,1s,5s] retries then `failed`), and the update-restart manifest flow. Use
    `enableRequestRecovery`/`ack_result` idempotency for mutations and never spawn a second daemon —
    `ensureInteractiveDaemonRunning` + launch lease already elect a single launcher.

