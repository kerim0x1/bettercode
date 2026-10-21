import { create } from "zustand"
import type { GitHubPullRequestWatch } from "@betterc0de/schema/http-contracts"
import {
  githubPullRequestWatches,
  githubSetPullRequestWatch,
  type GitHubWakeNotice,
} from "@/services/backend/github-api"

/**
 * The renderer's copy of the chats' pull request wake-ups: whether each is
 * on and what the backend's watcher last saw. The setting itself is kept
 * with the chat in the backend; this store reads it through
 * `/github/pull-requests/watch`, which the wake-up bridge polls anyway.
 */
interface PullRequestWakeState {
  watches: Record<string, GitHubPullRequestWatch>
  /** Chats whose switch is being saved. */
  saving: Record<string, boolean>
  loaded: boolean
  /** Reads every watch and the waiting messages; null when unavailable. */
  refresh: () => Promise<GitHubWakeNotice[] | null>
  setEnabled: (threadId: string, enabled: boolean) => Promise<void>
}

export const usePullRequestWakeStore = create<PullRequestWakeState>()(
  (set, get) => ({
    watches: {},
    saving: {},
    loaded: false,
    refresh: async () => {
      try {
        const list = await githubPullRequestWatches()
        const watches: Record<string, GitHubPullRequestWatch> = {}
        for (const watch of list.watches) watches[watch.threadId] = watch
        // A switch being saved keeps what the user just chose.
        const saving = get().saving
        for (const threadId of Object.keys(saving)) {
          const current = get().watches[threadId]
          if (current) watches[threadId] = current
          else delete watches[threadId]
        }
        set({ watches, loaded: true })
        return list.notices
      } catch {
        set({ loaded: true })
        return null
      }
    },
    setEnabled: async (threadId, enabled) => {
      const previous = get().watches[threadId]
      // Shown at once; the backend's answer replaces it.
      const optimistic: GitHubPullRequestWatch = previous
        ? { ...previous, enabled: true }
        : {
            threadId,
            enabled: true,
            state: "waiting",
            pullRequestNumber: null,
            pullRequestUrl: null,
            message: "Checking the pull request…",
            lastCheckedAt: null,
            lastWokeAt: null,
          }
      set((state) => ({
        saving: { ...state.saving, [threadId]: true },
        watches: enabled
          ? { ...state.watches, [threadId]: optimistic }
          : withoutKey(state.watches, threadId),
      }))
      try {
        const { watch } = await githubSetPullRequestWatch(threadId, enabled)
        set((state) => ({
          watches: watch
            ? { ...state.watches, [threadId]: watch }
            : withoutKey(state.watches, threadId),
        }))
      } catch (error) {
        set((state) => ({
          watches: previous
            ? { ...state.watches, [threadId]: previous }
            : withoutKey(state.watches, threadId),
        }))
        throw error
      } finally {
        set((state) => ({ saving: withoutKey(state.saving, threadId) }))
      }
    },
  })
)

function withoutKey<T>(
  record: Record<string, T>,
  key: string
): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** A chat's wake-up: on, and what the watcher last saw; null when off. */
export function usePullRequestWake(
  threadId: string | null | undefined
): GitHubPullRequestWatch | null {
  return usePullRequestWakeStore((state) =>
    threadId ? (state.watches[threadId] ?? null) : null
  )
}
