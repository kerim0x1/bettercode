import { EventEmitter } from "node:events"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "@betterc0de/schema"
import type { LegacyProviderEvent } from "./types"

/**
 * Listeners one lane may hold before Node warns (`MaxListenersExceededWarning`
 * on the process, which the host logs from stderr). Production keeps a
 * handful per lane — ingestion on `"event"` and `"canonical"`, the
 * checkpoint reactor and the goal runtime on `"projected"` — plus one
 * short-lived listener per legacy turn or goal update in flight, so a count
 * past this is a leaked subscription, not load. It used to be unlimited
 * (`setMaxListeners(0)`), which hid exactly that.
 */
export const PROVIDER_EVENT_BUS_MAX_LISTENERS = 64

/**
 * Provider-event bus with three lanes:
 *
 * - `"event"`     — raw legacy input: the frozen in-process provider stack
 *                   (`provider/adapters/`, `provider/service.ts`) and the
 *                   checkpoint reactor's own emissions.
 * - `"canonical"` — raw canonical input: the provider hub. Journaled as-is;
 *                   the legacy bridge runs behind the journal.
 * - `"projected"` — post-journal, post-projection legacy view, published by
 *                   ingestion once an event is durable. The checkpoint
 *                   reactor listens here, so it never observes an event the
 *                   journal has not recorded.
 *
 * Ingestion listens on the first two and emits on the third; nothing
 * re-enters `"event"` from `"projected"`, so there is no loop.
 *
 * Each backend has its own: `createBootRoot` constructs it as
 * `BootRoot.eventBus` and hands it to everything it wires (ingestion, the
 * checkpoint reactor, the provider hub subscription, the goal runtime, the
 * legacy provider service and adapters, and the agent permission runtime's
 * durable-deny notice).
 */
export class ProviderEventBus extends EventEmitter {
  constructor(maxListeners: number = PROVIDER_EVENT_BUS_MAX_LISTENERS) {
    super()
    this.setMaxListeners(maxListeners)
  }

  emitEvent(event: LegacyProviderEvent): void {
    this.emit("event", event)
  }

  emitCanonical(event: CanonicalProviderRuntimeEvent): void {
    this.emit("canonical", event)
  }

  emitProjected(event: LegacyProviderEvent): void {
    this.emit("projected", event)
  }
}
