import { useRef, type KeyboardEvent, type MouseEvent } from "react"
import { CodeIcon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, ArtboardIcon } from "@hugeicons/core-free-icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type AppMode = "agent" | "editor" | "design"

/** Each mode's colour, worn by its icon while it is the active one. */
const MODES: ReadonlyArray<{ id: AppMode; label: string; tint: string }> = [
  { id: "agent", label: "Agent", tint: "text-violet-600 dark:text-violet-400" },
  { id: "editor", label: "Editor", tint: "text-sky-600 dark:text-sky-400" },
  { id: "design", label: "Canvas", tint: "text-rose-600 dark:text-rose-400" },
]

/**
 * The sidebar footer's Agent/Editor/Canvas switch: one click per mode
 * instead of a menu. A sunken well holds the three modes; the active one
 * sits on a raised card chip, its icon in the mode's colour, and opens to
 * show its name while the others stay muted icons. Below a 400px footer
 * (the footer is the size container) the name stays hidden so the account
 * name keeps its room. Arrow keys move between modes; right-click opens a
 * mode in a new window where the shell supports it.
 */
export function SidebarModeSwitch({
  mode,
  onSelect,
  onOpenWindow,
  windowHint,
  className,
}: {
  mode: AppMode
  onSelect: (mode: AppMode) => void
  onOpenWindow?: (event: MouseEvent, mode: AppMode) => void
  windowHint?: string
  className?: string
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const next = (index + step + MODES.length) % MODES.length
    buttons.current[next]?.focus()
    onSelect(MODES[next]!.id)
  }

  return (
    <div
      role="radiogroup"
      aria-label="App mode"
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-[10px] bg-black/[0.045] p-[3px] ring-1 ring-border/60 ring-inset dark:bg-black/25",
        className
      )}
    >
      {MODES.map((entry, index) => {
        const active = entry.id === mode
        return (
          <Tooltip key={entry.id}>
            <TooltipTrigger asChild>
              <button
                ref={(element) => {
                  buttons.current[index] = element
                }}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${entry.label} mode`}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(entry.id)}
                onContextMenu={
                  onOpenWindow
                    ? (event) => onOpenWindow(event, entry.id)
                    : undefined
                }
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  "flex h-6 shrink-0 items-center rounded-[7px] px-1.5 transition-[background-color,box-shadow,color,padding] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none motion-reduce:transition-none",
                  active
                    ? "bg-card pr-2.5 text-foreground shadow-sm ring-1 ring-border @max-[400px]:pr-1.5"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex transition-colors duration-200 motion-reduce:transition-none",
                    active && entry.tint
                  )}
                >
                  <ModeIcon mode={entry.id} />
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "overflow-hidden text-xs font-medium whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    active
                      ? "ml-1.5 max-w-16 opacity-100 @max-[400px]:ml-0 @max-[400px]:max-w-0 @max-[400px]:opacity-0"
                      : "ml-0 max-w-0 opacity-0"
                  )}
                >
                  {entry.label}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-center">
              {entry.label}
              {windowHint ? (
                <span className="block text-[10px] opacity-70">
                  {windowHint}
                </span>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** Agent is the AI sparkle, Editor the code brackets, Canvas the artboard. */
function ModeIcon({ mode }: { mode: AppMode }) {
  if (mode === "editor") return <CodeIcon className="size-3.5 shrink-0" />
  return (
    <HugeiconsIcon
      icon={mode === "design" ? ArtboardIcon : AiMagicIcon}
      strokeWidth={2}
      className="size-3.5 shrink-0"
    />
  )
}
