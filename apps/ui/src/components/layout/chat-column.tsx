import { useEffect, useMemo, useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import { ChatTopBar } from "@/components/layout/chat-top-bar"
import { ChatTranscript } from "@/components/chat/chat-transcript"
import {
  ChatInputArea,
  type ChatInputComposerProps,
} from "@/components/chat/chat-input-area"
import { useChatStop } from "@/hooks/use-chat-stop"
import { normalizePlanModalInput } from "@/lib/plan-modal"
import { ProviderStatusBanner } from "@/components/chat/provider-status-banner"
import { ForkLineageBar } from "@/components/chat/fork-lineage-bar"
import { AgentTerminalDiff } from "@/components/layout/agent-terminal-diff"
import {
  useChatStore,
  useThreadActivities,
  useThreadById,
  useThreadMessages,
} from "@/lib/chat-store"
import {
  useThreadHasTranscript,
  useThreadIsStreaming,
  useThreadProviderLock,
} from "@/lib/chat/thread-derived"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import { useAppUiStore } from "@/lib/app-ui-store"
import { resolveProviderModelThinkingSelection } from "@/lib/provider-model-selection"
import { normalizeChatMode } from "@/lib/chat-mode-labels"
import {
  useChatStreamingState,
  useThreadPersistedPlans,
} from "@/hooks/use-chat-streaming-state"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"
import type { ConfirmAction } from "@/components/dialogs/confirm-action-dialog"
import type { MainAreaProps } from "@/hooks/use-app-shell-bundles"
import type { UiProvider } from "@/lib/provider-types"

/** Props of one chat column. Shell values keep the types the shell produces. */
export interface ChatColumnProps {
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
  chatMode: MainAreaProps["chatMode"]
  handleSubmit: (args: ChatSubmitPayload) => void
  setConfirmAction: (action: ConfirmAction) => void
  setPlanModalContent: SetPlanModalContent
  selectedProvider: MainAreaProps["selectedProvider"]
  selectedModel: MainAreaProps["selectedModel"]
  thinkingMode: MainAreaProps["thinkingMode"]
  specialMode: MainAreaProps["specialMode"]
  permissionLevel: MainAreaProps["permissionLevel"]
  deepgram: MainAreaProps["deepgram"]
  composerProps: MainAreaProps["composerProps"]
  terminalOpen: boolean
  setTerminalOpen: (v: boolean) => void
  diffOpen: boolean
  setDiffOpen: (v: boolean) => void
}

/** What every pane's column shares; the pane adds its own tab and thread. */
export type ChatColumnSharedProps = Omit<
  ChatColumnProps,
  "tabId" | "threadId" | "isActive" | "onActivate"
>

/**
 * One full chat column — top bar + transcript + composer + optional
 * terminal/diff strip. Parameterized by `threadId` so stacked editor chats
 * and agent panes can each stay bound to a different thread.
 *
 * The column itself subscribes only to narrow facts about its thread (is it
 * streaming, its provider lock, its recorded plans). The live transcript and
 * its per-frame streaming state live in {@link ChatColumnTranscript}, so a
 * streamed delta or a tool event re-renders the transcript, not the composer
 * and its menus.
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
  deepgram,
  composerProps,
  // Agent terminal/diff
  terminalOpen,
  setTerminalOpen,
  diffOpen,
  setDiffOpen,
}: ChatColumnProps) {
  const thread = useThreadById(threadId)
  const isStreaming = useThreadIsStreaming(threadId)
  const hasTranscript = useThreadHasTranscript(threadId)
  const providerLock = useThreadProviderLock(threadId)
  // Recorded plans are cached per history change, so the newest unimplemented
  // plan is recomputed only when messages or activities actually change.
  const persistedPlans = useThreadPersistedPlans(threadId)
  const activeProposedPlan = useMemo(
    () => persistedPlans.filter((plan) => !plan.implemented).at(-1) ?? null,
    [persistedPlans]
  )
  const effectiveMinimalChat = minimalChat
  const emptyEditorChat = appMode === "editor" && !hasTranscript && !isStreaming

  const composer = useAppPreferences(threadId)
  const selection = resolveProviderModelThinkingSelection({
    providers: composerProps.providers,
    selectedProviderId: composer.selectedProviderId,
    selectedModel: composer.selectedModel,
    thinkingMode: composer.thinkingMode,
    lockedProviderInstanceId:
      thread?.session?.providerInstanceId ?? providerLock.instanceId,
    lockedContinuationKey:
      thread?.session?.continuationKey ?? providerLock.continuationKey,
  })
  const selectedProvider = selection.provider
  const handleStop = useChatStop(selectedProvider, threadId)
  const effectiveSelectedModel = selection.modelId
  const thinkingMode = selection.thinkingMode
  const { specialMode, permissionLevel } = composer
  const effectiveChatMode = normalizeChatMode(composer.chatMode)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Opening the picker from outside a column (the submit handler's "choose
  // another model" prompt, the `/model` command) goes through a shared flag
  // that the focused column takes over below.
  const externalPickerOpen = useAppUiStore((s) => s.modelModalOpen)
  const setExternalPickerOpen = useAppUiStore((s) => s.setModelModalOpen)
  useEffect(() => {
    setPickerOpen(false)
  }, [threadId])
  // A slash command opens the focused pane once. Ordinary menu clicks stay
  // local, so focusing another pane cannot transfer an already-open picker.
  useEffect(() => {
    if (isActive && externalPickerOpen) {
      setPickerOpen(true)
      setExternalPickerOpen(false)
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

  const columnComposerProps: ChatInputComposerProps = {
    ...composerProps,
    activatePane: onActivate,
    appMode,
    minimalChat: effectiveMinimalChat,
    modelPickerOpen: isActive && pickerOpen,
    setModelPickerOpen,
    handleSubmit: wrappedSubmit,
    // Compare's other chats: sent as they are named, without focusing them.
    submitToThread: handleSubmit,
    handleStop,
    isStreaming,
    // Override: both the displayed value and the setter must target
    // THIS column's thread, not whichever is globally active.
    chatMode: effectiveChatMode,
    setChatMode: composer.setChatMode,
    selectedModel: effectiveSelectedModel,
    setSelectedModel: composer.setSelectedModel,
    selectedProvider,
    currentProvider: selectedProvider,
    selectedProviderId: selectedProvider?.id ?? composer.selectedProviderId,
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
      {/* Forked chats: where they came from, and Merge back. */}
      <ForkLineageBar threadId={threadId} minimalChat={effectiveMinimalChat} />

      {emptyEditorChat && (
        <div className="min-h-0 flex-1" data-editor-empty-chat="true" />
      )}
      {!emptyEditorChat && (
        <ChatColumnTranscript
          threadId={threadId}
          minimalChat={effectiveMinimalChat}
          activeProjectPath={
            thread?.worktreePath || thread?.projectPath || null
          }
          handleSubmit={wrappedSubmit}
          setConfirmAction={setConfirmAction}
          setPlanModalContent={openPlan}
          chatMode={effectiveChatMode}
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
        activeProposedPlan={activeProposedPlan}
        setPlanModalContent={openPlan}
        deepgram={deepgram}
        composerProps={columnComposerProps}
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

/**
 * The live transcript of one column. It owns the subscriptions that change
 * on every streamed delta and tool event (messages, activities, stream
 * text), so those updates stop here instead of re-rendering the column.
 */
function ChatColumnTranscript({
  threadId,
  minimalChat,
  activeProjectPath,
  handleSubmit,
  setConfirmAction,
  setPlanModalContent,
  chatMode,
  selectedProvider,
  appMode,
}: {
  threadId: string | null
  minimalChat: boolean
  activeProjectPath: string | null
  handleSubmit: (args: ChatSubmitPayload) => void
  setConfirmAction: (action: ConfirmAction) => void
  setPlanModalContent: SetPlanModalContent
  chatMode: string
  selectedProvider: UiProvider | undefined
  appMode: "agent" | "editor" | "design"
}) {
  const messages = useThreadMessages(threadId)
  const activities = useThreadActivities(threadId)
  const streaming = useChatStreamingState(
    messages,
    threadId,
    undefined,
    activities
  )
  return (
    <ChatTranscript
      messages={messages}
      activities={activities}
      isStreaming={streaming.isStreaming}
      minimalChat={minimalChat}
      activeThreadId={threadId}
      activeProjectPath={activeProjectPath}
      handleSubmit={handleSubmit}
      setConfirmAction={setConfirmAction}
      setPlanModalContent={setPlanModalContent}
      streamingText={streaming.streamingText}
      streamingPlanText={streaming.streamingPlanText}
      streamingTools={streaming.streamingTools}
      streamingDiffs={streaming.streamingDiffs}
      streamingTasks={streaming.streamingTasks}
      reasoningText={streaming.reasoningText}
      reasoningSegments={streaming.reasoningSegments}
      isReasoning={streaming.isReasoning}
      isPlanStreaming={streaming.isPlanStreaming}
      chatMode={chatMode}
      shimmerPhase={streaming.shimmerPhase}
      selectedProvider={selectedProvider}
      appMode={appMode}
    />
  )
}
