import { useEffect, useMemo, useState } from "react"
import {
  ActivityIcon,
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpFromLineIcon,
  BadgeCheckIcon,
  BookOpenIcon,
  BoxesIcon,
  BrainIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  CoinsIcon,
  CopyIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  DatabaseZapIcon,
  FileTextIcon,
  FlameIcon,
  FolderCodeIcon,
  GaugeIcon,
  HardDriveIcon,
  HistoryIcon,
  InfoIcon,
  LayersIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  PuzzleIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  TimerIcon,
  TrendingUpIcon,
  TrophyIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  SimpleDropdown,
  SimpleDropdownItem,
} from "@/components/ui/simple-dropdown"
import { ProviderIcon } from "@/components/provider-icon"
import { builtinProviders } from "@/lib/builtin-providers"
import { useUsageStore } from "@/lib/usage-store"
import {
  type UsageEntry,
  type UsagePricing,
  type UsageProviderId,
  type UsageLimit,
} from "@/services/backend"
import { cn } from "@/lib/utils"

type ActivityRange = "daily" | "weekly" | "cumulative"

const RANGES: Array<{ id: ActivityRange; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "cumulative", label: "Cumulative" },
]

const USAGE_PROVIDERS = ["claude", "codex"].map(
  (id) => builtinProviders.find((item) => item.id === id)!
)
const TOKEN_ICONS: Record<string, LucideIcon> = {
  input: ArrowDownToLineIcon,
  output: ArrowUpFromLineIcon,
  "cache-read": DatabaseZapIcon,
  "cache-write": DatabaseBackupIcon,
}
const INSIGHT_ICONS: Record<string, LucideIcon> = {
  "fast-mode": ZapIcon,
  effort: BrainIcon,
  "skills-distinct": BookOpenIcon,
  "skills-total": WorkflowIcon,
  chats: MessagesSquareIcon,
  average: GaugeIcon,
  models: BoxesIcon,
  plan: BadgeCheckIcon,
}
const LIST_ICONS: Record<string, LucideIcon> = {
  plugins: PuzzleIcon,
  skills: BookOpenIcon,
  projects: FolderCodeIcon,
}
const DETAIL_ICON = "size-3.5 shrink-0 text-muted-foreground"
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

function Skeleton({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-md bg-foreground/[0.06] motion-safe:animate-pulse",
        className
      )}
    />
  )
}

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
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
]

export function UsagePage({ onClose }: { onClose: () => void }) {
  const { reports, loading, error, load } = useUsageStore()
  const [provider, setProvider] = useState<UsageProviderId>("claude")
  const [menuOpen, setMenuOpen] = useState(false)
  const [range, setRange] = useState<ActivityRange>("daily")
  const [hovered, setHovered] = useState<{
    date: string
    amount: number
  } | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const report = useMemo(
    () => reports.find((item) => item.provider === provider) ?? null,
    [provider, reports]
  )
  const selectedProvider = USAGE_PROVIDERS.find((item) => item.id === provider)!
  const providerLabel = provider === "claude" ? "Claude Code" : "Codex"
  // A store may record chats before its first token count is available.
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
      icon: LayersIcon,
      value: tokenValue(summary?.totalTokens ?? 0),
      label: "Total tokens",
      hint: summary ? `${summary.sessions.toLocaleString()} chats` : undefined,
      title:
        "Every token this CLI has recorded, including cache reads and writes",
    },
    {
      id: "peak",
      icon: TrendingUpIcon,
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
      icon: TimerIcon,
      value: summary ? formatDuration(summary.longestSessionMs) : "—",
      label: "Longest chat",
      hint: "Active time",
      title: "Longest single chat measured as working time, not wall clock",
    },
    {
      id: "current-streak",
      icon: FlameIcon,
      value: summary ? `${summary.currentStreakDays} days` : "—",
      label: "Current streak",
      hint:
        summary?.currentStreakDays === 0
          ? "No activity today"
          : "Consecutive days",
      title:
        "Consecutive days with activity, counting yesterday while today is still quiet",
    },
    {
      id: "longest-streak",
      icon: TrophyIcon,
      value: summary ? `${summary.longestStreakDays} days` : "—",
      label: "Longest streak",
      hint: "Personal best",
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96] disabled:opacity-50"
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "motion-safe:animate-spin")}
            strokeWidth={1.5}
          />
          {loading ? "Updating…" : "Refresh"}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-9 sm:px-10">
        <div className="@container/usage mx-auto flex w-full max-w-[1040px] flex-col gap-3">
          <section
            className="flex flex-wrap items-center justify-between gap-3 px-0.5"
            aria-label="Usage overview"
          >
            <SimpleDropdown
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="start"
              side="bottom"
              className="min-w-[240px]"
              trigger={
                <Button
                  variant="ghost"
                  aria-label="Select usage provider"
                  aria-expanded={menuOpen}
                  className="h-auto gap-2.5 rounded-xl border border-border/50 bg-foreground/[0.02] px-3.5 py-2.5 text-[13px] hover:bg-foreground/[0.05] motion-reduce:transition-none"
                >
                  <ProviderIcon
                    provider={{ ...selectedProvider, name: providerLabel }}
                    className="size-4 shrink-0"
                  />
                  <span className="font-medium">{providerLabel}</span>
                  {report?.version && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      v{report.version}
                    </span>
                  )}
                  <ChevronDownIcon
                    className="size-3.5 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                </Button>
              }
            >
              {USAGE_PROVIDERS.map((item) => {
                const usage = reports.find(
                  (entry) => entry.provider === item.id
                )
                const label = item.id === "claude" ? "Claude Code" : "Codex"
                return (
                  <SimpleDropdownItem
                    key={item.id}
                    active={provider === item.id}
                    aria-pressed={provider === item.id}
                    onClick={() => {
                      setProvider(item.id as UsageProviderId)
                      setHovered(null)
                    }}
                    className="min-h-9 gap-2.5 px-2.5 focus-visible:outline focus-visible:outline-ring motion-reduce:transition-none"
                  >
                    <ProviderIcon
                      provider={{ ...item, name: label }}
                      className="size-4 shrink-0"
                    />
                    <span className="flex-1">{label}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {usage?.status === "unavailable"
                        ? "Not installed"
                        : usage?.status === "error"
                          ? "Unavailable"
                          : usage
                            ? `${formatCompact(usage.summary.totalTokens)} tokens`
                            : loading
                              ? "Reading…"
                              : "No report"}
                    </span>
                    <span className="flex size-3.5 items-center justify-center">
                      {provider === item.id && (
                        <CheckIcon className="size-3.5" strokeWidth={2} />
                      )}
                    </span>
                  </SimpleDropdownItem>
                )
              })}
            </SimpleDropdown>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {report?.plan && (
                <span className="rounded-full border border-border/50 px-2.5 py-1 text-[10px] font-medium text-foreground/80">
                  {report.plan}
                </span>
              )}
              <span role="status">
                {loading
                  ? report
                    ? "Updating local usage…"
                    : "Reading local usage…"
                  : report
                    ? `Updated ${formatAge(report.fetchedAt)} · All time`
                    : "Local usage"}
              </span>
            </div>
          </section>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-foreground"
            >
              {error}
            </p>
          )}

          {report?.error && (
            <div
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "rounded-xl border border-warning/30 bg-warning/5 px-5 py-4 text-xs text-foreground"
              )}
            >
              {report.error}
            </div>
          )}

          <section
            aria-label="Lifetime statistics"
            aria-busy={!report && loading}
            className="grid grid-cols-2 gap-2.5 @[760px]/usage:grid-cols-5"
          >
            {tiles.map((tile) => (
              <div
                key={tile.id}
                title={tile.title}
                className="min-w-0 rounded-2xl border border-border/40 bg-foreground/[0.02] p-4"
              >
                <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <tile.icon
                    aria-hidden="true"
                    className={DETAIL_ICON}
                    strokeWidth={1.5}
                  />
                  {tile.label}
                </p>
                {!report && loading ? (
                  <Skeleton className="mt-4 h-7 w-20" />
                ) : (
                  <p className="mt-4 text-[27px] leading-none font-medium tracking-[-0.035em] tabular-nums">
                    {tile.value}
                  </p>
                )}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {tile.hint ??
                    (tile.id === "peak"
                      ? "Highest daily usage"
                      : "All recorded activity")}
                </p>
              </div>
            ))}
          </section>

          {!report && (
            <section
              aria-label="Loading usage details"
              className="rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"
            >
              <p role="status" className="text-xs text-muted-foreground">
                {loading
                  ? "Reading your local activity. Large histories may take a moment on the first visit."
                  : "No provider usage is available."}
              </p>
              {loading && (
                <div className="mt-5 grid gap-6 sm:grid-cols-2">
                  <Skeleton className="h-32 rounded-lg" />
                  <Skeleton className="h-32 rounded-lg" />
                </div>
              )}
            </section>
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
              aria-label="Current limits"
              className="rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold">Current limits</h2>
                {report.limitsObservedAt && (
                  <span className="text-[10px] text-muted-foreground">
                    Checked {formatAge(report.limitsObservedAt)}
                  </span>
                )}
              </div>
              <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
                {report.limits.map((limit) => (
                  <UsageLimitRow key={limit.id} limit={limit} />
                ))}
              </div>
              {limitGroups.groups.length > 0 && (
                <div className="mt-5 space-y-3 border-t border-border/40 pt-4">
                  <h3 className="flex items-center gap-2 text-[12px] font-medium">
                    <ActivityIcon
                      aria-hidden="true"
                      className={DETAIL_ICON}
                      strokeWidth={1.5}
                    />
                    What drives your usage
                  </h3>
                  {limitGroups.groups.map((group) => (
                    <div
                      key={group.title}
                      className="overflow-hidden rounded-xl border border-border/40 bg-foreground/[0.02]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/30 px-4 py-3 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-2 font-medium text-foreground">
                          <CalendarDaysIcon
                            aria-hidden="true"
                            className={DETAIL_ICON}
                            strokeWidth={1.5}
                          />
                          {group.title}
                        </span>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          {group.meta.map((part) => {
                            const Icon = /sessions|chats/i.test(part)
                              ? MessagesSquareIcon
                              : ActivityIcon
                            return (
                              <span
                                key={part}
                                className="flex items-center gap-1.5 tabular-nums"
                              >
                                <Icon
                                  aria-hidden="true"
                                  className="size-3"
                                  strokeWidth={1.5}
                                />
                                {part}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                      <div className="grid divide-y divide-border/30 @[760px]/usage:grid-cols-3 @[760px]/usage:divide-x @[760px]/usage:divide-y-0">
                        {group.details
                          .filter((detail) => !detail.label)
                          .map((detail) => (
                            <LimitDetailRow key={detail.text} detail={detail} />
                          ))}
                      </div>
                      {group.details
                        .filter((detail) => detail.label)
                        .map((detail) => (
                          <LimitDetailRow key={detail.text} detail={detail} />
                        ))}
                    </div>
                  ))}
                </div>
              )}
              {limitGroups.intro.length > 0 && (
                <div className="mt-3 flex items-start gap-2 text-muted-foreground">
                  <InfoIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3 shrink-0"
                    strokeWidth={1.5}
                  />
                  <div className="space-y-1">
                    {limitGroups.intro.map((line) => (
                      <p key={line} className="text-[10px] leading-relaxed">
                        {line}
                      </p>
                    ))}
                  </div>
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

          {report && (report.pricing || hasTokens) && (
            <div className={ENTER} style={enterDelay(section++)}>
              {report.pricing ? (
                <CostSection
                  pricing={report.pricing}
                  provider={providerLabel}
                />
              ) : (
                <MissingRatesCard
                  models={report.models.map((model) => model.label)}
                  file={report.pricesFile}
                  provider={report.label}
                />
              )}
            </div>
          )}

          <section
            style={enterDelay(section++)}
            // Masonry, not a grid: cards differ a lot in height, and a
            // two-column grid leaves a hole under every short one.
            className={cn(ENTER, "gap-3 [column-fill:balance] lg:columns-2")}
          >
            <Card title="Activity insights" icon={ActivityIcon}>
              {report && report.insights.length > 0 ? (
                <dl className="divide-y divide-border/30">
                  {report.insights.map((insight) => {
                    const Icon = INSIGHT_ICONS[insight.id] ?? ActivityIcon
                    return (
                      <div
                        key={insight.id}
                        className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0"
                      >
                        <dt className="flex min-w-0 items-center gap-2.5 text-[12px] text-muted-foreground">
                          <Icon
                            aria-hidden="true"
                            className={DETAIL_ICON}
                            strokeWidth={1.5}
                          />
                          <span>{insight.label}</span>
                        </dt>
                        <dd className="shrink-0 text-[13px] font-medium tabular-nums">
                          {insight.value}
                        </dd>
                      </div>
                    )
                  })}
                  {summary && summary.cost !== null && (
                    <div className="flex items-center justify-between gap-4 py-2.5 last:pb-0">
                      <dt className="flex items-center gap-2.5 text-[12px] text-muted-foreground">
                        <CoinsIcon
                          aria-hidden="true"
                          className={DETAIL_ICON}
                          strokeWidth={1.5}
                        />
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
              <Card
                key={list.id}
                title={list.title}
                icon={LIST_ICONS[list.id] ?? LayersIcon}
              >
                <BarList entries={list.entries} unit={list.unit} />
              </Card>
            ))}

            {(report?.models.length ?? 0) > 0 && (
              <Card title="Models" icon={BoxesIcon}>
                <BarList
                  entries={report?.models ?? []}
                  unit={metric === "tokens" ? "" : "chats"}
                  renderIcon={() => (
                    <ProviderIcon
                      provider={{ ...selectedProvider, name: providerLabel }}
                      className="size-4 shrink-0"
                    />
                  )}
                />
              </Card>
            )}

            {breakdown.length > 0 && (
              <Card title="Token breakdown" icon={LayersIcon}>
                <BarList
                  entries={breakdown}
                  unit=""
                  renderIcon={(entry) => {
                    const Icon = TOKEN_ICONS[entry.id] ?? DatabaseIcon
                    return (
                      <Icon
                        aria-hidden="true"
                        className={DETAIL_ICON}
                        strokeWidth={1.5}
                      />
                    )
                  }}
                />
                {(summary?.tokens.reasoning ?? 0) > 0 && (
                  <p className="mt-4 flex items-start gap-2.5 border-t border-border/30 pt-3 text-[11px] text-muted-foreground">
                    <BrainIcon
                      aria-hidden="true"
                      className={DETAIL_ICON}
                      strokeWidth={1.5}
                    />
                    <span>
                      Output includes{" "}
                      <span className="text-foreground/80 tabular-nums">
                        {formatCompact(summary?.tokens.reasoning ?? 0)}
                      </span>{" "}
                      reasoning tokens.
                    </span>
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

          {report && (
            <section
              aria-label="Data coverage"
              style={enterDelay(section++)}
              className={cn(
                ENTER,
                "overflow-hidden rounded-2xl border border-border/40 bg-foreground/[0.02]"
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
                <h2 className="flex items-center gap-2 text-[12px] font-medium">
                  <DatabaseIcon
                    aria-hidden="true"
                    className={DETAIL_ICON}
                    strokeWidth={1.5}
                  />
                  About these numbers
                </h2>
                <span className="text-[10px] text-muted-foreground">
                  {report.label}
                </span>
              </div>
              {report.notes.length > 0 && (
                <ul className="grid gap-x-6 gap-y-4 px-5 py-4 @[760px]/usage:grid-cols-2">
                  {report.notes.map((note) => {
                    const Icon = /per-message|transcript/i.test(note)
                      ? FileTextIcon
                      : HistoryIcon
                    return (
                      <li key={note} className="flex items-start gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]"
                        >
                          <Icon className={DETAIL_ICON} strokeWidth={1.5} />
                        </span>
                        <p className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                          <NoteText text={note} />
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 text-[10px] text-muted-foreground",
                  report.notes.length > 0 && "border-t border-border/30"
                )}
              >
                <span className="flex items-center gap-2">
                  <HardDriveIcon
                    aria-hidden="true"
                    className="size-3"
                    strokeWidth={1.5}
                  />
                  Based on CLI history stored on this device.
                </span>
                <span className="flex items-center gap-1.5" role="status">
                  {loading && (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="size-3 motion-safe:animate-spin"
                    />
                  )}
                  {loading
                    ? "Updating…"
                    : `Read ${formatAge(report.fetchedAt)}`}
                </span>
              </div>
            </section>
          )}
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
    const Icon = /subagents/i.test(detail.label) ? WorkflowIcon : BookOpenIcon
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/30 px-4 py-3">
        <p className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Icon aria-hidden="true" className={DETAIL_ICON} strokeWidth={1.5} />
          {detail.label}
        </p>
        <div className="flex flex-wrap gap-2">
          {detail.items.map((item) => (
            <span
              key={item.name}
              className="flex max-w-full items-baseline gap-2 rounded-md border border-border/40 bg-foreground/[0.03] px-2 py-1 text-[10px]"
            >
              <span className="min-w-0 break-words">{item.name}</span>
              {item.share && (
                <span className="shrink-0 text-muted-foreground tabular-nums">
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
    const driver = /context/i.test(detail.text)
      ? { label: "Large context", icon: LayersIcon }
      : /subagent/i.test(detail.text)
        ? { label: "Subagent activity", icon: WorkflowIcon }
        : /sessions active|hours/i.test(detail.text)
          ? { label: "Long sessions", icon: TimerIcon }
          : { label: "Usage pattern", icon: ActivityIcon }
    const value = Math.max(0, Math.min(100, Number.parseFloat(detail.share)))
    return (
      <div className="flex min-w-0 flex-col p-4">
        <p className="flex items-center gap-2 text-[11px] font-medium">
          <driver.icon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          {driver.label}
        </p>
        <p className="mt-4 text-[26px] leading-none font-medium tracking-[-0.035em] tabular-nums">
          {detail.share}
        </p>
        <p className="mt-2 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {detail.text}
        </p>
        <div
          aria-hidden="true"
          className="mt-4 h-1 overflow-hidden rounded-full bg-foreground/[0.06]"
        >
          <span
            className="block h-full origin-left rounded-full bg-primary/60"
            style={{ transform: `scaleX(${value / 100})` }}
          />
        </div>
      </div>
    )
  }
  return (
    <p className="p-4 text-[11px] leading-relaxed text-muted-foreground">
      {detail.text}
    </p>
  )
}

/** Color supplements the status label; the meter also exposes its value to AT. */
export function UsageLimitRow({ limit }: { limit: UsageLimit }) {
  const value = Number.isFinite(limit.usedPercent)
    ? Math.max(0, Math.min(100, limit.usedPercent))
    : 0
  const status =
    value >= 100
      ? "Limit reached"
      : value >= 90
        ? "Almost at limit"
        : value >= 70
          ? "Getting close"
          : "Available"
  const color =
    value >= 90
      ? "text-destructive"
      : value >= 70
        ? "text-warning"
        : "text-muted-foreground"
  return (
    <div className="min-w-0 rounded-xl bg-foreground/[0.03] p-4">
      <p className="text-[11px] text-muted-foreground">{limit.label}</p>
      <div className="mt-2.5 flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-[22px] leading-none font-medium tracking-[-0.03em] tabular-nums">
          {value}%
        </span>
        <span className={cn("text-[10px]", color)}>{status}</span>
      </div>
      <div
        role="meter"
        aria-label={limit.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value}% used · ${status}`}
        className="my-2.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <div
          className={cn(
            "h-full origin-left rounded-full motion-safe:transition-transform motion-safe:duration-300",
            value >= 90
              ? "bg-destructive"
              : value >= 70
                ? "bg-warning"
                : "bg-primary/70"
          )}
          style={{ transform: `scaleX(${value / 100})` }}
        />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {formatReset(limit) ?? "Reset time not reported"}
      </p>
    </div>
  )
}

/** Card surface. In the masonry column it must not split across columns. */
const CARD =
  "mb-3 break-inside-avoid rounded-2xl border border-border/40 bg-foreground/[0.02] p-5"

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: LucideIcon
  children: React.ReactNode
}) {
  return (
    <section className={CARD}>
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        {Icon && (
          <Icon aria-hidden="true" className={DETAIL_ICON} strokeWidth={1.5} />
        )}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * List-price cost of the recorded tokens. The provider bills a subscription
 * here, so this answers "what would this have cost on the API" — it is not a
 * bill, and the section says how much of the usage it actually covers.
 */
function CostSection({
  pricing,
  provider,
}: {
  pricing: UsagePricing
  provider: string
}) {
  const rows = [
    ["input", "Input", pricing.breakdown.input, "New prompt tokens"],
    [
      "output",
      "Output",
      pricing.breakdown.output,
      "Generated responses & reasoning",
    ],
    [
      "cache-read",
      "Cache read",
      pricing.breakdown.cacheRead,
      "Reused context from cache",
    ],
    [
      "cache-write",
      "Cache write",
      pricing.breakdown.cacheWrite,
      "Context saved to cache",
    ],
  ] as const
  const recorded = pricing.pricedTokens + pricing.unpricedTokens
  const covered = recorded > 0 ? pricing.pricedTokens / recorded : 0
  const percent = (value: number) =>
    value > 0 && value < 0.001
      ? "<0.1%"
      : value > 0.999 && value < 1
        ? ">99.9%"
        : value.toLocaleString(undefined, {
            style: "percent",
            maximumFractionDigits: 1,
          })
  return (
    <section
      aria-labelledby="usage-api-cost-heading"
      className="overflow-hidden rounded-2xl border border-border/40 bg-foreground/[0.02]"
    >
      <div className="p-5 @[640px]/usage:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="usage-api-cost-heading"
            className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight"
          >
            <CoinsIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            API cost equivalent
          </h2>
          <span className="rounded-md border border-border/40 px-2 py-1 text-[10px] font-medium text-muted-foreground">
            {pricing.currency} ·{" "}
            {pricing.hasOverrides ? "Custom rates included" : "API list prices"}
          </span>
        </div>

        <div className="mt-6 grid gap-6 @[760px]/usage:grid-cols-[1.2fr_1fr] @[760px]/usage:items-center">
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">
              {provider} · All recorded usage
            </p>
            <p className="mt-2 text-[38px] leading-none font-semibold tracking-[-0.055em] break-words tabular-nums @[640px]/usage:text-[52px]">
              {formatMoney(pricing.total)}
            </p>
            <p className="mt-3 max-w-[42ch] text-[12px] leading-relaxed text-muted-foreground">
              Estimated value of your tokens at API rates. For comparison only,
              not your subscription bill.
            </p>
          </div>

          <div className="border-t border-border/40 pt-5 @[760px]/usage:border-t-0 @[760px]/usage:border-l @[760px]/usage:pt-0 @[760px]/usage:pl-6">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[12px] font-medium">Token coverage</h3>
              <span className="text-[23px] leading-none font-medium tracking-tight tabular-nums">
                {percent(covered)}
              </span>
            </div>
            <div
              role="meter"
              aria-label="Tokens included in the API cost estimate"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={covered * 100}
              aria-valuetext={`${percent(covered)} of recorded tokens have a known rate`}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]"
            >
              <span
                className="block h-full origin-left rounded-full bg-primary/70"
                style={{ transform: `scaleX(${covered})` }}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground/80 tabular-nums">
                {formatCompact(pricing.pricedTokens)}
              </span>
              {" of "}
              {formatCompact(recorded)} recorded tokens included.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {pricing.unpricedTokens > 0
                ? `${formatCompact(pricing.unpricedTokens)} tokens excluded because their model rates are missing.`
                : "Every recorded token has a known model rate."}
            </p>
          </div>
        </div>

        <dl className="mt-6 grid gap-3 @[440px]/usage:grid-cols-2 @[900px]/usage:grid-cols-4">
          {rows.map(([id, label, value, description]) => {
            const Icon = TOKEN_ICONS[id]
            const share = pricing.total > 0 ? value / pricing.total : 0
            return (
              <div
                key={id}
                className="flex min-w-0 flex-col rounded-xl border border-border/40 bg-foreground/[0.02] p-4"
              >
                <dt className="flex items-center gap-2 text-[12px] font-medium">
                  <Icon
                    aria-hidden="true"
                    className={DETAIL_ICON}
                    strokeWidth={1.5}
                  />
                  {label}
                </dt>
                <dd className="mt-3 text-[24px] leading-none font-medium tracking-[-0.03em] break-words tabular-nums">
                  {formatMoney(value)}
                </dd>
                <dd className="mt-2 flex flex-1 flex-col text-[10px] leading-relaxed text-muted-foreground">
                  <span className="flex-1">{description}</span>
                  <span className="mt-4 flex items-center justify-between gap-2">
                    <span>Share of cost</span>
                    <span className="font-medium text-foreground/80 tabular-nums">
                      {percent(share)}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="mt-1.5 block h-1 overflow-hidden rounded-full bg-foreground/[0.06]"
                  >
                    <span
                      className="block h-full origin-left rounded-full bg-primary/70"
                      style={{ transform: `scaleX(${share})` }}
                    />
                  </span>
                </dd>
              </div>
            )
          })}
        </dl>
      </div>

      <div className="flex items-start gap-3 border-t border-border/40 px-5 py-4 @[640px]/usage:px-6">
        <ReceiptTextIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
        />
        <div className="min-w-0 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
          <h3 className="text-[12px] font-medium text-foreground">
            Pricing details
          </h3>
          <p>
            Token counts are multiplied by each model’s API rates, then added
            together.{" "}
            {pricing.hasOverrides
              ? "Your custom model rates are included in this estimate."
              : "This estimate uses the app’s built-in model price table."}
          </p>
          {pricing.unpricedModels.length > 0 && (
            <div>
              <p>
                {pricing.unpricedModels.length}{" "}
                {pricing.unpricedModels.length === 1
                  ? "model is"
                  : "models are"}{" "}
                missing rates. Add their per-million-token prices to{" "}
                <code className="rounded bg-foreground/[0.06] px-1 py-0.5 text-[10px]">
                  model-prices.json
                </code>{" "}
                to include them.
              </p>
              <ul
                aria-label="Models without prices"
                className="mt-2 flex flex-wrap gap-1.5"
              >
                {pricing.unpricedModels.map((model) => (
                  <li
                    key={model}
                    className="max-w-full rounded-md bg-foreground/[0.04] px-2 py-1 text-[10px] break-words"
                  >
                    {model}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pricing.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
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
    <section className="rounded-2xl border border-border/40 bg-foreground/[0.02] p-5 @[640px]/usage:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight">
          <CoinsIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          API cost equivalent
        </h2>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(snippet)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
          className="gap-1.5 rounded-md text-[11px] text-muted-foreground"
        >
          {copied ? (
            <CheckIcon className="size-3.5" strokeWidth={2} />
          ) : (
            <CopyIcon className="size-3.5" strokeWidth={1.5} />
          )}
          {copied ? "Copied" : "Copy template"}
        </Button>
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-muted-foreground">{children}</p>
}

/** Make the coverage dates scannable without dropping any retention caveats. */
function NoteText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\b\d{4}-\d{2}-\d{2}\b)/g).map((part, index) =>
        /^\d{4}-\d{2}-\d{2}$/.test(part) ? (
          <time
            key={index}
            dateTime={part}
            className="font-medium text-foreground/85 tabular-nums"
          >
            {formatDay(part)}
          </time>
        ) : (
          part
        )
      )}
    </>
  )
}

/**
 * Ranked rows with a share bar. The bar is relative to the largest entry, so
 * the shape of the list is readable at a glance even when one row dominates.
 */
function BarList({
  entries,
  unit,
  renderIcon,
}: {
  entries: UsageEntry[]
  unit: string
  renderIcon?: (entry: UsageEntry) => React.ReactNode
}) {
  const max = entries.reduce((best, entry) => Math.max(best, entry.value), 0)
  if (entries.length === 0) return <Empty>Nothing recorded yet.</Empty>
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <div key={entry.id}>
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2.5 text-[12px]">
              {renderIcon && (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {renderIcon(entry)}
                </span>
              )}
              <span className="truncate" title={entry.label}>
                {entry.label}
              </span>
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
          <div
            className={cn(
              "mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]",
              renderIcon && "ml-6.5"
            )}
          >
            <span
              className="block h-full origin-left rounded-full bg-primary/70 motion-safe:transition-transform motion-safe:duration-300"
              style={{
                transform: `scaleX(${max > 0 ? entry.value / max : 0})`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
