import { useEffect, useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import { ChatTopBar } from "@/components/layout/chat-top-bar"
import { ChatTranscript } from "@/components/chat/chat-transcript"
import { ChatInputArea } from "@/components/chat/chat-input-area"
import { useChatStop } from "@/hooks/use-chat-stop"
import { normalizePlanModalInput } from "@/lib/plan-modal"
import { ProviderStatusBanner } from "@/components/chat/provider-status-banner"
import { AgentTerminalDiff } from "@/components/layout/agent-terminal-diff"
import {
  useChatStore,
  useThreadActivities,
  useThreadById,
  useThreadMessages,
} from "@/lib/chat-store"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import {
  latestProviderInstanceId,
  latestProviderContinuationKey,
  resolveProviderModelThinkingSelection,
} from "@/lib/provider-model-selection"
import { normalizeChatMode } from "@/lib/chat-mode-labels"
import { useChatStreamingState } from "@/hooks/use-chat-streaming-state"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"

/**
 * One full chat column — top bar + transcript + composer + optional
 * terminal/diff strip. Parameterized by `threadId` so stacked editor chats
 * and agent panes can each stay bound to a different thread.
 *
 * Each column subscribes to its own thread's messages and streaming state
 * via `useThreadMessages(threadId)` + `useChatStreamingState(messages, threadId)`,
 * which means when only one column exists the behavior matches the original
 * single-thread mount. In split mode each column updates independently as
 * its thread streams.
 *
 * Each submit carries this column's thread ID, including when focus changes
 * before the shared handler or asynchronous context preparation completes.
 */
export function ChatColumn({
  tabId: _tabId,
  threadId,
  isActive,
  onActivate,
  showHeader = true,
  showInlinePanels = true,
  // Shared UI / mode
  appMode,
  sidebarOpen,
  setSidebarOpen,
  minimalChat,
  // Chat transcript / composer props
  handleSubmit,
  setConfirmAction,
  setPlanModalContent,
  mentionQuery,
  mentionActive,
  slashActive,
  slashQuery,
  slashTrigger,
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
  composerProps,
  // Agent terminal/diff
  terminalOpen,
  setTerminalOpen,
  diffOpen,
  setDiffOpen,
}: {
  tabId: string
  threadId: string | null
  isActive: boolean
  onActivate: () => void
  showHeader?: boolean
  showInlinePanels?: boolean
  appMode: "agent" | "editor" | "design"
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  minimalChat: boolean
  chatMode: string
  handleSubmit: (args: ChatSubmitPayload) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setConfirmAction: (a: any) => void
  setPlanModalContent: SetPlanModalContent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedProvider: any
  selectedModel: string
  thinkingMode: string | null
  specialMode: string | null
  permissionLevel: string
  mentionQuery: string
  mentionActive: boolean
  slashActive: boolean
  slashQuery: string
  slashTrigger: "/" | "$"
  closeMention: () => void
  closeSlash: () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleSlashSelect: (cmd: any, replacement: string) => void
  autonomousMode: boolean
  autonomousStatus: "idle" | "working" | "paused" | "completed"
  autonomousIterations: number
  autonomousMaxIterations: number
  autonomousTask: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autonomousTaskList: any
  autonomousTimeBudgetMin: number
  autonomousStartedAt: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autonomousStopReason: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deepgram: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  composerProps: any
  terminalOpen: boolean
  setTerminalOpen: (v: boolean) => void
  diffOpen: boolean
  setDiffOpen: (v: boolean) => void
}) {
  const thread = useThreadById(threadId)
  const messages = useThreadMessages(threadId)
  const activities = useThreadActivities(threadId)
  const streaming = useChatStreamingState(
    messages,
    threadId,
    undefined,
    activities
  )
  const activeProposedPlan =
    streaming.allPlans
      .filter((plan) => !plan.streaming && !plan.implemented)
      .at(-1) ?? null
  const effectiveMinimalChat = minimalChat
  const emptyEditorChat =
    appMode === "editor" &&
    messages.length === 0 &&
    activities.length === 0 &&
    !streaming.isStreaming

  const composer = useAppPreferences(threadId)
  const selection = resolveProviderModelThinkingSelection({
    providers: composerProps.providers,
    selectedProviderId: composer.selectedProviderId,
    selectedModel: composer.selectedModel,
    thinkingMode: composer.thinkingMode,
    lockedProviderInstanceId:
      thread?.session?.providerInstanceId ??
      latestProviderInstanceId(activities),
    lockedContinuationKey:
      thread?.session?.continuationKey ??
      latestProviderContinuationKey(activities),
  })
  const selectedProvider = selection.provider
  const handleStop = useChatStop(selectedProvider, threadId)
  const effectiveSelectedModel = selection.modelId
  const thinkingMode = selection.thinkingMode
  const { specialMode, permissionLevel } = composer
  const effectiveChatMode = normalizeChatMode(composer.chatMode)
  const [pickerOpen, setPickerOpen] = useState(false)
  const externalPickerOpen = composerProps.modelPickerOpen
  const setExternalPickerOpen = composerProps.setModelPickerOpen
  useEffect(() => {
    setPickerOpen(false)
  }, [threadId])
  // A slash command opens the focused pane once. Ordinary menu clicks stay
  // local, so focusing another pane cannot transfer an already-open picker.
  useEffect(() => {
    if (isActive && externalPickerOpen) {
      setPickerOpen(true)
      setExternalPickerOpen?.(false)
    }
  }, [isActive, externalPickerOpen, setExternalPickerOpen])
  useEffect(() => {
    if (!isActive) setPickerOpen(false)
  }, [isActive])
  const setModelPickerOpen = useCallback(
    (open: boolean) => {
      if (open) onActivate()
      setPickerOpen(open)
    },
    [onActivate]
  )

  // Pin this thread in the LRU so it's never evicted while this column
  // is mounted — evicting a visible column's messages mid-render crashes.
  useEffect(() => {
    if (!threadId) return
    useChatStore.getState().pinThread(threadId)
    return () => {
      useChatStore.getState().unpinThread(threadId)
    }
  }, [threadId])

  const wrappedSubmit = async (args: ChatSubmitPayload) => {
    if (threadId) useChatStore.getState().setActiveThread(threadId)
    onActivate()
    return handleSubmit({ ...args, threadId })
  }
  const openPlan: SetPlanModalContent = (input) => {
    const payload = normalizePlanModalInput(input)
    setPlanModalContent(payload ? { ...payload, threadId } : null)
  }

  if (appMode === "editor" && threadId && !thread) {
    return (
      <div
        role="status"
        className="m-auto max-w-xs space-y-2 px-5 text-center text-xs text-muted-foreground"
      >
        <p className="font-medium text-foreground">Conversation unavailable</p>
        <p>
          This chat is not in the loaded history. Reopen it from history or
          close its tab.
        </p>
      </div>
    )
  }

  return (
    <div
      onMouseDownCapture={onActivate}
      onFocusCapture={onActivate}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        !isActive && "opacity-95"
      )}
    >
      {showHeader && (
        <ChatTopBar
          appMode={appMode}
          activeThread={thread}
          activeThreadId={threadId}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      )}
      <ProviderStatusBanner provider={selectedProvider} />

      {emptyEditorChat && (
        <div className="min-h-0 flex-1" data-editor-empty-chat="true" />
      )}
      {!emptyEditorChat && (
        <ChatTranscript
          messages={messages}
          activities={activities}
          isStreaming={streaming.isStreaming}
          minimalChat={effectiveMinimalChat}
          activeThreadId={threadId}
          activeProjectPath={
            thread?.worktreePath || thread?.projectPath || null
          }
          handleSubmit={wrappedSubmit}
          setConfirmAction={setConfirmAction}
          setPlanModalContent={openPlan}
          streamingText={streaming.streamingText}
          streamingPlanText={streaming.streamingPlanText}
          streamingTools={streaming.streamingTools}
          streamingDiffs={streaming.streamingDiffs}
          streamingTasks={streaming.streamingTasks}
          reasoningText={streaming.reasoningText}
          reasoningSegments={streaming.reasoningSegments}
          isReasoning={streaming.isReasoning}
          isPlanStreaming={streaming.isPlanStreaming}
          chatMode={effectiveChatMode}
          shimmerPhase={streaming.shimmerPhase}
          selectedProvider={selectedProvider}
          appMode={appMode}
        />
      )}

      <ChatInputArea
        isActive={isActive}
        minimalChat={effectiveMinimalChat}
        activeThreadId={threadId}
        activeProjectPath={thread?.worktreePath || thread?.projectPath}
        selectedModel={effectiveSelectedModel}
        thinkingMode={thinkingMode}
        selectedProvider={selectedProvider}
        chatMode={effectiveChatMode}
        specialMode={specialMode}
        permissionLevel={permissionLevel}
        contextWindow={composer.contextWindow}
        mentionQuery={isActive ? mentionQuery : ""}
        mentionActive={isActive && mentionActive}
        slashActive={isActive && slashActive}
        slashQuery={isActive ? slashQuery : ""}
        slashTrigger={slashTrigger}
        activeProposedPlan={activeProposedPlan}
        setPlanModalContent={openPlan}
        closeMention={closeMention}
        closeSlash={closeSlash}
        handleSlashSelect={handleSlashSelect}
        autonomousMode={autonomousMode}
        autonomousStatus={autonomousStatus}
        autonomousIterations={autonomousIterations}
        autonomousMaxIterations={autonomousMaxIterations}
        autonomousTask={autonomousTask}
        autonomousTaskList={autonomousTaskList}
        autonomousTimeBudgetMin={autonomousTimeBudgetMin}
        autonomousStartedAt={autonomousStartedAt}
        autonomousStopReason={autonomousStopReason}
        deepgram={deepgram}
        composerProps={{
          ...composerProps,
          activatePane: onActivate,
          appMode,
          minimalChat: effectiveMinimalChat,
          modelPickerOpen: isActive && pickerOpen,
          setModelPickerOpen,
          handleSubmit: wrappedSubmit,
          handleStop,
          isStreaming: streaming.isStreaming,
          // Override: both the displayed value and the setter must target
          // THIS column's thread, not whichever is globally active.
          chatMode: effectiveChatMode,
          setChatMode: composer.setChatMode,
          selectedModel: effectiveSelectedModel,
          setSelectedModel: composer.setSelectedModel,
          selectedProvider,
          currentProvider: selectedProvider,
          selectedProviderId:
            selectedProvider?.id ?? composer.selectedProviderId,
          setSelectedProviderId: composer.setSelectedProviderId,
          currentModelName:
            selectedProvider?.models.find(
              (model) => model.id === effectiveSelectedModel
            )?.name ?? effectiveSelectedModel,
          isLmStudio: selectedProvider?.id === "lmstudio",
          thinkingMode,
          setThinkingMode: composer.setThinkingMode,
          contextWindow: composer.contextWindow,
          setContextWindow: composer.setContextWindow,
          fastMode: composer.fastMode,
          setFastMode: composer.setFastMode,
          permissionLevel,
          setPermissionLevel: composer.setPermissionLevel,
        }}
      />

      {appMode === "agent" && showInlinePanels && (
        <AgentTerminalDiff
          threadId={threadId}
          projectPath={thread?.worktreePath || thread?.projectPath}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
          diffOpen={diffOpen}
          setDiffOpen={setDiffOpen}
        />
      )}

      {/* tabId consumed via ChatToolbar props — no explicit render needed */}
    </div>
  )
}
