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
