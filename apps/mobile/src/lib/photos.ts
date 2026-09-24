import {
  CHAT_ATTACHMENTS_MAX_COUNT,
  CHAT_MESSAGE_MAX_CHARS,
  type ChatAttachment,
} from "@betterc0de/schema/chat-attachment"

/**
 * Photos travel inside the message, as the desktop sends its own
 * attachments: one JPEG data URL each. The phone re-encodes every photo from
 * its pixels, which leaves the camera's metadata (location included) behind,
 * and makes it small enough that several fit into one request.
 */

/** The longest edge sent; Claude and GPT models look at no more detail than this. */
export const PHOTO_MAX_EDGE = 1568

/**
 * The largest JPEG sent. Its data URL stays below the desktop's limit for one
 * attachment (`CHAT_MESSAGE_MAX_CHARS`).
 */
export const PHOTO_MAX_BYTES = 700 * 1024

/** Most photos in one message. */
export const MAX_PHOTOS_PER_MESSAGE = Math.min(10, CHAT_ATTACHMENTS_MAX_COUNT)

/** What photos leave free of a request for the text, the chat's details and its history. */
export const REQUEST_RESERVE_BYTES = 256 * 1024

const DATA_URL_PREFIX = "data:image/jpeg;base64,"

/** The JSON around a photo's data URL: its type, file name and media type. */
const ATTACHMENT_OVERHEAD_BYTES = 128

/** Smaller sizes are tried when a photo is too large; each is 3/4 of the one before. */
const EDGE_STEPS = 3
const QUALITIES = [0.8, 0.65, 0.5] as const

/** A photo ready to send. */
export interface PreparedPhoto {
  id: string
  width: number
  height: number
  /** The JPEG, base64-encoded. */
  base64: string
}

/** An opened photo, upright, that can be encoded at any size. */
export interface PhotoCodec {
  width: number
  height: number
  /** The photo as a base64 JPEG at this size and quality (0–1). */
  jpeg(width: number, height: number, quality: number): Promise<string>
}

export interface EncodingStep {
  width: number
  height: number
  quality: number
}

/**
 * The sizes and qualities to try, best first: the long edge at most
 * `PHOTO_MAX_EDGE` (never enlarged), then smaller sizes, each at falling
 * JPEG qualities.
 */
export function encodingSteps(width: number, height: number): EncodingStep[] {
  const longEdge = Math.max(width, height)
  if (!(longEdge > 0)) return []
  const steps: EncodingStep[] = []
  const seen = new Set<string>()
  let edge = Math.min(longEdge, PHOTO_MAX_EDGE)
  for (let index = 0; index < EDGE_STEPS; index += 1) {
    const scale = edge / longEdge
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    }
    const key = `${size.width}x${size.height}`
    if (!seen.has(key)) {
      seen.add(key)
      for (const quality of QUALITIES) steps.push({ ...size, quality })
    }
    edge = Math.round(edge * 0.75)
  }
  return steps
}

/** Bytes of the data that a base64 string encodes. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * Encodes the photo at the best step whose JPEG is at most `maxBytes`, or
 * returns `null` when even the smallest is larger.
 */
export async function encodePhoto(
  codec: PhotoCodec,
  maxBytes: number
): Promise<{ base64: string; width: number; height: number } | null> {
  if (maxBytes <= 0) return null
  for (const step of encodingSteps(codec.width, codec.height)) {
    const base64 = await codec.jpeg(step.width, step.height, step.quality)
    if (base64Bytes(base64) <= maxBytes)
      return { base64, width: step.width, height: step.height }
  }
  return null
}

/** The photo as the message carries it, named by its place in the message. */
export function photoAttachment(
  photo: Pick<PreparedPhoto, "base64">,
  index: number
): ChatAttachment {
  return {
    type: "file",
    filename: photoFilename(index),
    mediaType: "image/jpeg",
    url: `${DATA_URL_PREFIX}${photo.base64}`,
  }
}

/** What a photo adds to a request. */
function photoRequestBytes(photo: Pick<PreparedPhoto, "base64">): number {
  return (
    DATA_URL_PREFIX.length + photo.base64.length + ATTACHMENT_OVERHEAD_BYTES
  )
}

/**
 * The largest JPEG the next photo of a message may be, given the photos it
 * already has: 0 when there is no room for another. Photos share the request
 * with the text and history, which get `REQUEST_RESERVE_BYTES` of it.
 */
export function nextPhotoMaxBytes(
  photos: readonly Pick<PreparedPhoto, "base64">[],
  maxRequestBytes: number
): number {
  if (photos.length >= MAX_PHOTOS_PER_MESSAGE) return 0
  const used = photos.reduce((sum, photo) => sum + photoRequestBytes(photo), 0)
  const free =
    maxRequestBytes -
    REQUEST_RESERVE_BYTES -
    used -
    DATA_URL_PREFIX.length -
    ATTACHMENT_OVERHEAD_BYTES
  // A data URL may be at most CHAT_MESSAGE_MAX_CHARS long.
  const perAttachment = CHAT_MESSAGE_MAX_CHARS - DATA_URL_PREFIX.length
  const base64Chars = Math.min(free, perAttachment)
  if (base64Chars <= 0) return 0
  return Math.min(PHOTO_MAX_BYTES, Math.floor((base64Chars * 3) / 4))
}

/** "photo-1.jpg" for the first photo of a message. */
export function photoFilename(index: number): string {
  return `photo-${index + 1}.jpg`
}
