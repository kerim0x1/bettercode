import { logger } from "../../observability/logger"

/**
 * Shared newline-delimited JSON framing for the Codex app-server and ACP
 * JSON-RPC clients.
 *
 * Both clients used to carry their own copy of this loop, and both tore the
 * whole agent process down when one line exceeded the cap: Codex sends the
 * cumulative turn diff in a single notification and ACP tool updates can carry
 * whole files, so one big lockfile change killed the session mid-turn. Now an
 * oversized line is skipped up to its newline and reported through
 * `onOversizedLine` with its head, so the client can fail only the request it
 * belongs to and keep the session alive.
 */

/** Generous default: a single protocol line rarely approaches this. */
export const DEFAULT_NDJSON_LINE_BYTE_CAP = 64 * 1024 * 1024

/** Bytes of an oversized line kept to recover its id and method. */
const OVERSIZED_HEAD_BYTES = 512

export interface OversizedNdjsonLine {
  /** Total length of the dropped line in bytes. */
  readonly bytes: number
  /** The first bytes of the line, decoded as UTF-8. */
  readonly head: string
}

export class NdjsonLineReader {
  private chunks: Buffer[] = []
  private bytes = 0
  /** Set while discarding the rest of an oversized line. */
  private skipping: { bytes: number; head: string } | null = null

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversizedLine: (line: OversizedNdjsonLine) => void
  ) {}

  push(rawChunk: Buffer | string): void {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk, "utf8")
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline >= 0 ? newline : chunk.length
      const segment = chunk.subarray(offset, end)
      if (this.skipping) {
        this.skipping.bytes += segment.byteLength
      } else if (this.bytes + segment.byteLength > this.maxLineBytes) {
        this.skipping = {
          bytes: this.bytes + segment.byteLength,
          head: lineHead([...this.chunks, segment]),
        }
        this.chunks = []
        this.bytes = 0
      } else if (segment.byteLength > 0) {
        this.chunks.push(segment)
        this.bytes += segment.byteLength
      }
      if (newline < 0) break
      this.finishLine()
      offset = newline + 1
    }
  }

  /** Flushes a trailing line that ended with the stream instead of `\n`. */
  end(): void {
    if (this.skipping || this.bytes > 0) this.finishLine()
  }

  private finishLine(): void {
    const skipped = this.skipping
    if (skipped) {
      this.skipping = null
      this.onOversizedLine(skipped)
      return
    }
    let line = Buffer.concat(this.chunks, this.bytes)
    this.chunks = []
    this.bytes = 0
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1)
    if (line.length > 0) this.onLine(line.toString("utf8"))
  }
}

/** The first bytes of a line without copying the whole buffered line. */
function lineHead(parts: ReadonlyArray<Buffer>): string {
  const head: Buffer[] = []
  let size = 0
  for (const part of parts) {
    if (size >= OVERSIZED_HEAD_BYTES) break
    const slice = part.subarray(0, OVERSIZED_HEAD_BYTES - size)
    head.push(slice)
    size += slice.byteLength
  }
  return Buffer.concat(head, size).toString("utf8")
}

export interface OversizedLineIdentity {
  /** Top-level `id`, when it appears before any nested value. */
  readonly id: number | string | null
  /** Top-level `method`, when it appears before any nested value. */
  readonly method: string | null
}

/**
 * Best-effort identity of a dropped JSON-RPC line. Only the top-level prefix
 * (before the first nested object or array) is searched, so text inside a
 * large `params`/`result` cannot be mistaken for the envelope.
 */
export function identifyOversizedLine(head: string): OversizedLineIdentity {
  const trimmed = head.trimStart()
  if (!trimmed.startsWith("{")) return { id: null, method: null }
  const nested = trimmed.slice(1).search(/[{[]/)
  const prefix = nested < 0 ? trimmed : trimmed.slice(0, nested + 1)
  const idMatch = /"id"\s*:\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)")/.exec(prefix)
  const methodMatch = /"method"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(prefix)
  return {
    id: idMatch
      ? idMatch[1] !== undefined
        ? Number(idMatch[1])
        : (idMatch[2] ?? null)
      : null,
    method: methodMatch?.[1] ?? null,
  }
}

/**
 * Runs every notification handler for a method and the `*` wildcard. A
 * throwing handler is isolated from the others but logged with the method:
 * the Codex translator runs inside the wildcard handler, and a swallowed
 * exception there used to drop events from the transcript without a trace.
 */
export function dispatchNdjsonNotification(
  handlers: ReadonlyMap<
    string,
    ReadonlySet<(method: string, params: unknown) => void>
  >,
  method: string,
  params: unknown,
  label: string
): void {
  for (const key of [method, "*"]) {
    const set = handlers.get(key)
    if (!set) continue
    for (const handler of set) {
      try {
        handler(method, params)
      } catch (error) {
        logger.error(
          { err: error, method, label },
          `${label} notification handler threw; the event was not processed`
        )
      }
    }
  }
}
