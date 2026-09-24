import type { RemoteTransport } from "../types"
import { DEMO_PROTOCOL, DemoBackend, type DemoOptions } from "./backend"

export { DEMO_PROTOCOL, DemoBackend, type DemoOptions } from "./backend"
export { DEMO_ENVIRONMENT_ID } from "./fixtures"

/** "Try the demo": the whole app against an in-memory desktop. */
export function createDemoTransport(
  options: DemoOptions = {}
): RemoteTransport & {
  dispose(): void
} {
  const backend = new DemoBackend(options)
  return {
    kind: "demo",
    api: backend.api,
    createChannel: (handlers) => {
      let unsubscribe: (() => void) | null = null
      return {
        start: () => {
          if (unsubscribe) return
          unsubscribe = backend.subscribe(handlers.onFrame)
          handlers.onState("live")
          handlers.onProtocol?.(DEMO_PROTOCOL)
        },
        stop: () => {
          unsubscribe?.()
          unsubscribe = null
        },
        reconnectNow: () => undefined,
      }
    },
    dispose: () => backend.dispose(),
  }
}
