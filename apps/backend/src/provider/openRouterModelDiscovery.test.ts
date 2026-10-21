import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetOpenRouterModelDiscoveryForTests,
  getOpenRouterCatalogModels,
  selectOpenRouterCatalogSubset,
} from "./openRouterModelDiscovery"

describe("selectOpenRouterCatalogSubset", () => {
  it("ignores malformed entries without dropping valid models", () => {
    expect(
      selectOpenRouterCatalogSubset([
        null,
        undefined,
        1,
        "qwen/not-an-object",
        { id: "deepseek/valid", name: "Valid" },
      ])
    ).toEqual([{ id: "deepseek/valid", name: "Valid", contextLength: null }])
  })

  it("keeps only picker families and drops batch/media variants", () => {
    const subset = selectOpenRouterCatalogSubset([
      {
        id: "qwen/qwen3.8-max",
        name: "Qwen: Qwen3.8 Max",
        context_length: 1_000_000,
      },
      {
        id: "qwen/qwen3.8-max:batch",
        name: "batch variant",
        context_length: 1_000_000,
      },
      {
        id: "google/gemini-3-pro-image",
        name: "Nano Banana",
        context_length: 131_072,
      },
      {
        id: "google/lyria-3-pro-preview",
        name: "Lyria",
        context_length: 1_048_576,
      },
      {
        id: "google/gemini-3.1-pro-preview-customtools",
        name: "Custom Tools",
        context_length: 1_048_576,
      },
      { id: "openai/gpt-5.4", name: "outside family", context_length: 400_000 },
      // Grok has no OpenRouter group — the direct xAI provider covers it.
      {
        id: "x-ai/grok-4.20",
        name: "SpaceXAI: Grok 4.20",
        context_length: 2_000_000,
      },
      { id: "", name: "broken" },
      { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", context_length: 1_310_720 },
      {
        id: "google/gemini-3.7-flash",
        name: "Gemini Flash",
        context_length: 1_000_000,
      },
    ])
    expect(subset.map((m) => m.id)).toEqual(["qwen/qwen3.8-max"])
  })

  it("preserves catalog order and tolerates missing context", () => {
    const subset = selectOpenRouterCatalogSubset([
      { id: "deepseek/deepseek-v4-pro", name: "V4 Pro" },
      { id: "deepseek/deepseek-v3.2", name: "V3.2", context_length: 163_840 },
    ])
    expect(subset).toEqual([
      { id: "deepseek/deepseek-v4-pro", name: "V4 Pro", contextLength: null },
      { id: "deepseek/deepseek-v3.2", name: "V3.2", contextLength: 163_840 },
    ])
  })
})

describe("getOpenRouterCatalogModels", () => {
  beforeEach(() => {
    __resetOpenRouterModelDiscoveryForTests()
  })

  const okResponse = (data: unknown) =>
    ({
      ok: true,
      json: async () => ({ data }),
    }) as unknown as Response

  it("fetches once and serves the cache within the TTL", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse([
        {
          id: "qwen/qwen3.8-max",
          name: "Qwen: Qwen3.8 Max",
          context_length: 1,
        },
      ])
    )
    const first = await getOpenRouterCatalogModels(fetchMock as typeof fetch)
    const second = await getOpenRouterCatalogModels(fetchMock as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toHaveLength(1)
    expect(second).toBe(first)
  })

  it("falls back to empty (not a throw) when the endpoint fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline")
    })
    await expect(
      getOpenRouterCatalogModels(fetchMock as unknown as typeof fetch)
    ).resolves.toEqual([])
  })

  it("retains a stale catalog and bounds retries after an invalid response", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okResponse([{ id: "deepseek/valid" }]))
        .mockResolvedValueOnce(okResponse(null))
        .mockResolvedValueOnce(okResponse([{ id: "deepseek/new" }]))
      const first = await getOpenRouterCatalogModels(fetchMock as typeof fetch)
      const expiredAt = 1_000 + 6 * 60 * 60_000
      clock.mockReturnValue(expiredAt)
      expect(await getOpenRouterCatalogModels(fetchMock as typeof fetch)).toBe(
        first
      )
      expect(await getOpenRouterCatalogModels(fetchMock as typeof fetch)).toBe(
        first
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)

      clock.mockReturnValue(expiredAt + 59_999)
      expect(await getOpenRouterCatalogModels(fetchMock as typeof fetch)).toBe(
        first
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      clock.mockReturnValue(expiredAt + 60_000)
      expect(
        await getOpenRouterCatalogModels(fetchMock as typeof fetch)
      ).toEqual([
        { id: "deepseek/new", name: "deepseek/new", contextLength: null },
      ])
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      clock.mockRestore()
    }
  })
})
