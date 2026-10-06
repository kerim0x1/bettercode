import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FileTreeDragState } from "@/hooks/use-file-tree-drag-drop"
import { FileTreeNode } from "./file-tree-node"

function renderTree(
  dragState?: FileTreeDragState,
  moreDirectoryPaths?: ReadonlySet<string>
) {
  const noop = () => {}
  return renderToStaticMarkup(
    <FileTreeNode
      item={{
        name: "lib",
        path: "lib",
        type: "folder",
        children: [{ name: "assets", path: "lib/assets", type: "folder" }],
      }}
      depth={0}
      expandedPaths={new Set(["lib"])}
      loadingDirectoryPaths={new Set()}
      failedDirectoryPaths={new Set()}
      moreDirectoryPaths={moreDirectoryPaths}
      onLoadMore={noop}
      toggleExpanded={noop}
      dragState={dragState}
      creating={null}
      renaming={null}
      onStartCreate={noop}
      onCommitCreate={noop}
      onCancelCreate={noop}
      onStartRename={noop}
      onCommitRename={noop}
      onCancelRename={noop}
      onDelete={noop}
      resolveEntryPath={(path) => `/repo/${path}`}
      relativeEntryPath={(path) => path}
    />
  )
}

describe("file tree drop feedback", () => {
  it("offers a continuation inside an expanded large folder", () => {
    const html = renderTree(undefined, new Set(["lib"]))
    expect(html).toContain('aria-label="Load more files in lib"')
    expect(html).toContain("Load more files")
    expect(renderTree()).not.toContain("Load more files")
  })
  it.each(["before", "after"] as const)(
    "shows only an insertion line for a %s drop beside a nested folder",
    (edge) => {
      const html = renderTree({
        sourcePath: "other/src",
        targetDirectory: "lib",
        insertion: { path: "lib/assets", edge },
      })
      expect(html).toContain(`data-file-tree-insertion="${edge}"`)
      expect(html).toContain('style="left:16px"')
      expect(html.match(/data-file-tree-insertion=/g)).toHaveLength(1)
      expect(html).not.toContain("data-file-tree-drop-target=")
      expect(html).toContain("pointer-events-none invisible")
    }
  )

  it("highlights the folder without an insertion line for an inside drop", () => {
    const html = renderTree({ sourcePath: "other/src", targetDirectory: "lib" })
    expect(html.match(/data-file-tree-drop-target="true"/g)).toHaveLength(1)
    expect(html).not.toContain("data-file-tree-insertion=")
  })

  it("removes drop feedback and restores row actions after dragging", () => {
    const html = renderTree({ sourcePath: null, targetDirectory: null })
    expect(html).not.toContain("data-file-tree-insertion=")
    expect(html).not.toContain("data-file-tree-drop-target=")
    expect(html).not.toContain("pointer-events-none invisible")
  })
})
