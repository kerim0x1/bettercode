import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import { loadProviderInstanceCatalog } from "./provider-instance-loader"
import {
  listProviderInstanceModels,
  listProviderInstances,
} from "@/services/backend/providersApi"

vi.mock("@/services/backend/providersApi", () => ({
  listProviderInstances: vi.fn(),
  listProviderInstanceModels: vi.fn(),
}))

const snapshot = (
  instanceId: string,
  input: Partial<ProviderInstanceSnapshot> = {}
) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    configured: true,
    ...input,
  }) as ProviderInstanceSnapshot

describe("provider instance catalog loading", () => {
  beforeEach(() => vi.resetAllMocks())

  it("fills in models only for enabled, configured instances without a list", async () => {
    vi.mocked(listProviderInstances).mockResolvedValueOnce([
      snapshot("codex"),
      snapshot("disabled", { enabled: false }),
      snapshot("unconfigured", { configured: false }),
      snapshot("listed", { models: [] }),
    ])
    vi.mocked(listProviderInstanceModels).mockResolvedValueOnce([
      { slug: "gpt-6-astra", name: "GPT-6-Astra" },
    ] as Awaited<ReturnType<typeof listProviderInstanceModels>>)

    const catalog = await loadProviderInstanceCatalog("/a")

    expect(listProviderInstances).toHaveBeenCalledExactlyOnceWith("/a")
    expect(listProviderInstanceModels).toHaveBeenCalledExactlyOnceWith(
      "codex",
      "/a"
    )
    expect(catalog[0]?.models).toEqual([
      {
        slug: "gpt-6-astra",
        name: "GPT-6-Astra",
        isCustom: false,
        capabilities: null,
      },
    ])
    expect(catalog.slice(1)).toEqual([
      snapshot("disabled", { enabled: false }),
      snapshot("unconfigured", { configured: false }),
      snapshot("listed", { models: [] }),
    ])
  })

  it("keeps an instance without models when its model lookup fails", async () => {
    vi.mocked(listProviderInstances).mockResolvedValueOnce([snapshot("codex")])
    vi.mocked(listProviderInstanceModels).mockRejectedValueOnce(
      new Error("CLI not ready")
    )

    expect(await loadProviderInstanceCatalog(null)).toEqual([snapshot("codex")])
  })

  it("skips the per-instance model lookups for a superseded request", async () => {
    const controller = new AbortController()
    vi.mocked(listProviderInstances).mockImplementationOnce(async () => {
      controller.abort()
      return [snapshot("codex")]
    })

    await loadProviderInstanceCatalog("/a", controller.signal)

    expect(listProviderInstanceModels).not.toHaveBeenCalled()
  })
})
