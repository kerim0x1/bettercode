import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { ProviderSessionBindingStore } from "../provider/runtime/ProviderSessionBindingStore"
import {
  ThreadService,
  parseThreadCheckpointRevertRequest,
  parseThreadMessageUpsertRequest,
  parseThreadMetaUpsertRequest,
  parseThreadSaveRequest,
  parseThreadTruncateRequest,
} from "./threads"

function sampleThreadBody() {
  return {
    id: "thread-1",
    title: "Integration fixture",
    projectName: "betterc0de",
    projectPath: "C:/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    messages: [
      {
        id: "msg-user",
        role: "user",
        content: "hello",
        attachments: [
          {
            type: "file",
            filename: "screenshot.png",
            mediaType: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "msg-assistant",
        role: "assistant",
        content: "world",
        reasoning: "thinking out loud",
        toolCalls: [{ id: "t-1", name: "Read", input: { path: "foo" } }],
        questions: [{ id: "q-1", text: "proceed?", options: [] }],
        answeredQuestions: [{ question: "ok?", answer: "yes" }],
        diffs: [
          {
            path: "src/x.ts",
            additions: 1,
            deletions: 0,
            oldText: "",
            newText: "a",
            isNew: true,
          },
        ],
        usage: { inputTokens: 10, outputTokens: 20 },
        modelId: "claude-opus-4-6",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  }
}

describe("ThreadService round-trip", () => {
  let db: Db
  let svc: ThreadService
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-threads-"))
    db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    svc = new ThreadService(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("listThreads surfaces saved threads with renderer-shaped keys", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const listed = svc.listThreads() as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: "thread-1",
      title: "Integration fixture",
      projectName: "betterc0de",
      projectPath: "C:/repo",
      envMode: "local",
      branch: null,
      worktreePath: null,
      worktreeState: "none",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
  })

  it("paginates threads with a stable updated-at and thread-id cursor", () => {
    const fixtures = [
      ["thread-e", "2026-01-01T00:00:05.000Z"],
      ["thread-d", "2026-01-01T00:00:04.000Z"],
      ["thread-c", "2026-01-01T00:00:03.000Z"],
      ["thread-b", "2026-01-01T00:00:03.000Z"],
      ["thread-a", "2026-01-01T00:00:02.000Z"],
    ] as const
    for (const [id, updatedAt] of fixtures) {
      svc.save(
        parseThreadSaveRequest({
          ...sampleThreadBody(),
          id,
          title: id,
          updatedAt,
          messages: [],
        })
      )
    }

    const first = svc.listThreadsPage({ limit: 2 })
    expect(
      (first.items as Array<{ id: string }>).map((thread) => thread.id)
    ).toEqual(["thread-e", "thread-d"])
    expect(first.next).toEqual({
      updatedAt: "2026-01-01T00:00:04.000Z",
      threadId: "thread-d",
    })

    const second = svc.listThreadsPage({
      limit: 2,
      beforeUpdatedAt: first.next?.updatedAt,
      beforeThreadId: first.next?.threadId,
    })
    expect(
      (second.items as Array<{ id: string }>).map((thread) => thread.id)
    ).toEqual(["thread-c", "thread-b"])
    expect(second.next).toEqual({
      updatedAt: "2026-01-01T00:00:03.000Z",
      threadId: "thread-b",
    })

    const third = svc.listThreadsPage({
      limit: 2,
      beforeUpdatedAt: second.next?.updatedAt,
      beforeThreadId: second.next?.threadId,
    })
    expect(
      (third.items as Array<{ id: string }>).map((thread) => thread.id)
    ).toEqual(["thread-a"])
    expect(third.next).toBeNull()
  })

  it("keeps aggregate statistics complete beyond the bounded list page", () => {
    const baseTime = Date.parse("2026-01-01T00:00:00.000Z")
    for (let index = 0; index < 105; index += 1) {
      svc.save(
        parseThreadSaveRequest({
          ...sampleThreadBody(),
          id: `stats-thread-${index.toString().padStart(3, "0")}`,
          updatedAt: new Date(baseTime + index).toISOString(),
          messages: [],
        })
      )
    }

    expect(svc.listThreads()).toHaveLength(100)
    expect(svc.stats().totalSessions).toBe(105)
  })

  it("round-trips branch and worktree metadata on thread rows", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        envMode: "worktree",
        branch: "agent/thread-1",
        worktreePath: "/tmp/repo-worktree",
        baseBranch: "main",
        worktreeState: "ready",
      })
    )

    const listed = svc.listThreads() as Array<Record<string, unknown>>
    expect(listed[0]).toMatchObject({
      id: "thread-1",
      envMode: "worktree",
      branch: "agent/thread-1",
      worktreePath: "/tmp/repo-worktree",
      baseBranch: "main",
      worktreeState: "ready",
    })

    svc.upsertThreadMeta(
      parseThreadMetaUpsertRequest("thread-1", {
        ...sampleThreadBody(),
        title: "Retitled",
        updatedAt: "2026-01-01T00:00:02.000Z",
      })
    )

    expect(
      (svc.listThreads() as Array<Record<string, unknown>>)[0]
    ).toMatchObject({
      title: "Retitled",
      envMode: "worktree",
      branch: "agent/thread-1",
      worktreePath: "/tmp/repo-worktree",
      baseBranch: "main",
      worktreeState: "ready",
    })
  })

  it("round-trips BetterC0de-style fork parent links on thread rows", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        id: "thread-child",
        title: "Forked fixture",
        parentThreadId: "thread-1",
        updatedAt: "2026-01-01T00:00:03.000Z",
        messages: [],
      })
    )

    const listed = svc.listThreads() as Array<Record<string, unknown>>
    const child = listed.find((thread) => thread.id === "thread-child")
    expect(child).toMatchObject({
      id: "thread-child",
      parentThreadId: "thread-1",
    })
  })

  it("returns the project path for checkpoint orchestration", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))

    expect(svc.getThreadProjectPath("thread-1")).toBe("C:/repo")
    expect(svc.getThreadProjectPath("missing-thread")).toBeNull()
  })

  // Regression: the sidebar filters skeleton threads on `messageCount` until
  // their messages are lazily hydrated. If listThreads stops surfacing this
  // field, every real chat disappears from the sidebar after a reload.
  it("listThreads returns messageCount so the sidebar can skip hydration-empty skeletons", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const emptyBody = {
      ...sampleThreadBody(),
      id: "thread-empty",
      messages: [],
    }
    svc.save(parseThreadSaveRequest(emptyBody))

    const listed = svc.listThreads() as Array<{
      id: string
      messageCount?: number
    }>
    const populated = listed.find((t) => t.id === "thread-1")
    const empty = listed.find((t) => t.id === "thread-empty")
    expect(populated?.messageCount).toBe(2)
    expect(empty?.messageCount).toBe(0)
  })

  it("lists the last assistant model without hydrating messages, including after a rewrite", () => {
    const body = sampleThreadBody()
    svc.save(
      parseThreadSaveRequest({
        ...body,
        messages: [
          ...body.messages,
          {
            id: "latest",
            role: "assistant",
            content: "new reply",
            modelId: "gpt-6-astra",
            createdAt: body.updatedAt,
          },
          {
            id: "followup",
            role: "user",
            content: "next",
            modelId: "selected-only",
            createdAt: body.updatedAt,
          },
        ],
      })
    )
    expect(svc.listThreads()[0]).toMatchObject({
      lastModelId: "gpt-6-astra",
      messages: [],
    })
    svc.save(parseThreadSaveRequest(body))
    expect(svc.listThreads()[0]).toMatchObject({
      lastModelId: "claude-opus-4-6",
      messages: [],
    })
    svc.save(parseThreadSaveRequest({ ...body, messages: [] }))
    expect(svc.listThreads()[0]).toMatchObject({
      lastModelId: null,
      messages: [],
    })
  })

  it("listThreads surfaces the latest provider session binding", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const bindings = new ProviderSessionBindingStore(db)
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-work",
      continuationKey: "codex:home:/Users/example/.codex-work",
    })
    bindings.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    })
    bindings.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      status: "running",
      activeTurnId: "turn-1",
      lastError:
        "spawn failed at C:\\private\\provider.json with token sk-sensitive",
    })

    const [thread] = svc.listThreads() as Array<{
      session?: Record<string, unknown> | null
    }>
    expect(thread.session).toMatchObject({
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-work",
      resumeCursor: { providerThreadId: "codex-thread-work" },
      continuationKey: "codex:home:/Users/example/.codex-work",
      status: "running",
      activeTurnId: "turn-1",
      lastError: "Provider session failed.",
      runtimeMode: "full-access",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    })
    expect(JSON.stringify(thread.session)).not.toContain("provider.json")
    expect(JSON.stringify(thread.session)).not.toContain("sk-sensitive")
  })

  it("listMessages round-trips every optional ChatMessage field", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const loaded = svc.listMessages("thread-1") as Array<
      Record<string, unknown>
    >

    expect(loaded).toHaveLength(2)
    expect(loaded[0].attachments).toEqual([
      {
        type: "file",
        filename: "screenshot.png",
        mediaType: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
      },
    ])
    const assistant = loaded[1]
    expect(assistant.role).toBe("assistant")
    expect(assistant.content).toBe("world")
    expect(assistant.reasoning).toBe("thinking out loud")
    expect(assistant.modelId).toBe("claude-opus-4-6")
    // These fields used to be silently dropped on load — W0.3 fix.
    expect(assistant.toolCalls).toEqual([
      { id: "t-1", name: "Read", input: { path: "foo" } },
    ])
    expect(assistant.questions).toEqual([
      { id: "q-1", text: "proceed?", options: [] },
    ])
    expect(assistant.answeredQuestions).toEqual([
      { question: "ok?", answer: "yes" },
    ])
    expect(assistant.diffs).toEqual([
      {
        path: "src/x.ts",
        additions: 1,
        deletions: 0,
        oldText: "",
        newText: "a",
        isNew: true,
      },
    ])
    expect(assistant.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it("paginates message history backwards without gaps or duplicates", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "message-0",
            role: "user",
            content: "zero",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "message-1",
            role: "assistant",
            content: "one",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "message-2",
            role: "user",
            content: "two",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "message-3",
            role: "assistant",
            content: "three",
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ],
      })
    )

    const newest = svc.listMessages("thread-1", { limit: 2 }) as Array<{
      id: string
      sequence: number
    }>
    expect(newest.map((message) => message.id)).toEqual([
      "message-2",
      "message-3",
    ])

    const older = svc.listMessages("thread-1", {
      limit: 2,
      beforeSequence: newest[0].sequence,
    }) as Array<{ id: string; sequence: number }>
    expect(older.map((message) => message.id)).toEqual([
      "message-0",
      "message-1",
    ])
    expect(
      new Set([...older, ...newest].map((message) => message.sequence)).size
    ).toBe(4)
  })

  it("builds provider history from the active durable compaction context without the current user message", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "old-user",
            role: "user",
            content: "old context",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "compact-command",
            role: "user",
            content: "/compact",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "compact-checkpoint",
            role: "assistant",
            content: "Durable compaction summary",
            compactedContext: true,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "after-compact",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-read",
                name: "Read",
                input: { path: "src/a.ts" },
                output: "file body",
                startedAt: "2026-01-01T00:00:03.000Z",
              },
            ],
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          {
            id: "current-user",
            role: "user",
            content: "continue",
            createdAt: "2026-01-01T00:00:04.000Z",
          },
        ],
      })
    )

    expect(
      svc.buildProviderHistory("thread-1", {
        excludeMessageId: "current-user",
      })
    ).toEqual([
      {
        role: "assistant",
        content: "Durable compaction summary",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-read", name: "Read", input: { path: "src/a.ts" } },
        ],
      },
      { role: "tool", tool_call_id: "call-read", content: "file body" },
    ])
  })

  it("recognizes legacy compact command and heading pairs as the active durable context", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "legacy-old",
            role: "assistant",
            content: "discard me",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "legacy-command",
            role: "user",
            content: "/compact keep recent facts",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "legacy-checkpoint",
            role: "assistant",
            content: "# Compacted Session Context\n\nLegacy summary",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "legacy-current",
            role: "user",
            content: "continue",
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ],
      })
    )

    expect(
      svc.buildProviderHistory("thread-1", {
        excludeMessageId: "legacy-current",
      })
    ).toEqual([
      {
        role: "assistant",
        content: "# Compacted Session Context\n\nLegacy summary",
      },
    ])
  })

  it("keeps the newest complete durable groups within the serialized UTF-8 budget", () => {
    const newestGroup = [
      {
        role: "assistant",
        content: "latest 🧠",
        tool_calls: [
          { id: "call-latest", name: "Grep", input: { query: "TODO" } },
        ],
      },
      { role: "tool", tool_call_id: "call-latest", content: "no matches" },
    ]
    const maxBytes = new TextEncoder().encode(
      JSON.stringify(newestGroup)
    ).byteLength
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "older-user",
            role: "user",
            content: "🚀".repeat(500),
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "latest-assistant",
            role: "assistant",
            content: "latest 🧠",
            toolCalls: [
              {
                id: "call-latest",
                name: "Grep",
                input: { query: "TODO" },
                output: "no matches",
              },
            ],
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "current-user",
            role: "user",
            content: "current",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
      })
    )

    const history = svc.buildProviderHistory("thread-1", {
      excludeMessageId: "current-user",
      maxBytes,
    })
    expect(history).toEqual(newestGroup)
    expect(
      new TextEncoder().encode(JSON.stringify(history)).byteLength
    ).toBeLessThanOrEqual(maxBytes)
  })

  it("limits valid unique tool calls after discarding malformed entries", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    svc.upsertMessage({
      thread_id: "thread-1",
      message: {
        message_id: "tool-validation-assistant",
        turn_id: "tool-validation-turn",
        role: "assistant",
        content: "validated tools",
        created_at: "2026-01-01T00:00:03.000Z",
        extra: {
          toolCalls: [
            ...Array.from({ length: 128 }, () => ({ id: "", name: "" })),
            {
              id: "valid-call",
              name: "Read",
              input: { path: "src/index.ts" },
              output: "first result",
            },
            {
              id: "valid-call",
              name: "Duplicate",
              input: {},
              output: "must be ignored",
            },
          ],
        },
      },
    })

    expect(svc.buildProviderHistory("thread-1").slice(-2)).toEqual([
      {
        role: "assistant",
        content: "validated tools",
        tool_calls: [
          { id: "valid-call", name: "Read", input: { path: "src/index.ts" } },
        ],
      },
      { role: "tool", tool_call_id: "valid-call", content: "first result" },
    ])
  })

  it("does not let unusable recent rows displace older valid provider history", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    for (let index = 0; index < 90; index += 1) {
      svc.upsertMessage({
        thread_id: "thread-1",
        message: {
          message_id: `unusable-${index}`,
          turn_id: null,
          role: "system",
          content: "",
          created_at: `2026-01-01T00:01:${String(index % 60).padStart(2, "0")}.000Z`,
          extra: {},
        },
      })
    }

    expect(svc.buildProviderHistory("thread-1")).toEqual(
      expect.arrayContaining([
        { role: "user", content: "hello" },
        expect.objectContaining({ role: "assistant", content: "world" }),
      ])
    )
  })

  it("excludes synchronously failed dispatch messages and clears the marker on retry", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const dispatch = {
      thread_id: "thread-1",
      title: "Fixture",
      project_name: "BetterC0de",
      project_path: "/tmp/project",
      created_at: "2026-01-01T00:00:03.000Z",
      message: {
        message_id: "dispatch-retry-user",
        turn_id: null,
        role: "user",
        content: "retry this message",
        created_at: "2026-01-01T00:00:03.000Z",
        extra: { providerKind: "claude" },
      },
    } as const

    svc.persistUserMessageForTurn(dispatch)
    svc.markDispatchMessageFailed("thread-1", "dispatch-retry-user")
    expect(svc.buildProviderHistory("thread-1")).not.toContainEqual({
      role: "user",
      content: "retry this message",
    })

    svc.persistUserMessageForTurn(dispatch)
    expect(svc.buildProviderHistory("thread-1")).toContainEqual({
      role: "user",
      content: "retry this message",
    })
  })

  it("aggregates BetterC0de-style thread stats from persisted messages", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        id: "thread-2",
        title: "Second fixture",
        projectPath: "/other",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:01.000Z",
        messages: [
          {
            id: "msg-user-2",
            role: "user",
            content: "run",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "msg-assistant-2",
            role: "assistant",
            content: "done",
            toolCalls: [
              { id: "t-2", name: "Bash", input: { cmd: "npm test" } },
            ],
            usage: {
              inputTokens: 5,
              outputTokens: 7,
              reasoningOutputTokens: 3,
              cachedInputTokens: 2,
              cost: 0.02,
            },
            modelId: "openai/gpt-5.5",
            createdAt: "2026-01-02T00:00:01.000Z",
          },
        ],
      })
    )

    db.prepare(
      `INSERT INTO projection_turns
        (turn_id, thread_id, status, provider_kind, model_id, started_at, completed_at)
       VALUES ('turn-claude', 'thread-1', 'completed', 'anthropic_cli', 'claude-opus-4-6', ?, ?)`
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")
    db.prepare(
      `UPDATE projection_messages SET turn_id = 'turn-claude'
       WHERE message_id = 'msg-assistant'`
    ).run()
    db.prepare(
      `INSERT INTO projection_turns
        (turn_id, thread_id, status, provider_kind, model_id, started_at, completed_at)
       VALUES ('turn-codex', 'thread-2', 'completed', 'codex', 'openai/gpt-5.5', ?, ?)`
    ).run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:01.000Z")
    db.prepare(
      `UPDATE projection_messages SET turn_id = 'turn-codex'
       WHERE message_id = 'msg-assistant-2'`
    ).run()

    const perThreadMessageQuery = vi.spyOn(svc, "listMessages")
    const stats = svc.stats()

    expect(stats.totalSessions).toBe(2)
    expect(stats.totalMessages).toBe(4)
    expect(stats.totalTokens).toEqual({
      input: 15,
      output: 27,
      reasoning: 3,
      cache: { read: 2, write: 0 },
    })
    expect(stats.totalCost).toBe(0.02)
    expect(stats.toolUsage).toEqual({ Read: 1, Bash: 1 })
    expect(stats.modelUsage["claude-opus-4-6"]?.messages).toBe(1)
    expect(stats.modelUsage["openai/gpt-5.5"]?.tokens.reasoning).toBe(3)
    expect(stats.providerUsage.anthropic_cli?.messages).toBe(1)
    expect(stats.providerUsage.codex?.tokens.output).toBe(7)
    expect(stats.dailyUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: "2026-01-01",
          provider: "anthropic_cli",
        }),
        expect.objectContaining({ date: "2026-01-02", provider: "codex" }),
      ])
    )
    expect(stats.medianTokensPerSession).toBe(23.5)
    expect(perThreadMessageQuery).not.toHaveBeenCalled()
  })

  it("save is a pure upsert — re-saving the same thread keeps a stable row count", () => {
    const body = sampleThreadBody()
    svc.save(parseThreadSaveRequest(body))
    body.title = "Renamed"
    body.updatedAt = "2026-01-02T00:00:00.000Z"
    svc.save(parseThreadSaveRequest(body))

    const listed = svc.listThreads() as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0].title).toBe("Renamed")
  })

  it("does not let an older provider replay overwrite a newer assistant transcript", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const request = (content: string, providerRuntimeSequence: number) => ({
      thread_id: "thread-1",
      message: {
        message_id: "provider-assistant:thread-1:turn-1",
        turn_id: "turn-1",
        role: "assistant",
        content,
        created_at: "2026-01-01T00:00:02.000Z",
        extra: { providerRuntimeSequence },
      },
    })

    svc.upsertMessage(request("complete answer", 12))
    svc.upsertMessage(request("stale tail", 11))
    expect(svc.listMessages("thread-1")).toContainEqual(
      expect.objectContaining({
        id: "provider-assistant:thread-1:turn-1",
        content: "complete answer",
      })
    )

    svc.upsertRecoveredAssistantMessage(request("newer recovery", 13))
    expect(svc.listMessages("thread-1")).toContainEqual(
      expect.objectContaining({
        id: "provider-assistant:thread-1:turn-1",
        content: "newer recovery",
      })
    )
  })

  it("persists a dispatch user message while idempotently ensuring its thread", () => {
    const request = {
      thread_id: "thread-dispatch",
      title: "New Chat",
      project_name: "BetterC0de",
      project_path: "/repo",
      created_at: "2026-07-11T02:00:00.000Z",
      message: {
        message_id: "user-dispatch-1",
        turn_id: null,
        role: "user",
        content: "Persist before dispatch",
        created_at: "2026-07-11T02:00:00.000Z",
        extra: { modelId: "gpt-5.5" },
      },
    }

    svc.persistUserMessageForTurn(request)
    svc.persistUserMessageForTurn(request)

    expect(svc.listMessages("thread-dispatch")).toEqual([
      expect.objectContaining({
        id: "user-dispatch-1",
        role: "user",
        content: "Persist before dispatch",
      }),
    ])
    expect(svc.listThreads()).toContainEqual(
      expect.objectContaining({
        id: "thread-dispatch",
        title: "New Chat",
        projectPath: "/repo",
        messageCount: 1,
      })
    )
  })

  it("does not overwrite existing thread metadata when persisting dispatch", () => {
    const existing = sampleThreadBody()
    existing.title = "Important existing title"
    svc.save(parseThreadSaveRequest(existing))

    svc.persistUserMessageForTurn({
      thread_id: "thread-1",
      title: "New Chat",
      project_name: "Different Project",
      project_path: "/different",
      created_at: "2026-07-11T02:00:00.000Z",
      message: {
        message_id: "user-dispatch-2",
        turn_id: null,
        role: "user",
        content: "Continue",
        created_at: "2026-07-11T02:00:00.000Z",
        extra: {},
      },
    })

    expect(svc.listThreads()).toContainEqual(
      expect.objectContaining({
        id: "thread-1",
        title: "Important existing title",
      })
    )
  })

  it("rejects a reused dispatch message id with different content", () => {
    const request = {
      thread_id: "thread-dispatch-conflict",
      title: "New Chat",
      project_name: "BetterC0de",
      project_path: "/repo",
      created_at: "2026-07-11T02:00:00.000Z",
      message: {
        message_id: "user-dispatch-conflict",
        turn_id: null,
        role: "user",
        content: "Original content",
        created_at: "2026-07-11T02:00:00.000Z",
        extra: { modelId: "gpt-5.5" },
      },
    }
    svc.persistUserMessageForTurn(request)

    expect(() =>
      svc.persistUserMessageForTurn({
        ...request,
        message: { ...request.message, content: "Replacement content" },
      })
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "dispatch_message_conflict",
      })
    )
    expect(svc.listMessages(request.thread_id)).toEqual([
      expect.objectContaining({
        id: request.message.message_id,
        role: "user",
        content: "Original content",
      }),
    ])
  })

  it("cannot overwrite an assistant message through dispatch persistence", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))

    expect(() =>
      svc.persistUserMessageForTurn({
        thread_id: "thread-1",
        title: "New Chat",
        project_name: "BetterC0de",
        project_path: "C:/repo",
        created_at: "2026-01-01T00:00:01.000Z",
        message: {
          message_id: "msg-assistant",
          turn_id: null,
          role: "user",
          content: "Overwrite attempt",
          created_at: "2026-01-01T00:00:01.000Z",
          extra: {},
        },
      })
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "dispatch_message_conflict",
      })
    )
    expect(svc.listMessages("thread-1")).toContainEqual(
      expect.objectContaining({
        id: "msg-assistant",
        role: "assistant",
        content: "world",
      })
    )
  })

  it("upsertThreadMeta creates a thread shell without messages", () => {
    svc.upsertThreadMeta(
      parseThreadMetaUpsertRequest("thread-1", sampleThreadBody())
    )
    const listed = svc.listThreads() as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: "thread-1",
      title: "Integration fixture",
      projectName: "betterc0de",
      projectPath: "C:/repo",
    })
    expect(svc.listMessages("thread-1")).toEqual([])
  })

  it("upsertMessage appends and updates messages incrementally", () => {
    svc.upsertThreadMeta(
      parseThreadMetaUpsertRequest("thread-1", sampleThreadBody())
    )

    const base = sampleThreadBody()
    svc.upsertMessage(
      parseThreadMessageUpsertRequest("thread-1", base.messages[0])
    )
    svc.upsertMessage(
      parseThreadMessageUpsertRequest("thread-1", base.messages[1])
    )

    let loaded = svc.listMessages("thread-1") as Array<Record<string, unknown>>
    expect(loaded).toHaveLength(2)
    expect(loaded[0].content).toBe("hello")
    expect(loaded[1].content).toBe("world")

    const updatedAssistant = {
      ...base.messages[1],
      content: "updated world",
      questions: [{ id: "q-2", text: "still proceed?", options: [] }],
    }
    svc.upsertMessage(
      parseThreadMessageUpsertRequest("thread-1", updatedAssistant)
    )

    loaded = svc.listMessages("thread-1") as Array<Record<string, unknown>>
    expect(loaded).toHaveLength(2)
    expect(loaded[1].content).toBe("updated world")
    expect(loaded[1].questions).toEqual([
      { id: "q-2", text: "still proceed?", options: [] },
    ])
  })

  it("replays a recovered assistant before messages persisted later", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    svc.upsertMessage({
      thread_id: "thread-1",
      message: {
        message_id: "later-user",
        turn_id: null,
        role: "user",
        content: "message sent after the missing assistant",
        created_at: "2026-01-01T00:00:03.000Z",
        extra: {},
      },
    })
    const recovered = {
      thread_id: "thread-1",
      message: {
        message_id: "provider-assistant:thread-1:turn-recovered",
        turn_id: "turn-recovered",
        role: "assistant",
        content: "recovered response",
        created_at: "2026-01-01T00:00:02.000Z",
        extra: { reasoning: "recovered reasoning" },
      },
    } as const

    svc.upsertRecoveredAssistantMessage(recovered)
    svc.upsertRecoveredAssistantMessage({
      ...recovered,
      message: { ...recovered.message, content: "updated recovered response" },
    })

    expect(
      (
        svc.listMessages("thread-1") as Array<{ id: string; content: string }>
      ).map((message) => [message.id, message.content])
    ).toEqual([
      ["msg-user", "hello"],
      ["msg-assistant", "world"],
      [
        "provider-assistant:thread-1:turn-recovered",
        "updated recovered response",
      ],
      ["later-user", "message sent after the missing assistant"],
    ])
    expect(
      (svc.listThreads() as Array<{ id: string; updatedAt: string }>).find(
        (thread) => thread.id === "thread-1"
      )?.updatedAt
    ).toBe("2026-01-01T00:00:03.000Z")
  })

  it("keeps later user turns after recovered assistants when timestamps collide", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "initiating-user",
            role: "user",
            content: "start",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
      })
    )
    const laterUser = {
      thread_id: "thread-1",
      message: {
        message_id: "same-time-later-user",
        turn_id: null,
        role: "user",
        content: "next turn",
        created_at: "2026-01-01T00:00:02.000Z",
        extra: {},
      },
    } as const
    svc.upsertMessage(laterUser)
    svc.upsertMessage(laterUser)
    svc.upsertRecoveredAssistantMessage({
      thread_id: "thread-1",
      message: {
        message_id: "same-time-recovered-assistant",
        turn_id: "turn-recovered",
        role: "assistant",
        content: "recovered",
        created_at: "2026-01-01T00:00:02.000Z",
        extra: {},
      },
    })

    expect(
      (
        svc.listMessages("thread-1") as Array<{
          id: string
          createdAt: string
        }>
      ).map((message) => [message.id, message.createdAt])
    ).toEqual([
      ["initiating-user", "2026-01-01T00:00:02.000Z"],
      ["same-time-recovered-assistant", "2026-01-01T00:00:02.000Z"],
      ["same-time-later-user", "2026-01-01T00:00:02.001Z"],
    ])
  })

  it("commits compaction command, checkpoint, and a thread-wide provider epoch atomically", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const bindings = new ProviderSessionBindingStore(db)
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "native-codex",
      resumeCursor: { threadId: "native-codex" },
    })
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "native-claude",
      resumeCursor: { sessionId: "native-claude" },
    })

    const result = svc.commitCompaction({
      thread_id: "thread-1",
      request_id: "checkpoint-1",
      command_message: {
        message_id: "compact-command-1",
        turn_id: null,
        role: "user",
        content: "/compact",
        created_at: "2026-01-01T00:00:02.000Z",
        extra: {},
      },
      checkpoint_message: {
        message_id: "checkpoint-1",
        turn_id: null,
        role: "assistant",
        content: "# Compacted Session Context\n\nDurable summary",
        created_at: "2026-01-01T00:00:03.000Z",
        extra: { compactedContext: true },
      },
    })

    expect(result).toEqual({
      alreadyCommitted: false,
      generation: 1,
      messageId: "checkpoint-1",
    })
    expect(
      (svc.listMessages("thread-1") as Array<Record<string, unknown>>).slice(-2)
    ).toEqual([
      expect.objectContaining({ id: "compact-command-1", role: "user" }),
      expect.objectContaining({
        id: "checkpoint-1",
        role: "assistant",
        compactedContext: true,
        compactionGeneration: 1,
      }),
    ])
    expect(bindings.get("thread-1", "codex-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
    })
    expect(bindings.get("thread-1", "claude-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
    })

    expect(
      svc.commitCompaction({
        thread_id: "thread-1",
        request_id: "checkpoint-1",
        command_message: {
          message_id: "compact-command-1",
          turn_id: null,
          role: "user",
          content: "/compact",
          created_at: "2026-01-01T00:00:02.000Z",
          extra: {},
        },
        checkpoint_message: {
          message_id: "checkpoint-1",
          turn_id: null,
          role: "assistant",
          content: "# Compacted Session Context\n\nDurable summary",
          created_at: "2026-01-01T00:00:03.000Z",
          extra: { compactedContext: true },
        },
      })
    ).toEqual({
      alreadyCommitted: true,
      generation: 1,
      messageId: "checkpoint-1",
    })
    expect(bindings.get("thread-1", "codex-work")?.generation).toBe(1)
  })

  it("truncateAfterMessage removes persisted messages and stale turn read-model rows", () => {
    const body = {
      ...sampleThreadBody(),
      messages: [
        {
          id: "msg-u1",
          role: "user",
          turnId: "turn-1",
          content: "first",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "msg-a1",
          role: "assistant",
          turnId: "turn-1",
          content: "first answer",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "msg-u2",
          role: "user",
          turnId: "turn-2",
          content: "second",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "msg-a2",
          role: "assistant",
          turnId: "turn-2",
          content: "second answer",
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ],
    }
    svc.save(parseThreadSaveRequest(body))
    for (const turnId of ["turn-1", "turn-2"]) {
      db.prepare(
        `INSERT INTO projection_turns
          (turn_id, thread_id, status, provider_kind, model_id, started_at, completed_at)
         VALUES (?, 'thread-1', 'completed', 'codex', 'gpt-5.5', ?, ?)`
      ).run(turnId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")
      db.prepare(
        `INSERT INTO projection_approvals
          (approval_id, thread_id, turn_id, request_type, status, payload_json, created_at)
         VALUES (?, 'thread-1', ?, 'tool', 'approved', '{}', ?)`
      ).run(`approval-${turnId}`, turnId, "2026-01-01T00:00:01.000Z")
      db.prepare(
        `INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, kind, tone, summary, payload_json, sequence, created_at)
         VALUES (?, 'thread-1', ?, 'tool_call', 'tool', ?, '{}', ?, ?)`
      ).run(
        `activity-${turnId}`,
        turnId,
        `activity ${turnId}`,
        turnId === "turn-1" ? 1 : 2,
        turnId === "turn-1"
          ? "2026-01-01T00:00:00.500Z"
          : "2026-01-01T00:00:02.500Z"
      )
      db.prepare(
        `INSERT INTO checkpoint_diffs
          (thread_id, turn_id, checkpoint_ref, diff_content, created_at)
         VALUES ('thread-1', ?, ?, 'diff', ?)`
      ).run(turnId, `refs/${turnId}`, "2026-01-01T00:00:01.000Z")
    }
    db.prepare(
      `INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, kind, tone, summary, payload_json, sequence, created_at)
       VALUES ('activity-null-late', 'thread-1', NULL, 'info', 'info', 'late', '{}', 3, '2026-01-01T00:00:04.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO turn_diffs
        (thread_id, turn_index, turn_id, boundary_message_id,
         boundary_sequence, diff_text, files_changed, insertions, deletions,
         created_at)
       VALUES
        ('thread-1', 1, 'turn-1', 'msg-a1', 1, 'diff 1', 1, 1, 0,
         '2026-01-01T00:00:01.000Z'),
        ('thread-1', 2, 'turn-2', 'msg-a2', 3, 'diff 2', 1, 1, 0,
         '2026-01-01T00:00:03.000Z')`
    ).run()

    const result = svc.truncateAfterMessage(
      parseThreadTruncateRequest("thread-1", {
        messageId: "msg-a1",
        updatedAt: "2026-01-01T00:01:00.000Z",
      })
    )

    expect(result).toEqual({ deletedMessages: 2 })
    expect(
      (svc.listMessages("thread-1") as Array<{ id: string }>).map((m) => m.id)
    ).toEqual(["msg-u1", "msg-a1"])
    expect(
      (
        db
          .prepare(`SELECT turn_id FROM projection_turns ORDER BY turn_id`)
          .all() as Array<{
          turn_id: string
        }>
      ).map((row) => row.turn_id)
    ).toEqual(["turn-1"])
    expect(
      (
        db
          .prepare(`SELECT turn_id FROM projection_approvals ORDER BY turn_id`)
          .all() as Array<{
          turn_id: string
        }>
      ).map((row) => row.turn_id)
    ).toEqual(["turn-1"])
    expect(
      (
        db
          .prepare(
            `SELECT activity_id FROM projection_thread_activities ORDER BY activity_id`
          )
          .all() as Array<{
          activity_id: string
        }>
      ).map((row) => row.activity_id)
    ).toEqual(["activity-turn-1"])
    expect(
      (
        db
          .prepare(`SELECT turn_id FROM checkpoint_diffs ORDER BY turn_id`)
          .all() as Array<{
          turn_id: string
        }>
      ).map((row) => row.turn_id)
    ).toEqual(["turn-1"])
    expect(
      (
        db
          .prepare(`SELECT turn_index FROM turn_diffs ORDER BY turn_index`)
          .all() as Array<{
          turn_index: number
        }>
      ).map((row) => row.turn_index)
    ).toEqual([1])
    expect(
      (svc.listThreads() as Array<{ messageCount?: number }>)[0].messageCount
    ).toBe(2)
  })

  it("truncateAfterTurnCount prunes messages and checkpoint read-model rows", () => {
    const body = {
      ...sampleThreadBody(),
      messages: [
        {
          id: "msg-u1",
          role: "user",
          turnId: "turn-1",
          content: "first",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "msg-a1",
          role: "assistant",
          turnId: "turn-1",
          content: "first answer",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "msg-u2",
          role: "user",
          turnId: "turn-2",
          content: "second",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "msg-a2",
          role: "assistant",
          turnId: "turn-2",
          content: "second answer",
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ],
    }
    const turn1Ref = checkpointRefForThreadTurn("thread-1", 1)
    const turn2Ref = checkpointRefForThreadTurn("thread-1", 3)
    svc.save(parseThreadSaveRequest(body))
    for (const turnId of ["turn-1", "turn-2"]) {
      db.prepare(
        `INSERT INTO projection_turns
          (turn_id, thread_id, status, provider_kind, model_id, started_at, completed_at)
         VALUES (?, 'thread-1', 'completed', 'codex', 'gpt-5.5', ?, ?)`
      ).run(turnId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")
      db.prepare(
        `INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, kind, tone, summary, payload_json, sequence, created_at)
         VALUES (?, 'thread-1', ?, 'tool_call', 'tool', ?, '{}', ?, ?)`
      ).run(
        `activity-${turnId}`,
        turnId,
        `activity ${turnId}`,
        turnId === "turn-1" ? 1 : 2,
        turnId === "turn-1"
          ? "2026-01-01T00:00:00.500Z"
          : "2026-01-01T00:00:02.500Z"
      )
    }
    db.prepare(
      `INSERT INTO checkpoint_diffs
        (thread_id, turn_id, checkpoint_ref, diff_content, created_at)
       VALUES ('thread-1', 'turn-1', ?, 'diff 1', '2026-01-01T00:00:01.000Z'),
              ('thread-1', 'turn-2', ?, 'diff 2', '2026-01-01T00:00:03.000Z')`
    ).run(turn1Ref, turn2Ref)
    db.prepare(
      `INSERT INTO turn_diffs
        (thread_id, turn_index, turn_id, boundary_message_id,
         boundary_sequence, diff_text, files_changed, insertions, deletions,
         created_at)
       VALUES
        ('thread-1', 1, 'turn-1', 'msg-a1', 1, 'diff 1', 1, 1, 0,
         '2026-01-01T00:00:01.000Z'),
        ('thread-1', 2, 'turn-2', 'msg-a2', 3, 'diff 2', 1, 1, 0,
         '2026-01-01T00:00:03.000Z')`
    ).run()

    const result = svc.truncateAfterTurnCount(
      parseThreadCheckpointRevertRequest(
        "thread-1",
        {
          turnCount: 1,
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
        [turn2Ref]
      )
    )

    expect(result).toEqual({
      deletedMessages: 2,
      boundaryMessageId: "msg-a1",
    })
    expect(
      (svc.listMessages("thread-1") as Array<{ id: string }>).map((m) => m.id)
    ).toEqual(["msg-u1", "msg-a1"])
    expect(
      (
        db
          .prepare(`SELECT checkpoint_ref FROM checkpoint_diffs ORDER BY id`)
          .all() as Array<{ checkpoint_ref: string }>
      ).map((row) => row.checkpoint_ref)
    ).toEqual([turn1Ref])
    expect(
      (
        db
          .prepare(`SELECT turn_index FROM turn_diffs ORDER BY turn_index`)
          .all() as Array<{ turn_index: number }>
      ).map((row) => row.turn_index)
    ).toEqual([1])
    expect(
      (
        db
          .prepare(
            `SELECT activity_id FROM projection_thread_activities ORDER BY activity_id`
          )
          .all() as Array<{ activity_id: string }>
      ).map((row) => row.activity_id)
    ).toEqual(["activity-turn-1"])
  })

  it("uses durable checkpoint boundaries across compaction and failed turns", () => {
    svc.save(
      parseThreadSaveRequest({
        ...sampleThreadBody(),
        messages: [
          {
            id: "msg-u1",
            role: "user",
            turnId: "turn-1",
            content: "first",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "msg-a1",
            role: "assistant",
            turnId: "turn-1",
            content: "first answer",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "msg-compaction",
            role: "assistant",
            content: "synthetic compacted context",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "msg-u2",
            role: "user",
            content: "second",
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          {
            id: "msg-a2",
            role: "assistant",
            turnId: "native-2",
            content: "second answer",
            createdAt: "2026-01-01T00:00:04.000Z",
          },
          {
            id: "msg-u3-failed",
            role: "user",
            content: "failed third turn",
            createdAt: "2026-01-01T00:00:05.000Z",
          },
        ],
      })
    )
    db.prepare(
      `
      INSERT INTO turn_diffs
        (thread_id, turn_index, turn_id, dispatch_turn_id,
         boundary_message_id, boundary_sequence, diff_text, created_at)
      VALUES
        ('thread-1', 1, 'turn-1', NULL, 'msg-a1', 1, 'diff 1',
         '2026-01-01T00:00:01.000Z'),
        ('thread-1', 2, 'native-2', 'dispatch-2', 'msg-a2', 4, 'diff 2',
         '2026-01-01T00:00:04.000Z'),
        ('thread-1', 3, 'native-3', 'dispatch-3', 'msg-u3-failed', 5,
         'diff 3',
         '2026-01-01T00:00:05.000Z')
    `
    ).run()
    db.prepare(
      `
      INSERT INTO projection_turns
        (turn_id, thread_id, status, started_at, completed_at)
      VALUES
        ('native-2', 'thread-1', 'completed',
         '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z'),
        ('native-3', 'thread-1', 'interrupted',
         '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z')
    `
    ).run()
    db.prepare(
      `
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, kind, tone, summary, payload_json,
         created_at)
      VALUES
        ('activity-2', 'thread-1', 'native-2', 'info', 'info', 'kept', '{}',
         '2026-01-01T00:00:04.000Z'),
        ('activity-3', 'thread-1', 'native-3', 'error', 'error', 'failed', '{}',
         '2026-01-01T00:00:05.000Z')
    `
    ).run()
    db.prepare(
      `
      INSERT INTO projection_approvals
        (approval_id, thread_id, turn_id, request_type, status, payload_json,
         created_at)
      VALUES
        ('approval-2', 'thread-1', 'native-2', 'tool', 'approved', '{}',
         '2026-01-01T00:00:04.000Z'),
        ('approval-3', 'thread-1', 'native-3', 'tool', 'denied', '{}',
         '2026-01-01T00:00:05.000Z')
    `
    ).run()
    db.prepare(
      `
      INSERT INTO checkpoint_diffs
        (thread_id, turn_id, checkpoint_ref, diff_content, created_at)
      VALUES
        ('thread-1', 'dispatch-2', 'refs/turn-2', '',
         '2026-01-01T00:00:04.000Z'),
        ('thread-1', 'dispatch-3', 'refs/turn-3', '',
         '2026-01-01T00:00:05.000Z')
    `
    ).run()

    expect(
      (svc.listThreads() as Array<{ turnCount: number }>)[0]?.turnCount
    ).toBe(3)

    expect(
      svc.truncateAfterTurnCount(
        parseThreadCheckpointRevertRequest("thread-1", {
          turnCount: 2,
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      )
    ).toEqual({
      deletedMessages: 1,
      boundaryMessageId: "msg-a2",
    })
    expect(
      (svc.listMessages("thread-1") as Array<{ id: string }>).map(
        (message) => message.id
      )
    ).toEqual(["msg-u1", "msg-a1", "msg-compaction", "msg-u2", "msg-a2"])
    for (const [table, idColumn] of [
      ["projection_turns", "turn_id"],
      ["projection_thread_activities", "turn_id"],
      ["projection_approvals", "turn_id"],
    ] as const) {
      expect(
        (
          db
            .prepare(
              `SELECT DISTINCT ${idColumn} AS turn_id
               FROM ${table}
               ORDER BY turn_id`
            )
            .all() as Array<{ turn_id: string }>
        ).map((row) => row.turn_id)
      ).toEqual(["native-2"])
    }
    expect(
      (
        db
          .prepare(
            `SELECT DISTINCT turn_id
             FROM checkpoint_diffs
             ORDER BY turn_id`
          )
          .all() as Array<{ turn_id: string }>
      ).map((row) => row.turn_id)
    ).toEqual(["dispatch-2"])

    expect(
      svc.truncateAfterTurnCount(
        parseThreadCheckpointRevertRequest("thread-1", {
          turnCount: 1,
          updatedAt: "2026-01-01T00:02:00.000Z",
        })
      )
    ).toEqual({
      deletedMessages: 3,
      boundaryMessageId: "msg-a1",
    })
    expect(
      (svc.listMessages("thread-1") as Array<{ id: string }>).map(
        (message) => message.id
      )
    ).toEqual(["msg-u1", "msg-a1"])
    for (const table of [
      "projection_turns",
      "projection_thread_activities",
      "projection_approvals",
      "checkpoint_diffs",
    ] as const) {
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 0 })
    }
    expect(
      (
        db
          .prepare(
            `SELECT turn_index FROM turn_diffs
             WHERE thread_id = 'thread-1'
             ORDER BY turn_index`
          )
          .all() as Array<{ turn_index: number }>
      ).map((row) => row.turn_index)
    ).toEqual([1])
  })

  it("delete removes both the thread and its messages", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    svc.delete("thread-1")
    expect(svc.listThreads()).toEqual([])
    expect(svc.listMessages("thread-1")).toEqual([])
  })

  it("delete removes the complete thread graph without foreign-key failures", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    db.prepare(
      `INSERT INTO projection_turns
        (turn_id, thread_id, status, provider_kind, model_id, started_at)
       VALUES ('turn-delete', 'thread-1', 'completed', 'codex', 'gpt', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO projection_approvals
        (approval_id, thread_id, turn_id, request_type, status, payload_json, created_at)
       VALUES ('approval-delete', 'thread-1', 'turn-delete', 'tool', 'approved', '{}', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO checkpoint_diffs
        (thread_id, turn_id, checkpoint_ref, diff_content, created_at)
       VALUES ('thread-1', 'turn-delete', 'refs/delete', 'diff', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO turn_diffs
        (thread_id, turn_index, diff_text, created_at)
       VALUES ('thread-1', 1, 'diff', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO provider_sessions
        (session_id, thread_id, provider_kind, model_id, status, created_at)
       VALUES ('session-delete', 'thread-1', 'codex', 'gpt', 'active', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO provider_session_bindings
        (thread_id, provider_instance_id, provider_kind, created_at, updated_at)
       VALUES ('thread-1', 'codex', 'codex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO worktree_registry
        (worktree_id, thread_id, worktree_path, branch, base_branch, base_repo_path, state, created_at, updated_at)
       VALUES ('worktree-delete', 'thread-1', '/tmp/delete', 'delete-branch', 'main', '/repo', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type,
         occurred_at, command_id)
       VALUES
        ('provider-delete', 'provider_runtime', 'thread-1', 1, 'ProviderRuntime:tool_result', '2026-01-01T00:00:00.000Z', NULL),
        ('provider-keep', 'provider_runtime', 'thread-other', 1, 'ProviderRuntime:tool_result', '2026-01-01T00:00:00.000Z', NULL),
        ('domain-delete', 'thread', 'thread-1', 1, 'ThreadCreated', '2026-01-01T00:00:00.000Z', 'command-delete'),
        ('worktree-delete', 'worktree', 'thread-1', 1, 'WorktreeCreated', '2026-01-01T00:00:00.000Z', NULL),
        ('domain-keep', 'thread', 'thread-other', 1, 'ThreadCreated', '2026-01-01T00:00:00.000Z', 'command-keep')`
    ).run()
    db.prepare(
      `INSERT INTO command_receipts
        (command_id, status, result_json, request_hash, created_at)
       VALUES
        ('command-delete', 'completed', NULL, 'hash-delete', '2026-01-01T00:00:00.000Z'),
        ('command-keep', 'completed', NULL, 'hash-keep', '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO checkpoint_revert_quarantine
        (thread_id, phase, payload_json, error, quarantined_at)
       VALUES
        ('thread-1', 'git_applied', '{}', 'delete me', '2026-01-01T00:00:00.000Z')`
    ).run()

    expect(() => svc.delete("thread-1")).not.toThrow()

    for (const table of [
      "projection_threads",
      "projection_messages",
      "projection_turns",
      "projection_approvals",
      "projection_thread_activities",
      "checkpoint_diffs",
      "turn_diffs",
      "provider_sessions",
      "provider_session_bindings",
      "worktree_registry",
      "checkpoint_revert_quarantine",
    ]) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as {
        count: number
      }
      expect(row.count, table).toBe(0)
    }
    expect(
      (
        db
          .prepare(
            `SELECT event_id FROM orchestration_events ORDER BY event_id`
          )
          .all() as Array<{ event_id: string }>
      ).map((row) => row.event_id)
    ).toEqual(["domain-keep", "provider-keep"])
    expect(
      (
        db
          .prepare(
            `SELECT command_id FROM command_receipts ORDER BY command_id`
          )
          .all() as Array<{ command_id: string }>
      ).map((row) => row.command_id)
    ).toEqual(["command-keep"])
  })

  it("returns archived purge candidates without erasing worktree lifecycle state", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    db.prepare(
      `UPDATE projection_threads
       SET status = 'archived', archived_at = '2020-01-01T00:00:00.000Z'
       WHERE thread_id = 'thread-1'`
    ).run()
    db.prepare(
      `INSERT INTO worktree_registry
        (worktree_id, thread_id, worktree_path, branch, base_branch, base_repo_path, state, created_at, updated_at)
       VALUES ('worktree-retained', 'thread-1', '/tmp/retained', 'retained-branch', 'main', '/repo', 'ready', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
    ).run()

    expect(svc.purgeArchivedOlderThan(1)).toEqual(["thread-1"])
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM projection_threads`)
          .get() as { count: number }
      ).count
    ).toBe(1)
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM worktree_registry`).get() as {
          count: number
        }
      ).count
    ).toBe(1)
  })

  it("listProjects synthesizes from active threads", () => {
    svc.save(parseThreadSaveRequest(sampleThreadBody()))
    const projects = svc.listProjects() as Array<Record<string, unknown>>
    expect(projects).toEqual([{ name: "betterc0de", path: "C:/repo" }])
  })
})
