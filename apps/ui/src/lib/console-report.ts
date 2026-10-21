import type { ConsoleLog } from "@/hooks/use-console-capture"
import type { BugReportPayload } from "@/types/electron-api"

export function truncateReportText(text: string, limit: number): string {
  const suffix = "\n[truncated]"
  return text.length > limit
    ? text.slice(0, limit - suffix.length) + suffix
    : text
}

export function buildConsoleReport({
  consoleLogs,
  activeThread,
  selectedModel,
  messageCount,
}: {
  consoleLogs: ConsoleLog[]
  activeThread:
    | { title?: string; projectPath?: string | null }
    | null
    | undefined
  selectedModel: string | null
  messageCount: number
}): BugReportPayload {
  const errors = consoleLogs.filter((log) => log.type === "error")
  const warnings = consoleLogs.filter((log) => log.type === "warn")
  const line = (log: ConsoleLog) =>
    `[${log.timestamp.toISOString()}] [${log.type.toUpperCase()}] ${log.message}`
  return {
    logs: truncateReportText(consoleLogs.map(line).join("\n"), 64_000),
    message: truncateReportText(
      [
        "# BetterC0de Console Report",
        `Generated: ${new Date().toISOString()}`,
        "",
        "## Session Info",
        `- Thread: ${activeThread?.title || "No thread"}`,
        `- Project: ${activeThread?.projectPath || "None"}`,
        `- Model: ${selectedModel || "None"}`,
        `- Messages: ${messageCount}`,
        "",
        "## Console Logs",
        `Total: ${consoleLogs.length} (${errors.length} errors, ${warnings.length} warnings)`,
        "",
        "### Errors",
        ...errors.map(line),
        "",
        "### Warnings",
        ...warnings.map(line),
        "",
        "### All Logs",
        ...consoleLogs.map(line),
      ].join("\n"),
      128_000
    ),
    stack: truncateReportText(
      consoleLogs
        .filter((log) => log.stack)
        .map((log) => `${line(log)}\n${log.stack}`)
        .join("\n\n"),
      32_000
    ),
  }
}
