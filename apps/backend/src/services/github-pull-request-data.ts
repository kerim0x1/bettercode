import type {
  GitHubChangedFile,
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubCheckSummary,
  GitHubConversationItem,
  GitHubPullRequestDetail,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubRepositoryInfo,
  GitHubReviewDecision,
  GitHubReviewState,
} from "@betterc0de/schema/http-contracts"

/**
 * Pure mapping of what `gh ... --json` prints into the Pull Requests read
 * models. Anything malformed is skipped or read as unknown rather than
 * failing the whole answer, and every free-text field is bounded: a pull
 * request's body and conversation come from anyone who can comment.
 */

/** The fields `gh pr list` is asked for (Pull Requests page). */
export const PULL_REQUEST_LIST_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "baseRefName",
  "isCrossRepository",
  "createdAt",
  "updatedAt",
  "reviewDecision",
  "reviewRequests",
  "statusCheckRollup",
  "additions",
  "deletions",
  "labels",
].join(",")

/** The fields `gh pr view` is asked for (a pull request's page). */
export const PULL_REQUEST_DETAIL_FIELDS = [
  PULL_REQUEST_LIST_FIELDS,
  "body",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "mergedAt",
  "closedAt",
  "changedFiles",
  "files",
  "comments",
  "reviews",
].join(",")

export const MAX_BODY_CHARS = 64 * 1024
export const MAX_COMMENT_CHARS = 16 * 1024
export const MAX_CONVERSATION_ITEMS = 150
export const MAX_FILES = 3_000
const MAX_LABELS = 20

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

/** `text` cut to `max` characters, and whether it was cut. */
export function boundText(
  value: unknown,
  max: number
): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : ""
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false }
}

export interface GitHubAuthor {
  login: string | null
  isBot: boolean
}

/** `gh` reports users as `{ login, is_bot }`; apps as `app/<name>`. */
export function readAuthor(value: unknown): GitHubAuthor {
  if (!isRow(value)) return { login: null, isBot: false }
  const login = str(value.login)
  const isBot =
    value.is_bot === true ||
    value.type === "Bot" ||
    (login !== null && (login.endsWith("[bot]") || login.startsWith("app/")))
  return { login, isBot }
}

export function readPullRequestState(row: Row): GitHubPullRequestState {
  const state = String(row.state ?? "").toUpperCase()
  if (state === "MERGED") return "merged"
  if (state === "CLOSED") return "closed"
  return row.isDraft === true ? "draft" : "open"
}

export function readReviewDecision(
  value: unknown
): GitHubReviewDecision | null {
  switch (String(value ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "changes_requested"
    case "REVIEW_REQUIRED":
      return "review_required"
    default:
      return null
  }
}

/** A check run or commit status as one outcome. */
export function readCheckStatus(row: Row): GitHubCheckStatus {
  // Commit statuses (`StatusContext`) carry a single state.
  if (row.__typename === "StatusContext" || typeof row.context === "string") {
    switch (String(row.state ?? "").toUpperCase()) {
      case "SUCCESS":
        return "pass"
      case "FAILURE":
      case "ERROR":
        return "fail"
      default:
        return "pending"
    }
  }
  if (String(row.status ?? "").toUpperCase() !== "COMPLETED") return "pending"
  switch (String(row.conclusion ?? "").toUpperCase()) {
    case "SUCCESS":
      return "pass"
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "fail"
    case "CANCELLED":
      return "cancelled"
    case "SKIPPED":
      return "skipped"
    case "NEUTRAL":
    case "STALE":
      return "neutral"
    default:
      return "pending"
  }
}

/** The checks of `statusCheckRollup`, in the order GitHub lists them. */
export function parseCheckRuns(rollup: unknown): GitHubCheckRun[] {
  if (!Array.isArray(rollup)) return []
  const runs: GitHubCheckRun[] = []
  for (const entry of rollup) {
    if (!isRow(entry)) continue
    const name = str(entry.name) ?? str(entry.context)
    if (!name) continue
    runs.push({
      name,
      workflow: str(entry.workflowName),
      status: readCheckStatus(entry),
      url: str(entry.detailsUrl) ?? str(entry.targetUrl),
      startedAt: str(entry.startedAt),
      completedAt: str(entry.completedAt),
    })
  }
  return runs
}

/** Cancelled checks count as failed: they block a required check too. */
export function summarizeChecks(
  runs: readonly GitHubCheckRun[]
): GitHubCheckSummary {
  const summary: GitHubCheckSummary = {
    total: runs.length,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
  }
  for (const run of runs) {
    if (run.status === "pass") summary.passed += 1
    else if (run.status === "fail" || run.status === "cancelled")
      summary.failed += 1
    else if (run.status === "pending") summary.pending += 1
    else summary.skipped += 1
  }
  return summary
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((label) => (isRow(label) ? str(label.name) : null))
    .filter((name): name is string => name !== null)
    .slice(0, MAX_LABELS)
}

/** Whether `login` is one of the users asked to review. */
export function isReviewRequestedFrom(
  requests: unknown,
  login: string | null
): boolean {
  if (!login || !Array.isArray(requests)) return false
  const wanted = login.toLowerCase()
  return requests.some(
    (request) =>
      isRow(request) &&
      typeof request.login === "string" &&
      request.login.toLowerCase() === wanted
  )
}

/** One `gh pr list` / `gh pr view` row as a summary; null when malformed. */
export function readPullRequestSummary(
  row: unknown,
  viewerLogin: string | null
): GitHubPullRequestSummary | null {
  if (!isRow(row)) return null
  const number = row.number
  const url = str(row.url)
  const headBranch = str(row.headRefName)
  if (typeof number !== "number" || !url || !headBranch) return null
  const author = readAuthor(row.author)
  return {
    number,
    title: boundText(row.title, 1_024).text,
    url,
    state: readPullRequestState(row),
    author: author.login,
    authorIsBot: author.isBot,
    headBranch,
    baseBranch: str(row.baseRefName) ?? "",
    isCrossRepository: row.isCrossRepository === true,
    createdAt: str(row.createdAt),
    updatedAt: str(row.updatedAt),
    reviewDecision: readReviewDecision(row.reviewDecision),
    reviewRequested: isReviewRequestedFrom(row.reviewRequests, viewerLogin),
    checks: summarizeChecks(parseCheckRuns(row.statusCheckRollup)),
    additions: num(row.additions),
    deletions: num(row.deletions),
    labels: readLabels(row.labels),
  }
}

/** `gh pr list --json` output; anything malformed is skipped. */
export function parsePullRequestSummaries(
  json: unknown,
  viewerLogin: string | null
): GitHubPullRequestSummary[] {
  if (!Array.isArray(json)) return []
  return json
    .map((row) => readPullRequestSummary(row, viewerLogin))
    .filter((row): row is GitHubPullRequestSummary => row !== null)
}

function readReviewState(value: unknown): GitHubReviewState | null {
  switch (String(value ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "changes_requested"
    case "COMMENTED":
      return "commented"
    case "DISMISSED":
      return "dismissed"
    case "PENDING":
      return "pending"
    default:
      return null
  }
}

/**
 * Issue comments and submitted reviews, oldest first. Pending reviews (the
 * viewer's unsent draft) are left out; only the newest
 * `MAX_CONVERSATION_ITEMS` are kept.
 */
export function parseConversation(
  comments: unknown,
  reviews: unknown
): { items: GitHubConversationItem[]; truncated: boolean } {
  const items: GitHubConversationItem[] = []
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      if (!isRow(comment)) continue
      const author = readAuthor(comment.author)
      items.push({
        id: str(comment.id) ?? `comment-${items.length}`,
        kind: "comment",
        author: author.login,
        authorIsBot: author.isBot,
        authorAssociation: str(comment.authorAssociation),
        body: boundText(comment.body, MAX_COMMENT_CHARS).text,
        createdAt: str(comment.createdAt),
        reviewState: null,
        url: str(comment.url),
      })
    }
  }
  if (Array.isArray(reviews)) {
    for (const review of reviews) {
      if (!isRow(review)) continue
      const reviewState = readReviewState(review.state)
      if (reviewState === "pending") continue
      const author = readAuthor(review.author)
      items.push({
        id: str(review.id) ?? `review-${items.length}`,
        kind: "review",
        author: author.login,
        authorIsBot: author.isBot,
        authorAssociation: str(review.authorAssociation),
        body: boundText(review.body, MAX_COMMENT_CHARS).text,
        createdAt: str(review.submittedAt) ?? str(review.createdAt),
        reviewState,
        url: null,
      })
    }
  }
  items.sort(
    (left, right) =>
      (Date.parse(left.createdAt ?? "") || 0) -
      (Date.parse(right.createdAt ?? "") || 0)
  )
  return items.length > MAX_CONVERSATION_ITEMS
    ? { items: items.slice(-MAX_CONVERSATION_ITEMS), truncated: true }
    : { items, truncated: false }
}

function readFiles(value: unknown): GitHubChangedFile[] {
  if (!Array.isArray(value)) return []
  const files: GitHubChangedFile[] = []
  for (const file of value) {
    if (!isRow(file)) continue
    const path = str(file.path)
    if (!path) continue
    files.push({
      path,
      additions: num(file.additions),
      deletions: num(file.deletions),
    })
    if (files.length >= MAX_FILES) break
  }
  return files
}

function readMergeable(value: unknown): GitHubPullRequestDetail["mergeable"] {
  switch (String(value ?? "").toUpperCase()) {
    case "MERGEABLE":
      return "mergeable"
    case "CONFLICTING":
      return "conflicting"
    default:
      return "unknown"
  }
}

/** `gh pr view --json` output as the pull request's page; null when malformed. */
export function parsePullRequestDetail(
  json: unknown,
  context: { viewerLogin: string | null; repository: GitHubRepositoryInfo }
): GitHubPullRequestDetail | null {
  const summary = readPullRequestSummary(json, context.viewerLogin)
  if (!summary || !isRow(json)) return null
  const body = boundText(json.body, MAX_BODY_CHARS)
  const conversation = parseConversation(json.comments, json.reviews)
  const viewer = context.viewerLogin?.toLowerCase() ?? null
  return {
    ...summary,
    body: body.text,
    bodyTruncated: body.truncated,
    headSha: str(json.headRefOid),
    mergeable: readMergeable(json.mergeable),
    mergeStateStatus: str(json.mergeStateStatus),
    mergedAt: str(json.mergedAt),
    closedAt: str(json.closedAt),
    changedFiles: num(json.changedFiles),
    checkRuns: parseCheckRuns(json.statusCheckRollup),
    files: readFiles(json.files),
    conversation: conversation.items,
    conversationTruncated: conversation.truncated,
    viewerIsAuthor: viewer !== null && summary.author?.toLowerCase() === viewer,
    repository: context.repository,
  }
}

const PULL_REQUEST_URL =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)/g

/** The last pull request URL in `output` (what `gh pr create` prints). */
export function findPullRequestUrl(
  output: string
): { url: string; number: number } | null {
  let found: { url: string; number: number } | null = null
  for (const match of output.matchAll(PULL_REQUEST_URL)) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number) && number > 0) {
      found = { url: match[0], number }
    }
  }
  return found
}

/** `gh pr create` refuses a second pull request for the same branch. */
export function isPullRequestAlreadyExists(output: string): boolean {
  return /already exists/i.test(output)
}

export interface GitHubRepositoryFields {
  defaultBranch: string | null
  viewerPermission: string | null
  mergeMethods: GitHubRepositoryInfo["mergeMethods"]
  deleteBranchOnMerge: boolean
  url: string | null
}

/** `gh repo view --json` output; GitHub's defaults when a field is missing. */
export function parseRepositoryFields(json: unknown): GitHubRepositoryFields {
  const row = isRow(json) ? json : {}
  const defaultBranch = isRow(row.defaultBranchRef)
    ? str(row.defaultBranchRef.name)
    : null
  const merge = row.mergeCommitAllowed !== false
  const squash = row.squashMergeAllowed !== false
  const rebase = row.rebaseMergeAllowed !== false
  return {
    defaultBranch,
    viewerPermission: str(row.viewerPermission),
    // A repository always allows at least one method; if GitHub said none,
    // offer merge and let GitHub answer.
    mergeMethods:
      merge || squash || rebase
        ? { merge, squash, rebase }
        : { merge: true, squash: false, rebase: false },
    deleteBranchOnMerge: row.deleteBranchOnMerge === true,
    url: str(row.url),
  }
}

/** An inline comment on the pull request's diff (REST `pulls/{n}/comments`). */
export interface GitHubReviewComment {
  id: string
  author: string | null
  authorIsBot: boolean
  authorAssociation: string | null
  body: string
  createdAt: string | null
  path: string | null
  line: number | null
  url: string | null
}

/** `gh api repos/{slug}/pulls/{n}/comments` output; malformed rows are skipped. */
export function parseReviewComments(json: unknown): GitHubReviewComment[] {
  if (!Array.isArray(json)) return []
  const comments: GitHubReviewComment[] = []
  for (const row of json) {
    if (!isRow(row)) continue
    const id =
      typeof row.id === "number" || typeof row.id === "string"
        ? String(row.id)
        : null
    if (!id) continue
    const author = readAuthor(row.user)
    const line =
      typeof row.line === "number"
        ? row.line
        : typeof row.original_line === "number"
          ? row.original_line
          : null
    comments.push({
      id,
      author: author.login,
      authorIsBot: author.isBot,
      authorAssociation: str(row.author_association),
      body: boundText(row.body, MAX_COMMENT_CHARS).text,
      createdAt: str(row.created_at),
      path: str(row.path),
      line,
      url: str(row.html_url),
    })
  }
  return comments
}

/** The run and job of an Actions check's details link. */
export function actionsJobFromUrl(
  url: string | null
): { runId: string; jobId: string | null } | null {
  if (!url) return null
  const match =
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(
      url
    )
  return match ? { runId: match[1]!, jobId: match[2] ?? null } : null
}

/**
 * The last lines of `gh run view --log-failed`, without the job and step
 * columns, timestamps and colour codes: what a reader needs to see why the
 * job failed.
 */
export function failedLogTail(
  log: string,
  options: { maxLines?: number; maxChars?: number } = {}
): string {
  const maxLines = options.maxLines ?? 40
  const maxChars = options.maxChars ?? 3_000
  const lines = log
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => {
      // `job<TAB>step<TAB>2026-10-20T10:00:00.0000000Z message`
      const columns = line.split("\t")
      const message = columns.length >= 3 ? columns.slice(2).join("\t") : line
      return message
        .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
        .trimEnd()
    })
    .filter((line) => line.trim().length > 0)
  let tail = lines.slice(-maxLines).join("\n")
  if (tail.length > maxChars) tail = tail.slice(tail.length - maxChars)
  return tail
}
