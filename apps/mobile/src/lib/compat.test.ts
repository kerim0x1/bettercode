import {
  REMOTE_API_VERSION,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import { describe, expect, it } from "vitest"
import { assessCompatibility, hasFeature, needsUpdate } from "./compat"

const protocol = (overrides: Partial<RemoteProtocol> = {}): RemoteProtocol => ({
  apiVersion: REMOTE_API_VERSION,
  minClientVersion: "0.1.0-beta.1",
  capabilities: {
    accessLevel: "full",
    terminalGranted: false,
    maxRequestBytes: 2_097_152,
    features: ["threads.get"],
  },
  ...overrides,
})

describe("desktop compatibility", () => {
  it("accepts a desktop this app understands", () => {
    expect(assessCompatibility(protocol(), "0.1.0-beta.3")).toEqual({
      kind: "ok",
    })
  })

  it("treats a desktop without protocol negotiation as legacy", () => {
    expect(assessCompatibility(null, "0.1.0-beta.3")).toEqual({
      kind: "legacy_desktop",
    })
  })

  it("asks to update the app when the desktop requires a newer one", () => {
    expect(
      assessCompatibility(
        protocol({ minClientVersion: "0.1.0-rc.1" }),
        "0.1.0-beta.9"
      )
    ).toEqual({
      kind: "app_update_required",
      minClientVersion: "0.1.0-rc.1",
    })
  })

  it("asks to update the app when the desktop speaks a newer protocol", () => {
    expect(
      assessCompatibility(
        protocol({ apiVersion: REMOTE_API_VERSION + 1 }),
        "9.9.9"
      )
    ).toMatchObject({
      kind: "app_update_required",
    })
  })

  it("asks to update the desktop when it speaks an older protocol than any this app knows", () => {
    expect(assessCompatibility(protocol({ apiVersion: 0 }), "0.1.0")).toEqual({
      kind: "desktop_update_required",
    })
  })

  it("stops the app only when one side has to be updated", () => {
    expect(needsUpdate({ kind: "ok" })).toBe(false)
    expect(needsUpdate({ kind: "legacy_desktop" })).toBe(false)
    expect(
      needsUpdate({ kind: "app_update_required", minClientVersion: null })
    ).toBe(true)
    expect(needsUpdate({ kind: "desktop_update_required" })).toBe(true)
  })

  it("uses additive features only when the desktop lists them", () => {
    expect(hasFeature(protocol(), "threads.get")).toBe(true)
    expect(hasFeature(protocol(), "terminal.ws")).toBe(false)
    expect(hasFeature(null, "threads.get")).toBe(false)
  })
})
