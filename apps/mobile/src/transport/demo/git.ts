import { extractGitHunkPatches } from "@betterc0de/schema/git-diff"
import { RemoteApiError } from "../live/http"
import type {
  GeneratedCommitMessage,
  GitDiffResult,
  GitHunkRequest,
  GitHunkResult,
  GitLogEntry,
  GitStatusResult,
} from "../types"

/**
 * The demo's git repositories, in memory: a committed tree, the index and
 * the working tree, each a map of file path → contents. Diffs are real
 * unified diffs (three lines of context), so the phone parses them and
 * stages single hunks exactly as it does with a desktop, and the desktop's
 * refusals come back in its own words.
 */

type Tree = Map<string, string>

interface BranchState {
  upstream: string | null
  ahead: number
  behind: number
  /** Commits the remote has and this branch does not, newest first. */
  incoming: GitLogEntry[]
}

interface DemoRepo {
  branch: string
  readonly branches: Map<string, BranchState>
  head: Tree
  index: Tree
  worktree: Tree
  log: GitLogEntry[]
}

export interface DemoRepoSeed {
  readonly branch: string
  /** Every branch, with its upstream and how far it is ahead and behind. */
  readonly branches: Record<string, Partial<BranchState>>
  readonly head: Record<string, string>
  /** The index where it differs from the committed tree. */
  readonly staged?: Record<string, string>
  /** The working tree where it differs from the index; new files are untracked. */
  readonly changed?: Record<string, string>
  readonly log: GitLogEntry[]
}

const CONTEXT_LINES = 3

export const NOTHING_TO_COMMIT =
  "Nothing to commit — stage changes first or modify a tracked file."

function linesOf(text: string): string[] {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

type Edit = { kind: "same" | "remove" | "add"; line: string }

/** The shortest edit from `before` to `after`, by longest common subsequence. */
function lineEdits(before: string[], after: string[]): Edit[] {
  const rows = before.length + 1
  const columns = after.length + 1
  const common = new Uint32Array(rows * columns)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i * columns + j] =
        before[i] === after[j]
          ? common[(i + 1) * columns + j + 1]! + 1
          : Math.max(
              common[(i + 1) * columns + j]!,
              common[i * columns + j + 1]!
            )
    }
  }
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      edits.push({ kind: "same", line: before[i]! })
      i += 1
      j += 1
    } else if (
      j < after.length &&
      (i === before.length ||
        // On a tie the removal goes first, as git prints a replaced line.
        common[i * columns + j + 1]! > common[(i + 1) * columns + j]!)
    ) {
      edits.push({ kind: "add", line: after[j]! })
      j += 1
    } else {
      edits.push({ kind: "remove", line: before[i]! })
      i += 1
    }
  }
  return edits
}

/** One file's unified diff, as `git diff` prints it; "" when nothing changed. */
export function unifiedFileDiff(
  path: string,
  before: string | undefined,
  after: string | undefined
): string {
  if (before === after) return ""
  const edits = lineEdits(linesOf(before ?? ""), linesOf(after ?? ""))
  const header = [`diff --git a/${path} b/${path}`]
  if (before === undefined) header.push("new file mode 100644")
  if (after === undefined) header.push("deleted file mode 100644")
  header.push(before === undefined ? "--- /dev/null" : `--- a/${path}`)
  header.push(after === undefined ? "+++ /dev/null" : `+++ b/${path}`)

  // One hunk while at most twice the context lies between changes, as in git.
  const changed = edits.flatMap((edit, index) =>
    edit.kind === "same" ? [] : [index]
  )
  const groups: Array<[number, number]> = []
  for (const index of changed) {
    const last = groups.at(-1)
    if (last && index - last[1] - 1 <= CONTEXT_LINES * 2) last[1] = index
    else groups.push([index, index])
  }

  const hunks: string[] = []
  for (const [first, last] of groups) {
    const start = Math.max(0, first - CONTEXT_LINES)
    const end = Math.min(edits.length - 1, last + CONTEXT_LINES)
    let oldLine = 1
    let newLine = 1
    for (const edit of edits.slice(0, start)) {
      if (edit.kind !== "add") oldLine += 1
      if (edit.kind !== "remove") newLine += 1
    }
    const body = edits.slice(start, end + 1)
    const oldCount = body.filter((edit) => edit.kind !== "add").length
    const newCount = body.filter((edit) => edit.kind !== "remove").length
    // Git numbers an empty side by the line before it.
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine
    const newStart = newCount === 0 ? newLine - 1 : newLine
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...body.map(
        (edit) =>
          `${edit.kind === "same" ? " " : edit.kind === "add" ? "+" : "-"}${edit.line}`
      )
    )
  }
  return `${[...header, ...hunks].join("\n")}\n`
}

function hunkConflict(): RemoteApiError {
  return new RemoteApiError(
    "This hunk no longer matches the workspace. Refresh the diff and review the latest changes.",
    409,
    "git_hunk_conflict"
  )
}

/**
 * Applies a single-hunk patch to `text`, or undoes it with `reverse`;
 * `undefined` stands for a file that does not exist.
 */
function applyHunkPatch(
  text: string | undefined,
  patch: string,
  reverse: boolean
): string | undefined {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n")
  const at = lines.findIndex((line) => line.startsWith("@@ "))
  const match = lines[at]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) throw hunkConflict()
  const body = lines.slice(at + 1).filter((line) => line !== "")
  const from = body.filter((line) => !line.startsWith(reverse ? "-" : "+"))
  const to = body.filter((line) => !line.startsWith(reverse ? "+" : "-"))
  const start = Number(reverse ? match[3] : match[1])
  const count = Number((reverse ? match[4] : match[2]) ?? "1")
  const current = linesOf(text ?? "")
  const offset = count === 0 ? start : start - 1
  const expected = from.map((line) => line.slice(1))
  if (
    current.slice(offset, offset + expected.length).join("\n") !==
    expected.join("\n")
  ) {
    throw hunkConflict()
  }
  current.splice(offset, expected.length, ...to.map((line) => line.slice(1)))
  const creates = patch.includes(
    reverse ? "\ndeleted file mode" : "\nnew file mode"
  )
  const removes = patch.includes(
    reverse ? "\nnew file mode" : "\ndeleted file mode"
  )
  if (removes && current.length === 0) return undefined
  if (text === undefined && !creates && current.length === 0) return undefined
  return current.length > 0 ? `${current.join("\n")}\n` : ""
}

function treeFrom(record: Record<string, string>): Tree {
  return new Map(Object.entries(record))
}

function changedPaths(before: Tree, after: Tree): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort()
}

function diffTrees(before: Tree, after: Tree, paths: string[]): string {
  return paths
    .map((path) => unifiedFileDiff(path, before.get(path), after.get(path)))
    .join("")
}

/** The date `git log --date=iso` prints: `2026-09-24 09:12:44 +0000`. */
export function gitIsoDate(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} +0000`
}

export class DemoGit {
  private readonly repos = new Map<string, DemoRepo>()
  private readonly hunkReceipts = new Map<string, GitHunkResult>()
  private commitCounter = 0

  constructor(
    seeds: Record<string, DemoRepoSeed>,
    private readonly now: () => Date
  ) {
    for (const [root, seed] of Object.entries(seeds)) {
      const head = treeFrom(seed.head)
      const index = new Map([...head, ...Object.entries(seed.staged ?? {})])
      this.repos.set(root, {
        branch: seed.branch,
        branches: new Map(
          Object.entries(seed.branches).map(([name, state]) => [
            name,
            {
              upstream: state.upstream ?? null,
              ahead: state.ahead ?? 0,
              behind: state.behind ?? 0,
              incoming: state.incoming ?? [],
            },
          ])
        ),
        head,
        index,
        worktree: new Map([...index, ...Object.entries(seed.changed ?? {})]),
        log: [...seed.log],
      })
    }
  }

  /** A new worktree: a clean checkout of `baseRoot`'s last commit on a new branch. */
  addWorktree(path: string, baseRoot: string, branch: string): void {
    const base = this.repos.get(baseRoot)
    if (!base) return
    const branches = new Map(base.branches)
    branches.set(branch, { upstream: null, ahead: 0, behind: 0, incoming: [] })
    this.repos.set(path, {
      branch,
      branches,
      head: new Map(base.head),
      index: new Map(base.head),
      worktree: new Map(base.head),
      log: [...base.log],
    })
  }

  /**
   * A file in a repository's working tree: `undefined` when `root` is no
   * demo repository, `null` when the repository has no such file.
   */
  workingFile(root: string, path: string): string | null | undefined {
    const repo = this.repos.get(root)
    if (!repo) return undefined
    return repo.worktree.get(path) ?? null
  }

  private repo(cwd: string): DemoRepo {
    const repo = this.repos.get(cwd)
    if (!repo) throw new RemoteApiError("Not a git repository.", 400)
    return repo
  }

  private branchState(repo: DemoRepo): BranchState {
    const state = repo.branches.get(repo.branch)
    if (!state) throw new RemoteApiError("Not a git repository.", 400)
    return state
  }

  status(cwd: string): GitStatusResult {
    const repo = this.repo(cwd)
    const staged = changedPaths(repo.head, repo.index)
    const modified = [...repo.index.keys()]
      .filter((path) => repo.worktree.get(path) !== repo.index.get(path))
      .sort()
    const untracked = [...repo.worktree.keys()]
      .filter((path) => !repo.index.has(path))
      .sort()
    const state = this.branchState(repo)
    return {
      branch: repo.branch,
      is_clean:
        staged.length === 0 && modified.length === 0 && untracked.length === 0,
      staged,
      modified,
      untracked,
      ahead: state.upstream ? state.ahead : 0,
      behind: state.upstream ? state.behind : 0,
      upstream: state.upstream,
    }
  }

  diff(cwd: string, staged: boolean): GitDiffResult {
    const repo = this.repo(cwd)
    // `git diff` leaves untracked files out.
    const diff = staged
      ? diffTrees(repo.head, repo.index, changedPaths(repo.head, repo.index))
      : diffTrees(
          repo.index,
          repo.worktree,
          [...repo.index.keys()]
            .filter((path) => repo.worktree.get(path) !== repo.index.get(path))
            .sort()
        )
    return { diff, truncated: false, totalBytes: diff.length }
  }

  stage(cwd: string, paths: string[]): void {
    const repo = this.repo(cwd)
    for (const path of paths) {
      const content = repo.worktree.get(path)
      if (content === undefined) repo.index.delete(path)
      else repo.index.set(path, content)
    }
  }

  unstage(cwd: string, paths: string[]): void {
    const repo = this.repo(cwd)
    for (const path of paths) {
      const content = repo.head.get(path)
      if (content === undefined) repo.index.delete(path)
      else repo.index.set(path, content)
    }
  }

  stageAll(cwd: string): void {
    const repo = this.repo(cwd)
    repo.index = new Map(repo.worktree)
  }

  unstageAll(cwd: string): void {
    const repo = this.repo(cwd)
    repo.index = new Map(repo.head)
  }

  /** `git checkout -- <path>`: the index's version replaces the working file. */
  discard(cwd: string, path: string): void {
    const repo = this.repo(cwd)
    const content = repo.index.get(path)
    if (content === undefined) {
      throw new RemoteApiError(
        `error: pathspec '${path}' did not match any file(s) known to git`,
        500
      )
    }
    repo.worktree.set(path, content)
  }

  applyHunk(request: GitHunkRequest): GitHunkResult {
    const repo = this.repo(request.cwd)
    const receipt = request.operationId
      ? this.hunkReceipts.get(request.operationId)
      : undefined
    if (receipt) return { ...receipt, replayed: true }
    const valid =
      (request.source === "unstaged" &&
        (request.action === "accept" || request.action === "reject")) ||
      (request.source === "staged" && request.action === "unstage")
    if (!valid) {
      throw new RemoteApiError(
        "Invalid hunk action for diff source.",
        400,
        "git_hunk_action_invalid"
      )
    }
    const patch = `${request.patch.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`
    const current =
      request.source === "staged"
        ? unifiedFileDiff(
            request.path,
            repo.head.get(request.path),
            repo.index.get(request.path)
          )
        : unifiedFileDiff(
            request.path,
            repo.index.get(request.path),
            repo.worktree.get(request.path)
          )
    if (!extractGitHunkPatches(current).includes(patch)) throw hunkConflict()

    const [tree, reverse] =
      request.action === "accept"
        ? ([repo.index, false] as const)
        : request.action === "reject"
          ? ([repo.worktree, true] as const)
          : ([repo.index, true] as const)
    const next = applyHunkPatch(tree.get(request.path), patch, reverse)
    if (next === undefined) tree.delete(request.path)
    else tree.set(request.path, next)

    const result: GitHunkResult = {
      ok: true,
      action: request.action,
      patchId: `demo-${this.hunkReceipts.size + 1}`,
      applied: true,
    }
    if (request.operationId) this.hunkReceipts.set(request.operationId, result)
    return result
  }

  commit(cwd: string, message: string): { output: string } {
    const repo = this.repo(cwd)
    if (changedPaths(repo.head, repo.index).length === 0) {
      throw new RemoteApiError(NOTHING_TO_COMMIT, 400, "git_nothing_to_commit")
    }
    this.commitCounter += 1
    const hash = `${this.commitCounter.toString(16).padStart(8, "0")}${"5eed".repeat(8)}`
    const subject = message.trim().split("\n")[0] ?? ""
    repo.head = new Map(repo.index)
    repo.log.unshift({
      hash,
      message: subject,
      author: "Demo User",
      date: gitIsoDate(this.now()),
    })
    const state = this.branchState(repo)
    if (state.upstream) state.ahead += 1
    return { output: `[${repo.branch} ${hash.slice(0, 7)}] ${subject}` }
  }

  push(
    cwd: string,
    options: { setUpstream?: boolean; branch?: string } = {}
  ): { output: string } {
    const repo = this.repo(cwd)
    const state = this.branchState(repo)
    if (options.setUpstream && options.branch) {
      state.upstream = `origin/${options.branch}`
      state.ahead = 0
      return {
        output: `branch '${options.branch}' set up to track '${state.upstream}'.`,
      }
    }
    if (!state.upstream) {
      throw new RemoteApiError(
        "Branch has no upstream — use Publish instead.",
        400,
        "git_remote_error"
      )
    }
    if (state.behind > 0) {
      throw new RemoteApiError(
        "Remote has new commits — pull first, then push again.",
        409,
        "git_remote_error"
      )
    }
    state.ahead = 0
    return { output: `To demo:${state.upstream}` }
  }

  pull(cwd: string): { output: string } {
    const repo = this.repo(cwd)
    const state = this.branchState(repo)
    if (!state.upstream) {
      throw new RemoteApiError(
        "Branch has no upstream — set one before pulling.",
        400,
        "git_remote_error"
      )
    }
    repo.log.unshift(...state.incoming)
    const pulled = state.incoming.length
    state.incoming = []
    state.behind = 0
    return { output: pulled > 0 ? "Fast-forward" : "Already up to date." }
  }

  /** The demo's remote holds nothing that the status does not show already. */
  fetch(cwd: string): GitStatusResult {
    return this.status(cwd)
  }

  checkout(cwd: string, branch: string, create: boolean): void {
    const repo = this.repo(cwd)
    if (create) {
      if (repo.branches.has(branch)) {
        throw new RemoteApiError(
          `fatal: a branch named '${branch}' already exists`,
          500
        )
      }
      repo.branches.set(branch, {
        upstream: null,
        ahead: 0,
        behind: 0,
        incoming: [],
      })
    } else if (!repo.branches.has(branch)) {
      throw new RemoteApiError(
        `error: pathspec '${branch}' did not match any file(s) known to git`,
        500
      )
    }
    repo.branch = branch
  }

  branches(cwd: string): { branches: string[]; current: string } {
    const repo = this.repo(cwd)
    return { branches: [...repo.branches.keys()].sort(), current: repo.branch }
  }

  log(cwd: string, count: number): GitLogEntry[] {
    return this.repo(cwd).log.slice(0, count)
  }

  /** A plain summary of the files the desktop's generator was given. */
  commitMessage(stagedSummary: string): GeneratedCommitMessage {
    const files = stagedSummary
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^(Changed|New): /, "").trim())
      .filter(Boolean)
    if (files.length === 0) {
      throw new RemoteApiError("There are no changes to summarize.", 400)
    }
    return {
      subject:
        files.length === 1
          ? `Update ${files[0]!.split("/").pop()}`
          : `Update ${files.length} files`,
      body: files.map((file) => `- ${file}`).join("\n"),
    }
  }
}
