import { describe, expect, it } from "vitest"
import { HttpError } from "@/lib/errors"
import {
  baseBranchOptions,
  cleanBranchName,
  createPullRequestBlocker,
  fallbackPullRequestTitle,
  githubSetupHint,
  pullRequestErrorMessage,
  pushPlan,
} from "./pull-request-create"

const ready = {
  status: "ok" as const,
  message: null,
  defaultBranch: "main",
}

function pr(state: string) {
  return {
    number: 4,
    title: "Existing",
    url: "https://github.com/o/r/pull/4",
    state,
    branch: "feat/a",
    updatedAt: null,
  }
}

describe("createPullRequestBlocker", () => {
  it("passes a feature branch without an open pull request", () => {
    expect(
      createPullRequestBlocker({
        repository: ready,
        branch: "feat/a",
        existing: pr("merged"),
      })
    ).toBeNull()
  })

  it("stops for the GitHub CLI or remote first", () => {
    expect(
      createPullRequestBlocker({
        repository: {
          status: "gh_signed_out",
          message: "Sign in",
          defaultBranch: null,
        },
        branch: "main",
        existing: null,
      })
    ).toEqual({ kind: "github", status: "gh_signed_out", message: "Sign in" })
  })

  it("asks for a branch of its own on the default branch or a detached head", () => {
    expect(
      createPullRequestBlocker({
        repository: ready,
        branch: "main",
        existing: null,
      })
    ).toEqual({ kind: "default_branch", branch: "main" })
    expect(
      createPullRequestBlocker({
        repository: ready,
        branch: "HEAD",
        existing: null,
      })
    ).toEqual({ kind: "detached" })
  })

  it("shows an open or draft pull request instead of a second one", () => {
    expect(
      createPullRequestBlocker({
        repository: ready,
        branch: "feat/a",
        existing: pr("draft"),
      })
    ).toMatchObject({ kind: "existing", pullRequest: { number: 4 } })
  })
})

describe("pushPlan", () => {
  const status = {
    branch: "feat/a",
    upstream: "origin/feat/a",
    ahead: 0,
    behind: 0,
  }

  it("publishes a branch without an upstream", () => {
    expect(pushPlan({ ...status, upstream: null }, "origin")).toEqual({
      kind: "publish",
      branch: "feat/a",
      remote: "origin",
    })
  })

  it("pushes commits GitHub does not have, and stops a branch that is behind", () => {
    expect(pushPlan({ ...status, ahead: 2 }, "origin")).toEqual({
      kind: "push",
    })
    expect(pushPlan({ ...status, ahead: 1, behind: 3 }, "origin")).toEqual({
      kind: "behind",
      behind: 3,
    })
    expect(pushPlan(status, "origin")).toEqual({ kind: "none" })
  })
})

describe("baseBranchOptions", () => {
  it("offers the default branch first, without the head or duplicates", () => {
    expect(
      baseBranchOptions("main", ["develop", "feat/a", "main", " "], "feat/a")
    ).toEqual(["main", "develop"])
    expect(baseBranchOptions(null, ["feat/a"], "feat/a")).toEqual([])
  })
})

describe("fallbackPullRequestTitle", () => {
  it("takes the newest commit's subject", () => {
    expect(
      fallbackPullRequestTitle(
        { commits: "abc1234 Add retries\ndef5678 Start" },
        "feat/retries"
      )
    ).toBe("Add retries")
  })

  it("names the branch when there are no commits", () => {
    expect(fallbackPullRequestTitle(null, "feat/add-retry_logic")).toBe(
      "Add retry logic"
    )
  })
})

describe("cleanBranchName", () => {
  it("turns a suggestion into a name git accepts", () => {
    expect(cleanBranchName("  feature/Add retries: now  ")).toBe(
      "feature/Add-retries-now"
    )
    expect(cleanBranchName("-/fix..login~1/")).toBe("fix.login-1")
    expect(cleanBranchName("topic.lock")).toBe("topic")
  })
})

describe("messages", () => {
  it("explains an untrusted workspace", () => {
    expect(
      pullRequestErrorMessage(
        new HttpError("refused", 403, "/github/pull-requests/create", {
          code: "workspace_untrusted",
        })
      )
    ).toContain("isn't trusted")
    expect(pullRequestErrorMessage(new Error("boom"))).toBe("boom")
  })

  it("gives setup steps for a CLI problem only", () => {
    expect(githubSetupHint("gh_missing")).toContain("gh auth login")
    expect(githubSetupHint("ok")).toBeNull()
  })
})
