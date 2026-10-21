import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import path from "node:path"
import { sanitizedChildEnvironment } from "../../../security/childEnvironment"
import {
  buildWindowsCmdArgs,
  resolveComSpec,
} from "../../../security/windowsCommandLine"
import { trackChildProcessTree } from "../../../services/child-process-registry"
import { logger } from "../../../observability/logger"
import {
  listWindowsChildProcesses,
  runProviderWindowsTaskkill,
  windowsProcessStillMatches,
  type WindowsProcessRecord,
} from "../ChildProcessTermination"
import { ChildStdinWriter } from "../ChildStdinWriter"
import {
  DEFAULT_NDJSON_LINE_BYTE_CAP,
  NdjsonLineReader,
  dispatchNdjsonNotification,
  identifyOversizedLine,
  type OversizedNdjsonLine,
} from "../NdjsonLineReader"
import { ProcessStderrTail } from "../ProcessStderrTail"
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: number | string
  readonly result?: unknown
  readonly error?: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export interface ServerRequestHandler {
  (
    method: string,
    params: unknown,
    respond: (result: unknown) => void,
    respondError: (code: number, message: string, data?: unknown) => void
  ): void
}

export interface NotificationHandler {
  (method: string, params: unknown): void
}

export interface ProtocolLogHandler {
  (event: {
    readonly direction: "incoming" | "outgoing"
    readonly payload: unknown
  }): void
}

export interface AcpJsonRpcClientOptions {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly callTimeoutMs?: number
  readonly stdoutLineByteCap?: number
  readonly protocolLogger?: ProtocolLogHandler | null
  /** Test seam for deterministic retained-child close retry coverage. */
  readonly terminateChildProcess?: (
    child: ChildProcessWithoutNullStreams
  ) => Promise<void>
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000

/**
 * `session/prompt` resolves only when the whole turn is finished, so it must
 * not share the short per-call timeout. It used to, which killed every turn
 * that ran longer than a minute and surfaced it as "Grok provider failed".
 *
 * This is a budget for *silence*, re-armed by every inbound message, so a turn
 * may run for hours while the agent is producing something — and a genuinely
 * wedged process still fails instead of hanging forever. It is held while the
 * agent waits on one of our answers (`holdIdleTimeouts`): a permission request
 * or question parked for the user is not silence.
 */
export const ACP_PROMPT_IDLE_TIMEOUT_MS = 10 * 60_000

/**
 * A call that never came back.
 *
 * Typed rather than a bare `Error` so the adapters can tell this apart from a
 * protocol fault and say so. It used to be indistinguishable, which is how a
 * turn killed by the old 60s deadline reached the user as the unhelpful
 * "Grok provider failed." — the one fact that would have explained it lived
 * only in the backend log.
 *
 * The message names a duration and an RPC method. It carries no path, no
 * credential and no prompt content, so it is safe to show.
 */
export class AcpRpcTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  /** True when the deadline measured silence rather than total duration. */
  readonly idle: boolean

  constructor(method: string, timeoutMs: number, idle: boolean) {
    super(
      idle
        ? `acp rpc timeout: ${method} produced no output for ${timeoutMs} ms`
        : `acp rpc timeout after ${timeoutMs} ms: ${method}`
    )
    this.name = "AcpRpcTimeoutError"
    this.method = method
    this.timeoutMs = timeoutMs
    this.idle = idle
  }
}

function formatTimeoutDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}

/**
 * What to show the user when an ACP turn fails.
 *
 * Only the timeout is explained: it is the one failure whose cause is both
 * useful and safe to repeat verbatim. Anything else stays generic rather than
 * risking an internal detail on screen.
 */
export function acpTurnFailureMessage(
  error: unknown,
  providerLabel: string
): string {
  if (error instanceof AcpRpcTimeoutError) {
    const duration = formatTimeoutDuration(error.timeoutMs)
    return error.idle
      ? `${providerLabel} stopped responding — nothing received for ${duration}.`
      : `${providerLabel} did not answer within ${duration}.`
  }
  if (error instanceof AcpServerResponseRefusedError) {
    return `${providerLabel} did not receive the reply to its ${describeAcpServerRequest(
      error.method
    )} because its input backlog is full; the turn was stopped.`
  }
  return `${providerLabel} provider failed.`
}

/**
 * The reply to a server-initiated request (a permission or question) could
 * not be handed to the agent: the stdin writer refused it because its backlog
 * bound was exceeded or the pipe is dead. The agent would wait for that reply
 * forever, so the client fails the turn with this instead of dropping it.
 */
export class AcpServerResponseRefusedError extends Error {
  readonly method: string
  readonly requestId: number | string

  constructor(method: string, requestId: number | string) {
    super(
      `acp rpc response to server request ${method} (id ${String(requestId)}) was refused by the stdin writer`
    )
    this.name = "AcpServerResponseRefusedError"
    this.method = method
    this.requestId = requestId
  }
}

function describeAcpServerRequest(method: string): string {
  if (method === "session/request_permission") return "permission request"
  return "request"
}
const DEFAULT_STDOUT_LINE_CAP = DEFAULT_NDJSON_LINE_BYTE_CAP

interface PendingRequest {
  readonly method: string
  timer: NodeJS.Timeout
  /**
   * When set, the deadline measures *silence* rather than total duration: any
   * inbound traffic re-arms it. Used for calls that legitimately run as long as
   * the agent keeps working.
   */
  readonly idleTimeoutMs?: number
  /** Re-arms `timer` for the full idle window. Only set alongside `idleTimeoutMs`. */
  readonly rearm?: () => void
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

function spawnCommandAndArgs(
  command: string,
  args: ReadonlyArray<string>
): {
  command: string
  args: ReadonlyArray<string>
  windowsVerbatimArguments: boolean
} {
  if (process.platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false }
  }
  const directExe = path.isAbsolute(command) && /\.exe$/i.test(command)
  if (directExe) return { command, args, windowsVerbatimArguments: false }
  return {
    command: resolveComSpec(),
    args: buildWindowsCmdArgs(command, args),
    windowsVerbatimArguments: true,
  }
}

/** Wait until the child has exited, up to `timeoutMs`. True = it's dead. */
function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve(child.exitCode !== null || child.signalCode !== null)
    }, timeoutMs)
    timer.unref()
    child.once("exit", onExit)
  })
}

export interface AcpChildTerminationDeps {
  readonly platform?: NodeJS.Platform
  /** Test seam for the Windows tree kill; defaults to the shared runner. */
  readonly runTaskkill?: (pid: number) => Promise<void>
  /** Test seam for the descendant snapshot taken before the root is killed. */
  readonly listDescendants?: (pid: number) => Promise<WindowsProcessRecord[]>
  /** Test seam: is the recorded process still the one we snapshotted? */
  readonly probeDescendant?: (record: WindowsProcessRecord) => Promise<boolean>
  readonly taskkillExitGraceMs?: number
  readonly killGraceMs?: number
}

/**
 * What we did to a Windows child so far. Kept per ChildProcess (not per
 * client) because the client's own reference is dropped on the exit event
 * while termination may still be unconfirmed.
 */
interface AcpWindowsKillRecord {
  /** Set before the first signal the client itself sends to the root. */
  killAttempted: boolean
  /**
   * Direct children of the root, snapshotted before the root was killed on
   * its own. `null` when the snapshot failed: the tree is then unknown and a
   * retry can never confirm it — that is the honest outcome.
   */
  descendants: WindowsProcessRecord[] | null
}

const windowsKillRecords = new WeakMap<
  ChildProcessWithoutNullStreams,
  AcpWindowsKillRecord
>()

/** Inspection seam for tests: the kill record for a child, if any. */
export function acpWindowsKillRecord(child: ChildProcessWithoutNullStreams): {
  readonly killAttempted: boolean
  readonly descendants: ReadonlyArray<WindowsProcessRecord> | null
} | null {
  const record = windowsKillRecords.get(child)
  return record
    ? { killAttempted: record.killAttempted, descendants: record.descendants }
    : null
}

function unconfirmedTreeError(
  message: string,
  pid: number,
  cause?: unknown
): Error {
  return Object.assign(
    new Error(
      `ACP Windows process-tree termination could not be confirmed: ${message}`
    ),
    {
      code: "ACP_PROCESS_TREE_UNCONFIRMED",
      pid,
      ...(cause !== undefined ? { cause } : {}),
    }
  )
}

export async function terminateAcpChildProcess(
  child: ChildProcessWithoutNullStreams,
  deps: AcpChildTerminationDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  const rootExited = () => child.exitCode !== null || child.signalCode !== null
  if (platform === "win32" && child.pid != null) {
    const pid = child.pid
    const record = windowsKillRecords.get(child)
    if (rootExited()) {
      // Only a child that exited before any kill attempt counts as gone on
      // its own. A root we signalled ourselves is a cmd.exe shim for
      // non-.exe commands: its exit says nothing about the agent under it,
      // so a retry has to finish the recorded descendants instead.
      if (!record?.killAttempted) return
      await finishRecordedDescendants(child, pid, record, deps)
      return
    }
    // taskkill /T /F reaps the whole tree — but it can fail (access denied,
    // PID race) or hang outright. Run it through the shared bounded runner
    // (sanitized env, timeout) and then verify the root actually exited.
    let taskkillFailure: unknown = null
    try {
      await (deps.runTaskkill ?? runProviderWindowsTaskkill)(pid)
    } catch (error) {
      taskkillFailure = error
      logger.warn(
        { err: error, pid },
        "acp taskkill failed; the agent process tree may survive"
      )
    }
    if (taskkillFailure === null) {
      // taskkill reaped the tree; the root's exit event just arrives async.
      if (await waitForChildExit(child, deps.taskkillExitGraceMs ?? 2_000)) {
        windowsKillRecords.delete(child)
        return
      }
      // A direct SIGKILL of the root can only hurry what taskkill already
      // did — but it is still a kill of the shim, so record what was under
      // it first: if the root only exits after our grace, the next retry
      // must not take that exit as confirmation.
      await recordKillAttempt(child, pid, deps)
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      if (await waitForChildExit(child, deps.killGraceMs ?? 2_000)) {
        await finishRecordedDescendants(
          child,
          pid,
          windowsKillRecords.get(child) ?? {
            killAttempted: true,
            descendants: null,
          },
          deps
        )
        return
      }
      throw unconfirmedTreeError(
        "taskkill succeeded but the root process did not exit.",
        pid
      )
    }
    // taskkill failed. For a non-`.exe` command `child.pid` is the cmd.exe
    // shim, so a SIGKILL of it orphans the real agent instead of ending it.
    // Snapshot the shim's children first so a retry can finish them, then
    // send it anyway — closing the pipes is the one lever left and most
    // agents exit on stdin EOF — but never report success here: the caller
    // keeps the handle quarantined and retries on its next start/stop.
    await recordKillAttempt(child, pid, deps)
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    const rootGone = await waitForChildExit(child, deps.killGraceMs ?? 2_000)
    throw unconfirmedTreeError(
      rootGone
        ? "taskkill failed and only the root process (a cmd.exe shim for non-.exe commands) was killed; its recorded descendants are finished on the next retry."
        : "taskkill failed and the root process did not exit.",
      pid,
      taskkillFailure
    )
  }

  if (child.pid) {
    await ensureAcpPosixProcessGroupTerminated(child.pid)
  } else if (!rootExited()) {
    child.kill("SIGTERM")
  }
  if (rootExited() || (await waitForChildExit(child, 3_000))) return
  try {
    child.kill("SIGKILL")
  } catch {
    // The root may have exited between the liveness check and the signal.
  }
  if (!(await waitForChildExit(child, 2_000))) {
    throw Object.assign(
      new Error("ACP child did not exit after forced termination."),
      { code: "ACP_ROOT_PROCESS_SURVIVED" }
    )
  }
}

/**
 * Marks the first kill the client sends to a Windows root and snapshots the
 * root's direct children beforehand (once). A failed snapshot is kept as
 * `null`: the tree is then unknown and stays unconfirmed on every retry.
 */
async function recordKillAttempt(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  deps: AcpChildTerminationDeps
): Promise<void> {
  const existing = windowsKillRecords.get(child)
  if (existing?.killAttempted) return
  let descendants: WindowsProcessRecord[] | null = null
  try {
    descendants = await (deps.listDescendants ?? listWindowsChildProcesses)(pid)
  } catch (error) {
    logger.warn(
      { err: error, pid },
      "acp could not enumerate the process tree before killing its root; its termination can no longer be confirmed"
    )
  }
  windowsKillRecords.set(child, { killAttempted: true, descendants })
}

/**
 * Retry path for a root we killed ourselves: every recorded descendant must be
 * observed gone (or verified as a reused PID) or be taskkilled here. Success
 * releases the record; anything else throws so the quarantine stays.
 */
async function finishRecordedDescendants(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  record: AcpWindowsKillRecord,
  deps: AcpChildTerminationDeps
): Promise<void> {
  if (record.descendants === null) {
    throw unconfirmedTreeError(
      "the root process was killed before its process tree could be enumerated, so nothing can confirm the agent under it is gone.",
      pid
    )
  }
  const remaining: WindowsProcessRecord[] = []
  const failures: unknown[] = []
  for (const descendant of record.descendants) {
    try {
      const alive = await (deps.probeDescendant ?? windowsProcessStillMatches)(
        descendant
      )
      if (!alive) continue
      await (deps.runTaskkill ?? runProviderWindowsTaskkill)(descendant.pid)
    } catch (error) {
      failures.push(error)
      remaining.push(descendant)
    }
  }
  record.descendants = remaining
  windowsKillRecords.set(child, record)
  if (remaining.length > 0) {
    throw unconfirmedTreeError(
      `${remaining.length} recorded descendant process(es) of the killed root could not be terminated.`,
      pid,
      failures[0]
    )
  }
  windowsKillRecords.delete(child)
}

async function ensureAcpPosixProcessGroupTerminated(
  pid: number
): Promise<void> {
  if (!isAcpPosixProcessGroupAlive(pid)) return
  signalAcpPosixProcessGroup(pid, "SIGTERM")
  if (await waitForAcpPosixProcessGroupExit(pid, 3_000)) return
  signalAcpPosixProcessGroup(pid, "SIGKILL")
  if (await waitForAcpPosixProcessGroupExit(pid, 2_000)) return
  throw Object.assign(new Error(`ACP process group ${pid} survived SIGKILL.`), {
    code: "ACP_PROCESS_GROUP_SURVIVED_SIGKILL",
    pid,
  })
}

function signalAcpPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals
): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function isAcpPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

async function waitForAcpPosixProcessGroupExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    if (!isAcpPosixProcessGroupAlive(pid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return !isAcpPosixProcessGroupAlive(pid)
}

export class AcpJsonRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdin: ChildStdinWriter | null = null
  /** The child `stdin` was built for; guards against a second writer per pipe. */
  private stdinChild: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly notificationHandlers = new Map<
    string,
    Set<NotificationHandler>
  >()
  private nextRequestId = 1
  private closed = false
  private closePromise: Promise<void> | null = null
  /**
   * A child whose termination threw. Kept separately because the exit
   * handler drops `child` — and a root we killed ourselves exits without
   * proving its tree did — so the next close() can retry on it.
   */
  private unconfirmedChild: ChildProcessWithoutNullStreams | null = null
  private serverRequestHandler: ServerRequestHandler | null = null
  private readonly callTimeoutMs: number
  private readonly stdoutLineCap: number
  /** Bounded stderr of the current child, for failure details and logs. */
  private readonly stderrTail = new ProcessStderrTail()
  /** Releases the crash-reaper registration once the tree is confirmed gone. */
  private untrackChild: (() => void) | null = null
  /** Open holds on the silence deadlines; see `holdIdleTimeouts`. */
  private idleHolds = 0

  constructor(private readonly options: AcpJsonRpcClientOptions) {
    super()
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.stdoutLineCap = options.stdoutLineByteCap ?? DEFAULT_STDOUT_LINE_CAP
  }

  /**
   * Pauses every silence-measured call (`resetTimeoutOnActivity`) while the
   * agent waits on one of our answers, such as a permission request or a
   * question parked for the user: its silence then is not a wedge. Releasing
   * the last hold gives those calls their full window back. Each returned
   * release function is effective once; calls with a total-duration deadline
   * are not affected.
   */
  holdIdleTimeouts(): () => void {
    this.idleHolds += 1
    for (const entry of this.pending.values()) {
      if (entry.idleTimeoutMs !== undefined) clearTimeout(entry.timer)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.idleHolds -= 1
      if (this.idleHolds > 0) return
      for (const entry of this.pending.values()) entry.rearm?.()
    }
  }

  isAlive(): boolean {
    return !this.closed && this.child !== null && this.child.exitCode === null
  }

  /** Redacted tail of the agent's stderr; empty when it printed nothing. */
  stderrText(maxChars = 2_000): string {
    return this.stderrTail.isEmpty ? "" : this.stderrTail.tail(maxChars)
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler
  }

  async spawnChild(): Promise<void> {
    if (this.child) return
    const { command, args = [], cwd, env } = this.options
    const spawned = spawnCommandAndArgs(command, args)
    const child = spawn(spawned.command, [...spawned.args], {
      cwd,
      env: sanitizedChildEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: spawned.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams
    // Child and writer are set together, before the first await: `call()`
    // only checks `this.child`, so a caller racing the spawn event used to
    // build a writer of its own and `attachChild` then built a second one
    // over the same pipe (two drain listeners, two queues).
    this.child = child
    this.stdin = this.createStdinWriter(child)

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (error: Error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          child.off("spawn", onSpawn)
          child.off("error", onError)
        }
        child.once("spawn", onSpawn)
        child.once("error", onError)
      })
    } catch (error) {
      // Nothing was started: a later close() must not try to terminate a
      // process that never existed, and isAlive() must not report one.
      if (this.child === child) this.child = null
      this.stdin?.markDead("acp child failed to spawn", { silent: true })
      throw error
    }

    this.untrackChild?.()
    this.untrackChild = trackChildProcessTree(child, "acp agent")
    this.attachChild(child)
  }

  /**
   * Wires stream and lifecycle listeners for a spawned child. Split from
   * `spawnChild` so the listener behaviour can be exercised against a fake
   * child in tests without spawning a process.
   */
  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child
    // Exactly one writer per child. spawnChild built it already; a directly
    // injected child (tests) gets it here, before any write, so an EPIPE from
    // a child that died mid-request never surfaces as an unhandled `error`.
    if (this.stdinChild !== child) this.stdin = this.createStdinWriter(child)

    // An oversized line (a tool_call_update carrying a whole file, say) is
    // skipped and fails only the exchange it belongs to; it no longer kills
    // the agent process mid-turn. A trailing line without newline is flushed
    // when stdout ends.
    const stdout = new NdjsonLineReader(
      this.stdoutLineCap,
      (line) => this.handleLine(line),
      (line) => this.handleOversizedLine(line)
    )
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk))
    child.stdout.on("end", () => stdout.end())

    // The real reason an agent dies is usually printed here. Lines are kept
    // in a bounded tail for failure details and logged at debug level; they
    // never reach the transcript.
    this.stderrTail.clear()
    const recordStderr = (lines: string[]) => {
      for (const line of lines) {
        logger.debug(
          { command: this.options.command, line },
          "acp agent stderr"
        )
        this.emit("stderr", line)
      }
    }
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) =>
      recordStderr(this.stderrTail.push(chunk))
    )
    child.stderr.on("end", () => recordStderr(this.stderrTail.flush()))

    child.on("exit", (code, signal) => {
      this.closed = true
      this.stdin?.markDead(`acp child exited (code=${code} signal=${signal})`)
      // The process is gone; a later close() must not try to terminate it and
      // a late server-request response must not write into a dead pipe.
      if (this.child === child) this.child = null
      const stderr = this.stderrText(1_200)
      if (stderr && code !== 0) {
        logger.warn(
          { command: this.options.command, code, signal, stderr },
          "acp agent exited with an error"
        )
      }
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(
          new Error(
            `acp child exited before responding to ${entry.method} (code=${code} signal=${signal})${
              stderr ? ` stderr=${stderr}` : ""
            }`
          )
        )
        this.pending.delete(id)
      }
      const emitExit = () => this.emit("exit", { code, signal })
      if (process.platform !== "win32" && child.pid != null) {
        void ensureAcpPosixProcessGroupTerminated(child.pid).then(
          () => {
            this.releaseTracking()
            emitExit()
          },
          (error) => {
            this.emit("child-error", error)
            emitExit()
          }
        )
      } else {
        emitExit()
      }
    })

    child.on("error", (error) => this.emit("child-error", error))
  }

  async call<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs?: number,
    options: { readonly resetTimeoutOnActivity?: boolean } = {}
  ): Promise<T> {
    if (!this.child || this.closed) {
      throw new Error(`acp rpc not alive for call ${method}`)
    }
    const id = this.nextRequestId++
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    this.options.protocolLogger?.({ direction: "outgoing", payload: request })
    const effectiveTimeoutMs = timeoutMs ?? this.callTimeoutMs
    const idle = options.resetTimeoutOnActivity === true
    return await new Promise<T>((resolve, reject) => {
      const fire = () => {
        this.pending.delete(id)
        reject(new AcpRpcTimeoutError(method, effectiveTimeoutMs, idle))
      }
      const timer = setTimeout(fire, effectiveTimeoutMs)
      // Started while the agent waits on us: the silence clock stays held
      // until the last hold is released.
      if (idle && this.idleHolds > 0) clearTimeout(timer)
      const rearm = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        if (this.idleHolds > 0) return
        entry.timer = setTimeout(fire, effectiveTimeoutMs)
      }
      this.pending.set(id, {
        method,
        timer,
        ...(idle ? { idleTimeoutMs: effectiveTimeoutMs, rearm } : {}),
        resolve: (value) => resolve(value as T),
        reject,
      })
      if (!this.stdinWriter()?.write(`${JSON.stringify(request)}\n`)) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`acp rpc stdin is closed; cannot send ${method}`))
      }
    })
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.child || this.closed) return
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params }
    this.options.protocolLogger?.({
      direction: "outgoing",
      payload: notification,
    })
    this.stdinWriter()?.write(`${JSON.stringify(notification)}\n`)
  }

  /** Writes a response to a server-initiated request, or logs why it can't. */
  private writeServerResponse(response: JsonRpcResponse, method: string): void {
    this.options.protocolLogger?.({ direction: "outgoing", payload: response })
    const stdin = this.stdinWriter()
    if (!stdin) {
      logger.warn(
        { method, id: response.id },
        "acp rpc server-request response dropped; child already exited"
      )
      return
    }
    if (stdin.write(`${JSON.stringify(response)}\n`)) return
    // The writer refused the reply (backlog bound exceeded, or the pipe died
    // between the check above and the write). The agent is now waiting on an
    // answer that will never arrive, so fail the turn instead of letting it
    // sit out the idle budget with a misleading timeout.
    const refused = new AcpServerResponseRefusedError(method, response.id)
    logger.error(
      { method, id: response.id, pendingBytes: stdin.pendingBytes },
      "acp rpc server-request response refused by the stdin writer; failing the turn"
    )
    this.rejectAllPending(() => refused)
    this.emit("child-error", refused)
  }

  private createStdinWriter(
    child: ChildProcessWithoutNullStreams
  ): ChildStdinWriter {
    this.stdinChild = child
    return new ChildStdinWriter(child.stdin, {
      label: "acp rpc",
      logger,
      onError: (error) => {
        // The pipe is gone but the process may linger without ever exiting:
        // a call waiting on it would otherwise sit out its full timeout (up
        // to the 10-minute prompt idle budget).
        this.rejectAllPending(
          (method) =>
            `acp rpc stdin errored while waiting on ${method}: ${error.message}`
        )
        this.emit("child-error", error)
      },
    })
  }

  private rejectAllPending(failure: (method: string) => string | Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      const reason = failure(entry.method)
      entry.reject(reason instanceof Error ? reason : new Error(reason))
    }
  }

  /**
   * The writer for the live child. Never built lazily for a spawned child —
   * that is done in spawnChild/attachChild — only for a child injected
   * straight into `this.child` by a test, and then once per child.
   */
  private stdinWriter(): ChildStdinWriter | null {
    if (!this.child) return null
    if (this.stdinChild !== this.child) {
      this.stdin = this.createStdinWriter(this.child)
    }
    return this.stdin
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const operation = this.closeInternal()
    this.closePromise = operation
    try {
      await operation
    } finally {
      if (this.closePromise === operation) this.closePromise = null
    }
  }

  private async closeInternal(): Promise<void> {
    if (this.closed && !this.child && !this.unconfirmedChild) return
    this.closed = true
    // A child whose termination threw is retried even after its exit event
    // dropped `this.child`: on Windows that exit may be our own kill of the
    // cmd.exe shim, which proves nothing about the agent under it.
    const child = this.child ?? this.unconfirmedChild
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`acp rpc closed while waiting on ${entry.method}`))
      this.pending.delete(id)
    }
    if (!child) return
    try {
      await (this.options.terminateChildProcess ?? terminateAcpChildProcess)(
        child
      )
    } catch (error) {
      this.unconfirmedChild = child
      throw error
    }
    this.unconfirmedChild = null
    this.releaseTracking()
    if (this.child === child) this.child = null
  }

  private releaseTracking(): void {
    this.untrackChild?.()
    this.untrackChild = null
  }

  /**
   * A line over the cap was skipped. A response fails only its call, a
   * server request is answered with an error so the agent does not wait for
   * a reply forever, and a notification is dropped with a warning.
   */
  private handleOversizedLine(line: OversizedNdjsonLine): void {
    const identity = identifyOversizedLine(line.head)
    const entry =
      identity.id !== null && !identity.method
        ? this.pending.get(identity.id)
        : undefined
    logger.warn(
      {
        bytes: line.bytes,
        cap: this.stdoutLineCap,
        method: identity.method ?? entry?.method ?? null,
        correlated: Boolean(entry),
      },
      "acp rpc line exceeded the stdout cap and was dropped"
    )
    // Still activity: the agent is working, not silent.
    for (const pending of this.pending.values()) pending.rearm?.()
    if (entry && identity.id !== null) {
      this.pending.delete(identity.id)
      clearTimeout(entry.timer)
      entry.reject(
        new Error(
          `acp rpc response for ${entry.method} exceeded the ${this.stdoutLineCap}-byte line cap and was discarded`
        )
      )
      return
    }
    if (identity.id !== null && identity.method) {
      this.writeServerResponse(
        {
          jsonrpc: "2.0",
          id: identity.id,
          error: {
            code: -32600,
            message: `Request exceeded the client's ${this.stdoutLineCap}-byte line limit.`,
          },
        },
        identity.method
      )
    }
  }

  private handleLine(line: string): void {
    if (!line) return
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      message = parsed as Record<string, unknown>
    } catch {
      // Agents print the occasional banner on stdout; keep a trace of it
      // instead of dropping it silently (the Codex client already does).
      logger.debug(
        { bytes: line.length, preview: line.slice(0, 200) },
        "acp rpc line was not valid JSON"
      )
      return
    }
    if (
      message.id != null &&
      typeof message.id !== "string" &&
      !(typeof message.id === "number" && Number.isFinite(message.id))
    )
      return
    this.options.protocolLogger?.({ direction: "incoming", payload: message })

    // Any inbound traffic — a stream chunk, a permission request, anything —
    // proves the agent is still working. Long-running calls measure silence,
    // not wall clock, so they get their full window back here.
    for (const entry of this.pending.values()) entry.rearm?.()

    const hasId = message.id !== undefined && message.id !== null
    const method = typeof message.method === "string" ? message.method : null

    if (hasId && method) {
      const id = message.id as number | string
      const respond = (result: unknown) => {
        this.writeServerResponse({ jsonrpc: "2.0", id, result }, method)
      }
      const respondError = (
        code: number,
        errorMessage: string,
        data?: unknown
      ) => {
        this.writeServerResponse(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code,
              message: errorMessage,
              ...(data !== undefined ? { data } : {}),
            },
          },
          method
        )
      }
      if (!this.serverRequestHandler) {
        respondError(-32601, `No handler registered for ${method}`)
        return
      }
      this.serverRequestHandler(
        method,
        message.params ?? {},
        respond,
        respondError
      )
      return
    }

    if (hasId) {
      const id = message.id as number | string
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = message.error as { code?: number; message?: string }
        pending.reject(
          new Error(
            `acp rpc error ${error.code ?? ""}: ${error.message ?? "unknown"}`
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (method) {
      dispatchNdjsonNotification(
        this.notificationHandlers,
        method,
        message.params ?? {},
        "acp rpc"
      )
    }
  }
}
