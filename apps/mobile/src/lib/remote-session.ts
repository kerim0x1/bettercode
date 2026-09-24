import { isRecord } from "@betterc0de/schema/json-read"
import { remoteProtocolSchema } from "@betterc0de/schema/remote-protocol"
import type {
  ConnectionProfile,
  RemoteBootstrap,
  RemotePairResponse,
  RemoteProtocol,
  RemoteSessionSummary,
} from "@/types/remote"
import { normalizeBaseUrl } from "./endpoint"

function text(value: unknown, limit = 512): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit
  )
}

function timestamp(value: unknown): value is string {
  return text(value, 64) && Number.isFinite(Date.parse(value))
}

function session(value: unknown): value is RemoteSessionSummary {
  return (
    isRecord(value) &&
    text(value.id) &&
    text(value.label) &&
    timestamp(value.createdAt) &&
    timestamp(value.lastSeenAt) &&
    timestamp(value.expiresAt) &&
    (value.accessLevel === undefined || text(value.accessLevel, 64))
  )
}

/** Only the fields the app relies on; anything else a newer desktop adds is dropped. */
function sessionSummary(value: RemoteSessionSummary): RemoteSessionSummary {
  return {
    id: value.id,
    label: value.label,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
    expiresAt: value.expiresAt,
    // A level this app does not know is treated as the safe one.
    ...(value.accessLevel
      ? { accessLevel: value.accessLevel === "full" ? "full" : "read_only" }
      : {}),
  }
}

/**
 * The desktop's protocol block. Absent on desktops that predate it; a block
 * this app cannot read is treated the same way instead of failing the
 * connection, so the version check can still tell the user what to update.
 */
export function parseRemoteProtocol(value: unknown): RemoteProtocol | null {
  if (value === undefined || value === null) return null
  const parsed = remoteProtocolSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function token(value: unknown): value is string {
  return text(value, 4096) && !/\s/.test(value)
}

export function parseConnectionProfile(value: unknown): ConnectionProfile {
  if (
    !isRecord(value) ||
    !text(value.baseUrl, 4096) ||
    !text(value.environmentId) ||
    !token(value.sessionToken) ||
    !timestamp(value.pairedAt) ||
    !session(value.session)
  ) {
    throw new Error("Invalid stored remote profile.")
  }
  return {
    baseUrl: normalizeBaseUrl(value.baseUrl),
    environmentId: value.environmentId,
    sessionToken: value.sessionToken,
    pairedAt: value.pairedAt,
    session: sessionSummary(value.session),
  }
}

export function parseRemotePairResponse(value: unknown): RemotePairResponse {
  if (
    !isRecord(value) ||
    value.enabled !== true ||
    value.authenticated !== true ||
    value.authentication !== "remote" ||
    value.tokenType !== "Bearer" ||
    !text(value.environmentId) ||
    !token(value.sessionToken) ||
    !session(value.session)
  ) {
    throw new Error("Invalid backend pairing response.")
  }
  return {
    enabled: true,
    authenticated: true,
    authentication: "remote",
    tokenType: "Bearer",
    environmentId: value.environmentId,
    sessionToken: value.sessionToken,
    session: sessionSummary(value.session),
    protocol: parseRemoteProtocol(value.protocol),
  }
}

export function parseRemoteBootstrap(value: unknown): RemoteBootstrap {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.authenticated !== "boolean" ||
    (value.authentication !== null &&
      value.authentication !== "local" &&
      value.authentication !== "remote") ||
    (value.environmentId !== null && !text(value.environmentId)) ||
    (value.session !== null && !session(value.session)) ||
    (value.authentication === "remote" &&
      (!value.authenticated || !session(value.session)))
  ) {
    throw new Error("Invalid backend session response.")
  }
  return {
    enabled: value.enabled,
    authenticated: value.authenticated,
    authentication: value.authentication,
    environmentId: value.environmentId,
    session: value.session === null ? null : sessionSummary(value.session),
    protocol: parseRemoteProtocol(value.protocol),
  }
}
