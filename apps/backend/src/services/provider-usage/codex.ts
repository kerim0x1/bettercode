import Database from "better-sqlite3"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  detectCodexCliAsync,
  isCodexCliAuthenticatedAsync,
} from "../../cli/detect"
import { scanWithCache } from "./cache"
import {
  LONG_CONTEXT_NOTE,
  PriceBook,
  priceModels,
  type PricedTokens,
} from "./pricing"
import {
  forEachLine,
  numberValue,
  parseJson,
  record,
  stringValue,
} from "./jsonl"
import {
  addDay,
  addTokens,
  countMax,
  localDay,
  percent,
  summarize,
  topEntries,
  type DayBucket,
} from "./shared"
import {
  emptyTokenBreakdown,
  type ProviderUsageReport,
  type UsageInsight,
  type UsageLimit,
  type UsageList,
  type UsageTokenBreakdown,
} from "./types"

/**
 * Codex has no usage command, but it keeps an authoritative index.
 *
 * `~/.codex/state_<n>.sqlite` stores one row per thread with `tokens_used`,
 * which matches the final `total_token_usage.total_tokens` of that thread's
 * rollout exactly. Reading it avoids walking the rollout corpus, which runs
 * to gigabytes (single files past 7 GB) and cannot be read eagerly.
 */

const ROLLOUT_TAIL_BYTES = 512 * 1024
const ROLLOUT_LIMIT_CANDIDATES = 5
/**
 * A thread's last `token_count` carries its running totals, and it sits at the
 * end of the rollout. Reading a tail keeps the corpus (gigabytes, single files
 * past 7 GB) out of the request while still recovering the token split.
 */
const ROLLOUT_USAGE_TAIL_BYTES = 1024 * 1024
const WINDOWS_LONG_PATH_PREFIX = `\\\\?\\`

interface CodexThreadRow {
  id: string
  rollout_path: string | null
  created_at: number | null
  updated_at: number | null
  tokens_used: number | null
  model: string | null
  reasoning_effort: string | null
  cli_version: string | null
  cwd: string | null
}

/** Codex versions its local databases (`state_5.sqlite`); use the newest. */
function newestDatabase(home: string, prefix: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(home)
  } catch {
    return null
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)
  const newest = entries
    .map((name) => pattern.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[0], version: Number(match[1]) }))
    .sort((a, b) => b.version - a.version)
    .at(0)
  return newest ? path.join(home, newest.name) : null
}

/**
 * Summed turn durations per thread — the time Codex actually worked, as
 * opposed to the span between a thread's first and last message, which counts
 * every night a thread sat open.
 */
function readActiveDurations(home: string): Map<string, number> {
  const durations = new Map<string, number>()
  const databasePath = newestDatabase(home, "thread_history")
  if (!databasePath) return durations
  let db: Database.Database
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true })
  } catch {
    return durations
  }
  try {
    const rows = db
      .prepare(
        `SELECT thread_id, SUM(duration_ms) AS ms
         FROM thread_turns WHERE duration_ms IS NOT NULL
         GROUP BY thread_id`
      )
      .all() as Array<{ thread_id: string; ms: number | null }>
    for (const row of rows) durations.set(row.thread_id, numberValue(row.ms))
  } catch {
    return durations
  } finally {
    db.close()
  }
  return durations
}

function readThreads(databasePath: string): CodexThreadRow[] {
  let db: Database.Database
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true })
  } catch {
    return []
  }
  try {
    return db
      .prepare(
        `SELECT id, rollout_path, created_at, updated_at, tokens_used,
                model, reasoning_effort, cli_version, cwd
         FROM threads`
      )
      .all() as CodexThreadRow[]
  } catch {
    return []
  } finally {
    db.close()
  }
}

function localPath(value: string): string {
  return value.startsWith(WINDOWS_LONG_PATH_PREFIX)
    ? value.slice(WINDOWS_LONG_PATH_PREFIX.length)
    : value
}

function windowLabel(minutes: number, fallback: string): string {
  if (minutes === 10_080) return "Weekly limit"
  if (minutes === 300) return "5-hour limit"
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour limit`
  return fallback
}

/** The freshest `rate_limits` block Codex wrote, taken from a tail read. */
async function readRateLimits(rolloutPaths: readonly string[]): Promise<{
  limits: UsageLimit[]
  plan: string | null
}> {
  for (const rollout of rolloutPaths) {
    let latest: Record<string, unknown> | null = null
    await forEachLine(
      rollout,
      (line) => {
        if (line.indexOf('"rate_limits"') < 0) return
        const row = parseJson(line)
        const payload = record(row?.payload)
        const limits = record(payload?.rate_limits)
        if (limits) latest = limits
      },
      { fromEnd: ROLLOUT_TAIL_BYTES }
    )
    if (!latest) continue
    const block = latest as Record<string, unknown>
    const limits: UsageLimit[] = []
    for (const key of ["primary", "secondary"] as const) {
      const window = record(block[key])
      if (!window) continue
      const usedPercent = numberValue(window.used_percent)
      if (!Number.isFinite(usedPercent)) continue
      const resetsAtSeconds = numberValue(window.resets_at)
      const resetsAt =
        resetsAtSeconds > 0
          ? new Date(resetsAtSeconds * 1000).toISOString()
          : null
      limits.push({
        id: key,
        label: windowLabel(
          numberValue(window.window_minutes),
          key === "primary" ? "Primary limit" : "Secondary limit"
        ),
        usedPercent,
        resetsAt,
        resetLabel: null,
      })
    }
    if (limits.length === 0) continue
    return { limits, plan: stringValue(block.plan_type) }
  }
  return { limits: [], plan: null }
}

/**
 * The token split for one thread. Codex counts `cached_input_tokens` inside
 * `input_tokens` and `reasoning_output_tokens` inside `output_tokens`, so the
 * cached share is subtracted out to match how every other provider reports.
 */
async function scanRolloutUsage(file: string): Promise<
  UsageTokenBreakdown & {
    total: number
    /** Carried so a cached entry can still be mapped back to its thread. */
    file: string
  }
> {
  let found: Record<string, unknown> | null = null
  await forEachLine(
    file,
    (line) => {
      if (line.indexOf('"token_count"') < 0) return
      const row = parseJson(line)
      const payload = record(row?.payload)
      if (payload?.type !== "token_count") return
      const total = record(record(payload.info)?.total_token_usage)
      if (total) found = total
    },
    { fromEnd: ROLLOUT_USAGE_TAIL_BYTES }
  )
  const usage = found as Record<string, unknown> | null
  if (!usage) return { ...emptyTokenBreakdown(), total: 0, file }
  const cacheRead = numberValue(usage.cached_input_tokens)
  const input = Math.max(0, numberValue(usage.input_tokens) - cacheRead)
  return {
    input,
    output: numberValue(usage.output_tokens),
    reasoning: numberValue(usage.reasoning_output_tokens),
    cacheRead,
    cacheWrite: numberValue(usage.cache_write_input_tokens),
    total: numberValue(usage.total_tokens),
    file,
  }
}

function projectLabel(cwd: string | null): string | null {
  if (!cwd) return null
  const normalized = localPath(cwd).replace(/[\\/]+$/, "")
  const base = normalized.split(/[\\/]/).filter(Boolean).at(-1)
  return base ?? null
}

export async function collectCodexUsage(options: {
  dataDir: string | null
  refresh: boolean
}): Promise<ProviderUsageReport> {
  const startedAt = Date.now()
  const home = path.join(os.homedir(), ".codex")
  const detected = await detectCodexCliAsync(undefined, {
    isAuthenticated: isCodexCliAuthenticatedAsync,
    authType: "cli",
  })
  const databasePath = newestDatabase(home, "state")
  const threads = databasePath ? readThreads(databasePath) : []
  const activeDurations = readActiveDurations(home)

  const daily = new Map<string, DayBucket>()
  const models = new Map<string, number>()
  const efforts = new Map<string, number>()
  const projects = new Map<string, number>()
  let longestSessionMs = 0
  let totalTokens = 0
  for (const thread of threads) {
    const tokens = numberValue(thread.tokens_used)
    const created = numberValue(thread.created_at)
    if (created > 0) {
      // A thread's tokens land on the day it started: Codex records one
      // running total per thread, not a per-day series.
      addDay(daily, localDay(created * 1000), {
        tokens,
        messages: 0,
        sessions: 1,
      })
    }
    totalTokens += tokens
    const activeMs = activeDurations.get(thread.id)
    if (activeMs !== undefined) {
      longestSessionMs = Math.max(longestSessionMs, activeMs)
    }
    const model = stringValue(thread.model)
    if (model) models.set(model, (models.get(model) ?? 0) + tokens)
    const effort = stringValue(thread.reasoning_effort)
    if (effort) efforts.set(effort, (efforts.get(effort) ?? 0) + 1)
    const project = projectLabel(thread.cwd)
    if (project) projects.set(project, (projects.get(project) ?? 0) + tokens)
  }

  const modelByRollout = new Map<string, string>()
  for (const thread of threads) {
    const model = stringValue(thread.model)
    if (thread.rollout_path && model) {
      modelByRollout.set(localPath(thread.rollout_path), model)
    }
  }
  const rollouts = threads
    .filter((thread) => Boolean(thread.rollout_path))
    .sort((a, b) => numberValue(b.updated_at) - numberValue(a.updated_at))
    .map((thread) => localPath(thread.rollout_path as string))
  const { limits, plan } = await readRateLimits(
    rollouts.slice(0, ROLLOUT_LIMIT_CANDIDATES)
  )

  const split = await scanWithCache({
    dataDir: options.dataDir,
    scope: "codex",
    files: rollouts,
    compute: scanRolloutUsage,
  })
  const tokens = emptyTokenBreakdown()
  const modelTokens = new Map<string, PricedTokens>()
  let splitTotal = 0
  for (const usage of split.values) {
    addTokens(tokens, usage)
    splitTotal += usage.total
    // The split is per rollout; the thread index says which model wrote it.
    const model = modelByRollout.get(usage.file)
    if (!model) continue
    const current = modelTokens.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }
    current.input += usage.input
    current.output += usage.output
    current.cacheRead += usage.cacheRead
    // Codex does not record a TTL for its cache writes.
    current.cacheWrite5m += usage.cacheWrite
    modelTokens.set(model, current)
  }
  const priceBook = new PriceBook(options.dataDir)
  const { pricing, costByModel } = priceModels(priceBook, modelTokens, [
    LONG_CONTEXT_NOTE,
  ])

  const summary = summarize({
    daily,
    tokens,
    totalTokens,
    sessions: threads.length,
    messages: 0,
    longestSessionMs,
  })

  const insights: UsageInsight[] = []
  const effort = countMax(efforts)
  if (effort) {
    insights.push({
      id: "effort",
      label: "Most used reasoning effort",
      value: `${effort.key} · ${percent(effort.share)}`,
    })
  }
  insights.push({
    id: "chats",
    label: "Chats in total",
    value: threads.length.toLocaleString("en-US"),
  })
  if (threads.length > 0) {
    insights.push({
      id: "average",
      label: "Average tokens per chat",
      value: new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(Math.round(totalTokens / threads.length)),
    })
  }
  if (models.size > 0) {
    insights.push({
      id: "models",
      label: "Models used",
      value: models.size.toLocaleString("en-US"),
    })
  }
  const version = detected.version ?? null
  if (plan) {
    insights.push({ id: "plan", label: "Plan", value: plan })
  }

  const lists: UsageList[] = []
  if (projects.size > 0) {
    lists.push({
      id: "projects",
      title: "Busiest projects",
      unit: "tokens",
      entries: topEntries(projects),
    })
  }

  const notes: string[] = [
    "Token totals come from Codex's own thread index, which records one running total per thread — the day a thread started carries its tokens.",
  ]
  const splitCoverage = totalTokens > 0 ? splitTotal / totalTokens : 1
  if (splitTotal > 0 && splitCoverage < 0.95) {
    notes.push(
      `The token split is read from the end of each session log and covers ${percent(splitCoverage)} of those tokens; the rest belongs to logs whose final tally sits further back than the tail that is read.`
    )
  }
  if (!databasePath) {
    notes.push("No Codex thread index was found in ~/.codex.")
  }

  const hasData = threads.length > 0
  return {
    provider: "codex",
    label: "Codex",
    status: hasData ? "ready" : detected.installed ? "partial" : "unavailable",
    installed: detected.installed,
    authenticated: detected.authenticated,
    version,
    plan,
    source: databasePath
      ? `${path.basename(databasePath)} + rollout rate limits`
      : "~/.codex",
    fetchedAt: new Date().toISOString(),
    scannedMs: Date.now() - startedAt,
    summary,
    daily: [...daily.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, bucket]) => ({ date, ...bucket })),
    pricing,
    pricesFile: priceBook.file,
    models: topEntries(models, 8).map((entry) => ({
      ...entry,
      ...(costByModel.has(entry.id) ? { cost: costByModel.get(entry.id) } : {}),
    })),
    insights,
    lists,
    limits,
    limitsObservedAt: null,
    limitNotes: [],
    notes,
  }
}
