import { logger } from "../../observability/logger"

export interface BetterC0deCompatClientInput {
  readonly baseUrl: string
  readonly directory: string
  readonly serverUsername?: string
  readonly serverPassword?: string
  /**
   * Current `opencode` wraps v2 inventory payloads in a
   * `{ location, data: [...] }` envelope instead of returning a bare array.
   * When set, the v2 list calls unwrap that envelope so callers still see a
   * plain array. Defaults to false (legacy BetterC0de compatibility).
   */
  readonly v2Envelope?: boolean
}

interface RoutingQuery extends Record<string, string | undefined> {
  readonly directory?: string
  readonly workspace?: string
}

interface RequestOptions {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE"
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly body?: Record<string, unknown>
  readonly signal?: AbortSignal
}

interface CallOptions {
  readonly signal?: AbortSignal
}

interface CompatResult<T = unknown> {
  readonly data?: T
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SSE_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 90_000
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024
const MAX_SSE_FRAME_BYTES = 1024 * 1024

export function createBetterC0deCompatHttpClient<TClient = unknown>(
  input: BetterC0deCompatClientInput
): TClient {
  const baseUrl = input.baseUrl.replace(/\/+$/g, "")
  const defaultRouting: RoutingQuery = {
    directory: input.directory,
  }
  const unwrapV2 = <T>(payload: T | undefined): T | undefined =>
    input.v2Envelope
      ? (unwrapV2Envelope(payload) as T | undefined)
      : payload

  const request = async <T = unknown>(
    options: RequestOptions
  ): Promise<CompatResult<T>> => {
    const deadline = createDeadlineSignal(
      options.signal,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "BetterC0de compatibility request timed out."
    )
    try {
      const response = await fetch(buildUrl(baseUrl, options.path, options.query), {
        method: options.method,
        headers: buildHeaders(input, Boolean(options.body)),
        body: options.body ? JSON.stringify(stripUndefined(options.body)) : undefined,
        signal: deadline.signal,
      })
      return await readJsonResponse<T>(response, deadline.signal)
    } finally {
      deadline.cleanup()
    }
  }

  const routingQuery = (parameters?: RoutingQuery | null): RoutingQuery => ({
    directory: parameters?.directory ?? defaultRouting.directory,
    ...(parameters?.workspace ? { workspace: parameters.workspace } : {}),
  })

  const splitRouting = <T extends Record<string, unknown> | undefined>(
    parameters: T
  ): {
    readonly query: RoutingQuery
    readonly body: Record<string, unknown>
  } => {
    const { directory, workspace, ...body } = (parameters ?? {}) as Record<
      string,
      unknown
    >
    return {
      query: routingQuery({
        directory: typeof directory === "string" ? directory : undefined,
        workspace: typeof workspace === "string" ? workspace : undefined,
      }),
      body,
    }
  }

  const sessionPath = (sessionID: unknown, suffix = ""): string =>
    `/session/${encodeSegment(requiredString(sessionID, "sessionID"))}${suffix}`

  const requestPath = (requestID: unknown, suffix: string): string =>
    `/${suffix}/${encodeSegment(requiredString(requestID, "requestID"))}`

  return {
    session: {
      create: (
        parameters?: Record<string, unknown>,
        options?: CallOptions
      ) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: "/session",
          query,
          body,
          signal: options?.signal,
        })
      },
      prompt: (parameters: Record<string, unknown>, options?: CallOptions) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: sessionPath(parameters.sessionID, "/message"),
          query,
          body: omit(body, ["sessionID"]),
          signal: options?.signal,
        })
      },
      promptAsync: (
        parameters: Record<string, unknown>,
        options?: CallOptions
      ) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: sessionPath(parameters.sessionID, "/prompt_async"),
          query,
          body: omit(body, ["sessionID"]),
          signal: options?.signal,
        })
      },
      delete: (parameters: Record<string, unknown>, options?: CallOptions) => {
        const { query } = splitRouting(parameters)
        return request({
          method: "DELETE",
          path: sessionPath(parameters.sessionID),
          query,
          signal: options?.signal,
        })
      },
      abort: (parameters: Record<string, unknown>) => {
        const { query } = splitRouting(parameters)
        return request({
          method: "POST",
          path: sessionPath(parameters.sessionID, "/abort"),
          query,
        })
      },
      messages: (parameters: Record<string, unknown>) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "GET",
          path: sessionPath(parameters.sessionID, "/message"),
          query: { ...query, ...omit(body, ["sessionID"]) },
        })
      },
      revert: (parameters: Record<string, unknown>) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: sessionPath(parameters.sessionID, "/revert"),
          query,
          body: omit(body, ["sessionID"]),
        })
      },
    },
    event: {
      subscribe: async (
        parameters?: RoutingQuery,
        options?: { readonly signal?: AbortSignal }
      ) => ({
        stream: streamSseEvents(
          buildUrl(baseUrl, "/event", routingQuery(parameters)),
          buildHeaders(input, false),
          options?.signal
        ),
      }),
    },
    permission: {
      reply: (parameters: Record<string, unknown>) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: `${requestPath(parameters.requestID, "permission")}/reply`,
          query,
          body: omit(body, ["requestID"]),
        })
      },
    },
    question: {
      reply: (parameters: Record<string, unknown>) => {
        const { query, body } = splitRouting(parameters)
        return request({
          method: "POST",
          path: `${requestPath(parameters.requestID, "question")}/reply`,
          query,
          body: omit(body, ["requestID"]),
        })
      },
      reject: (parameters: Record<string, unknown>) => {
        const { query } = splitRouting(parameters)
        return request({
          method: "POST",
          path: `${requestPath(parameters.requestID, "question")}/reject`,
          query,
        })
      },
    },
    provider: {
      list: (parameters?: RoutingQuery) =>
        request({
          method: "GET",
          path: "/provider",
          query: routingQuery(parameters),
        }),
    },
    v2: {
      model: {
        list: (parameters?: {
          readonly location?: { readonly directory?: string; readonly workspace?: string }
        }) =>
          request({
            method: "GET",
            path: "/api/model",
            query: locationQuery(parameters?.location, defaultRouting),
          }).then((result: CompatResult<unknown>) => ({
            data: unwrapV2(result.data),
          })),
      },
      provider: {
        list: (parameters?: {
          readonly location?: { readonly directory?: string; readonly workspace?: string }
        }) =>
          request({
            method: "GET",
            path: "/api/provider",
            query: locationQuery(parameters?.location, defaultRouting),
          }).then((result: CompatResult<unknown>) => ({
            data: unwrapV2(result.data),
          })),
      },
    },
    app: {
      agents: (parameters?: RoutingQuery) =>
        request({
          method: "GET",
          path: "/agent",
          query: routingQuery(parameters),
        }),
      skills: (parameters?: RoutingQuery) =>
        request({
          method: "GET",
          path: "/skill",
          query: routingQuery(parameters),
        }),
    },
    command: {
      list: (parameters?: RoutingQuery) =>
        request({
          method: "GET",
          path: "/command",
          query: routingQuery(parameters),
        }),
    },
    tool: {
      list: (parameters: {
        readonly directory?: string
        readonly workspace?: string
        readonly provider: string
        readonly model: string
      }) =>
        request({
          method: "GET",
          path: "/experimental/tool",
          query: {
            ...routingQuery(parameters),
            provider: parameters.provider,
            model: parameters.model,
          },
        }),
      ids: (parameters?: RoutingQuery) =>
        request({
          method: "GET",
          path: "/experimental/tool/ids",
          query: routingQuery(parameters),
        }),
    },
  } as TClient
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, unknown>
): string {
  const url = new URL(path, `${baseUrl}/`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item))
      continue
    }
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function buildHeaders(
  input: BetterC0deCompatClientInput,
  hasBody: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  }
  if (hasBody) headers["Content-Type"] = "application/json"
  if (input.serverPassword) {
    headers.Authorization = `Basic ${Buffer.from(
      `${input.serverUsername ?? "betterc0de"}:${input.serverPassword}`,
      "utf8"
    ).toString("base64")}`
  }
  return headers
}

async function readJsonResponse<T>(
  response: Response,
  signal?: AbortSignal
): Promise<CompatResult<T>> {
  const text = await readResponseTextLimited(
    response,
    MAX_JSON_RESPONSE_BYTES,
    signal
  )
  const parsed: ParsedJson =
    text.trim().length > 0 ? parseJson(text) : { ok: true, value: undefined }
  const data = parsed.ok ? parsed.value : undefined
  if (!response.ok) {
    const error = new Error(
      response.statusText || `HTTP request failed with ${response.status}`
    ) as Error & {
      response?: { status: number }
      data?: unknown
      body?: unknown
    }
    error.response = { status: response.status }
    error.data = data
    error.body = data ?? text
    throw error
  }
  if (!parsed.ok) {
    throw new Error(
      `BetterC0de compatibility server returned a ${response.status} response that was not JSON.`
    )
  }
  return { data: data as T | undefined }
}

async function* streamSseEvents(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): AsyncIterable<unknown> {
  const connection = createDeadlineSignal(
    signal,
    DEFAULT_SSE_CONNECT_TIMEOUT_MS,
    "BetterC0de compatibility event connection timed out."
  )
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        Accept: "text/event-stream",
      },
      signal: connection.signal,
    })
    connection.clearTimer()
    if (!response.ok) {
      await readJsonResponse(response, connection.signal)
      return
    }
    if (!response.body) return

    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let skipNextLf = false
    let dataLines: string[] = []
    let frameBytes = 0

    const emit = function* () {
      if (dataLines.length === 0) return
      const data = dataLines.join("\n")
      dataLines = []
      frameBytes = 0
      if (data === "[DONE]") return
      const parsed = parseJson(data)
      if (!parsed.ok) {
        // A malformed frame is dropped rather than surfaced as a string the
        // event loop would try to read `.type` off.
        logger.warn(
          { bytes: Buffer.byteLength(data, "utf8"), preview: data.slice(0, 120) },
          "BetterC0de compatibility SSE frame was not valid JSON; skipped"
        )
        return
      }
      yield parsed.value
    }

    while (true) {
      const { value, done } = await readWithIdleTimeout(
        reader,
        connection.signal,
        DEFAULT_SSE_IDLE_TIMEOUT_MS
      )
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (skipNextLf && buffer.length > 0) {
        if (buffer.startsWith("\n")) buffer = buffer.slice(1)
        skipNextLf = false
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
        throw new Error("BetterC0de compatibility SSE buffer exceeded limit.")
      }
      let newlineIndex = findNewlineIndex(buffer)
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "")
        skipNextLf = buffer[newlineIndex] === "\r" && newlineIndex === buffer.length - 1
        buffer = buffer.slice(
          buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n"
            ? newlineIndex + 2
            : newlineIndex + 1
        )
        if (line === "") {
          yield* emit()
        } else if (line.startsWith("data:")) {
          const dataLine = line.slice(5).trimStart()
          frameBytes += Buffer.byteLength(line, "utf8") + 1
          if (frameBytes > MAX_SSE_FRAME_BYTES) {
            throw new Error(
              "BetterC0de compatibility SSE frame exceeded limit."
            )
          }
          dataLines.push(dataLine)
        }
        newlineIndex = findNewlineIndex(buffer)
      }
    }
    if (buffer.trim().length > 0 && buffer.startsWith("data:")) {
      const dataLine = buffer.slice(5).trimStart()
      frameBytes += Buffer.byteLength(buffer, "utf8") + 1
      if (frameBytes > MAX_SSE_FRAME_BYTES) {
        throw new Error("BetterC0de compatibility SSE frame exceeded limit.")
      }
      dataLines.push(dataLine)
    }
    yield* emit()
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    connection.cleanup()
  }
}

function createDeadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message: string
): {
  readonly signal: AbortSignal
  readonly clearTimer: () => void
  readonly cleanup: () => void
} {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) {
    onAbort()
  } else {
    parent?.addEventListener("abort", onAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error(message))
  }, timeoutMs)
  timer.unref?.()
  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }
  return {
    signal: controller.signal,
    clearTimer,
    cleanup: () => {
      clearTimer()
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await readWithIdleTimeout(
        reader,
        signal,
        DEFAULT_REQUEST_TIMEOUT_MS
      )
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        throw new Error(
          `BetterC0de compatibility response exceeded ${maxBytes} bytes.`
        )
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: Uint8Array }
> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("BetterC0de compatibility request aborted.")
    )
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () =>
      finish(() =>
        reject(
          signal?.reason ??
            new Error("BetterC0de compatibility request aborted.")
        )
      )
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error("BetterC0de compatibility response idle timeout.")
          )
        ),
      timeoutMs
    )
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error))
    )
  })
}

function locationQuery(
  location: { readonly directory?: string; readonly workspace?: string } | undefined,
  fallback: RoutingQuery
): Record<string, string> {
  return {
    "location[directory]": location?.directory ?? fallback.directory ?? "",
    ...(location?.workspace ?? fallback.workspace
      ? { "location[workspace]": location?.workspace ?? fallback.workspace ?? "" }
      : {}),
  }
}

/**
 * Current `opencode` wraps its v2 list payloads in `{ location, data }`.
 * Older builds (and BetterC0de's compatibility CLI) return the array
 * directly, so tolerate both.
 */
function unwrapV2Envelope(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "data" in value
  ) {
    return (value as { data: unknown }).data
  }
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Missing required BetterC0de compatibility field: ${name}.`)
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as T
}

function omit<T extends Record<string, unknown>>(
  input: T,
  keys: ReadonlyArray<string>
): Record<string, unknown> {
  const blocked = new Set(keys)
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !blocked.has(key) && value !== undefined
    )
  )
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/**
 * Never hands the raw text back as if it were the parsed document: a caller
 * that then reads `data.id` off a string gets `undefined` and fails one step
 * later with no hint that the server sent something that was not JSON.
 */
function parseJson(value: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

function findNewlineIndex(value: string): number {
  const unix = value.indexOf("\n")
  const classic = value.indexOf("\r")
  if (unix < 0) return classic
  if (classic < 0) return unix
  return Math.min(unix, classic)
}
