import { randomUUID } from "node:crypto"
import type {
  AutonomyPrompt,
  AutonomyRunConfig,
  AutonomyStopReason,
  AutonomyTask,
  ThreadAutonomy,
} from "@betterc0de/schema"
import { HttpError } from "../../errors"

/**
 * The "Autonomous Work" scheduler: whenever a chat with a working run goes
 * idle, it sends the next turn on its own, until the task list is done or a
 * limit is reached, then sends one summary turn. It schedules ordinary
 * admitted chat turns through its ports (`autonomy-runtime.ts` wires them
 * to the chat dispatch path) and never writes conversations or calls an
 * adapter itself.
 *
 * The rules are the ones the renderer's loop followed before the backend
 * took it over:
 *  - after a turn ends, wait {@link AUTONOMY_FOLLOW_UP_DELAY_MS} of idleness
 *    (a message the user queued goes first), then read the chat's last
 *    reply: `[TASK_DONE:<id>]` markers tick tasks off;
 *  - stop when every task is done or the reply says all work is complete
 *    (`completion-signal`), the time budget is spent (`time-budget`) or the
 *    follow-up cap is reached (`max-iterations`); a stop sends one summary
 *    turn and completes the run;
 *  - otherwise send the next follow-up, refreshing the plan every fourth
 *    iteration or when the reply stops changing;
 *  - a turn that fails after it started does not stop the run (the cap
 *    bounds it); a turn the backend refuses pauses it (`error`). Pausing or
 *    stopping never interrupts a turn already running.
 */

/** Idle time after a turn before the run sends its next one. */
export const AUTONOMY_FOLLOW_UP_DELAY_MS = 1_200

export const AUTONOMY_RESTART_REASON =
  "Backend restarted. Resume to continue with current permissions."

/** Phrases that end a run as complete when the last reply contains one. */
export const AUTONOMY_COMPLETION_KEYWORDS = [
  "all tasks complete",
  "all tasks are complete",
  "everything is done",
  "all steps completed",
  "implementation is complete",
  "task is complete",
  "task completed",
  "all done",
  "finished all",
  "completed all",
  "alles erledigt",
  "aufgabe abgeschlossen",
] as const

/** `[TASK_DONE:<id>]` markers in a reply. */
const TASK_DONE_RE = /\[TASK_DONE:([\w-]+)\]/g

export interface AutonomyPorts<Context> {
  /** The run as last journaled; `null`/`undefined`: none. */
  read(threadId: string): ThreadAutonomy | null | undefined
  /**
   * Journals the run's state (`null`: no run) and, with `prompt`, the user
   * message of the turn that just started. Must throw unless the update was
   * durably projected.
   */
  publish(
    threadId: string,
    autonomy: ThreadAutonomy | null,
    prompt?: AutonomyPrompt
  ): void
  /** No turn runs or is being admitted in the chat. */
  isIdle(threadId: string): boolean
  waitForIdle(threadId: string): Promise<void>
  /** The chat's last message when the assistant wrote it, otherwise "". */
  lastReply(threadId: string): string
  /**
   * Admits `prompt` as an ordinary chat turn. `guard` throws once the run
   * no longer wants the turn; `started` runs synchronously once the
   * provider turn exists.
   */
  dispatch(
    threadId: string,
    prompt: AutonomyPrompt,
    context: Context,
    guard: () => void,
    started: () => void
  ): Promise<void>
  /** The model the run's turns use, shown with their messages. */
  modelId?(context: Context): string | undefined
  onError(error: unknown): void
  onDispose?(): void
  now?(): number
}

interface Entry<Context> {
  autonomy: ThreadAutonomy | null
  context?: Context
  /** Bumped by every command; a cycle or timer of an older one stands down. */
  generation: number
  /** A cycle is reading the chat or admitting a turn. */
  running: boolean
  /** `start` is admitting the run's opening message. */
  opening: boolean
  timer?: ReturnType<typeof setTimeout>
  /** Whether the replies still change (not journaled, like the old loop's). */
  progress: { signature: string; stagnantCycles: number }
}

/** A command the run's state refuses: a 409 with a public message. */
export class AutonomyCommandError extends HttpError {
  constructor(message: string) {
    super(409, message, "autonomy_conflict")
    this.name = "AutonomyCommandError"
  }
}

function formatTaskList(tasks: ReadonlyArray<AutonomyTask>): string {
  return tasks
    .map(
      (task) =>
        `- [${task.done ? "x" : " "}] ${task.id}: ${task.text.trim() || "(empty)"}`
    )
    .join("\n")
}

function stopReasonLabel(reason: AutonomyStopReason): string {
  switch (reason) {
    case "completion-signal":
      return "all tasks are complete"
    case "time-budget":
      return "the wall-clock time budget was reached"
    case "max-iterations":
      return "the iteration cap was reached"
    case "user":
      return "the user stopped the run"
    case "error":
      return "an error occurred"
  }
}

/** The task ids a reply marks done. */
export function readTaskDoneMarkers(reply: string): Set<string> {
  return new Set(
    Array.from(reply.matchAll(TASK_DONE_RE), (match) => match[1]).filter(
      (id): id is string => Boolean(id)
    )
  )
}

/** Why the run stops after `reply`, or `null` to continue. */
export function autonomyStopReason(
  run: ThreadAutonomy,
  reply: string,
  now: number
): AutonomyStopReason | null {
  if (run.tasks.length > 0 && run.tasks.every((task) => task.done))
    return "completion-signal"
  if (
    run.timeBudgetMin > 0 &&
    (now - run.startedAt) / 60_000 >= run.timeBudgetMin
  )
    return "time-budget"
  if (run.iterations >= run.maxIterations) return "max-iterations"
  if (reply) {
    const lower = reply.toLowerCase()
    if (AUTONOMY_COMPLETION_KEYWORDS.some((keyword) => lower.includes(keyword)))
      return "completion-signal"
  }
  return null
}

/** The follow-up prompt of iteration `iteration` (1-based). */
export function autonomyFollowUpPrompt(
  run: ThreadAutonomy,
  iteration: number,
  stagnantCycles: number
): string {
  const task = run.tasks[0]?.text || "the assigned work"
  const shouldRefreshPlan = iteration % 4 === 0 || stagnantCycles >= 2
  const taskBlock =
    run.tasks.length > 0
      ? `\n\nActive tasks:\n${formatTaskList(run.tasks)}\n\nFocus on the next unchecked task. When you finish one, emit a marker \`[TASK_DONE:<id>]\` on its own line so the harness can tick it off.`
      : ""
  const baseContext = `Iteration ${iteration}/${run.maxIterations}.${taskBlock}`
  return shouldRefreshPlan
    ? `Continue the autonomous run for: ${task}. ${baseContext}\n\nFirst refresh a concise plan (3–7 checklist items) based on the current repo state, then immediately execute the highest-priority unfinished step. If blocked by missing details, choose the safest assumption and continue.`
    : `Continue the autonomous run for: ${task}. ${baseContext}\n\nBriefly summarize progress, identify the next concrete step, then execute it immediately. Do not wait for confirmation.`
}

/** The prompt of the turn that ends a run. */
export function autonomySummaryPrompt(
  run: ThreadAutonomy,
  reason: AutonomyStopReason
): string {
  const doneCount = run.tasks.filter((task) => task.done).length
  const listBlock =
    run.tasks.length > 0
      ? `\n\nTask list snapshot (${doneCount}/${run.tasks.length} done):\n${formatTaskList(run.tasks)}`
      : ""
  return `The autonomous run is stopping because ${stopReasonLabel(reason)}.${listBlock}\n\nWrite a final summary in 5–8 bullet points:\n- What was completed (reference each task id where relevant)\n- What's still open or partially done\n- One recommended next step if the user picks this up again\n\nDo not run further tools or start new work — this is the final message of the run.`
}

function isThreadBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "turn_active"
  )
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 2_000) || "Autonomous Work failed."
}

export class ThreadAutonomyRuns<Context> {
  private readonly entries = new Map<string, Entry<Context>>()
  private closed = false

  constructor(private readonly ports: AutonomyPorts<Context>) {}

  get(threadId: string): ThreadAutonomy | null {
    const entry = this.entries.get(threadId)
    return entry ? entry.autonomy : (this.ports.read(threadId) ?? null)
  }

  /** A run a previous process left working waits for an explicit resume. */
  recover(threadId: string, autonomy: ThreadAutonomy): void {
    if (autonomy.status !== "working") return
    this.ports.publish(threadId, {
      ...autonomy,
      status: "paused",
      updatedAt: this.now(),
      lastReason: AUTONOMY_RESTART_REASON,
    })
  }

  /**
   * Starts a run, replacing any run the chat had, and sends its opening
   * message through `openingTurn`. When that turn is refused there is no
   * run, and the error is the caller's.
   */
  async start<T>(
    threadId: string,
    config: AutonomyRunConfig,
    context: Context,
    openingTurn: (guard: () => void) => Promise<T>
  ): Promise<{ autonomy: ThreadAutonomy | null; result: T }> {
    this.assertOpen()
    const entry = this.entry(threadId)
    const now = this.now()
    const run: ThreadAutonomy = {
      id: randomUUID(),
      status: "working",
      tasks: config.tasks.map((task) => ({
        id: task.id,
        text: task.text,
        done: false,
      })),
      iterations: 0,
      maxIterations: config.maxIterations,
      timeBudgetMin: config.timeBudgetMin,
      startedAt: now,
      updatedAt: now,
      stopReason: null,
    }
    // Journal and projection acknowledge the run before any turn starts.
    this.commit(threadId, entry, run)
    this.invalidate(entry)
    entry.context = context
    entry.progress = { signature: "", stagnantCycles: 0 }
    const generation = entry.generation
    // No follow-up may overtake the opening message while it is admitted.
    entry.opening = true
    try {
      const result = await openingTurn(() =>
        this.assertCurrent(entry, generation)
      )
      entry.opening = false
      this.schedule(threadId, entry)
      return { autonomy: entry.autonomy, result }
    } catch (error) {
      entry.opening = false
      if (
        !this.closed &&
        entry.generation === generation &&
        entry.autonomy?.id === run.id
      ) {
        this.invalidate(entry)
        entry.context = undefined
        try {
          this.commit(threadId, entry, null)
        } catch (publishError) {
          this.ports.onError(publishError)
        }
      }
      throw error
    }
  }

  /** Stops sending turns; a turn already running finishes. */
  pause(threadId: string): ThreadAutonomy {
    this.assertOpen()
    const entry = this.entry(threadId)
    const run = this.requireRun(entry)
    if (run.status !== "working") return run
    const next: ThreadAutonomy = {
      ...run,
      status: "paused",
      updatedAt: this.now(),
    }
    this.commit(threadId, entry, next)
    this.invalidate(entry)
    return next
  }

  /**
   * Continues a paused run with `context` (the caller's provider, model and
   * permissions). The time budget starts over, as it did in the renderer.
   */
  resume(threadId: string, context: Context): ThreadAutonomy {
    this.assertOpen()
    const entry = this.entry(threadId)
    const run = this.requireRun(entry)
    if (run.status === "working") return run
    if (run.status !== "paused")
      throw new AutonomyCommandError(
        "This Autonomous Work run has ended. Start a new run instead."
      )
    const now = this.now()
    const { lastReason: _lastReason, ...rest } = run
    const next: ThreadAutonomy = {
      ...rest,
      status: "working",
      startedAt: now,
      updatedAt: now,
      stopReason: null,
    }
    this.commit(threadId, entry, next)
    this.invalidate(entry)
    entry.context = context
    this.schedule(threadId, entry)
    return next
  }

  /** Ends the run without a summary; a turn already running finishes. */
  stop(threadId: string): null {
    this.assertOpen()
    const entry = this.entry(threadId)
    if (entry.autonomy) this.commit(threadId, entry, null)
    this.invalidate(entry)
    entry.context = undefined
    this.entries.delete(threadId)
    return null
  }

  /** Ticks a task off by hand, or reopens it. */
  setTaskDone(threadId: string, taskId: string, done: boolean): ThreadAutonomy {
    this.assertOpen()
    const entry = this.entry(threadId)
    const run = this.requireRun(entry)
    if (!run.tasks.some((task) => task.id === taskId))
      throw new AutonomyCommandError("This run has no such task.")
    const next: ThreadAutonomy = {
      ...run,
      tasks: run.tasks.map((task) =>
        task.id === taskId ? { ...task, done } : task
      ),
      updatedAt: this.now(),
    }
    this.commit(threadId, entry, next)
    return next
  }

  /**
   * Thread teardown: drop this scheduler's timer and context and invalidate
   * any turn still waiting for admission. The journaled state goes with the
   * chat.
   */
  forgetThread(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (!entry) return
    this.invalidate(entry)
    entry.context = undefined
    entry.autonomy = null
    this.entries.delete(threadId)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) {
      entry.generation++
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = undefined
    }
    this.entries.clear()
    // The backend shutdown owns interruption and drains its admitted turns.
    this.ports.onDispose?.()
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }

  private assertOpen(): void {
    if (this.closed)
      throw new AutonomyCommandError("Autonomous Work is shutting down.")
  }

  private assertCurrent(entry: Entry<Context>, generation: number): void {
    if (
      this.closed ||
      entry.generation !== generation ||
      entry.autonomy?.status !== "working"
    )
      throw new AutonomyCommandError(
        "Autonomous Work was paused or changed before the turn was admitted."
      )
  }

  private entry(threadId: string): Entry<Context> {
    let entry = this.entries.get(threadId)
    if (!entry) {
      entry = {
        autonomy: this.ports.read(threadId) ?? null,
        generation: 0,
        running: false,
        opening: false,
        progress: { signature: "", stagnantCycles: 0 },
      }
      this.entries.set(threadId, entry)
    }
    return entry
  }

  private requireRun(entry: Entry<Context>): ThreadAutonomy {
    if (!entry.autonomy)
      throw new AutonomyCommandError(
        "There is no Autonomous Work run in this chat."
      )
    return entry.autonomy
  }

  /** Journal first; only an acknowledged state becomes the scheduler's. */
  private commit(
    threadId: string,
    entry: Entry<Context>,
    next: ThreadAutonomy | null,
    prompt?: AutonomyPrompt
  ): void {
    this.ports.publish(threadId, next, prompt)
    entry.autonomy = next
  }

  private invalidate(entry: Entry<Context>): void {
    entry.generation++
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
  }

  private wantsTurns(entry: Entry<Context>): boolean {
    return (
      !this.closed &&
      !entry.opening &&
      entry.autonomy?.status === "working" &&
      entry.context !== undefined
    )
  }

  private schedule(threadId: string, entry: Entry<Context>): void {
    if (!this.wantsTurns(entry) || entry.running || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.tick(threadId, entry).catch((error: unknown) =>
        this.ports.onError(error)
      )
    }, AUTONOMY_FOLLOW_UP_DELAY_MS)
    entry.timer.unref?.()
  }

  private async tick(threadId: string, entry: Entry<Context>): Promise<void> {
    if (!this.wantsTurns(entry) || entry.running) return
    if (!this.ports.isIdle(threadId)) {
      // Another turn runs (the user's, or one their queue sent): wait for
      // it, then give the queue the same head start again.
      await this.ports.waitForIdle(threadId).catch(() => undefined)
      this.schedule(threadId, entry)
      return
    }
    await this.cycle(threadId, entry)
  }

  private prompt(entry: Entry<Context>, content: string): AutonomyPrompt {
    const modelId =
      entry.context !== undefined
        ? this.ports.modelId?.(entry.context)
        : undefined
    return {
      messageId: randomUUID(),
      content,
      createdAt: new Date(this.now()).toISOString(),
      ...(modelId ? { modelId } : {}),
    }
  }

  private async cycle(threadId: string, entry: Entry<Context>): Promise<void> {
    if (!this.wantsTurns(entry) || entry.running) return
    entry.running = true
    const generation = entry.generation
    const guard = () => this.assertCurrent(entry, generation)
    try {
      let run = entry.autonomy!
      const reply = this.ports.lastReply(threadId)
      const done = reply ? readTaskDoneMarkers(reply) : new Set<string>()
      if (run.tasks.some((task) => !task.done && done.has(task.id))) {
        run = {
          ...run,
          tasks: run.tasks.map((task) =>
            done.has(task.id) ? { ...task, done: true } : task
          ),
          updatedAt: this.now(),
        }
        this.commit(threadId, entry, run)
      }
      const reason = autonomyStopReason(run, reply, this.now())
      if (reason) {
        await this.finish(threadId, entry, generation, run, reason, guard)
        return
      }
      if (reply) {
        const signature = `${reply.slice(0, 200)}::${reply.slice(-200)}::${reply.length}`
        if (entry.progress.signature === signature)
          entry.progress.stagnantCycles += 1
        else entry.progress = { signature, stagnantCycles: 0 }
      }
      const iteration = run.iterations + 1
      const prompt = this.prompt(
        entry,
        autonomyFollowUpPrompt(run, iteration, entry.progress.stagnantCycles)
      )
      const counted = run
      await this.ports.dispatch(threadId, prompt, entry.context!, guard, () =>
        this.announce(
          threadId,
          entry,
          generation,
          { ...counted, iterations: iteration, updatedAt: this.now() },
          prompt
        )
      )
    } catch (error) {
      // The chat got busy between the idle check and the admission: the
      // next tick waits for that turn instead.
      if (!isThreadBusy(error)) this.fail(threadId, entry, generation, error)
    } finally {
      entry.running = false
      this.schedule(threadId, entry)
    }
  }

  /** The summary turn; the run completes once it has started. */
  private async finish(
    threadId: string,
    entry: Entry<Context>,
    generation: number,
    run: ThreadAutonomy,
    reason: AutonomyStopReason,
    guard: () => void
  ): Promise<void> {
    const prompt = this.prompt(entry, autonomySummaryPrompt(run, reason))
    await this.ports.dispatch(threadId, prompt, entry.context!, guard, () =>
      this.announce(
        threadId,
        entry,
        generation,
        {
          ...run,
          status: "completed",
          stopReason: reason,
          updatedAt: this.now(),
        },
        prompt
      )
    )
    if (entry.generation === generation) entry.context = undefined
  }

  /**
   * Runs inside the dispatch, once the turn exists: it must not throw. The
   * turn's message is announced even when a command changed the run in the
   * meantime (with the run as that command left it). A journal that refuses
   * the update stops the run instead of starting another turn.
   */
  private announce(
    threadId: string,
    entry: Entry<Context>,
    generation: number,
    next: ThreadAutonomy,
    prompt: AutonomyPrompt
  ): void {
    const current = entry.generation === generation
    // A stopped run's entry is gone; a later run must not hear of this turn.
    if (!current && this.entries.get(threadId) !== entry) return
    try {
      this.commit(threadId, entry, current ? next : entry.autonomy, prompt)
    } catch (error) {
      entry.generation++
      entry.context = undefined
      this.ports.onError(error)
    }
  }

  private fail(
    threadId: string,
    entry: Entry<Context>,
    generation: number,
    error: unknown
  ): void {
    if (
      this.closed ||
      entry.generation !== generation ||
      entry.autonomy?.status !== "working"
    )
      return
    const next: ThreadAutonomy = {
      ...entry.autonomy,
      status: "paused",
      stopReason: "error",
      updatedAt: this.now(),
      lastReason: errorMessage(error),
    }
    try {
      this.commit(threadId, entry, next)
    } catch (publishError) {
      // A failed journal is retried by ingestion, never by another turn.
      entry.generation++
      entry.context = undefined
      this.ports.onError(publishError)
    }
  }
}
