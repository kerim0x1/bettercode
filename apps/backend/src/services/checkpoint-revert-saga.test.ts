import { beforeEach, describe, expect, it, vi } from "vitest"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import type { AppState } from "../appState"
import { revertThreadCheckpoint } from "./checkpoint-revert-saga"
import { MAX_CHECKPOINT_REVERT_TURN_RANGE } from "./checkpoint-revert-operations"
import { workspaceRecoveryGate } from "./workspace-recovery-gate"
import { closeShellSessionsForWorkspace } from "./shell"

vi.mock("./git", () => ({ isRepo: vi.fn(async () => ({ is_repo: false })) }))
vi.mock("./shell", () => ({
  closeShellSessionsForWorkspace: vi.fn(async () => {}),
}))
vi.mock("./terminalPty", () => ({
  shutdownTerminalPtySessionsForWorkspace: vi.fn(async () => {}),
}))
vi.mock("./checkpoint-recovery-fence", () => ({
  recoveryWorkspacesForThread: () => [],
}))
vi.mock("./workspace-recovery-gate", () => ({
  workspaceRecoveryGate: {
    acquireExclusiveAfterQuiesce: vi.fn(async () => ({ release: vi.fn() })),
  },
}))

describe("checkpoint revert counter validation", () => {
  beforeEach(() => vi.clearAllMocks())

  const run = (latestTurn: number, refs: string[] = []) =>
    revertThreadCheckpoint({
      state: {
        providerSessionBindings: {
          getLatestForThread: () => ({
            cwd: "/repo",
            providerKind: "codex",
            providerInstanceId: "codex",
          }),
        },
        checkpointDiffs: {
          listCheckpointRefsByThread: () => refs,
          latestTurnIndex: () => latestTurn,
        },
      } as unknown as AppState,
      threadId: "thread-1",
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })

  it.each([MAX_CHECKPOINT_REVERT_TURN_RANGE + 1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects counter %s before workspace quiescence or restore",
    async (count) => {
      await expect(run(count)).rejects.toMatchObject({
        code: "checkpoint_turn_range_invalid",
      })
      expect(
        workspaceRecoveryGate.acquireExclusiveAfterQuiesce
      ).not.toHaveBeenCalled()
      expect(closeShellSessionsForWorkspace).not.toHaveBeenCalled()
    }
  )

  it.each(["9007199254740992", "1e9", "0x100000", "0001000000"])(
    "ignores noncanonical or unsafe checkpoint slot %s",
    async (suffix) => {
      const prefix = checkpointRefForThreadTurn("thread-1", 0).slice(0, -1)
      await expect(run(1, [`${prefix}${suffix}`])).resolves.toMatchObject({
        reverted: false,
      })
      expect(
        workspaceRecoveryGate.acquireExclusiveAfterQuiesce
      ).toHaveBeenCalledOnce()
    }
  )
})
