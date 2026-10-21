import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  state: {
    hydrateThreadMessages: vi.fn(async () => undefined),
    threads: [] as Array<Record<string, unknown>>,
    addMessage: vi.fn(),
  },
  decision: vi.fn(),
  compact: vi.fn(),
}))

vi.mock("@/lib/chat-store", () => ({
  useChatStore: { getState: () => mocks.state },
}))
vi.mock("@/lib/thread-compaction", () => ({
  buildThreadCompactionOutput: mocks.compact,
}))
vi.mock("@/services/backend/chatApi", () => ({
  getAutoCompactionDecision: mocks.decision,
}))
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import {
  compactThreadAutomaticallyBeforeTurn,
  parseContextTokenLabel,
  selectedModelLimits,
} from "./auto-thread-compaction"

describe("automatic thread compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.threads = [
      {
        id: "thread-1",
        usage: { usedTokens: 180_000, maxTokens: 200_000 },
      },
    ]
    mocks.decision.mockResolvedValue({
      shouldCompact: false,
      reason: "below-threshold",
      precondition: {
        compactionGeneration: 0,
        lastMessageId: "assistant-1",
      },
    })
    mocks.compact.mockResolvedValue({
      content: "# Compacted Session Context\n\nSummary",
      messageId: "checkpoint-1",
      createdAt: "2026-07-24T05:00:01.000Z",
      generation: 1,
    })
  })

  it("does nothing when the backend decision stays below threshold", async () => {
    await expect(
      compactThreadAutomaticallyBeforeTurn({
        threadId: "thread-1",
        incomingContent: "continue",
        runtimePath: "C:/repo",
        selectedProvider: undefined,
        selectedModel: "model",
        thinkingMode: null,
      })
    ).resolves.toEqual({
      compacted: false,
      reason: "below-threshold",
    })

    expect(mocks.compact).not.toHaveBeenCalled()
    expect(mocks.state.addMessage).not.toHaveBeenCalled()
  })

  it("commits through the existing bounded compacter before adding the next turn", async () => {
    mocks.decision.mockResolvedValue({
      shouldCompact: true,
      reason: "threshold-reached",
      precondition: {
        compactionGeneration: 0,
        lastMessageId: "assistant-1",
      },
    })

    await expect(
      compactThreadAutomaticallyBeforeTurn({
        threadId: "thread-1",
        incomingContent: "continue",
        runtimePath: "C:/repo",
        selectedProvider: undefined,
        selectedModel: "model",
        thinkingMode: "high",
      })
    ).resolves.toMatchObject({
      compacted: true,
      reason: "threshold-reached",
      generation: 1,
    })

    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "automatic",
        autoCompactionPrecondition: {
          compactionGeneration: 0,
          lastMessageId: "assistant-1",
        },
      })
    )
    expect(mocks.state.addMessage).toHaveBeenCalledTimes(2)
    expect(mocks.state.addMessage).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({
        id: "checkpoint-1",
        compactedContext: true,
        compactionGeneration: 1,
      }),
      { persist: false }
    )
  })

  it("continues the user's turn when summary or rotation does not commit", async () => {
    mocks.decision.mockResolvedValue({
      shouldCompact: true,
      reason: "threshold-reached",
      precondition: {
        compactionGeneration: 0,
        lastMessageId: "assistant-1",
      },
    })
    mocks.compact.mockResolvedValue({
      content: "# Compact Session\n\n> Failed",
    })

    await expect(
      compactThreadAutomaticallyBeforeTurn({
        threadId: "thread-1",
        incomingContent: "continue",
        selectedProvider: undefined,
        selectedModel: "model",
        thinkingMode: null,
      })
    ).resolves.toEqual({
      compacted: false,
      reason: "compaction-not-committed",
    })
    expect(mocks.state.addMessage).not.toHaveBeenCalled()
  })
})

describe("automatic compaction model limits", () => {
  it("parses compact and formatted context labels", () => {
    expect(parseContextTokenLabel("1M")).toBe(1_000_000)
    expect(parseContextTokenLabel("256K")).toBe(256_000)
    expect(parseContextTokenLabel("128,000")).toBe(128_000)
    expect(parseContextTokenLabel("project")).toBeUndefined()
  })

  it("prefers typed provider catalog limits", () => {
    expect(
      selectedModelLimits(
        {
          id: "provider",
          name: "Provider",
          logo: "",
          models: [
            {
              id: "model",
              name: "Model",
              context: "200K",
              tier: "Test",
              catalog: {
                limit: {
                  context: 300_000,
                  input: 280_000,
                  output: 20_000,
                },
              },
            },
          ],
        },
        "model"
      )
    ).toEqual({
      contextTokens: 300_000,
      inputTokens: 280_000,
      outputTokens: 20_000,
    })
  })
})
