import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { normalizeNineRouterBaseUrl } from "@betterc0de/schema"
import { __resetMasterKeyCache } from "../../settings/crypto"
import { SettingsService } from "../../settings/service"
import {
  nineRouterConnectionIdFromName,
  pickNineRouterConnection,
} from "./connections"
import { NineRouterModelCatalog } from "./modelCatalog"
import { NineRouterService } from "./service"

const MODELS = {
  data: [
    {
      id: "cc/claude-opus-5-5",
      owned_by: "cc",
      capabilities: { reasoning: true, thinkingFormat: "claude-adaptive" },
    },
  ],
}

function routerFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/api/health"))
      return new Response(JSON.stringify({ ok: true }))
    if (url.endsWith("/api/version"))
      return new Response(JSON.stringify({ currentVersion: "0.5.95" }))
    return new Response(JSON.stringify(MODELS))
  })
}

describe("normalizeNineRouterBaseUrl", () => {
  it.each([
    ["localhost:20128", "http://localhost:20128/v1"],
    ["http://localhost:20128", "http://localhost:20128/v1"],
    ["http://localhost:20128/", "http://localhost:20128/v1"],
    ["http://localhost:20128/v1/", "http://localhost:20128/v1"],
    ["http://localhost:20128/v1/v1", "http://localhost:20128/v1"],
    ["http://localhost:20128/dashboard/keys", "http://localhost:20128/v1"],
    [
      "https://r1a2b3.abc-tunnel.us/v1/chat/completions",
      "https://r1a2b3.abc-tunnel.us/v1",
    ],
    [
      "https://proxy.example.com/9router?x=1",
      "https://proxy.example.com/9router/v1",
    ],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeNineRouterBaseUrl(raw)).toBe(expected)
  })

  it.each(["", "ftp://host", "http://user:pass@host:20128", "http://"])(
    "rejects %s",
    (raw) => {
      expect(normalizeNineRouterBaseUrl(raw)).toBeNull()
    }
  )
})

describe("nineRouterConnectionIdFromName", () => {
  it("derives readable unique ids", () => {
    expect(nineRouterConnectionIdFromName("My VPS", [])).toBe("my-vps")
    expect(nineRouterConnectionIdFromName("My VPS", ["my-vps"])).toBe(
      "my-vps-2"
    )
    expect(nineRouterConnectionIdFromName("9 Router", [])).toBe("router")
    expect(nineRouterConnectionIdFromName("!!!", [])).toBe("router")
  })
})

describe("NineRouterService", () => {
  let dir: string
  let filePath: string
  let settings: SettingsService

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-9router-"))
    filePath = path.join(dir, "settings.json")
    vi.stubEnv(
      "BETTERC0DE_SETTINGS_KEY",
      Buffer.alloc(32, 9).toString("base64")
    )
    __resetMasterKeyCache()
    settings = new SettingsService(filePath)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    __resetMasterKeyCache()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function service(fetchImpl = routerFetch()) {
    return new NineRouterService(
      settings,
      new NineRouterModelCatalog(fetchImpl as unknown as typeof fetch),
      fetchImpl as unknown as typeof fetch
    )
  }

  it("creates a checked connection and never returns or stores the key in plaintext", async () => {
    const created = await service().create({
      name: "VPS",
      baseUrl: "https://router.example.com",
      apiKey: "sk-secret-key",
    })
    expect(created).toMatchObject({
      id: "vps",
      baseUrl: "https://router.example.com/v1",
      dashboardUrl: "https://router.example.com/dashboard",
      secret: { configured: true, storage: "encrypted" },
      status: { state: "online", version: "0.5.95", modelCount: 1 },
      models: [{ slug: "cc/claude-opus-5-5", tier: "Claude Code" }],
    })
    expect(JSON.stringify(created)).not.toContain("sk-secret-key")
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("sk-secret-key")
    expect(JSON.stringify(settings.getPublic())).not.toContain("sk-secret-key")
    expect(pickNineRouterConnection(settings.get(), "vps").apiKey).toBe(
      "sk-secret-key"
    )
  })

  it("requires the key again before a connection moves to a new URL", async () => {
    const routers = service()
    await routers.create({
      name: "VPS",
      baseUrl: "https://router.example.com/v1",
      apiKey: "sk-secret-key",
    })
    await expect(
      routers.update("vps", { baseUrl: "https://evil.example.net/v1" })
    ).rejects.toThrow("Re-enter the API key")
    // The generic settings patch enforces the same rule.
    expect(() =>
      settings.update({
        providers: {
          ninerouter: {
            connections: [
              {
                id: "vps",
                name: "VPS",
                base_url: "https://evil.example.net/v1",
              },
            ],
          },
        },
      })
    ).toThrow("URL cannot change while preserving its stored API key")
    const moved = await routers.update("vps", {
      baseUrl: "https://router2.example.com",
      apiKey: { set: "sk-new-key" },
    })
    expect(moved.baseUrl).toBe("https://router2.example.com/v1")
    expect(pickNineRouterConnection(settings.get(), "vps").apiKey).toBe(
      "sk-new-key"
    )
  })

  it("keeps other connections' keys when one connection changes", async () => {
    const routers = service()
    await routers.create({
      name: "Laptop",
      baseUrl: "http://localhost:20128/v1",
    })
    await routers.create({
      name: "VPS",
      baseUrl: "https://router.example.com/v1",
      apiKey: "sk-secret-key",
    })
    await routers.update("laptop", {
      name: "Desk",
      customModels: ["cx/gpt-5.5(xhigh)", "cx/gpt-5.5(xhigh)"],
      hiddenModels: ["cc/claude-opus-5-5"],
    })
    expect(pickNineRouterConnection(settings.get(), "vps").apiKey).toBe(
      "sk-secret-key"
    )
    const view = await routers.view({ includeHidden: true })
    const laptop = view.connections.find((entry) => entry.id === "laptop")!
    expect(laptop).toMatchObject({
      name: "Desk",
      customModels: ["cx/gpt-5.5(xhigh)"],
      secret: { configured: false },
    })
    expect(
      laptop.models.find((model) => model.slug === "cc/claude-opus-5-5")
    ).toMatchObject({ hidden: true })
    const visible = await routers.view()
    expect(
      visible.connections
        .find((entry) => entry.id === "laptop")!
        .models.map((model) => model.slug)
    ).toEqual(["cx/gpt-5.5(xhigh)"])
  })

  it("removes a connection", async () => {
    const routers = service()
    await routers.create({ name: "Laptop", baseUrl: "localhost:20128" })
    const view = await routers.remove("laptop")
    expect(view.connections).toEqual([])
    await expect(routers.remove("laptop")).rejects.toThrow("not found")
  })

  it("rejects an address that is not http(s)", async () => {
    await expect(
      service().create({ name: "Bad", baseUrl: "ftp://router" })
    ).rejects.toThrow("Enter the 9Router address")
  })

  it("detects a local router and whether it is already connected", async () => {
    const fetchImpl = routerFetch()
    const routers = service(fetchImpl)
    expect(await routers.detect()).toEqual({
      found: true,
      baseUrl: "http://localhost:20128/v1",
      version: "0.5.95",
      alreadyConnected: false,
    })
    await routers.create({ name: "Laptop", baseUrl: "127.0.0.1:20128" })
    expect((await routers.detect()).alreadyConnected).toBe(true)
  })

  it("reports no router when nothing answers locally", async () => {
    const routers = service(
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )
    expect(await routers.detect()).toMatchObject({ found: false })
  })
})
