import type { ProviderKind, ThreadId } from "./contracts"
import type { ProviderHub } from "./ProviderHub"
import type {
  ProviderSessionBinding,
  ProviderSessionBindingStore,
} from "./ProviderSessionBindingStore"

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export interface ProviderSessionReaperLogger {
  info(bindings: Record<string, unknown>, message: string): void
  warn(bindings: Record<string, unknown>, message: string): void
  debug?(bindings: Record<string, unknown>, message: string): void
}

export interface ProviderSessionReaperOptions {
  readonly bindings: ProviderSessionBindingStore
  readonly providerHub: Pick<
    ProviderHub,
    "stopSession" | "withThreadMaintenance"
  >
  readonly logger: ProviderSessionReaperLogger
  readonly inactivityThresholdMs?: number
  readonly sweepIntervalMs?: number
  readonly now?: () => number
}

export interface ProviderSessionReaperSweepResult {
  readonly totalBindings: number
  readonly reapedCount: number
  readonly skippedActiveCount: number
  readonly skippedFreshCount: number
  readonly skippedStoppedCount: number
  readonly failedCount: number
}

export class ProviderSessionReaper {
  private readonly inactivityThresholdMs: number
  private readonly sweepIntervalMs: number
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private sweepInFlight: Promise<ProviderSessionReaperSweepResult> | null = null
  private stopped = false

  constructor(private readonly options: ProviderSessionReaperOptions) {
    const inactivityThreshold =
      options.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS
    this.inactivityThresholdMs = Number.isFinite(inactivityThreshold)
      ? Math.max(1, inactivityThreshold)
      : DEFAULT_INACTIVITY_THRESHOLD_MS
    const sweepInterval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    // Node turns an overflowing timer delay into 1 ms, producing a busy sweep loop.
    this.sweepIntervalMs = Number.isFinite(sweepInterval)
      ? Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.trunc(sweepInterval)))
      : DEFAULT_SWEEP_INTERVAL_MS
    this.now = options.now ?? Date.now
  }

  start(): () => void {
    if (this.timer)
      return () => {
        void this.stop()
      }
    this.stopped = false
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        this.options.logger.warn(
          { err },
          "provider.session.reaper.sweep-failed"
        )
      })
    }, this.sweepIntervalMs)
    this.timer.unref?.()
    this.options.logger.info(
      {
        inactivityThresholdMs: this.inactivityThresholdMs,
        sweepIntervalMs: this.sweepIntervalMs,
      },
      "provider.session.reaper.started"
    )
    return () => {
      void this.stop()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.sweepInFlight
  }

  sweep(): Promise<ProviderSessionReaperSweepResult> {
    if (this.stopped) {
      return Promise.resolve(emptySweepResult())
    }
    if (this.sweepInFlight) return this.sweepInFlight
    const sweep = this.runSweep().finally(() => {
      if (this.sweepInFlight === sweep) this.sweepInFlight = null
    })
    this.sweepInFlight = sweep
    return sweep
  }

  private async runSweep(): Promise<ProviderSessionReaperSweepResult> {
    const bindings = this.options.bindings.list()
    const now = this.now()
    let reapedCount = 0
    let skippedActiveCount = 0
    let skippedFreshCount = 0
    let skippedStoppedCount = 0
    let failedCount = 0

    for (const binding of bindings) {
      if (isStoppedBinding(binding)) {
        skippedStoppedCount += 1
        continue
      }

      if (binding.activeTurnId) {
        skippedActiveCount += 1
        this.options.logger.debug?.(
          {
            threadId: binding.threadId,
            providerInstanceId: binding.providerInstanceId,
            activeTurnId: binding.activeTurnId,
          },
          "provider.session.reaper.skipped-active-turn"
        )
        continue
      }

      const updatedAtMs = Date.parse(binding.updatedAt)
      if (Number.isNaN(updatedAtMs)) {
        failedCount += 1
        this.options.logger.warn(
          {
            threadId: binding.threadId,
            providerInstanceId: binding.providerInstanceId,
            updatedAt: binding.updatedAt,
          },
          "provider.session.reaper.invalid-updated-at"
        )
        continue
      }

      const idleDurationMs = now - updatedAtMs
      if (idleDurationMs < this.inactivityThresholdMs) {
        skippedFreshCount += 1
        continue
      }

      try {
        const providerKind = providerKindForHub(binding.providerKind)
        await this.options.providerHub.withThreadMaintenance(
          binding.threadId,
          () =>
            this.options.providerHub.stopSession(
              providerKind,
              binding.threadId as ThreadId,
              binding.providerInstanceId
            )
        )
        this.options.bindings.updateSessionLifecycle({
          threadId: binding.threadId,
          providerKind: binding.providerKind,
          providerInstanceId: binding.providerInstanceId,
          status: "stopped",
          activeTurnId: null,
        })
        reapedCount += 1
        this.options.logger.info(
          {
            threadId: binding.threadId,
            providerKind: binding.providerKind,
            providerInstanceId: binding.providerInstanceId,
            idleDurationMs,
            reason: "inactivity_threshold",
          },
          "provider.session.reaped"
        )
      } catch (err) {
        failedCount += 1
        this.options.logger.warn(
          {
            err,
            threadId: binding.threadId,
            providerKind: binding.providerKind,
            providerInstanceId: binding.providerInstanceId,
            idleDurationMs,
          },
          "provider.session.reaper.stop-failed"
        )
      }
    }

    if (reapedCount > 0) {
      this.options.logger.info(
        { reapedCount, totalBindings: bindings.length },
        "provider.session.reaper.sweep-complete"
      )
    }

    return {
      totalBindings: bindings.length,
      reapedCount,
      skippedActiveCount,
      skippedFreshCount,
      skippedStoppedCount,
      failedCount,
    }
  }
}

function emptySweepResult(): ProviderSessionReaperSweepResult {
  return {
    totalBindings: 0,
    reapedCount: 0,
    skippedActiveCount: 0,
    skippedFreshCount: 0,
    skippedStoppedCount: 0,
    failedCount: 0,
  }
}

function isStoppedBinding(binding: ProviderSessionBinding): boolean {
  return binding.status === "stopped" || binding.status === "closed"
}

function providerKindForHub(providerKind: ProviderKind): ProviderKind {
  if (providerKind === "codex_cli") return "codex"
  if (providerKind === "anthropic_cli") return "claude"
  return providerKind
}
