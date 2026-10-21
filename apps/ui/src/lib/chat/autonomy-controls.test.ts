import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AutonomyRunConfig, ThreadAutonomy } from "@betterc0de/schema"

const api = vi.hoisted(() => ({
  postChatAutonomyStart: vi.fn(),
  postChatAutonomyResume: vi.fn(),
  postChatAutonomyPause: vi.fn(),
  postChatAutonomyStop: vi.fn(),
  postChatAutonomyTask: vi.fn(),
  postChatSend: vi.fn(),
  upsertThreadMeta: vi.fn(),
}))

vi.mock("@/services/backend/autonomyApi", () => ({
  postChatAutonomyStart: api.postChatAutonomyStart,
  postChatAutonomyResume: api.postChatAutonomyResume,
  postChatAutonomyPause: api.postChatAutonomyPause,
  postChatAutonomyStop: api.postChatAutonomyStop,
  postChatAutonomyTask: api.postChatAutonomyTask,
}))
vi.mock("@/services/backend/coreApi", () => ({
  upsertThreadMeta: api.upsertThreadMeta,
  saveThread: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  deleteThreadDb: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadMessage: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({ providers: {} }),
}))
vi.mock("@/services/backend/chatApi", () => ({
  postChatGoal: vi.fn(),
  postChatInterrupt: vi.fn(),
  postChatPersistUser: vi.fn(),
  postChatSend: api.postChatSend,
  loadThreadActivities: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue("Title"),
}))
vi.mock("@/services/ipc-facade", () => ({ getElectronApi: () => undefined }))
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: {
    getState: () => ({ clearCheckpointsForThread: vi.fn() }),
  },
}))

import { useChatStore } from "@/lib/chat-store"
import type { UiProvider } from "@/lib/provider-types"
import {
  pauseAutonomousRun,
  resumeAutonomousRun,
  setAutonomousTaskDone,
  stopAutonomousRun,
} from "./autonomy-controls"
import { sendChatMessage } from "./send-message"

const RUN: ThreadAutonomy = {
  id: "run",
  status: "working",
  tasks: [{ id: "parser", text: "Write the parser", done: false }],
  iterations: 0,
  maxIterations: 5,
  timeBudgetMin: 0,
  startedAt: 1_000,
  updatedAt: 1_000,
  stopReason: null,
}

const CONFIG: AutonomyRunConfig = {
  tasks: [{ id: "parser", text: "Write the parser" }],
  maxIterations: 5,
  timeBudgetMin: 0,
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  api.upsertThreadMeta.mockResolvedValue(undefined)
  useChatStore.setState({
    threads: [
      {
        id: "chat",
        title: "Chat",
        projectName: "Project",
        projectPath: "",
        messages: [],
        createdAt: "2026-10-07T10:00:00.000Z",
        updatedAt: "2026-10-07T10:00:00.000Z",
      },
    ],
    activeThreadId: "chat",
    autonomyByThread: {},
    settingsByThread: {},
  })
})

describe("Autonomous Work controls", () => {
  it("mirror the run the backend answers a pause, a task change and a stop with", async () => {
    useChatStore.getState().setThreadAutonomy("chat", RUN)

    const paused = { ...RUN, status: "paused" as const, updatedAt: 2_000 }
    api.postChatAutonomyPause.mockResolvedValue({ autonomy: paused })
    await pauseAutonomousRun("chat")
    expect(api.postChatAutonomyPause).toHaveBeenCalledWith("chat")
    expect(useChatStore.getState().autonomyByThread.chat).toEqual(paused)

    const ticked = {
      ...paused,
      tasks: [{ ...RUN.tasks[0]!, done: true }],
      updatedAt: 3_000,
    }
    api.postChatAutonomyTask.mockResolvedValue({ autonomy: ticked })
    await setAutonomousTaskDone("chat", "parser", true)
    expect(api.postChatAutonomyTask).toHaveBeenCalledWith(
      "chat",
      "parser",
      true
    )
    expect(useChatStore.getState().autonomyByThread.chat?.tasks[0]?.done).toBe(
      true
    )

    api.postChatAutonomyStop.mockResolvedValue({ autonomy: null })
    await stopAutonomousRun("chat")
    expect(useChatStore.getState().autonomyByThread).toEqual({})
  })

  it("resume sends the chat's composer selection, not a message", async () => {
    api.postChatAutonomyResume.mockResolvedValue({ autonomy: RUN })
    await resumeAutonomousRun("chat", {
      provider: {
        id: "claude",
        providerKind: "claude",
        models: [],
      } as unknown as UiProvider,
      modelId: "claude-model",
      thinkingMode: null,
      chatMode: "agent",
      specialMode: null,
      permissionLevel: "allow-edits",
      contextWindow: null,
      projectPath: null,
      appMode: "agent",
    })
    expect(api.postChatAutonomyResume).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "chat",
        providerKind: "claude",
        modelId: "claude-model",
        permissionLevel: "allow-edits",
        prepareTurn: true,
      })
    )
    expect(api.postChatSend).not.toHaveBeenCalled()
    expect(useChatStore.getState().autonomyByThread.chat).toEqual(RUN)
  })
})

describe("the run's opening message", () => {
  it("starts the run in the backend instead of a plain send", async () => {
    api.postChatAutonomyStart.mockResolvedValue({
      autonomy: RUN,
      turn: { status: "streaming", turnId: "turn-1" },
    })
    const result = await sendChatMessage(
      "chat",
      "[Autonomous Work — run started]",
      "claude-model",
      "claude",
      null,
      "agent",
      null,
      null,
      "ask-on-edit",
      null,
      null,
      null,
      null,
      null,
      {
        id: "opening",
        content: "[Autonomous Work — run started]",
        createdAt: "2026-10-07T10:00:00.000Z",
      },
      null,
      "agent",
      null,
      [],
      null,
      null,
      undefined,
      { action: "start", config: CONFIG }
    )
    expect(result).toEqual({ status: "streaming", turnId: "turn-1" })
    // The chat must exist in the backend before the run is kept with it.
    expect(api.upsertThreadMeta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat" })
    )
    expect(api.postChatAutonomyStart).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "chat",
        message: "[Autonomous Work — run started]",
        providerKind: "claude",
        userMessageId: "opening",
        autonomy: CONFIG,
      })
    )
    expect(api.postChatSend).not.toHaveBeenCalled()
    expect(useChatStore.getState().autonomyByThread.chat).toEqual(RUN)
  })
})
