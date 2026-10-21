/**
 * Steering: sends a queued message into its chat's running turn so the
 * agent changes course. The message waits first in the chat's queue
 * (persisted like every queued draft, so a restart pauses it there) while
 * the backend tries it (`/chat/steer`):
 *
 * - `steered`: the provider took it. It leaves the queue and shows in the
 *   transcript as a user message, at the time it was sent.
 * - `unsupported`: the provider takes no input mid-turn. The turn is
 *   stopped, without pausing the queue, and the message is sent next.
 * - `not_running`, `not_steerable`: it stays first and goes out as the next
 *   turn once the running one ends.
 *
 * A failed request fails the message and pauses its chat's queue, like a
 * failed queued send.
 */
import {
  ATTACHMENTS_ONLY_MESSAGE,
  browserElementAttachment,
  browserElementsPrompt,
} from "@betterc0de/schema"
import { QUEUE_TEXT } from "@betterc0de/schema/message-queue"
import { normalizeChatAttachments } from "@/lib/chat-commands/input-context"
import { useChatStore } from "@/lib/chat-store"
import { handleError } from "@/lib/errors/handle"
import {
  useMessageQueueStore,
  type QueuedMessage,
} from "@/lib/message-queue-store"
import { postChatSteer } from "@/services/backend/chatApi"
import { interruptTurn } from "./send-message"
import { canSteerPayload, type SteerTarget } from "./steer-delivery"

export type SteerOutcome =
  /** The running turn took the message. */
  | "steered"
  /** The turn was stopped; the message is sent next. */
  | "stopped"
  /** The message waits first in the queue for the next turn. */
  | "queued"
  /** The request failed; the message is failed and its queue paused. */
  | "failed"
  /** The message is gone, already being sent, or cannot be steered. */
  | "skipped"

export async function steerQueuedMessage(
  id: string,
  target: SteerTarget
): Promise<SteerOutcome> {
  const current = useMessageQueueStore
    .getState()
    .messages.find((message) => message.id === id)
  if (!current || !canSteerPayload(current.payload)) return "skipped"
  let entry: QueuedMessage | null
  try {
    entry = useMessageQueueStore.getState().claimForSteer(id)
  } catch (error) {
    handleError(error, { source: "message-queue" })
    return "failed"
  }
  if (!entry) return "skipped"
  const { threadId, payload } = entry
  const stream = useChatStore.getState().streamingByThread[threadId]
  if (!stream?.isStreaming) {
    // Nothing to steer into: it goes out as the next turn.
    release(id)
    return "queued"
  }

  const text =
    payload.text.trim() ||
    (payload.files.length > 0 ? ATTACHMENTS_ONLY_MESSAGE : "")
  const context = browserElementsPrompt(payload.browserElements)
  const attachments = [
    ...normalizeChatAttachments(payload.files),
    ...payload.browserElements.map(browserElementAttachment),
  ]
  const content = payload.visibleText ?? text
  const createdAt = new Date().toISOString()
  const modelId = stream.streamingModelId

  let status: Awaited<ReturnType<typeof postChatSteer>>["status"]
  try {
    const response = await postChatSteer({
      threadId,
      providerKind: target.providerKind,
      providerInstanceId: target.providerInstanceId,
      message: context ? `${context}\n\n${text}` : text,
      userMessageId: id,
      userMessageContent: content,
      userMessageCreatedAt: createdAt,
      modelId,
      attachments,
    })
    status = response.status
  } catch (error) {
    // As for a queued send: the message may have arrived, so the queue
    // waits for the user instead of sending it again.
    const reason =
      error instanceof Error ? error.message : "The message was not sent."
    try {
      useMessageQueueStore
        .getState()
        .fail(id, `${QUEUE_TEXT.unconfirmed} ${reason}`)
    } catch (storageError) {
      handleError(storageError, { source: "message-queue" })
    }
    handleError(error, { source: "chat-steer" })
    return "failed"
  }

  if (status === "steered") {
    // The backend stored the message; this shows it until the next read.
    useChatStore.getState().addMessage(
      threadId,
      {
        id,
        role: "user",
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(modelId ? { modelId } : {}),
        createdAt,
      },
      { persist: false }
    )
    try {
      useMessageQueueStore.getState().finish(id)
    } catch (error) {
      handleError(error, { source: "message-queue" })
    }
    return "steered"
  }

  release(id)
  if (status === "not_steerable") {
    const { toast } = await import("sonner")
    toast.info(
      "The current step takes no messages. Yours is sent when it ends."
    )
    return "queued"
  }
  if (status !== "unsupported") return "queued"

  // Stop pressed while the request ran leaves the message paused; the turn
  // is then already being stopped.
  const released = useMessageQueueStore
    .getState()
    .messages.find((message) => message.id === id)
  if (released?.status !== "queued") return "queued"
  try {
    await interruptTurn(
      threadId,
      target.providerKind,
      target.providerInstanceId,
      { pauseQueue: false }
    )
  } catch (error) {
    handleError(error, { source: "chat-steer" })
  }
  // As Stop does: end the local stream, which lets the queue send next.
  if (useChatStore.getState().streamingByThread[threadId]?.isStreaming)
    useChatStore.getState().finalizeStream(threadId)
  return "stopped"
}

function release(id: string): void {
  try {
    useMessageQueueStore.getState().release(id)
  } catch (error) {
    handleError(error, { source: "message-queue" })
  }
}
