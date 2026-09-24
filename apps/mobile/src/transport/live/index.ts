import type { RemoteClientInfo } from "@betterc0de/schema/remote-protocol"
import type { ConnectionProfile } from "@/types/remote"
import type { RemoteApi, RemoteTransport } from "../types"
import { createLiveApi } from "./api"
import { RemoteApiError } from "./http"
import { RemoteSocket } from "./socket"

export { pairMobile } from "./api"
export { RemoteApiError } from "./http"

export interface LiveTransportOptions {
  readonly client: RemoteClientInfo | null
  /**
   * Called with every refusal before the caller sees it, so a session-wide
   * answer (the app is too old, the session is gone) is handled in one place.
   */
  readonly onRefusal?: (error: RemoteApiError) => void
}

function observeRefusals(
  api: RemoteApi,
  onRefusal: (error: RemoteApiError) => void
): RemoteApi {
  const observed: Record<string, unknown> = {}
  for (const [name, method] of Object.entries(api) as Array<
    [string, (...args: unknown[]) => Promise<unknown>]
  >) {
    observed[name] = async (...args: unknown[]) => {
      try {
        return await method(...args)
      } catch (error) {
        if (error instanceof RemoteApiError) onRefusal(error)
        throw error
      }
    }
  }
  return observed as unknown as RemoteApi
}

/** The paired desktop: HTTP for requests, the WebSocket for live events. */
export function createLiveTransport(
  profile: ConnectionProfile,
  options: LiveTransportOptions
): RemoteTransport {
  const api = createLiveApi({
    baseUrl: profile.baseUrl,
    token: profile.sessionToken,
    client: options.client,
  })
  return {
    kind: "live",
    api: options.onRefusal ? observeRefusals(api, options.onRefusal) : api,
    createChannel: (handlers) =>
      new RemoteSocket(
        {
          baseUrl: profile.baseUrl,
          sessionToken: profile.sessionToken,
          client: options.client,
        },
        handlers
      ),
  }
}
