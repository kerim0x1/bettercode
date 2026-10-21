import {
  buildBetterC0deCliParityMarkdown,
  buildBetterC0deGapMarkdown,
  buildBetterC0deHttpParityMarkdown,
  buildBetterC0deParityMarkdown,
} from "@/lib/betterc0de-parity"
import { buildBetterC0deTipsMarkdown } from "@/lib/betterc0de-tips"
import {
  buildBetterC0deAuthControlOutput,
  buildBetterC0deInternalRouteOutput,
  buildBetterC0deInternalRouteTerminalCommand,
  buildBetterC0deLifecycleRouteOutput,
  buildBetterC0deTuiControlRouteOutput,
} from "./compat-route-commands"
import {
  buildBetterC0deSyncRouteOutput,
  buildBetterC0deWorkspaceRouteOutput,
} from "./compat-sync-commands"
import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import {
  buildBetterC0deDebugConfigOutput,
  buildProjectConfigOutput,
  buildProjectKeybindsOutput,
  buildProjectTuiConfigOutput,
} from "./project-config-commands"
import { isSlashCommand } from "./prompt-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import { buildProjectTuiConfigWriteOutput } from "./tui-commands"

const BETTERC0DE_INTERNAL_ROUTE_COMMANDS = new Set([
  "auth.set",
  "auth.remove",
  "provider.oauth.authorize",
  "provider.oauth.callback",
  "experimental.console.get",
  "experimental.console.listOrgs",
  "experimental.console.switchOrg",
  "experimental.session.list",
  "experimental.workspace.adapter.list",
  "experimental.workspace.create",
  "experimental.workspace.list",
  "experimental.workspace.remove",
  "experimental.workspace.status",
  "global.event",
  "global.upgrade",
  "part.delete",
  "part.update",
  "project.initGit",
  "session.command",
  "session.deleteMessage",
  "session.prompt",
  "session.prompt_async",
  "session.shell",
  "session.summarize",
  "tui.appendPrompt",
  "tui.clearPrompt",
  "tui.command.execute",
  "tui.executeCommand",
  "tui.openHelp",
  "tui.openModels",
  "tui.openSessions",
  "tui.openThemes",
  "tui.prompt.append",
  "tui.publish",
  "tui.selectSession",
  "tui.session.select",
  "tui.showToast",
  "tui.toast.show",
  "tui.submitPrompt",
  "v2.session.prompt",
  "v2.session.wait",
])

/** BetterC0de compatibility config, parity reports and route commands. `/auth.set` and `/auth.remove` stay ahead of the internal-route spec that also lists them. */
export const COMPAT_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "betterc0de",
        "betterc0de-config",
        "project-config",
        "debug.config",
        "debug-config",
        "config.get",
        "config-get",
        "config.update",
        "config-update",
        "global.config.get",
        "global-config-get",
        "global.config.update",
        "global-config-update",
        "compat-config",
      ],
      run: (run) => {
        const { cmd, args, activeThread, projectConfigList } = run
        if (isSlashCommand(cmd, "debug.config", "debug-config")) {
          if (args.some(isBetterC0deRuntimeTerminalFlag)) {
            dispatchPrefilledTerminalCommand(
              activeThread,
              "betterc0de debug config"
            )
          }
          run.output = buildBetterC0deDebugConfigOutput(
            projectConfigList,
            activeThread,
            args
          )
        } else {
          run.output = buildProjectConfigOutput(projectConfigList, activeThread)
        }
      },
    },
    {
      names: [
        "betterc0de-audit",
        "betterc0de.parity",
        "betterc0de-parity",
        "compat",
        "compat-audit",
        "parity",
      ],
      run: (run) => {
        run.output = buildBetterC0deParityMarkdown()
      },
    },
    {
      names: [
        "betterc0de-cli",
        "betterc0de.commands",
        "betterc0de-commands",
        "betterc0de.entrypoints",
        "betterc0de-entrypoints",
      ],
      run: (run) => {
        const { args } = run
        run.output = buildBetterC0deCliParityMarkdown(args)
      },
    },
    {
      names: [
        "betterc0de-api",
        "betterc0de.api",
        "betterc0de-http",
        "betterc0de.http",
        "openapi",
        "openapi.operations",
      ],
      run: (run) => {
        const { args } = run
        run.output = buildBetterC0deHttpParityMarkdown(args)
      },
    },
    {
      names: [
        "betterc0de-gaps",
        "betterc0de.missing",
        "betterc0de-missing",
        "betterc0de.todo",
        "betterc0de-todo",
      ],
      run: (run) => {
        const { args } = run
        run.output = buildBetterC0deGapMarkdown(args)
      },
    },
    {
      names: [
        "betterc0de-sync",
        "betterc0de.sync",
        "sync",
        "sync.history.list",
        "sync-history",
        "sync.replay",
        "sync-replay",
        "sync.start",
        "sync-start",
        "sync.steal",
        "sync-steal",
      ],
      run: (run) => {
        const { cmd, args, activeThread, store, threadId } = run
        run.output = buildBetterC0deSyncRouteOutput(cmd, args, {
          threads: store.threads,
          activeThreadId: threadId,
          activitiesByThread: store.activitiesByThread,
          streamingByThread: store.streamingByThread,
          activeThread,
        })
      },
    },
    {
      names: [
        "betterc0de-workspace",
        "betterc0de.workspace",
        "experimental.workspace.syncList",
        "experimental-workspace-sync-list",
        "experimental.workspace.warp",
        "experimental-workspace-warp",
      ],
      run: (run) => {
        const { cmd, args, activeThread, store, threadId } = run
        run.output = buildBetterC0deWorkspaceRouteOutput(cmd, args, {
          threads: store.threads,
          activeThreadId: threadId,
          activeThread,
        })
      },
    },
    {
      names: [
        "betterc0de-lifecycle",
        "betterc0de.lifecycle",
        "global.dispose",
        "global-dispose",
        "instance.dispose",
        "instance-dispose",
      ],
      run: (run) => {
        const { cmd, activeThread } = run
        run.output = buildBetterC0deLifecycleRouteOutput(cmd, activeThread)
      },
    },
    {
      names: [
        "tui-control",
        "tui.control.next",
        "tui-control-next",
        "tui.control.response",
        "tui-control-response",
      ],
      run: (run) => {
        const { cmd, args } = run
        run.output = buildBetterC0deTuiControlRouteOutput(cmd, args)
      },
    },
    {
      names: ["auth.set", "auth-set", "auth.remove", "auth-remove"],
      run: (run) => {
        const { cmd, args } = run
        run.output = buildBetterC0deAuthControlOutput(cmd, args)
      },
    },
    {
      names: [
        "betterc0de-internal",
        "betterc0de.internal",
        ...BETTERC0DE_INTERNAL_ROUTE_COMMANDS,
      ],
      run: (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = buildBetterC0deInternalRouteTerminalCommand(
          cmd,
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildBetterC0deInternalRouteOutput(cmd, args)
      },
    },
    {
      names: ["tui", "tui-config"],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        run.output = args.includes("--config-only")
          ? await buildProjectTuiConfigWriteOutput(args, activeThread)
          : buildProjectTuiConfigOutput(projectConfigList, activeThread)
      },
    },
    {
      names: [
        "keybinds",
        "keybindings",
        "which-key",
        "which-key.toggle",
        "which-key.layout.toggle",
        "which-key.pending.toggle",
        "which-key.group.previous",
        "which-key.group.next",
        "which-key.scroll.up",
        "which-key.scroll.down",
        "which-key.page.up",
        "which-key.page.down",
        "which-key.home",
        "which-key.end",
      ],
      run: async (run) => {
        const { args, activeThread, projectConfigList } = run
        run.output = args.includes("--config-only")
          ? await buildProjectTuiConfigWriteOutput(args, activeThread)
          : buildProjectKeybindsOutput(projectConfigList, activeThread)
      },
    },
    {
      names: ["tips", "tips.toggle", "betterc0de-tips", "tips-toggle"],
      run: (run) => {
        run.output = buildBetterC0deTipsMarkdown()
      },
    },
  ]
