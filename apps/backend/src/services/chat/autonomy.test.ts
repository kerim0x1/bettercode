import type {
  AutonomyPrompt,
  AutonomyRunConfig,
  ThreadAutonomy,
} from "@betterc0de/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AUTONOMY_FOLLOW_UP_DELAY_MS,
  AUTONOMY_RESTART_REASON,
  AutonomyCommandError,
  ThreadAutonomyRuns,
  autonomyFollowUpPrompt,
  autonomyStopReason,
  readTaskDoneMarkers,
  type AutonomyPorts,
} from "./autonomy"

interface Context {
  model: string
}

const CONFIG: AutonomyRunConfig = {
  tasks: [
    { id: "parser", text: "Write the parser" },
    { id: "tests", text: "Test it" },
  ],
  maxIterations: 5,
  timeBudgetMin: 0,
}

function setup() {
  const saved = new Map<string, ThreadAutonomy | null>()
  const published: Array<{
    autonomy: ThreadAutonomy | null
    prompt?: AutonomyPrompt
  }> = []
  const turns: Array<{ prompt: AutonomyPrompt; context: Context }> = []
  /** What the next turns answer, in order; then "Still working on it." */
  const replies: string[] = []
  const state = {
    clock: 1_000_000,
    idle: true,
    lastReply: "",
    releaseIdle: null as (() => void) | null,
    refuseNext: null as unknown,
    duringDispatch: null as (() => void) | null,
  }
  const ports: AutonomyPorts<Context> = {
    read: (threadId) => saved.get(threadId),
    publish: vi.fn((threadId, autonomy, prompt) => {
      saved.set(threadId, autonomy)
      published.push({ autonomy, ...(prompt ? { prompt } : {}) })
    }),
    isIdle: () => state.idle,
    waitForIdle: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          state.releaseIdle = resolve
        })
    ),
    lastReply: () => state.lastReply,
    dispatch: vi.fn(async (_threadId, prompt, context, guard, started) => {
      state.duringDispatch?.()
      guard()
      if (state.refuseNext) {
        const error = state.refuseNext
        state.refuseNext = null
        throw error
      }
      turns.push({ prompt, context })
      started()
      state.lastReply = replies.shift() ?? "Still working on it."
    }),
    modelId: (context) => context.model,
    onError: vi.fn(),
    now: () => state.clock,
  }
  const runs = new ThreadAutonomyRuns(ports)
  const start = (
    openingReply: string,
    config: AutonomyRunConfig = CONFIG,
    context: Context = { model: "selected-model" }
  ) =>
    runs.start("thread", config, context, async (guard) => {
      guard()
      state.lastReply = openingReply
      return { status: "streaming", turnId: "opening" }
    })
  /** One follow-up delay of idleness. */
  const idleDelay = () =>
    vi.advanceTimersByTimeAsync(AUTONOMY_FOLLOW_UP_DELAY_MS)
  const current = () => saved.get("thread") ?? null
  return {
    runs,
    ports,
    saved,
    published,
    turns,
    replies,
    state,
    start,
    idleDelay,
    current,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("Autonomous Work scheduler", () => {
  it("journals the run before its opening message and waits for an idle chat", async () => {
    const f = setup()
    const { autonomy, result } = await f.start("Plan first.")
    expect(result).toEqual({ status: "streaming", turnId: "opening" })
    expect(autonomy).toMatchObject({
      status: "working",
      iterations: 0,
      maxIterations: 5,
      timeBudgetMin: 0,
      startedAt: 1_000_000,
      stopReason: null,
      tasks: [
        { id: "parser", text: "Write the parser", done: false },
        { id: "tests", text: "Test it", done: false },
      ],
    })
    expect(f.current()).toEqual(autonomy)
    await vi.advanceTimersByTimeAsync(AUTONOMY_FOLLOW_UP_DELAY_MS - 1)
    expect(f.turns).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.turns).toHaveLength(1)
  })

  it("ticks tasks off from markers and sends the follow-up with its message announced", async () => {
    const f = setup()
    await f.start(
      "Done with the parser.\n[TASK_DONE:parser]\n[TASK_DONE:unknown]"
    )
    await f.idleDelay()
    expect(f.turns).toHaveLength(1)
    const prompt = f.turns[0]!.prompt
    expect(prompt.content).toContain(
      "Continue the autonomous run for: Write the parser. Iteration 1/5."
    )
    expect(prompt.content).toContain("- [x] parser: Write the parser")
    expect(prompt.content).toContain("- [ ] tests: Test it")
    expect(prompt.content).toContain("Briefly summarize progress")
    expect(prompt.modelId).toBe("selected-model")
    expect(f.turns[0]!.context).toEqual({ model: "selected-model" })
    // The marker is journaled first, then the counted iteration with the
    // message of the turn that just started.
    expect(f.published.at(-2)?.autonomy?.tasks[0]?.done).toBe(true)
    expect(f.published.at(-1)).toEqual({
      autonomy: expect.objectContaining({ iterations: 1, status: "working" }),
      prompt,
    })
  })

  it("ends with one summary turn once every task is done", async () => {
    const f = setup()
    f.replies.push("[TASK_DONE:tests]")
    await f.start("[TASK_DONE:parser]")
    await f.idleDelay()
    await f.idleDelay()
    expect(f.turns).toHaveLength(2)
    const summary = f.turns[1]!.prompt.content
    expect(summary).toContain(
      "The autonomous run is stopping because all tasks are complete."
    )
    expect(summary).toContain("Task list snapshot (2/2 done)")
    expect(f.current()).toMatchObject({
      status: "completed",
      stopReason: "completion-signal",
      iterations: 1,
    })
    expect(f.published.at(-1)?.prompt?.content).toBe(summary)
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(2)
  })

  it("stops at the iteration cap", async () => {
    const f = setup()
    f.replies.push("First pass.", "Second pass.")
    await f.start("Plan.", { ...CONFIG, maxIterations: 2 })
    await f.idleDelay()
    await f.idleDelay()
    await f.idleDelay()
    expect(f.turns.map((turn) => turn.prompt.content)).toEqual([
      expect.stringContaining("Iteration 1/2."),
      expect.stringContaining("Iteration 2/2."),
      expect.stringContaining("because the iteration cap was reached"),
    ])
    expect(f.current()).toMatchObject({
      status: "completed",
      stopReason: "max-iterations",
      iterations: 2,
    })
  })

  it("stops when the time budget is spent", async () => {
    const f = setup()
    await f.start("Plan.", { ...CONFIG, timeBudgetMin: 1 })
    f.state.clock += 60_000
    await f.idleDelay()
    expect(f.turns).toHaveLength(1)
    expect(f.turns[0]!.prompt.content).toContain(
      "because the wall-clock time budget was reached"
    )
    expect(f.current()).toMatchObject({
      status: "completed",
      stopReason: "time-budget",
    })
  })

  it("treats a completion phrase in the last reply as the end", async () => {
    const f = setup()
    await f.start("Everything is done; all tasks are complete.")
    await f.idleDelay()
    expect(f.turns[0]!.prompt.content).toContain(
      "because all tasks are complete"
    )
    expect(f.current()?.stopReason).toBe("completion-signal")
  })

  it("refreshes the plan every fourth iteration and when the replies stop changing", async () => {
    const f = setup()
    f.replies.push("A", "B", "C", "D", "D", "D")
    await f.start("Start", { ...CONFIG, maxIterations: 10 })
    for (let i = 0; i < 7; i++) await f.idleDelay()
    const refreshed = f.turns.map((turn) =>
      turn.prompt.content.includes("First refresh a concise plan")
    )
    // Iteration 4 refreshes by count; 7 after the reply repeated twice.
    expect(refreshed).toEqual([false, false, false, true, false, false, true])
  })

  it("lets another turn in the chat go first and waits for it", async () => {
    const f = setup()
    await f.start("Plan.")
    f.state.idle = false
    await f.idleDelay()
    expect(f.ports.waitForIdle).toHaveBeenCalledTimes(1)
    expect(f.turns).toHaveLength(0)
    f.state.idle = true
    f.state.lastReply = "The user's turn: [TASK_DONE:parser]"
    f.state.releaseIdle?.()
    await vi.advanceTimersByTimeAsync(AUTONOMY_FOLLOW_UP_DELAY_MS - 1)
    expect(f.turns).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.turns).toHaveLength(1)
    expect(f.current()?.tasks[0]?.done).toBe(true)
  })

  it("retries when the chat got busy at admission instead of failing", async () => {
    const f = setup()
    await f.start("Plan.")
    f.state.refuseNext = Object.assign(new Error("busy"), {
      code: "turn_active",
    })
    await f.idleDelay()
    expect(f.turns).toHaveLength(0)
    expect(f.current()?.status).toBe("working")
    await f.idleDelay()
    expect(f.turns).toHaveLength(1)
  })

  it("pauses on a refused turn and keeps the reason", async () => {
    const f = setup()
    await f.start("Plan.")
    f.state.refuseNext = new Error("Codex is not configured")
    await f.idleDelay()
    expect(f.current()).toMatchObject({
      status: "paused",
      stopReason: "error",
      lastReason: "Codex is not configured",
    })
    await f.idleDelay()
    expect(f.turns).toHaveLength(0)
  })

  it("pauses without interrupting and resumes with the new context and a fresh clock", async () => {
    const f = setup()
    await f.start("Plan.")
    expect(f.runs.pause("thread")).toMatchObject({ status: "paused" })
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(0)
    f.state.clock += 5 * 60_000
    const resumed = f.runs.resume("thread", { model: "other-model" })
    expect(resumed).toMatchObject({
      status: "working",
      startedAt: f.state.clock,
      stopReason: null,
    })
    await f.idleDelay()
    expect(f.turns).toHaveLength(1)
    expect(f.turns[0]!.context).toEqual({ model: "other-model" })
    expect(f.turns[0]!.prompt.modelId).toBe("other-model")
  })

  it("drops a follow-up the user paused while it was being admitted", async () => {
    const f = setup()
    await f.start("Plan.")
    f.state.duringDispatch = () => {
      f.state.duringDispatch = null
      f.runs.pause("thread")
    }
    await f.idleDelay()
    expect(f.turns).toHaveLength(0)
    expect(f.current()).toMatchObject({ status: "paused", stopReason: null })
  })

  it("stop ends the run without a summary", async () => {
    const f = setup()
    await f.start("Plan.")
    expect(f.runs.stop("thread")).toBeNull()
    expect(f.saved.get("thread")).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(0)
    expect(() => f.runs.pause("thread")).toThrow(AutonomyCommandError)
  })

  it("leaves no run when the opening message is refused", async () => {
    const f = setup()
    await expect(
      f.runs.start("thread", CONFIG, { model: "m" }, async () => {
        throw new Error("workspace untrusted")
      })
    ).rejects.toThrow("workspace untrusted")
    expect(f.saved.get("thread")).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(0)
  })

  it("ends the run when the user ticks the last task off by hand", async () => {
    const f = setup()
    await f.start("Plan.")
    f.runs.setTaskDone("thread", "parser", true)
    f.runs.setTaskDone("thread", "tests", true)
    expect(f.current()?.tasks.every((task) => task.done)).toBe(true)
    expect(() => f.runs.setTaskDone("thread", "missing", true)).toThrow(
      AutonomyCommandError
    )
    await f.idleDelay()
    expect(f.turns[0]!.prompt.content).toContain(
      "because all tasks are complete"
    )
  })

  it("resumes only a paused run", async () => {
    const f = setup()
    await f.start("Plan.")
    expect(f.runs.resume("thread", { model: "m" }).status).toBe("working")
    f.runs.setTaskDone("thread", "parser", true)
    f.runs.setTaskDone("thread", "tests", true)
    await f.idleDelay()
    expect(f.current()?.status).toBe("completed")
    expect(() => f.runs.resume("thread", { model: "m" })).toThrow(
      "This Autonomous Work run has ended"
    )
  })

  it("pauses a run a previous process left working until it is resumed", async () => {
    const f = setup()
    const working: ThreadAutonomy = {
      id: "run",
      status: "working",
      tasks: [{ id: "parser", text: "Write the parser", done: false }],
      iterations: 3,
      maxIterations: 5,
      timeBudgetMin: 0,
      startedAt: 1,
      updatedAt: 2,
      stopReason: null,
    }
    f.saved.set("thread", working)
    f.runs.recover("thread", working)
    expect(f.current()).toEqual({
      ...working,
      status: "paused",
      updatedAt: f.state.clock,
      lastReason: AUTONOMY_RESTART_REASON,
    })
    f.runs.recover("other", { ...working, status: "completed" })
    expect(f.saved.has("other")).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(0)
    const resumed = f.runs.resume("thread", { model: "m" })
    expect(resumed).not.toHaveProperty("lastReason")
    expect(resumed.iterations).toBe(3)
    await f.idleDelay()
    expect(f.turns[0]!.prompt.content).toContain("Iteration 4/5.")
  })

  it("stops scheduling once disposed", async () => {
    const f = setup()
    await f.start("Plan.")
    f.runs.dispose()
    await vi.advanceTimersByTimeAsync(10 * AUTONOMY_FOLLOW_UP_DELAY_MS)
    expect(f.turns).toHaveLength(0)
    expect(() => f.runs.pause("thread")).toThrow("shutting down")
  })
})

describe("Autonomous Work rules", () => {
  const run: ThreadAutonomy = {
    id: "run",
    status: "working",
    tasks: [{ id: "a-1", text: "  ", done: false }],
    iterations: 0,
    maxIterations: 3,
    timeBudgetMin: 0,
    startedAt: 0,
    updatedAt: 0,
    stopReason: null,
  }

  it("reads only well-formed task markers", () => {
    expect([
      ...readTaskDoneMarkers("[TASK_DONE:a-1] [TASK_DONE:b_2] [TASK_DONE:]"),
    ]).toEqual(["a-1", "b_2"])
  })

  it("orders the stop checks as the renderer did", () => {
    expect(autonomyStopReason(run, "", 0)).toBeNull()
    expect(autonomyStopReason({ ...run, iterations: 3 }, "all done", 0)).toBe(
      "max-iterations"
    )
    expect(autonomyStopReason(run, "Aufgabe abgeschlossen.", 0)).toBe(
      "completion-signal"
    )
    expect(
      autonomyStopReason({ ...run, tasks: [] }, "Keep going.", 0)
    ).toBeNull()
  })

  it("names an empty task and falls back to the assigned work", () => {
    expect(autonomyFollowUpPrompt(run, 1, 0)).toContain("- [ ] a-1: (empty)")
    expect(autonomyFollowUpPrompt({ ...run, tasks: [] }, 2, 0)).toBe(
      "Continue the autonomous run for: the assigned work. Iteration 2/3.\n\nBriefly summarize progress, identify the next concrete step, then execute it immediately. Do not wait for confirmation."
    )
  })
})
