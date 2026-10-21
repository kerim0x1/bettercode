import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ProjectFileTree,
  fileTreeCountLabel,
} from "@/components/file-tree/project-file-tree"

// The tree fetches in an effect that a static render never runs; mocked so
// importing the component does not pull the backend runtime into the test.
vi.mock("@/services/backend/workspaceApi", () => ({
  createDirectory: vi.fn(),
  deleteWorkspacePath: vi.fn(),
  moveWorkspacePath: vi.fn(),
  writeFile: vi.fn(),
}))
vi.mock("@/services/backend/filesystem", () => ({
  listDirectoryFs: vi.fn(async () => ({ entries: [] })),
}))
// `useConfirm` throws outside its provider; the tree only needs it for
// delete, which a static render never reaches.
vi.mock("@/components/dialogs/confirm-provider", () => ({
  useConfirm: () => async () => false,
}))

afterEach(() => vi.unstubAllGlobals())

describe("fileTreeCountLabel", () => {
  it("identifies loaded entries without claiming a project-wide total", () => {
    expect(fileTreeCountLabel(5000)).toEqual({
      text: "5000 loaded",
      title:
        "Files and folders loaded so far. Open a folder to load its contents.",
    })
    expect(fileTreeCountLabel(0).text).toBe("0 loaded")
  })
})

describe("ProjectFileTree", () => {
  it("keeps the editor workspace toggle reachable during loading without showing a false zero count", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectFileTree
          projectPath="C:\\repo\\"
          completeRootListing
          defaultOpen
        />
      </TooltipProvider>
    )
    expect(html).toContain('aria-label="Workspace: repo"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain("aria-controls=")
    expect(html).toContain('aria-label="New file"')
    expect(html).toContain('aria-label="New folder"')
    expect(html).toContain('role="status"')
    expect(html).not.toContain("tabular-nums")
    expect(html).not.toContain("Empty folder")
  })

  it("restores a collapsed workspace while keeping the header icons available", () => {
    const getItem = vi.fn(() => "closed")
    vi.stubGlobal("localStorage", { getItem })
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectFileTree
          projectPath="/repo"
          completeRootListing
          defaultOpen
          openStorageKey="betterc0de-editor-section:workspace"
        />
      </TooltipProvider>
    )
    expect(getItem).toHaveBeenCalledWith("betterc0de-editor-section:workspace")
    expect(html).toContain('aria-label="Workspace: repo"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="New file"')
    expect(html).toContain('aria-label="New folder"')
    expect(html).not.toContain('role="status"')
  })

  it("respects a controlled closed state even with an open default", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectFileTree
          projectPath="/repo"
          completeRootListing
          defaultOpen
          open={false}
          onOpenChange={() => {}}
        />
      </TooltipProvider>
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="status"')
  })

  it("uses the default when the saved workspace state is inaccessible", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Blocked")
      },
    })
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectFileTree
          projectPath="/repo"
          completeRootListing
          defaultOpen
          openStorageKey="betterc0de-editor-section:workspace"
        />
      </TooltipProvider>
    )
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="New file"')
  })

  it("renders nothing until the first listing has loaded", () => {
    // Nothing — not a header with a "0" count, and no truncation row — may
    // show before the backend has answered once.
    const html = renderToStaticMarkup(
      <ProjectFileTree projectPath="/repo" onFileSelect={() => {}} />
    )
    expect(html).toBe("")
  })
})
