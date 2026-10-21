import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { requestIdentity } from "../../remote/http"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import {
  pauseThreadAutonomy,
  resumeThreadAutonomy,
  setThreadAutonomyTask,
  startThreadAutonomy,
  stopThreadAutonomy,
} from "../../services/chat/autonomy-runtime"
import {
  capRemoteChatPermissions,
  type RemotePermissionAccess,
} from "../../services/chat/requests"
import { withThreadPermissionLevel } from "../../services/chat/thread-settings"
import { handleHttpContract } from "../contracts"

/** The caller checks `routes/chat.ts` applies to every chat turn. */
export interface ChatAutonomyCaller {
  permissionAccess(c: Context): RemotePermissionAccess
  reserveRemoteTurn(c: Context): RemoteProviderTurnReservation | null
}

/**
 * Autonomous Work (`services/chat/autonomy-runtime.ts`). A start or resume
 * starts provider turns, so its body is the chat send body and passes the
 * checks `/chat/send` and `/chat/goal` apply: the chat's own permission
 * level where the request names none, a paired device's cap, its turn
 * ownership, and orchestration only from the desktop. Every later turn of
 * the run keeps that caller, as a goal's turns do. Pause, stop and a task
 * change start nothing.
 */
export function registerChatAutonomyRoutes(
  api: Hono,
  state: AppState,
  caller: ChatAutonomyCaller
): void {
  const assertOrchestrationAllowed = (
    c: Context,
    body: { readonly orchestration?: { readonly enabled?: boolean } }
  ) => {
    if (
      body.orchestration?.enabled &&
      requestIdentity(c, state.config, state)?.kind !== "local"
    )
      throw new HttpError(
        403,
        "Only the desktop host can configure orchestration."
      )
  }

  api.post("/chat/autonomy/start", (c) =>
    handleHttpContract(
      c,
      "chatAutonomyStart",
      async (body) => {
        assertOrchestrationAllowed(c, body)
        return startThreadAutonomy(
          state,
          capRemoteChatPermissions(
            withThreadPermissionLevel(state, body),
            caller.permissionAccess(c)
          ),
          () => caller.reserveRemoteTurn(c)
        )
      },
      { operation: "chat autonomy start" }
    )
  )

  api.post("/chat/autonomy/resume", (c) =>
    handleHttpContract(
      c,
      "chatAutonomyResume",
      async (body) => {
        assertOrchestrationAllowed(c, body)
        return resumeThreadAutonomy(
          state,
          capRemoteChatPermissions(
            withThreadPermissionLevel(state, body),
            caller.permissionAccess(c)
          ),
          () => caller.reserveRemoteTurn(c)
        )
      },
      { operation: "chat autonomy resume" }
    )
  )

  api.post("/chat/autonomy/pause", (c) =>
    handleHttpContract(
      c,
      "chatAutonomyPause",
      async (body) => pauseThreadAutonomy(state, body.threadId),
      { operation: "chat autonomy pause" }
    )
  )

  api.post("/chat/autonomy/stop", (c) =>
    handleHttpContract(
      c,
      "chatAutonomyStop",
      async (body) => stopThreadAutonomy(state, body.threadId),
      { operation: "chat autonomy stop" }
    )
  )

  api.post("/chat/autonomy/task", (c) =>
    handleHttpContract(
      c,
      "chatAutonomyTask",
      async (body) =>
        setThreadAutonomyTask(state, body.threadId, body.taskId, body.done),
      { operation: "chat autonomy task" }
    )
  )
}
