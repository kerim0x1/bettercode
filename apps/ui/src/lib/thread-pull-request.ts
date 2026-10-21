import { useMemo } from "react"
import {
  gitListPullRequests,
  type GitPullRequest,
} from "@/services/backend/gitApi"
import {
  createSharedResourceFamily,
  jsonEqual,
  useSharedResourceKey,
} from "@/lib/shared-resource"

export type PullRequestState = "open" | "draft" | "merged" | "closed"

const PULL_REQUEST_POLL_MS = 2 * 60_000
const NO_PULL_REQUESTS: GitPullRequest[] = []

/**
 * A workspace's pull requests, keyed by its path. Every sidebar row of a
 * project reads the same list, so a project costs one request per poll
 * however many chats it shows; the backend shares it per repository too.
 */
export const pullRequestsStore = createSharedResourceFamily<GitPullRequest[]>({
  initial: NO_PULL_REQUESTS,
  create: (cwd) => ({
    intervalMs: PULL_REQUEST_POLL_MS,
    load: async () => (await gitListPullRequests(cwd)).pullRequests,
    isEqual: jsonEqual,
  }),
})

/**
 * Reloads every workspace's list now, after a pull request was created,
 * merged or closed here, so the sidebar follows without waiting for the
 * next poll. The backend drops its own cached list for that repository.
 */
export function refreshPullRequests(): void {
  for (const [, resource] of pullRequestsStore.entries()) resource.invalidate()
}

/** The backend's state, with anything unknown read as closed. */
export function pullRequestState(
  pullRequest: GitPullRequest
): PullRequestState {
  const state = pullRequest.state.toLowerCase()
  return state === "open" || state === "draft" || state === "merged"
    ? state
    : "closed"
}

/** The pull request for a branch: an open or draft one first, then the newest. */
export function pullRequestForBranch(
  pullRequests: readonly GitPullRequest[],
  branch: string
): GitPullRequest | null {
  const matching = pullRequests.filter((entry) => entry.branch === branch)
  if (matching.length === 0) return null
  const rank = (entry: GitPullRequest) => {
    const state = pullRequestState(entry)
    return state === "open" || state === "draft" ? 0 : 1
  }
  return [...matching].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") ||
      b.number - a.number
  )[0]!
}

/**
 * The pull request of a chat's branch, or null. A chat without a recorded
 * branch subscribes to nothing.
 */
export function useThreadPullRequest(
  cwd: string | null | undefined,
  branch: string | null | undefined
): GitPullRequest | null {
  const key = cwd && branch ? cwd : null
  const pullRequests = useSharedResourceKey(pullRequestsStore, key)
  return useMemo(
    () =>
      pullRequests && branch
        ? pullRequestForBranch(pullRequests, branch)
        : null,
    [pullRequests, branch]
  )
}
