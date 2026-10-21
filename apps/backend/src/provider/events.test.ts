import { describe, expect, it } from "vitest"
import { PROVIDER_EVENT_BUS_MAX_LISTENERS, ProviderEventBus } from "./events"

describe("ProviderEventBus", () => {
  it("warns about a leaked subscription instead of allowing any number", () => {
    expect(PROVIDER_EVENT_BUS_MAX_LISTENERS).toBeGreaterThan(0)
    expect(new ProviderEventBus().getMaxListeners()).toBe(
      PROVIDER_EVENT_BUS_MAX_LISTENERS
    )
    expect(new ProviderEventBus(3).getMaxListeners()).toBe(3)
  })

  it("keeps two buses apart", () => {
    const first = new ProviderEventBus()
    const second = new ProviderEventBus()
    const seen: string[] = []
    first.on("event", () => seen.push("first"))
    second.on("event", () => seen.push("second"))

    first.emitEvent({ event_type: "turn_started", thread_id: "t", payload: {} })

    expect(seen).toEqual(["first"])
  })
})
