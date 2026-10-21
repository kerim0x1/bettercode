import type { ProviderAdapterShape, ProviderKind } from "./contracts"
import {
  ProviderSessionCapacityError,
  ProviderTurnCapacityError,
} from "./ProviderHubErrors"
import type { ProviderRuntimeInstance } from "./ProviderHubTypes"

/** Optional lower operational limits; values cannot exceed the hard caps. */
export interface ProviderTurnCapacityOptions {
  readonly maxActiveTurns?: number
  readonly maxActiveTurnsPerProvider?: number
  readonly maxActiveTurnsPerInstance?: number
  readonly maxLiveSessions?: number
  readonly maxLiveSessionsPerInstance?: number
  readonly sessionAdmissionQueueMaxEntries?: number
}

/** The part of a turn admission that counts against active-turn capacity. */
export interface ProviderTurnCapacityEntry {
  readonly providerKind: ProviderKind
  readonly providerInstanceId: string | null
  readonly providerInstance: ProviderRuntimeInstance | null
}

/**
 * The provider hub's operational limits: active turns (global, per provider,
 * per backend) and live sessions (global, per backend), plus the depth of the
 * session-admission queue. Instances that share one adapter share its
 * per-instance limits, so aliases cannot multiply a backend's capacity. The
 * checks are synchronous on purpose: the hub reserves right after checking,
 * with no promise boundary in between for another caller to slip through.
 */
export class ProviderTurnCapacity {
  private static readonly ACTIVE_TURNS_DEFAULT = 32
  private static readonly ACTIVE_TURNS_HARD_MAX = 128
  private static readonly ACTIVE_TURNS_PER_PROVIDER_DEFAULT = 16
  private static readonly ACTIVE_TURNS_PER_PROVIDER_HARD_MAX = 64
  private static readonly ACTIVE_TURNS_PER_INSTANCE_DEFAULT = 8
  private static readonly ACTIVE_TURNS_PER_INSTANCE_HARD_MAX = 32
  private static readonly LIVE_SESSIONS_DEFAULT = 64
  private static readonly LIVE_SESSIONS_HARD_MAX = 256
  private static readonly LIVE_SESSIONS_PER_INSTANCE_DEFAULT = 16
  private static readonly LIVE_SESSIONS_PER_INSTANCE_HARD_MAX = 64
  private static readonly SESSION_ADMISSION_QUEUE_DEFAULT = 64
  private static readonly SESSION_ADMISSION_QUEUE_HARD_MAX = 256
  readonly maxActiveTurns: number
  readonly maxActiveTurnsPerProvider: number
  readonly maxActiveTurnsPerInstance: number
  readonly maxLiveSessions: number
  readonly maxLiveSessionsPerInstance: number
  readonly sessionAdmissionQueueMaxEntries: number

  constructor(options: ProviderTurnCapacityOptions) {
    this.maxActiveTurns = boundedProviderOperationalLimit(
      options.maxActiveTurns,
      ProviderTurnCapacity.ACTIVE_TURNS_DEFAULT,
      ProviderTurnCapacity.ACTIVE_TURNS_HARD_MAX
    )
    this.maxActiveTurnsPerProvider = boundedProviderOperationalLimit(
      options.maxActiveTurnsPerProvider,
      ProviderTurnCapacity.ACTIVE_TURNS_PER_PROVIDER_DEFAULT,
      ProviderTurnCapacity.ACTIVE_TURNS_PER_PROVIDER_HARD_MAX
    )
    this.maxActiveTurnsPerInstance = boundedProviderOperationalLimit(
      options.maxActiveTurnsPerInstance,
      ProviderTurnCapacity.ACTIVE_TURNS_PER_INSTANCE_DEFAULT,
      ProviderTurnCapacity.ACTIVE_TURNS_PER_INSTANCE_HARD_MAX
    )
    this.maxLiveSessions = boundedProviderOperationalLimit(
      options.maxLiveSessions,
      ProviderTurnCapacity.LIVE_SESSIONS_DEFAULT,
      ProviderTurnCapacity.LIVE_SESSIONS_HARD_MAX
    )
    this.maxLiveSessionsPerInstance = boundedProviderOperationalLimit(
      options.maxLiveSessionsPerInstance,
      ProviderTurnCapacity.LIVE_SESSIONS_PER_INSTANCE_DEFAULT,
      ProviderTurnCapacity.LIVE_SESSIONS_PER_INSTANCE_HARD_MAX
    )
    this.sessionAdmissionQueueMaxEntries = boundedProviderOperationalLimit(
      options.sessionAdmissionQueueMaxEntries,
      ProviderTurnCapacity.SESSION_ADMISSION_QUEUE_DEFAULT,
      ProviderTurnCapacity.SESSION_ADMISSION_QUEUE_HARD_MAX
    )
  }

  assertTurnCapacity(
    turnsByThread: ReadonlyMap<string, ProviderTurnCapacityEntry>,
    provider: ProviderKind,
    instance: ProviderRuntimeInstance | null
  ): void {
    if (turnsByThread.size >= this.maxActiveTurns) {
      throw new ProviderTurnCapacityError("global", this.maxActiveTurns)
    }

    let providerTurns = 0
    let instanceTurns = 0
    for (const admission of turnsByThread.values()) {
      if (admission.providerKind === provider) providerTurns += 1
      if (
        instance &&
        (admission.providerInstance?.adapter === instance.adapter ||
          (!admission.providerInstance &&
            admission.providerInstanceId === instance.instanceId))
      ) {
        instanceTurns += 1
      }
    }
    if (providerTurns >= this.maxActiveTurnsPerProvider) {
      throw new ProviderTurnCapacityError(
        "provider",
        this.maxActiveTurnsPerProvider
      )
    }
    if (instance && instanceTurns >= this.maxActiveTurnsPerInstance) {
      throw new ProviderTurnCapacityError(
        "instance",
        this.maxActiveTurnsPerInstance
      )
    }
  }

  assertSessionCapacity(
    instance: ProviderRuntimeInstance,
    liveSessions: ReadonlyMap<ProviderAdapterShape, ReadonlySet<string>>
  ): void {
    let globalCount = 0
    for (const sessions of liveSessions.values()) globalCount += sessions.size
    if (globalCount >= this.maxLiveSessions) {
      throw new ProviderSessionCapacityError("global", this.maxLiveSessions)
    }
    const targetCount = liveSessions.get(instance.adapter)?.size ?? 0
    if (targetCount >= this.maxLiveSessionsPerInstance) {
      throw new ProviderSessionCapacityError(
        "instance",
        this.maxLiveSessionsPerInstance
      )
    }
  }
}

function boundedProviderOperationalLimit(
  requested: number | undefined,
  defaultValue: number,
  hardMaximum: number
): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return defaultValue
  }
  return Math.max(1, Math.min(hardMaximum, Math.floor(requested)))
}
