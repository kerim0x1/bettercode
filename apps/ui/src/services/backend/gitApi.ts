import type {
  GitHunkActionInput,
  GitHunkActionResult,
  GitStatus,
} from "@betterc0de/schema"
import type {
  GitUserProfile,
  GitWorktreeCreateResult,
  GitWorktreeInfo,
  OpenTarget,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"

// Every call goes through its shared contract
// (`@betterc0de/schema/http-contracts`): the request is checked before it is
// sent and the response validated before a caller sees it.

export type { GitUserProfile, GitWorktreeInfo, OpenTarget }

type GitDiffResponse = Record<string, unknown> & {
  diff?: string
  diff_text?: string
  diffText?: string
  /** Server bounded the payload; what arrived is a prefix, not the whole diff. */
  truncated?: boolean
  /** Full size before truncation, so the UI can say how much is hidden. */
  totalBytes?: number
}

type NormalizedGitDiffResponse = GitDiffResponse & {
  diff: string
  diff_text: string
  diffText: string
  truncated: boolean
  totalBytes: number
}

/** Older panels read the diff as `diff_text` or `diffText`; keep both names. */
function normalizeGitDiffResponse(
  result: GitDiffResponse
): NormalizedGitDiffResponse {
  const diffText = result.diff_text ?? result.diffText ?? result.diff ?? ""
  return {
    ...result,
    diff: diffText,
    diff_text: diffText,
    diffText,
    truncated: result.truncated === true,
    totalBytes:
      typeof result.totalBytes === "number"
        ? result.totalBytes
        : diffText.length,
  }
}

const done = (): void => undefined

export const gitUserProfile = (
  cwd?: string | null
): Promise<GitUserProfile> => {
  // Normalize a blank/whitespace cwd to null: `?? null` only catches
  // null/undefined, so an empty string (no folder open at startup) would
  // otherwise be sent verbatim and rejected by the schema's non-blank
  // gitPath rule with a 400. The backend treats a null cwd as a global
  // git-identity lookup, which is exactly what we want with no project open.
  const normalizedCwd = cwd?.trim() ? cwd : null
  return invokeContract("gitProfile", { body: { cwd: normalizedCwd } })
}

export const gitStatus = (cwd: string): Promise<GitStatus> =>
  invokeContract("gitStatus", { body: { cwd } })

export const gitCommit = (
  cwd: string,
  message: string
): Promise<Record<string, unknown>> =>
  invokeContract("gitCommit", { body: { cwd, message } }).then((result) => {
    window.dispatchEvent(
      new CustomEvent("betterc0de:git-commit", {
        detail: {
          cwd,
          commitMessage: message,
          output: result.output || "",
        },
      })
    )
    return result
  })

export const gitPush = (
  cwd: string,
  opts: { setUpstream?: boolean; branch?: string; remote?: string } = {}
): Promise<Record<string, unknown>> =>
  invokeContract("gitPush", {
    body: { cwd, ...opts },
    silentStatuses: [400, 401, 404, 409],
  })

export const gitFetch = (cwd: string): Promise<{ status: GitStatus }> =>
  invokeContract("gitFetch", {
    body: { cwd },
    timeoutMs: 100_000,
    silentStatuses: [400, 401, 404, 502],
  })

export const gitPull = (cwd: string): Promise<Record<string, unknown>> =>
  invokeContract("gitPull", {
    body: { cwd },
    silentStatuses: [400, 401, 404, 409],
  })

export const gitDiscard = (
  cwd: string,
  path: string
): Promise<Record<string, unknown>> =>
  invokeContract("gitDiscard", { body: { cwd, path } })

export const openInEditor = (path: string, editor: string): Promise<void> =>
  invokeContract("gitOpenEditor", { body: { path, editor } }).then(done)

export const getOpenTargets = (
  opts: { refresh?: boolean } = {}
): Promise<{ targets: OpenTarget[] }> =>
  invokeContract("gitOpenTargets", {
    query: opts.refresh ? "?refresh=true" : undefined,
  })

export const gitInit = (cwd: string): Promise<Record<string, unknown>> =>
  invokeContract("gitInit", { body: { cwd } })

export const isGitRepo = (cwd: string): Promise<boolean> =>
  invokeContract("gitIsRepo", { body: { cwd } }).then(
    (result) => result.is_repo
  )

export const gitDiff = (cwd: string): Promise<NormalizedGitDiffResponse> =>
  invokeContract("gitDiff", { body: { cwd } }).then(normalizeGitDiffResponse)

export const gitDiffStaged = (
  cwd: string
): Promise<NormalizedGitDiffResponse> =>
  invokeContract("gitDiffStaged", { body: { cwd } }).then(
    normalizeGitDiffResponse
  )

export const gitListRemotes = (cwd: string): Promise<string[]> =>
  invokeContract("gitRemotes", { body: { cwd } })

/** A GitHub pull request, matched to a chat by its head branch. */
export interface GitPullRequest {
  number: number
  title: string
  url: string
  /** `open`, `draft`, `merged` or `closed`. */
  state: string
  branch: string
  updatedAt: string | null
}

/** Recent pull requests of the workspace's GitHub repository, via `gh`. */
export const gitListPullRequests = (
  cwd: string
): Promise<{ available: boolean; pullRequests: GitPullRequest[] }> =>
  invokeContract("gitPullRequests", { body: { cwd } })

export const gitAddRemote = (
  cwd: string,
  name: string,
  url: string
): Promise<void> =>
  invokeContract("gitRemoteAdd", { body: { cwd, name, url } }).then(done)

export const gitStage = (cwd: string, paths: string[]): Promise<void> =>
  invokeContract("gitStage", { body: { cwd, paths } }).then(done)

export const gitUnstage = (cwd: string, paths: string[]): Promise<void> =>
  invokeContract("gitUnstage", { body: { cwd, paths } }).then(done)

export const gitStageAll = (cwd: string): Promise<void> =>
  invokeContract("gitStageAll", { body: { cwd } }).then(done)

export const gitUnstageAll = (cwd: string): Promise<void> =>
  invokeContract("gitUnstageAll", { body: { cwd } }).then(done)

export const gitApplyHunk = (
  input: GitHunkActionInput
): Promise<GitHunkActionResult> =>
  invokeContract("gitHunkApply", {
    body: {
      ...input,
      operationId: input.operationId ?? crypto.randomUUID(),
    },
  })

export const gitLog = (
  cwd: string,
  count?: number
): Promise<{
  commits: { hash: string; message: string; author: string; date: string }[]
}> =>
  invokeContract("gitLog", { body: { cwd, count: count ?? 20 } }).then(
    (result) => ({
      // A subject, author or date git did not print reads as empty.
      commits: result.commits.map((commit) => ({
        hash: commit.hash,
        message: commit.message ?? "",
        author: commit.author ?? "",
        date: commit.date ?? "",
      })),
    })
  )

export const gitCheckoutBranch = (
  cwd: string,
  branch: string,
  create?: boolean
): Promise<void> =>
  invokeContract("gitCheckout", {
    body: { cwd, branch, create: create ?? false },
  }).then(done)

export const gitListBranches = (
  cwd: string
): Promise<{ branches: string[]; current: string }> =>
  invokeContract("gitBranches", { body: { cwd } })

export const gitStash = (cwd: string, message?: string): Promise<void> =>
  invokeContract("gitStash", { body: { cwd, message } }).then(done)

export const gitStashPop = (cwd: string): Promise<void> =>
  invokeContract("gitStashPop", { body: { cwd } }).then(done)

export const gitListWorktrees = (cwd: string): Promise<GitWorktreeInfo[]> =>
  invokeContract("gitWorktrees", { body: { cwd } })

export const gitCreateWorktree = (
  cwd: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<GitWorktreeCreateResult> =>
  invokeContract("gitWorktreeCreate", {
    body: { cwd, worktreePath, branch, baseBranch },
  })

export const gitRemoveWorktree = (
  cwd: string,
  worktreePath: string,
  opts: { force?: boolean } = {}
): Promise<void> =>
  invokeContract("gitWorktreeRemove", {
    body: { cwd, worktreePath, ...opts },
  }).then(done)

export const gitPruneWorktrees = (cwd: string): Promise<void> =>
  invokeContract("gitWorktreePrune", { body: { cwd } }).then(done)

/**
 * Refused by the backend (410): checkpoints belong to the provider turn
 * lifecycle. Kept so an older caller gets that answer instead of a 404.
 */
export const gitCaptureCheckpoint = (
  cwd: string,
  checkpointRef: string
): Promise<{ ok: true }> =>
  invokeContract("gitCheckpointCapture", { body: { cwd, checkpointRef } })

export const gitDiffCheckpoints = (
  cwd: string,
  fromCheckpointRef: string,
  toCheckpointRef: string,
  opts: { fallbackFromToHead?: boolean; ignoreWhitespace?: boolean } = {}
): Promise<{ diff: string }> =>
  invokeContract("gitCheckpointDiff", {
    body: { cwd, fromCheckpointRef, toCheckpointRef, ...opts },
  })
