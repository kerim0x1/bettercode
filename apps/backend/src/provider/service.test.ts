import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProviderAdapter } from "./adapter"
import { ProviderEventBus } from "./events"
import { awaitApproval, resolveApproval } from "./permissions"
import { ProviderAdapterRegistry } from "./registry"
import { ProviderService, type ProviderServiceOptions } from "./service"
import type {
  ModelDefinition,
  ProviderKind,
  LegacyProviderEvent,
  ProviderSendTurnInput,
} from "./types"
import { ThreadTurnCoordinator } from "./threadTurnCoordinator"

class StubAdapter implements ProviderAdapter {
  private readonly events = new EventEmitter()

  constructor(
    private readonly kind: ProviderKind,
    private readonly ownsLifecycle: boolean,
    private readonly send: (
      input: ProviderSendTurnInput
    ) => Promise<void> = async () => {},
    private readonly stop: (threadId: string) => Promise<void> = async () => {},
    private readonly stopAll: () => Promise<number> = async () => 0
  ) {}

  providerKind(): ProviderKind {
    return this.kind
  }
  displayName(): string {
    return `stub:${this.kind}`
  }
  availableModels(): ModelDefinition[] {
    return []
  }
  isConfigured(): boolean {
    return true
  }
  managesOwnTurnLifecycle(): boolean {
    return this.ownsLifecycle
  }
  async sendMessage(input: ProviderSendTurnInput): Promise<void> {
    await this.send(input)
  }
  async interrupt(threadId: string): Promise<void> {
    await this.stop(threadId)
  }
  async interruptAll(): Promise<number> {
    return await this.stopAll()
  }
  subscribeEvents(): EventEmitter {
    return this.events
  }
}

/** The bus the services under test publish on; tests emit adapter events on it. */
const providerEventBus = new ProviderEventBus()

const INPUT: ProviderSendTurnInput = {
  thread_id: "thread-1",
  message: "hello",
  model_id: "claude-opus-4-7",
  history: [],
}

describe("ProviderService", () => {
  afterEach(() => {
    vi.useRealTimers()
    providerEventBus.removeAllListeners("event")
  })

  it("rejects new dispatches after shutdown admission closes", () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })

    service.beginShutdown()

    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({
        statusCode: 503,
        code: "provider_shutting_down",
      })
    )
  })

  it("awaits the pre-turn durability hook before calling the adapter", async () => {
    let releaseBaseline!: () => void
    const baselinePending = new Promise<void>((resolve) => {
      releaseBaseline = resolve
    })
    const send = vi.fn(async () => {})
    const beforeTurn = vi.fn(() => baselinePending)
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      beforeTurn,
    })
    const dispatchTurnId = "00000000-0000-4000-8000-000000000001"

    const running = service.sendTurn(INPUT, "openai", dispatchTurnId)
    await Promise.resolve()

    expect(beforeTurn).toHaveBeenCalledWith({
      event_type: "turn_started",
      thread_id: "thread-1",
      payload: expect.objectContaining({
        turn_id: dispatchTurnId,
        dispatchTurnId,
        turn_index: 1,
        provider_kind: "openai",
      }),
    })
    expect(send).not.toHaveBeenCalled()

    releaseBaseline()
    await running
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("runs the shared turn lifecycle policy, with individual hooks overriding it", async () => {
    const send = vi.fn(async () => {})
    const policyBeforeTurn = vi.fn(async () => {})
    const policyAfterTurn = vi.fn(async () => {})
    const preDispatchPolicy = vi.fn(() => ({ decision: "allow" as const }))
    const overridingAfterTurn = vi.fn(async () => {})
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send))
    const turnLifecycle = {
      beforeTurn: policyBeforeTurn,
      preDispatchPolicy,
      afterTurn: policyAfterTurn,
    }
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      turnLifecycle,
    })
    const overridden = new ProviderService(registry, {
      eventBus: providerEventBus,
      turnLifecycle,
      afterTurn: overridingAfterTurn,
    })

    const handle = service.dispatchTurnWithHandle(
      { ...INPUT, project_path: process.cwd(), app_mode: "agent" },
      "openai"
    )
    await expect(handle.settled).resolves.toBeUndefined()

    expect(policyBeforeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "turn_started",
        thread_id: INPUT.thread_id,
        payload: expect.objectContaining({ turn_id: handle.turnId }),
      })
    )
    expect(preDispatchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: INPUT.thread_id,
        turnId: handle.turnId,
        projectPath: process.cwd(),
        appMode: "agent",
        providerKind: "openai",
      })
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(policyAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "turn_completed",
        thread_id: INPUT.thread_id,
      })
    )

    const second = overridden.dispatchTurnWithHandle(
      { ...INPUT, thread_id: "thread-2" },
      "openai"
    )
    await expect(second.settled).resolves.toBeUndefined()
    expect(overridingAfterTurn).toHaveBeenCalledTimes(1)
    expect(policyAfterTurn).toHaveBeenCalledTimes(1)
  })

  it("settles a workspace-trust denial normally without entering the legacy adapter", async () => {
    const send = vi.fn(async () => {})
    const preDispatchPolicy = vi.fn(async () => ({
      decision: "deny" as const,
      toolName: "AgentMode",
      reason: "Agent Mode is disabled for this untrusted workspace.",
    }))
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      preDispatchPolicy,
    })
    const events: LegacyProviderEvent[] = []
    providerEventBus.on("event", (event) => events.push(event))

    const handle = service.dispatchTurnWithHandle(
      {
        ...INPUT,
        project_path: process.cwd(),
        app_mode: "agent",
      },
      "openai"
    )

    await expect(handle.completion).resolves.toBeUndefined()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(preDispatchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: INPUT.thread_id,
        projectPath: process.cwd(),
        appMode: "agent",
        providerKind: "openai",
      })
    )
    expect(
      events
        .filter((event) =>
          ["tool.denied", "turn_completed", "turn_error"].includes(
            event.event_type
          )
        )
        .map((event) => event.event_type)
    ).toEqual(["tool.denied", "turn_completed"])
  })

  it("rolls back a reserved synthetic turn index when beforeTurn rejects", async () => {
    const observedIndices: number[] = []
    const beforeTurn = vi
      .fn<
        (
          event: Parameters<
            NonNullable<ProviderServiceOptions["beforeTurn"]>
          >[0]
        ) => Promise<void>
      >()
      .mockImplementationOnce(async (event) => {
        observedIndices.push(event.payload?.turn_index as number)
        throw new Error("baseline failed")
      })
      .mockImplementationOnce(async (event) => {
        observedIndices.push(event.payload?.turn_index as number)
      })
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      beforeTurn,
    })

    await expect(service.sendTurn(INPUT, "openai")).rejects.toThrow(
      "baseline failed"
    )
    await expect(service.sendTurn(INPUT, "openai")).resolves.toBeUndefined()

    expect(observedIndices).toEqual([1, 1])
  })

  it("prevents a legacy adapter send when interrupted during beforeTurn", async () => {
    let releaseBaseline!: () => void
    const baselinePending = new Promise<void>((resolve) => {
      releaseBaseline = resolve
    })
    const beforeTurn = vi.fn(() => baselinePending)
    const send = vi.fn(async () => {})
    const interrupt = vi.fn(async () => {})
    const coordinator = new ThreadTurnCoordinator()
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, interrupt))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      beforeTurn,
      threadTurnCoordinator: coordinator,
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce())
    const interrupted = service.interrupt("openai", INPUT.thread_id)

    releaseBaseline()
    await expect(handle.completion).rejects.toMatchObject({
      name: "ProviderTurnDispatchCancelledError",
    })
    await expect(interrupted).resolves.toBeUndefined()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(coordinator.activeOwner(INPUT.thread_id)).toBeNull()
  })

  it("publishes a synthetic terminal event before awaiting the afterTurn barrier", async () => {
    let releaseAfterTurn!: () => void
    const afterTurnPending = new Promise<void>((resolve) => {
      releaseAfterTurn = resolve
    })
    const afterTurn = vi.fn(() => afterTurnPending)
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      afterTurn,
    })
    const emitted: string[] = []
    providerEventBus.on("event", (event) => {
      emitted.push(event.event_type)
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    let settled = false
    void handle.settled.then(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(afterTurn).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: "turn_completed" })
      )
    })

    expect(emitted).toContain("turn_completed")
    expect(settled).toBe(false)
    releaseAfterTurn()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(emitted).toContain("turn_completed")
  })

  it("publishes a synthetic error event before awaiting the afterTurn barrier", async () => {
    let releaseAfterTurn!: () => void
    const afterTurnPending = new Promise<void>((resolve) => {
      releaseAfterTurn = resolve
    })
    const afterTurn = vi.fn(() => afterTurnPending)
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter("openai", false, async () => {
        throw new Error("adapter failed")
      })
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      afterTurn,
    })
    const emitted: Array<{ event_type: string; payload?: unknown }> = []
    providerEventBus.on("event", (event) => {
      emitted.push(event)
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    const rejection = expect(handle.settled).rejects.toThrow("adapter failed")
    await vi.waitFor(() => {
      expect(afterTurn).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: "turn_error" })
      )
    })

    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "turn_error",
          payload: expect.objectContaining({ error: "Provider turn failed." }),
        }),
      ])
    )
    expect(JSON.stringify(emitted)).not.toContain("adapter failed")
    releaseAfterTurn()
    await rejection
    expect(emitted.some((event) => event.event_type === "turn_error")).toBe(
      true
    )
  })

  it("retains a published terminal event when afterTurn fails", async () => {
    const afterTurn = vi.fn(async () => {
      throw new Error("afterTurn failed")
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      afterTurn,
    })
    const emitted: string[] = []
    providerEventBus.on("event", (event) => {
      emitted.push(event.event_type)
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    const rejection = expect(handle.settled).rejects.toThrow("afterTurn failed")

    await rejection
    expect(emitted).toContain("turn_completed")
  })

  it("awaits afterTurn before an explicit interrupt settles or releases admission", async () => {
    let releaseAfterTurn!: () => void
    const afterTurnPending = new Promise<void>((resolve) => {
      releaseAfterTurn = resolve
    })
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const afterTurn = vi.fn(async (event: LegacyProviderEvent) => {
      expect(emitted).toContain(event.event_type)
      await afterTurnPending
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter(
        "openai",
        false,
        () => sendPending,
        async () => {}
      )
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      afterTurn,
    })
    const emitted: string[] = []
    providerEventBus.on("event", (event) => {
      emitted.push(event.event_type)
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    let interruptSettled = false
    const interrupted = service
      .interrupt("openai", INPUT.thread_id)
      .then(() => {
        interruptSettled = true
      })
    await Promise.resolve()
    expect(interruptSettled).toBe(false)
    expect(() =>
      service.assertCanDispatch(INPUT.thread_id, "openai")
    ).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    finishSend()
    await vi.waitFor(() => {
      expect(afterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "turn_interrupted",
          payload: expect.objectContaining({
            turn_id: handle.turnId,
            dispatchTurnId: handle.turnId,
          }),
        })
      )
    })

    expect(interruptSettled).toBe(false)
    expect(emitted).toContain("turn_interrupted")
    expect(() =>
      service.assertCanDispatch(INPUT.thread_id, "openai")
    ).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    releaseAfterTurn()
    await interrupted
    await expect(handle.settled).resolves.toBeUndefined()
    expect(emitted).toContain("turn_interrupted")
    expect(() =>
      service.assertCanDispatch(INPUT.thread_id, "openai")
    ).not.toThrow()
  })

  it("keeps shutdown fenced until the interrupted adapter promise quiesces", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, async () => {}))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      shutdownTimeoutMs: 1_000,
    })
    service.dispatchTurn(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())

    const shutdown = service.interruptAll()
    let settled = false
    void shutdown.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finishSend()
    await expect(shutdown).resolves.toBeGreaterThanOrEqual(1)
  })

  it("reports registry interruption failure after active turns are finalized", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, async () => {}))
    vi.spyOn(registry, "interruptAll").mockImplementation(() => {
      throw new Error("registry interruption failed")
    })
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      shutdownTimeoutMs: 1_000,
    })
    service.dispatchTurn(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())

    const shutdown = expect(service.interruptAll()).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        message: "One or more legacy provider shutdown operations failed",
      })
    )
    finishSend()
    await shutdown
  })

  it("bounds shutdown when an interrupted adapter never settles", async () => {
    vi.useFakeTimers()
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter("openai", false, send, () => new Promise<void>(() => {}))
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      shutdownTimeoutMs: 25,
      turnTimeoutMs: 1_000,
    })
    service.dispatchTurn(INPUT, "openai")
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    const shutdown = service.interruptAll()
    const rejection = expect(shutdown).rejects.toMatchObject({
      name: "ProviderShutdownTimeoutError",
      timeoutMs: 25,
    })

    await vi.advanceTimersByTimeAsync(25)

    await rejection
    finishSend()
    await Promise.resolve()
    await Promise.resolve()
  })

  it("bounds explicit interrupt while retaining the fence until dispatch quiesces", async () => {
    vi.useFakeTimers()
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const coordinator = new ThreadTurnCoordinator()
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter(
        "openai",
        false,
        () => sendPending,
        async () => {}
      )
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      shutdownTimeoutMs: 25,
      threadTurnCoordinator: coordinator,
    })
    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    await Promise.resolve()
    await Promise.resolve()

    const interruption = expect(
      service.interrupt("openai", INPUT.thread_id)
    ).rejects.toMatchObject({
      name: "ProviderInterruptTimeoutError",
      timeoutMs: 25,
    })
    await vi.advanceTimersByTimeAsync(25)
    await interruption

    expect(coordinator.activeOwner(INPUT.thread_id)).toBe("legacy:openai")
    expect(() =>
      service.assertCanDispatch("another-thread", "openai")
    ).toThrowError(
      expect.objectContaining({
        statusCode: 503,
        code: "provider_backend_quarantined",
        message: "Provider backend is temporarily unavailable.",
      })
    )

    finishSend()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(coordinator.activeOwner(INPUT.thread_id)).toBeNull()
  })

  it("uses a successful hard stop after targeted interruption fails without quarantining the adapter", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const targetedInterrupt = vi.fn(async () => {
      throw new Error("targeted interrupt failed")
    })
    const hardStop = vi.fn(async () => 1)
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter(
        "openai",
        false,
        () => sendPending,
        targetedInterrupt,
        hardStop
      )
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      shutdownTimeoutMs: 1_000,
    })
    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    await Promise.resolve()
    await Promise.resolve()

    const interruption = expect(
      service.interrupt("openai", INPUT.thread_id)
    ).rejects.toThrow("targeted interrupt failed")
    await vi.waitFor(() => expect(hardStop).toHaveBeenCalledOnce())
    expect(targetedInterrupt).toHaveBeenCalledWith(INPUT.thread_id)

    finishSend()
    await interruption
    await expect(handle.settled).rejects.toThrow("targeted interrupt failed")
    expect(() =>
      service.assertCanDispatch("another-thread", "openai")
    ).not.toThrow()
  })

  it("emits synthetic turn lifecycle for request-scoped adapters", async () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })
    const events: string[] = []
    providerEventBus.on("event", (event) => {
      events.push((event as { event_type: string }).event_type)
    })

    await service.sendTurn(INPUT, "openai")

    expect(events).toEqual(["turn_started", "turn_completed"])
  })

  it("continues synthetic turn indices from durable history after restart", async () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const durableTurnCount = vi.fn(() => 4)
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      durableTurnCount,
    })
    const indices: number[] = []
    providerEventBus.on("event", (event) => {
      const typed = event as {
        event_type: string
        payload?: { turn_index?: number }
      }
      if (typed.event_type === "turn_started" && typed.payload?.turn_index) {
        indices.push(typed.payload.turn_index)
      }
    })

    await service.sendTurn(INPUT, "openai")
    await service.sendTurn(INPUT, "openai")

    expect(indices).toEqual([5, 6])
    expect(durableTurnCount).toHaveBeenCalledWith("thread-1")
  })

  it("interrupts and forgets all ephemeral state for one thread", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const interrupt = vi.fn(async () => {})
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, interrupt))
    const durableTurnCount = vi.fn(() => 0)
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      durableTurnCount,
    })

    service.dispatchTurn(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const interrupted = service.interruptThread(INPUT.thread_id)
    await vi.waitFor(() =>
      expect(interrupt).toHaveBeenCalledWith(INPUT.thread_id)
    )
    expect(interrupt).toHaveBeenCalledWith(INPUT.thread_id)

    finishSend()
    await expect(interrupted).resolves.toBe(true)
    service.forgetThread(INPUT.thread_id)
    await service.sendTurn(INPUT, "openai")
    expect(durableTurnCount).toHaveBeenLastCalledWith(INPUT.thread_id)
  })

  it("tears down an active legacy turn under an exclusive thread barrier", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const interrupt = vi.fn(async () => {})
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, interrupt))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })

    service.dispatchTurn(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const teardown = service.withThreadTeardown(INPUT.thread_id, async () => {
      expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "turn_active" })
      )
    })
    await vi.waitFor(() =>
      expect(interrupt).toHaveBeenCalledWith(INPUT.thread_id)
    )
    finishSend()
    await teardown
    expect(() => service.dispatchTurn(INPUT, "openai")).not.toThrow()
  })

  it("does not emit premature lifecycle events for self-managed adapters", async () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("anthropic_cli", true))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })
    const events: string[] = []
    providerEventBus.on("event", (event) => {
      events.push((event as { event_type: string }).event_type)
    })

    await service.sendTurn(INPUT, "anthropic_cli")

    expect(events).toEqual([])
  })

  it("admits exactly one dispatched turn per thread until completion", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, () => pending))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })

    const turnId = service.dispatchTurn(INPUT, "openai")
    expect(turnId).toEqual(expect.any(String))
    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    release()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(() => service.dispatchTurn(INPUT, "openai")).not.toThrow()
  })

  it("rejects legacy dispatch while another provider stack owns the thread", () => {
    const coordinator = new ThreadTurnCoordinator()
    coordinator.reserveTurn(INPUT.thread_id, "hub:codex")
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      threadTurnCoordinator: coordinator,
    })

    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )
  })

  it("accepts and releases a turn token reserved by the HTTP admission boundary", async () => {
    const coordinator = new ThreadTurnCoordinator()
    const sharedToken = coordinator.reserveTurn(
      INPUT.thread_id,
      "http:legacy:openai"
    )
    expect(sharedToken).not.toBeNull()
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      threadTurnCoordinator: coordinator,
    })

    expect(() =>
      service.dispatchTurn(INPUT, "openai", { sharedToken: sharedToken! })
    ).not.toThrow()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(coordinator.activeOwner(INPUT.thread_id)).toBeNull()
  })

  it("claims natural completion before listeners can request an interrupt", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, () => pending))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })
    const terminalEvents: string[] = []
    let interruptAfterCompletion: Promise<void> | undefined
    providerEventBus.on("event", (event) => {
      const type = (event as { event_type: string }).event_type
      if (!["turn_completed", "turn_interrupted", "turn_error"].includes(type))
        return
      terminalEvents.push(type)
      if (type === "turn_completed") {
        interruptAfterCompletion = service.interrupt("openai", INPUT.thread_id)
      }
    })

    service.dispatchTurn(INPUT, "openai")
    release()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await interruptAfterCompletion

    expect(terminalEvents).toEqual(["turn_completed"])
  })

  it("coordinates legacy turn admission with thread maintenance", async () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })

    await service.withThreadMaintenance(INPUT.thread_id, async () => {
      expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
        expect.objectContaining({ statusCode: 409, code: "turn_active" })
      )
    })

    let release!: () => void
    const pendingRegistry = new ProviderAdapterRegistry()
    pendingRegistry.register(
      new StubAdapter(
        "openai",
        false,
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
    )
    const busyService = new ProviderService(pendingRegistry, {
      eventBus: providerEventBus,
    })
    busyService.dispatchTurn(INPUT, "openai")
    await expect(
      busyService.withThreadMaintenance(INPUT.thread_id, async () => undefined)
    ).rejects.toMatchObject({ statusCode: 409, code: "turn_active" })
    release()
  })

  it("keeps admission closed until a requested interrupt has actually completed", async () => {
    let finishSend!: () => void
    let finishInterrupt!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const interruptPending = new Promise<void>((resolve) => {
      finishInterrupt = resolve
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter("openai", false, send, () => interruptPending)
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })
    const terminalEvents: string[] = []
    providerEventBus.on("event", (event) => {
      const type = (event as { event_type: string }).event_type
      if (["turn_completed", "turn_interrupted", "turn_error"].includes(type)) {
        terminalEvents.push(type)
      }
    })

    service.dispatchTurn(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const interrupted = service.interrupt("openai", INPUT.thread_id)
    finishSend()
    await Promise.resolve()
    await Promise.resolve()

    expect(terminalEvents).toEqual([])
    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    finishInterrupt()
    await interrupted
    expect(terminalEvents).toEqual(["turn_interrupted"])
    expect(() => service.dispatchTurn(INPUT, "openai")).not.toThrow()
  })

  it("retains admission after interrupt acknowledgement until legacy dispatch quiesces", async () => {
    let finishSend!: () => void
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const send = vi.fn(() => sendPending)
    const interrupt = vi.fn(async () => {})
    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false, send, interrupt))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    let interruptionSettled = false
    const interrupted = service
      .interrupt("openai", INPUT.thread_id)
      .then(() => {
        interruptionSettled = true
      })
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce())
    await Promise.resolve()

    expect(interruptionSettled).toBe(false)
    expect(() =>
      service.assertCanDispatch(INPUT.thread_id, "openai")
    ).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    finishSend()
    await interrupted
    await expect(handle.settled).resolves.toBeUndefined()
    expect(() =>
      service.assertCanDispatch(INPUT.thread_id, "openai")
    ).not.toThrow()
  })

  it("emits one timeout terminal and retains admission until timeout interruption completes", async () => {
    vi.useFakeTimers()
    let finishInterrupt!: () => void
    let finishSend!: () => void
    const interruptPending = new Promise<void>((resolve) => {
      finishInterrupt = resolve
    })
    const sendPending = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const registry = new ProviderAdapterRegistry()
    registry.register(
      new StubAdapter(
        "openai",
        false,
        () => sendPending,
        () => interruptPending
      )
    )
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
      turnTimeoutMs: 25,
    })
    const terminalEvents: Array<{ type: string; status?: unknown }> = []
    providerEventBus.on("event", (event) => {
      const typed = event as {
        event_type: string
        payload?: { status?: unknown }
      }
      if (
        ["turn_completed", "turn_interrupted", "turn_error"].includes(
          typed.event_type
        )
      ) {
        terminalEvents.push({
          type: typed.event_type,
          status: typed.payload?.status,
        })
      }
    })

    const handle = service.dispatchTurnWithHandle(INPUT, "openai")
    await vi.advanceTimersByTimeAsync(25)

    expect(terminalEvents).toEqual([])
    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    finishInterrupt()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(terminalEvents).toEqual([])
    expect(() => service.dispatchTurn(INPUT, "openai")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )

    finishSend()
    await expect(handle.settled).rejects.toMatchObject({
      name: "ProviderTurnTimeoutError",
    })
    expect(terminalEvents).toEqual([
      { type: "turn_error", status: "timed_out" },
    ])
    expect(() => service.dispatchTurn(INPUT, "openai")).not.toThrow()
  })

  describe("turn limits", () => {
    function recordTerminalEvents(): Array<{ type: string; status?: unknown }> {
      const terminalEvents: Array<{ type: string; status?: unknown }> = []
      providerEventBus.on("event", (event) => {
        const typed = event as {
          event_type: string
          payload?: { status?: unknown }
        }
        if (
          ["turn_completed", "turn_interrupted", "turn_error"].includes(
            typed.event_type
          )
        ) {
          terminalEvents.push({
            type: typed.event_type,
            status: typed.payload?.status,
          })
        }
      })
      return terminalEvents
    }

    function hangingAdapter(): StubAdapter {
      let finishSend!: () => void
      const sendPending = new Promise<void>((resolve) => {
        finishSend = resolve
      })
      return new StubAdapter(
        "openai",
        false,
        () => sendPending,
        async () => {
          finishSend()
        }
      )
    }

    function streamDelta(): void {
      providerEventBus.emitEvent({
        event_type: "content_delta",
        thread_id: INPUT.thread_id,
        payload: { delta: "." },
      })
    }

    it("keeps a streaming turn alive past the inactivity limit and times it out once it goes quiet", async () => {
      vi.useFakeTimers()
      const registry = new ProviderAdapterRegistry()
      registry.register(hangingAdapter())
      const service = new ProviderService(registry, {
        eventBus: providerEventBus,
        turnTimeoutMs: 100,
      })
      const terminalEvents = recordTerminalEvents()

      const handle = service.dispatchTurnWithHandle(INPUT, "openai")
      for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50)
        streamDelta()
      }
      expect(terminalEvents).toEqual([])

      await vi.advanceTimersByTimeAsync(100)
      await expect(handle.settled).rejects.toMatchObject({
        name: "ProviderTurnTimeoutError",
        kind: "idle",
        timeoutMs: 100,
      })
      expect(terminalEvents).toEqual([
        { type: "turn_error", status: "timed_out" },
      ])
    })

    it("pauses the inactivity limit while a tool approval waits for the user", async () => {
      vi.useFakeTimers()
      let decision: string | undefined
      const registry = new ProviderAdapterRegistry()
      registry.register(
        new StubAdapter("openai", false, async () => {
          providerEventBus.emitEvent({
            event_type: "tool_approval_requested",
            thread_id: INPUT.thread_id,
            payload: { requestId: "approval-1", tool: "Bash" },
          })
          decision = await awaitApproval(INPUT.thread_id, "approval-1")
        })
      )
      const service = new ProviderService(registry, {
        eventBus: providerEventBus,
        turnTimeoutMs: 1_000,
      })
      const terminalEvents = recordTerminalEvents()

      const handle = service.dispatchTurnWithHandle(INPUT, "openai")
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(terminalEvents).toEqual([])

      expect(resolveApproval(INPUT.thread_id, "approval-1", "approve")).toBe(
        true
      )
      await expect(handle.completion).resolves.toBeUndefined()
      expect(decision).toBe("approve")
      expect(terminalEvents).toEqual([
        { type: "turn_completed", status: undefined },
      ])
    })

    it("ends a turn at the absolute ceiling even while it keeps streaming", async () => {
      vi.useFakeTimers()
      const registry = new ProviderAdapterRegistry()
      registry.register(hangingAdapter())
      const service = new ProviderService(registry, {
        eventBus: providerEventBus,
        turnTimeoutMs: 100,
        turnMaxDurationMs: 300,
      })
      const terminalEvents = recordTerminalEvents()

      const handle = service.dispatchTurnWithHandle(INPUT, "openai")
      const rejection = expect(handle.settled).rejects.toMatchObject({
        name: "ProviderTurnTimeoutError",
        kind: "max-duration",
        timeoutMs: 300,
      })
      for (let elapsed = 0; elapsed < 400; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50)
        streamDelta()
      }
      await rejection
      expect(terminalEvents).toEqual([
        { type: "turn_error", status: "timed_out" },
      ])
    })
  })

  it("returns typed failures for missing providers and unsupported response capabilities", async () => {
    const emptyService = new ProviderService(new ProviderAdapterRegistry(), {
      eventBus: providerEventBus,
    })
    await expect(
      emptyService.interrupt("openai", "thread-1")
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "provider_not_found",
    })
    await expect(
      emptyService.respondToApproval("openai", "thread-1", "request-1", "deny")
    ).rejects.toMatchObject({ statusCode: 404, code: "provider_not_found" })

    const registry = new ProviderAdapterRegistry()
    registry.register(new StubAdapter("openai", false))
    const service = new ProviderService(registry, {
      eventBus: providerEventBus,
    })
    await expect(
      service.respondToApproval("openai", "thread-1", "request-1", "deny")
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "provider_capability_unsupported",
    })
  })
})
