import { useState } from "react"
import { Slider as SliderPrimitive } from "radix-ui"
import { RotateCcwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  isThinkingModeOptionActive,
  type ModelThinkingOption,
} from "@/lib/model-capabilities"

/** The preference default (`preferences-store`) the reset control returns to. */
export const DEFAULT_THINKING_MODE = "High"

/** One line under the level name so the ladder reads as more than a number. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  // 9Router: the model decides how long to think (adaptive thinking).
  auto: "Model sets its own depth",
  off: "No extended thinking",
  noreasoning: "No extended thinking",
  minimal: "Barely any thinking",
  low: "Quick answers",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Very thorough",
  max: "Longest thinking",
  ultrathink: "Longest thinking",
  ultracode: "Multi-agent orchestration",
}

function modeKey(mode: string | null): string {
  return mode ? mode.toLowerCase().replace(/[^a-z0-9]/g, "") : "off"
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
 * The reasoning-effort picker as a slider: the chosen level and what it
 * means on top, a reset to the preference default on the right, one stop per
 * level along the track. Replaces the seven-row list, which took a whole
 * flyout to answer "how hard should it think".
 *
 * The level applies on release (or on an arrow key), not on every pixel of a
 * drag, so a drag across five stops is one preference write, not five.
 */
export function ThinkingEffortSlider({
  options,
  thinkingMode,
  defaultMode = DEFAULT_THINKING_MODE,
  onSelect,
  className,
}: {
  options: ReadonlyArray<ModelThinkingOption>
  thinkingMode: string | null
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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const shownIndex = previewIndex ?? selectedIndex
  const shown = options[shownIndex] ?? options[0]
  if (!shown) return null
  const max = Math.max(0, options.length - 1)
  const isUltraThink = /ultra ?think/iu.test(shown.mode ?? "")
  const resetTarget = defaultIndex >= 0 ? options[defaultIndex] : undefined
  const canReset = resetTarget !== undefined && defaultIndex !== selectedIndex

  return (
    <div
      role="group"
      aria-label="Reasoning effort"
      className={cn("w-[240px] px-3.5 pt-2.5 pb-3.5", className)}
      // The menus around this control move focus with the arrow keys; the
      // slider needs them for itself.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        {/* Mirrors the reset button so the title sits on the true centre. */}
        {resetTarget && <span aria-hidden="true" className="size-6 shrink-0" />}
        <div className="min-w-0 flex-1 text-center">
          <div
            aria-live="polite"
            className={cn(
              "truncate text-[14px] leading-5 font-semibold text-foreground",
              isUltraThink && "ultra-think-text"
            )}
          >
            {shown.label}
          </div>
          <div className="truncate text-[11px] leading-4 text-muted-foreground">
            {DESCRIPTIONS[modeKey(shown.mode)] ?? "Reasoning effort"}
          </div>
        </div>
        {resetTarget && (
          <button
            type="button"
            aria-label={`Reset to ${resetTarget.label}`}
            title={`Reset to ${resetTarget.label}`}
            disabled={!canReset}
            onClick={() => onSelect(resetTarget.mode)}
            className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.96] disabled:opacity-30 disabled:hover:bg-transparent disabled:active:scale-100"
          >
            <RotateCcwIcon className="size-3.5" strokeWidth={2} />
          </button>
        )}
      </div>
      <SliderPrimitive.Root
        aria-label="Reasoning effort"
        min={0}
        max={max}
        step={1}
        value={[shownIndex]}
        onValueChange={([index]) => setPreviewIndex(index ?? 0)}
        onValueCommit={([index]) => {
          setPreviewIndex(null)
          const next = options[index ?? 0]
          if (next) onSelect(next.mode)
        }}
        className="relative mt-3.5 flex h-6 w-full touch-none items-center select-none"
      >
        {/* Filled up to the thumb; the stops still ahead sit on the rest of
            the track, as on a hardware slider. */}
        <SliderPrimitive.Track className="relative h-2 grow rounded-full bg-foreground/12">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-primary" />
          {options.map((option, index) =>
            index > shownIndex ? (
              <span
                key={`${option.mode ?? "off"}:${index}`}
                aria-hidden="true"
                data-slot="effort-stop"
                className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40"
                style={{ left: `${max === 0 ? 50 : (index / max) * 100}%` }}
              />
            ) : null
          )}
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-valuetext={shown.label}
          className="block size-5 cursor-grab rounded-full bg-primary shadow-[0_1px_3px_rgb(0_0_0/0.45)] ring-[3px] ring-popover transition-[box-shadow] duration-150 outline-none hover:ring-ring/40 focus-visible:ring-ring/60 active:cursor-grabbing"
        />
      </SliderPrimitive.Root>
    </div>
  )
}
