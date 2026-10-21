import { useEffect, useId, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { MoleculesIcon } from "@hugeicons/core-free-icons"
import {
  ORCHESTRATOR_PROVIDER_LABELS,
  chatOrchestrationSchema,
  orchestrationForMain,
  orchestratorModelKey,
  orchestratorProviderSchema,
  isOrchestratorExcludedEffort,
  type ChatOrchestration,
  type OrchestratorProvider,
  type OrchestratorSelectedModel,
} from "@betterc0de/schema"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { PromptInputButton } from "@/components/ai-elements/prompt-input"
import { ProviderIcon } from "@/components/provider-icon"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ReasoningLevelIcon } from "./reasoning-level-icon"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import {
  getModelThinkingOptions,
  getThinkingModeLabel,
  type ModelThinkingOption,
} from "@/lib/model-capabilities"
import { cn } from "@/lib/utils"
import { builtinProviders } from "@/lib/builtin-providers"
import type { UiProvider } from "@/lib/provider-types"
import {
  subagentModelChoices,
  selectedSubagentModels,
  orchestrationThinkingOptions,
  orchestrationWithModels,
  type SubagentModelChoice,
} from "@/lib/orchestration-models"
import {
  ORCHESTRATION_MENU_CLASS,
  OrchestrationProviderGroup,
  OrchestrationThinkingPanel,
  focusThinkingSlider,
} from "./orchestration-model-menu"
import {
  MENU_HEADING,
  MENU_ITEM_HINT,
  MENU_NOTE,
  MENU_SEPARATOR,
} from "@/components/ui/menu-chrome"
import { useChatStore } from "@/lib/chat-store"
import { useSettingsStore } from "@/lib/settings-store"
import {
  ORCHESTRATION_OFF,
  savedOrchestration,
  useOrchestrationDraft,
} from "@/lib/orchestration-composer-store"
import {
  getOrchestratorStatus,
  stopOrchestrator,
} from "@/services/backend/orchestratorApi"
import type { ComposerFooterProps } from "./chat-composer-types"

type Props = Pick<
  ComposerFooterProps,
  | "threadId"
  | "providers"
  | "currentProvider"
  | "currentModelName"
  | "isStreaming"
>
const PROVIDERS = orchestratorProviderSchema.options.map((kind) => ({
  kind,
  label: ORCHESTRATOR_PROVIDER_LABELS[kind],
}))

function useSelection(
  threadId: Props["threadId"],
  mainProvider: Props["currentProvider"]
) {
  const saved = useChatStore((state) =>
    threadId ? state.settingsByThread[threadId]?.orchestration : undefined
  )
  const draft = useOrchestrationDraft((state) => state.selection)
  const experiment = useSettingsStore((state) => state.orchestratorEnabled)
  const selection = threadId ? savedOrchestration(saved) : draft
  return experiment
    ? orchestrationForMain(selection, mainProvider?.providerKind)
    : ORCHESTRATION_OFF
}

/** One write path for the panel and the composer model summary. */
function useOrchestrationEditor(
  threadId: Props["threadId"],
  isStreaming: Props["isStreaming"]
) {
  const worker = useChatStore((state) =>
    Boolean(threadId && state.settingsByThread[threadId]?.orchestrationWorker)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutation = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const locked = busy || isStreaming || worker
  async function change(next: ChatOrchestration) {
    if (mutation.current || locked) return
    mutation.current = true
    setBusy(true)
    setError(null)
    try {
      if (next.enabled && next.models && next.models.length > 128)
        throw new Error("Select at most 128 subagent models.")
      next = chatOrchestrationSchema.parse(next)
      if (next.enabled && !useSettingsStore.getState().orchestratorEnabled)
        await useSettingsStore.getState().update({ orchestrator_enabled: true })
      if (!next.enabled && threadId) {
        const session = await getOrchestratorStatus(threadId)
        if (session?.status === "ready") await stopOrchestrator(threadId)
      }
      if (threadId)
        useChatStore
          .getState()
          .setThreadSetting(threadId, "orchestration", next)
      else useOrchestrationDraft.getState().set(next)
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not update orchestration."
        )
    } finally {
      mutation.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { worker, busy, error, locked, change }
}

/** Provider groups; those with selected models start expanded on each open. */
function DelegateGroups({
  workers,
  choices,
  selectedModels,
  providers,
  disabled,
  onChange,
}: {
  workers: ReadonlyArray<{ kind: OrchestratorProvider }>
  choices: readonly SubagentModelChoice[]
  selectedModels: readonly OrchestratorSelectedModel[]
  providers: Props["providers"]
  disabled: boolean
  onChange: (
    kind: OrchestratorProvider,
    models: OrchestratorSelectedModel[]
  ) => void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<OrchestratorProvider>>(
    () => new Set(selectedModels.map((model) => model.providerKind))
  )
  return (
    <>
      {workers.map(({ kind }, index) => (
        <OrchestrationProviderGroup
          key={kind}
          kind={kind}
          choices={choices.filter(
            (choice) => choice.value.providerKind === kind
          )}
          selected={selectedModels.filter(
            (model) => model.providerKind === kind
          )}
          disabled={disabled}
          loading={providers.some(
            (provider) =>
              provider.providerKind === kind && provider.modelsReady === false
          )}
          last={index === workers.length - 1}
          expanded={expanded.has(kind)}
          onExpandedChange={(open) =>
            setExpanded((current) => {
              const next = new Set(current)
              if (open) next.add(kind)
              else next.delete(kind)
              return next
            })
          }
          onChange={(models) => onChange(kind, models)}
        />
      ))}
    </>
  )
}

export function ComposerOrchestrationMenu({
  threadId,
  providers,
  currentProvider,
  currentModelName,
  isStreaming,
}: Props) {
  const titleId = useId()
  const descriptionId = useId()
  const selection = useSelection(threadId, currentProvider)
  const { worker, busy, error, locked, change } = useOrchestrationEditor(
    threadId,
    isStreaming
  )
  const mainKind = currentProvider?.providerKind
  const supported =
    mainKind === "claude" || mainKind === "codex" || mainKind === "grok_cli"
  const workers = PROVIDERS.filter(({ kind }) => kind !== mainKind)
  const choices = subagentModelChoices(providers, mainKind)
  const selectedModels = selectedSubagentModels(selection, choices)
  const available = workers.filter(({ kind }) =>
    choices.some((choice) => choice.value.providerKind === kind)
  )
  const firstAvailable = available[0]
  // A state that needs attention replaces the selection count in the footer.
  const status = busy
    ? "Saving selection…"
    : worker
      ? "Workers cannot delegate further."
      : !supported
        ? "Choose Claude, Codex or Grok CLI as the main model."
        : isStreaming
          ? "You can edit the selection after this turn finishes."
          : !available.length
            ? "Connect another provider in Settings to get started."
            : null
  const lead =
    currentModelName || currentProvider?.name || "Choose a main model"
  const headline = selection.enabled
    ? `${currentModelName || "The main agent"} leads ${selectedModels.length} ${selectedModels.length === 1 ? "delegate" : "delegates"}`
    : "Let the main agent delegate to other models."
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          size="icon-xs"
          tooltip={`Orchestration · ${selection.enabled ? "On" : "Off"}`}
          aria-label={`Orchestration: ${selection.enabled ? "On" : "Off"}`}
          className={cn(
            "shrink-0 rounded-md text-muted-foreground motion-reduce:transition-none",
            selection.enabled && "text-foreground"
          )}
        >
          <OrchestrationIcon className="size-4" />
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        className={cn(
          ORCHESTRATION_MENU_CLASS,
          "max-h-[min(520px,var(--radix-dropdown-menu-content-available-height))] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain motion-reduce:animate-none"
        )}
      >
        <div className="flex items-center gap-2 py-0.5 pr-0.5 pl-2">
          <OrchestrationIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 id={titleId} className="text-[12px] leading-5 font-medium">
            Orchestration
          </h2>
          <span className="rounded-[4px] border border-border px-1 text-[9px] leading-3.5 font-medium tracking-wider text-muted-foreground uppercase">
            Experimental
          </span>
          {/* A menu item keeps keyboard order inside the menu; the track is
              drawn like the shared Switch, which cannot nest in a menuitem. */}
          <DropdownMenuCheckboxItem
            aria-label="Enable orchestration"
            checked={selection.enabled}
            disabled={
              locked || (!selection.enabled && (!supported || !firstAvailable))
            }
            className="ml-auto shrink-0 rounded-[var(--radius)] p-1.5 [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(enabled) => {
              if (!enabled) void change({ enabled: false })
              else if (firstAvailable)
                void change(
                  orchestrationWithModels(
                    choices
                      .filter(
                        (choice) =>
                          choice.value.providerKind === firstAvailable.kind
                      )
                      .map((choice) => choice.value)
                  )
                )
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-4 w-7 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none",
                selection.enabled ? "bg-primary" : "bg-input/90"
              )}
            >
              <span
                className={cn(
                  "size-3 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none",
                  selection.enabled
                    ? "translate-x-3 dark:bg-primary-foreground"
                    : "dark:bg-foreground"
                )}
              />
            </span>
          </DropdownMenuCheckboxItem>
        </div>
        <p id={descriptionId} className={cn(MENU_ITEM_HINT, "mt-0 px-2")}>
          {headline}
        </p>
        <div className={MENU_SEPARATOR} />
        {/* The team as a tree: the main agent is the root, providers branch
            from its line and models from theirs (see the model menu). */}
        <div className="relative flex h-9 items-center gap-2 px-2">
          {workers.length > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-[26px] bottom-0 left-[15.5px] w-px bg-muted-foreground/30"
            />
          )}
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            {currentProvider ? (
              <ProviderIcon provider={currentProvider} className="size-4" />
            ) : (
              <OrchestrationIcon className="size-4 text-muted-foreground" />
            )}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-medium"
            title={currentModelName}
          >
            {lead}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            Main agent
          </span>
        </div>
        <DelegateGroups
          workers={workers}
          choices={choices}
          selectedModels={selectedModels}
          providers={providers}
          disabled={locked || !supported}
          onChange={(kind, models) =>
            void change(
              orchestrationWithModels([
                ...selectedModels.filter(
                  (model) => model.providerKind !== kind
                ),
                ...models,
              ])
            )
          }
        />
        <p role="status" className={MENU_NOTE}>
          {status ??
            (selection.enabled
              ? `${selectedModels.length} ${selectedModels.length === 1 ? "model" : "models"} selected for delegation.`
              : "Select models to enable delegation.")}
        </p>
        {error && (
          <p
            role="alert"
            className="px-2 pt-1 pb-0.5 text-[11px] leading-4 text-destructive"
          >
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type SummaryModel = {
  key: string
  selected: OrchestratorSelectedModel
  /** Absent when the account or model is not currently available. */
  choice: SubagentModelChoice | undefined
  name: string
  accountName: string
  provider: UiProvider | undefined
  effort: string
  effortLabel: string
  options: ReadonlyArray<ModelThinkingOption>
}

function describeModel(
  selected: OrchestratorSelectedModel,
  providers: readonly UiProvider[],
  choices: readonly SubagentModelChoice[]
): SummaryModel {
  const key = orchestratorModelKey(selected)
  const choice = choices.find(
    (candidate) => orchestratorModelKey(candidate.value) === key
  )
  // Resolve against the selected account, including cached catalogs while
  // discovery runs. Never borrow another account's model name.
  const account = providers.find(
    (candidate) =>
      candidate.providerKind === selected.providerKind &&
      candidate.providerInstanceId === selected.providerInstanceId
  )
  const provider = account?.logo
    ? account
    : builtinProviders.find(
        (candidate) => candidate.providerKind === selected.providerKind
      )
  const effort = selected.reasoningEffort ?? "auto"
  const options = choice
    ? orchestrationThinkingOptions(choice)
    : [
        { mode: "auto", label: "Auto" },
        ...getModelThinkingOptions(
          account ?? provider,
          selected.modelId
        ).filter(
          (option) =>
            option.mode !== null &&
            option.mode !== "auto" &&
            !isOrchestratorExcludedEffort(option.mode)
        ),
      ]
  return {
    key,
    selected,
    choice,
    name:
      choice?.name ??
      account?.models.find((model) => model.id === selected.modelId)?.name ??
      selected.modelId,
    accountName: account?.name ?? selected.providerInstanceId,
    provider,
    effort,
    effortLabel:
      effort === "auto"
        ? "Auto"
        : (options.find((option) => option.mode === effort)?.label ??
          getThinkingModeLabel(account ?? provider, selected.modelId, effort) ??
          effort),
    options,
  }
}

/** Entries shown before the rest of the row collapses into a count. */
const SUMMARY_LIMIT = 5
/** Borderless entries that show a surface only while hovered, focused or open. */
const SUMMARY_ENTRY_CLASS =
  "flex h-8 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-[state=open]:bg-accent motion-reduce:transition-none"
const SUMMARY_TOOLTIP_CLASS =
  "flex-col items-start gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md motion-reduce:animate-none [&>span>svg]:bg-popover [&>span>svg]:fill-popover"

function ProviderLogo({ provider }: { provider: UiProvider | undefined }) {
  if (!provider) return null
  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 shrink-0 items-center justify-center"
    >
      <ProviderIcon provider={provider} className="size-3.5" />
    </span>
  )
}

function ThinkingLevel({ model }: { model: SummaryModel }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
        reasoningColorClass(model.effort)
      )}
    >
      <ReasoningLevelIcon
        options={model.options}
        mode={model.effort}
        className="size-4"
      />
      <span>{model.effortLabel}</span>
    </span>
  )
}

type SummaryEditing = {
  locked: boolean
  lockedReason: string
  error: string | null
  onEffort: (model: SummaryModel, effort: string | null) => void
}

function SummaryThinkingContent({
  model,
  editing,
}: {
  model: SummaryModel
  editing: SummaryEditing
}) {
  return (
    <>
      {model.choice && !editing.locked ? (
        <OrchestrationThinkingPanel
          options={model.options}
          effort={model.effort}
          modelName={model.name}
          selectionKey={model.key}
          onChange={(effort) => editing.onEffort(model, effort)}
        />
      ) : (
        <p className="max-w-56 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
          {model.choice
            ? editing.lockedReason
            : "This model is unavailable. Edit the selection under Orchestration."}
        </p>
      )}
      {editing.error && (
        <p
          role="alert"
          className="max-w-56 px-3 pb-2.5 text-[11px] text-destructive"
        >
          {editing.error}
        </p>
      )}
    </>
  )
}

/** Hover or focus shows the thinking level; a click opens its slider. */
function SummaryEntry({
  model,
  editing,
}: {
  model: SummaryModel
  editing: SummaryEditing
}) {
  const [hinted, setHinted] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip
        delayDuration={150}
        open={hinted && !open}
        onOpenChange={setHinted}
      >
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${model.name}, ${model.accountName}`}
              className={SUMMARY_ENTRY_CLASS}
            >
              {model.provider && (
                <span
                  aria-hidden="true"
                  className="flex size-4 items-center justify-center"
                >
                  <ProviderIcon provider={model.provider} className="size-4" />
                </span>
              )}
              <span aria-hidden="true" className="flex">
                <ReasoningLevelIcon
                  options={model.options}
                  mode={model.effort}
                  className="size-4"
                />
              </span>
            </button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className={SUMMARY_TOOLTIP_CLASS}
        >
          <span className="max-w-64 text-[11px] font-medium break-words">
            {model.name}
          </span>
          <span className="flex w-full items-center justify-between gap-4">
            <span className="text-[10px] text-muted-foreground">Thinking</span>
            <ThinkingLevel model={model} />
          </span>
          {model.effort === "auto" && (
            <span className="text-[10px] text-muted-foreground">
              Provider default
            </span>
          )}
          {model.choice && !editing.locked && (
            <span className="text-[10px] text-muted-foreground">
              Click to adjust
            </span>
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label={`${model.name} thinking`}
        className={cn(
          ORCHESTRATION_MENU_CLASS,
          "w-auto p-0 motion-reduce:animate-none"
        )}
        onFocus={focusThinkingSlider}
      >
        <SummaryThinkingContent model={model} editing={editing} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The collapsed rest of the row: a count that lists and edits them. */
function SummaryOverflow({
  models,
  editing,
}: {
  models: SummaryModel[]
  editing: SummaryEditing
}) {
  const [hinted, setHinted] = useState(false)
  const [open, setOpen] = useState(false)
  const label = `${models.length} more ${models.length === 1 ? "model" : "models"}`
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip
        delayDuration={150}
        open={hinted && !open}
        onOpenChange={setHinted}
      >
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              className={SUMMARY_ENTRY_CLASS}
            >
              <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">
                +{models.length}
              </span>
            </button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className={cn(SUMMARY_TOOLTIP_CLASS, "w-64 items-stretch")}
        >
          <span className="text-[10px] text-muted-foreground">{label}</span>
          {models.map((model) => (
            <span key={model.key} className="flex items-center gap-2">
              <ProviderLogo provider={model.provider} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                {model.name}
              </span>
              <ThinkingLevel model={model} />
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          ORCHESTRATION_MENU_CLASS,
          "max-h-[min(340px,var(--radix-dropdown-menu-content-available-height))] w-[260px] max-w-[calc(100vw-24px)] overflow-y-auto motion-reduce:animate-none"
        )}
      >
        <DropdownMenuLabel className={MENU_HEADING}>{label}</DropdownMenuLabel>
        {models.map((model) => (
          <DropdownMenuSub key={model.key}>
            <DropdownMenuSubTrigger
              aria-label={`${model.name} thinking`}
              className="h-8 gap-2 rounded-[var(--radius)] px-2 text-[12px] font-normal"
            >
              <ProviderLogo provider={model.provider} />
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              <ThinkingLevel model={model} />
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionPadding={12}
                aria-label={`${model.name} thinking`}
                className={cn(
                  ORCHESTRATION_MENU_CLASS,
                  "w-auto p-0 motion-reduce:animate-none"
                )}
                onFocus={focusThinkingSlider}
              >
                <SummaryThinkingContent model={model} editing={editing} />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Orchestration summary above the composer footer: a heading with the model
 * count over a row of the selected models, each a logo and its thinking level.
 */
export function ComposerOrchestrationBadge({
  threadId,
  currentProvider,
  providers,
  isStreaming,
}: Pick<Props, "threadId" | "currentProvider" | "providers" | "isStreaming">) {
  const selection = useSelection(threadId, currentProvider)
  const { worker, error, change } = useOrchestrationEditor(
    threadId,
    isStreaming
  )
  if (!selection.enabled) return null
  const choices = subagentModelChoices(providers, currentProvider?.providerKind)
  const selectedModels = selectedSubagentModels(selection, choices)
  const models = selectedModels.map((selected) =>
    describeModel(selected, providers, choices)
  )
  const loading = selection.providers.some((kind) =>
    providers.some(
      (provider) =>
        provider.providerKind === kind && provider.modelsReady === false
    )
  )
  // Saving never swaps the open slider for a note; overlapping writes are
  // dropped by the editor instead.
  const editing: SummaryEditing = {
    locked: worker || isStreaming,
    lockedReason: worker
      ? "Workers cannot change delegation."
      : "You can adjust thinking after this turn finishes.",
    error,
    onEffort: (model, reasoningEffort) =>
      void change(
        orchestrationWithModels(
          selectedModels.map((selected) =>
            orchestratorModelKey(selected) === model.key
              ? { ...selected, reasoningEffort }
              : selected
          )
        )
      ),
  }
  const collapsed = models.length > SUMMARY_LIMIT
  const visible = collapsed ? models.slice(0, SUMMARY_LIMIT - 1) : models
  const hidden = collapsed ? models.slice(SUMMARY_LIMIT - 1) : []
  return (
    <div
      role="group"
      aria-label="Orchestration enabled"
      className="flex w-full flex-col items-center gap-1.5 px-3 pb-2"
    >
      <div className="flex items-center justify-center gap-1.5 text-xs leading-4">
        <OrchestrationIcon className="size-4 text-primary" />
        <span className="font-medium text-foreground">Orchestration</span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          ·
        </span>
        <span className="text-muted-foreground tabular-nums">
          {models.length
            ? `${models.length} ${models.length === 1 ? "model" : "models"}`
            : loading
              ? "Loading selected models…"
              : "No models available"}
        </span>
      </div>
      {models.length > 0 && (
        <div
          role="list"
          aria-label="Selected agent models"
          className="flex flex-wrap items-center justify-center gap-1"
        >
          {visible.map((model) => (
            <div role="listitem" key={model.key} className="flex">
              <SummaryEntry model={model} editing={editing} />
            </div>
          ))}
          {hidden.length > 0 && (
            <div role="listitem" className="flex">
              <SummaryOverflow models={hidden} editing={editing} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Orchestration's own mark: a lead node linked to the models it delegates to. */
function OrchestrationIcon({ className }: { className?: string }) {
  return (
    <HugeiconsIcon
      icon={MoleculesIcon}
      strokeWidth={2}
      aria-hidden="true"
      className={className}
    />
  )
}
