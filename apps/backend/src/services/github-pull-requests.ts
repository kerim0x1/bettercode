import { resolveExecutableOnPath } from "../security/executablePath"
import { gitRun } from "./git/process"
import { runCommand } from "./provider-usage/command"

/**
 * Recent pull requests of a workspace's GitHub repository, for the sidebar's
 * per-chat PR status. Read through the user's own GitHub CLI login.
 *
 * `gh` runs outside the repository with an explicit `--repo`, so it reads no
 * repository config and runs nothing from the workspace; only the remote URL
 * comes from the repository, through the hardened git runner. Results are
 * shared per repository for a minute, since every sidebar project polls.
 */

export type PullRequestState = "open" | "draft" | "merged" | "closed"

export interface BranchPullRequest {
  number: number
  title: string
  url: string
  state: PullRequestState
  branch: string
  updatedAt: string | null
}

export interface PullRequestListing {
  available: boolean
  pullRequests: BranchPullRequest[]
}

const CACHE_TTL_MS = 60_000
/** A missing or signed-out `gh` is rechecked less often. */
const UNAVAILABLE_TTL_MS = 5 * 60_000
const GH_TIMEOUT_MS = 15_000
const LIST_LIMIT = 100
const MAX_CACHED_REPOSITORIES = 64

const UNAVAILABLE: PullRequestListing = { available: false, pullRequests: [] }

const byRepository = new Map<
  string,
  {
    listing?: PullRequestListing
    expiresAt: number
    pending?: Promise<PullRequestListing>
  }
>()

/** `owner/name` of a GitHub remote URL (HTTPS, SSH or scp-style), else null. */
export function parseGitHubSlug(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim()
    )
  return match ? `${match[1]}/${match[2]}` : null
}

/** Maps `gh pr list --json` rows; anything malformed is skipped. */
export function parsePullRequests(json: string): BranchPullRequest[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const pullRequests: BranchPullRequest[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const value = row as Record<string, unknown>
    // A fork's `main` is not this repository's `main`.
    if (value.isCrossRepository === true) continue
    const number = value.number
    const branch = value.headRefName
    const url = value.url
    if (
      typeof number !== "number" ||
      typeof branch !== "string" ||
      typeof url !== "string" ||
      !branch
    ) {
      continue
    }
    const rawState = String(value.state ?? "").toUpperCase()
    const state: PullRequestState =
      rawState === "MERGED"
        ? "merged"
        : rawState === "CLOSED"
          ? "closed"
          : value.isDraft === true
            ? "draft"
            : "open"
    pullRequests.push({
      number,
      title: typeof value.title === "string" ? value.title : "",
      url,
      state,
      branch,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    })
  }
  return pullRequests
}

/** A git remote of the repository that points at GitHub. */
export interface GitHubRemote {
  /** The git remote's name (`origin`). */
  name: string
  /** `owner/name` on GitHub. */
  slug: string
}

/**
 * The repository's GitHub remote: `origin` when it points at GitHub, else
 * the first remote that does; null without one.
 */
export async function githubRemote(cwd: string): Promise<GitHubRemote | null> {
  let stdout: string
  try {
    ;({ stdout } = await gitRun(cwd, [
      "config",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ]))
  } catch {
    // No remote at all, or not a repository.
    return null
  }
  const remotes = stdout
    .split(/\r?\n/)
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, slug: parseGitHubSlug(match[2]!) }))
    .filter((remote): remote is GitHubRemote => Boolean(remote.slug))
  return (
    remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null
  )
}

async function githubSlug(cwd: string): Promise<string | null> {
  return (await githubRemote(cwd))?.slug ?? null
}

/**
 * Forgets the repository's cached list, so the next read asks GitHub again
 * (after a pull request was created, merged or closed here).
 */
export function invalidatePullRequests(slug: string): void {
  // Dropped rather than expired: a read already on its way predates the
  // change and would otherwise be cached as fresh.
  byRepository.delete(slug.toLowerCase())
}

async function fetchPullRequests(slug: string): Promise<PullRequestListing> {
  const gh = resolveExecutableOnPath("gh", {
    allowScripts: process.platform === "win32",
  })
  if (!gh) return UNAVAILABLE
  const result = await runCommand(
    gh,
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--state",
      "all",
      "--limit",
      String(LIST_LIMIT),
      "--json",
      "number,title,url,state,isDraft,headRefName,isCrossRepository,updatedAt",
    ],
    GH_TIMEOUT_MS
  )
  // A non-zero exit is a signed-out CLI, an unknown repository or no network.
  if (result.status !== 0) return UNAVAILABLE
  return { available: true, pullRequests: parsePullRequests(result.stdout) }
}

export async function listPullRequests(
  cwd: string
): Promise<PullRequestListing> {
  const slug = await githubSlug(cwd)
  if (!slug) return UNAVAILABLE
  const key = slug.toLowerCase()
  let entry = byRepository.get(key)
  if (!entry) {
    if (byRepository.size >= MAX_CACHED_REPOSITORIES) {
      byRepository.delete(byRepository.keys().next().value!)
    }
    entry = { expiresAt: 0 }
    byRepository.set(key, entry)
  }
  if (entry.pending) return entry.pending
  if (entry.listing && entry.expiresAt > Date.now()) return entry.listing
  const current = entry
  current.pending = fetchPullRequests(slug)
    .then((listing) => {
      // A failed refresh keeps the last list instead of blanking the sidebar.
      if (!listing.available && current.listing?.available) {
        current.expiresAt = Date.now() + CACHE_TTL_MS
        return current.listing
      }
      current.listing = listing
      current.expiresAt =
        Date.now() + (listing.available ? CACHE_TTL_MS : UNAVAILABLE_TTL_MS)
      return listing
    })
    .finally(() => {
      current.pending = undefined
    })
  return current.pending
}
