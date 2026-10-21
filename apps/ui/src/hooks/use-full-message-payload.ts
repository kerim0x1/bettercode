import { useCallback, useEffect, useState } from "react"
import { useChatStore } from "@/lib/chat-store"
import { createLogger } from "@/lib/logger"

const log = createLogger("full-message-payload")

/** The persisted message a diff or attachment placeholder belongs to. */
export interface FullMessageSource {
  readonly threadId: string
  readonly messageId: string
}

/**
 * `loading` while the full copy is read; `error` when the read failed (try
 * again with `retry`); `unavailable` when the full copy has no payload to
 * fill in either.
 */
export type FullMessagePayloadStatus =
  | "idle"
  | "loading"
  | "error"
  | "unavailable"

/**
 * Reads the full copy of a message from a light transcript page once its
 * diff text or attachment data is about to be shown (`needed`). The store
 * folds the payloads in, so the caller re-renders with the real content and
 * `needed` turns false; nothing is read while `needed` is false.
 */
export function useFullMessagePayload(
  source: FullMessageSource | null | undefined,
  needed: boolean
): { status: FullMessagePayloadStatus; retry: () => void } {
  const [status, setStatus] = useState<FullMessagePayloadStatus>("idle")
  const [attempt, setAttempt] = useState(0)
  const threadId = source?.threadId
  const messageId = source?.messageId

  useEffect(() => {
    if (!needed || !threadId || !messageId) return
    let cancelled = false
    setStatus("loading")
    useChatStore
      .getState()
      .hydrateFullMessage(threadId, messageId)
      .then(
        () => {
          // Still needed after a successful read: there is nothing to fill.
          if (!cancelled) setStatus("unavailable")
        },
        (err: unknown) => {
          log.warn("Failed to load the full message", threadId, messageId, err)
          if (!cancelled) setStatus("error")
        }
      )
    return () => {
      cancelled = true
    }
  }, [needed, threadId, messageId, attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return {
    status: !needed
      ? "idle"
      : !threadId || !messageId
        ? // No saved message to read it from.
          "unavailable"
        : // The first render, before the effect has started the read.
          status === "idle"
          ? "loading"
          : status,
    retry,
  }
}
