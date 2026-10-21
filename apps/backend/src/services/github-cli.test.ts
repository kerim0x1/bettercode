import { describe, expect, it } from "vitest"
import {
  classifyGhFailure,
  ghFailureError,
  ghFailureSummary,
  GH_SIGNED_OUT_MESSAGE,
} from "./github-cli"

describe("classifyGhFailure", () => {
  it.each([
    [
      "To get started with GitHub CLI, please run:  gh auth login",
      "signed_out",
    ],
    [
      "HTTP 401: Bad credentials (https://api.github.com/graphql)",
      "signed_out",
    ],
    ["GraphQL: API rate limit exceeded for user ID 1.", "rate_limited"],
    [
      "GraphQL: Could not resolve to a PullRequest with the number of 999.",
      "not_found",
    ],
    [
      "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
      "network",
    ],
    ["GraphQL: Pull request is not mergeable (mergePullRequest)", "failed"],
  ])("reads %j as %s", (output, kind) => {
    expect(classifyGhFailure(output)).toBe(kind)
  })
})

describe("ghFailureSummary", () => {
  it("keeps GitHub's reason and drops the usage text", () => {
    expect(
      ghFailureSummary(
        "GraphQL: Base branch was modified. Review and try the merge again.\n\nUsage:  gh pr merge [<number>] [flags]\n\nFlags:\n  --admin"
      )
    ).toBe("GraphQL: Base branch was modified. Review and try the merge again.")
  })

  it("redacts tokens that ended up in the output", () => {
    expect(
      ghFailureSummary("failed with ghp_abcdefghijklmnopqrstuvwxyz0123")
    ).not.toContain("abcdefghijklmnopqrstuvwxyz0123")
  })
})

describe("ghFailureError", () => {
  it("tells a signed-out user what to run", () => {
    const error = ghFailureError({
      status: 4,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts. Run gh auth login",
    })
    expect(error.statusCode).toBe(412)
    expect(error.code).toBe("github_cli_signed_out")
    expect(error.message).toBe(GH_SIGNED_OUT_MESSAGE)
  })

  it("reads a run that never finished as a timeout", () => {
    const error = ghFailureError({ status: null, stdout: "", stderr: "" })
    expect(error.statusCode).toBe(504)
    expect(error.code).toBe("github_cli_timeout")
  })

  it("passes GitHub's own reason through for other failures", () => {
    const error = ghFailureError({
      status: 1,
      stdout: "",
      stderr: "GraphQL: Pull request is not mergeable (mergePullRequest)",
    })
    expect(error.statusCode).toBe(502)
    expect(error.code).toBe("github_cli_failed")
    expect(error.message).toBe(
      "GraphQL: Pull request is not mergeable (mergePullRequest)"
    )
  })
})
