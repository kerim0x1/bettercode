import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { dispatchTerminalNewSession } from "@/lib/terminal-events"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type { ActiveThreadRef } from "./provider-config"

export function dispatchPrefilledTerminalCommand(
  activeThread: ActiveThreadRef,
  command: string
): void {
  const prefs = usePreferencesStore.getState()
  prefs.set("terminalOpen", true)
  const threadId = activeThread?.id ?? useChatStore.getState().activeThreadId
  window.setTimeout(() => {
    dispatchTerminalNewSession({
      threadId,
      mode: prefs.appMode,
      cwd: resolveThreadRuntimePath(activeThread),
      initialCommand: command,
    })
  }, 0)
}

export function buildToggleOutput(label: string, enabled: boolean): string {
  return `# ${label}\n\n${enabled ? "Enabled" : "Disabled"}`
}
