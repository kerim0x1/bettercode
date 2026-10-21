import type {
  BackendStatusEvent,
  ElectronRuntimeConfig,
} from "@/types/electron-api"

/**
 * Desktop runtime config (backend port, preview partition, preload path)
 * comes from the Electron main process over IPC (`runtime:config`) instead of
 * being injected into the page with `executeJavaScript`. It is published on
 * `window.__BETTERC0DE__`, where the backend clients already read it.
 *
 * Order matters: the `backend:status` subscription is set up before the
 * config is requested. A `ready` event sent before the subscription is then
 * reflected in the reply (main records the port before broadcasting), and
 * every later restart arrives as an event.
 */
let initialized = false

function publish(next: Partial<ElectronRuntimeConfig>) {
  const current = window.__BETTERC0DE__
  // Backend-served remote pages own their config; never overwrite it.
  if (current?.mode === "remote_http") return
  window.__BETTERC0DE__ = {
    ...(current ?? { port: 0, mode: "local_sidecar" }),
    ...next,
    port: typeof next.port === "number" && next.port > 0 ? next.port : 0,
    mode: next.mode ?? current?.mode ?? "local_sidecar",
  }
}

export async function initDesktopRuntimeConfig(): Promise<void> {
  if (typeof window === "undefined" || initialized) return
  const api = window.electronAPI
  if (!api?.getRuntimeConfig || window.__BETTERC0DE__?.mode === "remote_http") {
    return
  }
  initialized = true
  api.onBackendStatus?.((value) => {
    const event = value as BackendStatusEvent | null
    if (
      event?.status === "ready" &&
      typeof event.port === "number" &&
      event.port > 0
    ) {
      publish({ port: event.port })
    }
  })
  try {
    const config = await api.getRuntimeConfig()
    if (config && typeof config === "object") publish(config)
  } catch (error) {
    console.warn("[runtime] could not read the desktop runtime config:", error)
  }
}

/** Test hook: forget the one-time initialization. */
export function __resetDesktopRuntimeConfigForTests(): void {
  initialized = false
}
