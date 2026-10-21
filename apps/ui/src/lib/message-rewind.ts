import {
  asRecord,
  readBrowserElementAttachment,
  type BrowserElementReference,
} from "@betterc0de/schema"
import { providerKindFromActivityPayload } from "@betterc0de/schema/activity-tools"
import type { ThreadRewindFileRevertBlocker } from "@betterc0de/schema/http-contracts"
import { useChatStore, type ChatMessage } from "@/lib/chat-store"
import { useCheckpointStore } from "@/lib/checkpoint-store"
import { interruptTurn } from "@/lib/chat/send-message"
import { messageHasOmittedAttachmentData } from "@/lib/chat/message-payloads"
import type { ChatSubmitPayload } from "@/lib/chat/types"
import { handleError } from "@/lib/errors/handle"
import { HttpError } from "@/lib/errors/types"
import { latestProviderInstanceId } from "@/lib/provider-model-selection"
import {
  loadThreadRewindPlan,
  rewindThreadToMessage,
  type ThreadRewindPlan,
} from "@/services/backend/rewind-api"

/**
 * Edit and resend: the chat goes back to just before one of the user's
 * messages, and the edited text goes out as a new turn. The backend cuts
 * the stored chat and makes the agent's session forget the removed turns
 * (`apps/backend/src/services/thread-rewind.ts`); this module previews the
 * rewind, applies it to the transcript on screen and sends the new text.
 */

/** Changed files a preview lists; the rest are counted. */
export const REWIND_LISTED_FILES = 50

/** An attachment of the edited message, as the editor shows and resends it. */
export interface EditableAttachment {
  /** Position in the message's attachments; stable across a full reload. */
  readonly key: string
  readonly label: string
  readonly kind: "file" | "element"
}

export function editableAttachments(
  message: Pick<ChatMessage, "attachments">
): EditableAttachment[] {
  return (message.attachments ?? []).map((attachment, index) => {
    const element = readBrowserElementAttachment(attachment)
    return {
      key: String(index),
      kind: element ? "element" : "file",
      label: element
        ? attachment.filename || `<${element.tagName}>`
        : attachment.filename || attachment.mediaType || "Attachment",
    }
  })
}

/** What the kept attachments become in a new submission. */
export function resendAttachments(
  message: Pick<ChatMessage, "attachments">,
  keptKeys: ReadonlySet<string>
): {
  files: Array<{
    type: string
    filename: string | null
    mediaType: string | null
    url: string
  }>
  elements: BrowserElementReference[]
  missingData: boolean
} {
  const files: Array<{
    type: string
    filename: string | null
    mediaType: string | null
    url: string
  }> = []
  const elements: BrowserElementReference[] = []
  let missingData = false
  ;(message.attachments ?? []).forEach((attachment, index) => {
    if (!keptKeys.has(String(index))) return
    const element = readBrowserElementAttachment(attachment)
    if (element) {
      elements.push(element)
      return
    }
    if (attachment.dataOmitted === true) missingData = true
    files.push({
      type: attachment.type,
      filename: attachment.filename ?? null,
      mediaType: attachment.mediaType ?? null,
      url: attachment.url,
    })
  })
  return { files, elements, missingData }
}

function normalizedPath(filePath: string, workspaceRoot?: string | null) {
  const path = filePath.replace(/\\/g, "/")
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "")
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return path.slice(root.length + 1)
  }
  return path.replace(/^\.\//, "")
}

/** Files the answers after `index` recorded as changed. */
export function changedFilesAfter(
  messages: readonly Pick<ChatMessage, "role" | "diffs">[],
  index: number
): string[] {
  const paths: string[] = []
  for (const message of messages.slice(Math.max(0, index))) {
    if (message.role !== "assistant") continue
    for (const diff of message.diffs ?? []) {
      if (diff.path) paths.push(diff.path)
    }
  }
  return paths
}

/** One list of changed files, relative to the workspace, each file once. */
export function mergeChangedFiles(
  lists: readonly (readonly string[])[],
  workspaceRoot?: string | null
): string[] {
  const seen = new Map<string, string>()
  for (const list of lists) {
    for (const file of list) {
      const path = normalizedPath(file, workspaceRoot)
      const key = path.toLowerCase()
      if (path && !seen.has(key)) seen.set(key, path)
    }
  }
  return [...seen.values()]
}

/** Why "Revert files too" is unavailable, in the dialog's words. */
export function fileRevertBlockerText(
  blocker: ThreadRewindFileRevertBlocker | null
): string | null {
  switch (blocker) {
    case null:
      return null
    case "unsaved":
      return "Saving conversations is off, so this chat has no checkpoints."
    case "no_session":
      return "No agent session with a project folder belongs to this chat, so there is no checkpoint to restore."
    case "not_git":
      return "This folder isn't a Git repository, so there are no checkpoints to restore."
    case "no_checkpoint":
      return "The checkpoint for this point in the chat is missing."
    case "no_changes":
      return "No agent turn after this message has a checkpoint to undo."
  }
}

export interface RewindPreview {
  readonly plan: ThreadRewindPlan
  /** Changed files from the backend's checkpoints and the answers' diffs. */
  readonly changedFiles: string[]
  readonly changedFilesTruncated: boolean
  /** A turn is running in the chat and has to stop first. */
  readonly running: boolean
}

function locateMessage(
  threadId: string,
  messageId: string
): { messages: readonly ChatMessage[]; index: number } | null {
  const messages = useChatStore
    .getState()
    .threads.find((thread) => thread.id === threadId)?.messages
  const index = messages?.findIndex((message) => message.id === messageId)
  return messages && index !== undefined && index >= 0
    ? { messages, index }
    : null
}

function threadIsRunning(threadId: string): boolean {
  return (
    useChatStore.getState().streamingByThread[threadId]?.isStreaming === true
  )
}

function autonomyIsWorking(threadId: string): boolean {
  return (
    useChatStore.getState().autonomyByThread[threadId]?.status === "working"
  )
}

/** What resending this message would remove, and the choice it needs. */
export async function previewRewind(
  threadId: string,
  messageId: string,
  workspaceRoot?: string | null
): Promise<RewindPreview> {
  if (autonomyIsWorking(threadId)) {
    throw new Error(
      "Autonomous Work is running in this chat. Pause it before editing a message."
    )
  }
  const plan = await loadThreadRewindPlan(threadId, messageId)
  const located = locateMessage(threadId, messageId)
  const changed = mergeChangedFiles(
    [
      plan.changedFiles,
      located ? changedFilesAfter(located.messages, located.index) : [],
    ],
    workspaceRoot
  )
  return {
    plan,
    changedFiles: changed.slice(0, REWIND_LISTED_FILES),
    changedFilesTruncated:
      plan.changedFilesTruncated || changed.length > REWIND_LISTED_FILES,
    running: threadIsRunning(threadId),
  }
}

async function stopRunningTurn(threadId: string): Promise<void> {
  const state = useChatStore.getState()
  const thread = state.threads.find((candidate) => candidate.id === threadId)
  const activities = state.activitiesByThread[threadId] ?? []
  let providerKind = thread?.session?.providerKind ?? null
  for (
    let index = activities.length - 1;
    !providerKind && index >= 0;
    index -= 1
  ) {
    providerKind =
      providerKindFromActivityPayload(asRecord(activities[index]?.payload)) ??
      null
  }
  await interruptTurn(
    threadId,
    providerKind ?? "openai",
    thread?.session?.providerInstanceId ?? latestProviderInstanceId(activities)
  )
  // The partial answer is about to be removed with the rest, so it is
  // dropped rather than finalized into a message.
  useChatStore.getState().clearStreaming(threadId)
}

function isTurnActiveError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    (error.code === "turn_active" ||
      error.message.includes("already has active provider work"))
  )
}

const TURN_RELEASE_ATTEMPTS = 8
const TURN_RELEASE_DELAY_MS = 400

/**
 * The backend refuses a rewind while a turn is active. Right after a stop
 * the turn takes a moment to wind down, so the request is retried briefly.
 */
async function rewindWhenIdle(
  threadId: string,
  messageId: string,
  revertFiles: boolean,
  retry: boolean
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rewindThreadToMessage(threadId, messageId, { revertFiles })
    } catch (error) {
      if (!retry || !isTurnActiveError(error)) throw error
      if (attempt >= TURN_RELEASE_ATTEMPTS) {
        throw new Error(
          "The running turn didn't stop in time. Try again in a moment."
        )
      }
      await new Promise((resolve) =>
        setTimeout(resolve, TURN_RELEASE_DELAY_MS * attempt)
      )
    }
  }
}

/** Removes the message and everything after it from the transcript on screen. */
function applyLocalRewind(
  threadId: string,
  messageId: string,
  serverDeleted: number
): void {
  const located = locateMessage(threadId, messageId)
  if (!located) return
  const keep = located.messages.slice(0, located.index)
  const removed = located.messages.slice(located.index)
  useChatStore.setState((state) => {
    const streamingByThread = { ...state.streamingByThread }
    const activitiesByThread = { ...state.activitiesByThread }
    const activitiesLoadedByThread = { ...state.activitiesLoadedByThread }
    delete streamingByThread[threadId]
    delete activitiesByThread[threadId]
    delete activitiesLoadedByThread[threadId]
    return {
      streamingByThread,
      activitiesByThread,
      activitiesLoadedByThread,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: keep,
              // Older pages may not be loaded: count what was removed.
              messageCount:
                thread.messageCount === undefined
                  ? keep.length
                  : Math.max(keep.length, thread.messageCount - removed.length),
              updatedAt: new Date().toISOString(),
            }
          : thread
      ),
    }
  })
  useCheckpointStore.getState().deleteCheckpointsAfter(threadId, {
    messageIds: removed.map((message) => message.id),
  })
  const store = useChatStore.getState()
  void store.hydrateThreadActivities(threadId)
  // A file restore goes back to the last checkpoint, which may sit before
  // a few kept rows (a local command's output); take the stored chat then.
  if (serverDeleted > removed.length) {
    void store.hydrateThreadMessages(threadId, true)
  }
}

export interface RewindAndResendInput {
  readonly threadId: string
  readonly messageId: string
  readonly text: string
  /** `EditableAttachment.key`s the user kept. */
  readonly keptAttachmentKeys: ReadonlySet<string>
  readonly revertFiles: boolean
  /** Stop a running turn first (the user confirmed it). */
  readonly stopRunningTurn: boolean
  /** The chat's submit handler (`ChatSubmitPayload`). */
  readonly resend: (payload: ChatSubmitPayload) => unknown
}

/**
 * Rewinds the chat to just before the message and sends the edited text.
 * Throws, with nothing changed, when the rewind cannot happen. Once the
 * chat is rewound the editor is gone, so a failed send is reported here and
 * the text goes back to the composer.
 */
export async function rewindAndResend(
  input: RewindAndResendInput
): Promise<void> {
  const { threadId, messageId } = input
  const text = input.text.trim()
  if (autonomyIsWorking(threadId)) {
    throw new Error(
      "Autonomous Work is running in this chat. Pause it before editing a message."
    )
  }
  let located = locateMessage(threadId, messageId)
  if (!located) throw new Error("This message is no longer in the chat.")
  // Light transcript pages leave large attachments out; resending needs them.
  const original = located.messages[located.index]!
  if (
    messageHasOmittedAttachmentData(original) &&
    [...input.keptAttachmentKeys].some(
      (key) => original.attachments?.[Number(key)]?.dataOmitted === true
    )
  ) {
    await useChatStore.getState().hydrateFullMessage(threadId, messageId)
    located = locateMessage(threadId, messageId)
    if (!located) throw new Error("This message is no longer in the chat.")
  }
  const attachments = resendAttachments(
    located.messages[located.index]!,
    input.keptAttachmentKeys
  )
  if (attachments.missingData) {
    throw new Error(
      "An attachment of this message couldn't be loaded. Remove it or try again."
    )
  }
  if (!text && attachments.files.length === 0) {
    throw new Error("Write a message or keep an attachment to send.")
  }

  const running = threadIsRunning(threadId)
  if (running && !input.stopRunningTurn) {
    throw new Error("A turn is running in this chat. Stop it first.")
  }
  if (running) await stopRunningTurn(threadId)

  const result = await rewindWhenIdle(
    threadId,
    messageId,
    input.revertFiles,
    running
  )
  if (!result.rewound) {
    throw new Error(result.reason ?? "The chat couldn't be rewound.")
  }
  applyLocalRewind(threadId, messageId, result.deletedMessages)

  // Delivered like a queued draft: its own id, time and element tags, and
  // not queued behind drafts the stop paused, which predate the edit.
  const payload: ChatSubmitPayload = {
    threadId,
    text,
    files: attachments.files,
    queuedSubmission: {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      browserElements: attachments.elements,
    },
  }
  try {
    const sent = await Promise.resolve(input.resend(payload))
    if (sent === false) {
      useChatStore.getState().setDraft(threadId, input.text)
      handleError(
        new Error(
          "The chat was rewound, but the edited message wasn't sent. It's back in the composer."
        ),
        { source: "message-resend" }
      )
    }
  } catch (error) {
    // The submit path already shows the failure under the message.
    handleError(error, { source: "message-resend", silent: true })
  }
}
