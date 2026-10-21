import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend/coreApi", () => ({
  upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
  saveThread: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  deleteThreadDb: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadMessage: vi.fn(),
}))
vi.mock("@/services/backend/chatApi", () => ({
  loadThreadActivities: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue("AI Title"),
}))
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: {
    getState: () => ({
      deleteCheckpointsAfter: vi.fn(),
      clearCheckpointsForThread: vi.fn(),
    }),
  },
}))

import { emptyStreamState, useChatStore } from "@/lib/chat-store"
import type { ChatMessage, ChatThread } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import {
  HAND_BACK_MAX_ANSWER_CHARS,
  HAND_BACK_MAX_FILES,
  buildForkHandBack,
  forkOwnMessages,
  isUserFork,
  lastForkAnswer,
  mergeBackBlocker,
  mergeForkBack,
  resolveForkMessageReference,
} from "@/lib/thread-branching"

const FORKED_AT = "2026-10-20T12:00:00.000Z"

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content: id, createdAt, ...overrides }
}

function thread(
  id: string,
  messages: ChatMessage[],
  overrides: Partial<ChatThread> = {}
): ChatThread {
  return {
    id,
    title: id,
    projectName: "repo",
    projectPath: "/repo",
    messages,
    messageCount: messages.length,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T12:30:00.000Z",
    ...overrides,
  }
}

const parentMessages = [
  message("user-1", "user", "2026-10-20T10:00:00.000Z"),
  message("answer-1", "assistant", "2026-10-20T10:01:00.000Z", {
    turnId: "turn-1",
    diffs: [
      {
        path: "src/parent.ts",
        additions: 1,
        deletions: 0,
        oldText: "",
        newText: "",
        isNew: false,
      },
    ],
  }),
]

const forkMessages = [
  // Copies of the parent keep their original times.
  message("copy-1", "user", "2026-10-20T10:00:00.000Z"),
  message("copy-2", "assistant", "2026-10-20T10:01:00.000Z", {
    content: "Parent answer",
  }),
  message("fork-user", "user", "2026-10-20T12:05:00.000Z"),
  message("fork-answer", "assistant", "2026-10-20T12:06:00.000Z", {
    content: "Tried the other approach: it works.",
    turnId: "turn-9",
    diffs: [
      {
        path: "/repo/src/fork.ts",
        additions: 3,
        deletions: 1,
        oldText: "",
        newText: "",
        isNew: false,
      },
    ],
  }),
  message("status", "assistant", "2026-10-20T12:07:00.000Z", {
    content: "# Status\n\nAll good.",
  }),
]

function resetChat() {
  useChatStore.setState({
    threads: [
      thread("fork", forkMessages, {
        title: "Try plan B (fork)",
        parentThreadId: "parent",
        createdAt: FORKED_AT,
      }),
      thread("parent", parentMessages),
    ],
    activeThreadId: "fork",
    messagesLoadedByThread: { fork: true, parent: true },
    activitiesByThread: {},
    activitiesLoadedByThread: {},
    streamingByThread: {},
    settingsByThread: {},
    autonomyByThread: {},
  })
  useMessageQueueStore.setState({ messages: [] })
}

describe("fork helpers", () => {
  it("treats a chat with a parent as a fork, except orchestration workers", () => {
    expect(isUserFork({ parentThreadId: "parent" }, undefined)).toBe(true)
    expect(
      isUserFork({ parentThreadId: "parent" }, { orchestrationWorker: true })
    ).toBe(false)
    expect(isUserFork({ parentThreadId: null }, undefined)).toBe(false)
  })

  it("separates what the fork added from the copied history", () => {
    expect(
      forkOwnMessages({ createdAt: FORKED_AT, messages: forkMessages }).map(
        (entry) => entry.id
      )
    ).toEqual(["fork-user", "fork-answer", "status"])
  })

  it("hands back the agent's answer rather than a local command's output", () => {
    expect(lastForkAnswer(forkMessages)).toBe(
      "Tried the other approach: it works."
    )
    expect(
      lastForkAnswer([
        message("status", "assistant", FORKED_AT, { content: "Only this" }),
      ])
    ).toBe("Only this")
    expect(lastForkAnswer([message("u", "user", FORKED_AT)])).toBeNull()
  })

  it("writes a concise hand-back with the title, files and answer", () => {
    const text = buildForkHandBack({
      forkTitle: "Try plan B\n(fork)",
      answer: "Done.",
      changedFiles: ["src/fork.ts"],
    })
    expect(text).toContain('fork "Try plan B (fork)"')
    expect(text).toContain("- `src/fork.ts`")
    expect(text.trimEnd().endsWith("Done.")).toBe(true)
    expect(
      buildForkHandBack({ forkTitle: "", answer: "Done.", changedFiles: [] })
    ).toContain("The fork didn't change any files.")
  })

  it("keeps a long hand-back bounded", () => {
    const text = buildForkHandBack({
      forkTitle: "Fork",
      answer: "x".repeat(HAND_BACK_MAX_ANSWER_CHARS + 500),
      changedFiles: Array.from(
        { length: HAND_BACK_MAX_FILES + 3 },
        (_, index) => `file-${index}.ts`
      ),
    })
    expect(text).toContain("- and 3 more")
    expect(text).toContain("[The rest of this answer is in the fork.]")
    expect(text.length).toBeLessThan(HAND_BACK_MAX_ANSWER_CHARS + 2_000)
  })

  it("resolves /fork <number> the way /messages numbers the chat", () => {
    expect(resolveForkMessageReference(forkMessages, "2")).toEqual({
      messageId: "copy-2",
    })
    expect(resolveForkMessageReference(forkMessages, "9")).toEqual({
      error: "This chat has 5 messages.",
    })
    expect("error" in resolveForkMessageReference(forkMessages, "0")).toBe(true)
    expect("error" in resolveForkMessageReference(forkMessages, "last")).toBe(
      true
    )
  })
})

describe("mergeForkBack", () => {
  beforeEach(resetChat)

  it("queues the hand-back for the parent and opens it", async () => {
    const outcome = await mergeForkBack("fork")

    expect(outcome).toEqual({ parentThreadId: "parent", queued: false })
    expect(useChatStore.getState().activeThreadId).toBe("parent")
    const [queued] = useMessageQueueStore.getState().messages
    expect(queued?.threadId).toBe("parent")
    expect(queued?.payload.text).toContain("Try plan B (fork)")
    expect(queued?.payload.text).toContain("- `src/fork.ts`")
    expect(queued?.payload.text).not.toContain("src/parent.ts")
    expect(queued?.payload.text).toContain("Tried the other approach")
  })

  it("says the hand-back waits when the parent is busy", async () => {
    useChatStore.setState({
      streamingByThread: { parent: { ...emptyStreamState, isStreaming: true } },
    })
    await expect(mergeForkBack("fork")).resolves.toMatchObject({
      queued: true,
    })
  })

  it("refuses a chat that isn't a fork, or a fork that is still working", async () => {
    expect(mergeBackBlocker("parent")).toMatch(/isn't a fork/)
    await expect(mergeForkBack("parent")).rejects.toThrow(/isn't a fork/)
    useChatStore.setState({
      streamingByThread: { fork: { ...emptyStreamState, isStreaming: true } },
    })
    expect(mergeBackBlocker("fork")).toMatch(/still working/)
    expect(useMessageQueueStore.getState().messages).toEqual([])
  })
})

describe("forkThread through a message", () => {
  beforeEach(resetChat)

  it("copies the history up to and including the chosen answer", async () => {
    const forkId = await useChatStore
      .getState()
      .forkThread("parent", undefined, { throughMessageId: "user-1" })
    const fork = useChatStore
      .getState()
      .threads.find((candidate) => candidate.id === forkId)
    expect(fork?.parentThreadId).toBe("parent")
    expect(fork?.messages.map((entry) => entry.content)).toEqual(["user-1"])
    expect(useChatStore.getState().activeThreadId).toBe(forkId)
  })

  it("refuses a message that is not in the chat", async () => {
    await expect(
      useChatStore
        .getState()
        .forkThread("parent", undefined, { throughMessageId: "missing" })
    ).resolves.toBeNull()
  })
})
