import { classifyApiKeyFailure } from "../../auth/apiKeyPool"

export interface TransientRetryOptions {
  /** Turn cancellation; aborts a pending backoff immediately. */
  readonly signal?: AbortSignal
  /** Total attempts on the same key, including the first one. */
  readonly maxAttempts?: number
  /** First backoff step; doubles per retry before jitter. */
  readonly baseDelayMs?: number
  /** Upper bound for one computed backoff step. */
  readonly maxBackoffMs?: number
  /**
   * Longest provider-requested `Retry-After` honoured on the same key. A
   * longer request is not waited out here: the error goes back to the key
   * pool, which records the cooldown and fails over to the next key.
   */
  readonly maxRetryAfterMs?: number
  readonly random?: () => number
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const TRANSIENT_RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxBackoffMs: 16_000,
  maxRetryAfterMs: 60_000,
} as const

/**
 * Retries one API-key request on transient failures (408, 429, 5xx, 529
 * overloaded, connection errors) with exponential backoff, full jitter on
 * the upper half, and the provider's `Retry-After` when present. The key pool
 * disables SDK-level retries so it can fail over between keys; without this
 * a single overloaded response would fail a whole agentic turn for users with
 * one key.
 *
 * A request that already streamed output is never retried, because the
 * renderer has shown that output and a replay would duplicate it.
 */
export async function withTransientRetry<T>(
  attempt: (started: () => void) => Promise<T>,
  started: () => void = () => undefined,
  options: TransientRetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? TRANSIENT_RETRY_DEFAULTS.maxAttempts)
  )
  const baseDelayMs = Math.max(
    0,
    options.baseDelayMs ?? TRANSIENT_RETRY_DEFAULTS.baseDelayMs
  )
  const maxBackoffMs = Math.max(
    baseDelayMs,
    options.maxBackoffMs ?? TRANSIENT_RETRY_DEFAULTS.maxBackoffMs
  )
  const maxRetryAfterMs = Math.max(
    0,
    options.maxRetryAfterMs ?? TRANSIENT_RETRY_DEFAULTS.maxRetryAfterMs
  )
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep

  for (let attemptNumber = 1; ; attemptNumber++) {
    let streamed = false
    try {
      return await attempt(() => {
        streamed = true
        started()
      })
    } catch (error) {
      if (streamed || attemptNumber >= maxAttempts || options.signal?.aborted)
        throw error
      if (classifyApiKeyFailure(error).kind !== "cooldown") throw error
      const requested = retryAfterMs(error)
      if (requested !== null && requested > maxRetryAfterMs) throw error
      const step = Math.min(
        maxBackoffMs,
        baseDelayMs * 2 ** (attemptNumber - 1)
      )
      const jittered = step / 2 + random() * (step / 2)
      await sleep(Math.max(jittered, requested ?? 0), options.signal)
    }
  }
}

/** Provider-requested delay from `retry-after-ms` / `retry-after`, if any. */
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const headers =
    error && typeof error === "object"
      ? (error as { headers?: unknown }).headers
      : undefined
  if (!headers || typeof headers !== "object") return null
  const get = (name: string): unknown =>
    headers instanceof Headers
      ? headers.get(name)
      : (headers as Record<string, unknown>)[name]
  const millis = get("retry-after-ms")
  if (typeof millis === "string" && /^\d+(?:\.\d+)?$/.test(millis.trim()))
    return Number(millis.trim())
  const after = get("retry-after")
  if (typeof after !== "string") return null
  const trimmed = after.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request aborted."))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Request aborted."))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
