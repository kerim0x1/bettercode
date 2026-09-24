import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import type { AppState } from "../../appState"
import { routingTestServices } from "../../testUtils/routing-services"
import { registerWorkspaceRoutes } from "./workspace"

// A phone edits a file the agent may change at the same moment: the save
// must name the bytes it started from and fail instead of overwriting.

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-edit-"))
  roots.push(root)
  const state = {
    ...routingTestServices(),
    projectProjections: { listAll: () => [{ path: root }] },
    threads: { listProjects: () => [] },
    worktreeRegistry: { listAll: () => [] },
  } as unknown as AppState
  const api = new Hono()
  registerWorkspaceRoutes(api, state)
  const post = (route: string, body: Record<string, unknown>) =>
    api.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, ...body }),
    })
  return { root, post }
}

const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

describe("workspace edits with an expected file hash", () => {
  it("reads the file with the hash of its exact bytes", async () => {
    const { root, post } = await workspace()
    await fs.writeFile(path.join(root, "notes.md"), "héllo\n", "utf8")
    const response = await post("/workspace/read", { relativePath: "notes.md" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      content: "héllo\n",
      path: path.join(await fs.realpath(root), "notes.md"),
      size: Buffer.byteLength("héllo\n"),
      sha256: sha256("héllo\n"),
      isUtf8: true,
    })
  })

  it("marks a file that is not valid UTF-8, so it is never saved as text", async () => {
    const { root, post } = await workspace()
    const bytes = Buffer.from([0x66, 0x6f, 0xff, 0xfe, 0x6f])
    await fs.writeFile(path.join(root, "latin1.txt"), bytes)
    const body = (await (
      await post("/workspace/read", { relativePath: "latin1.txt" })
    ).json()) as {
      isUtf8: boolean
      sha256: string
    }
    expect(body.isUtf8).toBe(false)
    expect(body.sha256).toBe(sha256(bytes))
  })

  it("saves over the version it read and refuses to overwrite a newer one", async () => {
    const { root, post } = await workspace()
    const file = path.join(root, "app.ts")
    await fs.writeFile(file, "one", "utf8")
    const { sha256: readHash } = (await (
      await post("/workspace/read", { relativePath: "app.ts" })
    ).json()) as {
      sha256: string
    }

    const saved = await post("/workspace/write", {
      relativePath: "app.ts",
      contents: "two",
      expectedSha256: readHash,
    })
    expect(saved.status).toBe(204)
    expect(await fs.readFile(file, "utf8")).toBe("two")

    // A second save that still names "one" would silently drop "two".
    const stale = await post("/workspace/write", {
      relativePath: "app.ts",
      contents: "three",
      expectedSha256: readHash,
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: "WORKSPACE_PATH_CHANGED" })
    expect(await fs.readFile(file, "utf8")).toBe("two")
  })

  it("creates a file only when it does not exist yet", async () => {
    const { root, post } = await workspace()
    const created = await post("/workspace/write", {
      relativePath: "new.ts",
      contents: "a",
      expectedSha256: null,
    })
    expect(created.status).toBe(204)
    const again = await post("/workspace/write", {
      relativePath: "new.ts",
      contents: "b",
      expectedSha256: null,
    })
    expect(again.status).toBe(409)
    expect(await fs.readFile(path.join(root, "new.ts"), "utf8")).toBe("a")
  })

  it("rejects a hash that is not a lowercase SHA-256 digest", async () => {
    const { post } = await workspace()
    for (const expectedSha256 of ["abc", "A".repeat(64), 42]) {
      const response = await post("/workspace/write", {
        relativePath: "x.ts",
        contents: "x",
        expectedSha256,
      })
      expect(response.status, String(expectedSha256)).toBe(400)
    }
  })
})
