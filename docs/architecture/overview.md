# Architecture Overview

## System Map

For the folder-by-folder tree, see [code-map.md](./code-map.md).

BetterC0de is composed of two layers:

1. Renderer: React/Vite app in `apps/ui`
2. Desktop shell + backend: Electron main process in `apps/shell` which spawns
   and supervises the loopback Node backend (`apps/backend/`) by default.
   `BETTERC0DE_BACKEND=in-process` enables the optional in-process mode.

The Expo companion in `apps/mobile` is another client of that same backend.
It does not own workspace files or provider processes.

## Request Flow

### Renderer to Backend

- Renderer calls named functions from `apps/ui/src/services/backend`
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
  with legacy thread selections taking precedence over global defaults. Model
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
  through the shared submit lane. Autonomous work records its owner separately
  from focus and observes that owner's stream and composer settings.
- Terminal session events carry a thread ID captured before delayed dispatch;
  an explicit panel ID takes precedence for keyboard shortcuts. Each session
  owns its cwd. Project-picker callbacks reactivate their initiating pane and
  ignore results after unmount. Successful chat deletion clears a matching
  autonomous owner in the same store update; denied deletions preserve the run.
- The Codex runtime retains its last successful model metadata across failed
  refreshes. Its startup fallback includes Astra without inventing model capabilities. OpenRouter
  automatic picker groups include Qwen and DeepSeek; Google and GLM are excluded
  in both discovery and renderer grouping. Provider catalog loaders discard
  superseded requests; connection cleanup aborts pending authentication as well
  as established sockets.
- Desktop and Mobile share `packages/schema/src/provider-replay.ts`: reconnect
  cursors, journal replacement, duplicate suppression, and sequence-gap signals.
  Stopped or replaced sockets cannot apply late frames.
- Critical chat, approval, thread and settings endpoints use
  `packages/schema/src/http-contracts.ts` on both clients and the server.
  Responses are validated before use; invalid dispatch responses are never
  automatically retried. Remaining HTTP endpoints still use generic transport
  types. Settings validation preserves redacted secret metadata.
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
- Provider events are emitted through a global `EventEmitter` bus and
  broadcast to every authenticated WebSocket client as
  `{channel:"provider.runtimeEvent", data:{event_type, thread_id, payload}}`.
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
| `lifecycle.ts`   | 0       | config, bearer token, cleanup ledger, admission gate, taint machinery, resource-admission reopen, startup abort listener |
| `persistence.ts` | 1       | SQLite open + migrations, event store, projections, session bindings, agent permission policy                            |
| `settings.ts`    | 2       | settings, logging, remote access + revoked-session cleanup, transcript recovery replay, OAuth store                      |
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

## Main Runtime Boundaries

- `apps/shell/main.cjs` — process lifecycle, window creation, backend boot
- `apps/shell/shared/urlPolicy.cjs` — trusted sender + navigation policy
- `apps/shell/shared/runtimeConfig.cjs` — injected renderer port and runtime metadata;
  the bearer remains in the main process
- `apps/ui/src/services/backend/*` — renderer-side backend interfaces
- `apps/backend/src/http/routes/*` — HTTP endpoints grouped by feature
- `apps/backend/src/services/*` — transport-agnostic backend use cases
- `apps/ui/src/hooks/chat-submit/*` — dependency-based slash-command parsers,
  output and actions. `lib/slash-command-runtime.ts` retains routing and exports.
  The submit hook loads this runtime on demand to keep it out of the first frame.

## Verification

`verify:source` includes schema builds, Desktop/Backend/Mobile typechecks and
tests, lint and packaging contracts. CI runs it on Ubuntu and Windows, followed
by an isolated backend startup/RSS smoke and a fresh renderer production build.
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
write completes.

The desktop process bearer remains private to Electron and is never placed in
renderer JavaScript. Enabling Remote Access changes the backend bind host from
loopback to the configured network host and serves the built Vite client from
that same HTTP origin. A one-time pairing credential is exchanged for an
HttpOnly browser cookie; SQLite stores only SHA-256 credential digests.

Paired sessions can call the ordinary HTTP and WebSocket application surfaces,
which is what makes all host-owned chats and workspaces available remotely.
Terminal bypass remains operation-bound: a valid paired session can mint a
one-shot capability for the exact command or PTY action, but never receives
Electron's process bearer.
Remote-host administration is a separate owner capability: only Electron's
process bearer may create pairing links, change the listener settings, list all
paired devices, or revoke other devices. A paired browser can inspect its
connection and sign itself out.

## Supported Runtime

- Electron desktop shell, packaged via `electron-builder`
- Node backend spawned from `apps/backend/dist/index.js` by default; optional
  in-process mode loads `apps/backend/dist/inProcess.js`
- HTTP (loopback) + WebSocket transport between renderer and backend
- Rust and Tauri are no longer part of the project.
