import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  state: {
    hydrateThreadMessages: vi.fn(async () => undefined),
    threads: [] as Array<Record<string, unknown>>,
  },
  buildTranscript: vi.fn(() => "active transcript"),
  generateSummary: vi.fn(async () => ({ summary: "fresh summary" })),
  rotateSession: vi.fn(async () => ({
    rotated: true,
    generation: 2,
    messageId: "checkpoint-new",
  })),
}))

vi.mock("@/lib/chat-store", () => ({
  useChatStore: { getState: () => mocks.state },
}))
vi.mock("@/lib/claude-terminal-history", () => ({
  buildClaudeTerminalCompactionTranscript: mocks.buildTranscript,
}))
vi.mock("@/lib/native-compacter-selection", () => ({
  buildNativeThreadCompacterSelection: vi.fn(() => undefined),
}))
vi.mock("@/lib/thread-context", () => ({
  resolveThreadRuntimePath: vi.fn(() => "C:/repo"),
}))
vi.mock("@/services/backend", () => ({
  generateThreadContextSummary: mocks.generateSummary,
  rotateProviderSession: mocks.rotateSession,
}))

import { buildThreadCompactionOutput } from "./thread-compaction"

describe("buildThreadCompactionOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildTranscript.mockReturnValue("active transcript")
    mocks.generateSummary.mockResolvedValue({ summary: "fresh summary" })
    mocks.rotateSession.mockResolvedValue({
      rotated: true,
      generation: 2,
      messageId: "checkpoint-new",
    })
  })

  it("summarizes only the active context after the newest checkpoint", async () => {
    const oldMessage = {
      id: "old",
      role: "user",
      content: "obsolete context",
      createdAt: "2026-07-10T10:00:00.000Z",
    }
    const checkpoint = {
      id: "checkpoint-old",
      role: "assistant",
      content: "# Compacted Session Context\n\nPrevious summary",
      compactedContext: true,
      compactionGeneration: 1,
      createdAt: "2026-07-10T11:00:00.000Z",
    }
    const tail = {
      id: "tail",
      role: "user",
      content: "continue from here",
      createdAt: "2026-07-10T12:00:00.000Z",
    }
    mocks.state.threads = [
      {
        id: "thread-1",
        title: "Thread",
        projectPath: "C:/repo",
        messages: [oldMessage, checkpoint, tail],
      },
    ]

    await buildThreadCompactionOutput({
      threadId: "thread-1",
      selectedProvider: undefined,
      selectedModel: "model",
      thinkingMode: null,
      command: {
        messageId: "command-new",
        content: "/compact",
        createdAt: "2026-07-10T13:00:00.000Z",
      },
    })

    expect(mocks.buildTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [checkpoint, tail] })
    )
  })
})
