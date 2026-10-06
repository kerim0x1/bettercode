import { collectClaudeUsage } from "./claude"
import { collectCodexUsage } from "./codex"
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

const REPORT_TTL_MS = 30_000
// Scope caches to the profile, and bound retained reports for embedded hosts.
const reportsByProfile = new Map<
  string | null,
  {
    reports?: ProviderUsageReport[]
    expiresAt: number
    pending?: Promise<ProviderUsageReport[]>
  }
>()

/** Read the supported usage stores, sharing recent and in-flight reports. */
export async function collectProviderUsage(options: {
  dataDir: string | null
  refresh?: boolean
}): Promise<ProviderUsageReport[]> {
  let cached = reportsByProfile.get(options.dataDir)
  if (!cached) {
    if (reportsByProfile.size >= 4)
      reportsByProfile.delete(reportsByProfile.keys().next().value!)
    cached = { expiresAt: 0 }
    reportsByProfile.set(options.dataDir, cached)
  }
  if (cached.pending) return cached.pending
  if (!options.refresh && cached.reports && cached.expiresAt > Date.now())
    return cached.reports
  const entry = cached
  entry.pending = readProviderUsage(options)
    .then((reports) => {
      entry.reports = reports
      entry.expiresAt = reports.some((report) => report.status === "error")
        ? 0
        : Date.now() + REPORT_TTL_MS
      return reports
    })
    .finally(() => {
      entry.pending = undefined
    })
  return entry.pending
}

async function readProviderUsage(options: {
  dataDir: string | null
  refresh?: boolean
}): Promise<ProviderUsageReport[]> {
  const refresh = options.refresh ?? false
  const order: UsageProviderId[] = ["claude", "codex"]
  const results = await Promise.allSettled([
    collectClaudeUsage({ dataDir: options.dataDir, refresh }),
    collectCodexUsage({ dataDir: options.dataDir, refresh }),
  ])
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failedReport(order[index]!, result.reason)
  )
}
