import { isRecord } from "@betterc0de/schema/json-read"
import type { ChatMessage, ThreadActivity } from "@/types/remote"

/**
 * The turns of a chat that can be restored: turn id → the checkpoint's turn
 * count, from the desktop's `checkpoint.captured` activities. The desktop
 * offers a restore wherever a capture names a checkpoint ref; the phone
 * also asks the capture to be ready (a missing or failed snapshot cannot be
 * returned to), and matches a capture to its turn by id only.
 */
export function restorableTurns(
  activities: readonly ThreadActivity[]
): Map<string, number> {
  const turns = new Map<string, number>()
  for (const activity of activities) {
    if (activity.kind !== "checkpoint.captured") continue
    const payload = isRecord(activity.payload) ? activity.payload : {}
    const ref = payload.checkpointRef ?? payload.checkpoint_ref
    if (typeof ref !== "string" || !ref) continue
    if (payload.status !== undefined && payload.status !== "ready") continue
    const turnId = [payload.turn_id, payload.turnId, activity.turnId].find(
      (value): value is string => typeof value === "string" && value.length > 0
    )
    const turnCount = [
      payload.turn_index,
      payload.turnIndex,
      payload.checkpointTurnCount,
    ].find(
      (value): value is number =>
        typeof value === "number" && Number.isInteger(value) && value >= 0
    )
    if (turnId && turnCount !== undefined) turns.set(turnId, turnCount)
  }
  return turns
}

/**
 * The replies a restore is offered under, as on the desktop: the last
 * assistant message of each restorable turn, except the chat's last
 * message (restoring to it would change nothing). Message id → turn count.
 */
export function restorePoints(
  messages: readonly ChatMessage[],
  turns: ReadonlyMap<string, number>
): Map<string, number> {
  const lastOfTurn = new Map<string, string>()
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.turnId &&
      turns.has(message.turnId)
    )
      lastOfTurn.set(message.turnId, message.id)
  }
  const lastId = messages.at(-1)?.id
  const points = new Map<string, number>()
  for (const [turnId, messageId] of lastOfTurn) {
    if (messageId !== lastId) points.set(messageId, turns.get(turnId)!)
  }
  return points
}
