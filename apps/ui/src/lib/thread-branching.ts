import {
  useChatStore,
  type ChatMessage,
  type ChatThread,
} from "@/lib/chat-store"
import type { ThreadSettings } from "@/lib/chat/types"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { changedFilesAfter, mergeChangedFiles } from "@/lib/message-rewind"

/**
 * Branching a chat: "Fork from here" starts a new chat with the history up
 * to one answer, and "Merge back to parent" hands a fork's result to the
 * chat it came from.
 *
 * A fork works in the same folder (and the same worktree, if the parent has
 * one) as its parent, like `/fork` always did: its file changes land where
 * the parent works, so merging back hands over the conversation, not files.
 */

/** Longest fork answer a hand-back carries; the rest stays in the fork. */
export const HAND_BACK_MAX_ANSWER_CHARS = 12_000
/** Changed files a hand-back lists by name. */
export const HAND_BACK_MAX_FILES = 40

/**
 * Whether the chat is a fork the user made. Orchestration workers also have
 * a parent, but report to their lead on their own.
 */
export function isUserFork(
  thread: Pick<ChatThread, "parentThreadId"> | null | undefined,
  settings: Pick<ThreadSettings, "orchestrationWorker"> | undefined
): boolean {
  return (
    Boolean(thread?.parentThreadId) && settings?.orchestrationWorker !== true
  )
}

/**
 * What the fork added itself. Copies of the parent's history keep their
 * original times, so they all predate the fork.
 */
export function forkOwnMessages(
  fork: Pick<ChatThread, "createdAt" | "messages">
): ChatMessage[] {
  return fork.messages.filter((message) => message.createdAt >= fork.createdAt)
}

/**
 * The fork's last answer from the agent: an answer that came from a turn
 * (it has a turn or a model) wins over a local command's output or an
 * error line.
 */
export function lastForkAnswer(
  messages: readonly ChatMessage[]
): string | null {
  let fallback: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== "assistant") continue
    if (message.compactedContext || message.internalContext) continue
    const content = message.content.trim()
    if (!content) continue
    if (message.turnId || message.modelId) return content
    fallback ??= content
  }
  return fallback
}

function inlineCode(value: string): string {
  return value.includes("`") ? value : `\`${value}\``
}

/** The message a fork sends its parent when it is merged back. */
export function buildForkHandBack(input: {
  readonly forkTitle: string
  readonly answer: string
  readonly changedFiles: readonly string[]
}): string {
  const title =
    input.forkTitle.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled fork"
  const answer = input.answer.trim()
  const clipped =
    answer.length > HAND_BACK_MAX_ANSWER_CHARS
      ? `${answer.slice(0, HAND_BACK_MAX_ANSWER_CHARS).trimEnd()}\n\n[The rest of this answer is in the fork.]`
      : answer
  const listed = input.changedFiles.slice(0, HAND_BACK_MAX_FILES)
  const more = input.changedFiles.length - listed.length
  return [
    `Merged back from the fork "${title}". Take its result into account from here on.`,
    "",
    listed.length > 0
      ? "Files the fork changed (in the same folder as this chat):"
      : "The fork didn't change any files.",
    ...listed.map((file) => `- ${inlineCode(file)}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    "",
    "The fork's last answer:",
    "",
    clipped,
  ].join("\n")
}

/**
 * `/fork 12`: the message numbered 12 in `/messages`, which counts from 1
 * over the whole chat.
 */
export function resolveForkMessageReference(
  messages: readonly Pick<ChatMessage, "id">[],
  reference: string
): { messageId: string } | { error: string } {
  const value = reference.trim()
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return {
      error:
        "Usage: `/fork` copies the whole chat; `/fork <number>` copies it up to that message, numbered as `/messages` lists them.",
    }
  }
  const number = Number(value)
  if (number > messages.length) {
    return {
      error: `This chat has ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    }
  }
  return { messageId: messages[number - 1]!.id }
}

/** Starts a new chat with the history up to and including `messageId`. */
export async function forkFromMessage(
  threadId: string,
  messageId: string
): Promise<string> {
  const forkId = await useChatStore
    .getState()
    .forkThread(threadId, undefined, { throughMessageId: messageId })
  if (!forkId) throw new Error("This chat couldn't be forked.")
  return forkId
}

export interface MergeBackOutcome {
  readonly parentThreadId: string
  /** The parent was busy, so the hand-back waits in its queue. */
  readonly queued: boolean
}

/** Why this chat can't merge back right now, or `null` when it can. */
export function mergeBackBlocker(threadId: string | null): string | null {
  const state = useChatStore.getState()
  const fork = threadId
    ? state.threads.find((thread) => thread.id === threadId)
    : undefined
  if (!fork || !isUserFork(fork, state.settingsByThread[fork.id])) {
    return "This chat isn't a fork, so there is no parent to merge back into."
  }
  if (!state.threads.some((thread) => thread.id === fork.parentThreadId)) {
    return "The chat this fork came from is no longer available."
  }
  if (state.streamingByThread[fork.id]?.isStreaming) {
    return "The fork is still working. Merge it back once its turn has finished."
  }
  return null
}

/**
 * Sends the parent the fork's last answer and the files it changed, as a
 * message of the user's, then opens the parent. The message goes through
 * the parent's queue: it is sent at once when the parent is idle and after
 * the current turn when it is busy.
 */
export async function mergeForkBack(
  forkThreadId: string
): Promise<MergeBackOutcome> {
  const blocker = mergeBackBlocker(forkThreadId)
  if (blocker) throw new Error(blocker)
  await useChatStore
    .getState()
    .ensureFullThreadMessages(forkThreadId, { payloads: false })
  const state = useChatStore.getState()
  const fork = state.threads.find((thread) => thread.id === forkThreadId)
  const parentThreadId = fork?.parentThreadId
  if (!fork || !parentThreadId) {
    throw new Error("This chat isn't a fork anymore.")
  }
  const own = forkOwnMessages(fork)
  const answer = lastForkAnswer(own)
  if (!answer) {
    throw new Error("The fork has no answer to hand back yet.")
  }
  const changedFiles = mergeChangedFiles(
    [changedFilesAfter(own, 0)],
    fork.worktreePath || fork.projectPath
  )
  const queue = useMessageQueueStore.getState()
  const queued =
    state.streamingByThread[parentThreadId]?.isStreaming === true ||
    queue.messages.some((entry) => entry.threadId === parentThreadId)
  queue.enqueue(parentThreadId, {
    text: buildForkHandBack({ forkTitle: fork.title, answer, changedFiles }),
    files: [],
    browserElements: [],
  })
  useChatStore.getState().setActiveThread(parentThreadId)
  return { parentThreadId, queued }
}
