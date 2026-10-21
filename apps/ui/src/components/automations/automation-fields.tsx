import { useRef, type KeyboardEvent, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Inputs in the automation editor: compact, at the settings text size. */
export const FIELD_INPUT =
  "h-8 rounded-lg border-border/50 bg-background/50 px-2.5 text-[12px] md:text-[12px] dark:bg-input/30"

/** Select triggers sized like `FIELD_INPUT`. */
export const FIELD_SELECT =
  "h-8 w-full rounded-lg border-border/50 bg-background/50 px-2.5 text-[12px] data-[size=default]:h-8 dark:bg-input/30"

/**
 * One labelled field: an 11px label above the control, a 10.5px hint or a
 * destructive error below it. `htmlFor` names a single control; a group of
 * controls passes `group` and gets `role="group"` with the label.
 */
export function AutomationField({
  label,
  htmlFor,
  labelId,
  group = false,
  hint,
  error,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  labelId?: string
  group?: boolean
  hint?: ReactNode
  error?: string
  className?: string
  children: ReactNode
}) {
  const body = (
    <>
      {children}
      {error ? (
        <span
          role="alert"
          className="text-[11px] leading-snug text-destructive"
        >
          {error}
        </span>
      ) : hint ? (
        <span className="text-[10.5px] leading-snug text-muted-foreground/75">
          {hint}
        </span>
      ) : null}
    </>
  )
  return group ? (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <span
        id={labelId}
        className="text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </span>
      {body}
    </div>
  ) : (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        id={labelId}
        className="text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </label>
      {body}
    </div>
  )
}

export interface SegmentOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly icon?: LucideIcon
}

/**
 * A segmented choice in Usage's well: a `radiogroup` whose arrow keys move
 * and select, with the active segment raised.
 */
export function AutomationSegments<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
}: {
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onChange: (value: T) => void
  ariaLabel?: string
  ariaLabelledBy?: string
  disabled?: boolean
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (step === 0 || disabled) return
    event.preventDefault()
    const next = (activeIndex + step + options.length) % options.length
    const option = options[next]
    if (!option) return
    onChange(option.value)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onKeyDown={move}
      className="flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-xl bg-foreground/[0.05] p-1"
    >
      {options.map((option, index) => {
        const active = index === activeIndex
        const Icon = option.icon
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50 motion-reduce:transition-none",
              active
                ? "bg-foreground/[0.08] font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon ? (
              <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            ) : null}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A titled block of the editor or the detail panel. */
export function AutomationSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}
