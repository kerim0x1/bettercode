import { create } from "zustand"
import type { GitHubPullRequestOverview } from "@betterc0de/schema/http-contracts"
import { githubPullRequestOverview } from "@/services/backend/github-api"

/**
 * The Pull Requests page's list: the open pull requests of the user's
 * projects, kept while the page is closed so returning to it shows the last
 * list at once and refreshes behind it. The backend caches each repository
 * for a minute; Refresh asks GitHub again.
 */
interface PullRequestsState {
  overview: GitHubPullRequestOverview | null
  /** The project folders the overview was read for. */
  folders: string[]
  loading: boolean
  error: string | null
  loadedAt: number | null
  load: (folders: string[], options?: { refresh?: boolean }) => Promise<void>
}

const STALE_MS = 60_000

let request = 0

export const usePullRequestsStore = create<PullRequestsState>()((set, get) => ({
  overview: null,
  folders: [],
  loading: false,
  error: null,
  loadedAt: null,
  load: async (folders, options = {}) => {
    const sameFolders =
      folders.length === get().folders.length &&
      folders.every((folder, index) => folder === get().folders[index])
    const fresh =
      sameFolders &&
      get().overview !== null &&
      Date.now() - (get().loadedAt ?? 0) < STALE_MS
    if (!options.refresh && fresh) return
    if (folders.length === 0) {
      set({
        overview: { viewerLogin: null, repositories: [] },
        folders,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      })
      return
    }
    const current = ++request
    set({ loading: true, error: null, folders })
    try {
      const overview = await githubPullRequestOverview(folders, {
        refresh: options.refresh,
      })
      if (current !== request) return
      set({ overview, loading: false, loadedAt: Date.now() })
    } catch (error) {
      if (current !== request) return
      set({
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Couldn't read pull requests.",
      })
    }
  },
}))
