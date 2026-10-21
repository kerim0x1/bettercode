import fs from "node:fs"
import { StringDecoder } from "node:string_decoder"

const CHUNK_BYTES = 1024 * 1024

/**
 * Streams a JSONL file line by line without holding it as one string, like
 * the usage reader (`provider-usage/jsonl.ts`), but bounded: `limitBytes`
 * reads only the start of a file and `shouldStop` ends the read between
 * chunks (a listing's time budget). A last line cut off by either is left
 * out, never handed on half.
 *
 * Resolves `complete: true` when the whole file was read, or null when it
 * cannot be opened or read (it is then skipped, not reported).
 */
export async function readJsonlLines(
  file: string,
  onLine: (line: string) => void,
  options: { limitBytes?: number; shouldStop?: () => boolean } = {}
): Promise<{ complete: boolean } | null> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, "r")
  } catch {
    return null
  }
  try {
    const decoder = new StringDecoder("utf8")
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    const limit = options.limitBytes ?? Number.POSITIVE_INFINITY
    let position = 0
    let carry = ""
    for (;;) {
      if (position >= limit || options.shouldStop?.()) {
        return { complete: false }
      }
      const length = Math.min(CHUNK_BYTES, limit - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      position += bytesRead
      carry += decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      let index = carry.indexOf("\n", start)
      while (index >= 0) {
        const line = carry.slice(start, index).trim()
        if (line.length > 0) onLine(line)
        start = index + 1
        index = carry.indexOf("\n", start)
      }
      carry = carry.slice(start)
    }
    carry += decoder.end()
    const last = carry.trim()
    if (last.length > 0) onLine(last)
    return { complete: true }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}
