import type { SnoozedChat } from "@betterc0de/schema"
import { snoozeStatus } from "@/lib/chat-snooze"

/**
 * Splits the sidebar's chats into the sections the feed layouts show, top
 * to bottom: Pinned (in the user's order), the feed (chats back from a
 * snooze first, then newest first), Inactive and Snoozed. Folders take
 * their chats from what is left (`hidden` lists what they must skip).
 *
 * A chat settles into Inactive once it has been untouched for a day, or
 * at once when the pull request of its branch was merged or closed. A chat
 * that is working or waiting for you, pinned, filed in a folder or back
 * from a snooze never settles.
 */

/** A chat untouched this long moves to Inactive. */
export const SETTLED_AFTER_MS = 24 * 60 * 60 * 1000

export interface ChatListThread {
  id: string
  updatedAt: string
}

export interface ChatListPartitionInput<T extends ChatListThread> {
  /** The chats the list shows (filters applied), newest first. */
  threads: readonly T[]
  pinnedIds: readonly string[]
  /** Chats filed in a folder (Compact list), or null without folders. */
  filedIds: ReadonlySet<string> | null
  snoozes: readonly SnoozedChat[]
  runningIds: ReadonlySet<string>
  waitingIds: ReadonlySet<string>
  /** Chats whose branch's pull request was merged or closed. */
  closedPullRequestIds: ReadonlySet<string>
  now: number
  settleAfterMs?: number
}

export interface ChatListPartition<T extends ChatListThread> {
  pinned: T[]
  recent: T[]
  settled: T[]
  snoozed: Array<{ thread: T; until: string }>
  /** Chats back from a snooze and not opened yet: they carry a mark. */
  back: Set<string>
  /** Pinned and snoozed chats, which folders do not show. */
  hidden: Set<string>
}

export function partitionChatList<T extends ChatListThread>(
  input: ChatListPartitionInput<T>
): ChatListPartition<T> {
  const settleAfterMs = input.settleAfterMs ?? SETTLED_AFTER_MS
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]))
  const snoozeById = new Map(
    input.snoozes.map((entry) => [entry.thread_id, entry])
  )

  const back = new Set<string>()
  const snoozed: Array<{ thread: T; until: string }> = []
  const away = new Set<string>()
  for (const thread of input.threads) {
    const entry = snoozeById.get(thread.id)
    if (!entry) continue
    const status = snoozeStatus(
      entry,
      {
        updatedAt: thread.updatedAt,
        running: input.runningIds.has(thread.id),
        waiting: input.waitingIds.has(thread.id),
      },
      input.now
    )
    if (status === "back") {
      back.add(thread.id)
    } else {
      away.add(thread.id)
      snoozed.push({ thread, until: entry.until })
    }
  }
  snoozed.sort((a, b) => Date.parse(a.until) - Date.parse(b.until))

  const pinnedSet = new Set(input.pinnedIds)
  const pinned = input.pinnedIds.flatMap((id) => {
    const thread = byId.get(id)
    return thread && !away.has(id) ? [thread] : []
  })

  const returned: T[] = []
  const recent: T[] = []
  const settled: T[] = []
  for (const thread of input.threads) {
    if (pinnedSet.has(thread.id) || away.has(thread.id)) continue
    if (input.filedIds?.has(thread.id)) continue
    if (back.has(thread.id)) {
      returned.push(thread)
      continue
    }
    const busy =
      input.runningIds.has(thread.id) || input.waitingIds.has(thread.id)
    const idleFor = input.now - Date.parse(thread.updatedAt)
    const settles =
      !busy &&
      (idleFor > settleAfterMs || input.closedPullRequestIds.has(thread.id))
    if (settles) settled.push(thread)
    else recent.push(thread)
  }

  return {
    pinned,
    recent: [...returned, ...recent],
    settled,
    snoozed,
    back,
    hidden: new Set([...pinnedSet, ...away]),
  }
}

/**
 * Chats whose pull request decides whether they settle: in the feed, not
 * busy, not back from a snooze and not idle long enough to settle anyway.
 * The list watches only their repositories' pull requests.
 */
export function pullRequestSettleCandidates<T extends ChatListThread>(
  partition: ChatListPartition<T>,
  input: Pick<
    ChatListPartitionInput<T>,
    "runningIds" | "waitingIds" | "now" | "settleAfterMs"
  >
): T[] {
  const settleAfterMs = input.settleAfterMs ?? SETTLED_AFTER_MS
  return partition.recent.filter(
    (thread) =>
      !partition.back.has(thread.id) &&
      !input.runningIds.has(thread.id) &&
      !input.waitingIds.has(thread.id) &&
      input.now - Date.parse(thread.updatedAt) <= settleAfterMs
  )
}
