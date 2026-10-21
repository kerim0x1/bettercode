import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectWs, wsRpc } from "./wsClient"

class MockWebSocket {
  static readonly OPEN = 1
  static instances: MockWebSocket[] = []

  readonly send = vi.fn()
  readonly close = vi.fn()
  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
}

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  MockWebSocket.instances = []
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  vi.stubGlobal("WebSocket", MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("connectWs authentication transport", () => {
  it("cancels an unfinished connection and ignores its late events", async () => {
    const controller = new AbortController()
    const onEvent = vi.fn()
    const rejected = vi.fn()
    const connection = connectWs(
      4321,
      undefined,
      onEvent,
      undefined,
      undefined,
      controller.signal
    ).catch(rejected)
    const socket = MockWebSocket.instances[0]!
    controller.abort()
    expect(socket.close).toHaveBeenCalledOnce()
    await connection
    expect(rejected).toHaveBeenCalledOnce()
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
    socket.onmessage?.({
      data: JSON.stringify({ channel: "provider.runtimeEvent", data: {} }),
    })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("times out authentication so the connection owner can retry", async () => {
    vi.useFakeTimers()
    try {
      const rejected = vi.fn()
      const onClose = vi.fn()
      void connectWs(4321, undefined, undefined, undefined, onClose).catch(
        rejected
      )
      const socket = MockWebSocket.instances[0]!
      socket.onopen?.()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rejected).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("authentication timed out"),
        })
      )
      expect(socket.close).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("closes superseded connections without triggering their reconnect callback", async () => {
    const onOldClose = vi.fn()
    const rejected = vi.fn()
    const oldConnection = connectWs(
      4321,
      undefined,
      undefined,
      undefined,
      onOldClose
    ).catch(rejected)
    const oldSocket = MockWebSocket.instances[0]!
    const newConnection = connectWs(5432)
    const newSocket = MockWebSocket.instances[1]!
    newSocket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
    await newConnection
    expect(oldSocket.close).toHaveBeenCalledOnce()
    await oldConnection
    expect(rejected).toHaveBeenCalledOnce()
    oldSocket.onclose?.({ code: 1000 })
    expect(onOldClose).not.toHaveBeenCalled()
  })

  it("clears RPC timeouts when a response arrives", async () => {
    vi.useFakeTimers()
    try {
      const connection = connectWs(4321)
      const socket = MockWebSocket.instances[0]!
      socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
      await connection

      const result = wsRpc(socket as unknown as WebSocket, "ping")
      const request = JSON.parse(
        String(socket.send.mock.calls.at(-1)?.[0])
      ) as {
        id: string
      }
      socket.onmessage?.({
        data: JSON.stringify({ id: request.id, result: "pong" }),
      })

      await expect(result).resolves.toBe("pong")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects in-flight RPCs immediately when their socket closes", async () => {
    vi.useFakeTimers()
    try {
      const connection = connectWs(4321)
      const socket = MockWebSocket.instances[0]!
      socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
      await connection

      const result = wsRpc(socket as unknown as WebSocket, "slow")
      socket.onclose?.({ code: 1006 })

      await expect(result).rejects.toThrow("WebSocket closed during RPC")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for upgrade authentication locally without sending a token frame", async () => {
    const connection = connectWs(4321)
    const socket = MockWebSocket.instances[0]!

    socket.onopen?.()
    expect(socket.url).toBe("ws://127.0.0.1:4321/ws")
    expect(socket.send).not.toHaveBeenCalled()

    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
    await expect(connection).resolves.toBe(socket)
  })

  it("retains the explicit in-band token handshake for remote mode", async () => {
    storage.set("betterc0de.backend.mode", "remote_http")
    storage.set("betterc0de.remote.baseUrl", "https://remote.example")
    storage.set("betterc0de.remote.token", "remote-secret")

    const connection = connectWs()
    const socket = MockWebSocket.instances[0]!
    socket.onopen?.()

    expect(socket.url).toBe("wss://remote.example/ws")
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "auth", token: "remote-secret" })
    )
    expect(storage.has("betterc0de.remote.token")).toBe(false)

    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
    await expect(connection).resolves.toBe(socket)
  })

  it("requests missed provider events and suppresses duplicate sequences", async () => {
    const onEvent = vi.fn()
    const firstConnection = connectWs(4321, undefined, onEvent)
    const first = MockWebSocket.instances[0]!

    first.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-a", latestSequence: 2 },
      }),
    })
    await expect(firstConnection).resolves.toBe(first)
    expect(first.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "provider_replay",
        journalId: "journal-a",
        afterSequence: 0,
      })
    )

    const firstProviderEvent = {
      channel: "provider.runtimeEvent",
      journalId: "journal-a",
      sequence: 1,
      data: { event_type: "content_delta" },
    }
    first.onmessage?.({ data: JSON.stringify(firstProviderEvent) })
    first.onmessage?.({ data: JSON.stringify(firstProviderEvent) })
    expect(onEvent).toHaveBeenCalledTimes(1)

    const secondConnection = connectWs(4321, undefined, onEvent)
    const second = MockWebSocket.instances[1]!
    second.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-a", latestSequence: 2 },
      }),
    })
    await expect(secondConnection).resolves.toBe(second)
    expect(second.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "provider_replay",
        journalId: "journal-a",
        afterSequence: 1,
      })
    )

    second.onmessage?.({
      data: JSON.stringify({
        ...firstProviderEvent,
        sequence: 2,
        data: { event_type: "turn_completed" },
      }),
    })
    second.onmessage?.({
      data: JSON.stringify({
        ...firstProviderEvent,
        sequence: 2,
        data: { event_type: "turn_completed" },
      }),
    })
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it("resets the replay cursor when the backend journal changes", async () => {
    const onEvent = vi.fn()
    const firstConnection = connectWs(4321, undefined, onEvent)
    const first = MockWebSocket.instances[0]!
    first.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-before-restart", latestSequence: 1 },
      }),
    })
    await firstConnection
    first.onmessage?.({
      data: JSON.stringify({
        channel: "provider.runtimeEvent",
        journalId: "journal-before-restart",
        sequence: 1,
        data: {},
      }),
    })

    const restartedConnection = connectWs(4321, undefined, onEvent)
    const restarted = MockWebSocket.instances[1]!
    restarted.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-after-restart", latestSequence: 0 },
      }),
    })
    await restartedConnection

    expect(restarted.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "provider_replay",
        journalId: "journal-before-restart",
        afterSequence: 1,
      })
    )

    const restartGap = {
      type: "provider_replay_gap",
      journalId: "journal-after-restart",
      requestedAfterSequence: 1,
      earliestAvailableSequence: 1,
      latestSequence: 0,
      reason: "journal_changed",
    }
    restarted.onmessage?.({ data: JSON.stringify(restartGap) })
    expect(onEvent).toHaveBeenCalledWith({
      channel: "provider.replayGap",
      data: restartGap,
    })
  })

  it("surfaces an unannounced provider sequence jump as a replay gap", async () => {
    const onEvent = vi.fn()
    const connection = connectWs(4321, undefined, onEvent)
    const socket = MockWebSocket.instances[0]!
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-sequence-gap", latestSequence: 0 },
      }),
    })
    await connection
    socket.onmessage?.({
      data: JSON.stringify({
        type: "provider_replay_complete",
        journalId: "journal-sequence-gap",
        latestSequence: 0,
      }),
    })

    socket.onmessage?.({
      data: JSON.stringify({
        channel: "provider.runtimeEvent",
        journalId: "journal-sequence-gap",
        sequence: 1,
        data: { event_type: "content_delta" },
      }),
    })
    socket.onmessage?.({
      data: JSON.stringify({
        channel: "provider.runtimeEvent",
        journalId: "journal-sequence-gap",
        sequence: 3,
        data: { event_type: "turn_completed" },
      }),
    })

    expect(onEvent).toHaveBeenNthCalledWith(2, {
      channel: "provider.replayGap",
      data: expect.objectContaining({
        journalId: "journal-sequence-gap",
        requestedAfterSequence: 1,
        earliestAvailableSequence: 3,
        latestSequence: 3,
        reason: "sequence_gap",
      }),
    })
    expect(onEvent).toHaveBeenCalledTimes(3)
  })

  it("surfaces replay gaps so persisted thread state can be rehydrated", async () => {
    const onEvent = vi.fn()
    const connection = connectWs(4321, undefined, onEvent)
    const socket = MockWebSocket.instances[0]!
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) })
    await connection

    const gap = {
      type: "provider_replay_gap",
      journalId: "journal-gap",
      requestedAfterSequence: 1,
      earliestAvailableSequence: 5,
      latestSequence: 8,
    }
    socket.onmessage?.({ data: JSON.stringify(gap) })

    expect(onEvent).toHaveBeenCalledWith({
      channel: "provider.replayGap",
      data: gap,
    })
  })
})

describe("realtime event failures", () => {
  async function connectedSocket(onEvent: (event: unknown) => void) {
    const connection = connectWs(4321, undefined, onEvent)
    const socket = MockWebSocket.instances[0]!
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        replay: { journalId: "journal-failures", latestSequence: 0 },
      }),
    })
    await connection
    socket.onmessage?.({
      data: JSON.stringify({
        type: "provider_replay_complete",
        journalId: "journal-failures",
        latestSequence: 0,
      }),
    })
    return socket
  }

  function runtimeEvent(sequence: number, eventType: string) {
    return {
      data: JSON.stringify({
        channel: "provider.runtimeEvent",
        journalId: "journal-failures",
        sequence,
        data: { event_type: eventType, thread_id: "thread-1" },
      }),
    }
  }

  it("reports a handler failure with context, keeps the socket and self-heals", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const received: unknown[] = []
      const socket = await connectedSocket((event) => {
        const data = (event as { data?: { event_type?: string } }).data
        if (data?.event_type === "turn_completed") {
          throw new Error("projection exploded")
        }
        received.push(event)
      })

      socket.onmessage?.(runtimeEvent(1, "turn_completed"))

      expect(consoleError).toHaveBeenCalled()
      const logged = consoleError.mock.calls.flat().map(String).join(" ")
      expect(logged).toContain("Realtime event handler failed")
      expect(logged).toContain("event=turn_completed")
      expect(logged).toContain("thread=thread-1")
      expect(socket.close).not.toHaveBeenCalled()

      // The failed frame was never acknowledged, so the next sequenced event
      // announces a gap and the app rehydrates the thread.
      socket.onmessage?.(runtimeEvent(2, "content_delta"))
      expect(received).toEqual([
        {
          channel: "provider.replayGap",
          data: expect.objectContaining({
            reason: "sequence_gap",
            requestedAfterSequence: 0,
          }),
        },
        expect.objectContaining({ channel: "provider.runtimeEvent" }),
      ])
    } finally {
      consoleError.mockRestore()
    }
  })

  it("drops malformed frames with a warning and keeps delivering", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const onEvent = vi.fn()
      const socket = await connectedSocket(onEvent)

      socket.onmessage?.({ data: "{not json" })
      socket.onmessage?.({ data: "42" })
      expect(consoleWarn).toHaveBeenCalled()
      expect(onEvent).not.toHaveBeenCalled()

      socket.onmessage?.(runtimeEvent(1, "content_delta"))
      expect(onEvent).toHaveBeenCalledOnce()
      expect(socket.close).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
