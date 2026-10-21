import { useCallback, useState } from "react"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useChatStore, type ChatQuestion } from "@/lib/chat-store"
import { sendChatMessage } from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import type { OpenAiTransport } from "@/lib/provider-types"
import { createLogger } from "@/lib/logger"

const log = createLogger("question-card") // M11

// Mirrors `<PendingQuestionsPanel>`'s prop shape so both question UIs forward
// the same turn context to `sendChatMessage`. Passing `undefined` here would
// drop `permissionLevel` / `chatMode` / `specialMode` and force the backend
// to fall back to its silent-permissive default (normalizeLevel → allow-edits
// with no prompt text), making follow-up answers look like ASK-mode replies.

/**
 * Interactive card rendered in the chat when the assistant asks a
 * multiple-choice question.
 *
 * The user picks an option (or types a free-form answer) and clicks Submit;
 * we persist the answer on the question, echo it back as a user message,
 * and kick off a new streaming turn so the assistant can continue.
 *
 * Once answered, the card collapses into a read-only summary. The `selected`
 * highlight and the `customAnswer` input are mutually exclusive — typing a
 * custom answer clears the selection, and vice versa.
 */
export function QuestionCard({
  question,
  threadId,
  selectedModel,
  thinkingMode,
  selectedProvider,
  chatMode,
  specialMode,
  permissionLevel,
  projectPath,
}: {
  question: ChatQuestion
  threadId: string
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
  projectPath?: string | null
}) {
  const [customAnswer, setCustomAnswer] = useState("")
  const isAnswered = !!question.answer
  const [selected, setSelected] = useState<string | null>(null)

  const handleSubmit = useCallback(
    (answer: string) => {
      useChatStore.getState().answerQuestion(threadId, question.id, answer)
      const dispatchUserMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: answer,
        createdAt: new Date().toISOString(),
      } as const
      useChatStore.getState().addMessage(threadId, dispatchUserMessage)
      useChatStore.getState().appendStreamDelta(threadId, "")
      resolveProviderTarget(selectedProvider, selectedModel)
        .then((target) =>
          sendChatMessage(
            threadId,
            answer,
            selectedModel,
            target.providerKind,
            coerceThinkingModeForModel(
              selectedProvider,
              selectedModel,
              thinkingMode
            ),
            chatMode,
            projectPath ?? null,
            specialMode,
            permissionLevel,
            target.openaiTransport,
            null,
            target.providerInstanceId,
            null,
            null,
            dispatchUserMessage
          )
        )
        .catch((e) => {
          log.warn("Failed to send question answer to AI", e)
        })
    },
    [
      question.id,
      threadId,
      selectedModel,
      thinkingMode,
      selectedProvider,
      chatMode,
      specialMode,
      permissionLevel,
      projectPath,
    ]
  )

  if (isAnswered) {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <p className="text-xs text-muted-foreground">{question.text}</p>
        <p className="mt-1 text-sm font-medium">{question.answer}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/50">
      {/* Header */}
      <div className="border-b border-border/50 px-4 py-3">
        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Question
        </p>
        <p className="mt-1 text-sm font-medium">{question.text}</p>
      </div>

      {/* Options */}
      <div className="divide-y divide-border/30">
        {question.options.map((opt, i) => (
          <button
            key={opt.label}
            type="button"
            onClick={() => setSelected(opt.label)}
            className={cn(
              "flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors",
              selected === opt.label ? "bg-primary/10" : "hover:bg-muted/50"
            )}
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded font-mono text-xs text-muted-foreground">
              {i + 1}
            </span>
            <span
              className={cn(
                "text-sm",
                selected === opt.label ? "font-semibold" : "font-medium"
              )}
            >
              {opt.label}
            </span>
            {selected === opt.label && (
              <CheckIcon className="mt-0.5 ml-auto size-4 shrink-0 text-primary" />
            )}
          </button>
        ))}
      </div>

      {/* Custom answer + Submit */}
      <div className="border-t border-border/50 px-4 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={customAnswer}
            onChange={(e) => {
              setCustomAnswer(e.target.value)
              setSelected(null)
            }}
            placeholder="Type your own answer, or leave blank to use selected"
            className="flex-1 rounded-lg border border-border/50 bg-transparent px-3 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none"
          />
          <Button
            size="sm"
            disabled={!selected && !customAnswer.trim()}
            onClick={() => handleSubmit(customAnswer.trim() || selected || "")}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  )
}
