/**
 * Reads the sentence a provider prints for when a limit resets, such as
 * `resets Sep 22, 7pm (Europe/Berlin)` or `in 2h 14m`, into an instant.
 * Shared by the Limits page (apps/ui `lib/limits.ts`), which reads Claude
 * Code's usage report, and the backend, which reads the same wording from
 * a turn that a usage limit stopped
 * (apps/backend `services/chat/usage-limit.ts`).
 */

const RESET_PREFIX = /^[\s·•–—-]*resets?\b[\s:]*/i

/** The reset sentence without its leading `resets`, for the reset chip. */
export function resetLabelText(label: string): string {
  const stripped = label.replace(RESET_PREFIX, "").trim()
  return stripped || label.trim()
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]

/** `Sep`, `Sept`, `September` → 8; anything else → -1. */
function nameIndex(names: readonly string[], value: string): number {
  const lower = value.toLowerCase()
  if (lower.length < 3) return -1
  return names.findIndex((name) => name.startsWith(lower))
}

const DURATION_UNIT =
  /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi
const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
}

/** `2h 14m`, `5 days`, `3d 4h`, `45 minutes`; null when anything is left over. */
export function parseResetDuration(text: string): number | null {
  const parts = [...text.matchAll(DURATION_UNIT)]
  const rest = text.replace(DURATION_UNIT, " ")
  if (parts.length === 0 || rest.replace(/[\s,]+|\band\b/gi, "") !== "") {
    return null
  }
  const total = parts.reduce(
    (sum, part) =>
      sum + Number(part[1]) * UNIT_MS[part[2]!.charAt(0).toLowerCase()]!,
    0
  )
  return Number.isFinite(total) ? total : null
}

interface CalendarDay {
  year: number
  /** 0-based, as in `Date`. */
  month: number
  day: number
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const known = zoneFormatters.get(zone)
  if (known) return known
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
    zoneFormatters.set(zone, formatter)
    return formatter
  } catch {
    return null
  }
}

/** Wall-clock fields of `instant` in `zone`, or in local time without one. */
function wallClock(
  instant: number,
  zone: Intl.DateTimeFormat | null
): CalendarDay & { hour: number; minute: number; second: number } {
  if (!zone) {
    const date = new Date(instant)
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    }
  }
  const parts: Record<string, number> = {}
  for (const part of zone.formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year ?? 0,
    month: (parts.month ?? 1) - 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  }
}

/** The instant a wall-clock time in `zone` (or local time) names. */
function zonedInstant(
  date: CalendarDay,
  hour: number,
  minute: number,
  zone: Intl.DateTimeFormat | null
): number {
  if (!zone) {
    return new Date(date.year, date.month, date.day, hour, minute).getTime()
  }
  const asUtc = Date.UTC(date.year, date.month, date.day, hour, minute)
  const offsetAt = (instant: number) => {
    const wall = wallClock(instant, zone)
    const wallAsUtc = Date.UTC(
      wall.year,
      wall.month,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second
    )
    return wallAsUtc - Math.floor(instant / 1000) * 1000
  }
  // Two passes settle the offset across a daylight-saving change.
  const first = asUtc - offsetAt(asUtc)
  const second = asUtc - offsetAt(first)
  return second
}

function addDays(date: CalendarDay, days: number): CalendarDay {
  const moved = new Date(Date.UTC(date.year, date.month, date.day + days))
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth(),
    day: moved.getUTCDate(),
  }
}

function isRealDay(date: CalendarDay): boolean {
  const check = new Date(Date.UTC(date.year, date.month, date.day))
  return check.getUTCMonth() === date.month && check.getUTCDate() === date.day
}

const TIME_12H =
  /(?:^|[\s,]+)(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?$/i
const TIME_24H = /(?:^|[\s,]+)(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$/i
const TIME_WORD = /(?:^|[\s,]+)(?:at\s+)?(noon|midnight)$/i

function splitTime(
  text: string
): { hour: number; minute: number; rest: string } | null {
  const twelve = TIME_12H.exec(text)
  if (twelve) {
    const hour = Number(twelve[1])
    if (hour < 1 || hour > 12) return null
    return {
      hour: (hour % 12) + (twelve[3]!.toLowerCase() === "p" ? 12 : 0),
      minute: Number(twelve[2] ?? 0),
      rest: text.slice(0, twelve.index),
    }
  }
  const day = TIME_24H.exec(text)
  if (day) {
    return {
      hour: Number(day[1]),
      minute: Number(day[2]),
      rest: text.slice(0, day.index),
    }
  }
  const word = TIME_WORD.exec(text)
  if (word) {
    return {
      hour: word[1]!.toLowerCase() === "noon" ? 12 : 0,
      minute: 0,
      rest: text.slice(0, word.index),
    }
  }
  return null
}

const MONTH_DAY =
  /^(?:[a-z]{3,9}\.?,?\s+)??([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i
const DAY_MONTH =
  /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/i

/**
 * Turns a provider's reset sentence into an instant, or null when it is
 * ambiguous. `reference` is when the sentence was printed: a relative
 * `in 2h 14m` counts from it, a bare time is its next occurrence after it,
 * and a date without a year takes the year that puts it closest to it.
 *
 * Handles `resets Sep 22, 7pm (Europe/Berlin)`, `Resets Oct 21 at 9am
 * (Europe/Berlin)`, `Resets 5pm (Europe/Berlin)`, `Resets in 2h 14m`,
 * `resets tomorrow at 9:30am`, `resets Mon 9am` and 24-hour times. A zone in
 * parentheses is honoured when the runtime knows it, otherwise local time is
 * assumed. A date without a time is left alone.
 */
export function parseResetLabel(
  label: string,
  reference: number
): number | null {
  let text = resetLabelText(label).replace(/\s+/g, " ").trim()
  if (!text || !Number.isFinite(reference)) return null

  const relative = /^in\s+(.+)$/i.exec(text)
  if (relative) {
    const ms = parseResetDuration(relative[1]!)
    return ms === null ? null : reference + ms
  }

  let zone: Intl.DateTimeFormat | null = null
  const zoneMatch = /\s*\(([^()]+)\)$/.exec(text)
  if (zoneMatch) {
    zone = zoneFormatter(zoneMatch[1]!.trim())
    text = text.slice(0, zoneMatch.index).trim()
  }
  text = text.replace(/^(?:at|on)\s+/i, "")

  const time = splitTime(text)
  if (!time) return null
  const datePart = time.rest.replace(/[\s,]+$/, "").trim()
  const today = wallClock(reference, zone)
  const nextAfterReference = (base: CalendarDay, stepDays: number) => {
    const candidate = zonedInstant(base, time.hour, time.minute, zone)
    return candidate > reference
      ? candidate
      : zonedInstant(addDays(base, stepDays), time.hour, time.minute, zone)
  }

  if (!datePart) return nextAfterReference(today, 1)
  if (/^today$/i.test(datePart)) {
    return zonedInstant(today, time.hour, time.minute, zone)
  }
  if (/^tomorrow$/i.test(datePart)) {
    return zonedInstant(addDays(today, 1), time.hour, time.minute, zone)
  }

  const weekday = /^([a-z]{3,9})\.?$/i.exec(datePart)
  if (weekday) {
    const target = nameIndex(WEEKDAYS, weekday[1]!)
    if (target < 0) return null
    const current = new Date(
      Date.UTC(today.year, today.month, today.day)
    ).getUTCDay()
    const base = addDays(today, (target - current + 7) % 7)
    return nextAfterReference(base, 7)
  }

  const monthFirst = MONTH_DAY.exec(datePart)
  const dayFirst = monthFirst ? null : DAY_MONTH.exec(datePart)
  if (!monthFirst && !dayFirst) return null
  const monthName = monthFirst ? monthFirst[1]! : dayFirst![2]!
  const dayText = monthFirst ? monthFirst[2]! : dayFirst![1]!
  const yearText = monthFirst ? monthFirst[3] : dayFirst![3]
  const month = nameIndex(MONTHS, monthName)
  const day = Number(dayText)
  if (month < 0 || day < 1 || day > 31) return null

  const years = yearText
    ? [Number(yearText)]
    : [today.year - 1, today.year, today.year + 1]
  let best: number | null = null
  for (const year of years) {
    const date = { year, month, day }
    if (!isRealDay(date)) continue
    const candidate = zonedInstant(date, time.hour, time.minute, zone)
    if (
      best === null ||
      Math.abs(candidate - reference) < Math.abs(best - reference)
    ) {
      best = candidate
    }
  }
  return best
}
