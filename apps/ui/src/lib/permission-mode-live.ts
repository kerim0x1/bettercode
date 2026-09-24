/**
 * Switching the permission mode of a thread that may be mid-turn. Shared by
 * both composer footers and the `/autoaccept` slash command.
 */

import { toast } from "sonner"
import {
  PERMISSION_MODE_FAILED,
  PERMISSION_MODE_QUEUED,
} from "@betterc0de/schema/chat-controls"
import { useChatStore } from "@/lib/chat-store"
import type { PermissionLevel } from "@/lib/preferences-store"
import { setChatPermissionMode } from "@/services/backend"

/**
 * Shared by both composer footers and /autoaccept. The backend settles pending
 * approvals; the UI must keep them visible until that settlement arrives.
 */
export function applyPermissionModeLive(
  id: PermissionLevel,
  provider?: { providerKind?: string; providerInstanceId?: string },
  threadId?: string | null
): Promise<void> {
  if (!threadId) return Promise.resolve()
  return setChatPermissionMode(
    threadId,
    provider?.providerKind ?? "claude",
    id,
    provider?.providerInstanceId ?? null
  )
    .then((result) => {
      if (result?.status === "failed") throw new Error(result.error)
      if (
        result?.applied !== "live" &&
        useChatStore.getState().streamingByThread[threadId]?.isStreaming
      ) {
        toast.info(PERMISSION_MODE_QUEUED.title, {
          description: PERMISSION_MODE_QUEUED.description,
        })
      }
    })
    .catch(() => {
      toast.error(PERMISSION_MODE_FAILED.title, {
        description: PERMISSION_MODE_FAILED.description,
      })
    })
}
