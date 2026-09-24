import { isRecord } from "@betterc0de/schema/json-read"
import type {
  ConnectionProfile,
  RemoteBootstrap,
  RemotePairResponse,
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
    timestamp(value.expiresAt)
  )
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
    session: value.session,
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
    session: value.session,
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
    session: value.session,
  }
}
