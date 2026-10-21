import { useSettingsStore } from "@/lib/settings-store"
import { clearThreadShare, getThreadShare } from "@/lib/thread-share"
import { isSlashCommand } from "./prompt-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import {
  type SlashCommandRun,
  type SlashCommandRunSpec,
  abortSlashRun,
} from "./slash-run"
import {
  buildArchiveThreadOutput,
  buildArchivedThreadsOutput,
  buildCopyLastAssistantMessageOutput,
  buildCopyThreadOutput,
  buildDeleteThreadOutput,
  buildRenameThreadOutput,
  buildSessionUpdateThreadOutput,
  buildUnarchiveThreadOutput,
} from "./thread-actions"
import {
  buildBetterC0deSessionIoTerminalCommand,
  buildExportThreadOutput,
  buildImportThreadOutput,
  buildShareThreadOutput,
} from "./thread-export"
import {
  buildContextThreadOutput,
  buildEventsThreadOutput,
  buildMessagesThreadOutput,
  buildTimelineThreadOutput,
} from "./thread-inspection"
import { buildDiffThreadOutput } from "./vcs-commands"

function buildUnshareThreadOutput(threadId: string | null): string {
  if (!threadId) {
    return "# Unshare Session\n\n> No active chat to unshare."
  }
  const existing = getThreadShare(threadId)
  if (!existing) {
    return "# Unshare Session\n\n> This chat has no local share marker."
  }
  clearThreadShare(threadId)
  return [
    "# Unshare Session\n",
    "Removed this chat's local share marker.",
    "",
    `Previous export fingerprint: \`${existing.transcriptFingerprint}\``,
  ].join("\n")
}

/** Archive, delete, share, copy, export, import and inspect the invoking chat. */
export const THREAD_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    {
      names: ["archive", "archive-session", "session.archive"],
      run: async (run) => {
        const { args, store, threadId } = run
        run.output = await buildArchiveThreadOutput(
          store.threads,
          threadId,
          args.join(" ")
        )
      },
    },
    {
      names: ["unarchive", "unarchive-session", "session.unarchive"],
      run: async (run) => {
        const { args, store, threadId } = run
        run.output = await buildUnarchiveThreadOutput(
          store.threads,
          threadId,
          args.join(" ")
        )
      },
    },
    {
      names: ["archives", "archived", "archived-sessions"],
      run: (run) => {
        const { store } = run
        run.output = buildArchivedThreadsOutput(
          store.threads,
          useSettingsStore.getState().archivedThreadIds
        )
      },
    },
    {
      names: ["delete-session", "delete", "session.delete"],
      run: (run) => {
        const { args, rawText, store, threadId } = run
        const deleteResult = buildDeleteThreadOutput(
          store.threads,
          threadId,
          args
        )
        if (deleteResult.threadId && deleteResult.confirmed) {
          const deletedActiveThread = deleteResult.threadId === threadId
          store.deleteThread(deleteResult.threadId)
          if (deletedActiveThread) {
            const replacementThreadId = store.createThread(
              "New Chat",
              "BetterC0de"
            )
            store.addMessage(replacementThreadId, {
              id: crypto.randomUUID(),
              role: "user",
              content: rawText,
              createdAt: new Date().toISOString(),
            })
            store.addMessage(replacementThreadId, {
              id: crypto.randomUUID(),
              role: "assistant",
              content: deleteResult.output,
              createdAt: new Date().toISOString(),
            })
            return abortSlashRun(run)
          }
        }
        run.output = deleteResult.output
      },
    },
    {
      names: ["share", "session.share"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildShareThreadOutput(threadId)
      },
    },
    {
      names: ["unshare", "session.unshare"],
      run: (run) => {
        const { threadId } = run
        run.output = buildUnshareThreadOutput(threadId)
      },
    },
    {
      names: ["copy", "session.copy"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildCopyThreadOutput(threadId)
      },
    },
    {
      names: ["copy-last", "copy-assistant", "copy-message", "messages.copy"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildCopyLastAssistantMessageOutput(threadId)
      },
    },
    {
      names: [
        "export",
        "session.export",
        "betterc0de-export",
        "betterc0de.export",
      ],
      run: async (run) => {
        const { cmd, args, activeThread, threadId } = run
        const betterC0deExportMode = isSlashCommand(
          cmd,
          "session.export",
          "betterc0de-export",
          "betterc0de.export",
          "betterc0de-export",
          "betterc0de.export"
        )
        const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
          "export",
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = await buildExportThreadOutput(threadId, args, {
          betterC0deMode: betterC0deExportMode,
        })
      },
    },
    {
      names: [
        "import",
        "session.import",
        "betterc0de-import",
        "betterc0de.import",
      ],
      run: async (run) => {
        const { args, activeThread } = run
        const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
          "import",
          args
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = await buildImportThreadOutput(args, activeThread)
      },
    },
    {
      names: ["diff", "diffs", "session.diff"],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildDiffThreadOutput(threadId, args)
      },
    },
    {
      names: ["session.update"],
      run: async (run) => {
        const { args, store, threadId } = run
        run.output = await buildSessionUpdateThreadOutput(
          store.threads,
          threadId,
          args
        )
      },
    },
    {
      names: ["rename", "title", "session.rename"],
      run: (run) => {
        const { args, threadId } = run
        run.output = buildRenameThreadOutput(threadId, args)
      },
    },
    {
      names: ["timeline", "session.timeline"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildTimelineThreadOutput(threadId)
      },
    },
    {
      names: ["events", "event.subscribe", "event-subscribe", "session.events"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildEventsThreadOutput(threadId)
      },
    },
    {
      names: [
        "messages",
        "message-list",
        "message",
        "session.messages",
        "session.message",
        "session.message.list",
        "v2.session.messages",
        "v2-session-messages",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildMessagesThreadOutput(threadId, args)
      },
    },
    {
      names: [
        "context",
        "session.context",
        "context-list",
        "v2.session.context",
        "v2-session-context",
      ],
      run: async (run) => {
        const {
          args,
          selectedProvider,
          selectedModel,
          permissionLevel,
          contextWindow,
          effectiveChatMode,
          threadId,
        } = run
        run.output = await buildContextThreadOutput(threadId, {
          selectedProvider,
          selectedModel,
          chatMode: effectiveChatMode,
          permissionLevel,
          contextWindow,
          full: args.includes("--full"),
        })
      },
    },
  ]
