/**
 * Full-mode footer for the chat composer.
 *
 * Renders the expanded toolbar with individual DropdownMenu pickers for
 * Mode, Thinking, Model (with favourites + context-window),
 * the Autonomous-mode popover, and voice / submit controls.
 *
 * Extracted from `chat-composer.tsx` to keep the main file under 500 LOC.
 */

import React, { useMemo } from "react"
import { cn } from "@/lib/utils"
import { chatModeLabel } from "@/lib/chat-mode-labels"
import type { ComposerFooterProps } from "./chat-composer-types"
import { ComposerOrchestrationMenu } from "./composer-orchestration"
import {
  SimpleDropdown,
  SimpleDropdownSubItem,
  SimpleDropdownSeparator,
} from "@/components/ui/simple-dropdown"
import { ProviderIcon } from "@/components/provider-icon"
import { SimpleContextIndicator } from "@/components/chat/simple-context-indicator"
import { VoiceInputControl } from "@/components/chat/voice-input-control"
import { ComposerSubmit } from "@/components/chat/composer-submit"
import { ModelSearchMenuList } from "@/components/chat/model-search-submenu"
import { pickerShowsModelSearch } from "@/lib/model-picker-search"
import { mapSortedModelsByProvider } from "@/lib/model-ordering"
import {
  PERMISSION_LEVELS,
  BYPASS_CONFIRM_TITLE,
  BYPASS_CONFIRM_BODY,
  permissionLevelLabel,
  type PermissionLevelOption,
} from "@/components/chat/composer-mode-tables"
import { applyPermissionModeLive } from "@/lib/permission-mode-live"
import { PermissionMenuRow } from "@/components/chat/permission-menu-row"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { supportsModelContextWindow } from "@/lib/model-capabilities"
import { resolveProviderModelSwitchSelection } from "@/lib/provider-model-selection"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import {
  PromptInputTools,
  PromptInputButton,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CheckIcon,
  PlusIcon,
  PaperclipIcon,
  ChevronDownIcon,
  InfinityIcon,
  StarIcon,
  LockIcon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  isProviderUnconfigured,
  resolveProviderSetupHint,
} from "@/lib/provider-status-hint"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BotIcon,
  ClipboardIcon,
  ChatBotIcon,
  ShieldKeyIcon,
} from "@hugeicons/core-free-icons"

export function ComposerFullFooter(props: ComposerFooterProps) {
  const confirm = useConfirm()
  const {
    handleStop,
    handleVoiceClick,
    threadId,
    handleVoiceContextMenu,
    thinkingMode,
    setThinkingMode,
    chatMode,
    setChatMode,
    autonomousMode,
    autonomousStatus,
    permissionLevel,
    setPermissionLevel,
    setContextWindow,
    selectedProvider,
    selectedProviderId,
    selectedModel,
    setSelectedModel,
    setSelectedProviderId,
    providers,
    favoriteEntries,
    toggleFavorite,
    isFavorite,
    isStreaming,
    modelPickerOpen,
    setModelPickerOpen,
    planFollowUpActive: hasPendingPlan,
    hideSubmit,
    voiceSetupComplete,
    deepgram,
    setVoiceModalOpen,
    setAutonomousDialogOpen,
  } = props
  const promptInput = usePromptInputController()
  const planFollowUpActive =
    hasPendingPlan &&
    !/^\/goal(?:\s|$)/i.test(promptInput.textInput.value.trim())
  const planFollowUpLabel =
    planFollowUpActive && promptInput.textInput.value.trim().length > 0
      ? "Refine"
      : "Implement"

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
        : "Multiagent"
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
    <>
      <PromptInputTools>
        <SimpleContextIndicator threadId={threadId ?? null} />

        <SimpleDropdown
          align="start"
          trigger={
            <PromptInputButton
              tooltip="Add"
              aria-label="Add"
              className="relative"
            >
              <PlusIcon className="size-3.5" />
              {promptInput.attachments.files.length > 0 && (
                <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-semibold text-primary-foreground tabular-nums">
                  {Math.min(promptInput.attachments.files.length, 9)}
                </span>
              )}
            </PromptInputButton>
          }
        >
          <SimpleDropdownSubItem
            onClick={() => promptInput.attachments.openFileDialog()}
          >
            <PaperclipIcon className="size-3.5" /> Files and folders
          </SimpleDropdownSubItem>
          <SimpleDropdownSeparator />
          <ComposerOrchestrationMenu {...props} />
        </SimpleDropdown>

        {/* Permissions moved out of this "More options" menu and into the
            input row beside the Mode chip: how far an agent may act on its own
            is decided as often as which mode it runs in, and it was two clicks
            deep with no sign of the current setting. The menu held nothing
            else, so it is gone. */}

        {/* Autonomous Work — opens the dedicated dialog (task list +
            iteration / time budget). All run controls live in the
            AutonomousStatusBar once a run is armed. */}
        <PromptInputButton
          tooltip="Autonomous Work"
          onClick={() => setAutonomousDialogOpen(true)}
          className={cn(
            autonomousMode &&
              autonomousStatus === "working" &&
              "animate-pulse bg-primary/10 text-primary"
          )}
        >
          <InfinityIcon className="size-3.5" />
          <span className="text-xs">Autonomous</span>
        </PromptInputButton>

        {/* Multiagent dropdown temporarily hidden from the composer per
            request — remove the "hidden" class below to restore it. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PromptInputButton
              tooltip="Multiagent"
              className={cn(
                "hidden",
                multiAgentRunning && "text-emerald-400",
                multiAgentPaused && "text-amber-400"
              )}
            >
              <HugeiconsIcon
                icon={BotIcon}
                strokeWidth={2}
                className="size-3.5"
              />
              <span className="text-xs">{multiAgentLabel}</span>
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </PromptInputButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[260px]">
            <DropdownMenuItem
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
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <GitBranchIcon className="size-3.5" />
              <div className="flex flex-1 flex-col">
                <span className="text-xs">Isolated worktrees</span>
                <span className="text-[10px] text-muted-foreground">
                  One git worktree and branch per agent.
                </span>
              </div>
            </DropdownMenuItem>
            {multiAgentActive && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>
                  <span className="size-2 rounded-full bg-emerald-400" />
                  <div className="flex flex-1 flex-col">
                    <span className="text-xs capitalize">
                      {multiAgentSession?.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {multiAgentWorkingCount} active · {multiAgentCount} agents
                    </span>
                  </div>
                </DropdownMenuItem>
                {multiAgentRunning && (
                  <DropdownMenuItem
                    onClick={() => useMultiAgentStore.getState().pauseSession()}
                  >
                    <PauseIcon className="size-3.5" />
                    <span className="flex-1">Pause swarm</span>
                  </DropdownMenuItem>
                )}
                {multiAgentPaused && (
                  <DropdownMenuItem onClick={resumeMultiAgent}>
                    <PlayIcon className="size-3.5" />
                    <span className="flex-1">Resume swarm</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => useMultiAgentStore.getState().cancelSession()}
                >
                  <SquareIcon className="size-3.5 text-destructive" />
                  <span className="flex-1 text-destructive">Stop swarm</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* The Mode picker is gone: Agent is the default, and Plan is reached
            with Shift+Tab instead of a dropdown. The "/ask" slash command still
            switches a thread to read-only ask mode.

            What stays is an indicator for any mode that is NOT the default.
            Without it, Shift+Tab would put the thread into a state with no
            sign it happened and no way back except the same hidden shortcut.
            Clicking returns to Agent. */}
        {/* Permissions sits beside Mode: the two are chosen together — which
            mode the agent runs in, and how far it may act without asking. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PromptInputButton
              tooltip="Permissions"
              className={cn(permissionLevel === "bypass" && "text-destructive")}
            >
              <HugeiconsIcon
                icon={ShieldKeyIcon}
                strokeWidth={2}
                className={cn(
                  "size-3.5",
                  permissionLevel === "bypass" && "text-destructive"
                )}
              />
              <span className="text-xs">
                {permissionLevelLabel(permissionLevel)}
              </span>
            </PromptInputButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[310px] p-1">
            {PERMISSION_LEVELS.map((option) => (
              <DropdownMenuItem
                key={option.id}
                className="items-start gap-2.5 rounded-lg px-2.5 py-2"
                onClick={() => void choosePermission(option.id)}
              >
                <PermissionMenuRow
                  option={option}
                  active={permissionLevel === option.id}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {chatMode !== "agent" && (
          <PromptInputButton
            tooltip={{
              content: `${chatModeLabel(chatMode)} mode`,
              shortcut: "⇧ Tab",
            }}
            onClick={() => setChatMode("agent")}
            className={cn(
              chatMode === "plan" ? "text-sky-400" : "text-red-400"
            )}
          >
            <HugeiconsIcon
              icon={chatMode === "plan" ? ClipboardIcon : ChatBotIcon}
              strokeWidth={2}
              className="size-3.5"
            />
            <span className="text-xs">{chatModeLabel(chatMode)}</span>
          </PromptInputButton>
        )}

        {/* No context-window selector: the context is pinned to the model's
            maximum ("1m") in use-app-preferences.ts. */}

        {/* Full model picker modal — kept as an invisible DropdownMenu so
            the inline trigger's "Browse all models..." escape hatch can open
            it via `setModelPickerOpen(true)`. The visible trigger has been
            replaced by the compact inline chip overlaying the textarea.
            Trigger is sized zero (NOT display:none) so Radix still has a
            DOM anchor for positioning the content — anchored to the
            top-right of the footer, which puts the popup roughly under
            the inline chip's location. */}
        <DropdownMenu open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
          <DropdownMenuTrigger
            className="pointer-events-none absolute top-0 right-0 size-0 overflow-hidden opacity-0"
            aria-hidden="true"
            tabIndex={-1}
          />
          <DropdownMenuContent
            align="end"
            side="top"
            collisionPadding={12}
            className="max-h-[min(480px,calc(100vh-24px))] w-64 max-w-[calc(100vw-16px)] overflow-y-auto p-1"
          >
            {/* Favorites section */}
            {favoriteEntries.length > 0 && (
              <>
                <div className="px-2 py-1 text-[9px] font-medium text-muted-foreground">
                  Favorites
                </div>
                {favoriteEntries.map((fav) => {
                  const p = fav.provider
                  const m = fav.model
                  const isSel =
                    selectedProviderId === p.id && selectedModel === m.id
                  return (
                    <DropdownMenuItem
                      key={fav.key}
                      onClick={() => {
                        selectProviderModel(p, m.id)
                      }}
                      className={cn("gap-2", isSel && "bg-accent")}
                    >
                      <ProviderIcon provider={p} />
                      <span
                        className={cn(
                          "flex-1 text-sm",
                          isSel && "font-semibold"
                        )}
                      >
                        {m.name}
                      </span>
                      <span className="text-[9px] text-muted-foreground">
                        {m.context}
                      </span>
                      {isSel && <CheckIcon className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  )
                })}
                <DropdownMenuSeparator />
              </>
            )}
            {providers.map((provider, _pIdx) => {
              // `configured === false` ⇒ backend reported the provider as
              // unset (no API key, no logged-in CLI, no running local
              // server). `undefined` ⇒ status not yet fetched — leave
              // enabled so we don't flash disabled UI on first paint.
              const isProviderDisabled = isProviderUnconfigured(provider)
              const setupTooltip = resolveProviderSetupHint(provider)
              if (
                provider.models.length === 0 &&
                !pickerShowsModelSearch(provider)
              ) {
                return (
                  <DropdownMenuItem
                    key={provider.id}
                    className="gap-2 text-muted-foreground"
                    disabled
                  >
                    <ProviderIcon provider={provider} />
                    <span className="flex-1">{provider.name}</span>
                    <span className="text-[9px]">No models</span>
                  </DropdownMenuItem>
                )
              }
              if (isProviderDisabled) {
                // Render a non-expandable, disabled, tooltip-wrapped row
                // so the user can see WHY the entry is greyed out without
                // navigating into a sub-menu they can't act on.
                return (
                  <TooltipProvider key={provider.id} delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuItem
                          disabled
                          className="cursor-not-allowed gap-2 opacity-50"
                        >
                          <ProviderIcon
                            provider={provider}
                            className="grayscale"
                          />
                          <span className="flex-1">{provider.name}</span>
                          <LockIcon className="size-3.5 text-muted-foreground" />
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {setupTooltip}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )
              }
              return (
                <DropdownMenuSub key={provider.id}>
                  <DropdownMenuSubTrigger className="gap-2">
                    <ProviderIcon provider={provider} />
                    <span className="flex-1">{provider.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {provider.models.length}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className="w-64 max-w-[calc(100vw-16px)] p-1"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <ModelSearchMenuList
                      provider={provider}
                      models={
                        sortedModelsByProviderId.get(provider.id) ??
                        provider.models
                      }
                      onSelect={(modelId) =>
                        selectProviderModel(provider, modelId)
                      }
                      renderModel={(model) => {
                        const isSelected =
                          selectedProviderId === provider.id &&
                          selectedModel === model.id
                        // Context window is pinned to the model's maximum —
                        // no per-model 1M/200k submenu, the row selects directly.
                        const contextLabel = supportsModelContextWindow(
                          provider,
                          model.id
                        )
                          ? "1M"
                          : model.context
                        return (
                          <DropdownMenuItem
                            key={model.id}
                            onClick={() => {
                              selectProviderModel(provider, model.id)
                            }}
                            className={cn("gap-2.5", isSelected && "bg-accent")}
                          >
                            <ProviderIcon provider={provider} />
                            <div className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  "block text-sm",
                                  isSelected && "font-semibold"
                                )}
                              >
                                {model.name}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {model.tier} · {contextLabel}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleFavorite(provider.id, model.id)
                              }}
                              className="shrink-0 p-0.5 text-muted-foreground/30 transition-colors hover:text-foreground"
                            >
                              <StarIcon
                                className={cn(
                                  "size-3.5",
                                  isFavorite(provider.id, model.id) &&
                                    "fill-current text-foreground"
                                )}
                              />
                            </button>
                            {isSelected && (
                              <CheckIcon className="size-3.5 shrink-0 text-primary" />
                            )}
                          </DropdownMenuItem>
                        )
                      }}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </PromptInputTools>

      {!hideSubmit && (
        <div className="flex items-center gap-2">
          <VoiceInputControl
            isRecording={deepgram.isRecording}
            voiceSetupComplete={voiceSetupComplete}
            onClick={() => handleVoiceClick(threadId)}
            onContextMenu={handleVoiceContextMenu}
            onOpenSettings={() => setVoiceModalOpen(true)}
          />
          <ComposerSubmit
            status={isStreaming ? "streaming" : undefined}
            onStop={handleStop}
            size={planFollowUpActive && !isStreaming ? "sm" : "icon-sm"}
            className={cn(
              planFollowUpActive && !isStreaming && "rounded-full px-4"
            )}
          >
            {isStreaming
              ? undefined
              : planFollowUpActive
                ? planFollowUpLabel
                : undefined}
          </ComposerSubmit>
        </div>
      )}
    </>
  )
}
