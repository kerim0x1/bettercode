import type { Hono } from "hono"
import type { AppState } from "../../appState"
import {
  readThreadRewindPlan,
  rewindThreadToMessage,
} from "../../services/thread-rewind"
import { contractResult, handleHttpContract } from "../contracts"
import { HttpError } from "../errors"

/** Message ids are client-chosen; anything longer is not one of ours. */
const MAX_MESSAGE_ID_CHARS = 512

function messageIdParam(raw: string | undefined): string {
  const messageId = raw?.trim() ?? ""
  if (!messageId || messageId.length > MAX_MESSAGE_ID_CHARS) {
    throw new HttpError(400, "A valid message id is required.")
  }
  return messageId
}

/**
 * Edit and resend (`services/thread-rewind.ts`). Registered after the thread
 * routes, so the checkpoint recovery fence on `/threads/:id/*` refuses a
 * rewind while a restore is still being recovered. A paired device with full
 * access may rewind like it may restore a checkpoint; read-only sessions are
 * refused by method.
 */
export function registerThreadRewindRoutes(api: Hono, state: AppState): void {
  api.get("/threads/:id/messages/:messageId/rewind", async (c) => {
    const plan = await readThreadRewindPlan(
      state,
      c.req.param("id"),
      messageIdParam(c.req.param("messageId"))
    )
    return contractResult(c, "threadRewindPlan", plan)
  })

  api.post("/threads/:id/messages/:messageId/rewind", (c) =>
    handleHttpContract(
      c,
      "rewindThread",
      async (body, ctx) =>
        rewindThreadToMessage(state, {
          threadId: ctx.req.param("id")!,
          messageId: messageIdParam(ctx.req.param("messageId")),
          revertFiles: body.revertFiles,
          updatedAt: body.updatedAt ?? new Date().toISOString(),
        }),
      { operation: "thread rewind" }
    )
  )
}
