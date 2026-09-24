import { logger } from "../observability/logger"
import type { ThreadActivityProjection } from "../persistence/projections"
import { threadActivityToWire } from "../provider/runtime"

/**
 * Route-emitted thread activities — the approval / plan / user-input
 * settlements `services/chat/requests.ts` records — are written to the
 * projection store directly, outside the provider event lane, so nothing used
 * to broadcast them: a failed approval response was persisted, but every
 * connected client kept showing the request card until it reloaded. The
 * WebSocket hub registers here on attach so those writes reach live clients
 * on the same `thread.activity` channel the ingestion path uses.
 *
 * A registry rather than an `AppState` field because the hub is constructed
 * after the state object and neither is reachable from the other; the
 * ingestion path gets the hub injected at construction for the same reason.
 */
export interface ThreadActivityBroadcaster {
  broadcast(frame: unknown): void
}

const broadcasters = new Set<ThreadActivityBroadcaster>()

export function registerThreadActivityBroadcaster(
  broadcaster: ThreadActivityBroadcaster
): () => void {
  broadcasters.add(broadcaster)
  return () => {
    broadcasters.delete(broadcaster)
  }
}

/**
 * A chat's new title, to every connected client (`thread.metadata`). Only an
 * explicit rename sends it: echoing every metadata write would bounce each
 * client's older copy back and forth. Best effort, like activities.
 */
export function broadcastThreadMetadata(update: {
  readonly threadId: string
  readonly title: string
  readonly updatedAt: string
}): void {
  const frame = { channel: "thread.metadata", data: { ...update } }
  for (const broadcaster of broadcasters) {
    try {
      broadcaster.broadcast(frame)
    } catch (err) {
      logger.warn(
        { err, thread: update.threadId },
        "failed to broadcast thread metadata"
      )
    }
  }
}

/** Best effort: the activity is already durable; a failed broadcast is logged, never thrown. */
export function broadcastThreadActivity(
  activity: ThreadActivityProjection
): void {
  if (broadcasters.size === 0) return
  const frame = {
    channel: "thread.activity",
    data: threadActivityToWire(activity),
  }
  for (const broadcaster of broadcasters) {
    try {
      broadcaster.broadcast(frame)
    } catch (err) {
      logger.warn(
        { err, thread: activity.thread_id, kind: activity.kind },
        "failed to broadcast route thread activity"
      )
    }
  }
}
