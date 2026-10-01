import {
  NINEROUTER_DEFAULT_BASE_URL,
  nineRouterConnectionIdFromInstanceId,
  normalizeNineRouterBaseUrl,
  type NineRouterConnection,
} from "@betterc0de/schema"
import type { Settings } from "../../settings/schema"

/** A connection as the adapter and catalog use it: normalized URL, plaintext key. */
export interface ResolvedNineRouterConnection {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string | null
  readonly enabled: boolean
  readonly tokenSaver: boolean
  readonly customModels: readonly string[]
  readonly hiddenModels: readonly string[]
}

export interface NineRouterSettingsSnapshot {
  readonly enabled: boolean
  readonly connections: readonly NineRouterConnection[]
}

export function readNineRouterSettings(
  settings: Settings
): NineRouterSettingsSnapshot {
  const config = (settings.providers as Record<string, unknown> | undefined)
    ?.ninerouter as
    | { enabled?: boolean; connections?: NineRouterConnection[] }
    | undefined
  return {
    enabled: config?.enabled !== false,
    connections: Array.isArray(config?.connections) ? config.connections : [],
  }
}

export function resolveNineRouterConnection(
  connection: NineRouterConnection
): ResolvedNineRouterConnection | null {
  const baseUrl = normalizeNineRouterBaseUrl(connection.base_url)
  if (!baseUrl) return null
  const apiKey = connection.api_key?.trim()
  return {
    id: connection.id,
    name: connection.name,
    baseUrl,
    apiKey: apiKey ? apiKey : null,
    enabled: connection.enabled !== false,
    tokenSaver: connection.token_saver !== false,
    customModels: connection.custom_models ?? [],
    hiddenModels: connection.hidden_models ?? [],
  }
}

/** Every connection with a usable URL; disabled ones only when asked. */
export function listNineRouterConnections(
  settings: Settings,
  options: { includeDisabled?: boolean } = {}
): ResolvedNineRouterConnection[] {
  const snapshot = readNineRouterSettings(settings)
  return snapshot.connections.flatMap((connection) => {
    const resolved = resolveNineRouterConnection(connection)
    if (!resolved) return []
    if (!options.includeDisabled && (!snapshot.enabled || !resolved.enabled))
      return []
    return [resolved]
  })
}

export class NineRouterConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NineRouterConnectionError"
  }
}

/**
 * The connection a turn runs on (`ninerouter:<id>` or a bare id). An explicit id must name an enabled
 * connection; without one (older chats, a single router) the first enabled
 * connection is used.
 */
export function pickNineRouterConnection(
  settings: Settings,
  connectionId: string | null | undefined
): ResolvedNineRouterConnection {
  const snapshot = readNineRouterSettings(settings)
  if (!snapshot.enabled)
    throw new NineRouterConnectionError(
      "9Router is turned off. Enable it in Settings → Providers → 9Router."
    )
  const enabled = listNineRouterConnections(settings)
  const id = nineRouterConnectionIdFromInstanceId(connectionId)
  if (id) {
    const match = enabled.find((connection) => connection.id === id)
    if (match) return match
    const known = snapshot.connections.find(
      (connection) => connection.id === id
    )
    throw new NineRouterConnectionError(
      known
        ? `9Router connection "${known.name}" is disabled or has an invalid URL. Check it in Settings → Providers → 9Router.`
        : `9Router connection "${id}" no longer exists. Choose another 9Router model.`
    )
  }
  const first = enabled[0]
  if (!first)
    throw new NineRouterConnectionError(
      `No 9Router connection is set up. Add one in Settings → Providers → 9Router (default ${NINEROUTER_DEFAULT_BASE_URL}).`
    )
  return first
}

/** Headers sent with every request to a connection. */
export function nineRouterRequestHeaders(
  connection: Pick<ResolvedNineRouterConnection, "tokenSaver">
): Record<string, string> {
  return connection.tokenSaver ? {} : { "X-9Router-Token-Saver": "off" }
}

/** The SDK requires a bearer value; routers with "Require API key" off ignore it. */
export const NINEROUTER_KEYLESS_BEARER = "betterc0de-no-key"

/** Stable, readable id from a connection name: "My VPS" → "my-vps", "my-vps-2", … */
export function nineRouterConnectionIdFromName(
  name: string,
  existingIds: Iterable<string>
): string {
  const taken = new Set(existingIds)
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "router"
  if (!taken.has(base)) return base
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}
