import http from "node:http"
import net from "node:net"
import { Duplex } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import { rejectUpgrade, WsHub, type WsHubOptions } from "./server"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function startHub(options: WsHubOptions = {}) {
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const hub = new WsHub("secret", options)
  hub.attach(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("missing test port")
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        hub.close()
        server.close(() => resolve())
      })
  )
  return { hub, url: `ws://127.0.0.1:${address.port}/ws` }
}

function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    ws.once("error", reject)
  })
}

function rejectedUpgrade(
  url: string,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0)
      response.resume()
    })
    ws.once("open", () => reject(new Error("upgrade unexpectedly succeeded")))
    ws.once("error", () => {
      // `unexpected-response` is the assertion path; the socket may emit a
      // follow-up error while the HTTP response is being torn down.
    })
  })
}

describe("rejectUpgrade", () => {
  it("attaches a persistent error listener and destroys only after the refusal flushed", () => {
    const order: string[] = []
    let onFinish: (() => void) | undefined
    const socket = {
      on: vi.fn((event: string) => order.push(`on:${event}`)),
      once: vi.fn((event: string, listener: () => void) => {
        order.push(`once:${event}`)
        onFinish = listener
      }),
      end: vi.fn(() => order.push("end")),
      destroy: vi.fn(() => order.push("destroy")),
    }

    rejectUpgrade(socket, 403, "Forbidden")

    expect(order).toEqual(["on:error", "once:finish", "end"])
    expect(socket.end).toHaveBeenCalledWith(
      expect.stringMatching(/^HTTP\/1\.1 403 Forbidden\r\n/)
    )
    onFinish?.()
    expect(order.at(-1)).toBe("destroy")
  })

  it("delivers the status line to a real TCP peer before closing", async () => {
    const received: Buffer[] = []
    const server = net.createServer((socket) => {
      rejectUpgrade(socket, 426, "Upgrade Required")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing port")
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve()))
    )

    const client = net.connect(address.port, "127.0.0.1")
    client.on("data", (chunk) => received.push(chunk))
    await new Promise<void>((resolve, reject) => {
      client.once("end", resolve)
      client.once("close", resolve)
      client.once("error", reject)
    })

    expect(Buffer.concat(received).toString("utf8")).toMatch(
      /^HTTP\/1\.1 426 Upgrade Required\r\n(?:.*\r\n)*\r\n$/
    )
  })

  it("survives a peer that hung up before the refusal was written", async () => {
    const uncaught = vi.fn()
    process.on("uncaughtException", uncaught)
    try {
      // A raw upgrade socket has no error listener of its own; the write
      // failing on a vanished peer emits `error` and would kill the process.
      const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          this.destroy(new Error("write EPIPE"))
          callback()
        },
      })
      rejectUpgrade(socket, 503, "Service Unavailable")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(uncaught).not.toHaveBeenCalled()
      expect(socket.destroyed).toBe(true)
    } finally {
      process.off("uncaughtException", uncaught)
    }
  })
})

describe("WsHub coalesced live delivery", () => {
  it("replays the same surviving snapshots with contiguous wire sequences", async () => {
    const { hub, url } = await startHub()
    const headers = {
      Authorization: "Bearer secret",
      Origin: "http://localhost:5173",
    }
    const ws = new WebSocket(url, { headers })
    const auth = await nextJson(ws)
    const replay = auth.replay as { journalId: string }
    const ready = nextJson(ws)
    ws.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )
    await ready
    const received = nextJsonMessages(ws, 2)
    for (let index = 0; index < 100; index++) {
      hub.broadcast({
        channel: "provider.runtimeEvent",
        data: {
          event_type: "tool_call_delta",
          thread_id: "thread-1",
          payload: {
            tool_id: "tool-1",
            turn_id: "turn-1",
            cumulative: true,
            output_delta: `output-${index}`,
          },
        },
      })
    }
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "turn_completed",
        thread_id: "thread-1",
        payload: { turn_id: "turn-1" },
      },
    })
    const frames = await received
    expect(frames).toMatchObject([
      { sequence: 1, data: { payload: { output_delta: "output-99" } } },
      { sequence: 2, data: { event_type: "turn_completed" } },
    ])
    ws.close()
    await new Promise<void>((resolve) => ws.once("close", () => resolve()))

    const resumed = new WebSocket(url, { headers })
    expect(await nextJson(resumed)).toMatchObject({
      replay: { latestSequence: 2 },
    })
    const catchUp = nextJsonMessages(resumed, 3)
    resumed.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )
    expect(await catchUp).toEqual([
      ...frames,
      expect.objectContaining({
        type: "provider_replay_complete",
        latestSequence: 2,
      }),
    ])
    resumed.close()
  })

  it("includes already pending updates in the authentication replay boundary", async () => {
    const { hub, url } = await startHub()
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "tool_call_delta",
        thread_id: "thread-1",
        payload: {
          tool_id: "tool-1",
          cumulative: true,
          output_delta: "latest",
        },
      },
    })
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    expect(await nextJson(ws)).toMatchObject({ replay: { latestSequence: 1 } })
    ws.close()
  })
})

describe("WsHub upgrade boundary", () => {
  it("survives an oversized pre-auth frame and closes only that socket", async () => {
    const { hub, url } = await startHub({
      allowedOrigins: ["https://remote.example"],
      maxPayloadBytes: 256 * 1024,
    })
    const uncaught = vi.fn()
    process.on("uncaughtException", uncaught)
    process.on("unhandledRejection", uncaught)
    try {
      const ws = new WebSocket(url, {
        headers: { Origin: "https://remote.example" },
      })
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve)
        ws.once("error", reject)
      })
      const closed = new Promise<number>((resolve) => {
        ws.once("close", (code) => resolve(code))
      })
      ws.once("error", () => {
        // The client may observe the abrupt close as an error first.
      })

      ws.send("x".repeat(300 * 1024))

      // `ws` rejects the frame with 1009 (message too big); the server must
      // still be alive and accepting the next connection.
      await expect(closed).resolves.toBe(1009)
      expect(uncaught).not.toHaveBeenCalled()
      const next = new WebSocket(url, {
        headers: {
          Authorization: "Bearer secret",
          Origin: "http://localhost:5173",
        },
      })
      await expect(nextJson(next)).resolves.toMatchObject({ type: "auth_ok" })
      expect(hub.clientCount()).toBe(1)
      next.close()
    } finally {
      process.off("uncaughtException", uncaught)
      process.off("unhandledRejection", uncaught)
    }
  })

  it("terminates a client that stops answering pings", async () => {
    const { hub, url } = await startHub({ livenessIntervalMs: 20 })
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    await nextJson(ws)
    expect(hub.clientCount()).toBe(1)
    // Stop reading from the wire so the client never sees (or answers) the
    // server's pings — the same signature as a peer that silently vanished.
    ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()

    await vi.waitFor(() => {
      expect(hub.clientCount()).toBe(0)
    })
    ;(ws as unknown as { _socket: { resume(): void } })._socket.resume()
    ws.terminate()
  })

  it("keeps a responsive client through several liveness sweeps", async () => {
    const { hub, url } = await startHub({ livenessIntervalMs: 20 })
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    await nextJson(ws)
    const pings: number[] = []
    ws.on("ping", () => pings.push(Date.now()))

    await vi.waitFor(() => {
      expect(pings.length).toBeGreaterThanOrEqual(3)
    })
    expect(hub.clientCount()).toBe(1)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it("closes unauthenticated handshake sockets during shutdown", async () => {
    const { hub, url } = await startHub({
      allowedOrigins: ["https://remote.example"],
    })
    const ws = new WebSocket(url, {
      headers: { Origin: "https://remote.example" },
    })
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    const closed = new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code))
    })

    await hub.close(1_000)

    await expect(closed).resolves.toBe(1001)
  })

  it("applies backpressure limits to non-provider broadcasts", () => {
    const hub = new WsHub("secret", { maxBufferedAmountBytes: 10 })
    const send = vi.fn()
    const close = vi.fn()
    const client = {
      socket: {
        readyState: WebSocket.OPEN,
        bufferedAmount: 11,
        send,
      },
      principal: { kind: "local" as const },
      providerEventsReady: true,
      lastDeliveredProviderSequence: 0,
      authenticatedAtSequence: 0,
      replayTimer: null,
      expiryTimer: null,
      rpcInFlight: 0,
      close,
      send: vi.fn(),
    }
    ;(hub as unknown as { clients: Set<typeof client> }).clients.add(client)

    hub.broadcast({ channel: "thread.activity", data: { id: "activity-1" } })

    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(
      1013,
      "client backpressure limit exceeded"
    )
  })

  it("limits concurrent RPC work per authenticated client", async () => {
    const { hub, url } = await startHub({ maxRpcInFlight: 1 })
    let resolveFirst!: (value: unknown) => void
    hub.setRpcHandler((method) =>
      method === "slow"
        ? new Promise((resolve) => {
            resolveFirst = resolve
          })
        : "unexpected"
    )
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    await nextJson(ws)

    const rejected = nextJson(ws)
    ws.send(JSON.stringify({ id: "first", method: "slow", params: {} }))
    ws.send(JSON.stringify({ id: "second", method: "slow", params: {} }))

    await expect(rejected).resolves.toEqual({
      id: "second",
      error: { message: "Too many concurrent RPC requests" },
    })
    const completed = nextJson(ws)
    resolveFirst("done")
    await expect(completed).resolves.toEqual({ id: "first", result: "done" })
    ws.close()
  })

  it("does not expose unexpected RPC error details", async () => {
    const { hub, url } = await startHub()
    hub.setRpcHandler(() => {
      throw new Error("C:\\secret\\provider-token.json")
    })
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    await nextJson(ws)
    const response = nextJson(ws)
    ws.send(JSON.stringify({ id: "failure", method: "provider.failure" }))

    await expect(response).resolves.toEqual({
      id: "failure",
      error: { message: "websocket RPC failed" },
    })
    ws.close()
  })

  it("accepts upgrade-header auth from the local renderer", async () => {
    const { url } = await startHub()
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })

    await expect(nextJson(ws)).resolves.toMatchObject({
      type: "auth_ok",
      replay: {
        journalId: expect.any(String),
        latestSequence: 0,
      },
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it("accepts a revocable remote-session cookie from the same hosted origin", async () => {
    const authenticateToken = vi.fn((token: string) =>
      token === "remote-session"
        ? {
            kind: "remote" as const,
            sessionId: "session-1",
            accessLevel: "full" as const,
            expiresAt: Date.now() + 60_000,
          }
        : null
    )
    const { url } = await startHub({
      allowSameHostOrigins: () => true,
      authenticateToken,
      sessionCookieName: "betterc0de_remote_session",
    })
    const parsed = new URL(url)
    const ws = new WebSocket(url, {
      headers: {
        Cookie: "betterc0de_remote_session=remote-session",
        Host: parsed.host,
        Origin: `http://${parsed.host}`,
      },
    })

    await expect(nextJson(ws)).resolves.toMatchObject({ type: "auth_ok" })
    expect(authenticateToken).toHaveBeenCalledWith("remote-session")
    ws.close()
  })

  it("closes connected remote clients immediately when their session is revoked", async () => {
    let revoke: ((sessionIds: readonly string[]) => void) | undefined
    const unsubscribe = vi.fn()
    const { url } = await startHub({
      authenticateToken: () => ({
        kind: "remote",
        sessionId: "session-revoked",
        accessLevel: "full",
        expiresAt: Date.now() + 60_000,
      }),
      sessionCookieName: "betterc0de_remote_session",
      allowSameHostOrigins: () => true,
      subscribeToRemoteSessionRevocations: (listener) => {
        revoke = listener
        return unsubscribe
      },
    })
    const parsed = new URL(url)
    const ws = new WebSocket(url, {
      headers: {
        Cookie: "betterc0de_remote_session=remote-session",
        Host: parsed.host,
        Origin: `http://${parsed.host}`,
      },
    })
    await nextJson(ws)
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString("utf8") })
      )
    })

    revoke?.(["session-revoked"])

    await expect(closed).resolves.toEqual({
      code: 4401,
      reason: "session revoked",
    })
  })

  it("revalidates idle remote clients and closes expired sessions", async () => {
    let active = true
    const { url } = await startHub({
      authenticateToken: () => ({
        kind: "remote",
        sessionId: "session-idle",
        accessLevel: "full",
        expiresAt: Date.now() + 60_000,
      }),
      revalidateRemoteSession: () => active,
      remoteSessionRevalidationMs: 1_000,
      sessionCookieName: "betterc0de_remote_session",
      allowSameHostOrigins: () => true,
    })
    const parsed = new URL(url)
    const ws = new WebSocket(url, {
      headers: {
        Cookie: "betterc0de_remote_session=remote-session",
        Host: parsed.host,
        Origin: `http://${parsed.host}`,
      },
    })
    await nextJson(ws)
    active = false

    const closed = await new Promise<{ code: number; reason: string }>(
      (resolve) => {
        ws.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString("utf8") })
        )
      }
    )
    expect(closed).toEqual({
      code: 4401,
      reason: "session expired or revoked",
    })
  })

  it("rejects arbitrary origins and invalid upgrade bearer tokens", async () => {
    const { url } = await startHub({ allowSameHostOrigins: () => true })
    const parsed = new URL(url)

    await expect(
      rejectedUpgrade(url, {
        Authorization: "Bearer secret",
        Origin: "https://attacker.example",
      })
    ).resolves.toBe(403)
    await expect(
      rejectedUpgrade(url, {
        Authorization: "Bearer wrong",
        Origin: `http://${parsed.host}`,
      })
    ).resolves.toBe(401)
  })

  it("rejects a remote-session cookie from a different loopback port", async () => {
    const { url } = await startHub({
      authenticateToken: () => ({
        kind: "remote",
        sessionId: "session-cross-port",
        accessLevel: "full",
        expiresAt: Date.now() + 60_000,
      }),
      allowSameHostOrigins: () => true,
      sessionCookieName: "betterc0de_remote_session",
    })

    await expect(
      rejectedUpgrade(url, {
        Cookie: "betterc0de_remote_session=remote-session",
        Origin: "http://127.0.0.1:5173",
      })
    ).resolves.toBe(403)
  })

  it("classifies a forwarded upgrade by the hop the trusted proxy wrote", async () => {
    const { url } = await startHub({
      allowedOrigins: ["http://remote.example"],
      trustProxyHeaders: true,
    })
    const headers = { Host: "remote.example", Origin: "http://remote.example" }

    // The client prepended a LAN address; the proxy appended the public
    // peer it really accepted. Plaintext from a public peer is refused.
    await expect(
      rejectedUpgrade(url, {
        ...headers,
        "X-Forwarded-For": "192.168.1.40, 203.0.113.9",
      })
    ).resolves.toBe(426)

    // A LAN peer the proxy really saw keeps the private-network policy.
    const ws = new WebSocket(url, {
      headers: { ...headers, "X-Forwarded-For": "203.0.113.9, 192.168.1.40" },
    })
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    ws.close()
  })

  it("requires secure forwarding for a non-loopback hosted WebSocket", async () => {
    const { url } = await startHub({
      allowedOrigins: ["https://remote.example"],
    })

    await expect(
      rejectedUpgrade(url, {
        Host: "remote.example",
        Origin: "https://remote.example",
      })
    ).resolves.toBe(426)
  })

  it.each<WsHubOptions>([
    { trustProxyHeaders: true },
    { trustLoopbackProxyHeaders: () => true },
  ])(
    "checks a forwarded client's transport even with a loopback Host (%j)",
    async (options) => {
      const { url } = await startHub(options)
      const headers = {
        Authorization: "Bearer secret",
        "X-Forwarded-For": "203.0.113.9",
      }
      await expect(rejectedUpgrade(url, headers)).resolves.toBe(426)
      await expect(
        rejectedUpgrade(url, {
          ...headers,
          "X-Forwarded-Proto": "https, http",
        })
      ).resolves.toBe(426)

      const ws = new WebSocket(url, {
        headers: {
          ...headers,
          "X-Forwarded-Proto": "http, https",
        },
      })
      await expect(nextJson(ws)).resolves.toMatchObject({ type: "auth_ok" })
      ws.close()
    }
  )

  it("downgrades remote RPC access on an explicitly enabled plaintext host", async () => {
    const { hub, url } = await startHub({
      allowedOrigins: ["http://remote.example"],
      allowInsecureRemoteAccess: true,
      authenticateToken: () => ({
        kind: "remote",
        sessionId: "session-plaintext",
        accessLevel: "full",
        expiresAt: Date.now() + 60_000,
      }),
      sessionCookieName: "betterc0de_remote_session",
    })
    hub.setRpcHandler((_method, _params, principal) =>
      principal.kind === "remote" ? principal.accessLevel : "local"
    )
    const ws = new WebSocket(url, {
      headers: {
        Cookie: "betterc0de_remote_session=remote-session",
        Host: "remote.example",
        Origin: "http://remote.example",
      },
    })
    await nextJson(ws)
    const response = nextJson(ws)
    ws.send(JSON.stringify({ id: "access", method: "access.level" }))

    await expect(response).resolves.toEqual({
      id: "access",
      result: "read_only",
    })
    ws.close()
  })

  it("keeps in-band auth only for an explicitly allowed remote origin", async () => {
    const { url } = await startHub({
      allowedOrigins: ["https://remote.example"],
    })
    const ws = new WebSocket(url, {
      headers: { Origin: "https://remote.example" },
    })

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve())
      ws.once("error", reject)
    })
    const authResult = nextJson(ws)
    ws.send(JSON.stringify({ type: "auth", token: "secret" }))
    await expect(authResult).resolves.toMatchObject({
      type: "auth_ok",
      replay: {
        journalId: expect.any(String),
        latestSequence: 0,
      },
    })
    ws.close()
  })

  it("caps sockets waiting for in-band auth and frees the slot once one authenticates", async () => {
    // In-band auth is only offered to an explicitly allowed origin.
    const { url } = await startHub({
      maxPendingAuthSockets: 1,
      allowedOrigins: ["https://remote.example"],
    })
    const headers = { Origin: "https://remote.example" }
    const first = new WebSocket(url, { headers })
    await new Promise<void>((resolve, reject) => {
      first.once("open", () => resolve())
      first.once("error", reject)
    })

    // One socket is already holding the only slot.
    await expect(rejectedUpgrade(url, headers)).resolves.toBe(429)

    // Authenticating releases it for the next unauthenticated upgrade.
    const authResult = nextJson(first)
    first.send(JSON.stringify({ type: "auth", token: "secret" }))
    await expect(authResult).resolves.toMatchObject({ type: "auth_ok" })
    const second = new WebSocket(url, { headers })
    await new Promise<void>((resolve, reject) => {
      second.once("open", () => resolve())
      second.once("error", reject)
    })

    // Closing an unauthenticated socket releases it as well.
    await expect(rejectedUpgrade(url, headers)).resolves.toBe(429)
    second.close()
    await new Promise<void>((resolve) => second.once("close", () => resolve()))
    const third = new WebSocket(url, { headers })
    await new Promise<void>((resolve, reject) => {
      third.once("open", () => resolve())
      third.once("error", reject)
    })
    third.close()
    first.close()
  })

  it("reports a replay gap when the client reconnects from a previous backend journal", async () => {
    const { url } = await startHub()
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const auth = await nextJson(ws)
    const replay = auth.replay as { journalId: string }
    const catchUp = nextJsonMessages(ws, 2)

    ws.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: "journal-before-restart",
        afterSequence: 17,
      })
    )

    await expect(catchUp).resolves.toEqual([
      expect.objectContaining({
        type: "provider_replay_gap",
        journalId: replay.journalId,
        reason: "journal_changed",
      }),
      expect.objectContaining({
        type: "provider_replay_complete",
        journalId: replay.journalId,
      }),
    ])
    ws.close()
  })

  it("signals an authenticated live client when an oversized provider frame is dropped", async () => {
    const { hub, url } = await startHub({ providerFrameMaxBytes: 160 })
    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const auth = await nextJson(ws)
    const replay = auth.replay as { journalId: string }
    const ready = nextJson(ws)
    ws.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )
    await ready

    const gap = nextJson(ws)
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "tool_result",
        payload: { output: "x".repeat(1_000) },
      },
    })

    await expect(gap).resolves.toMatchObject({
      type: "provider_replay_gap",
      journalId: replay.journalId,
      latestSequence: 1,
      reason: "oversized_frame",
    })
    ws.close()
  })

  it("replays provider runtime events after the reconnect cursor without duplicates", async () => {
    const { hub, url } = await startHub()
    const first = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const firstAuth = await nextJson(first)
    const replay = firstAuth.replay as {
      journalId: string
      latestSequence: number
    }
    const firstReady = nextJson(first)
    first.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )
    await expect(firstReady).resolves.toMatchObject({
      type: "provider_replay_complete",
      latestSequence: 0,
    })

    const firstEvent = nextJson(first)
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: { event_type: "content_delta", payload: { delta: "one" } },
    })
    await expect(firstEvent).resolves.toMatchObject({
      channel: "provider.runtimeEvent",
      sequence: 1,
      journalId: replay.journalId,
    })
    first.close()
    await new Promise<void>((resolve) => first.once("close", () => resolve()))

    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: { event_type: "content_delta", payload: { delta: "two" } },
    })

    const second = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const secondAuth = await nextJson(second)
    expect(secondAuth).toMatchObject({
      type: "auth_ok",
      replay: {
        journalId: replay.journalId,
        latestSequence: 2,
      },
    })

    const replayFrames = nextJsonMessages(second, 2)
    second.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 1,
      })
    )
    await expect(replayFrames).resolves.toEqual([
      expect.objectContaining({
        channel: "provider.runtimeEvent",
        sequence: 2,
      }),
      expect.objectContaining({
        type: "provider_replay_complete",
        latestSequence: 2,
      }),
    ])

    const duplicateRequestResult = nextJsonMessages(second, 1)
    second.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 1,
      })
    )
    await expect(duplicateRequestResult).resolves.toEqual([
      expect.objectContaining({
        type: "provider_replay_complete",
        latestSequence: 2,
      }),
    ])

    const liveEvent = nextJson(second)
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: { event_type: "turn_completed", payload: {} },
    })
    await expect(liveEvent).resolves.toMatchObject({
      channel: "provider.runtimeEvent",
      sequence: 3,
    })
    second.close()
  })

  it("bounds the replay journal and reports when an older cursor was truncated", async () => {
    const { hub, url } = await startHub({ replayCapacity: 2 })
    for (const delta of ["one", "two", "three"]) {
      hub.broadcast({
        channel: "provider.runtimeEvent",
        data: { event_type: "content_delta", payload: { delta } },
      })
    }

    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const auth = await nextJson(ws)
    const replay = auth.replay as { journalId: string }
    const catchUp = nextJsonMessages(ws, 4)
    ws.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )

    await expect(catchUp).resolves.toEqual([
      expect.objectContaining({
        type: "provider_replay_gap",
        requestedAfterSequence: 0,
        earliestAvailableSequence: 2,
        latestSequence: 3,
      }),
      expect.objectContaining({
        channel: "provider.runtimeEvent",
        sequence: 2,
      }),
      expect.objectContaining({
        channel: "provider.runtimeEvent",
        sequence: 3,
      }),
      expect.objectContaining({
        type: "provider_replay_complete",
        latestSequence: 3,
      }),
    ])
    ws.close()
  })

  it("bounds replay retention by encoded byte size", async () => {
    const { hub, url } = await startHub({ replayMaxBytes: 1 })
    hub.broadcast({
      channel: "provider.runtimeEvent",
      data: { event_type: "content_delta", payload: { delta: "not retained" } },
    })

    const ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer secret",
        Origin: "http://localhost:5173",
      },
    })
    const auth = await nextJson(ws)
    const replay = auth.replay as { journalId: string }
    const catchUp = nextJsonMessages(ws, 2)
    ws.send(
      JSON.stringify({
        type: "provider_replay",
        journalId: replay.journalId,
        afterSequence: 0,
      })
    )

    await expect(catchUp).resolves.toEqual([
      expect.objectContaining({
        type: "provider_replay_gap",
        earliestAvailableSequence: 2,
        latestSequence: 1,
      }),
      expect.objectContaining({
        type: "provider_replay_complete",
        latestSequence: 1,
      }),
    ])
    ws.close()
  })
})

function nextJsonMessages(
  ws: WebSocket,
  count: number
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = []
    const onMessage = (data: WebSocket.RawData) => {
      try {
        messages.push(
          JSON.parse(data.toString("utf8")) as Record<string, unknown>
        )
        if (messages.length === count) {
          ws.off("message", onMessage)
          ws.off("error", onError)
          resolve(messages)
        }
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => reject(error)
    ws.on("message", onMessage)
    ws.once("error", onError)
  })
}
