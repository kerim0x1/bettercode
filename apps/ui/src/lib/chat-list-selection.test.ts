import { afterEach, describe, expect, it } from "vitest"
import {
  pruneChatSelection,
  rangeChatSelection,
  toggleChatSelection,
  useChatSelectionStore,
} from "./chat-list-selection"

const ORDER = ["a", "b", "c", "d", "e"]

describe("chat list selection", () => {
  afterEach(() => useChatSelectionStore.getState().clear())

  it("toggles chats and moves the anchor", () => {
    const one = toggleChatSelection({ ids: [], anchor: null }, "b")
    expect(one).toEqual({ ids: ["b"], anchor: "b" })
    const two = toggleChatSelection(one, "d")
    expect(two).toEqual({ ids: ["b", "d"], anchor: "d" })
    expect(toggleChatSelection(two, "b")).toEqual({ ids: ["d"], anchor: "b" })
  })

  it("selects the range from the anchor in either direction", () => {
    const anchored = { ids: ["b"], anchor: "b" }
    expect(rangeChatSelection(anchored, ORDER, "d").ids).toEqual([
      "b",
      "c",
      "d",
    ])
    expect(
      rangeChatSelection({ ids: ["d"], anchor: "d" }, ORDER, "a").ids
    ).toEqual(["a", "b", "c", "d"])
    // A new range replaces the last one and keeps the anchor.
    const wider = rangeChatSelection(anchored, ORDER, "e")
    expect(rangeChatSelection(wider, ORDER, "c")).toEqual({
      ids: ["b", "c"],
      anchor: "b",
    })
  })

  it("toggles when there is no anchor in the visible order", () => {
    expect(rangeChatSelection({ ids: [], anchor: null }, ORDER, "c")).toEqual({
      ids: ["c"],
      anchor: "c",
    })
    expect(rangeChatSelection({ ids: ["x"], anchor: "x" }, ORDER, "c")).toEqual(
      { ids: ["x", "c"], anchor: "c" }
    )
  })

  it("drops chats the list no longer shows", () => {
    const selection = { ids: ["a", "b"], anchor: "b" }
    expect(pruneChatSelection(selection, new Set(["a", "b", "c"]))).toBe(
      selection
    )
    expect(pruneChatSelection(selection, new Set(["a"]))).toEqual({
      ids: ["a"],
      anchor: null,
    })
  })

  it("keeps the store in step", () => {
    const store = useChatSelectionStore.getState()
    store.toggle("a")
    useChatSelectionStore.getState().selectRange(ORDER, "c")
    expect(useChatSelectionStore.getState().ids).toEqual(["a", "b", "c"])
    useChatSelectionStore.getState().prune(new Set(["b", "c"]))
    expect(useChatSelectionStore.getState().ids).toEqual(["b", "c"])
    useChatSelectionStore.getState().clear()
    expect(useChatSelectionStore.getState().ids).toEqual([])
    expect(useChatSelectionStore.getState().anchor).toBeNull()
  })
})
