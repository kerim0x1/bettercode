import { editorModelUri } from "@/lib/editor-path"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"

/**
 * The structural slice of the Monaco namespace this module needs. The real
 * `typeof import("monaco-editor")` satisfies it; tests pass a fake.
 */
interface MonacoModelLike {
  readonly uri: { readonly scheme: string; toString(): string }
  isDisposed(): boolean
  dispose(): void
}

export interface MonacoModelApi {
  readonly Uri: { parse(value: string): { toString(): string } }
  readonly editor: {
    getModels(): readonly MonacoModelLike[]
    getEditors(): readonly { getModel(): MonacoModelLike | null }[]
  }
}

/** Monaco URIs (in Monaco's own string form) of every open editable text tab. */
export function openEditorModelUris(
  monaco: Pick<MonacoModelApi, "Uri">,
  tabs: readonly EditorTab[]
): Set<string> {
  const uris = new Set<string>()
  for (const tab of tabs) {
    if (tab.diff || (tab.fileKind ?? "text") !== "text") continue
    // Monaco normalises drive letters and escapes, so compare parsed forms.
    uris.add(monaco.Uri.parse(editorModelUri(tab.filePath)).toString())
  }
  return uris
}

/**
 * Dispose file models that no open editor tab owns and no mounted editor
 * shows. `@monaco-editor/react` swaps models on a `path` change without
 * disposing the previous one, so without this every file reached by a tab
 * switch keeps its text buffer, tokens, undo stack and TypeScript worker
 * mirror until the app quits. Models of open tabs (dirty or not) are kept,
 * which preserves each open file's undo history across tab switches.
 */
export function disposeDetachedEditorModels(
  monaco: MonacoModelApi,
  tabs: readonly EditorTab[]
): number {
  const keep = openEditorModelUris(monaco, tabs)
  const attached = new Set<MonacoModelLike>()
  for (const editor of monaco.editor.getEditors()) {
    const model = editor.getModel()
    if (model) attached.add(model)
  }
  let disposed = 0
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== "file" || model.isDisposed()) continue
    if (attached.has(model) || keep.has(model.uri.toString())) continue
    model.dispose()
    disposed += 1
  }
  return disposed
}

function openTextTabKey(tabs: readonly EditorTab[]): string {
  let key = ""
  for (const tab of tabs) {
    if (tab.diff || (tab.fileKind ?? "text") !== "text") continue
    key += `${tab.filePath}\n`
  }
  return key
}

let activeMonaco: MonacoModelApi | null = null
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeStore: (() => void) | null = null

/**
 * Run a cleanup after the current task, so React has committed the editor's
 * switch to its next model before detached models are judged.
 */
export function scheduleEditorModelCleanup(): void {
  if (!activeMonaco || cleanupTimer !== null) return
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null
    if (!activeMonaco) return
    disposeDetachedEditorModels(activeMonaco, useEditorStore.getState().tabs)
  }, 0)
}

/**
 * Start disposing models whenever the set of open text tabs changes (close,
 * close others, preview reuse, rename, delete). Idempotent; returns a stop
 * function for tests.
 */
export function installEditorModelDisposal(monaco: MonacoModelApi): () => void {
  activeMonaco = monaco
  if (!unsubscribeStore) {
    let previousKey = openTextTabKey(useEditorStore.getState().tabs)
    unsubscribeStore = useEditorStore.subscribe((state, previous) => {
      if (state.tabs === previous.tabs) return
      const key = openTextTabKey(state.tabs)
      if (key === previousKey) return
      previousKey = key
      scheduleEditorModelCleanup()
    })
  }
  return () => {
    unsubscribeStore?.()
    unsubscribeStore = null
    activeMonaco = null
    if (cleanupTimer !== null) clearTimeout(cleanupTimer)
    cleanupTimer = null
  }
}
