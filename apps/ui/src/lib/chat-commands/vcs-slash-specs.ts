import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  buildFindOutput,
  buildVcsApplyTerminalCommand,
  buildVcsOutput,
  isVcsApplyCommand,
} from "./vcs-commands"

/** VCS status, diff and patch apply, and workspace find. */
export const VCS_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "vcs",
        "vcs.status",
        "vcs-status",
        "vcs.get",
        "vcs.diff",
        "vcs-diff",
        "vcs.diff.raw",
        "vcs-diff-raw",
        "vcs-apply",
        "vcs.apply",
      ],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = isVcsApplyCommand(cmd, args)
          ? buildVcsApplyTerminalCommand(args)
          : { command: "", shouldOpen: false }
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = await buildVcsOutput(cmd, args, activeThread)
      },
    },
    {
      names: [
        "find",
        "find.text",
        "find-text",
        "find.file",
        "find-file",
        "find.files",
        "find-files",
        "find.symbol",
        "find-symbol",
        "find.symbols",
        "find-symbols",
      ],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        run.output = await buildFindOutput(cmd, args, activeThread)
      },
    },
  ]
