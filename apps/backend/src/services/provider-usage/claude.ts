import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectCliAsync, isClaudeCliAuthenticatedAsync } from "../../cli/detect"
import { scanWithCache } from "./cache"
import { commandOutput, runCommand } from "./command"
import {
  forEachLine,
  listJsonlFiles,
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
  PriceBook,
  priceModels,
  tokenTotal,
  type PricedTokens,
} from "./pricing"
import {
  emptyTokenBreakdown,
  type ProviderUsageReport,
  type UsageEntry,
  type UsageInsight,
  type UsageLimit,
  type UsageList,
} from "./types"

/**
 * Claude Code keeps two stores, and the report needs both.
 *
 * `~/.claude/projects/**\/*.jsonl` holds every assistant message with its
 * exact usage, thinking effort, speed and skill/plugin attribution, but the
 * CLI prunes old transcripts. `~/.claude/stats-cache.json` keeps the long
 * daily history that pruning already removed. Transcripts win wherever they
 * reach; the stats cache fills the days before them.
 */

const LIMITS_TTL_MS = 60_000
const LIMITS_CACHE_FILE = "usage-limits-cache.json"
/** Longer than this between two messages and the session was idle, not busy. */
const SESSION_IDLE_GAP_MS = 30 * 60_000

/** `[tokens, messages, input, output, reasoning, cacheRead, cacheWrite]` */
type FileDay = [number, number, number, number, number, number, number]
type FileDays = Record<string, FileDay>
type FileSessions = Record<
  string,
  [first: number, last: number, messages: number, activeMs: number]
>

/** `[input, output, cacheRead, cacheWrite5m, cacheWrite1h]` per model. */
type FileModelTokens = [number, number, number, number, number]

interface ClaudeFileAggregate {
  days: FileDays
  /**
   * Per model per day, so a day the stats cache has not folded in yet can be
   * added to the all-time totals — and priced, which needs the split.
   */
  dayModels: Record<string, Record<string, FileModelTokens>>
  efforts: Record<string, number>
  speeds: Record<string, number>
  skills: Record<string, number>
  plugins: Record<string, number>
  sessions: FileSessions
  messages: number
}

interface ModelTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ClaudeStatsCache {
  lastComputedDate: string | null
  dailyActivity: Array<{ date: string; messages: number; sessions: number }>
  dailyModelTokens: Array<{
    date: string
    tokensByModel: Record<string, number>
  }>
  /** All-time totals per model, which outlive the pruned transcripts. */
  modelUsage: Record<string, ModelTokens>
  totalSessions: number
}

let cachedLimits: LimitsReport | null = null

function bump(
  target: Record<string, number>,
  key: string | null,
  by = 1
): void {
  if (!key) return
  target[key] = (target[key] ?? 0) + by
}

async function scanTranscript(file: string): Promise<ClaudeFileAggregate> {
  const aggregate: ClaudeFileAggregate = {
    days: {},
    dayModels: {},
    efforts: {},
    speeds: {},
    skills: {},
    plugins: {},
    sessions: {},
    messages: 0,
  }
  const lastSeen = new Map<string, number>()
  await forEachLine(file, (line) => {
    // Cheap reject first: assistant rows are the only ones carrying usage.
    if (line.length < 40 || line.indexOf('"type":"assistant"') < 0) return
    const row = parseJson(line)
    if (!row || row.type !== "assistant") return
    const message = record(row.message)
    if (!message) return
    const usage = record(message.usage)
    if (!usage) return
    const input = numberValue(usage.input_tokens)
    const output = numberValue(usage.output_tokens)
    const cacheRead = numberValue(usage.cache_read_input_tokens)
    const cacheWrite = numberValue(usage.cache_creation_input_tokens)
    // Writes are billed per TTL: 1.25x for five minutes, 2x for an hour.
    const creation = record(usage.cache_creation)
    const write1h = numberValue(creation?.ephemeral_1h_input_tokens)
    const write5m = creation
      ? numberValue(creation.ephemeral_5m_input_tokens)
      : cacheWrite
    const reasoning = numberValue(
      record(usage.output_tokens_details)?.thinking_tokens
    )
    const total = input + output + cacheRead + cacheWrite
    aggregate.messages += 1

    const timestamp = stringValue(row.timestamp)
    const stamp = timestamp ? Date.parse(timestamp) : Number.NaN
    const model = stringValue(message.model)
    if (Number.isFinite(stamp)) {
      const day = localDay(stamp)
      const bucket = aggregate.days[day] ?? [0, 0, 0, 0, 0, 0, 0]
      bucket[0] += total
      bucket[1] += 1
      bucket[2] += input
      bucket[3] += output
      bucket[4] += reasoning
      bucket[5] += cacheRead
      bucket[6] += cacheWrite
      aggregate.days[day] = bucket
      if (model && model !== "<synthetic>") {
        const byModel = aggregate.dayModels[day] ?? {}
        const entry = byModel[model] ?? [0, 0, 0, 0, 0]
        entry[0] += input
        entry[1] += output
        entry[2] += cacheRead
        entry[3] += write5m
        entry[4] += write1h
        byModel[model] = entry
        aggregate.dayModels[day] = byModel
      }
    }

    bump(aggregate.efforts, stringValue(row.effort))
    bump(aggregate.speeds, stringValue(usage.speed))
    bump(aggregate.skills, stringValue(row.attributionSkill))
    bump(aggregate.plugins, stringValue(row.attributionPlugin))

    const sessionId = stringValue(row.sessionId)
    if (sessionId && Number.isFinite(stamp)) {
      const session = aggregate.sessions[sessionId] ?? [stamp, stamp, 0, 0]
      if (stamp < session[0]) session[0] = stamp
      if (stamp > session[1]) session[1] = stamp
      session[2] += 1
      // Active time, not wall clock: a chat resumed a week later would
      // otherwise report the week as its length.
      const previous = lastSeen.get(sessionId)
      if (previous !== undefined) {
        const gap = stamp - previous
        if (gap > 0 && gap <= SESSION_IDLE_GAP_MS) session[3] += gap
      }
      lastSeen.set(sessionId, stamp)
      aggregate.sessions[sessionId] = session
    }
  })
  return aggregate
}

function readStatsCache(home: string): ClaudeStatsCache | null {
  let parsed: Record<string, unknown> | null
  try {
    parsed = record(
      JSON.parse(fs.readFileSync(path.join(home, "stats-cache.json"), "utf8"))
    )
  } catch {
    return null
  }
  if (!parsed) return null
  const dailyActivity: ClaudeStatsCache["dailyActivity"] = []
  if (Array.isArray(parsed.dailyActivity)) {
    for (const item of parsed.dailyActivity) {
      const entry = record(item)
      const date = stringValue(entry?.date)
      if (!date) continue
      dailyActivity.push({
        date,
        messages: numberValue(entry?.messageCount),
        sessions: numberValue(entry?.sessionCount),
      })
    }
  }
  const dailyModelTokens: ClaudeStatsCache["dailyModelTokens"] = []
  if (Array.isArray(parsed.dailyModelTokens)) {
    for (const item of parsed.dailyModelTokens) {
      const entry = record(item)
      const date = stringValue(entry?.date)
      const byModel = record(entry?.tokensByModel)
      if (!date || !byModel) continue
      const tokensByModel: Record<string, number> = {}
      for (const [model, value] of Object.entries(byModel)) {
        tokensByModel[model] = numberValue(value)
      }
      dailyModelTokens.push({ date, tokensByModel })
    }
  }
  const modelUsage: Record<string, ModelTokens> = {}
  const rawModels = record(parsed.modelUsage)
  if (rawModels) {
    for (const [model, value] of Object.entries(rawModels)) {
      const usage = record(value)
      if (!usage) continue
      modelUsage[model] = {
        input: numberValue(usage.inputTokens),
        output: numberValue(usage.outputTokens),
        cacheRead: numberValue(usage.cacheReadInputTokens),
        cacheWrite: numberValue(usage.cacheCreationInputTokens),
      }
    }
  }
  return {
    lastComputedDate: stringValue(parsed.lastComputedDate),
    dailyActivity,
    dailyModelTokens,
    modelUsage,
    totalSessions: numberValue(parsed.totalSessions),
  }
}

/** `Current week (all models): 81% used · resets Sep 22, 4pm (Europe/Berlin)` */
export function parseLimits(raw: string): {
  limits: UsageLimit[]
  plan: string | null
  contributions: string[]
} {
  const limits: UsageLimit[] = []
  let plan: string | null = null
  const contributions: string[] = []
  let inContributions = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^What's contributing/i.test(trimmed)) {
      inContributions = true
      continue
    }
    if (inContributions) {
      // Kept with its indentation: the CLI nests details under each window.
      contributions.push(line.replace(/\s+$/, ""))
      continue
    }
    const match = /^(.+?):\s*([\d.]+)%\s*used\b\s*(?:[^\w\s]\s*)?(.*)$/.exec(
      trimmed
    )
    if (match) {
      const usedPercent = Number(match[2])
      if (Number.isFinite(usedPercent)) {
        limits.push({
          id: match[1],
          label: match[1],
          usedPercent,
          resetsAt: null,
          resetLabel: match[3] ? match[3].trim() : null,
        })
      }
      continue
    }
    // The CLI states the plan as a sentence; the page wants a chip.
    if (plan) continue
    if (/subscription/i.test(trimmed)) plan = "Subscription"
    else if (/api|credit/i.test(trimmed)) plan = "API credits"
  }
  return { limits, plan, contributions }
}

interface LimitsReport {
  at: number
  limits: UsageLimit[]
  plan: string | null
  contributions: string[]
}

function limitsCachePath(dataDir: string): string {
  return path.join(dataDir, LIMITS_CACHE_FILE)
}

function readPersistedLimits(dataDir: string | null): LimitsReport | null {
  if (!dataDir) return null
  try {
    const parsed = record(
      JSON.parse(fs.readFileSync(limitsCachePath(dataDir), "utf8"))
    )
    if (!parsed || !Array.isArray(parsed.limits)) return null
    return {
      at: numberValue(parsed.at),
      limits: parsed.limits as UsageLimit[],
      plan: stringValue(parsed.plan),
      contributions: Array.isArray(parsed.contributions)
        ? (parsed.contributions as string[])
        : [],
    }
  } catch {
    return null
  }
}

function writePersistedLimits(
  dataDir: string | null,
  report: LimitsReport
): void {
  if (!dataDir) return
  try {
    fs.writeFileSync(limitsCachePath(dataDir), JSON.stringify(report), "utf8")
  } catch {
    // The report is still correct without a persisted copy.
  }
}

/** Serialises refreshes so overlapping page loads spawn the CLI once. */
let limitsRefresh: Promise<LimitsReport> | null = null

async function fetchLimits(
  binaryPath: string,
  dataDir: string | null
): Promise<LimitsReport> {
  // `/usage` is handled inside the CLI and never reaches a model, so this is
  // a local report rather than a billed request.
  const result = await runCommand(binaryPath, [
    "-p",
    "/usage",
    "--output-format",
    "text",
    "--no-session-persistence",
  ])
  const parsed = parseLimits(commandOutput(result))
  const report: LimitsReport = { at: Date.now(), ...parsed }
  if (parsed.limits.length > 0) {
    cachedLimits = report
    writePersistedLimits(dataDir, report)
  }
  return report
}

/**
 * Reading the limits costs a CLI round trip of several seconds, which is
 * most of what a page load used to wait for. A stored copy is served right
 * away and a refresh runs behind the request, so only the very first load on
 * a machine pays that wait.
 */
async function loadLimits(
  binaryPath: string,
  dataDir: string | null,
  refresh: boolean
): Promise<LimitsReport> {
  const known = cachedLimits ?? readPersistedLimits(dataDir)
  if (known) cachedLimits = known
  const fresh = known !== null && Date.now() - known.at < LIMITS_TTL_MS

  if (refresh || (!known && !limitsRefresh)) {
    limitsRefresh ??= fetchLimits(binaryPath, dataDir).finally(() => {
      limitsRefresh = null
    })
    return limitsRefresh
  }
  if (!fresh && !limitsRefresh) {
    limitsRefresh = fetchLimits(binaryPath, dataDir).finally(() => {
      limitsRefresh = null
    })
    // Deliberately not awaited: the stored copy answers this request.
    limitsRefresh.catch(() => {})
  }
  return known ?? { at: 0, limits: [], plan: null, contributions: [] }
}

export async function collectClaudeUsage(options: {
  dataDir: string | null
  refresh: boolean
}): Promise<ProviderUsageReport> {
  const startedAt = Date.now()
  const home = path.join(os.homedir(), ".claude")
  const detected = await detectCliAsync("claude", {
    isAuthenticated: isClaudeCliAuthenticatedAsync,
    authType: "cli",
  })
  const files = await listJsonlFiles(path.join(home, "projects"))
  const scan = await scanWithCache<ClaudeFileAggregate>({
    dataDir: options.dataDir,
    scope: "claude",
    files,
    compute: scanTranscript,
  })

  const daily = new Map<string, DayBucket>()
  const transcriptDayTokens = new Map<string, ModelTokens>()
  const transcriptDayModels = new Map<string, Record<string, FileModelTokens>>()
  const efforts = new Map<string, number>()
  const speeds = new Map<string, number>()
  const skills = new Map<string, number>()
  const plugins = new Map<string, number>()
  const sessions = new Map<string, [number, number, number, number]>()
  let messages = 0
  const merge = (
    target: Map<string, number>,
    source: Record<string, number>
  ) => {
    for (const [key, value] of Object.entries(source)) {
      target.set(key, (target.get(key) ?? 0) + value)
    }
  }
  for (const aggregate of scan.values) {
    for (const [date, day] of Object.entries(aggregate.days)) {
      addDay(daily, date, { tokens: day[0], messages: day[1] })
      const components = transcriptDayTokens.get(date) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }
      components.input += day[2]
      components.output += day[3]
      components.cacheRead += day[5]
      components.cacheWrite += day[6]
      transcriptDayTokens.set(date, components)
    }
    for (const [date, byModel] of Object.entries(aggregate.dayModels)) {
      const current = transcriptDayModels.get(date) ?? {}
      for (const [model, value] of Object.entries(byModel)) {
        const entry = current[model] ?? [0, 0, 0, 0, 0]
        for (let index = 0; index < entry.length; index += 1) {
          entry[index] += value[index] ?? 0
        }
        current[model] = entry
      }
      transcriptDayModels.set(date, current)
    }
    merge(efforts, aggregate.efforts)
    merge(speeds, aggregate.speeds)
    merge(skills, aggregate.skills)
    merge(plugins, aggregate.plugins)
    for (const [id, session] of Object.entries(aggregate.sessions)) {
      const current = sessions.get(id)
      if (!current) sessions.set(id, [...session])
      else {
        current[0] = Math.min(current[0], session[0])
        current[1] = Math.max(current[1], session[1])
        current[2] += session[2]
        current[3] += session[3]
      }
    }
    messages += aggregate.messages
  }

  const transcriptDays = new Set(daily.keys())
  let longestSessionMs = 0
  let reasoning = 0
  for (const aggregate of scan.values) {
    for (const day of Object.values(aggregate.days)) reasoning += day[4]
  }
  for (const [, session] of sessions) {
    if (session[3] > longestSessionMs) longestSessionMs = session[3]
    addDay(daily, localDay(session[0]), { sessions: 1 })
  }

  const notes: string[] = []
  const stats = readStatsCache(home)
  const modelTokens = new Map<string, PricedTokens>()
  const addModel = (model: string, add: Partial<PricedTokens>) => {
    const current = modelTokens.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }
    current.input += add.input ?? 0
    current.output += add.output ?? 0
    current.cacheRead += add.cacheRead ?? 0
    current.cacheWrite5m += add.cacheWrite5m ?? 0
    current.cacheWrite1h += add.cacheWrite1h ?? 0
    modelTokens.set(model, current)
  }
  // The share of cache writes taken at the 1-hour TTL, measured on the
  // transcripts. The stats cache records a single cache-write figure, so the
  // older days are split by this ratio rather than guessed at one rate.
  let observed5m = 0
  let observed1h = 0
  for (const byModel of transcriptDayModels.values()) {
    for (const entry of Object.values(byModel)) {
      observed5m += entry[3]
      observed1h += entry[4]
    }
  }
  const ratio1h =
    observed5m + observed1h > 0 ? observed1h / (observed5m + observed1h) : 0

  const addTranscriptDays = (after: string | null) => {
    for (const [date, byModel] of transcriptDayModels) {
      if (after !== null && date <= after) continue
      for (const [model, entry] of Object.entries(byModel)) {
        addModel(model, {
          input: entry[0],
          output: entry[1],
          cacheRead: entry[2],
          cacheWrite5m: entry[3],
          cacheWrite1h: entry[4],
        })
      }
    }
  }

  if (stats) {
    // `modelUsage` is the only all-time record: Claude prunes transcripts and
    // `dailyModelTokens` reaches back a few months at most. Totals therefore
    // start from it and add only the transcript days it has not seen yet.
    const cutoff = stats.lastComputedDate ?? ""
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      addModel(model, {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite5m: usage.cacheWrite * (1 - ratio1h),
        cacheWrite1h: usage.cacheWrite * ratio1h,
      })
    }
    addTranscriptDays(cutoff)
    // Days the CLI has already pruned: tokens per model where the cache has
    // them, message and session counts for everything older.
    for (const entry of stats.dailyModelTokens) {
      if (transcriptDays.has(entry.date)) continue
      let dayTokens = 0
      for (const value of Object.values(entry.tokensByModel)) dayTokens += value
      addDay(daily, entry.date, { tokens: dayTokens })
    }
    for (const entry of stats.dailyActivity) {
      if (transcriptDays.has(entry.date)) continue
      addDay(daily, entry.date, { messages: 0, sessions: entry.sessions })
    }
  } else {
    addTranscriptDays(null)
  }

  const models = new Map<string, number>()
  const tokens = emptyTokenBreakdown()
  tokens.reasoning = reasoning
  for (const [model, entry] of modelTokens) {
    models.set(model, tokenTotal(entry))
    addTokens(tokens, {
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite5m + entry.cacheWrite1h,
    })
  }

  const priceBook = new PriceBook(options.dataDir)
  const priceNotes: string[] = []
  if (stats && observed1h > 0) {
    priceNotes.push(
      `Cache writes older than the retained transcripts are split at the ratio measured on them (${percent(ratio1h)} at the 1-hour rate), because Claude's stats cache records one combined figure.`
    )
  }
  const { pricing, costByModel } = priceModels(
    priceBook,
    modelTokens,
    priceNotes
  )

  const totalTokens =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  const sessionCount = Math.max(sessions.size, stats?.totalSessions ?? 0)
  const summary = summarize({
    daily,
    tokens,
    totalTokens,
    sessions: sessionCount,
    messages,
    longestSessionMs,
  })

  const firstTokenDay =
    [...daily.entries()]
      .filter(([, bucket]) => bucket.tokens > 0)
      .map(([date]) => date)
      .sort()
      .at(0) ?? null
  if (
    firstTokenDay &&
    summary.firstActivity &&
    summary.firstActivity < firstTokenDay
  ) {
    notes.push(
      `Totals cover all time from Claude's own model totals. The chart starts ${firstTokenDay}, because Claude keeps a per-day token series for recent months only — earlier days show activity without tokens.`
    )
  }
  const oldestTranscript = [...transcriptDays].sort().at(0) ?? null
  if (oldestTranscript) {
    notes.push(
      `Exact per-message data (thinking effort, skills, plugins, token split) covers the transcripts still on disk, from ${oldestTranscript}.`
    )
  }

  const insights: UsageInsight[] = []
  const fast = speeds.get("fast") ?? 0
  const speedTotal = [...speeds.values()].reduce((sum, value) => sum + value, 0)
  if (speedTotal > 0) {
    insights.push({
      id: "fast-mode",
      label: "Fast mode",
      value: percent(fast / speedTotal),
    })
  }
  const effort = countMax(efforts)
  if (effort) {
    insights.push({
      id: "effort",
      label: "Most used thinking effort",
      value: `${effort.key} · ${percent(effort.share)}`,
    })
  }
  if (skills.size > 0) {
    insights.push({
      id: "skills-distinct",
      label: "Skills discovered",
      value: skills.size.toLocaleString("en-US"),
    })
    insights.push({
      id: "skills-total",
      label: "Skills used in total",
      value: [...skills.values()]
        .reduce((sum, value) => sum + value, 0)
        .toLocaleString("en-US"),
    })
  }
  insights.push({
    id: "chats",
    label: "Chats in total",
    value: sessionCount.toLocaleString("en-US"),
  })

  const lists: UsageList[] = []
  if (plugins.size > 0) {
    lists.push({
      id: "plugins",
      title: "Most used plugins",
      unit: "runs",
      entries: topEntries(plugins),
    })
  }
  if (skills.size > 0) {
    lists.push({
      id: "skills",
      title: "Most used skills",
      unit: "runs",
      entries: topEntries(skills),
    })
  }

  let limits: UsageLimit[] = []
  let limitNotes: string[] = []
  let plan: string | null = null
  let limitsObservedAt: string | null = null
  if (detected.installed) {
    const report = await loadLimits(
      detected.binaryPath,
      options.dataDir,
      options.refresh
    )
    limits = report.limits
    plan = report.plan
    limitNotes = report.contributions
    if (report.at > 0) limitsObservedAt = new Date(report.at).toISOString()
  }

  const modelEntries: UsageEntry[] = topEntries(models, 8).map((entry) => ({
    ...entry,
    label: entry.id,
    ...(costByModel.has(entry.id) ? { cost: costByModel.get(entry.id) } : {}),
  }))

  const hasData = summary.totalTokens > 0 || summary.activeDays > 0
  return {
    provider: "claude",
    label: "Claude Code",
    status: hasData ? "ready" : detected.installed ? "partial" : "unavailable",
    installed: detected.installed,
    authenticated: detected.authenticated,
    version: detected.version,
    plan,
    source: "~/.claude transcripts + stats cache + claude /usage",
    fetchedAt: new Date().toISOString(),
    scannedMs: Date.now() - startedAt,
    summary,
    daily: [...daily.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, bucket]) => ({ date, ...bucket })),
    pricing,
    pricesFile: priceBook.file,
    models: modelEntries,
    insights,
    lists,
    limits,
    limitsObservedAt,
    limitNotes,
    notes,
  }
}
