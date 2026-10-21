import { redactSensitiveText } from "../../observability/redact"

/**
 * Bounded, line-buffered record of an agent process's stderr.
 *
 * The real reason a CLI dies (expired login, unknown model, crash trace) is
 * usually printed on stderr, while the process protocol only reports "exited
 * with code 1". Every provider process keeps the last lines here so a failure
 * can carry them in its diagnostic `detail` and the backend log. The text is
 * diagnostic only: it is never projected into the transcript as model output.
 *
 * Lines are assembled across chunks, so a line split between two `data`
 * events is recorded once and whole.
 */
export class ProcessStderrTail {
  private readonly lines: string[] = []
  private bytes = 0
  private partial = ""

  constructor(
    private readonly maxBytes = 16 * 1024,
    private readonly maxLineChars = 2_000
  ) {}

  /** Records a chunk and returns the lines it completed. */
  push(chunk: Buffer | string): string[] {
    const text =
      this.partial +
      (typeof chunk === "string" ? chunk : chunk.toString("utf8"))
    const parts = text.split(/\r?\n/)
    this.partial = parts.pop() ?? ""
    // A runaway line without a newline must not grow the buffer unbounded.
    if (this.partial.length > this.maxLineChars) {
      parts.push(this.partial)
      this.partial = ""
    }
    const completed: string[] = []
    for (const part of parts) {
      const line = this.bound(part)
      if (!line.trim()) continue
      this.record(line)
      completed.push(line)
    }
    return completed
  }

  /** Records a trailing line without newline, e.g. at process exit. */
  flush(): string[] {
    if (!this.partial) return []
    const line = this.bound(this.partial)
    this.partial = ""
    if (!line.trim()) return []
    this.record(line)
    return [line]
  }

  /** Redacted tail, newest last, at most `maxChars` characters. */
  tail(maxChars = 4_000): string {
    const text = redactSensitiveText(
      [...this.lines, ...(this.partial.trim() ? [this.partial] : [])].join("\n")
    )
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
  }

  get isEmpty(): boolean {
    return this.lines.length === 0 && !this.partial.trim()
  }

  clear(): void {
    this.lines.length = 0
    this.bytes = 0
    this.partial = ""
  }

  private bound(line: string): string {
    return line.length > this.maxLineChars
      ? `${line.slice(0, this.maxLineChars)}…`
      : line
  }

  private record(line: string): void {
    this.lines.push(line)
    this.bytes += line.length + 1
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift()
      this.bytes -= (dropped?.length ?? 0) + 1
    }
  }
}

/** Appends a stderr tail to a failure detail, when there is one. */
export function withStderrTail(
  detail: string,
  stderr: ProcessStderrTail | null | undefined,
  maxChars = 2_000
): string {
  if (!stderr || stderr.isEmpty) return detail
  return `${detail}\n\nProcess stderr (last lines):\n${stderr.tail(maxChars)}`
}
