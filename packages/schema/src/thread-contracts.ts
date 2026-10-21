import { z } from "zod"
import { endpoint, noBody, type RecordSchema } from "./http-endpoint"
import {
  threadActivityResponseSchema,
  threadWorktreeCreateResponseSchema,
} from "./thread-records"
import {
  threadCheckpointRecoveryResolveSchema,
  threadModelSwitchActivitySchema,
  threadTruncateSchema,
  threadWorktreeRemoveSchema,
  threadWorktreeResetSchema,
} from "./threads"

/**
 * The remaining thread routes (`apps/backend/src/http/routes/threads.ts`:
 * stats, diffs, activity output, message search, checkpoint recovery,
 * truncation, worktree maintenance) and the provider CLIs' usage reports
 * (`routes/usage.ts`).
 */

const text = z.string()
const bool = z.boolean()
const num = z.number()

// ── Usage statistics of the stored chats ────────────────────────────────

export interface ThreadTokenTotals {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ThreadUsageBucket {
  messages: number
  tokens: ThreadTokenTotals
  cost: number
}

/** `GET /threads/stats`: usage over a window (`?days=`) or one project. */
export interface ThreadUsageStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: ThreadTokenTotals
  toolUsage: Record<string, number>
  modelUsage: Record<string, ThreadUsageBucket>
  providerUsage?: Record<string, ThreadUsageBucket>
  dailyUsage?: Array<{
    date: string
    provider: string
    tokens: number
    cost: number
  }>
  dateRange: { earliest: string | null; latest: string | null }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

const threadTokenTotalsSchema: RecordSchema<ThreadTokenTotals> = z
  .object({
    input: num,
    output: num,
    reasoning: num,
    cache: z.object({ read: num, write: num }).passthrough(),
  })
  .passthrough()

const threadUsageBucketSchema: RecordSchema<ThreadUsageBucket> = z
  .object({ messages: num, tokens: threadTokenTotalsSchema, cost: num })
  .passthrough()

const threadUsageStatsSchema: RecordSchema<ThreadUsageStats> = z
  .object({
    totalSessions: num,
    totalMessages: num,
    totalCost: num,
    totalTokens: threadTokenTotalsSchema,
    toolUsage: z.record(text, num),
    modelUsage: z.record(text, threadUsageBucketSchema),
    providerUsage: z.record(text, threadUsageBucketSchema).optional(),
    dailyUsage: z
      .array(
        z
          .object({ date: text, provider: text, tokens: num, cost: num })
          .passthrough()
      )
      .optional(),
    dateRange: z
      .object({ earliest: text.nullable(), latest: text.nullable() })
      .passthrough(),
    days: num,
    costPerDay: num,
    tokensPerSession: num,
    medianTokensPerSession: num,
  })
  .passthrough()

// ── Diffs and checkpoints ───────────────────────────────────────────────

export interface ThreadTurnDiff {
  threadId: string
  turnIndex: number
  diffText: string
  filesChanged: number
  insertions: number
  deletions: number
  createdAt: string
}

export interface ThreadCheckpointDiff {
  id: number
  threadId: string
  turnId: string
  checkpointRef: string
  diffContent: string
  createdAt: string
}

/** One page of a chat's diffs, oldest first, with cursors for older pages. */
export interface ThreadDiffsPage {
  turnDiffs: ThreadTurnDiff[]
  checkpointDiffs: ThreadCheckpointDiff[]
  /** Cursor for the next (older) turn-diff page; null when complete. */
  nextBeforeTurnIndex?: number | null
  /** Cursor for the next (older) checkpoint-diff page; null when complete. */
  nextBeforeCheckpointId?: number | null
}

const threadDiffsPageSchema: RecordSchema<ThreadDiffsPage> = z
  .object({
    turnDiffs: z.array(
      z
        .object({
          threadId: text,
          turnIndex: num,
          diffText: text,
          filesChanged: num,
          insertions: num,
          deletions: num,
          createdAt: text,
        })
        .passthrough()
    ),
    checkpointDiffs: z.array(
      z
        .object({
          id: num,
          threadId: text,
          turnId: text,
          checkpointRef: text,
          diffContent: text,
          createdAt: text,
        })
        .passthrough()
    ),
    nextBeforeTurnIndex: num.nullable().optional(),
    nextBeforeCheckpointId: num.nullable().optional(),
  })
  .passthrough()

/** How far a chat can be restored, without any diff body. */
export interface ThreadCheckpointSummary {
  threadId: string
  currentTurnCount: number
}

const threadCheckpointSummarySchema: RecordSchema<ThreadCheckpointSummary> = z
  .object({ threadId: text, currentTurnCount: num })
  .passthrough()

/**
 * A checkpoint restore that stopped half way: the operation still pending
 * and the ones set aside for the user to resolve.
 */
const threadCheckpointRecoverySchema = z
  .object({
    recoveryRequired: bool,
    pending: z.object({ threadId: text, phase: text }).passthrough().nullable(),
    quarantined: z.array(
      z.object({ quarantineId: num, threadId: text, phase: text }).passthrough()
    ),
  })
  .passthrough()

// ── Activity output ─────────────────────────────────────────────────────

/**
 * The whole output of a tool activity whose stored payload carries a cut
 * copy, read back from the provider journal while it still holds the event.
 */
export interface ThreadActivityFullOutput {
  activityId: string
  /** The tool's primary output: usually a string, otherwise its JSON value. */
  output: unknown
  /** The journal itself had to bound the event, so this copy is cut too. */
  truncated: boolean
  /** UTF-8 bytes of `output` (of its JSON when it is not a string). */
  bytes: number
}

const threadActivityFullOutputSchema: RecordSchema<ThreadActivityFullOutput> = z
  .object({
    activityId: text,
    output: z.unknown(),
    truncated: bool,
    bytes: num,
  })
  .passthrough()

// ── Find in chat ────────────────────────────────────────────────────────

/** A stored message whose text matches a find-in-chat query. */
export interface ThreadMessageSearchHit {
  messageId: string
  role: string
  /** Storage order, as on a paged `GET /threads/:id/messages` row. */
  sequence: number
  createdAt: string
  /** Every match in the message's text (`chatFindPattern` rules). */
  matchCount: number
  /** One line of text around the first match. */
  snippet: string
}

/**
 * The messages of one chat that match a query, oldest first. The search
 * runs from the newest message back and stops once `limit` matches are
 * counted; `truncated` says older matches were left out.
 */
export interface ThreadMessageSearchResult {
  hits: ThreadMessageSearchHit[]
  /** Sum of the hits' `matchCount`. */
  totalMatches: number
  truncated: boolean
}

const threadMessageSearchResultSchema: RecordSchema<ThreadMessageSearchResult> =
  z
    .object({
      hits: z.array(
        z
          .object({
            messageId: text,
            role: text,
            sequence: num,
            createdAt: text,
            matchCount: num,
            snippet: text,
          })
          .passthrough()
      ),
      totalMatches: num,
      truncated: bool,
    })
    .passthrough()

// ── Provider usage reports ──────────────────────────────────────────────

export type UsageProviderId = "claude" | "codex" | "grok"
/** `partial`: the store exists but cannot report tokens. */
export type UsageStatus = "ready" | "partial" | "unavailable" | "error"

export interface UsageDailyPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  tokens: number
  messages: number
  sessions: number
  /**
   * USD at list prices for that day's priced models. Absent where the store
   * keeps no per-model split for the day (or no model on it has a rate).
   */
  cost?: number
}

export interface UsageEntry {
  id: string
  label: string
  value: number
  /** 0..1 of the list total, where meaningful. */
  share?: number
  /** USD at list prices, where a rate is known. */
  cost?: number
}

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
  unpricedTokens: number
  unpricedModels: string[]
  /** Some rate came from the user's own `model-prices.json`. */
  hasOverrides: boolean
  notes: string[]
  /**
   * USD the cache reads saved against paying the input rate for them.
   * Absent from hosts older than this field.
   */
  cacheSavings?: number
}

export interface UsageList {
  id: string
  title: string
  unit: string
  entries: UsageEntry[]
}

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

export interface UsageSummary {
  totalTokens: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
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
  /** Only where the store records money. */
  cost: number | null
}

/** Usage one provider CLI keeps in its own local store. */
export interface ProviderUsageReport {
  provider: UsageProviderId
  label: string
  status: UsageStatus
  installed: boolean
  authenticated: boolean
  version: string | null
  plan: string | null
  source: string
  fetchedAt: string
  scannedMs: number
  summary: UsageSummary
  daily: UsageDailyPoint[]
  pricing: UsagePricing | null
  pricesFile: string | null
  models: UsageEntry[]
  insights: UsageInsight[]
  lists: UsageList[]
  limits: UsageLimit[]
  limitsObservedAt: string | null
  limitNotes: string[]
  notes: string[]
  error?: string
}

const usageEntrySchema: RecordSchema<UsageEntry> = z
  .object({
    id: text,
    label: text,
    value: num,
    share: num.optional(),
    cost: num.optional(),
  })
  .passthrough()

const providerUsageReportSchema: RecordSchema<ProviderUsageReport> = z
  .object({
    provider: z.enum(["claude", "codex", "grok"]),
    label: text,
    status: z.enum(["ready", "partial", "unavailable", "error"]),
    installed: bool,
    authenticated: bool,
    version: text.nullable(),
    plan: text.nullable(),
    source: text,
    fetchedAt: text,
    scannedMs: num,
    summary: z
      .object({
        totalTokens: num,
        tokens: z
          .object({
            input: num,
            output: num,
            reasoning: num,
            cacheRead: num,
            cacheWrite: num,
          })
          .passthrough(),
        peakDayTokens: num,
        peakDayDate: text.nullable(),
        longestSessionMs: num,
        currentStreakDays: num,
        longestStreakDays: num,
        sessions: num,
        messages: num,
        activeDays: num,
        firstActivity: text.nullable(),
        lastActivity: text.nullable(),
        cost: num.nullable(),
      })
      .passthrough(),
    daily: z.array(
      z
        .object({
          date: text,
          tokens: num,
          messages: num,
          sessions: num,
          cost: num.optional(),
        })
        .passthrough()
    ),
    pricing: z
      .object({
        currency: z.literal("USD"),
        total: num,
        breakdown: z
          .object({
            input: num,
            output: num,
            cacheRead: num,
            cacheWrite: num,
          })
          .passthrough(),
        pricedTokens: num,
        unpricedTokens: num,
        unpricedModels: z.array(text),
        hasOverrides: bool,
        notes: z.array(text),
        cacheSavings: num.optional(),
      })
      .passthrough()
      .nullable(),
    pricesFile: text.nullable(),
    models: z.array(usageEntrySchema),
    insights: z.array(
      z
        .object({ id: text, label: text, value: text, hint: text.optional() })
        .passthrough()
    ),
    lists: z.array(
      z
        .object({
          id: text,
          title: text,
          unit: text,
          entries: z.array(usageEntrySchema),
        })
        .passthrough()
    ),
    limits: z.array(
      z
        .object({
          id: text,
          label: text,
          usedPercent: num,
          resetsAt: text.nullable(),
          resetLabel: text.nullable(),
        })
        .passthrough()
    ),
    limitsObservedAt: text.nullable(),
    limitNotes: z.array(text),
    notes: z.array(text),
    error: text.optional(),
  })
  .passthrough()

export const threadHttpContracts = {
  // `?days=` (whole days, 1..3650) and `?projectPath=` narrow the window.
  threadStats: endpoint(
    "GET",
    "/threads/stats",
    noBody,
    threadUsageStatsSchema
  ),
  saveModelSwitchActivity: endpoint(
    "POST",
    "/threads/:id/activities/model-switch",
    threadModelSwitchActivitySchema,
    threadActivityResponseSchema
  ),
  threadActivityOutput: endpoint(
    "GET",
    "/threads/:id/activities/:activityId/output",
    noBody,
    threadActivityFullOutputSchema
  ),
  // Find in chat. `?q=` (required, at most 200 characters), `?caseSensitive=1`,
  // `?beforeSequence=` (only older messages: the ones a client has not
  // loaded) and `?limit=` (matches, 1–1000).
  searchThreadMessages: endpoint(
    "GET",
    "/threads/:id/messages/search",
    noBody,
    threadMessageSearchResultSchema
  ),
  // `?limit=`, `?beforeTurnIndex=`, `?beforeCheckpointId=` page it.
  threadDiffs: endpoint(
    "GET",
    "/threads/:id/diffs",
    noBody,
    threadDiffsPageSchema
  ),
  // The same route with `?summary=1`: no diff body at all.
  threadCheckpointSummary: endpoint(
    "GET",
    "/threads/:id/diffs",
    noBody,
    threadCheckpointSummarySchema
  ),
  threadCheckpointRecovery: endpoint(
    "GET",
    "/threads/:id/checkpoint-recovery",
    noBody,
    threadCheckpointRecoverySchema
  ),
  resolveThreadCheckpointRecovery: endpoint(
    "POST",
    "/threads/:id/checkpoint-recovery/resolve",
    threadCheckpointRecoveryResolveSchema,
    z.object({ ok: z.literal(true) }).passthrough()
  ),
  truncateThread: endpoint(
    "POST",
    "/threads/:id/truncate",
    threadTruncateSchema,
    z.object({ deletedMessages: num }).passthrough()
  ),
  removeThreadWorktree: endpoint(
    "POST",
    "/threads/:id/worktree/remove",
    threadWorktreeRemoveSchema,
    z.object({ ok: z.literal(true) }).passthrough()
  ),
  resetThreadWorktree: endpoint(
    "POST",
    "/threads/:id/worktree/reset",
    threadWorktreeResetSchema,
    threadWorktreeCreateResponseSchema
  ),
  // `?refresh=1` reads the stores again instead of the cached reports.
  providerUsage: endpoint(
    "GET",
    "/usage/providers",
    noBody,
    z.array(providerUsageReportSchema)
  ),
} as const
