import { useCallback } from "react"
import { useChatStore } from "@/lib/chat-store"
import { interruptTurn } from "@/services/backend"
import type { UiProvider } from "@/lib/provider-types"

/**
 * `handleStop` for the chat composer's "stop/interrupt" button.
 *
 * Cancels the in-flight turn on the backend (so token generation /
 * tool-use actually halts) and immediately finalizes the local stream
 * so the UI stops showing the streaming shimmer. The raw provider
 * kind (fallback chain: `providerKind` → `id` → `"openai"`) is what the
 * backend uses to route the interrupt call to the right adapter.
 */
export function useChatStop(
  selectedProvider: UiProvider | undefined,
  threadId?: string | null
) {
  return useCallback(() => {
    const store = useChatStore.getState()
    const targetThreadId =
      threadId === undefined ? store.activeThreadId : threadId
    if (!targetThreadId) return
    const rawProviderKind =
      selectedProvider?.providerKind ?? selectedProvider?.id ?? "openai"
    interruptTurn(
      targetThreadId,
      rawProviderKind,
      selectedProvider?.providerInstanceId ?? null
    ).catch(() => {
      console.warn("Failed to interrupt AI turn")
    })
    store.finalizeStream(targetThreadId)
  }, [selectedProvider, threadId])
}
