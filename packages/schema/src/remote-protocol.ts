import { z } from "zod"

/**
 * How a paired device (the phone app, apps/mobile) and the desktop find out
 * whether they still understand each other.
 *
 * The phone app compiles the HTTP contracts in, and an installed app can be
 * weeks older or newer than the desktop it pairs with: store updates and
 * desktop auto-updates never land at the same moment. The desktop therefore
 * describes its protocol in `/remote/bootstrap`, in the pairing response and
 * in the WebSocket `auth_ok` frame, and refuses apps it can no longer serve.
 *
 * `REMOTE_API_VERSION` changes only for a change an installed app cannot
 * handle: a removed or renamed field, a new value in a response enum, or
 * different authentication or semantics. Additive changes are announced in
 * `capabilities.features` instead, and the app uses a feature only when the
 * desktop lists it.
 *
 *   1  desktops that predate this block (bootstrap has no `protocol`)
 *   2  this block, the app version gate, a `code` on every refusal
 */
export const REMOTE_API_VERSION = 2

/** The oldest phone app release the desktop still serves. */
export const REMOTE_MIN_CLIENT_VERSION = "0.1.0-beta.1"

/** Request header naming the calling app: `betterc0de-remote/<version> (<platform>)`. */
export const REMOTE_CLIENT_HEADER = "X-BetterC0de-Client"

/**
 * WebSocket close code for an app below `minClientVersion`. It must differ
 * from 4401 (unauthorized), which makes the app discard its pairing.
 */
export const WS_CLOSE_CLIENT_UPDATE_REQUIRED = 4426

/** Additive capabilities, listed in `capabilities.features` when available. */
export const REMOTE_FEATURES = {
  /** `GET /threads/:id` returns one thread with its session state. */
  threadsGet: "threads.get",
  /** `/workspace/read` returns `sha256`; `/workspace/write` honours `expectedSha256`. */
  workspaceWriteIfMatch: "workspace.write.ifMatch",
  /**
   * `POST /threads/:id/title` renames a chat, and every connected client
   * hears the new title (`thread.metadata`), so the rename sticks.
   */
  threadsRename: "threads.rename",
  /**
   * A `/chat/send` with `prepareTurn` gets the desktop's own preparation:
   * the user's "on message send" hooks run first (one that fails refuses
   * the message, `message_hook_failed`), and the turn gets the system
   * instruction the desktop builds for its own messages.
   */
  preparedTurns: "chat.preparedTurns",
  /**
   * A terminal over the WebSocket (`remote-terminal.ts`), for a device the
   * desktop allows one (`capabilities.terminalGranted`).
   */
  terminal: "terminal.ws",
} as const
export type RemoteFeature =
  (typeof REMOTE_FEATURES)[keyof typeof REMOTE_FEATURES]

export const remoteAccessLevelSchema = z.enum(["full", "read_only"])

export const remoteCapabilitiesSchema = z
  .object({
    /** Effective for this request or connection; an unknown value reads as read-only. */
    accessLevel: remoteAccessLevelSchema.catch("read_only"),
    /** The desktop allows this device a terminal ("Allow terminal from remote devices"). */
    terminalGranted: z.boolean(),
    /** Largest request body the API accepts, in bytes. */
    maxRequestBytes: z.number().int().positive(),
    features: z.array(z.string().min(1).max(64)).max(128),
  })
  .passthrough()

export const remoteProtocolSchema = z
  .object({
    apiVersion: z.number().int().positive(),
    minClientVersion: z.string().min(1).max(64),
    /** Desktop release; only sent to authenticated callers. */
    backendVersion: z.string().min(1).max(64).optional(),
    /** Only sent to authenticated callers. */
    capabilities: remoteCapabilitiesSchema.optional(),
  })
  .passthrough()

export type RemoteAccessLevel = z.infer<typeof remoteAccessLevelSchema>
export type RemoteCapabilities = z.infer<typeof remoteCapabilitiesSchema>
export type RemoteProtocol = z.infer<typeof remoteProtocolSchema>

// ---------------------------------------------------------------------------
// Remote access records
// ---------------------------------------------------------------------------
//
// What the desktop's `/remote/*` routes answer (`apps/backend/src/remote`),
// read by the desktop renderer's remote settings and by the phone app. The
// backend checks its responses against these types; the objects pass
// unknown fields through, so a newer desktop can add one. The phone parses
// these responses with its own lenient readers (`lib/remote-session.ts`)
// and keeps its types derived from these.

/** A schema whose parsed value and accepted input are both `T`. */
type RecordSchema<T> = z.ZodType<T, T>

/** How the caller is signed in: on this computer, as a paired device, or not. */
export type RemoteAuthentication = "local" | "remote" | null

const remoteAuthenticationSchema = z.enum(["local", "remote"]).nullable()

/** The app a paired device identified itself as (the phone app sends this). */
export interface RemoteSessionClient {
  name: string
  version: string
  platform: string | null
}

export const remoteSessionClientSchema: RecordSchema<RemoteSessionClient> = z
  .object({
    name: z.string(),
    version: z.string(),
    platform: z.string().nullable(),
  })
  .passthrough()

/** A paired device's session. */
export interface RemoteSession {
  id: string
  label: string
  /**
   * `read_only` for a session paired over plain HTTP: it can watch, not
   * operate, and lasts one hour. Desktops older than access levels omit it.
   */
  accessLevel?: RemoteAccessLevel
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  client?: RemoteSessionClient | null
  /**
   * The device's running terminals and shell commands; only the desktop's
   * own list of devices has it.
   */
  terminals?: number
}

export const remoteSessionSchema: RecordSchema<RemoteSession> = z
  .object({
    id: z.string(),
    label: z.string(),
    accessLevel: remoteAccessLevelSchema.optional(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    expiresAt: z.string(),
    client: remoteSessionClientSchema.nullable().optional(),
    terminals: z.number().optional(),
  })
  .passthrough()

/** `GET /remote/bootstrap`, public: whether and how the caller is signed in. */
export interface RemoteBootstrapResponse {
  enabled: boolean
  authenticated: boolean
  authentication: RemoteAuthentication
  session: RemoteSession | null
  /** `null` while remote access is off. */
  environmentId: string | null
  /** Absent from desktops that predate protocol negotiation (API version 1). */
  protocol?: RemoteProtocol
}

export const remoteBootstrapResponseSchema: RecordSchema<RemoteBootstrapResponse> =
  z
    .object({
      enabled: z.boolean(),
      authenticated: z.boolean(),
      authentication: remoteAuthenticationSchema,
      session: remoteSessionSchema.nullable(),
      environmentId: z.string().nullable(),
      protocol: remoteProtocolSchema.optional(),
    })
    .passthrough()

/** `POST /remote/pair`: a browser paired; the session rides in a cookie. */
export interface RemoteBrowserPairResponse {
  enabled: true
  authenticated: true
  authentication: "remote"
  environmentId: string
  session: RemoteSession
  protocol?: RemoteProtocol
}

/** `POST /remote/mobile/pair`: a native app paired and holds a bearer token. */
export interface RemoteMobilePairResponse extends RemoteBrowserPairResponse {
  tokenType: "Bearer"
  sessionToken: string
}

const remoteBrowserPairFields = {
  enabled: z.literal(true),
  authenticated: z.literal(true),
  authentication: z.literal("remote"),
  environmentId: z.string(),
  session: remoteSessionSchema,
  protocol: remoteProtocolSchema.optional(),
}

export const remoteBrowserPairResponseSchema: RecordSchema<RemoteBrowserPairResponse> =
  z.object(remoteBrowserPairFields).passthrough()

export const remoteMobilePairResponseSchema: RecordSchema<RemoteMobilePairResponse> =
  z
    .object({
      ...remoteBrowserPairFields,
      tokenType: z.literal("Bearer"),
      sessionToken: z.string(),
    })
    .passthrough()

/** How far an advertised address reaches. */
export type RemoteEndpointReachability =
  | "loopback"
  | "lan"
  | "private-network"
  | "public"

/** An address the desktop can be paired and reached at. */
export interface RemoteEndpoint {
  id: string
  label: string
  httpBaseUrl: string
  wsBaseUrl: string
  reachability: RemoteEndpointReachability
  hostedHttpsCompatible: boolean
  isDefault: boolean
}

export const remoteEndpointSchema: RecordSchema<RemoteEndpoint> = z
  .object({
    id: z.string(),
    label: z.string(),
    httpBaseUrl: z.string(),
    wsBaseUrl: z.string(),
    reachability: z.enum(["loopback", "lan", "private-network", "public"]),
    hostedHttpsCompatible: z.boolean(),
    isDefault: z.boolean(),
  })
  .passthrough()

/** `GET /remote/status`: the desktop's remote access and its addresses. */
export interface RemoteStatus {
  enabled: boolean
  listeningOnNetwork: boolean
  environmentId: string
  host: string
  port: number
  authentication: RemoteAuthentication
  currentSessionId: string | null
  endpoints: RemoteEndpoint[]
}

export const remoteStatusSchema: RecordSchema<RemoteStatus> = z
  .object({
    enabled: z.boolean(),
    listeningOnNetwork: z.boolean(),
    environmentId: z.string(),
    host: z.string(),
    port: z.number(),
    authentication: remoteAuthenticationSchema,
    currentSessionId: z.string().nullable(),
    endpoints: z.array(remoteEndpointSchema),
  })
  .passthrough()

/** `GET /remote/sessions`, desktop host only: every paired device. */
export interface RemoteSessionList {
  currentSessionId: string | null
  sessions: RemoteSession[]
}

export const remoteSessionListSchema: RecordSchema<RemoteSessionList> = z
  .object({
    currentSessionId: z.string().nullable(),
    sessions: z.array(remoteSessionSchema),
  })
  .passthrough()

/** One address a pairing link opens. */
export interface RemotePairingLink {
  endpointId: string
  label: string
  url: string
  isDefault: boolean
}

/** `POST /remote/pairing-links`: a new code and the links that carry it. */
export interface RemotePairingGrant {
  id: string
  credential: string
  label: string
  createdAt: string
  expiresAt: string
  links: RemotePairingLink[]
}

export const remotePairingGrantSchema: RecordSchema<RemotePairingGrant> = z
  .object({
    id: z.string(),
    credential: z.string(),
    label: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    links: z.array(
      z
        .object({
          endpointId: z.string(),
          label: z.string(),
          url: z.string(),
          isDefault: z.boolean(),
        })
        .passthrough()
    ),
  })
  .passthrough()

/**
 * An unredeemed pairing link as the desktop lists it later
 * (`GET /remote/pairing-links`). The code itself is shown once, at
 * creation, and never listed again.
 */
export type PendingRemotePairingLink = Pick<
  RemotePairingGrant,
  "id" | "label" | "createdAt" | "expiresAt"
>

export const pendingRemotePairingLinkSchema: RecordSchema<PendingRemotePairingLink> =
  z
    .object({
      id: z.string(),
      label: z.string(),
      createdAt: z.string(),
      expiresAt: z.string(),
    })
    .passthrough()

/** `GET /remote/tailscale`, desktop host only: the tailnet and the serve mapping. */
export interface TailscaleRemoteStatus {
  /** Backend has the integration wired (always true on a real backend). */
  available: boolean
  installed: boolean
  state: "running" | "needs-login" | "stopped" | "unavailable"
  magicDnsName: string | null
  tailnetIpv4Addresses: string[]
  /** Every address Tailscale assigned to this machine (IPv4 and IPv6). */
  selfAddresses: string[]
  /** The tailnet issues HTTPS certificates (admin console → DNS → HTTPS). */
  httpsCertificates: boolean
  /** The persisted setting. */
  serveEnabled: boolean
  /** Tailscale currently maps `https://<magicDnsName>` to this backend. */
  serveActive: boolean
  servePort: number
  httpsBaseUrl: string | null
  /**
   * The Tailscale service answered. `false` with state `stopped` means the
   * daemon itself is not running (Windows service stopped, app quit), not
   * that Tailscale is merely disconnected.
   */
  serviceRunning?: boolean
  /** MagicDNS is on for the tailnet, when Tailscale reports it. */
  magicDnsEnabled?: boolean | null
  /**
   * The HTTPS name answered as this desktop: `null` while unchecked,
   * `false` while it does not (yet), e.g. while Tailscale issues the
   * certificate on the first request.
   */
  serveReachable?: boolean | null
  /** Why the last attempt to turn on Tailscale Serve failed. */
  serveError?: string | null
  /**
   * Tailscale's own page for allowing Serve on this tailnet, when the CLI
   * asked for that consent (`https://login.tailscale.com/f/serve?node=…`).
   */
  serveConsentUrl?: string | null
}

export const tailscaleRemoteStatusSchema: RecordSchema<TailscaleRemoteStatus> =
  z
    .object({
      available: z.boolean(),
      installed: z.boolean(),
      state: z.enum(["running", "needs-login", "stopped", "unavailable"]),
      magicDnsName: z.string().nullable(),
      tailnetIpv4Addresses: z.array(z.string()),
      selfAddresses: z.array(z.string()),
      httpsCertificates: z.boolean(),
      serveEnabled: z.boolean(),
      serveActive: z.boolean(),
      servePort: z.number(),
      httpsBaseUrl: z.string().nullable(),
      serviceRunning: z.boolean().optional(),
      magicDnsEnabled: z.boolean().nullable().optional(),
      serveReachable: z.boolean().nullable().optional(),
      serveError: z.string().nullable().optional(),
      serveConsentUrl: z.string().nullable().optional(),
    })
    .passthrough()

// ---------------------------------------------------------------------------
// Release versions
// ---------------------------------------------------------------------------

const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface ParsedReleaseVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

export function parseReleaseVersion(
  value: string
): ParsedReleaseVersion | null {
  const match = RELEASE_VERSION.exec(value.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split(".") : []
  // Semver forbids leading zeros in numeric prerelease identifiers.
  if (
    prerelease.some(
      (part) => /^\d+$/.test(part) && !NUMERIC_IDENTIFIER.test(part)
    )
  ) {
    return null
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  }
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left)
  const rightNumeric = NUMERIC_IDENTIFIER.test(right)
  if (leftNumeric && rightNumeric)
    return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Semantic-version order: `0.1.0-beta.2 < 0.1.0-beta.10 < 0.1.0-rc.1 <
 * 0.1.0`. Build metadata is ignored. Returns `null` when either value is not
 * a version, so callers decide what an unreadable version means.
 */
export function compareReleaseVersions(
  left: string,
  right: string
): number | null {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    const order = Math.sign(a.core[index]! - b.core[index]!)
    if (order !== 0) return order
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length)
  }
  for (
    let index = 0;
    index < Math.min(a.prerelease.length, b.prerelease.length);
    index += 1
  ) {
    const order = comparePrereleaseIdentifier(
      a.prerelease[index]!,
      b.prerelease[index]!
    )
    if (order !== 0) return order
  }
  return Math.sign(a.prerelease.length - b.prerelease.length)
}

// ---------------------------------------------------------------------------
// Client identification
// ---------------------------------------------------------------------------

export interface RemoteClientInfo {
  /** App name, e.g. `betterc0de-remote`. */
  readonly name: string
  readonly version: string
  /** `ios`, `android`, `web`, … when the app says. */
  readonly platform: string | null
}

const CLIENT_HEADER_VALUE =
  /^([a-z][a-z0-9-]{0,39})\/(\S{1,64})(?: \(([a-z][a-z0-9-]{0,15})\))?$/

/** Reads `betterc0de-remote/0.1.0-beta.3 (ios)`; anything else is `null`. */
export function parseRemoteClientHeader(
  value: string | null | undefined
): RemoteClientInfo | null {
  const match = CLIENT_HEADER_VALUE.exec(value?.trim() ?? "")
  if (!match || !parseReleaseVersion(match[2]!)) return null
  return { name: match[1]!, version: match[2]!, platform: match[3] ?? null }
}

export function formatRemoteClientHeader(info: RemoteClientInfo): string {
  return `${info.name}/${info.version}${info.platform ? ` (${info.platform})` : ""}`
}

/**
 * The same identification inside the WebSocket `auth` frame, where a phone
 * cannot always set upgrade headers. Invalid or absent values read as `null`.
 */
export function parseRemoteClientInfo(value: unknown): RemoteClientInfo | null {
  if (!value || typeof value !== "object") return null
  const { name, version, platform } = value as Record<string, unknown>
  if (typeof name !== "string" || typeof version !== "string") return null
  const platformText =
    typeof platform === "string" && platform ? platform : null
  return parseRemoteClientHeader(
    formatRemoteClientHeader({ name, version, platform: platformText })
  )
}

/**
 * True only for an app that identified itself with a version below the
 * minimum. An app that sends no identification predates it and is served
 * while the minimum still includes the first releases.
 */
export function remoteClientNeedsUpdate(
  client: RemoteClientInfo | null,
  minClientVersion: string = REMOTE_MIN_CLIENT_VERSION
): boolean {
  if (!client) return false
  const order = compareReleaseVersions(client.version, minClientVersion)
  return order !== null && order < 0
}
