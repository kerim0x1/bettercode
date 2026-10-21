import type { TokenUsage } from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import { createLogger } from "@/lib/logger"
import { buildThreadCompactionOutput } from "@/lib/thread-compaction"
import type { UiProvider } from "@/lib/provider-types"
import { getAutoCompactionDecision } from "@/services/backend/chatApi"

const log = createLogger("auto-thread-compaction")

export interface AutomaticThreadCompactionInput {
  readonly threadId: string
  readonly incomingContent: string
  readonly runtimePath?: string | null
  readonly selectedProvider: UiProvider | undefined
  readonly selectedModel: string
  readonly thinkingMode: string | null
}

export interface AutomaticThreadCompactionResult {
  readonly compacted: boolean
  readonly reason: string
  readonly generation?: number
}

const inFlightByThread = new Map<
  string,
  Promise<AutomaticThreadCompactionResult>
>()

/**
 * Best-effort pre-turn compaction. The backend owns the decision; this helper
 * only invokes the already-bounded summary + atomic session-rotation flow.
 * Failures never recursively submit a turn and never swallow the user's
 * original prompt.
 */
export async function compactThreadAutomaticallyBeforeTurn(
  input: AutomaticThreadCompactionInput
): Promise<AutomaticThreadCompactionResult> {
  const existing = inFlightByThread.get(input.threadId)
  if (existing) return existing

  const operation = runAutomaticCompaction(input)
  inFlightByThread.set(input.threadId, operation)
  try {
    return await operation
  } finally {
    if (inFlightByThread.get(input.threadId) === operation) {
      inFlightByThread.delete(input.threadId)
    }
  }
}

async function runAutomaticCompaction(
  input: AutomaticThreadCompactionInput
): Promise<AutomaticThreadCompactionResult> {
  try {
    const store = useChatStore.getState()
    await store.hydrateThreadMessages(input.threadId)
    const thread = useChatStore
      .getState()
      .threads.find((candidate) => candidate.id === input.threadId)
    if (!thread) return { compacted: false, reason: "thread-unavailable" }

    const decision = await getAutoCompactionDecision({
      threadId: input.threadId,
      cwd: input.runtimePath ?? null,
      incomingContent: input.incomingContent,
      usage: compactionUsage(thread.usage),
      modelLimits: selectedModelLimits(
        input.selectedProvider,
        input.selectedModel
      ),
    })
    if (!decision.shouldCompact) {
      return { compacted: false, reason: decision.reason }
    }

    const command = {
      messageId: crypto.randomUUID(),
      content: "/compact --automatic",
      createdAt: new Date().toISOString(),
    }
    const compacted = await buildThreadCompactionOutput({
      threadId: input.threadId,
      selectedProvider: input.selectedProvider,
      selectedModel: input.selectedModel,
      thinkingMode: input.thinkingMode,
      command,
      trigger: "automatic",
      autoCompactionPrecondition: decision.precondition,
    })
    if (
      !compacted.messageId ||
      !compacted.createdAt ||
      compacted.generation === undefined
    ) {
      log.debug("automatic compaction did not commit", {
        threadId: input.threadId,
      })
      return { compacted: false, reason: "compaction-not-committed" }
    }

    const currentStore = useChatStore.getState()
    currentStore.addMessage(
      input.threadId,
      {
        id: command.messageId,
        role: "user",
        content: command.content,
        createdAt: command.createdAt,
      },
      { persist: false }
    )
    currentStore.addMessage(
      input.threadId,
      {
        id: compacted.messageId,
        role: "assistant",
        content: compacted.content,
        compactedContext: true,
        compactionGeneration: compacted.generation,
        createdAt: compacted.createdAt,
      },
      { persist: false }
    )
    return {
      compacted: true,
      reason: decision.reason,
      generation: compacted.generation,
    }
  } catch (error) {
    // The original turn remains authoritative. A racing turn or stale
    // decision is expected to fail here and then continue through normal send.
    log.debug("automatic compaction skipped", error)
    return { compacted: false, reason: "compaction-error" }
  }
}

function compactionUsage(usage: TokenUsage | null | undefined): {
  usedTokens?: number
  maxTokens?: number
  compactsAutomatically?: boolean
} | null {
  if (!usage) return null
  const usedTokens =
    nonnegativeInteger(usage.usedTokens) ??
    nonnegativeInteger(usage.totalTokens) ??
    nonnegativeInteger(usage.inputTokens)
  const maxTokens = positiveInteger(usage.maxTokens)
  const compactsAutomatically =
    typeof usage.compactsAutomatically === "boolean"
      ? usage.compactsAutomatically
      : undefined
  if (
    usedTokens === undefined &&
    maxTokens === undefined &&
    compactsAutomatically === undefined
  ) {
    return null
  }
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
  }
}

export function selectedModelLimits(
  provider: UiProvider | undefined,
  selectedModel: string
): {
  contextTokens?: number
  inputTokens?: number
  outputTokens?: number
} | null {
  const model = provider?.models.find(
    (candidate) => candidate.id === selectedModel
  )
  if (!model) return null
  const contextTokens =
    positiveInteger(model.catalog?.limit?.context) ??
    parseContextTokenLabel(model.context)
  const inputTokens = positiveInteger(model.catalog?.limit?.input)
  const outputTokens = positiveInteger(model.catalog?.limit?.output)
  if (
    contextTokens === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined
  ) {
    return null
  }
  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  }
}

export function parseContextTokenLabel(
  value: string | null | undefined
): number | undefined {
  const normalized = (value ?? "")
    .trim()
    .replaceAll(",", "")
    .replaceAll("_", "")
    .toUpperCase()
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMG])?$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier =
    match[2] === "G"
      ? 1_000_000_000
      : match[2] === "M"
        ? 1_000_000
        : match[2] === "K"
          ? 1_000
          : 1
  const tokens = Math.floor(amount * multiplier)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

function nonnegativeInteger(
  value: number | null | undefined
): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function positiveInteger(value: number | null | undefined): number | undefined {
  const integer = nonnegativeInteger(value)
  return integer !== undefined && integer > 0 ? integer : undefined
}
