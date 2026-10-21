/**
 * Live model discovery for OpenRouter.
 *
 * The renderer's OpenRouter picker groups (Qwen and DeepSeek)
 * used to be static id lists that rotted silently — at one audit 11 of 16 ids
 * no longer existed on OpenRouter and every selection would have been a 404.
 * This module fetches the public catalog (https://openrouter.ai/api/v1/models,
 * no auth required), trims it to the families the picker actually shows, and
 * caches the result so the provider-list path stays fast.
 *
 * Local-first note: the fetch is only triggered through the HTTP route, which
 * requires an OpenRouter API key to be configured — a user who never set up
 * OpenRouter never causes traffic to openrouter.ai.
 */

import { isRecord } from "@betterc0de/schema"

export interface OpenRouterCatalogModel {
  readonly id: string
  readonly name: string
  readonly contextLength: number | null
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const DISCOVERY_TTL_MS = 6 * 60 * 60_000
const DISCOVERY_RETRY_DELAY_MS = 60_000
/** Bounded so a hung endpoint can never delay the provider list. */
const DISCOVERY_TIMEOUT_MS = 5_000

/** The picker's family groups. Everything else in the ~400-model catalog is
 *  noise for this UI and gets dropped before caching. Grok (x-ai/) is
 *  deliberately absent — the direct xAI provider already covers it. */
const FAMILY_PREFIXES = ["qwen/", "deepseek/"] as const

/** Variants the picker never offers: batch endpoints and media models. */
const EXCLUDED_ID_FRAGMENTS = [
  ":batch",
  ":nitro",
  "image",
  "audio",
  "video",
  "lyria",
  "tts",
  "customtools",
] as const

interface DiscoveryCache {
  readonly models: ReadonlyArray<OpenRouterCatalogModel>
  readonly fetchedAt: number
}

let cache: DiscoveryCache | null = null
let inFlight: Promise<ReadonlyArray<OpenRouterCatalogModel>> | null = null
let retryAfter = 0

export function __resetOpenRouterModelDiscoveryForTests(): void {
  cache = null
  inFlight = null
  retryAfter = 0
}

/**
 * Pure selection: keeps only the picker's families, drops batch/media
 * variants, and preserves the catalog's serving order (newest releases
 * first). The per-family display cap lives in the renderer.
 */
export function selectOpenRouterCatalogSubset(
  entries: ReadonlyArray<unknown>
): OpenRouterCatalogModel[] {
  const out: OpenRouterCatalogModel[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === "string" ? entry.id : ""
    if (!id) continue
    const lower = id.toLowerCase()
    if (!FAMILY_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue
    if (EXCLUDED_ID_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
      continue
    }
    out.push({
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      contextLength:
        typeof entry.context_length === "number" &&
        Number.isFinite(entry.context_length)
          ? entry.context_length
          : null,
    })
  }
  return out
}

/**
 * Returns the cached catalog subset, fetching when the cache is cold or
 * expired. Failures fall back to whatever was cached before (possibly empty)
 * — the renderer keeps its curated fallback list in that case.
 */
export async function getOpenRouterCatalogModels(
  fetchImpl: typeof fetch = fetch
): Promise<ReadonlyArray<OpenRouterCatalogModel>> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < DISCOVERY_TTL_MS) return cache.models
  if (now < retryAfter) return cache?.models ?? []
  if (inFlight) return inFlight

  inFlight = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await fetchImpl(OPENROUTER_MODELS_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      })
      if (!response.ok) throw new Error(`openrouter models ${response.status}`)
      const body: unknown = await response.json()
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new Error("OpenRouter model catalog has an invalid shape")
      }
      const models = selectOpenRouterCatalogSubset(body.data)
      cache = { models, fetchedAt: Date.now() }
      retryAfter = 0
      return models
    } catch {
      // Keep serving the stale cache (or nothing) — a flaky network must not
      // break the picker, which still has its curated fallback entries.
      retryAfter = Date.now() + DISCOVERY_RETRY_DELAY_MS
      return cache?.models ?? []
    } finally {
      clearTimeout(timer)
      inFlight = null
    }
  })()
  return inFlight
}
