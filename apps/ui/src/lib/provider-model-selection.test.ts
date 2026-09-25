import { describe, expect, it } from "vitest"
import type { UiProvider } from "@/lib/provider-types"
import {
  resolveDefaultProvider,
  resolveProviderModelSelection,
  resolveProviderModelSwitchSelection,
  resolveProviderModelThinkingSelection,
} from "@/lib/provider-model-selection"

function provider(
  input: Partial<UiProvider> & Pick<UiProvider, "id">
): UiProvider {
  return {
    ...input,
    name: input.name ?? input.id,
    logo: "",
    providerKind: input.providerKind,
    providerInstanceId: input.providerInstanceId,
    continuationKey: input.continuationKey,
    modelsReady: input.modelsReady,
    models: input.models ?? [
      {
        id: `${input.id}-default`,
        name: "Default",
        context: "test",
        tier: "Test",
      },
    ],
  }
}

describe("resolveProviderModelSelection", () => {
  it("keeps an explicitly selected Claude API provider", () => {
    const api = provider({ id: "anthropic", configured: true })
    const codex = provider({ id: "codex", configured: true })
    const claude = provider({ id: "claude", configured: true })
    expect(
      resolveProviderModelSelection({
        providers: [api, codex, claude],
        selectedProviderId: "anthropic",
        selectedModel: "anthropic-default",
      })
    ).toEqual({ provider: api, modelId: "anthropic-default" })
  })

  it("maps a stored Claude API provider ID to the visible API entry", () => {
    const api = provider({
      id: "anthropic-api",
      providerKind: "anthropic",
      models: [
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          context: "1M",
          tier: "Flagship",
        },
      ],
    })
    expect(
      resolveProviderModelSelection({
        providers: [api],
        selectedProviderId: "anthropic",
        selectedModel: "claude-opus-5-5",
      })
    ).toEqual({ provider: api, modelId: "claude-opus-5-5" })
  })

  it.each(["claude-terminal"])(
    "migrates %s to Claude CLI and retains a compatible model",
    (id) => {
      const claude = provider({ id: "claude", providerInstanceId: "claude" })
      expect(
        resolveProviderModelSelection({
          providers: [provider({ id }), provider({ id: "codex" }), claude],
          selectedProviderId: id,
          selectedModel: "claude-default",
        })
      ).toEqual({ provider: claude, modelId: "claude-default" })
    }
  )

  it.each([
    { configured: false },
    { status: "disabled" as const },
    { status: "error" as const },
    { availability: "unavailable" as const },
    { models: [] },
  ])("falls back to Codex when Claude cannot be used: %j", (unavailable) => {
    const claude = provider({ id: "claude", configured: true, ...unavailable })
    const codex = provider({
      id: "codex",
      configured: true,
      modelsReady: false,
    })
    expect(
      resolveProviderModelSelection({
        providers: [
          provider({ id: "openai" }),
          provider({ id: "cursor" }),
          codex,
          claude,
        ],
        selectedProviderId: "claude",
        selectedModel: "claude-default",
      })
    ).toEqual({ provider: codex, modelId: "codex-default" })
  })

  it("tries Cursor, Grok CLI, then configured API providers", () => {
    const api = provider({ id: "anthropic", configured: true })
    const openai = provider({ id: "openai", configured: true })
    const grok = provider({
      id: "grok-cli",
      providerKind: "grok_cli",
      configured: true,
    })
    const cursor = provider({ id: "cursor", configured: true })
    const codex = provider({ id: "codex", configured: false })
    const claude = provider({ id: "claude", configured: false })
    expect(
      resolveDefaultProvider([api, openai, grok, cursor, codex, claude])
    ).toBe(cursor)
    expect(resolveDefaultProvider([api, openai, grok, codex, claude])).toBe(
      grok
    )
    expect(resolveDefaultProvider([api, openai, codex, claude])).toBe(api)
    expect(resolveDefaultProvider([api, codex, claude])).toBe(api)
    expect(
      resolveProviderModelSelection({
        providers: [api],
        selectedProviderId: "anthropic",
        selectedModel: "anthropic-default",
      }).provider
    ).toBe(api)
  })

  it("waits for Claude's startup probe and preserves an explicit valid Codex choice", () => {
    const claude = provider({ id: "claude", modelsReady: false })
    const codex = provider({ id: "codex", configured: true })
    expect(resolveDefaultProvider([codex, claude])).toBe(claude)
    expect(
      resolveProviderModelSelection({
        providers: [codex, claude],
        selectedProviderId: "codex",
        selectedModel: "codex-default",
      }).provider
    ).toBe(codex)
  })

  it("preserves an unavailable bound conversation so an outage does not switch its provider", () => {
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      configured: false,
    })
    expect(
      resolveProviderModelSelection({
        providers: [provider({ id: "codex", configured: true }), claude],
        selectedProviderId: "claude",
        selectedModel: "claude-default",
        lockedProviderInstanceId: "claude",
      }).provider
    ).toBe(claude)
  })

  it("uses an available custom Claude CLI instance before Codex", () => {
    const work = provider({
      id: "claude-work",
      providerKind: "anthropic_cli",
      providerInstanceId: "claude-work",
      configured: true,
    })
    expect(
      resolveDefaultProvider([
        provider({ id: "codex", configured: true }),
        provider({ id: "claude", configured: false }),
        work,
      ])
    ).toBe(work)
  })

  it("preserves Astra and Ultra while only the startup fallback catalog is available", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      modelsReady: false,
      models: [
        { id: "gpt-5.6-sol", name: "Sol", context: "1M", tier: "Flagship" },
      ],
    })
    const input = {
      providers: [codex],
      selectedProviderId: "codex",
      selectedModel: "gpt-6-astra",
      thinkingMode: "ultra",
    }
    expect(resolveProviderModelThinkingSelection(input)).toEqual({
      provider: codex,
      modelId: "gpt-6-astra",
      thinkingMode: "ultra",
    })

    const readyCodex = {
      ...codex,
      modelsReady: true,
      models: [
        ...codex.models,
        {
          id: "gpt-6-astra",
          name: "GPT-6-Astra",
          context: "runtime",
          tier: "Runtime",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select" as const,
                options: [
                  { id: "medium", label: "Medium" },
                  { id: "ultra", label: "Ultra" },
                ],
              },
            ],
          },
        },
      ],
    }
    expect(
      resolveProviderModelThinkingSelection({
        ...input,
        providers: [readyCodex],
      })
    ).toEqual({
      provider: readyCodex,
      modelId: "gpt-6-astra",
      thinkingMode: "ultra",
    })
    expect(
      resolveProviderModelSelection({
        ...input,
        providers: [{ ...codex, modelsReady: true }],
      }).modelId
    ).toBe("gpt-6-astra")
  })

  it("does not downgrade a stored reasoning level before model capabilities arrive", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      modelsReady: false,
      models: [
        { id: "gpt-5.6-sol", name: "Sol", context: "1M", tier: "Flagship" },
      ],
    })
    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex],
        selectedProviderId: "codex",
        selectedModel: "gpt-5.6-sol",
        thinkingMode: "ultra",
      }).thinkingMode
    ).toBe("ultra")
  })

  it("keeps a valid provider/model pair", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [codex],
        selectedProviderId: "codex",
        selectedModel: "gpt-5.5",
      })
    ).toEqual({
      provider: codex,
      modelId: "gpt-5.5",
    })
  })

  it("keeps a retired model ID until the user chooses a replacement", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [codex],
        selectedProviderId: "codex",
        selectedModel: "gpt-4.1",
      })
    ).toEqual({
      provider: codex,
      modelId: "gpt-4.1",
    })
  })

  it("normalizes legacy model aliases before falling back to provider defaults", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.4", name: "GPT 5.4", context: "256K", tier: "Flagship" },
      ],
    })
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [codex],
        selectedProviderId: "codex",
        selectedModel: "gpt-5-codex",
      })
    ).toEqual({
      provider: codex,
      modelId: "gpt-5.4",
    })
    expect(
      resolveProviderModelSelection({
        providers: [codex, claude],
        selectedProviderId: "claude",
        selectedModel: "opus-4.7",
      })
    ).toEqual({
      provider: claude,
      modelId: "claude-opus-4-7",
    })
  })

  it("normalizes Cursor aliases without applying them to BetterC0de", () => {
    const cursor = provider({
      id: "cursor",
      providerKind: "cursor",
      providerInstanceId: "cursor",
      models: [
        { id: "auto", name: "Auto", context: "runtime", tier: "Runtime" },
        {
          id: "composer-2",
          name: "Composer 2",
          context: "runtime",
          tier: "Runtime",
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          context: "runtime",
          tier: "Runtime",
        },
      ],
    })
    const BetterC0de = provider({
      id: "BetterC0de",
      providerKind: "BetterC0de",
      providerInstanceId: "BetterC0de",
      models: [
        {
          id: "openai/gpt-5",
          name: "OpenAI GPT-5",
          context: "runtime",
          tier: "Runtime",
        },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [cursor, BetterC0de],
        selectedProviderId: "cursor",
        selectedModel: "composer",
      })
    ).toEqual({
      provider: cursor,
      modelId: "composer-2",
    })
    expect(
      resolveProviderModelSelection({
        providers: [cursor, BetterC0de],
        selectedProviderId: "cursor",
        selectedModel: "sonnet-4.6-thinking",
      })
    ).toEqual({
      provider: cursor,
      modelId: "claude-sonnet-4-6",
    })
    expect(
      resolveProviderModelSelection({
        providers: [cursor, BetterC0de],
        selectedProviderId: "BetterC0de",
        selectedModel: "sonnet-4.6",
      })
    ).toEqual({
      provider: BetterC0de,
      modelId: "sonnet-4.6",
    })
  })

  it("keeps an alias until runtime model discovery can validate it", () => {
    const cursor = provider({
      id: "cursor",
      providerKind: "cursor",
      providerInstanceId: "cursor",
      models: [],
    })

    expect(
      resolveProviderModelSelection({
        providers: [cursor],
        selectedProviderId: "cursor",
        selectedModel: "composer",
      })
    ).toEqual({
      provider: cursor,
      modelId: "composer",
    })
  })

  it("keeps a saved model ID on a locked provider instance", () => {
    const defaultCodex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const workCodex = provider({
      id: "codex-work",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      models: [
        { id: "gpt-5.4", name: "GPT 5.4", context: "256K", tier: "Flagship" },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [defaultCodex, workCodex],
        selectedProviderId: "codex",
        selectedModel: "gpt-5.5",
        lockedProviderInstanceId: "codex-work",
      })
    ).toEqual({
      provider: workCodex,
      modelId: "gpt-5.5",
    })
  })

  it("falls back to the provider that owns the selected model when the provider preference is missing", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "opus-4-7",
          name: "Claude Opus 4.7",
          context: "200K",
          tier: "Flagship",
        },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [codex, claude],
        selectedProviderId: "openai",
        selectedModel: "opus-4-7",
      })
    ).toEqual({
      provider: claude,
      modelId: "opus-4-7",
    })
  })

  it("keeps a saved model ID on a locked continuation provider", () => {
    const defaultCodex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      continuationKey: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const workCodex = provider({
      id: "codex-work",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      continuationKey: "codex-work-thread",
      models: [
        { id: "gpt-5.4", name: "GPT 5.4", context: "256K", tier: "Flagship" },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [defaultCodex, workCodex],
        selectedProviderId: "codex",
        selectedModel: "gpt-5.5",
        lockedContinuationKey: "codex-work-thread",
      })
    ).toEqual({
      provider: workCodex,
      modelId: "gpt-5.5",
    })
  })

  it("does not let a locked provider from another kind override the selected provider", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "opus-4-7",
          name: "Claude Opus 4.7",
          context: "200K",
          tier: "Flagship",
        },
      ],
    })

    expect(
      resolveProviderModelSelection({
        providers: [codex, claude],
        selectedProviderId: "codex",
        selectedModel: "gpt-5.5",
        lockedProviderInstanceId: "claude",
      })
    ).toEqual({
      provider: codex,
      modelId: "gpt-5.5",
    })
  })

  it("preserves saved reasoning while a foreign model needs explicit replacement", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    })

    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claude],
        selectedProviderId: "claude",
        selectedModel: "gpt-5.5",
        thinkingMode: "xhigh",
      })
    ).toEqual({
      provider: claude,
      modelId: "gpt-5.5",
      thinkingMode: "xhigh",
    })
    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claude],
        selectedProviderId: "claude",
        selectedModel: "gpt-5.5",
        thinkingMode: "Extra High",
      })
    ).toEqual({
      provider: claude,
      modelId: "gpt-5.5",
      thinkingMode: "Extra High",
    })
    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claude],
        selectedProviderId: "claude",
        selectedModel: "gpt-5.5",
        thinkingMode: "ExtraHigh",
      })
    ).toEqual({
      provider: claude,
      modelId: "gpt-5.5",
      thinkingMode: "ExtraHigh",
    })
  })

  it("preserves Ultra Think on a saved model before replacement", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    })

    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claude],
        selectedProviderId: "claude",
        selectedModel: "gpt-5.5",
        thinkingMode: "Ultra Think",
      })
    ).toEqual({
      provider: claude,
      modelId: "gpt-5.5",
      thinkingMode: "Ultra Think",
    })
  })

  it("preserves reasoning on a saved model unavailable to Claude CLI", () => {
    const codex = provider({
      id: "codex",
      providerKind: "codex",
      providerInstanceId: "codex",
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", context: "400K", tier: "Flagship" },
      ],
    })
    const claudeCli = provider({
      id: "claude-cli",
      providerKind: "anthropic_cli",
      providerInstanceId: "claude-cli",
      models: [
        {
          id: "opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    })

    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claudeCli],
        selectedProviderId: "claude-cli",
        selectedModel: "gpt-5.5",
        thinkingMode: "xHigh",
      })
    ).toEqual({
      provider: claudeCli,
      modelId: "gpt-5.5",
      thinkingMode: "xHigh",
    })
    expect(
      resolveProviderModelThinkingSelection({
        providers: [codex, claudeCli],
        selectedProviderId: "claude-cli",
        selectedModel: "gpt-5.5",
        thinkingMode: "ExtraHigh",
      })
    ).toEqual({
      provider: claudeCli,
      modelId: "gpt-5.5",
      thinkingMode: "ExtraHigh",
    })
  })

  it("builds a persisted switch selection for GPT Extra High to Claude Max", () => {
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    })

    expect(
      resolveProviderModelSwitchSelection({
        provider: claude,
        modelId: "claude-opus-4-7",
        thinkingMode: "ExtraHigh",
        contextWindow: "200k",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "claude-opus-4-7",
      thinkingMode: "max",
      contextWindow: "200k",
    })
    expect(
      resolveProviderModelSwitchSelection({
        provider: claude,
        modelId: "claude-opus-4-7",
        thinkingMode: "xHigh",
        contextWindow: "1m",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "claude-opus-4-7",
      thinkingMode: "max",
      contextWindow: "1m",
    })
  })

  it("builds a persisted switch selection for GPT Ultra Think to Claude Ultrathink", () => {
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    })

    // Ultrathink left the fallback menu, so the coercion steps down to Max;
    // descriptor-backed providers that still advertise it keep it (below).
    expect(
      resolveProviderModelSwitchSelection({
        provider: claude,
        modelId: "claude-opus-4-7",
        thinkingMode: "Ultra Think",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "claude-opus-4-7",
      thinkingMode: "max",
      contextWindow: "1m",
    })

    const descriptorBackedClaude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    })

    expect(
      resolveProviderModelSwitchSelection({
        provider: descriptorBackedClaude,
        modelId: "claude-opus-4-7",
        thinkingMode: "Ultra Think",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "claude-opus-4-7",
      thinkingMode: "ultrathink",
      contextWindow: "1m",
    })
  })

  it("builds a persisted switch selection for dotted Opus 4.7 aliases", () => {
    const claude = provider({
      id: "claude",
      providerKind: "claude",
      providerInstanceId: "claude",
      models: [
        {
          id: "opus-4.7",
          name: "Claude Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    })

    expect(
      resolveProviderModelSwitchSelection({
        provider: claude,
        modelId: "opus-4.7",
        thinkingMode: "ExtraHigh",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "opus-4.7",
      thinkingMode: "max",
      contextWindow: "1m",
    })
    // Ultrathink left the fallback menu; the alias steps down to Max.
    expect(
      resolveProviderModelSwitchSelection({
        provider: claude,
        modelId: "opus-4.7",
        thinkingMode: "Ultra Think",
      })
    ).toEqual({
      providerId: "claude",
      modelId: "opus-4.7",
      thinkingMode: "max",
      contextWindow: "1m",
    })
  })
})
