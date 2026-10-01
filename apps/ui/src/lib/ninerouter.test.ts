import { describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend", () => ({
  getSettings: vi.fn(async () => ({
    providers: { openrouter: { api_key: "sk-or" } },
  })),
}))

import type {
  NineRouterConnectionView,
  NineRouterProviderView,
} from "@betterc0de/schema"
import { nineRouterUiProviders } from "@/lib/ninerouter-providers"
import {
  filterPickerModels,
  groupPickerModels,
  pickerCustomModelCandidate,
  pickerShowsModelSearch,
} from "@/lib/model-picker-search"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { wireModelIdForProvider } from "@/lib/wire-model-id"
import {
  coerceThinkingModeForModel,
  getModelThinkingOptions,
} from "@/lib/model-capabilities"
import {
  normalizeThinkingMode,
  thinkingModeToEffort,
} from "@/lib/thinking-mode"

function connection(
  over: Partial<NineRouterConnectionView> = {}
): NineRouterConnectionView {
  return {
    id: "laptop",
    name: "Laptop",
    baseUrl: "http://localhost:20128/v1",
    dashboardUrl: "http://localhost:20128/dashboard",
    enabled: true,
    tokenSaver: true,
    secret: { configured: false, storage: "encrypted" },
    customModels: [],
    hiddenModels: [],
    status: {
      state: "online",
      message: null,
      version: "0.5.95",
      latestVersion: null,
      latencyMs: 12,
      modelCount: 2,
      checkedAt: 1,
    },
    models: [
      {
        slug: "premium",
        name: "premium",
        tier: "Combos",
        isCustom: false,
        hidden: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "auto",
              options: [
                { id: "auto", label: "Auto (adaptive)", isDefault: true },
                { id: "none", label: "Off" },
                { id: "high", label: "High" },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
      {
        slug: "cc/claude-opus-5-5",
        name: "cc/claude-opus-5-5",
        tier: "Claude Code",
        context: "1M",
        isCustom: false,
        hidden: false,
        capabilities: { attachment: true, optionDescriptors: [] },
      },
      {
        slug: "kr/hidden",
        name: "kr/hidden",
        tier: "Kiro",
        isCustom: false,
        hidden: true,
      },
    ],
    ...over,
  }
}

const view = (
  connections: NineRouterConnectionView[],
  enabled = true
): NineRouterProviderView => ({ enabled, connections })

describe("nineRouterUiProviders", () => {
  it("names a single router 9Router and namespaces its instance id", () => {
    const [provider] = nineRouterUiProviders(view([connection()]))
    expect(provider).toMatchObject({
      id: "ninerouter:laptop",
      name: "9Router",
      providerKind: "ninerouter",
      providerInstanceId: "ninerouter:laptop",
      configured: true,
      modelsReady: true,
    })
    expect(provider.models.map((model) => model.id)).toEqual([
      "premium",
      "cc/claude-opus-5-5",
    ])
  })

  it("names several routers and skips disabled ones", () => {
    const providers = nineRouterUiProviders(
      view([
        connection(),
        connection({ id: "vps", name: "VPS" }),
        connection({ id: "off", name: "Off", enabled: false }),
      ])
    )
    expect(providers.map((provider) => provider.name)).toEqual([
      "9Router · Laptop",
      "9Router · VPS",
    ])
    expect(nineRouterUiProviders(view([connection()], false))).toEqual([])
  })

  it("explains an offline router with no models instead of offering it", () => {
    const [provider] = nineRouterUiProviders(
      view([
        connection({
          models: [],
          status: {
            ...connection().status,
            state: "offline",
            message: "9Router is not reachable at http://localhost:20128/v1.",
          },
        }),
      ])
    )
    expect(provider.configured).toBe(false)
    expect(provider.setupHint).toContain("not reachable")
  })

  it("keeps a cached connection pending until models load", () => {
    const [provider] = nineRouterUiProviders(
      view([
        connection({
          models: [],
          status: { ...connection().status, state: "unknown" },
        }),
      ])
    )
    expect(provider.modelsReady).toBe(false)
    expect(provider.configured).toBe(true)
  })
})

describe("9Router model picker search", () => {
  const [provider] = nineRouterUiProviders(view([connection()]))

  it("searches ids and groups ignoring separators", () => {
    expect(
      filterPickerModels(provider.models, "claude opus").map((m) => m.id)
    ).toEqual(["cc/claude-opus-5-5"])
    expect(
      filterPickerModels(provider.models, "combos").map((m) => m.id)
    ).toEqual(["premium"])
  })

  it("groups by account for 9Router only", () => {
    expect(
      groupPickerModels(provider, provider.models).map((group) => group.label)
    ).toEqual(["Combos", "Claude Code"])
    expect(
      groupPickerModels({ providerKind: "openai" }, provider.models)
    ).toHaveLength(1)
    expect(pickerShowsModelSearch(provider)).toBe(true)
    expect(pickerShowsModelSearch({ providerKind: "codex" })).toBe(false)
  })

  it("offers a typed id as a custom 9Router model", () => {
    expect(pickerCustomModelCandidate(provider, " cx/gpt-5.5(xhigh) ")).toBe(
      "cx/gpt-5.5(xhigh)"
    )
    expect(pickerCustomModelCandidate(provider, "premium")).toBeNull()
    expect(pickerCustomModelCandidate(provider, "two words")).toBeNull()
    expect(
      pickerCustomModelCandidate(
        { providerKind: "openai", models: [] },
        "gpt-x"
      )
    ).toBeNull()
  })
})

describe("9Router sending", () => {
  it("keeps account prefixes on the wire", () => {
    expect(wireModelIdForProvider("ninerouter", "cc/claude-opus-5-5")).toBe(
      "cc/claude-opus-5-5"
    )
    expect(wireModelIdForProvider("openrouter", "qwen/qwen3")).toBe(
      "qwen/qwen3"
    )
    expect(wireModelIdForProvider("codex", "openai/gpt-5.5")).toBe("gpt-5.5")
  })

  it("never reroutes a 9Router model to OpenRouter", async () => {
    await expect(
      resolveProviderTarget(
        {
          id: "ninerouter:laptop",
          providerKind: "ninerouter",
          providerInstanceId: "ninerouter:laptop",
        },
        "cc/claude-opus-5-5"
      )
    ).resolves.toEqual({
      providerKind: "ninerouter",
      openaiTransport: null,
      providerInstanceId: "ninerouter:laptop",
    })
  })
})

describe("9Router reasoning", () => {
  const [provider] = nineRouterUiProviders(view([connection()]))

  it("offers adaptive thinking from the router's descriptor", () => {
    expect(getModelThinkingOptions(provider, "premium")).toEqual([
      { mode: "auto", label: "Auto (adaptive)" },
      { mode: "No Reasoning", label: "Off" },
      { mode: "High", label: "High" },
      { mode: "max", label: "Max" },
    ])
    expect(coerceThinkingModeForModel(provider, "premium", "auto")).toBe("auto")
    expect(coerceThinkingModeForModel(provider, "premium", "xHigh")).toBe(
      "High"
    )
  })

  it("shows no ladder for a model 9Router reports as non-reasoning", () => {
    expect(getModelThinkingOptions(provider, "cc/claude-opus-5-5")).toEqual([])
  })

  it("offers the generic ladder for custom ids", () => {
    const custom = {
      ...provider,
      models: [
        {
          id: "cx/new",
          name: "cx/new",
          context: "runtime",
          tier: "Custom",
          isCustom: true,
        },
      ],
    }
    expect(
      getModelThinkingOptions(custom, "cx/new").map((option) => option.label)
    ).toEqual(["Off", "Low", "Medium", "High", "Extra High", "Max"])
  })

  it("passes every level through to the wire", () => {
    expect(normalizeThinkingMode(provider, "premium", "max")).toBe("max")
    expect(normalizeThinkingMode(provider, "premium", "No Reasoning")).toBe(
      "No Reasoning"
    )
    expect(thinkingModeToEffort("auto")).toBe("auto")
    expect(thinkingModeToEffort("No Reasoning")).toBe("none")
  })
})
