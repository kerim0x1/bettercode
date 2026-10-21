import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { logger } from "../observability/logger"
import { sanitizedShellEnvironment } from "../security/childEnvironment"
import {
  isAbsoluteExecutablePath,
  resolveExecutableOnPath,
  windowsSystemExecutable,
  windowsSystemRoot,
} from "../security/executablePath"
import { resolveComSpec } from "../security/windowsCommandLine"
import { locateGitExecutable } from "./git/process"
import {
  ensurePosixProcessGroupTerminated,
  isPosixProcessGroupAlive,
  signalPosixProcessGroup,
  taskkillChildProcessTree,
  waitForPosixProcessGroupExit,
} from "./process-termination"
import { trackChildProcessTree } from "./child-process-registry"

export { ensurePosixProcessGroupTerminated }

const DEFAULT_TIMEOUT_MS = 120_000 // 2 min — old limit was 30s and broke `npm install`.
const MAX_TIMEOUT_MS = 600_000 // 10 min hard cap — anything longer should use a real job runner.
const BetterC0de_BASH_DEFAULT_TIMEOUT_ENV =
  "BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"
/**
 * How long a run waits for its output pipes to close after the root process
 * exited. A descendant that inherited the pipes (`start /b`, a daemon that
 * escaped its process group, MSBuild node reuse) would otherwise keep the
 * run open forever.
 */
const POST_EXIT_OUTPUT_GRACE_MS = 5_000
/**
 * How long after the first termination request a run settles even if its
 * root never reported an exit. The session stays registered (and counted by
 * shutdown) until the process really exits; only the caller stops waiting.
 */
const TERMINATION_SETTLE_DEADLINE_MS = 15_000

function resolveCwd(cwd: string): string {
  if (!cwd || cwd.trim().length === 0) return process.cwd()
  return path.resolve(cwd)
}

export function resolveGitBashPath(
  input: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform | string
    readonly exists?: (candidate: string) => boolean
    /** Absolute git executable whose installation may ship bash. */
    readonly gitExecutable?: string | null
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
  // installs where the directory name is translated. The installation that
  // provides the git on PATH comes first: its `bin\bash.exe` sits two levels
  // above `cmd\git.exe` (or `mingw64\bin\git.exe`).
  const home = env.USERPROFILE || os.homedir()
  const programFiles64 = env.ProgramW6432 || "C:\\Program Files"
  const programFiles86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const installRoot = env.GIT_INSTALL_ROOT
  const gitExecutable =
    input.gitExecutable === undefined
      ? input.exists
        ? null
        : locateGitExecutable()
      : input.gitExecutable
  const candidates = [
    installRoot ? path.join(installRoot, "bin", "bash.exe") : null,
    ...gitInstallationBashCandidates(gitExecutable),
    path.join(programFiles64, "Git", "bin", "bash.exe"),
    path.join(programFiles86, "Git", "bin", "bash.exe"),
    path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ].filter((p): p is string => Boolean(p))
  for (const c of candidates) if (exists(c)) return c
  return null
}

function gitInstallationBashCandidates(gitExecutable: string | null): string[] {
  if (!gitExecutable || !isAbsoluteExecutablePath(gitExecutable, "win32")) {
    return []
  }
  const binDirectory = path.win32.dirname(gitExecutable)
  const parent = path.win32.dirname(binDirectory)
  return [
    path.win32.join(parent, "bin", "bash.exe"),
    path.win32.join(path.win32.dirname(parent), "bin", "bash.exe"),
  ]
}

function findGitBash(): string | null {
  return resolveGitBashPath()
}

/**
 * The shell an agent's "Bash" tool should use when the caller has no project
 * shell: Git Bash on Windows when it is installed (the model writes bash),
 * otherwise the platform default. Returns undefined for the default.
 */
export function preferredAgentShell(): string | undefined {
  if (process.platform !== "win32") return undefined
  return findGitBash() ? "gitbash" : undefined
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
  /**
   * The renderer instance that started the run, when it identified itself,
   * so its runs can be ended when that renderer goes away.
   */
  clientInstanceId?: string
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
  /**
   * The root exited but something it started still held the output pipes,
   * so the run stopped waiting for them. On Windows those descendants can no
   * longer be addressed and may still be running.
   */
  detachedDescendants?: boolean
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

interface ShellTreeTerminationState {
  readonly pending: Set<Promise<void>>
  readonly errors: Error[]
}

/**
 * The shell commands of one backend instance: the child processes it
 * started, who owns each one, where it runs and how far its termination got,
 * and whether it admits new commands.
 *
 * Bootstrap creates one (`BootRoot.shellSessions`, `AppState.shellSessions`)
 * and every route, agent tool, hook and lifecycle step that runs or ends a
 * command goes through it, so two backends in one process (the in-process
 * host, tests) no longer share a session table and a test builds its own
 * instead of resetting a module-level one.
 *
 * Sessions are keyed by `sessionId`. `abortSession(sessionId)` kills the
 * matching process tree and the promise from `runCommand` resolves with
 * `aborted: true`. Sessions are dropped once they settle.
 */
export class ShellSessionService {
  private readonly sessions = new Map<string, ChildProcess>()
  private readonly sessionOwners = new Map<string, string>()
  private readonly sessionSettlements = new Map<string, Promise<void>>()
  private readonly sessionCwds = new Map<string, string>()
  private readonly sessionClients = new Map<string, string>()
  private readonly treeTerminations = new WeakMap<
    ChildProcess,
    ShellTreeTerminationState
  >()
  private admissionsOpen = true

  resumeAdmissions(): void {
    this.admissionsOpen = true
  }

  beginShutdown(): void {
    this.admissionsOpen = false
  }

  /** Running commands, all of them or only those `ownerId` started. */
  activeSessionCount(ownerId?: string): number {
    if (ownerId === undefined) return this.sessions.size
    let count = 0
    for (const sessionOwner of this.sessionOwners.values()) {
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
  abortSession(sessionId: string, ownerId?: string): boolean {
    const child = this.sessions.get(sessionId)
    if (!child) return false
    if (
      ownerId !== undefined &&
      this.sessionOwners.get(sessionId) !== ownerId
    ) {
      return false
    }
    this.requestTreeTermination(child, "SIGTERM")
    // L5: escalate to SIGKILL if the child didn't exit within 10s (was 3s).
    // 3s often killed Node subprocesses mid-cleanup, orphaning grandchildren
    // (build tools, dev servers spawned by the LLM tool calls). 10s is a
    // pragmatic compromise for the typical foreground-process tear-down.
    setTimeout(() => {
      const still = this.sessions.get(sessionId)
      if (still === child) {
        this.requestTreeTermination(still, "SIGKILL")
      }
    }, 10_000).unref?.()
    return true
  }

  async closeAllSessions(graceMs = 2_000): Promise<number> {
    const entries = [...this.sessions.entries()]
    return this.closeSessionEntries(entries, graceMs)
  }

  async closeSessionsForWorkspace(
    workspace: string,
    graceMs = 2_000
  ): Promise<number> {
    const entries = [...this.sessions.entries()].filter(([sessionId]) => {
      const cwd = this.sessionCwds.get(sessionId)
      return cwd ? isSameOrDescendantPath(workspace, cwd) : false
    })
    return this.closeSessionEntries(entries, graceMs)
  }

  async closeSessionsForOwner(
    ownerId: string,
    graceMs = 2_000
  ): Promise<number> {
    const entries = [...this.sessions.entries()].filter(
      ([sessionId]) => this.sessionOwners.get(sessionId) === ownerId
    )
    return this.closeSessionEntries(entries, graceMs)
  }

  /** End the runs that one renderer instance of `ownerId` started. */
  async closeSessionsForClientInstance(
    ownerId: string,
    clientInstanceId: string,
    graceMs = 2_000
  ): Promise<number> {
    const entries = [...this.sessions.entries()].filter(
      ([sessionId]) =>
        this.sessionOwners.get(sessionId) === ownerId &&
        this.sessionClients.get(sessionId) === clientInstanceId
    )
    return this.closeSessionEntries(entries, graceMs)
  }

  private async closeSessionEntries(
    entries: Array<[string, ChildProcess]>,
    graceMs: number
  ): Promise<number> {
    if (entries.length === 0) return 0
    const terminationErrors: Error[] = []
    const settlements = entries
      .map(([sessionId]) => this.sessionSettlements.get(sessionId))
      .filter((value): value is Promise<void> => value !== undefined)

    collectTerminationErrors(
      await Promise.allSettled(
        entries.map(([, child]) =>
          this.requestTreeTermination(child, "SIGTERM")
        )
      ),
      terminationErrors
    )
    await this.waitForChildren(entries, graceMs)

    const remaining = entries.filter(([sessionId, child]) =>
      this.isTreeRetained(sessionId, child)
    )
    collectTerminationErrors(
      await Promise.allSettled(
        remaining.map(([, child]) =>
          this.requestTreeTermination(child, "SIGKILL")
        )
      ),
      terminationErrors
    )
    if (remaining.length > 0) {
      await this.waitForChildren(remaining, 500)
    }
    if (settlements.length > 0) {
      await Promise.race([
        Promise.allSettled(settlements).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_500)),
      ])
    }
    for (const [, child] of entries) {
      terminationErrors.push(...this.terminationState(child).errors)
    }
    const uniqueTerminationErrors = [...new Set(terminationErrors)]
    const survivors = entries.filter(([sessionId, child]) =>
      this.isTreeRetained(sessionId, child)
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

  private async waitForChildren(
    entries: readonly (readonly [string, ChildProcess])[],
    timeoutMs: number
  ): Promise<void> {
    const closed = Promise.all(
      entries.map(
        ([sessionId, child]) =>
          new Promise<void>((resolve) => {
            if (
              this.sessions.get(sessionId) !== child ||
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
   *   - `sessionId` is returned to the caller so a later `abortSession(id)`
   *     can kill the child mid-execution.
   *   - Resolves with `{aborted, timedOut}` flags instead of throwing, so the
   *     renderer can distinguish user-cancel from genuine failure.
   */
  async runCommand(input: RunShellInput): Promise<RunShellOutput> {
    if (!this.admissionsOpen) {
      throw Object.assign(new Error("Shell service is shutting down."), {
        statusCode: 503,
      })
    }
    if (!isShellOwnerActive(input)) {
      throw Object.assign(
        new Error("Shell session owner is no longer active."),
        {
          statusCode: 403,
          code: "SHELL_OWNER_INACTIVE",
        }
      )
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
    const shellId =
      input.shell ?? (process.platform === "win32" ? "cmd" : "bash")
    if (this.sessions.has(sessionId)) {
      throw Object.assign(
        new Error(`Shell session already exists: ${sessionId}`),
        { statusCode: 409 }
      )
    }
    if (this.sessions.size >= MAX_ACTIVE_SHELL_SESSIONS) {
      throw Object.assign(
        new Error(
          `Too many active shell sessions (${MAX_ACTIVE_SHELL_SESSIONS} maximum).`
        ),
        { statusCode: 429 }
      )
    }
    if (
      input.ownerId &&
      this.activeSessionCount(input.ownerId) >=
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

    // One denylist for every shell, PTY and formatter override; see
    // isSafeShellEnvironmentOverrideKey.
    const safeEnv = sanitizedShellEnvironment(input.env ?? {})

    const launch = resolveShellCommandLaunch(shellId, input.command)
    const sessions = this.sessions

    return await new Promise<RunShellOutput>((resolve, reject) => {
      let settled = false
      let callerSettled = false
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
      const untrackChild = trackChildProcessTree(child, "shell command")
      sessions.set(sessionId, child)
      this.sessionSettlements.set(sessionId, runSettled)
      this.sessionCwds.set(sessionId, cwd)
      if (input.ownerId) this.sessionOwners.set(sessionId, input.ownerId)
      if (input.clientInstanceId) {
        this.sessionClients.set(sessionId, input.clientInstanceId)
      }

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
      // Pipe chunks end wherever the OS cut them, often inside a multi-byte
      // character. One decoder per stream carries the partial sequence over.
      const stdoutDecoder = new StringDecoder("utf8")
      const stderrDecoder = new StringDecoder("utf8")
      let timedOut = false
      let signalAborted = false
      let ownerInvalidated = false
      let detachedDescendants = false
      let ownerExpiryTimer: NodeJS.Timeout | undefined
      let timer: NodeJS.Timeout | undefined
      let postExitTimer: NodeJS.Timeout | undefined
      let terminationDeadline: NodeJS.Timeout | undefined
      const onSignalAbort = () => {
        if (signalAborted || sessions.get(sessionId) !== child) return
        signalAborted = true
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        this.abortSession(sessionId, input.ownerId)
        armTerminationDeadline()
      }

      const appendArchive = (chunk: Buffer | string) => {
        if (!archiveStream || archiveFailed) return
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8")
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

      const clearRunTimers = () => {
        if (timer) clearTimeout(timer)
        if (postExitTimer) clearTimeout(postExitTimer)
        if (terminationDeadline) clearTimeout(terminationDeadline)
      }

      const releaseSession = () => {
        input.signal?.removeEventListener("abort", onSignalAbort)
        if (ownerExpiryTimer) {
          clearTimeout(ownerExpiryTimer)
          ownerExpiryTimer = undefined
        }
        if (sessions.get(sessionId) === child) {
          sessions.delete(sessionId)
          this.sessionOwners.delete(sessionId)
          this.sessionSettlements.delete(sessionId)
          this.sessionCwds.delete(sessionId)
          this.sessionClients.delete(sessionId)
        }
        untrackChild()
        markRunSettled()
      }

      const appendDecoded = (stream: "stdout" | "stderr", text: string) => {
        if (!text) return
        if (stream === "stdout") {
          const captured = appendBoundedOutput(
            stdout,
            text,
            MAX_CAPTURED_OUTPUT_BYTES,
            stdoutBytes
          )
          stdout = captured.text
          stdoutBytes = captured.bytes
          stdoutTruncated ||= captured.truncated
          return
        }
        const captured = appendBoundedOutput(
          stderr,
          text,
          MAX_CAPTURED_OUTPUT_BYTES,
          stderrBytes
        )
        stderr = captured.text
        stderrBytes = captured.bytes
        stderrTruncated ||= captured.truncated
      }

      const buildOutput = (
        code: number | null,
        signal: NodeJS.Signals | null
      ) => {
        appendDecoded("stdout", stdoutDecoder.end())
        appendDecoded("stderr", stderrDecoder.end())
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
        return {
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
          ...(detachedDescendants ? { detachedDescendants: true } : {}),
        } satisfies RunShellOutput
      }

      /**
       * Stop reading output that something other than the root still holds.
       * Destroying both pipes lets Node report `close` for an exited root.
       */
      const abandonOutputPipes = () => {
        detachedDescendants = true
        child.stdout?.destroy?.()
        child.stderr?.destroy?.()
      }

      /**
       * After a termination request the caller gets an answer within a bounded
       * time even if the root never reports an exit (a hung taskkill, a process
       * in uninterruptible sleep). The session itself stays registered until
       * the process really exits, so capacity and shutdown still see it.
       */
      function armTerminationDeadline(): void {
        if (terminationDeadline || settled) return
        terminationDeadline = setTimeout(() => {
          if (settled || callerSettled) return
          logger.warn(
            { sessionId, pid: child.pid ?? null },
            "shell command did not settle after termination; answering the caller while the process remains tracked"
          )
          abandonOutputPipes()
          void (async () => {
            await closeArchive()
            if (settled || callerSettled) return
            callerSettled = true
            resolve(buildOutput(child.exitCode, child.signalCode))
          })()
        }, TERMINATION_SETTLE_DEADLINE_MS)
        terminationDeadline.unref?.()
      }

      const invalidateOwner = () => {
        if (ownerInvalidated || sessions.get(sessionId) !== child) return
        ownerInvalidated = true
        this.abortSession(sessionId, input.ownerId)
        armTerminationDeadline()
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

      child.stdout?.on("data", (d: Buffer) => {
        appendArchive(d)
        appendDecoded("stdout", stdoutDecoder.write(d))
      })
      child.stderr?.on("data", (d: Buffer) => {
        appendArchive(d)
        appendDecoded("stderr", stderrDecoder.write(d))
      })
      // A destroyed pipe can report an error after the run gave up on it.
      child.stdout?.on("error", () => undefined)
      child.stderr?.on("error", () => undefined)

      timer = setTimeout(() => {
        timedOut = true
        this.requestTreeTermination(child, "SIGTERM")
        setTimeout(() => {
          if (sessions.get(sessionId) === child) {
            this.requestTreeTermination(child, "SIGKILL")
          }
        }, 3_000).unref?.()
        armTerminationDeadline()
      }, timeoutMs)

      child.once("exit", () => {
        if (process.platform !== "win32" && child.pid != null) {
          this.requestProcessGroupFinalization(child)
        }
        if (settled) return
        let graceExtensions = 0
        const onPostExitGraceElapsed = () => {
          if (settled) return
          // Output paused for a slow archive write is ours, not a descendant's.
          if (archiveBackpressured && graceExtensions < 6) {
            graceExtensions += 1
            postExitTimer = setTimeout(
              onPostExitGraceElapsed,
              POST_EXIT_OUTPUT_GRACE_MS
            )
            postExitTimer.unref?.()
            return
          }
          logger.warn(
            { sessionId, pid: child.pid ?? null },
            "shell command exited but a descendant still holds its output; no longer waiting for it"
          )
          abandonOutputPipes()
        }
        postExitTimer = setTimeout(
          onPostExitGraceElapsed,
          POST_EXIT_OUTPUT_GRACE_MS
        )
        postExitTimer.unref?.()
      })
      child.on("error", (err) => {
        if (settled) return
        settled = true
        clearRunTimers()
        void (async () => {
          if (child.pid != null) {
            await this.requestTreeTermination(child, "SIGKILL").catch(
              () => undefined
            )
          }
          const treeErrors = await this.settleTreeAfterRootExit(child)
          await closeArchive()
          await discardPartialArchive()
          releaseSession()
          if (callerSettled) return
          callerSettled = true
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
        clearRunTimers()
        const treeErrors = await this.settleTreeAfterRootExit(child)
        const output = buildOutput(code, signal)
        await closeArchive()
        if (archiveFailed) await discardPartialArchive()
        releaseSession()
        if (callerSettled) return
        callerSettled = true
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
        resolve(
          archiveFailed && output.archivePath
            ? (({ archivePath: _archivePath, ...rest }) => rest)(output)
            : output
        )
      })
      input.signal?.addEventListener("abort", onSignalAbort, { once: true })
      if (input.signal?.aborted) onSignalAbort()
    })
  }

  private terminationState(child: ChildProcess): ShellTreeTerminationState {
    let state = this.treeTerminations.get(child)
    if (!state) {
      state = { pending: new Set(), errors: [] }
      this.treeTerminations.set(child, state)
    }
    return state
  }

  private requestTreeTermination(
    child: ChildProcess,
    signal: NodeJS.Signals
  ): Promise<void> {
    const state = this.terminationState(child)
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

  private requestProcessGroupFinalization(child: ChildProcess): Promise<void> {
    const state = this.terminationState(child)
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

  private async settleTreeAfterRootExit(child: ChildProcess): Promise<Error[]> {
    const state = this.terminationState(child)
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

  private isTreeRetained(sessionId: string, child: ChildProcess): boolean {
    if (this.sessions.get(sessionId) === child) return true
    if (process.platform === "win32" || child.pid == null) return false
    try {
      return isPosixProcessGroupAlive(child.pid)
    } catch {
      return true
    }
  }
}

/**
 * The parts of `ShellSessionService` that run a command; what an agent tool
 * or a hook needs.
 */
export type ShellCommandRunner = Pick<ShellSessionService, "runCommand">

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
    //
    // Every request is forced, SIGTERM included: Windows refuses a graceful
    // taskkill for windowless console processes, and the old fallback then
    // ended only the root, which left the tree unaddressable and the run
    // waiting on pipes its descendants still held.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        logger.warn(
          { pid: child.pid, signal },
          "shell root process already exited before tree termination; descendants may be orphaned on Windows"
        )
        return
      }
      try {
        await taskkillChildProcessTree(child)
        return
      } catch (error) {
        const failure = error as { code?: unknown; exitCode?: unknown }
        if (
          failure.code === "TASKKILL_ROOT_EXITED" ||
          (failure.code === "TASKKILL_FAILED" && failure.exitCode === 128)
        ) {
          // The root ended between the check and the helper's lookup.
          logger.warn(
            { pid: child.pid, signal },
            "shell root process exited during tree termination; descendants may be orphaned on Windows"
          )
          return
        }
        // 255 is a partial traversal (a descendant exited while taskkill
        // walked the tree); retry once while the root is still ours.
        if (failure.code === "TASKKILL_FAILED" && failure.exitCode === 255) {
          continue
        }
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {
            // Preserve the taskkill failure, which contains the actionable cause.
          }
        }
        throw error
      }
    }
    throw Object.assign(
      new Error(`taskkill could not end shell process tree ${child.pid}.`),
      { code: "TASKKILL_FAILED", pid: child.pid, exitCode: 255 }
    )
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

export interface ShellLaunchResolutionOptions {
  /** Test seam: absolute path of a program on PATH, or null. */
  readonly resolveExecutable?: (name: string) => string | null
}

/**
 * Build the spawn for `command` under `shellId`.
 *
 * Every shell binary is an absolute path. A bare `powershell`/`bash`/`wsl`
 * spawned with the workspace as cwd is looked up in that workspace first on
 * Windows, and a repository can select these shell ids itself through its
 * project config, so a committed `powershell.exe` would run instead.
 */
export function resolveShellCommandLaunch(
  shellId: string,
  command: string,
  options: ShellLaunchResolutionOptions = {}
): ShellCommandLaunch {
  const resolveExecutable =
    options.resolveExecutable ??
    ((name: string) => resolveExecutableOnPath(name))
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
        binary:
          process.platform === "win32"
            ? windowsSystemExecutable(
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
              )
            : requireShellExecutable("powershell", resolveExecutable),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powerShellUtf8Command(command),
        ],
      }
    case "pwsh":
      return {
        shell: "pwsh",
        binary: requireShellExecutable("pwsh", resolveExecutable),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powerShellUtf8Command(command),
        ],
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
        binary:
          process.platform === "win32"
            ? windowsSystemExecutable("wsl.exe")
            : requireShellExecutable("wsl", resolveExecutable),
        args: ["--", "bash", "-c", command],
      }
    case "bash":
    case "zsh":
    case "sh":
      return {
        shell: normalized,
        binary: requireShellExecutable(normalized, resolveExecutable),
        args: ["-c", command],
      }
    default:
      if (process.platform === "win32") {
        // cmd /c reads its command line only up to the first CR or LF and
        // silently drops the rest, so a multi-line script would run its first
        // line and report that line's exit code as the result. Refuse it.
        if (/[\r\n]/.test(command)) {
          throw Object.assign(
            new Error(
              "cmd.exe runs only the first line of a multi-line command. Join the commands with && or run the script with PowerShell or Git Bash."
            ),
            { statusCode: 400, code: "SHELL_MULTILINE_UNSUPPORTED" }
          )
        }
        // `cmd /c <command>` through Node's default quoting corrupts any
        // embedded double quote: Node re-escapes it as `\"`, which cmd does
        // not understand, so `git commit -m "fix: thing"` reached the child
        // as `-m`, `"fix:`, `thing"`. Pass the line verbatim with `/s` so cmd
        // strips exactly our outer quotes and parses the rest as typed. See
        // ../security/windowsCommandLine.ts for the full pattern.
        //
        // cmd's built-ins and most console programs write in the console's
        // OEM code page, which is not UTF-8; switching the hidden console to
        // 65001 first makes the output decodable. chcp is addressed by its
        // absolute path so a `chcp.bat` in the workspace is not picked up.
        return {
          shell: "cmd",
          binary: resolveComSpec(),
          args: [
            "/d",
            "/s",
            "/c",
            `"${windowsChcpCommand()} 65001>nul & ${command}"`,
          ],
          windowsVerbatimArguments: true,
        }
      }
      return {
        shell: "sh",
        binary: requireShellExecutable("sh", resolveExecutable),
        args: ["-c", command],
      }
  }
}

function windowsChcpCommand(): string {
  const chcp = path.win32.join(windowsSystemRoot(), "System32", "chcp.com")
  return /[\s&()^|<>%!"]/.test(chcp) ? `"${chcp}"` : chcp
}

/**
 * Windows PowerShell writes redirected output in the console's code page;
 * make it UTF-8 (without a byte-order mark) before the command runs. A
 * failure to switch is ignored so the command itself always runs.
 */
function powerShellUtf8Command(command: string): string {
  return `try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ${command}`
}

const POSIX_SHELL_FALLBACKS: Record<string, readonly string[]> = {
  bash: [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/bash",
  ],
  zsh: [
    "/bin/zsh",
    "/usr/bin/zsh",
    "/usr/local/bin/zsh",
    "/opt/homebrew/bin/zsh",
  ],
  sh: ["/bin/sh", "/usr/bin/sh"],
}

/**
 * Absolute path of a shell program, from PATH (absolute entries only) or,
 * for the POSIX shells, their standard locations. Throws an ENOENT-coded
 * error rather than handing spawn a bare name.
 */
function requireShellExecutable(
  name: string,
  resolveExecutable: (name: string) => string | null
): string {
  const onPath = resolveExecutable(name)
  if (onPath) return onPath
  if (process.platform === "win32" && name === "pwsh") {
    for (const root of [process.env.ProgramW6432, process.env.ProgramFiles]) {
      if (!root) continue
      const candidate = path.win32.join(root, "PowerShell", "7", "pwsh.exe")
      if (fs.existsSync(candidate)) return candidate
    }
  }
  if (process.platform !== "win32") {
    for (const candidate of POSIX_SHELL_FALLBACKS[name] ?? []) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Not installed here.
      }
    }
  }
  throw Object.assign(new Error(`${name} was not found on PATH.`), {
    statusCode: 400,
    code: "ENOENT",
  })
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
      probeCommand(
        windowsSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]
      ),
      probeCommand(windowsSystemExecutable("wsl.exe"), ["--status"]),
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
    const zsh = resolveExecutableOnPath("zsh")
    if (zsh && (await probeCommand(zsh, ["--version"]))) {
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
