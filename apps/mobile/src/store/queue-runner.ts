import { startMessageQueueRunner } from "@betterc0de/schema/message-queue"
import { needsUpdate } from "@/lib/compat"
import type { RemoteApi } from "@/transport/types"
import { useAppStore } from "./app-store"
import { useQueueStore, type QueuedPayload } from "./queue-store"
import { selectAccessLevel, useSessionStore } from "./session-store"

/**
 * Whether a chat can take its next queued message: the desktop is reachable
 * and lets this phone send, the chat's messages are loaded (the message goes
 * with them as its history), and no turn runs in it.
 */
export function chatReadyForQueue(threadId: string): boolean {
  const session = useSessionStore.getState()
  if (session.state !== "online" || needsUpdate(session.compatibility))
    return false
  if (selectAccessLevel(session) === "read_only") return false
  const app = useAppStore.getState()
  const thread = app.threads.find((item) => item.id === threadId)
  return Boolean(
    thread &&
    app.messagesByThread[threadId] &&
    !app.streamsByThread[threadId]?.running &&
    !thread.session?.activeTurnId
  )
}

/**
 * Sends queued messages as their chats become ready, with the desktop's
 * rules (@betterc0de/schema/message-queue): one at a time per chat, a busy
 * chat is tried again, and a failed message pauses its chat's queue.
 * Returns the function that stops it.
 */
export function startQueueRunner(api: RemoteApi): () => void {
  const stopRunner = startMessageQueueRunner<QueuedPayload>({
    queue: useQueueStore,
    isReady: chatReadyForQueue,
    send: async (message) => {
      const outcome = await useAppStore.getState().send(
        api,
        message.threadId,
        message.payload.text,
        message.payload.selection,
        {
          messageId: message.id,
          createdAt: message.createdAt,
          owner: "queue",
          turnOptions: {
            thinkingMode: message.payload.thinkingMode,
            fastMode: message.payload.fastMode,
          },
        },
        message.payload.attachments
      )
      if (outcome.status === "busy") return false
      if (outcome.status === "failed") throw new Error(outcome.error)
      return true
    },
    subscribeReady: (wake) => {
      const stopApp = useAppStore.subscribe((state, previous) => {
        if (
          state.threads !== previous.threads ||
          state.streamsByThread !== previous.streamsByThread ||
          state.messagesByThread !== previous.messagesByThread
        )
          wake()
      })
      const stopSession = useSessionStore.subscribe((state, previous) => {
        if (
          state.state !== previous.state ||
          state.protocol !== previous.protocol ||
          state.compatibility !== previous.compatibility
        )
          wake()
      })
      return () => {
        stopApp()
        stopSession()
      }
    },
    // A failed message stays in the queue with its reason and pauses its
    // chat's queue; there is nothing more to tell.
    onError: () => undefined,
  })
  // A queued message's saved request goes when the message leaves the queue.
  const stopPruning = useQueueStore.subscribe((state) =>
    useAppStore
      .getState()
      .pruneQueueOutbox(new Set(state.messages.map((message) => message.id)))
  )
  return () => {
    stopRunner()
    stopPruning()
  }
}
