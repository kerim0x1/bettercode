import { useChatStore } from "@/lib/chat-store"
import { saveThreadModelSwitchActivity } from "@/services/backend/chatApi"

/**
 * Record the "Model switched from X to Y" divider on one thread.
 *
 * Extracted because two call sites need it and they must not drift: the global
 * preferences hook (which follows whichever thread is active) and the per-pane
 * composer (which must target its own column's thread, not the active one).
 *
 * Writes the projection optimistically and persists in the background —
 * a failed write costs a divider row, never the model change itself.
 */
export function recordModelSwitch(input: {
  threadId: string | null | undefined
  fromModelId: string | null | undefined
  toModelId: string
}): void {
  const { threadId, fromModelId, toModelId } = input
  if (!threadId || !fromModelId || !toModelId) return
  if (fromModelId === toModelId) return

  const activityId =
    globalThis.crypto?.randomUUID?.() ??
    `model-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const createdAt = new Date().toISOString()

  useChatStore.getState().upsertThreadActivity(threadId, {
    id: activityId,
    threadId,
    turnId: null,
    providerInstanceId: null,
    kind: "session.model.switched",
    tone: "info" as const,
    summary: `Model switched from ${fromModelId} to ${toModelId}.`,
    payload: { fromModelId, toModelId },
    sequence: null,
    createdAt,
  })

  void saveThreadModelSwitchActivity(threadId, {
    activityId,
    fromModelId,
    toModelId,
    createdAt,
  }).catch(() => {
    console.warn("Failed to persist model switch activity")
  })
}
