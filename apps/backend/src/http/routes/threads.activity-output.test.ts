import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { openDatabase, type Db } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import { ThreadActivityProjectionQuery } from "../../persistence/projections"
import { projectProviderEventToThreadActivity } from "../../provider/activity-projection"
import { legacyJournalEntry } from "../../provider/runtime/journalEntry"
import { ProviderRuntimeEventJournal } from "../../provider/runtime/ProviderRuntimeEventJournal"
import { registerThreadsRoutes as registerThreadsRoutesUnfilled } from "./threads"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerThreadsRoutes = withInertStateArgument(
  registerThreadsRoutesUnfilled,
  1
)

const databases: Array<{ db: Db; dir: string }> = []
afterEach(() => {
  for (const { db, dir } of databases.splice(0)) {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function appWithJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-activity-output-"))
  const db = openDatabase(path.join(dir, "test.sqlite"))
  runMigrations(db)
  databases.push({ db, dir })
  const eventStore = new EventStore(db)
  const threadActivities = new ThreadActivityProjectionQuery(db)
  const journal = new ProviderRuntimeEventJournal(eventStore)
  const app = new Hono()
  registerThreadsRoutes(app, {
    eventStore,
    threadActivities,
  } as unknown as AppState)
  return { app, journal, threadActivities }
}

describe("GET /threads/:id/activities/:activityId/output", () => {
  it("returns the full output behind a bounded tool activity", async () => {
    const { app, journal, threadActivities } = appWithJournal()
    const output = `${"build log line\n".repeat(30_000)}done`
    const persisted = journal.persist(
      legacyJournalEntry({
        event_type: "tool_result",
        thread_id: "thread-1",
        payload: { tool_id: "tool-1", tool_name: "exec_command", output },
      }),
      11
    )
    if (persisted.entry.shape !== "legacy") throw new Error("expected legacy")
    const activity = projectProviderEventToThreadActivity(
      persisted.entry.event,
      11
    )!
    threadActivities.upsert(activity)

    const response = await app.request(
      `/threads/thread-1/activities/${encodeURIComponent(activity.activity_id)}/output`
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      activityId: activity.activity_id,
      output,
      truncated: false,
      bytes: Buffer.byteLength(output, "utf8"),
    })
  })

  it("answers 404 with a code for each missing case", async () => {
    const findById = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        activity_id: "a-2",
        thread_id: "thread-1",
        turn_id: null,
        kind: "turn.completed",
        tone: "info",
        summary: "Turn completed",
        payload: {},
        sequence: 3,
        created_at: "2026-10-07T00:00:00.000Z",
      })
      .mockReturnValueOnce({
        activity_id: "a-3",
        thread_id: "thread-1",
        turn_id: null,
        kind: "tool.completed",
        tone: "tool",
        summary: "Ran command",
        payload: { outputTruncated: true },
        sequence: 4,
        created_at: "2026-10-07T00:00:00.000Z",
      })
    const app = new Hono()
    registerThreadsRoutes(app, {
      threadActivities: { findById },
      eventStore: { readProviderRuntimeByStreamVersion: () => [] },
    } as unknown as AppState)

    const codes: unknown[] = []
    for (const id of ["a-1", "a-2", "a-3"]) {
      const response = await app.request(
        `/threads/thread-1/activities/${id}/output`
      )
      expect(response.status).toBe(404)
      codes.push(((await response.json()) as { code?: unknown }).code)
    }
    expect(codes).toEqual([
      "activity_not_found",
      "activity_output_not_found",
      "activity_output_not_retained",
    ])
    expect(findById).toHaveBeenNthCalledWith(1, "thread-1", "a-1")
  })
})
