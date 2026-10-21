import type {
  ThreadRewindPlan,
  ThreadRewindResult,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"

export type { ThreadRewindPlan, ThreadRewindResult }

/**
 * What rewinding the chat to just before one of the user's messages would
 * remove, and whether the files can be restored to that point too.
 */
export const loadThreadRewindPlan = (
  threadId: string,
  messageId: string
): Promise<ThreadRewindPlan> =>
  invokeContract("threadRewindPlan", { id: threadId, params: { messageId } })

/**
 * Rewinds the chat to just before `messageId` (edit and resend). The
 * backend refuses with 409 `turn_active` while a turn runs.
 */
export const rewindThreadToMessage = (
  threadId: string,
  messageId: string,
  input: { revertFiles: boolean }
): Promise<ThreadRewindResult> =>
  invokeContract("rewindThread", {
    id: threadId,
    params: { messageId },
    body: {
      revertFiles: input.revertFiles,
      updatedAt: new Date().toISOString(),
    },
  })
