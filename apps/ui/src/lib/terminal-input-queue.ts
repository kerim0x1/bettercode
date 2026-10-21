import { takeTerminalInputChunk } from "@/lib/terminal-protocol"

/** One write carries at most this much (the PTY write route's limit). */
export const TERMINAL_WRITE_MAX_CHARS = 64 * 1024
/** Input waiting beyond this is refused (a paste far larger than a terminal takes). */
export const TERMINAL_INPUT_BACKLOG_MAX_CHARS = 4 * 1024 * 1024
const MAX_RETRIES = 20

export interface TerminalInputQueueOptions {
  /** Delivers one write; rejects when it was not applied. */
  readonly send: (data: string) => Promise<unknown>
  /** A write landed: time to read the echo. */
  readonly onSent?: () => void
  /** Input that can't be delivered any more; the queue is empty again. */
  readonly onFailed: (error: unknown) => void
  readonly isRetryable: (error: unknown) => boolean
  readonly maxChunkChars?: number
  readonly maxBacklogChars?: number
  readonly retryDelayMs?: (attempt: number) => number
}

/**
 * The keyboard's way to a terminal on the backend. Each write needs its
 * own capability and request, so one write is on its way at a time and
 * whatever is typed meanwhile goes out together with the next one, in the
 * order it was typed. A write refused for a passing reason (rate limit,
 * timeout, the backend restarting) is sent again before anything typed
 * after it.
 */
export class TerminalInputQueue {
  private pending = ""
  private sending = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private disposed = false
  private readonly options: TerminalInputQueueOptions

  constructor(options: TerminalInputQueueOptions) {
    this.options = options
  }

  /** Characters typed and not delivered yet. */
  get backlog(): number {
    return this.pending.length
  }

  /** False when the input was refused: the queue is closed or full. */
  push(data: string): boolean {
    if (this.disposed || !data) return false
    const max = this.options.maxBacklogChars ?? TERMINAL_INPUT_BACKLOG_MAX_CHARS
    if (this.pending.length + data.length > max) return false
    this.pending += data
    this.pump()
    return true
  }

  dispose(): void {
    this.disposed = true
    this.pending = ""
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private pump(): void {
    if (this.disposed || this.sending || this.retryTimer || !this.pending) {
      return
    }
    const chunk = takeTerminalInputChunk(
      this.pending,
      this.options.maxChunkChars ?? TERMINAL_WRITE_MAX_CHARS
    )
    this.pending = this.pending.slice(chunk.length)
    this.sending = true
    this.options.send(chunk).then(
      () => {
        this.sending = false
        this.attempts = 0
        if (this.disposed) return
        this.options.onSent?.()
        this.pump()
      },
      (error: unknown) => {
        this.sending = false
        if (this.disposed) return
        if (this.options.isRetryable(error) && this.attempts < MAX_RETRIES) {
          this.attempts += 1
          // Ahead of anything typed since, so the order holds.
          this.pending = chunk + this.pending
          const delay =
            this.options.retryDelayMs?.(this.attempts) ??
            Math.min(1_000, 100 * this.attempts)
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.pump()
          }, delay)
          return
        }
        this.pending = ""
        this.attempts = 0
        this.options.onFailed(error)
      }
    )
  }
}
