import type { Context } from "hono"
import type { ServerConfig } from "../config"
import {
  requiresReadOnlyRemoteAccess,
  type RemoteRequestIdentity,
} from "../remote/http"

export interface RemoteTerminalRefusal {
  readonly error: string
  readonly code: "remote_terminal_disabled"
}

/**
 * A paired device gets a terminal only when the desktop owner has turned on
 * `remote_access_allow_terminal` AND the session is a full one — a read-only
 * or plaintext-downgraded session never gets a shell, whatever the setting
 * says. Returns the refusal to send, or `null` when the device may proceed.
 * Shared by every route that hands a remote caller a shell and by the
 * WebSocket terminal (ws/terminalChannel.ts), so the grant cannot be
 * honoured on one path and forgotten on another.
 */
export function remoteTerminalRefusalFor(access: {
  /** `remote_access_allow_terminal` on the desktop. */
  readonly granted: boolean
  /** A full session, over a transport that does not downgrade it. */
  readonly fullSession: boolean
}): RemoteTerminalRefusal | null {
  if (!access.granted) {
    return {
      error:
        "Terminal access from paired devices is disabled on the desktop host.",
      code: "remote_terminal_disabled",
    }
  }
  if (!access.fullSession) {
    return {
      error:
        "This remote session is read-only; terminal access requires a full session.",
      code: "remote_terminal_disabled",
    }
  }
  return null
}

/**
 * `remoteTerminalRefusalFor` for an HTTP request: the refusal to send (a 403
 * body), or `null` when the caller may proceed — including every non-remote
 * caller, which desktop rules govern.
 */
export function remoteTerminalRefusal(
  c: Context,
  config: ServerConfig,
  identity: RemoteRequestIdentity | null,
  settings: { get(): { remote_access_allow_terminal?: boolean } } | undefined
): RemoteTerminalRefusal | null {
  if (identity?.kind !== "remote") return null
  return remoteTerminalRefusalFor({
    granted: settings?.get().remote_access_allow_terminal === true,
    fullSession:
      identity.session?.accessLevel === "full" &&
      !requiresReadOnlyRemoteAccess(c, config, identity),
  })
}
