import { describe, expect, it } from "vitest"
import { filterWorkspaceMapFiles } from "./editor-code-map-view"
import type { WorkspaceMapFile } from "@/services/backend"

function file(
  path: string,
  kind: WorkspaceMapFile["kind"] = "source"
): WorkspaceMapFile {
  const parts = path.split("/")
  const name = parts.pop()!
  return {
    path,
    name,
    directory: parts.join("/"),
    extension: name.split(".").pop()!,
    sizeBytes: 100,
    kind,
  }
}

const files = [
  file("src/App.tsx"),
  file("src/ui/Button.tsx"),
  file("src-old/App.tsx"),
  file("docs/src-guide.md", "docs"),
  file("package.json", "config"),
]

describe("code map folder filters", () => {
  it("includes descendants but never similarly named folders or search text matches", () => {
    const result = filterWorkspaceMapFiles(files, {
      query: "",
      kind: "all",
      directory: "src",
    })
    expect(result.map((entry) => entry.path)).toEqual([
      "src/App.tsx",
      "src/ui/Button.tsx",
    ])
  })

  it("distinguishes project-root files from clearing the folder filter", () => {
    expect(
      filterWorkspaceMapFiles(files, { query: "", kind: "all", directory: "" })
    ).toEqual([files[4]])
    expect(
      filterWorkspaceMapFiles(files, {
        query: "",
        kind: "all",
        directory: null,
      })
    ).toEqual(files)
  })

  it("combines folder, search and kind filters and handles Windows paths", () => {
    const windowsFile = { ...files[1], directory: "SRC\\ui" }
    expect(
      filterWorkspaceMapFiles([windowsFile, files[4]], {
        query: "button",
        kind: "source",
        directory: "src\\UI\\",
      })
    ).toEqual([windowsFile])
    expect(
      filterWorkspaceMapFiles(files, {
        query: "App",
        kind: "config",
        directory: "src",
      })
    ).toEqual([])
    expect(
      filterWorkspaceMapFiles(files, { query: "missing", kind: "all" })
    ).toEqual([])
  })
})
