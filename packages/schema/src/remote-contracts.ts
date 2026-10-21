import { z } from "zod"
import {
  endpoint,
  ignoredBody,
  noBody,
  type RecordSchema,
} from "./http-endpoint"
import {
  pendingRemotePairingLinkSchema,
  remoteBootstrapResponseSchema,
  remoteBrowserPairResponseSchema,
  remoteMobilePairResponseSchema,
  remotePairingGrantSchema,
  remoteSessionListSchema,
  remoteStatusSchema,
  tailscaleRemoteStatusSchema,
  type PendingRemotePairingLink,
} from "./remote-protocol"

/**
 * The remote access routes (`apps/backend/src/remote/http.ts`): pairing,
 * the desktop's addresses, its paired devices and Tailscale. Their records
 * are the shared ones in `remote-protocol.ts`, which the phone app compiles
 * in.
 *
 * Paired apps in the field send these requests, so each request schema
 * reads a body exactly as the route always has: a value it used to ignore
 * is still ignored (read as absent), never refused. Errors keep their
 * existing text and `code`.
 */

/**
 * `POST /remote/pair` and `POST /remote/mobile/pair`: the one-time code and
 * a name for the device. A code that is missing, not text or longer than 64
 * characters reads as empty, so it is refused as wrong (401
 * `pairing_code_invalid`); a label that is not text or longer than 80
 * characters is left out.
 */
export const remotePairRequestSchema = z
  .object({
    credential: z.string().max(64).catch(""),
    label: z.string().max(80).optional().catch(undefined),
  })
  .passthrough()

/**
 * `POST /remote/pairing-links`. Both fields are optional, and a body that
 * is not JSON at all reads as `{}`: the desktop's defaults apply.
 */
export const remotePairingLinkCreateSchema = z
  .object({
    label: z.string().optional().catch(undefined),
    /** Clamped by the backend to its own bounds. */
    ttlMinutes: z.number().optional().catch(undefined),
  })
  .passthrough()

/** `POST /remote/tailscale/serve`: turn the HTTPS mapping on or off. */
export const remoteTailscaleServeSchema = z
  .object({ enabled: z.boolean() })
  .passthrough()

/** `GET /remote/pairing-links`, desktop host only. */
export interface RemotePairingLinkList {
  pairingLinks: PendingRemotePairingLink[]
}

const remotePairingLinkListSchema: RecordSchema<RemotePairingLinkList> = z
  .object({ pairingLinks: z.array(pendingRemotePairingLinkSchema) })
  .passthrough()

/** How many pairing links or sessions were withdrawn. */
const revokedCountSchema = z
  .object({ revoked: z.number().int().nonnegative() })
  .passthrough()

/** Whether the one named pairing link or session was withdrawn. */
const revokedOneSchema = z.object({ revoked: z.boolean() }).passthrough()

export const remoteHttpContracts = {
  // Public: answered with or without a session, and before pairing.
  remoteBootstrap: endpoint(
    "GET",
    "/remote/bootstrap",
    noBody,
    remoteBootstrapResponseSchema
  ),
  // The browser's session rides in an HttpOnly cookie; a native app gets a
  // bearer token instead.
  remotePair: endpoint(
    "POST",
    "/remote/pair",
    remotePairRequestSchema,
    remoteBrowserPairResponseSchema
  ),
  remoteMobilePair: endpoint(
    "POST",
    "/remote/mobile/pair",
    remotePairRequestSchema,
    remoteMobilePairResponseSchema
  ),
  remoteStatus: endpoint("GET", "/remote/status", noBody, remoteStatusSchema),
  remoteLogout: endpoint(
    "POST",
    "/remote/logout",
    ignoredBody,
    z.object({ loggedOut: z.boolean() }).passthrough()
  ),
  // Desktop host only: a paired device gets a 403.
  remoteTailscaleStatus: endpoint(
    "GET",
    "/remote/tailscale",
    noBody,
    tailscaleRemoteStatusSchema
  ),
  remoteTailscaleServe: endpoint(
    "POST",
    "/remote/tailscale/serve",
    remoteTailscaleServeSchema,
    tailscaleRemoteStatusSchema
  ),
  remotePairingLinkCreate: endpoint(
    "POST",
    "/remote/pairing-links",
    remotePairingLinkCreateSchema,
    remotePairingGrantSchema
  ),
  remotePairingLinkList: endpoint(
    "GET",
    "/remote/pairing-links",
    noBody,
    remotePairingLinkListSchema
  ),
  remotePairingLinkRevokeAll: endpoint(
    "DELETE",
    "/remote/pairing-links",
    noBody,
    revokedCountSchema
  ),
  remotePairingLinkRevoke: endpoint(
    "DELETE",
    "/remote/pairing-links/:pairingId",
    noBody,
    revokedOneSchema
  ),
  remoteSessionList: endpoint(
    "GET",
    "/remote/sessions",
    noBody,
    remoteSessionListSchema
  ),
  remoteSessionTerminalsEnd: endpoint(
    "DELETE",
    "/remote/sessions/:sessionId/terminals",
    noBody,
    z.object({ ended: z.number().int().nonnegative() }).passthrough()
  ),
  remoteSessionRevoke: endpoint(
    "DELETE",
    "/remote/sessions/:sessionId",
    noBody,
    revokedOneSchema
  ),
  remoteSessionRevokeOthers: endpoint(
    "POST",
    "/remote/sessions/revoke-others",
    ignoredBody,
    revokedCountSchema
  ),
} as const
