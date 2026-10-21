import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearExecutablePathCache,
  isAbsoluteExecutablePath,
  requireExecutableOnPath,
  resolveExecutableOnPath,
  windowsSystemExecutable,
} from "./executablePath"

const tempRoots: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeFakeExecutable(directory: string, fileName: string): string {
  const filePath = path.join(directory, fileName)
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8")
  fs.chmodSync(filePath, 0o755)
  return filePath
}

const gitFileName = process.platform === "win32" ? "git.exe" : "git"

beforeEach(() => clearExecutablePathCache())

afterEach(() => {
  clearExecutablePathCache()
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("resolveExecutableOnPath", () => {
  it("never picks a git planted in the workspace (cwd-relative PATH entries are ignored)", () => {
    const workspace = makeTempDir("betterc0de-hostile-repo-")
    const tools = makeTempDir("betterc0de-tools-")
    writeFakeExecutable(workspace, gitFileName)
    writeFakeExecutable(workspace, "git.com")
    const realGit = writeFakeExecutable(tools, gitFileName)
    // Run from inside the planted repository, as Git spawns do, so a
    // relative entry, "." and an empty entry (POSIX: ".") would each reach
    // the planted binary if they were searched. The relative entry is not
    // derived with path.relative: across Windows drives (CI checks out on
    // D:, the temp directory is on C:) that returns an absolute path.
    const relativeWorkspace = path.join("..", path.basename(workspace))
    const previousCwd = process.cwd()
    process.chdir(workspace)
    try {
      const pathValue = [relativeWorkspace, ".", "", tools].join(path.delimiter)

      expect(resolveExecutableOnPath("git", { pathValue })).toBe(realGit)
      expect(
        resolveExecutableOnPath("git", {
          pathValue: [relativeWorkspace, "."].join(path.delimiter),
        })
      ).toBeNull()
    } finally {
      process.chdir(previousCwd)
    }
  })

  it("refuses relative names with a path separator", () => {
    const tools = makeTempDir("betterc0de-tools-")
    writeFakeExecutable(tools, gitFileName)
    expect(
      resolveExecutableOnPath(`.${path.sep}${gitFileName}`, {
        pathValue: tools,
      })
    ).toBeNull()
    expect(
      resolveExecutableOnPath(`bin${path.sep}${gitFileName}`, {
        pathValue: tools,
      })
    ).toBeNull()
  })

  it("returns an absolute executable path unchanged", () => {
    const tools = makeTempDir("betterc0de-tools-")
    const realGit = writeFakeExecutable(tools, gitFileName)
    expect(resolveExecutableOnPath(realGit, { pathValue: "" })).toBe(realGit)
  })

  it("throws an ENOENT-coded error when the tool is not installed", () => {
    expect(() =>
      requireExecutableOnPath("betterc0de-not-installed-tool", {
        pathValue: makeTempDir("betterc0de-empty-"),
      })
    ).toThrow(expect.objectContaining({ code: "ENOENT" }))
  })

  it("honours PATHEXT on Windows, prefers directly spawnable files and skips relative entries", () => {
    const files = new Set([
      "C:\\tools\\codex.cmd",
      "C:\\tools\\codex.exe",
      "C:\\npm\\claude.cmd",
      "repo\\git.exe",
      "D:\\git\\cmd\\git.exe",
    ])
    const isExecutableFile = (candidate: string) => files.has(candidate)
    const options = {
      platform: "win32" as const,
      pathExt: ".COM;.EXE;.BAT;.CMD",
      isExecutableFile,
    }

    expect(
      resolveExecutableOnPath("git", {
        ...options,
        pathValue: "repo;C:repo;\\repo;D:\\git\\cmd",
      })
    ).toBe("D:\\git\\cmd\\git.exe")
    expect(
      resolveExecutableOnPath("codex", {
        ...options,
        pathValue: "C:\\tools",
        allowScripts: true,
      })
    ).toBe("C:\\tools\\codex.exe")
    // A batch shim is only returned to callers that wrap it in cmd.exe.
    expect(
      resolveExecutableOnPath("claude", { ...options, pathValue: "C:\\npm" })
    ).toBeNull()
    expect(
      resolveExecutableOnPath("claude", {
        ...options,
        pathValue: '"C:\\npm"',
        allowScripts: true,
      })
    ).toBe("C:\\npm\\claude.cmd")
  })

  it("treats only drive-qualified and UNC paths as absolute on Windows", () => {
    expect(isAbsoluteExecutablePath("C:\\Windows", "win32")).toBe(true)
    expect(isAbsoluteExecutablePath("\\\\server\\share\\bin", "win32")).toBe(
      true
    )
    expect(isAbsoluteExecutablePath("C:Windows", "win32")).toBe(false)
    expect(isAbsoluteExecutablePath("\\Windows", "win32")).toBe(false)
    expect(isAbsoluteExecutablePath("bin", "win32")).toBe(false)
  })

  it("locates Windows system tools under SystemRoot", () => {
    expect(windowsSystemExecutable("taskkill.exe")).toMatch(
      /^[a-zA-Z]:\\.*\\System32\\taskkill\.exe$/
    )
  })
})
