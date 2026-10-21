import { Fragment, type ReactNode } from "react"
import { GlobeIcon } from "lucide-react"
import { SettingsDisclosure } from "@/components/settings/atoms"
import {
  PROVIDER_ACCESS_LABEL,
  providerBrand,
  type ProviderAccess,
} from "@/lib/provider-brand"
import { cn } from "@/lib/utils"

export type ProviderStatusTone = "ready" | "warning" | "muted" | "checking"

/**
 * A provider in Settings → Providers as a card that opens: the header shows
 * the brand mark in a tile, the name, a chip that says how it is reached
 * (CLI, API key, Local), its status and a one-line summary, plus optional
 * actions such as the enable switch. Its settings rows sit in the body,
 * which starts closed.
 */
export function ProviderCard({
  id,
  name,
  description,
  summary,
  access,
  status,
  actions,
  defaultOpen = false,
  children,
}: {
  id: string
  name: string
  description?: string
  /** One line under the name; the catalog description when left out. */
  summary?: ReactNode
  access: ProviderAccess
  status?: { label: string; tone: ProviderStatusTone } | null
  /** Controls on the header row, e.g. the enable switch. */
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <SettingsDisclosure
      label={name}
      icon={<ProviderLogo id={id} name={name} />}
      meta={
        <>
          <span
            className={cn(
              "shrink-0 rounded-[5px] border px-1.5 py-px text-[10px] leading-4 font-medium",
              access === "cli"
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/60 bg-muted/40 text-muted-foreground"
            )}
          >
            {PROVIDER_ACCESS_LABEL[access]}
          </span>
          {status ? <StatusPill {...status} /> : null}
        </>
      }
      summary={
        summary ?? (description ? <InlineCode text={description} /> : undefined)
      }
      actions={actions}
      defaultOpen={defaultOpen}
    >
      {children}
    </SettingsDisclosure>
  )
}

export function ProviderLogo({
  id,
  name,
  className,
}: {
  id: string
  name: string
  className?: string
}) {
  const brand = providerBrand(id)
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/[0.05]",
        className
      )}
    >
      {brand ? (
        <img
          src={brand.logo}
          alt={`${name} logo`}
          className={cn(
            "size-[18px] object-contain",
            brand.invertDark && "dark:invert"
          )}
        />
      ) : (
        <GlobeIcon
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
      )}
    </span>
  )
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: ProviderStatusTone
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          tone === "ready" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "muted" && "bg-muted-foreground/40",
          tone === "checking" &&
            "bg-muted-foreground/40 motion-safe:animate-pulse"
        )}
      />
      {label}
    </span>
  )
}

/** Catalog copy marks commands with backticks; show them as code. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split("`")
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={index}
            className="rounded bg-muted/60 px-1 py-px font-mono text-[10px] text-foreground/80"
          >
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        )
      )}
    </>
  )
}
