/**
 * Everyday porcelain: commit, push, pull, staging, log, checkout, stash,
 * remotes and branch maintenance. Remote failures are classified into
 * typed errors the UI can explain.
 */

import { gitRun, isMissingRevisionError } from "./process"
import {
  validateGitRemoteName,
  assertValidBranchName,
  validateRemoteUrl,
} from "./refs"
import { invalidateStatusCache, status } from "./status"
import { HttpError } from "../../errors"

async function assertConfiguredRemote(
  cwd: string,
  value: string
): Promise<string> {
  const remote = validateGitRemoteName(value)
  const remotes = await listRemotes(cwd)
  if (!remotes.includes(remote)) {
    throw Object.assign(
      new Error(`Git remote '${remote}' is not configured.`),
      {
        statusCode: 400,
      }
    )
  }
  return remote
}

/**
 * Strings git uses to tell us "the command ran fine but nothing was
 * actually committed" — typically because the user clicked Commit
 * without staging anything. Git can report this condition in either output
 * stream, so keep the explicit pattern check and return a stable domain
 * result instead of exposing Git's version-specific error text.
 */
const NO_COMMIT_PATTERNS = [
  /nothing to commit/i,
  /nothing added to commit/i,
  /no changes added to commit/i,
] as const

export async function commit(cwd: string, message: string) {
  const { stdout, stderr } = await gitRun(cwd, ["commit", "-F", "-"], {
    input: message,
  })
  const combined = `${stdout}\n${stderr}`
  if (NO_COMMIT_PATTERNS.some((re) => re.test(combined))) {
    throw Object.assign(
      new Error(
        "Nothing to commit — stage changes first or modify a tracked file."
      ),
      { statusCode: 400 }
    )
  }
  await invalidateStatusCache(cwd)
  return { output: stdout }
}

/**
 * Map a raw `git push` / `git pull` stderr to a user-friendly error +
 * HTTP status. Returns `null` when no known pattern matches, so the
 * caller falls through to the generic "<operation> failed" 500 path
 * (sanitizeError will log the original message via pino).
 *
 * Known pattern → user-facing copy lives in one place so adding a new
 * case (e.g. signed-commit failures) is a one-line edit.
 */
function classifyRemoteGitError(
  message: string,
  op: "push" | "pull" | "fetch"
): { status: number; message: string } | null {
  const m = message.toLowerCase()
  if (
    m.includes("has no upstream branch") ||
    m.includes("no tracking information")
  ) {
    return op === "push"
      ? {
          status: 400,
          message: "Branch has no upstream — use Publish instead.",
        }
      : {
          status: 400,
          message: "Branch has no upstream — set one before pulling.",
        }
  }
  if (m.includes("does not appear to be a git repository")) {
    return { status: 400, message: "Remote repository not reachable." }
  }
  if (
    m.includes("no configured push destination") ||
    m.includes("no remote repository") ||
    m.includes("no such remote")
  ) {
    return {
      status: 400,
      message: "No remote configured — add one in Settings → Remotes.",
    }
  }
  if (m.includes("repository not found") || m.includes("404")) {
    return { status: 404, message: "Remote repository not found (404)." }
  }
  if (
    m.includes("authentication failed") ||
    m.includes("permission denied") ||
    m.includes("could not read from remote repository")
  ) {
    return {
      status: 401,
      message:
        "Remote authentication failed — check your git credentials (HTTPS PAT, SSH key, or `gh auth login`).",
    }
  }
  if (
    m.includes("non-fast-forward") ||
    m.includes("fetch first") ||
    m.includes("updates were rejected because the remote contains work")
  ) {
    return {
      status: 409,
      message: "Remote has new commits — pull first, then push again.",
    }
  }
  if (
    m.includes("would be overwritten by merge") ||
    m.includes("local changes") ||
    m.includes("you have unmerged paths")
  ) {
    return {
      status: 409,
      message:
        "Local changes would be overwritten — commit or stash before pulling.",
    }
  }
  if (m.includes("refusing to merge unrelated histories")) {
    return {
      status: 409,
      message:
        "Local and remote histories don't share a common ancestor — manual resolution required.",
    }
  }
  return null
}

function rethrowAsRemoteGitError(err: unknown, op: "push" | "pull"): never {
  const raw = err instanceof Error ? err.message : String(err)
  const classified = classifyRemoteGitError(raw, op)
  if (classified) {
    throw Object.assign(new Error(classified.message), {
      statusCode: classified.status,
      code: "git_remote_error",
    })
  }
  // Unknown failure mode — let sanitizeError handle it (logs pino + 500).
  throw err
}

/**
 * Push the current HEAD to its upstream. When `opts.setUpstream` is set
 * AND `opts.branch` is provided, runs `git push -u origin <branch>`
 * instead — useful for the very first push of a freshly-created local
 * branch where no tracking branch is configured yet (`git push` alone
 * fails with "no upstream branch" on default git config).
 */
export async function push(
  cwd: string,
  opts: { setUpstream?: boolean; branch?: string; remote?: string } = {}
) {
  const args = ["push"]
  if (opts.setUpstream && opts.branch) {
    const branch = await assertValidBranchName(cwd, opts.branch)
    const remote = await assertConfiguredRemote(cwd, opts.remote ?? "origin")
    args.push("-u", remote, branch)
  }
  try {
    const { stdout, stderr } = await gitRun(cwd, args)
    await invalidateStatusCache(cwd)
    return { output: `${stdout}${stderr}`.trim() }
  } catch (err) {
    rethrowAsRemoteGitError(err, "push")
  }
}

export async function pull(cwd: string) {
  try {
    const { stdout, stderr } = await gitRun(cwd, ["pull"])
    await invalidateStatusCache(cwd)
    return { output: `${stdout}${stderr}`.trim() }
  } catch (err) {
    rethrowAsRemoteGitError(err, "pull")
  }
}

/** Refresh remote-tracking refs without merging into the working tree. */
export async function fetchRemote(cwd: string) {
  if ((await listRemotes(cwd)).length === 0) {
    throw new HttpError(
      400,
      "No remote configured. Add a remote before checking for updates.",
      "git_remote_error"
    )
  }
  try {
    await gitRun(cwd, ["fetch", "--all", "--no-recurse-submodules"], {
      timeoutMs: 60_000,
    })
    await invalidateStatusCache(cwd)
    return { status: await status(cwd) }
  } catch (err) {
    const classified = classifyRemoteGitError(
      err instanceof Error ? err.message : String(err),
      "fetch"
    )
    throw new HttpError(
      classified?.status ?? 502,
      classified?.message ??
        "Could not fetch remote updates. Check your connection and Git credentials, then try again.",
      "git_remote_error"
    )
  }
}

export async function discard(cwd: string, filePath: string) {
  await gitRun(cwd, ["checkout", "--", filePath])
  await invalidateStatusCache(cwd)
  return { ok: true }
}

export async function gitInit(cwd: string) {
  const { stdout } = await gitRun(cwd, ["init"])
  await invalidateStatusCache(cwd)
  return { output: stdout }
}

export async function listRemotes(cwd: string) {
  const { stdout } = await gitRun(cwd, ["remote", "-v"])
  const remotes = stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0])
    .filter((v, i, a) => a.indexOf(v) === i)
  return remotes
}

export async function addRemote(cwd: string, name: string, url: string) {
  const cleanUrl = validateRemoteUrl(url)
  const cleanName = validateGitRemoteName(name)
  await gitRun(cwd, ["remote", "add", cleanName, cleanUrl])
  await invalidateStatusCache(cwd)
}

export async function stage(cwd: string, paths: string[]) {
  await gitRun(cwd, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    input: nulDelimitedPathspec(paths),
  })
  await invalidateStatusCache(cwd)
}

export async function unstage(cwd: string, paths: string[]) {
  await gitRun(
    cwd,
    ["restore", "--staged", "--pathspec-from-file=-", "--pathspec-file-nul"],
    { input: nulDelimitedPathspec(paths) }
  )
  await invalidateStatusCache(cwd)
}

function nulDelimitedPathspec(paths: readonly string[]): string {
  if (paths.some((candidate) => candidate.includes("\0"))) {
    throw Object.assign(new Error("Git paths must not contain NUL bytes."), {
      statusCode: 400,
    })
  }
  return paths.length > 0 ? `${paths.join("\0")}\0` : ""
}

export async function stageAll(cwd: string) {
  await gitRun(cwd, ["add", "-A"])
  await invalidateStatusCache(cwd)
}

export async function unstageAll(cwd: string) {
  await gitRun(cwd, ["restore", "--staged", "."])
  await invalidateStatusCache(cwd)
}

export async function log(cwd: string, count: number) {
  const { stdout } = await gitRun(cwd, [
    "log",
    `-n`,
    String(count),
    "--pretty=format:%H\t%s\t%an\t%ad",
    "--date=iso",
  ])
  const commits = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, date] = line.split("\t")
      return { hash, message, author, date }
    })
  return { commits }
}

export async function checkout(cwd: string, branch: string, create: boolean) {
  const cleanBranch = await assertValidBranchName(cwd, branch)
  const args = create
    ? ["checkout", "-b", cleanBranch]
    : ["checkout", cleanBranch]
  await gitRun(cwd, args)
  await invalidateStatusCache(cwd)
}

export async function stash(cwd: string, message?: string) {
  const args = message ? ["stash", "push", "-m", message] : ["stash", "push"]
  await gitRun(cwd, args)
  await invalidateStatusCache(cwd)
}

export async function stashPop(cwd: string) {
  await gitRun(cwd, ["stash", "pop"])
  await invalidateStatusCache(cwd)
}

/**
 * Rename a branch in `cwd`. `newName` must be a valid git ref; we do NOT
 * enforce naming conventions here — that's the caller's job (see WorktreeManager's
 * slugify). Follows with a status refresh so callers see the new branch name
 * immediately, per the Objective 2 Tier 1 spec.
 */
export async function renameBranch(
  cwd: string,
  oldName: string,
  newName: string
): Promise<void> {
  const cleanOldName = await assertValidBranchName(cwd, oldName)
  const cleanNewName = await assertValidBranchName(cwd, newName)
  await gitRun(cwd, ["branch", "-m", cleanOldName, cleanNewName])
  await invalidateStatusCache(cwd)
}

export async function deleteBranch(
  cwd: string,
  branch: string,
  force = false
): Promise<void> {
  const cleanBranch = await assertValidBranchName(cwd, branch)
  try {
    await gitRun(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `refs/heads/${cleanBranch}`,
    ])
  } catch (error) {
    if (isMissingRevisionError(error)) return
    throw error
  }
  await gitRun(cwd, ["branch", force ? "-D" : "-d", cleanBranch])
  await invalidateStatusCache(cwd)
}
