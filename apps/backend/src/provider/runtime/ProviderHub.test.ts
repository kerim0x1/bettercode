import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ApprovalRequestId,
  ProviderAdapterShape,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSkill,
  ThreadId,
} from "./contracts"
import {
  backendMetrics,
  PROVIDER_RUNTIME_EVENTS_TOTAL,
  PROVIDER_TURN_DURATION_MS,
  PROVIDER_TURNS_TOTAL,
} from "../../observability/metrics"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import {
  ProviderBackendQuarantinedError,
  ProviderHub,
  ProviderMetadataCapacityError,
  ProviderMetadataInputError,
  ProviderSessionCapacityError,
  ProviderSessionInspectionError,
  ProviderStaleSessionCleanupError,
  ProviderTurnCapacityError,
  ProviderTurnConflictError,
} from "./ProviderHub"
import { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"
import { ThreadTurnCoordinator } from "../threadTurnCoordinator"

const createdDirs = new Set<string>()

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-hub-cache-"))
  createdDirs.add(dir)
  return dir
}

function insertProviderHubTestThread(
  db: ReturnType<typeof openDatabase>,
  threadId: string
): void {
  db.prepare(
    `
    INSERT INTO projection_threads
      (thread_id, project_id, title, status, env_mode, created_at, updated_at)
    VALUES (?, 'project-1', NULL, 'active', 'local', '2026-01-01', '2026-01-01')
  `
  ).run(threadId)
}

function makeAdapter(
  configured = true,
  options: {
    readonly stopAll?: () => Promise<void>
    readonly startSession?: ProviderAdapterShape["startSession"]
    readonly sendTurn?: ProviderAdapterShape["sendTurn"]
    readonly interruptTurn?: ProviderAdapterShape["interruptTurn"]
    readonly respondToRequest?: ProviderAdapterShape["respondToRequest"]
    readonly availableModels?: ProviderAdapterShape["availableModels"]
    readonly availableSkills?: ProviderAdapterShape["availableSkills"]
    readonly availableSlashCommands?: ProviderAdapterShape["availableSlashCommands"]
    readonly availableAgents?: ProviderAdapterShape["availableAgents"]
    readonly availableTools?: ProviderAdapterShape["availableTools"]
    readonly availableProviderCatalog?: ProviderAdapterShape["availableProviderCatalog"]
    readonly invalidateMetadata?: ProviderAdapterShape["invalidateMetadata"]
    readonly listSessions?: ProviderAdapterShape["listSessions"]
    readonly rollbackThread?: ProviderAdapterShape["rollbackThread"]
    readonly hasSession?: ProviderAdapterShape["hasSession"]
    readonly needsSessionConfigurationRefresh?: ProviderAdapterShape["needsSessionConfigurationRefresh"]
    readonly stopSession?: ProviderAdapterShape["stopSession"]
    readonly onSubscribe?: (emit: (event: ProviderRuntimeEvent) => void) => void
  } = {}
): ProviderAdapterShape {
  const listeners = new Set<(event: ProviderRuntimeEvent) => void>()
  const dispatchTurnIds = new Map<string, string>()
  const managedSessions = new Map<string, ProviderSession>()
  const emit = (rawEvent: ProviderRuntimeEvent) => {
    const dispatchTurnId = dispatchTurnIds.get(rawEvent.threadId)
    const shouldCorrelate =
      Boolean(dispatchTurnId) &&
      rawEvent.type !== "session.exited" &&
      (rawEvent.type === "turn.started" ||
        rawEvent.type === "turn.completed" ||
        rawEvent.type === "turn.aborted")
    const rawPayload = (
      rawEvent as unknown as { readonly payload?: Record<string, unknown> }
    ).payload
    const event = shouldCorrelate
      ? ({
          ...rawEvent,
          payload: {
            ...(rawPayload ?? {}),
            ...(typeof rawPayload?.dispatchTurnId === "string"
              ? {}
              : { dispatchTurnId }),
          },
        } as ProviderRuntimeEvent)
      : rawEvent
    for (const listener of listeners) listener(event)
    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.exited"
    ) {
      dispatchTurnIds.delete(event.threadId)
    }
    if (event.type === "session.exited") {
      managedSessions.delete(event.threadId)
    }
  }
  return {
    provider: "codex",
    displayName: "Codex",
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsApprovals: true,
      supportsResume: true,
      managesOwnLifecycle: true,
    },
    isConfigured: () => configured,
    needsSessionConfigurationRefresh: options.needsSessionConfigurationRefresh,
    availableModels: options.availableModels ?? (async () => []),
    ...(options.availableSkills
      ? { availableSkills: options.availableSkills }
      : {}),
    ...(options.availableSlashCommands
      ? { availableSlashCommands: options.availableSlashCommands }
      : {}),
    ...(options.availableAgents
      ? { availableAgents: options.availableAgents }
      : {}),
    ...(options.availableTools
      ? { availableTools: options.availableTools }
      : {}),
    ...(options.availableProviderCatalog
      ? { availableProviderCatalog: options.availableProviderCatalog }
      : {}),
    ...(options.invalidateMetadata
      ? { invalidateMetadata: options.invalidateMetadata }
      : {}),
    startSession: async (input) => {
      const session = await (
        options.startSession ??
        (async () => ({
          threadId: input.threadId,
          providerThreadId: null,
          status: "ready" as const,
          cwd: input.cwd ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }))
      )(input)
      managedSessions.set(input.threadId, session)
      return session
    },
    listSessions: async () => {
      const merged = new Map<string, ProviderSession>()
      for (const session of (await options.listSessions?.()) ?? []) {
        merged.set(session.threadId, session)
      }
      for (const session of managedSessions.values()) {
        merged.set(session.threadId, session)
      }
      return [...merged.values()]
    },
    sendTurn: async (input: ProviderSendTurnInput) => {
      if (input.dispatchTurnId) {
        dispatchTurnIds.set(input.threadId, input.dispatchTurnId)
      }
      await (options.sendTurn ?? (async () => {}))(input)
    },
    interruptTurn: options.interruptTurn ?? (async (_threadId: ThreadId) => {}),
    respondToRequest:
      options.respondToRequest ??
      (async (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision
      ) => {}),
    ...(options.rollbackThread
      ? { rollbackThread: options.rollbackThread }
      : {}),
    stopSession: async (threadId: ThreadId) => {
      await (options.stopSession ?? (async () => {}))(threadId)
      managedSessions.delete(threadId)
    },
    hasSession: (threadId: ThreadId) =>
      managedSessions.has(threadId) ||
      (options.hasSession?.(threadId) ?? false),
    subscribe: (listener) => {
      listeners.add(listener)
      options.onSubscribe?.(emit)
      return () => listeners.delete(listener)
    },
    stopAll: async () => {
      await (options.stopAll ?? (async () => {}))()
      managedSessions.clear()
    },
  }
}

describe("ProviderHub", () => {
  beforeEach(() => {
    backendMetrics.reset()
  })

  afterEach(() => {
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    createdDirs.clear()
  })

  it("records local admission before dispatch and correlates provider turn starts", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const accepted = vi.fn()
    const forwarded: ProviderRuntimeEvent[] = []
    const sendTurn = vi.fn(async () => {
      emitRuntimeEvent({
        type: "turn.started",
        threadId: "thread-admission",
        turnId: "provider-turn-1",
        eventId: "turn-started-1",
        at: 1,
      })
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn,
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => forwarded.push(event))

    const handle = hub.startTurn(
      "codex",
      {
        threadId: "thread-admission",
        message: "implement",
        modelId: "gpt-5.5",
        history: [],
      },
      { onAccepted: accepted }
    )
    await handle.completion

    expect(accepted).toHaveBeenCalledWith(handle.turnId, "codex")
    expect(accepted.mock.invocationCallOrder[0]).toBeLessThan(
      sendTurn.mock.invocationCallOrder[0] ?? 0
    )
    expect(forwarded).toContainEqual(
      expect.objectContaining({
        type: "turn.started",
        turnId: "provider-turn-1",
        payload: expect.objectContaining({ dispatchTurnId: handle.turnId }),
      })
    )
  })

  it("awaits the pre-turn durability hook before native adapter dispatch", async () => {
    let releaseBaseline!: () => void
    const baselinePending = new Promise<void>((resolve) => {
      releaseBaseline = resolve
    })
    const beforeTurn = vi.fn(() => baselinePending)
    const sendTurn = vi.fn(async () => {})
    const hub = new ProviderHub({
      beforeTurn,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })

    const handle = hub.startTurn("codex", {
      threadId: "thread-durable-baseline",
      message: "implement",
      modelId: "gpt-5.5",
      history: [],
      projectPath: "/repo",
    })
    await vi.waitFor(() => {
      expect(beforeTurn).toHaveBeenCalledWith({
        threadId: "thread-durable-baseline",
        turnId: handle.turnId,
        projectPath: "/repo",
        providerKind: "codex",
        providerInstanceId: "codex",
      })
    })
    expect(sendTurn).not.toHaveBeenCalled()

    releaseBaseline()
    await handle.completion
    expect(sendTurn).toHaveBeenCalledTimes(1)
  })

  it("prevents a native adapter send when interrupted during beforeTurn", async () => {
    let releaseBaseline!: () => void
    const baselinePending = new Promise<void>((resolve) => {
      releaseBaseline = resolve
    })
    const beforeTurn = vi.fn(() => baselinePending)
    const sendTurn = vi.fn(async () => {})
    const interruptTurn = vi.fn(async () => {})
    const coordinator = new ThreadTurnCoordinator()
    const hub = new ProviderHub({
      beforeTurn,
      threadTurnCoordinator: coordinator,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn, interruptTurn }),
        },
      ],
    })

    const handle = hub.startTurn("codex", {
      threadId: "thread-cancel-before-send",
      message: "implement",
      modelId: "gpt-5.5",
      history: [],
    })
    await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce())
    const interrupted = hub.interruptTurn(
      "codex",
      "thread-cancel-before-send" as ThreadId
    )

    releaseBaseline()
    await expect(handle.completion).rejects.toMatchObject({
      name: "ProviderTurnDispatchCancelledError",
    })
    await expect(interrupted).resolves.toBeUndefined()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(sendTurn).not.toHaveBeenCalled()
    expect(interruptTurn).not.toHaveBeenCalled()
    expect(coordinator.activeOwner("thread-cancel-before-send")).toBeNull()
  })

  it("keeps native settlement and admission open through terminal afterTurn", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    let releaseAfterTurn!: () => void
    const afterTurnPending = new Promise<void>((resolve) => {
      releaseAfterTurn = resolve
    })
    const forwarded: ProviderRuntimeEvent[] = []
    const afterTurn = vi.fn(async (event: ProviderRuntimeEvent) => {
      expect(forwarded).toContain(event)
      await afterTurnPending
    })
    const coordinator = new ThreadTurnCoordinator()
    const hub = new ProviderHub({
      afterTurn,
      threadTurnCoordinator: coordinator,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: vi.fn(async () => {}),
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => forwarded.push(event))

    const handle = hub.startTurn("codex", {
      threadId: "thread-native-settlement",
      message: "implement",
      modelId: "gpt-5.5",
      history: [],
    })
    await handle.completion
    let settled = false
    void handle.settled.then(() => {
      settled = true
    })

    expect(settled).toBe(false)
    expect(coordinator.activeOwner("thread-native-settlement")).toBe(
      "hub:codex"
    )

    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-native-settlement",
      turnId: "provider-turn-native-settlement",
      eventId: "turn-started-native-settlement",
      at: 1,
    })
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-native-settlement",
      turnId: "provider-turn-native-settlement",
      eventId: "turn-completed-native-settlement",
      at: 2,
    })
    await vi.waitFor(() => expect(afterTurn).toHaveBeenCalledOnce())

    expect(settled).toBe(false)
    expect(coordinator.activeOwner("thread-native-settlement")).toBe(
      "hub:codex"
    )
    releaseAfterTurn()
    await expect(handle.settled).resolves.toBeUndefined()
    expect(coordinator.activeOwner("thread-native-settlement")).toBeNull()
  })

  it("settles a native turn exactly once when its correlated session exits", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const afterTurn = vi.fn(async () => {})
    const hub = new ProviderHub({
      afterTurn,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: vi.fn(async () => {}),
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })

    const handle = hub.startTurn("codex", {
      threadId: "thread-session-exited-settlement",
      message: "implement",
      modelId: "gpt-5.5",
      history: [],
    })
    await handle.completion
    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-session-exited-settlement",
      turnId: "provider-turn-session-exited",
      eventId: "turn-started-session-exited",
      at: 1,
    })
    emitRuntimeEvent({
      type: "session.exited",
      threadId: "thread-session-exited-settlement",
      turnId: "provider-turn-session-exited",
      eventId: "session-exited-terminal",
      at: 2,
    })

    await expect(handle.settled).resolves.toBeUndefined()
    expect(afterTurn).toHaveBeenCalledOnce()
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.exited",
        payload: expect.objectContaining({
          dispatchTurnId: handle.turnId,
        }),
      })
    )

    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-session-exited-settlement",
      turnId: "provider-turn-session-exited",
      eventId: "late-turn-completed-after-session-exit",
      at: 3,
    })
    expect(afterTurn).toHaveBeenCalledOnce()
  })

  it("pins active turns to their adapter generation until settlement", async () => {
    let emitOld!: (event: ProviderRuntimeEvent) => void
    let emitNew!: (event: ProviderRuntimeEvent) => void
    const oldInterrupt = vi.fn(async () => {
      emitOld({
        type: "turn.aborted",
        threadId: "thread-generation",
        turnId: "old-provider-turn",
        eventId: "old-turn-aborted",
        at: 2,
        payload: { reason: "provider.interruptTurnForInstance" },
      })
    })
    const newInterrupt = vi.fn(async () => {})
    const oldAdapter = makeAdapter(true, {
      sendTurn: vi.fn(async () => {
        emitOld({
          type: "turn.started",
          threadId: "thread-generation",
          turnId: "old-provider-turn",
          eventId: "old-turn-started",
          at: 1,
        })
      }),
      interruptTurn: oldInterrupt,
      onSubscribe: (emit) => {
        emitOld = emit
      },
    })
    const newSendTurn = vi.fn(async () => {
      emitNew({
        type: "turn.started",
        threadId: "thread-after-generation",
        turnId: "new-provider-turn",
        eventId: "new-turn-started",
        at: 3,
      })
      emitNew({
        type: "turn.completed",
        threadId: "thread-after-generation",
        turnId: "new-provider-turn",
        eventId: "new-turn-completed",
        at: 4,
      })
    })
    const newAdapter = makeAdapter(true, {
      sendTurn: newSendTurn,
      interruptTurn: newInterrupt,
      onSubscribe: (emit) => {
        emitNew = emit
      },
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: oldAdapter,
        },
      ],
    })

    const active = hub.startTurn("codex", {
      threadId: "thread-generation",
      message: "first",
      modelId: "gpt-live",
      history: [],
    })
    await active.completion
    hub.replaceInstances([
      {
        instanceId: "codex",
        driver: "codex",
        provider: "codex",
        enabled: true,
        adapter: newAdapter,
      },
    ])

    await hub.interruptTurnForInstance(
      "codex",
      "thread-generation" as ThreadId,
      "codex"
    )
    await expect(active.settled).resolves.toBeUndefined()
    expect(oldInterrupt).toHaveBeenCalledWith(
      "thread-generation",
      expect.objectContaining({ interruptBudgetMs: expect.any(Number) })
    )
    expect(newInterrupt).not.toHaveBeenCalled()

    const next = hub.startTurn("codex", {
      threadId: "thread-after-generation",
      message: "second",
      modelId: "gpt-live",
      history: [],
    })
    await expect(next.completion).resolves.toBeUndefined()
    await expect(next.settled).resolves.toBeUndefined()
    expect(newSendTurn).toHaveBeenCalledOnce()
  })

  it("keeps a retiring adapter managed and blocks replacement admission until stop completes", async () => {
    let releaseRetirement!: () => void
    let emitOld!: (event: ProviderRuntimeEvent) => void
    const retirementPending = new Promise<void>((resolve) => {
      releaseRetirement = resolve
    })
    const stopOld = vi.fn(() => retirementPending)
    const oldAdapter = makeAdapter(true, {
      stopAll: stopOld,
      onSubscribe: (emit) => {
        emitOld = emit
      },
    })
    let newSubscribed = false
    const newAdapter = makeAdapter(true, {
      onSubscribe: () => {
        newSubscribed = true
      },
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: oldAdapter,
        },
      ],
    })
    const forwarded: ProviderRuntimeEvent[] = []
    hub.subscribe((event) => forwarded.push(event))

    hub.replaceInstances([
      {
        instanceId: "codex",
        driver: "codex",
        provider: "codex",
        enabled: true,
        adapter: newAdapter,
      },
    ])

    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce())
    expect(hub.getInstance("codex")?.adapter).toBe(oldAdapter)
    expect(newSubscribed).toBe(false)
    expect(() =>
      hub.assertCanStartTurn("codex", "thread-during-retirement", "codex")
    ).toThrowError(
      expect.objectContaining({
        statusCode: 503,
        code: "provider_backend_quarantined",
      })
    )

    emitOld({
      type: "runtime.error",
      threadId: "thread-retiring-subscription",
      eventId: "retiring-adapter-event",
      at: 1,
      message: "old adapter is still observed",
      class: "provider_error",
    })
    expect(forwarded).toContainEqual(
      expect.objectContaining({ eventId: "retiring-adapter-event" })
    )

    releaseRetirement()
    await vi.waitFor(() => {
      expect(hub.getInstance("codex")?.adapter).toBe(newAdapter)
    })
    expect(newSubscribed).toBe(true)
    expect(() =>
      hub.assertCanStartTurn("codex", "thread-after-retirement", "codex")
    ).not.toThrow()
  })

  it("keeps a failed retirement quarantined and never activates its replacement", async () => {
    let emitOld!: (event: ProviderRuntimeEvent) => void
    const stopOld = vi.fn(async () => {
      throw new Error("old backend refused to stop")
    })
    const oldAdapter = makeAdapter(true, {
      stopAll: stopOld,
      onSubscribe: (emit) => {
        emitOld = emit
      },
    })
    let newSubscribed = false
    const newAdapter = makeAdapter(true, {
      onSubscribe: () => {
        newSubscribed = true
      },
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: oldAdapter,
        },
      ],
    })
    const forwarded: ProviderRuntimeEvent[] = []
    hub.subscribe((event) => forwarded.push(event))

    hub.replaceInstances([
      {
        instanceId: "codex",
        driver: "codex",
        provider: "codex",
        enabled: true,
        adapter: newAdapter,
      },
    ])

    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce())
    await vi.waitFor(() => {
      expect(() =>
        hub.assertCanStartTurn(
          "codex",
          "thread-after-failed-retirement",
          "codex"
        )
      ).toThrow("Provider backend is temporarily unavailable.")
    })
    expect(hub.getInstance("codex")?.adapter).toBe(oldAdapter)
    expect(newSubscribed).toBe(false)

    emitOld({
      type: "runtime.error",
      threadId: "thread-failed-retirement-subscription",
      eventId: "failed-retirement-old-adapter-event",
      at: 1,
      message: "failed retirement remains observable",
      class: "provider_error",
    })
    expect(forwarded).toContainEqual(
      expect.objectContaining({
        eventId: "failed-retirement-old-adapter-event",
      })
    )
  })

  it("clears a recorded retirement failure once the backend retires on a later attempt", async () => {
    const stopOld = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("old backend refused to stop"))
      .mockResolvedValue(undefined)
    const oldAdapter = makeAdapter(true, { stopAll: stopOld })
    const newAdapter = makeAdapter(true)
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: oldAdapter,
        },
      ],
    })
    const replacement = [
      {
        instanceId: "codex",
        driver: "codex",
        provider: "codex" as const,
        enabled: true,
        adapter: newAdapter,
      },
    ]

    hub.replaceInstances(replacement)
    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(() =>
        hub.assertCanStartTurn("codex", "thread-retry", "codex")
      ).toThrow("Provider backend is temporarily unavailable.")
    )
    // The failure is visible on the instance status, not only in the log.
    const [blocked] = await hub.listInstances()
    expect(blocked?.retirementFailure).toBe("old backend refused to stop")
    expect(hub.getInstance("codex")?.adapter).toBe(oldAdapter)

    // Before: one failed stopAll left the failure recorded forever and the
    // replacement could never activate. A later successful retirement clears it.
    hub.replaceInstances(replacement)
    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(hub.getInstance("codex")?.adapter).toBe(newAdapter)
    )
    const [activated] = await hub.listInstances()
    expect(activated?.retirementFailure).toBeUndefined()
    expect(() =>
      hub.assertCanStartTurn("codex", "thread-after-retry", "codex")
    ).not.toThrow()
  })

  it("settles the turn as failed when a bus listener rejects its terminal event, without breaking the adapter's emit loop", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const sendTurn = vi.fn(async () => {
      emitRuntimeEvent({
        type: "turn.started",
        threadId: "thread-lane-failure",
        turnId: "provider-turn",
        eventId: "lane-turn-started",
        at: 1,
      })
      emitRuntimeEvent({
        type: "turn.completed",
        threadId: "thread-lane-failure",
        turnId: "provider-turn",
        eventId: "lane-turn-completed",
        at: 2,
      })
      // The adapter's own bookkeeping after the terminal event: with the
      // listener failure propagating into its emit loop this never ran.
      emitRuntimeEvent({
        type: "runtime.warning",
        threadId: "thread-lane-failure",
        eventId: "lane-after-terminal",
        at: 3,
        message: "adapter bookkeeping ran after the terminal event",
        willRetry: false,
      })
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn,
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    // Stands in for the ingestion lane, which rethrows for terminal events
    // whose journal or projection failed.
    const laneFailure = new Error("journal lane rejected terminal event")
    const forwarded: ProviderRuntimeEvent[] = []
    hub.subscribe((event) => {
      forwarded.push(event)
      if (event.type === "turn.completed") throw laneFailure
    })

    const handle = hub.startTurn("codex", {
      threadId: "thread-lane-failure",
      message: "go",
      modelId: "gpt-live",
      history: [],
    })
    // Dispatch itself is not what failed: the adapter's emit loop ran to the
    // end and its later events still reached every subscriber.
    await expect(handle.completion).resolves.toBeUndefined()
    await expect(handle.settled).rejects.toThrow(
      "journal lane rejected terminal event"
    )
    expect(
      forwarded
        .map((event) => event.type)
        .filter((type) => type !== "session.started")
    ).toEqual(["turn.started", "turn.completed", "runtime.warning"])
    // The adapter's later session exit still reaches subscribers too.
    emitRuntimeEvent({
      type: "session.exited",
      threadId: "thread-lane-failure",
      eventId: "lane-session-exited",
      at: 4,
    })
    expect(forwarded.at(-1)).toMatchObject({ type: "session.exited" })
  })

  it("scopes a retirement failure to its own adapter so other providers still admit sessions", async () => {
    const stopOld = vi.fn(async () => {
      throw new Error("old codex backend refused to stop")
    })
    const oldCodex = makeAdapter(true, { stopAll: stopOld })
    const claude = { ...makeAdapter(true), provider: "claude" as const }
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: oldCodex,
        },
        {
          instanceId: "claude",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: claude,
        },
      ],
    })

    hub.replaceInstances([
      {
        instanceId: "codex",
        driver: "codex",
        provider: "codex",
        enabled: true,
        adapter: makeAdapter(true),
      },
      {
        instanceId: "claude",
        driver: "claude",
        provider: "claude",
        enabled: true,
        adapter: claude,
      },
    ])
    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(() =>
        hub.assertCanStartTurn("codex", "thread-codex", "codex")
      ).toThrow("Provider backend is temporarily unavailable.")
    )

    // The failed backend blocks only itself. Before, the retirement failure
    // refused session admission on every adapter as "retained_backend", so
    // this Claude turn (which creates a session first) could never start.
    const claudeTurn = hub.startTurn("claude", {
      providerInstanceId: "claude",
      threadId: "thread-claude",
      message: "hello",
      modelId: "claude-opus",
      history: [],
      projectPath: "/proj",
    })
    await expect(claudeTurn.completion).resolves.toBeUndefined()
    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-codex-blocked",
        message: "hello",
        modelId: "gpt-5.5",
        history: [],
      })
    ).toThrow(ProviderBackendQuarantinedError)
  })

  it("does not bind an unscoped late session exit to a newer turn", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const afterTurn = vi.fn(async () => {})
    const hub = new ProviderHub({
      afterTurn,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: vi.fn(async () => {
              emitRuntimeEvent({
                type: "turn.started",
                threadId: "thread-late-session-exit",
                turnId: "new-provider-turn",
                eventId: "new-turn-started-before-late-exit",
                at: 2,
              })
            }),
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })

    const active = hub.startTurn("codex", {
      threadId: "thread-late-session-exit",
      message: "new session turn",
      modelId: "gpt-live",
      history: [],
    })
    await active.completion
    emitRuntimeEvent({
      type: "session.exited",
      threadId: "thread-late-session-exit",
      eventId: "late-exit-from-replaced-session",
      at: 1,
    })
    await Promise.resolve()

    expect(afterTurn).not.toHaveBeenCalled()
    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-late-session-exit",
        message: "must remain fenced",
        modelId: "gpt-live",
        history: [],
      })
    ).toThrow(ProviderTurnConflictError)

    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-late-session-exit",
      turnId: "new-provider-turn",
      eventId: "new-turn-completed-after-late-exit",
      at: 3,
    })
    await expect(active.settled).resolves.toBeUndefined()
    expect(afterTurn).toHaveBeenCalledOnce()
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.completed" })
    )
  })

  it("rejects delayed lifecycle events from the previous turn on the same adapter", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const forwarded: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => forwarded.push(event))

    const first = hub.startTurn("codex", {
      threadId: "thread-reused-adapter",
      message: "first",
      modelId: "gpt-live",
      history: [],
    })
    await first.completion
    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-first",
      eventId: "first-started",
      at: 1,
      payload: { dispatchTurnId: first.turnId },
    })
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-first",
      eventId: "first-completed",
      at: 2,
      payload: {
        state: "completed",
        dispatchTurnId: first.turnId,
      },
    })
    await first.settled

    const second = hub.startTurn("codex", {
      threadId: "thread-reused-adapter",
      message: "second",
      modelId: "gpt-live",
      history: [],
    })
    await second.completion
    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-first",
      eventId: "stale-first-started",
      at: 3,
      payload: { dispatchTurnId: first.turnId },
    })
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-first",
      eventId: "stale-first-completed",
      at: 4,
      payload: {
        state: "completed",
        dispatchTurnId: first.turnId,
      },
    })
    await Promise.resolve()

    expect(forwarded).not.toContainEqual(
      expect.objectContaining({ eventId: "stale-first-started" })
    )
    expect(forwarded).not.toContainEqual(
      expect.objectContaining({ eventId: "stale-first-completed" })
    )
    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-reused-adapter",
        message: "must remain fenced",
        modelId: "gpt-live",
        history: [],
      })
    ).toThrow(ProviderTurnConflictError)

    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-second",
      eventId: "second-started",
      at: 5,
      payload: { dispatchTurnId: second.turnId },
    })
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-reused-adapter",
      turnId: "provider-turn-second",
      eventId: "second-completed",
      at: 6,
      payload: {
        state: "completed",
        dispatchTurnId: second.turnId,
      },
    })
    await expect(second.settled).resolves.toBeUndefined()
  })

  it("emits a correlated terminal receipt for a stateless adapter", async () => {
    const baseAdapter = makeAdapter(true, { sendTurn: vi.fn(async () => {}) })
    const forwarded: ProviderRuntimeEvent[] = []
    const afterTurn = vi.fn(async (event: ProviderRuntimeEvent) => {
      expect(forwarded).toContain(event)
    })
    const hub = new ProviderHub({
      afterTurn,
      instances: [
        {
          instanceId: "stateless",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: {
            ...baseAdapter,
            capabilities: {
              ...baseAdapter.capabilities,
              managesOwnLifecycle: false,
            },
          },
        },
      ],
    })
    hub.subscribe((event) => forwarded.push(event))

    const handle = hub.startTurn("codex", {
      providerInstanceId: "stateless",
      threadId: "thread-stateless",
      message: "complete immediately",
      modelId: "gpt-stateless",
      history: [],
    })
    await handle.completion
    await handle.settled
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.completed",
        turnId: handle.turnId,
      })
    )

    expect(forwarded).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        threadId: "thread-stateless",
        turnId: handle.turnId,
        payload: expect.objectContaining({
          state: "completed",
          dispatchTurnId: handle.turnId,
        }),
      })
    )
  })

  it("admits only one in-flight turn per thread until a terminal event", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const sendTurn = vi.fn(async () => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn,
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })

    const first = hub.startTurn("codex", {
      threadId: "thread-1",
      message: "first",
      modelId: "gpt-5.5",
      history: [],
    })

    expect(first.turnId).toBeTruthy()
    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-1",
        message: "second",
        modelId: "gpt-5.5",
        history: [],
      })
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "turn_active",
        activeTurnId: first.turnId,
      })
    )

    await first.completion
    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "provider-turn-1",
      eventId: "turn-started-1",
      at: 1,
    })
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-1",
      turnId: "provider-turn-1",
      status: "completed",
      eventId: "turn-completed-1",
      at: 2,
    })
    await first.settled

    const second = hub.startTurn("codex", {
      threadId: "thread-1",
      message: "second",
      modelId: "gpt-5.5",
      history: [],
    })
    expect(second.turnId).not.toBe(first.turnId)

    await Promise.all([first.completion, second.completion])
  })

  it("rejects hub dispatch while another provider stack owns the thread", () => {
    const coordinator = new ThreadTurnCoordinator()
    coordinator.reserveTurn("thread-shared", "legacy:openai")
    const hub = new ProviderHub({
      threadTurnCoordinator: coordinator,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true),
        },
      ],
    })

    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-shared",
        message: "must conflict",
        modelId: "gpt-live",
        history: [],
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )
  })

  it("accepts and releases a turn token reserved by the HTTP admission boundary", async () => {
    const coordinator = new ThreadTurnCoordinator()
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const sharedToken = coordinator.reserveTurn(
      "thread-pre-reserved",
      "http:hub:codex"
    )
    expect(sharedToken).not.toBeNull()
    const hub = new ProviderHub({
      threadTurnCoordinator: coordinator,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })

    const turn = hub.startTurn(
      "codex",
      {
        threadId: "thread-pre-reserved",
        message: "accepted after durable persistence",
        modelId: "gpt-live",
        history: [],
      },
      { sharedToken: sharedToken! }
    )
    await turn.completion
    emitRuntimeEvent({
      type: "turn.completed",
      threadId: "thread-pre-reserved",
      turnId: turn.turnId,
      status: "completed",
      eventId: "turn-completed-pre-reserved",
      at: 1,
    })
    await turn.settled

    expect(coordinator.activeOwner("thread-pre-reserved")).toBeNull()
  })

  it("interrupts and releases a native turn when its watchdog expires", async () => {
    vi.useFakeTimers()
    try {
      let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
      const interruptTurn = vi.fn(async () => {
        emitRuntimeEvent({
          type: "turn.aborted",
          threadId: "thread-timeout",
          turnId: "provider-turn-timeout",
          eventId: "turn-aborted-timeout",
          at: 2,
          payload: {
            reason: "Turn timed out after 100ms.",
            status: "timed_out",
          },
        })
      })
      const observed: ProviderRuntimeEvent[] = []
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn,
              onSubscribe: (emit) => {
                emitRuntimeEvent = emit
              },
            }),
          },
        ],
      })
      hub.subscribe((event) => observed.push(event))

      const first = hub.startTurn("codex", {
        threadId: "thread-timeout",
        message: "first",
        modelId: "gpt-live",
        history: [],
      })
      emitRuntimeEvent({
        type: "turn.started",
        threadId: "thread-timeout",
        turnId: "provider-turn-timeout",
        eventId: "turn-started-timeout",
        at: 1,
      })
      await first.completion
      await vi.advanceTimersByTimeAsync(100)

      expect(interruptTurn).toHaveBeenCalledWith(
        "thread-timeout",
        expect.objectContaining({ interruptBudgetMs: expect.any(Number) })
      )
      expect(observed).toContainEqual(
        expect.objectContaining({
          type: "turn.aborted",
          threadId: "thread-timeout",
          turnId: "provider-turn-timeout",
          payload: expect.objectContaining({
            reason: "Turn timed out after 100ms.",
            status: "timed_out",
          }),
        })
      )
      expect(() =>
        hub.startTurn("codex", {
          threadId: "thread-timeout",
          message: "retry",
          modelId: "gpt-live",
          history: [],
        })
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-arms the turn watchdog on provider activity and pauses it for open requests", async () => {
    vi.useFakeTimers()
    try {
      let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
      const interruptTurn = vi.fn(async () => {
        emitRuntimeEvent({
          type: "turn.aborted",
          threadId: "thread-idle",
          turnId: "provider-turn-idle",
          eventId: "turn-aborted-idle",
          at: Date.now(),
          payload: { reason: "timed out", status: "timed_out" },
        })
      })
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn,
              onSubscribe: (emit) => {
                emitRuntimeEvent = emit
              },
            }),
          },
        ],
      })
      const turn = hub.startTurn("codex", {
        threadId: "thread-idle",
        message: "long run",
        modelId: "gpt-live",
        history: [],
      })
      emitRuntimeEvent({
        type: "turn.started",
        threadId: "thread-idle",
        turnId: "provider-turn-idle",
        eventId: "turn-started-idle",
        at: Date.now(),
      })
      await turn.completion

      // A turn that keeps streaming outlives many idle windows.
      for (let index = 0; index < 10; index++) {
        await vi.advanceTimersByTimeAsync(60)
        emitRuntimeEvent({
          type: "content.delta",
          threadId: "thread-idle",
          turnId: "provider-turn-idle",
          eventId: `delta-${index}`,
          at: Date.now(),
          payload: { streamKind: "assistant_text", delta: "." },
        })
      }
      expect(interruptTurn).not.toHaveBeenCalled()

      // Waiting for the user is not provider inactivity.
      emitRuntimeEvent({
        type: "request.opened",
        threadId: "thread-idle",
        turnId: "provider-turn-idle",
        eventId: "request-opened-idle",
        at: Date.now(),
        requestId: "approval-1",
        kind: "user_input",
      } as ProviderRuntimeEvent)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(interruptTurn).not.toHaveBeenCalled()

      emitRuntimeEvent({
        type: "request.resolved",
        threadId: "thread-idle",
        turnId: "provider-turn-idle",
        eventId: "request-resolved-idle",
        at: Date.now(),
        requestId: "approval-1",
        decision: "answer",
      } as ProviderRuntimeEvent)
      await vi.advanceTimersByTimeAsync(60)
      expect(interruptTurn).not.toHaveBeenCalled()

      // Silence after the answer still times the turn out.
      await vi.advanceTimersByTimeAsync(60)
      expect(interruptTurn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("interrupts a streaming turn at the absolute turn ceiling", async () => {
    vi.useFakeTimers()
    try {
      let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
      const interruptTurn = vi.fn(async () => {
        emitRuntimeEvent({
          type: "turn.aborted",
          threadId: "thread-ceiling",
          turnId: "provider-turn-ceiling",
          eventId: "turn-aborted-ceiling",
          at: Date.now(),
          payload: { reason: "ceiling", status: "timed_out" },
        })
      })
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        turnMaxDurationMs: 300,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn,
              onSubscribe: (emit) => {
                emitRuntimeEvent = emit
              },
            }),
          },
        ],
      })
      const turn = hub.startTurn("codex", {
        threadId: "thread-ceiling",
        message: "endless",
        modelId: "gpt-live",
        history: [],
      })
      emitRuntimeEvent({
        type: "turn.started",
        threadId: "thread-ceiling",
        turnId: "provider-turn-ceiling",
        eventId: "turn-started-ceiling",
        at: Date.now(),
      })
      await turn.completion
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(80)
        emitRuntimeEvent({
          type: "content.delta",
          threadId: "thread-ceiling",
          turnId: "provider-turn-ceiling",
          eventId: `ceiling-delta-${index}`,
          at: Date.now(),
          payload: { streamKind: "assistant_text", delta: "." },
        })
      }
      expect(interruptTurn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps native turn admission closed until watchdog interrupt completes", async () => {
    vi.useFakeTimers()
    try {
      let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
      let resolveInterrupt!: () => void
      const interruptTurn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveInterrupt = () => {
              emitRuntimeEvent({
                type: "turn.aborted",
                threadId: "thread-timeout-barrier",
                eventId: "turn-aborted-timeout-barrier",
                at: 2,
                payload: {
                  reason: "Turn timed out after 100ms.",
                  status: "timed_out",
                },
              })
              resolve()
            }
          })
      )
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn,
              onSubscribe: (emit) => {
                emitRuntimeEvent = emit
              },
            }),
          },
        ],
      })

      const first = hub.startTurn("codex", {
        threadId: "thread-timeout-barrier",
        message: "first",
        modelId: "gpt-live",
        history: [],
      })
      await first.completion
      await vi.advanceTimersByTimeAsync(100)

      expect(() =>
        hub.startTurn("codex", {
          threadId: "thread-timeout-barrier",
          message: "too early",
          modelId: "gpt-live",
          history: [],
        })
      ).toThrow(ProviderTurnConflictError)

      resolveInterrupt()
      await vi.waitFor(() => {
        expect(() =>
          hub.startTurn("codex", {
            threadId: "thread-timeout-barrier",
            message: "retry",
            modelId: "gpt-live",
            history: [],
          })
        ).not.toThrow()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("releases watchdog admission even when provider interruption fails", async () => {
    vi.useFakeTimers()
    try {
      let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
      const observed: ProviderRuntimeEvent[] = []
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn: vi.fn(async () => {
                emitRuntimeEvent({
                  type: "turn.aborted",
                  threadId: "thread-timeout-failure",
                  eventId: "turn-aborted-timeout-failure",
                  at: 2,
                  payload: {
                    reason: "Turn timed out after 100ms.",
                    status: "timed_out",
                  },
                })
                throw new Error("provider interrupt failed")
              }),
              onSubscribe: (emit) => {
                emitRuntimeEvent = emit
              },
            }),
          },
        ],
      })
      hub.subscribe((event) => observed.push(event))
      const first = hub.startTurn("codex", {
        threadId: "thread-timeout-failure",
        message: "first",
        modelId: "gpt-live",
        history: [],
      })
      await first.completion
      await vi.advanceTimersByTimeAsync(100)

      expect(observed).toContainEqual(
        expect.objectContaining({
          type: "runtime.error",
          message: "Failed to interrupt provider turn safely.",
        })
      )
      expect(() =>
        hub.startTurn("codex", {
          threadId: "thread-timeout-failure",
          message: "retry",
          modelId: "gpt-live",
          history: [],
        })
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds a hung watchdog interrupt and rejects settled after finalization", async () => {
    vi.useFakeTimers()
    try {
      const hub = new ProviderHub({
        turnTimeoutMs: 100,
        interruptTimeoutMs: 25,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn: vi.fn(() => new Promise<void>(() => {})),
            }),
          },
        ],
      })
      const turn = hub.startTurn("codex", {
        threadId: "thread-timeout-hung-interrupt",
        message: "first",
        modelId: "gpt-live",
        history: [],
      })
      await turn.completion
      const settlement = expect(turn.settled).rejects.toMatchObject({
        name: "AggregateError",
        message: "Provider turn finalization encountered multiple failures",
      })

      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)

      await settlement
      expect(() =>
        hub.assertCanStartTurn("codex", "thread-timeout-hung-interrupt")
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it("quarantines an unkillable backend without releasing its safety fences", async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new ThreadTurnCoordinator()
      const hub = new ProviderHub({
        threadTurnCoordinator: coordinator,
        interruptTimeoutMs: 25,
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            provider: "codex",
            enabled: true,
            adapter: makeAdapter(true, {
              interruptTurn: vi.fn(() => new Promise<void>(() => {})),
              stopSession: vi.fn(() => new Promise<void>(() => {})),
            }),
          },
        ],
      })
      const turn = hub.startTurn("codex", {
        threadId: "thread-unkillable",
        message: "first",
        modelId: "gpt-live",
        history: [],
      })
      await turn.completion
      let turnFinished = false
      void turn.settled.then(
        () => {
          turnFinished = true
        },
        () => {
          turnFinished = true
        }
      )

      const interrupting = hub.interruptTurn(
        "codex",
        "thread-unkillable" as ThreadId
      )
      const interruption = expect(interrupting).rejects.toMatchObject({
        name: "AggregateError",
        message: "Provider turn finalization encountered multiple failures",
      })
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(25)
      await interruption

      expect(turnFinished).toBe(false)
      expect(coordinator.activeOwner("thread-unkillable")).toBe("hub:codex")
      expect(() => hub.assertCanStartTurn("codex", "another-thread")).toThrow(
        ProviderBackendQuarantinedError
      )
      await expect(hub.listInstances()).resolves.toEqual([
        expect.objectContaining({
          instanceId: "codex",
          status: "error",
          availability: "unavailable",
          unavailableReason: "Provider instance is temporarily unavailable.",
        }),
      ])

      await expect(hub.stopAll()).rejects.toThrow(
        /provider operation|failed to stop/i
      )
      expect(turnFinished).toBe(false)
      expect(coordinator.activeOwner("thread-unkillable")).toBe("hub:codex")
    } finally {
      vi.useRealTimers()
    }
  })

  it("tears down an active turn and session under an exclusive thread barrier", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    let sessionActive = true
    const interruptTurn = vi.fn(async () => {
      emitRuntimeEvent({
        type: "turn.aborted",
        threadId: "thread-delete",
        providerInstanceId: "codex-work",
        turnId: "provider-turn-delete",
        eventId: "turn-aborted-delete",
        at: 2,
        payload: { reason: "provider.threadTeardown", status: "interrupted" },
      })
    })
    const stopSession = vi.fn(async () => {
      sessionActive = false
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            interruptTurn,
            stopSession,
            hasSession: () => sessionActive,
            listSessions: async () =>
              sessionActive
                ? [
                    {
                      threadId: "thread-delete",
                      providerThreadId: "native-thread-delete",
                      status: "ready",
                      cwd: null,
                      activeTurnId: null,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  ]
                : [],
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })

    const active = hub.startTurn("codex", {
      providerInstanceId: "codex-work",
      threadId: "thread-delete",
      message: "active",
      modelId: "gpt-live",
      history: [],
    })
    emitRuntimeEvent({
      type: "turn.started",
      threadId: "thread-delete",
      providerInstanceId: "codex-work",
      turnId: "provider-turn-delete",
      eventId: "turn-started-delete",
      at: 1,
    })
    await active.completion

    await hub.withThreadTeardown("thread-delete", async () => {
      expect(() =>
        hub.startTurn("codex", {
          threadId: "thread-delete",
          message: "must remain blocked",
          modelId: "gpt-live",
          history: [],
        })
      ).toThrow(ProviderTurnConflictError)
    })

    expect(interruptTurn).toHaveBeenCalledWith(
      "thread-delete",
      expect.objectContaining({ interruptBudgetMs: expect.any(Number) })
    )
    expect(stopSession).toHaveBeenCalledWith("thread-delete")
    const retry = hub.startTurn("codex", {
      threadId: "thread-delete",
      message: "allowed after teardown",
      modelId: "gpt-live",
      history: [],
    })
    await retry.completion
  })

  it("releases teardown admission when provider interruption rejects", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            interruptTurn: vi.fn(async () => {
              emitRuntimeEvent({
                type: "turn.aborted",
                threadId: "thread-teardown-failure",
                eventId: "turn-aborted-teardown-failure",
                at: 2,
                payload: {
                  reason: "provider.threadTeardown",
                  status: "interrupted",
                },
              })
              throw new Error("cannot interrupt")
            }),
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    const active = hub.startTurn("codex", {
      threadId: "thread-teardown-failure",
      message: "active",
      modelId: "gpt-live",
      history: [],
    })
    await active.completion

    await expect(
      hub.withThreadTeardown("thread-teardown-failure", async () => {})
    ).rejects.toThrow("cannot interrupt")
    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-teardown-failure",
        message: "retry",
        modelId: "gpt-live",
        history: [],
      })
    ).not.toThrow()
  })

  it("serializes thread maintenance against turn admission", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true),
        },
      ],
    })
    let release!: () => void
    const maintenance = hub.withThreadMaintenance(
      "thread-maintenance",
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    )

    expect(() =>
      hub.startTurn("codex", {
        threadId: "thread-maintenance",
        message: "must wait",
        modelId: "gpt-live",
        history: [],
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "turn_active" })
    )
    await expect(
      hub.withThreadMaintenance("thread-maintenance", async () => undefined)
    ).rejects.toMatchObject({ statusCode: 409, code: "turn_active" })

    release()
    await maintenance
    const admitted = hub.startTurn("codex", {
      threadId: "thread-maintenance",
      message: "now allowed",
      modelId: "gpt-live",
      history: [],
    })
    await expect(
      hub.withThreadMaintenance("thread-maintenance", async () => undefined)
    ).rejects.toMatchObject({ statusCode: 409, code: "turn_active" })
    await admitted.completion
  })

  it("fails interrupt and approval operations for an unknown provider instance", async () => {
    const hub = new ProviderHub({ instances: [] })

    await expect(
      hub.interruptTurnForInstance("codex", "thread-1" as ThreadId, "missing")
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "provider_instance_not_found",
    })
    await expect(
      hub.respondToRequest(
        "codex",
        "thread-1" as ThreadId,
        "approval-1" as ApprovalRequestId,
        { kind: "tool_approval", decision: "deny" },
        "missing"
      )
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "provider_instance_not_found",
    })
    await expect(
      hub.setPermissionMode(
        "codex",
        "thread-1" as ThreadId,
        "default",
        "missing"
      )
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "provider_instance_not_found",
    })
  })

  it("emits a runtime error when a selected provider instance is unavailable", async () => {
    const events: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: false,
          adapter: makeAdapter(),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await expect(
      hub.sendTurn("codex", {
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        message: "hello",
        modelId: "gpt-5.5",
        history: [],
      })
    ).rejects.toThrow(/disabled/i)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.error",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        threadId: "thread-1",
      })
    )
  })

  it("blocks dispatch when BetterC0de project provider policy disables the selected provider", async () => {
    const events: ProviderRuntimeEvent[] = []
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const projectProviderPolicyLoader = vi.fn(async (_cwd: string) => ({
      enabledProviders: [],
      disabledProviders: ["openai"],
    }))
    const hub = new ProviderHub({
      projectProviderPolicyLoader,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await expect(
      hub.sendTurn("codex", {
        threadId: "thread-1",
        message: "hello",
        modelId: "gpt-5.5",
        projectPath: "/repo",
        history: [],
      })
    ).rejects.toThrow(/betterc0de provider policy/i)

    expect(projectProviderPolicyLoader).toHaveBeenCalledWith("/repo")
    expect(sendTurn).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.error",
        providerKind: "codex",
        threadId: "thread-1",
      })
    )
  })

  it("fails closed when the project provider policy cannot be read", async () => {
    const sendTurn = vi.fn(async () => {})
    const hub = new ProviderHub({
      projectProviderPolicyLoader: vi.fn(async () => {
        throw new Error("invalid project provider policy")
      }),
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })

    await expect(
      hub.sendTurn("codex", {
        threadId: "thread-policy-error",
        message: "hello",
        modelId: "gpt-5.5",
        projectPath: "/repo",
        history: [],
      })
    ).rejects.toThrow("invalid project provider policy")
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it("blocks dispatch when BetterC0de project provider policy disables the selected model", async () => {
    const events: ProviderRuntimeEvent[] = []
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const projectProviderPolicyLoader = vi.fn(async (_cwd: string) => ({
      enabledProviders: [],
      disabledProviders: [],
      providers: [
        {
          id: "openai",
          whitelist: ["gpt-5.5"],
          blacklist: ["gpt-blocked"],
        },
      ],
    }))
    const hub = new ProviderHub({
      projectProviderPolicyLoader,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await expect(
      hub.sendTurn("codex", {
        threadId: "thread-1",
        message: "hello",
        modelId: "gpt-blocked",
        projectPath: "/repo",
        history: [],
      })
    ).rejects.toThrow(/model 'gpt-blocked' is disabled/i)

    expect(projectProviderPolicyLoader).toHaveBeenCalledWith("/repo")
    expect(sendTurn).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.error",
        providerKind: "codex",
        threadId: "thread-1",
      })
    )
  })

  it("uses a recovered binding cwd when applying BetterC0de project provider policy", async () => {
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const projectProviderPolicyLoader = vi.fn(async (_cwd: string) => ({
      enabledProviders: ["openai"],
      disabledProviders: [],
    }))
    const bindings = {
      get: vi.fn((threadId: string, providerInstanceId: string) =>
        threadId === "thread-1" && providerInstanceId === "codex"
          ? {
              threadId,
              providerKind: "codex",
              providerInstanceId,
              providerThreadId: null,
              resumeCursor: null,
              continuationKey: null,
              cwd: "/repo-from-binding",
              modelSelection: null,
              runtimeMode: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            }
          : null
      ),
      list: vi.fn(() => []),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
      updateRuntimeContext: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      projectProviderPolicyLoader,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })

    await hub.sendTurn(
      "codex",
      {
        threadId: "thread-1",
        message: "hello",
        modelId: "gpt-5.5",
        projectPath: null,
        history: [],
      },
      { bindings }
    )

    expect(projectProviderPolicyLoader).toHaveBeenCalledWith(
      "/repo-from-binding"
    )
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo-from-binding",
      })
    )
  })

  it("stops each distinct runtime adapter once", async () => {
    const stopAll = vi.fn(async () => {})
    const adapter = makeAdapter(true, { stopAll })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter,
        },
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter,
        },
      ],
    })

    await hub.stopAll()

    expect(stopAll).toHaveBeenCalledTimes(1)
  })

  it("waits for native interrupt finalization rather than dispatch acknowledgement", async () => {
    let emitRuntimeEvent!: (event: ProviderRuntimeEvent) => void
    let releaseInterrupt!: () => void
    const pendingInterrupt = new Promise<void>((resolve) => {
      releaseInterrupt = () => {
        emitRuntimeEvent({
          type: "turn.aborted",
          threadId: "thread-shutdown",
          eventId: "turn-aborted-shutdown",
          at: 2,
          payload: {
            reason: "provider.interruptAllTurns",
            status: "interrupted",
          },
        })
        resolve()
      }
    })
    const interruptTurn = vi.fn(() => pendingInterrupt)
    const observed: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: async () => {},
            interruptTurn,
            onSubscribe: (emit) => {
              emitRuntimeEvent = emit
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => observed.push(event))
    const turn = hub.startTurn("codex", {
      threadId: "thread-shutdown",
      message: "hello",
      modelId: "gpt-5.5",
      projectPath: "/repo",
      history: [],
    })
    await turn.completion

    let settled = false
    const interrupting = hub.interruptAllTurns().then((count) => {
      settled = true
      return count
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(interruptTurn).toHaveBeenCalledWith(
      "thread-shutdown",
      expect.objectContaining({ interruptBudgetMs: expect.any(Number) })
    )
    expect(settled).toBe(false)
    releaseInterrupt()
    await expect(interrupting).resolves.toBe(1)
    await expect(turn.settled).resolves.toBeUndefined()
    expect(observed).toContainEqual(
      expect.objectContaining({
        type: "turn.aborted",
        threadId: "thread-shutdown",
        payload: expect.objectContaining({
          status: "interrupted",
          dispatchTurnId: turn.turnId,
        }),
      })
    )
  })

  it("uses adapter stop finalization instead of a pending dispatch acknowledgement", async () => {
    let releaseTurn!: () => void
    const pendingTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const sendTurn = vi.fn(async () => pendingTurn)
    const stopAll = vi.fn(async () => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn,
            stopAll,
          }),
        },
      ],
    })
    const turn = hub.startTurn("codex", {
      threadId: "thread-stop-all",
      message: "hello",
      modelId: "gpt-5.5",
      projectPath: "/repo",
      history: [],
    })
    void turn.completion.catch(() => {})
    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledOnce())

    const stopping = hub.stopAll()
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(stopAll).toHaveBeenCalledOnce())
    expect(stopped).toBe(false)
    releaseTurn()
    await expect(turn.completion).resolves.toBeUndefined()
    await expect(stopping).resolves.toBeUndefined()
    await expect(turn.settled).resolves.toBeUndefined()
  })

  it("reports adapter shutdown failures after attempting every adapter", async () => {
    const failedStop = vi.fn(async () => {
      throw new Error("codex process did not stop")
    })
    const successfulStop = vi.fn(async () => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, { stopAll: failedStop }),
        },
        {
          instanceId: "claude",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: makeAdapter(true, { stopAll: successfulStop }),
        },
      ],
    })

    await expect(hub.stopAll()).rejects.toThrow(
      "1 provider adapter(s) failed to stop"
    )
    expect(failedStop).toHaveBeenCalledTimes(1)
    expect(successfulStop).toHaveBeenCalledTimes(1)
  })

  it("emits stopped lifecycle events for active sessions during stopAll", async () => {
    const events: ProviderRuntimeEvent[] = []
    const stopAll = vi.fn(async () => {})
    const listSessions = vi
      .fn<NonNullable<ProviderAdapterShape["listSessions"]>>()
      .mockResolvedValue([
        {
          threadId: "thread-1",
          providerThreadId: "sdk-thread-1",
          status: "running",
          cwd: "/repo",
          activeTurnId: "turn-1",
          createdAt: 100,
          updatedAt: 200,
        },
      ])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { listSessions, stopAll }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await hub.stopAll()

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        payload: expect.objectContaining({
          reason: "provider.stopAll",
          exitKind: "graceful",
        }),
      })
    )
  })

  it("correlates adapter runtime events with their owning provider instance", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const events: ProviderRuntimeEvent[] = []
    const forwarded: Array<{
      event: ProviderRuntimeEvent
      provider: string
    }> = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
      onEvent: (event, provider) => forwarded.push({ event, provider }),
    })
    hub.subscribe((event) => events.push(event))

    emit({
      threadId: "thread-1",
      eventId: "event-1",
      at: Date.now(),
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "content.delta",
      provider: "codex",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    })
    expect(forwarded).toEqual([
      {
        provider: "codex",
        event: expect.objectContaining({
          type: "content.delta",
          providerKind: "codex",
          providerInstanceId: "codex-work",
        }),
      },
    ])
  })

  it.each([
    { provider: "claude" as const, alias: "claudeAgent" },
    { provider: "cursor" as const, alias: "cursor-agent" },
    { provider: "betterc0de" as const, alias: "betterc0de-cli" },
  ])(
    "accepts canonical $provider driver aliases while correlating provider runtime events",
    ({ provider, alias }) => {
      let emit!: (event: ProviderRuntimeEvent) => void
      const events: ProviderRuntimeEvent[] = []
      const hub = new ProviderHub({
        instances: [
          {
            instanceId: `${provider}-main`,
            driver: provider,
            provider,
            displayName: `${provider} Main`,
            enabled: true,
            adapter: makeAdapter(true, {
              onSubscribe: (next) => {
                emit = next
              },
            }),
          },
        ],
      })
      hub.subscribe((event) => events.push(event))

      emit({
        threadId: "thread-1",
        eventId: `event-${provider}-alias`,
        at: Date.now(),
        type: "content.delta",
        provider: alias,
        payload: {
          streamKind: "assistant_text",
          delta: "hello",
        },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: "content.delta",
        provider,
        providerKind: provider,
        providerInstanceId: `${provider}-main`,
      })
    }
  )

  it("records metrics for correlated provider runtime events", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
    })

    emit({
      threadId: "thread-1",
      eventId: "event-metric-1",
      at: Date.now(),
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    })

    expect(backendMetrics.snapshot()).toContainEqual({
      type: "counter",
      name: PROVIDER_RUNTIME_EVENTS_TOTAL,
      attributes: {
        eventType: "content.delta",
        provider: "codex",
      },
      value: 1,
    })
    void hub
  })

  it("writes correlated provider runtime events to the canonical event logger", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const writes: Array<{
      event: ProviderRuntimeEvent
      threadId: string | null
    }> = []
    const close = vi.fn()
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
      canonicalEventLogger: {
        filePath: "/tmp/provider-events.log",
        write: (event, threadId) =>
          writes.push({
            event: event as ProviderRuntimeEvent,
            threadId: threadId ?? null,
          }),
        flush: async () => {},
        removeThread: async () => {},
        close,
      },
    })

    emit({
      threadId: "thread-1",
      eventId: "event-canonical-log",
      at: Date.now(),
      type: "content.delta",
      provider: "claudeAgent",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    })

    expect(writes).toEqual([
      {
        threadId: "thread-1",
        event: expect.objectContaining({
          type: "content.delta",
          provider: "claude",
          providerKind: "claude",
          providerInstanceId: "claude-main",
        }),
      },
    ])
    void hub
  })

  it("rejects adapter runtime events emitted for a different provider instance", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const events: ProviderRuntimeEvent[] = []
    const forwarded: Array<{
      event: ProviderRuntimeEvent
      provider: string
    }> = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
      onEvent: (event, provider) => forwarded.push({ event, provider }),
    })
    hub.subscribe((event) => events.push(event))

    emit({
      threadId: "thread-1",
      eventId: "foreign-event-1",
      at: Date.now(),
      type: "content.delta",
      providerKind: "codex",
      providerInstanceId: "other-codex",
      payload: {
        streamKind: "assistant_text",
        delta: "wrong instance",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      message: expect.stringContaining(
        "emitted event for instance 'other-codex'"
      ),
    })
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "content.delta",
        providerInstanceId: "other-codex",
      })
    )
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({
      provider: "codex",
      event: expect.objectContaining({
        type: "runtime.error",
        providerInstanceId: "codex-work",
      }),
    })
  })

  it("rejects adapter runtime events emitted for a different provider driver", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const events: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    emit({
      threadId: "thread-1",
      eventId: "foreign-event-2",
      at: Date.now(),
      type: "content.delta",
      provider: "codex",
      payload: {
        streamKind: "assistant_text",
        delta: "wrong driver",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      message: expect.stringContaining("emitted driver 'codex'"),
    })
  })

  it("rejects adapter runtime events emitted for a different provider kind", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const events: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    emit({
      threadId: "thread-1",
      eventId: "foreign-event-3",
      at: Date.now(),
      type: "content.delta",
      providerKind: "codex",
      payload: {
        streamKind: "assistant_text",
        delta: "wrong provider kind",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      message: expect.stringContaining("emitted event for 'codex'"),
    })
  })

  it("rejects adapter runtime events emitted for an unknown driver", () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const events: ProviderRuntimeEvent[] = []
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    emit({
      threadId: "thread-1",
      eventId: "foreign-event-4",
      at: Date.now(),
      type: "content.delta",
      provider: "custom-driver",
      payload: {
        streamKind: "assistant_text",
        delta: "unknown driver",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      message: expect.stringContaining("emitted driver 'custom-driver'"),
    })
  })

  it("marks all persisted provider bindings stopped during stopAll", async () => {
    const updateSessionLifecycle = vi.fn()
    const bindings = {
      get: vi.fn(() => null),
      list: vi.fn(() => [
        {
          threadId: "thread-active",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-1",
          resumeCursor: { sessionId: "sdk-thread-1" },
          continuationKey: "claude:home:/Users/example",
          status: "running",
          activeTurnId: "turn-1",
          lastError: null,
          runtimeMode: "full-access",
          cwd: "/repo/active",
          modelSelection: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        {
          threadId: "thread-persisted",
          providerKind: "codex",
          providerInstanceId: "codex-work",
          providerThreadId: "codex-thread-1",
          resumeCursor: { providerThreadId: "codex-thread-1" },
          continuationKey: "codex:home:/Users/example/.codex-work",
          status: "ready",
          activeTurnId: null,
          lastError: null,
          runtimeMode: "full-access",
          cwd: "/repo/persisted",
          modelSelection: {
            instanceId: "codex-work",
            model: "gpt-5.5",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ]),
      updateSessionLifecycle,
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { listSessions: async () => [] }),
        },
      ],
    })

    await hub.stopAll(bindings)

    expect(updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-active",
      providerInstanceId: "claude-main",
      providerKind: "claude",
      status: "stopped",
      activeTurnId: null,
    })
    expect(updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-persisted",
      providerInstanceId: "codex-work",
      providerKind: "codex",
      status: "stopped",
      activeTurnId: null,
    })
  })

  it("persists active provider session resume state before stopAll", async () => {
    const db = openDatabase(path.join(tempDir(), "test.sqlite"))
    runMigrations(db)
    const bindings = new ProviderSessionBindingStore(db)
    const stopAll = vi.fn(async () => {})
    const listSessions = vi
      .fn<NonNullable<ProviderAdapterShape["listSessions"]>>()
      .mockResolvedValue([
        {
          threadId: "thread-live",
          providerThreadId: "sdk-thread-1",
          resumeCursor: { sessionId: "sdk-thread-1" },
          continuationKey: "claude:home:/Users/example",
          status: "running",
          cwd: "/Users/example/project",
          activeTurnId: "turn-1",
          createdAt: 100,
          updatedAt: 200,
        },
      ])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { listSessions, stopAll }),
        },
      ],
    })

    await hub.stopAll(bindings)

    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(bindings.get("thread-live", "claude-main")).toMatchObject({
      threadId: "thread-live",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      providerThreadId: "sdk-thread-1",
      resumeCursor: { sessionId: "sdk-thread-1" },
      continuationKey: "claude:home:/Users/example",
      status: "stopped",
      activeTurnId: null,
      cwd: "/Users/example/project",
    })
    db.close()
  })

  it("caches provider metadata for list calls and refreshes explicitly", async () => {
    const availableSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockResolvedValueOnce([
        { name: "review", path: "/tmp/review", enabled: true },
      ])
      .mockResolvedValueOnce([
        { name: "review", path: "/tmp/review", enabled: true },
        { name: "tests", path: "/tmp/tests", enabled: true },
      ])
    const availableSlashCommands = vi
      .fn<NonNullable<ProviderAdapterShape["availableSlashCommands"]>>()
      .mockResolvedValue([{ name: "compact" }])
    const availableAgents = vi
      .fn<NonNullable<ProviderAdapterShape["availableAgents"]>>()
      .mockResolvedValue([{ name: "build", mode: "primary", hidden: false }])
    const availableTools = vi
      .fn<NonNullable<ProviderAdapterShape["availableTools"]>>()
      .mockResolvedValue([{ id: "bash", displayName: "Bash" }])
    const availableProviderCatalog = vi
      .fn<NonNullable<ProviderAdapterShape["availableProviderCatalog"]>>()
      .mockResolvedValue([
        {
          id: "openai",
          name: "OpenAI",
          connected: true,
          enabled: true,
          env: [],
          endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
          modelCount: 1,
        },
      ])
    const availableModels = vi
      .fn<ProviderAdapterShape["availableModels"]>()
      .mockResolvedValue([{ slug: "gpt-live", name: "GPT Live" }])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableModels,
            availableSkills,
            availableSlashCommands,
            availableAgents,
            availableTools,
            availableProviderCatalog,
          }),
        },
      ],
    })

    const [first] = await hub.listInstances({ cwd: "/repo" })
    const [second] = await hub.listInstances({ cwd: "/repo" })
    await hub.refreshInstanceMetadata("codex", { cwd: "/repo" })
    const [third] = await hub.listInstances({ cwd: "/repo" })

    expect(first?.skills).toHaveLength(1)
    expect(second?.skills).toHaveLength(1)
    expect(third?.skills).toHaveLength(2)
    expect(first?.slashCommands).toEqual([{ name: "compact" }])
    expect(first?.agents).toEqual([
      { name: "build", mode: "primary", hidden: false },
    ])
    expect(first?.tools).toEqual([{ id: "bash", displayName: "Bash" }])
    expect(first?.providerCatalog).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        connected: true,
        enabled: true,
        env: [],
        endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
        modelCount: 1,
      },
    ])
    expect(availableSkills).toHaveBeenCalledTimes(2)
    expect(availableSkills.mock.calls[1]?.[0]).toEqual({
      cwd: "/repo",
      force: true,
    })
    expect(availableSlashCommands).toHaveBeenCalledTimes(2)
    expect(availableAgents).toHaveBeenCalledTimes(2)
    expect(availableTools).toHaveBeenCalledTimes(2)
    expect(availableProviderCatalog).toHaveBeenCalledTimes(2)
    expect(availableModels).toHaveBeenCalledTimes(4)
    expect(availableModels.mock.calls[2]?.[0]).toEqual({ force: true })
    expect(third?.metadata?.checkedAt).toEqual(expect.any(Number))
  })

  it("does not expose provider metadata rejection details in snapshots", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableSkills: async () => {
              throw new Error(
                "failed at C:\\private\\skills.json with token sk-sensitive"
              )
            },
          }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances({ cwd: "/repo" })

    expect(snapshot?.metadata?.skillsError).toBe(
      "Provider skills could not be loaded."
    )
    expect(JSON.stringify(snapshot?.metadata)).not.toContain("skills.json")
    expect(JSON.stringify(snapshot?.metadata)).not.toContain("sk-sensitive")
  })

  it("invalidates provider metadata cache when an adapter reports changed skills", async () => {
    let emit!: (event: ProviderRuntimeEvent) => void
    const invalidateMetadata = vi.fn()
    const availableSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockResolvedValueOnce([
        { name: "review", path: "/tmp/review", enabled: true },
      ])
      .mockResolvedValueOnce([
        { name: "review", path: "/tmp/review", enabled: true },
        { name: "tests", path: "/tmp/tests", enabled: true },
      ])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableSkills,
            invalidateMetadata,
            onSubscribe: (next) => {
              emit = next
            },
          }),
        },
      ],
    })

    const [first] = await hub.listInstances({ cwd: "/repo" })
    emit({
      threadId: "thread-1",
      eventId: "event-1",
      at: Date.now(),
      type: "provider.metadata.changed",
      payload: {
        metadataKind: "skills",
        summary: "Skills changed",
      },
    })
    const [second] = await hub.listInstances({ cwd: "/repo" })

    expect(first?.skills).toHaveLength(1)
    expect(second?.skills).toHaveLength(2)
    expect(availableSkills).toHaveBeenCalledTimes(2)
    expect(availableSkills.mock.calls[1]?.[0]).toEqual({
      cwd: "/repo",
      force: false,
    })
    expect(invalidateMetadata).toHaveBeenCalledWith(undefined)
  })

  it("coalesces concurrent explicit provider metadata refreshes per cwd", async () => {
    let resolveSkills!: (value: ProviderSkill[]) => void
    const skillsPromise = new Promise<ProviderSkill[]>((resolve) => {
      resolveSkills = resolve
    })
    const availableSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockImplementationOnce(async () => skillsPromise)
    const availableSlashCommands = vi
      .fn<NonNullable<ProviderAdapterShape["availableSlashCommands"]>>()
      .mockResolvedValue([{ name: "compact" }])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableSkills,
            availableSlashCommands,
          }),
        },
      ],
    })

    const first = hub.refreshInstanceMetadata("codex", { cwd: "/repo" })
    const second = hub.refreshInstanceMetadata("codex", { cwd: "/repo" })

    expect(availableSkills).toHaveBeenCalledTimes(1)
    expect(availableSkills.mock.calls[0]?.[0]).toEqual({
      cwd: "/repo",
      force: true,
    })

    resolveSkills([{ name: "review", path: "/tmp/review", enabled: true }])

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ checkedAt: expect.any(Number) }),
      expect.objectContaining({ checkedAt: expect.any(Number) }),
    ])
    expect(availableSkills).toHaveBeenCalledTimes(1)
    expect(availableSlashCommands).toHaveBeenCalledTimes(1)
  })

  it("coalesces lexically equivalent cwd keys for concurrent instance lists", async () => {
    let releasePolicy!: () => void
    const policyPending = new Promise<null>((resolve) => {
      releasePolicy = () => resolve(null)
    })
    const projectProviderPolicyLoader = vi.fn(async () => policyPending)
    const hub = new ProviderHub({
      instances: [],
      projectProviderPolicyLoader,
    })
    const project = path.join(process.cwd(), "virtual-provider-project")
    const alias = path.join(project, "nested", "..")

    const first = hub.listInstances({ cwd: project })
    const second = hub.listInstances({ cwd: `  ${alias}${path.sep}  ` })

    expect(second).toBe(first)
    expect(projectProviderPolicyLoader).toHaveBeenCalledTimes(1)

    releasePolicy()
    await expect(first).resolves.toEqual([])
  })

  it("bounds concurrent instance-list keys", async () => {
    let releasePolicy!: () => void
    const policyPending = new Promise<null>((resolve) => {
      releasePolicy = () => resolve(null)
    })
    const projectProviderPolicyLoader = vi.fn(async () => policyPending)
    const hub = new ProviderHub({
      instances: [],
      projectProviderPolicyLoader,
      listInstancesInFlightMaxEntries: 1,
    })

    const first = hub.listInstances({ cwd: "/repo-a" })
    const overflow = hub.listInstances({ cwd: "/repo-b" })

    await expect(overflow).rejects.toBeInstanceOf(ProviderMetadataCapacityError)
    expect(projectProviderPolicyLoader).toHaveBeenCalledTimes(1)

    releasePolicy()
    await expect(first).resolves.toEqual([])
  })

  it("bounds distinct in-flight provider metadata keys", async () => {
    let resolveFirst!: (value: ProviderSkill[]) => void
    const firstSkillsPending = new Promise<ProviderSkill[]>((resolve) => {
      resolveFirst = resolve
    })
    const firstSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockImplementation(async () => firstSkillsPending)
    const secondSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockResolvedValue([])
    const hub = new ProviderHub({
      metadataInFlightMaxEntries: 1,
      instances: [
        {
          instanceId: "codex-a",
          driver: "codex",
          provider: "codex",
          displayName: "Codex A",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills: firstSkills }),
        },
        {
          instanceId: "codex-b",
          driver: "codex",
          provider: "codex",
          displayName: "Codex B",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills: secondSkills }),
        },
      ],
    })

    const first = hub.refreshInstanceMetadata("codex-a", { cwd: "/repo-a" })
    await vi.waitFor(() => expect(firstSkills).toHaveBeenCalledOnce())

    await expect(
      hub.refreshInstanceMetadata("codex-b", { cwd: "/repo-b" })
    ).rejects.toBeInstanceOf(ProviderMetadataCapacityError)
    expect(secondSkills).not.toHaveBeenCalled()

    resolveFirst([])
    await expect(first).resolves.toMatchObject({
      checkedAt: expect.any(Number),
    })
  })

  it("releases session admission when startSession never finishes", async () => {
    const hub = new ProviderHub({
      interruptTimeoutMs: 40,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            startSession: () => new Promise(() => {}),
          }),
        },
      ],
    })
    const first = hub.startTurn("codex", {
      threadId: "thread-hung-start",
      message: "first",
      modelId: "gpt-live",
      history: [],
    })
    const second = hub.startTurn("codex", {
      threadId: "thread-hung-start-next",
      message: "second",
      modelId: "gpt-live",
      history: [],
    })
    await expect(first.settled).rejects.toThrow(ProviderBackendQuarantinedError)
    await expect(second.settled).rejects.toThrow(ProviderSessionCapacityError)
  })

  it("drains an in-flight provider metadata read before stopping adapters", async () => {
    let resolveSkills!: (value: ProviderSkill[]) => void
    const skillsPending = new Promise<ProviderSkill[]>((resolve) => {
      resolveSkills = resolve
    })
    const availableSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockImplementation(async () => skillsPending)
    const stopAll = vi.fn(async () => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills, stopAll }),
        },
      ],
    })

    const refresh = hub.refreshInstanceMetadata("codex", { cwd: "/repo" })
    await vi.waitFor(() => expect(availableSkills).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = hub.stopAll().then(() => {
      stopped = true
    })
    // Let every already-runnable continuation settle: shutdown must be
    // parked on the metadata probe, not past it.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopAll).not.toHaveBeenCalled()
    expect(stopped).toBe(false)

    resolveSkills([])
    await expect(refresh).resolves.toMatchObject({
      checkedAt: expect.any(Number),
    })
    await stopping
    expect(stopAll).toHaveBeenCalledOnce()
  })

  it("limits provider metadata work globally and bounds its wait queue", async () => {
    let resolveFirst!: (value: ProviderSkill[]) => void
    const firstSkillsPending = new Promise<ProviderSkill[]>((resolve) => {
      resolveFirst = resolve
    })
    const firstSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockImplementation(async () => firstSkillsPending)
    const secondSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockResolvedValue([])
    const thirdSkills = vi
      .fn<NonNullable<ProviderAdapterShape["availableSkills"]>>()
      .mockResolvedValue([])
    const hub = new ProviderHub({
      metadataConcurrencyLimit: 1,
      metadataQueueMaxEntries: 1,
      instances: [
        {
          instanceId: "codex-a",
          driver: "codex",
          provider: "codex",
          displayName: "Codex A",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills: firstSkills }),
        },
        {
          instanceId: "codex-b",
          driver: "codex",
          provider: "codex",
          displayName: "Codex B",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills: secondSkills }),
        },
        {
          instanceId: "codex-c",
          driver: "codex",
          provider: "codex",
          displayName: "Codex C",
          enabled: true,
          adapter: makeAdapter(true, { availableSkills: thirdSkills }),
        },
      ],
    })

    const first = hub.refreshInstanceMetadata("codex-a")
    const second = hub.refreshInstanceMetadata("codex-b")
    const overflow = hub.refreshInstanceMetadata("codex-c")

    await expect(overflow).rejects.toBeInstanceOf(ProviderMetadataCapacityError)
    expect(firstSkills).toHaveBeenCalledOnce()
    expect(secondSkills).not.toHaveBeenCalled()
    expect(thirdSkills).not.toHaveBeenCalled()

    resolveFirst([])
    await expect(first).resolves.toMatchObject({
      checkedAt: expect.any(Number),
    })
    await expect(second).resolves.toMatchObject({
      checkedAt: expect.any(Number),
    })
    expect(secondSkills).toHaveBeenCalledOnce()
  })

  it("rejects provider cwd keys that exceed the fixed input bound", () => {
    const hub = new ProviderHub({ instances: [] })

    expect(() => hub.listInstances({ cwd: "x".repeat(4_097) })).toThrow(
      ProviderMetadataInputError
    )
  })

  it("includes provider models in instance snapshots", async () => {
    const availableModels = vi
      .fn<ProviderAdapterShape["availableModels"]>()
      .mockResolvedValue([{ slug: "gpt-live", name: "GPT Live" }])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { availableModels }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot?.models).toEqual([
      {
        slug: "gpt-live",
        name: "GPT Live",
        isCustom: false,
        capabilities: null,
      },
    ])
    expect(snapshot).toMatchObject({
      instanceId: "codex",
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      availability: "available",
      checkedAt: expect.any(String),
      versionAdvisory: {
        status: "unknown",
        currentVersion: null,
        latestVersion: null,
        updateCommand: "npm install -g @openai/codex@latest",
        canUpdate: true,
        checkedAt: expect.any(String),
        message: null,
      },
      showInteractionModeToggle: true,
    })
    expect(availableModels).toHaveBeenCalledTimes(1)
  })

  it("redacts declared config secrets and sensitive environment values", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "remote",
          driver: "betterc0de",
          provider: "betterc0de",
          displayName: "Remote",
          enabled: true,
          environment: [
            {
              name: "REMOTE_TOKEN",
              value: "environment-secret",
              sensitive: true,
            },
            { name: "LOG_LEVEL", value: "debug", sensitive: false },
          ],
          config: {
            serverUrl: "https://example.test",
            serverPassword: "server-secret",
          },
          adapter: makeAdapter(true),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot).toMatchObject({
      config: {
        serverUrl: "https://example.test",
        serverPassword: {
          configured: true,
          storage: expect.stringMatching(/^(encrypted|plaintext)$/),
        },
      },
      environment: [
        {
          name: "REMOTE_TOKEN",
          value: "",
          valueRedacted: true,
          secretState: {
            configured: true,
            storage: expect.stringMatching(/^(encrypted|plaintext)$/),
          },
        },
        { name: "LOG_LEVEL", value: "debug", sensitive: false },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("environment-secret")
    expect(JSON.stringify(snapshot)).not.toContain("server-secret")
  })

  it("filters instance snapshot models through BetterC0de provider model policy", async () => {
    const availableModels = vi
      .fn<ProviderAdapterShape["availableModels"]>()
      .mockResolvedValue([
        {
          slug: "gpt-live",
          name: "GPT Live",
          catalog: { providerId: "openai", modelId: "gpt-live" },
        },
        {
          slug: "gpt-blocked",
          name: "GPT Blocked",
          catalog: { providerId: "openai", modelId: "gpt-blocked" },
        },
        {
          slug: "gpt-other",
          name: "GPT Other",
          catalog: { providerId: "openai", modelId: "gpt-other" },
        },
      ])
    const projectProviderPolicyLoader = vi.fn(async (_cwd: string) => ({
      enabledProviders: [],
      disabledProviders: [],
      providers: [
        {
          id: "openai",
          whitelist: ["gpt-live"],
          blacklist: ["gpt-blocked"],
        },
      ],
    }))
    const hub = new ProviderHub({
      projectProviderPolicyLoader,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { availableModels }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances({ cwd: "/repo" })

    expect(projectProviderPolicyLoader).toHaveBeenCalledWith("/repo")
    expect(snapshot?.models.map((model) => model.slug)).toEqual(["gpt-live"])
  })

  it("uses provider status probes as authoritative snapshot auth state", async () => {
    const availableModels = vi
      .fn<ProviderAdapterShape["availableModels"]>()
      .mockResolvedValue([{ slug: "cursor-model", name: "Cursor Model" }])
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "cursor",
          driver: "cursor",
          provider: "cursor",
          displayName: "Cursor",
          enabled: true,
          installed: true,
          adapter: makeAdapter(true, { availableModels }),
          statusProbe: async () => ({
            installed: true,
            configured: false,
            version: "2026.04.08-abcdef",
            status: "error",
            auth: { status: "unauthenticated" },
            message:
              "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
          }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot).toMatchObject({
      instanceId: "cursor",
      configured: false,
      installed: true,
      version: "2026.04.08-abcdef",
      status: "error",
      auth: { status: "unauthenticated" },
      // The adapter's own probe message is actionable ("Run `cursor-agent login`") and
      // is surfaced verbatim; the generic "authentication is required" string is
      // only a fallback for probes that report a bad status without a message.
      message:
        "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
      models: [],
    })
    expect(availableModels).not.toHaveBeenCalled()
  })

  it("surfaces the adapter's own warning message instead of the generic one", async () => {
    // A provider that is authenticated and configured but whose live metadata
    // probe failed reports status "warning" with a reassuring, specific message.
    // The snapshot must carry that message through — not collapse it to the
    // generic "Provider status requires attention.", which hides that the
    // provider is still usable. Regression for the Codex status banner.
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex CLI",
          enabled: true,
          installed: true,
          adapter: makeAdapter(true),
          statusProbe: async () => ({
            installed: true,
            configured: true,
            version: null,
            status: "warning",
            auth: { status: "authenticated" },
            message:
              "Codex CLI is authenticated, but the app-server metadata probe " +
              "failed. Provider remains selectable; models and skills will use " +
              "cached or fallback metadata until the probe succeeds.",
          }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot).toMatchObject({
      instanceId: "codex",
      configured: true,
      installed: true,
      status: "warning",
      auth: { status: "authenticated" },
      message:
        "Codex CLI is authenticated, but the app-server metadata probe " +
        "failed. Provider remains selectable; models and skills will use " +
        "cached or fallback metadata until the probe succeeds.",
    })
  })

  it("falls back to the generic warning message when the probe omits one", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex CLI",
          enabled: true,
          installed: true,
          adapter: makeAdapter(true),
          statusProbe: async () => ({
            installed: true,
            configured: true,
            version: null,
            status: "warning",
            auth: { status: "authenticated" },
          }),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot?.message).toBe("Provider status requires attention.")
  })

  it("enriches provider snapshots with latest-version advisories", async () => {
    const latestProviderVersionResolver = vi.fn().mockResolvedValue("2.0.0")
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "1.0.0",
          config: { binaryPath: "/opt/homebrew/bin/codex" },
          adapter: makeAdapter(true),
        },
      ],
      latestProviderVersionResolver,
    })

    const [snapshot] = await hub.listInstances()

    expect(latestProviderVersionResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        packageName: "@openai/codex",
        update: expect.objectContaining({
          command: "brew upgrade codex",
        }),
      })
    )
    expect(snapshot?.versionAdvisory).toEqual({
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateCommand: "brew upgrade codex",
      canUpdate: true,
      checkedAt: expect.any(String),
      message: "Install the update now or review provider settings.",
    })
  })

  it("runs provider updates through the resolved allowlisted command and records success", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "updated",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    const latestProviderVersionResolver = vi.fn().mockResolvedValue("2.0.0")
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "1.0.0",
          config: { binaryPath: "/opt/homebrew/bin/codex" },
          adapter: makeAdapter(true),
        },
      ],
      latestProviderVersionResolver,
      providerMaintenanceCommandRunner: runCommand,
      refreshInstances: () => [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "2.0.0",
          config: { binaryPath: "/opt/homebrew/bin/codex" },
          adapter: makeAdapter(true),
        },
      ],
    })

    const result = await hub.updateProviderInstance("codex")

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "brew",
        args: ["upgrade", "codex"],
      })
    )
    expect(result.instance).toMatchObject({
      instanceId: "codex",
      version: "2.0.0",
      updateState: {
        status: "succeeded",
        message: "Provider updated.",
        output: null,
      },
    })
  })

  it("records provider update command failures in updateState", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "1.0.0",
          adapter: makeAdapter(true),
        },
      ],
      providerMaintenanceCommandRunner: vi.fn().mockResolvedValue({
        stdout: "",
        stderr:
          "permission denied at C:\\private\\provider.json for sk-sensitive",
        exitCode: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    })

    const result = await hub.updateProviderInstance("codex")

    expect(result.instance?.updateState).toMatchObject({
      status: "failed",
      message: "Update command exited with code 1.",
      output: null,
    })
    expect(JSON.stringify(result.instance?.updateState)).not.toContain(
      "provider.json"
    )
    expect(JSON.stringify(result.instance?.updateState)).not.toContain(
      "sk-sensitive"
    )
  })

  it("masks thrown provider update details in the public update state", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "1.0.0",
          adapter: makeAdapter(true),
        },
      ],
      providerMaintenanceCommandRunner: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "spawn failed at C:\\private\\provider.json with token sk-sensitive"
          )
        ),
    })

    const result = await hub.updateProviderInstance("codex")

    expect(result.instance?.updateState).toMatchObject({
      status: "failed",
      message: "Provider update failed.",
      output: null,
    })
    expect(JSON.stringify(result.instance?.updateState)).not.toContain(
      "provider.json"
    )
    expect(JSON.stringify(result.instance?.updateState)).not.toContain(
      "sk-sensitive"
    )
  })

  it("rejects concurrent updates for the same provider instance", async () => {
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const running = new Promise<void>((resolve) => {
      release = resolve
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          version: "1.0.0",
          adapter: makeAdapter(true),
        },
      ],
      providerMaintenanceCommandRunner: vi.fn(async () => {
        markStarted()
        await running
        return {
          stdout: "updated",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
    })

    const first = hub.updateProviderInstance("codex")
    await started
    await expect(hub.updateProviderInstance("codex")).rejects.toThrow(
      "already running"
    )
    release()
    await first
  })

  it("emits BetterC0de provider status and continuation fields", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude_work",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Work",
          enabled: true,
          continuationKey: "claude:home:/Users/example",
          adapter: makeAdapter(true),
        },
      ],
    })

    const [snapshot] = await hub.listInstances()

    expect(snapshot).toMatchObject({
      instanceId: "claude_work",
      driver: "claude",
      displayName: "Claude Work",
      enabled: true,
      configured: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      availability: "available",
      continuation: { groupKey: "claude:home:/Users/example" },
      continuationKey: "claude:home:/Users/example",
      showInteractionModeToggle: true,
    })
    expect(Date.parse(snapshot?.checkedAt ?? "")).not.toBeNaN()
  })

  it("hydrates provider snapshots from disk cache when live metadata is unavailable", async () => {
    const statusCacheDir = tempDir()
    const firstHub = new ProviderHub({
      statusCacheDir,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableModels: async () => [
              {
                slug: "gpt-5.5",
                name: "GPT 5.5",
                catalog: {
                  providerId: "openai",
                  modelId: "gpt-5.5",
                  status: "active",
                  limit: { context: 400_000 },
                },
              },
            ],
            availableProviderCatalog: async () => [
              {
                id: "openai",
                name: "OpenAI",
                connected: true,
                enabled: true,
                env: [],
                endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
                modelCount: 1,
              },
            ],
            availableSkills: async () => [
              { name: "review", path: "/tmp/review", enabled: true },
            ],
            availableAgents: async () => [
              { name: "build", mode: "primary", hidden: false },
            ],
            availableTools: async () => [
              { id: "bash", displayName: "Bash" },
              { id: "task", displayName: "Task" },
            ],
            availableSlashCommands: async () => [{ name: "compact" }],
          }),
        },
      ],
    })

    await firstHub.listInstances({ cwd: "/repo" })

    const secondHub = new ProviderHub({
      statusCacheDir,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableModels: async () => {
              throw new Error("model scan failed")
            },
            availableProviderCatalog: async () => {
              throw new Error("provider catalog scan failed")
            },
            availableSkills: async () => {
              throw new Error("skill scan failed")
            },
            availableAgents: async () => {
              throw new Error("agent scan failed")
            },
            availableTools: async () => {
              throw new Error("tool scan failed")
            },
            availableSlashCommands: async () => {
              throw new Error("command scan failed")
            },
          }),
        },
      ],
    })

    const [snapshot] = await secondHub.listInstances({ cwd: "/repo" })

    expect(snapshot?.models).toEqual([
      {
        slug: "gpt-5.5",
        name: "GPT 5.5",
        isCustom: false,
        capabilities: null,
        catalog: {
          providerId: "openai",
          modelId: "gpt-5.5",
          status: "active",
          limit: { context: 400_000 },
        },
      },
    ])
    expect(snapshot?.skills).toEqual([
      { name: "review", path: "/tmp/review", enabled: true },
    ])
    expect(snapshot?.providerCatalog).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        connected: true,
        enabled: true,
        env: [],
        endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
        modelCount: 1,
      },
    ])
    expect(snapshot?.agents).toEqual([
      { name: "build", mode: "primary", hidden: false },
    ])
    expect(snapshot?.tools).toEqual([
      { id: "bash", displayName: "Bash" },
      { id: "task", displayName: "Task" },
    ])
    expect(snapshot?.slashCommands).toEqual([{ name: "compact" }])
    expect(snapshot?.configured).toBe(true)
  })

  it("does not hydrate disabled or unavailable provider cache entries", async () => {
    const statusCacheDir = tempDir()
    const firstHub = new ProviderHub({
      statusCacheDir,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            availableModels: async () => [{ slug: "gpt-5.5", name: "GPT 5.5" }],
          }),
        },
      ],
    })
    await firstHub.listInstances()

    const disabledHub = new ProviderHub({
      statusCacheDir,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: false,
          adapter: makeAdapter(true),
        },
      ],
    })
    const unavailableHub = new ProviderHub({
      statusCacheDir,
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          unavailableReason: "Codex CLI missing",
          adapter: makeAdapter(true),
        },
      ],
    })

    const [disabled] = await disabledHub.listInstances()
    const [unavailable] = await unavailableHub.listInstances()

    expect(disabled?.models).toEqual([])
    expect(disabled?.configured).toBe(false)
    expect(disabled?.status).toBe("disabled")
    expect(disabled?.installed).toBe(true)
    expect(disabled?.availability).toBe("available")
    expect(unavailable?.models).toEqual([])
    expect(unavailable?.unavailableReason).toBe(
      "Provider instance is unavailable."
    )
    expect(unavailable?.status).toBe("error")
    expect(unavailable?.installed).toBe(false)
    expect(unavailable?.availability).toBe("unavailable")
  })

  it("lists active provider sessions with authoritative instance bindings", async () => {
    const activeSession: ProviderSession = {
      threadId: "thread-1",
      providerInstanceId: "stale-adapter-id",
      providerThreadId: "sdk-thread-1",
      status: "ready",
      cwd: "/repo",
      activeTurnId: null,
      createdAt: 100,
      updatedAt: 200,
    }
    const listSessions = vi
      .fn<NonNullable<ProviderAdapterShape["listSessions"]>>()
      .mockResolvedValue([activeSession])
    const bindings = {
      get: vi.fn((threadId: string, providerInstanceId: string) =>
        threadId === "thread-1" && providerInstanceId === "claude-work"
          ? {
              threadId: "thread-1",
              providerKind: "claude",
              providerInstanceId: "claude-work",
              providerThreadId: "sdk-thread-1",
              resumeCursor: { sessionId: "sdk-thread-1" },
              continuationKey: "claude:home:/Users/example",
              status: "running",
              activeTurnId: "turn-1",
              lastError: null,
              runtimeMode: "full-access",
              cwd: "/Users/example/project",
              modelSelection: {
                instanceId: "codex-work",
                model: "gpt-5.5",
                options: [{ id: "fastMode", value: true }],
              },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            }
          : null
      ),
      list: vi.fn(() => []),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-work",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Work",
          enabled: true,
          adapter: makeAdapter(true, { listSessions }),
        },
      ],
    })

    const sessions = await hub.listSessions(bindings)

    expect(bindings.get).toHaveBeenCalledWith("thread-1", "claude-work")
    expect(sessions).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-work",
        instanceId: "claude-work",
        driver: "claude",
        displayName: "Claude Work",
        resumeCursor: { sessionId: "sdk-thread-1" },
        continuationKey: "claude:home:/Users/example",
        runtimeMode: "full-access",
        active: true,
        persisted: true,
      }),
    ])
  })

  it("keeps persisted provider bindings visible when no adapter session is active", async () => {
    const bindings = {
      get: vi.fn(() => null),
      list: vi.fn(() => [
        {
          threadId: "thread-2",
          providerKind: "codex",
          providerInstanceId: "codex-work",
          providerThreadId: "codex-thread-2",
          resumeCursor: { providerThreadId: "codex-thread-2" },
          continuationKey: "codex:home:/Users/example/.codex-work",
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          runtimeMode: "full-access",
          cwd: "/Users/example/project",
          modelSelection: {
            instanceId: "codex-work",
            model: "gpt-5.5",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      ]),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, { listSessions: async () => [] }),
        },
      ],
    })

    const sessions = await hub.listSessions(bindings)

    expect(sessions).toEqual([
      expect.objectContaining({
        threadId: "thread-2",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        providerThreadId: "codex-thread-2",
        status: "stopped",
        cwd: "/Users/example/project",
        active: false,
        persisted: true,
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-01-01T00:00:02.000Z"),
      }),
    ])
  })

  it("records provider turn success metrics with provider and model family", async () => {
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn }),
        },
      ],
    })

    await hub.sendTurn("codex", {
      threadId: "thread-1",
      message: "hello",
      modelId: "legacy",
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      history: [],
    })

    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(backendMetrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "counter",
          name: PROVIDER_TURNS_TOTAL,
          attributes: {
            provider: "codex",
            instanceId: "codex",
            modelFamily: "gpt",
            outcome: "success",
          },
          value: 1,
        }),
        expect.objectContaining({
          type: "timer",
          name: PROVIDER_TURN_DURATION_MS,
          attributes: {
            provider: "codex",
            instanceId: "codex",
            modelFamily: "gpt",
          },
          count: 1,
        }),
      ])
    )
  })

  it("recovers and enriches send turns from persisted binding context", async () => {
    const modelSelection = {
      instanceId: "codex-work",
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    }
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "codex-thread-1",
        resumeCursor: { providerThreadId: "codex-thread-1" },
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        providerThreadId: "codex-thread-1",
        resumeCursor: { providerThreadId: "codex-thread-1" },
        continuationKey: "codex:home:/Users/example/.codex",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project",
        modelSelection,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            startSession,
            sendTurn,
            hasSession: () => false,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "codex",
      {
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        message: "continue",
        modelId: "legacy",
        projectPath: null,
        history: [],
      },
      { bindings }
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/Users/example/project",
        modelSelection,
        resumeCursor: { providerThreadId: "codex-thread-1" },
        runtimeMode: "full-access",
      })
    )
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        projectPath: "/Users/example/project",
        modelSelection,
      })
    )
  })

  it("starts first provider sessions with the current model selection context", async () => {
    let active = false
    const modelSelection = {
      instanceId: "claude-main",
      model: "claude-opus-4-7",
      options: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
    }
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => {
        active = true
        return {
          threadId: input.threadId,
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-session-1",
          resumeCursor: { sessionId: "sdk-session-1" },
          continuationKey: "claude:home:/Users/example",
          status: "ready",
          cwd: input.cwd ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: null,
        resumeCursor: null,
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project",
        modelSelection,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      list: vi.fn(() => []),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
      updateRuntimeContext: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => active,
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "claude",
      {
        providerInstanceId: "claude-main",
        threadId: "thread-1",
        message: "first turn",
        modelId: "claude-opus-4-7",
        projectPath: null,
        history: [],
      },
      { bindings }
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/Users/example/project",
        modelSelection,
        resumeCursor: null,
        runtimeMode: "full-access",
      })
    )
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        providerInstanceId: "claude-main",
        projectPath: "/Users/example/project",
        modelSelection,
      })
    )
    expect(bindings.updateRuntimeContext).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      cwd: "/Users/example/project",
      modelSelection,
    })
  })

  it("maps UI permission levels to provider runtime modes before session recovery", async () => {
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "cursor-session-1",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        runtimeMode: input.runtimeMode ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "cursor",
        providerInstanceId: "cursor-main",
        providerThreadId: null,
        resumeCursor: null,
        continuationKey: "cursor:cursor-main",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project",
        modelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      list: vi.fn(() => []),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
      updateRuntimeContext: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "cursor-main",
          driver: "cursor",
          provider: "cursor",
          displayName: "Cursor Main",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "cursor",
      {
        providerInstanceId: "cursor-main",
        threadId: "thread-1",
        message: "inspect",
        modelId: "composer-2",
        permissionLevel: "read-only",
        projectPath: null,
        history: [],
      },
      { bindings }
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        runtimeMode: "read-only",
      })
    )
    expect(bindings.updateRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        providerKind: "cursor",
        providerInstanceId: "cursor-main",
        runtimeMode: "read-only",
      })
    )
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ permissionLevel: "read-only" })
    )
  })

  it("restarts active provider sessions when the requested runtime mode changes", async () => {
    const stopSession = vi.fn(async (_threadId: ThreadId) => {})
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "betterc0de-session-2",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        runtimeMode: input.runtimeMode ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "betterc0de",
        providerInstanceId: "betterc0de-main",
        providerThreadId: "betterc0de-session-1",
        resumeCursor: null,
        continuationKey: "betterc0de:betterc0de-main",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project",
        modelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      list: vi.fn(() => []),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
      updateRuntimeContext: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "betterc0de-main",
          driver: "betterc0de",
          provider: "betterc0de",
          displayName: "BetterC0de compatibility Main",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "betterc0de-session-1",
                status: "ready",
                cwd: "/Users/example/project",
                activeTurnId: null,
                runtimeMode: "full-access",
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession,
            startSession,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "betterc0de",
      {
        providerInstanceId: "betterc0de-main",
        threadId: "thread-1",
        message: "inspect",
        modelId: "openai/gpt-5",
        permissionLevel: "ask-on-edit",
        projectPath: "/Users/example/project",
        history: [],
      },
      { bindings }
    )

    expect(stopSession).toHaveBeenCalledWith("thread-1")
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        runtimeMode: "approval-required",
      })
    )
  })

  it("resumes compatible provider-instance switches from the previous binding", async () => {
    const requestedModelSelection = {
      instanceId: "codex-work",
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    }
    const oldBinding = {
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-thread-1",
      resumeCursor: { providerThreadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex",
      status: "ready",
      activeTurnId: null,
      lastError: null,
      runtimeMode: "full-access",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
    const requestedBinding = {
      ...oldBinding,
      providerInstanceId: "codex-work",
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
      cwd: "/Users/example/worktree",
      modelSelection: requestedModelSelection,
      updatedAt: "2026-01-01T00:00:02.000Z",
    }
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "codex-thread-1",
        resumeCursor: { providerThreadId: "codex-thread-1" },
        continuationKey: "codex:home:/Users/example/.codex",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const stopOldSession = vi.fn(async (_threadId: ThreadId) => {})
    const bindings = {
      get: vi.fn((threadId: string, providerInstanceId: string) =>
        threadId === "thread-1" && providerInstanceId === "codex-work"
          ? requestedBinding
          : null
      ),
      list: vi.fn(() => [oldBinding, requestedBinding]),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: (threadId) => threadId === "thread-1",
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "codex-thread-1",
                status: "ready",
                cwd: "/Users/example/project",
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession: stopOldSession,
          }),
        },
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "codex",
      {
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        message: "continue in work instance",
        modelId: "legacy",
        projectPath: null,
        history: [],
      },
      { bindings }
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/Users/example/worktree",
        modelSelection: requestedModelSelection,
        resumeCursor: { providerThreadId: "codex-thread-1" },
        runtimeMode: "full-access",
      })
    )
    expect(stopOldSession).toHaveBeenCalledWith("thread-1")
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        projectPath: "/Users/example/worktree",
        modelSelection: requestedModelSelection,
      })
    )
    expect(bindings.setProviderThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        providerThreadId: "codex-thread-1",
        resumeCursor: { providerThreadId: "codex-thread-1" },
      })
    )
  })

  it("starts fresh when a persisted binding belongs to another continuation context", async () => {
    const staleBinding = {
      threadId: "thread-1",
      providerKind: "codex" as const,
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-old-home",
      resumeCursor: { providerThreadId: "codex-thread-old-home" },
      continuationKey: "codex:home:/Users/example/.codex",
      status: "stopped" as const,
      activeTurnId: null,
      lastError: null,
      runtimeMode: "full-access",
      cwd: "/Users/example/project",
      modelSelection: { instanceId: "codex-work", model: "gpt-5.5" },
      generation: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "codex-thread-new-home",
        resumeCursor: { providerThreadId: "codex-thread-new-home" },
        continuationKey: "codex:home:/Users/example/.codex-work",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const bindings = {
      get: vi.fn(() => staleBinding),
      list: vi.fn(() => [staleBinding]),
      getThreadGeneration: vi.fn(() => 0),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
      updateRuntimeContext: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex-work",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    await hub.sendTurn(
      "codex",
      {
        providerInstanceId: "codex-work",
        threadId: "thread-1",
        message: "continue after moving the provider home",
        modelId: "gpt-5.5",
        history: [{ role: "user", content: "prior durable message" }],
      },
      { bindings }
    )

    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        resumeCursor: null,
      })
    )
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [{ role: "user", content: "prior durable message" }],
      })
    )
    expect(bindings.setProviderThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "codex-thread-new-home",
        continuationKey: "codex:home:/Users/example/.codex-work",
      })
    )
  })

  it("switches from a stopped persisted provider binding and preserves durable history", async () => {
    const db = openDatabase(path.join(tempDir(), "provider-switch.sqlite"))
    runMigrations(db)
    insertProviderHubTestThread(db, "thread-1")
    const bindings = new ProviderSessionBindingStore(db)
    const events: ProviderRuntimeEvent[] = []
    const history = [
      { role: "user" as const, content: "question answered by codex" },
      { role: "assistant" as const, content: "previous codex answer" },
    ]
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-thread-1",
      resumeCursor: { providerThreadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex",
    })
    bindings.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      cwd: "/Users/example/project",
      runtimeMode: "full-access",
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    })
    bindings.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      status: "stopped",
      activeTurnId: null,
    })
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "claude-thread-1",
        resumeCursor: { sessionId: "claude-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          continuationKey: "claude:home:/Users/example",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { startSession, sendTurn }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    try {
      await hub.sendTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "continue with claude",
          modelId: "claude-opus-4-7",
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
          },
          projectPath: null,
          history,
        },
        { bindings }
      )

      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          cwd: "/Users/example/project",
          resumeCursor: null,
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
          },
        })
      )
      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          projectPath: "/Users/example/project",
          history,
        })
      )
      expect(bindings.getThreadGeneration("thread-1")).toBe(1)
      expect(bindings.get("thread-1", "codex")).toMatchObject({
        status: "stopped",
        providerThreadId: null,
        resumeCursor: null,
        continuationKey: null,
        generation: 1,
      })
      expect(bindings.get("thread-1", "claude-main")).toMatchObject({
        status: "ready",
        providerThreadId: "claude-thread-1",
        resumeCursor: { sessionId: "claude-thread-1" },
        generation: 1,
      })
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "runtime.error" })
      )
    } finally {
      db.close()
    }
  })

  it("stops a live previous provider before starting the selected provider", async () => {
    const db = openDatabase(path.join(tempDir(), "provider-live-switch.sqlite"))
    runMigrations(db)
    insertProviderHubTestThread(db, "thread-1")
    const bindings = new ProviderSessionBindingStore(db)
    const events: ProviderRuntimeEvent[] = []
    let oldSessionActive = true
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-thread-1",
      resumeCursor: { providerThreadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex",
    })
    bindings.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      cwd: "/Users/example/project",
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    })
    const stopOldSession = vi.fn(async (_threadId: ThreadId) => {
      oldSessionActive = false
    })
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "claude-thread-1",
        resumeCursor: { sessionId: "claude-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => oldSessionActive,
            listSessions: async () =>
              oldSessionActive
                ? [
                    {
                      threadId: "thread-1",
                      providerThreadId: "codex-thread-1",
                      resumeCursor: {
                        providerThreadId: "codex-thread-1",
                      },
                      continuationKey: "codex:home:/Users/example/.codex",
                      status: "ready",
                      cwd: "/Users/example/project",
                      activeTurnId: null,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  ]
                : [],
            stopSession: stopOldSession,
          }),
        },
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          continuationKey: "claude:home:/Users/example",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { startSession, sendTurn }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    try {
      await hub.sendTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "continue with claude",
          modelId: "claude-opus-4-7",
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
          },
          projectPath: "/Users/example/project",
          history: [{ role: "user", content: "durable context" }],
        },
        { bindings }
      )

      expect(stopOldSession).toHaveBeenCalledWith("thread-1")
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          resumeCursor: null,
        })
      )
      expect(stopOldSession.mock.invocationCallOrder[0]).toBeLessThan(
        startSession.mock.invocationCallOrder[0] ?? 0
      )
      expect(startSession.mock.invocationCallOrder[0]).toBeLessThan(
        sendTurn.mock.invocationCallOrder[0] ?? 0
      )
      const oldExitIndex = events.findIndex(
        (event) =>
          event.type === "session.exited" &&
          event.providerInstanceId === "codex"
      )
      const targetStartIndex = events.findIndex(
        (event) =>
          event.type === "session.started" &&
          event.providerInstanceId === "claude-main"
      )
      expect(oldExitIndex).toBeGreaterThanOrEqual(0)
      expect(targetStartIndex).toBeGreaterThan(oldExitIndex)
      expect(bindings.get("thread-1", "codex")).toMatchObject({
        status: "stopped",
        providerThreadId: null,
        resumeCursor: null,
        generation: 1,
      })
      expect(bindings.get("thread-1", "claude-main")).toMatchObject({
        status: "ready",
        providerThreadId: "claude-thread-1",
        generation: 1,
      })
    } finally {
      db.close()
    }
  })

  it("fails provider switching closed when the previous session cannot be stopped", async () => {
    const db = openDatabase(
      path.join(tempDir(), "provider-switch-failure.sqlite")
    )
    runMigrations(db)
    insertProviderHubTestThread(db, "thread-1")
    const bindings = new ProviderSessionBindingStore(db)
    const events: ProviderRuntimeEvent[] = []
    bindings.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-thread-1",
      resumeCursor: { providerThreadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex",
    })
    const stopOldSession = vi.fn(async (_threadId: ThreadId) => {
      throw new Error("private provider shutdown detail")
    })
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerThreadId: "claude-thread-1",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    )
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "codex-thread-1",
                resumeCursor: { providerThreadId: "codex-thread-1" },
                status: "ready",
                cwd: "/Users/example/project",
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession: stopOldSession,
          }),
        },
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, { startSession, sendTurn }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    try {
      const failure = await hub
        .sendTurn(
          "claude",
          {
            providerInstanceId: "claude-main",
            threadId: "thread-1",
            message: "continue with claude",
            modelId: "claude-opus-4-7",
            history: [],
          },
          { bindings }
        )
        .catch((error) => error)

      expect(failure).toBeInstanceOf(ProviderStaleSessionCleanupError)
      expect(failure).toMatchObject({
        code: "provider_stale_session_cleanup_failed",
        statusCode: 503,
        instanceId: "codex",
      })
      expect(startSession).not.toHaveBeenCalled()
      expect(sendTurn).not.toHaveBeenCalled()
      expect(bindings.getThreadGeneration("thread-1")).toBe(0)
      expect(bindings.get("thread-1", "codex")).toMatchObject({
        status: "ready",
        providerThreadId: "codex-thread-1",
        resumeCursor: { providerThreadId: "codex-thread-1" },
        continuationKey: "codex:home:/Users/example/.codex",
        generation: 0,
      })
      expect(bindings.get("thread-1", "claude-main")).toBeNull()
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "runtime.error",
          threadId: "thread-1",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          message: "Provider session cleanup could not be completed.",
        })
      )
      expect(
        events.some(
          (event) =>
            event.type === "runtime.error" &&
            event.message?.includes("private provider shutdown detail") === true
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it("starts fresh across A to B to A switches without restarting unchanged B turns", async () => {
    const db = openDatabase(path.join(tempDir(), "provider-roundtrip.sqlite"))
    runMigrations(db)
    insertProviderHubTestThread(db, "thread-1")
    const bindings = new ProviderSessionBindingStore(db)
    let codexStartCount = 0
    let claudeStartCount = 0
    const codexStart = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => {
        codexStartCount += 1
        return {
          threadId: input.threadId,
          providerThreadId: `codex-thread-${codexStartCount}`,
          resumeCursor: {
            providerThreadId: `codex-thread-${codexStartCount}`,
          },
          continuationKey: "codex:home:/Users/example/.codex",
          status: "ready",
          cwd: input.cwd ?? null,
          runtimeMode: input.runtimeMode ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    )
    const claudeStart = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => {
        claudeStartCount += 1
        return {
          threadId: input.threadId,
          providerThreadId: `claude-thread-${claudeStartCount}`,
          resumeCursor: {
            sessionId: `claude-thread-${claudeStartCount}`,
          },
          continuationKey: "claude:home:/Users/example",
          status: "ready",
          cwd: input.cwd ?? null,
          runtimeMode: input.runtimeMode ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    )
    const codexStop = vi.fn(async (_threadId: ThreadId) => {})
    const claudeStop = vi.fn(async (_threadId: ThreadId) => {})
    let emitCodex!: (event: ProviderRuntimeEvent) => void
    let emitClaude!: (event: ProviderRuntimeEvent) => void
    let runtimeEventSequence = 0
    const codexSend = vi.fn(async (input: ProviderSendTurnInput) => {
      runtimeEventSequence += 1
      const turnId = `codex-turn-${runtimeEventSequence}`
      emitCodex({
        type: "turn.started",
        threadId: input.threadId,
        turnId,
        eventId: `${turnId}-started`,
        at: runtimeEventSequence,
      })
      emitCodex({
        type: "turn.completed",
        threadId: input.threadId,
        turnId,
        status: "completed",
        eventId: `${turnId}-completed`,
        at: runtimeEventSequence,
      })
    })
    const claudeSend = vi.fn(async (input: ProviderSendTurnInput) => {
      runtimeEventSequence += 1
      const turnId = `claude-turn-${runtimeEventSequence}`
      emitClaude({
        type: "turn.started",
        threadId: input.threadId,
        turnId,
        eventId: `${turnId}-started`,
        at: runtimeEventSequence,
      })
      emitClaude({
        type: "turn.completed",
        threadId: input.threadId,
        turnId,
        status: "completed",
        eventId: `${turnId}-completed`,
        at: runtimeEventSequence,
      })
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex",
          displayName: "Codex",
          enabled: true,
          adapter: makeAdapter(true, {
            startSession: codexStart,
            stopSession: codexStop,
            sendTurn: codexSend,
            onSubscribe: (emit) => {
              emitCodex = emit
            },
          }),
        },
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          continuationKey: "claude:home:/Users/example",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            startSession: claudeStart,
            stopSession: claudeStop,
            sendTurn: claudeSend,
            onSubscribe: (emit) => {
              emitClaude = emit
            },
          }),
        },
      ],
    })
    const afterCodex = [
      { role: "user" as const, content: "ask codex" },
      { role: "assistant" as const, content: "codex answer" },
    ]
    const afterClaude = [
      ...afterCodex,
      { role: "user" as const, content: "ask claude" },
      { role: "assistant" as const, content: "claude answer" },
    ]

    try {
      const firstCodexTurn = hub.startTurn(
        "codex",
        {
          providerInstanceId: "codex",
          threadId: "thread-1",
          message: "ask codex",
          modelId: "gpt-5.5",
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          projectPath: "/Users/example/project",
          history: [],
        },
        { bindings }
      )
      await firstCodexTurn.completion
      await firstCodexTurn.settled
      const firstClaudeTurn = hub.startTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "ask claude",
          modelId: "claude-opus-4-7",
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
          },
          projectPath: "/Users/example/project",
          history: afterCodex,
        },
        { bindings }
      )
      await firstClaudeTurn.completion
      await firstClaudeTurn.settled

      expect(bindings.getThreadGeneration("thread-1")).toBe(1)
      const unchangedClaudeTurn = hub.startTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "same provider follow-up",
          modelId: "claude-opus-4-7",
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
          },
          projectPath: "/Users/example/project",
          history: afterClaude,
        },
        { bindings }
      )
      await unchangedClaudeTurn.completion
      await unchangedClaudeTurn.settled

      expect(claudeStart).toHaveBeenCalledTimes(1)
      expect(codexStop).toHaveBeenCalledTimes(1)
      expect(bindings.getThreadGeneration("thread-1")).toBe(1)

      const returnedCodexTurn = hub.startTurn(
        "codex",
        {
          providerInstanceId: "codex",
          threadId: "thread-1",
          message: "return to codex",
          modelId: "gpt-5.5",
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          projectPath: "/Users/example/project",
          history: afterClaude,
        },
        { bindings }
      )
      await returnedCodexTurn.completion
      await returnedCodexTurn.settled

      expect(codexStart).toHaveBeenCalledTimes(2)
      expect(codexStart).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          threadId: "thread-1",
          resumeCursor: null,
        })
      )
      expect(claudeStop).toHaveBeenCalledTimes(1)
      expect(codexSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ history: afterClaude })
      )
      expect(claudeSend).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ history: afterCodex })
      )
      expect(bindings.getThreadGeneration("thread-1")).toBe(2)
      expect(bindings.get("thread-1", "claude-main")).toMatchObject({
        status: "stopped",
        providerThreadId: null,
        resumeCursor: null,
        continuationKey: null,
        generation: 2,
      })
      expect(bindings.get("thread-1", "codex")).toMatchObject({
        status: "ready",
        providerThreadId: "codex-thread-2",
        resumeCursor: { providerThreadId: "codex-thread-2" },
        generation: 2,
      })
    } finally {
      db.close()
    }
  })

  it.each([
    {
      reason: "workspace",
      cwd: "/Users/example/project-worktree",
      refresh: false,
    },
    {
      reason: "orchestration tools",
      cwd: "/Users/example/project",
      refresh: true,
    },
  ])(
    "restarts with the resume cursor when $reason changes",
    async ({ cwd, refresh }) => {
      const modelSelection = {
        instanceId: "claude-main",
        model: "claude-opus-4-7",
        options: [{ id: "effort", value: "max" }],
      }
      const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
        async (input) => ({
          threadId: input.threadId,
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-session-1",
          resumeCursor: { sessionId: "sdk-session-1" },
          continuationKey: "claude:home:/Users/example",
          status: "ready",
          cwd: input.cwd ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      )
      const stopSession = vi.fn(async (_threadId: ThreadId) => {})
      const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
      const bindings = {
        get: vi.fn(() => ({
          threadId: "thread-1",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-session-1",
          resumeCursor: { sessionId: "sdk-session-1" },
          continuationKey: "claude:home:/Users/example",
          status: "ready",
          activeTurnId: null,
          lastError: null,
          runtimeMode: "full-access",
          cwd,
          modelSelection,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        })),
        list: vi.fn(() => []),
        setProviderThreadId: vi.fn(),
        updateSessionLifecycle: vi.fn(),
      } as unknown as ProviderSessionBindingStore
      const hub = new ProviderHub({
        instances: [
          {
            instanceId: "claude-main",
            driver: "claude",
            provider: "claude",
            continuationKey: "claude:home:/Users/example",
            displayName: "Claude Main",
            enabled: true,
            adapter: makeAdapter(true, {
              hasSession: () => true,
              needsSessionConfigurationRefresh: async () => refresh,
              listSessions: async () => [
                {
                  threadId: "thread-1",
                  providerInstanceId: "claude-main",
                  providerThreadId: "sdk-session-1",
                  resumeCursor: { sessionId: "sdk-session-1" },
                  continuationKey: "claude:home:/Users/example",
                  status: "ready",
                  cwd: "/Users/example/project",
                  activeTurnId: null,
                  createdAt: 100,
                  updatedAt: 200,
                },
              ],
              stopSession,
              startSession,
              sendTurn,
            }),
          },
        ],
      })

      await hub.sendTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "continue in worktree",
          modelId: "claude-opus-4-7",
          projectPath: null,
          history: [],
        },
        { bindings }
      )

      expect(stopSession).toHaveBeenCalledWith("thread-1")
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          cwd,
          modelSelection,
          resumeCursor: { sessionId: "sdk-session-1" },
        })
      )
      expect(sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          providerInstanceId: "claude-main",
          projectPath: cwd,
          modelSelection,
        })
      )
    }
  )

  it("restores the previous active session when a workspace restart fails", async () => {
    const events: ProviderRuntimeEvent[] = []
    const startSession = vi
      .fn<ProviderAdapterShape["startSession"]>()
      .mockRejectedValueOnce(new Error("cannot start in requested cwd"))
      .mockResolvedValueOnce({
        threadId: "thread-1",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-session-1",
        resumeCursor: { sessionId: "sdk-session-1" },
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        cwd: "/Users/example/project",
        activeTurnId: null,
        createdAt: 100,
        updatedAt: 300,
      })
    const stopSession = vi.fn(async (_threadId: ThreadId) => {})
    const sendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-session-1",
        resumeCursor: { sessionId: "sdk-session-1" },
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project-worktree",
        modelSelection: {
          instanceId: "claude-main",
          model: "claude-opus-4-7",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      })),
      list: vi.fn(() => []),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerInstanceId: "claude-main",
                providerThreadId: "sdk-session-1",
                resumeCursor: { sessionId: "sdk-session-1" },
                continuationKey: "claude:home:/Users/example",
                status: "ready",
                cwd: "/Users/example/project",
                activeTurnId: null,
                createdAt: 100,
                updatedAt: 200,
              },
            ],
            stopSession,
            startSession,
            sendTurn,
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await expect(
      hub.sendTurn(
        "claude",
        {
          providerInstanceId: "claude-main",
          threadId: "thread-1",
          message: "continue in worktree",
          modelId: "claude-opus-4-7",
          projectPath: null,
          history: [],
        },
        { bindings }
      )
    ).rejects.toThrow("cannot start in requested cwd")

    expect(stopSession).toHaveBeenCalledWith("thread-1")
    expect(startSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/Users/example/project-worktree",
      })
    )
    expect(startSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/Users/example/project",
        resumeCursor: { sessionId: "sdk-session-1" },
      })
    )
    expect(sendTurn).not.toHaveBeenCalled()
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        providerInstanceId: "claude-main",
      })
    )
  })

  it("stops stale sessions on other provider instances before dispatching a turn", async () => {
    const events: ProviderRuntimeEvent[] = []
    const staleStopSession = vi.fn(async (_threadId: ThreadId) => {})
    const currentSendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const staleHasSession = vi.fn(
      (threadId: ThreadId) => threadId === "thread-1"
    )
    const currentHasSession = vi.fn(() => true)
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: currentSendTurn,
            hasSession: currentHasSession,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "claude-current-thread",
                status: "ready",
                cwd: null,
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        },
        {
          instanceId: "claude-old",
          driver: "claude",
          provider: "claude",
          displayName: "Claude Old",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: staleHasSession,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "claude-old-thread",
                status: "ready",
                cwd: null,
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession: staleStopSession,
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await hub.sendTurn("claude", {
      providerInstanceId: "claude-main",
      threadId: "thread-1",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })

    // The Hub now establishes/reuses the target session before sendTurn even
    // without a binding store, so adapter-side auto-start cannot bypass
    // centralized session admission.
    expect(currentHasSession).toHaveBeenCalledWith("thread-1")
    expect(staleHasSession).toHaveBeenCalledWith("thread-1")
    expect(staleStopSession).toHaveBeenCalledWith("thread-1")
    expect(currentSendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        providerInstanceId: "claude-main",
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-old",
      })
    )
  })

  it("does not release a default-instance admission for another instance's session exit", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: makeAdapter(true, {
            sendTurn: vi.fn(async () => {}),
            hasSession: vi.fn(() => false),
          }),
        },
        {
          instanceId: "claude-old",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: vi.fn((threadId) => threadId === "thread-default"),
            listSessions: async () => [
              {
                threadId: "thread-default",
                providerThreadId: "claude-old-thread",
                status: "ready",
                cwd: null,
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession: vi.fn(async () => {}),
          }),
        },
      ],
    })

    const first = hub.startTurn("claude", {
      threadId: "thread-default",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    await first.completion

    expect(() =>
      hub.startTurn("claude", {
        threadId: "thread-default",
        message: "overlap",
        modelId: "claude-opus-4-7",
        history: [],
      })
    ).toThrow(ProviderTurnConflictError)
  })

  it("fails a new turn closed when stale session cleanup fails", async () => {
    const staleStopSession = vi.fn(async (_threadId: ThreadId) => {
      throw new Error("already gone")
    })
    const currentSendTurn = vi.fn(async (_input: ProviderSendTurnInput) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, { sendTurn: currentSendTurn }),
        },
        {
          instanceId: "codex-old",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Old",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "codex-old-thread",
                status: "ready",
                cwd: null,
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            stopSession: staleStopSession,
          }),
        },
      ],
    })

    const rejected = hub.startTurn("codex", {
      providerInstanceId: "codex-work",
      threadId: "thread-1",
      message: "hello",
      modelId: "gpt-5.5",
      history: [],
    })

    const cleanupFailure = await rejected.completion.catch((error) => error)
    expect(cleanupFailure).toBeInstanceOf(ProviderStaleSessionCleanupError)
    expect(cleanupFailure).toMatchObject({
      code: "provider_stale_session_cleanup_failed",
      statusCode: 503,
      instanceId: "codex-old",
    })
    expect(cleanupFailure.message).not.toContain("already gone")
    expect(staleStopSession).toHaveBeenCalledWith("thread-1")
    expect(currentSendTurn).not.toHaveBeenCalled()
  })

  it("emits a lifecycle event when stopping a selected provider session", async () => {
    const events: ProviderRuntimeEvent[] = []
    const stopSession = vi.fn(async (_threadId: ThreadId) => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, { stopSession }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await hub.stopSession("codex", "thread-1" as ThreadId, "codex-work")

    expect(stopSession).toHaveBeenCalledWith("thread-1")
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.exited",
        threadId: "thread-1",
        providerKind: "codex",
        providerInstanceId: "codex-work",
        payload: expect.objectContaining({
          reason: "provider.stopSession",
          exitKind: "graceful",
        }),
      })
    )
  })

  it("records provider turn failure metrics", async () => {
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude",
          driver: "claude",
          provider: "claude",
          displayName: "Claude",
          enabled: true,
          adapter: makeAdapter(false),
        },
      ],
    })

    await expect(
      hub.sendTurn("claude", {
        threadId: "thread-1",
        message: "hello",
        modelId: "claude-opus-4-7",
        history: [],
      })
    ).rejects.toThrow("Provider instance is not configured.")

    expect(backendMetrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "counter",
          name: PROVIDER_TURNS_TOTAL,
          attributes: {
            provider: "claude",
            modelFamily: "claude",
            outcome: "failure",
          },
          value: 1,
        }),
      ])
    )
  })

  it("forwards provider conversation rollback to the selected instance", async () => {
    const rollbackThread = vi.fn<
      NonNullable<ProviderAdapterShape["rollbackThread"]>
    >(async () => {})
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [
              {
                threadId: "thread-1",
                providerThreadId: "codex-thread-1",
                status: "ready",
                cwd: null,
                activeTurnId: null,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            rollbackThread,
          }),
        },
      ],
    })

    await expect(
      hub.rollbackConversation("codex", "thread-1" as ThreadId, 1, "codex-work")
    ).resolves.toBe(true)

    expect(rollbackThread).toHaveBeenCalledWith("thread-1", 1)
  })

  it("recovers a persisted provider session before rollback when no active runtime exists", async () => {
    const events: ProviderRuntimeEvent[] = []
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerInstanceId: "codex-work",
        providerThreadId: "codex-thread-1",
        resumeCursor: { threadId: "codex-thread-1" },
        continuationKey: "codex:home:/Users/example/.codex-work",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: 100,
        updatedAt: 200,
      })
    )
    const rollbackThread = vi.fn<
      NonNullable<ProviderAdapterShape["rollbackThread"]>
    >(async () => {})
    const bindings = {
      get: vi.fn((threadId: string, providerInstanceId: string) =>
        threadId === "thread-1" && providerInstanceId === "codex-work"
          ? {
              threadId: "thread-1",
              providerKind: "codex",
              providerInstanceId: "codex-work",
              providerThreadId: "codex-thread-1",
              resumeCursor: { threadId: "codex-thread-1" },
              continuationKey: "codex:home:/Users/example/.codex-work",
              status: "stopped",
              activeTurnId: null,
              lastError: null,
              runtimeMode: "full-access",
              cwd: "/Users/example/project",
              modelSelection: {
                instanceId: "codex-work",
                model: "gpt-5.5",
                options: [{ id: "fastMode", value: true }],
              },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            }
          : null
      ),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex",
          continuationKey: "codex:home:/Users/example/.codex-work",
          displayName: "Codex Work",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            startSession,
            rollbackThread,
          }),
        },
      ],
    })
    hub.subscribe((event) => events.push(event))

    await expect(
      hub.rollbackConversation(
        "codex",
        "thread-1" as ThreadId,
        1,
        "codex-work",
        bindings
      )
    ).resolves.toBe(true)

    expect(startSession).toHaveBeenCalledWith({
      threadId: "thread-1",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [{ id: "fastMode", value: true }],
      },
      resumeCursor: { threadId: "codex-thread-1" },
      runtimeMode: "full-access",
    })
    expect(bindings.setProviderThreadId).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-1",
      resumeCursor: { threadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex-work",
    })
    expect(bindings.updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      status: "ready",
      activeTurnId: null,
    })
    expect(rollbackThread).toHaveBeenCalledWith("thread-1", 1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.started",
        threadId: "thread-1",
        providerKind: "codex",
        providerInstanceId: "codex-work",
      })
    )
  })

  it("recovers a persisted provider session before responding to a pending request", async () => {
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => ({
        threadId: input.threadId,
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: { sessionId: "sdk-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: 100,
        updatedAt: 200,
      })
    )
    const respondToRequest = vi.fn<ProviderAdapterShape["respondToRequest"]>(
      async () => {}
    )
    const bindings = {
      get: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: { sessionId: "sdk-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "stopped",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        cwd: "/Users/example/project",
        modelSelection: {
          instanceId: "claude-main",
          model: "claude-opus-4-7",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      })),
      setProviderThreadId: vi.fn(),
      updateSessionLifecycle: vi.fn(),
    } as unknown as ProviderSessionBindingStore
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          continuationKey: "claude:home:/Users/example",
          displayName: "Claude Main",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            startSession,
            respondToRequest,
          }),
        },
      ],
    })

    await hub.respondToRequest(
      "claude",
      "thread-1" as ThreadId,
      "approval-1" as ApprovalRequestId,
      { kind: "tool_approval", decision: "approve" },
      "claude-main",
      bindings
    )

    expect(startSession).toHaveBeenCalledWith({
      threadId: "thread-1",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "claude-main",
        model: "claude-opus-4-7",
      },
      resumeCursor: { sessionId: "sdk-thread-1" },
      runtimeMode: "full-access",
    })
    expect(respondToRequest).toHaveBeenCalledWith("thread-1", "approval-1", {
      kind: "tool_approval",
      decision: "approve",
    })
    expect(bindings.updateSessionLifecycle).toHaveBeenCalledWith({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      status: "ready",
      activeTurnId: null,
    })
  })

  it("enforces the active-turn cap globally before reserving another turn", async () => {
    const codexAdapter = makeAdapter(true)
    const claudeAdapter = makeAdapter(true)
    const hub = new ProviderHub({
      maxActiveTurns: 1,
      maxActiveTurnsPerProvider: 4,
      maxActiveTurnsPerInstance: 4,
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: codexAdapter,
        },
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: claudeAdapter,
        },
      ],
    })

    const first = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "turn-cap-global-1",
      message: "one",
      modelId: "gpt-5",
      history: [],
    })
    await first.completion

    expect(() =>
      hub.assertCanStartTurn("claude", "turn-cap-global-2", "claude-main")
    ).toThrow(ProviderTurnCapacityError)
    expect(() =>
      hub.startTurn("claude", {
        providerInstanceId: "claude-main",
        threadId: "turn-cap-global-2",
        message: "two",
        modelId: "claude-opus",
        history: [],
      })
    ).toThrow(
      expect.objectContaining({
        code: "provider_turn_capacity",
        scope: "global",
        statusCode: 503,
      })
    )
  })

  it("enforces active-turn caps across provider instances and shared adapters", async () => {
    const providerHub = new ProviderHub({
      maxActiveTurns: 8,
      maxActiveTurnsPerProvider: 1,
      maxActiveTurnsPerInstance: 8,
      instances: [
        {
          instanceId: "codex-a",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true),
        },
        {
          instanceId: "codex-b",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true),
        },
      ],
    })
    await providerHub.startTurn("codex", {
      providerInstanceId: "codex-a",
      threadId: "turn-cap-provider-1",
      message: "one",
      modelId: "gpt-5",
      history: [],
    }).completion

    expect(() =>
      providerHub.startTurn("codex", {
        providerInstanceId: "codex-b",
        threadId: "turn-cap-provider-2",
        message: "two",
        modelId: "gpt-5",
        history: [],
      })
    ).toThrow(
      expect.objectContaining({
        scope: "provider",
        statusCode: 503,
      })
    )

    const sharedAdapter = makeAdapter(true)
    const instanceHub = new ProviderHub({
      maxActiveTurns: 8,
      maxActiveTurnsPerProvider: 8,
      maxActiveTurnsPerInstance: 1,
      instances: [
        {
          instanceId: "codex-alias-a",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: sharedAdapter,
        },
        {
          instanceId: "codex-alias-b",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: sharedAdapter,
        },
      ],
    })
    await instanceHub.startTurn("codex", {
      providerInstanceId: "codex-alias-a",
      threadId: "turn-cap-instance-1",
      message: "one",
      modelId: "gpt-5",
      history: [],
    }).completion

    expect(() =>
      instanceHub.startTurn("codex", {
        providerInstanceId: "codex-alias-b",
        threadId: "turn-cap-instance-2",
        message: "two",
        modelId: "gpt-5",
        history: [],
      })
    ).toThrow(
      expect.objectContaining({
        scope: "instance",
        statusCode: 503,
      })
    )
  })

  it("blocks a new session when the global live-session cap is exhausted", async () => {
    const existingSession: ProviderSession = {
      threadId: "live-global-existing",
      providerThreadId: "native-existing",
      status: "ready",
      cwd: null,
      activeTurnId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>()
    const sendTurn = vi.fn<ProviderAdapterShape["sendTurn"]>()
    const hub = new ProviderHub({
      maxLiveSessions: 1,
      maxLiveSessionsPerInstance: 4,
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: (threadId) => threadId === existingSession.threadId,
            listSessions: async () => [existingSession],
          }),
        },
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            listSessions: async () => [],
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    const rejected = hub.startTurn("claude", {
      providerInstanceId: "claude-main",
      threadId: "live-global-new",
      message: "new",
      modelId: "claude-opus",
      history: [],
    })

    await expect(rejected.completion).rejects.toBeInstanceOf(
      ProviderSessionCapacityError
    )
    await expect(rejected.completion).rejects.toMatchObject({
      code: "provider_session_capacity",
      scope: "global",
      statusCode: 503,
    })
    expect(startSession).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it("counts a shared adapter once and enforces its live-session cap across aliases", async () => {
    const existingSession: ProviderSession = {
      threadId: "live-instance-existing",
      providerThreadId: "native-existing",
      status: "ready",
      cwd: null,
      activeTurnId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const listSessions = vi
      .fn<NonNullable<ProviderAdapterShape["listSessions"]>>()
      .mockResolvedValue([existingSession])
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>()
    const sharedAdapter = makeAdapter(true, {
      hasSession: (threadId) => threadId === existingSession.threadId,
      listSessions,
      startSession,
    })
    const hub = new ProviderHub({
      maxLiveSessions: 8,
      maxLiveSessionsPerInstance: 1,
      instances: [
        {
          instanceId: "codex-alias-a",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: sharedAdapter,
        },
        {
          instanceId: "codex-alias-b",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: sharedAdapter,
        },
      ],
    })

    const rejected = hub.startTurn("codex", {
      providerInstanceId: "codex-alias-b",
      threadId: "live-instance-new",
      message: "new",
      modelId: "gpt-5",
      history: [],
    })

    await expect(rejected.completion).rejects.toMatchObject({
      code: "provider_session_capacity",
      scope: "instance",
      statusCode: 503,
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(startSession).not.toHaveBeenCalled()
  })

  it("allows an existing session to continue when session capacity is full", async () => {
    const existingSession: ProviderSession = {
      threadId: "live-existing-thread",
      providerThreadId: "native-existing",
      status: "ready",
      cwd: "/repo",
      activeTurnId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>()
    const sendTurn = vi.fn<ProviderAdapterShape["sendTurn"]>()
    const hub = new ProviderHub({
      maxLiveSessions: 1,
      maxLiveSessionsPerInstance: 1,
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: (threadId) => threadId === existingSession.threadId,
            listSessions: async () => [existingSession],
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    await hub.sendTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: existingSession.threadId,
      message: "continue",
      modelId: "gpt-5",
      projectPath: "/repo",
      history: [],
    })

    expect(startSession).not.toHaveBeenCalled()
    expect(sendTurn).toHaveBeenCalledTimes(1)
  })

  it("serializes concurrent session admission so only one caller can take the last slot", async () => {
    const sessions = new Map<string, ProviderSession>()
    let resolveFirstStart!: () => void
    const firstStartGate = new Promise<void>((resolve) => {
      resolveFirstStart = resolve
    })
    let signalFirstStart!: () => void
    const firstStartEntered = new Promise<void>((resolve) => {
      signalFirstStart = resolve
    })
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>(
      async (input) => {
        if (input.threadId === "session-race-1") {
          signalFirstStart()
          await firstStartGate
        }
        const session: ProviderSession = {
          threadId: input.threadId,
          providerThreadId: `native-${input.threadId}`,
          status: "ready",
          cwd: input.cwd ?? null,
          activeTurnId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        sessions.set(input.threadId, session)
        return session
      }
    )
    const adapter = makeAdapter(true, {
      hasSession: (threadId) => sessions.has(threadId),
      listSessions: async () => [...sessions.values()],
      startSession,
    })
    const hub = new ProviderHub({
      maxActiveTurns: 4,
      maxActiveTurnsPerProvider: 4,
      maxActiveTurnsPerInstance: 4,
      maxLiveSessions: 1,
      maxLiveSessionsPerInstance: 1,
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter,
        },
      ],
    })

    const first = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "session-race-1",
      message: "one",
      modelId: "gpt-5",
      history: [],
    })
    await firstStartEntered
    const second = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "session-race-2",
      message: "two",
      modelId: "gpt-5",
      history: [],
    })

    resolveFirstStart()
    await first.completion
    await expect(second.completion).rejects.toMatchObject({
      code: "provider_session_capacity",
      scope: "global",
      statusCode: 503,
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    expect([...sessions.keys()]).toEqual(["session-race-1"])
  })

  it("fails session creation closed when an adapter cannot enumerate sessions", async () => {
    const startSession = vi.fn<ProviderAdapterShape["startSession"]>()
    const sendTurn = vi.fn<ProviderAdapterShape["sendTurn"]>()
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => false,
            listSessions: async () => {
              throw new Error("native session registry unavailable")
            },
            startSession,
            sendTurn,
          }),
        },
      ],
    })

    const rejected = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "session-inspection-failure",
      message: "new",
      modelId: "gpt-5",
      history: [],
    })

    await expect(rejected.completion).rejects.toBeInstanceOf(
      ProviderSessionInspectionError
    )
    await expect(rejected.completion).rejects.toMatchObject({
      code: "provider_session_inspection_failed",
      statusCode: 503,
    })
    expect(startSession).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it("fails closed when hasSession and listSessions disagree about an existing thread", async () => {
    const sendTurn = vi.fn<ProviderAdapterShape["sendTurn"]>()
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter: makeAdapter(true, {
            hasSession: () => true,
            listSessions: async () => [],
            sendTurn,
          }),
        },
      ],
    })

    const rejected = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "inconsistent-existing-session",
      message: "continue",
      modelId: "gpt-5",
      history: [],
    })

    await expect(rejected.completion).rejects.toBeInstanceOf(
      ProviderSessionInspectionError
    )
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it("fails closed when a completed startSession is not visible to adapter inspection", async () => {
    const sendTurn = vi.fn<ProviderAdapterShape["sendTurn"]>()
    const base = makeAdapter(true, { sendTurn })
    const adapter: ProviderAdapterShape = {
      ...base,
      hasSession: () => false,
      listSessions: async () => [],
      startSession: async (input) => ({
        threadId: input.threadId,
        providerThreadId: "untracked-native-session",
        status: "ready",
        cwd: null,
        activeTurnId: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    }
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter,
        },
      ],
    })

    const rejected = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "invisible-started-session",
      message: "new",
      modelId: "gpt-5",
      history: [],
    })

    await expect(rejected.completion).rejects.toMatchObject({
      code: "provider_session_inspection_failed",
      statusCode: 503,
    })
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it("starts a guarded session before sendTurn without a binding store", async () => {
    const order: string[] = []
    const sessions = new Map<string, ProviderSession>()
    const adapter = makeAdapter(true, {
      hasSession: (threadId) => sessions.has(threadId),
      listSessions: async () => [...sessions.values()],
      startSession: async (input) => {
        order.push("startSession")
        const session: ProviderSession = {
          threadId: input.threadId,
          providerThreadId: `native-${input.threadId}`,
          status: "ready",
          cwd: input.cwd ?? null,
          activeTurnId: null,
          createdAt: 1,
          updatedAt: 1,
        }
        sessions.set(input.threadId, session)
        return session
      },
      sendTurn: async () => {
        order.push("sendTurn")
      },
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter,
        },
      ],
    })

    await hub.sendTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "guarded-no-bindings",
      message: "new",
      modelId: "gpt-5",
      history: [],
    })

    expect(order).toEqual(["startSession", "sendTurn"])
  })

  it("rejects queued session admission promptly when shutdown begins", async () => {
    let releaseFirstStart!: () => void
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })
    let signalFirstStart!: () => void
    const firstStartEntered = new Promise<void>((resolve) => {
      signalFirstStart = resolve
    })
    const sessions = new Map<string, ProviderSession>()
    const adapter = makeAdapter(true, {
      hasSession: (threadId) => sessions.has(threadId),
      listSessions: async () => [...sessions.values()],
      startSession: async (input) => {
        if (input.threadId === "shutdown-admission-1") {
          signalFirstStart()
          await firstStartGate
        }
        const session: ProviderSession = {
          threadId: input.threadId,
          providerThreadId: `native-${input.threadId}`,
          status: "ready",
          cwd: null,
          activeTurnId: null,
          createdAt: 1,
          updatedAt: 1,
        }
        sessions.set(input.threadId, session)
        return session
      },
    })
    const hub = new ProviderHub({
      maxActiveTurns: 4,
      maxActiveTurnsPerProvider: 4,
      maxActiveTurnsPerInstance: 4,
      instances: [
        {
          instanceId: "codex-main",
          driver: "codex",
          provider: "codex",
          enabled: true,
          adapter,
        },
      ],
    })

    const first = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "shutdown-admission-1",
      message: "one",
      modelId: "gpt-5",
      history: [],
    })
    await firstStartEntered
    const queued = hub.startTurn("codex", {
      providerInstanceId: "codex-main",
      threadId: "shutdown-admission-2",
      message: "two",
      modelId: "gpt-5",
      history: [],
    })
    // Let the second dispatch reach the serialized admission queue.
    await Promise.resolve()

    hub.beginShutdown()

    await expect(queued.completion).rejects.toMatchObject({
      statusCode: 503,
    })
    releaseFirstStart()
    await expect(first.completion).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(sessions.has("shutdown-admission-2")).toBe(false)
  })
})
