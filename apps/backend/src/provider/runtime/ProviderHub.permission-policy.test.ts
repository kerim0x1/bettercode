import { describe, expect, it, vi } from "vitest"
import type {
  ProviderAdapterShape,
  ProviderRuntimeEvent,
  ProviderSession,
} from "./contracts"
import { ProviderHub } from "./ProviderHub"
import { HttpError } from "../../errors"
import type { LegacyProviderEvent } from "../types"

function policyTestAdapter(
  sendTurn: () => Promise<void>
): ProviderAdapterShape {
  const sessions = new Map<string, ProviderSession>()
  return {
    provider: "claude",
    displayName: "Policy test provider",
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsApprovals: true,
      supportsResume: true,
      managesOwnLifecycle: true,
    },
    isConfigured: () => true,
    availableModels: async () => [{ slug: "test-model", name: "Test model" }],
    startSession: async (input) => {
      const now = Date.now()
      const session: ProviderSession = {
        threadId: input.threadId,
        providerThreadId: null,
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        runtimeMode: input.runtimeMode ?? null,
        createdAt: now,
        updatedAt: now,
      }
      sessions.set(input.threadId, session)
      return session
    },
    listSessions: async () => [...sessions.values()],
    sendTurn,
    interruptTurn: async () => {},
    respondToRequest: async () => {},
    stopSession: async (threadId) => {
      sessions.delete(threadId)
    },
    hasSession: (threadId) => sessions.has(threadId),
    subscribe: () => () => {},
    stopAll: async () => {
      sessions.clear()
    },
  }
}

describe("ProviderHub pre-dispatch policy", () => {
  it("restarts a session with unknown mode before applying an explicit permission mode", async () => {
    const sendTurn = vi.fn(async () => {})
    const adapter = policyTestAdapter(sendTurn)
    const threadId = "unknown-mode" as Parameters<
      typeof adapter.startSession
    >[0]["threadId"]
    await adapter.startSession({ threadId })
    const stop = vi.spyOn(adapter, "stopSession")
    const start = vi.spyOn(adapter, "startSession")
    const stopBeforeQuery = new Error("stop after session policy preparation")
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
      beforeTurn: async () => {
        throw stopBeforeQuery
      },
    })
    try {
      for (let i = 0; i < 2; i++) {
        await expect(
          hub.startTurn("claude", {
            threadId,
            message: "inspect",
            modelId: "test-model",
            history: [],
            permissionLevel: "read-only",
          }).settled
        ).rejects.toBe(stopBeforeQuery)
      }
      expect(stop).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeMode: "read-only" })
      )
      expect((await adapter.listSessions?.())?.[0]?.runtimeMode).toBe(
        "read-only"
      )
      expect(sendTurn).not.toHaveBeenCalled()
    } finally {
      await hub.stopAll()
    }
  })

  it("surfaces an actionable operational rejection without entering the provider", async () => {
    const sendTurn = vi.fn(async () => {})
    const error = new HttpError(
      403,
      "workspace root is not registered",
      "workspace_not_registered"
    )
    const hub = new ProviderHub({
      adapters: [policyTestAdapter(sendTurn)],
      projectProviderPolicyLoader: async () => null,
      beforeTurn: async () => {
        throw error
      },
    })
    const events: ProviderRuntimeEvent[] = []
    hub.subscribe((event) => events.push(event))
    const turn = hub.startTurn("claude", {
      threadId: "thread-failed",
      message: "implement",
      modelId: "test-model",
      history: [],
    })
    await expect(turn.completion).rejects.toBe(error)
    await expect(turn.settled).rejects.toBe(error)
    expect(sendTurn).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({ type: "runtime.error", message: error.message })
    )
    await hub.stopAll()
  })
  it("emits tool.denied and settles normally without entering the adapter", async () => {
    const sendTurn = vi.fn(async () => {})
    const beforeTurn = vi.fn(async () => {})
    const afterTurn = vi.fn(async () => {})
    const preDispatchPolicy = vi.fn(async () => ({
      decision: "deny" as const,
      toolName: "AgentMode",
      reason: "Agent Mode is disabled for this untrusted workspace.",
    }))
    const hub = new ProviderHub({
      adapters: [policyTestAdapter(sendTurn)],
      projectProviderPolicyLoader: async () => null,
      beforeTurn,
      afterTurn,
      preDispatchPolicy,
    })
    const events: ProviderRuntimeEvent[] = []
    const unsubscribe = hub.subscribe((event) => events.push(event))

    const turn = hub.startTurn("claude", {
      threadId: "thread-policy",
      message: "change the workspace",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "agent",
    })

    await expect(turn.completion).resolves.toBeUndefined()
    await expect(turn.settled).resolves.toBeUndefined()

    expect(sendTurn).not.toHaveBeenCalled()
    expect(beforeTurn).toHaveBeenCalledTimes(1)
    expect(preDispatchPolicy).toHaveBeenCalledWith({
      threadId: "thread-policy",
      turnId: turn.turnId,
      projectPath: process.cwd(),
      appMode: "agent",
      providerKind: "claude",
      providerInstanceId: "claude",
    })
    expect(
      events
        .filter(
          (event) =>
            event.type === "tool.denied" ||
            event.type === "turn.completed" ||
            event.type === "runtime.error"
        )
        .map((event) => event.type)
    ).toEqual(["tool.denied", "turn.completed"])
    expect(events.find((event) => event.type === "tool.denied")).toMatchObject({
      turnId: turn.turnId,
      payload: {
        toolName: "AgentMode",
        reason: "Agent Mode is disabled for this untrusted workspace.",
      },
    })
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.completed",
        turnId: turn.turnId,
      })
    )

    unsubscribe()
    await hub.stopAll()
  })

  it("runs the shared turn lifecycle policy in the legacy event shape", async () => {
    const sendTurn = vi.fn(async () => {})
    const before: LegacyProviderEvent[] = []
    const after: LegacyProviderEvent[] = []
    const preDispatchPolicy = vi.fn(() => ({
      decision: "deny" as const,
      toolName: "AgentMode",
      reason: "Agent Mode is disabled for this untrusted workspace.",
    }))
    const hub = new ProviderHub({
      adapters: [policyTestAdapter(sendTurn)],
      projectProviderPolicyLoader: async () => null,
      turnLifecycle: {
        beforeTurn: async (event) => {
          before.push(event)
        },
        preDispatchPolicy,
        afterTurn: async (event) => {
          after.push(event)
        },
      },
    })

    const turn = hub.startTurn("claude", {
      threadId: "thread-shared-policy",
      message: "change the workspace",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "agent",
    })
    await expect(turn.settled).resolves.toBeUndefined()

    expect(sendTurn).not.toHaveBeenCalled()
    expect(before).toEqual([
      {
        event_type: "turn_started",
        thread_id: "thread-shared-policy",
        payload: {
          turn_id: turn.turnId,
          dispatchTurnId: turn.turnId,
          provider_kind: "claude",
          provider_instance_id: "claude",
          project_path: process.cwd(),
        },
      },
    ])
    expect(preDispatchPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-shared-policy",
        turnId: turn.turnId,
        providerInstanceId: "claude",
      })
    )
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      event_type: "turn_completed",
      thread_id: "thread-shared-policy",
    })

    await hub.stopAll()
  })
})
