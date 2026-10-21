# Editor workspace

Editor mode uses a workspace sidebar, a code surface, and a resizable chat
surface. The sidebar switches between Files, Search, and Git; the menu also
exposes outline, code map, and references. It uses the same surface tokens and
menu primitives as Agent mode. Agent mode retains its existing pane grid.
The sidebar, the code surface, and the chat are rounded cards on the shell
surface with 8 px gaps, matching Agent mode's floating chat card; the empty
state without a folder uses the same frame. All three cards use the dark
`--background` surface, and the dark workbench Monaco theme paints the default
dark background (`#0f0f0f`) so the editor blends into its card. The view tabs
sit in a slightly raised bar with the canvas toolbar's flat active fill
sliding to the selected view, measured per tab; the More button takes the fill
when the active view lives in its menu.
Open Files, the workspace tree, and Recent Files use independent collapsible
headers with counts. The workspace header remains reachable while scrolling;
its creation icons stay available when collapsed and reopen the tree when used.
Reveal in Explorer
reopens the workspace and preserves expanded child folders. Agent file panes
and the File Explorer dialog also allow the workspace tree to collapse.
Their expanded state is saved in local renderer storage and survives changing
sidebar views. File actions use the existing editor store and dirty-file
confirmation; recent files reopen at their remembered cursor position.
Tree rows are 28 px high with 12 px labels and 18 px icons, increasing to
13 px labels and 20 px icons on large displays. Creation and rename inputs
follow the same sizing; Open Files and Recent Files use 13 px file names.

Material Icon Theme is pinned as a development dependency. `npm run icons:sync`
copies the official SVGs and MIT license into `apps/ui/public/file-icons` and
generates the checked-in association table. The renderer uses the shared
`file-icons.ts` resolver for specific names, path suffixes, compound extensions,
and expanded folder variants, including the system file browser. Generated CSS
selects the official light icon variants using the app's theme class. No extension
runtime or network icon fetch runs in the app.
Monaco keeps its local HTML, JavaScript/TypeScript, JSON, and CSS workers.
Additional JSON MIME aliases enable JSON-LD and import-map tokenization inside
HTML. The first embedded JSON encounter initializes Monaco's JSON tokenizer
through a temporary empty model, which is immediately disposed. Workbench
syntax rules distinguish tags, attributes, keywords, strings,
numbers, and JSON keys in dark and light modes without changing editor surfaces.

The shared desktop `DiffPanel` uses the active background and semantic theme
tokens in Editor, Agent, and workspace panes. `diff-syntax.ts` lazily loads the
existing Shiki highlighter for the selected file, tokenizes old/new revisions
separately, and keeps both theme palettes. Large files skip tokenization; source
text and independently applicable hunk patches remain intact. `DiffHunkLines`
renders paired cells in shared grid rows so wrapping cannot misalign revisions.
The file list uses `diffFileListWidth` in renderer preferences. Pointer capture
keeps divider drags inside the panel; only completed drags persist the width.
Cancellation or closing the list discards the temporary width. A ResizeObserver
clamps the visible width to the containing pane while preserving the saved
preference for larger panes. At narrow widths the list remains horizontal and
the divider is hidden. Scoped scrollbar parts follow the active theme without
Chromium's native `scrollbar-width: thin` override.
Stage, Discard, and Unstage still use the existing backend Git routes and their
permission, trust, conflict, and idempotency checks. Mobile has a separate diff
view and does not consume this desktop component.

The shared project tree supports internal drag-and-drop in Editor, Agent panes,
and the File Explorer dialog. A directory row's center targets that directory;
its top and bottom 8 px target the parent, with an insertion line at that depth.
File rows target their parent, and the workspace header targets the root.
Entries retain alphabetical sorting. Only hovering inside a target opens it
after 500 ms; moving to an edge cancels expansion. Row action icons are hidden
during dragging so the full width is available. External drags, moves to the
current parent, and moves into the source's descendants are ignored. Moves use
the existing `/workspace/move` route and its trust and checkpoint recovery gates.
The backend rejects occupied destinations with 409 before renaming and rejects
descendant destinations before creating parent directories. On success, the
editor store rebases open buffers, recent files, and navigation history; the tree
refreshes and reveals the destination. Failures leave editor paths unchanged and
appear in the tree. Mobile has no equivalent draggable project tree.

Workspace identity comes from the selected thread's runtime path, including
worktrees. Recent workspace choices come from loaded conversation history.
When entering the editor without a project, `useEditorWorkspace` waits for
history and restores the last known workspace and selected conversation.
An explicit editor launch folder takes precedence and is resolved after
history loads, avoiding duplicate threads on reload.

The editor stores its last workspace path and chat layout metadata in local
renderer storage. Layout metadata contains tab IDs, thread IDs, labels, and
the selected split. Messages and activities remain in the backend's existing
persistence and journal paths. This does not persist code buffers or replace
the thread history service. Invalid layout metadata falls back to a fresh tab.
Saved chats absent from loaded history remain visibly unavailable and cannot
accept messages until reopened from history.

Editor chat panels always use a single-column stack, with a minimum row height
and vertical scrolling in short windows. Top/bottom tab drop zones reorder that
stack. Adding an ordinary chat selects it in a single panel. The layout menu
and tab context menus enter and leave stacked views without deleting conversations.
Empty chats place their flexible spacer above the composer; populated chats use
the scrolling transcript there. The composer does not shrink. Tab titles size to
their content, shortcuts are in tooltips, and New chat/layout actions sit outside
the scrolling tab strip. The Agent mode pane grid retains its own layout.

The workspace overview and Files view retain bounded recursive scans. A
separate root directory listing keeps top-level folders reachable when the
scan is capped; expanding folders uses the existing backend directory reader.
Counts indicate truncation, and failed loads offer a retry.
The overview groups project identity, search and preview actions, scan counts,
key files, and a file-type breakdown using the existing theme tokens. Container
queries stack these sections according to the editor pane's width. The chart
uses all scanned files as its denominator; file types omitted from the summary
and files without extensions remain represented in a remaining-files segment.
This is renderer presentation only; scan limits and workspace authorization are
unchanged.

The Code Map sidebar uses the existing `/workspace/map` response, with a pinned
workspace summary and separate Overview/Files views. Folder filters match path
boundaries (including a distinct root-only filter), then combine with text and
kind filters; filter counts describe the current folder/search scope. The index
still renders at most 80 rows and asks the user to refine larger result sets.
Collapsible summary sections and type expansion remain local UI state. Workspace
changes remount the map so old selections and filters cannot carry into another
project. File open/reveal and brief copying retain their existing APIs; the
backend scan limits and trust checks are unchanged. The map is desktop-only,
shared by the sidebar and command-palette entry point, with no provider or
mobile contract changes.

Monaco stays lazy loaded. Editor panes use named themes and temporarily enable
JSX parsing, retaining diagnostics. Language defaults are restored when the
last editor pane closes, preserving the Agent file modal's configuration.
Search target positions are recovered from the tab store when a lazy editor
mounts after the navigation event.

The browser shares the file tab strip and stays mounted when switching back
to a file. Its last URL is saved per workspace; desktop history follows the
guest page's actual navigation. The element inspector starts collapsed.

Desktop element selection uses a host overlay above the isolated webview.
Pointer and keyboard picks never reach the guest page. The overlay reads a
bounded snapshot (URL, selector, tag, label and text) and scrolls the inspected
page on wheel input. It does not collect input values or raw HTML. Design's
select tool uses the same overlay; Browse in the editor removes it. The
sandboxed iframe fallback retains browsing but does not offer element picking.

`ElementInspector` owns only inspector presentation and filtering. The parent
preview panel keeps selection, tab and pending CSS state. Tree filtering retains
ancestors and selectors; keyboard navigation and preview picks use the same
selection callback. Inspector surfaces and scrollbars use the app theme tokens.
No new page reads, navigation permissions or workspace access paths are added.

The Styles inspector uses shared numeric controls for Design and CSS views.
Pointer capture keeps scrubbing active outside the field, and preview updates
are limited to one per animation frame while dragging. Escape, pointer
cancellation, and window blur restore the starting value; cleanup releases
capture and global listeners. CSS units are preserved, unsupported expressions
remain editable as text, and each spacing side is independent. Pending edits
coalesce by selector/property and disappear when restored to their original
value. Style changes stay in the existing preview transport and Send to AI
path; the inspector never writes workspace files directly.

Draft element references are scoped to a thread, deduplicated by URL and
selector, and capped at 16 per message. Sending captures the originating
thread's picks; a failed send retains them, and a successful send removes
only that captured set. Tags added meanwhile or in another chat survive.
Draft references use bounded local renderer storage. Sent references use the
existing attachment metadata contract and durable chat dispatch lane, so
desktop and mobile can show tags again after reload. Provider dispatch filters
these metadata attachments from native file inputs; selected elements enter
the prompt and restored history as explicitly untrusted reference text.

Filesystem, search, replacements, Git, and provider dispatch continue to use
the backend APIs and existing permission and trust checks. No adapter-specific
selection API, new message write path, or shell bridge is introduced.

## Queued composer drafts

The desktop composer stores unsent follow-ups in `message-queue-store`, using
the same local renderer storage boundary as draft element references. Enqueue
persists before acknowledging submission, so a full storage quota leaves the
original draft intact. Text, converted attachments and browser references are
captured together; later selections are not consumed when a queued draft sends.

One app-level queue runner watches turn completion for every queued thread,
independently of pane focus. A persisted claim prevents duplicate delivery by
multiple subscriptions. Each entry uses a stable user-message ID and timestamp
through the existing chat submission and backend dispatch receipt lane. Only
definitive busy responses are retried automatically; other failures pause the
thread's queue. Restarted queues require explicit Resume, including interrupted
claims whose delivery may already have reached the provider. Stop pauses queued
drafts before the local stream finalizes, and queued input takes precedence over
automatic autonomous-loop continuation.

Queued drafts stay editable until they are claimed. `lib/message-queue-editing`
holds the pure changes (edit a payload, move up or down, move in front of
another entry, add at the front, claim for steering); an entry being sent is
never edited or moved and nothing moves in front of it. The store persists each
change like an enqueue, so a restart restores the edited order paused. The
panel above the composer edits text, attachments and browser references inline,
reorders by native drag and drop (its own drag type, so pane drop zones ignore
it) or the item menu, and Alt+Up in an empty composer opens the last editable
entry; the global Alt+Up chat switch yields in that case. While the chat's next
entry is open in the editor, the runner treats the thread as busy, so the old
text is not sent.

Steering sends a draft into the running turn instead of after it. The entry is
added at the front (or moved there by **Steer now**) and claimed like a send,
then `lib/chat/steer-turn` posts it to `/chat/steer` with its queue id as the
user-message id. The backend resolves the thread's hub instance, runs the user's
on-message-send hooks and calls the adapter's optional `steerTurn`; only a
`steered` answer stores the message (`ThreadService.persistSteeredUserMessage`,
placed in front of the turn's stored answer so a reload reads request, steer,
answer). Codex implements it with app-server `turn/steer`, which names the
expected turn id, so input never lands in a later turn; an app-server without
the method answers `unsupported`. Claude Code runs each turn as one
single-message SDK query whose input closes at the first result, and ACP,
compatibility and API providers run a turn as one request, so they answer
`unsupported`. Then the renderer interrupts the turn without pausing the queue
and the entry, still first, goes out through normal dispatch as the next turn.
`not_running` and `not_steerable` (a review or compaction) leave it first for
the next turn. Slash commands and drafts that change the turn itself (a mode
override, a plan to implement, an Autonomous Work run) are never steered. A
steered message carries its text, images and picked browser elements; unlike a
turn's first message, its @-mentions are not expanded into file contents (the
running agent can open those files itself).

`settings.while_working_enter` (Queue or Steer) decides what Enter does while a
turn runs; Ctrl/Cmd+Enter does the other one. The composer binds that choice to
the one submit event it starts, so a skipped submit cannot carry it over.

This is a desktop composer feature, shared by Agent, Editor and Design views,
and it works with every adapter through normal chat dispatch and current thread
permissions. The phone app keeps its own queue with the same shared rules
(`@betterc0de/schema/message-queue`) and no editing or steering yet; its
dispatch contract is unchanged. Paired devices may call `/chat/steer` wherever
they may send.

## Skills in the slash picker

The shared desktop composer lists enabled provider skill metadata alongside
built-in, project and provider commands, with All/Commands/Skills filters.
Selecting a provider skill inserts its existing native `$skill` token. A typed
`/skill` alias is resolved in `lib/chat-commands/input-context` before local command
dispatch, preserving the visible user text. Built-ins and native provider
commands take precedence over aliases; runtime/project skill routing is unchanged.
Built-in commands run through the dispatcher below, and the normal submission
lane still owns permissions, queues and message persistence.

Claude, Codex, Claude Terminal and BetterC0de-compatible providers reuse the same
native skill path as the `$` picker. Cursor and Grok expose skills here only if
their provider metadata contains them; commands are not inferred to be skills.
This changes no adapter protocol or HTTP contract and reads no skill files in
the renderer. Mobile has no equivalent slash picker; its dispatch is unchanged.

## Slash command dispatch

Each built-in command family is a spec, `{ names, when?, run }`
(`SlashCommandSpec` in `lib/chat-commands/slash-registry.ts`), kept in a
`*-slash-specs.ts` file next to the builders and actions it uses. `names`
lists the commands without the leading slash; `when` narrows a spec to some
arguments, such as `/mcp add`. `builtin-slash-specs.ts` registers the specs
in two ordered phases:

1. `PRE_RUNTIME_SLASH_SPECS` (composer, session, thread, message scroll,
   workspace) run before anything is loaded. Their names never overlap, which
   `builtin-slash-specs.test.ts` checks, so their order does not matter.
2. `RUNTIME_SLASH_SPECS` run after `lib/slash-command-runtime.ts` loads the
   runtime MCP servers, skills and subagents and the workspace's project
   configuration once. Here list order is precedence: for a shared name the
   first spec whose `when` passes handles the command, so subcommand specs
   (`/mcp add`, `/providers login`) sit ahead of the spec that owns the bare
   name.

A spec either returns a result, which ends the command, or returns nothing
and lets the run continue with the output it set; `/resume <title>` that
finds no chat continues to the session list, `/models <query>` to the model
catalog. A command that no spec answered can still name a runtime MCP server,
skill or subagent; otherwise it goes to the normal submit flow.
`BUILTIN_SLASH_COMMAND_NAMES` is derived from the specs, so adding a spec is
how a command becomes a built-in. `slash-command-runtime.ts` (about 600 lines)
holds only this dispatch, the runtime-list loading and re-exports for
existing import sites; the submit hook imports it on demand. Add a command by
adding a spec to the matching `*-slash-specs.ts` file, or a new file listed
in `builtin-slash-specs.ts`, not by branching in the runtime.

## Settings compatibility and checkpoint context

The shared settings schema normalizes legacy `null` values only for optional
string fields. Its output stays `string | undefined`; required fields, invalid
types and undecryptable secrets retain the existing write protection. Loading
does not rewrite a file solely for this normalization. The normal validated,
locked settings save persists the canonical form and preserves encrypted keys.
Both desktop and mobile continue using the same redacted settings contract.

The desktop settings store reports and rolls back failed saves, and attaches a
rejection handler for controls that do not await the result. It returns the
original promise so awaited workflows can still stop after a failed save.

File checkpoints capture the originating thread's runtime path at stream
finalization and carry it through asynchronous file reads to the branch lookup.
They never default to the backend process directory or the currently focused
chat. Registration and workspace trust enforcement remain on the backend.
This applies to every provider through shared desktop finalization; mobile uses
backend checkpoints and has no corresponding renderer file-checkpoint path.
