import { describe, expect, it } from "vitest"
import { sha256Hex } from "@/lib/sha256"
import { DEMO_FILES, demoGitSeeds } from "./fixtures"
import { DemoFiles } from "./files"
import { DemoGit } from "./git"

const NOW = new Date("2026-09-24T10:00:00.000Z")
const ROOT = "/Users/demo/code/weather-app"

function demo() {
  const git = new DemoGit(demoGitSeeds(NOW), () => NOW)
  return { git, files: new DemoFiles(git, DEMO_FILES, () => NOW) }
}

const names = (files: DemoFiles, path: string) =>
  files.list(path).entries.map((entry) => entry.name)

describe("the demo's files", () => {
  it("are the repository's working tree, folders first", () => {
    const { files } = demo()
    expect(names(files, ROOT)).toEqual(["src", "package.json", "README.md"])
    expect(names(files, `${ROOT}/src/screens`)).toEqual([
      "Forecast.tsx",
      "Radar.tsx",
      "Settings.tsx",
    ])
    expect(files.list(`${ROOT}/src/screens`).parent).toBe(`${ROOT}/src`)
    expect(() => files.list(`${ROOT}/missing`)).toThrow("Folder not found.")
  })

  it("reads a file with its SHA-256", () => {
    const { files } = demo()
    const file = files.read(ROOT, `${ROOT}/src/theme.ts`)
    expect(file.sha256).toBe(sha256Hex(file.content))
    expect(() => files.read(ROOT, `${ROOT}/missing.ts`)).toThrow(
      "File not found."
    )
  })

  it("creates a file only where none exists, and source control sees it", () => {
    const { files, git } = demo()
    files.write(ROOT, "src/Map.tsx", "export {}\n", null)
    expect(git.status(ROOT).untracked).toContain("src/Map.tsx")
    expect(() => files.write(ROOT, "src/Map.tsx", "again\n", null)).toThrow(
      expect.objectContaining({ status: 409, code: "WORKSPACE_PATH_CHANGED" })
    )
  })

  it("saves over a file only while it still has the bytes that were read", () => {
    const { files } = demo()
    const read = files.read(ROOT, `${ROOT}/README.md`)
    files.write(ROOT, "README.md", "# Mine\n", read.sha256)
    expect(() =>
      files.write(ROOT, "README.md", "# Stale\n", read.sha256)
    ).toThrow(
      expect.objectContaining({ status: 409, code: "WORKSPACE_PATH_CHANGED" })
    )
    // Without a hash the write goes through, as on the desktop.
    files.write(ROOT, "README.md", "# Forced\n")
    expect(files.read(ROOT, `${ROOT}/README.md`).content).toBe("# Forced\n")
  })

  it("makes empty folders, and refuses paths that leave the project", () => {
    const { files } = demo()
    files.createFolder(ROOT, "docs/guides")
    expect(names(files, ROOT)).toEqual([
      "docs",
      "src",
      "package.json",
      "README.md",
    ])
    expect(names(files, `${ROOT}/docs`)).toEqual(["guides"])
    for (const path of ["../escape", "/etc/passwd", "C:/Windows", "a//b"]) {
      expect(() => files.write(ROOT, path, "")).toThrow(
        expect.objectContaining({ status: 400 })
      )
    }
  })

  it("renames a file and a folder with everything in it, but never onto another", () => {
    const { files, git } = demo()
    files.move(ROOT, "src/theme.ts", "src/colours.ts")
    expect(names(files, `${ROOT}/src`)).toContain("colours.ts")
    // As git sees a moved file: the tracked one deleted, a new one untracked.
    expect(git.status(ROOT)).toMatchObject({
      modified: expect.arrayContaining(["src/theme.ts"]),
      untracked: expect.arrayContaining(["src/colours.ts"]),
    })

    files.move(ROOT, "src/screens", "src/views")
    expect(names(files, `${ROOT}/src`)).toEqual([
      "views",
      "App.tsx",
      "colours.ts",
    ])
    expect(names(files, `${ROOT}/src/views`)).toContain("Radar.tsx")

    expect(() => files.move(ROOT, "src/App.tsx", "README.md")).toThrow(
      expect.objectContaining({ status: 409, code: "EEXIST" })
    )
    expect(() => files.move(ROOT, "src", "src/inner")).toThrow(
      expect.objectContaining({ status: 400 })
    )
  })

  it("deletes a file, and a folder only when told to take its contents too", () => {
    const { files } = demo()
    files.delete(ROOT, "package.json", false)
    expect(names(files, ROOT)).not.toContain("package.json")
    expect(() => files.delete(ROOT, "src", false)).toThrow(
      expect.objectContaining({ status: 500 })
    )
    files.delete(ROOT, "src", true)
    expect(names(files, ROOT)).toEqual(["README.md"])
    expect(() => files.delete(ROOT, "src", true)).toThrow(
      expect.objectContaining({ status: 404 })
    )
  })

  it("finds names of files and folders, ignoring case", () => {
    const { files } = demo()
    expect(
      files.searchNames(ROOT, "SCREENS", 10).entries.map((entry) => entry.name)
    ).toEqual(["screens", "Forecast.tsx", "Radar.tsx", "Settings.tsx"])
  })
})

describe("the demo's content search", () => {
  it("finds text as the desktop does: lines and columns from 1, a trimmed preview", () => {
    const { files } = demo()
    const { results, truncated } = files.searchContent(ROOT, "background")
    expect(truncated).toBe(false)
    expect(results).toEqual([
      {
        path: "src/theme.ts",
        name: "theme.ts",
        matches: [
          expect.objectContaining({ line: 1, column: 24, length: 10 }),
          expect.objectContaining({ line: 2, column: 23, length: 10 }),
        ],
      },
    ])
    expect(results[0]!.matches[0]).toMatchObject({
      previewColumn: 24,
      preview:
        'export const light = { background: "#ffffff", text: "#111111" }',
    })
  })

  it("minds case, whole words, regular expressions and globs", () => {
    const { files } = demo()
    const paths = (query: string, options = {}) =>
      files.searchContent(ROOT, query, options).results.map((file) => file.path)
    expect(paths("Forecast", { caseSensitive: true })).toEqual([
      "src/App.tsx",
      "src/screens/Forecast.tsx",
    ])
    expect(paths("forecast", { caseSensitive: true })).toEqual([
      "README.md",
      "src/screens/Forecast.tsx",
    ])
    expect(paths("them", { wholeWord: true })).toEqual([])
    expect(paths("#[0-9a-f]{6}", { regex: true })).toEqual(["src/theme.ts"])
    expect(paths("return", { include: "src/screens/**" })).toEqual([
      "src/screens/Forecast.tsx",
      "src/screens/Radar.tsx",
      "src/screens/Settings.tsx",
    ])
    expect(paths("return", { include: "*.tsx", exclude: "Radar.tsx" })).toEqual(
      ["src/App.tsx", "src/screens/Forecast.tsx", "src/screens/Settings.tsx"]
    )
  })

  it("stops at its limit and says so", () => {
    const { files } = demo()
    const search = files.searchContent(ROOT, "e", { limit: 3 })
    expect(
      search.results.reduce((total, file) => total + file.matches.length, 0)
    ).toBe(3)
    expect(search.truncated).toBe(true)
  })
})
