import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  HistoryIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { SettingsUpdatesSection } from "@/components/settings/privacy-updates-sections"
import { useSettingsStore } from "@/lib/settings-store"
import { openArchivedChats } from "@/lib/chat-list-dialogs"
import { ConversationImportSettingsRow } from "@/components/conversation-import/conversation-import-settings-row"

/**
 * "General" settings: updates, how chats are kept and removed, and the
 * reset. Look, layout, chat display, notifications and privacy each have
 * their own tab.
 *
 * The reset confirmation dialog is rendered by `SettingsPage`; this section
 * only opens it via `onOpenResetConfirm`.
 */
export function SettingsGeneralSection({
  onOpenResetConfirm,
}: {
  onOpenResetConfirm: () => void
}) {
  const settings = useSettingsStore()

  return (
    <>
      <SettingsUpdatesSection />

      <SettingsSection
        title="Chats & History"
        description="Also from chat: /autosave, /confirmations"
      >
        <SettingsRow
          icon={<HistoryIcon />}
          label="Save Conversations"
          description="Keep new messages, activity and provider logs in your local history. Off stops saving new turns; what is already saved stays."
        >
          <Switch
            aria-label="Save Conversations"
            checked={settings.autoSaveConversations}
            onCheckedChange={(value) =>
              settings.update({ auto_save_conversations: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<ArchiveRestoreIcon />}
          label="Archived chats"
          description="Search the chats you archived, read them, restore them to the sidebar or delete them."
        >
          <Button variant="outline" size="sm" onClick={openArchivedChats}>
            Show ({settings.archivedThreadIds.length})
          </Button>
        </SettingsRow>
        <ConversationImportSettingsRow />
        <SettingsRow
          icon={<ArchiveIcon />}
          label="Confirm Archive"
          description="Ask before a chat is archived from a menu. /unarchive brings it back."
        >
          <Switch
            aria-label="Confirm Archive"
            checked={settings.confirmArchive}
            onCheckedChange={(value) =>
              settings.update({ confirm_archive: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<Trash2Icon />}
          label="Confirm Delete"
          description="Ask before a chat is deleted. Deleting all chats of a project always asks."
        >
          <Switch
            aria-label="Confirm Delete"
            checked={settings.confirmDelete}
            onCheckedChange={(value) =>
              settings.update({ confirm_delete: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Reset">
        <SettingsRow
          icon={<RotateCcwIcon />}
          label="Reset all preferences"
          description="Layout, model choices and appearance go back to their defaults. Chat, notification and privacy settings, API keys and chat history stay."
        >
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onOpenResetConfirm}
          >
            <RefreshCwIcon className="mr-2 size-3.5" />
            Reset Settings
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
