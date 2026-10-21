import { describe, expect, it } from "vitest"
import { selectOrchestrationModels } from "./model-catalog"

const codex = {
  instanceId: "codex-account-a",
  driver: "codex",
  displayName: "OpenAI account A",
  enabled: true,
  configured: true,
  availability: "available" as const,
  models: [
    { slug: "gpt-6-astra", name: "Astra" },
    { slug: "gpt-6-sol", name: "Sol" },
  ],
}
// The runtime spells the Grok CLI driver like its settings id, not like the
// provider kind workers use.
const grok = {
  ...codex,
  instanceId: "grok-account",
  driver: "grok-cli",
  models: [{ slug: "grok-4.6", name: "Grok" }],
}
const claude = {
  ...codex,
  instanceId: "claude-account",
  driver: "claude",
  models: [{ slug: "fable", name: "Fable" }],
}

describe("orchestration model catalog", () => {
  it("keeps account-specific thinking capabilities for validation and dispatch", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          type: "select" as const,
          label: "Thinking",
          options: [{ id: "high", label: "High" }],
        },
      ],
    }
    const pool = selectOrchestrationModels(
      [
        {
          ...codex,
          models: [{ slug: "gpt-6-astra", name: "Astra", capabilities }],
        },
        { ...codex, instanceId: "second-account" },
      ],
      null,
      ["codex"]
    )
    expect(pool[0]?.capabilities).toEqual(capabilities)
    expect(pool[1]?.capabilities).toBeUndefined()
  })
  it("offers Claude workers with exact native model/account IDs and the same project restrictions", () => {
    const pool = selectOrchestrationModels([codex, grok, claude], null, [
      "claude",
      "codex",
    ])
    expect(pool.map((model) => model.providerKind)).toEqual([
      "codex",
      "codex",
      "claude",
    ])
    expect(pool[2]).toMatchObject({
      providerInstanceId: "claude-account",
      modelId: "fable",
    })
    expect(() =>
      selectOrchestrationModels(
        [claude],
        { enabledProviders: [], disabledProviders: ["claude"] },
        ["claude"]
      )
    ).toThrow("No available Claude")
    expect(() =>
      selectOrchestrationModels([{ ...claude, configured: false }], null, [
        "claude",
      ])
    ).toThrow("No available Claude")
  })
  it("uses exact native model and account IDs, with stable keys and explicit provider selection", () => {
    const instances = [
      codex,
      grok,
      { ...codex, instanceId: "codex-account-b" },
      codex,
    ]
    const all = selectOrchestrationModels(instances, null, [
      "codex",
      "grok_cli",
    ])
    expect(all).toHaveLength(5)
    expect(new Set(all.map((model) => model.id)).size).toBe(5)
    expect(all[0]).toMatchObject({
      providerInstanceId: "codex-account-a",
      modelId: "gpt-6-astra",
      providerKind: "codex",
    })
    expect(selectOrchestrationModels(instances, null, ["grok_cli"])).toEqual([
      all[2],
    ])
    expect(
      selectOrchestrationModels([...instances].reverse(), null, [
        "codex",
        "grok_cli",
      ])
        .map((model) => model.id)
        .sort()
    ).toEqual(all.map((model) => model.id).sort())
  })

  it("rejects unavailable pools and enforces project provider/model restrictions", () => {
    for (const change of [
      { enabled: false },
      { configured: false },
      { availability: "unavailable" as const },
      { driver: "openai" },
    ])
      expect(() =>
        selectOrchestrationModels([{ ...codex, ...change }], null, ["codex"])
      ).toThrow("No available")
    expect(() =>
      selectOrchestrationModels(
        [codex, grok],
        { enabledProviders: [], disabledProviders: ["grok_cli"] },
        ["codex", "grok_cli"]
      )
    ).toThrow("No available Grok")
    const models = selectOrchestrationModels(
      [codex, grok],
      {
        enabledProviders: [],
        disabledProviders: [],
        providers: [{ id: "codex", whitelist: ["gpt-6-astra"] }],
      },
      ["codex"]
    )
    expect(models.map((model) => model.modelId)).toEqual(["gpt-6-astra"])
    expect(() =>
      selectOrchestrationModels([codex], null, ["codex", "grok_cli"])
    ).toThrow("No available Grok")
  })

  it("returns a larger catalog so admission can enforce the limit after the user's model selection", () => {
    const models = Array.from({ length: 129 }, (_, i) => ({
      slug: `model-${i}`,
      name: `Model ${i}`,
    }))
    expect(
      selectOrchestrationModels([{ ...codex, models }], null, ["codex"])
    ).toHaveLength(129)
  })
})
