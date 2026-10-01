import { describe, expect, it, vi } from "vitest"
import {
  NineRouterModelCatalog,
  mapNineRouterModels,
  nineRouterConnectionModels,
} from "./modelCatalog"
import type { ResolvedNineRouterConnection } from "./connections"

const connection: ResolvedNineRouterConnection = {
  id: "laptop",
  name: "Laptop",
  baseUrl: "http://localhost:20128/v1",
  apiKey: "sk-test",
  enabled: true,
  tokenSaver: true,
  customModels: [],
  hiddenModels: [],
}

const MODELS = {
  object: "list",
  data: [
    {
      id: "premium-coding",
      object: "model",
      owned_by: "combo",
      capabilities: {
        vision: true,
        tools: true,
        reasoning: true,
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: true,
      },
      context_length: 200000,
    },
    {
      id: "cc/claude-opus-5-5",
      object: "model",
      owned_by: "cc",
      capabilities: {
        vision: true,
        reasoning: true,
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: true,
      },
      context_length: 1000000,
    },
    {
      id: "cx/gpt-5.5-codex",
      owned_by: "cx",
      capabilities: {
        reasoning: true,
        thinkingFormat: "openai",
        thinkingCanDisable: false,
      },
    },
    {
      id: "glm/glm-5.3",
      owned_by: "glm",
      capabilities: { reasoning: true, thinkingFormat: "zai" },
    },
    { id: "kr/fast-model", owned_by: "kr", capabilities: { reasoning: false } },
    { id: "gh/partial", owned_by: "gh", capabilities: { tools: true } },
    { id: "pplx/search", owned_by: "pplx", kind: "webSearch" },
    { id: "cc/claude-opus-5-5", owned_by: "cc" },
  ],
}

function descriptorOptions(model: { capabilities: Record<string, unknown> }) {
  const descriptors = model.capabilities.optionDescriptors as Array<{
    options: Array<{ id: string; label: string; isDefault?: boolean }>
    currentValue?: string
  }>
  return descriptors[0]
}

describe("mapNineRouterModels", () => {
  const models = mapNineRouterModels(MODELS.data)
  const byId = new Map(models.map((model) => [model.slug, model]))

  it("groups combos first and accounts by prefix, skipping tools and duplicates", () => {
    expect(models.map((model) => [model.slug, model.tier])).toEqual([
      ["premium-coding", "Combos"],
      ["cc/claude-opus-5-5", "Claude Code"],
      ["cx/gpt-5.5-codex", "Codex"],
      ["glm/glm-5.3", "Z.ai GLM"],
      ["kr/fast-model", "Kiro"],
      ["gh/partial", "GitHub Copilot"],
    ])
  })

  it("labels context windows and maps vision to attachments", () => {
    expect(byId.get("cc/claude-opus-5-5")).toMatchObject({
      context: "1M",
      capabilities: { attachment: true },
    })
    expect(byId.get("premium-coding")?.context).toBe("200K")
    expect(byId.get("cx/gpt-5.5-codex")?.capabilities.attachment).toBe(
      undefined
    )
  })

  it("offers adaptive thinking for Claude models and defaults to it", () => {
    const descriptor = descriptorOptions(byId.get("cc/claude-opus-5-5")!)
    expect(descriptor.options.map((option) => option.id)).toEqual([
      "auto",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(descriptor.currentValue).toBe("auto")
    expect(descriptor.options[0]).toMatchObject({
      label: "Auto (adaptive)",
      isDefault: true,
    })
  })

  it("follows 9Router's per-model levels and disable rules", () => {
    const codex = descriptorOptions(byId.get("cx/gpt-5.5-codex")!)
    expect(codex.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(codex.currentValue).toBe("medium")
    const glm = descriptorOptions(byId.get("glm/glm-5.3")!)
    expect(glm.options.map((option) => [option.id, option.label])).toEqual([
      ["none", "Off"],
      ["high", "On"],
    ])
  })

  it("marks non-reasoning models with an empty descriptor list", () => {
    expect(byId.get("kr/fast-model")?.capabilities.optionDescriptors).toEqual(
      []
    )
  })

  it("offers the generic ladder when capabilities are partial", () => {
    const partial = descriptorOptions(byId.get("gh/partial")!)
    expect(partial.options.map((option) => option.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })
})

describe("nineRouterConnectionModels", () => {
  const catalog = mapNineRouterModels(MODELS.data)

  it("appends custom ids and hides hidden ones unless asked", () => {
    const models = nineRouterConnectionModels(catalog, {
      customModels: ["cx/gpt-5.5(xhigh)", "cc/claude-opus-5-5"],
      hiddenModels: ["kr/fast-model"],
    })
    expect(models.some((model) => model.slug === "kr/fast-model")).toBe(false)
    expect(models.at(-1)).toMatchObject({
      slug: "cx/gpt-5.5(xhigh)",
      tier: "Custom",
      isCustom: true,
    })
    expect(
      models.filter((model) => model.slug === "cc/claude-opus-5-5")
    ).toHaveLength(1)
    const all = nineRouterConnectionModels(
      catalog,
      { customModels: [], hiddenModels: ["kr/fast-model"] },
      { includeHidden: true }
    )
    expect(all.find((model) => model.slug === "kr/fast-model")?.hidden).toBe(
      true
    )
  })
})

describe("NineRouterModelCatalog", () => {
  it("loads, caches and reports an online router", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(MODELS), { status: 200 })
    )
    const catalog = new NineRouterModelCatalog(
      fetchMock as unknown as typeof fetch
    )
    const first = await catalog.list(connection)
    const second = await catalog.list(connection)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("http://localhost:20128/v1/models")
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test"
    )
    expect(catalog.status(connection)).toMatchObject({
      state: "online",
      modelCount: 6,
    })
  })

  it("does not serve a list cached for another key", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(MODELS), { status: 200 })
    )
    const catalog = new NineRouterModelCatalog(
      fetchMock as unknown as typeof fetch
    )
    await catalog.list(connection)
    expect(catalog.cached({ ...connection, apiKey: "sk-other" })).toEqual([])
    await catalog.list({ ...connection, apiKey: "sk-other" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("reports a key problem and keeps the previous list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(MODELS), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API key required" }), {
          status: 401,
        })
      )
    const catalog = new NineRouterModelCatalog(
      fetchMock as unknown as typeof fetch
    )
    const first = await catalog.list(connection)
    const second = await catalog.list(connection, true)
    expect(second).toBe(first)
    expect(catalog.status(connection)).toMatchObject({
      state: "auth_required",
      message: expect.stringContaining("rejected the API key"),
    })
  })

  it("reports an unreachable router as offline", async () => {
    const catalog = new NineRouterModelCatalog((async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch)
    expect(await catalog.list(connection)).toEqual([])
    expect(catalog.status(connection)).toMatchObject({
      state: "offline",
      message: expect.stringContaining("npx 9router"),
    })
  })

  it("adds the router version to a check", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/health"))
        return new Response(JSON.stringify({ ok: true }))
      if (url.endsWith("/api/version"))
        return new Response(
          JSON.stringify({
            currentVersion: "0.5.95",
            latestVersion: "0.5.96",
            hasUpdate: true,
          })
        )
      return new Response(JSON.stringify(MODELS))
    })
    const catalog = new NineRouterModelCatalog(
      fetchMock as unknown as typeof fetch
    )
    const status = await catalog.check(connection)
    expect(status).toMatchObject({
      state: "online",
      version: "0.5.95",
      latestVersion: "0.5.96",
      modelCount: 6,
    })
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:20128/api/health",
      "http://localhost:20128/api/version",
      "http://localhost:20128/v1/models",
    ])
  })
})
