# Architecture Overview

## System Map

For the folder-by-folder tree, see [code-map.md](./code-map.md).

BetterC0de is composed of two layers:

1. Renderer: React/Vite app in `apps/ui`
2. Desktop shell + backend: Electron main process in `apps/shell` which forks
   and supervises the loopback Node backend (`apps/backend/`) as a child
   process. There is no in-process mode.

The Expo companion in `apps/mobile` is another client of that same backend.
It does not own workspace files or provider processes.

## Request Flow

### Renderer to Backend

- Renderer calls named functions from the modules in
  `apps/ui/src/services/backend` (`chatApi.ts`, `coreApi.ts`, `gitApi.ts`, …).
  There is no barrel: import the module that defines the function.
- The intended direction is components/hooks → `lib/` → `services/`.
  `services/` is transport only and does not drive zustand stores or run
  hooks: `chatApi.ts` sends `/chat/*`, `/permissions/*` and thread-activity
  requests, `lib/chat/send-message.ts` orchestrates a turn (stores, plugins,
  goals, autonomy), and `lib/chat/request-builders.ts` shapes the request
  without store or network access. Outside `services/`, renderer code
  reaches `window.electronAPI` only through `services/ipc-facade.ts`
  (`getElectronApi()` or a typed `ipcApi` method). ESLint warns on each of
  these rules; see [ci.md](../development/ci.md#lint-rules-and-ratchets).
- `runtime.ts` chooses the transport:
  - local HTTP on the loopback port injected via `window.__BETTERC0DE__`
  - same-origin remote HTTP with an HttpOnly paired-session cookie when the
    backend serves the web app to another device
- Streaming continues over a WebSocket via `wsClient.ts`
- The local HTTP transport observes Electron backend status before dialing.
  Downtime invalidates its cached config; readiness supplies the current port.
  CORS validation precedes the backend drain gate so allowed clients receive
  a readable 503. Preload status observers remove only their own listener.
- Desktop submit preparation is guarded per thread across composers, and each
  form guards attachment conversion before awaiting it. Refused sends preserve
  the draft. Finalizing an assistant item or an interaction segment retains the
  active provider turn; only a terminal turn event releases the busy state.
- Markdown response styles are scoped to `MessageResponse`, leaving tool controls
  unaffected. Tables and execution failures use the native-safe clipboard helper.
  Runtime error presentation uses public category/retry metadata; it does not
  recover raw diagnostics removed by the backend privacy boundary.
- The durable per-turn assistant transcript records a pending paragraph boundary
  after assistant items and tool interactions. The next text delta consumes it;
  token deltas within an item remain unchanged. That flag is persisted beside the
  projection sequence through the existing journal lane for idempotent recovery.
  Desktop and mobile receive the same saved content; adapters and HTTP contracts
  are unchanged.
- Desktop submits capture their pane's thread, workspace and composer settings
  before asynchronous context preparation. `composer-settings.ts` resolves
  persisted selections for both rendering and dispatch; `composer-preferences.ts`
  owns selection updates. Chats snapshot model defaults at creation or first use,
  with legacy thread selections taking precedence over global defaults.
  `lib/thread-settings-sync.ts` writes a chat's permission level, model
  selection and orchestration through to the backend and merges the backend's
  copy when the chat list loads; the store's localStorage copy is a cache. Model
  picker state belongs to each column; global open commands are consumed once by
  the focused column. Agent layouts bind initial and replacement blank tabs to
  distinct threads as soon as multiple tabs or panes exist, preserving their
  displayed defaults and the focused pane. Thread creation runs outside React
  state updaters and is deduplicated across effect replays.
- File review bars receive an explicit thread ID through the chat input area.
  Review state is local to the thread and turn, and dismissing it does not clear
  provider diffs. File restores select only that thread/turn's snapshot, resolve
  paths within its worktree or project, and wait for the backend write before
  showing success. They use the existing workspace permission boundary.
- Composer controllers initialize from their own thread's draft. DOM input and
  transcript navigation use explicit thread scopes; delayed clipboard and voice
  callbacks retain the initiating textarea. Live permissions, stop actions and
  context inspection receive that same thread ID. A null thread never falls back
  to another pane's stream. Plan modals capture their source thread and implement
  through the shared submit lane. Autonomous Work runs in the backend (see
  [Backend Transport to Services](#backend-transport-to-services));
  `lib/chat/autonomy-sync.ts` mirrors each chat's run from the thread list and
  `thread.metadata.updated` pushes, and decides nothing itself.
- Terminal session events carry a thread ID captured before delayed dispatch;
  an explicit panel ID takes precedence for keyboard shortcuts. Each session
  owns its cwd. Project-picker callbacks reactivate their initiating pane and
  ignore results after unmount. Deleting a chat ends its Autonomous Work run
  in the backend; the renderer drops its mirror only after the deletion
  succeeds, so a denied deletion leaves the run shown.
- The Codex runtime retains its last successful model metadata across failed
  refreshes. Its startup fallback includes Astra without inventing model capabilities. OpenRouter
  automatic picker groups include Qwen and DeepSeek; Google and GLM are excluded
  in both discovery and renderer grouping. Provider catalog loaders discard
  superseded requests; connection cleanup aborts pending authentication as well
  as established sockets.
- Desktop and Mobile share `packages/schema/src/provider-replay.ts`: reconnect
  cursors, journal replacement, duplicate suppression, and sequence-gap signals.
  Stopped or replaced sockets cannot apply late frames.
- Every API route except two has a shared contract in
  `packages/schema/src/http-contracts.ts`, assembled from group modules
  (`provider-contracts`, `shell-contracts`, `chat-contracts`,
  `thread-contracts`, `runtime-contracts`, `remote-contracts`) whose read
  models live in `thread-records`, `remote-protocol`, `runtime-records`,
  `desktop-config`, `thread-autonomy`, `output-bounds` and
  `pending-requests`. The backend parses the request and validates its
  response with the same schema (`handleHttpContract`, `contractJson`);
  desktop (`invokeContract`) and mobile validate responses before use.
  Invalid dispatch responses are never automatically retried. Settings
  validation preserves redacted secret metadata. The ratchet
  `apps/backend/src/http/contracts.structure.test.ts` allows two routes
  without a contract (`GET /health`, and `GET /shell/output/:archiveId`,
  which streams plain text) and requires each route to validate with its
  contract.
- Desktop parses every WebSocket frame with `parseRealtimeEvent`
  (`packages/schema/src/realtime-events.ts`) before it touches a store: the
  `provider.runtimeEvent`, `provider.replayGap`, `thread.metadata` and
  `thread.activity` payloads. A frame that does not match is dropped, not
  cast; unknown fields pass through so an older client accepts a newer host.
- Opening a chat reads a light page of the newest messages
  (`GET /threads/:id/messages?light=1`, `services/threads/light-message.ts`):
  diff text and inline `data:` attachments over 2,048 characters are left
  out and flagged (`textOmitted`, `dataOmitted`). When a diff is expanded or
  an attachment shown, the renderer fetches that message whole
  (`GET /threads/:id/messages/:messageId`, `lib/chat/message-payloads.ts`).
- Tool output is bounded at 64 KiB of JSON per activity
  (`packages/schema/src/output-bounds.ts`). A large value keeps its head and
  tail, marks the cut in the text, and records `outputTruncated`,
  `outputBytes` and `truncatedFields`. The backend bounds every activity it
  projects and every `provider.runtimeEvent` frame it broadcasts; the
  renderer bounds the activities it projects from plugin events
  (`lib/tool-output-bounds.ts`). `GET /threads/:id/activities/:activityId/output`
  returns the full value from the runtime journal while the journal still
  holds the event.
- Plan previews select a range of document rows without rewriting the saved
  markdown. Pending question progress evaluates each answer once per update;
  completeness and navigation use that same evaluation. Provider and model
  ordering computes ranks before sorting, preserving stable ties. Update
  notifications group provider states once and rank completed groups by their
  latest completion timestamp, with dismissed groups excluded.

### Backend Transport to Services

HTTP and WebSocket handlers delegate into shared TypeScript services:

- HTTP: `apps/backend/src/http/routes/*`
- WebSocket: `apps/backend/src/ws/*`
- Shared service layer: `apps/backend/src/services/*` and sibling domain folders
  (`persistence`, `provider`, `settings`, `auth`)
- `services/chat/` owns dispatch preparation, durable dispatch lifecycle,
  automatic compaction, approval/input responses and session controls.
  `http/routes/chat.ts` owns route registration and remote request identity.
- The backend prepares every turn (`services/chat/turn-preparation.ts`).
  Before every message from every client it runs the user's enabled
  `on_message_send` hooks in order (a goal or an Autonomous Work run runs
  them once for the command that sets it going, not for each of its turns);
  one that fails refuses the message (422 `message_hook_failed`) and each run is
  recorded in `hooks.json`. It fails closed: an unreadable `hooks.json`, or an
  enabled hook without a valid approval marker, refuses the message instead
  of skipping the hook. A request with `prepareTurn`, which the desktop, the
  remote web UI and the phone all send, also gets its system instruction
  built here from the user's and the project's skills, MCP servers,
  subagents and rules. The request carries only what the client alone
  knows: chat and focus modes, permission level, design brief, rule target.
- A chat's own settings (permission level, model selection, orchestration)
  are stored with the chat: `PATCH /threads/:id` with `{ settings }`,
  `projection_threads.settings_json` (migration 54),
  `services/chat/thread-settings.ts`. The stored permission level applies
  when a request names none, including after a restart.
- Autonomous Work runs in the backend. `services/chat/autonomy.ts` schedules
  a run and `autonomy-runtime.ts` sends its turns through `dispatchChatTurn`
  with the opening request's settings. A run's state is journaled as the
  chat's `thread.metadata.updated` event and projected into
  `projection_threads.autonomy_json` (migration 55), so it survives a window
  reload and a backend restart; a run left working by an earlier process
  comes back paused. Routes are `POST /chat/autonomy/{start,resume,pause,stop,task}`
  (`http/routes/chat-autonomy.ts`). A run needs conversation auto-save and a
  provider the backend runs itself, and cannot start while a goal is active
  in the same chat.
- The backend owns the desktop configuration: `mcp-servers.json`,
  `hooks.json`, `rules.md`, `skills/` and `subagents/` in the runtime home
  (`services/desktop-config/`). `ServerConfig.runtimeHome` resolves that
  folder once: `BETTERC0DE_RUNTIME_HOME` (the desktop passes it), else
  `BETTERC0DE_HOME`, else the parent of a data directory named `userdata`,
  else the data directory. Every write is atomic (staged file, fsync,
  rename) under a per-file lock. A write may name the SHA-256 revision it
  read; the shell's MCP and hook updates do and retry on a conflict, so two
  concurrent changes cannot drop each other.
  `/api/v1/config/{mcp,hooks,rules,skills,subagents}`
  (`http/routes/desktopConfig.ts`) answers only Electron's main process: a
  local request carrying the backend bearer in the
  `X-BetterC0de-Desktop-Shell` header, which renderer code never sees. The
  shell talks to it through `apps/shell/shared/desktop-config-client.cjs`
  after its native approval dialogs. At startup the backend moves any
  remaining `custom_rules`, `skills`, `mcp_servers` and `hooks` keys out of
  `settings.json` into those files once (`desktop-config/migration.ts`).
- `HubApprovalRequests` tracks unresolved tool requests after journal delivery.
  A live permission update preserves the active turn's context ownership and
  chat-mode ceiling, then re-evaluates pending requests through the same policy
  used for new requests. Provider responses emit the existing resolution events;
  failed responses leave requests pending. Codex and ACP approvals can therefore
  follow Bypass without restarting their active turns. Native policy changes
  that cannot take effect immediately are reported as queued to the caller.
- `services/workspace.ts` is a compatibility facade over `services/workspace/`:
  file confinement, bounded processes, project configuration, search, formatter
  staging and configuration discovery remain in their respective modules.
  ESLint prevents these services from importing HTTP.

## Persistence Flow

- SQLite is opened through `apps/backend/src/persistence/db.ts` using
  `better-sqlite3` (synchronous API).
- Schema migrations run through `apps/backend/src/persistence/migrations.ts`.
- `orchestration_events` is an append-only log addressed by `aggregate_kind`.
  The table name is historic: it once also backed an event-sourced command
  loop (`apps/backend/src/orchestration/`), which was removed in 2026-09 after
  months with zero callers. Today the log carries the provider runtime
  journal — every structural provider event is journaled there before it is
  projected or broadcast (see [`event-persistence.md`](./event-persistence.md)).
  Thread HTTP mutations and chat dispatch use the existing thread service and
  dispatch receipts; provider events retain their journal-first projection
  path. There is no parallel orchestration command loop.
- Thread/message projections live in `projection_threads` and
  `projection_messages`; the renderer reads them through the HTTP API.

## Provider Pipeline

- Desktop and mobile share the default chat provider priority in
  `packages/schema/src/model-selection.ts`: Claude CLI, Codex, Cursor, Grok CLI,
  then other configured providers. The renderer resolver applies availability
  before fallback, preserves usable explicit choices and bound conversations,
  and excludes the retired Claude Terminal picker entry. Claude API is a
  separate account-backed provider. Pending
  discovery must not persist a provisional fallback. The backend adapters and
  historical conversations remain intact.
- Claude API-key path uses `@anthropic-ai/sdk` in-process (no subprocess).
- OpenAI / Grok / OpenRouter / LM Studio share `openaiCompat.ts`, which wraps
  the official `openai` SDK with a `baseURL` override — one SSE loop for all
  four providers.
- Provider events go through the backend's own `ProviderEventBus`
  (`provider/events.ts`, one per backend, built by `createBootRoot`) and are
  broadcast to every authenticated WebSocket client as
  `{channel:"provider.runtimeEvent", data:{event_type, thread_id, payload}}`.
- Two provider stacks remain. The provider hub (`provider/runtime/`) runs
  Claude Code, Codex, Cursor, Grok CLI, Claude Terminal and BetterC0de
  compatibility instances; the frozen legacy stack (`provider/adapter.ts`,
  `adapters/`, `registry.ts`, `service.ts`) still runs the API-key
  providers. ESLint fails any other backend module that imports the legacy
  stack, apart from an allowlist in `eslint.config.js` (bootstrap, `AppState`,
  `ClaudeAdapter.ts`) that may only shrink. The legacy event shape is
  `LegacyProviderEvent` (`provider/types.ts`), distinct from the canonical
  `ProviderRuntimeEvent` the hub emits; `canonicalToLegacy`
  (`runtime/legacyBridge.ts`) is the one translation.
- `ProviderHub.ts` keeps the instances, their quarantine and the turn
  lifecycle, and delegates the rest: `ProviderSessionRegistry` (sessions per
  thread through one serialized admission queue), `ProviderTurnCapacity`
  (turn and session limits, checked synchronously before reserving),
  `HubApprovalRouter` (sends approval answers and permission-mode changes to
  the instance that owns the session), `ProviderStatusService` (status
  snapshots and the metadata and status caches), with shared types in
  `ProviderHubTypes.ts` and errors in `ProviderHubErrors.ts`.
- `runtime/providerDrivers.ts` lists each hub driver once: settings
  spelling, provider kind, aliases, default instance ids, catalog entry,
  session protocol and settings keys. `providerDriverInstances.ts` pairs each
  row with its instance factory and default configuration. Hub-or-legacy
  routing, aliases, default order and session budgets derive from it.
- `provider/turnLifecyclePolicy.ts` is the one set of turn hooks for both
  stacks: checkpoint baseline and turn admission before dispatch, the
  workspace trust gate right before the adapter, and checkpoint
  finalization after the terminal event. Bootstrap builds it once and hands
  it to the hub (through `hubTurnLifecycleHooks`) and to the legacy
  `ProviderService`.
- `provider/turnLimits.ts` holds the turn limits both stacks share: a turn
  times out after 30 minutes without a provider event, with the clock paused
  while an approval, plan approval or question waits for the user, and after
  12 hours in any case. `BETTERC0DE_PROVIDER_TURN_TIMEOUT_MS` and
  `BETTERC0DE_PROVIDER_TURN_MAX_DURATION_MS` change them
  (`bootstrap/providers.ts`). `BETTERC0DE_PROVIDER_MAX_IDLE_SESSIONS` sets
  how many idle sessions the reaper keeps per provider instance (default 4;
  `0` keeps none, `unlimited` removes the cap; `bootstrap/schedulers.ts`).
  Invalid values are logged and the default applies.
- Generic ACP code lives in `provider/runtime/acp/`: the JSON-RPC client,
  MCP server resolution (`AcpMcpServers.ts`), session configuration and the
  runtime and adapter bases. `cursor/` and `grok-cli/` keep what is
  specific to each CLI, such as binary resolution, account models and
  protocol extensions.
- Background helpers use their own models, set in `settings.json`:
  `image_generation_model` (image generation through the Codex CLI) and
  `commit_message_codex_model` / `commit_message_claude_model` (commit
  messages). Defaults are `DEFAULT_IMAGE_GENERATION_MODEL` and
  `DEFAULT_COMMIT_MESSAGE_MODELS` in `packages/schema/src/model-selection.ts`;
  a commit model that clearly belongs to the other CLI falls back to the
  default. Paired devices cannot change them.
- Provider control-plane boundaries are defined in
  [`provider-harness-adr.md`](./provider-harness-adr.md); streaming durability
  and journal ordering are defined in
  [`event-persistence.md`](./event-persistence.md).

## Backend Startup

`apps/backend/src/inProcess.ts` (`startNodeBackend`) is the composition root.
It is deliberately short: one ordered list of phase calls, the port loop, and
the startup unwind. The phases live in `apps/backend/src/bootstrap/`, one
plain function each, and only meet through the context types in
`bootstrap/context.ts`:

| Module           | Phase   | Builds                                                                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle.ts`   | 0       | config, bearer token, cleanup ledger, admission gate, per-backend service instances, taint machinery, resource-admission reopen, startup abort listener |
| `persistence.ts` | 1       | SQLite open + migrations, event store, projections, session bindings, agent permission policy                            |
| `settings.ts`    | 2       | settings, logging, remote access + revoked-session cleanup, transcript recovery replay, removal of the retired `auth.json` |
| `providers.ts`   | 3       | legacy adapters + registry, `ProviderHub`, settings-change listener, checkpoint reactor, `AppState`                      |
| `http.ts`        | 4, 7, 9 | `WsHub` + RPC handler; the Hono app; port bind and runtime error listener                                                |
| `recovery.ts`    | 5       | runtime journal spool replay, ingestion, journal replay, checkpoint/worktree recovery                                    |
| `schedulers.ts`  | 6, 8    | thread retention; transcript recovery timer, provider session reaper, vacuum                                             |
| `shutdown.ts`    | —       | the graceful `stop()` drain and the startup unwind                                                                       |

Two rules keep this honest, both pinned by
`bootstrap/bootstrap.structure.test.ts`: no phase module imports another
(only `context`, `lifecycle` and the pure `env` helpers are shared), and the
shutdown hard timeout is referenced only from `shutdown.ts`. Every phase
pushes its cleanup steps onto the shared `startupCleanup` ledger; the unwind
runs them reversed, so the push order across phases is load-bearing and is
snapshot-tested by `inProcess.test.ts`.

Process-level services are instances, not module singletons.
`createBootRoot` builds one of each per backend and the phases read them from
the `BootRoot`: the provider event bus, shell sessions, terminal PTYs, image
and native text generation, the workspace recovery gate and the agent
permission runtime. Git and workspace helper processes are also instances,
but code outside a backend reaches them through an installed default
(`setDefaultGitProcessService`, `setDefaultWorkspaceProcessService`);
`reopenResourceAdmissions` refuses to start
(`BACKEND_RESOURCE_SURVIVORS`) while the previously installed one still
holds processes.

When the shell forks the backend with `BETTERC0DE_STARTUP_CONTROL=ipc`, the
backend sends its `starting`, `ready` (port and bearer) and `error` frames
over the fork IPC channel (`startupControl.ts`), and the shell accepts
readiness only from there, so no log line can pose as it and the bearer
never passes through stderr, which the shell writes to its log. Without that
variable (`node apps/backend/dist/index.js`, the startup smoke test) the
same frames are JSON lines on stderr.

## Desktop shell and backend process

`apps/shell/main.cjs` keeps the application lifecycle and the startup and
quit order, and wires the modules in `apps/shell/shared/`; most have a
`scripts/*.test.mjs` suite of the same name. `shared/backend-process.cjs`
starts the backend with `child_process.fork()` on
`apps/backend/dist/index.js`. In a packaged build the fork re-runs the app
binary as Node (`ELECTRON_RUN_AS_NODE=1`); development uses a local Node
binary when one is found.

| Module | Owns |
| --- | --- |
| `backend-process.cjs` | Spawn, startup handshake, health probe, bearer injection for renderer requests, stop, restart, development reloader |
| `backend-supervisor.cjs`, `backend-environment.cjs` | Restart policy and `/health` liveness; the child's environment |
| `app-windows.cjs`, `window-state.cjs` | Main and secondary windows, crash and hang handling; saved window bounds |
| `app-ipc.cjs`, `trusted-ipc.cjs` | App-level IPC handlers; sender-checked `registerHandler` / `registerListener` and the guard around direct `ipcMain` use |
| `web-contents-policy.cjs`, `preview-partitions.cjs`, `user-input-gate.cjs` | Hardening for windows and preview guests, preview session cleanup, and input observed by the main process |
| `update-check.cjs`, `update-policy.cjs` | Release-feed checks and the update mode |
| `settings-key.cjs`, `legacy-data.cjs` | The settings encryption key and adopting a legacy installation's key |
| `command-approval.cjs`, `desktop-config-client.cjs` | Native approval dialogs; writes to the backend's `/api/v1/config/*` |
| `renderer-client-instances.cjs`, `process-tree.cjs` | Per-page ownership of terminals; process-tree snapshots for a forced stop |

- **Environment.** `shared/backend-environment.cjs` builds the child's
  environment explicitly. It keeps the user's variables (provider keys, proxy
  and CA settings, version managers) but drops `NODE_OPTIONS`, `NODE_PATH`,
  `LD_PRELOAD`, `DYLD_*`, `BASH_ENV`, `ENV`, other `ELECTRON_*` switches and
  npm lifecycle metadata, then applies the data directory, binary paths and,
  on macOS, the login shell's `PATH`.
- **Settings key.** The settings master key is not in the environment, where
  any same-user process could read it for the backend's lifetime. Electron
  sends it as a `settings-key` message on the fork IPC channel;
  `BETTERC0DE_SETTINGS_KEY_VIA_IPC=1` makes `index.ts` wait for it (up to 30
  seconds) before it reads settings.
- **Supervision.** `shared/backend-supervisor.cjs` restarts a backend that
  exits unexpectedly after 1, 2, 4 … seconds (at most 30). Five crashes within
  two minutes count as a crash loop: automatic restarts stop and the status
  becomes `failed` with a manual restart available. While the backend runs,
  `/health` is probed every 20 seconds; after three failed probes the backend
  is ended and the restart path takes over. Probes pause during system sleep
  and resume five seconds after wake-up. The renderer shows these states in
  `components/layout/backend-status-banner.tsx`, whose **Restart backend**
  button goes through Electron, not the stopped backend.
- **Application log.** Main-process output, forwarded backend output and
  renderer warnings and errors are redacted and written to `logs/app.log` in
  the data directory (`~/.betterc0de/userdata` in packaged builds), rotated at
  5 MB with two older files kept (`shared/rotating-log-file.cjs`). Settings →
  General → Privacy & Diagnostics opens the folder.
- **Electron fuses.** The `afterPack` hook `scripts/after-pack-fuses.cjs`
  sets the fuses of every packaged build and fails the build if reading them
  back disagrees: `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` and `--inspect` are
  ignored, cookies are encrypted, only `app.asar` loads, with embedded
  integrity validation (macOS and Windows). `RunAsNode` stays on because the
  forked backend is the app binary running with `ELECTRON_RUN_AS_NODE`; it can
  be turned off once the backend runs in a `utilityProcess`. Development runs
  use the stock Electron binary.
- **Renderer client instances.** The preload makes up a random id for every
  page load (`clientInstanceId`) and the renderer sends it as
  `X-BetterC0de-Client-Instance` with `/shell/run` and `/shell/pty/open`.
  When that page crashes, reloads or navigates, or its window closes, the
  main process calls `POST /shell/client/release` and the backend ends the
  terminals and shell runs the page started.
- **Content Security Policy.** `apps/ui/index.html` sets a ceiling policy
  that allows neither inline script nor `'unsafe-eval'`.
  `apps/ui/public/csp-bootstrap.js`, a classic script from the bundle's own
  origin, adds a narrower policy before the application module runs:
  `connect-src` limited to loopback, the page's origin and the configured
  remote backend, and in the desktop app `script-src 'self'
  'wasm-unsafe-eval'` and `frame-src 'self' blob:`. When the backend serves
  the bundle to a paired browser, `remote/web.ts` injects its runtime-config
  script with a fresh nonce per response and adds that `'nonce-…'` to the
  policy.
- **Preload contract.** `PreloadApi` in `shared/ipc-contract.cjs` lists every
  member and channel of `window.electronAPI`. The sandboxed preload cannot
  require it and repeats them, so `scripts/preload-api-contract.test.mjs`
  runs the real preload and fails when it, the registry or
  `apps/ui/src/types/electron-api.d.ts` drift apart.
- **Type checks.** The blocking `npm run typecheck:shell` (in
  `verify:source` and `release:check`) uses `apps/shell/tsconfig.gate.json`
  and checks syntax only. `npm run typecheck:shell:checkjs` type-checks
  every `.cjs` from its JSDoc under the strict settings. The shell is not
  clean under it yet, so no gate runs it; once the files that opted in with
  `// @ts-check` report nothing, removing `noCheck` from the gate config
  makes them blocking.
- **Plugin host.** With `BETTERC0DE_PLUGIN_HOST=utility` (off by default),
  third-party provider plugins run in an Electron `utilityProcess`
  (`shared/plugin-host-entry.cjs`, `plugin-host-runtime.cjs`) instead of the
  main process. `shared/plugin-host-client.cjs` gives every request a
  deadline, kills a host that stops answering, fails pending calls when the
  host exits, and starts a new one after a backoff, until too many crashes
  in a short window.

## Main Runtime Boundaries

- `apps/shell/main.cjs` — process lifecycle and startup order; windows,
  IPC and the backend process live in `apps/shell/shared/`
- `apps/shell/shared/urlPolicy.cjs` — trusted sender + navigation policy
- `apps/shell/shared/runtimeConfig.cjs` — injected renderer port and runtime metadata;
  the bearer remains in the main process
- `apps/ui/src/services/backend/*` — renderer-side backend transport, one
  module per API area
- `apps/ui/src/services/ipc-facade.ts` — how renderer code outside
  `services/` reaches the preload bridge
- `apps/backend/src/http/routes/*` — HTTP endpoints grouped by feature
- `apps/backend/src/services/*` — transport-agnostic backend use cases
- `apps/ui/src/lib/chat-commands/*` — built-in slash commands as
  `{ names, when?, run }` specs (`*-slash-specs.ts`) next to their parsers,
  output builders and actions. `lib/slash-command-runtime.ts` dispatches
  them; the submit hook loads it on demand to keep it out of the first frame.
  See [editor-workspace.md](./editor-workspace.md#slash-command-dispatch).

## Verification

`verify:source` includes schema builds, Desktop/Backend/Shell/Mobile
typechecks, tests, lint and packaging contracts. CI runs the full `release:check` on every
platform, including the backend startup/RSS budget, the production build and a
launch of the packaged app; see [ci.md](../development/ci.md).
The renderer build enforces vendor dependency cycles and byte budgets. Radix,
Floating UI and command/overlay packages share a chunk because their dependency
graph cannot be safely separated into two mutually importing vendor chunks.

## Remote Trust Boundary

`POST /workspace/open` is restricted to the desktop host and explicitly registers
a selected directory before any pre-thread metadata requests. These transient
roots live only for the backend lifetime; persisted thread/project records
continue to register roots after restart. Root authorization still canonicalizes
and revalidates paths. Registration does not override an explicit untrusted
decision or grant tool permissions.

Interactive Claude plans register the complete implementation tool catalog at
query creation because SDK tool inventories cannot change during that query.
The always-ask PreToolUse hook and mutable canUseTool gate enforce Plan/read-only
restrictions until explicit plan approval. Capture-only plans retain restricted
catalogs. Structural events still use the existing runtime journal lane.

Desktop clipboard writes go through the guarded `clipboard:write-text` IPC
channel. Preview web contents do not receive that bridge. A shared renderer
helper handles browser permission failures and reports success only after the
write completes. Chromium's clipboard read permission stays denied; the
terminal's right-click paste reads through `clipboard:read-text`, which the
main process answers only within two seconds of real input to the asking
window.

The desktop process bearer remains private to Electron and is never placed in
renderer JavaScript. Enabling Remote Access changes the backend bind host from
loopback to the configured network host and serves the built Vite client from
that same HTTP origin. A one-time pairing credential is exchanged for an
HttpOnly browser cookie; SQLite stores only SHA-256 credential digests.

Paired sessions can call the ordinary HTTP and WebSocket application surfaces,
which is what makes all host-owned chats and workspaces available remotely.
Only pairing over TLS, loopback or the tailnet issues a full session. Plaintext
from any other peer, a private LAN included, is treated as insecure
(`isInsecureNonLoopbackRequest`, and the same rule in `WsHub` upgrades):
pairing there issues a one-hour read-only session, and a full session used
over such a connection is downgraded to read-only for that request or socket.
Sessions also expire after 7 days without use. A paired device gets a terminal,
or a Bypass turn, only with the owner's terminal grant on a full session
(`http/remoteTerminalPolicy.ts`), and its approval responses never write
durable permission grants (`services/chat/requests.ts`).
Terminal bypass remains operation-bound: a valid paired session can mint a
one-shot capability for the exact command or PTY action, but never receives
Electron's process bearer.
Remote-host administration is a separate owner capability: only Electron's
process bearer may create, list or revoke pairing links, change the listener
settings, list all paired devices, or revoke other devices. Turning hosting
off, or starting with it off, revokes every session and unused pairing link.
A paired browser can inspect its connection and sign itself out.

## Supported Runtime

- Electron desktop shell, packaged via `electron-builder`
- Node backend forked from `apps/backend/dist/index.js` and supervised by the
  main process
- HTTP (loopback) + WebSocket transport between renderer and backend
- Rust and Tauri are no longer part of the project.
