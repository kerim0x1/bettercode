import { routingTestServices } from "../../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { AgentPermissionPolicy } from "../../provider/agent-permission-policy"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import {
  registerWorkspaceRoutes,
  resolveApprovedWorkspaceRoot,
} from "./workspace"

describe("workspace route root authorization", () => {
  it("registers an explicitly opened folder before its first thread while preserving trust decisions", async () => {
    const folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-open-workspace-")
    )
    const db = openDatabase(":memory:")
    runMigrations(db)
    const agentPermissions = new AgentPermissionPolicy(db)
    const state = {
      db,
      agentPermissions,
      projectProjections: { listAll: () => [] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
    } as unknown as AppState
    const api = new Hono()
    registerWorkspaceRoutes(api, state)
    try {
      const canonical = await fs.realpath(folder)
      agentPermissions.setWorkspaceTrust({
        workspacePath: canonical,
        state: "untrusted",
      })
      await expect(
        resolveApprovedWorkspaceRoot(state, folder)
      ).rejects.toMatchObject({ code: "workspace_not_registered" })
      const response = await api.request("/workspace/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacePath: folder }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ path: canonical })
      await expect(resolveApprovedWorkspaceRoot(state, folder)).resolves.toBe(
        canonical
      )
      expect(agentPermissions.getWorkspaceTrust(canonical).state).toBe(
        "untrusted"
      )
      // Registration is not a tool grant, and unrelated callers stay confined.
      await expect(
        resolveApprovedWorkspaceRoot(state, path.dirname(folder))
      ).rejects.toMatchObject({ code: "workspace_not_registered" })
      const config = await api.request("/workspace/project-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: folder }),
      })
      expect(config.status).toBe(200)
      const invalid = await api.request("/workspace/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacePath: "relative-folder" }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      db.close()
      await fs.rm(folder, { recursive: true, force: true })
    }
  })
  it("accepts registered projects and rejects caller-selected roots", async () => {
    const registered = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-approved-")
    )
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-outside-"))
    const state = {
      ...routingTestServices(),
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
    } as unknown as AppState

    await expect(resolveApprovedWorkspaceRoot(state, registered)).resolves.toBe(
      await fs.realpath(registered)
    )
    // A subdirectory of a registered root is approved by containment — the
    // renderer often derives its cwd from a file's parent directory.
    const nested = path.join(registered, "public", "brand")
    await fs.mkdir(nested, { recursive: true })
    await expect(resolveApprovedWorkspaceRoot(state, nested)).resolves.toBe(
      await fs.realpath(nested)
    )
    await expect(resolveApprovedWorkspaceRoot(state, outside)).rejects.toThrow(
      "workspace root is not registered"
    )

    await fs.rm(registered, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it("rejects unregistered roots across every cwd-based route", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-outside-"))
    const state = {
      ...routingTestServices(),
      projectProjections: { listAll: () => [] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
    } as unknown as AppState
    const api = new Hono()
    registerWorkspaceRoutes(api, state)

    const cases: Array<[string, Record<string, unknown>]> = [
      ["/workspace/search", { cwd: outside, query: "" }],
      ["/workspace/search-content", { cwd: outside, query: "needle" }],
      ["/workspace/quick-open", { cwd: outside }],
      ["/workspace/map", { cwd: outside }],
      ["/workspace/project-commands", { cwd: outside }],
      ["/workspace/project-agents", { cwd: outside }],
      ["/workspace/project-skills", { cwd: outside }],
      ["/workspace/project-mcp-servers", { cwd: outside }],
      ["/workspace/project-instructions", { cwd: outside }],
      ["/workspace/effective-rules", { cwd: outside, targetPath: "." }],
      ["/workspace/project-references", { cwd: outside }],
      ["/workspace/project-formatters", { cwd: outside }],
      [
        "/workspace/project-format",
        {
          cwd: outside,
          relativePath: "src/main.ts",
          formatterId: "prettier",
        },
      ],
      ["/workspace/project-lsp-servers", { cwd: outside }],
      ["/workspace/project-permissions", { cwd: outside }],
      ["/workspace/project-config", { cwd: outside }],
      ["/workspace/project-providers", { cwd: outside }],
      ["/workspace/project-plugins", { cwd: outside }],
      ["/workspace/project-tools", { cwd: outside }],
      ["/workspace/read", { cwd: outside, relativePath: "src/main.ts" }],
      [
        "/workspace/read-binary",
        { cwd: outside, relativePath: "assets/logo.png" },
      ],
      [
        "/workspace/write",
        { cwd: outside, relativePath: "src/main.ts", contents: "changed" },
      ],
      ["/workspace/mkdir", { cwd: outside, relativePath: "src/new-directory" }],
      [
        "/workspace/move",
        {
          cwd: outside,
          fromRelativePath: "src/old.ts",
          toRelativePath: "src/new.ts",
        },
      ],
      ["/workspace/delete", { cwd: outside, relativePath: "src/main.ts" }],
    ]

    try {
      for (const [route, body] of cases) {
        const response = await api.request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(response.status, route).toBe(403)
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("fences registered workspace mutations during checkpoint recovery", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-fenced-"))
    const state = {
      ...routingTestServices(),
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
      checkpointReverts: {
        blockingThreadForCwd: () => "thread-recovery",
      },
    } as unknown as AppState
    const api = new Hono()
    registerWorkspaceRoutes(api, state)

    try {
      const response = await api.request("/workspace/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: registered,
          relativePath: "blocked.txt",
          contents: "must not be written",
        }),
      })

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: "checkpoint_recovery_pending",
      })
      await expect(
        fs.stat(path.join(registered, "blocked.txt"))
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(registered, { recursive: true, force: true })
    }
  })

  it("trust-checks exact canonical roots for mutations but not reads", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-trust-"))
    await fs.writeFile(path.join(registered, "readable.txt"), "safe", "utf8")
    const assertWorkspaceTrusted = vi.fn(
      (input: { workspacePath: string; operation: string }) => {
        throw Object.assign(new Error(`untrusted for ${input.operation}`), {
          statusCode: 403,
          code: "workspace_untrusted",
        })
      }
    )
    const state = {
      ...routingTestServices(),
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
      agentPermissions: { assertWorkspaceTrusted },
    } as unknown as AppState
    const api = new Hono()
    registerWorkspaceRoutes(api, state)
    const requestedRoot = path.join(registered, ".")

    try {
      const read = await api.request("/workspace/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: requestedRoot,
          relativePath: "readable.txt",
        }),
      })
      expect(read.status).toBe(200)
      expect(assertWorkspaceTrusted).not.toHaveBeenCalled()

      const mutations: Array<[string, Record<string, unknown>]> = [
        [
          "/workspace/project-format",
          {
            cwd: requestedRoot,
            relativePath: "readable.txt",
            formatterId: "prettier",
          },
        ],
        [
          "/workspace/write",
          {
            cwd: requestedRoot,
            relativePath: "changed.txt",
            contents: "blocked",
          },
        ],
        [
          "/workspace/mkdir",
          { cwd: requestedRoot, relativePath: "blocked-directory" },
        ],
        [
          "/workspace/move",
          {
            cwd: requestedRoot,
            fromRelativePath: "readable.txt",
            toRelativePath: "moved.txt",
          },
        ],
        [
          "/workspace/delete",
          { cwd: requestedRoot, relativePath: "readable.txt" },
        ],
      ]
      for (const [route, body] of mutations) {
        const response = await api.request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(response.status, route).toBe(403)
        expect(await response.json()).toMatchObject({
          code: "workspace_untrusted",
        })
      }

      const canonical = await fs.realpath(registered)
      expect(assertWorkspaceTrusted).toHaveBeenCalledTimes(mutations.length)
      for (const [input] of assertWorkspaceTrusted.mock.calls) {
        expect(input.workspacePath).toBe(canonical)
      }
      expect(
        await fs.readFile(path.join(registered, "readable.txt"), "utf8")
      ).toBe("safe")
    } finally {
      await fs.rm(registered, { recursive: true, force: true })
    }
  })

  it.each(["source thread", "destination"])(
    "blocks scratch adoption while %s checkpoint recovery is pending",
    async (blockedScope) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "bc0de-adopt-fenced-")
      )
      const destination = path.join(directory, "destination")
      const dataDir = path.join(directory, "data")
      const source = path.join(dataDir, "scratch", "thread-source")
      await fs.mkdir(destination)
      await fs.mkdir(source, { recursive: true })
      await fs.writeFile(path.join(source, "draft.txt"), "unfinished source")
      const canonicalDestination = await fs.realpath(destination)
      const state = {
        ...routingTestServices(),
        config: { dataDir },
        projectProjections: { listAll: () => [{ path: destination }] },
        checkpointReverts: {
          hasBlockingRecovery: (threadId: string) =>
            blockedScope === "source thread" && threadId === "thread-source",
          blockingThreadForCwd: (cwd: string) =>
            blockedScope === "destination" && cwd === canonicalDestination
              ? "thread-destination"
              : null,
        },
      } as unknown as AppState
      const api = new Hono()
      registerWorkspaceRoutes(api, state)
      try {
        const response = await api.request("/workspace/scratch/adopt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: "thread-source", destination }),
        })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({
          code: "checkpoint_recovery_pending",
        })
        await expect(
          fs.stat(path.join(destination, "draft.txt"))
        ).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )
})
