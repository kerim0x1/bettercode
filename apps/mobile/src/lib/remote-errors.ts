import { RemoteApiError } from "@/transport/live/http"

/** What the user can do about a failure. */
export type RemoteErrorAction =
  | "retry"
  | "wait"
  | "pair_again"
  | "update_app"
  | "update_desktop"
  /** The desktop will never accept this message id again; only a new message helps. */
  | "send_as_new"

export interface RemoteErrorDescription {
  readonly title: string
  readonly message: string
  readonly action?: RemoteErrorAction
}

/**
 * Every refusal and failure a paired phone can meet, in words a user can act
 * on. The codes are the desktop's (docs/remote-access.md, "Phone app and
 * desktop versions"); older desktops send none, so the status decides then.
 */
export function describeRemoteError(error: unknown): RemoteErrorDescription {
  if (!(error instanceof RemoteApiError)) {
    return {
      title: "Something went wrong",
      message:
        error instanceof Error && error.message
          ? error.message
          : "The request failed.",
      action: "retry",
    }
  }
  switch (error.code) {
    case "client_update_required":
      return {
        title: "Update BetterC0de Remote",
        message: error.details.minClientVersion
          ? `This desktop needs version ${error.details.minClientVersion} or newer of the app.`
          : "This desktop needs a newer version of the app.",
        action: "update_app",
      }
    case "secure_transport_required":
      return {
        title: "Use a private or secure address",
        message:
          "The desktop accepts plain HTTP only on your network or tailnet. Connect over Wi-Fi or Tailscale, or use the HTTPS address from Settings → Remote Access.",
        action: "retry",
      }
    case "pairing_code_invalid":
      return {
        title: "Pairing code expired",
        message:
          "The code was already used or has expired. Create a new one on the desktop.",
        action: "pair_again",
      }
    case "remote_access_disabled":
      return {
        title: "Remote Access is off",
        message:
          "Turn on Settings → Remote Access on the desktop, then try again.",
        action: "retry",
      }
    case "remote_read_only":
      return {
        title: "This phone can only watch",
        message:
          "It paired over plain HTTP from outside your network. Pair it again over your Wi-Fi, Tailscale or HTTPS to work with the desktop.",
        action: "pair_again",
      }
    case "desktop_only":
    case "remote_host_owner_required":
      return {
        title: "Desktop only",
        message: "Only the desktop itself can do this.",
      }
    case "remote_terminal_disabled":
      return {
        title: "Terminal is off",
        message:
          "On the desktop, turn on Settings → Remote Access → Allow terminal from remote devices.",
      }
    case "workspace_not_registered":
      return {
        title: "Project not open on the desktop",
        message: "Open this folder as a project in the desktop app first.",
      }
    case "request_too_large":
      return {
        title: "Too large",
        message: "This is more than the desktop accepts in one request.",
      }
    case "rate_limited":
      return {
        title: "Too many requests",
        message: error.details.retryAfterMs
          ? `Try again in ${Math.max(1, Math.ceil(error.details.retryAfterMs / 1000))} seconds.`
          : "Wait a moment, then try again.",
        action: "wait",
      }
    case "turn_active":
    case "dispatch_in_progress":
      return {
        title: "The agent is still working",
        message: "Wait for the current reply, or stop it first.",
        action: "wait",
      }
    case "dispatch_id_conflict":
      return {
        title: "Message conflict",
        message: "This message was already sent with different content.",
        action: "send_as_new",
      }
    case "dispatch_outcome_unknown":
      return {
        title: "Not known if it arrived",
        message:
          "The desktop restarted while it took this message. If the reply is missing, send it again as a new message.",
        action: "send_as_new",
      }
    case "dispatch_failed":
      return {
        title: "The agent refused the message",
        message:
          "The desktop could not start it. Send it again as a new message.",
        action: "send_as_new",
      }
    case "dispatch_reverted":
      return {
        title: "Message undone",
        message:
          "It was removed when the chat was rewound on the desktop. Send it again as a new message.",
        action: "send_as_new",
      }
    case "timeout":
      return {
        title: "No answer from the desktop",
        message:
          "It did not answer in time. Check that it is awake and reachable, then try again.",
        action: "retry",
      }
    case "network":
      return {
        title: "Desktop unreachable",
        message:
          "Check that this phone and the desktop are on the same network or tailnet, and that BetterC0de is running.",
        action: "retry",
      }
    case "cancelled":
      return { title: "Cancelled", message: "The request was cancelled." }
  }
  switch (error.status) {
    case 401:
      return {
        title: "Signed out",
        message: "The desktop no longer accepts this phone. Pair it again.",
        action: "pair_again",
      }
    case 403:
      return { title: "Not allowed", message: error.message }
    case 426:
      return {
        title: "Use a private or secure address",
        message:
          "The desktop accepts plain HTTP only on your network or tailnet. Connect over Wi-Fi or Tailscale, or use its HTTPS address.",
        action: "retry",
      }
    case 429:
      return {
        title: "Too many requests",
        message: "Wait a moment, then try again.",
        action: "wait",
      }
    case 503:
      return {
        title: "Desktop busy",
        message:
          "The desktop is starting or shutting down. Try again in a moment.",
        action: "retry",
      }
  }
  return {
    title: error.status >= 500 ? "Desktop error" : "Request failed",
    message: error.message,
    action: "retry",
  }
}

/** The one-line form for places that show only text. */
export function remoteErrorMessage(error: unknown): string {
  return describeRemoteError(error).message
}
