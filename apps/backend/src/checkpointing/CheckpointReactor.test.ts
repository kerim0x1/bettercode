import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import type { LegacyProviderEvent } from "../provider/types"
import { CheckpointReactor } from "./CheckpointReactor"

function logger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function turnEvent(
  event_type: string,
  payload: Record<string, unknown> = {}
): LegacyProviderEvent {
  return {
    event_type,
    thread_id: "thread-1",
    payload,
  }
}

describe("CheckpointReactor", () => {
  it("keeps delimiter-containing thread and turn identities separate", async () => {
    const emitted: LegacyProviderEvent[] = []
    const captureCheckpoint = vi.fn(async () => undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: (threadId) => `/repo/${threadId}` },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: async () => ({ diff: "" }),
      isSnapshotEnabled: async () => true,
      isGitRepo: async () => true,
      emitEvent: (event) => {
        emitted.push(event)
      },
    })
    const first = { thread_id: "a", payload: { dispatchTurnId: "b::turn:c" } }
    const second = { thread_id: "a::turn:b", payload: { dispatchTurnId: "c" } }
    await reactor.prepareTurn({ ...first, event_type: "turn_started" })
    await reactor.prepareTurn({ ...second, event_type: "turn_started" })
    await reactor.finalizeTurn({ ...second, event_type: "turn_completed" })
    await reactor.finalizeTurn({ ...first, event_type: "turn_completed" })
    expect(captureCheckpoint).toHaveBeenCalledTimes(4)
    expect(
      emitted
        .filter((event) => event.event_type === "checkpoint.captured")
        .map((event) => event.thread_id)
    ).toEqual([second.thread_id, first.thread_id])
    await reactor.stop()
  })

  it("retains another thread's terminal failure when forgetting a prefix ID", async () => {
    const failure = new Error("checkpoint diff failed")
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: async () => undefined,
      diffCheckpoints: async () => {
        throw failure
      },
      isSnapshotEnabled: async () => true,
      isGitRepo: async () => true,
    })
    const identity = {
      thread_id: "a::sibling",
      payload: { dispatchTurnId: "turn" },
    }
    await reactor.prepareTurn({ ...identity, event_type: "turn_started" })
    await expect(
      reactor.finalizeTurn({ ...identity, event_type: "turn_completed" })
    ).rejects.toBe(failure)
    await reactor.forgetThread("a")
    await expect(
      reactor.finalizeTurn({ ...identity, event_type: "turn_completed" })
    ).rejects.toBe(failure)
    await reactor.stop()
  })

  it("captures hidden git refs around a provider turn and emits a diff update", async () => {
    const emitted: LegacyProviderEvent[] = []
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const diffCheckpoints = vi.fn().mockResolvedValue({
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
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints,
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
    })

    await reactor.ingest(
      turnEvent("turn_started", {
        turn_index: 1,
        providerKind: "openai",
      })
    )
    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    expect(reactor.isCheckpointRefActive(baseRef)).toBe(true)
    expect(reactor.isCheckpointRefActive(checkpointRef)).toBe(true)
    await reactor.ingest(
      turnEvent("turn_completed", {
        turn_index: 1,
        providerKind: "openai",
      })
    )

    expect(reactor.isCheckpointRefActive(baseRef)).toBe(false)
    expect(reactor.isCheckpointRefActive(checkpointRef)).toBe(false)
    expect(captureCheckpoint).toHaveBeenNthCalledWith(1, {
      cwd: "/repo",
      checkpointRef: baseRef,
    })
    expect(captureCheckpoint).toHaveBeenNthCalledWith(2, {
      cwd: "/repo",
      checkpointRef,
    })
    expect(diffCheckpoints).toHaveBeenCalledWith({
      cwd: "/repo",
      fromCheckpointRef: baseRef,
      toCheckpointRef: checkpointRef,
      fallbackFromToHead: false,
      ignoreWhitespace: false,
    })
    expect(emitted).toEqual([
      {
        event_type: "turn.diff.updated",
        thread_id: "thread-1",
        payload: expect.objectContaining({
          source: "checkpoint_reactor",
          providerKind: "openai",
          checkpointRef,
          baseCheckpointRef: baseRef,
          turn_index: 1,
          files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
        }),
      },
      {
        event_type: "checkpoint.captured",
        thread_id: "thread-1",
        payload: expect.objectContaining({
          source: "checkpoint_reactor",
          status: "ready",
          checkpointRef,
          baseCheckpointRef: baseRef,
          turn_index: 1,
        }),
      },
    ])
  })

  it("uses provider turn ids when native runtimes provide them", async () => {
    const emitted: LegacyProviderEvent[] = []
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
    })

    await reactor.ingest(turnEvent("turn_started", { turn_id: "turn-native" }))
    await reactor.ingest(
      turnEvent("turn_completed", { turn_id: "turn-native" })
    )

    expect(emitted[0]?.payload).toMatchObject({
      turn_id: "turn-native",
      checkpointRef: checkpointRefForThreadTurn("thread-1", 1),
      turn_index: 1,
      checkpointTurnCount: 1,
    })
  })

  it("captures partial workspace changes when a provider session exits", async () => {
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const diffCheckpoints = vi.fn().mockResolvedValue({ diff: "" })
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const emitEvent = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints,
      deleteCheckpointRefs,
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent,
    })

    await reactor.ingest(
      turnEvent("turn_started", { dispatchTurnId: "dispatch-exited" })
    )
    await reactor.ingest(
      turnEvent("session.exited", { dispatchTurnId: "dispatch-exited" })
    )
    await reactor.ingest(
      turnEvent("turn_completed", { dispatchTurnId: "dispatch-exited" })
    )

    expect(captureCheckpoint).toHaveBeenCalledTimes(2)
    expect(diffCheckpoints).toHaveBeenCalledOnce()
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "checkpoint.captured",
        payload: expect.objectContaining({ status: "error" }),
      })
    )
    expect(deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: [checkpointRefForThreadTurn("thread-1", 0)],
    })
  })

  it("captures failed turn checkpoints as error after the final failed completion", async () => {
    const emitted: LegacyProviderEvent[] = []
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const diffCheckpoints = vi.fn().mockResolvedValue({
      diff: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-v1",
        "+broken",
      ].join("\n"),
    })
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints,
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
    })

    await reactor.ingest(turnEvent("turn_started", { turn_id: "turn-native" }))
    await reactor.ingest(
      turnEvent("turn_error", {
        turn_id: "turn-native",
        error: "provider failed before final completion",
      })
    )

    expect(captureCheckpoint).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual([])

    await reactor.ingest(
      turnEvent("turn_error", {
        turn_id: "turn-native",
        status: "failed",
        error: "Sandbox command failed.",
      })
    )

    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    expect(captureCheckpoint).toHaveBeenNthCalledWith(2, {
      cwd: "/repo",
      checkpointRef,
    })
    expect(diffCheckpoints).toHaveBeenCalledWith({
      cwd: "/repo",
      fromCheckpointRef: baseRef,
      toCheckpointRef: checkpointRef,
      fallbackFromToHead: false,
      ignoreWhitespace: false,
    })
    expect(emitted).toEqual([
      expect.objectContaining({
        event_type: "turn.diff.updated",
        payload: expect.objectContaining({
          checkpointRef,
          baseCheckpointRef: baseRef,
          turn_id: "turn-native",
        }),
      }),
      expect.objectContaining({
        event_type: "checkpoint.captured",
        payload: expect.objectContaining({
          status: "error",
          checkpointRef,
          baseCheckpointRef: baseRef,
          turn_id: "turn-native",
        }),
      }),
    ])
  })

  it("ignores legacy lifecycle events without a turn id or turn index", async () => {
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(turnEvent("turn_started"))
    await reactor.ingest(turnEvent("turn_completed"))

    expect(captureCheckpoint).not.toHaveBeenCalled()
  })

  it("skips checkpoint refs when BetterC0de snapshot config is disabled", async () => {
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const diffCheckpoints = vi.fn().mockResolvedValue({ diff: "" })
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints,
      isGitRepo: vi.fn().mockResolvedValue(true),
      isSnapshotEnabled: vi.fn().mockResolvedValue(false),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(turnEvent("turn_started", { turn_index: 1 }))
    await reactor.ingest(turnEvent("turn_completed", { turn_index: 1 }))

    expect(captureCheckpoint).not.toHaveBeenCalled()
    expect(diffCheckpoints).not.toHaveBeenCalled()
  })

  it("subscribes and unsubscribes from the post-journal (projected) lane of the provider event bus", async () => {
    const bus = new EventEmitter()
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: bus,
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    const stop = reactor.start()
    bus.emit("projected", turnEvent("turn_started", { turn_index: 1 }))
    await waitForMockCall(captureCheckpoint, 1)
    stop()
    bus.emit("projected", turnEvent("turn_started", { turn_index: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captureCheckpoint).toHaveBeenCalledTimes(1)
  })

  it("does no per-event work for streamed deltas it never acts on", async () => {
    const bus = new EventEmitter()
    const reactor = new CheckpointReactor({
      eventBus: bus,
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })
    const internals = reactor as unknown as {
      ingestSerial: (...args: unknown[]) => Promise<void>
      queuesByThread: Map<string, unknown>
      threadTokens: Map<string, symbol>
    }
    const ingestSerial = vi.spyOn(internals, "ingestSerial")
    reactor.start()

    for (let index = 0; index < 500; index += 1) {
      bus.emit("projected", turnEvent("content_delta", { delta: "x" }))
      bus.emit("projected", turnEvent("reasoning_delta", { delta: "y" }))
    }
    // Synchronous: the early return happens before any promise is queued.
    expect(ingestSerial).not.toHaveBeenCalled()
    expect(internals.queuesByThread.size).toBe(0)
    expect(internals.threadTokens.size).toBe(0)

    bus.emit("projected", turnEvent("turn_started", { turn_index: 1 }))
    await waitForMockCall(ingestSerial, 1)
    reactor.stop()
  })

  it("treats a bus turn_started as a no-op once prepareTurn registered the same dispatch", async () => {
    // Pins the bus lane's only job for a turn start: `prepareTurn` (the hub's
    // pre-dispatch barrier) already captured the baseline for this
    // `dispatchTurnId`, so the same event observed on the bus afterwards must
    // not capture a second baseline. Moving the reactor to a post-journal
    // lane cannot change this, because the dedup keys off the dispatch id.
    const bus = new EventEmitter()
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: bus,
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })
    reactor.start()
    const started = turnEvent("turn_started", {
      turn_id: "native-turn",
      dispatchTurnId: "dispatch-prepared",
    })

    await reactor.prepareTurn(started)
    expect(captureCheckpoint).toHaveBeenCalledTimes(1)

    bus.emit("projected", started)
    bus.emit(
      "projected",
      turnEvent("turn_started", { dispatchTurnId: "dispatch-prepared" })
    )
    // The raw lane is not the reactor's: an event there is not observed.
    bus.emit(
      "event",
      turnEvent("turn_started", { dispatchTurnId: "dispatch-raw-only" })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captureCheckpoint).toHaveBeenCalledTimes(1)
    await reactor.stop()
  })

  it("defers bus terminal capture until the provider dispatch is quiescent", async () => {
    const bus = new EventEmitter()
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: bus,
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })
    reactor.start()
    const started = turnEvent("turn_started", {
      dispatchTurnId: "dispatch-quiescent",
    })
    const completed = turnEvent("turn_completed", {
      dispatchTurnId: "dispatch-quiescent",
    })

    bus.emit("projected", started)
    await waitForMockCall(captureCheckpoint, 1)
    bus.emit("projected", completed)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(captureCheckpoint).toHaveBeenCalledTimes(1)

    await reactor.finalizeTurn(completed)
    expect(captureCheckpoint).toHaveBeenCalledTimes(2)
    await reactor.stop()
  })

  it("serializes start and completion for the same thread", async () => {
    let releaseSnapshot!: (enabled: boolean) => void
    const snapshotGate = new Promise<boolean>((resolve) => {
      releaseSnapshot = resolve
    })
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const emitted: LegacyProviderEvent[] = []
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      isSnapshotEnabled: vi.fn(() => snapshotGate),
      emitEvent: (event) => emitted.push(event),
    })

    const starting = reactor.ingest(
      turnEvent("turn_started", { turn_id: "turn-racy" })
    )
    const completing = reactor.ingest(
      turnEvent("turn_completed", { turn_id: "turn-racy" })
    )
    releaseSnapshot(true)
    await Promise.all([starting, completing])

    expect(captureCheckpoint).toHaveBeenCalledTimes(2)
    expect(emitted.map((event) => event.event_type)).toEqual([
      "turn.diff.updated",
      "checkpoint.captured",
    ])
    expect(deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: [checkpointRefForThreadTurn("thread-1", 0)],
    })
  })

  it("does not repopulate checkpoint state after a thread is forgotten", async () => {
    let releaseSnapshot!: (enabled: boolean) => void
    const snapshotGate = new Promise<boolean>((resolve) => {
      releaseSnapshot = resolve
    })
    const isSnapshotEnabled = vi.fn(() => snapshotGate)
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      isSnapshotEnabled,
      emitEvent: vi.fn(),
    })

    const starting = reactor.ingest(
      turnEvent("turn_started", { turn_id: "turn-forgotten" })
    )
    await waitForMockCall(isSnapshotEnabled, 1)
    reactor.forgetThread("thread-1")
    releaseSnapshot(true)
    await starting
    await reactor.ingest(
      turnEvent("turn_completed", { turn_id: "turn-forgotten" })
    )

    expect(captureCheckpoint).not.toHaveBeenCalled()
  })

  it("removes an orphaned completion ref when diff capture fails", async () => {
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockRejectedValue(new Error("diff failed")),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(
      turnEvent("turn_started", { turn_id: "turn-orphaned" })
    )
    await reactor.ingest(
      turnEvent("turn_completed", { turn_id: "turn-orphaned" })
    )

    expect(deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: [
        checkpointRefForThreadTurn("thread-1", 0),
        checkpointRefForThreadTurn("thread-1", 1),
      ],
    })
  })

  it("propagates a bus-observed completion failure through the awaited finalizer", async () => {
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi
        .fn()
        .mockRejectedValue(new Error("checkpoint diff failed")),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })
    const started = turnEvent("turn_started", {
      dispatchTurnId: "dispatch-finalization-failed",
    })
    const completed = turnEvent("turn_completed", {
      dispatchTurnId: "dispatch-finalization-failed",
    })

    await reactor.prepareTurn(started)
    await reactor.ingest(completed)

    await expect(reactor.finalizeTurn(completed)).rejects.toThrow(
      "checkpoint diff failed"
    )
  })

  it("journals refs before capture and retains output intent until projection", async () => {
    const trace: string[] = []
    const queued = new Set<string>()
    const cleanupJournal = {
      enqueue: vi.fn(
        (input: {
          threadId: string
          cwd: string
          checkpointRefs: readonly string[]
        }) => {
          for (const checkpointRef of input.checkpointRefs) {
            queued.add(checkpointRef)
            trace.push(`enqueue:${checkpointRef}`)
          }
        }
      ),
      complete: vi.fn((cwd: string, checkpointRefs: readonly string[]) => {
        expect(cwd).toBe("/repo")
        for (const checkpointRef of checkpointRefs) {
          trace.push(`complete:${checkpointRef}`)
          queued.delete(checkpointRef)
        }
      }),
    }
    const captureCheckpoint = vi.fn(
      async (input: { cwd: string; checkpointRef: string }) => {
        expect(input.cwd).toBe("/repo")
        expect(queued.has(input.checkpointRef)).toBe(true)
        trace.push(`capture:${input.checkpointRef}`)
      }
    )
    const deleteCheckpointRefs = vi.fn(
      async (input: { cwd: string; checkpointRefs: string[] }) => {
        expect(input.cwd).toBe("/repo")
        for (const checkpointRef of input.checkpointRefs) {
          expect(queued.has(checkpointRef)).toBe(true)
          trace.push(`delete:${checkpointRef}`)
        }
      }
    )
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal,
      captureCheckpoint,
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(
      turnEvent("turn_started", { turn_id: "turn-journaled" })
    )
    await reactor.ingest(
      turnEvent("turn_completed", { turn_id: "turn-journaled" })
    )

    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 1)
    expect(trace).toEqual([
      `enqueue:${baseRef}`,
      `capture:${baseRef}`,
      `enqueue:${checkpointRef}`,
      `capture:${checkpointRef}`,
      `enqueue:${baseRef}`,
      `delete:${baseRef}`,
      `complete:${baseRef}`,
    ])
    expect([...queued]).toEqual([checkpointRef])
  })

  it("keeps a failed ref deletion queued for the durable retry scheduler", async () => {
    const queued = new Set<string>()
    const cleanupJournal = {
      enqueue: vi.fn(
        (input: {
          threadId: string
          cwd: string
          checkpointRefs: readonly string[]
        }) => {
          for (const checkpointRef of input.checkpointRefs) {
            queued.add(checkpointRef)
          }
        }
      ),
      complete: vi.fn((cwd: string, checkpointRefs: readonly string[]) => {
        expect(cwd).toBe("/repo")
        for (const checkpointRef of checkpointRefs) {
          queued.delete(checkpointRef)
        }
      }),
      recordFailure: vi.fn(),
    }
    const deleteCheckpointRefs = vi
      .fn()
      .mockRejectedValue(new Error("git ref lock busy"))
    const checkpointLogger = logger()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: checkpointLogger,
      cleanupJournal,
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(
      turnEvent("turn_started", { turn_id: "turn-cleanup-failure" })
    )
    await reactor.ingest(
      turnEvent("turn_interrupted", { turn_id: "turn-cleanup-failure" })
    )

    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    expect(deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: [baseRef],
    })
    expect(cleanupJournal.complete).not.toHaveBeenCalled()
    expect(cleanupJournal.recordFailure).toHaveBeenCalledWith(
      "/repo",
      baseRef,
      expect.objectContaining({ message: "git ref lock busy" })
    )
    expect([...queued]).toEqual([
      baseRef,
      checkpointRefForThreadTurn("thread-1", 1),
    ])
    expect(checkpointLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointRefs: [baseRef],
      }),
      "failed to clean up checkpoint refs"
    )
  })

  it("awaits the baseline before provider admission and deduplicates its later event", async () => {
    let releaseCapture!: () => void
    const captureBlocked = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    const captureCheckpoint = vi.fn(() => captureBlocked)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })
    const event = turnEvent("turn_started", {
      dispatchTurnId: "dispatch-1",
      turn_id: "dispatch-1",
    })

    let admitted = false
    const preparing = reactor.prepareTurn(event).then(() => {
      admitted = true
    })
    await waitForMockCall(captureCheckpoint, 1)
    expect(admitted).toBe(false)

    releaseCapture()
    await preparing
    await reactor.ingest(event)
    expect(captureCheckpoint).toHaveBeenCalledTimes(1)
  })

  it("rejects provider admission when the required baseline cannot be captured", async () => {
    const reconcileTurnSlot = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      captureCheckpoint: vi.fn().mockRejectedValue(new Error("git locked")),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      allocateTurnSlot: () => ({ slot: 0, turnCount: 1 }),
      reconcileTurnSlot,
      emitEvent: vi.fn(),
    })

    await expect(
      reactor.prepareTurn(
        turnEvent("turn_started", { dispatchTurnId: "dispatch-failed" })
      )
    ).rejects.toThrow("git locked")
    expect(reconcileTurnSlot).toHaveBeenCalledWith("thread-1")
  })

  it("retains the pre-first-turn baseline after a successful checkpoint", async () => {
    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    const completeIntent = vi.fn().mockReturnValue(true)
    const retainBaseline = vi.fn()
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const cleanupJournal = {
      enqueue: vi.fn(
        (input: { cwd: string; checkpointRefs: readonly string[] }) =>
          input.checkpointRefs.map((checkpointRef) => ({
            cwd: input.cwd,
            checkpointRef,
            intentId: `intent:${checkpointRef}`,
          }))
      ),
      completeIntent,
      retainBaseline,
    }
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal,
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
    })

    await reactor.ingest(
      turnEvent("turn_started", { dispatchTurnId: "dispatch-retained" })
    )
    await reactor.ingest(
      turnEvent("turn_completed", { dispatchTurnId: "dispatch-retained" })
    )

    expect(retainBaseline).toHaveBeenCalledWith({
      threadId: "thread-1",
      cwd: "/repo",
      checkpointRef: baseRef,
    })
    expect(completeIntent).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRef: baseRef,
      intentId: `intent:${baseRef}`,
    })
    expect(deleteCheckpointRefs).not.toHaveBeenCalled()
  })

  it("retains the initial baseline and advances the slot after an interrupted turn", async () => {
    const baseRef = checkpointRefForThreadTurn("thread-1", 0)
    let retained: {
      readonly cwd: string
      readonly checkpointRef: string
    } | null = null
    let nextSlot = 0
    const retainBaseline = vi.fn(
      (input: { cwd: string; checkpointRef: string }) => {
        retained = {
          cwd: input.cwd,
          checkpointRef: input.checkpointRef,
        }
      }
    )
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        retainBaseline,
        getBaseline: vi.fn(() => retained),
      },
      captureCheckpoint,
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      allocateTurnSlot: () => {
        const slot = nextSlot
        nextSlot += 1
        return { slot, turnCount: slot + 1 }
      },
      reconcileTurnSlot: () => {
        nextSlot = 0
      },
      emitEvent: vi.fn(),
    })

    await reactor.prepareTurn(
      turnEvent("turn_started", { dispatchTurnId: "dispatch-interrupted" })
    )
    expect(retainBaseline).toHaveBeenCalledWith({
      threadId: "thread-1",
      cwd: "/repo",
      checkpointRef: baseRef,
    })
    await reactor.finalizeTurn(
      turnEvent("turn_interrupted", {
        dispatchTurnId: "dispatch-interrupted",
      })
    )

    await reactor.prepareTurn(
      turnEvent("turn_started", { dispatchTurnId: "dispatch-retry" })
    )

    expect(captureCheckpoint).toHaveBeenCalledTimes(3)
    expect(captureCheckpoint).toHaveBeenNthCalledWith(1, {
      cwd: "/repo",
      checkpointRef: baseRef,
    })
    expect(captureCheckpoint).toHaveBeenNthCalledWith(2, {
      cwd: "/repo",
      checkpointRef: checkpointRefForThreadTurn("thread-1", 1),
    })
    expect(captureCheckpoint).toHaveBeenNthCalledWith(3, {
      cwd: "/repo",
      checkpointRef: checkpointRefForThreadTurn("thread-1", 2),
    })
    expect(deleteCheckpointRefs).not.toHaveBeenCalled()
  })

  it("recovers a durably admitted crash-gap before later turns are admitted", async () => {
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 2)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 3)
    const emitted: LegacyProviderEvent[] = []
    const completeTurnAdmission = vi.fn()
    const failTurnAdmission = vi.fn()
    const deleteCheckpointRefs = vi.fn().mockResolvedValue(undefined)
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        getBaseline: vi.fn(() => null),
      },
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs,
      diffCheckpoints: vi.fn().mockResolvedValue({
        diff: [
          "diff --git a/recovered.ts b/recovered.ts",
          "--- a/recovered.ts",
          "+++ b/recovered.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
        ].join("\n"),
      }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
      listTurnAdmissions: () => [
        {
          threadId: "thread-1",
          turnKey: "turn:dispatch-crashed",
          turnId: "native-crashed",
          dispatchTurnId: "dispatch-crashed",
          turnCount: 2,
          cwd: "/repo",
          baseCheckpointRef,
          checkpointRef,
        },
      ],
      completeTurnAdmission,
      failTurnAdmission,
    })

    await expect(reactor.recoverPendingAdmissions()).resolves.toBe(1)

    expect(completeTurnAdmission).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnKey: "turn:dispatch-crashed",
      turnCount: 2,
      checkpointRef,
    })
    expect(failTurnAdmission).not.toHaveBeenCalled()
    expect(emitted.map((event) => event.event_type)).toEqual([
      "turn.diff.updated",
      "checkpoint.captured",
    ])
    expect(emitted[0]?.payload).toMatchObject({
      turn_id: "native-crashed",
      dispatchTurnId: "dispatch-crashed",
      turn_index: 2,
      checkpointRef,
      baseCheckpointRef,
    })
    expect(emitted[1]?.payload).toMatchObject({
      status: "error",
      turn_index: 2,
    })
    expect(deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: [baseCheckpointRef],
    })
  })

  it("reuses a durable recovery checkpoint instead of overwriting it on retry", async () => {
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 2)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 3)
    const captureCheckpoint = vi.fn().mockResolvedValue(undefined)
    const hasCheckpointRef = vi.fn().mockResolvedValue(true)
    const completeTurnAdmission = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        getBaseline: vi.fn(() => ({
          cwd: "/repo",
          checkpointRef: baseCheckpointRef,
        })),
      },
      captureCheckpoint,
      hasCheckpointRef,
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
      listTurnAdmissions: () => [
        {
          threadId: "thread-1",
          turnKey: "turn:dispatch-crashed",
          turnId: "native-crashed",
          dispatchTurnId: "dispatch-crashed",
          turnCount: 2,
          cwd: "/repo",
          baseCheckpointRef,
          checkpointRef,
        },
      ],
      completeTurnAdmission,
      failTurnAdmission: vi.fn(),
    })

    await expect(reactor.recoverPendingAdmissions()).resolves.toBe(1)

    expect(hasCheckpointRef).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRef,
    })
    expect(captureCheckpoint).not.toHaveBeenCalled()
    expect(completeTurnAdmission).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnKey: "turn:dispatch-crashed",
      turnCount: 2,
      checkpointRef,
    })
  })

  it("completes recovery with a bounded file summary when the patch is too large", async () => {
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 2)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 3)
    const emitted: LegacyProviderEvent[] = []
    const outputLimitError = Object.assign(
      new Error("git diff exceeded the output limit"),
      { gitArgs: ["diff", "--patch"] }
    )
    const completeTurnAdmission = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        getBaseline: vi.fn(() => ({
          cwd: "/repo",
          checkpointRef: baseCheckpointRef,
        })),
      },
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      hasCheckpointRef: vi.fn().mockResolvedValue(true),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockRejectedValue(outputLimitError),
      summarizeCheckpointDiff: vi.fn().mockResolvedValue({
        files: [
          { path: "generated/a.bin", additions: 0, deletions: 0 },
          { path: "src/main.ts", additions: 4, deletions: 1 },
        ],
        totalFiles: 32_493,
        filesTruncated: true,
      }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
      listTurnAdmissions: () => [
        {
          threadId: "thread-1",
          turnKey: "turn:dispatch-crashed",
          turnId: "native-crashed",
          dispatchTurnId: "dispatch-crashed",
          turnCount: 2,
          cwd: "/repo",
          baseCheckpointRef,
          checkpointRef,
        },
      ],
      completeTurnAdmission,
      failTurnAdmission: vi.fn(),
    })

    await expect(reactor.recoverPendingAdmissions()).resolves.toBe(1)

    expect(emitted[0]).toMatchObject({
      event_type: "turn.diff.updated",
      payload: {
        unifiedDiff: "",
        diffTruncated: true,
        diffTruncationReason: "output_limit",
        diffFileCount: 32_493,
        diffFilesTruncated: true,
        files: [
          { path: "generated/a.bin", additions: 0, deletions: 0 },
          { path: "src/main.ts", additions: 4, deletions: 1 },
        ],
      },
    })
    expect(emitted[1]).toMatchObject({
      event_type: "checkpoint.captured",
      payload: {
        diffTruncated: true,
        diffTruncationReason: "output_limit",
        diffFileCount: 32_493,
        diffFilesTruncated: true,
        files: [
          { path: "generated/a.bin", additions: 0, deletions: 0 },
          { path: "src/main.ts", additions: 4, deletions: 1 },
        ],
      },
    })
    expect(completeTurnAdmission).toHaveBeenCalledOnce()
  })

  it("falls back to the file summary when diffCheckpoints returns a truncated patch", async () => {
    // `diffCheckpoints` now bounds its own output and reports `truncated`
    // instead of throwing; a partial patch must never be stored as complete.
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 2)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 3)
    const emitted: LegacyProviderEvent[] = []
    const completeTurnAdmission = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        getBaseline: vi.fn(() => ({
          cwd: "/repo",
          checkpointRef: baseCheckpointRef,
        })),
      },
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      hasCheckpointRef: vi.fn().mockResolvedValue(true),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/main.ts b/src/main.ts --- partial",
        truncated: true,
      }),
      summarizeCheckpointDiff: vi.fn().mockResolvedValue({
        files: [{ path: "src/main.ts", additions: 4, deletions: 1 }],
        totalFiles: 1,
        filesTruncated: false,
      }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: (event) => emitted.push(event),
      listTurnAdmissions: () => [
        {
          threadId: "thread-1",
          turnKey: "turn:dispatch-crashed",
          turnId: "native-crashed",
          dispatchTurnId: "dispatch-crashed",
          turnCount: 2,
          cwd: "/repo",
          baseCheckpointRef,
          checkpointRef,
        },
      ],
      completeTurnAdmission,
      failTurnAdmission: vi.fn(),
    })

    await expect(reactor.recoverPendingAdmissions()).resolves.toBe(1)

    expect(emitted[0]).toMatchObject({
      event_type: "turn.diff.updated",
      payload: {
        unifiedDiff: "",
        diffTruncated: true,
        diffTruncationReason: "output_limit",
        diffFileCount: 1,
        files: [{ path: "src/main.ts", additions: 4, deletions: 1 }],
      },
    })
    expect(completeTurnAdmission).toHaveBeenCalledOnce()
  })

  it("does not summarize while an output-limited Git process may still be alive", async () => {
    const baseCheckpointRef = checkpointRefForThreadTurn("thread-1", 2)
    const checkpointRef = checkpointRefForThreadTurn("thread-1", 3)
    const survivorError = Object.assign(
      new Error("git diff exceeded the output limit"),
      {
        gitArgs: ["diff", "--patch"],
        survivor: true,
      }
    )
    const summarizeCheckpointDiff = vi.fn()
    const completeTurnAdmission = vi.fn()
    const failTurnAdmission = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        getBaseline: vi.fn(() => ({
          cwd: "/repo",
          checkpointRef: baseCheckpointRef,
        })),
      },
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      hasCheckpointRef: vi.fn().mockResolvedValue(true),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockRejectedValue(survivorError),
      summarizeCheckpointDiff,
      isGitRepo: vi.fn().mockResolvedValue(true),
      emitEvent: vi.fn(),
      listTurnAdmissions: () => [
        {
          threadId: "thread-1",
          turnKey: "turn:dispatch-crashed",
          turnId: "native-crashed",
          dispatchTurnId: "dispatch-crashed",
          turnCount: 2,
          cwd: "/repo",
          baseCheckpointRef,
          checkpointRef,
        },
      ],
      completeTurnAdmission,
      failTurnAdmission,
    })

    await expect(reactor.recoverPendingAdmissions()).rejects.toBe(survivorError)

    expect(summarizeCheckpointDiff).not.toHaveBeenCalled()
    expect(completeTurnAdmission).not.toHaveBeenCalled()
    expect(failTurnAdmission).toHaveBeenCalledWith(
      "thread-1",
      "turn:dispatch-crashed",
      survivorError
    )
  })

  it("does not rewind an admitted slot when durable completion fails", async () => {
    const reconcileTurnSlot = vi.fn()
    const failTurnAdmission = vi.fn()
    const reactor = new CheckpointReactor({
      eventBus: new EventEmitter(),
      threads: { getThreadProjectPath: () => "/repo" },
      logger: logger(),
      cleanupJournal: {
        enqueue: vi.fn(() => []),
        retainBaseline: vi.fn(),
      },
      captureCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteCheckpointRefs: vi.fn().mockResolvedValue(undefined),
      diffCheckpoints: vi.fn().mockResolvedValue({ diff: "" }),
      isGitRepo: vi.fn().mockResolvedValue(true),
      allocateTurnSlot: () => ({ slot: 0, turnCount: 1 }),
      reconcileTurnSlot,
      recordTurnAdmission: vi.fn(),
      completeTurnAdmission: () => {
        throw new Error("projection receipt missing")
      },
      failTurnAdmission,
      emitEvent: vi.fn(),
    })

    await reactor.prepareTurn(
      turnEvent("turn_started", {
        turn_id: "native-1",
        dispatchTurnId: "dispatch-1",
      })
    )
    await expect(
      reactor.finalizeTurn(
        turnEvent("turn_completed", {
          turn_id: "native-1",
          dispatchTurnId: "dispatch-1",
        })
      )
    ).rejects.toThrow("projection receipt missing")

    expect(failTurnAdmission).toHaveBeenCalledWith(
      "thread-1",
      "turn:dispatch-1",
      expect.objectContaining({ message: "projection receipt missing" })
    )
    expect(reconcileTurnSlot).not.toHaveBeenCalled()
  })
})

async function waitForMockCall(
  mock: { mock: { calls: unknown[] } },
  count: number
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
