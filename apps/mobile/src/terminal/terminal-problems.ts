import type { TerminalClosedReason } from "@betterc0de/schema/remote-terminal"
import { remoteErrorMessage } from "@/lib/remote-errors"

/** Where a desktop allows terminals from paired devices. */
export const TERMINAL_SETTING =
  "Allow terminal from remote devices, in the desktop's Settings → Remote Access"

/** A terminal the desktop refused or lost, in words a user can act on. */
export function terminalProblem(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case "remote_terminal_disabled":
      return `The desktop does not allow terminals from this phone: turn on ${TERMINAL_SETTING}. A phone that can only watch gets none.`
    case "terminal_limit":
      return "Too many terminals are open on the desktop. End one, then open a new one."
    case "workspace_not_registered":
    case "workspace_unavailable":
      return "The desktop does not know this chat's folder as a workspace, so it opens no terminal there."
    case "connection_lost":
    case "timeout":
      return "The desktop cannot be reached right now."
    case "terminal_not_found":
      return "The terminal is gone on the desktop."
    case "terminal_exited":
      return "The terminal has ended."
    case "shutting_down":
      return "The desktop is shutting down."
    default:
      return remoteErrorMessage(error)
  }
}

/** Why the desktop closed a terminal, for the phone. */
export function terminalClosedMessage(reason: TerminalClosedReason): string {
  switch (reason) {
    case "grant_revoked":
      return `The desktop no longer allows terminals from paired devices (${TERMINAL_SETTING}).`
    case "detached":
      return "The terminal ended: the phone was away from it for 15 minutes."
    case "ended_on_desktop":
      return "The terminal was ended on the desktop."
    default:
      return "The terminal was closed."
  }
}
