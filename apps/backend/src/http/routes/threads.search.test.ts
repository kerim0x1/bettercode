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

// Find in chat asks the backend for the part of a long chat the renderer
// has not loaded.

const RESULT = {
  hits: [
    {
      messageId: "m-1",
      role: "user",
      sequence: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      matchCount: 1,
      snippet: "find me here",
    },
  ],
  totalMatches: 1,
  truncated: false,
}

function app() {
  const threads = {
    searchMessages: vi.fn(() => RESULT),
    getMessageView: vi.fn(() => null),
  }
  const hono = new Hono()
  registerThreadsRoutes(hono, { threads } as unknown as AppState)
  return { hono, threads }
}

describe("GET /threads/:id/messages/search", () => {
  it("searches the thread rather than reading a message called search", async () => {
    const { hono, threads } = app()
    const response = await hono.request(
      "/threads/thread-1/messages/search?q=find+me&caseSensitive=1&beforeSequence=40&limit=10"
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(RESULT)
    expect(threads.searchMessages).toHaveBeenCalledWith("thread-1", {
      query: "find me",
      caseSensitive: true,
      beforeSequence: 40,
      limit: 10,
    })
    expect(threads.getMessageView).not.toHaveBeenCalled()
  })

  it("refuses a missing, blank or overlong query", async () => {
    const { hono, threads } = app()
    for (const query of ["", "?q=", "?q=%20%20", `?q=${"x".repeat(201)}`]) {
      const response = await hono.request(
        `/threads/thread-1/messages/search${query}`
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: "invalid_search_query",
      })
    }
    expect(threads.searchMessages).not.toHaveBeenCalled()
  })
})
