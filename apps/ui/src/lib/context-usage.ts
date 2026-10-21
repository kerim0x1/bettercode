import type { ThreadActivity } from "@betterc0de/schema"

/** The activity the provider events record for each usage snapshot. */
export const CONTEXT_WINDOW_ACTIVITY = "context-window.updated"

export interface ContextUsage {
  usedTokens: number
  maxTokens: number | null
  totalProcessedTokens: number | null
  compactsAutomatically: boolean | null
  providerKind: string | null
  providerInstanceId: string | null
}

export function latestContextActivity(
  activities: readonly ThreadActivity[] | undefined
): ThreadActivity | null {
  if (!activities) return null
  for (let index = activities.length - 1; index >= 0; index--) {
    if (activities[index].kind === CONTEXT_WINDOW_ACTIVITY)
      return activities[index]
  }
  return null
}

/**
 * Reads a usage snapshot from a `context-window.updated` payload or a
 * thread's live `usage`. Returns null until something used tokens.
 */
export function readContextUsage(source: unknown): ContextUsage | null {
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null
  const record = source as Record<string, unknown>
  const usedTokens =
    tokenCount(record.usedTokens) ?? tokenCount(record.totalTokens)
  if (!usedTokens) return null
  return {
    usedTokens,
    maxTokens: tokenCount(record.maxTokens) || null,
    totalProcessedTokens: tokenCount(record.totalProcessedTokens) || null,
    compactsAutomatically:
      typeof record.compactsAutomatically === "boolean"
        ? record.compactsAutomatically
        : null,
    providerKind:
      typeof record.providerKind === "string" ? record.providerKind : null,
    providerInstanceId:
      typeof record.providerInstanceId === "string"
        ? record.providerInstanceId
        : null,
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

const COMPACT_TOKENS = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

/** "99", "35K", "187.4K", "1M" */
export function formatContextTokens(tokens: number): string {
  return COMPACT_TOKENS.format(Math.max(0, tokens))
}

/** "0%", "<0.1%", "3.7%", "42%" */
export function formatPercent(percent: number): string {
  if (percent <= 0) return "0%"
  if (percent < 0.1) return "<0.1%"
  if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, "")}%`
  return `${Math.round(percent)}%`
}
