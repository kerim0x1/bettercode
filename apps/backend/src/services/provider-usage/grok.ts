import Database from "better-sqlite3"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectCliAsync } from "../../cli/detect"
import {
  LONG_CONTEXT_NOTE,
  PriceBook,
  priceModels,
  type PricedTokens,
} from "./pricing"
import { numberValue, record, stringValue } from "./jsonl"
import {
  addDay,
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
  type UsageList,
  type UsageTokenBreakdown,
} from "./types"

/**
 * Grok keeps session metadata on disk and token usage in SQLite.
 *
 * `~/.grok/sessions/<workspace>/<session>/summary.json` always exists, so
 * chats, models and reasoning effort are reliable. `usage_events` in
 * `~/.grok/grok.db` is the only place tokens are persisted, and sessions
 * driven over ACP (which is how BetterC0de talks to Grok) do not fill it —
 * the table is read anyway so the numbers appear the moment xAI records them.
 */

interface GrokSessionSummary {
  createdAt: number
  updatedAt: number
  messages: number
  model: string | null
  effort: string | null
}

interface GrokUsageRow {
  day: string | null
  model: string | null
  input: number | null
  output: number | null
  total: number | null
  cost: number | null
}

/** Grok has no auth probe in `cli/detect`; its credential file is the signal. */
function hasGrokCredentials(home: string): boolean {
  try {
    return fs.statSync(path.join(home, "auth.json")).size > 0
  } catch {
    return false
  }
}

async function listSummaries(root: string): Promise<string[]> {
  const files: string[] = []
  let workspaces: fs.Dirent[]
  try {
    workspaces = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = path.join(root, workspace.name)
    let sessions: fs.Dirent[]
    try {
      sessions = await fs.promises.readdir(workspacePath, {
        withFileTypes: true,
      })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      files.push(path.join(workspacePath, session.name, "summary.json"))
    }
  }
  return files
}

async function readSummary(file: string): Promise<GrokSessionSummary | null> {
  let parsed: Record<string, unknown> | null
  try {
    parsed = record(JSON.parse(await fs.promises.readFile(file, "utf8")))
  } catch {
    return null
  }
  if (!parsed) return null
  const createdAt = Date.parse(stringValue(parsed.created_at) ?? "")
  const updatedAt = Date.parse(stringValue(parsed.updated_at) ?? "")
  if (!Number.isFinite(createdAt)) return null
  return {
    createdAt,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : createdAt,
    messages: numberValue(parsed.num_chat_messages),
    model: stringValue(parsed.current_model_id),
    effort: stringValue(parsed.reasoning_effort),
  }
}

function readUsageEvents(databasePath: string): GrokUsageRow[] {
  let db: Database.Database
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true })
  } catch {
    return []
  }
  try {
    return db
      .prepare(
        `SELECT created_at AS day, model,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(total_tokens) AS total, SUM(cost_micros) AS cost
         FROM usage_events
         GROUP BY created_at, model`
      )
      .all() as GrokUsageRow[]
  } catch {
    return []
  } finally {
    db.close()
  }
}

export async function collectGrokUsage(options: {
  dataDir: string | null
  refresh: boolean
}): Promise<ProviderUsageReport> {
  const startedAt = Date.now()
  const home = path.join(os.homedir(), ".grok")
  const detected = await detectCliAsync("grok")

  const summaryFiles = await listSummaries(path.join(home, "sessions"))
  const summaries = (
    await Promise.all(summaryFiles.map((file) => readSummary(file)))
  ).filter((summary): summary is GrokSessionSummary => summary !== null)

  const daily = new Map<string, DayBucket>()
  const models = new Map<string, number>()
  const sessionModels = new Map<string, number>()
  const efforts = new Map<string, number>()
  let messages = 0
  let longestSessionMs = 0
  for (const summary of summaries) {
    addDay(daily, localDay(summary.createdAt), {
      messages: summary.messages,
      sessions: 1,
    })
    messages += summary.messages
    longestSessionMs = Math.max(
      longestSessionMs,
      summary.updatedAt - summary.createdAt
    )
    if (summary.model) {
      sessionModels.set(
        summary.model,
        (sessionModels.get(summary.model) ?? 0) + 1
      )
    }
    if (summary.effort) {
      efforts.set(summary.effort, (efforts.get(summary.effort) ?? 0) + 1)
    }
  }

  const tokens: UsageTokenBreakdown = emptyTokenBreakdown()
  const modelTokens = new Map<string, PricedTokens>()
  let cost = 0
  const usageRows = readUsageEvents(path.join(home, "grok.db"))
  for (const row of usageRows) {
    const total = numberValue(row.total)
    const day = row.day ? localDay(row.day) : ""
    if (day) addDay(daily, day, { tokens: total })
    if (row.model) models.set(row.model, (models.get(row.model) ?? 0) + total)
    tokens.input += numberValue(row.input)
    tokens.output += numberValue(row.output)
    cost += numberValue(row.cost) / 1_000_000
    if (row.model) {
      const current = modelTokens.get(row.model) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      }
      current.input += numberValue(row.input)
      current.output += numberValue(row.output)
      modelTokens.set(row.model, current)
    }
  }
  const hasTokens = usageRows.length > 0

  const priceBook = new PriceBook(options.dataDir)
  const { pricing, costByModel } = priceModels(priceBook, modelTokens, [
    LONG_CONTEXT_NOTE,
  ])

  const summary = summarize({
    daily,
    tokens,
    sessions: summaries.length,
    messages,
    longestSessionMs,
    cost: hasTokens ? cost : null,
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
    value: summaries.length.toLocaleString("en-US"),
  })
  insights.push({
    id: "messages",
    label: "Messages recorded",
    value: messages.toLocaleString("en-US"),
  })
  if (sessionModels.size > 0) {
    insights.push({
      id: "models",
      label: "Models used",
      value: sessionModels.size.toLocaleString("en-US"),
    })
  }

  const lists: UsageList[] = []
  if (sessionModels.size > 0) {
    lists.push({
      id: "session-models",
      title: "Most used models",
      unit: "chats",
      entries: topEntries(sessionModels),
    })
  }

  const notes: string[] = []
  if (longestSessionMs > 0) {
    notes.push(
      "Grok records only a chat's start and last-update time, so chat length is the span between them, not active working time."
    )
  }
  if (!hasTokens && summaries.length > 0) {
    notes.push(
      "Grok stores token usage in ~/.grok/grok.db, and its usage table is empty on this machine — sessions started over ACP do not write it. Chats, models and activity below are exact; token counts appear once Grok records them."
    )
  }

  const hasData = summaries.length > 0 || hasTokens
  return {
    provider: "grok",
    label: "Grok",
    status: hasTokens
      ? "ready"
      : hasData
        ? "partial"
        : detected.installed
          ? "partial"
          : "unavailable",
    installed: detected.installed,
    authenticated: detected.authenticated || hasGrokCredentials(home),
    version: detected.version,
    plan: null,
    source: "~/.grok session summaries + grok.db",
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
    limits: [],
    limitsObservedAt: null,
    limitNotes: [],
    notes,
  }
}
