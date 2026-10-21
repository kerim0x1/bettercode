import { EventEmitter } from "node:events"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "@betterc0de/schema"
import type { ProviderRuntimeEvent } from "./types"

/**
 * Global provider-event bus with three lanes:
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
 */
export class ProviderEventBus extends EventEmitter {
  emitEvent(event: ProviderRuntimeEvent): void {
    this.emit("event", event)
  }

  emitCanonical(event: CanonicalProviderRuntimeEvent): void {
    this.emit("canonical", event)
  }

  emitProjected(event: ProviderRuntimeEvent): void {
    this.emit("projected", event)
  }
}

export const providerEventBus = new ProviderEventBus()
providerEventBus.setMaxListeners(0) // Many subscribers — don't warn.
