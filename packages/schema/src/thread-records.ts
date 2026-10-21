import { z } from "zod"
import type { ThreadActivity } from "./domain"

/**
 * Thread read models shared by several HTTP contracts and the realtime
 * channel. They live apart from `http-contracts.ts` so a contract module and
 * the renderer's WebSocket handling can use them without loading every
 * contract.
 */

const text = z.string()
const count = z.number().nonnegative()

/**
 * One activity of a chat (a tool call, an approval, a model switch): from
 * `GET /threads/:id/activities` and the `thread.activity` channel.
 */
export const threadActivityResponseSchema: z.ZodType<ThreadActivity> = z
  .object({
    id: text,
    threadId: text,
    turnId: text.nullish(),
    providerInstanceId: text.nullish(),
    kind: text,
    tone: z.enum(["thinking", "tool", "info", "approval", "error"]),
    summary: text,
    payload: z.unknown(),
    sequence: count.nullish(),
    createdAt: text,
  })
  .passthrough()

/** A chat's own git worktree, on a new branch from `baseBranch`. */
export const threadWorktreeCreateResponseSchema = z
  .object({
    worktreeId: text,
    threadId: text,
    worktreePath: text,
    branch: text,
    baseBranch: text,
    headSha: text.nullable(),
  })
  .passthrough()
