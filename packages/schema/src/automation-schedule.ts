/**
 * When a scheduled automation runs: the four schedule kinds, a small
 * five-field cron parser and the "next run after" calculation. Pure and
 * shared, so the desktop's Automations page previews exactly the times the
 * backend scheduler (apps/backend services/automations) will use.
 *
 * Every time is the desktop's local time: the backend runs on the same
 * machine as the app, and "daily at 09:00" means 09:00 on its clock.
 */

/** No schedule may run an automation more often than this. */
export const AUTOMATION_MIN_INTERVAL_MINUTES = 5
/** The longest "every N" interval: 31 days. */
export const AUTOMATION_MAX_INTERVAL_MINUTES = 31 * 24 * 60
export const AUTOMATION_CRON_MAX_CHARS = 200

export type AutomationIntervalUnit = "minutes" | "hours"

export type AutomationSchedule =
  | { readonly kind: "once"; readonly at: string }
  | {
      readonly kind: "interval"
      readonly every: number
      readonly unit: AutomationIntervalUnit
    }
  | {
      readonly kind: "daily"
      /** `HH:MM`, 24-hour. */
      readonly time: string
      /** 0 = Sunday … 6 = Saturday. */
      readonly weekdays: readonly number[]
    }
  | { readonly kind: "cron"; readonly expression: string }

/** A parsed cron expression: the values each field allows. */
export interface CronExpression {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** 0 = Sunday … 6 = Saturday (7 is read as Sunday). */
  readonly daysOfWeek: ReadonlySet<number>
  /**
   * Whether the day-of-month and day-of-week fields restrict anything. When
   * both do, a day matches either one, as in every common cron.
   */
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

export type CronParseResult =
  | { readonly ok: true; readonly cron: CronExpression }
  | { readonly ok: false; readonly error: string }

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
]
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

const CRON_MACROS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

interface CronField {
  readonly label: string
  readonly min: number
  readonly max: number
  /** Names for values, `names[i]` standing for `min + i`. */
  readonly names?: readonly string[]
}

const FIELDS: readonly CronField[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  // 7 is accepted as Sunday and folded to 0 below.
  { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES },
]

function parseFieldValue(raw: string, field: CronField): number | null {
  if (/^\d{1,2}$/.test(raw)) {
    const value = Number(raw)
    return value >= field.min && value <= field.max ? value : null
  }
  const index = field.names?.indexOf(raw.toUpperCase()) ?? -1
  return index >= 0 ? field.min + index : null
}

/** One field's allowed values, or the reason it is not valid. */
function parseField(
  text: string,
  field: CronField
): { values: Set<number> } | { error: string } {
  const values = new Set<number>()
  for (const part of text.split(",")) {
    const match = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(part)
    if (!match)
      return { error: `The ${field.label} field "${text}" is not valid.` }
    const [, range, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1 || step > field.max) {
      return {
        error: `The step in the ${field.label} field must be 1 to ${field.max}.`,
      }
    }
    let start: number
    let end: number
    if (range === "*") {
      start = field.min
      end = field.max
    } else {
      const bounds = range!.split("-")
      if (bounds.length > 2) {
        return { error: `The ${field.label} field "${text}" is not valid.` }
      }
      const first = parseFieldValue(bounds[0]!, field)
      const last =
        bounds.length === 2 ? parseFieldValue(bounds[1]!, field) : null
      if (first === null || (bounds.length === 2 && last === null)) {
        return {
          error: `The ${field.label} field allows ${field.min} to ${field.max}.`,
        }
      }
      start = first
      // `a/n` runs from a to the end of the field, as in Vixie cron.
      end = last ?? (stepText === undefined ? first : field.max)
      if (end < start) {
        return {
          error: `The range "${range}" in the ${field.label} field runs backwards.`,
        }
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return { values }
}

/**
 * Parses a five-field cron expression (`minute hour day month weekday`):
 * `*`, numbers, `a-b` ranges, `/n` steps, comma lists, month and weekday
 * names (`JAN`, `MON`), 7 as Sunday, and the `@hourly`, `@daily`,
 * `@weekly`, `@monthly` and `@yearly` shorthands.
 */
export function parseCronExpression(expression: string): CronParseResult {
  const trimmed = expression.trim()
  if (!trimmed) return { ok: false, error: "Enter a cron expression." }
  if (trimmed.length > AUTOMATION_CRON_MAX_CHARS) {
    return { ok: false, error: "This cron expression is too long." }
  }
  const expanded = trimmed.startsWith("@")
    ? CRON_MACROS[trimmed.toLowerCase()]
    : trimmed
  if (!expanded) {
    return { ok: false, error: `"${trimmed}" is not a supported shorthand.` }
  }
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) {
    return {
      ok: false,
      error:
        "A cron expression has 5 fields: minute, hour, day of month, month and day of week.",
    }
  }
  const sets: Set<number>[] = []
  for (let index = 0; index < FIELDS.length; index += 1) {
    const parsed = parseField(parts[index]!, FIELDS[index]!)
    if ("error" in parsed) return { ok: false, error: parsed.error }
    sets.push(parsed.values)
  }
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => day % 7))
  return {
    ok: true,
    cron: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      // Like cron itself: a field that starts with `*` restricts nothing.
      dayOfMonthRestricted: !parts[2]!.startsWith("*"),
      dayOfWeekRestricted: !parts[4]!.startsWith("*"),
    },
  }
}

function cronDayMatches(cron: CronExpression, date: Date): boolean {
  const dayOfMonth = cron.daysOfMonth.has(date.getDate())
  const dayOfWeek = cron.daysOfWeek.has(date.getDay())
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek
  }
  if (cron.dayOfMonthRestricted) return dayOfMonth
  if (cron.dayOfWeekRestricted) return dayOfWeek
  return true
}

const MINUTE_MS = 60_000
/** How far ahead an occurrence is looked for before "never" is answered. */
const CRON_SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE_MS

/**
 * The first minute strictly after `after` that the expression allows, in
 * local time, or `null` when none comes within five years (`0 0 30 2 *`).
 *
 * Minutes and hours advance in absolute time and days and months by the
 * calendar, so the search only ever moves forward: a skipped hour at a
 * daylight-saving change is passed over, a repeated one runs once.
 */
export function nextCronOccurrence(
  cron: CronExpression,
  after: Date
): Date | null {
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = after.getTime() + CRON_SEARCH_LIMIT_MS
  let candidate = new Date(start)
  for (let step = 0; step < 200_000; step += 1) {
    if (candidate.getTime() > limit) return null
    if (!cron.months.has(candidate.getMonth() + 1)) {
      candidate = new Date(
        candidate.getFullYear(),
        candidate.getMonth() + 1,
        1,
        0,
        0,
        0,
        0
      )
      continue
    }
    if (!cronDayMatches(cron, candidate)) {
      candidate = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate() + 1,
        0,
        0,
        0,
        0
      )
      continue
    }
    if (!cron.hours.has(candidate.getHours())) {
      candidate = new Date(
        candidate.getTime() + (60 - candidate.getMinutes()) * MINUTE_MS
      )
      continue
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      candidate = new Date(candidate.getTime() + MINUTE_MS)
      continue
    }
    return candidate
  }
  return null
}

/**
 * Whether two runs of the expression can come less than
 * `AUTOMATION_MIN_INTERVAL_MINUTES` apart: within an hour, or across the
 * turn of the hour when two consecutive hours are allowed.
 */
export function cronRunsTooOften(cron: CronExpression): boolean {
  const minutes = [...cron.minutes].sort((a, b) => a - b)
  for (let index = 1; index < minutes.length; index += 1) {
    if (minutes[index]! - minutes[index - 1]! < AUTOMATION_MIN_INTERVAL_MINUTES)
      return true
  }
  const first = minutes[0]
  const last = minutes[minutes.length - 1]
  if (first === undefined || last === undefined) return false
  const consecutiveHours = [...cron.hours].some((hour) =>
    cron.hours.has((hour + 1) % 24)
  )
  return consecutiveHours && 60 - last + first < AUTOMATION_MIN_INTERVAL_MINUTES
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `HH:MM` as hour and minute, or `null`. */
export function parseTimeOfDay(
  time: string
): { hour: number; minute: number } | null {
  const match = TIME_OF_DAY.exec(time)
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

/** An interval schedule's length in minutes. */
export function automationIntervalMinutes(
  every: number,
  unit: AutomationIntervalUnit
): number {
  return unit === "hours" ? every * 60 : every
}

function dailyCron(time: string, weekdays: readonly number[]): CronExpression {
  const parsed = parseTimeOfDay(time) ?? { hour: 0, minute: 0 }
  return {
    minutes: new Set([parsed.minute]),
    hours: new Set([parsed.hour]),
    daysOfMonth: new Set(Array.from({ length: 31 }, (_, index) => index + 1)),
    months: new Set(Array.from({ length: 12 }, (_, index) => index + 1)),
    daysOfWeek: new Set(weekdays),
    dayOfMonthRestricted: false,
    dayOfWeekRestricted: true,
  }
}

/**
 * Why a schedule cannot be saved, or `null`. A one-time run in the past is
 * checked where the clock is known (`automationOnceInPast`).
 */
export function automationScheduleProblem(
  schedule: AutomationSchedule
): string | null {
  switch (schedule.kind) {
    case "once":
      return Number.isFinite(Date.parse(schedule.at))
        ? null
        : "Choose a date and time."
    case "interval": {
      if (!Number.isInteger(schedule.every) || schedule.every < 1) {
        return "Enter a whole number."
      }
      const minutes = automationIntervalMinutes(schedule.every, schedule.unit)
      if (minutes < AUTOMATION_MIN_INTERVAL_MINUTES) {
        return `Runs can be at most every ${AUTOMATION_MIN_INTERVAL_MINUTES} minutes.`
      }
      if (minutes > AUTOMATION_MAX_INTERVAL_MINUTES) {
        return "Choose an interval of 31 days or less."
      }
      return null
    }
    case "daily": {
      if (!parseTimeOfDay(schedule.time)) return "Choose a time."
      if (schedule.weekdays.length === 0) return "Choose at least one day."
      if (
        schedule.weekdays.some(
          (day) => !Number.isInteger(day) || day < 0 || day > 6
        )
      ) {
        return "Choose days from Sunday to Saturday."
      }
      return null
    }
    case "cron": {
      const parsed = parseCronExpression(schedule.expression)
      if (!parsed.ok) return parsed.error
      if (cronRunsTooOften(parsed.cron)) {
        return `Runs can be at most every ${AUTOMATION_MIN_INTERVAL_MINUTES} minutes.`
      }
      // Checked from a fixed date so the answer does not change with the
      // clock: an expression with any occurrence has one within five years.
      if (!nextCronOccurrence(parsed.cron, new Date(2000, 0, 1))) {
        return "This expression never runs."
      }
      return null
    }
  }
}

/** Whether a one-time schedule's moment has already passed at `now`. */
export function automationOnceInPast(
  schedule: AutomationSchedule,
  now: Date
): boolean {
  return schedule.kind === "once" && !(Date.parse(schedule.at) > now.getTime())
}

/**
 * The first run strictly after `after`, or `null` when there is none (a
 * one-time run that has passed, an invalid schedule). Intervals count from
 * `anchor`, the moment the schedule was set, so a run that started late
 * does not shift the ones after it.
 */
export function nextAutomationRun(
  schedule: AutomationSchedule,
  after: Date,
  anchor: Date
): Date | null {
  if (automationScheduleProblem(schedule)) return null
  switch (schedule.kind) {
    case "once": {
      const at = Date.parse(schedule.at)
      return at > after.getTime() ? new Date(at) : null
    }
    case "interval": {
      const stepMs =
        automationIntervalMinutes(schedule.every, schedule.unit) * MINUTE_MS
      const elapsed = after.getTime() - anchor.getTime()
      const count = Math.max(1, Math.floor(elapsed / stepMs) + 1)
      return new Date(anchor.getTime() + count * stepMs)
    }
    case "daily":
      return nextCronOccurrence(
        dailyCron(schedule.time, schedule.weekdays),
        after
      )
    case "cron": {
      const parsed = parseCronExpression(schedule.expression)
      return parsed.ok ? nextCronOccurrence(parsed.cron, after) : null
    }
  }
}

/** The next `count` runs after `after`, for a preview. */
export function upcomingAutomationRuns(
  schedule: AutomationSchedule,
  after: Date,
  anchor: Date,
  count: number
): Date[] {
  const runs: Date[] = []
  let cursor = after
  while (runs.length < count) {
    const next = nextAutomationRun(schedule, cursor, anchor)
    if (!next) break
    runs.push(next)
    cursor = next
  }
  return runs
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** "Every 15 minutes", "Weekdays at 09:00", "Cron 0 9 * * 1-5", "Once". */
export function describeAutomationSchedule(
  schedule: AutomationSchedule
): string {
  switch (schedule.kind) {
    case "once":
      return "Once"
    case "interval": {
      const noun = schedule.unit === "hours" ? "hour" : "minute"
      return schedule.every === 1
        ? `Every ${noun}`
        : `Every ${schedule.every} ${noun}s`
    }
    case "daily": {
      const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b)
      const key = days.join(",")
      const when =
        days.length === 7
          ? "Every day"
          : key === "1,2,3,4,5"
            ? "Weekdays"
            : key === "0,6"
              ? "Weekends"
              : days.map((day) => SHORT_WEEKDAYS[day] ?? "?").join(", ")
      return `${when} at ${schedule.time}`
    }
    case "cron":
      return `Cron ${schedule.expression.trim()}`
  }
}
