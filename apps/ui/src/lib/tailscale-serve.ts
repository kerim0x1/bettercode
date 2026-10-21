import type { TailscaleRemoteStatus } from "@/services/backend/remoteApi"

/** The Tailscale admin console page with MagicDNS and HTTPS certificates. */
export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns"
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download"

export interface TailscaleSummary {
  /** One line the row's status column shows. */
  headline: string
  /** What the user should do next, or what is being served. */
  detail: string
  /** The switch is meaningful: Tailscale is installed and logged in. */
  canToggle: boolean
  tone: "ok" | "muted" | "warn"
  /** A page that fixes what is missing, opened in the browser. */
  action?: { label: string; url: string }
}

/** @deprecated name kept for the settings card; same shape. */
export type TailscaleServeSummary = TailscaleSummary

/**
 * Tailscale on this computer: installed, signed in, connected. Everything
 * else needs this first.
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
        "Install Tailscale on this computer and on your phone, and sign in to both with the same account.",
      canToggle: false,
      tone: "muted",
      action: { label: "Get Tailscale", url: TAILSCALE_DOWNLOAD_URL },
    }
  }
  if (status.state === "needs-login") {
    return {
      headline: "Not signed in",
      detail: "Sign in to Tailscale on this computer, then check again.",
      canToggle: false,
      tone: "warn",
    }
  }
  if (status.state === "stopped") {
    return status.serviceRunning === false
      ? {
          headline: "Not running",
          detail:
            "The Tailscale service is not running on this computer. Open Tailscale and connect, then check again.",
          canToggle: false,
          tone: "warn",
        }
      : {
          headline: "Disconnected",
          detail:
            "Tailscale is signed in but disconnected. Connect it from the Tailscale menu, then check again.",
          canToggle: false,
          tone: "warn",
        }
  }
  if (status.state !== "running") {
    return {
      headline: "Not responding",
      detail: "Tailscale did not answer. Make sure it runs, then check again.",
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
  return {
    headline: "Connected",
    detail: status.magicDnsName
      ? `${status.magicDnsName} · ${address}`
      : address,
    canToggle: false,
    tone: hostingEnabled ? "ok" : "muted",
  }
}

/**
 * Tailscale HTTPS, the recommended way in: Tailscale Serve publishes this
 * computer as `https://<machine>.<tailnet>.ts.net` with a certificate
 * Tailscale issues. tailscaled accepts the connections itself, so it needs
 * no network listener and no firewall rule, and a paired phone gets a full
 * session from anywhere on the tailnet.
 */
export function describeTailscaleServe(
  status: TailscaleRemoteStatus | null,
  hostingEnabled: boolean
): TailscaleSummary {
  const connection = describeTailscaleConnection(status, hostingEnabled)
  if (
    !status ||
    !status.available ||
    !status.installed ||
    status.state !== "running"
  ) {
    return {
      headline: connection.headline,
      detail: "Needs Tailscale connected on this computer.",
      canToggle: false,
      tone: "muted",
    }
  }
  if (!hostingEnabled) {
    return {
      headline: "Remote Access off",
      detail: "Turn on Remote Access above first.",
      canToggle: false,
      tone: "muted",
    }
  }
  if (!status.magicDnsName || status.magicDnsEnabled === false) {
    return {
      headline: "MagicDNS off",
      detail:
        "Turn on MagicDNS for your tailnet in the Tailscale admin console, then check again.",
      canToggle: status.serveEnabled,
      tone: "warn",
      action: { label: "Open DNS settings", url: TAILSCALE_ADMIN_DNS_URL },
    }
  }
  const url = status.httpsBaseUrl ?? `https://${status.magicDnsName}`
  const certificatesHint = status.httpsCertificates
    ? undefined
    : { label: "Open DNS settings", url: TAILSCALE_ADMIN_DNS_URL }

  const consent = status.serveConsentUrl
    ? {
        headline: "Needs approval",
        detail:
          "Tailscale Serve is not allowed on your tailnet yet. Allow it in Tailscale, then turn this on again.",
        canToggle: true,
        tone: "warn" as const,
        action: { label: "Allow in Tailscale", url: status.serveConsentUrl },
      }
    : null

  if (status.serveEnabled) {
    // Re-applying the mapping at start can meet the same consent page.
    if (!status.serveActive && consent) return consent
    if (!status.serveActive) {
      return {
        headline: "Not active",
        detail:
          "The setting is on, but Tailscale has no mapping to this computer. Turn it off and on again.",
        canToggle: true,
        tone: "warn",
      }
    }
    if (status.serveReachable === false) {
      if (status.serveError) {
        return {
          headline: "Blocked",
          detail: status.serveError,
          canToggle: true,
          tone: "warn",
        }
      }
      return status.httpsCertificates
        ? {
            headline: "Getting certificate",
            detail: `Tailscale is issuing the certificate for ${url}. This can take a minute the first time.`,
            canToggle: true,
            tone: "warn",
          }
        : {
            headline: "Certificates off",
            detail: `Turn on HTTPS certificates in the Tailscale admin console (DNS page), or ${url} cannot answer.`,
            canToggle: true,
            tone: "warn",
            action: certificatesHint,
          }
    }
    return {
      headline: status.serveReachable === true ? "Ready" : "On",
      detail: url,
      canToggle: true,
      tone: "ok",
    }
  }

  if (consent) return consent
  if (status.serveError) {
    return {
      headline: "Failed",
      detail: status.serveError,
      canToggle: true,
      tone: "warn",
      action: certificatesHint,
    }
  }
  return {
    headline: "Off",
    detail: `Publish this computer at ${url} for the devices on your tailnet: full access from anywhere, without opening a port or a firewall.${status.httpsCertificates ? "" : " Needs HTTPS certificates turned on in the Tailscale admin console."}`,
    canToggle: true,
    tone: "muted",
    action: certificatesHint,
  }
}
