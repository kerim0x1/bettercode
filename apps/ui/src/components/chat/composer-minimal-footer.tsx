/**
 * Minimal-mode footer for the chat composer — Codex-desktop-style layout:
 *
 *   [+] [permissions ▾]                 [⚡ model · reasoning ▾] [mic] [⬆]
 *
 * - "+" menu: Files and folders, plus experimental orchestration.
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
import { ProviderIcon } from "@/components/provider-icon"
import { mapSortedModelsByProvider } from "@/lib/model-ordering"
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
import { ModelSearchSubmenu } from "@/components/chat/model-search-submenu"
import { pickerShowsModelSearch } from "@/lib/model-picker-search"
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
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrainIcon,
  // The model row used to show a generic cube, which reads as "package"; a
  // chip names the engine. The speed row is a lightning bolt by the user's
  // choice: the Fast option inside fills its bolt when active, so the outline
  // on the row still reads as the axis rather than the value.
  AiChipIcon,
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
    selectedProviderId,
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
          {provider.models.length === 0 && !pickerShowsModelSearch(provider) ? (
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
            <ModelSearchSubmenu
              provider={provider}
              models={
                sortedModelsByProviderId.get(provider.id) ?? provider.models
              }
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              onSelect={(modelId) => selectProviderModel(provider, modelId)}
            />
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
        {/* ── "+" menu — Files and folders + Orchestration ── */}
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

            <SimpleDropdownSeparator />
            <ComposerOrchestrationMenu {...props} />

            {/* Permissions used to be a submenu here. It now sits beside the
                Mode chip in the input row — how an agent is allowed to act is
                decided as often as which mode it runs in, and it was two
                clicks deep with no indication of the current setting. */}
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
        <div className="order-2">
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
                  it only mounts while Fast Mode is actually on (#60). */}
              {showFastMode && fastMode && (
                <ZapIcon className="size-4" strokeWidth={2} />
              )}
              {currentProvider && (
                <ProviderIcon
                  provider={currentProvider}
                  className="!size-3.5 shrink-0"
                />
              )}
              <span className="max-w-[120px] truncate text-[12.5px] text-foreground/90 @max-[400px]:max-w-[96px]">
                {currentModelName}
              </span>
              {!isLmStudio && (
                <span className="text-[12.5px] text-muted-foreground/70 @max-[400px]:hidden">
                  {thinkingLabel}
                </span>
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
                <HugeiconsIcon
                  icon={AiChipIcon}
                  strokeWidth={1.75}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex-1">Model</span>
                <span className="mr-1 max-w-[120px] truncate text-[11px] text-muted-foreground">
                  {currentModelName}
                </span>
              </>
            }
            className="max-h-[300px] min-w-[210px]"
          >
            {renderModelItems()}
          </SimpleDropdownSub>

          {!isLmStudio && (
            <SimpleDropdownSub
              triggerClassName="min-h-8 gap-2.5 rounded-lg px-2.5 text-[12px]"
              trigger={
                <>
                  <HugeiconsIcon
                    icon={AiBrainIcon}
                    strokeWidth={1.75}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1">Reasoning</span>
                  <span className="mr-1 text-[11px] text-muted-foreground">
                    {thinkingLabel}
                  </span>
                </>
              }
              className="min-w-[256px]"
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
