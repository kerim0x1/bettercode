import type {
  UsageDailyPoint,
  UsageEntry,
  UsageSummary,
  UsageTokenBreakdown,
} from "./types"
import { emptySummary } from "./types"

/**
 * Calendar day in the machine's own timezone.
 *
 * Every store timestamps differently (ISO strings from Claude, unix seconds
 * from Codex), but a usage heatmap is read against the user's local days, so
 * all of them are folded onto the same local boundary here.
 */
export function localDay(value: Date | number | string): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** Local midnight for a `YYYY-MM-DD` key, so day arithmetic stays DST-safe. */
export function dayStart(date: string): number {
  const [year, month, day] = date.split("-").map(Number)
  if (!year || !month || !day) return Number.NaN
  return new Date(year, month - 1, day).getTime()
}

function nextDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

function previousDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() - 1)
  return date.getTime()
}

export interface DayBucket {
  tokens: number
  messages: number
  sessions: number
}

export function addDay(
  daily: Map<string, DayBucket>,
  date: string,
  bucket: Partial<DayBucket>
): void {
  if (!date) return
  const current = daily.get(date) ?? { tokens: 0, messages: 0, sessions: 0 }
  current.tokens += bucket.tokens ?? 0
  current.messages += bucket.messages ?? 0
  current.sessions += bucket.sessions ?? 0
  daily.set(date, current)
}

export function dailyPoints(daily: Map<string, DayBucket>): UsageDailyPoint[] {
  return [...daily.entries()]
    .filter(([date]) => Boolean(date))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, bucket]) => ({ date, ...bucket }))
}

/** Consecutive-day runs over the days that actually recorded activity. */
export function streaks(dates: readonly string[]): {
  current: number
  longest: number
} {
  const active = new Set(dates.filter(Boolean))
  const sorted = [...active].sort()
  let longest = 0
  let run = 0
  let previous: number | null = null
  for (const date of sorted) {
    const start = dayStart(date)
    if (!Number.isFinite(start)) continue
    run = previous !== null && nextDay(previous) === start ? run + 1 : 1
    if (run > longest) longest = run
    previous = start
  }
  let current = 0
  let cursor = dayStart(localDay(Date.now()))
  // A day that has not been worked on yet must not break yesterday's streak.
  if (!active.has(localDay(cursor))) cursor = previousDay(cursor)
  while (active.has(localDay(cursor))) {
    current += 1
    cursor = previousDay(cursor)
  }
  return { current, longest }
}

export function summarize(options: {
  daily: Map<string, DayBucket>
  tokens: UsageTokenBreakdown
  sessions: number
  messages: number
  longestSessionMs: number
  /**
   * All-time total where the store knows one the daily series cannot reach —
   * Claude keeps lifetime totals per model but only a few months of days.
   */
  totalTokens?: number
  firstActivity?: string | null
  lastActivity?: string | null
  cost?: number | null
}): UsageSummary {
  const summary = emptySummary()
  const points = dailyPoints(options.daily)
  const withTokens = points.filter((point) => point.tokens > 0)
  summary.tokens = options.tokens
  summary.totalTokens =
    options.totalTokens ?? points.reduce((sum, point) => sum + point.tokens, 0)
  const peak = withTokens.reduce<UsageDailyPoint | null>(
    (best, point) =>
      best === null || point.tokens > best.tokens ? point : best,
    null
  )
  summary.peakDayTokens = peak?.tokens ?? 0
  summary.peakDayDate = peak?.date ?? null
  summary.activeDays = points.length
  summary.sessions = options.sessions
  summary.messages = options.messages
  summary.longestSessionMs = options.longestSessionMs
  const runs = streaks(points.map((point) => point.date))
  summary.currentStreakDays = runs.current
  summary.longestStreakDays = runs.longest
  summary.firstActivity = options.firstActivity ?? points.at(0)?.date ?? null
  summary.lastActivity = options.lastActivity ?? points.at(-1)?.date ?? null
  summary.cost = options.cost ?? null
  return summary
}

/** Largest `limit` counters, with each one's share of the counted total. */
export function topEntries(
  counts: Map<string, number>,
  limit = 6
): UsageEntry[] {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  return [...counts.entries()]
    .filter(([id, value]) => Boolean(id) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, value]) => ({
      id,
      label: id,
      value,
      ...(total > 0 ? { share: value / total } : {}),
    }))
}

export function countMax(counts: Map<string, number>): {
  key: string
  value: number
  share: number
} | null {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  if (total === 0) return null
  let best: [string, number] | null = null
  for (const entry of counts) {
    if (best === null || entry[1] > best[1]) best = entry
  }
  if (!best) return null
  return { key: best[0], value: best[1], share: best[1] / total }
}

export function percent(value: number): string {
  if (!Number.isFinite(value)) return "0%"
  const scaled = value * 100
  return `${scaled >= 10 || scaled === 0 ? Math.round(scaled) : scaled.toFixed(1)}%`
}

export function addTokens(
  target: UsageTokenBreakdown,
  source: Partial<UsageTokenBreakdown>
): void {
  target.input += source.input ?? 0
  target.output += source.output ?? 0
  target.reasoning += source.reasoning ?? 0
  target.cacheRead += source.cacheRead ?? 0
  target.cacheWrite += source.cacheWrite ?? 0
}
