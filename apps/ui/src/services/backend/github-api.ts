import type {
  GitHubBranchComparison,
  GitHubPullRequestActionResult,
  GitHubPullRequestCreateResult,
  GitHubPullRequestDetail,
  GitHubPullRequestDiff,
  GitHubPullRequestOverview,
  GitHubPullRequestWatch,
  GitHubPullRequestWatchList,
  GitHubPullRequestWorkResult,
  GitHubRepositoryInfo,
  GitHubWakeNotice,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"

// Pull requests through the user's GitHub CLI (`gh`), one function per
// `/github/*` route. Every call goes through its shared contract
// (`@betterc0de/schema/http-contracts`). Expected refusals (no `gh`, signed
// out, no GitHub remote, a refusal from GitHub) are shown where they happen,
// so they stay out of the console.

export type {
  GitHubBranchComparison,
  GitHubPullRequestDetail,
  GitHubPullRequestOverview,
  GitHubPullRequestWatch,
  GitHubRepositoryInfo,
  GitHubWakeNotice,
}

const EXPECTED_FAILURES = [400, 403, 404, 409, 412, 413, 429, 502, 504]

export const githubRepository = (cwd: string): Promise<GitHubRepositoryInfo> =>
  invokeContract("githubRepository", {
    body: { cwd },
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubPullRequestOverview = (
  cwds: string[],
  options: { refresh?: boolean } = {}
): Promise<GitHubPullRequestOverview> =>
  invokeContract("githubPullRequestOverview", {
    body: { cwds, ...(options.refresh ? { refresh: true } : {}) },
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubCompareBranch = (input: {
  cwd: string
  base: string
  includeWorkingTree?: boolean
}): Promise<GitHubBranchComparison> =>
  invokeContract("githubBranchCompare", {
    body: input,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubCreatePullRequest = (input: {
  cwd: string
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
}): Promise<GitHubPullRequestCreateResult> =>
  invokeContract("githubPullRequestCreate", {
    body: input,
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubPullRequestDetail = (
  cwd: string,
  number: number
): Promise<GitHubPullRequestDetail> =>
  invokeContract("githubPullRequestDetail", {
    body: { cwd, number },
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubPullRequestDiff = (
  cwd: string,
  number: number
): Promise<GitHubPullRequestDiff> =>
  invokeContract("githubPullRequestDiff", {
    body: { cwd, number },
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubCommentOnPullRequest = (input: {
  cwd: string
  number: number
  body: string
}): Promise<GitHubPullRequestActionResult> =>
  invokeContract("githubPullRequestComment", {
    body: input,
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubReviewPullRequest = (input: {
  cwd: string
  number: number
  event: "approve" | "request_changes" | "comment"
  body: string
}): Promise<GitHubPullRequestActionResult> =>
  invokeContract("githubPullRequestReview", {
    body: input,
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubMergePullRequest = (input: {
  cwd: string
  number: number
  method: "merge" | "squash" | "rebase"
  deleteBranch?: boolean
  headSha?: string
}): Promise<GitHubPullRequestActionResult> =>
  invokeContract("githubPullRequestMerge", {
    body: input,
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubSetPullRequestState = (input: {
  cwd: string
  number: number
  action: "close" | "reopen"
}): Promise<GitHubPullRequestActionResult> =>
  invokeContract("githubPullRequestState", {
    body: input,
    timeoutMs: 90_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubWorkOnPullRequest = (input: {
  cwd: string
  number: number
  threadId: string
}): Promise<GitHubPullRequestWorkResult> =>
  invokeContract("githubPullRequestWork", {
    body: input,
    timeoutMs: 150_000,
    silentStatuses: EXPECTED_FAILURES,
  })

export const githubPullRequestWatches =
  (): Promise<GitHubPullRequestWatchList> =>
    invokeContract("githubPullRequestWatchList", {
      silentStatuses: [403],
    })

export const githubSetPullRequestWatch = (
  threadId: string,
  enabled: boolean
): Promise<{ watch: GitHubPullRequestWatch | null }> =>
  invokeContract("githubPullRequestWatchSet", {
    body: { threadId, enabled },
    silentStatuses: [403, 404],
  })

export const githubClaimWakeNotice = (
  noticeId: string
): Promise<{ notice: GitHubWakeNotice | null }> =>
  invokeContract("githubPullRequestWatchClaim", {
    body: { noticeId },
    silentStatuses: [403],
  })
