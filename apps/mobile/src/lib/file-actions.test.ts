import { describe, expect, it } from "vitest"
import { RemoteApiError } from "@/transport/live/http"
import {
  childPath,
  deleteConfirmation,
  fileActionError,
  fileNameProblem,
} from "./file-actions"

describe("file names", () => {
  it("are one plain name: not empty, no folders, not . or ..", () => {
    expect(fileNameProblem("Map.tsx")).toBeNull()
    expect(fileNameProblem("  ")).toBe("Enter a name.")
    expect(fileNameProblem("src/Map.tsx")).toBe(
      "A name cannot contain / or \\."
    )
    expect(fileNameProblem("src\\Map.tsx")).toBe(
      "A name cannot contain / or \\."
    )
    expect(fileNameProblem("..")).toBe("Choose another name.")
    expect(fileNameProblem("x".repeat(256))).toBe("The name is too long.")
  })

  it("join the folder they are made in", () => {
    expect(childPath("", " Map.tsx ")).toBe("Map.tsx")
    expect(childPath("src/screens", "Map.tsx")).toBe("src/screens/Map.tsx")
  })
})

describe("the desktop Explorer's delete question", () => {
  it("names the file or folder", () => {
    expect(deleteConfirmation({ name: "theme.ts", isDir: false })).toEqual({
      title: "Delete file?",
      message: '"theme.ts" will be permanently deleted.',
      action: "Delete",
    })
    expect(deleteConfirmation({ name: "src", isDir: true }).title).toBe(
      "Delete folder?"
    )
  })
})

describe("a file action the desktop refused", () => {
  it("says a name is taken, which the desktop only codes", () => {
    for (const code of ["WORKSPACE_PATH_CHANGED", "EEXIST"]) {
      expect(
        fileActionError(
          new RemoteApiError("workspace move failed", 409, code),
          "rename"
        )
      ).toEqual({
        title: "Name already taken",
        message: "A file or folder with this name already exists here.",
      })
    }
  })

  it("names what failed when the desktop only says it failed", () => {
    expect(
      fileActionError(
        new RemoteApiError("workspace delete failed", 500),
        "delete"
      )
    ).toEqual({
      title: "Could not delete it",
      message: "workspace delete failed",
    })
    expect(
      fileActionError(
        new RemoteApiError(
          "workspace root is not registered",
          403,
          "workspace_not_registered"
        ),
        "create"
      ).title
    ).toBe("Project not open on the desktop")
  })
})
