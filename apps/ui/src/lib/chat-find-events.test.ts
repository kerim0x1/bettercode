import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CHAT_FIND_OPEN_EVENT,
  requestChatFind,
  resolveChatFindScope,
  type ChatFindOpenRequest,
} from "./chat-find-events"

afterEach(() => vi.unstubAllGlobals())

describe("requestChatFind", () => {
  it("names the transcript and reports whether one opened", () => {
    const target = new EventTarget()
    vi.stubGlobal("window", target)
    const seen: ChatFindOpenRequest[] = []
    target.addEventListener(CHAT_FIND_OPEN_EVENT, (event) => {
      const request = (event as CustomEvent<ChatFindOpenRequest>).detail
      seen.push({ ...request })
      // Only the transcript the request names opens.
      if (request.scopeId === "scope-1") request.handled = true
    })

    expect(requestChatFind("scope-1")).toBe(true)
    expect(requestChatFind("scope-2")).toBe(false)
    expect(requestChatFind()).toBe(false)
    expect(seen).toEqual([{ scopeId: "scope-1" }, { scopeId: "scope-2" }, {}])
  })
})

describe("resolveChatFindScope", () => {
  it("claims nothing outside a document", () => {
    expect(resolveChatFindScope(null)).toBeNull()
  })
})
