import type {
  GitHubAccessStatus,
  GitHubBranchComparison,
  GitHubPullRequestActionResult,
  GitHubPullRequestCreateResult,
  GitHubPullRequestDetail,
  GitHubPullRequestDiff,
  GitHubPullRequestOverview,
  GitHubPullRequestSummary,
  GitHubRepositoryInfo,
  GitHubRepositoryPullRequests,
} from "@betterc0de/schema/http-contracts"
import { HttpError } from "../errors"
import { boundDisplayDiff, DISPLAY_DIFF_MAX_BYTES } from "./git/diff"
import { gitRun } from "./git/process"
import { validateGitRefName } from "./git/refs"
import { listBranches } from "./git/status"
import {
  GH_MISSING_MESSAGE,
  GH_MUTATION_TIMEOUT_MS,
  GH_SIGNED_OUT_MESSAGE,
  ghFailureError,
  ghMissingError,
  NO_GITHUB_REMOTE_MESSAGE,
  noGitHubRemoteError,
  parseGhJson,
  resolveGh,
  runGh,
  runGhResult,
  withBodyFile,
} from "./github-cli"
import {
  findPullRequestUrl,
  isPullRequestAlreadyExists,
  parsePullRequestDetail,
  parsePullRequestSummaries,
  parseRepositoryFields,
  PULL_REQUEST_DETAIL_FIELDS,
  PULL_REQUEST_LIST_FIELDS,
  readPullRequestState,
} from "./github-pull-request-data"
import {
  githubRemote,
  invalidatePullRequests,
  type GitHubRemote,
} from "./github-pull-requests"

/**
 * Pull requests read and changed through the user's GitHub CLI: the
 * repository's settings, the open pull requests of several projects, one
 * pull request's page and diff, and creating, commenting, reviewing,
 * merging, closing and reopening. Callers confine `cwd` to a registered
 * workspace first; mutations also need the workspace to be trusted.
 *
 * Reads are cached briefly per repository (the Pull Requests page and the
 * wake-up watcher both read), bounded in count, and refreshed after this
 * backend changes a pull request.
 */

const OVERVIEW_TTL_MS = 60_000
const REPOSITORY_TTL_MS = 10 * 60_000
const VIEWER_TTL_MS = 10 * 60_000
const VIEWER_FAILURE_TTL_MS = 60_000
const MAX_CACHED = 64
const OVERVIEW_CONCURRENCY = 4
const OVERVIEW_LIMIT = 50
const LIST_MAX_BYTES = 2 * 1024 * 1024
const DETAIL_MAX_BYTES = 4 * 1024 * 1024
const COMPARE_MAX_COMMITS = 50
const COMPARE_SUMMARY_MAX_CHARS = 12_000
const COMPARE_PATCH_MAX_CHARS = 40_000

interface Cached<T> {
  value: T
  expiresAt: number
}

function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_CACHED) {
    map.delete(map.keys().next().value!)
  }
  map.set(key, value)
}

let viewerCache: Cached<string | null> | null = null
let viewerPending: Promise<string | null> | null = null

/** The signed-in GitHub user, or null when `gh` cannot say. */
export async function viewerLogin(): Promise<string | null> {
  if (viewerCache && viewerCache.expiresAt > Date.now())
    return viewerCache.value
  if (viewerPending) return viewerPending
  viewerPending = (async () => {
    let login: string | null = null
    try {
      const { stdout } = await runGh(["api", "user"])
      const user = parseGhJson(stdout) as { login?: unknown } | null
      login =
        user && typeof user.login === "string" && user.login ? user.login : null
    } catch {
      login = null
    }
    viewerCache = {
      value: login,
      expiresAt: Date.now() + (login ? VIEWER_TTL_MS : VIEWER_FAILURE_TTL_MS),
    }
    return login
  })().finally(() => {
    viewerPending = null
  })
  return viewerPending
}

/** The public status and message for a failed `gh` read. */
function accessFailure(error: unknown): {
  status: GitHubAccessStatus
  message: string
} {
  if (error instanceof HttpError) {
    if (error.code === "github_cli_missing")
      return { status: "gh_missing", message: GH_MISSING_MESSAGE }
    if (error.code === "github_cli_signed_out")
      return { status: "gh_signed_out", message: GH_SIGNED_OUT_MESSAGE }
    if (error.code === "github_no_remote")
      return { status: "no_remote", message: NO_GITHUB_REMOTE_MESSAGE }
    return { status: "error", message: error.message }
  }
  return { status: "error", message: "GitHub CLI failed." }
}

function emptyRepositoryInfo(
  status: GitHubAccessStatus,
  message: string | null,
  remote: GitHubRemote | null
): GitHubRepositoryInfo {
  return {
    status,
    message,
    slug: remote?.slug ?? null,
    remote: remote?.name ?? null,
    url: remote ? `https://github.com/${remote.slug}` : null,
    defaultBranch: null,
    viewerLogin: null,
    viewerPermission: null,
    mergeMethods: { merge: true, squash: true, rebase: true },
    deleteBranchOnMerge: false,
  }
}

const repositoryCache = new Map<string, Cached<GitHubRepositoryInfo>>()

/**
 * The repository's GitHub settings (default branch, allowed merge methods)
 * and whether `gh` can reach it. Never throws for a missing CLI, sign-in or
 * remote: the status says which, with what to do.
 */
export async function readRepositoryInfo(
  cwd: string,
  options: { refresh?: boolean } = {}
): Promise<GitHubRepositoryInfo> {
  const remote = await githubRemote(cwd)
  if (!remote)
    return emptyRepositoryInfo("no_remote", NO_GITHUB_REMOTE_MESSAGE, null)
  if (!resolveGh())
    return emptyRepositoryInfo("gh_missing", GH_MISSING_MESSAGE, remote)
  const key = `${remote.slug.toLowerCase()}|${remote.name}`
  const cached = repositoryCache.get(key)
  if (!options.refresh && cached && cached.expiresAt > Date.now())
    return cached.value
  let info: GitHubRepositoryInfo
  try {
    const { stdout } = await runGh([
      "repo",
      "view",
      remote.slug,
      "--json",
      "url,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge,viewerPermission",
    ])
    const fields = parseRepositoryFields(parseGhJson(stdout))
    info = {
      ...emptyRepositoryInfo("ok", null, remote),
      ...fields,
      url: fields.url ?? `https://github.com/${remote.slug}`,
      viewerLogin: await viewerLogin(),
    }
    boundedSet(repositoryCache, key, {
      value: info,
      expiresAt: Date.now() + REPOSITORY_TTL_MS,
    })
  } catch (error) {
    const failure = accessFailure(error)
    info = emptyRepositoryInfo(failure.status, failure.message, remote)
  }
  return info
}

/** The repository behind `cwd` for a pull request action; throws what is missing. */
export async function requireRepository(cwd: string): Promise<GitHubRemote> {
  const remote = await githubRemote(cwd)
  if (!remote) throw noGitHubRemoteError()
  if (!resolveGh()) throw ghMissingError()
  return remote
}

const overviewCache = new Map<
  string,
  Cached<{ pullRequests: GitHubPullRequestSummary[]; fetchedAt: string }>
>()

async function openPullRequests(
  slug: string,
  viewer: string | null,
  refresh: boolean
): Promise<{ pullRequests: GitHubPullRequestSummary[]; fetchedAt: string }> {
  const key = `${slug.toLowerCase()}|${viewer ?? ""}`
  const cached = overviewCache.get(key)
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value
  const { stdout } = await runGh(
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--state",
      "open",
      "--limit",
      String(OVERVIEW_LIMIT),
      "--json",
      PULL_REQUEST_LIST_FIELDS,
    ],
    { maxOutputBytes: LIST_MAX_BYTES }
  )
  const value = {
    pullRequests: parsePullRequestSummaries(parseGhJson(stdout), viewer),
    fetchedAt: new Date().toISOString(),
  }
  boundedSet(overviewCache, key, {
    value,
    expiresAt: Date.now() + OVERVIEW_TTL_MS,
  })
  return value
}

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index]!)
      }
    }
  )
  await Promise.all(workers)
  return results
}

/**
 * The open pull requests of every repository behind `cwds` (already
 * confined), one entry per repository: two folders of one repository (a
 * worktree and its project) are read once.
 */
export async function readPullRequestOverview(
  cwds: readonly string[],
  options: { refresh?: boolean } = {}
): Promise<GitHubPullRequestOverview> {
  const remotes = await mapLimited(cwds, OVERVIEW_CONCURRENCY, (cwd) =>
    githubRemote(cwd)
  )
  const bySlug = new Map<string, { cwd: string; remote: GitHubRemote }>()
  const withoutRemote: GitHubRepositoryPullRequests[] = []
  cwds.forEach((cwd, index) => {
    const remote = remotes[index]
    if (!remote) {
      withoutRemote.push({
        cwd,
        slug: null,
        status: "no_remote",
        message: NO_GITHUB_REMOTE_MESSAGE,
        pullRequests: [],
        fetchedAt: null,
      })
      return
    }
    const key = remote.slug.toLowerCase()
    if (!bySlug.has(key)) bySlug.set(key, { cwd, remote })
  })
  const repositories = [...bySlug.values()]
  if (repositories.length > 0 && !resolveGh()) {
    return {
      viewerLogin: null,
      repositories: [
        ...repositories.map(({ cwd, remote }) => ({
          cwd,
          slug: remote.slug,
          status: "gh_missing" as const,
          message: GH_MISSING_MESSAGE,
          pullRequests: [],
          fetchedAt: null,
        })),
        ...withoutRemote,
      ],
    }
  }
  const viewer = repositories.length > 0 ? await viewerLogin() : null
  const read = await mapLimited(
    repositories,
    OVERVIEW_CONCURRENCY,
    async ({ cwd, remote }): Promise<GitHubRepositoryPullRequests> => {
      try {
        const list = await openPullRequests(
          remote.slug,
          viewer,
          options.refresh === true
        )
        return {
          cwd,
          slug: remote.slug,
          status: "ok",
          message: null,
          pullRequests: list.pullRequests,
          fetchedAt: list.fetchedAt,
        }
      } catch (error) {
        const failure = accessFailure(error)
        return {
          cwd,
          slug: remote.slug,
          status: failure.status,
          message: failure.message,
          pullRequests: [],
          fetchedAt: null,
        }
      }
    }
  )
  return { viewerLogin: viewer, repositories: [...read, ...withoutRemote] }
}

function forgetPullRequests(slug: string): void {
  invalidatePullRequests(slug)
  const prefix = `${slug.toLowerCase()}|`
  for (const key of [...overviewCache.keys()]) {
    if (key.startsWith(prefix)) overviewCache.delete(key)
  }
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await gitRun(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
    return true
  } catch {
    return false
  }
}

/**
 * What a pull request from the checked-out branch into `base` would carry:
 * its commits, diff stat and (bounded) patch, against the remote's copy of
 * `base` when this checkout has one. Read-only: nothing is fetched.
 */
export async function compareBranch(input: {
  cwd: string
  base: string
  includeWorkingTree?: boolean
}): Promise<GitHubBranchComparison> {
  const base = validateGitRefName(input.base, "Base branch")
  const head = (await listBranches(input.cwd)).current
  const remote = await githubRemote(input.cwd)
  const candidates = [
    ...(remote
      ? [
          {
            ref: `refs/remotes/${remote.name}/${base}`,
            label: `${remote.name}/${base}`,
          },
        ]
      : []),
    { ref: `refs/heads/${base}`, label: base },
  ]
  let baseRef: { ref: string; label: string } | null = null
  for (const candidate of candidates) {
    if (await refExists(input.cwd, candidate.ref)) {
      baseRef = candidate
      break
    }
  }
  const diffTarget = input.includeWorkingTree ? [] : ["HEAD"]
  if (!baseRef) {
    // No base to compare with: only uncommitted work can be described.
    const readDiff = async (args: string[]) =>
      input.includeWorkingTree
        ? ((await gitRun(input.cwd, args).catch(() => null))?.stdout ?? "")
        : ""
    const patch = await readDiff(["diff", "--no-color", "HEAD"])
    const stat = await readDiff(["diff", "--no-color", "--stat", "HEAD"])
    return {
      base,
      baseRef: null,
      head,
      ahead: 0,
      commits: "",
      diffStat: bounded(stat, COMPARE_SUMMARY_MAX_CHARS),
      patch: bounded(patch, COMPARE_PATCH_MAX_CHARS),
      patchTruncated: patch.length > COMPARE_PATCH_MAX_CHARS,
    }
  }
  const range = `${baseRef.ref}..HEAD`
  // Histories without a common commit compare against the base itself.
  const mergeBase =
    (
      await gitRun(input.cwd, ["merge-base", baseRef.ref, "HEAD"]).catch(
        () => null
      )
    )?.stdout.trim() || baseRef.ref
  const [aheadOut, logOut, statOut, patchOut] = await Promise.all([
    gitRun(input.cwd, ["rev-list", "--count", range]),
    gitRun(input.cwd, [
      "log",
      "--no-color",
      "--no-merges",
      `--max-count=${COMPARE_MAX_COMMITS}`,
      "--format=%h %s",
      range,
    ]),
    gitRun(input.cwd, [
      "diff",
      "--no-color",
      "--stat",
      mergeBase,
      ...diffTarget,
    ]),
    gitRun(input.cwd, ["diff", "--no-color", mergeBase, ...diffTarget]),
  ])
  const patch = patchOut.stdout
  return {
    base,
    baseRef: baseRef.label,
    head,
    ahead: Number.parseInt(aheadOut.stdout.trim(), 10) || 0,
    commits: bounded(logOut.stdout.trim(), COMPARE_SUMMARY_MAX_CHARS),
    diffStat: bounded(statOut.stdout.trim(), COMPARE_SUMMARY_MAX_CHARS),
    patch: bounded(patch, COMPARE_PATCH_MAX_CHARS),
    patchTruncated: patch.length > COMPARE_PATCH_MAX_CHARS,
  }
}

/**
 * `gh pr create` from `head` into `base`. A branch that already has an open
 * pull request answers with that one (`created: false`) instead of failing.
 */
export async function createPullRequest(input: {
  cwd: string
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
}): Promise<GitHubPullRequestCreateResult> {
  const remote = await requireRepository(input.cwd)
  const head = validateGitRefName(input.head, "Branch")
  const base = validateGitRefName(input.base, "Base branch")
  const title = input.title.replace(/[\r\n]+/g, " ").trim()
  if (head === base) {
    throw new HttpError(
      400,
      "The branch and the base branch are the same. Create a branch for your changes first.",
      "github_same_branch"
    )
  }
  const result = await withBodyFile(input.body, (file) =>
    runGhResult(
      [
        "pr",
        "create",
        "--repo",
        remote.slug,
        "--head",
        head,
        "--base",
        base,
        // Joined, so a title that starts with "-" is never read as a flag.
        `--title=${title}`,
        "--body-file",
        file,
        ...(input.draft ? ["--draft"] : []),
      ],
      { timeoutMs: GH_MUTATION_TIMEOUT_MS }
    )
  )
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status === 0) {
    const created =
      findPullRequestUrl(result.stdout) ?? findPullRequestUrl(output)
    if (!created) {
      throw new HttpError(
        502,
        "GitHub created the pull request but didn't say where. Check the repository on GitHub.",
        "github_cli_failed"
      )
    }
    forgetPullRequests(remote.slug)
    return {
      created: true,
      pullRequest: {
        number: created.number,
        title,
        url: created.url,
        state: input.draft ? "draft" : "open",
        branch: head,
        updatedAt: new Date().toISOString(),
      },
    }
  }
  const existing = isPullRequestAlreadyExists(output)
    ? findPullRequestUrl(output)
    : null
  if (!existing) throw ghFailureError(result)
  forgetPullRequests(remote.slug)
  let existingTitle = title
  let existingState: GitHubPullRequestCreateResult["pullRequest"]["state"] =
    "open"
  let updatedAt: string | null = null
  try {
    const { stdout } = await runGh([
      "pr",
      "view",
      String(existing.number),
      "--repo",
      remote.slug,
      "--json",
      "title,state,isDraft,updatedAt",
    ])
    const row = parseGhJson(stdout) as Record<string, unknown> | null
    if (row && typeof row === "object") {
      if (typeof row.title === "string" && row.title) existingTitle = row.title
      existingState = readPullRequestState(row)
      updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : null
    }
  } catch {
    // The link is what matters; the title is a nicety.
  }
  return {
    created: false,
    pullRequest: {
      number: existing.number,
      title: existingTitle,
      url: existing.url,
      state: existingState,
      branch: head,
      updatedAt,
    },
  }
}

async function repositoryForRead(cwd: string): Promise<GitHubRepositoryInfo> {
  const info = await readRepositoryInfo(cwd)
  if (info.status === "ok" && info.slug) return info
  switch (info.status) {
    case "gh_missing":
      throw ghMissingError()
    case "no_remote":
      throw noGitHubRemoteError()
    case "gh_signed_out":
      throw new HttpError(412, GH_SIGNED_OUT_MESSAGE, "github_cli_signed_out")
    default:
      throw new HttpError(
        502,
        info.message ?? "GitHub CLI failed.",
        "github_cli_failed"
      )
  }
}

/** One pull request's page: description, checks, files and conversation. */
export async function readPullRequestDetail(
  cwd: string,
  number: number
): Promise<GitHubPullRequestDetail> {
  const repository = await repositoryForRead(cwd)
  const result = await runGh(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      repository.slug!,
      "--json",
      PULL_REQUEST_DETAIL_FIELDS,
    ],
    { maxOutputBytes: DETAIL_MAX_BYTES, timeoutMs: 30_000 }
  )
  if (result.stdoutTruncated) {
    throw new HttpError(
      413,
      "This pull request is too large to show here. Open it on GitHub.",
      "github_pull_request_too_large"
    )
  }
  const detail = parsePullRequestDetail(parseGhJson(result.stdout), {
    viewerLogin: repository.viewerLogin,
    repository,
  })
  if (!detail) {
    throw new HttpError(
      502,
      "GitHub CLI returned a pull request this version can't read.",
      "github_cli_failed"
    )
  }
  return detail
}

/** The pull request's unified diff, cut on a line boundary when large. */
export async function readPullRequestDiff(
  cwd: string,
  number: number
): Promise<GitHubPullRequestDiff> {
  const remote = await requireRepository(cwd)
  const result = await runGh(
    ["pr", "diff", String(number), "--repo", remote.slug, "--color", "never"],
    { maxOutputBytes: DISPLAY_DIFF_MAX_BYTES + 1, timeoutMs: 45_000 }
  )
  const bounded = boundDisplayDiff(result.stdout)
  return result.stdoutTruncated ? { ...bounded, truncated: true } : bounded
}

function actionResult(output: string): GitHubPullRequestActionResult {
  const message = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return { ok: true, message: message ? bounded(message, 300) : null }
}

export async function commentOnPullRequest(input: {
  cwd: string
  number: number
  body: string
}): Promise<GitHubPullRequestActionResult> {
  const remote = await requireRepository(input.cwd)
  const result = await withBodyFile(input.body, (file) =>
    runGh(
      [
        "pr",
        "comment",
        String(input.number),
        "--repo",
        remote.slug,
        "--body-file",
        file,
      ],
      { timeoutMs: GH_MUTATION_TIMEOUT_MS }
    )
  )
  forgetPullRequests(remote.slug)
  return actionResult(result.stdout)
}

export async function reviewPullRequest(input: {
  cwd: string
  number: number
  event: "approve" | "request_changes" | "comment"
  body: string
}): Promise<GitHubPullRequestActionResult> {
  const remote = await requireRepository(input.cwd)
  const flag =
    input.event === "approve"
      ? "--approve"
      : input.event === "request_changes"
        ? "--request-changes"
        : "--comment"
  const args = [
    "pr",
    "review",
    String(input.number),
    "--repo",
    remote.slug,
    flag,
  ]
  const result = input.body.trim()
    ? await withBodyFile(input.body, (file) =>
        runGh([...args, "--body-file", file], {
          timeoutMs: GH_MUTATION_TIMEOUT_MS,
        })
      )
    : await runGh(args, { timeoutMs: GH_MUTATION_TIMEOUT_MS })
  forgetPullRequests(remote.slug)
  return actionResult(`${result.stdout}\n${result.stderr}`)
}

export async function mergePullRequest(input: {
  cwd: string
  number: number
  method: "merge" | "squash" | "rebase"
  deleteBranch?: boolean
  headSha?: string
}): Promise<GitHubPullRequestActionResult> {
  const repository = await repositoryForRead(input.cwd)
  if (!repository.mergeMethods[input.method]) {
    throw new HttpError(
      400,
      `This repository doesn't allow ${input.method === "merge" ? "merge commits" : `${input.method} merges`}.`,
      "github_merge_method_not_allowed"
    )
  }
  // With `--repo`, gh deletes only the remote branch; the local checkout is
  // left alone.
  const result = await runGh(
    [
      "pr",
      "merge",
      String(input.number),
      "--repo",
      repository.slug!,
      `--${input.method}`,
      ...(input.deleteBranch ? ["--delete-branch"] : []),
      ...(input.headSha ? ["--match-head-commit", input.headSha] : []),
    ],
    { timeoutMs: GH_MUTATION_TIMEOUT_MS }
  )
  forgetPullRequests(repository.slug!)
  return actionResult(`${result.stdout}\n${result.stderr}`)
}

export async function setPullRequestState(input: {
  cwd: string
  number: number
  action: "close" | "reopen"
}): Promise<GitHubPullRequestActionResult> {
  const remote = await requireRepository(input.cwd)
  const result = await runGh(
    ["pr", input.action, String(input.number), "--repo", remote.slug],
    { timeoutMs: GH_MUTATION_TIMEOUT_MS }
  )
  forgetPullRequests(remote.slug)
  return actionResult(`${result.stdout}\n${result.stderr}`)
}

/** What a chat needs to work on a pull request locally. */
export interface PullRequestCheckout {
  number: number
  /** The local branch the worktree checks out. */
  branch: string
  baseBranch: string
  crossRepository: boolean
  headSha: string | null
}

/**
 * Fetches the pull request's head into this repository and makes sure a
 * local branch of it exists: the head branch itself for a branch of this
 * repository (so a push updates the pull request), `pr-<number>` for one
 * from a fork. An existing local branch is kept as it is, never reset.
 */
export async function preparePullRequestBranch(
  cwd: string,
  number: number
): Promise<PullRequestCheckout> {
  const remote = await requireRepository(cwd)
  const { stdout } = await runGh([
    "pr",
    "view",
    String(number),
    "--repo",
    remote.slug,
    "--json",
    "number,headRefName,baseRefName,headRefOid,isCrossRepository",
  ])
  const row = parseGhJson(stdout) as Record<string, unknown> | null
  const headRefName =
    row && typeof row.headRefName === "string" ? row.headRefName : ""
  const baseBranch =
    row && typeof row.baseRefName === "string" ? row.baseRefName : ""
  if (!headRefName || !baseBranch) {
    throw new HttpError(
      502,
      "GitHub CLI didn't return the pull request's branches.",
      "github_cli_failed"
    )
  }
  const crossRepository = row?.isCrossRepository === true
  const headSha =
    row && typeof row.headRefOid === "string" ? row.headRefOid : null
  const branch = crossRepository
    ? `pr-${number}`
    : validateGitRefName(headRefName, "Branch")
  const remoteRef = crossRepository
    ? `refs/remotes/${remote.name}/pr/${number}`
    : `refs/remotes/${remote.name}/${branch}`
  const source = crossRepository
    ? `refs/pull/${number}/head`
    : `refs/heads/${branch}`
  try {
    await gitRun(
      cwd,
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        remote.name,
        `+${source}:${remoteRef}`,
      ],
      { timeoutMs: 60_000 }
    )
  } catch {
    throw new HttpError(
      502,
      "Couldn't fetch the pull request's branch. Check your connection and Git credentials, then try again.",
      "git_remote_error"
    )
  }
  if (!(await refExists(cwd, `refs/heads/${branch}`))) {
    await gitRun(cwd, [
      "branch",
      crossRepository ? "--no-track" : "--track",
      branch,
      remoteRef,
    ])
  }
  return { number, branch, baseBranch, crossRepository, headSha }
}
