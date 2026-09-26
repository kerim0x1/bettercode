import type {
  ModelCapabilities,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@betterc0de/schema"
import path from "node:path"
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@betterc0de/schema"

export interface CursorAcpRuntimeSettings {
  readonly binaryPath?: string | null
  readonly apiEndpoint?: string | null
}

export interface CursorAcpSpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

export interface CursorAcpSelectOption {
  readonly value: string
  readonly name: string
}

export interface CursorAcpSelectOptionGroup {
  readonly name: string
  readonly options: ReadonlyArray<CursorAcpSelectOption>
}

export type CursorAcpSessionConfigOption =
  | {
      readonly id: string
      readonly name: string
      readonly category?: string
      readonly type: "select"
      readonly currentValue?: string
      readonly options: ReadonlyArray<
        CursorAcpSelectOption | CursorAcpSelectOptionGroup
      >
    }
  | {
      readonly id: string
      readonly name: string
      readonly category?: string
      readonly type: "boolean"
      readonly currentValue?: boolean
    }

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv
): CursorAcpSpawnInput {
  const command = cursorSettings?.binaryPath?.trim() ?? ""
  if (!path.isAbsolute(command)) {
    throw new Error("Cursor Agent CLI path must be an absolute file path.")
  }
  return {
    command,
    args: [
      ...(cursorSettings?.apiEndpoint
        ? ["-e", cursorSettings.apiEndpoint]
        : []),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  }
}

export function resolveCursorAcpBaseModelId(
  model: string | null | undefined
): string {
  // ACP option values are opaque. A bracket can be part of the advertised ID.
  return model?.trim() || "default"
}

export function findCursorModelConfigOption(
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption>
): CursorAcpSessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.type === "select" &&
      (getCursorConfigOptionCategory(option) === "model" ||
        option.id.trim().toLowerCase() === "model")
  )
}

export function resolveCursorAcpAdvertisedModelId(
  model: string | null | undefined,
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption>
): string {
  const selected = resolveCursorAcpBaseModelId(model)
  const option = findCursorModelConfigOption(configOptions)
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

export function resolveCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined
): ReadonlyArray<{
  readonly configId: string
  readonly value: string | boolean
}> {
  if (!configOptions || configOptions.length === 0) return []

  const updates: Array<{ configId: string; value: string | boolean }> = []

  const reasoningOption = findCursorEffortConfigOption(configOptions)
  const requestedReasoning = normalizeCursorReasoningValue(
    getStringSelection(selections, ["reasoning", "effort", "reasoningEffort"])
  )
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value)
      const normalizedName = normalizeCursorReasoningValue(option.name)
      return (
        normalizedValue === requestedReasoning ||
        normalizedName === requestedReasoning
      )
    })
    if (value) updates.push({ configId: reasoningOption.id, value })
  }

  const contextOption = configOptions.find(
    (option) =>
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorContextConfigOption(option)
  )
  const requestedContextWindow = getStringSelection(selections, [
    "contextWindow",
    "context",
  ])
  if (contextOption && requestedContextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(requestedContextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(requestedContextWindow)
    )
    if (value) updates.push({ configId: contextOption.id, value })
  }

  const fastOption = configOptions.find(
    (option) =>
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorFastConfigOption(option)
  )
  const requestedFastMode = getBooleanSelection(selections, [
    "fastMode",
    "fast",
  ])
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, requestedFastMode)
    if (value !== undefined) updates.push({ configId: fastOption.id, value })
  }

  const thinkingOption = configOptions.find(
    (option) =>
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorThinkingConfigOption(option)
  )
  const requestedThinking = getBooleanSelection(selections, [
    "thinking",
    "think",
  ])
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findCursorBooleanConfigValue(
      thinkingOption,
      requestedThinking
    )
    if (value !== undefined)
      updates.push({ configId: thinkingOption.id, value })
  }

  return updates
}

export function buildCursorCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption> | null | undefined
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return { optionDescriptors: [] }
  }

  const optionDescriptors: ProviderOptionDescriptor[] = []
  const reasoningConfig = findCursorEffortConfigOption(configOptions)
  if (reasoningConfig?.type === "select") {
    const options = flattenSessionConfigSelectOptions(reasoningConfig).flatMap(
      (entry) => {
        const normalizedValue = normalizeCursorReasoningValue(entry.value)
        if (!normalizedValue) return []
        return [
          {
            id: normalizedValue,
            label: entry.name,
            ...(normalizeCursorReasoningValue(reasoningConfig.currentValue) ===
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
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorContextConfigOption(option)
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
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorFastConfigOption(option)
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
      getCursorConfigOptionCategory(option) === "model_config" &&
      isCursorThinkingConfigOption(option)
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

export function buildCursorDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption> | null | undefined
): ReadonlyArray<ProviderModel> {
  if (!configOptions || configOptions.length === 0) return []
  const modelOption = findCursorModelConfigOption(configOptions)
  const modelChoices = flattenSessionConfigSelectOptions(modelOption)
  if (!modelOption || modelChoices.length === 0) return []
  const currentModelValue =
    modelOption.type === "select"
      ? modelOption.currentValue?.trim() || undefined
      : undefined
  const currentModelCapabilities =
    buildCursorCapabilitiesFromConfigOptions(configOptions)
  return dedupeCursorModels(
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

export function buildCursorDiscoveredModelsFromSessionModels(
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
  return dedupeCursorModels(
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

export function mergeCursorCustomModels(
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
  configOption: CursorAcpSessionConfigOption | undefined
): ReadonlyArray<CursorAcpSelectOption> {
  const flattened: CursorAcpSelectOption[] = []
  if (configOption?.type === "select") {
    for (const entry of configOption.options) {
      const children = "value" in entry ? [entry] : entry.options
      for (const child of children)
        flattened.push({ name: child.name.trim(), value: child.value.trim() })
    }
  }
  return flattened
}

function normalizeCursorReasoningValue(
  value: string | null | undefined
): string | undefined {
  const label = value?.trim().toLowerCase() ?? ""
  if (["xhigh", "extra-high", "extra high"].includes(label)) return "xhigh"
  return ["low", "medium", "high", "max"].find((level) => level === label)
}

function getCursorConfigOptionCategory(
  option: CursorAcpSessionConfigOption
): string {
  return option.category?.trim().toLowerCase() ?? ""
}

function optionMatches(
  option: CursorAcpSessionConfigOption,
  ids: readonly string[],
  namePattern: RegExp
): boolean {
  return (
    ids.includes(option.id.trim().toLowerCase()) ||
    namePattern.test(option.name.trim())
  )
}

function isCursorEffortConfigOption(
  option: CursorAcpSessionConfigOption
): boolean {
  return (
    option.type === "select" &&
    optionMatches(option, ["effort", "reasoning"], /effort|reasoning/i)
  )
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<CursorAcpSessionConfigOption>
): CursorAcpSessionConfigOption | undefined {
  let selected: CursorAcpSessionConfigOption | undefined
  let rank = Infinity
  for (const option of configOptions) {
    if (!isCursorEffortConfigOption(option)) continue
    const category = getCursorConfigOptionCategory(option)
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

function isCursorContextConfigOption(
  option: CursorAcpSessionConfigOption
): boolean {
  return optionMatches(option, ["context", "context_size"], /context/i)
}

function isCursorFastConfigOption(
  option: CursorAcpSessionConfigOption
): boolean {
  return optionMatches(option, ["fast"], /^fast$|fast mode/i)
}

function isCursorThinkingConfigOption(
  option: CursorAcpSessionConfigOption
): boolean {
  return optionMatches(option, ["thinking"], /thinking/i)
}

function normalizeCursorConfigOptionToken(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  )
}

function findCursorSelectOptionValue(
  configOption: CursorAcpSessionConfigOption | undefined,
  matcher: (option: CursorAcpSelectOption) => boolean
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value
}

function findCursorBooleanConfigValue(
  configOption: CursorAcpSessionConfigOption | undefined,
  requested: boolean
): string | boolean | undefined {
  if (!configOption) return undefined
  if (configOption.type === "boolean") return requested
  return findCursorSelectOptionValue(
    configOption,
    (option) =>
      normalizeCursorConfigOptionToken(option.value) === String(requested)
  )
}

function isBooleanLikeConfigOption(
  option: CursorAcpSessionConfigOption
): boolean {
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
  option: CursorAcpSessionConfigOption | undefined
): boolean | undefined {
  if (!option) return undefined
  if (option.type === "boolean") return option.currentValue
  if (option.type !== "select") return undefined
  const normalized = option.currentValue?.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

function dedupeCursorModels(
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
