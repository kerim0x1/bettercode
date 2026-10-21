import { useChatStore } from "@/lib/chat-store"
import { buildCodeOutline } from "@/lib/code-outline"
import { dispatchEditorGotoLine } from "@/lib/editor-go-to-line"
import { useEditorStore } from "@/lib/editor-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  parseSourceReference,
  resolveSourceTarget,
  type ParseSourceReferenceOptions,
  type ResolveSourceTargetOptions,
  type SourceOpenTarget,
} from "@/lib/source-target"
import { getElectronApi } from "@/services/ipc-facade"

export interface OpenSourceTargetOptions extends ResolveSourceTargetOptions {
  /** Open the file in a reusable preview tab. */
  preview?: boolean
  /** Do not add the current editor location to navigation history. */
  preserveNavigation?: boolean
  /** Switch to BetterC0de's editor surface before revealing a file. */
  activateEditor?: boolean
}

export interface OpenSourceReferenceOptions
  extends OpenSourceTargetOptions, ParseSourceReferenceOptions {}

/**
 * Resolves and opens a typed target through BetterC0de's existing editor and
 * Electron browser seams. Returns `false` for rejected/unsupported targets
 * instead of throwing into chat, tool, or search renderers.
 */
export async function openSourceTarget(
  target: SourceOpenTarget,
  options: OpenSourceTargetOptions = {}
): Promise<boolean> {
  const workspacePath =
    options.workspacePath === undefined
      ? activeThreadWorkspacePath()
      : options.workspacePath
  const resolved = resolveSourceTarget(target, {
    workspacePath,
    allowOutsideWorkspace: options.allowOutsideWorkspace,
  })
  if (!resolved) return false

  if (resolved.kind === "external") {
    return openExternalTarget(resolved.url)
  }

  try {
    if (options.activateEditor !== false) {
      usePreferencesStore.getState().set("appMode", "editor")
    }
    await useEditorStore.getState().openFile(resolved.filePath, {
      line: resolved.line,
      column: resolved.column,
      preserveNavigation: options.preserveNavigation,
      preview: options.preview,
    })
    const symbolLocation =
      resolved.kind === "symbol" && resolved.line === undefined
        ? resolveOpenEditorSymbol(resolved.filePath, resolved.symbol)
        : null
    const line = resolved.line ?? symbolLocation?.line
    const column = resolved.column ?? symbolLocation?.column
    if (line !== undefined) {
      dispatchEditorGotoLine(
        {
          filePath: resolved.filePath,
          line,
          column: column ?? 1,
          endLine: resolved.endLine,
          endColumn: resolved.endColumn,
          // openFile already recorded the navigation transition.
          preserveNavigation: true,
        },
        { defer: true }
      )
    }
    return true
  } catch {
    return false
  }
}

export async function openSourceReference(
  reference: string,
  options: OpenSourceReferenceOptions = {}
): Promise<boolean> {
  const target = parseSourceReference(reference, {
    requirePathSignal: options.requirePathSignal,
  })
  if (!target) return false
  return openSourceTarget(target, options)
}

function resolveOpenEditorSymbol(
  filePath: string,
  symbol: string
): { line: number; column: number } | null {
  const tab = useEditorStore
    .getState()
    .tabs.find((candidate) => candidate.filePath === filePath)
  if (!tab || !tab.content) return null

  const outline = buildCodeOutline({
    content: tab.content,
    language: tab.language,
    fileName: tab.fileName,
  })
  const qualifiedTail = symbol.split(/[.#:]/).at(-1)?.trim() || symbol
  const exact =
    outline.find((entry) => entry.name === symbol) ??
    outline.find((entry) => entry.name === qualifiedTail)
  const match =
    exact ??
    outline.find(
      (entry) => entry.name.toLowerCase() === qualifiedTail.toLowerCase()
    )
  return match ? { line: match.line, column: match.column } : null
}

export function activeThreadWorkspacePath(): string | null {
  const state = useChatStore.getState()
  const activeThread = state.activeThreadId
    ? state.threads.find((thread) => thread.id === state.activeThreadId)
    : null
  const workspacePath =
    activeThread?.worktreePath?.trim() || activeThread?.projectPath?.trim()
  return workspacePath || null
}

async function openExternalTarget(url: string): Promise<boolean> {
  if (typeof window === "undefined") return false
  try {
    const desktopBridge = getElectronApi()
    if (desktopBridge?.openExternal) {
      await desktopBridge.openExternal(url)
      return true
    }
    window.open(url, "_blank", "noopener,noreferrer")
    return true
  } catch {
    return false
  }
}
