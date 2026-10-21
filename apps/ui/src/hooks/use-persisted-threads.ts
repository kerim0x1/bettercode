import { useChatStore, type ChatThread } from "@/lib/chat-store"
import { loadThreads } from "@/services/backend"
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
 * Hydrates the thread list once the Electron runtime config is available.
 * Transient backend/startup recovery failures are retried with bounded
 * exponential backoff instead of making history look empty until reload.
 */
export function usePersistedThreads() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))

    const hydrate = async () => {
      while (!cancelled && !window.__BETTERC0DE__?.port) {
        await delay(200)
      }

      let retryDelayMs = 500
      while (!cancelled) {
        try {
          const settingsBeforeLoad = useChatStore.getState().settingsByThread
          const threads = await loadThreads()
          if (cancelled) return
          if (!Array.isArray(threads)) throw new Error("Invalid thread list")

          useChatStore.setState((state) => ({
            settingsByThread: mergePersistedThreadGoals(
              state.settingsByThread,
              threads,
              settingsBeforeLoad
            ),
            threads: mergePersistedThreadSkeletons(state.threads, threads),
          }))
          setReady(true)
          return
        } catch (error) {
          console.warn("Failed to load threads; retrying:", error)
          await delay(retryDelayMs)
          retryDelayMs = Math.min(5_000, retryDelayMs * 2)
        }
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])
  return ready
}
