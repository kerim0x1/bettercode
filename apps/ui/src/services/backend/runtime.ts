import type {
  BackendMode,
  BackendTransport,
  RequestOptions,
  RuntimeConfig,
} from "./types"
import { HttpError, TimeoutError, AppError } from "@/lib/errors"

const BACKEND_MODE_STORAGE_KEY = "betterc0de.backend.mode"
const REMOTE_BASE_URL_STORAGE_KEY = "betterc0de.remote.baseUrl"
const REMOTE_TOKEN_STORAGE_KEY = "betterc0de.remote.token"
const REMOTE_WS_URL_STORAGE_KEY = "betterc0de.remote.wsUrl"

let cachedConfig: RuntimeConfig | null = null
let cachedTransport: { mode: BackendMode; transport: BackendTransport } | null =
  null
let inMemoryRemoteToken: string | null = null
let observedWindow: Window | null = null
let unsubscribeBackendStatus: (() => void) | undefined
let backendUnavailable = false

/** One-shot waiters from {@link whenBackendReady}. */
const backendReadyWaiters = new Set<(port: number) => void>()
/** Persistent listeners from {@link onBackendReady}. */
const backendReadyListeners = new Set<(port: number) => void>()

function observeLocalBackendStatus() {
  if (observedWindow === window) return
  unsubscribeBackendStatus?.()
  observedWindow = window
  backendUnavailable = false
  unsubscribeBackendStatus = window.electronAPI?.onBackendStatus?.((value) => {
    if (!value || typeof value !== "object") return
    const event = value as { status?: string; port?: number }
    if (
      event.status === "ready" &&
      typeof event.port === "number" &&
      event.port > 0
    ) {
      backendUnavailable = false
      const previous = window.__BETTERC0DE__ ??
        cachedConfig ?? { mode: "local_sidecar" }
      window.__BETTERC0DE__ = { ...previous, port: event.port }
      cachedConfig = null
      flushBackendReadyWaiters()
      for (const listener of [...backendReadyListeners]) {
        try {
          listener(event.port)
        } catch (error) {
          console.error("[backend] backend-ready listener failed:", error)
        }
      }
    } else if (
      ["failed", "restarting", "stopped"].includes(event.status ?? "")
    ) {
      backendUnavailable = true
      cachedConfig = null
    }
  })
}

function injectedBackendPort(): number | null {
  if (typeof window === "undefined") return null
  const port = window.__BETTERC0DE__?.port
  return typeof port === "number" && Number.isFinite(port) && port > 0
    ? port
    : null
}

/** The port to talk to, or null while the local backend is not reachable. */
function readyBackendPort(): number | null {
  if (backendUnavailable && getBackendMode() !== "remote_http") return null
  return injectedBackendPort()
}

function flushBackendReadyWaiters() {
  if (backendReadyWaiters.size === 0) return
  const port = readyBackendPort()
  if (port === null) return
  const waiters = [...backendReadyWaiters]
  backendReadyWaiters.clear()
  for (const resolve of waiters) resolve(port)
}

const RUNTIME_CONFIG_KEY = "__BETTERC0DE__"
let watchedConfigWindow: Window | null = null
let configInjectionWatched = false
let restoreConfigProperty: (() => void) | undefined

/**
 * The backend port reaches the renderer in two ways: the `backend:status`
 * "ready" event, and the `getRuntimeConfig` IPC reply, which
 * `initDesktopRuntimeConfig` (desktop-runtime-config.ts) publishes by
 * assigning `window.__BETTERC0DE__`; later "ready" events reassign it. A
 * waiter registered here can miss the event (it fired before this module
 * subscribed) or start before the IPC reply arrives, so the assignment is
 * observed too. An accessor keeps the property a plain value for every reader
 * and writer; it only adds the notification.
 */
function watchRuntimeConfigInjection(): boolean {
  if (typeof window === "undefined") return false
  if (watchedConfigWindow === window) return configInjectionWatched
  restoreConfigProperty?.()
  restoreConfigProperty = undefined
  watchedConfigWindow = window
  configInjectionWatched = false
  const target = window
  const descriptor = Object.getOwnPropertyDescriptor(target, RUNTIME_CONFIG_KEY)
  // Another accessor (or a frozen value) is not ours to replace.
  if (
    descriptor &&
    (!descriptor.configurable || descriptor.get || descriptor.set)
  ) {
    return false
  }
  let current = target.__BETTERC0DE__
  try {
    Object.defineProperty(target, RUNTIME_CONFIG_KEY, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (next: typeof current) => {
        current = next
        flushBackendReadyWaiters()
      },
    })
  } catch {
    return false
  }
  restoreConfigProperty = () => {
    Object.defineProperty(target, RUNTIME_CONFIG_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: current,
    })
  }
  configInjectionWatched = true
  return true
}

/**
 * Resolves with the backend port once the backend can take requests: right
 * away when the shell already published it, otherwise on the shell's "ready"
 * signal. Replaces fixed-interval polling for `window.__BETTERC0DE__.port`.
 * Remote runtimes resolve immediately; their requests do not use the port.
 * Rejects only when `signal` aborts.
 */
export function whenBackendReady(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Backend wait cancelled"))
  }
  if (typeof window === "undefined") return Promise.resolve(3773)
  if (getBackendMode() === "remote_http") {
    return Promise.resolve(injectedBackendPort() ?? 0)
  }
  if (!window.electronAPI?.onBackendStatus) {
    // No shell (a plain browser page): nothing will announce a port, so use
    // the same fallback as getConfig() instead of waiting forever.
    return Promise.resolve(injectedBackendPort() ?? 3773)
  }
  observeLocalBackendStatus()
  const watching = watchRuntimeConfigInjection()
  const port = readyBackendPort()
  if (port !== null) return Promise.resolve(port)

  return new Promise<number>((resolve, reject) => {
    let fallbackTimer: ReturnType<typeof setInterval> | undefined
    const cleanup = () => {
      backendReadyWaiters.delete(waiter)
      if (fallbackTimer) clearInterval(fallbackTimer)
      signal?.removeEventListener("abort", onAbort)
    }
    const waiter = (readyPort: number) => {
      cleanup()
      resolve(readyPort)
    }
    const onAbort = () => {
      cleanup()
      reject(new Error("Backend wait cancelled"))
    }
    backendReadyWaiters.add(waiter)
    signal?.addEventListener("abort", onAbort, { once: true })
    // Without the property watch (it is owned by something else) the event
    // remains the primary signal; a slow check covers a missed event.
    if (!watching) fallbackTimer = setInterval(flushBackendReadyWaiters, 500)
  })
}

/**
 * Calls `listener` with the port every time the shell reports that the local
 * backend (re)started. Used to reconnect at once instead of waiting out a
 * backoff timer. Returns an unsubscribe function.
 */
export function onBackendReady(listener: (port: number) => void): () => void {
  if (typeof window !== "undefined") observeLocalBackendStatus()
  backendReadyListeners.add(listener)
  return () => {
    backendReadyListeners.delete(listener)
  }
}

function requireLocalBackendAvailable() {
  observeLocalBackendStatus()
  if (backendUnavailable && getBackendMode() !== "remote_http") {
    throw new AppError(
      "Local backend is unavailable. Waiting for it to restart.",
      {
        code: "BACKEND_UNAVAILABLE",
      }
    )
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeBackendStatus?.()
    observedWindow = null
    // The next module instance installs its own accessor.
    restoreConfigProperty?.()
    restoreConfigProperty = undefined
    watchedConfigWindow = null
    configInjectionWatched = false
  })
}

function isProdBuild() {
  return (
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.MODE === "production"
  )
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`
}

export function readLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalStorage(key: string, value: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore storage write failures
  }
}

function removeLocalStorage(key: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore storage removal failures
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  )
}

function isRuntimeSameOrigin(parsed: URL): boolean {
  if (typeof window === "undefined") return false
  if (window.__BETTERC0DE__?.mode !== "remote_http") return false
  try {
    return parsed.origin === window.location.origin
  } catch {
    return false
  }
}

function secureRemoteUrl(
  raw: string,
  protocols: readonly string[],
  label: string
): string {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new AppError(`${label} is not a valid URL`)
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new AppError(
      `${label} must use ${protocols.map((value) => value.replace(":", "")).join(" or ")}`
    )
  }
  if (parsed.username || parsed.password) {
    throw new AppError(`${label} must not contain URL credentials`)
  }
  const encrypted = parsed.protocol === "https:" || parsed.protocol === "wss:"
  if (
    !encrypted &&
    !isLoopbackHostname(parsed.hostname) &&
    !isRuntimeSameOrigin(parsed)
  ) {
    throw new AppError(
      `${label} must use encrypted transport outside localhost`
    )
  }
  return parsed.toString().replace(/\/+$/, "")
}

function normalizeBackendMode(value?: string | null): BackendMode {
  if (!value) return "local_sidecar"
  const normalized = value.trim().toLowerCase()
  if (normalized === "remote" || normalized === "remote_http") {
    return "remote_http"
  }
  return "local_sidecar"
}

export function getBackendMode(): BackendMode {
  if (
    typeof window !== "undefined" &&
    window.__BETTERC0DE__?.mode === "remote_http"
  ) {
    return "remote_http"
  }
  return normalizeBackendMode(readLocalStorage(BACKEND_MODE_STORAGE_KEY))
}

export function isRemoteRuntime(): boolean {
  return getBackendMode() === "remote_http"
}

export function configureRemoteBackend(config: {
  baseUrl: string
  token?: string
  wsUrl?: string
}): void {
  const nextBaseUrl = secureRemoteUrl(
    config.baseUrl,
    ["http:", "https:"],
    "Remote backend URL"
  )
  const nextWsUrl =
    config.wsUrl === undefined
      ? undefined
      : secureRemoteUrl(config.wsUrl, ["ws:", "wss:"], "Remote WebSocket URL")
  if (nextWsUrl !== undefined) {
    const wsCredentialOrigin = new URL(nextWsUrl)
    wsCredentialOrigin.protocol =
      wsCredentialOrigin.protocol === "wss:" ? "https:" : "http:"
    if (wsCredentialOrigin.origin !== new URL(nextBaseUrl).origin) {
      throw new AppError(
        "Remote WebSocket URL must use the same credential origin as the remote backend URL"
      )
    }
  }
  const previousBaseUrl = readLocalStorage(REMOTE_BASE_URL_STORAGE_KEY)
  const originChanged = Boolean(
    previousBaseUrl &&
    new URL(previousBaseUrl).origin !== new URL(nextBaseUrl).origin
  )
  if (originChanged) {
    inMemoryRemoteToken = ""
    removeLocalStorage(REMOTE_TOKEN_STORAGE_KEY)
    removeLocalStorage(REMOTE_WS_URL_STORAGE_KEY)
  }
  writeLocalStorage(REMOTE_BASE_URL_STORAGE_KEY, nextBaseUrl)
  if (config.token !== undefined) {
    inMemoryRemoteToken = config.token
    removeLocalStorage(REMOTE_TOKEN_STORAGE_KEY)
  }
  if (nextWsUrl !== undefined) {
    writeLocalStorage(REMOTE_WS_URL_STORAGE_KEY, nextWsUrl)
  }
  cachedTransport = null
}

export function getConfig(): RuntimeConfig {
  requireLocalBackendAvailable()
  const injected = window.__BETTERC0DE__
  if (injected?.port) {
    if (!sameRuntimeConfig(cachedConfig, injected)) {
      cachedConfig = injected
    }
    return injected
  }
  if (cachedConfig) return cachedConfig
  return { port: 3773, mode: "electron" }
}

export async function waitForConfig(): Promise<RuntimeConfig> {
  requireLocalBackendAvailable()
  const injected = window.__BETTERC0DE__
  if (injected?.port) {
    if (!sameRuntimeConfig(cachedConfig, injected)) {
      cachedConfig = injected
    }
    return injected
  }
  if (cachedConfig) return cachedConfig

  // Wait for the shell to publish the port (bounded, so a renderer without a
  // shell still falls back to the default) instead of polling for it.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    await whenBackendReady(controller.signal)
  } catch {
    // Timed out: fall through to the defaults below.
  } finally {
    clearTimeout(timer)
  }
  requireLocalBackendAvailable()
  if (window.__BETTERC0DE__?.port) {
    cachedConfig = window.__BETTERC0DE__
    return cachedConfig
  }

  return getConfig()
}

function getRemoteConfig() {
  return {
    baseUrl: getRemoteBaseUrl(),
    // Backend-served remote pages authenticate only through their HttpOnly
    // session cookie. Never carry a legacy JS bearer into that trust model.
    token:
      typeof window !== "undefined" &&
      window.__BETTERC0DE__?.mode === "remote_http"
        ? ""
        : getRemoteToken(),
  }
}

function sameRuntimeConfig(
  current: RuntimeConfig | null,
  next: RuntimeConfig
): boolean {
  return (
    current?.port === next.port &&
    current?.mode === next.mode &&
    current?.baseUrl === next.baseUrl &&
    current?.electronPath === next.electronPath &&
    current?.previewPartition === next.previewPartition
  )
}

export function getRemoteBaseUrl(): string | null {
  if (
    typeof window !== "undefined" &&
    window.__BETTERC0DE__?.mode === "remote_http"
  ) {
    return window.__BETTERC0DE__.baseUrl || window.location.origin
  }
  return readLocalStorage(REMOTE_BASE_URL_STORAGE_KEY)
}

function parseJsonResponse<T>(response: Response): Promise<T> {
  return response.text().then((text) => {
    if (!text) return undefined as T
    return JSON.parse(text) as T
  })
}

/**
 * Reads the body of a non-OK response and turns it into the clearest
 * error message we can produce.  The backend now returns a uniform
 * `{ error: string }` JSON envelope on every failure path; older builds
 * and remote proxies may still return plain text.  Both are handled.
 */
/**
 * The backend's `{ error, code? }` failure body. `code` is the nominal
 * error id (`remote_terminal_disabled`, `workspace_not_registered`, …) and
 * rides on the thrown `HttpError` so callers can branch on it instead of
 * on the human-readable message.
 */
async function extractErrorDetails(
  response: Response
): Promise<{ message: string; code?: string }> {
  const fallback = `HTTP ${response.status}`
  let text = ""
  try {
    text = await response.text()
  } catch {
    return { message: fallback }
  }
  if (!text) return { message: fallback }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
    if (parsed && typeof parsed.error === "string" && parsed.error.length > 0) {
      return {
        message: parsed.error,
        ...(typeof parsed.code === "string" && parsed.code.length > 0
          ? { code: parsed.code }
          : {}),
      }
    }
  } catch {
    // Not JSON — fall through to returning the raw body text.
  }
  return { message: text }
}

// Default per-request timeout for non-streaming sidecar/remote calls. The
// backend can hang (deadlock, crashed adapter, blocked DB) and without this
// cap the renderer would wait forever on any UI action that invoke()s the
// backend. Callers can override via RequestOptions.timeoutMs.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Build a single AbortSignal that aborts when EITHER the caller-provided
 * signal fires OR the timeout elapses. Returns a cleanup function the caller
 * MUST invoke on success paths so the timer doesn't leak.
 */
function composeTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort(new DOMException("Request timed out", "TimeoutError"))
  }, timeoutMs)

  const onCallerAbort = () => {
    clearTimeout(timer)
    controller.abort(callerSignal?.reason)
  }
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer)
      controller.abort(callerSignal.reason)
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    },
    timedOut: () => didTimeOut,
  }
}

class LocalSidecarTransport implements BackendTransport {
  async request<T>(path: string, opts?: RequestOptions): Promise<T> {
    const config = await waitForConfig()
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
    }
    const method = opts?.method || "GET"
    const bodyAllowed = method !== "GET" && method !== "HEAD"
    const body =
      bodyAllowed && opts?.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined
    const normalizedPath = normalizePath(path)

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const { signal, cleanup, timedOut } = composeTimeoutSignal(
      opts?.signal,
      timeoutMs
    )

    try {
      // The backend mounts every route under /api/v1.  An earlier version
      // also retried on /api (unversioned) when v1 returned 404 — that
      // fallback silently masked contract drift between client and
      // backend, so it's gone.  If /api/v1 returns 404 the caller now
      // sees a hard failure, which is what we want.
      const doFetch = (runtimeConfig: RuntimeConfig) =>
        fetch(
          `http://127.0.0.1:${runtimeConfig.port}/api/v1${normalizedPath}`,
          {
            method,
            headers,
            body,
            signal,
          }
        )

      let response = await doFetch(config)
      if (response.status === 401 && isProdBuild()) {
        cachedConfig = null
        const refreshed = await waitForConfig()
        response = await doFetch(refreshed)
      }

      if (!response.ok) {
        const { message, code } = await extractErrorDetails(response)
        // Surface the backend's actual error string in DevTools console
        // alongside the network entry so debugging doesn't require
        // clicking through Network → Response. Important for 4xx/5xx
        // failures where the chat-bubble error catch would otherwise be
        // the only place the message lands. Soft-probe callers
        // (`silentStatuses`) opt out for expected misses.
        if (!opts?.silentStatuses?.includes(response.status)) {
          console.error(
            `[backend] ${method} ${path} → ${response.status}: ${message}`
          )
        }
        throw new HttpError(
          message,
          response.status,
          path,
          code ? { code } : undefined
        )
      }

      return await parseJsonResponse<T>(response)
    } catch (err) {
      if (timedOut()) {
        throw new TimeoutError(
          `Backend request timed out after ${timeoutMs}ms: ${path}`,
          timeoutMs,
          { cause: err }
        )
      }
      throw err
    } finally {
      cleanup()
    }
  }
}

class RemoteHttpTransport implements BackendTransport {
  async request<T>(path: string, opts?: RequestOptions): Promise<T> {
    const { baseUrl, token } = getRemoteConfig()
    if (!baseUrl) {
      throw new AppError(
        "Remote backend mode is enabled but no base URL is configured"
      )
    }
    const secureBaseUrl = secureRemoteUrl(
      baseUrl,
      ["http:", "https:"],
      "Remote backend URL"
    )

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const { signal, cleanup, timedOut } = composeTimeoutSignal(
      opts?.signal,
      timeoutMs
    )
    const method = opts?.method || "GET"
    const bodyAllowed = method !== "GET" && method !== "HEAD"

    try {
      const response = await fetch(
        `${secureBaseUrl}/api/v1${normalizePath(path)}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(opts?.headers || {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
          body:
            bodyAllowed && opts?.body !== undefined
              ? JSON.stringify(opts.body)
              : undefined,
          signal,
        }
      )

      if (!response.ok) {
        const { message, code } = await extractErrorDetails(response)
        // Surface the backend's actual error string in DevTools console
        // alongside the network entry so debugging doesn't require
        // clicking through Network → Response. Important for 4xx/5xx
        // failures where the chat-bubble error catch would otherwise be
        // the only place the message lands. Soft-probe callers
        // (`silentStatuses`) opt out for expected misses.
        if (!opts?.silentStatuses?.includes(response.status)) {
          console.error(
            `[backend] ${method} ${path} → ${response.status}: ${message}`
          )
        }
        throw new HttpError(
          message,
          response.status,
          path,
          code ? { code } : undefined
        )
      }

      return await parseJsonResponse<T>(response)
    } catch (err) {
      if (timedOut()) {
        throw new TimeoutError(
          `Remote backend request timed out after ${timeoutMs}ms: ${path}`,
          timeoutMs,
          { cause: err }
        )
      }
      throw err
    } finally {
      cleanup()
    }
  }
}

function getBackendTransport(): BackendTransport {
  const mode = getBackendMode()
  if (cachedTransport?.mode === mode) {
    return cachedTransport.transport
  }

  const transport =
    mode === "remote_http"
      ? new RemoteHttpTransport()
      : new LocalSidecarTransport()
  cachedTransport = { mode, transport }
  return transport
}

export async function openWorkspace(workspacePath: string): Promise<string> {
  // Through its shared contract (`workspaceOpen`), loaded on first use like
  // every contract. Not via `invokeContract`: that helper sends through this
  // module.
  const { requestHttpContract } =
    await import("@betterc0de/schema/http-contracts")
  const result = await requestHttpContract(
    "workspaceOpen",
    ({ path, method, body }) => invoke<unknown>(path, { method, body }),
    { body: { workspacePath } }
  )
  return result.path
}

export async function pickFolder(): Promise<string | null> {
  if (!window.electronAPI?.pickFolder) return null
  try {
    const folder = await window.electronAPI.pickFolder()
    // Publish the path only once metadata requests can use it safely.
    return folder ? await openWorkspace(folder) : null
  } catch (error) {
    const { handleError } = await import("@/lib/errors/handle")
    handleError(error, { source: "open-workspace" })
    return null
  }
}

/**
 * Whether the OS-native folder dialog is reachable (i.e. we run inside the
 * Electron shell). Callers use this to decide between the native picker and
 * the in-app System Browser fallback — in a plain browser `pickFolder`
 * resolves to `null`, which would silently do nothing.
 */
export function hasNativeFolderPicker(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI?.pickFolder
}

export function httpInvoke<T>(
  path: string,
  opts?: {
    method?: string
    body?: unknown
    signal?: AbortSignal
    timeoutMs?: number
    silentStatuses?: number[]
    /** Extra request headers (e.g. `clientInstanceRequestOptions()`). */
    headers?: Record<string, string>
  }
): Promise<T> {
  return getBackendTransport().request<T>(path, {
    method: opts?.method,
    body: opts?.body,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
    silentStatuses: opts?.silentStatuses,
    ...(opts?.headers ? { headers: opts.headers } : {}),
  })
}

export function invoke<T>(
  httpPath: string,
  opts?: {
    args?: Record<string, unknown>
    method?: string
    body?: unknown
    signal?: AbortSignal
    timeoutMs?: number
    silentStatuses?: number[]
    headers?: Record<string, string>
  }
): Promise<T> {
  return httpInvoke<T>(httpPath, {
    method: opts?.method,
    body: opts?.body ?? opts?.args,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
    silentStatuses: opts?.silentStatuses,
    ...(opts?.headers ? { headers: opts.headers } : {}),
  })
}

export function getRemoteToken(): string {
  if (inMemoryRemoteToken !== null) return inMemoryRemoteToken
  inMemoryRemoteToken = readLocalStorage(REMOTE_TOKEN_STORAGE_KEY) || ""
  removeLocalStorage(REMOTE_TOKEN_STORAGE_KEY)
  return inMemoryRemoteToken
}

export function buildRemoteWsUrl(): string {
  const explicit = readLocalStorage(REMOTE_WS_URL_STORAGE_KEY)
  const baseUrl = explicit || getRemoteBaseUrl()
  if (!baseUrl) {
    throw new Error(
      "Remote backend mode is enabled but no remote WebSocket URL is configured"
    )
  }

  const wsBase = explicit
    ? secureRemoteUrl(explicit, ["ws:", "wss:"], "Remote WebSocket URL")
    : secureRemoteUrl(baseUrl, ["http:", "https:"], "Remote backend URL")
        .replace(/^http/i, "ws")
        .replace(/\/+$/, "")
  return `${wsBase}/ws`
}
