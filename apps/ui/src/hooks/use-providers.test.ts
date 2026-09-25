import { describe, expect, it } from "vitest"
import {
  applyProjectProviderModelDefaults,
  hiddenProviderIdsForProjectPolicy,
  isProviderAllowedByProjectPolicy,
  isProviderVisible,
  mergeRuntimeModelMetadata,
  providerProjectPolicyKeys,
  providerVisibilityKeys,
} from "@/hooks/use-providers"
import { builtinProviders } from "@/lib/builtin-providers"
import type { UiProvider } from "@/lib/provider-types"

function provider(
  input: Partial<UiProvider> & Pick<UiProvider, "id">
): UiProvider {
  return {
    name: input.id,
    logo: "",
    models: [],
    ...input,
  }
}

describe("provider visibility", () => {
  it.each(["claude-terminal"])(
    "does not restore the retired %s picker entry through plugins or settings",
    (id) => {
      expect(builtinProviders.some((entry) => entry.id === id)).toBe(false)
      expect(isProviderVisible(provider({ id }), new Set())).toBe(false)
      expect(
        isProviderVisible(
          provider({ id: "custom", providerKind: id }),
          new Set()
        )
      ).toBe(false)
      expect(
        isProviderVisible(
          provider({ id: "claude", providerKind: "claude" }),
          new Set()
        )
      ).toBe(true)
    }
  )

  it("shows Claude API as a separate provider", () => {
    expect(builtinProviders.some((entry) => entry.id === "anthropic-api")).toBe(
      true
    )
    expect(
      isProviderVisible(provider({ id: "anthropic-api" }), new Set())
    ).toBe(true)
  })

  it("hides Qwen and DeepSeek provider families from the model dropdown by default", () => {
    const hidden = new Set(["or-qwen", "or-deepseek"])

    expect(isProviderVisible(provider({ id: "or-qwen" }), hidden)).toBe(false)
    expect(isProviderVisible(provider({ id: "qwen" }), hidden)).toBe(false)
    expect(isProviderVisible(provider({ id: "or-deepseek" }), hidden)).toBe(
      false
    )
    expect(isProviderVisible(provider({ id: "deepseek" }), hidden)).toBe(false)
    expect(isProviderVisible(provider({ id: "codex" }), hidden)).toBe(true)
  })

  it("keeps provider-family aliases attached to visibility keys", () => {
    expect(
      providerVisibilityKeys(
        provider({
          id: "deepseek-work",
          providerKind: "deepseek",
          providerInstanceId: "deepseek-work",
        })
      )
    ).toEqual(["deepseek-work", "or-deepseek", "deepseek"])
    expect(
      providerVisibilityKeys(
        provider({
          id: "qwen-work",
          providerKind: "qwen",
          providerInstanceId: "qwen-work",
        })
      )
    ).toEqual(["qwen-work", "or-qwen", "qwen"])
  })

  it("hides renamed Qwen and DeepSeek provider instances by family", () => {
    const hidden = new Set(["or-qwen", "or-deepseek"])

    expect(
      isProviderVisible(
        provider({ id: "openrouter-qwen-work", providerKind: "openrouter" }),
        hidden
      )
    ).toBe(false)
    expect(
      isProviderVisible(
        provider({ id: "openrouter-work", name: "DeepSeek Work" }),
        hidden
      )
    ).toBe(false)
  })

  it("applies BetterC0de enabled_providers as a project allowlist", () => {
    const policy = projectPolicy({ enabledProviders: ["openrouter"] })

    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "or-gemini", providerKind: "openrouter" }),
        policy
      )
    ).toBe(true)
    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "codex", providerKind: "codex" }),
        policy
      )
    ).toBe(false)
  })

  it("applies BetterC0de disabled_providers before normal hidden-provider preferences", () => {
    const policy = projectPolicy({ disabledProviders: ["anthropic", "qwen"] })

    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "anthropic", providerKind: "anthropic" }),
        policy
      )
    ).toBe(false)
    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "or-qwen", providerKind: "openrouter" }),
        policy
      )
    ).toBe(false)
    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "or-deepseek", providerKind: "openrouter" }),
        policy
      )
    ).toBe(true)
  })

  it("keeps OpenRouter family and split-provider aliases distinct", () => {
    expect(
      providerProjectPolicyKeys(
        provider({ id: "or-qwen", providerKind: "openrouter" })
      )
    ).toEqual(["or-qwen", "qwen", "openrouter"])
    expect(
      isProviderAllowedByProjectPolicy(
        provider({ id: "or-deepseek", providerKind: "openrouter" }),
        projectPolicy({ enabledProviders: ["qwen"] })
      )
    ).toBe(false)
  })

  it("treats explicit project provider enablement as activation for hidden defaults", () => {
    const hidden = hiddenProviderIdsForProjectPolicy(
      ["or-qwen", "or-deepseek"],
      projectPolicy({ enabledProviders: ["qwen"] })
    )

    expect(isProviderVisible(provider({ id: "or-qwen" }), hidden)).toBe(true)
    expect(isProviderVisible(provider({ id: "qwen" }), hidden)).toBe(true)
    expect(isProviderVisible(provider({ id: "or-deepseek" }), hidden)).toBe(
      false
    )
  })

  it("promotes BetterC0de project model as the runtime provider default", () => {
    const withDefault = applyProjectProviderModelDefaults(
      provider({
        id: "BetterC0de",
        providerKind: "BetterC0de",
        providerInstanceId: "BetterC0de",
        models: [
          {
            id: "openai/gpt-5",
            name: "GPT 5",
            context: "runtime",
            tier: "Runtime",
          },
        ],
      }),
      projectPolicy({ defaultModel: "anthropic/claude-sonnet-4-6" })
    )

    expect(withDefault.models.map((model) => model.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5",
    ])
    expect(withDefault.models[0]).toMatchObject({
      context: "project",
      tier: "Project",
      isCustom: true,
    })
  })

  it("adds BetterC0de project provider model overrides to the model picker", () => {
    const withProjectModels = applyProjectProviderModelDefaults(
      provider({
        id: "BetterC0de",
        providerKind: "BetterC0de",
        providerInstanceId: "BetterC0de",
        models: [
          {
            id: "openai/gpt-5",
            name: "GPT 5",
            context: "runtime",
            tier: "Runtime",
          },
        ],
      }),
      projectPolicy({
        defaultModel: "custom/fast-model",
        providers: [
          {
            id: "custom",
            models: [
              {
                id: "fast-model",
                name: "Fast Model",
                contextLimit: 128000,
                status: "stable",
              },
              {
                id: "custom/slow-model",
                name: "Slow Model",
              },
            ],
          },
        ],
      })
    )

    expect(withProjectModels.models.map((model) => model.id)).toEqual([
      "custom/fast-model",
      "custom/slow-model",
      "openai/gpt-5",
    ])
    expect(withProjectModels.models[0]).toMatchObject({
      name: "Fast Model",
      context: "128,000",
      tier: "stable",
      isCustom: true,
    })
  })

  it("filters BetterC0de project provider model overrides through provider whitelist and blacklist", () => {
    const withProjectModels = applyProjectProviderModelDefaults(
      provider({
        id: "BetterC0de",
        providerKind: "BetterC0de",
        providerInstanceId: "BetterC0de",
        models: [
          {
            id: "openai/gpt-5",
            name: "GPT 5",
            context: "runtime",
            tier: "Runtime",
          },
        ],
      }),
      projectPolicy({
        providers: [
          {
            id: "custom",
            whitelist: ["fast-model", "custom/qualified-model"],
            blacklist: ["old-model"],
            models: [
              { id: "fast-model", name: "Fast Model" },
              { id: "old-model", name: "Old Model" },
              { id: "slow-model", name: "Slow Model" },
              { id: "custom/qualified-model", name: "Qualified Model" },
            ],
          },
        ],
      })
    )

    expect(withProjectModels.models.map((model) => model.id)).toEqual([
      "custom/fast-model",
      "custom/qualified-model",
      "openai/gpt-5",
    ])
  })

  it("does not apply BetterC0de project model defaults to other providers", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })

    expect(
      applyProjectProviderModelDefaults(
        codex,
        projectPolicy({ defaultModel: "anthropic/claude-sonnet-4-6" })
      )
    ).toBe(codex)
  })
})

describe("runtime provider model metadata", () => {
  it("omits the removed Google and GLM picker groups", () => {
    expect(
      builtinProviders.some((provider) =>
        ["google", "or-gemini", "or-zhipu"].includes(provider.id)
      )
    ).toBe(false)
  })
  it("starts CLI providers without stale bundled model IDs", () => {
    const codex = builtinProviders.find((provider) => provider.id === "codex")
    expect(codex?.models).toEqual([])
    expect(
      builtinProviders.find((provider) => provider.id === "claude")?.models
    ).toEqual([])
    expect(
      builtinProviders.find((provider) => provider.id === "grok-cli")?.models
    ).toEqual([])
  })

  it("offers only live models and keeps their capabilities", () => {
    const fallback = builtinProviders.find(
      (provider) => provider.id === "codex"
    )!.models
    const available = mergeRuntimeModelMetadata(fallback, [
      { id: "gpt-5.6-sol", name: "Sol", context: "runtime", tier: "Runtime" },
    ])
    expect(available.map((model) => model.id)).toEqual(["gpt-5.6-sol"])
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "ultra", label: "Ultra" }],
        },
      ],
    }
    const live = mergeRuntimeModelMetadata(fallback, [
      {
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        context: "runtime",
        tier: "Runtime",
        capabilities,
      },
    ])
    expect(live[0]).toMatchObject({ id: "gpt-6-astra", capabilities })
    expect(live.filter((model) => model.id === "gpt-6-astra")).toHaveLength(1)
  })

  it("keeps fallback models and enriches duplicate Codex entries with live capabilities", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "fastMode",
          label: "Fast Mode",
          type: "boolean" as const,
        },
      ],
    }
    const models = mergeRuntimeModelMetadata(
      [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
        { id: "gpt-5.4", name: "GPT 5.4", context: "256K", tier: "Flagship" },
      ],
      [
        {
          id: "gpt-5.5",
          name: "Live GPT 5.5",
          context: "runtime",
          tier: "Runtime",
          capabilities,
        },
        {
          id: "gpt-new",
          name: "GPT New",
          context: "runtime",
          tier: "Runtime",
        },
      ]
    )

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-new",
    ])
    expect(models[0]).toMatchObject({
      name: "GPT 5.5",
      context: "400K",
      capabilities,
    })
  })
})

function projectPolicy(
  input: Partial<{
    defaultModel: string
    enabledProviders: string[]
    disabledProviders: string[]
    providers: Array<{
      id: string
      whitelist?: string[]
      blacklist?: string[]
      models: Array<{
        id: string
        name?: string
        contextLimit?: number
        status?: string
      }>
    }>
  }>
) {
  return {
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
    enabledProviders: input.enabledProviders ?? [],
    disabledProviders: input.disabledProviders ?? [],
    authAccounts: [],
    providers:
      input.providers?.map((provider) => ({
        id: provider.id,
        sourcePath: `BetterC0de.json#provider.${provider.id}`,
        env: [],
        whitelist: provider.whitelist ?? [],
        blacklist: provider.blacklist ?? [],
        optionKeys: [],
        hasApiKey: false,
        models: provider.models.map((model) => ({
          id: model.id,
          sourcePath: `BetterC0de.json#provider.${provider.id}.models.${model.id}`,
          optionKeys: [],
          headerKeys: [],
          variants: [],
          disabledVariants: [],
          ...(model.name ? { name: model.name } : {}),
          ...(model.contextLimit ? { contextLimit: model.contextLimit } : {}),
          ...(model.status ? { status: model.status } : {}),
        })),
      })) ?? [],
  }
}
