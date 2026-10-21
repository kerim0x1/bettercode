import { describe, expect, it } from "vitest"
import { parseGitHubSlug, parsePullRequests } from "./github-pull-requests"

describe("parseGitHubSlug", () => {
  it.each([
    ["https://github.com/kerim0x1/bettercode.git", "kerim0x1/bettercode"],
    ["https://token@github.com/owner/repo", "owner/repo"],
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
  ])("reads %s", (url, slug) => {
    expect(parseGitHubSlug(url)).toBe(slug)
  })

  it("ignores other hosts", () => {
    expect(parseGitHubSlug("https://gitlab.com/owner/repo.git")).toBeNull()
    expect(
      parseGitHubSlug("https://github.com.evil.test/owner/repo")
    ).toBeNull()
  })
})

describe("parsePullRequests", () => {
  it("maps gh rows and their state, skipping forks and malformed rows", () => {
    const rows = [
      {
        number: 12,
        title: "Open one",
        url: "https://github.com/o/r/pull/12",
        state: "OPEN",
        isDraft: false,
        headRefName: "feat/a",
        isCrossRepository: false,
        updatedAt: "2026-10-15T10:00:00Z",
      },
      {
        number: 11,
        title: "Draft",
        url: "https://github.com/o/r/pull/11",
        state: "OPEN",
        isDraft: true,
        headRefName: "feat/b",
      },
      {
        number: 10,
        title: "Merged",
        url: "https://github.com/o/r/pull/10",
        state: "MERGED",
        headRefName: "feat/c",
      },
      {
        number: 9,
        title: "From a fork",
        url: "https://github.com/o/r/pull/9",
        state: "OPEN",
        headRefName: "main",
        isCrossRepository: true,
      },
      { number: "8", headRefName: "x", url: "u" },
    ]
    expect(parsePullRequests(JSON.stringify(rows))).toEqual([
      {
        number: 12,
        title: "Open one",
        url: "https://github.com/o/r/pull/12",
        state: "open",
        branch: "feat/a",
        updatedAt: "2026-10-15T10:00:00Z",
      },
      expect.objectContaining({ number: 11, state: "draft" }),
      expect.objectContaining({ number: 10, state: "merged" }),
    ])
  })

  it("returns nothing for output that is not a JSON list", () => {
    expect(parsePullRequests("gh: not logged in")).toEqual([])
    expect(parsePullRequests("{}")).toEqual([])
  })
})
