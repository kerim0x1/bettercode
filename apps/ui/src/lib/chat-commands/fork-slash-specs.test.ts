import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend/coreApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/backend/coreApi")>()
  return {
    ...actual,
    saveThread: vi.fn().mockResolvedValue(undefined),
    upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
    saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock("@/services/backend/chatApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/backend/chatApi")>()
  return {
    ...actual,
    generateTitle: vi.fn().mockResolvedValue("Title"),
    loadThreadActivities: vi.fn().mockResolvedValue([]),
  }
})

import { useChatStore } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import {
  runRegisteredSlashCommand,
  type SlashRuntimeContext,
} from "@/lib/slash-command-runtime"

function slashContext(
  overrides: Partial<SlashRuntimeContext> & Pick<SlashRuntimeContext, "cmd">
): SlashRuntimeContext {
  const text = [overrides.cmd, ...(overrides.args ?? [])].join(" ")
  return {
    args: [],
    trimmedText: text,
    rawText: text,
    threadId: null,
    selectedProvider: undefined,
    selectedModel: "test-model",
    thinkingMode: null,
    chatMode: "agent",
    setChatMode: () => {},
    specialMode: null,
    permissionLevel: "ask",
    contextWindow: "default",
    fastMode: false,
    appMode: "agent",
    closeSlash: () => {},
    activeThread: null,
    effectiveChatMode: "agent",
    ...overrides,
  }
}

function sourceThread(): string {
  const store = useChatStore.getState()
  const id = store.createThread("Source", "BetterC0de", "/repo")
  store.addMessage(id, {
    id: "m-1",
    role: "user",
    content: "first",
    createdAt: "2026-10-20T10:00:00.000Z",
  })
  store.addMessage(id, {
    id: "m-2",
    role: "assistant",
    content: "answer",
    createdAt: "2026-10-20T10:00:01.000Z",
  })
  store.addMessage(id, {
    id: "m-3",
    role: "user",
    content: "second",
    createdAt: "2026-10-20T10:00:02.000Z",
  })
  return id
}

describe("/fork and /merge-back", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      threads: [],
      activeThreadId: null,
      messagesLoadedByThread: {},
      settingsByThread: {},
      streamingByThread: {},
    })
    useMessageQueueStore.setState({ messages: [] })
  })

  it("forks up to the message `/fork <number>` names", async () => {
    const sourceId = sourceThread()
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/fork", args: ["2"], threadId: sourceId })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toBe("")
    const fork = useChatStore
      .getState()
      .threads.find((thread) => thread.id === result?.threadId)
    expect(fork?.parentThreadId).toBe(sourceId)
    expect(fork?.messages.map((message) => message.content)).toEqual([
      "first",
      "answer",
    ])
  })

  it("explains a message number past the end instead of forking", async () => {
    const sourceId = sourceThread()
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/fork", args: ["9"], threadId: sourceId })
    )

    expect(result?.output).toContain("This chat has 3 messages.")
    expect(useChatStore.getState().threads).toHaveLength(1)
  })

  it("explains /merge-back in a chat that isn't a fork", async () => {
    const sourceId = sourceThread()
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/merge-back", threadId: sourceId })
    )

    expect(result?.output).toContain("isn't a fork")
    expect(useMessageQueueStore.getState().messages).toEqual([])
  })

  it("hands the fork's answer back to its parent and opens it", async () => {
    const sourceId = sourceThread()
    const forkId = (await useChatStore.getState().forkThread(sourceId))!
    const later = (seconds: number) =>
      new Date(Date.now() + seconds * 1000).toISOString()
    useChatStore.getState().addMessage(forkId, {
      id: "f-1",
      role: "user",
      content: "try it the other way",
      createdAt: later(1),
    })
    useChatStore.getState().addMessage(forkId, {
      id: "f-2",
      role: "assistant",
      content: "The other way works.",
      turnId: "turn-1",
      createdAt: later(2),
    })

    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/merge-back", threadId: forkId })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toBe("")
    expect(result?.threadId).toBe(sourceId)
    expect(useChatStore.getState().activeThreadId).toBe(sourceId)
    const [handBack] = useMessageQueueStore.getState().messages
    expect(handBack?.threadId).toBe(sourceId)
    // The fork's own answer, not the parent's copied one.
    expect(
      handBack?.payload.text.trimEnd().endsWith("The other way works.")
    ).toBe(true)
  })
})
