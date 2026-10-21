/**
 * macOS apps started from Finder, the Dock or Spotlight inherit launchd's
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew, nvm, volta,
 * asdf and friends are invisible to every tool the backend runs. Terminals
 * get the full PATH from the user's login shell profile; this module asks
 * that shell once, with a timeout, and merges the answer with what the app
 * already has.
 *
 * The probe runs `$SHELL -ilc` with an external `printenv`, which prints the
 * exported PATH the same way for zsh, bash and fish. Output is fenced by
 * random markers because interactive profiles often print banners.
 */

const { spawn } = require("node:child_process")
const { randomUUID } = require("node:crypto")
const path = require("node:path")

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 256 * 1024
/** Common locations when the login shell cannot be asked. */
const DARWIN_FALLBACK_PATH_ENTRIES = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
])

function splitPath(value) {
  return typeof value === "string"
    ? value.split(path.posix.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : []
}

/** Absolute, de-duplicated PATH entries in first-seen order. */
function mergePathLists(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : splitPath(list)) {
      if (!path.posix.isAbsolute(entry) || entry.includes("\u0000") || seen.has(entry)) continue
      seen.add(entry)
      merged.push(entry)
    }
  }
  return merged.join(path.posix.delimiter)
}

function parseMarkedOutput(output, marker) {
  const start = output.indexOf(marker)
  if (start < 0) return null
  const end = output.indexOf(marker, start + marker.length)
  if (end < 0) return null
  const value = output.slice(start + marker.length, end).trim()
  return value || null
}

/**
 * Resolve PATH as the user's login shell sets it. Resolves `null` when the
 * shell is unusable, times out or prints nothing usable; never rejects.
 */
function resolveLoginShellPath({
  shell = process.env.SHELL,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  const shellPath =
    typeof shell === "string" && path.posix.isAbsolute(shell) && !shell.includes("\u0000")
      ? shell
      : "/bin/zsh"
  const marker = `__BETTERC0DE_PATH_${randomUUID().replace(/-/g, "")}__`
  const command = `/usr/bin/printf '%s' '${marker}'; /usr/bin/printenv PATH; /usr/bin/printf '%s' '${marker}'`

  return new Promise((resolve) => {
    let settled = false
    let output = ""
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const stop = () => {
      if (!child?.pid) return
      try { killProcessGroup(child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch { /* already gone */ }
      }
    }
    const timer = setTimeout(() => {
      stop()
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    try {
      child = spawnImpl(shellPath, ["-i", "-l", "-c", command], {
        // stdin closed: an interactive profile must not wait for input.
        stdio: ["ignore", "pipe", "ignore"],
        // Own process group, so a timeout can stop whatever the profile started.
        detached: true,
        env: { ...env, BETTERC0DE_RESOLVING_ENVIRONMENT: "1" },
      })
    } catch {
      finish(null)
      return
    }
    child.stdout?.setEncoding?.("utf8")
    child.stdout?.on("data", (chunk) => {
      output += chunk
      if (output.length > MAX_OUTPUT_BYTES) {
        stop()
        finish(null)
      }
    })
    child.on("error", () => finish(null))
    child.on("close", () => {
      const value = parseMarkedOutput(output, marker)
      const entries = splitPath(value).filter((entry) => path.posix.isAbsolute(entry))
      finish(entries.length > 0 ? entries.join(path.posix.delimiter) : null)
    })
  })
}

/**
 * PATH for macOS child processes: the login shell's PATH first, then the
 * app's own entries, then well-known fallbacks so Homebrew is found even
 * when the profile could not be evaluated.
 */
async function resolveDarwinChildPath(options = {}) {
  const current = options.env?.PATH ?? process.env.PATH
  const loginPath = await resolveLoginShellPath(options)
  return {
    path: mergePathLists(loginPath, current, DARWIN_FALLBACK_PATH_ENTRIES),
    fromLoginShell: loginPath !== null,
  }
}

module.exports = {
  DARWIN_FALLBACK_PATH_ENTRIES,
  mergePathLists,
  parseMarkedOutput,
  resolveDarwinChildPath,
  resolveLoginShellPath,
}
