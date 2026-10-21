import { z } from "zod"

/** Upper bound shared by message text and inline attachment payloads. */
export const CHAT_MESSAGE_MAX_CHARS = 1024 * 1024

/** Most attachments one message may carry. */
export const CHAT_ATTACHMENTS_MAX_COUNT = 32

/**
 * The text a message is sent with when it has attachments but no text, on
 * the desktop and the phone alike.
 */
export const ATTACHMENTS_ONLY_MESSAGE = "Please review the attached file(s)."

/**
 * An attachment on a chat message. Lives in its own module because both the
 * chat contracts and the provider runtime events carry attachments; keeping
 * it here breaks the import cycle between the two.
 */
export const chatAttachmentSchema = z
  .object({
    type: z.string().min(1).max(64).default("file"),
    filename: z.string().max(1_024).nullish(),
    mediaType: z.string().max(256).nullish(),
    url: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  })
  .strict()
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>

/**
 * An attachment as a transcript read returns it. A light read
 * (`GET /threads/:id/messages?light=1`) replaces an inline `data:` URL with
 * an empty `data:` URL of the same media type and sets `dataOmitted`; the
 * full message (`GET /threads/:id/messages/:messageId`) carries the data.
 * Never send an attachment with `dataOmitted` back to the backend.
 */
export const chatMessageAttachmentSchema = chatAttachmentSchema.extend({
  dataOmitted: z.literal(true).optional(),
})
export type ChatMessageAttachment = z.infer<typeof chatMessageAttachmentSchema>

/** A message's attachments, as `/chat/send` accepts them. */
export const chatAttachmentsSchema = z
  .array(chatAttachmentSchema)
  .max(CHAT_ATTACHMENTS_MAX_COUNT)
