import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import os from "node:os"
import { assertSafeAbsolutePath } from "./filesystem-path-safety"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ListEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number | null
  mtime: number | null
}

export interface ListResult {
  path: string
  parent: string | null
  entries: ListEntry[]
  truncated: boolean
  nextOffset?: number
}

export interface SearchHit {
  path: string
  name: string
  isDir: boolean
  score: number
}

export interface SearchResult {
  entries: SearchHit[]
  truncated: boolean
  tookMs: number
}

export type DriveKind = "drive" | "home" | "volume" | "shortcut" | "root"

export interface DriveEntry {
  path: string
  label: string
  kind: DriveKind
  reachable: boolean
}

export interface DrivesResult {
  platform: NodeJS.Platform
  entries: DriveEntry[]
}

// ────────────────────────────────────────────────────────────────────────────
// listDirectory — immediate children of a path, sorted, capped
// ────────────────────────────────────────────────────────────────────────────

const LIST_ENTRY_CAP = 5000

export async function listDirectory(
  rawPath: unknown,
  showHidden: boolean = false,
  offset: number = 0
): Promise<ListResult> {
  const target = assertSafeAbsolutePath(rawPath)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw Object.assign(
      new Error("offset must be a non-negative safe integer"),
      { statusCode: 400 }
    )
  }

  let dirents: import("node:fs").Dirent[]
  try {
    dirents = await fs.readdir(target, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw Object.assign(new Error(`not a directory: ${target}`), {
        statusCode: 404,
      })
    }
    if (code === "EACCES" || code === "EPERM") {
      throw Object.assign(new Error(`permission denied: ${target}`), {
        statusCode: 403,
      })
    }
    throw err
  }

  // Filter + initial projection (no stat yet).
  const visible = (
    showHidden ? dirents : dirents.filter((d) => !d.name.startsWith("."))
  ).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return (
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.name.localeCompare(b.name)
    )
  })

  // Cap before stat to bound work on 100k-child dirs.
  const slice = visible.slice(offset, offset + LIST_ENTRY_CAP)
  const nextOffset = offset + slice.length
  const truncated = nextOffset < visible.length

  // Stat each entry in parallel; swallow per-entry errors (EACCES on a single
  // file shouldn't break the listing).
  const entries: ListEntry[] = await Promise.all(
    slice.map(async (d) => {
      const abs = path.join(target, d.name)
      let isDir = d.isDirectory()
      const isSymlink = d.isSymbolicLink()
      let size: number | null = null
      let mtime: number | null = null
      try {
        const st = await fs.stat(abs)
        size = st.isFile() ? st.size : null
        mtime = st.mtimeMs
        // If dirent was a symlink, stat() follows it — use the target's isDir
        // so the UI shows the right icon for symlinked dirs.
        if (isSymlink) isDir = st.isDirectory()
      } catch {
        // Broken symlink, permission denied on target, race delete. Keep the
        // entry visible with nulls so the user can still see its name exists.
      }
      return { name: d.name, path: abs, isDir, isSymlink, size, mtime }
    })
  )

  // Dirs first, then files; case-insensitive alphabetical within each group.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })

  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
    truncated,
    ...(truncated ? { nextOffset } : {}),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// searchTree — recursive walk with time budget, entry cap, depth cap,
//              symlink cycle guard
// ────────────────────────────────────────────────────────────────────────────

const SEARCH_DEFAULT_LIMIT = 2000
const SEARCH_ABSOLUTE_MAX = 5000
// Bumped from 8 to 20 — real project trees with workspaces / nested
// node_modules / generator output (e.g. .next/cache/webpack/server/...)
// regularly exceed 8 levels. 20 is enough for nearly any real codebase
// while still bounding pathological symlink chains together with the
// visited-set + wall-clock cap below.
const SEARCH_DEPTH_CAP = 20
// Bumped from 500ms / 1000ms — interactive search across the whole user
// home should be willing to wait a beat for thoroughness; the AbortController
// on every keystroke keeps the perceived latency low because in-flight
// queries are cancelled when the user keeps typing.
const SEARCH_SOFT_BUDGET_MS = 1500
const SEARCH_HARD_BUDGET_MS = 3000
const SEARCH_VISITED_CAP = 200_000
// Skip these directory names entirely during recursive search — they
// dominate file counts on dev machines without ever holding files the
// user is searching for. Mirrors the BASELINE_IGNORES of workspace.ts.
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gradle",
  ".idea",
  ".vscode-test",
])

/** `child` is `parent` or inside it, comparing resolved paths (case-folded on Windows). */
export function isPathWithin(parent: string, child: string): boolean {
  const fold = (value: string) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value)
  const relative = path.relative(fold(parent), fold(child))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function scoreMatch(name: string, needle: string): number {
  if (!needle) return 0
  const lowered = name.toLowerCase()
  const q = needle.toLowerCase()
  if (lowered === q) return 3
  if (lowered.startsWith(q)) return 2
  if (lowered.includes(q)) return 1
  return -1
}

export async function searchTree(
  rawRoot: unknown,
  query: unknown,
  rawLimit: unknown
): Promise<SearchResult> {
  const root = assertSafeAbsolutePath(rawRoot)
  const needle = typeof query === "string" ? query.trim() : ""
  const requestedLimit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(SEARCH_ABSOLUTE_MAX, Math.floor(rawLimit)))
      : SEARCH_DEFAULT_LIMIT

  const start = Date.now()
  const hits: SearchHit[] = []
  const visited = new Set<string>()

  // Seed the visited set with the root's realpath (if resolvable) so
  // symlinks pointing back to the root don't re-enter the walk.
  let rootReal = root
  try {
    rootReal = await fs.realpath(root)
  } catch {
    // Unresolvable root: confine against the path as given.
  }
  visited.add(rootReal)

  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > SEARCH_DEPTH_CAP) return false
    if (hits.length >= requestedLimit) return true
    const now = Date.now()
    if (now - start > SEARCH_HARD_BUDGET_MS) return true

    let dirents: import("node:fs").Dirent[]
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }

    for (const d of dirents) {
      if (hits.length >= requestedLimit) return true
      if (Date.now() - start > SEARCH_HARD_BUDGET_MS) return true

      const abs = path.join(dir, d.name)
      const score = scoreMatch(d.name, needle)
      if (score >= 0 || !needle) {
        hits.push({
          path: abs,
          name: d.name,
          isDir: d.isDirectory() || d.isSymbolicLink(),
          score: score < 0 ? 0 : score,
        })
      }

      if (d.isDirectory() || d.isSymbolicLink()) {
        // Skip dependency / cache / build dirs that explode the walk
        // without containing user-meaningful matches.
        if (SEARCH_SKIP_DIRS.has(d.name)) continue
        // Symlink cycle guard — resolve realpath and skip if already visited.
        // Soft budget controls recursion depth for symlinks specifically;
        // non-symlink dirs don't pay the realpath cost.
        let realTarget = abs
        if (d.isSymbolicLink()) {
          try {
            realTarget = await fs.realpath(abs)
            // The root is the confinement boundary for a remote caller: a
            // link (or Windows junction) whose target lives outside it is
            // listed as an entry but never descended, or the walk would hand
            // a paired device the rest of the disk.
            if (!isPathWithin(rootReal, realTarget)) continue
            if (visited.has(realTarget)) continue
            if (visited.size < SEARCH_VISITED_CAP) visited.add(realTarget)
            // Confirm it's a directory before descending — file symlinks
            // should not recurse.
            const st = await fs.stat(realTarget)
            if (!st.isDirectory()) continue
          } catch {
            continue
          }
        }
        const done = await walk(abs, depth + 1)
        if (done) return true
      }
    }
    return false
  }

  await walk(root, 0)

  // Rank: higher score first, then shorter name (more specific),
  // then alphabetical.
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.name.length !== b.name.length) return a.name.length - b.name.length
    return a.name.localeCompare(b.name)
  })

  const tookMs = Date.now() - start
  const truncated =
    hits.length >= requestedLimit || tookMs > SEARCH_SOFT_BUDGET_MS
  return { entries: hits.slice(0, requestedLimit), truncated, tookMs }
}

// ────────────────────────────────────────────────────────────────────────────
// enumerateDrives — platform-specific roots + favorites
// ────────────────────────────────────────────────────────────────────────────

const DRIVES_CACHE_TTL_MS = 30_000
const DRIVE_PROBE_TIMEOUT_MS = 800

let drivesCache: { at: number; result: DrivesResult } | null = null

function clearDrivesCache(): void {
  drivesCache = null
}

// Exported for tests only.
export const _internal = { clearDrivesCache, DRIVE_PROBE_TIMEOUT_MS }

async function probeWithTimeout(p: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(false)
      }
    }, DRIVE_PROBE_TIMEOUT_MS)
    fs.access(p)
      .then(() => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(true)
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(false)
        }
      })
  })
}

async function enumerateWindowsDrives(): Promise<DriveEntry[]> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
  const probes = await Promise.all(
    letters.map(async (L) => {
      const root = `${L}:\\`
      const reachable = await probeWithTimeout(root)
      return { letter: L, root, reachable }
    })
  )
  return probes
    .filter((p) => p.reachable)
    .map(
      (p): DriveEntry => ({
        path: p.root,
        label: `${p.letter}:`,
        kind: "drive",
        reachable: true,
      })
    )
}

async function enumerateMacEntries(): Promise<DriveEntry[]> {
  const entries: DriveEntry[] = []
  try {
    const vols = await fs.readdir("/Volumes", { withFileTypes: true })
    for (const v of vols) {
      if (!v.isDirectory() && !v.isSymbolicLink()) continue
      entries.push({
        path: path.join("/Volumes", v.name),
        label: v.name,
        kind: "volume",
        reachable: true,
      })
    }
  } catch {
    // /Volumes unreadable — fall through, still list shortcuts.
  }
  return entries
}

async function enumerateLinuxEntries(): Promise<DriveEntry[]> {
  const entries: DriveEntry[] = [
    { path: "/", label: "Root", kind: "root", reachable: true },
  ]
  const userName = os.userInfo().username
  const mediaUser = `/media/${userName}`
  for (const candidate of [mediaUser, "/mnt"]) {
    try {
      const children = await fs.readdir(candidate, { withFileTypes: true })
      for (const c of children) {
        if (!c.isDirectory() && !c.isSymbolicLink()) continue
        entries.push({
          path: path.join(candidate, c.name),
          label: c.name,
          kind: "volume",
          reachable: true,
        })
      }
    } catch {
      // candidate absent — skip.
    }
  }
  return entries
}

function homeShortcuts(): DriveEntry[] {
  const home = os.homedir()
  const shortcuts: DriveEntry[] = [
    { path: home, label: "Home", kind: "home", reachable: true },
  ]
  const CANDIDATES = ["Desktop", "Documents", "Downloads"]
  for (const name of CANDIDATES) {
    const p = path.join(home, name)
    try {
      if (fsSync.existsSync(p)) {
        shortcuts.push({
          path: p,
          label: name,
          kind: "shortcut",
          reachable: true,
        })
      }
    } catch {
      // ignore
    }
  }
  return shortcuts
}

export async function enumerateDrives(): Promise<DrivesResult> {
  const now = Date.now()
  if (drivesCache && now - drivesCache.at < DRIVES_CACHE_TTL_MS) {
    return drivesCache.result
  }
  const platform = process.platform
  const shortcuts = homeShortcuts()
  let platformEntries: DriveEntry[] = []
  if (platform === "win32") {
    platformEntries = await enumerateWindowsDrives()
  } else if (platform === "darwin") {
    platformEntries = await enumerateMacEntries()
  } else {
    platformEntries = await enumerateLinuxEntries()
  }
  const result: DrivesResult = {
    platform,
    entries: [...shortcuts, ...platformEntries],
  }
  drivesCache = { at: now, result }
  return result
}
