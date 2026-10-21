import {
  AUTOMATION_LIMITS,
  automationOnceInPast,
  automationScheduleProblem,
  formatAutomationRunDate,
  type AutomationInputBody,
  type AutomationIntervalUnit,
  type AutomationRunLocation,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationSchedule,
  type AutomationView,
  type AutomationWebhookEndpoint,
  type ModelSelection,
} from "@betterc0de/schema"
import {
  DEFAULT_PERMISSION_LEVEL,
  normalizePermissionLevel,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"

/**
 * The Automations page's pure parts: the editor's draft and how it becomes
 * a request, and the words and tones for times, runs and webhook URLs.
 * Times are the desktop's local time, as the backend scheduler uses them.
 */

export type AutomationScheduleKind = AutomationSchedule["kind"]
export type AutomationTriggerKind = "schedule" | "webhook"

/** Every editor field as the form holds it, text fields as typed. */
export interface AutomationDraft {
  name: string
  projectPath: string
  prompt: string
  providerKind: string
  providerInstanceId: string | null
  modelId: string
  modelSelection: ModelSelection | null
  /** The reasoning level as the composer names it ("High"), or none. */
  reasoningEffort: string | null
  permissionLevel: PermissionLevel
  runLocation: AutomationRunLocation
  triggerKind: AutomationTriggerKind
  scheduleKind: AutomationScheduleKind
  /** `YYYY-MM-DDTHH:MM`, the value of a `datetime-local` field. */
  onceAt: string
  intervalEvery: string
  intervalUnit: AutomationIntervalUnit
  /** `HH:MM`. */
  dailyTime: string
  dailyWeekdays: number[]
  cronExpression: string
  verifyGithubSignature: boolean
  /** A new GitHub secret; empty keeps the stored one. */
  webhookSecret: string
  enabled: boolean
}

export type AutomationDraftField =
  | "name"
  | "projectPath"
  | "prompt"
  | "model"
  | "schedule"
  | "webhookSecret"

export const WEEKDAYS: ReadonlyArray<{
  readonly day: number
  readonly short: string
  readonly long: string
}> = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
]

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** A moment as the value of a `datetime-local` field, in local time. */
export function toLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** A `datetime-local` value as an ISO moment, or `null`. */
export function fromLocalDateTimeInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  // Without an offset the string is read in local time.
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** A new automation: weekdays at 09:00, ready for a project and a model. */
export function emptyAutomationDraft(
  now: Date,
  defaults: {
    readonly projectPath?: string
    readonly providerKind?: string
    readonly providerInstanceId?: string | null
    readonly modelId?: string
  } = {}
): AutomationDraft {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return {
    name: "",
    projectPath: defaults.projectPath ?? "",
    prompt: "",
    providerKind: defaults.providerKind ?? "",
    providerInstanceId: defaults.providerInstanceId ?? null,
    modelId: defaults.modelId ?? "",
    modelSelection: null,
    reasoningEffort: null,
    permissionLevel: DEFAULT_PERMISSION_LEVEL,
    runLocation: "local",
    triggerKind: "schedule",
    scheduleKind: "daily",
    onceAt: toLocalDateTimeInput(tomorrow),
    intervalEvery: "60",
    intervalUnit: "minutes",
    dailyTime: "09:00",
    dailyWeekdays: [1, 2, 3, 4, 5],
    cronExpression: "0 9 * * 1-5",
    verifyGithubSignature: false,
    webhookSecret: "",
    enabled: true,
  }
}

/** The editor's draft for a saved automation. Secrets stay on the backend. */
export function draftFromAutomation(
  automation: AutomationView,
  now: Date
): AutomationDraft {
  const draft: AutomationDraft = {
    ...emptyAutomationDraft(now),
    name: automation.name,
    projectPath: automation.projectPath,
    prompt: automation.prompt,
    providerKind: automation.providerKind,
    providerInstanceId: automation.providerInstanceId,
    modelId: automation.modelId,
    modelSelection: automation.modelSelection,
    reasoningEffort: automation.reasoningEffort,
    permissionLevel: normalizePermissionLevel(automation.permissionLevel),
    runLocation: automation.runLocation,
    enabled: automation.enabled,
  }
  const trigger = automation.trigger
  if (trigger.type === "webhook") {
    return {
      ...draft,
      triggerKind: "webhook",
      verifyGithubSignature: trigger.verifyGithubSignature,
    }
  }
  const schedule = trigger.schedule
  draft.scheduleKind = schedule.kind
  switch (schedule.kind) {
    case "once":
      draft.onceAt = toLocalDateTimeInput(new Date(schedule.at))
      break
    case "interval":
      draft.intervalEvery = String(schedule.every)
      draft.intervalUnit = schedule.unit
      break
    case "daily":
      draft.dailyTime = schedule.time
      draft.dailyWeekdays = [...schedule.weekdays]
      break
    case "cron":
      draft.cronExpression = schedule.expression
      break
  }
  return draft
}

/** The schedule the draft describes, or `null` while a field cannot be read. */
export function draftSchedule(
  draft: AutomationDraft
): AutomationSchedule | null {
  switch (draft.scheduleKind) {
    case "once": {
      const at = fromLocalDateTimeInput(draft.onceAt)
      return at ? { kind: "once", at } : null
    }
    case "interval": {
      const every = Number(draft.intervalEvery.trim())
      return draft.intervalEvery.trim() && Number.isInteger(every)
        ? { kind: "interval", every, unit: draft.intervalUnit }
        : null
    }
    case "daily":
      return {
        kind: "daily",
        time: draft.dailyTime,
        weekdays: [...new Set(draft.dailyWeekdays)].sort((a, b) => a - b),
      }
    case "cron":
      return { kind: "cron", expression: draft.cronExpression.trim() }
  }
}

/** Why each field cannot be saved yet; empty when the draft is ready. */
export function draftProblems(
  draft: AutomationDraft,
  options: { readonly now: Date; readonly secretConfigured: boolean }
): Partial<Record<AutomationDraftField, string>> {
  const problems: Partial<Record<AutomationDraftField, string>> = {}
  if (!draft.name.trim()) problems.name = "Give the automation a name."
  else if (draft.name.trim().length > AUTOMATION_LIMITS.maxNameChars) {
    problems.name = `Use at most ${AUTOMATION_LIMITS.maxNameChars} characters.`
  }
  if (!draft.projectPath.trim()) problems.projectPath = "Choose a project."
  if (!draft.prompt.trim()) problems.prompt = "Write what the agent should do."
  else if (draft.prompt.length > AUTOMATION_LIMITS.maxPromptChars) {
    problems.prompt = `Use at most ${AUTOMATION_LIMITS.maxPromptChars.toLocaleString("en-US")} characters.`
  }
  if (!draft.providerKind || !draft.modelId) problems.model = "Choose a model."
  if (draft.triggerKind === "schedule") {
    const schedule = draftSchedule(draft)
    const problem = schedule
      ? automationScheduleProblem(schedule)
      : draft.scheduleKind === "interval"
        ? "Enter a whole number."
        : "Choose a date and time."
    if (problem) problems.schedule = problem
    else if (schedule && automationOnceInPast(schedule, options.now)) {
      problems.schedule = "Choose a time in the future."
    }
  } else if (draft.verifyGithubSignature) {
    const secret = draft.webhookSecret
    if (!secret && !options.secretConfigured) {
      problems.webhookSecret = "Add the secret you set in GitHub."
    } else if (secret && secret.length < 8) {
      problems.webhookSecret = "Use a secret of at least 8 characters."
    } else if (secret.length > AUTOMATION_LIMITS.maxSecretChars) {
      problems.webhookSecret = `Use at most ${AUTOMATION_LIMITS.maxSecretChars} characters.`
    }
  }
  return problems
}

/**
 * The request body for a draft that has no problems. A typed secret is
 * sent; an empty field keeps the stored one, and turning the signature
 * check off removes it.
 */
export function automationInputFromDraft(
  draft: AutomationDraft
): AutomationInputBody {
  const schedule = draftSchedule(draft)
  const trigger: AutomationInputBody["trigger"] =
    draft.triggerKind === "webhook"
      ? {
          type: "webhook",
          verifyGithubSignature: draft.verifyGithubSignature,
        }
      : {
          type: "schedule",
          schedule: schedule ?? { kind: "cron", expression: "" },
        }
  const secret =
    draft.triggerKind === "webhook" && draft.verifyGithubSignature
      ? draft.webhookSecret
        ? { webhookSecret: draft.webhookSecret }
        : {}
      : { webhookSecret: null }
  return {
    name: draft.name.trim(),
    projectPath: draft.projectPath.trim(),
    prompt: draft.prompt,
    providerKind: draft.providerKind,
    providerInstanceId: draft.providerInstanceId,
    modelId: draft.modelId,
    modelSelection: draft.modelSelection,
    reasoningEffort: draft.reasoningEffort,
    permissionLevel: draft.permissionLevel,
    runLocation: draft.runLocation,
    trigger,
    enabled: draft.enabled,
    ...secret,
  }
}

/** A random secret for GitHub's webhook form: 32 hex characters. */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/**
 * A moment near `now` in words: "Today at 09:00", "Tomorrow at 09:00",
 * "Yesterday at 18:30", "Fri at 09:00" within the week ahead, otherwise
 * "2026-11-03 09:00".
 */
export function formatAutomationMoment(iso: string, now: Date): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ""
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  if (days === 0) return `Today at ${time}`
  if (days === 1) return `Tomorrow at ${time}`
  if (days === -1) return `Yesterday at ${time}`
  if (days > 1 && days < 7) return `${DAY_NAMES[date.getDay()]} at ${time}`
  return formatAutomationRunDate(date)
}

/** The next run in words: "Due now" once its time has come. */
export function formatNextRun(
  automation: Pick<AutomationView, "enabled" | "nextRunAt" | "trigger">,
  now: Date
): string {
  if (!automation.enabled) return "Paused"
  if (automation.trigger.type === "webhook") return "When the webhook is called"
  if (!automation.nextRunAt) return "No upcoming run"
  return Date.parse(automation.nextRunAt) <= now.getTime()
    ? "Due now"
    : formatAutomationMoment(automation.nextRunAt, now)
}

export type AutomationTone =
  | "success"
  | "destructive"
  | "warning"
  | "primary"
  | "muted"

export const RUN_STATUS_PRESENTATION: Readonly<
  Record<
    AutomationRunStatus,
    { readonly label: string; readonly tone: AutomationTone }
  >
> = {
  starting: { label: "Starting", tone: "primary" },
  running: { label: "Running", tone: "primary" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  skipped: { label: "Skipped", tone: "warning" },
  interrupted: { label: "Interrupted", tone: "warning" },
}

export const RUN_TRIGGER_LABELS: Readonly<
  Record<AutomationRunTrigger, string>
> = {
  schedule: "Scheduled",
  "catch-up": "Catch-up",
  manual: "Run now",
  webhook: "Webhook",
}

/** Text color class for a tone, always shown with a word or an icon. */
export function automationToneText(tone: AutomationTone): string {
  switch (tone) {
    case "success":
      return "text-success"
    case "destructive":
      return "text-destructive"
    case "warning":
      return "text-warning"
    case "primary":
      return "text-primary"
    case "muted":
      return "text-muted-foreground"
  }
}

/** Dot color class for a tone. */
export function automationToneDot(tone: AutomationTone): string {
  switch (tone) {
    case "success":
      return "bg-success"
    case "destructive":
      return "bg-destructive"
    case "warning":
      return "bg-warning"
    case "primary":
      return "bg-primary"
    case "muted":
      return "bg-muted-foreground/40"
  }
}

export interface AutomationWebhookUrl {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly isDefault: boolean
  readonly reachability: AutomationWebhookEndpoint["reachability"]
}

/** The webhook's full URLs, the recommended one first. */
export function automationWebhookUrls(
  endpoints: readonly AutomationWebhookEndpoint[],
  path: string | null
): AutomationWebhookUrl[] {
  if (!path) return []
  return [...endpoints]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      url: `${endpoint.baseUrl.replace(/\/+$/, "")}${path}`,
      isDefault: endpoint.isDefault,
      reachability: endpoint.reachability,
    }))
}

/** Whether senders outside this computer can reach any of the URLs. */
export function webhookReachableFromOutside(
  endpoints: readonly AutomationWebhookEndpoint[]
): boolean {
  return endpoints.some((endpoint) => endpoint.reachability !== "loopback")
}

/** The last path segment of a project folder, for list rows. */
export function projectFolderName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? projectPath
}
