import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerThreadsRoutes as registerThreadsRoutesUnfilled } from "./threads"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerThreadsRoutes = withInertStateArgument(
  registerThreadsRoutesUnfilled,
  1
)

describe("thread model switch activities", () => {
  it("persists a model switch as a thread timeline activity", async () => {
    const upsert = vi.fn()
    const app = new Hono()
    registerThreadsRoutes(app, {
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request(
      "/threads/thread-1/activities/model-switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          activityId: "switch-1",
          fromModelId: "gpt-5.6-sol",
          toModelId: "gpt-5.6-luna",
          createdAt: "2026-07-23T20:30:00.000Z",
        }),
      }
    )

    expect(response.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      activity_id: "switch-1",
      thread_id: "thread-1",
      turn_id: null,
      provider_instance_id: null,
      kind: "session.model.switched",
      tone: "info",
      summary: "Model switched from gpt-5.6-sol to gpt-5.6-luna.",
      payload: {
        fromModelId: "gpt-5.6-sol",
        toModelId: "gpt-5.6-luna",
      },
      sequence: null,
      created_at: "2026-07-23T20:30:00.000Z",
    })
    expect(await response.json()).toMatchObject({
      id: "switch-1",
      threadId: "thread-1",
      kind: "session.model.switched",
    })
  })

  it("rejects no-op model switches", async () => {
    const upsert = vi.fn()
    const app = new Hono()
    registerThreadsRoutes(app, {
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request(
      "/threads/thread-1/activities/model-switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          activityId: "switch-1",
          fromModelId: "same-model",
          toModelId: "same-model",
          createdAt: "2026-07-23T20:30:00.000Z",
        }),
      }
    )

    expect(response.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })
})
