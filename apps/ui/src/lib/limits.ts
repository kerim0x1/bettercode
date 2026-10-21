/**
 * Pure helpers for the Limits page: remaining share, reset times and
 * countdowns, and the trend between two readings of the same limit.
 *
 * The limits themselves come from `GET /usage/providers` (see
 * `usage-store.ts`). Codex reports an exact reset instant; Claude Code only
 * prints a sentence such as `resets Sep 22, 7pm (Europe/Berlin)`, which
 * `parseResetLabel` turns into an instant where the wording is unambiguous.
 */

import { parseResetLabel, resetLabelText } from "@betterc0de/schema"

/** How often the open Limits page asks for a new report. */
export const LIMITS_POLL_MS = 30_000

/** A change older than this no longer shows a trend arrow. */
export const TREND_WINDOW_MS = 30 * 60_000

/**
 * At or below these shares of a window left, a limit reads "Getting close"
 * (warning) or "Almost at limit" (destructive): the Usage page's 70% and 90%
 * used, seen from the other side.
 */
export const LOW_REMAINING_PERCENT = 30
export const CRITICAL_REMAINING_PERCENT = 10

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export interface LimitLike {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  resetLabel: string | null
}

/** Whole percent of the window still available, clamped to 0..100. */
export function remainingPercent(
  limit: Pick<LimitLike, "usedPercent">
): number {
  const used = Number.isFinite(limit.usedPercent) ? limit.usedPercent : 0
  return Math.round(Math.max(0, Math.min(100, 100 - used)))
}

export type LimitTone = "normal" | "low" | "critical"

export function limitTone(remaining: number): LimitTone {
  if (remaining <= CRITICAL_REMAINING_PERCENT) return "critical"
  if (remaining <= LOW_REMAINING_PERCENT) return "low"
  return "normal"
}

/** The status words the Usage page's limit rows use. */
export function limitStatus(remaining: number): string {
  if (remaining <= 0) return "Limit reached"
  const tone = limitTone(remaining)
  if (tone === "critical") return "Almost at limit"
  if (tone === "low") return "Getting close"
  return "Available"
}

/**
 * How long a limit window lasts, from its label: Codex names the length
 * ("5-hour limit", "Weekly limit"), Claude Code says "session" (5 hours) or
 * "week". Unknown wording returns null.
 */
export function limitWindowMs(label: string): number | null {
  const hours = /(\d+)[-\s]?hours?\b/i.exec(label)
  if (hours) return Number(hours[1]) * HOUR_MS
  if (/session/i.test(label)) return 5 * HOUR_MS
  if (/week/i.test(label)) return 7 * DAY_MS
  if (/\bday\b|daily/i.test(label)) return DAY_MS
  return null
}

export interface LimitPace {
  /** Share of the window's time that has passed, 0..100. */
  elapsedPercent: number
  /**
   * Time until the window is used up at the rate so far, when that comes
   * before the reset; 0 once it is used up, null while it lasts.
   */
  runsOutInMs: number | null
}

/**
 * Use against time: how far into its window a limit is, and whether the
 * rate so far uses it up before it resets. Too early in a window (under 5%
 * of its time) the rate says little, so nothing is projected.
 */
export function limitPace(options: {
  usedPercent: number
  resetAt: number | null
  windowMs: number | null
  now: number
}): LimitPace | null {
  const { usedPercent, resetAt, windowMs, now } = options
  if (resetAt === null || windowMs === null || windowMs <= 0) return null
  const left = resetAt - now
  if (left <= 0 || left > windowMs) return null
  const elapsed = windowMs - left
  const elapsedPercent = Math.round((elapsed / windowMs) * 100)
  const used = Number.isFinite(usedPercent)
    ? Math.max(0, Math.min(100, usedPercent))
    : 0
  if (used >= 100) return { elapsedPercent, runsOutInMs: 0 }
  if (used <= 0 || elapsed < windowMs * 0.05) {
    return { elapsedPercent, runsOutInMs: null }
  }
  const toEmpty = ((100 - used) / used) * elapsed
  return { elapsedPercent, runsOutInMs: toEmpty < left ? toEmpty : null }
}

/** `6d 20h`, `1h 44m`, `12m`, `<1m`; `now` once the time has passed. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now"
  if (ms < 60_000) return "<1m"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`
}

/** The countdown spelled out for assistive technology. */
export function describeCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now"
  if (ms < 60_000) return "less than a minute"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return plural(minutes, "minute")
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0
      ? plural(hours, "hour")
      : `${plural(hours, "hour")} ${plural(rest, "minute")}`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0
    ? plural(days, "day")
    : `${plural(days, "day")} ${plural(rest, "hour")}`
}

/** `just now`, `12s ago`, `3 min ago`, `2 h ago`, `4 d ago`. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

// The reset-sentence reader lives in `@betterc0de/schema` (reset-label.ts),
// which the backend shares; re-exported for this page's callers.
export { parseResetLabel, resetLabelText }

/**
 * When a limit resets: the provider's exact instant, else its reset sentence
 * read relative to `reference` (when the sentence was printed).
 */
export function limitResetAt(
  limit: Pick<LimitLike, "resetsAt" | "resetLabel">,
  reference: number
): number | null {
  if (limit.resetsAt) {
    const parsed = Date.parse(limit.resetsAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return limit.resetLabel ? parseResetLabel(limit.resetLabel, reference) : null
}

/** Accessible name for one limit meter. */
export function describeLimit(options: {
  provider: string
  label: string
  remaining: number
  resetInMs: number | null
  resetLabel: string | null
}): string {
  const { provider, label, remaining, resetInMs, resetLabel } = options
  const name = label ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : ""
  const parts = [`${provider} ${name}`.trim(), `${remaining}% left`]
  const tone = limitTone(remaining)
  if (remaining <= 0) parts.push("limit reached")
  else if (tone === "critical") parts.push("almost used up")
  else if (tone === "low") parts.push("running low")
  if (resetInMs !== null) {
    parts.push(
      resetInMs > 0
        ? `resets in ${describeCountdown(resetInMs)}`
        : "reset time has passed"
    )
  } else if (resetLabel) {
    parts.push(`resets ${resetLabelText(resetLabel)}`)
  }
  return parts.join(", ")
}

/** The last remaining share seen for one limit, and the one before it. */
export interface LimitReading {
  remaining: number
  /** The previous, different reading; null until the value first changes. */
  previous: number | null
  /** When `remaining` was first seen at its current value. */
  changedAt: number
}

export type LimitReadings = Record<string, LimitReading>

export function limitReadingKey(provider: string, limitId: string): string {
  return `${provider}:${limitId}`
}

/**
 * Folds the current readings into the stored ones. A changed value keeps the
 * value it replaced, so the trend survives later identical polls. Limits a
 * provider no longer reports are dropped, but only for providers in
 * `current`, so a provider that failed to report keeps its history. Returns
 * `previous` itself when nothing changed.
 */
export function applyLimitReadings(
  previous: LimitReadings,
  current: ReadonlyArray<{ provider: string; id: string; remaining: number }>,
  now: number
): LimitReadings {
  let next: LimitReadings | null = null
  const seen = new Set<string>()
  const providers = new Set<string>()
  for (const { provider, id, remaining } of current) {
    const key = limitReadingKey(provider, id)
    seen.add(key)
    providers.add(provider)
    const before = previous[key]
    if (before && before.remaining === remaining) continue
    next ??= { ...previous }
    next[key] = {
      remaining,
      previous: before ? before.remaining : null,
      changedAt: now,
    }
  }
  for (const key of Object.keys(previous)) {
    const provider = key.slice(0, key.indexOf(":"))
    if (!providers.has(provider) || seen.has(key)) continue
    next ??= { ...previous }
    delete next[key]
  }
  return next ?? previous
}

export type LimitTrend = "down" | "up" | null

/** Down after use, up after a reset; nothing once the change is old. */
export function limitTrend(
  reading: LimitReading | undefined,
  now: number,
  windowMs = TREND_WINDOW_MS
): LimitTrend {
  if (!reading || reading.previous === null) return null
  if (now - reading.changedAt > windowMs) return null
  if (reading.remaining < reading.previous) return "down"
  if (reading.remaining > reading.previous) return "up"
  return null
}

const READINGS_STORAGE_KEY = "betterc0de-limit-readings"
let memoryReadings: LimitReadings | null = null

function isReading(value: unknown): value is LimitReading {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.remaining === "number" &&
    Number.isFinite(entry.remaining) &&
    (entry.previous === null ||
      (typeof entry.previous === "number" &&
        Number.isFinite(entry.previous))) &&
    typeof entry.changedAt === "number" &&
    Number.isFinite(entry.changedAt)
  )
}

/** Readings kept for this window, falling back to the stored copy. */
export function loadLimitReadings(): LimitReadings {
  if (memoryReadings) return memoryReadings
  const readings: LimitReadings = {}
  try {
    const raw = globalThis.localStorage?.getItem(READINGS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (key.includes(":") && isReading(value)) readings[key] = value
      }
    }
  } catch {
    // A missing or unreadable copy only costs the first trend arrow.
  }
  memoryReadings = readings
  return readings
}

export function saveLimitReadings(readings: LimitReadings): void {
  memoryReadings = readings
  try {
    globalThis.localStorage?.setItem(
      READINGS_STORAGE_KEY,
      JSON.stringify(readings)
    )
  } catch {
    // Storage can be full or blocked; the in-memory copy still works.
  }
}

/**
 * How far ahead the reset timeline looks: a little past the last reset, at
 * least a day and at most a week.
 */
export function resetTimelineSpan(lastResetInMs: number): number {
  return Math.min(7 * DAY_MS, Math.max(DAY_MS, lastResetInMs * 1.08))
}

/**
 * Lanes for the timeline's labels, given each marker's position in percent
 * (sorted ascending). A label takes the first lane whose last label sits at
 * least `minGap` percent to the left, so neighbours never overlap; when every
 * lane is taken it goes to the one whose last label is furthest left.
 */
export function timelineLanes(
  positions: readonly number[],
  lanes: number,
  minGap: number
): number[] {
  const lastInLane = Array.from({ length: lanes }, () => -Infinity)
  return positions.map((x) => {
    let lane = lastInLane.findIndex((last) => x - last >= minGap)
    if (lane < 0) {
      lane = lastInLane.indexOf(Math.min(...lastInLane))
    }
    lastInLane[lane] = x
    return lane
  })
}
