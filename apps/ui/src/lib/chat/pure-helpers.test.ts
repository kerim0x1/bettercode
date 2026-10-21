import { describe, expect, it } from "vitest"
import type {
  ChatMessage,
  ChatThread,
  ThreadActivity,
} from "@betterc0de/schema"
import {
  applyLru,
  mergeMessageSnapshot,
  oldestMessageSequence,
  type LruState,
} from "./pure-helpers"
import { emptyStreamState, LRU_CAPACITY } from "./types"

function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    projectName: "p",
    projectPath: "",
    messages: [
      {
        id: `${id}-m`,
        role: "assistant",
        content: "hi",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function activity(threadId: string): ThreadActivity {
  return {
    id: `${threadId}-a`,
    threadId,
    kind: "tool.completed",
    tone: "tool",
    summary: "tool",
    payload: { output: "x".repeat(32) },
    createdAt: "2026-01-01T00:00:00Z",
  }
}

/** `count` threads, all holding messages and activities, none in lruOrder. */
function residentState(count: number): LruState {
  const threads = Array.from({ length: count }, (_, index) =>
    thread(`t${index}`)
  )
  return {
    lruOrder: [],
    threads,
    activeThreadId: null,
    messagesLoadedByThread: Object.fromEntries(
      threads.map((item) => [item.id, true])
    ),
    activitiesByThread: Object.fromEntries(
      threads.map((item) => [item.id, [activity(item.id)]])
    ),
    activitiesLoadedByThread: Object.fromEntries(
      threads.map((item) => [item.id, true])
    ),
    olderMessagesCursorByThread: Object.fromEntries(
      threads.map((item) => [item.id, 7])
    ),
    streamingByThread: {},
    pinnedThreadIds: new Set(),
  }
}

describe("applyLru", () => {
  it("counts prefetched threads that never entered the order and evicts them", () => {
    const state = residentState(LRU_CAPACITY + 3)
    const result = applyLru(state, "t0")

    expect(result.lruOrder).toHaveLength(LRU_CAPACITY)
    expect(result.lruOrder[0]).toBe("t0")
    const evicted = state.threads
      .map((item) => item.id)
      .filter((id) => !result.lruOrder.includes(id))
    expect(evicted).toHaveLength(3)
    for (const id of evicted) {
      expect(result.messagesLoadedByThread[id]).toBe(false)
      expect(result.activitiesByThread[id]).toBeUndefined()
      expect(result.activitiesLoadedByThread[id]).toBeUndefined()
      expect(result.olderMessagesCursorByThread[id]).toBeUndefined()
      expect(result.threads.find((item) => item.id === id)?.messages).toEqual(
        []
      )
    }
    for (const id of result.lruOrder) {
      expect(result.activitiesByThread[id]).toHaveLength(1)
      expect(result.messagesLoadedByThread[id]).toBe(true)
    }
  })

  it("keeps the same references when nothing is over budget", () => {
    const state = residentState(3)
    const result = applyLru(state, "t1")
    expect(result.lruOrder[0]).toBe("t1")
    expect(result.activitiesByThread).toBe(state.activitiesByThread)
    expect(result.threads).toBe(state.threads)
  })

  it("never evicts the active, streaming, pinned, running or vetoed threads", () => {
    const state = residentState(LRU_CAPACITY + 5)
    // The overflow (cold end) holds t10..t14 when t0 is touched.
    state.activeThreadId = "t10"
    state.streamingByThread = {
      t11: { ...emptyStreamState, isStreaming: true },
    }
    state.pinnedThreadIds = new Set(["t12"])
    state.threads = state.threads.map((item) =>
      item.id === "t13"
        ? { ...item, session: { activeTurnId: "turn-1" } }
        : item
    )
    const result = applyLru(state, "t0", {
      keepResident: (id) => id === "t14",
    })

    for (const id of ["t10", "t11", "t12", "t13", "t14"]) {
      expect(result.messagesLoadedByThread[id]).toBe(true)
      expect(result.activitiesByThread[id]).toBeDefined()
    }
  })
})

function message(id: string, sequence?: number): ChatMessage {
  return {
    id,
    role: "user",
    content: id,
    createdAt: "2026-01-01T00:00:00Z",
    ...(sequence === undefined ? {} : { sequence }),
  } as ChatMessage
}

describe("mergeMessageSnapshot", () => {
  it("reads the oldest sequence of a page", () => {
    expect(oldestMessageSequence([message("a", 9), message("b", 4)])).toBe(4)
    expect(oldestMessageSequence([message("a")])).toBeUndefined()
  })

  it("keeps a message added while the read ran and drops rows removed on the server", () => {
    const merged = mergeMessageSnapshot({
      local: [message("old", 1), message("removed", 2), message("new-local")],
      page: [message("old", 1), message("reply", 3)],
      pageHasOlder: false,
      previousCursor: undefined,
      keepLocalIds: new Set(["new-local"]),
    })
    expect(merged.messages.map((item) => item.id)).toEqual([
      "old",
      "reply",
      "new-local",
    ])
    expect(merged.olderCursor).toBeUndefined()
  })

  it("keeps older pages the user already loaded when the page overlaps them", () => {
    const merged = mergeMessageSnapshot({
      local: [message("m1", 1), message("m2", 2), message("m3", 3)],
      page: [message("m2", 2), message("m3", 3), message("m4", 4)],
      pageHasOlder: true,
      previousCursor: undefined,
      keepLocalIds: new Set(),
    })
    expect(merged.messages.map((item) => item.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ])
    // The start of the chat was already loaded, so there is nothing older.
    expect(merged.olderCursor).toBeUndefined()
  })

  it("drops stale history that no longer reaches the page instead of leaving a gap", () => {
    const merged = mergeMessageSnapshot({
      local: [message("m1", 1), message("m2", 2)],
      page: [message("m50", 50), message("m51", 51)],
      pageHasOlder: true,
      previousCursor: undefined,
      keepLocalIds: new Set(),
    })
    expect(merged.messages.map((item) => item.id)).toEqual(["m50", "m51"])
    expect(merged.olderCursor).toBe(50)
  })
})
