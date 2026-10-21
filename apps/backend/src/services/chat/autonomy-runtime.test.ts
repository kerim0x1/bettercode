import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { registerChatRoutes as registerChatRoutesUnfilled } from "../../http/routes/chat"
import { registerChatAutonomyRoutes } from "../../http/routes/chat-autonomy"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import { openDatabase, type Db } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import { ProviderEventBus } from "../../provider/events"
import {
  forgetSessionPermission,
  setSessionPermission,
} from "../../provider/permissions"
import { ProviderRuntimeEventJournal } from "../../provider/runtime/ProviderRuntimeEventJournal"
import { ProviderRuntimeIngestion } from "../../provider/runtime/ProviderRuntimeIngestion"
import { ProviderRuntimeProjectionReceiptStore } from "../../provider/runtime/ProviderRuntimeProjectionReceiptStore"
import { ThreadTurnCoordinator } from "../../provider/threadTurnCoordinator"
import { withInertStateArgument } from "../../testUtils/inert-app-state"
import { ThreadService } from "../threads/service"
import {
  AUTONOMY_FOLLOW_UP_DELAY_MS,
  AUTONOMY_RESTART_REASON,
} from "./autonomy"
import { threadAutonomyRuns } from "./autonomy-registry"
import { initializeThreadAutonomy } from "./autonomy-runtime"
import { dispatchChatTurn } from "./dispatch"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerChatRoutes = withInertStateArgument(registerChatRoutesUnfilled, 1)

/** The bus the runtime and ingestion under test share. */
const providerEventBus = new ProviderEventBus()

/** What the next mocked turns answer, in order; then "Still working on it." */
const replies: string[] = []
const chat: { threads: ThreadService | null; turns: number } = {
  threads: null,
  turns: 0,
}

vi.mock("./dispatch", async (original) => ({
  ...(await original<typeof import("./dispatch")>()),
  prepareChatSendBody: vi.fn(async (_state, body) => body),
  // A turn that is admitted, starts and answers at once.
  dispatchChatTurn: vi.fn(async (_state, body, reserve, hooks) => {
    reserve()
    hooks?.guard()
    chat.turns += 1
    const turnId = `turn-${chat.turns}`
    hooks?.started({ turnId, settled: Promise.resolve() })
    chat.threads!.upsertMessage({
      thread_id: body.thread_id,
      message: {
        message_id: `reply-${chat.turns}`,
        turn_id: null,
        role: "assistant",
        content: replies.shift() ?? "Still working on it.",
        created_at: new Date().toISOString(),
        extra: {},
      },
    })
    return { status: "streaming", turnId }
  }),
}))

const OPENING = "[Autonomous Work — run started]\n\nTask list:\n- [ ] parser"

describe("Autonomous Work HTTP, journal and dispatch wiring", () => {
  let db: Db
  let dir: string
  let threads: ThreadService
  let state: AppState
  let app: Hono
  let ingestion: ProviderRuntimeIngestion
  let stop: () => void
  const broadcast = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    replies.length = 0
    chat.turns = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-autonomy-"))
    db = openDatabase(path.join(dir, "test.sqlite"))
    runMigrations(db)
    threads = new ThreadService(db)
    chat.threads = threads
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
      taintedRef: () => false,
      drainingRef: () => false,
      providerHub: {
        has: () => true,
        waitForThreadIdle: async () => {},
        interruptTurnIfActive: vi.fn(),
      },
      providers: {
        resolveProviderKind: (raw: string) => {
          throw new HttpError(400, `Unknown provider kind: ${raw}`)
        },
      },
    } as unknown as AppState
    ingestion = new ProviderRuntimeIngestion({
      eventBus: providerEventBus,
      eventJournal: new ProviderRuntimeEventJournal(new EventStore(db)),
      projectionReceipts: new ProviderRuntimeProjectionReceiptStore(db),
      threadMetadataStore: threads,
      activityStore: { upsert: vi.fn() },
      broadcaster: { broadcast, clientCount: () => 1 },
      logger: log,
      projectedSink: (event) => providerEventBus.emitProjected(event),
    })
    ingestion.start()
    stop = initializeThreadAutonomy(state, providerEventBus)
    app = new Hono()
    registerChatRoutes(app, state)
  })

  afterEach(() => {
    stop()
    ingestion.stop()
    db.close()
    forgetSessionPermission("thread")
    vi.useRealTimers()
    if (
      path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith("bc-autonomy-")
    )
      throw new Error("Unexpected test path")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const post = (route: string, body: Record<string, unknown>) =>
    app.request(`/chat/autonomy/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  const start = (overrides: Record<string, unknown> = {}) =>
    post("start", {
      threadId: "thread",
      message: OPENING,
      modelId: "codex-model",
      providerKind: "codex",
      permissionLevel: "read-only",
      reasoningEffort: "high",
      userMessageId: "opening",
      userMessageContent: OPENING,
      userMessageCreatedAt: new Date().toISOString(),
      autonomy: {
        tasks: [
          { id: "parser", text: "Write the parser" },
          { id: "tests", text: "Test it" },
        ],
        maxIterations: 3,
        timeBudgetMin: 0,
      },
      ...overrides,
    })
  const dispatched = (call: number) =>
    vi.mocked(dispatchChatTurn).mock.calls[call]?.[1]
  const idleDelay = () =>
    vi.advanceTimersByTimeAsync(AUTONOMY_FOLLOW_UP_DELAY_MS)

  it("journals the run, sends the opening message and continues until the summary", async () => {
    replies.push("Parser written.\n[TASK_DONE:parser]", "[TASK_DONE:tests]")
    const response = await start()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      autonomy: { status: "working", iterations: 0, maxIterations: 3 },
      turn: { status: "streaming", turnId: "turn-1" },
    })
    expect(threads.getThreadAutonomy("thread")).toMatchObject({
      status: "working",
      tasks: [
        { id: "parser", done: false },
        { id: "tests", done: false },
      ],
    })
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
    expect(dispatched(0)).toMatchObject({
      thread_id: "thread",
      message: OPENING,
      user_message_id: "opening",
      provider_kind: "codex",
      model_id: "codex-model",
      permission_level: "read-only",
    })

    await idleDelay()
    expect(dispatchChatTurn).toHaveBeenCalledTimes(2)
    const followUp = dispatched(1)!
    expect(followUp.message).toContain("Iteration 1/3.")
    expect(followUp.message).toContain("- [x] parser: Write the parser")
    expect(followUp).toMatchObject({
      user_message_content: followUp.message,
      model_id: "codex-model",
      reasoning_effort: "high",
      attachments: [],
      history: [],
    })
    expect(followUp.user_message_id).not.toBe("opening")
    expect(threads.getThreadAutonomy("thread")).toMatchObject({
      iterations: 1,
      tasks: [{ done: true }, { done: false }],
    })
    // The follow-up's message reached the clients with the run's state.
    const frames = JSON.stringify(broadcast.mock.calls)
    expect(frames).toContain(followUp.user_message_id!)
    expect(frames).toContain('"autonomyPrompt"')
    expect(threads.getThreadSummary("thread")).toMatchObject({
      autonomy: { status: "working", iterations: 1 },
    })

    await idleDelay()
    expect(dispatchChatTurn).toHaveBeenCalledTimes(3)
    expect(dispatched(2)!.message).toContain(
      "The autonomous run is stopping because all tasks are complete."
    )
    expect(threads.getThreadAutonomy("thread")).toMatchObject({
      status: "completed",
      stopReason: "completion-signal",
    })
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(3)
  })

  it("sends the turns after the first at the chat's live permission level", async () => {
    expect((await start()).status).toBe(200)
    setSessionPermission("thread", "allow-edits")
    await idleDelay()
    expect(dispatched(1)).toMatchObject({ permission_level: "allow-edits" })
  })

  it("pauses a run across a backend restart until it is resumed through HTTP", async () => {
    expect((await start()).status).toBe(200)
    stop()
    expect(threadAutonomyRuns.has(state)).toBe(false)
    stop = initializeThreadAutonomy(state, providerEventBus)
    expect(threads.getThreadAutonomy("thread")).toMatchObject({
      status: "paused",
      lastReason: AUTONOMY_RESTART_REASON,
    })
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)

    const resumed = await post("resume", {
      threadId: "thread",
      modelId: "other-model",
      providerKind: "codex",
      permissionLevel: "ask-on-edit",
    })
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toMatchObject({
      autonomy: { status: "working", stopReason: null },
    })
    await idleDelay()
    expect(dispatchChatTurn).toHaveBeenCalledTimes(2)
    expect(dispatched(1)).toMatchObject({
      model_id: "other-model",
      permission_level: "ask-on-edit",
    })
    expect(dispatched(1)!.message).toContain("Iteration 1/3.")
  })

  it("pauses, changes a task and stops through HTTP", async () => {
    expect((await start()).status).toBe(200)
    const paused = await post("pause", { threadId: "thread" })
    expect(await paused.json()).toMatchObject({
      autonomy: { status: "paused" },
    })
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)

    const ticked = await post("task", {
      threadId: "thread",
      taskId: "tests",
      done: true,
    })
    expect(await ticked.json()).toMatchObject({
      autonomy: { tasks: [{ done: false }, { done: true }] },
    })
    expect(
      (await post("task", { threadId: "thread", taskId: "nope", done: true }))
        .status
    ).toBe(409)

    const stopped = await post("stop", { threadId: "thread" })
    expect(await stopped.json()).toEqual({ autonomy: null })
    expect(threads.getThreadAutonomy("thread")).toBeNull()
    expect(threads.getThreadSummary("thread")).not.toHaveProperty("autonomy")
    expect((await post("pause", { threadId: "thread" })).status).toBe(409)
  })

  it("refuses a missing chat, a provider the backend does not run and a run without tasks", async () => {
    expect((await start({ threadId: "deleted" })).status).toBe(404)
    expect((await start({ providerKind: "my-plugin" })).status).toBe(400)
    expect(
      (
        await start({
          autonomy: { tasks: [], maxIterations: 3, timeBudgetMin: 0 },
        })
      ).status
    ).toBe(400)
    expect(dispatchChatTurn).not.toHaveBeenCalled()
    expect(threads.getThreadAutonomy("thread")).toBeNull()
  })

  it("leaves no run when the opening message is refused", async () => {
    vi.mocked(dispatchChatTurn).mockRejectedValueOnce(
      new HttpError(403, "Trust this folder first.", "workspace_untrusted")
    )
    const response = await start()
    expect(response.status).toBe(403)
    expect(threads.getThreadAutonomy("thread")).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(dispatchChatTurn).toHaveBeenCalledTimes(1)
  })

  it("caps a paired device's run and keeps its turn ownership for every turn", async () => {
    const reservation = {
      id: "phone",
    } as unknown as RemoteProviderTurnReservation
    const remote = new Hono()
    registerChatAutonomyRoutes(remote, state, {
      permissionAccess: () => ({ remote: true, mayBypass: false }),
      reserveRemoteTurn: () => reservation,
    })
    const response = await remote.request("/chat/autonomy/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread",
        message: OPENING,
        modelId: "codex-model",
        providerKind: "codex",
        permissionLevel: "bypass",
        autonomy: {
          tasks: [{ id: "parser", text: "Write the parser" }],
          maxIterations: 3,
          timeBudgetMin: 0,
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(dispatched(0)).toMatchObject({ permission_level: "ask-on-edit" })
    await idleDelay()
    expect(dispatchChatTurn).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(dispatchChatTurn).mock.calls)
      expect(call[2]()).toBe(reservation)
  })

  it("never takes a provider's metadata for a run", () => {
    providerEventBus.emitCanonical({
      eventId: "provider-metadata",
      threadId: "thread",
      providerKind: "codex",
      type: "thread.metadata.updated",
      at: Date.now(),
      payload: {
        metadata: {
          autonomy: {
            id: "forged",
            status: "working",
            tasks: [],
            iterations: 0,
            maxIterations: 1,
            timeBudgetMin: 0,
            startedAt: 0,
            updatedAt: 0,
            stopReason: null,
          },
          autonomyMutationId: "forged",
        },
      },
    })
    expect(threads.getThreadAutonomy("thread")).toBeNull()
  })
})
