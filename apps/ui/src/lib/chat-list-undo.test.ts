import { afterEach, describe, expect, it, vi } from "vitest"
import {
  pushUndoEntry,
  takeUndoEntry,
  UNDO_STACK_LIMIT,
  useChatListUndoStore,
  type ChatListUndoEntry,
} from "./chat-list-undo"

function entry(id: string, expiresAt = 1_000): ChatListUndoEntry {
  return { id, label: id, createdAt: 0, expiresAt, undo: () => {} }
}

describe("chat list undo stack", () => {
  afterEach(() => {
    useChatListUndoStore.getState().clear()
    vi.useRealTimers()
  })

  it("pushes on top, drops expired entries and keeps a bounded stack", () => {
    const stack = pushUndoEntry([entry("old", 5), entry("a")], entry("b"), 10)
    expect(stack.map((item) => item.id)).toEqual(["a", "b"])

    let many: ChatListUndoEntry[] = []
    for (let i = 0; i < UNDO_STACK_LIMIT + 5; i += 1) {
      many = pushUndoEntry(many, entry(`e${i}`), 0)
    }
    expect(many).toHaveLength(UNDO_STACK_LIMIT)
    expect(many[0]!.id).toBe("e5")
  })

  it("takes the newest live entry, or a given one", () => {
    const stack = [entry("a"), entry("b"), entry("gone", 5)]
    const newest = takeUndoEntry(stack, 10)
    expect(newest.entry?.id).toBe("b")
    expect(newest.rest.map((item) => item.id)).toEqual(["a"])

    const named = takeUndoEntry(stack, 10, "a")
    expect(named.entry?.id).toBe("a")
    expect(named.rest.map((item) => item.id)).toEqual(["b"])

    expect(takeUndoEntry(stack, 10, "gone").entry).toBeNull()
    expect(takeUndoEntry([], 10).entry).toBeNull()
  })

  it("runs undo once and forgets the entry", () => {
    const undo = vi.fn()
    const store = useChatListUndoStore.getState()
    const id = store.push({ label: "Archived “x”", undo })
    expect(useChatListUndoStore.getState().undo()?.id).toBe(id)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(useChatListUndoStore.getState().undo()).toBeNull()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it("undoes a toast's own entry and drops discarded or expired ones", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const first = vi.fn()
    const second = vi.fn()
    const store = useChatListUndoStore.getState()
    const firstId = store.push({ label: "first", undo: first })
    const secondId = store.push({ label: "second", undo: second, ttlMs: 50 })

    useChatListUndoStore.getState().undo(firstId)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()

    vi.setSystemTime(1_100)
    expect(useChatListUndoStore.getState().undo(secondId)).toBeNull()
    expect(second).not.toHaveBeenCalled()

    const third = useChatListUndoStore.getState().push({
      label: "third",
      undo: () => {},
    })
    useChatListUndoStore.getState().discard(third)
    expect(useChatListUndoStore.getState().entries).toEqual([])
  })
})
