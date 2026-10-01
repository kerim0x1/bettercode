import { createHash } from "node:crypto"
import {
  NINEROUTER_CUSTOM_GROUP,
  isRecord,
  nineRouterDefaultThinkingLevel,
  nineRouterModelGroup,
  nineRouterServerRoot,
  nineRouterThinkingLabel,
  nineRouterThinkingLevels,
  type NineRouterConnectionStatus,
  type NineRouterModel,
  type NineRouterModelCapabilities,
} from "@betterc0de/schema"
import {
  NINEROUTER_KEYLESS_BEARER,
  nineRouterRequestHeaders,
  type ResolvedNineRouterConnection,
} from "./connections"

const TTL_MS = 5 * 60_000
const FAILURE_RETRY_MS = 15_000
const MODELS_TIMEOUT_MS = 6_000
const PROBE_TIMEOUT_MS = 2_500
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 2_000
const MAX_MODEL_ID_CHARS = 256

/** A model as BetterC0de stores it for one connection (before custom/hidden overlays). */
export interface NineRouterCatalogModel {
  readonly slug: string
  readonly name: string
  readonly tier: string
  readonly context?: string
  readonly capabilities: Record<string, unknown>
}

interface Entry {
  readonly key: string
  readonly models: NineRouterCatalogModel[]
  readonly fetchedAt: number
}

const UNKNOWN_STATUS: NineRouterConnectionStatus = {
  state: "unknown",
  message: null,
  version: null,
  latestVersion: null,
  latencyMs: null,
  modelCount: null,
  checkedAt: null,
}

/**
 * Per-connection `/v1/models` cache plus the last health result. Entries are
 * keyed by connection id, URL and a hash of the key, so editing a connection
 * never serves the previous router's list.
 */
export class NineRouterModelCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<
    string,
    Promise<NineRouterCatalogModel[]>
  >()
  private readonly retryAfter = new Map<string, number>()
  private readonly statuses = new Map<
    string,
    { key: string; status: NineRouterConnectionStatus }
  >()

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  status(connection: ResolvedNineRouterConnection): NineRouterConnectionStatus {
    const stored = this.statuses.get(connection.id)
    return stored && stored.key === cacheKey(connection)
      ? stored.status
      : UNKNOWN_STATUS
  }

  /** Cached models, or `[]` before the first successful load. Never throws. */
  cached(connection: ResolvedNineRouterConnection): NineRouterCatalogModel[] {
    const entry = this.entries.get(connection.id)
    return entry && entry.key === cacheKey(connection) ? entry.models : []
  }

  invalidate(connectionId: string): void {
    this.entries.delete(connectionId)
    this.retryAfter.delete(connectionId)
    this.statuses.delete(connectionId)
  }

  /** Drops state for connections that no longer exist. */
  retain(connectionIds: Iterable<string>): void {
    const keep = new Set(connectionIds)
    for (const map of [this.entries, this.retryAfter, this.statuses]) {
      for (const id of map.keys()) if (!keep.has(id)) map.delete(id)
    }
  }

  /** Models for a connection; failures keep the last good list. */
  async list(
    connection: ResolvedNineRouterConnection,
    force = false
  ): Promise<NineRouterCatalogModel[]> {
    const key = cacheKey(connection)
    const cached = this.entries.get(connection.id)
    const fresh = cached && cached.key === key ? cached : null
    const now = Date.now()
    if (!force && fresh && now - fresh.fetchedAt < TTL_MS) return fresh.models
    if (!force && now < (this.retryAfter.get(connection.id) ?? 0))
      return fresh?.models ?? []
    const pending = this.inFlight.get(key)
    if (pending) return pending.catch(() => fresh?.models ?? [])
    const request = this.load(connection, key).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, request)
    return request.catch(() => fresh?.models ?? [])
  }

  /** Health, version and models in one pass, for the settings "Check" button. */
  async check(
    connection: ResolvedNineRouterConnection
  ): Promise<NineRouterConnectionStatus> {
    const root = nineRouterServerRoot(connection.baseUrl)
    const startedAt = Date.now()
    try {
      const health = await this.fetchImpl(`${root}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: "application/json" },
      })
      await health.body?.cancel().catch(() => undefined)
    } catch {
      // A reverse proxy may expose only /v1; the model request below decides.
    }
    const latencyMs = Date.now() - startedAt
    const version = await this.version(root)
    await this.list(connection, true)
    const status = this.status(connection)
    const merged: NineRouterConnectionStatus = {
      ...status,
      version: version?.current ?? status.version,
      latestVersion: version?.latest ?? status.latestVersion,
      latencyMs: status.state === "online" ? latencyMs : status.latencyMs,
    }
    this.statuses.set(connection.id, {
      key: cacheKey(connection),
      status: merged,
    })
    return merged
  }

  private async version(
    root: string
  ): Promise<{ current: string | null; latest: string | null } | null> {
    try {
      const response = await this.fetchImpl(`${root}/api/version`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: "application/json" },
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      const body: unknown = await response.json()
      if (!isRecord(body)) return null
      return {
        current:
          typeof body.currentVersion === "string" ? body.currentVersion : null,
        latest:
          typeof body.latestVersion === "string" ? body.latestVersion : null,
      }
    } catch {
      return null
    }
  }

  private async load(
    connection: ResolvedNineRouterConnection,
    key: string
  ): Promise<NineRouterCatalogModel[]> {
    const startedAt = Date.now()
    try {
      const response = await this.fetchImpl(`${connection.baseUrl}/models`, {
        method: "GET",
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${connection.apiKey ?? NINEROUTER_KEYLESS_BEARER}`,
          ...nineRouterRequestHeaders(connection),
        },
      })
      if (!response.ok) {
        const message = await readErrorMessage(response)
        const authFailure = response.status === 401 || response.status === 403
        throw new NineRouterCatalogError(
          authFailure ? "auth_required" : "error",
          authFailure
            ? connection.apiKey
              ? "9Router rejected the API key. Create a new key in the 9Router dashboard (Keys)."
              : "This 9Router requires an API key. Create one in the 9Router dashboard (Keys) and add it here."
            : `9Router answered ${response.status}${message ? `: ${message}` : ""}`
        )
      }
      const body = await readJson(response)
      if (!isRecord(body) || !Array.isArray(body.data))
        throw new NineRouterCatalogError(
          "error",
          "The server did not return a 9Router model list. Check that the URL points to 9Router's /v1 endpoint."
        )
      const models = mapNineRouterModels(body.data)
      this.entries.set(connection.id, { key, models, fetchedAt: Date.now() })
      this.retryAfter.delete(connection.id)
      const previous = this.status(connection)
      this.statuses.set(connection.id, {
        key,
        status: {
          ...previous,
          state: "online",
          message: null,
          latencyMs: Date.now() - startedAt,
          modelCount: models.length,
          checkedAt: Date.now(),
        },
      })
      return models
    } catch (error) {
      this.retryAfter.set(connection.id, Date.now() + FAILURE_RETRY_MS)
      const previous = this.status(connection)
      const failure =
        error instanceof NineRouterCatalogError
          ? error
          : new NineRouterCatalogError(
              "offline",
              `9Router is not reachable at ${connection.baseUrl}. Start it with "npx 9router" or check the URL.`
            )
      this.statuses.set(connection.id, {
        key,
        status: {
          ...previous,
          state: failure.state,
          message: failure.message,
          latencyMs: null,
          checkedAt: Date.now(),
        },
      })
      throw failure
    }
  }
}

class NineRouterCatalogError extends Error {
  constructor(
    readonly state: "auth_required" | "offline" | "error",
    message: string
  ) {
    super(message)
  }
}

function cacheKey(connection: ResolvedNineRouterConnection): string {
  const keyHash = connection.apiKey
    ? createHash("sha256").update(connection.apiKey).digest("hex")
    : "none"
  return `${connection.baseUrl}|${keyHash}|${connection.tokenSaver ? 1 : 0}`
}

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new NineRouterCatalogError("error", "9Router model list is too large")
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES)
    throw new NineRouterCatalogError("error", "9Router model list is too large")
  try {
    return JSON.parse(text)
  } catch {
    throw new NineRouterCatalogError(
      "error",
      "The server did not return JSON. Check that the URL points to 9Router's /v1 endpoint."
    )
  }
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, 2_000)
    const body: unknown = JSON.parse(text)
    if (!isRecord(body)) return null
    if (typeof body.error === "string") return body.error.slice(0, 200)
    if (isRecord(body.error) && typeof body.error.message === "string")
      return body.error.message.slice(0, 200)
    return null
  } catch {
    return null
  }
}

/** Maps 9Router's `/v1/models` entries to picker models with reasoning descriptors. */
export function mapNineRouterModels(
  entries: readonly unknown[]
): NineRouterCatalogModel[] {
  const seen = new Set<string>()
  const models: NineRouterCatalogModel[] = []
  for (const entry of entries) {
    if (models.length >= MAX_MODELS) break
    if (!isRecord(entry) || typeof entry.id !== "string") continue
    // Web search/fetch "models" are tools, not chat models.
    if (typeof entry.kind === "string") continue
    const slug = entry.id.trim()
    if (!slug || slug.length > MAX_MODEL_ID_CHARS || seen.has(slug)) continue
    seen.add(slug)
    const ownedBy = typeof entry.owned_by === "string" ? entry.owned_by : null
    const raw = isRecord(entry.capabilities) ? entry.capabilities : null
    const caps: NineRouterModelCapabilities | null = raw
      ? {
          ...(typeof raw.reasoning === "boolean"
            ? { reasoning: raw.reasoning }
            : {}),
          ...(typeof raw.thinkingFormat === "string"
            ? { thinkingFormat: raw.thinkingFormat }
            : {}),
          ...(typeof raw.thinkingCanDisable === "boolean"
            ? { thinkingCanDisable: raw.thinkingCanDisable }
            : {}),
        }
      : null
    const contextTokens =
      typeof entry.context_length === "number"
        ? entry.context_length
        : raw && typeof raw.contextWindow === "number"
          ? raw.contextWindow
          : null
    const context = contextTokens ? contextLabel(contextTokens) : undefined
    models.push({
      slug,
      name: slug,
      tier: nineRouterModelGroup(slug, ownedBy),
      ...(context ? { context } : {}),
      capabilities: nineRouterModelCapabilities(slug, caps, raw?.vision),
    })
  }
  return models
}

/**
 * Picker capabilities for a 9Router model. A known model always carries an
 * `optionDescriptors` list (empty when it does not reason) so the UI never
 * falls back to a guessed ladder for it.
 */
export function nineRouterModelCapabilities(
  slug: string,
  caps: NineRouterModelCapabilities | null,
  vision?: unknown
): Record<string, unknown> {
  const levels = nineRouterThinkingLevels(slug, caps)
  const format = caps?.thinkingFormat ?? null
  const defaultLevel = levels ? nineRouterDefaultThinkingLevel(levels) : null
  return {
    ...(vision === true ? { attachment: true } : {}),
    optionDescriptors:
      levels && levels.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              ...(defaultLevel ? { currentValue: defaultLevel } : {}),
              options: levels.map((level) => ({
                id: level,
                label: nineRouterThinkingLabel(level, format),
                ...(level === defaultLevel ? { isDefault: true } : {}),
              })),
            },
          ]
        : [],
  }
}

/** Merges catalog models with the connection's custom and hidden ids. */
export function nineRouterConnectionModels(
  catalog: readonly NineRouterCatalogModel[],
  connection: Pick<
    ResolvedNineRouterConnection,
    "customModels" | "hiddenModels"
  >,
  options: { includeHidden?: boolean } = {}
): NineRouterModel[] {
  const hidden = new Set(connection.hiddenModels)
  const out: NineRouterModel[] = []
  const seen = new Set<string>()
  for (const model of catalog) {
    seen.add(model.slug)
    const isHidden = hidden.has(model.slug)
    if (isHidden && !options.includeHidden) continue
    out.push({ ...model, isCustom: false, hidden: isHidden })
  }
  for (const raw of connection.customModels) {
    const slug = raw.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    const isHidden = hidden.has(slug)
    if (isHidden && !options.includeHidden) continue
    // No capabilities: the UI offers the generic ladder, which 9Router clamps.
    out.push({
      slug,
      name: slug,
      tier: NINEROUTER_CUSTOM_GROUP,
      isCustom: true,
      hidden: isHidden,
    })
  }
  return out
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${Math.round((tokens / 1_000_000) * 100) / 100}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}
