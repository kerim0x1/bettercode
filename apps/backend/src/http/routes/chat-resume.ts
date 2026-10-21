import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import {
  capRemoteChatPermissions,
  type RemotePermissionAccess,
} from "../../services/chat/requests"
import { controlChatResume } from "../../services/chat/resume-runtime"
import { handleHttpContract } from "../contracts"

/** The caller checks `routes/chat.ts` applies to every chat turn. */
export interface ChatResumeCaller {
  permissionAccess(c: Context): RemotePermissionAccess
  reserveRemoteTurn(c: Context): RemoteProviderTurnReservation | null
}

/**
 * A chat a usage limit or a restart stopped (services/chat/resume-runtime.ts):
 * resume it when the limit resets, at once, or not at all. "Resume now"
 * starts a turn with the stopped turn's settings, so a paired device's
 * turn gets its usual cap and ownership.
 */
export function registerChatResumeRoutes(
  api: Hono,
  state: AppState,
  caller: ChatResumeCaller
): void {
  api.post("/chat/resume", (c) =>
    handleHttpContract(
      c,
      "chatResume",
      async (body) => {
        const access = caller.permissionAccess(c)
        return controlChatResume(state, body.threadId, body.action, {
          capBody: (send) => capRemoteChatPermissions(send, access),
          reserveRemoteTurn: () => caller.reserveRemoteTurn(c),
        })
      },
      { operation: "chat resume" }
    )
  )
}
