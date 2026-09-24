import {
  threadMetadataUpdateSchema,
  type ThreadMetadataUpdate,
} from "@betterc0de/schema/thread-metadata"

/**
 * A chat renamed on another client (a paired phone): the backend announces
 * it as a `thread.metadata` frame. This copy must take the title over, or
 * its next metadata write (every persisted message sends the whole copy)
 * would put the old title back.
 *
 * Returns the title to apply, or `null` when the frame is malformed, the
 * chat is not in this window, or the title is already the same.
 */
export function remoteTitleChange(
  threads: ReadonlyArray<{ id: string; title: string }>,
  data: unknown
): Pick<ThreadMetadataUpdate, "threadId" | "title"> | null {
  const parsed = threadMetadataUpdateSchema.safeParse(data)
  if (!parsed.success) return null
  const { threadId, title } = parsed.data
  const thread = threads.find((candidate) => candidate.id === threadId)
  if (!thread || thread.title === title) return null
  return { threadId, title }
}
