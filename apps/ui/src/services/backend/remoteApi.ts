import type {
  PendingRemotePairingLink,
  RemoteBootstrapResponse,
  RemoteEndpoint,
  RemotePairingGrant,
  RemotePairingLink,
  RemoteSession,
  RemoteSessionClient,
  RemoteSessionList,
  RemoteStatus,
  TailscaleRemoteStatus,
} from "@betterc0de/schema/remote-protocol"
import type {
  HttpContractRequest,
  HttpContractResponse,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"
import { getRemoteBaseUrl } from "./runtime"

// The records the desktop's `/remote/*` routes answer are defined once, in
// `@betterc0de/schema/remote-protocol`, and the routes' contracts in
// `remote-contracts.ts`: the backend checks its responses against them, this
// module checks what it reads, and the phone app derives its own types.
export type {
  PendingRemotePairingLink,
  RemoteBootstrapResponse,
  RemoteEndpoint,
  RemotePairingGrant,
  RemotePairingLink,
  RemoteSession,
  RemoteSessionClient,
  RemoteSessionList,
  RemoteStatus,
  TailscaleRemoteStatus,
}

/** "2 terminals open", or `null` when the device runs none. */
export function describeRemoteTerminals(
  count: number | undefined
): string | null {
  if (!count || count < 1) return null
  return `${count} terminal${count === 1 ? "" : "s"} open`
}

const CLIENT_NAMES: Record<string, string> = {
  "betterc0de-remote": "BetterC0de Remote",
}
const PLATFORM_NAMES: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  web: "web",
}

/** "BetterC0de Remote 0.1.0-beta.3 on Android", or `null` for a browser session. */
export function describeRemoteClient(
  client: RemoteSessionClient | null | undefined
): string | null {
  if (!client) return null
  const name = CLIENT_NAMES[client.name] ?? client.name
  const platform = client.platform
    ? (PLATFORM_NAMES[client.platform] ?? client.platform)
    : null
  return `${name} ${client.version}${platform ? ` on ${platform}` : ""}`
}

/** What a device that pairs through this address may do, and for how long. */
export type RemotePairingAccess = "full" | "read-only"

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "::1" || /^127(\.\d+){3}$/.test(host)
}

/**
 * Mirrors the backend's pairing policy: a full 30-day session needs an
 * encrypted transport — HTTPS, this computer, or the tailnet (the WireGuard
 * tunnel). Plain HTTP across any other network, a private LAN included, is
 * readable by everyone on it, so pairing there yields a one-hour read-only
 * session.
 */
export function remotePairingAccess(endpoint: {
  id: string
  url: string
}): RemotePairingAccess {
  if (endpoint.id === "tailscale" || endpoint.id === "tailscale-ip") {
    return "full"
  }
  if (endpoint.id === "loopback") return "full"
  try {
    const url = new URL(endpoint.url)
    if (url.protocol === "https:") return "full"
    if (isLoopbackHostname(url.hostname)) return "full"
  } catch {
    // An unparsable address cannot be shown to be encrypted.
  }
  return "read-only"
}

/** Pending links that have not expired by `now`, newest first. */
export function activePairingLinks(
  links: readonly PendingRemotePairingLink[],
  now = Date.now()
): PendingRemotePairingLink[] {
  return links
    .filter((link) => Date.parse(link.expiresAt) > now)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function remoteOrigin(): string {
  const baseUrl = getRemoteBaseUrl()
  if (baseUrl) return baseUrl.replace(/\/+$/, "")
  return window.location.origin
}

/**
 * The two public routes (`/remote/bootstrap`, `/remote/pair`) go straight to
 * the desktop with the browser's cookie, before there is a session for the
 * backend transport to use. Their answers are checked against the same
 * contracts as every other route.
 */
async function publicRemoteRequest<K extends "remoteBootstrap" | "remotePair">(
  name: K,
  body?: HttpContractRequest<K>
): Promise<HttpContractResponse<K>> {
  // Keep validation schemas off the first-frame path, as `invokeContract` does.
  const { httpContracts } = await import("@betterc0de/schema/http-contracts")
  const contract = httpContracts[name]
  if (body !== undefined) contract.request.parse(body)
  const response = await fetch(`${remoteOrigin()}/api/v1${contract.path}`, {
    method: contract.method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = (payload as { error?: unknown } | null)?.error
    throw new Error(
      typeof error === "string" ? error : `HTTP ${response.status}`
    )
  }
  try {
    return contract.response.parse(payload) as HttpContractResponse<K>
  } catch {
    // Never include the payload: it carries the session.
    throw new Error(
      `Invalid backend response for ${contract.method} ${contract.path}`
    )
  }
}

export function getRemoteBootstrap(): Promise<RemoteBootstrapResponse> {
  return publicRemoteRequest("remoteBootstrap")
}

export function pairRemoteBrowser(
  credential: string,
  label: string
): Promise<RemoteBootstrapResponse> {
  return publicRemoteRequest("remotePair", { credential, label })
}

export function getRemoteStatus(): Promise<RemoteStatus> {
  return invokeContract("remoteStatus")
}

export function createRemotePairingLink(
  label = "Pairing link",
  ttlMinutes = 10
): Promise<RemotePairingGrant> {
  return invokeContract("remotePairingLinkCreate", {
    body: { label, ttlMinutes },
  })
}

/** Unredeemed, unexpired pairing links. Desktop host only. */
export async function listRemotePairingLinks(): Promise<
  PendingRemotePairingLink[]
> {
  return (await invokeContract("remotePairingLinkList")).pairingLinks
}

/** Withdraws one pairing link before anyone redeems it. Desktop host only. */
export function revokeRemotePairingLink(
  pairingId: string
): Promise<{ revoked: boolean }> {
  return invokeContract("remotePairingLinkRevoke", { params: { pairingId } })
}

/** Withdraws every pairing link nobody has redeemed. Desktop host only. */
export function revokeAllRemotePairingLinks(): Promise<{ revoked: number }> {
  return invokeContract("remotePairingLinkRevokeAll")
}

export function getTailscaleStatus(): Promise<TailscaleRemoteStatus> {
  return invokeContract("remoteTailscaleStatus")
}

export function setTailscaleServe(
  enabled: boolean
): Promise<TailscaleRemoteStatus> {
  return invokeContract("remoteTailscaleServe", { body: { enabled } })
}

export function listRemoteSessions(): Promise<RemoteSessionList> {
  return invokeContract("remoteSessionList")
}

export function revokeRemoteSession(
  sessionId: string
): Promise<{ revoked: boolean }> {
  return invokeContract("remoteSessionRevoke", { params: { sessionId } })
}

/** Ends a device's terminals and shell commands; the device stays paired. */
export function endRemoteSessionTerminals(
  sessionId: string
): Promise<{ ended: number }> {
  return invokeContract("remoteSessionTerminalsEnd", {
    params: { sessionId },
  })
}

export function revokeOtherRemoteSessions(): Promise<{ revoked: number }> {
  return invokeContract("remoteSessionRevokeOthers")
}

export function logoutRemoteSession(): Promise<{ loggedOut: boolean }> {
  return invokeContract("remoteLogout")
}
