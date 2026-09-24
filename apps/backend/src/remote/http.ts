import { createHash } from "node:crypto"
import os from "node:os"
import { isRecord } from "@betterc0de/schema"
import {
  REMOTE_CLIENT_HEADER,
  REMOTE_MIN_CLIENT_VERSION,
  parseRemoteClientHeader,
  remoteClientNeedsUpdate,
  type RemoteAccessLevel,
  type RemoteClientInfo,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { createRateLimiter } from "../http/middleware/rateLimit"
import { readCookie } from "../security/cookie"
import { constantTimeEqual } from "../security/token"
import {
  REMOTE_SESSION_COOKIE,
  type RemoteAccessService,
  type RemoteAccessSession,
} from "./service"
import {
  forwardedClientAddress,
  isLoopbackHostname,
  isLoopbackIpAddress,
  isPrivateLanAddress,
} from "./privateNetwork"
import { describeRemoteProtocol, publicRemoteProtocol } from "./protocol"
import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  isTailscaleAddress,
  normalizeSocketAddress,
  type TailscaleRemoteState,
} from "./tailscale"

export interface RemoteRequestIdentity {
  kind: "local" | "remote"
  session?: RemoteAccessSession
}

/**
 * Hono context slot holding the identity resolved for this request. Set once
 * by the router's auth middleware (or lazily by the first route that asks) so
 * a request never re-runs credential hashing and the session lookup.
 */
const IDENTITY_CONTEXT_KEY = "betterc0de.requestIdentity"

interface ResolvedRequestIdentity {
  readonly identity: RemoteRequestIdentity | null
}

export interface AdvertisedRemoteEndpoint {
  id: string
  label: string
  httpBaseUrl: string
  wsBaseUrl: string
  reachability: "loopback" | "lan" | "private-network" | "public"
  hostedHttpsCompatible: boolean
  isDefault: boolean
}

const INSECURE_REMOTE_SESSION_TTL_MS = 60 * 60 * 1000

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length).trim()
  return token || null
}

export function authenticateRemoteRequest(
  input: {
    authorization?: string
    cookie?: string
  },
  config: ServerConfig,
  remoteAccess?: RemoteAccessService
): RemoteRequestIdentity | null {
  const bearer = bearerToken(input.authorization)
  if (bearer) {
    if (config.authToken && constantTimeEqual(bearer, config.authToken)) {
      return { kind: "local" }
    }
    const remoteSession = remoteAccess?.authenticate(bearer)
    return remoteSession ? { kind: "remote", session: remoteSession } : null
  }

  const sessionToken = readCookie(input.cookie, REMOTE_SESSION_COOKIE)
  if (!sessionToken) return null
  const session = remoteAccess?.authenticate(sessionToken)
  return session ? { kind: "remote", session } : null
}

/**
 * Resolve the caller's identity once per request. The first call (normally
 * the router's auth middleware) authenticates and caches on the context;
 * every later call in the same request reads the cached result, including a
 * cached `null`. Routes mounted without the middleware (unit tests) still
 * authenticate correctly on their first call.
 */
export function resolveRequestIdentity(
  c: Context,
  config: ServerConfig,
  remoteAccess?: RemoteAccessService
): RemoteRequestIdentity | null {
  const cached = c.get(IDENTITY_CONTEXT_KEY) as
    | ResolvedRequestIdentity
    | undefined
  if (cached) return cached.identity
  const identity = authenticateRemoteRequest(
    {
      authorization: c.req.header("Authorization"),
      cookie: c.req.header("Cookie"),
    },
    config,
    remoteAccess
  )
  const resolved: ResolvedRequestIdentity = { identity }
  c.set(IDENTITY_CONTEXT_KEY, resolved)
  return identity
}

export function requestIdentity(
  c: Context,
  config: ServerConfig,
  state: AppState
): RemoteRequestIdentity | null {
  return resolveRequestIdentity(c, config, state.remoteAccess)
}

function remoteService(state: AppState): RemoteAccessService {
  if (!state.remoteAccess) throw new Error("Remote access is unavailable")
  return state.remoteAccess
}

export function isLocalOwnerRequest(
  c: Context,
  config: ServerConfig,
  state: AppState
): boolean {
  return requestIdentity(c, config, state)?.kind === "local"
}

/**
 * Rate-limit key for a request that may be unauthenticated: the forwarded
 * client address only when a proxy is explicitly trusted, else the direct
 * peer. Spoofed `X-Forwarded-For` values cannot mint fresh buckets.
 */
export function pairClientKey(c: Context, config: ServerConfig): string {
  const forwarded = trustedForwardedClient(c, config)
  if (forwarded) return `forwarded:${forwarded}`
  return `peer:${directPeerAddress(c) ?? "unknown"}`
}

/**
 * Whether this request's X-Forwarded-* headers come from a proxy we trust:
 * either an operator declared one (`trustProxyHeaders`), or Tailscale Serve
 * is on and the TCP peer is loopback — the only place that same-host proxy
 * can connect from. A remote peer's headers are never trusted this way, so
 * the rule can demote a loopback caller to "remote" but never promote one.
 */
function proxyHeadersTrusted(c: Context, config: ServerConfig): boolean {
  if (config.trustProxyHeaders === true) return true
  if (config.trustLoopbackProxyHeaders !== true) return false
  const peer = directPeerAddress(c)
  return peer !== null && isLoopbackIpAddress(peer)
}

/**
 * The client address a trusted proxy reported, or `null` when no proxy is
 * trusted or it reported nothing. Only ever consulted behind that trust:
 * without it the headers are attacker-controlled. `X-Real-IP` is not
 * read: a client can send it too, and unlike `X-Forwarded-For` a proxy
 * usually passes it through untouched instead of appending its own view.
 */
function trustedForwardedClient(
  c: Context,
  config: ServerConfig
): string | null {
  if (!proxyHeadersTrusted(c, config)) return null
  return forwardedClientAddress(c.req.header("X-Forwarded-For"))
}

/**
 * Where the request really came from: the forwarded client address when a
 * proxy is trusted, else the TCP peer. The same source `pairClientKey`
 * buckets on, so loopback classification and rate limiting cannot disagree
 * about who the caller is.
 */
function requestClientAddress(c: Context, config: ServerConfig): string | null {
  return trustedForwardedClient(c, config) ?? directPeerAddress(c)
}

export interface BootstrapRateLimitKeys {
  /** Shared by every caller behind one peer address; bounds credential hashing. */
  readonly peer: string
  /** Present only when a credential was offered: that device's own bucket. */
  readonly session: string | null
}

/**
 * Keys for the public bootstrap limiter. `null` for loopback peers — the
 * desktop renderer polls bootstrap and is never throttled. A tunnel or
 * reverse proxy folds every paired device into one peer address, so the
 * peer bucket is only a coarse hashing bound and each presented credential
 * gets its own bucket on top. The credential is hashed before it becomes a
 * key so the limiter never holds raw session tokens; a caller rotating
 * garbage credentials mints fresh session buckets but still drains the peer
 * bucket on every request.
 */
export function bootstrapRateLimitKeys(
  c: Context,
  config: ServerConfig
): BootstrapRateLimitKeys | null {
  if (requestPeerIsLoopback(c, config)) return null
  const credential =
    bearerToken(c.req.header("Authorization")) ??
    readCookie(c.req.header("Cookie"), REMOTE_SESSION_COOKIE)
  return {
    // Already carries its `peer:`/`forwarded:` prefix.
    peer: pairClientKey(c, config),
    session: credential
      ? `session:${createHash("sha256").update(credential).digest("base64url").slice(0, 32)}`
      : null,
  }
}

function requestIsSecure(c: Context, config: ServerConfig): boolean {
  if (proxyHeadersTrusted(c, config)) {
    const forwarded = c.req.header("X-Forwarded-Proto")
    if (forwarded) {
      // Match the client-address policy: only the value written by the
      // nearest trusted hop is authoritative; earlier values may be forged.
      return forwarded.split(",").at(-1)?.trim().toLowerCase() === "https"
    }
  }
  const incoming = incomingRequest(c)
  // HTTP/1 absolute-form request targets can name https:// over a plaintext
  // socket. Only the actual transport proves TLS when a socket is present.
  if (incoming?.socket) return incoming.socket.encrypted === true
  try {
    return new URL(c.req.url).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Plaintext that arrived through the Tailscale tunnel: the TCP peer is a
 * tailnet address and the local socket address is one of *this machine's*
 * tailnet addresses, so the packets came in on the WireGuard interface from
 * a peer Tailscale already authenticated. Encrypted end to end without TLS.
 * Behind a trusted proxy the direct peer is the proxy, so this never applies
 * to a forwarded request; and a machine whose ISP hands out 100.64/10 on a
 * physical NIC fails the local-address check because those addresses are not
 * in `tailscale status`.
 */
export function requestPeerIsTailnet(
  c: Context,
  config: ServerConfig
): boolean {
  if (trustedForwardedClient(c, config)) return false
  const own = config.tailnetSelfAddresses?.()
  if (!own || own.size === 0) return false
  const socket = incomingRequest(c)?.socket
  const peer = socket?.remoteAddress?.trim()
  const local = socket?.localAddress?.trim()
  if (!peer || !local) return false
  return (
    isTailscaleAddress(peer) &&
    isTailscaleAddress(local) &&
    own.has(normalizeSocketAddress(local))
  )
}

/**
 * Classifies LAN and VPN clients for private-network pairing. The address is the
 * forwarded one behind a trusted proxy, else the TCP peer — the same source
 * loopback classification uses. A public peer never qualifies, so a port
 * forwarded from a router without TLS still gets 426.
 */
export function requestPeerIsPrivateNetwork(
  c: Context,
  config: ServerConfig
): boolean {
  const client = requestClientAddress(c, config)
  return client !== null && isPrivateLanAddress(client)
}

/**
 * Transport the pairing and API routes accept without TLS: this computer,
 * the tailnet, a private network, or the explicit plaintext escape hatch.
 */
export function isRemoteRequestTransportAllowed(
  c: Context,
  config: ServerConfig
): boolean {
  return (
    requestIsSecure(c, config) ||
    requestPeerIsLoopback(c, config) ||
    requestPeerIsTailnet(c, config) ||
    requestPeerIsPrivateNetwork(c, config) ||
    config.allowInsecureRemoteAccess === true
  )
}

/**
 * Plaintext from a *public* peer. Only ever reachable with the plaintext
 * escape hatch, and then downgraded to read-only monitoring.
 */
export function isInsecureNonLoopbackRequest(
  c: Context,
  config: ServerConfig
): boolean {
  return (
    !requestIsSecure(c, config) &&
    !requestPeerIsLoopback(c, config) &&
    !requestPeerIsTailnet(c, config) &&
    !requestPeerIsPrivateNetwork(c, config)
  )
}

const READ_ONLY_REMOTE_GET_PATHS = [
  /^\/api\/v1\/remote\/status$/,
  /^\/api\/v1\/runtime\/health$/,
  /^\/api\/v1\/runtime\/capabilities$/,
  /^\/api\/v1\/settings$/,
  /^\/api\/v1\/ws-port$/,
  /^\/api\/v1\/projects$/,
  /^\/api\/v1\/providers$/,
  /^\/api\/v1\/models$/,
  /^\/api\/v1\/providers\/status$/,
  /^\/api\/v1\/providers\/instances$/,
  /^\/api\/v1\/providers\/instances\/[^/]+\/models$/,
  /^\/api\/v1\/threads$/,
  /^\/api\/v1\/threads\/stats$/,
  /^\/api\/v1\/threads\/[^/]+$/,
  /^\/api\/v1\/threads\/[^/]+\/(?:messages|activities|diffs|checkpoint-recovery)$/,
] as const

/**
 * Plaintext remote access is an explicit compatibility mode, not a way to
 * grant terminal or mutation rights. A session issued over plaintext stays
 * read-only even when replayed over TLS; any remote session used over
 * plaintext is also downgraded for that request.
 */
export function requiresReadOnlyRemoteAccess(
  c: Context,
  config: ServerConfig,
  identity: RemoteRequestIdentity
): boolean {
  return (
    identity.kind === "remote" &&
    (identity.session?.accessLevel === "read_only" ||
      isInsecureNonLoopbackRequest(c, config))
  )
}

/** The calling app's self-identification (`X-BetterC0de-Client`), if any. */
export function requestClientInfo(c: Context): RemoteClientInfo | null {
  return parseRemoteClientHeader(c.req.header(REMOTE_CLIENT_HEADER))
}

/**
 * The 426 an app below the desktop's minimum receives. Older apps show
 * `error` verbatim, so it has to make sense on its own.
 */
export function clientUpdateRequiredBody(): {
  error: string
  code: "client_update_required"
  minClientVersion: string
} {
  return {
    error:
      "This version of BetterC0de Remote is too old for this desktop. Update the app.",
    code: "client_update_required",
    minClientVersion: REMOTE_MIN_CLIENT_VERSION,
  }
}

/**
 * An app that has to update must still be able to sign out, so the desktop
 * does not keep a session the user can no longer reach.
 */
export function isClientUpdateGateExempt(c: Context): boolean {
  return c.req.method === "POST" && c.req.path === "/api/v1/remote/logout"
}

/** Access level of a remote caller for this request, plaintext downgrade included. */
export function effectiveRemoteAccessLevel(
  c: Context,
  config: ServerConfig,
  identity: RemoteRequestIdentity
): RemoteAccessLevel {
  return requiresReadOnlyRemoteAccess(c, config, identity)
    ? "read_only"
    : "full"
}

/**
 * The protocol block for this caller: version and minimum for anyone, the
 * capabilities only for an authenticated caller.
 */
export function requestRemoteProtocol(
  c: Context,
  config: ServerConfig,
  state: AppState,
  identity: RemoteRequestIdentity | null
): RemoteProtocol {
  if (!identity) return publicRemoteProtocol()
  if (identity.kind === "local") {
    return describeRemoteProtocol({
      accessLevel: "full",
      terminalAllowed: true,
    })
  }
  return describeRemoteProtocol({
    accessLevel: effectiveRemoteAccessLevel(c, config, identity),
    terminalAllowed:
      state.settings?.get().remote_access_allow_terminal === true,
  })
}

export function isReadOnlyRemoteRequestAllowed(c: Context): boolean {
  if (c.req.method === "POST" && c.req.path === "/api/v1/remote/logout") {
    return true
  }
  return (
    c.req.method === "GET" &&
    READ_ONLY_REMOTE_GET_PATHS.some((pattern) => pattern.test(c.req.path))
  )
}

/**
 * Endpoints a paired device may never reach, whatever its access level.
 * They write credentials, reshape provider configuration, expose host paths
 * and process internals, mint third-party tokens, or enumerate the whole
 * machine. "Full" remote access means the user's coding workflow, not
 * administration of the desktop host. `/filesystem/list` and
 * `/filesystem/search` are deliberately absent: the companion app browses
 * a thread's project through them, so they are confined to registered
 * workspace roots for remote callers inside the route instead.
 */
const DESKTOP_ONLY_PATHS: ReadonlyArray<{
  readonly methods: ReadonlySet<string> | null
  readonly pattern: RegExp
}> = [
  { methods: new Set(["POST"]), pattern: /^\/api\/v1\/workspace\/open$/ },
  // These templates merge host-global configuration, including arbitrary
  // environment values. MCP metadata has an explicit remote-safe projection
  // in its route; workspace approval cannot authorize raw host configuration.
  {
    methods: null,
    pattern: /^\/api\/v1\/workspace\/project-(?:lsp-servers|config)$/,
  },
  { methods: null, pattern: /^\/api\/v1\/providers\/[^/]+\/credential$/ },
  {
    methods: new Set(["POST"]),
    pattern: /^\/api\/v1\/providers\/instances\/[^/]+\/update$/,
  },
  { methods: null, pattern: /^\/api\/v1\/runtime\/debug-info$/ },
  { methods: null, pattern: /^\/api\/v1\/runtime\/heap-snapshot$/ },
  // Provider CLI reports include subscription quotas and local session
  // history; keep this host-local even for paired remote clients.
  { methods: null, pattern: /^\/api\/v1\/usage\// },
  { methods: null, pattern: /^\/api\/v1\/filesystem\/drives$/ },
  { methods: null, pattern: /^\/api\/v1\/settings\/deepgram-token$/ },
  // Themes: scanning this machine's editors and changing the stored set are
  // host decisions; reading them is how a paired browser matches the desktop.
  { methods: null, pattern: /^\/api\/v1\/themes\/installed$/ },
  { methods: new Set(["POST"]), pattern: /^\/api\/v1\/themes\/import$/ },
  { methods: new Set(["DELETE"]), pattern: /^\/api\/v1\/themes\/[^/]+$/ },
]

export function isDesktopOnlyRequest(c: Context): boolean {
  return DESKTOP_ONLY_PATHS.some(
    (entry) =>
      (entry.methods === null || entry.methods.has(c.req.method)) &&
      entry.pattern.test(c.req.path)
  )
}

/**
 * "Loopback" means the desktop renderer on this machine: never throttled,
 * never plaintext-downgraded. It is decided on the address the request came
 * from — the forwarded client behind a trusted proxy, else the TCP peer —
 * because a same-host reverse proxy makes every TCP peer 127.0.0.1. The
 * `Host` header only ever narrows the answer (a loopback peer asking for
 * a non-loopback name is DNS rebinding, not the renderer); whenever a peer
 * address is known it can never widen it. Hono's in-process `app.request`
 * (unit tests) has no socket at all, and only there does the URL decide.
 */
function requestPeerIsLoopback(c: Context, config: ServerConfig): boolean {
  const clientAddress = requestClientAddress(c, config)
  if (clientAddress && !isLoopbackIpAddress(clientAddress)) return false
  try {
    return isLoopbackHostname(new URL(c.req.url).hostname)
  } catch {
    return false
  }
}

function incomingRequest(c: Context):
  | {
      socket?: {
        remoteAddress?: string
        localAddress?: string
        encrypted?: boolean
      }
    }
  | undefined {
  const environment = c.env as
    | {
        incoming?: {
          socket?: {
            remoteAddress?: string
            localAddress?: string
            encrypted?: boolean
          }
        }
      }
    | undefined
  return environment?.incoming
}

function directPeerAddress(c: Context): string | null {
  return incomingRequest(c)?.socket?.remoteAddress?.trim() || null
}

function normalizeCustomEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null
    url.pathname = "/"
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

function endpoint(
  id: string,
  label: string,
  httpBaseUrl: string,
  reachability: AdvertisedRemoteEndpoint["reachability"],
  isDefault = false
): AdvertisedRemoteEndpoint {
  return {
    id,
    label,
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/i, "ws"),
    reachability,
    hostedHttpsCompatible: httpBaseUrl.startsWith("https://"),
    isDefault,
  }
}

/**
 * Tailnet endpoints. The tailnet IPv4 address is advertised as plain HTTP
 * whenever this machine is on a tailnet: the tunnel is the encryption and
 * the peer authentication, and `requestPeerIsTailnet` classifies requests on
 * it as private transport. The HTTPS name is added only while the serve
 * setting is on *and* Tailscale confirms a mapping to this backend's port —
 * a setting without a live mapping must not produce a dead pairing link.
 */
export async function discoverTailscaleEndpoints(
  config: ServerConfig,
  state: Pick<AppState, "settings" | "tailscale">
): Promise<AdvertisedRemoteEndpoint[]> {
  if (!state.tailscale) return []
  const found: AdvertisedRemoteEndpoint[] = []
  try {
    const status = await state.tailscale.status()
    const address =
      status.state === "running" ? status.tailnetIpv4Addresses[0] : null
    if (address) {
      found.push(
        endpoint(
          "tailscale-ip",
          "Tailscale",
          `http://${address}:${config.port}`,
          "private-network"
        )
      )
    }
    if (state.settings.get().remote_access_tailscale_serve === true) {
      const described = await state.tailscale.describe({
        localPort: config.port,
        serveEnabled: true,
      })
      // Listed after the address so the zero-config link stays recommended;
      // browsers that need a secure context pick this one deliberately.
      if (described.serveActive && described.httpsBaseUrl) {
        found.push(
          endpoint(
            "tailscale",
            "Tailscale HTTPS",
            described.httpsBaseUrl,
            "private-network"
          )
        )
      }
    }
  } catch {
    // Tailscale unreachable: no tailnet endpoints, the rest still works.
  }
  return found
}

export async function discoverRemoteEndpoints(
  config: ServerConfig,
  state: Pick<AppState, "settings" | "tailscale">
): Promise<AdvertisedRemoteEndpoint[]> {
  if (state.settings.get().remote_access_enabled !== true) return []

  const candidates: AdvertisedRemoteEndpoint[] = []
  const custom = normalizeCustomEndpoint(
    state.settings.get().remote_access_custom_url
  )
  if (
    custom &&
    (custom.startsWith("https://") ||
      isLoopbackHostname(new URL(custom).hostname) ||
      config.allowInsecureRemoteAccess === true)
  ) {
    candidates.push(
      endpoint(
        "custom",
        custom.startsWith("https://") ? "Public HTTPS" : "Custom endpoint",
        custom,
        "public",
        custom.startsWith("https://")
      )
    )
  }

  // An explicit public HTTPS endpoint stays the default when both exist;
  // tailnet links are still listed so a tailnet-only phone can use them.
  for (const tailnet of await discoverTailscaleEndpoints(config, state)) {
    if (candidates.some((candidate) => candidate.isDefault)) {
      tailnet.isDefault = false
    }
    candidates.push(tailnet)
  }

  // Private-network interfaces are always usable for pairing (see
  // `requestPeerIsPrivateNetwork`); a public interface address only with the
  // plaintext escape hatch, since a public peer is otherwise refused. The
  // tailnet address is advertised by `discoverTailscaleEndpoints` instead.
  const seen = new Set<string>()
  for (const [interfaceName, addresses] of Object.entries(
    os.networkInterfaces()
  )) {
    for (const address of addresses ?? []) {
      if (
        address.family !== "IPv4" ||
        address.internal ||
        address.address.startsWith("169.254.") ||
        isTailscaleAddress(address.address) ||
        seen.has(address.address)
      ) {
        continue
      }
      const privateNetwork = isPrivateLanAddress(address.address)
      if (!privateNetwork && config.allowInsecureRemoteAccess !== true) continue
      seen.add(address.address)
      const baseUrl = `http://${address.address}:${config.port}`
      candidates.push(
        endpoint(
          `network:${address.address}`,
          `${interfaceName} · ${address.address}`,
          baseUrl,
          privateNetwork ? "private-network" : "lan"
        )
      )
    }
  }

  candidates.push(
    endpoint(
      "loopback",
      "This computer",
      `http://127.0.0.1:${config.port}`,
      "loopback"
    )
  )

  if (!candidates.some((candidate) => candidate.isDefault)) {
    const preferred =
      candidates.find((candidate) => candidate.reachability !== "loopback") ??
      candidates[0]
    if (preferred) preferred.isDefault = true
  }
  return candidates
}

/** Shape of `/remote/tailscale`: detection plus what the setting asks for. */
export interface TailscaleRemoteStatusResponse extends TailscaleRemoteState {
  available: boolean
}

async function describeTailscale(
  config: ServerConfig,
  state: Pick<AppState, "settings" | "tailscale">
): Promise<TailscaleRemoteStatusResponse> {
  const serveEnabled =
    state.settings.get().remote_access_tailscale_serve === true
  if (!state.tailscale) {
    return {
      available: false,
      installed: false,
      state: "unavailable",
      magicDnsName: null,
      tailnetIpv4Addresses: [],
      selfAddresses: [],
      httpsCertificates: false,
      serveEnabled,
      serveActive: false,
      servePort: DEFAULT_TAILSCALE_SERVE_PORT,
      httpsBaseUrl: null,
    }
  }
  return {
    available: true,
    ...(await state.tailscale.describe({
      localPort: config.port,
      serveEnabled,
    })),
  }
}

function pairingUrl(baseUrl: string, credential: string): string {
  const url = new URL("/", baseUrl)
  url.hash = new URLSearchParams({ token: credential }).toString()
  return url.toString()
}

function consumePairingRateLimit(
  c: Context,
  config: ServerConfig,
  pairRateLimiter: ReturnType<typeof createRateLimiter>,
  globalPairRateLimiter: ReturnType<typeof createRateLimiter>
): { allowed: boolean; retryAfterMs: number } {
  // The client bucket is drawn first: one abusive peer that is already
  // refused must not keep draining the process-wide budget every other
  // device shares, or it could lock everyone out of pairing.
  const clientRate = pairRateLimiter.consume(pairClientKey(c, config))
  if (!clientRate.allowed) return clientRate
  const globalRate = globalPairRateLimiter.consume("global")
  return {
    allowed: globalRate.allowed,
    retryAfterMs: Math.max(globalRate.retryAfterMs, clientRate.retryAfterMs),
  }
}

/**
 * Reject abusive pairing attempts before any request-body middleware starts
 * buffering the payload. Both browser and native pairing share the same
 * per-peer and process-wide budgets.
 */
export function createPairingAdmissionMiddleware(
  config: ServerConfig
): MiddlewareHandler {
  const pairRateLimiter = createRateLimiter({
    capacity: 8,
    refillPerSecond: 1 / 15,
    maxKeys: 2_000,
  })
  const globalPairRateLimiter = createRateLimiter({
    capacity: 64,
    refillPerSecond: 2,
    maxKeys: 1,
  })

  return async (c, next) => {
    if (c.req.method !== "POST") return next()
    const rate = consumePairingRateLimit(
      c,
      config,
      pairRateLimiter,
      globalPairRateLimiter
    )
    if (!rate.allowed) {
      c.header(
        "Retry-After",
        String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000)))
      )
      return c.json(
        { error: "too many pairing attempts", code: "rate_limited" },
        429
      )
    }
    return next()
  }
}

function pairingSessionRestrictions(
  c: Context,
  config: ServerConfig
): { sessionTtlMs?: number; accessLevel: "full" | "read_only" } {
  return isInsecureNonLoopbackRequest(c, config)
    ? {
        sessionTtlMs: INSECURE_REMOTE_SESSION_TTL_MS,
        accessLevel: "read_only",
      }
    : { accessLevel: "full" }
}

/** Public bootstrap + one-time pairing exchange routes. */
export function registerRemotePublicRoutes(
  app: Hono,
  config: ServerConfig,
  state: AppState
): void {
  app.get("/api/v1/remote/bootstrap", (c) => {
    c.header("Cache-Control", "no-store")
    const enabled = state.remoteAccess?.enabled() === true
    if (
      !isRemoteRequestTransportAllowed(c, config) &&
      (c.req.header("Authorization") !== undefined ||
        c.req.header("Cookie") !== undefined)
    ) {
      return c.json(
        {
          error: "secure transport required",
          code: "secure_transport_required",
        },
        426
      )
    }
    const identity = requestIdentity(c, config, state)
    return c.json({
      enabled,
      authenticated: identity !== null,
      authentication: identity?.kind ?? null,
      session: identity?.session ?? null,
      environmentId: enabled
        ? (state.remoteAccess?.environmentId() ?? null)
        : null,
      protocol: requestRemoteProtocol(c, config, state, identity),
    })
  })

  // Browser clients receive the session as an HttpOnly cookie.
  app.post("/api/v1/remote/pair", (c) =>
    handlePairing(c, config, state, "cookie")
  )

  /**
   * Native clients cannot reliably extract or persist an HttpOnly Set-Cookie
   * credential. Keep their token exchange on a dedicated endpoint so the web
   * pairing response can never start exposing session credentials to browser
   * JavaScript by accident.
   */
  app.post("/api/v1/remote/mobile/pair", (c) =>
    handlePairing(c, config, state, "bearer")
  )
}

/**
 * One pairing exchange, two credential deliveries. Everything up to the
 * issued session is identical; only where the token goes differs, and that
 * choice is the caller's route, never request data.
 */
async function handlePairing(
  c: Context,
  config: ServerConfig,
  state: AppState,
  delivery: "cookie" | "bearer"
): Promise<Response> {
  const service = state.remoteAccess
  if (!service?.enabled()) {
    return c.json(
      { error: "remote access is disabled", code: "remote_access_disabled" },
      403
    )
  }
  if (!isRemoteRequestTransportAllowed(c, config)) {
    return c.json(
      { error: "secure transport required", code: "secure_transport_required" },
      426
    )
  }
  // Refused before the one-time code is spent, so the same code still works
  // after the app is updated.
  const client = requestClientInfo(c)
  if (remoteClientNeedsUpdate(client)) {
    return c.json(clientUpdateRequiredBody(), 426)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(
      { error: "invalid pairing request", code: "invalid_request" },
      400
    )
  }
  if (!isRecord(body)) {
    return c.json(
      { error: "invalid pairing request", code: "invalid_request" },
      400
    )
  }
  const credential =
    typeof body.credential === "string" && body.credential.length <= 64
      ? body.credential
      : ""
  const label =
    typeof body.label === "string" && body.label.length <= 80
      ? body.label
      : undefined
  const issued = service.consumePairingCredential(credential, {
    label,
    ...pairingSessionRestrictions(c, config),
  })
  if (!issued) {
    return c.json(
      {
        error: "pairing code is invalid or expired",
        code: "pairing_code_invalid",
      },
      401
    )
  }
  if (client) service.noteClient(issued.id, client)

  const session = {
    id: issued.id,
    label: issued.label,
    accessLevel: issued.accessLevel,
    createdAt: issued.createdAt,
    lastSeenAt: issued.lastSeenAt,
    expiresAt: issued.expiresAt,
    client,
  }
  const protocol = describeRemoteProtocol({
    accessLevel: issued.accessLevel,
    terminalAllowed:
      state.settings?.get().remote_access_allow_terminal === true,
  })
  c.header("Cache-Control", "no-store")
  if (delivery === "cookie") {
    const maxAge = Math.max(
      1,
      Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000)
    )
    setCookie(c, REMOTE_SESSION_COOKIE, issued.token, {
      httpOnly: true,
      maxAge,
      path: "/",
      sameSite: "Strict",
      secure: requestIsSecure(c, config),
    })
    return c.json({
      enabled: true,
      authenticated: true,
      authentication: "remote",
      environmentId: service.environmentId(),
      session,
      protocol,
    })
  }
  c.header("Pragma", "no-cache")
  return c.json({
    enabled: true,
    authenticated: true,
    authentication: "remote",
    environmentId: service.environmentId(),
    tokenType: "Bearer",
    sessionToken: issued.token,
    session,
    protocol,
  })
}

/** Authenticated remote-management routes mounted under `/api/v1`. */
export function registerRemoteRoutes(
  api: Hono,
  config: ServerConfig,
  state: AppState
): void {
  api.get("/remote/status", async (c) => {
    const service = remoteService(state)
    const identity = requestIdentity(c, config, state)
    return c.json({
      enabled: service.enabled(),
      listeningOnNetwork:
        service.enabled() &&
        config.host !== "127.0.0.1" &&
        config.host !== "localhost",
      environmentId: service.environmentId(),
      host: config.host,
      port: config.port,
      authentication: identity?.kind ?? null,
      currentSessionId: identity?.session?.id ?? null,
      endpoints: await discoverRemoteEndpoints(config, state),
    })
  })

  /**
   * Tailscale is a desktop-host concern: only the owner sees whether the
   * machine is on a tailnet or flips the serve mapping. A paired device gets
   * the resulting endpoint through `/remote/status` like any other.
   */
  api.get("/remote/tailscale", async (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "Tailscale status is only available to the desktop host" },
        403
      )
    }
    return c.json(await describeTailscale(config, state))
  })

  api.post("/remote/tailscale/serve", async (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "Tailscale Serve can only be changed by the desktop host" },
        403
      )
    }
    if (!state.tailscale) {
      return c.json({ error: "Tailscale integration is unavailable" }, 503)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid request" }, 400)
    }
    if (!isRecord(body)) return c.json({ error: "invalid request" }, 400)
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400)
    }
    if (body.enabled && !remoteService(state).enabled()) {
      return c.json({ error: "remote access is disabled" }, 409)
    }
    try {
      if (body.enabled) {
        await state.tailscale.enableServe(config.port)
      } else {
        await state.tailscale.disableServe()
      }
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Tailscale command failed",
        },
        502
      )
    }
    // Persist after the CLI accepted the change: a failed `tailscale serve`
    // must not leave a setting claiming an endpoint that does not exist.
    // The settings watcher flips `trustLoopbackProxyHeaders` from here.
    await state.settings.updatePublic({
      remote_access_tailscale_serve: body.enabled,
    })
    return c.json(await describeTailscale(config, state))
  })

  api.post("/remote/pairing-links", async (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "pairing links can only be created by the desktop host" },
        403
      )
    }
    const service = remoteService(state)
    if (!service.enabled()) {
      return c.json({ error: "remote access is disabled" }, 409)
    }
    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      // An empty body is valid and uses safe defaults.
    }
    if (!isRecord(body)) return c.json({ error: "invalid request" }, 400)
    const ttlMinutes =
      typeof body.ttlMinutes === "number" && Number.isFinite(body.ttlMinutes)
        ? body.ttlMinutes
        : undefined
    const grant = service.issuePairingGrant({
      label: typeof body.label === "string" ? body.label : undefined,
      ttlMs: ttlMinutes === undefined ? undefined : ttlMinutes * 60 * 1000,
    })
    const endpoints = await discoverRemoteEndpoints(config, state)
    return c.json({
      ...grant,
      links: endpoints.map((candidate) => ({
        endpointId: candidate.id,
        label: candidate.label,
        url: pairingUrl(candidate.httpBaseUrl, grant.credential),
        isDefault: candidate.isDefault,
      })),
    })
  })

  api.get("/remote/sessions", (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "remote sessions can only be managed by the desktop host" },
        403
      )
    }
    const service = remoteService(state)
    const identity = requestIdentity(c, config, state)
    return c.json({
      currentSessionId: identity?.session?.id ?? null,
      sessions: service.listSessions(),
    })
  })

  api.delete("/remote/sessions/:sessionId", async (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "remote sessions can only be managed by the desktop host" },
        403
      )
    }
    const service = remoteService(state)
    const sessionId = c.req.param("sessionId")
    if (!sessionId || sessionId.length > 100) {
      return c.json({ error: "invalid session id" }, 400)
    }
    return c.json({
      revoked: await service.revokeSessionAndWait(sessionId),
    })
  })

  api.post("/remote/sessions/revoke-others", async (c) => {
    if (!isLocalOwnerRequest(c, config, state)) {
      return c.json(
        { error: "remote sessions can only be managed by the desktop host" },
        403
      )
    }
    const service = remoteService(state)
    const identity = requestIdentity(c, config, state)
    return c.json({
      revoked: await service.revokeOtherSessionsAndWait(identity?.session?.id),
    })
  })

  api.post("/remote/logout", async (c) => {
    const service = remoteService(state)
    const identity = requestIdentity(c, config, state)
    if (identity?.session) {
      await service.revokeSessionAndWait(identity.session.id)
    }
    deleteCookie(c, REMOTE_SESSION_COOKIE, { path: "/" })
    return c.json({ loggedOut: identity?.kind === "remote" })
  })
}
