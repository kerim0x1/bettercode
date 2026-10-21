import {
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircle,
  LockIcon,
  RefreshCwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  describeTailscaleConnection,
  describeTailscaleServe,
  type TailscaleSummary,
} from "@/lib/tailscale-serve"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import type { TailscaleRemoteStatus } from "@/services/backend/remoteApi"
import { getElectronApi } from "@/services/ipc-facade"

/** The system browser in the desktop app, a new tab in a paired browser. */
function openExternalUrl(url: string) {
  const api = getElectronApi()
  if (api?.openExternal) {
    void api.openExternal(url).catch(() => {
      toast.error("Couldn't open the page", { description: url })
    })
  } else {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}

/** Tailscale's mark: the three-by-three dot grid, middle row lit. */
function TailscaleMark({ className }: { className?: string }) {
  const lit = new Set([3, 4, 5, 7])
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      {Array.from({ length: 9 }, (_, index) => (
        <circle
          key={index}
          cx={4 + (index % 3) * 8}
          cy={4 + Math.floor(index / 3) * 8}
          r={2.6}
          fill="currentColor"
          opacity={lit.has(index) ? 1 : 0.3}
        />
      ))}
    </svg>
  )
}

function StatusDot({ summary }: { summary: TailscaleSummary }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          summary.tone === "ok" && "bg-success",
          summary.tone === "warn" && "bg-warning",
          summary.tone === "muted" && "bg-muted-foreground/40"
        )}
      />
      {summary.headline}
    </span>
  )
}

function ActionButton({
  action,
  className,
}: {
  action: NonNullable<TailscaleSummary["action"]>
  className?: string
}) {
  return (
    <Button
      className={cn("h-7 gap-1.5 px-2.5 text-xs", className)}
      onClick={() => openExternalUrl(action.url)}
      size="sm"
      variant="outline"
    >
      {action.label}
      <ExternalLinkIcon className="size-3" />
    </Button>
  )
}

/**
 * Tailscale in Remote Access, the way in that works from anywhere: the
 * connection on this computer, then Tailscale HTTPS (Serve) with its switch.
 * Once the HTTPS name answers, its address sits under the switch, ready to
 * copy; whatever is missing comes with the page that fixes it.
 */
export function TailscaleServeCard({
  status,
  hostingEnabled,
  busy,
  disabled,
  refreshing = false,
  onToggle,
  onRefresh,
  onCopy,
}: {
  status: TailscaleRemoteStatus | null
  hostingEnabled: boolean
  busy: boolean
  /** Paired browsers see the state but cannot flip it. */
  disabled: boolean
  refreshing?: boolean
  onToggle: (enabled: boolean) => void
  onRefresh?: () => void
  onCopy?: (url: string) => void
}) {
  const connection = describeTailscaleConnection(status, hostingEnabled)
  const serve = describeTailscaleServe(status, hostingEnabled)
  const checked = status?.serveEnabled === true
  const servedUrl =
    checked && serve.tone === "ok" ? (status?.httpsBaseUrl ?? null) : null
  const serveDetail = busy
    ? "Setting up… Tailscale issues the certificate the first time, which can take a few seconds."
    : servedUrl
      ? "Your phone and other devices on your tailnet pair at this address, with full access."
      : serve.detail
  return (
    <div
      className="divide-y divide-border/50"
      data-tailscale-connection={connection.tone}
      data-tailscale-serve={serve.tone}
      data-serve-enabled={checked}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/[0.05]",
              connection.tone === "ok"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            <TailscaleMark className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Tailscale</p>
            <p
              className={cn(
                "mt-0.5 text-[12.5px] leading-snug text-muted-foreground",
                connection.headline === "Connected" && "truncate font-mono"
              )}
            >
              {connection.detail}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot summary={connection} />
          {connection.action ? (
            <ActionButton action={connection.action} />
          ) : null}
          {onRefresh ? (
            <Button
              aria-label="Check Tailscale again"
              disabled={refreshing}
              onClick={onRefresh}
              size="icon-xs"
              title="Check again"
              variant="ghost"
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5 text-muted-foreground",
                  refreshing && "motion-safe:animate-spin"
                )}
              />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
          <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            >
              <LockIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                Tailscale HTTPS
                <span className="rounded-md bg-success/10 px-1.5 py-px text-[10px] font-medium text-success">
                  Recommended
                </span>
              </p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                {serveDetail}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <StatusDot summary={serve} />
            )}
            <Switch
              aria-label="Tailscale HTTPS"
              checked={checked}
              disabled={disabled || busy || !serve.canToggle}
              onCheckedChange={onToggle}
            />
          </div>
        </div>
        {servedUrl && !busy ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 py-1 pr-1 pl-3 sm:ml-7">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-success"
            />
            <code className="min-w-0 flex-1 truncate font-mono text-xs">
              {servedUrl}
            </code>
            {onCopy ? (
              <Button
                aria-label="Copy address"
                onClick={() => onCopy(servedUrl)}
                size="icon-xs"
                title="Copy address"
                variant="ghost"
              >
                <CopyIcon className="size-3.5 text-muted-foreground" />
              </Button>
            ) : null}
          </div>
        ) : null}
        {serve.action && !busy ? (
          <ActionButton action={serve.action} className="mt-3 sm:ml-7" />
        ) : null}
      </div>
    </div>
  )
}
