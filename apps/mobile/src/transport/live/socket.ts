import { isRecord } from "@betterc0de/schema/json-read"
import { ProviderReplayCursor } from "@betterc0de/schema/provider-replay"
import {
  WS_CLOSE_CLIENT_UPDATE_REQUIRED,
  type RemoteClientInfo,
} from "@betterc0de/schema/remote-protocol"
import { websocketUrl } from "@/lib/endpoint"
import { parseRemoteProtocol } from "@/lib/remote-session"
import type { ChannelHandlers, RemoteChannel } from "../types"

/**
 * The backend closes a socket with this code when the session was
 * revoked, expired or never authenticated (`WS_CLOSE_UNAUTHORIZED`).
 * Reconnecting with the same token can only produce the same close.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401

/** The renderer waits this long for `auth_ok`; a silent socket is dead. */
const AUTH_HANDSHAKE_TIMEOUT_MS = 10_000

export interface SocketConnection {
  readonly baseUrl: string
  readonly sessionToken: string
  /** Sent in the `auth` frame so the desktop can ask a too-old app to update. */
  readonly client: RemoteClientInfo | null
}

/**
 * The desktop's live event stream. Authenticates in-band, replays what it
 * missed while disconnected (`provider_replay`), reconnects with backoff,
 * and stops for good on 4401 (session gone) or 4426 (app too old) until the
 * caller decides what to do.
 */
export class RemoteSocket implements RemoteChannel {
  private socket: WebSocket | null = null
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private halted = false
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly replay = new ProviderReplayCursor()

  constructor(
    private readonly connection: SocketConnection,
    private readonly handlers: ChannelHandlers
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect(false)
  }

  stop(): void {
    this.stopped = true
    this.clearHandshakeTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "app stopped")
  }

  reconnectNow(): void {
    if (this.stopped) return
    this.halted = false
    this.clearHandshakeTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const current = this.socket
    this.socket = null
    current?.close()
    this.connect(true)
  }

  private connect(reconnecting: boolean): void {
    if (this.stopped) return
    this.handlers.onState(reconnecting ? "reconnecting" : "connecting")
    const socket = new WebSocket(websocketUrl(this.connection.baseUrl))
    this.socket = socket
    let authenticated = false
    this.armHandshakeTimer(socket)

    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return
      socket.send(
        JSON.stringify({
          type: "auth",
          token: this.connection.sessionToken,
          ...(this.connection.client ? { client: this.connection.client } : {}),
        })
      )
    }

    socket.onmessage = (message) => {
      if (this.stopped || this.socket !== socket) return
      if (typeof message.data !== "string") return
      let frame: unknown
      try {
        frame = JSON.parse(message.data)
      } catch {
        return
      }
      if (!isRecord(frame)) return
      if (!authenticated) {
        if (frame.type !== "auth_ok") return
        authenticated = true
        this.clearHandshakeTimer()
        this.reconnectAttempt = 0
        this.handlers.onState("live")
        this.handlers.onProtocol?.(parseRemoteProtocol(frame.protocol))
        const replay = this.replay.negotiate(frame.replay)
        if (replay) socket.send(JSON.stringify(replay))
        return
      }
      if (frame.type === "protocol_update") {
        this.handlers.onProtocol?.(parseRemoteProtocol(frame.protocol))
        return
      }

      this.replay.deliver(frame, this.handlers.onFrame)
    }

    socket.onerror = () => {
      if (!this.stopped && this.socket === socket)
        this.handlers.onState("error")
    }

    socket.onclose = (event) => {
      const wasCurrent = this.socket === socket
      if (wasCurrent) {
        this.socket = null
        this.clearHandshakeTimer()
      }
      if (this.stopped || !wasCurrent) return
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        this.halted = true
        this.handlers.onState("error")
        this.handlers.onUnauthorized?.()
        return
      }
      if (event.code === WS_CLOSE_CLIENT_UPDATE_REQUIRED) {
        this.halted = true
        this.handlers.onState("error")
        this.handlers.onUpdateRequired?.()
        return
      }
      this.scheduleReconnect()
    }
  }

  /**
   * A socket that opens but never answers `auth` is dead in a way
   * `onclose` never reports (a half-open tunnel, a proxy that buffers).
   * Close it ourselves so the normal retry ladder runs.
   */
  private armHandshakeTimer(socket: WebSocket): void {
    this.clearHandshakeTimer()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (this.socket !== socket) return
      socket.close(4000, "auth handshake timed out")
    }, AUTH_HANDSHAKE_TIMEOUT_MS)
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  private scheduleReconnect(): void {
    if (this.halted) return
    this.reconnectAttempt += 1
    this.handlers.onState("reconnecting")
    const delay = Math.min(
      15_000,
      700 * 2 ** Math.min(this.reconnectAttempt, 5)
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect(true)
    }, delay)
  }
}
