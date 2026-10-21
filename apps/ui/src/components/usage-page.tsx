import { useEffect, useState } from "react"
import {
  ActivityIcon,
  ArrowLeftIcon,
  CoinsIcon,
  GaugeIcon,
  LayersIcon,
  RefreshCwIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { LimitsView } from "@/components/usage/limits-view"
import { UsageOverview } from "@/components/usage/usage-overview"
import { useUsageStore } from "@/lib/usage-store"
import { USAGE_RANGES, type UsageRangeId } from "@/lib/usage-overview"
import { cn } from "@/lib/utils"

export type UsageView = "cost" | "tokens" | "limits"

const VIEWS: ReadonlyArray<{ id: UsageView; label: string; icon: LucideIcon }> =
  [
    { id: "cost", label: "Cost", icon: CoinsIcon },
    { id: "tokens", label: "Tokens", icon: LayersIcon },
    { id: "limits", label: "Limits", icon: GaugeIcon },
  ]

const HEADER_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96] disabled:opacity-50"

/** How long ago something was read, so a stale page is obvious. */
function formatAge(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ""
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/**
 * Usage as a page in the main area: Cost and Tokens show what Claude Code
 * and Codex used, side by side, over a day range; Limits shows their live
 * limit windows. All three read the same `/usage/providers` reports.
 */
export function UsagePage({
  onClose,
  view = "cost",
  onViewChange,
}: {
  onClose: () => void
  view?: UsageView
  onViewChange?: (view: UsageView) => void
}) {
  const { reports, loading, error, load } = useUsageStore()
  const [localView, setLocalView] = useState<UsageView>(view)
  const [range, setRange] = useState<UsageRangeId>("30d")
  const active = onViewChange ? view : localView
  const setView = onViewChange ?? setLocalView

  useEffect(() => {
    void load()
  }, [load])

  const newest = reports.reduce(
    (best, report) => (report.fetchedAt > best ? report.fetchedAt : best),
    ""
  )

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-background px-3">
        <div className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Back to chat"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96]"
          >
            <ArrowLeftIcon className="size-3.5" strokeWidth={1.5} />
          </Button>
          <div className="flex items-center gap-2">
            <ActivityIcon
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.5}
            />
            <h1 className="text-[12px] font-medium">Usage</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            role="status"
            className="hidden text-[11px] text-muted-foreground sm:inline"
          >
            {loading
              ? reports.length > 0
                ? "Updating…"
                : "Reading local usage…"
              : newest
                ? `Updated ${formatAge(newest)}`
                : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            disabled={loading}
            className={HEADER_BUTTON}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "motion-safe:animate-spin")}
              strokeWidth={1.5}
            />
            Refresh
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
        <div className="@container/usage mx-auto flex w-full max-w-[1120px] flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
            <div
              role="tablist"
              aria-label="Usage view"
              className="flex items-center gap-0.5 rounded-xl bg-foreground/[0.05] p-1"
            >
              {VIEWS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active === item.id}
                  aria-controls="usage-view"
                  onClick={() => setView(item.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.96]",
                    active === item.id
                      ? "bg-foreground/[0.08] font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <item.icon
                    aria-hidden="true"
                    className="size-3.5"
                    strokeWidth={1.5}
                  />
                  {item.label}
                </button>
              ))}
            </div>
            {active !== "limits" && (
              <div
                role="group"
                aria-label="Day range"
                className="flex items-center gap-0.5 rounded-xl bg-foreground/[0.05] p-1"
              >
                {USAGE_RANGES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={range === item.id}
                    onClick={() => setRange(item.id)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[11px] tabular-nums transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.96]",
                      range === item.id
                        ? "bg-foreground/[0.08] font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-foreground"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void load(true)}
                disabled={loading}
                className="rounded-md text-[11px]"
              >
                Retry
              </Button>
            </div>
          )}

          <div id="usage-view" role="tabpanel" aria-label={active}>
            {active === "limits" ? (
              <LimitsView />
            ) : (
              <UsageOverview
                reports={reports}
                loading={loading}
                metric={active}
                range={range}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
