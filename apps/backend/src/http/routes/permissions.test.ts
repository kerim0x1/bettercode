import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { createServerConfig } from "../../config"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { AgentPermissionPolicy } from "../../provider/agent-permission-policy"
import { registerPermissionsRoutes as registerPermissionsRoutesUnfilled } from "./permissions"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerPermissionsRoutes = withInertStateArgument(
  registerPermissionsRoutesUnfilled,
  1
)

describe("permission routes", () => {
  it("confines remote Claude rule reads to registered workspaces while retaining desktop access", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-permission-roots-")
    )
    const approved = path.join(directory, "approved")
    const outside = path.join(directory, "outside")
    for (const cwd of [approved, outside]) {
      fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Read(private-project)"] },
        })
      )
    }
    const home = vi.spyOn(os, "homedir").mockReturnValue(directory)
    const app = new Hono()
    registerPermissionsRoutes(app, {
      config: { ...createServerConfig(), authToken: "desktop-secret" },
      remoteAccess: {
        authenticate: (token: string) =>
          token === "remote-secret" ? { id: "remote-session" } : null,
      },
      projectProjections: { listAll: () => [{ path: approved }] },
      agentPermissions: {},
    } as unknown as AppState)
    const read = (cwd: string | undefined, token: string) =>
      app.request("/permissions/claude-rules/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ cwd }),
      })
    try {
      const denied = await read(outside, "remote-secret")
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({
        code: "workspace_not_registered",
      })
      const remote = await read(approved, "remote-secret")
      expect(remote.status).toBe(200)
      expect(await remote.json()).toMatchObject({
        rules: [{ rule: "Read(private-project)" }],
      })
      const desktop = await read(outside, "desktop-secret")
      expect(desktop.status).toBe(200)
      expect(await desktop.json()).toMatchObject({
        rules: [{ rule: "Read(private-project)" }],
      })
      expect((await read(undefined, "remote-secret")).status).toBe(200)
    } finally {
      home.mockRestore()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fences project settings writes during checkpoint recovery", async () => {
    const app = new Hono()
    const db = openDatabase(":memory:")
    runMigrations(db)
    const blockingThreadForCwd = vi.fn(() => "thread-recovery")
    registerPermissionsRoutes(app, {
      config: { ...createServerConfig(), authToken: "desktop-secret" },
      agentPermissions: new AgentPermissionPolicy(db),
      checkpointReverts: {
        blockingThreadForCwd,
      },
    } as unknown as AppState)

    const response = await app.request("/permissions/claude-rules/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        source: "localSettings",
        behavior: "allow",
        rule: "Bash(npm test)",
        cwd: "/repo",
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: "checkpoint_recovery_pending",
    })
    expect(blockingThreadForCwd).toHaveBeenCalledWith("/repo")
    db.close()
  })

  it("creates, lists, evaluates, and deletes provider-neutral grants", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-permissions-api-")
    )
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(workspace)
    const db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    const agentPermissions = new AgentPermissionPolicy(db, {
      createId: () => "grant-api",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    })
    const app = new Hono()
    registerPermissionsRoutes(app, {
      config: { ...createServerConfig(), authToken: "desktop-secret" },
      agentPermissions,
    } as AppState)

    const create = await app.request("/permissions/grants/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "Edit",
        pathScope: "./src\\components",
        behavior: "allow",
      }),
    })
    expect(create.status).toBe(200)
    expect(await create.json()).toMatchObject({
      grant: {
        id: "grant-api",
        destination: "workspace",
        toolName: "edit",
        pathScope: "src/components",
        behavior: "allow",
      },
    })

    const list = await app.request("/permissions/grants/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      grants: [{ id: "grant-api" }],
    })

    const evaluate = await app.request("/permissions/grants/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        workspacePath: workspace,
        toolName: "edit",
        path: "src/components/button.tsx",
      }),
    })
    expect(evaluate.status).toBe(200)
    expect(await evaluate.json()).toMatchObject({
      evaluation: {
        decision: "allow",
        source: "grant",
        normalizedPath: "src/components/button.tsx",
      },
    })

    const remove = await app.request("/permissions/grants/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({ id: "grant-api" }),
    })
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ status: "acknowledged" })

    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it("rejects unscoped durable allow upserts including default pathScope", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-permissions-unscoped-")
    )
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(workspace)
    const db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    const app = new Hono()
    registerPermissionsRoutes(app, {
      config: { ...createServerConfig(), authToken: "desktop-secret" },
      agentPermissions: new AgentPermissionPolicy(db),
    } as AppState)

    const missingScope = await app.request("/permissions/grants/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "bash",
        behavior: "allow",
      }),
    })
    expect(missingScope.status).toBe(400)

    const matchAll = await app.request("/permissions/grants/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        destination: "user",
        toolName: "edit",
        pathScope: ".",
        behavior: "allow",
      }),
    })
    expect(matchAll.status).toBe(400)

    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it("gets and sets explicit workspace trust through the permissions API", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-trust-api-")
    )
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(workspace)
    const db = openDatabase(path.join(directory, "test.sqlite"))
    runMigrations(db)
    const app = new Hono()
    registerPermissionsRoutes(app, {
      config: { ...createServerConfig(), authToken: "desktop-secret" },
      agentPermissions: new AgentPermissionPolicy(db),
    } as AppState)

    const initial = await app.request("/permissions/workspace-trust/get", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    expect(await initial.json()).toMatchObject({
      trust: { state: "trusted", explicit: false },
    })

    const update = await app.request("/permissions/workspace-trust/set", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({ workspacePath: workspace, state: "untrusted" }),
    })
    expect(await update.json()).toMatchObject({
      trust: { state: "untrusted", explicit: true },
    })

    const invalidScope = await app.request("/permissions/grants/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer desktop-secret",
      },
      body: JSON.stringify({
        destination: "workspace",
        workspacePath: workspace,
        toolName: "read",
        pathScope: "../outside",
        behavior: "allow",
      }),
    })
    expect(invalidScope.status).toBe(400)

    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
