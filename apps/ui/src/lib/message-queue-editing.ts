/**
 * Changes to a chat's queued messages that the queue rules
 * (@betterc0de/schema/message-queue) leave open: editing a draft,
 * reordering, adding a message at the front, and claiming one to steer into
 * the running turn. Plain data in and out, like the shared rules; the store
 * persists what these return.
 *
 * A message being sent is fixed: it cannot be edited or moved, and nothing
 * moves in front of it. Functions that may change nothing return `null`
 * then, so the store does not write the same queue again.
 */
import {
  MAX_QUEUED_PER_THREAD,
  QUEUE_TEXT,
  queuedFor,
  type QueuedMessage,
} from "@betterc0de/schema/message-queue"

type Queue<Payload> = readonly QueuedMessage<Payload>[]

/** Whether the message can still be changed (it is not being sent). */
export function isQueuedMessageEditable<Payload>(
  message: QueuedMessage<Payload> | null | undefined
): message is QueuedMessage<Payload> {
  return Boolean(message) && message?.status !== "sending"
}

/** Replaces a queued message's payload. `null` when it is gone or being sent. */
export function updateQueuedMessage<Payload>(
  messages: Queue<Payload>,
  id: string,
  payload: Payload
): QueuedMessage<Payload>[] | null {
  const entry = messages.find((message) => message.id === id)
  if (!isQueuedMessageEditable(entry)) return null
  return messages.map((message) =>
    message.id === id ? { ...message, payload } : message
  )
}

/**
 * Moves a message one place up (`-1`) or down (`1`) in its chat's queue.
 * `null` when it cannot move that way.
 */
export function moveQueuedMessage<Payload>(
  messages: Queue<Payload>,
  id: string,
  step: -1 | 1
): QueuedMessage<Payload>[] | null {
  const entry = messages.find((message) => message.id === id)
  if (!isQueuedMessageEditable(entry)) return null
  const thread = queuedFor(messages, entry.threadId)
  return placeInThread(
    messages,
    entry,
    thread.filter((message) => message.id !== id),
    thread.indexOf(entry) + step
  )
}

/**
 * Moves a message in front of another message of the same chat, or to the
 * end with `beforeId` null (a drop below the last row). `null` when nothing
 * changes.
 */
export function moveQueuedMessageBefore<Payload>(
  messages: Queue<Payload>,
  id: string,
  beforeId: string | null
): QueuedMessage<Payload>[] | null {
  const entry = messages.find((message) => message.id === id)
  if (!isQueuedMessageEditable(entry) || beforeId === id) return null
  const rest = queuedFor(messages, entry.threadId).filter(
    (message) => message.id !== id
  )
  const target =
    beforeId === null
      ? rest.length
      : rest.findIndex((message) => message.id === beforeId)
  if (target < 0) return null
  return placeInThread(messages, entry, rest, target)
}

/** Whether `moveQueuedMessage` would move the message (for menu items). */
export function canMoveQueuedMessage<Payload>(
  messages: Queue<Payload>,
  id: string,
  step: -1 | 1
): boolean {
  return moveQueuedMessage(messages, id, step) !== null
}

/**
 * Adds a message at the front of its chat's queue, behind a message that is
 * being sent. Throws when the chat's queue is full, like `enqueueMessage`.
 */
export function enqueueMessageFirst<Payload>(
  messages: Queue<Payload>,
  message: QueuedMessage<Payload>
): QueuedMessage<Payload>[] {
  const thread = queuedFor(messages, message.threadId)
  if (thread.length >= MAX_QUEUED_PER_THREAD) throw new Error(QUEUE_TEXT.full)
  const anchor = thread[sendingPrefix(thread)]
  if (!anchor) return [...messages, message]
  const at = messages.indexOf(anchor)
  return [...messages.slice(0, at), message, ...messages.slice(at)]
}

/**
 * Takes a message to steer into the running turn: it moves to the front of
 * its chat's queue and is marked as being sent, so the queue does not also
 * send it. A paused or failed message can be steered too; that is the
 * user's explicit choice. `claimed` is null when the message is gone, or
 * when it or another message of its chat is already being sent.
 */
export function claimMessageForSteer<Payload>(
  messages: Queue<Payload>,
  id: string
): {
  messages: QueuedMessage<Payload>[]
  claimed: QueuedMessage<Payload> | null
} {
  const entry = messages.find((message) => message.id === id)
  if (
    !entry ||
    messages.some(
      (message) =>
        message.threadId === entry.threadId && message.status === "sending"
    )
  ) {
    return { messages: [...messages], claimed: null }
  }
  const claimed: QueuedMessage<Payload> = {
    ...entry,
    status: "sending",
    error: undefined,
    pauseRequested: false,
  }
  const rest = queuedFor(messages, entry.threadId).filter(
    (message) => message.id !== id
  )
  return {
    messages: withThreadOrder(messages, entry.threadId, [claimed, ...rest]),
    claimed,
  }
}

/** The message Alt+Up in an empty composer opens: the chat's last editable one. */
export function lastEditableQueuedMessage<Payload>(
  messages: Queue<Payload>,
  threadId: string
): QueuedMessage<Payload> | null {
  const thread = queuedFor(messages, threadId)
  for (let index = thread.length - 1; index >= 0; index -= 1) {
    if (isQueuedMessageEditable(thread[index])) return thread[index]
  }
  return null
}

/** How many messages at the front of a chat's queue are being sent. */
function sendingPrefix<Payload>(thread: Queue<Payload>): number {
  let count = 0
  while (count < thread.length && thread[count].status === "sending") count++
  return count
}

/**
 * Puts `entry` at `target` among the chat's other messages (`rest`), kept
 * behind any message being sent and within the queue. `null` when that is
 * where it already is.
 */
function placeInThread<Payload>(
  messages: Queue<Payload>,
  entry: QueuedMessage<Payload>,
  rest: readonly QueuedMessage<Payload>[],
  target: number
): QueuedMessage<Payload>[] | null {
  const position = Math.max(sendingPrefix(rest), Math.min(target, rest.length))
  const thread = queuedFor(messages, entry.threadId)
  if (thread[position] === entry) return null
  const order = [...rest]
  order.splice(position, 0, entry)
  return withThreadOrder(messages, entry.threadId, order)
}

/**
 * The queue with one chat's messages in `order`, in the places that chat's
 * messages held, so other chats' messages keep theirs. `order` holds the
 * same number of messages as the chat had.
 */
function withThreadOrder<Payload>(
  messages: Queue<Payload>,
  threadId: string,
  order: readonly QueuedMessage<Payload>[]
): QueuedMessage<Payload>[] {
  let next = 0
  return messages.map((message) =>
    message.threadId === threadId ? order[next++] : message
  )
}
