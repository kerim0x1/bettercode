import { routingTestServices } from "../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultSettings } from "@betterc0de/schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp } from "./router"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

function makeConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-test",
    dbPath: "/tmp/betterc0de-test/betterc0de.db",
    settingsPath: "/tmp/betterc0de-test/settings.json",
    authPath: "/tmp/betterc0de-test/auth.json",
    logsDir: "/tmp/betterc0de-test/logs",
    providerLogsDir: "/tmp/betterc0de-test/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-test/logs/provider/events.log",
    authToken: "secret",
  }
}

const REMOTE_SESSION = {
  id: "remote-session",
  label: "Phone",
  accessLevel: "full" as const,
  createdAt: "2026-05-20T08:00:00.000Z",
  lastSeenAt: "2026-05-20T08:00:00.000Z",
  expiresAt: "2036-06-20T08:00:00.000Z",
}

function makeApp(overrides: Record<string, unknown> = {}) {
  const config = makeConfig()
  const authenticate = vi.fn((token: string) =>
    token === "remote-token" ? REMOTE_SESSION : null
  )
  const state = {
    ...routingTestServices(),
    config,
    providerRegistry: { all: () => [] },
    threads: { persistUserMessageForTurn: vi.fn(), listProjects: () => [] },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
    remoteAccess: {
      enabled: () => true,
      environmentId: () => "env-test",
      authenticate,
    },
    settings: {
      get: () => ({}),
      getPublic: () => ({}),
      updatePublic: vi.fn(async (patch: Record<string, unknown>) => patch),
    },
    projectProjections: { listAll: () => [] },
    worktreeRegistry: { listAll: () => [] },
    authStore: { set: vi.fn(), remove: vi.fn() },
    providerHub: {
      getInstance: () => ({ instanceId: "codex", enabled: true }),
      updateProviderInstance: vi.fn(async () => ({ providers: [] })),
    },
    ...overrides,
  } as unknown as AppState
  return { app: buildApp(config, state), authenticate, state }
}

const REMOTE_HEADERS = {
  Cookie: "betterc0de_remote_session=remote-token",
  "Content-Type": "application/json",
}
const LOCAL_HEADERS = {
  Authorization: "Bearer secret",
  "Content-Type": "application/json",
}

describe("remote access scope", () => {
  it("refuses desktop-only endpoints to a full-access remote session", async () => {
    const { app, state } = makeApp()
    const cases: Array<[string, string]> = [
      ["POST", "/api/v1/workspace/open"],
      ["POST", "/api/v1/workspace/project-lsp-servers"],
      ["POST", "/api/v1/workspace/project-config"],
      ["GET", "/api/v1/runtime/debug-info"],
      ["POST", "/api/v1/runtime/heap-snapshot"],
      ["GET", "/api/v1/usage/providers"],
      ["POST", "/api/v1/providers/openai/credential"],
      ["DELETE", "/api/v1/providers/openai/credential"],
      ["POST", "/api/v1/providers/instances/codex/update"],
      ["POST", "/api/v1/settings/deepgram-token"],
      ["GET", "/api/v1/filesystem/drives"],
    ]
    for (const [method, route] of cases) {
      const response = await app.request(route, {
        method,
        headers: REMOTE_HEADERS,
        body: method === "GET" ? undefined : JSON.stringify({ type: "api", key: "k" }),
      })
      expect(response.status, `${method} ${route}`).toBe(403)
      expect(await response.json(), `${method} ${route}`).toEqual({
        error: "This endpoint is only available to the desktop host.",
        code: "desktop_only",
      })
    }
    expect(
      (state as unknown as { authStore: { set: ReturnType<typeof vi.fn> } })
        .authStore.set
    ).not.toHaveBeenCalled()

    const local = await app.request("/api/v1/runtime/debug-info", {
      headers: LOCAL_HEADERS,
    })
    expect(local.status).toBe(200)
    expect(await local.json()).toMatchObject({
      paths: { dataDir: "/tmp/betterc0de-test" },
    })
  })

  it("keeps credential-bearing global workspace templates on the desktop", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-template-scope-"))
    temporaryDirectories.push(registered)
    vi.stubEnv("BETTERC0DE_CONFIG_CONTENT", JSON.stringify({
      mcp: { private: { type: "remote", url: "https://example.invalid/mcp", headers: { Authorization: "global-mcp-secret" } } },
      lsp: { private: { command: ["language-server"], extensions: [".txt"], env: { TOKEN: "global-lsp-secret" } } },
      private_key: "global-config-secret",
    }))
    const { app } = makeApp({ projectProjections: { listAll: () => [{ path: registered }] } })
    for (const [route, secret] of [
      ["project-lsp-servers", "global-lsp-secret"],
      ["project-config", "global-config-secret"],
    ]) {
      const request = (headers: Record<string, string>) => app.request(`/api/v1/workspace/${route}`, {
        method: "POST", headers, body: JSON.stringify({ cwd: registered }),
      })
      const remote = await request(REMOTE_HEADERS)
      expect(remote.status, route).toBe(403)
      expect(await remote.text()).not.toContain(secret)
      const local = await request(LOCAL_HEADERS)
      expect(local.status, route).toBe(200)
      expect(await local.text()).toContain(secret)
    }
  })

  it("returns only safe MCP metadata without breaking remote workspace context reads", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-mcp-projection-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-mcp-outside-"))
    temporaryDirectories.push(registered, outside)
    vi.stubEnv("BETTERC0DE_HOME", registered)
    vi.stubEnv("BETTERC0DE_DATA_DIR", registered)
    const skillDirectory = path.join(registered, ".betterc0de", "skills", "review")
    await fs.mkdir(skillDirectory, { recursive: true })
    await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: review\ndescription: Project review guidance\n---\nFollow the project review checklist.\n")
    vi.stubEnv("BETTERC0DE_CONFIG_CONTENT", JSON.stringify({
      mcp: {
        local: { type: "local", command: ["/private/server", "--token=argument-secret"], environment: { PRIVATE_ENV: "environment-secret" }, enabled: false },
        remote: { type: "remote", url: "https://user:password@example.invalid/mcp?token=url-secret", headers: { PrivateHeader: "header-secret" }, oauth: { clientSecret: "oauth-secret" } },
      },
      permission: { bash: "deny" },
    }))
    const { app } = makeApp({ projectProjections: { listAll: () => [{ path: registered }] } })
    const request = (route: string, headers: Record<string, string> = REMOTE_HEADERS, cwd = registered) => app.request(`/api/v1/workspace/${route}`, {
      method: "POST", headers, body: JSON.stringify({ cwd }),
    })
    // The paired web client batches these endpoints with Promise.all.
    const responses = await Promise.all([
      "project-mcp-servers", "project-skills", "project-agents", "project-permissions",
    ].map((route) => request(route)))
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    expect(await responses[0]!.json()).toEqual([
      { id: "local", name: "local", type: "local", enabled: false, command: "", args: [], env: {}, sourcePath: "" },
      { id: "remote", name: "remote", type: "remote", enabled: true, command: "", args: [], env: {}, sourcePath: "" },
    ])
    expect(await responses[1]!.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "review", content: expect.stringContaining("Follow the project review checklist.") }),
    ]))
    expect(await responses[3]!.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: "bash", action: "deny" }),
    ]))
    const local = await request("project-mcp-servers", LOCAL_HEADERS)
    expect(local.status).toBe(200)
    expect(await local.text()).toContain("argument-secret")
    const blocked = await request("project-mcp-servers", REMOTE_HEADERS, outside)
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: "workspace_not_registered" })
  })

  it("confines remote filesystem browsing to registered workspace roots", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-scope-in-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-scope-out-"))
    temporaryDirectories.push(registered, outside)
    await fs.writeFile(path.join(registered, "README.md"), "hi", "utf8")
    const { app } = makeApp({
      projectProjections: { listAll: () => [{ path: registered }] },
    })

    const blocked = await app.request("/api/v1/filesystem/list", {
      method: "POST",
      headers: REMOTE_HEADERS,
      body: JSON.stringify({ path: outside }),
    })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: "workspace_not_registered" })

    const blockedSearch = await app.request("/api/v1/filesystem/search", {
      method: "POST",
      headers: REMOTE_HEADERS,
      body: JSON.stringify({ root: outside, query: "README" }),
    })
    expect(blockedSearch.status).toBe(403)

    const allowed = await app.request("/api/v1/filesystem/list", {
      method: "POST",
      headers: REMOTE_HEADERS,
      body: JSON.stringify({ path: registered }),
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "README.md" }),
      ]),
    })

    // The desktop renderer is the user's own file picker: no confinement.
    const desktop = await app.request("/api/v1/filesystem/list", {
      method: "POST",
      headers: LOCAL_HEADERS,
      body: JSON.stringify({ path: outside }),
    })
    expect(desktop.status).toBe(200)
  })

  it("refuses host-shaping settings to a remote session", async () => {
    const updatePublic = vi.fn(async (patch: Record<string, unknown>) => ({
      ...defaultSettings(),
      ...patch,
    }))
    const { app } = makeApp({
      settings: { get: () => ({}), getPublic: () => ({}), updatePublic },
    })
    const patchSettings = (
      headers: Record<string, string>,
      patch: Record<string, unknown>
    ) =>
      app.request("/api/v1/settings", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ patch }),
      })

    // Anything the host would execute, any widening of trust, and the
    // listener itself belong to the desktop owner.
    const forbidden: Array<Record<string, unknown>> = [
      { mcp_servers: [] },
      { hooks: [] },
      { providers: {} },
      { provider_instances: { codex: { driver: "codex", config: { binaryPath: "C:\\attacker\\agent.exe" } } } },
      { providerInstances: {} },
      { remove_provider_instance_ids: ["codex"] },
      { future_host_setting: true },
      { auto_trust_workspaces: true },
      { jev_search_enabled: true },
      { jev_api_key: { set: "remote-key" } },
      { remote_access_allow_terminal: true },
      { backend_trace_http: true },
      { theme: "dark", skills: [] },
    ]
    for (const patch of forbidden) {
      const response = await patchSettings(REMOTE_HEADERS, patch)
      expect(response.status, Object.keys(patch).join(",")).toBe(403)
      expect(await response.json()).toMatchObject({
        code: "remote_host_owner_required",
      })
    }
    expect(updatePublic).not.toHaveBeenCalled()

    // Presentation stays a per-device choice.
    const allowed = await patchSettings(REMOTE_HEADERS, { theme: "dark" })
    expect(allowed.status).toBe(200)
    expect(updatePublic).toHaveBeenCalledExactlyOnceWith({ theme: "dark" })

    // The desktop host itself is not restricted.
    const desktop = await patchSettings(LOCAL_HEADERS, {
      auto_trust_workspaces: true,
    })
    expect(desktop.status).toBe(200)
  })

  it("rejects every remote permission mutation while retaining owner access and remote reads", async () => {
    const deleteGrant = vi.fn(() => true)
    const setWorkspaceTrust = vi.fn((body) => body)
    const { app } = makeApp({ agentPermissions: {
      deleteGrant, setWorkspaceTrust, listGrants: () => [],
    } })
    for (const route of [
      "claude-rules/delete", "session-rules/delete", "grants/upsert",
      "grants/delete", "workspace-trust/set", "workspace-trust/ensure",
    ]) {
      const response = await app.request(`/api/v1/permissions/${route}`, {
        method: "POST", headers: REMOTE_HEADERS,
        body: JSON.stringify({ id: "owner-deny-rule", workspacePath: "C:\\repo", state: "trusted" }),
      })
      expect(response.status, route).toBe(403)
    }
    expect(deleteGrant).not.toHaveBeenCalled()
    expect(setWorkspaceTrust).not.toHaveBeenCalled()
    const owner = await app.request("/api/v1/permissions/grants/delete", {
      method: "POST", headers: LOCAL_HEADERS, body: JSON.stringify({ id: "owner-deny-rule" }),
    })
    expect(owner.status).toBe(200)
    expect(deleteGrant).toHaveBeenCalledExactlyOnceWith("owner-deny-rule")
    const read = await app.request("/api/v1/permissions/grants/list", {
      method: "POST", headers: REMOTE_HEADERS, body: "{}",
    })
    expect(read.status).toBe(200)
  })

  it("does not let a remote session register a workspace root by saving a thread", async () => {
    const registered = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-root-in-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-root-out-"))
    temporaryDirectories.push(registered, outside)
    const save = vi.fn()
    const { app } = makeApp({
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: {
        persistUserMessageForTurn: vi.fn(),
        listProjects: () => [],
        listThreads: () => [],
        save,
        upsertThreadMeta: vi.fn(),
      },
    })
    const saveThread = (headers: Record<string, string>, projectPath: string) =>
      app.request("/api/v1/threads", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "thread-phone",
          title: "From the phone",
          projectName: "somewhere",
          projectPath,
          createdAt: "2026-05-20T08:00:00.000Z",
          updatedAt: "2026-05-20T08:00:00.000Z",
        }),
      })

    // Registered roots are derived from saved threads, so this would have
    // been a registration the desktop never made.
    const blocked = await saveThread(REMOTE_HEADERS, outside)
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: "workspace_not_registered" })
    expect(save).not.toHaveBeenCalled()

    const allowed = await saveThread(REMOTE_HEADERS, registered)
    expect(allowed.status).toBe(204)
    expect(save).toHaveBeenCalledOnce()

    // The desktop opening a folder is the registration.
    const desktop = await saveThread(LOCAL_HEADERS, outside)
    expect(desktop.status).toBe(204)
  })

  it("authenticates a request once even when the route asks for the identity again", async () => {
    const { app, authenticate } = makeApp()

    const response = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: REMOTE_HEADERS,
      body: JSON.stringify({ patch: { remote_access_enabled: false } }),
    })

    // The route consults the identity to refuse remote host changes; that
    // must not be a second credential lookup.
    expect(response.status).toBe(403)
    expect(authenticate).toHaveBeenCalledTimes(1)
  })
})

describe("rate limited third-party endpoints", () => {
  it("limits key validation per caller identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    )
    const { app } = makeApp()
    const statuses: number[] = []
    for (let index = 0; index < 11; index += 1) {
      const response = await app.request("/api/v1/providers/validate-key", {
        method: "POST",
        headers: LOCAL_HEADERS,
        body: JSON.stringify({ kind: "openai", apiKey: "sk-test" }),
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses[10]).toBe(429)

    // A different identity has its own bucket.
    const remote = await app.request("/api/v1/providers/validate-key", {
      method: "POST",
      headers: REMOTE_HEADERS,
      body: JSON.stringify({ kind: "openai", apiKey: "sk-test" }),
    })
    expect(remote.status).toBe(200)
  })

  it("limits Deepgram token minting before the route runs", async () => {
    const { app } = makeApp()
    const statuses: number[] = []
    for (let index = 0; index < 11; index += 1) {
      const response = await app.request("/api/v1/settings/deepgram-token", {
        method: "POST",
        headers: LOCAL_HEADERS,
      })
      statuses.push(response.status)
    }
    // No key configured → 400 from the route; the eleventh never reaches it.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400))
    expect(statuses[10]).toBe(429)
  })

  it("limits unauthenticated bootstrap probing per non-loopback peer", async () => {
    // Freeze the clock: 601 requests take longer than the bucket's 100 ms
    // refill interval, so against real time the last probe would be admitted.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const { app } = makeApp()
      // The desktop renderer polls bootstrap from loopback and is never
      // throttled; a scanner on the network shares one large per-peer bucket.
      for (let index = 0; index < 31; index += 1) {
        expect((await app.request("/api/v1/remote/bootstrap")).status).toBe(200)
      }
      const scanner = { incoming: { socket: { remoteAddress: "198.51.100.7" } } }
      const url = "http://203.0.113.9:3773/api/v1/remote/bootstrap"
      const statuses: number[] = []
      for (let index = 0; index < 601; index += 1) {
        statuses.push((await app.request(url, {}, scanner)).status)
      }
      expect(statuses.slice(0, 600).every((status) => status === 200)).toBe(true)
      expect(statuses[600]).toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })
})
