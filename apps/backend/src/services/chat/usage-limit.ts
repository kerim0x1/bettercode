import { parseResetDuration, parseResetLabel } from "@betterc0de/schema"

/**
 * Whether a turn ended because the provider's usage or rate limit was
 * reached, and when that limit resets. Read from the structured parts of a
 * turn error where the provider gives them, and from the wording it prints
 * otherwise:
 *
 * - Claude Code: the `rate_limit_event` it sent before the failure, which
 *   ClaudeAdapter attaches as `detail.limit`, else its message (`Claude AI
 *   usage limit reached|1760000000`, `5-hour limit reached ∙ resets 3pm`,
 *   `You've hit your limit · resets 7pm (Europe/Berlin)`).
 * - Codex: `codexErrorInfo: "usageLimitExceeded"` in the error
 *   notification, the exhausted window of its latest rate-limit report
 *   (`resetsAt`, or `resets_in_seconds` in older reports), else its message
 *   (`… try again at 3:45 PM.`, `… try again in 2 days 3 hours.`).
 * - API keys: a 429 with `Retry-After`, which the key pool turns into the
 *   turn error's `limit`.
 *
 * Pure: the caller passes the clock. Times without a zone are read in this
 * machine's zone, as the CLIs that printed them do.
 */

export type ProviderLimitKind = "usage" | "rate"

export interface ProviderLimit {
  readonly kind: ProviderLimitKind
  /** When the limit resets (ms since the epoch); `null` when unknown. */
  readonly resetAt: number | null
}

/** A provider's latest rate-limit report and when it arrived. */
export interface RateLimitReport {
  readonly snapshot: unknown
  readonly receivedAt: number
}

/** A reset further ahead than this is not believed; weekly limits are 7 days. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000

/** A reset this far in the past still counts (slow delivery, clock skew). */
const RESET_GRACE_MS = 5 * 60_000

/** A window used this much is the one that stopped the turn. */
const EXHAUSTED_PERCENT = 99

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
    return Number(value.trim())
  return null
}

function plausible(ms: number | null, now: number): number | null {
  if (ms === null || !Number.isFinite(ms)) return null
  if (ms < now - RESET_GRACE_MS || ms > now + MAX_RESET_AHEAD_MS) return null
  return Math.round(ms)
}

/**
 * A reset instant as providers write it: epoch seconds, epoch milliseconds
 * or an ISO date. `null` when it is none of these or not plausible.
 */
export function normalizeResetInstant(
  value: unknown,
  now: number
): number | null {
  const numeric = finiteNumber(value)
  if (numeric !== null)
    return plausible(numeric < 1e12 ? numeric * 1000 : numeric, now)
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim())
    return plausible(Number.isFinite(parsed) ? parsed : null, now)
  }
  return null
}

function isLimitKind(value: unknown): value is ProviderLimitKind {
  return value === "usage" || value === "rate"
}

/** `{ kind, resetAt }` as the backend's own adapters attach it. */
function attachedLimit(value: unknown, now: number): ProviderLimit | null {
  const limit = record(value)
  if (!isLimitKind(limit.kind)) return null
  return {
    kind: limit.kind,
    resetAt: normalizeResetInstant(limit.resetAt, now),
  }
}

/** Codex's `codexErrorInfo`: a variant name, or `{ variant: { … } }`. */
function codexLimitKind(detail: unknown): ProviderLimitKind | null {
  const error = record(record(detail).error)
  const info = error.codexErrorInfo ?? record(detail).codexErrorInfo
  const names: string[] = []
  let httpStatus: number | null = null
  if (typeof info === "string") names.push(info)
  else {
    const fields = record(info)
    if (typeof fields.type === "string") names.push(fields.type)
    for (const [name, value] of Object.entries(fields)) {
      names.push(name)
      httpStatus ??= finiteNumber(
        record(value).httpStatusCode ?? record(value).http_status_code
      )
    }
  }
  if (names.some((name) => /usage[_-]?limit/i.test(name))) return "usage"
  if (httpStatus === 429) return "rate"
  return null
}

const USAGE_WORDING = [
  /usage[ _-]?limit/i,
  /\b(?:5|five)[- ]hour limit\b/i,
  /\bweekly limit\b/i,
  /\bhit your (?:usage )?limit\b/i,
  /\blimit reached\b[^\n]{0,40}\bresets?\b/i,
  /\bout of (?:extra )?usage\b/i,
]

const RATE_WORDING = [/rate[ _-]?limit/i, /\btoo many requests\b/i]

/** Failures that mention a limit but no reset will lift. */
const NOT_A_LIMIT =
  /\bcredit balance\b|\binsufficient[_ ]quota\b|\bbilling\b|\bcontext (?:window|length)\b|\bmax(?:imum)?[_ ]tokens\b|\boverloaded\b/i

/** Usage, rate, or `null` when the message is not about a limit. */
export function limitKindFromText(text: string): ProviderLimitKind | null {
  if (!text.trim() || NOT_A_LIMIT.test(text)) return null
  if (USAGE_WORDING.some((pattern) => pattern.test(text))) return "usage"
  if (RATE_WORDING.some((pattern) => pattern.test(text))) return "rate"
  return null
}

const DURATION_PART = String.raw`\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])`
const RELATIVE_RESET = new RegExp(
  String.raw`\b(?:try again|retry(?: again)?|resets?|reset|available again|back)\s+(?:in|after)\s+(${DURATION_PART}(?:(?:\s*,\s*|\s+and\s+|\s*)${DURATION_PART})*)`,
  "i"
)
const EPOCH_RESET = /\blimit reached\|(\d{9,13})\b/i
const ISO_RESET =
  /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/
/** `resets 3pm (Europe/Berlin)`, `will reset at …`, `try again at …`. */
const ABSOLUTE_RESET =
  /\b(?:resets?(?:\s+at|\s+on)?|try again at|available again at)\s+([^\n·•∙|;]+?)(?=\s*(?:[\n·•∙|;]|\.(?:\s|$)|$))/i

/** When the wording says the limit resets; `null` when it does not say. */
export function resetAtFromText(text: string, now: number): number | null {
  const epoch = EPOCH_RESET.exec(text)
  if (epoch) {
    const at = normalizeResetInstant(epoch[1], now)
    if (at !== null) return at
  }
  const relative = RELATIVE_RESET.exec(text)
  if (relative) {
    const ms = parseResetDuration(relative[1]!.replace(/\s+and\s+/gi, " "))
    if (ms !== null) {
      const at = plausible(now + ms, now)
      if (at !== null) return at
    }
  }
  const iso = ISO_RESET.exec(text)
  if (iso) {
    const at = normalizeResetInstant(iso[1], now)
    if (at !== null) return at
  }
  const absolute = ABSOLUTE_RESET.exec(text)
  if (absolute) {
    const at = plausible(parseResetLabel(absolute[1]!.trim(), now), now)
    if (at !== null) return at
  }
  return null
}

/**
 * When the window that stopped the turn resets, from a Codex rate-limit
 * report (`primary` / `secondary`): the latest reset of the windows used
 * up, since all of them have to be free again.
 */
export function resetAtFromRateLimits(
  report: RateLimitReport | null | undefined,
  now: number
): number | null {
  if (!report) return null
  const root = record(report.snapshot)
  const nested = record(root.rateLimits ?? root.rate_limits)
  const source = Object.keys(nested).length > 0 ? nested : root
  let latest: number | null = null
  for (const raw of [source.primary, source.secondary]) {
    const window = record(raw)
    const used = finiteNumber(window.usedPercent ?? window.used_percent)
    if (used === null || used < EXHAUSTED_PERCENT) continue
    const seconds = finiteNumber(
      window.resetsInSeconds ?? window.resets_in_seconds
    )
    const at =
      normalizeResetInstant(window.resetsAt ?? window.resets_at, now) ??
      (seconds === null
        ? null
        : plausible(report.receivedAt + seconds * 1000, now))
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** Every message a turn error carries, the provider's own included. */
function errorTexts(payload: Record<string, unknown>): string[] {
  const detail = payload.detail
  const detailRecord = record(detail)
  return [
    payload.error,
    payload.message,
    payload.errorMessage,
    payload.reason,
    detail,
    detailRecord.message,
    record(detailRecord.error).message,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  )
}

/**
 * The limit a turn error (`turn_error` on the provider event bus) reports,
 * or `null` when the turn failed for another reason. `rateLimits` is the
 * provider's latest rate-limit report, when it sends them.
 */
export function providerLimitFromTurnError(
  payload: Record<string, unknown>,
  now: number,
  rateLimits?: RateLimitReport | null
): ProviderLimit | null {
  const attached =
    attachedLimit(payload.limit, now) ??
    attachedLimit(record(payload.detail).limit, now)
  const text = errorTexts(payload).join("\n")
  const kind =
    attached?.kind ??
    codexLimitKind(payload.detail) ??
    (payload.class === "rate_limit" ? "rate" : null) ??
    limitKindFromText(text)
  if (!kind) return null
  return {
    kind,
    resetAt:
      attached?.resetAt ??
      resetAtFromRateLimits(rateLimits, now) ??
      resetAtFromText(text, now),
  }
}

/** When a 429 answer says to retry (`Retry-After`, `retry-after-ms`). */
export function retryAtFromHeaders(
  headers: unknown,
  now: number
): number | null {
  const get = (name: string): unknown =>
    headers instanceof Headers ? headers.get(name) : record(headers)[name]
  const millis = finiteNumber(get("retry-after-ms"))
  if (millis !== null) return plausible(now + millis, now)
  const after = get("retry-after")
  const seconds = finiteNumber(after)
  if (seconds !== null) return plausible(now + seconds * 1000, now)
  if (typeof after === "string") {
    const date = Date.parse(after)
    if (Number.isFinite(date)) return plausible(Math.max(now, date), now)
  }
  return null
}

/**
 * The limit an API request failure carries: the key pool's own `limit`, or
 * an HTTP 429 with its retry headers. `null` for any other failure.
 */
export function providerLimitFromError(
  error: unknown,
  now: number
): ProviderLimit | null {
  const root = record(error)
  const attached = attachedLimit(root.limit, now)
  if (attached) return attached
  if (finiteNumber(root.status) === 429) {
    return { kind: "rate", resetAt: retryAtFromHeaders(root.headers, now) }
  }
  return null
}

/**
 * Two reports of one turn's limit (Claude reports it twice: the error, then
 * the failed turn): the first kind, and a reset once either names one.
 */
export function mergeProviderLimits(
  first: ProviderLimit,
  second: ProviderLimit
): ProviderLimit {
  return { kind: first.kind, resetAt: first.resetAt ?? second.resetAt }
}
