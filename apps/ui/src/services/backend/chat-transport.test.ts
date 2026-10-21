import { beforeEach, describe, expect, it, vi } from "vitest"

const { invokeContract } = vi.hoisted(() => ({
  invokeContract: vi.fn(),
}))
vi.mock("./contracts", () => ({ invokeContract }))

import {
  postChatGoal,
  postChatInterrupt,
  postChatPersistUser,
  postChatSend,
} from "./chatApi"

describe("chat transport", () => {
  beforeEach(() => {
    invokeContract.mockReset().mockResolvedValue({})
  })

  it("posts a turn with the long admission timeout", async () => {
    const body = { threadId: "t1", message: "hi", modelId: "m" }
    await postChatSend(body)
    expect(invokeContract).toHaveBeenCalledWith("chatSend", {
      timeoutMs: 210_000,
      method: "POST",
      body,
    })
  })

  it("posts goal commands, plugin user messages and interrupts unchanged", async () => {
    const goal = { threadId: "t1", message: "/goal pause", modelId: "m" }
    await postChatGoal(goal)
    expect(invokeContract).toHaveBeenLastCalledWith("chatGoal", { body: goal })

    const user = { threadId: "t1", message: "hi", modelId: "m" }
    await postChatPersistUser(user)
    expect(invokeContract).toHaveBeenLastCalledWith("chatPersistUser", {
      method: "POST",
      body: user,
    })

    const stop = {
      threadId: "t1",
      providerKind: "codex",
      providerInstanceId: null,
    }
    await postChatInterrupt(stop)
    expect(invokeContract).toHaveBeenLastCalledWith("chatInterrupt", {
      method: "POST",
      body: stop,
    })
  })
})
