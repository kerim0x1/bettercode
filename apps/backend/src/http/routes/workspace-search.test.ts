import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import type { SearchEntriesResult } from "../../services/workspace"

// `/workspace/search` has no caller-controllable cap, so the only way to get
// a truncated entry listing from a small fixture is to answer for the walk.
// Every other export stays real: the content-search truncation below is
// produced by the genuine walk hitting a caller-supplied `limit`.
const entriesOverride = vi.hoisted(() => ({
  result: null as SearchEntriesResult | null,
}))

vi.mock("../../services/workspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/workspace")>()
  return {
    ...actual,
    searchEntriesDetailed: vi.fn(
      async (cwd: string, query: string) =>
        entriesOverride.result ?? actual.searchEntriesDetailed(cwd, query)
    ),
  }
})

import { registerWorkspaceRoutes as registerWorkspaceRoutesUnfilled } from "./workspace"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerWorkspaceRoutes = withInertStateArgument(
  registerWorkspaceRoutesUnfilled,
  1
)

/**
 * What either search route puts on the wire. Typed loosely on purpose: the
 * assertions below pin the shape, so a drift in the route shows up as a
 * failing expectation rather than a compile error hidden inside the helper.
 */
interface SearchWireResponse {
  entries?: Array<{ path: string; name: string; is_dir: boolean }>
  results?: Array<{ path: string; matches: unknown[] }>
  truncated?: boolean
  truncatedReason?: string
}

async function post(api: Hono, route: string, body: Record<string, unknown>) {
  const response = await api.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as SearchWireResponse,
  }
}

describe("workspace search routes report truncation", () => {
  let root = ""
  let api: Hono

  beforeEach(async () => {
    entriesOverride.result = null
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-search-shape-"))
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(
      path.join(root, "src", "alpha.ts"),
      "export const needle = 1\n",
      "utf8"
    )
    await fs.writeFile(
      path.join(root, "src", "beta.ts"),
      "export const needle = 2\n",
      "utf8"
    )
    const state = {
      projectProjections: { listAll: () => [{ path: root }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
    } as unknown as AppState
    api = new Hono()
    registerWorkspaceRoutes(api, state)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("wraps a complete entry listing in the detailed shape", async () => {
    const { status, json } = await post(api, "/workspace/search", {
      cwd: root,
      query: "",
    })
    expect(status).toBe(200)
    // The wire used to be a bare array; a client keyed on `.length` would
    // silently see `undefined` now, so pin the object shape explicitly.
    expect(Array.isArray(json)).toBe(false)
    expect(json.truncated).toBe(false)
    expect(json).not.toHaveProperty("truncatedReason")
    expect(json.entries).toEqual(
      expect.arrayContaining([
        { path: "src", name: "src", is_dir: true },
        { path: "src/alpha.ts", name: "alpha.ts", is_dir: false },
        { path: "src/beta.ts", name: "beta.ts", is_dir: false },
      ])
    )
  })

  it("passes a cut-short entry walk through with its reason", async () => {
    entriesOverride.result = {
      entries: [{ path: "src", name: "src", is_dir: true }],
      truncated: true,
      truncatedReason: "deadline",
    }
    const { status, json } = await post(api, "/workspace/search", {
      cwd: root,
      query: "",
    })
    expect(status).toBe(200)
    expect(json).toEqual({
      entries: [{ path: "src", name: "src", is_dir: true }],
      truncated: true,
      truncatedReason: "deadline",
    })
  })

  it("wraps a complete content search in the detailed shape", async () => {
    const { status, json } = await post(api, "/workspace/search-content", {
      cwd: root,
      query: "needle",
    })
    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(false)
    expect(json.truncated).toBe(false)
    expect(json).not.toHaveProperty("truncatedReason")
    expect(json.results?.map((r) => r.path)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ])
  })

  it("reports a content search stopped by the caller's limit", async () => {
    const { status, json } = await post(api, "/workspace/search-content", {
      cwd: root,
      query: "needle",
      limit: 1,
    })
    expect(status).toBe(200)
    expect(json.truncated).toBe(true)
    expect(json.truncatedReason).toBe("limit")
    expect(json.results).toHaveLength(1)
    expect(json.results?.[0]?.matches).toHaveLength(1)
  })
})
