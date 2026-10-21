import { z } from "zod"
import { endpoint, noBody, type RecordSchema } from "./http-endpoint"

/**
 * Edit and resend (`apps/backend/src/http/routes/thread-rewind.ts`): the
 * conversation goes back to just before one of the user's messages, which
 * is then sent again with new text. `GET` describes what the rewind would
 * remove, `POST` performs it.
 */

const text = z.string()
const bool = z.boolean()
const count = z.number().int().min(0)

/** Most changed files a plan lists; `changedFilesTruncated` says if more exist. */
export const THREAD_REWIND_MAX_LISTED_FILES = 50

/**
 * Why "Revert files too" is not offered:
 * - `unsaved`: the chat is not stored (conversation saving is off), so it has
 *   no checkpoints.
 * - `no_session`: no agent session with a project folder belongs to the chat.
 * - `not_git`: the folder is not a Git repository.
 * - `no_checkpoint`: the checkpoint for that point is missing.
 * - `no_changes`: no agent turn after that point has a checkpoint to undo.
 */
export const threadRewindFileRevertBlockerSchema = z.enum([
  "unsaved",
  "no_session",
  "not_git",
  "no_checkpoint",
  "no_changes",
])
export type ThreadRewindFileRevertBlocker = z.infer<
  typeof threadRewindFileRevertBlockerSchema
>

export interface ThreadRewindPlan {
  messageId: string
  /** The edited message and everything after it. */
  removedMessages: number
  /** Files agent turns changed after that point, as their diffs name them. */
  changedFiles: string[]
  changedFilesTruncated: boolean
  fileRevert: {
    available: boolean
    blocker: ThreadRewindFileRevertBlocker | null
    /** The checkpoint turn files would be restored to. */
    checkpointTurn: number | null
  }
}

const threadRewindPlanSchema: RecordSchema<ThreadRewindPlan> = z
  .object({
    messageId: text,
    removedMessages: count,
    changedFiles: z.array(text),
    changedFilesTruncated: bool,
    fileRevert: z
      .object({
        available: bool,
        blocker: threadRewindFileRevertBlockerSchema.nullable(),
        checkpointTurn: count.nullable(),
      })
      .passthrough(),
  })
  .passthrough()

/** `revertFiles` restores the project folder to the checkpoint as well. */
export const threadRewindRequestSchema = z
  .object({
    revertFiles: bool,
    updatedAt: z.string().max(64).optional(),
  })
  .strict()

/**
 * How the agent's session forgot the removed turns: rolled back in place,
 * or reset so the next turn starts a new session from the stored chat.
 */
export const threadRewindProviderSessionSchema = z.enum([
  "rolled_back",
  "reset",
  "unchanged",
])

export interface ThreadRewindResult {
  rewound: boolean
  revertedFiles: boolean
  deletedMessages: number
  rolledBackTurns: number
  providerSession: z.infer<typeof threadRewindProviderSessionSchema>
  /** Why nothing was changed, when `rewound` is false. */
  reason?: string
}

const threadRewindResultSchema: RecordSchema<ThreadRewindResult> = z
  .object({
    rewound: bool,
    revertedFiles: bool,
    deletedMessages: count,
    rolledBackTurns: count,
    providerSession: threadRewindProviderSessionSchema,
    reason: text.optional(),
  })
  .passthrough()

export const threadRewindHttpContracts = {
  threadRewindPlan: endpoint(
    "GET",
    "/threads/:id/messages/:messageId/rewind",
    noBody,
    threadRewindPlanSchema
  ),
  rewindThread: endpoint(
    "POST",
    "/threads/:id/messages/:messageId/rewind",
    threadRewindRequestSchema,
    threadRewindResultSchema
  ),
} as const
