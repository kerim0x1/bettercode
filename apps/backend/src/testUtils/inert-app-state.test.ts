import { describe, expect, it, vi } from "vitest"
import { withInertAppState, withInertStateArgument } from "./inert-app-state"

class CompleteThreads {
  getThreadProjectPath(): string {
    return "/repo"
  }
}

describe("withInertAppState", () => {
  it("fills missing members and missing methods in place, keeping what the test supplied", () => {
    const persistUserMessageForTurn = vi.fn()
    const threads = { persistUserMessageForTurn }
    const state = { threads } as Record<string, unknown>

    expect(withInertAppState(state)).toBe(state)
    expect(state.threads).toBe(threads)
    expect(
      (state.threads as Record<string, unknown>).persistUserMessageForTurn
    ).toBe(persistUserMessageForTurn)
    const filled = state.threads as {
      getThreadProjectPath(threadId: string): string | null
      listMessages(): unknown[]
    }
    expect(filled.getThreadProjectPath("thread-1")).toBeNull()
    expect(filled.listMessages()).toEqual([])
    const reverts = state.checkpointReverts as {
      hasBlockingRecovery(threadId: string): boolean
      blockingThreadForCwd(cwd: string): string | null
    }
    expect(reverts.hasBlockingRecovery("thread-1")).toBe(false)
    expect(reverts.blockingThreadForCwd("/repo")).toBeNull()
  })

  it("never overrides a supplied method", () => {
    const getThreadProjectPath = vi.fn(() => "/supplied")
    const state = { threads: { getThreadProjectPath } }

    withInertAppState(state)

    expect(state.threads.getThreadProjectPath).toBe(getThreadProjectPath)
  })

  it("takes a class instance as complete", () => {
    const threads = new CompleteThreads()
    const state = { threads } as Record<string, unknown>

    withInertAppState(state)

    expect(state.threads).toBe(threads)
    expect("listMessages" in threads).toBe(false)
  })

  it("runs maintenance and an unjournaled revert like the old guards did", async () => {
    const state = {} as Record<string, unknown>
    withInertAppState(state)
    const hub = state.providerHub as {
      withThreadMaintenance<T>(threadId: string, run: () => T): T
    }
    const reverts = state.checkpointReverts as {
      begin(input: { threadId: string }): { threadId: string; phase: string }
      setPhase(
        operation: { threadId: string; phase: string },
        phase: string
      ): { threadId: string; phase: string }
    }

    expect(hub.withThreadMaintenance("thread-1", () => 42)).toBe(42)
    const operation = reverts.begin({ threadId: "thread-1" })
    expect(operation).toEqual({ threadId: "thread-1", phase: "prepared" })
    expect(reverts.setPhase(operation, "database_truncated")).toEqual({
      threadId: "thread-1",
      phase: "database_truncated",
    })
  })
})

describe("withInertStateArgument", () => {
  it("fills the state argument before calling through", () => {
    const register = vi.fn(
      (_app: unknown, state: Record<string, unknown>) => state.taintBackend
    )
    const wrapped = withInertStateArgument(register, 1)
    const state: Record<string, unknown> = {}

    const taint = wrapped("app", state)

    expect(register).toHaveBeenCalledWith("app", state)
    expect(typeof taint).toBe("function")
  })
})
