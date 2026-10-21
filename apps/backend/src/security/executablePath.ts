import fs from "node:fs"
import path from "node:path"

/**
 * Resolve a bare program name to an absolute executable path without ever
 * consulting the current working directory.
 *
 * Why this exists: when a spawn passes a bare name such as `git`, libuv on
 * Windows looks in the CHILD'S cwd first (trying `git.com`, then `git.exe`)
 * and only then walks PATH, and cmd.exe does the same for anything it
 * launches. Every Git, shell and provider spawn in the backend runs with the
 * workspace as its cwd, so a repository that commits `git.exe` (or
 * `powershell.exe`, or `codex.cmd` for a cmd-wrapped launch) at its root
 * would run that file as soon as the folder is opened. On POSIX `execvp`
 * never searches cwd unless PATH itself contains an empty or relative entry,
 * which this resolver skips for the same reason.
 *
 * The lookup walks only absolute PATH entries, honours PATHEXT order on
 * Windows (preferring `.exe`/`.com`, which can be spawned without a shell),
 * and caches results per PATH value so hot paths such as `gitRun` do not
 * touch the filesystem on every call.
 */

export interface ExecutableLookupOptions {
  /** PATH to search; defaults to the backend's own PATH. */
  readonly pathValue?: string
  /** PATHEXT to honour on Windows; defaults to the backend's PATHEXT. */
  readonly pathExt?: string
  readonly platform?: NodeJS.Platform
  /**
   * Windows only: also accept batch shims (`.cmd`, `.bat`, and any other
   * PATHEXT entry). Those cannot be spawned directly and must go through
   * cmd.exe, so only callers that wrap the launch should set this.
   */
  readonly allowScripts?: boolean
  /** Test seam: whether `candidate` is an executable regular file. */
  readonly isExecutableFile?: (candidate: string) => boolean
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD"
const DIRECT_WINDOWS_EXTENSIONS = new Set([".COM", ".EXE"])
const POSITIVE_CACHE_TTL_MS = 5 * 60_000
const NEGATIVE_CACHE_TTL_MS = 15_000
const MAX_CACHE_ENTRIES = 256
const MAX_PATH_ENTRIES = 512

interface CacheEntry {
  readonly value: string | null
  readonly expiresAt: number
}

const lookupCache = new Map<string, CacheEntry>()

/** Test-only: forget every cached lookup. */
export function clearExecutablePathCache(): void {
  lookupCache.clear()
}

/**
 * Absolute path of `name` on PATH, or `null` when it is not installed.
 *
 * `name` may already be an absolute path (returned unchanged when it is an
 * executable file). A relative path with a separator (`./git`, `bin\git`)
 * is refused: it can only resolve against cwd, which is the hazard.
 */
export function resolveExecutableOnPath(
  name: string,
  options: ExecutableLookupOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const isExecutableFile =
    options.isExecutableFile ?? defaultIsExecutableFile(platform)
  const trimmed = name.trim()
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return null
  if (isAbsoluteExecutablePath(trimmed, platform)) {
    return isExecutableFile(trimmed) ? trimmed : null
  }
  if (
    /[\\/]/.test(trimmed) ||
    (platform === "win32" && trimmed.includes(":"))
  ) {
    return null
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? ""
  const pathExt =
    platform === "win32"
      ? (options.pathExt ?? process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT)
      : ""
  const allowScripts = options.allowScripts === true
  const cacheKey = [
    platform,
    allowScripts ? "scripts" : "direct",
    pathExt,
    pathValue,
    platform === "win32" ? trimmed.toLowerCase() : trimmed,
  ].join("\0")
  const now = Date.now()
  const cached = options.isExecutableFile
    ? undefined
    : lookupCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    // A cached hit is re-checked: an uninstalled or moved binary must not be
    // handed to spawn, and one stat is far cheaper than a PATH walk.
    if (cached.value === null || isExecutableFile(cached.value)) {
      return cached.value
    }
  }

  const candidates = candidateFileNames(
    trimmed,
    platform,
    pathExt,
    allowScripts
  )
  let resolved: string | null = null
  search: for (const directory of absolutePathEntries(pathValue, platform)) {
    for (const fileName of candidates) {
      const candidate = pathApi.join(directory, fileName)
      if (isExecutableFile(candidate)) {
        resolved = candidate
        break search
      }
    }
  }

  if (!options.isExecutableFile) {
    if (lookupCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = lookupCache.keys().next().value
      if (oldest !== undefined) lookupCache.delete(oldest)
    }
    lookupCache.delete(cacheKey)
    lookupCache.set(cacheKey, {
      value: resolved,
      expiresAt:
        now +
        (resolved === null ? NEGATIVE_CACHE_TTL_MS : POSITIVE_CACHE_TTL_MS),
    })
  }
  return resolved
}

/**
 * Like {@link resolveExecutableOnPath}, but throws an `ENOENT`-coded error
 * instead of returning `null`, so a missing tool fails the same way a failed
 * spawn of a bare name used to.
 */
export function requireExecutableOnPath(
  name: string,
  options: ExecutableLookupOptions = {}
): string {
  const resolved = resolveExecutableOnPath(name, options)
  if (resolved) return resolved
  throw Object.assign(new Error(`${name} was not found on PATH.`), {
    code: "ENOENT",
    errno: -2,
    syscall: `spawn ${name}`,
    path: name,
  })
}

/** `%SystemRoot%`, falling back to `C:\Windows` like the Electron shell does. */
export function windowsSystemRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = (
    env.SystemRoot ??
    env.SYSTEMROOT ??
    env.windir ??
    env.WINDIR
  )?.trim()
  return configured &&
    path.win32.isAbsolute(configured) &&
    /^[a-zA-Z]:[\\/]/.test(configured)
    ? configured
    : "C:\\Windows"
}

/**
 * Absolute path of a Windows system tool under `%SystemRoot%\System32`, e.g.
 * `windowsSystemExecutable("taskkill.exe")` or
 * `windowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe")`.
 */
export function windowsSystemExecutable(...segments: string[]): string {
  return path.win32.join(windowsSystemRoot(), "System32", ...segments)
}

export function isAbsoluteExecutablePath(
  value: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return path.posix.isAbsolute(value)
  // `C:foo` is drive-relative and `\foo` is relative to the current drive;
  // neither is a stable location.
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
}

function absolutePathEntries(
  pathValue: string,
  platform: NodeJS.Platform
): string[] {
  const delimiter = platform === "win32" ? ";" : ":"
  const seen = new Set<string>()
  const entries: string[] = []
  for (const raw of pathValue.split(delimiter)) {
    const entry = raw
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim()
    // Empty entries mean "current directory" on POSIX; relative ones resolve
    // against cwd everywhere. Both are exactly what this module refuses.
    if (!entry || !isAbsoluteExecutablePath(entry, platform)) continue
    const key = platform === "win32" ? entry.toLowerCase() : entry
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
    if (entries.length >= MAX_PATH_ENTRIES) break
  }
  return entries
}

function candidateFileNames(
  name: string,
  platform: NodeJS.Platform,
  pathExt: string,
  allowScripts: boolean
): string[] {
  if (platform !== "win32") return [name]
  const extensions = pathExt
    .split(";")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => /^\.[A-Z0-9]+$/.test(entry))
  // Directly spawnable extensions first, in PATHEXT order; libuv can only
  // start these without cmd.exe. Batch shims follow only when the caller
  // wraps the launch in cmd.
  const ordered = [
    ...extensions.filter((entry) => DIRECT_WINDOWS_EXTENSIONS.has(entry)),
    ...(extensions.some((entry) => DIRECT_WINDOWS_EXTENSIONS.has(entry))
      ? []
      : [".EXE", ".COM"]),
    ...(allowScripts
      ? extensions.filter((entry) => !DIRECT_WINDOWS_EXTENSIONS.has(entry))
      : []),
  ]
  const unique = [...new Set(ordered)]
  const existing = path.win32.extname(name).toUpperCase()
  if (
    existing &&
    (unique.includes(existing) || DIRECT_WINDOWS_EXTENSIONS.has(existing))
  ) {
    if (!allowScripts && !DIRECT_WINDOWS_EXTENSIONS.has(existing)) return []
    return [name]
  }
  return unique.map((extension) => `${name}${extension.toLowerCase()}`)
}

function defaultIsExecutableFile(
  platform: NodeJS.Platform
): (candidate: string) => boolean {
  return (candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false
      if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
