import { describe, expect, it } from "vitest"
import type {
  ProviderAdapterShape,
  ProviderSession,
  ThreadId,
} from "./contracts"
import { ProviderHub } from "./ProviderHub"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cursorAdapter(): ProviderAdapterShape {
  const sessions = new Map<ThreadId, ProviderSession>()
  return {
    provider: "cursor",
    displayName: "Cursor",
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsApprovals: true,
      supportsResume: true,
      managesOwnLifecycle: true,
    },
    isConfigured: () => true,
    availableModels: async () => [],
    startSession: async (input) => {
      await delay(60)
      const session: ProviderSession = {
        threadId: input.threadId,
        providerThreadId: "cursor-session",
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      sessions.set(input.threadId, session)
      return session
    },
    listSessions: async () => [...sessions.values()],
    sendTurn: async () => {},
    interruptTurn: async () => {},
    respondToRequest: async () => {},
    stopSession: async (threadId) => {
      await delay(60)
      sessions.delete(threadId)
    },
    hasSession: (threadId) => sessions.has(threadId),
    subscribe: () => () => {},
    stopAll: async () => {
      sessions.clear()
    },
  }
}

function cursorHub(adapter: ProviderAdapterShape): ProviderHub {
  return new ProviderHub({
    interruptTimeoutMs: 20,
    instances: [
      {
        instanceId: "cursor",
        driver: "cursor",
        provider: "cursor",
        enabled: true,
        adapter,
      },
    ],
  })
}

describe("ACP session operation deadlines", () => {
  it("allows Cursor startup beyond the short interruption budget", async () => {
    const hub = cursorHub(cursorAdapter())
    const turn = hub.startTurn("cursor", {
      threadId: "cursor-slow-start",
      message: "hello",
      modelId: "default",
      history: [],
    })

    await expect(turn.completion).resolves.toBeUndefined()
    await expect(hub.listInstances()).resolves.toEqual([
      expect.objectContaining({
        instanceId: "cursor",
        availability: "available",
      }),
    ])
  })

  it("allows Cursor shutdown beyond the short interruption budget", async () => {
    const hub = cursorHub(cursorAdapter())

    await expect(
      hub.stopSession("cursor", "cursor-slow-stop" as ThreadId, "cursor")
    ).resolves.toBeUndefined()
    await expect(hub.listInstances()).resolves.toEqual([
      expect.objectContaining({
        instanceId: "cursor",
        availability: "available",
      }),
    ])
  })
})
