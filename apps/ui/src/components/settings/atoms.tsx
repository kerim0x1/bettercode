import type React from "react"
import { useId, useState } from "react"
import { ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

/**
 * Small presentational primitives used across the settings page.
 *
 * These don't own any state or data fetching — they just give every section
 * a consistent "card with title / rows with label+description" layout:
 * left-aligned, an optional icon column, the control at the row's end, and
 * a row that wraps its control under the text when the column is narrow.
 */

export function SettingsSection({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: React.ReactNode
  /** Shown before the title, e.g. a provider logo. */
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-label={title}>
      <h4 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {icon}
        {title}
      </h4>
      {description ? (
        <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-2.5 divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card/30">
        {children}
      </div>
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  icon,
  children,
  className,
}: {
  label: string
  description?: React.ReactNode
  /** A 16px icon or brand mark in a muted column before the label. */
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5",
        className
      )}
    >
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
        {icon ? (
          <span
            aria-hidden="true"
            className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description ? (
            <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  )
}

/** A − value + stepper for small whole-number sizes such as font sizes. */
export function SettingsStepper({
  label,
  value,
  min,
  max,
  unit = "px",
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  onChange: (value: number) => void
}) {
  const buttonClass =
    "grid h-full w-8 place-items-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-border/70"
    >
      <button
        type="button"
        aria-label={`Smaller ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={buttonClass}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span
        aria-live="polite"
        className="grid h-full min-w-[56px] place-items-center border-x border-border/70 px-2 text-[12.5px] font-medium tabular-nums"
      >
        {value}
        {unit}
      </span>
      <button
        type="button"
        aria-label={`Larger ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={buttonClass}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  )
}

/** A slider with its current value, for ranges like a width in px. */
export function SettingsSlider({
  label,
  min,
  max,
  step,
  value,
  unit,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div className="flex w-[240px] shrink-0 items-center gap-3">
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
        className="flex-1"
      />
      <span className="w-14 text-right text-[12.5px] text-muted-foreground tabular-nums">
        {value}
        {unit}
      </span>
    </div>
  )
}

/**
 * A card that opens, for lists of providers or setups: a header row with an
 * icon (the caller's tile), the label with optional chips, a one-line
 * summary, header actions and a chevron, and a body that starts closed.
 */
export function SettingsDisclosure({
  label,
  icon,
  meta,
  summary,
  actions,
  defaultOpen = false,
  bodyClassName,
  children,
}: {
  label: string
  /** Rendered as is before the label, e.g. a 36px logo tile. */
  icon?: React.ReactNode
  /** Chips and status after the label. */
  meta?: React.ReactNode
  summary?: React.ReactNode
  /** Controls on the header row, e.g. a switch. */
  actions?: React.ReactNode
  defaultOpen?: boolean
  bodyClassName?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <article
      aria-label={label}
      className={cn(
        "overflow-hidden rounded-xl border bg-card/30 transition-colors duration-150",
        open ? "border-border/70" : "border-border/50"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {icon}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {label}
            </span>
            {meta}
          </span>
          {summary ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {summary}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <button
            type="button"
            aria-label={open ? `Close ${label}` : `Open ${label}`}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
            className="ml-1 grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform duration-150",
                open && "rotate-180"
              )}
            />
          </button>
        </div>
      </div>
      {open ? (
        <div
          id={bodyId}
          className={cn(
            "border-t border-border/40 bg-foreground/[0.015]",
            bodyClassName ?? "divide-y divide-border/50"
          )}
        >
          {children}
        </div>
      ) : null}
    </article>
  )
}
