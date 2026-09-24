import {
  TERMINAL_CHANNELS,
  TERMINAL_LIMITS,
  TERMINAL_METHODS,
  terminalFrameSchema,
  terminalSummarySchema,
  terminalWriteResultSchema,
  type TerminalClosedReason,
  type TerminalSummary,
} from "@betterc0de/schema/remote-terminal"

/** A call over the desktop's stream (`RemoteChannel.call`). */
export type TerminalCall = (method: string, params: unknown) => Promise<unknown>

export interface TerminalClientEvents {
  /** Output to show: each piece once, in order. */
  output(text: string): void
  /** Output the desktop could not keep until the phone took it. */
  gap(): void
  exit(exitCode: number | null): void
  /** The terminal is gone for this phone, and why. */
  closed(reason: TerminalClosedReason): void
  /** Input the desktop refused for good (the terminal is gone or off). */
  failed(error: unknown): void
}

/** Writes on their way at once (the desktop takes 32 calls at a time). */
const WRITES_IN_FLIGHT = 8
/** Output is acknowledged once this much came in, */
const ACK_AFTER_CHARS = 64 * 1024
/** or once no more came for this long. */
const ACK_DELAY_MS = 100
/** How soon a write that got no answer is sent again. */
const RETRY_MS = 1_000

interface Write {
  readonly inputSeq: number
  readonly data: string
  /** Sent over the current connection and not answered yet. */
  onWire: boolean
  /** Counts the sends: an old connection's failure concerns its own. */
  attempt: number
}

/** Errors that end the terminal for this phone: nothing to resend. */
const FINAL_CODES = new Set([
  "terminal_not_found",
  "terminal_exited",
  "remote_terminal_disabled",
  "remote_terminal_only",
  "remote_read_only",
  "REMOTE_READ_ONLY",
])

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : undefined
}

/**
 * The phone's side of one terminal on the desktop
 * (@betterc0de/schema/remote-terminal), whatever carries the calls and
 * frames (the WebSocket, or the demo).
 *
 * Input is numbered in the order it is sent. A write the desktop did not
 * answer is sent again with its number after a reconnect, and the desktop
 * applies each number once. Output is shown once per `seq`, a gap the
 * desktop announces as one, and what was shown is acknowledged so the
 * desktop sends on.
 */
export class TerminalClient {
  private terminalId: string | null = null
  private lastSeq = 0
  private charsSinceAck = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private nextInputSeq = 1
  /** Typed and not numbered yet. */
  private unsent = ""
  /** Numbered and not answered, oldest first. */
  private writes: Write[] = []
  private attached = false
  private ended = false

  constructor(
    private readonly call: TerminalCall,
    private readonly events: TerminalClientEvents
  ) {}

  get id(): string | null {
    return this.terminalId
  }

  get isEnded(): boolean {
    return this.ended
  }

  async open(
    cwd: string,
    cols: number,
    rows: number
  ): Promise<TerminalSummary> {
    const summary = terminalSummarySchema.parse(
      await this.call(TERMINAL_METHODS.open, { cwd, cols, rows })
    )
    this.terminalId = summary.terminalId
    this.nextInputSeq = summary.nextInputSeq
    this.attached = true
    this.pump()
    return summary
  }

  /**
   * Takes the terminal up again on a new connection: output after what was
   * shown, and the input the desktop has not applied, sent again.
   */
  async attach(): Promise<TerminalSummary> {
    const terminalId = this.requireId()
    this.detached()
    const summary = terminalSummarySchema.parse(
      await this.call(TERMINAL_METHODS.attach, {
        terminalId,
        afterSeq: this.lastSeq,
      })
    )
    // The desktop's next number says what it already applied.
    this.writes = this.writes.filter(
      (write) => write.inputSeq >= summary.nextInputSeq
    )
    this.attached = true
    this.pump()
    return summary
  }

  /** The connection went: what was on its way waits for `attach()`. */
  detached(): void {
    this.attached = false
    for (const write of this.writes) write.onWire = false
  }

  write(data: string): void {
    if (this.ended || !data) return
    this.unsent += data
    this.pump()
  }

  resize(cols: number, rows: number): Promise<void> {
    const terminalId = this.terminalId
    if (!terminalId || this.ended) return Promise.resolve()
    return this.call(TERMINAL_METHODS.resize, { terminalId, cols, rows }).then(
      () => undefined
    )
  }

  /** Ends the terminal on the desktop. */
  async close(): Promise<void> {
    const terminalId = this.terminalId
    this.stop()
    if (terminalId) {
      await this.call(TERMINAL_METHODS.close, { terminalId })
    }
  }

  /** Stops acknowledging and resending (the screen went away). */
  stop(): void {
    this.ended = true
    this.attached = false
    if (this.ackTimer) clearTimeout(this.ackTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ackTimer = null
    this.retryTimer = null
  }

  /** A frame from the desktop's stream; true when it was this terminal's. */
  receive(frame: unknown): boolean {
    const parsed = terminalFrameSchema.safeParse(frame)
    if (!parsed.success) return false
    const message = parsed.data
    if (!this.terminalId || message.data.terminalId !== this.terminalId)
      return false
    switch (message.channel) {
      case TERMINAL_CHANNELS.output:
        // Sent again after a reconnect: shown already.
        if (message.data.seq <= this.lastSeq) return true
        this.lastSeq = message.data.seq
        this.events.output(message.data.output)
        this.shown(message.data.output.length)
        return true
      case TERMINAL_CHANNELS.gap:
        if (message.data.toSeq <= this.lastSeq) return true
        this.lastSeq = message.data.toSeq
        this.events.gap()
        return true
      case TERMINAL_CHANNELS.exit:
        if (message.data.seq <= this.lastSeq) return true
        this.lastSeq = message.data.seq
        this.events.exit(message.data.exitCode)
        return true
      case TERMINAL_CHANNELS.closed:
        this.stop()
        this.events.closed(message.data.reason)
        return true
    }
  }

  private requireId(): string {
    if (!this.terminalId) throw new Error("The terminal is not open yet.")
    return this.terminalId
  }

  private shown(chars: number): void {
    this.charsSinceAck += chars
    if (this.charsSinceAck >= ACK_AFTER_CHARS) {
      this.acknowledge()
      return
    }
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = setTimeout(() => this.acknowledge(), ACK_DELAY_MS)
  }

  private acknowledge(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    this.charsSinceAck = 0
    const terminalId = this.terminalId
    if (!terminalId || this.ended) return
    // A lost acknowledgement is made up for by the next one.
    this.call(TERMINAL_METHODS.ack, { terminalId, seq: this.lastSeq }).catch(
      () => undefined
    )
  }

  /** Sends what waits: writes to send again first, then new input. */
  private pump(): void {
    const terminalId = this.terminalId
    if (!terminalId || !this.attached || this.ended) return
    let onWire = this.writes.filter((write) => write.onWire).length
    for (const write of this.writes) {
      if (onWire >= WRITES_IN_FLIGHT) return
      if (write.onWire) continue
      this.send(terminalId, write)
      onWire += 1
    }
    while (this.unsent && onWire < WRITES_IN_FLIGHT) {
      const data = takeChunk(this.unsent)
      this.unsent = this.unsent.slice(data.length)
      const write: Write = {
        inputSeq: this.nextInputSeq,
        data,
        onWire: false,
        attempt: 0,
      }
      this.nextInputSeq += 1
      this.writes.push(write)
      this.send(terminalId, write)
      onWire += 1
    }
  }

  private send(terminalId: string, write: Write): void {
    write.onWire = true
    write.attempt += 1
    const attempt = write.attempt
    this.call(TERMINAL_METHODS.write, {
      terminalId,
      inputSeq: write.inputSeq,
      data: write.data,
    }).then(
      (result) => {
        terminalWriteResultSchema.parse(result)
        this.writes = this.writes.filter((other) => other !== write)
        this.pump()
      },
      (error: unknown) => {
        if (!this.writes.includes(write) || write.attempt !== attempt) return
        write.onWire = false
        const code = codeOf(error)
        if (code && FINAL_CODES.has(code)) {
          this.stop()
          this.events.failed(error)
          return
        }
        // Lost, late or out of turn: sent again, with the same number.
        if (code !== "connection_lost" && !this.retryTimer && !this.ended) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.pump()
          }, RETRY_MS)
        }
      }
    )
  }
}

/** The UTF-8 length of one character (a code point). */
function utf8Length(character: string): number {
  const code = character.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  return code < 0x10000 ? 3 : 4
}

/** Up to one write's worth of input, without splitting a character in two. */
export function takeChunk(input: string): string {
  if (input.length * 3 <= TERMINAL_LIMITS.maxWriteBytes) return input
  let chunk = ""
  let bytes = 0
  for (const character of input) {
    const size = utf8Length(character)
    if (bytes + size > TERMINAL_LIMITS.maxWriteBytes) break
    chunk += character
    bytes += size
  }
  return chunk
}
