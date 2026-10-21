import type { GitStatus } from "@betterc0de/schema"

export interface FileDiffStats {
  additions: number
  deletions: number
}

/** VS-Code-style git status colors — letter + chevron tint per section.
 *  Filenames stay `text-foreground`; only the compact status letter carries
 *  the color so the list scans without shouting. */
export const GIT_STATUS_META: Record<
  string,
  { label: string; className: string }
> = {
  A: { label: "Staged", className: "text-success" },
  M: { label: "Modified", className: "text-warning" },
  U: { label: "Untracked", className: "text-primary" },
}

export interface GitLogEntry {
  hash: string
  message: string
  author: string
  date: string
}

/** The git panel's views: working-tree changes, commit log, branch list. */
export type GitPanelTab = "changes" | "log" | "branches"

/** A remote or destructive action waiting for the user's confirmation. */
export interface GitConfirmAction {
  title: string
  description: string
  action: () => void
}

/** Where a changed file opens from: the index, the working tree or nowhere
 *  (untracked files have no diff base and open as plain files). */
export type GitFileSource = "staged" | "unstaged" | null

export function parseDiffStats(
  diffText: string
): Record<string, FileDiffStats> {
  const result: Record<string, FileDiffStats> = {}
  if (!diffText) return result
  const chunks = diffText.split(/^diff --git /m).filter(Boolean)
  for (const chunk of chunks) {
    const pathMatch = chunk.match(/a\/(.+?)\s+b\//)
    if (!pathMatch) continue
    const filePath = pathMatch[1]
    let additions = 0
    let deletions = 0
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
    result[filePath] = { additions, deletions }
  }
  return result
}

export function normalizeFsPathForCompare(
  value: string | null | undefined
): string {
  return (value ?? "").replace(/[\\/]+$/, "")
}

export function threadMatchesPanelCwd(
  thread: { projectPath?: string | null; worktreePath?: string | null },
  cwd: string
): boolean {
  const normalizedCwd = normalizeFsPathForCompare(cwd)
  if (!normalizedCwd) return false
  return (
    normalizeFsPathForCompare(thread.projectPath) === normalizedCwd ||
    normalizeFsPathForCompare(thread.worktreePath) === normalizedCwd
  )
}

/**
 * The changed files shown for a filter. The filter only applies where the
 * panel shows a filter field (editor and agent modes); elsewhere every file
 * stays visible.
 */
export function filterChangedFiles(
  files: string[],
  fileFilter: string,
  filterEnabled: boolean
): string[] {
  return filterEnabled && fileFilter.trim()
    ? files.filter((file) =>
        file.toLowerCase().includes(fileFilter.trim().toLowerCase())
      )
    : files
}

/** File name and its directory prefix (with trailing separator, or ""). */
export function splitGitFilePath(file: string): {
  fileName: string
  dirPath: string
} {
  const fileName = file.split(/[/\\]/).pop() || file
  const dirPath = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/") + 1)
    : file.includes("\\")
      ? file.slice(0, file.lastIndexOf("\\") + 1)
      : ""
  return { fileName, dirPath }
}

export function pluralCommits(n: number): string {
  return `${n} ${n === 1 ? "commit" : "commits"}`
}

/**
 * Push / Pull state of the remote toolbar.
 *
 * `ahead`/`behind` come from `git rev-list --left-right --count
 * HEAD...@{upstream}` on the backend, so they reflect what's in the LOCAL ref
 * database — no implicit network call. The `upstream` field tells us whether
 * a tracking branch is configured at all: if null the branch was never
 * published, so the Push button switches to "Publish branch" mode (which on
 * the backend still runs `git push` — git creates the upstream when one isn't
 * set, provided `push.autoSetupRemote=true` or the user has it configured).
 */
export function describeRemoteSync(
  status: Pick<GitStatus, "ahead" | "behind" | "upstream" | "branch">,
  busy: {
    isPushing: boolean
    isPulling: boolean
    isCommitting: boolean
    isFetching: boolean
  }
) {
  const ahead = status.ahead ?? 0
  const behind = status.behind ?? 0
  const upstream = status.upstream ?? null
  const branchLabel = upstream ?? `origin/${status.branch || "main"}`
  const pushTitle = !upstream
    ? `Publish "${status.branch || "main"}" to remote`
    : ahead > 0
      ? `Push ${pluralCommits(ahead)} to ${branchLabel}`
      : `Up to date with ${branchLabel}`
  const pullTitle = !upstream
    ? `No upstream — set one before pulling`
    : behind > 0
      ? `Pull ${pluralCommits(behind)} from ${branchLabel}`
      : `Check ${branchLabel} for new commits and pull updates`
  const remoteBusy =
    busy.isPushing || busy.isPulling || busy.isCommitting || busy.isFetching
  const pushDisabled = remoteBusy || (Boolean(upstream) && ahead === 0)
  const pullDisabled = remoteBusy || !upstream
  return {
    ahead,
    behind,
    upstream,
    pushTitle,
    pullTitle,
    remoteBusy,
    pushDisabled,
    pullDisabled,
  }
}

/** The status line under the remote toolbar. */
export function remoteSyncStatusText(input: {
  isFetching: boolean
  lastFetchedAt: Date | null
  upstream: string | null
  behind: number
}): string {
  const { isFetching, lastFetchedAt, upstream, behind } = input
  return isFetching
    ? "Checking for remote updates…"
    : lastFetchedAt
      ? !upstream
        ? "Remote checked · publish to track this branch"
        : behind > 0
          ? `${pluralCommits(behind)} available to pull`
          : "No incoming commits · remote checked"
      : "Fetch to check for incoming commits"
}
