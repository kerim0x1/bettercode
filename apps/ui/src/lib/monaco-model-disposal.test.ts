import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { editorModelUri } from "@/lib/editor-path"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"
import {
  disposeDetachedEditorModels,
  installEditorModelDisposal,
  scheduleEditorModelCleanup,
  type MonacoModelApi,
} from "@/lib/monaco-model-disposal"

vi.mock("@/services/backend/workspaceApi", () => ({
  readFile: vi.fn(async (filePath: string) => ({
    path: filePath,
    content: "",
  })),
  writeFile: vi.fn(async () => undefined),
}))

interface FakeModel {
  uri: { scheme: string; toString(): string }
  disposed: boolean
  isDisposed(): boolean
  dispose(): void
}

function fakeModel(uri: string): FakeModel {
  const model: FakeModel = {
    uri: { scheme: uri.split(":")[0] ?? "", toString: () => uri },
    disposed: false,
    isDisposed: () => model.disposed,
    dispose: () => {
      model.disposed = true
    },
  }
  return model
}

function fakeMonaco(
  models: FakeModel[],
  shown: FakeModel[] = []
): MonacoModelApi {
  return {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      getModels: () => models.filter((model) => !model.disposed),
      getEditors: () => shown.map((model) => ({ getModel: () => model })),
    },
  }
}

function tab(filePath: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: filePath,
    filePath,
    fileName: filePath.split("/").pop() ?? filePath,
    language: "typescript",
    content: "",
    originalContent: "",
    revision: 0,
    readGeneration: 0,
    documentVersion: 0,
    aiBaselineContent: null,
    isDirty: false,
    isLoading: false,
    isPinned: false,
    isPreview: false,
    cursorLine: 1,
    cursorColumn: 1,
    selectionLineCount: 0,
    selectionCharCount: 0,
    ...overrides,
  }
}

describe("disposeDetachedEditorModels", () => {
  it("disposes file models that no open tab owns and no editor shows", () => {
    const open = fakeModel(editorModelUri("/repo/open.ts"))
    const dirty = fakeModel(editorModelUri("/repo/dirty.ts"))
    const shown = fakeModel(editorModelUri("/repo/modal.ts"))
    const closed = fakeModel(editorModelUri("/repo/closed.ts"))
    const inMemory = fakeModel("inmemory://model/1")
    const monaco = fakeMonaco([open, dirty, shown, closed, inMemory], [shown])

    const disposed = disposeDetachedEditorModels(monaco, [
      tab("/repo/open.ts"),
      tab("/repo/dirty.ts", { isDirty: true }),
    ])

    expect(disposed).toBe(1)
    expect(closed.disposed).toBe(true)
    expect(open.disposed).toBe(false)
    expect(dirty.disposed).toBe(false)
    expect(shown.disposed).toBe(false)
    expect(inMemory.disposed).toBe(false)
  })

  it("does not keep models for comparison or preview tabs with the same path", () => {
    const model = fakeModel(editorModelUri("/repo/a.ts"))
    const monaco = fakeMonaco([model])

    disposeDetachedEditorModels(monaco, [
      tab("/repo/a.ts", {
        diff: { cwd: "/repo", path: "a.ts", source: "unstaged" },
      }),
    ])

    expect(model.disposed).toBe(true)
  })
})

describe("installEditorModelDisposal", () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    useEditorStore.setState({
      tabs: [tab("/repo/a.ts"), tab("/repo/b.ts")],
      activeTabId: "/repo/a.ts",
    })
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it("releases a closed tab's model after the editor moved on", () => {
    const a = fakeModel(editorModelUri("/repo/a.ts"))
    const b = fakeModel(editorModelUri("/repo/b.ts"))
    stop = installEditorModelDisposal(fakeMonaco([a, b], [a]))

    useEditorStore.getState().closeTab("/repo/b.ts")
    expect(b.disposed).toBe(false)
    vi.runAllTimers()

    expect(b.disposed).toBe(true)
    expect(a.disposed).toBe(false)
  })

  it("ignores edits that do not change the set of open files", () => {
    const a = fakeModel(editorModelUri("/repo/a.ts"))
    const orphan = fakeModel(editorModelUri("/repo/orphan.ts"))
    stop = installEditorModelDisposal(fakeMonaco([a, orphan], [a]))

    useEditorStore.getState().updateContent("/repo/a.ts", "edited")
    vi.runAllTimers()
    expect(orphan.disposed).toBe(false)

    scheduleEditorModelCleanup()
    vi.runAllTimers()
    expect(orphan.disposed).toBe(true)
  })
})
