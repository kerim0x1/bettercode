import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * macOS apps started from Finder, the Dock or Spotlight inherit launchd's
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Every child the backend
 * starts copies PATH, and `bash -c` is neither a login nor an interactive
 * shell, so Homebrew, nvm, volta and asdf binaries were invisible to the
 * agent's Bash tool, `/shell/run`, hooks, formatters and git hooks
 * (`npx: command not found`, `env: node: No such file or directory`).
 *
 * At startup, when PATH looks like launchd's, ask the user's login shell for
 * its PATH once, the way VS Code resolves its shell environment, and merge
 * the absolute entries in front of the inherited ones in `process.env.PATH`.
 * Every environment builder and the executable resolver read that value, so
 * all children see the user's PATH. The Electron host may already have done
 * this and pass the result in `BETTERC0DE_LOGIN_SHELL_PATH`; that wins.
 */

export const LOGIN_SHELL_PATH_ENV = "BETTERC0DE_LOGIN_SHELL_PATH"

const LOGIN_SHELL_TIMEOUT_MS = 5_000
const MAX_OUTPUT_BYTES = 64 * 1024
const START_MARKER = "__BETTERC0DE_PATH_START__"
const END_MARKER = "__BETTERC0DE_PATH_END__"
const MINIMAL_DARWIN_PATH_ENTRIES = new Set([
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
])
const FALLBACK_DARWIN_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
]
const SUPPORTED_LOGIN_SHELLS = new Set([
  "zsh",
  "bash",
  "sh",
  "ksh",
  "dash",
  "fish",
])

let loginShellPathPromise: Promise<string | null> | null = null

export interface LoginShellPathOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  /** Test seam for the login-shell query. */
  readonly queryLoginShellPath?: (shell: string) => Promise<string | null>
  readonly directoryExists?: (directory: string) => boolean
}

/**
 * Whether `pathValue` is launchd's default PATH, i.e. contains nothing but
 * the four system directories. A terminal-launched backend has more.
 */
export function isMinimalDarwinPath(pathValue: string | undefined): boolean {
  const entries = (pathValue ?? "").split(":").filter(Boolean)
  return entries.every((entry) => MINIMAL_DARWIN_PATH_ENTRIES.has(entry))
}

/**
 * Merge `preferred` entries in front of `inherited`, keeping only absolute
 * directories and dropping duplicates. Relative entries (`.`, `bin`,
 * `node_modules/.bin`) would resolve against each child's cwd, which is the
 * workspace, so they are never imported.
 */
export function mergePathEntries(
  preferred: string,
  inherited: string | undefined
): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [
    ...preferred.split(":"),
    ...(inherited ?? "").split(":"),
  ]) {
    const trimmed = entry.trim()
    if (!trimmed || !path.posix.isAbsolute(trimmed) || seen.has(trimmed))
      continue
    seen.add(trimmed)
    merged.push(trimmed)
  }
  return merged.join(":")
}

/**
 * Resolve the user's login-shell PATH once and merge it into
 * `process.env.PATH`. Safe to call repeatedly; only the first call does any
 * work. Never throws: on failure it falls back to the usual Homebrew and
 * `/usr/local` directories that exist.
 */
export function primeLoginShellPath(
  options: LoginShellPathOptions = {}
): Promise<string | null> {
  if (!loginShellPathPromise) {
    loginShellPathPromise = resolveAndApplyLoginShellPath(options).catch(
      () => null
    )
  }
  return loginShellPathPromise
}

/** Test-only: allow `primeLoginShellPath` to run again. */
export function __resetLoginShellPathForTests(): void {
  loginShellPathPromise = null
}

async function resolveAndApplyLoginShellPath(
  options: LoginShellPathOptions
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== "darwin") return null

  const provided = env[LOGIN_SHELL_PATH_ENV]?.trim()
  let resolved: string | null = provided || null
  if (!resolved) {
    if (!isMinimalDarwinPath(env.PATH)) return null
    const shell = loginShellExecutable(env)
    const query = options.queryLoginShellPath ?? queryLoginShellPath
    resolved = shell ? await query(shell).catch(() => null) : null
  }
  if (!resolved) {
    const directoryExists = options.directoryExists ?? defaultDirectoryExists
    resolved = FALLBACK_DARWIN_PATH_ENTRIES.filter(directoryExists).join(":")
  }
  if (!resolved) return null
  const merged = mergePathEntries(resolved, env.PATH)
  if (merged) env.PATH = merged
  return merged || null
}

function loginShellExecutable(env: NodeJS.ProcessEnv): string | null {
  const shell = env.SHELL?.trim()
  if (
    shell &&
    path.posix.isAbsolute(shell) &&
    SUPPORTED_LOGIN_SHELLS.has(path.posix.basename(shell))
  ) {
    return shell
  }
  return fs.existsSync("/bin/zsh") ? "/bin/zsh" : null
}

/**
 * Run `$SHELL -ilc` and read PATH between two markers, so anything a profile
 * prints (banners, nvm notices) is ignored. Bounded by a timeout; the whole
 * process group is killed when it expires because an interactive profile may
 * start helpers.
 */
async function queryLoginShellPath(shell: string): Promise<string | null> {
  const isFish = path.posix.basename(shell) === "fish"
  const script = isFish
    ? `printf '%s%s%s' '${START_MARKER}' (string join : $PATH) '${END_MARKER}'`
    : `printf '%s%s%s' '${START_MARKER}' "$PATH" '${END_MARKER}'`
  return await new Promise<string | null>((resolve) => {
    let settled = false
    let output = ""
    const child = spawn(shell, ["-ilc", script], {
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        SHELL: shell,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    })
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        // The group may already be gone.
      }
      finish(null)
    }, LOGIN_SHELL_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk
    })
    child.once("error", () => finish(null))
    child.once("close", () => {
      const start = output.lastIndexOf(START_MARKER)
      const end = output.indexOf(END_MARKER, start + START_MARKER.length)
      finish(
        start >= 0 && end > start
          ? output.slice(start + START_MARKER.length, end).trim() || null
          : null
      )
    })
  })
}

function defaultDirectoryExists(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}
