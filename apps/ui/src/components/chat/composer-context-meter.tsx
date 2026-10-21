import { useState } from "react"
import { ListCollapseIcon } from "lucide-react"
import { PromptInputButton } from "@/components/ai-elements/prompt-input"
import { ProviderIcon } from "@/components/provider-icon"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import {
  MENU_NOTE,
  MENU_PANEL,
  MENU_WIDTH_MD,
} from "@/components/ui/menu-chrome"
import { selectedModelLimits } from "@/lib/auto-thread-compaction"
import { useChatStore } from "@/lib/chat-store"
import {
  formatContextTokens,
  formatPercent,
  latestContextActivity,
  readContextUsage,
} from "@/lib/context-usage"
import type { UiProvider } from "@/lib/provider-types"
import { cn } from "@/lib/utils"

/**
 * Context meter for the minimal composer: a small ring in the footer and,
 * on hover, focus or click, how full the window is, what the chat has
 * processed in total and who compacts it. Reads the latest
 * `context-window.updated` activity (persisted, so it survives a reload),
 * then the live usage the provider events keep on the thread.
 */
export function ComposerContextMeter({
  threadId,
  currentProvider,
  selectedModel,
  providers,
}: {
  threadId: string | null | undefined
  currentProvider: UiProvider | undefined
  selectedModel: string
  providers: UiProvider[]
}) {
  const [open, setOpen] = useState(false)
  const activity = useChatStore((state) =>
    threadId ? latestContextActivity(state.activitiesByThread[threadId]) : null
  )
  const liveUsage = useChatStore((state) =>
    threadId
      ? state.threads.find((thread) => thread.id === threadId)?.usage
      : undefined
  )
  if (!threadId) return null

  const usage =
    readContextUsage(activity?.payload) ?? readContextUsage(liveUsage)
  const maxTokens =
    usage?.maxTokens ??
    selectedModelLimits(currentProvider, selectedModel)?.contextTokens ??
    null
  const percent =
    usage && maxTokens ? Math.min(100, (usage.usedTokens / maxTokens) * 100) : 0
  const level: ContextLevel =
    percent >= 95 ? "critical" : percent >= 80 ? "high" : "normal"
  const provider =
    providers.find((entry) => entry.id === usage?.providerInstanceId) ??
    providers.find(
      (entry) =>
        usage?.providerKind &&
        (entry.providerKind ?? entry.id) === usage.providerKind
    ) ??
    currentProvider

  const measured = usage !== null && maxTokens !== null
  const hero = !usage
    ? "0%"
    : measured
      ? formatPercent(percent)
      : formatContextTokens(usage.usedTokens)
  const heroDetail = !usage
    ? "No usage yet"
    : measured
      ? `${formatContextTokens(usage.usedTokens)} of ${formatContextTokens(maxTokens)} tokens`
      : "tokens in context"
  const stats = [
    measured && {
      label: "Remaining",
      value: formatContextTokens(maxTokens - usage.usedTokens),
    },
    usage?.totalProcessedTokens && {
      label: "Processed",
      value: formatContextTokens(usage.totalProcessedTokens),
    },
  ].filter((stat): stat is { label: string; value: string } => Boolean(stat))
  const nativeCompaction = usage?.compactsAutomatically === true
  const note = !usage
    ? "Updates after the next reply."
    : nativeCompaction
      ? `${provider?.name ?? "The provider"} compacts its context automatically near the limit.`
      : "BetterC0de summarizes older turns before the window fills."

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={150}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <PromptInputButton
          size="icon-xs"
          aria-label={
            usage && maxTokens
              ? `Context window, ${formatPercent(percent)} used`
              : "Context window"
          }
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={cn(
            "rounded-md text-muted-foreground",
            level === "high" && "text-warning",
            level === "critical" && "text-destructive"
          )}
        >
          <ContextRing percent={percent} />
        </PromptInputButton>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className={cn(MENU_PANEL, MENU_WIDTH_MD, "text-[11px]")}
      >
        <div className="px-2.5 pt-2 pb-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Context window
            </span>
            {measured ? (
              <span
                className={cn("text-[10px] font-medium", LEVEL_TEXT[level])}
              >
                {LEVEL_LABEL[level]}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span
              className={cn(
                "text-[22px] leading-7 font-semibold tracking-tight tabular-nums",
                usage ? "text-foreground" : "text-muted-foreground/60"
              )}
            >
              {hero}
            </span>
            <span className="truncate text-muted-foreground tabular-nums">
              {heroDetail}
            </span>
          </div>
          <ContextSegments percent={percent} level={level} />
          {stats.length > 0 ? (
            <dl className="mt-3 grid auto-cols-fr grid-flow-col divide-x divide-border/50">
              {stats.map((stat) => (
                <div key={stat.label} className="min-w-0 px-3 first:pl-0">
                  <dt className="text-[10px] text-muted-foreground">
                    {stat.label}
                  </dt>
                  <dd className="mt-0.5 truncate text-[12px] font-medium text-foreground tabular-nums">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <p className={cn(MENU_NOTE, "items-start text-muted-foreground/75")}>
          {nativeCompaction && provider ? (
            <ProviderIcon
              provider={provider}
              className="mt-0.5 !size-3 shrink-0"
            />
          ) : (
            <ListCollapseIcon aria-hidden="true" className="mt-0.5" />
          )}
          <span>{note}</span>
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}

type ContextLevel = "normal" | "high" | "critical"

const LEVEL_LABEL: Record<ContextLevel, string> = {
  normal: "Plenty of room",
  high: "Filling up",
  critical: "Almost full",
}

const LEVEL_TEXT: Record<ContextLevel, string> = {
  normal: "text-muted-foreground",
  high: "text-warning",
  critical: "text-destructive",
}

const LEVEL_FILL: Record<ContextLevel, string> = {
  normal: "bg-foreground/80",
  high: "bg-warning",
  critical: "bg-destructive",
}

const SEGMENTS = 28

/**
 * The window as a row of cells; any usage lights the first cell, so a
 * fresh chat on a large window still shows that something is in it.
 */
function ContextSegments({
  percent,
  level,
}: {
  percent: number
  level: ContextLevel
}) {
  const lit =
    percent > 0 ? Math.max(1, Math.ceil((percent / 100) * SEGMENTS)) : 0
  return (
    <div
      role="meter"
      aria-label="Context window usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="mt-2.5 flex gap-[3px]"
    >
      {Array.from({ length: SEGMENTS }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2 flex-1 rounded-[2px] transition-colors duration-300 motion-reduce:transition-none",
            index < lit ? LEVEL_FILL[level] : "bg-muted/70"
          )}
        />
      ))}
    </div>
  )
}

function ContextRing({ percent }: { percent: number }) {
  const radius = 9
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 -rotate-90">
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-40"
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - (percent / 100) * circumference}
        className={cn(
          "transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
          percent === 0 && "opacity-0"
        )}
      />
    </svg>
  )
}
