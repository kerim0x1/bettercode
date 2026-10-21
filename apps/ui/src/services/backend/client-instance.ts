import { isRemoteRuntime } from "./runtime"

/**
 * Names the page load that starts a terminal or shell run. The backend
 * records it as the owner, and the desktop shell asks the backend to end
 * that page's terminals and runs when the page crashes, reloads or its
 * window closes (`POST /shell/client/release`).
 */
export const CLIENT_INSTANCE_HEADER = "X-BetterC0de-Client-Instance"

/** Same shape the backend accepts. */
const CLIENT_INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

/**
 * This page's client instance id, as the desktop preload generated and
 * registered it, or null outside the desktop app.
 */
export function getClientInstanceId(): string | null {
  if (typeof window === "undefined") return null
  const id = window.electronAPI?.clientInstanceId
  return typeof id === "string" && CLIENT_INSTANCE_ID_RE.test(id) ? id : null
}

/**
 * Request options carrying the client instance header, for the requests that
 * start terminals and shell runs. Empty when there is no desktop shell to
 * release them, or when the backend is a remote one (its terminals are not
 * this shell's to end, and an older remote backend would refuse the header
 * in its CORS preflight).
 */
export function clientInstanceRequestOptions(): {
  headers?: Record<string, string>
} {
  const id = getClientInstanceId()
  if (!id || isRemoteRuntime()) return {}
  return { headers: { [CLIENT_INSTANCE_HEADER]: id } }
}
