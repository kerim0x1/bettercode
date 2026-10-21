import { useSettingsStore } from "@/lib/settings-store"

export interface ThreadConfirmDialog {
  title: string
  description: string
  action: () => void
}

/**
 * Archive and delete from menus ask first only while Settings → General →
 * Confirm Archive / Confirm Delete is on; otherwise the action runs at once.
 * Without a dialog host, archive still runs (it can be undone with
 * /unarchive) and delete does nothing, as before.
 */
export function runThreadAction(
  kind: "archive" | "delete",
  dialog: ThreadConfirmDialog,
  onConfirm?: (dialog: ThreadConfirmDialog) => void
): void {
  const settings = useSettingsStore.getState()
  const ask =
    kind === "archive" ? settings.confirmArchive : settings.confirmDelete
  if (ask && onConfirm) {
    onConfirm(dialog)
    return
  }
  if (!ask || kind === "archive") dialog.action()
}

/** The archive dialog for one chat. */
export function archiveChatDialog(
  title: string | undefined,
  action: () => void
): ThreadConfirmDialog {
  return {
    title: "Archive chat?",
    description: `"${title || "New Chat"}" leaves the sidebar. /unarchive brings it back.`,
    action,
  }
}
