import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  spawnNativePty,
  type NativePtyHandle,
  type NativePtyExit,
} from "../provider/runtime/claudeTerminal/NativePty"
import { resolveGitBashPath } from "./shell"
import {
  isSafeShellEnvironmentOverrideKey,
  sanitizedShellEnvironment,
} from "../security/childEnvironment"

const MAX_EVENTS = 5_000
export const TERMINAL_PTY_MAX_EVENT_DATA_BYTES = 256 * 1024
export const TERMINAL_PTY_MAX_BUFFER_BYTES = 4 * 1024 * 1024
export const TERMINAL_PTY_MAX_ACTIVE_SESSIONS = 16
export const TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER = 4
export const TERMINAL_PTY_MAX_RETAINED_SESSIONS = 64
const SESSION_TTL_MS = 60_000
/**
 * How long a shutdown waits for a force-ended terminal's exit to be
 * reported. Windows' ConPTY reports it about a second after the process
 * ended (1.1 s measured with cmd.exe); a shorter wait counts an ended
 * terminal as one that did not exit, and the backend then refuses to
 * release its resources.
 */
export const TERMINAL_PTY_KILLED_EXIT_REPORT_MS = 3_000

export interface OpenTerminalPtyInput {
  readonly sessionId?: string
  readonly ownerId?: string
  readonly ownerExpiresAt?: number
  readonly cwd: string
  readonly shell?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly cols?: number
  readonly rows?: number
  readonly onProcessExit?: () => void
  readonly onProcessTreeFailure?: (error: Error) => void
}

export interface TerminalPtyEvent {
  readonly seq: number
  readonly type: "data" | "exit" | "system"
  readonly data?: string
  readonly exitCode?: number | null
  readonly signal?: number | string | null
  readonly at: number
}

export interface TerminalPtySnapshot {
  readonly sessionId: string
  readonly pid: number
  readonly cwd: string
  readonly shell: string
  readonly command: string
  readonly args: readonly string[]
  readonly status: "running" | "exited" | "cleanup_failed"
  readonly events: readonly TerminalPtyEvent[]
  readonly nextCursor: number
}

interface TerminalPtySession {
  readonly sessionId: string
  readonly pid: number
  readonly cwd: string
  readonly shell: string
  readonly command: string
  readonly args: readonly string[]
  readonly handle: NativePtyHandle
  readonly ownerId?: string
  readonly exitPromise: Promise<void>
  terminationTail: Promise<void>
  terminationPendingCount: number
  terminationErrors: Error[]
  exitError: Error | null
  status: "running" | "exited" | "cleanup_failed"
  closeRequested: boolean
  nextSeq: number
  events: TerminalPtyEvent[]
  bufferedBytes: number
  cleanupTimer: NodeJS.Timeout | null
  terminationTimer: NodeJS.Timeout | null
  ownerExpiryTimer: NodeJS.Timeout | null
  processExitNotified: boolean
  readonly onProcessExit?: () => void
  readonly onProcessTreeFailure?: (error: Error) => void
}

const sessions = new Map<string, TerminalPtySession>()
let terminalPtyAdmissionsOpen = true

export function resumeTerminalPtyAdmissions(): void {
  terminalPtyAdmissionsOpen = true
}

export function beginTerminalPtyShutdown(): void {
  terminalPtyAdmissionsOpen = false
}

export function openTerminalPtySession(
  input: OpenTerminalPtyInput
): TerminalPtySnapshot {
  if (!terminalPtyAdmissionsOpen) {
    throw Object.assign(new Error("Terminal service is shutting down."), {
      statusCode: 503,
    })
  }
  if (
    input.ownerExpiresAt !== undefined &&
    (!Number.isFinite(input.ownerExpiresAt) ||
      input.ownerExpiresAt <= Date.now())
  ) {
    throw Object.assign(
      new Error("Terminal session owner is no longer active."),
      {
        statusCode: 403,
        code: "TERMINAL_PTY_OWNER_INACTIVE",
      }
    )
  }
  const sessionId = input.sessionId ?? randomUUID()
  if (sessions.has(sessionId)) {
    throw Object.assign(
      new Error(`Terminal session already exists: ${sessionId}`),
      {
        statusCode: 409,
      }
    )
  }
  pruneExitedSessionsForCapacity()
  const activeSessionCount = countActiveSessions()
  if (activeSessionCount >= TERMINAL_PTY_MAX_ACTIVE_SESSIONS) {
    throw Object.assign(
      new Error(
        `Too many active terminal sessions (${TERMINAL_PTY_MAX_ACTIVE_SESSIONS} maximum).`
      ),
      { statusCode: 429 }
    )
  }
  if (
    input.ownerId &&
    countActiveSessions(input.ownerId) >=
      TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER
  ) {
    throw Object.assign(
      new Error(
        `Too many active terminal sessions for this caller (${TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER} maximum).`
      ),
      { statusCode: 429 }
    )
  }

  const cwd = resolveCwd(input.cwd)
  const launch = input.command
    ? {
        shell: "custom",
        command: input.command,
        args: [...(input.args ?? [])],
      }
    : resolveTerminalShellLaunch(input.shell)
  const displayArgs = formatLaunchArgs(launch.args)
  const env = makeTerminalEnv(input.env)
  const handle = spawnNativePty({
    command: launch.command,
    args: launch.args,
    cwd,
    env,
    cols: input.cols,
    rows: input.rows,
    onData: (data) => pushEvent(sessionId, { type: "data", data }),
  })
  const nativeExitPromise = handle.waitForExit()
  let settleExitPromise!: () => void
  const exitPromise = new Promise<void>((resolve) => {
    settleExitPromise = resolve
  })
  const session: TerminalPtySession = {
    sessionId,
    pid: handle.pid,
    cwd,
    shell: launch.shell,
    command: launch.command,
    args: displayArgs,
    handle,
    ownerId: input.ownerId,
    exitPromise,
    terminationTail: Promise.resolve(),
    terminationPendingCount: 0,
    terminationErrors: [],
    exitError: null,
    status: "running",
    closeRequested: false,
    nextSeq: 0,
    events: [],
    bufferedBytes: 0,
    cleanupTimer: null,
    terminationTimer: null,
    ownerExpiryTimer: null,
    processExitNotified: false,
    onProcessExit: input.onProcessExit,
    onProcessTreeFailure: input.onProcessTreeFailure,
  }
  sessions.set(sessionId, session)
  scheduleTerminalPtyOwnerExpiry(session, input.ownerExpiresAt)
  pushEvent(sessionId, {
    type: "system",
    data: formatLaunchCommand(launch.command, displayArgs),
  })
  void nativeExitPromise.then(
    (exit) => {
      markExited(session, exit)
      settleExitPromise()
    },
    (error) => {
      markExitFailed(session, error)
      settleExitPromise()
    }
  )

  return snapshot(session, 0)
}

export function readTerminalPtySession(
  sessionId: string,
  cursor = 0,
  ownerId?: string
): TerminalPtySnapshot | null {
  const session = sessions.get(sessionId)
  if (!session || !ownerMatches(session, ownerId)) return null
  return snapshot(session, cursor)
}

export function writeTerminalPtySession(
  sessionId: string,
  data: string,
  ownerId?: string
): boolean {
  const session = sessions.get(sessionId)
  if (
    !session ||
    !ownerMatches(session, ownerId) ||
    session.status !== "running" ||
    session.closeRequested
  ) {
    return false
  }
  session.handle.write(data)
  return true
}

export function terminalPtySessionCwd(
  sessionId: string,
  ownerId?: string
): string | null {
  const session = sessions.get(sessionId)
  return session && ownerMatches(session, ownerId) ? session.cwd : null
}

export function resizeTerminalPtySession(
  sessionId: string,
  cols: number,
  rows: number,
  ownerId?: string
): boolean {
  const session = sessions.get(sessionId)
  if (
    !session ||
    !ownerMatches(session, ownerId) ||
    session.status !== "running" ||
    session.closeRequested
  ) {
    return false
  }
  session.handle.resize(cols, rows)
  return true
}

export function closeTerminalPtySession(
  sessionId: string,
  ownerId?: string
): boolean {
  const session = sessions.get(sessionId)
  if (!session || !ownerMatches(session, ownerId)) return false
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
  if (session.ownerExpiryTimer) {
    clearTimeout(session.ownerExpiryTimer)
    session.ownerExpiryTimer = null
  }
  session.closeRequested = true
  if (session.status !== "exited") {
    if (!session.terminationTimer && session.terminationPendingCount === 0) {
      queueTerminalPtyTermination(session, "SIGTERM")
      session.terminationTimer = setTimeout(() => {
        session.terminationTimer = null
        if (session.status !== "exited") {
          queueTerminalPtyTermination(session, "SIGKILL")
        }
      }, 2_000)
      session.terminationTimer.unref?.()
    }
  } else {
    sessions.delete(sessionId)
  }
  return true
}

export function closeAllTerminalPtySessions(): number {
  const sessionIds = [...sessions.keys()]
  for (const sessionId of sessionIds) closeTerminalPtySession(sessionId)
  return sessionIds.length
}

/**
 * Stops all retained PTYs and waits for their native processes to exit.
 * Shutdown remains bounded even when a PTY implementation never resolves its
 * exit promise.
 */
export async function shutdownAllTerminalPtySessions(
  graceMs = 2_000
): Promise<number> {
  const retained = [...sessions.values()]
  return shutdownTerminalPtySessions(retained, graceMs)
}

export async function shutdownTerminalPtySessionsForWorkspace(
  workspace: string,
  graceMs = 2_000
): Promise<number> {
  const retained = [...sessions.values()].filter((session) =>
    isSameOrDescendantPath(workspace, session.cwd)
  )
  return shutdownTerminalPtySessions(retained, graceMs)
}

export async function shutdownTerminalPtySessionsForOwner(
  ownerId: string,
  graceMs = 2_000
): Promise<number> {
  const retained = [...sessions.values()].filter(
    (session) => session.ownerId === ownerId
  )
  return shutdownTerminalPtySessions(retained, graceMs)
}

async function shutdownTerminalPtySessions(
  retained: TerminalPtySession[],
  graceMs: number
): Promise<number> {
  if (retained.length === 0) return 0

  const gracefulTerminations: Promise<void>[] = []
  for (const session of retained) {
    session.closeRequested = true
    if (session.terminationTimer) {
      clearTimeout(session.terminationTimer)
      session.terminationTimer = null
    }
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
      session.cleanupTimer = null
    }
    if (session.ownerExpiryTimer) {
      clearTimeout(session.ownerExpiryTimer)
      session.ownerExpiryTimer = null
    }
    if (session.status === "exited") continue
    gracefulTerminations.push(queueTerminalPtyTermination(session, "SIGTERM"))
  }

  await Promise.all(gracefulTerminations)
  await waitForTerminalPtySessions(retained, graceMs)
  const running = retained.filter((session) => session.status !== "exited")
  await Promise.all(
    running.map((session) => queueTerminalPtyTermination(session, "SIGKILL"))
  )
  if (running.length > 0) {
    await waitForTerminalPtySessions(
      running,
      TERMINAL_PTY_KILLED_EXIT_REPORT_MS
    )
  }

  for (const session of retained) {
    if (
      session.status === "exited" &&
      sessions.get(session.sessionId) === session
    ) {
      sessions.delete(session.sessionId)
    }
  }
  const survivors = retained.filter((session) => session.status !== "exited")
  if (survivors.length > 0) {
    throw Object.assign(
      new Error(
        `${survivors.length} terminal session(s) did not exit during shutdown.`
      ),
      {
        code: "TERMINAL_PTY_SHUTDOWN_INCOMPLETE",
        sessionIds: survivors.map((session) => session.sessionId),
        causes: survivors.flatMap((session) => [
          ...session.terminationErrors,
          ...(session.exitError ? [session.exitError] : []),
        ]),
      }
    )
  }
  return retained.length
}

async function waitForTerminalPtySessions(
  retained: readonly TerminalPtySession[],
  timeoutMs: number
): Promise<void> {
  const exited = Promise.all(
    retained.map((session) => session.exitPromise)
  ).then(() => undefined)
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

function queueTerminalPtyTermination(
  session: TerminalPtySession,
  signal: NodeJS.Signals | undefined
): Promise<void> {
  const invoke = async () => {
    await session.handle.kill(signal)
  }
  const operation =
    session.terminationPendingCount === 0
      ? invoke()
      : session.terminationTail.then(invoke)
  session.terminationPendingCount += 1
  const observed = operation.then(
    () => {
      session.terminationErrors.length = 0
    },
    (error) => {
      session.terminationErrors.push(asError(error))
    }
  )
  const finalized = observed.finally(() => {
    session.terminationPendingCount = Math.max(
      0,
      session.terminationPendingCount - 1
    )
  })
  session.terminationTail = finalized
  return finalized
}

function snapshot(
  session: TerminalPtySession,
  cursor: number
): TerminalPtySnapshot {
  const events = session.events.filter((event) => event.seq > cursor)
  return {
    sessionId: session.sessionId,
    pid: session.pid,
    cwd: session.cwd,
    shell: session.shell,
    command: session.command,
    args: session.args,
    status: session.status,
    events,
    nextCursor: events.at(-1)?.seq ?? cursor,
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
    // The path may disappear while a terminal is being shut down.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function markExited(session: TerminalPtySession, exit: NativePtyExit): void {
  session.status = "exited"
  session.exitError = null
  session.terminationErrors.length = 0
  if (!session.processExitNotified) {
    session.processExitNotified = true
    try {
      session.onProcessExit?.()
    } catch {
      // A lifecycle observer must not prevent PTY cleanup.
    }
  }
  if (session.terminationTimer) {
    clearTimeout(session.terminationTimer)
    session.terminationTimer = null
  }
  if (session.ownerExpiryTimer) {
    clearTimeout(session.ownerExpiryTimer)
    session.ownerExpiryTimer = null
  }
  if (sessions.get(session.sessionId) !== session) return
  pushEvent(session.sessionId, {
    type: "exit",
    exitCode: exit.exitCode,
    signal: exit.signal ?? null,
  })
  if (session.closeRequested) {
    sessions.delete(session.sessionId)
  } else {
    scheduleCleanup(session)
  }
}

function markExitFailed(session: TerminalPtySession, error: unknown): void {
  session.exitError = asError(error)
  session.status = "cleanup_failed"
  session.closeRequested = true
  try {
    session.onProcessTreeFailure?.(session.exitError)
  } catch {
    // The session remains quarantined even if the fatal observer itself fails.
  }
  if (sessions.get(session.sessionId) !== session) return
  pushEvent(session.sessionId, {
    type: "system",
    data: `Terminal process-tree cleanup failed: ${session.exitError.message}`,
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function pushEvent(
  sessionId: string,
  event: Omit<TerminalPtyEvent, "seq" | "at">
): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.nextSeq += 1
  const boundedEvent =
    typeof event.data === "string"
      ? { ...event, data: boundTerminalPtyData(event.data) }
      : event
  const stored = {
    ...boundedEvent,
    seq: session.nextSeq,
    at: Date.now(),
  }
  session.events.push(stored)
  session.bufferedBytes += terminalEventBytes(stored)
  while (
    session.events.length > MAX_EVENTS ||
    session.bufferedBytes > TERMINAL_PTY_MAX_BUFFER_BYTES
  ) {
    const removed = session.events.shift()
    if (!removed) break
    session.bufferedBytes = Math.max(
      0,
      session.bufferedBytes - terminalEventBytes(removed)
    )
  }
}

export function boundTerminalPtyData(data: string): string {
  const bytes = Buffer.from(data, "utf8")
  if (bytes.byteLength <= TERMINAL_PTY_MAX_EVENT_DATA_BYTES) return data
  const marker = Buffer.from("\n[... terminal output truncated ...]\n", "utf8")
  const tailBytes = Math.max(
    0,
    TERMINAL_PTY_MAX_EVENT_DATA_BYTES - marker.byteLength
  )
  const prefix = marker.toString("utf8")
  let tail = bytes.subarray(bytes.length - tailBytes).toString("utf8")
  while (
    tail.length > 0 &&
    Buffer.byteLength(prefix + tail, "utf8") > TERMINAL_PTY_MAX_EVENT_DATA_BYTES
  ) {
    tail = tail.slice(1)
  }
  return prefix + tail
}

function terminalEventBytes(event: TerminalPtyEvent): number {
  return typeof event.data === "string"
    ? Buffer.byteLength(event.data, "utf8")
    : 0
}

function scheduleCleanup(session: TerminalPtySession): void {
  if (session.cleanupTimer) return
  session.cleanupTimer = setTimeout(() => {
    if (sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId)
    }
  }, SESSION_TTL_MS)
  session.cleanupTimer.unref?.()
}

function scheduleTerminalPtyOwnerExpiry(
  session: TerminalPtySession,
  expiresAt: number | undefined
): void {
  if (expiresAt === undefined || session.status === "exited") return
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) {
    closeTerminalPtySession(session.sessionId, session.ownerId)
    return
  }
  session.ownerExpiryTimer = setTimeout(
    () => {
      session.ownerExpiryTimer = null
      scheduleTerminalPtyOwnerExpiry(session, expiresAt)
    },
    Math.min(remaining, 2_147_000_000)
  )
  session.ownerExpiryTimer.unref?.()
}

function countActiveSessions(ownerId?: string): number {
  let count = 0
  for (const session of sessions.values()) {
    if (
      session.status !== "exited" &&
      (ownerId === undefined || session.ownerId === ownerId)
    ) {
      count += 1
    }
  }
  return count
}

export function activeTerminalPtySessionCount(): number {
  return countActiveSessions()
}

function ownerMatches(
  session: TerminalPtySession,
  ownerId: string | undefined
): boolean {
  return ownerId === undefined || session.ownerId === ownerId
}

function pruneExitedSessionsForCapacity(): void {
  if (sessions.size < TERMINAL_PTY_MAX_RETAINED_SESSIONS) return
  for (const [sessionId, session] of sessions) {
    if (session.status !== "exited") continue
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
    sessions.delete(sessionId)
    if (sessions.size < TERMINAL_PTY_MAX_RETAINED_SESSIONS) return
  }
}

function resolveCwd(cwd: string): string {
  if (!cwd || cwd.trim().length === 0 || cwd === "~") {
    return os.homedir()
  }
  return path.resolve(cwd.replace(/^~(?=$|\/|\\)/, os.homedir()))
}

export function resolveTerminalShellLaunch(shellId: string | undefined): {
  shell: string
  command: string
  args: string[]
} {
  if (process.platform === "win32") {
    const normalized = normalizeShellId(shellId)
    if (normalized === "powershell" || normalized === "pwsh") {
      return {
        shell: normalized,
        command: normalized === "pwsh" ? "pwsh.exe" : "powershell.exe",
        args: ["-NoLogo"],
      }
    }
    if (normalized === "gitbash") {
      const gitBash = findGitBash()
      if (!gitBash) {
        throw Object.assign(new Error("Git Bash not found."), {
          statusCode: 404,
        })
      }
      return { shell: "gitbash", command: gitBash, args: ["--login"] }
    }
    if (normalized === "wsl") {
      return { shell: "wsl", command: "wsl.exe", args: [] }
    }
    return { shell: "cmd", command: "cmd.exe", args: [] }
  }

  if (shellId && path.isAbsolute(shellId)) {
    const shell = path.basename(shellId)
    return {
      shell,
      command: shellId,
      args: shell === "bash" || shell === "zsh" ? ["-l"] : [],
    }
  }

  const detected = normalizeShellId(shellId ?? detectDefaultUnixShell())
  if (detected === "zsh") return { shell: "zsh", command: "zsh", args: ["-l"] }
  if (detected === "bash")
    return { shell: "bash", command: "bash", args: ["-l"] }
  if (detected === "sh") return { shell: "sh", command: "sh", args: [] }
  const userShell = process.env.SHELL || "/bin/sh"
  return { shell: path.basename(userShell), command: userShell, args: ["-l"] }
}

function normalizeShellId(shellId: string | undefined): string {
  const trimmed = (shellId ?? "").trim()
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

function formatLaunchArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1]
    if (previous === "--append-system-prompt") {
      return "[BetterC0de thread context]"
    }
    if (arg.length > 240) {
      return `${arg.slice(0, 220)}...[truncated]`
    }
    return arg
  })
}

function formatLaunchCommand(
  command: string,
  displayArgs: readonly string[]
): string {
  return `${command} ${displayArgs.join(" ")}`.trim()
}

function detectDefaultUnixShell(): "bash" | "zsh" | string {
  const base = path.basename(process.env.SHELL || "")
  if (base === "zsh" || base === "bash") return base
  return "bash"
}

function findGitBash(): string | null {
  return resolveGitBashPath()
}

function makeTerminalEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return sanitizedShellEnvironment({
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    ...Object.fromEntries(
      Object.entries(extra ?? {}).filter(([key]) =>
        isSafeShellEnvironmentOverrideKey(key)
      )
    ),
  })
}
