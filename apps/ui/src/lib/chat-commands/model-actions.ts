import { useChatStore } from "@/lib/chat-store"
import {
  cycleModelSelection,
  describeModelCycleSelection,
  type ModelCycleItem,
} from "@/lib/model-cycle"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  getProviderComposerSelection,
  upsertProviderComposerSelection,
} from "@/lib/provider-composer-selection"
import type { UiProvider } from "@/lib/provider-types"
import { type ProviderOptionSelection } from "@betterc0de/schema"
import {
  cycleProviderModelSelectOptionSelection,
  type ModelVariantCycleResult,
} from "./provider-commands"
import { escapeMarkdownTableCell } from "./provider-config"

export function applyModelCycleCommand(input: {
  items: readonly ModelCycleItem[]
  direction: 1 | -1
  selectedProviderId?: string | null
  selectedModel?: string | null
  setSelectedProviderId?: (id: string) => void
  setSelectedModel?: (id: string, providerId?: string) => void
  source: "model" | "favorite"
}): string {
  if (!input.setSelectedProviderId || !input.setSelectedModel) {
    return "# Model Selection\n\n> Model cycling is not available in this surface."
  }
  const next = cycleModelSelection({
    items: input.items,
    currentProviderId: input.selectedProviderId,
    currentModelId: input.selectedModel,
    direction: input.direction,
  })
  if (!next) {
    return input.source === "favorite"
      ? "# Favorite Model Selection\n\n> No favorite models are available yet. Mark models as favorites in the model picker first."
      : "# Model Selection\n\n> No configured provider models are available to cycle."
  }
  input.setSelectedProviderId(next.providerId)
  input.setSelectedModel(next.modelId, next.providerId)
  return describeModelCycleSelection(next, input.source)
}

export function applyModelVariantCycleCommand(input: {
  threadId?: string | null
  provider: UiProvider | undefined
  selectedModel: string
  requestedOptionId?: string | null
}): string {
  const result = cycleProviderModelVariantSelection({
    provider: input.provider,
    selectedModel: input.selectedModel,
    optionSelections: readActiveProviderComposerSelection(
      input.provider?.id,
      input.threadId
    )?.optionSelections,
    requestedOptionId: input.requestedOptionId,
  })

  if (!result.ok) return result.output

  setActiveProviderOptionSelections(
    result.providerId,
    result.optionSelections,
    input.threadId
  )
  return [
    "# Model Variant",
    "",
    `Selected **${result.providerName}** / \`${result.modelName}\`.`,
    "",
    "| Option | Previous | Next |",
    "|:-------|:---------|:-----|",
    `| ${escapeMarkdownTableCell(result.descriptorLabel)} (\`${escapeMarkdownTableCell(result.descriptorId)}\`) | ${formatVariantValue(result.previousValue, result.previousLabel)} | ${formatVariantValue(result.nextValue, result.nextLabel)} |`,
  ].join("\n")
}

export function applyModelAgentCycleCommand(input: {
  threadId?: string | null
  provider: UiProvider | undefined
  selectedModel: string
  direction: 1 | -1
}): string {
  const result = cycleProviderModelAgentSelection({
    provider: input.provider,
    selectedModel: input.selectedModel,
    optionSelections: readActiveProviderComposerSelection(
      input.provider?.id,
      input.threadId
    )?.optionSelections,
    direction: input.direction,
  })

  if (!result.ok) return result.output

  setActiveProviderOptionSelections(
    result.providerId,
    result.optionSelections,
    input.threadId
  )
  return [
    "# Agent Selection",
    "",
    `Selected **${result.providerName}** / \`${result.modelName}\`.`,
    "",
    "| Option | Previous | Next |",
    "|:-------|:---------|:-----|",
    `| ${escapeMarkdownTableCell(result.descriptorLabel)} (\`${escapeMarkdownTableCell(result.descriptorId)}\`) | ${formatVariantValue(result.previousValue, result.previousLabel)} | ${formatVariantValue(result.nextValue, result.nextLabel)} |`,
  ].join("\n")
}

export function cycleProviderModelVariantSelection(input: {
  provider: UiProvider | undefined
  selectedModel: string
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
  requestedOptionId?: string | null
}): ModelVariantCycleResult {
  return cycleProviderModelSelectOptionSelection({
    provider: input.provider,
    selectedModel: input.selectedModel,
    optionSelections: input.optionSelections,
    requestedOptionId: input.requestedOptionId,
    descriptorId: "variant",
    direction: 1,
    allowDefaultSelection: true,
    title: "Model Variant",
    missingMessage:
      "This provider/model does not expose an BetterC0de-compatible model variant yet.",
  })
}

export function cycleProviderModelAgentSelection(input: {
  provider: UiProvider | undefined
  selectedModel: string
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
  direction?: 1 | -1
}): ModelVariantCycleResult {
  return cycleProviderModelSelectOptionSelection({
    provider: input.provider,
    selectedModel: input.selectedModel,
    optionSelections: input.optionSelections,
    descriptorId: "agent",
    direction: input.direction ?? 1,
    allowDefaultSelection: false,
    title: "Agent Selection",
    missingMessage:
      "This provider/model does not expose BetterC0de compatibility provider-agent choices yet.",
  })
}

export function readActiveProviderComposerSelection(
  providerId: string | undefined,
  threadId = useChatStore.getState().activeThreadId
) {
  if (!providerId) return undefined
  const prefs = usePreferencesStore.getState()
  const chat = useChatStore.getState()
  const threadSettings = threadId ? chat.settingsByThread[threadId] : undefined
  return getProviderComposerSelection(
    providerId,
    prefs.modelSelectionByProvider,
    threadSettings?.modelSelectionByProvider
  )
}

function setActiveProviderOptionSelections(
  providerId: string,
  selections: ReadonlyArray<ProviderOptionSelection>,
  threadId = useChatStore.getState().activeThreadId
): void {
  const optionSelections =
    selections.length > 0
      ? selections.map((selection) => ({ ...selection }))
      : undefined
  const prefs = usePreferencesStore.getState()
  const chat = useChatStore.getState()
  if (threadId) {
    const threadSettings = chat.settingsByThread[threadId]
    const base = getProviderComposerSelection(
      providerId,
      prefs.modelSelectionByProvider,
      threadSettings?.modelSelectionByProvider
    )
    const next = upsertProviderComposerSelection(
      threadSettings?.modelSelectionByProvider,
      providerId,
      { ...(base ?? {}), optionSelections }
    )
    chat.setThreadSetting(threadId, "modelSelectionByProvider", next)
    return
  }
  prefs.set(
    "modelSelectionByProvider",
    upsertProviderComposerSelection(
      prefs.modelSelectionByProvider,
      providerId,
      {
        optionSelections,
      }
    )
  )
}

function formatVariantValue(
  value: string | undefined,
  label: string | undefined
): string {
  if (!value) return "`default`"
  if (!label || label === value) return `\`${escapeMarkdownTableCell(value)}\``
  return `${escapeMarkdownTableCell(label)} (\`${escapeMarkdownTableCell(value)}\`)`
}

export function buildFavoriteToggleOutput(input: {
  providerId: string | null
  modelId: string | null | undefined
  toggleFavorite?: (providerId: string, modelId: string) => void
  isFavorite?: (providerId: string, modelId: string) => boolean
}): string {
  if (!input.providerId || !input.modelId || !input.toggleFavorite) {
    return "# Favorite Model\n\n> Favorite toggling is not available in this surface."
  }
  const wasFavorite =
    input.isFavorite?.(input.providerId, input.modelId) ?? false
  input.toggleFavorite(input.providerId, input.modelId)
  return [
    "# Favorite Model",
    "",
    `${wasFavorite ? "Removed" : "Added"} \`${input.providerId}/${input.modelId}\` ${wasFavorite ? "from" : "to"} favorites.`,
  ].join("\n")
}
