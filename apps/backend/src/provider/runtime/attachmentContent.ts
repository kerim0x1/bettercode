import type { ProviderAttachment } from "../types"
import {
  attachmentMediaType,
  buildUnsupportedAttachmentNotice,
  parseBase64DataUrl,
} from "../attachments"

/** Image types every provider path here accepts (Anthropic and ACP agents). */
export type InlineImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"

/** One image attachment decoded from its base64 data URL. */
export interface InlineImageAttachment {
  readonly mediaType: InlineImageMediaType
  readonly base64: string
  readonly filename: string | null
}

export interface AttachmentContentSplit {
  /** Images the provider accepts as structured content. */
  readonly images: InlineImageAttachment[]
  /** Everything else; never dropped silently (see `attachmentNotice`). */
  readonly unsupported: ProviderAttachment[]
}

export const INLINE_IMAGE_MEDIA_TYPES: ReadonlySet<InlineImageMediaType> =
  new Set<InlineImageMediaType>([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ])

function isInlineImageMediaType(
  value: string | null
): value is InlineImageMediaType {
  return (
    value !== null &&
    (INLINE_IMAGE_MEDIA_TYPES as ReadonlySet<string>).has(value)
  )
}

/**
 * Splits user attachments into images a provider can receive as structured
 * content and the rest. Callers pass `acceptsImages: false` when the agent did
 * not advertise image input, so every attachment lands in `unsupported` and
 * the user sees the notice instead of the file disappearing.
 */
export function splitAttachmentsForImageInput(
  attachments: ReadonlyArray<ProviderAttachment> | undefined,
  options: { readonly acceptsImages: boolean }
): AttachmentContentSplit {
  const images: InlineImageAttachment[] = []
  const unsupported: ProviderAttachment[] = []
  for (const attachment of attachments ?? []) {
    const parsed = options.acceptsImages
      ? parseBase64DataUrl(attachment.url)
      : null
    const mediaType = normalizeImageMediaType(
      parsed?.mediaType ?? attachmentMediaType(attachment)
    )
    if (parsed && isInlineImageMediaType(mediaType)) {
      images.push({
        mediaType,
        base64: parsed.base64,
        filename: attachment.filename?.trim() || null,
      })
    } else {
      unsupported.push(attachment)
    }
  }
  return { images, unsupported }
}

/** The text notice for attachments that could not be delivered, or "". */
export function attachmentNotice(
  unsupported: ReadonlyArray<ProviderAttachment>
): string {
  return buildUnsupportedAttachmentNotice([...unsupported]) ?? ""
}

function normalizeImageMediaType(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return normalized === "image/jpg" ? "image/jpeg" : normalized
}
