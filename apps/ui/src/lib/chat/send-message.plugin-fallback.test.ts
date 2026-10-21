import { beforeEach, describe, expect, it, vi } from "vitest"

// A provider plugin's turn: `/chat/persist-user` runs the hooks and records
// the message; when the plugin then fails, the same message goes through
// `/chat/send` with the token persist-user returned, so the backend does not
// run the hooks a second time.

const mocks = vi.hoisted(() => ({
  postChatPersistUser: vi.fn(),
  postChatSend: vi.fn(),
  pluginSend: vi.fn(),
}))

vi.mock("@/services/backend/chatApi", () => ({
  postChatGoal: vi.fn(),
  postChatInterrupt: vi.fn(),
  postChatPersistUser: mocks.postChatPersistUser,
  postChatSend: mocks.postChatSend,
  loadThreadActivities: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue("Title"),
}))
vi.mock("@/services/backend/autonomyApi", () => ({
  postChatAutonomyStart: vi.fn(),
  postChatAutonomyResume: vi.fn(),
  postChatAutonomyPause: vi.fn(),
  postChatAutonomyStop: vi.fn(),
  postChatAutonomyTask: vi.fn(),
}))
vi.mock("@/services/backend/coreApi", () => ({
  upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
  saveThread: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  deleteThreadDb: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadMessage: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({ providers: {} }),
}))
vi.mock("@/services/ipc-facade", () => ({
  getElectronApi: () => ({ pluginSend: mocks.pluginSend }),
}))
vi.mock("@/lib/plugin-store", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: [
        {
          enabled: true,
          config: {},
          manifest: {
            id: "my-plugin",
            name: "My plugin",
            type: "provider",
            models: [{ id: "plugin-model" }],
          },
        },
      ],
    }),
  },
}))
vi.mock("@/lib/checkpoint-store", () => ({
  autoCheckpointFromToolCalls: vi.fn().mockResolvedValue(undefined),
  useCheckpointStore: {
    getState: () => ({ clearCheckpointsForThread: vi.fn() }),
  },
}))

import { useChatStore } from "@/lib/chat-store"
import { sendChatMessage } from "./send-message"

const send = () =>
  sendChatMessage(
    "chat",
    "Plan the change",
    "plugin-model",
    "my-plugin",
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
      id: "message-1",
      content: "Plan the change",
      createdAt: "2026-10-07T10:00:00.000Z",
    }
  )

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.postChatSend.mockResolvedValue({ status: "streaming" })
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
    settingsByThread: {},
  })
})

describe("a provider plugin's turn", () => {
  it("is not sent again when the plugin takes it", async () => {
    mocks.postChatPersistUser.mockResolvedValue({
      persisted: true,
      systemInstruction: "Prepared.",
      preparedTurnToken: "token-1",
    })
    mocks.pluginSend.mockResolvedValue({ result: null })
    await send()
    expect(mocks.pluginSend).toHaveBeenCalledWith(
      "my-plugin",
      "sendMessage",
      expect.objectContaining({ systemInstruction: "Prepared." })
    )
    expect(mocks.postChatSend).not.toHaveBeenCalled()
  })

  it("falls back to the backend with the token, so the hooks do not run twice", async () => {
    mocks.postChatPersistUser.mockResolvedValue({
      persisted: true,
      systemInstruction: "Prepared.",
      preparedTurnToken: "token-1",
    })
    mocks.pluginSend.mockRejectedValue(new Error("plugin crashed"))
    await send()
    expect(mocks.postChatSend).toHaveBeenCalledTimes(1)
    expect(mocks.postChatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "chat",
        userMessageId: "message-1",
        prepareTurn: true,
        preparedTurnToken: "token-1",
      })
    )
  })

  it("falls back without a token when the backend gave none", async () => {
    mocks.postChatPersistUser.mockResolvedValue({ persisted: true })
    mocks.pluginSend.mockRejectedValue(new Error("plugin crashed"))
    await send()
    expect(mocks.postChatSend).toHaveBeenCalledTimes(1)
    expect(mocks.postChatSend.mock.calls[0]![0]).not.toHaveProperty(
      "preparedTurnToken"
    )
  })
})
