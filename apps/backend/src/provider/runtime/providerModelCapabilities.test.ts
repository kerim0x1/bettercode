import { describe, expect, it } from "vitest"
import path from "node:path"
import {
  providerInstanceModelSchema,
  modelSelectionSchema,
} from "@betterc0de/schema"
import { CodexAdapter } from "./codex/CodexAdapter"
import {
  buildClaudeProviderModel,
  claudeModelSupportsBooleanOption,
  resolveClaudeContextWindow,
  resolveClaudeRuntimeModelId,
} from "./claude/ClaudeAdapter"

describe("provider model capabilities", () => {
  it("offers only custom models until Codex reports its catalog", async () => {
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: path.join(process.cwd(), ".missing-codex-for-model-catalog"),
      customModels: ["custom-codex"],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const models = await adapter.availableModels()
    const custom = models.find((model) => model.slug === "custom-codex")
    expect(models.map((model) => model.slug)).toEqual(["custom-codex"])
    expect(custom?.isCustom).toBe(true)
    expect(custom?.capabilities).toBeNull()
  })

  it("derives Claude option descriptors for saved model IDs", () => {
    const opus48 = buildClaudeProviderModel("claude-opus-4-8")
    const haiku = buildClaudeProviderModel("claude-haiku-4-5-20251001")
    const opus48Effort = opus48?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.id === "effort"
    )

    expect(
      opus48Effort?.type === "select"
        ? opus48Effort.options.find((option) => option.isDefault)
        : undefined
    ).toEqual({ id: "xhigh", label: "Extra High", isDefault: true })
    expect(
      opus48?.capabilities?.optionDescriptors?.some(
        (descriptor) =>
          descriptor.type === "select" && descriptor.id === "contextWindow"
      )
    ).toBe(true)
    // Saved Opus 4.6 selections retain their model-specific option.
    const opus46 = buildClaudeProviderModel("claude-opus-4-6")
    expect(
      opus46.capabilities?.optionDescriptors?.some(
        (descriptor) =>
          descriptor.type === "boolean" && descriptor.id === "fastMode"
      )
    ).toBe(true)
    expect(
      haiku?.capabilities?.optionDescriptors?.some(
        (descriptor) =>
          descriptor.type === "boolean" && descriptor.id === "thinking"
      )
    ).toBe(true)
  })

  it("gates Claude boolean options by the concrete selected model", () => {
    expect(
      claudeModelSupportsBooleanOption("claude-haiku-4-5-20251001", "thinking")
    ).toBe(true)
    expect(
      claudeModelSupportsBooleanOption("claude-opus-4-8", "thinking")
    ).toBe(false)
    // The option also works with a saved context-window suffix.
    expect(
      claudeModelSupportsBooleanOption("claude-opus-4-6", "fastMode")
    ).toBe(true)
    expect(
      claudeModelSupportsBooleanOption("claude-opus-4-6-200k", "fastMode")
    ).toBe(true)
  })

  it("resolves Claude contextWindow from modelSelection before legacy model suffixes", () => {
    expect(resolveClaudeRuntimeModelId("claude-opus-4-6-200k")).toBe(
      "claude-opus-4-6"
    )
    expect(
      resolveClaudeContextWindow(
        {
          threadId: "thread-1",
          message: "Build it",
          modelId: "claude-opus-4-6-200k",
          history: [],
        },
        "claude-opus-4-6-200k"
      )
    ).toBe("200k")
    expect(
      resolveClaudeContextWindow(
        {
          threadId: "thread-1",
          message: "Build it",
          modelId: "claude-opus-4-6-200k",
          modelSelection: {
            instanceId: "claude",
            model: "claude-opus-4-6",
            options: [{ id: "contextWindow", value: "1m" }],
          },
          history: [],
        },
        "claude-opus-4-6-200k"
      )
    ).toBe("1m")
  })

  it("normalizes legacy modelSelection option objects to the canonical array shape", () => {
    const parsed = modelSelectionSchema.parse({
      instanceId: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "high", fastMode: false, ignored: 1 },
    })

    expect(parsed.options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
    ])
  })

  it("validates provider model capabilities across the instance snapshot schema", () => {
    const parsed = providerInstanceModelSchema.parse({
      slug: "gpt-5.5",
      name: "GPT 5.5",
      isCustom: false,
      capabilities: {
        attachment: true,
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
            currentValue: "medium",
          },
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
        ],
      },
    })

    expect(
      parsed.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)
    ).toEqual(["reasoningEffort", "fastMode"])
    expect(parsed.capabilities?.attachment).toBe(true)
  })

  it("preserves BetterC0de-style model catalog metadata across the snapshot schema", () => {
    const parsed = providerInstanceModelSchema.parse({
      slug: "openai/gpt-5",
      name: "GPT-5",
      context: "1M",
      tier: "active",
      catalog: {
        providerId: "openai",
        modelId: "gpt-5",
        api: {
          id: "gpt-5",
          url: "https://api.openai.com/v1",
          package: "@ai-sdk/openai",
        },
        status: "active",
        releaseDate: "2026-01-01",
        limit: {
          context: 1_000_000,
          input: 900_000,
          output: 100_000,
        },
        cost: {
          input: 1.25,
          output: 10,
          cache: { read: 0.125, write: 1.25 },
        },
        variants: {
          medium: {},
          high: { reasoningEffort: "high" },
        },
      },
    })

    expect(parsed.catalog).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
      api: {
        id: "gpt-5",
        url: "https://api.openai.com/v1",
        package: "@ai-sdk/openai",
      },
      status: "active",
      releaseDate: "2026-01-01",
      limit: {
        context: 1_000_000,
        input: 900_000,
        output: 100_000,
      },
      cost: {
        input: 1.25,
        output: 10,
        cache: { read: 0.125, write: 1.25 },
      },
      variants: {
        medium: {},
        high: { reasoningEffort: "high" },
      },
    })
  })

  it("defaults provider model custom and capability fields", () => {
    expect(
      providerInstanceModelSchema.parse({
        slug: "gpt-5.5",
        name: "GPT 5.5",
      })
    ).toMatchObject({
      isCustom: false,
      capabilities: null,
    })
  })
})
