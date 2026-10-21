import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TailscaleServeCard } from "./tailscale-serve-card"
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

const noop = () => {}

/** The switch tag as rendered, so assertions can look at its own attributes. */
function switchTag(html: string): string {
  const match = html.match(/<button[^>]*role="switch"[^>]*>/)
  if (!match) throw new Error("switch not rendered")
  return match[0]
}

describe("TailscaleServeCard", () => {
  it("renders a disabled switch and the download link when Tailscale is missing", () => {
    const html = renderToStaticMarkup(
      <TailscaleServeCard
        busy={false}
        disabled={false}
        hostingEnabled
        onToggle={noop}
        status={status({ installed: false, state: "unavailable" })}
      />
    )
    expect(html).toContain('aria-label="Tailscale HTTPS"')
    expect(html).toContain("Not installed")
    expect(html).toContain("Get Tailscale")
    expect(html).toContain('data-tailscale-connection="muted"')
    expect(html).toContain('data-serve-enabled="false"')
    expect(html).not.toContain("Connected")
    expect(switchTag(html)).toContain('data-disabled=""')
    expect(html).not.toContain("ts.net")
  })

  it("shows the served address, ready to copy, once it answers", () => {
    const html = renderToStaticMarkup(
      <TailscaleServeCard
        busy={false}
        disabled={false}
        hostingEnabled
        onCopy={noop}
        onToggle={noop}
        status={status({
          serveEnabled: true,
          serveActive: true,
          serveReachable: true,
        })}
      />
    )
    expect(html).toContain("Ready")
    expect(html).toContain("Connected")
    expect(html).toContain("desk.tail1234.ts.net · 100.101.102.103")
    expect(html).toContain('data-tailscale-connection="ok"')
    expect(html).toContain("<code")
    expect(html).toContain("https://desk.tail1234.ts.net")
    expect(html).toContain('aria-label="Copy address"')
    expect(html).toContain('data-tailscale-serve="ok"')
    expect(html).toContain('data-serve-enabled="true"')
    expect(html).toContain('data-state="checked"')
    expect(switchTag(html)).not.toContain('data-disabled=""')
  })

  it("offers Tailscale's consent page when Serve is not allowed yet", () => {
    const html = renderToStaticMarkup(
      <TailscaleServeCard
        busy={false}
        disabled={false}
        hostingEnabled
        onToggle={noop}
        status={status({
          serveError: "Tailscale Serve is not allowed on this tailnet yet.",
          serveConsentUrl:
            "https://login.tailscale.com/f/serve?node=nAbc123CNTRL",
        })}
      />
    )
    expect(html).toContain("Needs approval")
    expect(html).toContain("Allow in Tailscale")
    // The served-address bar appears only for a name that answers.
    expect(html).not.toContain("<code")
  })

  it("keeps the switch read-only for paired browsers and while busy", () => {
    const remote = renderToStaticMarkup(
      <TailscaleServeCard
        busy={false}
        disabled
        hostingEnabled
        onToggle={noop}
        status={status()}
      />
    )
    expect(switchTag(remote)).toContain('data-disabled=""')

    const busy = renderToStaticMarkup(
      <TailscaleServeCard
        busy
        disabled={false}
        hostingEnabled
        onToggle={noop}
        status={status()}
      />
    )
    expect(busy).toContain("animate-spin")
    expect(busy).toContain("Setting up")
    expect(switchTag(busy)).toContain('data-disabled=""')
  })
})
