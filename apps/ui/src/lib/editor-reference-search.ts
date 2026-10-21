import { isWholeWordMatch } from "@betterc0de/schema/search-text"
import { relativeEditorPath, normalizeEditorPath } from "@/lib/editor-path"
import { isReferenceSearchableSymbol } from "@/lib/editor-references-store"
import type { EditorTab } from "@/lib/editor-store"
import type {
  WorkspaceContentSearchMatch,
  WorkspaceContentSearchResult,
} from "@/services/backend/workspaceApi"

const MAX_OPEN_EDITOR_MATCHES_PER_FILE = 120

export interface OpenEditorReferenceSearch {
  results: WorkspaceContentSearchResult[]
  searchedPathKeys: Set<string>
}

export function buildOpenEditorReferenceSearch(input: {
  projectPath: string
  tabs: readonly EditorTab[]
  symbol: string
}): OpenEditorReferenceSearch {
  const symbol = input.symbol.trim()
  const searchedPathKeys = new Set<string>()
  if (!isReferenceSearchableSymbol(symbol)) {
    return { results: [], searchedPathKeys }
  }

  const results: WorkspaceContentSearchResult[] = []
  for (const tab of input.tabs) {
    if (tab.diff) continue
    const path = relativeEditorPath(input.projectPath, tab.filePath)
    searchedPathKeys.add(referencePathKey(path))
    const matches = findOpenEditorSymbolMatches(tab.content, symbol)
    if (matches.length === 0) continue
    results.push({
      path,
      name: tab.fileName,
      matches,
    })
  }

  return { results, searchedPathKeys }
}

export function mergeReferenceResultsWithOpenEditors(input: {
  diskResults: readonly WorkspaceContentSearchResult[]
  openEditors: OpenEditorReferenceSearch
}): WorkspaceContentSearchResult[] {
  const openByPath = new Map(
    input.openEditors.results.map((result) => [
      referencePathKey(result.path),
      result,
    ])
  )
  const emitted = new Set<string>()
  const merged: WorkspaceContentSearchResult[] = []

  for (const diskResult of input.diskResults) {
    const key = referencePathKey(diskResult.path)
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
    const key = referencePathKey(openResult.path)
    if (emitted.has(key)) continue
    openOnlyResults.push(openResult)
    emitted.add(key)
  }

  return [...openOnlyResults, ...merged]
}

export function findOpenEditorSymbolMatches(
  content: string,
  symbol: string
): WorkspaceContentSearchMatch[] {
  const needle = symbol.trim()
  if (!isReferenceSearchableSymbol(needle)) return []

  const matches: WorkspaceContentSearchMatch[] = []
  const lines = content.split(/\r\n|\r|\n/g)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    let cursor = 0
    while (cursor <= line.length) {
      const matchIndex = line.indexOf(needle, cursor)
      if (matchIndex < 0) break
      if (isWholeWordMatch(line, matchIndex, needle.length)) {
        const preview = makeOpenEditorSearchPreview(
          line,
          matchIndex,
          needle.length
        )
        matches.push({
          line: index + 1,
          column: matchIndex + 1,
          length: needle.length,
          previewColumn: preview.matchColumn,
          previewLength: preview.matchLength,
          preview: preview.text,
        })
        if (matches.length >= MAX_OPEN_EDITOR_MATCHES_PER_FILE) {
          return matches
        }
      }
      cursor = matchIndex + Math.max(needle.length, 1)
    }
  }
  return matches
}

function referencePathKey(path: string): string {
  return normalizeEditorPath(path).toLowerCase()
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
