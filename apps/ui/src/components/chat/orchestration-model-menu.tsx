import type { FocusEvent, ReactNode } from "react"
import {
  ORCHESTRATOR_PROVIDER_LABELS,
  orchestratorModelKey,
  type OrchestratorSelectedModel,
  type OrchestratorProvider,
} from "@betterc0de/schema"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { MENU_PANEL } from "@/components/ui/menu-chrome"
import { ProviderIcon } from "@/components/provider-icon"
import { ThinkingEffortSlider } from "./thinking-effort-slider"
import { ReasoningLevelIcon } from "./reasoning-level-icon"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import { cn } from "@/lib/utils"
import { builtinProviders } from "@/lib/builtin-providers"
import {
  orchestrationThinkingOptions,
  type SubagentModelChoice,
} from "@/lib/orchestration-models"
import type { ModelThinkingOption } from "@/lib/model-capabilities"

interface Props {
  kind: OrchestratorProvider
  choices: readonly SubagentModelChoice[]
  selected: readonly OrchestratorSelectedModel[]
  disabled: boolean
  loading: boolean
  /** The last branch ends the main agent's line at its elbow. */
  last: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onChange: (models: OrchestratorSelectedModel[]) => void
}

/** Move focus from a freshly opened menu surface to its slider. */
export function focusThinkingSlider(event: FocusEvent<HTMLElement>) {
  if (event.target === event.currentTarget)
    event.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus()
}

/** The thinking slider shared by the panel and the composer model summary. */
export function OrchestrationThinkingPanel({
  options,
  effort,
  modelName,
  selectionKey,
  onChange,
}: {
  options: ReadonlyArray<ModelThinkingOption>
  effort: string
  modelName: string
  selectionKey: string
  onChange: (mode: string | null) => void
}) {
  const active = options.find((option) => option.mode === effort)
  return (
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
        modelName={modelName}
        selectionKey={selectionKey}
        onSelect={(mode) => onChange(mode === "auto" ? null : mode)}
      />
    </div>
  )
}

/**
 * The model picker's chrome on Radix menus: the shared dark panel and accent
 * rows instead of the translucent default and its light-grey highlight.
 */
export const ORCHESTRATION_MENU_CLASS = cn(
  MENU_PANEL,
  "**:data-[slot$=-item]:focus:bg-accent/50 **:data-[slot$=-item]:data-highlighted:bg-accent/50 **:data-[slot$=-trigger]:focus:bg-accent/50 **:data-[slot$=-trigger]:aria-expanded:bg-accent/50!"
)

/*
 * Tree geometry, in px from the tree's left edge. Each level indents 20px:
 * the main agent's logo is centred at 16, providers at 36, models at 56.
 * Connector lines run through those centres; rows start just after them so
 * hover surfaces never cover a line.
 */
const LINE = "bg-muted-foreground/30"
const LIVE_LINE = "bg-primary/70"

/** Thinking chip beside a selected model; its flyout holds the slider. */
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
  const options = orchestrationThinkingOptions(choice)
  const effort = selected.reasoningEffort ?? "auto"
  const active = options.find((option) => option.mode === effort)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={disabled}
        aria-label={`${choice.name} thinking${accountLabel}`}
        // The shared trigger appends a chevron; the chip reads as a value.
        className={cn(
          "h-6 max-w-[104px] shrink-0 gap-1 rounded-[var(--radius)] px-1.5 text-[11px] font-medium motion-reduce:transition-none [&>svg:last-child]:hidden",
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
          className={cn(
            ORCHESTRATION_MENU_CLASS,
            "w-auto p-0 motion-reduce:animate-none"
          )}
          onFocus={focusThinkingSlider}
        >
          <OrchestrationThinkingPanel
            options={options}
            effort={effort}
            modelName={choice.name}
            selectionKey={orchestratorModelKey(choice.value)}
            onChange={onChange}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/** A checkbox drawn on the model column; it follows the row's checked state. */
function ModelCheck() {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <span className="flex size-3.5 items-center justify-center rounded-[4px] border border-muted-foreground/50 transition-colors group-data-[state=checked]/model:border-primary group-data-[state=checked]/model:bg-primary motion-reduce:transition-none">
        <CheckIcon
          strokeWidth={3}
          className="size-2.5 text-primary-foreground! opacity-0 group-data-[state=checked]/model:opacity-100"
        />
      </span>
    </span>
  )
}

/** One model-level row with its branch from the provider's line. */
function TreeLeaf({
  last,
  live = false,
  children,
}: {
  last: boolean
  live?: boolean
  children: ReactNode
}) {
  return (
    <div className="relative flex min-h-8 items-center gap-1 pr-0.5">
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0 left-[35.5px] w-px",
          LINE,
          last ? "h-4" : "bottom-0"
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[15.5px] left-[36px] h-px w-1.5",
          live ? LIVE_LINE : LINE
        )}
      />
      {children}
    </div>
  )
}

const MODEL_ROW_CLASS =
  "group/model ml-[42px] min-h-7 min-w-0 flex-1 gap-2 rounded-[var(--radius)] px-1.5 py-1 text-[12px] font-normal [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"

/**
 * One provider branch of the orchestration tree. It expands in place, so
 * every selected model and its thinking level stay in view.
 */
export function OrchestrationProviderGroup({
  kind,
  choices,
  selected,
  disabled,
  loading,
  last,
  expanded,
  onExpandedChange,
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
  const showNote = loading || !choices.length
  const leaves =
    (choices.length ? 1 : 0) +
    choices.length +
    missing.length +
    (showNote ? 1 : 0)
  let leaf = 0
  const isLast = () => ++leaf === leaves
  return (
    <div className="relative">
      {/* The main agent's line; the last branch stops at its elbow. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0 left-[15.5px] w-px",
          LINE,
          last ? "h-[18px]" : "bottom-0"
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[17.5px] left-[16px] h-px w-1.5",
          selected.length ? LIVE_LINE : LINE
        )}
      />
      {expanded && leaves > 0 && (
        <span
          aria-hidden="true"
          className={cn("absolute top-[26px] left-[35.5px] h-2.5 w-px", LINE)}
        />
      )}
      {/* Inspection stays available while editing is locked. */}
      <DropdownMenuItem
        aria-label={`${label} subagent models`}
        aria-expanded={expanded}
        onSelect={(event) => {
          event.preventDefault()
          onExpandedChange(!expanded)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault()
            onExpandedChange(event.key === "ArrowRight")
          }
        }}
        className="ml-[22px] h-9 gap-2 rounded-[var(--radius)] px-1.5 text-left"
      >
        {provider && (
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <ProviderIcon provider={provider} className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-4 font-medium">
            {label}
          </span>
          <span
            title={summary}
            className="block truncate text-[10px] leading-3.5 font-normal text-muted-foreground"
          >
            {summary}
          </span>
        </span>
        <span
          className={cn(
            "text-[11px] font-normal tabular-nums",
            selected.length ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {loading
            ? selected.length || ""
            : `${selected.length}/${choices.length + missing.length}`}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 text-muted-foreground transition-transform duration-100 motion-reduce:transition-none",
            expanded && "rotate-90"
          )}
        />
      </DropdownMenuItem>
      {expanded && (
        <div role="group" aria-label={`${label} models`}>
          {choices.length > 0 && (
            <TreeLeaf last={isLast()}>
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
                className="ml-[42px] min-h-7 flex-1 rounded-[var(--radius)] px-1.5 py-1 text-[11px] font-normal text-muted-foreground"
              >
                {allSelected
                  ? "Clear selection"
                  : `Select all ${choices.length}`}
              </DropdownMenuItem>
            </TreeLeaf>
          )}
          {choices.map((choice) => {
            const key = orchestratorModelKey(choice.value)
            const selectedModel = selectedByKey.get(key)
            const accountLabel = multipleAccounts
              ? ` (${choice.provider.name})`
              : ""
            return (
              <TreeLeaf key={key} last={isLast()} live={Boolean(selectedModel)}>
                <DropdownMenuCheckboxItem
                  aria-label={`${choice.name}${accountLabel}`}
                  checked={Boolean(selectedModel)}
                  disabled={disabled || loading}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggle(choice.value)}
                  className={MODEL_ROW_CLASS}
                >
                  <ModelCheck />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={choice.name}>
                      {choice.name}
                    </span>
                    {multipleAccounts && (
                      <span className="block truncate text-[10px] text-muted-foreground">
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
              </TreeLeaf>
            )
          })}
          {missing.map((model) => (
            <TreeLeaf key={orchestratorModelKey(model)} last={isLast()} live>
              <DropdownMenuCheckboxItem
                aria-label={`Remove ${model.modelId}${multipleAccounts ? ` (${model.providerInstanceId})` : ""}`}
                checked
                disabled={disabled}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggle(model)}
                className={MODEL_ROW_CLASS}
              >
                <ModelCheck />
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
            </TreeLeaf>
          ))}
          {showNote && (
            <TreeLeaf last={isLast()}>
              <p className="ml-12 py-1.5 pr-2 text-[11px] leading-4 text-muted-foreground">
                {loading
                  ? "Loading supported models…"
                  : `No supported models available. Connect ${label} in Settings.`}
              </p>
            </TreeLeaf>
          )}
        </div>
      )}
    </div>
  )
}
