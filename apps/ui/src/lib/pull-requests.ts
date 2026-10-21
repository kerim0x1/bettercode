import type {
  GitHubAccessStatus,
  GitHubCheckSummary,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubRepositoryPullRequests,
  GitHubReviewDecision,
} from "@betterc0de/schema/http-contracts"

/**
 * Pure helpers of the Pull Requests page: which projects to read, the
 * filters (Mine, Review requested, All open) and search, and the words and
 * tones for a pull request's state, checks and review decision.
 */

export type PullRequestFilter = "mine" | "review" | "all"

/** A pull request with the project folder and repository it was read through. */
export interface ListedPullRequest extends GitHubPullRequestSummary {
  cwd: string
  slug: string
}

/** At most this many projects are read at once (the backend's limit). */
export const MAX_PULL_REQUEST_PROJECTS = 30

/**
 * The project folders of the user's chats, most recently used first, one
 * per folder. Worktrees of the same repository are read once by the backend.
 */
export function pullRequestProjectFolders(
  threads: ReadonlyArray<{
    projectPath?: string | null
    updatedAt?: string | null
  }>,
  max = MAX_PULL_REQUEST_PROJECTS
): string[] {
  const latest = new Map<string, number>()
  for (const thread of threads) {
    const folder = thread.projectPath?.trim()
    if (!folder) continue
    const key = folder.replace(/[\\/]+$/, "")
    const at = Date.parse(thread.updatedAt ?? "") || 0
    if ((latest.get(key) ?? -1) < at) latest.set(key, at)
  }
  return [...latest.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, max)
    .map(([folder]) => folder)
}

/** Every repository's pull requests in one list, most recently updated first. */
export function flattenPullRequests(
  repositories: readonly GitHubRepositoryPullRequests[]
): ListedPullRequest[] {
  const list: ListedPullRequest[] = []
  for (const repository of repositories) {
    if (!repository.slug) continue
    for (const pullRequest of repository.pullRequests) {
      list.push({ ...pullRequest, cwd: repository.cwd, slug: repository.slug })
    }
  }
  return list.sort(
    (left, right) =>
      (Date.parse(right.updatedAt ?? "") || 0) -
        (Date.parse(left.updatedAt ?? "") || 0) ||
      left.slug.localeCompare(right.slug) ||
      right.number - left.number
  )
}

function isMine(pullRequest: ListedPullRequest, viewer: string | null) {
  return Boolean(
    viewer && pullRequest.author?.toLowerCase() === viewer.toLowerCase()
  )
}

export function matchesFilter(
  pullRequest: ListedPullRequest,
  filter: PullRequestFilter,
  viewerLogin: string | null
): boolean {
  if (filter === "mine") return isMine(pullRequest, viewerLogin)
  if (filter === "review") return pullRequest.reviewRequested
  return true
}

/** Every word of `query` appears in the title, number, author, branch, repository or a label. */
export function matchesSearch(
  pullRequest: ListedPullRequest,
  query: string
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [
    pullRequest.title,
    `#${pullRequest.number}`,
    pullRequest.author ?? "",
    pullRequest.headBranch,
    pullRequest.baseBranch,
    pullRequest.slug,
    ...pullRequest.labels,
  ]
    .join("\n")
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

export function filterPullRequests(
  list: readonly ListedPullRequest[],
  options: {
    filter: PullRequestFilter
    query: string
    viewerLogin: string | null
  }
): ListedPullRequest[] {
  return list.filter(
    (pullRequest) =>
      matchesFilter(pullRequest, options.filter, options.viewerLogin) &&
      matchesSearch(pullRequest, options.query)
  )
}

export function filterCounts(
  list: readonly ListedPullRequest[],
  viewerLogin: string | null
): Record<PullRequestFilter, number> {
  return {
    mine: list.filter((entry) => matchesFilter(entry, "mine", viewerLogin))
      .length,
    review: list.filter((entry) => entry.reviewRequested).length,
    all: list.length,
  }
}

export type StatusTone = "success" | "danger" | "warning" | "muted" | "merged"

/** The tone class of a status, from the theme's semantic colors. */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: "text-success",
  danger: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
  // GitHub's merged purple: a state's own colour, like a provider logo
  // (the sidebar's pull request icons use it too).
  merged: "text-purple-700 dark:text-purple-400",
}

export function pullRequestStateLook(state: GitHubPullRequestState): {
  label: string
  tone: StatusTone
} {
  switch (state) {
    case "open":
      return { label: "Open", tone: "success" }
    case "draft":
      return { label: "Draft", tone: "muted" }
    case "merged":
      return { label: "Merged", tone: "merged" }
    default:
      return { label: "Closed", tone: "danger" }
  }
}

/** "3 of 4 checks passed", "1 check failing", "2 checks running". */
export function checkSummaryLook(checks: GitHubCheckSummary): {
  label: string
  short: string
  tone: StatusTone
  state: "pass" | "fail" | "pending" | "none"
} {
  const plural = (count: number) => (count === 1 ? "check" : "checks")
  if (checks.total === 0)
    return { label: "No checks", short: "", tone: "muted", state: "none" }
  if (checks.failed > 0)
    return {
      label: `${checks.failed} ${plural(checks.failed)} failing`,
      short: `${checks.passed}/${checks.total}`,
      tone: "danger",
      state: "fail",
    }
  if (checks.pending > 0)
    return {
      label: `${checks.pending} ${plural(checks.pending)} running`,
      short: `${checks.passed}/${checks.total}`,
      tone: "warning",
      state: "pending",
    }
  return {
    label: `${checks.passed} of ${checks.total} ${plural(checks.total)} passed`,
    short: `${checks.passed}/${checks.total}`,
    tone: "success",
    state: "pass",
  }
}

export function reviewDecisionLook(
  decision: GitHubReviewDecision | null
): { label: string; tone: StatusTone } | null {
  switch (decision) {
    case "approved":
      return { label: "Approved", tone: "success" }
    case "changes_requested":
      return { label: "Changes requested", tone: "danger" }
    case "review_required":
      return { label: "Review required", tone: "muted" }
    default:
      return null
  }
}

/**
 * What keeps pull requests from loading: the first CLI problem (missing or
 * signed out applies to every repository), how many projects have no
 * GitHub remote, and other repository errors.
 */
export function overviewProblems(
  repositories: readonly GitHubRepositoryPullRequests[]
): {
  cli: { status: GitHubAccessStatus; message: string } | null
  withoutRemote: number
  errors: Array<{ slug: string; message: string }>
} {
  const cli =
    repositories.find(
      (repository) =>
        repository.status === "gh_missing" ||
        repository.status === "gh_signed_out"
    ) ?? null
  return {
    cli: cli
      ? {
          status: cli.status,
          message: cli.message ?? "GitHub CLI isn't ready.",
        }
      : null,
    withoutRemote: repositories.filter(
      (repository) => repository.status === "no_remote"
    ).length,
    errors: repositories
      .filter((repository) => repository.status === "error")
      .map((repository) => ({
        slug: repository.slug ?? repository.cwd,
        message: repository.message ?? "Couldn't read pull requests.",
      })),
  }
}

/** "5m ago" style age of an ISO time; empty when unknown. */
export function updatedAgo(iso: string | null, now = Date.now()): string {
  const time = Date.parse(iso ?? "")
  if (!Number.isFinite(time)) return ""
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(time).toLocaleDateString()
}
