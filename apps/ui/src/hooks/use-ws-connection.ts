import { useEffect, useRef } from "react"
import { connectWs } from "@/services/backend/wsClient"
import { getWsPort } from "@/services/backend/coreApi"
import { onBackendReady, whenBackendReady } from "@/services/backend/runtime"
import type { WsEventHandler } from "@/services/backend/types"
import { onSystemResume } from "@/lib/system-resume"

/**
 * Establishes the app's persistent WebSocket connection to the backend
 * and keeps it alive across reconnects.
 *
 * Behavior:
 *  - Waits for the shell to report the backend as ready
 *    (`whenBackendReady`) instead of polling for `window.__BETTERC0DE__`,
 *    then resolves the port.
 *  - Connects via `connectWs`; on success, stores the socket on
 *    `wsRef.current` and flips `setWsReady(true)`.
 *  - On socket close (not user-initiated), schedules an exponential-
 *    backoff reconnect — capped at 30s with a small jitter, bounded to
 *    2^6 * 1s base delay.
 *  - A backend "ready" event (first start or restart), or the computer
 *    waking from sleep, skips any pending backoff and reconnects at once.
 *  - Cleanup on unmount cancels any pending reconnect and closes the
 *    current socket so stale sockets can't emit events into a torn-down
 *    component tree.
 *
 * The `onEvent` prop is the ws message handler — the hook intentionally
 * doesn't know *what* the events mean, only how to route them. The
 * callback is re-latched on every render; the effect re-creates on
 * `depKey` changes which should be a stable value the caller
 * increments only when it really wants to reconnect.
 */
export function useWsConnection({
  wsRef,
  setWsReady,
  onEvent,
  depKey,
}: {
  wsRef: React.MutableRefObject<WebSocket | null>
  setWsReady: (ready: boolean) => void
  onEvent: WsEventHandler
  depKey?: unknown
}) {
  const callbacks = useRef({ onEvent, setWsReady })
  useEffect(() => {
    callbacks.current = { onEvent, setWsReady }
  })
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    let connected = false
    let connecting = false
    let attemptId = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return
      const cappedAttempt = Math.min(reconnectAttempt, 6)
      const baseDelay = 1000 * 2 ** cappedAttempt
      const jitter = Math.floor(Math.random() * 300)
      const delay = Math.min(baseDelay + jitter, 30000)
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, delay)
    }

    /**
     * The port is resolved per attempt rather than captured once. Before this,
     * an attempt made while the backend was still booting locked onto the
     * hardcoded fallback port and every retry redialled it forever; the same
     * applied after a backend restart moved the port.
     *
     * One attempt runs at a time. `force` starts a new one anyway (the backend
     * just came up, so an attempt still dialling the old port is stale); the
     * older attempt then finishes without touching any state.
     */
    const connect = async (force = false) => {
      if (cancelled || (connecting && !force)) return
      const attempt = ++attemptId
      connecting = true
      const isCurrent = () => !cancelled && attempt === attemptId
      try {
        const port = await getWsPort()
        if (!isCurrent()) return
        let connectedWs: WebSocket | null = null
        const handleClose = () => {
          if (cancelled) return
          connected = false
          if (connectedWs && wsRef.current === connectedWs) wsRef.current = null
          callbacks.current.setWsReady(false)
          scheduleReconnect()
        }
        const nextWs = await connectWs(
          port,
          undefined,
          (event) => {
            if (!cancelled) callbacks.current.onEvent(event)
          },
          undefined,
          handleClose,
          controller.signal
        )
        connectedWs = nextWs
        if (!isCurrent()) {
          // Unmounted, or a newer attempt took over while this one finished.
          nextWs.close()
          return
        }
        connected = true
        reconnectAttempt = 0
        clearReconnectTimer()
        wsRef.current = nextWs
        callbacks.current.setWsReady(true)
      } catch {
        if (!isCurrent()) return
        callbacks.current.setWsReady(false)
        scheduleReconnect()
      } finally {
        if (attempt === attemptId) connecting = false
      }
    }

    // A (re)started backend is reachable now: drop any pending backoff and
    // dial immediately. A healthy socket is left alone.
    const reconnectNow = () => {
      if (cancelled || connected) return
      reconnectAttempt = 0
      clearReconnectTimer()
      void connect(true)
    }
    const unsubscribeReady = onBackendReady(reconnectNow)
    // After sleep the backoff timer may be stretched far into the future, so
    // a disconnected window retries at once. (The shell re-checks the
    // backend on resume as well and reports a restart through "ready".)
    const unsubscribeResume = onSystemResume(reconnectNow)

    whenBackendReady(controller.signal)
      .then(() => {
        if (cancelled || connected) return
        void connect()
      })
      .catch(() => {
        // Only an unmount aborts the wait.
      })
    return () => {
      cancelled = true
      unsubscribeReady()
      unsubscribeResume()
      controller.abort()
      clearReconnectTimer()
      wsRef.current = null
      // Abort also closes sockets still waiting for auth_ok.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])
}
