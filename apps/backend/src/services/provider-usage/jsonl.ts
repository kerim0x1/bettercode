import fs from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"

const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Stream a JSONL file line by line.
 *
 * Provider transcripts reach tens of megabytes (Codex rollouts reach
 * gigabytes), so the file is never materialised as one string: chunks are
 * decoded with a carry buffer and scanned by index instead of re-slicing,
 * which keeps the pass linear and lets the event loop breathe between reads.
 *
 * `from` starts at a byte offset, and `completeLinesOnly` leaves a last line
 * without its newline (one still being written) for the next read. Resolves
 * to the byte offset just past the last newline read, where an append-only
 * file can be picked up again, or null when the file cannot be opened.
 */
export async function forEachLine(
  file: string,
  onLine: (line: string) => void,
  options: { fromEnd?: number; from?: number; completeLinesOnly?: boolean } = {}
): Promise<number | null> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, "r")
  } catch {
    return null
  }
  try {
    let position = options.from ?? 0
    if (options.fromEnd !== undefined) {
      const stat = await handle.stat()
      position = Math.max(0, stat.size - options.fromEnd)
    }
    let lineEnd = position
    const decoder = new StringDecoder("utf8")
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let carry = ""
    // A tail read starts mid-line; that fragment is dropped by the first
    // JSON.parse failure at the call site.
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position)
      if (bytesRead === 0) break
      // A newline byte never occurs inside a multi-byte UTF-8 character, so
      // the raw buffer gives the byte offset of each line end.
      const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (lastNewline >= 0) lineEnd = position + lastNewline + 1
      position += bytesRead
      carry += decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      let index = carry.indexOf("\n", start)
      while (index >= 0) {
        const line = carry.slice(start, index)
        if (line.length > 0) onLine(line)
        start = index + 1
        index = carry.indexOf("\n", start)
      }
      carry = carry.slice(start)
    }
    if (options.completeLinesOnly) return lineEnd
    carry += decoder.end()
    if (carry.length > 0) onLine(carry)
    return position
  } finally {
    await handle.close()
  }
}

/**
 * `forEachLine` for the lines that contain `marker`, which must not contain a
 * newline.
 *
 * The raw bytes are searched and only the matching lines are decoded, so the
 * rows a caller drops anyway never become strings. In Claude transcripts that
 * is most of the file: tool results and user messages outweigh the assistant
 * rows that carry usage. Same options and result as `forEachLine`.
 */
export async function forEachMatchingLine(
  file: string,
  marker: string,
  onLine: (line: string) => void,
  options: { fromEnd?: number; from?: number; completeLinesOnly?: boolean } = {}
): Promise<number | null> {
  const needle = Buffer.from(marker, "utf8")
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, "r")
  } catch {
    return null
  }
  try {
    let position = options.from ?? 0
    if (options.fromEnd !== undefined) {
      const stat = await handle.stat()
      position = Math.max(0, stat.size - options.fromEnd)
    }
    let lineEnd = position
    let buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    // The start of a line the last read cut off, kept at the buffer's head.
    let carried = 0
    for (;;) {
      if (buffer.length - carried < CHUNK_BYTES / 4) {
        // A line longer than most of a chunk: grow instead of reading slivers.
        const grown = Buffer.allocUnsafe(carried + CHUNK_BYTES)
        buffer.copy(grown, 0, 0, carried)
        buffer = grown
      }
      const { bytesRead } = await handle.read(
        buffer,
        carried,
        buffer.length - carried,
        position
      )
      if (bytesRead === 0) break
      position += bytesRead
      const end = carried + bytesRead
      const view = buffer.subarray(0, end)
      // A newline byte never occurs inside a multi-byte UTF-8 character, so
      // byte offsets mark line ends and each line decodes on its own.
      const lastNewline = view.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        carried = end
        continue
      }
      lineEnd = position - end + lastNewline + 1
      let from = 0
      for (;;) {
        const hit = view.indexOf(needle, from)
        if (hit < 0 || hit > lastNewline) break
        const start = view.lastIndexOf(0x0a, hit) + 1
        const stop = view.indexOf(0x0a, hit)
        onLine(view.toString("utf8", start, stop))
        from = stop + 1
      }
      buffer.copy(buffer, 0, lastNewline + 1, end)
      carried = end - lastNewline - 1
    }
    if (options.completeLinesOnly) return lineEnd
    if (carried > 0 && buffer.subarray(0, carried).indexOf(needle) >= 0) {
      onLine(buffer.toString("utf8", 0, carried))
    }
    return position
  } finally {
    await handle.close()
  }
}

/**
 * The last line holding each marker in a stream of JSONL bytes, or null for
 * a marker that never occurs. Markers must not contain a newline.
 *
 * Made for logs that can only be read from the start, like a compressed
 * Codex rollout: each chunk is searched from its end, and nothing but the
 * newest matching lines and a partial last line is kept.
 */
export async function lastMatchingLines(
  chunks: AsyncIterable<Buffer>,
  markers: readonly string[]
): Promise<Array<string | null>> {
  const needles = markers.map((marker) => Buffer.from(marker, "utf8"))
  const found: Array<string | null> = markers.map(() => null)
  // The start of a line that a later chunk completes.
  let carried: Buffer[] = []
  const take = (line: Buffer) => {
    needles.forEach((needle, index) => {
      if (line.indexOf(needle) >= 0) found[index] = line.toString("utf8")
    })
  }
  for await (const chunk of chunks) {
    const first = chunk.indexOf(0x0a)
    if (first < 0) {
      carried.push(Buffer.from(chunk))
      continue
    }
    const last = chunk.lastIndexOf(0x0a)
    // Whole lines after the first newline of this chunk; newest last.
    const lines = chunk.subarray(first + 1, last)
    const completed = Buffer.concat([...carried, chunk.subarray(0, first)])
    needles.forEach((needle, index) => {
      const hit = lines.lastIndexOf(needle)
      if (hit >= 0) {
        const start = lines.lastIndexOf(0x0a, hit) + 1
        const end = lines.indexOf(0x0a, hit)
        found[index] = lines.toString(
          "utf8",
          start,
          end < 0 ? lines.length : end
        )
      } else if (completed.indexOf(needle) >= 0) {
        // Older than anything in this chunk, newer than earlier chunks.
        found[index] = completed.toString("utf8")
      }
    })
    carried =
      last + 1 < chunk.length ? [Buffer.from(chunk.subarray(last + 1))] : []
  }
  if (carried.length > 0) take(Buffer.concat(carried))
  return found
}

/**
 * Every `.jsonl` file under `root`, depth first, ignoring unreadable dirs.
 * Sibling directories are read concurrently: Claude keeps one per project and
 * one per chat with subagents, hundreds on an active machine.
 */
export async function listJsonlFiles(root: string): Promise<string[]> {
  const visit = async (directory: string): Promise<string[]> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      return []
    }
    const nested = await Promise.all(
      entries.map((entry) => {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) return visit(full)
        return entry.isFile() && entry.name.endsWith(".jsonl") ? [full] : []
      })
    )
    return nested.flat()
  }
  return visit(root)
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
