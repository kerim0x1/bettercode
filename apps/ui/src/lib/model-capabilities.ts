import type { UiProvider, UiProviderModel } from "@/lib/provider-types"
import { isClaudeOpusOrSonnet } from "@/lib/anthropic-model"
import { normalizeThinkingMode } from "@/lib/thinking-mode"
import {
  modelThinkingOptions,
  modelBooleanOption,
  normalizeThinkingModeValue,
  type ProviderOptionDescriptor,
} from "@betterc0de/schema"

type ProviderCapabilitySource = Pick<UiProvider, "id"> & Partial<UiProvider>

export interface ModelThinkingOption {
  readonly mode: string | null
  readonly label: string
}

export function getProviderModel(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined
): UiProviderModel | undefined {
  if (!provider || !modelId) return undefined
  return provider.models?.find((model) => model.id === modelId)
}

export function supportsProviderFastMode(
  provider: ProviderCapabilitySource | null | undefined
): boolean {
  const providerKey = (
    provider?.providerKind ??
    provider?.id ??
    ""
  ).toLowerCase()
  return providerKey === "claude"
}

export function supportsModelBooleanOption(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined,
  optionId: string
): boolean {
  return modelBooleanOption(
    {
      providerKind: getProviderKey(provider),
      modelId: modelId ?? "",
      capabilities: getProviderModel(provider, modelId)?.capabilities,
    },
    optionId
  )
}

export function supportsProviderContextWindow(
  provider: ProviderCapabilitySource | null | undefined
): boolean {
  const providerKey = (
    provider?.providerKind ??
    provider?.id ??
    ""
  ).toLowerCase()
  return (
    providerKey === "claude" ||
    providerKey === "anthropic" ||
    providerKey === "anthropic_cli"
  )
}

export function supportsModelSelectOption(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined,
  optionId: string
): boolean {
  const descriptors = getProviderModel(provider, modelId)?.capabilities
    ?.optionDescriptors
  if (descriptors && descriptors.length > 0) {
    return descriptors.some(
      (descriptor) => descriptor.type === "select" && descriptor.id === optionId
    )
  }
  return (
    optionId === "contextWindow" &&
    supportsProviderContextWindow(provider) &&
    typeof modelId === "string" &&
    isClaudeOpusOrSonnet(modelId)
  )
}

export function supportsModelContextWindow(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined
): boolean {
  return supportsModelSelectOption(provider, modelId, "contextWindow")
}

export function supportsModelAttachments(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined
): boolean {
  const model = getProviderModel(provider, modelId)
  if (typeof model?.capabilities?.attachment === "boolean") {
    return model.capabilities.attachment
  }

  const providerKey = getProviderKey(provider)
  const providerId = (provider?.id ?? "").toLowerCase()
  const transport = provider?.openaiTransport

  if (providerKey === "betterc0de" || providerKey === "BetterC0de") return true
  if (providerKey === "codex") return true
  if (providerKey === "anthropic" || providerId === "anthropic") return true
  if (providerKey === "openai" && transport !== "cli") return true
  return false
}

export function getModelSelectDescriptor(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined,
  optionIds: string | ReadonlyArray<string>
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  const ids = typeof optionIds === "string" ? [optionIds] : optionIds
  const descriptors = getProviderModel(provider, modelId)?.capabilities
    ?.optionDescriptors
  return descriptors?.find(
    (
      descriptor
    ): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" && ids.includes(descriptor.id)
  )
}

export function getModelThinkingOptions(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined
): ReadonlyArray<ModelThinkingOption> {
  return modelThinkingOptions({
    providerKind: getProviderKey(provider),
    modelId: modelId ?? "",
    capabilities: getProviderModel(provider, modelId)?.capabilities,
  })
}

export function getThinkingModeLabel(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined,
  thinkingMode: string | null
): string | null {
  if (!thinkingMode) return null
  const normalized = normalizeThinkingModeValue(thinkingMode)
  return (
    getModelThinkingOptions(provider, modelId).find((option) =>
      option.mode
        ? normalizeThinkingModeValue(option.mode) === normalized
        : false
    )?.label ?? thinkingMode
  )
}

export function coerceThinkingModeForModel(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined,
  thinkingMode: string | null
): string | null {
  if (modelId === "claude-opus-5-5" && !thinkingMode) return "Medium"
  const providerKey = getProviderKey(provider)
  const normalized = normalizeThinkingMode(
    provider
      ? { id: provider.id, providerKind: provider.providerKind }
      : undefined,
    modelId ?? "",
    thinkingMode
  )
  if (!normalized) return normalized

  const supportedModes = new Map<string, string>()
  for (const option of getModelThinkingOptions(provider, modelId)) {
    if (option.mode) {
      supportedModes.set(normalizeThinkingModeValue(option.mode), option.mode)
    }
  }
  if (supportedModes.size === 0) return normalized

  const key = normalizeThinkingModeValue(normalized)
  const isClaude =
    providerKey.includes("anthropic") || providerKey.includes("claude")

  if (isClaude) {
    if (key === "xhigh") {
      return (
        firstSupportedThinkingMode(supportedModes, [
          "max",
          "ultrathink",
          "xhigh",
          "high",
        ]) ?? normalized
      )
    }
    if (key === "ultrathink") {
      return (
        firstSupportedThinkingMode(supportedModes, [
          "ultrathink",
          "max",
          "xhigh",
          "high",
        ]) ?? normalized
      )
    }
    if (key === "max") {
      return (
        firstSupportedThinkingMode(supportedModes, [
          "max",
          "ultrathink",
          "xhigh",
          "high",
        ]) ?? normalized
      )
    }
  }

  if (supportedModes.has(key)) return supportedModes.get(key) ?? normalized

  if (key === "none") {
    return (
      firstSupportedThinkingMode(supportedModes, ["low", "medium", "high"]) ??
      normalized
    )
  }

  if (key === "ultra") {
    // Step down using only the options advertised by the selected model.
    return (
      firstSupportedThinkingMode(supportedModes, [
        "max",
        "xhigh",
        "high",
        "medium",
        "low",
      ]) ?? normalized
    )
  }

  if (key === "max" || key === "ultrathink" || key === "xhigh") {
    return (
      firstSupportedThinkingMode(supportedModes, [
        "xhigh",
        "high",
        "medium",
        "low",
      ]) ?? normalized
    )
  }

  if (key === "high") {
    return (
      firstSupportedThinkingMode(supportedModes, ["high", "medium", "low"]) ??
      normalized
    )
  }

  if (key === "medium") {
    return (
      firstSupportedThinkingMode(supportedModes, ["medium", "low", "high"]) ??
      normalized
    )
  }

  return (
    firstSupportedThinkingMode(supportedModes, [
      "low",
      "medium",
      "high",
      "xhigh",
    ]) ?? normalized
  )
}

export function isThinkingModeOptionActive(
  thinkingMode: string | null,
  optionMode: string | null
): boolean {
  if (thinkingMode === null || optionMode === null)
    return thinkingMode === optionMode
  return (
    normalizeThinkingModeValue(thinkingMode) ===
    normalizeThinkingModeValue(optionMode)
  )
}

export function supportsModelFastMode(
  provider: ProviderCapabilitySource | null | undefined,
  modelId: string | null | undefined
): boolean {
  return supportsModelBooleanOption(provider, modelId, "fastMode")
}

function getProviderKey(
  provider: ProviderCapabilitySource | null | undefined
): string {
  return (provider?.providerKind ?? provider?.id ?? "").toLowerCase()
}

function firstSupportedThinkingMode(
  supportedModes: ReadonlyMap<string, string>,
  candidates: ReadonlyArray<string>
): string | undefined {
  for (const candidate of candidates) {
    const mode = supportedModes.get(candidate)
    if (mode) return mode
  }
  return undefined
}
