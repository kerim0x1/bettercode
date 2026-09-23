import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { logger } from "../observability/logger"
import { sanitizedShellEnvironment } from "../security/childEnvironment"
import { resolveComSpec } from "../security/windowsCommandLine"
import { isNoSuchProcessError, runWindowsTaskkill } from "./process-termination"

const DEFAULT_TIMEOUT_MS = 120_000 // 2 min — old limit was 30s and broke `npm install`.
const MAX_TIMEOUT_MS = 600_000 // 10 min hard cap — anything longer should use a real job runner.
const BetterC0de_BASH_DEFAULT_TIMEOUT_ENV =
  "BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"

/** Key allow-list mirroring rust-backend/src/security is_safe_env_key to stop
 *  a malicious caller from injecting DYLD_INSERT_LIBRARIES, PATH, etc.
 *
 *  M7: extended denylist now also blocks Java/SSH/shell-startup injection
 *  vectors that the original list missed:
 *    - JAVA_TOOL_OPTIONS / _JAVA_OPTIONS — Java agent injection
 *    - GIT_SSH_COMMAND / GIT_SSH — replace SSH with arbitrary binary
 *    - BASH_ENV / ENV — shell startup-file injection
 *    - EDITOR / VISUAL / PAGER — interactive tool hijack
 */
function isSafeEnvKey(key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false
  const denied = new Set([
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "RUBYLIB",
    "PERL5LIB",
    "HOME",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "EDITOR",
    "VISUAL",
    "PAGER",
  ])
  return !denied.has(key.toUpperCase())
}

function resolveCwd(cwd: string): string {
  if (!cwd || cwd.trim().length === 0) return process.cwd()
  return path.resolve(cwd)
}

export function resolveGitBashPath(
  input: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform | string
    readonly exists?: (candidate: string) => boolean
  } = {}
): string | null {
  const platform = input.platform ?? process.platform
  if (platform !== "win32") return null
  const env = input.env ?? process.env
  const exists = input.exists ?? fs.existsSync
  const envOverride = env.BetterC0de_GIT_BASH_PATH || env.BETTERC0DE_GIT_BASH
  if (envOverride && exists(envOverride)) return envOverride
  // Standard Git for Windows installer locations, plus per-user installs
  // (the official installer now defaults to a user-scoped install under
  // %LOCALAPPDATA% on modern Windows) and `GIT_INSTALL_ROOT` if the user
  // configured a custom location. `process.env.ProgramW6432` falls back to
  // the canonical 64-bit Program Files path even on localized Windows
  // installs where the directory name is translated.
  const home = env.USERPROFILE || os.homedir()
  const programFiles64 = env.ProgramW6432 || "C:\\Program Files"
  const programFiles86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const installRoot = env.GIT_INSTALL_ROOT
  const candidates = [
    installRoot ? path.join(installRoot, "bin", "bash.exe") : null,
    path.join(programFiles64, "Git", "bin", "bash.exe"),
    path.join(programFiles86, "Git", "bin", "bash.exe"),
    path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ].filter((p): p is string => Boolean(p))
  for (const c of candidates) if (exists(c)) return c
  return null
}

function findGitBash(): string | null {
  return resolveGitBashPath()
}

export function resolveDefaultShellTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[BetterC0de_BASH_DEFAULT_TIMEOUT_ENV]?.trim()
  if (!raw) return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export interface RunShellInput {
  command: string
  cwd: string
  shell?: string
  env?: Record<string, string>
  /** Override the default timeout (2 min). Clamped to MAX_TIMEOUT_MS. */
  timeoutMs?: number
  /** Caller-supplied id so `abort(sessionId)` can cancel this run mid-flight.
   *  Generated and returned if omitted. */
  sessionId?: string
  /** Abort signal forwarded by a turn/tool owner. Aborting terminates the
   * complete registered process tree before this call settles. */
  signal?: AbortSignal
  /** Authenticated caller identity used for per-principal admission/ownership. */
  ownerId?: string
  /** Absolute epoch deadline for a revocable remote owner. */
  ownerExpiresAt?: number
  /** Revalidates a revocable owner across the spawn-registration boundary. */
  isOwnerActive?: () => boolean
  /** Optional server-owned file used to retain output beyond the in-memory
   * capture limit. The path must never come directly from a client. */
  archivePath?: string
  /** Hard disk-spool cap. Defaults to 16 MiB. */
  maxArchiveBytes?: number
}

export interface RunShellOutput {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  combined: string
  sessionId: string
  aborted: boolean
  timedOut: boolean
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  combinedTruncated?: boolean
  archivePath?: string
  archiveTruncated?: boolean
}

export const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024
// With 16 admitted shell sessions this caps concurrent spool data at 256 MiB.
export const MAX_ARCHIVED_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_ACTIVE_SHELL_SESSIONS = 16
export const MAX_ACTIVE_SHELL_SESSIONS_PER_OWNER = 4

/**
 * Append `chunk` to `current` without exceeding `maxBytes` of UTF-8.
 *
 * Pass `currentBytes` (the `bytes` from the previous call) on hot paths: a
 * command that streams a megabyte in 4 KiB chunks would otherwise re-measure
 * the whole buffer 256 times, which is quadratic in the output size.
 */
export function appendBoundedOutput(
  current: string,
  chunk: Buffer | string,
  maxBytes = MAX_CAPTURED_OUTPUT_BYTES,
  currentBytes?: number
): { text: string; truncated: boolean; bytes: number } {
  const used = currentBytes ?? Buffer.byteLength(current, "utf8")
  if (used >= maxBytes) return { text: current, truncated: true, bytes: used }
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
  const remaining = maxBytes - used
  if (input.byteLength <= remaining) {
    return {
      text: current + input.toString("utf8"),
      truncated: false,
      bytes: used + input.byteLength,
    }
  }
  let suffix = input.subarray(0, remaining).toString("utf8")
  let suffixBytes = Buffer.byteLength(suffix, "utf8")
  // Cutting inside a multi-byte sequence yields a replacement character that
  // can be wider than the bytes it replaced; trim until the suffix fits.
  while (suffix.length > 0 && used + suffixBytes > maxBytes) {
    suffix = suffix.slice(0, -1)
    suffixBytes = Buffer.byteLength(suffix, "utf8")
  }
  return {
    text: current + suffix,
    truncated: true,
    bytes: used + suffixBytes,
  }
}

export interface ShellCommandLaunch {
  shell: string
  binary: string
  args: string[]
  /**
   * Set when `args` already form a finished Windows command line that must
   * not be re-quoted by Node. See the cmd.exe branch of
   * {@link resolveShellCommandLaunch}.
   */
  windowsVerbatimArguments?: boolean
}

/**
 * Active shell sessions, keyed by `sessionId`. `abort(sessionId)` kills the
 * matching child process and the promise from `runShellCommand` resolves with
 * `aborted: true`. Sessions are dropped from the map once they settle.
 */
const activeSessions = new Map<string, ChildProcess>()
const activeSessionOwners = new Map<string, string>()
const activeSessionSettlements = new Map<string, Promise<void>>()
const activeSessionCwds = new Map<string, string>()
interface ShellTreeTerminationState {
  readonly pending: Set<Promise<void>>
  readonly errors: Error[]
}
const shellTreeTerminations = new WeakMap<
  ChildProcess,
  ShellTreeTerminationState
>()
let shellAdmissionsOpen = true

export function resumeShellAdmissions(): void {
  shellAdmissionsOpen = true
}

export function beginShellShutdown(): void {
  shellAdmissionsOpen = false
}

export function activeShellSessionCount(): number {
  return activeSessions.size
}

export function activeShellSessionCountForOwner(ownerId: string): number {
  let count = 0
  for (const sessionOwner of activeSessionOwners.values()) {
    if (sessionOwner === ownerId) count += 1
  }
  return count
}

/** Begin terminating the process tree owning `sessionId`.
 *
 * Windows termination runs `taskkill /T` asynchronously; command settlement
 * and service shutdown retain and await that helper before releasing state.
 * The boolean only reports whether an owned session was found.
 */
export function abortShellSession(
  sessionId: string,
  ownerId?: string
): boolean {
  const child = activeSessions.get(sessionId)
  if (!child) return false
  if (ownerId !== undefined && activeSessionOwners.get(sessionId) !== ownerId) {
    return false
  }
  requestShellProcessTreeTermination(child, "SIGTERM")
  // L5: escalate to SIGKILL if the child didn't exit within 10s (was 3s).
  // 3s often killed Node subprocesses mid-cleanup, orphaning grandchildren
  // (build tools, dev servers spawned by the LLM tool calls). 10s is a
  // pragmatic compromise for the typical foreground-process tear-down.
  setTimeout(() => {
    const still = activeSessions.get(sessionId)
    if (still === child) {
      requestShellProcessTreeTermination(still, "SIGKILL")
    }
  }, 10_000).unref?.()
  return true
}

/** Test-only reset. Production shutdown goes through `closeAllShellSessions`. */
export function __abortAllShellSessionsForTests(): number {
  const sessionIds = [...activeSessions.keys()]
  for (const sessionId of sessionIds) abortShellSession(sessionId)
  return sessionIds.length
}

export async function closeAllShellSessions(graceMs = 2_000): Promise<number> {
  const entries = [...activeSessions.entries()]
  return closeShellSessionEntries(entries, graceMs)
}

export async function closeShellSessionsForWorkspace(
  workspace: string,
  graceMs = 2_000
): Promise<number> {
  const entries = [...activeSessions.entries()].filter(([sessionId]) => {
    const cwd = activeSessionCwds.get(sessionId)
    return cwd ? isSameOrDescendantPath(workspace, cwd) : false
  })
  return closeShellSessionEntries(entries, graceMs)
}

export async function closeShellSessionsForOwner(
  ownerId: string,
  graceMs = 2_000
): Promise<number> {
  const entries = [...activeSessions.entries()].filter(
    ([sessionId]) => activeSessionOwners.get(sessionId) === ownerId
  )
  return closeShellSessionEntries(entries, graceMs)
}

async function closeShellSessionEntries(
  entries: Array<[string, ChildProcess]>,
  graceMs: number
): Promise<number> {
  if (entries.length === 0) return 0
  const terminationErrors: Error[] = []
  const settlements = entries
    .map(([sessionId]) => activeSessionSettlements.get(sessionId))
    .filter((value): value is Promise<void> => value !== undefined)

  collectTerminationErrors(
    await Promise.allSettled(
      entries.map(([, child]) =>
        requestShellProcessTreeTermination(child, "SIGTERM")
      )
    ),
    terminationErrors
  )
  await waitForShellChildren(entries, graceMs)

  const remaining = entries.filter(([sessionId, child]) =>
    isShellProcessTreeRetained(sessionId, child)
  )
  collectTerminationErrors(
    await Promise.allSettled(
      remaining.map(([, child]) =>
        requestShellProcessTreeTermination(child, "SIGKILL")
      )
    ),
    terminationErrors
  )
  if (remaining.length > 0) {
    await waitForShellChildren(remaining, 500)
  }
  if (settlements.length > 0) {
    await Promise.race([
      Promise.allSettled(settlements).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_500)),
    ])
  }
  for (const [, child] of entries) {
    terminationErrors.push(...shellTerminationState(child).errors)
  }
  const uniqueTerminationErrors = [...new Set(terminationErrors)]
  const survivors = entries.filter(([sessionId, child]) =>
    isShellProcessTreeRetained(sessionId, child)
  )
  if (survivors.length > 0 || uniqueTerminationErrors.length > 0) {
    throw Object.assign(
      new Error(
        survivors.length > 0
          ? `${survivors.length} shell session(s) did not settle during shutdown.`
          : `${uniqueTerminationErrors.length} shell process-tree termination operation(s) failed during shutdown.`
      ),
      {
        code: "SHELL_SHUTDOWN_INCOMPLETE",
        sessionIds: survivors.map(([sessionId]) => sessionId),
        causes: uniqueTerminationErrors,
      }
    )
  }
  return entries.length
}

async function waitForShellChildren(
  entries: readonly (readonly [string, ChildProcess])[],
  timeoutMs: number
): Promise<void> {
  const closed = Promise.all(
    entries.map(
      ([sessionId, child]) =>
        new Promise<void>((resolve) => {
          if (
            activeSessions.get(sessionId) !== child ||
            child.exitCode !== null
          ) {
            resolve()
            return
          }
          child.once("close", () => resolve())
        })
    )
  ).then(() => undefined)
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/**
 * Runs a shell command with abort + timeout support.
 *   - `timeoutMs` defaults to 2 min (was 30s), clamped at 10 min.
 *   - `sessionId` is returned to the caller so a later `abortShellSession(id)`
 *     can kill the child mid-execution.
 *   - Resolves with `{aborted, timedOut}` flags instead of throwing, so the
 *     renderer can distinguish user-cancel from genuine failure.
 */
export async function runShellCommand(
  input: RunShellInput
): Promise<RunShellOutput> {
  if (!shellAdmissionsOpen) {
    throw Object.assign(new Error("Shell service is shutting down."), {
      statusCode: 503,
    })
  }
  if (!isShellOwnerActive(input)) {
    throw Object.assign(new Error("Shell session owner is no longer active."), {
      statusCode: 403,
      code: "SHELL_OWNER_INACTIVE",
    })
  }
  if (!input.command || !input.command.trim()) {
    throw new Error("Command is empty")
  }
  const sessionId = input.sessionId ?? randomUUID()
  if (input.signal?.aborted) {
    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      combined: "",
      sessionId,
      aborted: true,
      timedOut: false,
    }
  }
  const cwd = resolveCwd(input.cwd)
  const shellId = input.shell ?? (process.platform === "win32" ? "cmd" : "bash")
  if (activeSessions.has(sessionId)) {
    throw Object.assign(
      new Error(`Shell session already exists: ${sessionId}`),
      { statusCode: 409 }
    )
  }
  if (activeSessions.size >= MAX_ACTIVE_SHELL_SESSIONS) {
    throw Object.assign(
      new Error(
        `Too many active shell sessions (${MAX_ACTIVE_SHELL_SESSIONS} maximum).`
      ),
      { statusCode: 429 }
    )
  }
  if (
    input.ownerId &&
    activeShellSessionCountForOwner(input.ownerId) >=
      MAX_ACTIVE_SHELL_SESSIONS_PER_OWNER
  ) {
    throw Object.assign(
      new Error(
        `Too many active shell sessions for this caller (${MAX_ACTIVE_SHELL_SESSIONS_PER_OWNER} maximum).`
      ),
      { statusCode: 429 }
    )
  }
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? resolveDefaultShellTimeoutMs(), 1_000),
    MAX_TIMEOUT_MS
  )

  const requestedEnv: NodeJS.ProcessEnv = {}
  if (input.env) {
    for (const [k, v] of Object.entries(input.env)) {
      if (isSafeEnvKey(k)) requestedEnv[k] = v
    }
  }
  const safeEnv = sanitizedShellEnvironment(requestedEnv)

  const launch = resolveShellCommandLaunch(shellId, input.command)

  return await new Promise<RunShellOutput>((resolve, reject) => {
    let settled = false
    let markRunSettled!: () => void
    const runSettled = new Promise<void>((done) => {
      markRunSettled = done
    })
    const child = spawn(launch.binary, launch.args, {
      cwd,
      env: safeEnv,
      // stdin is never fed, so hand the child a closed one. With a pipe that
      // nobody writes to, `cat`, `git commit` without -m, or an interactive
      // installer blocks on read until the 2-minute timeout kills it.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
      // POSIX: own process group so the whole tree can be signalled. Windows
      // has no equivalent without a Job Object; see terminateShellProcessTree.
      detached: process.platform !== "win32",
    })
    activeSessions.set(sessionId, child)
    activeSessionSettlements.set(sessionId, runSettled)
    activeSessionCwds.set(sessionId, cwd)
    if (input.ownerId) activeSessionOwners.set(sessionId, input.ownerId)

    const maxArchiveBytes = Math.min(
      Math.max(input.maxArchiveBytes ?? MAX_ARCHIVED_OUTPUT_BYTES, 0),
      MAX_ARCHIVED_OUTPUT_BYTES
    )
    const archiveStream =
      input.archivePath && maxArchiveBytes > 0
        ? fs.createWriteStream(input.archivePath, {
            // O_EXCL refuses an existing regular file or symlink. The path is
            // allocated by ToolOutputArchiveStore, never by the request.
            flags: "wx",
            mode: 0o600,
          })
        : null
    let archiveBytes = 0
    let archiveCreated = false
    let archiveTruncated = false
    let archiveFailed = false
    let archiveBackpressured = false
    archiveStream?.once("open", () => {
      archiveCreated = true
    })
    const resumeOutput = () => {
      if (!archiveBackpressured) return
      archiveBackpressured = false
      child.stdout?.resume()
      child.stderr?.resume()
    }
    archiveStream?.once("error", () => {
      archiveFailed = true
      resumeOutput()
    })
    archiveStream?.on("drain", resumeOutput)

    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let signalAborted = false
    let ownerInvalidated = false
    let ownerExpiryTimer: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    const onSignalAbort = () => {
      if (signalAborted || activeSessions.get(sessionId) !== child) return
      signalAborted = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      abortShellSession(sessionId, input.ownerId)
    }

    const appendArchive = (chunk: Buffer | string) => {
      if (!archiveStream || archiveFailed) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
      const remaining = maxArchiveBytes - archiveBytes
      if (remaining <= 0) {
        archiveTruncated = true
        return
      }
      const retained =
        bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining)
      archiveBytes += retained.byteLength
      if (!archiveStream.write(retained) && !archiveBackpressured) {
        archiveBackpressured = true
        child.stdout?.pause()
        child.stderr?.pause()
      }
      if (retained.byteLength < bytes.byteLength) archiveTruncated = true
    }

    const closeArchive = async () => {
      if (!archiveStream || archiveStream.closed) return
      await new Promise<void>((finish) => {
        let settled = false
        let forcedCloseTimer: NodeJS.Timeout | undefined
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(flushTimer)
          if (forcedCloseTimer) clearTimeout(forcedCloseTimer)
          finish()
        }
        const flushTimer = setTimeout(() => {
          archiveFailed = true
          archiveStream.destroy()
          // `close` normally follows destroy immediately. Keep a bounded
          // fallback so a broken filesystem stream cannot hang shell cleanup.
          forcedCloseTimer = setTimeout(done, 1_000)
        }, 5_000)
        archiveStream.once("close", done)
        if (!archiveStream.destroyed) archiveStream.end()
      })
    }

    const discardPartialArchive = async () => {
      if (!input.archivePath || !archiveCreated) return
      try {
        await fs.promises.unlink(input.archivePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // The route-owned archive store retries cleanup when the command
          // fails. Do not replace the original shell failure with an unlink
          // failure here.
        }
      }
    }

    const releaseSession = () => {
      input.signal?.removeEventListener("abort", onSignalAbort)
      if (ownerExpiryTimer) {
        clearTimeout(ownerExpiryTimer)
        ownerExpiryTimer = undefined
      }
      if (activeSessions.get(sessionId) === child) {
        activeSessions.delete(sessionId)
        activeSessionOwners.delete(sessionId)
        activeSessionSettlements.delete(sessionId)
        activeSessionCwds.delete(sessionId)
      }
      markRunSettled()
    }

    const invalidateOwner = () => {
      if (ownerInvalidated || activeSessions.get(sessionId) !== child) return
      ownerInvalidated = true
      abortShellSession(sessionId, input.ownerId)
    }
    const scheduleOwnerExpiry = () => {
      if (input.ownerExpiresAt === undefined) return
      const remaining = input.ownerExpiresAt - Date.now()
      if (remaining <= 0) {
        invalidateOwner()
        return
      }
      ownerExpiryTimer = setTimeout(
        scheduleOwnerExpiry,
        Math.min(remaining, 2_147_000_000)
      )
      ownerExpiryTimer.unref?.()
    }
    scheduleOwnerExpiry()
    if (!isShellOwnerActive(input)) invalidateOwner()

    child.stdout?.on("data", (d) => {
      appendArchive(d)
      const captured = appendBoundedOutput(
        stdout,
        d,
        MAX_CAPTURED_OUTPUT_BYTES,
        stdoutBytes
      )
      stdout = captured.text
      stdoutBytes = captured.bytes
      stdoutTruncated ||= captured.truncated
    })
    child.stderr?.on("data", (d) => {
      appendArchive(d)
      const captured = appendBoundedOutput(
        stderr,
        d,
        MAX_CAPTURED_OUTPUT_BYTES,
        stderrBytes
      )
      stderr = captured.text
      stderrBytes = captured.bytes
      stderrTruncated ||= captured.truncated
    })

    timer = setTimeout(() => {
      timedOut = true
      requestShellProcessTreeTermination(child, "SIGTERM")
      setTimeout(() => {
        if (activeSessions.get(sessionId) === child) {
          requestShellProcessTreeTermination(child, "SIGKILL")
        }
      }, 3_000).unref?.()
    }, timeoutMs)

    child.once("exit", () => {
      if (process.platform !== "win32" && child.pid != null) {
        requestShellProcessGroupFinalization(child)
      }
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      void (async () => {
        if (child.pid != null) {
          await requestShellProcessTreeTermination(child, "SIGKILL").catch(
            () => undefined
          )
        }
        const treeErrors = await settleShellProcessTreeAfterRootExit(child)
        await closeArchive()
        await discardPartialArchive()
        releaseSession()
        if (treeErrors.length === 0) {
          reject(err)
          return
        }
        reject(
          Object.assign(
            new Error(
              `${err.message}; shell process-tree cleanup also failed: ${treeErrors
                .map((error) => error.message)
                .join("; ")}`
            ),
            {
              code: "SHELL_PROCESS_TREE_INCOMPLETE",
              sessionId,
              cause: err,
              causes: treeErrors,
            }
          )
        )
      })()
    })
    child.on("close", async (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const treeErrors = await settleShellProcessTreeAfterRootExit(child)
      const trimmedStderr = stderr.trim()
      const trimmedStdout = stdout.trim()
      const combined = !trimmedStderr
        ? stdout
        : !trimmedStdout
          ? stderr
          : `${stdout}\n${stderr}`
      const aborted =
        !timedOut &&
        (signalAborted ||
          ownerInvalidated ||
          signal === "SIGTERM" ||
          signal === "SIGKILL")
      await closeArchive()
      if (archiveFailed) await discardPartialArchive()
      releaseSession()
      if (treeErrors.length > 0) {
        reject(
          Object.assign(
            new Error(
              `Shell process tree did not settle cleanly: ${treeErrors
                .map((error) => error.message)
                .join("; ")}`
            ),
            {
              code: "SHELL_PROCESS_TREE_INCOMPLETE",
              sessionId,
              causes: treeErrors,
            }
          )
        )
        return
      }
      resolve({
        success: code === 0 && !aborted && !timedOut,
        stdout,
        stderr,
        exitCode: code,
        combined: combined.replace(/\s+$/, ""),
        sessionId,
        aborted,
        timedOut,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(stderrTruncated ? { stderrTruncated: true } : {}),
        ...(stdoutTruncated || stderrTruncated
          ? { combinedTruncated: true }
          : {}),
        ...(!archiveFailed && input.archivePath
          ? { archivePath: input.archivePath }
          : {}),
        ...(archiveTruncated ? { archiveTruncated: true } : {}),
      })
    })
    input.signal?.addEventListener("abort", onSignalAbort, { once: true })
    if (input.signal?.aborted) onSignalAbort()
  })
}

function isShellOwnerActive(input: RunShellInput): boolean {
  if (
    input.ownerExpiresAt !== undefined &&
    (!Number.isFinite(input.ownerExpiresAt) ||
      input.ownerExpiresAt <= Date.now())
  ) {
    return false
  }
  if (!input.isOwnerActive) return true
  try {
    return input.isOwnerActive() === true
  } catch {
    return false
  }
}

function isSameOrDescendantPath(root: string, candidate: string): boolean {
  const comparableRoot = comparablePath(root)
  const comparableCandidate = comparablePath(candidate)
  const relative = path.relative(comparableRoot, comparableCandidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

function comparablePath(value: string): string {
  let resolved = path.resolve(value)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
    // The operation may target a path that disappeared during teardown.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function shellTerminationState(child: ChildProcess): ShellTreeTerminationState {
  let state = shellTreeTerminations.get(child)
  if (!state) {
    state = { pending: new Set(), errors: [] }
    shellTreeTerminations.set(child, state)
  }
  return state
}

function requestShellProcessTreeTermination(
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> {
  const state = shellTerminationState(child)
  const operation =
    state.pending.size === 0
      ? terminateShellProcessTree(child, signal)
      : Promise.allSettled([...state.pending]).then(() =>
          terminateShellProcessTree(child, signal)
        )
  state.pending.add(operation)
  void operation
    .catch((error) => {
      state.errors.push(asError(error))
    })
    .finally(() => {
      state.pending.delete(operation)
    })
  return operation
}

function requestShellProcessGroupFinalization(
  child: ChildProcess
): Promise<void> {
  const state = shellTerminationState(child)
  if (child.pid == null || process.platform === "win32") {
    return Promise.resolve()
  }
  const operation =
    state.pending.size === 0
      ? ensurePosixProcessGroupTerminated(child.pid)
      : Promise.allSettled([...state.pending]).then(() =>
          ensurePosixProcessGroupTerminated(child.pid!)
        )
  state.pending.add(operation)
  void operation
    .catch((error) => {
      state.errors.push(asError(error))
    })
    .finally(() => {
      state.pending.delete(operation)
    })
  return operation
}

async function settleShellProcessTreeAfterRootExit(
  child: ChildProcess
): Promise<Error[]> {
  const state = shellTerminationState(child)
  await Promise.allSettled([...state.pending])
  if (process.platform !== "win32" && child.pid != null) {
    try {
      await ensurePosixProcessGroupTerminated(child.pid)
    } catch (error) {
      state.errors.push(asError(error))
    }
  }
  return [...state.errors]
}

async function terminateShellProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> {
  if (child.pid == null) {
    if (child.exitCode === null) child.kill(signal)
    return
  }
  if (process.platform === "win32") {
    // Once the root has exited Windows no longer gives us a stable tree
    // identity. Reusing its PID in a later taskkill could terminate an
    // unrelated process; only helpers started while the root is live are safe.
    //
    // Known limit: a root that exits on its own (for example `cmd /c` after
    // handing off to `npm run dev`) leaves its descendants running, and they
    // cannot be reached from here. Fixing that needs a Job Object, which is
    // native code this backend does not ship. Say so instead of pretending.
    if (child.exitCode !== null) {
      logger.warn(
        { pid: child.pid, signal },
        "shell root process already exited before tree termination; descendants may be orphaned on Windows"
      )
      return
    }
    try {
      await runWindowsTaskkill(child.pid, signal === "SIGKILL")
      return
    } catch (error) {
      if (child.exitCode === null) {
        try {
          child.kill(signal)
        } catch {
          // Preserve the taskkill failure, which contains the actionable cause.
        }
      }
      throw error
    }
  }

  const signalled = signalPosixProcessGroup(child.pid, signal)
  if (!signalled && child.exitCode === null) {
    child.kill(signal)
  }
  if (signal === "SIGKILL") {
    const exited = await waitForPosixProcessGroupExit(child.pid, 500)
    if (!exited) {
      throw Object.assign(
        new Error(`POSIX process group ${child.pid} survived SIGKILL.`),
        {
          code: "PROCESS_GROUP_SURVIVED_SIGKILL",
          pid: child.pid,
        }
      )
    }
  }
}

export async function ensurePosixProcessGroupTerminated(
  pid: number
): Promise<void> {
  if (!isPosixProcessGroupAlive(pid)) return
  signalPosixProcessGroup(pid, "SIGTERM")
  if (await waitForPosixProcessGroupExit(pid, 250)) return
  signalPosixProcessGroup(pid, "SIGKILL")
  if (await waitForPosixProcessGroupExit(pid, 500)) return
  throw Object.assign(
    new Error(`POSIX process group ${pid} survived root-process exit.`),
    {
      code: "PROCESS_GROUP_SURVIVED_ROOT_EXIT",
      pid,
    }
  )
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    throw error
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    throw error
  }
}

async function waitForPosixProcessGroupExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    if (!isPosixProcessGroupAlive(pid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return !isPosixProcessGroupAlive(pid)
}

function isShellProcessTreeRetained(
  sessionId: string,
  child: ChildProcess
): boolean {
  if (activeSessions.get(sessionId) === child) return true
  if (process.platform === "win32" || child.pid == null) return false
  try {
    return isPosixProcessGroupAlive(child.pid)
  } catch {
    return true
  }
}

function collectTerminationErrors(
  results: readonly PromiseSettledResult<void>[],
  target: Error[]
): void {
  for (const result of results) {
    if (result.status === "rejected") target.push(asError(result.reason))
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function resolveShellCommandLaunch(
  shellId: string,
  command: string
): ShellCommandLaunch {
  if (process.platform !== "win32" && path.isAbsolute(shellId)) {
    return {
      shell: path.basename(shellId),
      binary: shellId,
      args: ["-c", command],
    }
  }

  const normalized = normalizeShellId(shellId)
  switch (normalized) {
    case "powershell":
      return {
        shell: "powershell",
        binary: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
      }
    case "pwsh":
      return {
        shell: "pwsh",
        binary: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
      }
    case "gitbash": {
      const bash = findGitBash()
      if (!bash)
        throw new Error(
          "Git Bash not found. Install Git for Windows or set BETTERC0DE_GIT_BASH."
        )
      return { shell: "gitbash", binary: bash, args: ["-c", command] }
    }
    case "wsl":
      return {
        shell: "wsl",
        binary: "wsl",
        args: ["--", "bash", "-c", command],
      }
    case "bash":
      return { shell: "bash", binary: "bash", args: ["-c", command] }
    case "zsh":
      return { shell: "zsh", binary: "zsh", args: ["-c", command] }
    case "sh":
      return { shell: "sh", binary: "sh", args: ["-c", command] }
    default:
      if (process.platform === "win32") {
        // `cmd /c <command>` through Node's default quoting corrupts any
        // embedded double quote: Node re-escapes it as `\"`, which cmd does
        // not understand, so `git commit -m "fix: thing"` reached the child
        // as `-m`, `"fix:`, `thing"`. Pass the line verbatim with `/s` so cmd
        // strips exactly our outer quotes and parses the rest as typed. See
        // ../security/windowsCommandLine.ts for the full pattern.
        return {
          shell: "cmd",
          binary: resolveComSpec(),
          args: ["/d", "/s", "/c", `"${command}"`],
          windowsVerbatimArguments: true,
        }
      }
      return { shell: "sh", binary: "sh", args: ["-c", command] }
  }
}

function normalizeShellId(shellId: string): string {
  const trimmed = shellId.trim()
  const base = path
    .basename(trimmed)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  if (base === "bash") return "bash"
  if (base === "zsh") return "zsh"
  if (base === "sh") return "sh"
  if (base === "pwsh") return "pwsh"
  if (base === "powershell") return "powershell"
  if (base === "wsl") return "wsl"
  if (base === "gitbash" || trimmed.toLowerCase() === "git-bash")
    return "gitbash"
  if (base === "cmd") return "cmd"
  return trimmed.toLowerCase()
}

export async function detectShells(): Promise<unknown[]> {
  const available: Record<string, unknown>[] = []
  const isWin = process.platform === "win32"
  if (isWin) {
    available.push({ id: "cmd", name: "Command Prompt", default: true })
    const [hasPowerShell, hasWsl] = await Promise.all([
      probeCommand("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "exit 0",
      ]),
      probeCommand("wsl", ["--status"]),
    ])
    if (hasPowerShell) available.push({ id: "powershell", name: "PowerShell" })
    if (findGitBash()) available.push({ id: "gitbash", name: "Git Bash" })
    if (hasWsl) available.push({ id: "wsl", name: "WSL (Linux)" })
  } else {
    const defaultUnixShell =
      path.basename(process.env.SHELL || "") === "zsh" ? "zsh" : "bash"
    available.push({
      id: "bash",
      name: "Bash",
      default: defaultUnixShell === "bash",
    })
    if (await probeCommand("zsh", ["--version"])) {
      available.push({
        id: "zsh",
        name: "Zsh",
        default: defaultUnixShell === "zsh",
      })
    }
  }
  return available
}

async function probeCommand(
  binary: string,
  args: readonly string[],
  timeoutMs = 2_000
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(binary, [...args], {
      env: sanitizedShellEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // Best effort; the timeout result is still a failed probe.
      }
      finish(false)
    }, timeoutMs)
    timer.unref?.()
    child.once("error", () => finish(false))
    child.once("close", (code) => finish(code === 0))
  })
}
