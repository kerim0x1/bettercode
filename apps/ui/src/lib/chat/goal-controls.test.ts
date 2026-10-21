import { describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  set: vi.fn(),
  revision: 0,
}))
vi.mock("@/services/backend/contracts", () => ({ invokeContract: mock.invoke }))
vi.mock("@/lib/chat-store", () => ({
  useChatStore: {
    getState: () => ({
      getThreadSettings: () => ({ goalRevision: mock.revision }),
      setThreadSetting: mock.set,
    }),
  },
}))
import { sendGoalControl } from "./send-message"

describe("goal controls", () => {
  it("routes pause through the goal contract without a provider launch", async () => {
    mock.set.mockClear()
    const goal = { objective: "Task", status: "paused" }
    mock.invoke.mockResolvedValueOnce({ goal })
    await sendGoalControl("origin-thread", "/goal pause", "selected-model")
    expect(mock.invoke).toHaveBeenLastCalledWith("chatGoal", {
      body: {
        threadId: "origin-thread",
        message: "/goal pause",
        modelId: "selected-model",
      },
    })
    expect(mock.set).toHaveBeenCalledWith("origin-thread", "goal", goal)
  })

  it("does not overwrite a newer live goal update with a slow control response", async () => {
    mock.set.mockClear()
    let respond!: (result: unknown) => void
    let started!: () => void
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    mock.invoke.mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        respond = resolve
      })
    })
    const sending = sendGoalControl(
      "origin-thread",
      "/goal pause",
      "selected-model"
    )
    await pending
    mock.revision++
    respond({ goal: { objective: "Old task", status: "paused" } })
    await sending
    expect(mock.set).not.toHaveBeenCalled()
  })
})
