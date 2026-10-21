import pino from "pino"
import { boundedRedactedText } from "./redact"

/**
 * Shared backend logger.
 *
 * Dev defaults to compact human-readable lines so Electron's console stays
 * usable while chat responses stream. Set `BETTERC0DE_LOG_FORMAT=json` when
 * structured logs are needed for ingestion.
 */
/**
 * Binding names whose values are credentials. Everything this logger writes
 * reaches the Electron app log and, when the user opted in, crash reports;
 * the main process redacts token-shaped text as well, this keeps obvious
 * fields from being printed in the first place.
 */
const SENSITIVE_BINDING =
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credentials?)$/i
const REDACTED_PATHS = [
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "cookie",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.password",
  "*.secret",
  "*.accessToken",
  "*.refreshToken",
  "*.access_token",
  "*.refresh_token",
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
]

const jsonLogger = pino(
  {
    level: normalizeLogLevel(process.env.LOG_LEVEL) ?? "info",
    base: { app: "betterc0de-backend" },
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  },
  pino.destination(2)
)

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"
type LogInput = Record<string, unknown> | string | Error | undefined
type LogFormat = "simple" | "json"

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
}

interface BackendLoggingSettings {
  readonly level: LogLevel
  readonly format: LogFormat
  readonly traceHttp: boolean
  readonly traceProviderEvents: boolean
}

let activeLoggingSettings: BackendLoggingSettings = {
  level: normalizeLogLevel(process.env.LOG_LEVEL) ?? "info",
  format: normalizeLogFormat(process.env.BETTERC0DE_LOG_FORMAT) ?? "simple",
  traceHttp: process.env.BETTERC0DE_TRACE_HTTP === "1",
  traceProviderEvents: process.env.BETTERC0DE_TRACE_PROVIDER_EVENTS === "1",
}

function normalizeLogLevel(value: string | undefined): LogLevel | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "fatal"
    ? normalized
    : null
}

function normalizeLogFormat(value: string | undefined): LogFormat | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === "simple" || normalized === "json" ? normalized : null
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return null
}

export function configureBackendLogging(
  settings: Record<string, unknown>
): void {
  activeLoggingSettings = {
    level:
      normalizeLogLevel(settings.backend_log_level as string | undefined) ??
      activeLoggingSettings.level,
    format:
      normalizeLogFormat(settings.backend_log_format as string | undefined) ??
      activeLoggingSettings.format,
    traceHttp:
      parseBoolean(settings.backend_trace_http) ??
      activeLoggingSettings.traceHttp,
    traceProviderEvents:
      parseBoolean(settings.backend_trace_provider_events) ??
      activeLoggingSettings.traceProviderEvents,
  }
  jsonLogger.level = activeLoggingSettings.level
}

export function getBackendLoggingSettings(): BackendLoggingSettings {
  return activeLoggingSettings
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[activeLoggingSettings.level]
}

function formatBindingValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === "object") {
    const maybeErr = value as {
      message?: unknown
      code?: unknown
      name?: unknown
    }
    if (typeof maybeErr.message === "string") return maybeErr.message
    if (typeof maybeErr.code === "string") return maybeErr.code
    if (typeof maybeErr.name === "string") return maybeErr.name
    return "{...}"
  }
  return String(value)
}

/** Bindings printed as indented blocks after the line, not inline. */
const DETAIL_BINDINGS = new Set(["stack", "cause"])
const DETAIL_MAX_CHARS = 8_000
const MAX_CAUSE_DEPTH = 3

function formatBindings(bindings: Record<string, unknown> | undefined): string {
  if (!bindings) return ""
  const pairs = Object.entries(bindings)
    .filter(
      ([key, value]) =>
        key !== "app" &&
        value !== undefined &&
        !(DETAIL_BINDINGS.has(key) && typeof value === "string")
    )
    .map(([key, value]) => {
      if (SENSITIVE_BINDING.test(key) && value !== null)
        return `${key}=[REDACTED]`
      const formatted = formatBindingValue(value)
      return formatted ? `${key}=${formatted}` : null
    })
    .filter((value): value is string => Boolean(value))
  return pairs.length > 0 ? ` ${pairs.join(" ")}` : ""
}

function errorChain(error: Error): string {
  const parts = [error.stack || `${error.name}: ${error.message}`]
  let cause: unknown = (error as { cause?: unknown }).cause
  for (
    let depth = 0;
    cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH;
    depth += 1
  ) {
    if (cause instanceof Error) {
      parts.push(
        `Caused by: ${cause.stack || `${cause.name}: ${cause.message}`}`
      )
      cause = (cause as { cause?: unknown }).cause
    } else {
      parts.push(`Caused by: ${String(cause)}`)
      break
    }
  }
  return parts.join("\n")
}

/**
 * Stack and cause details carried by a record: explicit `stack` / `cause`
 * string bindings (for example from http/errors.ts sanitizeError), and the
 * stack plus cause chain of Error values at error and fatal level. Printed
 * redacted and bounded, one indented block each, below the summary line.
 */
function formatDetails(
  level: LogLevel,
  input: LogInput,
  bindings: Record<string, unknown> | undefined
): string {
  const blocks: string[] = []
  const severe = LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.error
  if (input instanceof Error && severe) blocks.push(errorChain(input))
  if (bindings) {
    for (const [key, value] of Object.entries(bindings)) {
      if (DETAIL_BINDINGS.has(key) && typeof value === "string" && value) {
        blocks.push(`${key}: ${value}`)
      } else if (
        value instanceof Error &&
        severe &&
        !SENSITIVE_BINDING.test(key)
      ) {
        blocks.push(`${key}: ${errorChain(value)}`)
      }
    }
  }
  return blocks
    .map((block) =>
      boundedRedactedText(block, DETAIL_MAX_CHARS)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")
    )
    .map((block) => `\n${block}`)
    .join("")
}

function writeSimple(level: LogLevel, input: LogInput, message?: string): void {
  if (!shouldLog(level)) return
  const bindings =
    input &&
    typeof input === "object" &&
    !(input instanceof Error) &&
    !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  const text =
    message ??
    (input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : "log")
  process.stderr.write(
    `${level} ${text}${formatBindings(bindings)}${formatDetails(level, input, bindings)}\n`
  )
}

function write(level: LogLevel, input: LogInput, message?: string): void {
  if (activeLoggingSettings.format === "json") {
    if (message !== undefined && input !== undefined) {
      jsonLogger[level](input, message)
    } else if (input !== undefined) {
      jsonLogger[level](input)
    } else {
      jsonLogger[level]("")
    }
    return
  }
  writeSimple(level, input, message)
}

export const logger = {
  debug: (input?: LogInput, message?: string) => write("debug", input, message),
  info: (input?: LogInput, message?: string) => write("info", input, message),
  warn: (input?: LogInput, message?: string) => write("warn", input, message),
  error: (input?: LogInput, message?: string) => write("error", input, message),
  fatal: (input?: LogInput, message?: string) => write("fatal", input, message),
}
