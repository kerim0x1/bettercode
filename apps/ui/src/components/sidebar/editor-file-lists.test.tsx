import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EditorOpenEditorsList,
  EditorRecentFilesList,
} from "./editor-file-lists"
import type { EditorFileSection } from "./editor-file-section"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"
import { dispatchEditorGotoLine } from "@/lib/editor-go-to-line"

const rendered = vi.hoisted(() => ({
  sections: [] as ComponentProps<typeof EditorFileSection>[],
}))
vi.mock("./editor-file-section", async (original) => {
  const actual = await original<typeof import("./editor-file-section")>()
  return {
    EditorFileSection: (props: ComponentProps<typeof EditorFileSection>) => {
      rendered.sections.push(props)
      return createElement(actual.EditorFileSection, props)
    },
  }
})
vi.mock("@/lib/editor-store", async (original) => {
  const actual = await original<typeof import("@/lib/editor-store")>()
  const store = actual.useEditorStore
  return {
    ...actual,
    useEditorStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) =>
        selector(store.getState()),
      store
    ),
  }
})
vi.mock("@/lib/editor-go-to-line", () => ({ dispatchEditorGotoLine: vi.fn() }))

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: "a",
    filePath: "/repo/src/main.ts",
    fileName: "main.ts",
    language: "typescript",
    content: "modified",
    originalContent: "original",
    revision: 0,
    readGeneration: 0,
    documentVersion: 0,
    aiBaselineContent: null,
    isDirty: true,
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

function findProps(
  node: ReactNode,
  matches: (props: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined
  Children.forEach(node, (child) => {
    if (found || !isValidElement<Record<string, unknown>>(child)) return
    found = matches(child.props)
      ? child.props
      : findProps(child.props.children as ReactNode, matches)
  })
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  rendered.sections = []
  useEditorStore.setState({
    tabs: [tab()],
    activeTabId: "a",
    recentFiles: [],
    recentlyClosedTabs: [],
  })
  // Sections start collapsed; model a user who expanded them this session so
  // the list rows are rendered.
  vi.stubGlobal("sessionStorage", { getItem: () => "open" })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("editor file lists", () => {
  it("shows active, pinned and unsaved status with separate file actions", () => {
    useEditorStore.setState({
      tabs: [tab({ isPinned: true, isPreview: true })],
    })
    const html = renderToStaticMarkup(
      <EditorOpenEditorsList projectPath="/repo" />
    )
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-label="Pinned file"')
    expect(html).toContain('aria-label="Unsaved changes"')
    expect(html).toContain('aria-label="Actions for main.ts"')
    expect(html).toContain('aria-label="Close main.ts"')
    expect(html).toContain("Preview editor")
  })

  it("keeps unsaved files when closing is denied", () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal("confirm", confirm)
    renderToStaticMarkup(<EditorOpenEditorsList projectPath="/repo" />)
    const close = findProps(
      rendered.sections[0].children,
      (props) => props["aria-label"] === "Close main.ts"
    )!
    ;(close.onClick as () => void)()
    expect(confirm).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().tabs.map((item) => item.id)).toEqual(["a"])
  })

  it("retains pinned files when closing all unpinned files from the menu", () => {
    useEditorStore.setState({
      tabs: [
        tab(),
        tab({
          id: "pinned",
          filePath: "/repo/pinned.ts",
          fileName: "pinned.ts",
          isPinned: true,
        }),
      ],
    })
    const confirm = vi.fn((_message?: string) => true)
    vi.stubGlobal("confirm", confirm)
    renderToStaticMarkup(<EditorOpenEditorsList projectPath="/repo" />)
    const close = findProps(rendered.sections[0].actions, (props) =>
      Children.toArray(props.children as ReactNode).includes(
        "Close all unpinned files"
      )
    )!
    ;(close.onSelect as () => void)()
    expect(confirm.mock.calls[0][0]).not.toContain("pinned.ts")
    expect(useEditorStore.getState().tabs.map((item) => item.id)).toEqual([
      "pinned",
    ])
  })

  it("keeps both section headers available even when their lists are empty", () => {
    useEditorStore.setState({ tabs: [], recentFiles: [] })
    const html = renderToStaticMarkup(
      <>
        <EditorOpenEditorsList projectPath="/repo" />
        <EditorRecentFilesList projectPath="/repo" />
      </>
    )
    expect(html).toContain('aria-label="Open Files"')
    expect(html).toContain('aria-label="Recent Files"')
    expect(html).toContain('aria-label="Open Files actions"')
    expect(html).not.toContain('aria-label="Close ')
  })

  it("reopens a recent file at its remembered cursor without duplicating an open file", async () => {
    useEditorStore.setState({
      recentFiles: [
        {
          filePath: "/repo/src/main.ts",
          fileName: "main.ts",
          language: "typescript",
          line: 1,
          column: 1,
        },
        {
          filePath: "/repo/lib/helper.ts",
          fileName: "helper.ts",
          language: "typescript",
          line: 42,
          column: 7,
        },
      ],
    })
    const open = vi
      .spyOn(useEditorStore.getState(), "openFile")
      .mockResolvedValue(undefined)
    const html = renderToStaticMarkup(
      <EditorRecentFilesList projectPath="/repo" />
    )
    expect(html).not.toContain("main.ts")
    expect(html).toContain("helper.ts")
    const row = findProps(
      rendered.sections[0].children,
      (props) => props.title === "lib/helper.ts:42:7"
    )!
    ;(row.onClick as () => void)()
    await Promise.resolve()
    expect(open).toHaveBeenCalledWith("/repo/lib/helper.ts", {
      line: 42,
      column: 7,
      preview: false,
    })
    expect(dispatchEditorGotoLine).toHaveBeenCalledWith(
      {
        filePath: "/repo/lib/helper.ts",
        line: 42,
        column: 7,
        preserveNavigation: true,
      },
      { defer: true }
    )
  })
})
