import { describe, expect, it } from "vitest"
import { PINNED_CHAT_LIMIT } from "@betterc0de/schema"
import {
  arePinned,
  pinChats,
  restorePinnedChats,
  unpinChats,
} from "./chat-pins"

describe("chat pins", () => {
  it("pins at the end, before a pinned chat, or moves chats already pinned", () => {
    const pinned = ["a", "b", "c"]
    expect(pinChats(pinned, ["d"])).toEqual(["a", "b", "c", "d"])
    expect(pinChats(pinned, ["d", "e"], "b")).toEqual(["a", "d", "e", "b", "c"])
    expect(pinChats(pinned, ["c"], "a")).toEqual(["c", "a", "b"])
    // An anchor that is not pinned puts them at the end.
    expect(pinChats(pinned, ["d"], "zzz")).toEqual(["a", "b", "c", "d"])
  })

  it("lands a dragged selection before the next chat that stays", () => {
    const pinned = ["a", "b", "c", "d"]
    expect(pinChats(pinned, ["b", "x"], "b")).toEqual(["a", "b", "x", "c", "d"])
    expect(pinChats(pinned, ["c", "d"], "d")).toEqual(["a", "b", "c", "d"])
  })

  it("returns the same list when nothing changes", () => {
    const pinned = ["a", "b"]
    expect(pinChats(pinned, [])).toBe(pinned)
    expect(pinChats(pinned, ["b"])).toBe(pinned)
    expect(pinChats(pinned, ["a"], "b")).toBe(pinned)
    expect(unpinChats(pinned, ["x"])).toBe(pinned)
  })

  it("unpins and tells whether every chat is pinned", () => {
    expect(unpinChats(["a", "b", "c"], ["b", "x"])).toEqual(["a", "c"])
    expect(arePinned(["a", "b"], ["a", "b"])).toBe(true)
    expect(arePinned(["a", "b"], ["a", "c"])).toBe(false)
    expect(arePinned(["a"], [])).toBe(false)
  })

  it("stops adding new pins at the limit", () => {
    const full = Array.from({ length: PINNED_CHAT_LIMIT }, (_, i) => `t${i}`)
    expect(pinChats(full, ["new"])).toBe(full)
    // Moving a chat that is already pinned still works.
    expect(pinChats(full, ["t5"], "t0")[0]).toBe("t5")
  })

  it("puts chats back where they were for undo", () => {
    const previous = ["a", "b", "c"]
    // Unpinned b, then undo.
    expect(restorePinnedChats(["a", "c"], ["b"], previous)).toEqual([
      "a",
      "b",
      "c",
    ])
    // Pinned d, then undo: d was not pinned before.
    expect(restorePinnedChats(["a", "b", "c", "d"], ["d"], previous)).toEqual(
      previous
    )
    // Reordered c to the top, then undo; a chat pinned since stays.
    expect(restorePinnedChats(["c", "a", "b", "e"], ["c"], previous)).toEqual([
      "a",
      "b",
      "c",
      "e",
    ])
    const same = ["a", "b"]
    expect(restorePinnedChats(same, ["x"], ["a", "b"])).toBe(same)
  })
})
