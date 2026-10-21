import { afterEach, describe, expect, it, vi } from "vitest"
import {
  chatSlotFromKeyEvent,
  openChatListSlot,
  publishChatListOrder,
  releaseChatListOrder,
  useChatListNavStore,
} from "./chat-list-nav"

const { setActiveThread } = vi.hoisted(() => ({ setActiveThread: vi.fn() }))

vi.mock("@/lib/chat-store", () => ({
  useChatStore: {
    getState: () => ({
      setActiveThread,
      threads: [
        { id: "a", title: "First" },
        { id: "b", title: "Second" },
      ],
    }),
  },
}))

vi.mock("@/lib/chat-list-actions", () => ({ clearSnoozeOnOpen: vi.fn() }))

describe("chat list quick jump", () => {
  afterEach(() => {
    releaseChatListOrder("compact")
    setActiveThread.mockClear()
  })

  it("reads Ctrl/Cmd+1…9 from the physical key or the character", () => {
    expect(
      chatSlotFromKeyEvent({ code: "Digit3", key: "3", ctrlKey: true })
    ).toBe(3)
    expect(
      chatSlotFromKeyEvent({ code: "Digit1", key: "&", metaKey: true })
    ).toBe(1)
    expect(
      chatSlotFromKeyEvent({ code: "Numpad9", key: "9", ctrlKey: true })
    ).toBe(9)
    expect(
      chatSlotFromKeyEvent({ code: "Digit0", key: "0", ctrlKey: true })
    ).toBeNull()
    expect(chatSlotFromKeyEvent({ code: "Digit2", key: "2" })).toBeNull()
    expect(
      chatSlotFromKeyEvent({
        code: "Digit2",
        key: "@",
        ctrlKey: true,
        shiftKey: true,
      })
    ).toBeNull()
    expect(
      chatSlotFromKeyEvent({
        code: "Digit2",
        key: "2",
        ctrlKey: true,
        altKey: true,
      })
    ).toBeNull()
  })

  it("opens the chat in a slot of the published order", () => {
    const dispatched: Event[] = []
    // Node has CustomEvent but no window.
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => dispatched.push(event),
    })
    publishChatListOrder("compact", ["b", "a", "gone"])
    expect(openChatListSlot(1)).toBe(true)
    expect(setActiveThread).toHaveBeenCalledWith("b")
    expect(dispatched).toHaveLength(1)
    expect(openChatListSlot(3)).toBe(false)
    expect(openChatListSlot(4)).toBe(false)
    expect(openChatListSlot(10)).toBe(false)
    vi.unstubAllGlobals()
  })

  it("lets only the publishing layout clear the order", () => {
    publishChatListOrder("compact", ["a"])
    releaseChatListOrder("folders")
    expect(useChatListNavStore.getState().order).toEqual(["a"])
    releaseChatListOrder("compact")
    expect(useChatListNavStore.getState().order).toEqual([])
  })
})
