import { describe, expect, it } from "vitest"
import {
  describeTailscaleConnection,
  describeTailscaleServe,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_DOWNLOAD_URL,
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
    selfAddresses: ["100.101.102.103"],
    httpsCertificates: true,
    serveEnabled: false,
    serveActive: false,
    servePort: 443,
    httpsBaseUrl: "https://desk.tail1234.ts.net",
    serviceRunning: true,
    magicDnsEnabled: true,
    serveReachable: null,
    serveError: null,
    serveConsentUrl: null,
    ...overrides,
  }
}

describe("describeTailscaleConnection", () => {
  it("names the machine and its tailnet address once connected", () => {
    const on = describeTailscaleConnection(status(), true)
    expect(on).toMatchObject({
      headline: "Connected",
      detail: "desk.tail1234.ts.net · 100.101.102.103",
      tone: "ok",
      canToggle: false,
    })
    expect(describeTailscaleConnection(status(), false).tone).toBe("muted")
  })

  it("tells each missing piece apart, with the page that fixes it", () => {
    expect(
      describeTailscaleConnection(
        status({ installed: false, state: "unavailable" }),
        true
      )
    ).toMatchObject({
      headline: "Not installed",
      action: { url: TAILSCALE_DOWNLOAD_URL },
    })
    expect(
      describeTailscaleConnection(status({ state: "needs-login" }), true)
        .headline
    ).toBe("Not signed in")
    // The Windows service stopped vs. Tailscale merely disconnected.
    expect(
      describeTailscaleConnection(
        status({ state: "stopped", serviceRunning: false }),
        true
      )
    ).toMatchObject({ headline: "Not running", tone: "warn" })
    expect(
      describeTailscaleConnection(status({ state: "stopped" }), true).headline
    ).toBe("Disconnected")
    expect(
      describeTailscaleConnection(status({ state: "unavailable" }), true)
        .headline
    ).toBe("Not responding")
    expect(
      describeTailscaleConnection(status({ tailnetIpv4Addresses: [] }), true)
    ).toMatchObject({ headline: "No address", tone: "warn" })
    expect(describeTailscaleConnection(null, true).headline).toBe("Unavailable")
  })
})

describe("describeTailscaleServe", () => {
  it("keeps the switch inert until Tailscale is connected and hosting is on", () => {
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
      describeTailscaleServe(
        status({ state: "stopped", serviceRunning: false }),
        true
      )
    ).toMatchObject({ headline: "Not running", canToggle: false })
    expect(describeTailscaleServe(status(), false)).toMatchObject({
      headline: "Remote Access off",
      canToggle: false,
    })
  })

  it("offers the HTTPS name and points at the admin console when it is missing", () => {
    const off = describeTailscaleServe(status(), true)
    expect(off).toMatchObject({ headline: "Off", canToggle: true })
    expect(off.detail).toContain("https://desk.tail1234.ts.net")
    expect(off.detail).toContain("without opening a port")
    expect(off.action).toBeUndefined()

    const noCerts = describeTailscaleServe(
      status({ httpsCertificates: false }),
      true
    )
    expect(noCerts.detail).toContain("HTTPS certificates")
    expect(noCerts.action?.url).toBe(TAILSCALE_ADMIN_DNS_URL)

    const noMagicDns = describeTailscaleServe(
      status({ magicDnsEnabled: false }),
      true
    )
    expect(noMagicDns).toMatchObject({
      headline: "MagicDNS off",
      canToggle: false,
      action: { url: TAILSCALE_ADMIN_DNS_URL },
    })
  })

  it("hands over Tailscale's consent page when Serve is not allowed yet", () => {
    const consent = describeTailscaleServe(
      status({
        serveError: "Tailscale Serve is not allowed on this tailnet yet.",
        serveConsentUrl:
          "https://login.tailscale.com/f/serve?node=nAbc123CNTRL",
      }),
      true
    )
    expect(consent).toMatchObject({
      headline: "Needs approval",
      canToggle: true,
      action: {
        label: "Allow in Tailscale",
        url: "https://login.tailscale.com/f/serve?node=nAbc123CNTRL",
      },
    })
  })

  it("follows the served name from certificate to ready", () => {
    expect(
      describeTailscaleServe(
        status({ serveEnabled: true, serveActive: true, serveReachable: true }),
        true
      )
    ).toMatchObject({
      headline: "Ready",
      detail: "https://desk.tail1234.ts.net",
      tone: "ok",
      canToggle: true,
    })
    expect(
      describeTailscaleServe(
        status({
          serveEnabled: true,
          serveActive: true,
          serveReachable: false,
        }),
        true
      )
    ).toMatchObject({ headline: "Getting certificate", tone: "warn" })
    expect(
      describeTailscaleServe(
        status({
          serveEnabled: true,
          serveActive: true,
          serveReachable: false,
          httpsCertificates: false,
        }),
        true
      )
    ).toMatchObject({
      headline: "Certificates off",
      action: { url: TAILSCALE_ADMIN_DNS_URL },
    })
    expect(
      describeTailscaleServe(
        status({
          serveEnabled: true,
          serveActive: true,
          serveReachable: false,
          serveError:
            "Something other than this desktop answers on https://desk.tail1234.ts.net.",
        }),
        true
      )
    ).toMatchObject({ headline: "Blocked", tone: "warn" })
    expect(
      describeTailscaleServe(
        status({ serveEnabled: true, serveActive: false }),
        true
      )
    ).toMatchObject({ headline: "Not active", tone: "warn", canToggle: true })
  })
})
