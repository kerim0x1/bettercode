import type { GitStatus } from "@betterc0de/schema"
import type {
  GitHubBranchComparison,
  GitHubRepositoryInfo,
} from "@betterc0de/schema/http-contracts"
import { HttpError } from "@/lib/errors"
import type { GitPullRequest } from "@/services/backend/gitApi"

/**
 * Pure decisions of "Create pull request": what stops it (GitHub CLI,
 * remote, the default branch, an existing pull request), whether the branch
 * has to be published or pushed first, which base branches to offer, and
 * the words for a failure.
 */

export type CreatePullRequestBlocker =
  | { kind: "github"; status: GitHubRepositoryInfo["status"]; message: string }
  | { kind: "detached" }
  | { kind: "default_branch"; branch: string }
  | { kind: "existing"; pullRequest: GitPullRequest }

export function createPullRequestBlocker(input: {
  repository: Pick<GitHubRepositoryInfo, "status" | "message" | "defaultBranch">
  branch: string
  existing: GitPullRequest | null
}): CreatePullRequestBlocker | null {
  const { repository } = input
  if (repository.status !== "ok") {
    return {
      kind: "github",
      status: repository.status,
      message: repository.message ?? "GitHub CLI isn't ready.",
    }
  }
  const branch = input.branch.trim()
  if (!branch || branch === "HEAD") return { kind: "detached" }
  if (repository.defaultBranch && branch === repository.defaultBranch)
    return { kind: "default_branch", branch }
  if (
    input.existing &&
    (input.existing.state === "open" || input.existing.state === "draft")
  ) {
    return { kind: "existing", pullRequest: input.existing }
  }
  return null
}

export type PushPlan =
  | { kind: "none" }
  | { kind: "publish"; branch: string; remote: string }
  | { kind: "push" }
  | { kind: "behind"; behind: number }

/**
 * What must happen before GitHub can open the pull request: publish a branch
 * without an upstream, push commits it does not have yet, or nothing. A
 * branch behind its upstream has to be pulled first.
 */
export function pushPlan(
  status: Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind">,
  remote: string
): PushPlan {
  if (!status.upstream) {
    return { kind: "publish", branch: status.branch, remote }
  }
  if (status.behind > 0) return { kind: "behind", behind: status.behind }
  if (status.ahead > 0) return { kind: "push" }
  return { kind: "none" }
}

/** The default branch first, then the other local branches, without the head. */
export function baseBranchOptions(
  defaultBranch: string | null,
  branches: readonly string[],
  head: string
): string[] {
  const options = [defaultBranch, ...branches]
    .filter((branch): branch is string => Boolean(branch?.trim()))
    .map((branch) => branch.trim())
    .filter((branch) => branch !== head)
  return [...new Set(options)]
}

/** A title to start from when none was generated: the newest commit, else the branch. */
export function fallbackPullRequestTitle(
  comparison: Pick<GitHubBranchComparison, "commits"> | null,
  branch: string
): string {
  const firstCommit = comparison?.commits
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  if (firstCommit) return firstCommit.replace(/^[0-9a-f]{4,40}\s+/i, "")
  const words = branch.split("/").pop()!.replace(/[-_]+/g, " ").trim()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : branch
}

/** A branch name git accepts, from a generated or typed one. */
export function cleanBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/@\{/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[/.]+$/g, "")
    .replace(/\.lock$/i, "")
    .slice(0, 120)
}

/** What to tell the user about a failed step, by the backend's error code. */
export function pullRequestErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.code === "workspace_untrusted")
      return "This workspace isn't trusted. Trust it in Settings → Permissions, then try again."
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** The setup steps for a CLI problem, shown with a link to the CLI. */
export function githubSetupHint(
  status: GitHubRepositoryInfo["status"]
): string | null {
  switch (status) {
    case "gh_missing":
      return "Install GitHub CLI, run gh auth login in a terminal, then check again."
    case "gh_signed_out":
      return "Run gh auth login in a terminal, then check again."
    case "no_remote":
      return "Add a GitHub remote, for example with git remote add origin <url>, and push the branch."
    default:
      return null
  }
}
