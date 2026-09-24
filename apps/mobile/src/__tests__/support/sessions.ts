import type { RemoteAccessLevel } from "@betterc0de/schema/remote-protocol"
import { DEMO_PROFILE, useSessionStore } from "@/store/session-store"
import { createDemoTransport, DEMO_PROTOCOL } from "@/transport/demo"
import type { RemoteApi, RemoteTransport } from "@/transport/types"

/**
 * A paired desktop for screen tests: a live session whose calls the demo's
 * in-memory desktop answers, except the ones a test replaces. A replacement
 * given as a function receives the demo's own calls, to pass some through.
 * Nothing reaches the network.
 */
export function pairWithTestDesktop(
  options: {
    accessLevel?: RemoteAccessLevel
    api?: Partial<RemoteApi> | ((demo: RemoteApi) => Partial<RemoteApi>)
  } = {}
): RemoteTransport {
  const accessLevel = options.accessLevel ?? "full"
  const desktop = createDemoTransport({ chunkDelayMs: 0 })
  const overrides =
    typeof options.api === "function" ? options.api(desktop.api) : options.api
  const transport: RemoteTransport & { dispose(): void } = {
    kind: "live",
    api: { ...desktop.api, ...overrides },
    createChannel: desktop.createChannel,
    dispose: desktop.dispose,
  }
  useSessionStore.setState({
    mode: "live",
    profile: {
      ...DEMO_PROFILE,
      baseUrl: "http://192.168.1.20:8787",
      session: { ...DEMO_PROFILE.session, accessLevel },
    },
    transport,
    protocol: {
      ...DEMO_PROTOCOL,
      capabilities: {
        accessLevel,
        terminalGranted: false,
        maxRequestBytes: 2 * 1024 * 1024,
        features: DEMO_PROTOCOL.capabilities?.features ?? [],
      },
    },
    compatibility: { kind: "ok" },
    state: "online",
    socketState: "live",
    error: null,
    notice: null,
  })
  return transport
}
