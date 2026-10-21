# Shared project canvas

Canvas mode uses a single `useCanvasTransform` camera and dot grid. Project
frames are positioned in that camera's coordinate space. They never own a
second canvas or zoom state. Saved positions live in renderer-local storage;
URLs and device selections use the existing per-thread settings persistence.
Missing/deleted threads are not rendered. Removing a frame does not delete a
thread or stop its server.

The design setup wizard has been removed. Existing `designBrief` thread settings
remain compatible with prompt assembly and can be inspected or cleared from
their frame's brief popover through the existing `setThreadSetting` path. New
canvas projects do not create a brief or require setup before using previews.

The shell mounts the same workspace sidebar as Editor mode to the left of the
canvas, following the active thread's runtime path. The shared chat workbench
sits to the right. A ResizeObserver measures the space remaining after the file
sidebar so resizing or collapsing it re-clamps chat width without overwriting
the saved preference. The account footer is shared across all three modes.

The shared sidebar includes a Diff view using the existing `DiffPanel` and Git
endpoints. Its instance is keyed by runtime path so a checkout change discards
the old selection and in-flight display state. `lib/diff-view.ts` routes sidebar,
shortcut, palette, slash and Settings actions to this view in Editor and Design
modes; Agent keeps its existing diff surface. The sidebar view is persisted, and
closing it returns to Files. No provider, mobile or permission contract changes.

In Editor mode, `DiffPanel` renders only the changed-file list in the sidebar.
`EditorTab.diff` identifies a comparison by checkout, Git path and staged/unstaged
source; the central editor lazily mounts the same viewer for that fixed target.
Comparisons never participate in file saves or AI content reloads, and a missing
patch does not select another file. Navigation and reopening preserve the source.
Canvas mode keeps the full sidebar viewer, since the center belongs to its canvas.

## Element inspector and Select ⇄ Browse

The editor's preview panel and the canvas share one `SelectBrowseToggle` and
one `ElementInspector`; the inspector's state and transitions are the pure
`browser-preview/inspector-state.ts`. The editor keeps that state in its panel.
The canvas keeps it in `design/canvas-preview-store.ts` because several
previews feed one side panel: each card device registers its viewport handle
under `threadId::deviceId`, reports its DOM tree, picks and navigations, and the
store remembers which viewport the inspector follows (the last one picked in or
touched). Style edits post to that viewport only. The Select ⇄ Browse mode is
canvas-wide; the hand tool still overrides it. Static rendering reads a store's
initial snapshot, so component tests mock the store as a selector over a fixture.

## Runtime pane

`designRuntimePane` on the thread settings adds a fourth slot to a card
(`RUNTIME_PANE_WIDTH` stage pixels × card scale, not × the half-size preview;
`canvasProjectSize` grows by it). `design/canvas-runtime-pane.tsx` shows the
requests the card's preview guests made, the endpoints they imply, the dev
server log beside the pages' console, and the thread's folded tool runs
(`design/canvas-runtime.ts` holds the pure derivations).

Requests come from the shell: `apps/shell/preview-request-capture.cjs` listens
on the preview session's `webRequest` (non-blocking `onSendHeaders`, then
`onCompleted` / `onErrorOccurred`), skips static asset types, and broadcasts one
`preview:request` event per finished request keyed by the guest's
`webContentsId`. `PreviewViewportHandle.getWebContentsId()` lets a card map its
viewports to those ids; `design/canvas-runtime-store.ts` keeps a capped ring per
guest and per viewport (console). Replaying an endpoint runs a `fetch` inside
the page, so it carries the page's cookies and shows up in the log again; only
GET and HEAD are offered.

Card model metadata uses only its own thread's stream, provider-scoped settings
and recorded messages, with display names from the renderer's provider catalog.
The running model takes precedence during a turn; idle cards show the selected
model before history. Branch labels query existing Git endpoints at the runtime
path instead of trusting the thread's creation-time branch. Concurrent reads for
one path share a request. Refreshes pause while hidden and on access failures;
focus, turn transitions and the branch button can refresh them. These reads do
not update thread metadata or register/trust a workspace.

Each frame resolves its runtime path with `resolveThreadRuntimePath`, including
worktrees, and uses the existing per-path dev-server registry. Only an explicit
saved URL is probed; guessing port 3000 would connect unrelated projects to the
same application. Adding a folder registers it through the existing workspace
API before creating a chat. Filesystem and PTY operations retain backend trust
and permission checks. No new provider adapter, backend write path, HTTP
contract, shell IPC or mobile behavior is introduced.

All device guests use their native CSS viewport dimensions, presented at a
constant scale inside the frame, before the shared camera transform. Element
selection captures the originating thread ID. It enters the existing browser
context store and opens that thread through the shared chat-tab event.

Every guest is its own Chromium renderer process, so the board keeps only some
of them live. `lib/canvas-live-guests.ts` (`decideCanvasGuests`, used through
`hooks/use-canvas-live-guests.ts`) mounts a device preview or embedded page
only while it is near the viewport, large enough on screen to read, and within
`MAX_LIVE_CANVAS_GUESTS` (6). The guest the inspector follows and the selected
embed are pinned and stay live; the active chat's card and recently used
guests rank next. Separate enter and exit margins and sizes keep a guest from
flickering at the edge. A paused guest shows a same-size placeholder that says
why and how to load it again; a paused device keeps its console entries.

Alt temporarily enables the pan shield; V selects the pointer and H selects
the hand tool when focus is in the canvas and outside editable controls.
Temporary navigation keeps preview selection overlays mounted, so releasing a
modifier does not steal focus from chat. Guest Alt presses use the existing
keyboard bridge and return focus to the canvas to receive keyup. Blur and
visibility changes clear held modifiers; Ctrl+Alt stays available for AltGr.

Working status comes from the provider-independent stream/session selector,
including turns resumed after reconnect or started on mobile. Frames animate
twice at task start, then hold a static cue. Reduced motion disables animation.
Neither token updates nor an idle canvas schedule repainting animations.

Pointer dragging uses a capture overlay across guest iframes. It commits only on
pointer release; Escape, cancellation or focus loss discard the draft position.
Arrow-key movement uses the same saved positions. Moving a frame does not fit
the camera; Fit all is explicit so a drag cannot move its own coordinate system.
