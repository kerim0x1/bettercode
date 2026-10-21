import { HttpError } from "../errors"
import { logger } from "../observability/logger"
import { boundedRedactedText } from "../observability/redact"
import { currentRequestId } from "../observability/requestContext"
export { HttpError } from "../errors"

export function httpError(
  statusCode: number,
  message: string,
  code?: string
): HttpError {
  return new HttpError(statusCode, message, code)
}

export function isHttpError(value: unknown): value is HttpError {
  return (
    value instanceof HttpError ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { statusCode?: unknown }).statusCode === "number" &&
      typeof (value as { message?: unknown }).message === "string")
  )
}

export function getHttpStatus(value: unknown): number {
  if (!isHttpError(value)) return 500
  return normalizeHttpStatus((value as { statusCode: number }).statusCode)
}

function normalizeHttpStatus(value: number): number {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : undefined
}

/**
 * Codes whose message is safe (and useful) to surface to the client even when
 * the error isn't a nominal `HttpError`. These are operational conditions with
 * bounded, non-sensitive messages — e.g. the turn-conflict a client hits when
 * it dispatches while a plan turn is still awaiting approval. Without this the
 * real reason is masked to the generic "<operation> failed" (which showed up
 * as a confusing "chat send failed" on plan Implement).
 */
const PUBLIC_MESSAGE_ERROR_CODES = new Set<string>([
  "turn_active",
  "provider_turn_capacity",
  "provider_session_capacity",
  "provider_instance_not_found",
  "git_remote_error",
  // `AgentWorkspaceUntrustedError` (provider/agent-permission-policy.ts) is a
  // duck-typed 403 whose message names only the refused operation; masking
  // it left users with "git commit failed" and no hint that trust was why.
  "workspace_untrusted",
])

function boundedPublicMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 300
    ? value
    : undefined
}

const LOG_MESSAGE_MAX_CHARS = 1_000
const LOG_STACK_MAX_CHARS = 4_000

/**
 * Server-side diagnostics for a failed request. The client only ever sees the
 * sanitized response below; the log keeps the redacted message (and, for a
 * 5xx, the stack and cause) so an unexpected failure can actually be traced.
 */
function errorDiagnostics(
  err: unknown,
  includeStack: boolean
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {}
  const reqId = currentRequestId()
  if (reqId) diagnostics.reqId = reqId
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof err === "object" &&
            err !== null &&
            typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : undefined
  if (message) {
    diagnostics.errorMessage = boundedRedactedText(
      message,
      LOG_MESSAGE_MAX_CHARS
    )
  }
  if (!includeStack || !(err instanceof Error)) return diagnostics
  if (typeof err.stack === "string" && err.stack.length > 0) {
    diagnostics.stack = boundedRedactedText(err.stack, LOG_STACK_MAX_CHARS)
  }
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) {
    diagnostics.cause = boundedRedactedText(
      cause.stack ?? `${cause.name}: ${cause.message}`,
      LOG_STACK_MAX_CHARS
    )
  }
  return diagnostics
}

/**
 * Convert any thrown value into a safe HTTP response shape.
 *
 * Only a nominal `HttpError` carries an explicitly public message. Duck-typed
 * service errors can preserve a bounded HTTP status and safe error code, but
 * their internal message is masked; every other failure becomes a generic
 * 500. The log line keeps the redacted message, the request id and, for a
 * 5xx, the stack, so the response stays generic without losing the cause.
 */
export function sanitizeError(
  err: unknown,
  operation: string,
  context: Record<string, unknown> = {}
): { message: string; statusCode: number; code?: string } {
  if (err instanceof HttpError) {
    const statusCode = normalizeHttpStatus(err.statusCode)
    const code = safeErrorCode(err.code)
    // A deliberate 4xx HttpError is a public, expected refusal; a 5xx one is
    // still the backend failing and must leave a trace.
    if (statusCode >= 500) {
      logger.error(
        {
          operation,
          ...context,
          statusCode,
          errorType: err.name,
          ...(code ? { errorCode: code } : {}),
          ...errorDiagnostics(err, true),
        },
        `${operation} failed`
      )
    }
    return { message: err.message, statusCode, code }
  }
  const internalCode =
    typeof err === "object" && err !== null
      ? safeErrorCode((err as { code?: unknown }).code)
      : undefined
  // A 4xx is the caller being told no (bad input, unregistered root, a
  // conflict); only a 5xx is the backend failing. Logging both at ERROR
  // buried real failures under expected refusals.
  const statusForLog = getHttpStatus(err)
  const isServerFailure = statusForLog >= 500
  const log = isServerFailure ? logger.error : logger.warn
  log(
    {
      operation,
      ...context,
      statusCode: statusForLog,
      errorType: err instanceof Error ? err.name : typeof err,
      ...(internalCode ? { errorCode: internalCode } : {}),
      ...errorDiagnostics(err, isServerFailure),
    },
    `${operation} failed`
  )
  if (isHttpError(err)) {
    const e = err as { statusCode: number; code?: unknown; message?: unknown }
    const code = safeErrorCode(e.code)
    const publicMessage =
      code && PUBLIC_MESSAGE_ERROR_CODES.has(code)
        ? boundedPublicMessage(e.message)
        : undefined
    return {
      message: publicMessage ?? `${operation} failed`,
      statusCode: normalizeHttpStatus(e.statusCode),
      code,
    }
  }
  return { message: `${operation} failed`, statusCode: 500 }
}
