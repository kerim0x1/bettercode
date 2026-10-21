import { useEffect, useRef } from "react"
import { useChatStore } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { startMessageQueueRunner } from "@/lib/message-queue-runner"
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
        isReady: (threadId) => {
          const state = useChatStore.getState()
          return (
            state.threads.some((thread) => thread.id === threadId) &&
            !state.streamingByThread[threadId]?.isStreaming
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
        subscribeReady: (wake) =>
          useChatStore.subscribe((state, previous) => {
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
          }),
        onError: (error) => handleError(error, { source: "message-queue" }),
      }),
    []
  )
}
