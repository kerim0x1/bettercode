import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nineRouterProviderViewSchema } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { SettingsService } from "../../settings/service"
import { __resetMasterKeyCache } from "../../settings/crypto"
import { NineRouterModelCatalog } from "../../provider/ninerouter/modelCatalog"
import { NineRouterService } from "../../provider/ninerouter/service"
import { registerNineRouterRoutes } from "./ninerouter"

const directories: string[] = []
beforeEach(() => {
  vi.stubEnv("BETTERC0DE_SETTINGS_KEY", Buffer.alloc(32, 23).toString("base64"))
  __resetMasterKeyCache()
})
afterEach(() => {
  vi.unstubAllEnvs()
  __resetMasterKeyCache()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-9router-route-")
  )
  directories.push(directory)
  const settings = new SettingsService(path.join(directory, "settings.json"))
  const upstream = vi.fn(async (url: string) =>
    url.endsWith("/models")
      ? new Response(
          JSON.stringify({
            data: [{ id: "cc/claude-opus-5-5", owned_by: "cc" }],
          })
        )
      : new Response(JSON.stringify({ ok: true }))
  )
  const fetchImpl = upstream as unknown as typeof fetch
  const api = new Hono()
  api.onError((error, c) =>
    c.json(
      { error: error.message },
      ((error as { statusCode?: number }).statusCode as 400 | 403 | 404) || 500
    )
  )
  registerNineRouterRoutes(api, {
    settings,
    config: { authToken: "desktop-test" },
    nineRouter: new NineRouterService(
      settings,
      new NineRouterModelCatalog(fetchImpl),
      fetchImpl
    ),
  } as unknown as AppState)
  const request = (
    pathname: string,
    method = "GET",
    body?: unknown,
    owner = true
  ) =>
    api.request(`/providers/ninerouter${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(owner ? { Authorization: "Bearer desktop-test" } : {}),
      },
      ...(body !== undefined && method !== "GET"
        ? { body: JSON.stringify(body) }
        : {}),
    })
  return { request, upstream }
}

describe("9Router routes", () => {
  it("keeps connection management and local detection desktop-only", async () => {
    const { request, upstream } = fixture()
    for (const [pathname, method] of [
      ["/connections", "POST"],
      ["/connections/laptop", "PATCH"],
      ["/connections/laptop", "DELETE"],
      ["/connections/laptop/test", "POST"],
      ["/detect", "GET"],
    ])
      expect((await request(pathname, method, {}, false)).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("adds a connection for the owner and lists it with models", async () => {
    const { request } = fixture()
    const created = await request("/connections", "POST", {
      name: "Laptop",
      baseUrl: "http://localhost:20128",
      apiKey: "sk-route-secret",
    })
    expect(created.status).toBe(200)
    const text = await created.text()
    expect(text).not.toContain("sk-route-secret")
    const view = nineRouterProviderViewSchema.parse(
      await (await request("")).json()
    )
    expect(view.connections[0]).toMatchObject({
      id: "laptop",
      baseUrl: "http://localhost:20128/v1",
      models: [{ slug: "cc/claude-opus-5-5" }],
    })
  })

  it("hides router addresses from paired devices", async () => {
    const { request } = fixture()
    await request("/connections", "POST", {
      name: "VPS",
      baseUrl: "https://router.internal.example/v1",
    })
    const remote = await request("", "GET", undefined, false)
    const body = nineRouterProviderViewSchema.parse(await remote.json())
    expect(body.connections[0]).toMatchObject({
      id: "vps",
      baseUrl: "",
      dashboardUrl: "",
    })
    expect(JSON.stringify(body)).not.toContain("router.internal.example")
  })

  it("validates connection ids and bodies", async () => {
    const { request } = fixture()
    expect((await request("/connections/Not_Valid", "DELETE")).status).toBe(400)
    expect(
      (await request("/connections", "POST", { name: "", baseUrl: "x" })).status
    ).toBe(400)
    expect(
      (await request("/connections/missing", "PATCH", { name: "New" })).status
    ).toBe(404)
  })
})
