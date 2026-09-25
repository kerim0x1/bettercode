import { useEffect, useMemo, useState } from "react"
import { builtinProviders } from "@/lib/builtin-providers"
import { sortModelsForProviderInstance } from "@/lib/model-ordering"
import { usePluginStore } from "@/lib/plugin-store"
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "@/lib/provider-instances"
import { usePreferencesStore } from "@/lib/preferences-store"
import type { UiProvider } from "@/lib/provider-types"
import { useProviderStatus } from "@/hooks/use-provider-status"
import { useProviderInstances } from "@/hooks/use-provider-instances"
import { useApiModels } from "@/hooks/use-api-models"
import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import { isHiddenChatProvider } from "@betterc0de/schema/model-selection"
import {
  listProjectProviders,
  type WorkspaceProjectProvidersSummary,
} from "@/services/backend/workspaceApi"

/**
 * Reactive list of UI providers — enabled plugin-provided providers first,
 * followed by the built-in provider entries, with live `configured`/`authType`/
 * `setupHint` merged in from `/providers/status`.
 *
 * Plugins come first on purpose: if a plugin ships a provider with the same
 * `id` as a builtin (e.g. an alt Claude CLI integration), the plugin wins
 * by appearing earlier in the merged list — components that dedupe by `id`
 * (like the model picker) therefore see the plugin's version.
 *
 * Status-merge note: the backend keys its status map by `providerKind` —
 * which is a string like `"anthropic"` for the Claude API adapter and
 * `"lmstudio"` for LM Studio. UI providers either declare `providerKind`
 * directly or fall back to `id` (e.g. `"openai-api"` lacks an explicit
 * kind because the backend's OpenAI adapter is keyed `"openai"`). We try
 * both keys so the lookup matches regardless.
 */
export function useProviders(
  cwd?: string | null,
  includeHidden = false
): UiProvider[] {
  const pluginList = usePluginStore((s) => s.plugins)
  const { status } = useProviderStatus()
  const { instances } = useProviderInstances(cwd)
  const apiModels = useApiModels()
  const hiddenProviders = usePreferencesStore((s) => s.hiddenProviders)
  const hiddenModels = usePreferencesStore((s) => s.hiddenModels)
  const [projectProviders, setProjectProviders] =
    useState<WorkspaceProjectProvidersSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    const workspace = cwd?.trim()
    if (!workspace) {
      setProjectProviders(null)
      return
    }
    void listProjectProviders(workspace)
      .then((summary) => {
        if (!cancelled) setProjectProviders(summary)
      })
      .catch(() => {
        if (!cancelled) setProjectProviders(null)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return useMemo(() => {
    const hiddenProviderIds = hiddenProviderIdsForProjectPolicy(
      hiddenProviders,
      projectProviders
    )
    const hiddenModelIds = new Set(hiddenModels)
    const pluginProviders: UiProvider[] = pluginList
      .filter((p) => p.enabled && p.manifest.type === "provider")
      .map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        logo: p.manifest.icon || "",
        models: p.manifest.models,
      }))
    const pluginProviderIds = new Set(
      pluginProviders.map((provider) => provider.id)
    )
    const baseSourceList: UiProvider[] = [
      ...pluginProviders,
      ...builtinProviders,
    ]
    const instanceEntries = deriveProviderInstanceEntries(instances)
    const sortedInstanceEntries = sortProviderInstanceEntries(instanceEntries)
    // The built-in Claude Agent SDK provider stays in the list as-is. Any
    // `claude-terminal` instance (still seeded by the backend) is filtered out
    // so it never appears in the picker.
    const baseList = baseSourceList
    const instanceById = new Map(
      instanceEntries.map((entry) => [entry.instanceId, entry])
    )
    const dynamicInstances = sortedInstanceEntries
      .filter((entry) => !entry.isDefault)
      .filter((entry) => !isClaudeTerminalInstance(entry.instanceId))
      .map((entry) => providerFromInstance(entry, baseList))
      .filter((provider): provider is UiProvider => Boolean(provider))
    return [...baseList, ...dynamicInstances]
      .map((p): UiProvider => {
        // The status map is keyed by the backend's ProviderKind — try the
        // explicit `providerKind` first, fall back to `id`. If neither
        // matches we leave `configured` undefined (= "not yet fetched") so
        // the renderer doesn't pre-emptively disable unknown providers.
        const stat =
          (p.providerKind && status.get(p.providerKind)) ||
          status.get(p.id) ||
          undefined
        const instance = instanceById.get(p.providerInstanceId ?? p.id)
        const apiKind = pluginProviderIds.has(p.id)
          ? null
          : p.id === "openai-api"
            ? "openai"
            : p.id === "anthropic-api"
              ? "anthropic"
              : p.id === "grok"
                ? "grok"
                : null
        const withInstance = instance
          ? {
              ...p,
              name: instance.displayName || p.name,
              continuationKey: instance.continuationKey,
              configured: instance.configured,
              status: instance.status,
              statusMessage:
                instance.snapshot.message ??
                instance.snapshot.unavailableReason,
              availability: instance.snapshot.availability,
              unavailableReason: instance.snapshot.unavailableReason,
              setupHint:
                instance.snapshot.message ??
                instance.snapshot.unavailableReason ??
                p.setupHint,
              models: modelsFromInstance(instance.snapshot, p.models),
              modelsReady: instance.snapshot.models !== undefined,
              providerCatalog: instance.providerCatalog,
              skills: instance.skills,
              agents: instance.agents,
              tools: instance.tools,
              slashCommands: instance.slashCommands,
              environment: instance.snapshot.environment,
            }
          : apiKind
            ? {
                ...p,
                modelsReady: apiModels !== null,
                models:
                  apiModels
                    ?.filter((model) => model.provider === apiKind)
                    .map((model) => ({
                      id: model.slug,
                      name: model.name,
                      context: model.context ?? "runtime",
                      tier: model.tier ?? "Runtime",
                      isCustom: model.isCustom,
                      capabilities: model.capabilities,
                    })) ?? [],
              }
            : {
                ...p,
                modelsReady: p.providerInstanceId ? false : p.modelsReady,
              }
        if (!stat || instance) return withInstance
        return {
          ...withInstance,
          configured: stat.configured,
          status: stat.configured ? "ready" : "warning",
          statusMessage: stat.hint,
          authType: stat.authType,
          setupHint: stat.hint,
        }
      })
      .map((provider) =>
        applyProjectProviderModelDefaults(provider, projectProviders)
      )
      .filter((provider) =>
        isProviderAllowedByProjectPolicy(provider, projectProviders)
      )
      .filter(
        (provider) =>
          includeHidden || isProviderVisible(provider, hiddenProviderIds)
      )
      .filter((provider) => !isBetterC0deProvider(provider))
      .map((provider) =>
        includeHidden ? provider : filterHiddenModels(provider, hiddenModelIds)
      )
  }, [
    apiModels,
    hiddenModels,
    hiddenProviders,
    includeHidden,
    instances,
    pluginList,
    projectProviders,
    status,
  ])
}

export function isProviderAllowedByProjectPolicy(
  provider: UiProvider,
  policy: WorkspaceProjectProvidersSummary | null | undefined
): boolean {
  if (!policy) return true
  const keys = providerProjectPolicyKeys(provider)
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

export function hiddenProviderIdsForProjectPolicy(
  hiddenProviders: readonly string[],
  policy: WorkspaceProjectProvidersSummary | null | undefined
): Set<string> {
  const hiddenProviderIds = new Set(hiddenProviders)
  if (!policy || policy.enabledProviders.length === 0) {
    return hiddenProviderIds
  }

  const enabled = normalizeProviderPolicySet(policy.enabledProviders)
  if (enabled.has("qwen") || enabled.has("or-qwen")) {
    hiddenProviderIds.delete("qwen")
    hiddenProviderIds.delete("or-qwen")
  }
  if (enabled.has("deepseek") || enabled.has("or-deepseek")) {
    hiddenProviderIds.delete("deepseek")
    hiddenProviderIds.delete("or-deepseek")
  }

  return hiddenProviderIds
}

export function applyProjectProviderModelDefaults(
  provider: UiProvider,
  policy: WorkspaceProjectProvidersSummary | null | undefined
): UiProvider {
  if (
    !policy ||
    !providerProjectPolicyKeys(provider).some(
      (key) => key === "betterc0de" || key === "BetterC0de"
    )
  ) {
    return provider
  }

  const defaultModel = policy.defaultModel?.trim()
  const projectModels = projectProviderModelsForPicker(policy)
  if (!defaultModel && projectModels.length === 0) return provider

  const byId = new Map(provider.models.map((model) => [model.id, model]))
  for (const model of projectModels) {
    byId.set(model.id, { ...byId.get(model.id), ...model })
  }
  if (defaultModel && !byId.has(defaultModel)) {
    byId.set(defaultModel, {
      id: defaultModel,
      name: defaultModel,
      context: "project",
      tier: "Project",
      isCustom: true,
    })
  }

  const preferredIds = [
    ...(defaultModel ? [defaultModel] : []),
    ...projectModels.map((model) => model.id),
    ...provider.models.map((model) => model.id),
  ]
  const seen = new Set<string>()
  const models = preferredIds
    .filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return byId.has(id)
    })
    .map((id) => byId.get(id)!)

  return models.length === provider.models.length &&
    models.every((model, index) => model === provider.models[index])
    ? provider
    : { ...provider, models }
}

function projectProviderModelsForPicker(
  policy: WorkspaceProjectProvidersSummary
): UiProvider["models"] {
  return policy.providers.flatMap((projectProvider) =>
    projectProvider.models
      .filter((model) => isProjectProviderModelAllowed(projectProvider, model))
      .map((model) => {
        const id = model.id.includes("/")
          ? model.id
          : `${projectProvider.id}/${model.id}`
        return {
          id,
          name: model.name || id,
          context: model.contextLimit
            ? model.contextLimit.toLocaleString("en-US")
            : "project",
          tier: model.status || "Project",
          isCustom: true,
        }
      })
  )
}

function isProjectProviderModelAllowed(
  provider: WorkspaceProjectProvidersSummary["providers"][number],
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): boolean {
  const modelKeys = modelPolicyKeys(model.id)
  const blacklist = new Set(provider.blacklist.flatMap(modelPolicyKeys))
  if ([...modelKeys].some((key) => blacklist.has(key))) return false

  const whitelist = new Set(provider.whitelist.flatMap(modelPolicyKeys))
  if (whitelist.size > 0 && ![...modelKeys].some((key) => whitelist.has(key))) {
    return false
  }

  return true
}

function modelPolicyKeys(raw: string): string[] {
  const value = raw.trim()
  if (!value) return []
  const normalized = value.toLowerCase()
  const keys = new Set([value, normalized])
  const slashIndex = normalized.indexOf("/")
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    keys.add(normalized.slice(slashIndex + 1))
  }
  return [...keys]
}

export function providerProjectPolicyKeys(provider: UiProvider): string[] {
  const keys = new Set<string>()
  for (const key of providerVisibilityKeys(provider)) {
    addProviderProjectAliases(keys, key)
  }
  if (provider.providerKind)
    addProviderProjectAliases(keys, provider.providerKind)
  if (provider.openaiTransport) addProviderProjectAliases(keys, "openai")
  return [...keys]
}

function normalizeProviderPolicySet(values: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) addProviderPolicyAliases(out, value)
  return out
}

function addProviderProjectAliases(keys: Set<string>, raw: string): void {
  const key = normalizeProviderPolicyKey(raw)
  if (!key) return
  keys.add(key)
  if (key === "openai-api" || key === "openaiapi") keys.add("openai")
  if (key === "anthropic-api" || key === "anthropicapi") keys.add("anthropic")
  if (key === "betterc0de" || key === "bettercode") keys.add("BetterC0de")
  if (key === "BetterC0de") keys.add("betterc0de")
  if (key === "or-qwen") keys.add("qwen")
  if (key === "or-deepseek") keys.add("deepseek")
  if (key.startsWith("or-")) keys.add("openrouter")
}

function addProviderPolicyAliases(keys: Set<string>, raw: string): void {
  const key = normalizeProviderPolicyKey(raw)
  if (!key) return
  keys.add(key)
  if (key === "openai-api" || key === "openaiapi") keys.add("openai")
  if (key === "anthropic-api" || key === "anthropicapi") keys.add("anthropic")
  if (key === "betterc0de" || key === "bettercode") keys.add("BetterC0de")
  if (key === "BetterC0de") keys.add("betterc0de")
  if (key === "or-qwen") keys.add("qwen")
  if (key === "or-deepseek") keys.add("deepseek")
}

function normalizeProviderPolicyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

export function isProviderVisible(
  provider: UiProvider,
  hiddenProviderIds: ReadonlySet<string>
): boolean {
  if (
    isHiddenChatProvider(
      provider.id,
      provider.providerKind,
      provider.providerInstanceId
    )
  )
    return false
  return !providerVisibilityKeys(provider).some((key) =>
    hiddenProviderIds.has(key)
  )
}

export function providerVisibilityKeys(provider: UiProvider): string[] {
  const keys = new Set([provider.id])
  if (provider.id === "anthropic-api") {
    keys.add("anthropic")
    keys.add("claude-api")
  }
  if (provider.providerInstanceId) keys.add(provider.providerInstanceId)
  if (provider.id === "claude-terminal") keys.add("claude")
  if (providerMatchesHiddenFamily(provider, "qwen")) {
    keys.add("or-qwen")
    keys.add("qwen")
  }
  if (providerMatchesHiddenFamily(provider, "deepseek")) {
    keys.add("or-deepseek")
    keys.add("deepseek")
  }
  return [...keys]
}

function providerMatchesHiddenFamily(
  provider: UiProvider,
  family: "deepseek" | "qwen"
): boolean {
  const familyKey = family.toLowerCase()
  return [
    provider.id,
    provider.providerKind,
    provider.providerInstanceId,
    provider.name,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .includes(familyKey)
    )
}

function filterHiddenModels(
  provider: UiProvider,
  hiddenModelIds: ReadonlySet<string>
): UiProvider {
  if (hiddenModelIds.size === 0 || provider.models.length === 0) {
    return provider
  }
  const models = provider.models.filter(
    (model) => !hiddenModelIds.has(model.id)
  )
  return models.length === provider.models.length
    ? provider
    : { ...provider, models }
}

function providerFromInstance(
  entry: ProviderInstanceEntry,
  baseList: UiProvider[]
): UiProvider | null {
  const driver = entry.driverKind
  const base = baseList.find(
    (provider) =>
      provider.providerInstanceId === driver || provider.id === driver
  )
  if (!base) return null
  return {
    ...base,
    id: entry.instanceId,
    name: entry.displayName || `${base.name} (${entry.instanceId})`,
    logo: base.logo,
    providerKind: driver,
    providerInstanceId: entry.instanceId,
    continuationKey: entry.continuationKey,
    configured: entry.configured,
    status: entry.status,
    statusMessage: entry.snapshot.message ?? entry.snapshot.unavailableReason,
    availability: entry.snapshot.availability,
    unavailableReason: entry.snapshot.unavailableReason,
    setupHint: entry.snapshot.message ?? entry.snapshot.unavailableReason,
    models: modelsFromInstance(entry.snapshot, base.models),
    providerCatalog: entry.providerCatalog,
    skills: entry.skills,
    agents: entry.agents,
    tools: entry.tools,
    slashCommands: entry.slashCommands,
  }
}

function isClaudeTerminalInstance(instanceId: string): boolean {
  return /claude.*(?:terminal|pty)|(?:terminal|pty).*claude/i.test(instanceId)
}

/**
 * The "BetterC0de" compatibility provider is intentionally hidden from the
 * model picker — it's a runtime/compatibility inventory, not a model users pick
 * here. This only removes it from the dropdown; Settings (provider instances,
 * the Compatibility tab) and the backend `betterc0de` providerKind are
 * unaffected.
 */
function isBetterC0deProvider(provider: UiProvider): boolean {
  return [provider.id, provider.providerKind, provider.providerInstanceId]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase() === "betterc0de")
}

function modelsFromInstance(
  instance: ProviderInstanceSnapshot,
  fallback: UiProvider["models"]
): UiProvider["models"] {
  const runtimeModels =
    instance.models?.map((model) => ({
      id: model.slug,
      name: model.name || model.slug,
      context: model.context ?? "runtime",
      tier: model.tier ?? "Runtime",
      isCustom: model.isCustom,
      capabilities: model.capabilities,
      catalog: model.catalog,
    })) ?? []
  const customModels = readCustomModels(instance.config).map((id) => ({
    id,
    name: id,
    context: "custom",
    tier: "Custom",
    isCustom: true,
  }))
  // A completed CLI snapshot is authoritative, even when it is empty.
  return mergeModels(
    instance.models === undefined
      ? fallback
      : sortModelsForProviderInstance(runtimeModels),
    customModels
  )
}

export function mergeRuntimeModelMetadata(
  fallback: UiProvider["models"],
  runtimeModels: UiProvider["models"]
): UiProvider["models"] {
  const runtimeById = new Map(runtimeModels.map((model) => [model.id, model]))
  const orderedModels = sortModelsForProviderInstance(
    mergeModels(fallback, runtimeModels)
  )
  return orderedModels.map((model) => {
    const runtime = runtimeById.get(model.id)
    if (!runtime) return model
    return {
      ...model,
      isCustom: runtime.isCustom ?? model.isCustom,
      capabilities: runtime.capabilities ?? model.capabilities,
      catalog: runtime.catalog ?? model.catalog,
    }
  })
}

function readCustomModels(config: Record<string, unknown>): string[] {
  const value = config.customModels
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
}

function mergeModels(
  base: UiProvider["models"],
  extra: UiProvider["models"]
): UiProvider["models"] {
  const seen = new Set<string>()
  const out: UiProvider["models"] = []
  for (const model of [...base, ...extra]) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}
