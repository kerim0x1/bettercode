import {
  buildBetterC0deAccountTerminalCommand,
  buildProviderOrganizationOutput,
} from "./account-commands"
import {
  buildBetterC0deGithubTerminalCommand,
  buildGithubAgentOutput,
} from "./github-commands"
import {
  buildBetterC0dePluginTerminalCommand,
  buildPluginInstallOutput,
  buildPluginToggleOutput,
} from "./plugin-commands"
import { openSettingsTab } from "./settings-actions"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  betterC0deGithubSlashSubcommand,
  stripBetterC0deGithubSlashSubcommand,
} from "./slash-subcommands"
import { getElectronApi } from "@/services/ipc-facade"

/** GitHub agent, docs, organizations and plugins. */
export const INTEGRATION_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "github",
        "github-agent",
        "github.install",
        "github-install",
        "github.run",
        "github-run",
      ],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        const githubSubcommand = betterC0deGithubSlashSubcommand(cmd, args)
        const githubCommand =
          githubSubcommand === "run"
            ? "/github.run"
            : githubSubcommand === "install"
              ? "/github.install"
              : cmd
        const githubArgs = githubSubcommand
          ? stripBetterC0deGithubSlashSubcommand(args)
          : args
        const terminalCommand = buildBetterC0deGithubTerminalCommand(
          githubCommand,
          githubArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = await buildGithubAgentOutput(
          githubCommand,
          githubArgs,
          activeThread
        )
      },
    },
    {
      names: ["docs", "documentation", "docs.open", "docs-open"],
      run: (run) => {
        const docsUrl =
          "https://github.com/kerim0x1/bettercode/blob/main/PRODUCT_GUIDE.md"
        const electronApi = getElectronApi()
        void (
          electronApi?.openExternal?.(docsUrl) ?? window.open(docsUrl, "_blank")
        )
        run.output = `# Docs\n\nOpened ${docsUrl}`
      },
    },
    {
      names: [
        "org",
        "organization",
        "orgs",
        "switch-org",
        "console.orgs",
        "console-orgs",
        "console.switch",
        "console-switch",
        "console.org.switch",
        "console-org-switch",
        "account.orgs",
        "account.switch",
      ],
      run: (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = buildBetterC0deAccountTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        openSettingsTab("models")
        run.output = buildProviderOrganizationOutput(cmd, args)
      },
    },
    {
      names: [
        "plugin-install",
        "plugin",
        "plug",
        "plugin.install",
        "plugins.install",
        "plugins-install",
        "dialog.plugins.install",
        "dialog-plugins-install",
      ],
      run: async (run) => {
        const { args, activeThread } = run
        const terminalCommand = buildBetterC0dePluginTerminalCommand(args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        openSettingsTab("plugins")
        run.output = await buildPluginInstallOutput(args, activeThread)
      },
    },
    {
      names: ["plugin-toggle", "plugins.toggle", "plugins-toggle"],
      run: async (run) => {
        const { args, activeThread } = run
        openSettingsTab("plugins")
        run.output = await buildPluginToggleOutput(args, activeThread)
      },
    },
  ]
