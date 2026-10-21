import type {
  ChatMessage,
  ChatMessageAttachment,
  MessageDiff,
} from "@betterc0de/schema"

/**
 * Light transcript pages (`loadMessages(..., { light: true })`) leave out
 * diff text (`textOmitted`) and large inline attachment data
 * (`dataOmitted`). These helpers decide when a message still needs its full
 * copy (`loadMessage`) and fold that copy in without touching anything else
 * the store holds for the message.
 */

export function diffTextOmitted(diff: Pick<MessageDiff, "textOmitted">) {
  return diff.textOmitted === true
}

export function attachmentDataOmitted(
  attachment: Pick<ChatMessageAttachment, "dataOmitted">
) {
  return attachment.dataOmitted === true
}

export function messageHasOmittedDiffText(
  message: Pick<ChatMessage, "diffs">
): boolean {
  return message.diffs?.some(diffTextOmitted) === true
}

export function messageHasOmittedAttachmentData(
  message: Pick<ChatMessage, "attachments">
): boolean {
  return message.attachments?.some(attachmentDataOmitted) === true
}

/** Whether any payload of the message is still a light-read placeholder. */
export function messageHasOmittedPayload(
  message: Pick<ChatMessage, "diffs" | "attachments">
): boolean {
  return (
    messageHasOmittedDiffText(message) ||
    messageHasOmittedAttachmentData(message)
  )
}

/** The entry of `source` at `index` when it matches, else the first match. */
function matchingEntry<T>(
  source: readonly T[] | undefined,
  index: number,
  matches: (entry: T) => boolean
): T | undefined {
  if (!source) return undefined
  const atIndex = source[index]
  if (atIndex !== undefined && matches(atIndex)) return atIndex
  return source.find(matches)
}

function fullDiffFor(
  diff: MessageDiff,
  index: number,
  full: readonly MessageDiff[] | undefined
): MessageDiff {
  if (!diffTextOmitted(diff)) return diff
  const match = matchingEntry(
    full,
    index,
    (entry) => entry.path === diff.path && !diffTextOmitted(entry)
  )
  if (!match) return diff
  const { textOmitted: _omitted, ...rest } = diff
  return { ...rest, oldText: match.oldText, newText: match.newText }
}

function fullAttachmentFor(
  attachment: ChatMessageAttachment,
  index: number,
  full: readonly ChatMessageAttachment[] | undefined
): ChatMessageAttachment {
  if (!attachmentDataOmitted(attachment)) return attachment
  const match = matchingEntry(
    full,
    index,
    (entry) =>
      !attachmentDataOmitted(entry) &&
      (entry.filename ?? null) === (attachment.filename ?? null) &&
      entry.type === attachment.type
  )
  if (!match) return attachment
  const { dataOmitted: _omitted, ...rest } = attachment
  return { ...rest, url: match.url }
}

/**
 * `target` with each placeholder replaced by the payload of the same file in
 * `full`. Every other field of `target` is kept, so a message that changed
 * while the full copy was in flight (a streamed update, an answered
 * question) is not rolled back. Returns `target` itself when nothing was
 * filled in.
 */
export function withFullMessagePayloads(
  target: ChatMessage,
  full: Pick<ChatMessage, "diffs" | "attachments">
): ChatMessage {
  let changed = false
  const diffs = target.diffs?.map((diff, index) => {
    const next = fullDiffFor(diff, index, full.diffs)
    if (next !== diff) changed = true
    return next
  })
  const attachments = target.attachments?.map((attachment, index) => {
    const next = fullAttachmentFor(attachment, index, full.attachments)
    if (next !== attachment) changed = true
    return next
  })
  if (!changed) return target
  return {
    ...target,
    ...(diffs ? { diffs } : {}),
    ...(attachments ? { attachments } : {}),
  }
}

/**
 * A light page read again (a refresh, a replay gap) must not throw away
 * payloads this renderer already fetched in full: rows of the page that are
 * still placeholders take them from the loaded copy of the same message.
 */
export function keepLoadedMessagePayloads(
  page: readonly ChatMessage[],
  loaded: readonly ChatMessage[]
): ChatMessage[] {
  if (!page.some(messageHasOmittedPayload)) return [...page]
  const loadedById = new Map(loaded.map((message) => [message.id, message]))
  return page.map((message) => {
    if (!messageHasOmittedPayload(message)) return message
    const local = loadedById.get(message.id)
    return local ? withFullMessagePayloads(message, local) : message
  })
}
