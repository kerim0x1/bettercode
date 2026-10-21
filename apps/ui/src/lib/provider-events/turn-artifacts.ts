/**
 * Durable products of a turn: the completed assistant message item,
 * proposed plans, streaming diff summaries and captured checkpoints.
 */

import { asRecord, readString } from "@betterc0de/schema"
import { useChatStore, emptyStreamState } from "@/lib/chat-store"
import { useCheckpointStore } from "@/lib/checkpoint-store"
import { extractProposedPlanMarkdown } from "@/lib/plan-content"
import {
  parseTurnDiffFilesFromUnifiedDiff,
  type TurnDiffFileSummary,
} from "@betterc0de/schema/checkpointing"
import { activityFromProviderEvent } from "./activities"
import { clearContentPlanCapture } from "./delta-coalescing"
import {
  payloadTurnId,
  backendOwnedFinalizeOptions,
  payloadNumber,
} from "./payload"

export function isAssistantMessageItem(
  payload: Record<string, unknown>
): boolean {
  const itemType = readString(payload, "itemType", "item_type", "kind")
  const role = readString(payload, "role")
  const normalizedItemType = (itemType ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return (
    normalizedItemType === "assistantmessage" ||
    normalizedItemType === "agentmessage" ||
    normalizedItemType === "assistant" ||
    role === "assistant"
  )
}

function assistantMessageItemText(
  payload: Record<string, unknown>
): string | undefined {
  const data = asRecord(payload.data)
  const output = asRecord(payload.output)
  const result = asRecord(payload.result)
  return (
    readString(payload, "text", "content", "detail", "message") ??
    readString(data, "text", "content", "detail", "message") ??
    readString(output, "text", "content", "detail", "message") ??
    readString(result, "text", "content", "detail", "message")
  )
}

export function completeAssistantMessageItem(
  threadId: string,
  payload: Record<string, unknown>
) {
  const store = useChatStore.getState()
  const turnId = payloadTurnId(payload)
  if (turnId) store.setActiveTurnId(threadId, turnId)

  const stream = useChatStore.getState().streamingByThread[threadId]
  const text = assistantMessageItemText(payload)
  if (
    text &&
    (!stream || (!stream.isPlanStreaming && stream.streamingText.length === 0))
  ) {
    store.appendStreamDelta(threadId, text)
  }

  const latest = useChatStore.getState().streamingByThread[threadId]
  if (!latest || latest.isPlanStreaming) return
  if (
    latest.streamingText.trim().length === 0 &&
    latest.reasoningText.trim().length === 0 &&
    latest.streamingTools.length === 0 &&
    latest.streamingTasks.length === 0 &&
    latest.streamingDiffs.length === 0
  ) {
    clearContentPlanCapture(threadId)
    return
  }
  clearContentPlanCapture(threadId)
  useChatStore.getState().finalizeStream(threadId, {
    ...backendOwnedFinalizeOptions(threadId, turnId ?? latest.activeTurnId),
    // An assistant item can be commentary before more tools. Only the
    // terminal turn event releases the composer and autonomous loop.
    keepTurnActive: true,
  })
}

export function planMarkdownFromContent(text: string): string {
  return extractProposedPlanMarkdown(text) ?? text
}

export function upsertProposedPlanActivity(
  threadId: string,
  payload: Record<string, unknown>
) {
  const activity = activityFromProviderEvent(
    threadId,
    "turn.proposed.completed",
    payload
  )
  if (activity) {
    useChatStore.getState().upsertThreadActivity(threadId, activity)
  }
}

export function turnDiffSummariesFromPayload(
  payload: Record<string, unknown>
): TurnDiffFileSummary[] {
  if (Array.isArray(payload.files)) {
    return payload.files.flatMap((entry) => {
      const file = asRecord(entry)
      const path = readString(file, "path")
      const additions = payloadNumber(file, "additions") ?? 0
      const deletions = payloadNumber(file, "deletions") ?? 0
      return path ? [{ path, additions, deletions }] : []
    })
  }

  const unifiedDiff = readString(payload, "unifiedDiff", "unified_diff", "diff")
  return unifiedDiff ? [...parseTurnDiffFilesFromUnifiedDiff(unifiedDiff)] : []
}

function mergeTurnDiffSummaries<
  T extends {
    path: string
    additions: number
    deletions: number
    oldText: string
    newText: string
    isNew: boolean
  },
>(existingDiffs: T[], summaries: TurnDiffFileSummary[]): T[] {
  const byPath = new Map(existingDiffs.map((diff) => [diff.path, { ...diff }]))

  for (const summary of summaries) {
    const existing = byPath.get(summary.path)
    byPath.set(summary.path, {
      path: summary.path,
      additions: summary.additions,
      deletions: summary.deletions,
      oldText: existing?.oldText ?? "",
      newText: existing?.newText ?? "",
      isNew: existing?.isNew ?? false,
    } as T)
  }

  return [...byPath.values()]
}

export function upsertStreamingDiffSummaries(
  threadId: string,
  summaries: TurnDiffFileSummary[]
) {
  if (summaries.length === 0) return
  useChatStore.setState((state) => {
    const cur = state.streamingByThread[threadId]
    if (cur) {
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: true,
            streamingDiffs: mergeTurnDiffSummaries(
              cur.streamingDiffs,
              summaries
            ),
          },
        },
      }
    }

    let updated = false
    const threads = state.threads.map((thread) => {
      if (thread.id !== threadId || !thread.messages.length) return thread
      const messages = [...thread.messages]
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.role !== "assistant") continue
        messages[index] = {
          ...message,
          diffs: mergeTurnDiffSummaries(message.diffs ?? [], summaries),
        }
        updated = true
        break
      }
      return updated ? { ...thread, messages } : thread
    })

    if (updated) return { threads }

    return {
      streamingByThread: {
        ...state.streamingByThread,
        [threadId]: {
          ...emptyStreamState,
          isStreaming: true,
          streamingDiffs: mergeTurnDiffSummaries([], summaries),
        },
      },
    }
  })
}

function latestAssistantMessageIdForCheckpoint(
  threadId: string,
  turnId: string | null
): string | null {
  const thread = useChatStore
    .getState()
    .threads.find((item) => item.id === threadId)
  const assistants = [...(thread?.messages ?? [])]
    .reverse()
    .filter((message) => message.role === "assistant")
  return (
    assistants.find((message) => turnId && message.turnId === turnId)?.id ??
    assistants[0]?.id ??
    null
  )
}

export function recordCapturedCheckpoint(
  threadId: string,
  payload: Record<string, unknown>
) {
  const checkpointRef = readString(payload, "checkpointRef", "checkpoint_ref")
  if (!checkpointRef) return
  const thread = useChatStore
    .getState()
    .threads.find((item) => item.id === threadId)
  const projectPath = thread?.projectPath
  if (!projectPath) return
  const turnId = payloadTurnId(payload) ?? null
  const messageId = latestAssistantMessageIdForCheckpoint(threadId, turnId)
  if (!messageId) return
  const unifiedDiff = readString(payload, "unifiedDiff", "unified_diff", "diff")

  useCheckpointStore.getState().recordGitCheckpoint({
    threadId,
    messageId,
    projectPath,
    checkpointRef,
    baseCheckpointRef: readString(
      payload,
      "baseCheckpointRef",
      "base_checkpoint_ref"
    ),
    turnId,
    turnNumber: payloadNumber(payload, "turn_index", "turnIndex"),
    label: "After assistant turn",
    diff: unifiedDiff,
    diffFiles: turnDiffSummariesFromPayload(payload),
  })
}
