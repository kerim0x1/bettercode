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

/** Every `.jsonl` file under `root`, depth first, ignoring unreadable dirs. */
export async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full)
    }
  }
  await visit(root)
  return files
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
