import { stringifyCliArgs } from "@/lib/cli-parse"
import { usePreferencesStore } from "@/lib/preferences-store"
import { dispatchTerminalNewSession } from "@/lib/terminal-events"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type { WorkspaceProjectConfigSetting } from "@/services/backend/workspaceApi"
import { getRuntimeDebugInfo } from "@/services/backend/coreApi"
import { buildBetterC0deDbPathOutput } from "./debug-info-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  buildProjectPluginsOutput,
  buildProjectToolsConfigOutput,
  buildProjectToolsOutput,
} from "./project-config-commands"
import {
  type ActiveThreadRef,
  buildProjectProviderConfigOutput,
  buildProjectProvidersOutput,
  escapeMarkdownTableCell,
} from "./provider-config"
import {
  betterC0deDbMode,
  buildBetterC0deMaintenanceCliArgs,
  buildBetterC0deMaintenanceOutput,
  buildBetterC0deRuntimeEntrypointOutput,
} from "./runtime-commands"
import {
  buildBetterC0deRuntimeConfigOutput,
  isBetterC0deAttachmentConfigKey,
  isBetterC0deCompactionConfigKey,
  isBetterC0deRuntimeConfigKey,
  isBetterC0deToolOutputConfigKey,
} from "./runtime-config"
import {
  buildBetterC0deSessionCliOutput,
  buildBetterC0deSessionCliTerminalCommand,
} from "./session-cli-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

function buildProjectConfigGroupOutput(input: {
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>
  activeThread: ActiveThreadRef
  heading: string
  emptyTitle: string
  emptyMessage: string
  match: (key: string) => boolean
}): string {
  const runtimePath = resolveThreadRuntimePath(input.activeThread)
  if (!runtimePath) {
    return `# ${input.emptyTitle}\n\n> No workspace folder is open.`
  }
  const rows = input.settings.filter((setting) => input.match(setting.key))
  if (rows.length === 0) {
    return [`# ${input.emptyTitle}\n`, `> ${input.emptyMessage}`].join("\n")
  }

  return [
    `# ${input.heading}\n`,
    `${rows.length} setting${rows.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`.\n`,
    "| Setting | Kind | Value | Source |",
    "|:--------|:-----|:------|:-------|",
    ...rows.map(
      (setting) =>
        `| **${escapeMarkdownTableCell(setting.label)}** (\`${escapeMarkdownTableCell(setting.key)}\`) | ${setting.kind} | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
    ),
  ].join("\n")
}

function buildBetterC0deRuntimeTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("attach") || normalized === "attach"
      ? "attach"
      : normalized.includes("serve")
        ? "serve"
        : normalized.includes("web")
          ? "web"
          : normalized.includes("acp") || normalized === "acp"
            ? "acp"
            : normalized.includes("tui") ||
                normalized.includes("thread") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui")
              ? ""
              : "run"
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  return {
    command: ["betterc0de", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deMaintenanceTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode = normalized.includes("uninstall")
    ? "uninstall"
    : normalized.includes("completion")
      ? "completion"
      : normalized.includes("generate") || normalized.includes("openapi")
        ? "generate"
        : normalized.includes("db")
          ? "db"
          : "upgrade"
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  return {
    command: ["betterc0de", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

/** BetterC0de runtime limits, entrypoints, maintenance, session CLI and project provider, plugin and tool config. */
export const COMPAT_CONFIG_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "attachments",
        "attachment",
        "image-attachments",
        "betterc0de-attachments",
      ],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        if (args.includes("--config-only")) {
          run.output = await buildBetterC0deRuntimeConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectConfigGroupOutput({
            activeThread,
            emptyTitle: "BetterC0de Attachments",
            emptyMessage:
              "No BetterC0de attachment config found. Defaults are auto resize on, max 2000x2000, and 5 MB base64 payload.",
            heading: "BetterC0de Attachments",
            match: isBetterC0deAttachmentConfigKey,
            settings: projectConfigList,
          })
        }
      },
    },
    {
      names: ["tool-output", "tool-output-limits", "betterc0de-tool-output"],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        if (args.includes("--config-only")) {
          run.output = await buildBetterC0deRuntimeConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectConfigGroupOutput({
            activeThread,
            emptyTitle: "BetterC0de Tool Output",
            emptyMessage:
              "No BetterC0de tool_output config found. BetterC0de will use its runtime defaults.",
            heading: "BetterC0de Tool Output",
            match: isBetterC0deToolOutputConfigKey,
            settings: projectConfigList,
          })
        }
      },
    },
    {
      names: ["compaction", "context-compaction", "betterc0de-compaction"],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        if (args.includes("--config-only")) {
          run.output = await buildBetterC0deRuntimeConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectConfigGroupOutput({
            activeThread,
            emptyTitle: "BetterC0de Compaction",
            emptyMessage:
              "No BetterC0de compaction config found. BetterC0de will use its runtime defaults.",
            heading: "BetterC0de Compaction",
            match: isBetterC0deCompactionConfigKey,
            settings: projectConfigList,
          })
        }
      },
    },
    {
      names: [
        "betterc0de-runtime",
        "betterc0de.server",
        "betterc0de-app",
        "runtime-config",
        "betterc0de-server",
      ],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        if (args.includes("--config-only")) {
          run.output = await buildBetterC0deRuntimeConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectConfigGroupOutput({
            activeThread,
            emptyTitle: "BetterC0de Runtime Config",
            emptyMessage:
              "No BetterC0de compatibility runtime/app config found. BetterC0de will use its own app defaults.",
            heading: "BetterC0de Runtime Config",
            match: isBetterC0deRuntimeConfigKey,
            settings: projectConfigList,
          })
        }
      },
    },
    {
      names: [
        "betterc0de-tui",
        "betterc0de.thread",
        "betterc0de-thread",
        "betterc0de.ui",
        "betterc0de-ui",
        "betterc0de-run",
        "betterc0de.run",
        "betterc0de-cli-run",
        "betterc0de-serve",
        "betterc0de.serve",
        "betterc0de-server-start",
        "betterc0de-attach",
        "betterc0de.attach",
        "betterc0de-server-switch",
        "attach",
        "attach-server",
        "server.switch",
        "server-switch",
        "betterc0de-web",
        "betterc0de.web",
        "betterc0de-web-ui",
        "betterc0de-acp",
        "betterc0de.acp",
        "acp",
      ],
      run: (run) => {
        const { cmd, args, activeThread, threadId } = run
        const terminalCommand = buildBetterC0deRuntimeTerminalCommand(cmd, args)
        const runtimePath = resolveThreadRuntimePath(activeThread)
        if (
          runtimePath &&
          terminalCommand.shouldOpen &&
          terminalCommand.command
        ) {
          const prefs = usePreferencesStore.getState()
          prefs.set("terminalOpen", true)
          window.setTimeout(() => {
            dispatchTerminalNewSession({
              threadId,
              mode: prefs.appMode,
              cwd: runtimePath,
              initialCommand: terminalCommand.command,
            })
          }, 0)
        }
        run.output = buildBetterC0deRuntimeEntrypointOutput(
          cmd,
          args,
          activeThread
        )
      },
    },
    {
      names: [
        "betterc0de-upgrade",
        "betterc0de.upgrade",
        "betterc0de-update",
        "betterc0de-uninstall",
        "betterc0de.uninstall",
        "betterc0de-generate",
        "betterc0de.generate",
        "betterc0de-openapi",
        "betterc0de-completion",
        "betterc0de.completion",
        "completion",
        "betterc0de-db",
        "betterc0de.db",
        "betterc0de-db-path",
        "betterc0de-db-migrate",
        "betterc0de-db-query",
        "betterc0de.db.query",
        "db",
        "db.migrate",
        "db.query",
        "db-query",
      ],
      run: async (run) => {
        const { cmd, args, activeThread, threadId } = run
        const terminalCommand = buildBetterC0deMaintenanceTerminalCommand(
          cmd,
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          const prefs = usePreferencesStore.getState()
          prefs.set("terminalOpen", true)
          window.setTimeout(() => {
            dispatchTerminalNewSession({
              threadId,
              mode: prefs.appMode,
              cwd: resolveThreadRuntimePath(activeThread),
              initialCommand: terminalCommand.command,
            })
          }, 0)
        }
        const maintenanceCommandKey = cmd.replace(/^\//, "").toLowerCase()
        const isBetterC0deDbMaintenanceCommand =
          maintenanceCommandKey.includes("db") ||
          ["db", "db.migrate", "db.query", "db-query"].includes(
            maintenanceCommandKey
          )
        run.output =
          isBetterC0deDbMaintenanceCommand &&
          betterC0deDbMode(cmd, args) === "path"
            ? buildBetterC0deDbPathOutput(
                await getRuntimeDebugInfo(),
                cmd,
                args
              )
            : buildBetterC0deMaintenanceOutput(cmd, args)
      },
    },
    {
      names: [
        "betterc0de-session",
        "betterc0de.session",
        "betterc0de-session-list",
        "betterc0de.session.list",
        "betterc0de-session-delete",
        "betterc0de.session.delete",
        "session-cli",
        "session.cli",
      ],
      run: (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = buildBetterC0deSessionCliTerminalCommand(
          cmd,
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildBetterC0deSessionCliOutput(cmd, args, activeThread)
      },
    },
    {
      names: [
        "project-providers",
        "provider-config",
        "betterc0de-providers",
        "config.providers",
        "config-providers",
        "v2.provider.list",
        "v2-provider-list",
        "v2.provider.get",
        "v2-provider-get",
      ],
      run: async (run) => {
        const { args, activeThread, projectProvidersSummary } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectProviderConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectProvidersOutput(
            projectProvidersSummary,
            activeThread
          )
        }
      },
    },
    {
      names: ["project-plugins", "betterc0de-plugins"],
      run: (run) => {
        const { args, activeThread, projectPluginList } = run
        run.output = buildProjectPluginsOutput(
          projectPluginList,
          activeThread,
          args
        )
      },
    },
    {
      names: [
        "project-tools",
        "betterc0de-tools",
        "tool.list",
        "tool-list",
        "tool.ids",
        "tool-ids",
      ],
      run: async (run) => {
        const { args, permissionLevel, activeThread, projectToolList } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectToolsConfigOutput(args, activeThread)
        } else {
          run.output = buildProjectToolsOutput(
            projectToolList,
            activeThread,
            permissionLevel
          )
        }
      },
    },
  ]
