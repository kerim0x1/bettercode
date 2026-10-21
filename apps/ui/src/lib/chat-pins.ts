import { PINNED_CHAT_LIMIT } from "@betterc0de/schema"

/**
 * Edits of the pinned chats (`settings.pinned_thread_ids`), the group at
 * the top of the sidebar's chat lists. `/pin`, `/pins` and `/quick-switch`
 * read the same order. Every edit returns a new array, or the input itself
 * when nothing changes, so a caller can skip writing settings by comparing
 * references.
 */

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function arePinned(
  pinned: readonly string[],
  threadIds: readonly string[]
): boolean {
  return threadIds.length > 0 && threadIds.every((id) => pinned.includes(id))
}

/**
 * Pins chats before `beforeId`, or at the end when it is null or missing.
 * Chats that are already pinned move there, in the order given. New pins
 * past the limit are left out.
 */
export function pinChats(
  pinned: string[],
  threadIds: readonly string[],
  beforeId: string | null = null
): string[] {
  const moving = [...new Set(threadIds)]
  if (moving.length === 0) return pinned
  const movingSet = new Set(moving)
  const rest = pinned.filter((id) => !movingSet.has(id))
  const room = Math.max(0, PINNED_CHAT_LIMIT - rest.length)
  const placed = moving.slice(0, room)
  // The anchor is `beforeId`, or the next pinned chat after it that stays
  // where it is, so dropping a selection on one of its own rows works.
  let anchor: string | null = null
  if (beforeId !== null) {
    const start = pinned.indexOf(beforeId)
    if (start >= 0) {
      anchor = pinned.slice(start).find((id) => !movingSet.has(id)) ?? null
    }
  }
  const index = anchor === null ? rest.length : rest.indexOf(anchor)
  const next = [...rest.slice(0, index), ...placed, ...rest.slice(index)]
  return sameOrder(next, pinned) ? pinned : next
}

export function unpinChats(
  pinned: string[],
  threadIds: readonly string[]
): string[] {
  const removing = new Set(threadIds)
  const next = pinned.filter((id) => !removing.has(id))
  return next.length === pinned.length ? pinned : next
}

/**
 * Undo of a pin edit: the chats go back to where `previous` had them, and
 * chats `previous` did not pin are unpinned. Other chats keep the places
 * they have now.
 */
export function restorePinnedChats(
  pinned: string[],
  threadIds: readonly string[],
  previous: readonly string[]
): string[] {
  const restoring = new Set(threadIds)
  const next = pinned.filter((id) => !restoring.has(id))
  const back = previous
    .map((id, index) => ({ id, index }))
    .filter((entry) => restoring.has(entry.id))
  for (const { id, index } of back) {
    if (next.length >= PINNED_CHAT_LIMIT) break
    next.splice(Math.min(index, next.length), 0, id)
  }
  return sameOrder(next, pinned) ? pinned : next
}
