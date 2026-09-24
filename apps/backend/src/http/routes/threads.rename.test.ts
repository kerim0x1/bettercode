import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerThreadActivityBroadcaster } from "../../ws/threadActivityBroadcast"
import { registerThreadsRoutes } from "./threads"

// Clients keep their own copy of a chat's metadata and write all of it back,
// so a title changed on one client must reach the others, or their next write
// undoes it. POST /threads/:id/title renames and tells every client.

let unregister: (() => void) | null = null
afterEach(() => {
  unregister?.()
  unregister = null
})

function app(known: string[]) {
  const updateThreadTitle = vi.fn()
  const broadcast = vi.fn()
  unregister = registerThreadActivityBroadcaster({ broadcast })
  const hono = new Hono()
  registerThreadsRoutes(hono, {
    threads: {
      hasThread: (threadId: string) => known.includes(threadId),
      updateThreadTitle,
    },
  } as unknown as AppState)
  const rename = (threadId: string, body: unknown) =>
    hono.request(`/threads/${threadId}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { rename, updateThreadTitle, broadcast }
}

describe("renaming a chat", () => {
  it("stores the new title and tells every connected client", async () => {
    const { rename, updateThreadTitle, broadcast } = app(["thread-1"])
    const response = await rename("thread-1", { title: "  Release notes  " })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toEqual({
      threadId: "thread-1",
      title: "Release notes",
      updatedAt: expect.any(String),
    })
    expect(updateThreadTitle).toHaveBeenCalledWith(
      "thread-1",
      "Release notes",
      body.updatedAt
    )
    expect(broadcast).toHaveBeenCalledWith({
      channel: "thread.metadata",
      data: body,
    })
  })

  it("refuses an unknown chat and an empty title, and changes nothing", async () => {
    const { rename, updateThreadTitle, broadcast } = app(["thread-1"])
    const missing = await rename("thread-2", { title: "Name" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "thread_not_found" })
    const blank = await rename("thread-1", { title: "   " })
    expect(blank.status).toBe(400)
    expect(updateThreadTitle).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
