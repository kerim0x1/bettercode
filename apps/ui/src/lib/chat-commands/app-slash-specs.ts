import { usePreferencesStore } from "@/lib/preferences-store"
import { writeRuntimeHeapSnapshot } from "@/services/backend/coreApi"
import { buildRuntimeHeapSnapshotOutput } from "./debug-info-commands"
import { escapeMarkdownTableCell } from "./provider-config"
import {
  type AppLogPayload,
  type ParsedAppLogCommand,
  parseAppLogCommandArgs,
} from "./runtime-commands"
import {
  type SettingsTabId,
  executeRemoteAccessCommand,
  openSettingsTab,
} from "./settings-actions"
import { buildToggleOutput } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

const SETTINGS_TAB_BY_COMMAND = new Map<string, SettingsTabId>([
  ["/settings", "general"],
  ["/preferences", "general"],
  ["/settings.open", "general"],
  ["/settings-open", "general"],
  ["/providers", "models"],
  ["/appearance", "appearance"],
  ["/rules", "rules"],
  ["/skills-settings", "skills"],
  ["/tools", "tools"],
  ["/mcp-settings", "tools"],
  ["/hooks", "hooks"],
  ["/plugins", "plugins"],
  ["/plugins.list", "plugins"],
  ["/plugins-list", "plugins"],
  ["/betterc0de-settings", "betterc0de"],
  ["/betterc0de-settings", "betterc0de"],
])

const SETTINGS_TAB_BY_ARG = new Map<string, SettingsTabId>([
  ["general", "general"],
  ["appearance", "appearance"],
  ["theme", "appearance"],
  ["layout", "layout"],
  ["panels", "layout"],
  ["chat", "chat"],
  ["notifications", "notifications"],
  ["sound", "notifications"],
  ["sounds", "notifications"],
  ["privacy", "privacy"],
  ["diagnostics", "privacy"],
  ["logs", "privacy"],
  ["permissions", "permissions"],
  ["experimental", "experimental"],
  ["providers", "models"],
  ["provider", "models"],
  ["models", "models"],
  ["plugins", "plugins"],
  ["rules", "rules"],
  ["skills", "skills"],
  ["agents", "skills"],
  ["subagents", "skills"],
  ["tools", "tools"],
  ["mcp", "tools"],
  ["mcps", "tools"],
  ["hooks", "hooks"],
  ["remote", "remote"],
  ["remote-access", "remote"],
  ["betterc0de", "betterc0de"],
  ["betterc0de", "betterc0de"],
  ["project", "betterc0de"],
  ["project-config", "betterc0de"],
  ["docs", "docs"],
  ["help", "docs"],
])

function resolveSettingsTabCommand(
  command: string,
  arg?: string
): SettingsTabId | null {
  const direct = SETTINGS_TAB_BY_COMMAND.get(command)
  if (!direct) return null
  if (command === "/settings" || command === "/preferences") {
    return SETTINGS_TAB_BY_ARG.get(arg?.toLowerCase() ?? "") ?? direct
  }
  return direct
}

function settingsTabLabel(tab: SettingsTabId): string {
  switch (tab) {
    case "models":
      return "Providers"
    case "tools":
      return "Tools & MCP"
    case "skills":
      return "Skills & Subagents"
    case "betterc0de":
      return "Compatibility"
    case "remote":
      return "Remote Access"
    case "notifications":
      return "Notifications & Sound"
    case "privacy":
      return "Privacy & Diagnostics"
    default:
      return tab.charAt(0).toUpperCase() + tab.slice(1)
  }
}

function emitAppLog(payload: AppLogPayload): void {
  const message = `[${payload.service}] ${payload.message}`
  const args = payload.extra ? [message, payload.extra] : [message]
  if (payload.level === "error") {
    console.error(...args)
  } else if (payload.level === "warn") {
    console.warn(...args)
  } else if (payload.level === "debug") {
    console.debug(...args)
  } else {
    console.info(...args)
  }
}

export function buildAppLogOutput(parsed: ParsedAppLogCommand): string {
  if (!parsed.payload) {
    return [
      "# App Log",
      "",
      "Compatibility reference: `app.log` / `POST /log`.",
      "",
      `> ${parsed.error}`,
    ].join("\n")
  }

  const payload = parsed.payload
  return [
    "# App Log",
    "",
    "Compatibility reference: `app.log` / `POST /log`.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Service | \`${escapeMarkdownTableCell(payload.service)}\` |`,
    `| Level | \`${payload.level}\` |`,
    `| Message | ${escapeMarkdownTableCell(payload.message)} |`,
    payload.extra
      ? `| Extra | \`${escapeMarkdownTableCell(JSON.stringify(payload.extra))}\` |`
      : "",
    "",
    "> Wrote the entry to BetterC0de's local console panel. Compatibility writes this payload to the server log endpoint.",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Remote access, settings tabs, console panel, app log and heap snapshot. */
export const APP_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["remote", "remote-access"],
      run: async (run) => {
        const { args } = run
        run.output = await executeRemoteAccessCommand(args)
      },
    },
    {
      names: [...SETTINGS_TAB_BY_COMMAND.keys()].map((command) =>
        command.slice(1)
      ),
      when: ({ cmd, args }) => Boolean(resolveSettingsTabCommand(cmd, args[0])),
      run: (run) => {
        const { cmd, args } = run
        const tab = resolveSettingsTabCommand(cmd, args[0]) ?? "general"
        openSettingsTab(tab)
        run.output = `# Settings\n\nOpened **${settingsTabLabel(tab)}**.`
      },
    },
    {
      names: [
        "console",
        "app.console",
        "app-console",
        "app.debug",
        "app-debug",
      ],
      run: (run) => {
        const prefs = usePreferencesStore.getState()
        const next = !prefs.consolePanelOpen
        prefs.set("consolePanelOpen", next)
        run.output = buildToggleOutput("Console Panel", next)
      },
    },
    {
      names: ["app.log", "app-log"],
      run: (run) => {
        const { args } = run
        const parsed = parseAppLogCommandArgs(args)
        if (parsed.payload) {
          emitAppLog(parsed.payload)
          usePreferencesStore.getState().set("consolePanelOpen", true)
        }
        run.output = buildAppLogOutput(parsed)
      },
    },
    {
      names: ["heap-snapshot", "app.heap_snapshot", "app-heap-snapshot"],
      run: async (run) => {
        run.output = buildRuntimeHeapSnapshotOutput(
          await writeRuntimeHeapSnapshot()
        )
      },
    },
  ]
