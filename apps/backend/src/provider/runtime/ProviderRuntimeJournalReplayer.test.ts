import { describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import type { LegacyProviderEvent } from "../types"
import type { ProviderRuntimeJournalEntry } from "./journalEntry"
import { ProviderRuntimeJournalReplayer } from "./ProviderRuntimeJournalReplayer"
import { ProviderRuntimeProjectionReceiptStore } from "./ProviderRuntimeProjectionReceiptStore"

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-provider-replay-"))
  const db = openDatabase(path.join(dir, "test.sqlite"))
  runMigrations(db)
  const events = new EventStore(db)
  const receipts = new ProviderRuntimeProjectionReceiptStore(db)
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  return { db, events, receipts, logger }
}

function appendProviderEvent(
  events: EventStore,
  input: {
    event: unknown
    envelopeType?: string
    streamId?: string
    streamVersion?: number
    metadata?: unknown
  }
) {
  return events.append([
    {
      event_id: crypto.randomUUID(),
      aggregate_kind: "provider_runtime",
      stream_id: input.streamId ?? "thread-1",
      stream_version: input.streamVersion ?? 1,
      event_type: input.envelopeType ?? "ProviderRuntime:turn_completed",
      occurred_at: new Date().toISOString(),
      command_id: null,
      causation_event_id: null,
      correlation_id: null,
      actor_kind: "provider",
      payload_json: JSON.stringify(input.event),
      metadata_json: JSON.stringify(input.metadata ?? {}),
    },
  ])[0]
}

function legacyTurnId(entry: ProviderRuntimeJournalEntry): unknown {
  return entry.shape === "legacy"
    ? entry.event.payload.turn_id
    : entry.event.turnId
}

describe("ProviderRuntimeJournalReplayer", () => {
  it("replays valid unprojected events once and records receipts", () => {
    const { db, events, receipts, logger } = setup()
    const event: LegacyProviderEvent = {
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1", status: "completed" },
    }
    const stored = appendProviderEvent(events, { event, streamVersion: 9 })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 1,
      discarded: 0,
      blocked: null,
    })
    expect(replayPersisted).toHaveBeenCalledWith(
      { shape: "legacy", event },
      { projectionSequence: 9, truncation: null }
    )
    expect(receipts.get(stored.sequence)).toMatchObject({
      status: "projected",
      error: null,
    })
    expect(replayer.replayAll()).toEqual({
      replayed: 0,
      discarded: 0,
      blocked: null,
    })
    expect(replayPersisted).toHaveBeenCalledTimes(1)
    db.close()
  })

  it("feeds schema 2, schema 1 and unmarked rows to the projector as the same legacy event", () => {
    const { db, events, receipts, logger } = setup()
    const event: LegacyProviderEvent = {
      event_type: "tool_result",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1", tool_id: "tool-1", output: "ok" },
    }
    const envelopeType = "ProviderRuntime:tool_result"
    // Today's writer, the pre-`e1022fb` writer, and a row whose metadata never
    // carried a marker at all: all three are the legacy shape.
    const markedV2 = appendProviderEvent(events, {
      event,
      envelopeType,
      streamVersion: 1,
      metadata: {
        schema: 2,
        contract: "provider-runtime-event",
        durability: "journal-first",
      },
    })
    const markedV1 = appendProviderEvent(events, {
      event,
      envelopeType,
      streamVersion: 2,
      metadata: { schema: 1 },
    })
    const unmarked = appendProviderEvent(events, {
      event,
      envelopeType,
      streamVersion: 3,
      metadata: {},
    })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 3,
      discarded: 0,
      blocked: null,
    })
    expect(replayPersisted.mock.calls).toEqual([
      [
        { shape: "legacy", event },
        { projectionSequence: 1, truncation: null },
      ],
      [
        { shape: "legacy", event },
        { projectionSequence: 2, truncation: null },
      ],
      [
        { shape: "legacy", event },
        { projectionSequence: 3, truncation: null },
      ],
    ])
    for (const stored of [markedV2, markedV1, unmarked]) {
      expect(receipts.get(stored.sequence)).toMatchObject({
        status: "projected",
      })
    }
    db.close()
  })

  it("discards malformed entries and continues with the next valid event", () => {
    const { db, events, receipts, logger } = setup()
    const malformed = appendProviderEvent(events, {
      event: { event_type: "turn_completed" },
    })
    const validEvent: LegacyProviderEvent = {
      event_type: "turn_completed",
      thread_id: "thread-1",
      payload: { turn_id: "turn-2" },
    }
    const valid = appendProviderEvent(events, {
      event: validEvent,
      streamVersion: 2,
    })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 1,
      discarded: 1,
      blocked: null,
    })
    expect(receipts.get(malformed.sequence)).toMatchObject({
      status: "discarded",
    })
    expect(receipts.get(valid.sequence)).toMatchObject({ status: "projected" })
    expect(replayPersisted).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventSequence: malformed.sequence }),
      "discarded malformed provider runtime journal event"
    )
    db.close()
  })

  it("stops at an audit-only truncated event without acknowledging it and reports the block", () => {
    const { db, events, receipts, logger } = setup()
    const stored = appendProviderEvent(events, {
      event: {
        event_type: "content_replace",
        thread_id: "thread-1",
        payload: { journal_truncated: true, original_bytes: 2_000_000 },
      },
      envelopeType: "ProviderRuntime:content_replace",
      metadata: { schema: 1, truncated: true },
    })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toMatchObject({
      replayed: 0,
      discarded: 0,
      blocked: {
        eventSequence: stored.sequence,
        attempts: 1,
        maxAttempts: 3,
        error: expect.objectContaining({
          message: expect.stringContaining("audit-only truncation"),
        }),
      },
    })
    expect(replayPersisted).not.toHaveBeenCalled()
    expect(receipts.get(stored.sequence)).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventSequence: stored.sequence, attempts: 1 }),
      "provider runtime journal event is unrecoverable; the rest of its thread is skipped and retried on the next startup"
    )
    db.close()
  })

  it("stops at a future journal schema it cannot interpret", () => {
    const { db, events, receipts, logger } = setup()
    const stored = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1" },
      },
      metadata: { schema: 99 },
    })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll().blocked).toMatchObject({
      eventSequence: stored.sequence,
      error: expect.objectContaining({
        message: expect.stringContaining(
          "Unsupported provider runtime journal schema"
        ),
      }),
    })
    expect(replayPersisted).not.toHaveBeenCalled()
    expect(receipts.get(stored.sequence)).toBeNull()
    db.close()
  })

  it("leaves a projection failure unreceipted, stops replay there, and does not throw", () => {
    const { db, events, receipts, logger } = setup()
    const stored = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1" },
      },
    })
    const later = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-2" },
      },
      streamVersion: 2,
    })
    const failure = new Error("projection unavailable")
    const replayPersisted = vi.fn(() => {
      throw failure
    })
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 0,
      discarded: 0,
      blocked: {
        eventSequence: stored.sequence,
        eventType: "ProviderRuntime:turn_completed",
        thread: "thread-1",
        attempts: 1,
        maxAttempts: 3,
        error: failure,
      },
    })
    // Ordering: the later row of the same thread is not projected ahead of it.
    expect(replayPersisted).toHaveBeenCalledTimes(1)
    expect(receipts.get(stored.sequence)).toBeNull()
    expect(receipts.get(later.sequence)).toBeNull()
    expect(events.readUnprojectedProviderRuntimeEvents(10)).toHaveLength(2)
    expect(receipts.replayAttempts(stored.sequence)).toBe(1)
    db.close()
  })

  it("counts the attempt before the row is replayed, so a crashing projection still burns it", () => {
    const { db, events, receipts, logger } = setup()
    const stored = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1" },
      },
    })
    const seenAttempts: number[] = []
    const replayPersisted = vi.fn(() => {
      // Observed from inside the projection: the attempt is already on
      // record. A projection that took the process down used to leave the
      // count untouched, and the row boot-looped without ever reaching
      // its budget.
      seenAttempts.push(receipts.replayAttempts(stored.sequence))
      throw new Error("projection crashed")
    })
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll().blocked).toMatchObject({
      eventSequence: stored.sequence,
      attempts: 1,
    })
    expect(seenAttempts).toEqual([1])
    expect(receipts.replayAttempts(stored.sequence)).toBe(1)
    expect(replayer.replayAll().blocked).toMatchObject({ attempts: 2 })
    expect(seenAttempts).toEqual([1, 2])
    db.close()
  })

  it("skips only the poisoned thread and keeps replaying the others", () => {
    const { db, events, receipts, logger } = setup()
    const poisonA = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-a",
        payload: { turn_id: "turn-a-poison" },
      },
      streamId: "thread-a",
    })
    const laterA = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-a",
        payload: { turn_id: "turn-a-later" },
      },
      streamId: "thread-a",
      streamVersion: 2,
    })
    const healthyB = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-b",
        payload: { turn_id: "turn-b" },
      },
      streamId: "thread-b",
    })
    const replayPersisted = vi.fn((entry: ProviderRuntimeJournalEntry) => {
      if (legacyTurnId(entry) === "turn-a-poison") {
        throw new Error("projection unavailable")
      }
    })
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 1,
      discarded: 0,
      blocked: expect.objectContaining({
        eventSequence: poisonA.sequence,
        thread: "thread-a",
        attempts: 1,
      }),
    })
    // Thread B replayed; thread A stopped at its poisoned row and its
    // later row was neither projected ahead of it nor charged an attempt.
    expect(
      replayPersisted.mock.calls.map(([entry]) => legacyTurnId(entry))
    ).toEqual(["turn-a-poison", "turn-b"])
    expect(receipts.get(healthyB.sequence)).toMatchObject({
      status: "projected",
    })
    expect(receipts.get(poisonA.sequence)).toBeNull()
    expect(receipts.get(laterA.sequence)).toBeNull()
    expect(receipts.replayAttempts(laterA.sequence)).toBe(0)
    expect(
      events.readUnprojectedProviderRuntimeEvents(10).map((row) => row.sequence)
    ).toEqual([poisonA.sequence, laterA.sequence])
    db.close()
  })

  it("does not rerun a row whose earlier processes exhausted the attempt budget", () => {
    const { db, events, receipts, logger } = setup()
    const poison = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-poison" },
      },
    })
    appendProviderEvent(events, {
      streamVersion: 2,
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-healthy" },
      },
    })
    // Simulate persisted attempt records left by processes that terminated
    // during projection, before JavaScript could enter the failure handler.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      receipts.recordReplayAttempt(
        poison.sequence,
        "startup replay attempt in progress"
      )
    }
    const replayPersisted = vi.fn()
    const result = new ProviderRuntimeJournalReplayer(
      events,
      new ProviderRuntimeProjectionReceiptStore(db),
      { replayPersisted },
      logger
    ).replayAll()
    expect(result).toEqual({ replayed: 1, discarded: 1, blocked: null })
    expect(
      replayPersisted.mock.calls.map(([entry]) => legacyTurnId(entry))
    ).toEqual(["turn-healthy"])
    expect(receipts.get(poison.sequence)).toMatchObject({ status: "discarded" })
    db.close()
  })

  it("discards a poison pill after its attempt budget and continues with the next row", () => {
    const { db, events, receipts, logger } = setup()
    const poison = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-poison" },
      },
    })
    const healthy = appendProviderEvent(events, {
      event: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-healthy" },
      },
      streamVersion: 2,
    })
    const replayPersisted = vi.fn((entry: ProviderRuntimeJournalEntry) => {
      if (legacyTurnId(entry) === "turn-poison") {
        throw new Error("projection unavailable")
      }
    })
    // Each replayAll() is one backend start.
    const boot = () =>
      new ProviderRuntimeJournalReplayer(
        events,
        receipts,
        { replayPersisted },
        logger
      ).replayAll()

    expect(boot().blocked).toMatchObject({ attempts: 1 })
    expect(boot().blocked).toMatchObject({ attempts: 2 })
    expect(receipts.get(poison.sequence)).toBeNull()

    expect(boot()).toEqual({ replayed: 1, discarded: 1, blocked: null })
    expect(receipts.get(poison.sequence)).toMatchObject({
      status: "discarded",
      error: expect.stringContaining(
        "discarded after 3 failed startup replay attempt(s) (projection): projection unavailable"
      ),
    })
    expect(receipts.get(healthy.sequence)).toMatchObject({
      status: "projected",
    })
    expect(receipts.replayAttempts(poison.sequence)).toBe(0)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventSequence: poison.sequence, attempts: 3 }),
      "provider runtime journal replay kept failing; discarded the event so startup can proceed"
    )
    expect(events.readUnprojectedProviderRuntimeEvents(10)).toHaveLength(0)
    db.close()
  })
})

describe("ProviderRuntimeJournalReplayer canonical rows", () => {
  const canonical = {
    type: "tool.completed",
    threadId: "thread-1",
    eventId: "evt-1",
    turnId: "turn-1",
    providerKind: "codex",
    providerInstanceId: "codex-work",
    at: 1_004,
    toolId: "tool-1",
    toolName: "exec_command",
    output: { stdout: "ok" },
  }
  const canonicalMetadata = {
    schema: 3,
    contract: "provider-runtime-event",
    durability: "journal-first",
  }

  it("feeds a schema 3 row to the projector as a canonical entry", () => {
    const { db, events, receipts, logger } = setup()
    const stored = appendProviderEvent(events, {
      event: canonical,
      envelopeType: "ProviderRuntime:tool.completed",
      streamVersion: 4,
      metadata: canonicalMetadata,
    })
    const replayPersisted = vi.fn()
    const replayer = new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    )

    expect(replayer.replayAll()).toEqual({
      replayed: 1,
      discarded: 0,
      blocked: null,
    })
    expect(replayPersisted).toHaveBeenCalledWith(
      { shape: "canonical", event: canonical },
      { projectionSequence: 4, truncation: null }
    )
    expect(receipts.get(stored.sequence)).toMatchObject({ status: "projected" })
    db.close()
  })

  it("hands the truncation record of a bounded schema 3 row to the projector", () => {
    const { db, events, receipts, logger } = setup()
    appendProviderEvent(events, {
      event: { ...canonical, output: "x".repeat(64) },
      envelopeType: "ProviderRuntime:tool.completed",
      streamVersion: 5,
      metadata: {
        ...canonicalMetadata,
        payloadTruncated: true,
        originalBytes: 2_100_000,
        stringCapBytes: 65_536,
        truncatedFields: ["output", "payload.data.stdout"],
      },
    })
    const replayPersisted = vi.fn()
    new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    ).replayAll()

    expect(replayPersisted).toHaveBeenCalledWith(
      { shape: "canonical", event: { ...canonical, output: "x".repeat(64) } },
      {
        projectionSequence: 5,
        truncation: {
          originalBytes: 2_100_000,
          stringCapBytes: 65_536,
          fields: ["output", "payload.data.stdout"],
        },
      }
    )
    db.close()
  })

  it("does not schema-parse a canonical row: journal-limit diff flags replay verbatim", () => {
    // `diffTruncationReason: "journal_limit"` is not in the zod literal
    // (`"output_limit"`); a strip-mode parse would reject or drop it. The
    // replayer checks structure only, so the row replays as stored.
    const { db, events, receipts, logger } = setup()
    const diff = {
      type: "turn.diff.updated",
      threadId: "thread-1",
      eventId: "evt-diff",
      turnId: "turn-1",
      at: 1_013,
      payload: {
        files: [{ path: "a.ts", additions: 1, deletions: 0 }],
        diffTruncated: true,
        diffTruncationReason: "journal_limit",
        journal_limit: "still here",
      },
    }
    appendProviderEvent(events, {
      event: diff,
      envelopeType: "ProviderRuntime:turn.diff.updated",
      streamVersion: 6,
      metadata: {
        ...canonicalMetadata,
        payloadTruncated: true,
        originalBytes: 3_000_000,
        truncatedFields: ["payload.unifiedDiff"],
      },
    })
    const replayPersisted = vi.fn()
    new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    ).replayAll()

    expect(replayPersisted).toHaveBeenCalledWith(
      { shape: "canonical", event: diff },
      {
        projectionSequence: 6,
        truncation: {
          originalBytes: 3_000_000,
          fields: ["payload.unifiedDiff"],
        },
      }
    )
    db.close()
  })

  it("discards a schema 3 row whose envelope or stream disagrees with the event", () => {
    const { db, events, receipts, logger } = setup()
    const wrongEnvelope = appendProviderEvent(events, {
      event: canonical,
      envelopeType: "ProviderRuntime:tool.started",
      streamVersion: 7,
      metadata: canonicalMetadata,
    })
    const wrongStream = appendProviderEvent(events, {
      event: canonical,
      envelopeType: "ProviderRuntime:tool.completed",
      streamId: "thread-other",
      streamVersion: 8,
      metadata: canonicalMetadata,
    })
    const missingEventId = appendProviderEvent(events, {
      event: { ...canonical, eventId: "" },
      envelopeType: "ProviderRuntime:tool.completed",
      streamVersion: 9,
      metadata: canonicalMetadata,
    })
    const replayPersisted = vi.fn()
    expect(
      new ProviderRuntimeJournalReplayer(
        events,
        receipts,
        { replayPersisted },
        logger
      ).replayAll()
    ).toEqual({ replayed: 0, discarded: 3, blocked: null })
    for (const stored of [wrongEnvelope, wrongStream, missingEventId]) {
      expect(receipts.get(stored.sequence)).toMatchObject({
        status: "discarded",
      })
    }
    expect(replayPersisted).not.toHaveBeenCalled()
    db.close()
  })

  it("interleaves schema 2 and schema 3 rows of one thread by sequence", () => {
    const { db, events, receipts, logger } = setup()
    const legacy: LegacyProviderEvent = {
      event_type: "turn_started",
      thread_id: "thread-1",
      payload: { turn_id: "turn-1" },
    }
    appendProviderEvent(events, {
      event: legacy,
      envelopeType: "ProviderRuntime:turn_started",
      streamVersion: 1,
      metadata: { schema: 2 },
    })
    appendProviderEvent(events, {
      event: canonical,
      envelopeType: "ProviderRuntime:tool.completed",
      streamVersion: 2,
      metadata: canonicalMetadata,
    })
    const replayPersisted = vi.fn()
    new ProviderRuntimeJournalReplayer(
      events,
      receipts,
      { replayPersisted },
      logger
    ).replayAll()

    expect(replayPersisted.mock.calls).toEqual([
      [
        { shape: "legacy", event: legacy },
        { projectionSequence: 1, truncation: null },
      ],
      [
        { shape: "canonical", event: canonical },
        { projectionSequence: 2, truncation: null },
      ],
    ])
    db.close()
  })
})
