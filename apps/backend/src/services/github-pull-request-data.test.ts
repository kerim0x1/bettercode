import { describe, expect, it } from "vitest"
import type { GitHubRepositoryInfo } from "@betterc0de/schema/http-contracts"
import {
  actionsJobFromUrl,
  failedLogTail,
  findPullRequestUrl,
  isPullRequestAlreadyExists,
  MAX_CONVERSATION_ITEMS,
  parseCheckRuns,
  parseConversation,
  parsePullRequestDetail,
  parsePullRequestSummaries,
  parseRepositoryFields,
  parseReviewComments,
  summarizeChecks,
} from "./github-pull-request-data"

const repository: GitHubRepositoryInfo = {
  status: "ok",
  message: null,
  slug: "o/r",
  remote: "origin",
  url: "https://github.com/o/r",
  defaultBranch: "main",
  viewerLogin: "me",
  viewerPermission: "WRITE",
  mergeMethods: { merge: true, squash: true, rebase: false },
  deleteBranchOnMerge: false,
}

const rollup = [
  {
    __typename: "CheckRun",
    name: "test",
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/o/r/actions/runs/11/job/22",
    startedAt: "2026-10-20T10:00:00Z",
    completedAt: "2026-10-20T10:05:00Z",
  },
  {
    __typename: "CheckRun",
    name: "lint",
    status: "COMPLETED",
    conclusion: "SUCCESS",
  },
  { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
  {
    __typename: "CheckRun",
    name: "docs",
    status: "COMPLETED",
    conclusion: "SKIPPED",
  },
  {
    __typename: "StatusContext",
    context: "deploy/preview",
    state: "ERROR",
    targetUrl: "https://example.test/deploy",
  },
  { __typename: "CheckRun", status: "COMPLETED" },
]

describe("check runs", () => {
  it("reads check runs and commit statuses as one outcome each", () => {
    const runs = parseCheckRuns(rollup)
    expect(runs.map((run) => [run.name, run.status])).toEqual([
      ["test", "fail"],
      ["lint", "pass"],
      ["build", "pending"],
      ["docs", "skipped"],
      ["deploy/preview", "fail"],
    ])
    expect(runs[0]).toMatchObject({
      workflow: "CI",
      url: "https://github.com/o/r/actions/runs/11/job/22",
      completedAt: "2026-10-20T10:05:00Z",
    })
    expect(runs[4]!.url).toBe("https://example.test/deploy")
  })

  it("summarizes them, counting a cancelled check as failed", () => {
    const runs = parseCheckRuns([
      ...rollup,
      {
        __typename: "CheckRun",
        name: "e2e",
        status: "COMPLETED",
        conclusion: "CANCELLED",
      },
    ])
    expect(summarizeChecks(runs)).toEqual({
      total: 6,
      passed: 1,
      failed: 3,
      pending: 1,
      skipped: 1,
    })
    expect(parseCheckRuns("nope")).toEqual([])
  })
})

describe("parsePullRequestSummaries", () => {
  it("maps gh rows, including forks, and skips malformed ones", () => {
    const rows = [
      {
        number: 7,
        title: "Add retries",
        url: "https://github.com/o/r/pull/7",
        state: "OPEN",
        isDraft: true,
        author: { login: "alice", is_bot: false },
        headRefName: "feat/retries",
        baseRefName: "main",
        isCrossRepository: true,
        updatedAt: "2026-10-20T10:00:00Z",
        reviewDecision: "CHANGES_REQUESTED",
        reviewRequests: [
          { __typename: "User", login: "ME" },
          { __typename: "Team", slug: "core" },
        ],
        statusCheckRollup: rollup,
        additions: 10,
        deletions: 2,
        labels: [{ name: "bug" }, { color: "red" }],
      },
      {
        number: 8,
        title: "Bump deps",
        url: "https://github.com/o/r/pull/8",
        state: "OPEN",
        author: { login: "app/dependabot", is_bot: true },
        headRefName: "dependabot/npm",
      },
      { number: "9", url: "u", headRefName: "x" },
    ]
    const summaries = parsePullRequestSummaries(rows, "me")
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      number: 7,
      state: "draft",
      author: "alice",
      authorIsBot: false,
      isCrossRepository: true,
      reviewDecision: "changes_requested",
      reviewRequested: true,
      checks: { total: 5, failed: 2, passed: 1, pending: 1, skipped: 1 },
      labels: ["bug"],
    })
    expect(summaries[1]).toMatchObject({
      authorIsBot: true,
      reviewRequested: false,
      reviewDecision: null,
      baseBranch: "",
    })
    expect(parsePullRequestSummaries({}, "me")).toEqual([])
  })
})

describe("parseConversation", () => {
  it("merges comments and submitted reviews oldest first", () => {
    const { items, truncated } = parseConversation(
      [
        {
          id: "c1",
          author: { login: "bob" },
          authorAssociation: "MEMBER",
          body: "Looks good",
          createdAt: "2026-10-20T10:02:00Z",
          url: "https://github.com/o/r/pull/7#issuecomment-1",
        },
      ],
      [
        {
          id: "r1",
          author: { login: "carol" },
          authorAssociation: "COLLABORATOR",
          body: "Please fix",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-20T10:01:00Z",
        },
        { id: "r2", author: { login: "me" }, state: "PENDING", body: "draft" },
      ]
    )
    expect(truncated).toBe(false)
    expect(items.map((item) => [item.kind, item.id, item.reviewState])).toEqual(
      [
        ["review", "r1", "changes_requested"],
        ["comment", "c1", null],
      ]
    )
    expect(items[1]!.authorAssociation).toBe("MEMBER")
  })

  it("keeps only the newest items of a long conversation", () => {
    const comments = Array.from(
      { length: MAX_CONVERSATION_ITEMS + 5 },
      (_, index) => ({
        id: `c${index}`,
        author: { login: "bob" },
        body: "x",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })
    )
    const { items, truncated } = parseConversation(comments, [])
    expect(truncated).toBe(true)
    expect(items).toHaveLength(MAX_CONVERSATION_ITEMS)
    expect(items.at(-1)!.id).toBe(`c${MAX_CONVERSATION_ITEMS + 4}`)
  })
})

describe("parsePullRequestDetail", () => {
  it("reads the page fields and whether the viewer wrote it", () => {
    const detail = parsePullRequestDetail(
      {
        number: 7,
        title: "Add retries",
        url: "https://github.com/o/r/pull/7",
        state: "OPEN",
        author: { login: "Me" },
        headRefName: "feat/retries",
        baseRefName: "main",
        body: "## Summary",
        headRefOid: "abc1234def",
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        changedFiles: 2,
        files: [{ path: "a.ts", additions: 1, deletions: 0 }, { additions: 3 }],
        comments: [],
        reviews: [],
      },
      { viewerLogin: "me", repository }
    )
    expect(detail).toMatchObject({
      body: "## Summary",
      bodyTruncated: false,
      headSha: "abc1234def",
      mergeable: "conflicting",
      mergeStateStatus: "DIRTY",
      changedFiles: 2,
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      viewerIsAuthor: true,
      repository,
    })
    expect(
      parsePullRequestDetail(null, { viewerLogin: null, repository })
    ).toBe(null)
  })
})

describe("gh pr create output", () => {
  it("finds the created pull request's address", () => {
    expect(
      findPullRequestUrl(
        "Creating pull request for feat into main\n\nhttps://github.com/o/r/pull/42\n"
      )
    ).toEqual({ url: "https://github.com/o/r/pull/42", number: 42 })
    expect(findPullRequestUrl("no url here")).toBeNull()
  })

  it("recognizes a branch that already has a pull request", () => {
    const stderr =
      'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/o/r/pull/12'
    expect(isPullRequestAlreadyExists(stderr)).toBe(true)
    expect(findPullRequestUrl(stderr)?.number).toBe(12)
    expect(isPullRequestAlreadyExists("HTTP 422")).toBe(false)
  })
})

describe("parseRepositoryFields", () => {
  it("reads the allowed merge methods and the default branch", () => {
    expect(
      parseRepositoryFields({
        defaultBranchRef: { name: "trunk" },
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        deleteBranchOnMerge: true,
        viewerPermission: "ADMIN",
        url: "https://github.com/o/r",
      })
    ).toEqual({
      defaultBranch: "trunk",
      viewerPermission: "ADMIN",
      mergeMethods: { merge: false, squash: true, rebase: false },
      deleteBranchOnMerge: true,
      url: "https://github.com/o/r",
    })
  })

  it("falls back to merge commits when GitHub allows none", () => {
    expect(
      parseRepositoryFields({
        mergeCommitAllowed: false,
        squashMergeAllowed: false,
        rebaseMergeAllowed: false,
      }).mergeMethods
    ).toEqual({ merge: true, squash: false, rebase: false })
    expect(parseRepositoryFields(null).defaultBranch).toBeNull()
  })
})

describe("Actions logs", () => {
  it("reads the run and job of a check's link", () => {
    expect(
      actionsJobFromUrl("https://github.com/o/r/actions/runs/11/job/22")
    ).toEqual({ runId: "11", jobId: "22" })
    expect(actionsJobFromUrl("https://github.com/o/r/actions/runs/11")).toEqual(
      { runId: "11", jobId: null }
    )
    expect(actionsJobFromUrl("https://ci.example.test/build/1")).toBeNull()
    expect(actionsJobFromUrl(null)).toBeNull()
  })

  it("keeps the end of a failed log without columns, timestamps or colours", () => {
    const log = [
      "test\tRun tests\t2026-10-20T10:00:00.1234567Z \u001b[31mFAIL\u001b[0m src/a.test.ts",
      "test\tRun tests\t2026-10-20T10:00:01.0000000Z   expected 1, got 2",
      "test\tRun tests\t2026-10-20T10:00:02.0000000Z ",
      "test\tRun tests\t2026-10-20T10:00:03.0000000Z Error: Process completed with exit code 1.",
    ].join("\n")
    expect(failedLogTail(log)).toBe(
      [
        "FAIL src/a.test.ts",
        "  expected 1, got 2",
        "Error: Process completed with exit code 1.",
      ].join("\n")
    )
    expect(failedLogTail(log, { maxLines: 1 })).toBe(
      "Error: Process completed with exit code 1."
    )
    expect(failedLogTail("x".repeat(5_000), { maxChars: 100 })).toHaveLength(
      100
    )
  })
})

describe("parseReviewComments", () => {
  it("maps REST review comments and skips rows without an id", () => {
    expect(
      parseReviewComments([
        {
          id: 5,
          user: { login: "copilot[bot]", type: "Bot" },
          author_association: "NONE",
          body: "Consider a guard here.",
          created_at: "2026-10-20T10:00:00Z",
          path: "src/a.ts",
          original_line: 12,
          html_url: "https://github.com/o/r/pull/7#discussion_r5",
        },
        { body: "no id" },
      ])
    ).toEqual([
      {
        id: "5",
        author: "copilot[bot]",
        authorIsBot: true,
        authorAssociation: "NONE",
        body: "Consider a guard here.",
        createdAt: "2026-10-20T10:00:00Z",
        path: "src/a.ts",
        line: 12,
        url: "https://github.com/o/r/pull/7#discussion_r5",
      },
    ])
  })
})
