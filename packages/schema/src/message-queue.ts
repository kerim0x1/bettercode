/**
 * Messages written while a chat is busy wait in a queue and are sent in
 * order once it is free. The desktop and the phone app keep their own
 * queues (each in its local storage) with these same rules, so a queue
 * behaves alike on both:
 *
 * - at most 30 messages per chat;
 * - one message per chat is sent at a time, oldest first;
 * - a message is sent with its queue id as `userMessageId`, so resending it
 *   after an interruption is recognised as the same message;
 * - a queue restored after a restart is paused, and resumes only when the
 *   user says so;
 * - a failed message pauses the rest of its chat's queue.
 *
 * Everything here is plain data in and out; each app wraps it in its own
 * store and storage.
 */

export const MAX_QUEUED_PER_THREAD = 30

export const QUEUE_TEXT = {
  full: `This chat already has ${MAX_QUEUED_PER_THREAD} queued messages.`,
  paused: "Queue paused.",
  interrupted: "Delivery was interrupted. Check the chat before resuming.",
  restored: "Restored after restart. Resume when ready.",
  busy: "The chat is still busy. Resume the queue when it is ready.",
  unconfirmed:
    "Delivery could not be confirmed. Check the chat before resuming.",
} as const

export type QueuedMessageStatus = "queued" | "sending" | "paused" | "failed"

export interface QueuedMessage<Payload> {
  id: string
  threadId: string
  createdAt: string
  payload: Payload
  status: QueuedMessageStatus
  pauseRequested?: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// State changes: each returns the new list and leaves the old one untouched.
// ---------------------------------------------------------------------------

export function queuedFor<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  threadId: string
) {
  return messages.filter((message) => message.threadId === threadId)
}

/** Adds a message at the end of its chat's queue; throws when the chat's queue is full. */
export function enqueueMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  message: QueuedMessage<Payload>
): QueuedMessage<Payload>[] {
  if (queuedFor(messages, message.threadId).length >= MAX_QUEUED_PER_THREAD)
    throw new Error(QUEUE_TEXT.full)
  return [...messages, message]
}

/** Marks the message as being sent, if it is queued and first in its chat. */
export function claimMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string
): {
  messages: QueuedMessage<Payload>[]
  claimed: QueuedMessage<Payload> | null
} {
  const message = messages.find((entry) => entry.id === id)
  if (
    !message ||
    message.status !== "queued" ||
    messages.find((entry) => entry.threadId === message.threadId)?.id !== id
  ) {
    return { messages: [...messages], claimed: null }
  }
  return {
    messages: patch(messages, id, {
      status: "sending",
      error: undefined,
      pauseRequested: false,
    }),
    claimed: message,
  }
}

/** The message was delivered: it leaves the queue. */
export function finishMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string
) {
  return messages.filter((message) => message.id !== id)
}

/** The message was not sent this time: back to queued, or paused if a pause was asked for meanwhile. */
export function releaseMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string
) {
  const entry = messages.find((message) => message.id === id)
  if (!entry) return [...messages]
  return patch(
    messages,
    id,
    entry.pauseRequested
      ? { status: "paused", error: QUEUE_TEXT.paused }
      : { status: "queued" }
  )
}

/** The message failed; the rest of its chat's queue waits for the user. */
export function failMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string,
  error: string
) {
  const entry = messages.find((message) => message.id === id)
  if (!entry) return [...messages]
  return messages.map((message) =>
    message.threadId !== entry.threadId
      ? message
      : {
          ...message,
          status: message.id === id ? ("failed" as const) : ("paused" as const),
          error: message.id === id ? error : undefined,
        }
  )
}

/** Pauses a chat's queue. A message being sent finishes first and then pauses. `null` when nothing changes. */
export function pauseThread<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  threadId: string,
  reason: string = QUEUE_TEXT.paused
): QueuedMessage<Payload>[] | null {
  const pausable = (message: QueuedMessage<Payload>) =>
    message.threadId === threadId &&
    (message.status === "queued" || message.status === "sending")
  if (!messages.some(pausable)) return null
  return messages.map((message) =>
    pausable(message)
      ? {
          ...message,
          status:
            message.status === "sending"
              ? ("sending" as const)
              : ("paused" as const),
          pauseRequested: true,
          error: reason,
        }
      : message
  )
}

export function resumeThread<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  threadId: string
) {
  return messages.map((message) =>
    message.threadId === threadId && message.status !== "sending"
      ? {
          ...message,
          status: "queued" as const,
          error: undefined,
          pauseRequested: false,
        }
      : message
  )
}

/** Removes a message, unless it is being sent. */
export function removeMessage<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string
) {
  return messages.filter(
    (message) => message.id !== id || message.status === "sending"
  )
}

/** Drops a chat's queue (the chat was deleted). `null` when it had none. */
export function discardThread<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  threadId: string
) {
  const kept = messages.filter((message) => message.threadId !== threadId)
  return kept.length === messages.length ? null : kept
}

function patch<Payload>(
  messages: readonly QueuedMessage<Payload>[],
  id: string,
  change: Partial<QueuedMessage<Payload>>
): QueuedMessage<Payload>[] {
  return messages.map((message) =>
    message.id === id ? { ...message, ...change } : message
  )
}

/**
 * The queue as stored, read back after a restart: every message is paused,
 * and one that was being sent says it may or may not have arrived.
 * Malformed entries (or storage) are dropped.
 */
export function restoreQueue<Payload>(
  stored: string | null,
  isPayload: (payload: unknown) => payload is Payload
): QueuedMessage<Payload>[] {
  try {
    const values: unknown = JSON.parse(stored ?? "[]")
    if (!Array.isArray(values)) return []
    return values
      .filter(
        (value): value is QueuedMessage<Payload> =>
          Boolean(value) &&
          typeof value.id === "string" &&
          typeof value.threadId === "string" &&
          typeof value.createdAt === "string" &&
          isPayload(value.payload)
      )
      .map((value) => ({
        ...value,
        status: "paused" as const,
        error:
          value.status === "sending"
            ? QUEUE_TEXT.interrupted
            : QUEUE_TEXT.restored,
      }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** What the runner needs from a queue store (a zustand store has this shape). */
export interface QueueStore<Payload> {
  getState(): {
    messages: QueuedMessage<Payload>[]
    claim(id: string): QueuedMessage<Payload> | null
    finish(id: string): void
    release(id: string): void
    fail(id: string, error: string): void
  }
  subscribe(
    listener: (
      state: { messages: QueuedMessage<Payload>[] },
      previous: { messages: QueuedMessage<Payload>[] }
    ) => void
  ): () => void
}

/**
 * Sends queued messages when their chat is ready. `send` resolves `false`
 * when the chat turned out to be busy (safe to try again, up to three times
 * a second apart) and throws when delivery is uncertain, which fails the
 * message and pauses its chat's queue. Returns a function that stops it.
 */
export function startMessageQueueRunner<Payload>({
  queue,
  isReady,
  send,
  subscribeReady,
  onError,
}: {
  queue: QueueStore<Payload>
  isReady(threadId: string): boolean
  send(message: QueuedMessage<Payload>): Promise<unknown>
  subscribeReady(wake: () => void): () => void
  onError(error: unknown): void
}) {
  let stopped = false
  let scheduled = false
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryCounts = new Map<string, number>()
  const active = new Set<string>()
  const wake = () => {
    if (stopped || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (stopped) return
      const heads = new Map<string, QueuedMessage<Payload>>()
      for (const entry of queue.getState().messages)
        if (!heads.has(entry.threadId)) heads.set(entry.threadId, entry)
      for (const entry of heads.values()) {
        if (
          entry.status !== "queued" ||
          active.has(entry.threadId) ||
          retryTimers.has(entry.threadId) ||
          !isReady(entry.threadId)
        ) {
          continue
        }
        active.add(entry.threadId)
        void (async () => {
          try {
            const claimed = queue.getState().claim(entry.id)
            if (!claimed) return
            const result = await send(claimed)
            if (result === false) {
              if (
                queue
                  .getState()
                  .messages.find((message) => message.id === entry.id)
                  ?.pauseRequested
              ) {
                queue.getState().release(entry.id)
                return
              }
              // A definitive busy/preparation response is safe to retry. A
              // rejected/ambiguous dispatch goes to fail(), never this branch.
              const attempts = (retryCounts.get(entry.id) ?? 0) + 1
              retryCounts.set(entry.id, attempts)
              if (attempts >= 3) {
                queue.getState().fail(entry.id, QUEUE_TEXT.busy)
              } else {
                retryTimers.set(
                  entry.threadId,
                  setTimeout(() => {
                    retryTimers.delete(entry.threadId)
                    wake()
                  }, 1000)
                )
                queue.getState().release(entry.id)
              }
            } else {
              retryCounts.delete(entry.id)
              queue.getState().finish(entry.id)
            }
          } catch (error) {
            const reason =
              error instanceof Error
                ? error.message
                : "Message could not be sent."
            try {
              queue
                .getState()
                .fail(entry.id, `${QUEUE_TEXT.unconfirmed} ${reason}`)
            } catch (storageError) {
              onError(storageError)
            }
            onError(error)
          } finally {
            active.delete(entry.threadId)
            wake()
          }
        })()
      }
    })
  }
  const unsubscribeQueue = queue.subscribe((state, previous) => {
    for (const entry of state.messages) {
      const before = previous.messages.find(
        (message) => message.id === entry.id
      )
      if (
        entry.status === "queued" &&
        (before?.status === "paused" || before?.status === "failed")
      )
        retryCounts.delete(entry.id)
    }
    wake()
  })
  const unsubscribeReady = subscribeReady(wake)
  wake()
  return () => {
    stopped = true
    unsubscribeQueue()
    unsubscribeReady()
    for (const timer of retryTimers.values()) clearTimeout(timer)
  }
}
