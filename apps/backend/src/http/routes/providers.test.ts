import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { logger } from "../../observability/logger"

const openRouterMocks = vi.hoisted(() => ({
  getOpenRouterCatalogModels: vi.fn(async () => []),
}))
vi.mock(
  "../../provider/adapters/openRouterModelDiscovery",
  () => openRouterMocks
)
vi.mock("../../auth/keyResolution", () => ({
  resolveOpenRouterKey: () => ({ key: "sk-or-configured" }),
}))

import { registerProvidersRoutes } from "./providers"

function registerProviderTestRoutes(state: AppState): Hono {
  const app = new Hono()
  app.onError((error, c) => {
    const possibleHttpError = error as unknown as {
      statusCode?: unknown
    }
    const statusCode =
      typeof possibleHttpError.statusCode === "number"
        ? possibleHttpError.statusCode
        : 500
    return c.json({ error: error.message }, statusCode as 400 | 403 | 500 | 503)
  })
  registerProvidersRoutes(app, state)
  return app
}

describe("provider routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("applies API provider visibility to picker models while preserving the settings catalog and CLI models", async () => {
    const state = {
      providers: {
        listModelsLive: async () => [
          { provider: "openai", slug: "gpt-visible", name: "Visible" },
          { provider: "openai", slug: "gpt-hidden", name: "Hidden" },
          { provider: "grok", slug: "grok-test", name: "Grok" },
          { provider: "codex", slug: "gpt-hidden", name: "Codex" },
        ],
      },
      settings: {
        get: () => ({
          providers: {
            openai: {
              enabled: true,
              hidden_models: ["gpt-hidden", "gpt-custom-hidden"],
              custom_models: ["gpt-visible", "gpt-custom", "gpt-custom-hidden"],
            },
            grok: { enabled: false, custom_models: ["grok-custom"] },
          },
        }),
      },
    } as unknown as AppState
    const app = registerProviderTestRoutes(state)
    expect(await (await app.request("/models")).json()).toEqual([
      { provider: "openai", slug: "gpt-visible", name: "Visible" },
      { provider: "codex", slug: "gpt-hidden", name: "Codex" },
      {
        provider: "openai",
        slug: "gpt-custom",
        name: "gpt-custom",
        isCustom: true,
      },
    ])
    const settingsModels = (await (
      await app.request("/models?includeHidden=1")
    ).json()) as Array<{ provider: string; slug: string }>
    expect(settingsModels).toHaveLength(7)
    expect(
      settingsModels.some((model) => model.slug === "gpt-custom-hidden")
    ).toBe(true)
    expect(settingsModels.some((model) => model.slug === "grok-test")).toBe(
      true
    )
  })

  it("does not expose raw key-probe failures to clients", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "request failed with Authorization: Bearer sk-sensitive at C:\\private\\provider.json"
        )
      })
    )
    const app = new Hono()
    registerProvidersRoutes(app, {} as AppState)

    const response = await app.request("/providers/validate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "openai",
        apiKey: "sk-sensitive",
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      ok: true,
      valid: false,
      status: 0,
      error: "provider credential validation failed",
    })
    expect(JSON.stringify(body)).not.toContain("sk-sensitive")
    expect(JSON.stringify(body)).not.toContain("provider.json")
  })

  it.each([200, 400, 401, 403, 429, 500, 503])(
    "only confirms successful key probes and cancels status %i bodies",
    async (status) => {
      const cancel = vi.fn()
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(new ReadableStream({ cancel }), { status })
        )
      )
      const app = new Hono()
      registerProvidersRoutes(app, {} as AppState)
      const response = await app.request("/providers/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "google", apiKey: "test-key" }),
      })
      expect(await response.json()).toEqual({
        ok: true,
        valid: status === 200,
        status,
      })
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ["openrouter", "https://openrouter.ai/api/v1/key"],
    ["anthropic", "https://api.anthropic.com/v1/models?limit=1"],
  ])(
    "probes authenticated metadata for %s without generating text",
    async (kind, url) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
      vi.stubGlobal("fetch", fetchMock)
      const app = new Hono()
      registerProvidersRoutes(app, {} as AppState)
      await app.request("/providers/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, apiKey: "test-key" }),
      })
      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ method: "GET", body: undefined })
      )
    }
  )

  it("rejects an unknown provider kind instead of vouching for its key", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const app = new Hono()
    registerProvidersRoutes(app, {} as AppState)

    const response = await app.request("/providers/validate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "not-a-provider", apiKey: "sk-test" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, valid: false })
    expect(fetchMock).not.toHaveBeenCalled()

    const oversized = await app.request("/providers/validate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "openai", apiKey: "x".repeat(5_000) }),
    })
    expect(oversized.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("only stores or clears credentials under known provider ids", async () => {
    const set = vi.fn()
    const remove = vi.fn()
    const app = new Hono()
    registerProvidersRoutes(app, {
      authStore: { set, remove },
    } as unknown as AppState)

    const unknown = await app.request("/providers/evil%20provider/credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: "sk-test" }),
    })
    expect(unknown.status).toBe(400)
    expect(set).not.toHaveBeenCalled()

    const unknownDelete = await app.request("/providers/nope/credential", {
      method: "DELETE",
    })
    expect(unknownDelete.status).toBe(400)
    expect(remove).not.toHaveBeenCalled()

    const known = await app.request("/providers/openrouter/credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: "sk-test" }),
    })
    expect(known.status).toBe(200)
    expect(set).toHaveBeenCalledWith("openrouter", {
      type: "api",
      key: "sk-test",
    })
  })

  it("validates the provider instance id and cwd query before touching the hub", async () => {
    const getInstance = vi.fn()
    const app = new Hono()
    registerProvidersRoutes(app, {
      providerHub: { getInstance },
    } as unknown as AppState)

    for (const route of [
      `/providers/instances/${encodeURIComponent("bad id/with slash")}/refresh`,
      `/providers/instances/${"a".repeat(129)}/update`,
      `/providers/instances/codex/refresh?cwd=${"c".repeat(4_100)}`,
    ]) {
      const response = await app.request(route, { method: "POST" })
      expect(response.status, route).toBe(400)
    }
    expect(getInstance).not.toHaveBeenCalled()
  })

  it("reports an OpenRouter catalog failure instead of an empty catalog", async () => {
    const errorLog = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined)
    openRouterMocks.getOpenRouterCatalogModels.mockRejectedValueOnce(
      new Error("openrouter models 401 for key sk-or-revoked")
    )
    const app = new Hono()
    registerProvidersRoutes(app, {
      settings: { get: () => ({}) },
    } as unknown as AppState)

    const response = await app.request("/openrouter/models")

    expect(response.status).toBe(502)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty("data")
    expect(body).toMatchObject({ code: "openrouter_unavailable" })
    expect(JSON.stringify(body)).not.toContain("sk-or-revoked")
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sk-or-revoked")
  })

  it("uses the bounded LM Studio probe response without fetching models twice", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: " local-model ", extra: "discarded" },
              { id: "" },
              { nope: "invalid" },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const app = new Hono()
    registerProvidersRoutes(app, {} as AppState)

    const response = await app.request("/lmstudio/models")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: "local-model" }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects oversized LM Studio responses for every loopback candidate", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(512 * 1024 + 1) },
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const app = new Hono()
    registerProvidersRoutes(app, {} as AppState)

    const response = await app.request("/lmstudio/models")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ error: "not_running" })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("does not expose duck-typed provider failure details during updates", async () => {
    const internalMessage =
      "backend failed at C:\\private\\provider.json with token sk-sensitive"
    const state = {
      providerHub: {
        getInstance: () => ({ instanceId: "codex", enabled: true }),
        updateProviderInstance: vi.fn(async () => {
          throw Object.assign(new Error(internalMessage), {
            statusCode: 503,
            code: "provider_backend_quarantined",
          })
        }),
      },
    } as unknown as AppState
    const app = new Hono()
    registerProvidersRoutes(app, state)

    const response = await app.request("/providers/instances/codex/update", {
      method: "POST",
    })
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      error: "provider update failed",
      code: "provider_backend_quarantined",
    })
    expect(JSON.stringify(body)).not.toContain("provider.json")
    expect(JSON.stringify(body)).not.toContain("sk-sensitive")
  })

  it("rejects unregistered cwd values before provider metadata hooks run", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-provider-outside-")
    )
    const listInstances = vi.fn(async () => [])
    const modelsForInstance = vi.fn(async () => [])
    const refreshInstanceMetadata = vi.fn(async () => null)
    const updateProviderInstance = vi.fn(async () => ({
      providers: [],
    }))
    const state = {
      projectProjections: { listAll: () => [] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
      providerHub: {
        getInstance: () => ({ instanceId: "codex", enabled: true }),
        listInstances,
        modelsForInstance,
        refreshInstanceMetadata,
        updateProviderInstance,
      },
    } as unknown as AppState
    const app = registerProviderTestRoutes(state)
    const encodedCwd = encodeURIComponent(outside)

    try {
      for (const [method, route] of [
        ["GET", `/providers/instances?cwd=${encodedCwd}`],
        ["GET", `/providers/instances/codex/models?cwd=${encodedCwd}`],
        ["POST", `/providers/instances/codex/refresh?cwd=${encodedCwd}`],
        ["POST", `/providers/instances/codex/update?cwd=${encodedCwd}`],
      ] as const) {
        const response = await app.request(route, { method })
        expect(response.status, `${method} ${route}`).toBe(403)
      }

      expect(listInstances).not.toHaveBeenCalled()
      expect(modelsForInstance).not.toHaveBeenCalled()
      expect(refreshInstanceMetadata).not.toHaveBeenCalled()
      expect(updateProviderInstance).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("passes the canonical registered target for an approved symlink cwd", async () => {
    const registered = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-provider-project-")
    )
    const aliasParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-provider-alias-")
    )
    const alias = path.join(aliasParent, "project")
    const listInstances = vi.fn(async () => [])
    const state = {
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
      providerHub: { listInstances },
    } as unknown as AppState
    const app = registerProviderTestRoutes(state)

    try {
      await fs.symlink(
        registered,
        alias,
        process.platform === "win32" ? "junction" : "dir"
      )
      const response = await app.request(
        `/providers/instances?cwd=${encodeURIComponent(alias)}`
      )

      expect(response.status).toBe(200)
      expect(listInstances).toHaveBeenCalledWith({
        cwd: await fs.realpath(registered),
      })
    } finally {
      await fs.rm(aliasParent, { recursive: true, force: true })
      await fs.rm(registered, { recursive: true, force: true })
    }
  })

  it("fails closed with a safe 503 when project provider policy loading fails", async () => {
    const registered = await fs.mkdtemp(
      path.join(os.tmpdir(), "bc0de-provider-policy-")
    )
    await fs.writeFile(
      path.join(registered, "BetterC0de.json"),
      JSON.stringify({ enabled_providers: "openai" }),
      "utf8"
    )
    const listInstances = vi.fn(async () => [])
    const state = {
      projectProjections: { listAll: () => [{ path: registered }] },
      threads: { listProjects: () => [] },
      worktreeRegistry: { listAll: () => [] },
      providerHub: { listInstances },
    } as unknown as AppState
    const app = registerProviderTestRoutes(state)

    try {
      const response = await app.request(
        `/providers/instances?cwd=${encodeURIComponent(registered)}`
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: "Project provider policy could not be loaded.",
      })
      expect(listInstances).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(registered, { recursive: true, force: true })
    }
  })
})
