import { useEffect, useId, useRef, useState } from "react"
import { CheckIcon, WaypointsIcon } from "lucide-react"
import {
  ORCHESTRATOR_PROVIDER_LABELS,
  chatOrchestrationSchema,
  orchestrationForMain,
  orchestratorModelKey,
  orchestratorProviderSchema,
  type ChatOrchestration,
} from "@betterc0de/schema"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import { PromptInputButton } from "@/components/ai-elements/prompt-input"
import { ProviderIcon } from "@/components/provider-icon"
import { Badge } from "@/components/ui/badge"
import { AvatarGroup } from "@/components/ui/avatar"
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
} from "@/lib/model-capabilities"
import { cn } from "@/lib/utils"
import { builtinProviders } from "@/lib/builtin-providers"
import {
  subagentModelChoices,
  selectedSubagentModels,
  orchestrationWithModels,
} from "@/lib/orchestration-models"
import { OrchestrationModelMenu } from "./orchestration-model-menu"
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
  const mainKind = currentProvider?.providerKind
  const supported =
    mainKind === "claude" || mainKind === "codex" || mainKind === "grok_cli"
  const workers = PROVIDERS.filter(({ kind }) => kind !== mainKind)
  const choices = subagentModelChoices(providers, mainKind)
  const selectedModels = selectedSubagentModels(selection, choices)
  const available = workers.filter(({ kind }) =>
    choices.some((choice) => choice.value.providerKind === kind)
  )
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
  const firstAvailable = available[0]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          size="icon-xs"
          tooltip={`Orchestration · ${selection.enabled ? "On" : "Off"}`}
          aria-label={`Orchestration: ${selection.enabled ? "On" : "Off"}`}
          className={cn(
            "relative shrink-0 rounded-md text-muted-foreground motion-reduce:transition-none",
            selection.enabled && "bg-primary/10 text-primary"
          )}
        >
          <WaypointsIcon
            aria-hidden="true"
            className="size-4.5"
            strokeWidth={1.75}
          />
          {selection.enabled && (
            <span
              aria-hidden="true"
              className="absolute right-0.5 bottom-0.5 size-1 rounded-full bg-primary ring-2 ring-background"
            />
          )}
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
        className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl p-0 motion-reduce:animate-none"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <WaypointsIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground"
                strokeWidth={1.75}
              />
              <h2 id={titleId} className="text-[13px] leading-5 font-semibold">
                Orchestration
              </h2>
            </div>
            <span className="ml-6 text-[10px] leading-4 text-muted-foreground">
              Experimental
            </span>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenuCheckboxItem
              aria-label="Enable orchestration"
              checked={selection.enabled}
              disabled={
                locked ||
                (!selection.enabled && (!supported || !firstAvailable))
              }
              className="rounded-md text-[11px] text-muted-foreground"
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
              {selection.enabled ? "On" : "Off"}
            </DropdownMenuCheckboxItem>
          </div>
        </div>
        <p id={descriptionId} className="sr-only">
          The main agent delegates tasks to models you select from the providers
          below.
        </p>
        <div className="px-3 pb-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04] ring-1 ring-border/70"
            >
              {currentProvider ? (
                <ProviderIcon provider={currentProvider} className="size-5" />
              ) : (
                <WaypointsIcon className="size-5 text-muted-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block text-[10px] font-medium tracking-wide text-muted-foreground">
                Main agent
              </span>
              <span
                className="block truncate text-sm leading-5 font-semibold"
                title={currentModelName}
              >
                {currentModelName ||
                  currentProvider?.name ||
                  "Choose a main model"}
              </span>
            </div>
          </div>
          <div className="relative ml-4 border-l border-border/80 pt-2.5 pl-2">
            <div className="mb-0.5 flex items-center justify-between gap-2 pl-2">
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
                Delegates to
              </span>
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                  selectedModels.length
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                )}
              >
                {selectedModels.length} selected
              </span>
            </div>
            <div className="space-y-0.5">
              {workers.map(({ kind }) => (
                <OrchestrationModelMenu
                  key={kind}
                  kind={kind}
                  choices={choices.filter(
                    (choice) => choice.value.providerKind === kind
                  )}
                  selected={selectedModels.filter(
                    (model) => model.providerKind === kind
                  )}
                  disabled={locked || !supported}
                  loading={providers.some(
                    (provider) =>
                      provider.providerKind === kind &&
                      provider.modelsReady === false
                  )}
                  onChange={(models) =>
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
              ))}
            </div>
          </div>
        </div>
        <div className="border-t border-border/50 bg-foreground/[0.02] px-3 py-2">
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            >
              {selection.enabled ? (
                <CheckIcon className="size-3.5" />
              ) : (
                <span className="size-1 rounded-full bg-current" />
              )}
            </span>
            <p
              role="status"
              className="text-[11px] leading-4 text-muted-foreground"
            >
              {busy
                ? "Saving selection…"
                : worker
                  ? "Workers cannot delegate further."
                  : !supported
                    ? "Choose Claude, Codex or Grok CLI as the main model."
                    : isStreaming
                      ? "You can edit the selection after this turn finishes."
                      : !available.length
                        ? "Connect another provider in Settings to get started."
                        : selection.enabled
                          ? `${selectedModels.length} ${selectedModels.length === 1 ? "model" : "models"} selected for delegation.`
                          : "Select models to enable delegation."}
            </p>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ComposerOrchestrationBadge({
  threadId,
  currentProvider,
  providers,
}: Pick<Props, "threadId" | "currentProvider" | "providers">) {
  const selection = useSelection(threadId, currentProvider)
  if (!selection.enabled) return null
  const selectedModels = selectedSubagentModels(
    selection,
    subagentModelChoices(providers, currentProvider?.providerKind)
  )
  return (
    <div
      className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 pb-2 text-[11px] leading-4 text-muted-foreground"
      aria-label="Orchestration enabled"
    >
      <span className="inline-flex h-7 items-center gap-1.5 text-[10px]">
        <WaypointsIcon aria-hidden="true" className="size-3" />
        Orchestration
      </span>
      <AvatarGroup
        role="list"
        aria-label="Selected agent models"
        className="isolate min-w-0 flex-[1_1_200px] flex-wrap items-center gap-y-1.5"
      >
        {selectedModels.map((selected) => {
          // Resolve against the selected account, including cached catalogs
          // while discovery runs. Never borrow another account's model name.
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
          const name =
            account?.models.find((model) => model.id === selected.modelId)
              ?.name ?? selected.modelId
          const effort = selected.reasoningEffort ?? "auto"
          const effortLabel =
            effort === "auto"
              ? "Auto"
              : (getThinkingModeLabel(
                  account ?? provider,
                  selected.modelId,
                  effort
                ) ?? effort)
          const options = [
            { mode: "auto", label: "Auto" },
            ...getModelThinkingOptions(
              account ?? provider,
              selected.modelId
            ).filter(
              (option) => option.mode !== null && option.mode !== "auto"
            ),
          ]
          const accountName = account?.name ?? selected.providerInstanceId
          return (
            <div
              role="listitem"
              key={orchestratorModelKey(selected)}
              className="group/model relative max-w-full min-w-0 focus-within:z-10 hover:z-10"
            >
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    tabIndex={0}
                    aria-label={`${name}, ${accountName}`}
                    className="h-7 max-w-full cursor-default gap-1.5 rounded-full border-border/60 bg-background py-0 pr-5 pl-2.5 text-[11px] ring-2 ring-background transition-colors group-last/model:pr-2.5 hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none motion-reduce:transition-none"
                  >
                    {provider && (
                      <span
                        aria-hidden="true"
                        className="flex size-3.5 shrink-0 items-center justify-center"
                      >
                        <ProviderIcon
                          provider={provider}
                          className="size-3.5"
                        />
                      </span>
                    )}
                    <span className="min-w-0 truncate font-medium">{name}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  sideOffset={8}
                  collisionPadding={12}
                  className="flex-col items-start gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md motion-reduce:animate-none [&>span>svg]:bg-popover [&>span>svg]:fill-popover"
                >
                  <span className="max-w-64 text-[11px] font-medium break-words">
                    {name}
                  </span>
                  <span className="flex w-full items-center justify-between gap-4">
                    <span className="text-[10px] text-muted-foreground">
                      Thinking
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[11px] font-medium",
                        reasoningColorClass(effort)
                      )}
                    >
                      <ReasoningLevelIcon
                        options={options}
                        mode={effort}
                        className="size-4"
                      />
                      <span>{effortLabel}</span>
                    </span>
                  </span>
                  {effort === "auto" && (
                    <span className="text-[10px] text-muted-foreground">
                      Provider default
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
        {!selectedModels.length && (
          <div role="listitem" className="py-1 text-[10px]">
            {selection.providers.some((kind) =>
              providers.some(
                (provider) =>
                  provider.providerKind === kind &&
                  provider.modelsReady === false
              )
            )
              ? "Loading selected models…"
              : "No models available"}
          </div>
        )}
      </AvatarGroup>
    </div>
  )
}
