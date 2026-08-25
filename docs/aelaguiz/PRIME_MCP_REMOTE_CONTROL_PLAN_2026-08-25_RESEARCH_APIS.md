# Worker3: Code-level API extraction for `pi mcp-serve`

Repo: /Users/aelaguiz/workspace/prime-agent (read-only)
Date: 2026-08-25


## 1. DaemonClient (`packages/coding-agent/src/modes/daemon/daemon-client.ts`, 688 lines)

### Constructor + basics
```ts
export class DaemonClient {
  constructor(private readonly socketPath: string) {}          // L129
  get hello(): DaemonHello | undefined                          // L131
  get isConnected(): boolean                                    // L135 (socket exists && !destroyed)
  supportsServerCapability(capability: DaemonServerCapability): boolean  // L139
}
```
`DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>` (L30). Hello fields (daemon-protocol.ts L963-985): `socketPath`, `protocol: DaemonProtocolInfo`, `schemaId?`, `schemaRevision?`, `appVersion?`, `runtime?`, `supervisorGeneration?`, `supervisorPid?`, `clientId`, `serverCapabilities: readonly DaemonServerCapability[]`.

### Connect / handshake
```ts
async connect(timeoutMs = 3000): Promise<void>                 // L170; throws if already connected
async waitForHello(timeoutMs = 3000): Promise<DaemonHello>     // L144; resolves immediately if hello cached
async reconnect(timeoutMs = 3000): Promise<void>               // L226; no-op if still connected, dedups concurrent
disconnectForReconnect(reason: DaemonClosingReason): void      // L244
resetTransportForReconnect(): void                             // L256
```

### Sending commands
```ts
async request(
  command: DaemonCommandBody,             // = DistributiveOmit<DaemonCommand, "id"> (client assigns id)
  timeoutMs = 30000,
  options: DaemonClientRequestOptions = {},  // { onProgress?: (msg: DaemonRequestProgress) => void }
): Promise<DaemonResponse>                                     // L294
```
- `request()` awaits hello internally if not yet received (L304), checks command compatibility vs hello
  capabilities and throws `DaemonCapabilityUnavailableError` (L306-311).
- Wire ids are auto-generated `daemon_<n>` (L351); commands wrapped in a versioned envelope when
  protocol >= DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION; mutating commands get `ack_result`
  idempotency handling automatically (L362-363, L470+).
- Per-request timeout rejects with a descriptive Error including socket + daemon log path (L383-392).

`DaemonResponse` (daemon-protocol.ts L881-890):
```ts
type DaemonResponse =
  | { id?: string; type: "response"; command: string; success: true; data?: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string; errorInfo?: DaemonErrorInfo };
```
`DaemonErrorInfo` codes (L892-896): `missing_session_cwd`, `session_import_file_not_found`,
`session_already_active` (carries `sessionPath` + `activeSessionId?`), `command_result_uncertain`.

### Recovery / reconnect options
```ts
enableRequestRecovery(): void      // L284: keep in-flight promises alive; replay stable envelopes after reconnect
enableAutoReconnect(options: DaemonClientReconnectOptions): void   // L289: implies requestRecovery
interface DaemonClientReconnectOptions {   // L97
  recoverDaemon: () => Promise<void>;      // e.g. re-run ensureInteractiveDaemonRunning
  timeoutMs?: number;                      // default DEFAULT_RECONNECT_TIMEOUT_MS = 60_000 (L103)
  onStatus?: (status: DaemonClientReconnectStatus) => void;
    // { status: "reconnecting", error } | { status: "connected" } | { status: "failed", error }  (L92-95)
}
```

### Subscriptions / teardown
```ts
onMessage(listener: (message: DaemonOutbound) => void): () => void   // L269, returns unsubscribe
onClose(listener: (error: Error) => void): () => void                // L276, returns unsubscribe
close(): void                                                        // L394: rejects all pending, destroys socket
```
Close errors are `DaemonSocketClosedError` (L58) carrying `daemonClosingReason?: "shutdown" | "update"`.
Helper: `getDaemonSocketCloseReason(error): DaemonClosingReason | undefined` (L88).

### Minimal correct usage (only real APIs)
```ts
import { DaemonClient } from "./modes/daemon/daemon-client.js";
import { defaultDaemonSocketPath } from "./modes/daemon/daemon-socket.js";

const client = new DaemonClient(defaultDaemonSocketPath());
await client.connect();                 // 3s default timeout
const hello = await client.waitForHello();   // { protocol, schemaId, appVersion, serverCapabilities, ... }
const response = await client.request({ type: "list" }, 10_000);
if (response.success) {
  const { sessions } = response.data as { sessions: SessionSummary[] };
  // ...
}
client.close();
```

## 2. Daemon launch helpers (`src/cli/daemon-launch.ts`, 700 lines) + socket path (`src/modes/daemon/daemon-socket.ts`, 300 lines)

### Exported from daemon-launch.ts
```ts
export function isDaemonSessionSummary(value: unknown): value is SessionSummary                 // L35
export async function probeDaemonVersion(socketPath: string): Promise<DaemonVersionProbe>       // L73
  // DaemonVersionProbe (L66, NOT exported):
  //   { status: "absent" } | { status: "current"; hello } | { status: "stale"; hello } | { status: "unavailable"; error }
  // "current" = hello.protocol.version === DAEMON_PROTOCOL_VERSION && hello.schemaId === DAEMON_SCHEMA_ID && hello.appVersion === VERSION

export async function listActiveDaemonSessionSummaries(
  client: DaemonClient,
  options: { includeClientOwned?: boolean } = {},
): Promise<SessionSummary[]>                                                                    // L114
  // wraps `client.request({ type: "list", includeClientOwned })` + validation (L121-150, private)

export class DaemonHandshakeUnavailableError extends Error                                      // L153
export class StaleDaemonError extends Error                                                     // L168
export async function shutdownConnectedDaemonAndWait(...)                                       // L256
export async function shutdownDaemonAndWait(socketPath: string, timeoutMs = 5000): Promise<boolean>  // L275
export type RunningDaemonProbe                                                                  // L289
export function isSessionBusy(summary: SessionSummary): boolean                                 // L293
export async function probeRunningDaemonSessions(socketPath: string): Promise<RunningDaemonProbe>  // L297

export function ensureInteractiveDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void>  // L585
  // Memoized per socket path; spawns a current-version daemon if none/stale; failed attempts forgotten so retry works.

export function shouldStartDaemonEarly(args: readonly string[], startupBenchmark: boolean): boolean   // L655
export function maybeStartDaemonEarly(args: readonly string[]): void                            // L684
  // NOTE (L601-630): EARLY_LAUNCH_VALUE_FLAGS lists flags that take a value; a new verb/flags may need
  // registration here so early daemon launch skips them correctly (or verb must be excluded like other commands).
```
File-private: `canConnectToDaemon`, `queryActiveDaemonSessions`, `ensureDaemonRunning` (L523),
`ensureDaemonRunningAsLeader` (L359), `shutdownStaleDaemonIfNotBusy`, log-tail helpers.

### daemon-socket.ts exports (socket path resolution)
```ts
export function defaultDaemonSocketPath(): string        // win32: \\.\pipe\prime-agent-daemon; else join(defaultDaemonSocketDir(), "daemon.sock")
export function defaultDaemonSocketDir(): string         // join(tmpdir(), `prime-agent-${uid}`)
export { normalizeSocketPath } from "../../utils/daemon-socket-path.js";
  // normalizeSocketPath(socketPath: string, baseDir?: string): string  — lexical resolve; lowercases on win32
// also: DaemonSocketPathLease, acquireDaemonSocketPathLease, prepareDaemonSocketPath,
// restrictDaemonSocketPath, getDaemonSocketIdentity, cleanupDaemonSocketPath (supervisor-side only)
```

### How main.ts resolves the socket today (pattern to copy)
```ts
// main.ts L1263-1305
if (parsed.daemonSocket) parsed.daemonSocket = normalizeSocketPath(parsed.daemonSocket);
let daemonSocketPath = parsed.daemonSocket ?? defaultDaemonSocketPath();
... ensureInteractiveDaemonRunning(daemonSocketPath) ...
// reconnect recovery hook (main.ts L1541): recoverDaemon: () => ensureInteractiveDaemonRunning(daemonSocketPath)
```

## 3. CLI wiring: how `pi` dispatches verbs, and what `mcp-serve` needs

### Dispatch chain
1. `src/cli-main.ts` (`runCli()`, 46 lines): sets process title, calls `maybeStartDaemonEarly(process.argv.slice(2))`
   (skipped for known public commands), lazy-imports `./main.js`, calls `main(process.argv.slice(2))`.
2. `src/main.ts` `main(args, options?)` (L1166): first calls `handlePublicCommand(args)` (L1184,
   from `src/cli/public-command.ts`). If `publicCommand.handled` -> return. Otherwise `parseArgs(args)`
   (src/cli/args.ts) then `resolveAppMode(parsed, stdin.isTTY)` (main.ts L181-198: `--mode daemon|rpc|acp|json`,
   `--print`, else interactive).
3. `--mode daemon` path: main.ts L1466-1485 — `runDaemonMode(...)` for worker processes, else
   `runDaemonSupervisorMode({ socketPath: parsed.daemonSocket, defaultSessionConfig })`.

### Verb (public command) dispatch — src/cli/public-command.ts
- `handlePublicCommand(args)` -> `runPublicCommand` (L39): checks `args[0]` against
  `PUBLIC_COMMAND_NAMES` (derived from `COMMAND_SPECS` path.length===1 in `src/cli/command-registry.ts`).
- Unknown first arg -> `continueWith(args)` (falls through to interactive/message parsing). So a NEW VERB
  MUST be added to `COMMAND_SPECS` or it will be treated as a chat message.
- Verbs like `list`/`stop`/`send` route via `runInternalAgentCommand(cmd, rest)` (L225) ->
  `handleDaemonCommand(["daemon", cmd, ...rest])` in `src/cli/daemon-command.ts`.
- `daemon` itself is in `REMOVED_COMMAND_NAMES` (command-registry.ts): `"app","daemon","install","manage","remove","uninstall"`.
  The old `daemon ps` verb is now `pi status` -> `runPs(json)` (public-command.ts L253-258, daemon-ps.ts).

### daemon-command.ts internal pattern (model for a long-running verb)
`handleDaemonCommand` (L54) parses `--socket|--daemon-socket <path>` (default `defaultDaemonSocketPath()`),
`--json`, subcommand from `DAEMON_CLIENT_COMMANDS` set (L29-52), then (L150-151):
```ts
const client = new DaemonClient(parsed.socketPath);
await client.connect();
try { switch (parsed.command) { case "list": ... } } finally { client.close(); }
```
Note: these subcommands do NOT call `ensureInteractiveDaemonRunning` — they rely on
`maybeStartDaemonEarly` from cli-main.ts having kicked the daemon. A long-running `mcp-serve` should
call `ensureInteractiveDaemonRunning(socketPath)` itself.

### Exactly what to add for `pi mcp-serve`
1. **command-registry.ts**: append a `CommandSpec` `{ path: ["mcp-serve"], usage: "mcp-serve [--port <n>] [--bind <addr>] [--stdio] [--daemon-socket <path>]", summary: "...", options: [...] }`.
   This auto-registers help text (`formatTopLevelHelp`, `formatCommandHelp`) AND membership in
   `PUBLIC_COMMAND_NAMES` — which also makes `shouldStartDaemonEarly` (daemon-launch.ts L672-680) skip
   early daemon boot for the verb (fine: mcp-serve ensures the daemon itself).
2. **public-command.ts `runPublicCommand` switch (L80)**: add `case "mcp-serve":` that parses its own
   flags (pattern: `parseBooleanOptions` / manual loop like `parseDaemonClientCommand` in daemon-command.ts
   L71-132) and awaits a new `runMcpServe(...)` (e.g. `src/modes/mcp-serve/index.ts`), then `return HANDLED;`.
   The promise may stay pending forever — `pi status`-style verbs return; a server verb just never resolves.
   (Alternative: mirror `--mode daemon` by adding a Mode, but the verb route is the smaller diff and how
   `status`/`doctor` already work.)
3. **Flags**: `--daemon-socket` value already recognized by args.ts (L109) and by
   `EARLY_LAUNCH_VALUE_FLAGS` (daemon-launch.ts L601+); `--port`/`--bind`/`--stdio` are new, parsed
   locally inside the verb handler only (public-command verbs never reach `parseArgs`), so NO change to
   args.ts is required if flags stay verb-local.
4. **Help**: nothing else — help comes from `COMMAND_SPECS` automatically (`help mcp-serve` works via
   `isHelpCommandRequest` + `formatCommandHelp`).

## 4. `create` command payload + AgentSessionRuntimeConfig + minimal `prompt`

### `create` command (daemon-protocol.ts L383-394)
```ts
{
  id?: string;
  type: "create";
  sessionPath?: string;        // resume selector: session file path OR id/name selector (see §9)
  continueRecent?: boolean;
  noSession?: boolean;
  name?: string;
  config?: AgentSessionRuntimeConfig;
  runtimeMetadata?: AgentSessionRuntimeMetadata;
  lifecycle?: DaemonSessionLifecycle;   // "resident" | "client_owned" (L199). Omit or "resident" for headless-resident.
} & DaemonClientEnv & DaemonLaunchEnv   // env?: Record<string,string> (HERDR_* allowlist), launchEnv?: Record<string,string>
```
Response `data` on success = a `SessionSummary` (validated via `isDaemonSessionSummary` — main.ts L1137).

### AgentSessionRuntimeConfig (`src/core/agent-session-config.ts` L6-46) — ALL fields optional
```ts
export interface AgentSessionRuntimeConfig {
  cwd?; agentDir?; sessionDir?; provider?; model?; apiKey?;
  systemPrompt?; appendSystemPrompt?: string[]; thinking?: ThinkingLevel;
  models?: string[]; tools?: string[]; noTools?; noBuiltinTools?;
  extensions?: string[]; noExtensions?; skills?: string[]; noSkills?;
  promptTemplates?: string[]; noPromptTemplates?; themes?: string[]; noThemes?;
  noContextFiles?; autonomous?: AgentAutonomousConfig;
  extensionFlagValues?: Record<string, boolean | string>;
  serializedRefine?: boolean; executionMode?: AgentExecutionMode;
  telemetryDisabled?: true;
  initialGoal?: { objective: string; tokenBudget?: number };
}
```
The daemon merges client config over its own `defaultSessionConfig` via
`mergeAgentSessionRuntimeConfig(base, override)` (L63), so a **minimal headless create is just
`{ type: "create", config: { cwd: "/abs/path" } }`** (optionally `config.model`, `name`).
Default model/settings come from the daemon side. cwd omitted => daemon default;
`missing_session_cwd` errorInfo exists for cwd problems (daemon-protocol.ts L893).

### Call sites (patterns)
- Interactive: `createDaemonClientConnection` (main.ts L1075-1146) sends
  `{ type:"create", config, sessionPath, continueRecent, noSession, env: collectDaemonClientEnv(), lifecycle: "resident"|"client_owned", launchEnv: collectDaemonLaunchEnv() }`
  then `attach`. For MCP we skip attach; `env`/`launchEnv` optional (adopt-if-absent identity only).
- Headless CLI: `runCreate` (cli/daemon-command.ts L856-876) sends only
  `{ type:"create", name, config, sessionPath, continueRecent }` — no env, no attach. This IS the
  minimal viable resident-session creation, proven in shipped code.
- `collectDaemonClientEnv()` / `collectDaemonLaunchEnv()` exported from daemon-protocol.ts (L219, L230).

### `prompt` command (daemon-protocol.ts L431-446)
```ts
{ type: "prompt"; activeSessionId: string; message: string;
  content?; images?; streamingBehavior?: "steer" | "followUp";
  queueIfBusy?: boolean; expandPromptTemplates?; source?; agentMessageId?; customMessage?; admissionId?; }
```
Minimal: `{ type: "prompt", activeSessionId, message, queueIfBusy: true }`.
- Handler (daemon-mode.ts L4155-4250): no attach required; success response = ADMISSION ack
  (sent on preflight accept), not turn completion. `queueIfBusy` default is
  `command.streamingBehavior !== undefined` (L4185) — i.e. **false for a plain prompt**, so pass
  `queueIfBusy: true` explicitly to queue instead of erroring on a busy session.
- `prompt_and_wait` (L447-468) exists but blocks until turn end — wrong for remote MCP clients.
- CLI `runPrompt` (daemon-command.ts L953-972) attaches only because it wants to stream events; the
  attach is NOT needed for prompt itself.

## 5. get_messages / AgentMessage / rendering to text

### get_messages
- Command: `{ type: "get_messages"; activeSessionId: string }` (daemon-protocol.ts L550).
- Handler (daemon-mode.ts L4557-4562): `success(id, "get_messages", { messages: state.runtime.session.messages })`.
  => response `data = { messages: AgentMessage[] }`.

### AgentMessage definition chain
- `packages/agent/src/types.ts` L298: `export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];`
  (exported as `@earendil-works/pi-agent-core`).
- `Message` (packages/ai/src/types.ts L256): `UserMessage | AssistantMessage | ToolResultMessage`:
  - `UserMessage` (L224): `{ role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }`
  - `AssistantMessage` (L230): `{ role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[]; api; provider; model; usage: Usage; stopReason: StopReason; errorMessage?; timestamp; ... }`
  - `ToolResultMessage` (L246): `{ role: "toolResult"; toolCallId; toolName; content: (TextContent | ImageContent)[]; details?; isError: boolean; timestamp }`
- Content blocks (packages/ai/src/types.ts): `TextContent {type:"text", text}` (L177), `ThinkingContent {type:"thinking", thinking}` (L183), `ImageContent {type:"image", data(base64), mimeType}` (L193), `ToolCall {type:"toolCall", id, name, arguments: Record<string,any>}` (L199).
- Coding-agent custom roles via declaration merging (`src/core/messages.ts` L204-210):
  `bashExecution` (BashExecutionMessage L147: command/output), `custom` (CustomMessage L164),
  `branchSummary` (L186: `.summary`), `compactionSummary` (L193: `.summary`).
  So a rendered `AgentMessage.role` union is: user | assistant | toolResult | bashExecution | custom | branchSummary | compactionSummary.

### Existing text-rendering utilities (reuse candidates)
- **`src/core/agent-observe.ts` L146 `messageText(message: AgentMessage): string`** — exhaustive
  switch over ALL roles incl. custom ones; file-private but small; also has char-bounding helper
  (`{text, truncated}` L138-144). Best pattern to copy (or export) for MCP transcript tools.
- `src/core/session-manager.ts` L800 `extractTextContent(message: Message)` — text blocks only, file-private.
- `src/core/messages.ts`: `bashOutputToText` (L217), `bashExecutionToText(msg)` (L247) — exported.
- HTML export: `exportSessionToHtml` / `exportFromFile` in `src/core/export-html/index.ts` (L224/L273);
  daemon command `export_html {activeSessionId, outputPath?}` already exists (protocol L647).
- `get_last_assistant_text` is the cheap "final answer" getter — no client-side rendering needed.

## 6. Getter/control commands: exact payloads + response `data` shapes

All are `{ id?, type, ...fields }` requests; responses are `DaemonResponse` with `data` as below.
Handlers: worker side `src/modes/daemon/daemon-mode.ts`; supervisor routes/aggregates in `daemon-supervisor.ts`.

| Command (protocol line) | Request fields | Response `data` |
|---|---|---|
| `get_last_assistant_text` (L657) | `activeSessionId` | `{ text: string \| undefined }` (daemon-mode L5020-5025) |
| `get_state` (L548) | `activeSessionId` | `SessionSummary` (via `summaryForActiveSession`, daemon-mode L4547-4550) |
| `get_session_stats` (L552) | `activeSessionId` | `SessionStats` directly (daemon-mode L4572-4576) |
| `get_messages` (L550) | `activeSessionId` | `{ messages: AgentMessage[] }` |
| `get_queue` (L565) | `activeSessionId` | `{ steering: string[], followUp: string[] }` (message PREVIEWS, daemon-mode L4690-4696) |
| `get_rlm_children` (L551) | `activeSessionId` | `{ children: RlmChildAgentSnapshot[], eventSequence }` (daemon-mode L4564-4570) |
| `heartbeats_list` (L580) | `activeSessionId?` (optional) | `{ heartbeats: AgentConnectionHeartbeat[] }`; supervisor aggregates across all workers when no id (supervisor L1897-1943) |
| `heartbeat_manage` (L581-587) | `activeSessionId`, `jobId`, `action: "pause" \| "resume" \| "stop"` | `{ heartbeat: AgentCronJob }`; throws "No active heartbeat found" otherwise (daemon-mode L4739-4745) |
| `execute_bash_and_wait` (L631) | `activeSessionId`, `command: string` | `BashResult` = `{ output: string; exitCode?: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string }` (daemon-mode L4448-4455; blocks until done — set a generous request timeout) |
| `start_side_question` (L519-526) | `activeSessionId`, `sideQuestionId: string` (client-generated, unique), `question: string`, `previousTurns?: {question, answer}[]` | ack only (no data). Answer arrives as pushed `side_question_event` outbound messages `{ type:"side_question_event", activeSessionId, event: { id, question, answer, status: "running"\|"complete"\|"cancelled"\|"error", errorMessage? } }` — subscribe via `client.onMessage` and wait for terminal status (daemon-mode L4378-4414). Capability gate: `heartbeats_list/heartbeat_manage` need capabilities `heartbeat_catalog`/`heartbeat_management` (protocol L809-810). One side question per client+session at a time. |

Type sources:
- `SessionStats` — `src/core/session-stats.ts` L3: `{ sessionFile?, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens: {input,output,cacheRead,cacheWrite,total}, cost, contextUsage? }`.
- `SessionSummary` — `src/modes/daemon/daemon-session-list.ts` L30-84: id, lifecycle, `activity: "working"|"idle"` (SessionActivity), isSessionActive, lastActivityAt?, rlmDepth?, activeSessionId?, sessionId, sessionFile?, sessionName?, cwd, model?, thinkingLevel?, isStreaming, isCompacting, isBashRunning?, hasRunningRlmChildren?, isRunningTools?, attachedClients, messageCount, parent linkage fields, `summary?` (LLM recap), `taskState?` (completed|needs_input), `workerState?: starting|ready|recovering|stopping|failed`, workerPid?.
- `RlmChildAgentSnapshot` — `src/core/agent-session.ts` L288: `{ id, parentId?, activeSessionId?, sessionName?, model?, label, status, durationMs?, answerPreview?, toolUseCount?, tokenCount?, recap?, sessionDir, activity?, repliedSinceTask?, error? }`.
- `AgentConnectionHeartbeat` — `src/modes/agent-connection/types.ts` L536: `{ job: AgentCronJob, sessionName?, firstMessage? }`.
- `AgentCronJob` — `src/core/cron-jobs.ts`: `{ id, status, deliveryMode?, activeSessionId, sessionId, sessionFile, cwd, label?, prompt, schedule, createdAt, updatedAt, nextRunAt?, lastRunAt?, lastError?, runCount }`.
- `BashResult` — `src/core/bash-executor.ts` L24.
- Side question types — `src/modes/agent-connection/types.ts` L471-482.

## 7. Build / packaging / toolchain

- **Bin:** `packages/coding-agent/package.json`: `"bin": { "pi": "dist/bundle/cli.js" }`.
- **Build script:** `"build": "tsgo -p tsconfig.build.json && shx chmod +x dist/cli.js && npm run copy-assets && npm run bundle"`.
  `tsgo` (`@typescript/native-preview`) compiles src -> dist, then `scripts/bundle.mjs` runs **esbuild**
  (`bundle: true, splitting: true, format: esm, platform: node`) from `dist/cli.js` -> `dist/bundle/`.
- **New npm dependency bundling:** esbuild bundles everything EXCEPT the explicit `external` list:
  `["zeromq", "koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"]`
  (scripts/bundle.mjs). So `@modelcontextprotocol/sdk` added to `dependencies` WILL be bundled into
  dist/bundle automatically — no bundler config change needed (unless it drags native/interop deps).
  Add it in `packages/coding-agent/package.json` dependencies; note repo `.npmrc` enforces
  `min-release-age=7` days for dependency versions (root AGENTS.md, needs npm >= 11.10).
- **Node engines:** `"node": ">=22.8.0"` (both root and coding-agent package.json).
- **Check toolchain:** root `npm run check` = `biome check --write --error-on-warnings . && tsgo --noEmit && npm run check:installer && npm run check:browser-smoke`.
  Biome 2.5.5 (biome.json at repo root; tab indentation, organized imports) + tsgo typecheck. New code
  must pass both. Per AGENTS.md: run `npm run check` after code changes; it does NOT run tests; NEVER
  run `npm run dev`/`npm run build`/`npm test` yourself.
- **AGENTS.md style rules that bite:** no inline `await import(...)` / `import("pkg").Type`; no `any`
  unless necessary; comments only for real ambiguity; daemon protocol changes need
  capability/compat classification (mcp-serve v1 needs NO protocol change).
- Monorepo: npm workspaces (`packages/agent` = @earendil-works/pi-agent-core, `packages/ai`, `packages/tui`, `packages/coding-agent`).

## 8. Test suite

### `test/suite/harness.ts` (239 lines)
- `createHarness(options: HarnessOptions): Promise<Harness>` — builds an in-process `AgentSession`
  wired to the **faux provider** (`registerFauxProvider` from `@earendil-works/pi-ai`), in-memory
  SessionManager/SettingsManager/AuthStorage/ModelRegistry, temp dir, event capture.
- `Harness` exposes: `session`, `sessionManager`, `faux`, `setResponses/appendResponses`
  (scripted `FauxResponseStep[]` assistant replies), `events`, `eventsOfType(type)`, `tempDir`, `cleanup()`.
- Helpers: `getMessageText`, `getUserTexts`, `getAssistantTexts`.
- AGENTS.md: suite tests MUST use harness + faux provider, never real provider APIs/keys.

### Real-daemon boot pattern: `test/daemon-supervisor-process.test.ts`
- Spawns a real supervisor process (L78-100):
  `spawn(process.execPath, [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline", ...], { cwd, env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1", TSX_TSCONFIG_PATH } })`
  where `cliPath = resolve(__dirname, "../src/cli.ts")` and `tsxPath = node_modules/tsx/dist/cli.mjs`.
  Unique socket path per test: `join(tmpdir(), \`prime-supervisor-...-${pid}-${uuid}.sock\`)`.
- `connectEventually(socketPath)` (L200+): loop up to 15s, `new DaemonClient(socketPath)`, `connect(250)`,
  close+retry on failure.
- Teardown (afterEach L31-45): for each socket, `new DaemonClient`, `connect(250)`,
  `request({ type: "shutdown" }, 2000)`, `close()`; then SIGTERM children/worker pids.
- `daemon-client.test.ts` instead unit-tests DaemonClient against a mocked `node:net` (vi.mock) —
  good model for MCP-server unit tests without processes.

### Running tests (AGENTS.md)
- Single file, from **package root** (`packages/coding-agent`):
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- `npm run check` (repo root) does not run tests. Never run bare `npm test`/`npm run build` yourself.
- Regression tests go in `test/suite/regressions/<issue>-<slug>.test.ts`.
- `daemon-supervisor-process.test.ts` is excluded from `test:ci` (runs via `test:process`).

## 9. Session name/id selector resolution — reuse, don't reimplement

**The daemon resolves selectors server-side for `create {sessionPath}`** — the MCP server can pass a
raw selector (id, id-prefix/suffix, or name) straight through:

- `daemon-supervisor.ts` `createOrReuseWorker` (L2285-2315):
  1. `matchWorkers(command.sessionPath)` (L3910-ish, shown above): matches LIVE workers by exact
     `activeSessionId`/`sessionId`/`sessionName`, falling back to id-suffix matching
     (`matchesSessionIdSuffix`, `src/core/session-id.ts` L12). One match => reuse (returns the
     existing session's summary — "resume" is a no-op reattach).
  2. Else, if `looksLikeSessionPath(selector)` (`src/core/session-resolver.ts` L45: contains `/`, `\\`, or
     ends `.jsonl`) => treat as file path; otherwise `this.catalog.resolve(selector, cwd, sessionDir)`
     (catalog child process) which uses `resolveCatalogSessionMatch(sessions, selector)` —
     `src/modes/daemon/daemon-catalog-process.ts` L64-73: `session.id.startsWith(selector) || session.name === selector`,
     throws `Ambiguous session selector` on >1.
  3. Ambiguous live match => error `Ambiguous active session "<sel>"`.

Client-side helpers (if the MCP server wants to resolve BEFORE issuing control commands that need
a real `activeSessionId`):
- `resolveLiveSessionSelector(client, selector)` — `src/cli/daemon-command.ts` L1183-1204 (file-private,
  ~20 lines): filters `list` result by exact activeSessionId/sessionId/sessionName then id-suffix;
  copyable verbatim. IMPORTANT: per-session commands (`prompt`, `get_*`, etc.) are routed through
  `findWorkerForClient` -> `findWorker(selector)` (daemon-supervisor.ts L3934-3969), which uses the
  SAME `matchWorkers` semantics (exact activeSessionId/sessionId/sessionName, then id-suffix) and
  throws `Ambiguous active session`/`Unknown active session` — so the `activeSessionId` field of
  every command already ACCEPTS a name or id-suffix selector. MCP tools get selector support for free.
- Saved (inactive) sessions: `resolveSessionPath(selector, cwd, sessionDir?)` in
  `src/core/session-resolver.ts` L49 (exported) — local-then-global exact/partial with
  `SessionSelectorNotFoundError` / `SessionSelectorAmbiguousError`.
- `session_already_active` DaemonErrorInfo carries the live `activeSessionId` to use when a resume
  hits an already-running session (daemon-protocol.ts L895).

## 10. Top facts for implementation

1. `DaemonClient` is fully reusable: `new DaemonClient(socketPath)`, `connect(3000)`, `waitForHello()`,
   `request(commandBody, timeoutMs)`, `onMessage()/onClose()`, `close()`. Auto-reconnect + replay via
   `enableAutoReconnect({ recoverDaemon: () => ensureInteractiveDaemonRunning(socketPath) })`.
2. Default socket: `defaultDaemonSocketPath()` from `src/modes/daemon/daemon-socket.ts`
   (`$TMPDIR/prime-agent-<uid>/daemon.sock`); normalize user input with `normalizeSocketPath()`.
3. Daemon liveness: `ensureInteractiveDaemonRunning(socketPath)` (memoized, spawns/refreshes stale
   daemons); `probeDaemonVersion(socketPath)` for status reporting (absent/current/stale/unavailable).
4. `DaemonResponse` = `{ type:"response", command, success, data? | error, errorInfo? }`; every command
   in one discriminated union in `daemon-protocol.ts` (protocol 7, schema 23) — no schema work needed.
5. New verb registration = 2 files: `CommandSpec` in `src/cli/command-registry.ts` (help is automatic)
   + a `case "mcp-serve"` in `src/cli/public-command.ts` `runPublicCommand`. New flags (`--port`,
   `--bind`, `--stdio`) are parsed verb-locally; `--daemon-socket` handling exists.
6. Fleet status = `request({ type: "list" })` -> `{ sessions: SessionSummary[] }`; validate with
   exported `isDaemonSessionSummary`; `SessionSummary.summary`/`taskState` carry the LLM recap.
7. Create session: `{ type: "create", config: { cwd } }` is sufficient (all AgentSessionRuntimeConfig
   fields optional; daemon merges its defaults). Response data = SessionSummary. `sessionPath`
   accepts a file path OR id/name selector; daemon resolves and reuses live workers automatically.
8. Prompt: `{ type: "prompt", activeSessionId, message, queueIfBusy: true }` — success = admission,
   not completion; poll `get_state`/`list` afterward. `queueIfBusy` defaults to FALSE for plain prompts.
9. `activeSessionId` fields accept name/id-suffix selectors server-side (supervisor `findWorker`),
   with `Ambiguous`/`Unknown active session` errors — no client-side resolution needed for v1.
10. Read getters (no attach needed): `get_messages` -> `{messages: AgentMessage[]}`,
    `get_last_assistant_text` -> `{text}`, `get_state` -> SessionSummary, `get_session_stats` -> SessionStats,
    `get_queue` -> `{steering[], followUp[]}`, `get_rlm_children` -> `{children[]}`.
11. `execute_bash_and_wait` blocks server-side until BashResult — pass a large request timeoutMs.
    `start_side_question` is push-based: subscribe `onMessage` for `side_question_event` until terminal status.
12. AgentMessage rendering: copy `messageText()` from `src/core/agent-observe.ts` L146 (handles all 7
    roles incl. bashExecution/branchSummary/compactionSummary); content blocks are
    text/thinking/image/toolCall.
13. Build: add `@modelcontextprotocol/sdk` to coding-agent `dependencies`; esbuild bundles it
    automatically (only zeromq/koffi/undici/photon/clipboard are external). Node >= 22.8.0.
    `.npmrc` enforces 7-day min-release-age on installs.
14. Gates: `npm run check` (biome + tsgo) from repo root must pass; tests run per-file with
    `npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts` from packages/coding-agent.
15. Real-daemon integration-test pattern exists in `test/daemon-supervisor-process.test.ts`
    (spawn `--mode daemon --daemon-socket <tmp sock>` via tsx, `connectEventually`, shutdown in afterEach);
    unit-test pattern with mocked net in `test/daemon-client.test.ts`.
