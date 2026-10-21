import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { FileChangesBar } from "@/components/ai-elements/file-changes-bar"
import { FileMentionMenu } from "@/components/file-mentions"
import {
  detectSlashCommandTrigger,
  replaceSlashCommandTriggerRange,
  SlashCommandMenu,
} from "@/components/slash-commands"
import { PendingQuestionsPanel } from "@/components/chat/pending-questions-panel"
import { AutonomousStatusBar } from "@/components/chat/autonomous-status-bar"
import { ThreadGoalCard } from "@/components/chat/thread-goal-card"
import { ChatResumeCard } from "@/components/chat/chat-resume-card"
import { ChatComposer } from "@/components/chat/chat-composer"
import { chatContentWidth } from "./chat-layout"
import type { ComposerPlanFollowUp } from "@/components/chat/composer-plan-follow-up-banner"
import { QueuedMessages } from "@/components/chat/queued-messages"
import { unwrapPlanContent } from "@/lib/plan-content"
import { resolvePlanFollowUpSubmission } from "@/lib/proposed-plan"
import { implementPendingPlanApproval } from "@/lib/plan-implement"
import { useAppearanceStore } from "@/lib/appearance-store"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"
import { findComposerTextarea, setComposerInput } from "@/lib/composer-input"
import { useChatStore } from "@/lib/chat-store"
import { useComposerMenuStore } from "@/lib/composer-menu-store"
import type { Ref } from "react"
import type { ChatComposerProps } from "@/components/chat/chat-composer-types"
import type { UiProvider } from "@/lib/provider-types"
import type { PermissionLevel } from "@/lib/preferences-store"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import {
  AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN,
  AUTONOMOUS_MAX_ITERATIONS,
  type AutonomousStatus,
} from "@/lib/chat/types"
import { resumeAutonomousRun } from "@/lib/chat/autonomy-controls"

/**
 * The composer bag a chat column hands over. The input area adds the
 * thread wiring (thread, focus, autonomous ownership, plan follow-up).
 */
export type ChatInputComposerProps = Omit<
  ChatComposerProps,
  | "threadId"
  | "isActive"
  | "autonomousMode"
  | "autonomousStatus"
  | "activeProjectPath"
  | "planFollowUpActive"
>

export interface ChatInputAreaProps {
  innerRef?: Ref<HTMLDivElement>
  isActive?: boolean
  minimalChat: boolean
  activeThreadId: string | null
  activeProjectPath?: string | null
  selectedModel: string
  thinkingMode: string | null
  selectedProvider: UiProvider | undefined
  chatMode: string
  specialMode: string | null
  permissionLevel: PermissionLevel
  contextWindow?: string | null
  activeProposedPlan: ComposerPlanFollowUp | null
  /** Plan modal opener bound to this column's thread. */
  setPlanModalContent?: SetPlanModalContent
  deepgram: { error: string | null; clearError: () => void }
  composerProps: ChatInputComposerProps
}

/**
 * Bottom-of-chat input area that bundles every accessory above the actual
 * composer:
 *  - Pending file-change bar (staged diffs not yet committed)
 *  - Pending questions panel (step-wizard for the assistant's questions)
 *  - File mention `@…` autocomplete
 *  - Slash command `/…` autocomplete
 *  - Autonomous mode status bar
 *  - The composer itself (text area + all dropdowns + submit/stop)
 *  - Deepgram voice-error toast + "may make mistakes" disclaimer
 *
 * All these need access to the same pile of chat-state + handlers, so
 * rather than spread them across App.tsx we group them here and pass a
 * single prop bag through. Yes, the prop count is large — that's the
 * cost of this being the single integration point between the composer
 * chrome and every feature layered on top of it.
 *
 * The `/` and `@` menus read their state from the composer menu store here,
 * and only in the active column, so typing a command re-renders this area
 * instead of the app shell.
 */
export function ChatInputArea(props: ChatInputAreaProps) {
  const {
    innerRef,
    isActive = true,
    minimalChat,
    activeThreadId,
    activeProjectPath,
    selectedModel,
    thinkingMode,
    selectedProvider,
    chatMode,
    specialMode,
    permissionLevel,
    contextWindow,
    activeProposedPlan,
    deepgram,
    composerProps,
  } = props
  const fileContextEnabled = useAppearanceStore((s) => s.fileContextEnabled)
  // Inactive columns select constants, so typing elsewhere never re-renders
  // them.
  const mentionActive = useComposerMenuStore((s) => isActive && s.mentionActive)
  const mentionQuery = useComposerMenuStore((s) =>
    isActive ? s.mentionQuery : ""
  )
  const slashActive = useComposerMenuStore((s) => isActive && s.slashActive)
  const slashQuery = useComposerMenuStore((s) => (isActive ? s.slashQuery : ""))
  const slashTrigger = useComposerMenuStore((s) =>
    isActive ? s.slashTrigger : "/"
  )
  const slashRange = useComposerMenuStore((s) =>
    isActive ? s.slashRange : null
  )
  const closeMention = useComposerMenuStore((s) => s.closeMention)
  const closeSlash = useComposerMenuStore((s) => s.closeSlash)
  // This chat's Autonomous Work run, as the backend reports it.
  const autonomousRun = useChatStore((s) =>
    activeThreadId ? s.autonomyByThread[activeThreadId] : undefined
  )
  const autonomousStatus: AutonomousStatus = autonomousRun?.status ?? "idle"
  const resumeAutonomousWork = () =>
    activeThreadId
      ? resumeAutonomousRun(activeThreadId, {
          provider: selectedProvider,
          modelId: selectedModel,
          thinkingMode,
          chatMode,
          specialMode,
          permissionLevel,
          contextWindow,
          projectPath: activeProjectPath,
          appMode: composerProps.appMode,
        })
      : Promise.resolve()

  const composerSubmit = (payload: ChatSubmitPayload) => {
    payload = { ...payload, threadId: activeThreadId ?? null }
    // Goal controls must stay immediate, including while a plan is awaiting approval.
    if (/^\/goal(?:\s|$)/i.test(payload.text.trim()))
      return composerProps.handleSubmit(payload)
    const plan = activeProposedPlan
    if (plan && !plan.implemented && payload.files.length === 0) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: payload.text,
        planMarkdown: unwrapPlanContent(plan.content),
      })
      const isImplementation = followUp.interactionMode === "default"
      const sendFollowUp = () => {
        composerProps.setChatMode?.(
          followUp.interactionMode === "plan" ? "plan" : "agent"
        )
        return composerProps.handleSubmit({
          ...payload,
          text: followUp.text,
          visibleText: isImplementation
            ? "Implement the proposed plan."
            : undefined,
          chatModeOverride:
            followUp.interactionMode === "plan" ? "plan" : "agent",
          sourceProposedPlan: isImplementation
            ? (plan.sourceProposedPlan ?? null)
            : null,
        })
      }
      // Implement (empty draft) resolves the pending plan approval — the same
      // parked turn continues into implementation. A fresh "Implement the
      // proposed plan." turn only goes out when nothing is pending (no parked
      // turn to collide with). Plan refinement (non-empty draft) always sends.
      if (isImplementation && activeThreadId) {
        // Implementation continues the parked plan turn as an agent turn, so
        // switch the composer out of plan mode now — otherwise (on the normal
        // pending-approval path, where sendFollowUp never runs) the user's next
        // message would be sent as another plan request. Mirrors executePlan.
        composerProps.setChatMode?.("agent")
        void implementPendingPlanApproval(activeThreadId, {
          permissionMode: "acceptEdits",
        })
          .then((outcome) => {
            if (outcome === "no-approval") return sendFollowUp()
          })
          .catch(() => {
            // implementPendingPlanApproval resolves its own errors to "error";
            // this guards a rejected fallback submit from becoming unhandled.
          })
        return
      }
      return sendFollowUp()
    }
    return composerProps.handleSubmit(payload)
  }

  return (
    <div
      ref={innerRef}
      data-composer-thread={activeThreadId ?? ""}
      data-composer-active={isActive}
      className={cn(
        "relative mx-auto w-full shrink-0 px-4 pb-4",
        chatContentWidth(minimalChat)
      )}
    >
      {permissionLevel !== "bypass" && (
        <FileChangesBar threadId={activeThreadId ?? null} />
      )}
      <QueuedMessages
        threadId={activeThreadId ?? null}
        selectedProvider={selectedProvider}
      />
      <PendingQuestionsPanel
        key={activeThreadId ?? "new-chat"}
        threadId={activeThreadId}
        selectedModel={selectedModel}
        thinkingMode={thinkingMode}
        selectedProvider={selectedProvider}
        chatMode={chatMode}
        specialMode={specialMode}
        permissionLevel={permissionLevel}
        contextWindow={contextWindow}
      />
      <FileMentionMenu
        threadId={activeThreadId ?? null}
        query={mentionQuery}
        visible={fileContextEnabled && mentionActive && !slashActive}
        projectPath={activeProjectPath || ""}
        onSelect={() => {}}
        onClose={closeMention}
        setInputText={() => {}}
      />
      <SlashCommandMenu
        query={slashQuery}
        trigger={slashTrigger}
        selectedProvider={selectedProvider}
        projectPath={activeProjectPath}
        visible={slashActive}
        onSelect={(cmd) => {
          if (cmd.id === "model") composerProps.setModelPickerOpen?.(true)
          else if (cmd.id === "plan") composerProps.setChatMode?.("plan")
          else if (cmd.id === "ask") composerProps.setChatMode?.("ask")
          else if (cmd.id === "default") composerProps.setChatMode?.("agent")
          else if (cmd.id === "prompt-clear")
            setComposerInput(
              findComposerTextarea(activeThreadId ?? null),
              "",
              true
            )
          else if (cmd.id === "prompt-paste") {
            const input = findComposerTextarea(activeThreadId ?? null)
            void navigator.clipboard
              ?.readText()
              .then((text) => setComposerInput(input, text, true))
              .catch(() => {})
          }
          closeSlash?.()
        }}
        onClose={closeSlash}
        setInputText={(text) => {
          // Set the textarea value programmatically via DOM.
          const ta = findComposerTextarea(activeThreadId ?? null)
          if (ta) {
            const current = ta.value
            const storedRange =
              slashRange &&
              slashRange.start >= 0 &&
              slashRange.end >= slashRange.start &&
              slashRange.end <= current.length
                ? slashRange
                : null
            const liveTrigger = storedRange
              ? null
              : detectSlashCommandTrigger(
                  current,
                  Number.isFinite(ta.selectionStart)
                    ? ta.selectionStart
                    : current.length
                )
            const replaced = replaceSlashCommandTriggerRange(
              current,
              storedRange ??
                (liveTrigger
                  ? {
                      start: liveTrigger.rangeStart,
                      end: liveTrigger.rangeEnd,
                    }
                  : null),
              text
            )
            if (!replaced) return
            const nativeSet = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value"
            )?.set
            nativeSet?.call(ta, replaced.text)
            ta.dispatchEvent(new Event("input", { bubbles: true }))
            ta.setSelectionRange(replaced.cursor, replaced.cursor)
            ta.focus()
          }
        }}
      />
      <AutonomousStatusBar
        threadId={activeThreadId}
        onResume={resumeAutonomousWork}
        autonomousMode={autonomousRun !== undefined}
        autonomousStatus={autonomousStatus}
        autonomousIterations={autonomousRun?.iterations ?? 0}
        autonomousMaxIterations={
          autonomousRun?.maxIterations ?? AUTONOMOUS_MAX_ITERATIONS
        }
        autonomousTask={autonomousRun?.tasks[0]?.text ?? null}
        autonomousTaskList={autonomousRun?.tasks ?? null}
        autonomousTimeBudgetMin={
          autonomousRun?.timeBudgetMin ?? AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN
        }
        autonomousStartedAt={autonomousRun?.startedAt ?? null}
        autonomousStopReason={autonomousRun?.stopReason ?? null}
      />
      <ChatResumeCard threadId={activeThreadId} />
      <ThreadGoalCard
        threadId={activeThreadId}
        handleSubmit={composerProps.handleSubmit}
      />
      <ChatComposer
        {...composerProps}
        threadId={activeThreadId ?? null}
        isActive={isActive}
        autonomousMode={autonomousRun !== undefined}
        autonomousStatus={autonomousStatus}
        activeProjectPath={activeProjectPath}
        handleSubmit={composerSubmit}
        planFollowUpActive={Boolean(
          activeProposedPlan && !activeProposedPlan.implemented
        )}
      />

      {deepgram.error && (
        <div className="mx-auto mt-2 flex max-w-md items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs text-red-400">
          <span className="flex-1">{deepgram.error}</span>
          <button
            type="button"
            onClick={deepgram.clearError}
            className="text-red-400/60 hover:text-red-400"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
