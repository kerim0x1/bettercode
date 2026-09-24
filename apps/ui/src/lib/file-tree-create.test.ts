import { afterEach, describe, expect, it, vi } from "vitest"
import { HttpError } from "@/lib/errors/types"
import { createTreeEntry, treeCreateErrorMessage } from "./file-tree-create"

const backend = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))
vi.mock("@/services/backend", () => backend)

afterEach(() => vi.clearAllMocks())

describe("New file and New folder in the Explorer", () => {
  it("writes a new file only where none exists", async () => {
    await createTreeEntry("/repo/src", "README.md", "file")
    expect(backend.writeFile).toHaveBeenCalledWith(
      "/repo/src",
      "README.md",
      "",
      {
        expectedSha256: null,
      }
    )
    expect(backend.createDirectory).not.toHaveBeenCalled()
  })

  it("makes a folder", async () => {
    await createTreeEntry("/repo", "docs", "folder")
    expect(backend.createDirectory).toHaveBeenCalledWith("/repo", "docs")
    expect(backend.writeFile).not.toHaveBeenCalled()
  })

  it("says a taken name is taken, and passes other failures on", () => {
    expect(
      treeCreateErrorMessage(
        new HttpError("workspace write failed", 409, "/workspace/write", {
          code: "WORKSPACE_PATH_CHANGED",
        })
      )
    ).toBe("A file or folder with this name already exists.")
    expect(treeCreateErrorMessage(new Error("disk full"))).toBe("disk full")
    expect(treeCreateErrorMessage("?")).toBe("It could not be created.")
  })
})
