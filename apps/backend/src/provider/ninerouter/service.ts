import {
  NINEROUTER_MAX_CONNECTIONS,
  isLoopbackNineRouterUrl,
  isRecord,
  nineRouterDashboardUrl,
  normalizeNineRouterBaseUrl,
  type CreateNineRouterConnection,
  type NineRouterConnection,
  type NineRouterConnectionView,
  type NineRouterDetectResult,
  type NineRouterProviderView,
  type UpdateNineRouterConnection,
} from "@betterc0de/schema"
import type { SettingsService } from "../../settings/service"
import { getMasterKey } from "../../settings/crypto"
import { HttpError } from "../../http/errors"
import {
  listNineRouterConnections,
  nineRouterConnectionIdFromName,
  readNineRouterSettings,
  resolveNineRouterConnection,
  type ResolvedNineRouterConnection,
} from "./connections"
import {
  NineRouterModelCatalog,
  nineRouterConnectionModels,
} from "./modelCatalog"

/** Where a locally started 9Router answers (`npx 9router` binds 20128). */
export const NINEROUTER_LOCAL_CANDIDATES = [
  "http://localhost:20128",
  "http://127.0.0.1:20128",
] as const

const DETECT_TIMEOUT_MS = 1_200

type SettingsAccess = Pick<SettingsService, "get" | "update">

/**
 * Owns 9Router connections: the redacted view for settings and pickers,
 * create/update/remove with write-only keys, health checks and detection
 * of a router on this machine.
 */
export class NineRouterService {
  constructor(
    private readonly settings: SettingsAccess,
    readonly catalog = new NineRouterModelCatalog(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async view(
    options: { refresh?: boolean; includeHidden?: boolean } = {}
  ): Promise<NineRouterProviderView> {
    const settings = this.settings.get()
    const snapshot = readNineRouterSettings(settings)
    this.catalog.retain(snapshot.connections.map((connection) => connection.id))
    const connections = await Promise.all(
      snapshot.connections.map((connection) =>
        this.connectionView(connection, {
          load: snapshot.enabled && connection.enabled !== false,
          refresh: options.refresh === true,
          includeHidden: options.includeHidden === true,
        })
      )
    )
    return { enabled: snapshot.enabled, connections }
  }

  async create(
    input: CreateNineRouterConnection
  ): Promise<NineRouterConnectionView> {
    const baseUrl = requireBaseUrl(input.baseUrl)
    const snapshot = readNineRouterSettings(this.settings.get())
    if (snapshot.connections.length >= NINEROUTER_MAX_CONNECTIONS)
      throw new HttpError(
        400,
        `At most ${NINEROUTER_MAX_CONNECTIONS} 9Router connections can be saved.`
      )
    const id = nineRouterConnectionIdFromName(
      input.name,
      snapshot.connections.map((connection) => connection.id)
    )
    const apiKey = input.apiKey?.trim()
    const entry = {
      id,
      name: input.name.trim(),
      base_url: baseUrl,
      ...(apiKey ? { api_key: { set: apiKey } } : {}),
      enabled: true,
      token_saver: input.tokenSaver ?? true,
      custom_models: [],
      hidden_models: [],
    }
    this.save([...snapshot.connections.map(keepSecret), entry])
    return this.checkedView(id)
  }

  async update(
    id: string,
    patch: UpdateNineRouterConnection
  ): Promise<NineRouterConnectionView> {
    const snapshot = readNineRouterSettings(this.settings.get())
    const current = snapshot.connections.find(
      (connection) => connection.id === id
    )
    if (!current) throw new HttpError(404, "9Router connection not found")
    const baseUrl =
      patch.baseUrl !== undefined ? requireBaseUrl(patch.baseUrl) : undefined
    const urlChanged =
      baseUrl !== undefined &&
      baseUrl !== normalizeNineRouterBaseUrl(current.base_url)
    if (urlChanged && current.api_key && !patch.apiKey)
      throw new HttpError(
        400,
        "Re-enter the API key (or remove it) when changing the 9Router URL. A saved key is never sent to a new address."
      )
    const next = snapshot.connections.map((connection) => {
      if (connection.id !== id) return keepSecret(connection)
      return {
        ...keepSecret(connection),
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
        ...(patch.apiKey !== undefined ? { api_key: patch.apiKey } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.tokenSaver !== undefined
          ? { token_saver: patch.tokenSaver }
          : {}),
        ...(patch.customModels !== undefined
          ? { custom_models: dedupeIds(patch.customModels) }
          : {}),
        ...(patch.hiddenModels !== undefined
          ? { hidden_models: dedupeIds(patch.hiddenModels) }
          : {}),
      }
    })
    this.save(next)
    const credentialsChanged =
      urlChanged ||
      patch.apiKey !== undefined ||
      patch.tokenSaver !== undefined ||
      patch.enabled === true
    if (credentialsChanged) {
      this.catalog.invalidate(id)
      return this.checkedView(id)
    }
    return this.requireView(id, { refresh: false })
  }

  async remove(id: string): Promise<NineRouterProviderView> {
    const snapshot = readNineRouterSettings(this.settings.get())
    if (!snapshot.connections.some((connection) => connection.id === id))
      throw new HttpError(404, "9Router connection not found")
    this.save(
      snapshot.connections
        .filter((connection) => connection.id !== id)
        .map(keepSecret)
    )
    this.catalog.invalidate(id)
    return this.view()
  }

  async test(id: string): Promise<NineRouterConnectionView> {
    return this.checkedView(id)
  }

  /** Looks for a router on this machine; never contacts other hosts. */
  async detect(): Promise<NineRouterDetectResult> {
    const known = listNineRouterConnections(this.settings.get(), {
      includeDisabled: true,
    })
    for (const root of NINEROUTER_LOCAL_CANDIDATES) {
      try {
        const health = await this.fetchImpl(`${root}/api/health`, {
          signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
          headers: { accept: "application/json" },
        })
        if (!health.ok) {
          await health.body?.cancel().catch(() => undefined)
          continue
        }
        const body: unknown = await health.json().catch(() => null)
        if (!isRecord(body) || body.ok !== true) continue
        const baseUrl = `${root}/v1`
        return {
          found: true,
          baseUrl,
          version: await this.localVersion(root),
          alreadyConnected: known.some(
            (connection) =>
              isLoopbackNineRouterUrl(connection.baseUrl) &&
              portOf(connection.baseUrl) === portOf(baseUrl)
          ),
        }
      } catch {
        // Not running on this candidate.
      }
    }
    return {
      found: false,
      baseUrl: null,
      version: null,
      alreadyConnected: false,
    }
  }

  private async localVersion(root: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${root}/api/version`, {
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
        headers: { accept: "application/json" },
      })
      if (!response.ok) return null
      const body: unknown = await response.json()
      return isRecord(body) && typeof body.currentVersion === "string"
        ? body.currentVersion
        : null
    } catch {
      return null
    }
  }

  private async checkedView(id: string): Promise<NineRouterConnectionView> {
    const connection = this.resolved(id)
    if (connection) await this.catalog.check(connection)
    return this.requireView(id, { refresh: false })
  }

  private async requireView(
    id: string,
    options: { refresh: boolean }
  ): Promise<NineRouterConnectionView> {
    const settings = this.settings.get()
    const snapshot = readNineRouterSettings(settings)
    const connection = snapshot.connections.find((entry) => entry.id === id)
    if (!connection) throw new HttpError(404, "9Router connection not found")
    return this.connectionView(connection, {
      load: snapshot.enabled && connection.enabled !== false,
      refresh: options.refresh,
      includeHidden: true,
    })
  }

  private resolved(id: string): ResolvedNineRouterConnection | null {
    const connection = readNineRouterSettings(
      this.settings.get()
    ).connections.find((entry) => entry.id === id)
    return connection ? resolveNineRouterConnection(connection) : null
  }

  private async connectionView(
    connection: NineRouterConnection,
    options: { load: boolean; refresh: boolean; includeHidden: boolean }
  ): Promise<NineRouterConnectionView> {
    const resolved = resolveNineRouterConnection(connection)
    const catalog =
      resolved && options.load
        ? await this.catalog.list(resolved, options.refresh)
        : resolved
          ? this.catalog.cached(resolved)
          : []
    const baseUrl = resolved?.baseUrl ?? connection.base_url
    return {
      id: connection.id,
      name: connection.name,
      baseUrl,
      dashboardUrl: resolved ? nineRouterDashboardUrl(resolved.baseUrl) : "",
      enabled: connection.enabled !== false,
      tokenSaver: connection.token_saver !== false,
      secret: {
        configured: Boolean(connection.api_key),
        storage: getMasterKey() ? "encrypted" : "plaintext",
      },
      customModels: [...(connection.custom_models ?? [])],
      hiddenModels: [...(connection.hidden_models ?? [])],
      status: resolved
        ? this.catalog.status(resolved)
        : {
            state: "error",
            message: "The saved URL is not a valid http(s) address.",
            version: null,
            latestVersion: null,
            latencyMs: null,
            modelCount: null,
            checkedAt: null,
          },
      models: resolved
        ? nineRouterConnectionModels(catalog, resolved, {
            includeHidden: options.includeHidden,
          })
        : [],
    }
  }

  private save(connections: ReadonlyArray<Record<string, unknown>>): void {
    try {
      this.settings.update({ providers: { ninerouter: { connections } } })
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error
          ? error.message
          : "9Router settings were not saved"
      )
    }
  }
}

/** A stored entry written back unchanged: its key stays as stored. */
function keepSecret(connection: NineRouterConnection): Record<string, unknown> {
  const { api_key: _apiKey, ...rest } = connection
  return rest
}

function requireBaseUrl(raw: string): string {
  const baseUrl = normalizeNineRouterBaseUrl(raw)
  if (!baseUrl)
    throw new HttpError(
      400,
      "Enter the 9Router address, for example http://localhost:20128/v1"
    )
  return baseUrl
}

function dedupeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
}

function portOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  } catch {
    return ""
  }
}
