import { buildClaudeTerminalCompactionTranscript } from "@/lib/claude-terminal-history"
import { activeContextMessages } from "@/lib/chat-context"
import { useChatStore } from "@/lib/chat-store"
import { buildNativeThreadCompacterSelection } from "@/lib/native-compacter-selection"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type { UiProvider } from "@/lib/provider-types"
import {
  generateThreadContextSummary,
  rotateProviderSession,
} from "@/services/backend/chatApi"

export async function buildThreadCompactionOutput(input: {
  threadId: string | null
  selectedProvider: UiProvider | undefined
  selectedModel: string
  thinkingMode: string | null
  command: { messageId: string; content: string; createdAt: string }
  trigger?: "manual" | "automatic"
  autoCompactionPrecondition?: {
    compactionGeneration: number
    lastMessageId: string | null
  } | null
}): Promise<{
  content: string
  messageId?: string
  createdAt?: string
  generation?: number
}> {
  const { threadId, selectedProvider, selectedModel, thinkingMode, command } =
    input
  if (!threadId) {
    return { content: "# Compact Session\n\n> No active chat to compact yet." }
  }

  const store = useChatStore.getState()
  await store.ensureFullThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return {
      content: "# Compact Session\n\n> The active chat could not be found.",
    }
  }

  const transcript = buildClaudeTerminalCompactionTranscript({
    threadTitle: thread.title,
    projectPath: thread.projectPath || thread.worktreePath,
    messages: activeContextMessages(thread.messages).messages,
  })
  if (!transcript) {
    return {
      content:
        "# Compact Session\n\n> This chat has no useful context to compact yet.",
    }
  }

  try {
    const result = await generateThreadContextSummary({
      cwd: resolveThreadRuntimePath(thread),
      threadTitle: thread.title,
      projectPath: thread.projectPath || thread.worktreePath,
      transcript,
      modelSelection: buildNativeThreadCompacterSelection({
        provider: selectedProvider,
        selectedModel,
        thinkingMode,
      }),
    })
    const summary = result.summary.trim()
    if (!summary) {
      return {
        content:
          "# Compact Session\n\n> The compacter returned an empty summary.",
      }
    }
    const messageId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const content = [
      "# Compacted Session Context\n",
      input.trigger === "automatic"
        ? "The current chat was automatically summarized before the next turn reached the configured context limit."
        : "The current chat was summarized for handoff, resume, or continuing in another provider.",
      "Native provider continuity will begin from this durable checkpoint.",
      "",
      "---",
      "",
      summary,
    ].join("\n")
    const sessionRotation = await rotateProviderSession(threadId, {
      messageId,
      content,
      createdAt,
      commandMessageId: command.messageId,
      commandContent: command.content,
      commandCreatedAt: command.createdAt,
      autoCompactionPrecondition: input.autoCompactionPrecondition ?? null,
    })
    return {
      content,
      messageId: sessionRotation.messageId,
      createdAt,
      generation: sessionRotation.generation ?? undefined,
    }
  } catch (error) {
    return {
      content: [
        "# Compact Session\n",
        "> Failed to compact this chat.",
        "",
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    }
  }
}
