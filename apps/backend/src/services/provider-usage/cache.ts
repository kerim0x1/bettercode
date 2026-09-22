import fs from "node:fs"
import path from "node:path"

/**
 * Per-file aggregate cache.
 *
 * The Claude transcript corpus is ~1 GB on an active machine, so the first
 * scan is paid once and every later request only re-reads the JSONL files
 * whose size or mtime moved. Entries are keyed by absolute path; files that
 * disappeared (Claude prunes old transcripts) are dropped on write.
 */

const CACHE_VERSION = 5
const CACHE_FILE = "usage-stats-cache.json"

interface CacheEntry<T> {
  size: number
  mtimeMs: number
  value: T
}

interface CacheFile {
  version: number
  scopes: Record<string, Record<string, CacheEntry<unknown>>>
}

function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, scopes: {} }
}

function cachePath(dataDir: string): string {
  return path.join(dataDir, CACHE_FILE)
}

function readCacheFile(dataDir: string): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(dataDir), "utf8")
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed.version !== CACHE_VERSION || typeof parsed.scopes !== "object") {
      return emptyCache()
    }
    return { version: CACHE_VERSION, scopes: parsed.scopes ?? {} }
  } catch {
    return emptyCache()
  }
}

function writeCacheFile(dataDir: string, cache: CacheFile): void {
  const target = cachePath(dataDir)
  const temporary = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf8")
    fs.renameSync(temporary, target)
  } catch {
    // A usage page is not worth failing a request over; the next scan simply
    // recomputes from scratch.
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Ignored: the temp file is disposable.
    }
  }
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
export async function scanWithCache<T>(options: {
  dataDir: string | null
  scope: string
  files: readonly string[]
  compute: (file: string) => Promise<T | null>
}): Promise<FileScanResult<T>> {
  const cache = options.dataDir ? readCacheFile(options.dataDir) : emptyCache()
  const previous = cache.scopes[options.scope] ?? {}
  const next: Record<string, CacheEntry<unknown>> = {}
  const values: T[] = []
  let scanned = 0
  let reused = 0
  for (const file of options.files) {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
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
    const value = await options.compute(file)
    if (value === null) continue
    next[file] = { size: stat.size, mtimeMs: stat.mtimeMs, value }
    values.push(value)
    scanned += 1
  }
  if (
    options.dataDir &&
    (scanned > 0 || Object.keys(previous).length !== Object.keys(next).length)
  ) {
    cache.scopes[options.scope] = next
    writeCacheFile(options.dataDir, cache)
  }
  return { values, scanned, reused }
}
