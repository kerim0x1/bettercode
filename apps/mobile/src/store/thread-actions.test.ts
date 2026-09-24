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

describe("worktree chats", () => {
  const project = { name: "Project", path: "/repo" }

  beforeEach(() => store().reset())

  it("creates the chat, then its worktree, and shows it on the chat", async () => {
    const createThread = vi.fn(async () => undefined)
    const createWorktree = vi.fn(async (threadId: string) => ({
      worktreeId: "w",
      threadId,
      worktreePath: "/home/.betterc0de/worktrees/abc",
      branch: "agent/abc/new",
      baseBranch: "release/1.4",
      headSha: null,
    }))
    const thread = await store().createWorktreeChat(
      { createThread, createWorktree } as unknown as RemoteApi,
      project,
      "release/1.4"
    )
    expect(createWorktree).toHaveBeenCalledWith(thread.id, {
      baseRepoPath: "/repo",
      baseBranch: "release/1.4",
    })
    expect(store().threads[0]).toMatchObject({
      id: thread.id,
      envMode: "worktree",
      worktreePath: "/home/.betterc0de/worktrees/abc",
      branch: "agent/abc/new",
      baseBranch: "release/1.4",
    })
  })

  it("deletes the chat again when its worktree cannot be made", async () => {
    const createThread = vi.fn(async () => undefined)
    const deleteThread = vi.fn(async () => undefined)
    const createWorktree = vi.fn(async () => {
      throw new Error("not a git repository")
    })
    await expect(
      store().createWorktreeChat(
        { createThread, createWorktree, deleteThread } as unknown as RemoteApi,
        project
      )
    ).rejects.toThrow("not a git repository")
    expect(deleteThread).toHaveBeenCalledOnce()
    expect(store().threads).toEqual([])
  })
})

describe("restoring a checkpoint", () => {
  beforeEach(() => store().reset())

  it("reverts on the desktop, then loads the chat again from scratch", async () => {
    useAppStore.setState({
      threads: [chat("thread-1", "2026-09-24T08:00:00.000Z")],
      messagesByThread: {
        "thread-1": [
          {
            id: "gone",
            role: "assistant",
            content: "later reply",
            createdAt: "2026-09-24T09:00:00.000Z",
          },
        ],
      },
    })
    const revertCheckpoint = vi.fn(async () => ({
      reverted: true,
      rolledBackTurns: 1,
      deletedMessages: 2,
      boundaryMessageId: "kept",
    }))
    const kept = {
      id: "kept",
      role: "assistant" as const,
      content: "reply",
      createdAt: "2026-09-24T08:30:00.000Z",
    }
    const api = {
      revertCheckpoint,
      listMessages: vi.fn(async () => [kept]),
      listActivities: vi.fn(async () => []),
      listThreadsPage: vi.fn(async () => ({
        threads: [chat("thread-1", "2026-09-24T08:00:00.000Z")],
        nextCursor: null,
      })),
    } as unknown as RemoteApi
    await store().restoreCheckpoint(api, "thread-1", 1)
    expect(revertCheckpoint).toHaveBeenCalledWith("thread-1", 1)
    expect(store().messagesByThread["thread-1"]).toEqual([kept])
  })

  it("says why the desktop did not restore", async () => {
    const revertCheckpoint = vi.fn(async () => ({
      reverted: false,
      rolledBackTurns: 0,
      deletedMessages: 0,
      boundaryMessageId: null,
      reason: "No checkpoint for turn 3.",
    }))
    await expect(
      store().restoreCheckpoint(
        { revertCheckpoint } as unknown as RemoteApi,
        "thread-1",
        3
      )
    ).rejects.toThrow("No checkpoint for turn 3.")
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
