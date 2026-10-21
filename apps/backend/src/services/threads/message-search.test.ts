import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CHAT_FIND_MATCH_LIMIT,
  chatFindPattern,
  chatFindRanges,
  chatFindSnippet,
  isChatFindMessage,
} from "@betterc0de/schema"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import {
  searchStoredMessages,
  type StoredMessageSearchRow,
} from "./message-search"
import { ThreadService } from "./service"
import type { ThreadSaveMessage } from "./types"

const CREATED_AT = "2026-01-01T00:00:00.000Z"

/** Rows newest first, shaped as `searchMessagesStmt` reads them. */
function rows(
  messages: Array<{
    id: string
    role?: string
    text: string
    extra?: { internalContext?: string; compactedContext?: boolean }
  }>
): StoredMessageSearchRow[] {
  return messages
    .map((message, sequence) => ({
      message_id: message.id,
      role: message.role ?? "assistant",
      created_at: CREATED_AT,
      sequence,
      search_fields: JSON.stringify([
        message.text,
        message.extra?.internalContext ?? null,
        message.extra?.compactedContext ?? null,
      ]),
    }))
    .reverse()
}

describe("chatFindPattern", () => {
  it("matches text literally, ignoring case unless asked", () => {
    const pattern = chatFindPattern("a.b (c)")!
    expect(chatFindRanges("A.B (C) and axb (c)", pattern)).toEqual([[0, 7]])
    const sensitive = chatFindPattern("Foo", { caseSensitive: true })!
    expect(chatFindRanges("foo Foo FOO", sensitive)).toEqual([[4, 7]])
  })

  it("lets a space in the query match any run of whitespace", () => {
    const pattern = chatFindPattern("find  me")!
    expect(chatFindRanges("find\n  me, find me", pattern)).toEqual([
      [0, 9],
      [11, 18],
    ])
  })

  it("has nothing to search for in an empty or blank query", () => {
    expect(chatFindPattern("")).toBeNull()
    expect(chatFindPattern("   ")).toBeNull()
  })

  it("stops counting at the limit", () => {
    expect(chatFindRanges("aaaa", chatFindPattern("a")!, 2)).toEqual([
      [0, 1],
      [1, 2],
    ])
  })
})

describe("isChatFindMessage", () => {
  it("searches user and assistant messages but not handoff checkpoints", () => {
    expect(isChatFindMessage({ role: "user", content: "hi" })).toBe(true)
    expect(isChatFindMessage({ role: "assistant", content: "hi" })).toBe(true)
    expect(isChatFindMessage({ role: "tool", content: "hi" })).toBe(false)
    expect(
      isChatFindMessage({
        role: "assistant",
        content: "summary",
        internalContext: "provider-handoff",
      })
    ).toBe(false)
    expect(
      isChatFindMessage({
        role: "assistant",
        content: "# Provider Handoff\n\nPrepared by Claude",
        compactedContext: true,
      })
    ).toBe(false)
    expect(
      isChatFindMessage({
        role: "user",
        content: "Provider handoff: claude → codex",
      })
    ).toBe(false)
  })
})

describe("chatFindSnippet", () => {
  it("keeps one line around the match and marks cut ends", () => {
    const text = `${"x".repeat(60)} the needle\nis here ${"y".repeat(60)}`
    const start = text.indexOf("needle")
    const snippet = chatFindSnippet(text, start, start + 6, 10)
    expect(snippet).toBe("…xxxxx the needle is here y…")
  })
})

describe("searchStoredMessages", () => {
  it("returns matching messages oldest first with every match counted", () => {
    const result = searchStoredMessages(
      rows([
        { id: "m-0", role: "user", text: "Deploy the app" },
        { id: "m-1", text: "No match here" },
        { id: "m-2", text: "deploy, deploy and DEPLOY" },
      ]),
      { query: "deploy" }
    )
    expect(result.hits.map((hit) => [hit.messageId, hit.matchCount])).toEqual([
      ["m-0", 1],
      ["m-2", 3],
    ])
    expect(result.hits[0]).toMatchObject({
      role: "user",
      sequence: 0,
      createdAt: CREATED_AT,
      snippet: "Deploy the app",
    })
    expect(result.totalMatches).toBe(4)
    expect(result.truncated).toBe(false)
  })

  it("skips hidden handoff checkpoints and non-chat roles", () => {
    const result = searchStoredMessages(
      rows([
        {
          id: "handoff",
          text: "deploy notes",
          extra: { internalContext: "provider-handoff" },
        },
        { id: "tool", role: "tool", text: "deploy log" },
        { id: "shown", text: "deploy" },
      ]),
      { query: "deploy" }
    )
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["shown"])
  })

  it("keeps the newest matches and flags older ones past the limit", () => {
    const result = searchStoredMessages(
      rows([
        { id: "oldest", text: "word" },
        { id: "older", text: "word word" },
        { id: "newer", text: "word word" },
      ]),
      { query: "word", limit: 3 }
    )
    // Counting stops after the message that crosses the limit; that message
    // keeps its full count so the client can number its matches.
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["older", "newer"])
    expect(result.totalMatches).toBe(4)
    expect(result.truncated).toBe(true)
  })

  it("flags an exact limit only when an older match exists", () => {
    const exact = searchStoredMessages(
      rows([
        { id: "none", text: "nothing" },
        { id: "two", text: "word word" },
      ]),
      { query: "word", limit: 2 }
    )
    expect(exact.truncated).toBe(false)
    const more = searchStoredMessages(
      rows([
        { id: "one", text: "word" },
        { id: "two", text: "word word" },
      ]),
      { query: "word", limit: 2 }
    )
    expect(more.hits.map((hit) => hit.messageId)).toEqual(["two"])
    expect(more.truncated).toBe(true)
  })

  it("passes over a row whose stored JSON could not be read", () => {
    const [broken, ...rest] = rows([
      { id: "broken", text: "deploy" },
      { id: "fine", text: "deploy" },
    ]).reverse()
    const result = searchStoredMessages(
      [...rest, { ...broken, search_fields: null }],
      { query: "deploy" }
    )
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["fine"])
  })

  it("never counts beyond the shared limit", () => {
    const text = "a ".repeat(CHAT_FIND_MATCH_LIMIT + 5)
    const result = searchStoredMessages(
      rows([
        { id: "first", text: "a" },
        { id: "many", text },
      ]),
      { query: "a", limit: 50_000 }
    )
    expect(result.hits.map((hit) => hit.messageId)).toEqual(["many"])
    expect(result.truncated).toBe(true)
  })
})

describe("ThreadService.searchMessages", () => {
  let db: Db
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-thread-search-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function message(
    id: string,
    role: "user" | "assistant",
    content: string,
    extra: Record<string, unknown> = {}
  ): ThreadSaveMessage {
    return {
      message_id: id,
      turn_id: null,
      role,
      content,
      created_at: CREATED_AT,
      extra,
    }
  }

  it("searches only the messages before the client's cursor", () => {
    const svc = new ThreadService(db)
    svc.save({
      thread_id: "thread-1",
      title: "Thread",
      project_name: "project",
      project_path: "/repo",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      codex_thread_id: null,
      messages: [
        message("m-0", "user", "where is the config?"),
        message("m-1", "assistant", "The config is in config.ts"),
        message("m-2", "user", "thanks"),
        message("m-3", "assistant", "config updated"),
      ],
    })

    const all = svc.searchMessages("thread-1", { query: "config" })
    expect(all.hits.map((hit) => [hit.messageId, hit.matchCount])).toEqual([
      ["m-0", 1],
      ["m-1", 2],
      ["m-3", 1],
    ])
    expect(all.hits.map((hit) => hit.sequence)).toEqual([0, 1, 3])

    const older = svc.searchMessages("thread-1", {
      query: "config",
      beforeSequence: 2,
    })
    expect(older.hits.map((hit) => hit.messageId)).toEqual(["m-0", "m-1"])

    expect(
      svc.searchMessages("thread-1", { query: "CONFIG", caseSensitive: true })
        .hits
    ).toEqual([])
    expect(svc.searchMessages("missing", { query: "config" }).hits).toEqual([])
  })

  it("reads a thread's rows through its sequence index", () => {
    const svc = new ThreadService(db)
    // The service compiles its SQL through `prepareThreadStatements` and
    // keeps the result in a private `stmts` bag.
    const { source } = (
      svc as unknown as { stmts: Record<string, { source: string }> }
    ).stmts.searchMessagesStmt
    const params = Array.from(
      { length: (source.match(/\?/g) ?? []).length },
      () => "x"
    )
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as Array<{
        detail: string
      }>
    )
      .map((row) => row.detail)
      .join("\n")
    expect(plan).toMatch(/idx_messages_thread_seq/)
    expect(plan).not.toContain("USE TEMP B-TREE")
  })

  it("reads the text and the hiding flags out of the stored JSON", () => {
    const svc = new ThreadService(db)
    svc.save({
      thread_id: "thread-1",
      title: "Thread",
      project_name: "project",
      project_path: "/repo",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      codex_thread_id: null,
      messages: [
        message("m-0", "user", "config please", {
          attachments: [
            {
              type: "image",
              filename: "config.png",
              mediaType: "image/png",
              url: `data:image/png;base64,${"A".repeat(4096)}`,
            },
          ],
        }),
        message("m-1", "assistant", "config summary", {
          internalContext: "provider-handoff",
        }),
        message("m-2", "assistant", "config done"),
      ],
    })
    // A row written before the JSON was validated.
    db.prepare(
      "UPDATE projection_messages SET content_json = ? WHERE message_id = ?"
    ).run("{not json", "m-2")

    const result = svc.searchMessages("thread-1", { query: "config" })
    expect(result.hits.map((hit) => [hit.messageId, hit.matchCount])).toEqual([
      ["m-0", 1],
    ])
  })
})
