import { useState } from "react"
import { ImportIcon, MonitorIcon } from "lucide-react"
import { SettingsRow } from "@/components/settings/atoms"
import { BrandMarks } from "@/components/settings/brand-mark"
import { Button } from "@/components/ui/button"
import { isRemoteRuntime } from "@/services/backend/runtime"
import { hasElectronApi } from "@/services/ipc-facade"
import { ConversationImportDialog } from "./conversation-import-dialog"

/**
 * Settings → General → Chats & History: opens the conversation import
 * picker. The sessions live on the desktop's own disk, so a paired browser
 * only says where this is done.
 */
export function ConversationImportSettingsRow() {
  const [open, setOpen] = useState(false)
  const desktop = hasElectronApi() && !isRemoteRuntime()

  if (!desktop) {
    return (
      <SettingsRow
        icon={<MonitorIcon />}
        label="Import from Claude Code and Codex"
        description="Managed in the BetterC0de desktop app."
      >
        {null}
      </SettingsRow>
    )
  }

  return (
    <SettingsRow
      icon={<ImportIcon />}
      label="Import from Claude Code and Codex"
      description={
        <>
          Bring earlier conversations from this computer into BetterC0de. Each
          joins the project of its folder; continuing it resumes the original
          session where the CLI allows.
          <BrandMarks ids={["claude", "codex"]} className="mt-1.5 flex" />
        </>
      }
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Choose chats…
      </Button>
      <ConversationImportDialog open={open} onOpenChange={setOpen} />
    </SettingsRow>
  )
}
