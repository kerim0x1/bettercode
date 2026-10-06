import { cn } from "@/lib/utils"
import { reasoningColorClass } from "@/lib/reasoning-appearance"
import {
  isThinkingModeOptionActive,
  type ModelThinkingOption,
} from "@/lib/model-capabilities"

/** Four ascending strokes, with the selected effort reflected in their fill. */
export function ReasoningLevelIcon({
  options,
  mode,
  className,
}: {
  options: ReadonlyArray<ModelThinkingOption>
  mode: string | null
  className?: string
}) {
  const index = options.findIndex((option) =>
    isThinkingModeOptionActive(mode, option.mode)
  )
  const active =
    mode && index >= 0
      ? Math.max(1, Math.ceil((index / Math.max(1, options.length - 1)) * 4))
      : 0

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={cn("size-5 shrink-0", reasoningColorClass(mode), className)}
    >
      {[6, 10, 14, 18].map((height, bar) => (
        <path
          key={height}
          d={`M${4.5 + bar * 5} 21v-${height}`}
          className={cn(
            "motion-safe:transition-opacity motion-safe:duration-150",
            bar >= active && "opacity-25"
          )}
        />
      ))}
    </svg>
  )
}
