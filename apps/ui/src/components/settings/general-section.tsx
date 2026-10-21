import { useState } from "react"
import { isDiffViewOpen, setDiffViewOpen } from "@/lib/diff-view"
import { BellIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import {
  nativeNotificationPermission,
  requestNativeNotificationPermission,
} from "@/lib/native-notifications"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useSettingsStore } from "@/lib/settings-store"

/**
 * "General" settings tab content — theme switcher, a muted note on the
 * intentionally-hidden behavior toggles, and the entry point to the
 * settings-reset flow.
 *
 * The actual reset confirmation dialog is rendered by the parent modal;
 * this section only opens it via `onOpenResetConfirm`. Keeping the dialog
 * at the modal level means one instance is shared with the Docs tab and
 * global reset entry points.
 */
export function SettingsGeneralSection({
  theme,
  setTheme,
  onOpenResetConfirm,
}: {
  theme: string | undefined
  setTheme: (theme: "system" | "light" | "dark") => void
  onOpenResetConfirm: () => void
}) {
  const settings = useSettingsStore()
  const preferences = usePreferencesStore()
  const [notificationPermission, setNotificationPermission] = useState(() =>
    nativeNotificationPermission()
  )

  return (
    <>
      <SettingsSection title="Appearance">
        <SettingsRow
          label="Theme"
          description="Choose how BetterC0de looks across the app"
        >
          <Select
            value={theme === "light" ? "light" : "dark"}
            onValueChange={(v) => setTheme(v as "light" | "dark")}
          >
            <SelectTrigger className="w-[200px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Default Dark</SelectItem>
              <SelectItem value="light">White</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Workspace Layout"
        description="BetterC0de visibility controls for the main workspace panels. These match the titlebar buttons and chat commands such as /sidebar, /terminal, /review.toggle, and /console."
      >
        <SettingsRow
          label="Main Sidebar"
          description="Show the primary navigation and thread list"
        >
          <Switch
            checked={preferences.sidebarOpen}
            onCheckedChange={(value) => preferences.set("sidebarOpen", value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Workspace Sidebar"
          description="Show the editor explorer and workspace tools"
        >
          <Switch
            checked={preferences.workspaceSidebarOpen}
            onCheckedChange={(value) =>
              preferences.set("workspaceSidebarOpen", value)
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Right Panel"
          description="Show the workspace assistant, files, git, terminal, and diff area"
        >
          <Switch
            checked={preferences.rightSidebarOpen}
            onCheckedChange={(value) =>
              preferences.set("rightSidebarOpen", value)
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Files View"
          description="Open the project file tree in the workspace panel"
        >
          <Switch
            checked={
              preferences.rightSidebarOpen &&
              preferences.workspaceTab === "files"
            }
            onCheckedChange={(value) => {
              if (value) {
                preferences.set("rightSidebarOpen", true)
                preferences.set("workspaceTab", "files")
              } else if (preferences.workspaceTab === "files") {
                preferences.set("workspaceTab", "plan")
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Terminal"
          description="Show the integrated terminal panel"
        >
          <Switch
            checked={preferences.terminalOpen}
            onCheckedChange={(value) => preferences.set("terminalOpen", value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Review / Diff"
          description="Show the code review and diff panel"
        >
          <Switch
            checked={isDiffViewOpen(preferences)}
            onCheckedChange={setDiffViewOpen}
          />
        </SettingsRow>
        <SettingsRow
          label="Console"
          description="Show the developer console panel"
        >
          <Switch
            checked={preferences.consolePanelOpen}
            onCheckedChange={(value) =>
              preferences.set("consolePanelOpen", value)
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Behavior"
        description="BetterC0de runtime controls. The same toggles are available from chat with /streaming, /timestamps, /thinking, /reasoning-summaries, /actions, /progress, /shell-expanded, /edit-expanded, /scrollbar, /generic-tool-output, /conceal, /autosave, /diffwrap, and /confirmations."
      >
        <SettingsRow
          label="Assistant Streaming"
          description="Show the answer as it is written. Off delivers each answer in one piece — reasoning and tool activity keep streaming either way."
        >
          <Switch
            checked={settings.enableAssistantStreaming}
            onCheckedChange={(value) =>
              settings.update({ enable_assistant_streaming: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Message Timestamps"
          description="Show timestamps in chat message metadata"
        >
          <Switch
            checked={settings.showMessageTimestamps}
            onCheckedChange={(value) =>
              settings.update({ show_message_timestamps: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Thinking Blocks"
          description="Show assistant reasoning and thought summaries in chat"
        >
          <Switch
            checked={settings.showThinkingBlocks}
            onCheckedChange={(value) =>
              settings.update({ show_thinking_blocks: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Reasoning Summaries"
          description="Show a compact reasoning heading in thinking rows"
        >
          <Switch
            checked={settings.showReasoningSummaries}
            onCheckedChange={(value) =>
              settings.update({ show_reasoning_summaries: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Tool Details"
          description="Open tool output previews by default in chat"
        >
          <Switch
            checked={settings.showToolDetails}
            onCheckedChange={(value) =>
              settings.update({ show_tool_details: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Session Progress"
          description="Show BetterC0de live task progress in chat"
        >
          <Switch
            checked={settings.showSessionProgressBar}
            onCheckedChange={(value) =>
              settings.update({ show_session_progress_bar: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Shell Tool Parts"
          description="Expand shell, bash, exec, and command tool output by default"
        >
          <Switch
            checked={settings.shellToolPartsExpanded}
            onCheckedChange={(value) =>
              settings.update({ shell_tool_parts_expanded: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Edit Tool Parts"
          description="Expand edit, write, and patch tool output by default"
        >
          <Switch
            checked={settings.editToolPartsExpanded}
            onCheckedChange={(value) =>
              settings.update({ edit_tool_parts_expanded: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Chat Scrollbar"
          description="Show the main chat scrollbar"
        >
          <Switch
            checked={settings.showChatScrollbar}
            onCheckedChange={(value) =>
              settings.update({ show_chat_scrollbar: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Generic Tool Output"
          description="Allow generic provider tools to expose raw output previews"
        >
          <Switch
            checked={settings.showGenericToolOutput}
            onCheckedChange={(value) =>
              settings.update({ show_generic_tool_output: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Code Concealment"
          description="Hide code block previews in chat until opened"
        >
          <Switch
            checked={settings.concealCodeBlocks}
            onCheckedChange={(value) =>
              settings.update({ conceal_code_blocks: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Auto-save Conversations"
          description="Persist new messages, chat activities, and provider event logs locally. When off, new turns are not written to local history; existing history is not deleted."
        >
          <Switch
            checked={settings.autoSaveConversations}
            onCheckedChange={(value) =>
              settings.update({ auto_save_conversations: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Diff Word Wrap"
          description="Wrap long lines in the diff viewer"
        >
          <Switch
            checked={settings.diffWordWrap}
            onCheckedChange={(value) =>
              settings.update({ diff_word_wrap: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Diff Style"
          description="Use BetterC0de automatic split diffs or force stacked diffs"
        >
          <Select
            value={settings.diffStyle}
            onValueChange={(value) =>
              settings.update({
                diff_style: value === "stacked" ? "stacked" : "auto",
              })
            }
          >
            <SelectTrigger className="w-[150px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="stacked">Stacked</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Archive Confirmation"
          description="Ask before archiving a chat"
        >
          <Switch
            checked={settings.confirmArchive}
            onCheckedChange={(value) =>
              settings.update({ confirm_archive: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Delete Confirmation"
          description="Ask before deleting a chat"
        >
          <Switch
            checked={settings.confirmDelete}
            onCheckedChange={(value) =>
              settings.update({ confirm_delete: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Notifications"
        description="BetterC0de native notifications for background agent turns, approval requests, and provider errors."
      >
        <SettingsRow
          label="Agent Responses"
          description="Notify when a background or inactive-thread response is ready"
        >
          <Switch
            checked={settings.notificationAgent}
            onCheckedChange={(value) =>
              settings.update({ notification_agent: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Permissions"
          description="Notify when a provider waits for approval or user input"
        >
          <Switch
            checked={settings.notificationPermissions}
            onCheckedChange={(value) =>
              settings.update({ notification_permissions: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Errors"
          description="Notify when a provider turn or tool fails"
        >
          <Switch
            checked={settings.notificationErrors}
            onCheckedChange={(value) =>
              settings.update({ notification_errors: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Native Permission"
          description={`Current browser permission: ${notificationPermission}`}
        >
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={notificationPermission === "unsupported"}
            onClick={() => {
              requestNativeNotificationPermission()
                .then(setNotificationPermission)
                .catch(() =>
                  setNotificationPermission(nativeNotificationPermission())
                )
            }}
          >
            <BellIcon className="size-3.5" />
            Request Permission
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Backend Logs"
        description="Controls how much the local backend prints to the dev console. Changes apply immediately."
      >
        <SettingsRow
          label="Log Level"
          description="Minimum backend log level shown in the terminal"
        >
          <Select
            value={settings.backendLogLevel}
            onValueChange={(value) =>
              settings.update({
                backend_log_level:
                  value === "debug" || value === "warn" || value === "error"
                    ? value
                    : "info",
              })
            }
          >
            <SelectTrigger className="w-[150px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="error">Errors</SelectItem>
              <SelectItem value="warn">Warnings</SelectItem>
              <SelectItem value="info">Normal</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Log Format"
          description="Use compact lines for daily work or JSON when logs are collected by tooling"
        >
          <Select
            value={settings.backendLogFormat}
            onValueChange={(value) =>
              settings.update({
                backend_log_format: value === "json" ? "json" : "simple",
              })
            }
          >
            <SelectTrigger className="w-[150px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="simple">Simple</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="HTTP Trace"
          description="Log every backend API request instead of only slow or failed requests"
        >
          <Switch
            checked={settings.backendTraceHttp}
            onCheckedChange={(value) =>
              settings.update({ backend_trace_http: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Provider Event Trace"
          description="Log every provider websocket event, including token deltas"
        >
          <Switch
            checked={settings.backendTraceProviderEvents}
            onCheckedChange={(value) =>
              settings.update({ backend_trace_provider_events: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Reset">
        <SettingsRow
          label="Reset all preferences"
          description="Reset BetterC0de UI preferences and appearance to defaults. API keys, chat history, and external tools are not affected."
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
