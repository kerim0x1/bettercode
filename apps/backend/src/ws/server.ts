import { randomUUID } from "node:crypto"
import type { IncomingMessage, Server as HttpServer } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket } from "ws"
import { constantTimeEqual } from "../security/token"
import { isAllowedBrowserOrigin } from "../security/origin"
import {
  forwardedClientAddress,
  isLoopbackHostname,
  isLoopbackIpAddress,
  isPrivateLanAddress,
} from "../remote/privateNetwork"
import { isTailscaleAddress, normalizeSocketAddress } from "../remote/tailscale"
import { readCookie } from "../security/cookie"
import { logger } from "../observability/logger"
import {
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_UNAUTHORIZED,
  WS_MAX_PENDING_AUTH_SOCKETS,
} from "../constants"
import { sanitizeError } from "../http/errors"
import type { RemoteAccessLevel } from "../remote/service"
import { registerThreadActivityBroadcaster } from "./threadActivityBroadcast"
import { ToolSnapshotBuffer } from "./ToolSnapshotBuffer"

/** A single client connection that has completed the auth handshake. */
export interface AuthenticatedClient {
  readonly socket: WebSocket
  /** Closes the socket with the given code + reason. */
  close(code?: number, reason?: string): void
  /** Sends a framed JSON message. */
  send(frame: unknown): void
}

export interface WsLocalPrincipal {
  readonly kind: "local"
}

export interface WsRemotePrincipal {
  readonly kind: "remote"
  readonly sessionId: string
  readonly accessLevel: RemoteAccessLevel
  /** Absolute Unix epoch in milliseconds. */
  readonly expiresAt: number
}

export type WsPrincipal = WsLocalPrincipal | WsRemotePrincipal

interface ReplayClient extends AuthenticatedClient {
  readonly principal: WsPrincipal
  providerEventsReady: boolean
  lastDeliveredProviderSequence: number
  readonly authenticatedAtSequence: number
  replayTimer: NodeJS.Timeout | null
  expiryTimer: NodeJS.Timeout | null
  rpcInFlight: number
}

interface SequencedProviderFrame {
  readonly channel: "provider.runtimeEvent"
  readonly data: unknown
  readonly sequence: number
  readonly journalId: string
}

interface ReplayJournalEntry {
  readonly frame: SequencedProviderFrame
  readonly serialized: string
  readonly bytes: number
}

export interface WsHubOptions {
  readonly allowedOrigins?: readonly string[]
  /**
   * Accept browser origins whose host exactly matches the upgrade Host.
   * Read per upgrade: remote access is toggled at runtime and the hub
   * outlives the toggle.
   */
  readonly allowSameHostOrigins?: () => boolean
  /** Trust X-Forwarded-Proto only behind an explicitly configured proxy. */
  readonly trustProxyHeaders?: boolean
  /**
   * Trust X-Forwarded-Proto from loopback peers while a same-host TLS proxy
   * (Tailscale Serve) is enabled. Read per upgrade: the setting flips at
   * runtime and the hub outlives it.
   */
  readonly trustLoopbackProxyHeaders?: () => boolean
  /**
   * This machine's own tailnet addresses. A plaintext upgrade from a tailnet
   * peer onto one of them came through the WireGuard tunnel and counts as
   * private transport, like the HTTP side's `requestPeerIsTailnet`.
   */
  readonly tailnetSelfAddresses?: () => ReadonlySet<string>
  /** Explicit opt-in for plaintext, non-loopback WebSockets. */
  readonly allowInsecureRemoteAccess?: boolean
  /** Validates a remote credential and returns its revocable principal. */
  readonly authenticateToken?: (token: string) => WsRemotePrincipal | null
  /** Revalidates a connected remote session without retaining its credential. */
  readonly revalidateRemoteSession?: (principal: WsRemotePrincipal) => boolean
  /** Push channel used to close sockets immediately after an explicit revoke. */
  readonly subscribeToRemoteSessionRevocations?: (
    listener: (sessionIds: readonly string[]) => void
  ) => () => void
  /** Periodic defense-in-depth revalidation interval. */
  readonly remoteSessionRevalidationMs?: number
  /** HttpOnly browser-session cookie accepted during the upgrade. */
  readonly sessionCookieName?: string
  /** Maximum provider runtime frames retained for reconnect catch-up. */
  readonly replayCapacity?: number
  /** Maximum aggregate UTF-8 bytes retained for reconnect catch-up. */
  readonly replayMaxBytes?: number
  /** Maximum accepted inbound WebSocket frame size. */
  readonly maxPayloadBytes?: number
  /** Maximum provider runtime event size retained or broadcast. */
  readonly providerFrameMaxBytes?: number
  /** Close clients that accumulate more queued outbound bytes than this. */
  readonly maxBufferedAmountBytes?: number
  /** Maximum concurrent JSON-RPC calls accepted from one client. */
  readonly maxRpcInFlight?: number
  /** Sockets allowed to wait for in-band auth at once (`WS_MAX_PENDING_AUTH_SOCKETS`). */
  readonly maxPendingAuthSockets?: number
  /**
   * Interval between server-initiated pings. A client that misses
   * `LIVENESS_MISS_LIMIT` consecutive pongs is terminated so a dead TCP peer
   * cannot hold a client slot (and its replay cursor) open indefinitely.
   */
  readonly livenessIntervalMs?: number
}

/** Consecutive missed pongs before a client is terminated. */
const LIVENESS_MISS_LIMIT = 2

export type RpcHandler = (
  method: string,
  params: unknown,
  principal: WsPrincipal
) => Promise<unknown> | unknown

/**
 * Attaches a WebSocket listener to an existing HTTP server under the `/ws`
 * upgrade path. Mirrors rust-backend/src/ws/router.rs:
 *
 *  1. Trusted Electron clients authenticate with an upgrade Authorization
 *     header; explicit remote clients may send the legacy auth frame.
 *  2. Server replies `{ type: "auth_ok" }` on match.
 *  3. Otherwise the upgrade is rejected or the socket closes with 4401.
 *
 * After authentication the socket is added to a registry of active clients
 * that subsequent phases use to broadcast provider + orchestration events.
 */
export class WsHub {
  private readonly toolSnapshots = new ToolSnapshotBuffer({
    emit: (frame) => this.broadcastNow(frame),
    onError: (err) =>
      logger.error({ err }, "failed to broadcast coalesced tool update"),
  })
  private readonly clients = new Set<ReplayClient>()
  /** Upgraded sockets still waiting for their in-band `auth` frame. */
  private pendingAuthSockets = 0
  private readonly providerReplayJournal: ReplayJournalEntry[] = []
  private readonly providerReplayJournalId = randomUUID()
  private readonly replayCapacity: number
  private readonly replayMaxBytes: number
  private readonly maxPayloadBytes: number
  private readonly providerFrameMaxBytes: number
  private readonly maxBufferedAmountBytes: number
  private readonly maxRpcInFlight: number
  private readonly maxPendingAuthSockets: number
  private readonly remoteSessionRevalidationMs: number
  private readonly livenessIntervalMs: number
  private readonly remoteClientsBySession = new Map<string, Set<ReplayClient>>()
  /** Missed-pong counter per open socket, authenticated or not. */
  private readonly livenessMisses = new Map<WebSocket, number>()
  private livenessTimer: NodeJS.Timeout | null = null
  private providerReplayBytes = 0
  private providerSequence = 0
  private lastUnavailableProviderSequence = 0
  private wss: WebSocketServer | null = null
  private rpcHandler: RpcHandler | null = null
  private remoteSessionRevalidationTimer: NodeJS.Timeout | null = null
  private unsubscribeSessionRevocations: (() => void) | null = null
  private unregisterThreadActivityBroadcast: (() => void) | null = null
  private readonly rpcTasks = new Set<Promise<void>>()
  private acceptingConnections = true
  private httpServer: HttpServer | null = null
  private upgradeHandler:
    | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly authToken: string,
    private readonly options: WsHubOptions = {}
  ) {
    this.replayCapacity = Math.max(
      1,
      Math.floor(options.replayCapacity ?? 2_048)
    )
    this.replayMaxBytes = Math.max(
      1,
      Math.floor(options.replayMaxBytes ?? 8 * 1024 * 1024)
    )
    this.maxPayloadBytes = Math.max(
      1,
      Math.floor(options.maxPayloadBytes ?? 256 * 1024)
    )
    this.providerFrameMaxBytes = Math.max(
      1,
      Math.floor(options.providerFrameMaxBytes ?? 1024 * 1024)
    )
    this.maxBufferedAmountBytes = Math.max(
      1,
      Math.floor(options.maxBufferedAmountBytes ?? 4 * 1024 * 1024)
    )
    this.maxRpcInFlight = Math.max(1, Math.floor(options.maxRpcInFlight ?? 32))
    this.maxPendingAuthSockets = Math.max(
      1,
      Math.floor(options.maxPendingAuthSockets ?? WS_MAX_PENDING_AUTH_SOCKETS)
    )
    this.remoteSessionRevalidationMs = Math.max(
      1_000,
      Math.floor(options.remoteSessionRevalidationMs ?? 5_000)
    )
    this.livenessIntervalMs = Math.max(
      10,
      Math.floor(options.livenessIntervalMs ?? 30_000)
    )
  }

  /** Register a post-auth JSON-RPC-style handler for client-initiated calls. */
  setRpcHandler(handler: RpcHandler): void {
    this.rpcHandler = handler
  }

  attach(httpServer: HttpServer): void {
    if (this.wss || this.httpServer) {
      throw new Error("WebSocket hub is already attached")
    }
    this.acceptingConnections = true
    this.closePromise = null
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxPayloadBytes,
    })
    this.wss = wss
    this.httpServer = httpServer
    this.unregisterThreadActivityBroadcast =
      registerThreadActivityBroadcaster(this)
    this.unsubscribeSessionRevocations =
      this.options.subscribeToRemoteSessionRevocations?.((sessionIds) => {
        this.revokeRemoteSessions(sessionIds)
      }) ?? null
    if (this.options.revalidateRemoteSession) {
      this.remoteSessionRevalidationTimer = setInterval(() => {
        this.revalidateRemoteClients()
      }, this.remoteSessionRevalidationMs)
      this.remoteSessionRevalidationTimer.unref?.()
    }
    this.livenessTimer = setInterval(() => {
      this.pingClients()
    }, this.livenessIntervalMs)
    this.livenessTimer.unref?.()

    this.upgradeHandler = (request, socket, head) => {
      if (!this.acceptingConnections) {
        rejectUpgrade(socket, 503, "Service Unavailable")
        return
      }
      const url = request.url ?? ""
      let pathname = ""
      try {
        pathname = new URL(url, "http://localhost").pathname
      } catch {
        pathname = ""
      }
      if (pathname !== "/ws") {
        socket.destroy()
        return
      }
      // "Insecure" means plaintext from a *public* peer. This computer, the
      // tailnet and a private network are accepted without TLS, matching
      // `isInsecureNonLoopbackRequest` on the HTTP side.
      const insecureNonLoopback =
        !isSecureUpgrade(request, this.options) &&
        !isLoopbackUpgrade(request, this.options) &&
        !isTailnetUpgrade(request, this.options) &&
        !isPrivateNetworkUpgrade(request, this.options)
      if (
        insecureNonLoopback &&
        this.options.allowInsecureRemoteAccess !== true
      ) {
        rejectUpgrade(socket, 426, "Upgrade Required")
        return
      }
      // Upgrade-time auth: if `Authorization: Bearer <valid token>` arrives
      // with the upgrade request, the connection is pre-authenticated and
      // skips the in-band auth handshake. This lets Electron's main process
      // attach the bearer header transparently via `webRequest` so the
      // token never has to be exposed to renderer JS. Clients without the
      // header still go through the legacy in-band auth path.
      const authHeader = request.headers.authorization
      const headerToken =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : null
      const headerIsLocal =
        headerToken !== null && constantTimeEqual(headerToken, this.authToken)
      const cookieToken = this.options.sessionCookieName
        ? readCookie(request.headers.cookie, this.options.sessionCookieName)
        : null
      if (
        !isAllowedBrowserOrigin(
          request.headers.origin,
          this.options.allowedOrigins,
          {
            requestHost: request.headers.host,
            allowSameHost: this.options.allowSameHostOrigins?.() === true,
            allowLoopback: headerIsLocal,
            allowOpaque: headerIsLocal,
          }
        )
      ) {
        rejectUpgrade(socket, 403, "Forbidden")
        return
      }
      const headerPrincipal = headerToken
        ? this.authenticateCredential(headerToken)
        : null
      // A presented bearer is an explicit upgrade-auth attempt. Fail it at
      // the boundary instead of silently falling back to the legacy frame.
      if (authHeader !== undefined && !headerPrincipal) {
        rejectUpgrade(socket, 401, "Unauthorized")
        return
      }
      if (insecureNonLoopback && headerPrincipal?.kind === "local") {
        rejectUpgrade(socket, 426, "Upgrade Required")
        return
      }
      const cookiePrincipal = cookieToken
        ? this.authenticateRemoteCredential(cookieToken)
        : null
      const preAuthenticatedPrincipal = this.effectivePrincipal(
        headerPrincipal ?? cookiePrincipal,
        insecureNonLoopback
      )
      if (
        !preAuthenticatedPrincipal &&
        this.pendingAuthSockets >= this.maxPendingAuthSockets
      ) {
        rejectUpgrade(socket, 429, "Too Many Requests")
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) =>
        this.onConnection(ws, preAuthenticatedPrincipal, insecureNonLoopback)
      )
    }
    httpServer.on("upgrade", this.upgradeHandler)

    wss.on("close", () => {
      if (this.wss === wss) this.wss = null
    })
  }

  /** Broadcasts a framed JSON message to every authenticated client. */
  broadcast(frame: unknown): void {
    this.toolSnapshots.offer(frame)
  }

  private broadcastNow(frame: unknown): void {
    if (isProviderRuntimeFrame(frame)) {
      const sequencedFrame: SequencedProviderFrame = {
        ...frame,
        sequence: ++this.providerSequence,
        journalId: this.providerReplayJournalId,
      }
      const serialized = JSON.stringify(sequencedFrame)
      const bytes = Buffer.byteLength(serialized, "utf8")
      if (bytes > this.providerFrameMaxBytes) {
        logger.warn(
          { bytes, limit: this.providerFrameMaxBytes },
          "dropping oversized provider runtime WebSocket frame"
        )
        this.lastUnavailableProviderSequence = sequencedFrame.sequence
        for (const client of this.clients) {
          if (client.providerEventsReady) {
            client.send({
              type: "provider_replay_gap",
              journalId: this.providerReplayJournalId,
              requestedAfterSequence: client.lastDeliveredProviderSequence,
              earliestAvailableSequence: sequencedFrame.sequence + 1,
              latestSequence: this.providerSequence,
              reason: "oversized_frame",
            })
          }
        }
        return
      }
      this.providerReplayJournal.push({
        frame: sequencedFrame,
        serialized,
        bytes,
      })
      this.providerReplayBytes += bytes
      this.trimProviderReplayJournal()
      for (const client of this.clients) {
        if (client.providerEventsReady) {
          this.sendProviderFrame(client, sequencedFrame, serialized)
        }
      }
      return
    }

    const data = JSON.stringify(frame)
    for (const client of this.clients) {
      this.sendSerializedFrame(client, data)
    }
  }

  private trimProviderReplayJournal(): void {
    while (
      this.providerReplayJournal.length > this.replayCapacity ||
      this.providerReplayBytes > this.replayMaxBytes
    ) {
      const removed = this.providerReplayJournal.shift()
      if (!removed) break
      this.providerReplayBytes -= removed.bytes
    }
  }

  /** Number of currently-authenticated clients (for health endpoints). */
  clientCount(): number {
    return this.clients.size
  }

  revokeRemoteSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      for (const client of this.remoteClientsBySession.get(sessionId) ?? []) {
        client.close(WS_CLOSE_UNAUTHORIZED, "session revoked")
      }
    }
  }

  beginShutdown(): void {
    this.toolSnapshots.drain()
    this.acceptingConnections = false
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off("upgrade", this.upgradeHandler)
      this.upgradeHandler = null
    }
  }

  close(timeoutMs = 5_000): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeInternal(timeoutMs)
    return this.closePromise
  }

  private async closeInternal(timeoutMs: number): Promise<void> {
    this.beginShutdown()
    for (const client of this.clients) {
      if (client.replayTimer) clearTimeout(client.replayTimer)
      if (client.expiryTimer) clearTimeout(client.expiryTimer)
    }
    const wss = this.wss
    // `clients` only contains authenticated peers. Close handshake-pending
    // sockets from `wss.clients` as well so shutdown does not wait for their
    // authentication timeout.
    for (const socket of wss?.clients ?? []) {
      socket.close(1001, "server shutdown")
    }
    if (this.remoteSessionRevalidationTimer) {
      clearInterval(this.remoteSessionRevalidationTimer)
      this.remoteSessionRevalidationTimer = null
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
    this.unsubscribeSessionRevocations?.()
    this.unsubscribeSessionRevocations = null
    this.unregisterThreadActivityBroadcast?.()
    this.unregisterThreadActivityBroadcast = null
    const serverClosed = wss
      ? new Promise<void>((resolve, reject) => {
          wss.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      : Promise.resolve()
    const rpcDrained = Promise.allSettled([...this.rpcTasks]).then(
      () => undefined
    )
    let timedOut = false
    const timeout = new Promise<void>((_, reject) => {
      const timer = setTimeout(
        () => {
          timedOut = true
          for (const socket of wss?.clients ?? []) socket.terminate()
          reject(
            new Error(
              `WebSocket shutdown timed out with ${this.rpcTasks.size} RPC task(s) still active`
            )
          )
        },
        Math.max(0, timeoutMs)
      )
      timer.unref?.()
      Promise.allSettled([serverClosed, rpcDrained]).finally(() =>
        clearTimeout(timer)
      )
    })
    try {
      await Promise.race([
        Promise.all([serverClosed, rpcDrained]).then(() => undefined),
        timeout,
      ])
    } finally {
      if (timedOut) {
        for (const socket of wss?.clients ?? []) socket.terminate()
      }
      this.clients.clear()
      this.remoteClientsBySession.clear()
      this.livenessMisses.clear()
      if (this.wss === wss) this.wss = null
      this.httpServer = null
    }
  }

  // ───────────────────────────────────────── private ─────────────────────────

  private onConnection(
    socket: WebSocket,
    preAuthenticatedPrincipal: WsPrincipal | null = null,
    forceReadOnlyRemote = false
  ): void {
    let authenticated = preAuthenticatedPrincipal !== null
    let client: ReplayClient | null = null
    // `ws` emits `error` on the socket for any inbound frame over
    // `maxPayload` or with invalid UTF-8 — before auth, from anyone who can
    // reach the port. Without a listener that is an uncaught exception that
    // takes the backend down. Log and let `ws` finish its own close (1009 /
    // 1007); terminate only if it does not.
    socket.on("error", (error) => {
      logger.warn(
        { err: error, authenticated },
        "websocket client error; closing socket"
      )
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.terminate()
      }
    })
    this.livenessMisses.set(socket, 0)
    socket.on("pong", () => {
      this.livenessMisses.set(socket, 0)
    })
    socket.on("close", () => {
      this.livenessMisses.delete(socket)
    })
    let timer: NodeJS.Timeout | null = authenticated
      ? null
      : setTimeout(() => {
          if (!authenticated) {
            logger.warn("ws auth timeout")
            socket.close(WS_CLOSE_UNAUTHORIZED, "auth timeout")
          }
        }, WS_AUTH_TIMEOUT_MS)
    // The pending-auth slot is released on authentication or on close,
    // whichever comes first; a slot must never be returned twice.
    let pendingSlotHeld = !authenticated
    if (pendingSlotHeld) this.pendingAuthSockets += 1
    const releasePendingSlot = () => {
      if (!pendingSlotHeld) return
      pendingSlotHeld = false
      this.pendingAuthSockets -= 1
    }
    socket.once("close", releasePendingSlot)

    // Upgrade-time auth: register the client immediately and acknowledge so
    // the renderer's onmessage handler observes `auth_ok` exactly once,
    // matching the legacy code path.
    if (preAuthenticatedPrincipal) {
      client = this.registerAuthenticatedClient(
        socket,
        preAuthenticatedPrincipal
      )
    }

    // The handler is async: anything thrown outside an inner try/catch would
    // surface as an unhandled rejection instead of closing this one socket.
    socket.on("message", async (raw) => {
      try {
        if (!this.acceptingConnections) {
          socket.close(1012, "service restarting")
          return
        }
        let msg: unknown
        try {
          msg = JSON.parse(raw.toString("utf8"))
        } catch {
          if (!authenticated)
            socket.close(WS_CLOSE_UNAUTHORIZED, "invalid frame")
          return
        }

        if (!authenticated) {
          const principal = isAuthMessage(msg)
            ? this.effectivePrincipal(
                this.authenticateCredential(msg.token),
                forceReadOnlyRemote
              )
            : null
          if (!principal) {
            socket.close(WS_CLOSE_UNAUTHORIZED, "auth failed")
            return
          }
          authenticated = true
          releasePendingSlot()
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          client = this.registerAuthenticatedClient(socket, principal)
          return
        }

        if (!client || !this.isPrincipalValid(client.principal)) {
          socket.close(WS_CLOSE_UNAUTHORIZED, "session expired or revoked")
          return
        }

        // Header-authed clients may still send the legacy `{type:"auth"}`
        // message (e.g. an older renderer build). Silently ignore it post-auth
        // so it doesn't get parsed as a malformed RPC frame.
        if (isAuthMessage(msg)) return

        if (isProviderReplayRequest(msg)) {
          this.replayProviderEvents(client, msg)
          return
        }

        // Post-auth: treat as JSON-RPC-style call if it has method + id.
        const rpc = msg as { method?: unknown; id?: unknown; params?: unknown }
        if (
          typeof rpc.method !== "string" ||
          (typeof rpc.id !== "string" && typeof rpc.id !== "number")
        ) {
          return // Unknown frame shape — ignore.
        }
        if (!this.rpcHandler) {
          client.send({ id: rpc.id, error: { message: "RPC not configured" } })
          return
        }
        if (!this.acceptingConnections) {
          client.send({
            id: rpc.id,
            error: { message: "Service is shutting down" },
          })
          return
        }
        if (client.rpcInFlight >= this.maxRpcInFlight) {
          client.send({
            id: rpc.id,
            error: { message: "Too many concurrent RPC requests" },
          })
          return
        }
        client.rpcInFlight += 1
        let resolveTask!: () => void
        const task = new Promise<void>((resolve) => {
          resolveTask = resolve
        })
        this.rpcTasks.add(task)
        try {
          const result = await this.rpcHandler(
            rpc.method,
            rpc.params,
            client.principal
          )
          client.send({ id: rpc.id, result })
        } catch (err) {
          const sanitized = sanitizeError(err, "websocket RPC", {
            method: rpc.method,
          })
          client.send({
            id: rpc.id,
            error: {
              message: sanitized.message,
              ...(sanitized.code ? { code: sanitized.code } : {}),
            },
          })
        } finally {
          client.rpcInFlight = Math.max(0, client.rpcInFlight - 1)
          resolveTask()
          this.rpcTasks.delete(task)
        }
      } catch (error) {
        logger.warn(
          { err: error, authenticated },
          "websocket message handling failed; closing socket"
        )
        socket.close(1011, "internal error")
      }
    })

    socket.on("close", () => {
      if (timer) clearTimeout(timer)
    })
  }

  /**
   * One liveness sweep: every open socket that has not answered the previous
   * ping is charged a miss; at the limit it is terminated (no close
   * handshake — the peer is presumed gone). Counters reset on `pong`.
   */
  private pingClients(): void {
    for (const socket of this.wss?.clients ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const misses = this.livenessMisses.get(socket) ?? 0
      if (misses >= LIVENESS_MISS_LIMIT) {
        logger.warn({ misses }, "terminating unresponsive WebSocket client")
        this.livenessMisses.delete(socket)
        socket.terminate()
        continue
      }
      this.livenessMisses.set(socket, misses + 1)
      try {
        socket.ping()
      } catch (error) {
        logger.warn({ err: error }, "websocket ping failed")
        socket.terminate()
      }
    }
  }

  private authenticateCredential(token: string): WsPrincipal | null {
    if (constantTimeEqual(token, this.authToken)) return { kind: "local" }
    return this.authenticateRemoteCredential(token)
  }

  private effectivePrincipal(
    principal: WsPrincipal | null,
    forceReadOnlyRemote: boolean
  ): WsPrincipal | null {
    if (!principal || !forceReadOnlyRemote) return principal
    if (principal.kind === "local") return null
    return { ...principal, accessLevel: "read_only" }
  }

  private authenticateRemoteCredential(
    token: string
  ): WsRemotePrincipal | null {
    try {
      const principal = this.options.authenticateToken?.(token) ?? null
      if (
        !principal ||
        principal.kind !== "remote" ||
        !principal.sessionId ||
        !Number.isFinite(principal.expiresAt) ||
        principal.expiresAt <= Date.now()
      ) {
        return null
      }
      return principal
    } catch (error) {
      logger.warn({ err: error }, "remote websocket authentication failed")
      return null
    }
  }

  private registerAuthenticatedClient(
    socket: WebSocket,
    principal: WsPrincipal
  ): ReplayClient {
    this.toolSnapshots.flush()
    const client: ReplayClient = {
      socket,
      principal,
      providerEventsReady: false,
      lastDeliveredProviderSequence: 0,
      authenticatedAtSequence: this.providerSequence,
      replayTimer: null,
      expiryTimer: null,
      rpcInFlight: 0,
      close: (code, reason) => socket.close(code, reason),
      // Same backpressure policy as broadcasts; `client` is referenced
      // lazily so the closure can be created before the object exists.
      send: (frame) => {
        this.sendSerializedFrame(client, JSON.stringify(frame))
      },
    }
    this.clients.add(client)
    if (principal.kind === "remote") {
      let sessionClients = this.remoteClientsBySession.get(principal.sessionId)
      if (!sessionClients) {
        sessionClients = new Set()
        this.remoteClientsBySession.set(principal.sessionId, sessionClients)
      }
      sessionClients.add(client)
      this.armRemoteSessionExpiry(client)
    }
    socket.on("close", () => {
      if (client.replayTimer) clearTimeout(client.replayTimer)
      client.replayTimer = null
      if (client.expiryTimer) clearTimeout(client.expiryTimer)
      client.expiryTimer = null
      this.clients.delete(client)
      if (client.principal.kind === "remote") {
        const sessionClients = this.remoteClientsBySession.get(
          client.principal.sessionId
        )
        sessionClients?.delete(client)
        if (sessionClients?.size === 0) {
          this.remoteClientsBySession.delete(client.principal.sessionId)
        }
      }
    })

    socket.send(
      JSON.stringify({
        type: "auth_ok",
        replay: {
          journalId: this.providerReplayJournalId,
          latestSequence: this.providerSequence,
        },
      })
    )

    // Older renderers do not negotiate replay. After a short grace period,
    // deliver only events emitted since authentication and then resume live
    // delivery so mixed-version desktop upgrades do not silently go stale.
    client.replayTimer = setTimeout(() => {
      this.replayProviderEvents(client, {
        type: "provider_replay",
        journalId: this.providerReplayJournalId,
        afterSequence: client.authenticatedAtSequence,
      })
    }, 1_000)
    return client
  }

  private isPrincipalValid(principal: WsPrincipal): boolean {
    if (principal.kind === "local") return true
    if (principal.expiresAt <= Date.now()) return false
    if (!this.options.revalidateRemoteSession) return true
    try {
      return this.options.revalidateRemoteSession(principal) === true
    } catch (error) {
      logger.warn(
        { err: error, sessionId: principal.sessionId },
        "remote websocket session revalidation failed"
      )
      return false
    }
  }

  private revalidateRemoteClients(): void {
    for (const client of this.clients) {
      if (
        client.principal.kind === "remote" &&
        !this.isPrincipalValid(client.principal)
      ) {
        client.close(WS_CLOSE_UNAUTHORIZED, "session expired or revoked")
      }
    }
  }

  private armRemoteSessionExpiry(client: ReplayClient): void {
    if (client.principal.kind !== "remote") return
    if (client.expiryTimer) clearTimeout(client.expiryTimer)
    const remaining = client.principal.expiresAt - Date.now()
    if (remaining <= 0) {
      client.close(WS_CLOSE_UNAUTHORIZED, "session expired")
      return
    }
    client.expiryTimer = setTimeout(
      () => {
        client.expiryTimer = null
        if (client.principal.kind !== "remote") return
        if (client.principal.expiresAt <= Date.now()) {
          client.close(WS_CLOSE_UNAUTHORIZED, "session expired")
        } else {
          this.armRemoteSessionExpiry(client)
        }
      },
      Math.min(remaining, 2_147_000_000)
    )
    client.expiryTimer.unref?.()
  }

  private replayProviderEvents(
    client: ReplayClient,
    request: ProviderReplayRequest
  ): void {
    this.toolSnapshots.flush()
    if (client.replayTimer) clearTimeout(client.replayTimer)
    client.replayTimer = null

    const journalChanged = request.journalId !== this.providerReplayJournalId
    const requestedAfter = !journalChanged ? request.afterSequence : 0
    const earliestAvailable =
      this.providerReplayJournal[0]?.frame.sequence ?? this.providerSequence + 1
    const retainedPrefixMissing = requestedAfter < earliestAvailable - 1
    const unavailableFrameMissing =
      this.lastUnavailableProviderSequence > requestedAfter
    if (journalChanged || retainedPrefixMissing || unavailableFrameMissing) {
      client.send({
        type: "provider_replay_gap",
        journalId: this.providerReplayJournalId,
        requestedAfterSequence: request.afterSequence,
        earliestAvailableSequence: earliestAvailable,
        latestSequence: this.providerSequence,
        reason: journalChanged
          ? "journal_changed"
          : unavailableFrameMissing
            ? "unavailable_frame"
            : "journal_truncated",
      })
    }

    const afterSequence = Math.max(
      requestedAfter,
      client.lastDeliveredProviderSequence
    )
    for (const entry of this.providerReplayJournal) {
      if (entry.frame.sequence > afterSequence) {
        this.sendProviderFrame(client, entry.frame, entry.serialized)
      }
    }
    client.providerEventsReady = true
    client.send({
      type: "provider_replay_complete",
      journalId: this.providerReplayJournalId,
      latestSequence: this.providerSequence,
    })
  }

  private sendProviderFrame(
    client: ReplayClient,
    frame: SequencedProviderFrame,
    serialized: string
  ): void {
    if (
      frame.sequence <= client.lastDeliveredProviderSequence ||
      client.socket.readyState !== WebSocket.OPEN
    ) {
      return
    }
    if (!this.sendSerializedFrame(client, serialized)) return
    client.lastDeliveredProviderSequence = frame.sequence
  }

  private sendSerializedFrame(
    client: ReplayClient,
    serialized: string
  ): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false
    if (client.socket.bufferedAmount > this.maxBufferedAmountBytes) {
      logger.warn(
        {
          bufferedAmount: client.socket.bufferedAmount,
          limit: this.maxBufferedAmountBytes,
        },
        "closing slow WebSocket client"
      )
      client.close(1013, "client backpressure limit exceeded")
      return false
    }
    client.socket.send(serialized)
    return true
  }
}

export function rejectUpgrade(
  socket: {
    end(chunk: string): unknown
    destroy(): unknown
    on(event: "error", listener: (error: Error) => void): unknown
    once(event: "finish", listener: () => void): unknown
  },
  status: number,
  reason: string
): void {
  // Same shape as ws's own `abortHandshake`. The raw upgrade socket has no
  // error listener yet, so a peer that already hung up would turn the write
  // into an uncaught `EPIPE`/`ECONNRESET` on the process — and it can fail
  // asynchronously after this function returned, so the listener stays
  // attached rather than `once`. `end()` + destroy-on-finish flushes the
  // status line before the FIN; `write()` + immediate `destroy()` could
  // discard it, and the client then saw a reset instead of the 4xx.
  socket.on("error", () => {})
  socket.once("finish", () => socket.destroy())
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

function isSecureUpgrade(
  request: IncomingMessage,
  options: Pick<WsHubOptions, "trustProxyHeaders" | "trustLoopbackProxyHeaders">
): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted === true)
    return true
  const loopbackProxyTrusted =
    options.trustLoopbackProxyHeaders?.() === true &&
    isLoopbackPeer(request.socket.remoteAddress)
  if (options.trustProxyHeaders !== true && !loopbackProxyTrusted) return false
  const forwarded = request.headers["x-forwarded-proto"]
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded
  return value?.split(",").at(-1)?.trim().toLowerCase() === "https"
}

function isLoopbackPeer(address: string | undefined): boolean {
  return typeof address === "string" && isLoopbackIpAddress(address)
}

function isTailnetUpgrade(
  request: IncomingMessage,
  options: Pick<
    WsHubOptions,
    "tailnetSelfAddresses" | "trustProxyHeaders" | "trustLoopbackProxyHeaders"
  >
): boolean {
  if (
    upgradeProxyHeadersTrusted(request, options) &&
    forwardedClientAddress(request.headers["x-forwarded-for"])
  )
    return false
  const own = options.tailnetSelfAddresses?.()
  if (!own || own.size === 0) return false
  const peer = request.socket.remoteAddress
  const local = request.socket.localAddress
  if (!peer || !local) return false
  return (
    isTailscaleAddress(peer) &&
    isTailscaleAddress(local) &&
    own.has(normalizeSocketAddress(local))
  )
}

/**
 * Mirrors the HTTP side (`remote/http.ts` `proxyHeadersTrusted`): a
 * configured proxy is trusted for every peer, a same-host TLS proxy only
 * while the request really arrived from loopback.
 */
function upgradeProxyHeadersTrusted(
  request: IncomingMessage,
  options: Pick<WsHubOptions, "trustProxyHeaders" | "trustLoopbackProxyHeaders">
): boolean {
  if (options.trustProxyHeaders === true) return true
  return (
    options.trustLoopbackProxyHeaders?.() === true &&
    isLoopbackPeer(request.socket.remoteAddress)
  )
}

function isPrivateNetworkUpgrade(
  request: IncomingMessage,
  options: Pick<WsHubOptions, "trustProxyHeaders" | "trustLoopbackProxyHeaders">
): boolean {
  const forwarded = upgradeProxyHeadersTrusted(request, options)
    ? forwardedClientAddress(request.headers["x-forwarded-for"])
    : null
  const client = forwarded ?? request.socket.remoteAddress
  return !!client && isPrivateLanAddress(client)
}

function isLoopbackUpgrade(
  request: IncomingMessage,
  options: Pick<WsHubOptions, "trustProxyHeaders" | "trustLoopbackProxyHeaders">
): boolean {
  // A same-host proxy may rewrite Host to loopback. Classify its forwarded
  // client, just like HTTP, before allowing the loopback transport exception.
  const forwarded = upgradeProxyHeadersTrusted(request, options)
    ? forwardedClientAddress(request.headers["x-forwarded-for"])
    : null
  if (!isLoopbackPeer(forwarded ?? request.socket.remoteAddress)) return false
  try {
    const hostname = new URL(`http://${request.headers.host ?? ""}`).hostname
    return isLoopbackHostname(hostname)
  } catch {
    return false
  }
}

interface AuthMessage {
  type: "auth"
  token: string
}

interface ProviderReplayRequest {
  type: "provider_replay"
  journalId: string
  afterSequence: number
}

function isAuthMessage(value: unknown): value is AuthMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "auth" &&
    typeof (value as { token?: unknown }).token === "string"
  )
}

function isProviderReplayRequest(
  value: unknown
): value is ProviderReplayRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "provider_replay" &&
    typeof (value as { journalId?: unknown }).journalId === "string" &&
    typeof (value as { afterSequence?: unknown }).afterSequence === "number" &&
    Number.isSafeInteger((value as { afterSequence: number }).afterSequence) &&
    (value as { afterSequence: number }).afterSequence >= 0
  )
}

function isProviderRuntimeFrame(value: unknown): value is {
  channel: "provider.runtimeEvent"
  data: unknown
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { channel?: unknown }).channel === "provider.runtimeEvent" &&
    "data" in value
  )
}
