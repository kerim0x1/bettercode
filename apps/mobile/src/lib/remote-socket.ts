import { isRecord } from "@betterc0de/schema/json-read"
import type { ConnectionProfile } from "@/types/remote"
import { ProviderReplayCursor } from "@betterc0de/schema/provider-replay"
import { websocketUrl } from "./endpoint"

export type RemoteSocketState = "connecting" | "live" | "reconnecting" | "error"

/**
 * The backend closes a socket with this code when the session was
 * revoked, expired or never authenticated (`WS_CLOSE_UNAUTHORIZED`).
 * Reconnecting with the same token can only produce the same close.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401

/** The renderer waits this long for `auth_ok`; a silent socket is dead. */
const AUTH_HANDSHAKE_TIMEOUT_MS = 10_000

interface RemoteSocketOptions {
  onFrame: (frame: unknown) => void
  onState: (state: RemoteSocketState) => void
  /**
   * The backend refused the session. The socket stops retrying until
   * `reconnectNow()`; the caller re-checks the session and either clears
   * the pairing or, if the host still accepts it, reconnects explicitly.
   */
  onUnauthorized?: () => void
}

export class RemoteSocket {
  private socket: WebSocket | null = null
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private unauthorized = false
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly replay = new ProviderReplayCursor()

  constructor(
    private readonly profile: ConnectionProfile,
    private readonly options: RemoteSocketOptions
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
    this.unauthorized = false
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
    this.options.onState(reconnecting ? "reconnecting" : "connecting")
    const socket = new WebSocket(websocketUrl(this.profile.baseUrl))
    this.socket = socket
    let authenticated = false
    this.armHandshakeTimer(socket)

    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return
      socket.send(
        JSON.stringify({ type: "auth", token: this.profile.sessionToken })
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
        this.options.onState("live")
        const replay = this.replay.negotiate(frame.replay)
        if (replay) socket.send(JSON.stringify(replay))
        return
      }

      this.replay.deliver(frame, this.options.onFrame)
    }

    socket.onerror = () => {
      if (!this.stopped && this.socket === socket) this.options.onState("error")
    }

    socket.onclose = (event) => {
      const wasCurrent = this.socket === socket
      if (wasCurrent) {
        this.socket = null
        this.clearHandshakeTimer()
      }
      if (this.stopped || !wasCurrent) return
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        this.unauthorized = true
        this.options.onState("error")
        this.options.onUnauthorized?.()
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
    if (this.unauthorized) return
    this.reconnectAttempt += 1
    this.options.onState("reconnecting")
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
