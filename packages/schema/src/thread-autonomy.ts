import { z } from "zod"
import { pick } from "./_helpers"
import { chatSendSchema } from "./chat"

/**
 * Autonomous Work: a chat works through a task list turn by turn without
 * waiting for the user. The backend schedules the turns
 * (apps/backend services/chat/autonomy.ts); a client starts, pauses, resumes
 * and stops a run and reads its state from the chat (`ChatThread.autonomy`)
 * and from the chat's `thread.metadata.updated` pushes.
 */

/** The limits the start dialog offers by default. */
export const AUTONOMY_DEFAULT_MAX_ITERATIONS = 50
export const AUTONOMY_DEFAULT_TIME_BUDGET_MIN = 90

/** What the backend accepts for one run. */
export const AUTONOMY_MAX_TASKS = 100
export const AUTONOMY_TASK_TEXT_MAX_CHARS = 4_000
export const AUTONOMY_MAX_ITERATIONS_LIMIT = 10_000
export const AUTONOMY_MAX_TIME_BUDGET_MIN = 525_600

/**
 * A task id is what the model writes back in a `[TASK_DONE:<id>]` marker,
 * so it is limited to the characters the marker accepts.
 */
export const AUTONOMY_TASK_ID_PATTERN = /^[\w-]{1,128}$/

/** Why a run stopped: shown once the run is completed. */
export const autonomyStopReasonSchema = z.enum([
  "user",
  "max-iterations",
  "time-budget",
  "completion-signal",
  "error",
])
export type AutonomyStopReason = z.infer<typeof autonomyStopReasonSchema>

/** One row of a run's task list. */
export const autonomyTaskSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(AUTONOMY_TASK_TEXT_MAX_CHARS),
  done: z.boolean(),
})
export type AutonomyTask = z.infer<typeof autonomyTaskSchema>

/**
 * A chat's run as the backend keeps it. `working`: the backend sends the
 * next turn whenever the chat goes idle; `paused`: it waits for a resume;
 * `completed`: the run ended (`stopReason`) and sent its summary turn. No
 * run is `null`. `startedAt` is when the run last started working (a
 * resume restarts the time budget); `iterations` counts the follow-up turns.
 */
export const threadAutonomySchema = z.object({
  id: z.string().min(1),
  status: z.enum(["working", "paused", "completed"]),
  tasks: z.array(autonomyTaskSchema),
  iterations: z.number().nonnegative(),
  maxIterations: z.number().nonnegative(),
  timeBudgetMin: z.number().nonnegative(),
  startedAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  stopReason: autonomyStopReasonSchema.nullable(),
  /** Why the run paused by itself (an error, a backend restart). */
  lastReason: z.string().optional(),
})
export type ThreadAutonomy = z.infer<typeof threadAutonomySchema>
export type ThreadAutonomyStatus = ThreadAutonomy["status"]

/**
 * The user message of a turn the run sends (a follow-up or the summary),
 * announced with the run's state in the same `thread.metadata.updated` push
 * (`metadata.autonomyPrompt`) so a client can show it before the reply.
 */
export const autonomyPromptSchema = z.object({
  messageId: z.string().min(1).max(512),
  content: z.string(),
  createdAt: z.string().min(1),
  modelId: z.string().optional(),
})
export type AutonomyPrompt = z.infer<typeof autonomyPromptSchema>

/** The task list and limits a run starts with. Every task starts open. */
export const autonomyRunConfigSchema = z
  .object({
    tasks: z
      .array(
        z.object({
          id: z
            .string()
            .regex(
              AUTONOMY_TASK_ID_PATTERN,
              "A task id may contain letters, digits, '_' and '-' only"
            ),
          text: z.string().trim().min(1).max(AUTONOMY_TASK_TEXT_MAX_CHARS),
        })
      )
      .min(1, "Autonomous Work needs at least one task")
      .max(AUTONOMY_MAX_TASKS)
      .refine(
        (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
        "Task ids must be unique"
      ),
    maxIterations: z.number().int().min(1).max(AUTONOMY_MAX_ITERATIONS_LIMIT),
    timeBudgetMin: z.number().int().min(0).max(AUTONOMY_MAX_TIME_BUDGET_MIN),
  })
  .strict()
export type AutonomyRunConfig = z.infer<typeof autonomyRunConfigSchema>

/**
 * POST /chat/autonomy/start: the run's opening message, as a chat send body
 * (provider, model, permission level, …: the turns that follow use the same),
 * and `autonomy`, its task list and limits.
 */
export const chatAutonomyStartSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    ...chatSendSchema.parse(raw),
    autonomy: autonomyRunConfigSchema.parse(raw.autonomy),
  }))
export type ChatAutonomyStartBody = z.infer<typeof chatAutonomyStartSchema>

/**
 * POST /chat/autonomy/resume: a chat send body naming the provider, model
 * and permission level the run continues with. Its message is not sent.
 */
export const chatAutonomyResumeSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) =>
    chatSendSchema.parse({ message: "Resume Autonomous Work", ...raw })
  )

const autonomyThreadIdSchema = z
  .string()
  .trim()
  .min(1, "threadId is required")
  .max(512)

/** POST /chat/autonomy/pause and /chat/autonomy/stop. */
export const chatAutonomyThreadSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    threadId: autonomyThreadIdSchema.parse(
      pick<unknown>(raw, "threadId", "thread_id")
    ),
  }))

/** POST /chat/autonomy/task: ticks a task off by hand, or reopens it. */
export const chatAutonomyTaskSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    threadId: autonomyThreadIdSchema.parse(
      pick<unknown>(raw, "threadId", "thread_id")
    ),
    taskId: z
      .string()
      .min(1, "taskId is required")
      .max(128)
      .parse(pick<unknown>(raw, "taskId", "task_id")),
    done: z.boolean().parse(raw.done),
  }))

/** The run after a pause, resume, stop or task change; `null`: no run. */
export const chatAutonomyResponseSchema = z.object({
  autonomy: threadAutonomySchema.nullable(),
})
