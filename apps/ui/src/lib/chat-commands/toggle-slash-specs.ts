import { useAppearanceStore } from "@/lib/appearance-store"
import { useChatStore } from "@/lib/chat-store"
import { applyPermissionModeLive } from "@/lib/permission-mode-live"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useSettingsStore } from "@/lib/settings-store"
import { buildThreadCompactionOutput } from "@/lib/thread-compaction"
import {
  handleDiffStyleCommand,
  handleNotificationsCommand,
  resolveToggleArg,
} from "./settings-actions"
import { buildToggleOutput } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

/** Chat display, behaviour and permission toggles, compaction and UI density. */
export const TOGGLE_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["streaming"],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(
          args[0],
          settings.enableAssistantStreaming
        )
        await settings.update({ enable_assistant_streaming: next })
        run.output = buildToggleOutput("Assistant Streaming", next)
      },
    },
    {
      names: [
        "timestamps",
        "toggle-timestamps",
        "toggle.timestamps",
        "session.toggle.timestamps",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showMessageTimestamps)
        await settings.update({ show_message_timestamps: next })
        run.output = buildToggleOutput("Message Timestamps", next)
      },
    },
    {
      names: [
        "thinking",
        "toggle-thinking",
        "toggle.thinking",
        "session.toggle.thinking",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showThinkingBlocks)
        await settings.update({ show_thinking_blocks: next })
        run.output = buildToggleOutput("Thinking Blocks", next)
      },
    },
    {
      names: [
        "reasoning-summaries",
        "reasoning-summary",
        "session.toggle.reasoning_summaries",
        "session-toggle-reasoning-summaries",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showReasoningSummaries)
        await settings.update({ show_reasoning_summaries: next })
        run.output = buildToggleOutput("Reasoning Summaries", next)
      },
    },
    {
      names: [
        "tool-details",
        "actions",
        "toggle-actions",
        "toggle.actions",
        "session.toggle.actions",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showToolDetails)
        await settings.update({ show_tool_details: next })
        run.output = buildToggleOutput("Tool Details", next)
      },
    },
    {
      names: [
        "progress",
        "session-progress",
        "session.toggle.progress_bar",
        "session-toggle-progress-bar",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showSessionProgressBar)
        await settings.update({ show_session_progress_bar: next })
        run.output = buildToggleOutput("Session Progress", next)
      },
    },
    {
      names: [
        "shell-expanded",
        "shell-tool-parts",
        "shell-tool-parts-expanded",
        "session.toggle.shell_tool_parts_expanded",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.shellToolPartsExpanded)
        await settings.update({ shell_tool_parts_expanded: next })
        run.output = buildToggleOutput("Shell Tool Parts Expanded", next)
      },
    },
    {
      names: [
        "edit-expanded",
        "edit-tool-parts",
        "edit-tool-parts-expanded",
        "session.toggle.edit_tool_parts_expanded",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.editToolPartsExpanded)
        await settings.update({ edit_tool_parts_expanded: next })
        run.output = buildToggleOutput("Edit Tool Parts Expanded", next)
      },
    },
    {
      names: [
        "scrollbar",
        "toggle-scrollbar",
        "toggle.scrollbar",
        "session.toggle.scrollbar",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showChatScrollbar)
        await settings.update({ show_chat_scrollbar: next })
        run.output = buildToggleOutput("Chat Scrollbar", next)
      },
    },
    {
      names: [
        "generic-tool-output",
        "generic-output",
        "toggle-generic-tool-output",
        "toggle.generic_tool_output",
        "session.toggle.generic_tool_output",
      ],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.showGenericToolOutput)
        await settings.update({ show_generic_tool_output: next })
        run.output = buildToggleOutput("Generic Tool Output", next)
      },
    },
    {
      names: ["conceal", "toggle-conceal", "session.toggle.conceal"],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.concealCodeBlocks)
        await settings.update({ conceal_code_blocks: next })
        run.output = buildToggleOutput("Code Concealment", next)
      },
    },
    {
      names: ["autosave", "auto-save"],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.autoSaveConversations)
        await settings.update({ auto_save_conversations: next })
        run.output = buildToggleOutput("Auto-save Conversations", next)
      },
    },
    {
      names: ["diffwrap", "wrap", "app.toggle.diffwrap", "app-toggle-diffwrap"],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(args[0], settings.diffWordWrap)
        await settings.update({ diff_word_wrap: next })
        run.output = buildToggleOutput("Diff Word Wrap", next)
      },
    },
    {
      names: ["diff-style", "diff_style", "diff.style", "app.diff_style"],
      run: async (run) => {
        const { args } = run
        run.output = await handleDiffStyleCommand(args)
      },
    },
    {
      names: ["notifications", "notify", "notification"],
      run: async (run) => {
        const { args } = run
        run.output = await handleNotificationsCommand(args)
      },
    },
    {
      names: ["confirmations", "confirm"],
      run: async (run) => {
        const { args } = run
        const settings = useSettingsStore.getState()
        const next = resolveToggleArg(
          args[0],
          settings.confirmArchive && settings.confirmDelete
        )
        await settings.update({
          confirm_archive: next,
          confirm_delete: next,
        })
        run.output = buildToggleOutput("Archive/Delete Confirmations", next)
      },
    },
    {
      names: ["autoaccept", "auto-accept", "permissions.autoaccept"],
      run: async (run) => {
        const { args, selectedProvider, permissionLevel, threadId } = run
        const current = permissionLevel === "bypass"
        const next = resolveToggleArg(args[0], current)
        const nextPermission = next ? "bypass" : "ask-on-edit"
        if (threadId) {
          useChatStore
            .getState()
            .setThreadSetting(threadId, "permissionLevel", nextPermission)
        } else {
          usePreferencesStore.getState().set("permissionLevel", nextPermission)
        }
        await applyPermissionModeLive(
          nextPermission,
          selectedProvider,
          threadId
        )
        run.output = buildToggleOutput("Auto Accept", next)
      },
    },
    {
      names: [
        "compact",
        "summarize",
        "session.compact",
        "v2.session.compact",
        "v2-session-compact",
      ],
      run: async (run) => {
        const {
          rawText,
          selectedProvider,
          selectedModel,
          thinkingMode,
          threadId,
        } = run
        const commandMessage = {
          messageId: crypto.randomUUID(),
          content: rawText,
          createdAt: new Date().toISOString(),
        }
        const compaction = await buildThreadCompactionOutput({
          threadId,
          selectedProvider,
          selectedModel,
          thinkingMode,
          command: commandMessage,
        })
        run.output = compaction.content
        run.outputMessageId = compaction.messageId
        run.outputMessageCreatedAt = compaction.createdAt
        run.outputMessageCompactionGeneration = compaction.generation
        run.outputUserMessageId = commandMessage.messageId
        run.outputUserMessageCreatedAt = commandMessage.createdAt
      },
    },
    {
      names: ["density", "compact-ui"],
      run: (run) => {
        const { trimmedText } = run
        const appearance = useAppearanceStore.getState()
        const arg = trimmedText.split(/\s+/)[1]?.toLowerCase()
        const next =
          arg === "on" || arg === "1" || arg === "true"
            ? true
            : arg === "off" || arg === "0" || arg === "false"
              ? false
              : !appearance.compactMode
        appearance.set("compactMode", next)
        run.output = `# Compact UI\n\n${next ? "Enabled" : "Disabled"}`
      },
    },
  ]
