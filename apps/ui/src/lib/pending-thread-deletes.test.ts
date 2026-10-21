import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPendingThreadDeletes } from "./pending-thread-deletes"

// The module's default instance deletes through the chat store.
vi.mock("@/lib/chat-store", () => ({
  useChatStore: { getState: () => ({ deleteThread: () => {} }) },
}))

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const JOURNAL_KEY = "betterc0de:pending-thread-deletes"

describe("pending thread deletes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })
  afterEach(() => vi.useRealTimers())

  it("hides chats at once and deletes them when the undo window passes", () => {
    const commit = vi.fn()
    const storage = memoryStorage()
    const deletes = createPendingThreadDeletes({
      commit,
      storage,
      delayMs: 8_000,
    })
    const batch = deletes.schedule(["a", "b", "a"])
    expect(deletes.store.getState().hidden).toEqual({ a: true, b: true })
    expect(JSON.parse(storage.data.get(JOURNAL_KEY)!)).toEqual([
      { id: "a", at: 18_000 },
      { id: "b", at: 18_000 },
    ])
    vi.advanceTimersByTime(7_999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit.mock.calls).toEqual([["a"], ["b"]])
    expect(deletes.isPending(batch)).toBe(false)
    // Deleted chats stay hidden; the journal is done with them.
    expect(deletes.store.getState().hidden).toEqual({ a: true, b: true })
    expect(storage.data.has(JOURNAL_KEY)).toBe(false)
  })

  it("brings chats back when undone in time", () => {
    const commit = vi.fn()
    const storage = memoryStorage()
    const deletes = createPendingThreadDeletes({ commit, storage })
    const batch = deletes.schedule(["a"])
    expect(deletes.cancel(batch)).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(commit).not.toHaveBeenCalled()
    expect(deletes.store.getState().hidden).toEqual({})
    expect(storage.data.has(JOURNAL_KEY)).toBe(false)
    expect(deletes.cancel(batch)).toBe(false)
  })

  it("runs every waiting deletion when the window closes", () => {
    const commit = vi.fn()
    const deletes = createPendingThreadDeletes({ commit, storage: null })
    deletes.schedule(["a"])
    deletes.schedule(["b"])
    deletes.flush()
    expect(commit.mock.calls).toEqual([["a"], ["b"]])
    vi.advanceTimersByTime(60_000)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it("finishes deletions that were due when the app quit, not another window's", () => {
    const storage = memoryStorage()
    storage.setItem(
      JOURNAL_KEY,
      JSON.stringify([
        { id: "due", at: 9_000 },
        { id: "waiting", at: 15_000 },
        { id: 3, at: 1 },
      ])
    )
    const commit = vi.fn()
    const deletes = createPendingThreadDeletes({ commit, storage })
    expect(deletes.resume()).toEqual(["due"])
    expect(commit.mock.calls).toEqual([["due"]])
    expect(deletes.store.getState().hidden).toEqual({ due: true })
    expect(JSON.parse(storage.data.get(JOURNAL_KEY)!)).toEqual([
      { id: "waiting", at: 15_000 },
    ])
  })
})
