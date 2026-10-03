import { createHash, randomUUID } from "node:crypto"
import type {
  ApiKeyInfo,
  ApiKeyPoolView,
  ApiKeyProvider,
  StoredApiKey,
} from "@betterc0de/schema"
import type { SettingsService } from "../settings/service"
import { getMasterKey } from "../settings/crypto"
import { HttpError } from "../errors"
import { getProvider, resolveProviderApiKey } from "../provider/catalog"

export interface ApiKeyCredential {
  readonly id: string
  readonly key: string
  readonly source: ApiKeyInfo["source"]
  readonly label: string
}
type Health = {
  status: "ready" | "invalid" | "quota" | "cooldown"
  message: string | null
  retryAt: number | null
  checkedAt: number
}
export interface ApiKeyFailure {
  readonly kind: "invalid" | "quota" | "cooldown" | "request"
  readonly message: string
  readonly retryAt: number | null
}

/** Provider messages may echo credentials. Only these fixed messages leave this module. */
export class ApiKeyRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApiKeyRequestError"
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}
function retryAt(
  error: Record<string, unknown>,
  now: number,
  fallback: number
): number {
  const headers = error.headers
  const get = (name: string): unknown =>
    headers instanceof Headers ? headers.get(name) : record(headers)[name]
  const millis = get("retry-after-ms")
  if (typeof millis === "string" && /^\d+(?:\.\d+)?$/.test(millis))
    return now + Number(millis)
  const after = get("retry-after")
  if (typeof after === "string") {
    if (/^\d+(?:\.\d+)?$/.test(after)) return now + Number(after) * 1000
    const date = Date.parse(after)
    if (Number.isFinite(date)) return Math.max(now, date)
  }
  return now + fallback
}

export function classifyApiKeyFailure(
  error: unknown,
  now = Date.now()
): ApiKeyFailure {
  const root = record(error)
  const outer = record(root.error)
  const body = Object.keys(record(outer.error)).length
    ? record(outer.error)
    : outer
  const code = String(body.code ?? root.code ?? body.type ?? root.type ?? "")
  const detail =
    `${code} ${String(body.message ?? root.message ?? "")}`.toLowerCase()
  const status = Number(root.status ?? (code === "overloaded_error" ? 529 : 0))
  // Request, policy, geographic and IP restrictions need user action, not account rotation.
  if (
    /country|region|policy|permission|ip.*(?:allowlist|not authorized)|blocked|forbidden/.test(
      detail
    ) ||
    status === 403
  )
    return {
      kind: "request",
      message:
        "The provider rejected access. Check account permissions and provider restrictions.",
      retryAt: null,
    }
  if (
    status === 402 ||
    /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit|billing_error|credit balance|spend limit|monthly.{0,20}(?:cap|limit)|insufficient.{0,20}(?:credit|balance)/.test(
      detail
    )
  )
    return {
      kind: "quota",
      message:
        "Credits or usage limit exhausted. Update billing, then retry this key.",
      retryAt: null,
    }
  if (
    status === 401 ||
    /authentication_error|invalid_api_key|incorrect api key/.test(detail)
  )
    return {
      kind: "invalid",
      message: "Authentication failed. Replace or check this key.",
      retryAt: null,
    }
  if (status === 429)
    return {
      kind: "cooldown",
      message: "Rate limited. Waiting before using this key again.",
      retryAt: retryAt(root, now, 30_000),
    }
  if (
    status === 408 ||
    status >= 500 ||
    /APIConnectionError|APIConnectionTimeoutError|APITimeoutError|TimeoutError/.test(
      String(root.name)
    ) ||
    /^(?:api_error|overloaded_error|timeout_error)$/.test(code) ||
    /fetch failed/.test(detail) ||
    /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)$/.test(
      String(record(root.cause).code)
    )
  )
    return {
      kind: "cooldown",
      message: "Temporary provider or connection failure.",
      retryAt: retryAt(root, now, 5_000),
    }
  return {
    kind: "request",
    message:
      "The API request failed. Check the selected model and request settings.",
    retryAt: null,
  }
}

/** Bound upstream error bodies; cancellation releases even an oversized response. */
export async function readApiKeyResponseError(
  response: Response
): Promise<{ status: number; headers: Headers; error: unknown }> {
  let error: unknown
  const reader = response.body?.getReader()
  if (reader) {
    try {
      let size = 0
      const chunks: Uint8Array[] = []
      while (size < 8_192) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 8_192) break
        chunks.push(next.value)
      }
      error = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      /* Status still identifies authentication and transient failures. */
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  return { status: response.status, headers: response.headers, error }
}

/** Shared by settings routes and API adapters; health never contains secrets or response bodies. */
export class ApiKeyPool {
  private readonly health = new Map<string, Health>()
  private readonly versions = new Map<string, number>()

  constructor(
    private readonly settings: Pick<
      SettingsService,
      "get" | "getPublic" | "update"
    >
  ) {}

  credentials(provider: ApiKeyProvider): ApiKeyCredential[] {
    const settings = this.settings.get()
    const config = settings.providers[provider]
    if (config.api_keys !== undefined)
      return config.api_keys.map((entry) => ({
        id: entry.id,
        key: entry.api_key,
        label: entry.label,
        source: "settings",
      }))
    const definition = getProvider(provider)
    const legacy = definition
      ? resolveProviderApiKey(definition, settings)
      : null
    if (!legacy) return []
    return [
      {
        id: "legacy",
        key: legacy.key,
        source:
          legacy.source.kind === "environment"
            ? "environment"
            : legacy.source.kind === "cliConfig"
              ? "cliConfig"
              : "settings",
        label:
          legacy.source.kind === "settings"
            ? "Existing key"
            : legacy.source.kind === "environment"
              ? "Environment key"
              : "CLI configuration key",
      },
    ]
  }

  private identity(
    provider: ApiKeyProvider,
    credential: ApiKeyCredential
  ): string {
    return `${provider}:${credential.id}:${createHash("sha256").update(credential.key).digest("hex")}`
  }

  private enabled(
    provider: ApiKeyProvider,
    credential: ApiKeyCredential
  ): boolean {
    const config = this.settings.get().providers[provider]
    return (
      credential.key.length > 0 &&
      config.enabled &&
      (config.api_keys?.find((key) => key.id === credential.id)?.enabled ??
        true)
    )
  }

  eligible(provider: ApiKeyProvider, credential: ApiKeyCredential): boolean {
    const health = this.health.get(this.identity(provider, credential))
    return (
      !health ||
      health.status === "ready" ||
      (health.status === "cooldown" &&
        health.retryAt !== null &&
        Date.now() >= health.retryAt)
    )
  }

  isReady(provider: ApiKeyProvider): boolean {
    return this.credentials(provider).some(
      (key) => this.enabled(provider, key) && this.eligible(provider, key)
    )
  }

  view(provider: ApiKeyProvider): ApiKeyPoolView {
    const config = this.settings.get().providers[provider]
    const publicConfig = record(
      record(this.settings.getPublic().providers)[provider]
    )
    return {
      provider,
      enabled: config.enabled,
      managed: config.api_keys !== undefined,
      keys: this.credentials(provider).map((key) => {
        const state = this.health.get(this.identity(provider, key))
        const publicEntry = Array.isArray(publicConfig.api_keys)
          ? publicConfig.api_keys.find((value) => record(value).id === key.id)
          : undefined
        const secret = record(
          record(publicEntry).api_key ?? publicConfig.api_key
        )
        const enabled =
          config.api_keys?.find((value) => value.id === key.id)?.enabled ?? true
        const cooling =
          state?.status === "cooldown" && (state.retryAt ?? 0) > Date.now()
        return {
          id: key.id,
          label: key.label,
          enabled,
          source: key.source,
          secret: {
            configured: Boolean(key.key),
            storage:
              secret.storage === "plaintext" || !getMasterKey()
                ? "plaintext"
                : "encrypted",
          },
          status: !enabled
            ? "disabled"
            : state?.status === "cooldown" && !cooling
              ? "untested"
              : (state?.status ?? "untested"),
          message: state?.message ?? null,
          retryAt: cooling ? (state?.retryAt ?? null) : null,
          checkedAt: state?.checkedAt ?? null,
        }
      }),
    }
  }

  snapshot(provider: ApiKeyProvider): ApiKeySession {
    const credentials = this.credentials(provider).filter((key) =>
      this.enabled(provider, key)
    )
    return new ApiKeySession(this, provider, credentials)
  }

  version(provider: ApiKeyProvider, credential: ApiKeyCredential): number {
    return this.versions.get(this.identity(provider, credential)) ?? 0
  }
  success(
    provider: ApiKeyProvider,
    credential: ApiKeyCredential,
    version?: number
  ): void {
    this.setHealth(
      provider,
      credential,
      { status: "ready", message: null, retryAt: null, checkedAt: Date.now() },
      version
    )
  }
  failure(
    provider: ApiKeyProvider,
    credential: ApiKeyCredential,
    error: unknown,
    version?: number
  ): ApiKeyFailure {
    const failure = classifyApiKeyFailure(error)
    if (failure.kind !== "request")
      this.setHealth(
        provider,
        credential,
        {
          status: failure.kind,
          message: failure.message,
          retryAt: failure.retryAt,
          checkedAt: Date.now(),
        },
        version
      )
    return failure
  }
  private setHealth(
    provider: ApiKeyProvider,
    credential: ApiKeyCredential,
    health: Health,
    version?: number
  ): void {
    if (version !== undefined && version !== this.version(provider, credential))
      return
    // Late completion from a removed/replaced credential must not update its replacement.
    if (
      this.credentials(provider).some(
        (current) =>
          this.identity(provider, current) ===
          this.identity(provider, credential)
      )
    ) {
      const id = this.identity(provider, credential)
      this.health.set(id, health)
      this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    }
  }
  reset(provider: ApiKeyProvider, id: string): ApiKeyPoolView {
    const key = this.requireKey(provider, id)
    const state = this.health.get(this.identity(provider, key))
    if (state?.status === "cooldown" && (state.retryAt ?? 0) > Date.now())
      throw new HttpError(
        409,
        "Wait for the provider's retry delay before checking this key."
      )
    this.health.delete(this.identity(provider, key))
    this.versions.set(
      this.identity(provider, key),
      this.version(provider, key) + 1
    )
    return this.view(provider)
  }
  requireKey(provider: ApiKeyProvider, id: string): ApiKeyCredential {
    const key = this.credentials(provider).find((value) => value.id === id)
    if (!key) throw new HttpError(404, "API key not found")
    return key
  }
  private editable(provider: ApiKeyProvider): StoredApiKey[] {
    const config = this.settings.get().providers[provider]
    if (config.api_keys !== undefined) return structuredClone(config.api_keys)
    return config.api_key?.trim()
      ? [
          {
            id: "legacy",
            label: "Existing key",
            enabled: true,
            api_key: config.api_key,
          },
        ]
      : []
  }
  private save(provider: ApiKeyProvider, keys: StoredApiKey[]): ApiKeyPoolView {
    this.settings.update({
      providers: { [provider]: { api_key: { clear: true }, api_keys: keys } },
    })
    const active = new Set(
      this.credentials(provider).map((key) => this.identity(provider, key))
    )
    for (const id of this.health.keys())
      if (id.startsWith(`${provider}:`) && !active.has(id))
        this.health.delete(id)
    return this.view(provider)
  }
  add(provider: ApiKeyProvider, label: string, key: string): ApiKeyPoolView {
    const keys = this.editable(provider)
    if (keys.length >= 20)
      throw new HttpError(
        400,
        "At most 20 API keys can be stored per provider."
      )
    if (keys.some((entry) => entry.api_key === key))
      throw new HttpError(409, "This key is already stored for this provider.")
    return this.save(provider, [
      ...keys,
      { id: randomUUID(), label, enabled: true, api_key: key },
    ])
  }
  useExternal(provider: ApiKeyProvider): ApiKeyPoolView {
    this.settings.update({
      providers: { [provider]: { api_key: { clear: true }, api_keys: null } },
    })
    for (const id of this.health.keys())
      if (id.startsWith(`${provider}:`)) this.health.delete(id)
    return this.view(provider)
  }
  update(
    provider: ApiKeyProvider,
    id: string,
    patch: { label?: string; enabled?: boolean; apiKey?: string }
  ): ApiKeyPoolView {
    const keys = this.editable(provider)
    const key = keys.find((entry) => entry.id === id)
    if (!key)
      throw new HttpError(
        400,
        "This key is supplied externally. Change its environment or CLI configuration."
      )
    if (
      patch.apiKey &&
      keys.some((entry) => entry.id !== id && entry.api_key === patch.apiKey)
    )
      throw new HttpError(409, "This key is already stored for this provider.")
    if (patch.label !== undefined) key.label = patch.label
    if (patch.enabled !== undefined) key.enabled = patch.enabled
    if (patch.apiKey !== undefined) key.api_key = patch.apiKey
    return this.save(provider, keys)
  }
  remove(provider: ApiKeyProvider, id: string): ApiKeyPoolView {
    const keys = this.editable(provider)
    if (!keys.some((key) => key.id === id))
      throw new HttpError(
        400,
        "Externally supplied keys cannot be removed here."
      )
    return this.save(
      provider,
      keys.filter((key) => key.id !== id)
    )
  }
  reorder(provider: ApiKeyProvider, ids: string[]): ApiKeyPoolView {
    const keys = this.editable(provider)
    if (
      ids.length !== keys.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !keys.some((key) => key.id === id))
    )
      throw new HttpError(400, "Specify each stored key exactly once.")
    return this.save(
      provider,
      ids.map((id) => keys.find((key) => key.id === id)!)
    )
  }
}

/** Immutable turn credentials. Each model request can fail over before receiving any response. */
export class ApiKeySession {
  private current = 0
  constructor(
    private readonly pool: ApiKeyPool,
    readonly provider: ApiKeyProvider,
    private readonly keys: readonly ApiKeyCredential[]
  ) {}

  async run<T>(
    operation: (key: ApiKeyCredential, started: () => void) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let failure: ApiKeyFailure | undefined
    for (let index = this.current; index < this.keys.length; index++) {
      signal?.throwIfAborted()
      const key = this.keys[index]
      if (!this.pool.eligible(this.provider, key)) continue
      let started = false
      const version = this.pool.version(this.provider, key)
      try {
        const result = await operation(key, () => {
          started = true
        })
        signal?.throwIfAborted()
        this.current = index
        this.pool.success(this.provider, key, version)
        return result
      } catch (error) {
        signal?.throwIfAborted()
        failure = this.pool.failure(this.provider, key, error, version)
        if (started || failure.kind === "request")
          throw new ApiKeyRequestError(failure.message)
      }
    }
    throw new ApiKeyRequestError(
      failure?.message ??
        "No API key is available. Check enabled keys, billing, and retry delays in Settings → Providers."
    )
  }
}
