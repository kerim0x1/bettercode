import { describe, expect, it } from "vitest"
import {
  filterRuntimeModelsByProjectPolicy,
  isRuntimeModelAllowedByProjectPolicy,
  isRuntimeProviderAllowedByProjectPolicy,
  runtimeModelProjectPolicyKeys,
  runtimeProviderProjectPolicyKeys,
} from "./projectProviderPolicy"

describe("runtime provider project policy", () => {
  it("applies BetterC0de enabled_providers as an allowlist", () => {
    expect(
      isRuntimeProviderAllowedByProjectPolicy(
        { instanceId: "BetterC0de", driver: "BetterC0de" },
        { enabledProviders: ["BetterC0de"], disabledProviders: [] }
      )
    ).toBe(true)
    expect(
      isRuntimeProviderAllowedByProjectPolicy(
        { instanceId: "cursor", driver: "cursor" },
        { enabledProviders: ["BetterC0de"], disabledProviders: [] }
      )
    ).toBe(false)
  })

  it("applies BetterC0de disabled_providers before the allowlist", () => {
    expect(
      isRuntimeProviderAllowedByProjectPolicy(
        { instanceId: "claude-terminal", driver: "claude-terminal" },
        { enabledProviders: ["anthropic"], disabledProviders: ["claude"] }
      )
    ).toBe(false)
  })

  it("maps BetterC0de runtime drivers to BetterC0de provider aliases", () => {
    expect(
      runtimeProviderProjectPolicyKeys({
        instanceId: "claude-terminal",
        driver: "claude-terminal",
      })
    ).toEqual(["claude-terminal", "claude", "anthropic"])
    expect(
      runtimeProviderProjectPolicyKeys({ instanceId: "codex", driver: "codex" })
    ).toEqual(["codex", "openai"])
  })

  it("applies BetterC0de provider model whitelist and blacklist entries", () => {
    const provider = { instanceId: "codex", driver: "codex" }
    const policy = {
      enabledProviders: [],
      disabledProviders: [],
      providers: [
        {
          id: "openai",
          whitelist: ["gpt-5.5"],
          blacklist: ["gpt-blocked"],
        },
      ],
    }

    expect(
      isRuntimeModelAllowedByProjectPolicy(
        provider,
        {
          slug: "gpt-5.5",
          name: "GPT 5.5",
          catalog: { providerId: "openai", modelId: "gpt-5.5" },
        },
        policy
      )
    ).toBe(true)
    expect(
      isRuntimeModelAllowedByProjectPolicy(
        provider,
        { slug: "gpt-blocked", name: "GPT Blocked" },
        policy
      )
    ).toBe(false)
    expect(
      isRuntimeModelAllowedByProjectPolicy(
        provider,
        { slug: "gpt-other", name: "GPT Other" },
        policy
      )
    ).toBe(false)
  })

  it("matches slash-qualified BetterC0de model ids by provider-local model id", () => {
    expect(runtimeModelProjectPolicyKeys({ slug: "openai/gpt-5.5" })).toEqual([
      "openai/gpt-5.5",
      "gpt-5.5",
    ])
    expect(
      filterRuntimeModelsByProjectPolicy(
        { instanceId: "BetterC0de", driver: "BetterC0de" },
        [
          {
            slug: "openai/gpt-5.5",
            name: "GPT 5.5",
            catalog: { providerId: "openai", modelId: "gpt-5.5" },
          },
          {
            slug: "anthropic/claude-opus",
            name: "Claude Opus",
            catalog: { providerId: "anthropic", modelId: "claude-opus" },
          },
        ],
        {
          enabledProviders: [],
          disabledProviders: [],
          providers: [{ id: "openai", whitelist: ["gpt-5.5"] }],
        }
      ).map((model) => model.slug)
    ).toEqual(["openai/gpt-5.5", "anthropic/claude-opus"])
  })
  it("applies upstream provider policies to catalog-less dispatch slugs", () => {
    const policy = {
      enabledProviders: [],
      disabledProviders: [],
      providers: [{ id: "anthropic", blacklist: ["claude-opus"] }],
    }
    for (const provider of [
      { instanceId: "BetterC0de", driver: "BetterC0de" },
      { instanceId: "opencode-cli", driver: "opencode-cli" },
    ]) {
      expect(
        isRuntimeModelAllowedByProjectPolicy(
          provider,
          { slug: "anthropic/claude-opus" },
          policy
        )
      ).toBe(false)
      expect(
        isRuntimeModelAllowedByProjectPolicy(
          provider,
          { slug: "openai/gpt-5.5" },
          policy
        )
      ).toBe(true)
    }
  })
})
