import { memo, useCallback, useRef, useState, type PointerEvent } from "react"
import {
  ArrowUpRightIcon,
  FolderIcon,
  GitBranchIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  MoveDiagonal2Icon,
  PauseIcon,
  RefreshCwIcon,
  ServerIcon,
  XIcon,
} from "lucide-react"
import { useChatStore } from "@/lib/chat-store"
import { useThreadIsRunning } from "@/lib/chat/running-selectors"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { canvasModelSelection } from "@/lib/canvas-project-info"
import { getModelInfo } from "@/lib/get-model-info"
import type { UiProvider } from "@/lib/provider-types"
import { ProviderIcon } from "@/components/provider-icon"
import { useWorkspaceBranch } from "@/hooks/use-workspace-branch"
import { useCanvasGuestState } from "@/hooks/use-canvas-live-guests"
import type { CanvasGuestState } from "@/lib/canvas-live-guests"
import {
  PROJECT_HEADER_HEIGHT,
  PROJECT_FOOTER_HEIGHT,
  PREVIEW_SCALE,
  canvasCardScale,
  canvasProjectLayout,
  canvasDevices,
  canvasProjectSize,
  resizeCardScale,
  type CanvasPlacement,
  type CanvasPoint,
} from "@/lib/project-canvas"
import { CanvasChatStatus } from "./canvas-chat-status"
import { useCanvasPreviewSource } from "@/hooks/use-canvas-preview-source"
import { CanvasPreviewSourceControl } from "./canvas-preview-source-control"
import { useDevServer } from "@/hooks/use-dev-server"
import {
  CANVAS_DEVICE_PRESETS,
  type CanvasDevicePreset,
} from "@/components/browser-preview/constants"
import type { PreviewViewportHandle } from "@/components/browser-preview/preview-viewport"
import type {
  ConsoleLog,
  DomNode,
  SelectedElement,
} from "@/components/browser-preview/types"
import { DesignArtboard } from "./design-artboard"
import {
  canvasViewportKey,
  registerCanvasViewport,
  useCanvasPreviewStore,
} from "./canvas-preview-store"
import { CanvasRuntimePane } from "./canvas-runtime-pane"
import { useCanvasRuntimeStore } from "./canvas-runtime-store"
import {
  ArtboardEmptyState,
  BriefPopover,
  ServerStatusPill,
  ToolButton,
} from "./design-preview-controls"
import { cn } from "@/lib/utils"

type ProjectFrameProps = {
  providers?: UiProvider[]
  placement: CanvasPlacement
  active: boolean
  panActive: boolean
  onOpenChat: (threadId: string) => void
  onRemove: (threadId: string) => void
  onMoveStart: (event: PointerEvent, origin: CanvasPlacement) => void
  onMove: (threadId: string, point: CanvasPoint) => void
  onElementSelected: (threadId: string, element: SelectedElement) => void
  onShortcut: (shortcut: string) => void
  /** Canvas scale, used only to convert resize gestures into stage pixels. */
  zoom: number
}

export const CanvasProjectFrame = memo(function CanvasProjectFrame({
  providers = [],
  placement,
  active,
  panActive,
  onOpenChat,
  onRemove,
  onMoveStart,
  onMove,
  onElementSelected,
  onShortcut,
  zoom,
}: ProjectFrameProps) {
  const { threadId } = placement
  const thread = useChatStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const settings = useChatStore((state) => state.settingsByThread[threadId])
  const running = useThreadIsRunning(threadId)
  const currentModel = useChatStore(
    (state) => state.streamingByThread[threadId]?.streamingModelId
  )
  const projectPath = resolveThreadRuntimePath(thread)
  const branch = useWorkspaceBranch(
    projectPath,
    `${running}:${thread?.branch ?? ""}`
  )
  const dev = useDevServer(projectPath)
  const devices = canvasDevices(settings)
  const cardScale = canvasCardScale(settings)
  const layout = canvasProjectLayout(settings)
  const size = canvasProjectSize(settings)
  const preview = useCanvasPreviewSource(threadId, projectPath, settings, dev)
  const { url } = preview
  const selectionMode = useCanvasPreviewStore((state) => state.selectionMode)
  const viewports = useRef(new Map<string, PreviewViewportHandle>())
  // Corner drag: the card keeps its aspect ratio, so horizontal travel alone
  // sets the scale. Live store writes are debounced by the store itself.
  const resize = useRef<{
    pointerId: number
    startX: number
    startScale: number
    startWidth: number
  } | null>(null)
  const setCardScale = (next: number | undefined) =>
    useChatStore.getState().setThreadSetting(threadId, "designCardScale", next)
  const stepCardScale = (delta: number) =>
    setCardScale(
      canvasCardScale({
        designCardScale: Math.round((cardScale + delta) * 100) / 100,
      })
    )
  const navigate = (next: string | null) =>
    preview.select(next ? { kind: "url", url: next } : { kind: "server" })

  if (!thread) return null
  const selection = canvasModelSelection(
    thread,
    settings,
    currentModel,
    running
  )
  const provider =
    providers.find((item) =>
      selection.source === "selected"
        ? item.id === settings?.selectedProviderId
        : item.providerInstanceId === thread.session?.providerInstanceId &&
          Boolean(item.providerInstanceId)
    ) ??
    providers.find(
      (item) =>
        selection.source !== "selected" &&
        item.providerKind === thread.session?.providerKind &&
        Boolean(item.providerKind)
    )
  const model = getModelInfo(selection.id)
  const modelLabel =
    provider?.models.find((item) => item.id === selection.id)?.name ??
    model?.name ??
    "Model not recorded"
  const modelSource = {
    current: "Running model",
    selected: "Selected model",
    used: "Last used model",
    unknown: "No model recorded",
  }[selection.source]
  const toggleDevice = (id: CanvasDevicePreset["id"]) => {
    const ids = devices.map((device) => device.id)
    const next = ids.includes(id)
      ? ids.filter((item) => item !== id)
      : [...ids, id]
    if (next.length)
      useChatStore
        .getState()
        .setThreadSetting(threadId, "designDevicePresets", next)
  }
  const refresh = () =>
    viewports.current.forEach((viewport) => viewport.reload())
  const beginResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScale: cardScale,
      startWidth: canvasProjectSize(settings).width,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      resize.current = null
    }
  }
  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const current = resize.current
    if (!current || current.pointerId !== event.pointerId) return
    setCardScale(
      resizeCardScale({
        startScale: current.startScale,
        startWidth: current.startWidth,
        deltaX: event.clientX - current.startX,
        zoom,
      })
    )
  }
  const endResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resize.current?.pointerId === event.pointerId) resize.current = null
  }

  return (
    <div style={{ width: size.width, height: size.height }}>
      <article
        data-canvas-project={threadId}
        data-active={active || undefined}
        data-working={running || undefined}
        aria-label={`${thread.projectName || "Project"} preview`}
        className={cn(
          "relative rounded-2xl bg-card text-foreground shadow-xl ring-1 ring-border/70",
          active && "ring-2 ring-primary/55"
        )}
        style={{
          width: layout.width,
          transform: `scale(${cardScale})`,
          transformOrigin: "0 0",
        }}
      >
        <header
          data-canvas-controls
          className="flex flex-col justify-center gap-2 rounded-t-2xl border-b border-border/60 bg-sidebar p-4"
          style={{ height: PROJECT_HEADER_HEIGHT }}
          onPointerDown={(event) => {
            if (
              event.target instanceof Element &&
              !event.target.closest("button,input")
            )
              onMoveStart(event, placement)
          }}
        >
          <div className="flex h-7 min-w-0 shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={`Move ${thread.projectName}`}
              title="Drag to move · arrow keys to nudge · Shift for larger steps"
              onPointerDown={(event) => onMoveStart(event, placement)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key
                  )
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                const step = event.shiftKey ? 100 : 10
                onMove(threadId, {
                  x:
                    placement.x +
                    (event.key === "ArrowLeft"
                      ? -step
                      : event.key === "ArrowRight"
                        ? step
                        : 0),
                  y:
                    placement.y +
                    (event.key === "ArrowUp"
                      ? -step
                      : event.key === "ArrowDown"
                        ? step
                        : 0),
                })
              }}
              className="-ml-1 flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
            >
              <GripVerticalIcon className="size-4" />
            </button>
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-sm font-semibold"
              title={projectPath ?? undefined}
            >
              {thread.projectName || "Project"}
            </span>
            <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {thread.worktreePath ? "Worktree" : "Local"}
            </span>
            <CanvasChatStatus
              threadId={threadId}
              running={running}
              hasError={Boolean(thread.session?.lastError)}
            />
            <ToolButton
              title={`Remove ${thread.projectName} from canvas`}
              onClick={() => onRemove(threadId)}
            >
              <XIcon className="size-3.5" />
            </ToolButton>
          </div>
          <div className="flex h-6 min-w-0 shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
            <span
              className="min-w-0 flex-1 truncate font-mono"
              title={projectPath ?? undefined}
            >
              {projectPath || "No folder attached"}
            </span>
            <button
              type="button"
              onClick={branch.refresh}
              disabled={!projectPath}
              aria-label={`Branch: ${branch.label}. Refresh branch`}
              data-canvas-branch={branch.status}
              className="flex max-w-[45%] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border/50 px-2 py-1 text-[11px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none"
              title={`${branch.label}\n${projectPath || "No folder attached"}\nClick to refresh from Git`}
            >
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{branch.label}</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => onOpenChat(threadId)}
            aria-label={`Open chat: ${thread.title || "Untitled chat"}`}
            aria-current={active ? "true" : undefined}
            className="group flex h-14 min-w-0 shrink-0 items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 text-left transition-colors hover:border-muted-foreground/40 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="mb-1 flex min-w-0 items-center gap-2 text-[10px] leading-3 text-muted-foreground">
                <span className="shrink-0">
                  {active ? "Active chat" : "Chat"}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  data-canvas-model={selection.source}
                  aria-label={`${modelSource}: ${modelLabel}`}
                  title={`${modelSource}: ${modelLabel}`}
                  className="inline-flex min-w-0 items-center gap-1.5"
                >
                  {provider && (
                    <ProviderIcon
                      provider={provider}
                      className="size-3 shrink-0"
                    />
                  )}
                  <span className="truncate">{modelLabel}</span>
                </span>
              </span>
              <span
                className="block truncate text-[13px] leading-4 font-medium"
                title={thread.title || "Untitled chat"}
              >
                {thread.title || "Untitled chat"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground group-hover:text-foreground">
              Open chat <ArrowUpRightIcon className="size-3.5" />
            </span>
          </button>
        </header>
        <div className="p-4">
          <div
            data-canvas-controls
            className="mb-3 flex h-10 min-w-0 items-center gap-2"
          >
            <CanvasPreviewSourceControl preview={preview} />
            {preview.source.kind === "server" && <ServerStatusPill dev={dev} />}
            <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" />
            <ToolButton title="Refresh all device previews" onClick={refresh}>
              <RefreshCwIcon className="size-3.5" />
            </ToolButton>
            {CANVAS_DEVICE_PRESETS.map((device) => (
              <ToolButton
                key={device.id}
                title={`Toggle ${device.label} preview`}
                active={devices.some((item) => item.id === device.id)}
                onClick={() => toggleDevice(device.id)}
              >
                {device.icon}
              </ToolButton>
            ))}
            <ToolButton
              title="Toggle runtime pane (requests, endpoints, logs, tools)"
              active={Boolean(settings?.designRuntimePane)}
              onClick={() =>
                useChatStore
                  .getState()
                  .setThreadSetting(
                    threadId,
                    "designRuntimePane",
                    settings?.designRuntimePane ? undefined : true
                  )
              }
            >
              <ServerIcon className="size-3.5" />
            </ToolButton>
            {settings?.designBrief && (
              <BriefPopover
                brief={settings.designBrief}
                onRemoveBrief={() =>
                  useChatStore
                    .getState()
                    .setThreadSetting(threadId, "designBrief", undefined)
                }
              />
            )}
          </div>
          <div className="flex items-start gap-4">
            {devices.map((device) => (
              <ProjectDevice
                key={device.id}
                guestId={canvasViewportKey(threadId, device.id)}
                device={device}
                url={url}
                panActive={panActive}
                slotScale={PREVIEW_SCALE}
                selectionMode={selectionMode}
                register={(handle, paused) => {
                  const key = canvasViewportKey(threadId, device.id)
                  if (handle) viewports.current.set(device.id, handle)
                  else viewports.current.delete(device.id)
                  registerCanvasViewport(key, handle)
                  if (handle) return
                  useCanvasPreviewStore
                    .getState()
                    .forgetViewport(threadId, device.id)
                  // The guest is gone either way; a paused preview keeps its
                  // console lines for when it loads again.
                  useCanvasRuntimeStore
                    .getState()
                    .releaseViewport(key, { keepConsole: paused })
                }}
                onGuestChange={(webContentsId) =>
                  useCanvasRuntimeStore
                    .getState()
                    .bindGuest(
                      canvasViewportKey(threadId, device.id),
                      webContentsId
                    )
                }
                onElementSelected={(element) => {
                  const pageUrl = element.url || url || ""
                  onElementSelected(threadId, { ...element, url: pageUrl })
                  useCanvasPreviewStore
                    .getState()
                    .reportElement(threadId, device.id, pageUrl, element)
                }}
                onDomTree={(tree) =>
                  useCanvasPreviewStore
                    .getState()
                    .reportDomTree(threadId, device.id, tree)
                }
                onNavigate={(nextUrl) =>
                  useCanvasPreviewStore
                    .getState()
                    .reportNavigation(threadId, device.id, nextUrl)
                }
                onConsoleEntries={(entries) =>
                  useCanvasRuntimeStore
                    .getState()
                    .recordConsole(
                      canvasViewportKey(threadId, device.id),
                      entries
                    )
                }
                onFocus={() =>
                  useCanvasPreviewStore
                    .getState()
                    .focusViewport(threadId, device.id, url ?? "")
                }
                onShortcut={(shortcut) => {
                  const viewport = viewports.current.get(device.id)
                  if (shortcut === "reload-page") viewport?.reload()
                  else if (shortcut === "navigate-back")
                    viewport?.goBackInPage()
                  else if (shortcut === "navigate-forward")
                    viewport?.goForwardInPage()
                  else onShortcut(shortcut)
                }}
                emptyState={
                  <div className="flex max-w-sm flex-col items-center gap-4 text-center">
                    {preview.resolving ? (
                      <p className="text-sm text-muted-foreground">
                        Opening HTML preview…
                      </p>
                    ) : preview.error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {preview.error}
                      </p>
                    ) : (
                      <ArtboardEmptyState
                        projectPath={projectPath}
                        dev={dev}
                        onNavigate={navigate}
                      />
                    )}
                    {preview.canChooseHtml && (
                      <button
                        type="button"
                        disabled={preview.busy}
                        onClick={() => void preview.chooseHtml()}
                        className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
                      >
                        Choose HTML file…
                      </button>
                    )}
                  </div>
                }
              />
            ))}
            {layout.runtimePaneWidth > 0 && (
              <CanvasRuntimePane
                threadId={threadId}
                deviceIds={devices.map((device) => device.id)}
                dev={dev}
                width={layout.runtimePaneWidth}
                height={layout.previewHeight}
              />
            )}
          </div>
        </div>
        <footer
          data-canvas-controls
          className="flex items-center gap-3 rounded-b-2xl border-t border-border/60 px-4 text-[11px] text-muted-foreground"
          style={{ height: PROJECT_FOOTER_HEIGHT }}
        >
          <span className="min-w-0 flex-1 truncate">
            {selectionMode
              ? "Select an element to add it to chat"
              : "Browse preview"}{" "}
            <span className="mx-1.5 text-muted-foreground/40">·</span> Ctrl / ⌘
            + scroll to zoom canvas
          </span>
          <button
            type="button"
            onClick={() => setCardScale(undefined)}
            title="Reset card size"
            className="rounded-md px-2 py-1 font-mono tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            {Math.round(cardScale * 100)}%
          </button>
          <button
            type="button"
            data-canvas-controls
            data-card-scale={cardScale}
            aria-label={`Resize ${thread.projectName || "project"} card`}
            title="Drag to resize · arrow keys to step · double-click to reset"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onLostPointerCapture={endResize}
            onDoubleClick={() => setCardScale(undefined)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.25 : 0.1
              if (event.key === "ArrowUp" || event.key === "ArrowRight") {
                event.preventDefault()
                stepCardScale(step)
              } else if (
                event.key === "ArrowDown" ||
                event.key === "ArrowLeft"
              ) {
                event.preventDefault()
                stepCardScale(-step)
              } else if (event.key === "0") {
                event.preventDefault()
                setCardScale(undefined)
              }
            }}
            className="grid size-8 shrink-0 cursor-nwse-resize touch-none place-items-center rounded-md border border-border/60 bg-background/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <MoveDiagonal2Icon className="size-3.5" strokeWidth={1.75} />
            <span className="sr-only">{Math.round(cardScale * 100)}%</span>
          </button>
        </footer>
      </article>
    </div>
  )
})

const PAUSED_COPY: Record<
  Exclude<CanvasGuestState, "live">,
  { title: string; body: string }
> = {
  offscreen: {
    title: "Preview paused",
    body: "It loads again when this device scrolls into view.",
  },
  small: {
    title: "Preview paused",
    body: "Zoom in to load the page.",
  },
  capped: {
    title: "Preview paused to save memory",
    body: "Click to load this page; the least recently used preview pauses.",
  },
}

/**
 * Stands in for a guest the board has paused: same size as the device, no
 * process behind it. Pressing it focuses the device, which loads it again.
 */
function PausedPreview({
  state,
  url,
}: {
  state: Exclude<CanvasGuestState, "live">
  url: string
}) {
  const copy = PAUSED_COPY[state]
  return (
    <div
      data-canvas-paused={state}
      className="flex size-full items-center justify-center rounded-lg bg-muted/10 p-8 ring-1 ring-border/60"
    >
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border/60 bg-muted/25 text-muted-foreground">
          <PauseIcon className="size-7" strokeWidth={1.5} />
        </div>
        <div className="space-y-2">
          <p className="text-2xl font-medium text-foreground">{copy.title}</p>
          <p className="text-lg leading-relaxed text-muted-foreground">
            {copy.body}
          </p>
        </div>
        <p className="max-w-full truncate font-mono text-base text-muted-foreground/70">
          {url}
        </p>
      </div>
    </div>
  )
}

function ProjectDevice({
  guestId,
  device,
  url,
  panActive,
  selectionMode,
  slotScale,
  register,
  onGuestChange,
  onElementSelected,
  onDomTree,
  onNavigate,
  onConsoleEntries,
  onFocus,
  onShortcut,
  emptyState,
}: {
  /** The board's id for this guest, shared with the preview store. */
  guestId: string
  device: CanvasDevicePreset
  url: string | null
  panActive: boolean
  /** Canvas-wide Select ⇄ Browse mode. */
  selectionMode: boolean
  /** Card-local pixels per device pixel; the ancestor scales the entire card. */
  slotScale: number
  /** `paused` is true when the guest unmounts because the board paused it. */
  register: (handle: PreviewViewportHandle | null, paused: boolean) => void
  onGuestChange: (webContentsId: number | null) => void
  onElementSelected: (element: SelectedElement) => void
  onDomTree: (tree: DomNode | null) => void
  onNavigate: (url: string) => void
  onConsoleEntries: (entries: ConsoleLog[]) => void
  /** The user touched this preview: the inspector follows it. */
  onFocus: () => void
  onShortcut: (shortcut: string) => void
  emptyState: React.ReactNode
}) {
  const [loading, setLoading] = useState(false)
  const guestState = useCanvasGuestState(guestId)
  // Parent callbacks change while zooming. Detach only when the guest really
  // unmounts, otherwise the focused element and inspector tree are lost.
  const registerRef = useRef(register)
  registerRef.current = register
  // Read when the guest detaches: set by the render that paused it.
  const pausedRef = useRef(false)
  pausedRef.current = guestState !== "live"
  const attachViewport = useCallback((handle: PreviewViewportHandle | null) => {
    registerRef.current(handle, pausedRef.current)
  }, [])
  // Keep the page viewport stable. Only CSS transforms scale the canvas.
  const artboard =
    url && guestState !== "live" ? (
      <PausedPreview state={guestState} url={url} />
    ) : (
      <DesignArtboard
        ref={attachViewport}
        preset={device}
        url={url}
        interactMode={panActive ? "hand" : "interact"}
        selectionMode={selectionMode}
        isLoading={loading}
        onLoadingChange={setLoading}
        onElementSelected={onElementSelected}
        onDomTree={onDomTree}
        onNavigate={onNavigate}
        onConsoleEntries={onConsoleEntries}
        onGuestChange={onGuestChange}
        onShortcut={onShortcut}
        emptyState={emptyState}
        hideLabel
      />
    )
  return (
    <div
      data-canvas-device={device.id}
      className="shrink-0"
      style={{ width: device.width * slotScale }}
      onPointerDownCapture={onFocus}
    >
      <div className="flex h-7 items-center gap-2 text-[11px] text-muted-foreground">
        {device.icon}
        <span>{device.label}</span>
        <span className="font-mono text-[10px] opacity-60">
          {device.width} × {device.height}
        </span>
      </div>
      <div style={{ height: device.height * slotScale }}>
        <div
          style={{
            transform: `scale(${slotScale})`,
            transformOrigin: "0 0",
            width: device.width,
            height: device.height,
          }}
        >
          {artboard}
        </div>
      </div>
    </div>
  )
}
