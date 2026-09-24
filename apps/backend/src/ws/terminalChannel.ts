import { Buffer } from "node:buffer"
import {
  TERMINAL_CHANNELS,
  TERMINAL_LIMITS,
  TERMINAL_METHODS,
  terminalAckParamsSchema,
  terminalAttachParamsSchema,
  terminalCloseParamsSchema,
  terminalOpenParamsSchema,
  terminalResizeParamsSchema,
  terminalWriteParamsSchema,
  type TerminalClosedReason,
  type TerminalSummary,
} from "@betterc0de/schema/remote-terminal"
import type { z } from "zod"
import type { AppState } from "../appState"
import { HttpError } from "../errors"
import {
  acquireCheckpointRecoveryMutationLease,
  withCheckpointRecoveryMutation,
} from "../http/checkpointRecoveryFence"
import { remoteTerminalRefusalFor } from "../http/remoteTerminalPolicy"
import { logger } from "../observability/logger"
import {
  closeTerminalPtySession,
  openTerminalPtySession,
  readTerminalPtySession,
  resizeTerminalPtySession,
  subscribeTerminalPtySession,
  writeTerminalPtySession,
  type TerminalPtyEvent,
} from "../services/terminalPty"
import { getProjectShell } from "../services/workspace"
import { resolveApprovedWorkspaceRoot } from "../services/workspace/authorization"
import type { WsConnection, WsPrincipal, WsRemotePrincipal } from "./server"

/** Output goes out at most this often, */
const FLUSH_MS = 16
/** in frames of whole events up to about this size (one event can be larger). */
const FRAME_BYTES = 32 * 1024
/** A socket with more queued than this gets time before more output. */
const SOCKET_PAUSE_BYTES = 512 * 1024
const SOCKET_RETRY_MS = 50

const METHODS = new Set<string>(Object.values(TERMINAL_METHODS))

/** What a terminal starts: a shell by name, or a command. */
export interface TerminalLaunch {
  readonly shell?: string
  readonly command?: string
  readonly args?: readonly string[]
}

export interface RemoteTerminalChannelOptions {
  readonly state: AppState
  /** `remote_access_allow_terminal`, read on every call. */
  readonly terminalGranted: () => boolean
  /** How long a terminal no device is attached to keeps running. */
  readonly detachedMs?: number
  /** What to start in a workspace: the project's shell unless a test says otherwise. */
  readonly launch?: (cwd: string) => Promise<TerminalLaunch> | TerminalLaunch
}

async function projectShell(cwd: string): Promise<TerminalLaunch> {
  return { shell: await getProjectShell(cwd).catch(() => undefined) }
}

interface Attachment {
  readonly connection: WsConnection
  readonly stopListening: () => void
  /** The last `seq` sent or announced as a gap. */
  sentSeq: number
  /** Output sent and not acknowledged yet, oldest first. */
  readonly inFlight: Array<{ seq: number; bytes: number }>
  unackedBytes: number
  flushTimer: NodeJS.Timeout | null
}

interface RemoteTerminal {
  readonly id: string
  /** The paired device's session. */
  readonly sessionId: string
  /** How the PTY service knows the device (the shell routes use the same). */
  readonly ownerId: string
  readonly cwd: string
  readonly shell: string
  readonly openedAt: string
  status: "running" | "exited"
  nextInputSeq: number
  /** Writes are applied one after the other, in the order they came in. */
  writeTail: Promise<unknown>
  attachment: Attachment | null
  detachedTimer: NodeJS.Timeout | null
  unsubscribe: (() => void) | null
}

/**
 * Terminals on this desktop for paired devices, over the WebSocket
 * (@betterc0de/schema/remote-terminal). A terminal belongs to the device
 * that opened it; one connection of the device at a time gets its output,
 * and a terminal no connection is attached to ends after `detachedMs`. The
 * PTY service keeps the output (services/terminalPty.ts); this channel
 * sends it on, as fast as the device acknowledges it.
 */
export class RemoteTerminalChannel {
  private readonly terminals = new Map<string, RemoteTerminal>()
  private readonly detachedMs: number

  constructor(private readonly options: RemoteTerminalChannelOptions) {
    this.detachedMs = options.detachedMs ?? TERMINAL_LIMITS.detachedMs
  }

  /** Whether `method` is one of the terminal's. */
  static handles(method: string): boolean {
    return METHODS.has(method)
  }

  async handle(
    method: string,
    params: unknown,
    principal: WsPrincipal,
    connection: WsConnection
  ): Promise<unknown> {
    const device = this.authorize(principal)
    switch (method) {
      case TERMINAL_METHODS.open:
        return await this.open(
          device,
          parse(terminalOpenParamsSchema, params),
          connection
        )
      case TERMINAL_METHODS.attach: {
        const { terminalId, afterSeq } = parse(
          terminalAttachParamsSchema,
          params
        )
        const terminal = this.owned(device, terminalId)
        this.attach(terminal, connection, afterSeq)
        return this.summary(terminal)
      }
      case TERMINAL_METHODS.write:
        return await this.write(
          device,
          parse(terminalWriteParamsSchema, params)
        )
      case TERMINAL_METHODS.resize: {
        const { terminalId, cols, rows } = parse(
          terminalResizeParamsSchema,
          params
        )
        const terminal = this.owned(device, terminalId)
        if (
          !resizeTerminalPtySession(terminal.id, cols, rows, terminal.ownerId)
        )
          throw ended()
        return { ok: true }
      }
      case TERMINAL_METHODS.ack: {
        const { terminalId, seq } = parse(terminalAckParamsSchema, params)
        this.acknowledge(this.owned(device, terminalId), seq)
        return { ok: true }
      }
      case TERMINAL_METHODS.close: {
        const { terminalId } = parse(terminalCloseParamsSchema, params)
        this.end(this.owned(device, terminalId), "closed")
        return { ok: true }
      }
      case TERMINAL_METHODS.list:
        return {
          terminals: [...this.terminals.values()]
            .filter((terminal) => terminal.sessionId === device.sessionId)
            .filter((terminal) => this.refresh(terminal))
            .map((terminal) => this.summary(terminal)),
        }
      default:
        throw new HttpError(404, "Unknown terminal method.", "unknown_method")
    }
  }

  /**
   * The desktop took terminals from paired devices away: each device hears
   * why, and every terminal ends.
   */
  endAll(reason: TerminalClosedReason): void {
    for (const terminal of [...this.terminals.values()]) {
      this.end(terminal, reason)
    }
  }

  /**
   * Revoked sessions: their connections are closed already and their
   * processes end with the session (bootstrap/settings.ts); only the
   * records go.
   */
  forgetSessions(sessionIds: readonly string[]): void {
    const revoked = new Set(sessionIds)
    for (const terminal of [...this.terminals.values()]) {
      if (revoked.has(terminal.sessionId)) this.forget(terminal)
    }
  }

  /** Running terminals of a device (for the desktop's list of devices). */
  count(sessionId: string): number {
    let count = 0
    for (const terminal of this.terminals.values()) {
      if (terminal.sessionId === sessionId && terminal.status === "running")
        count += 1
    }
    return count
  }

  dispose(): void {
    for (const terminal of [...this.terminals.values()]) this.forget(terminal)
  }

  private authorize(principal: WsPrincipal): WsRemotePrincipal {
    // The desktop's renderer opens its terminals over HTTP, where each open
    // and each keystroke needs a capability only the desktop's main process
    // can mint: this channel must not be a way around that.
    if (principal.kind !== "remote") {
      throw new HttpError(
        403,
        "Terminals over the WebSocket are for paired devices.",
        "remote_terminal_only"
      )
    }
    const refusal = remoteTerminalRefusalFor({
      granted: this.options.terminalGranted(),
      fullSession: principal.accessLevel === "full",
    })
    if (refusal) throw new HttpError(403, refusal.error, refusal.code)
    return principal
  }

  private async open(
    device: WsRemotePrincipal,
    params: z.infer<typeof terminalOpenParamsSchema>,
    connection: WsConnection
  ): Promise<TerminalSummary> {
    const { state } = this.options
    const cwd = await resolveApprovedWorkspaceRoot(state, params.cwd)
    const launch = await (this.options.launch ?? projectShell)(cwd)
    const ownerId = `remote:${device.sessionId}`
    // Held while the shell runs, as for the desktop's own terminals: a
    // checkpoint restore waits for it rather than rewriting files under it.
    const lease = await acquireCheckpointRecoveryMutationLease(state, {
      workspaces: [cwd],
    })
    let opened: ReturnType<typeof openTerminalPtySession>
    try {
      opened = openTerminalPtySession({
        ownerId,
        ownerExpiresAt: device.expiresAt,
        cwd,
        shell: launch.shell,
        command: launch.command,
        args: launch.args,
        cols: params.cols,
        rows: params.rows,
        onProcessExit: () => lease?.release(),
        onProcessTreeFailure: (error) =>
          state.taintBackend?.(error, "remote terminal process tree"),
      })
    } catch (error) {
      lease?.release()
      throw openRefusal(error)
    }
    const terminal: RemoteTerminal = {
      id: opened.sessionId,
      sessionId: device.sessionId,
      ownerId,
      cwd: opened.cwd,
      shell: opened.shell,
      openedAt: new Date().toISOString(),
      status: "running",
      nextInputSeq: 1,
      writeTail: Promise.resolve(),
      attachment: null,
      detachedTimer: null,
      unsubscribe: null,
    }
    this.terminals.set(terminal.id, terminal)
    terminal.unsubscribe = subscribeTerminalPtySession(
      terminal.id,
      (event) => this.onEvent(terminal, event),
      ownerId
    )
    this.attach(terminal, connection, 0)
    // Who opened what, where: never what was typed or shown.
    logger.info(
      { terminalId: terminal.id, sessionId: device.sessionId, cwd },
      "remote terminal opened"
    )
    return this.summary(terminal)
  }

  private write(
    device: WsRemotePrincipal,
    params: z.infer<typeof terminalWriteParamsSchema>
  ): Promise<{ applied: boolean }> {
    const terminal = this.owned(device, params.terminalId)
    if (
      Buffer.byteLength(params.data, "utf8") > TERMINAL_LIMITS.maxWriteBytes
    ) {
      throw new HttpError(
        413,
        `One write carries at most ${TERMINAL_LIMITS.maxWriteBytes} bytes.`,
        "terminal_input_too_large"
      )
    }
    // Queued before anything is awaited, so writes apply in the order the
    // device sent them even when it did not wait for the answers.
    const applied = terminal.writeTail.then(() =>
      withCheckpointRecoveryMutation(
        this.options.state,
        { workspaces: [terminal.cwd] },
        () => {
          if (params.inputSeq < terminal.nextInputSeq) return { applied: false }
          if (params.inputSeq > terminal.nextInputSeq) {
            throw new HttpError(
              409,
              `Input ${params.inputSeq} came before input ${terminal.nextInputSeq}.`,
              "terminal_input_gap"
            )
          }
          if (
            !writeTerminalPtySession(terminal.id, params.data, terminal.ownerId)
          )
            throw ended()
          terminal.nextInputSeq += 1
          return { applied: true }
        }
      )
    )
    terminal.writeTail = applied.catch(() => undefined)
    return applied
  }

  /** The device's terminal, or not found: another device's reads the same. */
  private owned(device: WsRemotePrincipal, terminalId: string): RemoteTerminal {
    const terminal = this.terminals.get(terminalId)
    if (
      !terminal ||
      terminal.sessionId !== device.sessionId ||
      !this.refresh(terminal)
    ) {
      throw new HttpError(404, "Terminal not found.", "terminal_not_found")
    }
    return terminal
  }

  /** Brings the record up to date; false (and forgotten) once the PTY is gone. */
  private refresh(terminal: RemoteTerminal): boolean {
    const snapshot = readTerminalPtySession(
      terminal.id,
      Number.MAX_SAFE_INTEGER,
      terminal.ownerId
    )
    if (!snapshot) {
      this.forget(terminal)
      return false
    }
    if (snapshot.status !== "running") terminal.status = "exited"
    return true
  }

  private summary(terminal: RemoteTerminal): TerminalSummary {
    return {
      terminalId: terminal.id,
      cwd: terminal.cwd,
      shell: terminal.shell,
      status: terminal.status,
      openedAt: terminal.openedAt,
      nextInputSeq: terminal.nextInputSeq,
    }
  }

  private attach(
    terminal: RemoteTerminal,
    connection: WsConnection,
    afterSeq: number
  ): void {
    // One connection at a time: a device that reconnected takes over.
    this.detach(terminal, false)
    if (terminal.detachedTimer) {
      clearTimeout(terminal.detachedTimer)
      terminal.detachedTimer = null
    }
    const lastSeq =
      readTerminalPtySession(terminal.id, afterSeq, terminal.ownerId)
        ?.lastSeq ?? 0
    const attachment: Attachment = {
      connection,
      stopListening: connection.onClose(() => {
        if (terminal.attachment === attachment) this.detach(terminal, true)
      }),
      sentSeq: Math.min(afterSeq, lastSeq),
      inFlight: [],
      unackedBytes: 0,
      flushTimer: null,
    }
    terminal.attachment = attachment
    this.scheduleFlush(terminal, 0)
  }

  private detach(terminal: RemoteTerminal, startTimer: boolean): void {
    const attachment = terminal.attachment
    if (attachment) {
      attachment.stopListening()
      if (attachment.flushTimer) clearTimeout(attachment.flushTimer)
      attachment.flushTimer = null
      terminal.attachment = null
    }
    if (
      startTimer &&
      !terminal.detachedTimer &&
      this.terminals.get(terminal.id) === terminal
    ) {
      terminal.detachedTimer = setTimeout(() => {
        terminal.detachedTimer = null
        this.end(terminal, "detached")
      }, this.detachedMs)
      terminal.detachedTimer.unref?.()
    }
  }

  private acknowledge(terminal: RemoteTerminal, seq: number): void {
    const attachment = terminal.attachment
    if (!attachment) return
    while (
      attachment.inFlight.length > 0 &&
      attachment.inFlight[0]!.seq <= seq
    ) {
      attachment.unackedBytes -= attachment.inFlight.shift()!.bytes
    }
    this.scheduleFlush(terminal, 0)
  }

  private onEvent(terminal: RemoteTerminal, event: TerminalPtyEvent): void {
    if (event.type === "exit") terminal.status = "exited"
    this.scheduleFlush(terminal, FLUSH_MS)
  }

  private scheduleFlush(terminal: RemoteTerminal, delayMs: number): void {
    const attachment = terminal.attachment
    if (!attachment || attachment.flushTimer) return
    attachment.flushTimer = setTimeout(() => {
      attachment.flushTimer = null
      this.flush(terminal)
    }, delayMs)
    attachment.flushTimer.unref?.()
  }

  /** Sends what the device has not had, as far as it has acknowledged. */
  private flush(terminal: RemoteTerminal): void {
    const attachment = terminal.attachment
    if (!attachment) return
    const { connection } = attachment
    if (!connection.isOpen()) {
      this.detach(terminal, true)
      return
    }
    if (connection.bufferedAmount() > SOCKET_PAUSE_BYTES) {
      this.scheduleFlush(terminal, SOCKET_RETRY_MS)
      return
    }
    const snapshot = readTerminalPtySession(
      terminal.id,
      attachment.sentSeq,
      terminal.ownerId
    )
    if (!snapshot) {
      this.forget(terminal)
      return
    }
    const terminalId = terminal.id
    // The buffer dropped output before it could be sent: say so.
    const firstKept = snapshot.events[0]?.seq ?? snapshot.lastSeq + 1
    if (firstKept > attachment.sentSeq + 1) {
      connection.send({
        channel: TERMINAL_CHANNELS.gap,
        data: {
          terminalId,
          fromSeq: attachment.sentSeq + 1,
          toSeq: firstKept - 1,
        },
      })
      attachment.sentSeq = firstKept - 1
    }
    let output = ""
    let outputBytes = 0
    let seq = attachment.sentSeq
    const sendOutput = () => {
      if (output) {
        connection.send({
          channel: TERMINAL_CHANNELS.output,
          data: { terminalId, seq, output },
        })
        attachment.inFlight.push({ seq, bytes: outputBytes })
        attachment.unackedBytes += outputBytes
      }
      attachment.sentSeq = seq
      output = ""
      outputBytes = 0
    }
    for (const event of snapshot.events) {
      // The rest waits for the device's acknowledgement.
      if (attachment.unackedBytes + outputBytes >= TERMINAL_LIMITS.unackedBytes)
        break
      if (event.type === "data") {
        const bytes = Buffer.byteLength(event.data ?? "", "utf8")
        if (outputBytes > 0 && outputBytes + bytes > FRAME_BYTES) sendOutput()
        output += event.data ?? ""
        outputBytes += bytes
        seq = event.seq
      } else if (event.type === "exit") {
        sendOutput()
        seq = event.seq
        connection.send({
          channel: TERMINAL_CHANNELS.exit,
          data: {
            terminalId,
            seq,
            exitCode: event.exitCode ?? null,
            signal: event.signal ?? null,
          },
        })
        attachment.sentSeq = seq
        terminal.status = "exited"
      } else {
        // A note of the service's (the command it started, a failed
        // cleanup): counted, not shown.
        seq = event.seq
      }
    }
    sendOutput()
  }

  /** Ends a terminal for good: its device hears why, and its process ends. */
  private end(terminal: RemoteTerminal, reason: TerminalClosedReason): void {
    if (this.terminals.get(terminal.id) !== terminal) return
    const attachment = terminal.attachment
    if (attachment?.connection.isOpen()) {
      attachment.connection.send({
        channel: TERMINAL_CHANNELS.closed,
        data: { terminalId: terminal.id, reason },
      })
    }
    this.forget(terminal)
    closeTerminalPtySession(terminal.id, terminal.ownerId)
    logger.info(
      { terminalId: terminal.id, sessionId: terminal.sessionId, reason },
      "remote terminal closed"
    )
  }

  private forget(terminal: RemoteTerminal): void {
    if (this.terminals.get(terminal.id) !== terminal) return
    this.terminals.delete(terminal.id)
    terminal.unsubscribe?.()
    terminal.unsubscribe = null
    this.detach(terminal, false)
    if (terminal.detachedTimer) clearTimeout(terminal.detachedTimer)
    terminal.detachedTimer = null
  }
}

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const result = schema.safeParse(params)
  if (!result.success) {
    throw new HttpError(400, "Invalid terminal request.", "invalid_params")
  }
  return result.data
}

function ended(): HttpError {
  return new HttpError(409, "The terminal has ended.", "terminal_exited")
}

/** The PTY service's refusals, with a code the device can act on. */
function openRefusal(error: unknown): unknown {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (statusCode === 429) {
    return new HttpError(
      429,
      "Too many terminals are open. Close one first.",
      "terminal_limit"
    )
  }
  if (statusCode === 503) {
    return new HttpError(503, "The desktop is shutting down.", "shutting_down")
  }
  return error
}
