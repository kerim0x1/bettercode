import { routingTestServices } from "../testUtils/routing-services"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { ThreadActivityProjectionQuery } from "../persistence/projections"
import { registerThreadActivityBroadcaster } from "../ws/threadActivityBroadcast"
import { ProviderSessionBindingStore } from "../provider/runtime/ProviderSessionBindingStore"
import type { ProviderKind, ProviderSendTurnInput } from "../provider/runtime"
import {
  ChatDispatchStore,
  recoverChatDispatchesAfterRestart,
} from "../services/chat-dispatch-store"
import { ThreadService } from "../services/threads"
import { parseThreadSaveRequest } from "../services/threads"
import { workspaceRecoveryGate } from "../services/workspace-recovery-gate"
import { registerChatRoutes } from "./routes/chat"
import { RemoteProviderTurnOwnership } from "../remote/providerTurnOwnership"
import { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import {
  browserElementAttachment,
  withBrowserElementContext,
} from "@betterc0de/schema"

const tempDirs: string[] = []

describe("durable chat dispatch HTTP lifecycle", () => {
  let db: Db
  let threads: ThreadService
  let dispatches: ChatDispatchStore
  let bindings: ProviderSessionBindingStore

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-chat-http-"))
    tempDirs.push(dir)
    db = openDatabase(path.join(dir, "state.db"))
    runMigrations(db)
    threads = new ThreadService(db)
    dispatches = new ChatDispatchStore(db)
    bindings = new ProviderSessionBindingStore(db)
  })

  afterEach(() => {
    db.close()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("persists browser tags through dispatch and history without treating them as provider files", async () => {
    const attachment = browserElementAttachment({
      url: "https://example.com/",
      selector: "#buy",
      tagName: "button",
      text: "Buy",
      label: "Buy",
    })
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("browser-turn")
        return testTurnHandle("browser-turn", neverSettles())
      }
    )
    const app = appWithHub(startTurn)
    const content = "Make this smaller"
    const result = await send(app, {
      ...requestBody(),
      message: withBrowserElementContext(content, [attachment]),
      userMessageContent: content,
      attachments: [attachment],
    })
    expect(result.status, await result.clone().text()).toBe(200)
    expect(startTurn.mock.calls[0][1]).toMatchObject({
      message: expect.stringContaining('"selector":"#buy"'),
    })
    expect(startTurn.mock.calls[0][1]).not.toHaveProperty("attachments")
    expect(threads.listMessages("thread-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content, attachments: [attachment] }),
      ])
    )
    expect(threads.buildProviderHistory("thread-1")).toEqual([
      {
        role: "user",
        content: withBrowserElementContext(content, [attachment]),
      },
    ])
  })

  it("replays an identical send that races the original admission instead of 409 turn_active", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("admission-race")
        return testTurnHandle("admission-race", neverSettles())
      }
    )
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        threadTurnCoordinator: new ThreadTurnCoordinator(),
        providerHub: {
          has: vi.fn(() => true),
          assertCanStartTurn: vi.fn(),
          startTurn,
        },
        projectProjections: { listAll: () => [] },
        worktreeRegistry: { listAll: () => [] },
      })
    )

    // Same message id, same request, both in flight at once: the thread
    // token is held by whichever admission wins, and the durable row does
    // not exist yet when the loser checks — the loser must still replay.
    const [first, second] = await Promise.all([
      send(app, requestBody()),
      send(app, requestBody()),
    ])

    expect(first.status, await first.clone().text()).toBe(200)
    expect(second.status, await second.clone().text()).toBe(200)
    const bodies = await Promise.all([first.json(), second.json()])
    expect(bodies).toEqual(
      expect.arrayContaining([
        { status: "streaming", turnId: "admission-race" },
        { status: "streaming", turnId: "admission-race", replayed: true },
      ])
    )
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(dispatches.get("message-1")).toMatchObject({
      status: "accepted",
      providerTurnId: "admission-race",
    })
  })

  it.each([
    ["thread-1", "message-1", "thread-2", "message-1"],
    ["a:b", "c", "a", "b:c"],
  ])(
    "keeps in-flight admission %s/%s distinct from %s/%s",
    async (firstThread, firstMessage, secondThread, secondMessage) => {
      const startTurn = vi.fn(
        (_provider: string, _input: unknown, options: AcceptedOptions) => {
          const turnId = `turn-${startTurn.mock.calls.length}`
          options.onAccepted?.(turnId)
          return testTurnHandle(turnId, neverSettles())
        }
      )
      const app = new Hono()
      registerChatRoutes(
        app,
        state({
          // Auto-save off keeps the durable dispatch store — keyed by message
          // id alone — out of the picture; the in-memory admission map is
          // what this exercises.
          settings: { get: () => ({ auto_save_conversations: false }) },
          threadTurnCoordinator: new ThreadTurnCoordinator(),
          providerHub: {
            has: vi.fn(() => true),
            assertCanStartTurn: vi.fn(),
            startTurn,
          },
          projectProjections: { listAll: () => [] },
          worktreeRegistry: { listAll: () => [] },
        })
      )
      // Thread 1 admits `message-1`, thread 2 reuses the same client-chosen id,
      // and a retry of thread 1's send races the original for its turn token.
      // All three walk the same await chain, so they reach the reservation in
      // start order: the original registers, thread 2 registers (keyed by id
      // alone this overwrote the original), and the retry's reservation fails
      // and looks the original up — it must find it, not thread 2's, not 409.
      const [first, second, replayed] = await Promise.all([
        send(app, {
          ...requestBody(),
          threadId: firstThread,
          userMessageId: firstMessage,
        }),
        send(app, {
          ...requestBody(),
          threadId: secondThread,
          userMessageId: secondMessage,
        }),
        send(app, {
          ...requestBody(),
          threadId: firstThread,
          userMessageId: firstMessage,
        }),
      ])
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(replayed.status, await replayed.clone().text()).toBe(200)
      expect(await first.json()).toEqual({
        status: "streaming",
        turnId: "turn-1",
      })
      expect(await second.json()).toEqual({
        status: "streaming",
        turnId: "turn-2",
      })
      expect(await replayed.json()).toEqual({
        status: "streaming",
        turnId: "turn-1",
        replayed: true,
      })
      expect(startTurn).toHaveBeenCalledTimes(2)
    }
  )

  it("returns the accepted turn for an HTTP retry without redispatching", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("admission-1")
        return testTurnHandle("admission-1", neverSettles())
      }
    )
    const app = appWithHub(startTurn)

    const first = await send(app, requestBody())
    const retry = await send(app, {
      ...requestBody(),
      history: [{ role: "assistant", content: "renderer history changed" }],
    })

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({
      status: "streaming",
      turnId: "admission-1",
      replayed: true,
    })
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(dispatches.get("message-1")).toMatchObject({
      status: "accepted",
      providerTurnId: "admission-1",
    })

    const conflict = await send(app, {
      ...requestBody(),
      message: "different request under the same id",
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      code: "dispatch_id_conflict",
    })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("keeps an inferred mutable session binding out of retry identity", async () => {
    bindings.upsert({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-inferred-first",
      providerThreadId: "native-first",
    })
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("inferred-admission")
        return testTurnHandle("inferred-admission", neverSettles())
      }
    )
    const app = appWithHub(startTurn)
    const { providerInstanceId: _omitted, ...requestWithoutInstance } =
      requestBody()

    expect((await send(app, requestWithoutInstance)).status).toBe(200)
    expect(dispatches.get("message-1")).toMatchObject({
      // The concrete execution identity is durably bound for terminal
      // receipts, but remains outside the immutable request fingerprint.
      providerInstanceId: "claude-inferred-first",
      providerTurnId: "inferred-admission",
    })

    bindings.upsert({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-inferred-later",
      providerThreadId: "native-later",
    })
    const retry = await send(app, requestWithoutInstance)

    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({
      status: "streaming",
      turnId: "inferred-admission",
      replayed: true,
    })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("binds a newly selected default Hub instance before terminal correlation", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("default-admission", "claude-default")
        return testTurnHandle("default-admission", neverSettles())
      }
    )
    const app = appWithHub(startTurn)
    const { providerInstanceId: _omitted, ...requestWithoutInstance } =
      requestBody()

    expect((await send(app, requestWithoutInstance)).status).toBe(200)
    expect(dispatches.get("message-1")).toMatchObject({
      status: "accepted",
      providerInstanceId: "claude-default",
      providerTurnId: "default-admission",
    })

    expect(
      dispatches.markCompletedByProviderTurn(
        "thread-1",
        "claude-default",
        "default-admission"
      )
    ).toMatchObject({
      status: "completed",
      providerInstanceId: "claude-default",
    })
  })

  it("returns dispatch_in_progress for a live pending duplicate", async () => {
    const startTurn = vi.fn(() =>
      testTurnHandle("pending-admission", neverSettles())
    )
    const app = appWithHub(startTurn)

    expect((await send(app, requestBody())).status).toBe(200)
    db.prepare(
      `
      UPDATE chat_dispatches
      SET status = 'pending', provider_turn_id = NULL, accepted_at = NULL
      WHERE dispatch_id = 'message-1'
    `
    ).run()
    const retry = await send(app, requestBody())

    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "dispatch_in_progress" })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("returns dispatch_outcome_unknown after startup recovery", async () => {
    const startTurn = vi.fn(() =>
      testTurnHandle("crashed-admission", neverSettles())
    )
    const app = appWithHub(startTurn)
    expect((await send(app, requestBody())).status).toBe(200)
    db.prepare(
      `
      UPDATE chat_dispatches
      SET status = 'pending', provider_turn_id = NULL, accepted_at = NULL
      WHERE dispatch_id = 'message-1'
    `
    ).run()

    expect(
      recoverChatDispatchesAfterRestart(dispatches, bindings)
    ).toHaveLength(1)
    const retry = await send(app, requestBody())

    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({
      code: "dispatch_outcome_unknown",
    })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("never redispatches an id after synchronous provider rejection", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("not-started-turn")
        throw new Error("provider refused admission")
      }
    )
    const app = appWithHub(startTurn)

    expect((await send(app, requestBody())).status).toBe(500)
    const retry = await send(app, requestBody())

    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "dispatch_failed" })
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(dispatches.get("message-1")).toMatchObject({ status: "failed" })
  })

  it("records a late Hub rejection after admission", async () => {
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject
    })
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("hub-turn")
        return testTurnHandle("hub-turn", completion)
      }
    )
    const app = appWithHub(startTurn)

    expect((await send(app, requestBody())).status).toBe(200)
    rejectCompletion(new Error("hub rejected late"))
    await settleAsyncFailure()

    expect(dispatches.get("message-1")).toMatchObject({
      status: "failed",
      lastError: "hub rejected late",
    })
  })

  it("records a late Legacy rejection through the completion handle", async () => {
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject
    })
    const dispatchTurnWithHandle = vi.fn(
      (_input: unknown, _kind: string, options: AcceptedOptions) => {
        options.onAccepted?.("legacy-turn")
        return testTurnHandle("legacy-turn", completion)
      }
    )
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        providerHub: { has: vi.fn(() => false) },
        providers: {
          resolveProviderKind: vi.fn(() => "openai"),
          assertCanDispatch: vi.fn(),
          dispatchTurnWithHandle,
        },
      })
    )

    const body = { ...requestBody(), providerKind: "openai" }
    expect((await send(app, body)).status).toBe(200)
    rejectCompletion(new Error("legacy rejected late"))
    await settleAsyncFailure()

    expect(dispatches.get("message-1")).toMatchObject({
      status: "failed",
      lastError: "legacy rejected late",
    })
    expect(dispatchTurnWithHandle).toHaveBeenCalledTimes(1)
  })

  it("retains the workspace lease after dispatch ack until turn settlement", async () => {
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("lease-turn")
        return testTurnHandle("lease-turn", Promise.resolve(), settled)
      }
    )
    const workspace = path.join(tempDirs.at(-1)!, "lease-workspace")
    fs.mkdirSync(workspace)
    const app = appWithHub(startTurn, true, vi.fn(), [workspace])

    expect(
      (
        await send(app, {
          ...requestBody(),
          projectPath: workspace,
        })
      ).status
    ).toBe(200)

    let exclusiveAcquired = false
    const exclusive = workspaceRecoveryGate
      .acquireExclusive(workspace)
      .then((lease) => {
        exclusiveAcquired = true
        return lease
      })
    await Promise.resolve()
    await Promise.resolve()
    expect(exclusiveAcquired).toBe(false)

    resolveSettled()
    const lease = await exclusive
    expect(exclusiveAcquired).toBe(true)
    lease.release()
  })

  it("binds a remote session to the exact provider turn and revocation awaits settlement", async () => {
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("remote-owned-turn", "claude-main")
        return testTurnHandle("remote-owned-turn", Promise.resolve(), settled)
      }
    )
    const interruptTurnIfActive = vi.fn(async () => true)
    const ownership = new RemoteProviderTurnOwnership(() => true)
    const session = {
      id: "remote-session",
      label: "Phone",
      accessLevel: "full" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        config: { authToken: "desktop-secret" },
        remoteAccess: {
          authenticate: vi.fn((token: string) =>
            token === "remote-token" ? session : null
          ),
        },
        remoteProviderTurns: ownership,
        providerHub: {
          has: vi.fn(() => true),
          assertCanStartTurn: vi.fn(),
          startTurn,
          interruptTurnIfActive,
        },
      })
    )

    const response = await app.request("/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer remote-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    })
    expect(response.status).toBe(200)
    expect(ownership.activeCount(session.id)).toBe(1)

    let revocationSettled = false
    const revocation = ownership.revokeSession(session.id).then((count) => {
      revocationSettled = true
      return count
    })
    await vi.waitFor(() =>
      expect(interruptTurnIfActive).toHaveBeenCalledWith(
        "thread-1",
        "remote-owned-turn"
      )
    )
    expect(revocationSettled).toBe(false)

    resolveSettled()
    await expect(revocation).resolves.toBe(1)
    expect(ownership.activeCount(session.id)).toBe(0)
  })

  it("does not create an outbox or durable message when auto-save is off", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("ephemeral-turn")
        return testTurnHandle("ephemeral-turn", Promise.resolve())
      }
    )
    const app = appWithHub(startTurn, false)

    expect((await send(app, requestBody())).status).toBe(200)
    expect(dispatches.get("message-1")).toBeNull()
    expect(threads.getMessage("thread-1", "message-1")).toBeNull()
  })

  it("adopts an earlier persist-user message into the atomic dispatch lifecycle", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("persisted-first-turn")
        return testTurnHandle("persisted-first-turn", neverSettles())
      }
    )
    const app = appWithHub(startTurn)

    const persisted = await app.request("/chat/persist-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody()),
    })
    expect(persisted.status).toBe(200)
    expect((await send(app, requestBody())).status).toBe(200)

    expect(dispatches.get("message-1")).toMatchObject({ status: "accepted" })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_messages WHERE message_id = 'message-1'"
        )
        .get()
    ).toEqual({ count: 1 })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("compacts durable context inside every chat send before provider admission", async () => {
    threads.save(
      parseThreadSaveRequest({
        id: "thread-1",
        title: "Automatic compaction",
        projectName: "project",
        projectPath: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:06.000Z",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "first requirement",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "first result",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "user-2",
            role: "user",
            content: "second requirement",
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "assistant-2",
            role: "assistant",
            content: "second result",
            createdAt: "2026-01-01T00:00:03.000Z",
          },
          {
            id: "user-3",
            role: "user",
            content: "third requirement",
            createdAt: "2026-01-01T00:00:04.000Z",
          },
          {
            id: "assistant-3",
            role: "assistant",
            content: "third result",
            createdAt: "2026-01-01T00:00:05.000Z",
          },
        ],
      })
    )
    bindings.upsert({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      providerThreadId: "native-before-compaction",
      status: "ready",
    })
    const summarize = vi.fn(async (_input: { transcript: string }) => ({
      summary: "Durable server-owned summary",
    }))
    const stopSession = vi.fn(async () => {})
    const startTurn = vi.fn(
      (
        _provider: string,
        _input: Record<string, unknown>,
        options: AcceptedOptions
      ) => {
        options.onAccepted?.("compacted-turn", "claude-main")
        return testTurnHandle("compacted-turn", Promise.resolve())
      }
    )
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        threadTurnCoordinator: new ThreadTurnCoordinator(),
        threadActivities: { listByThread: vi.fn(() => []) },
        chatHelpers: { generateThreadContextSummary: summarize },
        providerHub: {
          has: vi.fn(() => true),
          assertCanStartTurn: vi.fn(),
          withThreadMaintenance: async (
            _threadId: string,
            run: () => unknown
          ) => run(),
          stopSession,
          startTurn,
        },
        providers: {
          resolveProviderKind: vi.fn(() => "claude"),
          withThreadMaintenance: async (
            _threadId: string,
            run: () => unknown
          ) => run(),
        },
      })
    )

    const response = await send(app, {
      ...requestBody(),
      message: "current request is dispatched separately",
      userMessageContent: "current request is dispatched separately",
      autoCompactionUsage: {
        usedTokens: 181_000,
        maxTokens: 200_000,
      },
      autoCompactionModelLimits: {
        contextTokens: 200_000,
        outputTokens: 20_000,
      },
    })

    expect(response.status, await response.clone().text()).toBe(200)
    const result = (await response.json()) as {
      status: string
      turnId: string
      automaticCompaction: {
        commandMessageId: string
        checkpointMessageId: string
        generation: number
      }
    }
    expect(result).toMatchObject({
      status: "streaming",
      turnId: "compacted-turn",
      automaticCompaction: {
        generation: 1,
      },
    })
    expect(summarize).toHaveBeenCalledTimes(1)
    const summaryInput = summarize.mock.calls[0]![0]
    expect(summaryInput.transcript).toContain("first requirement")
    expect(summaryInput.transcript).toContain("third result")
    expect(summaryInput.transcript).not.toContain(
      "current request is dispatched separately"
    )
    const providerInput = startTurn.mock.calls[0]![1] as Record<string, unknown>
    const history = providerInput.history as Array<{
      role: string
      content: string
    }>
    expect(history.at(-1)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Durable server-owned summary"),
    })
    expect(
      history.some((message) =>
        message.content.includes("current request is dispatched separately")
      )
    ).toBe(false)
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-1",
      "claude-main"
    )
    const persisted = threads.listMessages("thread-1", {
      limit: 20,
    }) as Array<Record<string, unknown>>
    expect(
      persisted.filter((message) => message.id === "message-1")
    ).toHaveLength(1)
    expect(persisted.at(-2)).toMatchObject({
      id: result.automaticCompaction.commandMessageId,
      role: "user",
      content: "/compact --automatic",
    })
    expect(persisted.at(-1)).toMatchObject({
      id: result.automaticCompaction.checkpointMessageId,
      role: "assistant",
      compactedContext: true,
      compactionGeneration: 1,
    })
  })

  it("keeps a reverted message id tombstoned against delayed HTTP retries", async () => {
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("reverted-turn")
        return testTurnHandle("reverted-turn", neverSettles())
      }
    )
    const app = appWithHub(startTurn)
    expect((await send(app, requestBody())).status).toBe(200)

    threads.truncateAfterTurnCount({
      thread_id: "thread-1",
      turn_count: 0,
      stale_checkpoint_refs: [],
      updated_at: "2026-01-01T00:05:00.000Z",
    })
    const retry = await send(app, requestBody())

    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: "dispatch_reverted" })
    expect(dispatches.get("message-1")).toMatchObject({ status: "reverted" })
    expect(threads.getMessage("thread-1", "message-1")).toBeNull()
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(() =>
      threads.persistUserMessageForTurn({
        thread_id: "thread-1",
        title: "Thread",
        project_name: "project",
        project_path: "/repo",
        created_at: "2026-01-01T00:00:00.000Z",
        message: {
          message_id: "message-1",
          turn_id: null,
          role: "user",
          content: "continue",
          created_at: "2026-01-01T00:00:00.000Z",
          extra: {},
        },
      })
    ).toThrow(/removed by an explicit thread revert/i)
  })

  it("taints without falsely failing an admitted turn when acceptance cannot be persisted", async () => {
    db.exec(`
      CREATE TRIGGER fail_chat_dispatch_accept
      BEFORE UPDATE OF status ON chat_dispatches
      WHEN NEW.status = 'accepted'
      BEGIN
        SELECT RAISE(ABORT, 'forced accept failure');
      END;
    `)
    const taintBackend = vi.fn()
    const startTurn = vi.fn(
      (_provider: string, _input: unknown, options: AcceptedOptions) => {
        options.onAccepted?.("unrecorded-turn")
        return testTurnHandle("unrecorded-turn", neverSettles())
      }
    )
    const app = appWithHub(startTurn, true, taintBackend)

    expect((await send(app, requestBody())).status).toBe(500)
    expect(taintBackend).toHaveBeenCalledWith(
      expect.objectContaining({ message: "forced accept failure" }),
      "chat_dispatch_accept"
    )
    expect(dispatches.get("message-1")).toMatchObject({
      status: "pending",
      providerTurnId: "unrecorded-turn",
    })
    const retry = await send(app, requestBody())
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({
      status: "streaming",
      turnId: "unrecorded-turn",
      replayed: true,
    })
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["claude", "codex"],
    ["codex", "claude"],
    ["claude", "grok_cli"],
    ["grok_cli", "claude"],
    ["codex", "grok_cli"],
    ["grok_cli", "codex"],
  ] as const)(
    "hands off %s to %s using the previous model before launching the target",
    async (source, target) => {
      const fixture = handoffFixture(source, target)
      const response = await send(fixture.app, fixture.body)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toMatchObject({
        providerHandoff: {
          sourceProvider: source,
          targetProvider: target,
          sourceModel: "previous-model",
          generation: 1,
        },
      })
      expect(fixture.summarize).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSelection: {
            instanceId: `${source}-source`,
            model: "previous-model",
          },
          transcript: expect.stringContaining("Keep the public API stable"),
          targetProvider: target,
        })
      )
      expect(fixture.summarize.mock.calls[0]?.[0].transcript).not.toContain(
        "new provider request"
      )
      expect(fixture.startTurn).toHaveBeenCalledWith(
        target,
        expect.objectContaining({
          message: "new provider request",
          history: [
            {
              role: "assistant",
              content: expect.stringContaining(
                "Handoff: keep API; tests passed; next add retry."
              ),
            },
          ],
        }),
        expect.anything()
      )
      expect(fixture.events).toEqual(["summary", "stop", "start"])
      const reloadedMessages = new ThreadService(db).listMessages("thread-1")
      expect(
        reloadedMessages.filter(
          (message) =>
            message !== null &&
            typeof message === "object" &&
            "internalContext" in message &&
            message.internalContext === "provider-handoff"
        )
      ).toEqual([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant", compactedContext: true }),
      ])
      expect(
        threads.buildProviderHistory("thread-1", {
          excludeMessageId: "message-1",
        })
      ).toEqual([
        {
          role: "assistant",
          content: expect.stringContaining("# Provider Handoff"),
        },
      ])
      // Retrying an accepted send must not pay for a second summary or dispatch.
      expect((await send(fixture.app, fixture.body)).status).toBe(200)
      expect(fixture.summarize).toHaveBeenCalledTimes(1)
      expect(fixture.startTurn).toHaveBeenCalledTimes(1)
    }
  )

  it("does not summarize for a different model/instance within one provider", async () => {
    const fixture = handoffFixture("claude", "claude")
    const response = await send(fixture.app, fixture.body)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fixture.summarize).not.toHaveBeenCalled()
    expect(fixture.events).toEqual(["start"])
    expect(bindings.getThreadGeneration("thread-1")).toBe(0)
  })

  it("summarizes with the new source when switching back, preserving the earlier handoff", async () => {
    const fixture = handoffFixture("claude", "codex")
    expect((await send(fixture.app, fixture.body)).status).toBe(200)
    fixture.finishTurn()
    const response = await send(fixture.app, {
      ...fixture.body,
      userMessageId: "return-message",
      providerKind: "claude",
      providerInstanceId: "claude-source",
      modelId: "previous-model",
      message: "switch back",
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fixture.summarize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelSelection: { instanceId: "codex-target", model: "new-model" },
        transcript: expect.stringContaining(
          "Handoff: keep API; tests passed; next add retry."
        ),
      })
    )
    expect(bindings.getThreadGeneration("thread-1")).toBe(2)
  })

  it("reuses a committed handoff after a failed target launch", async () => {
    const fixture = handoffFixture("claude", "codex")
    fixture.startTurn.mockImplementationOnce(() => {
      throw new Error("target not ready")
    })
    expect(
      (await send(fixture.app, fixture.body)).status
    ).toBeGreaterThanOrEqual(400)
    const response = await send(fixture.app, {
      ...fixture.body,
      userMessageId: "retry-message",
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fixture.summarize).toHaveBeenCalledTimes(1)
    expect(fixture.startTurn).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({
        history: [
          {
            role: "assistant",
            content: expect.stringContaining("# Provider Handoff"),
          },
        ],
      }),
      expect.anything()
    )
  })

  it.each(["failure", "empty"])(
    "does not stop the source or start the target on summary %s",
    async (mode) => {
      const fixture = handoffFixture("grok_cli", "codex")
      fixture.summarize.mockImplementationOnce(async () => {
        if (mode === "failure") throw new Error("upstream unavailable")
        return { summary: " " }
      })
      const response = await send(fixture.app, fixture.body)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({
        code: "provider_handoff_failed",
      })
      expect(fixture.startTurn).not.toHaveBeenCalled()
      expect(fixture.events).not.toContain("stop")
      expect(bindings.getThreadGeneration("thread-1")).toBe(0)
      expect(bindings.getLatestForThread("thread-1")?.providerThreadId).toBe(
        "native-source"
      )
      expect(
        new ThreadActivityProjectionQuery(db)
          .listByThread("thread-1")
          .find((row) => row.kind === "context.provider-handoff")?.payload
      ).toMatchObject({ status: "failed" })
    }
  )

  it("rejects a summary if an existing message changed while it was generated", async () => {
    const fixture = handoffFixture("claude", "codex")
    fixture.summarize.mockImplementationOnce(async () => {
      threads.upsertMessage({
        thread_id: "thread-1",
        message: {
          message_id: "prior-answer",
          turn_id: null,
          role: "assistant",
          content: "A new unresolved failure",
          created_at: "2026-01-01T00:00:01.000Z",
          extra: {},
        },
      })
      return { summary: "stale summary" }
    })
    const response = await send(fixture.app, fixture.body)
    expect(response.status).toBe(409)
    expect(fixture.startTurn).not.toHaveBeenCalled()
    expect(fixture.events).not.toContain("stop")
  })

  it("broadcasts real handoff progress before the target is started and settles the same activity", async () => {
    const fixture = handoffFixture("claude", "codex")
    let releaseSummary!: () => void
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve
    })
    fixture.summarize.mockImplementationOnce(async () => {
      await summaryGate
      return { summary: "Verified context" }
    })
    const broadcast = vi.fn()
    const unregister = registerThreadActivityBroadcaster({ broadcast })
    try {
      const responsePromise = send(fixture.app, fixture.body)
      try {
        await vi.waitFor(() =>
          expect(fixture.summarize).toHaveBeenCalledTimes(1)
        )
        expect(fixture.startTurn).not.toHaveBeenCalled()
        expect(broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "thread.activity",
            data: expect.objectContaining({
              kind: "context.provider-handoff",
              payload: expect.objectContaining({
                status: "compacting",
                requestMessageId: "message-1",
              }),
            }),
          })
        )
      } finally {
        releaseSummary()
      }
      expect((await responsePromise).status).toBe(200)
      const activity = new ThreadActivityProjectionQuery(db)
        .listByThread("thread-1")
        .find((row) => row.kind === "context.provider-handoff")
      expect(activity?.payload).toMatchObject({
        status: "completed",
        sourceProvider: "claude",
        targetProvider: "codex",
      })
      expect(broadcast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({ status: "completed" }),
          }),
        })
      )
    } finally {
      unregister()
    }
  })

  function handoffFixture(
    source: "claude" | "codex" | "grok_cli",
    target: "claude" | "codex" | "grok_cli"
  ) {
    threads.save(
      parseThreadSaveRequest({
        id: "thread-1",
        title: "Handoff",
        projectName: "project",
        projectPath: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        messages: [
          {
            id: "prior-user",
            role: "user",
            content: "Keep the public API stable",
            modelId: "previous-model",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "prior-answer",
            role: "assistant",
            content: "Tests passed; retry remains open",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      })
    )
    bindings.upsert({
      threadId: "thread-1",
      providerKind: source,
      providerInstanceId: `${source}-source`,
      providerThreadId: "native-source",
      status: "ready",
      modelSelection: {
        instanceId: `${source}-source`,
        model: "previous-model",
      },
    })
    const events: string[] = []
    const coordinator = new ThreadTurnCoordinator()
    let admittedToken: symbol | undefined
    const summarize = vi.fn(async (_input: { transcript: string }) => {
      events.push("summary")
      return { summary: "Handoff: keep API; tests passed; next add retry." }
    })
    const startTurn = vi.fn(
      (
        provider: ProviderKind,
        input: ProviderSendTurnInput,
        options: AcceptedOptions
      ) => {
        events.push("start")
        admittedToken = options.sharedToken
        const instanceId =
          input.modelSelection?.instanceId ??
          (provider === target ? `${target}-target` : `${source}-source`)
        const turnId = `handoff-turn-${startTurn.mock.calls.length}`
        bindings.upsert({
          threadId: "thread-1",
          providerKind: provider,
          providerInstanceId: instanceId,
          providerThreadId: `native-${instanceId}`,
          status: "ready",
          modelSelection: {
            instanceId,
            model: input.modelSelection?.model ?? input.modelId ?? "new-model",
          },
        })
        options.onAccepted?.(turnId, instanceId)
        return testTurnHandle(turnId, Promise.resolve())
      }
    )
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        threadTurnCoordinator: coordinator,
        chatHelpers: { generateProviderHandoffSummary: summarize },
        threadActivities: new ThreadActivityProjectionQuery(db),
        providerHub: {
          has: () => true,
          assertCanStartTurn: vi.fn(),
          startTurn,
          withThreadMaintenance: async (_id: string, run: () => unknown) =>
            run(),
          stopSession: async () => {
            events.push("stop")
          },
        },
        providers: {
          resolveProviderKind: () => target,
          withThreadMaintenance: async (_id: string, run: () => unknown) =>
            run(),
        },
      })
    )
    const finishTurn = () => {
      if (!admittedToken) throw new Error("No admitted handoff turn")
      coordinator.releaseTurn("thread-1", admittedToken)
      dispatches.markCompleted({
        dispatchId: "message-1",
        providerTurnId: "handoff-turn-1",
        providerInstanceId: `${target}-target`,
      })
    }
    return {
      app,
      summarize,
      startTurn,
      events,
      finishTurn,
      body: {
        ...requestBody(),
        providerKind: target,
        providerInstanceId: `${target}-target`,
        modelId: "new-model",
        message: "new provider request",
        userMessageCreatedAt: "2026-01-01T00:00:03.000Z",
      },
    }
  }

  function appWithHub(
    startTurn: HubStartTurn,
    autoSave = true,
    taintBackend = vi.fn(),
    projects: readonly string[] = []
  ): Hono {
    const app = new Hono()
    registerChatRoutes(
      app,
      state({
        settings: { get: () => ({ auto_save_conversations: autoSave }) },
        providerHub: {
          has: vi.fn(() => true),
          assertCanStartTurn: vi.fn(),
          startTurn,
        },
        projectProjections: {
          listAll: () => projects.map((projectPath) => ({ path: projectPath })),
        },
        worktreeRegistry: {
          listAll: () => [],
        },
        taintBackend,
      })
    )
    return app
  }

  function state(overrides: Record<string, unknown> = {}): AppState {
    return {
      ...routingTestServices(),
      settings: { get: () => ({ auto_save_conversations: true }) },
      threads,
      chatDispatches: dispatches,
      providerSessionBindings: bindings,
      providerHub: { has: vi.fn(() => true) },
      providers: {
        resolveProviderKind: vi.fn(() => "openai"),
        assertCanDispatch: vi.fn(),
      },
      ...overrides,
    } as unknown as AppState
  }
})

interface AcceptedOptions {
  readonly sharedToken?: symbol
  readonly onAccepted?: (turnId: string, providerInstanceId?: string) => void
}

type HubStartTurn = (
  provider: string,
  input: unknown,
  options: AcceptedOptions
) => {
  readonly turnId: string
  readonly completion: Promise<void>
  readonly settled: Promise<void>
}

function testTurnHandle(
  turnId: string,
  completion: Promise<void>,
  settled: Promise<void> = completion
): {
  readonly turnId: string
  readonly completion: Promise<void>
  readonly settled: Promise<void>
} {
  return { turnId, completion, settled }
}

function requestBody(): Record<string, unknown> {
  return {
    threadId: "thread-1",
    providerKind: "claude",
    providerInstanceId: "claude-main",
    message: "continue",
    modelId: "claude-opus",
    userMessageId: "message-1",
    userMessageCreatedAt: "2026-01-01T00:00:00.000Z",
    history: [],
  }
}

async function send(
  app: Hono,
  body: Record<string, unknown>
): Promise<Response> {
  return await app.request("/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function neverSettles(): Promise<void> {
  return new Promise(() => {})
}

async function settleAsyncFailure(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
