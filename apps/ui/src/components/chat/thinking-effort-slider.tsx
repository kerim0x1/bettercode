import { useId, useState } from "react"
import { Slider as SliderPrimitive } from "radix-ui"
import { RotateCcwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ReasoningLevelIcon } from "@/components/chat/reasoning-level-icon"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import {
  isThinkingModeOptionActive,
  type ModelThinkingOption,
} from "@/lib/model-capabilities"
import { normalizeThinkingModeValue } from "@betterc0de/schema"

/** The preference default (`preferences-store`) the reset control returns to. */
export const DEFAULT_THINKING_MODE = "High"

/** Accessible explanation and hover hint for the selected level. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  auto: "Uses this model's default reasoning effort.",
  off: "No extended thinking. Responds directly.",
  none: "No extended thinking. Responds directly.",
  minimal: "Minimal reasoning for quick responses.",
  low: "Quick reasoning for straightforward tasks.",
  medium: "Balanced depth for everyday tasks.",
  high: "Thorough reasoning for complex problems.",
  xhigh: "Extra depth for difficult, multi-step problems.",
  max: "Maximum reasoning effort for the hardest tasks.",
  ultrathink: "Maximum reasoning effort for the hardest tasks.",
  ultra: "Extended reasoning at this model's highest effort.",
  ultracode: "Multi-agent orchestration for complex tasks.",
}

function modeKey(mode: string | null): string {
  return mode ? normalizeThinkingModeValue(mode) : "off"
}

/** Position of a mode on the ladder, or -1 when the ladder does not offer it. */
export function thinkingOptionIndex(
  options: ReadonlyArray<ModelThinkingOption>,
  mode: string | null
): number {
  return options.findIndex((option) =>
    isThinkingModeOptionActive(mode, option.mode)
  )
}

/**
 * Compact reasoning picker with the level and model centred above a stepped
 * pill slider. The menu's level icon and reset flank the header.
 *
 * The level applies on release (or on an arrow key), not on every pixel of a
 * drag, so a drag across five stops is one preference write, not five.
 */
export function ThinkingEffortSlider({
  options,
  thinkingMode,
  modelName,
  selectionKey,
  defaultMode = DEFAULT_THINKING_MODE,
  onSelect,
  className,
}: {
  options: ReadonlyArray<ModelThinkingOption>
  thinkingMode: string | null
  modelName?: string
  /** Resets a drag when the thread, provider, or model changes. */
  selectionKey?: string
  /** `null` disables the reset control. */
  defaultMode?: string | null
  onSelect: (mode: string | null) => void
  className?: string
}) {
  // A stored mode this ladder does not offer reads as Off rather than as an
  // empty header; `coerceThinkingModeForModel` steps it down on its own.
  const selectedIndex = Math.max(0, thinkingOptionIndex(options, thinkingMode))
  const defaultIndex =
    defaultMode === null ? -1 : thinkingOptionIndex(options, defaultMode)
  const contextKey = JSON.stringify([
    selectionKey ?? modelName,
    options.map((option) => option.mode),
  ])
  const [preview, setPreview] = useState({
    sourceMode: thinkingMode,
    contextKey,
    mode: thinkingMode,
  })
  const previewIsCurrent =
    preview.sourceMode === thinkingMode && preview.contextKey === contextKey
  // Reconcile before rendering, without remounting the focused slider. Keep
  // committed previews until the parent acknowledges them; clearing on commit
  // flashes the old value and conflicts with Radix's keyboard callback order.
  if (!previewIsCurrent) {
    setPreview({ sourceMode: thinkingMode, contextKey, mode: thinkingMode })
  }
  const descriptionId = useId()
  const shownIndex = previewIsCurrent
    ? Math.max(0, thinkingOptionIndex(options, preview.mode))
    : selectedIndex
  const shown = options[shownIndex] ?? options[0]
  if (!shown) return null
  const max = Math.max(0, options.length - 1)
  const levelColor = reasoningColorClass(shown.mode)
  const resetTarget = defaultIndex >= 0 ? options[defaultIndex] : undefined
  const canReset = resetTarget !== undefined && defaultIndex !== shownIndex
  const description =
    shown.label === "On"
      ? "Thinking is enabled for this model."
      : (DESCRIPTIONS[modeKey(shown.mode)] ??
        "Choose how deeply this model reasons through a task.")
  const showMode = (mode: string | null) => {
    setPreview({ sourceMode: thinkingMode, contextKey, mode })
  }
  const commitMode = (mode: string | null) => {
    showMode(mode)
    if (!isThinkingModeOptionActive(thinkingMode, mode)) onSelect(mode)
  }

  return (
    <div
      role="group"
      aria-label="Reasoning effort"
      className={cn("w-[252px] max-w-[calc(100vw-2rem)] p-2.5", className)}
      // The menus around this control move focus with the arrow keys; the
      // slider needs them for itself.
      onKeyDown={(event) => {
        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "PageUp",
            "PageDown",
          ].includes(event.key)
        )
          event.stopPropagation()
      }}
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-start gap-2">
        <span className="flex size-7 items-center justify-center">
          <ReasoningLevelIcon
            options={options}
            mode={shown.mode}
            className="size-6"
          />
        </span>
        <div className="min-w-0 text-center">
          <p
            aria-live="polite"
            title={description}
            className={cn(
              "truncate text-sm leading-[18px] font-semibold",
              levelColor
            )}
          >
            {shown.label}
          </p>
          <p
            title={modelName}
            className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground"
          >
            {modelName || "Reasoning effort"}
          </p>
        </div>
        {resetTarget && (
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={`Reset to ${resetTarget.label}`}
            title={`Reset to ${resetTarget.label}`}
            disabled={!canReset}
            onClick={() => commitMode(resetTarget.mode)}
            className="justify-self-center rounded-md text-muted-foreground motion-reduce:transition-none"
          >
            <RotateCcwIcon
              aria-hidden="true"
              className="size-3.5"
              strokeWidth={1.5}
            />
          </Button>
        )}
      </div>
      <p id={descriptionId} className="sr-only">
        {description}
      </p>

      {options.length > 1 ? (
        <SliderPrimitive.Root
          data-slot="reasoning-slider"
          aria-label="Reasoning effort"
          aria-describedby={descriptionId}
          min={0}
          max={max}
          step={1}
          value={[shownIndex]}
          onValueChange={([index]) => {
            const next = options[index ?? 0]
            if (next) showMode(next.mode)
          }}
          onValueCommit={([index]) => {
            const next = options[index ?? 0]
            if (next) commitMode(next.mode)
          }}
          onPointerCancel={() => showMode(thinkingMode)}
          className={cn(
            "relative mt-1.5 flex h-8 w-full touch-none items-center select-none",
            levelColor
          )}
        >
          <SliderPrimitive.Track className="relative h-6 grow overflow-hidden rounded-full bg-foreground/10">
            <SliderPrimitive.Range className="absolute h-full rounded-full bg-current" />
            {/* Match the stop centres to Radix's in-bounds 28px thumb. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3.5 left-3.5"
            >
              {options.map((option, index) => (
                <span
                  key={`${option.mode ?? "off"}:${index}`}
                  data-slot={index > shownIndex ? "effort-stop" : undefined}
                  className={cn(
                    "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    index < shownIndex ? "bg-background/50" : "bg-foreground/30"
                  )}
                  style={{ left: `${(index / max) * 100}%` }}
                />
              ))}
            </div>
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-label="Reasoning effort"
            aria-valuetext={shown.label}
            aria-describedby={descriptionId}
            className="block size-7 cursor-grab rounded-full border border-popover/10 bg-foreground shadow-sm outline-none hover:ring-4 hover:ring-ring/15 focus-visible:ring-4 focus-visible:ring-ring/40 active:cursor-grabbing motion-safe:transition-shadow motion-safe:duration-150"
          />
        </SliderPrimitive.Root>
      ) : (
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          One level available
        </p>
      )}
    </div>
  )
}
