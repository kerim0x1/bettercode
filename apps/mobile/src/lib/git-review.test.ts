import { afterEach, describe, expect, it } from "vitest"
import { createDemoTransport } from "@/transport/demo"
import type { GitStatusResult, RemoteTransport } from "@/transport/types"
import {
  changeCount,
  checkoutConfirmation,
  commitChanges,
  discardConfirmation,
  generateCommitMessage,
  gitLogDate,
  gitSections,
  lineCounts,
  pullConfirmation,
  pushConfirmation,
} from "./git-review"

const ROOT = "/Users/demo/code/weather-app"
const transports: RemoteTransport[] = []

function demoApi() {
  const transport = createDemoTransport({ chunkDelayMs: 0 })
  transports.push(transport)
  return transport.api
}

afterEach(() => {
  for (const transport of transports.splice(0)) {
    ;(transport as { dispose?: () => void }).dispose?.()
  }
})

const status = (overrides: Partial<GitStatusResult> = {}): GitStatusResult => ({
  branch: "main",
  is_clean: false,
  staged: [],
  modified: [],
  untracked: [],
  ahead: 0,
  behind: 0,
  upstream: "origin/main",
  ...overrides,
})

describe("the git review's lists", () => {
  it("are the desktop's three, in its order, without empty ones", async () => {
    const api = demoApi()
    const current = await api.gitStatus(ROOT)
    expect(gitSections(current)).toEqual([
      { key: "staged", title: "Staged Changes", files: ["package.json"] },
      {
        key: "changes",
        title: "Changes",
        files: ["README.md", "src/theme.ts"],
      },
      {
        key: "untracked",
        title: "Untracked",
        files: ["src/screens/Radar.tsx"],
      },
    ])
    expect(changeCount(current)).toBe(4)
    expect(gitSections(status())).toEqual([])
  })

  it("count added and removed lines per file", async () => {
    const api = demoApi()
    const { diff } = await api.gitDiff(ROOT)
    expect(lineCounts(diff)).toEqual({
      "README.md": { additions: 2, deletions: 2 },
      "src/theme.ts": { additions: 1, deletions: 1 },
    })
  })
})

describe("the desktop's confirmations", () => {
  it("publish a branch without upstream and push one with", () => {
    expect(
      pushConfirmation(status({ upstream: null, branch: "radar" }))
    ).toEqual({
      title: "Publish branch?",
      message:
        'Branch "radar" has no upstream — publish to origin/radar now? Future pushes will go there automatically.',
      action: "Publish",
    })
    expect(pushConfirmation(status({ ahead: 1 })).message).toBe(
      'Push 1 commit on "main" to origin/main.'
    )
    expect(pushConfirmation(status({ ahead: 3 })).message).toBe(
      'Push 3 commits on "main" to origin/main.'
    )
  })

  it("pull, discard and switch branch", () => {
    expect(pullConfirmation(status()).message).toBe(
      'Pull latest changes from the remote into "main".'
    )
    expect(discardConfirmation("src/theme.ts").message).toBe(
      'All changes to "src/theme.ts" will be permanently lost. This cannot be undone.'
    )
    expect(checkoutConfirmation("release/1.4").message).toBe(
      'Switch the workspace to "release/1.4"? Git will stop if local changes cannot be carried safely.'
    )
  })
})

describe("committing", () => {
  it("takes only what is staged when something is", async () => {
    const api = demoApi()
    await commitChanges(api, ROOT, await api.gitStatus(ROOT), " Release 1.3.0 ")
    const after = await api.gitStatus(ROOT)
    expect(after.staged).toEqual([])
    expect(after.modified).toEqual(["README.md", "src/theme.ts"])
    expect((await api.gitLog(ROOT, 1))[0]?.message).toBe("Release 1.3.0")
  })

  it("stages everything first when nothing is staged, as the desktop's smart commit", async () => {
    const api = demoApi()
    await api.gitUnstageAll(ROOT)
    await commitChanges(api, ROOT, await api.gitStatus(ROOT), "Everything")
    expect(await api.gitStatus(ROOT)).toMatchObject({
      is_clean: true,
      ahead: 2,
    })
  })
})

describe("a generated commit message", () => {
  it("covers the staged changes when there are any", async () => {
    const api = demoApi()
    await expect(generateCommitMessage(api, ROOT)).resolves.toBe(
      "Update package.json\n\n- package.json"
    )
  })

  it("covers every change and new file when nothing is staged", async () => {
    const api = demoApi()
    await api.gitUnstageAll(ROOT)
    await expect(generateCommitMessage(api, ROOT)).resolves.toBe(
      "Update 4 files\n\n- README.md\n- package.json\n- src/theme.ts\n- src/screens/Radar.tsx"
    )
  })

  it("says so when there is nothing to describe", async () => {
    const api = demoApi()
    await expect(
      generateCommitMessage(api, "/Users/demo/code/api-server")
    ).rejects.toThrow("There are no changes to summarize.")
  })
})

describe("git log dates", () => {
  it("reads git's ISO format with its offset", () => {
    expect(gitLogDate("2026-09-24 09:12:44 +0200")?.toISOString()).toBe(
      "2026-09-24T07:12:44.000Z"
    )
    expect(gitLogDate("2026-09-24 09:12:44 -0130")?.toISOString()).toBe(
      "2026-09-24T10:42:44.000Z"
    )
    expect(gitLogDate("yesterday")).toBeNull()
    expect(gitLogDate(undefined)).toBeNull()
  })
})
