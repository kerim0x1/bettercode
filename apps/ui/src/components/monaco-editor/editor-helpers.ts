import type { editor as MonacoEditor, IRange } from "monaco-editor"
import { useEditorStore, type EditorSelectionContext } from "@/lib/editor-store"

/** LCS-based line diff → per-line operations for decoration rendering. */
export type LineDiffOp =
  | { type: "same"; newLine: number }
  | { type: "add"; newLine: number }
  | { type: "remove"; beforeNewLine: number; text: string }

export const DEFAULT_MONACO_FONT_FAMILY =
  "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace"

export function resolveMonacoFontFamily(value: string): string {
  const fontFamily = value.trim()
  if (!fontFamily) return DEFAULT_MONACO_FONT_FAMILY
  return `'${fontFamily.replace(/'/g, "\\'")}', ${DEFAULT_MONACO_FONT_FAMILY}`
}

export function computeLineDiff(
  oldText: string,
  newText: string
): LineDiffOp[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const m = a.length
  const n = b.length
  // Guard against pathologically huge files — fall back to a no-op diff.
  if (m * n > 2_000_000)
    return b.map((_, i) => ({ type: "same", newLine: i + 1 }))

  const dp: Uint32Array[] = Array.from(
    { length: m + 1 },
    () => new Uint32Array(n + 1)
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const ops: LineDiffOp[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "same", newLine: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", newLine: j })
      j--
    } else {
      // Removal: attribute to the line that will come next in the new file
      ops.push({ type: "remove", beforeNewLine: j + 1, text: a[i - 1] })
      i--
    }
  }
  return ops.reverse()
}

export function selectionStats(
  editor: MonacoEditor.IStandaloneCodeEditor,
  range: IRange
): EditorSelectionContext {
  const model = editor.getModel()
  const empty = {
    lineCount: 0,
    charCount: 0,
    startLine: range.startLineNumber,
    startColumn: range.startColumn,
    endLine: range.endLineNumber,
    endColumn: range.endColumn,
    text: "",
  }
  if (!model) return empty
  const text = model.getValueInRange(range)
  if (!text) return empty
  return {
    lineCount: Math.max(
      1,
      Math.abs(range.endLineNumber - range.startLineNumber) + 1
    ),
    charCount: text.length,
    startLine: range.startLineNumber,
    startColumn: range.startColumn,
    endLine: range.endLineNumber,
    endColumn: range.endColumn,
    text,
  }
}

export function editorCommandTargetsFile(
  detail: { filePath?: string } | undefined,
  filePath: string
): boolean {
  if (detail?.filePath) return detail.filePath === filePath
  const state = useEditorStore.getState()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  return activeTab?.filePath === filePath
}
