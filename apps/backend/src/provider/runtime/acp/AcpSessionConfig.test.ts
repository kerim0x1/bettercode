import { describe, expect, it } from "vitest"
import {
  buildAcpDiscoveredModelsFromConfigOptions,
  buildAcpDiscoveredModelsFromSessionModels,
  findAcpModelConfigOption,
  resolveAcpAdvertisedModelId,
  resolveAcpBaseModelId,
  resolveAcpConfigUpdates,
  type AcpSessionConfigOption,
} from "./AcpSessionConfig"

const parameterizedConfigOptions: ReadonlyArray<AcpSessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "model_config",
    type: "boolean",
    currentValue: false,
  },
]

describe("resolveAcpBaseModelId", () => {
  it("preserves opaque ACP model values", () => {
    expect(
      resolveAcpBaseModelId(
        "gpt-5.4-medium-fast[reasoning=medium,context=272k]"
      )
    ).toBe("gpt-5.4-medium-fast[reasoning=medium,context=272k]")
  })

  it("falls back to default for empty values", () => {
    expect(resolveAcpBaseModelId(" ")).toBe("default")
  })
})

describe("ACP model inventory", () => {
  it("reads an uncategorized model selector and preserves its exact values", () => {
    const options: AcpSessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "composer[fast]",
        options: [{ value: "composer[fast]", name: "Composer Fast" }],
      },
    ]
    expect(findAcpModelConfigOption(options)?.id).toBe("model")
    expect(buildAcpDiscoveredModelsFromConfigOptions(options)).toEqual([
      expect.objectContaining({
        slug: "composer[fast]",
        name: "Composer Fast",
      }),
    ])
    expect(resolveAcpAdvertisedModelId("composer[fast]", options)).toBe(
      "composer[fast]"
    )
  })

  it("maps older parameter suffixes only to an advertised base model", () => {
    expect(
      resolveAcpAdvertisedModelId(
        "gpt-5.4-medium-fast[reasoning=medium]",
        parameterizedConfigOptions
      )
    ).toBe("gpt-5.4-medium-fast")
    expect(
      resolveAcpAdvertisedModelId(
        "withdrawn[reasoning=medium]",
        parameterizedConfigOptions
      )
    ).toBe("withdrawn[reasoning=medium]")
  })

  it("reads the typed ACP model list when no config selector is advertised", () => {
    expect(
      buildAcpDiscoveredModelsFromSessionModels({
        currentModelId: "auto",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "new-model", name: "New Model" },
        ],
      }).map((model) => model.slug)
    ).toEqual(["auto", "new-model"])
  })
})

describe("resolveAcpConfigUpdates", () => {
  it("maps BetterC0de model selections to advertised ACP config ids", () => {
    expect(
      resolveAcpConfigUpdates(parameterizedConfigOptions, [
        { id: "reasoning", value: "xhigh" },
        { id: "contextWindow", value: "1m" },
        { id: "fastMode", value: true },
        { id: "thinking", value: true },
      ])
    ).toEqual([
      { configId: "reasoning", value: "extra-high" },
      { configId: "context", value: "1m" },
      { configId: "fast", value: "true" },
      { configId: "thinking", value: true },
    ])
  })

  it("accepts legacy effort option ids while preferring the reasoning option", () => {
    expect(
      resolveAcpConfigUpdates(parameterizedConfigOptions, [
        { id: "effort", value: "high" },
      ])
    ).toEqual([{ configId: "reasoning", value: "high" }])
  })
})
