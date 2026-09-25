import { describe, expect, it } from "vitest"
import {
  coerceThinkingModeForModel,
  getModelThinkingOptions,
  getThinkingModeLabel,
  isThinkingModeOptionActive,
  supportsModelAttachments,
  supportsModelContextWindow,
  supportsModelBooleanOption,
  supportsModelFastMode,
  supportsProviderFastMode,
} from "@/lib/model-capabilities"
import type { UiProvider } from "@/lib/provider-types"

describe("model capabilities", () => {
  it("keeps OpenAI's advertised none and max effort levels", () => {
    const provider: UiProvider = {
      id: "openai-api",
      name: "OpenAI API",
      logo: "",
      providerKind: "openai",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          context: "1.05M",
          tier: "Runtime",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "none", label: "None" },
                  { id: "medium", label: "Medium" },
                  { id: "xhigh", label: "xHigh" },
                  { id: "max", label: "Max" },
                ],
              },
            ],
          },
        },
      ],
    }
    expect(getModelThinkingOptions(provider, "gpt-5.6-sol")).toEqual([
      { mode: "No Reasoning", label: "None" },
      { mode: "Medium", label: "Medium" },
      { mode: "xHigh", label: "xHigh" },
      { mode: "max", label: "Max" },
    ])
    expect(coerceThinkingModeForModel(provider, "gpt-5.6-sol", "max")).toBe(
      "max"
    )
  })

  it("keeps Opus 5.5 adaptive thinking on at medium by default", () => {
    const provider: UiProvider = {
      id: "anthropic-api",
      name: "Claude API",
      logo: "",
      providerKind: "anthropic",
      models: [
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          context: "1M",
          tier: "Flagship",
        },
      ],
    }
    expect(
      getModelThinkingOptions(provider, "claude-opus-5-5")
    ).not.toContainEqual({
      mode: null,
      label: "Off",
    })
    expect(coerceThinkingModeForModel(provider, "claude-opus-5-5", null)).toBe(
      "Medium"
    )
  })
  it("orders Grok's descending runtime efforts from low to high without changing their values or labels", () => {
    const options = [
      { id: "xhigh", label: "Extra High Effort" },
      { id: "high", label: "High Effort" },
      { id: "medium", label: "Medium Effort" },
      { id: "low", label: "Low Effort" },
    ]
    const provider: UiProvider = {
      id: "grok-cli",
      providerKind: "grok_cli",
      name: "Grok CLI",
      logo: "",
      models: [
        {
          id: "grok-4.6",
          name: "Grok 4.6",
          context: "500k",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Effort",
                type: "select",
                options,
              },
            ],
          },
        },
      ],
    }
    expect(getModelThinkingOptions(provider, "grok-4.6")).toEqual([
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low Effort" },
      { mode: "Medium", label: "Medium Effort" },
      { mode: "High", label: "High Effort" },
      { mode: "xHigh", label: "Extra High Effort" },
    ])
    expect(options.map((option) => option.id)).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
    ])
    expect(coerceThinkingModeForModel(provider, "grok-4.6", "High")).toBe(
      "High"
    )
  })
  it("uses model option descriptors when they are present", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Opus 4.7",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              { id: "effort", label: "Reasoning", type: "select", options: [] },
            ],
          },
        },
        {
          id: "claude-opus-4-6",
          name: "Opus 4.6",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
            ],
          },
        },
      ],
    }

    expect(supportsModelFastMode(provider, "claude-opus-4-7")).toBe(false)
    expect(supportsModelFastMode(provider, "claude-opus-4-6")).toBe(true)
  })

  it("does not invent Codex fast-mode support before runtime descriptors load", () => {
    expect(
      supportsProviderFastMode({
        id: "codex",
        name: "Codex",
        logo: "",
        models: [],
      })
    ).toBe(false)
    expect(
      supportsModelBooleanOption(
        {
          id: "codex",
          name: "Codex",
          logo: "",
          providerKind: "codex",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
          ],
        },
        "gpt-5.5",
        "fastMode"
      )
    ).toBe(false)
  })

  it("uses contextWindow select descriptors when they are present", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-haiku-4-5-20251001",
          name: "Haiku 4.5",
          context: "200K",
          tier: "Fast",
          capabilities: {
            optionDescriptors: [
              { id: "thinking", label: "Thinking", type: "boolean" },
            ],
          },
        },
        {
          id: "claude-sonnet-4-6",
          name: "Sonnet 4.6",
          context: "1M",
          tier: "Balanced",
          capabilities: {
            optionDescriptors: [
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "200k", label: "200k", isDefault: true },
                  { id: "1m", label: "1M" },
                ],
              },
            ],
          },
        },
      ],
    }

    expect(
      supportsModelContextWindow(provider, "claude-haiku-4-5-20251001")
    ).toBe(false)
    expect(supportsModelContextWindow(provider, "claude-sonnet-4-6")).toBe(true)
  })

  it("falls back to Claude Opus/Sonnet context support before descriptors load", () => {
    expect(
      supportsModelContextWindow(
        {
          id: "claude",
          name: "Claude CLI",
          logo: "",
          providerKind: "claude",
          models: [
            {
              id: "claude-opus-4-7",
              name: "Opus 4.7",
              context: "1M",
              tier: "Flagship",
            },
          ],
        },
        "claude-opus-4-7"
      )
    ).toBe(true)
  })

  it("uses explicit attachment capability before provider fallbacks", () => {
    const provider: UiProvider = {
      id: "betterc0de",
      name: "BetterC0de",
      logo: "",
      providerKind: "betterc0de",
      models: [
        {
          id: "openai/text-only",
          name: "Text Only",
          context: "1M",
          tier: "Runtime",
          capabilities: { attachment: false },
        },
        {
          id: "openai/vision",
          name: "Vision",
          context: "1M",
          tier: "Runtime",
          capabilities: { attachment: true },
        },
      ],
    }

    expect(supportsModelAttachments(provider, "openai/text-only")).toBe(false)
    expect(supportsModelAttachments(provider, "openai/vision")).toBe(true)
  })

  it("falls back to provider-level attachment support before runtime metadata loads", () => {
    expect(
      supportsModelAttachments(
        {
          id: "betterc0de",
          name: "BetterC0de",
          logo: "",
          providerKind: "betterc0de",
          models: [
            {
              id: "openai/gpt-5",
              name: "GPT-5",
              context: "1M",
              tier: "Runtime",
            },
          ],
        },
        "openai/gpt-5"
      )
    ).toBe(true)
    expect(
      supportsModelAttachments(
        {
          id: "anthropic",
          name: "Claude API",
          logo: "",
          providerKind: "anthropic",
          models: [
            {
              id: "claude-sonnet-4-6",
              name: "Sonnet 4.6",
              context: "200K",
              tier: "Balanced",
            },
          ],
        },
        "claude-sonnet-4-6"
      )
    ).toBe(true)
    expect(
      supportsModelAttachments(
        {
          id: "openai-api",
          name: "OpenAI API",
          logo: "",
          providerKind: "openai",
          openaiTransport: "api",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
          ],
        },
        "gpt-5.5"
      )
    ).toBe(true)
    expect(
      supportsModelAttachments(
        {
          id: "codex",
          name: "Codex",
          logo: "",
          providerKind: "codex",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT 5.5",
              context: "400K",
              tier: "Flagship",
            },
          ],
        },
        "gpt-5.5"
      )
    ).toBe(true)
  })

  it("builds thinking options from provider descriptors", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-opus-4-6",
          name: "Opus 4.6",
          context: "1M",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "high", label: "High", isDefault: true },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    }

    expect(getModelThinkingOptions(provider, "claude-opus-4-6")).toEqual([
      { mode: null, label: "Off" },
      { mode: "High", label: "High" },
      { mode: "max", label: "Max" },
      { mode: "ultrathink", label: "Ultrathink" },
    ])
    expect(getThinkingModeLabel(provider, "claude-opus-4-6", "max")).toBe("Max")
    expect(getThinkingModeLabel(provider, "claude-opus-4-6", "High")).toBe(
      "High"
    )
    expect(isThinkingModeOptionActive("Ultra Think", "ultrathink")).toBe(true)
  })

  // This used to assert the opposite — that Codex offers only "Off" until
  // `model/list` metadata arrives. That was safe but lossy: the picker wrote
  // the coerced value back through `resolveProviderModelSwitchSelection`, so
  // selecting a Codex model silently overwrote the user's reasoning
  // preference with Off and left Codex looking incapable of reasoning.
  // Offering the standard ladder is safe because the backend's
  // `effortForModel` forwards an effort only when the live descriptor lists
  // it, and drops anything it cannot verify — so a stale UI guess never
  // reaches the CLI.
  it("keeps the user's reasoning level on Codex before model/list metadata loads", () => {
    const provider: UiProvider = {
      id: "codex",
      name: "Codex (CLI)",
      logo: "",
      providerKind: "codex",
      models: [
        {
          id: "__codex_cli_default__",
          name: "Codex default",
          context: "CLI",
          tier: "Default",
        },
      ],
    }

    expect(getModelThinkingOptions(provider, "__codex_cli_default__")).toEqual([
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low" },
      { mode: "Medium", label: "Medium" },
      { mode: "High", label: "High" },
    ])
    expect(
      coerceThinkingModeForModel(provider, "__codex_cli_default__", "High")
    ).toBe("High")
    // An explicit Off is still the user's choice and must survive.
    expect(
      coerceThinkingModeForModel(provider, "__codex_cli_default__", null)
    ).toBeNull()
  })

  it("uses live Codex reasoning descriptors without slug assumptions", () => {
    const provider: UiProvider = {
      id: "codex",
      name: "Codex (CLI)",
      logo: "",
      providerKind: "codex",
      models: [
        {
          id: "live-model-with-arbitrary-name",
          name: "Live model",
          context: "runtime",
          tier: "Runtime",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "max", label: "Maximum", isDefault: true },
                  { id: "ultra", label: "Ultra" },
                ],
                currentValue: "max",
              },
            ],
          },
        },
      ],
    }

    expect(
      getModelThinkingOptions(provider, "live-model-with-arbitrary-name")
    ).toEqual([
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low" },
      { mode: "max", label: "Maximum" },
      { mode: "ultra", label: "Ultra" },
    ])
    expect(
      coerceThinkingModeForModel(
        provider,
        "live-model-with-arbitrary-name",
        "ultra"
      )
    ).toBe("ultra")
    expect(
      coerceThinkingModeForModel(
        provider,
        "live-model-with-arbitrary-name",
        "High"
      )
    ).toBe("Low")
  })

  it("maps GPT xHigh style selections to Claude-native max effort", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Opus 4.7",
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
                  { id: "xhigh", label: "Extra High", isDefault: true },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    }

    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "xHigh")
    ).toBe("max")
    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "Extra High")
    ).toBe("max")
    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "ExtraHigh")
    ).toBe("max")
    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "Ultra Think")
    ).toBe("ultrathink")
    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "No Reasoning")
    ).toBe("Low")
  })

  it("maps GPT xHigh to Claude max before runtime descriptors load", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    }

    expect(getModelThinkingOptions(provider, "claude-opus-4-7")).toEqual([
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low" },
      { mode: "Medium", label: "Medium" },
      { mode: "High", label: "High" },
      { mode: "xHigh", label: "Extra High" },
      { mode: "max", label: "Max" },
      { mode: "ultracode", label: "Ultracode" },
    ])
    expect(
      coerceThinkingModeForModel(provider, "claude-opus-4-7", "xHigh")
    ).toBe("max")
    expect(getThinkingModeLabel(provider, "claude-opus-4-7", "max")).toBe("Max")
  })

  it("maps dotted Opus 4.7 aliases to Claude max and ultrathink before descriptors load", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "opus-4.7",
          name: "Opus 4.7",
          context: "1M",
          tier: "Flagship",
        },
      ],
    }

    expect(getModelThinkingOptions(provider, "opus-4.7")).toEqual([
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low" },
      { mode: "Medium", label: "Medium" },
      { mode: "High", label: "High" },
      { mode: "xHigh", label: "Extra High" },
      { mode: "max", label: "Max" },
      { mode: "ultracode", label: "Ultracode" },
    ])
    expect(coerceThinkingModeForModel(provider, "opus-4.7", "ExtraHigh")).toBe(
      "max"
    )
    // Ultrathink left the menu; a stored selection steps down to Max.
    expect(
      coerceThinkingModeForModel(provider, "opus-4.7", "Ultra Think")
    ).toBe("max")
  })

  it("keeps a fallback-coerced Claude max value stable after descriptors arrive", () => {
    const provider: UiProvider = {
      id: "claude",
      name: "Claude CLI",
      logo: "",
      providerKind: "claude",
      models: [
        {
          id: "claude-opus-4-7",
          name: "Opus 4.7",
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
                  { id: "xhigh", label: "Extra High", isDefault: true },
                  { id: "max", label: "Max" },
                  { id: "ultrathink", label: "Ultrathink" },
                ],
              },
            ],
          },
        },
      ],
    }

    expect(coerceThinkingModeForModel(provider, "claude-opus-4-7", "max")).toBe(
      "max"
    )
  })

  it("maps Claude max effort back to GPT xHigh when switching providers", () => {
    const provider: UiProvider = {
      id: "codex",
      name: "Codex",
      logo: "",
      providerKind: "codex",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT 5.5",
          context: "400K",
          tier: "Flagship",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "none", label: "No Reasoning" },
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                ],
              },
            ],
          },
        },
      ],
    }

    expect(coerceThinkingModeForModel(provider, "gpt-5.5", "max")).toBe("xHigh")
    expect(coerceThinkingModeForModel(provider, "gpt-5.5", "ultrathink")).toBe(
      "xHigh"
    )
  })
})
