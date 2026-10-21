import { runEditorSave } from "@/lib/editor-save"
import { copyText } from "@/lib/clipboard"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { useChatStore, getThreadStream } from "@/lib/chat-store"
import { readFile } from "@/services/backend/workspaceApi"
import { HttpError } from "@/lib/errors/types"
import { createLogger } from "@/lib/logger"
import { relativeEditorPath, resolveWorkspaceFilePath } from "@/lib/editor-path"
import {
  buildEditorBreadcrumbSegments,
  shouldShowEditorBreadcrumbs,
} from "@/lib/editor-breadcrumbs"
import { confirmCloseDirtyEditorTabs } from "@/lib/editor-close-confirmation"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import {
  EDITOR_FILE_ACTIVATE_EVENT,
  EDITOR_PREVIEW_TOGGLE_EVENT,
} from "@/lib/preview-events"
import { previewTabLabel } from "./browser-preview/url"
import { cn } from "@/lib/utils"
import { editorDiffLabel } from "@/lib/editor-diff"
import { usePreferencesStore } from "@/lib/preferences-store"

// M11: route catches through the shared logger so failures land in the error
// log store (visible in DevPanel), not just the browser console.
const log = createLogger("editor-panel")
import {
  useEditorStore,
  type EditorSelectionContext,
  type EditorTab,
} from "@/lib/editor-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import type {
  InlineEditRequest,
  InlineEditProvider,
} from "@/components/monaco-editor-wrapper"

// [PERF] Monaco (~4 MB) and BrowserPreview (~2 KLOC + iframe sandbox) are deferred
// until a tab is actually open. Type-only imports above stay eager (erased at build).
const loadMonacoEditorWrapper = () =>
  import("@/components/monaco-editor-wrapper").then((m) => ({
    default: m.MonacoEditorWrapper,
  }))
const MonacoEditorWrapper = lazy(loadMonacoEditorWrapper)
const BrowserPreviewPanel = lazy(() =>
  import("@/components/browser-preview-panel").then((m) => ({
    default: m.BrowserPreviewPanel,
  }))
)
const FilePreview = lazy(() =>
  import("@/components/editor/file-preview").then((m) => ({
    default: m.FilePreview,
  }))
)
const DiffPanel = lazy(() =>
  import("@/components/diff-panel").then((module) => ({
    default: module.DiffPanel,
  }))
)
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  XIcon,
  GlobeIcon,
  PinIcon,
  SplitSquareHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { getFileIconUrl } from "@/lib/file-icons"
import { Button } from "@/components/ui/button"
import { CodebaseOverview } from "@/components/editor/codebase-overview"
import {
  buildCodeOutline,
  selectCurrentOutlinePath,
  type CodeOutlineItem,
} from "@/lib/code-outline"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  countEditorDiagnostics,
  selectAllEditorDiagnostics,
  useEditorDiagnosticsStore,
} from "@/lib/editor-diagnostics-store"

const SPLIT_PRIMARY_DEFAULT_PERCENT = 50
const SPLIT_PRIMARY_MIN_PERCENT = 25
const SPLIT_PRIMARY_MAX_PERCENT = 75
const SPLIT_PRIMARY_KEYBOARD_STEP = 5

function clampSplitPrimaryPercent(value: number): number {
  return Math.min(
    SPLIT_PRIMARY_MAX_PERCENT,
    Math.max(SPLIT_PRIMARY_MIN_PERCENT, value)
  )
}

export function EditorPanel({
  projectPath,
  onInlineEdit,
  inlineEditProviders,
  inlineEditSelectedModelId,
  inlineEditSelectedProviderId,
  onInlineEditModelChange,
}: {
  projectPath?: string | null
  onInlineEdit?: (request: InlineEditRequest) => void | Promise<void>
  inlineEditProviders?: InlineEditProvider[]
  inlineEditSelectedModelId?: string
  inlineEditSelectedProviderId?: string
  onInlineEditModelChange?: (modelId: string, providerId: string) => void
}) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeOtherTabs = useEditorStore((s) => s.closeOtherTabs)
  const closeTabsToRight = useEditorStore((s) => s.closeTabsToRight)
  const closeSavedTabs = useEditorStore((s) => s.closeSavedTabs)
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs)
  const togglePinTab = useEditorStore((s) => s.togglePinTab)
  const updateContent = useEditorStore((s) => s.updateContent)
  const updateCursor = useEditorStore((s) => s.updateCursor)
  const saveTab = useEditorStore((s) => s.saveTab)
  const navigationBackCount = useEditorStore(
    (s) => s.navigationBackStack.length
  )
  const navigationForwardCount = useEditorStore(
    (s) => s.navigationForwardStack.length
  )
  const goBack = useEditorStore((s) => s.goBack)
  const goForward = useEditorStore((s) => s.goForward)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null

  // Monaco remains code-split, but editor mode warms the chunk after its
  // initial paint so the first file click does not pay the full download and
  // parse cost. The short delay keeps startup interaction responsive.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMonacoEditorWrapper()
    }, 350)
    return () => window.clearTimeout(timer)
  }, [])
  const activeOutline = useMemo(
    () =>
      activeTab !== null &&
      !activeTab.diff &&
      (activeTab.fileKind ?? "text") === "text"
        ? buildCodeOutline({
            content: activeTab.content,
            language: activeTab.language,
            fileName: activeTab.fileName,
          })
        : [],
    [activeTab]
  )
  const activeOutlinePath = useMemo(
    () =>
      activeTab
        ? selectCurrentOutlinePath(activeOutline, activeTab.cursorLine)
        : [],
    [activeOutline, activeTab]
  )
  const isStreaming = useChatStore(
    (s) => getThreadStream(s, s.activeThreadId).isStreaming
  )
  const prevStreamingRef = useRef(false)
  // Path that returned 404 mid-stream — suppresses further polls of that path
  // until the active tab's path changes.
  const path404Ref = useRef<string | null>(null)

  // Browser preview as full-height view mode
  const [viewMode, setViewMode] = useState<"editor" | "preview">("editor")
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState("")
  useEffect(() => {
    const showFile = () => setViewMode("editor")
    window.addEventListener(EDITOR_FILE_ACTIVATE_EVENT, showFile)
    return () =>
      window.removeEventListener(EDITOR_FILE_ACTIVATE_EVENT, showFile)
  }, [])
  useEffect(() => {
    if (viewMode === "preview") setPreviewOpen(true)
  }, [viewMode])
  const previousFileTab = useRef(activeTabId)
  useEffect(() => {
    if (activeTabId !== previousFileTab.current) setViewMode("editor")
    previousFileTab.current = activeTabId
  }, [activeTabId])
  const [tabMenu, setTabMenu] = useState<{
    x: number
    y: number
    tabId: string
  } | null>(null)
  const [splitTabId, setSplitTabId] = useState<string | null>(null)
  const [splitPrimaryPercent, setSplitPrimaryPercent] = useState(
    SPLIT_PRIMARY_DEFAULT_PERCENT
  )
  const [isSplitResizing, setIsSplitResizing] = useState(false)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const splitResizeCleanupRef = useRef<(() => void) | null>(null)
  const contextTab = tabMenu
    ? (tabs.find((tab) => tab.id === tabMenu.tabId) ?? null)
    : null
  const splitTab = splitTabId
    ? (tabs.find((tab) => tab.id === splitTabId) ?? null)
    : null
  const contextTabIndex = contextTab
    ? tabs.findIndex((tab) => tab.id === contextTab.id)
    : -1
  const contextTabsRightCount =
    contextTabIndex === -1
      ? 0
      : tabs.slice(contextTabIndex + 1).filter((tab) => !tab.isPinned).length
  const contextOtherTabsCount = contextTab
    ? tabs.filter((tab) => tab.id !== contextTab.id && !tab.isPinned).length
    : 0
  const contextSavedTabsCount = tabs.filter(
    (tab) => !tab.isDirty && !tab.isPinned
  ).length
  const contextClosableTabsCount = tabs.filter((tab) => !tab.isPinned).length

  useEffect(() => {
    const openPreview = () => setViewMode("preview")
    const togglePreview = () =>
      setViewMode((current) => (current === "preview" ? "editor" : "preview"))
    window.addEventListener("betterc0de:editor-open-preview", openPreview)
    window.addEventListener(EDITOR_PREVIEW_TOGGLE_EVENT, togglePreview)
    return () => {
      window.removeEventListener("betterc0de:editor-open-preview", openPreview)
      window.removeEventListener(EDITOR_PREVIEW_TOGGLE_EVENT, togglePreview)
    }
  }, [])

  const openTabToSide = useCallback(
    (tabId: string | null | undefined = activeTabId) => {
      const targetId = tabId ?? activeTabId
      if (!targetId || !tabs.some((tab) => tab.id === targetId)) return
      setSplitTabId(targetId)
      setViewMode("editor")
    },
    [activeTabId, tabs]
  )

  const closeSplitEditor = useCallback(() => {
    setSplitTabId(null)
  }, [])

  const setClampedSplitPrimaryPercent = useCallback((value: number) => {
    setSplitPrimaryPercent(clampSplitPrimaryPercent(value))
  }, [])

  const resizeSplitFromClientX = useCallback(
    (clientX: number) => {
      const rect = splitContainerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      setClampedSplitPrimaryPercent(((clientX - rect.left) / rect.width) * 100)
    },
    [setClampedSplitPrimaryPercent]
  )

  const stopSplitResize = useCallback(() => {
    splitResizeCleanupRef.current?.()
    splitResizeCleanupRef.current = null
    setIsSplitResizing(false)
  }, [])

  const startSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!splitTab) return
      event.preventDefault()
      event.stopPropagation()
      resizeSplitFromClientX(event.clientX)
      stopSplitResize()
      setIsSplitResizing(true)

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault()
        resizeSplitFromClientX(moveEvent.clientX)
      }
      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove)
        window.removeEventListener("pointerup", handlePointerUp)
        window.removeEventListener("pointercancel", handlePointerUp)
      }
      const handlePointerUp = () => {
        cleanup()
        splitResizeCleanupRef.current = null
        setIsSplitResizing(false)
      }

      window.addEventListener("pointermove", handlePointerMove)
      window.addEventListener("pointerup", handlePointerUp)
      window.addEventListener("pointercancel", handlePointerUp)
      splitResizeCleanupRef.current = cleanup
    },
    [resizeSplitFromClientX, splitTab, stopSplitResize]
  )

  const handleSplitResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!splitTab) return
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setClampedSplitPrimaryPercent(
          splitPrimaryPercent - SPLIT_PRIMARY_KEYBOARD_STEP
        )
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        setClampedSplitPrimaryPercent(
          splitPrimaryPercent + SPLIT_PRIMARY_KEYBOARD_STEP
        )
      } else if (event.key === "Home") {
        event.preventDefault()
        setClampedSplitPrimaryPercent(SPLIT_PRIMARY_MIN_PERCENT)
      } else if (event.key === "End") {
        event.preventDefault()
        setClampedSplitPrimaryPercent(SPLIT_PRIMARY_MAX_PERCENT)
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        setClampedSplitPrimaryPercent(SPLIT_PRIMARY_DEFAULT_PERCENT)
      }
    },
    [setClampedSplitPrimaryPercent, splitPrimaryPercent, splitTab]
  )

  useEffect(() => () => stopSplitResize(), [stopSplitResize])

  useEffect(() => {
    const handleSplitRight = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      openTabToSide(detail?.tabId)
    }
    const handleCloseSplit = () => closeSplitEditor()
    window.addEventListener("betterc0de:editor-split-right", handleSplitRight)
    window.addEventListener("betterc0de:editor-close-split", handleCloseSplit)
    return () => {
      window.removeEventListener(
        "betterc0de:editor-split-right",
        handleSplitRight
      )
      window.removeEventListener(
        "betterc0de:editor-close-split",
        handleCloseSplit
      )
    }
  }, [closeSplitEditor, openTabToSide])

  useEffect(() => {
    if (!splitTabId) return
    if (tabs.some((tab) => tab.id === splitTabId)) return
    const fallback = tabs.find((tab) => tab.id !== activeTabId) ?? null
    setSplitTabId(fallback?.id ?? null)
  }, [activeTabId, splitTabId, tabs])

  // Auto-refresh active tab when streaming ends (AI finished editing)
  useEffect(() => {
    if (
      prevStreamingRef.current &&
      !isStreaming &&
      activeTab !== null &&
      !activeTab.diff &&
      (activeTab.fileKind ?? "text") === "text" &&
      !activeTab.isDirty
    ) {
      readFile(activeTab.filePath)
        .then((res) => {
          if (res.content !== activeTab.content) {
            useEditorStore.getState().reloadFromAi(activeTab.filePath)
          }
        })
        .catch((err) => {
          if (err instanceof HttpError && err.status === 404) return
          log.warn("Failed to check file for AI reload:", activeTab.filePath)
        })
    }
    prevStreamingRef.current = isStreaming
  }, [activeTab, isStreaming])

  // Poll during streaming to catch live file changes. Pauses automatically
  // when the window is hidden (visibility API) and on dirty/not-streaming
  // states. The 404 ref stops further reads of a deleted path until the
  // user switches tabs (active path mismatch resets it).
  useVisibilityInterval(
    () => {
      if (
        !activeTab ||
        activeTab.diff ||
        (activeTab.fileKind ?? "text") !== "text" ||
        activeTab.isDirty
      )
        return
      if (path404Ref.current === activeTab.filePath) return
      if (path404Ref.current !== null) path404Ref.current = null
      readFile(activeTab.filePath)
        .then((res) => {
          if (res.content !== activeTab.content) {
            useEditorStore.getState().reloadFromAi(activeTab.filePath)
          }
        })
        .catch((err) => {
          if (err instanceof HttpError && err.status === 404) {
            path404Ref.current = activeTab.filePath
            return
          }
          log.warn("Failed to poll file during streaming:", activeTab.filePath)
        })
    },
    2000,
    {
      enabled:
        isStreaming &&
        activeTab !== null &&
        !activeTab.diff &&
        (activeTab.fileKind ?? "text") === "text" &&
        !activeTab.isDirty,
    }
  )

  // Instant reload when a tool writes to the currently open file.
  useEffect(() => {
    const onFileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail
      const changedPath = detail?.path
      if (
        !activeTab ||
        activeTab.diff ||
        (activeTab.fileKind ?? "text") !== "text" ||
        activeTab.isDirty ||
        !changedPath
      )
        return
      const normChanged = changedPath.replace(/\\/g, "/")
      const normActive = activeTab.filePath.replace(/\\/g, "/")
      if (normChanged === normActive) {
        useEditorStore.getState().reloadFromAi(activeTab.filePath)
      }
    }
    window.addEventListener(
      "betterc0de:file-changed",
      onFileChanged as EventListener
    )
    return () =>
      window.removeEventListener(
        "betterc0de:file-changed",
        onFileChanged as EventListener
      )
  }, [activeTab])

  const handleSave = useCallback(() => {
    if (activeTabId) void runEditorSave(() => saveTab(activeTabId))
  }, [activeTabId, saveTab])

  const handleChange = useCallback(
    (value: string) => {
      if (activeTabId) updateContent(activeTabId, value)
    },
    [activeTabId, updateContent]
  )

  const handleCursorChange = useCallback(
    (line: number, column: number, selection?: EditorSelectionContext) => {
      if (activeTabId) updateCursor(activeTabId, line, column, selection)
    },
    [activeTabId, updateCursor]
  )

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      const tab = tabs.find((item) => item.id === tabId)
      if (!tab) return
      if (!confirmCloseDirtyEditorTabs([tab], "closing this editor")) return
      closeTab(tabId)
    },
    [closeTab, tabs]
  )

  const handleTabContextMenu = useCallback(
    (event: React.MouseEvent, tabId: string) => {
      event.preventDefault()
      event.stopPropagation()
      setActiveTab(tabId)
      setTabMenu({ x: event.clientX, y: event.clientY, tabId })
    },
    [setActiveTab]
  )

  const handleTabContentChange = useCallback(
    (tabId: string, value: string) => {
      updateContent(tabId, value)
    },
    [updateContent]
  )

  const handleTabCursorChange = useCallback(
    (
      tabId: string,
      line: number,
      column: number,
      selection?: EditorSelectionContext
    ) => {
      updateCursor(tabId, line, column, selection)
    },
    [updateCursor]
  )

  const closeTabWithDirtyConfirmation = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId)
      if (!tab) return
      if (!confirmCloseDirtyEditorTabs([tab], "closing this editor")) return
      closeTab(tabId)
    },
    [closeTab, tabs]
  )

  const closeOtherTabsWithDirtyConfirmation = useCallback(
    (tabId: string) => {
      const target = tabs.find((tab) => tab.id === tabId)
      if (!target) return
      const closingTabs = tabs.filter(
        (tab) => tab.id !== tabId && !tab.isPinned
      )
      if (!confirmCloseDirtyEditorTabs(closingTabs, "closing other editors"))
        return
      closeOtherTabs(tabId)
    },
    [closeOtherTabs, tabs]
  )

  const closeTabsToRightWithDirtyConfirmation = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return
      const closingTabs = tabs.slice(index + 1).filter((tab) => !tab.isPinned)
      if (
        !confirmCloseDirtyEditorTabs(
          closingTabs,
          "closing editors to the right"
        )
      )
        return
      closeTabsToRight(tabId)
    },
    [closeTabsToRight, tabs]
  )

  const closeAllTabsWithDirtyConfirmation = useCallback(() => {
    const closingTabs = tabs.filter((tab) => !tab.isPinned)
    if (!confirmCloseDirtyEditorTabs(closingTabs, "closing all editors")) return
    closeAllTabs()
  }, [closeAllTabs, tabs])

  const copyTabPath = useCallback(
    async (tab: EditorTab, kind: "absolute" | "relative") => {
      const path =
        kind === "relative"
          ? relativeEditorPath(projectPath, tab.filePath)
          : tab.filePath
      await copyText(path).catch((err) => {
        log.warn("Failed to copy editor tab path:", err)
      })
    },
    [projectPath]
  )

  const revealTabInExplorer = useCallback((tab: EditorTab) => {
    usePreferencesStore.getState().setMultiple({
      sidebarOpen: true,
      editorSidebarView: "files",
    })
    dispatchEditorRevealFile(tab.filePath, { defer: true })
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Tab Bar — rounded chip tabs (active = soft bg-muted pill), same
          visual language as the pane/panel/composer tab strips. The previous
          VS Code "connected tab" used bg-background + a bg-primary top
          stripe; with this theme's near-black background and near-white
          primary that rendered as a dark hole outlined in glaring white. */}
      <div className="relative flex h-11 shrink-0 items-center border-b border-border/40 bg-background">
        <div className="flex h-full shrink-0 items-center gap-0.5 border-r border-border/45 px-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={navigationBackCount === 0}
                  onClick={() => void goBack()}
                  aria-label="Go back"
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Go Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={navigationForwardCount === 0}
                  onClick={() => void goForward()}
                  aria-label="Go forward"
                >
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Go Forward</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Open files and browser"
        >
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={viewMode === "editor" && tab.id === activeTabId}
              onClick={() => {
                setActiveTab(tab.id)
                setViewMode("editor")
              }}
              onContextMenu={(event) => handleTabContextMenu(event, tab.id)}
              onTogglePin={(e) => {
                e.stopPropagation()
                togglePinTab(tab.id)
              }}
              onClose={(e) => handleCloseTab(e, tab.id)}
            />
          ))}
          {previewOpen && (
            <div
              role="tab"
              aria-label="Browser preview"
              aria-selected={viewMode === "preview"}
              tabIndex={viewMode === "preview" ? 0 : -1}
              onClick={() => setViewMode("preview")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  setViewMode("preview")
                }
              }}
              className={cn(
                "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px]",
                viewMode === "preview"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/40"
              )}
            >
              <GlobeIcon className="size-3.5 shrink-0" />
              <span className="max-w-48 truncate">
                {previewTabLabel(previewUrl)}
              </span>
              <button
                type="button"
                aria-label="Close browser tab"
                className="ml-1 grid size-5 place-items-center rounded hover:bg-background/60"
                onClick={(event) => {
                  event.stopPropagation()
                  setPreviewOpen(false)
                  setViewMode("editor")
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={splitTab ? "secondary" : "ghost"}
                  size="icon-xs"
                  disabled={!activeTabId}
                  onClick={() =>
                    splitTab ? closeSplitEditor() : openTabToSide(activeTabId)
                  }
                  aria-label={
                    splitTab ? "Close split editor" : "Split editor right"
                  }
                >
                  <SplitSquareHorizontalIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {splitTab ? "Close Split Editor" : "Split Editor Right"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setViewMode("preview")}
                  aria-label="Open browser preview"
                >
                  <GlobeIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open Browser Preview</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {viewMode === "editor" && activeTab && (
        <EditorBreadcrumbs
          projectPath={projectPath}
          activeTab={activeTab}
          outlinePath={activeOutlinePath}
        />
      )}

      {previewOpen && (
        <div
          className={cn(
            "min-h-0 flex-1 flex-col",
            viewMode === "preview" ? "flex" : "hidden"
          )}
        >
          <Suspense fallback={<div className="min-h-0 flex-1 bg-muted/20" />}>
            <BrowserPreviewPanel
              key={projectPath}
              projectPath={projectPath}
              onUrlChange={setPreviewUrl}
              className="min-h-0 flex-1"
              onClose={() => {
                setPreviewOpen(false)
                setViewMode("editor")
              }}
            />
          </Suspense>
        </div>
      )}

      {/* Editor Area */}
      <div className={cn("min-h-0 flex-1", viewMode === "preview" && "hidden")}>
        {activeTab ? (
          splitTab ? (
            <div
              ref={splitContainerRef}
              className={cn(
                "flex h-full min-h-0",
                isSplitResizing && "cursor-col-resize select-none"
              )}
            >
              <div
                className="flex min-w-0 flex-col"
                style={{
                  flexBasis: `${splitPrimaryPercent}%`,
                  flexGrow: 0,
                  flexShrink: 0,
                }}
              >
                <EditorPaneContent
                  tab={activeTab}
                  projectPath={projectPath}
                  onChange={(value) =>
                    handleTabContentChange(activeTab.id, value)
                  }
                  onSave={() => void runEditorSave(() => saveTab(activeTab.id))}
                  onCursorChange={(line, column, selection) =>
                    handleTabCursorChange(activeTab.id, line, column, selection)
                  }
                  onInlineEdit={onInlineEdit}
                  inlineEditProviders={inlineEditProviders}
                  inlineEditSelectedModelId={inlineEditSelectedModelId}
                  inlineEditSelectedProviderId={inlineEditSelectedProviderId}
                  onInlineEditModelChange={onInlineEditModelChange}
                />
              </div>
              <SplitEditorResizeHandle
                value={splitPrimaryPercent}
                onPointerDown={startSplitResize}
                onKeyDown={handleSplitResizeKeyDown}
                onReset={() =>
                  setClampedSplitPrimaryPercent(SPLIT_PRIMARY_DEFAULT_PERCENT)
                }
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <SplitEditorGroupHeader
                  tabs={tabs}
                  selectedTabId={splitTab.id}
                  projectPath={projectPath}
                  onSelectTab={setSplitTabId}
                  onClose={closeSplitEditor}
                />
                <EditorPaneContent
                  tab={splitTab}
                  projectPath={projectPath}
                  onChange={(value) =>
                    handleTabContentChange(splitTab.id, value)
                  }
                  onSave={() => void runEditorSave(() => saveTab(splitTab.id))}
                  onCursorChange={(line, column, selection) =>
                    handleTabCursorChange(splitTab.id, line, column, selection)
                  }
                  onInlineEdit={onInlineEdit}
                  inlineEditProviders={inlineEditProviders}
                  inlineEditSelectedModelId={inlineEditSelectedModelId}
                  inlineEditSelectedProviderId={inlineEditSelectedProviderId}
                  onInlineEditModelChange={onInlineEditModelChange}
                />
              </div>
            </div>
          ) : (
            <EditorPaneContent
              tab={activeTab}
              projectPath={projectPath}
              onChange={handleChange}
              onSave={handleSave}
              onCursorChange={handleCursorChange}
              onInlineEdit={onInlineEdit}
              inlineEditProviders={inlineEditProviders}
              inlineEditSelectedModelId={inlineEditSelectedModelId}
              inlineEditSelectedProviderId={inlineEditSelectedProviderId}
              onInlineEditModelChange={onInlineEditModelChange}
            />
          )
        ) : projectPath ? (
          <CodebaseOverview
            projectPath={projectPath}
            onOpenBrowser={() => setViewMode("preview")}
            onOpenFile={(relativePath) =>
              useEditorStore
                .getState()
                .openFile(resolveWorkspaceFilePath(projectPath, relativePath))
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>

      {/* Status Bar */}
      {viewMode === "editor" && activeTab && (
        <EditorStatusBar
          activeTab={activeTab}
          projectPath={projectPath}
          onDismissAiDiff={() =>
            useEditorStore.getState().clearAiDiff(activeTab.id)
          }
        />
      )}
      {contextTab && tabMenu && (
        <EditorTabContextMenu
          position={tabMenu}
          actions={[
            ...(contextTab.isPreview
              ? [
                  {
                    id: "keep-preview",
                    label: "Keep Preview Open",
                    hint: contextTab.fileName,
                    run: () =>
                      contextTab.diff
                        ? useEditorStore.getState().openDiff(contextTab.diff)
                        : void useEditorStore
                            .getState()
                            .openFile(contextTab.filePath, {
                              preview: false,
                              reloadExisting: false,
                              preserveNavigation: true,
                            }),
                  },
                ]
              : []),
            {
              id: "pin",
              label: contextTab.isPinned ? "Unpin Editor" : "Pin Editor",
              hint: contextTab.fileName,
              run: () => togglePinTab(contextTab.id),
            },
            {
              id: "reveal",
              label: "Reveal in Explorer",
              hint: relativeEditorPath(projectPath, contextTab.filePath),
              run: () => revealTabInExplorer(contextTab),
            },
            {
              id: "copy-relative",
              label: "Copy Relative Path",
              run: () => void copyTabPath(contextTab, "relative"),
            },
            {
              id: "copy-absolute",
              label: "Copy Path",
              run: () => void copyTabPath(contextTab, "absolute"),
            },
            {
              id: "open-to-side",
              label: "Open to Side",
              hint: contextTab.fileName,
              run: () => openTabToSide(contextTab.id),
            },
            {
              id: "close",
              label: "Close",
              run: () => closeTabWithDirtyConfirmation(contextTab.id),
            },
            {
              id: "close-others",
              label: "Close Others",
              hint: `${contextOtherTabsCount} editor${contextOtherTabsCount === 1 ? "" : "s"}`,
              disabled: contextOtherTabsCount === 0,
              run: () => closeOtherTabsWithDirtyConfirmation(contextTab.id),
            },
            {
              id: "close-right",
              label: "Close to the Right",
              hint: `${contextTabsRightCount} right`,
              disabled: contextTabsRightCount === 0,
              run: () => closeTabsToRightWithDirtyConfirmation(contextTab.id),
            },
            {
              id: "close-saved",
              label: "Close Saved Editors",
              hint: `${contextSavedTabsCount} saved`,
              disabled: contextSavedTabsCount === 0,
              run: closeSavedTabs,
            },
            {
              id: "close-all",
              label: "Close All Editors",
              hint: `${contextClosableTabsCount} editor${contextClosableTabsCount === 1 ? "" : "s"}`,
              disabled: contextClosableTabsCount === 0,
              run: closeAllTabsWithDirtyConfirmation,
            },
          ]}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  )
}

function EditorPaneContent({
  tab,
  projectPath,
  onChange,
  onSave,
  onCursorChange,
  onInlineEdit,
  inlineEditProviders,
  inlineEditSelectedModelId,
  inlineEditSelectedProviderId,
  onInlineEditModelChange,
}: {
  tab: EditorTab
  projectPath?: string | null
  onChange: (value: string) => void
  onSave: () => void
  onCursorChange?: (
    line: number,
    column: number,
    selection?: EditorSelectionContext
  ) => void
  onInlineEdit?: (request: InlineEditRequest) => void | Promise<void>
  inlineEditProviders?: InlineEditProvider[]
  inlineEditSelectedModelId?: string
  inlineEditSelectedProviderId?: string
  onInlineEditModelChange?: (modelId: string, providerId: string) => void
}) {
  if (tab.diff) {
    return (
      <div
        className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        data-editor-diff={tab.diff.source}
      >
        <Suspense
          fallback={
            <p role="status" className="p-4 text-xs text-muted-foreground">
              Loading comparison…
            </p>
          }
        >
          <DiffPanel
            key={`${tab.id}:${tab.diff.source}`}
            open
            cwd={tab.diff.cwd}
            fileTarget={tab.diff}
            onClose={() => useEditorStore.getState().closeTab(tab.id)}
          />
        </Suspense>
      </div>
    )
  }
  if (tab.isLoading) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  if ((tab.fileKind ?? "text") !== "text") {
    return (
      <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading preview…
            </div>
          }
        >
          <FilePreview tab={tab} />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading editor...
          </div>
        }
      >
        <MonacoEditorWrapper
          workbench
          filePath={tab.filePath}
          projectPath={projectPath}
          language={tab.language}
          value={tab.content}
          onChange={onChange}
          onSave={onSave}
          onCursorChange={onCursorChange}
          onInlineEdit={onInlineEdit}
          aiBaselineContent={tab.aiBaselineContent}
          inlineEditProviders={inlineEditProviders}
          inlineEditSelectedModelId={inlineEditSelectedModelId}
          inlineEditSelectedProviderId={inlineEditSelectedProviderId}
          onInlineEditModelChange={onInlineEditModelChange}
        />
      </Suspense>
    </div>
  )
}

function SplitEditorGroupHeader({
  tabs,
  selectedTabId,
  projectPath,
  onSelectTab,
  onClose,
}: {
  tabs: readonly EditorTab[]
  selectedTabId: string
  projectPath?: string | null
  onSelectTab: (tabId: string) => void
  onClose: () => void
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-sidebar">
      <div
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Split editor files"
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selectedTabId
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => onSelectTab(tab.id)}
              title={
                tab.diff
                  ? `${tab.filePath} (${editorDiffLabel(tab.diff)})`
                  : tab.filePath
              }
              className={cn(
                "flex h-full max-w-[180px] min-w-[92px] shrink-0 items-center gap-1.5 border-r border-border/35 px-2 text-[11px] transition-colors",
                isSelected
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
              )}
            >
              <img
                src={getFileIconUrl(tab.fileName)}
                alt=""
                className="size-3.5 shrink-0"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-left",
                  tab.isPreview && "italic"
                )}
              >
                {tab.fileName}
              </span>
              {tab.diff && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {editorDiffLabel(tab.diff)}
                </span>
              )}
              {tab.isDirty && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-400"
                  aria-label="Unsaved changes"
                />
              )}
            </button>
          )
        })}
      </div>
      <span
        className="hidden max-w-[180px] shrink-0 truncate px-2 text-[10px] text-muted-foreground lg:block"
        title={
          tabs.find((tab) => tab.id === selectedTabId)?.filePath ?? undefined
        }
      >
        {relativeEditorPath(
          projectPath,
          tabs.find((tab) => tab.id === selectedTabId)?.filePath ?? ""
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        className="mx-1 shrink-0"
        aria-label="Close split editor"
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  )
}

function SplitEditorResizeHandle({
  value,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  value: number
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onReset: () => void
}) {
  const roundedValue = Math.round(value)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize split editor"
      aria-valuemin={SPLIT_PRIMARY_MIN_PERCENT}
      aria-valuemax={SPLIT_PRIMARY_MAX_PERCENT}
      aria-valuenow={roundedValue}
      aria-valuetext={`Left editor ${roundedValue} percent`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      title="Drag to resize split editor. Double-click to reset."
      className="group relative z-10 flex w-2 shrink-0 cursor-col-resize items-stretch justify-center outline-none focus-visible:bg-primary/10"
    >
      <span className="pointer-events-none block h-full w-px bg-border/70 transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
      <span className="pointer-events-none absolute top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-primary/35 group-focus-visible:bg-primary/50" />
    </div>
  )
}

function EditorBreadcrumbs({
  projectPath,
  activeTab,
  outlinePath,
}: {
  projectPath?: string | null
  activeTab: EditorTab
  outlinePath: readonly CodeOutlineItem[]
}) {
  const segments = buildEditorBreadcrumbSegments(
    projectPath,
    activeTab.filePath
  )
  if (!shouldShowEditorBreadcrumbs(segments.length, outlinePath.length)) {
    return null
  }
  const fileSegment = segments[segments.length - 1]
  const folders = segments.slice(0, -1)
  const revealSegmentInExplorer = (
    segment: ReturnType<typeof buildEditorBreadcrumbSegments>[number]
  ) => {
    if (!segment.revealable) return
    usePreferencesStore.getState().setMultiple({
      sidebarOpen: true,
      editorSidebarView: "files",
    })
    dispatchEditorRevealFile(segment.absolutePath, { defer: true })
  }
  const jumpToOutlineItem = (item: CodeOutlineItem) => {
    window.dispatchEvent(
      new CustomEvent("betterc0de:editor-goto-line", {
        detail: {
          filePath: activeTab.filePath,
          line: item.line,
          column: item.column,
        },
      })
    )
  }

  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1 overflow-hidden border-b border-border/45 bg-background px-2 text-[10.5px] text-muted-foreground"
      title={activeTab.filePath}
    >
      {folders.map((segment, index) => (
        <div
          key={`${segment.relativePath}-${index}`}
          className="flex min-w-0 items-center gap-1"
        >
          {segment.revealable ? (
            <button
              type="button"
              onClick={() => revealSegmentInExplorer(segment)}
              className="max-w-[112px] truncate rounded px-1 py-px text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
              title={`Reveal ${segment.relativePath} in Explorer`}
            >
              {segment.label}
            </button>
          ) : (
            <span className="max-w-[112px] truncate">{segment.label}</span>
          )}
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/45" />
        </div>
      ))}
      <img
        src={getFileIconUrl(fileSegment?.label ?? activeTab.fileName)}
        alt=""
        className="size-3.5 shrink-0"
      />
      {fileSegment?.revealable ? (
        <button
          type="button"
          onClick={() => revealSegmentInExplorer(fileSegment)}
          className="min-w-0 truncate rounded px-1 py-px font-medium text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          title={`Reveal ${fileSegment.relativePath} in Explorer`}
        >
          {fileSegment.label}
        </button>
      ) : (
        <span className="min-w-0 truncate font-medium text-foreground">
          {fileSegment?.label ?? activeTab.fileName}
        </span>
      )}
      {activeTab.isDirty && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-amber-400"
          aria-label="Unsaved changes"
        />
      )}
      {outlinePath.length > 0 && (
        <>
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/45" />
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            {outlinePath.map((item, index) => (
              <div key={item.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => jumpToOutlineItem(item)}
                  className="min-w-0 truncate rounded px-1 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
                  title={`${item.kind} ${item.name} (${item.line}:${item.column})`}
                >
                  {item.name}
                </button>
                {index < outlinePath.length - 1 && (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/35" />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function EditorStatusBar({
  activeTab,
  projectPath,
  onDismissAiDiff,
}: {
  activeTab: EditorTab
  projectPath?: string | null
  onDismissAiDiff: () => void
}) {
  const stats = getEditorStats(activeTab.content)
  const relativePath = relativeEditorPath(projectPath, activeTab.filePath)
  const editorWordWrap = usePreferencesStore((state) => state.editorWordWrap)
  const editorMinimap = usePreferencesStore((state) => state.editorMinimap)
  const editorStickyScroll = usePreferencesStore(
    (state) => state.editorStickyScroll
  )
  const editorRenderWhitespace = usePreferencesStore(
    (state) => state.editorRenderWhitespace
  )
  const editorInlayHints = usePreferencesStore(
    (state) => state.editorInlayHints
  )
  const editorLineNumbers = usePreferencesStore(
    (state) => state.editorLineNumbers
  )
  const setPreference = usePreferencesStore((state) => state.set)
  const diagnosticsByFile = useEditorDiagnosticsStore(
    (state) => state.diagnosticsByFile
  )
  const diagnosticCounts = useMemo(
    () => countEditorDiagnostics(selectAllEditorDiagnostics(diagnosticsByFile)),
    [diagnosticsByFile]
  )
  const diagnosticTotal =
    diagnosticCounts.error +
    diagnosticCounts.warning +
    diagnosticCounts.info +
    diagnosticCounts.hint
  const revealActiveFileInExplorer = useCallback(() => {
    usePreferencesStore.getState().setMultiple({
      sidebarOpen: true,
      editorSidebarView: "files",
    })
    dispatchEditorRevealFile(activeTab.filePath, { defer: true })
  }, [activeTab.filePath])

  if (activeTab.diff || (activeTab.fileKind ?? "text") !== "text") {
    return (
      <div className="flex h-6 shrink-0 items-center gap-2.5 border-t border-border/40 bg-muted/20 px-2 text-[9.5px] text-muted-foreground">
        <button
          type="button"
          onClick={revealActiveFileInExplorer}
          className="min-w-0 truncate rounded px-1 py-px text-left font-mono transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
          title={`Reveal ${activeTab.filePath} in Explorer`}
          aria-label={`Reveal ${relativePath} in Explorer`}
        >
          {relativePath}
        </button>
        <div className="flex-1" />
        <span className="shrink-0 capitalize">
          {activeTab.diff
            ? `${editorDiffLabel(activeTab.diff)} · Read-only comparison`
            : `${activeTab.fileKind ?? "file"} preview`}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-6 shrink-0 items-center gap-2.5 border-t border-border/40 bg-muted/20 px-2 text-[9.5px] text-muted-foreground">
      <button
        type="button"
        onClick={revealActiveFileInExplorer}
        className="min-w-0 truncate rounded px-1 py-px text-left font-mono transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
        title={`Reveal ${activeTab.filePath} in Explorer`}
        aria-label={`Reveal ${relativePath} in Explorer`}
      >
        {relativePath}
      </button>
      <div className="flex-1" />
      {activeTab.aiBaselineContent !== null && (
        <button
          type="button"
          onClick={onDismissAiDiff}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
          title="Dismiss AI diff highlighting"
        >
          <span className="size-1.5 rounded-full bg-emerald-500" />
          AI modified
        </button>
      )}
      {activeTab.isDirty && (
        <span className="shrink-0 font-medium text-amber-400">Modified</span>
      )}
      {diagnosticTotal > 0 && (
        <span
          className="flex shrink-0 items-center gap-1.5 px-1.5 py-0.5"
          aria-label={`Diagnostics: ${diagnosticCounts.error} errors, ${diagnosticCounts.warning} warnings`}
        >
          {diagnosticCounts.error > 0 && (
            <span className="flex items-center gap-0.5 text-red-500 dark:text-red-400">
              <CircleAlertIcon className="size-3" aria-hidden />
              {diagnosticCounts.error}
            </span>
          )}
          {diagnosticCounts.warning > 0 && (
            <span className="flex items-center gap-0.5 text-amber-500 dark:text-amber-400">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {diagnosticCounts.warning}
            </span>
          )}
          {diagnosticCounts.error === 0 && diagnosticCounts.warning === 0 && (
            <span className="flex items-center gap-0.5">
              <CircleAlertIcon className="size-3" aria-hidden />
              {diagnosticCounts.info + diagnosticCounts.hint}
            </span>
          )}
        </span>
      )}
      <span className="shrink-0">{activeTab.language}</span>
      <button
        type="button"
        onClick={() => setPreference("editorWordWrap", !editorWordWrap)}
        className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
        title="Toggle word wrap"
      >
        Wrap {editorWordWrap ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={() => setPreference("editorMinimap", !editorMinimap)}
        className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted"
        title="Toggle minimap"
      >
        Map {editorMinimap ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={() => setPreference("editorStickyScroll", !editorStickyScroll)}
        className="hidden shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted md:inline-flex"
        title="Toggle sticky scroll"
      >
        Sticky {editorStickyScroll ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={() =>
          setPreference("editorRenderWhitespace", !editorRenderWhitespace)
        }
        className="hidden shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted lg:inline-flex"
        title="Toggle render whitespace"
      >
        Spaces {editorRenderWhitespace ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={() => setPreference("editorInlayHints", !editorInlayHints)}
        className="hidden shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted lg:inline-flex"
        title="Toggle inlay hints"
      >
        Hints {editorInlayHints ? "On" : "Off"}
      </button>
      <button
        type="button"
        onClick={() => setPreference("editorLineNumbers", !editorLineNumbers)}
        className="hidden shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted xl:inline-flex"
        title="Toggle line numbers"
      >
        Lines {editorLineNumbers ? "On" : "Off"}
      </button>
      <span className="shrink-0">
        Ln {activeTab.cursorLine}, Col {activeTab.cursorColumn}
      </span>
      {activeTab.selectionCharCount > 0 && (
        <span className="hidden shrink-0 sm:inline">
          {formatSelectionStats(
            activeTab.selectionLineCount,
            activeTab.selectionCharCount
          )}
        </span>
      )}
      <span className="hidden shrink-0 sm:inline">{stats.lines} lines</span>
      <span className="hidden shrink-0 md:inline">{stats.size}</span>
      <span className="shrink-0">UTF-8</span>
    </div>
  )
}

function formatSelectionStats(lineCount: number, charCount: number): string {
  const lines = lineCount > 1 ? `${lineCount} lines, ` : ""
  return `Sel ${lines}${charCount} chars`
}

function getEditorStats(content: string): { lines: number; size: string } {
  const lines = content.length === 0 ? 1 : content.split(/\r\n|\r|\n/g).length
  const bytes = new TextEncoder().encode(content).byteLength
  return { lines, size: formatBytes(bytes) }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${formatCompactNumber(kb)} KB`
  return `${formatCompactNumber(kb / 1024)} MB`
}

function formatCompactNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}

function TabItem({
  tab,
  isActive,
  onClick,
  onContextMenu,
  onTogglePin,
  onClose,
}: {
  tab: EditorTab
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
  onTogglePin: (e: React.MouseEvent<HTMLButtonElement>) => void
  onClose: (e: React.MouseEvent) => void
}) {
  const [closeHovered, setCloseHovered] = useState(false)

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={() => {
        if (tab.diff) useEditorStore.getState().openDiff(tab.diff)
        else
          void useEditorStore
            .getState()
            .openFile(tab.filePath, { reloadExisting: false })
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick()
        }
      }}
      onAuxClick={(e) => {
        // Middle click closes — standard VS Code UX.
        if (e.button === 1) {
          e.preventDefault()
          onClose(e as unknown as React.MouseEvent)
        }
      }}
      title={
        tab.diff
          ? `${tab.filePath} (${editorDiffLabel(tab.diff)})`
          : tab.filePath
      }
      className={cn(
        "group relative flex h-7 max-w-60 min-w-32 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-[11px] transition-colors outline-none select-none 2xl:max-w-72 2xl:min-w-40",
        "focus-visible:ring-1 focus-visible:ring-ring/25 focus-visible:ring-inset",
        isActive
          ? "bg-muted/70 text-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
    >
      {tab.isPinned && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-label="Unpin editor"
          aria-pressed={true}
          title="Unpin editor"
          className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-primary hover:bg-muted-foreground/20"
        >
          <PinIcon className="size-2.5" aria-hidden />
        </button>
      )}
      <img
        src={getFileIconUrl(tab.fileName)}
        alt=""
        className={cn(
          "size-3.5 shrink-0",
          isActive ? "opacity-100" : "opacity-80"
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          tab.isPreview && "text-muted-foreground italic"
        )}
      >
        {tab.fileName}
      </span>
      {tab.diff && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {editorDiffLabel(tab.diff)}
        </span>
      )}
      {/* Close / dirty — dirty tabs show a dot in the close slot by default,
          hover swaps to X so the user always has a one-click close. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose(e)
        }}
        onMouseEnter={() => setCloseHovered(true)}
        onMouseLeave={() => setCloseHovered(false)}
        aria-label={tab.isDirty ? "Close (unsaved changes)" : "Close"}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/80 hover:bg-muted-foreground/20 hover:text-foreground",
          // Always visible on the active tab, and whenever the file is
          // dirty (so the unsaved-dot is persistent); otherwise hover to reveal.
          isActive || tab.isDirty
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100"
        )}
      >
        {tab.isDirty && !closeHovered ? (
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
        ) : (
          <XIcon className="size-3" aria-hidden />
        )}
      </button>
    </div>
  )
}

interface EditorTabContextAction {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  run: () => void
}

function EditorTabContextMenu({
  position,
  actions,
  onClose,
}: {
  position: { x: number; y: number }
  actions: readonly EditorTabContextAction[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const width = 260
  const height = Math.min(360, actions.length * 34 + 12)
  const left =
    typeof window === "undefined"
      ? position.x
      : Math.max(8, Math.min(position.x, window.innerWidth - width - 8))
  const top =
    typeof window === "undefined"
      ? position.y
      : Math.max(8, Math.min(position.y, window.innerHeight - height - 8))

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        role="menu"
        aria-label="Editor tab actions"
        className="absolute w-[260px] rounded-md border border-border/60 bg-popover p-1 text-xs text-popover-foreground shadow-xl shadow-black/25"
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            disabled={action.disabled}
            onClick={() => {
              if (action.disabled) return
              action.run()
              onClose()
            }}
            className={cn(
              "flex h-8 w-full items-center justify-between gap-3 rounded px-2 text-left transition-colors",
              action.disabled
                ? "cursor-default text-muted-foreground/40"
                : "text-popover-foreground hover:bg-muted"
            )}
          >
            <span className="min-w-0 truncate">{action.label}</span>
            {action.hint && (
              <span className="max-w-[110px] shrink-0 truncate text-[10px] text-muted-foreground">
                {action.hint}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body
  )
}
