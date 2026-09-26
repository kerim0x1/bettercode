// [REFACTOR] 2048 LOC → orchestrator only. Types, constants, injected script,
// DOM tree renderer, and layout editor live under ./browser-preview/*.
// The iframe/webview transport + message bridge moved into
// ./browser-preview/preview-viewport (shared with the design-mode canvas).
// This file now owns: toolbar, history state, inspector state, CSS-change
// buffer, and the footer/console.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  SparklesIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { DEVICE_PRESETS } from "./browser-preview/constants"
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
import {
  PreviewViewport,
  type PreviewViewportHandle,
} from "./browser-preview/preview-viewport"
import type {
  ConsoleLog,
  DomNode,
  SelectedElement,
} from "./browser-preview/types"

interface BrowserPreviewPanelProps {
  onClose: () => void
  className?: string
  projectPath?: string | null
  threadId?: string | null
  active?: boolean
  compact?: boolean
  onUrlChange?: (url: string) => void
}

export function BrowserPreviewPanel({
  onClose,
  className,
  projectPath,
  threadId,
  active = true,
  compact = false,
  onUrlChange,
}: BrowserPreviewPanelProps) {
  const viewportRef = useRef<PreviewViewportHandle>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const isElectron = !!window.electronAPI
  const activeThreadId = useChatStore((state) => state.activeThreadId)
  const targetThreadId = threadId === undefined ? activeThreadId : threadId
  const [selectionMode, setSelectionMode] = useState(isElectron)
  const [initialUrl] = useState(() => {
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

  const [url, setUrl] = useState(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [pageHistory, setPageHistory] = useState({
    back: false,
    forward: false,
  })
  const [history, setHistory] = useState<string[]>([initialUrl])
  const [historyIndex, setHistoryIndex] = useState(0)

  const [devicePreset, setDevicePreset] = useState(DEVICE_PRESETS[0])
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
    try {
      localStorage.setItem(
        `betterc0de-preview-url:${projectPath ?? ""}`,
        currentUrl
      )
    } catch {
      /* Storage can be unavailable. */
    }
    onUrlChange?.(currentUrl)
  }, [currentUrl, projectPath, onUrlChange])

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

  const handleUrlSubmit = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        let t = inputUrl.trim()
        if (t && !t.startsWith("http://") && !t.startsWith("https://"))
          t = "http://" + t
        if (t) navigate(t)
      }
    },
    [inputUrl, navigate]
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
      {/* Toolbar */}
      <div
        className={cn(
          "flex shrink-0 gap-1 border-b border-border/40 bg-muted/20 px-2 py-1",
          compact ? "flex-col items-stretch" : "items-center"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Go back in preview"
                  variant="ghost"
                  size="icon-xs"
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
                  onClick={refresh}
                  aria-label="Reload preview"
                >
                  <RefreshCwIcon
                    className={cn("size-3.5", isLoading && "animate-spin")}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Input
            ref={urlInputRef}
            aria-label="Preview URL"
            className="h-6 min-w-0 flex-1 rounded-lg border-border/40 bg-sidebar px-2 font-mono text-[11px]"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlSubmit}
            placeholder="Enter URL..."
          />
          {compact && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close browser preview"
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
        <div
          className={cn("flex min-w-0 items-center gap-1", compact && "w-full")}
        >
          {!compact && (
            <Separator orientation="vertical" className="mx-0.5 h-4" />
          )}
          <SelectBrowseToggle
            selectionMode={selectionMode}
            onToggle={() => setSelectionMode((value) => !value)}
            available={isElectron}
          />
          {!compact && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1 text-[10px] text-muted-foreground"
                >
                  {devicePreset.icon}
                  <span>{devicePreset.label}</span>
                  <ChevronDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {DEVICE_PRESETS.map((p) => (
                  <DropdownMenuItem
                    key={p.label}
                    onClick={() => setDevicePreset(p)}
                    className="gap-2"
                  >
                    {p.icon}
                    <span>{p.label}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {p.width === "100%" ? "Full" : p.width}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!compact && (
            <Separator orientation="vertical" className="mx-0.5 h-4" />
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={treeOpen ? "secondary" : "ghost"}
                  aria-label="Toggle element inspector"
                  aria-expanded={treeOpen}
                  size="icon-xs"
                  onClick={() => setTreeOpen(!treeOpen)}
                >
                  {treeOpen ? (
                    <PanelLeftCloseIcon className="size-3.5" />
                  ) : (
                    <PanelLeftOpenIcon className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Elements</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
          {!compact && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close browser preview"
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Main */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
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
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/10">
            <div
              className="h-full transition-all duration-200"
              style={{ width: devicePreset.width, maxWidth: "100%" }}
            >
              <PreviewViewport
                ref={viewportRef}
                url={url}
                selectionMode={selectionMode && !(compact && treeOpen)}
                onSelectionExit={() => setSelectionMode(false)}
                onNavigate={(nextUrl, nextHistory) => {
                  setInputUrl(nextUrl)
                  setCurrentUrl(nextUrl)
                  setPageHistory(nextHistory)
                }}
                onLoadingChange={setIsLoading}
                onDomTree={setDomTree}
                onConsoleEntries={handleConsoleEntries}
                onElementSelected={handleElementSelected}
                onShortcut={handleShortcut}
              />
            </div>
          </div>

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
                          log.level === "error" && "bg-red-500/5 text-red-400",
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
        </div>
      </div>

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
          <span className="text-amber-400">{cssChanges.length} change(s)</span>
        )}
        {!compact && <span>{devicePreset.label}</span>}
      </div>
    </div>
  )
}
