/**
 * Opening the Pull Requests page from anywhere (sidebar, command palette,
 * a chat's pull request chip). The app shell listens for the event, like
 * it does for Usage.
 */

export const OPEN_PULL_REQUESTS_EVENT = "betterc0de:open-pull-requests"

/** A pull request to open directly, by the project folder it lives in. */
export interface PullRequestsPageTarget {
  cwd: string
  number: number
}

export function openPullRequestsPage(target?: PullRequestsPageTarget): void {
  window.dispatchEvent(
    new CustomEvent<PullRequestsPageTarget | null>(OPEN_PULL_REQUESTS_EVENT, {
      detail: target ?? null,
    })
  )
}

/** The target of an open event, when it names a valid one. */
export function pullRequestsPageTarget(
  event: Event
): PullRequestsPageTarget | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (!detail || typeof detail !== "object") return null
  const { cwd, number } = detail as Partial<PullRequestsPageTarget>
  return typeof cwd === "string" &&
    cwd.length > 0 &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
    ? { cwd, number }
    : null
}
