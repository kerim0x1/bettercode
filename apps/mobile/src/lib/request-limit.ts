import { DEFAULT_MAX_REQUEST_BYTES } from "./compat"

/**
 * The largest request the paired desktop accepts. The session store keeps
 * it current from the desktop's protocol (session-store.ts); the stores
 * that send read it here, so they need not depend on the session.
 */
let limit = DEFAULT_MAX_REQUEST_BYTES

export function maxRequestBytesNow(): number {
  return limit
}

export function setMaxRequestBytes(bytes: number): void {
  limit = bytes
}
