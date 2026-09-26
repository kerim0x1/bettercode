import { canonicalProviderKindAlias } from "./providerKindAliases"

export interface ProjectProviderPolicy {
  readonly enabledProviders: readonly string[]
  readonly disabledProviders: readonly string[]
  readonly providers?: readonly ProjectProviderModelPolicy[]
}

export interface ProjectProviderModelPolicy {
  readonly id: string
  readonly whitelist?: readonly string[]
  readonly blacklist?: readonly string[]
}

export interface RuntimeProviderPolicyTarget {
  readonly instanceId: string
  readonly driver: string
  readonly displayName?: string | null
}

export interface RuntimeModelPolicyTarget {
  readonly slug: string
  readonly name?: string | null
  readonly shortName?: string | null
  readonly subProvider?: string | null
  readonly catalog?: {
    readonly providerId?: string | null
    readonly modelId?: string | null
    readonly api?: {
      readonly id?: string | null
    } | null
  } | null
}

export function isRuntimeProviderAllowedByProjectPolicy(
  provider: RuntimeProviderPolicyTarget,
  policy: ProjectProviderPolicy | null | undefined
): boolean {
  if (!policy) return true
  const keys = runtimeProviderProjectPolicyKeys(provider)
  const enabled = normalizeProviderPolicySet(policy.enabledProviders)
  const disabled = normalizeProviderPolicySet(policy.disabledProviders)
  if (disabled.size > 0 && keys.some((key) => disabled.has(key))) {
    return false
  }
  if (enabled.size > 0 && !keys.some((key) => enabled.has(key))) {
    return false
  }
  return true
}

export function isRuntimeModelAllowedByProjectPolicy(
  provider: RuntimeProviderPolicyTarget,
  model: RuntimeModelPolicyTarget,
  policy: ProjectProviderPolicy | null | undefined
): boolean {
  const matchingPolicy = runtimeModelPolicyForProvider(provider, model, policy)
  if (!matchingPolicy) return true

  const modelKeys = runtimeModelProjectPolicyKeys(model)
  const blacklist = normalizeModelPolicySet(matchingPolicy.blacklist ?? [])
  if (blacklist.size > 0 && modelKeys.some((key) => blacklist.has(key))) {
    return false
  }

  const whitelist = normalizeModelPolicySet(matchingPolicy.whitelist ?? [])
  if (whitelist.size > 0 && !modelKeys.some((key) => whitelist.has(key))) {
    return false
  }

  return true
}

export function filterRuntimeModelsByProjectPolicy<
  T extends RuntimeModelPolicyTarget,
>(
  provider: RuntimeProviderPolicyTarget,
  models: readonly T[],
  policy: ProjectProviderPolicy | null | undefined
): readonly T[] {
  if (!policy?.providers || policy.providers.length === 0) return models
  return models.filter((model) =>
    isRuntimeModelAllowedByProjectPolicy(provider, model, policy)
  )
}

export function runtimeProviderProjectPolicyKeys(
  provider: RuntimeProviderPolicyTarget
): string[] {
  const keys = new Set<string>()
  addProviderProjectAliases(keys, provider.instanceId)
  addProviderProjectAliases(keys, provider.driver)
  if (provider.displayName) addProviderProjectAliases(keys, provider.displayName)
  return [...keys]
}

export function runtimeModelProjectPolicyKeys(
  model: RuntimeModelPolicyTarget
): string[] {
  const keys = new Set<string>()
  addModelProjectAliases(keys, model.slug)
  if (model.name) addModelProjectAliases(keys, model.name)
  if (model.shortName) addModelProjectAliases(keys, model.shortName)
  if (model.subProvider) addModelProjectAliases(keys, model.subProvider)
  if (model.catalog?.modelId) addModelProjectAliases(keys, model.catalog.modelId)
  if (model.catalog?.api?.id) addModelProjectAliases(keys, model.catalog.api.id)
  return [...keys]
}

function runtimeModelPolicyForProvider(
  provider: RuntimeProviderPolicyTarget,
  model: RuntimeModelPolicyTarget,
  policy: ProjectProviderPolicy | null | undefined
): ProjectProviderModelPolicy | null {
  if (!policy?.providers || policy.providers.length === 0) return null

  const providerKeys = new Set(runtimeProviderProjectPolicyKeys(provider))
  let catalogProviderId = model.catalog?.providerId
  const driverKind = canonicalProviderKindAlias(provider.driver)
  if (
    !catalogProviderId &&
    (driverKind === "betterc0de" || driverKind === "opencode_cli")
  ) {
    // Dispatch carries a provider/model slug without the catalog metadata
    // used by model listing. Both paths must apply the upstream policy.
    const slug = model.slug.trim()
    const separator = slug.indexOf("/")
    if (separator > 0 && separator < slug.length - 1) {
      catalogProviderId = slug.slice(0, separator)
    }
  }
  if (catalogProviderId) {
    for (const key of providerProjectPolicyKeysForId(catalogProviderId)) {
      providerKeys.add(key)
    }
  }

  for (const providerPolicy of policy.providers) {
    const policyKeys = providerProjectPolicyKeysForId(providerPolicy.id)
    if (policyKeys.some((key) => providerKeys.has(key))) {
      return providerPolicy
    }
  }
  return null
}

function providerProjectPolicyKeysForId(id: string): string[] {
  const keys = new Set<string>()
  addProviderProjectAliases(keys, id)
  return [...keys]
}

function normalizeProviderPolicySet(values: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) addProviderProjectAliases(out, value)
  return out
}

function normalizeModelPolicySet(values: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) addModelProjectAliases(out, value)
  return out
}

function addProviderProjectAliases(keys: Set<string>, raw: string): void {
  const key = normalizeProviderPolicyKey(raw)
  if (!key) return
  keys.add(key)

  if (key === "openai-api" || key === "openaiapi") keys.add("openai")
  if (key === "anthropic-api" || key === "anthropicapi") {
    keys.add("anthropic")
  }
  if (key === "claude-terminal" || key === "claude-pty") {
    keys.add("claude")
    keys.add("anthropic")
  }
  if (key === "claude" || key === "claudecode" || key === "claude-code") {
    keys.add("anthropic")
  }
  if (key === "anthropic") keys.add("claude")
  if (key === "codex" || key === "codex-cli") keys.add("openai")
  if (key === "openai") keys.add("codex")
  if (key === "or-qwen") keys.add("qwen")
  if (key === "qwen") keys.add("or-qwen")
  if (key === "or-deepseek") keys.add("deepseek")
  if (key === "deepseek") keys.add("or-deepseek")
  if (key.startsWith("or-")) keys.add("openrouter")
}

function addModelProjectAliases(keys: Set<string>, raw: string): void {
  const exact = raw.trim()
  if (!exact) return
  keys.add(exact)

  const normalized = normalizeModelPolicyKey(exact)
  if (normalized) keys.add(normalized)

  const slashIndex = normalized.indexOf("/")
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    keys.add(normalized.slice(slashIndex + 1))
  }
}

function normalizeProviderPolicyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

function normalizeModelPolicyKey(value: string): string {
  return value.trim().toLowerCase()
}
