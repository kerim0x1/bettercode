import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  FileMentionMenu,
  FileMentionResultsPanel,
} from "@/components/file-mentions"

// The panel under test never fetches; the menu's own fetch lives in an
// effect that `renderToStaticMarkup` does not run. Mocked so importing the
// component does not drag the backend runtime into the test.
vi.mock("@/services/backend/workspaceApi", () => ({
  searchEntriesDetailed: vi.fn(async () => ({ entries: [], truncated: false })),
}))

const files = [
  { name: "src", path: "src", type: "folder" as const },
  { name: "index.ts", path: "src/index.ts", type: "file" as const },
]

function renderPanel(
  truncation: { truncated: boolean; reason?: string },
  list = files
): string {
  return renderToStaticMarkup(
    <FileMentionResultsPanel
      query="ind"
      files={list}
      selectedIndex={0}
      truncation={truncation}
      onSelect={() => {}}
      onHover={() => {}}
    />
  )
}

describe("FileMentionResultsPanel", () => {
  it("lists matches without any truncation row when the walk completed", () => {
    const html = renderPanel({ truncated: false })
    expect(html).toContain('aria-label="Files"')
    expect(html).toContain("2 results")
    expect(html).toContain("src/index.ts")
    // The negative assertion is the regression guard: a complete list must
    // not carry a "cut short" footnote.
    expect(html).not.toContain("data-search-truncated")
    expect(html).not.toContain("cut short")
  })

  it("ends a cut-short match list with a static notice", () => {
    const html = renderPanel({ truncated: true, reason: "visited" })
    expect(html).toContain('aria-label="Files"')
    expect(html).toContain("2 results")
    expect(html).toContain('data-search-truncated="visited"')
    expect(html).toContain(
      "File list cut short (entry cap) — some files may be missing"
    )
    // Footnote, not a headline: it comes after the last match.
    expect(html.indexOf("src/index.ts")).toBeLessThan(
      html.indexOf("data-search-truncated")
    )
    expect(html).not.toMatch(/animate-/)
  })

  // A "no files matching" from a capped walk is not a "no": the file the
  // user is typing may simply be past the cut.
  it("qualifies an empty match set when the walk was cut short", () => {
    const html = renderPanel({ truncated: true, reason: "deadline" }, [])
    expect(html).toContain("No files matching")
    expect(html).toContain('data-search-truncated="deadline"')
    expect(html).toContain(
      "File list cut short (time limit) — the file may exist but was not listed"
    )
  })

  it("leaves a genuine empty match set unqualified", () => {
    const html = renderPanel({ truncated: false }, [])
    expect(html).toContain("No files matching")
    expect(html).not.toContain("data-search-truncated")
  })
})

describe("FileMentionMenu", () => {
  it("renders nothing before its first load", () => {
    // Guards the panel split: the menu must not paint an empty "no files"
    // box (or a notice) while it still has nothing to show.
    const html = renderToStaticMarkup(
      <FileMentionMenu
        threadId={null}
        query=""
        visible
        projectPath="/repo"
        onSelect={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toBe("")
  })
})
