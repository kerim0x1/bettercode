/**
 * Full chat composer — PromptInput wrapper with Simple/Extended mode
 * branches, feature/attach/terminal/permissions menus, mode/thinking/
 * model/context-window pickers, voice input, favorites, submit/stop.
 *
 * Extracted wholesale from App.tsx to give the composer a real component
 * boundary. All state + callbacks come in as props.
 *
 * The heavy footer UIs are split into:
 *   - `composer-minimal-footer.tsx`  (SimpleDropdown menus, compact layout)
 *   - `composer-full-footer.tsx`     (DropdownMenu pickers, expanded layout)
 *   - `chat-composer-types.ts`       (shared prop interface)
 */

import { cn } from "@/lib/utils"
import { useCallback, useEffect, useRef } from "react"
import { MentionChips } from "@/components/chat/mention-chips"
import { ComposerContextChips } from "@/components/chat/composer-context-chips"
import { ComposerDraftSync } from "@/components/chat/composer-draft-sync"
import { ComposerVoiceTextarea } from "@/components/chat/composer-voice-textarea"
import { ComposerPromptHistorySync } from "@/components/chat/composer-prompt-history-sync"
import { ComposerAttachments } from "@/components/chat/composer-attachments"
import { ComposerMinimalFooter } from "@/components/chat/composer-minimal-footer"
import { ComposerFullFooter } from "@/components/chat/composer-full-footer"
import { ComposerInlineModelTrigger } from "@/components/chat/composer-inline-model-trigger"
import type {
  ChatComposerProps,
  ComposerFooterProps,
} from "./chat-composer-types"
import { useAppearanceStore } from "@/lib/appearance-store"
import { useBetterC0deProjectBehavior } from "@/lib/betterc0de-project-behavior"
import {
  PromptInput,
  PromptInputProvider,
  PromptInputFooter,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import { handleError } from "@/lib/errors/handle"
import { useChatStore } from "@/lib/chat-store"
import { useSettingsStore } from "@/lib/settings-store"
import {
  alternateDelivery,
  type WhileWorkingDelivery,
} from "@/lib/chat/steer-delivery"
import { ComposerOrchestrationBadge } from "./composer-orchestration"
import { ComposerCompareBar, useCompareSubmit } from "./composer-compare"

/**
 * Bridges the empty-state suggestion cards (chat-transcript.tsx) into the
 * composer: they dispatch `betterc0de:insert-prompt` with a template and
 * this listener writes it into the textarea state. Event-based because the
 * transcript and the composer live in different subtrees with no shared
 * controller context.
 */
function ComposerInsertPromptSync({ threadId }: { threadId: string | null }) {
  const controller = usePromptInputController()
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ text?: string; threadId?: string | null }>
      ).detail
      if (!detail || detail.threadId !== threadId) return
      const text = detail.text
      if (typeof text === "string") controller.textInput.setInput(text)
    }
    window.addEventListener("betterc0de:insert-prompt", handler)
    return () => window.removeEventListener("betterc0de:insert-prompt", handler)
  }, [controller, threadId])
  return null
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    threadId = null,
    isActive = true,
    activatePane,
    handleSubmit,
    handleStop,
    handleVoiceClick,
    handleVoiceContextMenu,
    minimalChat,
    thinkingMode,
    setThinkingMode,
    autonomousMode,
    autonomousStatus,
    chatMode,
    setChatMode,
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
    selectedModel,
    setSelectedModel,
    setSelectedProviderId,
    providers,
    favoriteEntries,
    toggleFavorite,
    isFavorite,
    isLmStudio,
    isStreaming,
    modelPickerOpen,
    setModelPickerOpen,
    planFollowUpActive,
    voiceSetupComplete,
    deepgram,
    setTerminalOpen,
    setVoiceModalOpen,
    setAutonomousDialogOpen,
    checkSlash,
    checkMention,
    appMode,
    activeProjectPath,
    submitToThread,
  } = props
  // Several models chosen in a new chat: one chat per model on send.
  const submitWithCompare = useCompareSubmit({
    threadId,
    providers,
    selectedProviderId,
    selectedModel,
    thinkingMode,
    handleSubmit,
    submitToThread,
  })
  // Ctrl/Cmd+Enter while the agent works sends the other way than Enter
  // (queue or steer). The choice is armed only while the key starts the
  // form's submit and is then bound to that submit event, so a submit that
  // never reaches `onSubmit` cannot leave it behind for the next one.
  const armedDelivery = useRef<WhileWorkingDelivery | undefined>(undefined)
  const deliveryBySubmit = useRef(new WeakMap<Event, WhileWorkingDelivery>())
  const fileContextEnabled = useAppearanceStore((s) => s.fileContextEnabled)
  const projectBehavior = useBetterC0deProjectBehavior(activeProjectPath)
  const handleAttachmentError = useCallback((error: { message: string }) => {
    handleError(new Error(error.message), { source: "chat-attachments" })
  }, [])
  /* Props forwarded to both footer variants */
  const footerProps: ComposerFooterProps = {
    threadId,
    handleSubmit,
    handleStop,
    handleVoiceClick,
    handleVoiceContextMenu,
    thinkingMode,
    setThinkingMode,
    autonomousMode,
    autonomousStatus,
    chatMode,
    setChatMode,
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
    selectedModel,
    setSelectedModel,
    setSelectedProviderId,
    providers,
    favoriteEntries,
    toggleFavorite,
    isFavorite,
    isLmStudio,
    isStreaming,
    modelPickerOpen,
    setModelPickerOpen,
    planFollowUpActive,
    voiceSetupComplete,
    deepgram,
    setTerminalOpen,
    setVoiceModalOpen,
    setAutonomousDialogOpen,
    appMode,
  }

  return (
    // `PromptInputProvider` lifts the textarea state into a controller
    // context so `ComposerDraftSync` can read/write per-thread drafts.
    // One provider per composer instance → isolated state (splitting the
    // view into two columns still gives each its own draft buffer).
    <PromptInputProvider
      key={threadId ?? "new-chat"}
      initialInput={threadId ? useChatStore.getState().getDraft(threadId) : ""}
    >
      {/* Minimal layout: ONE lighter card (bg-sidebar, #141414) holds the
          context strip, and the input sits recessed inside it in the darker
          body tone (#0F0F0F). That two-tone step is what makes the strip read
          as its own bar rather than as the input's first line — with both on
          the same fill it just looked like a caption.
          `display: contents` in the full layout keeps this wrapper out of the
          box model entirely, so that path is unchanged. */}
      <div
        className={cn(
          minimalChat
            ? "w-full rounded-2xl border border-border/50 bg-sidebar p-1.5"
            : "contents"
        )}
      >
        {minimalChat && (
          <ComposerContextChips
            threadId={threadId}
            activatePane={activatePane}
          />
        )}
        <PromptInput
          imageAttachmentPolicy={projectBehavior.imageAttachmentPolicy}
          multiple
          onError={handleAttachmentError}
          onSubmitCapture={(event) => {
            if (armedDelivery.current)
              deliveryBySubmit.current.set(
                event.nativeEvent,
                armedDelivery.current
              )
          }}
          onSubmit={(message, event) => {
            const delivery = deliveryBySubmit.current.get(event.nativeEvent)
            return submitWithCompare(
              delivery ? { ...message, delivery } : message
            )
          }}
          className={cn(
            minimalChat
              ? "w-full [&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-transparent [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:transition-colors [&_[data-slot=input-group]:focus-within]:border-border/60"
              : "[&_[data-slot=input-group]]:border-ring/30 [&_[data-slot=input-group]]:ring-4 [&_[data-slot=input-group]]:ring-ring/8 [&_[data-slot=input-group]]:transition-[border-color] [&_[data-slot=input-group]]:duration-100 [&_[data-slot=input-group]:focus-within]:border-ring/50",
            autonomousMode &&
              autonomousStatus === "working" &&
              "ring-primary/20"
          )}
        >
          <ComposerDraftSync threadId={threadId} isActive={isActive} />
          <ComposerPromptHistorySync threadId={threadId} />
          <ComposerInsertPromptSync threadId={threadId} />
          <ComposerAttachments simple={minimalChat} />
          <MentionChips
            threadId={threadId}
            skills={selectedProvider?.skills ?? []}
          />
          {!minimalChat && (
            <div className="pointer-events-none absolute top-2 right-2 z-10">
              <div className="pointer-events-auto">
                <ComposerInlineModelTrigger {...footerProps} />
              </div>
            </div>
          )}
          <ComposerVoiceTextarea
            threadId={threadId}
            placeholder={
              minimalChat
                ? "Just get started"
                : fileContextEnabled
                  ? "Message BetterC0de — / for commands and skills, @ for files"
                  : "Message BetterC0de — / for commands and skills"
            }
            className={cn(
              minimalChat
                ? "min-h-28 py-3.5 pl-3 text-[13px] leading-5"
                : "min-h-44 pt-5 pl-4 text-base"
            )}
            onChange={(e) => {
              checkSlash(e.target.value, e.target.selectionStart)
              checkMention(e.target.value)
            }}
            onClick={(e) => {
              checkSlash(e.currentTarget.value, e.currentTarget.selectionStart)
            }}
            onKeyUp={(e) => {
              checkSlash(e.currentTarget.value, e.currentTarget.selectionStart)
            }}
            onKeyDown={(e) => {
              // Idle, Ctrl+Enter keeps inserting a line and Cmd+Enter sends.
              if (
                !isStreaming ||
                e.key !== "Enter" ||
                !(e.ctrlKey || e.metaKey) ||
                e.shiftKey ||
                e.altKey ||
                e.nativeEvent.isComposing ||
                !e.currentTarget.value.trim()
              )
                return
              e.preventDefault()
              const form = e.currentTarget.form
              if (!form) return
              armedDelivery.current = alternateDelivery(
                useSettingsStore.getState().whileWorkingEnter
              )
              try {
                form.requestSubmit()
              } finally {
                armedDelivery.current = undefined
              }
            }}
          />
          {/* The footer is its own container so the chips can react to the
            column they live in (design side panel vs. wide agent chat). */}
          <ComposerCompareBar {...footerProps} />
          <ComposerOrchestrationBadge
            threadId={threadId}
            currentProvider={currentProvider}
            providers={providers}
            isStreaming={isStreaming}
          />
          <PromptInputFooter
            className={cn(
              "@container",
              minimalChat && "gap-0.5 px-2 pt-0 pb-2"
            )}
          >
            {minimalChat ? (
              <ComposerMinimalFooter {...footerProps} />
            ) : (
              <ComposerFullFooter {...footerProps} />
            )}
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptInputProvider>
  )
}
