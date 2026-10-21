import type { CSSProperties } from "react"
import { FolderOpenIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChatStore, type ChatThread } from "@/lib/chat-store"
import { useThreadMessageCount } from "@/lib/chat/thread-derived"
import { useConsoleLogStore } from "@/lib/console-log-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { clampEditorChatPanelWidth } from "@/lib/editor-layout"
import type { MainAreaProps } from "@/hooks/use-app-shell-bundles"
import { Button } from "@/components/ui/button"
import { EditorModeSplitView } from "@/components/layout/editor-mode-split-view"
import { ChatWorkbenchPanel } from "@/components/layout/chat-workbench-panel"
import { MultiAgentSwarmView } from "@/components/layout/multi-agent-swarm-view"
import { ConsolePanel } from "@/components/layout/console-panel"
import { ChatColumn } from "@/components/layout/chat-column"
import { PaneGrid } from "@/components/layout/panes/pane-grid"
import { DesignModeSurface } from "@/components/layout/design-mode-surface"

/**
 * The `<main>` content area: editor split-view in editor mode, then the
 * chat column(s) — a single {@link ChatColumn} in normal mode, or several
 * editor chats stacked vertically (`splitTabIds` drives which tabs render).
 * Console panel + modals hang off the bottom / sibling slot.
 *
 * Each `ChatColumn` subscribes to its own thread's messages + streaming
 * state via its `threadId` prop, so split columns update independently as
 * their respective threads stream.
 */
export function MainArea(props: MainAreaProps) {
  const {
    wsReady: _wsReady,
    appMode,
    activeThread,
    activeThreadId,
    sidebarOpen,
    setSidebarOpen,
    minimalChat,
    chatPanelWidth,
    setChatPanelWidth,
    // Editor mode
    handleInlineEdit,
    providers,
    selectedModel,
    selectedProviderId,
    setSelectedModel,
    setSelectedProviderId,
    setContextWindow,
    terminalOpen,
    setTerminalOpen,
    diffOpen,
    setDiffOpen,
    // Chat toolbar
    setConfirmAction,
    // Composer tabs
    composerTabs,
    activeComposerTab,
    setActiveComposerTab,
    closeComposerTab,
    addComposerTab,
    maxComposerTabs,
    splitTabIds,
    splitMode,
    maxSplit,
    enterSplitMode,
    exitSplitMode,
    addTabToSplit,
    removeTabFromSplit,
    addSplitColumn,
    reorderTab,
    insertIntoSplit,
    // Panes (agent-mode grid)
    paneLayout,
    closePane,
    setActivePane,
    addTab,
    setActiveTab,
    closeTab,
    moveTabToPane,
    openThreadOnPane,
    setEditingFile,
    // Chat transcript
    swarmActive,
    handleSubmit,
    setPlanModalContent,
    chatMode,
    selectedProvider,
    // Input area
    thinkingMode,
    setThinkingMode,
    specialMode,
    permissionLevel,
    deepgram,
    composerProps,
    // Console panel
    consolePanelOpen,
    consolePanelHeight,
    setConsolePanelHeight,
    setConsolePanelOpen,
    setSystemBrowserOpen,
    setSystemBrowserIntent,
    // AppModals rendering inside main
    appModals,
  } = props

  const activeTabIds: string[] =
    splitMode && splitTabIds && splitTabIds.length > 0
      ? splitTabIds
      : [activeComposerTab]

  const consolePanel = consolePanelOpen ? (
    <ConsolePanelSlot
      consolePanelHeight={consolePanelHeight}
      setConsolePanelHeight={setConsolePanelHeight}
      setConsolePanelOpen={setConsolePanelOpen}
      activeThread={activeThread}
      selectedModel={selectedModel}
    />
  ) : null

  const renderColumn = (tabId: string) => {
    const tab = composerTabs.find((t: { id: string }) => t.id === tabId)
    if (!tab) return null
    const isActive = tabId === activeComposerTab
    return (
      <ChatColumn
        key={tabId}
        tabId={tabId}
        threadId={tab.threadId}
        isActive={isActive}
        onActivate={() => {
          setActiveComposerTab(tabId)
          if (tab.threadId) {
            useChatStore.getState().setActiveThread(tab.threadId)
          }
        }}
        appMode={appMode}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        minimalChat={minimalChat}
        chatMode={chatMode}
        handleSubmit={handleSubmit}
        setConfirmAction={setConfirmAction}
        setPlanModalContent={setPlanModalContent}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        thinkingMode={thinkingMode}
        specialMode={specialMode}
        permissionLevel={permissionLevel}
        deepgram={deepgram}
        composerProps={composerProps}
        terminalOpen={terminalOpen}
        setTerminalOpen={setTerminalOpen}
        diffOpen={diffOpen}
        setDiffOpen={setDiffOpen}
      />
    )
  }

  // The one chat container editor and design share.
  const renderChatWorkbenchPanel = (frame: {
    className?: string
    style?: CSSProperties
  }) => (
    <ChatWorkbenchPanel
      className={frame.className}
      style={frame.style}
      mode={appMode === "design" ? "design" : "editor"}
      minimalChat={minimalChat}
      activeThread={activeThread}
      setConfirmAction={setConfirmAction}
      tabs={{
        composerTabs,
        activeComposerTab,
        setActiveComposerTab,
        closeComposerTab,
        splitTabIds,
        splitMode,
        maxSplit,
        enterSplitMode,
        exitSplitMode,
        addTabToSplit,
        removeTabFromSplit,
        reorderTab,
        addComposerTab,
        addSplitColumn,
        maxComposerTabs,
      }}
      activeTabIds={activeTabIds}
      splitMode={Boolean(splitMode)}
      insertIntoSplit={insertIntoSplit}
      renderColumn={renderColumn}
    >
      {consolePanel}
    </ChatWorkbenchPanel>
  )

  // Shared prop set for every pane's ChatColumn — passed as one object through
  // PaneGrid → Pane → ChatColumn (avoids re-drilling ~35 props per layer).
  const chatBag = {
    appMode,
    showInlinePanels: false,
    sidebarOpen,
    setSidebarOpen,
    minimalChat,
    chatMode,
    handleSubmit,
    setConfirmAction,
    setPlanModalContent,
    selectedProvider,
    selectedModel,
    thinkingMode,
    specialMode,
    permissionLevel,
    deepgram,
    composerProps,
    setEditingFile,
    terminalOpen,
    setTerminalOpen,
    diffOpen,
    setDiffOpen,
  }

  const isEditorMode = appMode === "editor"
  const isDesignMode = appMode === "design"
  const editorProjectPath = isEditorMode
    ? resolveThreadRuntimePath(activeThread)
    : null
  const isEditorWithoutWorkspace = isEditorMode && !editorProjectPath
  const editorChatPanelWidth = clampEditorChatPanelWidth(chatPanelWidth)

  if (isDesignMode) {
    return (
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <DesignModeSurface
          providers={providers}
          activeThreadId={activeThreadId}
          renderChatPanel={renderChatWorkbenchPanel}
        />
        {appModals}
      </main>
    )
  }

  if (isEditorWithoutWorkspace) {
    // Framed like the workbench below, so the sidebar card keeps its gap.
    return (
      <main className="editor-workbench flex min-w-0 flex-1 overflow-hidden bg-sidebar p-2">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40 bg-background">
          <EditorWorkspaceEmptyCanvas
            onOpenWorkspace={() => {
              setSystemBrowserIntent("editor-open-folder")
              setSystemBrowserOpen(true)
            }}
          />
        </div>
        {appModals}
      </main>
    )
  }

  return (
    <main
      className={cn(
        "flex min-w-0 flex-1 bg-background",
        isEditorMode
          ? "editor-workbench flex-row overflow-hidden bg-sidebar p-2"
          : "flex-col"
      )}
    >
      {isEditorMode && (
        <EditorModeSplitView
          projectPath={editorProjectPath ?? ""}
          handleInlineEdit={handleInlineEdit}
          providers={providers}
          selectedModel={selectedModel}
          selectedProviderId={selectedProviderId}
          thinkingMode={thinkingMode}
          setSelectedModel={setSelectedModel}
          setSelectedProviderId={setSelectedProviderId}
          setContextWindow={setContextWindow}
          setThinkingMode={setThinkingMode}
          diffOpen={diffOpen}
          setDiffOpen={setDiffOpen}
          chatPanelWidth={editorChatPanelWidth}
          setChatPanelWidth={setChatPanelWidth}
        />
      )}

      {/* ═══════ CHAT UI ═══════ */}
      {isEditorMode && !swarmActive ? (
        renderChatWorkbenchPanel({
          style: {
            width: `min(${editorChatPanelWidth}px, calc(100% - 308px))`,
            minWidth: 280,
          },
        })
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Chat area — swarm grid or agent pane grid */}
          {swarmActive ? (
            <MultiAgentSwarmView providers={providers} />
          ) : (
            <PaneGrid
              layout={paneLayout}
              chatBag={chatBag}
              setActivePane={setActivePane}
              closePane={closePane}
              setActiveTab={setActiveTab}
              closeTab={closeTab}
              addTab={addTab}
              moveTabToPane={moveTabToPane}
              openThreadOnPane={openThreadOnPane}
            />
          )}

          {consolePanel}
        </div>
      )}
      {/* end chat column */}

      {appModals}
    </main>
  )
}

/**
 * The console panel with its live inputs. The log stream and the message
 * count are read here, so a flushed log batch or a new message re-renders the
 * panel, not the main area.
 */
function ConsolePanelSlot({
  consolePanelHeight,
  setConsolePanelHeight,
  setConsolePanelOpen,
  activeThread,
  selectedModel,
}: {
  consolePanelHeight: number
  setConsolePanelHeight: (height: number) => void
  setConsolePanelOpen: (open: boolean) => void
  activeThread: ChatThread | null
  selectedModel: string
}) {
  const consoleLogs = useConsoleLogStore((s) => s.logs)
  const setConsoleLogs = useConsoleLogStore((s) => s.setLogs)
  const consoleTab = useConsoleLogStore((s) => s.tab)
  const setConsoleTab = useConsoleLogStore((s) => s.setTab)
  const messageCount = useThreadMessageCount(activeThread?.id ?? null)
  return (
    <ConsolePanel
      consolePanelHeight={consolePanelHeight}
      setConsolePanelHeight={setConsolePanelHeight}
      consolePanelOpen
      setConsolePanelOpen={setConsolePanelOpen}
      consoleTab={consoleTab}
      setConsoleTab={setConsoleTab}
      consoleLogs={consoleLogs}
      setConsoleLogs={setConsoleLogs}
      activeThread={activeThread}
      selectedModel={selectedModel}
      messageCount={messageCount}
    />
  )
}

function EditorWorkspaceEmptyCanvas({
  onOpenWorkspace,
}: {
  onOpenWorkspace: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-[420px] flex-col items-center text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/35 text-sidebar-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <FolderOpenIcon className="size-4" strokeWidth={1.75} />
        </div>
        <div className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground/65 uppercase">
          Editor Mode
        </div>
        <h2 className="mt-2 text-lg font-semibold tracking-normal text-sidebar-foreground">
          Open Workspace
        </h2>
        <p className="mt-2 max-w-[360px] text-xs leading-5 text-muted-foreground">
          Choose a project folder to show files, source control, terminal and
          editor tools.
        </p>
        <div className="mt-5">
          <Button
            type="button"
            size="sm"
            className="h-8 gap-2 rounded-md px-3 text-xs"
            onClick={onOpenWorkspace}
          >
            <FolderOpenIcon className="size-3.5" />
            Open Workspace
          </Button>
        </div>
      </div>
    </div>
  )
}
