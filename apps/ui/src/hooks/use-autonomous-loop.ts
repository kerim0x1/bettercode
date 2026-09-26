import { useEffect, useRef } from "react"
import { getThreadStream, useChatStore, useThreadById, useThreadActivities } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import { resolveProviderModelThinkingSelection, latestProviderInstanceId, latestProviderContinuationKey, resolveDispatchModelId } from "@/lib/provider-model-selection"
import { sendChatMessage } from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import type { UiProvider } from "@/lib/provider-types"
import type { AutonomousStopReason, AutonomousTask } from "@/lib/chat/types"

const COMPLETION_KEYWORDS = [
  "all tasks complete",
  "all tasks are complete",
  "everything is done",
  "all steps completed",
  "implementation is complete",
  "task is complete",
  "task completed",
  "all done",
  "finished all",
  "completed all",
  "alles erledigt",
  "aufgabe abgeschlossen",
]

/** Extract `[TASK_DONE:<id>]` markers from the model's reply. */
const TASK_DONE_RE = /\[TASK_DONE:([\w-]+)\]/g

function formatTaskList(list: AutonomousTask[] | null | undefined): string {
  if (!list || list.length === 0) return ""
  return list
    .map(
      (t) =>
        `- [${t.done ? "x" : " "}] ${t.id}: ${t.text.trim() || "(empty)"}`,
    )
    .join("\n")
}

function stopReasonLabel(reason: AutonomousStopReason): string {
  switch (reason) {
    case "completion-signal":
      return "all tasks are complete"
    case "time-budget":
      return "the wall-clock time budget was reached"
    case "max-iterations":
      return "the iteration cap was reached"
    case "user":
      return "the user stopped the run"
    case "error":
      return "an error occurred"
  }
}

/**
 * Drives the "Autonomous Work" loop: whenever the assistant's streaming turn
 * ends, automatically send a follow-up prompt so the agent keeps iterating on
 * the task list without user input.
 *
 * Stops on any of:
 *  - Every task in `autonomousTaskList` marked done (`completion-signal`)
 *  - Wall-clock elapsed ≥ `autonomousTimeBudgetMin` (`time-budget`)
 *  - Iterations ≥ `autonomousMaxIterations` (`max-iterations`)
 *  - Assistant's last reply matches a completion keyword (`completion-signal`)
 *  - User pause / reset / stop (`user`)
 *  - Error during send (`error`)
 *
 * On any non-user stop we fire ONE final summary turn so the run ends with a
 * clear bilanz of what got done vs. what's still pending, then flip status to
 * "completed" and record the stop reason.
 */
export function useAutonomousLoop({ providers }: { providers: UiProvider[] }) {
  const threadId = useChatStore(s => s.autonomousThreadId)
  const isStreaming = useChatStore(s => getThreadStream(s, threadId).isStreaming)
  const thread = useThreadById(threadId)
  const activities = useThreadActivities(threadId)
  const composer = useAppPreferences(threadId)
  const { provider: selectedProvider, modelId: selectedModel, thinkingMode } = resolveProviderModelThinkingSelection({
    ...composer, providers,
    lockedProviderInstanceId: thread?.session?.providerInstanceId ?? latestProviderInstanceId(activities),
    lockedContinuationKey: thread?.session?.continuationKey ?? latestProviderContinuationKey(activities),
  })
  const { chatMode, specialMode, permissionLevel, contextWindow } = composer
  const autonomousMode = useChatStore((s) => s.autonomousMode)
  const autonomousStatus = useChatStore((s) => s.autonomousStatus)
  const autonomousIterations = useChatStore((s) => s.autonomousIterations)
  const autonomousMaxIterations = useChatStore(
    (s) => s.autonomousMaxIterations,
  )
  const autonomousTimeBudgetMin = useChatStore(
    (s) => s.autonomousTimeBudgetMin,
  )
  const autonomousStartedAt = useChatStore((s) => s.autonomousStartedAt)
  const autonomousTaskList = useChatStore((s) => s.autonomousTaskList)
  const prevAutonomousStreaming = useRef({ threadId, isStreaming: false })
  const autonomousProgressRef = useRef({ signature: "", stagnantCycles: 0 })

  useEffect(() => {
    const wasStreaming = prevAutonomousStreaming.current.threadId === threadId && prevAutonomousStreaming.current.isStreaming
    prevAutonomousStreaming.current = { threadId, isStreaming }

    if (!wasStreaming || isStreaming) return
    if (!autonomousMode || autonomousStatus !== "working") return

    const store = useChatStore.getState()
    if (!threadId) return
    if (useMessageQueueStore.getState().messages.some(entry => entry.threadId === threadId)) return

    // Shared send helper used by both normal iterations and final summary.
    const sendAutonomousTurn = async (
      promptText: string,
      isFinalSummary: boolean,
    ) => {
      const s = useChatStore.getState()
      if (!s.autonomousMode || s.autonomousStatus !== "working" || s.autonomousThreadId !== threadId) return
      if (useMessageQueueStore.getState().messages.some(entry => entry.threadId === threadId)) return

      const dispatchUserMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: promptText,
        modelId: selectedModel,
        createdAt: new Date().toISOString(),
      } as const
      try {
        const target = await resolveProviderTarget(selectedProvider, selectedModel)
        const current = useChatStore.getState()
        const currentThread = current.threads.find((t) => t.id === threadId)
        if (!currentThread || !current.autonomousMode || current.autonomousStatus !== "working" || current.autonomousThreadId !== threadId) return
        if (useMessageQueueStore.getState().messages.some(entry => entry.threadId === threadId)) return
        const effectiveModel = resolveDispatchModelId(
          target.providerKind,
          selectedModel
        )
        current.addMessage(threadId, dispatchUserMessage)
        current.setStreamingModelId(threadId, selectedModel)
        current.appendStreamDelta(threadId, "")
        await sendChatMessage(
          threadId,
          promptText,
          effectiveModel,
          target.providerKind,
          coerceThinkingModeForModel(selectedProvider, selectedModel, thinkingMode),
          chatMode,
          currentThread?.worktreePath || currentThread?.projectPath || null,
          specialMode,
          permissionLevel,
          target.openaiTransport,
          null,
          target.providerInstanceId,
          contextWindow,
          null,
          dispatchUserMessage,
        )
        if (isFinalSummary && useChatStore.getState().autonomousThreadId === threadId) {
          useChatStore.getState().setAutonomousStatus("completed")
        }
      } catch {
        useChatStore.getState().clearStreaming(threadId)
        if (useChatStore.getState().autonomousThreadId !== threadId) return
        useChatStore.getState().setAutonomousStopReason("error")
        useChatStore.getState().setAutonomousStatus("paused")
      }
    }

    // Fire one final summary turn, then flip status to "completed" with the
    // given reason. Records the reason first so a race with user-pause still
    // shows the right badge in the status bar.
    const finalizeRun = async (reason: AutonomousStopReason) => {
      const s = useChatStore.getState()
      s.setAutonomousStopReason(reason)

      const list = s.autonomousTaskList
      const doneCount = list ? list.filter((t) => t.done).length : 0
      const totalCount = list ? list.length : 0
      const listBlock =
        list && list.length > 0
          ? `\n\nTask list snapshot (${doneCount}/${totalCount} done):\n${formatTaskList(list)}`
          : ""

      const summaryPrompt = `The autonomous run is stopping because ${stopReasonLabel(reason)}.${listBlock}\n\nWrite a final summary in 5–8 bullet points:\n- What was completed (reference each task id where relevant)\n- What's still open or partially done\n- One recommended next step if the user picks this up again\n\nDo not run further tools or start new work — this is the final message of the run.`

      await sendAutonomousTurn(summaryPrompt, /* isFinalSummary */ true)
    }

    // ─── Parse task-done markers from the last assistant message ─────────
    const thread = store.threads.find((t) => t.id === threadId)
    const lastMsg =
      thread && thread.messages.length > 0
        ? thread.messages[thread.messages.length - 1]
        : null
    const lastAssistantText =
      lastMsg && lastMsg.role === "assistant" && lastMsg.content
        ? lastMsg.content
        : ""

    if (lastAssistantText) {
      const matches: RegExpMatchArray[] = Array.from(
        lastAssistantText.matchAll(TASK_DONE_RE)
      )
      for (const m of matches) {
        const id = m[1]
        if (id) store.markAutonomousTaskDone(id, true)
      }
    }

    // ─── Termination checks (ordered by authority) ──────────────────────
    const freshList = useChatStore.getState().autonomousTaskList

    if (freshList && freshList.length > 0 && freshList.every((t) => t.done)) {
      void finalizeRun("completion-signal")
      return
    }

    if (
      autonomousTimeBudgetMin > 0 &&
      autonomousStartedAt &&
      (Date.now() - autonomousStartedAt) / 60000 >= autonomousTimeBudgetMin
    ) {
      void finalizeRun("time-budget")
      return
    }

    if (autonomousIterations >= autonomousMaxIterations) {
      void finalizeRun("max-iterations")
      return
    }

    if (lastAssistantText) {
      const lower = lastAssistantText.toLowerCase()
      if (COMPLETION_KEYWORDS.some((kw) => lower.includes(kw))) {
        void finalizeRun("completion-signal")
        return
      }

      const signature = `${lastAssistantText.slice(0, 200)}::${lastAssistantText.slice(-200)}::${lastAssistantText.length}`
      if (autonomousProgressRef.current.signature === signature) {
        autonomousProgressRef.current.stagnantCycles += 1
      } else {
        autonomousProgressRef.current.signature = signature
        autonomousProgressRef.current.stagnantCycles = 0
      }
    }

    // ─── Normal follow-up iteration ─────────────────────────────────────
    const timer = setTimeout(async () => {
      const currentStore = useChatStore.getState()
      if (
        !currentStore.autonomousMode ||
        currentStore.autonomousStatus !== "working" || currentStore.autonomousThreadId !== threadId
      )
        return

      currentStore.incrementAutonomousIteration()
      const iter = currentStore.autonomousIterations + 1
      const max = currentStore.autonomousMaxIterations
      const list = currentStore.autonomousTaskList
      const task = currentStore.autonomousTask || "the assigned work"
      const stagnant = autonomousProgressRef.current.stagnantCycles
      const shouldRefreshPlan = iter % 4 === 0 || stagnant >= 2

      const taskBlock =
        list && list.length > 0
          ? `\n\nActive tasks:\n${formatTaskList(list)}\n\nFocus on the next unchecked task. When you finish one, emit a marker \`[TASK_DONE:<id>]\` on its own line so the harness can tick it off.`
          : ""

      const baseContext = `Iteration ${iter}/${max}.${taskBlock}`

      const followUp = shouldRefreshPlan
        ? `Continue the autonomous run for: ${task}. ${baseContext}\n\nFirst refresh a concise plan (3–7 checklist items) based on the current repo state, then immediately execute the highest-priority unfinished step. If blocked by missing details, choose the safest assumption and continue.`
        : `Continue the autonomous run for: ${task}. ${baseContext}\n\nBriefly summarize progress, identify the next concrete step, then execute it immediately. Do not wait for confirmation.`

      await sendAutonomousTurn(followUp, /* isFinalSummary */ false)
    }, 1200)

    return () => clearTimeout(timer)
  }, [
    threadId,
    isStreaming,
    autonomousMode,
    autonomousStatus,
    autonomousIterations,
    autonomousMaxIterations,
    autonomousTimeBudgetMin,
    autonomousStartedAt,
    autonomousTaskList,
    selectedModel,
    selectedProvider,
    thinkingMode,
    chatMode,
    specialMode,
    permissionLevel,
    contextWindow,
  ])
}
