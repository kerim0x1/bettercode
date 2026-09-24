import { create } from "zustand"
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
  type QueuedMessage,
} from "@betterc0de/schema/message-queue"
import { createId } from "@/lib/ids"
import { documents } from "@/lib/local-documents"
import type { ModelOption } from "@/types/remote"

/**
 * What a queued message is sent with. The model is fixed when the message
 * is queued: the chat may not be open when its turn comes, and the phone
 * learns a chat's models only while it is.
 */
export interface QueuedPayload {
  text: string
  selection: ModelOption
  thinkingMode: string | null
  fastMode: boolean
}

export type PhoneQueuedMessage = QueuedMessage<QueuedPayload>

const DOCUMENT = "message-queue.json"

function isQueuedPayload(payload: unknown): payload is QueuedPayload {
  const value = payload as Partial<QueuedPayload> | null
  return Boolean(
    value &&
    typeof value.text === "string" &&
    value.selection &&
    typeof value.selection.modelId === "string" &&
    typeof value.selection.providerKind === "string"
  )
}

interface QueueStore {
  messages: PhoneQueuedMessage[]
  /** Reads the queue saved on this phone, paused, as the desktop does after a restart. */
  hydrate(): void
  enqueue(threadId: string, payload: QueuedPayload): PhoneQueuedMessage
  claim(id: string): PhoneQueuedMessage | null
  finish(id: string): void
  release(id: string): void
  fail(id: string, error: string): void
  pause(threadId: string, reason?: string): void
  resume(threadId: string): void
  remove(id: string): void
  discardThread(threadId: string): void
  /** Ends the queue with the pairing it was meant for. */
  discardAll(): void
}

/** The queue's rules are the desktop's (@betterc0de/schema/message-queue). */
export const useQueueStore = create<QueueStore>((set, get) => {
  // Saved before it takes effect, so a message the phone could not save is
  // not queued (the draft stays in the composer).
  const commit = (messages: PhoneQueuedMessage[]) => {
    documents.write(DOCUMENT, JSON.stringify(messages))
    set({ messages })
  }
  // Pausing and failing must hold in memory even when saving fails.
  const commitOrKeep = (messages: PhoneQueuedMessage[]) => {
    try {
      commit(messages)
    } catch {
      set({ messages })
    }
  }
  return {
    messages: [],
    hydrate() {
      try {
        set({
          messages: restoreQueue(documents.read(DOCUMENT), isQueuedPayload),
        })
      } catch {
        set({ messages: [] })
      }
    },
    enqueue(threadId, payload) {
      const message: PhoneQueuedMessage = {
        id: createId("mobile-message"),
        threadId,
        createdAt: new Date().toISOString(),
        payload: JSON.parse(JSON.stringify(payload)) as QueuedPayload,
        status: "queued",
      }
      commit(enqueueMessage(get().messages, message))
      return message
    },
    claim(id) {
      const { messages, claimed } = claimMessage(get().messages, id)
      if (claimed) commitOrKeep(messages)
      return claimed
    },
    finish: (id) => commitOrKeep(finishMessage(get().messages, id)),
    release(id) {
      if (get().messages.some((message) => message.id === id))
        commitOrKeep(releaseMessage(get().messages, id))
    },
    fail(id, error) {
      if (get().messages.some((message) => message.id === id))
        commitOrKeep(failMessage(get().messages, id, error))
    },
    pause(threadId, reason) {
      const messages = pauseThread(get().messages, threadId, reason)
      if (messages) commitOrKeep(messages)
    },
    resume: (threadId) => commitOrKeep(resumeThread(get().messages, threadId)),
    remove: (id) => commitOrKeep(removeMessage(get().messages, id)),
    discardThread(threadId) {
      const messages = discardThreadMessages(get().messages, threadId)
      if (messages) commitOrKeep(messages)
    },
    discardAll: () => commitOrKeep([]),
  }
})
