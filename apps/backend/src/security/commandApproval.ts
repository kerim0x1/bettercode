import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { getMasterKey } from "../settings/crypto"

/**
 * Verifies the approval markers the desktop app stores next to commands it
 * runs later without anyone watching (hooks). The desktop's main process
 * writes a marker only after the user allowed the exact command in a native
 * dialog (apps/shell/shared/command-approval.cjs); this is the same check, so
 * a command the backend runs on its own (a phone message's hooks) is one the
 * user approved, not one a renderer or another program wrote into the file.
 *
 * Marker: `{ v: 1, alg, digest }` over `JSON.stringify([kind, command])`:
 *  - `hmac-sha256`: HMAC-SHA256 under
 *    HMAC-SHA256(settingsKey, "betterc0de/command-approval/v1"), where
 *    settingsKey is the 32-byte settings master key;
 *  - `sha256`: a plain digest, written only when the desktop has no OS
 *    credential storage (and so no settings key).
 * A keyed marker counts only while the key is available and a plain one
 * only while it is not, exactly as on the desktop.
 */

const APPROVAL_VERSION = 1
const APPROVAL_KEY_LABEL = "betterc0de/command-approval/v1"

export interface CommandApprovalMarker {
  readonly v: number
  readonly alg: "hmac-sha256" | "sha256"
  readonly digest: string
}

function approvalKey(settingsKey: Buffer | null): Buffer | null {
  if (!settingsKey || settingsKey.length !== 32) return null
  return createHmac("sha256", settingsKey).update(APPROVAL_KEY_LABEL).digest()
}

function canonicalCommand(kind: string, command: string): string {
  return JSON.stringify([String(kind), String(command)])
}

/**
 * The marker the desktop writes for `command` (the backend never stores
 * one; tests and diagnostics use this).
 */
export function createCommandApprovalMarker(
  kind: string,
  command: string,
  settingsKey: Buffer | null = getMasterKey()
): CommandApprovalMarker {
  const payload = canonicalCommand(kind, command)
  const key = approvalKey(settingsKey)
  if (key) {
    return {
      v: APPROVAL_VERSION,
      alg: "hmac-sha256",
      digest: createHmac("sha256", key).update(payload).digest("base64"),
    }
  }
  return {
    v: APPROVAL_VERSION,
    alg: "sha256",
    digest: createHash("sha256").update(payload).digest("base64"),
  }
}

function digestsEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false
  const a = Buffer.from(left, "base64")
  const b = Buffer.from(right, "base64")
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b)
}

/** True when `marker` approves exactly `command` for `kind`. */
export function isCommandApprovalMarkerValid(
  kind: string,
  command: string,
  marker: unknown,
  settingsKey: Buffer | null = getMasterKey()
): boolean {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return false
  }
  const candidate = marker as { v?: unknown; alg?: unknown; digest?: unknown }
  if (candidate.v !== APPROVAL_VERSION) return false
  const expected = createCommandApprovalMarker(kind, command, settingsKey)
  return (
    candidate.alg === expected.alg &&
    digestsEqual(candidate.digest, expected.digest)
  )
}
