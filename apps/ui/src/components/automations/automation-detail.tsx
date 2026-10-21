import { useEffect, useState, type ReactNode } from "react"
import { PauseIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react"
import {
  describeAutomationSchedule,
  type AutomationDelivery,
  type AutomationRun,
  type AutomationView,
  type AutomationWebhookEndpoint,
} from "@betterc0de/schema"
import { permissionLevelLabel } from "@betterc0de/schema/chat-controls"
import { formatProviderActivityLabel } from "@betterc0de/schema/provider-label"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { Button } from "@/components/ui/button"
import { formatAutomationMoment, formatNextRun } from "@/lib/automations"
import { displayModelName } from "@/lib/model-display-name"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  deleteAutomation,
  getAutomation,
  runAutomationNow,
  setAutomationEnabled,
} from "@/services/backend/automations-api"
import { AutomationSection } from "./automation-fields"
import {
  AutomationDeliveries,
  AutomationRunHistory,
  AutomationRunStatus,
} from "./automation-run-history"
import { AutomationWebhookCard } from "./automation-webhook-card"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function triggerSummary(automation: AutomationView, now: Date): string {
  const trigger = automation.trigger
  if (trigger.type === "webhook") {
    return trigger.verifyGithubSignature
      ? "Webhook, GitHub signature checked"
      : "Webhook"
  }
  return trigger.schedule.kind === "once"
    ? `Once, ${formatAutomationMoment(trigger.schedule.at, now)}`
    : describeAutomationSchedule(trigger.schedule)
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-[12.5px] text-foreground">
        {children}
      </dd>
    </div>
  )
}

/**
 * One automation: its actions (Run now, Pause or Resume, Edit, Delete), what
 * it runs with, its webhook URLs, its prompt, and its last 50 runs and
 * deliveries. Each run links to the chat it started.
 */
export function AutomationDetail({
  automation,
  endpoints,
  remoteAccessEnabled,
  now,
  onEdit,
  onUpdated,
  onRefresh,
  onDeleted,
  onOpenChat,
}: {
  automation: AutomationView
  endpoints: readonly AutomationWebhookEndpoint[] | null
  remoteAccessEnabled: boolean | null
  now: Date
  onEdit: () => void
  onUpdated: (automation: AutomationView) => void
  /** Reads the list again, for a run's new state. */
  onRefresh: () => void
  onDeleted: (id: string) => void
  onOpenChat: (run: AutomationRun) => void
}) {
  const confirm = useConfirm()
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [deliveries, setDeliveries] = useState<AutomationDelivery[] | null>(
    null
  )
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyRequest, setHistoryRequest] = useState(0)
  const [busy, setBusy] = useState<"run" | "toggle" | "delete" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const lastRun = automation.lastRun
  // The history is read again whenever the list reports a change.
  const changeKey = `${lastRun?.id ?? ""}:${lastRun?.status ?? ""}:${lastRun?.threadId ?? ""}:${automation.updatedAt}`

  useEffect(() => {
    let cancelled = false
    getAutomation(automation.id).then(
      (detail) => {
        if (cancelled) return
        setRuns(detail.runs)
        setDeliveries(detail.deliveries)
        setHistoryError(null)
      },
      (error: unknown) => {
        if (!cancelled) setHistoryError(errorMessage(error))
      }
    )
    return () => {
      cancelled = true
    }
  }, [automation.id, changeKey, historyRequest])

  const act = async (
    kind: "run" | "toggle" | "delete",
    operation: () => Promise<void>
  ) => {
    setBusy(kind)
    setActionError(null)
    try {
      await operation()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const runNow = () =>
    act("run", async () => {
      const { run } = await runAutomationNow(automation.id)
      if (run.status === "skipped") {
        toast.info("Skipped: the previous run is still going.")
      } else {
        toast.success("Run started")
      }
      setHistoryRequest((count) => count + 1)
      onRefresh()
    })

  const toggle = () =>
    act("toggle", async () => {
      const { automation: updated } = await setAutomationEnabled(
        automation.id,
        !automation.enabled
      )
      onUpdated(updated)
    })

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${automation.name}”?`,
      description:
        "Its schedule, webhook URL and run history are deleted. The chats its runs started stay.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    await act("delete", async () => {
      await deleteAutomation(automation.id)
      onDeleted(automation.id)
    })
  }

  const model = [
    formatProviderActivityLabel({
      providerKind: automation.providerKind,
      providerInstanceId: automation.providerInstanceId,
    }),
    displayModelName(automation.modelId),
    automation.reasoningEffort,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[18px] font-semibold text-foreground">
                {automation.name}
              </h2>
              <span
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  automation.enabled
                    ? "bg-success/10 text-success"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {automation.enabled ? "Active" : "Paused"}
              </span>
            </div>
            <p
              className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground"
              title={automation.projectPath}
            >
              {automation.projectPath}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-[12px]"
              disabled={busy !== null}
              aria-busy={busy === "run"}
              onClick={() => void runNow()}
            >
              <PlayIcon aria-hidden="true" className="size-3.5" />
              Run now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-[12px]"
              disabled={busy !== null}
              aria-busy={busy === "toggle"}
              onClick={() => void toggle()}
            >
              {automation.enabled ? (
                <PauseIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <PlayIcon aria-hidden="true" className="size-3.5" />
              )}
              {automation.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-[12px]"
              disabled={busy !== null}
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" className="size-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-lg text-muted-foreground hover:text-destructive"
              disabled={busy !== null}
              aria-label={`Delete ${automation.name}`}
              title="Delete"
              onClick={() => void remove()}
            >
              <Trash2Icon aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
        {actionError ? (
          <p role="alert" className="text-[12px] text-destructive">
            {actionError}
          </p>
        ) : null}
      </header>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 @[420px]/automation:grid-cols-2 @[720px]/automation:grid-cols-3">
        <Fact label="Trigger">{triggerSummary(automation, now)}</Fact>
        <Fact label="Next run">{formatNextRun(automation, now)}</Fact>
        <Fact label="Last run">
          {lastRun ? (
            <span className="inline-flex items-center gap-1.5">
              <AutomationRunStatus status={lastRun.status} />
              <span className="text-muted-foreground">
                {formatAutomationMoment(lastRun.startedAt, now)}
              </span>
            </span>
          ) : (
            "Never"
          )}
        </Fact>
        <Fact label="Model">{model}</Fact>
        <Fact label="Permissions">
          {permissionLevelLabel(automation.permissionLevel)}
        </Fact>
        <Fact label="Runs in">
          {automation.runLocation === "worktree"
            ? "A new worktree each run"
            : "The project folder"}
        </Fact>
      </dl>

      <AutomationWebhookCard
        automation={automation}
        endpoints={endpoints}
        remoteAccessEnabled={remoteAccessEnabled}
        onRotated={onUpdated}
      />

      <AutomationSection title="Prompt">
        <p className="max-h-56 overflow-y-auto rounded-lg bg-muted/30 px-3 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {automation.prompt}
        </p>
      </AutomationSection>

      <AutomationSection
        title="Runs"
        description="The last 50 runs. Each one has its own chat."
      >
        {historyError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-[12px] text-destructive"
          >
            <span className="min-w-0 flex-1">{historyError}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setHistoryRequest((count) => count + 1)}
            >
              Retry
            </Button>
          </div>
        ) : (
          <AutomationRunHistory runs={runs} now={now} onOpenChat={onOpenChat} />
        )}
      </AutomationSection>

      {automation.trigger.type === "webhook" ? (
        <AutomationSection
          title="Deliveries"
          description="The last 50 requests to the webhook URL and how they were answered."
        >
          <AutomationDeliveries deliveries={deliveries} now={now} />
        </AutomationSection>
      ) : null}
    </div>
  )
}
