import {
  REMOTE_CLIENT_HEADER,
  formatRemoteClientHeader,
  type RemoteClientInfo,
} from "@betterc0de/schema/remote-protocol"
import { normalizeBaseUrl } from "@/lib/endpoint"

/** Default for a call; slow operations pass their own `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 20_000

export interface RemoteApiErrorDetails {
  /** From `Retry-After`, when the desktop throttled the request. */
  readonly retryAfterMs?: number
  /** With `client_update_required`: the oldest app the desktop serves. */
  readonly minClientVersion?: string
}

/**
 * A refused or failed request. `status` is 0 when no HTTP answer arrived;
 * `code` is the desktop's machine-readable reason (see "Phone app and
 * desktop versions" in docs/remote-access.md), or `timeout` / `network`.
 */
export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: RemoteApiErrorDetails = {}
  ) {
    super(message)
    this.name = "RemoteApiError"
  }
}

export interface HttpConnection {
  readonly baseUrl: string
  /** `null` before pairing. */
  readonly token: string | null
  /** Sent as `X-BetterC0de-Client` so the desktop can refuse too-old apps. */
  readonly client: RemoteClientInfo | null
  /** Injected in tests; the platform `fetch` otherwise. */
  readonly fetch?: typeof fetch
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HttpResult<T> {
  readonly status: number
  readonly headers: Headers
  readonly data: T
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("Retry-After")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/** One request against `/api/v1`; a 204 resolves with `data: undefined`. */
export async function httpRequest<T>(
  connection: HttpConnection,
  path: string,
  options: RequestOptions = {}
): Promise<HttpResult<T>> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
  const fetchImpl = connection.fetch ?? fetch
  try {
    const response = await fetchImpl(
      `${normalizeBaseUrl(connection.baseUrl)}/api/v1${path.startsWith("/") ? path : `/${path}`}`,
      {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(connection.token
            ? { Authorization: `Bearer ${connection.token}` }
            : {}),
          ...(connection.client
            ? {
                [REMOTE_CLIENT_HEADER]: formatRemoteClientHeader(
                  connection.client
                ),
              }
            : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      }
    )
    if (response.status === 204) {
      return { status: 204, headers: response.headers, data: undefined as T }
    }
    const payload = (await response.json().catch(() => null)) as unknown
    if (!response.ok) {
      const body =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {}
      throw new RemoteApiError(
        typeof body.error === "string"
          ? body.error
          : `Desktop request failed (${response.status}).`,
        response.status,
        typeof body.code === "string" ? body.code : undefined,
        {
          retryAfterMs: retryAfterMs(response.headers),
          ...(typeof body.minClientVersion === "string"
            ? { minClientVersion: body.minClientVersion }
            : {}),
        }
      )
    }
    return {
      status: response.status,
      headers: response.headers,
      data: payload as T,
    }
  } catch (error) {
    if (error instanceof RemoteApiError) throw error
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new RemoteApiError(
        "The desktop did not answer in time.",
        0,
        "timeout"
      )
    }
    if (options.signal?.aborted) {
      throw new RemoteApiError("The request was cancelled.", 0, "cancelled")
    }
    throw new RemoteApiError(
      error instanceof Error ? error.message : "The desktop is unreachable.",
      0,
      "network"
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

/** The response body only. */
export async function httpJson<T>(
  connection: HttpConnection,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  return (await httpRequest<T>(connection, path, options)).data
}
