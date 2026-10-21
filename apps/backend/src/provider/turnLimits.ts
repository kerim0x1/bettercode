/**
 * Turn limits shared by the provider hub and the direct-API provider service.
 *
 * A turn ends as timed out only after it has gone this long without a
 * provider event, and the clock is paused while a request (approval, plan
 * approval, question) waits for the user. Long agentic runs that keep
 * streaming are bounded only by the generous absolute ceiling.
 */

/** No provider event for this long interrupts the turn as timed out. */
export const TURN_IDLE_TIMEOUT_DEFAULT_MS = 30 * 60_000
/** Absolute ceiling for one turn, whatever its activity. */
export const TURN_MAX_DURATION_DEFAULT_MS = 12 * 60 * 60_000
/** Node turns a longer timer delay into 1 ms, which would end every turn at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface TurnLimits {
  readonly idleTimeoutMs: number
  readonly maxDurationMs: number
}

function limitOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(value)))
}

/**
 * Unset, non-finite or non-positive values take the default, delays are
 * kept within the timer range, and the ceiling is never below the idle limit.
 */
export function normalizeTurnLimits(
  input: {
    readonly idleTimeoutMs?: number
    readonly maxDurationMs?: number
  } = {}
): TurnLimits {
  const idleTimeoutMs = limitOrDefault(
    input.idleTimeoutMs,
    TURN_IDLE_TIMEOUT_DEFAULT_MS
  )
  const maxDurationMs = Math.max(
    idleTimeoutMs,
    limitOrDefault(input.maxDurationMs, TURN_MAX_DURATION_DEFAULT_MS)
  )
  return { idleTimeoutMs, maxDurationMs }
}

export type TurnTimeoutKind = "idle" | "max-duration"

export interface TurnWatchdogOptions extends TurnLimits {
  /** Called once when a limit is hit, after the watchdog has stopped. */
  readonly onTimeout: (kind: TurnTimeoutKind, limitMs: number) => void
  /** True while a request of the turn waits for the user. */
  readonly isWaitingOnUser?: () => boolean
  readonly now?: () => number
}

/**
 * Inactivity watchdog plus absolute deadline for one turn. Activity only
 * moves a timestamp (`touch`), so a streamed token never re-arms a timer; the
 * idle check re-schedules itself for the remaining budget when it fires early.
 */
export class TurnWatchdog {
  private readonly now: () => number
  private lastActivityAt: number
  private idleHandle: ReturnType<typeof setTimeout> | null = null
  private deadlineHandle: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: TurnWatchdogOptions) {
    this.now = options.now ?? Date.now
    this.lastActivityAt = this.now()
    this.scheduleIdleCheck(options.idleTimeoutMs)
    this.deadlineHandle = setTimeout(
      () => this.fire("max-duration", options.maxDurationMs),
      options.maxDurationMs
    )
    this.deadlineHandle.unref?.()
  }

  /** Records provider activity (any event of the turn, or a settled request). */
  touch(): void {
    if (!this.stopped) this.lastActivityAt = this.now()
  }

  stop(): void {
    this.stopped = true
    if (this.idleHandle) {
      clearTimeout(this.idleHandle)
      this.idleHandle = null
    }
    if (this.deadlineHandle) {
      clearTimeout(this.deadlineHandle)
      this.deadlineHandle = null
    }
  }

  private scheduleIdleCheck(delayMs: number): void {
    if (this.idleHandle) clearTimeout(this.idleHandle)
    this.idleHandle = setTimeout(
      () => this.checkIdle(),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs)))
    )
    this.idleHandle.unref?.()
  }

  private checkIdle(): void {
    this.idleHandle = null
    if (this.stopped) return
    if (this.options.isWaitingOnUser?.()) {
      // Waiting on the user is not provider inactivity: hold the clock, so
      // the full idle budget is left once the request settles.
      this.lastActivityAt = this.now()
      this.scheduleIdleCheck(this.options.idleTimeoutMs)
      return
    }
    const remaining =
      this.lastActivityAt + this.options.idleTimeoutMs - this.now()
    if (remaining > 0) {
      this.scheduleIdleCheck(remaining)
      return
    }
    this.fire("idle", this.options.idleTimeoutMs)
  }

  private fire(kind: TurnTimeoutKind, limitMs: number): void {
    if (this.stopped) return
    this.stop()
    this.options.onTimeout(kind, limitMs)
  }
}
