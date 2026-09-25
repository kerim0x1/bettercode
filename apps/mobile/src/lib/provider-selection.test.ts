import { describe, expect, it } from "vitest"
import type { ChatMessage, ChatThread, ProviderInstance } from "@/types/remote"
import { modelOptions, preferredModel } from "./provider-selection"

const now = "2026-07-21T12:00:00.000Z"

const instances: ProviderInstance[] = [
  {
    instanceId: "codex-work",
    driver: "codex",
    displayName: "Codex Work",
    enabled: true,
    configured: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    instanceId: "disabled",
    driver: "claude",
    enabled: false,
    configured: true,
    installed: true,
    status: "disabled",
    availability: "unavailable",
    models: [{ slug: "opus", name: "Opus" }],
  },
]

describe("provider selection", () => {
  it("starts with Claude CLI and falls back through the available CLIs before APIs", () => {
    const instance = (driver: string): ProviderInstance => ({
      instanceId: driver,
      driver,
      enabled: true,
      installed: true,
      configured: true,
      status: "ready",
      availability: "available",
      models: [{ slug: `${driver}-model`, name: driver }],
    })
    const catalog = [
      "anthropic",
      "openai",
      "grok_cli",
      "cursor",
      "codex",
      "claude",
      "claude-terminal",
    ].map(instance)
    expect(modelOptions(catalog).map((option) => option.providerKind)).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok_cli",
      "anthropic",
      "openai",
    ])
    const thread: ChatThread = {
      id: "new",
      title: "New",
      projectName: "Repo",
      projectPath: "/repo",
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    expect(
      preferredModel(thread, [], modelOptions(catalog))?.providerKind
    ).toBe("claude")
    for (const kind of [
      "claude",
      "codex",
      "cursor",
      "grok_cli",
      "anthropic",
      "openai",
    ]) {
      const options = modelOptions(catalog)
      expect(preferredModel(thread, [], options)?.providerKind).toBe(kind)
      catalog.find((entry) => entry.driver === kind)!.configured = false
    }
    expect(preferredModel(thread, [], modelOptions(catalog))).toBeNull()
  })

  it("only exposes dispatchable provider models", () => {
    expect(modelOptions(instances).map((option) => option.modelId)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ])
  })

  it("prefers the thread binding and its last-used model", () => {
    const thread: ChatThread = {
      id: "thread-1",
      title: "Test",
      projectName: "Repo",
      projectPath: "/repo",
      session: { providerKind: "codex", providerInstanceId: "codex-work" },
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Done",
        modelId: "gpt-5.4-mini",
        createdAt: now,
      },
    ]
    expect(
      preferredModel(thread, messages, modelOptions(instances))?.modelId
    ).toBe("gpt-5.4-mini")
  })
})
