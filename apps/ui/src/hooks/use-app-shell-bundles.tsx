import { useCallback, useEffect } from "react"
import { displayModelName } from "@/lib/model-display-name"
import { AppModals } from "@/components/layout/app-modals"
import {
  getThreadStream,
  useActiveThread,
  useChatStore,
} from "@/lib/chat-store"
import { useThreadProviderLock } from "@/lib/chat/thread-derived"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { toggleDiffView } from "@/lib/diff-view"
import { useRuntimeHookBridge } from "@/lib/runtime-hooks"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import { appUiActions } from "@/lib/app-ui-store"
import { composerMenuActions } from "@/lib/composer-menu-store"
import { useConsoleLogStore } from "@/lib/console-log-store"
import { useAppearanceState } from "@/hooks/use-appearance-state"
import { useChatEventBus } from "@/hooks/use-chat-event-bus"
import { useChatStop } from "@/hooks/use-chat-stop"
import { useChatSubmit } from "@/hooks/use-chat-submit"
import { useMessageQueue } from "@/hooks/use-message-queue"
import { useComposerTabs } from "@/hooks/use-composer-tabs"
import { usePanes } from "@/hooks/use-panes"
import { useConsoleCapture } from "@/hooks/use-console-capture"
import { useFavorites } from "@/hooks/use-favorites"
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts"
import { useInlineEdit } from "@/hooks/use-inline-edit"
import { useApprovalAttention } from "@/hooks/use-approval-attention"
import { useAttentionNotifications } from "@/hooks/use-attention-notifications"
import { useNativeNotifications } from "@/hooks/use-native-notifications"
import { useCliAutoSync } from "@/hooks/use-cli-auto-sync"
import { usePersistedThreads } from "@/hooks/use-persisted-threads"
import { useProvidersWithLmStudio } from "@/hooks/use-providers-with-lm-studio"
import { useRightSidebarResize } from "@/hooks/use-right-sidebar-resize"
import { useSelectedProvider } from "@/hooks/use-selected-provider"
import { useStartupInit } from "@/hooks/use-startup-init"
import { useToolApproval } from "@/hooks/use-tool-approval"
import { useUiSounds } from "@/hooks/use-ui-sounds"
import { useVoiceInput } from "@/hooks/use-voice-input"
import { useApplyLaunchParams } from "@/hooks/use-apply-launch-params"
import { useEditorWorkspace } from "@/hooks/use-editor-workspace"
import { clampEditorChatPanelWidth } from "@/lib/editor-layout"
import { getElectronApi } from "@/services/ipc-facade"
import { openAutomationsPage } from "@/lib/automations-page"

/**
 * Meta-hook that assembles every state hook the app needs plus the
 * prop bags for each of the `<AppShell>` slots.
 *
 * The original App.tsx returned a ~240-line `<AppShell>` call where every
 * prop bag spelled out ~30 fields. Moving that assembly here keeps App.tsx
 * tiny (import → hook call → render) while still keeping the zustand
 * selector pattern: each underlying store hook runs at this level, so
 * components downstream only get plain objects.
 *
 * Structured as a single flat function because the prop bags cross-reference
 * each other (e.g. `composerProps` folds into `mainAreaProps`) — splitting
 * it up would just create many small files that each need the same
 * arguments.
 *
 * Every state change here re-renders the whole shell, so state that changes
 * while the user types or works does not live here: modal flags and their
 * inputs are in `app-ui-store`, the composer's `/` and `@` menus in
 * `composer-menu-store`, the captured console in `console-log-store`, and the
 * transcript in the chat store. This hook only takes their setters, which
 * never change, and the components that show a value subscribe to it.
 */
export function useAppShellBundles() {
  useRuntimeHookBridge()
  useNativeNotifications()
  useAttentionNotifications()
  useApprovalAttention()

  const activeThread = useActiveThread()
  const { gitUserName, gitHubUser } = useStartupInit(
    activeThread?.projectPath ?? null
  )

  const {
    sidebarOpen,
    setSidebarOpen,
    selectedModel,
    setSelectedModel,
    selectedProviderId,
    setSelectedProviderId,
    contextWindow,
    setContextWindow,
    fastMode,
    setFastMode,
    thinkingMode,
    setThinkingMode,
    chatMode,
    setChatMode,
    specialMode,
    terminalOpen,
    setTerminalOpen,
    diffOpen,
    setDiffOpen,
    consolePanelOpen,
    setConsolePanelOpen,
    consolePanelHeight,
    setConsolePanelHeight,
    chatPanelWidth,
    setChatPanelWidth,
    permissionLevel,
    setPermissionLevel,
    workspaceTab,
    setWorkspaceTab,
    appMode,
    setAppMode,
    sidebarWidth,
    setSidebarWidth,
    rightSidebarWidth,
    setRightSidebarWidth,
    rightSidebarOpen,
    setRightSidebarOpen,
    fileTreeOpen: _fileTreeOpen,
    setFileTreeOpen,
    editorSidebarView,
    setEditorSidebarView,
  } = useAppPreferences()

  // Apply per-window launch params (`#mode=editor&cwd=<path>`) exactly
  // once on first mount. Lives here rather than in App.tsx because the
  // history hydration must finish before choosing a conversation.
  const threadsReady = usePersistedThreads()
  useApplyLaunchParams({ threadsReady })
  useEditorWorkspace(appMode, threadsReady)

  const {
    setModelModalOpen,
    setSettingsOpen,
    setSettingsTab,
    setEditingFile,
    setChatSearch,
    setChatDateFilter,
    setPlanModalContent,
    setConfirmAction,
    setEditorModeModalOpen,
    setEditorModalPath,
    setNewThreadModalOpen,
    setNewThreadModalPath,
    setFileTreeSidebar,
    setGitModal,
    setMarketplaceOpen,
    setShortcutsOpen,
    setCommandPaletteOpen,
    setQuickOpenOpen,
    setGoToLineOpen,
    setDocumentSymbolsOpen,
    setWorkspaceSymbolsOpen,
    setAutonomousDialogOpen,
    setSystemBrowserOpen,
    setSystemBrowserIntent,
    setNewProjectOpen,
    setNewProjectStep,
    setNewProjectName,
    setNewProjectPath,
    setNewProjectPM,
    setNewProjectTemplate,
    setNewProjectUI,
    setNewProjectStatus,
    setNewProjectLog,
    openNewProjectWizard,
  } = appUiActions()

  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: unknown }>).detail
      const tab = typeof detail?.tab === "string" ? detail.tab : "general"
      setSettingsTab(tab)
      setSettingsOpen(true)
    }
    window.addEventListener("betterc0de:open-settings", onOpenSettings)
    return () =>
      window.removeEventListener("betterc0de:open-settings", onOpenSettings)
  }, [setSettingsOpen, setSettingsTab])

  useEffect(() => {
    const onOpenQuickOpen = () => {
      setAppMode("editor")
      setQuickOpenOpen(true)
    }
    window.addEventListener("betterc0de:open-quick-open", onOpenQuickOpen)
    return () =>
      window.removeEventListener("betterc0de:open-quick-open", onOpenQuickOpen)
  }, [setAppMode, setQuickOpenOpen])

  const {
    composerTabs,
    activeComposerTab,
    setActiveComposerTab,
    addComposerTab,
    closeComposerTab,
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
    switchActiveTabToThread,
  } = useComposerTabs()
  const {
    paneLayout,
    addPane,
    closePane,
    setActivePane,
    maximizePane,
    restorePane,
    addTab,
    setActiveTab,
    closeTab,
    moveTabToPane,
    openThreadOnPane,
  } = usePanes()

  // Auto-shrink the left sidebar when more than 4 chat tabs are open so
  // the tab strip has room to breathe. Shrinks 20 px per extra tab, capped
  // at 80 px total and clamped to the 220 px minimum. The user's stored
  // preference is untouched — the compression lifts automatically once the
  // tab count drops back to ≤ 4.
  const effectiveSidebarWidth =
    composerTabs.length > 4
      ? Math.max(
          220,
          sidebarWidth - Math.min(80, (composerTabs.length - 4) * 20)
        )
      : sidebarWidth
  const effectiveChatPanelWidth =
    appMode === "editor"
      ? clampEditorChatPanelWidth(chatPanelWidth)
      : chatPanelWidth

  // The capture feeds the console store; only the console panel and the
  // title bar's counts subscribe to the stream.
  useConsoleCapture(useConsoleLogStore.getState().setLogs)

  const { checkSlash, closeSlash, checkMention, closeMention } =
    composerMenuActions()
  const { isResizingRight, handleRightResizeStart } = useRightSidebarResize({
    rightSidebarWidth,
    setRightSidebarWidth,
  })
  // LM Studio polling stays on whenever the composer is mounted. The
  // earlier gate (`selectedProviderId === "lmstudio" || modelModalOpen`)
  // only fired for the full-screen model picker — the inline composer
  // dropdown never set those flags, so users opening the dropdown for the
  // first time saw an empty LM Studio submenu. Polling now hits a backend
  // route every 120s (cheap when LM Studio is offline — backend short-
  // circuits to `not_running`).
  const providers = useProvidersWithLmStudio(
    true,
    activeThread?.projectPath ?? null
  )

  const {
    favoriteEntries,
    toggle: toggleFavorite,
    isFavorite,
  } = useFavorites(providers)

  const {
    voiceModalOpen,
    setVoiceModalOpen,
    voiceSetupComplete,
    deepgram,
    startVoice,
    handleVoiceClick,
    handleVoiceContextMenu,
  } = useVoiceInput()

  // Only coarse, slow-changing facts about the active thread are read here.
  // The transcript, its activities and the streamed text change on every
  // provider event; the components that show them subscribe themselves
  // (ChatColumn, ChatTranscript, PlanModalStreamSync), so a tool event does
  // not re-render the whole shell.
  const activeThreadId = activeThread?.id ?? null
  const providerLock = useThreadProviderLock(activeThreadId)
  const isStreaming = useChatStore((state) =>
    Boolean(getThreadStream(state, activeThreadId).isStreaming)
  )
  const {
    chatUiStyle,
    uiSoundEnabled,
    uiSoundTypingEnabled,
    uiSoundClicksEnabled,
    uiSoundKeyUpEnabled,
    uiSoundKeyboardTheme,
    uiSoundMouseTheme,
    uiSoundVolume,
    minimalChat,
  } = useAppearanceState()
  const swarmSession = useMultiAgentStore((s) => s.session)
  const swarmActive =
    swarmSession != null && swarmSession.status !== "configuring"
  const selectedProviderSelection = useSelectedProvider({
    providers,
    selectedProviderId,
    setSelectedProviderId,
    selectedModel,
    setSelectedModel,
    thinkingMode,
    setThinkingMode,
    lockedProviderInstanceId:
      activeThread?.session?.providerInstanceId ?? providerLock.instanceId,
    lockedContinuationKey:
      activeThread?.session?.continuationKey ?? providerLock.continuationKey,
  })
  const selectedProvider = selectedProviderSelection.selectedProvider
  const resolvedSelectedModel = selectedProviderSelection.selectedModel
  const resolvedThinkingMode = selectedProviderSelection.thinkingMode

  const currentModelName =
    selectedProvider?.models.find((m) => m.id === resolvedSelectedModel)
      ?.name ??
    (selectedProvider?.modelsReady === true && resolvedSelectedModel
      ? `${displayModelName(resolvedSelectedModel)} (unavailable)`
      : resolvedSelectedModel
        ? displayModelName(resolvedSelectedModel)
        : "Select model")

  const isLmStudio = selectedProvider?.id === "lmstudio"
  const currentProvider = selectedProvider

  const respondToolApproval = useToolApproval(permissionLevel)

  const { wsReady } = useChatEventBus({
    setPlanModalContent,
    respondToolApproval,
    providers,
  })

  useCliAutoSync(
    activeThread?.worktreePath ?? activeThread?.projectPath ?? null
  )

  useGlobalShortcuts({
    setChatMode,
    onNewAgent: () => {
      setNewThreadModalPath("")
      setNewThreadModalOpen(true)
    },
    onNewProject: openNewProjectWizard,
    onOpenMarketplace: () => {
      setMarketplaceOpen(true)
    },
    onOpenAutomations: openAutomationsPage,
    onOpenSearch: () => {
      if (appMode !== "agent") {
        setSidebarOpen(true)
        setEditorSidebarView("search")
        return
      }
      setChatSearch(" ")
    },
    onOpenSystemBrowser: () => {
      setSystemBrowserIntent(
        appMode !== "agent" ? "editor-open-folder" : "agent-new-thread"
      )
      setSystemBrowserOpen(true)
    },
    onOpenSettings: () => {
      setSettingsTab("general")
      setSettingsOpen(true)
    },
    onOpenCommandPalette: () => setCommandPaletteOpen(true),
    onOpenQuickOpen: () => {
      setAppMode("editor")
      setQuickOpenOpen(true)
    },
    onOpenGoToLine: () => {
      setAppMode("editor")
      setGoToLineOpen(true)
    },
    onOpenDocumentSymbols: () => {
      setAppMode("editor")
      setDocumentSymbolsOpen(true)
    },
    onOpenWorkspaceSymbols: () => {
      setAppMode("editor")
      setWorkspaceSymbolsOpen(true)
    },
    onOpenExplorer: () => {
      setAppMode("editor")
      setSidebarOpen(true)
      setEditorSidebarView("files")
    },
    onOpenSourceControl: () => {
      setAppMode("editor")
      setSidebarOpen(true)
      setEditorSidebarView("source-control")
    },
    onToggleSidebar: () =>
      setSidebarOpen(!usePreferencesStore.getState().sidebarOpen),
    onToggleTerminal: () =>
      setTerminalOpen(!usePreferencesStore.getState().terminalOpen),
    onToggleDiff: toggleDiffView,
    onToggleShortcuts: () => setShortcutsOpen((prev) => !prev),
    onSwitchThread: switchActiveTabToThread,
  })

  useUiSounds({
    uiSoundEnabled,
    uiSoundTypingEnabled,
    uiSoundClicksEnabled,
    uiSoundKeyUpEnabled,
    uiSoundKeyboardTheme,
    uiSoundMouseTheme,
    uiSoundVolume,
  })

  // Stable, so `handleSubmit` keeps its identity across shell renders.
  const openModelPicker = useCallback(
    () => setModelModalOpen(true),
    [setModelModalOpen]
  )
  const openCommandPalette = useCallback(
    () => setCommandPaletteOpen(true),
    [setCommandPaletteOpen]
  )

  const handleSubmit = useChatSubmit({
    providers,
    favoriteEntries,
    toggleFavorite,
    isFavorite,
    appMode,
    openModelPicker,
    openCommandPalette,
    closeSlash,
    closeMention,
  })
  useMessageQueue(handleSubmit)

  const handleInlineEdit = useInlineEdit({
    selectedModel: resolvedSelectedModel,
    selectedProvider,
    thinkingMode: resolvedThinkingMode,
    specialMode,
    permissionLevel,
    contextWindow,
  })

  const handleStop = useChatStop(selectedProvider)

  const electronApi = getElectronApi()

  return {
    sidebarOpen,
    // The workspace panel is a persistent shell, not gated on whether a
    // thread/folder is attached. Its content shows the "No folder / Repo
    // open" empty state when no project is available, so the panel (and the
    // resize handle + toggle) stays reachable at all times in agent mode.
    // It binds to the active chat: focusing a different pane calls
    // setActiveThread (see use-panes.ts), which rebinds `activeThread` below,
    // so this single right panel follows whichever chat/workspace is active
    // and the titlebar "Workspace" toggle shows/hides it. Per-pane workspace
    // tabs remain as an inline alternative; this is the shared, switch-as-you-
    // switch-chats panel. Editor mode has its own EditorModeSplitView, so it
    // isn't shown there.
    showWorkspaceRightPanel: appMode === "agent",
    // Plain object literals — no useMemo wrappers. AppShell spreads each bag
    // into its slot (`<Titlebar {...titlebarProps} />`), and Titlebar,
    // LeftSidebar and WorkspaceRightPanel are React.memo'd, so they compare
    // the individual values and stable setters, not the bag identity. The
    // shell no longer subscribes to messages, activities or streamed text,
    // so it re-renders on coarse changes (thread switch, a new message on
    // the thread object, composer menus), not on every provider event.
    titlebarProps: {
      activeThreadProjectName: activeThread?.projectName,
      consolePanelOpen,
      chatUiStyle,
      appMode,
      setAppMode,
      setConsolePanelOpen,
      setNewProjectOpen,
      setSettingsOpen,
      setSidebarOpen,
      setTerminalOpen,
      setSystemBrowserOpen,
      setSystemBrowserIntent,
      electronApi,
      // Chat tab controls surfaced in the titlebar after the File menu.
      composerTabs,
      activeComposerTab,
      setActiveComposerTab,
      splitMode,
      enterSplitMode,
      exitSplitMode,
    },
    leftSidebarProps: {
      // One width for Agent, Editor and Canvas.
      sidebarWidth: effectiveSidebarWidth,
      setSidebarWidth,
      setSidebarOpen,
      minimalChat,
      chatUiStyle,
      appMode,
      setAppMode,
      activeThread,
      setChatDateFilter,
      gitHubUser,
      gitUserName,
      uiSoundEnabled,
      setNewThreadModalPath,
      setNewThreadModalOpen,
      setNewProjectName,
      setNewProjectPath,
      setNewProjectTemplate,
      setNewProjectUI,
      setNewProjectPM,
      setNewProjectStep,
      setNewProjectStatus,
      setNewProjectLog,
      setNewProjectOpen,
      setMarketplaceOpen,
      setSettingsTab,
      setSettingsOpen,
      setGitModal,
      setChatSearch,
      setConfirmAction,
      setEditorModalPath,
      setEditorModeModalOpen,
      setFileTreeOpen,
      setSystemBrowserIntent,
      editorSidebarView,
      setEditorSidebarView,
      providers,
      setSystemBrowserOpen,
    },
    // mainAreaProps aggregates composer, tab and console state
    // into a single bag for <MainArea>. MainArea is not memoized; it renders
    // when the shell does, which no longer happens per keystroke in the
    // composer menus, per console batch or when a dialog opens. Each
    // ChatColumn subscribes to its own thread.
    mainAreaProps: {
      wsReady,
      appMode,
      setAppMode,
      activeThread,
      activeThreadId,
      sidebarOpen,
      setSidebarOpen,
      minimalChat,
      chatPanelWidth: effectiveChatPanelWidth,
      setChatPanelWidth,
      handleInlineEdit,
      providers,
      selectedModel: resolvedSelectedModel,
      selectedProviderId,
      setSelectedModel,
      setSelectedProviderId,
      setContextWindow,
      terminalOpen,
      setTerminalOpen,
      diffOpen,
      setDiffOpen,
      setConfirmAction,
      setFileTreeSidebar,
      setGitModal,
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
      paneLayout,
      addPane,
      closePane,
      setActivePane,
      maximizePane,
      restorePane,
      addTab,
      setActiveTab,
      closeTab,
      moveTabToPane,
      openThreadOnPane,
      setEditingFile,
      swarmActive,
      isStreaming,
      handleSubmit,
      setPlanModalContent,
      chatMode,
      selectedProvider,
      thinkingMode: resolvedThinkingMode,
      setThinkingMode,
      specialMode,
      permissionLevel,
      deepgram,
      composerProps: {
        handleSubmit,
        handleStop,
        handleVoiceClick,
        handleVoiceContextMenu,
        minimalChat,
        thinkingMode: resolvedThinkingMode,
        setThinkingMode,
        chatMode,
        setChatMode,
        specialMode,
        permissionLevel,
        setPermissionLevel,
        contextWindow,
        setContextWindow,
        fastMode,
        setFastMode,
        currentModelName,
        selectedProvider,
        currentProvider,
        selectedProviderId,
        selectedModel: resolvedSelectedModel,
        setSelectedModel,
        setSelectedProviderId,
        providers,
        favoriteEntries,
        toggleFavorite,
        isFavorite,
        isLmStudio,
        isStreaming,
        voiceSetupComplete,
        deepgram,
        setTerminalOpen,
        setVoiceModalOpen,
        checkSlash,
        checkMention,
        setAutonomousDialogOpen,
      },
      consolePanelOpen,
      consolePanelHeight,
      setConsolePanelHeight,
      setConsolePanelOpen,
      setChatSearch,
      setSystemBrowserOpen,
      setSystemBrowserIntent,
      appModals: (
        <AppModals
          activeThread={activeThread}
          minimalChat={minimalChat}
          providers={providers}
          handleSubmit={handleSubmit}
          appMode={appMode}
          setAppMode={setAppMode}
          setSidebarOpen={setSidebarOpen}
          setFileTreeOpen={setFileTreeOpen}
          setEditorSidebarView={setEditorSidebarView}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
          voiceModalOpen={voiceModalOpen}
          setVoiceModalOpen={setVoiceModalOpen}
          startVoice={startVoice}
        />
      ),
    },
    workspaceRightPanelProps: {
      rightSidebarOpen,
      setRightSidebarOpen,
      rightSidebarWidth,
      onResizeStart: handleRightResizeStart,
      isResizingRight,
      workspaceTab,
      setWorkspaceTab,
      activeThread,
      setPlanModalContent,
      setEditingFile,
    },
  }
}

/**
 * Inferred prop-bag types derived straight from {@link useAppShellBundles}.
 * Downstream components (AppShell, MainArea, etc.) import these instead of
 * re-declaring the shape as `any`, so changes to the orchestrator propagate
 * through the type system without silent prop drift.
 */
export type AppShellBundles = ReturnType<typeof useAppShellBundles>
export type TitlebarProps = AppShellBundles["titlebarProps"]
export type LeftSidebarProps = AppShellBundles["leftSidebarProps"]
export type MainAreaProps = AppShellBundles["mainAreaProps"]
export type WorkspaceRightPanelProps =
  AppShellBundles["workspaceRightPanelProps"]
