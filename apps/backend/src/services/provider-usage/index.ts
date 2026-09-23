import { collectClaudeUsage } from "./claude"
import { collectCodexUsage } from "./codex"
import { collectGrokUsage } from "./grok"
import {
  emptySummary,
  type ProviderUsageReport,
  type UsageProviderId,
} from "./types"

export type {
  ProviderUsageReport,
  UsageDailyPoint,
  UsageEntry,
  UsageInsight,
  UsageLimit,
  UsageList,
  UsageProviderId,
  UsageStatus,
  UsageSummary,
  UsageTokenBreakdown,
} from "./types"

const LABELS: Record<UsageProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
}

function failedReport(
  provider: UsageProviderId,
  reason: unknown
): ProviderUsageReport {
  return {
    provider,
    label: LABELS[provider],
    status: "error",
    installed: false,
    authenticated: false,
    version: null,
    plan: null,
    source: "",
    fetchedAt: new Date().toISOString(),
    scannedMs: 0,
    summary: emptySummary(),
    daily: [],
    pricing: null,
    pricesFile: null,
    models: [],
    insights: [],
    lists: [],
    limits: [],
    limitsObservedAt: null,
    limitNotes: [],
    notes: [],
    error: reason instanceof Error ? reason.message : String(reason),
  }
}

/**
 * Read every provider CLI's own usage store. One provider failing never
 * removes the others from the page.
 */
export async function collectProviderUsage(options: {
  dataDir: string | null
  refresh?: boolean
}): Promise<ProviderUsageReport[]> {
  const refresh = options.refresh ?? false
  const order: UsageProviderId[] = ["claude", "codex", "grok"]
  const results = await Promise.allSettled([
    collectClaudeUsage({ dataDir: options.dataDir, refresh }),
    collectCodexUsage({ dataDir: options.dataDir, refresh }),
    collectGrokUsage({ dataDir: options.dataDir, refresh }),
  ])
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failedReport(order[index]!, result.reason)
  )
}
