import {
  REMOTE_API_VERSION,
  REMOTE_FEATURES,
  REMOTE_MIN_CLIENT_VERSION,
  remoteProtocolSchema,
  type RemoteAccessLevel,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import { readBackendVersion } from "../version"

/** Largest request body the API accepts (see the router's body limit). */
export const API_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/** Everything this desktop implements beyond `REMOTE_API_VERSION`'s baseline. */
const FEATURES: readonly string[] = [
  REMOTE_FEATURES.threadsGet,
  REMOTE_FEATURES.workspaceWriteIfMatch,
  REMOTE_FEATURES.threadsRename,
  REMOTE_FEATURES.preparedTurns,
]

const backendVersion = readBackendVersion()

/**
 * What an unauthenticated caller may learn: enough to decide whether its app
 * can pair with this desktop at all, nothing that fingerprints the install.
 */
export function publicRemoteProtocol(): RemoteProtocol {
  return {
    apiVersion: REMOTE_API_VERSION,
    minClientVersion: REMOTE_MIN_CLIENT_VERSION,
  }
}

export interface RemoteProtocolInputs {
  /** Effective for this request or connection (plaintext downgrades included). */
  readonly accessLevel: RemoteAccessLevel
  /** `remote_access_allow_terminal` on the desktop. */
  readonly terminalAllowed: boolean
}

/**
 * The full protocol block for an authenticated caller. It is parsed through
 * the shared schema so the desktop can never advertise a shape the phone's
 * parser rejects.
 */
export function describeRemoteProtocol({
  accessLevel,
  terminalAllowed,
}: RemoteProtocolInputs): RemoteProtocol {
  return remoteProtocolSchema.parse({
    ...publicRemoteProtocol(),
    backendVersion,
    capabilities: {
      accessLevel,
      terminalGranted: terminalAllowed && accessLevel === "full",
      maxRequestBytes: API_BODY_LIMIT_BYTES,
      features: [...FEATURES],
    },
  })
}
