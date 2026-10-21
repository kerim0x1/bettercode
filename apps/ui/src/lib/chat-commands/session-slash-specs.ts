import { useAppearanceStore } from "@/lib/appearance-store"
import { useChatStore } from "@/lib/chat-store"
import { filterThreadsForSessionDirectory } from "@/lib/session-directory-filter"
import {
  mergeForkBack,
  resolveForkMessageReference,
} from "@/lib/thread-branching"
import { isSlashCommand } from "./prompt-commands"
import {
  type SlashCommandRun,
  type SlashCommandRunSpec,
  abortSlashRun,
} from "./slash-run"
import {
  buildPinThreadOutput,
  buildPinnedThreadsOutput,
  buildQuickSwitchThreadOutput,
  pinnedChatIds,
} from "./thread-actions"
import {
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSiblingChildThread,
} from "./thread-navigation"

function resolveQuickSwitchSlot(
  command: string,
  argument?: string
): number | null {
  const commandMatch = /^\/session\.quick_switch\.([1-9])$/.exec(command)
  if (commandMatch?.[1]) return Number(commandMatch[1])
  if (!isSlashCommand(command, "quick-switch")) return null
  const slot = Number(argument)
  return Number.isInteger(slot) && slot >= 1 && slot <= 9 ? slot : null
}

/** New chat, resume, session, fork-branch and pinned-slot navigation. */
export const SESSION_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    {
      names: ["new", "clear", "session.new", "session.create", "session-new"],
      run: (run) => {
        const { store } = run
        store.createThread("New Chat", "BetterC0de")
        return abortSlashRun(run)
      },
    },
    {
      names: ["resume", "continue"],
      run: (run) => {
        const { args, store, threadId } = run
        const sessionThreads = filterThreadsForSessionDirectory(
          store.threads,
          threadId,
          useAppearanceStore.getState().sessionDirectoryFilterEnabled
        )
        const target = args.join(" ").trim().toLowerCase()
        if (target) {
          const match = sessionThreads.find((thread) => {
            const title = thread.title.toLowerCase()
            return (
              thread.id.toLowerCase().startsWith(target) ||
              title.includes(target)
            )
          })
          if (match) {
            store.setActiveThread(match.id)
            return abortSlashRun(run)
          }
        }
      },
    },
    {
      names: [
        "session.next",
        "session-next",
        "session.next.unseen",
        "session-next-unseen",
      ],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveAdjacentSessionThread(
          filterThreadsForSessionDirectory(
            store.threads,
            threadId,
            useAppearanceStore.getState().sessionDirectoryFilterEnabled
          ),
          threadId,
          1
        )
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output = "# Next Session\n\n> No other session is available."
      },
    },
    {
      names: [
        "session.previous",
        "session-previous",
        "session.prev",
        "session-prev",
        "session.previous.unseen",
        "session-previous-unseen",
      ],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveAdjacentSessionThread(
          filterThreadsForSessionDirectory(
            store.threads,
            threadId,
            useAppearanceStore.getState().sessionDirectoryFilterEnabled
          ),
          threadId,
          -1
        )
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output = "# Previous Session\n\n> No other session is available."
      },
    },
    {
      names: ["fork", "session.fork"],
      run: async (run) => {
        const { rawText, store } = run
        if (!run.threadId) {
          run.threadId = store.createThread("New Chat", "BetterC0de")
          store.addMessage(run.threadId, {
            id: crypto.randomUUID(),
            role: "user",
            content: rawText,
            createdAt: new Date().toISOString(),
          })
          store.addMessage(run.threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "# Fork Session\n\n> No existing chat history to fork yet.",
            createdAt: new Date().toISOString(),
          })
          return abortSlashRun(run)
        }
        // `/fork <n>` keeps the history up to message n, numbered as
        // `/messages` lists the whole chat.
        let throughMessageId: string | undefined
        const reference = run.args[0]
        if (reference) {
          const threadId = run.threadId
          await store.ensureFullThreadMessages(threadId, { payloads: false })
          const resolved = resolveForkMessageReference(
            useChatStore
              .getState()
              .threads.find((thread) => thread.id === threadId)?.messages ?? [],
            reference
          )
          if ("error" in resolved) {
            run.output = `# Fork Session\n\n> ${resolved.error}`
            return abortSlashRun(run)
          }
          throughMessageId = resolved.messageId
        }
        const forkedThreadId = await store.forkThread(
          run.threadId,
          undefined,
          throughMessageId ? { throughMessageId } : undefined
        )
        if (forkedThreadId) {
          return abortSlashRun(run, { threadId: forkedThreadId })
        }
        run.output = "# Fork Session\n\n> The active chat could not be found."
      },
    },
    {
      names: ["merge-back", "session.merge_back", "session-merge-back"],
      run: async (run) => {
        if (!run.threadId) {
          run.output =
            "# Merge Back\n\n> Open a forked chat to merge it back into its parent."
          return abortSlashRun(run)
        }
        try {
          const { parentThreadId } = await mergeForkBack(run.threadId)
          // The hand-back is in the parent's queue and the parent is open;
          // nothing is added to the fork.
          return abortSlashRun(run, { threadId: parentThreadId })
        } catch (error) {
          run.output = `# Merge Back\n\n> ${
            error instanceof Error ? error.message : String(error)
          }`
          return abortSlashRun(run)
        }
      },
    },
    {
      names: ["parent", "session-parent", "session.parent"],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveParentThread(store.threads, threadId)
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Parent Session\n\n> This chat has no linked parent session."
      },
    },
    {
      names: [
        "child",
        "children",
        "session-child",
        "session.child",
        "session.children",
        "session.child.first",
      ],
      run: (run) => {
        const { args, store, threadId } = run
        const target = resolveChildThread(
          store.threads,
          threadId,
          args.join(" ")
        )
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Child Session\n\n> This chat has no linked child fork yet."
      },
    },
    {
      names: ["child-next", "next-child", "session.child.next"],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveSiblingChildThread(store.threads, threadId, 1)
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Next Child Session\n\n> This chat is not inside a child-session branch with siblings."
      },
    },
    {
      names: [
        "child-previous",
        "prev-child",
        "previous-child",
        "session.child.previous",
      ],
      run: (run) => {
        const { store, threadId } = run
        const target = resolveSiblingChildThread(store.threads, threadId, -1)
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output =
          "# Previous Child Session\n\n> This chat is not inside a child-session branch with siblings."
      },
    },
    {
      names: ["pin", "pin-session", "session.pin", "session.pin.toggle"],
      run: (run) => {
        const { store, threadId } = run
        run.output = buildPinThreadOutput(store, threadId)
      },
    },
    {
      names: ["pins", "pinned", "pinned-sessions"],
      run: (run) => {
        const { store } = run
        run.output = buildPinnedThreadsOutput(store.threads, pinnedChatIds())
      },
    },
    {
      names: [
        "quick-switch",
        "session.quick_switch.1",
        "session.quick_switch.2",
        "session.quick_switch.3",
        "session.quick_switch.4",
        "session.quick_switch.5",
        "session.quick_switch.6",
        "session.quick_switch.7",
        "session.quick_switch.8",
        "session.quick_switch.9",
      ],
      run: (run) => {
        const { cmd, args, store } = run
        const quickSwitchSlot = resolveQuickSwitchSlot(cmd, args[0])
        if (quickSwitchSlot === null) return
        const target = resolvePinnedThreadSlot(
          store.threads,
          pinnedChatIds(),
          quickSwitchSlot
        )
        if (target) {
          store.setActiveThread(target.id)
          return abortSlashRun(run)
        }
        run.output = buildQuickSwitchThreadOutput(quickSwitchSlot)
      },
    },
  ]
