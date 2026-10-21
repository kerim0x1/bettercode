import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const chat = vi.hoisted(() => ({
  createThread: vi.fn(() => "thread-1"),
  deleteThread: vi.fn(),
  updateThreadContext: vi.fn(),
  setDraft: vi.fn(),
  setThreadSetting: vi.fn(),
}))
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }))
const api = vi.hoisted(() => ({
  githubPullRequestDiff: vi.fn(),
  githubWorkOnPullRequest: vi.fn(),
}))

vi.mock("@/lib/chat-store", () => ({
  useChatStore: { getState: () => chat },
}))
vi.mock("@/lib/message-queue-store", () => ({
  useMessageQueueStore: { getState: () => queue },
}))
vi.mock("@/services/backend/github-api", () => api)

import {
  askAgentToReview,
  reviewPrompt,
  workOnPullRequest,
} from "./pull-request-work"
import {
  openPullRequestsPage,
  OPEN_PULL_REQUESTS_EVENT,
  pullRequestsPageTarget,
} from "./pull-requests-page"

const pullRequest = {
  number: 12,
  title: "Add retries",
  url: "https://github.com/o/r/pull/12",
  headBranch: "feat/retries",
  baseBranch: "main",
  body: "## Summary\nRetries failed calls.",
  author: "alice",
}

const dispatched: Event[] = []

beforeEach(() => {
  vi.clearAllMocks()
  dispatched.length = 0
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => {
      dispatched.push(event)
      return true
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("reviewPrompt", () => {
  it("asks for a read-only review with the description and the diff", () => {
    const prompt = reviewPrompt(pullRequest, {
      text: "diff --git a/x b/x\n+```js",
      truncated: false,
    })
    expect(prompt).toContain("Review pull request #12: Add retries")
    expect(prompt).toContain("Branch feat/retries into main, by @alice.")
    expect(prompt).toContain("Don't change any files.")
    expect(prompt).toContain("> ## Summary\n> Retries failed calls.")
    // The diff's own backticks cannot close its fence.
    expect(prompt).toContain("````diff\ndiff --git a/x b/x\n+```js\n````")
  })

  it("says when the diff was shortened", () => {
    expect(
      reviewPrompt({ ...pullRequest, body: "" }, { text: "x", truncated: true })
    ).toContain("Diff (shortened;")
  })
})

describe("askAgentToReview", () => {
  it("opens a read-only chat and sends it the review request", async () => {
    api.githubPullRequestDiff.mockResolvedValue({
      diff: "diff --git a/x b/x",
      truncated: false,
      totalBytes: 18,
    })
    await expect(askAgentToReview("/work/r", pullRequest)).resolves.toBe(
      "thread-1"
    )
    expect(chat.createThread).toHaveBeenCalledWith(
      "Review #12: Add retries",
      "r",
      "/work/r",
      {}
    )
    expect(chat.setThreadSetting).toHaveBeenCalledWith(
      "thread-1",
      "permissionLevel",
      "read-only"
    )
    expect(queue.enqueue).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        files: [],
        browserElements: [],
        text: expect.stringContaining("diff --git a/x b/x"),
      })
    )
    expect(dispatched.map((event) => event.type)).toEqual([
      "betterc0de:open-thread",
    ])
  })
})

describe("workOnPullRequest", () => {
  it("puts the new chat on the checked-out worktree", async () => {
    api.githubWorkOnPullRequest.mockResolvedValue({
      mode: "worktree",
      path: "/home/me/.betterc0de/worktrees/abc/thread1",
      branch: "feat/retries",
      baseBranch: "main",
      worktreeId: "w1",
      headSha: "abc",
      crossRepository: false,
    })
    await expect(workOnPullRequest("/work/r", pullRequest)).resolves.toEqual({
      threadId: "thread-1",
      crossRepository: false,
    })
    expect(chat.updateThreadContext).toHaveBeenCalledWith("thread-1", {
      envMode: "worktree",
      branch: "feat/retries",
      worktreePath: "/home/me/.betterc0de/worktrees/abc/thread1",
      baseBranch: "main",
      worktreeState: "ready",
    })
    expect(chat.setDraft).toHaveBeenCalled()
  })

  it("removes the empty chat when the branch can't be checked out", async () => {
    api.githubWorkOnPullRequest.mockRejectedValue(new Error("checked out"))
    await expect(workOnPullRequest("/work/r", pullRequest)).rejects.toThrow(
      "checked out"
    )
    expect(chat.deleteThread).toHaveBeenCalledWith("thread-1")
    expect(dispatched).toEqual([])
  })
})

describe("pull requests page events", () => {
  it("carries the pull request to open, and nothing when it is not valid", () => {
    openPullRequestsPage({ cwd: "/work/r", number: 12 })
    expect(dispatched[0]!.type).toBe(OPEN_PULL_REQUESTS_EVENT)
    expect(pullRequestsPageTarget(dispatched[0]!)).toEqual({
      cwd: "/work/r",
      number: 12,
    })
    openPullRequestsPage()
    expect(pullRequestsPageTarget(dispatched[1]!)).toBeNull()
    expect(
      pullRequestsPageTarget(
        new CustomEvent("x", { detail: { cwd: "/w", number: -1 } })
      )
    ).toBeNull()
  })
})
