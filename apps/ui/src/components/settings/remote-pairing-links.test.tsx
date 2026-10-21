import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PendingRemotePairingLink } from "@/services/backend/remoteApi"
import {
  PendingPairingLinks,
  pairingLinkBusyKey,
  type PendingPairingLinksStatus,
} from "./remote-pairing-links"

const links: PendingRemotePairingLink[] = [
  {
    id: "grant-2",
    label: "Trusted device",
    createdAt: "2026-10-07T11:58:00.000Z",
    expiresAt: "2026-10-07T12:08:00.000Z",
  },
  {
    id: "grant-1",
    label: "Kitchen tablet",
    createdAt: "2026-10-07T11:55:00.000Z",
    expiresAt: "2026-10-07T12:05:00.000Z",
  },
]

function render(
  overrides: Partial<{
    links: PendingRemotePairingLink[]
    status: PendingPairingLinksStatus
    busy: string | null
    disabled: boolean
    shownLinkId: string | null
  }> = {}
): string {
  return renderToStaticMarkup(
    <PendingPairingLinks
      busy={null}
      disabled={false}
      links={links}
      onRetry={() => {}}
      onRevoke={() => {}}
      onRevokeAll={() => {}}
      shownLinkId={null}
      status="ready"
      {...overrides}
    />
  )
}

describe("PendingPairingLinks", () => {
  it("lists each unused link with its own labelled revoke action and a revoke-all", () => {
    const html = render({ shownLinkId: "grant-2" })
    expect(html).toContain("Unused links (2)")
    expect(html).toContain('data-pairing-link="grant-2"')
    expect(html).toContain('data-pairing-link="grant-1"')
    expect(html).toMatch(
      /aria-label="Revoke the Kitchen tablet link created [^"]+"/
    )
    expect(html).toContain("Trusted device · Shown above")
    expect(html).not.toContain("Kitchen tablet · Shown above")
    expect(html).toContain("Revoke all")
  })

  it("shows the empty, loading and error states without a revoke-all", () => {
    const empty = render({ links: [] })
    expect(empty).toContain("No unused pairing links.")
    expect(empty).not.toContain("Revoke all")

    const loading = render({ status: "loading" })
    expect(loading).toContain("Loading links")
    expect(loading).not.toContain("data-pairing-link")

    const failed = render({ status: "error" })
    expect(failed).toContain("Unused links could not be loaded.")
    expect(failed).toContain("Retry")
    expect(failed).not.toContain("Revoke all")
  })

  it("disables the actions while another remote-access change is running", () => {
    const html = render({ busy: pairingLinkBusyKey("grant-1"), disabled: true })
    expect(html.match(/disabled=""/g)?.length).toBe(3)
    expect(html).toContain("animate-spin")
  })
})
