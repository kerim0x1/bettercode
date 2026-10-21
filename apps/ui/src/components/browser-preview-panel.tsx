// [REFACTOR] 2048 LOC → orchestrator only. Types, constants, injected script,
// DOM tree renderer, and layout editor live under ./browser-preview/*.
// The iframe/webview transport + message bridge moved into
// ./browser-preview/preview-viewport (shared with the design-mode canvas).
// This file now owns: toolbar, history state, inspector state, CSS-change
// buffer, and the footer/console.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  ListTreeIcon,
  PanelRightIcon,
  RefreshCwIcon,
  SparklesIcon,
  StarIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import { normalizeBrowserElement } from "@betterc0de/schema"
import { toast } from "sonner"
import {
  useBrowserContextStore,
  MAX_BROWSER_ELEMENTS,
} from "@/lib/browser-context-store"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import {
  BROWSER_PREVIEW_COMMAND_EVENT,
  dispatchEditorPreviewToggle,
  type BrowserPreviewCommandEventDetail,
} from "@/lib/preview-events"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { resolveAddress } from "@/lib/browser-address"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { DEVICE_PRESETS, deviceUserAgent } from "./browser-preview/constants"
import { ElementInspector } from "./browser-preview/element-inspector"
import {
  EMPTY_INSPECTOR_STATE,
  cssChangesPrompt,
  highlightCommand,
  selectCommand,
  withDomTree,
  withPageChange,
  withSelectedElement,
  withStyleChange,
  withTab,
  withoutCssChanges,
  withoutSelection,
  type ElementInspectorState,
  type InspectorTab,
} from "./browser-preview/inspector-state"
import { SelectBrowseToggle } from "./browser-preview/select-browse-toggle"
import { previewUrl } from "./browser-preview/url"
import { BrowserStartPage } from "./browser-preview/browser-start-page"
import {
  PreviewViewport,
  type PreviewViewportHandle,
} from "./browser-preview/preview-viewport"
import type {
  ConsoleLog,
  DomNode,
  SelectedElement,
} from "./browser-preview/types"
import { hasElectronApi } from "@/services/ipc-facade"

interface BrowserPreviewPanelProps {
  onClose: () => void
  className?: string
  projectPath?: string | null
  threadId?: string | null
  active?: boolean
  compact?: boolean
  onUrlChange?: (url: string) => void
  /**
   * The workspace browser's tab: the page to open, or null for the start
   * page. Left undefined, the panel reopens the project's last preview URL
   * (or localhost:3000), as the editor preview does.
   */
  initialUrl?: string | null
  /** The page's address, title or icon changed (tab title, history). */
  onPageChange?: (page: {
    url?: string
    title?: string | null
    favicon?: string | null
  }) => void
  /** Rendered right of the page while `sidePanelOpen`, e.g. the history. */
  renderSidePanel?: (navigate: (url: string) => void) => ReactNode
  sidePanelOpen?: boolean
  onToggleSidePanel?: () => void
  /** Shows the favorite star when given. */
  favorite?: boolean
  onToggleFavorite?: () => void
}

export function BrowserPreviewPanel({
  onClose,
  className,
  projectPath,
  threadId,
  active = true,
  compact = false,
  onUrlChange,
  initialUrl: requestedUrl,
  onPageChange,
  renderSidePanel,
  sidePanelOpen = false,
  onToggleSidePanel,
  favorite = false,
  onToggleFavorite,
}: BrowserPreviewPanelProps) {
  const viewportRef = useRef<PreviewViewportHandle>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const isElectron = hasElectronApi()
  const activeThreadId = useChatStore((state) => state.activeThreadId)
  const targetThreadId = threadId === undefined ? activeThreadId : threadId
  // A workspace-browser tab is for browsing first; picking elements for the
  // chat is one click away. The editor preview keeps selecting by default.
  const tabbed = requestedUrl !== undefined
  const [selectionMode, setSelectionMode] = useState(isElectron && !tabbed)
  const [initialUrl] = useState<string | null>(() => {
    if (tabbed) return requestedUrl ? previewUrl(requestedUrl) : null
    try {
      return (
        previewUrl(
          localStorage.getItem(`betterc0de-preview-url:${projectPath ?? ""}`) ||
            ""
        ) || "http://localhost:3000"
      )
    } catch {
      return "http://localhost:3000"
    }
  })

  // Null shows the start page until the first navigation.
  const [url, setUrl] = useState<string | null>(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl ?? "")
  const [currentUrl, setCurrentUrl] = useState(initialUrl ?? "")
  const [pageHistory, setPageHistory] = useState({
    back: false,
    forward: false,
  })
  const [history, setHistory] = useState<string[]>(
    initialUrl ? [initialUrl] : []
  )
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1)
  const pageChangeRef = useRef(onPageChange)
  pageChangeRef.current = onPageChange

  const [devicePreset, setDevicePreset] = useState(DEVICE_PRESETS[0])
  // The page area's size: a tablet or phone viewport is scaled to fit it.
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const stageObserverRef = useRef<ResizeObserver | null>(null)
  const stageRef = useCallback((node: HTMLDivElement | null) => {
    stageObserverRef.current?.disconnect()
    stageObserverRef.current = null
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setStage({ width: box.width, height: box.height })
    })
    observer.observe(node)
    stageObserverRef.current = observer
  }, [])
  const deviceSize = devicePreset.size
  const deviceScale =
    deviceSize && stage.width > 0 && stage.height > 0
      ? Math.max(
          0.1,
          Math.min(
            1,
            (stage.width - DEVICE_GUTTER * 2) / deviceSize.width,
            (stage.height - DEVICE_GUTTER * 2 - DEVICE_LABEL) /
              deviceSize.height
          )
        )
      : 1
  const deviceAgent = deviceUserAgent(devicePreset.agent)
  const [treeOpen, setTreeOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([])
  // Inspector state and its transitions are shared with the canvas
  // (`browser-preview/inspector-state`); this panel only hosts them.
  const [inspector, setInspector] = useState<ElementInspectorState>(
    EMPTY_INSPECTOR_STATE
  )
  const {
    tree: domTree,
    selected: selectedElement,
    editedStyles,
    cssChanges,
    tab: inspectorTab,
  } = inspector
  const setInspectorTab = useCallback(
    (tab: InspectorTab) => setInspector((state) => withTab(state, tab)),
    []
  )
  const setDomTree = useCallback(
    (tree: DomNode | null) => setInspector((state) => withDomTree(state, tree)),
    []
  )
  useEffect(() => {
    if (!currentUrl) return
    // A workspace-browser tab keeps its address in the browser store.
    if (!tabbed) {
      try {
        localStorage.setItem(
          `betterc0de-preview-url:${projectPath ?? ""}`,
          currentUrl
        )
      } catch {
        /* Storage can be unavailable. */
      }
    }
    onUrlChange?.(currentUrl)
  }, [currentUrl, projectPath, onUrlChange, tabbed])

  // Fix 7: useMemo for errorCount
  const errorCount = useMemo(
    () => consoleLogs.filter((l) => l.level === "error").length,
    [consoleLogs]
  )
  // Viewport callbacks — the transport lives in PreviewViewport; this panel
  // only owns the inspector/console state fed by these.
  const handleConsoleEntries = useCallback((entries: ConsoleLog[]) => {
    setConsoleLogs((prev) => [
      ...prev.slice(-(200 - entries.length)),
      ...entries,
    ])
  }, [])

  const handleElementSelected = useCallback(
    (el: SelectedElement) => {
      setInspector((state) => withSelectedElement(state, el))
      const element = normalizeBrowserElement({
        ...el,
        url: el.url || currentUrl,
      })
      if (!element) return
      const store = useChatStore.getState()
      const target = store.threads.find(
        (thread) => thread.id === targetThreadId
      )
      if (targetThreadId && !target) return
      const threadId =
        targetThreadId ??
        store.createThread(
          "New Chat",
          projectPath?.split(/[\\/]/).pop() || "Workspace",
          projectPath ?? undefined
        )
      if (!useBrowserContextStore.getState().add(threadId, element)) {
        toast.info(
          `You can select up to ${MAX_BROWSER_ELEMENTS} elements per message`
        )
      }
    },
    [targetThreadId, projectPath, currentUrl]
  )

  const handleShortcut = useCallback(
    (shortcut: string) => {
      if (shortcut === "toggle-preview") {
        if (compact) onClose()
        else dispatchEditorPreviewToggle()
        return
      }
      if (shortcut === "focus-url-bar") {
        urlInputRef.current?.focus()
        urlInputRef.current?.select()
        return
      }
      const vp = viewportRef.current
      if (!vp) return
      if (shortcut === "reload-page") {
        setIsLoading(true)
        vp.reload()
      } else if (shortcut === "navigate-back") {
        vp.goBackInPage()
      } else if (shortcut === "navigate-forward") {
        vp.goForwardInPage()
      } else if (shortcut === "open-devtools") {
        vp.openDevTools()
      } else if (shortcut === "zoom-in") {
        vp.pageZoomIn()
      } else if (shortcut === "zoom-out") {
        vp.pageZoomOut()
      } else if (shortcut === "zoom-reset") {
        vp.pageZoomReset()
      }
    },
    [compact, onClose]
  )

  useEffect(() => {
    if (!active) return
    const onPreviewCommand = (event: Event) => {
      const detail = (event as CustomEvent<BrowserPreviewCommandEventDetail>)
        .detail
      if (detail?.command) handleShortcut(detail.command)
    }
    window.addEventListener(BROWSER_PREVIEW_COMMAND_EVENT, onPreviewCommand)
    return () => {
      window.removeEventListener(
        BROWSER_PREVIEW_COMMAND_EVENT,
        onPreviewCommand
      )
    }
  }, [active, handleShortcut])

  const navigate = useCallback(
    (newUrl: string) => {
      if (!previewUrl(newUrl)) return
      setUrl(newUrl)
      setCurrentUrl(newUrl)
      setInputUrl(newUrl)
      setIsLoading(true)
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), newUrl])
      setHistoryIndex((p) => p + 1)
      setInspector(withPageChange)
      pageChangeRef.current?.({ url: newUrl })
    },
    [historyIndex]
  )

  const goBack = useCallback(() => {
    if (isElectron) {
      viewportRef.current?.goBackInPage()
      return
    }
    if (historyIndex > 0) {
      const i = historyIndex - 1
      setHistoryIndex(i)
      setUrl(history[i])
      setInputUrl(history[i])
      setCurrentUrl(history[i])
      setIsLoading(true)
    }
  }, [isElectron, historyIndex, history])

  const goForward = useCallback(() => {
    if (isElectron) {
      viewportRef.current?.goForwardInPage()
      return
    }
    if (historyIndex < history.length - 1) {
      const i = historyIndex + 1
      setHistoryIndex(i)
      setUrl(history[i])
      setInputUrl(history[i])
      setCurrentUrl(history[i])
      setIsLoading(true)
    }
  }, [isElectron, historyIndex, history])

  const refresh = useCallback(() => {
    setIsLoading(true)
    viewportRef.current?.reload()
  }, [])

  // An address opens; anything else is searched (`lib/browser-address`).
  const handleUrlSubmit = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        const target = resolveAddress(inputUrl)
        if (target) navigate(target)
      } else if (e.key === "Escape") {
        setInputUrl(currentUrl)
        e.currentTarget.blur()
      }
    },
    [currentUrl, inputUrl, navigate]
  )

  const postToPreview = useCallback((msg: Record<string, unknown>) => {
    viewportRef.current?.postToPreview(msg)
  }, [])

  const applyStyleChange = useCallback(
    (property: string, value: string) => {
      const result = withStyleChange(inspector, property, value)
      if (result.state !== inspector) setInspector(result.state)
      if (result.command) postToPreview(result.command)
    },
    [inspector, postToPreview]
  )

  const highlightElement = useCallback(
    (selector: string) => postToPreview(highlightCommand(selector)),
    [postToPreview]
  )

  const selectFromTree = useCallback(
    (selector: string) => postToPreview(selectCommand(selector)),
    [postToPreview]
  )

  const sendCssToAI = useCallback(() => {
    if (cssChanges.length === 0) return
    const store = useChatStore.getState()
    let destinationThreadId = targetThreadId
    if (
      destinationThreadId &&
      !store.threads.some((thread) => thread.id === destinationThreadId)
    )
      return
    if (!destinationThreadId)
      destinationThreadId = store.createThread(
        "Visual Changes",
        projectPath?.split(/[\\/]/).pop() || "Workspace",
        projectPath ?? undefined
      )
    dispatchComposerDraftRestoreAfterSubmit({
      threadId: destinationThreadId,
      text: [
        store.getDraft(destinationThreadId),
        cssChangesPrompt(cssChanges, currentUrl),
      ]
        .filter(Boolean)
        .join("\n\n"),
    })
    setInspector(withoutCssChanges)
  }, [cssChanges, currentUrl, projectPath, targetThreadId])

  const elLabel = selectedElement
    ? `${selectedElement.tagName}${selectedElement.id ? "#" + selectedElement.id : ""}${selectedElement.className ? "." + selectedElement.className.split(" ")[0] : ""}`
    : ""

  return (
    <div
      data-betterc0de-preview={active ? "browser" : undefined}
      className={cn("flex flex-col bg-background", className)}
    >
      {/* Navigation bar: history, reload, favorite, one search-or-address
          field, element selection, the page tools (inspector, console,
          device, DevTools) and the history panel toggle. */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/40 bg-background px-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Go back in preview"
                variant="ghost"
                size="icon-xs"
                className={NAV_BUTTON}
                onClick={goBack}
                disabled={isElectron ? !pageHistory.back : historyIndex <= 0}
              >
                <ArrowLeftIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Go forward in preview"
                variant="ghost"
                size="icon-xs"
                className={NAV_BUTTON}
                onClick={goForward}
                disabled={
                  isElectron
                    ? !pageHistory.forward
                    : historyIndex >= history.length - 1
                }
              >
                <ArrowRightIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forward</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={NAV_BUTTON}
                onClick={refresh}
                disabled={!url}
                aria-label="Reload preview"
              >
                <RefreshCwIcon
                  className={cn("size-3.5", isLoading && url && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          {onToggleFavorite ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={NAV_BUTTON}
                  onClick={onToggleFavorite}
                  disabled={!url}
                  aria-label={favorite ? "Remove favorite" : "Add favorite"}
                  aria-pressed={favorite}
                >
                  <StarIcon
                    className={cn(
                      "size-3.5",
                      favorite && "fill-warning text-warning"
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {favorite ? "Remove favorite" : "Add favorite"}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </TooltipProvider>
        <input
          ref={urlInputRef}
          aria-label="Search or enter URL"
          className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[12px] text-foreground transition-colors outline-none placeholder:text-muted-foreground/70 hover:bg-muted/40 focus:border-border/60 focus:bg-muted/40"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleUrlSubmit}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Search or enter URL"
          spellCheck={false}
        />
        {url ? (
          <SelectBrowseToggle
            selectionMode={selectionMode}
            onToggle={() => setSelectionMode((value) => !value)}
            available={isElectron}
          />
        ) : null}
        {cssChanges.length > 0 && (
          <Button
            variant="default"
            size="xs"
            className="gap-1 text-[10px]"
            onClick={sendCssToAI}
          >
            <SparklesIcon className="size-3" />
            Send to AI
            <Badge variant="secondary" className="ml-0.5 h-4 px-1 text-[9px]">
              {cssChanges.length}
            </Badge>
          </Button>
        )}
        {/* Page tools sit in the bar, not behind a menu: inspector, console
            (red when the page logged errors), device size and DevTools. */}
        {url ? (
          <TooltipProvider>
            <div className="ml-0.5 flex shrink-0 items-center gap-0.5">
              <span
                aria-hidden="true"
                className="mx-0.5 h-4 w-px bg-border/60"
              />
              <ToolButton
                label="Element inspector"
                pressed={treeOpen}
                onClick={() => setTreeOpen((open) => !open)}
              >
                <ListTreeIcon className="size-3.5" />
              </ToolButton>
              <ToolButton
                label={
                  errorCount > 0
                    ? `Console · ${errorCount} error${errorCount === 1 ? "" : "s"}`
                    : "Console"
                }
                pressed={consoleOpen}
                onClick={() => setConsoleOpen((open) => !open)}
              >
                <TerminalIcon
                  className={cn(
                    "size-3.5",
                    errorCount > 0 && "text-destructive"
                  )}
                />
              </ToolButton>
              <div
                role="radiogroup"
                aria-label="Device size"
                className="flex items-center gap-px rounded-md border border-border/50 p-px"
              >
                {DEVICE_PRESETS.map((preset) => {
                  const selected = devicePreset.label === preset.label
                  const size = preset.size
                    ? `${preset.size.width} × ${preset.size.height}`
                    : "full width"
                  return (
                    <Tooltip key={preset.label}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={`${preset.label}, ${size}`}
                          onClick={() => setDevicePreset(preset)}
                          className={cn(
                            "grid size-5 place-items-center rounded-[5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none [&_svg]:size-3",
                            selected
                              ? "bg-muted/70 text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {preset.icon}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {preset.label} · {size}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
              {isElectron ? (
                <ToolButton
                  label="Open DevTools"
                  onClick={() => viewportRef.current?.openDevTools()}
                >
                  <WrenchIcon className="size-3.5" />
                </ToolButton>
              ) : null}
            </div>
          </TooltipProvider>
        ) : null}
        {onToggleSidePanel ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    NAV_BUTTON,
                    sidePanelOpen && "bg-muted/60 text-foreground"
                  )}
                  onClick={onToggleSidePanel}
                  aria-label={sidePanelOpen ? "Hide history" : "Show history"}
                  aria-pressed={sidePanelOpen}
                >
                  <PanelRightIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>History and favorites</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {!compact && (
          <Button
            variant="ghost"
            size="icon-xs"
            className={NAV_BUTTON}
            onClick={onClose}
            aria-label="Close browser preview"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Main */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {url === null ? (
          <div className="min-w-0 flex-1">
            <BrowserStartPage onNavigate={navigate} />
          </div>
        ) : (
          <>
            {treeOpen && (
              <ElementInspector
                compact={compact}
                tree={domTree}
                selected={selectedElement}
                tab={inspectorTab}
                onTabChange={setInspectorTab}
                onSelect={selectFromTree}
                onHighlight={highlightElement}
                onClear={() => setInspector(withoutSelection)}
                loading={isLoading}
                styles={editedStyles}
                onStyleChange={applyStyleChange}
                pageUrl={currentUrl}
              />
            )}

            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                compact && treeOpen
                  ? "pointer-events-none invisible absolute inset-0"
                  : "relative"
              )}
              aria-hidden={compact && treeOpen}
              inert={compact && treeOpen}
            >
              {/* Desktop fills the area. A tablet or phone keeps its real
                  viewport (so the page's breakpoints see the device, not the
                  panel) and is scaled down to fit, like the canvas devices.
                  The tree stays the same for every preset, so switching
                  does not remount the page. */}
              <div
                ref={stageRef}
                className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-muted/10"
              >
                <div
                  aria-hidden={!deviceSize}
                  className={cn(
                    "mb-1.5 h-4 shrink-0 text-[10.5px] text-muted-foreground tabular-nums",
                    !deviceSize && "hidden"
                  )}
                >
                  {deviceSize
                    ? `${devicePreset.label} · ${deviceSize.width} × ${deviceSize.height}${
                        deviceScale < 1
                          ? ` · ${Math.round(deviceScale * 100)}%`
                          : ""
                      }`
                    : null}
                </div>
                <div
                  className={cn(
                    "overflow-hidden",
                    deviceSize
                      ? "shrink-0 rounded-[12px] border border-border/60 bg-background"
                      : "min-h-0 w-full flex-1"
                  )}
                  style={
                    deviceSize
                      ? {
                          width: deviceSize.width * deviceScale + 2,
                          height: deviceSize.height * deviceScale + 2,
                        }
                      : undefined
                  }
                >
                  <div
                    style={
                      deviceSize
                        ? {
                            width: deviceSize.width,
                            height: deviceSize.height,
                            transform: `scale(${deviceScale})`,
                            transformOrigin: "0 0",
                          }
                        : { width: "100%", height: "100%" }
                    }
                  >
                    <PreviewViewport
                      ref={viewportRef}
                      url={url}
                      userAgent={deviceAgent}
                      selectionMode={selectionMode && !(compact && treeOpen)}
                      onSelectionExit={() => setSelectionMode(false)}
                      onNavigate={(nextUrl, nextHistory) => {
                        setInputUrl(nextUrl)
                        setCurrentUrl(nextUrl)
                        setPageHistory(nextHistory)
                        pageChangeRef.current?.({ url: nextUrl })
                      }}
                      onPageInfo={(info) => pageChangeRef.current?.(info)}
                      onLoadingChange={setIsLoading}
                      onDomTree={setDomTree}
                      onConsoleEntries={handleConsoleEntries}
                      onElementSelected={handleElementSelected}
                      onShortcut={handleShortcut}
                    />
                  </div>
                </div>
              </div>

              {/* The console bar shows once opened from the toolbar, or with errors. */}
              {consoleOpen || errorCount > 0 ? (
                <Collapsible
                  open={consoleOpen}
                  onOpenChange={setConsoleOpen}
                  className="shrink-0 border-t border-border/40"
                >
                  <div className="flex w-full items-center gap-2 bg-muted/20 px-3 py-1">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 pl-1 transition-colors hover:bg-muted/40"
                      >
                        <ChevronRightIcon
                          className={cn(
                            "size-3 text-muted-foreground transition-transform",
                            consoleOpen && "rotate-90"
                          )}
                        />
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Console
                        </span>
                        {errorCount > 0 && (
                          <Badge
                            variant="destructive"
                            className="h-3.5 px-1 text-[9px]"
                          >
                            {errorCount}
                          </Badge>
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <div className="flex-1" />
                    {consoleLogs.length > 0 && (
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
                        onClick={() => setConsoleLogs([])}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <CollapsibleContent>
                    <ScrollArea className="max-h-36 bg-sidebar">
                      <div className="space-y-px p-2 font-mono">
                        {consoleLogs.length === 0 ? (
                          <p className="px-1 py-2 text-center text-[10px] text-muted-foreground/40">
                            No console output
                          </p>
                        ) : (
                          consoleLogs.map((log, i) => (
                            <div
                              key={`${log.timestamp.getTime()}-${i}`}
                              className={cn(
                                "rounded px-1 py-0.5 text-[10px]",
                                log.level === "error" &&
                                  "bg-red-500/5 text-red-400",
                                log.level === "warn" &&
                                  "bg-yellow-500/5 text-yellow-400",
                                log.level === "log" && "text-muted-foreground"
                              )}
                            >
                              <span className="mr-1.5 text-muted-foreground/40">
                                {log.timestamp.toLocaleTimeString()}
                              </span>
                              {log.message}
                            </div>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          </>
        )}
        {sidePanelOpen && renderSidePanel ? renderSidePanel(navigate) : null}
      </div>

      {/* Status line, only while selecting or with a selection or edits. */}
      {url && (selectionMode || selectedElement || cssChanges.length > 0) ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-border/40 bg-muted/20 px-3 py-0.5 text-[10px] text-muted-foreground">
          <span className="truncate">
            {selectionMode
              ? "Click elements to add them to chat · Esc to browse"
              : "Browse the page · enable Select to pick elements"}
          </span>
          <div className="flex-1" />
          {selectedElement && (
            <span className="font-medium text-primary">{elLabel}</span>
          )}
          {cssChanges.length > 0 && (
            <span className="text-amber-400">
              {cssChanges.length} change(s)
            </span>
          )}
          {deviceSize && <span>{devicePreset.label}</span>}
        </div>
      ) : null}
    </div>
  )
}

/** Space around a scaled device, and its label row above it. */
const DEVICE_GUTTER = 16
const DEVICE_LABEL = 22

/** Quiet toolbar icon buttons, like the reference browser's. */
const NAV_BUTTON =
  "size-6 text-muted-foreground hover:text-foreground disabled:opacity-35"

/** A page tool in the navigation bar; `pressed` marks a toggle that is on. */
function ToolButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(NAV_BUTTON, pressed && "bg-muted/60 text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
