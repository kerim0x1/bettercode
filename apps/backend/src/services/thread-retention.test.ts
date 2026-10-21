import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadRetentionScheduler } from "./thread-retention"
import { WorkspaceRecoveryGate } from "./workspace-recovery-gate"

/** The scheduler's shell commands: only their workspace shutdown matters here. */
const closeShellSessionsForWorkspaceMock =
  vi.fn<(workspace: string) => Promise<number>>()
/** The scheduler's terminals: only their workspace shutdown matters here. */
const shutdownTerminalPtySessionsForWorkspaceMock =
  vi.fn<(workspace: string) => Promise<number>>()

function makeDependencies(options: { worktreeFailure?: Error } = {}) {
  const calls: string[] = []
  const gate =
    (name: string) =>
    async <T>(_threadId: string, operation: () => Promise<T> | T) => {
      calls.push(`${name}:enter`)
      try {
        return await operation()
      } finally {
        calls.push(`${name}:exit`)
      }
    }
  const dependencies = {
    shellSessions: {
      closeSessionsForWorkspace: closeShellSessionsForWorkspaceMock,
    },
    terminalPtys: {
      shutdownForWorkspace: shutdownTerminalPtySessionsForWorkspaceMock,
    },
    workspaceRecoveryGate: new WorkspaceRecoveryGate(),
    forgetThreadGoal: vi.fn(() => calls.push("goal:forget")),
    threads: {
      archiveOldThreads: vi.fn(() => 2),
      purgeArchivedOlderThan: vi.fn(() => ["thread-1"]),
      getThreadProjectPath: vi.fn(() => "/repo"),
      delete: vi.fn(() => calls.push("thread:delete")),
    },
    worktrees: {
      findForThread: vi.fn(() => null),
      removeForThread: vi.fn(async () => {
        calls.push("worktree:remove")
        if (options.worktreeFailure) throw options.worktreeFailure
      }),
    },
    threadTurnCoordinator: { withTeardown: vi.fn(gate("coordinator")) },
    providerHub: { withThreadTeardown: vi.fn(gate("hub")) },
    providers: {
      withThreadTeardown: vi.fn(gate("legacy")),
      forgetThread: vi.fn(() => calls.push("provider:forget")),
    },
    providerEventLoggers: [
      {
        removeThread: vi.fn(async () => {
          calls.push("log:remove")
        }),
      },
    ],
    transcriptRecoveryStore: {
      removeThread: vi.fn(() => {
        calls.push("transcript:remove")
        return 1
      }),
    },
    checkpointReactor: {
      forgetThread: vi.fn(() => calls.push("checkpoint:forget")),
    },
    checkpointReverts: {
      hasBlockingRecovery: vi.fn(() => false),
      blockingThreadForCwd: vi.fn((): string | null => null),
    },
    deleteThreadCheckpointRefs: vi.fn(async () => {
      calls.push("checkpoint-refs:delete")
      return 2
    }),
  }
  return { dependencies, calls }
}

describe("ThreadRetentionScheduler", () => {
  beforeEach(() => {
    closeShellSessionsForWorkspaceMock.mockReset()
    closeShellSessionsForWorkspaceMock.mockResolvedValue(0)
    shutdownTerminalPtySessionsForWorkspaceMock.mockReset()
    shutdownTerminalPtySessionsForWorkspaceMock.mockResolvedValue(0)
  })

  it("keeps a monthly configured interval within the Node timer range", async () => {
    vi.useFakeTimers()
    const interval = vi.spyOn(globalThis, "setInterval")
    const { dependencies } = makeDependencies()
    const scheduler = new ThreadRetentionScheduler(dependencies as never, {
      intervalMs: 30 * 24 * 60 * 60 * 1_000,
    })
    try {
      scheduler.start()
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 2 ** 31 - 1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dependencies.threads.archiveOldThreads).not.toHaveBeenCalled()
    } finally {
      await scheduler.stop()
      interval.mockRestore()
      vi.useRealTimers()
    }
  })

  it("tears down external resources before deleting the durable thread", async () => {
    const { dependencies, calls } = makeDependencies()
    const scheduler = new ThreadRetentionScheduler(dependencies as never)

    await expect(scheduler.runNow()).resolves.toEqual({
      archived: 2,
      purged: 1,
      failed: 0,
    })
    expect(dependencies.threads.purgeArchivedOlderThan).toHaveBeenCalledWith(
      30,
      50
    )
    expect(calls).toEqual([
      "coordinator:enter",
      "hub:enter",
      "legacy:enter",
      "checkpoint:forget",
      "checkpoint-refs:delete",
      "worktree:remove",
      "log:remove",
      "transcript:remove",
      "provider:forget",
      "goal:forget",
      "thread:delete",
      "legacy:exit",
      "hub:exit",
      "coordinator:exit",
    ])
  })

  it("retains the archived row when external teardown fails", async () => {
    const { dependencies } = makeDependencies({
      worktreeFailure: new Error("still mounted"),
    })
    const scheduler = new ThreadRetentionScheduler(dependencies as never)

    await expect(scheduler.runNow()).resolves.toEqual({
      archived: 2,
      purged: 0,
      failed: 1,
    })
    expect(dependencies.threads.delete).not.toHaveBeenCalled()
    expect(dependencies.providers.forgetThread).not.toHaveBeenCalled()
  })

  it("does not purge a thread with unfinished checkpoint recovery", async () => {
    const { dependencies, calls } = makeDependencies()
    dependencies.checkpointReverts.hasBlockingRecovery.mockReturnValue(true)
    const scheduler = new ThreadRetentionScheduler(dependencies as never)

    await expect(scheduler.runNow()).resolves.toEqual({
      archived: 2,
      purged: 0,
      failed: 0,
    })
    expect(calls).toEqual([
      "coordinator:enter",
      "hub:enter",
      "legacy:enter",
      "legacy:exit",
      "hub:exit",
      "coordinator:exit",
    ])
    expect(dependencies.threads.delete).not.toHaveBeenCalled()
    expect(dependencies.checkpointReactor.forgetThread).not.toHaveBeenCalled()
  })

  it("does not purge through a workspace fenced by another recovery", async () => {
    const { dependencies } = makeDependencies()
    dependencies.checkpointReverts.blockingThreadForCwd.mockReturnValue(
      "thread-recovery"
    )
    const scheduler = new ThreadRetentionScheduler(dependencies as never)

    await expect(scheduler.runNow()).resolves.toEqual({
      archived: 2,
      purged: 0,
      failed: 0,
    })
    expect(dependencies.checkpointReactor.forgetThread).not.toHaveBeenCalled()
    expect(dependencies.threads.delete).not.toHaveBeenCalled()
  })

  it("queues exclusive maintenance, drains workspace processes, and holds the barrier through purge", async () => {
    const { dependencies } = makeDependencies()
    const { workspaceRecoveryGate } = dependencies
    dependencies.worktrees.removeForThread.mockImplementation(async () => {
      expect(workspaceRecoveryGate.tryAcquireExclusive("/repo")).toBeNull()
    })
    const scheduler = new ThreadRetentionScheduler(dependencies as never)
    const overlappingMutation =
      await workspaceRecoveryGate.acquireShared("/repo")

    try {
      const run = scheduler.runNow()

      await vi.waitFor(() => {
        expect(closeShellSessionsForWorkspaceMock).toHaveBeenCalledWith(
          path.resolve("/repo")
        )
        expect(
          shutdownTerminalPtySessionsForWorkspaceMock
        ).toHaveBeenCalledWith(path.resolve("/repo"))
      })
      expect(workspaceRecoveryGate.waitingLeaseCount()).toBeGreaterThan(0)
      expect(dependencies.worktrees.removeForThread).not.toHaveBeenCalled()

      overlappingMutation.release()
      await expect(run).resolves.toEqual({
        archived: 2,
        purged: 1,
        failed: 0,
      })
    } finally {
      overlappingMutation.release()
    }

    const exclusive = workspaceRecoveryGate.tryAcquireExclusive("/repo")
    expect(exclusive).not.toBeNull()
    exclusive?.release()
  })
})
