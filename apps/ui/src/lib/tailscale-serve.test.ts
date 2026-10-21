import { describe, expect, it } from "vitest"
import {
  describeTailscaleConnection,
  describeTailscaleServe,
} from "./tailscale-serve"
import type { TailscaleRemoteStatus } from "@/services/backend/remoteApi"

function status(
  overrides: Partial<TailscaleRemoteStatus> = {}
): TailscaleRemoteStatus {
  return {
    available: true,
    installed: true,
    state: "running",
    magicDnsName: "desk.tail1234.ts.net",
    tailnetIpv4Addresses: ["100.101.102.103"],
    httpsCertificates: true,
    serveEnabled: false,
    serveActive: false,
    servePort: 443,
    httpsBaseUrl: "https://desk.tail1234.ts.net",
    ...overrides,
  }
}

describe("describeTailscaleConnection", () => {
  it("shows the tailnet address as the zero-config path once hosting is on", () => {
    const on = describeTailscaleConnection(status(), true)
    expect(on).toMatchObject({
      headline: "Connected · 100.101.102.103",
      tone: "ok",
    })
    expect(on.detail).toContain("http://100.101.102.103")
    expect(on.detail).toContain("no certificate")
    expect(on.canToggle).toBe(false)

    const off = describeTailscaleConnection(status(), false)
    expect(off).toMatchObject({
      headline: "Connected · 100.101.102.103",
      tone: "muted",
    })
    expect(off.detail).toContain("Turn on Remote Access")
  })

  it("explains what is missing before the address can be used", () => {
    expect(
      describeTailscaleConnection(
        status({ installed: false, state: "unavailable" }),
        true
      ).headline
    ).toBe("Not installed")
    expect(
      describeTailscaleConnection(status({ state: "needs-login" }), true)
        .headline
    ).toBe("Not signed in")
    expect(
      describeTailscaleConnection(status({ tailnetIpv4Addresses: [] }), true)
    ).toMatchObject({ headline: "No address", tone: "warn" })
    expect(describeTailscaleConnection(null, true).headline).toBe("Unavailable")
  })
})

describe("describeTailscaleServe", () => {
  it("keeps the switch inert until Tailscale is installed, signed in and hosting is on", () => {
    expect(describeTailscaleServe(null, true)).toMatchObject({
      headline: "Unavailable",
      canToggle: false,
    })
    expect(
      describeTailscaleServe(
        status({ installed: false, state: "unavailable" }),
        true
      )
    ).toMatchObject({ headline: "Not installed", canToggle: false })
    expect(
      describeTailscaleServe(status({ state: "needs-login" }), true)
    ).toMatchObject({
      headline: "Not signed in",
      canToggle: false,
      tone: "warn",
    })
    expect(
      describeTailscaleServe(status({ state: "stopped" }), true)
    ).toMatchObject({ headline: "Not running", canToggle: false })
    expect(describeTailscaleServe(status(), false)).toMatchObject({
      headline: "Hosting off",
      canToggle: false,
    })
  })

  it("offers the tailnet URL when ready and warns when certificates are off", () => {
    const ready = describeTailscaleServe(status(), true)
    expect(ready).toMatchObject({
      headline: "Off",
      canToggle: true,
      tone: "muted",
    })
    expect(ready.detail).toContain("https://desk.tail1234.ts.net")
    expect(ready.detail).not.toContain("HTTPS certificates")

    const noCerts = describeTailscaleServe(
      status({ httpsCertificates: false }),
      true
    )
    expect(noCerts.detail).toContain("Requires HTTPS certificates")
    expect(ready.detail).toMatch(/^Optional\./)

    const noMagicDns = describeTailscaleServe(
      status({ magicDnsName: null, httpsBaseUrl: null }),
      true
    )
    expect(noMagicDns.canToggle).toBe(false)
    expect(noMagicDns.detail).toContain("MagicDNS")
  })

  it("distinguishes a live mapping from a setting Tailscale does not honour", () => {
    const serving = describeTailscaleServe(
      status({ serveEnabled: true, serveActive: true }),
      true
    )
    expect(serving).toMatchObject({
      headline: "Serving",
      tone: "ok",
      canToggle: true,
    })
    expect(serving.detail).toContain("https://desk.tail1234.ts.net")

    const stale = describeTailscaleServe(
      status({ serveEnabled: true, serveActive: false }),
      true
    )
    expect(stale).toMatchObject({
      headline: "Not active",
      tone: "warn",
      canToggle: true,
    })

    const servingNoCerts = describeTailscaleServe(
      status({
        serveEnabled: true,
        serveActive: true,
        httpsCertificates: false,
      }),
      true
    )
    expect(servingNoCerts.tone).toBe("warn")
    expect(servingNoCerts.detail).toContain("connections will fail")
  })
})
