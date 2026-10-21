import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the named exports chat-store.ts imports from the backend coreApi and
// chatApi modules. Add an entry here when the chat store adds a backend call:
// historically a missing mock entry (upsertThreadMeta) silently threw
// "No 'X' export is defined on the … mock" deep inside createThread().
vi.mock("@/services/backend/coreApi", () => ({
  upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  deleteThreadDb: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  // Legacy names retained in case transitively imported by another module
  // the test pulls in:
  saveThread: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/services/backend/chatApi", () => ({
  loadThreadActivities: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue("AI Title"),
}))

const checkpointFns = vi.hoisted(() => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  captureTurnCheckpointStart: vi.fn().mockResolvedValue(null),
  captureTurnCheckpointComplete: vi.fn().mockResolvedValue(null),
  recordGitCheckpoint: vi.fn().mockReturnValue("cp-1"),
  discardTurnCheckpoint: vi.fn(),
}))

vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: checkpointFns.autoCheckpointFromToolCalls,
  useCheckpointStore: {
    getState: () => checkpointFns,
  },
}))

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: {
    getState: () => ({
      tabs: [],
      reloadFromAi: vi.fn(),
    }),
  },
}))

// Provide crypto.randomUUID in Node
if (typeof globalThis.crypto === "undefined") {
  let counter = 0
  ;(globalThis as unknown as Record<string, unknown>).crypto = {
    randomUUID: () => `test-uuid-${++counter}`,
  }
}

// Provide minimal window for provider-events (dispatchEvent, etc.)
if (typeof globalThis.window === "undefined") {
  ;(globalThis as unknown as Record<string, unknown>).window = {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    CustomEvent: class CustomEvent {
      type: string
      detail: unknown
      constructor(type: string, opts?: { detail?: unknown }) {
        this.type = type
        this.detail = opts?.detail
      }
    },
  }
}
// Ensure CustomEvent is global
if (typeof globalThis.CustomEvent === "undefined") {
  ;(globalThis as unknown as Record<string, unknown>).CustomEvent = (
    window as unknown as { CustomEvent: unknown }
  ).CustomEvent
}

import { useChatStore } from "@/lib/chat-store"
import { parseBetterC0dePlanJson } from "@/lib/plan-content"
import {
  handleProviderEvent,
  type ProviderEventCallbacks,
} from "@/lib/provider-events"
import { PROVIDER_METADATA_CHANGED_EVENT } from "@/lib/provider-metadata-events"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let threadId: string

function resetStore() {
  useChatStore.setState({
    threads: [],
    activeThreadId: null,
    streamingByThread: {},
    activitiesByThread: {},
    activitiesLoadedByThread: {},
    messagesLoadedByThread: {},
    lruOrder: [],
    draftsByThread: {},
    lastUsage: null,
    autonomyByThread: {},
  })
}

function setupThread(): string {
  const id = useChatStore.getState().createThread("Test", "proj", "/proj")
  useChatStore.getState().setActiveThread(id)
  return id
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provider-events: handleProviderEvent", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    vi.useFakeTimers()
    threadId = setupThread()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([undefined, { message: "Tool not available" }])(
    "keeps canonical failed tools failed when the error is %j",
    (error) => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "failed-tool",
        tool_name: "Bash",
        input: { command: "npm test" },
      })
      handleProviderEvent(threadId, "tool.failed", {
        toolId: "failed-tool",
        toolName: "Bash",
        error,
      })
      expect(
        useChatStore.getState().streamingByThread[threadId]?.streamingTools
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "failed-tool",
            state: "output-error",
            error: error ? "Tool not available" : "Tool failed",
          }),
        ])
      )
    }
  )

  it("leaves composer plan mode after an interactive approval from any client", () => {
    useChatStore.getState().setThreadSetting(threadId, "chatMode", "plan")
    handleProviderEvent(threadId, "plan_approval_resolved", {
      requestId: "plan",
      decision: "deny",
    })
    expect(useChatStore.getState().settingsByThread[threadId]?.chatMode).toBe(
      "plan"
    )
    handleProviderEvent(threadId, "plan_approval_resolved", {
      requestId: "plan",
      decision: "approve",
    })
    expect(useChatStore.getState().settingsByThread[threadId]?.chatMode).toBe(
      "agent"
    )
  })

  it.each([true, false])(
    "recognizes hook and task lifecycle events without unhandled debug output (projection=%s)",
    (projectActivities) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
      const events = [
        "hook.started",
        "hook.progress",
        "hook.completed",
        "task.started",
        "task.progress",
        "task.completed",
      ]
      try {
        for (const type of events)
          handleProviderEvent(
            threadId,
            type,
            {
              providerKind: "claude",
              providerInstanceId: "claude",
              hookId: "hook-1",
              hookName: "SessionStart:resume",
              taskId: "task-1",
              taskType: "local_bash",
              outcome: "success",
              status: "completed",
              output: "Hook warning remains inspectable",
              summary: "Preview server ready",
            },
            { projectActivities }
          )
        expect(debug).not.toHaveBeenCalled()
        const activities =
          useChatStore.getState().activitiesByThread[threadId] ?? []
        expect(activities.map((activity) => activity.kind)).toEqual(
          projectActivities ? events : []
        )
        if (projectActivities)
          expect(
            activities.find((activity) => activity.kind === "hook.completed")
          ).toMatchObject({
            payload: { output: "Hook warning remains inspectable" },
          })
        handleProviderEvent(threadId, "unknown.future.event", {})
        expect(debug).toHaveBeenCalledWith(
          "[BetterC0de] unhandled event: unknown.future.event",
          expect.any(Object)
        )
      } finally {
        debug.mockRestore()
      }
    }
  )

  // -----------------------------------------------------------------------
  // 1. content_delta
  // -----------------------------------------------------------------------
  describe("content_delta", () => {
    it("appends delta to streaming text", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "Hello" })
      handleProviderEvent(threadId, "content_delta", { delta: " World" })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("Hello World")
      expect(stream.isStreaming).toBe(true)
    })

    it("ignores when delta is absent", () => {
      handleProviderEvent(threadId, "content_delta", {})
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("handles empty string delta", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "" })
      // Empty string is falsy so it should be ignored by the if-guard
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })
  })

  describe("content.delta compatibility", () => {
    it("routes assistant text deltas into streaming text", () => {
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        textDelta: "Hello",
      })
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        delta: " Codex",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("Hello Codex")
      expect(stream.reasoningText).toBe("")
      expect(stream.isStreaming).toBe(true)
    })

    it("routes reasoning deltas into reasoning text", () => {
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "reasoning_summary_text",
        textDelta: "Checking",
      })
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "reasoning_text",
        delta: " paths",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.reasoningText).toBe("Checking paths")
      expect(stream.streamingText).toBe("")
      expect(stream.isReasoning).toBe(true)
    })

    it("routes canonical payload-shaped content deltas", () => {
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-1",
        payload: {
          streamKind: "assistant_text",
          delta: "Nested",
          contentIndex: 0,
        },
      })
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-1",
        payload: {
          streamKind: "reasoning_text",
          delta: "Reason",
          summaryIndex: 0,
        },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("Nested")
      expect(stream.reasoningText).toBe("Reason")
      expect(stream.activeTurnId).toBe("turn-1")
    })

    it("finalizes turn completion events", () => {
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        delta: "Final answer",
      })
      handleProviderEvent(threadId, "turn.completed", {})
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const assistantMsg = thread!.messages.find((m) => m.role === "assistant")
      expect(assistantMsg!.content).toBe("Final answer")
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it.each(["assistant_message", "agentMessage"])(
      "finalizes assistant text when a canonical %s item completes",
      (itemType) => {
        handleProviderEvent(threadId, "turn.started", { turnId: "turn-item" })
        handleProviderEvent(threadId, "content.delta", {
          turnId: "turn-item",
          itemId: "item-answer",
          streamKind: "assistant_text",
          delta: "Buffered answer",
        })
        handleProviderEvent(threadId, "item.completed", {
          turnId: "turn-item",
          itemId: "item-answer",
          payload: {
            itemType,
            status: "completed",
          },
        })

        const assistantMessages =
          useChatStore
            .getState()
            .threads.find((thread) => thread.id === threadId)
            ?.messages.filter((message) => message.role === "assistant") ?? []

        expect(assistantMessages).toHaveLength(1)
        expect(assistantMessages[0]).toMatchObject({
          content: "Buffered answer",
          turnId: "turn-item",
        })
        expect(
          useChatStore.getState().streamingByThread[threadId]
        ).toMatchObject({ isStreaming: true })
      }
    )

    it("uses assistant item detail when no text delta was streamed", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-detail" })
      handleProviderEvent(threadId, "item.completed", {
        turnId: "turn-detail",
        itemId: "item-detail",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Final detail",
        },
      })

      const assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []

      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]).toMatchObject({
        content: "Final detail",
        turnId: "turn-detail",
      })
    })

    it("normalizes legacy item_completed assistant completions", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-legacy" })
      handleProviderEvent(threadId, "item_completed", {
        turn_id: "turn-legacy",
        itemId: "item-legacy",
        itemType: "assistant_message",
        status: "completed",
        detail: "Legacy bridge detail",
      })

      const assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []

      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]).toMatchObject({
        content: "Legacy bridge detail",
        turnId: "turn-legacy",
      })
    })

    it("does not duplicate assistant output when item completion is followed by turn completion", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-dedup" })
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-dedup",
        itemId: "item-dedup",
        streamKind: "assistant_text",
        delta: "Done",
      })
      handleProviderEvent(threadId, "item.completed", {
        turnId: "turn-dedup",
        itemId: "item-dedup",
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      })
      handleProviderEvent(threadId, "turn.completed", {
        turnId: "turn-dedup",
        payload: { state: "completed" },
      })

      const assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []

      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0].content).toBe("Done")
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("keeps the turn busy between commentary, tools and the final answer", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "busy-turn" })
      handleProviderEvent(threadId, "item.completed", {
        turnId: "busy-turn",
        itemType: "assistant_message",
        detail: "Checking the project",
      })
      expect(useChatStore.getState().streamingByThread[threadId]).toMatchObject(
        {
          isStreaming: true,
          activeTurnId: "busy-turn",
        }
      )
      handleProviderEvent(threadId, "tool.started", {
        turnId: "busy-turn",
        toolId: "read",
        toolName: "shell",
      })
      handleProviderEvent(threadId, "tool.completed", {
        turnId: "busy-turn",
        toolId: "read",
        output: "read done",
      })
      expect(
        useChatStore.getState().streamingByThread[threadId]?.isStreaming
      ).toBe(true)
      handleProviderEvent(threadId, "content.delta", {
        turnId: "busy-turn",
        streamKind: "assistant_text",
        delta: "Finished",
      })
      handleProviderEvent(threadId, "item.completed", {
        turnId: "busy-turn",
        itemType: "assistant_message",
      })
      expect(
        useChatStore.getState().streamingByThread[threadId]?.isStreaming
      ).toBe(true)
      handleProviderEvent(threadId, "turn.completed", { turnId: "busy-turn" })
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
      expect(
        useChatStore
          .getState()
          .threads.find((t) => t.id === threadId)
          ?.messages.some((m) => m.content.startsWith("Error:"))
      ).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // 2. content_replace
  // -----------------------------------------------------------------------
  describe("content_replace", () => {
    it("replaces streaming text entirely", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "old" })
      handleProviderEvent(threadId, "content_replace", {
        text: "replaced text",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("replaced text")
      expect(stream.isStreaming).toBe(true)
      expect(stream.isReasoning).toBe(false)
    })

    it("ignores when text is absent", () => {
      handleProviderEvent(threadId, "content_replace", {})
      // No existing state yet, so nothing changes
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 3. reasoning_delta
  // -----------------------------------------------------------------------
  describe("reasoning_delta", () => {
    it("appends to reasoning text", () => {
      handleProviderEvent(threadId, "reasoning_delta", { delta: "Think" })
      handleProviderEvent(threadId, "reasoning_delta", { delta: "ing" })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.reasoningText).toBe("Thinking")
      expect(stream.isReasoning).toBe(true)
    })

    it("ignores absent delta", () => {
      handleProviderEvent(threadId, "reasoning_delta", {})
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 4. turn_started
  // -----------------------------------------------------------------------
  describe("turn_started", () => {
    it("sets streaming state via empty delta", () => {
      handleProviderEvent(threadId, "turn_started", {})

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream).toBeDefined()
      expect(stream.isStreaming).toBe(true)
    })

    it("leaves git checkpoint capture to the backend reactor", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-1" })

      expect(checkpointFns.captureTurnCheckpointStart).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // 5. turn_completed
  // -----------------------------------------------------------------------
  describe("turn_completed", () => {
    it("does not confuse a completed Claude turn with an achieved goal", () => {
      const goal = {
        objective: "Finish all migration steps",
        status: "active" as const,
        startedAt: 100,
        updatedAt: 100,
        providerKind: "claude",
      }
      useChatStore.getState().setThreadSetting(threadId, "goal", goal)
      handleProviderEvent(threadId, "turn_completed", {})
      expect(useChatStore.getState().getThreadSettings(threadId).goal).toEqual(
        goal
      )
      handleProviderEvent(threadId, "thread.metadata.updated", {
        providerKind: "claude",
        metadata: { goal: { objective: goal.objective, status: "complete" } },
      })
      expect(
        useChatStore.getState().getThreadSettings(threadId).goal?.status
      ).toBe("achieved")
    })
    it("finalizes stream and creates assistant message", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "Final answer" })
      handleProviderEvent(threadId, "turn_completed", {})
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const msgs = thread!.messages
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      const assistantMsg = msgs.find((m) => m.role === "assistant")
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.content).toBe("Final answer")
    })

    it("does not duplicate backend checkpoint completion work in the renderer", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-2" })
      handleProviderEvent(threadId, "content_delta", {
        delta: "Changed files",
      })
      handleProviderEvent(threadId, "turn.completed", { turnId: "turn-2" })

      const assistantMsg = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)!
        .messages.find((m) => m.role === "assistant")!

      expect(assistantMsg.content).toBe("Changed files")
      expect(checkpointFns.captureTurnCheckpointComplete).not.toHaveBeenCalled()
    })

    it("normalizes payload-shaped turn completion states", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "partial" })
      handleProviderEvent(threadId, "turn.completed", {
        turnId: "turn-3",
        payload: {
          state: "failed",
          stopReason: "error",
          errorMessage: "model failed",
        },
      })

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const assistantMsg = thread!.messages.find((m) => m.role === "assistant")
      expect(assistantMsg!.content).toContain("Error: model failed")
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("updates token usage when provided", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "x" })
      handleProviderEvent(threadId, "turn_completed", {
        input_tokens: 50,
        output_tokens: 100,
      })
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      expect(thread!.usage).toBeDefined()
      expect(thread!.usage!.inputTokens).toBe(50)
      expect(thread!.usage!.outputTokens).toBe(100)
    })

    it("clears streaming state after finalization", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "text" })
      handleProviderEvent(threadId, "turn_completed", {})

      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("surfaces an empty provider completion instead of leaving the UI blank", () => {
      handleProviderEvent(threadId, "turn_started", {})
      handleProviderEvent(threadId, "turn_completed", {})
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const assistantMsg = thread!.messages.find((m) => m.role === "assistant")
      expect(assistantMsg!.content).toContain(
        "Provider completed without returning response content"
      )
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 6. turn_error
  // -----------------------------------------------------------------------
  describe("turn_error", () => {
    it("adds error message and clears streaming", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "partial" })
      handleProviderEvent(threadId, "turn_error", {
        error: "Rate limit exceeded",
      })
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const errorMsg = thread!.messages.find(
        (m) => m.role === "assistant" && m.content.includes("Error:")
      )
      expect(errorMsg).toBeDefined()
      expect(errorMsg!.content).toContain("Rate limit exceeded")
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("uses default error message when none provided", () => {
      handleProviderEvent(threadId, "turn_error", {})
      vi.advanceTimersByTime(10)

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      const errorMsg = thread!.messages.find((m) =>
        m.content.includes("Connection error")
      )
      expect(errorMsg).toBeDefined()
    })

    it("projects canonical runtime warning and error payloads with stable event ids", () => {
      handleProviderEvent(threadId, "runtime.warning", {
        eventId: "evt-warning",
        turnId: "turn-1",
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        payload: {
          message: "Provider got slow",
          detail: { latencyMs: 1500 },
        },
      })
      handleProviderEvent(threadId, "runtime.error", {
        eventId: "evt-error",
        turnId: "turn-1",
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        payload: {
          message: "Provider failed",
          class: "transport_error",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        id: `${threadId}::runtime.warning::evt-warning`,
        turnId: "turn-1",
        providerInstanceId: "claude-main",
        kind: "runtime.warning",
        summary: "Provider got slow",
        payload: {
          provider: "claudeAgent",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          message: "Provider got slow",
          error: "Provider got slow",
          detail: { latencyMs: 1500 },
        },
      })
      expect(activities[1]).toMatchObject({
        id: `${threadId}::runtime.error::evt-error`,
        turnId: "turn-1",
        providerInstanceId: "claude-main",
        kind: "runtime.error",
        summary: "Provider failed",
        payload: {
          provider: "claudeAgent",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          message: "Provider failed",
          error: "Provider failed",
          class: "transport_error",
        },
      })
    })
  })

  // -----------------------------------------------------------------------
  // 7. tool_call
  // -----------------------------------------------------------------------
  describe("tool_call", () => {
    it("adds tool call to streaming state", () => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "tc-1",
        tool_name: "grep",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        input: { pattern: "foo" },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0].id).toBe("tc-1")
      expect(stream.streamingTools[0].name).toBe("grep")
      expect(stream.streamingTools[0].providerKind).toBe("codex")
      expect(stream.streamingTools[0].providerInstanceId).toBe("codex-work")
      expect(stream.streamingTools[0].state).toBe("input-available")

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        kind: "tool.started",
        summary: "Searched files: foo",
      })
      expect(activities[0].payload).toMatchObject({
        presentation: {
          summary: "Searched files",
          detail: "foo",
        },
      })
    })

    it("uses 'unknown' as default tool name", () => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "tc-2",
        input: {},
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0].name).toBe("unknown")
    })

    it("normalizes snake-case provider fields for streaming tools", () => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "tc-3",
        tool_name: "grep",
        provider_kind: "codex_cli",
        provider_instance_id: "codex-work",
        input: { pattern: "foo" },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0]).toMatchObject({
        providerKind: "codex",
        providerInstanceId: "codex-work",
      })
    })
  })

  // -----------------------------------------------------------------------
  // 8. tool_result
  // -----------------------------------------------------------------------
  describe("tool_result", () => {
    it("updates tool with output", () => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "tc-1",
        tool_name: "read",
        input: { path: "/f" },
      })
      handleProviderEvent(threadId, "tool_result", {
        tool_id: "tc-1",
        providerInstanceId: "codex-work",
        output: "file contents here",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0].output).toBe("file contents here")
      expect(stream.streamingTools[0].providerInstanceId).toBe("codex-work")
      expect(stream.streamingTools[0].state).toBe("output-available")
    })
  })

  // -----------------------------------------------------------------------
  // 9. token_usage
  // -----------------------------------------------------------------------
  describe("token_usage", () => {
    it("updates last usage on the thread", () => {
      handleProviderEvent(threadId, "token_usage", {
        usage: {
          inputTokens: 42,
          outputTokens: 99,
          totalCostUsd: 0.0042,
          cacheReadTokens: 12,
        },
      })

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      expect(thread!.usage).toBeDefined()
      expect(thread!.usage!.inputTokens).toBe(42)
      expect(thread!.usage!.cacheReadTokens).toBe(12)
      expect(thread!.usage!.totalCostUsd).toBe(0.0042)
    })

    it("ignores when usage payload is missing", () => {
      handleProviderEvent(threadId, "token_usage", {})

      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      expect(thread!.usage).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 10. tool_approval_requested
  // -----------------------------------------------------------------------
  describe("tool_approval_requested", () => {
    it("stores a pending approval activity instead of auto-responding", () => {
      const respondToolApproval = vi.fn()
      const callbacks: ProviderEventCallbacks = { respondToolApproval }

      handleProviderEvent(
        threadId,
        "tool_approval_requested",
        {
          requestId: "req-1",
          pluginId: "my-plugin",
          providerKind: "claude",
          tool: "bash",
          input: { command: "ls" },
        },
        callbacks
      )

      expect(respondToolApproval).not.toHaveBeenCalled()
      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities).toHaveLength(1)
      expect(activities[0]).toMatchObject({
        kind: "approval.requested",
        tone: "approval",
        summary: "Approval required for bash",
      })
      expect(activities[0].payload).toMatchObject({
        requestId: "req-1",
        pluginId: "my-plugin",
        providerKind: "claude",
        toolName: "bash",
        requestKind: "command",
      })
    })

    it("does nothing without a callback", () => {
      // Should not throw
      expect(() =>
        handleProviderEvent(threadId, "tool_approval_requested", {
          requestId: "req-1",
        })
      ).not.toThrow()
    })

    it("does nothing without a requestId", () => {
      const respondToolApproval = vi.fn()
      handleProviderEvent(
        threadId,
        "tool_approval_requested",
        { tool: "bash" },
        { respondToolApproval }
      )

      expect(respondToolApproval).not.toHaveBeenCalled()
    })

    it("finalizes assistant text at approval boundaries and starts a new segment", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-approval" })
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-approval",
        streamKind: "assistant_text",
        delta: "first half",
      })
      handleProviderEvent(threadId, "request.opened", {
        requestId: "req-approval",
        turnId: "turn-approval",
        providerKind: "codex",
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      })

      let assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []

      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]).toMatchObject({
        content: "first half",
        turnId: "turn-approval",
      })
      expect(useChatStore.getState().streamingByThread[threadId]).toMatchObject(
        { isStreaming: true }
      )

      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-approval",
        streamKind: "assistant_text",
        delta: " second half",
      })
      handleProviderEvent(threadId, "turn.completed", {
        turnId: "turn-approval",
      })

      assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []

      expect(assistantMessages).toHaveLength(2)
      expect(assistantMessages[1]).toMatchObject({
        content: " second half",
        turnId: "turn-approval",
      })
    })

    it("drops whitespace-only assistant text at approval boundaries", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-blank" })
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-blank",
        streamKind: "assistant_text",
        delta: "\n\n  ",
      })
      handleProviderEvent(threadId, "request.opened", {
        requestId: "req-blank",
        turnId: "turn-blank",
        providerKind: "codex",
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      })

      const assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []
      const activities = useChatStore.getState().activitiesByThread[threadId]

      expect(assistantMessages).toHaveLength(0)
      expect(
        activities?.some((activity) => activity.kind === "approval.requested")
      ).toBe(true)
      expect(useChatStore.getState().streamingByThread[threadId]).toMatchObject(
        { isStreaming: true }
      )
    })
  })

  // -----------------------------------------------------------------------
  // 11. user_input_requested
  // -----------------------------------------------------------------------
  describe("user_input_requested", () => {
    it("finalizes assistant text before rendering provider questions", () => {
      handleProviderEvent(threadId, "turn.started", { turnId: "turn-question" })
      handleProviderEvent(threadId, "content.delta", {
        turnId: "turn-question",
        streamKind: "assistant_text",
        delta: "Need one detail first.",
      })
      handleProviderEvent(threadId, "user-input.requested", {
        requestId: "req-question",
        turnId: "turn-question",
        providerKind: "claude",
        payload: {
          questions: [
            {
              id: "scope",
              question: "Which scope?",
              options: ["Backend", "Frontend"],
            },
          ],
        },
      })

      const assistantMessages =
        useChatStore
          .getState()
          .threads.find((thread) => thread.id === threadId)
          ?.messages.filter((message) => message.role === "assistant") ?? []
      const stream = useChatStore.getState().streamingByThread[threadId]

      expect(assistantMessages).toHaveLength(1)
      expect(assistantMessages[0]).toMatchObject({
        content: "Need one detail first.",
        turnId: "turn-question",
      })
      expect(stream.pendingQuestions).toHaveLength(1)
      expect(stream.pendingQuestions[0]).toMatchObject({
        id: "req-question",
        text: "Which scope?",
      })
    })

    it("adds questions to thread streaming state", () => {
      handleProviderEvent(threadId, "user_input_requested", {
        requestId: "req-1",
        questions: [
          {
            question: "Which framework?",
            options: [
              { label: "React", description: "UI library" },
              { label: "Vue" },
            ],
          },
        ],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.pendingQuestions).toHaveLength(1)
      expect(stream.pendingQuestions[0].text).toBe("Which framework?")
      expect(stream.pendingQuestions[0].options).toHaveLength(2)
      expect(stream.pendingQuestions[0].options[0].label).toBe("React")
      expect(stream.pendingQuestions[0].options[0].description).toBe(
        "UI library"
      )
    })

    it("uses header as fallback when question is absent", () => {
      handleProviderEvent(threadId, "user_input_requested", {
        requestId: "req-1",
        questions: [{ header: "Select an option" }],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.pendingQuestions[0].text).toBe("Select an option")
    })

    it("uses default text when both question and header are absent", () => {
      handleProviderEvent(threadId, "user_input_requested", {
        requestId: "req-1",
        questions: [{}],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.pendingQuestions[0].text).toBe("Question")
    })

    it("handles empty questions array", () => {
      handleProviderEvent(threadId, "user_input_requested", {
        requestId: "req-1",
        questions: [],
      })

      // Either no streaming state or empty pendingQuestions
      const stream = useChatStore.getState().streamingByThread[threadId]
      if (stream) {
        expect(stream.pendingQuestions).toHaveLength(0)
      }
    })

    it("handles missing questions field", () => {
      handleProviderEvent(threadId, "user_input_requested", {
        requestId: "req-1",
      })

      // Defaults to [] so no questions added
      const stream = useChatStore.getState().streamingByThread[threadId]
      if (stream) {
        expect(stream.pendingQuestions).toHaveLength(0)
      }
    })

    it("normalizes canonical user-input.requested events", () => {
      handleProviderEvent(threadId, "user-input.requested", {
        requestId: "req-canonical",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        payload: {
          questions: [
            {
              id: "framework",
              question: "Which framework?",
              options: ["React", "Vue"],
            },
          ],
        },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(stream.pendingQuestions).toHaveLength(1)
      expect(stream.pendingQuestions[0]).toMatchObject({
        id: "req-canonical",
        text: "Which framework?",
        options: [{ label: "React" }, { label: "Vue" }],
      })
      expect(activities?.[0]).toMatchObject({
        kind: "user-input.requested",
        providerInstanceId: "claude-main",
        payload: {
          providerKind: "claude",
          providerInstanceId: "claude-main",
          requestId: "req-canonical",
        },
      })
    })

    it("normalizes canonical user-input.resolved events", () => {
      handleProviderEvent(threadId, "user-input.resolved", {
        requestId: "req-canonical",
        providerKind: "claude",
        payload: {
          answers: { framework: "React" },
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities?.[0]).toMatchObject({
        kind: "user-input.resolved",
        summary: "User input answered",
        payload: {
          requestId: "req-canonical",
          decision: "answer",
          answers: { framework: "React" },
        },
      })
    })
  })

  // -----------------------------------------------------------------------
  // 12. file_diff
  // -----------------------------------------------------------------------
  describe("file_diff", () => {
    it("adds diff to streaming state", () => {
      handleProviderEvent(threadId, "file_diff", {
        path: "src/index.ts",
        additions: 5,
        deletions: 2,
        old_text: "old code",
        new_text: "new code",
        is_new: false,
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingDiffs).toHaveLength(1)
      expect(stream.streamingDiffs[0]).toEqual({
        path: "src/index.ts",
        additions: 5,
        deletions: 2,
        oldText: "old code",
        newText: "new code",
        isNew: false,
      })
    })

    it("merges diff for the same file path", () => {
      handleProviderEvent(threadId, "file_diff", {
        path: "src/index.ts",
        additions: 3,
        deletions: 1,
        old_text: "line1",
        new_text: "line1new",
      })
      handleProviderEvent(threadId, "file_diff", {
        path: "src/index.ts",
        additions: 2,
        deletions: 1,
        old_text: "line2",
        new_text: "line2new",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingDiffs).toHaveLength(1)
      expect(stream.streamingDiffs[0].additions).toBe(5)
      expect(stream.streamingDiffs[0].deletions).toBe(2)
      expect(stream.streamingDiffs[0].oldText).toBe("line1\nline2")
      expect(stream.streamingDiffs[0].newText).toBe("line1new\nline2new")
    })

    it("keeps separate entries for different paths", () => {
      handleProviderEvent(threadId, "file_diff", {
        path: "a.ts",
        additions: 1,
        deletions: 0,
      })
      handleProviderEvent(threadId, "file_diff", {
        path: "b.ts",
        additions: 2,
        deletions: 0,
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingDiffs).toHaveLength(2)
    })

    it("handles missing path gracefully", () => {
      handleProviderEvent(threadId, "file_diff", {
        additions: 1,
        deletions: 0,
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingDiffs).toHaveLength(1)
      expect(stream.streamingDiffs[0].path).toBe("")
    })
  })

  describe("turn.diff.updated", () => {
    it("renders checkpoint reactor file summaries as streaming diffs", () => {
      handleProviderEvent(threadId, "turn.diff.updated", {
        files: [
          { path: "src/app.ts", additions: 2, deletions: 1 },
          { path: "README.md", additions: 1, deletions: 0 },
        ],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingDiffs).toEqual([
        {
          path: "src/app.ts",
          additions: 2,
          deletions: 1,
          oldText: "",
          newText: "",
          isNew: false,
        },
        {
          path: "README.md",
          additions: 1,
          deletions: 0,
          oldText: "",
          newText: "",
          isNew: false,
        },
      ])
      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.some((activity) => activity.kind === "turn.diff.updated")
      ).toBe(true)
    })

    it("uses unified diff text when files are not supplied", () => {
      handleProviderEvent(threadId, "turn.diff.updated", {
        unifiedDiff: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+next",
        ].join("\n"),
      })

      expect(
        useChatStore.getState().streamingByThread[threadId].streamingDiffs
      ).toEqual([
        {
          path: "src/app.ts",
          additions: 2,
          deletions: 1,
          oldText: "",
          newText: "",
          isNew: false,
        },
      ])
    })

    it("updates summary counts without dropping existing inline diff text", () => {
      handleProviderEvent(threadId, "file_diff", {
        path: "src/app.ts",
        additions: 1,
        deletions: 1,
        old_text: "old",
        new_text: "new",
      })
      handleProviderEvent(threadId, "turn.diff.updated", {
        files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
      })

      expect(
        useChatStore.getState().streamingByThread[threadId].streamingDiffs[0]
      ).toEqual({
        path: "src/app.ts",
        additions: 4,
        deletions: 2,
        oldText: "old",
        newText: "new",
        isNew: false,
      })
    })

    it("attaches late checkpoint diffs to the latest assistant message after streaming is complete", () => {
      useChatStore.getState().addMessage(threadId, {
        id: "assistant-late",
        role: "assistant",
        content: "done",
        createdAt: new Date().toISOString(),
      })

      handleProviderEvent(threadId, "turn.diff.updated", {
        files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
      })

      const thread = useChatStore
        .getState()
        .threads.find((item) => item.id === threadId)!
      expect(thread.messages.at(-1)?.diffs).toEqual([
        {
          path: "src/app.ts",
          additions: 2,
          deletions: 1,
          oldText: "",
          newText: "",
          isNew: false,
        },
      ])
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
    })

    it("projects checkpoint captured events into visible activities", () => {
      useChatStore.getState().addMessage(threadId, {
        id: "assistant-1",
        role: "assistant",
        content: "done",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
      })

      handleProviderEvent(threadId, "checkpoint.captured", {
        turn_id: "turn-1",
        checkpointRef: "refs/betterc0de/checkpoints/thread/turn/1",
        baseCheckpointRef: "refs/betterc0de/checkpoints/thread/turn/0",
        files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
      })

      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.find((activity) => activity.kind === "checkpoint.captured")
      ).toMatchObject({
        turnId: "turn-1",
        summary: "Checkpoint captured",
      })
      expect(checkpointFns.recordGitCheckpoint).toHaveBeenCalledWith({
        threadId,
        messageId: "assistant-1",
        projectPath: "/proj",
        checkpointRef: "refs/betterc0de/checkpoints/thread/turn/1",
        baseCheckpointRef: "refs/betterc0de/checkpoints/thread/turn/0",
        turnId: "turn-1",
        turnNumber: undefined,
        label: "After assistant turn",
        diff: undefined,
        diffFiles: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
      })
    })
  })

  // -----------------------------------------------------------------------
  // Additional events
  // -----------------------------------------------------------------------
  describe("reasoning_replace", () => {
    it("replaces reasoning text", () => {
      handleProviderEvent(threadId, "reasoning_delta", { delta: "old" })
      handleProviderEvent(threadId, "reasoning_replace", {
        text: "new reasoning",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.reasoningText).toBe("new reasoning")
      expect(stream.isReasoning).toBe(true)
    })
  })

  describe("task_list", () => {
    it("stores task list in streaming state", () => {
      handleProviderEvent(threadId, "task_list", {
        tasks: [
          { text: "Step 1", completed: false },
          { text: "Step 2", completed: true },
        ],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTasks).toHaveLength(2)
      expect(stream.streamingTasks[0].text).toBe("Step 1")
      expect(stream.streamingTasks[1].completed).toBe(true)
    })
  })

  describe("turn.plan.updated", () => {
    it("stores provider-native plan steps in streaming state", () => {
      handleProviderEvent(threadId, "turn.plan.updated", {
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Patch parser", status: "in_progress" },
        ],
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTasks).toEqual([
        { text: "Inspect files", completed: true },
        { text: "Patch parser", completed: false },
      ])
    })

    it("finalizes task-only provider plans as BetterC0de JSON content", () => {
      handleProviderEvent(threadId, "turn.plan.updated", {
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Patch parser", status: "pending" },
        ],
      })
      handleProviderEvent(threadId, "turn_completed", {})

      const thread = useChatStore
        .getState()
        .threads.find((item) => item.id === threadId)
      const latestAssistant = thread?.messages.at(-1)
      const parsed = parseBetterC0dePlanJson(latestAssistant?.content ?? "")

      expect(latestAssistant?.role).toBe("assistant")
      expect(parsed?.sections[0]?.steps.map((step) => step.text)).toEqual([
        "Inspect files",
        "Patch parser",
      ])
    })
  })

  describe("plan_completed", () => {
    it("stores legacy completed plans as proposed-plan activity without assistant text", () => {
      handleProviderEvent(threadId, "content_delta", { delta: "plan output" })
      const setPlanModalContent = vi.fn()
      handleProviderEvent(
        threadId,
        "plan_completed",
        { planMarkdown: "# Plan\n- step 1" },
        { setPlanModalContent }
      )

      expect(setPlanModalContent).not.toHaveBeenCalled()
      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.some((activity) => activity.kind === "turn.proposed.completed")
      ).toBe(true)
      expect(
        useChatStore
          .getState()
          .threads.find((item) => item.id === threadId)
          ?.messages.some((message) => message.role === "assistant")
      ).toBe(false)
    })
  })

  describe("turn.proposed.completed", () => {
    it("stores proposed plan markdown as a dedicated plan activity", () => {
      handleProviderEvent(threadId, "turn.proposed.completed", {
        planMarkdown: "# Ship it\n\n## Summary\n\nUse BetterC0de planning.",
      })

      const thread = useChatStore
        .getState()
        .threads.find((item) => item.id === threadId)
      const latestAssistant = thread?.messages.at(-1)
      const planActivity = useChatStore
        .getState()
        .activitiesByThread[
          threadId
        ]?.find((activity) => activity.kind === "turn.proposed.completed")

      expect(latestAssistant).toBeUndefined()
      expect(planActivity?.payload).toMatchObject({
        planMarkdown: "# Ship it\n\n## Summary\n\nUse BetterC0de planning.",
      })
    })

    it("upserts duplicate completed plans without a turn id by stable content key", () => {
      handleProviderEvent(threadId, "turn.proposed.completed", {
        planMarkdown: "# Ship it\n\n- step 1",
      })
      handleProviderEvent(threadId, "turn.proposed.completed", {
        planMarkdown: "# Ship it\n\n- step 1",
      })

      const planActivities =
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.filter((activity) => activity.kind === "turn.proposed.completed") ??
        []

      expect(planActivities).toHaveLength(1)
      expect(planActivities[0]?.id).toContain("turn.proposed.completed")
      expect(planActivities[0]?.payload).toMatchObject({
        planId: expect.stringMatching(/^plan:[^:]+:content:hash-/),
        planMarkdown: "# Ship it\n\n- step 1",
      })
    })

    it("uses stable plan ids for turn-scoped proposed plans", () => {
      handleProviderEvent(threadId, "turn.proposed.completed", {
        turnId: "turn-plan",
        planMarkdown: "# Plan\n\n- step 1",
      })

      const planActivity = useChatStore
        .getState()
        .activitiesByThread[
          threadId
        ]?.find((activity) => activity.kind === "turn.proposed.completed")

      expect(planActivity).toMatchObject({
        id: `${threadId}::turn.proposed.completed::plan:${threadId}:turn:turn-plan`,
        turnId: "turn-plan",
        payload: {
          planId: `plan:${threadId}:turn:turn-plan`,
          planMarkdown: "# Plan\n\n- step 1",
        },
      })
    })

    it("streams proposed plan deltas outside normal assistant text", () => {
      handleProviderEvent(threadId, "turn.proposed.delta", {
        delta: "# Plan",
      })
      handleProviderEvent(threadId, "turn.proposed.delta", {
        delta: "\n- step 1",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("")
      expect(stream.streamingPlanText).toBe("# Plan\n- step 1")
      expect(stream.isPlanStreaming).toBe(true)
    })

    it("captures streamed proposed_plan tags before raw text reaches chat", () => {
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        delta: "<pro",
      })
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        delta: "posed_plan>\n# Plan\n- step",
      })
      handleProviderEvent(threadId, "content.delta", {
        streamKind: "assistant_text",
        delta: "\n</proposed_plan>",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingText).toBe("")
      expect(stream.streamingPlanText).toContain("<proposed_plan>")
      expect(stream.isPlanStreaming).toBe(true)

      handleProviderEvent(threadId, "turn.completed", {})

      expect(
        useChatStore.getState().streamingByThread[threadId]
      ).toBeUndefined()
      expect(
        useChatStore
          .getState()
          .threads.find((item) => item.id === threadId)
          ?.messages.some((message) => message.role === "assistant")
      ).toBe(false)
      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.find((activity) => activity.kind === "turn.proposed.completed")
          ?.payload
      ).toMatchObject({ planMarkdown: "# Plan\n- step" })
    })
  })

  describe("tool_call_delta", () => {
    it("updates tool call input incrementally", () => {
      handleProviderEvent(threadId, "tool_call", {
        tool_id: "tc-1",
        tool_name: "write",
        input: { path: "/f" },
      })
      handleProviderEvent(threadId, "tool_call_delta", {
        tool_id: "tc-1",
        input: { path: "/f", content: "new content" },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(
        (stream.streamingTools[0].input as { content: string }).content
      ).toBe("new content")
    })

    it("ignores when tool_id is missing", () => {
      handleProviderEvent(threadId, "tool_call_delta", { input: {} })
      // Should not throw or create state
    })

    it("keeps one activity row per streamed output chunk and accumulates the tool output", () => {
      // Codex streams command output as per-chunk `output_delta`. The
      // transcript concatenates `output_delta` across `tool.updated` rows;
      // keying chunks by tool id replaced the row each time and left only
      // the last chunk. The streaming tool must also hold the whole output.
      handleProviderEvent(threadId, "tool_call", {
        providerKind: "codex",
        tool_id: "cmd-1",
        tool_name: "Run command",
        input: { command: "npm test" },
      })
      for (const delta of ["line 1\n", "line 2\n", "line 3\n"]) {
        handleProviderEvent(threadId, "tool_call_delta", {
          providerKind: "codex",
          tool_id: "cmd-1",
          tool_name: "Run command",
          output_delta: delta,
          streamKind: "command_output",
        })
      }

      const activities = useChatStore
        .getState()
        .activitiesByThread[
          threadId
        ].filter((activity) => activity.kind === "tool.updated")
      expect(activities).toHaveLength(3)
      expect(new Set(activities.map((activity) => activity.id)).size).toBe(3)
      expect(
        activities
          .map(
            (activity) =>
              (activity.payload as { output_delta: string }).output_delta
          )
          .join("")
      ).toBe("line 1\nline 2\nline 3\n")

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0]).toMatchObject({
        id: "cmd-1",
        output: "line 1\nline 2\nline 3\n",
      })
    })

    it("replaces one tool-keyed row when the update carries the cumulative detail", () => {
      // ACP providers send the whole output so far as `detail`, mirrored
      // into `output_delta` by the bridge; one row per call is right there.
      for (const detail of ["Searching", "Searching\nFound 3"]) {
        handleProviderEvent(threadId, "tool_call_delta", {
          providerKind: "cursor",
          tool_id: "grep-1",
          tool_name: "Grep",
          detail,
          output_delta: detail,
        })
      }
      const activities = useChatStore
        .getState()
        .activitiesByThread[
          threadId
        ].filter((activity) => activity.kind === "tool.updated")
      expect(activities).toHaveLength(1)
      expect(activities[0]).toMatchObject({
        id: `${threadId}::tool.updated::grep-1`,
        payload: { output_delta: "Searching\nFound 3" },
      })
      // The streaming card follows the same predicate: a cumulative payload
      // replaces the output. Appending it showed "SearchingSearching\nFound 3".
      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0]).toMatchObject({
        id: "grep-1",
        output: "Searching\nFound 3",
      })
      expect(stream.streamingTools[0].output).not.toContain(
        "SearchingSearching"
      )
    })

    it("replaces the streaming output for a bridged cumulative snapshot whose detail differs", () => {
      // Codex `patchUpdated` bridged: `detail` is the path list, the whole
      // patch so far is `output_delta`, and the bridge marks it `cumulative`.
      const patches = [
        "diff --git a/src/app.ts b/src/app.ts\n+one\n",
        "diff --git a/src/app.ts b/src/app.ts\n+one\n+two\n",
      ]
      for (const patch of patches) {
        handleProviderEvent(threadId, "tool_call_delta", {
          providerKind: "codex",
          tool_id: "patch-1",
          tool_name: "File change",
          detail: "src/app.ts",
          output_delta: patch,
          cumulative: true,
        })
      }
      const activities = useChatStore
        .getState()
        .activitiesByThread[
          threadId
        ].filter((activity) => activity.kind === "tool.updated")
      expect(activities).toHaveLength(1)
      expect(activities[0].id).toBe(`${threadId}::tool.updated::patch-1`)
      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0]).toMatchObject({
        id: "patch-1",
        output: patches[1],
      })
      expect(stream.streamingTools[0].output).not.toBe(patches[0] + patches[1])
    })
  })

  describe("canonical tool events", () => {
    it("stores provider-aware tool lifecycle events", () => {
      handleProviderEvent(threadId, "tool.started", {
        providerKind: "codex",
        toolId: "tool-1",
        toolName: "shell",
        input: { command: "npm test" },
        startedAt: "2026-05-11T10:00:00.000Z",
        sessionId: "session-1",
        agentId: "agent-1",
        payload: {
          taskId: "task-1",
          parentToolId: "tool-root",
        },
      })
      handleProviderEvent(threadId, "tool.delta", {
        toolId: "tool-1",
        toolName: "shell",
        delta: "running\n",
      })
      handleProviderEvent(threadId, "tool.completed", {
        toolId: "tool-1",
        toolName: "shell",
        output: "done",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0]).toMatchObject({
        id: "tool-1",
        name: "shell",
        providerKind: "codex",
        input: { command: "npm test" },
        output: "done",
        state: "output-available",
        sessionId: "session-1",
        agentId: "agent-1",
        taskId: "task-1",
        parentToolId: "tool-root",
      })
      expect(stream.streamingTools[0].outputPreview).toBe("done")
    })

    it("stores canonical item lifecycle events as tool cards", () => {
      handleProviderEvent(threadId, "item.started", {
        providerKind: "codex",
        itemId: "item-1",
        turnId: "turn-1",
        payload: {
          itemType: "command_execution",
          title: "Run tests",
          detail: "npm test",
          data: { command: "npm test" },
        },
      })
      handleProviderEvent(threadId, "item.updated", {
        itemId: "item-1",
        payload: {
          itemType: "command_execution",
          title: "Run tests",
          detail: "running",
        },
      })
      handleProviderEvent(threadId, "item.completed", {
        itemId: "item-1",
        payload: {
          itemType: "command_execution",
          title: "Run tests",
          data: { stdout: "ok" },
        },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools).toHaveLength(1)
      expect(stream.streamingTools[0]).toMatchObject({
        id: "item-1",
        name: "Run tests",
        providerKind: "codex",
        input: { command: "npm test" },
        output: { stdout: "ok" },
        state: "output-available",
        turnId: "turn-1",
      })
      expect(
        useChatStore
          .getState()
          .activitiesByThread[threadId].map((activity) => activity.kind)
      ).toEqual(
        expect.arrayContaining([
          "tool.started",
          "tool.updated",
          "tool.completed",
        ])
      )
      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ].find((activity) => activity.kind === "tool.completed")
      ).toMatchObject({
        summary: "Ran command",
        payload: {
          canonicalItemLifecycle: "completed",
        },
      })
    })

    it("uses provider driver slugs as tool-card provider metadata", () => {
      handleProviderEvent(threadId, "item.started", {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        itemId: "item-claude-1",
        payload: {
          itemType: "file_change",
          title: "Edit",
          data: { input: { file_path: "app.ts" } },
        },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0]).toMatchObject({
        id: "item-claude-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
      })
      expect(
        useChatStore.getState().activitiesByThread[threadId][0].payload
      ).toMatchObject({
        provider: "claudeAgent",
        providerKind: "claude",
        providerInstanceId: "claude-main",
      })
    })

    it("normalizes providerKind driver slugs for tool cards", () => {
      handleProviderEvent(threadId, "item.started", {
        providerKind: "claudeAgent",
        itemId: "item-claude-kind",
        payload: {
          itemType: "command_execution",
          title: "Run command",
          detail: "npm test",
        },
      })

      handleProviderEvent(threadId, "item.started", {
        providerKind: "BetterC0de",
        itemId: "item-BetterC0de",
        payload: {
          itemType: "command_execution",
          title: "Run BetterC0de command",
          detail: "npm test",
        },
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "item-claude-kind",
            providerKind: "claude",
          }),
          expect.objectContaining({
            id: "item-BetterC0de",
            providerKind: "BetterC0de",
          }),
        ])
      )
    })

    it("marks failed canonical tool events as errors", () => {
      handleProviderEvent(threadId, "tool.started", {
        providerKind: "claude",
        toolId: "tool-2",
        toolName: "Edit",
        input: { path: "a.ts" },
      })
      handleProviderEvent(threadId, "tool.failed", {
        toolId: "tool-2",
        toolName: "Edit",
        error: "denied",
      })

      const stream = useChatStore.getState().streamingByThread[threadId]
      expect(stream.streamingTools[0]).toMatchObject({
        id: "tool-2",
        name: "Edit",
        providerKind: "claude",
        error: "denied",
        state: "output-error",
      })
    })

    it("projects canonical tool denials without terminating the active turn", () => {
      handleProviderEvent(threadId, "content_delta", {
        delta: "Still working",
        turn_id: "turn-1",
      })
      handleProviderEvent(threadId, "tool.denied", {
        provider: "claudeAgent",
        providerInstanceId: "claude-main",
        eventId: "event-denied-1",
        turnId: "turn-1",
        payload: {
          toolName: "Edit",
          toolUseId: "tool-1",
          reason: "Path is outside the workspace",
          agentId: "agent-1",
        },
      })

      const state = useChatStore.getState()
      expect(state.streamingByThread[threadId]).toMatchObject({
        isStreaming: true,
        streamingText: "Still working",
        activeTurnId: "turn-1",
        streamingTools: [],
      })
      expect(state.activitiesByThread[threadId]).toEqual([
        expect.objectContaining({
          id: `${threadId}::tool.denied::event-denied-1`,
          turnId: "turn-1",
          providerInstanceId: "claude-main",
          kind: "tool.denied",
          tone: "error",
          summary: "Tool denied: Edit",
          payload: expect.objectContaining({
            providerKind: "claude",
            providerInstanceId: "claude-main",
            toolId: "tool-1",
            toolName: "Edit",
            reason: "Path is outside the workspace",
            detail: "Path is outside the workspace",
            agentId: "agent-1",
          }),
        }),
      ])
      expect(
        state.threads
          .find((thread) => thread.id === threadId)
          ?.messages.some((message) => message.role === "assistant")
      ).toBe(false)
    })
  })

  describe("task lifecycle events", () => {
    it("projects task progress into visible reasoning activities", () => {
      handleProviderEvent(threadId, "task.progress", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turnId: "turn-1",
        payload: {
          taskId: "task-1",
          description: "Scanning files",
          summary: "Found matching provider code",
          lastToolName: "grep",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        kind: "task.progress",
        tone: "info",
        summary: "Reasoning update",
        turnId: "turn-1",
        providerInstanceId: "codex-work",
        payload: {
          taskId: "task-1",
          detail: "Found matching provider code",
          lastToolName: "grep",
        },
      })
    })

    it("projects auxiliary runtime events into activities", () => {
      handleProviderEvent(threadId, "tool.progress", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        turnId: "turn-1",
        payload: {
          toolUseId: "tool-1",
          toolName: "grep",
          summary: "Searching files",
        },
      })
      handleProviderEvent(threadId, "config.warning", {
        providerKind: "codex",
        turnId: "turn-1",
        payload: {
          summary: "Invalid config key",
          details: "Ignored deprecated option",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        kind: "tool.updated",
        tone: "tool",
        summary: "Searching files",
        turnId: "turn-1",
        providerInstanceId: "codex-work",
        payload: {
          toolId: "tool-1",
          toolName: "grep",
          output_delta: "Searching files",
        },
      })
      expect(activities[1]).toMatchObject({
        kind: "config.warning",
        tone: "info",
        summary: "Invalid config key",
        payload: {
          detail: "Ignored deprecated option",
        },
      })
    })

    it("applies thread metadata name updates to the local thread title", () => {
      handleProviderEvent(threadId, "thread.metadata.updated", {
        providerKind: "codex",
        payload: {
          name: "Renamed by provider",
          metadata: { source: "provider" },
        },
      })

      expect(
        useChatStore.getState().threads.find((thread) => thread.id === threadId)
          ?.title
      ).toBe("Renamed by provider")
    })

    it("mirrors structured Codex goal metadata into the thread UI state", () => {
      handleProviderEvent(threadId, "thread.metadata.updated", {
        providerKind: "codex",
        payload: {
          metadata: {
            goal: {
              objective: "Finish the migration",
              status: "active",
              started_at: "2026-07-23T10:00:00.000Z",
              turn_count: 3,
            },
          },
        },
      })

      expect(
        useChatStore.getState().getThreadSettings(threadId).goal
      ).toMatchObject({
        objective: "Finish the migration",
        status: "active",
        startedAt: Date.parse("2026-07-23T10:00:00.000Z"),
        turns: 3,
        providerKind: "codex",
      })

      handleProviderEvent(threadId, "thread.metadata.updated", {
        providerKind: "codex",
        payload: { metadata: { goal: null } },
      })

      expect(
        useChatStore.getState().getThreadSettings(threadId).goal
      ).toBeNull()
    })

    it("normalizes canonical request approval events into activities", () => {
      handleProviderEvent(threadId, "request.opened", {
        requestId: "request-1",
        providerKind: "codex",
        payload: {
          requestType: "command_execution_approval",
          detail: "Run npm test",
          args: { command: "npm test" },
        },
      })
      handleProviderEvent(threadId, "request.resolved", {
        requestId: "request-1",
        providerKind: "codex",
        payload: {
          requestType: "command_execution_approval",
          decision: "approve",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        kind: "approval.requested",
        tone: "approval",
        summary: "Command approval requested",
        payload: {
          requestId: "request-1",
          requestKind: "command",
          requestType: "command_execution_approval",
          detail: "Run npm test",
          input: { command: "npm test" },
        },
      })
      expect(activities[1]).toMatchObject({
        kind: "approval.resolved",
        tone: "approval",
        summary: "Approval resolved",
        payload: {
          requestId: "request-1",
          requestKind: "command",
          requestType: "command_execution_approval",
          decision: "approve",
        },
      })
    })

    it("classifies dynamic tool approvals as command approvals", () => {
      handleProviderEvent(threadId, "request.opened", {
        requestId: "request-dynamic",
        providerKind: "claude",
        payload: {
          requestType: "dynamic_tool_call",
          detail: "Run dynamic tool",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities[0]).toMatchObject({
        kind: "approval.requested",
        tone: "approval",
        summary: "Command approval requested",
        payload: {
          requestId: "request-dynamic",
          requestKind: "command",
          requestType: "dynamic_tool_call",
        },
      })
    })

    it("projects session lifecycle events into activities", () => {
      handleProviderEvent(threadId, "session.started", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        payload: {
          message: "started",
        },
      })
      handleProviderEvent(threadId, "session.state.changed", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        payload: {
          state: "waiting",
          reason: "status:compacting",
        },
      })
      handleProviderEvent(threadId, "session.exited", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        payload: {
          exitKind: "graceful",
        },
      })

      const activities = useChatStore.getState().activitiesByThread[threadId]
      expect(activities.map((activity) => activity.kind)).toEqual([
        "session.started",
        "session.state.changed",
        "session.exited",
      ])
      expect(activities[0]).toMatchObject({
        summary: "Provider session started",
        providerInstanceId: "codex-work",
        payload: { detail: "started" },
      })
      expect(activities[1]).toMatchObject({
        summary: "Provider session waiting",
        payload: { detail: "status:compacting" },
      })
      expect(activities[2]).toMatchObject({
        summary: "Provider session exited",
        payload: { exitKind: "graceful" },
      })
    })

    it("projects thread, plan, and item update events into UI state", () => {
      handleProviderEvent(threadId, "thread.token-usage.updated", {
        providerKind: "codex",
        payload: {
          usage: {
            usedTokens: 126,
            maxTokens: 258400,
            inputTokens: 120,
            outputTokens: 6,
          },
        },
      })
      handleProviderEvent(threadId, "thread.state.changed", {
        payload: {
          state: "compacted",
        },
      })
      handleProviderEvent(threadId, "turn.plan.updated", {
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Inspect", status: "completed" }],
        },
      })
      handleProviderEvent(threadId, "item.updated", {
        turnId: "turn-1",
        itemId: "item-1",
        payload: {
          itemType: "command_execution",
          title: "Run tests",
          detail: "npm test",
        },
      })
      handleProviderEvent(threadId, "thread.realtime.started", {
        providerKind: "codex",
        payload: {
          realtimeSessionId: "realtime-session-1",
        },
      })
      handleProviderEvent(threadId, "thread.realtime.error", {
        providerKind: "codex",
        payload: {
          message: "Realtime failed",
        },
      })
      handleProviderEvent(threadId, "thread.realtime.audio.delta", {
        providerKind: "codex",
        payload: {
          audio: "base64-audio",
        },
      })

      const state = useChatStore.getState()
      const activities = state.activitiesByThread[threadId]
      expect(
        state.threads.find((thread) => thread.id === threadId)?.usage
      ).toMatchObject({
        usedTokens: 126,
        maxTokens: 258400,
      })
      expect(activities.map((activity) => activity.kind)).toContain(
        "context-window.updated"
      )
      expect(activities.map((activity) => activity.kind)).toContain(
        "context-compaction"
      )
      expect(activities.map((activity) => activity.kind)).toContain(
        "turn.plan.updated"
      )
      expect(
        activities.find((activity) => activity.kind === "tool.updated")
      ).toMatchObject({
        summary: "Ran command output",
        payload: {
          itemType: "command_execution",
          detail: "npm test",
        },
      })
      expect(activities.map((activity) => activity.kind)).toContain(
        "thread.realtime.started"
      )
      expect(
        activities.find((activity) => activity.kind === "thread.realtime.error")
      ).toMatchObject({
        tone: "error",
        summary: "Realtime failed",
      })
    })
  })

  describe("provider metadata events", () => {
    it("dispatches a provider metadata refresh signal and records an activity", () => {
      const dispatchSpy = vi.spyOn(window, "dispatchEvent")
      handleProviderEvent(threadId, "provider.metadata.changed", {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        metadataKind: "skills",
        summary: "Skills changed",
      })

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PROVIDER_METADATA_CHANGED_EVENT,
          detail: {
            providerKind: "codex",
            providerInstanceId: "codex-work",
            metadataKind: "skills",
            cwd: undefined,
          },
        })
      )
      expect(
        useChatStore
          .getState()
          .activitiesByThread[
            threadId
          ]?.find((activity) => activity.kind === "provider.metadata.changed")
      ).toMatchObject({
        summary: "Skills changed",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          metadataKind: "skills",
        },
      })
    })
  })

  describe("unknown event type", () => {
    it("does not throw for unknown event types", () => {
      expect(() =>
        handleProviderEvent(threadId, "some_unknown_event", { data: 123 })
      ).not.toThrow()
    })
  })
})
