import { useEffect, useId, useMemo } from "react"
import { ProviderIcon } from "@/components/provider-icon"
import {
  DEFAULT_THINKING_MODE,
  ThinkingEffortSlider,
} from "@/components/chat/thinking-effort-slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useProvidersWithLmStudio } from "@/hooks/use-providers-with-lm-studio"
import type { AutomationDraft } from "@/lib/automations"
import { buildModelSelection } from "@/lib/chat/request-builders"
import {
  getModelThinkingOptions,
  getProviderModel,
  isThinkingModeOptionActive,
} from "@/lib/model-capabilities"
import { displayModelName } from "@/lib/model-display-name"
import { usePluginStore } from "@/lib/plugin-store"
import type { UiProvider } from "@/lib/provider-types"
import { AutomationField, FIELD_SELECT } from "./automation-fields"

/** The backend provider kind a picker entry sends turns to. */
function providerKindOf(provider: UiProvider): string {
  return provider.providerKind ?? provider.id
}

/** The picker entry a saved kind and instance name, preferring one with the model. */
function matchingProvider(
  providers: readonly UiProvider[],
  draft: Pick<
    AutomationDraft,
    "providerKind" | "providerInstanceId" | "modelId"
  >
): UiProvider | undefined {
  const candidates = providers.filter(
    (provider) =>
      providerKindOf(provider) === draft.providerKind &&
      (provider.providerInstanceId ?? null) ===
        (draft.providerInstanceId ?? null)
  )
  return (
    candidates.find((provider) =>
      provider.models.some((model) => model.id === draft.modelId)
    ) ?? candidates[0]
  )
}

/**
 * The draft fields for a provider and model: the kind and instance a turn
 * is sent with, and the model selection the composer would build for the
 * same choice (`buildModelSelection`), reasoning level included. A level
 * the model does not offer falls back to the composer's default, or Off.
 */
function selectionPatch(
  provider: UiProvider,
  modelId: string,
  reasoning: string | null
): Partial<AutomationDraft> {
  const providerKind = providerKindOf(provider)
  const providerInstanceId = provider.providerInstanceId ?? null
  const options = getModelThinkingOptions(provider, modelId)
  const offered = (mode: string | null) =>
    options.some((option) => isThinkingModeOptionActive(mode, option.mode))
  const reasoningEffort =
    options.length <= 1
      ? null
      : offered(reasoning)
        ? reasoning
        : offered(DEFAULT_THINKING_MODE)
          ? DEFAULT_THINKING_MODE
          : offered(null)
            ? null
            : (options[0]?.mode ?? null)
  return {
    providerKind,
    providerInstanceId,
    modelId,
    reasoningEffort,
    modelSelection: buildModelSelection({
      modelId,
      providerKind,
      providerInstanceId,
      reasoningEffort,
      capabilities: getProviderModel(provider, modelId)?.capabilities ?? null,
    }),
  }
}

/**
 * Provider, model and reasoning level for an automation, from the same
 * provider list and capabilities as the composer's model picker. Provider
 * plugins run in the desktop window, not in the backend that runs
 * automations, so they are not offered.
 */
export function AutomationModelFields({
  draft,
  onChange,
  error,
}: {
  draft: AutomationDraft
  onChange: (patch: Partial<AutomationDraft>) => void
  error?: string
}) {
  const providerFieldId = useId()
  const modelFieldId = useId()
  const reasoningLabelId = useId()
  const plugins = usePluginStore((state) => state.plugins)
  const allProviders = useProvidersWithLmStudio(true, draft.projectPath || null)
  const providers = useMemo(() => {
    const pluginIds = new Set(
      plugins
        .filter(
          (plugin) => plugin.enabled && plugin.manifest.type === "provider"
        )
        .map((plugin) => plugin.manifest.id)
    )
    return allProviders.filter(
      (provider) =>
        !pluginIds.has(provider.id) &&
        provider.availability !== "unavailable" &&
        provider.status !== "disabled"
    )
  }, [allProviders, plugins])
  const provider = matchingProvider(providers, draft)
  const modelKnown = Boolean(
    provider?.models.some((model) => model.id === draft.modelId)
  )

  // A new automation starts on the first ready provider and its first model.
  useEffect(() => {
    if (draft.providerKind || draft.modelId) return
    const first = providers.find(
      (candidate) =>
        candidate.configured !== false && candidate.models.length > 0
    )
    const firstModel = first?.models[0]
    if (first && firstModel) {
      onChange(selectionPatch(first, firstModel.id, DEFAULT_THINKING_MODE))
    }
  }, [providers, draft.providerKind, draft.modelId, onChange])

  const thinkingOptions = provider
    ? getModelThinkingOptions(provider, draft.modelId)
    : []
  const modelName = provider
    ? displayModelName(
        draft.modelId,
        getProviderModel(provider, draft.modelId)?.name
      )
    : displayModelName(draft.modelId)

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid gap-x-4 gap-y-3.5 @[560px]/automation:grid-cols-2">
        <AutomationField
          label="Provider"
          htmlFor={providerFieldId}
          error={error}
        >
          <Select
            value={provider?.id ?? (draft.providerKind ? "__saved__" : "")}
            onValueChange={(id) => {
              const next = providers.find((candidate) => candidate.id === id)
              const nextModel =
                next?.models.find((model) => model.id === draft.modelId) ??
                next?.models[0]
              if (next && nextModel) {
                onChange(
                  selectionPatch(next, nextModel.id, draft.reasoningEffort)
                )
              }
            }}
          >
            <SelectTrigger
              id={providerFieldId}
              aria-invalid={error ? true : undefined}
              className={FIELD_SELECT}
            >
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent position="popper">
              {!provider && draft.providerKind ? (
                <SelectItem value="__saved__" disabled>
                  {draft.providerKind} (unavailable)
                </SelectItem>
              ) : null}
              {providers.map((candidate) => (
                <SelectItem
                  key={candidate.id}
                  value={candidate.id}
                  disabled={candidate.models.length === 0}
                >
                  <ProviderIcon provider={candidate} className="size-3.5" />
                  {candidate.name}
                  {candidate.configured === false ? " (needs setup)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </AutomationField>
        <AutomationField label="Model" htmlFor={modelFieldId}>
          <Select
            value={draft.modelId}
            disabled={!provider}
            onValueChange={(modelId) => {
              if (provider) {
                onChange(
                  selectionPatch(provider, modelId, draft.reasoningEffort)
                )
              }
            }}
          >
            <SelectTrigger id={modelFieldId} className={FIELD_SELECT}>
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent position="popper">
              {draft.modelId && !modelKnown ? (
                <SelectItem value={draft.modelId} disabled>
                  {displayModelName(draft.modelId)} (unavailable)
                </SelectItem>
              ) : null}
              {provider?.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {displayModelName(model.id, model.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </AutomationField>
      </div>
      {provider && modelKnown && thinkingOptions.length > 1 ? (
        <AutomationField
          label="Reasoning"
          labelId={reasoningLabelId}
          group
          hint="The level the run's turns use, as in the composer's reasoning picker."
        >
          <div className="w-fit rounded-xl border border-border/50 bg-background/40">
            <ThinkingEffortSlider
              options={thinkingOptions}
              thinkingMode={draft.reasoningEffort}
              modelName={modelName}
              selectionKey={`${provider.id}:${draft.modelId}`}
              defaultMode={null}
              onSelect={(mode) =>
                onChange(selectionPatch(provider, draft.modelId, mode))
              }
            />
          </div>
        </AutomationField>
      ) : null}
    </div>
  )
}
