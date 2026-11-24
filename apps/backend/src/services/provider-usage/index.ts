import { httpContracts } from "@betterc0de/schema/http-contracts"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { logger } from "../../observability/logger"
import { collectClaudeUsage, withClaudeLimits } from "./claude"
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
/**
 * How long a scan that failed for one provider stands. Clients ask again while
 * `refreshing` is set; without this pause each of those requests would start
 * the next failing scan.
 */
const FAILED_REPORT_TTL_MS = 10_000
const SAVED_REPORTS_FILE = "usage-reports.json"
/**
 * Bump when a report's shape or how one of its numbers is counted changes, so
 * a copy saved by an older build is not shown.
 */
const SAVED_REPORTS_VERSION = 1

interface ProfileReports {
  reports?: ProviderUsageReport[]
  expiresAt: number
  /** The scan running behind the current answers. */
  pending?: Promise<void>
  /** Reading the copy an earlier run saved; settles once per profile. */
  restoring?: Promise<void>
}

// Scope caches to the profile, and bound retained reports for embedded hosts.
const reportsByProfile = new Map<string | null, ProfileReports>()

function profileReports(dataDir: string | null): ProfileReports {
  let entry = reportsByProfile.get(dataDir)
  if (!entry) {
    if (reportsByProfile.size >= 4)
      reportsByProfile.delete(reportsByProfile.keys().next().value!)
    entry = { expiresAt: 0 }
    reportsByProfile.set(dataDir, entry)
  }
  return entry
}

/**
 * The usage reports, answered at once whenever there are any.
 *
 * A full read walks gigabytes of transcripts on an active machine, so the
 * last reports answer while a newer read runs behind the request: after a
 * refresh, when they are older than 30 seconds, and on the first request
 * after a restart, which is answered from the copy the last run saved. Those
 * answers carry `refreshing: true` until the new reports are in. Only a
 * profile without any reports yet waits for its first read.
 */
export async function collectProviderUsage(options: {
  dataDir: string | null
  refresh?: boolean
}): Promise<ProviderUsageReport[]> {
  const refresh = options.refresh ?? false
  const entry = profileReports(options.dataDir)
  entry.restoring ??= readSavedReports(options.dataDir).then((saved) => {
    entry.reports ??= saved
  })
  await entry.restoring
  if (
    (refresh || !entry.reports || entry.expiresAt <= Date.now()) &&
    !entry.pending
  ) {
    entry.pending = rescan(entry, options.dataDir, refresh)
  }
  if (!entry.reports) await entry.pending
  const reports = entry.reports
  if (!reports) throw new Error("Usage could not be read.")
  const scanning = entry.pending !== undefined
  const context = { dataDir: options.dataDir, refresh }
  return reports.map((report) => {
    const current =
      report.provider === "claude" ? withClaudeLimits(report, context) : report
    return scanning && !current.refreshing
      ? { ...current, refreshing: true }
      : current
  })
}

function rescan(
  entry: ProfileReports,
  dataDir: string | null,
  refresh: boolean
): Promise<void> {
  const scan = readProviderUsage({ dataDir, refresh })
    .then(async (reports) => {
      const failed = reports.some((report) => report.status === "error")
      entry.reports = reports
      entry.expiresAt =
        Date.now() + (failed ? FAILED_REPORT_TTL_MS : REPORT_TTL_MS)
      if (!failed) await saveReports(dataDir, reports)
    })
    .finally(() => {
      entry.pending = undefined
    })
  // A request that had reports to show is not waiting for this one.
  scan.catch((error: unknown) => {
    logger.warn({ err: error }, "provider usage scan failed")
  })
  return scan
}

function savedReportsPath(dataDir: string): string {
  return path.join(dataDir, SAVED_REPORTS_FILE)
}

async function readSavedReports(
  dataDir: string | null
): Promise<ProviderUsageReport[] | undefined> {
  if (!dataDir) return undefined
  try {
    const saved = JSON.parse(
      await fs.promises.readFile(savedReportsPath(dataDir), "utf8")
    ) as { version?: unknown; reports?: unknown }
    if (saved.version !== SAVED_REPORTS_VERSION) return undefined
    // Validated like an answer, so a damaged copy is dropped instead of
    // failing the request.
    if (!httpContracts.providerUsage.response.safeParse(saved.reports).success)
      return undefined
    return saved.reports as ProviderUsageReport[]
  } catch {
    return undefined
  }
}

async function saveReports(
  dataDir: string | null,
  reports: readonly ProviderUsageReport[]
): Promise<void> {
  if (!dataDir) return
  const target = savedReportsPath(dataDir)
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.promises.writeFile(
      temporary,
      JSON.stringify({ version: SAVED_REPORTS_VERSION, reports }),
      "utf8"
    )
    await fs.promises.rename(temporary, target)
  } catch {
    // Without a saved copy the next start waits for its first read.
    await fs.promises.rm(temporary, { force: true }).catch(() => {
      // Ignored: the temp file is disposable.
    })
  }
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
