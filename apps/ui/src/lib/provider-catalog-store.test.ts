import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import {
  apiModelsResource,
  handleProviderMetadataChanged,
  handleProviderSettingsUpdated,
  projectProvidersStore,
  providerInstancesStore,
  providerStatusResource,
  resetProviderCatalogStoresForTests,
} from "./provider-catalog-store"
import {
  getProviderStatus,
  listModels,
  listProviderInstanceModels,
  listProviderInstances,
  refreshProviderInstance,
  type ApiModel,
  type ProviderStatus,
} from "@/services/backend/providersApi"
import {
  listProjectProviders,
  type WorkspaceProjectProvidersSummary,
} from "@/services/backend/workspaceApi"

vi.mock("@/services/backend/providersApi", () => ({
  getProviderStatus: vi.fn(),
  listModels: vi.fn(),
  listProviderInstances: vi.fn(),
  listProviderInstanceModels: vi.fn(),
  refreshProviderInstance: vi.fn(),
}))
vi.mock("@/services/backend/workspaceApi", () => ({
  listProjectProviders: vi.fn(),
}))
vi.mock("@/lib/settings-store", () => ({
  SETTINGS_UPDATED_EVENT: "betterc0de:settings-updated",
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const snapshot = (instanceId: string, modelId?: string) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    configured: true,
    ...(modelId
      ? {
          models: [
            {
              slug: modelId,
              name: modelId,
              isCustom: false,
              capabilities: null,
            },
          ],
        }
      : {}),
  }) as ProviderInstanceSnapshot

const status = (provider: string, configured = true) =>
  ({ provider, name: provider, configured }) as ProviderStatus

describe("shared provider catalog", () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => resetProviderCatalogStoresForTests())

  it("serves every status subscriber from one request", async () => {
    vi.mocked(getProviderStatus).mockResolvedValue([status("anthropic")])
    const unsubscribers = [1, 2, 3].map(() =>
      providerStatusResource.subscribe(() => {})
    )
    await flush()

    expect(getProviderStatus).toHaveBeenCalledTimes(1)
    expect(providerStatusResource.getSnapshot().get("anthropic")).toEqual(
      status("anthropic")
    )
    for (const unsubscribe of unsubscribers) unsubscribe()
  })

  it("shares one instance catalog request per workspace", async () => {
    vi.mocked(listProviderInstances).mockImplementation(async (cwd) => [
      snapshot(`codex:${cwd ?? "global"}`, "gpt-6-astra"),
    ])
    providerInstancesStore.subscribe("/a", () => {})
    providerInstancesStore.subscribe("/a", () => {})
    providerInstancesStore.subscribe("", () => {})
    await flush()

    expect(vi.mocked(listProviderInstances).mock.calls).toEqual([
      ["/a"],
      [null],
    ])
    expect(providerInstancesStore.getSnapshot("/a")).toEqual([
      snapshot("codex:/a", "gpt-6-astra"),
    ])
  })

  it("keeps the newer catalog when an older model lookup finishes last", async () => {
    const entered = Promise.withResolvers<void>()
    const oldModels =
      Promise.withResolvers<
        Awaited<ReturnType<typeof listProviderInstanceModels>>
      >()
    vi.mocked(listProviderInstances)
      .mockResolvedValueOnce([snapshot("codex")])
      .mockResolvedValueOnce([snapshot("codex", "gpt-6-astra")])
    vi.mocked(listProviderInstanceModels).mockImplementationOnce(() => {
      entered.resolve()
      return oldModels.promise
    })
    const older = providerInstancesStore.refresh("/a")
    await entered.promise
    await providerInstancesStore.refresh("/a", { force: true })
    oldModels.resolve([])
    await older

    expect(providerInstancesStore.getSnapshot("/a")).toEqual([
      snapshot("codex", "gpt-6-astra"),
    ])
  })

  it("does not let a previous workspace's late response reach the current one", async () => {
    const pending = Promise.withResolvers<ProviderInstanceSnapshot[]>()
    vi.mocked(listProviderInstances)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([snapshot("codex", "gpt-6-astra")])
    providerInstancesStore.subscribe("/a", () => {})()
    providerInstancesStore.subscribe("/b", () => {})
    await flush()
    pending.resolve([snapshot("codex", "old")])
    await flush()

    expect(providerInstancesStore.getSnapshot("/b")).toEqual([
      snapshot("codex", "gpt-6-astra"),
    ])
    expect(providerInstancesStore.getSnapshot("/a")).toEqual([
      snapshot("codex", "old"),
    ])
  })

  it("preserves metadata during a restart and accepts the recovered catalog", async () => {
    vi.mocked(listProviderInstances)
      .mockResolvedValueOnce([snapshot("codex", "gpt-6-astra")])
      .mockRejectedValueOnce(new Error("Backend restarting"))
      .mockResolvedValueOnce([snapshot("codex", "gpt-5.6-sol")])
    await providerInstancesStore.refresh("/a", { force: true })
    await providerInstancesStore.refresh("/a", { force: true })
    expect(providerInstancesStore.getSnapshot("/a")).toEqual([
      snapshot("codex", "gpt-6-astra"),
    ])
    await providerInstancesStore.refresh("/a", { force: true })
    expect(providerInstancesStore.getSnapshot("/a")).toEqual([
      snapshot("codex", "gpt-5.6-sol"),
    ])
  })

  it("rescans changed provider metadata once per mounted workspace", async () => {
    vi.mocked(listProviderInstances).mockResolvedValue([
      snapshot("codex", "gpt-6-astra"),
      snapshot("codex-work", "gpt-6-astra"),
    ])
    vi.mocked(refreshProviderInstance).mockResolvedValue({
      instance: null,
      models: [],
    })
    providerInstancesStore.subscribe("/a", () => {})
    providerInstancesStore.subscribe("/a", () => {})
    providerInstancesStore.subscribe("", () => {})
    await flush()
    vi.mocked(listProviderInstances).mockClear()

    await handleProviderMetadataChanged({
      providerKind: "codex",
      metadataKind: "skills",
    })

    expect(vi.mocked(refreshProviderInstance).mock.calls).toEqual([
      ["codex", "/a"],
      ["codex-work", "/a"],
      ["codex", null],
      ["codex-work", null],
    ])
    expect(listProviderInstances).toHaveBeenCalledTimes(2)
  })

  it("on a settings change refetches mounted data and hides the old account's API models", async () => {
    vi.mocked(getProviderStatus).mockResolvedValue([status("openai")])
    vi.mocked(listModels)
      .mockResolvedValueOnce([
        { slug: "old", name: "Old", provider: "openai" },
      ] as ApiModel[])
      .mockResolvedValueOnce([
        { slug: "new", name: "New", provider: "openai" },
      ] as ApiModel[])
    vi.mocked(listProviderInstances).mockResolvedValue([])
    providerStatusResource.subscribe(() => {})
    apiModelsResource.subscribe(() => {})
    const unsubscribeIdle = providerInstancesStore.subscribe("/idle", () => {})
    await flush()
    unsubscribeIdle()
    expect(apiModelsResource.getSnapshot()?.[0]?.slug).toBe("old")

    handleProviderSettingsUpdated()
    expect(apiModelsResource.getSnapshot()).toBeNull()
    await flush()

    expect(apiModelsResource.getSnapshot()?.[0]?.slug).toBe("new")
    expect(getProviderStatus).toHaveBeenCalledTimes(2)
    // The idle workspace refetches only when something shows it again.
    expect(listProviderInstances).toHaveBeenCalledTimes(1)
    providerInstancesStore.subscribe("/idle", () => {})
    await flush()
    expect(listProviderInstances).toHaveBeenCalledTimes(2)
  })

  it("clears a workspace's project policy when it cannot be read", async () => {
    vi.mocked(listProjectProviders)
      .mockResolvedValueOnce({
        enabledProviders: ["codex"],
      } as WorkspaceProjectProvidersSummary)
      .mockRejectedValueOnce(new Error("unreadable"))
    projectProvidersStore.subscribe("/a", () => {})
    projectProvidersStore.subscribe("/a", () => {})
    await flush()
    expect(listProjectProviders).toHaveBeenCalledExactlyOnceWith("/a")
    expect(projectProvidersStore.getSnapshot("/a")?.enabledProviders).toEqual([
      "codex",
    ])

    await projectProvidersStore.refresh("/a", { force: true })
    expect(projectProvidersStore.getSnapshot("/a")).toBeNull()
  })
})
