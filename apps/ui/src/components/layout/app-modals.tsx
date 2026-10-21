import { lazy, Suspense, useCallback, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent as _DialogContent, // unused, but keeps the dialog primitive imported in case consumers want it
} from "@/components/ui/dialog"
import { ErrorBoundary } from "@/components/error-boundary"
import { useChatStore } from "@/lib/chat-store"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import { executeComposerPlan } from "@/lib/execute-composer-plan"
import { handleError } from "@/lib/errors/handle"
import {
  hasNativeFolderPicker,
  pickFolder,
  openWorkspace,
} from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import type { UiProvider } from "@/lib/provider-types"
import type {
  SetPlanModalContent,
  SourceProposedPlanReference,
} from "@/lib/plan-modal"

// ─── Lazy modal imports ─────────────────────────────────────────────────────
// Every modal is mounted on-demand. Combined with the `{state && <Modal …>}`
// guards below this means the modules are NOT downloaded until the user
// actually opens the feature — keeps the initial bundle small and startup
// RAM low on fresh launch. Each modal's state (`editingFile`, `marketplaceOpen`,
// …) already gates visibility, so the lazy mount is a pure perf win.
const BackgroundComposerPanel = lazy(() =>
  import("@/components/background-composer-panel").then((m) => ({
    default: m.BackgroundComposerPanel,
  }))
)
const DeepgramVoiceModal = lazy(() =>
  import("@/components/deepgram-voice-modal").then((m) => ({
    default: m.DeepgramVoiceModal,
  }))
)
const FileEditorModal = lazy(() =>
  import("@/components/file-editor-modal").then((m) => ({
    default: m.FileEditorModal,
  }))
)
const MarketplaceModal = lazy(() =>
  import("@/components/marketplace-modal").then((m) => ({
    default: m.MarketplaceModal,
  }))
)
const MultiAgentConfigPanel = lazy(() =>
  import("@/components/multi-agent-config-panel").then((m) => ({
    default: m.MultiAgentConfigPanel,
  }))
)
const MultiAgentSessionPanel = lazy(() =>
  import("@/components/multi-agent-session-panel").then((m) => ({
    default: m.MultiAgentSessionPanel,
  }))
)
const ApprovalRequestModal = lazy(() =>
  import("@/components/chat/approval-request-modal").then((m) => ({
    default: m.ApprovalRequestModal,
  }))
)
const PlanModal = lazy(() =>
  import("@/components/plan-view").then((m) => ({ default: m.PlanModal }))
)
const SettingsModal = lazy(() =>
  import("@/components/settings/settings-modal").then((m) => ({
    default: m.SettingsModal,
  }))
)
const SearchChatsDialog = lazy(() =>
  import("@/components/dialogs/search-chats-dialog").then((m) => ({
    default: m.SearchChatsDialog,
  }))
)
const EditorModeDialog = lazy(() =>
  import("@/components/dialogs/editor-mode-dialog").then((m) => ({
    default: m.EditorModeDialog,
  }))
)
const NewThreadDialog = lazy(() =>
  import("@/components/dialogs/new-thread-dialog").then((m) => ({
    default: m.NewThreadDialog,
  }))
)
const NewProjectDialog = lazy(() =>
  import("@/components/dialogs/new-project-dialog").then((m) => ({
    default: m.NewProjectDialog,
  }))
)
const FileExplorerDialog = lazy(() =>
  import("@/components/dialogs/file-explorer-dialog").then((m) => ({
    default: m.FileExplorerDialog,
  }))
)
const SourceControlDialog = lazy(() =>
  import("@/components/dialogs/source-control-dialog").then((m) => ({
    default: m.SourceControlDialog,
  }))
)
const ConfirmActionDialog = lazy(() =>
  import("@/components/dialogs/confirm-action-dialog").then((m) => ({
    default: m.ConfirmActionDialog,
  }))
)
const AutonomousWorkDialog = lazy(() =>
  import("@/components/dialogs/autonomous-work-dialog").then((m) => ({
    default: m.AutonomousWorkDialog,
  }))
)
const KeyboardShortcutsDialog = lazy(() =>
  import("@/components/settings/keyboard-shortcuts-dialog").then((m) => ({
    default: m.KeyboardShortcutsDialog,
  }))
)
const EditorCommandPaletteDialog = lazy(() =>
  import("@/components/dialogs/editor-command-palette-dialog").then((m) => ({
    default: m.EditorCommandPaletteDialog,
  }))
)
const EditorQuickOpenDialog = lazy(() =>
  import("@/components/dialogs/editor-quick-open-dialog").then((m) => ({
    default: m.EditorQuickOpenDialog,
  }))
)
const EditorGoToLineDialog = lazy(() =>
  import("@/components/dialogs/editor-go-to-line-dialog").then((m) => ({
    default: m.EditorGoToLineDialog,
  }))
)
const EditorDocumentSymbolsDialog = lazy(() =>
  import("@/components/dialogs/editor-document-symbols-dialog").then((m) => ({
    default: m.EditorDocumentSymbolsDialog,
  }))
)
const EditorWorkspaceSymbolsDialog = lazy(() =>
  import("@/components/dialogs/editor-workspace-symbols-dialog").then((m) => ({
    default: m.EditorWorkspaceSymbolsDialog,
  }))
)
const SystemBrowserDialog = lazy(() =>
  import("@/components/dialogs/system-browser-dialog").then((m) => ({
    default: m.SystemBrowserDialog,
  }))
)

/**
 * Consolidates every "app-level modal" into one component so App.tsx's
 * JSX return tree doesn't carry ~200 lines of dialog wiring. Each modal
 * already owns its own presentation — this wrapper is pure plumbing.
 *
 * **Performance note:** every modal below is `React.lazy`d and the mount is
 * guarded by the corresponding state flag so opening a feature is the only
 * trigger that downloads its code. Closed modals contribute zero bytes to
 * the initial bundle.
 *
 * The one non-trivial bit of logic here is PlanModal's `onExecute`
 * callback, which:
 *  - Flips `chatMode` back to "agent" (from "plan").
 *  - Adds a short "Implement the plan now." user message.
 *  - Sends through `handleSubmit` with an explicit thread and agent-mode override.
 *
 * The swarm's `MultiAgentSessionPanel` is wrapped in an ErrorBoundary
 * because its live render depends on the multi-agent store state which
 * can get into odd shapes during session transitions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function AppModals(props: any) {
  const {
    // Plan modal
    planModalContent,
    planModalSourceProposedPlan,
    planModalThreadId,
    planModalImplemented,
    setPlanModalContent,
    // Chat search
    chatSearch,
    setChatSearch,
    minimalChat,
    // File editor / explorer / git
    editingFile,
    setEditingFile,
    activeThread,
    fileExplorerModal,
    setFileExplorerModal,
    gitModal,
    setGitModal,
    // Marketplace / voice
    marketplaceOpen,
    setMarketplaceOpen,
    voiceModalOpen,
    setVoiceModalOpen,
    startVoice,
    // Multi-agent
    providers,
    // Editor mode modal
    editorModeModalOpen,
    setEditorModeModalOpen,
    editorModalPath,
    setEditorModalPath,
    appMode,
    setAppMode,
    setSidebarOpen,
    setFileTreeOpen,
    setEditorSidebarView,
    terminalOpen,
    setTerminalOpen,
    // New thread modal
    newThreadModalOpen,
    setNewThreadModalOpen,
    newThreadModalPath,
    setNewThreadModalPath,
    // New project wizard
    newProjectOpen,
    setNewProjectOpen,
    newProjectStep,
    setNewProjectStep,
    newProjectStatus,
    setNewProjectStatus,
    newProjectLog,
    setNewProjectLog,
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
    // Confirm action
    confirmAction,
    setConfirmAction,
    // Settings
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    // Keyboard shortcuts
    shortcutsOpen,
    setShortcutsOpen,
    // Command palette
    commandPaletteOpen,
    setCommandPaletteOpen,
    // Quick open
    quickOpenOpen,
    setQuickOpenOpen,
    // Go to line
    goToLineOpen,
    setGoToLineOpen,
    // Document symbols
    documentSymbolsOpen,
    setDocumentSymbolsOpen,
    // Workspace symbols
    workspaceSymbolsOpen,
    setWorkspaceSymbolsOpen,
    // Autonomous Work
    autonomousDialogOpen,
    setAutonomousDialogOpen,
    // System Browser
    systemBrowserOpen,
    setSystemBrowserOpen,
    systemBrowserIntent,
    setSystemBrowserIntent,
    handleSubmit,
  } = props as {
    planModalContent: string | null
    planModalSourceProposedPlan: SourceProposedPlanReference | null
    planModalThreadId: string | null
    planModalImplemented: boolean
    setPlanModalContent: SetPlanModalContent
    selectedModel: string
    selectedProvider: UiProvider | undefined
    thinkingMode: string | null
    permissionLevel: string
    contextWindow?: string | null
    fastMode?: boolean
    setChatMode: (m: string) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
  }

  // ── Multi-agent state checks for conditional mount ──
  const multiAgentConfigOpen = useMultiAgentStore((s) => s.isConfigOpen)
  const multiAgentSessionActive = useMultiAgentStore(
    (s) =>
      s.session !== null &&
      s.session.status !== "completed" &&
      s.session.status !== "cancelled"
  )

  // ── Folder picking ──────────────────────────────────────────────────────
  // "Open Folder" everywhere in the app flips `systemBrowserOpen`. Inside the
  // Electron shell we intercept that here and show the OS-native directory
  // dialog instead of the in-app System Browser; the browser stays as the
  // fallback for dev/web builds where `pickFolder` can't resolve a path.
  const applyPickedFolder = useCallback(
    (path: string, intent: string) => {
      if (intent === "editor-open-folder") {
        const name = basename(path) || "Project"
        const mode = appMode === "design" ? "design" : "editor"
        useChatStore
          .getState()
          .createThread(mode === "design" ? "Canvas" : "Editor", name, path)
        setAppMode(mode)
        setSidebarOpen(true)
        setFileTreeOpen(true)
        setEditorSidebarView("files")
        return
      }
      setNewThreadModalPath(path)
      setNewThreadModalOpen(true)
    },
    [
      appMode,
      setAppMode,
      setSidebarOpen,
      setFileTreeOpen,
      setEditorSidebarView,
      setNewThreadModalPath,
      setNewThreadModalOpen,
    ]
  )

  // Guards against a second dialog while one is already up: the OS dialog is
  // modal but async, and re-renders would otherwise re-trigger the effect.
  const nativePickerBusy = useRef(false)
  useEffect(() => {
    if (!systemBrowserOpen || !hasNativeFolderPicker()) return
    if (nativePickerBusy.current) return
    nativePickerBusy.current = true
    const intent = systemBrowserIntent
    void pickFolder()
      .then((path) => {
        if (path) applyPickedFolder(path, intent)
      })
      .finally(() => {
        nativePickerBusy.current = false
        setSystemBrowserOpen(false)
        setSystemBrowserIntent("agent-new-thread")
      })
  }, [
    systemBrowserOpen,
    systemBrowserIntent,
    applyPickedFolder,
    setSystemBrowserOpen,
    setSystemBrowserIntent,
  ])

  const openNewProjectWizard = () => {
    setNewProjectName("")
    setNewProjectPath("")
    setNewProjectTemplate(null)
    setNewProjectUI(null)
    setNewProjectPM("npm")
    setNewProjectStep(0)
    setNewProjectStatus("idle")
    setNewProjectLog("")
    setNewProjectOpen(true)
  }

  const executePlan = (planContent: string, inNewThread = false) => {
    if (planModalImplemented) return
    setPlanModalContent(null)
    void executeComposerPlan({
      threadId: planModalThreadId,
      content: planContent,
      sourceProposedPlan: planModalSourceProposedPlan,
      inNewThread,
      submit: handleSubmit,
    }).catch((error) => handleError(error, { source: "plan-implementation" }))
  }

  return (
    <Suspense fallback={null}>
      <ErrorBoundary label="Approval request modal">
        <ApprovalRequestModal />
      </ErrorBoundary>
      {chatSearch !== null && chatSearch !== undefined && (
        <SearchChatsDialog
          chatSearch={chatSearch}
          setChatSearch={setChatSearch}
          minimalChat={minimalChat}
        />
      )}

      {planModalContent !== null && (
        <PlanModal
          open={true}
          onClose={() => setPlanModalContent(null)}
          content={planModalContent || ""}
          executeDisabled={planModalImplemented}
          executeLabel={planModalImplemented ? "Implemented" : "Execute Plan"}
          onExecute={(planContent) => executePlan(planContent, false)}
          onExecuteInNewThread={(planContent) => executePlan(planContent, true)}
        />
      )}

      {editingFile !== null && (
        <FileEditorModal
          open={true}
          onClose={() => setEditingFile(null)}
          filePath={editingFile}
          cwd={activeThread?.projectPath || undefined}
        />
      )}

      {marketplaceOpen && (
        <MarketplaceModal
          open={true}
          onClose={() => setMarketplaceOpen(false)}
        />
      )}

      {voiceModalOpen && (
        <DeepgramVoiceModal
          open={true}
          onOpenChange={setVoiceModalOpen}
          onSaved={startVoice}
        />
      )}

      <BackgroundComposerPanel />

      {multiAgentConfigOpen && (
        <MultiAgentConfigPanel
          open={true}
          onOpenChange={(open) => {
            if (!open) useMultiAgentStore.getState().closeConfig()
          }}
          providers={providers}
        />
      )}

      {multiAgentSessionActive && (
        <ErrorBoundary label="Multi-agent session">
          <MultiAgentSessionPanel
            onPause={() => useMultiAgentStore.getState().pauseSession()}
            onResume={() => {
              const resolve = async (pid: string, mid: string) => {
                const p = providers.find((pr: UiProvider) => pr.id === pid)
                return resolveProviderTarget(p, mid)
              }
              useMultiAgentStore
                .getState()
                .resumeSession(resolve, (m) => buildSystemInstruction(m))
            }}
            onCancel={() => useMultiAgentStore.getState().cancelSession()}
          />
        </ErrorBoundary>
      )}

      {editorModeModalOpen && (
        <EditorModeDialog
          open={true}
          onOpenChange={setEditorModeModalOpen}
          editorModalPath={editorModalPath}
          setEditorModalPath={setEditorModalPath}
          minimalChat={minimalChat}
          setAppMode={setAppMode}
          setFileTreeOpen={setFileTreeOpen}
        />
      )}

      {newThreadModalOpen && (
        <NewThreadDialog
          open={true}
          onOpenChange={setNewThreadModalOpen}
          newThreadModalPath={newThreadModalPath}
          setNewThreadModalPath={setNewThreadModalPath}
          minimalChat={minimalChat}
        />
      )}

      {newProjectOpen && (
        <NewProjectDialog
          open={true}
          onOpenChange={setNewProjectOpen}
          minimalChat={minimalChat}
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
        />
      )}

      {fileExplorerModal && (
        <FileExplorerDialog
          open={true}
          onOpenChange={setFileExplorerModal}
          projectPath={activeThread?.projectPath}
          minimalChat={minimalChat}
          onFileSelect={(path: string) => {
            setEditingFile(path)
            setFileExplorerModal(false)
          }}
        />
      )}

      {gitModal && (
        <SourceControlDialog
          open={true}
          onOpenChange={setGitModal}
          projectPath={activeThread?.projectPath}
          minimalChat={minimalChat}
        />
      )}

      {confirmAction && (
        <ConfirmActionDialog
          action={confirmAction}
          onClear={() => setConfirmAction(null)}
          minimalChat={minimalChat}
        />
      )}

      {settingsOpen && (
        <Dialog
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open) setSettingsTab("general")
          }}
        >
          <SettingsModal defaultTab={settingsTab} />
        </Dialog>
      )}

      {shortcutsOpen && (
        <KeyboardShortcutsDialog
          open={true}
          onOpenChange={setShortcutsOpen}
          isSimple={!!minimalChat}
        />
      )}

      {commandPaletteOpen && (
        <EditorCommandPaletteDialog
          open={true}
          onOpenChange={setCommandPaletteOpen}
          projectPath={activeThread?.projectPath}
          appMode={appMode}
          setAppMode={setAppMode}
          setSidebarOpen={setSidebarOpen}
          setEditorSidebarView={setEditorSidebarView}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
          setQuickOpenOpen={setQuickOpenOpen}
          setGoToLineOpen={setGoToLineOpen}
          setDocumentSymbolsOpen={setDocumentSymbolsOpen}
          setWorkspaceSymbolsOpen={setWorkspaceSymbolsOpen}
          setMarketplaceOpen={setMarketplaceOpen}
          setSettingsOpen={setSettingsOpen}
          setSettingsTab={setSettingsTab}
          setShortcutsOpen={setShortcutsOpen}
          setSystemBrowserOpen={setSystemBrowserOpen}
          setSystemBrowserIntent={setSystemBrowserIntent}
          setNewThreadModalOpen={setNewThreadModalOpen}
          setNewThreadModalPath={setNewThreadModalPath}
          onNewProject={openNewProjectWizard}
        />
      )}

      {quickOpenOpen && (
        <EditorQuickOpenDialog
          open={true}
          onOpenChange={setQuickOpenOpen}
          projectPath={activeThread?.projectPath}
          onOpenFolder={() => {
            setSystemBrowserIntent("editor-open-folder")
            setSystemBrowserOpen(true)
          }}
        />
      )}

      {goToLineOpen && (
        <EditorGoToLineDialog open={true} onOpenChange={setGoToLineOpen} />
      )}

      {documentSymbolsOpen && (
        <EditorDocumentSymbolsDialog
          open={true}
          onOpenChange={setDocumentSymbolsOpen}
        />
      )}

      {workspaceSymbolsOpen && (
        <EditorWorkspaceSymbolsDialog
          open={true}
          onOpenChange={setWorkspaceSymbolsOpen}
          projectPath={activeThread?.projectPath}
          onOpenFolder={() => {
            setSystemBrowserIntent("editor-open-folder")
            setSystemBrowserOpen(true)
          }}
        />
      )}

      {autonomousDialogOpen && (
        <AutonomousWorkDialog
          open={true}
          onOpenChange={setAutonomousDialogOpen}
          handleSubmit={handleSubmit}
        />
      )}

      {/* Fallback only — inside the shell the effect above opens the native
          OS dialog and never mounts this. */}
      {systemBrowserOpen && !hasNativeFolderPicker() && (
        <SystemBrowserDialog
          open={true}
          onOpenChange={(open: boolean) => {
            setSystemBrowserOpen(open)
            if (!open) setSystemBrowserIntent("agent-new-thread")
          }}
          onPathPicked={(path: string) => {
            void openWorkspace(path)
              .then((registeredPath) => {
                applyPickedFolder(registeredPath, systemBrowserIntent)
                setSystemBrowserOpen(false)
                setSystemBrowserIntent("agent-new-thread")
              })
              .catch((error) =>
                handleError(error, { source: "open-workspace" })
              )
          }}
        />
      )}
    </Suspense>
  )
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""
}
