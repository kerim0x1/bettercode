import { describe, expect, it } from "vitest"
import type { SnoozedChat } from "@betterc0de/schema"
import {
  partitionChatList,
  pullRequestSettleCandidates,
  SETTLED_AFTER_MS,
  type ChatListPartitionInput,
} from "./chat-list-sections"

const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const HOUR = 60 * 60 * 1000

function chat(id: string, hoursAgo: number) {
  return { id, updatedAt: new Date(NOW - hoursAgo * HOUR).toISOString() }
}

type Chat = ReturnType<typeof chat>

function input(
  threads: Chat[],
  overrides: Partial<ChatListPartitionInput<Chat>> = {}
): ChatListPartitionInput<Chat> {
  return {
    threads,
    pinnedIds: [],
    filedIds: null,
    snoozes: [],
    runningIds: new Set(),
    waitingIds: new Set(),
    closedPullRequestIds: new Set(),
    now: NOW,
    ...overrides,
  }
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

function snooze(
  threadId: string,
  until: number,
  since = NOW - HOUR
): SnoozedChat {
  return {
    thread_id: threadId,
    until: new Date(until).toISOString(),
    since: new Date(since).toISOString(),
  }
}

describe("chat list sections", () => {
  // Newest first, as the list sorts them.
  const threads = [chat("a", 1), chat("b", 5), chat("c", 30), chat("d", 50)]

  it("settles chats untouched for a day unless they are busy", () => {
    const sections = partitionChatList(
      input(threads, { runningIds: new Set(["d"]) })
    )
    expect(ids(sections.recent)).toEqual(["a", "b", "d"])
    expect(ids(sections.settled)).toEqual(["c"])
    expect(SETTLED_AFTER_MS).toBe(24 * HOUR)
  })

  it("settles a chat whose pull request was merged or closed right away", () => {
    const sections = partitionChatList(
      input(threads, {
        closedPullRequestIds: new Set(["b", "a"]),
        waitingIds: new Set(["a"]),
      })
    )
    // a waits for you, so it stays.
    expect(ids(sections.recent)).toEqual(["a"])
    expect(ids(sections.settled)).toEqual(["b", "c", "d"])
  })

  it("puts pinned chats first in their order and keeps filed ones out of the feed", () => {
    const sections = partitionChatList(
      input(threads, {
        pinnedIds: ["d", "missing", "a"],
        filedIds: new Set(["b"]),
      })
    )
    expect(ids(sections.pinned)).toEqual(["d", "a"])
    expect(ids(sections.recent)).toEqual([])
    expect(ids(sections.settled)).toEqual(["c"])
    expect([...sections.hidden].sort()).toEqual(["a", "d", "missing"])
  })

  it("hides snoozed chats and brings due ones back at the top", () => {
    const sections = partitionChatList(
      input(threads, {
        pinnedIds: ["b"],
        snoozes: [
          snooze("a", NOW + 2 * HOUR),
          snooze("b", NOW + HOUR),
          // Due: back at the top of the feed with a mark.
          snooze("d", NOW - 1),
        ],
      })
    )
    expect(ids(sections.pinned)).toEqual([])
    expect(sections.snoozed.map((entry) => entry.thread.id)).toEqual(["b", "a"])
    expect(ids(sections.recent)).toEqual(["d"])
    expect(ids(sections.settled)).toEqual(["c"])
    expect([...sections.back]).toEqual(["d"])
    expect(sections.hidden.has("a")).toBe(true)
    expect(sections.hidden.has("d")).toBe(false)
  })

  it("brings a snoozed chat back early when it waits for you", () => {
    const sections = partitionChatList(
      input(threads, {
        snoozes: [snooze("c", NOW + HOUR)],
        waitingIds: new Set(["c"]),
      })
    )
    expect(ids(sections.recent)).toEqual(["c", "a", "b"])
    expect(sections.back.has("c")).toBe(true)
  })

  it("watches pull requests only for chats that could still settle by them", () => {
    const base = input(threads, {
      runningIds: new Set(["a"]),
      snoozes: [snooze("b", NOW - 1)],
    })
    const sections = partitionChatList(base)
    // a is busy, b is back from a snooze, c and d settle by age anyway.
    expect(ids(pullRequestSettleCandidates(sections, base))).toEqual([])
    const quiet = input(threads)
    expect(
      ids(pullRequestSettleCandidates(partitionChatList(quiet), quiet))
    ).toEqual(["a", "b"])
  })
})
