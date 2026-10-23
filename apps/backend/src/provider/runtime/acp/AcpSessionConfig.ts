import type {
  ModelCapabilities,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@betterc0de/schema"
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@betterc0de/schema"

/**
 * Agent Client Protocol session config options (`configOptions` of
 * `session/new`): finding the model selector, mapping BetterC0de option
 * selections (reasoning, context window, fast mode, thinking) onto the
 * advertised config ids, and deriving model inventories and capability
 * descriptors from them. Protocol-generic and shared by every ACP agent;
 * vendor specifics belong in the provider folders.
 */

export interface AcpSelectOption {
  readonly value: string
  readonly name: string
}

export interface AcpSelectOptionGroup {
  readonly name: string
  readonly options: ReadonlyArray<AcpSelectOption>
}

export type AcpSessionConfigOption =
  | {
      readonly id: string
      readonly name: string
      readonly category?: string
      readonly type: "select"
      readonly currentValue?: string
      readonly options: ReadonlyArray<AcpSelectOption | AcpSelectOptionGroup>
    }
  | {
      readonly id: string
      readonly name: string
      readonly category?: string
      readonly type: "boolean"
      readonly currentValue?: boolean
    }

export function resolveAcpBaseModelId(
  model: string | null | undefined
): string {
  // ACP option values are opaque. A bracket can be part of the advertised ID.
  return model?.trim() || "default"
}

export function findAcpModelConfigOption(
  configOptions: ReadonlyArray<AcpSessionConfigOption>
): AcpSessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.type === "select" &&
      (getConfigOptionCategory(option) === "model" ||
        option.id.trim().toLowerCase() === "model")
  )
}

/**
 * Some ACP agents (OpenCode) expose their build/plan selector as a session
 * config option instead of the older `modes` field. Treat it as the mode
 * state so plan intent reaches `session/set_config_option`.
 */
export function findAcpModeConfigOption(
  configOptions: ReadonlyArray<AcpSessionConfigOption>
): AcpSessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.type === "select" &&
      (getConfigOptionCategory(option) === "mode" ||
        option.id.trim().toLowerCase() === "mode")
  )
}

export function modeStateFromConfigOptions(
  configOptions: ReadonlyArray<AcpSessionConfigOption>
):
  | {
      currentModeId: string
      availableModes: ReadonlyArray<{ id: string; name: string }>
    }
  | undefined {
  const option = findAcpModeConfigOption(configOptions)
  if (!option || option.type !== "select") return undefined
  const currentModeId = option.currentValue?.trim()
  const availableModes = flattenSessionConfigSelectOptions(option).map(
    (entry) => ({
      id: entry.value.trim(),
      name: entry.name.trim() || entry.value.trim(),
    })
  )
  if (!currentModeId || availableModes.length === 0) return undefined
  return { currentModeId, availableModes }
}

export function resolveAcpAdvertisedModelId(
  model: string | null | undefined,
  configOptions: ReadonlyArray<AcpSessionConfigOption>
): string {
  const selected = resolveAcpBaseModelId(model)
  const option = findAcpModelConfigOption(configOptions)
  const values = flattenSessionConfigSelectOptions(option).map((entry) =>
    entry.value.trim()
  )
  if (values.includes(selected)) return selected
  // Older BetterC0de selections embedded parameter choices in a suffix.
  // Strip that suffix only when the resulting ID is actually advertised.
  const legacyBase = selected.split("[", 1)[0]!
  return legacyBase !== selected && values.includes(legacyBase)
    ? legacyBase
    : selected
}

export function resolveAcpConfigUpdates(
  configOptions: ReadonlyArray<AcpSessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined
): ReadonlyArray<{
  readonly configId: string
  readonly value: string | boolean
}> {
  if (!configOptions || configOptions.length === 0) return []

  const updates: Array<{ configId: string; value: string | boolean }> = []

  const reasoningOption = findEffortConfigOption(configOptions)
  const requestedReasoning = normalizeAcpReasoningValue(
    getStringSelection(selections, ["reasoning", "effort", "reasoningEffort"])
  )
  if (reasoningOption && requestedReasoning) {
    const value = findSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeAcpReasoningValue(option.value)
      const normalizedName = normalizeAcpReasoningValue(option.name)
      return (
        normalizedValue === requestedReasoning ||
        normalizedName === requestedReasoning
      )
    })
    if (value) updates.push({ configId: reasoningOption.id, value })
  }

  const contextOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isContextConfigOption(option)
  )
  const requestedContextWindow = getStringSelection(selections, [
    "contextWindow",
    "context",
  ])
  if (contextOption && requestedContextWindow) {
    const value = findSelectOptionValue(
      contextOption,
      (option) =>
        normalizeConfigOptionToken(option.value) ===
          normalizeConfigOptionToken(requestedContextWindow) ||
        normalizeConfigOptionToken(option.name) ===
          normalizeConfigOptionToken(requestedContextWindow)
    )
    if (value) updates.push({ configId: contextOption.id, value })
  }

  const fastOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isFastConfigOption(option)
  )
  const requestedFastMode = getBooleanSelection(selections, [
    "fastMode",
    "fast",
  ])
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findBooleanConfigValue(fastOption, requestedFastMode)
    if (value !== undefined) updates.push({ configId: fastOption.id, value })
  }

  const thinkingOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isThinkingConfigOption(option)
  )
  const requestedThinking = getBooleanSelection(selections, [
    "thinking",
    "think",
  ])
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findBooleanConfigValue(thinkingOption, requestedThinking)
    if (value !== undefined)
      updates.push({ configId: thinkingOption.id, value })
  }

  return updates
}

export function buildAcpCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<AcpSessionConfigOption> | null | undefined
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return { optionDescriptors: [] }
  }

  const optionDescriptors: ProviderOptionDescriptor[] = []
  const reasoningConfig = findEffortConfigOption(configOptions)
  if (reasoningConfig?.type === "select") {
    const options = flattenSessionConfigSelectOptions(reasoningConfig).flatMap(
      (entry) => {
        const normalizedValue = normalizeAcpReasoningValue(entry.value)
        if (!normalizedValue) return []
        return [
          {
            id: normalizedValue,
            label: entry.name,
            ...(normalizeAcpReasoningValue(reasoningConfig.currentValue) ===
            normalizedValue
              ? { isDefault: true as const }
              : {}),
          },
        ]
      }
    )
    if (options.length > 0) {
      optionDescriptors.push({
        id: "reasoning",
        label: reasoningConfig.name?.trim() || "Reasoning",
        type: "select",
        options,
        ...(options.find((option) => option.isDefault)?.id
          ? { currentValue: options.find((option) => option.isDefault)?.id }
          : {}),
      })
    }
  }

  const contextOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isContextConfigOption(option)
  )
  if (contextOption?.type === "select") {
    const options = flattenSessionConfigSelectOptions(contextOption).map(
      (entry) => ({
        id: entry.value,
        label: entry.name,
        ...(contextOption.currentValue === entry.value
          ? { isDefault: true as const }
          : {}),
      })
    )
    if (options.length > 0) {
      optionDescriptors.push({
        id: "contextWindow",
        label: contextOption.name?.trim() || "Context Window",
        type: "select",
        options,
        ...(contextOption.currentValue
          ? { currentValue: contextOption.currentValue }
          : {}),
      })
    }
  }

  const fastOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isFastConfigOption(option)
  )
  if (fastOption && isBooleanLikeConfigOption(fastOption)) {
    optionDescriptors.push({
      id: "fastMode",
      label: fastOption.name?.trim() || "Fast Mode",
      type: "boolean",
      ...(getBooleanCurrentValue(fastOption) !== undefined
        ? { currentValue: getBooleanCurrentValue(fastOption) }
        : {}),
    })
  }

  const thinkingOption = configOptions.find(
    (option) =>
      getConfigOptionCategory(option) === "model_config" &&
      isThinkingConfigOption(option)
  )
  if (thinkingOption && isBooleanLikeConfigOption(thinkingOption)) {
    optionDescriptors.push({
      id: "thinking",
      label: thinkingOption.name?.trim() || "Thinking",
      type: "boolean",
      ...(getBooleanCurrentValue(thinkingOption) !== undefined
        ? { currentValue: getBooleanCurrentValue(thinkingOption) }
        : {}),
    })
  }

  return createModelCapabilities({ optionDescriptors })
}

export function buildAcpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<AcpSessionConfigOption> | null | undefined
): ReadonlyArray<ProviderModel> {
  if (!configOptions || configOptions.length === 0) return []
  const modelOption = findAcpModelConfigOption(configOptions)
  const modelChoices = flattenSessionConfigSelectOptions(modelOption)
  if (!modelOption || modelChoices.length === 0) return []
  const currentModelValue =
    modelOption.type === "select"
      ? modelOption.currentValue?.trim() || undefined
      : undefined
  const currentModelCapabilities =
    buildAcpCapabilitiesFromConfigOptions(configOptions)
  return dedupeModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      shortName: modelChoice.name.trim(),
      isCustom: false,
      context: "runtime",
      tier: "Runtime",
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : { optionDescriptors: [] },
    }))
  )
}

export function buildAcpDiscoveredModelsFromSessionModels(
  models:
    | {
        readonly currentModelId?: string
        readonly availableModels?: ReadonlyArray<{
          readonly modelId?: string
          readonly name?: string
          readonly description?: string
        }>
      }
    | null
    | undefined
): ReadonlyArray<ProviderModel> {
  return dedupeModels(
    (models?.availableModels ?? []).flatMap((entry): ProviderModel[] => {
      const slug = entry.modelId?.trim()
      if (!slug) return []
      const name = entry.name?.trim() || slug
      return [
        {
          slug,
          name,
          shortName: name,
          isCustom: false,
          context: "runtime",
          tier: "Runtime",
          capabilities: { optionDescriptors: [] },
        },
      ]
    })
  )
}

export function mergeAcpCustomModels(
  base: ReadonlyArray<ProviderModel>,
  customModels: ReadonlyArray<string>
): ReadonlyArray<ProviderModel> {
  const out: ProviderModel[] = []
  const seen = new Set<string>()
  for (const model of base) {
    if (!model.slug || seen.has(model.slug)) continue
    seen.add(model.slug)
    out.push(model)
  }
  for (const raw of customModels) {
    const slug = raw.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push({
      slug,
      name: slug,
      shortName: slug,
      isCustom: true,
      context: "custom",
      tier: "Custom",
      capabilities: { optionDescriptors: [] },
    })
  }
  return out
}

function getStringSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  ids: ReadonlyArray<string>
): string | undefined {
  for (const id of ids) {
    const value = getProviderOptionStringSelectionValue(selections, id)
    if (value !== undefined) return value
  }
  return undefined
}

function getBooleanSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  ids: ReadonlyArray<string>
): boolean | undefined {
  for (const id of ids) {
    const value = getProviderOptionBooleanSelectionValue(selections, id)
    if (value !== undefined) return value
  }
  return undefined
}

function flattenSessionConfigSelectOptions(
  configOption: AcpSessionConfigOption | undefined
): ReadonlyArray<AcpSelectOption> {
  const flattened: AcpSelectOption[] = []
  if (configOption?.type === "select") {
    for (const entry of configOption.options) {
      const children = "value" in entry ? [entry] : entry.options
      for (const child of children)
        flattened.push({ name: child.name.trim(), value: child.value.trim() })
    }
  }
  return flattened
}

function normalizeAcpReasoningValue(
  value: string | null | undefined
): string | undefined {
  const label = value?.trim().toLowerCase() ?? ""
  if (["xhigh", "extra-high", "extra high"].includes(label)) return "xhigh"
  return ["low", "medium", "high", "max"].find((level) => level === label)
}

function getConfigOptionCategory(option: AcpSessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? ""
}

function optionMatches(
  option: AcpSessionConfigOption,
  ids: readonly string[],
  namePattern: RegExp
): boolean {
  return (
    ids.includes(option.id.trim().toLowerCase()) ||
    namePattern.test(option.name.trim())
  )
}

function isEffortConfigOption(option: AcpSessionConfigOption): boolean {
  return (
    option.type === "select" &&
    optionMatches(option, ["effort", "reasoning"], /effort|reasoning/i)
  )
}

function findEffortConfigOption(
  configOptions: ReadonlyArray<AcpSessionConfigOption>
): AcpSessionConfigOption | undefined {
  let selected: AcpSessionConfigOption | undefined
  let rank = Infinity
  for (const option of configOptions) {
    if (!isEffortConfigOption(option)) continue
    const category = getConfigOptionCategory(option)
    const priority =
      category === "model_option"
        ? 0
        : option.id.trim().toLowerCase() === "effort"
          ? 1
          : category === "thought_level"
            ? 2
            : 3
    if (priority < rank) {
      selected = option
      rank = priority
    }
  }
  return selected
}

function isContextConfigOption(option: AcpSessionConfigOption): boolean {
  return optionMatches(option, ["context", "context_size"], /context/i)
}

function isFastConfigOption(option: AcpSessionConfigOption): boolean {
  return optionMatches(option, ["fast"], /^fast$|fast mode/i)
}

function isThinkingConfigOption(option: AcpSessionConfigOption): boolean {
  return optionMatches(option, ["thinking"], /thinking/i)
}

function normalizeConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  )
}

function findSelectOptionValue(
  configOption: AcpSessionConfigOption | undefined,
  matcher: (option: AcpSelectOption) => boolean
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value
}

function findBooleanConfigValue(
  configOption: AcpSessionConfigOption | undefined,
  requested: boolean
): string | boolean | undefined {
  if (!configOption) return undefined
  if (configOption.type === "boolean") return requested
  return findSelectOptionValue(
    configOption,
    (option) => normalizeConfigOptionToken(option.value) === String(requested)
  )
}

function isBooleanLikeConfigOption(option: AcpSessionConfigOption): boolean {
  if (option.type === "boolean") return true
  if (option.type !== "select") return false
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) =>
      entry.value.trim().toLowerCase()
    )
  )
  return values.has("true") && values.has("false")
}

function getBooleanCurrentValue(
  option: AcpSessionConfigOption | undefined
): boolean | undefined {
  if (!option) return undefined
  if (option.type === "boolean") return option.currentValue
  if (option.type !== "select") return undefined
  const normalized = option.currentValue?.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

function dedupeModels(
  models: ReadonlyArray<ProviderModel>
): ReadonlyArray<ProviderModel> {
  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const model of models) {
    if (!model.slug || seen.has(model.slug)) continue
    seen.add(model.slug)
    out.push(model)
  }
  return out
}
