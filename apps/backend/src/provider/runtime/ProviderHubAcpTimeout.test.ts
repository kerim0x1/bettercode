import { describe, expect, it, vi } from "vitest"
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

  it.each([6_000, 16_000])(
    "releases Cursor after a confirmed fallback stop taking %i ms",
    async (cleanupMs) => {
      vi.useFakeTimers()
      const adapter = cursorAdapter()
      const originalStop = adapter.stopSession.bind(adapter)
      const stopped = vi.fn()
      adapter.stopSession = async (thread) => {
        await delay(cleanupMs - 60)
        await originalStop(thread)
        stopped()
      }
      const hub = new ProviderHub({ adapters: [adapter] })
      const threadId = "cursor-cleanup" as ThreadId
      try {
        const turn = hub.startTurn("cursor", {
          threadId,
          message: "hello",
          modelId: "default",
          history: [],
        })
        await vi.advanceTimersByTimeAsync(60)
        await turn.completion
        const interrupt = hub.interruptTurn("cursor", threadId)
        const reportedFailure = expect(interrupt).rejects.toThrow()

        // No terminal event arrives, so hard stop begins after 5 seconds.
        await vi.advanceTimersByTimeAsync(10_000)
        expect(stopped).not.toHaveBeenCalled()
        expect(() =>
          hub.assertCanStartTurn("cursor", "different-thread")
        ).not.toThrow()

        if (cleanupMs > 15_000) {
          await vi.advanceTimersByTimeAsync(10_000)
          await reportedFailure
          expect(() =>
            hub.assertCanStartTurn("cursor", "different-thread")
          ).toThrow("Provider backend is temporarily unavailable.")
          await vi.advanceTimersByTimeAsync(1_000)
        } else {
          await vi.advanceTimersByTimeAsync(1_000)
          await reportedFailure
        }

        await expect(turn.settled).rejects.toThrow()
        expect(stopped).toHaveBeenCalledOnce()
        expect(adapter.hasSession(threadId)).toBe(false)
        expect(() =>
          hub.assertCanStartTurn("cursor", "different-thread")
        ).not.toThrow()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("keeps the adapter quarantined until every pending hard stop is confirmed", async () => {
    vi.useFakeTimers()
    const adapter = cursorAdapter()
    const firstThread = "cursor-first" as ThreadId
    const secondThread = "cursor-second" as ThreadId
    const originalStop = adapter.stopSession.bind(adapter)
    adapter.stopSession = async (thread) => {
      await delay(thread === firstThread ? 15_940 : 16_940)
      await originalStop(thread)
    }
    const hub = new ProviderHub({ adapters: [adapter] })
    try {
      const turns = [firstThread, secondThread].map((threadId) =>
        hub.startTurn("cursor", {
          threadId,
          message: "hello",
          modelId: "default",
          history: [],
        })
      )
      await vi.advanceTimersByTimeAsync(120)
      await Promise.all(turns.map((turn) => turn.completion))
      const interrupts = [firstThread, secondThread].map((thread) =>
        expect(hub.interruptTurn("cursor", thread)).rejects.toThrow()
      )

      await vi.advanceTimersByTimeAsync(21_000)
      await Promise.all(interrupts)
      expect(adapter.hasSession(firstThread)).toBe(false)
      expect(adapter.hasSession(secondThread)).toBe(true)
      expect(() =>
        hub.assertCanStartTurn("cursor", "different-thread")
      ).toThrow("Provider backend is temporarily unavailable.")

      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.all(
        turns.map((turn) => expect(turn.settled).rejects.toThrow())
      )
      expect(adapter.hasSession(secondThread)).toBe(false)
      expect(() =>
        hub.assertCanStartTurn("cursor", "different-thread")
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
