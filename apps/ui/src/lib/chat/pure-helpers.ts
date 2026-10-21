import type { ChatThread } from "@betterc0de/schema"
import { LRU_CAPACITY, type ThreadStreamState } from "./types"

export function generateId(): string {
  return crypto.randomUUID()
}

/** Keep lightweight model metadata when the transcript is evicted. */
export function lastRecordedModelId(
  thread: Pick<ChatThread, "messages" | "lastModelId">
): string | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]!
    if (message.role === "assistant" && message.modelId?.trim())
      return message.modelId.trim()
  }
  return thread.lastModelId?.trim() || undefined
}

/**
 * Module-local dedupe map for in-flight hydrations. Lives outside zustand
 * state because storing a Promise in state would trigger needless renders
 * and because subscribers don't care about in-flight status — only the
 * eventual `messagesLoadedByThread` flip.
 */
export const hydrationInFlight = new Map<string, Promise<void>>()

/** Per-thread debounce timers for persistThread. */
export const metaSaveTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

/** Promote `threadId` to LRU front and evict anything past LRU_CAPACITY.
 *  Streaming threads and pinned threads (visible split-mode columns) are
 *  never evicted — dropping their messages mid-render crashes the UI. */
export function applyLru(
  state: {
    lruOrder: string[]
    threads: ChatThread[]
    messagesLoadedByThread: Record<string, boolean>
    streamingByThread: Record<string, ThreadStreamState>
    pinnedThreadIds: Set<string>
  },
  touchId: string
): {
  lruOrder: string[]
  threads: ChatThread[]
  messagesLoadedByThread: Record<string, boolean>
} {
  const nextOrder = [touchId, ...state.lruOrder.filter((x) => x !== touchId)]
  if (nextOrder.length <= LRU_CAPACITY) {
    return {
      lruOrder: nextOrder,
      threads: state.threads,
      messagesLoadedByThread: state.messagesLoadedByThread,
    }
  }
  // Beyond cap — identify eviction candidates, skipping streaming + pinned.
  const overflow = nextOrder.slice(LRU_CAPACITY)
  const evictable = overflow.filter(
    (id) =>
      !state.streamingByThread[id]?.isStreaming &&
      !state.pinnedThreadIds.has(id)
  )
  if (evictable.length === 0) {
    return {
      lruOrder: nextOrder,
      threads: state.threads,
      messagesLoadedByThread: state.messagesLoadedByThread,
    }
  }
  const evictSet = new Set(evictable)
  const keptOrder = nextOrder.filter((id) => !evictSet.has(id))
  const nextLoaded = { ...state.messagesLoadedByThread }
  for (const id of evictable) nextLoaded[id] = false
  return {
    lruOrder: keptOrder,
    messagesLoadedByThread: nextLoaded,
    threads: state.threads.map((t) =>
      evictSet.has(t.id)
        ? { ...t, lastModelId: lastRecordedModelId(t), messages: [] }
        : t
    ),
  }
}
