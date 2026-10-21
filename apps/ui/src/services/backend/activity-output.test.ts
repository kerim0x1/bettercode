import { beforeEach, describe, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  invoke: vi.fn(),
  getConfig: vi.fn(() => ({ port: 3773, mode: "local_sidecar" })),
}))
vi.mock("@/services/backend/runtime", () => runtime)

import { loadThreadActivityOutput } from "./coreApi"

describe("loadThreadActivityOutput", () => {
  beforeEach(() => {
    runtime.invoke.mockReset()
  })

  it("reads the full output route with encoded ids and keeps 404s quiet", async () => {
    const result = {
      activityId: "thread 1::tool.completed::tool/1",
      output: "the whole log",
      truncated: false,
      bytes: 13,
    }
    runtime.invoke.mockResolvedValueOnce(result)

    await expect(
      loadThreadActivityOutput("thread 1", "thread 1::tool.completed::tool/1")
    ).resolves.toEqual(result)

    expect(runtime.invoke).toHaveBeenCalledWith(
      "/threads/thread%201/activities/thread%201%3A%3Atool.completed%3A%3Atool%2F1/output",
      expect.objectContaining({ method: "GET", silentStatuses: [404] })
    )
  })

  it("passes an abort signal through", async () => {
    runtime.invoke.mockResolvedValueOnce({
      activityId: "a",
      output: "",
      truncated: false,
      bytes: 0,
    })
    const controller = new AbortController()

    await loadThreadActivityOutput("t", "a", { signal: controller.signal })

    expect(runtime.invoke).toHaveBeenCalledWith(
      "/threads/t/activities/a/output",
      expect.objectContaining({
        method: "GET",
        silentStatuses: [404],
        signal: controller.signal,
      })
    )
  })
})
