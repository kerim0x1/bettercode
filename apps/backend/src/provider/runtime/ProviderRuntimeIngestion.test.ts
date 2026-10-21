import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { openDatabase } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import type { ThreadActivityProjection } from "../../persistence/projections"
import { ProviderRuntimeJournalReplayer } from "./ProviderRuntimeJournalReplayer"
import { ProviderRuntimeJournalRecoveryStore } from "./ProviderRuntimeJournalRecoveryStore"
import { ProviderRuntimeProjectionReceiptStore } from "./ProviderRuntimeProjectionReceiptStore"
import type { ProviderRuntimeEvent } from "../types"
import {
  InMemoryPendingSourceProposedPlanImplementationStore,
  ProviderRuntimeBridgeError,
  ProviderRuntimeIngestion,
  providerAssistantMessageId,
} from "./ProviderRuntimeIngestion"
import {
  ProviderRuntimeEventJournal,
  ProviderRuntimeJournalSerializationError,
} from "./ProviderRuntimeEventJournal"
import { canonicalToLegacy } from "./legacyBridge"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "./contracts"
import {
  CANONICAL_JOURNAL_FIXTURES,
  cloneFixtureEvent,
  oversizedToolCompletedFixture,
  oversizedToolCompletedManyBlocksFixture,
  type CanonicalJournalFixture,
} from "./testUtils/canonicalJournalFixtures"
import { canonicalJournalEntry, legacyJournalEntry } from "./journalEntry"

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeBroadcaster(clientCount = 2) {
  const frames: unknown[] = []
  return {
    frames,
    broadcast: vi.fn((frame: unknown) => {
      frames.push(frame)
    }),
    clientCount: vi.fn(() => clientCount),
  }
}

function toolCallEvent(
  input?: Partial<ProviderRuntimeEvent>
): ProviderRuntimeEvent {
  return {
    event_type: "tool_call",
    thread_id: "thread-1",
    payload: {
      providerKind: "codex",
      providerInstanceId: "codex-work",
      tool_id: "tool-1",
      tool_name: "exec_command",
      turn_id: "turn-1",
      input: { command: "npm test" },
    },
    ...input,
  }
}

/** Frozen wall clock for the canonical goldens: activities without an `at`-derived timestamp stamp `Date.now()`. */
const GOLDEN_NOW = Date.parse("2026-09-11T12:00:00.000Z")

interface JournaledRow {
  readonly event_type: string
  readonly stream_id: string
  readonly stream_version: number
  readonly payload_json: string
  readonly metadata_json: string
}

/**
 * A full ingestion with a real journal over an in-memory append log, capturing
 * every activity, broadcast frame and journal row. Shared by the step-0
 * goldens (today's `canonicalToLegacy -> ingest` path) and the parity tests
 * that drive the same fixtures through the post-journal bridge.
 */
function makeCanonicalHarness(
  options: {
    readonly sequenceStart?: number
    readonly appendSequenceStart?: number
    readonly legacyView?: (
      event: CanonicalProviderRuntimeEvent
    ) => ProviderRuntimeEvent | null
    readonly append?: (rows: JournaledRow[]) => Array<{ sequence: number }>
  } = {}
) {
  const rows: JournaledRow[] = []
  let appendSequence = options.appendSequenceStart ?? 500
  const append = vi.fn(
    options.append ??
      ((input: JournaledRow[]) =>
        input.map((row) => {
          rows.push(row)
          return { sequence: ++appendSequence }
        }))
  )
  const eventJournal = new ProviderRuntimeEventJournal({
    append,
  } as unknown as EventStore)
  const activities: ThreadActivityProjection[] = []
  const frames: unknown[] = []
  const projected: ProviderRuntimeEvent[] = []
  const receipts = { markProjected: vi.fn() }
  const lifecycleStore = {
    hasProviderTurn: vi.fn(() => true),
    markCompletedByProviderTurn: vi.fn(),
    markFailedByProviderTurn: vi.fn(),
  }
  const logger = makeLogger()
  const fatal = vi.fn()
  const ingestion = new ProviderRuntimeIngestion({
    eventBus: new EventEmitter(),
    eventJournal,
    projectionReceipts: receipts,
    chatDispatchLifecycleStore: lifecycleStore,
    activityStore: {
      upsert: (activity) => activities.push(structuredClone(activity)),
    },
    broadcaster: {
      broadcast: (frame: unknown) => frames.push(structuredClone(frame)),
      clientCount: () => 1,
    },
    logger,
    onFatalProjectionFailure: fatal,
    sequenceStart: options.sequenceStart ?? 100,
    ...(options.legacyView ? { legacyView: options.legacyView } : {}),
    projectedSink: (event: ProviderRuntimeEvent) =>
      projected.push(structuredClone(event)),
  })
  return {
    ingestion,
    activities,
    frames,
    rows,
    projected,
    receipts,
    lifecycleStore,
    logger,
    fatal,
    append,
  }
}

type CanonicalHarness = ReturnType<typeof makeCanonicalHarness>

function harnessSnapshot(harness: CanonicalHarness) {
  return {
    activities: harness.activities,
    frames: harness.frames,
    rows: harness.rows.map((row) => ({
      event_type: row.event_type,
      stream_id: row.stream_id,
      stream_version: row.stream_version,
    })),
    lifecycle: {
      completed: harness.lifecycleStore.markCompletedByProviderTurn.mock.calls,
      failed: harness.lifecycleStore.markFailedByProviderTurn.mock.calls,
    },
    receipts: harness.receipts.markProjected.mock.calls.map((call) => call[0]),
  }
}

/** Today's production path: bridge in front of the bus, then legacy ingest. */
function driveThroughLegacyBridgePath(
  harness: CanonicalHarness,
  events: ReadonlyArray<CanonicalProviderRuntimeEvent>
): void {
  for (const event of events) {
    const legacy = canonicalToLegacy(cloneFixtureEvent(event))
    if (legacy) harness.ingestion.ingest(legacy)
  }
}

function withFrozenClock<T>(run: () => T): T {
  vi.useFakeTimers({ toFake: ["Date"], now: GOLDEN_NOW })
  try {
    return run()
  } finally {
    vi.useRealTimers()
  }
}

function runtimeFrames(frames: ReadonlyArray<unknown>): ProviderRuntimeEvent[] {
  return frames
    .filter(
      (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
        (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
    )
    .map((frame) => frame.data)
}

describe("ProviderRuntimeIngestion", () => {
  it("journals a bound terminal dispatch before completion and receipt projection", () => {
    const calls: string[] = []
    const lifecycleStore = {
      hasProviderTurn: vi.fn(() => true),
      markCompletedByProviderTurn: vi.fn(() => calls.push("completed")),
      markFailedByProviderTurn: vi.fn(() => calls.push("failed")),
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist: vi.fn(() => (calls.push("journal"), 77)) },
      projectionReceipts: { markProjected: vi.fn(() => calls.push("receipt")) },
      chatDispatchLifecycleStore: lifecycleStore,
      shouldPersistConversations: () => false,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-terminal",
      payload: {
        provider_instance_id: "codex-work",
        turn_id: "provider-native-turn",
        dispatchTurnId: "dispatch-turn",
        status: "completed",
      },
    })

    expect(lifecycleStore.markCompletedByProviderTurn).toHaveBeenCalledWith(
      "thread-terminal",
      "codex-work",
      "dispatch-turn"
    )
    expect(lifecycleStore.hasProviderTurn).toHaveBeenCalledWith(
      "thread-terminal",
      "codex-work",
      "dispatch-turn"
    )
    expect(lifecycleStore.markFailedByProviderTurn).not.toHaveBeenCalled()
    expect(calls).toEqual(["journal", "completed", "receipt"])
  })

  it("treats explicit failure as authoritative and ignores graceful session exit", () => {
    const lifecycleStore = {
      hasProviderTurn: vi.fn(() => true),
      markCompletedByProviderTurn: vi.fn(),
      markFailedByProviderTurn: vi.fn(),
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      chatDispatchLifecycleStore: lifecycleStore,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-terminal",
      payload: { dispatchTurnId: "dispatch-failed", status: "failed" },
    })
    ingestion.ingest({
      event_type: "session.exited",
      thread_id: "thread-terminal",
      payload: {},
    })

    expect(lifecycleStore.markFailedByProviderTurn).toHaveBeenCalledOnce()
    expect(lifecycleStore.markFailedByProviderTurn).toHaveBeenCalledWith(
      "thread-terminal",
      null,
      "dispatch-failed",
      "Provider turn ended with status 'failed'."
    )
    expect(lifecycleStore.markCompletedByProviderTurn).not.toHaveBeenCalled()
  })

  it("fails an active dispatch when the Hub correlates its session exit", () => {
    const lifecycleStore = {
      hasProviderTurn: vi.fn(() => true),
      markCompletedByProviderTurn: vi.fn(),
      markFailedByProviderTurn: vi.fn(),
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      chatDispatchLifecycleStore: lifecycleStore,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "session.exited",
      thread_id: "thread-terminal",
      payload: { dispatchTurnId: "dispatch-active-on-exit" },
    })

    expect(lifecycleStore.markFailedByProviderTurn).toHaveBeenCalledWith(
      "thread-terminal",
      null,
      "dispatch-active-on-exit",
      "Provider turn failed."
    )
    expect(lifecycleStore.markCompletedByProviderTurn).not.toHaveBeenCalled()
  })

  it("projects every canonical turn failure event onto its dispatch", () => {
    const lifecycleStore = {
      hasProviderTurn: vi.fn(() => true),
      markCompletedByProviderTurn: vi.fn(),
      markFailedByProviderTurn: vi.fn(),
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      chatDispatchLifecycleStore: lifecycleStore,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    const failures: Array<ProviderRuntimeEvent> = [
      {
        event_type: "turn_error",
        thread_id: "thread-terminal",
        payload: {
          dispatchTurnId: "dispatch-error",
          message: "provider error",
        },
      },
      {
        event_type: "turn_interrupted",
        thread_id: "thread-terminal",
        payload: {
          dispatchTurnId: "dispatch-interrupted",
          reason: "user interrupt",
        },
      },
      {
        event_type: "turn.aborted",
        thread_id: "thread-terminal",
        payload: { dispatchTurnId: "dispatch-aborted", status: "aborted" },
      },
    ]

    for (const event of failures) ingestion.ingest(event)

    expect(lifecycleStore.markFailedByProviderTurn).toHaveBeenCalledTimes(3)
    expect(
      lifecycleStore.markFailedByProviderTurn.mock.calls.map((call) => call[2])
    ).toEqual(["dispatch-error", "dispatch-interrupted", "dispatch-aborted"])
    expect(lifecycleStore.markCompletedByProviderTurn).not.toHaveBeenCalled()
  })

  it("replays the same completed receipt idempotently", () => {
    let status: "pending" | "completed" = "pending"
    const markCompletedByProviderTurn = vi.fn(() => {
      if (status !== "pending" && status !== "completed") {
        throw new Error("invalid terminal transition")
      }
      status = "completed"
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      chatDispatchLifecycleStore: {
        hasProviderTurn: () => true,
        markCompletedByProviderTurn,
        markFailedByProviderTurn: vi.fn(),
      },
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    const event: ProviderRuntimeEvent = {
      event_type: "turn_completed",
      thread_id: "thread-terminal",
      payload: { dispatchTurnId: "dispatch-replayed" },
    }

    ingestion.replayPersisted(legacyJournalEntry(event), {
      projectionSequence: 91,
    })
    ingestion.replayPersisted(legacyJournalEntry(event), {
      projectionSequence: 91,
    })

    expect(status).toBe("completed")
    expect(markCompletedByProviderTurn).toHaveBeenCalledTimes(2)
    expect(markCompletedByProviderTurn).toHaveBeenNthCalledWith(
      1,
      "thread-terminal",
      null,
      "dispatch-replayed"
    )
    expect(markCompletedByProviderTurn).toHaveBeenNthCalledWith(
      2,
      "thread-terminal",
      null,
      "dispatch-replayed"
    )
  })

  it("leaves a replay receipt uncommitted when terminal lifecycle projection fails", () => {
    const projectionReceipts = { markProjected: vi.fn() }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      projectionReceipts,
      chatDispatchLifecycleStore: {
        hasProviderTurn: () => true,
        markCompletedByProviderTurn: () => {
          throw new Error("dispatch storage unavailable")
        },
        markFailedByProviderTurn: vi.fn(),
      },
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    expect(() =>
      ingestion.replayPersisted(
        legacyJournalEntry({
          event_type: "turn_completed",
          thread_id: "thread-terminal",
          payload: { dispatchTurnId: "dispatch-replay" },
        }),
        { projectionSequence: 88 }
      )
    ).toThrow("dispatch storage unavailable")
    expect(projectionReceipts.markProjected).not.toHaveBeenCalled()
  })

  it("durably journals canonical provider events before broadcasting", () => {
    const eventJournal = { persist: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      activityStore: { upsert: vi.fn() },
      broadcaster,
      logger: makeLogger(),
      sequenceStart: 40,
    })
    const event = toolCallEvent()

    ingestion.ingest(event)

    expect(eventJournal.persist).toHaveBeenCalledWith(
      legacyJournalEntry(event),
      41
    )
    expect(eventJournal.persist.mock.invocationCallOrder[0]).toBeLessThan(
      broadcaster.broadcast.mock.invocationCallOrder[0] ?? 0
    )
  })

  it("receipts a journal event only after its projections succeed", () => {
    const eventJournal = { persist: vi.fn(() => 73) }
    const projectionReceipts = { markProjected: vi.fn() }
    const activityStore = { upsert: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      projectionReceipts,
      activityStore,
      broadcaster,
      logger: makeLogger(),
    })

    ingestion.ingest(toolCallEvent())

    expect(projectionReceipts.markProjected).toHaveBeenCalledWith(73)
    expect(activityStore.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      projectionReceipts.markProjected.mock.invocationCallOrder[0] ?? 0
    )
    const runtimeBroadcastIndex = broadcaster.broadcast.mock.calls.findIndex(
      ([frame]) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
    )
    expect(runtimeBroadcastIndex).toBeGreaterThanOrEqual(0)
    expect(
      projectionReceipts.markProjected.mock.invocationCallOrder[0]
    ).toBeLessThan(
      broadcaster.broadcast.mock.invocationCallOrder[runtimeBroadcastIndex] ?? 0
    )
  })

  it("leaves a journal event unreceipted when a projection fails", () => {
    const projectionReceipts = { markProjected: vi.fn() }
    const persist = vi.fn().mockReturnValueOnce(74).mockReturnValueOnce(75)
    const fatal = vi.fn()
    const upsert = vi.fn(() => {
      throw new Error("activity store unavailable")
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist },
      projectionReceipts,
      activityStore: { upsert },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest(toolCallEvent())
    ingestion.ingest(toolCallEvent({ payload: { tool_id: "tool-2" } }))

    expect(projectionReceipts.markProjected).not.toHaveBeenCalled()
    // Both events are journaled; the second append re-opens projection, which
    // fails again for the same reason. Neither is silently skipped.
    expect(fatal).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(
      upsert.mock.calls.filter(
        (call) =>
          (call as unknown as [{ kind: string }])[0].kind === "tool.started"
      )
    ).toHaveLength(2)
  })

  it("holds back the broadcast of an event whose receipt failed and surfaces a degraded notice", () => {
    const persist = vi.fn().mockReturnValueOnce(81).mockReturnValueOnce(82)
    const upsert = vi.fn()
    const fatal = vi.fn()
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist },
      projectionReceipts: {
        markProjected: vi.fn(() => {
          throw new Error("receipt database unavailable")
        }),
      },
      activityStore: { upsert },
      broadcaster,
      logger,
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest(toolCallEvent())
    ingestion.ingest(
      toolCallEvent({
        event_type: "session.updated",
        payload: { status: "ready" },
      })
    )

    expect(fatal).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenCalledTimes(2)
    const runtimeFrames = broadcaster.frames.filter(
      (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
    )
    // The events themselves are never broadcast without a receipt...
    expect(
      runtimeFrames.filter(
        (frame) => frame.data.event_type !== "runtime.warning"
      )
    ).toEqual([])
    // ...but the user is told, in-thread, that projection is degraded — once
    // per thread per degraded block, not once per event.
    const notices = runtimeFrames.filter(
      (frame) => frame.data.event_type === "runtime.warning"
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]?.data.payload).toMatchObject({
      class: "projection_degraded",
      reason: "projection_receipt",
      source_event_type: "tool_call",
    })
    expect(
      upsert.mock.calls
        .map((call) => (call as unknown as [{ kind: string }])[0].kind)
        .filter((kind) => kind === "runtime.warning")
    ).toEqual(["runtime.warning"])
    // The second append does not claim projections "resume": the backend
    // is tainted and draining when this path runs.
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("projections resume")
    )
  })

  it("emits a fresh degraded notice per thread once a projection has succeeded again", () => {
    let sequence = 90
    const persist = vi.fn(() => ++sequence)
    let receiptsFail = true
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist },
      projectionReceipts: {
        markProjected: vi.fn(() => {
          if (receiptsFail) throw new Error("receipt database unavailable")
        }),
      },
      activityStore: { upsert: vi.fn() },
      broadcaster,
      logger: makeLogger(),
      onFatalProjectionFailure: vi.fn(),
    })
    const notices = () =>
      broadcaster.frames.filter(
        (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
          (frame as { channel?: unknown }).channel ===
            "provider.runtimeEvent" &&
          (frame as { data: ProviderRuntimeEvent }).data.event_type ===
            "runtime.warning"
      )

    ingestion.ingest(toolCallEvent())
    ingestion.ingest(toolCallEvent({ payload: { tool_id: "tool-2" } }))
    // A different thread is its own block and gets its own notice.
    ingestion.ingest(toolCallEvent({ thread_id: "thread-2" }))
    expect(notices().map((frame) => frame.data.thread_id)).toEqual([
      "thread-1",
      "thread-2",
    ])

    receiptsFail = false
    ingestion.ingest(toolCallEvent({ payload: { tool_id: "tool-3" } }))
    receiptsFail = true
    ingestion.ingest(toolCallEvent({ payload: { tool_id: "tool-4" } }))
    expect(notices().map((frame) => frame.data.thread_id)).toEqual([
      "thread-1",
      "thread-2",
      "thread-1",
    ])
  })

  it("replays persisted events without re-journaling or broadcasting", () => {
    const eventJournal = { persist: vi.fn() }
    const activityStore = { upsert: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      shouldPersistConversations: () => false,
      activityStore,
      broadcaster,
      logger: makeLogger(),
    })
    const event = toolCallEvent()

    ingestion.replayPersisted(legacyJournalEntry(event), {
      projectionSequence: 91,
    })

    expect(activityStore.upsert).toHaveBeenCalledOnce()
    expect(eventJournal.persist).not.toHaveBeenCalled()
    expect(
      broadcaster.frames.filter(
        (frame) =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
      )
    ).toEqual([])
  })

  it("uses the original projection sequence during startup replay", () => {
    const upsert = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1_000_000,
    })

    ingestion.replayPersisted(legacyJournalEntry(toolCallEvent()), {
      projectionSequence: 91,
    })

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 91 })
    )
  })

  it("hydrates the durable transcript prefix before replaying a missing delta", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        getMessage: vi.fn(() => ({
          message_id: providerAssistantMessageId("thread-prefix", "turn-1"),
          turn_id: "turn-1",
          role: "assistant",
          content: "Hello ",
          created_at: "2026-07-11T04:00:00.000Z",
          extra: { providerRuntimeSequence: 100 },
        })),
        upsertMessage,
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1_000,
    })

    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "content_delta",
        thread_id: "thread-prefix",
        payload: { turn_id: "turn-1", delta: "world" },
      }),
      { projectionSequence: 101 }
    )

    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-prefix",
      message: expect.objectContaining({
        content: "Hello world",
        extra: expect.objectContaining({ providerRuntimeSequence: 101 }),
      }),
    })
  })

  it("skips a replayed transcript delta before mutation and applies only its missing suffix", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        getMessage: vi.fn(() => ({
          message_id: providerAssistantMessageId("thread-prefix", "turn-1"),
          turn_id: "turn-1",
          role: "assistant",
          content: "prefix/100",
          created_at: "2026-07-11T04:00:00.000Z",
          extra: { providerRuntimeSequence: 100 },
        })),
        upsertMessage,
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1_000,
    })

    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "content_delta",
        thread_id: "thread-prefix",
        payload: { turn_id: "turn-1", delta: "/100" },
      }),
      { projectionSequence: 100 }
    )
    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "content_delta",
        thread_id: "thread-prefix",
        payload: { turn_id: "turn-1", delta: "/101" },
      }),
      { projectionSequence: 101 }
    )

    expect(upsertMessage).toHaveBeenCalledOnce()
    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-prefix",
      message: expect.objectContaining({
        content: "prefix/100/101",
        extra: expect.objectContaining({ providerRuntimeSequence: 101 }),
      }),
    })
  })

  it("hydrates a durable assistant transcript for terminal-only replay", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        getMessage: vi.fn(() => ({
          message_id: providerAssistantMessageId("thread-terminal", "turn-1"),
          turn_id: "turn-1",
          role: "assistant",
          content: "finished answer",
          created_at: "2026-07-11T04:00:00.000Z",
          extra: { providerRuntimeSequence: 100, status: "running" },
        })),
        upsertMessage,
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "turn_completed",
        thread_id: "thread-terminal",
        payload: { turn_id: "turn-1", status: "completed" },
      }),
      { projectionSequence: 101 }
    )

    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-terminal",
      message: expect.objectContaining({
        content: "finished answer",
        extra: expect.objectContaining({
          status: "completed",
          providerRuntimeSequence: 101,
        }),
      }),
    })
  })

  it("counts hydrated transcript prefixes against the global byte cap", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        getMessage: vi.fn(() => ({
          message_id: providerAssistantMessageId("thread-memory", "turn-1"),
          turn_id: "turn-1",
          role: "assistant",
          content: "persisted-prefix",
          created_at: "2026-07-11T04:00:00.000Z",
          extra: { providerRuntimeSequence: 100 },
        })),
        upsertMessage,
      },
      bufferedAssistantTranscriptsMaxBytes: 8,
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "content_delta",
        thread_id: "thread-memory",
        payload: { turn_id: "turn-1", delta: "duplicate" },
      }),
      { projectionSequence: 100 }
    )

    expect(upsertMessage).toHaveBeenCalledOnce()
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ content: "persisted-prefix" }),
      })
    )
  })

  it("fences later live projections when accepted-link acknowledgement fails", () => {
    const eventJournal = { persist: vi.fn(() => 501) }
    const fatal = vi.fn()
    const ackPending = vi.fn(() => {
      throw new Error("accepted-link delete unavailable")
    })
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      projectionReceipts: { markProjected: vi.fn() },
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => ({ activeTurnId: null })),
        updateSessionLifecycle: vi.fn(),
      },
      sourceProposedPlanImplementations: {
        recordPending: vi.fn(),
        clearPending: vi.fn(),
        clearAll: vi.fn(() => 0),
        peekPending: vi.fn(() => ({
          sourceProposedPlan: { threadId: "source-thread", planId: "plan-1" },
          implementationThreadId: "implementation-thread",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          acceptedTurnId: "accepted-turn",
        })),
        ackPending,
      },
      broadcaster,
      logger: makeLogger(),
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest({
      event_type: "turn_started",
      thread_id: "implementation-thread",
      payload: {
        providerKind: "claude",
        providerInstanceId: "claude-main",
        turn_id: "provider-turn",
        dispatchTurnId: "accepted-turn",
      },
    })
    ingestion.ingest(toolCallEvent({ thread_id: "implementation-thread" }))

    expect(ackPending).toHaveBeenCalledOnce()
    expect(fatal).toHaveBeenCalledOnce()
    expect(eventJournal.persist).toHaveBeenCalledTimes(2)
    // The failed turn_started is never broadcast; the next successful journal
    // append re-opens projection, so the later tool call goes out after the
    // in-thread degradation notice.
    expect(
      broadcaster.frames
        .filter(
          (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
        )
        .map((frame) => frame.data.event_type)
    ).toEqual(["runtime.warning", "tool_call"])
  })

  it("throws during strict replay when accepted-link acknowledgement fails", () => {
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => ({ activeTurnId: null })),
        updateSessionLifecycle: vi.fn(),
      },
      sourceProposedPlanImplementations: {
        recordPending: vi.fn(),
        clearPending: vi.fn(),
        clearAll: vi.fn(() => 0),
        peekPending: vi.fn(() => ({
          sourceProposedPlan: { threadId: "source-thread", planId: "plan-1" },
          implementationThreadId: "implementation-thread",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          acceptedTurnId: "accepted-turn",
        })),
        ackPending: vi.fn(() => {
          throw new Error("accepted-link delete unavailable")
        }),
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    expect(() =>
      ingestion.replayPersisted(
        legacyJournalEntry({
          event_type: "turn_started",
          thread_id: "implementation-thread",
          payload: {
            providerKind: "claude",
            providerInstanceId: "claude-main",
            turn_id: "provider-turn",
            dispatchTurnId: "accepted-turn",
          },
        }),
        { projectionSequence: 101 }
      )
    ).toThrow("accepted-link delete unavailable")
  })

  it("keeps provider turns live but ephemeral when conversation auto-save is disabled", () => {
    const eventJournal = { persist: vi.fn() }
    const activityStore = { upsert: vi.fn() }
    const checkpointDiffStore = { recordRuntimeEvent: vi.fn() }
    const transcriptStore = { upsertMessage: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      shouldPersistConversations: () => false,
      activityStore,
      checkpointDiffStore,
      transcriptStore,
      broadcaster,
      logger: makeLogger(),
    })
    const contentEvent: ProviderRuntimeEvent = {
      event_type: "content_delta",
      thread_id: "thread-ephemeral",
      payload: {
        turn_id: "turn-ephemeral",
        delta: "private transient response",
      },
    }
    const terminalEvent: ProviderRuntimeEvent = {
      event_type: "turn_completed",
      thread_id: "thread-ephemeral",
      payload: { turn_id: "turn-ephemeral", status: "completed" },
    }

    ingestion.ingest(contentEvent)
    ingestion.ingest(toolCallEvent({ thread_id: "thread-ephemeral" }))
    ingestion.ingest(terminalEvent)

    expect(eventJournal.persist).not.toHaveBeenCalled()
    expect(activityStore.upsert).not.toHaveBeenCalled()
    expect(transcriptStore.upsertMessage).not.toHaveBeenCalled()
    expect(checkpointDiffStore.recordRuntimeEvent).toHaveBeenCalledTimes(3)
    expect(broadcaster.broadcast).toHaveBeenCalledTimes(3)
    expect(broadcaster.broadcast).toHaveBeenCalledWith({
      channel: "provider.runtimeEvent",
      data: contentEvent,
    })
  })

  it("retries terminal journaling before the final transcript snapshot and broadcast", () => {
    const upsertMessage = vi.fn()
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const persist = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("journal temporarily unavailable")
      })
      .mockImplementation(() => undefined)
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist },
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster,
      logger,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-journal-failure",
      payload: { turn_id: "turn-1", delta: "still durable" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-journal-failure",
      payload: { turn_id: "turn-1" },
    })

    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-journal-failure",
      message: expect.objectContaining({ content: "still durable" }),
    })
    expect(broadcaster.broadcast).toHaveBeenCalledWith({
      channel: "provider.runtimeEvent",
      data: expect.objectContaining({ event_type: "turn_completed" }),
    })
    expect(persist).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "turn_completed", attempt: 1 }),
      "provider runtime journal persist failed; retrying before projection"
    )
  })

  it("does not project or broadcast an event that cannot be journaled", () => {
    const upsertMessage = vi.fn()
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: {
        persist: vi.fn(() => {
          throw new Error("journal unavailable")
        }),
      },
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster,
      logger,
    })

    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-journal-failure",
      payload: { turn_id: "turn-1" },
    })

    expect(upsertMessage).not.toHaveBeenCalled()
    expect(broadcaster.broadcast).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "turn_completed",
        attempts: 3,
      }),
      "provider runtime journal persist failed; event queued before projection"
    )
  })

  it("fails fast instead of permanently queueing an unserializable event", () => {
    const persist = vi.fn(() => {
      throw new ProviderRuntimeJournalSerializationError("cyclic payload")
    })
    const fatal = vi.fn()
    const activityStore = { upsert: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist },
      activityStore,
      broadcaster,
      logger: makeLogger(),
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest(toolCallEvent())

    expect(persist).toHaveBeenCalledOnce()
    expect(fatal).toHaveBeenCalledOnce()
    // Only the degradation notice reaches the store and the wire; the
    // unserializable event itself is neither projected nor broadcast.
    expect(
      activityStore.upsert.mock.calls.map(
        (call) => (call as unknown as [{ kind: string }])[0].kind
      )
    ).toEqual(["runtime.warning"])
    expect(
      broadcaster.frames
        .filter(
          (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
            (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
        )
        .map((frame) => frame.data.event_type)
    ).toEqual(["runtime.warning"])
  })

  it("journals a 2 MB tool result with a bounded payload and keeps projecting", () => {
    let sequence = 500
    const append = vi.fn(
      (rows: Array<{ payload_json: string; metadata_json: string }>) =>
        rows.map(() => ({ sequence: ++sequence }))
    )
    const eventJournal = new ProviderRuntimeEventJournal({
      append,
    } as unknown as EventStore)
    const fatal = vi.fn()
    const activityStore = { upsert: vi.fn() }
    const projectionReceipts = { markProjected: vi.fn() }
    const broadcaster = makeBroadcaster()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      projectionReceipts,
      activityStore,
      broadcaster,
      logger: makeLogger(),
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest({
      event_type: "tool_result",
      thread_id: "thread-oversized",
      payload: {
        turn_id: "turn-1",
        tool_id: "tool-big",
        tool_name: "exec_command",
        output: "x".repeat(2 * 1024 * 1024),
      },
    })
    ingestion.ingest(
      toolCallEvent({
        thread_id: "thread-oversized",
        payload: { tool_id: "tool-2" },
      })
    )

    expect(fatal).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledTimes(2)
    const [bigRow] = append.mock.calls[0]![0]
    expect(Buffer.byteLength(bigRow!.payload_json, "utf8")).toBeLessThanOrEqual(
      1024 * 1024
    )
    expect(JSON.parse(bigRow!.metadata_json)).toMatchObject({
      payloadTruncated: true,
    })
    expect(
      activityStore.upsert.mock.calls.map(
        (call) => (call as unknown as [{ kind: string }])[0].kind
      )
    ).toEqual(["tool.completed", "tool.started"])
    // Journal-first means project what was journaled: the live activity and
    // the broadcast carry the bounded output and its structured marker, so a
    // replay after a crash can never show less than the user saw live.
    const liveActivity = (
      activityStore.upsert.mock.calls[0] as unknown as [{ payload: unknown }]
    )[0]
    const livePayload = liveActivity.payload as {
      output: string
      payloadTruncated?: boolean
      journal_truncation?: { fields: string[] }
    }
    expect(livePayload.output.length).toBeLessThan(2 * 1024 * 1024)
    expect(livePayload.output).toMatch(/^x+$/)
    expect(livePayload.payloadTruncated).toBe(true)
    expect(livePayload.journal_truncation?.fields).toEqual(["output"])
    const broadcastBig = broadcaster.frames.find(
      (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
        (frame as { channel?: unknown }).channel === "provider.runtimeEvent" &&
        (frame as { data: ProviderRuntimeEvent }).data.event_type ===
          "tool_result"
    )
    expect(
      (broadcastBig?.data.payload as { output: string }).output.length
    ).toBeLessThan(2 * 1024 * 1024)
    expect(JSON.parse(bigRow!.payload_json).payload.output).toBe(
      (broadcastBig?.data.payload as { output: string }).output
    )
    expect(
      projectionReceipts.markProjected.mock.calls.map((call) => call[0])
    ).toEqual([501, 502])
    expect(
      broadcaster.frames
        .filter(
          (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
            (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
        )
        .map((frame) => frame.data.event_type)
    ).toEqual(["tool_result", "tool_call"])
  })

  it("rethrows an ingestion failure for a terminal event so the hub can mark the turn uncertain", () => {
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger,
    })
    const failure = new Error("projection lane exploded")
    vi.spyOn(
      ingestion as unknown as { ingestEvent: () => void },
      "ingestEvent"
    ).mockImplementation(() => {
      throw failure
    })

    expect(() =>
      ingestion.ingest({
        event_type: "session.updated",
        thread_id: "thread-terminal-rethrow",
        payload: {},
      })
    ).not.toThrow()
    expect(() =>
      ingestion.ingest({
        event_type: "turn_completed",
        thread_id: "thread-terminal-rethrow",
        payload: { turn_id: "turn-1", status: "completed" },
      })
    ).toThrow(failure)
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it("flushes a 1 MB streamed response adaptively and keeps byte counters exact", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    // Mixed-width characters so byte length differs from string length.
    const delta = "é".repeat(256) + "x".repeat(512)
    const deltaBytes = Buffer.byteLength(delta, "utf8")
    const count = Math.ceil((1024 * 1024) / deltaBytes)
    for (let index = 0; index < count; index += 1) {
      ingestion.ingest({
        event_type: "content_delta",
        thread_id: "thread-stream",
        payload: { turn_id: "turn-1", delta },
      })
    }

    const transcript = (
      ingestion as unknown as {
        bufferedAssistantTranscripts: Map<
          string,
          { content: string; contentBytes: number; reasoningBytes: number }
        >
      }
    ).bufferedAssistantTranscripts.get("thread-stream:turn-1")
    expect(transcript).toBeDefined()
    expect(transcript!.contentBytes).toBe(
      Buffer.byteLength(transcript!.content, "utf8")
    )
    expect(transcript!.contentBytes).toBeGreaterThanOrEqual(1024 * 1024)
    // A fixed 16 KiB cadence would rewrite the row ~64 times for 1 MB.
    expect(upsertMessage.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(upsertMessage.mock.calls.length).toBeLessThanOrEqual(30)
  })

  it("retries a blocked journal event asynchronously and preserves later event order", async () => {
    vi.useFakeTimers()
    try {
      const broadcaster = makeBroadcaster()
      const logger = makeLogger()
      const persist = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 1")
        })
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 2")
        })
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 3")
        })
        .mockImplementation(() => undefined)
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        eventJournal: { persist },
        activityStore: { upsert: vi.fn() },
        broadcaster,
        logger,
        sequenceStart: 40,
        journalRetryBaseMs: 10,
        journalRetryMaxMs: 10,
      })
      const terminal: ProviderRuntimeEvent = {
        event_type: "turn_completed",
        thread_id: "thread-journal-retry",
        payload: { turn_id: "turn-1" },
      }
      const later: ProviderRuntimeEvent = {
        event_type: "session.updated",
        thread_id: "thread-journal-retry",
        payload: { status: "ready" },
      }

      ingestion.ingest(terminal)
      ingestion.ingest(later)

      expect(broadcaster.broadcast).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)

      const runtimeEvents = broadcaster.frames
        .filter(
          (frame): frame is { channel: string; data: ProviderRuntimeEvent } =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
        )
        .map((frame) => frame.data.event_type)
      expect(runtimeEvents).toEqual(["turn_completed", "session.updated"])
      expect(persist).toHaveBeenCalledWith(legacyJournalEntry(terminal), 41)
    } finally {
      vi.useRealTimers()
    }
  })

  it("spools a journal retry queue before graceful shutdown", () => {
    const enqueue = vi.fn(() => true)
    const event: ProviderRuntimeEvent = {
      event_type: "turn_completed",
      thread_id: "thread-shutdown-journal",
      payload: { turn_id: "turn-1" },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: {
        persist: vi.fn(() => {
          throw new Error("database remains locked")
        }),
      },
      journalRecoveryStore: { enqueue },
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 40,
    })

    ingestion.ingest(event)
    expect(() => ingestion.stop()).not.toThrow()

    expect(enqueue).toHaveBeenCalledWith(legacyJournalEntry(event), {
      projectionSequence: 41,
    })
  })

  it("spools every accepted event and stops intake when the retry queue reaches its count limit", () => {
    const enqueue = vi.fn(() => true)
    const fatal = vi.fn()
    const logger = makeLogger()
    const first: ProviderRuntimeEvent = {
      event_type: "content_delta",
      thread_id: "thread-overflow",
      payload: { turn_id: "turn-1", delta: "first" },
    }
    const overflow: ProviderRuntimeEvent = {
      event_type: "content_delta",
      thread_id: "thread-overflow",
      payload: { turn_id: "turn-1", delta: "second" },
    }
    const rejectedAfterStop: ProviderRuntimeEvent = {
      event_type: "turn_completed",
      thread_id: "thread-overflow",
      payload: { turn_id: "turn-1" },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: {
        persist: vi.fn(() => {
          throw new Error("database remains locked")
        }),
      },
      journalRecoveryStore: { enqueue },
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 40,
      journalQueueMaxEvents: 1,
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest(first)
    ingestion.ingest(overflow)
    ingestion.ingest(rejectedAfterStop)

    expect(enqueue.mock.calls).toEqual([
      [legacyJournalEntry(first), { projectionSequence: 41 }],
      [legacyJournalEntry(overflow), { projectionSequence: 42 }],
    ])
    expect(fatal).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "turn_completed" }),
      "provider runtime event rejected after journal intake stopped"
    )
    expect(() => ingestion.stop()).not.toThrow()
  })

  it("spools the current event instead of dropping it when the retry queue byte limit is exceeded", () => {
    const enqueue = vi.fn(() => true)
    const fatal = vi.fn()
    const event: ProviderRuntimeEvent = {
      event_type: "content_delta",
      thread_id: "thread-byte-overflow",
      payload: { turn_id: "turn-1", delta: "larger than one byte" },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: {
        persist: vi.fn(() => {
          throw new Error("database remains locked")
        }),
      },
      journalRecoveryStore: { enqueue },
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 50,
      journalQueueMaxBytes: 1,
      onFatalProjectionFailure: fatal,
    })

    ingestion.ingest(event)

    expect(enqueue).toHaveBeenCalledWith(legacyJournalEntry(event), {
      projectionSequence: 51,
    })
    expect(fatal).toHaveBeenCalledOnce()
    expect(() => ingestion.stop()).not.toThrow()
  })

  it("broadcasts streaming deltas immediately and snapshots them within 250ms", () => {
    vi.useFakeTimers()
    try {
      const eventJournal = { persist: vi.fn() }
      const upsertMessage = vi.fn()
      const broadcaster = makeBroadcaster()
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        eventJournal,
        activityStore: { upsert: vi.fn() },
        transcriptStore: { upsertMessage },
        broadcaster,
        logger: makeLogger(),
      })

      ingestion.ingest({
        event_type: "content_delta",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1", delta: "token" },
      })

      expect(eventJournal.persist).not.toHaveBeenCalled()
      expect(upsertMessage).not.toHaveBeenCalled()
      expect(broadcaster.broadcast).toHaveBeenCalledWith({
        channel: "provider.runtimeEvent",
        data: expect.objectContaining({ event_type: "content_delta" }),
      })

      vi.advanceTimersByTime(249)
      expect(upsertMessage).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(upsertMessage).toHaveBeenCalledWith({
        thread_id: "thread-1",
        message: expect.objectContaining({ content: "token" }),
      })
      ingestion.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("snapshots a streamed assistant transcript at the byte threshold", () => {
    const eventJournal = { persist: vi.fn() }
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal,
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptFlushBytes: 8,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-threshold",
      payload: { turn_id: "turn-1", delta: "12345678" },
    })

    expect(eventJournal.persist).not.toHaveBeenCalled()
    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-threshold",
      message: expect.objectContaining({ content: "12345678" }),
    })
    ingestion.stop()
  })

  it("persists streamed assistant text before broadcasting the terminal event", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-1",
        streamKind: "assistant_text",
        delta: "Hello ",
      },
    })
    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-1",
        streamKind: "assistant_text",
        delta: "world",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-1",
        status: "completed",
      },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-1",
      message: expect.objectContaining({
        message_id: "provider-assistant:thread-1:turn-1",
        turn_id: "turn-1",
        role: "assistant",
        content: "Hello world",
        extra: expect.objectContaining({
          providerKind: "codex",
          providerInstanceId: "codex-work",
        }),
      }),
    })
  })

  it.each([
    ["item.completed", { itemType: "assistantMessage" }],
    ["item_completed", { role: "assistant" }],
    ["item.completed", { kind: "agentMessage" }],
    [
      "tool_call",
      { tool_id: "read-1", tool_name: "Read", input: { path: "README.md" } },
    ],
  ])(
    "preserves paragraphs across %s without changing token chunks",
    (eventType, payload) => {
      const upsertMessage = vi.fn()
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        activityStore: { upsert: vi.fn() },
        transcriptStore: { upsertMessage },
        broadcaster: makeBroadcaster(),
        logger: makeLogger(),
      })
      const emit = (event_type: string, data: Record<string, unknown>) =>
        ingestion.ingest({
          event_type,
          thread_id: "paragraphs",
          payload: { turn_id: "turn-1", ...data },
        })
      emit("content_delta", { delta: "I will re" })
      emit("content_delta", { delta: "view the files." })
      emit(eventType, payload)
      emit("content_delta", { delta: "" })
      emit("content_delta", { delta: "## Findings\n\nCode uses `foo" })
      emit("content_delta", { delta: "bar()`." })
      emit("turn_completed", {})
      expect(upsertMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content:
              "I will review the files.\n\n## Findings\n\nCode uses `foobar()`.",
          }),
        })
      )
      ingestion.stop()
    }
  )

  it.each(["\n\n", "\r\n\r\n"])(
    "does not duplicate existing %j paragraph spacing",
    (newline) => {
      const upsertMessage = vi.fn()
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        activityStore: { upsert: vi.fn() },
        transcriptStore: { upsertMessage },
        broadcaster: makeBroadcaster(),
        logger: makeLogger(),
      })
      const emit = (event_type: string, payload: Record<string, unknown>) =>
        ingestion.ingest({
          event_type,
          thread_id: "paragraphs",
          payload: { turn_id: "turn-1", ...payload },
        })
      emit("content_delta", { delta: `First${newline}` })
      emit("item.completed", { itemType: "assistantMessage" })
      emit("content_delta", { delta: "Second" })
      emit("turn_completed", {})
      expect(upsertMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: `First${newline}Second`,
          }),
        })
      )
      ingestion.stop()
    }
  )

  it("restores an assistant boundary and ignores replayed events before adding the suffix", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        upsertMessage,
        getMessage: () => ({
          message_id: "provider-assistant:paragraphs:turn-1",
          turn_id: "turn-1",
          role: "assistant",
          content: "First.",
          created_at: "2026-09-14T12:00:00Z",
          extra: {
            providerRuntimeSequence: 10,
            assistantTextBoundaryPending: true,
          },
        }),
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    const delta = (text: string) =>
      legacyJournalEntry({
        event_type: "content_delta",
        thread_id: "paragraphs",
        payload: { turn_id: "turn-1", delta: text },
      })
    ingestion.replayPersisted(delta("First."), { projectionSequence: 9 })
    ingestion.replayPersisted(delta("Second."), { projectionSequence: 11 })
    ingestion.replayPersisted(delta("Second."), { projectionSequence: 11 })
    expect(upsertMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ content: "First.\n\nSecond." }),
      })
    )
    const extra = upsertMessage.mock.lastCall?.[0].message.extra
    expect(extra.assistantTextBoundaryPending).toBeUndefined()
    ingestion.stop()
  })

  it("honors empty text and reasoning replacement events", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    const base = {
      thread_id: "thread-replace",
      payload: { turn_id: "turn-replace" },
    }

    ingestion.ingest({
      ...base,
      event_type: "content_delta",
      payload: { ...base.payload, delta: "discard me" },
    })
    ingestion.ingest({
      ...base,
      event_type: "content_replace",
      payload: { ...base.payload, text: "" },
    })
    ingestion.ingest({
      ...base,
      event_type: "content_delta",
      payload: { ...base.payload, delta: "final" },
    })
    ingestion.ingest({
      ...base,
      event_type: "reasoning_delta",
      payload: { ...base.payload, delta: "old reasoning" },
    })
    ingestion.ingest({
      ...base,
      event_type: "reasoning_replace",
      payload: { ...base.payload, text: "new reasoning" },
    })
    ingestion.ingest({ ...base, event_type: "turn_completed" })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-replace",
      message: expect.objectContaining({
        content: "final",
        extra: expect.objectContaining({
          reasoning: "new reasoning",
          status: "completed",
          providerRuntimeSequence: expect.any(Number),
        }),
      }),
    })
  })

  it("bounds buffered assistant transcripts by UTF-8 byte size", () => {
    const upsertMessage = vi.fn()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger,
      assistantTranscriptMaxBytes: 10,
      bufferedAssistantTranscriptsMaxBytes: 20,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-bounded",
      payload: { turn_id: "turn-bounded", delta: "1234567890overflow" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-bounded",
      payload: { turn_id: "turn-bounded" },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-bounded",
      message: expect.objectContaining({ content: "1234567890" }),
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
      "assistant transcript exceeded its byte limit and was truncated"
    )
  })

  it("prioritizes visible assistant content over previously buffered reasoning", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 10,
    })

    ingestion.ingest({
      event_type: "reasoning_delta",
      thread_id: "thread-priority",
      payload: { turn_id: "turn-priority", delta: "1234567890" },
    })
    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-priority",
      payload: { turn_id: "turn-priority", delta: "answer" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-priority",
      payload: { turn_id: "turn-priority" },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-priority",
      message: expect.objectContaining({
        content: "answer",
        extra: expect.objectContaining({ reasoning: "1234" }),
      }),
    })
  })

  it("persists reasoning-only assistant turns", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "reasoning_delta",
      thread_id: "thread-reasoning-only",
      payload: { turn_id: "turn-reasoning-only", delta: "private reasoning" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-reasoning-only",
      payload: { turn_id: "turn-reasoning-only" },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-reasoning-only",
      message: expect.objectContaining({
        content: "",
        extra: expect.objectContaining({ reasoning: "private reasoning" }),
      }),
    })
  })

  it("persists tool-only assistant turns with their final result", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "tool_call",
      thread_id: "thread-tool-only",
      payload: {
        turn_id: "turn-tool-only",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        tool_id: "tool-1",
        tool_name: "exec_command",
        input: { command: "npm test" },
        createdAt: "2026-07-11T02:00:00.000Z",
      },
    })
    ingestion.ingest({
      event_type: "tool_result",
      thread_id: "thread-tool-only",
      payload: {
        turn_id: "turn-tool-only",
        tool_id: "tool-1",
        output: "all tests passed",
        createdAt: "2026-07-11T02:00:01.000Z",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-tool-only",
      payload: { turn_id: "turn-tool-only" },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-tool-only",
      message: expect.objectContaining({
        content: "",
        extra: expect.objectContaining({
          toolCalls: [
            expect.objectContaining({
              id: "tool-1",
              name: "exec_command",
              input: { command: "npm test" },
              output: "all tests passed",
              state: "output-available",
              providerKind: "codex",
              providerInstanceId: "codex-work",
              turnId: "turn-tool-only",
            }),
          ],
        }),
      }),
    })
  })

  it("keeps the first real tool name and carries later ACP titles separately", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    // Grok's ACP: the first event names the tool, every later event retitles
    // it — and for a search the title is the pattern itself.
    ingestion.ingest({
      event_type: "item.started",
      thread_id: "thread-acp-title",
      payload: {
        turn_id: "turn-acp-title",
        providerKind: "grok_cli",
        itemId: "call-1",
        itemType: "dynamic_tool_call",
        title: "grep",
        data: { rawInput: { pattern: "readFile", path: "C:\\repo\\src" } },
        createdAt: "2026-09-16T20:00:00.000Z",
      },
    })
    ingestion.ingest({
      event_type: "item.completed",
      thread_id: "thread-acp-title",
      payload: {
        turn_id: "turn-acp-title",
        providerKind: "grok_cli",
        itemId: "call-1",
        itemType: "dynamic_tool_call",
        title: "readFile",
        data: {
          kind: "search",
          rawInput: {
            variant: "Grep",
            pattern: "readFile",
            path: "C:\\repo\\src",
          },
          content: [
            {
              type: "content",
              content: { type: "text", text: "found 0 matches" },
            },
          ],
        },
        createdAt: "2026-09-16T20:00:01.000Z",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-acp-title",
      payload: { turn_id: "turn-acp-title" },
    })

    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-acp-title",
      message: expect.objectContaining({
        extra: expect.objectContaining({
          toolCalls: [
            expect.objectContaining({
              id: "call-1",
              name: "grep",
              title: "readFile",
              kind: "search",
              state: "output-available",
            }),
          ],
        }),
      }),
    })
  })

  it("does not overwrite an evicted transcript prefix with later tail deltas", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 100,
      bufferedAssistantTranscriptsMaxBytes: 6,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-evicted",
      payload: { turn_id: "turn-evicted", delta: "prefix!" },
    })
    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-evicted",
      payload: { turn_id: "turn-evicted", delta: "tail" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-evicted",
      payload: { turn_id: "turn-evicted" },
    })

    expect(upsertMessage).toHaveBeenCalledTimes(1)
    expect(upsertMessage).toHaveBeenCalledWith({
      thread_id: "thread-evicted",
      message: expect.objectContaining({ content: "prefix!" }),
    })
  })

  it("retains eviction protection after the bounded tombstone LRU rotates", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 100,
      bufferedAssistantTranscriptsMaxBytes: 5,
      evictedAssistantTranscriptMaxKeys: 1,
    })

    for (const suffix of ["a", "b"]) {
      ingestion.ingest({
        event_type: "content_delta",
        thread_id: `thread-${suffix}`,
        payload: { turn_id: `turn-${suffix}`, delta: `prefix-${suffix}` },
      })
    }
    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-a",
      payload: { turn_id: "turn-a", delta: "late-tail" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-a",
      payload: { turn_id: "turn-a" },
    })

    expect(upsertMessage).toHaveBeenCalledTimes(2)
    expect(upsertMessage).toHaveBeenNthCalledWith(1, {
      thread_id: "thread-a",
      message: expect.objectContaining({ content: "prefix-a" }),
    })
  })

  it("retries a failed terminal transcript flush automatically with bounded backoff", () => {
    vi.useFakeTimers()
    const upsertMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("database busy")
      })
      .mockImplementationOnce(() => undefined)
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptRetryBaseMs: 10,
      assistantTranscriptRetryMaxMs: 20,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-retry",
      payload: { turn_id: "turn-retry", delta: "durable after retry" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-retry",
      payload: { turn_id: "turn-retry" },
    })
    expect(upsertMessage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10)

    expect(upsertMessage).toHaveBeenCalledTimes(2)
    expect(upsertMessage).toHaveBeenLastCalledWith({
      thread_id: "thread-retry",
      message: expect.objectContaining({ content: "durable after retry" }),
    })
    ingestion.stop()
    vi.useRealTimers()
  })

  it("transfers a terminal transcript to the durable recovery spool after retries", () => {
    vi.useFakeTimers()
    try {
      const enqueue = vi.fn(() => true)
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        activityStore: { upsert: vi.fn() },
        transcriptStore: {
          upsertMessage: () => {
            throw new Error("database remains unavailable")
          },
        },
        transcriptRecoveryStore: { enqueue },
        broadcaster: makeBroadcaster(),
        logger: makeLogger(),
        assistantTranscriptRetryBaseMs: 10,
        assistantTranscriptRetryMaxMs: 10,
        assistantTranscriptRetryMaxAttempts: 1,
      })

      ingestion.ingest({
        event_type: "content_delta",
        thread_id: "thread-spool",
        payload: { turn_id: "turn-spool", delta: "recover me" },
      })
      ingestion.ingest({
        event_type: "turn_completed",
        thread_id: "thread-spool",
        payload: { turn_id: "turn-spool" },
      })
      expect(enqueue).not.toHaveBeenCalled()

      vi.advanceTimersByTime(10)

      expect(enqueue).toHaveBeenCalledWith(
        {
          thread_id: "thread-spool",
          message: expect.objectContaining({
            message_id: providerAssistantMessageId(
              "thread-spool",
              "turn-spool"
            ),
            role: "assistant",
            content: "recover me",
          }),
        },
        { reason: "retry_exhausted", truncated: false }
      )
      const state = ingestion as unknown as {
        bufferedAssistantTranscripts: Map<string, unknown>
      }
      expect(state.bufferedAssistantTranscripts.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("spools an uncommitted terminal transcript during shutdown", () => {
    const enqueue = vi.fn(() => true)
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        upsertMessage: () => {
          throw new Error("database unavailable during shutdown")
        },
      },
      transcriptRecoveryStore: { enqueue },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-shutdown-spool",
      payload: { turn_id: "turn-1", delta: "shutdown recovery" },
    })
    ingestion.stop()

    expect(enqueue).toHaveBeenCalledWith(
      {
        thread_id: "thread-shutdown-spool",
        message: expect.objectContaining({ content: "shutdown recovery" }),
      },
      { reason: "shutdown", truncated: false }
    )
  })

  it("reports fatal durability failure when shutdown cannot persist or spool", () => {
    const onFatalDurabilityFailure = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        upsertMessage: () => {
          throw new Error("database unavailable during shutdown")
        },
      },
      transcriptRecoveryStore: { enqueue: () => false },
      onFatalDurabilityFailure,
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-shutdown-fatal",
      payload: { turn_id: "turn-1", delta: "must not disappear silently" },
    })
    ingestion.stop()

    expect(onFatalDurabilityFailure).toHaveBeenCalledWith(expect.any(Error), {
      threadId: "thread-shutdown-fatal",
      turnId: "turn-1",
    })
  })

  it("persists an explicit marker when transcript content is truncated", () => {
    const upsertMessage = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 5,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-truncated",
      payload: { turn_id: "turn-1", delta: "123456" },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-truncated",
      payload: { turn_id: "turn-1" },
    })

    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          content: "12345",
          extra: expect.objectContaining({ transcriptTruncated: true }),
        }),
      })
    )
  })

  it("spools a bounded partial transcript before hard-memory eviction", () => {
    const enqueue = vi.fn(() => true)
    const onFatalDurabilityFailure = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: {
        upsertMessage: () => {
          throw new Error("database busy")
        },
      },
      transcriptRecoveryStore: { enqueue },
      onFatalDurabilityFailure,
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 100,
      bufferedAssistantTranscriptsMaxBytes: 5,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-memory-spool",
      payload: { turn_id: "turn-memory", delta: "123456" },
    })

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-memory-spool",
        message: expect.objectContaining({ content: "123456" }),
      }),
      { reason: "memory_pressure", truncated: false }
    )
    expect(onFatalDurabilityFailure).not.toHaveBeenCalled()
  })

  it("reports a fatal durability failure when SQLite and the spool both fail", () => {
    vi.useFakeTimers()
    try {
      const onFatalDurabilityFailure = vi.fn()
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        activityStore: { upsert: vi.fn() },
        transcriptStore: {
          upsertMessage: () => {
            throw new Error("database unavailable")
          },
        },
        transcriptRecoveryStore: { enqueue: () => false },
        onFatalDurabilityFailure,
        broadcaster: makeBroadcaster(),
        logger: makeLogger(),
        assistantTranscriptRetryBaseMs: 10,
        assistantTranscriptRetryMaxMs: 10,
        assistantTranscriptRetryMaxAttempts: 1,
      })
      ingestion.ingest({
        event_type: "content_delta",
        thread_id: "thread-fatal",
        payload: { turn_id: "turn-fatal", delta: "cannot persist" },
      })
      ingestion.ingest({
        event_type: "turn_completed",
        thread_id: "thread-fatal",
        payload: { turn_id: "turn-fatal" },
      })

      vi.advanceTimersByTime(10)

      expect(onFatalDurabilityFailure).toHaveBeenCalledWith(expect.any(Error), {
        threadId: "thread-fatal",
        turnId: "turn-fatal",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("enforces the hard assistant buffer limit even when persistence fails", () => {
    const upsertMessage = vi.fn(() => {
      throw new Error("database busy")
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      transcriptStore: { upsertMessage },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      assistantTranscriptMaxBytes: 100,
      bufferedAssistantTranscriptsMaxBytes: 5,
      evictedAssistantTranscriptMaxKeys: 2,
    })

    for (let index = 0; index < 3; index += 1) {
      ingestion.ingest({
        event_type: "content_delta",
        thread_id: `thread-hard-limit-${index}`,
        payload: { turn_id: `turn-${index}`, delta: "123456" },
      })
    }

    const state = ingestion as unknown as {
      bufferedAssistantTranscriptBytes: number
      bufferedAssistantTranscripts: Map<string, unknown>
      evictedAssistantTranscriptKeys: Set<string>
    }
    expect(state.bufferedAssistantTranscriptBytes).toBe(0)
    expect(state.bufferedAssistantTranscripts.size).toBe(0)
    expect(state.evictedAssistantTranscriptKeys.size).toBe(2)
  })

  it("persists projected thread activities and broadcasts provider events", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 10,
    })

    const event = toolCallEvent()
    ingestion.ingest(event)

    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({
      activity_id: "thread-1::tool.started::tool-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      provider_instance_id: "codex-work",
      kind: "tool.started",
      tone: "tool",
      summary: "Ran command: npm test",
      sequence: 11,
    })
    expect(broadcaster.frames).toEqual([
      expect.objectContaining({
        channel: "thread.activity",
        data: expect.objectContaining({
          id: "thread-1::tool.started::tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
          providerInstanceId: "codex-work",
          kind: "tool.started",
          summary: "Ran command: npm test",
          sequence: 11,
        }),
      }),
      {
        channel: "provider.runtimeEvent",
        data: event,
      },
    ])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "provider.runtimeEvent",
        event: "tool_call",
        thread: "thread-1",
        turn: "turn-1",
        provider: "codex",
        instance: "codex-work",
        tool: "exec_command",
        clients: 2,
      }),
      "tool started"
    )
  })

  it("persists tool denials as inspectable nonterminal activities", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const markCompletedByProviderTurn = vi.fn()
    const markFailedByProviderTurn = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      chatDispatchLifecycleStore: {
        hasProviderTurn: vi.fn(() => true),
        markCompletedByProviderTurn,
        markFailedByProviderTurn,
      },
      broadcaster,
      logger,
      sequenceStart: 20,
    })
    const event: ProviderRuntimeEvent = {
      event_type: "tool.denied",
      thread_id: "thread-1",
      payload: {
        providerKind: "claude",
        providerInstanceId: "claude-work",
        event_id: "event-denied-1",
        created_at: "2026-05-11T10:00:00.000Z",
        turn_id: "turn-1",
        tool_id: "tool-1",
        tool_name: "Edit",
        reason: "Path is outside the workspace",
        detail: "Path is outside the workspace",
      },
    }

    ingestion.ingest(event)

    expect(activities).toEqual([
      expect.objectContaining({
        activity_id: "thread-1::tool.denied::event-denied-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        provider_instance_id: "claude-work",
        kind: "tool.denied",
        tone: "error",
        summary: "Tool denied: Edit",
        sequence: 21,
        created_at: "2026-05-11T10:00:00.000Z",
        payload: expect.objectContaining({
          eventType: "tool.denied",
          toolId: "tool-1",
          toolName: "Edit",
          reason: "Path is outside the workspace",
          detail: "Path is outside the workspace",
        }),
      }),
    ])
    expect(markCompletedByProviderTurn).not.toHaveBeenCalled()
    expect(markFailedByProviderTurn).not.toHaveBeenCalled()
    expect(broadcaster.frames).toEqual([
      expect.objectContaining({
        channel: "thread.activity",
        data: expect.objectContaining({
          id: "thread-1::tool.denied::event-denied-1",
          kind: "tool.denied",
          tone: "error",
          summary: "Tool denied: Edit",
        }),
      }),
      { channel: "provider.runtimeEvent", data: event },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool.denied",
        thread: "thread-1",
        turn: "turn-1",
        provider: "claude",
        instance: "claude-work",
        tool: "Edit",
      }),
      "tool denied"
    )
  })

  it("keeps token streaming logs quiet but logs reasoning start once", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      broadcaster,
      logger,
      sequenceStart: 20,
    })

    ingestion.ingest({
      event_type: "content_delta",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1", delta: "hello" },
    })
    ingestion.ingest({
      event_type: "reasoning_delta",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1", delta: "thinking" },
    })
    ingestion.ingest({
      event_type: "reasoning_delta",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1", delta: " more" },
    })

    expect(broadcaster.broadcast).toHaveBeenCalledTimes(3)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "provider.runtimeEvent",
        event: "reasoning_delta",
        thread: "thread-1",
        turn: "turn-1",
      }),
      "reasoning started"
    )
  })

  it("finalizes buffered proposed-plan deltas on turn completion", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "# Plan\n",
      },
    })
    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "- step 1",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
      },
    })

    const completedPlans = activities.filter(
      (activity) => activity.kind === "turn.proposed.completed"
    )
    expect(completedPlans).toHaveLength(1)
    expect(completedPlans[0]).toMatchObject({
      activity_id:
        "thread-1::turn.proposed.completed::plan:thread-1:turn:turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      provider_instance_id: "claude-main",
      payload: {
        planId: "plan:thread-1:turn:turn-1",
        planMarkdown: "# Plan\n- step 1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
      },
    })
  })

  it("restores a durable proposed-plan prefix before replaying a missing delta", () => {
    const projected: ThreadActivityProjection[] = []
    const durablePrefix: ThreadActivityProjection = {
      activity_id: "plan-prefix",
      thread_id: "thread-plan-prefix",
      turn_id: "turn-1",
      provider_instance_id: "claude-main",
      kind: "turn.proposed.delta",
      tone: "info",
      summary: "Plan draft updated",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "# Plan\n",
      },
      sequence: 100,
      created_at: "2026-07-11T04:00:00.000Z",
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: {
        upsert: (activity) => projected.push(activity),
        listByThread: () => [durablePrefix],
      },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1_000,
    })

    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "turn.proposed.delta",
        thread_id: "thread-plan-prefix",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          turn_id: "turn-1",
          delta: "- recovered step",
        },
      }),
      { projectionSequence: 101 }
    )
    ingestion.replayPersisted(
      legacyJournalEntry({
        event_type: "turn.proposed.completed",
        thread_id: "thread-plan-prefix",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          turn_id: "turn-1",
        },
      }),
      { projectionSequence: 102 }
    )

    expect(
      projected.find((activity) => activity.kind === "turn.proposed.completed")
        ?.payload
    ).toMatchObject({ planMarkdown: "# Plan\n- recovered step" })
  })

  it("bounds proposed plans by per-entry and global UTF-8 bytes", () => {
    const activities: ThreadActivityProjection[] = []
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 28,
      proposedPlanMaxBytes: 8,
      bufferedProposedPlansMaxBytes: 12,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-plan-a",
      payload: { turn_id: "turn-a", delta: "1234567890" },
    })
    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-plan-b",
      payload: { turn_id: "turn-b", delta: "abcdefgh" },
    })

    const state = ingestion as unknown as {
      bufferedProposedPlanBytes: number
      bufferedProposedPlans: Map<string, { text: string; bytes: number }>
    }
    expect(state.bufferedProposedPlanBytes).toBeLessThanOrEqual(12)
    expect(state.bufferedProposedPlans.has("thread-plan-a:turn-a")).toBe(false)
    expect(
      state.bufferedProposedPlans.get("thread-plan-b:turn-b")
    ).toMatchObject({
      text: "abcdefgh",
      bytes: 8,
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 8 }),
      "proposed plan exceeded its byte limit and was truncated"
    )
  })

  it("keys proposed-plan buffers by turn before item id", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 30,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "codex",
        providerInstanceId: "codex-work",
        itemId: "plan-item-1",
        turn_id: "turn-1",
        delta: "# Plan\n",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-1",
      },
    })

    const completedPlans = activities.filter(
      (activity) => activity.kind === "turn.proposed.completed"
    )
    expect(completedPlans).toHaveLength(1)
    expect(completedPlans[0]).toMatchObject({
      activity_id:
        "thread-1::turn.proposed.completed::plan:thread-1:turn:turn-1",
      payload: {
        itemId: "plan-item-1",
        planId: "plan:thread-1:turn:turn-1",
        planMarkdown: "# Plan",
      },
    })
  })

  it("uses buffered proposed-plan deltas when a completion event arrives before turn completion", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "# Draft",
      },
    })
    ingestion.ingest({
      event_type: "turn.proposed.completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        planMarkdown: "# Final",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
      },
    })

    const completedPlans = activities.filter(
      (activity) => activity.kind === "turn.proposed.completed"
    )
    expect(completedPlans).toHaveLength(1)
    expect(completedPlans[0]?.payload).toMatchObject({
      planMarkdown: "# Draft",
    })
  })

  it("uses direct proposed-plan completion payloads when no deltas were buffered", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 35,
    })

    ingestion.ingest({
      event_type: "turn.proposed.completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        planMarkdown: "# Direct",
      },
    })

    const completedPlans = activities.filter(
      (activity) => activity.kind === "turn.proposed.completed"
    )
    expect(completedPlans).toHaveLength(1)
    expect(completedPlans[0]).toMatchObject({
      activity_id:
        "thread-1::turn.proposed.completed::plan:thread-1:turn:turn-1",
      sequence: 36,
      payload: {
        planId: "plan:thread-1:turn:turn-1",
        planMarkdown: "# Direct",
      },
    })
  })

  it("does not create empty proposed-plan cards from empty buffered completions", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 45,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "   ",
      },
    })
    ingestion.ingest({
      event_type: "turn.proposed.completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        planMarkdown: "   ",
      },
    })

    expect(
      activities.filter(
        (activity) => activity.kind === "turn.proposed.completed"
      )
    ).toEqual([])
  })

  it("clears buffered proposed-plan deltas when a provider session exits", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 55,
    })

    ingestion.ingest({
      event_type: "turn.proposed.delta",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        delta: "# Stale plan",
      },
    })
    ingestion.ingest({
      event_type: "session.exited",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
      },
    })

    expect(
      activities.filter(
        (activity) => activity.kind === "turn.proposed.completed"
      )
    ).toEqual([])
  })

  it("persists thread metadata updates as thread title changes", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const updateThreadTitle = vi.fn()
    const event: ProviderRuntimeEvent = {
      event_type: "thread.metadata.updated",
      thread_id: "thread-1",
      payload: {
        name: "Renamed by provider",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      threadMetadataStore: { updateThreadTitle },
      broadcaster,
      logger,
      sequenceStart: 20,
    })

    ingestion.ingest(event)

    expect(updateThreadTitle).toHaveBeenCalledWith(
      "thread-1",
      "Renamed by provider",
      "2026-05-13T00:00:00.000Z"
    )
    expect(broadcaster.frames).toEqual([
      {
        channel: "provider.runtimeEvent",
        data: event,
      },
    ])
  })

  it("persists turn lifecycle as provider session state", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const updateSessionLifecycle = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: { updateSessionLifecycle },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "turn_started",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
      },
    })
    ingestion.ingest({
      event_type: "turn_error",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        error: "model failed",
      },
    })

    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "running",
      activeTurnId: "turn-1",
    })
    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "error",
      activeTurnId: null,
      lastError: "Provider turn failed.",
    })
  })

  it("accepts Claude lifecycle events when the provider instance is a placeholder", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    let current = {
      activeTurnId: null as string | null,
      lastError: null as string | null,
      runtimeMode: "approval-required",
    }
    const updateSessionLifecycle = vi.fn(
      (next: {
        readonly activeTurnId?: string | null
        readonly lastError?: string | null
        readonly runtimeMode?: string | null
      }) => {
        current = {
          ...current,
          activeTurnId:
            next.activeTurnId !== undefined
              ? next.activeTurnId
              : current.activeTurnId,
          lastError:
            next.lastError !== undefined ? next.lastError : current.lastError,
          runtimeMode: next.runtimeMode ?? current.runtimeMode,
        }
      }
    )
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => current),
        updateSessionLifecycle,
      },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "turn_started",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        turn_id: "turn-claude-placeholder",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        turn_id: "turn-claude-placeholder",
        status: "completed",
      },
    })

    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude",
      status: "running",
      activeTurnId: "turn-claude-placeholder",
    })
    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude",
      status: "ready",
      activeTurnId: null,
      lastError: null,
    })
  })

  it("marks a source proposed plan implemented after the target provider turn starts", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const sourceProposedPlanImplementations =
      new InMemoryPendingSourceProposedPlanImplementationStore()
    sourceProposedPlanImplementations.recordPending({
      sourceProposedPlan: {
        threadId: "thread-plan",
        planId: "plan-1",
      },
      implementationThreadId: "thread-implementation",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      acceptedTurnId: "turn-1",
    })

    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      sessionLifecycleStore: {
        get: vi.fn(() => ({ activeTurnId: null })),
        updateSessionLifecycle: vi.fn(),
      },
      sourceProposedPlanImplementations,
      broadcaster,
      logger,
      sequenceStart: 100,
    })

    ingestion.ingest({
      event_type: "turn_started",
      thread_id: "thread-implementation",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    })

    const implemented = activities.find(
      (activity) => activity.kind === "turn.proposed.implemented"
    )
    expect(implemented).toMatchObject({
      activity_id:
        "thread-plan::turn.proposed.implemented::plan-1::thread-implementation",
      thread_id: "thread-plan",
      provider_instance_id: "claude-main",
      kind: "turn.proposed.implemented",
      tone: "info",
      summary: "Plan implemented",
      sequence: 102,
      created_at: "2026-05-13T00:00:00.000Z",
      payload: {
        sourceProposedPlan: {
          threadId: "thread-plan",
          planId: "plan-1",
        },
        implementationThreadId: "thread-implementation",
        implementedAt: "2026-05-13T00:00:00.000Z",
        providerKind: "claude",
        providerInstanceId: "claude-main",
      },
    })
    expect(
      sourceProposedPlanImplementations.consumePending({
        implementationThreadId: "thread-implementation",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        acceptedTurnId: "turn-1",
      })
    ).toBeNull()
  })

  it("does not mark source proposed plans implemented for stale turn starts", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const sourceProposedPlanImplementations =
      new InMemoryPendingSourceProposedPlanImplementationStore()
    sourceProposedPlanImplementations.recordPending({
      sourceProposedPlan: {
        threadId: "thread-plan",
        planId: "plan-1",
      },
      implementationThreadId: "thread-implementation",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      acceptedTurnId: "turn-active",
    })
    const updateSessionLifecycle = vi.fn()

    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      sessionLifecycleStore: {
        get: vi.fn(() => ({ activeTurnId: "turn-active" })),
        updateSessionLifecycle,
      },
      sourceProposedPlanImplementations,
      broadcaster,
      logger,
      sequenceStart: 100,
    })

    ingestion.ingest({
      event_type: "turn_started",
      thread_id: "thread-implementation",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-stale",
      },
    })

    expect(
      activities.some(
        (activity) => activity.kind === "turn.proposed.implemented"
      )
    ).toBe(false)
    expect(updateSessionLifecycle).not.toHaveBeenCalled()
    expect(
      sourceProposedPlanImplementations.consumePending({
        implementationThreadId: "thread-implementation",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        acceptedTurnId: "turn-active",
      })
    ).toMatchObject({
      sourceProposedPlan: {
        threadId: "thread-plan",
        planId: "plan-1",
      },
    })
  })

  it("guards stale turn completions against the active provider turn", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const current = {
      activeTurnId: "turn-2",
      lastError: null,
      runtimeMode: "full-access",
    }
    const updateSessionLifecycle = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => current),
        updateSessionLifecycle,
      },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
      },
    })
    ingestion.ingest({
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-2",
      },
    })

    expect(updateSessionLifecycle).toHaveBeenCalledTimes(1)
    expect(updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "ready",
      activeTurnId: null,
      lastError: null,
    })
  })

  it("preserves active turn state on late session starts and stops on session exit", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    let current = {
      activeTurnId: "turn-1" as string | null,
      lastError: "previous failure" as string | null,
      runtimeMode: "full-access",
    }
    const updateSessionLifecycle = vi.fn(
      (next: {
        readonly activeTurnId?: string | null
        readonly lastError?: string | null
        readonly runtimeMode?: string | null
      }) => {
        current = {
          ...current,
          activeTurnId:
            next.activeTurnId !== undefined
              ? next.activeTurnId
              : current.activeTurnId,
          lastError:
            next.lastError !== undefined ? next.lastError : current.lastError,
          runtimeMode: next.runtimeMode ?? current.runtimeMode,
        }
      }
    )
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => current),
        updateSessionLifecycle,
      },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "thread.started",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
      },
    })
    ingestion.ingest({
      event_type: "session.started",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
      },
    })
    ingestion.ingest({
      event_type: "session.exited",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
      },
    })

    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "running",
      activeTurnId: "turn-1",
    })
    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "running",
      activeTurnId: "turn-1",
    })
    expect(updateSessionLifecycle).toHaveBeenNthCalledWith(3, {
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "stopped",
      activeTurnId: null,
    })
  })

  it("guards stale runtime errors while accepting unscoped provider failures", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const current = {
      activeTurnId: "turn-2",
      lastError: null,
      runtimeMode: "full-access",
    }
    const updateSessionLifecycle = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      sessionLifecycleStore: {
        get: vi.fn(() => current),
        updateSessionLifecycle,
      },
      broadcaster,
      logger,
      sequenceStart: 25,
    })

    ingestion.ingest({
      event_type: "runtime.error",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        turn_id: "turn-1",
        message: "stale failure",
      },
    })
    ingestion.ingest({
      event_type: "runtime.error",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        message: "process died",
      },
    })

    expect(updateSessionLifecycle).toHaveBeenCalledTimes(1)
    expect(updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "error",
      activeTurnId: null,
      lastError: "Provider runtime error.",
    })
  })

  it("records canonical runtime warning and error activities from typed payloads", () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 60,
    })

    ingestion.ingest({
      event_type: "runtime.warning",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        event_id: "evt-warning",
        turn_id: "turn-1",
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    })
    ingestion.ingest({
      event_type: "runtime.error",
      thread_id: "thread-1",
      payload: {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        event_id: "evt-error",
        turn_id: "turn-1",
        message: "Runtime still processed",
        class: "transport_error",
      },
    })

    expect(activities).toEqual([
      expect.objectContaining({
        activity_id: "thread-1::runtime.warning::evt-warning",
        turn_id: "turn-1",
        provider_instance_id: "claude-main",
        kind: "runtime.warning",
        summary: "Provider runtime warning",
        payload: expect.objectContaining({
          providerKind: "claude",
          event_id: "evt-warning",
          turn_id: "turn-1",
        }),
      }),
      expect.objectContaining({
        activity_id: "thread-1::runtime.error::evt-error",
        turn_id: "turn-1",
        provider_instance_id: "claude-main",
        kind: "runtime.error",
        summary: "Provider runtime error",
        payload: expect.objectContaining({
          providerKind: "claude",
          class: "transport_error",
          event_id: "evt-error",
          turn_id: "turn-1",
        }),
      }),
    ])
    expect(
      broadcaster.frames.filter(
        (frame) =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { channel?: unknown }).channel === "thread.activity"
      )
    ).toHaveLength(2)
  })

  it("still broadcasts provider events when activity persistence fails", () => {
    const broadcaster = makeBroadcaster(1)
    const logger = makeLogger()
    const event = toolCallEvent()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: {
        upsert: () => {
          throw new Error("sqlite is busy")
        },
      },
      broadcaster,
      logger,
      sequenceStart: 20,
    })

    ingestion.ingest(event)

    expect(broadcaster.frames).toEqual([
      {
        channel: "provider.runtimeEvent",
        data: event,
      },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: "thread-1",
        kind: "tool.started",
      }),
      "failed to persist provider thread activity"
    )
  })

  it("persists checkpoint diff events without blocking broadcast", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const checkpointDiffStore = { recordRuntimeEvent: vi.fn() }
    const event: ProviderRuntimeEvent = {
      event_type: "turn.diff.updated",
      thread_id: "thread-1",
      payload: {
        turn_index: 1,
        checkpointRef: "refs/betterc0de/checkpoints/thread/turn/1",
        unifiedDiff:
          "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: () => {} },
      checkpointDiffStore,
      broadcaster,
      logger,
      sequenceStart: 40,
    })

    ingestion.ingest(event)

    expect(checkpointDiffStore.recordRuntimeEvent).toHaveBeenCalledWith(event)
    expect(broadcaster.frames).toContainEqual({
      channel: "provider.runtimeEvent",
      data: event,
    })
  })

  it("still broadcasts provider events when checkpoint diff persistence fails", () => {
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const event: ProviderRuntimeEvent = {
      event_type: "turn.diff.updated",
      thread_id: "thread-1",
      payload: {
        turn_index: 1,
        checkpointRef: "refs/betterc0de/checkpoints/thread/turn/1",
        unifiedDiff:
          "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: () => {} },
      checkpointDiffStore: {
        recordRuntimeEvent: () => {
          throw new Error("sqlite is busy")
        },
      },
      broadcaster,
      logger,
      sequenceStart: 50,
    })

    ingestion.ingest(event)

    expect(broadcaster.frames).toContainEqual({
      channel: "provider.runtimeEvent",
      data: event,
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "turn.diff.updated",
        thread: "thread-1",
      }),
      "failed to persist provider checkpoint diff"
    )
  })

  it("continues processing runtime events after one ingestion handler throws", () => {
    const eventBus = new EventEmitter()
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const lifecycleUpdates: Array<{
      threadId: string
      providerInstanceId: string
      status: string
      activeTurnId?: string | null
      lastError?: string | null
    }> = []
    const ingestion = new ProviderRuntimeIngestion({
      eventBus,
      activityStore: { upsert: () => {} },
      sessionLifecycleStore: {
        get: () => ({ activeTurnId: null }),
        updateSessionLifecycle: (input) => lifecycleUpdates.push(input),
      },
      sourceProposedPlanImplementations: {
        recordPending: vi.fn(),
        clearPending: vi.fn(),
        clearAll: vi.fn(() => 0),
        peekPending: () => {
          throw new Error("pending store unavailable")
        },
        ackPending: vi.fn(),
      },
      broadcaster,
      logger,
      sequenceStart: 90,
    })
    ingestion.start()

    const failingEvent: ProviderRuntimeEvent = {
      event_type: "turn.started",
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-fails-in-sidecar",
      },
    }
    const followUpEvent: ProviderRuntimeEvent = {
      event_type: "runtime.error",
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turn_id: "turn-after-failure",
        message: "runtime still processed",
      },
    }

    expect(() => eventBus.emit("event", failingEvent)).not.toThrow()
    eventBus.emit("event", followUpEvent)
    ingestion.stop()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "turn.started",
        thread: "thread-1",
      }),
      "failed to read accepted source-plan implementation link"
    )
    expect(lifecycleUpdates).toContainEqual(
      expect.objectContaining({
        threadId: "thread-1",
        providerInstanceId: "codex-work",
        status: "error",
        activeTurnId: "turn-after-failure",
        lastError: "Provider runtime error.",
      })
    )
    expect(broadcaster.frames).toContainEqual({
      channel: "provider.runtimeEvent",
      data: followUpEvent,
    })
  })

  it("subscribes and unsubscribes from the provider event bus", () => {
    const bus = new EventEmitter()
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      activityStore: { upsert: () => {} },
      broadcaster,
      logger,
      sequenceStart: 30,
    })
    const stop = ingestion.start()

    bus.emit("event", toolCallEvent())
    stop()
    bus.emit("event", toolCallEvent({ thread_id: "thread-2" }))

    expect(
      broadcaster.frames.filter(
        (frame) =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { channel?: unknown }).channel === "provider.runtimeEvent"
      )
    ).toHaveLength(1)
  })
})

/**
 * Goldens for what the user saw when the canonical fixture corpus went
 * through the old production path (`canonicalToLegacy` in front of the bus,
 * then `ingest`) — the step-0 reference the post-journal bridge is held to.
 * Activities, broadcast frames, journal rows and dispatch lifecycle calls are
 * pinned as literals. Declined fixtures are invisible here: the bridge drops
 * them before the bus, so they consume no sequence on this path (the
 * canonical path journals them and does; see the parity test).
 */
describe("canonical fixtures through the legacy bridge path (goldens)", () => {
  const GOLDEN_ACTIVITY_ROWS: ReadonlyArray<
    [string, string, string | null, string, number, string, string]
  > = [
    [
      "turn.started",
      "thread-fixture::turn.started::turn-1",
      "turn-1",
      "thinking",
      101,
      "2026-09-11T12:00:00.000Z",
      "Turn started",
    ],
    [
      "tool.started",
      "thread-fixture::tool.started::tool-1",
      "turn-1",
      "tool",
      103,
      "1970-01-01T00:00:01.002Z",
      "Ran command: npm test",
    ],
    [
      "tool.updated",
      "thread-fixture::tool.updated::tool-1",
      "turn-1",
      "tool",
      104,
      "2026-09-11T12:00:00.000Z",
      "Ran command output",
    ],
    [
      "tool.completed",
      "thread-fixture::tool.completed::tool-1",
      "turn-1",
      "tool",
      105,
      "1970-01-01T00:00:01.004Z",
      "Ran command completed",
    ],
    [
      "tool.failed",
      "thread-fixture::tool.failed::tool-2",
      "turn-1",
      "error",
      106,
      "1970-01-01T00:00:01.005Z",
      "Read file failed",
    ],
    [
      "tool.started",
      "thread-fixture::tool.started::item-2",
      "turn-1",
      "tool",
      107,
      "1970-01-01T00:00:01.006Z",
      "Changed files: a.ts",
    ],
    [
      "tool.completed",
      "thread-fixture::tool.completed::item-2",
      "turn-1",
      "tool",
      108,
      "1970-01-01T00:00:01.007Z",
      "Changed files completed",
    ],
    [
      "plan-approval.requested",
      "thread-fixture::plan-approval.requested::req-plan-1",
      "turn-1",
      "approval",
      109,
      "2026-09-11T12:00:00.000Z",
      "Plan approval requested",
    ],
    [
      "approval.requested",
      "thread-fixture::approval.requested::req-tool-1",
      "turn-1",
      "approval",
      110,
      "2026-09-11T12:00:00.000Z",
      "Approval required for exec_command",
    ],
    [
      "approval.resolved",
      "thread-fixture::approval.resolved::req-tool-1",
      "turn-1",
      "info",
      111,
      "2026-09-11T12:00:00.000Z",
      "Approval approved",
    ],
    [
      "tool.denied",
      "thread-fixture::tool.denied::evt-tool-denied",
      "turn-1",
      "error",
      112,
      "2026-09-11T12:00:00.000Z",
      "Tool denied: rm",
    ],
    [
      "turn.diff.updated",
      "thread-fixture::turn.diff.updated::turn-1",
      "turn-1",
      "info",
      114,
      "2026-09-11T12:00:00.000Z",
      "Diff updated",
    ],
    [
      "runtime.error",
      "thread-fixture::runtime.error::evt-runtime-error",
      "turn-1",
      "error",
      115,
      "2026-09-11T12:00:00.000Z",
      "Provider runtime error",
    ],
    [
      "runtime.error",
      "thread-fixture::runtime.error::116",
      "turn-1",
      "error",
      116,
      "2026-09-11T12:00:00.000Z",
      "Provider runtime error",
    ],
    [
      "turn.completed",
      "thread-fixture::turn_completed::turn-2",
      "turn-2",
      "info",
      117,
      "2026-09-11T12:00:00.000Z",
      "Turn completed",
    ],
    [
      "turn.aborted",
      "thread-fixture::turn.aborted::turn-3",
      "turn-3",
      "info",
      118,
      "2026-09-11T12:00:00.000Z",
      "Turn interrupted",
    ],
    [
      "session.exited",
      "thread-fixture::session.exited::119",
      null,
      "error",
      119,
      "2026-09-11T12:00:00.000Z",
      "Provider session exited with error",
    ],
    [
      "session.state.changed",
      "thread-fixture::session.state.changed::120",
      null,
      "info",
      120,
      "2026-09-11T12:00:00.000Z",
      "Provider session ready",
    ],
  ]

  const GOLDEN_FRAMES: ReadonlyArray<[string, string]> = [
    ["thread.activity", "turn.started"],
    ["provider.runtimeEvent", "turn_started"],
    ["provider.runtimeEvent", "content_delta"],
    ["thread.activity", "tool.started"],
    ["provider.runtimeEvent", "tool_call"],
    ["thread.activity", "tool.updated"],
    ["provider.runtimeEvent", "tool_call_delta"],
    ["thread.activity", "tool.completed"],
    ["provider.runtimeEvent", "tool_result"],
    ["thread.activity", "tool.failed"],
    ["provider.runtimeEvent", "tool_result"],
    ["thread.activity", "tool.started"],
    ["provider.runtimeEvent", "tool_call"],
    ["thread.activity", "tool.completed"],
    ["provider.runtimeEvent", "tool_result"],
    ["thread.activity", "plan-approval.requested"],
    ["provider.runtimeEvent", "plan_approval_requested"],
    ["thread.activity", "approval.requested"],
    ["provider.runtimeEvent", "tool_approval_requested"],
    ["thread.activity", "approval.resolved"],
    ["provider.runtimeEvent", "tool_approval_resolved"],
    ["thread.activity", "tool.denied"],
    ["provider.runtimeEvent", "tool.denied"],
    ["provider.runtimeEvent", "token_usage"],
    ["thread.activity", "turn.diff.updated"],
    ["provider.runtimeEvent", "turn.diff.updated"],
    ["thread.activity", "runtime.error"],
    ["provider.runtimeEvent", "turn_error"],
    ["thread.activity", "runtime.error"],
    ["provider.runtimeEvent", "turn_error"],
    ["thread.activity", "turn.completed"],
    ["provider.runtimeEvent", "turn_completed"],
    ["thread.activity", "turn.aborted"],
    ["provider.runtimeEvent", "turn.aborted"],
    ["thread.activity", "session.exited"],
    ["provider.runtimeEvent", "session.exited"],
    ["thread.activity", "session.state.changed"],
    ["provider.runtimeEvent", "session.state.changed"],
  ]

  const GOLDEN_ROW_ENVELOPES = [
    "ProviderRuntime:turn_started",
    "ProviderRuntime:content_delta",
    "ProviderRuntime:tool_call",
    "ProviderRuntime:tool_call_delta",
    "ProviderRuntime:tool_result",
    "ProviderRuntime:tool_result",
    "ProviderRuntime:tool_call",
    "ProviderRuntime:tool_result",
    "ProviderRuntime:plan_approval_requested",
    "ProviderRuntime:tool_approval_requested",
    "ProviderRuntime:tool_approval_resolved",
    "ProviderRuntime:tool.denied",
    "ProviderRuntime:token_usage",
    "ProviderRuntime:turn.diff.updated",
    "ProviderRuntime:turn_error",
    "ProviderRuntime:turn_error",
    "ProviderRuntime:turn_completed",
    "ProviderRuntime:turn.aborted",
    "ProviderRuntime:session.exited",
    "ProviderRuntime:session.state.changed",
  ]

  function frameSummary(frame: unknown): [string, string] {
    const { channel, data } = frame as {
      channel: string
      data: { event_type?: string; kind?: string }
    }
    return [channel, (data.event_type ?? data.kind)!]
  }

  it("pins the activities, frames, journal rows and lifecycle calls of the fixture corpus", () => {
    const harness = makeCanonicalHarness()
    withFrozenClock(() =>
      driveThroughLegacyBridgePath(
        harness,
        CANONICAL_JOURNAL_FIXTURES.map((fixture) => fixture.event)
      )
    )
    const snapshot = harnessSnapshot(harness)

    expect(
      snapshot.activities.map((activity) => [
        activity.kind,
        activity.activity_id,
        activity.turn_id,
        activity.tone,
        activity.sequence,
        activity.created_at,
        activity.summary,
      ])
    ).toEqual(GOLDEN_ACTIVITY_ROWS)
    expect(snapshot.frames.map(frameSummary)).toEqual(GOLDEN_FRAMES)
    expect(snapshot.rows.map((row) => row.event_type)).toEqual(
      GOLDEN_ROW_ENVELOPES
    )
    expect(
      snapshot.rows.every((row) => row.stream_id === "thread-fixture")
    ).toBe(true)
    // Every journaled row is receipted, in order, and the two bridge-declined
    // fixtures never reach the journal on this path.
    expect(snapshot.receipts).toEqual(
      GOLDEN_ROW_ENVELOPES.map((_, index) => 501 + index)
    )
    expect(snapshot.lifecycle).toEqual({
      completed: [["thread-fixture", "codex-work", "dispatch-2"]],
      failed: [
        ["thread-fixture", "codex-work", "turn-1", "provider exploded"],
        ["thread-fixture", "codex-work", "dispatch-1", "model refused"],
        ["thread-fixture", "codex-work", "dispatch-3", "user interrupt"],
        [
          "thread-fixture",
          "codex-work",
          "dispatch-4",
          "process exited with code 1",
        ],
      ],
    })
    expect(harness.fatal).not.toHaveBeenCalled()
  })

  it("pins the payload details that clients key on", () => {
    const harness = makeCanonicalHarness()
    withFrozenClock(() =>
      driveThroughLegacyBridgePath(
        harness,
        CANONICAL_JOURNAL_FIXTURES.map((fixture) => fixture.event)
      )
    )
    const byKind = (kind: string, index = 0) =>
      harness.activities.filter((activity) => activity.kind === kind)[index]!
        .payload as Record<string, unknown>
    const frames = runtimeFrames(harness.frames)
    const frame = (eventType: string, index = 0) =>
      frames.filter((event) => event.event_type === eventType)[index]!.payload

    // item.updated snapshot: cumulative marker survives so the row replaces
    // in place, keyed by the tool id.
    expect(byKind("tool.updated")).toMatchObject({
      toolId: "tool-1",
      output_delta: "> vitest run\n",
      cumulative: true,
      providerKind: "codex",
      providerInstanceId: "codex-work",
    })
    expect(byKind("tool.completed")).toMatchObject({
      toolId: "tool-1",
      output: { stdout: "ok", exitCode: 0 },
      completed_at: 1_004,
    })
    // `raw` never reaches the wire or the activity.
    expect(byKind("tool.completed")).not.toHaveProperty("raw")
    expect(frame("tool_result")).not.toHaveProperty("raw")
    expect(byKind("plan-approval.requested")).toMatchObject({
      requestId: "req-plan-1",
      planMarkdown: "# Plan\n\n- run tests\n- fix failures\n",
    })
    expect(frame("token_usage")).toEqual({
      providerKind: "codex",
      providerInstanceId: "codex-work",
      turn_id: "turn-1",
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        usedTokens: 165,
        cachedInputTokens: 20,
        durationMs: 800,
      },
    })
    expect(frame("turn_error", 1)).toMatchObject({
      status: "failed",
      error: "model refused",
      dispatchTurnId: "dispatch-1",
      turn_id: "turn-1",
    })
    expect(frame("session.exited")).toMatchObject({
      dispatchTurnId: "dispatch-4",
      reason: "process exited with code 1",
      exitKind: "error",
      recoverable: false,
    })
    expect(byKind("session.exited")).toMatchObject({
      dispatchTurnId: "dispatch-4",
    })
  })

  it("pins the bounded live projection of an oversized tool result", () => {
    const harness = makeCanonicalHarness()
    withFrozenClock(() =>
      driveThroughLegacyBridgePath(harness, [oversizedToolCompletedFixture()])
    )

    expect(harness.rows).toHaveLength(1)
    const row = harness.rows[0]!
    expect(Buffer.byteLength(row.payload_json, "utf8")).toBeLessThanOrEqual(
      1024 * 1024
    )
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      payloadTruncated: true,
    })
    const activity = harness.activities[0]!
    const payload = activity.payload as {
      output: string
      payloadTruncated?: boolean
      journal_truncation?: {
        truncated: boolean
        fields: string[]
        originalBytes: number
      }
    }
    expect(activity.kind).toBe("tool.completed")
    expect(payload.output).toMatch(/^x+$/)
    expect(payload.output.length).toBeLessThan(2 * 1024 * 1024)
    expect(payload.payloadTruncated).toBe(true)
    expect(payload.journal_truncation).toMatchObject({
      truncated: true,
      fields: ["output"],
    })
    const [frame] = runtimeFrames(harness.frames)
    expect(frame!.event_type).toBe("tool_result")
    expect((frame!.payload as { output: string }).output).toBe(payload.output)
    expect(JSON.parse(row.payload_json).payload.output).toBe(payload.output)
    expect(harness.receipts.markProjected).toHaveBeenCalledWith(501)
  })
})

/**
 * The bridge moved behind the journal. Nothing the user sees may move with
 * it: every canonical fixture must produce, through `ingestCanonical`, the
 * activities and frames the step-0 goldens pinned for the old
 * `canonicalToLegacy -> ingest` path, and a v2 row and a v3 row of the same
 * event must replay to identical activities.
 */
describe("canonical ingestion behind the journal", () => {
  /** The old path: bridge in front, then legacy ingest (the golden reference). */
  function goldenSnapshot(
    events: ReadonlyArray<CanonicalProviderRuntimeEvent>
  ) {
    const harness = makeCanonicalHarness()
    withFrozenClock(() => driveThroughLegacyBridgePath(harness, events))
    return { harness, snapshot: harnessSnapshot(harness) }
  }

  /**
   * The one user-visible difference between the two paths. A canonical event
   * the bridge declines is journaled and receipted, so it consumes a
   * projection sequence; the old path dropped it in front of the bus and
   * consumed none. Every activity after a declined fixture is therefore
   * numbered higher on the canonical path — by the number of declined
   * fixtures before it — and so is any activity id derived from the
   * sequence. This maps a canonical snapshot back onto the old numbering so
   * everything else can still be compared byte for byte.
   */
  function withoutDeclinedSequenceSkew(
    snapshot: ReturnType<typeof harnessSnapshot>,
    fixtures: ReadonlyArray<CanonicalJournalFixture>,
    sequenceStart = 100
  ): ReturnType<typeof harnessSnapshot> {
    const declinedSequences = fixtures.flatMap((fixture, index) =>
      fixture.bridged ? [] : [sequenceStart + 1 + index]
    )
    const renumber = <T extends { sequence?: number | null }>(record: T): T => {
      const sequence = record.sequence
      if (typeof sequence !== "number") return record
      const skew = declinedSequences.filter(
        (declined) => declined < sequence
      ).length
      if (skew === 0) return record
      const renumbered = sequence - skew
      const renumberId = (id: unknown) =>
        typeof id === "string" && id.endsWith(`::${sequence}`)
          ? `${id.slice(0, -String(sequence).length)}${renumbered}`
          : id
      const out = { ...record, sequence: renumbered } as T & {
        activity_id?: unknown
        id?: unknown
      }
      if ("activity_id" in out) out.activity_id = renumberId(out.activity_id)
      if ("id" in out) out.id = renumberId(out.id)
      return out
    }
    return {
      ...snapshot,
      activities: snapshot.activities.map(renumber),
      frames: snapshot.frames.map((frame) => {
        const { channel, data } = frame as {
          channel: string
          data: { sequence?: number | null }
        }
        return channel === "thread.activity"
          ? { ...(frame as object), data: renumber(data) }
          : frame
      }),
    }
  }

  /** The production path: canonical intake, journal, bridge behind it. */
  function canonicalSnapshot(
    events: ReadonlyArray<CanonicalProviderRuntimeEvent>,
    options: Parameters<typeof makeCanonicalHarness>[0] = {}
  ) {
    const harness = makeCanonicalHarness(options)
    withFrozenClock(() => {
      for (const event of events) {
        harness.ingestion.ingestCanonical(cloneFixtureEvent(event))
      }
    })
    return { harness, snapshot: harnessSnapshot(harness) }
  }

  function sqliteHarness(
    options: {
      readonly legacyView?: (
        event: CanonicalProviderRuntimeEvent
      ) => ProviderRuntimeEvent | null
      readonly receipts?: boolean
      readonly sequenceStart?: number
    } = {}
  ) {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "bc0de-canonical-journal-")
    )
    const db = openDatabase(path.join(dir, "test.sqlite"))
    runMigrations(db)
    const events = new EventStore(db)
    const receipts = new ProviderRuntimeProjectionReceiptStore(db)
    const journal = new ProviderRuntimeEventJournal(events)
    const activities: ThreadActivityProjection[] = []
    const frames: unknown[] = []
    const logger = makeLogger()
    const fatal = vi.fn()
    const build = (bridge?: typeof options.legacyView) =>
      new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        eventJournal: journal,
        ...(options.receipts === false ? {} : { projectionReceipts: receipts }),
        activityStore: {
          upsert: (activity) => activities.push(structuredClone(activity)),
        },
        broadcaster: {
          broadcast: (frame: unknown) => frames.push(structuredClone(frame)),
          clientCount: () => 1,
        },
        logger,
        onFatalProjectionFailure: fatal,
        sequenceStart: options.sequenceStart ?? 100,
        ...(bridge ? { legacyView: bridge } : {}),
      })
    const ingestion = build(options.legacyView)
    const replayAllWithRealBridge = () =>
      new ProviderRuntimeJournalReplayer(
        events,
        receipts,
        build(),
        logger
      ).replayAll()
    return {
      db,
      events,
      receipts,
      journal,
      ingestion,
      activities,
      frames,
      logger,
      fatal,
      replayAllWithRealBridge,
      close: () => db.close(),
    }
  }

  it("live parity: ingestCanonical reproduces the step-0 goldens, except that a declined event now consumes a sequence", () => {
    const events = CANONICAL_JOURNAL_FIXTURES.map((fixture) => fixture.event)
    const golden = goldenSnapshot(events)
    const live = canonicalSnapshot(events)

    // The skew, as literals. The declined `item.started` is second in the
    // corpus: the old path never saw it, the canonical path journals it as
    // row 102, so every activity after `turn.started` sits one sequence
    // later than the golden — including the ids derived from the sequence.
    expect(live.snapshot.rows[1]).toEqual({
      event_type: "ProviderRuntime:item.started",
      stream_id: "thread-fixture",
      stream_version: 102,
    })
    expect(
      golden.snapshot.activities.map((activity) => activity.sequence)
    ).toEqual([
      101, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 114, 115, 116, 117,
      118, 119, 120,
    ])
    expect(
      live.snapshot.activities.map((activity) => activity.sequence)
    ).toEqual([
      101, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 115, 116, 117, 118,
      119, 120, 121,
    ])
    expect(
      live.snapshot.activities
        .filter((activity) => /::\d+$/.test(activity.activity_id))
        .map((activity) => activity.activity_id)
    ).toEqual([
      "thread-fixture::runtime.error::117",
      "thread-fixture::session.exited::120",
      "thread-fixture::session.state.changed::121",
    ])

    // Everything else is byte for byte what the old path produced.
    const normalized = withoutDeclinedSequenceSkew(
      live.snapshot,
      CANONICAL_JOURNAL_FIXTURES
    )
    expect(normalized.activities).toEqual(golden.snapshot.activities)
    expect(normalized.frames).toEqual(golden.snapshot.frames)
    expect(live.snapshot.lifecycle).toEqual(golden.snapshot.lifecycle)
    expect(JSON.stringify(normalized.activities)).toBe(
      JSON.stringify(golden.snapshot.activities)
    )
    expect(JSON.stringify(normalized.frames)).toBe(
      JSON.stringify(golden.snapshot.frames)
    )
    // What else changed is the journal, not the user: every row is now
    // canonical, and the two bridge-declined fixtures are journaled and
    // receipted where the old path dropped them before the journal.
    expect(live.snapshot.rows.map((row) => row.event_type)).toEqual(
      events.map((event) => `ProviderRuntime:${event.type}`)
    )
    for (const row of live.harness.rows) {
      expect(JSON.parse(row.metadata_json)).toMatchObject({ schema: 3 })
      expect(row.payload_json).not.toContain('"raw"')
    }
    expect(live.snapshot.receipts).toEqual(
      events.map((_, index) => 501 + index)
    )
    expect(golden.snapshot.receipts).toHaveLength(events.length - 2)
    expect(live.harness.fatal).not.toHaveBeenCalled()
    // The only error-level lines are the "event failed" lines both paths
    // write for the two failure fixtures (runtime.error, turn.completed
    // failed); the broadcast log names the wire event, as before.
    expect(live.harness.logger.error.mock.calls).toEqual(
      golden.harness.logger.error.mock.calls
    )
    expect(
      live.harness.logger.error.mock.calls.map((call) => [
        call[0].event,
        call[1],
      ])
    ).toEqual([
      ["turn_error", "event failed"],
      ["turn_error", "event failed"],
    ])
  })

  it("replay parity: a v2 row and a v3 row of the same event replay to identical activities", () => {
    const v2 = sqliteHarness({ receipts: true })
    const v3 = sqliteHarness({ receipts: true })
    let sequence = 0
    for (const fixture of CANONICAL_JOURNAL_FIXTURES) {
      if (!fixture.bridged) continue
      sequence += 1
      const legacy = canonicalToLegacy(cloneFixtureEvent(fixture.event))!
      v2.journal.persist(legacyJournalEntry(legacy), sequence)
      v3.journal.persist(
        canonicalJournalEntry(cloneFixtureEvent(fixture.event)),
        sequence
      )
    }
    expect(v2.events.readUnprojectedProviderRuntimeEvents(100)).toHaveLength(
      sequence
    )
    expect(v3.events.readUnprojectedProviderRuntimeEvents(100)).toHaveLength(
      sequence
    )

    const v2Result = withFrozenClock(() => v2.replayAllWithRealBridge())
    const v3Result = withFrozenClock(() => v3.replayAllWithRealBridge())

    expect(v2Result).toEqual({
      replayed: sequence,
      discarded: 0,
      blocked: null,
    })
    expect(v3Result).toEqual(v2Result)
    expect(v3.activities).toEqual(v2.activities)
    expect(JSON.stringify(v3.activities)).toBe(JSON.stringify(v2.activities))
    expect(v3.activities.length).toBeGreaterThan(10)
    // Replay is silent on both: no frames.
    expect(v2.frames).toEqual([])
    expect(v3.frames).toEqual([])
    v2.close()
    v3.close()
  })

  it("bounded live == bounded replay for an oversized canonical tool result", () => {
    const live = sqliteHarness({ receipts: false })
    withFrozenClock(() =>
      live.ingestion.ingestCanonical(oversizedToolCompletedFixture())
    )
    expect(live.activities).toHaveLength(1)
    const liveActivity = live.activities[0]!
    const livePayload = liveActivity.payload as {
      output: string
      payloadTruncated?: boolean
      journal_truncation?: {
        truncated: boolean
        fields: string[]
        originalBytes: number
      }
    }
    expect(liveActivity.kind).toBe("tool.completed")
    expect(livePayload.output).toMatch(/^x+$/)
    expect(livePayload.output.length).toBeLessThan(2 * 1024 * 1024)
    expect(livePayload.payloadTruncated).toBe(true)
    expect(livePayload.journal_truncation).toMatchObject({
      truncated: true,
      fields: ["output"],
    })
    const [liveFrame] = runtimeFrames(live.frames)
    expect((liveFrame!.payload as { output: string }).output).toBe(
      livePayload.output
    )
    // The row is canonical and pure: the markers live in metadata.
    const [row] = live.events.readUnprojectedProviderRuntimeEvents(10)
    expect(JSON.parse(row!.metadata_json)).toMatchObject({
      schema: 3,
      payloadTruncated: true,
      truncatedFields: ["output"],
    })
    const stored = JSON.parse(row!.payload_json) as Record<string, unknown>
    expect(stored).not.toHaveProperty("payloadTruncated")
    expect(stored).not.toHaveProperty("journal_truncation")
    expect(stored.output).toBe(livePayload.output)

    // Same DB, fresh ingestion: replay projects the identical activity.
    const activitiesBeforeReplay = live.activities.length
    withFrozenClock(() => live.replayAllWithRealBridge())
    expect(live.activities).toHaveLength(activitiesBeforeReplay + 1)
    expect(live.activities[1]).toEqual(liveActivity)
    expect(JSON.stringify(live.activities[1])).toBe(
      JSON.stringify(liveActivity)
    )
    live.close()
  })

  it("bridge bug (returns null): the canonical row is journaled and receipted; a fixed bridge re-projects it", () => {
    const fixture = CANONICAL_JOURNAL_FIXTURES.find(
      (entry) => entry.name === "tool.completed with raw envelope"
    )!
    const declineToolCompleted = (event: CanonicalProviderRuntimeEvent) =>
      event.type === "tool.completed" ? null : canonicalToLegacy(event)
    const harness = sqliteHarness({ legacyView: declineToolCompleted })
    const append = vi.spyOn(harness.events, "append")

    harness.ingestion.ingestCanonical(cloneFixtureEvent(fixture.event))

    expect(append).toHaveBeenCalledTimes(1)
    const [row] = harness.events.readProviderRuntimeByStreamVersion(
      "thread-fixture",
      101
    )
    const { raw: _raw, ...withoutRaw } = fixture.event as { raw?: unknown }
    expect(JSON.parse(row!.payload_json)).toEqual(withoutRaw)
    expect(harness.activities).toEqual([])
    expect(harness.frames).toEqual([])
    expect(harness.receipts.get(row!.sequence)).toMatchObject({
      status: "projected",
    })
    expect(harness.fatal).not.toHaveBeenCalled()
    expect(harness.logger.info).toHaveBeenCalledWith(
      { event_type: "tool.completed", thread: "thread-fixture" },
      expect.stringContaining("bridge declined")
    )

    // The maintenance step a bridge fix would ship with: clear the receipt so
    // the startup replayer re-offers the row to the (now correct) bridge.
    harness.db
      .prepare(
        "DELETE FROM provider_runtime_projection_receipts WHERE event_sequence = ?"
      )
      .run(row!.sequence)
    withFrozenClock(() => harness.replayAllWithRealBridge())
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "tool.completed",
    ])
    expect(harness.activities[0]!.payload).toMatchObject({
      toolId: "tool-1",
      output: { stdout: "ok", exitCode: 0 },
    })
    harness.close()
  })

  it("bridge bug (throws): the canonical row is journaled, left unreceipted with a degraded notice, and replays with a fixed bridge", () => {
    const fixture = CANONICAL_JOURNAL_FIXTURES.find(
      (entry) => entry.name === "tool.completed with raw envelope"
    )!
    const explode = new Error("bridge exploded")
    const throwOnToolCompleted = (event: CanonicalProviderRuntimeEvent) => {
      if (event.type === "tool.completed") throw explode
      return canonicalToLegacy(event)
    }
    const harness = sqliteHarness({ legacyView: throwOnToolCompleted })
    const append = vi.spyOn(harness.events, "append")

    expect(() =>
      harness.ingestion.ingestCanonical(cloneFixtureEvent(fixture.event))
    ).not.toThrow()

    expect(append).toHaveBeenCalledTimes(1)
    const [row] = harness.events.readProviderRuntimeByStreamVersion(
      "thread-fixture",
      101
    )
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      type: "tool.completed",
      toolId: "tool-1",
      output: { stdout: "ok", exitCode: 0 },
    })
    expect(harness.receipts.get(row!.sequence)).toBeNull()
    // Nothing of the tool result reached the user; the degraded notice did.
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "runtime.warning",
    ])
    expect(harness.activities[0]!.payload).toMatchObject({
      class: "projection_degraded",
      providerKind: "codex",
      providerInstanceId: "codex-work",
    })
    const notices = runtimeFrames(harness.frames)
    expect(notices.map((frame) => frame.event_type)).toEqual([
      "runtime.warning",
    ])
    expect(notices[0]!.payload).toMatchObject({
      class: "projection_degraded",
      reason: "projection",
      source_event_type: "tool.completed",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      turn_id: "turn-1",
      error: "bridge exploded",
    })
    // A translation bug is not a persistence failure: the row is durable, so
    // the backend is not tainted and keeps running. Logged with the cause.
    expect(harness.fatal).not.toHaveBeenCalled()
    expect(harness.logger.error).toHaveBeenCalledWith(
      { err: explode, event_type: "tool.completed", thread: "thread-fixture" },
      "legacy bridge failed after journaling; row left unreceipted for startup replay"
    )
    expect(harness.logger.error).toHaveBeenCalledTimes(1)

    withFrozenClock(() =>
      expect(harness.replayAllWithRealBridge()).toEqual({
        replayed: 1,
        discarded: 0,
        blocked: null,
      })
    )
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "runtime.warning",
      "tool.completed",
    ])
    expect(harness.activities[1]!.payload).toMatchObject({
      toolId: "tool-1",
      output: { stdout: "ok", exitCode: 0 },
    })
    expect(harness.receipts.get(row!.sequence)).toMatchObject({
      status: "projected",
    })
    harness.close()
  })

  it("bridge bug (throws) on a terminal event: rethrows so the hub settles the turn as failed, without tainting the backend, and replays with a fixed bridge", () => {
    const fixture = CANONICAL_JOURNAL_FIXTURES.find(
      (entry) => entry.name === "turn.completed status completed"
    )!
    const explode = new Error("bridge exploded on turn.completed")
    const throwOnTurnCompleted = (event: CanonicalProviderRuntimeEvent) => {
      if (event.type === "turn.completed") throw explode
      return canonicalToLegacy(event)
    }
    const harness = sqliteHarness({ legacyView: throwOnTurnCompleted })

    // What the hub's emit sees: the failure, typed, carrying the bridge's own
    // error — the same outcome the old wiring (bridge in front) produced.
    let thrown: unknown
    try {
      harness.ingestion.ingestCanonical(cloneFixtureEvent(fixture.event))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderRuntimeBridgeError)
    expect(thrown).toMatchObject({
      message: "bridge exploded on turn.completed",
      eventType: "turn.completed",
      cause: explode,
    })

    // Durable, unreceipted, surfaced once — and no taint.
    const [row] = harness.events.readProviderRuntimeByStreamVersion(
      "thread-fixture",
      101
    )
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      type: "turn.completed",
      turnId: "turn-2",
      status: "completed",
    })
    expect(harness.receipts.get(row!.sequence)).toBeNull()
    expect(harness.fatal).not.toHaveBeenCalled()
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "runtime.warning",
    ])
    expect(
      runtimeFrames(harness.frames).map((frame) => frame.event_type)
    ).toEqual(["runtime.warning"])
    expect(harness.logger.error.mock.calls.map((call) => call[1])).toEqual([
      "legacy bridge failed after journaling; row left unreceipted for startup replay",
    ])

    // A non-terminal event on the same thread afterwards is not blocked, and
    // the degraded notice is not repeated while the block lasts.
    const started = CANONICAL_JOURNAL_FIXTURES.find(
      (entry) => entry.name === "tool.started"
    )!
    expect(() =>
      harness.ingestion.ingestCanonical(cloneFixtureEvent(started.event))
    ).not.toThrow()
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "runtime.warning",
      "tool.started",
    ])

    // Next start with the fixed bridge: the unreceipted row projects.
    withFrozenClock(() =>
      expect(harness.replayAllWithRealBridge()).toEqual({
        replayed: 1,
        discarded: 0,
        blocked: null,
      })
    )
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "runtime.warning",
      "tool.started",
      "turn.completed",
    ])
    expect(harness.receipts.get(row!.sequence)).toMatchObject({
      status: "projected",
    })
    harness.close()
  })

  it("bridge bug (throws) on a queued terminal event: consumes the queue entry without tainting the backend", async () => {
    vi.useFakeTimers()
    try {
      const explode = new Error("bridge exploded while draining")
      const fatal = vi.fn()
      const logger = makeLogger()
      const persist = vi
        .fn()
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("database is locked"), {
            code: "SQLITE_BUSY",
          })
        })
        .mockImplementation(() => 91)
      const receipts = { markProjected: vi.fn() }
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        eventJournal: { persist },
        projectionReceipts: receipts,
        activityStore: { upsert: vi.fn() },
        broadcaster: makeBroadcaster(),
        logger,
        onFatalProjectionFailure: fatal,
        sequenceStart: 90,
        journalRetryBaseMs: 10,
        journalRetryMaxMs: 10,
        legacyView: (event) => {
          if (event.type === "turn.completed") throw explode
          return canonicalToLegacy(event)
        },
      })
      const terminal = cloneFixtureEvent(
        CANONICAL_JOURNAL_FIXTURES.find(
          (entry) => entry.name === "turn.completed status completed"
        )!.event
      )

      // Contention queues the event; the hub's emit has returned by the
      // time the drain runs, so there is nothing to rethrow to.
      expect(() => ingestion.ingestCanonical(terminal)).not.toThrow()
      expect(persist).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10)

      expect(persist).toHaveBeenCalledTimes(2)
      expect(receipts.markProjected).not.toHaveBeenCalled()
      expect(fatal).not.toHaveBeenCalled()
      expect(logger.error.mock.calls.map((call) => call[1])).toEqual([
        "legacy bridge failed after journaling; row left unreceipted for startup replay",
      ])
      // The queue is drained: a later event journals and projects normally.
      const later = cloneFixtureEvent(
        CANONICAL_JOURNAL_FIXTURES.find(
          (entry) => entry.name === "tool.started"
        )!.event
      )
      ingestion.ingestCanonical(later)
      expect(persist).toHaveBeenCalledTimes(3)
      expect(receipts.markProjected).toHaveBeenCalledWith(91)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rethrows an ingestion failure for a canonical terminal event so the hub can mark the turn uncertain", () => {
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger,
    })
    const failure = new Error("projection lane exploded")
    vi.spyOn(
      ingestion as unknown as { ingestEvent: () => void },
      "ingestEvent"
    ).mockImplementation(() => {
      throw failure
    })
    const byName = (name: string) =>
      cloneFixtureEvent(
        CANONICAL_JOURNAL_FIXTURES.find((entry) => entry.name === name)!.event
      )

    expect(() =>
      ingestion.ingestCanonical(byName("session.state.changed"))
    ).not.toThrow()
    expect(() =>
      ingestion.ingestCanonical(byName("tool.completed with raw envelope"))
    ).not.toThrow()
    expect(() =>
      ingestion.ingestCanonical(byName("turn.completed status failed"))
    ).toThrow(failure)
    expect(() =>
      ingestion.ingestCanonical(byName("turn.completed status completed"))
    ).toThrow(failure)
    expect(() => ingestion.ingestCanonical(byName("turn.aborted"))).toThrow(
      failure
    )
    // `session.exited` settles a correlated admission in the hub exactly like
    // `turn.aborted`, so it is terminal here too — in both spellings.
    expect(() =>
      ingestion.ingestCanonical(
        byName("session.exited with injected dispatchTurnId")
      )
    ).toThrow(failure)
    expect(() =>
      ingestion.ingest({
        event_type: "session_exited",
        thread_id: "thread-fixture",
        payload: { reason: "process exited", dispatchTurnId: "dispatch-4" },
      })
    ).toThrow(failure)
    expect(() =>
      ingestion.ingest({
        event_type: "session.updated",
        thread_id: "thread-fixture",
        payload: { status: "ready" },
      })
    ).not.toThrow()
    expect(logger.error).toHaveBeenCalledTimes(8)
  })

  it("journals, receipts and does not broadcast a structural event the bridge declines, and replays it silently", () => {
    const fixture = CANONICAL_JOURNAL_FIXTURES.find(
      (entry) =>
        entry.name === "request.opened tool_user_input (bridge declines)"
    )!
    const harness = sqliteHarness()

    harness.ingestion.ingestCanonical(cloneFixtureEvent(fixture.event))

    const [row] = harness.events.readProviderRuntimeByStreamVersion(
      "thread-fixture",
      101
    )
    expect(row).toMatchObject({ event_type: "ProviderRuntime:request.opened" })
    expect(JSON.parse(row!.payload_json)).toEqual(fixture.event)
    expect(harness.receipts.get(row!.sequence)).toMatchObject({
      status: "projected",
    })
    expect(harness.activities).toEqual([])
    expect(harness.frames).toEqual([])
    expect(() =>
      harness.ingestion.replayPersisted(canonicalJournalEntry(fixture.event), {
        projectionSequence: row!.stream_version,
      })
    ).not.toThrow()
    expect(harness.activities).toEqual([])
    harness.close()
  })

  it("holds a canonical entry in the journal retry queue, retries in order and spools a version 3 record on stop", async () => {
    vi.useFakeTimers()
    try {
      const broadcaster = makeBroadcaster()
      const persist = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 1")
        })
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 2")
        })
        .mockImplementationOnce(() => {
          throw new Error("journal unavailable 3")
        })
        .mockImplementation(() => undefined)
      const ingestion = new ProviderRuntimeIngestion({
        eventBus: new EventEmitter(),
        eventJournal: { persist },
        activityStore: { upsert: vi.fn() },
        broadcaster,
        logger: makeLogger(),
        sequenceStart: 40,
        journalRetryBaseMs: 10,
        journalRetryMaxMs: 10,
      })
      const canonicalTerminal = cloneFixtureEvent(
        CANONICAL_JOURNAL_FIXTURES.find(
          (entry) => entry.name === "turn.completed status completed"
        )!.event
      )
      const later: ProviderRuntimeEvent = {
        event_type: "session.updated",
        thread_id: "thread-fixture",
        payload: { status: "ready" },
      }

      ingestion.ingestCanonical(canonicalTerminal)
      ingestion.ingest(later)

      expect(broadcaster.broadcast).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)

      expect(
        runtimeFrames(broadcaster.frames).map((event) => event.event_type)
      ).toEqual(["turn_completed", "session.updated"])
      expect(persist).toHaveBeenCalledWith(
        { shape: "canonical", event: canonicalTerminal },
        41
      )
      expect(persist).toHaveBeenCalledWith(legacyJournalEntry(later), 42)
    } finally {
      vi.useRealTimers()
    }
  })

  it("spools a queued canonical entry as a version 3 recovery record during shutdown", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "bc0de-canonical-spool-")
    )
    const recoveryStore = new ProviderRuntimeJournalRecoveryStore(directory, {
      logger: makeLogger(),
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: {
        persist: vi.fn(() => {
          throw new Error("database remains locked")
        }),
      },
      journalRecoveryStore: recoveryStore,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 40,
    })
    const event = cloneFixtureEvent(
      CANONICAL_JOURNAL_FIXTURES.find((entry) => entry.name === "tool.started")!
        .event
    )

    ingestion.ingestCanonical(event)
    expect(() => ingestion.stop()).not.toThrow()

    const [fileName] = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
    const record = JSON.parse(
      fs.readFileSync(path.join(directory, fileName!), "utf8")
    )
    expect(record).toMatchObject({
      version: 3,
      shape: "canonical",
      projectionSequence: 41,
      event,
    })
    // Startup replays the record into the journal as a canonical entry.
    const persist = vi.fn()
    expect(recoveryStore.replay({ persist })).toEqual({
      replayed: 1,
      quarantined: 0,
      pending: 0,
    })
    expect(persist).toHaveBeenCalledWith(
      { shape: "canonical", event },
      41,
      record.eventId
    )
  })

  it("hands the legacy view to projectedSink exactly once per live event, after the receipt, never on replay", () => {
    const calls: string[] = []
    const projected: ProviderRuntimeEvent[] = []
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist: vi.fn(() => (calls.push("journal"), 77)) },
      projectionReceipts: { markProjected: vi.fn(() => calls.push("receipt")) },
      activityStore: { upsert: vi.fn(() => calls.push("activity")) },
      broadcaster: {
        broadcast: vi.fn((frame: { channel: string }) => {
          if (frame.channel === "provider.runtimeEvent") calls.push("broadcast")
        }),
        clientCount: () => 1,
      },
      logger: makeLogger(),
      projectedSink: (event) => {
        calls.push("projected")
        projected.push(event)
      },
    })
    const started = cloneFixtureEvent(
      CANONICAL_JOURNAL_FIXTURES.find((entry) => entry.name === "tool.started")!
        .event
    )
    const legacyStarted: ProviderRuntimeEvent = {
      event_type: "turn_started",
      thread_id: "thread-fixture",
      payload: { turn_id: "turn-1", dispatchTurnId: "dispatch-1" },
    }

    ingestion.ingestCanonical(started)
    ingestion.ingest(legacyStarted)

    expect(calls).toEqual([
      "journal",
      "activity",
      "receipt",
      "projected",
      "broadcast",
      "journal",
      "activity",
      "receipt",
      "projected",
      "broadcast",
    ])
    expect(projected).toEqual([canonicalToLegacy(started), legacyStarted])

    ingestion.replayPersisted(canonicalJournalEntry(started), {
      projectionSequence: 5,
    })
    ingestion.replayPersisted(legacyJournalEntry(legacyStarted), {
      projectionSequence: 6,
    })
    expect(projected).toHaveLength(2)
  })

  it("does not hand a declined, bridge-failed or projection-blocked event to projectedSink", () => {
    const projected: ProviderRuntimeEvent[] = []
    const byName = (name: string) =>
      cloneFixtureEvent(
        CANONICAL_JOURNAL_FIXTURES.find((entry) => entry.name === name)!.event
      )
    const declined = byName("item.started non-tool item (bridge declines)")
    const started = byName("tool.started")
    const completed = byName("tool.completed with raw envelope")
    const upsert = vi.fn()
    const receipts = { markProjected: vi.fn() }
    const fatal = vi.fn()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: new EventEmitter(),
      eventJournal: { persist: vi.fn(() => 78) },
      projectionReceipts: receipts,
      activityStore: { upsert },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      onFatalProjectionFailure: fatal,
      legacyView: (event) => {
        if (event.type === "tool.completed") throw new Error("bridge exploded")
        return canonicalToLegacy(event)
      },
      projectedSink: (event) => projected.push(event),
    })

    // Declined: journaled and receipted, nothing to hand over.
    ingestion.ingestCanonical(declined)
    expect(receipts.markProjected).toHaveBeenCalledTimes(1)
    expect(projected).toEqual([])

    // Bridge failed: journaled, unreceipted, nothing to hand over.
    ingestion.ingestCanonical(completed)
    expect(receipts.markProjected).toHaveBeenCalledTimes(1)
    expect(projected).toEqual([])

    // Projection blocked on a journaled event: the activity store refuses,
    // the row stays unreceipted for replay, and the reactor lane must not
    // see an event the projections could not record.
    upsert.mockImplementationOnce(() => {
      throw new Error("activity store unavailable")
    })
    ingestion.ingestCanonical(started)
    expect(receipts.markProjected).toHaveBeenCalledTimes(1)
    expect(fatal).toHaveBeenCalledTimes(1)
    expect(projected).toEqual([])

    // Control: the same event with a working store does reach the sink.
    ingestion.ingestCanonical(started)
    expect(receipts.markProjected).toHaveBeenCalledTimes(2)
    expect(projected).toEqual([canonicalToLegacy(started)])
  })

  it("journals and projects an oversized event of many sub-cap strings instead of failing it as unjournalable", () => {
    const harness = makeCanonicalHarness()
    const event = oversizedToolCompletedManyBlocksFixture()

    withFrozenClock(() => harness.ingestion.ingestCanonical(event))

    // Appended, bounded, receipted — not the fatal lane.
    expect(harness.fatal).not.toHaveBeenCalled()
    expect(harness.rows).toHaveLength(1)
    const row = harness.rows[0]!
    expect(Buffer.byteLength(row.payload_json, "utf8")).toBeLessThanOrEqual(
      1024 * 1024
    )
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      schema: 3,
      payloadTruncated: true,
      stringCapBytes: 32 * 1024,
    })
    expect(harness.receipts.markProjected).toHaveBeenCalledWith(501)
    // Projected and broadcast from the bounded copy, with the markers.
    expect(harness.activities.map((activity) => activity.kind)).toEqual([
      "tool.completed",
    ])
    const payload = harness.activities[0]!.payload as {
      output: { content: Array<{ text: string }> }
      payloadTruncated?: boolean
      journal_truncation?: { fields: string[] }
    }
    expect(payload.output.content).toHaveLength(25)
    expect(Buffer.byteLength(payload.output.content[0]!.text, "utf8")).toBe(
      32 * 1024
    )
    expect(payload.payloadTruncated).toBe(true)
    expect(payload.journal_truncation?.fields).toHaveLength(25)
    const [frame] = runtimeFrames(harness.frames)
    expect(frame!.event_type).toBe("tool_result")
    expect(
      harness.projected.map((projectedEvent) => projectedEvent.event_type)
    ).toEqual(["tool_result"])
  })

  it("subscribes to the canonical bus lane and leaves it on stop", () => {
    const bus = new EventEmitter()
    const activityStore = { upsert: vi.fn() }
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      activityStore,
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
    })
    const started = cloneFixtureEvent(
      CANONICAL_JOURNAL_FIXTURES.find((entry) => entry.name === "tool.started")!
        .event
    )

    ingestion.start()
    bus.emit("canonical", started)
    expect(activityStore.upsert).toHaveBeenCalledTimes(1)
    expect(bus.listenerCount("canonical")).toBe(1)
    expect(bus.listenerCount("event")).toBe(1)

    ingestion.stop()
    bus.emit("canonical", started)
    expect(activityStore.upsert).toHaveBeenCalledTimes(1)
    expect(bus.listenerCount("canonical")).toBe(0)
    expect(bus.listenerCount("event")).toBe(0)
  })
})
