import { useEditorStore } from "@/lib/editor-store"
import {
  buildOpenEditorWorkspaceSymbolSources,
  buildWorkspaceDefinitionCandidates,
  type WorkspaceDefinitionCandidate,
  type WorkspaceSymbolSource,
} from "@/lib/workspace-symbols"
import {
  quickOpenFiles,
  readFile,
  searchContent,
  type WorkspaceContentSearchResult,
  type WorkspaceQuickOpenFile,
} from "@/services/backend/workspaceApi"

/**
 * Go to Definition across the workspace: the open editor tabs plus the files
 * a content and file-name search for the symbol turns up.
 */
const DEFINITION_SEARCH_LIMIT = 100
const DEFINITION_FILE_LIMIT = 32

export async function resolveWorkspaceDefinition(input: {
  projectPath?: string | null
  currentFilePath: string
  currentContent: string
  symbol: string
  originLine: number
  originColumn: number
}): Promise<WorkspaceDefinitionCandidate | null> {
  const openEditorSources = buildOpenEditorWorkspaceSymbolSources({
    projectPath: input.projectPath,
    currentFilePath: input.currentFilePath,
    currentContent: input.currentContent,
    tabs: useEditorStore.getState().tabs,
  })
  const sources = [...openEditorSources.sources]

  if (input.projectPath) {
    const [contentSearch, fileSearch] = await Promise.allSettled([
      searchContent(input.projectPath, input.symbol, DEFINITION_SEARCH_LIMIT),
      quickOpenFiles(input.projectPath, input.symbol, DEFINITION_SEARCH_LIMIT),
    ])

    const files = uniqueDefinitionFiles(
      contentSearch.status === "fulfilled" ? contentSearch.value : [],
      fileSearch.status === "fulfilled" ? fileSearch.value : [],
      openEditorSources.sourcePathKeys
    ).slice(0, DEFINITION_FILE_LIMIT)

    const loadedSources = await Promise.all(
      files.map(async (file) => {
        const filePath = joinWorkspacePath(input.projectPath!, file.path)
        try {
          const loaded = await readFile(filePath, { silent404: true })
          return {
            filePath,
            relativePath: file.path,
            content: loaded.content,
          } satisfies WorkspaceSymbolSource
        } catch {
          return null
        }
      })
    )
    for (const source of loadedSources) {
      if (source) sources.push(source)
    }
  }

  const definitions = buildWorkspaceDefinitionCandidates(sources, {
    symbol: input.symbol,
    originFilePath: input.currentFilePath,
    originLine: input.originLine,
    originColumn: input.originColumn,
  })
  return definitions[0] ?? null
}

function uniqueDefinitionFiles(
  contentResults: readonly WorkspaceContentSearchResult[],
  fileResults: readonly WorkspaceQuickOpenFile[],
  excludedPathKeys: ReadonlySet<string>
): Array<{ path: string; name: string }> {
  const seen = new Set(excludedPathKeys)
  const out: Array<{ path: string; name: string }> = []
  for (const result of [...contentResults, ...fileResults]) {
    const key = normalizePath(result.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: result.path, name: result.name })
  }
  return out
}

function joinWorkspacePath(projectPath: string, relativePath: string): string {
  const separator = projectPath.includes("\\") ? "\\" : "/"
  const base = projectPath.replace(/[\\/]+$/, "")
  const relative = relativePath.replace(/^[\\/]+/, "")
  return `${base}${separator}${relative}`
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/")
}
