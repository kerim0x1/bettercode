import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Per-file aggregate cache.
 *
 * The Claude transcript corpus is ~1 GB on an active machine, so the first
 * scan is paid once and every later request only re-reads the JSONL files
 * whose size or mtime moved. Entries are keyed by absolute path; files that
 * disappeared (Claude prunes old transcripts) are dropped on write.
 *
 * Each scope (provider) owns its own cache file, so the Claude and Codex scans
 * that run in parallel never read, parse or rewrite each other's aggregates.
 * A scan reads its file once, asynchronously, and writes it back once.
 */

const CACHE_VERSION = 5
const CACHE_FILE_PREFIX = "usage-stats-cache"
/** Single shared file used before the cache was split per scope. */
const LEGACY_CACHE_FILE = `${CACHE_FILE_PREFIX}.json`

interface CacheEntry<T> {
  size: number
  mtimeMs: number
  value: T
  /** Append-only scopes: bytes read so far, always at a line boundary. */
  offset?: number
  /** Append-only scopes: the bytes just before `offset`, to notice a rewrite. */
  fingerprint?: string
}

/** Where an append-only scan stopped, and what it had added up by then. */
export interface AppendScan<T> {
  value: T
  offset: number
}

const FINGERPRINT_BYTES = 64

interface ScopeCacheFile {
  version: number
  scope: string
  entries: Record<string, CacheEntry<unknown>>
}

function scopeFileSegment(scope: string): string {
  const safe = scope.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64)
  return safe.length > 0 ? safe : "default"
}

/** Absolute path of the cache file that holds one scope's aggregates. */
export function usageCachePath(dataDir: string, scope: string): string {
  return path.join(
    dataDir,
    `${CACHE_FILE_PREFIX}.${scopeFileSegment(scope)}.json`
  )
}

async function readScopeCache(
  dataDir: string,
  scope: string
): Promise<Record<string, CacheEntry<unknown>>> {
  try {
    const raw = await fs.promises.readFile(
      usageCachePath(dataDir, scope),
      "utf8"
    )
    const parsed = JSON.parse(raw) as Partial<ScopeCacheFile>
    if (
      parsed.version !== CACHE_VERSION ||
      parsed.scope !== scope ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return {}
    }
    return parsed.entries
  } catch {
    return {}
  }
}

async function writeScopeCache(
  dataDir: string,
  scope: string,
  entries: Record<string, CacheEntry<unknown>>
): Promise<void> {
  const target = usageCachePath(dataDir, scope)
  // Unique per write so two overlapping scans can never interleave one file.
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  const body: ScopeCacheFile = { version: CACHE_VERSION, scope, entries }
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(temporary, JSON.stringify(body), "utf8")
    await fs.promises.rename(temporary, target)
  } catch {
    // A usage page is not worth failing a request over; the next scan simply
    // recomputes from scratch.
    await fs.promises.rm(temporary, { force: true }).catch(() => {
      // Ignored: the temp file is disposable.
    })
    return
  }
  // The pre-split shared file is never read again; drop it so it does not
  // linger as dead weight in the data directory.
  await fs.promises
    .rm(path.join(dataDir, LEGACY_CACHE_FILE), { force: true })
    .catch(() => {
      // Ignored: a stale legacy file only costs disk space.
    })
}

export interface FileScanResult<T> {
  values: T[]
  scanned: number
  reused: number
}

/**
 * Run `compute` over every file whose fingerprint changed, reusing cached
 * aggregates for the rest. Returns one value per readable file.
 */
export function scanWithCache<T>(options: {
  dataDir: string | null
  scope: string
  files: readonly string[]
  compute: (file: string) => Promise<T | null>
}): Promise<FileScanResult<T>> {
  return scanFiles<T>({
    ...options,
    entryFor: async (file, _cached, stat) => {
      const value = await options.compute(file)
      return value === null
        ? null
        : { size: stat.size, mtimeMs: stat.mtimeMs, value }
    },
  })
}

/**
 * `scanWithCache` for files that only ever grow, like Claude transcripts. A
 * file that grew is read on from where the last scan stopped: an active
 * chat's transcript reaches a hundred megabytes and changes with every
 * message, so reading it from the start on each page load cost seconds. A
 * file that shrank, or whose bytes before that point changed, is scanned from
 * the start again.
 */
export function scanAppendOnlyWithCache<T>(options: {
  dataDir: string | null
  scope: string
  files: readonly string[]
  scan: (
    file: string,
    from: AppendScan<T> | null
  ) => Promise<AppendScan<T> | null>
}): Promise<FileScanResult<T>> {
  return scanFiles<T>({
    ...options,
    entryFor: async (file, cached, stat) => {
      const from = await resumePoint<T>(file, cached, stat.size)
      const result = await options.scan(file, from)
      if (!result) return null
      const fingerprint = await readFingerprint(file, result.offset)
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        value: result.value,
        offset: result.offset,
        ...(fingerprint !== null ? { fingerprint } : {}),
      }
    },
  })
}

async function resumePoint<T>(
  file: string,
  cached: CacheEntry<unknown> | undefined,
  size: number
): Promise<AppendScan<T> | null> {
  if (cached?.offset === undefined || cached.fingerprint === undefined)
    return null
  if (size < cached.offset) return null
  if ((await readFingerprint(file, cached.offset)) !== cached.fingerprint)
    return null
  // The cached aggregate is extended in place, so it must not be shared.
  return { value: structuredClone(cached.value) as T, offset: cached.offset }
}

async function readFingerprint(
  file: string,
  offset: number
): Promise<string | null> {
  const start = Math.max(0, offset - FINGERPRINT_BYTES)
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(offset - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead).toString("base64")
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

async function scanFiles<T>(options: {
  dataDir: string | null
  scope: string
  files: readonly string[]
  entryFor: (
    file: string,
    cached: CacheEntry<unknown> | undefined,
    stat: fs.Stats
  ) => Promise<CacheEntry<T> | null>
}): Promise<FileScanResult<T>> {
  const previous = options.dataDir
    ? await readScopeCache(options.dataDir, options.scope)
    : {}
  const next: Record<string, CacheEntry<unknown>> = {}
  const values: T[] = []
  let scanned = 0
  let reused = 0
  for (const file of options.files) {
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(file)
    } catch {
      continue
    }
    const cached = previous[file]
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      next[file] = cached
      values.push(cached.value as T)
      reused += 1
      continue
    }
    const entry = await options.entryFor(file, cached, stat)
    if (entry === null) continue
    next[file] = entry
    values.push(entry.value)
    scanned += 1
  }
  if (
    options.dataDir &&
    (scanned > 0 || Object.keys(previous).length !== Object.keys(next).length)
  ) {
    await writeScopeCache(options.dataDir, options.scope, next)
  }
  return { values, scanned, reused }
}
