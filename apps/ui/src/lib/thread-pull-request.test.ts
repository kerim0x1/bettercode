import { describe, expect, it } from "vitest"
import {
  pullRequestForBranch,
  pullRequestState,
} from "@/lib/thread-pull-request"
import type { GitPullRequest } from "@/services/backend/gitApi"

function pr(
  number: number,
  branch: string,
  state: string,
  updatedAt: string | null = null
): GitPullRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state,
    branch,
    updatedAt,
  }
}

describe("pullRequestForBranch", () => {
  it("prefers an open pull request over a newer merged one", () => {
    const list = [
      pr(3, "feat/a", "merged", "2026-10-15T12:00:00Z"),
      pr(2, "feat/a", "open", "2026-10-14T12:00:00Z"),
      pr(1, "feat/b", "open"),
    ]
    expect(pullRequestForBranch(list, "feat/a")?.number).toBe(2)
  })

  it("takes the newest when none is open, and null without a match", () => {
    const list = [
      pr(4, "feat/a", "closed", "2026-10-10T12:00:00Z"),
      pr(5, "feat/a", "merged", "2026-10-12T12:00:00Z"),
    ]
    expect(pullRequestForBranch(list, "feat/a")?.number).toBe(5)
    expect(pullRequestForBranch(list, "main")).toBeNull()
  })
})

describe("pullRequestState", () => {
  it("reads unknown states as closed", () => {
    expect(pullRequestState(pr(1, "a", "draft"))).toBe("draft")
    expect(pullRequestState(pr(1, "a", "something-new"))).toBe("closed")
  })
})
