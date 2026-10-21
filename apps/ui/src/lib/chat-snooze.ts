import { SNOOZED_CHAT_LIMIT, type SnoozedChat } from "@betterc0de/schema"

/**
 * Snoozed chats (`settings.snoozed_threads`): a snoozed chat leaves the
 * sidebar's chat lists until its time, then comes back at the top with a
 * "Back" mark until it is opened. A new message, a question or approval
 * waiting for you, or the end of a turn that was running when it was
 * snoozed brings it back early. Pure helpers; the list and the actions in
 * `chat-list-actions.ts` do the reading and writing.
 */

export type { SnoozedChat }

export type SnoozePreset = "1h" | "3h" | "tomorrow" | "next-week"

export const SNOOZE_PRESETS: ReadonlyArray<{
  id: SnoozePreset
  label: string
}> = [
  { id: "1h", label: "1 hour" },
  { id: "3h", label: "3 hours" },
  { id: "tomorrow", label: "Tomorrow 9:00" },
  { id: "next-week", label: "Next week (Monday 9:00)" },
]

/** Hour of the morning the day presets wake a chat at. */
const MORNING_HOUR = 9
/** A thread updated this much after it was snoozed counts as changed. */
const CHANGE_TOLERANCE_MS = 1_000
const DAY_MS = 24 * 60 * 60 * 1000

function atMorning(day: Date, addDays: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + addDays,
    MORNING_HOUR,
    0,
    0,
    0
  )
}

/** When a preset wakes a chat snoozed at `now`, in local time. */
export function snoozePresetTime(preset: SnoozePreset, now: Date): Date {
  switch (preset) {
    case "1h":
      return new Date(now.getTime() + 60 * 60 * 1000)
    case "3h":
      return new Date(now.getTime() + 3 * 60 * 60 * 1000)
    case "tomorrow":
      return atMorning(now, 1)
    case "next-week": {
      // The coming Monday; on a Monday, the one a week later.
      const day = now.getDay()
      const days = (8 - day) % 7 || 7
      return atMorning(now, days)
    }
  }
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** "Today 15:30", "Tomorrow 09:00", "Mon 09:00" or "27 Oct, 09:00". */
export function formatSnoozeTime(
  until: Date,
  now: Date,
  locale?: string
): string {
  const time = until.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  if (sameDay(until, now)) return `Today ${time}`
  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  )
  if (sameDay(until, tomorrow)) return `Tomorrow ${time}`
  const ahead = until.getTime() - now.getTime()
  if (ahead > 0 && ahead < 6 * DAY_MS) {
    return `${until.toLocaleDateString(locale, { weekday: "short" })} ${time}`
  }
  return `${until.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
  })}, ${time}`
}

/**
 * The custom snooze dialog's `<input type="date">` and `type="time"`
 * values as a local time, or null when either is empty or invalid.
 */
export function parseSnoozeInput(date: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time.trim())
  if (!dateMatch || !timeMatch) return null
  const [year, month, day] = dateMatch.slice(1).map(Number) as [
    number,
    number,
    number,
  ]
  const [hours, minutes] = timeMatch.slice(1).map(Number) as [number, number]
  if (hours > 23 || minutes > 59) return null
  const value = new Date(year, month - 1, day, hours, minutes, 0, 0)
  // Rejects dates such as 2026-02-31, which Date would roll over.
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null
  }
  return value
}

/** `YYYY-MM-DD` and `HH:MM` for the dialog's inputs, in local time. */
export function snoozeInputValues(value: Date): { date: string; time: string } {
  const pad = (part: number) => String(part).padStart(2, "0")
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  }
}

export type SnoozeStatus = "snoozed" | "back"

/**
 * Whether a snoozed chat is still away. It is back once its time passed,
 * while it waits for you, after it changed since it was snoozed, or when a
 * turn that was running at the time has ended.
 */
export function snoozeStatus(
  entry: SnoozedChat,
  chat: { updatedAt: string; running: boolean; waiting: boolean },
  now: number
): SnoozeStatus {
  if (chat.waiting) return "back"
  const until = Date.parse(entry.until)
  if (!Number.isFinite(until) || now >= until) return "back"
  const since = Date.parse(entry.since)
  const updated = Date.parse(chat.updatedAt)
  if (
    Number.isFinite(since) &&
    Number.isFinite(updated) &&
    updated - since > CHANGE_TOLERANCE_MS
  ) {
    return "back"
  }
  if (entry.running === true && !chat.running) return "back"
  return "snoozed"
}

/**
 * Snoozes chats until `until`, replacing an earlier snooze of the same
 * chat. `runningIds` are the chats with a turn in progress, so the end of
 * that turn can bring them back. The oldest entries give way at the limit.
 */
export function snoozeChats(
  entries: SnoozedChat[],
  threadIds: readonly string[],
  until: Date,
  now: Date,
  runningIds: ReadonlySet<string> = new Set()
): SnoozedChat[] {
  const ids = [...new Set(threadIds)]
  if (ids.length === 0) return entries
  const replacing = new Set(ids)
  const added: SnoozedChat[] = ids.map((id) => ({
    thread_id: id,
    until: until.toISOString(),
    since: now.toISOString(),
    ...(runningIds.has(id) ? { running: true } : {}),
  }))
  const next = [
    ...entries.filter((entry) => !replacing.has(entry.thread_id)),
    ...added,
  ]
  return next.slice(Math.max(0, next.length - SNOOZED_CHAT_LIMIT))
}

export function unsnoozeChats(
  entries: SnoozedChat[],
  threadIds: readonly string[]
): SnoozedChat[] {
  const removing = new Set(threadIds)
  const next = entries.filter((entry) => !removing.has(entry.thread_id))
  return next.length === entries.length ? entries : next
}

/**
 * Undo of a snooze edit: the chats get back the entries `previous` had for
 * them (or none). Other chats keep their current entries.
 */
export function restoreSnoozes(
  entries: SnoozedChat[],
  threadIds: readonly string[],
  previous: readonly SnoozedChat[]
): SnoozedChat[] {
  const restoring = new Set(threadIds)
  const kept = entries.filter((entry) => !restoring.has(entry.thread_id))
  const back = previous.filter((entry) => restoring.has(entry.thread_id))
  if (kept.length === entries.length && back.length === 0) return entries
  return [...kept, ...back].slice(
    Math.max(0, kept.length + back.length - SNOOZED_CHAT_LIMIT)
  )
}

/** The next future wake time, for a timer that re-renders the list. */
export function nextSnoozeWake(
  entries: readonly SnoozedChat[],
  now: number
): number | null {
  let next: number | null = null
  for (const entry of entries) {
    const until = Date.parse(entry.until)
    if (!Number.isFinite(until) || until <= now) continue
    if (next === null || until < next) next = until
  }
  return next
}

export function snoozeEntryFor(
  entries: readonly SnoozedChat[],
  threadId: string
): SnoozedChat | undefined {
  return entries.find((entry) => entry.thread_id === threadId)
}
