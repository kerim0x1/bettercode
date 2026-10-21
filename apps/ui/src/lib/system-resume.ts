import { getElectronApi } from "@/services/ipc-facade"
/**
 * Calls `listener` when the computer wakes from sleep. The desktop shell
 * reports it (powerMonitor `resume`); timers stretch across a suspend, so
 * whatever was scheduled before it (a reconnect backoff, a poll) may now be
 * far in the future. Outside the desktop app this never fires.
 *
 * Returns an unsubscribe function.
 */
export function onSystemResume(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const subscribe = getElectronApi()?.onSystemResume
  if (typeof subscribe !== "function") return () => {}
  return subscribe(() => {
    try {
      listener()
    } catch (error) {
      console.error("[system] resume listener failed:", error)
    }
  })
}
