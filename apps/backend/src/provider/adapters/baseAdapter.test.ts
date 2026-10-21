import { describe, it, expect, vi } from "vitest"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
} from "../types"
import { BaseProviderAdapter } from "./baseAdapter"
import { providerEventBus } from "../events"
import { awaitApproval } from "../permissions"
import { StalePendingProviderRequestError } from "../runtime/pendingRequestErrors"
import { ProviderAdapterRegistry } from "../registry"

class TestAdapter extends BaseProviderAdapter {
  public emittedEvents: ProviderRuntimeEvent[] = []
  public interruptCalls: string[] = []
  public sessions = new Set<string>()

  providerKind(): ProviderKind {
    return "anthropic"
  }
  displayName(): string {
    return "Test"
  }
  availableModels(): ModelDefinition[] {
    return []
  }
  isConfigured(): boolean {
    return true
  }

  async sendMessage(_input: ProviderSendTurnInput): Promise<void> {
    // unused — the base-class behaviour we test here doesn't need a real send.
  }

  async interrupt(threadId: string): Promise<void> {
    this.interruptCalls.push(threadId)
    this.sessions.delete(threadId)
  }

  protected _activeSessionIds(): string[] {
    return [...this.sessions]
  }

  // Expose the protected emit for direct testing.
  publicEmit(event: ProviderRuntimeEvent): void {
    this.emittedEvents.push(event)
    this.emit(event)
  }
}

describe("BaseProviderAdapter", () => {
  it("attempts every session even if one interruption fails", async () => {
    const adapter = new TestAdapter()
    adapter.sessions = new Set(["first", "second"])
    const failure = new Error("first interruption failed")
    const interrupt = vi
      .spyOn(adapter, "interrupt")
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    await expect(adapter.interruptAll()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure],
    })
    expect(interrupt.mock.calls.map(([id]) => id)).toEqual(["first", "second"])
  })

  it("attempts every registered adapter even if one interruption fails", async () => {
    const first = new TestAdapter()
    const second = new TestAdapter()
    vi.spyOn(second, "providerKind").mockReturnValue("openai")
    const failure = new Error("first adapter failed")
    vi.spyOn(first, "interruptAll").mockRejectedValue(failure)
    const secondInterrupt = vi
      .spyOn(second, "interruptAll")
      .mockResolvedValue(2)
    const registry = new ProviderAdapterRegistry()
    registry.register(first)
    registry.register(second)
    await expect(registry.interruptAll()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure],
    })
    expect(secondInterrupt).toHaveBeenCalledOnce()
  })

  it("subscribeEvents returns the local EventEmitter", () => {
    const adapter = new TestAdapter()
    const emitter1 = adapter.subscribeEvents()
    const emitter2 = adapter.subscribeEvents()
    expect(emitter1).toBe(emitter2)
  })

  it("emit fans out to both the local bus and the global providerEventBus", () => {
    const adapter = new TestAdapter()
    const localSpy = vi.fn()
    const globalSpy = vi.fn()
    adapter.subscribeEvents().on("event", localSpy)
    providerEventBus.on("event", globalSpy)
    try {
      const event: ProviderRuntimeEvent = {
        event_type: "turn_started",
        thread_id: "t-1",
        payload: {},
      }
      adapter.publicEmit(event)
      expect(localSpy).toHaveBeenCalledWith(event)
      expect(globalSpy).toHaveBeenCalledWith(event)
    } finally {
      providerEventBus.off("event", globalSpy)
    }
  })

  it("interruptAll iterates the active session ids and calls interrupt for each", async () => {
    const adapter = new TestAdapter()
    adapter.sessions.add("a")
    adapter.sessions.add("b")
    adapter.sessions.add("c")
    const count = await adapter.interruptAll()
    expect(count).toBe(3)
    expect(adapter.interruptCalls.sort()).toEqual(["a", "b", "c"])
  })

  it("interruptAll returns 0 when no sessions are active", async () => {
    const adapter = new TestAdapter()
    expect(await adapter.interruptAll()).toBe(0)
    expect(adapter.interruptCalls).toEqual([])
  })

  it("respondToApproval rejects unknown requests", async () => {
    const adapter = new TestAdapter()
    await expect(
      adapter.respondToApproval("missing-thread", "missing-req", "approve")
    ).rejects.toBeInstanceOf(StalePendingProviderRequestError)
  })

  it("respondToApproval resolves live requests once and rejects replay", async () => {
    const adapter = new TestAdapter()
    const pending = awaitApproval("live-thread", "live-request")
    await expect(
      adapter.respondToApproval("live-thread", "live-request", "approve")
    ).resolves.toBeUndefined()
    await expect(pending).resolves.toBe("approve")
    await expect(
      adapter.respondToApproval("live-thread", "live-request", "approve")
    ).rejects.toBeInstanceOf(StalePendingProviderRequestError)
  })
})
