import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ThreadResume } from "@betterc0de/schema"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { ThreadService } from "../threads"
import {
  parseResumeRecord,
  parseResumeTurnState,
  SqliteChatResumeStore,
} from "./resume-store"

const tempDirs: string[] = []
const createdAt = "2026-10-20T10:00:00.000Z"

const record: ThreadResume = {
  reason: "usage_limit",
  stoppedAt: 1_792_490_400_000,
  resetAt: 1_792_501_200_000,
  mode: "auto",
  resumeAt: 1_792_501_230_000,
  status: "waiting",
  failures: 0,
  resumable: true,
  providerKind: "claude",
  note: null,
}

describe("SqliteChatResumeStore", () => {
  let db: Db
  let threads: ThreadService
  let store: SqliteChatResumeStore

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-resume-"))
    tempDirs.push(dir)
    db = openDatabase(path.join(dir, "state.db"))
    runMigrations(db)
    threads = new ThreadService(db)
    store = new SqliteChatResumeStore(db)
    threads.persistUserMessageForTurn({
      thread_id: "thread",
      title: "Limited chat",
      project_name: "Project",
      project_path: "",
      created_at: createdAt,
      message: {
        message_id: "message-1",
        turn_id: null,
        role: "user",
        content: "Continue.",
        created_at: createdAt,
        extra: { modelId: "claude-opus-4-7" },
      },
    })
  })

  afterEach(() => {
    db.close()
    for (const dir of tempDirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true })
  })

  it("keeps the record with the chat and lists it with the thread", () => {
    expect(store.hasThread("thread")).toBe(true)
    expect(store.hasThread("missing")).toBe(false)
    store.writeRecord("thread", record)
    expect(store.readRecord("thread")).toEqual(record)
    expect(threads.getThreadSummary("thread")).toMatchObject({
      resume: record,
    })
    store.writeRecord("thread", null)
    expect(store.readRecord("thread")).toBeNull()
    expect(threads.getThreadSummary("thread")).not.toHaveProperty("resume")
  })

  it("lists chats with a record or a running turn for startup", () => {
    expect(store.listPending()).toEqual([])
    store.writeTurnState("thread", {
      template: { model_id: "claude-opus-4-7" },
      restartContinuations: 0,
      running: {
        turnId: "turn-1",
        origin: "user",
        startedAt: 1,
        providerKind: "claude",
        providerInstanceId: "claude",
        waitingForApproval: false,
      },
    })
    expect(store.listPending()).toEqual([
      {
        threadId: "thread",
        record: null,
        turn: expect.objectContaining({
          running: expect.objectContaining({ turnId: "turn-1" }),
        }),
      },
    ])
    // The settings alone are not pending, and an empty state is no state.
    store.writeTurnState("thread", { template: { model_id: "m" } })
    expect(store.listPending()).toEqual([])
    store.writeTurnState("thread", {})
    expect(store.readTurnState("thread")).toBeNull()
  })

  it("marks a message the scheduler sent", () => {
    store.markAutomatic("thread", "message-1", "usage-limit")
    expect(threads.listMessages("thread")).toEqual([
      expect.objectContaining({ id: "message-1", automatic: "usage-limit" }),
    ])
  })
})

describe("stored state that no longer reads", () => {
  it("is dropped, not trusted", () => {
    expect(parseResumeRecord("{")).toBeNull()
    expect(parseResumeRecord(JSON.stringify({ reason: "nope" }))).toBeNull()
    expect(parseResumeTurnState("[]")).toBeNull()
    expect(
      parseResumeTurnState(
        JSON.stringify({
          template: "not settings",
          running: { startedAt: 5, origin: "someone", turnId: 7 },
        })
      )
    ).toEqual({
      running: {
        turnId: null,
        origin: null,
        startedAt: 5,
        providerKind: null,
        providerInstanceId: null,
        waitingForApproval: false,
      },
    })
  })
})
