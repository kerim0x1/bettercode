import type React from "react"
import { cn } from "@/lib/utils"

/**
 * Small presentational primitives used across the settings modal.
 *
 * These don't own any state or data fetching — they just give every section
 * a consistent "card with title / rows with label+description" layout.
 */

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium text-muted-foreground">
        {title}
      </h4>
      {description ? (
        <p className="mb-2 text-[11px] text-muted-foreground/70">
          {description}
        </p>
      ) : null}
      <div className="space-y-1 divide-y divide-border/50 rounded-xl border border-border/50">
        {children}
      </div>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3",
        className
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  )
}
