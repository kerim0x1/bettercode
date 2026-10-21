import { toast } from "sonner"

/** Native writes avoid Chromium's clipboard permission gate in Electron. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof window !== "undefined" &&
      window.electronAPI?.writeClipboardText
    ) {
      await window.electronAPI.writeClipboardText(text)
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
