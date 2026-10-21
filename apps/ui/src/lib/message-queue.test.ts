import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createMessageQueueStore,
  type QueueStorage,
} from "./message-queue-store"
import { startMessageQueueRunner } from "./message-queue-runner"

function fixture() {
  let value: string | null = null
  const storage: QueueStorage = {
    read: () => value,
    write: (next) => {
      value = next
    },
  }
  const queue = createMessageQueueStore(storage)
  const add = (threadId: string, text: string) =>
    queue.getState().enqueue(threadId, { text, files: [], browserElements: [] })
  return { storage, queue, add }
}
afterEach(() => vi.useRealTimers())

describe("queued drafts", () => {
  it("stores an independent copy of attachments and browser tags before acknowledging enqueue", () => {
    const { queue, storage } = fixture()
    const payload = {
      text: "Change this",
      files: [{ type: "file", url: "data:text/plain;base64,SGk=" }],
      browserElements: [
        {
          url: "https://example.com",
          selector: "#buy",
          tagName: "button",
          text: "Buy",
          label: "Buy",
        },
      ],
    }
    const entry = queue.getState().enqueue("a", payload)
    payload.text = "Later draft"
    payload.files.length = 0
    payload.browserElements.length = 0
    expect(JSON.parse(storage.read()!)[0]).toMatchObject({
      id: entry.id,
      payload: {
        text: "Change this",
        files: [{ type: "file" }],
        browserElements: [{ selector: "#buy" }],
      },
    })
    expect(queue.getState().messages[0].payload.text).toBe("Change this")
  })

  it("keeps the queue unchanged if saving the new draft fails", () => {
    const { queue, storage, add } = fixture()
    add("a", "Existing")
    storage.write = () => {
      throw new Error("Storage full")
    }
    expect(() => add("a", "Unacknowledged")).toThrow("Storage full")
    expect(
      queue.getState().messages.map((entry) => entry.payload.text)
    ).toEqual(["Existing"])
  })

  it("restores pending and interrupted deliveries paused, preserving their identities", () => {
    const { queue, storage, add } = fixture()
    const first = add("a", "First")
    add("a", "Second")
    queue.getState().claim(first.id)
    const restored = createMessageQueueStore(storage).getState().messages
    expect(restored.map((entry) => entry.status)).toEqual(["paused", "paused"])
    expect(restored[0]).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
    })
    expect(restored[0].error).toContain("Check the chat")
  })

  it("allows only one claim of a thread's first message and protects sending entries from removal", () => {
    const { queue, add } = fixture()
    const first = add("a", "First"),
      second = add("a", "Second")
    expect(queue.getState().claim(second.id)).toBeNull()
    expect(queue.getState().claim(first.id)).not.toBeNull()
    expect(queue.getState().claim(first.id)).toBeNull()
    queue.getState().remove(first.id)
    expect(queue.getState().messages).toHaveLength(2)
    queue.getState().remove(second.id)
    expect(queue.getState().messages).toHaveLength(1)
  })

  it("still pauses in memory when storage fails during Stop", () => {
    const { queue, storage, add } = fixture()
    add("a", "Waiting")
    storage.write = () => {
      throw new Error("Storage full")
    }
    expect(() => queue.getState().pause("a")).toThrow()
    expect(queue.getState().messages[0].status).toBe("paused")
  })

  it("discards only the deleted chat's drafts", () => {
    const { queue, add, storage } = fixture()
    add("a", "Delete me")
    add("b", "Keep me")
    queue.getState().discardThread("a")
    expect(queue.getState().messages.map((entry) => entry.threadId)).toEqual([
      "b",
    ])
    expect(JSON.parse(storage.read()!)).toHaveLength(1)
  })
})

describe("editing the queue", () => {
  it("saves edits and the new order, which come back paused after a restart", () => {
    const { queue, storage, add } = fixture()
    const first = add("a", "First"),
      second = add("a", "Second")
    queue.getState().edit(second.id, {
      text: "Second, edited",
      files: [],
      browserElements: [],
    })
    queue.getState().move(second.id, -1)
    const restored = createMessageQueueStore(storage).getState().messages
    expect(
      restored.map((entry) => [entry.id, entry.payload.text, entry.status])
    ).toEqual([
      [second.id, "Second, edited", "paused"],
      [first.id, "First", "paused"],
    ])
  })

  it("does not write the queue when nothing changes", () => {
    const { queue, storage, add } = fixture()
    const only = add("a", "Only")
    const write = vi.fn()
    storage.write = write
    queue.getState().move(only.id, -1)
    queue.getState().moveBefore(only.id, null)
    expect(write).not.toHaveBeenCalled()
  })

  it("puts a message to steer first and keeps the runner off it while claimed", async () => {
    const { queue, add } = fixture()
    add("a", "Queued earlier")
    const steer = queue
      .getState()
      .enqueueFirst("a", { text: "Steer this", files: [], browserElements: [] })
    expect(queue.getState().messages[0].id).toBe(steer.id)
    expect(queue.getState().claimForSteer(steer.id)?.status).toBe("sending")
    // A sent message starts a turn, so the chat is busy until it ends.
    const ready = new Set(["a"])
    const send = vi.fn(async (entry) => {
      ready.delete(entry.threadId)
    })
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: (id) => ready.has(id),
      subscribeReady: () => () => {},
      onError: vi.fn(),
    })
    try {
      await Promise.resolve()
      expect(send).not.toHaveBeenCalled()
      queue.getState().release(steer.id)
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(send.mock.calls[0][0].id).toBe(steer.id)
    } finally {
      stop()
    }
  })
})

describe("queue delivery", () => {
  it("waits for completion and delivers FIFO independently of the focused chat", async () => {
    const { queue, add } = fixture()
    add("a", "A1")
    add("a", "A2")
    add("b", "B1")
    const ready = new Set(["b"])
    let wake!: () => void
    const send = vi.fn(async (entry) => {
      ready.delete(entry.threadId)
    })
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: (id) => ready.has(id),
      subscribeReady: (fn) => {
        wake = fn
        return () => {}
      },
      onError: vi.fn(),
    })
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      expect(send.mock.calls[0][0].payload.text).toBe("B1")
      ready.add("a")
      wake()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
      expect(send.mock.calls[1][0].payload.text).toBe("A1")
      ready.add("a")
      wake()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
      expect(send.mock.calls[2][0].payload.text).toBe("A2")
      await vi.waitFor(() => expect(queue.getState().messages).toEqual([]))
    } finally {
      stop()
    }
  })

  it("does not double-dispatch with two subscriptions or while a send is awaiting admission", async () => {
    const { queue, add } = fixture()
    const gate = Promise.withResolvers<void>()
    add("a", "Once")
    const send = vi.fn(() => gate.promise)
    const options = {
      queue,
      send,
      isReady: () => true,
      subscribeReady: () => () => {},
      onError: vi.fn(),
    }
    const first = startMessageQueueRunner(options),
      second = startMessageQueueRunner(options)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(queue.getState().messages[0].status).toBe("sending")
      gate.resolve()
      await vi.waitFor(() => expect(queue.getState().messages).toEqual([]))
      expect(send).toHaveBeenCalledOnce()
    } finally {
      first()
      second()
    }
  })

  it("pauses after an ambiguous failure and never automatically retries it or the next draft", async () => {
    const { queue, add } = fixture()
    add("a", "First")
    add("a", "Second")
    const send = vi.fn().mockRejectedValue(new Error("Connection lost"))
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: () => true,
      subscribeReady: () => () => {},
      onError: vi.fn(),
    })
    try {
      await vi.waitFor(() =>
        expect(queue.getState().messages.map((entry) => entry.status)).toEqual([
          "failed",
          "paused",
        ])
      )
      expect(send).toHaveBeenCalledOnce()
    } finally {
      stop()
    }
  })

  it("retries only definitive busy responses and keeps a stopped queue paused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { queue, add } = fixture()
    add("a", "Waiting")
    const send = vi.fn().mockResolvedValue(false)
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: () => true,
      subscribeReady: () => () => {},
      onError: vi.fn(),
    })
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(1000)
      expect(send).toHaveBeenCalledTimes(2)
      queue.getState().pause("a")
      await vi.advanceTimersByTimeAsync(5000)
      expect(send).toHaveBeenCalledTimes(2)
      expect(queue.getState().messages[0].status).toBe("paused")
    } finally {
      stop()
    }
  })

  it("does not send or spin if the delivery claim cannot be persisted", async () => {
    const { queue, add, storage } = fixture()
    add("a", "Keep me")
    storage.write = () => {
      throw new Error("Disk quota")
    }
    const send = vi.fn()
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: () => true,
      subscribeReady: () => () => {},
      onError: vi.fn(),
    })
    try {
      await vi.waitFor(() =>
        expect(queue.getState().messages[0].status).toBe("failed")
      )
      expect(send).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it("honors Stop while a queued draft is still awaiting admission", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { queue, add } = fixture()
    add("a", "Preparing")
    add("a", "Next")
    const admission = Promise.withResolvers<boolean>()
    const send = vi.fn(() => admission.promise)
    const stop = startMessageQueueRunner({
      queue,
      send,
      isReady: () => true,
      subscribeReady: () => () => {},
      onError: vi.fn(),
    })
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      queue.getState().pause("a")
      admission.resolve(false)
      await vi.waitFor(() =>
        expect(queue.getState().messages.map((entry) => entry.status)).toEqual([
          "paused",
          "paused",
        ])
      )
      await vi.advanceTimersByTimeAsync(5000)
      expect(send).toHaveBeenCalledOnce()
    } finally {
      stop()
    }
  })
})
