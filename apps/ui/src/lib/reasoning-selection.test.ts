import { describe, expect, it } from "vitest"
import type { ModelCapabilities } from "@betterc0de/schema"
import { normalizeThinkingModeValue } from "@betterc0de/schema"
import {
  coerceThinkingModeForModel,
  getModelThinkingOptions,
} from "./model-capabilities"
import { buildModelSelection } from "@/services/backend/chatApi"
import type { UiProvider } from "./provider-types"

function providerWith(
  providerKind: string,
  capabilities: ModelCapabilities
): UiProvider {
  return {
    id: `${providerKind}-account`,
    providerKind,
    name: providerKind,
    logo: "",
    models: [
      {
        id: "runtime-model",
        name: "Runtime model",
        context: "runtime",
        tier: "Runtime",
        capabilities,
      },
    ],
  }
}

describe("reasoning selection from catalog through request", () => {
  it.each([
    ["claude", "effort"],
    ["anthropic", "effort"],
    ["anthropic_cli", "effort"],
    ["codex", "reasoningEffort"],
    ["openai", "reasoningEffort"],
    ["grok_cli", "reasoningEffort"],
    ["grok", "reasoningEffort"],
    ["cursor", "reasoning"],
    ["google", "effort"],
    ["deepseek", "effort"],
    ["openrouter", "effort"],
    ["custom-provider", "reasoningEffort"],
  ])(
    "keeps every advertised %s level selectable and transmits its %s value",
    (kind, id) => {
      // An advertised value is authoritative even when the legacy provider
      // fallback is capped lower. Include future, provider-defined levels.
      const ids = [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultrathink",
        "ultra",
        "ultracode",
        "vendor-deep",
      ]
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            id,
            label: "Reasoning",
            type: "select",
            currentValue: "high",
            options: [...ids]
              .reverse()
              .map((value) => ({ id: value, label: value })),
          },
        ],
      }
      const provider = providerWith(kind, capabilities)
      const options = getModelThinkingOptions(provider, "runtime-model")
      expect(
        options.map((option) => normalizeThinkingModeValue(option.mode!))
      ).toEqual(ids.map(normalizeThinkingModeValue))
      for (const option of options) {
        const persisted = coerceThinkingModeForModel(
          provider,
          "runtime-model",
          option.mode
        )
        expect(persisted).toBe(option.mode)
        expect(
          coerceThinkingModeForModel(provider, "runtime-model", persisted)
        ).toBe(persisted)
        const wire = buildModelSelection({
          providerKind: kind,
          modelId: "runtime-model",
          capabilities,
          reasoningEffort: persisted,
        })
        const value = ids.find(
          (value) =>
            normalizeThinkingModeValue(value) ===
            normalizeThinkingModeValue(option.mode!)
        )
        expect(wire.options).toEqual([{ id, value }])
      }
    }
  )

  it.each(["claude", "cursor"])(
    "offers an actual thinking toggle for %s models with boolean-only support",
    (kind) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          { id: "effort", label: "Effort", type: "select", options: [] },
          {
            id: "thinking",
            label: "Thinking",
            type: "boolean",
            currentValue: true,
          },
        ],
      }
      const provider = providerWith(kind, capabilities)
      const options = getModelThinkingOptions(provider, "runtime-model")
      expect(options).toEqual([
        { mode: null, label: "Off" },
        { mode: "High", label: "On" },
      ])
      for (const option of options) {
        expect(
          coerceThinkingModeForModel(provider, "runtime-model", option.mode)
        ).toBe(option.mode)
        expect(
          buildModelSelection({
            providerKind: kind,
            modelId: "runtime-model",
            capabilities,
            reasoningEffort: option.mode,
          }).options
        ).toEqual([{ id: "thinking", value: option.mode !== null }])
      }
    }
  )
})
