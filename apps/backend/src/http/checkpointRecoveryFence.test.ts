import type { AppState } from "../appState"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { WorkspaceRecoveryGate } from "../services/workspace-recovery-gate"
import {
  assertThreadRecoveryComplete,
  assertWorkspaceRecoveryComplete,
  withCheckpointRecoveryMutation,
} from "./checkpointRecoveryFence"

function stateWithStore(store: Record<string, unknown>): AppState {
  return {
    checkpointReverts: store,
    workspaceRecoveryGate: new WorkspaceRecoveryGate(),
  } as unknown as AppState
}

describe("checkpoint recovery mutation fences", () => {
  it("blocks thread and workspace mutations while recovery is pending", () => {
    const state = stateWithStore({
      hasBlockingRecovery: (threadId: string) => threadId === "thread-1",
      blockingThreadForCwd: (cwd: string) =>
        cwd === "/repo" ? "thread-1" : null,
    })

    expect(() => assertThreadRecoveryComplete(state, "thread-1")).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: "checkpoint_recovery_pending",
      })
    )
    expect(() => assertWorkspaceRecoveryComplete(state, "/repo")).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: "checkpoint_recovery_pending",
      })
    )
  })

  it("allows unrelated threads and workspaces", () => {
    const state = stateWithStore({
      hasBlockingRecovery: () => false,
      blockingThreadForCwd: () => null,
    })

    expect(() =>
      assertThreadRecoveryComplete(state, "thread-safe")
    ).not.toThrow()
    expect(() =>
      assertWorkspaceRecoveryComplete(state, "/repo-safe")
    ).not.toThrow()
  })

  it("fails closed when recovery state cannot be verified", () => {
    const unavailable = () => {
      throw new Error("database unavailable")
    }
    const state = stateWithStore({
      hasBlockingRecovery: unavailable,
      blockingThreadForCwd: unavailable,
    })

    expect(() => assertThreadRecoveryComplete(state, "thread-1")).toThrow(
      expect.objectContaining({
        statusCode: 503,
        code: "checkpoint_recovery_unavailable",
      })
    )
    expect(() => assertWorkspaceRecoveryComplete(state, "/repo")).toThrow(
      expect.objectContaining({
        statusCode: 503,
        code: "checkpoint_recovery_unavailable",
      })
    )
  })

  it("re-checks the durable fence after waiting for recovery ownership", async () => {
    const workspace = `/recovery-fence-${randomUUID()}`
    let recoveryPending = false
    let operationCalled = false
    const state = stateWithStore({
      hasBlockingRecovery: () => false,
      blockingThreadForCwd: () => (recoveryPending ? "thread-recovery" : null),
    })
    const recoveryLease =
      await state.workspaceRecoveryGate.acquireExclusive(workspace)
    const mutation = withCheckpointRecoveryMutation(
      state,
      { workspaces: [workspace] },
      () => {
        operationCalled = true
      }
    )

    await Promise.resolve()
    expect(operationCalled).toBe(false)
    recoveryPending = true
    recoveryLease.release()

    await expect(mutation).rejects.toMatchObject({
      statusCode: 409,
      code: "checkpoint_recovery_pending",
    })
    expect(operationCalled).toBe(false)
    expect(state.workspaceRecoveryGate.activeLeaseCount()).toBe(0)
  })
})
