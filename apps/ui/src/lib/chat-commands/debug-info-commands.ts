import { stringifyCliArgs } from "@/lib/cli-parse"
import type { RuntimeDebugInfo } from "@/services/backend/coreApi"
import { formatDebugPathCell } from "./lsp-commands"
import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import { escapeInlineCode, escapeMarkdownTableCell } from "./provider-config"
import {
  buildBetterC0deMaintenanceCliArgs,
  buildBetterC0deMaintenanceValidationMessages,
  formatBytes,
} from "./runtime-commands"

export function buildRuntimeDebugInfoOutput(info: RuntimeDebugInfo): string {
  const compat = info.betterc0de
  return [
    "# Debug Info",
    "",
    "Compatibility reference: `betterc0de debug info`.",
    "",
    "| Runtime | Value |",
    "|:--------|:------|",
    `| App | ${escapeMarkdownTableCell(info.app.name)} |`,
    `| Version | \`${escapeInlineCode(info.app.version || "unknown")}\` |`,
    `| Backend | \`${escapeInlineCode(info.app.backend)}\` |`,
    `| Uptime | ${formatDebugDuration(info.app.uptimeSeconds)} |`,
    `| OS | ${escapeMarkdownTableCell(`${info.system.type} ${info.system.release}`)} |`,
    `| Platform | \`${escapeInlineCode(info.system.platform)}-${escapeInlineCode(info.system.arch)}\` |`,
    `| Node | \`${escapeInlineCode(info.process.node)}\` |`,
    `| V8 | \`${escapeInlineCode(info.process.versions.v8 ?? "-")}\` |`,
    `| libuv | \`${escapeInlineCode(info.process.versions.uv ?? "-")}\` |`,
    `| NODE_MODULE_VERSION | \`${escapeInlineCode(info.process.versions.modules ?? "-")}\` |`,
    `| PID | ${info.process.pid.toLocaleString()} |`,
    `| CWD | ${formatDebugPathCell(info.process.cwd)} |`,
    "",
    "| Terminal | Value |",
    "|:---------|:------|",
    `| TERM | \`${escapeInlineCode(info.terminal.term ?? "-")}\` |`,
    `| Program | \`${escapeInlineCode(info.terminal.program ?? "-")}\` |`,
    `| Shell | ${formatDebugPathCell(info.terminal.shell)} |`,
    ...(compat
      ? [
          "",
          "| Compatibility plugins | State |",
          "|:-----------------|:------|",
          `| External plugins | ${formatBetterC0deExternalPluginsState(compat)} |`,
          `| Default plugins | ${formatBetterC0deDefaultPluginsState(compat)} |`,
          `| Plugin metadata | ${formatDebugPathCell(compat.pluginMetaPath)} |`,
        ]
      : []),
    "",
    "| Environment override | State |",
    "|:---------------------|:------|",
    `| BETTERC0DE_HOME | ${info.envOverrides.betterc0deHome} |`,
    `| BETTERC0DE_DATA_DIR | ${info.envOverrides.betterc0deDataDir} |`,
    "",
    "> Use `/debug-paths` or `/db.path` for local data and database paths. Secrets and environment values are not printed.",
  ].join("\n")
}

function formatBetterC0deExternalPluginsState(
  compat: NonNullable<RuntimeDebugInfo["betterc0de"]>
): string {
  if (compat.pureMode || compat.externalPlugins === "disabled-by-pure") {
    return "external plugins disabled (--pure)"
  }
  return "enabled"
}

function formatBetterC0deDefaultPluginsState(
  compat: NonNullable<RuntimeDebugInfo["betterc0de"]>
): string {
  if (
    compat.defaultPluginsDisabled ||
    compat.defaultPlugins === "disabled-by-env"
  ) {
    return "disabled (BETTERC0DE_DISABLE_DEFAULT_PLUGINS)"
  }
  return "enabled"
}

export function buildRuntimeDebugPathsOutput(info: RuntimeDebugInfo): string {
  const compat = info.betterc0de
  return [
    "# Debug Paths",
    "",
    "Compatibility reference: `betterc0de debug paths` / `betterc0de db path`.",
    "",
    "| Path | Value |",
    "|:-----|:------|",
    `| Data dir | ${formatDebugPathCell(info.paths.dataDir)} |`,
    `| SQLite database | ${formatDebugPathCell(info.database.path)} |`,
    `| BetterC0de compatibility config dir | ${formatDebugPathCell(compat?.configDir)} |`,
    `| BetterC0de compatibility config source | \`${compat?.configDirSource ?? "default"}\` |`,
    `| Compatibility data dir | ${formatDebugPathCell(compat?.dataDir)} |`,
    `| Compatibility state dir | ${formatDebugPathCell(compat?.stateDir)} |`,
    `| Compatibility cache dir | ${formatDebugPathCell(compat?.cacheDir)} |`,
    `| Compatibility bin dir | ${formatDebugPathCell(compat?.binDir)} |`,
    `| Compatibility log dir | ${formatDebugPathCell(compat?.logDir)} |`,
    `| Compatibility repos dir | ${formatDebugPathCell(compat?.reposDir)} |`,
    `| BetterC0de compatibility database | ${formatDebugPathCell(compat?.dbPath)} |`,
    `| BetterC0de compatibility database source | \`${compat?.dbPathSource ?? "default"}\` |`,
    `| Compatibility auth file | ${formatDebugPathCell(compat?.authPath)} |`,
    `| BetterC0de MCP auth file | ${formatDebugPathCell(compat?.mcpAuthPath)} |`,
    `| Compatibility plugin metadata | ${formatDebugPathCell(compat?.pluginMetaPath)} |`,
    `| Settings file | ${formatDebugPathCell(info.paths.settingsPath)} |`,
    `| Auth file | ${formatDebugPathCell(info.paths.authPath)} |`,
    `| Logs dir | ${formatDebugPathCell(info.paths.logsDir)} |`,
    `| Provider logs dir | ${formatDebugPathCell(info.paths.providerLogsDir)} |`,
    `| Provider event log | ${formatDebugPathCell(info.paths.providerEventLogPath)} |`,
    `| Process cwd | ${formatDebugPathCell(info.process.cwd)} |`,
    "",
    "> Paths are read-only diagnostics. Auth contents and other secrets are not displayed.",
  ].join("\n")
}

export function buildBetterC0deDbPathOutput(
  info: RuntimeDebugInfo,
  command = "/betterc0de-db-path",
  args: ReadonlyArray<string> = []
): string {
  const compat = info.betterc0de
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  const cliCommand = ["betterc0de", "db", cliArgs].filter(Boolean).join(" ")
  const validation = buildBetterC0deMaintenanceValidationMessages(
    command,
    "db",
    args
  )
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)

  return [
    "# BetterC0de DB Path",
    "",
    "Compatibility reference: `betterc0de db path`.",
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| BetterC0de compatibility database | ${formatDebugPathCell(compat?.dbPath)} |`,
    `| BetterC0de compatibility database source | \`${compat?.dbPathSource ?? "default"}\` |`,
    `| Compatibility data dir | ${formatDebugPathCell(compat?.dataDir)} |`,
    `| BetterC0de database | ${formatDebugPathCell(info.database.path)} |`,
    validation.length > 0
      ? [
          "",
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
        ].join("\n")
      : "",
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with this command prefilled. The table above is BetterC0de's read-only local path lookup."
      : "> Read-only path lookup. Use `/debug-paths` for all local paths; add `--terminal` for the raw compatibility CLI handoff.",
  ].join("\n")
}

export function buildRuntimeHeapSnapshotOutput(result: {
  path: string
  bytes: number
}): string {
  return [
    "# Heap Snapshot",
    "",
    "Compatibility reference: `app.heap_snapshot`.",
    "",
    "Node backend heap snapshot written.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Path | ${formatDebugPathCell(result.path)} |`,
    `| Size | ${formatBytes(result.bytes)} |`,
    "",
    "> Keep heap snapshots local. They can contain runtime object data.",
  ].join("\n")
}

function formatDebugDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s"
  const whole = Math.floor(seconds)
  const days = Math.floor(whole / 86_400)
  const hours = Math.floor((whole % 86_400) / 3_600)
  const minutes = Math.floor((whole % 3_600) / 60)
  const remaining = whole % 60
  return [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    remaining > 0 || (days === 0 && hours === 0 && minutes === 0)
      ? `${remaining}s`
      : "",
  ]
    .filter(Boolean)
    .join(" ")
}
