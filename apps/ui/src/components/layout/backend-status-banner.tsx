import { useEffect, useState } from "react"
import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { BackendStatusEvent } from "@/types/electron-api"
import { getElectronApi } from "@/services/ipc-facade"

export type BackendBannerState =
  | { kind: "hidden" }
  | { kind: "restarting"; attempt?: number; reason?: string }
  | { kind: "failed"; reason?: string; crashLoop: boolean }

/**
 * Maps `backend:status` events to what the banner shows. Automatic restarts
 * after a crash are announced; restarts the user started elsewhere (remote
 * access settings) keep their own progress UI. A `failed` backend always
 * offers a manual restart.
 */
export function nextBackendBannerState(
  previous: BackendBannerState,
  event: BackendStatusEvent
): BackendBannerState {
  switch (event.status) {
    case "ready":
      return { kind: "hidden" }
    case "restarting":
      if (event.automatic === true) {
        return {
          kind: "restarting",
          attempt: event.attempt,
          reason: event.reason,
        }
      }
      // A restart the user asked for from the failed state stays visible.
      return previous.kind === "hidden"
        ? previous
        : { kind: "restarting", reason: event.reason }
    case "failed":
    case "stopped":
      return {
        kind: "failed",
        reason: event.reason,
        crashLoop: event.crashLoop === true,
      }
    default:
      return previous
  }
}

function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
}

/**
 * Floating notice for a local backend that crashed. The Electron supervisor
 * restarts it automatically with backoff; after repeated crashes it stops and
 * this banner offers a manual restart, which does not need the (dead)
 * backend. Renders nothing while the backend is healthy or outside Electron.
 */
export function BackendStatusBanner() {
  const [state, setState] = useState<BackendBannerState>({ kind: "hidden" })
  const [restartPending, setRestartPending] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)

  useEffect(() => {
    const api = getElectronApi()
    if (!api?.onBackendStatus) return
    return api.onBackendStatus((value) => {
      if (!value || typeof value !== "object") return
      const event = value as BackendStatusEvent
      setState((previous) => nextBackendBannerState(previous, event))
      if (event.status === "ready") setRestartError(null)
    })
  }, [])

  if (state.kind === "hidden") return null

  const restart = async () => {
    const api = getElectronApi()
    if (!api?.restartBackend || restartPending) return
    setRestartPending(true)
    setRestartError(null)
    setState({ kind: "restarting" })
    try {
      await api.restartBackend()
    } catch (error) {
      setRestartError(ipcErrorMessage(error))
      setState({ kind: "failed", crashLoop: false })
    } finally {
      setRestartPending(false)
    }
  }

  const failed = state.kind === "failed"
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 w-[min(26rem,calc(100vw-2rem))]">
      <Alert
        variant={failed ? "destructive" : "default"}
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        className="pointer-events-auto border-border shadow-lg"
      >
        {failed ? (
          <AlertTriangleIcon aria-hidden="true" />
        ) : (
          <Loader2Icon
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        )}
        <AlertTitle>
          {failed
            ? "The local backend stopped"
            : "Restarting the local backend"}
        </AlertTitle>
        <AlertDescription>
          <p>
            {failed
              ? state.crashLoop
                ? "It crashed several times in a row, so automatic restarts are paused. Chats, terminals and file operations are unavailable until it runs again."
                : "Chats, terminals and file operations are unavailable until it runs again."
              : state.attempt
                ? `It stopped unexpectedly and is being restarted (attempt ${state.attempt}). Your chats are kept.`
                : "Your chats are kept."}
          </p>
          {state.reason ? (
            <p className="mt-1 font-mono text-xs break-words text-muted-foreground">
              {state.reason}
            </p>
          ) : null}
          {restartError ? (
            <p className="mt-1 text-xs text-destructive">
              Restart failed: {restartError}
            </p>
          ) : null}
          {failed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2 gap-1.5"
              disabled={restartPending}
              onClick={() => void restart()}
            >
              <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              Restart backend
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  )
}
