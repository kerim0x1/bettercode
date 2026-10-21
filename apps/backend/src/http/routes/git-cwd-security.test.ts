import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AppState } from "../../appState"
import { registerGitRoutes } from "./git"

describe("git route cwd confinement", () => {
  it("rejects an unregistered cwd for mutations and reads", async () => {
    const registered = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-git-approved-")
    )
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-git-outside-")
    )
    const state = {
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
    } as unknown as AppState
    const api = new Hono()
    registerGitRoutes(api, state)

    for (const [route, body] of [
      ["/git/status", { cwd: outside }],
      ["/git/fetch", { cwd: outside }],
      ["/git/commit", { cwd: outside, message: "nope" }],
      ["/git/diff", { cwd: outside }],
    ] as const) {
      const response = await api.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(response.status, route).toBe(403)
      expect(await response.json()).toMatchObject({
        error: "workspace root is not registered",
      })
    }

    await fs.rm(registered, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })
})
