/**
 * Pure helpers for chats that resume by themselves (`@betterc0de/schema`
 * thread-resume.ts): the sidebar's "Limited" status and its label, the
 * resume card's wording, and when this window's message queue may send
 * again. The record itself lives in `@/lib/chat-resume-store`.
 */
import {
  isThreadResumeLimit,
  type ChatThread,
  type ThreadResume,
} from "@betterc0de/schema"

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/**
 * How long before the backend's resume this window releases its queued
 * messages, so the user's own follow-up goes out instead of "Continue."
 * (the backend stands down when the user sends something).
 */
export const QUEUE_RELEASE_LEAD_MS = 20_000

/** Why this window holds a chat's queued messages. */
export const QUEUE_HOLD_REASON = "Waiting for the usage limit to reset."

/**
 * Whether the sidebar shows the chat as "Limited": a usage or rate limit
 * stopped it and it is still waiting, either to resume by itself or for a
 * reset that has not come yet.
 */
export function isLimitedNow(
  resume: ThreadResume | null | undefined,
  now: number
): boolean {
  if (!resume || !isThreadResumeLimit(resume)) return false
  if (resume.status !== "waiting") return false
  return (
    resume.mode === "auto" || resume.resetAt === null || resume.resetAt > now
  )
}

/** `14:30` today, `Wed 14:30` within the week, else `Oct 23, 14:30`. */
export function formatResetTime(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
  if (date.toDateString() === new Date(now).toDateString()) return time
  if (Math.abs(at - now) < 6 * DAY_MS)
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`
}

/** "Limited · resets 14:30", or "Limited" when the reset is unknown or past. */
export function limitedLabel(
  resume: Pick<ThreadResume, "resetAt">,
  now: number,
  format: (at: number, now: number) => string = formatResetTime
): string {
  return resume.resetAt !== null && resume.resetAt > now
    ? `Limited · resets ${format(resume.resetAt, now)}`
    : "Limited"
}

/** The card's heading for a record. */
export function resumeTitle(resume: Pick<ThreadResume, "reason">): string {
  switch (resume.reason) {
    case "usage_limit":
      return "Usage limit reached"
    case "rate_limit":
      return "Rate limit reached"
    case "restart":
      return "Stopped by a restart"
  }
}

/** The card's line under the heading: what happens next. */
export function resumeStatusText(
  resume: ThreadResume,
  now: number,
  format: (at: number, now: number) => string = formatResetTime
): string {
  if (resume.note) return resume.note
  if (resume.status === "resuming") return "Resuming…"
  if (resume.mode === "auto" && resume.resumeAt !== null) {
    const when = format(resume.resumeAt, now)
    return resume.reason === "restart"
      ? `Continues at ${when}.`
      : resume.resetAt === null
        ? `The reset time is unknown. Tries again at ${when}.`
        : `Resumes at ${when}, just after the reset.`
  }
  if (resume.resetAt !== null)
    return resume.resetAt > now
      ? `Resets at ${format(resume.resetAt, now)}. Not resuming by itself.`
      : "The limit has reset."
  return "Not resuming by itself."
}

/**
 * Whether this window holds the chat's queued messages, and until when
 * (`null`: until the record changes). Only a limit holds them: sent now,
 * they would only meet the same limit. Released just before the backend's
 * resume, so a queued follow-up is what goes out.
 */
export function queueHold(
  resume: ThreadResume | null | undefined,
  now: number
): { readonly releaseAt: number | null } | null {
  if (!resume || !isThreadResumeLimit(resume)) return null
  if (resume.status === "resuming") return { releaseAt: null }
  if (resume.mode === "auto" && resume.resumeAt !== null)
    return {
      releaseAt: Math.max(now, resume.resumeAt - QUEUE_RELEASE_LEAD_MS),
    }
  if (resume.resetAt === null) return { releaseAt: null }
  return resume.resetAt > now ? { releaseAt: resume.resetAt } : null
}

type ResumeByThread = Readonly<Record<string, ThreadResume>>

/**
 * The records of a freshly loaded thread list. A chat whose record a push
 * changed while the list loaded keeps the pushed one; a chat the list shows
 * without a record has none.
 */
export function mergePersistedThreadResumes(
  current: ResumeByThread,
  persisted: ReadonlyArray<Pick<ChatThread, "id" | "resume">>,
  beforeLoad: ResumeByThread
): ResumeByThread {
  let next = current
  for (const thread of persisted) {
    if (current[thread.id] !== beforeLoad[thread.id]) continue
    const resume = thread.resume ?? undefined
    if (resume === current[thread.id]) continue
    if (next === current) next = { ...current }
    const writable = next as Record<string, ThreadResume>
    if (resume) writable[thread.id] = resume
    else delete writable[thread.id]
  }
  return next
}
