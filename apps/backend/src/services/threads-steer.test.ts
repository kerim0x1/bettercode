import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { ThreadService, type ThreadUserMessageDispatchRequest } from "./threads"

function userMessage(
  id: string,
  content: string,
  createdAt: string
): ThreadUserMessageDispatchRequest {
  return {
    thread_id: "thread-steer",
    title: "New Chat",
    project_name: "BetterC0de",
    project_path: "/repo",
    created_at: createdAt,
    message: {
      message_id: id,
      turn_id: null,
      role: "user",
      content,
      created_at: createdAt,
      extra: {},
    },
  }
}

describe("a message steered into a running turn", () => {
  let db: Db
  let svc: ThreadService
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-steer-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    svc = new ThreadService(db)
    svc.persistUserMessageForTurn(
      userMessage(
        "turn-user",
        "Refactor the parser",
        "2026-10-20T10:00:00.000Z"
      )
    )
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const order = () =>
    (svc.listMessages("thread-steer") as Array<{ id: string }>).map(
      (message) => message.id
    )

  it("goes in front of the turn's answer stored so far, also when repeated", () => {
    svc.upsertMessage({
      thread_id: "thread-steer",
      message: {
        message_id: "turn-answer",
        turn_id: "turn-1",
        role: "assistant",
        content: "Reading the parser…",
        created_at: "2026-10-20T10:00:01.000Z",
        extra: {},
      },
    })
    const steer = userMessage(
      "steer-1",
      "Keep the public API",
      "2026-10-20T10:00:05.000Z"
    )

    svc.persistSteeredUserMessage(steer, "turn-user")
    svc.persistSteeredUserMessage(steer, "turn-user")

    expect(order()).toEqual(["turn-user", "steer-1", "turn-answer"])
  })

  it("stays last while the turn has no stored answer, or without its turn", () => {
    svc.persistSteeredUserMessage(
      userMessage("steer-1", "Keep the public API", "2026-10-20T10:00:05.000Z"),
      "turn-user"
    )
    svc.persistSteeredUserMessage(
      userMessage("steer-2", "And add tests", "2026-10-20T10:00:06.000Z"),
      null
    )

    expect(order()).toEqual(["turn-user", "steer-1", "steer-2"])
  })
})
