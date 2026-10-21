import { beforeEach, expect, it, vi } from "vitest"
import {
  captureEditorDocument,
  EditorSaveError,
  useEditorStore,
} from "./editor-store"
import { readFile, writeFile } from "@/services/backend/workspaceApi"

vi.mock("@/services/backend/workspaceApi", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    navigationBackStack: [],
    navigationForwardStack: [],
    recentlyClosedTabs: [],
    recentFiles: [],
  })
  vi.mocked(readFile).mockResolvedValue({ path: "/repo/a.ts", content: "base" })
})
const tab = () => useEditorStore.getState().tabs[0]!
async function open() {
  await useEditorStore.getState().openFile("/repo/a.ts")
  return tab().id
}

it("keeps edits made during save dirty, with the baseline equal to the bytes written", async () => {
  const id = await open()
  useEditorStore.getState().updateContent(id, "version A")
  const write = deferred<void>()
  vi.mocked(writeFile).mockReturnValue(write.promise)
  const saving = useEditorStore.getState().saveTab(id)
  await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
  useEditorStore.getState().updateContent(id, "version B")
  write.resolve()
  await saving
  expect(writeFile).toHaveBeenCalledWith("/repo/", "a.ts", "version A")
  expect(tab()).toMatchObject({
    content: "version B",
    originalContent: "version A",
    isDirty: true,
  })
  useEditorStore.getState().closeSavedTabs()
  expect(tab().content).toBe("version B")
})

it("serializes saves in invocation order and leaves later edits dirty", async () => {
  const id = await open()
  const first = deferred<void>(),
    second = deferred<void>()
  vi.mocked(writeFile)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  useEditorStore.getState().updateContent(id, "A")
  const a = useEditorStore.getState().saveTab(id)
  useEditorStore.getState().updateContent(id, "B")
  const b = useEditorStore.getState().saveTab(id)
  await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
  first.resolve()
  await a
  await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2))
  useEditorStore.getState().updateContent(id, "C")
  second.resolve()
  await b
  expect(vi.mocked(writeFile).mock.calls.map((call) => call[2])).toEqual([
    "A",
    "B",
  ])
  expect(tab()).toMatchObject({
    content: "C",
    originalContent: "B",
    isDirty: true,
  })
})

it.each(["openFile", "reloadFromAi", "reloadFromDisk"] as const)(
  "%s preserves edits made during its read",
  async (method) => {
    const id = await open()
    const reading = deferred<{ path: string; content: string }>()
    vi.mocked(readFile).mockReturnValue(reading.promise)
    const pending = useEditorStore.getState()[method]("/repo/a.ts")
    useEditorStore.getState().updateContent(id, "human edit")
    reading.resolve({ path: "/repo/a.ts", content: "disk edit" })
    await pending
    expect(tab()).toMatchObject({
      content: "human edit",
      originalContent: "base",
      isDirty: true,
    })
  }
)

it("does not accept an old read even after the user edits back to the original bytes", async () => {
  const id = await open()
  const reading = deferred<{ path: string; content: string }>()
  vi.mocked(readFile).mockReturnValue(reading.promise)
  const pending = useEditorStore.getState().reloadFromDisk("/repo/a.ts")
  useEditorStore.getState().updateContent(id, "edit")
  useEditorStore.getState().updateContent(id, "base")
  reading.resolve({ path: "/repo/a.ts", content: "obsolete response" })
  await pending
  expect(tab().content).toBe("base")
})

it("ignores older read responses and stale initial-load errors after preview reuse", async () => {
  await open()
  const old = deferred<{ path: string; content: string }>()
  vi.mocked(readFile)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ path: "/repo/a.ts", content: "newest" })
  const first = useEditorStore.getState().reloadFromAi("/repo/a.ts")
  await useEditorStore.getState().reloadFromDisk("/repo/a.ts")
  old.resolve({ path: "/repo/a.ts", content: "older" })
  await first
  expect(tab().content).toBe("newest")
  useEditorStore.getState().closeAllTabs()
  const initial = deferred<{ path: string; content: string }>()
  vi.mocked(readFile)
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce({ path: "/repo/b.ts", content: "B" })
  const a = useEditorStore.getState().openFile("/repo/a.ts", { preview: true })
  await useEditorStore.getState().openFile("/repo/b.ts", { preview: true })
  initial.reject(new Error("A unavailable"))
  await a
  expect(tab()).toMatchObject({
    filePath: "/repo/b.ts",
    content: "B",
    isLoading: false,
  })
})

it("does not mark a renamed document saved when the old path's write completes", async () => {
  const id = await open()
  useEditorStore.getState().updateContent(id, "edit")
  const writing = deferred<void>()
  vi.mocked(writeFile).mockReturnValueOnce(writing.promise)
  const pending = useEditorStore.getState().saveTab(id)
  await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
  useEditorStore.getState().handlePathMoved("/repo/a.ts", "/repo/b.ts")
  writing.resolve()
  await pending
  expect(tab()).toMatchObject({
    filePath: "/repo/b.ts",
    originalContent: "base",
    isDirty: true,
  })
})

it("rejects failed saves, keeps the dirty baseline, and permits a later retry", async () => {
  const id = await open()
  useEditorStore.getState().updateContent(id, "edit")
  vi.mocked(writeFile)
    .mockRejectedValueOnce(new Error("ENOSPC"))
    .mockResolvedValueOnce(undefined)
  await expect(useEditorStore.getState().saveTab(id)).rejects.toBeInstanceOf(
    EditorSaveError
  )
  expect(tab()).toMatchObject({
    content: "edit",
    originalContent: "base",
    isDirty: true,
  })
  await expect(useEditorStore.getState().saveTab(id)).resolves.toMatchObject({
    status: "saved",
    hasUnsavedChanges: false,
  })
  expect(tab().isDirty).toBe(false)
})

it("reports Save All failures while still saving independent files", async () => {
  const id = await open()
  useEditorStore.getState().updateContent(id, "edit A")
  await useEditorStore.getState().openFile("/repo/b.ts")
  const second = useEditorStore.getState().tabs[1]!
  useEditorStore.getState().updateContent(second.id, "edit B")
  vi.mocked(writeFile)
    .mockRejectedValueOnce(new Error("ENOSPC"))
    .mockResolvedValueOnce(undefined)
  await expect(useEditorStore.getState().saveAllTabs()).rejects.toThrow(
    "/repo/a.ts"
  )
  expect(useEditorStore.getState().tabs.map((tab) => tab.isDirty)).toEqual([
    true,
    false,
  ])
})

it("commits all versioned changes together and leaves them dirty", async () => {
  await open()
  const expected = captureEditorDocument(tab())
  const result = useEditorStore
    .getState()
    .applyDocumentChanges([{ expected, content: "renamed" }])
  expect(result).toEqual({ status: "applied", changedTabIds: [expected.id] })
  expect(tab()).toMatchObject({
    content: "renamed",
    originalContent: "base",
    revision: expected.revision + 1,
    isDirty: true,
  })
  expect(writeFile).not.toHaveBeenCalled()
})

it("rejects the whole rename when even an unchanged dependency was edited", async () => {
  await open()
  const first = captureEditorDocument(tab())
  await useEditorStore.getState().openFile("/repo/b.ts")
  const dependency = captureEditorDocument(useEditorStore.getState().tabs[1]!)
  useEditorStore.getState().updateContent(dependency.id, "different binding")
  useEditorStore.getState().updateContent(dependency.id, dependency.content)
  const result = useEditorStore
    .getState()
    .applyDocumentChanges(
      [{ expected: first, content: "renamed" }],
      [first, dependency]
    )
  expect(result).toEqual({
    status: "conflict",
    filePaths: [dependency.filePath],
  })
  expect(tab().content).toBe(first.content)
})

it("rejects a versioned change after its tab's path has moved", async () => {
  await open()
  const expected = captureEditorDocument(tab())
  useEditorStore.getState().handlePathMoved("/repo/a.ts", "/repo/b.ts")
  expect(
    useEditorStore
      .getState()
      .applyDocumentChanges([{ expected, content: "renamed" }]).status
  ).toBe("conflict")
  expect(tab().content).toBe(expected.content)
})
