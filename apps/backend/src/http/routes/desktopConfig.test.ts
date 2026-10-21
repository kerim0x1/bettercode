import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import type { ServerConfig } from "../../config"
import {
  routerLifecycleServices,
  routingTestServices,
} from "../../testUtils/routing-services"
import { withInertStateArgument } from "../../testUtils/inert-app-state"
import { buildApp as buildAppUnfilled } from "../router"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const REMOTE_SESSION = {
  id: "remote-session",
  label: "Phone",
  accessLevel: "full" as const,
  createdAt: "2026-05-20T08:00:00.000Z",
  lastSeenAt: "2026-05-20T08:00:00.000Z",
  expiresAt: "2036-06-20T08:00:00.000Z",
}

function makeApp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-config-routes-"))
  temporary.push(home)
  const dataDir = path.join(home, "custom-data")
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3773,
    dataDir,
    runtimeHome: home,
    dbPath: path.join(dataDir, "betterc0de.db"),
    settingsPath: path.join(dataDir, "settings.json"),
    authPath: path.join(dataDir, "auth.json"),
    logsDir: path.join(dataDir, "logs"),
    providerLogsDir: path.join(dataDir, "logs", "provider"),
    providerEventLogPath: path.join(dataDir, "logs", "provider", "events.log"),
    authToken: "secret",
  }
  const state = {
    ...routerLifecycleServices(),
    ...routingTestServices(),
    config,
    providerRegistry: { all: () => [] },
    threads: { persistUserMessageForTurn: vi.fn(), listProjects: () => [] },
    remoteAccess: {
      enabled: () => true,
      environmentId: () => "env-test",
      authenticate: (token: string) =>
        token === "remote-token" ? REMOTE_SESSION : null,
    },
    settings: { get: () => ({}), getPublic: () => ({}) },
  } as unknown as AppState
  return { app: buildApp(config, state), home }
}

const RENDERER = {
  Authorization: "Bearer secret",
  "Content-Type": "application/json",
}
/** What the desktop's main process sends (shared/desktop-config-client.cjs). */
const DESKTOP_SHELL = {
  ...RENDERER,
  "X-BetterC0de-Desktop-Shell": "secret",
}
const REMOTE = {
  Cookie: "betterc0de_remote_session=remote-token",
  "Content-Type": "application/json",
}

describe("/config routes", () => {
  it("answer only the desktop's main process", async () => {
    const { app } = makeApp()
    for (const headers of [
      RENDERER,
      { ...RENDERER, "X-BetterC0de-Desktop-Shell": "guess" },
    ]) {
      const read = await app.request("/api/v1/config/hooks", { headers })
      expect(read.status).toBe(403)
      expect(await read.json()).toMatchObject({ code: "desktop_only" })
      const write = await app.request("/api/v1/config/hooks", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          entries: [{ id: "x", event: "on_commit", command: "curl evil" }],
        }),
      })
      expect(write.status).toBe(403)
    }
    const remote = await app.request("/api/v1/config/mcp", {
      headers: { ...REMOTE, "X-BetterC0de-Desktop-Shell": "secret" },
    })
    expect(remote.status).toBe(403)
    expect(await remote.json()).toMatchObject({ code: "desktop_only" })
  })

  it("store the MCP list exactly as given and refuse a stale revision", async () => {
    const { app, home } = makeApp()
    const empty = await app.request("/api/v1/config/mcp", {
      headers: DESKTOP_SHELL,
    })
    expect(await empty.json()).toEqual({ entries: [], revision: "absent" })

    const entry = {
      id: "github",
      command: "npx",
      env: { GITHUB_TOKEN: "enc:v1:opaque" },
      scope: "project",
      projectRoot: "/work/repo",
      approval: { v: 1, alg: "hmac-sha256", digest: "x".repeat(44) },
    }
    const put = await app.request("/api/v1/config/mcp", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      body: JSON.stringify({ entries: [entry], expectedRevision: "absent" }),
    })
    expect(put.status).toBe(200)
    const written = (await put.json()) as { revision: string }
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "mcp-servers.json"), "utf8"))
    ).toEqual([entry])

    const stale = await app.request("/api/v1/config/mcp", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      body: JSON.stringify({ entries: [], expectedRevision: "absent" }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: "desktop_config_conflict",
    })
    const current = await app.request("/api/v1/config/mcp", {
      headers: DESKTOP_SHELL,
    })
    expect(await current.json()).toEqual({
      entries: [entry],
      revision: written.revision,
    })

    const duplicate = await app.request("/api/v1/config/mcp", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      body: JSON.stringify({ entries: [{ id: "a" }, { id: "a" }] }),
    })
    expect(duplicate.status).toBe(400)
  })

  it("read and write rules, skills and subagents", async () => {
    const { app, home } = makeApp()
    const rules = await app.request("/api/v1/config/rules", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      // Larger than the general API body limit: the configuration routes
      // take whole documents.
      body: JSON.stringify({ content: "r".repeat(3 * 1024 * 1024) }),
    })
    expect(rules.status).toBe(200)
    expect(fs.statSync(path.join(home, "rules.md")).size).toBe(3 * 1024 * 1024)

    const skill = await app.request("/api/v1/config/skills/style", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      body: JSON.stringify({
        manifest: { id: "style", name: "Style" },
        text: "Use tabs.",
      }),
    })
    expect(await skill.json()).toEqual({ id: "style" })
    const listed = await app.request("/api/v1/config/skills", {
      headers: DESKTOP_SHELL,
    })
    expect(await listed.json()).toEqual({
      entries: [
        {
          id: "style",
          manifest: { id: "style", name: "Style" },
          text: "Use tabs.",
        },
      ],
    })
    const missing = await app.request("/api/v1/config/subagents/reviewer", {
      headers: DESKTOP_SHELL,
    })
    expect(await missing.json()).toEqual({ entry: null })
    const removed = await app.request("/api/v1/config/skills/style", {
      method: "DELETE",
      headers: DESKTOP_SHELL,
    })
    expect(await removed.json()).toEqual({ removed: true })
    const invalid = await app.request("/api/v1/config/skills/..%2Fescape", {
      method: "PUT",
      headers: DESKTOP_SHELL,
      body: JSON.stringify({ manifest: {}, text: "" }),
    })
    expect(invalid.status).toBe(400)
    expect(fs.readdirSync(path.join(home, "skills"))).toEqual([])
  })
})
