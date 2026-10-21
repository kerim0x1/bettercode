import type { ChatThread, ThreadActivity } from "@betterc0de/schema"
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

/** The slice of chat-store state the LRU reads and rewrites. */
export interface LruState {
  lruOrder: string[]
  threads: ChatThread[]
  activeThreadId?: string | null
  messagesLoadedByThread: Record<string, boolean>
  activitiesByThread: Record<string, ThreadActivity[]>
  activitiesLoadedByThread: Record<string, boolean>
  olderMessagesCursorByThread: Record<string, number>
  streamingByThread: Record<string, ThreadStreamState>
  pinnedThreadIds: Set<string>
}

export type LruResult = Pick<
  LruState,
  | "lruOrder"
  | "threads"
  | "messagesLoadedByThread"
  | "activitiesByThread"
  | "activitiesLoadedByThread"
  | "olderMessagesCursorByThread"
>

export interface LruOptions {
  /**
   * Extra veto for threads whose resident state must survive, for example a
   * thread whose activities still hold an unanswered approval: dropping them
   * would also drop the sidebar's attention badge.
   */
  readonly keepResident?: (threadId: string) => boolean
}

/** Threads that currently hold a transcript or activities in memory. */
function residentThreadIds(state: LruState): string[] {
  const resident: string[] = []
  for (const thread of state.threads) {
    if (
      state.messagesLoadedByThread[thread.id] ||
      state.activitiesLoadedByThread[thread.id] ||
      state.activitiesByThread[thread.id] !== undefined
    ) {
      resident.push(thread.id)
    }
  }
  return resident
}

function isProtectedFromEviction(
  state: LruState,
  threadId: string,
  touchId: string,
  options: LruOptions
): boolean {
  if (threadId === touchId || threadId === state.activeThreadId) return true
  if (state.streamingByThread[threadId]?.isStreaming) return true
  if (state.pinnedThreadIds.has(threadId)) return true
  // A turn the backend still runs (started on the phone, or resumed after a
  // reconnect) keeps writing into this thread's transcript and activities.
  const thread = state.threads.find((item) => item.id === threadId)
  if (thread?.session?.activeTurnId) return true
  return options.keepResident?.(threadId) === true
}

/** Promote `threadId` to LRU front and evict anything past LRU_CAPACITY.
 *
 *  Every thread that holds messages or activities counts against the
 *  budget, including threads that were never opened directly (neighbours
 *  prefetched by `setActiveThread`, background reads). Those join the cold
 *  end of the order. Eviction drops the transcript, the activity log and the
 *  older-page cursor together; reopening the thread hydrates them again.
 *
 *  The active thread, streaming threads, threads with a running backend turn
 *  and pinned threads (visible split-mode columns) are never evicted —
 *  dropping their messages mid-render crashes the UI. */
export function applyLru(
  state: LruState,
  touchId: string,
  options: LruOptions = {}
): LruResult {
  const touched = [touchId, ...state.lruOrder.filter((x) => x !== touchId)]
  const ordered = new Set(touched)
  const nextOrder = [
    ...touched,
    ...residentThreadIds(state).filter((id) => !ordered.has(id)),
  ]
  const unchanged: LruResult = {
    lruOrder: nextOrder,
    threads: state.threads,
    messagesLoadedByThread: state.messagesLoadedByThread,
    activitiesByThread: state.activitiesByThread,
    activitiesLoadedByThread: state.activitiesLoadedByThread,
    olderMessagesCursorByThread: state.olderMessagesCursorByThread,
  }
  if (nextOrder.length <= LRU_CAPACITY) return unchanged

  // Beyond cap — identify eviction candidates, skipping protected threads.
  const evictable = nextOrder
    .slice(LRU_CAPACITY)
    .filter((id) => !isProtectedFromEviction(state, id, touchId, options))
  if (evictable.length === 0) return unchanged

  const evictSet = new Set(evictable)
  const nextLoaded = { ...state.messagesLoadedByThread }
  const nextActivities = { ...state.activitiesByThread }
  const nextActivitiesLoaded = { ...state.activitiesLoadedByThread }
  const nextCursors = { ...state.olderMessagesCursorByThread }
  for (const id of evictable) {
    nextLoaded[id] = false
    delete nextActivities[id]
    delete nextActivitiesLoaded[id]
    delete nextCursors[id]
  }
  return {
    lruOrder: nextOrder.filter((id) => !evictSet.has(id)),
    messagesLoadedByThread: nextLoaded,
    activitiesByThread: nextActivities,
    activitiesLoadedByThread: nextActivitiesLoaded,
    olderMessagesCursorByThread: nextCursors,
    threads: state.threads.map((t) =>
      evictSet.has(t.id)
        ? { ...t, lastModelId: lastRecordedModelId(t), messages: [] }
        : t
    ),
  }
}

/** Message rows read with a page request carry their storage sequence. */
export function messageSequence(message: object): number | undefined {
  const value = (message as { sequence?: unknown }).sequence
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined
}

/** Oldest storage sequence in a page, or undefined when rows carry none. */
export function oldestMessageSequence(
  messages: ReadonlyArray<object>
): number | undefined {
  let oldest: number | undefined
  for (const message of messages) {
    const sequence = messageSequence(message)
    if (sequence !== undefined && (oldest === undefined || sequence < oldest)) {
      oldest = sequence
    }
  }
  return oldest
}

export interface MessageSnapshotMerge<T extends { id: string }> {
  readonly messages: T[]
  /** Cursor for the next older page, or undefined when nothing older exists. */
  readonly olderCursor: number | undefined
}

/**
 * Merge a fresh server page (the newest `page.length` rows) into the
 * transcript already on screen instead of replacing it.
 *
 * - Rows in the page win: the server copy is authoritative for its range.
 * - Older rows loaded earlier are kept when the page overlaps them, so a
 *   refresh does not throw away history the user already paged in.
 * - Local rows the server did not have yet (`keepLocalIds`: optimistic
 *   messages whose save is still in flight, or messages added while the
 *   read ran) are re-applied after the page.
 * - Anything else missing from the page was removed on the server and is
 *   dropped.
 */
export function mergeMessageSnapshot<T extends { id: string }>(input: {
  readonly local: ReadonlyArray<T>
  readonly page: ReadonlyArray<T>
  readonly pageHasOlder: boolean
  readonly previousCursor: number | undefined
  readonly keepLocalIds: ReadonlySet<string>
}): MessageSnapshotMerge<T> {
  const { local, page, pageHasOlder, previousCursor, keepLocalIds } = input
  const pageIds = new Set(page.map((message) => message.id))
  const pageOldest = oldestMessageSequence(page)
  let prefix: T[] = []
  if (pageHasOlder && pageOldest !== undefined) {
    // Keep earlier history only when it reaches into the page; otherwise
    // more than a page arrived while we were away and keeping it would
    // leave a silent gap between the two ranges.
    const overlaps = local.some((message) => {
      const sequence = messageSequence(message)
      return sequence !== undefined && sequence >= pageOldest
    })
    if (overlaps) {
      prefix = local.filter((message) => {
        if (pageIds.has(message.id)) return false
        const sequence = messageSequence(message)
        return sequence !== undefined && sequence < pageOldest
      })
    }
  }
  const prefixIds = new Set(prefix.map((message) => message.id))
  const pending = local.filter(
    (message) =>
      !pageIds.has(message.id) &&
      !prefixIds.has(message.id) &&
      keepLocalIds.has(message.id)
  )
  // With earlier history kept, the cursor that was already past it still
  // applies (undefined there means the start of the chat is loaded).
  const olderCursor = !pageHasOlder
    ? undefined
    : prefix.length > 0
      ? previousCursor
      : pageOldest
  return {
    messages:
      prefix.length === 0 && pending.length === 0
        ? [...page]
        : [...prefix, ...page, ...pending],
    olderCursor,
  }
}
