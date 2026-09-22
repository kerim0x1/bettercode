/**
 * One normalized usage report per provider CLI.
 *
 * Every provider stores its history differently — Claude keeps JSONL
 * transcripts plus a stats cache, Codex keeps a SQLite thread index, Grok
 * keeps per-session summaries — so each collector reduces its own store to
 * the shape below and the renderer stays provider-agnostic.
 */

export type UsageProviderId = "claude" | "codex" | "grok"

/** `ready` means numbers are present; `partial` means the store exists but
 *  cannot report tokens (Grok today); `unavailable` means nothing installed. */
export type UsageStatus = "ready" | "partial" | "unavailable" | "error"

export interface UsageDailyPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  tokens: number
  messages: number
  sessions: number
}

export interface UsageEntry {
  id: string
  label: string
  value: number
  /** 0..1 of the list total, filled in by the collector when meaningful. */
  share?: number
  /** USD at list prices, where a rate for this entry is known. */
  cost?: number
}

/** What the recorded tokens would cost at the providers' published rates. */
export interface UsagePricing {
  currency: "USD"
  total: number
  breakdown: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  pricedTokens: number
  /** Tokens from models with no published rate, so the gap is visible. */
  unpricedTokens: number
  unpricedModels: string[]
  /** True when some rate came from the user's own `model-prices.json`. */
  hasOverrides: boolean
  /** Caveats specific to how this provider's cost was derived. */
  notes: string[]
}

export interface UsageList {
  id: string
  title: string
  /** Noun for the value column, e.g. `runs` or `tokens`. */
  unit: string
  entries: UsageEntry[]
}

/** A heterogeneous line in the activity-insights column: the collector
 *  formats the value because "Very high · 56%" has no numeric shape. */
export interface UsageInsight {
  id: string
  label: string
  value: string
  hint?: string
}

export interface UsageLimit {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  resetLabel: string | null
}

export interface UsageTokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageSummary {
  totalTokens: number
  tokens: UsageTokenBreakdown
  peakDayTokens: number
  peakDayDate: string | null
  longestSessionMs: number
  currentStreakDays: number
  longestStreakDays: number
  sessions: number
  messages: number
  activeDays: number
  firstActivity: string | null
  lastActivity: string | null
  /** Only reported where the store records money; `null` elsewhere. */
  cost: number | null
}

export interface ProviderUsageReport {
  provider: UsageProviderId
  label: string
  status: UsageStatus
  installed: boolean
  authenticated: boolean
  version: string | null
  /** Subscription tier when the store names one, e.g. Codex `plan_type`. */
  plan: string | null
  /** Human-readable description of where these numbers came from. */
  source: string
  fetchedAt: string
  scannedMs: number
  summary: UsageSummary
  daily: UsageDailyPoint[]
  /** `null` when no model in this report has a published rate. */
  pricing: UsagePricing | null
  /** Absolute path of the file where the user can add missing rates. */
  pricesFile: string | null
  models: UsageEntry[]
  insights: UsageInsight[]
  lists: UsageList[]
  limits: UsageLimit[]
  /** When the limits were read; they are served from a stored copy. */
  limitsObservedAt: string | null
  /**
   * What the provider says is driving those limits, in its own layout —
   * indented lines are details under the unindented line above them.
   */
  limitNotes: string[]
  /** Caveats worth showing under the report, e.g. retention windows. */
  notes: string[]
  error?: string
}

export function emptyTokenBreakdown(): UsageTokenBreakdown {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptySummary(): UsageSummary {
  return {
    totalTokens: 0,
    tokens: emptyTokenBreakdown(),
    peakDayTokens: 0,
    peakDayDate: null,
    longestSessionMs: 0,
    currentStreakDays: 0,
    longestStreakDays: 0,
    sessions: 0,
    messages: 0,
    activeDays: 0,
    firstActivity: null,
    lastActivity: null,
    cost: null,
  }
}
