import {
  REMOTE_API_VERSION,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import { describe, expect, it } from "vitest"
import {
  bypassAllowed,
  bypassUnavailableNotice,
  presetWithoutBypass,
} from "./bypass"

const protocol = (terminalGranted: boolean): RemoteProtocol => ({
  apiVersion: REMOTE_API_VERSION,
  minClientVersion: "0.1.0-beta.1",
  capabilities: {
    accessLevel: "full",
    terminalGranted,
    maxRequestBytes: 2_097_152,
    features: [],
  },
})

describe("Bypass from a paired phone", () => {
  it("follows the desktop's terminal grant", () => {
    expect(bypassAllowed(protocol(true))).toBe(true)
    expect(bypassAllowed(protocol(false))).toBe(false)
  })

  it("is not limited by a desktop that states no capabilities", () => {
    expect(bypassAllowed(null)).toBe(true)
    expect(
      bypassAllowed({
        apiVersion: REMOTE_API_VERSION,
        minClientVersion: "0.1.0-beta.1",
      })
    ).toBe(true)
  })

  it("keeps any preset but Bypass, which becomes Ask first", () => {
    expect(presetWithoutBypass("allow-edits")).toBe("allow-edits")
    expect(presetWithoutBypass("read-only")).toBe("read-only")
    expect(presetWithoutBypass("bypass")).toBe("ask-on-edit")
  })

  it("names the desktop setting and the preset the chat uses", () => {
    const notice = bypassUnavailableNotice("allow-edits")
    expect(notice.title).toBe("Bypass is off for this phone")
    expect(notice.description).toContain("Allow terminal from remote devices")
    expect(notice.description).toContain("This chat uses Auto-edit.")
  })
})
