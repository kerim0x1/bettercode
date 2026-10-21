import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatThread, ThreadAutonomy } from "@betterc0de/schema"

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
  generateTitle: vi.fn().mockResolvedValue("Title"),
}))
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: {
    getState: () => ({ clearCheckpointsForThread: vi.fn() }),
  },
}))

import { useChatStore } from "@/lib/chat-store"
import { handleProviderEvent } from "@/lib/provider-events"
import {
  applyAutonomyMetadata,
  mergePersistedThreadAutonomy,
} from "./autonomy-sync"

function run(overrides: Partial<ThreadAutonomy> = {}): ThreadAutonomy {
  return {
    id: "run",
    status: "working",
    tasks: [
      { id: "parser", text: "Write the parser", done: true },
      { id: "tests", text: "Test it", done: false },
    ],
    iterations: 3,
    maxIterations: 50,
    timeBudgetMin: 90,
    startedAt: 1_000,
    updatedAt: 2_000,
    stopReason: null,
    ...overrides,
  }
}

/** A push from the backend's runtime: a mutation id and no provider. */
function push(metadata: Record<string, unknown>) {
  return { metadata: { autonomyMutationId: "mutation", ...metadata } }
}

function thread(id: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    projectName: "Project",
    projectPath: "/project",
    messages: [],
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
    ...extra,
  }
}

/** The run's opening message, sent by the composer. */
const OPENING = {
  id: "opening",
  role: "user" as const,
  content: "[Autonomous Work — run started]",
  createdAt: "2026-10-07T10:00:00.000Z",
}

beforeEach(() => {
  useChatStore.setState({
    threads: [thread("chat", { messages: [OPENING] })],
    activeThreadId: "chat",
    messagesLoadedByThread: { chat: true },
    streamingByThread: {},
    autonomyByThread: {},
  })
})

describe("mirroring the backend's Autonomous Work runs", () => {
  it("takes the run from the chat's metadata pushes and drops it when it ends", () => {
    const working = run()
    handleProviderEvent(
      "chat",
      "thread.metadata.updated",
      push({ autonomy: working })
    )
    expect(useChatStore.getState().autonomyByThread).toEqual({ chat: working })

    const paused = run({ status: "paused", updatedAt: 3_000 })
    applyAutonomyMetadata("chat", {}, push({ autonomy: paused }).metadata)
    expect(useChatStore.getState().autonomyByThread.chat?.status).toBe("paused")

    applyAutonomyMetadata("chat", {}, push({ autonomy: null }).metadata)
    expect(useChatStore.getState().autonomyByThread).toEqual({})
  })

  it("never takes a provider's metadata or an unattributed value for a run", () => {
    applyAutonomyMetadata(
      "chat",
      { providerKind: "codex" },
      push({ autonomy: run() }).metadata
    )
    applyAutonomyMetadata("chat", {}, { autonomy: run() })
    applyAutonomyMetadata(
      "chat",
      {},
      push({ autonomy: { status: "working" } }).metadata
    )
    expect(useChatStore.getState().autonomyByThread).toEqual({})
  })

  it("keeps a newer state of the same run over a late older one", () => {
    useChatStore.getState().setThreadAutonomy("chat", run({ updatedAt: 5_000 }))
    applyAutonomyMetadata(
      "chat",
      {},
      push({ autonomy: run({ iterations: 1, updatedAt: 4_000 }) }).metadata
    )
    expect(useChatStore.getState().autonomyByThread.chat?.iterations).toBe(3)
    // A new run replaces the old one whatever its clock says.
    applyAutonomyMetadata(
      "chat",
      {},
      push({ autonomy: run({ id: "next", iterations: 0, updatedAt: 10 }) })
        .metadata
    )
    expect(useChatStore.getState().autonomyByThread.chat?.id).toBe("next")
  })

  it("shows the message of a turn the run started, once, before its reply", () => {
    const prompt = {
      messageId: "follow-up-1",
      content: "Continue the autonomous run for: Write the parser.",
      createdAt: "2026-10-07T10:01:00.000Z",
      modelId: "codex-model",
    }
    const update = push({ autonomy: run(), autonomyPrompt: prompt })
    handleProviderEvent("chat", "thread.metadata.updated", update)
    handleProviderEvent("chat", "thread.metadata.updated", update)
    const messages = useChatStore.getState().threads[0]!.messages
    expect(messages).toEqual([
      OPENING,
      {
        id: "follow-up-1",
        role: "user",
        content: prompt.content,
        modelId: "codex-model",
        createdAt: prompt.createdAt,
      },
    ])
    expect(
      useChatStore.getState().streamingByThread.chat?.streamingModelId
    ).toBe("codex-model")
  })

  it("leaves the message to the transcript load when the chat is not loaded", () => {
    useChatStore.setState({ messagesLoadedByThread: {} })
    applyAutonomyMetadata(
      "chat",
      {},
      push({
        autonomyPrompt: {
          messageId: "follow-up-1",
          content: "Continue.",
          createdAt: "2026-10-07T10:01:00.000Z",
        },
      }).metadata
    )
    expect(useChatStore.getState().threads[0]!.messages).toEqual([OPENING])
  })
})

describe("runs in the thread list", () => {
  it("restores the runs the backend kept, without undoing a push that arrived while loading", () => {
    const kept = run({ id: "kept" })
    const pushed = run({ id: "pushed", updatedAt: 9_000 })
    const stale = run({ id: "stale" })
    const beforeLoad = { b: stale, c: stale }
    const current = { b: stale, c: pushed }
    const merged = mergePersistedThreadAutonomy(
      current,
      [
        thread("a", { autonomy: kept }),
        thread("b"),
        thread("c", { autonomy: kept }),
      ],
      beforeLoad
    )
    // "a" restored, "b" has no run any more, "c" keeps its newer push.
    expect(merged).toEqual({ a: kept, c: pushed })
  })

  it("returns the same map when nothing changes", () => {
    const current = { a: run() }
    expect(
      mergePersistedThreadAutonomy(
        current,
        [thread("a", { autonomy: current.a })],
        current
      )
    ).toBe(current)
  })
})
