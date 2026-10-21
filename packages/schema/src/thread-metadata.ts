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

/**
 * A chat's settings changed (PATCH /threads/:id `{ settings }`): every
 * connected client hears the settings the backend now keeps with the chat,
 * whole, on the same `thread.metadata` channel. Such a frame carries no
 * title, so a client that only reads renames (`threadMetadataUpdateSchema`,
 * as installed phone apps do) skips it. The settings are checked key by key
 * where they are applied (`threadSettingsSchema` in threads.ts), which keeps
 * this module small.
 */
export const threadSettingsUpdateSchema = z
  .object({
    threadId: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
  })
  .passthrough()

export type ThreadSettingsUpdate = z.infer<typeof threadSettingsUpdateSchema>

/**
 * A `thread.metadata` frame: a new title, new settings, or the chat's
 * resume record (`resume`, `null` once it is gone, with `resumePrompt` when
 * the backend just sent a message; thread-resume.ts). Like settings, the
 * record is checked where it is applied, which keeps this module small.
 */
export const threadMetadataFrameSchema = z
  .object({
    threadId: z.string().min(1),
    title: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    resume: z.unknown().optional(),
    resumePrompt: z.unknown().optional(),
  })
  .passthrough()
  .refine(
    (frame) =>
      frame.title !== undefined ||
      frame.settings !== undefined ||
      frame.resume !== undefined,
    "A thread.metadata frame carries a title, settings or a resume record"
  )

export type ThreadMetadataFrame = z.infer<typeof threadMetadataFrameSchema>
