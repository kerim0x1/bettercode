import { describe, expect, it } from "vitest"
import {
  describeRemoteSync,
  filterChangedFiles,
  parseDiffStats,
  pluralCommits,
  remoteSyncStatusText,
  splitGitFilePath,
  threadMatchesPanelCwd,
} from "./git-panel-utils"

const idle = {
  isPushing: false,
  isPulling: false,
  isCommitting: false,
  isFetching: false,
}

describe("parseDiffStats", () => {
  it("counts added and removed lines per file, ignoring the file headers", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+more",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "-gone",
      "",
    ].join("\n")
    expect(parseDiffStats(diff)).toEqual({
      "src/app.ts": { additions: 2, deletions: 1 },
      "README.md": { additions: 0, deletions: 1 },
    })
  })

  it("returns nothing for an empty diff", () => {
    expect(parseDiffStats("")).toEqual({})
  })
})

describe("threadMatchesPanelCwd", () => {
  it("matches the project or worktree path, ignoring trailing separators", () => {
    expect(threadMatchesPanelCwd({ projectPath: "/repo/" }, "/repo")).toBe(true)
    expect(
      threadMatchesPanelCwd(
        { projectPath: "/other", worktreePath: "C:\\wt\\" },
        "C:\\wt"
      )
    ).toBe(true)
    expect(threadMatchesPanelCwd({ projectPath: "/other" }, "/repo")).toBe(
      false
    )
  })

  it("never matches an empty panel folder", () => {
    expect(threadMatchesPanelCwd({ projectPath: "" }, "")).toBe(false)
  })
})

describe("filterChangedFiles", () => {
  const files = ["src/App.tsx", "docs/readme.md"]

  it("filters case-insensitively when the mode has a filter field", () => {
    expect(filterChangedFiles(files, "  app ", true)).toEqual(["src/App.tsx"])
  })

  it("keeps every file without a filter or where the mode has none", () => {
    expect(filterChangedFiles(files, "   ", true)).toBe(files)
    expect(filterChangedFiles(files, "app", false)).toBe(files)
  })
})

describe("splitGitFilePath", () => {
  it("splits POSIX and Windows paths into name and directory", () => {
    expect(splitGitFilePath("src/lib/a.ts")).toEqual({
      fileName: "a.ts",
      dirPath: "src/lib/",
    })
    expect(splitGitFilePath("src\\b.ts")).toEqual({
      fileName: "b.ts",
      dirPath: "src\\",
    })
    expect(splitGitFilePath("c.ts")).toEqual({ fileName: "c.ts", dirPath: "" })
  })
})

describe("remote sync state", () => {
  it("offers to publish a branch without an upstream", () => {
    const sync = describeRemoteSync(
      { branch: "feature", ahead: 0, behind: 0, upstream: null },
      idle
    )
    expect(sync.pushTitle).toBe('Publish "feature" to remote')
    expect(sync.pullTitle).toBe("No upstream — set one before pulling")
    expect(sync.pushDisabled).toBe(false)
    expect(sync.pullDisabled).toBe(true)
  })

  it("disables Push when the branch is up to date and everything while busy", () => {
    const upToDate = describeRemoteSync(
      { branch: "main", ahead: 0, behind: 2, upstream: "origin/main" },
      idle
    )
    expect(upToDate.pushTitle).toBe("Up to date with origin/main")
    expect(upToDate.pullTitle).toBe("Pull 2 commits from origin/main")
    expect(upToDate.pushDisabled).toBe(true)
    expect(upToDate.pullDisabled).toBe(false)

    const busy = describeRemoteSync(
      { branch: "main", ahead: 1, behind: 0, upstream: "origin/main" },
      { ...idle, isFetching: true }
    )
    expect(busy.pushTitle).toBe("Push 1 commit to origin/main")
    expect(busy.remoteBusy).toBe(true)
    expect(busy.pushDisabled).toBe(true)
    expect(busy.pullDisabled).toBe(true)
  })

  it("describes the last fetch", () => {
    const fetchedAt = new Date(0)
    expect(
      remoteSyncStatusText({
        isFetching: true,
        lastFetchedAt: fetchedAt,
        upstream: "o/m",
        behind: 1,
      })
    ).toBe("Checking for remote updates…")
    expect(
      remoteSyncStatusText({
        isFetching: false,
        lastFetchedAt: null,
        upstream: "o/m",
        behind: 1,
      })
    ).toBe("Fetch to check for incoming commits")
    expect(
      remoteSyncStatusText({
        isFetching: false,
        lastFetchedAt: fetchedAt,
        upstream: null,
        behind: 0,
      })
    ).toBe("Remote checked · publish to track this branch")
    expect(
      remoteSyncStatusText({
        isFetching: false,
        lastFetchedAt: fetchedAt,
        upstream: "o/m",
        behind: 3,
      })
    ).toBe("3 commits available to pull")
    expect(
      remoteSyncStatusText({
        isFetching: false,
        lastFetchedAt: fetchedAt,
        upstream: "o/m",
        behind: 0,
      })
    ).toBe("No incoming commits · remote checked")
  })

  it("pluralizes commits", () => {
    expect(pluralCommits(1)).toBe("1 commit")
    expect(pluralCommits(0)).toBe("0 commits")
  })
})
