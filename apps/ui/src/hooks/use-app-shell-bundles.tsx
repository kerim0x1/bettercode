import {
  latestProviderInstanceId,
  latestProviderContinuationKey,
} from "@/lib/provider-model-selection"
import { useCallback, useEffect } from "react"
import { AppModals } from "@/components/layout/app-modals"
import {
  useSlashCommands,
  type SlashCommand,
} from "@/components/slash-commands"
import { useFileMentions } from "@/components/file-mentions"
import {
  getThreadStream,
  useActiveMessages,
  useActiveThread,
  useChatStore,
  useThreadActivities,
} from "@/lib/chat-store"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { toggleDiffView } from "@/lib/diff-view"
import { useRuntimeHookBridge } from "@/lib/runtime-hooks"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import { useAppUiState } from "@/hooks/use-app-ui-state"
import { useAppearanceState } from "@/hooks/use-appearance-state"
import { useAutonomousLoop } from "@/hooks/use-autonomous-loop"
import { useAutonomousState } from "@/hooks/use-autonomous-state"
import { useChatEventBus } from "@/hooks/use-chat-event-bus"
import { useChatStop } from "@/hooks/use-chat-stop"
import { findComposerTextarea, setComposerInput } from "@/lib/composer-input"
import { useChatSubmit } from "@/hooks/use-chat-submit"
import { useMessageQueue } from "@/hooks/use-message-queue"
import { useComposerTabs } from "@/hooks/use-composer-tabs"
import { usePanes } from "@/hooks/use-panes"
import { useConsoleLogState } from "@/hooks/use-console-log-state"
import { useFavorites } from "@/hooks/use-favorites"
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts"
import { useInlineEdit } from "@/hooks/use-inline-edit"
import { useApprovalAttention } from "@/hooks/use-approval-attention"
import { useAttentionNotifications } from "@/hooks/use-attention-notifications"
import { useNativeNotifications } from "@/hooks/use-native-notifications"
import { useNewProjectWizardState } from "@/hooks/use-new-project-wizard-state"
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
import {
  clampEditorChatPanelWidth,
  clampEditorSidebarWidth,
} from "@/lib/editor-layout"

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
    modelModalOpen,
    setModelModalOpen,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    editingFile,
    setEditingFile,
    chatSearch,
    setChatSearch,
    chatDateFilter,
    setChatDateFilter,
    planModalContent,
    planModalSourceProposedPlan,
    planModalThreadId,
    planModalImplemented,
    setPlanModalContent,
    confirmAction,
    setConfirmAction,
    editorModeModalOpen,
    setEditorModeModalOpen,
    editorModalPath,
    setEditorModalPath,
    newThreadModalOpen,
    setNewThreadModalOpen,
    newThreadModalPath,
    setNewThreadModalPath,
    fileExplorerModal,
    setFileExplorerModal,
    setFileTreeSidebar,
    gitModal,
    setGitModal,
    marketplaceOpen,
    setMarketplaceOpen,
    shortcutsOpen,
    setShortcutsOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    quickOpenOpen,
    setQuickOpenOpen,
    goToLineOpen,
    setGoToLineOpen,
    documentSymbolsOpen,
    setDocumentSymbolsOpen,
    workspaceSymbolsOpen,
    setWorkspaceSymbolsOpen,
    autonomousDialogOpen,
    setAutonomousDialogOpen,
    systemBrowserOpen,
    setSystemBrowserOpen,
    systemBrowserIntent,
    setSystemBrowserIntent,
  } = useAppUiState()

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
  const effectiveEditorSidebarWidth = clampEditorSidebarWidth(sidebarWidth)
  const effectiveChatPanelWidth =
    appMode === "editor"
      ? clampEditorChatPanelWidth(chatPanelWidth)
      : chatPanelWidth

  const { consoleLogs, setConsoleLogs, consoleTab, setConsoleTab } =
    useConsoleLogState()

  const {
    slashActive,
    slashQuery,
    slashTrigger,
    slashRange,
    checkInput: checkSlash,
    close: closeSlash,
  } = useSlashCommands()
  const {
    active: mentionActive,
    query: mentionQuery,
    checkInput: checkMention,
    close: closeMention,
  } = useFileMentions()
  const { isResizingRight, handleRightResizeStart } = useRightSidebarResize({
    rightSidebarWidth,
    setRightSidebarWidth,
  })
  const {
    newProjectOpen,
    setNewProjectOpen,
    newProjectStep,
    setNewProjectStep,
    newProjectName,
    setNewProjectName,
    newProjectPath,
    setNewProjectPath,
    newProjectPM,
    setNewProjectPM,
    newProjectTemplate,
    setNewProjectTemplate,
    newProjectUI,
    setNewProjectUI,
    newProjectStatus,
    setNewProjectStatus,
    newProjectLog,
    setNewProjectLog,
  } = useNewProjectWizardState()
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

  const messages = useActiveMessages()
  const threadActivities = useThreadActivities(activeThread?.id)
  const activeThreadId = activeThread?.id ?? null
  const isStreaming = useChatStore((state) =>
    Boolean(getThreadStream(state, activeThreadId).isStreaming)
  )
  const isPlanStreaming = useChatStore((state) =>
    Boolean(getThreadStream(state, activeThreadId).isPlanStreaming)
  )
  const streamingPlanText = useChatStore(
    (state) => getThreadStream(state, activeThreadId).streamingPlanText
  )

  useEffect(() => {
    if (planModalContent === null || !isPlanStreaming || !streamingPlanText) {
      return
    }
    if (
      streamingPlanText !== planModalContent &&
      (planModalContent === "" ||
        streamingPlanText.startsWith(planModalContent))
    ) {
      setPlanModalContent(streamingPlanText)
    }
  }, [
    isPlanStreaming,
    planModalContent,
    setPlanModalContent,
    streamingPlanText,
  ])
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
      activeThread?.session?.providerInstanceId ??
      latestProviderInstanceId(threadActivities),
    lockedContinuationKey:
      activeThread?.session?.continuationKey ??
      latestProviderContinuationKey(threadActivities),
  })
  const selectedProvider = selectedProviderSelection.selectedProvider
  const resolvedSelectedModel = selectedProviderSelection.selectedModel
  const resolvedThinkingMode = selectedProviderSelection.thinkingMode

  const {
    autonomousMode,
    autonomousTask,
    autonomousStatus,
    autonomousIterations,
    autonomousMaxIterations,
    autonomousTaskList,
    autonomousTimeBudgetMin,
    autonomousStartedAt,
    autonomousStopReason,
  } = useAutonomousState()

  useAutonomousLoop({ providers })

  const currentModelName =
    selectedProvider?.models.find((m) => m.id === resolvedSelectedModel)
      ?.name ??
    (selectedProvider?.modelsReady === true && resolvedSelectedModel
      ? `${resolvedSelectedModel} (unavailable)`
      : resolvedSelectedModel || "Select model")

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
    onNewProject: () => {
      setNewProjectName("")
      setNewProjectPath("")
      setNewProjectTemplate(null)
      setNewProjectUI(null)
      setNewProjectPM("npm")
      setNewProjectStep(0)
      setNewProjectStatus("idle")
      setNewProjectLog("")
      setNewProjectOpen(true)
    },
    onOpenMarketplace: () => {
      setMarketplaceOpen(true)
    },
    // TODO: implement automations panel
    onOpenAutomations: () => {
      console.info("Automations: not implemented yet")
    },
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

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand, _replacement: string) => {
      const input = findComposerTextarea()
      const setComposerText = (text: string) => {
        setComposerInput(input, text, true)
      }

      if (cmd.id === "model") {
        setModelModalOpen(true)
      } else if (cmd.id === "plan") {
        setChatMode("plan")
      } else if (cmd.id === "ask") {
        setChatMode("ask")
      } else if (cmd.id === "default") {
        setChatMode("agent")
      } else if (cmd.id === "prompt-clear") {
        setComposerText("")
      } else if (cmd.id === "prompt-paste") {
        const readText = navigator.clipboard?.readText?.bind(
          navigator.clipboard
        )
        if (readText) {
          void readText()
            .then((text) => {
              if (text) setComposerText(text)
            })
            .catch(() => {})
        }
      }
      // Provider-native commands and non-mode built-ins are written into the
      // composer; the user presses Enter to execute or send them.
      closeSlash()
    },
    [closeSlash, setChatMode, setModelModalOpen]
  )

  const handleSubmit = useChatSubmit({
    providers,
    favoriteEntries,
    toggleFavorite,
    isFavorite,
    appMode,
    openModelPicker: () => setModelModalOpen(true),
    openCommandPalette: () => setCommandPaletteOpen(true),
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

  const electronApi = window.electronAPI

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
    // Plain object literals — no useMemo wrappers. An earlier version
    // wrapped each bundle in useMemo with the full dep list (80+ entries
    // for mainAreaProps), which was a net loss: the cache busted on
    // nearly every render (streaming deltas, slash/mention queries,
    // messages, focus changes) and each miss cost a 20–80 way Object.is
    // comparison. Returning a fresh object literal is cheaper than the
    // hash AND has identical downstream behavior, since AppShell and
    // its children are not React.memo'd against these bags.
    titlebarProps: {
      activeThreadProjectName: activeThread?.projectName,
      consoleLogs,
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
      sidebarWidth:
        appMode !== "agent"
          ? effectiveEditorSidebarWidth
          : effectiveSidebarWidth,
      setSidebarWidth,
      setSidebarOpen,
      minimalChat,
      chatUiStyle,
      appMode,
      setAppMode,
      activeThread,
      messages,
      chatSearch,
      chatDateFilter,
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
      marketplaceOpen,
      setMarketplaceOpen,
      settingsOpen,
      settingsTab,
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
    // mainAreaProps aggregates chat streaming, composer, tab, autonomous,
    // console, and modal state into a single bag for <MainArea>. Previously
    // wrapped in a useMemo with an 80-entry dep array — the cache busted on
    // nearly every render (streaming deltas, slash/mention queries, messages,
    // focus changes) so memoization was effectively a no-op paid for with an
    // 80-way Object.is loop. Plain object literal is cheaper and has the
    // same downstream behavior since MainArea isn't React.memo'd.
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
      messages,
      isStreaming,
      handleSubmit,
      setPlanModalContent,
      chatMode,
      selectedProvider,
      thinkingMode: resolvedThinkingMode,
      setThinkingMode,
      specialMode,
      permissionLevel,
      mentionQuery,
      mentionActive,
      slashActive,
      slashQuery,
      slashTrigger,
      slashRange,
      closeMention,
      closeSlash,
      handleSlashSelect,
      autonomousMode,
      autonomousStatus,
      autonomousIterations,
      autonomousMaxIterations,
      autonomousTask,
      autonomousTaskList,
      autonomousTimeBudgetMin,
      autonomousStartedAt,
      autonomousStopReason,
      deepgram,
      composerProps: {
        handleSubmit,
        handleStop,
        handleVoiceClick,
        handleVoiceContextMenu,
        minimalChat,
        thinkingMode: resolvedThinkingMode,
        setThinkingMode,
        autonomousMode,
        autonomousStatus,
        autonomousTask,
        autonomousIterations,
        autonomousMaxIterations,
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
        modelPickerOpen: modelModalOpen,
        setModelPickerOpen: setModelModalOpen,
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
      consoleTab,
      setConsoleTab,
      consoleLogs,
      setConsoleLogs,
      setChatSearch,
      setSystemBrowserOpen,
      setSystemBrowserIntent,
      appModals: (
        <AppModals
          planModalContent={planModalContent}
          planModalSourceProposedPlan={planModalSourceProposedPlan}
          planModalThreadId={planModalThreadId}
          planModalImplemented={planModalImplemented}
          setPlanModalContent={setPlanModalContent}
          selectedModel={resolvedSelectedModel}
          selectedProvider={selectedProvider}
          thinkingMode={resolvedThinkingMode}
          permissionLevel={permissionLevel}
          contextWindow={contextWindow}
          fastMode={fastMode}
          setChatMode={setChatMode}
          chatSearch={chatSearch}
          setChatSearch={setChatSearch}
          minimalChat={minimalChat}
          editingFile={editingFile}
          setEditingFile={setEditingFile}
          activeThread={activeThread}
          fileExplorerModal={fileExplorerModal}
          setFileExplorerModal={setFileExplorerModal}
          gitModal={gitModal}
          setGitModal={setGitModal}
          marketplaceOpen={marketplaceOpen}
          setMarketplaceOpen={setMarketplaceOpen}
          voiceModalOpen={voiceModalOpen}
          setVoiceModalOpen={setVoiceModalOpen}
          startVoice={startVoice}
          providers={providers}
          editorModeModalOpen={editorModeModalOpen}
          setEditorModeModalOpen={setEditorModeModalOpen}
          editorModalPath={editorModalPath}
          setEditorModalPath={setEditorModalPath}
          appMode={appMode}
          setAppMode={setAppMode}
          setSidebarOpen={setSidebarOpen}
          setFileTreeOpen={setFileTreeOpen}
          editorSidebarView={editorSidebarView}
          setEditorSidebarView={setEditorSidebarView}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
          diffOpen={diffOpen}
          setDiffOpen={setDiffOpen}
          newThreadModalOpen={newThreadModalOpen}
          setNewThreadModalOpen={setNewThreadModalOpen}
          newThreadModalPath={newThreadModalPath}
          setNewThreadModalPath={setNewThreadModalPath}
          newProjectOpen={newProjectOpen}
          setNewProjectOpen={setNewProjectOpen}
          newProjectStep={newProjectStep}
          setNewProjectStep={setNewProjectStep}
          newProjectStatus={newProjectStatus}
          setNewProjectStatus={setNewProjectStatus}
          newProjectLog={newProjectLog}
          setNewProjectLog={setNewProjectLog}
          newProjectName={newProjectName}
          setNewProjectName={setNewProjectName}
          newProjectPath={newProjectPath}
          setNewProjectPath={setNewProjectPath}
          newProjectPM={newProjectPM}
          setNewProjectPM={setNewProjectPM}
          newProjectTemplate={newProjectTemplate}
          setNewProjectTemplate={setNewProjectTemplate}
          newProjectUI={newProjectUI}
          setNewProjectUI={setNewProjectUI}
          confirmAction={confirmAction}
          setConfirmAction={setConfirmAction}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          shortcutsOpen={shortcutsOpen}
          setShortcutsOpen={setShortcutsOpen}
          commandPaletteOpen={commandPaletteOpen}
          setCommandPaletteOpen={setCommandPaletteOpen}
          quickOpenOpen={quickOpenOpen}
          setQuickOpenOpen={setQuickOpenOpen}
          goToLineOpen={goToLineOpen}
          setGoToLineOpen={setGoToLineOpen}
          documentSymbolsOpen={documentSymbolsOpen}
          setDocumentSymbolsOpen={setDocumentSymbolsOpen}
          workspaceSymbolsOpen={workspaceSymbolsOpen}
          setWorkspaceSymbolsOpen={setWorkspaceSymbolsOpen}
          autonomousDialogOpen={autonomousDialogOpen}
          setAutonomousDialogOpen={setAutonomousDialogOpen}
          systemBrowserOpen={systemBrowserOpen}
          setSystemBrowserOpen={setSystemBrowserOpen}
          systemBrowserIntent={systemBrowserIntent}
          setSystemBrowserIntent={setSystemBrowserIntent}
          handleSubmit={handleSubmit}
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
