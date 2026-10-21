/**
 * Thread worktrees: create, reset, remove, prune and list.
 */

import { gitRun } from "./process"
import {
  validateGitRefName,
  assertValidBranchName,
  canonicalizeExistingPath,
  normalizeBranchRef,
} from "./refs"
import { invalidateStatusCache, invalidateStatusCaches } from "./status"

// ─── Worktree operations (Phase 1 Objective 1) ───────────────────────────────
// Everything in this section routes through `gitRun` so there's no shell
// interpolation on any worktree path — matches the injection-safety
// invariants of the rest of the module.

export interface WorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  prunable: boolean
}

/**
 * Create a new git worktree rooted at `worktreePath` with a fresh branch.
 * `baseBranch` is the starting point — must already exist in `cwd`.
 * Fails if: baseBranch missing, target path occupied, branch already checked
 * out in another worktree (git enforces this; we surface a clear error).
 */
export async function createWorktree(
  cwd: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<{ path: string; branch: string; base: string }> {
  const cleanBranch = await assertValidBranchName(cwd, branch)
  const cleanBase = validateGitRefName(baseBranch, "Base branch")
  await gitRun(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${cleanBase}^{commit}`,
  ])
  await gitRun(cwd, [
    "worktree",
    "add",
    "-b",
    cleanBranch,
    "--",
    worktreePath,
    cleanBase,
  ])
  await invalidateStatusCaches(cwd, worktreePath)
  return {
    path: canonicalizeExistingPath(worktreePath),
    branch: cleanBranch,
    base: cleanBase,
  }
}

/**
 * Create a git worktree at `worktreePath` checked out on the existing local
 * branch `branch` (a pull request's branch), instead of a fresh one. Git
 * refuses a branch already checked out in another worktree.
 */
export async function createWorktreeOnBranch(
  cwd: string,
  worktreePath: string,
  branch: string
): Promise<{ path: string; branch: string }> {
  const cleanBranch = validateGitRefName(branch, "Branch")
  await gitRun(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `refs/heads/${cleanBranch}^{commit}`,
  ])
  await gitRun(cwd, ["worktree", "add", "--", worktreePath, cleanBranch])
  await invalidateStatusCaches(cwd, worktreePath)
  return {
    path: canonicalizeExistingPath(worktreePath),
    branch: cleanBranch,
  }
}

/** Remove a worktree. Pass `force: true` to override uncommitted changes
 *  (equivalent of `git worktree remove --force`). */
export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const args = ["worktree", "remove"]
  if (opts.force) args.push("--force")
  args.push(worktreePath)
  await gitRun(cwd, args)
  await invalidateStatusCaches(cwd, worktreePath)
}

/**
 * Reset an existing secondary worktree to `targetRef` and leave it clean.
 * The caller is responsible for ensuring `worktreePath` is not the primary
 * repository path; this helper only shells out through `gitRun`.
 */
export async function resetWorktree(
  cwd: string,
  worktreePath: string,
  targetRef: string,
  opts: { clean?: boolean; updateSubmodules?: boolean } = {}
): Promise<void> {
  const target = validateGitRefName(targetRef, "Worktree reset target")

  await gitRun(worktreePath, ["reset", "--hard", target])
  if (opts.clean ?? true) {
    await gitRun(worktreePath, ["clean", "-ffdx"])
  }

  if (opts.updateSubmodules ?? true) {
    await gitRun(worktreePath, [
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--force",
    ])
    await gitRun(worktreePath, [
      "submodule",
      "foreach",
      "--recursive",
      "git",
      "reset",
      "--hard",
    ])
    await gitRun(worktreePath, [
      "submodule",
      "foreach",
      "--recursive",
      "git",
      "clean",
      "-fdx",
    ])
  }

  const { stdout } = await gitRun(worktreePath, [
    "-c",
    "core.fsmonitor=false",
    "status",
    "--porcelain=v1",
  ])
  if (stdout.trim()) {
    throw new Error(`Worktree reset left local changes:\n${stdout.trim()}`)
  }
  await invalidateStatusCaches(cwd, worktreePath)
}

/** Prune stale worktree admin records. Run this periodically to clean up
 *  orphaned `.git/worktrees/<name>` directories whose trees got `rm -rf`'d. */
export async function pruneWorktrees(cwd: string): Promise<void> {
  await gitRun(cwd, ["worktree", "prune"])
  await invalidateStatusCache(cwd)
}

/**
 * List all worktrees for `cwd`'s repository. Parses porcelain output so the
 * path/HEAD/branch fields come back structured rather than string-split.
 *
 * The porcelain format is a block-per-worktree with blank-line separators and
 * one key-value attribute per line (`worktree <path>`, `HEAD <sha>`, `branch <ref>`,
 * `bare`, `detached`, `prunable`).
 */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const { stdout } = await gitRun(cwd, ["worktree", "list", "--porcelain"])
  const blocks = stdout
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  return blocks.map((block) => {
    const info: WorktreeInfo = {
      path: "",
      head: null,
      branch: null,
      bare: false,
      detached: false,
      prunable: false,
    }
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree "))
        info.path = canonicalizeExistingPath(
          line.slice("worktree ".length).trim()
        )
      else if (line.startsWith("HEAD "))
        info.head = line.slice("HEAD ".length).trim()
      else if (line.startsWith("branch "))
        info.branch = normalizeBranchRef(line.slice("branch ".length).trim())
      else if (line === "bare") info.bare = true
      else if (line === "detached") info.detached = true
      else if (line === "prunable" || line.startsWith("prunable "))
        info.prunable = true
    }
    return info
  })
}
