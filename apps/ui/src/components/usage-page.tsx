import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import {
  SimpleDropdown,
  SimpleDropdownItem,
} from "@/components/ui/simple-dropdown"
import {
  loadProviderUsage,
  type ProviderUsageReport,
  type UsageEntry,
  type UsagePricing,
  type UsageProviderId,
} from "@/services/backend"
import { cn } from "@/lib/utils"

type ActivityRange = "daily" | "weekly" | "cumulative"

const RANGES: Array<{ id: ActivityRange; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "cumulative", label: "Cumulative" },
]

const PROVIDER_ORDER: UsageProviderId[] = ["claude", "codex", "grok"]
const WEEKS = 53
const DAYS_PER_WEEK = 7
const DAY_MS = 86_400_000

/**
 * Staggered page entrance. A CSS animation runs once on mount and
 * `fill-mode-both` holds the end state, so a re-render mid-flight can never
 * strand a section at its start frame the way a restarted JS tween can.
 */
const ENTER =
  "motion-safe:animate-in motion-safe:fill-mode-both motion-safe:duration-300 motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
const enterDelay = (index: number) => ({ animationDelay: `${index * 60}ms` })

function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0"
  const unit =
    value >= 1e12
      ? { divisor: 1e12, suffix: "T" }
      : value >= 1e9
        ? { divisor: 1e9, suffix: "B" }
        : value >= 1e6
          ? { divisor: 1e6, suffix: "M" }
          : value >= 1e3
            ? { divisor: 1e3, suffix: "K" }
            : null
  if (!unit) return Math.round(value).toLocaleString()
  const scaled = value / unit.divisor
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled
    .toFixed(decimals)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")}${unit.suffix}`
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value > 0 && value < 0.01) return "<$0.01"
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  })
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (!Number.isFinite(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function formatReset(limit: {
  resetsAt: string | null
  resetLabel: string | null
}): string | null {
  if (limit.resetLabel) return limit.resetLabel
  if (!limit.resetsAt) return null
  const parsed = new Date(limit.resetsAt)
  if (!Number.isFinite(parsed.getTime())) return null
  return `Resets ${parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

/** How long ago the report was read, so a stale page is obvious. */
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

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/** Monday of the week `timestamp` falls in, at local midnight. */
function weekStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

const STATUS_DOT: Record<string, string> = {
  ready: "bg-emerald-400",
  partial: "bg-amber-400",
  unavailable: "bg-muted-foreground/40",
  error: "bg-red-400",
}

/** Rows run Monday to Sunday; only alternate rows are labelled. */
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""]

interface LimitItem {
  name: string
  share: string | null
}

interface LimitDetail {
  /** Leading share, as in `92% of your usage was at >150k context`. */
  share: string | null
  text: string
  /** `Top skills` and its entries, where the line is a ranked list. */
  label: string | null
  items: LimitItem[]
}

interface LimitGroup {
  title: string
  meta: string[]
  details: LimitDetail[]
}

/** Turns one line of the provider's limits breakdown back into its parts. */
function parseLimitDetail(text: string): LimitDetail {
  const ranked = /^Top\s+([^:]+):\s*(.+)$/.exec(text)
  if (ranked) {
    const items = ranked[2]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const withShare = /^(.*?)\s+(\d+(?:\.\d+)?%)$/.exec(part)
        return withShare
          ? { name: withShare[1], share: withShare[2] }
          : { name: part, share: null }
      })
    return { share: null, text, label: `Top ${ranked[1]}`, items }
  }
  const leading = /^(\d+(?:\.\d+)?%)\s+(.*)$/.exec(text)
  if (leading) {
    return { share: leading[1], text: leading[2], label: null, items: [] }
  }
  return { share: null, text, label: null, items: [] }
}

function unitFor(metric: "tokens" | "sessions", amount: number): string {
  if (metric === "tokens") return "tokens"
  return amount === 1 ? "chat" : "chats"
}

const HEATMAP_LEVELS = [
  "bg-foreground/[0.05]",
  "bg-blue-500/25",
  "bg-blue-500/45",
  "bg-blue-500/70",
  "bg-blue-500",
]

export function UsagePage({ onClose }: { onClose: () => void }) {
  const [reports, setReports] = useState<ProviderUsageReport[]>([])
  const [provider, setProvider] = useState<UsageProviderId | null>(null)
  const [range, setRange] = useState<ActivityRange>("daily")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState<{
    date: string
    amount: number
  } | null>(null)

  const load = useCallback((refresh: boolean) => {
    setLoading(true)
    loadProviderUsage({ refresh })
      .then((next) => {
        setReports(next)
        setError(null)
        setProvider((current) => {
          if (current && next.some((item) => item.provider === current)) {
            return current
          }
          const ready = next.find((item) => item.status === "ready")
          return ready?.provider ?? next.at(0)?.provider ?? null
        })
      })
      .catch(() => setError("The provider usage reports could not be read."))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(false), [load])

  const report = useMemo(
    () => reports.find((item) => item.provider === provider) ?? null,
    [provider, reports]
  )
  const ordered = useMemo(
    () =>
      [...reports].sort(
        (a, b) =>
          PROVIDER_ORDER.indexOf(a.provider) -
          PROVIDER_ORDER.indexOf(b.provider)
      ),
    [reports]
  )

  // A provider that records no tokens (Grok today) still records chats, so
  // the chart shows those rather than a year of empty cells.
  const hasTokens = (report?.summary.totalTokens ?? 0) > 0
  const metric: "tokens" | "sessions" =
    report && !hasTokens && report.summary.sessions > 0 ? "sessions" : "tokens"

  const calendar = useMemo(() => {
    const byDate = new Map<string, number>()
    for (const point of report?.daily ?? [])
      byDate.set(point.date, point[metric])
    const lastWeek = weekStart(Date.now())
    const start = lastWeek - (WEEKS - 1) * DAYS_PER_WEEK * DAY_MS
    const days = Array.from({ length: WEEKS * DAYS_PER_WEEK }, (_, index) => {
      // Cells run down each column, so a column is one calendar week.
      const week = Math.floor(index / DAYS_PER_WEEK)
      const weekday = index % DAYS_PER_WEEK
      const timestamp = start + (week * DAYS_PER_WEEK + weekday) * DAY_MS
      const date = localDayKey(timestamp)
      return { date, timestamp, amount: byDate.get(date) ?? 0 }
    })
    let running = 0
    const values = days.map((day, index) => {
      if (range === "weekly") {
        const window = days.slice(Math.max(0, index - 6), index + 1)
        return {
          ...day,
          value: window.reduce((sum, entry) => sum + entry.amount, 0),
        }
      }
      if (range === "cumulative") {
        running += day.amount
        return { ...day, value: running }
      }
      return { ...day, value: day.amount }
    })
    const max = values.reduce((best, day) => Math.max(best, day.value), 0)
    const today = localDayKey(Date.now())
    const past = days.filter((day) => day.date <= today)
    const windowTotal = past.reduce((sum, day) => sum + day.amount, 0)
    const windowDays = past.filter((day) => day.amount > 0).length
    const months: Array<{ key: string; label: string }> = []
    let previous = ""
    for (let week = 0; week < WEEKS; week += 1) {
      const first = values[week * DAYS_PER_WEEK]
      const label = first
        ? new Date(first.timestamp).toLocaleString(undefined, {
            month: "short",
          })
        : ""
      months.push({
        key: `${label}-${week}`,
        label: label === previous ? "" : label,
      })
      previous = label
    }
    return { values, max, months, windowTotal, windowDays }
  }, [metric, range, report])

  /**
   * The CLI nests limit details under a window heading by indenting them, and
   * the details are structured data written as prose. Parsing them back into
   * a share, a label and its items is what lets the card lay them out.
   */
  const limitGroups = useMemo(() => {
    const groups: LimitGroup[] = []
    const intro: string[] = []
    for (const line of report?.limitNotes ?? []) {
      const text = line.trim()
      if (!text) continue
      if (/^\s/.test(line) && groups.length > 0) {
        groups.at(-1)?.details.push(parseLimitDetail(text))
        continue
      }
      // `Last 24h · 2323 requests · 12 sessions`
      const heading = /^(Last\s+\S+)\s*·\s*(.*)$/.exec(text)
      if (heading) {
        groups.push({
          title: heading[1],
          meta: heading[2]
            .split("·")
            .map((part) => part.trim())
            .filter(Boolean),
          details: [],
        })
        continue
      }
      if (/^Last\b/.test(text)) {
        groups.push({ title: text, meta: [], details: [] })
        continue
      }
      intro.push(text)
    }
    return { groups, intro }
  }, [report])

  const summary = report?.summary
  const tokenValue = (value: number) =>
    !summary ? "—" : hasTokens ? formatCompact(value) : "—"
  const tiles = [
    {
      id: "tokens",
      value: tokenValue(summary?.totalTokens ?? 0),
      label: "Total tokens",
      title:
        "Every token this CLI has recorded, including cache reads and writes",
    },
    {
      id: "peak",
      value: tokenValue(summary?.peakDayTokens ?? 0),
      label: "Peak day",
      hint:
        hasTokens && summary?.peakDayDate
          ? formatDay(summary.peakDayDate)
          : undefined,
      title: "Most tokens recorded on one calendar day",
    },
    {
      id: "longest",
      value: summary ? formatDuration(summary.longestSessionMs) : "—",
      label: "Longest chat",
      title: "Longest single chat measured as working time, not wall clock",
    },
    {
      id: "current-streak",
      value: summary ? `${summary.currentStreakDays} days` : "—",
      label: "Current streak",
      title:
        "Consecutive days with activity, counting yesterday while today is still quiet",
    },
    {
      id: "longest-streak",
      value: summary ? `${summary.longestStreakDays} days` : "—",
      label: "Longest streak",
      title: "Longest run of consecutive days with activity",
    },
  ]

  // Only these four add up to the total. Reasoning is counted inside output,
  // so it is reported separately instead of as a fifth bar that would make
  // the rows look like they sum to more than the headline number.
  const breakdown: UsageEntry[] = summary
    ? (
        [
          ["input", "Input", summary.tokens.input],
          ["output", "Output", summary.tokens.output],
          ["cache-read", "Cache read", summary.tokens.cacheRead],
          ["cache-write", "Cache write", summary.tokens.cacheWrite],
        ] as const
      )
        .filter(([, , value]) => value > 0)
        .map(([id, label, value]) => ({ id, label, value }))
    : []

  let section = 0
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-background px-3">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to chat"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96]"
          >
            <ArrowLeftIcon className="size-3.5" strokeWidth={1.5} />
          </button>
          <div className="flex items-center gap-2">
            <ActivityIcon
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.5}
            />
            <span className="text-[12px] font-medium">Usage</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96] disabled:opacity-50"
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "animate-spin")}
            strokeWidth={1.5}
          />
          Refresh
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-9 sm:px-10">
        <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3">
          <div
            style={enterDelay(section++)}
            className={cn(
              ENTER,
              "flex flex-wrap items-center justify-between gap-3 px-0.5"
            )}
          >
            <SimpleDropdown
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="start"
              side="bottom"
              className="min-w-[240px]"
              trigger={
                <button
                  type="button"
                  aria-label="Select provider"
                  className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-foreground/[0.02] px-3.5 py-2.5 text-[13px] transition-colors duration-150 hover:bg-foreground/[0.05] active:scale-[0.96]"
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      STATUS_DOT[report?.status ?? "unavailable"]
                    )}
                  />
                  <span className="font-medium">
                    {report?.label ?? "No provider"}
                  </span>
                  {report?.version && (
                    <span className="text-[11px] text-muted-foreground">
                      v{report.version}
                    </span>
                  )}
                  <ChevronDownIcon
                    className="size-3.5 text-muted-foreground/60"
                    strokeWidth={1.5}
                  />
                </button>
              }
            >
              {ordered.map((item) => (
                <SimpleDropdownItem
                  key={item.provider}
                  onClick={() => setProvider(item.provider)}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT[item.status]
                    )}
                  />
                  <span className="flex-1">{item.label}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {item.status === "ready"
                      ? formatCompact(item.summary.totalTokens)
                      : item.status === "partial"
                        ? "No tokens"
                        : item.status === "error"
                          ? "Error"
                          : "Not installed"}
                  </span>
                  {item.provider === provider && (
                    <CheckIcon
                      className="size-3.5 text-primary"
                      strokeWidth={2}
                    />
                  )}
                </SimpleDropdownItem>
              ))}
            </SimpleDropdown>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {report?.plan && (
                <span className="rounded-full border border-border/50 px-2.5 py-1 text-[10px] font-medium text-foreground/80">
                  {report.plan}
                </span>
              )}
              <span className="truncate">
                {report ? report.source : "Reading provider stores…"}
              </span>
              {report && (
                <span className="shrink-0 text-muted-foreground/60">
                  · {formatAge(report.fetchedAt)}
                </span>
              )}
            </div>
          </div>

          {report?.error && (
            <div
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-5 py-4 text-[12px] text-amber-200/90"
              )}
            >
              {report.error}
            </div>
          )}

          <section
            style={enterDelay(section++)}
            className={cn(ENTER, "grid grid-cols-2 gap-2.5 sm:grid-cols-5")}
          >
            {tiles.map((tile) => (
              <div
                key={tile.id}
                title={tile.title}
                className="rounded-2xl border border-border/40 bg-foreground/[0.02] px-4 py-5 text-center"
              >
                <p className="text-[27px] leading-none font-medium tracking-[-0.035em] tabular-nums">
                  {tile.value}
                </p>
                <p className="mt-2.5 truncate text-[11px] text-muted-foreground">
                  {tile.label}
                </p>
                <p className="mt-1 h-3 truncate text-[10px] text-muted-foreground/60">
                  {tile.hint ?? ""}
                </p>
              </div>
            ))}
          </section>

          {!report && (
            <div
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "flex items-center justify-center gap-2 rounded-2xl border border-border/40 bg-foreground/[0.02] px-5 py-14 text-[12px] text-muted-foreground"
              )}
            >
              {loading && (
                <LoaderCircleIcon
                  className="size-3.5 animate-spin"
                  strokeWidth={2}
                />
              )}
              {loading
                ? "Reading the provider CLI stores…"
                : "No provider usage is available."}
            </div>
          )}

          {report && report.status === "unavailable" && (
            <div
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "rounded-2xl border border-border/40 bg-foreground/[0.02] px-5 py-12 text-center"
              )}
            >
              <p className="text-[13px] font-medium">
                {report.label} is not installed on this machine
              </p>
              <p className="mx-auto mt-2 max-w-[440px] text-[11px] leading-relaxed text-muted-foreground">
                Install its CLI and sign in; this page reads whatever it writes
                to {report.source || "its own store"} and needs no further
                setup.
              </p>
            </div>
          )}

          {report && report.limits.length > 0 && (
            <section
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold">Current limits</h2>
                {/* Served from a stored copy so the page does not wait on the
                    CLI; say so once the copy is no longer fresh. */}
                {report.limitsObservedAt &&
                  Date.now() - Date.parse(report.limitsObservedAt) >
                    120_000 && (
                    <span className="text-[10px] text-muted-foreground/70">
                      read {formatAge(report.limitsObservedAt)}
                    </span>
                  )}
              </div>
              {/* Providers report one to three windows; each gets its own
                  surface so the label, the number and the bar read as one
                  unit instead of three columns the eye has to pair up. */}
              <div className="mt-4 grid [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))] gap-3">
                {report.limits.map((limit) => (
                  <div
                    key={limit.id}
                    className="rounded-xl bg-foreground/[0.03] p-4"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-[22px] leading-none font-medium tracking-[-0.03em] tabular-nums">
                        {limit.usedPercent}%
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {limit.label}
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                      <span
                        className={cn(
                          "block h-full rounded-full transition-[width] duration-500 ease-out",
                          limit.usedPercent >= 90
                            ? "bg-red-400"
                            : limit.usedPercent >= 70
                              ? "bg-amber-400"
                              : "bg-blue-500"
                        )}
                        style={{
                          width: `${Math.min(100, Math.max(0, limit.usedPercent))}%`,
                        }}
                      />
                    </div>
                    {formatReset(limit) && (
                      <p className="mt-2.5 truncate text-[10px] text-muted-foreground/70">
                        {formatReset(limit)}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {limitGroups.groups.length > 0 && (
                <div className="mt-6 border-t border-border/40 pt-5">
                  <h3 className="text-[12px] font-medium">
                    What is driving these limits
                  </h3>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {limitGroups.groups.map((group) => (
                      <div
                        key={group.title}
                        className="rounded-xl bg-foreground/[0.03] p-4"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                          <span className="text-[12px] font-medium">
                            {group.title}
                          </span>
                          {group.meta.map((part) => (
                            <span
                              key={part}
                              className="text-[10px] text-muted-foreground tabular-nums"
                            >
                              {part}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3.5 space-y-3">
                          {group.details.map((detail) => (
                            <LimitDetailRow key={detail.text} detail={detail} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {limitGroups.intro.map((line) => (
                    <p
                      key={line}
                      className="mt-3 text-[10px] leading-relaxed text-muted-foreground/60"
                    >
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}

          <section
            style={enterDelay(section++)}
            className={cn(
              ENTER,
              "rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold">
                  {metric === "tokens" ? "Token usage" : "Chat activity"}
                </h2>
                {/* One line that carries the window summary, and becomes a
                    readout while a day is hovered. */}
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {hovered
                    ? `${
                        hovered.amount > 0
                          ? `${formatCompact(hovered.amount)} ${unitFor(metric, hovered.amount)}`
                          : "No usage"
                      } · ${formatDay(hovered.date)}`
                    : // Deliberately "charted", not "total": a provider may
                      // keep lifetime totals without a per-day series.
                      `Charted: ${formatCompact(calendar.windowTotal)} ${unitFor(
                        metric,
                        calendar.windowTotal
                      )} over ${calendar.windowDays} ${
                        calendar.windowDays === 1 ? "day" : "days"
                      }`}
                </p>
              </div>
              <div className="flex items-center gap-0.5 self-start rounded-xl bg-foreground/[0.05] p-1">
                {RANGES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={range === item.id}
                    onClick={() => setRange(item.id)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[11px] transition-colors duration-150 active:scale-[0.96]",
                      range === item.id
                        ? "bg-foreground/[0.08] font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-5 overflow-x-auto pb-1">
              <div className="flex min-w-[740px] gap-2">
                {/* Stretches to the cell grid, so its seven rows line up with
                    the seven weekday rows whatever width the cells take. */}
                <div className="grid shrink-0 grid-rows-7 gap-[3px] self-stretch text-[9px] text-muted-foreground/70">
                  {WEEKDAYS.map((day, index) => (
                    <span
                      key={index}
                      className="flex items-center leading-none"
                    >
                      {day}
                    </span>
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="grid grid-flow-col grid-rows-7 gap-[3px]"
                    onMouseLeave={() => setHovered(null)}
                  >
                    {calendar.values.map((day) => {
                      const level =
                        calendar.max === 0 || day.value === 0
                          ? 0
                          : Math.min(
                              4,
                              Math.max(
                                1,
                                Math.ceil(
                                  Math.sqrt(day.value / calendar.max) * 4
                                )
                              )
                            )
                      return (
                        <span
                          key={day.date}
                          onMouseEnter={() =>
                            setHovered({ date: day.date, amount: day.amount })
                          }
                          className={cn(
                            "aspect-square rounded-[3px] outline outline-transparent transition-[outline-color] duration-150",
                            HEATMAP_LEVELS[level],
                            "hover:outline-foreground/30"
                          )}
                        />
                      )
                    })}
                  </div>
                  <div className="mt-2.5 grid auto-cols-fr grid-flow-col text-[10px] text-muted-foreground">
                    {calendar.months.map((month) => (
                      <span key={month.key}>{month.label}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
              <span>Less</span>
              {HEATMAP_LEVELS.map((level) => (
                <span
                  key={level}
                  className={cn("size-2.5 rounded-[3px]", level)}
                />
              ))}
              <span>More</span>
            </div>
          </section>

          <section
            style={enterDelay(section++)}
            // Masonry, not a grid: cards differ a lot in height, and a
            // two-column grid leaves a hole under every short one.
            className={cn(ENTER, "gap-3 [column-fill:balance] lg:columns-2")}
          >
            {report?.pricing ? (
              <CostCard pricing={report.pricing} />
            ) : (
              report &&
              hasTokens && (
                <MissingRatesCard
                  models={report.models.map((model) => model.label)}
                  file={report.pricesFile}
                  provider={report.label}
                />
              )
            )}

            <Card title="Activity insights">
              {report && report.insights.length > 0 ? (
                <dl className="divide-y divide-border/30">
                  {report.insights.map((insight) => (
                    <div
                      key={insight.id}
                      className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0"
                    >
                      <dt className="text-[12px] text-muted-foreground">
                        {insight.label}
                      </dt>
                      <dd className="shrink-0 text-[13px] font-medium tabular-nums">
                        {insight.value}
                      </dd>
                    </div>
                  ))}
                  {summary && summary.cost !== null && (
                    <div className="flex items-baseline justify-between gap-4 py-2.5 last:pb-0">
                      <dt className="text-[12px] text-muted-foreground">
                        Recorded spend
                      </dt>
                      <dd className="shrink-0 text-[13px] font-medium tabular-nums">
                        ${summary.cost.toFixed(2)}
                      </dd>
                    </div>
                  )}
                </dl>
              ) : (
                <Empty>
                  {loading ? "Reading local stores…" : "No activity recorded."}
                </Empty>
              )}
            </Card>

            {(report?.lists ?? []).map((list) => (
              <Card key={list.id} title={list.title}>
                <BarList entries={list.entries} unit={list.unit} />
              </Card>
            ))}

            {(report?.models.length ?? 0) > 0 && (
              <Card title="Models">
                <BarList
                  entries={report?.models ?? []}
                  unit={metric === "tokens" ? "" : "chats"}
                />
              </Card>
            )}

            {breakdown.length > 0 && (
              <Card title="Token breakdown">
                <BarList entries={breakdown} unit="" />
                {(summary?.tokens.reasoning ?? 0) > 0 && (
                  <p className="mt-4 border-t border-border/30 pt-3 text-[11px] text-muted-foreground">
                    Output includes{" "}
                    <span className="text-foreground/80 tabular-nums">
                      {formatCompact(summary?.tokens.reasoning ?? 0)}
                    </span>{" "}
                    reasoning tokens.
                  </p>
                )}
              </Card>
            )}

            {report && report.lists.length === 0 && breakdown.length === 0 && (
              <Card title="Breakdown">
                <Empty>
                  {report.label} does not record skill or plugin attribution.
                </Empty>
              </Card>
            )}
          </section>

          {report && report.notes.length > 0 && (
            <section
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "space-y-2 rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"
              )}
            >
              {report.notes.map((note) => (
                <p
                  key={note}
                  className="text-[11px] leading-relaxed text-muted-foreground"
                >
                  {note}
                </p>
              ))}
            </section>
          )}

          {error && (
            <p className="mt-6 text-center text-[12px] text-muted-foreground">
              {error}
            </p>
          )}

          <p className="mt-4 mb-2 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/60">
            {loading && (
              <LoaderCircleIcon
                className="size-3 animate-spin"
                strokeWidth={2}
              />
            )}
            Read locally from each provider CLI's own store. Nothing leaves this
            machine.
          </p>
        </div>
      </div>
    </main>
  )
}

/**
 * One line of the provider's limits breakdown. A leading share becomes a
 * number the eye can scan down the column; a ranked list becomes chips,
 * because "Top skills: /a 6%, /b 3%" is a table written as a sentence.
 */
function LimitDetailRow({ detail }: { detail: LimitDetail }) {
  if (detail.label) {
    return (
      <div>
        <p className="text-[10px] text-muted-foreground/70">{detail.label}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {detail.items.map((item) => (
            <span
              key={item.name}
              className="flex items-baseline gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-[10px]"
            >
              <span className="max-w-[190px] truncate">{item.name}</span>
              {item.share && (
                <span className="text-muted-foreground tabular-nums">
                  {item.share}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (detail.share) {
    return (
      <p className="flex gap-2.5 text-[11px] leading-relaxed">
        <span className="w-8 shrink-0 text-right font-medium tabular-nums">
          {detail.share}
        </span>
        <span className="text-muted-foreground">{detail.text}</span>
      </p>
    )
  }
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      {detail.text}
    </p>
  )
}

/** Card surface. In the masonry column it must not split across columns. */
const CARD =
  "mb-3 break-inside-avoid rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className={CARD}>
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * List-price cost of the recorded tokens. The provider bills a subscription
 * here, so this answers "what would this have cost on the API" — it is not a
 * bill, and the card says how much of the usage it actually covers.
 */
function CostCard({ pricing }: { pricing: UsagePricing }) {
  const rows = [
    ["Input", pricing.breakdown.input],
    ["Output", pricing.breakdown.output],
    ["Cache read", pricing.breakdown.cacheRead],
    ["Cache write", pricing.breakdown.cacheWrite],
  ] as const
  const max = rows.reduce((best, [, value]) => Math.max(best, value), 0)
  const recorded = pricing.pricedTokens + pricing.unpricedTokens
  const covered = recorded > 0 ? pricing.pricedTokens / recorded : 1
  return (
    <section className={CARD}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">At API list prices</h2>
        <span className="text-[20px] font-medium tracking-[-0.03em] tabular-nums">
          {formatMoney(pricing.total)}
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px]">{label}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                {formatMoney(value)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
              <span
                className="block h-full rounded-full bg-emerald-500/70 transition-[width] duration-500 ease-out"
                style={{
                  width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-1.5 border-t border-border/30 pt-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          What these tokens would cost on the API. This plan is a subscription,
          so it is a comparison, not a bill.
        </p>
        {covered < 0.999 && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Covers {percentLabel(covered)} of the recorded tokens.{" "}
            {pricing.unpricedModels.length} model
            {pricing.unpricedModels.length === 1 ? "" : "s"} have no published
            rate ({formatCompact(pricing.unpricedTokens)} tokens) — add them to{" "}
            <code className="rounded bg-foreground/[0.06] px-1 py-0.5 text-[10px]">
              model-prices.json
            </code>{" "}
            to include them.
          </p>
        )}
        {pricing.notes.map((note) => (
          <p
            key={note}
            className="text-[11px] leading-relaxed text-muted-foreground"
          >
            {note}
          </p>
        ))}
      </div>
    </section>
  )
}

/**
 * Shown when nothing in the report has a published rate. The snippet lists
 * every model that actually appeared, so filling it in is a paste and a
 * number per line rather than a lookup of what to name.
 */
function MissingRatesCard({
  models,
  file,
  provider,
}: {
  models: string[]
  file: string | null
  provider: string
}) {
  const [copied, setCopied] = useState(false)
  const snippet = [
    "{",
    ...models.map(
      (model, index) =>
        `  ${JSON.stringify(model)}: { "input": 0, "output": 0 }` +
        (index < models.length - 1 ? "," : "")
    ),
    "}",
  ].join("\n")
  return (
    <section className={CARD}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">At API list prices</h2>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(snippet)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96]"
        >
          {copied ? (
            <CheckIcon className="size-3.5" strokeWidth={2} />
          ) : (
            <CopyIcon className="size-3.5" strokeWidth={1.5} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
        No rate is published for {provider}&apos;s models, so there is nothing
        to price them with. Paste this into{" "}
        {file ? (
          <code className="rounded bg-foreground/[0.06] px-1 py-0.5 text-[10px] break-all">
            {file}
          </code>
        ) : (
          <code className="rounded bg-foreground/[0.06] px-1 py-0.5 text-[10px]">
            model-prices.json
          </code>
        )}
        , fill in the per-million-token rates, and the cost appears here.
      </p>
      <pre className="mt-3 max-h-[220px] overflow-auto rounded-lg bg-foreground/[0.04] p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {snippet}
      </pre>
    </section>
  )
}

function percentLabel(share: number): string {
  const scaled = share * 100
  return `${scaled >= 99.5 ? ">99" : scaled.toFixed(scaled >= 10 ? 0 : 1)}%`
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-muted-foreground">{children}</p>
}

/**
 * Ranked rows with a share bar. The bar is relative to the largest entry, so
 * the shape of the list is readable at a glance even when one row dominates.
 */
function BarList({ entries, unit }: { entries: UsageEntry[]; unit: string }) {
  const max = entries.reduce((best, entry) => Math.max(best, entry.value), 0)
  if (entries.length === 0) return <Empty>Nothing recorded yet.</Empty>
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.id}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[12px]" title={entry.label}>
              {entry.label}
            </span>
            <span className="flex shrink-0 items-baseline gap-2 text-[12px] text-muted-foreground tabular-nums">
              {entry.cost !== undefined && (
                <span className="text-foreground/70">
                  {formatMoney(entry.cost)}
                </span>
              )}
              <span>
                {formatCompact(entry.value)}
                {unit ? ` ${unit}` : ""}
              </span>
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
            <span
              className="block h-full rounded-full bg-blue-500/70 transition-[width] duration-500 ease-out"
              style={{
                width: `${max > 0 ? Math.max(2, (entry.value / max) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
