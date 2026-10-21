import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { isReadOnlyRemoteRequestAllowed } from "../../remote/http"
import { registerThreadsRoutes as registerThreadsRoutesUnfilled } from "./threads"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerThreadsRoutes = withInertStateArgument(
  registerThreadsRoutesUnfilled,
  1
)

// The desktop pages its transcript with `light=1` (no diff text, no inline
// attachment data) and fetches one full message when it shows a diff or an
// attachment. Other callers keep the full rows.

const MESSAGE = {
  id: "m-1",
  role: "assistant",
  content: "done",
  createdAt: "2026-01-01T00:00:00.000Z",
  sequence: 4,
}

function app(message: Record<string, unknown> | null = MESSAGE) {
  const threads = {
    listMessages: vi.fn(() => [MESSAGE]),
    getMessageView: vi.fn(() => message),
  }
  const hono = new Hono()
  registerThreadsRoutes(hono, { threads } as unknown as AppState)
  return { hono, threads }
}

describe("GET /threads/:id/messages", () => {
  it("passes the light flag only when it is asked for", async () => {
    const { hono, threads } = app()
    await hono.request("/threads/thread-1/messages?limit=100&light=1")
    expect(threads.listMessages).toHaveBeenLastCalledWith("thread-1", {
      limit: 100,
      beforeSequence: undefined,
      light: true,
    })

    await hono.request("/threads/thread-1/messages?beforeSequence=7")
    const lastOptions = threads.listMessages.mock.lastCall as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(lastOptions[1]).toEqual({ limit: undefined, beforeSequence: 7 })
    expect(Object.hasOwn(lastOptions[1], "light")).toBe(false)

    await hono.request("/threads/thread-1/messages?light=0")
    const offOptions = threads.listMessages.mock.lastCall as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(Object.hasOwn(offOptions[1], "light")).toBe(false)
  })
})

describe("GET /threads/:id/messages/:messageId", () => {
  it("returns one full message of the thread", async () => {
    const { hono, threads } = app()
    const response = await hono.request("/threads/thread-1/messages/m-1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(MESSAGE)
    expect(threads.getMessageView).toHaveBeenCalledWith("thread-1", "m-1")
  })

  it("answers 404 when the thread has no such message", async () => {
    const { hono } = app(null)
    const response = await hono.request("/threads/thread-1/messages/other")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "message_not_found" })
  })
})

describe("read-only remote devices", () => {
  async function allowed(method: string, path: string): Promise<boolean> {
    const hono = new Hono()
    hono.all("*", (c) => c.json({ allowed: isReadOnlyRemoteRequestAllowed(c) }))
    const response = await hono.request(path, { method })
    return ((await response.json()) as { allowed: boolean }).allowed
  }

  it("may read one full message like the transcript itself", async () => {
    await expect(
      allowed("GET", "/api/v1/threads/thread-1/messages/m-1")
    ).resolves.toBe(true)
    await expect(
      allowed("GET", "/api/v1/threads/thread-1/messages/m-1/extra")
    ).resolves.toBe(false)
    await expect(
      allowed("POST", "/api/v1/threads/thread-1/messages/m-1")
    ).resolves.toBe(false)
  })
})
