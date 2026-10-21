import { LoaderCircle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PendingRemotePairingLink } from "@/services/backend/remoteApi"

export type PendingPairingLinksStatus = "loading" | "error" | "ready"

/** Busy key for one link's revoke button, shared with the section's state. */
export function pairingLinkBusyKey(linkId: string): string {
  return `pairing-link:${linkId}`
}

export const REVOKE_ALL_PAIRING_LINKS_BUSY_KEY = "pairing-links:all"

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date)
}

/**
 * Pairing links nobody has redeemed yet. They travel as screenshots and QR
 * codes, so each one can be withdrawn before it is used; the code itself is
 * never listed again after creation.
 */
export function PendingPairingLinks({
  links,
  status,
  busy,
  disabled,
  shownLinkId,
  onRevoke,
  onRevokeAll,
  onRetry,
}: {
  links: readonly PendingRemotePairingLink[]
  status: PendingPairingLinksStatus
  busy: string | null
  disabled: boolean
  /** The link whose code and QR code are on screen right now. */
  shownLinkId: string | null
  onRevoke: (link: PendingRemotePairingLink) => void
  onRevokeAll: () => void
  onRetry: () => void
}) {
  const headingId = "remote-pending-pairing-links"
  return (
    <section aria-labelledby={headingId} className="space-y-2 px-4 py-3">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="text-xs font-medium" id={headingId}>
          Unused links
          {status === "ready" && links.length > 0 ? ` (${links.length})` : ""}
        </p>
        {status === "ready" && links.length > 0 ? (
          <Button
            disabled={disabled}
            onClick={onRevokeAll}
            size="sm"
            variant="outline"
          >
            {busy === REVOKE_ALL_PAIRING_LINKS_BUSY_KEY ? (
              <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            Revoke all
          </Button>
        ) : null}
      </div>
      {status === "loading" ? (
        <p
          className="flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-3.5 animate-spin" /> Loading links
        </p>
      ) : status === "error" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" role="status">
            Unused links could not be loaded.
          </p>
          <Button
            disabled={disabled}
            onClick={onRetry}
            size="sm"
            variant="ghost"
          >
            Retry
          </Button>
        </div>
      ) : links.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No unused pairing links.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {links.map((link) => {
            const created = formatTime(link.createdAt)
            const shown = link.id === shownLinkId
            return (
              <li
                className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2"
                data-pairing-link={link.id}
                key={link.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {link.label}
                    {shown ? " · Shown above" : ""}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    Created {created} · Expires {formatTime(link.expiresAt)}
                  </p>
                </div>
                <Button
                  aria-label={`Revoke the ${link.label} link created ${created}`}
                  disabled={disabled}
                  onClick={() => onRevoke(link)}
                  size="icon-sm"
                  variant="ghost"
                >
                  {busy === pairingLinkBusyKey(link.id) ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5 text-destructive" />
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
