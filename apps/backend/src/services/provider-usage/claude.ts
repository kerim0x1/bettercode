import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectCliAsync, isClaudeCliAuthenticatedAsync } from "../../cli/detect"
import { scanAppendOnlyWithCache, type AppendScan } from "./cache"
import { commandOutput, runCommand } from "./command"
import {
  forEachMatchingLine,
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
  modelLabel,
  percent,
  summarize,
  topEntries,
  type DayBucket,
} from "./shared"
import {
  PriceBook,
  normalizeModelId,
  priceModels,
  dayCost,
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
/**
 * The transcript aggregate's format. 1: a message written as several rows is
 * counted once. 2: every row is also summed, as Claude's stats cache does.
 */
const TRANSCRIPT_CACHE_REVISION = 2
/** Full days before the stats cache's last one that test how it counts. */
const STATS_CHECK_DAYS = 7
/** Fewer row tokens than this and a model's own factor is noise. */
const MIN_OWN_SCALE_TOKENS = 10_000_000
/** Every row that can carry usage has it; the scan decodes no other line. */
const ASSISTANT_ROW_MARKER = '"type":"assistant"'

/** `[tokens, messages, input, output, reasoning, cacheRead, cacheWrite]` */
type FileDay = [number, number, number, number, number, number, number]
type FileDays = Record<string, FileDay>
type FileSessions = Record<
  string,
  [first: number, last: number, messages: number, activeMs: number]
>

/** `[input, output, cacheRead, cacheWrite5m, cacheWrite1h]` per model. */
type FileModelTokens = [number, number, number, number, number]
/** `[input, output, cacheRead, cacheWrite]` */
type RowTokens = [number, number, number, number]

/**
 * The message the last counted row belonged to, kept with the aggregate so a
 * resumed scan still recognises its further rows.
 */
type LastMessage = [
  key: string,
  day: string | null,
  model: string | null,
  output: number,
  reasoning: number,
]

export interface ClaudeFileAggregate {
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
  last?: LastMessage
  /**
   * Every row's usage per model, repeats included, the way Claude's own stats
   * cache counts it; compared with the counted replies to correct that cache.
   */
  rowModels?: Record<string, RowTokens>
  /** The same per day, all models together. */
  rowDays?: Record<string, number>
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
/** The CLI the last report found, which `readClaudeLimits` asks. */
let claudeBinaryPath: string | null = null

function bump(
  target: Record<string, number>,
  key: string | null,
  by = 1
): void {
  if (!key) return
  target[key] = (target[key] ?? 0) + by
}

/**
 * Adds a transcript's assistant messages to an aggregate, from the start or,
 * for a transcript that only grew, from where the last scan stopped.
 *
 * Claude Code writes one row per content block of a reply (thinking, text,
 * each tool call), and every row repeats the reply's usage. The rows follow
 * each other, and only `output_tokens` grows while the reply streams, so a
 * reply is counted once and its later rows add only the output it gained.
 */
export async function scanClaudeTranscript(
  file: string,
  from: AppendScan<ClaudeFileAggregate> | null
): Promise<AppendScan<ClaudeFileAggregate> | null> {
  const aggregate: ClaudeFileAggregate = from?.value ?? {
    days: {},
    dayModels: {},
    efforts: {},
    speeds: {},
    skills: {},
    plugins: {},
    sessions: {},
    messages: 0,
  }
  // Transcripts are chronological, so a resumed scan measures each session's
  // next gap from its latest message.
  const lastSeen = new Map<string, number>(
    Object.entries(aggregate.sessions).map(([id, session]) => [id, session[1]])
  )
  const offset = await forEachMatchingLine(
    file,
    ASSISTANT_ROW_MARKER,
    (line) => {
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
      const timestamp = stringValue(row.timestamp)
      const stamp = timestamp ? Date.parse(timestamp) : Number.NaN
      const model = stringValue(message.model)
      const day = Number.isFinite(stamp) ? localDay(stamp) : null
      if (day !== null && model && model !== "<synthetic>") {
        const rows = (aggregate.rowModels ??= {})
        const counted = (rows[model] ??= [0, 0, 0, 0])
        counted[0] += input
        counted[1] += output
        counted[2] += cacheRead
        counted[3] += cacheWrite
        const rowDays = (aggregate.rowDays ??= {})
        rowDays[day] = (rowDays[day] ?? 0) + total
      }

      const messageId = stringValue(message.id)
      const key = messageId
        ? `${messageId}:${stringValue(row.requestId) ?? ""}`
        : null
      const last = aggregate.last
      if (key !== null && last !== undefined && last[0] === key) {
        addReplyGrowth(aggregate, last, output, reasoning)
        return
      }
      aggregate.messages += 1

      if (key !== null) {
        aggregate.last = [
          key,
          day,
          model && model !== "<synthetic>" ? model : null,
          output,
          reasoning,
        ]
      } else {
        delete aggregate.last
      }
      if (day !== null) {
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
    },
    { from: from?.offset ?? 0, completeLinesOnly: true }
  )
  return offset === null ? null : { value: aggregate, offset }
}

/** Output a reply gained since its previous row, on that reply's day. */
function addReplyGrowth(
  aggregate: ClaudeFileAggregate,
  last: LastMessage,
  output: number,
  reasoning: number
): void {
  const extraOutput = Math.max(0, output - last[3])
  const extraReasoning = Math.max(0, reasoning - last[4])
  if (extraOutput === 0 && extraReasoning === 0) return
  last[3] += extraOutput
  last[4] += extraReasoning
  const [, day, model] = last
  if (day === null) return
  const bucket = aggregate.days[day]
  if (bucket) {
    bucket[0] += extraOutput
    bucket[3] += extraOutput
    bucket[4] += extraReasoning
  }
  const entry = model ? aggregate.dayModels[day]?.[model] : undefined
  if (entry) entry[1] += extraOutput
}

const UNSCALED: ModelTokens = {
  input: 1,
  output: 1,
  cacheRead: 1,
  cacheWrite: 1,
}

function emptyModelTokens(): ModelTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function addModelTokens(target: ModelTokens, add: ModelTokens): void {
  target.input += add.input
  target.output += add.output
  target.cacheRead += add.cacheRead
  target.cacheWrite += add.cacheWrite
}

function addModelTokensTo(
  target: Map<string, ModelTokens>,
  model: string,
  add: ModelTokens
): void {
  const current = target.get(model) ?? emptyModelTokens()
  addModelTokens(current, add)
  target.set(model, current)
}

function modelTokensTotal(tokens: ModelTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

export interface StatsScale {
  /** Reply tokens per counted row token, by token type. */
  forModel(model: string): ModelTokens
  /** The same for a day's single total. */
  forDayTotal(model: string): number
  /** Rows counted per reply token, over all models. */
  rowsPerReply: number
}

/**
 * How far Claude's stats cache overcounts, or null when it doesn't.
 *
 * Claude Code sums every transcript row into `stats-cache.json`, and a reply
 * is written as one row per part, each repeating its usage. The transcripts
 * carry both counts, so their ratio corrects the stats for days whose
 * transcripts are gone: per model and token type where a model has enough
 * rows, pooled otherwise. The last full days both cover decide first whether
 * the cache counts rows at all, so a cache that counts replies is left as it
 * is.
 */
export function measureStatsScale(
  aggregates: readonly ClaudeFileAggregate[],
  stats: Pick<ClaudeStatsCache, "lastComputedDate" | "dailyModelTokens">
): StatsScale | null {
  const rows = new Map<string, ModelTokens>()
  const replies = new Map<string, ModelTokens>()
  const rowDays = new Map<string, number>()
  const replyDays = new Map<string, number>()
  for (const aggregate of aggregates) {
    for (const [model, row] of Object.entries(aggregate.rowModels ?? {})) {
      addModelTokensTo(rows, normalizeModelId(model), {
        input: row[0],
        output: row[1],
        cacheRead: row[2],
        cacheWrite: row[3],
      })
    }
    for (const byModel of Object.values(aggregate.dayModels)) {
      for (const [model, entry] of Object.entries(byModel)) {
        addModelTokensTo(replies, normalizeModelId(model), {
          input: entry[0],
          output: entry[1],
          cacheRead: entry[2],
          cacheWrite: entry[3] + entry[4],
        })
      }
    }
    for (const [day, total] of Object.entries(aggregate.rowDays ?? {})) {
      rowDays.set(day, (rowDays.get(day) ?? 0) + total)
    }
    for (const [day, bucket] of Object.entries(aggregate.days)) {
      replyDays.set(day, (replyDays.get(day) ?? 0) + bucket[0])
    }
  }

  // The cache's last day is usually cut off where it was computed.
  const cutoff = stats.lastComputedDate ?? ""
  const checked = stats.dailyModelTokens
    .filter((entry) => entry.date < cutoff && rowDays.has(entry.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-STATS_CHECK_DAYS)
  let statsSum = 0
  let rowSum = 0
  let replySum = 0
  for (const entry of checked) {
    for (const value of Object.values(entry.tokensByModel)) statsSum += value
    rowSum += rowDays.get(entry.date) ?? 0
    replySum += replyDays.get(entry.date) ?? 0
  }
  if (statsSum <= 0 || replySum <= 0 || rowSum <= replySum) return null
  // Whichever of the two counts the cache is closer to, as a ratio.
  if (
    Math.abs(Math.log(statsSum / rowSum)) >=
    Math.abs(Math.log(statsSum / replySum))
  ) {
    return null
  }

  const share = (reply: number, row: number, fallback: number) =>
    row > 0 ? Math.min(1, reply / row) : fallback
  const factors = (
    reply: ModelTokens,
    row: ModelTokens,
    fallback: ModelTokens
  ): ModelTokens => ({
    input: share(reply.input, row.input, fallback.input),
    output: share(reply.output, row.output, fallback.output),
    cacheRead: share(reply.cacheRead, row.cacheRead, fallback.cacheRead),
    cacheWrite: share(reply.cacheWrite, row.cacheWrite, fallback.cacheWrite),
  })
  const pooledRows = emptyModelTokens()
  const pooledReplies = emptyModelTokens()
  for (const tokens of rows.values()) addModelTokens(pooledRows, tokens)
  for (const tokens of replies.values()) addModelTokens(pooledReplies, tokens)
  const pooled = factors(pooledReplies, pooledRows, UNSCALED)
  const pooledTotal = share(
    modelTokensTotal(pooledReplies),
    modelTokensTotal(pooledRows),
    1
  )
  const own = (model: string) => {
    const id = normalizeModelId(model)
    const row = rows.get(id)
    const reply = replies.get(id)
    return row && reply && modelTokensTotal(row) >= MIN_OWN_SCALE_TOKENS
      ? { row, reply }
      : null
  }
  return {
    forModel(model) {
      const found = own(model)
      return found ? factors(found.reply, found.row, pooled) : pooled
    },
    forDayTotal(model) {
      const found = own(model)
      return found
        ? share(
            modelTokensTotal(found.reply),
            modelTokensTotal(found.row),
            pooledTotal
          )
        : pooledTotal
    },
    rowsPerReply: pooledTotal > 0 ? 1 / pooledTotal : 1,
  }
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
/** When the CLI was last asked, so a failing read isn't repeated on every poll. */
let limitsAttemptAt = 0

async function fetchLimits(
  binaryPath: string,
  dataDir: string | null
): Promise<LimitsReport> {
  // `/usage` is handled inside the CLI and never reaches a model, so this is
  // a local report rather than a billed request. `--strict-mcp-config` with
  // no config starts none of the user's MCP servers, which `/usage` never
  // needs.
  const result = await runCommand(binaryPath, [
    "-p",
    "/usage",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--strict-mcp-config",
  ])
  const parsed = parseLimits(commandOutput(result))
  const report: LimitsReport = { at: Date.now(), ...parsed }
  if (parsed.limits.length > 0) {
    cachedLimits = report
    writePersistedLimits(dataDir, report)
  }
  return report
}

interface ClaudeLimitsReading extends LimitsReport {
  /** A newer reading is being taken; ask again shortly. */
  refreshing: boolean
}

/**
 * The limits `claude /usage` printed last, without waiting for the CLI.
 *
 * Starting the CLI takes seconds, and the page used to wait for it on every
 * Refresh and on the first load. A reading older than a minute, or any
 * reading when `refresh` is set, starts a new one behind the request instead,
 * and `refreshing` tells the caller to ask again. A failed reading is retried
 * after a minute, not on the next request.
 */
function readClaudeLimits(options: {
  dataDir: string | null
  refresh: boolean
}): ClaudeLimitsReading {
  const known = cachedLimits ?? readPersistedLimits(options.dataDir)
  if (known) cachedLimits = known
  const now = Date.now()
  const due =
    options.refresh ||
    ((known === null || now - known.at >= LIMITS_TTL_MS) &&
      now - limitsAttemptAt >= LIMITS_TTL_MS)
  if (due && !limitsRefresh && claudeBinaryPath) {
    limitsAttemptAt = now
    limitsRefresh = fetchLimits(claudeBinaryPath, options.dataDir).finally(
      () => {
        limitsRefresh = null
      }
    )
    // Deliberately not awaited: the stored reading answers this request.
    limitsRefresh.catch(() => {})
  }
  return {
    ...(known ?? { at: 0, limits: [], plan: null, contributions: [] }),
    refreshing: limitsRefresh !== null,
  }
}

/**
 * A Claude report with the current `/usage` reading. Reports are kept for a
 * while and restored after a restart, but limits move faster, so they are
 * added to each answer instead of being stored with the report.
 */
export function withClaudeLimits(
  report: ProviderUsageReport,
  options: { dataDir: string | null; refresh: boolean }
): ProviderUsageReport {
  if (!report.installed) return report
  const reading = readClaudeLimits(options)
  return {
    ...report,
    plan: reading.plan,
    limits: reading.limits,
    limitNotes: reading.contributions,
    limitsObservedAt:
      reading.at > 0 ? new Date(reading.at).toISOString() : null,
    ...(reading.refreshing ? { refreshing: true } : {}),
  }
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
  claudeBinaryPath = detected.installed ? detected.binaryPath : null
  const files = await listJsonlFiles(path.join(home, "projects"))
  const scan = await scanAppendOnlyWithCache<ClaudeFileAggregate>({
    dataDir: options.dataDir,
    scope: "claude",
    revision: TRANSCRIPT_CACHE_REVISION,
    files,
    scan: scanClaudeTranscript,
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
  const addModel = (id: string, add: Partial<PricedTokens>) => {
    // A dated id (`claude-haiku-4-5-20251001`) is the same model as its alias.
    const model = normalizeModelId(id)
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
    const scale = measureStatsScale(scan.values, stats)
    if (scale) {
      notes.push(
        `Claude Code's own stats cache counts a reply once for each of its parts (thinking, text, every tool call); on the transcripts here that is ${scale.rowsPerReply.toFixed(1)}× the real usage. Totals and days older than the transcripts on disk are scaled down by the factor measured on them for each model; the days the transcripts cover are counted exactly.`
      )
    }
    for (const [model, usage] of Object.entries(stats.modelUsage)) {
      const factor = scale?.forModel(model) ?? UNSCALED
      const cacheWrite = usage.cacheWrite * factor.cacheWrite
      addModel(model, {
        input: Math.round(usage.input * factor.input),
        output: Math.round(usage.output * factor.output),
        cacheRead: Math.round(usage.cacheRead * factor.cacheRead),
        cacheWrite5m: Math.round(cacheWrite * (1 - ratio1h)),
        cacheWrite1h: Math.round(cacheWrite * ratio1h),
      })
    }
    addTranscriptDays(cutoff)
    // Days the CLI has already pruned: tokens per model where the cache has
    // them, message and session counts for everything older.
    for (const entry of stats.dailyModelTokens) {
      if (transcriptDays.has(entry.date)) continue
      let dayTokens = 0
      for (const [model, value] of Object.entries(entry.tokensByModel)) {
        dayTokens += value * (scale?.forDayTotal(model) ?? 1)
      }
      addDay(daily, entry.date, { tokens: Math.round(dayTokens) })
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
  // A day's cost where the transcripts split its tokens by model. Days only
  // the stats cache remembers carry one total per model, which can't be
  // priced, so they stay without a cost instead of a guess.
  for (const [date, byModel] of transcriptDayModels) {
    const cost = dayCost(
      priceBook,
      Object.entries(byModel).map(
        ([model, entry]) =>
          [
            model,
            {
              input: entry[0],
              output: entry[1],
              cacheRead: entry[2],
              cacheWrite5m: entry[3],
              cacheWrite1h: entry[4],
            },
          ] as const
      )
    )
    if (cost !== null) addDay(daily, date, { cost })
  }
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

  const modelEntries: UsageEntry[] = topEntries(models, 20).map((entry) => ({
    ...entry,
    label: modelLabel(entry.id),
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
    // The plan and limits come from `/usage`; `withClaudeLimits` adds them.
    plan: null,
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
    limits: [],
    limitsObservedAt: null,
    limitNotes: [],
    notes,
  }
}
