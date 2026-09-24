import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { describe, expect, it } from "vitest"
import { RemoteApiError } from "../live/http"
import { demoGitSeeds } from "./fixtures"
import { DemoGit, NOTHING_TO_COMMIT, unifiedFileDiff } from "./git"

const NOW = new Date("2026-09-24T10:00:00.000Z")
const WEATHER = "/Users/demo/code/weather-app"
const API = "/Users/demo/code/api-server"

function demoGit() {
  return new DemoGit(demoGitSeeds(NOW), () => NOW)
}

function hunksOf(git: DemoGit, path: string, staged: boolean) {
  return (
    parseGitDiff(git.diff(WEATHER, staged).diff).find(
      (file) => file.name === path
    )?.hunks ?? []
  )
}

describe("the demo's unified diffs", () => {
  it("are what git prints: headers, three lines of context, a replaced line removed first", () => {
    const before = ["one", "two", "three", "four", "five"].join("\n") + "\n"
    const after = ["one", "two", "THREE", "four", "five"].join("\n") + "\n"
    expect(unifiedFileDiff("a.txt", before, after)).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,5 +1,5 @@",
        " one",
        " two",
        "-three",
        "+THREE",
        " four",
        " five",
        "",
      ].join("\n")
    )
    expect(unifiedFileDiff("a.txt", before, before)).toBe("")
  })

  it("marks new and deleted files as git does", () => {
    expect(unifiedFileDiff("new.txt", undefined, "a\nb\n")).toBe(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n"
    )
    expect(unifiedFileDiff("old.txt", "a\n", undefined)).toBe(
      "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n"
    )
  })

  it("keeps changes six lines apart in one hunk and splits them at seven", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const edit = (changed: number[]) =>
      lines
        .map((line, index) => (changed.includes(index + 1) ? `${line}!` : line))
        .join("\n") + "\n"
    const original = lines.join("\n") + "\n"
    const hunks = (changed: number[]) =>
      parseGitDiff(unifiedFileDiff("f.txt", original, edit(changed)))[0]!.hunks
        .length
    expect(hunks([3, 10])).toBe(1)
    expect(hunks([3, 11])).toBe(2)
  })
})

describe("the demo repositories", () => {
  it("start with a staged, a changed and a new file, and a commit to push", () => {
    const git = demoGit()
    expect(git.status(WEATHER)).toEqual({
      branch: "main",
      is_clean: false,
      staged: ["package.json"],
      modified: ["README.md", "src/theme.ts"],
      untracked: ["src/screens/Radar.tsx"],
      ahead: 1,
      behind: 0,
      upstream: "origin/main",
    })
    expect(hunksOf(git, "README.md", false)).toHaveLength(2)
    expect(git.status(API)).toMatchObject({ is_clean: true, behind: 1 })
  })

  it("stages one hunk of two, and unstages it again", () => {
    const git = demoGit()
    const [first, second] = hunksOf(git, "README.md", false)
    git.applyHunk({
      cwd: WEATHER,
      path: "README.md",
      source: "unstaged",
      action: "accept",
      patch: first!.patch,
    })
    expect(git.status(WEATHER).staged).toEqual(["README.md", "package.json"])
    expect(hunksOf(git, "README.md", true).map((hunk) => hunk.patch)).toEqual([
      first!.patch,
    ])
    const [left] = hunksOf(git, "README.md", false)
    const text = (hunk: typeof left) =>
      hunk!.lines.map((line) => `${line.type}:${line.content}`)
    expect(text(left)).toEqual(text(second))

    const [staged] = hunksOf(git, "README.md", true)
    git.applyHunk({
      cwd: WEATHER,
      path: "README.md",
      source: "staged",
      action: "unstage",
      patch: staged!.patch,
    })
    expect(git.status(WEATHER).staged).toEqual(["package.json"])
    expect(hunksOf(git, "README.md", false)).toHaveLength(2)
  })

  it("discards one hunk from the working tree", () => {
    const git = demoGit()
    const [first] = hunksOf(git, "README.md", false)
    git.applyHunk({
      cwd: WEATHER,
      path: "README.md",
      source: "unstaged",
      action: "reject",
      patch: first!.patch,
    })
    expect(git.workingFile(WEATHER, "README.md")).toContain("for one city.")
    expect(hunksOf(git, "README.md", false)).toHaveLength(1)
  })

  it("refuses a hunk that no longer matches, in the desktop's words", () => {
    const git = demoGit()
    const [first] = hunksOf(git, "README.md", false)
    const accept = {
      cwd: WEATHER,
      path: "README.md",
      source: "unstaged" as const,
      action: "accept" as const,
      patch: first!.patch,
    }
    git.applyHunk(accept)
    expect(() => git.applyHunk(accept)).toThrow(
      expect.objectContaining({
        status: 409,
        code: "git_hunk_conflict",
        message:
          "This hunk no longer matches the workspace. Refresh the diff and review the latest changes.",
      })
    )
  })

  it("answers the same hunk action again as a replay", () => {
    const git = demoGit()
    const [first] = hunksOf(git, "README.md", false)
    const accept = {
      cwd: WEATHER,
      path: "README.md",
      source: "unstaged" as const,
      action: "accept" as const,
      patch: first!.patch,
      operationId: "hunk-1",
    }
    expect(git.applyHunk(accept).replayed).toBeUndefined()
    expect(git.applyHunk(accept)).toMatchObject({
      applied: true,
      replayed: true,
    })
  })

  it("stages and unstages files, all of them, and discards a changed file", () => {
    const git = demoGit()
    git.stage(WEATHER, ["src/screens/Radar.tsx"])
    expect(git.status(WEATHER).untracked).toEqual([])
    git.unstage(WEATHER, ["src/screens/Radar.tsx", "package.json"])
    expect(git.status(WEATHER)).toMatchObject({
      staged: [],
      untracked: ["src/screens/Radar.tsx"],
    })
    git.stageAll(WEATHER)
    expect(git.status(WEATHER)).toMatchObject({
      staged: [
        "README.md",
        "package.json",
        "src/screens/Radar.tsx",
        "src/theme.ts",
      ],
      modified: [],
      untracked: [],
    })
    git.unstageAll(WEATHER)
    git.discard(WEATHER, "src/theme.ts")
    expect(git.status(WEATHER).modified).toEqual(["README.md", "package.json"])
    expect(git.workingFile(WEATHER, "src/theme.ts")).toContain("#000000")
  })

  it("commits what is staged, and refuses to commit nothing", () => {
    const git = demoGit()
    git.commit(WEATHER, "Release 1.3.0\n\nBumps the version.")
    expect(git.status(WEATHER)).toMatchObject({ staged: [], ahead: 2 })
    expect(git.log(WEATHER, 1)[0]).toMatchObject({
      message: "Release 1.3.0",
      author: "Demo User",
      date: "2026-09-24 10:00:00 +0000",
    })
    expect(git.log(WEATHER, 1)[0]!.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(() => git.commit(WEATHER, "Again")).toThrow(
      expect.objectContaining({
        status: 400,
        code: "git_nothing_to_commit",
        message: NOTHING_TO_COMMIT,
      })
    )
  })

  it("pushes, publishes a new branch, and pulls what the remote has", () => {
    const git = demoGit()
    git.push(WEATHER)
    expect(git.status(WEATHER).ahead).toBe(0)

    git.checkout(WEATHER, "radar", true)
    expect(git.branches(WEATHER)).toEqual({
      branches: ["main", "radar", "release/1.4"],
      current: "radar",
    })
    expect(() => git.push(WEATHER)).toThrow(
      expect.objectContaining({
        status: 400,
        message: "Branch has no upstream — use Publish instead.",
      })
    )
    git.push(WEATHER, { setUpstream: true, branch: "radar" })
    expect(git.status(WEATHER).upstream).toBe("origin/radar")

    const api = demoGit()
    expect(() => api.push(API)).toThrow(
      expect.objectContaining({
        status: 409,
        message: "Remote has new commits — pull first, then push again.",
      })
    )
    api.pull(API)
    expect(api.status(API).behind).toBe(0)
    expect(api.log(API, 1)[0]!.message).toBe("Rate-limit the login endpoint")
  })

  it("is not a repository where the demo has none", () => {
    expect(() => demoGit().status("/Users/demo/elsewhere")).toThrow(
      RemoteApiError
    )
  })

  it("gives a new worktree a clean checkout on its own branch", () => {
    const git = demoGit()
    git.addWorktree("/tmp/wt", WEATHER, "agent/wt")
    expect(git.status("/tmp/wt")).toMatchObject({
      branch: "agent/wt",
      is_clean: true,
      upstream: null,
    })
    expect(git.workingFile("/tmp/wt", "src/theme.ts")).toContain("#000000")
  })
})
