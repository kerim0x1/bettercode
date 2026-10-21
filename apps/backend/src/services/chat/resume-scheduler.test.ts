import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  chatSendSchema,
  RESUME_AFTER_RESTART_MESSAGE,
  type ThreadResume,
} from "@betterc0de/schema"
import type { LegacyProviderEvent } from "../../provider/types"
import {
  ChatResumeScheduler,
  type ChatResumePorts,
  type ChatResumeSettings,
  type ResumeDispatchRequest,
} from "./resume-scheduler"
import type {
  ChatResumeStore,
  PendingResumeRow,
  ResumeTurnState,
} from "./resume-store"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const start = Date.parse("2026-10-20T10:00:00Z")

/** The chat store's rules without SQLite: rows exist only for known chats. */
class MemoryStore implements ChatResumeStore {
  readonly records = new Map<string, ThreadResume>()
  readonly turns = new Map<string, ResumeTurnState>()
  readonly threads = new Set(["thread"])
  readonly automatic: Array<[string, string, string]> = []

  hasThread(threadId: string) {
    return this.threads.has(threadId)
  }
  readRecord(threadId: string) {
    return this.records.get(threadId) ?? null
  }
  writeRecord(threadId: string, record: ThreadResume | null) {
    if (!this.threads.has(threadId)) return
    if (record) this.records.set(threadId, record)
    else this.records.delete(threadId)
  }
  readTurnState(threadId: string) {
    return this.turns.get(threadId) ?? null
  }
  writeTurnState(threadId: string, state: ResumeTurnState | null) {
    if (!this.threads.has(threadId)) return
    if (
      state &&
      (state.template || state.running || state.restartContinuations)
    )
      this.turns.set(threadId, state)
    else this.turns.delete(threadId)
  }
  listPending(): PendingResumeRow[] {
    return [...this.threads]
      .map((threadId) => ({
        threadId,
        record: this.readRecord(threadId),
        turn: this.readTurnState(threadId),
      }))
      .filter((row) => row.record || row.turn?.running)
  }
  markAutomatic(threadId: string, messageId: string, kind: string) {
    this.automatic.push([threadId, messageId, kind])
  }
}

function sendBody(messageId: string, message = "Fix the failing tests") {
  return chatSendSchema.parse({
    threadId: "thread",
    message,
    userMessageId: messageId,
    providerKind: "claude",
    providerInstanceId: "claude",
    modelId: "claude-opus-4-7",
    permissionLevel: "allow-edits",
  })
}

function event(
  event_type: string,
  payload: Record<string, unknown> = {}
): LegacyProviderEvent {
  return {
    event_type,
    thread_id: "thread",
    payload: {
      providerKind: "claude",
      providerInstanceId: "claude",
      ...payload,
    },
  }
}

function setup(
  options: {
    readonly store?: MemoryStore
    readonly settings?: Partial<ChatResumeSettings>
    readonly canResume?: boolean
  } = {}
) {
  const store = options.store ?? new MemoryStore()
  const sent: ResumeDispatchRequest[] = []
  let failure: Error | null = null
  const published: Array<{
    record: ThreadResume | null
    prompt: unknown
  }> = []
  const ports: ChatResumePorts = {
    store,
    now: () => Date.now(),
    random: () => 0,
    settings: () => ({
      resumeAfterUsageLimit: true,
      continueAfterRestart: true,
      autoSave: true,
      ...options.settings,
    }),
    canResumeSession: () => options.canResume ?? true,
    isIdle: () => true,
    dispatch: vi.fn(async (request, guard, started) => {
      guard()
      if (failure) {
        const error = failure
        failure = null
        throw error
      }
      sent.push(request)
      // dispatchChatTurn reports the send before the provider starts it.
      scheduler.noteDispatch(
        chatSendSchema.parse({
          ...request.template,
          thread_id: request.threadId,
          message: request.content,
          user_message_id: request.messageId,
        }),
        "scheduler"
      )
      started({
        turnId: `resume-${sent.length}`,
        settled: new Promise(() => {}),
      })
    }),
    publish: vi.fn((_threadId, record, prompt) => {
      published.push({ record, prompt })
    }),
    onError: vi.fn(),
  }
  const scheduler = new ChatResumeScheduler(ports)
  const userTurn = (turnId: string) => {
    scheduler.noteDispatch(sendBody(`message-${turnId}`), "user")
    scheduler.observe(event("turn_started", { turn_id: turnId }))
  }
  const limited = (turnId: string, payload: Record<string, unknown>) =>
    scheduler.observe(
      event("turn_error", { turn_id: turnId, status: "failed", ...payload })
    )
  return {
    scheduler,
    store,
    sent,
    published,
    ports,
    userTurn,
    limited,
    failNext: (error: Error) => {
      failure = error
    },
    record: () => store.readRecord("thread"),
  }
}

const resetIn = (ms: number) => Math.round((Date.now() + ms) / 1000)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
})
afterEach(() => vi.useRealTimers())

describe("resuming after a usage limit", () => {
  it("sends Continue. just after the reset and clears the record once the turn ran", async () => {
    const f = setup()
    f.userTurn("turn-1")
    expect(f.store.readTurnState("thread")?.running).toMatchObject({
      turnId: "turn-1",
      origin: "user",
    })
    f.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })
    expect(f.record()).toMatchObject({
      reason: "usage_limit",
      mode: "auto",
      status: "waiting",
      resetAt: start + HOUR,
      resumeAt: start + HOUR + 30_000,
      failures: 0,
      resumable: true,
    })
    // The turn is over; its settings stay for the resume.
    expect(f.store.readTurnState("thread")?.running).toBeUndefined()
    expect(f.store.readTurnState("thread")?.template).toMatchObject({
      model_id: "claude-opus-4-7",
    })

    await vi.advanceTimersByTimeAsync(HOUR + 29_000)
    expect(f.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({ content: "Continue.", caller: null })
    expect(f.record()?.status).toBe("resuming")
    expect(f.store.automatic).toEqual([
      ["thread", f.sent[0]!.messageId, "usage-limit"],
    ])
    expect(f.published.at(-1)?.prompt).toMatchObject({
      messageId: f.sent[0]!.messageId,
      content: "Continue.",
      automatic: "usage-limit",
      modelId: "claude-opus-4-7",
    })

    f.scheduler.observe(event("turn_started", { turn_id: "resume-1" }))
    expect(f.store.readTurnState("thread")?.running?.origin).toBe("resume")
    f.scheduler.observe(event("turn_completed", { turn_id: "resume-1" }))
    expect(f.record()).toBeNull()
    expect(f.published.at(-1)?.record).toBeNull()
  })

  it("adds the reset time a second report of the same turn names", () => {
    const f = setup()
    f.userTurn("turn-1")
    f.scheduler.observe(
      event("turn_error", { error: "You've hit your usage limit." })
    )
    expect(f.record()).toMatchObject({
      resetAt: null,
      resumeAt: start + 30 * MINUTE,
    })
    f.limited("turn-1", {
      error: "Claude SDK reported a failure",
      detail: { limit: { kind: "usage", resetAt: resetIn(2 * HOUR) } },
    })
    expect(f.record()).toMatchObject({
      resetAt: start + 2 * HOUR,
      resumeAt: start + 2 * HOUR + 30_000,
      failures: 0,
    })
  })

  it("stands down when the user sends something or stops the chat", async () => {
    const f = setup()
    f.userTurn("turn-1")
    f.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })
    f.scheduler.noteDispatch(sendBody("message-2", "Try this instead"), "user")
    expect(f.record()).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(f.sent).toHaveLength(0)

    f.userTurn("turn-2")
    f.scheduler.noteUserStop("thread")
    expect(f.store.readTurnState("thread")?.running).toBeUndefined()
  })

  it("follows the user's choice: don't resume, resume at reset, resume now", async () => {
    const f = setup()
    f.userTurn("turn-1")
    f.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })

    expect(await f.scheduler.control("thread", "cancel")).toMatchObject({
      mode: "off",
      resumeAt: null,
    })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(f.sent).toHaveLength(0)

    vi.setSystemTime(start)
    expect(await f.scheduler.control("thread", "schedule")).toMatchObject({
      mode: "auto",
      resumeAt: start + HOUR + 30_000,
    })
    expect(await f.scheduler.control("thread", "now")).toMatchObject({
      status: "resuming",
    })
    expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(f.sent).toHaveLength(1)

    expect(await f.scheduler.control("thread", "dismiss")).toBeNull()
    expect(f.record()).toBeNull()
  })

  it("keeps the schedule when Resume now cannot start", async () => {
    const f = setup()
    f.userTurn("turn-1")
    f.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })
    f.ports.isIdle = () => false
    await expect(f.scheduler.control("thread", "now")).rejects.toThrow("busy")
    expect(f.record()).toMatchObject({ mode: "auto", status: "waiting" })
    f.ports.isIdle = () => true
    await vi.advanceTimersByTimeAsync(HOUR + 30_000)
    expect(f.sent).toHaveLength(1)
  })

  it("re-arms when the resumed turn meets the limit again and gives up at the third time", async () => {
    const f = setup()
    f.userTurn("turn-1")
    f.limited("turn-1", { error: "You've hit your usage limit." })
    const delays = [30 * MINUTE, HOUR, 2 * HOUR]
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay)
      expect(f.sent).toHaveLength(index + 1)
      const turnId = `resume-${index + 1}`
      f.scheduler.observe(event("turn_started", { turn_id: turnId }))
      f.limited(turnId, { error: "You've hit your usage limit." })
      expect(f.record()?.failures).toBe(index + 1)
    }
    expect(f.record()).toMatchObject({
      mode: "off",
      resumeAt: null,
      note: expect.stringContaining("3 tries"),
    })
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(f.sent).toHaveLength(3)
  })

  it("backs off when the turn cannot be sent", async () => {
    const f = setup()
    f.userTurn("turn-1")
    f.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })
    f.failNext(new Error("Claude is not available."))
    await vi.advanceTimersByTimeAsync(HOUR + 30_000)
    expect(f.record()).toMatchObject({
      mode: "auto",
      status: "waiting",
      failures: 1,
      resumeAt: Date.now() + HOUR,
    })
  })

  it("waits for the user without the setting or for another scheduler's turn", async () => {
    const off = setup({ settings: { resumeAfterUsageLimit: false } })
    off.userTurn("turn-1")
    off.limited("turn-1", { error: "You've hit your usage limit." })
    expect(off.record()).toMatchObject({ mode: "off", resumeAt: null })

    const goal = setup()
    goal.scheduler.noteDispatch(sendBody("goal-1"), "scheduler")
    goal.scheduler.observe(event("turn_started", { turn_id: "turn-1" }))
    goal.limited("turn-1", { error: "You've hit your usage limit." })
    expect(goal.record()).toMatchObject({ mode: "off" })
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(off.sent).toHaveLength(0)
    expect(goal.sent).toHaveLength(0)
  })

  it("arms a record again after a restart", async () => {
    const before = setup()
    before.userTurn("turn-1")
    before.limited("turn-1", {
      error: `Claude AI usage limit reached|${resetIn(HOUR)}`,
    })
    before.scheduler.beginShutdown()
    before.scheduler.dispose()

    vi.setSystemTime(start + 2 * HOUR)
    const after = setup({ store: before.store })
    after.scheduler.recover()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(after.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(after.sent).toHaveLength(1)
  })
})

describe("continuing after a restart", () => {
  it("continues a turn a quit cut off, once, with a note", async () => {
    const before = setup()
    before.userTurn("turn-1")
    // The shutdown interrupts the turn; the marker stays.
    before.scheduler.beginShutdown()
    before.scheduler.observe(event("turn_interrupted", { turn_id: "turn-1" }))
    before.scheduler.dispose()
    expect(before.store.readTurnState("thread")?.running).toBeDefined()

    const after = setup({ store: before.store })
    after.scheduler.recover()
    expect(after.record()).toMatchObject({
      reason: "restart",
      mode: "auto",
      resumeAt: start + 15_000,
    })
    expect(after.store.readTurnState("thread")).toMatchObject({
      restartContinuations: 1,
    })
    expect(after.store.readTurnState("thread")?.running).toBeUndefined()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(after.sent).toHaveLength(1)
    expect(after.sent[0]?.content).toBe(RESUME_AFTER_RESTART_MESSAGE)
    expect(after.store.automatic.at(-1)?.[2]).toBe("restart")

    after.scheduler.observe(event("turn_started", { turn_id: "resume-1" }))
    after.scheduler.observe(event("turn_completed", { turn_id: "resume-1" }))
    expect(after.record()).toBeNull()

    // Nothing is left for a later start to continue.
    const again = setup({ store: before.store })
    again.scheduler.recover()
    expect(again.record()).toBeNull()
  })

  it("does not continue a chat that waited for an approval", () => {
    const before = setup()
    before.userTurn("turn-1")
    before.scheduler.observe(
      event("tool_approval_requested", { requestId: "approval-1" })
    )
    before.scheduler.beginShutdown()

    const after = setup({ store: before.store })
    after.scheduler.recover()
    expect(after.record()).toMatchObject({
      reason: "restart",
      mode: "off",
      resumeAt: null,
      note: expect.stringContaining("approval"),
    })
  })

  it("leaves chats the user stopped, providers that cannot resume, and the setting off", () => {
    const stopped = setup()
    stopped.userTurn("turn-1")
    stopped.scheduler.noteUserStop("thread")
    stopped.scheduler.beginShutdown()
    const afterStop = setup({ store: stopped.store })
    afterStop.scheduler.recover()
    expect(afterStop.record()).toBeNull()

    for (const options of [
      { canResume: false },
      { settings: { continueAfterRestart: false } },
    ]) {
      const before = setup()
      before.userTurn("turn-1")
      before.scheduler.beginShutdown()
      const after = setup({ store: before.store, ...options })
      after.scheduler.recover()
      expect(after.record()).toBeNull()
      expect(after.store.readTurnState("thread")?.running).toBeUndefined()
    }
  })

  it("stops continuing after several restarts in a row", () => {
    const store = new MemoryStore()
    store.turns.set("thread", {
      template: { provider_kind: "claude", model_id: "claude-opus-4-7" },
      restartContinuations: 3,
      running: {
        turnId: "turn-9",
        origin: "restart",
        startedAt: start,
        providerKind: "claude",
        providerInstanceId: "claude",
        waitingForApproval: false,
      },
    })
    const after = setup({ store })
    after.scheduler.recover()
    expect(after.record()).toMatchObject({ mode: "off", resumeAt: null })
  })

  it("counts a continuation that a restart cut off again", () => {
    const running = {
      turnId: "resume-1",
      origin: "restart",
      startedAt: start,
      providerKind: "claude",
      providerInstanceId: "claude",
      waitingForApproval: false,
    } as const
    const resuming: ThreadResume = {
      reason: "restart",
      stoppedAt: start,
      resetAt: null,
      mode: "auto",
      resumeAt: null,
      status: "resuming",
      failures: 0,
      resumable: true,
      providerKind: "claude",
      note: null,
    }
    const template = { provider_kind: "claude", model_id: "claude-opus-4-7" }

    const again = new MemoryStore()
    again.records.set("thread", resuming)
    again.turns.set("thread", {
      template,
      restartContinuations: 1,
      running,
    })
    setup({ store: again }).scheduler.recover()
    expect(again.readRecord("thread")).toMatchObject({
      mode: "auto",
      status: "waiting",
      resumeAt: start + 15_000,
    })
    expect(again.readTurnState("thread")).toEqual({
      template,
      restartContinuations: 2,
    })

    const exhausted = new MemoryStore()
    exhausted.records.set("thread", resuming)
    exhausted.turns.set("thread", {
      template,
      restartContinuations: 3,
      running,
    })
    setup({ store: exhausted }).scheduler.recover()
    expect(exhausted.readRecord("thread")).toMatchObject({
      mode: "off",
      status: "waiting",
      resumeAt: null,
    })
  })
})
