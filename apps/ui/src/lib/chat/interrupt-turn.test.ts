import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  postChatInterrupt: vi.fn(),
  pause: vi.fn(),
  plugins: [] as Array<{ enabled: boolean; manifest: { id: string } }>,
  bridge: undefined as { pluginSend: ReturnType<typeof vi.fn> } | undefined,
}))

vi.mock("@/services/backend/chatApi", () => ({
  postChatGoal: vi.fn(),
  postChatInterrupt: mocks.postChatInterrupt,
  postChatPersistUser: vi.fn(),
  postChatSend: vi.fn(),
}))
vi.mock("@/lib/message-queue-store", () => ({
  useMessageQueueStore: { getState: () => ({ pause: mocks.pause }) },
}))
vi.mock("@/lib/plugin-store", () => ({
  usePluginStore: { getState: () => ({ plugins: mocks.plugins }) },
}))
vi.mock("@/services/ipc-facade", () => ({
  getElectronApi: () => mocks.bridge,
}))

import { interruptTurn } from "./send-message"

describe("interruptTurn", () => {
  beforeEach(() => {
    mocks.postChatInterrupt.mockReset().mockResolvedValue({
      status: "interrupted",
    })
    mocks.pause.mockReset()
    mocks.plugins = []
    mocks.bridge = undefined
  })

  it("pauses queued follow-ups and interrupts through the backend", async () => {
    await interruptTurn("t1", "codex", "codex-1")
    expect(mocks.pause).toHaveBeenCalledWith("t1")
    expect(mocks.postChatInterrupt).toHaveBeenCalledWith({
      threadId: "t1",
      providerKind: "codex",
      providerInstanceId: "codex-1",
    })
  })

  it("routes an enabled provider plugin over the desktop bridge", async () => {
    const pluginSend = vi.fn().mockResolvedValue({ ok: true })
    mocks.bridge = { pluginSend }
    mocks.plugins = [{ enabled: true, manifest: { id: "my-provider" } }]
    await interruptTurn("t1", "my-provider")
    expect(mocks.pause).toHaveBeenCalledWith("t1")
    expect(pluginSend).toHaveBeenCalledWith("my-provider", "interrupt", {
      threadId: "t1",
    })
    expect(mocks.postChatInterrupt).not.toHaveBeenCalled()
  })

  it("falls back to the backend when no plugin matches the provider", async () => {
    const pluginSend = vi.fn()
    mocks.bridge = { pluginSend }
    mocks.plugins = [{ enabled: false, manifest: { id: "codex" } }]
    await interruptTurn("t1", "codex")
    expect(pluginSend).not.toHaveBeenCalled()
    expect(mocks.postChatInterrupt).toHaveBeenCalledWith({
      threadId: "t1",
      providerKind: "codex",
      providerInstanceId: undefined,
    })
  })
})
