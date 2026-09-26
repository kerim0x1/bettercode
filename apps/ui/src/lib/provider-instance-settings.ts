import type { ProviderInstanceConfig } from "@betterc0de/schema"

export function normalizeProviderDriver(driver: unknown): string {
  const value = typeof driver === "string" && driver.trim() ? driver.trim() : "codex"
  const key = value.toLowerCase().replace(/[_-]+/g, "")
  if (["claude", "anthropiccli", "claudecli", "claudeagent"].includes(key)) return "claude"
  if (["betterc0de", "bettercode"].includes(key)) return "betterc0de"
  if (key === "opencodecli") return "opencode-cli"
  if (key === "opencode") return "betterc0de"
  if (key === "codexcli") return "codex"
  return value
}

/** Keep round trips lossless, including redaction metadata and custom drivers.
 * Defaults belong to newly created instances; adding empty destination fields
 * to an existing profile changes its credential binding on the backend. */
export function normalizeProviderInstanceConfig(
  instanceId: string,
  raw: Partial<ProviderInstanceConfig>
): ProviderInstanceConfig {
  return {
    ...raw,
    instanceId: raw.instanceId || instanceId,
    driver: normalizeProviderDriver(raw.driver),
    enabled: raw.enabled !== false,
    environment: (raw.environment ?? []).map((item) => ({ ...item })),
    config: { ...(raw.config ?? {}) },
  }
}

export function isValidEnvironmentDraft(environment: ProviderInstanceConfig["environment"]): boolean {
  return environment.every((item) => /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(item.name))
}

export function changedProviderConfigFields(config: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const current = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown> : {}
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) =>
    !Object.is(current[key], value) && !(value === "" && current[key] == null)
  ))
}
