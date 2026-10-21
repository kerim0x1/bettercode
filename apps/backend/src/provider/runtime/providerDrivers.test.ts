import { settingsSchema } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"
import { getProvider } from "../catalog"
import {
  defaultProviderInstances,
  PROVIDER_DRIVER_REGISTRY,
  type ProviderSettingsRecord,
} from "./providerDriverInstances"
import {
  defaultProviderInstanceRank,
  HUB_PROVIDER_KINDS,
  isAcpProviderDriver,
  isHubProviderKind,
  normalizeProviderDriver,
  PROVIDER_DRIVERS,
  providerDriverDescriptor,
} from "./providerDrivers"

describe("provider driver registry", () => {
  it("normalizes every known spelling to its driver and leaves others alone", () => {
    expect(normalizeProviderDriver("Codex_CLI")).toBe("codex")
    expect(normalizeProviderDriver(" codex-cli ")).toBe("codex")
    expect(normalizeProviderDriver("claudeAgent")).toBe("claude")
    expect(normalizeProviderDriver("anthropic_cli")).toBe("claude")
    expect(normalizeProviderDriver("claude-pty")).toBe("claude-terminal")
    expect(normalizeProviderDriver("cursor_agent")).toBe("cursor")
    expect(normalizeProviderDriver("grok-build")).toBe("grok-cli")
    expect(normalizeProviderDriver("BetterCode-Agent")).toBe("betterc0de")
    // Bare `grok` is the legacy xAI API-key provider, never the CLI driver.
    expect(normalizeProviderDriver("grok")).toBe("grok")
    expect(normalizeProviderDriver(" my-driver ")).toBe("my-driver")
  })

  it("claims each alias for exactly one driver", () => {
    const aliases = PROVIDER_DRIVERS.flatMap((driver) => driver.aliases)
    expect(new Set(aliases).size).toBe(aliases.length)
    for (const alias of aliases) {
      expect(alias).toBe(alias.toLowerCase().replace(/[_-]+/g, ""))
    }
  })

  it("orders the default instances and sorts everything else last", () => {
    expect(
      [
        "codex",
        "claude",
        "claude-terminal",
        "cursor",
        "betterc0de",
        "BetterC0de",
        "grok-cli",
      ].map(defaultProviderInstanceRank)
    ).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(defaultProviderInstanceRank("codex-work")).toBe(10)
  })

  it("derives the hub-served provider kinds", () => {
    expect([...HUB_PROVIDER_KINDS].sort()).toEqual(
      ["betterc0de", "claude", "codex", "cursor", "grok_cli"].sort()
    )
    expect(isHubProviderKind("grok_cli")).toBe(true)
    // The API-key providers still run on the legacy stack.
    for (const legacy of ["anthropic", "openai", "grok", "openrouter"]) {
      expect(isHubProviderKind(legacy)).toBe(false)
    }
  })

  it("gives only the ACP drivers the ACP session budgets", () => {
    expect(isAcpProviderDriver("cursor")).toBe(true)
    expect(isAcpProviderDriver("grok-cli")).toBe(true)
    expect(isAcpProviderDriver("codex")).toBe(false)
    expect(isAcpProviderDriver("claude")).toBe(false)
    expect(isAcpProviderDriver("unknown")).toBe(false)
  })

  it("links each driver to an existing catalog entry", () => {
    for (const driver of PROVIDER_DRIVERS) {
      if (driver.catalogId === null) continue
      expect(getProvider(driver.catalogId), driver.driver).toBeDefined()
    }
    expect(providerDriverDescriptor("grok-cli")?.catalogId).toBe("grok-cli")
    expect(providerDriverDescriptor("unknown")).toBeNull()
  })

  it("pairs every registry row with an instance factory", () => {
    expect(PROVIDER_DRIVER_REGISTRY.map((driver) => driver.driver)).toEqual(
      PROVIDER_DRIVERS.map((driver) => driver.driver)
    )
    for (const driver of PROVIDER_DRIVER_REGISTRY) {
      expect(typeof driver.buildInstance, driver.driver).toBe("function")
      expect(typeof driver.defaultInstances, driver.driver).toBe("function")
    }
  })

  it("builds default instances that only use their driver's settings keys", () => {
    const settings = settingsSchema.parse({
      providers: {
        "claude-terminal": { enabled: true },
        betterc0de: { enabled: true },
      },
    })
    const defaults = defaultProviderInstances(
      settings.providers as ProviderSettingsRecord
    )
    expect(Object.keys(defaults).sort()).toEqual(
      [
        "betterc0de",
        "claude",
        "claude-terminal",
        "codex",
        "cursor",
        "grok-cli",
      ].sort()
    )
    for (const [instanceId, config] of Object.entries(defaults)) {
      const descriptor = providerDriverDescriptor(config.driver)
      expect(descriptor, instanceId).not.toBeNull()
      expect(descriptor!.defaultInstanceIds, instanceId).toContain(instanceId)
      const keys = Object.keys((config.config ?? {}) as Record<string, unknown>)
      for (const key of keys) {
        expect(descriptor!.settingsKeys, `${instanceId}.${key}`).toContain(key)
      }
    }
  })

  it("omits the opt-in default instances until they are enabled", () => {
    const defaults = defaultProviderInstances(
      settingsSchema.parse({}).providers as ProviderSettingsRecord
    )
    expect(defaults).not.toHaveProperty("claude-terminal")
    expect(defaults).not.toHaveProperty("betterc0de")
  })
})
