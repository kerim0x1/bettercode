import { MessageSquareIcon } from "lucide-react"
import type { AutomationDelivery, AutomationRun } from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  RUN_STATUS_PRESENTATION,
  RUN_TRIGGER_LABELS,
  automationToneDot,
  automationToneText,
  formatAutomationMoment,
} from "@/lib/automations"
import { cn } from "@/lib/utils"

/** A run's status: a dot (a spinner while it goes) and the word, in its tone. */
export function AutomationRunStatus({
  status,
  className,
}: {
  status: AutomationRun["status"]
  className?: string
}) {
  const presentation = RUN_STATUS_PRESENTATION[status]
  const going = status === "starting" || status === "running"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px] font-medium",
        automationToneText(presentation.tone),
        className
      )}
    >
      {going ? (
        <Spinner
          aria-hidden="true"
          className="size-3 motion-reduce:animate-none"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            automationToneDot(presentation.tone)
          )}
        />
      )}
      {presentation.label}
    </span>
  )
}

/**
 * The last 50 runs, newest first: status, what started it, when, its chat
 * and why it failed or was skipped.
 */
export function AutomationRunHistory({
  runs,
  now,
  onOpenChat,
}: {
  runs: readonly AutomationRun[] | null
  now: Date
  onOpenChat: (run: AutomationRun) => void
}) {
  if (runs === null) {
    return <p className="text-[12px] text-muted-foreground">Loading runs…</p>
  }
  if (runs.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No runs yet. Run now starts one.
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/50">
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
        >
          <AutomationRunStatus status={run.status} className="w-28 shrink-0" />
          <span className="text-[12px] text-muted-foreground">
            {RUN_TRIGGER_LABELS[run.trigger]}
          </span>
          <time
            dateTime={run.startedAt}
            className="text-[12px] text-muted-foreground tabular-nums"
          >
            {formatAutomationMoment(run.startedAt, now)}
          </time>
          <span className="ml-auto" />
          {run.threadId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="max-w-[240px] rounded-md text-[12px]"
              title={run.threadTitle ?? "Open chat"}
              aria-label={
                run.threadTitle ? `Open chat ${run.threadTitle}` : "Open chat"
              }
              onClick={() => onOpenChat(run)}
            >
              <MessageSquareIcon aria-hidden="true" className="size-3" />
              <span className="truncate">Open chat</span>
            </Button>
          ) : null}
          {run.error ? (
            <p
              className={cn(
                "basis-full text-[11px] leading-snug",
                run.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {run.error}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function deliveryTone(status: number): string {
  if (status >= 200 && status < 300) return "bg-success/10 text-success"
  if (status >= 500) return "bg-destructive/10 text-destructive"
  return "bg-warning/10 text-warning"
}

/** The last 50 webhook deliveries that carried the right token. */
export function AutomationDeliveries({
  deliveries,
  now,
}: {
  deliveries: readonly AutomationDelivery[] | null
  now: Date
}) {
  if (deliveries === null) return null
  if (deliveries.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No deliveries yet. Requests with a wrong URL are not listed.
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/50">
      {deliveries.map((delivery) => (
        <li
          key={delivery.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]"
        >
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
              deliveryTone(delivery.status)
            )}
          >
            {delivery.status}
          </span>
          <time
            dateTime={delivery.receivedAt}
            className="text-muted-foreground tabular-nums"
          >
            {formatAutomationMoment(delivery.receivedAt, now)}
          </time>
          {delivery.event ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {delivery.event}
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate text-foreground"
            title={delivery.response}
          >
            {delivery.response}
          </span>
        </li>
      ))}
    </ul>
  )
}
