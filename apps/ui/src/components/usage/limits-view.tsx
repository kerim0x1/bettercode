import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  ActivityIcon,
  BookOpenIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CircleCheckIcon,
  GaugeIcon,
  HourglassIcon,
  InfoIcon,
  LayersIcon,
  MessagesSquareIcon,
  OctagonAlertIcon,
  RotateCwIcon,
  TimerIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/provider-icon"
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
import { useUsageStore } from "@/lib/usage-store"
import {
  LIMITS_POLL_MS,
  applyLimitReadings,
  describeLimit,
  formatAgo,
  formatCountdown,
  limitPace,
  limitReadingKey,
  limitResetAt,
  limitStatus,
  limitTone,
  limitTrend,
  limitWindowMs,
  loadLimitReadings,
  remainingPercent,
  resetLabelText,
  resetTimelineSpan,
  saveLimitReadings,
  timelineLanes,
  type LimitPace,
  type LimitReading,
  type LimitReadings,
  type LimitTone,
} from "@/lib/limits"
import type {
  ProviderUsageReport,
  UsageLimit,
  UsageProviderId,
} from "@/services/backend/coreApi"
import { cn } from "@/lib/utils"

const SIGN_IN: Record<UsageProviderId, string> = {
  claude: "claude auth login",
  codex: "codex login",
  grok: "grok login",
}

const EMPTY_HINT: Record<UsageProviderId, string> = {
  claude:
    "Claude Code's /usage report named no limit windows. Subscription accounts show their session and weekly limits here.",
  codex:
    "Codex records its limits with each turn, so they appear after your next Codex chat.",
  grok: "Grok reports no limits.",
}

const SOURCE: Record<UsageProviderId, string> = {
  claude: "Claude Code: read from its /usage report on this device.",
  codex: "Codex: recorded with each turn, so as fresh as your last Codex chat.",
  grok: "Grok: not read.",
}

const TONE_TEXT: Record<LimitTone, string> = {
  normal: "text-muted-foreground",
  low: "text-warning",
  critical: "text-destructive",
}
const TONE_FILL: Record<LimitTone, string> = {
  normal: "bg-primary/70",
  low: "bg-warning",
  critical: "bg-destructive",
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
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

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden"
  )
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

interface LimitWindow {
  provider: UsageProviderId
  limit: UsageLimit
  remaining: number
  tone: LimitTone
  resetAt: number | null
  reading: LimitReading | undefined
  pace: LimitPace | null
}

/** One provider's limits with what the view derives from them. */
function limitWindows(
  report: ProviderUsageReport,
  readings: LimitReadings,
  now: number
): LimitWindow[] {
  // Claude prints its reset as a sentence; read it against when it was printed.
  const printed = Date.parse(report.limitsObservedAt ?? report.fetchedAt)
  const reference = Number.isFinite(printed) ? printed : now
  return report.limits.map((limit) => {
    const remaining = remainingPercent(limit)
    const resetAt = limitResetAt(limit, reference)
    return {
      provider: report.provider,
      limit,
      remaining,
      tone: limitTone(remaining),
      resetAt,
      reading: readings[limitReadingKey(report.provider, limit.id)],
      pace: limitPace({
        usedPercent: limit.usedPercent,
        resetAt,
        windowMs: limitWindowMs(limit.label),
        now,
      }),
    }
  })
}

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

/**
 * The CLI nests limit details under a window heading by indenting them, and
 * the details are structured data written as prose. Parsing them back into
 * a share, a label and its items is what lets the card lay them out.
 */
function limitGroups(notes: readonly string[]): {
  groups: LimitGroup[]
  intro: string[]
} {
  const groups: LimitGroup[] = []
  const intro: string[] = []
  for (const line of notes) {
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
}

/**
 * Ring color for a window: the provider's color, fainter for each further
 * window, or the warning / destructive tone once a window runs low.
 */
function ringColor(
  provider: UsageProviderId,
  index: number,
  tone: LimitTone
): string {
  if (tone === "critical") return "var(--destructive)"
  if (tone === "low") return "var(--warning)"
  const strength = [100, 60, 36, 22][Math.min(index, 3)]
  return `color-mix(in oklab, ${USAGE_PROVIDER_COLOR[provider]} ${strength}%, transparent)`
}

const VERDICT: Record<
  "none" | "clear" | "close" | "almost" | "reached",
  { label: string; icon: LucideIcon; pill: string }
> = {
  none: {
    label: "No limits yet",
    icon: GaugeIcon,
    pill: "bg-foreground/[0.06] text-muted-foreground",
  },
  clear: {
    label: "All clear",
    icon: CircleCheckIcon,
    pill: "bg-success/12 text-success",
  },
  close: {
    label: "Getting close",
    icon: TriangleAlertIcon,
    pill: "bg-warning/12 text-warning",
  },
  almost: {
    label: "Almost at a limit",
    icon: TriangleAlertIcon,
    pill: "bg-destructive/12 text-destructive",
  },
  reached: {
    label: "Limit reached",
    icon: OctagonAlertIcon,
    pill: "bg-destructive/12 text-destructive",
  },
}

/**
 * The Limits view of the Usage page. A verdict card says in one sentence
 * how much room is left and when the next window refills; each provider
 * shows its windows as concentric rings beside their numbers; a timeline
 * places every reset ahead; Pace compares use with time. It reads the shared
 * `/usage/providers` reports and, while it is shown and the window is
 * visible, asks again every 30 seconds; the backend answers with its stored
 * limits and refreshes stale Claude limits behind the request.
 */
export function LimitsView() {
  const reports = useUsageStore((s) => s.reports)
  const loading = useUsageStore((s) => s.loading)
  const visible = useDocumentVisible()
  const [now, setNow] = useState(() => Date.now())
  const lastPollRef = useRef(0)

  // Countdowns and "12s ago" tick while the view can be seen.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible])

  // Poll while visible. The store keeps a 30 s copy, so each poll waits until
  // that copy is due (or 30 s after a failed attempt) instead of a fixed beat
  // that would land just inside the copy's lifetime and skip every other read.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let timer: number | undefined
    const schedule = () => {
      if (cancelled) return
      const since = Math.max(
        useUsageStore.getState().loadedAt,
        lastPollRef.current
      )
      timer = window.setTimeout(
        () => {
          lastPollRef.current = Date.now()
          void useUsageStore.getState().load().finally(schedule)
        },
        Math.max(0, since + LIMITS_POLL_MS - Date.now())
      )
    }
    schedule()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [visible])

  // The previous different reading of each limit, for the trend arrows.
  const [readings, setReadings] = useState<LimitReadings>(loadLimitReadings)
  const readingsRef = useRef(readings)
  useEffect(() => {
    const current = reports.flatMap((report) =>
      report.limits.map((limit) => ({
        provider: report.provider,
        id: limit.id,
        remaining: remainingPercent(limit),
      }))
    )
    if (current.length === 0) return
    const next = applyLimitReadings(readingsRef.current, current, Date.now())
    if (next === readingsRef.current) return
    readingsRef.current = next
    saveLimitReadings(next)
    setReadings(next)
  }, [reports])

  const providers = USAGE_PROVIDER_IDS.map((id) => ({
    id,
    report: reports.find((report) => report.provider === id) ?? null,
  }))
  const windows = useMemo(
    () =>
      USAGE_PROVIDER_IDS.flatMap((id) => {
        const report = reports.find((item) => item.provider === id)
        return report ? limitWindows(report, readings, now) : []
      }),
    [reports, readings, now]
  )
  const checkedAt = Math.max(
    0,
    ...reports.map((report) => {
      const at = Date.parse(report.limitsObservedAt ?? report.fetchedAt)
      return Number.isFinite(at) ? at : 0
    })
  )
  const firstLoad = reports.length === 0 && loading
  const paced = windows.filter((item) => item.pace !== null)
  const upcoming = windows.filter(
    (item) => item.resetAt !== null && item.resetAt > now
  )

  let section = 0
  return (
    <div className="flex flex-col gap-4">
      <VerdictCard
        windows={windows}
        now={now}
        checkedAt={checkedAt}
        pending={firstLoad}
        style={enterDelay(section++)}
      />

      <div className="grid gap-4 @[880px]/usage:grid-cols-2">
        {providers.map(({ id, report }) => (
          <ProviderRingsCard
            key={id}
            provider={id}
            report={report}
            pending={firstLoad}
            windows={windows.filter((item) => item.provider === id)}
            now={now}
            style={enterDelay(section++)}
          />
        ))}
      </div>

      {upcoming.length > 0 && (
        <ResetTimelineCard
          windows={upcoming}
          now={now}
          style={enterDelay(section++)}
        />
      )}

      {paced.length > 0 && (
        <PaceCard windows={paced} style={enterDelay(section++)} />
      )}

      {providers.map(({ id, report }) =>
        report && report.limitNotes.length > 0 ? (
          <DriversCard
            key={id}
            provider={id}
            notes={report.limitNotes}
            style={enterDelay(section++)}
          />
        ) : null
      )}

      {reports.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[10px] text-muted-foreground">
          <InfoIcon aria-hidden="true" className="size-3" strokeWidth={1.5} />
          {USAGE_PROVIDER_IDS.map((id) => (
            <span key={id}>{SOURCE[id]}</span>
          ))}
        </p>
      )}
    </div>
  )
}

function VerdictCard({
  windows,
  now,
  checkedAt,
  pending,
  style,
}: {
  windows: readonly LimitWindow[]
  now: number
  checkedAt: number
  pending: boolean
  style: CSSProperties
}) {
  const lowest = windows.reduce<LimitWindow | null>(
    (best, item) => (!best || item.remaining < best.remaining ? item : best),
    null
  )
  const nextReset = windows.reduce<LimitWindow | null>(
    (best, item) =>
      item.resetAt !== null &&
      item.resetAt > now &&
      (!best || best.resetAt === null || item.resetAt < best.resetAt)
        ? item
        : best,
    null
  )
  const runsOut = windows
    .filter(
      (item) =>
        item.pace?.runsOutInMs !== null &&
        item.pace?.runsOutInMs !== undefined &&
        item.pace.runsOutInMs > 0
    )
    .sort((a, b) => (a.pace?.runsOutInMs ?? 0) - (b.pace?.runsOutInMs ?? 0))
    .at(0)
  const state: keyof typeof VERDICT = !lowest
    ? "none"
    : lowest.remaining <= 0
      ? "reached"
      : lowest.tone === "critical"
        ? "almost"
        : lowest.tone === "low" || runsOut
          ? "close"
          : "clear"
  const verdict = VERDICT[state]
  const name = (item: LimitWindow) =>
    `${USAGE_PROVIDER_LABEL[item.provider]} · ${item.limit.label}`

  return (
    <section
      aria-label="Limits status"
      aria-busy={pending}
      style={style}
      className={cn(ENTER, CARD, "overflow-hidden")}
    >
      <div className="grid @[760px]/usage:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
                verdict.pill
              )}
            >
              <verdict.icon
                aria-hidden="true"
                className="size-3.5"
                strokeWidth={2}
              />
              {verdict.label}
            </span>
            {checkedAt > 0 && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
                />
                Live · checked {formatAgo(now - checkedAt)}
              </span>
            )}
          </div>
          {pending ? (
            <>
              <Skeleton className="mt-5 h-7 w-3/4" />
              <Skeleton className="mt-3 h-4 w-1/2" />
            </>
          ) : lowest ? (
            <>
              <p className="mt-4 text-[22px] leading-snug font-semibold tracking-[-0.02em]">
                <span className="text-muted-foreground">Tightest is </span>
                {name(lowest)}
                <span className="text-muted-foreground"> with </span>
                <span
                  className={cn(
                    "tabular-nums",
                    lowest.tone !== "normal" && TONE_TEXT[lowest.tone]
                  )}
                >
                  {lowest.remaining}% left
                </span>
                {lowest.resetAt !== null && lowest.resetAt > now && (
                  <span className="text-muted-foreground">
                    , back to full in{" "}
                    <span className="text-foreground tabular-nums">
                      {formatCountdown(lowest.resetAt - now)}
                    </span>
                  </span>
                )}
                <span className="text-muted-foreground">.</span>
              </p>
              <p
                className={cn(
                  "mt-2 text-[12px] leading-relaxed",
                  runsOut ? "text-warning" : "text-muted-foreground"
                )}
              >
                {runsOut?.pace?.runsOutInMs
                  ? `At the pace so far, ${name(runsOut)} runs out in ~${formatCountdown(runsOut.pace.runsOutInMs)}, before it resets.`
                  : `${windows.length} limit ${windows.length === 1 ? "window" : "windows"}, every one on track to last until its reset.`}
              </p>
            </>
          ) : (
            <p className="mt-4 text-[15px] text-muted-foreground">
              Limits appear here once Claude Code or Codex report them.
            </p>
          )}
        </div>
        <div className="flex flex-col justify-center border-t border-border/40 p-6 @[760px]/usage:border-t-0 @[760px]/usage:border-l">
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <RotateCwIcon
              aria-hidden="true"
              className="size-3.5"
              strokeWidth={1.5}
            />
            Next reset
          </p>
          <p className="mt-2 text-[34px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
            {nextReset?.resetAt
              ? formatCountdown(nextReset.resetAt - now)
              : "—"}
          </p>
          <p className="mt-2 truncate text-[11px] text-muted-foreground">
            {nextReset?.resetAt
              ? `${name(nextReset)} · ${formatClock(nextReset.resetAt)}`
              : "No reset time reported"}
          </p>
        </div>
      </div>
    </section>
  )
}

/** Concentric rings, one per window, each filled to the share left. */
function LimitRings({
  provider,
  windows,
  size = 168,
}: {
  provider: UsageProviderId
  windows: readonly LimitWindow[]
  size?: number
}) {
  const stroke = windows.length > 3 ? 9 : 12
  const gap = 5
  const lowest = windows.reduce<LimitWindow | null>(
    (best, item) => (!best || item.remaining < best.remaining ? item : best),
    null
  )
  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
      >
        {windows.slice(0, 4).map((item, index) => {
          const radius = size / 2 - stroke / 2 - index * (stroke + gap)
          const circumference = 2 * Math.PI * radius
          return (
            <g key={item.limit.id}>
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                className="stroke-foreground/[0.07]"
              />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                stroke={ringColor(provider, index, item.tone)}
                strokeDasharray={`${(item.remaining / 100) * circumference} ${circumference}`}
                className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700 motion-safe:ease-out"
              />
            </g>
          )
        })}
      </svg>
      {lowest && (
        <div className="absolute text-center">
          <p
            className={cn(
              "text-[24px] leading-none font-semibold tracking-[-0.04em] tabular-nums",
              lowest.tone !== "normal" && TONE_TEXT[lowest.tone]
            )}
          >
            {lowest.remaining}%
          </p>
          <p className="mt-1 text-[9px] tracking-wide text-muted-foreground uppercase">
            lowest
          </p>
        </div>
      )}
    </div>
  )
}

function ProviderRingsCard({
  provider,
  report,
  pending,
  windows,
  now,
  style,
}: {
  provider: UsageProviderId
  report: ProviderUsageReport | null
  pending: boolean
  windows: LimitWindow[]
  now: number
  style: CSSProperties
}) {
  const icon = usageProviderIcon(provider)
  const label = USAGE_PROVIDER_LABEL[provider]
  const observedAt = report?.limitsObservedAt
    ? Date.parse(report.limitsObservedAt)
    : Number.NaN
  const retry = () => void useUsageStore.getState().load(true)

  let body: ReactNode
  if (!report) {
    body = pending ? (
      <div className="mt-5 flex items-center gap-6">
        <Skeleton className="size-[168px] shrink-0 rounded-full" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </div>
    ) : (
      <StateNote>No limits reported yet.</StateNote>
    )
  } else if (report.status === "error") {
    body = (
      <div
        role="alert"
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs"
      >
        <span className="min-w-0 flex-1">
          Couldn&apos;t read {label} limits
          {report.error ? `: ${report.error}` : "."}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={retry}
          className="rounded-md text-[11px]"
        >
          Retry
        </Button>
      </div>
    )
  } else if (windows.length > 0) {
    body = (
      <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-5">
        <LimitRings provider={provider} windows={windows} />
        <ul className="min-w-[220px] flex-1 space-y-4">
          {windows.map((item, index) => (
            <WindowRow
              key={item.limit.id}
              item={item}
              color={ringColor(provider, index, item.tone)}
              now={now}
            />
          ))}
        </ul>
      </div>
    )
  } else if (report.status === "unavailable" || !report.installed) {
    body = (
      <StateNote>
        {label} isn&apos;t installed on this machine. Install it and sign in to
        see its limits here.
      </StateNote>
    )
  } else if (!report.authenticated) {
    body = (
      <StateNote>
        Sign in to {label} to see its limits: run{" "}
        <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[10px] text-foreground/85">
          {SIGN_IN[provider]}
        </code>
        , then refresh.
      </StateNote>
    )
  } else {
    body = <StateNote>{EMPTY_HINT[provider]}</StateNote>
  }

  return (
    <section
      aria-label={`${label} limits`}
      style={style}
      className={cn(ENTER, CARD, "flex flex-col p-5")}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground/[0.05]">
            {icon && <ProviderIcon provider={icon} className="size-[18px]" />}
          </span>
          <h2 className="truncate text-[14px] font-semibold">{label}</h2>
          {report?.plan && (
            <span className="rounded-full border border-border/50 px-2 py-0.5 text-[10px] font-medium text-foreground/80">
              {report.plan}
            </span>
          )}
        </div>
        {Number.isFinite(observedAt) && windows.length > 0 && (
          <span
            className="text-[10px] text-muted-foreground"
            title={new Date(observedAt).toLocaleString()}
          >
            Checked {formatAgo(now - observedAt)}
          </span>
        )}
      </div>
      {body}
    </section>
  )
}

function StateNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * One window beside the rings: its swatch and label, the share left, the
 * reset and the status words, with a trend chip after a recent change.
 */
function WindowRow({
  item,
  color,
  now,
}: {
  item: LimitWindow
  color: string
  now: number
}) {
  const { limit, remaining, tone, resetAt, reading } = item
  const trend = limitTrend(reading, now)
  const resetInMs = resetAt === null ? null : resetAt - now
  const status = limitStatus(remaining)
  const delta =
    trend && reading && reading.previous !== null
      ? remaining - reading.previous
      : null
  const trendText =
    delta !== null && reading
      ? `${trend === "down" ? "Down" : "Up"} from ${reading.previous}% ${formatAgo(now - reading.changedAt)}`
      : null
  const TrendIcon = trend === "up" ? TrendingUpIcon : TrendingDownIcon
  return (
    <li
      role="meter"
      aria-label={describeLimit({
        provider: USAGE_PROVIDER_LABEL[item.provider],
        label: limit.label,
        remaining,
        resetInMs,
        resetLabel: limit.resetLabel,
      })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remaining}
      aria-valuetext={`${remaining}% left · ${status}`}
      className="min-w-0"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[12px]">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate" title={limit.label}>
            {limit.label}
          </span>
        </span>
        <span className="shrink-0 text-[18px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {remaining}%
          <span className="ml-1 text-[11px] font-normal tracking-normal text-muted-foreground">
            left
          </span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 pl-[18px] text-[10px] text-muted-foreground">
        <span
          className="flex min-w-0 items-center gap-1.5"
          title={
            resetAt !== null ? new Date(resetAt).toLocaleString() : undefined
          }
        >
          <RotateCwIcon
            aria-hidden="true"
            className="size-3 shrink-0"
            strokeWidth={1.5}
          />
          <span className="truncate tabular-nums">
            {resetAt !== null && resetInMs !== null
              ? resetInMs > 0
                ? `Resets in ${formatCountdown(resetInMs)} · ${formatClock(resetAt)}`
                : "Resetting now"
              : limit.resetLabel
                ? `Resets ${resetLabelText(limit.resetLabel)}`
                : "Reset time not reported"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {delta !== null && trendText && (
            <span
              title={trendText}
              className="flex items-center gap-0.5 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 tabular-nums"
            >
              <TrendIcon
                aria-hidden="true"
                className="size-3"
                strokeWidth={1.5}
              />
              {`${delta > 0 ? "+" : "−"}${Math.abs(delta)}%`}
              <span className="sr-only">{trendText}</span>
            </span>
          )}
          <span className={TONE_TEXT[tone]}>{status}</span>
        </span>
      </div>
    </li>
  )
}

/**
 * Every reset ahead on one axis from now: a dot per window in its provider's
 * color, its label lifted into the lowest free lane above the axis (so close
 * resets never overlap), and day (or 6-hour) gridlines with their labels
 * under the axis.
 */
function ResetTimelineCard({
  windows,
  now,
  style,
}: {
  windows: readonly LimitWindow[]
  now: number
  style: CSSProperties
}) {
  const items = [...windows].sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0))
  const last = (items.at(-1)?.resetAt ?? now) - now
  const span = resetTimelineSpan(last)
  // A little room after "Now" and before the end keeps edge markers apart.
  const x = (at: number) => 3 + Math.max(0, Math.min(1, (at - now) / span)) * 94
  const positions = items.map((item) => x(item.resetAt ?? now))
  const lanes = timelineLanes(positions, 3, 17)
  const laneCount = Math.max(1, ...lanes.map((lane) => lane + 1))
  const LANE = 30
  const axisY = 12 + laneCount * LANE + 14
  const height = axisY + 26
  const labelTop = (lane: number) => axisY - 36 - lane * LANE
  const hourly = span <= 1.5 * 24 * 60 * 60_000
  const ticks: Array<{ at: number; label: string }> = []
  if (hourly) {
    const first = new Date(now)
    first.setMinutes(0, 0, 0)
    first.setHours(first.getHours() + (6 - (first.getHours() % 6)))
    for (let at = first.getTime(); at < now + span; at += 6 * 60 * 60_000) {
      ticks.push({
        at,
        label: new Date(at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      })
    }
  } else {
    const first = new Date(now)
    first.setHours(24, 0, 0, 0)
    for (
      let day = first.getTime();
      day < now + span;
      day = new Date(day).setDate(new Date(day).getDate() + 1)
    ) {
      ticks.push({
        at: day,
        label: new Date(day).toLocaleDateString(undefined, {
          weekday: "short",
        }),
      })
    }
  }

  return (
    <section
      aria-label="Resets ahead"
      style={style}
      className={cn(ENTER, CARD, "p-5")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <CalendarClockIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Resets ahead
        </h2>
        <span className="text-[10px] text-muted-foreground">
          {hourly
            ? "Next 24 hours"
            : `Next ${Math.round(span / 86_400_000)} days`}
        </span>
      </div>
      <ol className="sr-only">
        {items.map((item) => (
          <li key={`${item.provider}:${item.limit.id}`}>
            {USAGE_PROVIDER_LABEL[item.provider]} {item.limit.label} resets in{" "}
            {formatCountdown((item.resetAt ?? now) - now)}
          </li>
        ))}
      </ol>
      <div aria-hidden="true" className="relative mt-3" style={{ height }}>
        {ticks.map((tick) => (
          <div
            key={tick.at}
            className="absolute top-0 border-l border-dashed border-border/30"
            style={{ left: `${x(tick.at)}%`, height: axisY + 6 }}
          >
            <span
              className="absolute left-1.5 text-[9px] whitespace-nowrap text-muted-foreground/70"
              style={{ top: axisY + 6 }}
            >
              {tick.label}
            </span>
          </div>
        ))}
        <div
          className="absolute inset-x-0 h-px bg-gradient-to-r from-foreground/60 via-border to-border/40"
          style={{ top: axisY }}
        />
        <span
          className="absolute left-0 size-2.5 -translate-y-1/2 rounded-full bg-foreground ring-4 ring-foreground/10"
          style={{ top: axisY }}
        />
        <span
          className="absolute left-0 text-[9px] font-medium text-foreground"
          style={{ top: axisY + 8 }}
        >
          Now
        </span>
        {items.map((item, index) => {
          const left = positions[index]
          const top = labelTop(lanes[index])
          const color =
            item.tone === "critical"
              ? "var(--destructive)"
              : item.tone === "low"
                ? "var(--warning)"
                : USAGE_PROVIDER_COLOR[item.provider]
          const anchor =
            left < 12
              ? "-translate-x-2"
              : left > 88
                ? "-translate-x-[calc(100%_-_8px)]"
                : "-translate-x-1/2"
          const icon = usageProviderIcon(item.provider)
          return (
            <div key={`${item.provider}:${item.limit.id}`}>
              <span
                className="absolute w-px bg-foreground/25"
                style={{
                  left: `${left}%`,
                  top: top + 22,
                  height: axisY - top - 22,
                }}
              />
              <span
                className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                style={{ left: `${left}%`, top: axisY, background: color }}
              />
              <span
                className={cn(
                  "absolute flex h-[22px] items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2 text-[10px] whitespace-nowrap shadow-sm",
                  anchor
                )}
                style={{ left: `${left}%`, top }}
              >
                {icon && (
                  <ProviderIcon provider={icon} className="size-3 shrink-0" />
                )}
                <span className="font-medium">{item.limit.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatCountdown((item.resetAt ?? now) - now)}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function PaceCard({
  windows,
  style,
}: {
  windows: readonly LimitWindow[]
  style: CSSProperties
}) {
  return (
    <section aria-label="Pace" style={style} className={cn(ENTER, CARD, "p-5")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <HourglassIcon
            aria-hidden="true"
            className={DETAIL_ICON}
            strokeWidth={1.5}
          />
          Pace
        </h2>
        <span className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-3 rounded-full bg-primary/70" />
            Used
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-0.5 rounded-full bg-foreground/60" />
            Time passed
          </span>
        </span>
      </div>
      <div className="mt-4 grid gap-x-8 gap-y-4 @[880px]/usage:grid-cols-2">
        {windows.map((item) => (
          <PaceRow key={`${item.provider}:${item.limit.id}`} item={item} />
        ))}
      </div>
    </section>
  )
}

/**
 * Use against time for one window: the bar is what is used, the mark how
 * much of the window's time has passed. A bar past the mark means the rate
 * so far uses the window up before it resets.
 */
function PaceRow({ item }: { item: LimitWindow }) {
  const pace = item.pace
  if (!pace) return null
  const used = 100 - item.remaining
  const icon = usageProviderIcon(item.provider)
  // Under 5% of the window the rate says little; the lib projects nothing.
  const verdict: { text: string; tone: LimitTone } =
    pace.runsOutInMs === 0
      ? { text: "Used up", tone: "critical" }
      : pace.runsOutInMs !== null
        ? {
            text: `Runs out in ~${formatCountdown(pace.runsOutInMs)}`,
            tone: "low",
          }
        : pace.elapsedPercent < 5 && used > pace.elapsedPercent
          ? { text: "Too early to tell", tone: "normal" }
          : { text: "Lasts until the reset", tone: "normal" }
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[12px]">
          {icon && (
            <ProviderIcon provider={icon} className="size-3.5 shrink-0" />
          )}
          <span className="truncate" title={item.limit.label}>
            {item.limit.label}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            verdict.tone === "normal"
              ? "text-foreground/70"
              : TONE_TEXT[verdict.tone]
          )}
        >
          {verdict.text}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${item.limit.label}: ${used}% used after ${pace.elapsedPercent}% of the window. ${verdict.text}.`}
        className="relative mt-2 h-1.5 rounded-full bg-foreground/[0.06]"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full motion-safe:transition-[width] motion-safe:duration-500",
            verdict.tone === "normal"
              ? "bg-primary/70"
              : TONE_FILL[verdict.tone]
          )}
          style={{ width: `${used}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
          style={{ left: `${pace.elapsedPercent}%` }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground tabular-nums">
        {used}% used · {pace.elapsedPercent}% of the window passed
      </p>
    </div>
  )
}

function DriversCard({
  provider,
  notes,
  style,
}: {
  provider: UsageProviderId
  notes: readonly string[]
  style: CSSProperties
}) {
  const drivers = useMemo(() => limitGroups(notes), [notes])
  if (drivers.groups.length === 0 && drivers.intro.length === 0) return null
  return (
    <section
      aria-label={`What drives your ${USAGE_PROVIDER_LABEL[provider]} usage`}
      style={style}
      className={cn(ENTER, CARD, "space-y-3 p-5")}
    >
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <ActivityIcon
          aria-hidden="true"
          className={DETAIL_ICON}
          strokeWidth={1.5}
        />
        What drives your {USAGE_PROVIDER_LABEL[provider]} usage
      </h2>
      {drivers.groups.map((group) => (
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
      {drivers.intro.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <InfoIcon
            aria-hidden="true"
            className="mt-0.5 size-3 shrink-0"
            strokeWidth={1.5}
          />
          <div className="space-y-1">
            {drivers.intro.map((line) => (
              <p key={line} className="text-[10px] leading-relaxed">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
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
