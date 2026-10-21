import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase, type Db } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import { ThreadActivityProjectionQuery } from "../../persistence/projections"
import { legacyJournalEntry } from "../runtime/journalEntry"
import { ProviderRuntimeEventJournal } from "../runtime/ProviderRuntimeEventJournal"
import type { LegacyProviderEvent } from "../types"
import { readThreadActivityFullOutput } from "./full-output"
import { projectProviderEventToThreadActivity } from "./index"

const databases: Array<{ db: Db; dir: string }> = []
afterEach(() => {
  for (const { db, dir } of databases.splice(0)) {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-full-output-"))
  const db = openDatabase(path.join(dir, "test.sqlite"))
  runMigrations(db)
  databases.push({ db, dir })
  const events = new EventStore(db)
  const journal = new ProviderRuntimeEventJournal(events)
  const activities = new ThreadActivityProjectionQuery(db)
  /** Journal first, then project what was journaled, as ingestion does. */
  const ingest = (event: LegacyProviderEvent, sequence: number) => {
    const persisted = journal.persist(legacyJournalEntry(event), sequence)
    if (persisted.entry.shape !== "legacy") throw new Error("expected legacy")
    const activity = projectProviderEventToThreadActivity(
      persisted.entry.event,
      sequence
    )
    if (!activity) throw new Error("expected an activity")
    activities.upsert(activity)
    return activity
  }
  return { db, events, activities, ingest }
}

function toolResult(output: unknown): LegacyProviderEvent {
  return {
    event_type: "tool_result",
    thread_id: "thread-1",
    payload: {
      turn_id: "turn-1",
      tool_id: "tool-1",
      tool_name: "exec_command",
      output,
    },
  }
}

describe("readThreadActivityFullOutput", () => {
  it("returns the whole output of a bounded tool activity from the journal", () => {
    const { activities, events, ingest } = setup()
    const output = `start\n${"0123456789abcdef\n".repeat(20_000)}end`
    const activity = ingest(toolResult(output), 5)
    expect(
      (activity.payload as { outputTruncated?: boolean }).outputTruncated
    ).toBe(true)

    expect(
      readThreadActivityFullOutput(
        { activities, events },
        "thread-1",
        activity.activity_id
      )
    ).toEqual({
      status: "found",
      activityId: activity.activity_id,
      output,
      bytes: Buffer.byteLength(output, "utf8"),
      truncated: false,
    })
  })

  it("says when the journal copy itself was bounded", () => {
    const { activities, events, ingest } = setup()
    // Over the journal's 1 MiB row limit: the journal keeps a cut copy.
    const output = "x".repeat(2 * 1024 * 1024)
    const activity = ingest(toolResult(output), 6)

    const result = readThreadActivityFullOutput(
      { activities, events },
      "thread-1",
      activity.activity_id
    )

    expect(result.status).toBe("found")
    if (result.status !== "found") return
    expect(result.truncated).toBe(true)
    expect(typeof result.output).toBe("string")
    expect((result.output as string).length).toBeLessThan(output.length)
    expect(result.bytes).toBe((result.output as string).length)
  })

  it("does not reveal an activity through another thread's path", () => {
    const { activities, events, ingest } = setup()
    const activity = ingest(toolResult("x".repeat(200_000)), 7)

    expect(
      readThreadActivityFullOutput(
        { activities, events },
        "thread-2",
        activity.activity_id
      )
    ).toEqual({ status: "not_found" })
  })

  it("reports output the journal no longer retains", () => {
    const { db, activities, events, ingest } = setup()
    const activity = ingest(toolResult("x".repeat(200_000)), 8)
    db.prepare("DELETE FROM orchestration_events").run()

    expect(
      readThreadActivityFullOutput(
        { activities, events },
        "thread-1",
        activity.activity_id
      )
    ).toEqual({ status: "not_retained" })
  })

  it("has no output for activities that are not tool calls", () => {
    const { activities, events, ingest } = setup()
    const activity = ingest(
      {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1", status: "completed" },
      },
      9
    )

    expect(
      readThreadActivityFullOutput(
        { activities, events },
        "thread-1",
        activity.activity_id
      )
    ).toEqual({ status: "no_output" })
  })
})
