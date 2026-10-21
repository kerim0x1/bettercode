import pino from "pino"

/**
 * Shared backend logger.
 *
 * Dev defaults to compact human-readable lines so Electron's console stays
 * usable while chat responses stream. Set `BETTERC0DE_LOG_FORMAT=json` when
 * structured logs are needed for ingestion.
 */
const jsonLogger = pino(
  {
    level: normalizeLogLevel(process.env.LOG_LEVEL) ?? "info",
    base: { app: "betterc0de-backend" },
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

function formatBindings(bindings: Record<string, unknown> | undefined): string {
  if (!bindings) return ""
  const pairs = Object.entries(bindings)
    .filter(([key, value]) => key !== "app" && value !== undefined)
    .map(([key, value]) => {
      const formatted = formatBindingValue(value)
      return formatted ? `${key}=${formatted}` : null
    })
    .filter((value): value is string => Boolean(value))
  return pairs.length > 0 ? ` ${pairs.join(" ")}` : ""
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
  process.stderr.write(`${level} ${text}${formatBindings(bindings)}\n`)
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
