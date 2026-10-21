import {
  buildMcpAddOutput,
  buildMcpAuthOutput,
  buildMcpDebugOutput,
  buildMcpServersOutput,
  buildRuntimeMcpDetailOutput,
  buildRuntimeMcpToggleOutput,
  stripBetterC0deMcpSlashSubcommand,
} from "./mcp-actions"
import {
  buildBetterC0deMcpTerminalCommand,
  buildMcpLogoutOutput,
  buildMcpNotFoundOutput,
  buildMcpResourcesOutput,
  buildProjectMcpConfigOutput,
  isBetterC0deRuntimeTerminalFlag,
  resolveRuntimeMcpServer,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import { isSlashCommand } from "./prompt-commands"
import { openSettingsTab, resolveToggleArg } from "./settings-actions"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import { isBetterC0deMcpSlashSubcommand } from "./slash-subcommands"

/** MCP servers. Each `/mcp <subcommand>` spec precedes the alias family it maps to, and all of them precede the plain `/mcp` list. */
export const MCP_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["mcp"],
      when: ({ cmd, args }) =>
        isBetterC0deMcpSlashSubcommand(cmd, args, "resources"),
      run: (run) => {
        const { args, activeThread, mcpList } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        if (mcpArgs.some(isBetterC0deRuntimeTerminalFlag)) {
          dispatchPrefilledTerminalCommand(activeThread, "betterc0de serve")
        }
        run.output = buildMcpResourcesOutput(mcpList, mcpArgs)
      },
    },
    {
      names: [
        "mcp-resources",
        "mcp.resources",
        "mcp-resource-list",
        "resources",
        "experimental.resource.list",
        "experimental-resource-list",
      ],
      run: (run) => {
        const { args, activeThread, mcpList } = run
        if (args.some(isBetterC0deRuntimeTerminalFlag)) {
          dispatchPrefilledTerminalCommand(activeThread, "betterc0de serve")
        }
        run.output = buildMcpResourcesOutput(mcpList, args)
      },
    },
    {
      names: ["mcp"],
      when: ({ cmd, args }) =>
        isBetterC0deMcpSlashSubcommand(cmd, args, "auth"),
      run: (run) => {
        const { args, activeThread, mcpList } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        const terminalCommand = buildBetterC0deMcpTerminalCommand(
          "/mcp-auth",
          mcpArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
        const listOnly =
          cleanArgs[0]?.toLowerCase() === "list" ||
          cleanArgs[0]?.toLowerCase() === "ls"
        if (cleanArgs[0] && !listOnly) {
          const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
          run.output = matchedMcp
            ? buildRuntimeMcpDetailOutput(matchedMcp)
            : buildMcpNotFoundOutput(cleanArgs[0], mcpList)
        } else {
          run.output = buildMcpAuthOutput(mcpList, mcpArgs)
        }
      },
    },
    {
      names: [
        "mcp-auth",
        "mcp.auth",
        "mcp.auth.list",
        "mcp.auth.ls",
        "mcp.auth.start",
        "mcp.auth.callback",
        "mcp.auth.authenticate",
        "mcp-auth-list",
        "mcp-auth-ls",
      ],
      run: (run) => {
        const { cmd, args, activeThread, mcpList } = run
        const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
        if (cleanArgs[0]) {
          const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
          run.output = matchedMcp
            ? buildRuntimeMcpDetailOutput(matchedMcp)
            : buildMcpNotFoundOutput(cleanArgs[0], mcpList)
        } else {
          run.output = buildMcpAuthOutput(mcpList, args)
        }
      },
    },
    {
      names: ["mcp"],
      when: ({ cmd, args }) => isBetterC0deMcpSlashSubcommand(cmd, args, "add"),
      run: async (run) => {
        const { args, activeThread } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        if (mcpArgs.includes("--config-only")) {
          run.output = await buildProjectMcpConfigOutput(mcpArgs, activeThread)
        } else {
          const terminalCommand = buildBetterC0deMcpTerminalCommand(
            "/mcp-add",
            mcpArgs
          )
          if (terminalCommand.shouldOpen && terminalCommand.command) {
            dispatchPrefilledTerminalCommand(
              activeThread,
              terminalCommand.command
            )
          }
          openSettingsTab("tools")
          run.output = buildMcpAddOutput(activeThread, mcpArgs)
        }
      },
    },
    {
      names: ["mcp-add", "mcp.add", "mcp-install", "mcp.install"],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectMcpConfigOutput(args, activeThread)
        } else {
          const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
          if (terminalCommand.shouldOpen && terminalCommand.command) {
            dispatchPrefilledTerminalCommand(
              activeThread,
              terminalCommand.command
            )
          }
          openSettingsTab("tools")
          run.output = buildMcpAddOutput(activeThread, args)
        }
      },
    },
    {
      names: ["mcp"],
      when: ({ cmd, args }) =>
        isBetterC0deMcpSlashSubcommand(cmd, args, "logout"),
      run: (run) => {
        const { args, activeThread, mcpList } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        const terminalCommand = buildBetterC0deMcpTerminalCommand(
          "/mcp-logout",
          mcpArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
        run.output = buildMcpLogoutOutput(mcpList, cleanArgs[0], mcpArgs)
      },
    },
    {
      names: ["mcp-logout", "mcp.logout", "mcp.auth.remove", "mcp-auth-logout"],
      run: (run) => {
        const { cmd, args, activeThread, mcpList } = run
        const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
        run.output = buildMcpLogoutOutput(mcpList, cleanArgs[0], args)
      },
    },
    {
      names: ["mcp"],
      when: ({ cmd, args }) =>
        isBetterC0deMcpSlashSubcommand(cmd, args, "debug"),
      run: (run) => {
        const { args, activeThread, mcpList } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        const terminalCommand = buildBetterC0deMcpTerminalCommand(
          "/mcp-debug",
          mcpArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
        run.output = buildMcpDebugOutput(mcpList, cleanArgs[0], mcpArgs)
      },
    },
    {
      names: ["mcp-debug", "mcp.debug", "mcp-inspect"],
      run: (run) => {
        const { cmd, args, activeThread, mcpList } = run
        const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
        run.output = buildMcpDebugOutput(mcpList, cleanArgs[0], args)
      },
    },
    {
      names: ["mcp"],
      when: ({ cmd, args }) =>
        isBetterC0deMcpSlashSubcommand(cmd, args, "list"),
      run: (run) => {
        const { args, activeThread, mcpList } = run
        const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
        const terminalCommand = buildBetterC0deMcpTerminalCommand(
          "/mcp.list",
          mcpArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildMcpServersOutput(mcpList, mcpArgs)
      },
    },
    {
      names: ["mcps", "mcp", "mcp.list", "mcp.ls", "mcp.status", "mcp-ls"],
      run: async (run) => {
        const { cmd, args, activeThread, mcpList } = run
        const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
        if (cleanArgs[0]) {
          const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
          if (!matchedMcp) {
            run.output = buildMcpNotFoundOutput(cleanArgs[0], mcpList)
          } else if (cleanArgs[1]) {
            run.output = await buildRuntimeMcpToggleOutput(
              matchedMcp,
              resolveToggleArg(cleanArgs[1], matchedMcp.enabled)
            )
          } else {
            run.output = buildRuntimeMcpDetailOutput(matchedMcp)
          }
        } else {
          run.output = buildMcpServersOutput(mcpList, args)
        }
      },
    },
    {
      names: [
        "mcp-toggle",
        "toggle-mcp",
        "mcp.toggle",
        "mcp.connect",
        "mcp.disconnect",
        "dialog.mcp.toggle",
        "dialog-mcp-toggle",
        "mcp-enable",
        "mcp-disable",
      ],
      run: async (run) => {
        const { cmd, args, activeThread, mcpList } = run
        const forced = isSlashCommand(cmd, "mcp-enable")
          ? true
          : isSlashCommand(cmd, "mcp-disable")
            ? false
            : undefined
        if (args.includes("--config-only")) {
          const cleanArgs = args.filter(
            (arg) =>
              arg !== "--config-only" && !isBetterC0deRuntimeTerminalFlag(arg)
          )
          const target = cleanArgs[0]
          if (!target) {
            run.output =
              "# MCP Toggle\n\n> Usage: `/mcp-toggle <id> [on|off] --config-only`"
          } else {
            const matchedMcp = resolveRuntimeMcpServer(mcpList, target)
            const enabled =
              typeof forced === "boolean"
                ? forced
                : resolveToggleArg(cleanArgs[1], matchedMcp?.enabled ?? true)
            run.output = await buildProjectMcpConfigOutput(
              ["--config-only", target, "--enabled", String(enabled)],
              activeThread
            )
          }
        } else {
          const matchedMcp = args[0]
            ? resolveRuntimeMcpServer(mcpList, args[0])
            : null
          if (!args[0]) {
            run.output = "# MCP Toggle\n\n> Usage: `/mcp-toggle <id> [on|off]`"
          } else if (!matchedMcp) {
            run.output = buildMcpNotFoundOutput(args[0], mcpList)
          } else {
            run.output = await buildRuntimeMcpToggleOutput(
              matchedMcp,
              typeof forced === "boolean"
                ? forced
                : resolveToggleArg(args[1], matchedMcp.enabled)
            )
          }
        }
      },
    },
  ]
