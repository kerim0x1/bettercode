import { describe, expect, it } from "vitest"
import {
  buildWorkspaceMapBrief,
  formatWorkspaceBriefBytes,
} from "@/lib/workspace-map-brief"
import type { WorkspaceMapOverview } from "@/services/backend/workspaceApi"

describe("buildWorkspaceMapBrief", () => {
  it("builds a compact markdown brief from workspace map data", () => {
    const brief = buildWorkspaceMapBrief(makeOverview(), {
      projectPath: "/repo",
    })

    expect(brief).toContain("# Workspace Brief")
    expect(brief).toContain("Project: /repo")
    expect(brief).toContain("Files: 42 scanned")
    expect(brief).toContain("- apps/ui: 18 code / 25 files")
    expect(brief).toContain("- .tsx: 14 files")
    expect(brief).toContain("- package.json (config)")
    expect(brief).toContain("- apps/ui/src/App.tsx (2.0 KB)")
  })

  it("marks truncated workspaces", () => {
    expect(
      buildWorkspaceMapBrief({ ...makeOverview(), truncated: true })
    ).toContain("Files: 42 scanned (truncated)")
  })
})

describe("formatWorkspaceBriefBytes", () => {
  it("formats bounded byte values", () => {
    expect(formatWorkspaceBriefBytes(0)).toBe("0 B")
    expect(formatWorkspaceBriefBytes(512)).toBe("512 B")
    expect(formatWorkspaceBriefBytes(2048)).toBe("2.0 KB")
    expect(formatWorkspaceBriefBytes(20 * 1024)).toBe("20 KB")
  })
})

function makeOverview(): WorkspaceMapOverview {
  return {
    rootName: "repo",
    totalFiles: 42,
    scannedFiles: 42,
    codeFiles: 27,
    totalBytes: 80_000,
    truncated: false,
    files: [],
    topDirectories: [
      {
        path: "apps/ui",
        name: "ui",
        fileCount: 25,
        codeFileCount: 18,
        totalBytes: 50_000,
      },
    ],
    extensions: [
      {
        extension: "tsx",
        label: ".tsx",
        fileCount: 14,
        codeFileCount: 14,
        totalBytes: 40_000,
      },
    ],
    importantFiles: [
      {
        path: "package.json",
        name: "package.json",
        directory: "",
        extension: "json",
        sizeBytes: 1024,
        kind: "config",
      },
    ],
    largestFiles: [
      {
        path: "apps/ui/src/App.tsx",
        name: "App.tsx",
        directory: "apps/ui/src",
        extension: "tsx",
        sizeBytes: 2048,
        kind: "source",
      },
    ],
  }
}
