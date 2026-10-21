import { z } from "zod"
import {
  AUTOMATION_CRON_MAX_CHARS,
  AUTOMATION_MAX_INTERVAL_MINUTES,
  automationScheduleProblem,
  type AutomationSchedule,
} from "./automation-schedule"
import { PERMISSION_LEVEL_IDS } from "./chat-controls"
import { modelSelectionSchema } from "./model-selection"

/**
 * Automations: an agent task that starts a new chat on a schedule or when a
 * webhook is called. The backend keeps them in the runtime home and runs
 * them (apps/backend services/automations); the desktop's Automations page
 * edits them through the desktop-only `/automations` routes.
 */

export const AUTOMATION_LIMITS = {
  maxAutomations: 100,
  maxNameChars: 120,
  maxPromptChars: 32_000,
  maxProjectPathChars: 4_096,
  /** Runs and webhook deliveries kept per automation. */
  maxHistory: 50,
  maxErrorChars: 500,
  /** A webhook request body larger than this is refused (413). */
  webhookMaxBodyBytes: 256 * 1024,
  /** Characters one `{{…}}` placeholder may insert. */
  maxPlaceholderValueChars: 2_000,
  /** Characters all placeholders of one prompt may insert together. */
  maxWebhookDataChars: 16_000,
  maxSecretChars: 256,
  /** Webhook deliveries one automation accepts per minute, after a burst. */
  webhookPerMinute: 10,
  webhookBurst: 10,
} as const

/** A webhook URL's token: 32 random bytes, base64url without padding. */
export const AUTOMATION_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Automation ids are UUIDs minted by the backend. */
export const AUTOMATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
/** The public path a webhook is delivered to, under the backend's address. */
export const AUTOMATION_WEBHOOK_PATH_PREFIX = "/hooks/automations"

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 09:30.")

/**
 * When a scheduled automation runs (`automation-schedule.ts`): once, every N
 * minutes or hours (at least every 5 minutes), daily at a time on chosen
 * weekdays, or a five-field cron expression.
 */
export const automationScheduleSchema: z.ZodType<
  AutomationSchedule,
  AutomationSchedule
> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("once"), at: z.string().datetime() }).strict(),
    z
      .object({
        kind: z.literal("interval"),
        every: z.number().int().min(1).max(AUTOMATION_MAX_INTERVAL_MINUTES),
        unit: z.enum(["minutes", "hours"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("daily"),
        time: timeOfDaySchema,
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      })
      .strict(),
    z
      .object({
        kind: z.literal("cron"),
        expression: z.string().trim().min(1).max(AUTOMATION_CRON_MAX_CHARS),
      })
      .strict(),
  ])
  .superRefine((schedule, context) => {
    const problem = automationScheduleProblem(schedule)
    if (problem) context.addIssue({ code: "custom", message: problem })
  })

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("schedule"), schedule: automationScheduleSchema })
    .strict(),
  z
    .object({
      type: z.literal("webhook"),
      /**
       * Check `X-Hub-Signature-256` (HMAC-SHA256 of the body with the
       * automation's secret, as GitHub sends it) and refuse a delivery
       * without a valid one.
       */
      verifyGithubSignature: z.boolean(),
    })
    .strict(),
])
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>

export const AUTOMATION_RUN_LOCATIONS = ["local", "worktree"] as const
export type AutomationRunLocation = (typeof AUTOMATION_RUN_LOCATIONS)[number]

/**
 * `POST /automations` and `PUT /automations/:id`: the whole automation.
 * `webhookSecret` is write-only: a string sets the GitHub signature secret,
 * `null` removes it, and leaving it out keeps the stored one.
 */
export const automationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(AUTOMATION_LIMITS.maxNameChars),
    projectPath: z
      .string()
      .trim()
      .min(1)
      .max(AUTOMATION_LIMITS.maxProjectPathChars),
    prompt: z
      .string()
      .max(AUTOMATION_LIMITS.maxPromptChars)
      .refine((value) => value.trim().length > 0, "Enter a prompt."),
    providerKind: z.string().trim().min(1).max(128),
    providerInstanceId: z.string().trim().min(1).max(512).nullable(),
    modelId: z.string().trim().min(1).max(512),
    modelSelection: modelSelectionSchema.nullable(),
    reasoningEffort: z.string().trim().min(1).max(128).nullable(),
    permissionLevel: z.enum(PERMISSION_LEVEL_IDS),
    runLocation: z.enum(AUTOMATION_RUN_LOCATIONS),
    trigger: automationTriggerSchema,
    enabled: z.boolean(),
    webhookSecret: z
      .string()
      .min(8, "Use a secret of at least 8 characters.")
      .max(AUTOMATION_LIMITS.maxSecretChars)
      .nullable()
      .optional(),
  })
  .strict()
export type AutomationInput = z.infer<typeof automationInputSchema>
/** What a client sends: `webhookSecret` may be left out. */
export type AutomationInputBody = z.input<typeof automationInputSchema>

export const AUTOMATION_RUN_TRIGGERS = [
  "schedule",
  /** The app was not running at the due time; one run at the next start. */
  "catch-up",
  "manual",
  "webhook",
] as const
export type AutomationRunTrigger = (typeof AUTOMATION_RUN_TRIGGERS)[number]

export const AUTOMATION_RUN_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  /** Not started: the previous run of the automation was still running. */
  "skipped",
  /** The app stopped while the run was going. */
  "interrupted",
] as const
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number]

/** One run: the chat it started and how it ended. */
export const automationRunSchema = z.object({
  id: z.string().min(1),
  trigger: z.enum(AUTOMATION_RUN_TRIGGERS),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  /** The scheduled moment a schedule or catch-up run stands for. */
  scheduledFor: z.string().nullable(),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  /** The run's chat, once it exists. */
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  /** Why it failed or was skipped. */
  error: z.string().nullable(),
  /** The webhook delivery that started it. */
  deliveryId: z.string().nullable(),
})
export type AutomationRun = z.infer<typeof automationRunSchema>

/**
 * One webhook request that carried the right token: when it came, the HTTP
 * status it was answered with and what the answer said. Bodies and headers
 * are not kept.
 */
export const automationDeliverySchema = z.object({
  id: z.string().min(1),
  receivedAt: z.string().min(1),
  status: z.number().int(),
  /** The response's message, such as "Run started." */
  response: z.string(),
  /** `X-GitHub-Event`, when the sender named one. */
  event: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  runId: z.string().nullable(),
})
export type AutomationDelivery = z.infer<typeof automationDeliverySchema>

/** An automation's webhook as the desktop shows it. */
export const automationWebhookViewSchema = z.object({
  /**
   * `/hooks/automations/<id>/<token>`, to append to a base URL. `null` when
   * the stored token cannot be read on this computer: Rotate URL makes a new
   * one.
   */
  path: z.string().nullable(),
  secretConfigured: z.boolean(),
})
export type AutomationWebhookView = z.infer<typeof automationWebhookViewSchema>

/** An automation as the routes answer it; secrets are never included. */
export const automationViewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  projectPath: z.string(),
  prompt: z.string(),
  providerKind: z.string(),
  providerInstanceId: z.string().nullable(),
  modelId: z.string(),
  modelSelection: modelSelectionSchema.nullable(),
  reasoningEffort: z.string().nullable(),
  permissionLevel: z.string(),
  runLocation: z.enum(AUTOMATION_RUN_LOCATIONS),
  trigger: automationTriggerSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The next scheduled run; `null` for a webhook, a paused automation or a passed one-time run. */
  nextRunAt: z.string().nullable(),
  /** A run of this automation is going now. */
  running: z.boolean(),
  lastRun: automationRunSchema.nullable(),
  /** Only for a webhook trigger. */
  webhook: automationWebhookViewSchema.nullable(),
})
export type AutomationView = z.infer<typeof automationViewSchema>

/** A base address the webhook path can be appended to. */
export const automationWebhookEndpointSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  reachability: z.enum(["loopback", "lan", "private-network", "public"]),
  isDefault: z.boolean(),
})
export type AutomationWebhookEndpoint = z.infer<
  typeof automationWebhookEndpointSchema
>

/** `GET /automations`. */
export const automationListResponseSchema = z.object({
  automations: z.array(automationViewSchema),
})
export type AutomationListResponse = z.infer<
  typeof automationListResponseSchema
>

/**
 * `GET /automations/webhook-endpoints`: where this desktop can be reached,
 * the Remote Access addresses while it is on, otherwise only this computer.
 * Kept apart from the list because finding them may ask the Tailscale CLI.
 */
export const automationWebhookEndpointsResponseSchema = z.object({
  endpoints: z.array(automationWebhookEndpointSchema),
  remoteAccessEnabled: z.boolean(),
})
export type AutomationWebhookEndpointsResponse = z.infer<
  typeof automationWebhookEndpointsResponseSchema
>

/** `GET /automations/:id`: the automation with its run history and deliveries, newest first. */
export const automationDetailResponseSchema = z.object({
  automation: automationViewSchema,
  runs: z.array(automationRunSchema),
  deliveries: z.array(automationDeliverySchema),
})
export type AutomationDetailResponse = z.infer<
  typeof automationDetailResponseSchema
>

/** What a webhook sender reads back when its delivery was taken. */
export const automationWebhookResponseSchema = z.object({
  accepted: z.boolean(),
  runId: z.string().nullable(),
  message: z.string(),
})
export type AutomationWebhookResponse = z.infer<
  typeof automationWebhookResponseSchema
>

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** `2026-10-20 09:00` in local time. */
export function formatAutomationRunDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** The title of a run's chat: "<name> · <date>". */
export function automationRunTitle(name: string, date: Date): string {
  return `${name.trim()} · ${formatAutomationRunDate(date)}`
}

const PLACEHOLDER_PATTERN = /\{\{\s*((?:body|headers)(?:\.[^\s{}]+)?)\s*\}\}/g

/**
 * The `{{body.…}}` and `{{headers.…}}` placeholders a webhook prompt uses,
 * in order of first use.
 */
export function automationPromptPlaceholders(prompt: string): string[] {
  const found = new Set<string>()
  for (const match of prompt.matchAll(PLACEHOLDER_PATTERN)) {
    if (match[1]) found.add(match[1])
  }
  return [...found]
}

/** A fresh RegExp for `{{…}}` placeholders (global, so not shared). */
export function automationPlaceholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_PATTERN.source, "g")
}
