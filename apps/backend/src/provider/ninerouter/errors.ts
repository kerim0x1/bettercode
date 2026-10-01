import type { ResolvedNineRouterConnection } from "./connections"

type RequestError = Error & {
  status?: number
  headers?: Headers | Record<string, string | null | undefined>
}

/**
 * Rewrites SDK failures in terms of the 9Router connection: which router,
 * what to do about it. Returns `null` for errors that are already specific
 * (an upstream model message, a tool failure).
 */
export function describeNineRouterError(
  error: unknown,
  connection: Pick<ResolvedNineRouterConnection, "name" | "baseUrl" | "apiKey">,
  modelId: string
): Error | null {
  if (!(error instanceof Error)) return null
  const requestError = error as RequestError
  const status =
    typeof requestError.status === "number" ? requestError.status : null
  const detail = upstreamDetail(error.message)
  const label = `9Router "${connection.name}"`
  let message: string | null = null
  if (status === null && isConnectionFailure(error)) {
    message = `${label} is not reachable at ${connection.baseUrl}. Start it with "npx 9router" or check the URL in Settings → Providers → 9Router.`
  } else if (status === 401 || status === 403) {
    message = connection.apiKey
      ? `${label} rejected the API key. Create a new key in the 9Router dashboard (Keys) and update it in Settings → Providers → 9Router.`
      : `${label} requires an API key. Create one in the 9Router dashboard (Keys) and add it in Settings → Providers → 9Router, or turn off "Require API key" in 9Router.`
  } else if (status === 404) {
    message = `${label} cannot route "${modelId}". Refresh the 9Router models or connect the matching account in the 9Router dashboard.${detail ? ` (${detail})` : ""}`
  } else if (status === 503 || status === 429) {
    const retry = retryAfterSeconds(requestError.headers)
    message = `Every account behind ${label} is rate-limited or unavailable for "${modelId}".${retry ? ` Try again in ${retry}s,` : " Try again shortly,"} or add a fallback combo in the 9Router dashboard.${detail ? ` (${detail})` : ""}`
  }
  if (!message) return null
  const described = new Error(message, { cause: error }) as RequestError
  if (status !== null) described.status = status
  return described
}

function isConnectionFailure(error: Error): boolean {
  const name = error.name.toLowerCase()
  const text = error.message.toLowerCase()
  return (
    name.includes("connection") ||
    text.includes("connection error") ||
    text.includes("econnrefused") ||
    text.includes("fetch failed") ||
    text.includes("enotfound")
  )
}

function upstreamDetail(message: string): string | null {
  // SDK messages look like "404 {json}" or "404 Model not found".
  const trimmed = message.replace(/^\d{3}\s*/, "").trim()
  if (!trimmed || trimmed.length > 300) return trimmed.slice(0, 300) || null
  return trimmed
}

function retryAfterSeconds(headers: RequestError["headers"]): number | null {
  if (!headers) return null
  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : (headers as Record<string, string | null | undefined>)["retry-after"]
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}
