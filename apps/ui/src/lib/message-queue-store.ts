import { create } from "zustand"
import type { BrowserElementReference } from "@betterc0de/schema"
import {
  claimMessage,
  discardThread as discardThreadMessages,
  enqueueMessage,
  failMessage,
  finishMessage,
  pauseThread,
  releaseMessage,
  removeMessage,
  restoreQueue,
  resumeThread,
  type QueuedMessage as SharedQueuedMessage,
} from "@betterc0de/schema/message-queue"
import type { ChatSubmitPayload } from "@/lib/chat/types"
import {
  claimMessageForSteer,
  enqueueMessageFirst,
  moveQueuedMessage,
  moveQueuedMessageBefore,
  updateQueuedMessage,
} from "@/lib/message-queue-editing"

export type QueuedMessagePayload = Omit<
  ChatSubmitPayload,
  "threadId" | "queuedSubmission" | "delivery"
> & {
  browserElements: BrowserElementReference[]
}
/** The queue's rules are shared with the phone app (@betterc0de/schema/message-queue). */
export type QueuedMessage = SharedQueuedMessage<QueuedMessagePayload>
export interface QueueStorage {
  read(): string | null
  write(value: string): void
}
const key = "betterc0de-message-queue"
const browserStorage: QueueStorage = {
  read: () =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(key),
  write: (value) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value)
  },
}

interface MessageQueueState {
  messages: QueuedMessage[]
  enqueue(threadId: string, payload: QueuedMessagePayload): QueuedMessage
  /** Adds a message at the front of its chat's queue (one to steer). */
  enqueueFirst(threadId: string, payload: QueuedMessagePayload): QueuedMessage
  /** Replaces a draft's text and attachments, unless it is being sent. */
  edit(id: string, payload: QueuedMessagePayload): void
  /** One place up (`-1`) or down (`1`) in its chat's queue. */
  move(id: string, step: -1 | 1): void
  /** In front of another message of its chat, or last with `null`. */
  moveBefore(id: string, beforeId: string | null): void
  /** Takes a message to steer into the running turn (see message-queue-editing). */
  claimForSteer(id: string): QueuedMessage | null
  claim(id: string): QueuedMessage | null
  finish(id: string): void
  release(id: string): void
  fail(id: string, error: string): void
  pause(threadId: string, reason?: string): void
  resume(threadId: string): void
  remove(id: string): void
  discardThread(threadId: string): void
}

function isQueuedMessagePayload(
  payload: unknown
): payload is QueuedMessagePayload {
  const value = payload as Partial<QueuedMessagePayload> | null
  return Boolean(
    value &&
    typeof value.text === "string" &&
    Array.isArray(value.files) &&
    Array.isArray(value.browserElements)
  )
}

function restore(storage: QueueStorage): QueuedMessage[] {
  try {
    return restoreQueue(storage.read(), isQueuedMessagePayload)
  } catch {
    return []
  }
}

/** Unsubmitted drafts, like browser selections, live in the renderer's local
 * storage. Provider messages still use the existing durable dispatch lane. */
export function createMessageQueueStore(
  storage: QueueStorage = browserStorage
) {
  return create<MessageQueueState>((set, get) => {
    const commit = (messages: QueuedMessage[]) => {
      // Persist before acknowledging enqueue or starting delivery. A quota
      // failure leaves the composer draft and the previous queue untouched.
      storage.write(JSON.stringify(messages))
      set({ messages })
    }
    // Stop, fail and discard must still take effect in memory when browser
    // storage is full; restored drafts are paused on startup regardless.
    const commitOrKeep = (messages: QueuedMessage[]) => {
      try {
        commit(messages)
      } catch (error) {
        set({ messages })
        throw error
      }
    }
    const newMessage = (
      threadId: string,
      payload: QueuedMessagePayload
    ): QueuedMessage => ({
      id: crypto.randomUUID(),
      threadId,
      createdAt: new Date().toISOString(),
      payload: structuredClone(payload),
      status: "queued",
    })
    // Edits and moves change only an unsent draft; when nothing changes the
    // queue is not written again.
    const commitChange = (messages: QueuedMessage[] | null) => {
      if (messages) commit(messages)
    }
    return {
      messages: restore(storage),
      enqueue(threadId, payload) {
        const message = newMessage(threadId, payload)
        commit(enqueueMessage(get().messages, message))
        return message
      },
      enqueueFirst(threadId, payload) {
        const message = newMessage(threadId, payload)
        commit(enqueueMessageFirst(get().messages, message))
        return message
      },
      edit(id, payload) {
        commitChange(
          updateQueuedMessage(get().messages, id, structuredClone(payload))
        )
      },
      move(id, step) {
        commitChange(moveQueuedMessage(get().messages, id, step))
      },
      moveBefore(id, beforeId) {
        commitChange(moveQueuedMessageBefore(get().messages, id, beforeId))
      },
      claimForSteer(id) {
        const { messages, claimed } = claimMessageForSteer(get().messages, id)
        if (claimed) commit(messages)
        return claimed
      },
      claim(id) {
        const { messages, claimed } = claimMessage(get().messages, id)
        if (claimed) commit(messages)
        return claimed
      },
      finish: (id) => commit(finishMessage(get().messages, id)),
      release(id) {
        if (get().messages.some((message) => message.id === id))
          commit(releaseMessage(get().messages, id))
      },
      fail(id, error) {
        if (!get().messages.some((message) => message.id === id)) return
        commitOrKeep(failMessage(get().messages, id, error))
      },
      pause(threadId, reason) {
        const messages = pauseThread(get().messages, threadId, reason)
        if (messages) commitOrKeep(messages)
      },
      resume(threadId) {
        commit(resumeThread(get().messages, threadId))
      },
      remove(id) {
        commit(removeMessage(get().messages, id))
      },
      discardThread(threadId) {
        const messages = discardThreadMessages(get().messages, threadId)
        if (messages) commitOrKeep(messages)
      },
    }
  })
}

export const useMessageQueueStore = createMessageQueueStore()
