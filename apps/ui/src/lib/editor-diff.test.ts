import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile, writeFile } from "@/services/backend"
import { useEditorStore } from "./editor-store"
import { editorDiffKey, type EditorDiffTarget } from "./editor-diff"
import { buildOpenEditorContentSearch } from "./editor-content-search"
import { buildOpenEditorReferenceSearch } from "./editor-reference-search"

vi.mock("@/services/backend", () => ({
  readFile: vi.fn(async (path: string) => ({ path, content: "saved text" })),
  writeFile: vi.fn(async () => undefined),
}))

const changes: EditorDiffTarget = {
  cwd: "C:/repo",
  path: "src/app.ts",
  source: "unstaged",
}
const staged: EditorDiffTarget = { ...changes, source: "staged" }
const store = () => useEditorStore.getState()
const active = () => store().tabs.find((tab) => tab.id === store().activeTabId)!

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    recentlyClosedTabs: [],
    recentFiles: [],
    navigationBackStack: [],
    navigationForwardStack: [],
  })
  vi.clearAllMocks()
})

describe("editor diff documents", () => {
  it("keeps the editable file, index and working tree comparisons separate", async () => {
    await store().openFile("C:/repo/src/app.ts")
    const file = active()
    store().updateContent(file.id, "unsaved edit")
    store().openDiff(changes)
    store().openDiff(staged)
    store().openDiff({ ...changes, cwd: "C:\\repo\\", path: "src\\app.ts" })
    expect(store().tabs).toHaveLength(3)
    expect(active().diff).toEqual(changes)
    await store().openFile(file.filePath)
    expect(active()).toMatchObject({
      id: file.id,
      content: "unsaved edit",
      isDirty: true,
    })
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it("never writes comparison content or loads deleted paths as text", async () => {
    store().openDiff({ ...changes, path: "deleted.ts" })
    store().updateContent(active().id, "accidental edit")
    await store().saveActiveTab()
    await store().saveAllTabs()
    await store().reloadFromDisk(active().filePath)
    await store().reloadFromAi(active().filePath)
    expect(active()).toMatchObject({ content: "", isDirty: false })
    expect(readFile).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    store().handlePathDeleted(active().filePath)
    expect(store().tabs).toHaveLength(1)
  })

  it("reuses a diff preview until kept open, and preserves pinned documents", () => {
    store().openDiff(changes, { preview: true })
    store().openDiff(staged, { preview: true })
    expect(store().tabs).toHaveLength(1)
    store().openDiff(staged)
    expect(active().isPreview).toBe(false)
    const pinned = active().id
    store().togglePinTab(pinned)
    store().openDiff(changes, { preview: true })
    store().closeAllTabs()
    expect(store().tabs.map((tab) => tab.id)).toEqual([pinned])
  })

  it("restores the comparison source through back, forward and reopening", async () => {
    await store().openFile("C:/repo/src/app.ts")
    store().openDiff(changes)
    store().openDiff(staged)
    await store().goBack()
    expect(active().diff).toEqual(changes)
    await store().goBack()
    expect(active().diff).toBeUndefined()
    await store().goForward()
    expect(active().diff).toEqual(changes)
    store().closeTab(active().id)
    await store().reopenClosedTab()
    expect(active().diff).toEqual(changes)
    expect(store().tabs).toHaveLength(3)
    expect(store().recentFiles).toHaveLength(1)
  })

  it("reopens staged and unstaged tabs independently after both are closed", async () => {
    store().openDiff(changes)
    store().openDiff(staged)
    store().closeAllTabs()
    expect(store().recentlyClosedTabs).toHaveLength(2)
    await store().reopenClosedTab()
    await store().reopenClosedTab()
    expect(new Set(store().tabs.map((tab) => tab.diff?.source))).toEqual(
      new Set(["staged", "unstaged"])
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it("keeps worktrees isolated and does not rebase Git revision paths", () => {
    store().openDiff(changes)
    store().openDiff({ ...changes, cwd: "C:/worktrees/test" })
    expect(store().tabs).toHaveLength(2)
    store().handlePathMoved(
      "C:/worktrees/test/src/app.ts",
      "C:/worktrees/test/src/new.ts"
    )
    expect(active().filePath).toBe("C:/worktrees/test/src/app.ts")
    expect(active().diff?.path).toBe("src/app.ts")
    expect(editorDiffKey(changes)).not.toBe(editorDiffKey(active().diff!))
  })

  it("does not let a comparison's empty buffer hide source search results", () => {
    store().openDiff(changes)
    const input = { projectPath: changes.cwd, tabs: store().tabs }
    expect(
      buildOpenEditorContentSearch({ ...input, query: "title" })
        .searchedPathKeys.size
    ).toBe(0)
    expect(
      buildOpenEditorReferenceSearch({ ...input, symbol: "title" })
        .searchedPathKeys.size
    ).toBe(0)
  })

  it("ignores late file reads when a diff replaces a loading file preview", async () => {
    let resolve!: (value: { path: string; content: string }) => void
    vi.mocked(readFile).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const opening = store().openFile("C:/repo/src/slow.ts", { preview: true })
    store().openDiff(changes, { preview: true })
    resolve({ path: "C:/repo/src/slow.ts", content: "late response" })
    await opening
    expect(active()).toMatchObject({
      diff: changes,
      content: "",
      isDirty: false,
    })
    expect(store().tabs).toHaveLength(1)
  })
})
