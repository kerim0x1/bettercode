import { beforeEach, describe, expect, it, vi } from "vitest"

const runtimeConfig = vi.hoisted(() => ({
  listRuntimeHooks: vi.fn(),
  updateRuntimeHookRun: vi.fn(),
}))
const backend = vi.hoisted(() => ({
  runShellCommandDetailed: vi.fn(),
}))

vi.mock("@/lib/runtime-config", () => runtimeConfig)
vi.mock("@/services/backend/workspaceApi", () => backend)

import { queueRuntimeHooks } from "./runtime-hooks"

// Blocking "on message send" hooks run in the backend before every message
// (apps/backend turn-preparation.ts); the renderer runs only the
// notification hooks, after the fact.

describe("notification hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeConfig.updateRuntimeHookRun.mockResolvedValue(undefined)
  })

  it("runs only the enabled hooks of the event, never a message-send hook", async () => {
    runtimeConfig.listRuntimeHooks.mockResolvedValue([
      { id: "a", event: "on_commit", command: "notify", enabled: true },
      { id: "b", event: "on_commit", command: "off", enabled: false },
      { id: "c", event: "on_message_send", command: "lint", enabled: true },
    ])
    backend.runShellCommandDetailed.mockResolvedValue({
      success: true,
      exitCode: 0,
    })

    await queueRuntimeHooks("on_commit", { cwd: "/project" })

    expect(backend.runShellCommandDetailed).toHaveBeenCalledTimes(1)
    expect(backend.runShellCommandDetailed.mock.calls[0][0]).toBe("notify")
    expect(runtimeConfig.updateRuntimeHookRun).toHaveBeenLastCalledWith(
      "a",
      "success",
      0,
      null
    )
  })

  it("records a failure and goes on with the next hook", async () => {
    runtimeConfig.listRuntimeHooks.mockResolvedValue([
      { id: "a", event: "on_commit", command: "first", enabled: true },
      { id: "b", event: "on_commit", command: "second", enabled: true },
    ])
    backend.runShellCommandDetailed
      .mockResolvedValueOnce({ success: false, exitCode: 2, stderr: "boom" })
      .mockResolvedValueOnce({ success: true, exitCode: 0 })

    await expect(
      queueRuntimeHooks("on_commit", { cwd: "/project" })
    ).resolves.toBeUndefined()

    expect(backend.runShellCommandDetailed).toHaveBeenCalledTimes(2)
    expect(runtimeConfig.updateRuntimeHookRun).toHaveBeenCalledWith(
      "a",
      "error",
      2,
      expect.any(String)
    )
  })
})
