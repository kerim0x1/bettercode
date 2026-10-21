import { describe, expect, it } from "vitest"
import {
  MAX_QUEUED_PER_THREAD,
  QUEUE_TEXT,
  type QueuedMessage,
} from "@betterc0de/schema/message-queue"
import {
  canMoveQueuedMessage,
  claimMessageForSteer,
  enqueueMessageFirst,
  isQueuedMessageEditable,
  lastEditableQueuedMessage,
  moveQueuedMessage,
  moveQueuedMessageBefore,
  updateQueuedMessage,
} from "./message-queue-editing"

type Entry = QueuedMessage<{ text: string }>

function entry(
  id: string,
  threadId = "a",
  status: Entry["status"] = "queued"
): Entry {
  return {
    id,
    threadId,
    createdAt: "2026-10-20T10:00:00.000Z",
    payload: { text: id },
    status,
  }
}

const ids = (messages: readonly Entry[] | null) =>
  messages?.map((message) => message.id) ?? null

describe("editing queued messages", () => {
  it("replaces a draft's payload but never one that is being sent", () => {
    const queue = [entry("a1", "a", "sending"), entry("a2")]
    expect(updateQueuedMessage(queue, "a2", { text: "changed" })?.[1]).toEqual({
      ...queue[1],
      payload: { text: "changed" },
    })
    expect(updateQueuedMessage(queue, "a1", { text: "changed" })).toBeNull()
    expect(updateQueuedMessage(queue, "missing", { text: "x" })).toBeNull()
    expect(queue[1].payload.text).toBe("a2")
  })

  it("keeps a paused or failed draft editable", () => {
    expect(isQueuedMessageEditable(entry("p", "a", "paused"))).toBe(true)
    expect(isQueuedMessageEditable(entry("f", "a", "failed"))).toBe(true)
    expect(isQueuedMessageEditable(entry("s", "a", "sending"))).toBe(false)
    expect(isQueuedMessageEditable(undefined)).toBe(false)
  })
})

describe("reordering queued messages", () => {
  it("moves within its chat and leaves other chats' places alone", () => {
    const queue = [entry("a1"), entry("b1", "b"), entry("a2"), entry("a3")]
    expect(ids(moveQueuedMessage(queue, "a3", -1))).toEqual([
      "a1",
      "b1",
      "a3",
      "a2",
    ])
    expect(ids(moveQueuedMessage(queue, "a1", 1))).toEqual([
      "a2",
      "b1",
      "a1",
      "a3",
    ])
  })

  it("does nothing at the ends of the queue", () => {
    const queue = [entry("a1"), entry("a2")]
    expect(moveQueuedMessage(queue, "a1", -1)).toBeNull()
    expect(moveQueuedMessage(queue, "a2", 1)).toBeNull()
    expect(canMoveQueuedMessage(queue, "a1", -1)).toBe(false)
    expect(canMoveQueuedMessage(queue, "a1", 1)).toBe(true)
  })

  it("never moves a message in front of, or the message that is, being sent", () => {
    const queue = [entry("a1", "a", "sending"), entry("a2"), entry("a3")]
    expect(moveQueuedMessage(queue, "a2", -1)).toBeNull()
    expect(moveQueuedMessage(queue, "a1", 1)).toBeNull()
    expect(ids(moveQueuedMessageBefore(queue, "a3", "a1"))).toEqual([
      "a1",
      "a3",
      "a2",
    ])
  })

  it("drops a message in front of another or at the end", () => {
    const queue = [entry("a1"), entry("a2"), entry("a3")]
    expect(ids(moveQueuedMessageBefore(queue, "a3", "a1"))).toEqual([
      "a3",
      "a1",
      "a2",
    ])
    expect(ids(moveQueuedMessageBefore(queue, "a1", null))).toEqual([
      "a2",
      "a3",
      "a1",
    ])
    expect(moveQueuedMessageBefore(queue, "a1", "a2")).toBeNull()
    expect(moveQueuedMessageBefore(queue, "a1", "a1")).toBeNull()
    expect(moveQueuedMessageBefore(queue, "a1", "other-chat")).toBeNull()
  })
})

describe("adding at the front", () => {
  it("goes first in its chat, behind a message being sent", () => {
    const queue = [entry("b1", "b"), entry("a1", "a", "sending"), entry("a2")]
    expect(ids(enqueueMessageFirst(queue, entry("new")))).toEqual([
      "b1",
      "a1",
      "new",
      "a2",
    ])
    expect(ids(enqueueMessageFirst([entry("b1", "b")], entry("new")))).toEqual([
      "b1",
      "new",
    ])
  })

  it("respects the per-chat limit", () => {
    const full = Array.from({ length: MAX_QUEUED_PER_THREAD }, (_, index) =>
      entry(`a${index}`)
    )
    expect(() => enqueueMessageFirst(full, entry("new"))).toThrow(
      QUEUE_TEXT.full
    )
  })
})

describe("claiming a message to steer", () => {
  it("moves it first and marks it as being sent, clearing a pause", () => {
    const queue = [
      entry("a1", "a", "paused"),
      entry("b1", "b"),
      { ...entry("a2", "a", "failed"), error: "Boom", pauseRequested: true },
    ]
    const { messages, claimed } = claimMessageForSteer(queue, "a2")
    expect(ids(messages)).toEqual(["a2", "b1", "a1"])
    expect(claimed).toMatchObject({
      id: "a2",
      status: "sending",
      error: undefined,
      pauseRequested: false,
    })
    expect(messages[2].status).toBe("paused")
  })

  it("refuses while another message of the chat is being sent", () => {
    const queue = [entry("a1", "a", "sending"), entry("a2")]
    expect(claimMessageForSteer(queue, "a2").claimed).toBeNull()
    expect(claimMessageForSteer(queue, "a1").claimed).toBeNull()
    expect(claimMessageForSteer(queue, "missing").claimed).toBeNull()
  })
})

describe("the message Alt+Up edits", () => {
  it("is the chat's last message that is not being sent", () => {
    const queue = [entry("a1"), entry("a2"), entry("b1", "b", "sending")]
    expect(lastEditableQueuedMessage(queue, "a")?.id).toBe("a2")
    expect(lastEditableQueuedMessage(queue, "b")).toBeNull()
    expect(lastEditableQueuedMessage(queue, "none")).toBeNull()
  })
})
