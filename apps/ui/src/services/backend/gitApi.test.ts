import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getOpenTargets,
  gitApplyHunk,
  gitDiff,
  gitDiffStaged,
  gitLog,
  gitStage,
  gitUserProfile,
  isGitRepo,
} from "./gitApi"
import { invoke } from "./runtime"

vi.mock("./runtime", () => ({
  invoke: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

describe("gitApi", () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it("unwraps backend git repo envelopes into booleans", async () => {
    mockedInvoke.mockResolvedValueOnce({ is_repo: false })
    await expect(isGitRepo("/not-a-repo")).resolves.toBe(false)

    mockedInvoke.mockResolvedValueOnce({ is_repo: true })
    await expect(isGitRepo("/repo")).resolves.toBe(true)
  })

  it("rejects a response outside the shared contract", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(isGitRepo("/repo")).rejects.toThrow(
      "Invalid backend response for POST /git/is-repo"
    )
  })

  it("normalizes git diff aliases for existing panels", async () => {
    mockedInvoke.mockResolvedValueOnce({
      diff: "diff --git a/a b/a",
      truncated: false,
      totalBytes: 18,
    })

    await expect(gitDiff("/repo")).resolves.toMatchObject({
      diff: "diff --git a/a b/a",
      diff_text: "diff --git a/a b/a",
      diffText: "diff --git a/a b/a",
      truncated: false,
      totalBytes: 18,
    })
  })

  it("normalizes staged git diff aliases too", async () => {
    mockedInvoke.mockResolvedValueOnce({
      diff: "staged diff",
      truncated: true,
      totalBytes: 4_000_000,
    })

    await expect(gitDiffStaged("/repo")).resolves.toMatchObject({
      diff: "staged diff",
      diff_text: "staged diff",
      diffText: "staged diff",
      truncated: true,
      totalBytes: 4_000_000,
    })
    expect(mockedInvoke).toHaveBeenCalledWith("/git/diff-staged", {
      method: "POST",
      body: { cwd: "/repo" },
    })
  })

  it("loads the effective Git profile for the active workspace", async () => {
    mockedInvoke.mockResolvedValueOnce({
      name: "Test User",
      email: "123+octocat@users.noreply.github.com",
      githubUser: "octocat",
    })

    await expect(gitUserProfile("/repo")).resolves.toEqual({
      name: "Test User",
      email: "123+octocat@users.noreply.github.com",
      githubUser: "octocat",
    })
    expect(mockedInvoke).toHaveBeenCalledWith("/git/profile", {
      method: "POST",
      body: { cwd: "/repo" },
    })
  })

  it("normalizes a blank cwd to null so no folder open falls back to global identity", async () => {
    mockedInvoke.mockResolvedValueOnce({
      name: null,
      email: null,
      githubUser: null,
    })

    // At startup with no project open the caller passes "" — `?? null` would
    // leave it as "" and the backend's non-blank gitPath rule would 400.
    await gitUserProfile("   ")

    expect(mockedInvoke).toHaveBeenCalledWith("/git/profile", {
      method: "POST",
      body: { cwd: null },
    })
  })

  it("checks a request against the contract before it is sent", async () => {
    await expect(gitStage("", ["a.txt"])).rejects.toThrow()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("reads a commit without a subject, author or date as empty text", async () => {
    mockedInvoke.mockResolvedValueOnce({ commits: [{ hash: "abc123" }] })

    await expect(gitLog("/repo", 5)).resolves.toEqual({
      commits: [{ hash: "abc123", message: "", author: "", date: "" }],
    })
    expect(mockedInvoke).toHaveBeenCalledWith("/git/log", {
      method: "POST",
      body: { cwd: "/repo", count: 5 },
    })
  })

  it("asks for fresh open targets only on refresh", async () => {
    const targets = [
      { id: "vscode", label: "VS Code", group: "editor", available: true },
    ]
    mockedInvoke.mockResolvedValue({ targets })

    await expect(getOpenTargets()).resolves.toEqual({ targets })
    await getOpenTargets({ refresh: true })

    expect(mockedInvoke.mock.calls.map(([path]) => path)).toEqual([
      "/git/open-targets",
      "/git/open-targets?refresh=true",
    ])
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({ method: "GET" })
  })

  it("sends an exact typed hunk action to the authoritative backend route", async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      action: "accept",
      patchId: "a".repeat(64),
      applied: true,
    })
    const input = {
      cwd: "/repo",
      path: "src/example.ts",
      source: "unstaged" as const,
      action: "accept" as const,
      patch:
        "diff --git a/src/example.ts b/src/example.ts\n" +
        "--- a/src/example.ts\n" +
        "+++ b/src/example.ts\n" +
        "@@ -1 +1 @@\n-old\n+new\n",
    }

    await expect(gitApplyHunk(input)).resolves.toMatchObject({
      ok: true,
      action: "accept",
    })
    expect(mockedInvoke).toHaveBeenCalledWith("/git/hunks/apply", {
      method: "POST",
      body: expect.objectContaining({
        ...input,
        operationId: expect.any(String),
      }),
    })
  })
})
