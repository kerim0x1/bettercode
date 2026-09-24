import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteApi } from "@/transport/types"
import type { ChatThread, ModelOption } from "@/types/remote"
import { useAppStore } from "./app-store"
import { useComposerSettings } from "./composer-settings-store"
import { useQueueStore } from "./queue-store"

const store = () => useAppStore.getState()

function chat(id: string, updatedAt: string): ChatThread {
  return {
    id,
    title: id,
    projectName: "Project",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt,
  }
}

const selection: ModelOption = {
  key: "claude:sonnet",
  providerKind: "claude",
  providerInstanceId: "claude-1",
  providerLabel: "Claude",
  modelId: "sonnet",
  modelLabel: "Sonnet",
  capabilities: null,
}

describe("renaming a chat", () => {
  beforeEach(() => {
    store().reset()
    useAppStore.setState({
      threads: [
        chat("newer", "2026-09-24T09:00:00.000Z"),
        chat("older", "2026-09-24T08:00:00.000Z"),
      ],
    })
  })

  it("renames on the desktop and shows the title it stored", async () => {
    const renameThread = vi.fn(async (threadId: string, title: string) => ({
      threadId,
      title,
      updatedAt: "2026-09-24T10:00:00.000Z",
    }))
    await store().renameThread(
      { renameThread } as unknown as RemoteApi,
      "older",
      "Release notes"
    )
    expect(renameThread).toHaveBeenCalledWith("older", "Release notes")
    expect(store().threads.map((thread) => [thread.id, thread.title])).toEqual([
      ["older", "Release notes"],
      ["newer", "newer"],
    ])
  })

  it("takes over a title changed on the desktop", () => {
    expect(
      store().applyFrame({
        channel: "thread.metadata",
        data: {
          threadId: "newer",
          title: "Renamed on the desktop",
          updatedAt: "2026-09-24T09:30:00.000Z",
        },
      })
    ).toBeNull()
    expect(store().threads[0]).toMatchObject({
      id: "newer",
      title: "Renamed on the desktop",
    })
    store().applyFrame({
      channel: "thread.metadata",
      data: {
        threadId: "unknown",
        title: "X",
        updatedAt: "2026-09-24T09:31:00.000Z",
      },
    })
    expect(store().threads.map((thread) => thread.id)).toEqual([
      "newer",
      "older",
    ])
  })
})

describe("deleting a chat", () => {
  beforeEach(() => {
    store().reset()
    useQueueStore.getState().discardAll()
    useComposerSettings.getState().forgetAll()
  })

  it("forgets everything the phone kept for it, and nothing else", async () => {
    const running = {
      turnId: "turn",
      content: "",
      reasoning: "",
      running: true,
      error: null,
      startedAt: "now",
    }
    useAppStore.setState({
      threads: [
        chat("gone", "2026-09-24T09:00:00.000Z"),
        chat("kept", "2026-09-24T08:00:00.000Z"),
      ],
      messagesByThread: { gone: [], kept: [] },
      streamsByThread: { gone: running, kept: running },
      requestsByThread: { gone: [], kept: [] },
      selectedModels: { gone: selection, kept: selection },
    })
    useQueueStore.getState().enqueue("gone", {
      text: "Later",
      selection,
      thinkingMode: null,
      fastMode: false,
    })
    useQueueStore.getState().enqueue("kept", {
      text: "Later too",
      selection,
      thinkingMode: null,
      fastMode: false,
    })
    useComposerSettings.getState().update("gone", { chatMode: "plan" })

    const deleteThread = vi.fn(async () => undefined)
    await store().deleteThread({ deleteThread } as unknown as RemoteApi, "gone")

    expect(deleteThread).toHaveBeenCalledWith("gone")
    expect(store().threads.map((thread) => thread.id)).toEqual(["kept"])
    for (const key of [
      "messagesByThread",
      "streamsByThread",
      "requestsByThread",
      "selectedModels",
    ] as const) {
      expect(Object.keys(store()[key]), key).toEqual(["kept"])
    }
    expect(
      useQueueStore.getState().messages.map((message) => message.threadId)
    ).toEqual(["kept"])
    expect(useComposerSettings.getState().byThread).toEqual({})
  })

  it("keeps the chat when the desktop refuses", async () => {
    useAppStore.setState({
      threads: [chat("kept", "2026-09-24T08:00:00.000Z")],
    })
    const deleteThread = vi.fn(async () => {
      throw new Error("refused")
    })
    await expect(
      store().deleteThread({ deleteThread } as unknown as RemoteApi, "kept")
    ).rejects.toThrow("refused")
    expect(store().threads.map((thread) => thread.id)).toEqual(["kept"])
  })
})
