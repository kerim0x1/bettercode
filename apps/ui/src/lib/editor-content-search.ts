import { isWholeWordMatch } from "@betterc0de/schema/search-text"
import { normalizeEditorPath, relativeEditorPath } from "@/lib/editor-path"
import type { EditorTab } from "@/lib/editor-store"
import type {
  WorkspaceContentSearchMatch,
  WorkspaceContentSearchOptions,
  WorkspaceContentSearchResult,
} from "@/services/backend/workspaceApi"

const MAX_OPEN_EDITOR_MATCHES_PER_FILE = 120

export interface OpenEditorContentSearch {
  results: WorkspaceContentSearchResult[]
  searchedPathKeys: Set<string>
}

export function buildOpenEditorContentSearch(input: {
  projectPath: string
  tabs: readonly EditorTab[]
  query: string
  options?: WorkspaceContentSearchOptions
}): OpenEditorContentSearch {
  const query = input.query.trim()
  const searchedPathKeys = new Set<string>()
  if (!query) return { results: [], searchedPathKeys }

  const limit = Math.min(Math.max(input.options?.limit ?? 200, 1), 500)
  const pathFilter = createOpenEditorSearchPathFilter(input.options)
  const results: WorkspaceContentSearchResult[] = []
  let totalMatches = 0
  for (const tab of input.tabs) {
    if (tab.diff) continue
    if (totalMatches >= limit) break
    const path = relativeEditorPath(input.projectPath, tab.filePath)
    if (!pathFilter(path, tab.fileName)) continue
    const key = contentSearchPathKey(path)
    searchedPathKeys.add(key)

    const matches = findOpenEditorContentMatches(
      tab.content,
      query,
      input.options
    )
    if (matches.length === 0) continue
    const limitedMatches = matches.slice(0, limit - totalMatches)
    totalMatches += limitedMatches.length
    results.push({ path, name: tab.fileName, matches: limitedMatches })
  }

  return { results, searchedPathKeys }
}

export function mergeContentSearchResultsWithOpenEditors(input: {
  diskResults: readonly WorkspaceContentSearchResult[]
  openEditors: OpenEditorContentSearch
}): WorkspaceContentSearchResult[] {
  const openByPath = new Map(
    input.openEditors.results.map((result) => [
      contentSearchPathKey(result.path),
      result,
    ])
  )
  const emitted = new Set<string>()
  const merged: WorkspaceContentSearchResult[] = []

  for (const diskResult of input.diskResults) {
    const key = contentSearchPathKey(diskResult.path)
    if (input.openEditors.searchedPathKeys.has(key)) {
      const openResult = openByPath.get(key)
      if (openResult) {
        merged.push(openResult)
        emitted.add(key)
      }
      continue
    }
    merged.push(diskResult)
    emitted.add(key)
  }

  const openOnlyResults: WorkspaceContentSearchResult[] = []
  for (const openResult of input.openEditors.results) {
    const key = contentSearchPathKey(openResult.path)
    if (emitted.has(key)) continue
    openOnlyResults.push(openResult)
    emitted.add(key)
  }

  return [...openOnlyResults, ...merged]
}

export function findOpenEditorContentMatches(
  content: string,
  query: string,
  options: WorkspaceContentSearchOptions = {}
): WorkspaceContentSearchMatch[] {
  const needle = query.trim()
  if (!needle) return []

  const caseSensitive = options.caseSensitive === true
  const regex = options.regex
    ? compileOpenEditorSearchRegex(needle, caseSensitive)
    : null
  const searchNeedle = caseSensitive ? needle : needle.toLowerCase()
  const matches: WorkspaceContentSearchMatch[] = []
  const lines = content.split(/\r\n|\r|\n/g)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const searchLine = caseSensitive ? line : line.toLowerCase()
    const lineMatches = regex
      ? findRegexContentMatches(line, regex, {
          wholeWord: options.wholeWord === true,
        })
      : findLiteralContentMatches(searchLine, searchNeedle, {
          originalLine: line,
          wholeWord: options.wholeWord === true,
        })
    for (const match of lineMatches) {
      const preview = makeOpenEditorSearchPreview(
        line,
        match.index,
        match.length
      )
      matches.push({
        line: index + 1,
        column: match.index + 1,
        length: match.length,
        previewColumn: preview.matchColumn,
        previewLength: preview.matchLength,
        preview: preview.text,
      })
      if (matches.length >= MAX_OPEN_EDITOR_MATCHES_PER_FILE) return matches
    }
  }

  return matches
}

function findLiteralContentMatches(
  searchLine: string,
  searchNeedle: string,
  options: { originalLine: string; wholeWord: boolean }
): Array<{ index: number; length: number }> {
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
    }
    cursor = index + Math.max(searchNeedle.length, 1)
  }
  return matches
}

function findRegexContentMatches(
  line: string,
  regex: RegExp,
  options: { wholeWord: boolean }
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
    }
    if (text.length === 0) regex.lastIndex = match.index + 1
  }
  return matches
}

function compileOpenEditorSearchRegex(query: string, caseSensitive: boolean) {
  try {
    return new RegExp(query, caseSensitive ? "g" : "gi")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid search regex: ${message}`)
  }
}

function makeOpenEditorSearchPreview(
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

function createOpenEditorSearchPathFilter(
  options: WorkspaceContentSearchOptions | undefined
): (relativePath: string, fileName: string) => boolean {
  const includeMatchers = parseSearchGlobList(options?.include).map(
    createSearchGlobMatcher
  )
  const excludeMatchers = parseSearchGlobList(options?.exclude).map(
    createSearchGlobMatcher
  )
  return (relativePath, fileName) => {
    const normalizedPath = normalizeEditorPath(relativePath)
    if (
      includeMatchers.length > 0 &&
      !includeMatchers.some((matcher) => matcher(normalizedPath, fileName))
    ) {
      return false
    }
    if (
      excludeMatchers.length > 0 &&
      excludeMatchers.some((matcher) => matcher(normalizedPath, fileName))
    ) {
      return false
    }
    return true
  }
}

function parseSearchGlobList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/g)
    .map((item) =>
      normalizeEditorPath(item.trim()).replace(/^\.\//, "").replace(/^\/+/, "")
    )
    .filter(Boolean)
}

function createSearchGlobMatcher(
  pattern: string
): (relativePath: string, fileName: string) => boolean {
  const target = pattern.includes("/") ? "path" : "name"
  const regex = new RegExp(`^${globPatternToRegExpSource(pattern)}$`, "i")
  return (relativePath, fileName) =>
    regex.test(target === "path" ? relativePath : fileName)
}

function globPatternToRegExpSource(pattern: string): string {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?"
          index += 2
        } else {
          source += ".*"
          index += 1
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += escapeRegexChar(char)
  }
  return source
}

function escapeRegexChar(value: string | undefined): string {
  return value ? value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : ""
}

function contentSearchPathKey(path: string): string {
  return normalizeEditorPath(path).toLowerCase()
}
