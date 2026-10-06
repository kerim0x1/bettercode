import {
  ORCHESTRATOR_PROVIDER_LABELS,
  orchestratorModelKey,
  type OrchestratorSelectedModel,
  type OrchestratorProvider,
} from "@betterc0de/schema"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/provider-icon"
import { ThinkingEffortSlider } from "./thinking-effort-slider"
import { ReasoningLevelIcon } from "./reasoning-level-icon"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import { cn } from "@/lib/utils"
import { builtinProviders } from "@/lib/builtin-providers"
import type { SubagentModelChoice } from "@/lib/orchestration-models"

interface Props {
  kind: OrchestratorProvider
  choices: readonly SubagentModelChoice[]
  selected: readonly OrchestratorSelectedModel[]
  disabled: boolean
  loading: boolean
  onChange: (models: OrchestratorSelectedModel[]) => void
}

function ModelThinkingPicker({
  choice,
  selected,
  disabled,
  accountLabel,
  onChange,
}: {
  choice: SubagentModelChoice
  selected: OrchestratorSelectedModel
  disabled: boolean
  accountLabel: string
  onChange: (mode: string | null) => void
}) {
  // Auto is a UI-only stop. The orchestration contract stores the provider
  // default as null, and every explicit effort keeps its advertised ID.
  const options = [
    { mode: "auto", label: "Auto" },
    ...choice.reasoningOptions
      .filter((option) => option.id !== "auto")
      .map((option) => ({ mode: option.id, label: option.label })),
  ]
  const effort = selected.reasoningEffort ?? "auto"
  const active = options.find((option) => option.mode === effort)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={disabled}
        aria-label={`${choice.name} thinking${accountLabel}`}
        className={cn(
          "mr-1 h-7 max-w-[104px] gap-1 rounded-md px-1.5 text-[10px] motion-reduce:transition-none",
          reasoningColorClass(effort)
        )}
      >
        <ReasoningLevelIcon
          options={options}
          mode={effort}
          className="size-3.5"
        />
        <span className="truncate">{active?.label ?? effort}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          sideOffset={6}
          collisionPadding={12}
          aria-label={`${choice.name} thinking${accountLabel}`}
          className="w-auto gap-0 rounded-xl p-0 motion-reduce:animate-none"
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              event.currentTarget
                .querySelector<HTMLElement>('[role="slider"]')
                ?.focus()
          }}
        >
          <div
            onKeyDown={(event) => {
              if (event.key === "Tab") event.stopPropagation()
            }}
          >
            {!active && (
              <div className="px-2.5 pt-2 text-[11px] text-muted-foreground">
                <p>Saved effort “{effort}” is unavailable.</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onChange(null)}
                >
                  Use Auto
                </Button>
              </div>
            )}
            <ThinkingEffortSlider
              options={options}
              thinkingMode={effort}
              defaultMode="auto"
              modelName={choice.name}
              selectionKey={orchestratorModelKey(choice.value)}
              onSelect={(mode) => onChange(mode === "auto" ? null : mode)}
            />
          </div>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

export function OrchestrationModelMenu({
  kind,
  choices,
  selected,
  disabled,
  loading,
  onChange,
}: Props) {
  const label = ORCHESTRATOR_PROVIDER_LABELS[kind]
  const provider = builtinProviders.find(
    (candidate) => candidate.providerKind === kind
  )
  const selectedByKey = new Map(
    selected.map((model) => [orchestratorModelKey(model), model])
  )
  const availableModels = new Map(
    choices.map((choice) => [orchestratorModelKey(choice.value), choice.name])
  )
  const missing = loading
    ? []
    : selected.filter(
        (model) => !availableModels.has(orchestratorModelKey(model))
      )
  const summary = loading
    ? "Loading models…"
    : selected.length
      ? selected
          .map(
            (model) =>
              availableModels.get(orchestratorModelKey(model)) ?? model.modelId
          )
          .join(", ")
      : choices.length
        ? `${choices.length} ${choices.length === 1 ? "model" : "models"} available`
        : "No models available"
  const allSelected =
    choices.length > 0 &&
    choices.every((choice) =>
      selectedByKey.has(orchestratorModelKey(choice.value))
    )
  const multipleAccounts =
    new Set([
      ...choices.map((choice) => choice.value.providerInstanceId),
      ...selected.map((model) => model.providerInstanceId),
    ]).size > 1
  function toggle(model: OrchestratorSelectedModel) {
    const key = orchestratorModelKey(model)
    onChange(
      selectedByKey.has(key)
        ? selected.filter((item) => orchestratorModelKey(item) !== key)
        : [...selected, model]
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label={`${label} subagent models`}
        className="relative h-10 w-full justify-start gap-2 rounded-md px-2 text-left before:pointer-events-none before:absolute before:top-5 before:-left-2 before:h-px before:w-2 before:bg-border/80 motion-reduce:transition-none"
      >
        {provider && (
          <span aria-hidden="true">
            <ProviderIcon provider={provider} className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{label}</span>
          <span
            title={summary}
            className="block truncate text-[10px] font-normal text-muted-foreground"
          >
            {summary}
          </span>
        </span>
        {selected.length > 0 && (
          <span className="text-[10px] text-primary tabular-nums">
            {selected.length}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          sideOffset={6}
          collisionPadding={12}
          className="max-h-[min(340px,var(--radix-dropdown-menu-content-available-height))] w-[290px] max-w-[calc(100vw-24px)] overflow-y-auto"
        >
          <DropdownMenuLabel>{label} models</DropdownMenuLabel>
          {choices.length > 0 && (
            <>
              <DropdownMenuItem
                disabled={disabled || loading}
                onSelect={(event) => {
                  event.preventDefault()
                  onChange(
                    allSelected
                      ? []
                      : choices.map(
                          (choice) =>
                            selectedByKey.get(
                              orchestratorModelKey(choice.value)
                            ) ?? choice.value
                        )
                  )
                }}
                className="text-xs"
              >
                {allSelected ? "Clear selection" : "Select all"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {choices.map((choice) => {
            const key = orchestratorModelKey(choice.value)
            const selectedModel = selectedByKey.get(key)
            const accountLabel = multipleAccounts
              ? ` (${choice.provider.name})`
              : ""
            return (
              <div key={key} className="flex items-center gap-0.5">
                <DropdownMenuCheckboxItem
                  aria-label={`${choice.name}${accountLabel}`}
                  checked={Boolean(selectedModel)}
                  disabled={disabled || loading}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggle(choice.value)}
                  className="min-w-0 flex-1 text-xs"
                >
                  <span aria-hidden="true">
                    <ProviderIcon
                      provider={choice.provider}
                      className="size-3.5"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={choice.name}>
                      {choice.name}
                    </span>
                    {multipleAccounts && (
                      <span className="block truncate text-[10px] font-normal text-muted-foreground">
                        {choice.provider.name}
                      </span>
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
                {selectedModel && (
                  <ModelThinkingPicker
                    choice={choice}
                    selected={selectedModel}
                    accountLabel={accountLabel}
                    disabled={disabled || loading}
                    onChange={(reasoningEffort) =>
                      onChange(
                        selected.map((model) =>
                          orchestratorModelKey(model) === key
                            ? { ...model, reasoningEffort }
                            : model
                        )
                      )
                    }
                  />
                )}
              </div>
            )
          })}
          {missing.map((model) => (
            <DropdownMenuCheckboxItem
              key={orchestratorModelKey(model)}
              aria-label={`Remove ${model.modelId}${multipleAccounts ? ` (${model.providerInstanceId})` : ""}`}
              checked
              disabled={disabled}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => toggle(model)}
              className="text-xs"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{model.modelId}</span>
                {multipleAccounts && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {model.providerInstanceId}
                  </span>
                )}
                <span className="block text-[10px] text-muted-foreground">
                  Unavailable · remove selection
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          {(loading || !choices.length) && (
            <p className="px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {loading
                ? "Loading supported models…"
                : `No supported models available. Connect ${label} in Settings.`}
            </p>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
