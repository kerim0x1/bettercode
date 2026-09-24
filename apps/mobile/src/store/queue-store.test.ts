import { beforeEach, describe, expect, it } from "vitest"
import type { ChatAttachment } from "@betterc0de/schema/chat-attachment"
import { documents } from "@/lib/local-documents"
import type { ModelOption } from "@/types/remote"
import { useQueueStore, type QueuedPayload } from "./queue-store"

const selection: ModelOption = {
  key: "claude:sonnet",
  providerKind: "claude",
  providerInstanceId: "claude-1",
  providerLabel: "Claude",
  modelId: "sonnet",
  modelLabel: "Sonnet",
  capabilities: null,
}

const photo: ChatAttachment = {
  type: "file",
  filename: "photo-1.jpg",
  mediaType: "image/jpeg",
  url: "data:image/jpeg;base64,AAAA",
}

const payload = (overrides: Partial<QueuedPayload> = {}): QueuedPayload => ({
  text: "Look at this",
  selection,
  thinkingMode: null,
  fastMode: false,
  ...overrides,
})

const queue = () => useQueueStore.getState()

describe("the phone's message queue", () => {
  beforeEach(() => queue().discardAll())

  it("keeps a queued message's photos across a restart", () => {
    queue().enqueue("thread-1", payload({ attachments: [photo] }))
    // The app starts again and reads the queue it saved.
    useQueueStore.setState({ messages: [] })
    queue().hydrate()
    expect(queue().messages).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        status: "paused",
        payload: expect.objectContaining({ attachments: [photo] }),
      }),
    ])
  })

  it("restores a message saved before photos could be queued", () => {
    queue().enqueue("thread-1", payload())
    useQueueStore.setState({ messages: [] })
    queue().hydrate()
    expect(queue().messages).toHaveLength(1)
    expect(queue().messages[0]!.payload.attachments).toBeUndefined()
  })

  it("drops a saved message whose photos are not attachments", () => {
    queue().enqueue("thread-1", payload({ attachments: [photo] }))
    const saved = JSON.parse(
      documents.read("message-queue.json") ?? "[]"
    ) as Array<{
      payload: { attachments: unknown[] }
    }>
    saved[0]!.payload.attachments = [{ url: 42 }]
    documents.write("message-queue.json", JSON.stringify(saved))
    useQueueStore.setState({ messages: [] })
    queue().hydrate()
    expect(queue().messages).toEqual([])
  })
})
