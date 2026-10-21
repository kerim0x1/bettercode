import { BROWSER_ELEMENT_ATTACHMENT_TYPE, isRecord } from "@betterc0de/schema"

/**
 * Light transcript reads (`GET /threads/:id/messages?light=1`).
 *
 * A transcript page is parsed synchronously on both event loops, and its
 * heavy parts are rarely shown: the before/after text of every file a turn
 * changed, and inline `data:` attachments of up to 1 MiB each. A light read
 * drops both and flags the gap, so the renderer can fetch the full message
 * (`GET /threads/:id/messages/:messageId`) when a diff or an attachment is
 * actually opened. Everything else, including the diff counts the file
 * change cards show, is unchanged. Browser element references stay: they
 * are small metadata the message text itself is rendered with.
 */

const DATA_URL_PREFIX = "data:"
const FALLBACK_MEDIA_TYPE = "application/octet-stream"
/** Same bound as an attachment's `mediaType` on the wire. */
const MAX_MEDIA_TYPE_CHARS = 256
/**
 * Inline payloads up to this size stay: the placeholder and the extra round
 * trip would cost more than they save.
 */
export const LIGHT_INLINE_DATA_MAX_CHARS = 2 * 1024

/** The `data:` URL a light read sends instead of the inline payload. */
export function omittedDataUrl(
  url: string,
  mediaType: string | null | undefined
): string {
  const declared = usableMediaType(mediaType) ?? dataUrlMediaType(url)
  return `${DATA_URL_PREFIX}${declared ?? FALLBACK_MEDIA_TYPE};base64,`
}

function usableMediaType(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed &&
    trimmed.length <= MAX_MEDIA_TYPE_CHARS &&
    !/[,;\s]/.test(trimmed)
    ? trimmed
    : null
}

/** The media type a `data:` URL declares, or `null` when it declares none. */
function dataUrlMediaType(url: string): string | null {
  const comma = url.indexOf(",")
  const header = url.slice(
    DATA_URL_PREFIX.length,
    comma < 0 ? DATA_URL_PREFIX.length + MAX_MEDIA_TYPE_CHARS + 1 : comma
  )
  return usableMediaType(header.split(";", 1)[0])
}

function isInlineDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.slice(0, DATA_URL_PREFIX.length).toLowerCase() === DATA_URL_PREFIX
  )
}

function lightDiffs(diffs: unknown[]): unknown[] | null {
  let changed = false
  const next = diffs.map((diff) => {
    if (!isRecord(diff)) return diff
    const hasText =
      (typeof diff.oldText === "string" && diff.oldText !== "") ||
      (typeof diff.newText === "string" && diff.newText !== "")
    if (!hasText) return diff
    changed = true
    return { ...diff, oldText: "", newText: "", textOmitted: true }
  })
  return changed ? next : null
}

function lightAttachments(attachments: unknown[]): unknown[] | null {
  let changed = false
  const next = attachments.map((attachment) => {
    if (
      !isRecord(attachment) ||
      attachment.type === BROWSER_ELEMENT_ATTACHMENT_TYPE ||
      !isInlineDataUrl(attachment.url) ||
      attachment.url.length <= LIGHT_INLINE_DATA_MAX_CHARS
    ) {
      return attachment
    }
    changed = true
    const mediaType =
      typeof attachment.mediaType === "string" ? attachment.mediaType : null
    return {
      ...attachment,
      url: omittedDataUrl(attachment.url, mediaType),
      dataOmitted: true,
    }
  })
  return changed ? next : null
}

/**
 * The light form of one hydrated message row. Returns the same object when
 * there is nothing to omit, so a light page of plain text messages costs no
 * extra copies.
 */
export function toLightMessage(
  message: Record<string, unknown>
): Record<string, unknown> {
  const diffs = Array.isArray(message.diffs) ? lightDiffs(message.diffs) : null
  const attachments = Array.isArray(message.attachments)
    ? lightAttachments(message.attachments)
    : null
  if (!diffs && !attachments) return message
  return {
    ...message,
    ...(diffs ? { diffs } : {}),
    ...(attachments ? { attachments } : {}),
  }
}

function omittedDiff(diff: unknown): boolean {
  return isRecord(diff) && diff.textOmitted === true
}

function omittedAttachment(attachment: unknown): boolean {
  return isRecord(attachment) && attachment.dataOmitted === true
}

/** Whether a message's extras still carry light-read placeholders. */
export function hasOmittedPayloads(extra: Record<string, unknown>): boolean {
  return (
    (Array.isArray(extra.diffs) && extra.diffs.some(omittedDiff)) ||
    (Array.isArray(extra.attachments) &&
      extra.attachments.some(omittedAttachment))
  )
}

/** The stored entry at `index` when it matches, else the first that does. */
function matchingEntry(
  stored: unknown[],
  index: number,
  matches: (entry: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  const atIndex = stored[index]
  if (isRecord(atIndex) && matches(atIndex)) return atIndex
  for (const entry of stored) {
    if (isRecord(entry) && matches(entry)) return entry
  }
  return null
}

/**
 * A message read light and written back must not replace stored diff text
 * or attachment data with its placeholders: each placeholder takes the
 * stored payload of the same file again. A placeholder with nothing stored
 * to restore keeps its flag, so readers still see that the payload is gone.
 * Returns the same object when there is nothing to restore.
 */
export function restoreOmittedPayloads(
  extra: Record<string, unknown>,
  stored: Record<string, unknown>
): Record<string, unknown> {
  if (!hasOmittedPayloads(extra)) return extra
  const storedDiffs = Array.isArray(stored.diffs) ? stored.diffs : []
  const storedAttachments = Array.isArray(stored.attachments)
    ? stored.attachments
    : []
  const diffs = Array.isArray(extra.diffs)
    ? extra.diffs.map((diff, index) => {
        if (!omittedDiff(diff) || !isRecord(diff)) return diff
        const match = matchingEntry(
          storedDiffs,
          index,
          (entry) =>
            entry.path === diff.path &&
            entry.textOmitted !== true &&
            typeof entry.oldText === "string" &&
            typeof entry.newText === "string"
        )
        if (!match) return diff
        const { textOmitted: _omitted, ...rest } = diff
        return { ...rest, oldText: match.oldText, newText: match.newText }
      })
    : extra.diffs
  const attachments = Array.isArray(extra.attachments)
    ? extra.attachments.map((attachment, index) => {
        if (!omittedAttachment(attachment) || !isRecord(attachment)) {
          return attachment
        }
        const match = matchingEntry(
          storedAttachments,
          index,
          (entry) =>
            entry.dataOmitted !== true &&
            (entry.filename ?? null) === (attachment.filename ?? null) &&
            isInlineDataUrl(entry.url)
        )
        if (!match) return attachment
        const { dataOmitted: _omitted, ...rest } = attachment
        return { ...rest, url: match.url }
      })
    : extra.attachments
  return { ...extra, diffs, attachments }
}
