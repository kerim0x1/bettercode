import { toast } from "sonner"
import { useChatStore } from "./chat-store"
import type { AppMode } from "./preferences-store"
import { resolveThreadRuntimePath } from "./thread-context"

type WindowApi = Pick<NonNullable<Window["electronAPI"]>, "windowOpenWith">

export async function openAppWindow(
  mode: AppMode,
  fallbackCwd?: string | null,
  api: WindowApi | undefined = typeof window === "undefined"
    ? undefined
    : window.electronAPI
): Promise<void> {
  if (!api?.windowOpenWith) return
  const store = useChatStore.getState()
  const thread = store.threads.find(
    (entry) => entry.id === store.activeThreadId
  )
  const cwd = resolveThreadRuntimePath(thread) || fallbackCwd
  try {
    const result = await api.windowOpenWith({ mode, ...(cwd ? { cwd } : {}) })
    if (!result.ok) toast.error(result.error || "Could not open a new window")
  } catch {
    toast.error("Could not open a new window")
  }
}
