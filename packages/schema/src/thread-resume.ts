import { z } from "zod"

/**
 * A chat that stopped before its work was done and can continue by itself.
 *
 * - `usage_limit` / `rate_limit`: the provider's usage or rate limit ended
 *   the turn. With "Resume chats stopped by a usage limit" on (Settings →
 *   Chat), the backend sends "Continue." once the limit resets.
 * - `restart`: the app or backend quit while the turn ran. With "Continue
 *   running chats after a restart" on, the backend continues the chat once
 *   at the next start. A chat that was waiting for an approval is not
 *   continued; its record waits for the user instead.
 *
 * The backend keeps the record with the chat (`ChatThread.resume`), pushes
 * each change on the `thread.metadata` channel (`resume`) and acts on the
 * user's choice (`POST /chat/resume`). The schedule itself lives in
 * apps/backend services/chat/resume-runtime.ts.
 */

/** Automatic attempts in a row after which the backend stops trying. */
export const THREAD_RESUME_MAX_FAILURES = 3

/** What the backend sends once a limit has reset. */
export const RESUME_AFTER_LIMIT_MESSAGE = "Continue."

/** What the backend sends to a chat that a restart interrupted. */
export const RESUME_AFTER_RESTART_MESSAGE =
  "The app restarted while you were working. Continue where you left off."

export const threadResumeReasonSchema = z.enum([
  "usage_limit",
  "rate_limit",
  "restart",
])
export type ThreadResumeReason = z.infer<typeof threadResumeReasonSchema>

/**
 * `mode` is the user's choice (or the setting's default): `auto` resumes at
 * `resumeAt`, `off` waits for the user. `status` is `resuming` while the
 * turn the backend sent runs; the record goes away once the chat continues.
 */
export const threadResumeSchema = z.object({
  reason: threadResumeReasonSchema,
  /** When the chat stopped (ms since the epoch). */
  stoppedAt: z.number().nonnegative(),
  /** When the provider said its limit resets; `null` when it did not say. */
  resetAt: z.number().nonnegative().nullable(),
  mode: z.enum(["auto", "off"]),
  /** When the backend sends its message; `null` unless `mode` is `auto`. */
  resumeAt: z.number().nonnegative().nullable(),
  status: z.enum(["waiting", "resuming"]),
  /** Automatic attempts in a row that did not get the chat going again. */
  failures: z.number().int().nonnegative(),
  /** Whether the backend has the chat's turn settings to resume it with. */
  resumable: z.boolean(),
  /** The provider whose limit stopped the chat. */
  providerKind: z.string().max(128).nullable().optional(),
  /** Why the backend stopped resuming by itself, in the user's words. */
  note: z.string().max(1000).nullable().optional(),
})
export type ThreadResume = z.infer<typeof threadResumeSchema>

/** A usage or rate limit stopped the chat (the sidebar's "Limited"). */
export function isThreadResumeLimit(
  resume: Pick<ThreadResume, "reason"> | null | undefined
): boolean {
  return resume?.reason === "usage_limit" || resume?.reason === "rate_limit"
}

/**
 * Marks a user message the backend sent by itself (`ChatMessage.automatic`),
 * so a transcript shows it as a note rather than as something the user
 * typed.
 */
export const automaticMessageKindSchema = z.enum(["usage-limit", "restart"])
export type AutomaticMessageKind = z.infer<typeof automaticMessageKindSchema>

/**
 * The message of a turn the backend just started, pushed with the record
 * (`resumePrompt`) so an open chat shows it before the reply streams in.
 */
export const threadResumePromptSchema = z.object({
  messageId: z.string().min(1).max(512),
  content: z.string(),
  createdAt: z.string().min(1),
  automatic: automaticMessageKindSchema,
  modelId: z.string().optional(),
})
export type ThreadResumePrompt = z.infer<typeof threadResumePromptSchema>

/**
 * POST /chat/resume. `schedule`: resume when the limit resets (after a
 * backoff when no reset time is known); `now`: resume at once; `cancel`:
 * keep the record but do not resume; `dismiss`: forget it.
 */
export const chatResumeControlSchema = z
  .object({
    threadId: z.string().trim().min(1, "threadId is required").max(512),
    action: z.enum(["schedule", "now", "cancel", "dismiss"]),
  })
  .strict()
export type ChatResumeControlBody = z.infer<typeof chatResumeControlSchema>
export type ChatResumeAction = ChatResumeControlBody["action"]

/** The chat's record after the change; `null` when it has none. */
export const chatResumeResponseSchema = z.object({
  resume: threadResumeSchema.nullable(),
})
export type ChatResumeResponse = z.infer<typeof chatResumeResponseSchema>
