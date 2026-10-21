import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import {
  getLanguage,
  MAX_RECENTLY_CLOSED_CONTENT_CHARS,
  useEditorStore,
} from "@/lib/editor-store"
import { EDITOR_FILE_ACTIVATE_EVENT } from "@/lib/preview-events"

vi.mock("@/services/backend/workspaceApi", () => ({
  readFile: vi.fn(async (filePath: string) => ({
    path: filePath,
    content: `content:${filePath}`,
  })),
  writeFile: vi.fn(async () => undefined),
}))

const readFileMock = vi.mocked(readFile)
const writeFileMock = vi.mocked(writeFile)

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    navigationBackStack: [],
    navigationForwardStack: [],
    recentlyClosedTabs: [],
    recentFiles: [],
  })
  readFileMock.mockImplementation(async (filePath: string) => ({
    path: filePath,
    content: `content:${filePath}`,
  }))
  readFileMock.mockClear()
  writeFileMock.mockClear()
})

describe("editor navigation history", () => {
  it("reveals the editor when the already active file is reopened or selected over the browser", async () => {
    const events = new EventTarget()
    const reveal = vi.fn()
    events.addEventListener(EDITOR_FILE_ACTIVATE_EVENT, reveal)
    vi.stubGlobal("window", events)
    try {
      await useEditorStore.getState().openFile("/repo/src/a.ts")
      const tabId = useEditorStore.getState().activeTabId!
      await useEditorStore
        .getState()
        .openFile("/repo/src/a.ts", { reloadExisting: false })
      useEditorStore.getState().setActiveTab(tabId)
      expect(reveal).toHaveBeenCalledTimes(3)
      expect(useEditorStore.getState().tabs).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("detects common languages and special filenames", () => {
    expect(getLanguage("/repo/Dockerfile")).toBe("dockerfile")
    expect(getLanguage("C:\\repo\\script.ps1")).toBe("powershell")
    expect(getLanguage("/repo/app.php")).toBe("php")
    expect(getLanguage("/repo/unknown.rules")).toBe("plaintext")
  })

  it("opens images as previews without decoding their bytes as UTF-8 text", async () => {
    await useEditorStore.getState().openFile("/repo/assets/logo.png", {
      preview: true,
    })

    const tab = useEditorStore.getState().tabs[0]
    expect(tab).toMatchObject({
      filePath: "/repo/assets/logo.png",
      fileKind: "image",
      content: "",
      isLoading: false,
      isPreview: true,
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("still loads unknown source extensions as editable plaintext", async () => {
    await useEditorStore.getState().openFile("/repo/config/custom.rules")

    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      fileKind: "text",
      language: "plaintext",
      content: "content:/repo/config/custom.rules",
      isLoading: false,
    })
    expect(readFileMock).toHaveBeenCalledOnce()
  })

  it("moves backward and forward between opened files", async () => {
    const store = useEditorStore.getState()
    await store.openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")

    expect(activeFilePath()).toBe("/repo/src/b.ts")
    expect(useEditorStore.getState().navigationBackStack).toMatchObject([
      { filePath: "/repo/src/a.ts", line: 1, column: 1 },
    ])

    await useEditorStore.getState().goBack()
    expect(activeFilePath()).toBe("/repo/src/a.ts")
    expect(useEditorStore.getState().navigationForwardStack).toMatchObject([
      { filePath: "/repo/src/b.ts", line: 1, column: 1 },
    ])

    await useEditorStore.getState().goForward()
    expect(activeFilePath()).toBe("/repo/src/b.ts")
  })

  it("records and restores same-file cursor jumps", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const activeTabId = useEditorStore.getState().activeTabId
    expect(activeTabId).toBeTruthy()
    useEditorStore.getState().updateCursor(activeTabId!, 10, 3)
    useEditorStore.getState().recordNavigationPoint()
    useEditorStore.getState().updateCursor(activeTabId!, 40, 2)

    await useEditorStore.getState().goBack()
    expect(activeCursor()).toEqual({ line: 10, column: 3 })

    await useEditorStore.getState().goForward()
    expect(activeCursor()).toEqual({ line: 40, column: 2 })
  })

  it("tracks active selection statistics without changing navigation history", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const activeTabId = useEditorStore.getState().activeTabId
    expect(activeTabId).toBeTruthy()

    useEditorStore
      .getState()
      .updateCursor(activeTabId!, 12, 5, { lineCount: 3, charCount: 42 })

    expect(activeCursor()).toEqual({ line: 12, column: 5 })
    expect(activeSelection()).toEqual({ lineCount: 3, charCount: 42 })
    expect(useEditorStore.getState().navigationBackStack).toEqual([])
  })

  it("does not reload and clobber a dirty tab when it is opened again", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const activeTabId = useEditorStore.getState().activeTabId
    expect(activeTabId).toBeTruthy()
    useEditorStore.getState().updateContent(activeTabId!, "unsaved edit")
    readFileMock.mockClear()

    await useEditorStore.getState().openFile("/repo/src/a.ts")

    expect(readFileMock).not.toHaveBeenCalled()
    expect(activeContent()).toBe("unsaved edit")
  })

  it("saves all dirty tabs", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const firstId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(firstId, "edit a")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const secondId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(secondId, "edit b")

    await useEditorStore.getState().saveAllTabs()

    expect(writeFileMock).toHaveBeenCalledTimes(2)
    expect(useEditorStore.getState().tabs.every((tab) => !tab.isDirty)).toBe(
      true
    )
  })

  it("closes other tabs while preserving the target tab", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const firstId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    await useEditorStore.getState().openFile("/repo/src/c.ts")

    useEditorStore.getState().closeOtherTabs(firstId)

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(activeFilePath()).toBe("/repo/src/a.ts")
  })

  it("closes saved tabs and keeps dirty work open", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const dirtyId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(dirtyId, "unsaved")
    await useEditorStore.getState().openFile("/repo/src/b.ts")

    useEditorStore.getState().closeSavedTabs()

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(activeFilePath()).toBe("/repo/src/a.ts")
    expect(useEditorStore.getState().tabs[0]?.isDirty).toBe(true)
  })

  it("reopens the most recently closed dirty editor without losing content", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const tabId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateCursor(tabId, 12, 4)
    useEditorStore.getState().updateContent(tabId, "unsaved edit")

    useEditorStore.getState().closeTab(tabId)
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(useEditorStore.getState().recentlyClosedTabs).toHaveLength(1)

    await useEditorStore.getState().reopenClosedTab()

    expect(activeFilePath()).toBe("/repo/src/a.ts")
    expect(activeContent()).toBe("unsaved edit")
    expect(activeCursor()).toEqual({ line: 12, column: 4 })
    expect(useEditorStore.getState().tabs[0]?.isDirty).toBe(true)
    expect(useEditorStore.getState().recentlyClosedTabs).toHaveLength(0)
  })

  it("forgets the text of saved closed editors and reads the file again on reopen", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const tabId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateCursor(tabId, 7, 3)
    useEditorStore.getState().togglePinTab(tabId)

    useEditorStore.getState().closeTab(tabId)

    expect(useEditorStore.getState().recentlyClosedTabs[0]).toMatchObject({
      filePath: "/repo/src/a.ts",
      content: "",
      originalContent: "",
      aiBaselineContent: null,
      isDirty: false,
      isPinned: true,
      cursorLine: 7,
      cursorColumn: 3,
    })

    readFileMock.mockImplementation(async (filePath: string) => ({
      path: filePath,
      content: "changed on disk",
    }))
    readFileMock.mockClear()
    await useEditorStore.getState().reopenClosedTab()

    expect(readFileMock).toHaveBeenCalledWith("/repo/src/a.ts")
    expect(activeContent()).toBe("changed on disk")
    expect(activeCursor()).toEqual({ line: 7, column: 3 })
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      isLoading: false,
      isDirty: false,
      isPinned: true,
    })
  })

  it("caps unsaved text kept for closed editors and drops the oldest first", async () => {
    const third = "x".repeat(Math.floor(MAX_RECENTLY_CLOSED_CONTENT_CHARS / 3))
    for (const name of ["a", "b", "c"]) {
      await useEditorStore.getState().openFile(`/repo/src/${name}.ts`)
      const tabId = useEditorStore.getState().activeTabId!
      useEditorStore.getState().updateContent(tabId, `${name}:${third}`)
      useEditorStore.getState().closeTab(tabId)
    }

    const closed = useEditorStore.getState().recentlyClosedTabs
    expect(closed.map((tab) => tab.filePath)).toEqual([
      "/repo/src/c.ts",
      "/repo/src/b.ts",
      "/repo/src/a.ts",
    ])
    expect(closed[0]?.isDirty).toBe(true)
    expect(closed[0]?.content.startsWith("c:")).toBe(true)
    expect(closed[1]?.isDirty).toBe(true)
    expect(closed[1]?.content.startsWith("b:")).toBe(true)
    expect(closed[2]).toMatchObject({ content: "", isDirty: false })
  })

  it("closes tabs to the right and reopens the nearest closed editor first", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const middleId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/c.ts")
    await useEditorStore.getState().openFile("/repo/src/d.ts")

    useEditorStore.getState().closeTabsToRight(middleId)

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ])
    expect(activeFilePath()).toBe("/repo/src/b.ts")
    expect(
      useEditorStore.getState().recentlyClosedTabs.map((tab) => tab.filePath)
    ).toEqual(["/repo/src/c.ts", "/repo/src/d.ts"])

    await useEditorStore.getState().reopenClosedTab()

    expect(activeFilePath()).toBe("/repo/src/c.ts")
  })

  it("moves the active editor left and right without changing the active tab", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const middleId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/c.ts")
    useEditorStore
      .getState()
      .setActiveTab(middleId, { preserveNavigation: true })

    useEditorStore.getState().moveTab(middleId, "left")

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/b.ts",
      "/repo/src/a.ts",
      "/repo/src/c.ts",
    ])
    expect(activeFilePath()).toBe("/repo/src/b.ts")

    useEditorStore.getState().moveTab(middleId, "right")

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/c.ts",
    ])
    expect(activeFilePath()).toBe("/repo/src/b.ts")
  })

  it("does not move editor tabs beyond the tab strip bounds", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const firstId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const secondId = useEditorStore.getState().activeTabId!

    useEditorStore.getState().moveTab(firstId, "left")
    useEditorStore.getState().moveTab(secondId, "right")

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ])
  })

  it("activates adjacent editor tabs and wraps at tab strip edges", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    await useEditorStore.getState().openFile("/repo/src/c.ts")

    useEditorStore.getState().activateAdjacentTab("previous")
    expect(activeFilePath()).toBe("/repo/src/b.ts")

    useEditorStore.getState().activateAdjacentTab("previous")
    expect(activeFilePath()).toBe("/repo/src/a.ts")

    useEditorStore.getState().activateAdjacentTab("previous")
    expect(activeFilePath()).toBe("/repo/src/c.ts")

    useEditorStore.getState().activateAdjacentTab("next")
    expect(activeFilePath()).toBe("/repo/src/a.ts")
  })

  it("pins editor tabs to the left and unpins them back into the normal group", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const bId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/c.ts")
    const cId = useEditorStore.getState().activeTabId!

    useEditorStore.getState().togglePinTab(bId)
    useEditorStore.getState().togglePinTab(cId)

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/b.ts",
      "/repo/src/c.ts",
      "/repo/src/a.ts",
    ])
    expect(useEditorStore.getState().tabs.map((tab) => tab.isPinned)).toEqual([
      true,
      true,
      false,
    ])

    useEditorStore.getState().togglePinTab(bId)

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/c.ts",
      "/repo/src/b.ts",
      "/repo/src/a.ts",
    ])
    expect(useEditorStore.getState().tabs.map((tab) => tab.isPinned)).toEqual([
      true,
      false,
      false,
    ])
  })

  it("keeps pinned editor tabs when closing saved or all editors", async () => {
    await useEditorStore.getState().openFile("/repo/src/pinned.ts")
    const pinnedId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().togglePinTab(pinnedId)
    await useEditorStore.getState().openFile("/repo/src/saved.ts")
    await useEditorStore.getState().openFile("/repo/src/dirty.ts")
    const dirtyId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(dirtyId, "dirty")

    useEditorStore.getState().closeSavedTabs()

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/pinned.ts",
      "/repo/src/dirty.ts",
    ])

    useEditorStore.getState().closeAllTabs()

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/pinned.ts",
    ])
    expect(useEditorStore.getState().recentlyClosedTabs[0]?.filePath).toBe(
      "/repo/src/dirty.ts"
    )
  })

  it("does not move editor tabs across pinned boundaries", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const firstId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().togglePinTab(firstId)
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    const secondId = useEditorStore.getState().activeTabId!

    useEditorStore.getState().moveTab(secondId, "left")

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
    ])
  })

  it("reopens the active editor first after closing all tabs", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    await useEditorStore.getState().openFile("/repo/src/c.ts")
    const activeBeforeClose = activeFilePath()

    useEditorStore.getState().closeAllTabs()
    await useEditorStore.getState().reopenClosedTab()

    expect(activeFilePath()).toBe(activeBeforeClose)
  })

  it("reuses a clean preview tab while browsing files", async () => {
    await useEditorStore
      .getState()
      .openFile("/repo/src/a.ts", { preview: true })
    const previewId = useEditorStore.getState().activeTabId

    await useEditorStore
      .getState()
      .openFile("/repo/src/b.ts", { preview: true })

    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().activeTabId).toBe(previewId)
    expect(activeFilePath()).toBe("/repo/src/b.ts")
    expect(activeIsPreview()).toBe(true)
    expect(useEditorStore.getState().recentlyClosedTabs).toHaveLength(0)
    expect(
      useEditorStore.getState().recentFiles.map((file) => file.filePath)
    ).toEqual(["/repo/src/b.ts", "/repo/src/a.ts"])
  })

  it("keeps recently viewed editor files with the latest cursor location", async () => {
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const firstId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateCursor(firstId, 18, 6)
    await useEditorStore.getState().openFile("/repo/src/b.ts")
    await useEditorStore.getState().openFile("/repo/src/a.ts")

    expect(useEditorStore.getState().recentFiles.slice(0, 2)).toMatchObject([
      { filePath: "/repo/src/a.ts", line: 18, column: 6 },
      { filePath: "/repo/src/b.ts", line: 1, column: 1 },
    ])
  })

  it("promotes preview tabs when editing or reopening permanently", async () => {
    await useEditorStore
      .getState()
      .openFile("/repo/src/a.ts", { preview: true })
    const previewId = useEditorStore.getState().activeTabId!
    expect(activeIsPreview()).toBe(true)

    useEditorStore.getState().updateContent(previewId, "edited")
    expect(activeIsPreview()).toBe(false)

    await useEditorStore
      .getState()
      .openFile("/repo/src/b.ts", { preview: true })
    expect(useEditorStore.getState().tabs).toHaveLength(2)
    expect(activeFilePath()).toBe("/repo/src/b.ts")
    expect(activeIsPreview()).toBe(true)

    await useEditorStore
      .getState()
      .openFile("/repo/src/b.ts", { preview: false })
    expect(activeIsPreview()).toBe(false)
  })

  it("updates open editors and navigation history when a path is renamed", async () => {
    await useEditorStore.getState().openFile("/repo/src/old.js")
    const renamedId = useEditorStore.getState().activeTabId!
    await useEditorStore.getState().openFile("/repo/src/other.ts")

    useEditorStore
      .getState()
      .handlePathMoved("/repo/src/old.js", "/repo/src/new.py")

    const renamed = useEditorStore
      .getState()
      .tabs.find((tab) => tab.id === renamedId)
    expect(renamed?.filePath).toBe("/repo/src/new.py")
    expect(renamed?.fileName).toBe("new.py")
    expect(renamed?.language).toBe("python")
    expect(useEditorStore.getState().navigationBackStack).toMatchObject([
      { filePath: "/repo/src/new.py" },
    ])
  })

  it("keeps dirty buffers and history attached when their parent folder moves", async () => {
    await useEditorStore.getState().openFile("/repo/src/nested/a.ts")
    const tabId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(tabId, "unsaved changes")
    await useEditorStore.getState().openFile("/repo/src/nested/b.ts")
    useEditorStore.getState().closeTab(useEditorStore.getState().activeTabId!)
    useEditorStore
      .getState()
      .handlePathMoved("/repo/src/nested", "/repo/assets/nested")
    expect(
      useEditorStore.getState().tabs.find((tab) => tab.id === tabId)
    ).toMatchObject({
      filePath: "/repo/assets/nested/a.ts",
      content: "unsaved changes",
      isDirty: true,
    })
    expect(useEditorStore.getState().recentlyClosedTabs[0]?.filePath).toBe(
      "/repo/assets/nested/b.ts"
    )
    expect(
      useEditorStore.getState().recentFiles.map((file) => file.filePath)
    ).toContain("/repo/assets/nested/a.ts")
    expect(
      useEditorStore
        .getState()
        .navigationBackStack.every(
          (entry) => !entry.filePath.startsWith("/repo/src/nested")
        )
    ).toBe(true)
  })

  it("closes open editors under deleted folders while preserving dirty recently closed content", async () => {
    await useEditorStore.getState().openFile("/repo/keep.ts")
    await useEditorStore.getState().openFile("/repo/src/a.ts")
    const dirtyId = useEditorStore.getState().activeTabId!
    useEditorStore.getState().updateContent(dirtyId, "unsaved after delete")
    await useEditorStore.getState().openFile("/repo/src/nested/b.ts")

    useEditorStore.getState().handlePathDeleted("/repo/src")

    expect(useEditorStore.getState().tabs.map((tab) => tab.filePath)).toEqual([
      "/repo/keep.ts",
    ])
    expect(activeFilePath()).toBe("/repo/keep.ts")
    expect(
      useEditorStore.getState().recentlyClosedTabs.map((tab) => tab.filePath)
    ).toEqual(["/repo/src/a.ts", "/repo/src/nested/b.ts"])
    expect(
      useEditorStore
        .getState()
        .recentFiles.some((file) => file.filePath.startsWith("/repo/src"))
    ).toBe(false)
    expect(useEditorStore.getState().recentlyClosedTabs[0]?.content).toBe(
      "unsaved after delete"
    )
    expect(
      useEditorStore
        .getState()
        .navigationBackStack.some((location) =>
          location.filePath.startsWith("/repo/src")
        )
    ).toBe(false)
  })
})

function activeFilePath(): string | null {
  const state = useEditorStore.getState()
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId)?.filePath ?? null
  )
}

function activeContent(): string | null {
  const state = useEditorStore.getState()
  return state.tabs.find((tab) => tab.id === state.activeTabId)?.content ?? null
}

function activeCursor(): { line: number; column: number } | null {
  const state = useEditorStore.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  return tab ? { line: tab.cursorLine, column: tab.cursorColumn } : null
}

function activeSelection(): { lineCount: number; charCount: number } | null {
  const state = useEditorStore.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  return tab
    ? {
        lineCount: tab.selectionLineCount,
        charCount: tab.selectionCharCount,
      }
    : null
}

function activeIsPreview(): boolean | null {
  const state = useEditorStore.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  return tab?.isPreview ?? null
}
