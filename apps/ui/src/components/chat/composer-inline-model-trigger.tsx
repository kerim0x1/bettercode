/**
 * Compact, single-trigger model picker that overlays the top-right of the
 * chat input area. Combines Model selection, Thinking level, and Fast Mode
 * toggle into one dropdown so the footer can stay focused on mode / submit
 * controls.
 *
 * The "Browse all models..." item is the escape hatch back into the full
 * picker modal (`setModelPickerOpen?.(true)`), so power users can still
 * reach the favourite-managing / provider-grouped picker that lives in
 * `composer-full-footer.tsx`.
 */

import { useMemo } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CheckIcon,
  ChevronDownIcon,
  BrainIcon,
  ZapIcon,
  LayersIcon,
} from "lucide-react"
import { ProviderIcon } from "@/components/provider-icon"
import { ThinkingEffortSlider } from "@/components/chat/thinking-effort-slider"
import { cn } from "@/lib/utils"
import {
  getModelThinkingOptions,
  supportsModelFastMode,
} from "@/lib/model-capabilities"
import {
  resolveDefaultProvider,
  resolveProviderModelSwitchSelection,
} from "@/lib/provider-model-selection"
import type { ComposerFooterProps } from "./chat-composer-types"

const MAX_RECENT_MODELS = 5

export function ComposerInlineModelTrigger(props: ComposerFooterProps) {
  const {
    threadId,
    thinkingMode,
    setThinkingMode,
    fastMode,
    setFastMode,
    currentModelName,
    selectedProvider,
    currentProvider,
    selectedProviderId,
    selectedModel,
    setSelectedModel,
    setSelectedProviderId,
    contextWindow,
    setContextWindow,
    providers,
    favoriteEntries,
    isLmStudio,
    setModelPickerOpen,
  } = props

  const triggerProvider = selectedProvider ?? resolveDefaultProvider(providers)
  const thinkingOptions = useMemo(
    () => getModelThinkingOptions(currentProvider, selectedModel),
    [currentProvider, selectedModel]
  )
  const fastModeSupported =
    Boolean(selectedModel) &&
    supportsModelFastMode(currentProvider, selectedModel)

  // Recent / favourites list: prefer the user's favourites; fall back to the
  // current provider's first few models so the menu is never empty.
  const recentEntries = useMemo(() => {
    if (favoriteEntries.length > 0) {
      return favoriteEntries.slice(0, MAX_RECENT_MODELS).map((fav) => ({
        key: fav.key,
        provider: fav.provider,
        model: fav.model,
      }))
    }
    const provider =
      currentProvider ?? selectedProvider ?? resolveDefaultProvider(providers)
    if (!provider) return []
    return provider.models.slice(0, MAX_RECENT_MODELS).map((model) => ({
      key: `${provider.id}:${model.id}`,
      provider,
      model,
    }))
  }, [favoriteEntries, currentProvider, selectedProvider, providers])

  const selectProviderModel = (
    provider: (typeof providers)[number],
    modelId: string
  ) => {
    const next = resolveProviderModelSwitchSelection({
      provider,
      modelId,
      thinkingMode,
      contextWindow,
    })
    setSelectedProviderId(next.providerId)
    setSelectedModel(next.modelId, next.providerId)
    setContextWindow(next.contextWindow, next.providerId)
    setThinkingMode(next.thinkingMode, next.providerId)
  }

  if (!triggerProvider) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 max-w-[200px] cursor-pointer items-center gap-1.5",
            "rounded-md border border-border/40 bg-card/60 px-2 text-[11px]",
            "text-foreground/80 transition-colors duration-75",
            "hover:border-border/70 hover:bg-card hover:text-foreground",
            "data-[state=open]:border-border data-[state=open]:bg-card",
            "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          )}
        >
          <ProviderIcon
            provider={triggerProvider}
            className={cn(
              "size-3.5 shrink-0",
              (triggerProvider.providerKind ?? triggerProvider.id) ===
                "openai" && "size-4"
            )}
          />
          <span className="max-w-[140px] truncate">{currentModelName}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-16px)] p-1.5"
      >
        <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5">
          <ProviderIcon
            provider={triggerProvider}
            className={cn(
              "size-4 shrink-0",
              (triggerProvider.providerKind ?? triggerProvider.id) ===
                "openai" && "size-[18px]"
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Model
            </div>
            <div className="truncate text-xs font-semibold text-foreground">
              {currentModelName}
            </div>
          </div>
        </div>

        {recentEntries.length > 0 && (
          <>
            <div className="mt-1 px-2 py-1 text-[10px] tracking-wide text-muted-foreground uppercase">
              {favoriteEntries.length > 0 ? "Favourites" : "Recent"}
            </div>
            {recentEntries.map(({ key, provider, model }) => {
              const isActive =
                selectedProviderId === provider.id && selectedModel === model.id
              return (
                <DropdownMenuItem
                  key={key}
                  onClick={() => selectProviderModel(provider, model.id)}
                  className={cn("gap-2", isActive && "bg-accent")}
                >
                  <ProviderIcon provider={provider} className="size-3.5" />
                  <span
                    className={cn(
                      "flex-1 truncate text-sm",
                      isActive && "font-semibold"
                    )}
                  >
                    {model.name}
                  </span>
                  {isActive && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              )
            })}
          </>
        )}

        {setModelPickerOpen && (
          <DropdownMenuItem
            onClick={() => setModelPickerOpen(true)}
            className="gap-2"
          >
            <LayersIcon className="size-3.5" />
            <span className="flex-1 text-sm">Browse all models...</span>
            <ChevronDownIcon className="size-3.5 -rotate-90 text-muted-foreground" />
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <div className="px-2 py-1 text-[10px] tracking-wide text-muted-foreground uppercase">
          Thinking
        </div>
        {isLmStudio ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <BrainIcon className="size-3.5 opacity-50" />
            <span>LM Studio handles reasoning</span>
          </div>
        ) : thinkingOptions.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <BrainIcon className="size-3.5 opacity-50" />
            <span>No thinking options for this model</span>
          </div>
        ) : (
          <ThinkingEffortSlider
            options={thinkingOptions}
            thinkingMode={thinkingMode}
            modelName={currentModelName}
            selectionKey={JSON.stringify([
              threadId,
              currentProvider?.id,
              selectedModel,
            ])}
            onSelect={(mode) => setThinkingMode(mode, currentProvider?.id)}
            className="w-full"
          />
        )}

        {fastModeSupported && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setFastMode(!fastMode)
              }}
              className="gap-2"
            >
              <ZapIcon
                className={cn(
                  "size-3.5",
                  fastMode ? "text-amber-400" : "text-muted-foreground"
                )}
                strokeWidth={2}
                fill={fastMode ? "currentColor" : "none"}
              />
              <span className="flex-1 text-sm">Fast mode</span>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  fastMode
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                    : "border-border/60 bg-muted/40 text-muted-foreground"
                )}
              >
                {fastMode ? "On" : "Off"}
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
