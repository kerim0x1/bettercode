# BetterC0de workspace reference

For contributor setup, use the [development guide](README.md). These notes describe the desktop workspace in more detail.

BetterC0de is a desktop AI coding environment. It puts the coding CLIs you
already have — Claude Code, OpenAI Codex, Cursor Agent, Grok — behind one
editor, one chat surface, and one set of permissions, so you can run several
agents side by side on the same repository.

- **Multi-pane agent workspace** — split the window into panes, each with its
  own chat, terminal, plan, diff, files, or git tab.
- **Bring your own CLI** — installed CLIs are detected on disk and appear in
  the model picker with their available models. No API key required for CLIs
  you are already signed in to.
- **Model lists that keep themselves current** — Anthropic models are
  discovered from the API and merged over the shipped list, and capabilities
  (context window, reasoning levels) are derived from the model generation, so
  a new release works without waiting for an app update.
- **Editor, Agent, and Canvas modes** — a Monaco-based editor, an agentic chat,
  and a canvas with live previews and runtime cards.
  Editor mode keeps files on the left, file and browser tabs in the center,
  and chat on the right, using the existing theme. Both side panels share dark,
  rounded frames; the center keeps the lighter shell background in dark mode.
  Canvas mode uses the same collapsible file sidebar on the left, the shared
  project canvas in the center, and resizable chat on the right. Opening a file
  takes you to the editor; opening a folder keeps you in Canvas mode. All three
  modes keep the account name, mode dropdown, appearance menu, and settings in
  the bottom-left sidebar footer.
  Open Files, the workspace tree, and Recent Files collapse independently and
  remember their state. The workspace header has New file and New folder
  icons with tooltips; open-file actions remain available from their menus.
  File and folder names use larger icons and text with roomier tree rows.
  The official Material Icon Theme supplies local icons for named folders,
  file types, and configuration files throughout the file tree, tabs, and file
  browser. HTML, JavaScript, and JSON use distinct syntax colors; HTML script
  blocks also recognize JSON-LD and import maps. All icons and language workers
  are bundled locally and work offline.
  Drag files or folders onto a folder's center to move inside it. Drop near a
  row's top or bottom edge to move beside it, guided by an insertion line, or onto
  the workspace header to return to its root. Entries remain alphabetically sorted.
  Hovering over a folder's center opens it. Existing
  destination entries are never replaced by a move, and open editor buffers follow
  their moved paths.
  In the desktop browser
  preview, Select mode picks page elements without activating buttons, links,
  or forms. Picks become removable chat tags; describe your changes and send
  them together. Browse (or Escape) restores normal page interaction.
  The Styles inspector groups size, layout, spacing, and typography into
  collapsible sections. Drag a numeric field's handle to adjust it live, or
  Shift-drag the value itself. Shift uses ten-unit steps; Alt uses tenths.
  Arrow keys work too, and Escape cancels an edit. Padding and margin expose
  all four sides independently. Preview edits reach source files only through
  the existing Send to AI flow.
- **Remote access** — pair a phone or a second machine with the running desktop
  app over your own network. Nothing is proxied through a cloud service.

Editor and Canvas sidebars have direct Files, Search, Git, Diff and Code Map
tabs, with outline and references in the view menu. Entering the editor without
a project reopens an available workspace, preferring the last one used there.
Its workspace overview groups file and folder counts, detected frameworks, key
files, and a file-type chart, with file search and browser preview directly below
the project header. Sections stack in narrow panels, and incomplete scans remain
clearly labeled. Search has labeled Case, Word and Regex controls, a clear-search
action, and independently collapsible Filters and Replace sections. Active file
filters stay visible as a count when collapsed. Results group matches under file
icons and relative paths, with readable line previews; partial searches label the
replacement action "Replace listed". Source Control can filter changed paths.
Editor and Canvas mode share a searchable **Chats** dropdown. Each entry shows
the last recorded model, project, branch, message count and recent activity;
running chats show **Working**. A model selected before its first reply is
labeled **Selected**. Older chats expose their recorded model before loading
the transcript. Search by title, model, project or branch; use arrow keys and
Enter to open a chat, and Escape to close the menu. Open chats and recent
history are grouped separately, with other projects below the current one.

Open chats and their layout are remembered locally. Use **+** for another chat and **Chat layout** to show
several chats stacked vertically or return to one. Each editor chat keeps its
composer at the bottom, including empty chats. Drag tabs onto a chat's top or
bottom edge to arrange the stack. The New chat and layout buttons stay
reachable beside the active chat's dropdown.
These editor controls are separate from the Agent mode pane layout.

In the desktop sidebar's mode dropdown, right-click **Agent**, **Editor** or
**Canvas** to open that mode in a separate BetterC0de window. This works in
Simple and Extended UI. The new window uses the current project or worktree
and selects an existing chat there when available. Each window keeps its own
mode, including after reload, and its title-bar controls affect only that
window. Left-click continues to switch modes in the current window.
The title bar's **Window** menu also offers **New Editor Window**, **New Canvas
Window** and **New Agent Window** for the current project.

The left sidebar in Editor and Canvas modes includes a **Diff** tab beside
Files, Search and Git. It shows staged and unstaged code changes for the active
project or worktree. **Ctrl+Shift+D**, **Toggle Diff Panel** in the command
palette, `/review-toggle` and the Review / Diff setting open the same view
without switching modes. Toggle again or select Files to return to the explorer.
In Editor mode the sidebar lists changed files; clicking one opens its diff as
a file tab in the central editor. Double-click the file or tab to keep it open.
Staged and unstaged comparisons have separate tabs alongside editable files,
with split/unified views, syntax highlighting, hunk actions and an Open File
action. Tabs support pinning, closing, reopening and split editor groups.
Untracked files in Git open as regular files until staged. Canvas mode keeps
its diff viewer in the sidebar. Changed files scroll vertically in both modes;
in narrow Canvas panels, the file list sits above the independently scrolling
comparison. Filtering and file counts stay visible while scrolling the list.
Editor and Canvas sidebar tabs adapt to the panel width: views that no longer
fit move into the More menu, while the selected primary view stays visible.
Widening the sidebar brings the tabs back automatically.

Canvas mode keeps projects on one shared, zoomable canvas. **Add project** opens
a repository folder or attaches an existing chat. Its picker searches chat titles,
projects and models, shows recent activity and working chats, and supports arrow
keys and Enter to select a chat. Right-click empty canvas space
to place one there. Each frame shows its repo/worktree path, branch, chat, model,
preview URL and dev-server status. Drag its header to move it, or focus its move
handle and use arrow keys (Shift for larger steps). Escape cancels a drag.
**Fit all projects** brings every frame into view. Positions are saved locally.
Hold **Ctrl** (or **Cmd**) and scroll to zoom the canvas around the pointer.
While held, card controls and previews are shielded from clicks; releasing the
key restores interaction. Hold **Alt** and drag to pan; releasing Alt restores
the selected tool. **V** selects the pointer, **H** selects the hand tool.
Space-drag also pans. These tool shortcuts leave text fields available for typing.
The model badge distinguishes the running model, the next selected model, and
the last recorded model. Branch badges read Git in each card's actual checkout
or worktree, refresh while the window is visible and after tasks, and can be
clicked to refresh immediately. Missing Git access is shown as unavailable.

Desktop, Tablet and Mobile previews can run together inside each project frame.
The frame's server button adds a **Runtime** pane beside them: the API requests
its previews make (method, path, status, time), the endpoints those imply with
a replay for reads, the dev server's output next to the pages' console, and the
tool calls of the frame's chat. Requests are captured by the desktop shell from
the preview session itself, so the page is not modified.

The canvas toolbar carries the same **Select** / **Browse** toggle as the
editor's browser preview and an **Elements** button that opens the same side
panel: pick an element in any frame's preview to see its page structure and
edit its styles live, then send the collected changes to that frame's chat.
Click its chat title to open the matching conversation; picked page elements
attach to that same chat even when another project was active. A short animation
marks a working task, followed by a steady status indicator; reduced motion is
respected. Removing a frame only removes it from the canvas. Its chat and any
running dev server remain available; use the server control to stop it.
Dev-server detection lists each project's root once and reads only an existing
package manifest. Missing lockfiles do not produce failed read requests, and
binary Bun lockfiles need not be loaded. Access or manifest errors remain
visible and can be retried from the preview.

Canvas mode opens directly on the canvas without a step-by-step setup. Describe
design changes in chat. Older chats with a saved design brief show a brief icon
on their frame; open it to view or remove that context.

## Quick start

Requirements: **Node 22+**, npm, and git. Windows, macOS, and Linux are
supported. At least one coding CLI is recommended — the app works without one,
but you will need to add an API key instead.

```bash
git clone https://github.com/kerim0x1/bettercode.git
cd bettercode
npm ci               # installs locked dependencies and prepares Node native modules
npm run dev          # Vite + backend + Electron
```

To produce an installer for your platform:

```bash
npm run build:win    # or build:mac / build:linux
```

Artifacts land in `release/`.

### Connecting an AI CLI

Install any of these and sign in once in a terminal; BetterC0de finds them on
its own and shows their status under **Settings → Providers**:

| CLI          | Install                                        | Sign in              |
| ------------ | ---------------------------------------------- | -------------------- |
| Claude Code  | `npm i -g @anthropic-ai/claude-code`           | `claude`             |
| OpenAI Codex | `npm i -g @openai/codex`                       | `codex login`        |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| Grok         | `npm i -g @xai-official/grok`                  | `grok login`         |

The initial model selection uses **Claude CLI**, then **Codex**, **Cursor**, and
**Grok CLI**, depending on availability. Other configured providers follow.
An explicit model choice and existing conversation bindings are preserved.
**Claude API** appears separately and becomes usable when an Anthropic API
account is configured.
Desktop and mobile use the same default provider priority.

API-key providers (Claude API, OpenAI, xAI, OpenRouter, LM Studio, and others)
are configured in the same place. Claude API, OpenAI, and xAI show models
available to the configured account. Claude CLI reads its SDK initialization
list, Codex uses `model/list`, and Grok uses ACP and its CLI cache. Catalogs
refresh every 15 minutes. **Settings → Model Visibility → Refresh API models**
starts a fresh API lookup, and provider-instance refresh updates a CLI. The last
successful account-specific list is saved without credentials. If a first
refresh fails, only explicitly added custom models are offered. A model
withdrawn from an account remains named in an existing chat; choose another
model before sending again.

If a CLI is installed somewhere unusual, set its full path in
**Settings → Providers**; the app never guesses at a bare command name that
could belong to a different vendor.

Codex can use a separate authentication directory while sharing its session
history and tools. The shared and authentication directories must not overlap,
including through filesystem links. BetterC0de checks the complete layout for
conflicts before creating links; existing private authentication and local
runtime files remain in their own directory.

The sidebar shows provider updates that run during the current session. Dismissed
results stay hidden through status refreshes; a new update result can appear
again. Successful updates dismiss automatically, while failures remain available
for inspection in provider settings.

### Skills and browser inspection

The editor's **Code Map** separates **Overview** from the **Files** index.
The overview keeps workspace totals, collapsible folders, file types, entry
points and related files together. Click a folder to browse its files, including
subfolders; **Project root** shows only files at the top level. The file index
keeps search and category filters visible while scrolling, with removable folder
filters and an Explorer reveal action on each row. Long paths fit narrow sidebars,
and partial scans remain clearly marked.

In the desktop composer, type `/` to browse commands and skills together, or
choose **Skills** to narrow the list. Selecting a provider skill inserts its
native `$skill` reference; typing `/skill-name your request` also invokes it.
Existing commands keep their meaning when names overlap: choose the **Skill**
entry or use `$skill-name` explicitly. Disabled provider skills are excluded.
Project skills remain available through their existing slash commands.

`/skills` shows a compact list with exact invocations and disabled entries marked.
Use `/skills --json` for full sources and contents, or `/skills --verbose` for
descriptions. Chat tables scroll independently and offer copy, CSV download and
an expanded view. Numbered reports keep their markers beside the text, and
inline file paths stay readable and can open source locations.

Failed tool steps show the available error message, expandable details and a
copy action. Provider runtime errors describe the public error category and
retry status without exposing private diagnostics. New saved transcripts retain
paragraph breaks between assistant messages and tool interactions.

Desktop and mobile tool activity show the script inside recognized shell
invocations. Argument lists preserve the script's quotes, and ambiguous commands
remain visible in full. This formatting does not alter executed commands.

The browser preview's element inspector has searchable page elements with
readable names, tag labels and clear selection. Search by text, tag, ID or class;
arrow keys navigate the tree and Enter selects an element. Picking an element
in the preview reveals its parent branches. The Styles tab shows the selection
and its dimensions above compact Design/CSS controls. Drag a numeric handle to
adjust its value; Shift takes larger steps, Alt smaller steps, and Escape cancels.
Style edits still preview locally and can be sent to the agent with **Send to AI**.

### Chatting without a project

You do not need a repository to start. A chat with no folder attached runs in
its own private scratch workspace under BetterC0de's data directory, so the
agent still has working file and shell tools. BetterC0de's built-in file tools
are confined to that directory. Shell commands run from it under your account:
an approved command can access paths outside it. A scratch workspace is not an
operating-system sandbox; the selected permission mode still applies.

When the idea is worth keeping, use **Fork into repo** in the chat header: it
branches the conversation into the repository you pick, brings along whatever
was built in the scratch workspace (never overwriting existing files), and
leaves the original folder-less chat untouched — so the same chat can be
forked into more than one repository. The copy skips `node_modules` and
`.git` and stops at 5,000 files or 256 MB; when that happens the fork
notification says how many files made it and that the rest was left in the
scratch workspace, rather than pouring an unbounded scratch tree into your
repository.

### Workspace trust

Folder selection waits for backend registration before loading Git status,
provider profiles and project configuration. Explicitly untrusted folders stay
untrusted. Remote clients can use registered workspaces but cannot register
arbitrary folders on the host.

Approving an interactive Claude plan switches the composer to Agent mode and
enables implementation tools in the same CLI session. Writes and agent tasks
remain gated by the selected permissions. Resolved plan requests disappear from
attention badges after reload as well as during live use.

While an agent is working, press Enter or **Queue message** to save a follow-up
in that desktop chat's queue. Messages, attachments and selected browser elements
are sent in order after the current turn, even when another chat is focused.
The queue uses the normal provider dispatch and the chat's settings at delivery;
it does not interrupt the active turn. You can remove waiting messages. **Stop**
pauses the queue; **Resume** continues it. Unsent drafts are stored locally in
the renderer, and restored queues stay paused after a restart. Delivery errors
also pause the queue instead of silently retrying an uncertain request.

Stopping a Claude turn preserves its conversation and resume position. Once
the interrupted turn and checkpoint finalization have settled, you can send
a follow-up in the same chat. A late Stop after an answer finishes also leaves
the conversation usable; a still-running turn continues to block a second send.

**Bypass Permission** hides the composer file-review bar; the changes remain
available in the chat and diff views. Plans remain accessible from the chat,
without a fixed **Plan ready** banner above the input.

File tools stay confined to the open workspace in every permission mode, with
one exception: the agent CLIs' own configuration directories (`~/.claude`,
`~/.codex`, `~/.cursor`, `~/.grok`, or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
when set). Claude Code keeps its auto-memory and skills there, so access to
those paths follows the selected permission mode instead of being refused
outright. Every other path outside the workspace is refused at every level.

The desktop Git diff panel follows the app theme and configured code font/size.
It highlights syntax in both light and dark mode and marks changed words inside
added/removed lines. Unified and split views share folding and Stage, Discard,
and Unstage actions; paired rows stay aligned when wrapped. Very large or unknown
file types retain the full plain-text diff without a syntax pass.
The file list can be collapsed with the panel icon left of its search field and
reopened from the left edge of the file header. Drag the divider to resize the
list; its width is remembered locally. Arrow keys resize a focused divider
(Shift takes larger steps); double-click resets the width. Narrow panes keep
the horizontal file list.

Copy actions use the native clipboard in the desktop app. Browser permission
denials show a copy error without repeated unhandled exceptions. Provider profile
editing preserves stored credentials and custom driver names; incomplete
environment-variable rows stay local until they have valid names.
Console and Report messages can be selected or copied individually, including
their timestamps. Full-log and report copying remain available in the panel.

Older settings files with `null` optional text fields load without resetting
preferences or credentials. The next successful save writes the normalized
values. Invalid settings and unreadable encrypted credentials still block writes
to protect the original file. Failed setting changes roll back in the UI and
show a save error, including changes made through quick toggles.
File-checkpoint branch labels use the originating chat's project or worktree,
including when another chat is focused. Hook and background-task lifecycle
events remain inspectable in the chat without spurious unhandled-event logs.

Opening a folder is treated as the decision to trust it, so Agent Mode works
immediately in projects you open yourself. Trust is what allows a repository's
own configuration — MCP servers and formatter commands declared in the repo —
to run. To review each project explicitly instead, turn off
**Settings → Permissions → Trust opened workspaces automatically**; you can
also mark any workspace untrusted there, which always wins.

### Importing editor themes

**Settings → Appearance → Imported themes** brings VS Code, Cursor, and any
theme in the same JSON format into BetterC0de. **Import from VS Code / Cursor**
lists the color themes those editors have installed on this machine (built-in
and extension themes under `~/.vscode`, `~/.vscode-insiders`, and
`~/.cursor`, plus each app's bundled extensions); **Import file…** and
**Paste JSON…** take a theme file directly. JSONC comments, trailing commas,
and `include` chains inside an installed extension are handled; pasted or
picked files must be self-contained.

An imported theme drives the whole app at once: the workbench colors (sidebar,
panels, buttons, borders) are derived from the theme's `colors`, the Monaco
editor gets its TextMate `tokenColors` folded onto Monarch tokens, and chat
code blocks are highlighted with the original theme through shiki. Light or dark
mode follows the theme's own `type`. Imported themes are stored under
`<dataDir>/themes/` and appear next to the built-in templates in
**Settings → Appearance** and in `/theme` (by id or name; `/themes` lists
them). Paired browsers can select imported themes but not import or remove
them; the mobile app has no theming. Removing the active theme falls back to
the default template of the same mode.

## Repository layout

Four coordinated workspace apps:

- React/Vite renderer in `apps/ui`
- Electron shell in `apps/shell`
- Node/Hono backend in `apps/backend`, spawned as a local sidecar by default
- Expo/React Native companion app in `apps/mobile`

Shared Zod schemas and cross-cutting types live in `packages/schema`.

Desktop and Mobile detect gaps when reconnecting to the provider event stream
and reload affected conversation state. Late events from a closed connection
are ignored. Desktop cancels superseded connections and retries if authentication
does not finish. Long-running status labels and the Ultra thinking indicator use
steady text and color to avoid continuous repainting across agent panes.

Repeated full tool-output snapshots are combined over a 50 ms window before
delivery to Desktop and Mobile. Incremental output chunks and lifecycle events
stay intact, and pending snapshots flush before approvals or turn completion.
The durable journal still records the original events.

Use `/goal <objective>` to start a goal with the selected provider and model.
The goal card above the composer supports edit, pause, resume and clear;
it uses the composer's theme surface and compact controls. Its objective and
status note remain readable in narrow panes. Pause/Resume stays in the header;
the actions menu contains Edit and Clear. Collapse keeps the objective visible;
editing supports multiple lines and Ctrl/Cmd+Enter to save (Escape cancels).
Type `/goal ` to browse its controls in the desktop slash menu. For Claude CLI,
Grok CLI and Codex, use `/goal <goal text>` to start, `/goal pause` to pause,
and `/goal continue` to continue with the selected model (`/goal resume` is an
alias). `/goal` or `/goal status` shows progress, `/goal edit <goal text>` changes
the objective, and `/goal clear` stops and removes it. The same commands work on
Mobile. Controls work during a running turn and while a plan awaits approval;
they are sent immediately instead of queued. Command names ignore casing while
goal text keeps its original casing.

BetterC0de schedules each continuation through its normal backend chat dispatch,
after the previous turn and its checkpoint work have fully settled. It uses
current workspace trust and permission checks. A normal admitted message pauses
the goal so user instructions take priority; Stop also pauses it. Pause and
Clear interrupt only the turn started for that goal. Resume uses the current
composer settings. Active goals recover as paused after a backend restart and
never restart work without an explicit resume. Conversation auto-save must be
enabled so follow-up turns retain their history.

Goals support the runtime adapters for Claude CLI, Codex, Cursor, Grok CLI,
opt-in Claude Terminal and HTTP compatibility instances. Legacy in-process
providers and Electron provider plugins are not supported. A provider must
return an explicit status and reason for each goal turn; an ordinary completed
turn does not mean the goal is achieved. Missing reports stop continuation after
three turns. Dispatch failures block the goal without retrying ambiguous work.
Completion is the agent's reported assessment; review its evidence in the chat.

Managed goals show their completed turns and admitted-turn elapsed time. They
do not impose a default token budget. Explicit token budgets currently return
an error before changing the goal because provider usage counters are not
consistently scoped to one turn. Existing provider-native goals remain readable
with their native token accounting and limits; their controls stay in the
provider. Goal changes and clears are journaled and projected into the thread
snapshot before acknowledgement. Desktop and Mobile preserve newer live updates
when older thread-list requests finish.

The backend is a TypeScript/Node process bound to loopback with a per-launch
bearer token. Set `BETTERC0DE_BACKEND=in-process` only for the optional
in-process development/runtime mode.

## Runtime Layout

- Electron spawns `apps/backend` by default and supervises its lifecycle.
- The renderer talks to the backend through `apps/ui/src/services/backend`, which dispatches over HTTP (loopback) and a WebSocket for streaming events.
- The backend exposes the application capabilities through two transport adapters:
  - HTTP routes in `apps/backend/src/http/routes`
  - WebSocket (auth handshake + event broadcast + optional RPC) in `apps/backend/src/ws`
- The backend takes a single-writer lock on its SQLite database
  (`<data dir>/…/<db>.lock`, containing the owning pid). A second backend
  pointed at the same data directory refuses to start with a
  `database_locked` error naming that file; delete it only if the pid it
  names is really gone.
- Provider events larger than the journal limit are journaled with their
  oversized text fields cut down rather than dropped, and the thread shows a
  "Provider runtime warning" activity when projection had to degrade. The rest
  of the turn keeps streaming.
- Thinking status ends when the provider starts answering or first reports a
  tool, including Grok/Cursor ACP updates without a separate start event.
  Desktop preserves the order of buffered thinking and answer chunks. Each
  response has one collapsed thinking disclosure containing every finished
  phase and the live text. Its timer adds thinking time across phases, and
  manual expand/collapse choices persist while the turn runs. Tool activity
  stays in its own group. Saved responses and mobile also use one disclosure.
  Mobile tracks the same transitions instead of showing Thinking for the whole turn.

## Remote Access

Keep the BetterC0de desktop app running, then open **Settings → Remote Access**
or run `/remote` in a chat. BetterC0de restarts its backend on the network
listener and creates a short-lived, one-time pairing link and QR code. Opening
that link in a trusted browser, or scanning it inside the native BetterC0de
Remote app, gives the device the live chats, projects, approvals, diffs, and
files owned by the desktop host.

On the same Wi-Fi (or any private network) that is all it takes: the phone
scans the QR and gets a full session, nothing to install. For access away from
home, Tailscale on both devices advertises the tailnet address automatically
and the phone pairs through the encrypted tunnel; or put the port behind a
trusted HTTPS tunnel or reverse proxy and save its public URL in Remote Access
settings. Plaintext from a public address is refused by default and, when
explicitly enabled, read-only. BetterC0de does not proxy remote traffic through
a cloud service. See [Remote Access](../remote-access.md) for the full setup
and security model.

A paired remote device is not the desktop. It cannot store provider
credentials, update provider CLIs, take heap snapshots, mint speech tokens,
list local drives, or read the backend's on-disk paths; those routes answer
`desktop_only`. Shell commands sent from a remote device always go through the
normal permission classification. A terminal on a paired device (PTY or a
human-typed bypass command) is off by default; the desktop owner can enable
**Allow terminal from remote devices** in Remote Access settings, which grants
shell access on this computer to every paired device with a full session.
Read-only sessions and paired devices themselves cannot turn it on. Turning it
off immediately ends every terminal and running command a paired device holds.
"Open in…" targets are desktop-only for paired devices, except Terminal, Git
Bash and WSL, which follow the same grant.

## Backend (`apps/backend/`)

TypeScript + Node 22 + Hono + `better-sqlite3` + `ws` + `pino`. Key modules:

- `apps/backend/src/index.ts` — default spawned-process entry
- `apps/backend/src/inProcess.ts` — the ordered list of startup phases (implemented in `apps/backend/src/bootstrap/`); returns a handle with `{ port, token, stop() }`
- `apps/backend/src/appState.ts` — shared service container
- `apps/backend/src/persistence/` — SQLite (migrations, EventStore, CommandReceiptStore, projection queries)
- `apps/backend/src/provider/` — provider adapter interface, registry, service; Claude via `@anthropic-ai/sdk`; OpenAI + Grok + OpenRouter + LMStudio via the `openai` SDK with a `baseURL` override
- `apps/backend/src/services/` — shell (subprocess wrappers), git (21 ops via `execFile`), workspace (search/read/write with path-traversal guards), project. Workspace searches are capped (result count, visited entries, scanned files/bytes, and a deadline); `/workspace/search` and `/workspace/search-content` answer with `{ entries|results, truncated, truncatedReason }` so a cut-short list never looks complete. Every surface that lists those results (file tree, @-mentions, search sidebar, references, symbols, `/find`, `/debug-rg`) ends a cut-short list with a static "cut short" row, and a rename whose search was cut short warns that files past the cut still hold the old name.
- `apps/backend/src/auth/` — CLI detection (`claude`/`codex --version`), key resolution (settings → env → CLI config)
- `apps/backend/src/settings/` — Zod schema + file-persisted settings service
- `apps/backend/src/security/token.ts` — 256-bit bearer token + `crypto.timingSafeEqual`
- `apps/backend/src/ws/server.ts` — `ws.Server` with `{type:"auth", token}` handshake, event broadcast, RPC dispatch

## Frontend (`apps/ui/src/services/backend/`)

The renderer's backend access layer:

- `runtime.ts` — transport selection (Electron sidecar / optional remote HTTP), config injection
- `coreApi.ts` — settings, threads, projects
- `providersApi.ts` — provider catalogs and runtime status
- `chatApi.ts` — chat send/interrupt/title/question flows
- `gitApi.ts` — git actions and payload shaping
- `workspaceApi.ts` — workspace IO, shell helpers. `searchEntriesDetailed` / `searchContentDetailed` return the truncation flag; `searchEntries` / `searchContent` are array-only wrappers for callers that do not show a list
- `wsClient.ts` — WebSocket connection + event subscription

## Electron Boundaries

- `apps/shell/main.cjs` — app lifecycle, window creation, backend loading
- `apps/shell/shared/urlPolicy.cjs` — trusted sender and navigation policy
- `apps/shell/shared/runtimeConfig.cjs` — injected renderer port and runtime metadata; the bearer stays in the main process

## Scripts

- `npm run dev` — Vite + Electron with the supervised local backend
- `npm run backend:build` — compile `apps/backend` (TypeScript → `dist`)
- `npm run backend:dev` — watch-mode TypeScript compile for `apps/backend` (does not rebuild native modules — run `backend:rebuild` separately if you reinstall)
- `npm run backend:rebuild` — rerun `electron-rebuild`
- `npm run build` — build the shared schemas and backend, then typecheck and build the renderer with chunk and size checks
- `npm run package:dir:win` / `package:dir:mac` / `package:dir:linux` — electron-builder dir builds
- `npm run package` — full Windows NSIS installer

- `npm run mobile:android` / `npm run mobile:ios` — generate the native project, then build and start a development build on a device, emulator or simulator
- `npm run mobile:start` — start Metro for an already installed development build
- `npm run mobile:check` — check the app config, native dependencies and the Android/iOS/web bundles
- `npm run mobile:prebuild` / `npm run mobile:icons` — regenerate the native projects or the icons
- `npm run mobile:toolchain` — show what the native builds need and what is missing
- `npm run mobile:apk -- <build|verify|e2e|all>` / `npm run mobile:ios:sim -- <build|e2e|all>` — build, check and device-test the Android APK or the iOS simulator app (see [mobile.md](mobile.md))
- `npm run typecheck:mobile` / `npm run test:mobile` — verify the React Native workspace
- `npm run test:e2e:remote` — build the backend, then run the phone app's network client against it in-process

## Codex CLI integration

The backend speaks directly to OpenAI's open-source `codex` CLI
([openai/codex](https://github.com/openai/codex)) so ChatGPT Plus/Pro/Team
subscribers don't need an API key.

Requirements:

- `codex` CLI installed and on your `PATH`
- `codex login` run once in a terminal (opens a browser for ChatGPT OAuth,
  stores tokens in `~/.codex/`)

When both are true, BetterC0de spawns `codex app-server` on demand — one
subprocess per active chat thread — and talks JSON-RPC over stdin/stdout.
The adapter reuses the same process across every turn in that chat, so
the expensive CLI-boot happens only once. You'll see a new provider entry
**Codex (CLI)** in the provider picker when it's available.

Models and reasoning options come from the CLI's live catalog. A saved model
selection is retained while that catalog loads. Failed refreshes preserve the
last successful account-specific catalog and its reasoning options.
Google and GLM are no longer offered as built-in provider groups.
Changing the model in a chat
pane also updates the selection used for its next message; changing reasoning
or context options keeps that model selected.

Each desktop chat pane shows its own model, reasoning and permission settings.
Changing a model affects that chat only, including older chats and newly opened
panes. The initially blank panel and a panel whose last chat tab was closed also
receive their own chat identity when used alongside other panels. An open model
picker closes when focus moves to another pane; model-picker
commands open it in the focused pane.
File reviews also belong to their chat: streaming and saved changes stay in that
pane, and review actions use its workspace and checkpoints. Dismissing a review
keeps the recorded diffs intact. Failed file restores remain visible with an error.
Chat file-change summaries preview five project files and load more on demand in
a bounded list. Temporary browser profiles, caches and generated directories are
grouped in a separate collapsed section, with their own count; they do not inflate
the project edit totals. Every recorded file remains accessible, and checkpoint
restore and Git views retain the complete change set. The same grouping applies
on mobile. Paths containing spaces remain intact, including binary files.
Large checkpoint diffs can be stored as a marked summary while their Git
snapshots retain the full file contents. Restarting the app recovers checkpoints
left pending by the earlier oversized-diff error without deleting chat history
or resetting the workspace.
Drafts, prompt history navigation, suggestions, file mentions, context usage and
dictation stay with their composer. Stop and live permission actions target the
chat that initiated them, including after a confirmation dialog. Plans retain
their source chat when opened for implementation; autonomous runs stay attached
to their starting chat when focus moves elsewhere.
Pasted text, including long blocks, stays visible and editable in the composer.
It is never replaced with a "Pasted lines" placeholder. Editing, undo, queued
messages and retries use the actual text; pasted images still become attachments.
The old paste-summary setting no longer applies. Its slash-command aliases remain
compatible and explain this behavior instead of toggling it.
Switching a running chat from **Ask first** to **Bypass Permission** also settles
its pending tool approvals, including Codex requests from an already running
turn. Later tool requests follow the new selection. Explicit ask/deny rules,
workspace trust and Plan/Ask/Read-only ceilings still apply; questions still
require answers. The permission menu and `/autoaccept` use the same live update.
If a provider can only apply a change on the next turn, the desktop shows a
notice; stop and resend to apply that change immediately. Failed live updates
remain visible and do not dismiss unanswered approvals.
Terminal commands and new-session requests target one chat or an explicitly
selected terminal panel. Existing terminal sessions retain their working
directory when switching tabs or opening a different project. Delayed folder
selections return to their originating pane; closing that composer discards the
pending UI action. Deleting a chat ends its autonomous run only after the backend
confirms deletion. The separate Plan tab retains the plan's source chat too.
Sending captures those settings and the destination chat immediately, so switching
tabs while project context loads does not move the message into another chat.
Send shows its pending state during preparation and ignores repeated clicks or
Enter presses. Text typed while sending stays in the draft. Intermediate agent
messages and approval requests keep the chat busy until the provider turn ends;
they do not trigger another autonomous iteration or unlock another send.
Preparation and routing failures appear in the originating chat. Catalog refreshes
ignore late responses from an older request or workspace.
When Electron reports a stopped or restarting backend, local requests fail
immediately without repeatedly dialing its old port. A ready event restores the
connection settings. Development servers stop when their Electron launcher exits,
so closing a development session does not leave Vite and TypeScript watchers behind.

Under the hood:

- `apps/backend/src/provider/runtime/codex/CodexSessionRuntime.ts` owns the
  JSON-RPC manager (spawn, pending-request map, timeouts, stderr ring
  buffer, graceful shutdown).
- `apps/backend/src/provider/runtime/codex/translator/` translates Codex
  notifications (`item/agentMessage/delta`, `item/completed`,
  `turn/completed`, `thread/tokenUsage/updated`, etc.) into the renderer's
  `ProviderRuntimeEvent` strings.
- On macOS, packaged apps do not inherit the user's interactive shell `PATH`.
  The backend resolves `codex` through the login shell and known install
  locations before spawning it, so Finder-launched builds work like `npm run dev`.
- The backend exits cleanly: every spawned `codex.exe` is killed from the
  root `stop()` path, so `tasklist | findstr codex` shows zero leftovers
  after quitting.

If Codex is installed but unauthenticated, `GET /api/v1/cli/status` returns
`codex.authenticated: false` and the onboarding flow can surface a
"Login to ChatGPT" call-to-action that spawns `codex login` on the user's
behalf.

## Native modules

Normal development uses a forked backend with native modules built for the local Node runtime. `npm ci` and the development launcher prepare that binding. Packaging separately rebuilds native modules for Electron and restores the local Node setup afterward. Use `npm rebuild better-sqlite3` if standalone backend tests report a Node ABI mismatch; use the packaging scripts for Electron builds.

## Claude CLI on macOS

Claude CLI uses Anthropic's Agent SDK and local `claude` binary. On macOS,
Keychain access is tied to the signing identity of the executable that wrote
the token. BetterC0de therefore prefers the user's installed system `claude`
over the SDK-bundled fallback, avoiding a packaged-app hang when the bundled
binary cannot read the user's existing Keychain entry.

Override with `BETTERC0DE_CLAUDE_CODE_PATH=/absolute/path/to/claude` when
testing CI builds or a specific Claude Code binary.

## Verification

`npm run verify:source` runs the whole gate CI uses (workspace versions,
schema build, Desktop/Backend/Mobile typechecks, lint, packaging tests, and all three test suites).
Individually:

- `npm run typecheck` / `npm run typecheck:backend` — renderer / backend types
- `npm test` / `npm run test:backend` — renderer / backend test suites
- `npm run lint`
- `npm run smoke:multichat` — real composer, model-dropdown and file-review interactions in
  an isolated Electron profile, covering pane ownership, provider changes,
  picker commands, review actions, failed restores, drafts, history, context
  usage, file mentions, dictation, permission confirmation and autonomous
  continuation after focus changes, delayed project selection, and terminal
  event/working-directory ownership
- `node --check apps/shell/main.cjs` — main-process syntax
- `npm run perf:backend` — backend startup time and memory budget
- `npm run build:frontend` — also enforces the chunk-cycle and bundle-size
  budgets, including how many bytes load before the first frame
- `npm run package:dir:win` / `:mac` / `:linux` — local package smoke build

## Naming Rules

- TypeScript files: `camelCase`
- Folders: `kebab-case` where new feature folders are introduced
- Public endpoint paths remain stable across releases (frontend contract)
