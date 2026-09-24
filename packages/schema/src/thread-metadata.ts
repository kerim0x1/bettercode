import { z } from "zod"

/**
 * A chat's new title, as POST /threads/:id/title answers it and as every
 * connected client hears it (the `thread.metadata` WebSocket frame). Kept
 * apart from the HTTP contracts so a client can read the frame without
 * loading all of them (the desktop's entry bundle has a size budget).
 */
export const threadMetadataUpdateSchema = z
  .object({
    threadId: z.string().min(1),
    title: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough()

export type ThreadMetadataUpdate = z.infer<typeof threadMetadataUpdateSchema>
