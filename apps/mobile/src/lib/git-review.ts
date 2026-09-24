import { generateWorkspaceCommitMessage } from "@betterc0de/schema/git-commit-message"
import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { pathWithinRoot } from "@/lib/endpoint"
import type { GitStatusResult, RemoteApi } from "@/transport/types"

/**
 * The phone's git review follows the desktop's git panel: its three lists,
 * its smart commit, and its words for every confirmation.
 */

export type GitSectionKey = "staged" | "changes" | "untracked"

export interface LineCounts {
  additions: number
  deletions: number
}

export interface GitSection {
  key: GitSectionKey
  title: string
  files: string[]
}

/** The desktop's lists, in its order; empty ones are left out. */
export function gitSections(status: GitStatusResult): GitSection[] {
  return (
    [
      { key: "staged", title: "Staged Changes", files: status.staged },
      { key: "changes", title: "Changes", files: status.modified },
      { key: "untracked", title: "Untracked", files: status.untracked },
    ] as const
  )
    .filter((section) => section.files.length > 0)
    .map((section) => ({ ...section, files: [...section.files] }))
}

export function changeCount(status: GitStatusResult): number {
  return status.staged.length + status.modified.length + status.untracked.length
}

/** Added and removed lines per file of a diff. */
export function lineCounts(diffText: string): Record<string, LineCounts> {
  return Object.fromEntries(
    parseGitDiff(diffText).map((file) => [
      file.name,
      { additions: file.additions, deletions: file.deletions },
    ])
  )
}

export interface Confirmation {
  title: string
  message: string
  /** The label of the button that does it. */
  action: string
}

/** Push, or with no upstream yet, publish the branch to origin. */
export function pushConfirmation(status: GitStatusResult): Confirmation {
  const branch = status.branch || "main"
  if (!status.upstream) {
    return {
      title: "Publish branch?",
      message: `Branch "${branch}" has no upstream — publish to origin/${branch} now? Future pushes will go there automatically.`,
      action: "Publish",
    }
  }
  return {
    title: "Push to remote?",
    message: `Push ${status.ahead} ${status.ahead === 1 ? "commit" : "commits"} on "${branch}" to ${status.upstream}.`,
    action: "Push",
  }
}

export function pullConfirmation(status: GitStatusResult): Confirmation {
  return {
    title: "Pull from remote?",
    message: `Pull latest changes from the remote into "${status.branch || "main"}".`,
    action: "Pull",
  }
}

export function discardConfirmation(file: string): Confirmation {
  return {
    title: "Discard changes?",
    message: `All changes to "${file}" will be permanently lost. This cannot be undone.`,
    action: "Discard",
  }
}

/**
 * The desktop discards a single hunk without asking; on a phone a stray tap
 * is easier, so the phone asks first.
 */
export function discardHunkConfirmation(file: string): Confirmation {
  return {
    title: "Discard this change?",
    message: `These lines of "${file}" go back to how they were. This cannot be undone.`,
    action: "Discard",
  }
}

export function checkoutConfirmation(branch: string): Confirmation {
  return {
    title: "Switch branch?",
    message: `Switch the workspace to "${branch}"? Git will stop if local changes cannot be carried safely.`,
    action: "Switch",
  }
}

/**
 * The desktop's smart commit: with nothing staged, everything changed is
 * staged first, so Commit never silently does nothing.
 */
export async function commitChanges(
  api: RemoteApi,
  cwd: string,
  status: GitStatusResult,
  message: string
): Promise<void> {
  const hasStaged = status.staged.length > 0
  const hasUnstaged = status.modified.length > 0 || status.untracked.length > 0
  if (!hasStaged && hasUnstaged) await api.gitStageAll(cwd)
  await api.gitCommit(cwd, message.trim())
}

/**
 * A commit message from the desktop's generator, for exactly what Commit
 * will take (@betterc0de/schema/git-commit-message). `signal` stops waiting;
 * the desktop then finishes the generation and nobody reads it.
 */
export function generateCommitMessage(
  api: RemoteApi,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  return generateWorkspaceCommitMessage(cwd, {
    status: () => api.gitStatus(cwd, { signal }),
    diff: async () => {
      const patch = await api.gitDiff(cwd, false, { signal })
      return { diffText: patch.diff, truncated: patch.truncated }
    },
    stagedDiff: async () => {
      const patch = await api.gitDiff(cwd, true, { signal })
      return { diffText: patch.diff, truncated: patch.truncated }
    },
    readUntracked: async (file) =>
      (await api.readFile(cwd, pathWithinRoot(cwd, file))).content,
    generate: (request) => api.generateCommitMessage(request, { signal }),
  })
}

/**
 * `git log --date=iso` prints `2026-09-24 09:12:44 +0200`, which not every
 * JavaScript engine parses; this reads it as an ISO timestamp.
 */
export function gitLogDate(value: string | undefined): Date | null {
  const match = value
    ?.trim()
    .match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/)
  if (!match) return null
  const date = new Date(
    `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`
  )
  return Number.isNaN(date.getTime()) ? null : date
}
