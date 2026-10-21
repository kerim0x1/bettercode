import { copyText as copyClipboardText } from "@/lib/clipboard"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  Copy,
  Link2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Share2,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Wifi,
} from "lucide-react"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/lib/settings-store"
import { toast } from "@/lib/toast"
import { getSettings } from "@/services/backend/coreApi"
import { TailscaleServeCard } from "@/components/remote/tailscale-serve-card"
import {
  PendingPairingLinks,
  pairingLinkBusyKey,
  REVOKE_ALL_PAIRING_LINKS_BUSY_KEY,
  type PendingPairingLinksStatus,
} from "@/components/settings/remote-pairing-links"
import {
  activePairingLinks,
  createRemotePairingLink,
  describeRemoteClient,
  describeRemoteTerminals,
  endRemoteSessionTerminals,
  getRemoteBootstrap,
  getRemoteStatus,
  getTailscaleStatus,
  listRemotePairingLinks,
  listRemoteSessions,
  logoutRemoteSession,
  remotePairingAccess,
  revokeAllRemotePairingLinks,
  revokeOtherRemoteSessions,
  revokeRemotePairingLink,
  revokeRemoteSession,
  setTailscaleServe,
  type PendingRemotePairingLink,
  type RemotePairingGrant,
  type RemoteSession,
  type RemoteStatus,
  type TailscaleRemoteStatus,
} from "@/services/backend/remoteApi"
import { isRemoteRuntime } from "@/services/backend/runtime"
import { getElectronApi } from "@/services/ipc-facade"

/** The settings on this page the local settings store does not mirror. */
async function readRemoteHostSettings(): Promise<{
  allowTerminal: boolean
  lan: boolean
}> {
  const settings = (await getSettings()) as Record<string, unknown>
  return {
    allowTerminal: settings.remote_access_allow_terminal === true,
    // Missing means on: how Remote Access listened before the switch.
    lan: settings.remote_access_lan !== false,
  }
}

/** While Tailscale issues the certificate, how often and how long to look. */
const TAILSCALE_CERTIFICATE_POLL_MS = 4_000
const TAILSCALE_CERTIFICATE_POLLS = 20

const PairingQrCode = lazy(() =>
  import("@/components/remote/pairing-qr-code").then((module) => ({
    default: module.PairingQrCode,
  }))
)

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}

async function copyText(value: string, label: string): Promise<void> {
  try {
    if (!(await copyClipboardText(value)))
      throw new Error("Clipboard unavailable")
  } catch {
    try {
      const field = document.createElement("textarea")
      field.value = value
      field.setAttribute("readonly", "")
      field.style.position = "fixed"
      field.style.opacity = "0"
      document.body.append(field)
      field.select()
      const copied = document.execCommand("copy")
      field.remove()
      if (!copied) throw new Error("Clipboard command failed")
    } catch {
      toast.error("Could not copy to the clipboard")
      return
    }
  }
  toast.success(`${label} copied`)
}

function endpointReach(
  endpoint: Pick<RemoteStatus["endpoints"][number], "id" | "reachability">
): string {
  if (endpoint.id === "tailscale" || endpoint.id === "tailscale-ip") {
    return "Devices on your tailnet"
  }
  switch (endpoint.reachability) {
    case "loopback":
      return "Only this computer"
    case "private-network":
      return "Same LAN or private network"
    case "public":
      return "Configured public endpoint"
    default:
      return "Network interface"
  }
}

/** Where an address reaches, and whether pairing through it is read-only. */
function endpointHint(
  endpoint: Pick<
    RemoteStatus["endpoints"][number],
    "id" | "reachability" | "httpBaseUrl"
  >
): string {
  const reach = endpointReach(endpoint)
  return remotePairingAccess({ id: endpoint.id, url: endpoint.httpBaseUrl }) ===
    "read-only"
    ? `${reach} · read-only, 1 hour`
    : reach
}

export function SettingsRemoteAccessSection() {
  const settings = useSettingsStore()
  const remoteRuntime = isRemoteRuntime()
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [grant, setGrant] = useState<RemotePairingGrant | null>(null)
  const [pairingLinks, setPairingLinks] = useState<PendingRemotePairingLink[]>(
    []
  )
  const [pairingLinksStatus, setPairingLinksStatus] =
    useState<PendingPairingLinksStatus>("loading")
  const [customUrl, setCustomUrl] = useState(settings.remoteAccessCustomUrl)
  const [allowTerminal, setAllowTerminal] = useState(false)
  const [lan, setLan] = useState(true)
  const [tailscale, setTailscale] = useState<TailscaleRemoteStatus | null>(null)
  const [tailscaleRefreshing, setTailscaleRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Desktop host only: a paired device can neither see nor withdraw links.
  // Never rejects, so a failure here does not hide the rest of the page.
  const refreshPairingLinks = useCallback(async () => {
    if (remoteRuntime) return
    try {
      setPairingLinks(activePairingLinks(await listRemotePairingLinks()))
      setPairingLinksStatus("ready")
    } catch {
      setPairingLinksStatus("error")
    }
  }, [remoteRuntime])

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const hostSettings = await readRemoteHostSettings()
      setAllowTerminal(hostSettings.allowTerminal)
      setLan(hostSettings.lan)
      if (remoteRuntime) {
        const [nextStatus, bootstrap] = await Promise.all([
          getRemoteStatus(),
          getRemoteBootstrap(),
        ])
        setStatus(nextStatus)
        setSessions(bootstrap.session ? [bootstrap.session] : [])
        setCurrentSessionId(bootstrap.session?.id ?? null)
        return
      }
      const [nextStatus, sessionResult, nextTailscale] = await Promise.all([
        getRemoteStatus(),
        listRemoteSessions(),
        // Owner-only and best effort: a backend without the integration
        // must not turn the whole page into an error.
        getTailscaleStatus().catch(() => null),
        refreshPairingLinks(),
      ])
      setStatus(nextStatus)
      setSessions(sessionResult.sessions)
      setCurrentSessionId(sessionResult.currentSessionId)
      setTailscale(nextTailscale)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load remote access"
      )
    }
  }, [refreshPairingLinks, remoteRuntime])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const refreshTailscale = useCallback(async () => {
    if (remoteRuntime) return
    setTailscaleRefreshing(true)
    try {
      const [nextTailscale, nextStatus] = await Promise.all([
        getTailscaleStatus(),
        getRemoteStatus(),
      ])
      setTailscale(nextTailscale)
      setStatus(nextStatus)
    } catch {
      // The card keeps showing the last answer.
    } finally {
      setTailscaleRefreshing(false)
    }
  }, [remoteRuntime])

  // Tailscale issues the HTTPS certificate on the first request to a new
  // mapping; until the name answers, look again every few seconds.
  const certificatePending =
    tailscale?.serveEnabled === true &&
    tailscale.serveActive &&
    tailscale.serveReachable === false &&
    !tailscale.serveError
  useEffect(() => {
    if (!certificatePending) return
    let polls = 0
    const timer = window.setInterval(() => {
      polls += 1
      if (polls > TAILSCALE_CERTIFICATE_POLLS) {
        window.clearInterval(timer)
        return
      }
      void getTailscaleStatus()
        .then(setTailscale)
        .catch(() => undefined)
    }, TAILSCALE_CERTIFICATE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [certificatePending])

  // Links expire on their own (an hour at most). Drop them from the list,
  // and the code and QR code from the screen, once they no longer work.
  useEffect(() => {
    const expiries = [
      ...pairingLinks.map((link) => Date.parse(link.expiresAt)),
      grant ? Date.parse(grant.expiresAt) : Number.NaN,
    ].filter(Number.isFinite)
    if (expiries.length === 0) return
    const delay = Math.min(
      Math.max(0, Math.min(...expiries) - Date.now()) + 250,
      2 ** 31 - 1
    )
    const timer = window.setTimeout(() => {
      const now = Date.now()
      setPairingLinks((current) => activePairingLinks(current, now))
      setGrant((current) =>
        current && !(Date.parse(current.expiresAt) > now) ? null : current
      )
    }, delay)
    return () => window.clearTimeout(timer)
  }, [grant, pairingLinks])

  useEffect(() => {
    setCustomUrl(settings.remoteAccessCustomUrl)
  }, [settings.remoteAccessCustomUrl])

  const defaultLink = useMemo(
    () =>
      grant?.links.find((link) => link.isDefault) ?? grant?.links[0] ?? null,
    [grant]
  )

  const setEnabled = async (enabled: boolean) => {
    const desktopBridge = getElectronApi()
    if (!desktopBridge?.restartBackend) {
      toast.warning("Change remote hosting from the BetterC0de desktop app")
      return
    }
    setBusy("toggle")
    setError(null)
    setGrant(null)
    try {
      await settings.update({ remote_access_enabled: enabled })
      await desktopBridge.restartBackend()
      await refresh()
      toast.success(
        enabled ? "Remote access enabled" : "Remote access disabled"
      )
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not restart the host"
      setError(message)
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }

  const setLanListening = async (value: boolean) => {
    const desktopBridge = getElectronApi()
    if (!desktopBridge?.restartBackend) {
      toast.warning("Change remote hosting from the BetterC0de desktop app")
      return
    }
    setBusy("lan")
    setError(null)
    setGrant(null)
    try {
      await settings.update({ remote_access_lan: value })
      setLan(value)
      // Where the backend listens is decided when it starts.
      await desktopBridge.restartBackend()
      await refresh()
      toast.success(
        value
          ? "Listening on the local network"
          : "No longer listening on the local network"
      )
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not restart the host"
      setError(message)
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }

  const setTerminalGrant = async (value: boolean) => {
    setBusy("allow-terminal")
    setError(null)
    try {
      // The backend refuses this patch from a paired device; only the
      // desktop host widens what paired devices may do.
      await settings.update({ remote_access_allow_terminal: value })
      setAllowTerminal(value)
      toast.success(
        value
          ? "Paired devices can now open a terminal"
          : "Terminal access for paired devices disabled"
      )
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not change terminal access"
      setError(message)
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }

  const toggleTailscaleServe = async (value: boolean) => {
    setBusy("tailscale")
    setError(null)
    setGrant(null)
    try {
      const next = await setTailscaleServe(value)
      setTailscale(next)
      await refresh()
      if (!value) toast.success("Tailscale HTTPS turned off")
      else if (next.serveReachable === true)
        toast.success("Tailscale HTTPS is ready", {
          description: next.httpsBaseUrl ?? undefined,
        })
      else toast.info("Tailscale HTTPS is on; the certificate is on its way")
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not change Tailscale HTTPS"
      toast.error(message)
      // The card explains what is missing, with the page that fixes it.
      await refreshTailscale()
    } finally {
      setBusy(null)
    }
  }

  const saveCustomUrl = async () => {
    const value = customUrl.trim()
    if (value) {
      try {
        const url = new URL(value)
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error()
        }
      } catch {
        setError("Enter a complete HTTP or HTTPS URL")
        return
      }
    }
    setBusy("custom-url")
    setError(null)
    try {
      await settings.update({ remote_access_custom_url: value })
      await refresh()
      setGrant(null)
      toast.success(value ? "Remote endpoint saved" : "Custom endpoint removed")
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the endpoint"
      )
    } finally {
      setBusy(null)
    }
  }

  const createLink = async () => {
    setBusy("pair")
    setError(null)
    try {
      const nextGrant = await createRemotePairingLink("Trusted device", 10)
      setGrant(nextGrant)
      await refreshPairingLinks()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create a pairing link"
      )
    } finally {
      setBusy(null)
    }
  }

  const shareLink = async () => {
    if (!defaultLink) return
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Pair with BetterC0de",
          text: `Use this one-time BetterC0de pairing link before ${formatDate(grant!.expiresAt)}.`,
          url: defaultLink.url,
        })
        return
      }
      await copyText(defaultLink.url, "Pairing link")
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setError(
        cause instanceof Error ? cause.message : "Could not share the link"
      )
    }
  }

  const revoke = async (session: RemoteSession) => {
    setBusy(`revoke:${session.id}`)
    try {
      if (session.id === currentSessionId) {
        await logoutRemoteSession()
        window.location.reload()
        return
      }
      await revokeRemoteSession(session.id)
      await refresh()
      toast.success(`Revoked ${session.label}`)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not revoke the device"
      )
    } finally {
      setBusy(null)
    }
  }

  const revokePairingLink = async (link: PendingRemotePairingLink) => {
    setBusy(pairingLinkBusyKey(link.id))
    setError(null)
    try {
      const { revoked } = await revokeRemotePairingLink(link.id)
      setGrant((current) => (current?.id === link.id ? null : current))
      await refreshPairingLinks()
      if (revoked) {
        toast.success("Pairing link revoked")
      } else {
        toast.info("That link was already used or has expired")
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not revoke the pairing link"
      )
    } finally {
      setBusy(null)
    }
  }

  const revokeAllPairingLinks = async () => {
    setBusy(REVOKE_ALL_PAIRING_LINKS_BUSY_KEY)
    setError(null)
    try {
      const { revoked } = await revokeAllRemotePairingLinks()
      // Whatever code is on screen no longer works (or was already used).
      setGrant(null)
      await refreshPairingLinks()
      toast.success(
        `Revoked ${revoked} pairing link${revoked === 1 ? "" : "s"}`
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not revoke the pairing links"
      )
    } finally {
      setBusy(null)
    }
  }

  const endTerminals = async (session: RemoteSession) => {
    setBusy(`terminals:${session.id}`)
    try {
      const { ended } = await endRemoteSessionTerminals(session.id)
      await refresh()
      toast.success(
        ended > 0
          ? `Closed ${ended} terminal${ended === 1 ? "" : "s"} on ${session.label}`
          : `${session.label} has no open terminals`
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not close the device's terminals"
      )
    } finally {
      setBusy(null)
    }
  }

  const revokeOthers = async () => {
    setBusy("revoke-others")
    try {
      const result = await revokeOtherRemoteSessions()
      await refresh()
      toast.success(
        `Revoked ${result.revoked} remote session${result.revoked === 1 ? "" : "s"}`
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not revoke sessions"
      )
    } finally {
      setBusy(null)
    }
  }

  const enabled = status?.enabled ?? settings.remoteAccessEnabled
  // Some address other devices reach: Tailscale HTTPS, the network, a URL.
  const reachable =
    status?.endpoints.some(
      (endpoint) => endpoint.reachability !== "loopback"
    ) === true

  return (
    <>
      <SettingsSection
        title="Host"
        description="The desktop backend serves the complete BetterC0de web app and all of this host's chats, projects, files, terminals, and provider sessions."
      >
        <SettingsRow
          label="Remote Access"
          description={
            remoteRuntime
              ? "Only the desktop app can change remote hosting"
              : "Let your phone and other computers pair with this desktop. Turning it off signs out every paired device and revokes unused pairing links."
          }
        >
          <div className="flex items-center gap-2">
            {busy === "toggle" ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Switch
              aria-label="Remote Access"
              checked={enabled}
              disabled={remoteRuntime || busy !== null}
              onCheckedChange={(value) => void setEnabled(value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          icon={<Wifi />}
          label="Local network"
          description={
            remoteRuntime
              ? "Only the desktop app can change where it listens"
              : `Also listen on Wi-Fi and LAN${status?.port ? ` (port ${status.port})` : ""}, over plain HTTP: devices there pair read-only for one hour, and the system firewall may ask first. Not needed for Tailscale HTTPS. Changing it restarts the backend.`
          }
        >
          <div className="flex items-center gap-2">
            {busy === "lan" ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Switch
              aria-label="Local network"
              checked={lan}
              disabled={remoteRuntime || !enabled || busy !== null}
              onCheckedChange={(value) => void setLanListening(value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Allow terminal from remote devices"
          description={
            remoteRuntime
              ? "Only the desktop app can grant paired devices a terminal"
              : "Warning: this grants shell access on this computer to every paired device with a full session"
          }
        >
          <div className="flex items-center gap-2">
            {busy === "allow-terminal" ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Switch
              aria-label="Allow terminal from remote devices"
              checked={allowTerminal}
              disabled={remoteRuntime || busy !== null}
              onCheckedChange={(value) => void setTerminalGrant(value)}
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      {remoteRuntime ? null : (
        <SettingsSection
          title="Tailscale"
          description="Reach this computer from anywhere: put it and your phone on the same tailnet, and Tailscale encrypts everything between them. Nothing is opened to the internet."
        >
          <TailscaleServeCard
            busy={busy === "tailscale"}
            disabled={busy !== null}
            hostingEnabled={enabled}
            onCopy={(url) => void copyText(url, "Address")}
            onRefresh={() => void refreshTailscale()}
            onToggle={(value) => void toggleTailscaleServe(value)}
            refreshing={tailscaleRefreshing}
            status={tailscale}
          />
        </SettingsSection>
      )}

      <SettingsSection
        title="Reachability"
        description="For full access use Tailscale or an https:// address. Pairing over plain Wi-Fi is read-only for one hour."
      >
        <div className="space-y-3 px-4 py-3">
          <label className="text-sm font-medium" htmlFor="remote-custom-url">
            Custom public URL
          </label>
          <div className="flex gap-2">
            <Input
              id="remote-custom-url"
              disabled={remoteRuntime || busy !== null}
              onChange={(event) => setCustomUrl(event.target.value)}
              placeholder="https://betterc0de.example.com"
              spellCheck={false}
              value={customUrl}
            />
            <Button
              disabled={
                remoteRuntime ||
                busy !== null ||
                customUrl.trim() === settings.remoteAccessCustomUrl
              }
              onClick={() => void saveCustomUrl()}
              size="sm"
              variant="outline"
            >
              {busy === "custom-url" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </div>
          {enabled && status?.endpoints.length ? (
            <div className="space-y-1.5 pt-1">
              {status.endpoints.map((endpoint) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2"
                  key={endpoint.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">
                      {endpoint.label}
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {endpoint.httpBaseUrl}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {endpointHint(endpoint)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Pair a device"
        description="Each link works once and expires after 10 minutes; no link lasts longer than an hour. Opening it creates a separate, revocable session. Revoke unused links if a screenshot or QR code went somewhere it shouldn't."
      >
        <div className="space-y-3 px-4 py-3">
          <Button
            className="gap-2"
            disabled={remoteRuntime || !enabled || !reachable || busy !== null}
            onClick={() => void createLink()}
            size="sm"
          >
            {busy === "pair" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Link2 className="size-3.5" />
            )}
            Create one-time link
          </Button>
          {!enabled ? (
            <p className="text-xs text-muted-foreground">
              Enable remote access before pairing another device.
            </p>
          ) : !reachable && !remoteRuntime ? (
            <p className="text-xs text-muted-foreground">
              Turn on Tailscale HTTPS or Local network, so a device can reach
              this computer.
            </p>
          ) : remoteRuntime ? (
            <p className="text-xs text-muted-foreground">
              New devices can only be paired from the desktop host.
            </p>
          ) : null}
          {grant ? (
            <div className="space-y-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
                    <ShieldCheck className="size-3.5" /> Ready to pair
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Expires {formatDate(grant.expiresAt)}
                  </p>
                </div>
                <Button
                  aria-label="Share pairing link"
                  onClick={() => void shareLink()}
                  size="icon-sm"
                  variant="outline"
                >
                  <Share2 className="size-3.5" />
                </Button>
              </div>
              <button
                className="flex w-full items-center justify-between rounded-lg bg-background px-3 py-2 text-left"
                onClick={() => void copyText(grant.credential, "Pairing code")}
                type="button"
              >
                <code className="text-sm font-semibold tracking-[0.12em]">
                  {grant.credential}
                </code>
                <Copy className="size-3.5 text-muted-foreground" />
              </button>
              {defaultLink ? (
                <div className="flex justify-center rounded-xl bg-white p-3">
                  <Suspense
                    fallback={
                      <div className="size-40 animate-pulse rounded-lg bg-neutral-200" />
                    }
                  >
                    <PairingQrCode value={defaultLink.url} />
                  </Suspense>
                </div>
              ) : null}
              <div className="space-y-1.5">
                {grant.links.map((link) => (
                  <button
                    className="flex w-full items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-left hover:bg-muted/60"
                    key={link.endpointId}
                    onClick={() => void copyText(link.url, "Pairing link")}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">
                        {link.label}
                        {link.isDefault ? " · Recommended" : ""}
                        {remotePairingAccess({
                          id: link.endpointId,
                          url: link.url,
                        }) === "read-only"
                          ? " · Read-only, 1 hour"
                          : ""}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {link.url}
                      </span>
                    </span>
                    <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {!remoteRuntime && enabled ? (
          <PendingPairingLinks
            busy={busy}
            disabled={busy !== null}
            links={pairingLinks}
            onRetry={() => void refreshPairingLinks()}
            onRevoke={(link) => void revokePairingLink(link)}
            onRevokeAll={() => void revokeAllPairingLinks()}
            shownLinkId={grant?.id ?? null}
            status={pairingLinksStatus}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Paired devices"
        description="Sessions survive app restarts and end after 30 days, or after 7 days without use. Revoke any device you no longer trust."
      >
        {sessions.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Smartphone className="size-4" /> No paired devices
          </div>
        ) : (
          sessions.map((session) => {
            const current = session.id === currentSessionId
            const client = describeRemoteClient(session.client)
            const terminals = describeRemoteTerminals(session.terminals)
            return (
              <SettingsRow
                description={`${current ? "This browser · " : ""}${session.accessLevel === "read_only" ? "Read-only · " : ""}${client ? `${client} · ` : ""}Last active ${formatDate(session.lastSeenAt)}${terminals ? ` · ${terminals}` : ""}`}
                key={session.id}
                label={session.label}
              >
                <div className="flex shrink-0 items-center gap-1">
                  {terminals && !remoteRuntime ? (
                    <Button
                      aria-label={`Close the terminals on ${session.label}`}
                      disabled={busy !== null}
                      onClick={() => void endTerminals(session)}
                      size="sm"
                      variant="ghost"
                    >
                      {busy === `terminals:${session.id}` ? (
                        <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
                      ) : (
                        <SquareTerminal className="mr-1.5 size-3.5" />
                      )}
                      Close terminals
                    </Button>
                  ) : null}
                  <Button
                    aria-label={
                      current
                        ? "Sign out this browser"
                        : `Revoke ${session.label}`
                    }
                    disabled={busy !== null}
                    onClick={() => void revoke(session)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    {busy === `revoke:${session.id}` ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : current ? (
                      <LogOut className="size-3.5" />
                    ) : (
                      <Trash2 className="size-3.5 text-destructive" />
                    )}
                  </Button>
                </div>
              </SettingsRow>
            )
          })
        )}
        <div className="flex justify-end gap-2 px-4 py-3">
          <Button
            disabled={busy !== null}
            onClick={() => void refresh()}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className="mr-1.5 size-3.5" /> Refresh
          </Button>
          {!remoteRuntime ? (
            <Button
              disabled={
                busy !== null || sessions.length === (currentSessionId ? 1 : 0)
              }
              onClick={() => void revokeOthers()}
              size="sm"
              variant="outline"
            >
              Revoke {currentSessionId ? "others" : "all"}
            </Button>
          ) : null}
        </div>
      </SettingsSection>

      <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs leading-5 text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <TriangleAlert className="size-4 text-amber-500" /> Paired devices can
          operate this host
        </p>
        <p className="mt-1">
          A full session — paired over HTTPS, on this computer or through your
          tailnet — can read and operate chats and workspaces on this computer
          for 30 days, or until it goes unused for 7 days. Pair only devices you
          control and revoke lost ones. Pairing over plain HTTP, on your private
          network or a public address, is read-only and ends after one hour.
          Never forward this port from a router without TLS.
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </>
  )
}
