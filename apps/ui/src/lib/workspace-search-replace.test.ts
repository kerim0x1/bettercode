import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile, writeFile } from "@/services/backend"
import type { EditorTab } from "@/lib/editor-store"
import { useEditorStore } from "@/lib/editor-store"
import { replaceWorkspaceSearchResults } from "@/lib/workspace-search-replace"

const backendState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}))

vi.mock("@/services/backend", () => ({
  readFile: vi.fn(async (filePath: string) => ({
    path: filePath,
    content: backendState.files.get(filePath) ?? "",
  })),
  writeFile: vi.fn(
    async (cwd: string, relativePath: string, contents: string) => {
      backendState.files.set(`${cwd}/${relativePath}`, contents)
    }
  ),
}))

const readFileMock = vi.mocked(readFile)
const writeFileMock = vi.mocked(writeFile)

beforeEach(() => {
  backendState.files.clear()
  readFileMock.mockClear()
  writeFileMock.mockClear()
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    navigationBackStack: [],
    navigationForwardStack: [],
    recentlyClosedTabs: [],
  })
})

describe("replaceWorkspaceSearchResults", () => {
  it("replaces the supplied search results and refreshes clean open tabs from disk", async () => {
    backendState.files.set("/repo/src/a.ts", "foo foo")
    backendState.files.set("/repo/src/b.ts", "foo")
    useEditorStore.setState({
      tabs: [
        tab({
          id: "a",
          filePath: "/repo/src/a.ts",
          content: "foo foo",
          originalContent: "foo foo",
          aiBaselineContent: "before-ai",
        }),
      ],
      activeTabId: "a",
    })

    const outcome = await replaceWorkspaceSearchResults({
      projectPath: "/repo",
      query: "foo",
      replacement: "bar",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      preserveCase: false,
      results: [
        searchResult("src/a.ts", "a.ts"),
        searchResult("src/b.ts", "b.ts"),
      ],
    })

    expect(outcome).toEqual({ changedFiles: 2, replacements: 3 })
    expect(writeFileMock).toHaveBeenCalledWith("/repo", "src/a.ts", "bar bar")
    expect(writeFileMock).toHaveBeenCalledWith("/repo", "src/b.ts", "bar")
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      filePath: "/repo/src/a.ts",
      content: "bar bar",
      originalContent: "bar bar",
      aiBaselineContent: null,
      isDirty: false,
    })
  })

  it("blocks replacement when a target file has unsaved editor changes", async () => {
    backendState.files.set("/repo/src/a.ts", "foo")
    useEditorStore.setState({
      tabs: [
        tab({
          id: "a",
          filePath: "/repo/src/a.ts",
          content: "unsaved",
          originalContent: "foo",
          isDirty: true,
        }),
      ],
      activeTabId: "a",
    })

    await expect(
      replaceWorkspaceSearchResults({
        projectPath: "/repo",
        query: "foo",
        replacement: "bar",
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        preserveCase: false,
        results: [searchResult("src/a.ts", "a.ts")],
      })
    ).rejects.toThrow("Save or close a.ts before replacing.")
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})

function searchResult(path: string, name: string) {
  return {
    path,
    name,
    matches: [
      {
        line: 1,
        column: 1,
        length: 3,
        previewColumn: 1,
        previewLength: 3,
        preview: "foo",
      },
    ],
  }
}

function tab(overrides: Partial<EditorTab>): EditorTab {
  const filePath = overrides.filePath ?? "/repo/src/file.ts"
  return {
    id: "tab",
    filePath,
    fileName:
      overrides.fileName ??
      filePath.replace(/\\/g, "/").split("/").pop() ??
      "file.ts",
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
