import { randomUUID } from "node:crypto"
import {
  isThreadResumeLimit,
  type ChatResumeAction,
  type ChatSendBody,
  type ThreadResume,
  type ThreadResumePrompt,
} from "@betterc0de/schema"
import type { LegacyProviderEvent } from "../../provider/types"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import {
  afterFailedAttempt,
  isResumableOrigin,
  limitRecord,
  MAX_RESTART_CONTINUATIONS,
  resumeAtForLimit,
  resumeMessage,
  resumeTemplate,
  scheduledRecord,
  STARTUP_RESUME_DELAY_MS,
  timerDelay,
  type ResumeTemplate,
  type TurnOrigin,
} from "./resume-policy"
import type {
  ChatResumeStore,
  ResumeTurnState,
  RunningTurnMarker,
} from "./resume-store"
import {
  mergeProviderLimits,
  providerLimitFromTurnError,
  type ProviderLimit,
  type RateLimitReport,
} from "./usage-limit"

/**
 * Resumes chats that stopped before their work was done
 * (`@betterc0de/schema` thread-resume.ts):
 *
 * - It watches every chat's turns on the provider event bus. A turn that
 *   ends on a usage or rate limit gets a record with the reset time; with
 *   "Resume chats stopped by a usage limit" on, "Continue." goes out a
 *   little after the reset (after 30 minutes, 1 hour and 2 hours when the
 *   provider named no reset). Limited again: re-armed with the new reset.
 *   The third failed attempt in a row stops it.
 * - It keeps a marker of the running turn with the chat. A marker left by
 *   a quit or crash is continued once at the next start ("Continue running
 *   chats after a restart"), unless the chat was waiting for an approval,
 *   its provider cannot resume a session, or the user had stopped it.
 * - Anything the user sends, a Stop, or "Don't resume" cancels it.
 *
 * Its turns are ordinary chat turns (`dispatch`), sent with the settings of
 * the turn that stopped; it never calls a provider itself. The record lives
 * with the chat (resume-store.ts), so a schedule survives restarts.
 */

export interface ResumeTurn {
  readonly turnId: string
  readonly settled: Promise<void>
}

/** Who asked for "Resume now": a paired device's limits apply to its turn. */
export interface ResumeCaller {
  readonly capBody: (body: ChatSendBody) => ChatSendBody
  readonly reserveRemoteTurn: () => RemoteProviderTurnReservation | null
}

export interface ResumeDispatchRequest {
  readonly threadId: string
  readonly template: ResumeTemplate
  readonly content: string
  readonly messageId: string
  readonly createdAt: string
  readonly caller: ResumeCaller | null
}

export interface ChatResumeSettings {
  readonly resumeAfterUsageLimit: boolean
  readonly continueAfterRestart: boolean
  readonly autoSave: boolean
}

export interface ChatResumePorts {
  readonly store: ChatResumeStore
  now(): number
  random(): number
  settings(): ChatResumeSettings
  /** Whether the provider picks its session up again after a restart. */
  canResumeSession(
    providerKind: string | null,
    providerInstanceId: string | null
  ): boolean
  /** Whether no turn runs in the chat now. */
  isIdle(threadId: string): boolean
  /**
   * Sends the turn as `/chat/send` would. `guard` throws once the resume
   * was cancelled; `started` runs when the provider accepted the turn.
   */
  dispatch(
    request: ResumeDispatchRequest,
    guard: () => void,
    started: (turn: ResumeTurn) => void
  ): Promise<void>
  /** Tells every client about the record and the message just sent. */
  publish(
    threadId: string,
    record: ThreadResume | null,
    prompt?: ThreadResumePrompt
  ): void
  onError(error: unknown): void
}

/** A turn running in this process. */
interface LiveTurn {
  readonly turnId: string | null
  readonly origin: TurnOrigin | null
  readonly providerKind: string | null
  readonly providerInstanceId: string | null
  readonly openRequests: Set<string>
}

/** The scheduler's own turn, from dispatch until it ends. */
interface Attempt {
  readonly id: string
  readonly messageId: string
  readonly origin: TurnOrigin
  turnId: string | null
  dispatching: boolean
}

/** A dispatch seen before its turn started. */
interface PendingDispatch {
  readonly origin: TurnOrigin
  readonly template: ResumeTemplate | null
  readonly at: number
}

/** The latest limit of a chat's turn, to merge a second report of it. */
interface RecentLimit {
  readonly turnKey: string | null
  readonly at: number
  limit: ProviderLimit
}

/** A dispatch this old no longer explains a turn that starts. */
const DISPATCH_MATCH_MS = 5 * 60_000
/** Two limit reports of one turn arrive within this. */
const LIMIT_MERGE_MS = 60_000
/** After a resumed turn settles, its end event gets this long to arrive. */
const SETTLE_GRACE_MS = 3_000

const REQUEST_OPENED = new Set([
  "tool_approval_requested",
  "plan_approval_requested",
  "user_input_requested",
])
const REQUEST_CLOSED = new Set([
  "tool_approval_resolved",
  "plan_approval_resolved",
  "user_input_resolved",
])

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function payloadTurnId(payload: Record<string, unknown>): string | null {
  return text(payload.turn_id) ?? text(payload.turnId)
}

function providerKindOf(payload: Record<string, unknown>): string | null {
  return (
    text(payload.providerKind) ??
    text(payload.provider_kind) ??
    text(payload.provider)
  )
}

function providerInstanceOf(payload: Record<string, unknown>): string | null {
  return text(payload.providerInstanceId) ?? text(payload.provider_instance_id)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ChatResumeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generations = new Map<string, number>()
  private readonly live = new Map<string, LiveTurn>()
  private readonly dispatches = new Map<string, PendingDispatch>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly recentLimits = new Map<string, RecentLimit>()
  private readonly rateLimits = new Map<string, RateLimitReport>()
  private shuttingDown = false
  private closed = false

  constructor(private readonly ports: ChatResumePorts) {}

  /** The chat's record, as clients see it. */
  get(threadId: string): ThreadResume | null {
    return this.ports.store.readRecord(threadId)
  }

  // ── Startup ──────────────────────────────────────────────────────────

  /**
   * Picks up what the previous process left: records to arm again, and
   * markers of turns a quit or crash cut off. Runs before the backend
   * accepts requests; every resume waits `STARTUP_RESUME_DELAY_MS` so the
   * providers come up first.
   */
  recover(): void {
    const now = this.ports.now()
    const notBefore = now + STARTUP_RESUME_DELAY_MS
    for (const row of this.ports.store.listPending()) {
      try {
        let record = row.record
        const turn = row.turn
        if (turn?.running) {
          this.ports.store.writeTurnState(row.threadId, withoutRunning(turn))
          if (record?.status === "resuming") {
            // The scheduler's own turn was cut off: it goes out again. A
            // restart continuation cut off again counts toward
            // MAX_RESTART_CONTINUATIONS, so a crash loop ends.
            const continuations = (turn.restartContinuations ?? 0) + 1
            if (
              record.reason === "restart" &&
              continuations > MAX_RESTART_CONTINUATIONS
            ) {
              record = {
                ...record,
                status: "waiting",
                mode: "off",
                resumeAt: null,
                note: "Restarts interrupted this chat several times in a row, so it was not continued again.",
              }
            } else {
              if (record.reason === "restart")
                this.ports.store.writeTurnState(row.threadId, {
                  ...withoutRunning(turn),
                  restartContinuations: continuations,
                })
              record = { ...record, status: "waiting", resumeAt: notBefore }
            }
            this.save(row.threadId, record)
          } else if (!record || !isThreadResumeLimit(record)) {
            record =
              this.restartRecord(row.threadId, turn.running, turn, now) ??
              record
          }
        } else if (record?.status === "resuming") {
          record = {
            ...record,
            status: "waiting",
            resumeAt: record.mode === "auto" ? notBefore : null,
          }
          this.save(row.threadId, record)
        }
        if (record) this.arm(row.threadId, record, notBefore)
      } catch (error) {
        this.ports.onError(error)
      }
    }
  }

  /** The record for a chat a restart cut off, or `null` to leave it. */
  private restartRecord(
    threadId: string,
    running: RunningTurnMarker,
    turn: ResumeTurnState,
    now: number
  ): ThreadResume | null {
    const settings = this.ports.settings()
    if (!settings.continueAfterRestart || !settings.autoSave) return null
    // A turn the user did not send (a goal, a worker) belongs to its own
    // scheduler, which handles a restart itself.
    if (!isResumableOrigin(running.origin)) return null
    const base = {
      reason: "restart",
      stoppedAt: now,
      resetAt: null,
      status: "waiting",
      failures: 0,
      resumable: turn.template !== undefined,
      providerKind: running.providerKind,
    } as const
    if (running.waitingForApproval) {
      // The provider that asked is gone; resuming asks again.
      const record: ThreadResume = {
        ...base,
        mode: "off",
        resumeAt: null,
        note: "The app restarted while this chat was waiting for your approval. Resume it to ask again.",
      }
      this.save(threadId, record)
      return record
    }
    if (!turn.template) return null
    if (
      !this.ports.canResumeSession(
        running.providerKind,
        running.providerInstanceId
      )
    )
      return null
    if ((turn.restartContinuations ?? 0) >= MAX_RESTART_CONTINUATIONS) {
      const record: ThreadResume = {
        ...base,
        mode: "off",
        resumeAt: null,
        note: "Restarts interrupted this chat several times in a row, so it was not continued again.",
      }
      this.save(threadId, record)
      return record
    }
    const record: ThreadResume = {
      ...base,
      mode: "auto",
      resumeAt: now + STARTUP_RESUME_DELAY_MS,
      note: null,
    }
    this.ports.store.writeTurnState(threadId, {
      ...withoutRunning(turn),
      restartContinuations: (turn.restartContinuations ?? 0) + 1,
    })
    this.save(threadId, record)
    return record
  }

  // ── Turns ────────────────────────────────────────────────────────────

  /**
   * A chat turn is about to be sent (`dispatchChatTurn`). Anything but the
   * scheduler's own turn continues the chat, so a waiting resume is
   * dropped; a turn the user sent is the one a later resume repeats the
   * settings of.
   */
  noteDispatch(body: ChatSendBody, origin: TurnOrigin): void {
    if (this.closed) return
    const threadId = body.thread_id
    const attempt = this.attempts.get(threadId)
    // The scheduler's own turn carries the message id it chose.
    const ownOrigin =
      attempt &&
      attempt.dispatching &&
      attempt.messageId === body.user_message_id
        ? attempt.origin
        : null
    this.dispatches.set(threadId, {
      origin: ownOrigin ?? origin,
      template: !ownOrigin && origin === "user" ? resumeTemplate(body) : null,
      at: this.ports.now(),
    })
    if (ownOrigin) return
    // Bookkeeping must never refuse the user's message.
    try {
      this.drop(threadId)
    } catch (error) {
      this.ports.onError(error)
    }
  }

  /** The user pressed Stop: nothing of this chat continues by itself. */
  noteUserStop(threadId: string): void {
    if (this.closed) return
    try {
      this.drop(threadId)
      this.attempts.delete(threadId)
      if (!this.shuttingDown) this.clearRunningMarker(threadId)
    } catch (error) {
      this.ports.onError(error)
    }
  }

  /** One event of the provider event bus, after it was journaled. */
  observe(event: LegacyProviderEvent): void {
    if (this.closed) return
    const threadId = event.thread_id
    const payload: Record<string, unknown> = event.payload ?? {}
    try {
      if (event.event_type === "account.rate-limits.updated") {
        this.rememberRateLimits(payload)
        return
      }
      // A subagent's turn is part of its parent's.
      if (payload.parentTaskId || payload.parentAgentId) return
      switch (event.event_type) {
        case "turn_started":
        case "turn.started":
          this.onTurnStarted(threadId, payload)
          return
        case "turn_error":
          this.onTurnError(threadId, payload)
          return
        case "turn_completed":
          this.onTurnEnded(threadId, payload)
          return
        case "turn_interrupted":
        case "turn.aborted":
          this.onTurnEnded(threadId, payload)
          return
        case "session.exited":
        case "session_exited":
          if (this.live.has(threadId)) this.onTurnEnded(threadId, payload)
          return
        default:
          if (REQUEST_OPENED.has(event.event_type))
            this.onRequest(threadId, payload, true)
          else if (REQUEST_CLOSED.has(event.event_type))
            this.onRequest(threadId, payload, false)
      }
    } catch (error) {
      this.ports.onError(error)
    }
  }

  private onTurnStarted(
    threadId: string,
    payload: Record<string, unknown>
  ): void {
    const now = this.ports.now()
    const pending = this.dispatches.get(threadId)
    this.dispatches.delete(threadId)
    // A turn nobody here sent has no known origin, unless it continues the
    // one still running (a provider that starts a turn of its own inside).
    const dispatch =
      pending && now - pending.at <= DISPATCH_MATCH_MS ? pending : null
    const origin = dispatch?.origin ?? this.live.get(threadId)?.origin ?? null
    const turnId = payloadTurnId(payload)
    const live: LiveTurn = {
      turnId,
      origin,
      providerKind: providerKindOf(payload),
      providerInstanceId: providerInstanceOf(payload),
      openRequests: new Set(),
    }
    this.live.set(threadId, live)
    const attempt = this.attempts.get(threadId)
    if (attempt && origin === attempt.origin && attempt.turnId === null)
      attempt.turnId = turnId
    if (this.shuttingDown) return
    // The marker a restart continues the chat from.
    const previous = this.ports.store.readTurnState(threadId)
    const template = dispatch?.template ?? previous?.template ?? undefined
    this.ports.store.writeTurnState(threadId, {
      ...(template ? { template } : {}),
      restartContinuations:
        origin === "user" ? 0 : (previous?.restartContinuations ?? 0),
      running: {
        turnId,
        origin,
        startedAt: now,
        providerKind: live.providerKind,
        providerInstanceId: live.providerInstanceId,
        waitingForApproval: false,
      },
    })
  }

  private onRequest(
    threadId: string,
    payload: Record<string, unknown>,
    open: boolean
  ): void {
    const live = this.live.get(threadId)
    if (!live) return
    const id =
      text(payload.requestId) ??
      text(payload.request_id) ??
      text(payload.event_id) ??
      "request"
    const before = live.openRequests.size > 0
    if (open) live.openRequests.add(id)
    else live.openRequests.delete(id)
    const after = live.openRequests.size > 0
    if (before === after || this.shuttingDown) return
    const state = this.ports.store.readTurnState(threadId)
    if (!state?.running) return
    this.ports.store.writeTurnState(threadId, {
      ...state,
      running: { ...state.running, waitingForApproval: after },
    })
  }

  private onTurnError(
    threadId: string,
    payload: Record<string, unknown>
  ): void {
    if (!this.shuttingDown) {
      const live = this.live.get(threadId) ?? null
      const now = this.ports.now()
      const report =
        this.rateLimits.get(
          live?.providerInstanceId ?? providerInstanceOf(payload) ?? ""
        ) ??
        this.rateLimits.get(live?.providerKind ?? providerKindOf(payload) ?? "")
      const limit = providerLimitFromTurnError(payload, now, report)
      if (limit) this.recordLimit(threadId, live, limit, payload)
    }
    // Whether the turn's own failure or a runtime error before it, the turn
    // is over: a restart has nothing to continue.
    this.onTurnEnded(threadId, payload)
  }

  /**
   * A turn ended (completed, failed, interrupted). During shutdown nothing
   * changes: the marker stays for the next start to continue.
   */
  private onTurnEnded(
    threadId: string,
    payload: Record<string, unknown>
  ): void {
    if (this.shuttingDown) return
    const live = this.live.get(threadId)
    const endedTurnId = payloadTurnId(payload) ?? live?.turnId ?? null
    if (live && (!live.turnId || !endedTurnId || live.turnId === endedTurnId))
      this.live.delete(threadId)
    const attempt = this.attempts.get(threadId)
    const record = this.ports.store.readRecord(threadId)
    this.clearRunningMarker(threadId, record !== null)
    if (!attempt || attempt.turnId === null) return
    if (endedTurnId && attempt.turnId !== endedTurnId) return
    this.attempts.delete(threadId)
    // The resumed turn ran: unless a new limit re-armed the record, the
    // chat is going again (or the user stopped it, or it failed for
    // another reason the transcript shows).
    if (record?.status === "resuming") this.drop(threadId)
  }

  private recordLimit(
    threadId: string,
    live: LiveTurn | null,
    limit: ProviderLimit,
    payload: Record<string, unknown>
  ): void {
    const now = this.ports.now()
    const turnKey = live?.turnId ?? payloadTurnId(payload)
    const existing = this.ports.store.readRecord(threadId)
    const recent = this.recentLimits.get(threadId)
    if (
      recent &&
      recent.turnKey === turnKey &&
      now - recent.at <= LIMIT_MERGE_MS &&
      existing &&
      isThreadResumeLimit(existing) &&
      existing.status === "waiting"
    ) {
      // A second report of the same turn: it may only add the reset time.
      recent.limit = mergeProviderLimits(recent.limit, limit)
      if (existing.resetAt !== null || recent.limit.resetAt === null) return
      const next: ThreadResume = {
        ...existing,
        resetAt: recent.limit.resetAt,
        resumeAt:
          existing.mode === "auto"
            ? resumeAtForLimit({
                resetAt: recent.limit.resetAt,
                failures: existing.failures,
                now,
                random: () => this.ports.random(),
              })
            : null,
      }
      this.save(threadId, next)
      this.arm(threadId, next)
      return
    }
    this.recentLimits.set(threadId, { turnKey, at: now, limit })
    const origin = live?.origin ?? null
    const attempt = this.attempts.get(threadId)
    const previous =
      attempt && origin === attempt.origin && existing?.status === "resuming"
        ? existing
        : null
    const template = this.templateFor(threadId)
    const settings = this.ports.settings()
    const record = limitRecord({
      limit,
      now,
      random: () => this.ports.random(),
      autoResume:
        settings.resumeAfterUsageLimit &&
        settings.autoSave &&
        isResumableOrigin(origin),
      resumable: template !== null,
      providerKind: live?.providerKind ?? providerKindOf(payload),
      previous,
    })
    if (template) {
      const state = this.ports.store.readTurnState(threadId)
      if (!state?.template)
        this.ports.store.writeTurnState(threadId, {
          ...(state ?? {}),
          template,
        })
    }
    this.bump(threadId)
    this.save(threadId, record)
    this.arm(threadId, record)
  }

  private rememberRateLimits(payload: Record<string, unknown>): void {
    const report: RateLimitReport = {
      snapshot: payload.rateLimits ?? payload.rate_limits ?? payload,
      receivedAt: this.ports.now(),
    }
    const instance = providerInstanceOf(payload)
    const kind = providerKindOf(payload)
    if (instance) this.rateLimits.set(instance, report)
    if (kind) this.rateLimits.set(kind, report)
  }

  // ── The user's choice ────────────────────────────────────────────────

  /**
   * POST /chat/resume. Returns the record after the change, `null` when
   * the chat has none (or no longer has one).
   */
  async control(
    threadId: string,
    action: ChatResumeAction,
    caller: ResumeCaller | null = null
  ): Promise<ThreadResume | null> {
    if (this.closed) throw new Error("Chat resuming is shutting down.")
    const record = this.ports.store.readRecord(threadId)
    if (!record) return null
    if (action === "dismiss") {
      this.drop(threadId)
      return null
    }
    if (record.status === "resuming") return record
    if (action === "cancel") {
      this.bump(threadId)
      this.cancelTimer(threadId)
      const next: ThreadResume = { ...record, mode: "off", resumeAt: null }
      this.save(threadId, next)
      return next
    }
    if (action === "schedule") {
      const next = scheduledRecord({
        record,
        now: this.ports.now(),
        random: () => this.ports.random(),
      })
      this.bump(threadId)
      this.save(threadId, next)
      this.arm(threadId, next)
      return next
    }
    await this.attempt(threadId, record, { manual: true, caller })
    return this.ports.store.readRecord(threadId)
  }

  // ── Resuming ─────────────────────────────────────────────────────────

  private async fire(threadId: string, generation: number): Promise<void> {
    this.timers.delete(threadId)
    if (this.closed || this.shuttingDown) return
    // `arm` reads a chat without a generation yet (one a restart left) as 0.
    if ((this.generations.get(threadId) ?? 0) !== generation) return
    const record = this.ports.store.readRecord(threadId)
    if (!record || record.mode !== "auto" || record.status !== "waiting") return
    if (!this.ports.store.hasThread(threadId)) return
    await this.attempt(threadId, record, { manual: false, caller: null })
  }

  /**
   * Sends the resume turn. An automatic attempt that cannot start counts as
   * a failure and is tried again later; a manual one ("Resume now") throws
   * to its caller and leaves the record as it was.
   */
  private async attempt(
    threadId: string,
    record: ThreadResume,
    options: { readonly manual: boolean; readonly caller: ResumeCaller | null }
  ): Promise<void> {
    const generation = this.bump(threadId)
    this.cancelTimer(threadId)
    const refuse = (reason: string): void => {
      if (options.manual) {
        // The bump above cancelled the schedule; a refused "Resume now"
        // leaves it as it was.
        this.arm(threadId, record)
        throw new Error(reason)
      }
      const next = afterFailedAttempt({
        record,
        reason,
        now: this.ports.now(),
      })
      this.save(threadId, next)
      this.arm(threadId, next)
    }
    if (!this.ports.settings().autoSave) {
      refuse(
        "Conversation auto-save is off. Turn it on to resume chats by themselves."
      )
      return
    }
    const template = this.templateFor(threadId)
    if (!template) {
      if (options.manual) {
        this.arm(threadId, record)
        throw new Error(
          "This chat has no turn settings to resume with. Send a message to continue."
        )
      }
      this.save(threadId, {
        ...record,
        mode: "off",
        resumeAt: null,
        resumable: false,
        note: "Send a message to continue this chat.",
      })
      return
    }
    if (!this.ports.isIdle(threadId)) {
      refuse("The chat is busy with another turn.")
      return
    }
    const { content, automatic } = resumeMessage(record)
    const createdAt = new Date(this.ports.now()).toISOString()
    const attempt: Attempt = {
      id: randomUUID(),
      messageId: randomUUID(),
      origin: record.reason === "restart" ? "restart" : "resume",
      turnId: null,
      dispatching: true,
    }
    const resuming: ThreadResume = {
      ...record,
      mode: "auto",
      status: "resuming",
      resumeAt: null,
      note: null,
    }
    this.attempts.set(threadId, attempt)
    this.save(threadId, resuming)
    const guard = () => {
      if (
        this.closed ||
        this.shuttingDown ||
        this.generations.get(threadId) !== generation
      )
        throw new Error("Resuming the chat was cancelled.")
    }
    try {
      await this.ports.dispatch(
        {
          threadId,
          template,
          content,
          messageId: attempt.messageId,
          createdAt,
          caller: options.caller,
        },
        guard,
        (turn) => {
          attempt.turnId = turn.turnId
          void turn.settled.then(
            () => this.settled(threadId, attempt, null),
            (error: unknown) => this.settled(threadId, attempt, error)
          )
          // The turn runs already: nothing here may fail its dispatch.
          try {
            this.ports.store.markAutomatic(
              threadId,
              attempt.messageId,
              automatic
            )
            const modelId = text(template.model_id)
            this.ports.publish(threadId, resuming, {
              messageId: attempt.messageId,
              content,
              createdAt,
              automatic,
              ...(modelId ? { modelId } : {}),
            })
          } catch (error) {
            this.ports.onError(error)
          }
        }
      )
      attempt.dispatching = false
    } catch (error) {
      attempt.dispatching = false
      if (this.attempts.get(threadId) === attempt)
        this.attempts.delete(threadId)
      // Cancelled meanwhile (the user sent something, chose otherwise), or
      // the backend is stopping: the next start sends it again.
      if (
        this.closed ||
        this.shuttingDown ||
        this.generations.get(threadId) !== generation
      )
        return
      if (options.manual) {
        this.save(threadId, record)
        this.arm(threadId, record)
        throw error
      }
      refuse(errorMessage(error))
    }
  }

  /**
   * The resumed turn settled. Its end event normally decided already; if
   * none arrived (or it named another turn), this does.
   */
  private settled(threadId: string, attempt: Attempt, error: unknown): void {
    const timer = setTimeout(() => {
      if (this.closed || this.shuttingDown) return
      if (this.attempts.get(threadId) !== attempt) return
      this.attempts.delete(threadId)
      try {
        const record = this.ports.store.readRecord(threadId)
        if (record?.status !== "resuming") return
        if (error === null) {
          this.drop(threadId)
          return
        }
        const next = afterFailedAttempt({
          record,
          reason: errorMessage(error),
          now: this.ports.now(),
        })
        this.save(threadId, next)
        this.arm(threadId, next)
      } catch (failure) {
        this.ports.onError(failure)
      }
    }, SETTLE_GRACE_MS)
    timer.unref?.()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * The backend is shutting down: no resume goes out, and the turns its
   * shutdown interrupts keep their markers for the next start.
   */
  beginShutdown(): void {
    this.shuttingDown = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** A purged chat: forget its timer and state here. */
  forgetThread(threadId: string): void {
    this.cancelTimer(threadId)
    this.bump(threadId)
    this.live.delete(threadId)
    this.dispatches.delete(threadId)
    this.attempts.delete(threadId)
    this.recentLimits.delete(threadId)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.beginShutdown()
    this.live.clear()
    this.dispatches.clear()
    this.attempts.clear()
    this.recentLimits.clear()
    this.rateLimits.clear()
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private templateFor(threadId: string): ResumeTemplate | null {
    return (
      this.dispatches.get(threadId)?.template ??
      this.ports.store.readTurnState(threadId)?.template ??
      null
    )
  }

  /** Removes the chat's record, if any, and cancels what was scheduled. */
  private drop(threadId: string): void {
    this.cancelTimer(threadId)
    this.bump(threadId)
    if (this.ports.store.readRecord(threadId)) this.save(threadId, null)
  }

  /**
   * The turn is over: clear its marker. Without a record its settings are
   * not needed anymore either.
   */
  private clearRunningMarker(threadId: string, keepTemplate = false): void {
    const state = this.ports.store.readTurnState(threadId)
    if (!state) return
    if (!state.running && (keepTemplate || state.template === undefined)) return
    const rest = withoutRunning(state)
    this.ports.store.writeTurnState(
      threadId,
      keepTemplate ? rest : restartCountOnly(rest)
    )
  }

  private save(
    threadId: string,
    record: ThreadResume | null,
    prompt?: ThreadResumePrompt
  ): void {
    this.ports.store.writeRecord(threadId, record)
    this.ports.publish(threadId, record, prompt)
  }

  private bump(threadId: string): number {
    const next = (this.generations.get(threadId) ?? 0) + 1
    this.generations.set(threadId, next)
    return next
  }

  private cancelTimer(threadId: string): void {
    const timer = this.timers.get(threadId)
    if (timer) clearTimeout(timer)
    this.timers.delete(threadId)
  }

  /** Schedules the record's resume, no earlier than `notBefore`. */
  private arm(threadId: string, record: ThreadResume, notBefore = 0): void {
    this.cancelTimer(threadId)
    if (this.closed || this.shuttingDown) return
    if (
      record.mode !== "auto" ||
      record.status !== "waiting" ||
      record.resumeAt === null
    )
      return
    const generation = this.generations.get(threadId) ?? 0
    const at = Math.max(record.resumeAt, notBefore)
    const timer = setTimeout(
      () => {
        void this.fire(threadId, generation).catch((error: unknown) =>
          this.ports.onError(error)
        )
      },
      timerDelay(at, this.ports.now())
    )
    timer.unref?.()
    this.timers.set(threadId, timer)
  }
}

function withoutRunning(state: ResumeTurnState): ResumeTurnState {
  const { running: _running, ...rest } = state
  return rest
}

function restartCountOnly(state: ResumeTurnState): ResumeTurnState {
  return state.restartContinuations
    ? { restartContinuations: state.restartContinuations }
    : {}
}
