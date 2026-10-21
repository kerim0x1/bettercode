import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  generateCommitMessage,
  gitDiff,
  gitDiffStaged,
  gitStatus,
  readFile,
} from "@/services/backend"
import { generateWorkspaceCommitMessage } from "./git-commit-message"

vi.mock("@/services/backend", () => ({
  generateCommitMessage: vi.fn(),
  gitDiff: vi.fn(),
  gitDiffStaged: vi.fn(),
  gitStatus: vi.fn(),
  readFile: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(gitStatus).mockResolvedValue({
    branch: "main",
    is_clean: false,
    staged: [],
    modified: ["src/app.ts"],
    untracked: ["src/new.ts"],
    ahead: 0,
    behind: 0,
    upstream: null,
  })
  const diff = {
    diff: "",
    diffText: "",
    diff_text: "diff --git a/src/app.ts b/src/app.ts\n+fixSelection()",
    truncated: false,
    totalBytes: 60,
  }
  vi.mocked(gitDiff).mockResolvedValue(diff)
  vi.mocked(gitDiffStaged).mockResolvedValue(diff)
  vi.mocked(readFile).mockResolvedValue({
    content: "export const newFeature = true",
    path: "/repo/src/new.ts",
  })
  vi.mocked(generateCommitMessage).mockResolvedValue({
    subject: "Improve browser selection",
    body: "- Fix selection alignment\n- Add element details",
  })
})

describe("shared Git commit generation for Agent, Editor and Canvas", () => {
  it("uses a fresh status and includes new file contents without staging", async () => {
    expect(await generateWorkspaceCommitMessage("/repo")).toBe(
      "Improve browser selection\n\n- Fix selection alignment\n- Add element details"
    )
    expect(readFile).toHaveBeenCalledWith("/repo/src/new.ts")
    expect(generateCommitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        stagedSummary: expect.stringContaining("New: src/new.ts"),
        stagedPatch: expect.stringContaining("export const newFeature = true"),
      })
    )
    expect(gitDiffStaged).not.toHaveBeenCalled()
  })

  it("summarizes only the index when staged changes exist", async () => {
    vi.mocked(gitStatus).mockResolvedValueOnce({
      branch: "main",
      is_clean: false,
      staged: ["src/app.ts"],
      modified: ["unrelated.ts"],
      untracked: ["new.ts"],
      ahead: 0,
      behind: 0,
      upstream: null,
    })
    await generateWorkspaceCommitMessage("/repo")
    expect(gitDiffStaged).toHaveBeenCalledWith("/repo")
    expect(gitDiff).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(
      vi.mocked(generateCommitMessage).mock.calls[0][0].stagedSummary
    ).not.toContain("unrelated")
  })

  it("rejects filename-only responses from an older backend", async () => {
    vi.mocked(generateCommitMessage).mockResolvedValueOnce({
      subject: "- src/app.ts",
      body: "",
    })
    await expect(generateWorkspaceCommitMessage("/repo")).rejects.toThrow(
      "existing message has been kept"
    )
  })

  it("marks unreadable new files instead of inventing their contents", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("Binary file"))
    await generateWorkspaceCommitMessage("/repo")
    expect(
      vi.mocked(generateCommitMessage).mock.calls[0][0].stagedPatch
    ).toContain("contents unavailable")
  })

  it("keeps large diffs below the API limit while preserving later files", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce({
      diff: "",
      diffText: "",
      diff_text:
        "diff --git a/big b/big\n" +
        "+entry\n".repeat(200_000) +
        "diff --git a/last b/last\n+lastChange()",
      truncated: true,
      totalBytes: 2_000_000,
    })
    await generateWorkspaceCommitMessage("/repo")
    const patch = vi.mocked(generateCommitMessage).mock.calls[0][0].stagedPatch
    expect(patch.length).toBeLessThan(1024 * 1024)
    expect(patch).toContain("lastChange()")
    expect(patch).toContain("Git diff was truncated")
  })
})
