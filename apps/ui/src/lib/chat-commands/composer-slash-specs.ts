import {
  buildFavoriteModelCycleItems,
  buildModelCycleItems,
} from "@/lib/model-cycle"
import {
  applyModelAgentCycleCommand,
  applyModelCycleCommand,
  buildFavoriteToggleOutput,
} from "./model-actions"
import {
  type SlashCommandRun,
  type SlashCommandRunSpec,
  abortSlashRun,
} from "./slash-run"
import { betterC0deAgentSlashSubcommand } from "./slash-subcommands"

const CHAT_MODE_CYCLE = ["agent", "plan", "ask"] as const

function shouldOpenModelPickerForSlashCommand(
  command: string,
  args: readonly string[]
): boolean {
  if (command === "/models" && args.length > 0) return false
  return true
}

export function cycleChatMode(
  currentMode: string | null | undefined,
  direction: 1 | -1
): string {
  const currentIndex = CHAT_MODE_CYCLE.findIndex((mode) => mode === currentMode)
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : CHAT_MODE_CYCLE.length - 1
      : (currentIndex + direction + CHAT_MODE_CYCLE.length) %
        CHAT_MODE_CYCLE.length
  return CHAT_MODE_CYCLE[nextIndex] ?? "agent"
}

function buildChatModeCycleOutput(mode: string): string {
  const label =
    mode === "agent" ? "Agent" : mode[0]!.toUpperCase() + mode.slice(1)
  return `# Chat Mode\n\n${label} mode is active.`
}

/** Model picker, command palette, chat mode, agent, model and favorite cycling. */
export const COMPOSER_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    {
      names: [
        "model",
        "models",
        "model.choose",
        "model.list",
        "model-list",
        "model.dialog.provider",
        "model-dialog-provider",
      ],
      when: ({ cmd, args }) => shouldOpenModelPickerForSlashCommand(cmd, args),
      run: (run) => {
        const { openModelPicker, closeSlash } = run
        closeSlash()
        openModelPicker?.()
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "command-palette",
        "command.palette.show",
        "command-palette-show",
      ],
      run: (run) => {
        const { openCommandPalette, closeSlash } = run
        closeSlash()
        openCommandPalette?.()
        return abortSlashRun(run)
      },
    },
    {
      names: ["mode-next", "chat-mode-next"],
      run: (run) => {
        const { chatMode, setChatMode } = run
        const next = cycleChatMode(chatMode, 1)
        setChatMode(next)
        run.output = buildChatModeCycleOutput(next)
      },
    },
    {
      names: ["mode-previous", "chat-mode-previous"],
      run: (run) => {
        const { chatMode, setChatMode } = run
        const next = cycleChatMode(chatMode, -1)
        setChatMode(next)
        run.output = buildChatModeCycleOutput(next)
      },
    },
    {
      names: ["agent", "agent-next", "agent.cycle"],
      when: ({ cmd, args }) => !betterC0deAgentSlashSubcommand(cmd, args),
      run: (run) => {
        const { selectedProvider, selectedModel, threadId } = run
        run.output = applyModelAgentCycleCommand({
          threadId,
          provider: selectedProvider,
          selectedModel,
          direction: 1,
        })
      },
    },
    {
      names: ["agent-previous", "previous-agent", "agent.cycle.reverse"],
      run: (run) => {
        const { selectedProvider, selectedModel, threadId } = run
        run.output = applyModelAgentCycleCommand({
          threadId,
          provider: selectedProvider,
          selectedModel,
          direction: -1,
        })
      },
    },
    {
      names: ["model-next", "next-model", "model-cycle", "model.cycle_recent"],
      run: (run) => {
        const {
          selectedProvider,
          selectedProviderId,
          selectedModel,
          providers,
          setSelectedProviderId,
          setSelectedModel,
        } = run
        run.output = applyModelCycleCommand({
          items: buildModelCycleItems(providers),
          direction: 1,
          selectedProviderId: selectedProvider?.id ?? selectedProviderId,
          selectedModel,
          setSelectedProviderId,
          setSelectedModel,
          source: "model",
        })
      },
    },
    {
      names: [
        "model-previous",
        "previous-model",
        "prev-model",
        "model.cycle_recent_reverse",
      ],
      run: (run) => {
        const {
          selectedProvider,
          selectedProviderId,
          selectedModel,
          providers,
          setSelectedProviderId,
          setSelectedModel,
        } = run
        run.output = applyModelCycleCommand({
          items: buildModelCycleItems(providers),
          direction: -1,
          selectedProviderId: selectedProvider?.id ?? selectedProviderId,
          selectedModel,
          setSelectedProviderId,
          setSelectedModel,
          source: "model",
        })
      },
    },
    {
      names: [
        "favorite-next",
        "next-favorite",
        "favorite-model-next",
        "model.cycle_favorite",
      ],
      run: (run) => {
        const {
          selectedProvider,
          selectedProviderId,
          selectedModel,
          favoriteEntries,
          setSelectedProviderId,
          setSelectedModel,
        } = run
        run.output = applyModelCycleCommand({
          items: buildFavoriteModelCycleItems(favoriteEntries),
          direction: 1,
          selectedProviderId: selectedProvider?.id ?? selectedProviderId,
          selectedModel,
          setSelectedProviderId,
          setSelectedModel,
          source: "favorite",
        })
      },
    },
    {
      names: [
        "favorite-toggle",
        "model.dialog.favorite",
        "model-dialog-favorite",
      ],
      run: (run) => {
        const {
          selectedProvider,
          selectedProviderId,
          selectedModel,
          toggleFavorite,
          isFavorite,
        } = run
        run.output = buildFavoriteToggleOutput({
          providerId: selectedProvider?.id ?? selectedProviderId ?? null,
          modelId: selectedModel,
          toggleFavorite,
          isFavorite,
        })
      },
    },
    {
      names: [
        "favorite-previous",
        "previous-favorite",
        "prev-favorite",
        "favorite-model-previous",
        "model.cycle_favorite_reverse",
      ],
      run: (run) => {
        const {
          selectedProvider,
          selectedProviderId,
          selectedModel,
          favoriteEntries,
          setSelectedProviderId,
          setSelectedModel,
        } = run
        run.output = applyModelCycleCommand({
          items: buildFavoriteModelCycleItems(favoriteEntries),
          direction: -1,
          selectedProviderId: selectedProvider?.id ?? selectedProviderId,
          selectedModel,
          setSelectedProviderId,
          setSelectedModel,
          source: "favorite",
        })
      },
    },
  ]
