import { useCallback, useEffect, useState, type KeyboardEvent } from "react"
import {
  GitBranchPlusIcon,
  GitCompareArrowsIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import type { ChatThread } from "@betterc0de/schema"
import { ProviderIcon } from "@/components/provider-icon"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MENU_NOTE } from "@/components/ui/menu-chrome"
import {
  SimpleDropdownItem,
  SimpleDropdownLabel,
  SimpleDropdownSub,
} from "@/components/ui/simple-dropdown"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useChatStore, useThreadById } from "@/lib/chat-store"
import type { ChatSubmitPayload } from "@/lib/chat/types"
import {
  COMPARE_MAX_MODELS,
  compareEntries,
  compareModelKey,
  compareModelLabels,
  isCompareModifier,
  sameCompareModel,
  toggleCompareModel,
  useCompareSelectionStore,
  type CompareModelEntry,
} from "@/lib/compare-models"
import {
  getModelThinkingOptions,
  getThinkingModeLabel,
  type ModelThinkingOption,
} from "@/lib/model-capabilities"
import { displayModelName } from "@/lib/model-display-name"
import { modelIconProvider } from "@/lib/model-vendor-logo"
import { resolveProviderModelSwitchSelection } from "@/lib/provider-model-selection"
import type { UiProvider } from "@/lib/provider-types"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { isGitRepo } from "@/services/backend/gitApi"
import type { ComposerFooterProps } from "./chat-composer-types"
import {
  ORCHESTRATION_MENU_CLASS,
  focusThinkingSlider,
} from "./orchestration-model-menu"
import { ReasoningLevelIcon } from "./reasoning-level-icon"
import { ThinkingEffortSlider } from "./thinking-effort-slider"

/**
 * Compare in the composer: Shift-, Ctrl- or ⌘-clicking models in the model
 * menu of a chat without messages chooses up to four; sending then starts
 * one chat per model (`lib/compare-send.ts`). The composer's own model is the
 * first and keeps its own controls; the others keep their reasoning level in
 * `lib/compare-models.ts`. Both footers, the inline model chip and the
 * summary above the footer read the same state through `useComposerCompare`.
 */

type ChatStoreState = ReturnType<typeof useChatStore.getState>

const NO_EXTRAS: CompareModelEntry[] = []

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * A chat can start a comparison until it has its first message, and only
 * once: the chats of a comparison carry its group.
 */
function acceptsCompare(
  state: ChatStoreState,
  threadId: string | null | undefined
): boolean {
  if (!threadId) return false
  const thread = state.threads.find((candidate) => candidate.id === threadId)
  if (!thread || thread.messages.length > 0 || (thread.messageCount ?? 0) > 0)
    return false
  if (state.streamingByThread[threadId]?.isStreaming) return false
  return !state.settingsByThread[threadId]?.compareGroupId
}

/** One compared model as the composer shows it. */
export interface CompareModelView {
  readonly key: string
  readonly entry: CompareModelEntry
  readonly provider: UiProvider | undefined
  /** The maker's mark in a catalog of several makers, else the provider's. */
  readonly iconProvider: UiProvider | undefined
  readonly name: string
  /** Its part of the chat titles ("Opus 4.5"). */
  readonly label: string
  readonly options: ReadonlyArray<ModelThinkingOption>
  readonly levelLabel: string
}

function describeCompareModels(
  entries: ReadonlyArray<CompareModelEntry>,
  providers: ReadonlyArray<UiProvider>
): CompareModelView[] {
  const described = entries.map((entry) => {
    const provider = providers.find(
      (candidate) => candidate.id === entry.providerId
    )
    const model = provider?.models.find(
      (candidate) => candidate.id === entry.modelId
    )
    const name = displayModelName(entry.modelId, model?.name)
    return {
      key: compareModelKey(entry),
      entry,
      provider,
      iconProvider: provider
        ? modelIconProvider(provider, { id: entry.modelId, name })
        : undefined,
      name,
      options: getModelThinkingOptions(provider, entry.modelId),
      levelLabel:
        getThinkingModeLabel(provider, entry.modelId, entry.thinkingMode) ??
        "Off",
    }
  })
  const labels = compareModelLabels(
    described.map((model) => ({
      name: model.name,
      providerName: model.provider?.name ?? "",
    }))
  )
  return described.map((model, index) => ({
    ...model,
    label: labels[index] ?? model.name,
  }))
}

/** What a model row's click carries; React's mouse events fit. */
interface CompareClickEvent {
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  preventDefault: () => void
}

export interface ComposerCompare {
  readonly threadId: string | null
  /** Offered: a chat with no messages yet. */
  readonly available: boolean
  /** Two or more models chosen. */
  readonly active: boolean
  /** The chosen models, the composer's own first; empty while inactive. */
  readonly models: CompareModelView[]
  /** What the comparison is doing while its chats are prepared. */
  readonly progress: string | null
  /** Models added after the composer's own, kept even while unavailable. */
  readonly extraCount: number
  /** A row's check: membership while comparing, else the single selection. */
  isRowSelected: (providerId: string, modelId: string) => boolean
  /**
   * A model row's click. With Shift, Ctrl or ⌘ it toggles the model in the
   * comparison, keeps the menu open and returns `true`; a plain click ends
   * the comparison and returns `false`, so the row selects as before.
   */
  handleModelClick: (
    event: CompareClickEvent,
    provider: UiProvider,
    modelId: string
  ) => boolean
  /** Enter or Space with a modifier on a Radix menu row, which would drop it. */
  handleModelKeyDown: (
    event: KeyboardEvent,
    provider: UiProvider,
    modelId: string
  ) => void
  setThinking: (model: CompareModelView, mode: string | null) => void
  clear: () => void
}

type CompareProps = Pick<
  ComposerFooterProps,
  | "threadId"
  | "providers"
  | "selectedProviderId"
  | "selectedModel"
  | "thinkingMode"
  | "contextWindow"
  | "setSelectedProviderId"
  | "setSelectedModel"
  | "setContextWindow"
  | "setThinkingMode"
>

export function useComposerCompare(props: CompareProps): ComposerCompare {
  const threadId = props.threadId ?? null
  const available = useChatStore(
    useCallback(
      (state: ChatStoreState) => acceptsCompare(state, threadId),
      [threadId]
    )
  )
  const extras = useCompareSelectionStore((state) =>
    threadId ? (state.extrasByThread[threadId] ?? NO_EXTRAS) : NO_EXTRAS
  )
  const progress = useCompareSelectionStore((state) =>
    threadId ? (state.progressByThread[threadId] ?? null) : null
  )
  const primary: CompareModelEntry = {
    providerId: props.selectedProviderId,
    modelId: props.selectedModel,
    thinkingMode: props.thinkingMode,
  }
  const entries = available ? compareEntries(primary, extras) : [primary]
  const active = entries.length > 1
  const models = active ? describeCompareModels(entries, props.providers) : []

  // The composer's own model, as a plain click on its row would select it.
  const selectEntry = (entry: CompareModelEntry) => {
    const provider = props.providers.find(
      (candidate) => candidate.id === entry.providerId
    )
    if (!provider) return
    const next = resolveProviderModelSwitchSelection({
      provider,
      modelId: entry.modelId,
      thinkingMode: entry.thinkingMode,
      contextWindow: props.contextWindow,
    })
    props.setSelectedProviderId(next.providerId)
    props.setSelectedModel(next.modelId, next.providerId)
    props.setContextWindow(next.contextWindow, next.providerId)
    props.setThinkingMode(next.thinkingMode, next.providerId)
  }

  const toggle = (provider: UiProvider, modelId: string) => {
    if (!threadId) return
    const store = useCompareSelectionStore.getState()
    const candidate: CompareModelEntry = {
      providerId: provider.id,
      modelId,
      // The current level, where the model offers it.
      thinkingMode: resolveProviderModelSwitchSelection({
        provider,
        modelId,
        thinkingMode: props.thinkingMode,
        contextWindow: props.contextWindow,
      }).thinkingMode,
    }
    const result = toggleCompareModel(
      primary,
      store.extrasByThread[threadId] ?? NO_EXTRAS,
      candidate
    )
    if (result.kind === "changed") {
      store.setExtras(threadId, result.extras)
    } else if (result.kind === "promoted") {
      selectEntry(result.primary)
      store.setExtras(threadId, result.extras)
    } else if (result.kind === "full") {
      toast.info(`You can compare up to ${COMPARE_MAX_MODELS} models.`, {
        id: "compare-limit",
      })
    }
  }

  const clear = () => {
    if (threadId) useCompareSelectionStore.getState().clear(threadId)
  }

  return {
    threadId,
    available,
    active,
    models,
    progress,
    extraCount: extras.length,
    isRowSelected: (providerId, modelId) =>
      active
        ? entries.some((entry) =>
            sameCompareModel(entry, { providerId, modelId })
          )
        : props.selectedProviderId === providerId &&
          props.selectedModel === modelId,
    handleModelClick: (event, provider, modelId) => {
      if (available && isCompareModifier(event)) {
        event.preventDefault()
        toggle(provider, modelId)
        return true
      }
      if (extras.length > 0) clear()
      return false
    },
    handleModelKeyDown: (event, provider, modelId) => {
      if (!available || !isCompareModifier(event)) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      toggle(provider, modelId)
    },
    setThinking: (model, mode) => {
      if (!threadId) return
      if (sameCompareModel(model.entry, primary)) {
        props.setThinkingMode(mode, model.entry.providerId)
      } else {
        useCompareSelectionStore
          .getState()
          .setThinking(threadId, model.entry, mode)
      }
    },
    clear,
  }
}

/** The model menu's foot: how to compare, or how far the comparison is. */
export function ComposerCompareHint({
  compare,
  className,
}: {
  compare: ComposerCompare
  className?: string
}) {
  if (!compare.available) return null
  return (
    <p className={cn(MENU_NOTE, "text-muted-foreground/75", className)}>
      <GitCompareArrowsIcon aria-hidden="true" strokeWidth={1.75} />
      <span>
        {compare.active
          ? `${compare.models.length} of ${COMPARE_MAX_MODELS} models · each gets its own chat`
          : `${IS_MAC ? "⇧- or ⌘-click" : "Shift- or Ctrl-click"} to compare up to ${COMPARE_MAX_MODELS} models`}
      </span>
    </p>
  )
}

/** The model chip's face while comparing: the models' logos stacked, then the count. */
export function CompareChipModels({
  compare,
  className,
}: {
  compare: ComposerCompare
  className?: string
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center -space-x-1"
      >
        {compare.models.map((model) => (
          <span
            key={model.key}
            className="flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border/60"
          >
            {model.iconProvider ? (
              <ProviderIcon
                provider={model.iconProvider}
                className="!size-[11px]"
              />
            ) : null}
          </span>
        ))}
      </span>
      <span className="truncate text-foreground/90">
        {compare.models.length} models
      </span>
      <span className="sr-only">
        : {compare.models.map((model) => model.name).join(", ")}
      </span>
    </span>
  )
}

function CompareLevel({ model }: { model: CompareModelView }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
        reasoningColorClass(model.entry.thinkingMode)
      )}
    >
      <ReasoningLevelIcon
        options={model.options}
        mode={model.entry.thinkingMode}
        className="size-4"
      />
      <span>{model.levelLabel}</span>
    </span>
  )
}

/** One model's reasoning slider, or why it has none. */
function CompareThinkingPanel({
  model,
  compare,
}: {
  model: CompareModelView
  compare: ComposerCompare
}) {
  if (model.options.length === 0) {
    return (
      <p className="max-w-56 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground">
        {model.name} has no reasoning levels to choose from.
      </p>
    )
  }
  return (
    <ThinkingEffortSlider
      options={model.options}
      thinkingMode={model.entry.thinkingMode}
      modelName={model.name}
      selectionKey={JSON.stringify([compare.threadId, model.key])}
      onSelect={(mode) => compare.setThinking(model, mode)}
    />
  )
}

/**
 * The compact model menu's rows while comparing, in place of its single
 * Reasoning row: each model with its own level, then a way back to one.
 */
export function ComposerCompareMenuRows({
  compare,
}: {
  compare: ComposerCompare
}) {
  if (!compare.active) return null
  return (
    <>
      <SimpleDropdownLabel className="px-2.5">
        Reasoning per model
      </SimpleDropdownLabel>
      {compare.models.map((model) => (
        <SimpleDropdownSub
          key={model.key}
          triggerClassName="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
          trigger={
            <>
              {model.iconProvider ? (
                <ProviderIcon
                  provider={model.iconProvider}
                  className="!size-4 shrink-0"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              <span
                className={cn(
                  "mr-1 flex shrink-0 items-center gap-1 text-[11px] font-medium",
                  reasoningColorClass(model.entry.thinkingMode)
                )}
              >
                <ReasoningLevelIcon
                  options={model.options}
                  mode={model.entry.thinkingMode}
                  className="size-3.5"
                />
                {model.levelLabel}
              </span>
            </>
          }
          className="min-w-[258px]"
        >
          <CompareThinkingPanel model={model} compare={compare} />
        </SimpleDropdownSub>
      ))}
      <SimpleDropdownItem
        onClick={compare.clear}
        className="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
      >
        <XIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
        <span className="flex-1">Back to one model</span>
      </SimpleDropdownItem>
    </>
  )
}

/** Borderless entries that show a surface only while hovered, focused or open. */
const ENTRY_CLASS =
  "flex h-8 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60 data-[state=open]:bg-accent motion-reduce:transition-none"
const TOOLTIP_CLASS =
  "flex-col items-start gap-1.5 rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md motion-reduce:animate-none [&>span>svg]:bg-popover [&>span>svg]:fill-popover"

/** Hover or focus names the model and its level; a click opens its slider. */
function CompareBarEntry({
  model,
  compare,
  locked,
}: {
  model: CompareModelView
  compare: ComposerCompare
  locked: boolean
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
        <DropdownMenuTrigger asChild disabled={locked}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${model.name}, reasoning ${model.levelLabel}`}
              className={ENTRY_CLASS}
            >
              {model.iconProvider ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 items-center justify-center"
                >
                  <ProviderIcon
                    provider={model.iconProvider}
                    className="!size-4"
                  />
                </span>
              ) : null}
              <span aria-hidden="true" className="flex">
                <ReasoningLevelIcon
                  options={model.options}
                  mode={model.entry.thinkingMode}
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
          className={TOOLTIP_CLASS}
        >
          <span className="max-w-64 text-[11px] font-medium break-words">
            {model.name}
          </span>
          <span className="flex w-full items-center justify-between gap-4">
            <span className="text-[10px] text-muted-foreground">Reasoning</span>
            <CompareLevel model={model} />
          </span>
          {!locked && model.options.length > 0 && (
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
        aria-label={`${model.name} reasoning`}
        className={cn(
          ORCHESTRATION_MENU_CLASS,
          "w-auto p-0 motion-reduce:animate-none"
        )}
        onFocus={focusThinkingSlider}
      >
        <CompareThinkingPanel model={model} compare={compare} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type CompareRunLocation = "worktrees" | "shared" | "separate"

/**
 * Where the compared chats will run: a worktree each in a Git repository,
 * a scratch folder each without a project, otherwise one shared folder.
 * `null` while the repository check runs.
 */
function useCompareRunLocation(
  thread: Pick<ChatThread, "projectPath" | "worktreePath"> | null | undefined,
  enabled: boolean
): CompareRunLocation | null {
  const projectPath = thread?.projectPath?.trim() ?? ""
  const inWorktree = Boolean(thread?.worktreePath?.trim())
  const [probe, setProbe] = useState<{ path: string; repo: boolean } | null>(
    null
  )
  useEffect(() => {
    if (!enabled || !projectPath || inWorktree) return
    let cancelled = false
    isGitRepo(projectPath)
      .catch(() => false)
      .then((repo) => {
        if (!cancelled) setProbe({ path: projectPath, repo })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, projectPath, inWorktree])
  if (!projectPath) return "separate"
  if (inWorktree) return "worktrees"
  if (probe?.path !== projectPath) return null
  return probe.repo ? "worktrees" : "shared"
}

function CompareRunNote({
  progress,
  location,
  count,
}: {
  progress: string | null
  location: CompareRunLocation | null
  count: number
}) {
  const line = "flex max-w-md items-start gap-1.5 text-[11px] leading-4"
  if (progress) {
    return (
      <p className={cn(line, "text-muted-foreground")}>
        <LoaderCircleIcon
          aria-hidden="true"
          className="mt-0.5 size-3 shrink-0 motion-safe:animate-spin"
        />
        {progress}
      </p>
    )
  }
  if (location === "shared") {
    return (
      <p className={cn(line, "text-warning")}>
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-3 shrink-0"
        />
        Not a Git repository: the {count} chats share this folder and can edit
        the same files.
      </p>
    )
  }
  if (location === "worktrees" || location === "separate") {
    return (
      <p className={cn(line, "text-muted-foreground")}>
        <GitBranchPlusIcon
          aria-hidden="true"
          className="mt-0.5 size-3 shrink-0"
        />
        {location === "worktrees"
          ? "Each model gets its own chat and worktree."
          : "Each model gets its own chat."}
      </p>
    )
  }
  return null
}

/**
 * The comparison above the composer footer: a heading with the model count
 * and a way back to one model, the models with their reasoning levels, and
 * where the chats will run, or what is being prepared.
 */
export function ComposerCompareBar(props: CompareProps) {
  const compare = useComposerCompare(props)
  const thread = useThreadById(compare.threadId)
  const location = useCompareRunLocation(thread, compare.active)
  const { threadId, available, extraCount, progress } = compare
  // A chat that has messages keeps no unsent comparison.
  useEffect(() => {
    if (threadId && !available && extraCount > 0 && !progress)
      useCompareSelectionStore.getState().clear(threadId)
  }, [threadId, available, extraCount, progress])
  if (!compare.active) return null
  const count = compare.models.length
  const busy = Boolean(progress)
  return (
    <div
      role="group"
      aria-label="Compare models"
      className="flex w-full flex-col items-center gap-1.5 px-3 pb-2"
    >
      <div className="flex items-center justify-center gap-1.5 text-xs leading-4">
        <GitCompareArrowsIcon
          aria-hidden="true"
          className="size-4 text-primary"
          strokeWidth={2}
        />
        <span className="font-medium text-foreground">Compare</span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          ·
        </span>
        <span className="text-muted-foreground tabular-nums">
          {count} models
        </span>
        <button
          type="button"
          onClick={compare.clear}
          disabled={busy}
          aria-label="Back to one model"
          title="Back to one model"
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div
        role="list"
        aria-label="Compared models"
        className="flex flex-wrap items-center justify-center gap-1"
      >
        {compare.models.map((model) => (
          <div role="listitem" key={model.key} className="flex">
            <CompareBarEntry model={model} compare={compare} locked={busy} />
          </div>
        ))}
      </div>
      <div aria-live="polite" className="flex justify-center text-center">
        <CompareRunNote progress={progress} location={location} count={count} />
      </div>
    </div>
  )
}

/**
 * The composer's submit: while a comparison is chosen, one chat per model
 * (`dispatchCompare`, loaded on first use); otherwise the composer's own
 * submit, unchanged.
 */
export function useCompareSubmit({
  threadId,
  providers,
  selectedProviderId,
  selectedModel,
  thinkingMode,
  handleSubmit,
  submitToThread,
}: {
  threadId: string | null
  providers: ReadonlyArray<UiProvider>
  selectedProviderId: string
  selectedModel: string
  thinkingMode: string | null
  handleSubmit: (payload: ChatSubmitPayload) => void
  submitToThread?: (payload: ChatSubmitPayload) => unknown
}) {
  const confirm = useConfirm()
  return (payload: ChatSubmitPayload): void | Promise<boolean | void> => {
    if (!threadId || !submitToThread) return handleSubmit(payload)
    const extras =
      useCompareSelectionStore.getState().extrasByThread[threadId] ?? NO_EXTRAS
    if (
      extras.length === 0 ||
      !acceptsCompare(useChatStore.getState(), threadId)
    )
      return handleSubmit(payload)
    const entries = compareEntries(
      { providerId: selectedProviderId, modelId: selectedModel, thinkingMode },
      extras
    )
    if (entries.length < 2) return handleSubmit(payload)
    const models = describeCompareModels(entries, providers)
    return import("@/lib/compare-send").then(({ dispatchCompare }) =>
      dispatchCompare({
        originThreadId: threadId,
        models: models.map((model) => ({
          entry: model.entry,
          provider: model.provider,
          name: model.name,
          label: model.label,
        })),
        payload,
        sendOrigin: handleSubmit,
        sendTo: submitToThread,
        confirmSharedFolder: (count, projectName) =>
          confirm({
            title: "Share one folder?",
            description: `${projectName} is not a Git repository, so the ${count} chats can't each get a worktree of their own. They will work in the same folder and can edit the same files at the same time.`,
            confirmLabel: `Send to ${count} models`,
          }),
      })
    )
  }
}
