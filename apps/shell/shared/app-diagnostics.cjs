const { formatWithOptions } = require("node:util")
const { createBugReportSender } = require("./bug-report.cjs")
const { redactSensitiveText } = require("./log-redaction.cjs")

const MAX_LINES = 200
const MAX_LINE_CHARS = 4000
/** Renderer chatter at these levels stays out of the persistent log file. */
const RENDERER_FILE_LEVELS = new Set(["warning", "warn", "error", "2", "3"])

/**
 * Main-process diagnostics: a redacted ring buffer of recent console lines
 * (main, forwarded backend output, renderer console), an optional persistent
 * log sink, and the bug-report sender.
 *
 * `automaticReports` is the user's consent to automatic crash reports. It may
 * be a boolean or a function that is asked at report time, so turning the
 * setting off takes effect immediately. Manual reports never consult it.
 */
function createAppDiagnostics({
  logger = console,
  automaticReports = false,
  redact = redactSensitiveText,
  logSink = null,
  ...senderOptions
}) {
  const lines = []
  const activeReports = new Set()
  const restorers = []
  const attached = new WeakSet()
  const automaticReportsAllowed = () => {
    try {
      return typeof automaticReports === "function"
        ? automaticReports() === true
        : automaticReports === true
    } catch {
      return false
    }
  }
  const addLog = (level, message, { persist = true } = {}) => {
    const line = redact(`[${new Date().toISOString()}] [${level}] ${String(message).slice(0, MAX_LINE_CHARS)}`)
    lines.push(line)
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
    if (persist && logSink) {
      try { logSink.write(line) } catch { /* The log file is best effort. */ }
    }
  }
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = logger[level]
    if (typeof original !== "function") continue
    const wrapped = (...args) => {
      try {
        addLog(level, formatWithOptions({ depth: 2, maxArrayLength: 20, maxStringLength: MAX_LINE_CHARS }, ...args))
      } catch { /* Logging must remain safe even for unusual objects. */ }
      return original.apply(logger, args)
    }
    logger[level] = wrapped
    restorers.push(() => { if (logger[level] === wrapped) logger[level] = original })
  }

  const sender = createBugReportSender({
    ...senderOptions,
    redact,
    getLogs: () => lines.join("\n").slice(-64_000),
  })
  const sendReport = (report) => {
    if (report?.automatic === true && !automaticReportsAllowed()) {
      return Promise.resolve({ ok: false, error: "Automatic reports are disabled.", retryAfterMs: 0 })
    }
    const pending = sender(report)
    activeReports.add(pending)
    pending.then(() => activeReports.delete(pending), () => activeReports.delete(pending))
    return pending
  }
  const reportError = async (error) => {
    if (!automaticReportsAllowed()) return
    try {
      const message = error instanceof Error ? error.message : formatWithOptions({ depth: 2 }, error)
      return await sendReport({
        automatic: true,
        message: (message || "Unknown application error").slice(0, 128_000),
        stack: (error instanceof Error ? error.stack || "" : "").slice(0, 32_000),
      })
    } catch {
      // Reporting must never recurse into the application's global error handlers.
    }
  }

  return {
    sendReport,
    reportError,
    attachRenderer(contents) {
      if (attached.has(contents)) return
      attached.add(contents)
      contents.on("console-message", (details) => {
        if (details.frame && contents.mainFrame && details.frame !== contents.mainFrame) return
        const level = String(details.level)
        addLog(`renderer:${level}`, details.message, { persist: RENDERER_FILE_LEVELS.has(level) })
      })
      contents.on("render-process-gone", (_event, details) => {
        if (["clean-exit", "killed"].includes(details.reason)) return
        void reportError(new Error(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`))
      })
    },
    async flush(timeoutMs = 5000) {
      if (activeReports.size === 0) return
      let timer
      try {
        await Promise.race([
          Promise.allSettled([...activeReports]),
          new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
        ])
      } finally { clearTimeout(timer) }
    },
    /** Write buffered log lines synchronously (fatal and shutdown paths). */
    flushLogs() {
      try { logSink?.flushSync?.() } catch { /* best effort */ }
    },
    /** Path of the persistent log file, when one is configured. */
    get logFilePath() {
      return logSink?.path ?? null
    },
    dispose() {
      for (const restore of restorers) restore()
      try { logSink?.close?.() } catch { /* best effort */ }
    },
  }
}

module.exports = { createAppDiagnostics }
