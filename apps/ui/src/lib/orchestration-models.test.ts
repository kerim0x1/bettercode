import { describe, expect, it } from "vitest"
import {
  chatOrchestrationSchema,
  orchestrationForMain,
} from "@betterc0de/schema"
import {
  subagentModelChoices,
  selectedSubagentModels,
  orchestrationWithModels,
} from "./orchestration-models"
import type { UiProvider } from "./provider-types"

const codex: UiProvider = {
  id: "codex-work",
  name: "Work account",
  providerKind: "codex",
  providerInstanceId: "codex-work",
  logo: "",
  models: [
    { id: "gpt-6-astra", name: "Astra", context: "1m", tier: "Main" },
    { id: "gpt-6-sol", name: "Sol", context: "1m", tier: "Main" },
  ],
}
const claude: UiProvider = {
  ...codex,
  id: "claude",
  name: "Claude",
  providerKind: "claude",
  providerInstanceId: "claude",
  models: [{ id: "fable", name: "Fable", context: "1m", tier: "Main" }],
}
const catalog = [
  codex,
  claude,
  {
    ...codex,
    id: "personal",
    name: "Personal account",
    providerInstanceId: "personal",
  },
]

describe("subagent model selection", () => {
  it("never offers Ultracode to workers and reads a saved one as Auto", () => {
    const opus = {
      ...claude,
      models: [
        {
          ...claude.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select" as const,
                label: "Effort",
                options: [
                  { id: "high", label: "High" },
                  { id: "ultracode", label: "Ultracode" },
                ],
                promptInjectedValues: ["ultracode"],
              },
            ],
          },
        },
      ],
    }
    const [choice] = subagentModelChoices([opus], "codex")
    expect(choice?.reasoningOptions.map((option) => option.id)).toEqual([
      "high",
    ])
    const saved = {
      providerKind: "claude" as const,
      providerInstanceId: "claude",
      modelId: "fable",
    }
    expect(
      selectedSubagentModels(
        {
          enabled: true,
          providers: ["claude"],
          models: [{ ...saved, reasoningEffort: "Ultra Code" }],
        },
        [choice!]
      )
    ).toEqual([{ ...saved, reasoningEffort: null }])
  })

  it("offers only advertised thinking levels in increasing order and preserves exact selections", () => {
    const withThinking = {
      ...codex,
      models: [
        {
          ...codex.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select" as const,
                label: "Thinking",
                options: [
                  { id: "high", label: "High" },
                  { id: "low", label: "Low" },
                ],
              },
            ],
          },
        },
      ],
    }
    const [choice] = subagentModelChoices([withThinking], "claude")
    expect(choice?.reasoningOptions.map((option) => option.id)).toEqual([
      "low",
      "high",
    ])
    expect(
      subagentModelChoices([codex], "claude").every(
        (item) => item.reasoningOptions.length === 0
      )
    ).toBe(true)
    const selected = {
      providerKind: "codex" as const,
      providerInstanceId: "codex-work",
      modelId: "gpt-6-astra",
      reasoningEffort: "high",
    }
    const selection = orchestrationWithModels([selected])
    const saved = chatOrchestrationSchema.parse(
      JSON.parse(JSON.stringify(selection))
    )
    expect(selectedSubagentModels(saved, [])).toEqual([selected])
    expect(orchestrationForMain(saved, "grok_cli")).toEqual(saved)
  })
  it("shows eligible account-scoped models, excluding main and pending/unavailable providers", () => {
    const choices = subagentModelChoices(catalog, "claude")
    expect(
      choices.map((choice) => [
        choice.value.providerInstanceId,
        choice.value.modelId,
      ])
    ).toEqual([
      ["codex-work", "gpt-6-astra"],
      ["codex-work", "gpt-6-sol"],
      ["personal", "gpt-6-astra"],
      ["personal", "gpt-6-sol"],
    ])
    for (const change of [
      { modelsReady: false },
      { availability: "unavailable" as const },
      { configured: false },
      { providerInstanceId: undefined },
    ])
      expect(
        subagentModelChoices([{ ...codex, ...change }], "grok_cli")
      ).toEqual([])
    expect(subagentModelChoices([codex, codex], "grok_cli")).toHaveLength(2)
  })
  it("freezes selected models, preserves account identity and removes only the new main provider", () => {
    const choices = subagentModelChoices(catalog, "grok_cli")
    const selected = [choices[0]!.value, choices[2]!.value]
    const selection = orchestrationWithModels(selected)
    expect(chatOrchestrationSchema.parse(selection)).toEqual(selection)
    expect(
      selectedSubagentModels(
        selection,
        subagentModelChoices(
          [...catalog, { ...codex, providerInstanceId: "new-account" }],
          "grok_cli"
        )
      )
    ).toEqual(selected)
    expect(orchestrationForMain(selection, "codex")).toEqual({
      enabled: true,
      providers: ["claude"],
      models: [choices[2]!.value],
    })
    expect(orchestrationWithModels([])).toEqual({ enabled: false })
    expect(orchestrationWithModels([selected[0]!, selected[0]!])).toEqual({
      enabled: true,
      providers: ["codex"],
      models: [selected[0]],
    })
    expect(
      selectedSubagentModels({ enabled: true, providers: ["claude"] }, choices)
    ).toEqual([choices[2]!.value])
  })
  it("rejects empty, duplicate, mismatched or partially unspecified explicit model grants", () => {
    const model = subagentModelChoices([codex], "claude")[0]!.value
    for (const value of [
      { providers: ["codex"], models: [] },
      { providers: ["codex"], models: [model, model] },
      { providers: ["claude"], models: [model] },
      { providers: ["codex", "claude"], models: [model] },
      { providers: ["codex"], models: [{ ...model, reasoningEffort: "" }] },
      { providers: ["codex"], models: [{ ...model, reasoningEffort: false }] },
      {
        providers: ["codex"],
        models: [
          { ...model, reasoningEffort: "high" },
          { ...model, reasoningEffort: "low" },
        ],
      },
    ])
      expect(
        chatOrchestrationSchema.safeParse({ enabled: true, ...value }).success
      ).toBe(false)
  })
})
