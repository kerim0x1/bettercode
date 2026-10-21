import {
  readFile,
  writeFile,
  type WorkspaceContentSearchResult,
} from "@/services/backend/workspaceApi"
import {
  normalizeEditorPath,
  resolveWorkspaceFilePath,
} from "@/lib/editor-path"
import { useEditorStore } from "@/lib/editor-store"
import { replaceLiteralInContent } from "@/lib/workspace-replace"

export interface WorkspaceSearchReplaceOutcome {
  replacements: number
  changedFiles: number
}

export interface WorkspaceSearchReplaceInput {
  projectPath: string
  query: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  preserveCase: boolean
  results: readonly WorkspaceContentSearchResult[]
}

export async function replaceWorkspaceSearchResults(
  input: WorkspaceSearchReplaceInput
): Promise<WorkspaceSearchReplaceOutcome> {
  const targets = input.results.map((result) => ({
    relativePath: result.path,
    filePath: resolveWorkspaceFilePath(input.projectPath, result.path),
  }))
  const targetPathSet = new Set(
    targets.map((target) => normalizeEditorPath(target.filePath).toLowerCase())
  )
  const dirtyTarget = useEditorStore
    .getState()
    .tabs.find(
      (tab) =>
        tab.isDirty &&
        targetPathSet.has(normalizeEditorPath(tab.filePath).toLowerCase())
    )
  if (dirtyTarget) {
    throw new Error(`Save or close ${dirtyTarget.fileName} before replacing.`)
  }

  const changes: Array<{
    filePath: string
    relativePath: string
    content: string
    replacements: number
  }> = []

  for (const target of targets) {
    const loaded = await readFile(target.filePath, { silent404: true })
    const replaced = replaceLiteralInContent(
      loaded.content,
      input.query,
      input.replacement,
      {
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        preserveCase: input.preserveCase,
      }
    )
    if (replaced.count === 0) continue
    changes.push({
      ...target,
      content: replaced.content,
      replacements: replaced.count,
    })
  }

  for (const change of changes) {
    await writeFile(input.projectPath, change.relativePath, change.content)
  }

  const openCleanPaths = new Set(
    useEditorStore
      .getState()
      .tabs.filter((tab) => !tab.isDirty)
      .map((tab) => normalizeEditorPath(tab.filePath).toLowerCase())
  )
  for (const change of changes) {
    if (!openCleanPaths.has(normalizeEditorPath(change.filePath).toLowerCase()))
      continue
    await useEditorStore.getState().reloadFromDisk(change.filePath)
  }

  return {
    changedFiles: changes.length,
    replacements: changes.reduce(
      (total, change) => total + change.replacements,
      0
    ),
  }
}
