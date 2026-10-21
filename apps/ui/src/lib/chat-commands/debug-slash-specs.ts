import { useAppearanceStore } from "@/lib/appearance-store"
import { stringifyCliArgs } from "@/lib/cli-parse"
import type { UiProvider } from "@/lib/provider-types"
import type {
  RuntimeMcpServer,
  RuntimeSkill,
  RuntimeSubagent,
} from "@/lib/runtime-config"
import { useSettingsStore } from "@/lib/settings-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  type ThreadUsageStats,
  getRuntimeDebugInfo,
  loadThreadStats,
} from "@/services/backend/coreApi"
import {
  buildRuntimeDebugInfoOutput,
  buildRuntimeDebugPathsOutput,
} from "./debug-info-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  type ActiveThreadRef,
  escapeMarkdownTableCell,
} from "./provider-config"
import { buildDebugRgOutput } from "./runtime-commands"
import {
  type StatsCommandOptions,
  buildThreadStatsOutput,
} from "./session-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import { buildDebugSnapshotOutput } from "./thread-inspection"

function buildSystemStatusOutput(input: {
  mcpList: RuntimeMcpServer[]
  skillList: RuntimeSkill[]
  subagentList: RuntimeSubagent[]
  selectedProvider: UiProvider | undefined
  selectedModel: string
  chatMode: string
  permissionLevel: string
  activeThread: ActiveThreadRef
}): string {
  const settings = useSettingsStore.getState()
  const appearance = useAppearanceStore.getState()
  const provider = input.selectedProvider
  const providerStatus =
    provider?.configured === false
      ? "Needs setup"
      : provider?.status === "ready" || provider?.configured === true
        ? "Ready"
        : "Unknown"

  return [
    "# System Status\n",
    "| Runtime | Value |",
    "|:--------|:------|",
    `| **Mode** | \`${input.chatMode}\` |`,
    `| **Permission** | \`${input.permissionLevel}\` |`,
    `| **Provider** | ${provider ? escapeMarkdownTableCell(provider.name) : "None"} |`,
    `| **Provider Status** | ${providerStatus} |`,
    `| **Model** | \`${input.selectedModel}\` |`,
    `| **Project** | ${escapeMarkdownTableCell(input.activeThread?.projectPath || input.activeThread?.worktreePath || "No folder")} |`,
    "",
    "| Component | Installed | Active |",
    "|:----------|----------:|-------:|",
    `| **MCP Servers** | ${input.mcpList.length} | ${input.mcpList.filter((m) => m.enabled).length} |`,
    `| **Skills** | ${input.skillList.length} | ${input.skillList.filter((s) => s.enabled).length} |`,
    `| **Subagents** | ${input.subagentList.length} | ${input.subagentList.filter((agent) => agent.enabled).length} |`,
    "",
    "| Behavior | State |",
    "|:---------|:------|",
    `| **Assistant Streaming** | ${settings.enableAssistantStreaming ? "On" : "Off"} |`,
    `| **Session Progress** | ${settings.showSessionProgressBar ? "On" : "Off"} |`,
    `| **Reasoning Summaries** | ${settings.showReasoningSummaries ? "On" : "Off"} |`,
    `| **Shell Tool Parts Expanded** | ${settings.shellToolPartsExpanded ? "On" : "Off"} |`,
    `| **Edit Tool Parts Expanded** | ${settings.editToolPartsExpanded ? "On" : "Off"} |`,
    `| **Auto-save Conversations** | ${settings.autoSaveConversations ? "On" : "Off"} |`,
    `| **Diff Word Wrap** | ${settings.diffWordWrap ? "On" : "Off"} |`,
    `| **Diff Style** | \`${settings.diffStyle}\` |`,
    `| **Notifications** | Agent ${settings.notificationAgent ? "On" : "Off"}, Permissions ${settings.notificationPermissions ? "On" : "Off"}, Errors ${settings.notificationErrors ? "On" : "Off"} |`,
    `| **Compact Chat** | ${appearance.compactMode ? "On" : "Off"} |`,
    `| **Theme Mode Lock** | ${appearance.themeModeLocked ? "On" : "Off"} |`,
    `| **Animations** | ${appearance.animationsEnabled ? "On" : "Off"} |`,
    `| **File Context** | ${appearance.fileContextEnabled ? "On" : "Off"} |`,
    `| **Session Directory Filter** | ${appearance.sessionDirectoryFilterEnabled ? "On" : "Off"} |`,
    `| **Terminal Titles** | ${appearance.terminalTitleEnabled ? "On" : "Off"} |`,
    "",
    "> Use `/mcps`, `/skills`, `/agents`, `/connect`, or `/settings providers` for details.",
  ].join("\n")
}

export function buildBetterC0deDebugUtilityOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const mode = betterC0deDebugUtilityMode(command)
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  const cliCommand = ["betterc0de debug", mode, cliArgs]
    .filter(Boolean)
    .join(" ")
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const heading =
    mode === "scrap"
      ? "BetterC0de Debug Scrap"
      : mode === "v2"
        ? "BetterC0de Debug V2"
        : mode === "wait"
          ? "BetterC0de Debug Wait"
          : "BetterC0de Debug Startup"
  const details =
    mode === "scrap"
      ? [
          "Lists all known BetterC0de compatibility projects as JSON.",
          "In BetterC0de, use the project/sidebar views and `/sessions` for local project/session navigation.",
        ]
      : mode === "v2"
        ? [
            "Dumps BetterC0de v2 catalog/provider/default-model diagnostics.",
            "In BetterC0de, use `/catalog`, `/providers`, `/models <query> --verbose`, and Settings > Compatibility.",
          ]
        : mode === "wait"
          ? [
              "Sleeps indefinitely for debugger attachment.",
              "BetterC0de intentionally does not start an endless wait process from chat.",
            ]
          : [
              "Prints BetterC0de startup timing based on `performance.now()`.",
              `Current renderer uptime marker: ${Math.round(performance.now()).toLocaleString()}ms.`,
            ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`betterc0de debug ${mode}\`.`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with this BetterC0de debug command prefilled. Press Enter there to run it intentionally."
      : "> This BetterC0de command is read-only guidance. Add `--terminal` when you need byte-for-byte compatibility CLI output in the integrated terminal.",
  ].join("\n")
}

function buildBetterC0deDebugUtilityTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const mode = betterC0deDebugUtilityMode(command)
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  return {
    command: ["betterc0de debug", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function betterC0deDebugUtilityMode(
  command: string
): "startup" | "scrap" | "v2" | "wait" {
  const normalized = command.replace(/^\//, "").toLowerCase()
  if (normalized.includes("scrap")) return "scrap"
  if (normalized.includes("v2")) return "v2"
  if (normalized.includes("wait")) return "wait"
  return "startup"
}

export function parseStatsCommandOptions(
  args: readonly string[],
  activeThread: ActiveThreadRef
): StatsCommandOptions {
  const terminalCommand = buildBetterC0deStatsTerminalCommand(args)
  const options: StatsCommandOptions = {
    validation: [],
    ...(terminalCommand.shouldOpen
      ? { terminalCommand: terminalCommand.command }
      : {}),
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) {
      continue
    }
    if (arg === "--today") {
      options.days = 0
      continue
    }
    if (arg === "--current-project" || arg === "--current") {
      options.projectPath = resolveThreadRuntimePath(activeThread)
      continue
    }
    if (arg === "--days") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        options.validation!.push("--days requires a value.")
      } else {
        const parsed = parseStatsNonNegativeInteger(value, "--days", options)
        if (parsed !== undefined) options.days = parsed
        index += 1
      }
      continue
    }
    if (arg.startsWith("--days=")) {
      const parsed = parseStatsNonNegativeInteger(
        arg.slice("--days=".length),
        "--days",
        options
      )
      if (parsed !== undefined) options.days = parsed
      continue
    }
    if (arg === "--project") {
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith("-")) {
        options.projectPath = parseStatsProjectFilter(value, activeThread)
        index += 1
      } else {
        options.validation!.push(
          "--project requires a value. Use `--project=` for the current project."
        )
      }
      continue
    }
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length)
      options.projectPath = parseStatsProjectFilter(value, activeThread)
      continue
    }
    if (arg === "--project-current") {
      options.projectPath = resolveThreadRuntimePath(activeThread)
      continue
    }
    if (arg === "--project-path") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        options.projectPath = value
        index += 1
      } else {
        options.validation!.push("--project-path requires a value.")
      }
      continue
    }
    if (arg.startsWith("--project-path=")) {
      options.projectPath = arg.slice("--project-path=".length)
      continue
    }
    if (arg === "--tools") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        const parsed = parseStatsNonNegativeInteger(value, "--tools", options)
        if (parsed !== undefined) options.toolLimit = parsed
        index += 1
      } else {
        options.toolLimit = Infinity
      }
      continue
    }
    if (arg.startsWith("--tools=")) {
      const parsed = parseStatsNonNegativeInteger(
        arg.slice("--tools=".length),
        "--tools",
        options
      )
      if (parsed !== undefined) options.toolLimit = parsed
      continue
    }
    if (arg === "--models") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        const parsed = parseStatsNonNegativeInteger(value, "--models", options)
        if (parsed !== undefined) options.modelLimit = parsed
        index += 1
      } else {
        options.modelLimit = Infinity
      }
      continue
    }
    if (arg.startsWith("--models=")) {
      const value = arg.slice("--models=".length)
      if (value.trim().length === 0) {
        options.modelLimit = Infinity
      } else {
        const parsed = parseStatsNonNegativeInteger(value, "--models", options)
        if (parsed !== undefined) options.modelLimit = parsed
      }
      continue
    }
    if (arg === "--no-models") {
      options.modelLimit = 0
    }
  }
  return options
}

function parseStatsNonNegativeInteger(
  value: string,
  label: string,
  options: StatsCommandOptions
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    options.validation!.push(`${label} requires a value.`)
    return undefined
  }
  if (!/^\d+$/.test(trimmed)) {
    options.validation!.push(`${label} must be a non-negative integer.`)
    return undefined
  }
  return Number.parseInt(trimmed, 10)
}

function buildBetterC0deStatsTerminalCommand(args: readonly string[]): {
  command: string
  shouldOpen: boolean
} {
  const cliArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--today") {
      cliArgs.push("--days", "0")
      continue
    }
    if (
      arg === "--current-project" ||
      arg === "--current" ||
      arg === "--project-current"
    ) {
      cliArgs.push("--project=")
      continue
    }
    if (arg === "--project-path") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        cliArgs.push("--project", value)
        index += 1
      }
      continue
    }
    if (arg.startsWith("--project-path=")) {
      cliArgs.push(`--project=${arg.slice("--project-path=".length)}`)
      continue
    }
    cliArgs.push(arg)
  }

  return {
    command: ["betterc0de stats", stringifyCliArgs(cliArgs)]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function parseStatsProjectFilter(
  value: string,
  activeThread: ActiveThreadRef
): string | null {
  const trimmed = value.trim()
  if (
    trimmed === "" ||
    trimmed === "''" ||
    trimmed === '""' ||
    trimmed === "current"
  ) {
    return resolveThreadRuntimePath(activeThread)
  }
  return value
}

function emptyThreadUsageStats(): ThreadUsageStats {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: { earliest: null, latest: null },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }
}

/** System status, debug diagnostics, usage and token statistics. */
export const DEBUG_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "status",
        "betterc0de.status",
        "betterc0de-status",
        "global.health",
      ],
      run: (run) => {
        const {
          selectedProvider,
          selectedModel,
          permissionLevel,
          activeThread,
          effectiveChatMode,
          mcpList,
          skillList,
          subagentList,
        } = run
        run.output = buildSystemStatusOutput({
          mcpList,
          skillList,
          subagentList,
          selectedProvider,
          selectedModel,
          chatMode: effectiveChatMode,
          permissionLevel,
          activeThread,
        })
      },
    },
    {
      names: [
        "debug-info",
        "debug.info",
        "betterc0de.debug.info",
        "betterc0de-debug-info",
      ],
      run: async (run) => {
        run.output = buildRuntimeDebugInfoOutput(await getRuntimeDebugInfo())
      },
    },
    {
      names: [
        "debug-paths",
        "debug.paths",
        "betterc0de.debug.paths",
        "betterc0de-debug-paths",
        "db.path",
        "db-path",
        "paths",
        "path.get",
        "path-get",
      ],
      run: async (run) => {
        run.output = buildRuntimeDebugPathsOutput(await getRuntimeDebugInfo())
      },
    },
    {
      names: [
        "debug-rg",
        "debug.rg",
        "debug.rg.files",
        "debug.rg.search",
        "debug.file",
        "debug.file.read",
        "debug-file-read",
        "debug.file.list",
        "debug-file-list",
        "debug.file.status",
        "debug-file-status",
        "debug.file.search",
        "debug.file.tree",
        "file",
        "file.read",
        "file-read",
        "file.list",
        "file-list",
        "file.status",
        "file-status",
      ],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        run.output = await buildDebugRgOutput(cmd, args, activeThread)
      },
    },
    {
      names: [
        "debug-snapshot",
        "debug.snapshot",
        "debug.snapshot.track",
        "debug.snapshot.patch",
        "debug.snapshot.diff",
        "debug-snapshot-track",
        "debug-snapshot-patch",
        "debug-snapshot-diff",
      ],
      run: async (run) => {
        const { cmd, args, threadId } = run
        run.output = await buildDebugSnapshotOutput(threadId, cmd, args)
      },
    },
    {
      names: [
        "debug-utility",
        "debug.startup",
        "debug-startup",
        "debug.scrap",
        "debug-scrap",
        "debug.v2",
        "debug-v2",
        "debug.wait",
        "debug-wait",
      ],
      run: (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = buildBetterC0deDebugUtilityTerminalCommand(
          cmd,
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildBetterC0deDebugUtilityOutput(cmd, args)
      },
    },
    {
      names: ["usage", "cli-usage"],
      run: (run) => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("betterc0de:open-usage"))
        }
        run.output = ""
      },
    },
    {
      names: ["stats", "token-usage", "session.stats", "session-stats"],
      run: async (run) => {
        const { args, activeThread } = run
        const statsOptions = parseStatsCommandOptions(args, activeThread)
        if (statsOptions.terminalCommand) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            statsOptions.terminalCommand
          )
        }
        const stats =
          (statsOptions.validation?.length ?? 0) > 0
            ? emptyThreadUsageStats()
            : await loadThreadStats(statsOptions)
        run.output = buildThreadStatsOutput(stats, statsOptions)
      },
    },
  ]
