import { EventEmitter } from "node:events"
import type { ProviderAdapter } from "../adapter"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
} from "../types"
import { providerEventBus } from "../events"
import { resolveApproval } from "../permissions"
import { StalePendingProviderRequestError } from "../runtime/pendingRequestErrors"

/**
 * Abstract base class for `ProviderAdapter` implementations.
 *
 * Centralises the small infrastructure that every adapter previously hand-
 * rolled: a per-instance `EventEmitter` for local subscribers, a uniform
 * `emit` that fans events out to both the local bus and the global
 * `providerEventBus`, the `subscribeEvents` accessor, and the approval-
 * response delegation to `resolveApproval`. `interruptAll` has a default
 * implementation that iterates the active session IDs returned by
 * `_activeSessionIds`; override only if a faster path exists.
 *
 * Subclasses must implement: `providerKind`, `displayName`,
 * `availableModels`, `isConfigured`, `sendMessage`, `interrupt`, and
 * `_activeSessionIds` (a snapshot of in-flight thread IDs).
 *
 * Adapters with a different cancellation primitive (e.g. SDK-managed
 * sessions vs `AbortController`) keep their own internal map and just
 * surface its keys via `_activeSessionIds`.
 */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  protected readonly localBus = new EventEmitter()

  abstract providerKind(): ProviderKind
  abstract displayName(): string
  abstract availableModels(): ModelDefinition[]
  abstract isConfigured(): boolean
  abstract sendMessage(input: ProviderSendTurnInput): Promise<void>
  abstract interrupt(threadId: string): Promise<void>

  /** Snapshot of the thread IDs this adapter currently has in-flight.
   *  Default `interruptAll` iterates this list and calls `interrupt(id)`
   *  for each. Subclasses provide whichever map they use as the source. */
  protected abstract _activeSessionIds(): string[]

  subscribeEvents(): EventEmitter {
    return this.localBus
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: "approve" | "deny"
  ): Promise<void> {
    if (!resolveApproval(threadId, requestId, decision)) {
      throw new StalePendingProviderRequestError("approval", requestId)
    }
  }

  async interruptAll(): Promise<number> {
    const ids = this._activeSessionIds()
    const results = await Promise.allSettled(
      ids.map((id) => Promise.resolve().then(() => this.interrupt(id)))
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length)
      throw new AggregateError(
        failures,
        "Failed to interrupt all provider sessions"
      )
    return ids.length
  }

  /** Fan an event out to both the per-instance local bus (for direct
   *  subscribers / tests) and the global provider event bus (for the
   *  WebSocket broadcaster + other cross-cutting consumers). */
  protected emit(event: ProviderRuntimeEvent): void {
    this.localBus.emit("event", event)
    providerEventBus.emitEvent(event)
  }

  /** Default `authMeta`: most adapters authenticate via a renderer-supplied
   *  API key, so the default copy points the user at the settings panel.
   *  Subclasses override for CLI / local-server / oauth flows. The
   *  `ProviderService.getStatus()` route surfaces this so the renderer's
   *  model picker can show provider-specific setup tooltips.
   */
  authMeta(): { authType: string; hint?: string } {
    return {
      authType: "api-key",
      hint: "Not set up — add an API key in Settings.",
    }
  }
}
