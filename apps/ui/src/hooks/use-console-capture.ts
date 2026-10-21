import { useEffect } from "react"
import type { ConsoleLog } from "@/lib/console-log-store"
import { useSettingsStore } from "@/lib/settings-store"
import { ipcApi } from "@/services/ipc-facade"

export type { ConsoleLog }

const MAX_LOGS = 200
const FLUSH_INTERVAL_MS = 150
const MAX_MESSAGE_CHARS = 4000

/**
 * Monkey-patches `console.log` / `warn` / `error` / `info` / `debug` so the console
 * panel can display them in-app, while still forwarding to the real
 * browser console.
 *
 * Perf notes:
 *  - Individual calls only write to a ring buffer; a batched `setConsoleLogs`
 *    runs at most once per `FLUSH_INTERVAL_MS`, so a 1000-call burst causes
 *    one React render instead of 1000.
 *  - Object args are truncated to `MAX_MESSAGE_CHARS` and the `JSON.stringify`
 *    runs without indentation so logging a large object doesn't freeze the
 *    UI thread.
 *  - Keeps the last `MAX_LOGS` entries to bound memory over long sessions.
 *  - Restores the originals on unmount so the patch doesn't outlive the tree.
 */
export function useConsoleCapture(
  setConsoleLogs: React.Dispatch<React.SetStateAction<ConsoleLog[]>>
) {
  useEffect(() => {
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    const originalInfo = console.info
    const originalDebug = console.debug

    const buffer: ConsoleLog[] = []
    const recentLogs: ConsoleLog[] = []
    let flushScheduled = false

    const scheduleFlush = () => {
      if (flushScheduled) return
      flushScheduled = true
      setTimeout(() => {
        flushScheduled = false
        if (buffer.length === 0) return
        const batch = buffer.splice(0, buffer.length)
        setConsoleLogs((prev) => {
          const merged =
            prev.length + batch.length > MAX_LOGS
              ? [...prev, ...batch].slice(-MAX_LOGS)
              : [...prev, ...batch]
          return merged
        })
      }, FLUSH_INTERVAL_MS)
    }

    const formatArg = (arg: unknown): string => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`
      if (typeof arg !== "object" || arg === null) return String(arg)
      try {
        const s = JSON.stringify(arg)
        return s.length > MAX_MESSAGE_CHARS
          ? `${s.slice(0, MAX_MESSAGE_CHARS)}…[${s.length - MAX_MESSAGE_CHARS} chars elided]`
          : s
      } catch {
        return "[unserializable]"
      }
    }

    const addLog = (type: ConsoleLog["type"], args: unknown[]) => {
      let message = args.map(formatArg).join(" ")
      if (message.length > MAX_MESSAGE_CHARS)
        message = message.slice(0, MAX_MESSAGE_CHARS) + "…"
      const stack = args
        .filter((arg): arg is Error => arg instanceof Error)
        .map((error) => error.stack || `${error.name}: ${error.message}`)
        .join("\n\n")
        .slice(0, 16_000)
      const entry = {
        type,
        message,
        ...(stack ? { stack } : {}),
        timestamp: new Date(),
      }
      buffer.push(entry)
      recentLogs.push(entry)
      if (recentLogs.length > MAX_LOGS)
        recentLogs.splice(0, recentLogs.length - MAX_LOGS)
      scheduleFlush()
    }

    console.log = (...args) => {
      originalLog.apply(console, args)
      addLog("log", args)
    }
    console.warn = (...args) => {
      originalWarn.apply(console, args)
      addLog("warn", args)
    }
    console.error = (...args) => {
      originalError.apply(console, args)
      addLog("error", args)
    }
    console.info = (...args) => {
      originalInfo.apply(console, args)
      addLog("info", args)
    }
    console.debug = (...args) => {
      originalDebug.apply(console, args)
      addLog("debug", args)
    }

    const reportError = (
      reason: unknown,
      fallback = "Unhandled renderer error"
    ) => {
      // Automatic reports are opt-in (Settings → Privacy & Diagnostics). The shell
      // enforces the same choice; checking here keeps the log buffer from
      // crossing IPC at all without consent.
      if (useSettingsStore.getState().crashReportsEnabled !== true) return
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : fallback)
      void ipcApi.bugReport
        .send({
          automatic: true,
          message: (error.message || fallback).slice(0, 128_000),
          stack: (error.stack || "").slice(0, 32_000),
          logs: recentLogs
            .map(
              (log) =>
                `[${log.timestamp.toISOString()}] [${log.type}] ${log.message}`
            )
            .join("\n")
            .slice(-64_000),
        })
        .catch(() => {})
    }
    const onError = (event: ErrorEvent) => {
      if (event.message) reportError(event.error, event.message)
    }
    const onRejection = (event: PromiseRejectionEvent) =>
      reportError(event.reason, "Unhandled renderer promise rejection")
    if (typeof window !== "undefined") {
      window.addEventListener("error", onError)
      window.addEventListener("unhandledrejection", onRejection)
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("error", onError)
        window.removeEventListener("unhandledrejection", onRejection)
      }
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
      console.info = originalInfo
      console.debug = originalDebug
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
