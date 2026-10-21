import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkpointRefForThreadTurn } from "@betterc0de/schema/checkpointing"

const backend = vi.hoisted(() => ({
  gitCaptureCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
  gitDiffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
  gitStatus: vi.fn().mockResolvedValue({ branch: "main" }),
  isGitRepo: vi.fn().mockResolvedValue(true),
  readFile: vi.fn().mockResolvedValue({ content: "old", path: "file.ts" }),
  revertThreadCheckpoint: vi.fn().mockResolvedValue({
    reverted: true,
    rolledBackTurns: 1,
    deletedMessages: 2,
    boundaryMessageId: "assistant-1",
  }),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/services/backend", () => backend)

if (typeof globalThis.crypto === "undefined") {
  let counter = 0
  ;(globalThis as unknown as Record<string, unknown>).crypto = {
    randomUUID: () => `checkpoint-test-${++counter}`,
  }
}

import {
  autoCheckpointFromToolCalls,
  useCheckpointStore,
} from "@/lib/checkpoint-store"

function resetStore() {
  useCheckpointStore.setState({
    checkpoints: [],
    pendingTurnCheckpoints: {},
    activeCheckpointId: null,
    isRestoring: false,
  })
}

describe("checkpoint-store git turn checkpoints", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    backend.gitCaptureCheckpoint.mockResolvedValue({ ok: true })
    backend.gitDiffCheckpoints.mockResolvedValue({ diff: "" })
    backend.gitStatus.mockResolvedValue({ branch: "main" })
    backend.isGitRepo.mockResolvedValue(true)
    backend.revertThreadCheckpoint.mockResolvedValue({
      reverted: true,
      rolledBackTurns: 1,
      deletedMessages: 2,
      boundaryMessageId: "assistant-1",
    })
    backend.writeFile.mockResolvedValue(undefined)
  })

  it("captures baseline and completion as paired hidden git refs", async () => {
    backend.gitDiffCheckpoints.mockResolvedValue({
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+next",
      ].join("\n"),
    })

    const started = await useCheckpointStore
      .getState()
      .captureTurnCheckpointStart({
        threadId: "thread-1",
        turnId: "turn-1",
        projectPath: "/repo",
      })

    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const completeRef = checkpointRefForThreadTurn("thread-1", 1)
    expect(started).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      projectPath: "/repo",
      baseCheckpointRef: baseRef,
      checkpointRef: completeRef,
      turnNumber: 0,
    })
    expect(backend.gitCaptureCheckpoint).toHaveBeenCalledWith("/repo", baseRef)

    const checkpointId = await useCheckpointStore
      .getState()
      .captureTurnCheckpointComplete({
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        projectPath: "/repo",
      })

    expect(checkpointId).toBeTruthy()
    expect(backend.gitCaptureCheckpoint).toHaveBeenLastCalledWith(
      "/repo",
      completeRef
    )
    expect(backend.gitDiffCheckpoints).toHaveBeenCalledWith(
      "/repo",
      baseRef,
      completeRef
    )
    expect(useCheckpointStore.getState().checkpoints[0]).toMatchObject({
      threadId: "thread-1",
      messageId: "assistant-1",
      projectPath: "/repo",
      checkpointRef: completeRef,
      baseCheckpointRef: baseRef,
      gitBranch: "main",
      diffFiles: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    })
    expect(useCheckpointStore.getState().pendingTurnCheckpoints).toEqual({})
  })

  it("uses the captured chat workspace for automatic file checkpoint branch reads", async () => {
    const cwd = "C:\\Users\\MaxiN\\Documents\\GitHub\\kittycord"
    const id = await autoCheckpointFromToolCalls(
      "thread-1",
      "message-1",
      [
        {
          id: "edit-1",
          name: "Edit",
          state: "output-available",
          input: { file_path: `${cwd}\\src\\app.ts` },
        },
      ],
      cwd
    )
    expect(id).toBeTruthy()
    await vi.waitFor(() =>
      expect(useCheckpointStore.getState().checkpoints[0].gitBranch).toBe(
        "main"
      )
    )
    expect(backend.gitStatus).toHaveBeenCalledExactlyOnceWith(cwd)
    expect(useCheckpointStore.getState().checkpoints[0].projectPath).toBe(cwd)
  })

  it.each([undefined, null, "", "   ", "."])(
    "never probes the IDE directory when the checkpoint workspace is %j",
    async (cwd) => {
      useCheckpointStore
        .getState()
        .createCheckpoint(
          "thread-1",
          "message-1",
          "Files",
          { "app.ts": "old" },
          cwd
        )
      await Promise.resolve()
      expect(backend.gitStatus).not.toHaveBeenCalled()
      expect(useCheckpointStore.getState().checkpoints[0].gitBranch).toBe(
        "unknown"
      )
    }
  )

  it("skips git checkpoints when the project is not a git repo", async () => {
    backend.isGitRepo.mockResolvedValue(false)

    const result = await useCheckpointStore
      .getState()
      .captureTurnCheckpointStart({
        threadId: "thread-1",
        turnId: "turn-1",
        projectPath: "/repo",
      })

    expect(result).toBeNull()
    expect(backend.gitCaptureCheckpoint).not.toHaveBeenCalled()
  })

  it("restores git-backed checkpoints through the backend snapshot", async () => {
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    useCheckpointStore.setState({
      checkpoints: [
        {
          id: "cp-1",
          threadId: "thread-1",
          messageId: "assistant-1",
          label: "After turn",
          timestamp: "2026-05-12T00:00:00.000Z",
          files: { "src/app.ts": "fallback" },
          gitBranch: "main",
          projectPath: "/repo",
          checkpointRef,
          turnNumber: 1,
        },
      ],
    })

    await useCheckpointStore.getState().restoreCheckpoint("cp-1")

    expect(backend.revertThreadCheckpoint).toHaveBeenCalledWith("thread-1", 1)
    expect(backend.writeFile).not.toHaveBeenCalled()
    expect(useCheckpointStore.getState().activeCheckpointId).toBe("cp-1")
  })

  it("records backend-captured git checkpoints for restore", () => {
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 0)

    const id = useCheckpointStore.getState().recordGitCheckpoint({
      threadId: "thread-1",
      messageId: "assistant-1",
      projectPath: "/repo",
      checkpointRef,
      baseCheckpointRef,
      turnId: "turn-1",
      turnNumber: 1,
      diffFiles: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    })

    expect(id).toBeTruthy()
    expect(useCheckpointStore.getState().checkpoints[0]).toMatchObject({
      id,
      threadId: "thread-1",
      messageId: "assistant-1",
      projectPath: "/repo",
      checkpointRef,
      baseCheckpointRef,
      turnId: "turn-1",
      turnNumber: 1,
      diffFiles: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    })
  })

  it("merges backend-captured checkpoints with matching local refs", () => {
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    useCheckpointStore.setState({
      checkpoints: [
        {
          id: "local-cp",
          threadId: "thread-1",
          messageId: "assistant-1",
          label: "Local",
          timestamp: "2026-05-12T00:00:00.000Z",
          files: {},
          gitBranch: "main",
          projectPath: "/repo",
          checkpointRef,
        },
      ],
    })

    const id = useCheckpointStore.getState().recordGitCheckpoint({
      threadId: "thread-1",
      messageId: "assistant-1",
      projectPath: "/repo",
      checkpointRef,
      diffFiles: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
    })

    expect(id).toBe("local-cp")
    expect(useCheckpointStore.getState().checkpoints).toHaveLength(1)
    expect(useCheckpointStore.getState().checkpoints[0].diffFiles).toEqual([
      { path: "src/app.ts", additions: 2, deletions: 1 },
    ])
  })

  it("falls back to file snapshots for legacy checkpoints", async () => {
    useCheckpointStore.setState({
      checkpoints: [
        {
          id: "cp-legacy",
          threadId: "thread-1",
          messageId: "assistant-1",
          label: "Legacy",
          timestamp: "2026-05-12T00:00:00.000Z",
          files: { "/repo/src/app.ts": "old source" },
          gitBranch: "unknown",
        },
      ],
    })

    await useCheckpointStore.getState().restoreCheckpoint("cp-legacy")

    expect(backend.revertThreadCheckpoint).not.toHaveBeenCalled()
    expect(backend.writeFile).toHaveBeenCalledWith(
      "/repo/src",
      "app.ts",
      "old source"
    )
  })

  it("removes only the renderer projection for a git-backed checkpoint", () => {
    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    useCheckpointStore.setState({
      checkpoints: [
        {
          id: "cp-1",
          threadId: "thread-1",
          messageId: "assistant-1",
          label: "After turn",
          timestamp: "2026-05-12T00:00:00.000Z",
          files: {},
          gitBranch: "main",
          projectPath: "/repo",
          baseCheckpointRef: baseRef,
          checkpointRef,
        },
      ],
    })

    useCheckpointStore.getState().deleteCheckpoint("cp-1")

    expect(useCheckpointStore.getState().checkpoints).toEqual([])
  })

  it("prunes checkpoints after a restored message and deletes their hidden refs", () => {
    const turn1Base = checkpointRefForThreadTurn("thread-1", 0)
    const turn1Ref = checkpointRefForThreadTurn("thread-1", 1)
    const turn2Base = checkpointRefForThreadTurn("thread-1", 2)
    const turn2Ref = checkpointRefForThreadTurn("thread-1", 3)
    useCheckpointStore.setState({
      activeCheckpointId: "cp-2",
      checkpoints: [
        {
          id: "cp-1",
          threadId: "thread-1",
          messageId: "assistant-1",
          label: "Turn 1",
          timestamp: "2026-05-12T00:00:00.000Z",
          files: {},
          gitBranch: "main",
          projectPath: "/repo",
          baseCheckpointRef: turn1Base,
          checkpointRef: turn1Ref,
          turnNumber: 1,
        },
        {
          id: "cp-2",
          threadId: "thread-1",
          messageId: "assistant-2",
          label: "Turn 2",
          timestamp: "2026-05-12T00:00:01.000Z",
          files: {},
          gitBranch: "main",
          projectPath: "/repo",
          baseCheckpointRef: turn2Base,
          checkpointRef: turn2Ref,
          turnNumber: 2,
        },
        {
          id: "cp-other",
          threadId: "thread-other",
          messageId: "assistant-other",
          label: "Other",
          timestamp: "2026-05-12T00:00:02.000Z",
          files: {},
          gitBranch: "main",
          projectPath: "/repo",
          turnNumber: 2,
        },
      ],
    })

    useCheckpointStore.getState().deleteCheckpointsAfter("thread-1", {
      messageIds: ["assistant-2"],
      turnNumber: 1,
    })

    expect(
      useCheckpointStore.getState().checkpoints.map((cp) => cp.id)
    ).toEqual(["cp-1", "cp-other"])
    expect(useCheckpointStore.getState().activeCheckpointId).toBeNull()
  })
})
