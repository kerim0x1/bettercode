import { useEffect, useRef } from "react"
import { useChatStore } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { startMessageQueueRunner } from "@/lib/message-queue-runner"
import {
  isQueueHeadBeingEdited,
  useQueuedMessageEditor,
} from "@/lib/queued-message-editor"
import { handleError } from "@/lib/errors/handle"
import type { ChatSubmitPayload } from "./use-chat-submit"

export function useMessageQueue(
  submit: (payload: ChatSubmitPayload) => Promise<unknown>
) {
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  }, [submit])
  useEffect(
    () =>
      startMessageQueueRunner({
        queue: useMessageQueueStore,
        // A chat's next message also waits while it is open in the editor.
        isReady: (threadId) => {
          const state = useChatStore.getState()
          return (
            state.threads.some((thread) => thread.id === threadId) &&
            !state.streamingByThread[threadId]?.isStreaming &&
            !isQueueHeadBeingEdited(threadId)
          )
        },
        send: (entry) =>
          submitRef.current({
            ...entry.payload,
            threadId: entry.threadId,
            queuedSubmission: {
              id: entry.id,
              createdAt: entry.createdAt,
              browserElements: entry.payload.browserElements,
            },
          }),
        subscribeReady: (wake) => {
          const stopChat = useChatStore.subscribe((state, previous) => {
            const threads = new Set(
              useMessageQueueStore
                .getState()
                .messages.map((entry) => entry.threadId)
            )
            if (
              state.threads !== previous.threads ||
              [...threads].some(
                (id) =>
                  state.streamingByThread[id]?.isStreaming !==
                  previous.streamingByThread[id]?.isStreaming
              )
            )
              wake()
          })
          const stopEditor = useQueuedMessageEditor.subscribe(
            (state, previous) => {
              if (state.editingId !== previous.editingId) wake()
            }
          )
          return () => {
            stopChat()
            stopEditor()
          }
        },
        onError: (error) => handleError(error, { source: "message-queue" }),
      }),
    []
  )
}
