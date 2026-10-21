import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  pullRequestForBranch,
  pullRequestState,
  pullRequestsStore,
} from "@/lib/thread-pull-request"

/**
 * Which of these chats have a merged or closed pull request on their branch,
 * so the feed can move them to Inactive. Reads the same per-repository
 * pull request lists the rows show (`lib/thread-pull-request.ts`), so it
 * adds no requests of its own: the feed's rows already watch those
 * repositories.
 */
export function useClosedPullRequestThreadIds(
  threads: ReadonlyArray<{
    id: string
    projectPath?: string | null
    worktreePath?: string | null
    branch?: string | null
  }>
): ReadonlySet<string> {
  // One string, so a re-render with the same chats keeps the subscription.
  const signature = threads
    .flatMap((thread) => {
      const cwd = thread.projectPath || thread.worktreePath
      return cwd && thread.branch
        ? [`${thread.id}\u0000${cwd}\u0000${thread.branch}`]
        : []
    })
    .join("\n")

  const entries = useMemo(
    () =>
      signature
        ? signature.split("\n").map((line) => {
            const [id, cwd, branch] = line.split("\u0000") as [
              string,
              string,
              string,
            ]
            return { id, cwd, branch }
          })
        : [],
    [signature]
  )

  const subscribe = useCallback(
    (listener: () => void) => {
      const cwds = [...new Set(entries.map((entry) => entry.cwd))]
      const unsubscribes = cwds.map((cwd) =>
        pullRequestsStore.subscribe(cwd, listener)
      )
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe()
      }
    },
    [entries]
  )

  const getSnapshot = useCallback(
    () =>
      entries
        .filter((entry) => {
          const pullRequest = pullRequestForBranch(
            pullRequestsStore.getSnapshot(entry.cwd),
            entry.branch
          )
          if (!pullRequest) return false
          const state = pullRequestState(pullRequest)
          return state === "merged" || state === "closed"
        })
        .map((entry) => entry.id)
        .join("\n"),
    [entries]
  )

  const closed = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(() => new Set(closed ? closed.split("\n") : []), [closed])
}
