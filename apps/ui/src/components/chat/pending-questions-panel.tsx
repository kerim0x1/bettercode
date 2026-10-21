import { useEffect, useMemo, useState } from "react"
import { CheckIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useChatStore, useThreadActivities } from "@/lib/chat-store"
import { respondToUserInput } from "@/services/backend/chatApi"
import { sendChatMessage } from "@/lib/chat/send-message"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import { isStalePendingRequestFailureDetail } from "@/lib/pending-provider-requests"
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@/lib/pending-user-input"
import type { OpenAiTransport } from "@/lib/provider-types"
import { createLogger } from "@/lib/logger"
import {
  derivePendingProviderUserInputs,
  normalizeProviderQuestion,
  type PanelQuestion,
  type PendingProviderUserInput,
} from "@/lib/pending-user-input-requests"

// M11: route catches through the shared logger.
const log = createLogger("pending-questions-panel")

// Re-export for existing importers/tests; the implementation lives in the
// shared lib so the attention system uses the same pairing rules.
export { derivePendingProviderUserInputs }
export type { PanelQuestion, PendingProviderUserInput }

function answerToText(answer: string | string[] | null | undefined): string {
  if (Array.isArray(answer)) return answer.join(", ")
  return answer ?? ""
}

/**
 * Step-by-step panel for answering either provider-native `user_input`
 * requests or the batch of questions parsed from the latest assistant
 * message.
 *
 * Unlike `<QuestionCard>`, which renders each question inline in the
 * transcript, this panel sits directly above the chat input and walks
 * through all unanswered questions one at a time — the user picks or types
 * an answer, hits Next, and on the last step Submit sends all answers back
 * to the model in a single turn. Empty answers fall back to the first
 * option so a submission never leaves the assistant blocked.
 *
 * Dismissing the panel hides only the current request/message batch; a later
 * provider request or assistant question set opens a fresh panel.
 */
export function PendingQuestionsPanel({
  threadId,
  selectedModel,
  thinkingMode,
  selectedProvider,
  chatMode,
  specialMode,
  permissionLevel,
  contextWindow,
}: {
  threadId: string | null
  selectedModel: string
  thinkingMode: string | null
  selectedProvider?: {
    id: string
    providerKind?: string
    providerInstanceId?: string
    openaiTransport?: OpenAiTransport
  }
  chatMode: string
  specialMode: string | null
  permissionLevel: string
  contextWindow?: string | null
}) {
  const threads = useChatStore((s) => s.threads)
  const activities = useThreadActivities(threadId)
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({})
  const [dismissedBatchId, setDismissedBatchId] = useState<string | null>(null)

  // Find unanswered questions from the last assistant message
  const thread = threads.find((t) => t.id === threadId)
  const lastAssistant = thread?.messages
    ?.filter((m) => m.role === "assistant")
    .pop()
  const assistantQuestions = useMemo(
    () =>
      (lastAssistant?.questions?.filter((q) => !q.answer) ?? [])
        .map((question, index) => normalizeProviderQuestion(question, index))
        .filter((question): question is PanelQuestion => question !== null),
    [lastAssistant?.questions]
  )
  const pendingProviderInput = useMemo(() => {
    const pending = derivePendingProviderUserInputs(activities)
    return pending[pending.length - 1]
  }, [activities])
  const questions = pendingProviderInput?.questions ?? assistantQuestions
  const questionBatchId = pendingProviderInput
    ? `provider:${threadId}:${pendingProviderInput.requestId}`
    : lastAssistant
      ? `assistant:${lastAssistant.id}:${questions.map((q) => q.id).join("|")}`
      : "none"

  useEffect(() => {
    if (currentStep >= questions.length) setCurrentStep(0)
  }, [currentStep, questions.length])

  useEffect(() => {
    setAnswers({})
    setCurrentStep(0)
  }, [questionBatchId])

  if (dismissedBatchId === questionBatchId || questions.length === 0)
    return null

  const progress = derivePendingUserInputProgress(
    questions,
    answers,
    currentStep
  )
  const current = progress.activeQuestion ?? questions[0]
  if (!current) return null

  const handleSelect = (label: string) => {
    setAnswers((prev) => ({
      ...prev,
      [current.id]: togglePendingUserInputOptionSelection(
        current,
        prev[current.id],
        label
      ),
    }))
  }

  const handleSubmitAll = async () => {
    const completedAnswers = buildPendingUserInputAnswers(questions, answers)
    if (!completedAnswers) {
      setCurrentStep(
        findFirstUnansweredPendingUserInputQuestionIndex(questions, answers)
      )
      return
    }

    setDismissedBatchId(questionBatchId) // Hide panel immediately
    const answeredPairs: { question: string; answer: string }[] = []
    const structuredAnswers: Record<string, unknown> = completedAnswers

    for (const q of questions) {
      const answer = completedAnswers[q.id]
      const displayAnswer = answerToText(answer) || "skipped"
      if (!pendingProviderInput && threadId) {
        useChatStore.getState().answerQuestion(threadId, q.id, displayAnswer)
      }
      answeredPairs.push({ question: q.text, answer: displayAnswer })
    }

    if (threadId && pendingProviderInput && answeredPairs.length > 0) {
      try {
        const response = await respondToUserInput(
          threadId,
          pendingProviderInput.providerKind,
          pendingProviderInput.requestId,
          structuredAnswers,
          pendingProviderInput.providerInstanceId ??
            selectedProvider?.providerInstanceId ??
            null
        )
        if (response.status === "failed") {
          const detail = response.error ?? "Provider user input response failed"
          const providerInstanceId =
            pendingProviderInput.providerInstanceId ??
            selectedProvider?.providerInstanceId ??
            null
          useChatStore.getState().upsertThreadActivity(threadId, {
            id: `${threadId}::provider.user-input.respond.failed::${pendingProviderInput.requestId}`,
            threadId,
            providerInstanceId,
            kind: "provider.user-input.respond.failed",
            tone: "error",
            summary: "Provider user input response failed",
            payload: {
              providerKind: pendingProviderInput.providerKind,
              providerInstanceId,
              requestId: pendingProviderInput.requestId,
              detail,
            },
            sequence: Date.now() * 1000,
            createdAt: new Date().toISOString(),
          })
          if (!isStalePendingRequestFailureDetail(detail)) {
            setDismissedBatchId(null)
          }
          return
        }
        const providerInstanceId =
          pendingProviderInput.providerInstanceId ??
          selectedProvider?.providerInstanceId ??
          null
        useChatStore.getState().upsertThreadActivity(threadId, {
          id: `${threadId}::user-input.resolved::${pendingProviderInput.requestId}`,
          threadId,
          providerInstanceId,
          kind: "user-input.resolved",
          tone: "info",
          summary: "User input answered",
          payload: {
            providerKind: pendingProviderInput.providerKind,
            providerInstanceId,
            requestId: pendingProviderInput.requestId,
            decision: "answer",
            answers: structuredAnswers,
          },
          sequence: Number.MAX_SAFE_INTEGER,
          createdAt: new Date().toISOString(),
        })
      } catch (e) {
        setDismissedBatchId(null)
        log.warn("Failed to submit provider user input", e)
        return
      }
    } else if (threadId && answeredPairs.length > 0) {
      // Build a clean answer string for the AI
      const answerText = answeredPairs
        .map((p) => `${p.question} ${p.answer}`)
        .join("\n")

      // Add as user message with answeredQuestions metadata for display
      const dispatchUserMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: `Answered ${answeredPairs.length} question${answeredPairs.length > 1 ? "s" : ""}`,
        answeredQuestions: answeredPairs,
        createdAt: new Date().toISOString(),
      } as const
      useChatStore.getState().addMessage(threadId, dispatchUserMessage)

      // Send the actual answers to the AI
      useChatStore.getState().appendStreamDelta(threadId, "")
      resolveProviderTarget(selectedProvider, selectedModel)
        .then((target) =>
          sendChatMessage(
            threadId,
            answerText,
            selectedModel,
            target.providerKind,
            coerceThinkingModeForModel(
              selectedProvider,
              selectedModel,
              thinkingMode
            ),
            chatMode,
            thread?.projectPath || null,
            specialMode,
            permissionLevel,
            target.openaiTransport,
            null,
            target.providerInstanceId,
            contextWindow,
            null,
            dispatchUserMessage
          )
        )
        .catch((e) => {
          log.warn("Failed to submit pending question answers", e)
        })
    }

    setAnswers({})
    setCurrentStep(0)
  }

  const handleNext = () => {
    if (!progress.canAdvance) return
    if (progress.questionIndex < questions.length - 1) {
      setCurrentStep((s) => s + 1)
    }
  }

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1)
    }
  }

  // Abort the whole question batch — clears streaming state + strips the
  // questions from the assistant message so this panel won't re-open. No
  // follow-up turn is sent to the model.
  const handleAbort = () => {
    if (!pendingProviderInput && threadId) {
      useChatStore.getState().dismissPendingQuestions(threadId)
    }
    setAnswers({})
    setCurrentStep(0)
    setDismissedBatchId(questionBatchId)
  }

  const selectedForCurrent = progress.selectedOptionLabels

  return (
    <div className="mb-3 overflow-hidden rounded-2xl border border-border/50 bg-sidebar">
      {/* Step indicator */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {currentStep + 1}/{questions.length}
          </span>
          <Separator orientation="vertical" className="h-3" />
          <span className="text-[10px] font-medium tracking-wider text-primary uppercase">
            Question
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setCurrentStep(i)}
                className={cn(
                  "size-1.5 rounded-full transition-colors",
                  i === currentStep
                    ? "bg-primary"
                    : resolvePendingUserInputAnswer(
                          questions[i],
                          answers[questions[i].id]
                        )
                      ? "bg-primary/40"
                      : "bg-muted-foreground/30"
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={handleAbort}
            aria-label="Dismiss questions"
            title="Dismiss questions"
            className="ml-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Question */}
      <div className="px-4 py-3">
        <p className="text-sm font-medium">{current.text}</p>
      </div>

      {/* Options */}
      <div className="px-2 pb-2">
        {current.options.map((opt, i) => {
          const isSelected = selectedForCurrent.includes(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => handleSelect(opt.label)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                isSelected
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded font-mono text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className={cn(isSelected && "font-semibold")}>
                {opt.label}
              </span>
              {isSelected && (
                <CheckIcon className="ml-auto size-4 text-primary" />
              )}
            </button>
          )
        })}
      </div>

      {/* Custom input + navigation */}
      <div className="border-t border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={progress.customAnswer}
            onChange={(e) => {
              setAnswers((prev) => ({
                ...prev,
                [current.id]: setPendingUserInputCustomAnswer(
                  prev[current.id],
                  e.target.value
                ),
              }))
            }}
            placeholder="Type your own answer..."
            className="flex-1 rounded-lg border-0 bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground/40 focus:outline-none"
          />
          {currentStep > 0 && (
            <Button variant="ghost" size="xs" onClick={handlePrev}>
              Back
            </Button>
          )}
          {currentStep < questions.length - 1 ? (
            <Button
              variant="outline"
              size="xs"
              disabled={!progress.canAdvance}
              onClick={handleNext}
            >
              Next
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={!progress.isComplete}
              onClick={handleSubmitAll}
            >
              Submit answers
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
