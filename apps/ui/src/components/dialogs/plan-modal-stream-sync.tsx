import { useEffect } from "react"
import { getThreadStream, useChatStore } from "@/lib/chat-store"
import type { SetPlanModalContent } from "@/lib/plan-modal"

/**
 * Keeps an open plan modal in step with the plan that is still being
 * written. It subscribes to the streamed plan text itself, so that per-delta
 * subscription lives in this leaf instead of the app shell.
 */
export function PlanModalStreamSync({
  threadId,
  planModalContent,
  setPlanModalContent,
}: {
  threadId: string | null
  planModalContent: string | null
  setPlanModalContent: SetPlanModalContent
}) {
  const isPlanStreaming = useChatStore((state) =>
    Boolean(getThreadStream(state, threadId).isPlanStreaming)
  )
  // Read only while a modal is open, so a closed modal does not re-render on
  // every plan delta.
  const streamingPlanText = useChatStore((state) =>
    planModalContent === null
      ? ""
      : getThreadStream(state, threadId).streamingPlanText
  )

  useEffect(() => {
    if (planModalContent === null || !isPlanStreaming || !streamingPlanText) {
      return
    }
    if (
      streamingPlanText !== planModalContent &&
      (planModalContent === "" ||
        streamingPlanText.startsWith(planModalContent))
    ) {
      setPlanModalContent(streamingPlanText)
    }
  }, [
    isPlanStreaming,
    planModalContent,
    setPlanModalContent,
    streamingPlanText,
  ])

  return null
}
