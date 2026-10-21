import { useId } from "react"
import {
  CalendarClockIcon,
  CopyIcon,
  KeyRoundIcon,
  WebhookIcon,
} from "lucide-react"
import {
  automationPromptPlaceholders,
  automationScheduleProblem,
  upcomingAutomationRuns,
  type AutomationIntervalUnit,
} from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  WEEKDAYS,
  draftSchedule,
  formatAutomationMoment,
  generateWebhookSecret,
  type AutomationDraft,
  type AutomationScheduleKind,
  type AutomationTriggerKind,
} from "@/lib/automations"
import { copyText } from "@/lib/clipboard"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  AutomationField,
  AutomationSegments,
  FIELD_INPUT,
  FIELD_SELECT,
} from "./automation-fields"

type DraftChange = (patch: Partial<AutomationDraft>) => void

const TRIGGERS = [
  { value: "schedule", label: "On a schedule", icon: CalendarClockIcon },
  { value: "webhook", label: "From a webhook", icon: WebhookIcon },
] as const satisfies ReadonlyArray<{
  value: AutomationTriggerKind
  label: string
  icon: typeof WebhookIcon
}>

const SCHEDULE_KINDS = [
  { value: "once", label: "Once" },
  { value: "interval", label: "Every" },
  { value: "daily", label: "Daily" },
  { value: "cron", label: "Cron" },
] as const satisfies ReadonlyArray<{
  value: AutomationScheduleKind
  label: string
}>

/** When an automation runs: a schedule, or a call to its webhook URL. */
export function AutomationTriggerFields({
  draft,
  onChange,
  now,
  scheduleError,
  secretError,
  secretConfigured,
  saved,
}: {
  draft: AutomationDraft
  onChange: DraftChange
  now: Date
  scheduleError?: string
  secretError?: string
  /** A GitHub secret is stored for this automation. */
  secretConfigured: boolean
  /** The automation exists, so its URL is shown beside it. */
  saved: boolean
}) {
  const labelId = useId()
  return (
    <div className="flex flex-col gap-3.5">
      <AutomationField label="Starts" labelId={labelId} group>
        <AutomationSegments
          value={draft.triggerKind}
          options={TRIGGERS}
          ariaLabelledBy={labelId}
          onChange={(triggerKind) => onChange({ triggerKind })}
        />
      </AutomationField>
      {draft.triggerKind === "schedule" ? (
        <AutomationScheduleFields
          draft={draft}
          onChange={onChange}
          now={now}
          error={scheduleError}
        />
      ) : (
        <AutomationWebhookFields
          draft={draft}
          onChange={onChange}
          error={secretError}
          secretConfigured={secretConfigured}
          saved={saved}
        />
      )}
    </div>
  )
}

function AutomationScheduleFields({
  draft,
  onChange,
  now,
  error,
}: {
  draft: AutomationDraft
  onChange: DraftChange
  now: Date
  error?: string
}) {
  const kindLabelId = useId()
  const onceId = useId()
  const everyId = useId()
  const timeId = useId()
  const daysLabelId = useId()
  const cronId = useId()
  const schedule = draftSchedule(draft)
  const upcoming =
    schedule && !automationScheduleProblem(schedule)
      ? upcomingAutomationRuns(schedule, now, now, 3)
      : []
  const invalid = error ? true : undefined

  return (
    <div className="flex flex-col gap-3.5">
      <AutomationField label="Repeat" labelId={kindLabelId} group>
        <AutomationSegments
          value={draft.scheduleKind}
          options={SCHEDULE_KINDS}
          ariaLabelledBy={kindLabelId}
          onChange={(scheduleKind) => onChange({ scheduleKind })}
        />
      </AutomationField>

      {draft.scheduleKind === "once" ? (
        <AutomationField label="Date and time" htmlFor={onceId}>
          <Input
            id={onceId}
            type="datetime-local"
            aria-invalid={invalid}
            className={cn(FIELD_INPUT, "w-fit")}
            value={draft.onceAt}
            onChange={(event) => onChange({ onceAt: event.target.value })}
          />
        </AutomationField>
      ) : null}

      {draft.scheduleKind === "interval" ? (
        <AutomationField
          label="Every"
          htmlFor={everyId}
          hint="At least every 5 minutes, counted from when you save."
        >
          <div className="flex items-center gap-2">
            <Input
              id={everyId}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              aria-invalid={invalid}
              className={cn(FIELD_INPUT, "w-24 tabular-nums")}
              value={draft.intervalEvery}
              onChange={(event) =>
                onChange({ intervalEvery: event.target.value })
              }
            />
            <Select
              value={draft.intervalUnit}
              onValueChange={(unit) =>
                onChange({ intervalUnit: unit as AutomationIntervalUnit })
              }
            >
              <SelectTrigger
                aria-label="Unit"
                className={cn(FIELD_SELECT, "w-32")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </AutomationField>
      ) : null}

      {draft.scheduleKind === "daily" ? (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3.5">
          <AutomationField label="Time" htmlFor={timeId}>
            <Input
              id={timeId}
              type="time"
              aria-invalid={invalid}
              className={cn(FIELD_INPUT, "w-32 tabular-nums")}
              value={draft.dailyTime}
              onChange={(event) => onChange({ dailyTime: event.target.value })}
            />
          </AutomationField>
          <AutomationField label="Days" labelId={daysLabelId} group>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map(({ day, short, long }) => {
                const on = draft.dailyWeekdays.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={long}
                    title={long}
                    onClick={() =>
                      onChange({
                        dailyWeekdays: on
                          ? draft.dailyWeekdays.filter((d) => d !== day)
                          : [...draft.dailyWeekdays, day],
                      })
                    }
                    className={cn(
                      "h-8 min-w-10 rounded-lg border px-2 text-[12px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none motion-reduce:transition-none",
                      on
                        ? "border-primary/40 bg-primary/12 font-medium text-primary"
                        : "border-border/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {short}
                  </button>
                )
              })}
            </div>
          </AutomationField>
        </div>
      ) : null}

      {draft.scheduleKind === "cron" ? (
        <AutomationField
          label="Cron expression"
          htmlFor={cronId}
          hint="Minute, hour, day of month, month and day of week, such as 0 9 * * 1-5. @hourly, @daily and @weekly work too."
        >
          <Input
            id={cronId}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid}
            className={cn(FIELD_INPUT, "font-mono")}
            value={draft.cronExpression}
            onChange={(event) =>
              onChange({ cronExpression: event.target.value })
            }
          />
        </AutomationField>
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : upcoming.length > 0 ? (
        <div className="rounded-lg bg-muted/30 px-3 py-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            Next runs
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-foreground tabular-nums">
            {upcoming.map((date) => (
              <li key={date.toISOString()}>
                {formatAutomationMoment(date.toISOString(), now)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground/75">
            In this computer&apos;s time. If BetterC0de is closed when a run is
            due, it runs once when the app starts again.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function AutomationWebhookFields({
  draft,
  onChange,
  error,
  secretConfigured,
  saved,
}: {
  draft: AutomationDraft
  onChange: DraftChange
  error?: string
  secretConfigured: boolean
  saved: boolean
}) {
  const switchId = useId()
  const switchHintId = useId()
  const secretId = useId()
  const placeholders = automationPromptPlaceholders(draft.prompt)

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[12px] text-muted-foreground">
        Each POST to the automation&apos;s URL starts a run.{" "}
        {saved
          ? "The URL is shown next to the automation."
          : "The URL appears once you save."}
      </p>
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={draft.verifyGithubSignature}
          onCheckedChange={(checked) =>
            onChange({ verifyGithubSignature: checked })
          }
          aria-label="Check GitHub signature"
          aria-describedby={switchHintId}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <label
            htmlFor={switchId}
            className="text-[13px] font-medium text-foreground"
          >
            Check GitHub signature
          </label>
          <p id={switchHintId} className="text-[12px] text-muted-foreground">
            Refuse deliveries without a valid X-Hub-Signature-256 made with your
            secret.
          </p>
        </div>
      </div>
      {draft.verifyGithubSignature ? (
        <AutomationField
          label="Secret"
          htmlFor={secretId}
          error={error}
          hint={
            secretConfigured
              ? "A secret is stored. Leave this empty to keep it."
              : "Use the same secret in the webhook's Secret field on GitHub."
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={secretId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              placeholder={secretConfigured ? "••••••••" : undefined}
              className={cn(FIELD_INPUT, "min-w-0 flex-1 font-mono")}
              value={draft.webhookSecret}
              onChange={(event) =>
                onChange({ webhookSecret: event.target.value })
              }
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-[12px]"
              onClick={() =>
                onChange({ webhookSecret: generateWebhookSecret() })
              }
            >
              <KeyRoundIcon aria-hidden="true" className="size-3.5" />
              Generate
            </Button>
            {draft.webhookSecret ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy the secret"
                title="Copy the secret"
                className="size-8 rounded-lg"
                onClick={() => {
                  void copyText(draft.webhookSecret).then((copied) => {
                    if (copied) toast.success("Secret copied")
                  })
                }}
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </AutomationField>
      ) : null}
      <div className="rounded-lg bg-muted/30 px-3 py-2.5 text-[12px] text-muted-foreground">
        <p>
          Put request data in the prompt with{" "}
          <code className="font-mono text-foreground">{"{{body.path}}"}</code>{" "}
          and{" "}
          <code className="font-mono text-foreground">
            {"{{headers.name}}"}
          </code>
          , such as{" "}
          <code className="font-mono text-foreground">
            {"{{body.pull_request.title}}"}
          </code>{" "}
          or{" "}
          <code className="font-mono text-foreground">
            {"{{headers.x-github-event}}"}
          </code>
          . Values go in as marked, untrusted data, and the agent is told not to
          follow instructions in them.
        </p>
        {placeholders.length > 0 ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1">
            <span>In this prompt:</span>
            {placeholders.map((placeholder) => (
              <code
                key={placeholder}
                className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground"
              >
                {placeholder}
              </code>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  )
}
