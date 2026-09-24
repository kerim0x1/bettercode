import type { ConnectionState, SocketState } from "@/store/session-store"

export type ConnectionBadgeKind =
  | "demo"
  | "live"
  | "watching"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "remote_disabled"

export interface ConnectionBadge {
  readonly kind: ConnectionBadgeKind
  readonly label: string
  /** Whether the app can act right now (drives the pill's colour). */
  readonly healthy: boolean
}

/**
 * The pill in every header. It says "Live" only when the desktop answered
 * the last check *and* the live channel is up; a failing channel used to
 * keep showing "Online".
 */
export function connectionBadge(input: {
  mode: "live" | "demo" | null
  state: ConnectionState
  socketState: SocketState
  readOnly: boolean
}): ConnectionBadge {
  if (input.mode === "demo")
    return { kind: "demo", label: "Demo", healthy: true }
  if (input.state === "remote_disabled") {
    return { kind: "remote_disabled", label: "Remote off", healthy: false }
  }
  if (input.state === "offline")
    return { kind: "offline", label: "Offline", healthy: false }
  if (input.state === "online" && input.socketState === "live") {
    return input.readOnly
      ? { kind: "watching", label: "Watching", healthy: true }
      : { kind: "live", label: "Live", healthy: true }
  }
  if (
    input.state === "online" &&
    (input.socketState === "error" || input.socketState === "reconnecting")
  ) {
    return { kind: "reconnecting", label: "Reconnecting", healthy: false }
  }
  return { kind: "connecting", label: "Connecting", healthy: false }
}
