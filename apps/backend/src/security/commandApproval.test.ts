import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createCommandApprovalMarker,
  isCommandApprovalMarkerValid,
} from "./commandApproval"

/**
 * The desktop's own implementation (apps/shell/shared/command-approval.cjs).
 * The backend must accept exactly the markers it writes.
 */
interface ShellCommandApproval {
  setCommandApprovalKey(base64Key: string | null): void
  createApprovalMarker(kind: string, command: string): unknown
  isApprovalMarkerValid(kind: string, command: string, marker: unknown): boolean
}
const shell = createRequire(__filename)(
  path.join(__dirname, "../../../shell/shared/command-approval.cjs")
) as ShellCommandApproval

afterEach(() => shell.setCommandApprovalKey(null))

describe("command approval markers", () => {
  it("accepts the desktop's keyed marker for exactly the approved command", () => {
    const settingsKey = randomBytes(32)
    shell.setCommandApprovalKey(settingsKey.toString("base64"))
    const marker = shell.createApprovalMarker("hook", "npm run lint")

    expect(
      isCommandApprovalMarkerValid("hook", "npm run lint", marker, settingsKey)
    ).toBe(true)
    expect(
      isCommandApprovalMarkerValid("hook", "npm run lint ", marker, settingsKey)
    ).toBe(false)
    expect(
      isCommandApprovalMarkerValid("mcp", "npm run lint", marker, settingsKey)
    ).toBe(false)
    // Another installation's key approves nothing here.
    expect(
      isCommandApprovalMarkerValid(
        "hook",
        "npm run lint",
        marker,
        randomBytes(32)
      )
    ).toBe(false)
    // Nor without a key: a keyed marker needs the key.
    expect(
      isCommandApprovalMarkerValid("hook", "npm run lint", marker, null)
    ).toBe(false)
    // And the backend writes the same marker the desktop does.
    expect(
      createCommandApprovalMarker("hook", "npm run lint", settingsKey)
    ).toEqual(marker)
  })

  it("accepts the plain digest only while there is no settings key", () => {
    shell.setCommandApprovalKey(null)
    const marker = shell.createApprovalMarker("hook", "make check")
    expect(
      isCommandApprovalMarkerValid("hook", "make check", marker, null)
    ).toBe(true)
    // Gaining a key re-asks instead of trusting old digests.
    expect(
      isCommandApprovalMarkerValid(
        "hook",
        "make check",
        marker,
        randomBytes(32)
      )
    ).toBe(false)
  })

  it("refuses malformed markers", () => {
    const key = randomBytes(32)
    const valid = createCommandApprovalMarker("hook", "x", key)
    for (const marker of [
      null,
      "marker",
      [],
      { ...valid, v: 2 },
      { ...valid, alg: "sha256" },
      { ...valid, digest: "AAAA" },
      { v: 1, alg: "hmac-sha256" },
    ]) {
      expect(isCommandApprovalMarkerValid("hook", "x", marker, key)).toBe(false)
    }
  })
})
