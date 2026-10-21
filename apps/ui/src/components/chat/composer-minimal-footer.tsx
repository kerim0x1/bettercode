/**
 * Minimal-mode footer for the chat composer — Codex-desktop-style layout:
 *
 *   [+] [permissions ▾]             [⚡ model · reasoning ▾] [◔] [mic] [⬆]
 *
 * - "◔" ring: context window meter (`composer-context-meter.tsx`).
 * - "+" menu: Files and folders.
 * - Orchestration icon: model pool, directly before permissions.
 * - There is no Mode picker: Agent is the default and Plan is toggled with
 *   Shift+Tab, so the one thing left to choose in the input row is how far
 *   the agent may act on its own.
 * - Permission chip: label from the shared table, red when Bypass is on.
 * - Model chip: one dropdown with Model / Reasoning / Speed sub-rows
 *   (Speed = Fast Mode, only for models that support it).
 *
 * Extracted from `chat-composer.tsx` to keep the main file under 500 LOC.
 */

import React, { useMemo } from "react"
import { cn } from "@/lib/utils"
import { chatModeLabel } from "@/lib/chat-mode-labels"
import type { ComposerFooterProps } from "./chat-composer-types"
import { ComposerOrchestrationMenu } from "./composer-orchestration"
import {
  CompareChipModels,
  ComposerCompareHint,
  ComposerCompareMenuRows,
  useComposerCompare,
} from "./composer-compare"
import { ProviderIcon } from "@/components/provider-icon"
import { mapSortedModelsByProvider } from "@/lib/model-ordering"
import { modelIconProvider } from "@/lib/model-vendor-logo"
import {
  isProviderUnconfigured,
  resolveProviderSetupHint,
} from "@/lib/provider-status-hint"
import { LockIcon } from "lucide-react"
import { VoiceInputControl } from "@/components/chat/voice-input-control"
import {
  PERMISSION_LEVELS,
  BYPASS_CONFIRM_TITLE,
  BYPASS_CONFIRM_BODY,
  permissionLevelLabel,
  type PermissionLevelOption,
} from "@/components/chat/composer-mode-tables"
import { applyPermissionModeLive } from "@/lib/permission-mode-live"
import {
  PermissionMenuRow,
  permissionIcon,
} from "@/components/chat/permission-menu-row"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  getModelThinkingOptions,
  getThinkingModeLabel,
  supportsModelFastMode,
} from "@/lib/model-capabilities"
import { ThinkingEffortSlider } from "@/components/chat/thinking-effort-slider"
import { ReasoningLevelIcon } from "@/components/chat/reasoning-level-icon"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import { resolveProviderModelSwitchSelection } from "@/lib/provider-model-selection"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import {
  PromptInputTools,
  PromptInputButton,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import { ComposerSubmit } from "@/components/chat/composer-submit"
import { ComposerContextMeter } from "@/components/chat/composer-context-meter"
import {
  SimpleDropdown,
  SimpleDropdownSub,
  SimpleDropdownSubItem,
  SimpleDropdownSeparator,
  SimpleDropdownLabel,
} from "@/components/ui/simple-dropdown"

import {
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  PaperclipIcon,
  ArrowUpIcon,
  ZapIcon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FlashIcon as FlashHugeIcon,
  BotIcon,
  ClipboardIcon,
  ChatBotIcon,
} from "@hugeicons/core-free-icons"

export function ComposerMinimalFooter(props: ComposerFooterProps) {
  const confirm = useConfirm()
  const {
    handleStop,
    thinkingMode,
    setThinkingMode,
    chatMode,
    setChatMode,
    permissionLevel,
    setPermissionLevel,
    setContextWindow,
    fastMode,
    setFastMode,
    currentModelName,
    selectedProvider,
    currentProvider,
    selectedModel,
    setSelectedModel,
    setSelectedProviderId,
    providers,
    isFavorite,
    isLmStudio,
    isStreaming,
    modelPickerOpen,
    setModelPickerOpen,
    planFollowUpActive: hasPendingPlan,
    hideSubmit,
    voiceSetupComplete,
    deepgram,
    handleVoiceClick,
    threadId,
    handleVoiceContextMenu,
  } = props
  const promptInput = usePromptInputController()
  // Shift/Ctrl/⌘-click in a new chat: one prompt to several models.
  const compare = useComposerCompare(props)
  const planFollowUpActive =
    hasPendingPlan &&
    !/^\/goal(?:\s|$)/i.test(promptInput.textInput.value.trim())
  const planFollowUpLabel =
    planFollowUpActive && promptInput.textInput.value.trim().length > 0
      ? "Refine"
      : "Implement"

  // Fast Mode is a model capability exposed by Codex/Claude CLI runtimes.
  //   - Codex CLI → `serviceTier: "fast"` on Codex's `turn/start` payload
  //     (per OpenAI's official schema).
  //   - Claude CLI → `settings.fastMode: true` in Claude Agent SDK's
  //     `ClaudeQueryOptions` (per Anthropic's SDK).
  // Runtime `capabilities.optionDescriptors` decide per-model visibility once
  // loaded; until then we use the provider-level fallback.
  const providerKey = (
    currentProvider?.providerKind ??
    currentProvider?.id ??
    ""
  ).toLowerCase()
  const showFastMode =
    Boolean(selectedModel) &&
    supportsModelFastMode(currentProvider, selectedModel)
  const sortedModelsByProviderId = useMemo(
    () => mapSortedModelsByProvider(providers, isFavorite),
    [providers, isFavorite]
  )
  const selectProviderModel = (
    provider: (typeof providers)[number],
    modelId: string,
    nextContextWindow: string = "1m"
  ) => {
    const nextSelection = resolveProviderModelSwitchSelection({
      provider,
      modelId,
      thinkingMode,
      contextWindow: nextContextWindow,
    })
    setSelectedProviderId(nextSelection.providerId)
    setSelectedModel(nextSelection.modelId, nextSelection.providerId)
    setContextWindow(nextSelection.contextWindow, nextSelection.providerId)
    setThinkingMode(nextSelection.thinkingMode, nextSelection.providerId)
  }

  const buildThinkingOptions = () =>
    getModelThinkingOptions(currentProvider, selectedModel)

  const renderThinkingItems = () => (
    <ThinkingEffortSlider
      options={buildThinkingOptions()}
      thinkingMode={thinkingMode}
      modelName={currentModelName}
      selectionKey={JSON.stringify([
        threadId,
        currentProvider?.id,
        selectedModel,
      ])}
      onSelect={(mode) => setThinkingMode(mode, currentProvider?.id)}
    />
  )

  const renderModelItems = () =>
    providers.map((provider) => {
      // `configured === false` means the backend explicitly reported the
      // provider as unconfigured (no API key / no logged-in CLI / no
      // running local server). `undefined` means the status hasn't been
      // fetched yet and we MUST NOT pre-emptively disable the entry —
      // see resolveProviderSetupHint / isProviderUnconfigured for the
      // shared rule.
      const isDisabled = isProviderUnconfigured(provider)
      const tooltip = resolveProviderSetupHint(provider)
      return (
        <SimpleDropdownSub
          key={provider.id}
          disabled={isDisabled}
          tooltip={tooltip}
          trigger={
            <>
              <ProviderIcon
                provider={provider}
                className={cn("!size-3.5 shrink-0", isDisabled && "grayscale")}
              />
              <span className="flex-1">{provider.name}</span>
              {isDisabled ? (
                <LockIcon className="mr-1 size-3 text-muted-foreground" />
              ) : (
                <span className="mr-1 text-xs text-muted-foreground">
                  {provider.models.length > 0 ? provider.models.length : "—"}
                </span>
              )}
            </>
          }
          className="max-h-[350px]"
        >
          {provider.models.length === 0 ? (
            // LM Studio (and any other provider whose model list is fetched
            // dynamically) starts with `models: []` — render a placeholder so
            // the entry stays visible in the dropdown instead of being filtered
            // out before the live list arrives. Click is a no-op via
            // pointer-events-none so the item reads as informational.
            <SimpleDropdownSubItem className="pointer-events-none opacity-60">
              <span className="flex-1 text-xs text-muted-foreground">
                No models available
              </span>
            </SimpleDropdownSubItem>
          ) : (
            (sortedModelsByProviderId.get(provider.id) ?? provider.models).map(
              (model) => {
                // While comparing, every chosen model is checked.
                const isSelected = compare.isRowSelected(provider.id, model.id)
                return (
                  <SimpleDropdownSubItem
                    key={model.id}
                    onClick={(event) => {
                      if (compare.handleModelClick(event, provider, model.id))
                        return
                      selectProviderModel(provider, model.id)
                    }}
                    active={isSelected}
                  >
                    <ProviderIcon
                      provider={modelIconProvider(provider, model)}
                      className="!size-3.5 shrink-0"
                    />
                    <span
                      className="min-w-0 flex-1 text-left"
                      title={model.name !== model.id ? model.id : undefined}
                    >
                      <span className="block truncate">{model.name}</span>
                      {/* A readable name over an OpenRouter slug keeps the
                          exact id in reach, so a typo still shows. */}
                      {model.name !== model.id && model.id.includes("/") ? (
                        <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                          {model.id}
                        </span>
                      ) : null}
                    </span>
                    {isSelected && (
                      <CheckIcon className="size-3 shrink-0 text-primary" />
                    )}
                  </SimpleDropdownSubItem>
                )
              }
            )
          )}
        </SimpleDropdownSub>
      )
    })

  // The per-level icon moved into `permission-menu-row.tsx` so both footers
  // draw the same row.

  // Codex-style approval menu (#58): roomy rows, icon column, bold title
  // over a grey description, the danger level fully in the destructive colour.
  const choosePermission = async (id: PermissionLevelOption["id"]) => {
    if (id === "bypass" && permissionLevel !== "bypass") {
      const okToProceed = await confirm({
        title: BYPASS_CONFIRM_TITLE,
        description: BYPASS_CONFIRM_BODY,
        confirmLabel: "Enable Bypass",
        destructive: true,
      })
      if (!okToProceed) return
    }
    setPermissionLevel(id)
    applyPermissionModeLive(id, selectedProvider, threadId)
  }

  const renderPermissionItems = () =>
    PERMISSION_LEVELS.map((option) => (
      <SimpleDropdownSubItem
        key={option.id}
        className="items-start gap-2.5 rounded-lg px-2.5 py-2"
        onClick={() => void choosePermission(option.id)}
        active={permissionLevel === option.id}
      >
        <PermissionMenuRow
          option={option}
          active={permissionLevel === option.id}
        />
      </SimpleDropdownSubItem>
    ))

  // In a catalog of several makers (OpenRouter, Cursor) the chip and the
  // Model row show the selected model's maker, like its row in the list.
  const currentModelIconProvider =
    currentProvider && selectedModel
      ? modelIconProvider(currentProvider, {
          id: selectedModel,
          name: currentModelName,
        })
      : null
  const thinkingLabel =
    getThinkingModeLabel(currentProvider, selectedModel, thinkingMode) ?? "Off"

  // Same table the menu renders, so the chip and the checked row always agree.
  const permissionLabel = permissionLevelLabel(permissionLevel)
  const PermissionChipIcon = permissionIcon(permissionLevel)
  const multiAgentSession = useMultiAgentStore((s) => s.session)
  const multiAgentRunning = multiAgentSession?.status === "running"
  const multiAgentPaused = multiAgentSession?.status === "paused"
  const multiAgentConfiguring = multiAgentSession?.status === "configuring"
  const multiAgentActive =
    Boolean(multiAgentSession) &&
    !["completed", "cancelled"].includes(multiAgentSession?.status ?? "")
  const multiAgentCount = multiAgentSession?.agents.length ?? 0
  const multiAgentWorkingCount =
    multiAgentSession?.agents.filter((agent) => agent.status === "working")
      .length ?? 0
  const multiAgentLabel = multiAgentRunning
    ? `${multiAgentWorkingCount}/${multiAgentCount}`
    : multiAgentPaused
      ? "Paused"
      : multiAgentConfiguring
        ? "Draft"
        : "Multi"

  const openMultiAgentConfig = (useDraft = true) => {
    const draft = promptInput.textInput.value.trim()
    const store = useMultiAgentStore.getState()
    if (
      store.session?.status === "completed" ||
      store.session?.status === "cancelled"
    ) {
      store.clearSession()
    }
    store.openConfig()
    if (useDraft && draft) store.setTask(draft)
  }

  const resumeMultiAgent = () => {
    const resolve = async (providerId: string, modelId: string) => {
      const provider = providers.find(
        (candidate) => candidate.id === providerId
      )
      return resolveProviderTarget(provider, modelId)
    }
    useMultiAgentStore
      .getState()
      .resumeSession(resolve, (mode) => buildSystemInstruction(mode))
  }

  return (
    <div className="contents">
      {/* Clipped, never overlapping: in a narrow column the right group keeps
          its size and the left group hides labels (see the @max-[400px]
          variants) instead of drawing under the model chip. */}
      <PromptInputTools className="min-w-0 gap-1 overflow-hidden">
        {/* ── "+" menu — Files and folders ── */}
        <div className="order-1">
          <SimpleDropdown
            align="start"
            trigger={
              <PromptInputButton
                tooltip="Add"
                aria-label="Add"
                size="icon-xs"
                className="relative rounded-md text-muted-foreground"
              >
                <PlusIcon className="size-4" strokeWidth={2} />
                {promptInput.attachments.files.length > 0 && (
                  <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-semibold text-primary-foreground tabular-nums">
                    {Math.min(promptInput.attachments.files.length, 9)}
                  </span>
                )}
              </PromptInputButton>
            }
            className="min-w-[210px]"
          >
            <SimpleDropdownLabel>Add</SimpleDropdownLabel>
            <SimpleDropdownSubItem
              onClick={() => promptInput.attachments.openFileDialog()}
            >
              <PaperclipIcon className="size-3.5" strokeWidth={2} />
              <span className="flex-1">Files and folders</span>
              {promptInput.attachments.files.length > 0 && (
                <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                  {promptInput.attachments.files.length}
                </span>
              )}
            </SimpleDropdownSubItem>
          </SimpleDropdown>
        </div>

        {/* The Mode picker is gone: Agent is the default, and Plan is reached
            with Shift+Tab instead of a dropdown. The "/ask" slash command
            still switches a thread to read-only ask mode.

            What stays is an indicator for any mode that is NOT the default.
            Without it, Shift+Tab would put the thread into a state with no
            sign it happened and no way back except the same hidden shortcut —
            and "/ask" would be a one-way door. Clicking returns to Agent. */}
        {chatMode !== "agent" && (
          <div className="order-3">
            <PromptInputButton
              tooltip={{
                content: `${chatModeLabel(chatMode)} mode`,
                shortcut: "⇧ Tab",
              }}
              size="xs"
              onClick={() => setChatMode("agent")}
              className={cn(
                "gap-1 rounded-md px-1.5 text-[12.5px]",
                chatMode === "plan" ? "text-sky-400" : "text-red-400"
              )}
            >
              <HugeiconsIcon
                icon={chatMode === "plan" ? ClipboardIcon : ChatBotIcon}
                strokeWidth={2}
                className="size-4"
              />
              <span className="text-[12.5px] @max-[340px]:hidden">
                {chatModeLabel(chatMode)}
              </span>
            </PromptInputButton>
          </div>
        )}

        {/* ── Inline Permissions chip — the one thing left to choose in the
            input row, so it stays visible rather than living in a menu.
            It carries the icon of the ACTIVE preset, not a generic shield:
            the chip and the checked row in its own menu must show the same
            thing. Bypass Permission announces itself in red. ── */}
        <div className="order-2 flex shrink-0 items-center gap-1">
          <ComposerOrchestrationMenu {...props} />
          <SimpleDropdown
            align="start"
            trigger={
              <PromptInputButton
                tooltip="Permissions"
                size="xs"
                className={cn(
                  "gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground",
                  permissionLevel === "bypass" && "text-destructive"
                )}
              >
                <PermissionChipIcon className="size-3.5" strokeWidth={1.75} />
                <span className="text-[12.5px] @max-[400px]:hidden">
                  {permissionLabel}
                </span>
              </PromptInputButton>
            }
            className="min-w-[310px] p-1"
          >
            {renderPermissionItems()}
          </SimpleDropdown>
        </div>

        {/* ── Multiagent dropdown — lives with the turn controls, not the
            editor ActivityBar. Starting a run allocates one git worktree per
            agent thread before any provider turn is sent.
            Temporarily hidden from the composer per request — remove `hidden`
            below to restore it. */}
        <div className="order-4 hidden">
          <SimpleDropdown
            align="start"
            trigger={
              <PromptInputButton
                tooltip="Multiagent"
                size="xs"
                className={cn(
                  "gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground",
                  multiAgentRunning && "text-emerald-400",
                  multiAgentPaused && "text-amber-400"
                )}
              >
                <HugeiconsIcon
                  icon={BotIcon}
                  strokeWidth={2}
                  className="size-3.5"
                />
                <span className="text-[12.5px]">{multiAgentLabel}</span>
              </PromptInputButton>
            }
            className="min-w-[236px]"
          >
            <SimpleDropdownSubItem
              onClick={() => openMultiAgentConfig(true)}
              disabled={providers.length === 0}
            >
              <HugeiconsIcon
                icon={BotIcon}
                strokeWidth={2}
                className="size-3.5"
              />
              <div className="flex flex-1 flex-col">
                <span className="text-xs">
                  {multiAgentConfiguring ? "Continue setup" : "Configure swarm"}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  Uses the current prompt as the shared task.
                </span>
              </div>
            </SimpleDropdownSubItem>

            <SimpleDropdownSubItem disabled>
              <GitBranchIcon className="size-3.5" />
              <div className="flex flex-1 flex-col">
                <span className="text-xs">Isolated worktrees</span>
                <span className="text-[10px] text-muted-foreground">
                  One git worktree and branch per agent.
                </span>
              </div>
            </SimpleDropdownSubItem>

            {multiAgentActive && (
              <>
                <SimpleDropdownSeparator />
                <SimpleDropdownSubItem disabled>
                  <span className="size-2 rounded-full bg-emerald-400" />
                  <div className="flex flex-1 flex-col">
                    <span className="text-xs capitalize">
                      {multiAgentSession?.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {multiAgentWorkingCount} active · {multiAgentCount} agents
                    </span>
                  </div>
                </SimpleDropdownSubItem>
                {multiAgentRunning && (
                  <SimpleDropdownSubItem
                    onClick={() => useMultiAgentStore.getState().pauseSession()}
                  >
                    <PauseIcon className="size-3.5" />
                    <span className="flex-1">Pause swarm</span>
                  </SimpleDropdownSubItem>
                )}
                {multiAgentPaused && (
                  <SimpleDropdownSubItem onClick={resumeMultiAgent}>
                    <PlayIcon className="size-3.5" />
                    <span className="flex-1">Resume swarm</span>
                  </SimpleDropdownSubItem>
                )}
                <SimpleDropdownSubItem
                  onClick={() => useMultiAgentStore.getState().cancelSession()}
                >
                  <SquareIcon className="size-3.5 text-destructive" />
                  <span className="flex-1 text-destructive">Stop swarm</span>
                </SimpleDropdownSubItem>
              </>
            )}
          </SimpleDropdown>
        </div>
      </PromptInputTools>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* ── Model chip — Codex-style: ⚡ model + reasoning value, one
            dropdown with Model / Reasoning / Speed rows. `modelPickerOpen`
            keeps external open-model-picker triggers working. ── */}
        <SimpleDropdown
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
          align="end"
          trigger={
            <PromptInputButton
              tooltip="Model"
              size="xs"
              className="gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground"
            >
              {/* The bolt is a Fast-Mode STATUS light, not a decoration —
                  it only mounts while Fast Mode is actually on (#60), filled
                  in the purple of the top reasoning levels. */}
              {showFastMode && fastMode && !compare.active && (
                <>
                  {/* The Speed row's own bolt, so chip and menu match. */}
                  <HugeiconsIcon
                    icon={FlashHugeIcon}
                    aria-hidden="true"
                    strokeWidth={1.75}
                    fill="currentColor"
                    className="size-4 shrink-0 text-purple-700 dark:text-purple-400"
                  />
                  <span className="sr-only">Fast mode on</span>
                </>
              )}
              {/* Comparing: the chosen models' logos stacked and their count
                  in place of one model and its level. */}
              {compare.active && (
                <CompareChipModels
                  compare={compare}
                  className="max-w-[160px] @max-[400px]:max-w-[120px]"
                />
              )}
              {!compare.active && currentProvider && (
                <ProviderIcon
                  provider={currentModelIconProvider ?? currentProvider}
                  className="!size-3.5 shrink-0"
                />
              )}
              {!compare.active && (
                <span className="max-w-[120px] truncate text-[12.5px] text-foreground/90 @max-[400px]:max-w-[96px]">
                  {currentModelName}
                </span>
              )}
              {!isLmStudio && !compare.active && (
                <>
                  {/* The same stepped level icon as the Reasoning row; it
                      stays when a narrow column hides the label. */}
                  <ReasoningLevelIcon
                    options={buildThinkingOptions()}
                    mode={thinkingMode}
                    className="size-3.5"
                  />
                  <span
                    className={cn(
                      "text-[12.5px] @max-[400px]:hidden",
                      reasoningColorClass(thinkingMode)
                    )}
                  >
                    {thinkingLabel}
                  </span>
                </>
              )}
              <ChevronDownIcon className="size-3.5 text-muted-foreground/60" />
            </PromptInputButton>
          }
          className="min-w-[240px] p-1"
        >
          {/* Codex-style rows (#59): 13px label, grey value right, roomy
              36px rows. */}
          <SimpleDropdownSub
            triggerClassName="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
            trigger={
              <>
                {currentProvider ? (
                  <ProviderIcon
                    provider={currentModelIconProvider ?? currentProvider}
                    className="!size-4 shrink-0"
                  />
                ) : (
                  <TerminalIcon aria-hidden="true" className="size-5" />
                )}
                <span className="flex-1">Model</span>
                <span className="mr-1 max-w-[120px] truncate text-[11px] text-muted-foreground">
                  {compare.active
                    ? `${compare.models.length} models`
                    : currentModelName}
                </span>
              </>
            }
            className="max-h-[300px] min-w-[210px]"
          >
            {renderModelItems()}
            <ComposerCompareHint compare={compare} />
          </SimpleDropdownSub>

          {/* While comparing, each model gets its own reasoning row. */}
          <ComposerCompareMenuRows compare={compare} />
          {!isLmStudio && !compare.active && (
            <SimpleDropdownSub
              triggerClassName="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
              trigger={
                <>
                  <ReasoningLevelIcon
                    options={buildThinkingOptions()}
                    mode={thinkingMode}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1">Reasoning</span>
                  <span
                    className={cn(
                      "mr-1 text-[11px] font-medium",
                      reasoningColorClass(thinkingMode)
                    )}
                  >
                    {thinkingLabel}
                  </span>
                </>
              }
              className="min-w-[258px]"
            >
              {renderThinkingItems()}
            </SimpleDropdownSub>
          )}

          {showFastMode && (
            <SimpleDropdownSub
              triggerClassName="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
              trigger={
                <>
                  <HugeiconsIcon
                    icon={FlashHugeIcon}
                    strokeWidth={1.75}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1">Speed</span>
                  <span className="mr-1 text-[11px] text-muted-foreground">
                    {fastMode ? "Fast" : "Standard"}
                  </span>
                </>
              }
              className="min-w-[200px]"
            >
              <SimpleDropdownSubItem
                keepOpen
                onClick={() => setFastMode(true)}
                active={fastMode}
              >
                <ZapIcon
                  className="size-3.5 text-foreground"
                  strokeWidth={2}
                  fill={fastMode ? "currentColor" : "none"}
                />
                <div className="flex flex-1 flex-col">
                  <span className="text-xs">Fast</span>
                  <span className="text-[10px] text-muted-foreground">
                    {providerKey === "codex"
                      ? "OpenAI priority compute — faster responses, costs 1.5× more."
                      : "Priority compute — faster responses, costs 1.5× more."}
                  </span>
                </div>
                {fastMode && <CheckIcon className="size-3 text-primary" />}
              </SimpleDropdownSubItem>
              <SimpleDropdownSubItem
                keepOpen
                onClick={() => setFastMode(false)}
                active={!fastMode}
              >
                <ZapIcon
                  className="size-3.5 text-muted-foreground/60"
                  strokeWidth={2}
                />
                <div className="flex flex-1 flex-col">
                  <span className="text-xs">Standard</span>
                  <span className="text-[10px] text-muted-foreground">
                    Default routing at standard cost.
                  </span>
                </div>
                {!fastMode && <CheckIcon className="size-3 text-primary" />}
              </SimpleDropdownSubItem>
            </SimpleDropdownSub>
          )}
        </SimpleDropdown>

        <div className="contents @max-[300px]:hidden">
          <ComposerContextMeter
            threadId={threadId}
            currentProvider={currentProvider}
            selectedModel={selectedModel}
            providers={providers}
          />
        </div>

        {!hideSubmit && (
          <>
            <VoiceInputControl
              isRecording={deepgram.isRecording}
              voiceSetupComplete={voiceSetupComplete}
              size="icon-sm"
              onClick={() => handleVoiceClick(threadId)}
              onContextMenu={handleVoiceContextMenu}
            />
            <ComposerSubmit
              status={isStreaming ? "streaming" : undefined}
              onStop={handleStop}
              provider={selectedProvider}
              size={planFollowUpActive && !isStreaming ? "sm" : "icon-xs"}
              className={cn(
                "rounded-full",
                planFollowUpActive && !isStreaming
                  ? "h-8 px-3.5 text-[13px] font-medium"
                  : "size-8"
              )}
            >
              {isStreaming ? undefined : planFollowUpActive ? (
                planFollowUpLabel
              ) : (
                <ArrowUpIcon className="size-4" strokeWidth={2} />
              )}
            </ComposerSubmit>
          </>
        )}
      </div>
    </div>
  )
}
