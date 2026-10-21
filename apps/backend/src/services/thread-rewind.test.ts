import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { ThreadService } from "./threads"
import type { ThreadSaveMessage } from "./threads/types"
import {
  changedFilesFromDiffs,
  checkpointTurnBeforeMessage,
  providerRewindAction,
  readRewindTurns,
  readThreadRewindAnchor,
} from "./thread-rewind"

function diffFor(...files: string[]): string {
  return files
    .map((file) =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n")
    )
    .join("\n")
}

describe("checkpointTurnBeforeMessage", () => {
  const turns = [
    { turnIndex: 1, boundarySequence: 1 },
    { turnIndex: 2, boundarySequence: 3 },
    { turnIndex: 3, boundarySequence: 5 },
  ]

  it("returns the last turn that ended before the message", () => {
    // user 0, answer 1 (turn 1), user 2, answer 3 (turn 2), user 4, answer 5
    expect(checkpointTurnBeforeMessage(4, turns)).toBe(2)
    expect(checkpointTurnBeforeMessage(2, turns)).toBe(1)
  })

  it("goes back to the folder before the first turn for the first message", () => {
    expect(checkpointTurnBeforeMessage(0, turns)).toBe(0)
    expect(checkpointTurnBeforeMessage(0, [])).toBe(0)
  })

  it("ignores the order the rows arrive in", () => {
    expect(checkpointTurnBeforeMessage(4, [...turns].reverse())).toBe(2)
  })

  it("does not know the point when an earlier turn's end is unknown", () => {
    expect(
      checkpointTurnBeforeMessage(4, [
        { turnIndex: 1, boundarySequence: -1 },
        { turnIndex: 2, boundarySequence: 3 },
      ])
    ).toBeNull()
  })

  it("is not confused by an unknown turn after the message", () => {
    expect(
      checkpointTurnBeforeMessage(2, [
        { turnIndex: 1, boundarySequence: 1 },
        { turnIndex: 2, boundarySequence: 3 },
        { turnIndex: 3, boundarySequence: -1 },
      ])
    ).toBe(1)
  })
})

describe("changedFilesFromDiffs", () => {
  it("lists each file once across turns", () => {
    expect(
      changedFilesFromDiffs([diffFor("b.ts", "a.ts"), diffFor("a.ts", "c.ts")])
    ).toEqual({ files: ["a.ts", "b.ts", "c.ts"], truncated: false })
  })

  it("caps the list and says so", () => {
    expect(changedFilesFromDiffs([diffFor("a.ts", "b.ts", "c.ts")], 2)).toEqual(
      { files: ["a.ts", "b.ts"], truncated: true }
    )
  })

  it("reads nothing from an empty or missing diff", () => {
    expect(changedFilesFromDiffs(["", "   "])).toEqual({
      files: [],
      truncated: false,
    })
  })
})

describe("providerRewindAction", () => {
  it("leaves the session alone when no turn reached the agent", () => {
    expect(
      providerRewindAction({
        assistantTurns: 0,
        dispatchedTurns: 0,
        crossesSessionBoundary: false,
      })
    ).toEqual({ kind: "none" })
  })

  it("rolls back the answered turns", () => {
    expect(
      providerRewindAction({
        assistantTurns: 2,
        dispatchedTurns: 2,
        crossesSessionBoundary: false,
      })
    ).toEqual({ kind: "rollback", turns: 2 })
    // Providers without dispatch records still roll back what answered.
    expect(
      providerRewindAction({
        assistantTurns: 1,
        dispatchedTurns: 0,
        crossesSessionBoundary: false,
      })
    ).toEqual({ kind: "rollback", turns: 1 })
  })

  it("resets the session when the turn count is in doubt", () => {
    // A dispatched turn that never answered may still be in the session.
    expect(
      providerRewindAction({
        assistantTurns: 0,
        dispatchedTurns: 1,
        crossesSessionBoundary: false,
      })
    ).toEqual({ kind: "reset" })
    // A compaction or handoff started a new session inside the range.
    expect(
      providerRewindAction({
        assistantTurns: 3,
        dispatchedTurns: 3,
        crossesSessionBoundary: true,
      })
    ).toEqual({ kind: "reset" })
  })
})

describe("rewind reads and truncation", () => {
  let db: Db
  let threads: ThreadService
  let directory: string
  const createdAt = (second: number) =>
    `2026-10-20T10:00:${String(second).padStart(2, "0")}.000Z`

  function message(
    id: string,
    role: "user" | "assistant",
    second: number,
    overrides: Partial<ThreadSaveMessage> = {}
  ): ThreadSaveMessage {
    return {
      message_id: id,
      turn_id: null,
      role,
      content: id,
      created_at: createdAt(second),
      extra: {},
      ...overrides,
    }
  }

  function sequenceOf(messageId: string): number {
    return (
      db
        .prepare(
          "SELECT sequence FROM projection_messages WHERE message_id = ?"
        )
        .get(messageId) as { sequence: number }
    ).sequence
  }

  function insertTurn(turnIndex: number, boundaryMessageId: string): void {
    db.prepare(
      `INSERT INTO turn_diffs(
         thread_id, turn_index, diff_text, files_changed, created_at,
         boundary_message_id, boundary_sequence
       ) VALUES ('thread-1', ?, ?, 1, ?, ?, ?)`
    ).run(
      turnIndex,
      diffFor(`file-${turnIndex}.ts`),
      createdAt(turnIndex),
      boundaryMessageId,
      sequenceOf(boundaryMessageId)
    )
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-rewind-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    threads = new ThreadService(db)
    threads.save({
      thread_id: "thread-1",
      title: "Thread",
      project_name: "project",
      project_path: "/repo",
      created_at: createdAt(0),
      updated_at: createdAt(10),
      codex_thread_id: null,
      messages: [
        message("user-1", "user", 1),
        message("answer-1", "assistant", 2, { turn_id: "turn-1" }),
        message("user-2", "user", 3),
        message("answer-2", "assistant", 4, { turn_id: "turn-2" }),
        message("compact-2", "assistant", 5, {
          extra: { compactedContext: true },
        }),
        message("user-3", "user", 6),
        message("answer-3", "assistant", 7, { turn_id: "turn-3" }),
      ],
    })
    insertTurn(1, "answer-1")
    insertTurn(2, "answer-2")
    insertTurn(3, "answer-3")
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it("describes the range from the edited message on", () => {
    const anchor = readThreadRewindAnchor(db, "thread-1", "user-2")
    expect(anchor).toMatchObject({
      role: "user",
      sequence: sequenceOf("user-2"),
      removedMessages: 5,
      assistantTurns: 2,
      dispatchedTurns: 0,
      crossesSessionBoundary: true,
    })
    expect(readThreadRewindAnchor(db, "thread-1", "user-3")).toMatchObject({
      removedMessages: 2,
      assistantTurns: 1,
      crossesSessionBoundary: false,
    })
    expect(readThreadRewindAnchor(db, "thread-1", "missing")).toBeNull()
  })

  it("finds the checkpoint before the edited message", () => {
    const turns = readRewindTurns(db, "thread-1")
    expect(turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3])
    expect(checkpointTurnBeforeMessage(sequenceOf("user-2"), turns)).toBe(1)
    expect(checkpointTurnBeforeMessage(sequenceOf("user-1"), turns)).toBe(0)
  })

  it("removes the edited message and everything after it", () => {
    const result = threads.truncateFromMessage({
      thread_id: "thread-1",
      message_id: "user-2",
      updated_at: createdAt(20),
    })
    expect(result.deletedMessages).toBe(5)
    const remaining = (
      db
        .prepare(
          `SELECT message_id FROM projection_messages
           WHERE thread_id = 'thread-1' ORDER BY sequence`
        )
        .all() as Array<{ message_id: string }>
    ).map((row) => row.message_id)
    expect(remaining).toEqual(["user-1", "answer-1"])
    // Only the checkpoint of the kept turn is left.
    expect(
      readRewindTurns(db, "thread-1").map((turn) => turn.turnIndex)
    ).toEqual([1])
  })

  it("can remove the whole chat from its first message", () => {
    expect(
      threads.truncateFromMessage({
        thread_id: "thread-1",
        message_id: "user-1",
        updated_at: createdAt(20),
      }).deletedMessages
    ).toBe(7)
    expect(readRewindTurns(db, "thread-1")).toEqual([])
  })
})
