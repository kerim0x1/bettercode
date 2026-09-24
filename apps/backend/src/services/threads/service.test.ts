import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { logger } from "../../observability/logger"
import { HttpError } from "../../errors"
import { ThreadService } from "./service"
import { parseThreadSaveMessage } from "./parsers"
import type { ThreadSaveMessage, ThreadSaveRequest } from "./types"

const CREATED_AT = "2026-01-01T00:00:00.000Z"

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  overrides: Partial<ThreadSaveMessage> = {}
): ThreadSaveMessage {
  return {
    message_id: id,
    turn_id: null,
    role,
    content,
    created_at: CREATED_AT,
    extra: {},
    ...overrides,
  }
}

function saveRequest(messages: ThreadSaveMessage[]): ThreadSaveRequest {
  return {
    thread_id: "thread-1",
    title: "Thread",
    project_name: "project",
    project_path: "/repo",
    created_at: CREATED_AT,
    updated_at: "2026-01-01T00:05:00.000Z",
    codex_thread_id: null,
    messages,
  }
}

function explain(db: Db, sql: string): string[] {
  const params = Array.from(
    { length: (sql.match(/\?/g) ?? []).length },
    () => "x"
  )
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string
    }>
  ).map((row) => row.detail)
}

function statementSource(service: ThreadService, name: string): string {
  // The service compiles its SQL through `prepareThreadStatements` and
  // keeps the result in a private `stmts` bag.
  const statement = (
    service as unknown as { stmts: Record<string, { source: string }> }
  ).stmts[name]
  if (!statement) throw new Error(`unknown statement ${name}`)
  return statement.source
}

describe("ThreadService.save protects runtime-authored rows", () => {
  let db: Db
  let svc: ThreadService
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-thread-save-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    svc = new ThreadService(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const streamedAssistant = (overrides: Partial<ThreadSaveMessage> = {}) =>
    message("assistant-1", "assistant", "streamed answer", {
      turn_id: "turn-1",
      created_at: "2026-01-01T00:00:01.000Z",
      extra: {
        providerRuntimeSequence: 7,
        modelId: "claude-opus-4-6",
        toolCalls: [{ id: "t-1", name: "Read", input: {} }],
      },
      ...overrides,
    })

  const storedRows = () =>
    db
      .prepare(
        `SELECT message_id, sequence FROM projection_messages
         WHERE thread_id = 'thread-1' ORDER BY sequence`
      )
      .all()

  const expectProtected = (run: () => void) => {
    let error: unknown
    try {
      run()
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({
      statusCode: 409,
      code: "runtime_message_protected",
    })
  }

  it.each(["runtime", "compaction"])(
    "protects %s rows from incremental renderer rewrites",
    (owner) => {
      const original = streamedAssistant({
        extra:
          owner === "runtime"
            ? { providerRuntimeSequence: 7, modelId: "runtime-model" }
            : { compactedContext: true, compactionRequestId: "compact-1" },
      })
      svc.save(saveRequest([original]))
      const rendererCopy = (overrides: Record<string, unknown> = {}) =>
        parseThreadSaveMessage({
          id: original.message_id,
          turnId: original.turn_id,
          role: original.role,
          content: original.content,
          createdAt: CREATED_AT,
          modelId: "stale-model",
          providerRuntimeSequence: 999,
          extra: { providerRuntimeSequence: 999 },
          ...overrides,
        })
      for (const override of [
        { content: "stale text" },
        { turnId: "other-turn" },
        { role: "user" },
      ]) {
        expectProtected(() =>
          svc.upsertMessage({
            thread_id: "thread-1",
            message: rendererCopy(override),
          })
        )
      }
      svc.upsertMessage({ thread_id: "thread-1", message: rendererCopy() })
      expect(svc.getMessage("thread-1", original.message_id)).toMatchObject({
        content: original.content,
        created_at: original.created_at,
        extra: original.extra,
      })
    }
  )

  it("accepts newer runtime snapshots while preserving their ordering", () => {
    svc.save(saveRequest([streamedAssistant()]))
    svc.upsertMessage({
      thread_id: "thread-1",
      message: streamedAssistant({
        content: "finished answer",
        extra: { providerRuntimeSequence: 8 },
      }),
    })
    svc.upsertMessage({ thread_id: "thread-1", message: streamedAssistant() })
    expect(svc.getMessage("thread-1", "assistant-1")).toMatchObject({
      content: "finished answer",
      extra: { providerRuntimeSequence: 8 },
    })
  })

  it.each(["__proto__", "constructor", "toString"])(
    "aggregates reserved model and tool name %s",
    (name) => {
      svc.save(
        saveRequest([
          message("assistant-1", "assistant", "answer", {
            extra: {
              modelId: name,
              toolCalls: [{ id: "tool-1", name, input: {} }],
            },
          }),
        ])
      )
      for (const stats of [svc.stats(), svc.stats()]) {
        expect(Object.hasOwn(stats.modelUsage, name)).toBe(true)
        expect(stats.modelUsage[name].messages).toBe(1)
        expect(Object.hasOwn(stats.toolUsage, name)).toBe(true)
        expect(stats.toolUsage[name]).toBe(1)
      }
    }
  )

  // Regression: compaction checkpoints carry no runtime sequence and are not
  // dispatch rows, so a stale renderer snapshot that predated the `/compact`
  // deleted the checkpoint on its next full save — and with it the whole
  // compaction window, so the next turn resent the full transcript.
  it("refuses a full save that omits a compaction checkpoint row and leaves it intact", () => {
    svc.save(
      saveRequest([
        message("user-1", "user", "hello"),
        message("assistant-1", "assistant", "hi there", {
          created_at: "2026-01-01T00:00:01.000Z",
        }),
      ])
    )
    const committed = svc.commitCompaction({
      thread_id: "thread-1",
      request_id: "compaction-1",
      command_message: message("command-1", "user", "/compact", {
        created_at: "2026-01-01T00:00:02.000Z",
      }),
      checkpoint_message: message(
        "compaction-1",
        "assistant",
        "## Compacted context\n\nsummary",
        { created_at: "2026-01-01T00:00:03.000Z" }
      ),
    })
    expect(committed.alreadyCommitted).toBe(false)
    // No runtime marker: the row is protected by its compaction flag alone.
    const usage = db
      .prepare(
        "SELECT runtime_sequence FROM projection_message_usage WHERE message_id = 'compaction-1'"
      )
      .get() as { runtime_sequence: number | null } | undefined
    expect(usage?.runtime_sequence ?? null).toBeNull()

    // Snapshot from before the compaction plus a newly typed message.
    expectProtected(() =>
      svc.save(
        saveRequest([
          message("user-1", "user", "hello"),
          message("assistant-1", "assistant", "hi there", {
            created_at: "2026-01-01T00:00:01.000Z",
          }),
          message("user-2", "user", "follow-up", {
            created_at: "2026-01-01T00:00:04.000Z",
          }),
        ])
      )
    )
    expect(storedRows()).toEqual([
      { message_id: "user-1", sequence: 0 },
      { message_id: "assistant-1", sequence: 1 },
      { message_id: "command-1", sequence: 2 },
      { message_id: "compaction-1", sequence: 3 },
    ])

    // Rewriting the checkpoint's text is refused as well.
    expectProtected(() =>
      svc.save(
        saveRequest([
          message("user-1", "user", "hello"),
          message("assistant-1", "assistant", "hi there"),
          message("command-1", "user", "/compact"),
          message("compaction-1", "assistant", "edited summary"),
        ])
      )
    )

    // A save that carries the checkpoint unchanged goes through, keeps the
    // compaction marker, and may append after it.
    svc.save(
      saveRequest([
        message("user-1", "user", "hello"),
        message("assistant-1", "assistant", "hi there"),
        message("command-1", "user", "/compact"),
        message("compaction-1", "assistant", "## Compacted context\n\nsummary"),
        message("user-2", "user", "follow-up", {
          created_at: "2026-01-01T00:00:04.000Z",
        }),
      ])
    )
    expect(storedRows()).toEqual([
      { message_id: "user-1", sequence: 0 },
      { message_id: "assistant-1", sequence: 1 },
      { message_id: "command-1", sequence: 2 },
      { message_id: "compaction-1", sequence: 3 },
      { message_id: "user-2", sequence: 4 },
    ])
    const stored = db
      .prepare(
        "SELECT content_json FROM projection_messages WHERE message_id = 'compaction-1'"
      )
      .get() as { content_json: string }
    expect(JSON.parse(stored.content_json).extra).toMatchObject({
      compactedContext: true,
      compactionRequestId: "compaction-1",
    })
  })

  it("refuses a full save that omits a streamed assistant row and leaves the row intact", () => {
    svc.save(saveRequest([message("user-1", "user", "hello")]))
    svc.upsertMessage({ thread_id: "thread-1", message: streamedAssistant() })
    expect(
      db
        .prepare(
          "SELECT runtime_sequence FROM projection_message_usage WHERE message_id = 'assistant-1'"
        )
        .get()
    ).toEqual({ runtime_sequence: 7 })

    // The renderer snapshot predates the assistant row: it still lists only
    // the user message plus a new one it just typed. That is a stale
    // snapshot, and the save must say so instead of quietly patching it.
    expectProtected(() =>
      svc.save(
        saveRequest([
          message("user-1", "user", "hello"),
          message("user-2", "user", "follow-up", {
            created_at: "2026-01-01T00:00:02.000Z",
          }),
        ])
      )
    )

    // Nothing from the refused save landed: no new row, no re-sequencing.
    expect(storedRows()).toEqual([
      { message_id: "user-1", sequence: 0 },
      { message_id: "assistant-1", sequence: 1 },
    ])
    expect(svc.getMessage("thread-1", "assistant-1")).toMatchObject({
      content: "streamed answer",
      extra: { modelId: "claude-opus-4-6" },
    })
  })

  it("refuses a full save that rewrites a streamed assistant row's text", () => {
    svc.upsertThreadMeta(saveRequest([]))
    svc.upsertMessage({ thread_id: "thread-1", message: streamedAssistant() })

    expectProtected(() =>
      svc.save(
        saveRequest([
          message("user-1", "user", "hello"),
          message("assistant-1", "assistant", "truncated stale copy", {
            turn_id: "turn-1",
          }),
        ])
      )
    )
    expectProtected(() =>
      svc.save(
        saveRequest([
          message("assistant-1", "assistant", "streamed answer", {
            turn_id: "another-turn",
          }),
        ])
      )
    )

    expect(svc.getMessage("thread-1", "assistant-1")).toMatchObject({
      content: "streamed answer",
      turn_id: "turn-1",
      extra: { toolCalls: [{ id: "t-1", name: "Read", input: {} }] },
    })
    expect(storedRows()).toEqual([{ message_id: "assistant-1", sequence: 0 }])
  })

  it("re-sequences a streamed assistant row the renderer sends back unchanged", () => {
    svc.upsertThreadMeta(saveRequest([]))
    svc.upsertMessage({ thread_id: "thread-1", message: streamedAssistant() })

    // The renderer's copy went through the save parser: the runtime marker
    // and the usage/tool payload are gone, only role, turn and text remain.
    svc.save(
      saveRequest([
        message("user-1", "user", "hello"),
        message("assistant-1", "assistant", "streamed answer", {
          turn_id: "turn-1",
          created_at: "2026-01-01T00:00:01.000Z",
        }),
      ])
    )

    expect(svc.getMessage("thread-1", "assistant-1")).toMatchObject({
      content: "streamed answer",
      extra: {
        providerRuntimeSequence: 7,
        modelId: "claude-opus-4-6",
        toolCalls: [{ id: "t-1", name: "Read", input: {} }],
      },
    })
    expect(storedRows()).toEqual([
      { message_id: "user-1", sequence: 0 },
      { message_id: "assistant-1", sequence: 1 },
    ])
  })

  it("deletes a renderer-authored assistant row the renderer removed", () => {
    // No runtime sequence: a slash-command reply or a forked copy.
    svc.save(
      saveRequest([
        message("user-1", "user", "/help"),
        message("assistant-help", "assistant", "Available commands: ..."),
      ])
    )
    expect(
      db
        .prepare(
          "SELECT runtime_sequence FROM projection_message_usage WHERE message_id = 'assistant-help'"
        )
        .get()
    ).toEqual({ runtime_sequence: null })

    svc.save(saveRequest([message("user-1", "user", "/help")]))
    expect(storedRows()).toEqual([{ message_id: "user-1", sequence: 0 }])
    expect(svc.getMessage("thread-1", "assistant-help")).toBeNull()
  })

  it("rewrites a renderer-authored assistant row from the renderer's copy", () => {
    svc.save(
      saveRequest([
        message("user-1", "user", "/help"),
        message("assistant-help", "assistant", "Available commands: ..."),
      ])
    )
    svc.save(
      saveRequest([
        message("user-1", "user", "/help"),
        message(
          "assistant-help",
          "assistant",
          "Available commands: /help, /clear",
          {
            extra: { modelId: "local-slash" },
          }
        ),
      ])
    )
    expect(svc.getMessage("thread-1", "assistant-help")).toMatchObject({
      content: "Available commands: /help, /clear",
      extra: { modelId: "local-slash" },
    })
  })

  it("still deletes renderer-authored rows the renderer removed", () => {
    svc.save(
      saveRequest([
        message("user-1", "user", "keep"),
        message("user-2", "user", "remove"),
      ])
    )
    svc.save(saveRequest([message("user-1", "user", "keep")]))
    expect(
      (svc.listMessages("thread-1") as Array<{ id: string }>).map(
        (entry) => entry.id
      )
    ).toEqual(["user-1"])
  })

  it("keeps turn_count consistent through save and truncate without a writer recompute", () => {
    svc.save(
      saveRequest([
        message("user-1", "user", "one"),
        message("assistant-1", "assistant", "a", { turn_id: "turn-1" }),
        message("user-2", "user", "two"),
        message("assistant-2", "assistant", "b", { turn_id: "turn-2" }),
      ])
    )
    const turnCount = () =>
      (
        db
          .prepare(
            "SELECT turn_count FROM projection_threads WHERE thread_id = 'thread-1'"
          )
          .get() as { turn_count: number }
      ).turn_count
    expect(turnCount()).toBe(2)

    svc.truncateAfterMessage({
      thread_id: "thread-1",
      message_id: "assistant-1",
      updated_at: "2026-01-01T00:06:00.000Z",
    })
    expect(turnCount()).toBe(1)

    svc.upsertMessage({
      thread_id: "thread-1",
      message: message("assistant-3", "assistant", "c", { turn_id: "turn-3" }),
    })
    expect(turnCount()).toBe(2)
  })

  it("logs corrupt stored JSON with the message identity instead of swallowing it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    svc.save(saveRequest([message("user-1", "user", "hello")]))
    db.prepare(
      `UPDATE projection_messages SET content_json = '{not json'
       WHERE message_id = 'user-1'`
    ).run()

    expect(svc.getMessage("thread-1", "user-1")).toMatchObject({
      content: "",
      extra: {},
    })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        messageId: "user-1",
        column: "content_json",
      }),
      expect.stringContaining("corrupt")
    )
  })
})

describe("ThreadService thread list query plan", () => {
  let db: Db
  let svc: ThreadService
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-thread-plan-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    svc = new ThreadService(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it("looks the latest binding up per page row instead of materialising every binding", () => {
    for (const name of ["listThreadsStmt", "listThreadsBeforeStmt"]) {
      const plan = explain(db, statementSource(svc, name)).join("\n")
      expect(plan, name).not.toContain("MATERIALIZE")
      expect(plan, name).not.toContain("USE TEMP B-TREE")
      expect(plan, name).toContain("idx_provider_bindings_thread_updated")
      expect(plan, name).toContain("idx_threads_status_page")
    }
  })

  it("keeps the per-thread message statements on an index after migration 49's drops", () => {
    const cases: Array<[string, RegExp]> = [
      ["listMessagesStmt", /idx_messages_thread_seq/],
      [
        "deleteMessagesStmt",
        /projection_messages USING (COVERING )?INDEX idx_messages_thread_/,
      ],
      ["listThreadsStmt", /idx_threads_status_page/],
    ]
    for (const [name, expected] of cases) {
      const plan = explain(db, statementSource(svc, name)).join("\n")
      expect(plan, name).toMatch(expected)
      expect(plan, name).not.toMatch(/^SCAN projection_/m)
      expect(plan, name).not.toContain("USE TEMP B-TREE")
    }
  })

  it("pages messages newest-first below a sequence cursor", () => {
    svc.save(
      saveRequest([
        message("m-0", "user", "zero"),
        message("m-1", "assistant", "one"),
        message("m-2", "user", "two"),
        message("m-3", "assistant", "three"),
      ])
    )
    const ids = (page: unknown[]) =>
      (page as Array<{ id: string }>).map((entry) => entry.id)
    expect(ids(svc.listMessages("thread-1", { limit: 2 }))).toEqual([
      "m-2",
      "m-3",
    ])
    expect(
      ids(svc.listMessages("thread-1", { limit: 2, beforeSequence: 2 }))
    ).toEqual(["m-0", "m-1"])
    expect(
      ids(svc.listMessages("thread-1", { limit: 2, beforeSequence: 0 }))
    ).toEqual([])
  })

  it("pages newest-first through the cursor and joins each thread's latest binding", () => {
    const threads = [
      ["thread-a", "2026-01-01T00:00:03.000Z"],
      ["thread-b", "2026-01-01T00:00:02.000Z"],
      ["thread-c", "2026-01-01T00:00:02.000Z"],
      ["thread-d", "2026-01-01T00:00:01.000Z"],
    ] as const
    for (const [threadId, updatedAt] of threads) {
      svc.upsertThreadMeta({
        ...saveRequest([]),
        thread_id: threadId,
        created_at: CREATED_AT,
        updated_at: updatedAt,
      })
    }
    const insertBinding = db.prepare(
      `INSERT INTO provider_session_bindings
         (thread_id, provider_instance_id, provider_kind, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, 'ready')`
    )
    insertBinding.run(
      "thread-a",
      "old-instance",
      "codex",
      CREATED_AT,
      "2026-01-01T00:00:01.000Z"
    )
    insertBinding.run(
      "thread-a",
      "new-instance",
      "claude",
      CREATED_AT,
      "2026-01-01T00:00:02.000Z"
    )
    insertBinding.run(
      "thread-c",
      "only-instance",
      "cursor",
      CREATED_AT,
      "2026-01-01T00:00:01.000Z"
    )

    const ids = (items: unknown[]) =>
      (items as Array<{ id: string }>).map((item) => item.id)

    const first = svc.listThreadsPage({ limit: 2 })
    // Ties on updated_at break by thread_id descending, like the index.
    expect(ids(first.items)).toEqual(["thread-a", "thread-c"])
    expect(first.next).toEqual({
      updatedAt: "2026-01-01T00:00:02.000Z",
      threadId: "thread-c",
    })
    expect(
      (
        first.items as Array<{
          id: string
          session?: { providerKind?: string } | null
        }>
      ).map((item) => [item.id, item.session?.providerKind ?? null])
    ).toEqual([
      ["thread-a", "claude"],
      ["thread-c", "cursor"],
    ])

    const second = svc.listThreadsPage({
      limit: 2,
      beforeUpdatedAt: first.next!.updatedAt,
      beforeThreadId: first.next!.threadId,
    })
    expect(ids(second.items)).toEqual(["thread-b", "thread-d"])
    expect(second.next).toBeNull()
  })
})
