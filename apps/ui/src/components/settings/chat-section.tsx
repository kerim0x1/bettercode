import {
  ALargeSmallIcon,
  AppWindowIcon,
  AtSignIcon,
  BracesIcon,
  BrainIcon,
  ClockIcon,
  CodeXmlIcon,
  Columns2Icon,
  FilePenLineIcon,
  FolderIcon,
  FoldVerticalIcon,
  ListChecksIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  ShipWheelIcon,
  SquareTerminalIcon,
  TextCursorIcon,
  TextQuoteIcon,
  TimerResetIcon,
  WrapTextIcon,
  WrenchIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SettingsRow,
  SettingsSection,
  SettingsStepper,
} from "@/components/settings/atoms"
import { useAppearanceStore } from "@/lib/appearance-store"
import { useSettingsStore } from "@/lib/settings-store"

/**
 * "Chat" settings: message text, how a conversation shows answers,
 * reasoning, tool output and diffs, plus what chats draw context from. Each
 * group names the chat commands that flip the same switches.
 */
export function SettingsChatSection() {
  const settings = useSettingsStore()
  const appearance = useAppearanceStore()

  return (
    <>
      <SettingsSection title="Text" description="Also from chat: /density">
        <SettingsRow
          icon={<ALargeSmallIcon />}
          label="Message Text Size"
          description="Text size of chat messages, in every mode. 13px is the default."
        >
          <SettingsStepper
            label="Message text size"
            value={appearance.messageTextSize}
            min={11}
            max={20}
            onChange={(value) => appearance.set("messageTextSize", value)}
          />
        </SettingsRow>
        <SettingsRow
          icon={<FoldVerticalIcon />}
          label="Compact Messages"
          description="Tighter lines and less space between messages."
        >
          <Switch
            aria-label="Compact Messages"
            checked={appearance.compactMode}
            onCheckedChange={(value) => appearance.set("compactMode", value)}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Sending"
        description="Ctrl+Enter (⌘Enter on a Mac) does the other one while the agent works. Alt+↑ in an empty composer edits the last queued message."
      >
        <SettingsRow
          icon={<ShipWheelIcon />}
          label="While the agent works, Enter…"
          description="Queue sends your message after the current turn. Steer sends it into the running turn now; agents that can't take a message mid-turn stop the current step and send it next."
        >
          <Select
            value={settings.whileWorkingEnter}
            onValueChange={(value) =>
              settings.update({
                while_working_enter: value === "steer" ? "steer" : "queue",
              })
            }
          >
            <SelectTrigger
              className="w-[150px]"
              size="sm"
              aria-label="While the agent works, Enter…"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="queue">Queue</SelectItem>
              <SelectItem value="steer">Steer</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Resuming"
        description="Chats a limit or a restart stopped pick up again with a short note in the chat. Sending a message or pressing Stop cancels it."
      >
        <SettingsRow
          icon={<TimerResetIcon />}
          label="Resume chats stopped by a usage limit"
          description={`Sends "Continue." (or your next queued message) shortly after the provider's limit resets. Without a reset time it tries after 30 minutes, 1 hour and 2 hours. The chat's card can still change this for one chat.`}
        >
          <Switch
            aria-label="Resume chats stopped by a usage limit"
            checked={settings.resumeAfterUsageLimit}
            onCheckedChange={(value) =>
              settings.update({ resume_after_usage_limit: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<RotateCcwIcon />}
          label="Continue running chats after a restart"
          description="When the app or its backend quit while a chat was working, it continues once at the next start, if its agent can resume the session. Chats waiting for your approval wait for you instead."
        >
          <Switch
            aria-label="Continue running chats after a restart"
            checked={settings.continueAfterRestart}
            onCheckedChange={(value) =>
              settings.update({ continue_after_restart: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Responses"
        description="Also from chat: /streaming, /timestamps, /progress, /scrollbar"
      >
        <SettingsRow
          icon={<TextCursorIcon />}
          label="Assistant Streaming"
          description="Show the answer as it is written. Off delivers each answer in one piece; reasoning and tool activity keep streaming either way."
        >
          <Switch
            aria-label="Assistant Streaming"
            checked={settings.enableAssistantStreaming}
            onCheckedChange={(value) =>
              settings.update({ enable_assistant_streaming: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<ClockIcon />}
          label="Message Timestamps"
          description="Show when each message was sent."
        >
          <Switch
            aria-label="Message Timestamps"
            checked={settings.showMessageTimestamps}
            onCheckedChange={(value) =>
              settings.update({ show_message_timestamps: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<ListChecksIcon />}
          label="Session Progress"
          description="Live progress of the running task in the chat."
        >
          <Switch
            aria-label="Session Progress"
            checked={settings.showSessionProgressBar}
            onCheckedChange={(value) =>
              settings.update({ show_session_progress_bar: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<ScrollTextIcon />}
          label="Chat Scrollbar"
          description="Show the transcript's scrollbar. Off still scrolls with the wheel."
        >
          <Switch
            aria-label="Chat Scrollbar"
            checked={settings.showChatScrollbar}
            onCheckedChange={(value) =>
              settings.update({ show_chat_scrollbar: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<AppWindowIcon />}
          label="Visual Replies"
          description="Agents can answer with a live page, such as a chart, table or mockup, shown in a sandbox in the chat. Off shows those pages as code and stops suggesting them to agents."
        >
          <Switch
            aria-label="Visual Replies"
            checked={settings.visualReplies}
            onCheckedChange={(value) =>
              settings.update({ visual_replies: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Reasoning"
        description="Also from chat: /thinking, /reasoning-summaries"
      >
        <SettingsRow
          icon={<BrainIcon />}
          label="Thinking Blocks"
          description="The model's reasoning as a collapsible row above each answer."
        >
          <Switch
            aria-label="Thinking Blocks"
            checked={settings.showThinkingBlocks}
            onCheckedChange={(value) =>
              settings.update({ show_thinking_blocks: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<TextQuoteIcon />}
          label="Reasoning Summaries"
          description={
            settings.showThinkingBlocks
              ? "Title thinking rows with a short summary instead of only the time."
              : "Needs Thinking Blocks."
          }
        >
          <Switch
            aria-label="Reasoning Summaries"
            disabled={!settings.showThinkingBlocks}
            checked={settings.showReasoningSummaries}
            onCheckedChange={(value) =>
              settings.update({ show_reasoning_summaries: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Tool output"
        description="Also from chat: /actions, /shell-expanded, /edit-expanded, /generic-tool-output, /conceal"
      >
        <SettingsRow
          icon={<WrenchIcon />}
          label="Tool Details"
          description="Open tool output previews by default."
        >
          <Switch
            aria-label="Tool Details"
            checked={settings.showToolDetails}
            onCheckedChange={(value) =>
              settings.update({ show_tool_details: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<SquareTerminalIcon />}
          label="Shell Commands Expanded"
          description="Show shell command output open instead of collapsed."
        >
          <Switch
            aria-label="Shell Commands Expanded"
            checked={settings.shellToolPartsExpanded}
            onCheckedChange={(value) =>
              settings.update({ shell_tool_parts_expanded: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<FilePenLineIcon />}
          label="File Edits Expanded"
          description="Show file edits and their diffs open instead of collapsed."
        >
          <Switch
            aria-label="File Edits Expanded"
            checked={settings.editToolPartsExpanded}
            onCheckedChange={(value) =>
              settings.update({ edit_tool_parts_expanded: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<BracesIcon />}
          label="Generic Tool Output"
          description="Raw output for tools without their own view, such as MCP tools."
        >
          <Switch
            aria-label="Generic Tool Output"
            checked={settings.showGenericToolOutput}
            onCheckedChange={(value) =>
              settings.update({ show_generic_tool_output: value })
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<CodeXmlIcon />}
          label="Hide Code Blocks"
          description="Collapse code blocks in answers until you open them."
        >
          <Switch
            aria-label="Hide Code Blocks"
            checked={settings.concealCodeBlocks}
            onCheckedChange={(value) =>
              settings.update({ conceal_code_blocks: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Diffs" description="Also from chat: /diffwrap">
        <SettingsRow
          icon={<Columns2Icon />}
          label="Diff Style"
          description="Side by side when there is room, or always stacked."
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
          icon={<WrapTextIcon />}
          label="Word Wrap"
          description="Wrap long lines in diffs instead of scrolling sideways."
        >
          <Switch
            aria-label="Diff Word Wrap"
            checked={settings.diffWordWrap}
            onCheckedChange={(value) =>
              settings.update({ diff_word_wrap: value })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Context">
        <SettingsRow
          icon={<AtSignIcon />}
          label="File Context"
          description="Mention project files with @ to add them to a message."
        >
          <Switch
            aria-label="File Context"
            checked={appearance.fileContextEnabled}
            onCheckedChange={(value) =>
              appearance.set("fileContextEnabled", value)
            }
          />
        </SettingsRow>
        <SettingsRow
          icon={<FolderIcon />}
          label="Current Workspace Only"
          description="Alt+↑/↓, /sessions and /resume only go through chats of the open project. The sidebar always lists every chat."
        >
          <Switch
            aria-label="Current Workspace Only"
            checked={appearance.sessionDirectoryFilterEnabled}
            onCheckedChange={(value) =>
              appearance.set("sessionDirectoryFilterEnabled", value)
            }
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
