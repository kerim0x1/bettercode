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
  Check,
  Copy,
  ExternalLink,
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
} from "lucide-react"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/lib/settings-store"
import { toast } from "@/lib/toast"
import { getSettings } from "@/services/backend"
import { TailscaleServeCard } from "@/components/remote/tailscale-serve-card"
import {
  createRemotePairingLink,
  describeRemoteClient,
  describeRemoteTerminals,
  endRemoteSessionTerminals,
  getRemoteBootstrap,
  getRemoteStatus,
  getTailscaleStatus,
  listRemoteSessions,
  logoutRemoteSession,
  revokeOtherRemoteSessions,
  revokeRemoteSession,
  setTailscaleServe,
  type RemotePairingGrant,
  type RemoteSession,
  type RemoteStatus,
  type TailscaleRemoteStatus,
} from "@/services/backend/remoteApi"
import { isRemoteRuntime } from "@/services/backend/runtime"

/** The one setting on this page the local settings store does not mirror. */
async function readRemoteTerminalGrant(): Promise<boolean> {
  const settings = (await getSettings()) as Record<string, unknown>
  return settings.remote_access_allow_terminal === true
}

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

function endpointHint(
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

export function SettingsRemoteAccessSection() {
  const settings = useSettingsStore()
  const remoteRuntime = isRemoteRuntime()
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [grant, setGrant] = useState<RemotePairingGrant | null>(null)
  const [customUrl, setCustomUrl] = useState(settings.remoteAccessCustomUrl)
  const [allowTerminal, setAllowTerminal] = useState(false)
  const [tailscale, setTailscale] = useState<TailscaleRemoteStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      setAllowTerminal(await readRemoteTerminalGrant())
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
  }, [remoteRuntime])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setCustomUrl(settings.remoteAccessCustomUrl)
  }, [settings.remoteAccessCustomUrl])

  const defaultLink = useMemo(
    () =>
      grant?.links.find((link) => link.isDefault) ?? grant?.links[0] ?? null,
    [grant]
  )

  const setEnabled = async (enabled: boolean) => {
    if (!window.electronAPI?.restartBackend) {
      toast.warning("Change remote hosting from the BetterC0de desktop app")
      return
    }
    setBusy("toggle")
    setError(null)
    setGrant(null)
    try {
      await settings.update({ remote_access_enabled: enabled })
      await window.electronAPI.restartBackend()
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
      setTailscale(await setTailscaleServe(value))
      await refresh()
      toast.success(
        value
          ? "Serving through Tailscale HTTPS"
          : "Tailscale Serve mapping removed"
      )
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not change Tailscale Serve"
      setError(message)
      toast.error(message)
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
  const listening = status?.listeningOnNetwork === true

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
              ? "Only the desktop app can change the network listener"
              : "Listen on this computer's network interfaces after a controlled backend restart"
          }
        >
          <div className="flex items-center gap-2">
            {busy === "toggle" ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Switch
              checked={enabled}
              disabled={remoteRuntime || busy !== null}
              onCheckedChange={(value) => void setEnabled(value)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Listener status"
          description={
            listening
              ? `Available on port ${status?.port ?? ""}`
              : enabled
                ? "Restarting or limited to this computer"
                : "Network access is closed"
          }
        >
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${listening ? "text-emerald-500" : "text-muted-foreground"}`}
          >
            {listening ? <Check className="size-3.5" /> : null}
            {listening ? "Listening" : "Not listening"}
          </span>
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

      <SettingsSection
        title="Reachability"
        description="A device on your private network (home or office Wi-Fi, VPN, tailnet) pairs with a full 30-day session over the address shown below — nothing to install on the phone. Plaintext from a public address is refused unless BETTERC0DE_ALLOW_INSECURE_REMOTE_ACCESS is set, and then read-only for one hour. For access away from home use Tailscale below or a trusted https:// URL."
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
        title="Tailscale"
        description="Optional, for access away from home: with Tailscale on this computer and on the phone, the tailnet address is advertised automatically and devices on your tailnet pair with a full session from anywhere — the tunnel is the encryption, nothing is exposed to the public internet. HTTPS via Tailscale Serve is a further option for browsers."
      >
        <TailscaleServeCard
          busy={busy === "tailscale"}
          disabled={remoteRuntime || busy !== null}
          hostingEnabled={enabled}
          onToggle={(value) => void toggleTailscaleServe(value)}
          status={tailscale}
        />
      </SettingsSection>

      <SettingsSection
        title="Pair a device"
        description="Each credential expires after 10 minutes and can be used once. Opening it creates a separate, revocable browser session."
      >
        <div className="space-y-3 px-4 py-3">
          <Button
            className="gap-2"
            disabled={remoteRuntime || !enabled || !listening || busy !== null}
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
      </SettingsSection>

      <SettingsSection
        title="Paired devices"
        description="Sessions survive app restarts. Revoke any browser you no longer trust."
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
                description={`${current ? "This browser · " : ""}${client ? `${client} · ` : ""}Last active ${formatDate(session.lastSeenAt)}${terminals ? ` · ${terminals}` : ""}`}
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
          A full session — HTTPS, this computer, your private network or your
          tailnet — can read and operate chats and workspaces on this computer.
          Pair only devices you control and revoke lost ones. Public plaintext
          pairing, when explicitly enabled, is read-only and expires in one
          hour. Never forward this port from a router without TLS.
        </p>
        {defaultLink ? (
          <a
            className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
            href={defaultLink.url}
            rel="noreferrer"
            target="_blank"
          >
            Test the recommended link <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </>
  )
}
