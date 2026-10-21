import {
  cacheThreadSettings,
  useChatStore,
  type ChatThread,
} from "@/lib/chat-store"
import {
  mergeStoredThreadSettings,
  queueThreadSettingsChange,
  type ThreadSettingsChange,
} from "@/lib/thread-settings-sync"
import { mergePersistedThreadAutonomy } from "@/lib/chat/autonomy-sync"
import {
  applyPersistedThreadResumes,
  useChatResumeStore,
} from "@/lib/chat-resume-store"
import { loadThreads } from "@/services/backend/coreApi"
import { onBackendReady, whenBackendReady } from "@/services/backend/runtime"
import { useEffect, useState } from "react"

type ThreadSettingsMap = ReturnType<
  typeof useChatStore.getState
>["settingsByThread"]

/** Backend snapshots restore goals without overwriting live updates received during loading. */
export function mergePersistedThreadGoals(
  current: ThreadSettingsMap,
  persisted: ChatThread[],
  beforeLoad: ThreadSettingsMap
): ThreadSettingsMap {
  let next = current
  for (const thread of persisted) {
    if (thread.goal === undefined) continue
    const settings = current[thread.id]
    if (
      (settings?.goalRevision ?? 0) !==
      (beforeLoad[thread.id]?.goalRevision ?? 0)
    )
      continue
    if (next === current) next = { ...current }
    next[thread.id] = { ...settings, goal: thread.goal }
  }
  return next
}

/**
 * Merge the initial database snapshot without replacing threads that were
 * created or hydrated while the request was in flight. A plain assignment is
 * racy: "New Task" can create and activate a thread before `loadThreads()`
 * resolves, after which the late response used to remove that thread while
 * leaving `activeThreadId` pointing at it.
 */
export function mergePersistedThreadSkeletons(
  current: ChatThread[],
  persisted: ChatThread[]
): ChatThread[] {
  const skeletons = persisted.map((thread) => ({
    ...thread,
    messages: [],
  }))
  const persistedIds = new Set(skeletons.map((thread) => thread.id))
  const currentById = new Map(current.map((thread) => [thread.id, thread]))

  return [
    ...current.filter((thread) => !persistedIds.has(thread.id)),
    ...skeletons.map((thread) => currentById.get(thread.id) ?? thread),
  ]
}

/**
 * Resolves after `ms`, or earlier when the shell reports that the backend
 * (re)started, or when `signal` aborts. Used between retries so a backend
 * restart is picked up at once instead of after the current backoff step.
 */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let unsubscribe: () => void = () => {}
    const finish = () => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    unsubscribe = onBackendReady(finish)
    signal.addEventListener("abort", finish, { once: true })
  })
}

/**
 * Hydrates the thread list as soon as the shell reports the backend ready
 * (no polling for the runtime config). Transient backend/startup recovery
 * failures are retried with bounded exponential backoff instead of making
 * history look empty until reload; a backend restart cuts the wait short.
 */
export function usePersistedThreads() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    const cancelled = () => signal.aborted

    const hydrate = async () => {
      try {
        await whenBackendReady(signal)
      } catch {
        return
      }

      let retryDelayMs = 500
      while (!cancelled()) {
        try {
          const settingsBeforeLoad = useChatStore.getState().settingsByThread
          const autonomyBeforeLoad = useChatStore.getState().autonomyByThread
          const resumesBeforeLoad = useChatResumeStore.getState().byThread
          const threads = await loadThreads()
          if (cancelled()) return
          if (!Array.isArray(threads)) throw new Error("Invalid thread list")

          let migrations: Array<[string, ThreadSettingsChange]> = []
          useChatStore.setState((state) => {
            // The settings the backend keeps with each chat win over the
            // localStorage cache; ones only the cache has move to the
            // backend (the first load after the backend began keeping them).
            const stored = mergeStoredThreadSettings(
              state.settingsByThread,
              threads,
              settingsBeforeLoad
            )
            migrations = stored.migrations
            return {
              settingsByThread: mergePersistedThreadGoals(
                stored.settingsByThread,
                threads,
                settingsBeforeLoad
              ),
              // Autonomous Work runs the backend kept across a reload.
              autonomyByThread: mergePersistedThreadAutonomy(
                state.autonomyByThread,
                threads,
                autonomyBeforeLoad
              ),
              threads: mergePersistedThreadSkeletons(state.threads, threads),
            }
          })
          cacheThreadSettings()
          // Chats a usage limit or a restart stopped (chat-resume-store).
          applyPersistedThreadResumes(threads, resumesBeforeLoad)
          for (const [threadId, change] of migrations) {
            queueThreadSettingsChange(threadId, change)
          }
          setReady(true)
          return
        } catch (error) {
          if (cancelled()) return
          console.warn("Failed to load threads; retrying:", error)
          await waitForRetry(retryDelayMs, signal)
          retryDelayMs = Math.min(5_000, retryDelayMs * 2)
        }
      }
    }

    void hydrate()
    return () => {
      controller.abort()
    }
  }, [])
  return ready
}
