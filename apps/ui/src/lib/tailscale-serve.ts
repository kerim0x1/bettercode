import type { TailscaleRemoteStatus } from "@/services/backend/remoteApi"

export interface TailscaleSummary {
  /** One line the row's status column shows. */
  headline: string
  /** What the user should do next, or what is being served. */
  detail: string
  /** The switch is meaningful: Tailscale is installed and logged in. */
  canToggle: boolean
  tone: "ok" | "muted" | "warn"
}

/** @deprecated name kept for the settings card; same shape. */
export type TailscaleServeSummary = TailscaleSummary

/**
 * The tailnet connection itself. Optional — on the same Wi-Fi the LAN
 * address already pairs with a full session. Once the desktop is on a tailnet
 * its address is advertised as a plain-HTTP endpoint the backend treats as
 * private transport (the tunnel is the encryption), so a phone on the same
 * tailnet pairs with a full session from anywhere.
 */
export function describeTailscaleConnection(
  status: TailscaleRemoteStatus | null,
  hostingEnabled: boolean
): TailscaleSummary {
  if (!status || !status.available) {
    return {
      headline: "Unavailable",
      detail: "The desktop backend does not expose Tailscale here.",
      canToggle: false,
      tone: "muted",
    }
  }
  if (!status.installed) {
    return {
      headline: "Not installed",
      detail:
        "Install Tailscale on this computer and sign in, then install it on the phone with the same account.",
      canToggle: false,
      tone: "muted",
    }
  }
  if (status.state === "needs-login") {
    return {
      headline: "Not signed in",
      detail: "Sign in to Tailscale on this computer first.",
      canToggle: false,
      tone: "warn",
    }
  }
  if (status.state !== "running") {
    return {
      headline: "Not running",
      detail: "Start Tailscale on this computer, then refresh.",
      canToggle: false,
      tone: "warn",
    }
  }
  const address = status.tailnetIpv4Addresses[0]
  if (!address) {
    return {
      headline: "No address",
      detail: "Tailscale is running but reported no tailnet address yet.",
      canToggle: false,
      tone: "warn",
    }
  }
  if (!hostingEnabled) {
    return {
      headline: `Connected · ${address}`,
      detail:
        "Turn on Remote Access above and this address is advertised to devices on your tailnet.",
      canToggle: false,
      tone: "muted",
    }
  }
  return {
    headline: `Connected · ${address}`,
    detail: `Devices on your tailnet pair with a full session over http://${address} from anywhere. Encrypted by the tunnel; no certificate or admin console setup needed.`,
    canToggle: false,
    tone: "ok",
  }
}

/**
 * The optional HTTPS add-on: Tailscale Serve publishes the host under its
 * MagicDNS name with a certificate Tailscale issues. Only needed for a
 * browser that wants a secure context (clipboard, camera, notifications);
 * the phone app does not need it.
 */
export function describeTailscaleServe(
  status: TailscaleRemoteStatus | null,
  hostingEnabled: boolean
): TailscaleSummary {
  const connection = describeTailscaleConnection(status, hostingEnabled)
  if (!status || !status.available || !status.installed) return connection
  if (status.state !== "running") return connection
  if (!hostingEnabled) {
    return {
      headline: "Hosting off",
      detail:
        "Turn on Remote Access above before publishing through Tailscale.",
      canToggle: false,
      tone: "muted",
    }
  }
  if (status.serveEnabled && status.serveActive && status.httpsBaseUrl) {
    return {
      headline: "Serving",
      detail: status.httpsCertificates
        ? `${status.httpsBaseUrl} · HTTPS for browsers on your tailnet`
        : `${status.httpsBaseUrl} · enable HTTPS certificates in the Tailscale admin console (DNS → HTTPS) or connections will fail`,
      canToggle: true,
      tone: status.httpsCertificates ? "ok" : "warn",
    }
  }
  if (status.serveEnabled) {
    return {
      headline: "Not active",
      detail:
        "The setting is on but Tailscale reports no mapping to this backend. Toggle it off and on again.",
      canToggle: true,
      tone: "warn",
    }
  }
  return {
    headline: "Off",
    detail: status.magicDnsName
      ? `Optional. Also publish this host as https://${status.magicDnsName} for browsers that need a secure context.${status.httpsCertificates ? "" : " Requires HTTPS certificates in the Tailscale admin console (DNS → HTTPS)."}`
      : "Optional. MagicDNS is off for this tailnet; Tailscale Serve needs a machine name.",
    canToggle: status.magicDnsName !== null,
    tone: "muted",
  }
}
