import {
  DEFAULT_PERMISSION_LEVEL,
  permissionLevelLabel,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"
import type { RemoteProtocol } from "@betterc0de/schema/remote-protocol"

/**
 * Bypass hands the agent an unattended shell, so the desktop allows it from
 * a paired phone only under the terminal's rule: "Allow terminal from remote
 * devices" is on and the session is a full one, which the desktop states as
 * `capabilities.terminalGranted`. Without it, the desktop runs a Bypass
 * message as Ask first and refuses to switch a turn to Bypass
 * (`remote_bypass_disabled`). A desktop that states no capabilities predates
 * the rule and does not limit Bypass.
 */
export function bypassAllowed(protocol: RemoteProtocol | null): boolean {
  return protocol?.capabilities?.terminalGranted !== false
}

/** The line under the unavailable Bypass row in the permissions menu. */
export const BYPASS_UNAVAILABLE_HINT =
  "Needs “Allow terminal from remote devices” on the desktop"

/** The preset a chat keeps when Bypass is not allowed: never Bypass itself. */
export function presetWithoutBypass(level: PermissionLevel): PermissionLevel {
  return level === "bypass" ? DEFAULT_PERMISSION_LEVEL : level
}

/** Why the chat does not use Bypass, and the preset it uses instead. */
export function bypassUnavailableNotice(kept: PermissionLevel): {
  readonly title: string
  readonly description: string
} {
  return {
    title: "Bypass is off for this phone",
    description: `The desktop allows Bypass from a paired phone only when Settings → Remote Access → Allow terminal from remote devices is on. This chat uses ${permissionLevelLabel(kept)}.`,
  }
}
