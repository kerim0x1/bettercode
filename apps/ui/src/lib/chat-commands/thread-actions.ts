import {
  archivedThreadIdsAfterAction,
  resolveSessionCommandThread,
} from "@/lib/chat-commands/thread-navigation"
import {
  useChatStore,
  type ChatMessage,
  type ChatThread,
} from "@/lib/chat-store"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  removePromptStashEntry,
  resolvePromptStashEntry,
} from "@/lib/prompt-stash"
import type { UiProvider } from "@/lib/provider-types"
import { useSettingsStore } from "@/lib/settings-store"
import { togglePinnedChats } from "@/lib/chat-list-actions"
import { interruptTurn } from "@/lib/chat/send-message"
import { escapeMarkdownTableCell } from "./provider-config"
import { formatSessionTime, parseSessionUpdateArgs } from "./session-commands"
import { copyTextToClipboard, loadThreadTranscript } from "./thread-export"

export function buildPromptStashPopOutput(
  selector: string | undefined,
  threadId: string
): string {
  const prefs = usePreferencesStore.getState()
  const resolved = resolvePromptStashEntry(prefs.promptStashEntries, selector)
  if (!resolved) {
    return [
      "# Prompt Stash",
      "",
      "> No matching stashed prompt found.",
      "",
      "Use `/stashes` to inspect available entries.",
    ].join("\n")
  }
  prefs.set(
    "promptStashEntries",
    removePromptStashEntry(prefs.promptStashEntries, resolved.index)
  )
  dispatchComposerDraftRestoreAfterSubmit({
    text: resolved.entry.input,
    threadId,
  })
  return [
    "# Prompt Stash",
    "",
    `Restored prompt #${resolved.displayIndex} (\`${resolved.entry.id.slice(0, 8)}\`) into the composer.`,
    "",
    "> The entry was removed from the stash, matching BetterC0de pop behavior.",
  ].join("\n")
}

export function buildPromptStashDeleteOutput(
  selector: string | undefined
): string {
  if (!selector?.trim()) {
    return "# Prompt Stash\n\n> Usage: `/stash-delete <#|id>`"
  }
  const prefs = usePreferencesStore.getState()
  const resolved = resolvePromptStashEntry(prefs.promptStashEntries, selector)
  if (!resolved) {
    return [
      "# Prompt Stash",
      "",
      `> No stashed prompt matched \`${selector}\`.`,
      "",
      "Use `/stashes` to inspect available entries.",
    ].join("\n")
  }
  prefs.set(
    "promptStashEntries",
    removePromptStashEntry(prefs.promptStashEntries, resolved.index)
  )
  return [
    "# Prompt Stash",
    "",
    `Deleted prompt #${resolved.displayIndex} (\`${resolved.entry.id.slice(0, 8)}\`).`,
  ].join("\n")
}

export function buildPinThreadOutput(
  store: ReturnType<typeof useChatStore.getState>,
  threadId: string | null | undefined
): string {
  if (!threadId) {
    return "# Pin Session\n\n> No active chat session to pin."
  }
  const thread = store.threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Pin Session\n\n> The active chat session could not be found."
  }
  // The sidebar's Pinned group (settings), not the chat store's
  // `pinThread`, which only keeps visible chats in memory.
  const result = togglePinnedChats([threadId], { toast: false })
  return [
    "# Pin Session",
    "",
    `${result === "pinned" ? "Pinned" : "Unpinned"} **${thread.title}**.`,
    "",
    "> Pinned sessions lead the sidebar and fill BetterC0de-compatible quick-switch slots 1-9 in pin order.",
  ].join("\n")
}

/** The sidebar's pinned chats, in order, for `/pins` and `/quick-switch`. */
export function pinnedChatIds(): ReadonlySet<string> {
  return new Set(useSettingsStore.getState().pinnedThreadIds)
}

export function buildPinnedThreadsOutput(
  threads: readonly ChatThread[],
  pinnedThreadIds: ReadonlySet<string>
): string {
  const pinned = [...pinnedThreadIds]
    .map((id) => threads.find((thread) => thread.id === id) ?? null)
    .filter((thread): thread is ChatThread => Boolean(thread))
    .slice(0, 9)
  if (pinned.length === 0) {
    return "# Pinned Sessions\n\n> No sessions pinned yet. Use `/pin` in a chat to add it to the quick-switch slots."
  }
  return [
    "# Pinned Sessions",
    "",
    "| Slot | Session | Project | Updated |",
    "|:-----|:--------|:--------|:--------|",
    ...pinned.map(
      (thread, index) =>
        `| ${index + 1} | **${escapeMarkdownTableCell(thread.title)}** | ${escapeMarkdownTableCell(thread.projectName ?? "-")} | ${formatSessionTime(thread.updatedAt)} |`
    ),
    "",
    "> Use `/quick-switch <slot>` or `/session.quick_switch.<slot>` to jump to a pinned session.",
  ].join("\n")
}

export function buildQuickSwitchThreadOutput(slot: number): string {
  return `# Quick Switch\n\n> No pinned session in slot ${slot}. Use \`/pins\` to inspect available slots.`
}

export function resolveInterruptProviderKind(
  selectedProvider: Pick<UiProvider, "providerKind" | "id"> | undefined,
  selectedProviderId?: string | null
): string {
  return (
    selectedProvider?.providerKind ??
    selectedProvider?.id ??
    selectedProviderId ??
    "openai"
  )
}

export async function buildInterruptThreadOutput(
  threadId: string | null | undefined,
  selectedProvider: UiProvider | undefined,
  selectedProviderId?: string | null
): Promise<string> {
  if (!threadId) {
    return "# Interrupt\n\n> No active chat session to interrupt."
  }
  const store = useChatStore.getState()
  const stream = store.streamingByThread[threadId]
  if (!stream?.isStreaming && !stream?.activeTurnId) {
    return "# Interrupt\n\n> No active provider turn is streaming for this chat."
  }
  const providerKind = resolveInterruptProviderKind(
    selectedProvider,
    selectedProviderId
  )
  try {
    await interruptTurn(
      threadId,
      providerKind,
      selectedProvider?.providerInstanceId ?? null
    )
  } finally {
    store.finalizeStream(threadId)
  }
  return ["# Interrupt", "", "Interrupted the active provider turn."].join("\n")
}

export async function buildArchiveThreadOutput(
  threads: readonly ChatThread[],
  activeThreadId: string | null | undefined,
  query: string
): Promise<string> {
  const target = resolveSessionCommandThread(threads, activeThreadId, query)
  if (!target) {
    return "# Archive Session\n\n> No matching chat session found."
  }
  const settings = useSettingsStore.getState()
  await settings.update({
    archived_thread_ids: archivedThreadIdsAfterAction(
      settings.archivedThreadIds,
      target.id,
      "archive"
    ),
  })
  return [
    "# Archive Session",
    "",
    `Archived **${target.title}**.`,
    "",
    "> Use `/archives` to list archived sessions or `/unarchive <id|title>` to restore one.",
  ].join("\n")
}

export async function buildUnarchiveThreadOutput(
  threads: readonly ChatThread[],
  activeThreadId: string | null | undefined,
  query: string
): Promise<string> {
  const settings = useSettingsStore.getState()
  const target = resolveSessionCommandThread(threads, activeThreadId, query)
  if (!target) {
    return "# Unarchive Session\n\n> No matching chat session found."
  }
  await settings.update({
    archived_thread_ids: archivedThreadIdsAfterAction(
      settings.archivedThreadIds,
      target.id,
      "unarchive"
    ),
  })
  return [
    "# Unarchive Session",
    "",
    `Restored **${target.title}** to the sidebar.`,
  ].join("\n")
}

export function buildArchivedThreadsOutput(
  threads: readonly ChatThread[],
  archivedThreadIds: readonly string[]
): string {
  const archived = archivedThreadIds
    .map((id) => threads.find((thread) => thread.id === id) ?? null)
    .filter((thread): thread is ChatThread => Boolean(thread))
  if (archived.length === 0) {
    return "# Archived Sessions\n\n> No archived sessions found."
  }
  return [
    "# Archived Sessions",
    "",
    "| # | Session | Project | Updated | ID |",
    "|:--|:--------|:--------|:--------|:---|",
    ...archived.map(
      (thread, index) =>
        `| ${index + 1} | **${escapeMarkdownTableCell(thread.title)}** | ${escapeMarkdownTableCell(thread.projectName ?? "-")} | ${formatSessionTime(thread.updatedAt)} | \`${escapeMarkdownTableCell(thread.id)}\` |`
    ),
    "",
    "> Use `/unarchive <id|title>` to restore a session.",
  ].join("\n")
}

export function buildDeleteThreadOutput(
  threads: readonly ChatThread[],
  activeThreadId: string | null | undefined,
  args: readonly string[]
): {
  output: string
  threadId: string | null
  confirmed: boolean
} {
  const confirmed = args.some((arg) =>
    ["--yes", "-y", "yes", "confirm"].includes(arg.toLowerCase())
  )
  const query = args
    .filter(
      (arg) => !["--yes", "-y", "yes", "confirm"].includes(arg.toLowerCase())
    )
    .join(" ")
  const target = resolveSessionCommandThread(threads, activeThreadId, query)
  if (!target) {
    return {
      output: "# Delete Session\n\n> No matching chat session found.",
      threadId: null,
      confirmed: false,
    }
  }
  if (!confirmed) {
    const suffix = query.trim() ? ` ${query.trim()}` : ""
    return {
      output: [
        "# Delete Session",
        "",
        `Ready to permanently delete **${target.title}**.`,
        "",
        `Run \`/delete-session${suffix} --yes\` to confirm.`,
        "",
        "> This removes the chat from BetterC0de storage. Use `/archive` if you only want to hide it from the sidebar.",
      ].join("\n"),
      threadId: target.id,
      confirmed: false,
    }
  }
  return {
    output: ["# Delete Session", "", `Deleted **${target.title}**.`].join("\n"),
    threadId: target.id,
    confirmed: true,
  }
}

export async function buildCopyThreadOutput(
  threadId: string | null
): Promise<string> {
  const loaded = await loadThreadTranscript(threadId, "Copy Session")
  if (typeof loaded === "string") return loaded

  const copied = await copyTextToClipboard(loaded.transcript)
  return [
    "# Copy Session\n",
    copied
      ? "Copied this chat transcript to the clipboard."
      : "Clipboard copy was unavailable.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| **Thread** | \`${loaded.thread.id.slice(0, 8)}\` |`,
    `| **Messages** | ${loaded.thread.messages.length} |`,
  ].join("\n")
}

export async function buildCopyLastAssistantMessageOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId)
    return "# Copy Assistant Message\n\n> No active chat is selected."

  const store = useChatStore.getState()
  await store.hydrateThreadMessages(threadId)
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Copy Assistant Message\n\n> The active chat could not be found."
  }

  const text = lastAssistantMessageText(thread.messages)
  if (!text) {
    return "# Copy Assistant Message\n\n> No assistant message with text content was found."
  }

  const copied = await copyTextToClipboard(text)
  return [
    "# Copy Assistant Message\n",
    copied
      ? "Copied the latest assistant message to the clipboard."
      : "Clipboard copy was unavailable.",
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| **Thread** | \`${thread.id.slice(0, 8)}\` |`,
    `| **Characters** | ${text.length} |`,
  ].join("\n")
}

export function buildRenameThreadOutput(
  threadId: string | null,
  args: readonly string[]
): string {
  if (!threadId) return "# Rename Session\n\n> No active chat is selected."

  const nextTitle = sanitizeThreadRenameTitle(args.join(" "))
  if (!nextTitle) {
    return "# Rename Session\n\n> Usage: `/rename <new title>`."
  }

  const store = useChatStore.getState()
  const thread = store.threads.find((candidate) => candidate.id === threadId)
  if (!thread) {
    return "# Rename Session\n\n> The active chat could not be found."
  }

  const previousTitle = thread.title || "Untitled"
  store.updateThreadTitle(threadId, nextTitle)
  return [
    "# Rename Session\n",
    `Renamed this chat to **${nextTitle}**.`,
    "",
    "| Field | Value |",
    "|:--|:--|",
    `| Previous title | ${escapeMarkdownTableCell(previousTitle)} |`,
    `| New title | ${escapeMarkdownTableCell(nextTitle)} |`,
  ].join("\n")
}

export async function buildSessionUpdateThreadOutput(
  threads: readonly ChatThread[],
  activeThreadId: string | null | undefined,
  args: readonly string[]
): Promise<string> {
  const update = parseSessionUpdateArgs(args)
  if (update.title) {
    return buildRenameThreadOutput(activeThreadId ?? null, [update.title])
  }
  if (update.archived !== undefined) {
    return update.archived
      ? buildArchiveThreadOutput(threads, activeThreadId, "")
      : buildUnarchiveThreadOutput(threads, activeThreadId, "")
  }
  if (update.permission) {
    return [
      "# Update Session",
      "",
      "Compatibility reference: `session.update`.",
      "",
      `Requested permission metadata: \`${escapeMarkdownTableCell(update.permission)}\``,
      "",
      "> BetterC0de keeps runtime approval policy in the composer permission menu and `/autoaccept`; project permission rules are managed with `/permissions --config-only`.",
    ].join("\n")
  }
  return [
    "# Update Session",
    "",
    "Compatibility reference: `session.update`.",
    "",
    "> Usage: `/session.update --title <title>`, `/session.update --archive true`, `/session.update --unarchive`, or `/session.update --permission <rule>`.",
  ].join("\n")
}

export function sanitizeThreadRenameTitle(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 120)
}

export function lastAssistantMessageText(
  messages: ReadonlyArray<ChatMessage>
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== "assistant") continue
    const text = message.content.trim()
    if (text) return text
  }
  return null
}
