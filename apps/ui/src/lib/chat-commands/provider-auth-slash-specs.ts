import {
  buildBetterC0deAccountTerminalCommand,
  buildProviderOrganizationOutput,
} from "./account-commands"
import { isSlashCommand } from "./prompt-commands"
import {
  buildBetterC0deProviderAuthTerminalCommand,
  buildBetterC0deProviderConnectTerminalCommand,
  buildProviderAuthOutput,
  buildProviderConnectionOutput,
} from "./provider-commands"
import { openSettingsTab } from "./settings-actions"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  isBetterC0deConsoleSlashSubcommand,
  isBetterC0deProviderSlashSubcommand,
  stripBetterC0deConsoleSlashSubcommand,
  stripBetterC0deProviderSlashSubcommand,
} from "./slash-subcommands"

/** `/providers|auth <subcommand>` and `/console|account <subcommand>`. Registered ahead of the settings, console and auth specs that share these names. */
export const PROVIDER_SUBCOMMAND_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["providers", "auth"],
      when: ({ cmd, args }) =>
        isBetterC0deProviderSlashSubcommand(cmd, args, "login"),
      run: (run) => {
        const { cmd, args, selectedProvider, activeThread } = run
        const providerArgs = stripBetterC0deProviderSlashSubcommand(args)
        const providerMode = isSlashCommand(cmd, "auth")
          ? "/auth.login"
          : "/providers.login"
        const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
          providerMode,
          providerArgs,
          selectedProvider
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderConnectionOutput(
          selectedProvider,
          providerMode,
          providerArgs
        )
      },
    },
    {
      names: ["providers", "auth"],
      when: ({ cmd, args }) =>
        isBetterC0deProviderSlashSubcommand(cmd, args, "list") ||
        isBetterC0deProviderSlashSubcommand(cmd, args, "logout"),
      run: (run) => {
        const { cmd, args, selectedProvider, providers, activeThread } = run
        const providerArgs = stripBetterC0deProviderSlashSubcommand(args)
        const authRoot = isSlashCommand(cmd, "auth")
        const providerMode = isBetterC0deProviderSlashSubcommand(
          cmd,
          args,
          "logout"
        )
          ? authRoot
            ? "/auth.logout"
            : "/providers.logout"
          : authRoot
            ? "/auth.list"
            : "/providers.list"
        const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
          providerMode,
          providerArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderAuthOutput(
          providers,
          selectedProvider,
          providerMode,
          providerArgs
        )
      },
    },
    {
      names: ["console", "account"],
      when: ({ cmd, args }) =>
        isBetterC0deConsoleSlashSubcommand(cmd, args, "login") ||
        isBetterC0deConsoleSlashSubcommand(cmd, args, "open"),
      run: (run) => {
        const { cmd, args, selectedProvider, activeThread } = run
        const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
        const consoleMode = isBetterC0deConsoleSlashSubcommand(
          cmd,
          args,
          "open"
        )
          ? "/console.open"
          : "/console.login"
        const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
          consoleMode,
          consoleArgs,
          selectedProvider
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderConnectionOutput(
          selectedProvider,
          consoleMode,
          consoleArgs
        )
      },
    },
    {
      names: ["console", "account"],
      when: ({ cmd, args }) =>
        isBetterC0deConsoleSlashSubcommand(cmd, args, "logout"),
      run: (run) => {
        const { args, selectedProvider, providers, activeThread } = run
        const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
        const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
          "/console.logout",
          consoleArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderAuthOutput(
          providers,
          selectedProvider,
          "/console.logout",
          consoleArgs
        )
      },
    },
    {
      names: ["console", "account"],
      when: ({ cmd, args }) =>
        isBetterC0deConsoleSlashSubcommand(cmd, args, "orgs") ||
        isBetterC0deConsoleSlashSubcommand(cmd, args, "switch"),
      run: (run) => {
        const { cmd, args, activeThread } = run
        const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
        const consoleMode = isBetterC0deConsoleSlashSubcommand(
          cmd,
          args,
          "switch"
        )
          ? "/console.switch"
          : "/console.orgs"
        const terminalCommand = buildBetterC0deAccountTerminalCommand(
          consoleMode,
          consoleArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        openSettingsTab("models")
        run.output = buildProviderOrganizationOutput(consoleMode, consoleArgs)
      },
    },
  ]

/** Provider connection and authentication status. */
export const PROVIDER_AUTH_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "connect",
        "provider.connect",
        "provider-connect",
        "providers.login",
        "provider.login",
        "auth.login",
        "auth.connect",
        "console.login",
        "console.open",
        "account.login",
        "account.open",
      ],
      run: (run) => {
        const { cmd, args, selectedProvider, activeThread } = run
        const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
          cmd,
          args,
          selectedProvider
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderConnectionOutput(selectedProvider, cmd, args)
      },
    },
    {
      names: [
        "auth",
        "auth.list",
        "auth.ls",
        "auth.get",
        "provider-auth",
        "provider.auth",
        "providers.list",
        "providers.ls",
        "provider.list",
        "provider.ls",
        "providers.logout",
        "provider.logout",
        "auth.logout",
        "console.logout",
        "account",
        "account.list",
        "account.logout",
      ],
      run: (run) => {
        const { cmd, args, selectedProvider, providers, activeThread } = run
        const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
          cmd,
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildProviderAuthOutput(
          providers,
          selectedProvider,
          cmd,
          args
        )
      },
    },
  ]
