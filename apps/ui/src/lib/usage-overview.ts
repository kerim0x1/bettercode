/**
 * Pure helpers for the Usage page's Cost and Tokens views: the day range,
 * one chart row per day with a value per provider, per-provider and
 * per-model totals, and number formats.
 *
 * Ranges sum the reports' daily points. "All" uses each provider's all-time
 * totals instead, because older days can keep a token count without the
 * per-model split a cost needs (see `UsageDailyPoint.cost`).
 */
import type {
  ProviderUsageReport,
  UsageProviderId,
} from "@/services/backend/coreApi"

export type UsageMetric = "cost" | "tokens"
export type UsageRangeId = "7d" | "30d" | "90d" | "all"

export const USAGE_RANGES: ReadonlyArray<{
  id: UsageRangeId
  label: string
  days: number | null
}> = [
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "all", label: "All", days: null },
]

/** The longest span "All" charts, so a very old first day stays cheap. */
const MAX_CHART_DAYS = 1100

export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0"
  const unit =
    value >= 1e12
      ? { divisor: 1e12, suffix: "T" }
      : value >= 1e9
        ? { divisor: 1e9, suffix: "B" }
        : value >= 1e6
          ? { divisor: 1e6, suffix: "M" }
          : value >= 1e3
            ? { divisor: 1e3, suffix: "K" }
            : null
  if (!unit) return Math.round(value).toLocaleString()
  const scaled = value / unit.divisor
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled
    .toFixed(decimals)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")}${unit.suffix}`
}

export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value > 0 && value < 0.01) return "<$0.01"
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 10_000 ? 0 : 2,
  })
}

/** Axis money: `$0`, `$250`, `$1.5K`. */
export function formatMoneyAxis(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0"
  return value >= 1000 ? `$${formatCompact(value)}` : `$${Math.round(value)}`
}

/** A share as `33.2%`, `<0.1%` for a sliver, `0%` for nothing. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%"
  if (share < 0.001) return "<0.1%"
  return `${(share * 100).toFixed(1)}%`
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local midnight of a `YYYY-MM-DD` day. */
export function dayStart(date: string): number {
  return new Date(`${date}T00:00:00`).getTime()
}

/**
 * Local midnight `days` calendar days after `timestamp`'s day. Calendar steps,
 * not multiples of 24 h, so a daylight-saving change never repeats a date.
 */
export function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * The days a range covers, oldest first, ending today. "All" (null) starts
 * at the first day any report has.
 */
export function rangeDays(
  reports: readonly ProviderUsageReport[],
  days: number | null,
  now: number
): string[] {
  const today = addLocalDays(now, 0)
  let start: number
  if (days !== null) {
    start = addLocalDays(today, -(days - 1))
  } else {
    const first = reports
      .flatMap((report) => report.daily.map((point) => point.date))
      .sort()
      .at(0)
    start = first ? dayStart(first) : today
    if (!Number.isFinite(start)) start = today
  }
  start = Math.max(start, addLocalDays(today, -(MAX_CHART_DAYS - 1)))
  const out: string[] = []
  for (let day = start; day <= today; day = addLocalDays(day, 1)) {
    out.push(localDayKey(day))
  }
  return out
}

export type UsageChartRow = { date: string } & Record<string, number | string>

/** One row per day with each provider's cost or tokens; missing days are 0. */
export function dailySeries(
  reports: readonly ProviderUsageReport[],
  dates: readonly string[],
  metric: UsageMetric
): UsageChartRow[] {
  const byProvider = reports.map(
    (report) =>
      [
        report.provider,
        new Map(
          report.daily.map((point) => [
            point.date,
            metric === "cost" ? (point.cost ?? 0) : point.tokens,
          ])
        ),
      ] as const
  )
  return dates.map((date) => {
    const row: UsageChartRow = { date }
    for (const [provider, values] of byProvider) {
      row[provider] = values.get(date) ?? 0
    }
    return row
  })
}

export interface ProviderUsageTotals {
  provider: UsageProviderId
  /** USD at list prices; null when the provider has no published rates. */
  cost: number | null
  tokens: number
  sessions: number
  /** Days in the range that recorded tokens but no cost. */
  unpricedDays: number
}

/** A provider's totals for the given days, or all time when `dates` is null. */
export function providerTotals(
  report: ProviderUsageReport,
  dates: ReadonlySet<string> | null
): ProviderUsageTotals {
  if (!dates) {
    return {
      provider: report.provider,
      cost: report.pricing?.total ?? null,
      tokens: report.summary.totalTokens,
      sessions: report.summary.sessions,
      unpricedDays: 0,
    }
  }
  let cost = 0
  let priced = false
  let tokens = 0
  let sessions = 0
  let unpricedDays = 0
  for (const point of report.daily) {
    if (!dates.has(point.date)) continue
    tokens += point.tokens
    sessions += point.sessions
    if (point.cost !== undefined) {
      cost += point.cost
      priced = true
    } else if (point.tokens > 0) {
      unpricedDays += 1
    }
  }
  return {
    provider: report.provider,
    cost: priced ? cost : report.pricing ? 0 : null,
    tokens,
    sessions,
    unpricedDays,
  }
}

export function metricValue(
  totals: Pick<ProviderUsageTotals, "cost" | "tokens">,
  metric: UsageMetric
): number {
  return metric === "cost" ? (totals.cost ?? 0) : totals.tokens
}

export interface ModelUsageRow {
  key: string
  provider: UsageProviderId
  label: string
  tokens: number
  cost: number | null
  /** 0..1 of the active metric's total. */
  share: number
}

/** Every provider's models in one list, largest first by the active metric. */
export function modelRows(
  reports: readonly ProviderUsageReport[],
  metric: UsageMetric
): ModelUsageRow[] {
  const rows = reports.flatMap((report) =>
    report.models.map((model) => ({
      key: `${report.provider}:${model.id}`,
      provider: report.provider,
      label: model.label,
      tokens: model.value,
      cost: model.cost ?? null,
    }))
  )
  const total = rows.reduce((sum, row) => sum + metricValue(row, metric), 0)
  return rows
    .map((row) => ({
      ...row,
      share: total > 0 ? metricValue(row, metric) / total : 0,
    }))
    .sort(
      (a, b) =>
        metricValue(b, metric) - metricValue(a, metric) || b.tokens - a.tokens
    )
}

export interface DayUsageRow {
  date: string
  /** Null when no provider recorded a cost for the day. */
  cost: number | null
  tokens: number
  sessions: number
  share: number
}

/** Active days in the range, newest first, with their share of the range. */
export function dayRows(
  reports: readonly ProviderUsageReport[],
  dates: readonly string[],
  metric: UsageMetric
): DayUsageRow[] {
  const wanted = new Set(dates)
  const days = new Map<string, Omit<DayUsageRow, "share">>()
  for (const report of reports) {
    for (const point of report.daily) {
      if (!wanted.has(point.date)) continue
      const day = days.get(point.date) ?? {
        date: point.date,
        cost: null,
        tokens: 0,
        sessions: 0,
      }
      day.tokens += point.tokens
      day.sessions += point.sessions
      if (point.cost !== undefined) day.cost = (day.cost ?? 0) + point.cost
      days.set(point.date, day)
    }
  }
  const active = [...days.values()].filter(
    (day) => day.tokens > 0 || day.sessions > 0 || (day.cost ?? 0) > 0
  )
  const total = active.reduce((sum, day) => sum + metricValue(day, metric), 0)
  return active
    .map((day) => ({
      ...day,
      share: total > 0 ? metricValue(day, metric) / total : 0,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

export interface UsageTotals {
  processed: number
  cachedInput: number
  uncachedInput: number
  cacheWrites: number
  output: number
  /** Null when no provider reports it (no rates, or an older host). */
  cacheSavings: number | null
}

/** All-time token totals across providers. */
export function usageTotals(
  reports: readonly ProviderUsageReport[]
): UsageTotals {
  const totals: UsageTotals = {
    processed: 0,
    cachedInput: 0,
    uncachedInput: 0,
    cacheWrites: 0,
    output: 0,
    cacheSavings: null,
  }
  for (const report of reports) {
    const tokens = report.summary.tokens
    totals.processed += report.summary.totalTokens
    totals.cachedInput += tokens.cacheRead
    totals.uncachedInput += tokens.input
    totals.cacheWrites += tokens.cacheWrite
    totals.output += tokens.output
    const savings = report.pricing?.cacheSavings
    if (typeof savings === "number") {
      totals.cacheSavings = (totals.cacheSavings ?? 0) + savings
    }
  }
  return totals
}

export interface RangeSummary {
  total: number
  sessions: number
  activeDays: number
  /** Total divided by the days in the range. */
  perDay: number
  peak: { date: string; value: number } | null
}

/** What a chart row range adds up to for the active metric. */
export function rangeSummary(
  rows: readonly UsageChartRow[],
  providers: readonly string[],
  reports: readonly ProviderUsageReport[]
): RangeSummary {
  let total = 0
  let activeDays = 0
  let peak: RangeSummary["peak"] = null
  for (const row of rows) {
    let value = 0
    for (const provider of providers) value += Number(row[provider]) || 0
    total += value
    if (value > 0) activeDays += 1
    if (value > 0 && (!peak || value > peak.value)) {
      peak = { date: row.date, value }
    }
  }
  const dates = new Set(rows.map((row) => row.date))
  let sessions = 0
  for (const report of reports) {
    if (!providers.includes(report.provider)) continue
    for (const point of report.daily) {
      if (dates.has(point.date)) sessions += point.sessions
    }
  }
  return {
    total,
    sessions,
    activeDays,
    perDay: rows.length > 0 ? total / rows.length : 0,
    peak,
  }
}

/**
 * The same metric for the equally long period before the range, to compare
 * against. Null when there is nothing to compare: "All", no data before, or
 * a cost period with days that kept tokens but no cost.
 */
export function previousPeriodTotal(
  reports: readonly ProviderUsageReport[],
  providers: readonly string[],
  days: number | null,
  now: number,
  metric: UsageMetric
): number | null {
  if (days === null) return null
  const end = addLocalDays(now, -days)
  const start = addLocalDays(end, -(days - 1))
  const from = localDayKey(start)
  const to = localDayKey(end)
  let total = 0
  let seen = false
  for (const report of reports) {
    if (!providers.includes(report.provider)) continue
    for (const point of report.daily) {
      if (point.date < from || point.date > to) continue
      if (metric === "cost" && point.cost === undefined && point.tokens > 0) {
        return null
      }
      const value = metric === "cost" ? (point.cost ?? 0) : point.tokens
      if (value > 0) seen = true
      total += value
    }
  }
  return seen ? total : null
}

/** Average of the metric per weekday in the range, Monday first. */
export function weekdayRhythm(
  rows: readonly UsageChartRow[],
  providers: readonly string[]
): number[] {
  const sums = Array.from({ length: 7 }, () => 0)
  const counts = Array.from({ length: 7 }, () => 0)
  for (const row of rows) {
    const weekday = (new Date(`${row.date}T00:00:00`).getDay() + 6) % 7
    let value = 0
    for (const provider of providers) value += Number(row[provider]) || 0
    sums[weekday] += value
    counts[weekday] += 1
  }
  return sums.map((sum, index) => (counts[index] > 0 ? sum / counts[index] : 0))
}

/** Share of all input tokens that was read back from the prompt cache. */
export function cacheHitRate(
  tokens: Pick<UsageTotals, "cachedInput" | "uncachedInput" | "cacheWrites">
): number {
  const input = tokens.cachedInput + tokens.uncachedInput + tokens.cacheWrites
  return input > 0 ? tokens.cachedInput / input : 0
}

export interface ActivityStreaks {
  /** Days in a row with activity, ending today (or yesterday, while today is quiet). */
  current: number
  longest: number
  /** Last day of the longest run, `YYYY-MM-DD`. */
  longestEnd: string | null
}

/** Runs of consecutive days on which any provider recorded activity. */
export function activityStreaks(
  reports: readonly ProviderUsageReport[],
  now: number
): ActivityStreaks {
  const active = new Set<string>()
  for (const report of reports) {
    for (const point of report.daily) {
      if (point.tokens > 0 || point.sessions > 0) active.add(point.date)
    }
  }
  let longest = 0
  let longestEnd: string | null = null
  let run = 0
  let previous: number | null = null
  for (const date of [...active].sort()) {
    const start = dayStart(date)
    run =
      previous !== null && localDayKey(addLocalDays(previous, 1)) === date
        ? run + 1
        : 1
    if (run > longest) {
      longest = run
      longestEnd = date
    }
    previous = start
  }
  let cursor = addLocalDays(now, 0)
  if (!active.has(localDayKey(cursor))) cursor = addLocalDays(cursor, -1)
  let current = 0
  while (active.has(localDayKey(cursor))) {
    current += 1
    cursor = addLocalDays(cursor, -1)
  }
  return { current, longest, longestEnd }
}
