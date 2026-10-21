import { randomUUID } from "node:crypto"
import {
  AUTOMATION_LIMITS,
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  automationOnceInPast,
  automationRunTitle,
  nextAutomationRun,
  type AutomationDelivery,
  type AutomationDetailResponse,
  type AutomationInput,
  type AutomationRun,
  type AutomationRunLocation,
  type AutomationRunTrigger,
  type AutomationView,
  type AutomationWebhookResponse,
} from "@betterc0de/schema"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import { decryptSecret, encryptSecret } from "../../settings/crypto"
import {
  emptyAutomationHistory,
  type AutomationHistory,
  type AutomationStore,
  type StoredAutomation,
} from "./store"
import {
  GITHUB_SIGNATURE_HEADER,
  generateWebhookToken,
  parseWebhookPayload,
  renderWebhookPrompt,
  verifyGithubSignature,
  webhookEventName,
  webhookPromptHeaders,
  webhookTokenMatches,
} from "./webhook"

/**
 * Automations: agent tasks that start a new chat on a schedule, by hand or
 * when their webhook is called.
 *
 * - **Scheduler.** One timer wakes for the earliest due run (and at least
 *   hourly, so a changed clock is noticed), never a polling loop. The first
 *   wake after startup waits a little, so the backend has finished starting.
 * - **Missed runs.** A run whose time passed while the app was closed (or
 *   the computer slept) runs once when the scheduler next wakes, recorded
 *   as `catch-up`: everything due until then counts as handled, so an
 *   automation never runs more than once to catch up.
 * - **One run at a time.** A run that comes while the automation's previous
 *   run is still going does not start; it is recorded as `skipped`.
 * - **History.** The last 50 runs and 50 webhook deliveries per automation.
 *   A run still going when the app stopped reads as `interrupted`.
 *
 * Each run gets its own chat through `AutomationRunner` (`runner.ts`), the
 * server-side path goals and Autonomous Work use to start turns.
 */

export interface AutomationRunRequest {
  readonly automation: Readonly<StoredAutomation>
  readonly runId: string
  readonly threadId: string
  /** "<name> · <date>". */
  readonly title: string
  /** What the model gets. */
  readonly message: string
  /** What the chat shows as the user's message: it names the automation. */
  readonly displayMessage: string
  readonly createdAt: string
  /** Called once the run's chat exists, before its turn starts. */
  readonly onChatCreated: () => void
}

export interface AutomationRunner {
  /** Starts the run's turn; resolves once it was admitted, with its end. */
  start(
    request: AutomationRunRequest
  ): Promise<{ readonly settled: Promise<void> }>
}

export interface AutomationTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface AutomationServiceOptions {
  readonly store: AutomationStore
  readonly runner: AutomationRunner
  /**
   * The canonical project folder for a definition, or an `HttpError` when it
   * is missing, not trusted, or not a Git repository for worktree runs.
   */
  readonly resolveProject: (
    projectPath: string,
    runLocation: AutomationRunLocation
  ) => Promise<string>
  /** False while the backend drains or after it was tainted. */
  readonly available?: () => boolean
  readonly now?: () => number
  readonly timers?: AutomationTimers
  readonly secrets?: {
    encrypt(value: string): string
    decrypt(value: string): string | null
  }
  readonly log?: Pick<typeof logger, "info" | "warn" | "error">
  /** How long after startup the first due run may start. */
  readonly startupDelayMs?: number
  /** How long history changes are gathered before they are written. */
  readonly historySaveDelayMs?: number
}

export interface AutomationWebhookRequest {
  readonly automationId: string
  readonly token: string
  readonly body: Uint8Array
  readonly contentType: string | undefined
  readonly headers: Iterable<readonly [string, string]>
}

export type AutomationWebhookOutcome =
  | {
      readonly status: 200 | 202
      readonly response: AutomationWebhookResponse
    }
  | {
      readonly status: 400 | 401 | 404 | 409 | 429 | 503
      readonly error: string
      readonly code: string
      readonly retryAfterMs?: number
    }

/** A due run this much later than its time counts as a catch-up. */
const CATCH_UP_GRACE_MS = 2 * 60_000
/** The scheduler wakes at least this often to notice a changed clock. */
const MAX_TIMER_MS = 60 * 60_000
const MIN_TIMER_MS = 1_000
/** While the backend refuses work, the scheduler looks again after this. */
const UNAVAILABLE_RETRY_MS = 60_000
const DEFAULT_STARTUP_DELAY_MS = 15_000
const DEFAULT_HISTORY_SAVE_DELAY_MS = 500

const defaultTimers: AutomationTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

const TRIGGER_WORDS: Readonly<Record<AutomationRunTrigger, string>> = {
  schedule: "Scheduled run",
  "catch-up": "Catch-up run: the app was closed at the scheduled time",
  manual: "Run by hand",
  webhook: "Started by a webhook",
}

/** The user message a run's chat shows: which automation, and why it ran. */
export function automationDisplayMessage(
  name: string,
  trigger: AutomationRunTrigger,
  message: string
): string {
  return `**Automation:** ${name} · ${TRIGGER_WORDS[trigger]}\n\n${message}`
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > AUTOMATION_LIMITS.maxErrorChars
    ? `${text.slice(0, AUTOMATION_LIMITS.maxErrorChars - 1)}…`
    : text
}

function notFound(): HttpError {
  return new HttpError(404, "Automation not found.", "automation_not_found")
}

/** The definition fields an input sets; ids, times and secrets are the service's. */
function definitionFields(input: AutomationInput) {
  return {
    name: input.name,
    prompt: input.prompt,
    providerKind: input.providerKind,
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    modelSelection: input.modelSelection,
    reasoningEffort: input.reasoningEffort,
    permissionLevel: input.permissionLevel,
    runLocation: input.runLocation,
    trigger: input.trigger,
    enabled: input.enabled,
  }
}

/** A token bucket per automation for webhook deliveries. */
class DeliveryBuckets {
  private readonly buckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >()

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number
  ) {}

  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now()
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: now,
    }
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs
    )
    bucket.updatedAt = now
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, retryAfterMs: 0 }
    }
    return {
      allowed: false,
      retryAfterMs: Math.ceil((1 - bucket.tokens) / this.refillPerMs),
    }
  }

  delete(key: string): void {
    this.buckets.delete(key)
  }
}

export class AutomationService {
  private readonly automations = new Map<string, StoredAutomation>()
  private readonly histories = new Map<string, AutomationHistory>()
  /** Automation id → the id of its run that is going now. */
  private readonly active = new Map<string, string>()
  private readonly timers: AutomationTimers
  private readonly now: () => number
  private readonly available: () => boolean
  private readonly log: Pick<typeof logger, "info" | "warn" | "error">
  private readonly startupUntil: number
  private readonly deliveryBuckets: DeliveryBuckets
  private timer: unknown = null
  private historyTimer: unknown = null
  private historyDirty = false
  private disposed = false

  constructor(private readonly options: AutomationServiceOptions) {
    this.timers = options.timers ?? defaultTimers
    this.now = options.now ?? Date.now
    this.available = options.available ?? (() => true)
    this.log = options.log ?? logger
    this.deliveryBuckets = new DeliveryBuckets(
      AUTOMATION_LIMITS.webhookBurst,
      AUTOMATION_LIMITS.webhookPerMinute / 60_000,
      this.now
    )
    const snapshot = options.store.load()
    for (const automation of snapshot.automations) {
      this.automations.set(automation.id, automation)
    }
    const stoppedAt = new Date(this.now()).toISOString()
    for (const [id, history] of Object.entries(snapshot.history)) {
      if (!this.automations.has(id)) continue
      for (const run of history.runs) {
        if (run.status !== "starting" && run.status !== "running") continue
        run.status = "interrupted"
        run.finishedAt ??= stoppedAt
        run.error ??= "The app stopped before the run finished."
        this.historyDirty = true
      }
      this.histories.set(id, history)
    }
    this.startupUntil =
      this.now() + (options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS)
    if (this.historyDirty) this.saveHistorySoon()
    this.arm()
  }

  // ── Reading ───────────────────────────────────────────────────────────

  list(): AutomationView[] {
    return [...this.automations.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((automation) => this.view(automation))
  }

  detail(id: string): AutomationDetailResponse {
    const automation = this.require(id)
    const history = this.histories.get(id) ?? emptyAutomationHistory()
    return {
      automation: this.view(automation),
      runs: structuredClone(history.runs),
      deliveries: structuredClone(history.deliveries),
    }
  }

  // ── Changing ──────────────────────────────────────────────────────────

  async create(input: AutomationInput): Promise<AutomationView> {
    this.assertOpen()
    this.assertRoom()
    const projectPath = await this.options.resolveProject(
      input.projectPath,
      input.runLocation
    )
    this.assertOpen()
    this.assertRoom()
    const now = this.now()
    this.assertScheduleAhead(input, now)
    const at = new Date(now).toISOString()
    const automation: StoredAutomation = {
      ...definitionFields(input),
      id: randomUUID(),
      projectPath,
      createdAt: at,
      updatedAt: at,
      scheduleAnchorAt: at,
      webhookToken: this.encrypt(generateWebhookToken()),
      webhookSecret: input.webhookSecret
        ? this.encrypt(input.webhookSecret)
        : null,
    }
    this.assertSecretForSignature(automation)
    this.automations.set(automation.id, automation)
    this.histories.set(automation.id, emptyAutomationHistory())
    try {
      this.persistAutomations()
    } catch (error) {
      this.automations.delete(automation.id)
      this.histories.delete(automation.id)
      throw error
    }
    this.log.info(
      { automationId: automation.id, trigger: automation.trigger.type },
      "automation created"
    )
    this.arm()
    return this.view(automation)
  }

  async update(id: string, input: AutomationInput): Promise<AutomationView> {
    this.assertOpen()
    this.require(id)
    const projectPath = await this.options.resolveProject(
      input.projectPath,
      input.runLocation
    )
    this.assertOpen()
    // Read again: it may have changed or gone while the folder was checked.
    const current = this.require(id)
    const now = this.now()
    const at = new Date(now).toISOString()
    const scheduleChanged =
      JSON.stringify(current.trigger) !== JSON.stringify(input.trigger)
    if (scheduleChanged) this.assertScheduleAhead(input, now)
    const next: StoredAutomation = {
      ...current,
      ...definitionFields(input),
      projectPath,
      updatedAt: at,
      scheduleAnchorAt: scheduleChanged ? at : current.scheduleAnchorAt,
      webhookToken:
        current.webhookToken ?? this.encrypt(generateWebhookToken()),
      webhookSecret:
        input.webhookSecret === undefined
          ? current.webhookSecret
          : input.webhookSecret === null
            ? null
            : this.encrypt(input.webhookSecret),
    }
    this.assertSecretForSignature(next)
    const history = this.historyFor(id)
    const handledBefore = history.lastHandledAt
    // A new schedule starts from now; a resumed one skips the paused time.
    if (scheduleChanged) history.lastHandledAt = null
    else if (!current.enabled && next.enabled) history.lastHandledAt = at
    this.automations.set(id, next)
    try {
      this.persistAutomations()
    } catch (error) {
      this.automations.set(id, current)
      history.lastHandledAt = handledBefore
      throw error
    }
    if (history.lastHandledAt !== handledBefore) this.saveHistorySoon()
    this.arm()
    return this.view(next)
  }

  /** Deletes the automation and its history; a run going now keeps its chat. */
  remove(id: string): boolean {
    this.assertOpen()
    const current = this.automations.get(id)
    if (!current) return false
    this.automations.delete(id)
    try {
      this.persistAutomations()
    } catch (error) {
      this.automations.set(id, current)
      throw error
    }
    this.histories.delete(id)
    this.deliveryBuckets.delete(id)
    this.saveHistorySoon()
    this.log.info({ automationId: id }, "automation deleted")
    this.arm()
    return true
  }

  /** Pause (`false`) or resume (`true`). A resume does not catch up. */
  setEnabled(id: string, enabled: boolean): AutomationView {
    this.assertOpen()
    const current = this.require(id)
    if (current.enabled === enabled) return this.view(current)
    const at = new Date(this.now()).toISOString()
    const next: StoredAutomation = { ...current, enabled, updatedAt: at }
    this.automations.set(id, next)
    try {
      this.persistAutomations()
    } catch (error) {
      this.automations.set(id, current)
      throw error
    }
    if (enabled) {
      this.historyFor(id).lastHandledAt = at
      this.saveHistorySoon()
    }
    this.arm()
    return this.view(next)
  }

  /** A new webhook token: the old URL stops working at once. */
  rotateWebhook(id: string): AutomationView {
    this.assertOpen()
    const current = this.require(id)
    const next: StoredAutomation = {
      ...current,
      webhookToken: this.encrypt(generateWebhookToken()),
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.automations.set(id, next)
    try {
      this.persistAutomations()
    } catch (error) {
      this.automations.set(id, current)
      throw error
    }
    this.deliveryBuckets.delete(id)
    this.log.info({ automationId: id }, "automation webhook URL rotated")
    return this.view(next)
  }

  /** Runs the automation now, whatever its trigger, also while paused. */
  runNow(id: string): AutomationRun {
    this.assertOpen()
    const automation = this.require(id)
    if (!this.available()) {
      throw new HttpError(
        503,
        "The backend is stopping. Run the automation after it restarts.",
        "automations_unavailable"
      )
    }
    const message =
      automation.trigger.type === "webhook"
        ? renderWebhookPrompt(automation.prompt, { body: {}, headers: {} })
            .message
        : automation.prompt
    return this.startRun(automation, "manual", {
      scheduledFor: null,
      message,
      deliveryId: null,
    })
  }

  // ── Webhook ───────────────────────────────────────────────────────────

  /**
   * One webhook request. The token decides first, in constant time, and a
   * wrong one is answered like an unknown automation (404) and not logged.
   * After that every answer is recorded as a delivery: the rate limit, the
   * GitHub signature, a paused automation, a `ping`, an unreadable body, a
   * skipped or a started run.
   */
  receiveWebhook(request: AutomationWebhookRequest): AutomationWebhookOutcome {
    const automation = this.automations.get(request.automationId)
    const expected =
      !this.disposed &&
      automation?.trigger.type === "webhook" &&
      automation.webhookToken
        ? this.decrypt(automation.webhookToken)
        : null
    if (
      !webhookTokenMatches(request.token, expected) ||
      !automation ||
      automation.trigger.type !== "webhook"
    ) {
      return { status: 404, error: "Not found.", code: "not_found" }
    }
    const automationId = automation.id
    const headers = new Map<string, string>()
    for (const [name, value] of request.headers) {
      headers.set(name.toLowerCase(), value)
    }
    const promptHeaders = webhookPromptHeaders(headers)
    const delivery: AutomationDelivery = {
      id: randomUUID(),
      receivedAt: new Date(this.now()).toISOString(),
      status: 0,
      response: "",
      event: webhookEventName(promptHeaders),
      bytes: request.body.byteLength,
      runId: null,
    }
    const refuse = (
      status: 400 | 401 | 409 | 429 | 503,
      code: string,
      error: string,
      retryAfterMs?: number
    ): AutomationWebhookOutcome => {
      this.recordDelivery(automationId, {
        ...delivery,
        status,
        response: error,
      })
      return retryAfterMs === undefined
        ? { status, error, code }
        : { status, error, code, retryAfterMs }
    }

    const rate = this.deliveryBuckets.consume(automation.id)
    if (!rate.allowed) {
      return refuse(
        429,
        "rate_limited",
        "Too many deliveries. Try again in a minute.",
        rate.retryAfterMs
      )
    }
    if (automation.trigger.verifyGithubSignature) {
      const secret = automation.webhookSecret
        ? this.decrypt(automation.webhookSecret)
        : null
      if (
        !secret ||
        !verifyGithubSignature(
          secret,
          request.body,
          headers.get(GITHUB_SIGNATURE_HEADER)
        )
      ) {
        return refuse(
          401,
          "invalid_signature",
          "The X-Hub-Signature-256 signature did not match."
        )
      }
    }
    if (!automation.enabled) {
      return refuse(409, "automation_paused", "This automation is paused.")
    }
    if (!this.available()) {
      return refuse(
        503,
        "automations_unavailable",
        "The desktop is stopping. Send the delivery again later."
      )
    }
    if (delivery.event === "ping") {
      const response: AutomationWebhookResponse = {
        accepted: false,
        runId: null,
        message: "Pong. Each delivery to this URL starts a run.",
      }
      this.recordDelivery(automation.id, {
        ...delivery,
        status: 200,
        response: response.message,
      })
      return { status: 200, response }
    }
    const payload = parseWebhookPayload(request.contentType, request.body)
    if (!payload.ok) return refuse(400, "invalid_body", payload.error)
    const rendered = renderWebhookPrompt(automation.prompt, {
      body: payload.value,
      headers: promptHeaders,
    })
    const run = this.startRun(automation, "webhook", {
      scheduledFor: null,
      message: rendered.message,
      deliveryId: delivery.id,
    })
    const skipped = run.status === "skipped"
    const response: AutomationWebhookResponse = {
      accepted: !skipped,
      runId: run.id,
      message: skipped
        ? "Skipped: the previous run of this automation is still going."
        : "Run started.",
    }
    const status = skipped ? 200 : 202
    this.recordDelivery(automation.id, {
      ...delivery,
      status,
      response: response.message,
      runId: run.id,
    })
    return { status, response }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Stops the scheduler and writes pending history. Runs going now keep going. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
    if (this.historyTimer !== null) {
      this.timers.clear(this.historyTimer)
      this.historyTimer = null
    }
    this.saveHistoryNow()
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  private startRun(
    automation: StoredAutomation,
    trigger: AutomationRunTrigger,
    extra: {
      readonly scheduledFor: string | null
      readonly message: string
      readonly deliveryId: string | null
    }
  ): AutomationRun {
    const now = this.now()
    const at = new Date(now).toISOString()
    const history = this.historyFor(automation.id)
    if (this.active.has(automation.id)) {
      const skipped: AutomationRun = {
        id: randomUUID(),
        trigger,
        status: "skipped",
        scheduledFor: extra.scheduledFor,
        startedAt: at,
        finishedAt: at,
        threadId: null,
        threadTitle: null,
        error: "The previous run of this automation was still going.",
        deliveryId: extra.deliveryId,
      }
      this.recordRun(history, skipped)
      this.log.info(
        { automationId: automation.id, trigger },
        "automation run skipped: the previous run is still going"
      )
      return structuredClone(skipped)
    }
    const run: AutomationRun = {
      id: randomUUID(),
      trigger,
      status: "starting",
      scheduledFor: extra.scheduledFor,
      startedAt: at,
      finishedAt: null,
      threadId: null,
      threadTitle: automationRunTitle(automation.name, new Date(now)),
      error: null,
      deliveryId: extra.deliveryId,
    }
    this.recordRun(history, run)
    this.active.set(automation.id, run.id)
    this.log.info(
      { automationId: automation.id, runId: run.id, trigger },
      "automation run starting"
    )
    void this.execute(automation, run, extra.message)
    return structuredClone(run)
  }

  private async execute(
    automation: StoredAutomation,
    run: AutomationRun,
    message: string
  ): Promise<void> {
    const threadId = randomUUID()
    try {
      const handle = await this.options.runner.start({
        automation,
        runId: run.id,
        threadId,
        title: run.threadTitle ?? automation.name,
        message,
        displayMessage: automationDisplayMessage(
          automation.name,
          run.trigger,
          message
        ),
        createdAt: run.startedAt,
        onChatCreated: () => {
          run.threadId = threadId
          this.saveHistorySoon()
        },
      })
      run.status = "running"
      this.saveHistorySoon()
      try {
        await handle.settled
        this.finish(automation.id, run, "completed", null)
      } catch (error) {
        this.finish(automation.id, run, "failed", errorText(error))
      }
    } catch (error) {
      this.finish(automation.id, run, "failed", errorText(error))
    }
  }

  private finish(
    automationId: string,
    run: AutomationRun,
    status: "completed" | "failed",
    error: string | null
  ): void {
    run.status = status
    run.finishedAt = new Date(this.now()).toISOString()
    run.error = error
    if (this.active.get(automationId) === run.id)
      this.active.delete(automationId)
    if (status === "failed") {
      this.log.warn(
        { automationId, runId: run.id, err: error },
        "automation run failed"
      )
    } else {
      this.log.info({ automationId, runId: run.id }, "automation run completed")
    }
    this.saveHistorySoon()
  }

  private recordRun(history: AutomationHistory, run: AutomationRun): void {
    history.runs.unshift(run)
    if (history.runs.length > AUTOMATION_LIMITS.maxHistory) {
      history.runs.splice(AUTOMATION_LIMITS.maxHistory)
    }
    this.saveHistorySoon()
  }

  private recordDelivery(
    automationId: string,
    delivery: AutomationDelivery
  ): void {
    if (!this.automations.has(automationId)) return
    const history = this.historyFor(automationId)
    history.deliveries.unshift(delivery)
    if (history.deliveries.length > AUTOMATION_LIMITS.maxHistory) {
      history.deliveries.splice(AUTOMATION_LIMITS.maxHistory)
    }
    this.saveHistorySoon()
  }

  // ── Scheduler ─────────────────────────────────────────────────────────

  /** The automation's next due run, or `null`. It may already be past. */
  private dueAt(automation: StoredAutomation): Date | null {
    if (!automation.enabled || automation.trigger.type !== "schedule") {
      return null
    }
    const anchor = Date.parse(automation.scheduleAnchorAt)
    if (!Number.isFinite(anchor)) return null
    const handledText = this.histories.get(automation.id)?.lastHandledAt
    const handled = handledText ? Date.parse(handledText) : Number.NaN
    const after = Number.isFinite(handled) ? Math.max(handled, anchor) : anchor
    return nextAutomationRun(
      automation.trigger.schedule,
      new Date(after),
      new Date(anchor)
    )
  }

  private arm(delayOverrideMs?: number): void {
    if (this.disposed) return
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
    const now = this.now()
    let wait = delayOverrideMs
    if (wait === undefined) {
      let earliest = Number.POSITIVE_INFINITY
      for (const automation of this.automations.values()) {
        const due = this.dueAt(automation)
        if (due && due.getTime() < earliest) earliest = due.getTime()
      }
      if (!Number.isFinite(earliest)) return
      wait = Math.min(
        MAX_TIMER_MS,
        Math.max(MIN_TIMER_MS, earliest - now, this.startupUntil - now)
      )
    }
    this.timer = this.timers.set(() => {
      this.timer = null
      this.tick()
    }, wait)
  }

  private tick(): void {
    if (this.disposed) return
    if (!this.available()) {
      this.arm(UNAVAILABLE_RETRY_MS)
      return
    }
    const now = this.now()
    try {
      for (const automation of [...this.automations.values()]) {
        const due = this.dueAt(automation)
        if (!due || due.getTime() > now) continue
        // Everything due until now is handled by this one run.
        this.historyFor(automation.id).lastHandledAt = new Date(
          now
        ).toISOString()
        this.startRun(
          automation,
          now - due.getTime() > CATCH_UP_GRACE_MS ? "catch-up" : "schedule",
          {
            scheduledFor: due.toISOString(),
            message: automation.prompt,
            deliveryId: null,
          }
        )
      }
    } catch (error) {
      this.log.error(
        { err: errorText(error) },
        "the automation scheduler could not start a run"
      )
    }
    this.saveHistorySoon()
    this.arm()
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private view(automation: StoredAutomation): AutomationView {
    const history = this.histories.get(automation.id)
    const next = this.dueAt(automation)
    const lastRun = history?.runs[0]
    return {
      id: automation.id,
      name: automation.name,
      projectPath: automation.projectPath,
      prompt: automation.prompt,
      providerKind: automation.providerKind,
      providerInstanceId: automation.providerInstanceId,
      modelId: automation.modelId,
      modelSelection: structuredClone(automation.modelSelection),
      reasoningEffort: automation.reasoningEffort,
      permissionLevel: automation.permissionLevel,
      runLocation: automation.runLocation,
      trigger: structuredClone(automation.trigger),
      enabled: automation.enabled,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
      nextRunAt: next ? next.toISOString() : null,
      running: this.active.has(automation.id),
      lastRun: lastRun ? structuredClone(lastRun) : null,
      webhook:
        automation.trigger.type === "webhook"
          ? {
              path: this.webhookPath(automation),
              secretConfigured: automation.webhookSecret !== null,
            }
          : null,
    }
  }

  private webhookPath(automation: StoredAutomation): string | null {
    const token = automation.webhookToken
      ? this.decrypt(automation.webhookToken)
      : null
    return token
      ? `${AUTOMATION_WEBHOOK_PATH_PREFIX}/${encodeURIComponent(automation.id)}/${token}`
      : null
  }

  private require(id: string): StoredAutomation {
    const automation = this.automations.get(id)
    if (!automation) throw notFound()
    return automation
  }

  private historyFor(id: string): AutomationHistory {
    let history = this.histories.get(id)
    if (!history) {
      history = emptyAutomationHistory()
      this.histories.set(id, history)
    }
    return history
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new HttpError(
        503,
        "Automations are unavailable while the backend stops.",
        "automations_unavailable"
      )
    }
  }

  private assertRoom(): void {
    if (this.automations.size >= AUTOMATION_LIMITS.maxAutomations) {
      throw new HttpError(
        409,
        `You can keep up to ${AUTOMATION_LIMITS.maxAutomations} automations. Delete one first.`,
        "automation_limit"
      )
    }
  }

  private assertScheduleAhead(input: AutomationInput, now: number): void {
    if (
      input.trigger.type === "schedule" &&
      automationOnceInPast(input.trigger.schedule, new Date(now))
    ) {
      throw new HttpError(
        400,
        "Choose a time in the future.",
        "automation_schedule_past"
      )
    }
  }

  private assertSecretForSignature(automation: StoredAutomation): void {
    if (
      automation.trigger.type === "webhook" &&
      automation.trigger.verifyGithubSignature &&
      automation.webhookSecret === null
    ) {
      throw new HttpError(
        400,
        "Add a secret to check GitHub signatures.",
        "automation_secret_required"
      )
    }
  }

  private encrypt(value: string): string {
    return this.options.secrets?.encrypt(value) ?? encryptSecret(value)
  }

  private decrypt(value: string): string | null {
    return this.options.secrets
      ? this.options.secrets.decrypt(value)
      : decryptSecret(value)
  }

  private persistAutomations(): void {
    this.options.store.saveAutomations([...this.automations.values()])
  }

  private saveHistorySoon(): void {
    this.historyDirty = true
    if (this.disposed || this.historyTimer !== null) return
    this.historyTimer = this.timers.set(() => {
      this.historyTimer = null
      this.saveHistoryNow()
    }, this.options.historySaveDelayMs ?? DEFAULT_HISTORY_SAVE_DELAY_MS)
  }

  private saveHistoryNow(): void {
    if (!this.historyDirty) return
    this.historyDirty = false
    try {
      const history: Record<string, AutomationHistory> = {}
      for (const [id, entry] of this.histories) {
        if (this.automations.has(id)) history[id] = entry
      }
      this.options.store.saveHistory(history)
    } catch (error) {
      // Kept dirty: the next change writes it again.
      this.historyDirty = true
      this.log.error(
        { err: errorText(error) },
        "the automation history could not be saved"
      )
    }
  }
}
