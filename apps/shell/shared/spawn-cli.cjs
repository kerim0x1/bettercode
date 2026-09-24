/**
 * Shared CLI spawn helper for the Electron main process.
 *
 * Windows contract copied from `apps/backend/src/services/image-generation.ts`
 * / `CodexRpcClient.spawnChild` (rpc.ts): Node >= 18.20 refuses to spawn
 * `.cmd` / extension-less npm shims directly, and spawning a script file via
 * its file association is a trap (a `.cjs` opens the user's editor instead
 * of node). So anything that is not an absolute `.exe` path goes through
 * `%ComSpec% /d /s /c` with cmd-style caret escaping.
 */

const { spawn } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const PROCESS_TREE_SETTLE_TIMEOUT_MS = 5_000
const CLI_SHUTDOWN_TIMEOUT_MS = 10_000
const MAX_ACTIVE_CLI_PROCESSES = 4
const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]
const UNSAFE_ENV_KEYS = new Set([
  "BETTERC0DE_SETTINGS_KEY",
  "BASH_ENV",
  "ENV",
  "ELECTRON_RUN_AS_NODE",
  "LD_AUDIT",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
])
let acceptingCliProcesses = true
let cliShutdownPromise = null
const activeCliProcesses = new Map()

function isUnsafeEnvironmentKey(name) {
  const normalized = String(name || "").trim().toUpperCase()
  return UNSAFE_ENV_KEYS.has(normalized) || normalized.startsWith("DYLD_")
}

function sanitizedCliEnvironment(overrides = {}) {
  const env = {}
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined && !isUnsafeEnvironmentKey(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      value !== undefined &&
      !isUnsafeEnvironmentKey(key)
    ) {
      env[key] = String(value)
    }
  }
  return env
}

/**
 * Argument quoting for the `cmd.exe /d /s /c "<line>"` +
 * `windowsVerbatimArguments: true` spawn pattern below.
 *
 * VERBATIM MIRROR of `apps/backend/src/security/windowsCommandLine.ts`
 * (`quoteWindowsCmdArg`, `quoteWindowsCmdPath`, `buildWindowsCmdArgs`). The
 * two processes cannot share a module (CJS preload/main vs. the compiled
 * backend), so the algorithm is duplicated deliberately. THE TWO MUST STAY IN
 * SYNC: `scripts/spawn-cli-quoting.test.mjs` transpiles the backend source
 * and asserts both produce identical tokens, and drives a real `.cmd` shim
 * through this file. Change one, change the other, run both tests. The
 * backend header carries the full reasoning; the short version follows.
 *
 * Two layers, applied in order:
 *
 *  1. argv layer (MSVCRT rules) — the token the target program parses back
 *     into one argument: wrap in `"`, escape embedded `"` as `\"`, double any
 *     backslash run that precedes a quote or ends the token.
 *
 *  2. cmd layer — make the token inert to cmd. Which form depends on whether
 *     the value contains a `"`:
 *
 *     - No `"` in the value: the argv quotes stay REAL quotes. Inside a
 *       genuine cmd quoted region every operator is inert, and — the reason
 *       this matters — the quotes survive a `.cmd` shim's percent-star
 *       expansion. npm shims (`claude.cmd`, `codex.cmd`, …) re-parse their
 *       arguments when that expands, and by then cmd has already stripped
 *       every caret, so a caret-escaped `a^&b` arrives at the batch as `a&b`
 *       and runs `b` (this file shipped exactly that: `x>out.txt` wrote a
 *       file and `a|b` ran a pipe). Only `%` cannot live inside the quotes:
 *       `%VAR%` expands even in a quoted region and a caret is literal there,
 *       so each `%` is emitted BETWEEN quoted regions as `^%` — MSVCRT
 *       quote-toggling glues `"50"^%" off"` back into the single argument
 *       `50% off`.
 *
 *     - A `"` in the value: caret-escape every cmd metacharacter in the argv
 *       token, INCLUDING the quotes layer 1 added. Once the quotes are
 *       caret-escaped there is no quoted region from cmd's point of view and
 *       the whole token is inert literal text.
 *
 * A batch shim reparses embedded quotes as command syntax. The builder
 * rejects quoted arguments for possible batch targets, and rejects control
 * characters that cmd would truncate. A direct absolute exe receives quoted
 * values intact. The complete line remains subject to cmd's 8191-character limit.
 */

/** cmd.exe metacharacters that must be caret-escaped outside a quoted region. */
const CMD_METACHARACTERS = /([()%!^"<>&|])/g

/**
 * Characters that force quoting of an argv token: whitespace and `"` for
 * MSVCRT, plus every cmd operator and expansion character — a bare `a&b` is
 * one MSVCRT token, but a `.cmd` shim's re-parse would run it as two commands.
 */
const ARGV_NEEDS_QUOTING = /[\s"&|<>^()%!]/

/** Characters that require a `%`-free segment to sit inside real quotes. */
const SEGMENT_NEEDS_QUOTING = /[\s&|<>^()!]/

function quoteWindowsCmdArg(value) {
  // Empty argument: `""` at the argv layer, both quotes caret-escaped so cmd
  // does not open a quoted region.
  if (value.length === 0) return '^"^"'
  if (!ARGV_NEEDS_QUOTING.test(value)) return value
  if (value.includes('"')) return escapeForCmd(quoteForArgv(value))
  return quoteSegmentsAroundPercent(value)
}

/**
 * Real-quote form for a value without `"`: every `%` is emitted as `^%`
 * outside the quoted regions, everything else stays inside them. MSVCRT
 * toggles quote mode at each `"` within one token, so `"a"^%"b c"` is the
 * single argument `a%b c` to the program.
 */
function quoteSegmentsAroundPercent(value) {
  return value
    .split("%")
    .map((segment) => {
      if (segment.length === 0) return ""
      if (!SEGMENT_NEEDS_QUOTING.test(segment)) return segment
      return quoteForArgv(segment)
    })
    .join("^%")
}

/** MSVCRT argv quoting — what the target program's own parser expects. */
function quoteForArgv(value) {
  // Double every backslash run that immediately precedes a quote, then escape
  // the quote. Also double a trailing backslash run so it does not escape the
  // closing quote we are about to add.
  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1")
  return `"${escaped}"`
}

/**
 * Make the token literal to cmd. Quotes are escaped too, so cmd never enters a
 * quoted region and every metacharacter stays inert.
 */
function escapeForCmd(token) {
  return token.replace(CMD_METACHARACTERS, "^$1")
}

/**
 * Quote the COMMAND token. Deliberately different from `quoteWindowsCmdArg`:
 * cmd itself resolves this path, so it needs REAL quote delimiters. A
 * caret-escaped `^"` is a literal quote character, and cmd would then look for
 * a file whose name begins with `"` — every CLI under `C:\Program Files\…`
 * would fail with "not recognized". Real quoting is safe here because a
 * Windows path cannot contain `"`; an embedded quote is rejected rather than
 * mangled.
 */
function quoteWindowsCmdPath(command) {
  if (/["\r\n\0%!]/.test(command)) {
    throw Object.assign(
      new Error("Executable path must not contain a quote, control, or expansion character."),
      { statusCode: 400 }
    )
  }
  return /[\s()%!^<>&|]/.test(command) ? `"${command}"` : command
}

/** Full `/d /s /c "<line>"` vector — keeps the asymmetry above in one place. */
function buildWindowsCmdArgs(command, args) {
  for (const value of [command, ...args]) {
    if (/[\r\n\0]/.test(value)) {
      throw Object.assign(new Error("Windows command arguments must not contain CR, LF, or NUL."), { statusCode: 400 })
    }
  }
  const directExecutable = /\.exe$/i.test(command) && path.win32.isAbsolute(command)
  if (!directExecutable && args.some((value) => value.includes('"'))) {
    throw Object.assign(new Error("Quoted arguments require an absolute executable rather than a batch shim."), { statusCode: 400 })
  }
  const line = [
    quoteWindowsCmdPath(command),
    ...args.map(quoteWindowsCmdArg),
  ].join(" ")
  return ["/d", "/s", "/c", `"${line}"`]
}

const BINARY_CACHE_TTL_MS = 5 * 60_000
const binaryCache = new Map()

/** Well-known npm global shim locations checked when `where`/`which` fails. */
function knownBinaryCandidates(bin) {
  const home = os.homedir()
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    return [
      path.join(appData, "npm", `${bin}.cmd`),
      path.join(appData, "npm", `${bin}.ps1`),
      path.join(appData, "npm", bin),
    ]
  }
  return [
    path.join(home, ".local", "bin", bin),
    `/usr/local/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
    ...(process.platform === "darwin" && bin === "codex"
      ? [
          "/Applications/Codex.app/Contents/Resources/codex",
          path.join(home, ".bun", "bin", "codex"),
          path.join(home, ".npm-global", "bin", "codex"),
          path.join(home, ".volta", "bin", "codex"),
          path.join(home, "Library", "pnpm", "codex"),
          "/opt/local/bin/codex",
        ]
      : []),
  ]
}

/**
 * Resolve a CLI binary ("claude" | "codex" | "npx" | ...) to a spawnable
 * path, or null when not installed. Result cached for 5 minutes.
 */
function resolveCliBinary(bin) {
  if (typeof bin !== "string" || !/^[A-Za-z0-9._-]+$/.test(bin)) {
    return null
  }
  const cached = binaryCache.get(bin)
  if (cached && Date.now() - cached.at < BINARY_CACHE_TTL_MS) {
    return cached.path
  }
  let resolved = null
  const isWindows = process.platform === "win32"
  const separator = isWindows ? ";" : ":"
  const rawExtensions = isWindows
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""]
  const extensions =
    isWindows && path.extname(bin) ? [""] : rawExtensions
  const pathDirs = (process.env.PATH || "")
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .slice(0, 256)
  outer: for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${bin}${extension}`)
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile()) continue
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK)
        resolved = candidate
        break outer
      } catch {
        // Try the next deterministic PATH candidate.
      }
    }
  }
  if (!resolved) {
    for (const candidate of knownBinaryCandidates(bin)) {
      try {
        if (fs.existsSync(candidate)) {
          resolved = candidate
          break
        }
      } catch {
        // ignore
      }
    }
  }
  binaryCache.set(bin, { path: resolved, at: Date.now() })
  return resolved
}

function waitForPromise(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      timer.unref?.()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function taskkillExecutable() {
  const windowsRoot =
    process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows"
  return path.join(windowsRoot, "System32", "taskkill.exe")
}

function runTaskkill(pid, timeoutMs = PROCESS_TREE_SETTLE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let helper
    const finish = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    try {
      helper = spawn(taskkillExecutable(), ["/pid", String(pid), "/T", "/F"], {
        cwd: process.env.SYSTEMROOT || process.env.WINDIR || undefined,
        env: sanitizedCliEnvironment(),
        windowsHide: true,
        stdio: "ignore",
      })
    } catch (error) {
      finish(error)
      return
    }
    timer = setTimeout(() => {
      try {
        helper.kill("SIGKILL")
      } catch {
        // The helper may already have exited.
      }
      finish(new Error(`taskkill helper timed out for PID ${pid}`))
    }, Math.max(1, timeoutMs))
    timer.unref?.()
    helper.once("error", finish)
    helper.once("close", (code) => {
      if (code === 0) {
        finish()
      } else if (code === 128) {
        finish(
          new Error(
            `taskkill could not verify process tree ${pid} because its root no longer exists`,
          ),
        )
      } else {
        finish(new Error(`taskkill exited with code ${code}`))
      }
    })
  })
}

function processGroupExists(pid) {
  if (process.platform === "win32" || !pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process group ${pid} remained alive after termination`)
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25)
      timer.unref?.()
    })
  }
}

async function terminateProcessTree(child, closePromise) {
  const pid = child.pid
  if (!pid) return
  const errors = []
  if (process.platform === "win32") {
    try {
      await waitForPromise(
        runTaskkill(pid),
        PROCESS_TREE_SETTLE_TIMEOUT_MS,
        `taskkill timed out for PID ${pid}`,
      )
    } catch (error) {
      errors.push(error)
      try {
        child.kill("SIGKILL")
      } catch (fallbackError) {
        errors.push(fallbackError)
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM")
    } catch (error) {
      if (error?.code !== "ESRCH") errors.push(error)
    }
    try {
      await waitForProcessGroupExit(pid, 500)
    } catch {
      try {
        process.kill(-pid, "SIGKILL")
      } catch (error) {
        if (error?.code !== "ESRCH") errors.push(error)
      }
    }
  }

  try {
    await waitForPromise(
      closePromise,
      PROCESS_TREE_SETTLE_TIMEOUT_MS,
      `Process ${pid} did not close after tree termination`,
    )
  } catch (error) {
    errors.push(error)
  }
  if (process.platform !== "win32") {
    try {
      await waitForProcessGroupExit(pid, PROCESS_TREE_SETTLE_TIMEOUT_MS)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to terminate process tree ${pid}`)
  }
}

function beginCliProcessShutdown() {
  acceptingCliProcesses = false
}

function resumeCliProcessAdmissions() {
  if (activeCliProcesses.size > 0) {
    throw new Error("Cannot resume CLI admissions while processes are active")
  }
  acceptingCliProcesses = true
  cliShutdownPromise = null
}

function activeCliProcessCount() {
  return activeCliProcesses.size
}

function assertCliProcessCapacity() {
  pruneClosedCliProcesses()
  if (activeCliProcesses.size < MAX_ACTIVE_CLI_PROCESSES) return
  throw Object.assign(
    new Error(
      `CLI process capacity exhausted (${MAX_ACTIVE_CLI_PROCESSES} active)`,
    ),
    {
      code: "CLI_PROCESS_CAPACITY",
      statusCode: 503,
      retryAfterMs: 1_000,
    },
  )
}

function terminateTrackedCliProcess(record) {
  if (!record.terminationPromise) {
    const attempt = terminateProcessTree(
      record.child,
      record.closePromise,
    )
    const tracked = attempt.catch((error) => {
      if (record.terminationPromise === tracked) {
        record.terminationPromise = null
      }
      throw error
    })
    record.terminationPromise = tracked
  }
  return record.terminationPromise
}

function pruneClosedCliProcesses() {
  for (const [child, record] of activeCliProcesses) {
    const rootClosed =
      record.closed ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !child.pid
    const descendantsRemain =
      process.platform !== "win32" &&
      child.pid &&
      processGroupExists(child.pid)
    if (rootClosed && !descendantsRemain) {
      activeCliProcesses.delete(child)
    }
  }
}

function shutdownAllCliProcesses(timeoutMs = CLI_SHUTDOWN_TIMEOUT_MS) {
  beginCliProcessShutdown()
  if (cliShutdownPromise) return cliShutdownPromise

  const attempt = (async () => {
    pruneClosedCliProcesses()
    const records = [...activeCliProcesses.values()]
    const results = await waitForPromise(
      Promise.allSettled(records.map(terminateTrackedCliProcess)),
      Math.max(1, timeoutMs),
      `CLI process shutdown exceeded ${timeoutMs}ms`,
    )
    pruneClosedCliProcesses()
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason)
    if (activeCliProcesses.size > 0) {
      failures.push(
        new Error(
          `${activeCliProcesses.size} CLI process(es) remained active after shutdown`,
        ),
      )
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "CLI process shutdown was incomplete")
    }
  })()
  const tracked = attempt.catch((error) => {
    if (cliShutdownPromise === tracked) cliShutdownPromise = null
    throw error
  })
  cliShutdownPromise = tracked
  return tracked
}

/**
 * Run a CLI to completion.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runCli(binaryPath, args, options = {}) {
  const {
    cwd = os.homedir(),
    timeoutMs = 15_000,
    env,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = options
  if (!acceptingCliProcesses) {
    return Promise.reject(new Error("CLI process manager is shutting down"))
  }
  try {
    assertCliProcessCapacity()
  } catch (error) {
    return Promise.reject(error)
  }
  if (typeof binaryPath !== "string" || binaryPath.length === 0) {
    return Promise.reject(new Error("CLI binary path is required"))
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return Promise.reject(new Error("CLI arguments must be strings"))
  }

  const isWindows = process.platform === "win32"
  const directExe =
    isWindows && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath)
  const viaCmd = isWindows && !directExe
  const spawnCommand = viaCmd
    ? process.env.ComSpec && process.env.ComSpec.length > 0
      ? process.env.ComSpec
      : "cmd.exe"
    : binaryPath
  // Mirror Node's own `shell: true` contract: the whole command line is a
  // single outer-quoted `/c` argument passed VERBATIM. Without verbatim,
  // Node re-escapes the inner quotes around paths containing spaces
  // (C:\Program Files\...) as \" — which cmd.exe does not understand.
  const spawnArgs = viaCmd ? buildWindowsCmdArgs(binaryPath, args) : args

  return (async () => {
    if (!acceptingCliProcesses) {
      throw new Error("CLI process manager is shutting down")
    }
    assertCliProcessCapacity()
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: sanitizedCliEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: viaCmd,
      detached: process.platform !== "win32",
    })
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    const cap = Math.max(1024, Math.min(16 * 1024 * 1024, maxOutputBytes))
    const append = (chunks, chunk, currentBytes) => {
      if (currentBytes >= cap) return currentBytes
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = cap - currentBytes
      const accepted =
        bytes.length <= remaining ? bytes : bytes.subarray(0, remaining)
      chunks.push(accepted)
      return currentBytes + accepted.length
    }
    child.stdout?.on("data", (chunk) => {
      const incoming = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stdoutBytes + incoming > cap) stdoutTruncated = true
      stdoutBytes = append(stdoutChunks, chunk, stdoutBytes)
    })
    child.stderr?.on("data", (chunk) => {
      const incoming = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stderrBytes + incoming > cap) stderrTruncated = true
      stderrBytes = append(stderrChunks, chunk, stderrBytes)
    })

    const closePromise = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    const record = {
      child,
      closePromise,
      terminationPromise: null,
      closed: false,
    }
    closePromise.then(
      () => {
        record.closed = true
      },
      () => {
        record.closed = true
      },
    )
    activeCliProcesses.set(child, record)
    const timeoutToken = Symbol("timeout")
    let timer
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutToken), Math.max(1, timeoutMs))
      timer.unref?.()
    })

    let outcome
    let timedOut = false
    let processTreeVerified = process.platform !== "win32"
    try {
      outcome = await Promise.race([closePromise, timeoutPromise])
      if (outcome === timeoutToken) {
        timedOut = true
        await terminateTrackedCliProcess(record)
        processTreeVerified = true
        outcome = await closePromise
      } else if (process.platform !== "win32" && child.pid) {
        // A naturally exited group must not retain descendants.
        if (processGroupExists(child.pid)) {
          await terminateTrackedCliProcess(record)
        }
        processTreeVerified = !processGroupExists(child.pid)
      }
    } finally {
      if (timer) clearTimeout(timer)
      const rootClosed =
        record.closed ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        !child.pid
      const descendantsRemain =
        process.platform !== "win32" &&
        child.pid &&
        processGroupExists(child.pid)
      if (rootClosed && !descendantsRemain) {
        activeCliProcesses.delete(child)
      }
    }

    return {
      code: outcome.code,
      signal: outcome.signal,
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf-8"),
      stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf-8"),
      timedOut,
      processTreeVerified,
      stdoutTruncated,
      stderrTruncated,
    }
  })()
}

module.exports = {
  runCli,
  resolveCliBinary,
  buildWindowsCmdArgs,
  quoteWindowsCmdArg,
  quoteWindowsCmdPath,
  sanitizedCliEnvironment,
  terminateProcessTree,
  beginCliProcessShutdown,
  resumeCliProcessAdmissions,
  shutdownAllCliProcesses,
  activeCliProcessCount,
}
