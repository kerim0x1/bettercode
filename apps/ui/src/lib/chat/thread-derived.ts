import { useCallback } from "react"
import type { ChatMessage, ThreadActivity } from "@betterc0de/schema"
import { useChatStore } from "../chat-store"
import {
  latestProviderContinuationKey,
  latestProviderInstanceId,
} from "@/lib/provider-model-selection"

/**
 * Narrow, memoized reads of a thread's transcript state.
 *
 * Components high in the tree (the app shell, each chat column) only need a
 * few facts derived from a thread's messages and activities. Subscribing to
 * the arrays themselves re-rendered them on every tool event; these
 * selectors return primitives, or values cached per array reference, so
 * zustand's equality check skips unrelated updates.
 */

export const EMPTY_MESSAGES: ChatMessage[] = []
export const EMPTY_ACTIVITIES: ThreadActivity[] = []

type ChatStoreState = ReturnType<typeof useChatStore.getState>

export function selectThreadMessages(
  state: ChatStoreState,
  threadId: string | null | undefined
): ChatMessage[] {
  if (!threadId) return EMPTY_MESSAGES
  return (
    state.threads.find((thread) => thread.id === threadId)?.messages ??
    EMPTY_MESSAGES
  )
}

export function selectThreadActivities(
  state: ChatStoreState,
  threadId: string | null | undefined
): ThreadActivity[] {
  if (!threadId) return EMPTY_ACTIVITIES
  return state.activitiesByThread[threadId] ?? EMPTY_ACTIVITIES
}

export interface ThreadProviderLock {
  readonly instanceId: string | null
  readonly continuationKey: string | null
}

const providerLockCache = new WeakMap<
  ReadonlyArray<ThreadActivity>,
  ThreadProviderLock
>()

/** Provider instance / continuation the thread's activities are bound to. */
export function threadProviderLock(
  activities: ReadonlyArray<ThreadActivity>
): ThreadProviderLock {
  const cached = providerLockCache.get(activities)
  if (cached) return cached
  const lock = {
    instanceId: latestProviderInstanceId(activities),
    continuationKey: latestProviderContinuationKey(activities),
  }
  providerLockCache.set(activities, lock)
  return lock
}

/**
 * The provider lock derived from a thread's activities. Re-renders only when
 * the lock itself changes, not on every activity upsert.
 */
export function useThreadProviderLock(
  threadId: string | null | undefined
): ThreadProviderLock {
  const instanceId = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        threadProviderLock(selectThreadActivities(state, threadId)).instanceId,
      [threadId]
    )
  )
  const continuationKey = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        threadProviderLock(selectThreadActivities(state, threadId))
          .continuationKey,
      [threadId]
    )
  )
  return { instanceId, continuationKey }
}

/** Whether the thread has any message or activity to show. */
export function useThreadHasTranscript(
  threadId: string | null | undefined
): boolean {
  return useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        selectThreadMessages(state, threadId).length > 0 ||
        selectThreadActivities(state, threadId).length > 0,
      [threadId]
    )
  )
}

/** Message count of the loaded transcript. */
export function useThreadMessageCount(
  threadId: string | null | undefined
): number {
  return useChatStore(
    useCallback(
      (state: ChatStoreState) => selectThreadMessages(state, threadId).length,
      [threadId]
    )
  )
}

/** Whether the thread's stream is running. */
export function useThreadIsStreaming(
  threadId: string | null | undefined
): boolean {
  return useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        Boolean(threadId && state.streamingByThread[threadId]?.isStreaming),
      [threadId]
    )
  )
}
