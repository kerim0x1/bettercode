import type { ChatThread } from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import {
  buildThreadShareMarkdown,
  markThreadShared,
  type ThreadShareRecord,
} from "@/lib/thread-share"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
import { listProjectConfigSettings } from "@/services/backend/workspaceApi"

const autoShareInFlight = new Set<string>()

export async function maybeMarkBetterC0deAutoShare(
  threadId: string
): Promise<ThreadShareRecord | null> {
  if (autoShareInFlight.has(threadId)) return null
  autoShareInFlight.add(threadId)
  try {
    const store = useChatStore.getState()
    await store.ensureFullThreadMessages(threadId)
    const thread = useChatStore
      .getState()
      .threads.find((candidate) => candidate.id === threadId)
    if (!thread) return null
    return await markBetterC0deAutoShareForThread(thread)
  } catch {
    return null
  } finally {
    autoShareInFlight.delete(threadId)
  }
}

export async function markBetterC0deAutoShareForThread(
  thread: ChatThread,
  loadSettings: typeof listProjectConfigSettings = listProjectConfigSettings
): Promise<ThreadShareRecord | null> {
  const runtimePath = resolveThreadRuntimePath(thread)
  if (!runtimePath) return null
  const settings = await loadSettings(runtimePath)
  if (betterC0deShareModeFromProjectSettings(settings) !== "auto") return null
  if (!hasShareableThreadContent(thread)) return null

  const transcript = buildThreadShareMarkdown(thread)
  return markThreadShared({
    threadId: thread.id,
    title: thread.title,
    messageCount: thread.messages.length,
    transcript,
  })
}

function hasShareableThreadContent(thread: ChatThread): boolean {
  return thread.messages.some(
    (message) =>
      message.content.trim() ||
      message.reasoning?.trim() ||
      message.toolCalls?.length ||
      message.diffs?.length
  )
}
