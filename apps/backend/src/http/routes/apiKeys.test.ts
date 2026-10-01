import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { SettingsService } from "../../settings/service"
import { __resetMasterKeyCache } from "../../settings/crypto"
import { registerApiKeyRoutes } from "./apiKeys"
import { apiKeyPoolViewSchema } from "@betterc0de/schema"

const keyResponse = async (response: Response) =>
  apiKeyPoolViewSchema.parse(await response.json())

const directories: string[] = []
beforeEach(() => {
  vi.stubEnv("BETTERC0DE_SETTINGS_KEY", Buffer.alloc(32, 19).toString("base64"))
  __resetMasterKeyCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  __resetMasterKeyCache()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-key-route-")
  )
  directories.push(directory)
  const settings = new SettingsService(path.join(directory, "settings.json"))
  const api = new Hono()
  api.onError((error, c) =>
    c.json(
      { error: error.message },
      ((error as { statusCode?: number }).statusCode as 400 | 403 | 404) || 500
    )
  )
  registerApiKeyRoutes(api, {
    settings,
    config: { authToken: "desktop-test" },
  } as AppState)
  const request = (suffix = "", method = "GET", body?: unknown, owner = true) =>
    api.request(`/providers/api-keys/openai${suffix}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(owner ? { Authorization: "Bearer desktop-test" } : {}),
      },
      ...(body !== undefined && method !== "GET"
        ? { body: JSON.stringify(body) }
        : {}),
    })
  return { settings, api, request }
}
describe("owner API-key routes", () => {
  it("rejects unauthenticated reads and every credential mutation before touching storage or upstream", async () => {
    const { request } = fixture()
    const upstream = vi.fn()
    vi.stubGlobal("fetch", upstream)
    for (const [suffix, method] of [
      ["", "GET"],
      ["", "POST"],
      ["", "DELETE"],
      ["/id", "PATCH"],
      ["/id", "DELETE"],
      ["/order", "PUT"],
      ["/id/test", "POST"],
      ["/id/retry", "POST"],
    ])
      expect((await request(suffix, method, {}, false)).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
  it("adds, edits, reorders, disables, and removes keys with no secret in responses", async () => {
    const { request, settings } = fixture()
    const first = await request("", "POST", {
      label: "Primary",
      apiKey: "synthetic-primary",
    })
    expect(first.status).toBe(200)
    const initial = await keyResponse(first)
    const second = await request("", "POST", {
      label: "Backup",
      apiKey: "synthetic-backup",
    })
    const added = await keyResponse(second)
    const id = initial.keys[0].id
    expect(JSON.stringify(added)).not.toContain("synthetic-")
    expect(
      (
        await request(`/${id}`, "PATCH", {
          label: "Renamed",
          enabled: false,
          apiKey: "synthetic-replacement",
        })
      ).status
    ).toBe(200)
    expect(settings.get().providers.openai.api_keys?.[0].enabled).toBe(false)
    expect(
      (
        await request("/order", "PUT", {
          ids: added.keys.map((key: { id: string }) => key.id).reverse(),
        })
      ).status
    ).toBe(200)
    expect((await request(`/${id}`, "DELETE")).status).toBe(200)
    expect(settings.get().providers.openai.api_keys).toHaveLength(1)
  })
  it("rejects unsupported providers, malformed bodies, and unbounded credentials", async () => {
    const { api, request } = fixture()
    for (const body of [
      { label: "Key", apiKey: "" },
      { label: "Key", apiKey: "a".repeat(4097) },
      { label: "Key", apiKey: "test", other: true },
    ])
      expect((await request("", "POST", body)).status).toBe(400)
    expect(
      (
        await api.request("/providers/api-keys/codex", {
          headers: { Authorization: "Bearer desktop-test" },
        })
      ).status
    ).toBe(400)
  })
  it("checks the stored key in the backend and returns only safe status", async () => {
    const { request } = fixture()
    const added = await keyResponse(
      await request("", "POST", { label: "Key", apiKey: "synthetic-secret" })
    )
    const upstream = vi.fn(async () => new Response("{}", { status: 401 }))
    vi.stubGlobal("fetch", upstream)
    const response = await request(`/${added.keys[0].id}/test`, "POST")
    const checked = await keyResponse(response)
    expect(checked.keys[0].status).toBe("invalid")
    expect(JSON.stringify(checked)).not.toContain("synthetic-secret")
    expect(upstream.mock.calls[0]).toMatchObject([
      "https://api.openai.com/v1/models",
      { headers: { Authorization: "Bearer synthetic-secret" } },
    ])
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}"))
    )
    expect(
      (await keyResponse(await request(`/${added.keys[0].id}/test`, "POST")))
        .keys[0].status
    ).toBe("ready")
  })
  it.each([400, 403])(
    "surfaces a safe failed-check message for status %i without changing key eligibility",
    async (status) => {
      const { request } = fixture()
      const added = await keyResponse(
        await request("", "POST", { label: "Key", apiKey: "synthetic-secret" })
      )
      const upstream = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "Permission denied for synthetic-secret" },
            }),
            { status }
          )
      )
      vi.stubGlobal("fetch", upstream)
      const response = await request(`/${added.keys[0].id}/test`, "POST")
      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).toContain("Check account permissions")
      expect(body).not.toContain("synthetic-secret")
      expect((await keyResponse(await request())).keys[0].status).toBe(
        "untested"
      )
      expect(upstream).toHaveBeenCalledOnce()
    }
  )
  it("honors rate-limit delays and requires an explicit retry after quota recovery", async () => {
    const { request } = fixture()
    const added = await keyResponse(
      await request("", "POST", { label: "Key", apiKey: "synthetic-secret" })
    )
    const id = added.keys[0].id
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "credit_balance_exhausted" } }),
            { status: 429 }
          )
      )
    )
    expect(
      (await keyResponse(await request(`/${id}/test`, "POST"))).keys[0].status
    ).toBe("quota")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}"))
    )
    expect(
      (await keyResponse(await request(`/${id}/test`, "POST"))).keys[0].status
    ).toBe("quota")
    expect(
      (await keyResponse(await request(`/${id}/retry`, "POST"))).keys[0].status
    ).toBe("untested")
    const upstream = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "120" } })
    )
    vi.stubGlobal("fetch", upstream)
    await request(`/${id}/test`, "POST")
    expect((await request(`/${id}/test`, "POST")).status).toBe(409)
    expect((await request(`/${id}/retry`, "POST")).status).toBe(409)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})
