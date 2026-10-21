import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import {
  ActivityIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BadgeCheckIcon,
  BookOpenIcon,
  BoxesIcon,
  BrainIcon,
  CalendarRangeIcon,
  ChevronDownIcon,
  FlameIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderCodeIcon,
  GaugeIcon,
  HistoryIcon,
  InfoIcon,
  LayersIcon,
  MessagesSquareIcon,
  PiggyBankIcon,
  PuzzleIcon,
  TrophyIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { EvilAreaChart } from "@/components/charts/area-chart"
import type { ChartConfig } from "@/components/charts/chart"
import { ProviderIcon } from "@/components/provider-icon"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  CARD,
  DETAIL_ICON,
  ENTER,
  USAGE_PROVIDER_COLOR,
  USAGE_PROVIDER_IDS,
  USAGE_PROVIDER_LABEL,
  enterDelay,
  usageProviderIcon,
} from "@/components/usage/usage-surface"
import {
  USAGE_RANGES,
  activityStreaks,
  cacheHitRate,
  dailySeries,
  formatCompact,
  formatMoney,
  formatMoneyAxis,
  formatShare,
  metricValue,
  modelRows,
  previousPeriodTotal,
  providerTotals,
  rangeDays,
  rangeSummary,
  usageTotals,
  weekdayRhythm,
  type UsageMetric,
  type UsageRangeId,
} from "@/lib/usage-overview"
import type {
  ProviderUsageReport,
  UsageProviderId,
} from "@/services/backend/coreApi"
import { cn } from "@/lib/utils"

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
const HEATMAP_LEVELS = [
  "bg-foreground/[0.05]",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
]
const WEEKS = 53
const DAYS_PER_WEEK = 7
/** Rows run Monday to Sunday; only alternate rows are labelled. */
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""]
const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]
const MODEL_ROWS = 8

/**
 * The token anatomy, from what costs least to what costs most. Shades of the
 * foreground keep it one quiet bar in every theme.
 */
const ANATOMY = [
  { id: "cached", label: "Cached input", shade: "bg-foreground/85" },
  { id: "writes", label: "Cache writes", shade: "bg-foreground/55" },
  { id: "uncached", label: "Uncached input", shade: "bg-foreground/35" },
  { id: "output", label: "Output", shade: "bg-foreground/20" },
] as const

function formatValue(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatMoney(value) : formatCompact(value)
}

function formatDayLabel(date: string, withWeekday = true): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (!Number.isFinite(parsed.getTime())) return date
  return parsed.toLocaleDateString(undefined, {
    ...(withWeekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
  })
}

function prefersStillness(): boolean {
  if (typeof window === "undefined") return true
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
    document.documentElement.classList.contains("animations-disabled")
  )
}

/**
 * Counts a figure up to its new value over 600ms (ease-out), so switching
 * metric or range reads as a change instead of a jump. Off under reduced
 * motion and the app's Animations setting.
 */
function useCountUp(target: number): number {
  const [value, setValue] = useState(target)
  const currentRef = useRef(target)
  useEffect(() => {
    if (prefersStillness()) {
      currentRef.current = target
      setValue(target)
      return
    }
    const from = currentRef.current
    const started = performance.now()
    let frame = 0
    const tick = (time: number) => {
      const progress = Math.min(1, (time - started) / 600)
      const eased = 1 - (1 - progress) ** 3
      currentRef.current = from + (target - from) * eased
      setValue(currentRef.current)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return value
}

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

/** A share as a ring with the percentage inside. */
function ShareRing({
  share,
  color,
  size = 48,
  label,
}: {
  share: number
  color: string
  size?: number
  label: string
}) {
  const radius = size / 2 - 3
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, share))
  return (
    <div
      role="img"
      aria-label={label}
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={3.5}
          className="stroke-foreground/[0.08]"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={3.5}
          strokeLinecap="round"
          stroke={color}
          strokeDasharray={`${clamped * circumference} ${circumference}`}
          className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500"
        />
      </svg>
      <span className="absolute text-[11px] font-semibold tabular-nums">
        {Math.round(clamped * 100)}%
      </span>
    </div>
  )
}

/** A small area line of one provider's days in the range. */
function Sparkline({
  values,
  color,
  className,
}: {
  values: readonly number[]
  color: string
  className?: string
}) {
  const id = useRef(`spark-${Math.random().toString(36).slice(2)}`).current
  const max = Math.max(...values, 0)
  if (values.length < 2 || max <= 0) {
    return <div aria-hidden="true" className={className} />
  }
  const points = values.map((value, index) => [
    (index / (values.length - 1)) * 100,
    30 - (value / max) * 28,
  ])
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`)
    .join(" ")
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className={className}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L100,32 L0,32 Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The Cost and Tokens views of the Usage page. A hero chart carries the
 * range: its figure follows the day under the pointer, chips switch the
 * providers' series on and off, and a strip below sums the range. Provider
 * cards, the token anatomy with the cache, the top models and the weekly
 * rhythm follow, then the activity calendar, highlights and sources.
 */
export function UsageOverview({
  reports,
  loading,
  metric,
  range,
}: {
  reports: readonly ProviderUsageReport[]
  loading: boolean
  metric: UsageMetric
  range: UsageRangeId
}) {
  const providers = useMemo(
    () =>
      USAGE_PROVIDER_IDS.map((id) => reports.find((r) => r.provider === id))
        .filter((report): report is ProviderUsageReport => Boolean(report))
        .filter(
          (report) =>
            report.status !== "unavailable" ||
            report.summary.totalTokens > 0 ||
            report.daily.length > 0
        ),
    [reports]
  )
  const missing = USAGE_PROVIDER_IDS.filter(
    (id) => !providers.some((report) => report.provider === id)
  )
  const rangeInfo = USAGE_RANGES.find((item) => item.id === range)!
  // "Today" is read again with every new report, which is when it matters.
  const dates = useMemo(
    () => rangeDays(providers, rangeInfo.days, Date.now()),
    [providers, rangeInfo.days]
  )
  const dateSet = useMemo(
    () => (rangeInfo.days === null ? null : new Set(dates)),
    [dates, rangeInfo.days]
  )
  const series = useMemo(
    () => dailySeries(providers, dates, metric),
    [providers, dates, metric]
  )
  const [hidden, setHidden] = useState<ReadonlySet<UsageProviderId>>(
    () => new Set()
  )
  const shown = providers
    .map((report) => report.provider)
    .filter((id) => !hidden.has(id))
  const summary = rangeSummary(series, shown, providers)
  const previous = previousPeriodTotal(
    providers,
    shown,
    rangeInfo.days,
    Date.now(),
    metric
  )
  const delta =
    previous !== null && previous > 0
      ? (summary.total - previous) / previous
      : null
  const totals = providers.map((report) => providerTotals(report, dateSet))
  const allValue = totals.reduce(
    (sum, item) => sum + metricValue(item, metric),
    0
  )
  // "All" totals come from the all-time figures, which reach further back
  // than the daily series.
  const rangeTotal =
    range === "all"
      ? totals
          .filter((item) => shown.includes(item.provider))
          .reduce((sum, item) => sum + metricValue(item, metric), 0)
      : summary.total
  const unpricedDays = totals.reduce((sum, item) => sum + item.unpricedDays, 0)

  const [hoverDate, setHoverDate] = useState<string | null>(null)
  const hoverRow = hoverDate
    ? (series.find((row) => row.date === hoverDate) ?? null)
    : null
  const hoverValue = hoverRow
    ? shown.reduce((sum, id) => sum + (Number(hoverRow[id]) || 0), 0)
    : null
  const counted = useCountUp(rangeTotal)
  const heroFigure = hoverValue ?? counted

  const chartConfig = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        providers.map((report) => [
          report.provider,
          {
            label: USAGE_PROVIDER_LABEL[report.provider],
            colors: { light: [USAGE_PROVIDER_COLOR[report.provider]] },
          },
        ])
      ),
    [providers]
  )
  const firstLoad = providers.length === 0 && loading
  const rangeLabel =
    range === "all" ? "All time" : `Last ${rangeInfo.days} days`
  const metricLabel = metric === "cost" ? "Spend at API prices" : "Tokens"

  const toggle = (id: UsageProviderId) =>
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      // Keep at least one series on screen.
      else if (shown.length > 1) next.add(id)
      return next
    })

  let section = 0
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label={metric === "cost" ? "Cost over time" : "Tokens over time"}
        aria-busy={firstLoad}
        style={enterDelay(section++)}
        className={cn(ENTER, CARD, "overflow-hidden")}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5 px-6 pt-6">
          <div className="min-w-0">
            <p
              aria-live="polite"
              className="text-[11px] text-muted-foreground tabular-nums"
            >
              {hoverDate
                ? formatDayLabel(hoverDate)
                : `${metricLabel} · ${rangeLabel}`}
            </p>
            {firstLoad ? (
              <Skeleton className="mt-3 h-11 w-48" />
            ) : (
              <p className="mt-2 text-[44px] leading-none font-semibold tracking-[-0.05em] tabular-nums">
                {formatValue(heroFigure, metric)}
              </p>
            )}
            <div className="mt-3 flex min-h-5 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
              {hoverRow ? (
                shown.map((id) => (
                  <span key={id} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full"
                      style={{ background: USAGE_PROVIDER_COLOR[id] }}
                    />
                    {USAGE_PROVIDER_LABEL[id]}{" "}
                    <span className="text-foreground/85">
                      {formatValue(Number(hoverRow[id]) || 0, metric)}
                    </span>
                  </span>
                ))
              ) : (
                <>
                  {delta !== null && (
                    <span
                      title={`Previous ${rangeInfo.days} days: ${formatValue(previous ?? 0, metric)}`}
                      className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/85"
                    >
                      {delta >= 0 ? (
                        <ArrowUpRightIcon
                          aria-hidden="true"
                          className="size-3"
                          strokeWidth={2}
                        />
                      ) : (
                        <ArrowDownRightIcon
                          aria-hidden="true"
                          className="size-3"
                          strokeWidth={2}
                        />
                      )}
                      {formatShare(Math.abs(delta))}
                      <span className="font-normal text-muted-foreground">
                        vs previous {rangeInfo.days} days
                      </span>
                    </span>
                  )}
                  <span>
                    {summary.sessions.toLocaleString()}{" "}
                    {summary.sessions === 1 ? "session" : "sessions"}
                  </span>
                  {metric === "cost" && (
                    <span className="flex items-center gap-1">
                      <span aria-hidden="true" className="mr-1.5">
                        ·
                      </span>
                      API estimate
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="About the API estimate"
                            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                          >
                            <InfoIcon className="size-3" strokeWidth={1.5} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-[260px]">
                          What these tokens would cost at the providers&apos;
                          published API rates. Subscriptions bill differently,
                          so this is not your bill.
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          <div
            role="group"
            aria-label="Providers in the chart"
            className="flex flex-wrap gap-2"
          >
            {totals.map((item) => {
              const icon = usageProviderIcon(item.provider)
              const on = !hidden.has(item.provider)
              const value = metricValue(item, metric)
              return (
                <button
                  key={item.provider}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(item.provider)}
                  title={on ? "Hide in the chart" : "Show in the chart"}
                  className={cn(
                    "flex min-w-[150px] items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-[opacity,background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.98]",
                    on
                      ? "border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.05]"
                      : "border-dashed border-border/60 opacity-55 hover:opacity-80"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      background: on
                        ? USAGE_PROVIDER_COLOR[item.provider]
                        : "transparent",
                      boxShadow: `inset 0 0 0 1.5px ${USAGE_PROVIDER_COLOR[item.provider]}`,
                    }}
                  />
                  {icon && (
                    <ProviderIcon provider={icon} className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium">
                      {USAGE_PROVIDER_LABEL[item.provider]}
                    </span>
                    <span className="block text-[10px] text-muted-foreground tabular-nums">
                      {metric === "cost" && item.cost === null
                        ? "No rates"
                        : formatValue(value, metric)}{" "}
                      · {formatShare(allValue > 0 ? value / allValue : 0)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-3 pt-5 pb-1">
          <EvilAreaChart
            key={`${metric}-${range}-${shown.join(",")}`}
            data={series}
            config={chartConfig}
            curveType="monotone"
            animationType="left-to-right"
            isLoading={firstLoad}
            className="aspect-auto h-[280px] w-full"
            chartProps={{
              margin: { top: 8, right: 12, bottom: 0, left: 0 },
              onMouseMove: (state) =>
                setHoverDate(
                  state.isTooltipActive && typeof state.activeLabel === "string"
                    ? state.activeLabel
                    : null
                ),
              onMouseLeave: () => setHoverDate(null),
            }}
          >
            <EvilAreaChart.Grid />
            <EvilAreaChart.XAxis
              dataKey="date"
              tickFormatter={(value: string) => formatDayLabel(value, false)}
              minTickGap={48}
              tick={{ fontSize: 10 }}
            />
            <EvilAreaChart.YAxis
              tickFormatter={(value: number) =>
                metric === "cost"
                  ? formatMoneyAxis(value)
                  : formatCompact(value)
              }
              tick={{ fontSize: 10 }}
            />
            <EvilAreaChart.Tooltip hideContent />
            {providers
              .filter((report) => shown.includes(report.provider))
              .map((report) => (
                <EvilAreaChart.Area
                  key={report.provider}
                  dataKey={report.provider}
                  variant="gradient"
                  strokeVariant="solid"
                  strokeWidth={1.75}
                >
                  <EvilAreaChart.ActiveDot variant="border" />
                </EvilAreaChart.Area>
              ))}
          </EvilAreaChart>
        </div>

        <dl className="grid grid-cols-2 gap-y-4 border-t border-border/40 py-4 @[760px]/usage:grid-cols-4 @[760px]/usage:divide-x @[760px]/usage:divide-border/40">
          {[
            {
              label: "Sessions",
              value: summary.sessions.toLocaleString(),
              hint: rangeLabel,
            },
            {
              label: "Active days",
              value: summary.activeDays.toLocaleString(),
              hint: `of ${dates.length.toLocaleString()} days`,
            },
            {
              label: "Per day",
              value: formatValue(summary.perDay, metric),
              hint: "Average over the range",
            },
            {
              label: "Peak day",
              value: summary.peak
                ? formatValue(summary.peak.value, metric)
                : "—",
              hint: summary.peak
                ? formatDayLabel(summary.peak.date)
                : "No activity",
            },
          ].map((cell) => (
            <div key={cell.label} className="min-w-0 px-6">
              <dt className="text-[10px] text-muted-foreground">
                {cell.label}
              </dt>
              <dd className="mt-1 text-[16px] font-semibold tracking-[-0.02em] tabular-nums">
                {cell.value}
              </dd>
              <dd className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {cell.hint}
              </dd>
            </div>
          ))}
        </dl>
        {metric === "cost" && unpricedDays > 0 && (
          <p className="flex items-start gap-1.5 border-t border-border/40 px-6 py-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon
              aria-hidden="true"
              className="mt-0.5 size-3 shrink-0"
              strokeWidth={1.5}
            />
            {unpricedDays} {unpricedDays === 1 ? "day" : "days"} in this range
            kept only token totals, without the per-model split a cost needs.
          </p>
        )}
      </section>

      <div className="grid gap-4 @[760px]/usage:grid-cols-2">
        {totals.map((item) => {
          const report = providers.find((r) => r.provider === item.provider)!
          return (
            <ProviderCard
              key={item.provider}
              report={report}
              value={metricValue(item, metric)}
              share={allValue > 0 ? metricValue(item, metric) / allValue : 0}
              other={
                metric === "cost"
                  ? `${formatCompact(item.tokens)} tokens`
                  : item.cost === null
                    ? "No rates"
                    : formatMoney(item.cost)
              }
              sessions={item.sessions}
              priced={metric !== "cost" || item.cost !== null}
              metric={metric}
              values={series.map((row) => Number(row[item.provider]) || 0)}
              style={enterDelay(section++)}
            />
          )
        })}
        {missing.map((id) => (
          <MissingProviderCard
            key={id}
            provider={id}
            report={reports.find((item) => item.provider === id) ?? null}
            loading={loading}
            style={enterDelay(section++)}
          />
        ))}
      </div>

      {providers.length > 0 && (
        <div className="grid gap-4 @[880px]/usage:grid-cols-3">
          <AnatomyCard reports={providers} style={enterDelay(section++)} />
          <CacheCard reports={providers} style={enterDelay(section++)} />
        </div>
      )}

      {providers.length > 0 && (
        <div className="grid gap-4 @[880px]/usage:grid-cols-3">
          <ModelsCard
            reports={providers}
            metric={metric}
            style={enterDelay(section++)}
          />
          <div className="flex flex-col gap-4">
            <RhythmCard
              rows={series}
              providers={shown}
              metric={metric}
              rangeLabel={rangeLabel}
              peak={summary.peak}
              style={enterDelay(section++)}
            />
            <StreaksCard reports={providers} style={enterDelay(section++)} />
          </div>
        </div>
      )}

      <ActivityCard
        reports={providers}
        metric={metric}
        style={enterDelay(section++)}
      />

      {providers.some(
        (report) => report.insights.length > 0 || report.lists.length > 0
      ) && <HighlightsCard reports={providers} style={enterDelay(section++)} />}

      {providers.length > 0 && (
        <AboutCard reports={providers} style={enterDelay(section++)} />
      )}
    </div>
  )
}

function ProviderCard({
  report,
  value,
  share,
  other,
  sessions,
  priced,
  metric,
  values,
  style,
}: {
  report: ProviderUsageReport
  value: number
  share: number
  other: string
  sessions: number
  priced: boolean
  metric: UsageMetric
  values: readonly number[]
  style: CSSProperties
}) {
  const icon = usageProviderIcon(report.provider)
  const label = USAGE_PROVIDER_LABEL[report.provider]
  const color = USAGE_PROVIDER_COLOR[report.provider]
  const topModel = modelRows([report], metric)[0] ?? null
  const tokens = report.summary.tokens
  const hitRate = cacheHitRate({
    cachedInput: tokens.cacheRead,
    uncachedInput: tokens.input,
    cacheWrites: tokens.cacheWrite,
  })
  const activeDays = values.filter((item) => item > 0).length
  return (
    <article
      aria-label={label}
      style={style}
      className={cn(ENTER, CARD, "flex flex-col p-5")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/[0.05]">
            {icon && <ProviderIcon provider={icon} className="size-5" />}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold">{label}</h3>
            <p className="truncate text-[11px] text-muted-foreground">
              {[report.plan, report.version ? `v${report.version}` : null]
                .filter(Boolean)
                .join(" · ") || "Local history"}
            </p>
          </div>
        </div>
        <ShareRing
          share={share}
          color={color}
          label={`${formatShare(share)} of the ${metric === "cost" ? "cost" : "tokens"}`}
        />
      </div>
      <div className="mt-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[28px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
            {priced ? formatValue(value, metric) : "—"}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
            {other} · {sessions.toLocaleString()}{" "}
            {sessions === 1 ? "session" : "sessions"}
          </p>
        </div>
        <Sparkline
          values={values}
          color={color}
          className="h-11 w-[42%] max-w-[180px] shrink-0"
        />
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border/30 pt-4">
        <div className="min-w-0">
          <dt className="text-[10px] text-muted-foreground">Top model</dt>
          <dd
            className="mt-1 truncate text-[12px] font-medium"
            title={topModel?.label}
          >
            {topModel?.label ?? "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-muted-foreground">Cache hits</dt>
          <dd className="mt-1 text-[12px] font-medium tabular-nums">
            {hitRate > 0 ? formatShare(hitRate) : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] text-muted-foreground">Active days</dt>
          <dd className="mt-1 text-[12px] font-medium tabular-nums">
            {activeDays} / {values.length}
          </dd>
        </div>
      </dl>
    </article>
  )
}

function MissingProviderCard({
  provider,
  report,
  loading,
  style,
}: {
  provider: UsageProviderId
  report: ProviderUsageReport | null
  loading: boolean
  style: CSSProperties
}) {
  const icon = usageProviderIcon(provider)
  return (
    <article
      aria-label={USAGE_PROVIDER_LABEL[provider]}
      style={style}
      className={cn(
        ENTER,
        "flex items-center gap-3 rounded-2xl border border-dashed border-border/50 p-5 text-muted-foreground"
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground/[0.04]">
        {icon && <ProviderIcon provider={icon} className="size-5 opacity-60" />}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground/80">
          {USAGE_PROVIDER_LABEL[provider]}
        </p>
        <p className="text-[11px]">
          {report?.status === "error"
            ? "Couldn't read its history."
            : report
              ? "Not installed on this machine."
              : loading
                ? "Reading its history…"
                : "No report."}
        </p>
      </div>
    </article>
  )
}

function AnatomyCard({
  reports,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  style: CSSProperties
}) {
  const totals = usageTotals(reports)
  const values: Record<(typeof ANATOMY)[number]["id"], number> = {
    cached: totals.cachedInput,
    writes: totals.cacheWrites,
    uncached: totals.uncachedInput,
    output: totals.output,
  }
  const sum = Object.values(values).reduce((acc, value) => acc + value, 0)
  const reasoning = reports.reduce(
    (acc, report) => acc + report.summary.tokens.reasoning,
    0
  )
  return (
    <section
      aria-label="Where the tokens go"
      style={style}
      className={cn(ENTER, CARD, "p-5 @[880px]/usage:col-span-2")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <LayersIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Where the tokens go
        </h2>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          All time · {formatCompact(totals.processed)} processed
        </span>
      </div>
      <div
        role="img"
        aria-label={ANATOMY.map(
          (part) =>
            `${part.label} ${formatShare(sum > 0 ? values[part.id] / sum : 0)}`
        ).join(", ")}
        className="mt-5 flex h-3 gap-0.5 overflow-hidden rounded-full bg-foreground/[0.04]"
      >
        {ANATOMY.map((part) =>
          values[part.id] > 0 ? (
            <span
              key={part.id}
              className={cn(
                "h-full first:rounded-l-full last:rounded-r-full",
                part.shade
              )}
              style={{ width: `${(values[part.id] / sum) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 @[620px]/usage:grid-cols-4">
        {ANATOMY.map((part) => (
          <div key={part.id} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-[3px]", part.shade)}
              />
              {part.label}
            </dt>
            <dd className="mt-1.5 text-[18px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
              {formatCompact(values[part.id])}
            </dd>
            <dd className="mt-1 text-[10px] text-muted-foreground tabular-nums">
              {formatShare(sum > 0 ? values[part.id] / sum : 0)}
            </dd>
          </div>
        ))}
      </dl>
      {reasoning > 0 && (
        <p className="mt-4 flex items-center gap-2 border-t border-border/30 pt-3 text-[11px] text-muted-foreground">
          <BrainIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Output includes{" "}
          <span className="text-foreground/85 tabular-nums">
            {formatCompact(reasoning)}
          </span>{" "}
          reasoning tokens.
        </p>
      )}
    </section>
  )
}

function CacheCard({
  reports,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  style: CSSProperties
}) {
  const totals = usageTotals(reports)
  const hitRate = cacheHitRate(totals)
  return (
    <section
      aria-label="Cache savings"
      style={style}
      className={cn(ENTER, CARD, "flex flex-col p-5")}
    >
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <PiggyBankIcon
          aria-hidden="true"
          className={DETAIL_ICON}
          strokeWidth={1.5}
        />
        Cache savings
      </h2>
      <p className="mt-4 text-[32px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
        {totals.cacheSavings === null ? "—" : formatMoney(totals.cacheSavings)}
      </p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {totals.cacheSavings === null
          ? "No published rates to compare against."
          : "Saved against paying the full input rate, all time."}
      </p>
      <div className="mt-auto flex items-center gap-3 pt-5">
        <ShareRing
          share={hitRate}
          color="var(--foreground)"
          size={52}
          label={`${formatShare(hitRate)} of input came from the cache`}
        />
        <p className="text-[12px] leading-snug text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">
            {formatShare(hitRate)}
          </span>{" "}
          of all input was read back from the prompt cache.
        </p>
      </div>
    </section>
  )
}

function ModelsCard({
  reports,
  metric,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  metric: UsageMetric
  style: CSSProperties
}) {
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => modelRows(reports, metric), [reports, metric])
  const visible = expanded ? rows : rows.slice(0, MODEL_ROWS)
  const max = rows.reduce(
    (best, row) => Math.max(best, metricValue(row, metric)),
    0
  )
  return (
    <section
      aria-label="Top models"
      style={style}
      className={cn(ENTER, CARD, "p-5 @[880px]/usage:col-span-2")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <TrophyIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Top models
        </h2>
        <span className="text-[10px] text-muted-foreground">
          All time · by {metric === "cost" ? "cost" : "tokens"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-[12px] text-muted-foreground">
          No model recorded yet.
        </p>
      ) : (
        <ol className="mt-3 divide-y divide-border/25">
          {visible.map((row, index) => {
            const icon = usageProviderIcon(row.provider)
            const value = metricValue(row, metric)
            return (
              <li
                key={row.key}
                className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 py-2.5"
              >
                <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2 text-[12px]">
                    {icon && (
                      <ProviderIcon
                        provider={icon}
                        className="size-3.5 shrink-0"
                      />
                    )}
                    <span className="truncate" title={row.label}>
                      {row.label}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <span
                      className="block h-full origin-left rounded-full opacity-75 motion-safe:transition-transform motion-safe:duration-500"
                      style={{
                        transform: `scaleX(${max > 0 ? value / max : 0})`,
                        background: USAGE_PROVIDER_COLOR[row.provider],
                      }}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[12px] font-medium tabular-nums">
                    {metric === "cost" && row.cost === null
                      ? "—"
                      : formatValue(value, metric)}
                  </p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    {formatShare(row.share)}
                    {metric === "cost"
                      ? ` · ${formatCompact(row.tokens)}`
                      : row.cost !== null
                        ? ` · ${formatMoney(row.cost)}`
                        : ""}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {rows.length > MODEL_ROWS && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 h-7 gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 transition-transform duration-150",
              expanded && "rotate-180"
            )}
            strokeWidth={1.5}
          />
          {expanded ? "Show fewer" : `Show all ${rows.length} models`}
        </Button>
      )}
    </section>
  )
}

function RhythmCard({
  rows,
  providers,
  metric,
  rangeLabel,
  peak,
  style,
}: {
  rows: Parameters<typeof weekdayRhythm>[0]
  providers: readonly string[]
  metric: UsageMetric
  rangeLabel: string
  peak: { date: string; value: number } | null
  style: CSSProperties
}) {
  const rhythm = weekdayRhythm(rows, providers)
  const max = Math.max(...rhythm, 0)
  const busiest = max > 0 ? rhythm.indexOf(max) : -1
  return (
    <section
      aria-label="Weekly rhythm"
      style={style}
      className={cn(ENTER, CARD, "flex flex-1 flex-col p-5")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <CalendarRangeIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Weekly rhythm
        </h2>
        <span className="text-[10px] text-muted-foreground">{rangeLabel}</span>
      </div>
      <div
        role="img"
        aria-label={WEEKDAY_NAMES.map(
          (name, index) => `${name} ${formatValue(rhythm[index], metric)}`
        ).join(", ")}
        className="mt-5 flex min-h-32 flex-1 items-end gap-2"
      >
        {rhythm.map((value, index) => (
          <div
            key={WEEKDAY_NAMES[index]}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2"
          >
            <span
              title={`${WEEKDAY_NAMES[index]}: ${formatValue(value, metric)} on average`}
              className={cn(
                "w-full max-w-5 rounded-full motion-safe:transition-[height] motion-safe:duration-500",
                index === busiest ? "bg-foreground/80" : "bg-foreground/15"
              )}
              style={{
                height: `${max > 0 ? Math.max(4, (value / max) * 100) : 4}%`,
              }}
            />
            <span
              className={cn(
                "text-[10px]",
                index === busiest
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {WEEKDAY_NAMES[index].slice(0, 2)}
            </span>
          </div>
        ))}
      </div>
      <div className="space-y-1.5 pt-5 text-[11px] text-muted-foreground">
        <p>
          Busiest:{" "}
          <span className="font-medium text-foreground">
            {busiest >= 0 ? WEEKDAY_NAMES[busiest] : "—"}
          </span>
          {busiest >= 0 && (
            <span className="tabular-nums">
              {" "}
              · {formatValue(rhythm[busiest], metric)} on average
            </span>
          )}
        </p>
        {peak && (
          <p>
            Peak day:{" "}
            <span className="font-medium text-foreground">
              {formatDayLabel(peak.date)}
            </span>
            <span className="tabular-nums">
              {" "}
              · {formatValue(peak.value, metric)}
            </span>
          </p>
        )}
      </div>
    </section>
  )
}

function StreaksCard({
  reports,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  style: CSSProperties
}) {
  const streaks = activityStreaks(reports, Date.now())
  const best = streaks.longest > 0 && streaks.current >= streaks.longest
  return (
    <section
      aria-label="Streaks"
      style={style}
      className={cn(ENTER, CARD, "p-5")}
    >
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <FlameIcon
          aria-hidden="true"
          className={DETAIL_ICON}
          strokeWidth={1.5}
        />
        Streaks
      </h2>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-[10px] text-muted-foreground">Current</dt>
          <dd className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[26px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
              {streaks.current}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {streaks.current === 1 ? "day" : "days"}
            </span>
          </dd>
          <dd className="mt-1 text-[10px] text-muted-foreground">
            {best
              ? "Your longest yet"
              : streaks.current > 0
                ? "In a row, still going"
                : "Starts with your next chat"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-muted-foreground">Longest</dt>
          <dd className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[26px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
              {streaks.longest}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {streaks.longest === 1 ? "day" : "days"}
            </span>
          </dd>
          <dd className="mt-1 truncate text-[10px] text-muted-foreground">
            {streaks.longestEnd
              ? `Until ${formatDayLabel(streaks.longestEnd, false)}`
              : "No activity yet"}
          </dd>
        </div>
      </dl>
    </section>
  )
}

/** Monday of the week `timestamp` falls in, at local midnight. */
function weekStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

function ActivityCard({
  reports,
  metric,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  metric: UsageMetric
  style: CSSProperties
}) {
  const [hovered, setHovered] = useState<{
    date: string
    amount: number
  } | null>(null)
  const calendar = useMemo(() => {
    const byDate = new Map<string, number>()
    for (const report of reports) {
      for (const point of report.daily) {
        const value = metric === "cost" ? (point.cost ?? 0) : point.tokens
        byDate.set(point.date, (byDate.get(point.date) ?? 0) + value)
      }
    }
    const lastWeek = weekStart(Date.now())
    const start = new Date(lastWeek)
    start.setDate(start.getDate() - (WEEKS - 1) * DAYS_PER_WEEK)
    const days = Array.from({ length: WEEKS * DAYS_PER_WEEK }, (_, index) => {
      // Cells run down each column, so a column is one calendar week.
      const date = new Date(start)
      date.setDate(date.getDate() + index)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      return {
        date: key,
        timestamp: date.getTime(),
        amount: byDate.get(key) ?? 0,
      }
    })
    const max = days.reduce((best, day) => Math.max(best, day.amount), 0)
    const months: Array<{ key: string; label: string }> = []
    let previous = ""
    for (let week = 0; week < WEEKS; week += 1) {
      const first = days[week * DAYS_PER_WEEK]
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
    const activeDays = days.filter((day) => day.amount > 0).length
    return { days, max, months, activeDays }
  }, [reports, metric])

  return (
    <section
      aria-label="Activity"
      style={style}
      className={cn(ENTER, CARD, "p-5")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <ActivityIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Activity
        </h2>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {hovered
            ? `${
                hovered.amount > 0
                  ? formatValue(hovered.amount, metric)
                  : "Nothing"
              } · ${formatDayLabel(hovered.date)}`
            : `${calendar.activeDays} active days in the last year`}
        </p>
      </div>
      <div className="mt-5 overflow-x-auto pb-1">
        <div className="flex min-w-[740px] gap-2">
          <div className="grid shrink-0 grid-rows-7 gap-[3px] self-stretch text-[9px] text-muted-foreground/70">
            {WEEKDAYS.map((day, index) => (
              <span key={index} className="flex items-center leading-none">
                {day}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="grid grid-flow-col grid-rows-7 gap-[3px]"
              onMouseLeave={() => setHovered(null)}
            >
              {calendar.days.map((day) => {
                const level =
                  calendar.max === 0 || day.amount === 0
                    ? 0
                    : Math.min(
                        4,
                        Math.max(
                          1,
                          Math.ceil(Math.sqrt(day.amount / calendar.max) * 4)
                        )
                      )
                return (
                  <span
                    key={day.date}
                    onMouseEnter={() =>
                      setHovered({ date: day.date, amount: day.amount })
                    }
                    className={cn(
                      "aspect-square rounded-[3px] outline outline-transparent transition-[outline-color] duration-150 hover:outline-foreground/30",
                      HEATMAP_LEVELS[level]
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
          <span key={level} className={cn("size-2.5 rounded-[3px]", level)} />
        ))}
        <span>More</span>
      </div>
    </section>
  )
}

function HighlightsCard({
  reports,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  style: CSSProperties
}) {
  return (
    <section
      aria-label="Highlights"
      style={style}
      className={cn(
        ENTER,
        "grid gap-3",
        reports.length > 1 && "@[880px]/usage:grid-cols-2"
      )}
    >
      {reports.map((report) => {
        const icon = usageProviderIcon(report.provider)
        return (
          <div key={report.provider} className={cn(CARD, "p-5")}>
            <h2 className="flex items-center gap-2 text-[13px] font-semibold">
              {icon && (
                <ProviderIcon provider={icon} className="size-4 shrink-0" />
              )}
              {USAGE_PROVIDER_LABEL[report.provider]}
            </h2>
            {report.insights.length > 0 && (
              <dl className="mt-4 divide-y divide-border/30">
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
              </dl>
            )}
            {report.lists.map((list) => {
              const Icon = LIST_ICONS[list.id] ?? LayersIcon
              const max = list.entries.reduce(
                (best, entry) => Math.max(best, entry.value),
                0
              )
              return (
                <div
                  key={list.id}
                  className="mt-5 border-t border-border/30 pt-4"
                >
                  <h3 className="flex items-center gap-2 text-[12px] font-medium">
                    <Icon
                      aria-hidden="true"
                      className={DETAIL_ICON}
                      strokeWidth={1.5}
                    />
                    {list.title}
                  </h3>
                  <div className="mt-3 space-y-3">
                    {list.entries.slice(0, 6).map((entry) => (
                      <div key={entry.id}>
                        <div className="flex items-center justify-between gap-3 text-[12px]">
                          <span className="truncate" title={entry.label}>
                            {entry.label}
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {formatCompact(entry.value)}
                            {list.unit ? ` ${list.unit}` : ""}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                          <span
                            className="block h-full origin-left rounded-full bg-primary/70"
                            style={{
                              transform: `scaleX(${max > 0 ? entry.value / max : 0})`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </section>
  )
}

function AboutCard({
  reports,
  style,
}: {
  reports: readonly ProviderUsageReport[]
  style: CSSProperties
}) {
  const unpriced = reports.flatMap(
    (report) => report.pricing?.unpricedModels ?? []
  )
  const pricesFile = reports.find((report) => report.pricesFile)?.pricesFile
  const notes = reports.flatMap((report) => [
    ...report.notes.map((note) => ({ provider: report.provider, note })),
    ...(report.pricing?.notes ?? []).map((note) => ({
      provider: report.provider,
      note,
    })),
  ])
  const newest = Math.max(
    0,
    ...reports.map((report) => Date.parse(report.fetchedAt) || 0)
  )
  return (
    <section
      aria-label="About these numbers"
      style={style}
      className={cn(ENTER, CARD, "overflow-hidden")}
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
        {newest > 0 && (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <HistoryIcon
              aria-hidden="true"
              className="size-3"
              strokeWidth={1.5}
            />
            Read{" "}
            {new Date(newest).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      <ul className="grid gap-x-6 gap-y-4 px-5 py-4 @[760px]/usage:grid-cols-2">
        {notes.map(({ provider, note }) => (
          <li key={`${provider}:${note}`} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]"
            >
              <FileTextIcon className={DETAIL_ICON} strokeWidth={1.5} />
            </span>
            <p className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {USAGE_PROVIDER_LABEL[provider as UsageProviderId]}:
              </span>{" "}
              {note}
            </p>
          </li>
        ))}
        {unpriced.length > 0 && (
          <li className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]"
            >
              <InfoIcon className={DETAIL_ICON} strokeWidth={1.5} />
            </span>
            <p className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
              No published rate for {unpriced.join(", ")}, so their tokens are
              not in the cost.
              {pricesFile ? ` Add rates in ${pricesFile}.` : ""}
            </p>
          </li>
        )}
      </ul>
    </section>
  )
}
