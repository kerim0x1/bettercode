import { toast } from "sonner"
import { getElectronApi } from "@/services/ipc-facade"

/** Native writes avoid Chromium's clipboard permission gate in Electron. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const desktopBridge = getElectronApi()
    if (desktopBridge?.writeClipboardText) {
      await desktopBridge.writeClipboardText(text)
    } else {
      await navigator.clipboard.writeText(text)
    }
    return true
  } catch {
    // Report once without putting clipboard contents into the error log.
    toast.error("Could not copy. Select the text and press Ctrl+C.", {
      id: "clipboard-copy-failed",
    })
    return false
  }
}

/**
 * The clipboard's text for a paste the user just asked for (a right-click),
 * or null when it can't be read. Electron keeps Chromium's read permission
 * denied, so the desktop reads it through the main process, which answers
 * only right after a click or key press.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const desktopBridge = getElectronApi()
    if (desktopBridge?.readClipboardText) {
      return await desktopBridge.readClipboardText()
    }
    return await navigator.clipboard.readText()
  } catch {
    toast.error("Could not paste. Use the paste shortcut instead.", {
      id: "clipboard-paste-failed",
    })
    return null
  }
}
