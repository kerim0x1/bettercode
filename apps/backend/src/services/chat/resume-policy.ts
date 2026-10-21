import {
  chatSendSchema,
  RESUME_AFTER_LIMIT_MESSAGE,
  RESUME_AFTER_RESTART_MESSAGE,
  THREAD_RESUME_MAX_FAILURES,
  type AutomaticMessageKind,
  type ChatSendBody,
  type ThreadResume,
} from "@betterc0de/schema"
import { normalizeLevel } from "../../provider/permissions"
import type { ProviderLimit } from "./usage-limit"

/**
 * The rules of chat resuming (resume-scheduler.ts runs them): when a chat
 * a limit stopped is resumed, what a failed attempt changes, and which
 * settings the resumed turn is sent with. Pure: the caller passes the clock
 * and the random source.
 */

/** Sent a little after the reset, so the provider has counted it. */
export const RESUME_JITTER_MIN_MS = 30_000
export const RESUME_JITTER_MAX_MS = 90_000

/** Without a reset time: 30 minutes, then 1 hour, then 2 hours. */
export const RESUME_BACKOFF_MS = [
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
] as const

/** After a start, the providers get this long to come up first. */
export const STARTUP_RESUME_DELAY_MS = 15_000

/** A continuation after a restart that could not be sent is tried again after these. */
export const RESTART_RETRY_MS = [60_000, 5 * 60_000] as const

/**
 * Restart continuations a chat gets in a row (a turn the user sent resets
 * the count), so a backend that crashes during the continuation does not
 * restart it forever.
 */
export const MAX_RESTART_CONTINUATIONS = 3

/** Node runs a longer timer at once. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Who started a turn: the user (any client), the resume scheduler (after a
 * limit or a restart), another backend scheduler (a goal, Autonomous Work)
 * or the orchestrator for a worker chat. Only the first two are resumed by
 * themselves; the others own their chats' turns.
 */
export type TurnOrigin = "user" | "resume" | "restart" | "scheduler" | "worker"

export function isResumableOrigin(origin: TurnOrigin | null | undefined) {
  return origin === "user" || origin === "resume" || origin === "restart"
}

/** The wait before the next try when no reset time is known. */
export function backoffDelay(failures: number): number {
  const index = Math.min(
    Math.max(0, Math.floor(failures)),
    RESUME_BACKOFF_MS.length - 1
  )
  return RESUME_BACKOFF_MS[index]!
}

/** When to resume: just after the reset, or after a backoff without one. */
export function resumeAtForLimit(input: {
  readonly resetAt: number | null
  readonly failures: number
  readonly now: number
  readonly random: () => number
}): number {
  if (input.resetAt !== null && input.resetAt > input.now) {
    const jitter =
      RESUME_JITTER_MIN_MS +
      Math.floor(
        Math.min(1, Math.max(0, input.random())) *
          (RESUME_JITTER_MAX_MS - RESUME_JITTER_MIN_MS)
      )
    return input.resetAt + jitter
  }
  return input.now + backoffDelay(input.failures)
}

/** How long a timer waits for `at`, within what Node can schedule. */
export function timerDelay(at: number, now: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, at - now))
}

/**
 * The record for a chat a limit just stopped. `previous` is the chat's
 * record when the turn that failed was the scheduler's own attempt: its
 * failures carry over, and the third in a row stops resuming.
 */
export function limitRecord(input: {
  readonly limit: ProviderLimit
  readonly now: number
  readonly random: () => number
  /** The setting, and whether the turn was one the scheduler may resume. */
  readonly autoResume: boolean
  readonly resumable: boolean
  readonly providerKind: string | null
  readonly previous?: ThreadResume | null
}): ThreadResume {
  const failures = input.previous ? input.previous.failures + 1 : 0
  const gaveUp = failures >= THREAD_RESUME_MAX_FAILURES
  const auto = input.autoResume && input.resumable && !gaveUp
  return {
    reason: input.limit.kind === "usage" ? "usage_limit" : "rate_limit",
    stoppedAt: input.now,
    resetAt: input.limit.resetAt,
    mode: auto ? "auto" : "off",
    resumeAt: auto
      ? resumeAtForLimit({
          resetAt: input.limit.resetAt,
          failures,
          now: input.now,
          random: input.random,
        })
      : null,
    status: "waiting",
    failures,
    resumable: input.resumable,
    providerKind: input.providerKind,
    note: gaveUp
      ? `Still limited after ${THREAD_RESUME_MAX_FAILURES} tries. Resume the chat when you are ready.`
      : null,
  }
}

/**
 * An attempt that could not start the turn (the provider is unavailable,
 * the chat is busy, …): tried again after a wait, up to the limit.
 */
export function afterFailedAttempt(input: {
  readonly record: ThreadResume
  readonly reason: string
  readonly now: number
}): ThreadResume {
  const failures = input.record.failures + 1
  if (failures >= THREAD_RESUME_MAX_FAILURES) {
    return {
      ...input.record,
      mode: "off",
      resumeAt: null,
      status: "waiting",
      failures,
      note: `Couldn't resume the chat: ${input.reason}`.slice(0, 1000),
    }
  }
  const delay =
    input.record.reason === "restart"
      ? RESTART_RETRY_MS[Math.min(failures - 1, RESTART_RETRY_MS.length - 1)]!
      : backoffDelay(failures)
  return {
    ...input.record,
    mode: "auto",
    resumeAt: input.now + delay,
    status: "waiting",
    failures,
    note: null,
  }
}

/** The user chose to resume when the limit resets (or after a backoff). */
export function scheduledRecord(input: {
  readonly record: ThreadResume
  readonly now: number
  readonly random: () => number
}): ThreadResume {
  const resumeAt =
    input.record.reason === "restart"
      ? input.now
      : resumeAtForLimit({
          resetAt: input.record.resetAt,
          failures: 0,
          now: input.now,
          random: input.random,
        })
  return {
    ...input.record,
    mode: "auto",
    resumeAt,
    status: "waiting",
    failures: 0,
    note: null,
  }
}

/** The message a resumed turn sends, and how the transcript marks it. */
export function resumeMessage(record: Pick<ThreadResume, "reason">): {
  readonly content: string
  readonly automatic: AutomaticMessageKind
} {
  return record.reason === "restart"
    ? { content: RESUME_AFTER_RESTART_MESSAGE, automatic: "restart" }
    : { content: RESUME_AFTER_LIMIT_MESSAGE, automatic: "usage-limit" }
}

const LEVEL_RANK = {
  "read-only": 0,
  "ask-on-edit": 1,
  "allow-edits": 2,
  bypass: 3,
} as const

/**
 * The stricter of the level the stopped turn ran with and the chat's level
 * now: a resumed turn never gets more than either allowed.
 */
export function stricterPermissionLevel(
  original: string | null,
  current: string | null
): string | null {
  if (!original?.trim()) return current
  if (!current?.trim()) return original
  return LEVEL_RANK[normalizeLevel(current)] <
    LEVEL_RANK[normalizeLevel(original)]
    ? current
    : original
}

/**
 * What the scheduler keeps of a turn to send its continuation with: every
 * setting of the request, none of its content.
 */
export type ResumeTemplate = Record<string, unknown>

const CONTENT_FIELDS = [
  "message",
  "history",
  "attachments",
  "user_message_id",
  "user_message_content",
  "user_message_created_at",
  "source_proposed_plan",
  "auto_compaction_usage",
  "prepared_turn_token",
] as const

export function resumeTemplate(body: ChatSendBody): ResumeTemplate {
  const template: Record<string, unknown> = { ...body }
  for (const field of CONTENT_FIELDS) delete template[field]
  return template
}

/**
 * The send body of a resumed turn: the template's settings, the canned
 * message, a fresh message id and the permission level to use. No folder:
 * the chat's own (`resolveChatWorkspaceRoot`) decides where it runs, as it
 * does for every turn. Throws when the template no longer parses (a newer
 * version changed the request).
 */
export function resumeSendBody(input: {
  readonly threadId: string
  readonly template: ResumeTemplate
  readonly content: string
  readonly messageId: string
  readonly createdAt: string
  readonly permissionLevel: string | null
}): ChatSendBody {
  return chatSendSchema.parse({
    ...input.template,
    thread_id: input.threadId,
    message: input.content,
    user_message_id: input.messageId,
    user_message_content: input.content,
    user_message_created_at: input.createdAt,
    history: [],
    attachments: [],
    source_proposed_plan: null,
    project_path: null,
    permission_level: input.permissionLevel,
  })
}
