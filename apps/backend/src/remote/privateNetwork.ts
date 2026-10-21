import { isIP } from "node:net"
import { normalizeSocketAddress } from "./tailscale"

/**
 * The client a trusted proxy saw, read from `X-Forwarded-For`. A proxy
 * *appends* the peer it accepted the connection from, so only the
 * rightmost entry was written by the hop we trust; everything left of it
 * is whatever the client chose to send. Reading the leftmost entry let a
 * public peer claim a LAN address and pair a full plaintext session.
 * Only meaningful behind a trusted proxy: without one the whole header
 * is attacker-controlled and callers must not consult it at all.
 */
export function forwardedClientAddress(
  header: string | readonly string[] | undefined | null
): string | null {
  const raw = Array.isArray(header) ? header[header.length - 1] : header
  if (typeof raw !== "string") return null
  const hops = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return hops.length > 0 ? hops[hops.length - 1]! : null
}

/**
 * Addresses that only exist inside a home, office or VPN network: RFC 1918,
 * link-local, and the IPv6 ULA / link-local ranges. A plaintext request from
 * such a peer qualifies for BetterC0de's private-network pairing policy: it
 * may pair without TLS, but only as short read-only monitoring, since a
 * private address is not encryption. Deliberately excludes the
 * Tailscale CGNAT range 100.64/10: an ISP can hand that out on a physical
 * interface shared with strangers, so it only counts when the packets
 * demonstrably arrived through the tailnet (`requestPeerIsTailnet`).
 */
/**
 * A socket or forwarded address in 127.0.0.0/8, or IPv6 `::1`. The value has
 * to be an IP literal: `127.0.0.1.nip.io` is a DNS name that can resolve to
 * loopback, and a prefix check would treat that name as this machine.
 */
export function isLoopbackIpAddress(address: string): boolean {
  const normalized = normalizeSocketAddress(address)
  if (normalized === "::1") return true
  if (isIP(normalized) !== 4) return false
  return Number(normalized.split(".")[0]) === 127
}

/** `localhost` or a loopback IP literal. Extra DNS labels never qualify. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeSocketAddress(hostname)
  return normalized === "localhost" || isLoopbackIpAddress(normalized)
}

export function isPrivateLanAddress(address: string): boolean {
  const normalized = normalizeSocketAddress(address)
  const family = isIP(normalized)
  if (family === 4) {
    const parts = normalized.split(".").map(Number)
    const [a, b] = parts as [number, number, number, number]
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (family === 6) {
    // fc00::/7 (ULA) and fe80::/10 (link-local).
    return (
      /^f[cd][0-9a-f]{2}:/.test(normalized) ||
      /^fe[89ab][0-9a-f]:/.test(normalized)
    )
  }
  return false
}
