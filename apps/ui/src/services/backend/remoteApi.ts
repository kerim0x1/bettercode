import { getRemoteBaseUrl, invoke } from "./runtime"

/** The app a paired device identified itself as (the phone app sends this). */
export interface RemoteSessionClient {
  name: string
  version: string
  platform: string | null
}

export interface RemoteSession {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  client?: RemoteSessionClient | null
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

export interface RemoteBootstrapResponse {
  enabled: boolean
  authenticated: boolean
  authentication: "local" | "remote" | null
  session: RemoteSession | null
  environmentId: string | null
}

export interface RemoteEndpoint {
  id: string
  label: string
  httpBaseUrl: string
  wsBaseUrl: string
  reachability: "loopback" | "lan" | "private-network" | "public"
  hostedHttpsCompatible: boolean
  isDefault: boolean
}

export interface RemoteStatus {
  enabled: boolean
  listeningOnNetwork: boolean
  environmentId: string
  host: string
  port: number
  authentication: "local" | "remote" | null
  currentSessionId: string | null
  endpoints: RemoteEndpoint[]
}

export interface TailscaleRemoteStatus {
  /** Backend has the integration wired (always true on a real backend). */
  available: boolean
  installed: boolean
  state: "running" | "needs-login" | "stopped" | "unavailable"
  magicDnsName: string | null
  tailnetIpv4Addresses: string[]
  /** The tailnet issues HTTPS certificates (admin console → DNS → HTTPS). */
  httpsCertificates: boolean
  /** The persisted setting. */
  serveEnabled: boolean
  /** Tailscale currently maps `https://<magicDnsName>` to this backend. */
  serveActive: boolean
  servePort: number
  httpsBaseUrl: string | null
}

export interface RemotePairingLink {
  endpointId: string
  label: string
  url: string
  isDefault: boolean
}

export interface RemotePairingGrant {
  id: string
  credential: string
  label: string
  createdAt: string
  expiresAt: string
  links: RemotePairingLink[]
}

function remoteOrigin(): string {
  const baseUrl = getRemoteBaseUrl()
  if (baseUrl) return baseUrl.replace(/\/+$/, "")
  return window.location.origin
}

async function publicRemoteRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${remoteOrigin()}/api/v1/remote${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown
  } & T
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`
    )
  }
  return body
}

export function getRemoteBootstrap(): Promise<RemoteBootstrapResponse> {
  return publicRemoteRequest<RemoteBootstrapResponse>("/bootstrap")
}

export function pairRemoteBrowser(
  credential: string,
  label: string
): Promise<RemoteBootstrapResponse> {
  return publicRemoteRequest<RemoteBootstrapResponse>("/pair", {
    method: "POST",
    body: JSON.stringify({ credential, label }),
  })
}

export function getRemoteStatus(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("/remote/status")
}

export function createRemotePairingLink(
  label = "Pairing link",
  ttlMinutes = 10
): Promise<RemotePairingGrant> {
  return invoke<RemotePairingGrant>("/remote/pairing-links", {
    method: "POST",
    body: { label, ttlMinutes },
  })
}

export function getTailscaleStatus(): Promise<TailscaleRemoteStatus> {
  return invoke<TailscaleRemoteStatus>("/remote/tailscale")
}

export function setTailscaleServe(
  enabled: boolean
): Promise<TailscaleRemoteStatus> {
  return invoke<TailscaleRemoteStatus>("/remote/tailscale/serve", {
    method: "POST",
    body: { enabled },
  })
}

export function listRemoteSessions(): Promise<{
  currentSessionId: string | null
  sessions: RemoteSession[]
}> {
  return invoke("/remote/sessions")
}

export function revokeRemoteSession(
  sessionId: string
): Promise<{ revoked: boolean }> {
  return invoke(`/remote/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
}

export function revokeOtherRemoteSessions(): Promise<{ revoked: number }> {
  return invoke("/remote/sessions/revoke-others", { method: "POST" })
}

export function logoutRemoteSession(): Promise<{ loggedOut: boolean }> {
  return invoke("/remote/logout", { method: "POST" })
}
