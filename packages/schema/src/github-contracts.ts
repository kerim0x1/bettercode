import { z } from "zod"
import { endpoint, noBody, type RecordSchema } from "./http-endpoint"

/**
 * The GitHub routes (`apps/backend/src/http/routes/github.ts`): pull
 * requests listed, created, reviewed and merged through the user's own
 * GitHub CLI login (`gh`), and the per-chat wake-ups on failed checks,
 * reviews and merge conflicts. The backend runs `gh` outside the repository
 * with an explicit `--repo`; the repository only supplies its GitHub remote.
 */

const text = z.string()
const count = z.number().int().nonnegative()

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}

/** A registered workspace folder; the backend confines it to its roots. */
const cwdSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => value.trim().length > 0, "cwd must not be blank")
  .refine((value) => !value.includes("\0"), "cwd must not contain NUL")

/** A branch name as git accepts it; the backend checks it again. */
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !hasControlCharacter(value) &&
      !/[\s~^:?*[\]\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock"),
    "Invalid branch name"
  )

const pullRequestNumberSchema = z.number().int().positive().max(2_147_483_647)
const threadIdSchema = z.string().trim().min(1).max(256)
const bodySchema = z.string().max(65_536)
const nonBlankBodySchema = bodySchema.refine(
  (value) => value.trim().length > 0,
  "Write a message first"
)

// ── Requests ────────────────────────────────────────────────────────────

/** A repository, named by one of its registered workspace folders. */
export const githubCwdSchema = z.object({ cwd: cwdSchema }).strict()

/** The open pull requests of several projects at once (one per repository). */
export const githubPullRequestOverviewSchema = z
  .object({
    cwds: z.array(cwdSchema).min(1).max(30),
    /** Skip the one-minute cache. */
    refresh: z.boolean().optional(),
  })
  .strict()

/**
 * The commits and diff a pull request from the checked-out branch into
 * `base` would carry, for writing its title and description.
 * `includeWorkingTree` adds the uncommitted changes to tracked files.
 */
export const githubBranchCompareSchema = z
  .object({
    cwd: cwdSchema,
    base: branchSchema,
    includeWorkingTree: z.boolean().optional(),
  })
  .strict()

export const githubPullRequestCreateSchema = z
  .object({
    cwd: cwdSchema,
    head: branchSchema,
    base: branchSchema,
    title: z
      .string()
      .trim()
      .min(1, "Give the pull request a title")
      .max(1_024)
      .refine((value) => !/[\r\n\0]/.test(value), "The title must be one line"),
    body: bodySchema,
    draft: z.boolean().optional(),
  })
  .strict()

/** One pull request of the repository behind `cwd`. */
export const githubPullRequestRefSchema = z
  .object({ cwd: cwdSchema, number: pullRequestNumberSchema })
  .strict()

export const githubPullRequestCommentSchema = z
  .object({
    cwd: cwdSchema,
    number: pullRequestNumberSchema,
    body: nonBlankBodySchema,
  })
  .strict()

export const githubPullRequestReviewSchema = z
  .object({
    cwd: cwdSchema,
    number: pullRequestNumberSchema,
    event: z.enum(["approve", "request_changes", "comment"]),
    body: bodySchema,
  })
  .strict()
  .refine(
    (value) => value.event === "approve" || value.body.trim().length > 0,
    "Requesting changes or commenting needs a message"
  )

export const githubPullRequestMergeSchema = z
  .object({
    cwd: cwdSchema,
    number: pullRequestNumberSchema,
    method: z.enum(["merge", "squash", "rebase"]),
    deleteBranch: z.boolean().optional(),
    /** Merge only when the head is still the commit the user reviewed. */
    headSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i, "Invalid commit")
      .optional(),
  })
  .strict()

export const githubPullRequestStateSchema = z
  .object({
    cwd: cwdSchema,
    number: pullRequestNumberSchema,
    action: z.enum(["close", "reopen"]),
  })
  .strict()

/** Check out the pull request's branch in a new worktree for `threadId`. */
export const githubPullRequestWorkSchema = z
  .object({
    cwd: cwdSchema,
    number: pullRequestNumberSchema,
    threadId: threadIdSchema,
  })
  .strict()

/** Turn a chat's wake-ups on its pull request on or off. */
export const githubPullRequestWatchSetSchema = z
  .object({ threadId: threadIdSchema, enabled: z.boolean() })
  .strict()

export const githubPullRequestWatchClaimSchema = z
  .object({ noticeId: z.string().trim().min(1).max(128) })
  .strict()

// ── Read models ─────────────────────────────────────────────────────────

/**
 * Whether `gh` could answer for the repository: `gh_missing` and
 * `gh_signed_out` are the user's CLI, `no_remote` a repository without a
 * GitHub remote, `error` anything else (network, permissions).
 */
export type GitHubAccessStatus =
  | "ok"
  | "gh_missing"
  | "gh_signed_out"
  | "no_remote"
  | "error"

const accessStatusSchema = z.enum([
  "ok",
  "gh_missing",
  "gh_signed_out",
  "no_remote",
  "error",
])

export interface GitHubMergeMethods {
  merge: boolean
  squash: boolean
  rebase: boolean
}

export interface GitHubRepositoryInfo {
  status: GitHubAccessStatus
  /** What went wrong and what to do, when `status` is not `ok`. */
  message: string | null
  /** `owner/name`. */
  slug: string | null
  /** The git remote that points at it. */
  remote: string | null
  url: string | null
  defaultBranch: string | null
  /** The signed-in GitHub user. */
  viewerLogin: string | null
  /** `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE` or `READ`. */
  viewerPermission: string | null
  /** The merge methods the repository allows. */
  mergeMethods: GitHubMergeMethods
  deleteBranchOnMerge: boolean
}

const repositoryInfoSchema: RecordSchema<GitHubRepositoryInfo> = z
  .object({
    status: accessStatusSchema,
    message: text.nullable(),
    slug: text.nullable(),
    remote: text.nullable(),
    url: text.nullable(),
    defaultBranch: text.nullable(),
    viewerLogin: text.nullable(),
    viewerPermission: text.nullable(),
    mergeMethods: z
      .object({ merge: z.boolean(), squash: z.boolean(), rebase: z.boolean() })
      .passthrough(),
    deleteBranchOnMerge: z.boolean(),
  })
  .passthrough()

export type GitHubPullRequestState = "open" | "draft" | "merged" | "closed"
export type GitHubReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"

const pullRequestStateSchema = z.enum(["open", "draft", "merged", "closed"])
const reviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
])

/** The checks on the head commit, by outcome. */
export interface GitHubCheckSummary {
  total: number
  passed: number
  failed: number
  pending: number
  skipped: number
}

const checkSummarySchema: RecordSchema<GitHubCheckSummary> = z
  .object({
    total: count,
    passed: count,
    failed: count,
    pending: count,
    skipped: count,
  })
  .passthrough()

/** A pull request as the Pull Requests page lists it. */
export interface GitHubPullRequestSummary {
  number: number
  title: string
  url: string
  state: GitHubPullRequestState
  author: string | null
  authorIsBot: boolean
  headBranch: string
  baseBranch: string
  /** From a fork: the head branch lives in another repository. */
  isCrossRepository: boolean
  createdAt: string | null
  updatedAt: string | null
  reviewDecision: GitHubReviewDecision | null
  /** The signed-in user is asked to review it. */
  reviewRequested: boolean
  checks: GitHubCheckSummary
  additions: number
  deletions: number
  labels: string[]
}

const summaryShape = {
  number: count,
  title: text,
  url: text,
  state: pullRequestStateSchema,
  author: text.nullable(),
  authorIsBot: z.boolean(),
  headBranch: text,
  baseBranch: text,
  isCrossRepository: z.boolean(),
  createdAt: text.nullable(),
  updatedAt: text.nullable(),
  reviewDecision: reviewDecisionSchema.nullable(),
  reviewRequested: z.boolean(),
  checks: checkSummarySchema,
  additions: count,
  deletions: count,
  labels: z.array(text),
}

const pullRequestSummarySchema: RecordSchema<GitHubPullRequestSummary> = z
  .object(summaryShape)
  .passthrough()

export interface GitHubRepositoryPullRequests {
  /** The project folder the repository was read through. */
  cwd: string
  slug: string | null
  status: GitHubAccessStatus
  message: string | null
  pullRequests: GitHubPullRequestSummary[]
  fetchedAt: string | null
}

export interface GitHubPullRequestOverview {
  viewerLogin: string | null
  repositories: GitHubRepositoryPullRequests[]
}

const overviewSchema: RecordSchema<GitHubPullRequestOverview> = z
  .object({
    viewerLogin: text.nullable(),
    repositories: z.array(
      z
        .object({
          cwd: text,
          slug: text.nullable(),
          status: accessStatusSchema,
          message: text.nullable(),
          pullRequests: z.array(pullRequestSummarySchema),
          fetchedAt: text.nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough()

export type GitHubCheckStatus =
  | "pass"
  | "fail"
  | "pending"
  | "skipped"
  | "neutral"
  | "cancelled"

export interface GitHubCheckRun {
  name: string
  /** The Actions workflow, when the check is a workflow job. */
  workflow: string | null
  status: GitHubCheckStatus
  url: string | null
  startedAt: string | null
  completedAt: string | null
}

const checkRunSchema: RecordSchema<GitHubCheckRun> = z
  .object({
    name: text,
    workflow: text.nullable(),
    status: z.enum([
      "pass",
      "fail",
      "pending",
      "skipped",
      "neutral",
      "cancelled",
    ]),
    url: text.nullable(),
    startedAt: text.nullable(),
    completedAt: text.nullable(),
  })
  .passthrough()

export type GitHubReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending"

/** An issue comment or a review on the pull request's conversation. */
export interface GitHubConversationItem {
  id: string
  kind: "comment" | "review"
  author: string | null
  authorIsBot: boolean
  /** `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, … */
  authorAssociation: string | null
  body: string
  createdAt: string | null
  reviewState: GitHubReviewState | null
  url: string | null
}

const conversationItemSchema: RecordSchema<GitHubConversationItem> = z
  .object({
    id: text,
    kind: z.enum(["comment", "review"]),
    author: text.nullable(),
    authorIsBot: z.boolean(),
    authorAssociation: text.nullable(),
    body: text,
    createdAt: text.nullable(),
    reviewState: z
      .enum([
        "approved",
        "changes_requested",
        "commented",
        "dismissed",
        "pending",
      ])
      .nullable(),
    url: text.nullable(),
  })
  .passthrough()

export interface GitHubChangedFile {
  path: string
  additions: number
  deletions: number
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  body: string
  bodyTruncated: boolean
  headSha: string | null
  mergeable: "mergeable" | "conflicting" | "unknown"
  /** GitHub's merge state (`CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, …). */
  mergeStateStatus: string | null
  mergedAt: string | null
  closedAt: string | null
  changedFiles: number
  checkRuns: GitHubCheckRun[]
  files: GitHubChangedFile[]
  /** Oldest first; the newest items when the conversation was cut. */
  conversation: GitHubConversationItem[]
  conversationTruncated: boolean
  viewerIsAuthor: boolean
  repository: GitHubRepositoryInfo
}

const pullRequestDetailSchema: RecordSchema<GitHubPullRequestDetail> = z
  .object({
    ...summaryShape,
    body: text,
    bodyTruncated: z.boolean(),
    headSha: text.nullable(),
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
    mergeStateStatus: text.nullable(),
    mergedAt: text.nullable(),
    closedAt: text.nullable(),
    changedFiles: count,
    checkRuns: z.array(checkRunSchema),
    files: z.array(
      z.object({ path: text, additions: count, deletions: count }).passthrough()
    ),
    conversation: z.array(conversationItemSchema),
    conversationTruncated: z.boolean(),
    viewerIsAuthor: z.boolean(),
    repository: repositoryInfoSchema,
  })
  .passthrough()

/** The pull request's unified diff, cut on a line boundary when large. */
export interface GitHubPullRequestDiff {
  diff: string
  truncated: boolean
  totalBytes: number
}

const pullRequestDiffSchema: RecordSchema<GitHubPullRequestDiff> = z
  .object({ diff: text, truncated: z.boolean(), totalBytes: count })
  .passthrough()

export interface GitHubBranchComparison {
  base: string
  /** The ref compared against (`origin/main`), or null when none exists locally. */
  baseRef: string | null
  head: string
  /** Commits on the head that the base does not have. */
  ahead: number
  /** One commit subject per line, newest first. */
  commits: string
  diffStat: string
  patch: string
  patchTruncated: boolean
}

const branchComparisonSchema: RecordSchema<GitHubBranchComparison> = z
  .object({
    base: text,
    baseRef: text.nullable(),
    head: text,
    ahead: count,
    commits: text,
    diffStat: text,
    patch: text,
    patchTruncated: z.boolean(),
  })
  .passthrough()

/** A pull request as the sidebar links it to a chat (by its head branch). */
export interface GitHubPullRequestLink {
  number: number
  title: string
  url: string
  state: GitHubPullRequestState
  branch: string
  updatedAt: string | null
}

export interface GitHubPullRequestCreateResult {
  /** False when the branch already had an open pull request, returned instead. */
  created: boolean
  pullRequest: GitHubPullRequestLink
}

const pullRequestCreateResultSchema: RecordSchema<GitHubPullRequestCreateResult> =
  z
    .object({
      created: z.boolean(),
      pullRequest: z
        .object({
          number: count,
          title: text,
          url: text,
          state: pullRequestStateSchema,
          branch: text,
          updatedAt: text.nullable(),
        })
        .passthrough(),
    })
    .passthrough()

export interface GitHubPullRequestActionResult {
  ok: true
  /** What `gh` reported, when it said something worth showing. */
  message: string | null
}

const actionResultSchema: RecordSchema<GitHubPullRequestActionResult> = z
  .object({ ok: z.literal(true), message: text.nullable() })
  .passthrough()

/**
 * Where a chat can work on a pull request: a new worktree on its branch, or
 * the project folder when that branch is already checked out there.
 */
export interface GitHubPullRequestWorkResult {
  mode: "worktree" | "project"
  path: string
  branch: string
  baseBranch: string
  worktreeId: string | null
  headSha: string | null
  /** From a fork: pushing the local branch does not update the pull request. */
  crossRepository: boolean
}

const workResultSchema: RecordSchema<GitHubPullRequestWorkResult> = z
  .object({
    mode: z.enum(["worktree", "project"]),
    path: text,
    branch: text,
    baseBranch: text,
    worktreeId: text.nullable(),
    headSha: text.nullable(),
    crossRepository: z.boolean(),
  })
  .passthrough()

export type GitHubPullRequestWatchState =
  | "watching"
  | "waiting"
  | "stopped"
  | "error"

/** A chat's wake-ups on the pull request of its branch. */
export interface GitHubPullRequestWatch {
  threadId: string
  enabled: boolean
  state: GitHubPullRequestWatchState
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  message: string | null
  lastCheckedAt: string | null
  lastWokeAt: string | null
}

const watchSchema: RecordSchema<GitHubPullRequestWatch> = z
  .object({
    threadId: text,
    enabled: z.boolean(),
    state: z.enum(["watching", "waiting", "stopped", "error"]),
    pullRequestNumber: count.nullable(),
    pullRequestUrl: text.nullable(),
    message: text.nullable(),
    lastCheckedAt: text.nullable(),
    lastWokeAt: text.nullable(),
  })
  .passthrough()

/** A message for a chat, waiting for the desktop to send it. */
export interface GitHubWakeNotice {
  id: string
  threadId: string
  createdAt: string
  pullRequestNumber: number | null
  /** One line for a notification ("Checks failed on #12"). */
  title: string
  /** The message the chat receives. */
  text: string
}

const wakeNoticeSchema: RecordSchema<GitHubWakeNotice> = z
  .object({
    id: text,
    threadId: text,
    createdAt: text,
    pullRequestNumber: count.nullable(),
    title: text,
    text: text,
  })
  .passthrough()

export interface GitHubPullRequestWatchList {
  watches: GitHubPullRequestWatch[]
  notices: GitHubWakeNotice[]
}

const watchListSchema: RecordSchema<GitHubPullRequestWatchList> = z
  .object({
    watches: z.array(watchSchema),
    notices: z.array(wakeNoticeSchema),
  })
  .passthrough()

export const githubHttpContracts = {
  githubRepository: endpoint(
    "POST",
    "/github/repository",
    githubCwdSchema,
    repositoryInfoSchema
  ),
  githubPullRequestOverview: endpoint(
    "POST",
    "/github/pull-requests/overview",
    githubPullRequestOverviewSchema,
    overviewSchema
  ),
  githubBranchCompare: endpoint(
    "POST",
    "/github/pull-requests/compare",
    githubBranchCompareSchema,
    branchComparisonSchema
  ),
  githubPullRequestCreate: endpoint(
    "POST",
    "/github/pull-requests/create",
    githubPullRequestCreateSchema,
    pullRequestCreateResultSchema
  ),
  githubPullRequestDetail: endpoint(
    "POST",
    "/github/pull-requests/detail",
    githubPullRequestRefSchema,
    pullRequestDetailSchema
  ),
  githubPullRequestDiff: endpoint(
    "POST",
    "/github/pull-requests/diff",
    githubPullRequestRefSchema,
    pullRequestDiffSchema
  ),
  githubPullRequestComment: endpoint(
    "POST",
    "/github/pull-requests/comment",
    githubPullRequestCommentSchema,
    actionResultSchema
  ),
  githubPullRequestReview: endpoint(
    "POST",
    "/github/pull-requests/review",
    githubPullRequestReviewSchema,
    actionResultSchema
  ),
  githubPullRequestMerge: endpoint(
    "POST",
    "/github/pull-requests/merge",
    githubPullRequestMergeSchema,
    actionResultSchema
  ),
  githubPullRequestState: endpoint(
    "POST",
    "/github/pull-requests/state",
    githubPullRequestStateSchema,
    actionResultSchema
  ),
  githubPullRequestWork: endpoint(
    "POST",
    "/github/pull-requests/work",
    githubPullRequestWorkSchema,
    workResultSchema
  ),
  // Desktop host only: the desktop window sends the waiting messages.
  githubPullRequestWatchList: endpoint(
    "GET",
    "/github/pull-requests/watch",
    noBody,
    watchListSchema
  ),
  githubPullRequestWatchSet: endpoint(
    "POST",
    "/github/pull-requests/watch",
    githubPullRequestWatchSetSchema,
    z.object({ watch: watchSchema.nullable() }).passthrough()
  ),
  githubPullRequestWatchClaim: endpoint(
    "POST",
    "/github/pull-requests/watch/claim",
    githubPullRequestWatchClaimSchema,
    z.object({ notice: wakeNoticeSchema.nullable() }).passthrough()
  ),
} as const
