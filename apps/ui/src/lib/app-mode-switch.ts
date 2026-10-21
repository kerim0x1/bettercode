import { useChatStore } from "./chat-store"
import { usePreferencesStore, type AppMode } from "./preferences-store"
import { resolveThreadRuntimePath } from "./thread-context"

export interface AppModeSwitchUi {
  setAppMode: (mode: AppMode) => void
  setSystemBrowserIntent: (
    intent: "agent-new-thread" | "editor-open-folder"
  ) => void
  setSystemBrowserOpen: (open: boolean) => void
  activeProjectPath?: string | null
}

/**
 * Switches the app mode the same way from every control. Editor Mode works
 * on a folder: it opens the file tree, and the folder picker when no chat
 * has a folder yet.
 */
export function switchAppMode(mode: AppMode, ui: AppModeSwitchUi) {
  ui.setAppMode(mode)
  if (mode !== "editor") return
  usePreferencesStore.getState().set("fileTreeOpen", true)
  if (
    ui.activeProjectPath ||
    useChatStore
      .getState()
      .threads.some((thread) => resolveThreadRuntimePath(thread))
  )
    return
  ui.setSystemBrowserIntent("editor-open-folder")
  ui.setSystemBrowserOpen(true)
}
