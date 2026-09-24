import {
  REMOTE_API_VERSION,
  compareReleaseVersions,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"

/**
 * Protocol versions this build understands (see
 * packages/schema/src/remote-protocol.ts). 1 is a desktop that predates
 * protocol negotiation: chats work, newer features stay hidden.
 */
export const SUPPORTED_API_VERSIONS = {
  min: 1,
  max: REMOTE_API_VERSION,
} as const

export type Compatibility =
  /** Everything this build knows works. */
  | { kind: "ok" }
  /** A desktop from before protocol negotiation: basics only, suggest updating it. */
  | { kind: "legacy_desktop" }
  /** This app is too old for the desktop; the pairing stays valid. */
  | { kind: "app_update_required"; minClientVersion: string | null }
  /** The desktop is too old for this app. */
  | { kind: "desktop_update_required" }

export function assessCompatibility(
  protocol: RemoteProtocol | null,
  appVersion: string
): Compatibility {
  if (!protocol) return { kind: "legacy_desktop" }
  if (protocol.apiVersion > SUPPORTED_API_VERSIONS.max) {
    return {
      kind: "app_update_required",
      minClientVersion: protocol.minClientVersion,
    }
  }
  if (protocol.apiVersion < SUPPORTED_API_VERSIONS.min) {
    return { kind: "desktop_update_required" }
  }
  const order = compareReleaseVersions(appVersion, protocol.minClientVersion)
  if (order !== null && order < 0) {
    return {
      kind: "app_update_required",
      minClientVersion: protocol.minClientVersion,
    }
  }
  return { kind: "ok" }
}

/** The app cannot work with this desktop until one side is updated. */
export function needsUpdate(compatibility: Compatibility): boolean {
  return (
    compatibility.kind === "app_update_required" ||
    compatibility.kind === "desktop_update_required"
  )
}

/** Additive features are used only when the desktop lists them. */
export function hasFeature(
  protocol: RemoteProtocol | null,
  feature: string
): boolean {
  return protocol?.capabilities?.features.includes(feature) === true
}
