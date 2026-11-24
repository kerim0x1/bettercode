import type { ProviderAdapterShape } from "./contracts"
import { ProviderBackendQuarantinedError } from "./ProviderHubErrors"
import type { ProviderRuntimeInstance } from "./ProviderHubTypes"

interface ProviderBackendQuarantine {
  readonly failure: ProviderBackendQuarantinedError
  readonly uncertainThreads: Set<string>
  readonly pendingHardStops: Set<string>
  recoverWhenHardStopsFinish: boolean
}

/** Retains uncertain ownership until cleanup is confirmed. */
export class ProviderBackendQuarantines extends Map<
  ProviderAdapterShape,
  ProviderBackendQuarantine
> {
  constructor(
    private readonly onAvailabilityChanged: (
      adapter: ProviderAdapterShape
    ) => void
  ) {
    super()
  }

  record(
    instance: ProviderRuntimeInstance,
    reason: string,
    options: {
      readonly replaceFailure?: boolean
      readonly hardStopThread?: string
      readonly uncertainThread?: string
    } = {}
  ): ProviderBackendQuarantinedError {
    const { adapter, instanceId } = instance
    const existing = this.get(adapter)
    const pendingHardStops = existing?.pendingHardStops ?? new Set<string>()
    const uncertainThreads = existing?.uncertainThreads ?? new Set<string>()
    // Only a quarantine caused entirely by timed-out hard stops can be
    // released when those stops finish. Retirement and other failures stay fenced.
    const recoverWhenHardStopsFinish =
      options.hardStopThread !== undefined &&
      (existing?.recoverWhenHardStopsFinish ?? true)
    if (options.hardStopThread !== undefined)
      pendingHardStops.add(options.hardStopThread)
    if (options.uncertainThread !== undefined)
      uncertainThreads.add(options.uncertainThread)
    if (existing && !options.replaceFailure) {
      existing.recoverWhenHardStopsFinish = recoverWhenHardStopsFinish
      return existing.failure
    }

    const failure = new ProviderBackendQuarantinedError(
      instanceId,
      existing?.failure.quarantinedAt ?? Date.now(),
      reason
    )
    this.set(adapter, {
      failure,
      pendingHardStops,
      uncertainThreads,
      recoverWhenHardStopsFinish,
    })
    this.onAvailabilityChanged(adapter)
    return failure
  }

  confirmHardStop(adapter: ProviderAdapterShape, threadId: string): void {
    const quarantine = this.get(adapter)
    if (
      quarantine?.pendingHardStops.delete(threadId) &&
      quarantine.recoverWhenHardStopsFinish &&
      quarantine.pendingHardStops.size === 0
    ) {
      this.delete(adapter)
      this.onAvailabilityChanged(adapter)
    }
  }
}
