import ignore, { type Ignore } from "ignore"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpError } from "../../errors"
import { compileBoundedGlob } from "../bounded-glob"
import { readWorkspaceFile } from "./files"
import { RegexSearch } from "./regex-search"
import {
  BetterC0de_GLOBAL_CONFIG_FILES,
  BetterC0de_PROJECT_CONFIG_FILES,
  betterC0deDirectoryConfigFileSources,
  betterC0deExplicitConfigSource,
  betterC0deGlobalConfigSources,
  betterC0deManagedConfigSources,
  betterC0deProjectConfigFileSources,
  parseJsoncObject,
  readRecord,
  type BetterC0deConfigFileSource,
} from "./project-config"

export interface SearchEntry {
  path: string
  name: string
  is_dir: boolean
}

export interface ContentSearchMatch {
  line: number
  column: number
  length: number
  previewColumn: number
  previewLength: number
  preview: string
}

export interface ContentSearchResult {
  path: string
  name: string
  matches: ContentSearchMatch[]
}

export interface ContentSearchOptions {
  limit?: number
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string
  exclude?: string
}

export interface QuickOpenFile {
  path: string
  name: string
}

export type WorkspaceMapFileKind = "source" | "config" | "docs" | "data"

export interface WorkspaceMapFile {
  path: string
  name: string
  directory: string
  extension: string
  sizeBytes: number
  kind: WorkspaceMapFileKind
}

export interface WorkspaceMapDirectory {
  path: string
  name: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapExtension {
  extension: string
  label: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapOverview {
  rootName: string
  totalFiles: number
  scannedFiles: number
  codeFiles: number
  totalBytes: number
  truncated: boolean
  files: WorkspaceMapFile[]
  topDirectories: WorkspaceMapDirectory[]
  extensions: WorkspaceMapExtension[]
  importantFiles: WorkspaceMapFile[]
  largestFiles: WorkspaceMapFile[]
}

/**
 * Baseline excludes: directories that are never useful to index, regardless
 * of what `.gitignore` says (or whether one exists). Keeps the search
 * responsive on fresh clones without a gitignore in place, and matches what
 * an experienced dev expects "search files in this repo" to return.
 */
const BASELINE_IGNORES = [
  ".git/",
  "node_modules/",
  ".turbo/",
  ".cache/",
  ".betterc0de/",
  ".codex/",
  ".claude/",
  ".omx/",
  "release/",
]

const CONTENT_SEARCH_MAX_DEPTH = 12

const CONTENT_SEARCH_MAX_FILE_BYTES = 1024 * 1024

const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 8

const CONTENT_SEARCH_MAX_SCANNED_FILES = 5_000

const CONTENT_SEARCH_MAX_SCANNED_BYTES = 64 * 1024 * 1024

const CONTENT_SEARCH_MAX_DURATION_MS = 5_000

const SEARCH_ENTRIES_MAX_RESULTS = 1_000

const SEARCH_ENTRIES_MAX_VISITED = 50_000

const SEARCH_ENTRIES_MAX_DURATION_MS = 5_000

const QUICK_OPEN_MAX_DEPTH = 12

const QUICK_OPEN_MAX_SCANNED_FILES = 20_000

const WORKSPACE_MAP_MAX_DEPTH = 12

export const PROJECT_CACHE_MAX_ENTRIES = 128

const CONTENT_SEARCH_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".br",
  ".class",
  ".db",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".otf",
  ".pdf",
  ".png",
  ".sqlite",
  ".sqlite3",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
])

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".less",
  ".mjs",
  ".php",
  ".prisma",
  ".proto",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
])

const CONFIG_FILE_NAMES = new Set([
  ".env",
  ".env.example",
  ".eslintrc",
  ".gitignore",
  ".prettierrc",
  "biome.json",
  "bun.lockb",
  "components.json",
  "deno.json",
  "dockerfile",
  "eslint.config.js",
  "eslint.config.mjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "postcss.config.js",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "turbo.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "yarn.lock",
])

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"])

const DATA_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".toml",
  ".xml",
  ".yaml",
  ".yml",
])

// Per-root ignore matcher cache. Invalidated at each `searchEntries` call
// whose root is new; within a single process, repeated searches against the
// same root reuse the cached matcher (parsing `.gitignore` files is the
// dominant cost after directory enumeration).
const matcherCache = new Map<string, { signature: string; matcher: Ignore }>()

async function statMtime(absolutePath: string): Promise<number> {
  try {
    return (await fs.stat(absolutePath)).mtimeMs
  } catch {
    return 0
  }
}

async function buildIgnoreMatcher(root: string): Promise<Ignore> {
  const cacheKey = root
  const cached = matcherCache.get(cacheKey)
  const rootIgnore = path.join(root, ".gitignore")
  const sources = betterC0deWatcherConfigSourcesSync(root)
  const mtimes = await Promise.all([
    statMtime(rootIgnore),
    ...sources.map((source) => statMtime(source.absolutePath)),
  ])
  const signatureParts = [
    `git:${mtimes[0]}`,
    ...sources.map(
      (source, index) => `${source.sourcePath}:${mtimes[index + 1]}`
    ),
    `BetterC0de_CONFIG_CONTENT:${process.env.BetterC0de_CONFIG_CONTENT ?? ""}`,
  ]

  const signature = signatureParts.join("|")
  if (cached && cached.signature === signature) {
    matcherCache.delete(cacheKey)
    matcherCache.set(cacheKey, cached)
    return cached.matcher
  }

  const matcher = ignore().add(BASELINE_IGNORES)
  try {
    matcher.add(await fs.readFile(rootIgnore, "utf8"))
  } catch {
    // Absent or unreadable .gitignore — baseline excludes still apply.
  }
  const watcherIgnores = await readBetterC0deWatcherIgnores(root, sources)
  if (watcherIgnores.length > 0) matcher.add(watcherIgnores)

  setBoundedCache(
    matcherCache,
    cacheKey,
    { signature, matcher },
    PROJECT_CACHE_MAX_ENTRIES
  )
  return matcher
}

export function setBoundedCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number
): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    cache.delete(oldest.value)
  }
}

async function readBetterC0deWatcherIgnores(
  root: string,
  sources: readonly BetterC0deConfigFileSource[] = betterC0deWatcherConfigSourcesSync(
    root
  )
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const contents = await Promise.all(
    sources.map((source) =>
      fs.readFile(source.absolutePath, "utf8").catch(() => null)
    )
  )
  for (const content of contents) {
    if (content === null) continue
    const config = parseJsoncObject(content)
    const watcher = readRecord(config, "watcher")
    for (const rawPattern of readStringArray(watcher.ignore)) {
      const pattern = normalizeBetterC0deWatcherIgnorePattern(rawPattern)
      if (!pattern || seen.has(pattern)) continue
      seen.add(pattern)
      out.push(pattern)
    }
  }
  const contentConfig = process.env.BetterC0de_CONFIG_CONTENT?.trim()
  if (contentConfig) {
    const config = parseJsoncObject(contentConfig)
    const watcher = readRecord(config, "watcher")
    for (const rawPattern of readStringArray(watcher.ignore)) {
      const pattern = normalizeBetterC0deWatcherIgnorePattern(rawPattern)
      if (!pattern || seen.has(pattern)) continue
      seen.add(pattern)
      out.push(pattern)
    }
  }
  return out
}

function betterC0deWatcherConfigSourcesSync(
  workspaceRoot: string
): BetterC0deConfigFileSource[] {
  return [
    ...betterC0deGlobalConfigSources(BetterC0de_GLOBAL_CONFIG_FILES),
    ...[betterC0deExplicitConfigSource("BETTERC0DE_CONFIG")].filter(
      (source): source is BetterC0deConfigFileSource => Boolean(source)
    ),
    ...[betterC0deExplicitConfigSource("BetterC0de_CONFIG")].filter(
      (source): source is BetterC0deConfigFileSource => Boolean(source)
    ),
    ...betterC0deProjectConfigFileSources(
      workspaceRoot,
      BetterC0de_PROJECT_CONFIG_FILES
    ),
    ...betterC0deDirectoryConfigFileSources(workspaceRoot, [
      "betterc0de.json",
      "betterc0de.jsonc",
      "BetterC0de.json",
      "BetterC0de.jsonc",
    ]),
    ...betterC0deManagedConfigSources([
      "betterc0de.json",
      "betterc0de.jsonc",
      "BetterC0de.json",
      "BetterC0de.jsonc",
    ]),
  ]
}

function normalizeBetterC0deWatcherIgnorePattern(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/")
  if (
    !trimmed ||
    trimmed.startsWith("~/") ||
    path.isAbsolute(trimmed) ||
    trimmed.split("/").includes("..")
  ) {
    return null
  }
  return trimmed.replace(/^\.\/+/, "")
}

// ── Nested .gitignore support ──────────────────────────────────────────
//
// Only the root `.gitignore` used to be honoured, so a `packages/app/.gitignore`
// excluding `dist/` was ignored and every search paid for walking that tree.
// Nested files are read as the walk enters their directory, translated to
// root-relative patterns, and cached by (path, mtime, size) so repeated
// searches do not re-read them. Budgets bound the cost on hostile trees.

const NESTED_GITIGNORE_MAX_FILES = 256
const NESTED_GITIGNORE_MAX_FILE_BYTES = 64 * 1024
const NESTED_GITIGNORE_MAX_TOTAL_BYTES = 512 * 1024
const NESTED_GITIGNORE_CACHE_MAX_ENTRIES = 1_024

const nestedGitignoreCache = new Map<
  string,
  { mtimeMs: number; size: number; patterns: string[] }
>()

/**
 * Rewrite the lines of a `.gitignore` located in `relDir` (root-relative,
 * forward slashes, no trailing slash) so they mean the same thing when
 * evaluated from the workspace root. Follows gitignore's rule: a pattern with
 * a slash anywhere but the end is anchored to its own directory, any other
 * pattern matches at every depth below it.
 */
export function translateNestedGitignore(
  relDir: string,
  content: string
): string[] {
  const out: string[] = []
  // The directory is spliced into a *pattern*, so a name like
  // `packages/[legacy]` must not become a character class. Backslash escapes
  // are gitignore syntax; a leading `#` or `!` would otherwise turn the whole
  // line into a comment or a negation.
  relDir = relDir
    .replace(/[\\[\]*?]/g, (char) => `\\${char}`)
    .replace(/^[#!]/, (char) => `\\${char}`)
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/(?<!\\)\s+$/, "")
    if (!line || line.startsWith("#")) continue
    const negated = line.startsWith("!")
    const body = negated ? line.slice(1) : line
    if (!body) continue
    let translated: string
    if (body.startsWith("/")) {
      translated = `${relDir}/${body.slice(1)}`
    } else {
      const inner = body.endsWith("/") ? body.slice(0, -1) : body
      translated = inner.includes("/")
        ? `${relDir}/${body}`
        : `${relDir}/**/${body}`
    }
    out.push(negated ? `!${translated}` : translated)
  }
  return out
}

class WalkIgnore {
  /**
   * Root rules (baseline, root `.gitignore`, watcher ignores) plus every
   * nested file seen so far, as ONE ordered rule list. That ordering is what
   * gives nested files git's precedence: the last matching rule wins, and a
   * deeper `.gitignore` is always added after the ones above it, so
   * `!important.log` in `sub/` overrides a root `*.log`. Two matchers joined
   * with `||` could never un-ignore anything.
   *
   * The root matcher is shared and cached across searches, so the combined
   * one is a private copy created on first use.
   */
  private combined: Ignore | null = null
  private nestedFiles = 0
  private nestedBytes = 0

  constructor(private readonly root: Ignore) {}

  ignores(relForMatcher: string): boolean {
    return (this.combined ?? this.root).ignores(relForMatcher)
  }

  /** Call when the walk enters `dirAbs` (`relDir` root-relative, "" for root). */
  async enter(dirAbs: string, relDir: string): Promise<void> {
    if (!relDir || this.nestedFiles >= NESTED_GITIGNORE_MAX_FILES) return
    if (this.nestedBytes >= NESTED_GITIGNORE_MAX_TOTAL_BYTES) return
    const ignorePath = path.join(dirAbs, ".gitignore")
    let stat: import("node:fs").Stats
    try {
      stat = await fs.stat(ignorePath)
    } catch {
      return
    }
    if (!stat.isFile() || stat.size > NESTED_GITIGNORE_MAX_FILE_BYTES) return
    this.nestedFiles += 1
    // The cached patterns are translated relative to the search ROOT
    // (`sub/deep/**/x` for a file at `<root>/sub/deep/.gitignore`), so the
    // same file reached from a different root — the user opens `<root>/sub`
    // as its own workspace — needs a different translation. Keying by the
    // file alone served root A's patterns under root B, where they matched
    // nothing and the nested ignores silently stopped applying.
    const cacheKey = `${relDir}\0${ignorePath}`
    const cached = nestedGitignoreCache.get(cacheKey)
    let patterns: string[]
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      patterns = cached.patterns
    } else {
      let content: string
      try {
        content = await fs.readFile(ignorePath, "utf8")
      } catch {
        return
      }
      this.nestedBytes += stat.size
      patterns = translateNestedGitignore(relDir, content)
      setBoundedCache(
        nestedGitignoreCache,
        cacheKey,
        { mtimeMs: stat.mtimeMs, size: stat.size, patterns },
        NESTED_GITIGNORE_CACHE_MAX_ENTRIES
      )
    }
    if (patterns.length > 0) {
      this.combined ??= ignore().add(this.root)
      this.combined.add(patterns)
    }
  }
}

async function buildWalkIgnore(root: string): Promise<WalkIgnore> {
  return new WalkIgnore(await buildIgnoreMatcher(root))
}

export type SearchEntriesTruncationReason = "results" | "visited" | "deadline"

export interface SearchEntriesResult {
  readonly entries: SearchEntry[]
  /** True when a cap stopped the walk; the list is then incomplete. */
  readonly truncated: boolean
  readonly truncatedReason?: SearchEntriesTruncationReason
}

export interface SearchEntriesLimits {
  readonly maxResults?: number
  readonly maxVisited?: number
  readonly maxDurationMs?: number
}

/**
 * Case-insensitive substring search over the project tree with `.gitignore`
 * awareness. Ignored paths are skipped entirely (not visited), which is what
 * makes the walk fast on monorepos with big `node_modules` trees.
 *
 * Matching semantics: an empty query returns every non-ignored entry (file
 * + dir) up to the recursion + result caps; a non-empty query filters by
 * case-insensitive substring on the entry name.
 *
 * Prefer {@link searchEntriesDetailed}: this array form cannot tell the
 * caller that a cap cut the list short.
 */
export async function searchEntries(
  cwd: string,
  query: string
): Promise<SearchEntry[]> {
  return (await searchEntriesDetailed(cwd, query)).entries
}

export async function searchEntriesDetailed(
  cwd: string,
  query: string,
  limits: SearchEntriesLimits = {}
): Promise<SearchEntriesResult> {
  const root = path.resolve(cwd)
  const needle = query.toLowerCase()
  const results: SearchEntry[] = []
  const matcher = await buildWalkIgnore(root)
  const maxResults = limits.maxResults ?? SEARCH_ENTRIES_MAX_RESULTS
  const maxVisited = limits.maxVisited ?? SEARCH_ENTRIES_MAX_VISITED
  const deadline =
    Date.now() + (limits.maxDurationMs ?? SEARCH_ENTRIES_MAX_DURATION_MS)
  let visitedEntries = 0
  let truncatedReason: SearchEntriesTruncationReason | undefined

  const stopReason = (): SearchEntriesTruncationReason | null => {
    if (results.length >= maxResults) return "results"
    if (visitedEntries >= maxVisited) return "visited"
    if (Date.now() >= deadline) return "deadline"
    return null
  }

  async function walk(dir: string, relDir: string, depth: number) {
    if (depth > 10) return
    const stopped = stopReason()
    if (stopped) {
      truncatedReason ??= stopped
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await matcher.enter(dir, relDir)
    for (const entry of entries) {
      const stoppedInLoop = stopReason()
      if (stoppedInLoop) {
        truncatedReason ??= stoppedInLoop
        return
      }
      visitedEntries += 1
      // ignore.ignores wants paths relative to the ignore root with forward
      // slashes and a trailing `/` for directories.
      const abs = path.join(dir, entry.name)
      const relPath = path.relative(root, abs).replace(/\\/g, "/")
      if (!relPath) continue
      const relForMatcher = entry.isDirectory() ? `${relPath}/` : relPath
      if (matcher.ignores(relForMatcher)) continue
      if (!needle || entry.name.toLowerCase().includes(needle)) {
        results.push({
          path: relPath,
          name: entry.name,
          is_dir: entry.isDirectory(),
        })
      }
      if (entry.isDirectory()) await walk(abs, relPath, depth + 1)
    }
  }

  await walk(root, "", 0)
  return truncatedReason
    ? { entries: results, truncated: true, truncatedReason }
    : { entries: results, truncated: false }
}

let activeContentSearches = 0

export type ContentSearchTruncationReason =
  | "limit"
  | "files"
  | "bytes"
  | "deadline"

export interface ContentSearchDetailedResult {
  readonly results: ContentSearchResult[]
  /** True when a cap stopped the walk; more matches may exist. */
  readonly truncated: boolean
  readonly truncatedReason?: ContentSearchTruncationReason
}

export interface ContentSearchLimits {
  readonly maxScannedFiles?: number
  readonly maxScannedBytes?: number
  readonly maxDurationMs?: number
}

/**
 * Prefer {@link searchContentDetailed}: this array form cannot tell the
 * caller that the 5 s deadline or the file/byte budget cut the search short.
 */
export async function searchContent(
  cwd: string,
  query: string,
  options: ContentSearchOptions = {}
): Promise<ContentSearchResult[]> {
  return (await searchContentDetailed(cwd, query, options)).results
}

export async function searchContentDetailed(
  cwd: string,
  query: string,
  options: ContentSearchOptions = {},
  limits: ContentSearchLimits = {}
): Promise<ContentSearchDetailedResult> {
  if (activeContentSearches >= 4) {
    throw new HttpError(
      503,
      "Content search capacity exhausted.",
      "search_capacity"
    )
  }
  activeContentSearches += 1
  try {
    return await searchContentWithinBudget(cwd, query, options, limits)
  } finally {
    activeContentSearches -= 1
  }
}

async function searchContentWithinBudget(
  cwd: string,
  query: string,
  options: ContentSearchOptions = {},
  limits: ContentSearchLimits = {}
): Promise<ContentSearchDetailedResult> {
  const root = path.resolve(cwd)
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)
  const searchNeedle = options.caseSensitive ? needle : needle.toLowerCase()
  const regex = options.regex
    ? compileContentSearchRegex(needle, options.caseSensitive === true)
    : null
  const pathFilter = createContentSearchPathFilter({
    include: options.include,
    exclude: options.exclude,
  })
  const results: ContentSearchResult[] = []
  let totalMatches = 0
  const matcher = await buildWalkIgnore(root)
  const maxScannedFiles =
    limits.maxScannedFiles ?? CONTENT_SEARCH_MAX_SCANNED_FILES
  const maxScannedBytes =
    limits.maxScannedBytes ?? CONTENT_SEARCH_MAX_SCANNED_BYTES
  const budget = {
    scannedFiles: 0,
    scannedBytes: 0,
    deadline:
      Date.now() + (limits.maxDurationMs ?? CONTENT_SEARCH_MAX_DURATION_MS),
  }
  const regexSearch = regex ? new RegexSearch() : null
  let truncatedReason: ContentSearchTruncationReason | undefined

  const stopReason = (): ContentSearchTruncationReason | null => {
    if (totalMatches >= limit) return "limit"
    if (budget.scannedFiles >= maxScannedFiles) return "files"
    if (budget.scannedBytes >= maxScannedBytes) return "bytes"
    if (Date.now() >= budget.deadline) return "deadline"
    return null
  }

  async function walk(dir: string, relDir: string, depth: number) {
    if (depth > CONTENT_SEARCH_MAX_DEPTH) return
    const stopped = stopReason()
    if (stopped) {
      truncatedReason ??= stopped
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await matcher.enter(dir, relDir)

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })

    for (const entry of entries) {
      const stoppedInLoop = stopReason()
      if (stoppedInLoop) {
        truncatedReason ??= stoppedInLoop
        return
      }
      const abs = path.join(dir, entry.name)
      const relPath = path.relative(root, abs).replace(/\\/g, "/")
      if (!relPath) continue
      const relForMatcher = entry.isDirectory() ? `${relPath}/` : relPath
      if (matcher.ignores(relForMatcher)) continue

      if (entry.isDirectory()) {
        await walk(abs, relPath, depth + 1)
        continue
      }
      if (!entry.isFile() || shouldSkipContentSearchFile(entry.name)) continue
      if (!pathFilter(relPath, entry.name)) continue

      const fileMatches = await searchFileContent(
        abs,
        searchNeedle,
        limit - totalMatches,
        {
          caseSensitive: options.caseSensitive === true,
          wholeWord: options.wholeWord === true,
          regex,
          regexSearch,
          root,
        },
        budget
      )
      if (fileMatches.length === 0) continue
      totalMatches += fileMatches.length
      results.push({
        path: relPath,
        name: entry.name,
        matches: fileMatches,
      })
    }
  }

  try {
    await walk(root, "", 0)
    // Reaching the requested limit exactly is only a truncation when the walk
    // was cut short; a final stopReason() check tells the two apart.
    if (!truncatedReason && totalMatches >= limit) truncatedReason = "limit"
    return truncatedReason
      ? { results, truncated: true, truncatedReason }
      : { results, truncated: false }
  } finally {
    await regexSearch?.close()
  }
}

export async function quickOpenFiles(
  cwd: string,
  query: string,
  options: { limit?: number; include?: string } = {}
): Promise<QuickOpenFile[]> {
  const root = path.resolve(cwd)
  const needle = normalizeQuickOpenQuery(query)
  const limit = Math.min(Math.max(options.limit ?? 80, 1), 200)
  const matcher = await buildWalkIgnore(root)
  const pathFilter = createContentSearchPathFilter({
    include: options.include,
  })
  const candidates: Array<QuickOpenFile & { score: number }> = []
  let scannedFiles = 0

  async function walk(dir: string, relDir: string, depth: number) {
    if (
      depth > QUICK_OPEN_MAX_DEPTH ||
      scannedFiles >= QUICK_OPEN_MAX_SCANNED_FILES
    ) {
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await matcher.enter(dir, relDir)

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })

    for (const entry of entries) {
      if (scannedFiles >= QUICK_OPEN_MAX_SCANNED_FILES) return
      const abs = path.join(dir, entry.name)
      const relPath = path.relative(root, abs).replace(/\\/g, "/")
      if (!relPath) continue
      const relForMatcher = entry.isDirectory() ? `${relPath}/` : relPath
      if (matcher.ignores(relForMatcher)) continue

      if (entry.isDirectory()) {
        await walk(abs, relPath, depth + 1)
        continue
      }
      if (!entry.isFile() || shouldSkipContentSearchFile(entry.name)) continue
      if (!pathFilter(relPath, entry.name)) continue

      scannedFiles += 1
      const score = scoreQuickOpenPath(relPath, needle)
      if (score === null) continue
      candidates.push({
        path: relPath,
        name: entry.name,
        score,
      })
    }
  }

  await walk(root, "", 0)
  return candidates
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
    })
    .slice(0, limit)
    .map(({ score: _score, ...file }) => file)
}

export async function workspaceMap(
  cwd: string,
  options: { maxFiles?: number } = {}
): Promise<WorkspaceMapOverview> {
  const root = path.resolve(cwd)
  const rootName = path.basename(root) || root
  const maxFiles = Math.min(Math.max(options.maxFiles ?? 5_000, 100), 20_000)
  const matcher = await buildWalkIgnore(root)
  const directories = new Map<string, WorkspaceMapDirectory>()
  const extensions = new Map<string, WorkspaceMapExtension>()
  const files: WorkspaceMapFile[] = []
  let totalBytes = 0
  let codeFiles = 0
  let truncated = false

  async function walk(dir: string, relDir: string, depth: number) {
    if (depth > WORKSPACE_MAP_MAX_DEPTH || files.length >= maxFiles) {
      if (files.length >= maxFiles) truncated = true
      return
    }

    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await matcher.enter(dir, relDir)

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }

      const abs = path.join(dir, entry.name)
      const relPath = path.relative(root, abs).replace(/\\/g, "/")
      if (!relPath) continue
      const relForMatcher = entry.isDirectory() ? `${relPath}/` : relPath
      if (matcher.ignores(relForMatcher)) continue

      if (entry.isDirectory()) {
        await walk(abs, relPath, depth + 1)
        continue
      }
      if (!entry.isFile() || shouldSkipContentSearchFile(entry.name)) continue

      let stat: import("node:fs").Stats
      try {
        stat = await fs.stat(abs)
      } catch {
        continue
      }
      if (!stat.isFile()) continue

      const ext = normalizedExtension(entry.name)
      const kind = workspaceMapFileKind(entry.name)
      const isCodeFile = kind === "source"
      const directory = normalizedDirectory(relPath)
      const file: WorkspaceMapFile = {
        path: relPath,
        name: entry.name,
        directory,
        extension: ext,
        sizeBytes: stat.size,
        kind,
      }
      files.push(file)
      totalBytes += stat.size
      if (isCodeFile) codeFiles += 1

      const topDir = topLevelDirectory(relPath)
      const dirStat =
        directories.get(topDir) ??
        ({
          path: topDir,
          name: topDir || rootName,
          fileCount: 0,
          codeFileCount: 0,
          totalBytes: 0,
        } satisfies WorkspaceMapDirectory)
      dirStat.fileCount += 1
      dirStat.totalBytes += stat.size
      if (isCodeFile) dirStat.codeFileCount += 1
      directories.set(topDir, dirStat)

      const extStat =
        extensions.get(ext) ??
        ({
          extension: ext,
          label: extensionLabel(ext),
          fileCount: 0,
          codeFileCount: 0,
          totalBytes: 0,
        } satisfies WorkspaceMapExtension)
      extStat.fileCount += 1
      extStat.totalBytes += stat.size
      if (isCodeFile) extStat.codeFileCount += 1
      extensions.set(ext, extStat)
    }
  }

  await walk(root, "", 0)

  return {
    rootName,
    totalFiles: files.length,
    scannedFiles: files.length,
    codeFiles,
    totalBytes,
    truncated,
    files: files
      .slice()
      .sort((a, b) =>
        a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
      ),
    topDirectories: Array.from(directories.values())
      .sort((a, b) => {
        if (b.codeFileCount !== a.codeFileCount) {
          return b.codeFileCount - a.codeFileCount
        }
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        return a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
      })
      .slice(0, 24),
    extensions: Array.from(extensions.values())
      .sort((a, b) => {
        if (b.codeFileCount !== a.codeFileCount) {
          return b.codeFileCount - a.codeFileCount
        }
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        return a.extension.localeCompare(b.extension)
      })
      .slice(0, 18),
    importantFiles: files
      .map((file) => ({ file, score: importantFileScore(file) }))
      .filter(
        (entry): entry is { file: WorkspaceMapFile; score: number } =>
          entry.score !== null
      )
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.file.path.localeCompare(b.file.path, undefined, {
          sensitivity: "base",
        })
      })
      .slice(0, 14)
      .map((entry) => entry.file),
    largestFiles: files
      .slice()
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, 8),
  }
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function shouldSkipContentSearchFile(name: string): boolean {
  const lowerName = name.toLowerCase()
  if (lowerName === ".ds_store") return true
  const ext = path.extname(name).toLowerCase()
  if (CONTENT_SEARCH_BINARY_EXTENSIONS.has(ext)) return true
  if (lowerName.endsWith(".min.js") || lowerName.endsWith(".map")) return true
  return false
}

function normalizedExtension(fileName: string): string {
  const lowerName = fileName.toLowerCase()
  const ext = path.extname(lowerName)
  if (ext) return ext.slice(1)
  if (lowerName.startsWith(".")) return lowerName.slice(1)
  return "none"
}

function workspaceMapFileKind(fileName: string): WorkspaceMapFileKind {
  const lowerName = fileName.toLowerCase()
  const ext = path.extname(lowerName)
  if (SOURCE_EXTENSIONS.has(ext)) return "source"
  if (CONFIG_FILE_NAMES.has(lowerName)) return "config"
  if (DOC_EXTENSIONS.has(ext)) return "docs"
  if (DATA_EXTENSIONS.has(ext)) return "data"
  return "data"
}

function normalizedDirectory(relPath: string): string {
  const directory = path.posix.dirname(relPath)
  return directory === "." ? "" : directory
}

function topLevelDirectory(relPath: string): string {
  const firstSlash = relPath.indexOf("/")
  return firstSlash < 0 ? "" : relPath.slice(0, firstSlash)
}

function extensionLabel(extension: string): string {
  return extension === "none" ? "no ext" : `.${extension}`
}

function importantFileScore(file: WorkspaceMapFile): number | null {
  const lowerPath = file.path.toLowerCase()
  const lowerName = file.name.toLowerCase()
  if (lowerName === "package.json") return 1_000
  if (lowerName === "tsconfig.json") return 970
  if (lowerName.startsWith("vite.config")) return 950
  if (lowerName.startsWith("next.config")) return 940
  if (lowerName === "components.json") return 930
  if (lowerName === "turbo.json") return 920
  if (lowerName === "readme.md") return 880
  if (/^src\/(main|index|app)\.(t|j)sx?$/.test(lowerPath)) return 860
  if (/^app\/(page|layout)\.(t|j)sx?$/.test(lowerPath)) return 850
  if (/^src\/app\/(page|layout)\.(t|j)sx?$/.test(lowerPath)) return 840
  if (file.kind === "config" && !file.directory) return 760
  return null
}

function normalizeQuickOpenQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/\s+/g, "")
}

function scoreQuickOpenPath(relPath: string, query: string): number | null {
  const pathLower = relPath.toLowerCase()
  const baseLower = pathLower.split("/").pop() ?? pathLower
  if (!query) return 1_000 - Math.min(pathLower.length, 999)

  if (baseLower === query) return 100_000 - pathLower.length
  if (pathLower === query) return 95_000 - pathLower.length
  if (baseLower.startsWith(query)) return 90_000 - pathLower.length
  const baseIndex = baseLower.indexOf(query)
  if (baseIndex >= 0) return 80_000 - baseIndex * 20 - pathLower.length
  const pathIndex = pathLower.indexOf(query)
  if (pathIndex >= 0) return 70_000 - pathIndex * 10 - pathLower.length

  const fuzzy = fuzzyPathScore(pathLower, query)
  return fuzzy === null ? null : 40_000 + fuzzy - pathLower.length
}

function fuzzyPathScore(pathLower: string, query: string): number | null {
  let score = 0
  let pathIndex = 0
  let previousMatch = -1

  for (const char of query) {
    const matchIndex = pathLower.indexOf(char, pathIndex)
    if (matchIndex < 0) return null

    const previousChar = matchIndex > 0 ? pathLower[matchIndex - 1] : ""
    const boundary =
      matchIndex === 0 ||
      previousChar === "/" ||
      previousChar === "-" ||
      previousChar === "_" ||
      previousChar === "."
    score += boundary ? 120 : 40
    if (previousMatch >= 0)
      score -= Math.min(matchIndex - previousMatch - 1, 12)
    previousMatch = matchIndex
    pathIndex = matchIndex + 1
  }

  return score
}

async function searchFileContent(
  absPath: string,
  searchNeedle: string,
  remainingLimit: number,
  options: {
    caseSensitive: boolean
    wholeWord: boolean
    regex: RegExp | null
    regexSearch: RegexSearch | null
    root: string
  },
  budget: {
    scannedFiles: number
    scannedBytes: number
    deadline: number
  }
): Promise<ContentSearchMatch[]> {
  if (
    budget.scannedFiles >= CONTENT_SEARCH_MAX_SCANNED_FILES ||
    budget.scannedBytes >= CONTENT_SEARCH_MAX_SCANNED_BYTES ||
    Date.now() >= budget.deadline
  ) {
    return []
  }
  let stat: import("node:fs").Stats
  try {
    stat = await fs.lstat(absPath)
  } catch {
    return []
  }
  if (!stat.isFile() || stat.size > CONTENT_SEARCH_MAX_FILE_BYTES) return []
  if (budget.scannedBytes + stat.size > CONTENT_SEARCH_MAX_SCANNED_BYTES) {
    budget.scannedBytes = CONTENT_SEARCH_MAX_SCANNED_BYTES
    return []
  }
  budget.scannedFiles += 1
  budget.scannedBytes += stat.size

  let buffer: Buffer
  try {
    buffer = (
      await readWorkspaceFile(
        options.root,
        path.relative(options.root, absPath),
        CONTENT_SEARCH_MAX_FILE_BYTES
      )
    ).content
  } catch {
    return []
  }
  if (buffer.includes(0)) return []

  const text = buffer.toString("utf8")
  const matches: ContentSearchMatch[] = []
  const maxMatches = Math.min(
    CONTENT_SEARCH_MAX_MATCHES_PER_FILE,
    Math.max(remainingLimit, 0)
  )
  if (maxMatches === 0) return []

  const lines = text.split(/\r\n|\r|\n/g)
  if (options.regex && options.regexSearch) {
    const found = await options.regexSearch.match(
      text,
      options.regex,
      maxMatches,
      options.wholeWord,
      budget.deadline
    )
    return found.map((match) => {
      const preview = makeSearchPreview(
        lines[match.line] ?? "",
        match.index,
        match.length
      )
      return {
        line: match.line + 1,
        column: match.index + 1,
        length: match.length,
        previewColumn: preview.matchColumn,
        previewLength: preview.matchLength,
        preview: preview.text,
      }
    })
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (Date.now() >= budget.deadline) break
    const line = lines[index] ?? ""
    const searchLine = options.caseSensitive ? line : line.toLowerCase()
    const lineMatches = findContentMatches(searchLine, searchNeedle, {
      originalLine: line,
      wholeWord: options.wholeWord,
      regex: null,
      limit: maxMatches - matches.length,
    })
    for (const match of lineMatches) {
      const preview = makeSearchPreview(line, match.index, match.length)
      matches.push({
        line: index + 1,
        column: match.index + 1,
        length: match.length,
        previewColumn: preview.matchColumn,
        previewLength: preview.matchLength,
        preview: preview.text,
      })
      if (matches.length >= maxMatches) break
    }
    if (matches.length >= maxMatches) break
  }

  return matches
}

function findContentMatches(
  searchLine: string,
  searchNeedle: string,
  options: {
    originalLine: string
    wholeWord: boolean
    regex: RegExp | null
    limit: number
  }
): Array<{ index: number; length: number }> {
  if (options.limit <= 0) return []
  if (options.regex) {
    return findRegexContentMatches(options.originalLine, options.regex, {
      wholeWord: options.wholeWord,
      limit: options.limit,
    })
  }

  const matches: Array<{ index: number; length: number }> = []
  let cursor = 0
  while (cursor <= searchLine.length) {
    const index = searchLine.indexOf(searchNeedle, cursor)
    if (index < 0) break
    if (
      !options.wholeWord ||
      isWholeWordMatch(options.originalLine, index, searchNeedle.length)
    ) {
      matches.push({ index, length: searchNeedle.length })
      if (matches.length >= options.limit) break
    }
    cursor = index + Math.max(searchNeedle.length, 1)
  }
  return matches
}

function findRegexContentMatches(
  line: string,
  regex: RegExp,
  options: { wholeWord: boolean; limit: number }
): Array<{ index: number; length: number }> {
  const matches: Array<{ index: number; length: number }> = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    const text = match[0] ?? ""
    if (
      !options.wholeWord ||
      isWholeWordMatch(line, match.index, text.length)
    ) {
      matches.push({ index: match.index, length: Math.max(text.length, 1) })
      if (matches.length >= options.limit) break
    }
    if (text.length === 0) regex.lastIndex = match.index + 1
  }
  return matches
}

function compileContentSearchRegex(query: string, caseSensitive: boolean) {
  if (query.length > 256) {
    throw Object.assign(
      new Error("Search regex is limited to 256 characters"),
      {
        statusCode: 400,
      }
    )
  }
  // Preserve the supported syntax subset. Execution is isolated in a worker:
  // even a single repetition (a+b) can take quadratic time on a missing match.
  if (
    hasUnsafeContentSearchRegexFeatures(query) ||
    /\\(?:[1-9]|k<)/.test(query) ||
    /\(\?[=!<]/.test(query)
  ) {
    throw Object.assign(
      new Error(
        "Unsafe search regex feature: groups, multiple repetitions, lookarounds and backreferences are not supported"
      ),
      { statusCode: 400 }
    )
  }
  try {
    return new RegExp(query, caseSensitive ? "g" : "gi")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw Object.assign(new Error(`Invalid search regex: ${message}`), {
      statusCode: 400,
    })
  }
}

function hasUnsafeContentSearchRegexFeatures(query: string): boolean {
  if (/[(){}]/.test(query)) return true
  let escaped = false
  let inCharacterClass = false
  let repetitionQuantifiers = 0
  for (const char of query) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "[") {
      inCharacterClass = true
      continue
    }
    if (char === "]") {
      inCharacterClass = false
      continue
    }
    if (!inCharacterClass && (char === "*" || char === "+" || char === "?")) {
      repetitionQuantifiers += 1
      if (repetitionQuantifiers > 1) return true
    }
  }
  return false
}

function createContentSearchPathFilter(input: {
  include?: string
  exclude?: string
}): (relativePath: string, fileName: string) => boolean {
  const includeMatchers = parseSearchGlobList(input.include).map(
    createSearchGlobMatcher
  )
  const excludeMatchers = parseSearchGlobList(input.exclude).map(
    createSearchGlobMatcher
  )
  return (relativePath, fileName) => {
    const normalizedPath = normalizeSearchPath(relativePath)
    if (
      includeMatchers.length > 0 &&
      !includeMatchers.some((matcher) => matcher(normalizedPath, fileName))
    ) {
      return false
    }
    return !excludeMatchers.some((matcher) => matcher(normalizedPath, fileName))
  }
}

function parseSearchGlobList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/g)
    .map((item) => normalizeSearchPath(item.trim()))
    .filter(Boolean)
}

function createSearchGlobMatcher(
  pattern: string
): (relativePath: string, fileName: string) => boolean {
  const target = pattern.includes("/") ? "path" : "name"
  const matches = compileBoundedGlob(pattern, { caseInsensitive: true })
  return (relativePath, fileName) =>
    matches(target === "path" ? relativePath : fileName)
}

function normalizeSearchPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")
}

function isWholeWordMatch(
  line: string,
  index: number,
  length: number
): boolean {
  return (
    !isSearchWordChar(line[index - 1]) &&
    !isSearchWordChar(line[index + length])
  )
}

function isSearchWordChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_$-]/.test(value))
}

function makeSearchPreview(
  line: string,
  matchIndex: number,
  matchLength: number
): { text: string; matchColumn: number; matchLength: number } {
  const normalized = line.replace(/\t/g, "  ").trimEnd()
  const normalizedMatchIndex = line
    .slice(0, matchIndex)
    .replace(/\t/g, "  ").length
  const normalizedMatchLength = Math.max(
    1,
    line.slice(matchIndex, matchIndex + matchLength).replace(/\t/g, "  ").length
  )
  if (normalized.length <= 220) {
    const text = normalized.trimStart()
    const leadingTrimmed = normalized.length - text.length
    return {
      text,
      matchColumn: Math.max(1, normalizedMatchIndex - leadingTrimmed + 1),
      matchLength: normalizedMatchLength,
    }
  }

  const start = Math.max(0, normalizedMatchIndex - 80)
  const end = Math.min(
    normalized.length,
    normalizedMatchIndex + normalizedMatchLength + 120
  )
  const prefix = start > 0 ? "..." : ""
  const suffix = end < normalized.length ? "..." : ""
  const slice = normalized.slice(start, end)
  const trimmed = slice.trim()
  const leadingTrimmed = slice.length - slice.trimStart().length
  return {
    text: `${prefix}${trimmed}${suffix}`,
    matchColumn:
      prefix.length +
      Math.max(0, normalizedMatchIndex - start - leadingTrimmed) +
      1,
    matchLength: normalizedMatchLength,
  }
}
