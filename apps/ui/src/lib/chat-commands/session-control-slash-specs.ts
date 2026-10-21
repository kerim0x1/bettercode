import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import { buildInterruptThreadOutput } from "./thread-actions"
import {
  buildRedoCheckpointOutput,
  buildUndoCheckpointOutput,
} from "./workspace-actions"
import { getElectronApi } from "@/services/ipc-facade"

function scheduleWindowCloseFromChat(): void {
  if (typeof window === "undefined") return
  window.setTimeout(() => {
    void getElectronApi()?.windowClose?.()
  }, 100)
}

/** Checkpoint undo and redo, turn interrupt and window exit. */
export const SESSION_CONTROL_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["undo", "session.undo", "session.revert"],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildUndoCheckpointOutput(threadId, args[0])
      },
    },
    {
      names: ["redo", "session.redo", "session.unrevert"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildRedoCheckpointOutput(threadId)
      },
    },
    {
      names: [
        "interrupt",
        "stop",
        "cancel",
        "session.interrupt",
        "session.abort",
      ],
      run: async (run) => {
        const { selectedProvider, selectedProviderId, threadId } = run
        run.output = await buildInterruptThreadOutput(
          threadId,
          selectedProvider,
          selectedProviderId
        )
      },
    },
    {
      names: ["exit", "quit", "q", "app.exit", "app-exit"],
      run: (run) => {
        scheduleWindowCloseFromChat()
        run.output = "# Exit\n\nClosing BetterC0de window."
      },
    },
  ]
