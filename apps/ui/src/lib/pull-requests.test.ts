import { describe, expect, it } from "vitest"
import type {
  GitHubPullRequestSummary,
  GitHubRepositoryPullRequests,
} from "@betterc0de/schema/http-contracts"
import {
  checkSummaryLook,
  filterCounts,
  filterPullRequests,
  flattenPullRequests,
  overviewProblems,
  pullRequestProjectFolders,
  pullRequestStateLook,
  reviewDecisionLook,
  updatedAgo,
} from "./pull-requests"

function summary(
  overrides: Partial<GitHubPullRequestSummary> = {}
): GitHubPullRequestSummary {
  return {
    number: 1,
    title: "Add retries",
    url: "https://github.com/o/r/pull/1",
    state: "open",
    author: "alice",
    authorIsBot: false,
    headBranch: "feat/retries",
    baseBranch: "main",
    isCrossRepository: false,
    createdAt: "2026-10-20T08:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z",
    reviewDecision: null,
    reviewRequested: false,
    checks: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 },
    additions: 1,
    deletions: 0,
    labels: [],
    ...overrides,
  }
}

function repository(
  overrides: Partial<GitHubRepositoryPullRequests> = {}
): GitHubRepositoryPullRequests {
  return {
    cwd: "/work/r",
    slug: "o/r",
    status: "ok",
    message: null,
    pullRequests: [],
    fetchedAt: "2026-10-20T10:00:00Z",
    ...overrides,
  }
}

describe("pullRequestProjectFolders", () => {
  it("lists each project folder once, most recently used first", () => {
    expect(
      pullRequestProjectFolders([
        { projectPath: "/a", updatedAt: "2026-10-01T00:00:00Z" },
        { projectPath: "/b/", updatedAt: "2026-10-03T00:00:00Z" },
        { projectPath: "/a", updatedAt: "2026-10-05T00:00:00Z" },
        { projectPath: "", updatedAt: "2026-10-09T00:00:00Z" },
        { projectPath: null },
      ])
    ).toEqual(["/a", "/b"])
    expect(
      pullRequestProjectFolders(
        [{ projectPath: "/a" }, { projectPath: "/b" }],
        1
      )
    ).toHaveLength(1)
  })
})

describe("filters and search", () => {
  const list = flattenPullRequests([
    repository({
      pullRequests: [
        summary({ number: 1, updatedAt: "2026-10-20T09:00:00Z" }),
        summary({
          number: 2,
          author: "Me",
          title: "Fix login",
          labels: ["bug"],
          updatedAt: "2026-10-20T11:00:00Z",
        }),
      ],
    }),
    repository({
      cwd: "/work/s",
      slug: "o/s",
      pullRequests: [
        summary({
          number: 3,
          reviewRequested: true,
          headBranch: "dependabot/npm",
          updatedAt: "2026-10-20T10:00:00Z",
        }),
      ],
    }),
    repository({ cwd: "/work/x", slug: null, status: "no_remote" }),
  ])

  it("lists every repository's pull requests by latest activity", () => {
    expect(list.map((entry) => [entry.slug, entry.number])).toEqual([
      ["o/r", 2],
      ["o/s", 3],
      ["o/r", 1],
    ])
    expect(list[1]!.cwd).toBe("/work/s")
  })

  it("filters mine, review requested and all", () => {
    const pick = (filter: "mine" | "review" | "all", query = "") =>
      filterPullRequests(list, { filter, query, viewerLogin: "me" }).map(
        (entry) => entry.number
      )
    expect(pick("mine")).toEqual([2])
    expect(pick("review")).toEqual([3])
    expect(pick("all")).toEqual([2, 3, 1])
    expect(filterCounts(list, "me")).toEqual({ mine: 1, review: 1, all: 3 })
    expect(
      filterPullRequests(list, { filter: "mine", query: "", viewerLogin: null })
    ).toEqual([])
  })

  it("searches title, number, author, branch, repository and labels", () => {
    const search = (query: string) =>
      filterPullRequests(list, { filter: "all", query, viewerLogin: "me" }).map(
        (entry) => entry.number
      )
    expect(search("login")).toEqual([2])
    expect(search("#3")).toEqual([3])
    expect(search("BUG")).toEqual([2])
    expect(search("o/s dependabot")).toEqual([3])
    expect(search("alice feat/retries")).toEqual([1])
    expect(search("nothing-like-this")).toEqual([])
  })
})

describe("looks", () => {
  it("names a state with its tone", () => {
    expect(pullRequestStateLook("merged")).toEqual({
      label: "Merged",
      tone: "merged",
    })
    expect(pullRequestStateLook("draft").tone).toBe("muted")
  })

  it("summarizes checks by their worst outcome", () => {
    expect(
      checkSummaryLook({
        total: 4,
        passed: 2,
        failed: 1,
        pending: 1,
        skipped: 0,
      })
    ).toMatchObject({ state: "fail", label: "1 check failing", short: "2/4" })
    expect(
      checkSummaryLook({
        total: 3,
        passed: 1,
        failed: 0,
        pending: 2,
        skipped: 0,
      })
    ).toMatchObject({ state: "pending", label: "2 checks running" })
    expect(
      checkSummaryLook({
        total: 2,
        passed: 2,
        failed: 0,
        pending: 0,
        skipped: 0,
      })
    ).toMatchObject({ state: "pass", label: "2 of 2 checks passed" })
    expect(
      checkSummaryLook({
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
      }).state
    ).toBe("none")
  })

  it("names review decisions", () => {
    expect(reviewDecisionLook("changes_requested")).toEqual({
      label: "Changes requested",
      tone: "danger",
    })
    expect(reviewDecisionLook(null)).toBeNull()
  })

  it("says how long ago something changed", () => {
    const now = Date.parse("2026-10-20T12:00:00Z")
    expect(updatedAgo("2026-10-20T11:59:40Z", now)).toBe("just now")
    expect(updatedAgo("2026-10-20T11:15:00Z", now)).toBe("45m ago")
    expect(updatedAgo("2026-10-20T07:00:00Z", now)).toBe("5h ago")
    expect(updatedAgo("2026-10-17T12:00:00Z", now)).toBe("3d ago")
    expect(updatedAgo(null, now)).toBe("")
  })
})

describe("overviewProblems", () => {
  it("reports the CLI problem once and counts projects without a remote", () => {
    expect(
      overviewProblems([
        repository({ status: "gh_signed_out", message: "Sign in" }),
        repository({
          slug: "o/s",
          status: "gh_signed_out",
          message: "Sign in",
        }),
        repository({ slug: null, status: "no_remote" }),
        repository({ slug: "o/t", status: "error", message: "HTTP 500" }),
      ])
    ).toEqual({
      cli: { status: "gh_signed_out", message: "Sign in" },
      withoutRemote: 1,
      errors: [{ slug: "o/t", message: "HTTP 500" }],
    })
  })
})
