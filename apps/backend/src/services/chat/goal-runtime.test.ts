import { ThreadTurnCoordinator } from "../../provider/threadTurnCoordinator"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { EventStore } from "../../persistence/eventStore"
import { ThreadService } from "../threads/service"
import { providerEventBus } from "../../provider/events"
import { ProviderRuntimeIngestion } from "../../provider/runtime/ProviderRuntimeIngestion"
import { ProviderRuntimeEventJournal } from "../../provider/runtime/ProviderRuntimeEventJournal"
import { ProviderRuntimeProjectionReceiptStore } from "../../provider/runtime/ProviderRuntimeProjectionReceiptStore"
import { initializeThreadGoals } from "./goal-runtime"
import { threadGoals } from "./goal-registry"
import { registerChatRoutes } from "../../http/routes/chat"
import { dispatchChatTurn } from "./dispatch"

vi.mock("./dispatch", async (original) => ({
  ...(await original<typeof import("./dispatch")>()),
  prepareChatSendBody: vi.fn(async (_state, body) => body),
  resolveHubInstanceId: vi.fn(),
  dispatchChatTurn: vi.fn(async (_state, body, reserve, hooks) => {
    reserve()
    hooks.guard()
    hooks.started({ turnId: "owned-turn", settled: Promise.resolve() })
    const nonce = /"id":"([^"]+)"/.exec(body.message)![1]
    providerEventBus.emitCanonical({
      type: "content.delta",
      eventId: "result",
      threadId: body.thread_id,
      providerKind: body.provider_kind,
      at: Date.now(),
      streamKind: "assistant_text",
      delta: `Verified.\n<!-- betterc0de-goal: ${JSON.stringify({ id: nonce, status: "complete", reason: "Implementation verified by tests." })} -->`,
    })
    return { status: "streaming", turnId: "owned-turn" }
  }),
}))

describe("goal HTTP, journal and dispatch wiring", () => {
  let db: Db
  let dir: string
  let threads: ThreadService
  let state: AppState
  let app: Hono
  let ingestion: ProviderRuntimeIngestion
  let stop: () => void
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-managed-goals-"))
    db = openDatabase(path.join(dir, "test.sqlite"))
    runMigrations(db)
    threads = new ThreadService(db)
    threads.upsertThreadMeta({
      thread_id: "thread",
      title: "Task",
      project_name: "Project",
      project_path: dir,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      codex_thread_id: null,
    })
    state = {
      db,
      threads,
      threadTurnCoordinator: new ThreadTurnCoordinator(),
      settings: { get: () => ({ auto_save_conversations: true }) },
      providerHub: {
        has: () => true,
        waitForThreadIdle: async () => {},
        interruptTurnIfActive: vi.fn(),
      },
    } as unknown as AppState
    ingestion = new ProviderRuntimeIngestion({
      eventBus: providerEventBus,
      eventJournal: new ProviderRuntimeEventJournal(new EventStore(db)),
      projectionReceipts: new ProviderRuntimeProjectionReceiptStore(db),
      threadMetadataStore: threads,
      activityStore: { upsert: vi.fn() },
      broadcaster: { broadcast: vi.fn(), clientCount: () => 1 },
      logger: log,
      projectedSink: (event) => providerEventBus.emitProjected(event),
    })
    ingestion.start()
    stop = initializeThreadGoals(state)
    app = new Hono()
    registerChatRoutes(app, state)
  })
  afterEach(() => {
    stop()
    ingestion.stop()
    db.close()
    vi.useRealTimers()
    if (
      path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith("bc-managed-goals-")
    )
      throw new Error("Unexpected test path")
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const request = (
    message: string,
    threadId = "thread",
    providerKind = "codex",
    options: Record<string, unknown> = {}
  ) =>
    app.request("/chat/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        message,
        modelId: "test-model",
        providerKind,
        ...options,
      }),
    })

  it.each(["query", "record"])(
    "removes its event listener and registry entry when startup %s fails",
    (stage) => {
      stop()
      const count = providerEventBus.listenerCount("projected")
      const query = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        if (stage === "query") throw new Error("goal query failed")
        return {
          all: () => [{ thread_id: "thread", provider_goal_json: "{}" }],
        } as never
      })
      const read = vi
        .spyOn(threads, "getThreadGoal")
        .mockImplementationOnce(() => {
          throw new Error("goal record failed")
        })
      try {
        expect(() => initializeThreadGoals(state)).toThrow(
          `goal ${stage} failed`
        )
        expect(providerEventBus.listenerCount("projected")).toBe(count)
        expect(threadGoals.has(state)).toBe(false)
      } finally {
        query.mockRestore()
        read.mockRestore()
      }
    }
  )

  it.each(["claude", "grok_cli", "codex"])(
    "starts, pauses and continues with the selected %s model",
    async (providerKind) => {
      const options = {
        modelId: `${providerKind}-selected-model`,
        permissionLevel: "read-only",
        reasoningEffort: "high",
      }
      expect(
        (await request("/goal Fix My UI", "thread", providerKind, options))
          .status
      ).toBe(200)
      expect(threads.getThreadGoal("thread")).toMatchObject({
        objective: "Fix My UI",
        status: "active",
      })
      expect(
        (await request("/goal pause", "thread", providerKind)).status
      ).toBe(200)
      await vi.advanceTimersByTimeAsync(1500)
      expect(dispatchChatTurn).not.toHaveBeenCalled()
      expect(threads.getThreadGoal("thread")?.status).toBe("paused")
      expect(
        (await request("/goal continue", "thread", providerKind, options))
          .status
      ).toBe(200)
      await vi.advanceTimersByTimeAsync(750)
      expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
      expect(vi.mocked(dispatchChatTurn).mock.calls[0]?.[1]).toMatchObject({
        provider_kind: providerKind,
        model_id: options.modelId,
        permission_level: "read-only",
        reasoning_effort: "high",
      })
      expect(threads.getThreadGoal("thread")).toMatchObject({
        objective: "Fix My UI",
        status: "achieved",
        turns: 1,
      })
    }
  )

  it("starts through HTTP, journals status, dispatches once and persists confirmed achievement", async () => {
    const response = await request("/goal Finish migration")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      goal: { source: "betterc0de", status: "active" },
    })
    expect(threads.getThreadGoal("thread")?.status).toBe("active")
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
    expect(threads.getThreadGoal("thread")).toMatchObject({
      status: "achieved",
      turns: 1,
      lastReason: "Implementation verified by tests.",
    })
    const persisted = threads.getThreadGoal("thread")
    expect(persisted?.id).toBeTruthy()
    stop()
    stop = initializeThreadGoals(state)
    expect(threads.getThreadGoal("thread")).toEqual(persisted)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
  })

  it("recovers active goals as paused, supports explicit resume and durable clear", async () => {
    expect((await request("/goal Work")).status).toBe(200)
    stop()
    stop = initializeThreadGoals(state)
    expect(threads.getThreadGoal("thread")?.status).toBe("paused")
    await vi.advanceTimersByTimeAsync(3000)
    expect(dispatchChatTurn).not.toHaveBeenCalled()
    expect((await request("/goal resume")).status).toBe(200)
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
    expect((await request("/goal clear")).status).toBe(200)
    expect(threads.getThreadGoal("thread")).toBeNull()
  })

  it("refuses nonexistent chats, unsupported providers and unacknowledged journal writes", async () => {
    expect((await request("/goal Work", "deleted")).status).toBe(404)
    expect(
      (await request("/goal Work", "thread", "legacy-plugin")).status
    ).toBe(400)
    ingestion.stop()
    expect((await request("/goal Work")).status).toBe(400)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dispatchChatTurn).not.toHaveBeenCalled()
    expect(threads.getThreadGoal("thread")).toBeUndefined()
  })
})
