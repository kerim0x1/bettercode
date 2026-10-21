import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerThreadsRoutes } from "./threads"

function modelSwitchBody(): Record<string, unknown> {
  return {
    activityId: "switch-1",
    fromModelId: "gpt-5.6-sol",
    toModelId: "gpt-5.6-luna",
    createdAt: "2026-07-23T20:30:00.000Z",
  }
}

describe("thread route input bounds", () => {
  it("clamps the stats window to whole days in [1, 3650]", async () => {
    const stats = vi.fn(() => ({ total: 0 }))
    const app = new Hono()
    registerThreadsRoutes(app, { threads: { stats } } as unknown as AppState)

    for (const [query, expected] of [
      ["days=0", 1],
      ["days=-5", 1],
      ["days=2.9", 2],
      ["days=99999", 3_650],
      ["days=30", 30],
      ["days=abc", undefined],
      ["", undefined],
    ] as const) {
      stats.mockClear()
      const response = await app.request(`/threads/stats?${query}`)
      expect(response.status, query).toBe(200)
      expect(stats, query).toHaveBeenCalledWith(
        expect.objectContaining({ days: expected })
      )
    }
  })

  it("refuses to re-home a model-switch activity that belongs to another thread", async () => {
    const upsert = vi.fn()
    const get = vi.fn((activityId: string) =>
      activityId === "switch-1" ? { thread_id: "thread-other" } : undefined
    )
    const app = new Hono()
    registerThreadsRoutes(app, {
      threadActivities: { upsert },
      db: { prepare: () => ({ get }) },
    } as unknown as AppState)

    const hijack = await app.request(
      "/threads/thread-1/activities/model-switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(modelSwitchBody()),
      }
    )
    expect(hijack.status).toBe(409)
    expect(await hijack.json()).toMatchObject({
      code: "activity_thread_mismatch",
    })
    expect(upsert).not.toHaveBeenCalled()

    // Same id, same thread: an idempotent re-post is fine.
    const own = await app.request(
      "/threads/thread-other/activities/model-switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(modelSwitchBody()),
      }
    )
    expect(own.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activity_id: "switch-1",
        thread_id: "thread-other",
      })
    )
  })
})
