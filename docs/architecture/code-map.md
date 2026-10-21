# Code map

Where things live, what each folder is for, and where the remaining large
files are. `overview.md` explains the request flow; this file is the tree.

```
BetterC0de/
├── apps/
│   ├── backend/src/          Local Node server (Hono + WebSocket + SQLite)
│   ├── ui/src/               Electron renderer (React 19 + Vite + zustand)
│   ├── shell/                Electron main + preload (.cjs; tests in scripts/
│                            and the renderer reference suite)
│   └── mobile/src/           Expo companion (paired client of the backend)
├── packages/schema/src/      Shared Zod contracts and pure helpers
├── docs/architecture/        Decisions and maps (this file)
└── scripts/                  Build, audit and smoke tooling (not a workspace)
```

## Backend — `apps/backend/src`

Layering is `http → services → provider → persistence`; `eslint.config.js`
freezes the boundaries that were measured at zero violations.

```
backend/src/
├── index.ts                   Child-process entry Electron forks
├── startupControl.ts          Startup frames over the fork IPC channel (or stderr)
├── inProcess.ts               Composition root (`startNodeBackend`); tests call it directly
├── bootstrap/                 Startup phases, in order
│   ├── env.ts  settings.ts  persistence.ts  providers.ts
│   ├── http.ts                HTTP app + WsHub wiring (remote-access thunks)
│   ├── recovery.ts  schedulers.ts  shutdown.ts
│   ├── lifecycle.ts           `createBootRoot`: config and the per-backend service instances
│   └── context.ts             The AppState assembled by the phases
├── http/
│   ├── router.ts              Middleware order, CORS, drain gate, rate limits
│   ├── routes/                One file per resource
│   │   ├── chat.ts            Dispatch, approvals, goals (calls services/chat)
│   │   ├── chat-autonomy.ts   Autonomous Work start/resume/pause/stop/task
│   │   ├── threads.ts         Thread persistence — the only write path
│   │   ├── settings.ts        Public settings; remote deny-list lives here
│   │   ├── desktopConfig.ts   `/config/*`: MCP, hooks, rules, skills, subagents (shell only)
│   │   ├── git.ts  filesystem.ts  workspace.ts  shell.ts
│   │   └── providers.ts  projects.ts  permissions.ts  runtime.ts
│   ├── contracts.ts           Typed request/response via @betterc0de/schema
│   ├── contracts.structure.test.ts  Ratchet: every route has a contract (2 exceptions)
│   └── middleware/            Rate limiting, auth, remote scope
├── services/
│   ├── chat/                  Dispatch lifecycle, turn preparation and message
│   │                          hooks, thread settings, goals, Autonomous Work, history
│   ├── desktop-config/        The runtime home's config files: store, MCP, hooks, migration
│   ├── threads/
│   │   ├── service.ts         ThreadService (sequencing writes)
│   │   ├── statements.ts      Every prepared SQL statement it runs
│   │   └── parsers.ts
│   ├── git/                   Split by concern; `services/git` stays the import
│   │   ├── process.ts         Admission limits, bounded output, termination
│   │   ├── refs.ts  status.ts  commands.ts  diff.ts
│   │   ├── worktrees.ts  checkpoints.ts  profile.ts
│   │   └── index.ts
│   ├── workspace/             Files, search, MCP, plugins, trust, authorization
│   ├── checkpoint-recovery-fence.ts, checkpoint-revert-saga.ts
│   ├── shell.ts  terminalPty.ts  text-generation.ts  …
├── provider/
│   ├── runtime/               THE provider stack (new work goes here)
│   │   ├── ProviderHub.ts     Instances, quarantine, turn lifecycle; delegates to:
│   │   ├── ProviderSessionRegistry.ts, ProviderTurnCapacity.ts, HubApprovalRouter.ts,
│   │   │   ProviderStatusService.ts, ProviderHubTypes.ts, ProviderHubErrors.ts
│   │   ├── providerDrivers.ts, providerDriverInstances.ts   One row per hub driver + its factory
│   │   ├── ProviderRuntimeIngestion.ts   Journal → project → broadcast
│   │   ├── ProviderRuntimeEventJournal.ts, …Replayer.ts, …RecoveryStore.ts
│   │   ├── claude/            Claude Agent SDK adapter
│   │   ├── codex/             Codex app-server adapter
│   │   │   └── translator/    Codex notifications → runtime events, per family
│   │   ├── acp/               Shared ACP code: JSON-RPC client, MCP servers, session config, bases
│   │   ├── cursor/  grok-cli/ What is specific to each ACP CLI
│   │   ├── betterc0deCompat/  BetterC0de-server compatibility adapter
│   │   ├── claudeTerminal/    Backend-only, opt-in
│   │   └── legacyBridge.ts    `canonicalToLegacy`: canonical → `LegacyProviderEvent`
│   ├── turnLifecyclePolicy.ts Turn hooks shared by both stacks (checkpoints, trust gate)
│   ├── turnLimits.ts          Idle timeout and absolute ceiling for a turn
│   ├── activity-projection/   Runtime events → ThreadActivity rows, per family; output bounds
│   ├── adapters/, adapter.ts, registry.ts, service.ts   Legacy stack (ESLint allowlist, no new importers)
│   ├── agent-loop/            In-house tool loop for direct-API providers
│   ├── catalog/               Provider/model catalogs
│   └── permissions.ts, agent-permission-*.ts, project-tool-policy.ts
├── persistence/               SQLite: db.ts, migrations, projections, eventStore
├── remote/                    Pairing, sessions, LAN/tailnet policy, Tailscale
│   ├── http.ts                Identity, transport predicates, pairing limiter
│   ├── privateNetwork.ts      `isPrivateLanAddress`, `forwardedClientAddress`
│   └── service.ts  tailscale.ts  web.ts  terminalGrant.ts
├── ws/                        WsHub (upgrade policy, auth, replay journal, RPC)
├── auth/  security/  observability/  lifecycle/  cli/  settings/  checkpointing/
└── appState.ts  config.ts  constants.ts  errors.ts
```

## Renderer — `apps/ui/src`

```
ui/src/
├── main.tsx, App.tsx          Bootstraps hooks/use-app-shell*
├── lib/                       Pure logic and zustand stores (no React components)
│   ├── chat-store.ts, chat/   Thread + streaming state, selectors, types
│   │   ├── send-message.ts    Turn orchestration (stores, plugins, goals, autonomy)
│   │   ├── request-builders.ts  Request shaping; no store or network access
│   │   └── autonomy-sync.ts   Mirror of the backend's Autonomous Work runs
│   ├── provider-events/       The one provider event entry point
│   │   ├── index.ts           handleProviderEvent, flushPendingDeltas
│   │   ├── normalize.ts       Any wire shape → one vocabulary
│   │   ├── handle.ts          The switch; delta barrier; store mutations
│   │   ├── activities/        Event → ThreadActivity row, same families as the backend
│   │   ├── delta-coalescing.ts  Frame-coalesced streaming, plan capture
│   │   ├── turn-artifacts.ts  Assistant items, plans, diffs, checkpoints
│   │   └── payload.ts         Payload readers (mirrors backend shared.ts)
│   ├── slash-command-runtime.ts  Slash dispatcher: pre-runtime specs, runtime lists, runtime specs
│   ├── slash-command-catalog.ts  BUILTIN_COMMANDS data
│   ├── slash-command-query.ts    Trigger detection, ranking, replacement
│   ├── settings-store.ts, preferences-store.ts, checkpoint-store.ts, …
│   ├── app-ui-store.ts        Modal flags and the New Project wizard (was app-shell state)
│   ├── composer-menu-store.ts `/`, `$` and `@` menu state of the focused composer
│   ├── console-log-store.ts   Captured console stream and the console tab
│   ├── pending-*.ts           Approval / user-input / attention derivations
│   └── chat-commands/         Slash commands: `*-slash-specs.ts` specs, their builders
│       ├── builtin-slash-specs.ts  The two ordered spec lists; BUILTIN_SLASH_COMMAND_NAMES
│       └── slash-registry.ts  `SlashCommandSpec`, indexing and dispatch
├── hooks/
│   ├── use-chat-submit.ts     Submit path; imports the runtime on submit
│   ├── use-panes.ts           Agent-mode pane grid
│   └── use-provider-*.ts, use-composer-tabs.ts, …
├── components/
│   ├── chat/                  Transcript, composer, tool rows, goal card
│   ├── layout/                Main area, panes, sidebars, workspace panel
│   ├── design/                Canvas mode (folder keeps its old name): canvas, cards,
│   │                          canvas-preview-store (inspector focus), canvas-runtime-* (pane)
│   ├── browser-preview/       Live preview, element inspector, inspector-state, select-browse-toggle
│   ├── settings/, dialogs/, sidebar/, editor/, file-tree/
│   ├── git-panel.tsx, git-panel/  Git panel; its sections and state hooks
│   ├── monaco-editor-wrapper.tsx, monaco-editor/  Editor; its helpers and popups
│   ├── ui/, ai-elements/, kibo-ui/   Component kits
│   └── slash-commands.tsx     The menu (re-exports catalog + query)
├── services/
│   ├── backend/               HTTP/WS transport, one module per API area (no barrel)
│   └── ipc-facade.ts          The only way to `window.electronAPI` outside services/
└── types/                     electron-api.d.ts, IPC channel lists
```

The intended direction is components/hooks → `lib/` → `services/`. ESLint
warns when `lib/` imports `hooks/` and when `services/` imports a store or a
hook. The slash command implementation lives in `lib/chat-commands/`, next to
`lib/slash-command-runtime.ts`, so the dispatcher no longer reaches into
`hooks/`. File names under `apps/ui/src` are kebab-case;
`scripts/filename-case.test.mjs` fails on a new file that isn't, and its
allowlist of older exceptions can only shrink.

## Shell — `apps/shell`

```
shell/
├── main.cjs                   App lifecycle and startup/quit order; wires shared/
├── preload.cjs                The sandboxed bridge (`window.electronAPI`)
├── *-ipc.cjs                  Feature IPC: hooks, MCP, skills, subagents, plugins, CLI plugins, …
├── plugin-manager.cjs         Provider plugins, in main or in the plugin host
├── shared/                    One module per concern (table in overview.md)
│   ├── backend-process.cjs    Backend spawn, startup handshake, supervision, stop
│   ├── ipc-contract.cjs       Channel names and `PreloadApi`
│   └── desktop-config-client.cjs  Writes MCP, hooks, rules, skills, subagents via the backend
├── tsconfig.json              checkJs for editors and `typecheck:shell:checkjs` (not a gate)
└── tsconfig.gate.json         The blocking `typecheck:shell` (syntax only)
```

## Mobile — `apps/mobile/src`

```
mobile/src/
├── app/                       expo-router screens
├── store/app-store.ts         Threads, messages, streams, requests
├── store/session-store.ts     Pairing profile, connection checks
├── lib/remote-api.ts          HTTP client
├── lib/remote-socket.ts       WebSocket with replay cursor, 4401 handling
├── lib/runtime-events.ts      Frame decoding (twin of renderer normalize)
└── components/                message-item/ (rows, tool-calls, file-changes), composer, request cards, …
```

Mobile re-implements rather than shares the renderer's client logic; a fix
in `apps/ui/src/lib` often has a twin in `apps/mobile/src/lib`.

## Shared — `packages/schema/src`

Zod schemas and pure helpers used by all three clients and the backend.
Subpath exports (`./json-read`, `./provider-replay`, `./tool-activity`, …)
exist for lean consumers; `index.ts` re-exports everything else.

- `json-read.ts` — `isRecord`, `asRecord`, `readString`, `readTrimmed`,
  `readNumber`, `readBoolean`. Import these; do not redeclare them.
- `tool-activity.ts` — how a tool call is described (`describeProviderToolActivity`).
- `thread-goal.ts` — `/goal` command parsing shared by desktop, mobile, backend.
- `http-contracts.ts` — typed endpoints for every API route but two, assembled
  from `provider-contracts.ts`, `shell-contracts.ts`, `chat-contracts.ts`,
  `thread-contracts.ts`, `runtime-contracts.ts` and `remote-contracts.ts`;
  `http-endpoint.ts` defines `endpoint()`.
- `realtime-events.ts` — `parseRealtimeEvent` for WebSocket frame payloads.
- `output-bounds.ts` — the 64 KiB head-and-tail bound on tool output.
- `desktop-config.ts` — the `/config/*` documents, writes and revisions;
  `runtime-records.ts` — the stored hook and MCP server records with their
  approval markers.

## Remaining large units (2026-09-17)

Kept deliberately or not yet split. Complexity is allowed at the adapter
boundary; the inland ones are the candidates.

The slash runtime's ~3,800-line `runSlashLadder` left this list on
2026-10-07: commands are specs now, and `slash-command-runtime.ts` is a
dispatcher of about 600 lines. In `apps/ui`, `max-lines-per-function` warns
above 300 lines.

| File | Unit | Lines | Note |
| --- | --- | --- | --- |
| `apps/backend/src/provider/runtime/claude/ClaudeAdapter.ts` | `query` wrapper, `sendTurn` | ~1400 / ~665 | SDK boundary |
| `apps/backend/src/provider/runtime/betterc0deCompat/BetterC0deCompatAdapter.ts` | `handleWorkspaceEvent` | ~450 | Was one 1330-line method; now five family methods |
| `apps/backend/src/provider/runtime/ProviderRuntimeIngestion.ts` | `processEvent` | large | The journal lane; not transactional on purpose |
| `apps/ui/src/lib/provider-events/activities/` | four family projectors | ~1000 | Twin of backend `activity-projection`, cut the same way; folding the two is the real fix |
