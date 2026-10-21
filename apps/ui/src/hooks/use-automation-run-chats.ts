import { useEffect } from "react"
import { ensureAutomationChats } from "@/lib/automation-chats"
import { listAutomations } from "@/services/backend/automations-api"
import { isRemoteRuntime } from "@/services/backend/runtime"

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 60_000

/**
 * Brings the chats automation runs start in the background into the chat
 * list: once a minute while the window is visible, the newest run chat of
 * each automation is added if the list does not have it yet. Desktop only
 * (automations are not available to a paired browser), and quiet on
 * failure: the Automations page reports errors.
 */
export function useAutomationRunChats(): void {
  useEffect(() => {
    if (isRemoteRuntime()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      if (document.visibilityState === "visible") {
        try {
          const { automations } = await listAutomations()
          await ensureAutomationChats(
            automations.flatMap((automation) =>
              automation.lastRun?.threadId ? [automation.lastRun.threadId] : []
            )
          )
        } catch {
          // The backend may be starting or restarting; the next check retries.
        }
      }
      if (!cancelled) timer = setTimeout(() => void check(), CHECK_EVERY_MS)
    }
    timer = setTimeout(() => void check(), FIRST_CHECK_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])
}
