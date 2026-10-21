import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { isReadOnlyRemoteRequestAllowed } from "./http"

async function readOnlyAllowed(method: string, path: string): Promise<boolean> {
  const app = new Hono()
  app.all("*", (c) => c.json({ allowed: isReadOnlyRemoteRequestAllowed(c) }))
  const response = await app.request(path, { method })
  const body = (await response.json()) as { allowed: boolean }
  return body.allowed
}

describe("read-only remote access to tool output", () => {
  it("lets a read-only device read a tool call's full output", async () => {
    await expect(
      readOnlyAllowed(
        "GET",
        "/api/v1/threads/thread-1/activities/thread-1%3A%3Atool.completed%3A%3Atool-1/output"
      )
    ).resolves.toBe(true)
  })

  it("does not open other activity sub-paths or methods", async () => {
    await expect(
      readOnlyAllowed("GET", "/api/v1/threads/thread-1/activities/a/b/output")
    ).resolves.toBe(false)
    await expect(
      readOnlyAllowed(
        "POST",
        "/api/v1/threads/thread-1/activities/model-switch"
      )
    ).resolves.toBe(false)
  })
})

describe("read-only remote access to find in chat", () => {
  it("lets a read-only device search a chat it can read", async () => {
    await expect(
      readOnlyAllowed("GET", "/api/v1/threads/thread-1/messages/search?q=x")
    ).resolves.toBe(true)
    await expect(
      readOnlyAllowed("POST", "/api/v1/threads/thread-1/messages/search")
    ).resolves.toBe(false)
  })
})
