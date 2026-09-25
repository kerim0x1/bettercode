import type { UiProvider } from "@/lib/provider-types"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import {
  chatProviderPriority,
  isHiddenChatProvider,
  resolveSelectableModel,
} from "@betterc0de/schema/model-selection"

export interface ProviderModelSelectionInput {
  readonly providers: ReadonlyArray<UiProvider>
  readonly selectedProviderId: string
  readonly selectedModel: string
  readonly lockedProviderInstanceId?: string | null
  readonly lockedContinuationKey?: string | null
}

export interface ProviderModelSelectionResult {
  readonly provider: UiProvider | undefined
  readonly modelId: string
}

export interface ProviderModelThinkingSelectionInput extends ProviderModelSelectionInput {
  readonly thinkingMode: string | null
}

export interface ProviderModelThinkingSelectionResult extends ProviderModelSelectionResult {
  readonly thinkingMode: string | null
}

export interface ProviderModelSwitchSelectionInput {
  readonly provider: UiProvider
  readonly modelId: string
  readonly thinkingMode: string | null
  readonly contextWindow?: string | null
}

export interface ProviderModelSwitchSelectionResult {
  readonly providerId: string
  readonly modelId: string
  readonly thinkingMode: string | null
  readonly contextWindow: "200k" | "1m"
}

export function resolveProviderModelSelection(
  input: ProviderModelSelectionInput
): ProviderModelSelectionResult {
  const {
    providers: sourceProviders,
    selectedProviderId,
    selectedModel,
    lockedProviderInstanceId,
    lockedContinuationKey,
  } = input

  const providers = sourceProviders.filter(
    (provider) =>
      !isHiddenChatProvider(
        provider.id,
        provider.providerKind,
        provider.providerInstanceId
      )
  )

  const preferred =
    providers.find((provider) => provider.id === selectedProviderId) ??
    resolveLegacyApiProvider(providers, selectedProviderId) ??
    resolveLegacyClaudeTerminalProvider(providers, selectedProviderId)
  const locked = lockedProviderInstanceId
    ? providers.find(
        (provider) => provider.providerInstanceId === lockedProviderInstanceId
      )
    : undefined
  const continuationLocked = lockedContinuationKey
    ? providers.find(
        (provider) => provider.continuationKey === lockedContinuationKey
      )
    : undefined

  const bound =
    resolveLockedProvider(preferred, locked, continuationLocked) ??
    (preferred &&
    (isUsableProvider(preferred) ||
      preferred === locked ||
      preferred === continuationLocked)
      ? preferred
      : undefined) ??
    locked ??
    continuationLocked
  const provider = bound ?? resolveDefaultProvider(providers) ?? preferred

  // A provider fallback must not carry a foreign model into a CLI whose live
  // catalog is still loading. Compatible Claude API model ids can migrate.
  const model =
    !bound &&
    provider &&
    provider !== preferred &&
    !hasSelectableModel(provider, selectedModel)
      ? (provider.models[0]?.id ?? "")
      : selectedModel

  return {
    provider,
    modelId: resolveModelForProvider(provider, model),
  }
}

function isUsableProvider(provider: UiProvider): boolean {
  return (
    provider.configured !== false &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    (provider.models.length > 0 || provider.modelsReady === false)
  )
}

export function resolveDefaultProvider(
  providers: ReadonlyArray<UiProvider>
): UiProvider | undefined {
  return providers
    .filter(
      (provider) =>
        !isHiddenChatProvider(
          provider.id,
          provider.providerKind,
          provider.providerInstanceId
        ) && isUsableProvider(provider)
    )
    .sort(
      (left, right) =>
        chatProviderPriority(left.providerKind ?? left.id) -
        chatProviderPriority(right.providerKind ?? right.id)
    )[0]
}

export function resolveProviderModelThinkingSelection(
  input: ProviderModelThinkingSelectionInput
): ProviderModelThinkingSelectionResult {
  const selection = resolveProviderModelSelection(input)
  return {
    ...selection,
    thinkingMode:
      selection.provider?.modelsReady === false ||
      (selection.modelId &&
        selection.provider &&
        !hasModel(selection.provider, selection.modelId))
        ? input.thinkingMode
        : coerceThinkingModeForModel(
            selection.provider,
            selection.modelId,
            input.thinkingMode
          ),
  }
}

export function resolveProviderModelSwitchSelection(
  input: ProviderModelSwitchSelectionInput
): ProviderModelSwitchSelectionResult {
  return {
    providerId: input.provider.id,
    modelId: input.modelId,
    thinkingMode: coerceThinkingModeForModel(
      input.provider,
      input.modelId,
      input.thinkingMode
    ),
    contextWindow: input.contextWindow === "200k" ? "200k" : "1m",
  }
}

function resolveLegacyClaudeTerminalProvider(
  providers: ReadonlyArray<UiProvider>,
  selectedProviderId: string
): UiProvider | undefined {
  // The "Claude Terminal" provider was removed from the UI. A persisted
  // selection still pointing at it resolves to the built-in Claude (Agent
  // SDK) provider so the user keeps a working Claude selection after upgrade.
  const key = selectedProviderId.toLowerCase().replace(/[^a-z0-9]/g, "")
  const isLegacyClaudeTerminal =
    key.includes("claude") && (key.includes("terminal") || key.includes("pty"))
  if (!isLegacyClaudeTerminal) return undefined
  return providers.find(
    (provider) =>
      provider.id === "claude" && provider.providerInstanceId === "claude"
  )
}

function resolveLegacyApiProvider(
  providers: ReadonlyArray<UiProvider>,
  selectedProviderId: string
): UiProvider | undefined {
  if (selectedProviderId !== "anthropic" && selectedProviderId !== "claude-api")
    return undefined
  return providers.find((provider) => provider.id === "anthropic-api")
}

function resolveLockedProvider(
  preferred: UiProvider | undefined,
  locked: UiProvider | undefined,
  continuationLocked: UiProvider | undefined
): UiProvider | undefined {
  if (
    preferred &&
    locked &&
    preferred.providerInstanceId &&
    locked.providerKind === preferred.providerKind &&
    preferred.providerInstanceId !== locked.providerInstanceId
  ) {
    return locked
  }
  if (
    preferred &&
    continuationLocked &&
    continuationLocked.providerKind === preferred.providerKind &&
    preferred.continuationKey !== continuationLocked.continuationKey
  ) {
    return continuationLocked
  }
  return undefined
}

function resolveModelForProvider(
  provider: UiProvider | undefined,
  selectedModel: string
): string {
  if (!provider) return selectedModel
  if (hasModel(provider, selectedModel)) return selectedModel
  const resolved = resolveSelectableModel(
    provider.providerKind ?? provider.id,
    selectedModel,
    provider.models
  )
  if (resolved) return resolved
  // Preserve a stored ID even after the catalog removes it. Sending requires
  // the user to choose a current model explicitly.
  return selectedModel || provider.models[0]?.id || ""
}

function hasModel(provider: UiProvider, modelId: string): boolean {
  return provider.models.some((model) => model.id === modelId)
}

function hasSelectableModel(provider: UiProvider, modelId: string): boolean {
  return (
    resolveSelectableModel(
      provider.providerKind ?? provider.id,
      modelId,
      provider.models
    ) !== null
  )
}

export function latestProviderInstanceId(
  activities: ReadonlyArray<{
    providerInstanceId?: string | null
    payload?: unknown
  }>
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]
    if (activity.providerInstanceId) return activity.providerInstanceId
    const value = providerActivityField(
      activity.payload,
      "providerInstanceId",
      "provider_instance_id"
    )
    if (value) return value
  }
  return null
}

export function latestProviderContinuationKey(
  activities: ReadonlyArray<{ payload?: unknown }>
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const value = providerActivityField(
      activities[index].payload,
      "continuationKey",
      "continuation_key"
    )
    if (value) return value
  }
  return null
}

function providerActivityField(
  payload: unknown,
  key: string,
  legacyKey: string
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null
  const fields = payload as Record<string, unknown>
  const value = fields[key] ?? fields[legacyKey]
  return typeof value === "string" && value.length > 0 ? value : null
}
