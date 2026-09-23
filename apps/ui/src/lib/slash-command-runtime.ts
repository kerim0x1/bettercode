import { findComposerTextarea } from "@/lib/composer-input"
import { applyPermissionModeLive } from "@/lib/permission-mode-live"
import {
  buildAgentCreateOutput,
  buildBetterC0deAgentTerminalCommand,
  buildRuntimeSubagentDebugOutput,
  buildRuntimeSubagentDetailOutput,
  formatSubagentStatus,
} from "../hooks/chat-submit/agent-commands"
import {
  buildProjectFormatPreviewOutput,
  buildProjectFormatTerminalCommand,
  buildProjectFormatterConfigOutput,
  formatCommand,
  parseProjectFormatArgs,
  parseProjectFormatFlags,
} from "../hooks/chat-submit/formatter-commands"
import {
  buildBetterC0deGithubTerminalCommand,
  buildGithubAgentOutput,
} from "../hooks/chat-submit/github-commands"
import {
  listProjectRuntimeSkills,
  listProjectRuntimeSubagents,
  mergeRuntimeSkills,
  mergeRuntimeSubagents,
} from "../hooks/chat-submit/input-context"
import {
  buildProjectLspConfigOutput,
  buildProjectLspDebugOutput,
  formatDebugPathCell,
  formatList,
  type ProjectLspDebugIntent,
  type ProjectLspDebugKind,
} from "../hooks/chat-submit/lsp-commands"
import {
  buildMcpAddOutput,
  buildMcpAuthOutput,
  buildMcpDebugOutput,
  buildMcpServersOutput,
  buildRuntimeMcpDetailOutput,
  buildRuntimeMcpToggleOutput,
  listProjectRuntimeMcps,
  stripBetterC0deMcpSlashSubcommand,
} from "../hooks/chat-submit/mcp-actions"
import {
  buildBetterC0deMcpTerminalCommand,
  buildMcpLogoutOutput,
  buildMcpNotFoundOutput,
  buildMcpResourcesOutput,
  buildMcpTerminalSection,
  buildProjectMcpConfigOutput,
  isBetterC0deRuntimeTerminalFlag,
  resolveRuntimeMcpServer,
  stripBetterC0deRuntimeUiFlags,
} from "../hooks/chat-submit/mcp-commands"
import {
  applyModelAgentCycleCommand,
  applyModelCycleCommand,
  applyModelVariantCycleCommand,
  buildFavoriteToggleOutput,
  readActiveProviderComposerSelection,
} from "../hooks/chat-submit/model-actions"
import {
  buildApprovalDecisionOutput,
  buildProjectPermissionsConfigOutput,
  buildProjectPermissionsOutput,
} from "../hooks/chat-submit/permission-commands"
import {
  buildBetterC0dePluginTerminalCommand,
  buildPluginInstallOutput,
  buildPluginToggleOutput,
} from "../hooks/chat-submit/plugin-commands"
import {
  buildProjectCommandConfigOutput,
  buildProjectCommandsOutput,
  buildProjectReferenceConfigOutput,
  buildProjectReferencesOutput,
  buildRuntimeSkillsOutput,
} from "../hooks/chat-submit/project-commands"
import {
  buildBetterC0deDebugConfigOutput,
  buildProjectConfigOutput,
  buildProjectInstructionsConfigOutput,
  buildProjectInstructionsOutput,
  buildProjectKeybindsOutput,
  buildProjectPluginsOutput,
  buildProjectSkillsConfigOutput,
  buildProjectToolsConfigOutput,
  buildProjectToolsOutput,
  buildProjectTuiConfigOutput,
  formatProjectToolState,
} from "../hooks/chat-submit/project-config-commands"
import { isSlashCommand } from "../hooks/chat-submit/prompt-commands"
import {
  buildBetterC0deModelsTerminalCommand,
  buildBetterC0deProviderAuthTerminalCommand,
  buildBetterC0deProviderConnectTerminalCommand,
  buildProviderAuthOutput,
  buildProviderCatalogOutput,
  buildProviderConnectionOutput,
  maintenanceMissingValueMessages,
  selectedOptionValue,
} from "../hooks/chat-submit/provider-commands"
import {
  buildProjectProviderConfigOutput,
  buildProjectProvidersOutput,
  escapeInlineCode,
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "../hooks/chat-submit/provider-config"
import {
  buildPendingApprovalsThreadOutput,
  buildPendingUserInputsThreadOutput,
  buildSessionStatusOutput,
  buildThreadTodosOutput,
  buildUserInputAnswerOutput,
  buildUserInputRejectOutput,
} from "../hooks/chat-submit/request-actions"
import {
  betterC0deDbMode,
  betterC0deInternalRouteGuidance,
  betterC0deTuiCommandEquivalent,
  buildBetterC0deMaintenanceCliArgs,
  buildBetterC0deMaintenanceOutput,
  buildBetterC0deMaintenanceValidationMessages,
  buildBetterC0deRuntimeEntrypointOutput,
  buildDebugRgOutput,
  buildWorkspaceRemoveOutput,
  formatBytes,
  parseAppLogCommandArgs,
  type AppLogPayload,
  type ParsedAppLogCommand,
} from "../hooks/chat-submit/runtime-commands"
import {
  buildBetterC0deRuntimeConfigOutput,
  isBetterC0deAttachmentConfigKey,
  isBetterC0deCompactionConfigKey,
  isBetterC0deRuntimeConfigKey,
  isBetterC0deToolOutputConfigKey,
} from "../hooks/chat-submit/runtime-config"
import {
  buildSessionsOutput,
  buildThreadStatsOutput,
  compareThreadActivities,
  type SessionListOptions,
  type StatsCommandOptions,
} from "../hooks/chat-submit/session-commands"
import {
  executeRemoteAccessCommand,
  handleDiffStyleCommand,
  handleNotificationsCommand,
  openSettingsTab,
  resolveToggleArg,
  type SettingsTabId,
} from "../hooks/chat-submit/settings-actions"
import {
  buildArchiveThreadOutput,
  buildArchivedThreadsOutput,
  buildCopyLastAssistantMessageOutput,
  buildCopyThreadOutput,
  buildDeleteThreadOutput,
  buildInterruptThreadOutput,
  buildPinThreadOutput,
  buildPinnedThreadsOutput,
  buildPromptStashDeleteOutput,
  buildPromptStashPopOutput,
  buildQuickSwitchThreadOutput,
  buildRenameThreadOutput,
  buildSessionUpdateThreadOutput,
  buildUnarchiveThreadOutput,
} from "../hooks/chat-submit/thread-actions"
import {
  buildBetterC0deSessionIoTerminalCommand,
  buildExportThreadOutput,
  buildImportThreadOutput,
  buildShareThreadOutput,
} from "../hooks/chat-submit/thread-export"
import {
  buildContextThreadOutput,
  buildDebugSnapshotOutput,
  buildEventsThreadOutput,
  buildMessagesThreadOutput,
  buildTimelineThreadOutput,
} from "../hooks/chat-submit/thread-inspection"
import { buildProjectTuiConfigWriteOutput } from "../hooks/chat-submit/tui-commands"
import {
  buildDiffThreadOutput,
  buildFindOutput,
  buildVcsApplyTerminalCommand,
  buildVcsOutput,
  isVcsApplyCommand,
} from "../hooks/chat-submit/vcs-commands"
import {
  buildAddSelectionContextOutput,
  buildClearEditorContextOutput,
  buildCloseEditorTabOutput,
  buildOpenFileOutput,
  buildRedoCheckpointOutput,
  buildUndoCheckpointOutput,
  buildWarpWorkspaceOutput,
  buildWorkspaceListOutput,
  buildWorkspaceNewOutput,
  buildWorkspaceResetOutput,
  buildWorkspaceToggleOutput,
} from "../hooks/chat-submit/workspace-actions"
export {
  buildAgentCreateOutput,
  buildRuntimeSubagentDebugOutput,
  buildRuntimeSubagentDetailOutput,
} from "../hooks/chat-submit/agent-commands"
export { buildProjectFormatterConfigOutput } from "../hooks/chat-submit/formatter-commands"
export { buildGithubAgentOutput } from "../hooks/chat-submit/github-commands"
export {
  buildEditorSelectionContextDraft,
  buildProjectCommandAgentInstructions,
  buildProjectCommandPrompt,
  buildProjectReferenceMentionContext,
  buildProjectSkillCommandPrompt,
  extractBetterC0deMentions,
  hydrateProjectCommandShellBlocks,
  hydrateProjectCommandTemplate,
  isProviderNativeSlashCommand,
  listProjectRuntimeSkills,
  listProjectRuntimeSubagents,
  mergeRuntimeSkills,
  mergeRuntimeSubagents,
  normalizeChatAttachments,
  projectCommandChatModeOverride,
  providerSkillSlashPrompt,
  resolveProjectCommandModelOverride,
  type EditorSelectionContextDraftInput,
} from "../hooks/chat-submit/input-context"
export { buildProjectLspConfigOutput } from "../hooks/chat-submit/lsp-commands"
export {
  buildMcpAddOutput,
  buildMcpAuthOutput,
  buildMcpDebugOutput,
  buildMcpServersOutput,
  buildRuntimeMcpDetailOutput,
  stripBetterC0deMcpSlashSubcommand,
} from "../hooks/chat-submit/mcp-actions"
export {
  buildMcpLogoutOutput,
  buildMcpResourcesOutput,
  buildProjectMcpConfigOutput,
  resolveRuntimeMcpServer,
} from "../hooks/chat-submit/mcp-commands"
export {
  cycleProviderModelAgentSelection,
  cycleProviderModelVariantSelection,
  readActiveProviderComposerSelection,
} from "../hooks/chat-submit/model-actions"
export {
  buildPendingApprovalsOutput,
  buildProjectPermissionsConfigOutput,
  buildProjectPermissionsOutput,
  buildUserInputAnswerPayload,
  resolvePendingApprovalReference,
} from "../hooks/chat-submit/permission-commands"
export {
  buildPluginInstallOutput,
  buildPluginToggleOutput,
} from "../hooks/chat-submit/plugin-commands"
export {
  buildProjectCommandConfigOutput,
  buildProjectReferenceConfigOutput,
  buildRuntimeSkillsOutput,
  projectCommandSubtaskLabel,
} from "../hooks/chat-submit/project-commands"
export {
  buildBetterC0deDebugConfigOutput,
  buildProjectInstructionsConfigOutput,
  buildProjectKeybindsOutput,
  buildProjectPluginsOutput,
  buildProjectSkillsConfigOutput,
  buildProjectToolsConfigOutput,
} from "../hooks/chat-submit/project-config-commands"
export {
  buildBetterC0deDefaultAgentContext,
  buildBetterC0deDefaultCommandPrompt,
  buildBetterC0dePrTerminalOutput,
} from "../hooks/chat-submit/prompt-commands"
export {
  buildProviderAuthOutput,
  buildProviderCatalogOutput,
  buildProviderConnectionOutput,
  cycleModelVariantValue,
  resolveModelVariantValue,
  type ModelVariantCycleResult,
} from "../hooks/chat-submit/provider-commands"
export {
  buildProjectProviderConfigOutput,
  buildProjectProvidersOutput,
  type ActiveThreadRef,
} from "../hooks/chat-submit/provider-config"
export {
  buildPendingUserInputsOutput,
  buildThreadTodosOutputFromItems,
  resolvePendingUserInputReference,
} from "../hooks/chat-submit/request-actions"
export {
  buildBetterC0deMaintenanceOutput,
  buildBetterC0deRuntimeEntrypointOutput,
  buildDebugFileListOutput,
  buildDebugFileReadOutput,
  buildDebugFileStatusOutput,
  buildDebugRgFilesOutput,
  buildDebugRgSearchOutput,
  buildDebugRgTreeOutput,
  parseAppLogCommandArgs,
  resolveDebugRgRequest,
} from "../hooks/chat-submit/runtime-commands"
export { buildBetterC0deRuntimeConfigOutput } from "../hooks/chat-submit/runtime-config"
export {
  buildSessionStatusOutputFromSnapshot,
  buildSessionsOutput,
  buildThreadStatsOutput,
  deriveChatPendingApprovals,
  deriveChatPendingUserInputs,
  deriveChatTodosFromActivities,
  parseSessionUpdateArgs,
  type ChatPendingApproval,
  type ChatPendingUserInput,
  type ChatPendingUserInputQuestion,
  type ChatSessionStatusSnapshot,
  type ChatTodoItem,
} from "../hooks/chat-submit/session-commands"
export {
  buildDiffStyleOutput,
  buildNativeNotificationsOutput,
  executeRemoteAccessCommand,
  resolveDiffStyleArg,
} from "../hooks/chat-submit/settings-actions"
export {
  lastAssistantMessageText,
  resolveInterruptProviderKind,
  sanitizeThreadRenameTitle,
} from "../hooks/chat-submit/thread-actions"
export {
  betterC0deImportUrlCandidates,
  buildDebugSnapshotMarkdown,
  buildExportThreadOutput,
  buildImportThreadOutput,
  buildThreadDiffMarkdown,
  buildThreadImportDraftFromJsonPayload,
  buildThreadJsonExportPayload,
  type ThreadImportDraft,
} from "../hooks/chat-submit/thread-export"
export {
  activeContextMessagesFromThread,
  buildThreadContextMarkdown,
  buildThreadEventsOutputFromSnapshot,
  buildThreadMessagesMarkdown,
  buildThreadTimelineMarkdown,
  parseMessageListArgs,
  type ChatThreadEventsSnapshot,
  type MessageListOptions,
  type MessageListOrder,
  type ThreadContextMarkdownOptions,
  type ThreadContextSlice,
} from "../hooks/chat-submit/thread-inspection"
export { buildProjectTuiConfigWriteOutput } from "../hooks/chat-submit/tui-commands"
export {
  buildFindFilesOutput,
  buildFindTextOutput,
  buildVcsApplyOutput,
  buildVcsDiffOutput,
  buildVcsOutput,
  buildVcsStatusOutput,
} from "../hooks/chat-submit/vcs-commands"
// The command ladder and compatibility exports stay here; dependency-based
// parsing, output and action modules live in hooks/chat-submit. The submit hook
// imports this runtime on demand so command implementation is not startup work.
import {
  dispatchSlashCommand,
  indexSlashCommands,
} from "@/hooks/chat-submit/slash-registry"
import {
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSiblingChildThread,
} from "@/hooks/chat-submit/thread-navigation"
import {
  SELECTABLE_THEME_TEMPLATES,
  templateMode,
  useAppearanceStore,
} from "@/lib/appearance-store"
import { readCustomThemes } from "@/lib/custom-theme-cache"
import { customTemplateId, customThemeIdOf } from "@/lib/vscode-theme"
import {
  BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  BETTERC0DE_INPUT_ACTION_COMMANDS,
  findBetterC0deKeybindDefault,
} from "@/lib/betterc0de-keybinds"
import {
  buildBetterC0deCliParityMarkdown,
  buildBetterC0deGapMarkdown,
  buildBetterC0deHttpParityMarkdown,
  buildBetterC0deParityMarkdown,
} from "@/lib/betterc0de-parity"
import { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
import { buildBetterC0deTipsMarkdown } from "@/lib/betterc0de-tips"
import {
  useChatStore,
  type ChatThread,
  type ThreadActivity,
  type ThreadStreamState,
} from "@/lib/chat-store"
import { stringifyCliArgs } from "@/lib/cli-parse"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import {
  buildFavoriteModelCycleItems,
  buildModelCycleItems,
  type ModelCycleFavoriteEntry,
} from "@/lib/model-cycle"
import type { SourceProposedPlanReference } from "@/lib/plan-modal"
import { usePreferencesStore } from "@/lib/preferences-store"
import { toggleDiffView } from "@/lib/diff-view"
import {
  buildPromptHistoryListOutput,
  createPromptHistoryEntry,
  pushPromptHistoryEntry,
  resolvePromptHistoryEntry,
} from "@/lib/prompt-history"
import {
  buildPromptStashListOutput,
  createPromptStashEntry,
  pushPromptStashEntry,
} from "@/lib/prompt-stash"
import type { UiProvider } from "@/lib/provider-types"
import {
  listRuntimeMcps,
  listRuntimeSkills,
  listRuntimeSubagents,
  type RuntimeMcpServer,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import { filterThreadsForSessionDirectory } from "@/lib/session-directory-filter"
import { useSettingsStore } from "@/lib/settings-store"
import { dispatchTerminalNewSession } from "@/lib/terminal-events"
import { buildThreadCompactionOutput } from "@/lib/thread-compaction"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { clearThreadShare, getThreadShare } from "@/lib/thread-share"
import {
  formatProjectFile,
  getRuntimeDebugInfo,
  listProjectCommands,
  listProjectConfigSettings,
  listProjectFormatters,
  listProjectLspServers,
  listProjectPermissions,
  listProjectPlugins,
  listProjectProviders,
  listProjectReferences,
  listProjectTools,
  loadThreadStats,
  writeRuntimeHeapSnapshot,
  type RuntimeDebugInfo,
  type ThreadUsageStats,
  type WorkspaceProjectCommand,
  type WorkspaceProjectConfigSetting,
  type WorkspaceProjectFormatResult,
  type WorkspaceProjectFormatter,
  type WorkspaceProjectLspServer,
  type WorkspaceProjectPermissionRule,
  type WorkspaceProjectPlugin,
  type WorkspaceProjectProvidersSummary,
  type WorkspaceProjectReference,
  type WorkspaceProjectToolFlag,
} from "@/services/backend"
import {
  getProviderOptionCurrentValue,
  type ProviderOptionSelection,
} from "@betterc0de/schema"

export interface ChatSubmitPayload {
  /** Explicit pane ownership; omitted for commands in the active chat. */
  threadId?: string | null
  text: string
  files: unknown[]
  visibleText?: string
  chatModeOverride?: string | null
  sourceProposedPlan?: SourceProposedPlanReference | null
  /** Stable identity and captured element tags for a queued draft's delivery. */
  queuedSubmission?: {
    id: string
    createdAt: string
    browserElements: import("@betterc0de/schema").BrowserElementReference[]
  }
}
const CHAT_MODE_CYCLE = ["agent", "plan", "ask"] as const

const BETTERC0DE_INTERNAL_ROUTE_COMMANDS = new Set([
  "auth.set",
  "auth.remove",
  "provider.oauth.authorize",
  "provider.oauth.callback",
  "experimental.console.get",
  "experimental.console.listOrgs",
  "experimental.console.switchOrg",
  "experimental.session.list",
  "experimental.workspace.adapter.list",
  "experimental.workspace.create",
  "experimental.workspace.list",
  "experimental.workspace.remove",
  "experimental.workspace.status",
  "global.event",
  "global.upgrade",
  "part.delete",
  "part.update",
  "project.initGit",
  "session.command",
  "session.deleteMessage",
  "session.prompt",
  "session.prompt_async",
  "session.shell",
  "session.summarize",
  "tui.appendPrompt",
  "tui.clearPrompt",
  "tui.command.execute",
  "tui.executeCommand",
  "tui.openHelp",
  "tui.openModels",
  "tui.openSessions",
  "tui.openThemes",
  "tui.prompt.append",
  "tui.publish",
  "tui.selectSession",
  "tui.session.select",
  "tui.showToast",
  "tui.toast.show",
  "tui.submitPrompt",
  "v2.session.prompt",
  "v2.session.wait",
])

export interface SlashRuntimeContext {
  cmd: string
  args: string[]
  trimmedText: string
  rawText: string
  threadId: string | null
  selectedProvider: UiProvider | undefined
  selectedProviderId?: string
  selectedModel: string
  providers?: UiProvider[]
  favoriteEntries?: ModelCycleFavoriteEntry[]
  toggleFavorite?: (providerId: string, modelId: string) => void
  isFavorite?: (providerId: string, modelId: string) => boolean
  setSelectedProviderId?: (id: string) => void
  setSelectedModel?: (id: string, providerId?: string) => void
  thinkingMode: string | null
  chatMode: string
  setChatMode: (mode: string) => void
  specialMode: string | null
  permissionLevel: string
  contextWindow: string
  fastMode: boolean
  appMode: "agent" | "editor" | "design"
  openModelPicker?: () => void
  openCommandPalette?: () => void
  closeSlash: () => void
  activeThread: ActiveThreadRef
  effectiveChatMode: string
}

export interface SlashRuntimeResult {
  handled: boolean
  output: string
  threadId?: string | null
  outputMessageId?: string
  outputMessageCreatedAt?: string
  outputMessageCompactionGeneration?: number
  outputUserMessageId?: string
  outputUserMessageCreatedAt?: string
}

function slashAbort(
  result: Omit<SlashRuntimeResult, "handled">
): SlashRuntimeResult {
  return { handled: true, ...result }
}

const SLASH_COMMAND_INDEX = indexSlashCommands([
  {
    names: [
      "model",
      "models",
      "model.choose",
      "model.list",
      "model-list",
      "model.dialog.provider",
      "model-dialog-provider",
      "command-palette",
      "command.palette.show",
      "command-palette-show",
      "mode-next",
      "chat-mode-next",
      "mode-previous",
      "chat-mode-previous",
      "agent",
      "agent-next",
      "agent.cycle",
      "agent-previous",
      "previous-agent",
      "agent.cycle.reverse",
      "model-next",
      "next-model",
      "model-cycle",
      "model.cycle_recent",
      "model-previous",
      "previous-model",
      "prev-model",
      "model.cycle_recent_reverse",
      "favorite-next",
      "next-favorite",
      "favorite-model-next",
      "model.cycle_favorite",
      "favorite-toggle",
      "model.dialog.favorite",
      "model-dialog-favorite",
      "favorite-previous",
      "previous-favorite",
      "prev-favorite",
      "favorite-model-previous",
      "model.cycle_favorite_reverse",
      "new",
      "clear",
      "session.new",
      "session.create",
      "session-new",
      "resume",
      "continue",
      "session.next",
      "session-next",
      "session.next.unseen",
      "session-next-unseen",
      "session.previous",
      "session-previous",
      "session.prev",
      "session-prev",
      "session.previous.unseen",
      "session-previous-unseen",
      "fork",
      "session.fork",
      "parent",
      "session-parent",
      "session.parent",
      "child",
      "children",
      "session-child",
      "session.child",
      "session.children",
      "session.child.first",
      "child-next",
      "next-child",
      "session.child.next",
      "child-previous",
      "prev-child",
      "previous-child",
      "session.child.previous",
      "pin",
      "pin-session",
      "session.pin",
      "session.pin.toggle",
      "pins",
      "pinned",
      "pinned-sessions",
      "archive",
      "archive-session",
      "session.archive",
      "unarchive",
      "unarchive-session",
      "session.unarchive",
      "archives",
      "archived",
      "archived-sessions",
      "delete-session",
      "delete",
      "session.delete",
      "share",
      "session.share",
      "unshare",
      "session.unshare",
      "copy",
      "session.copy",
      "copy-last",
      "copy-assistant",
      "copy-message",
      "messages.copy",
      "export",
      "session.export",
      "betterc0de-export",
      "betterc0de.export",
      "import",
      "session.import",
      "betterc0de-import",
      "betterc0de.import",
      "diff",
      "diffs",
      "session.diff",
      "session.update",
      "rename",
      "title",
      "session.rename",
      "timeline",
      "session.timeline",
      "events",
      "event.subscribe",
      "event-subscribe",
      "session.events",
      "messages",
      "message-list",
      "message",
      "session.messages",
      "session.message",
      "session.message.list",
      "v2.session.messages",
      "v2-session-messages",
      "context",
      "session.context",
      "context-list",
      "v2.session.context",
      "v2-session-context",
      "first",
      "first-message",
      "messages.first",
      "session.first",
      "last",
      "last-message",
      "messages.last",
      "session.last",
      "last-user",
      "last-user-message",
      "messages-last-user",
      "messages.last_user",
      "session.messages_last_user",
      "next-message",
      "message-next",
      "message.next",
      "messages.next",
      "session.message.next",
      "previous-message",
      "prev-message",
      "message-previous",
      "message.previous",
      "messages.previous",
      "session.message.previous",
      "page-up",
      "pageup",
      "messages-page-up",
      "message.page_up",
      "messages.page_up",
      "session.page.up",
      "page-down",
      "pagedown",
      "messages-page-down",
      "message.page_down",
      "messages.page_down",
      "session.page.down",
      "line-up",
      "lineup",
      "messages-line-up",
      "message.line_up",
      "messages.line_up",
      "session.line.up",
      "line-down",
      "linedown",
      "messages-line-down",
      "message.line_down",
      "messages.line_down",
      "session.line.down",
      "half-page-up",
      "halfpage-up",
      "session.half.page.up",
      "half-page-down",
      "halfpage-down",
      "session.half.page.down",
      "open",
      "editor",
      "file.open",
      "prompt.editor",
      "prompt-editor",
      "add-selection",
      "context.addselection",
      "context-add-selection",
      "selection-context",
      "editor-context-clear",
      "prompt.editor_context.clear",
      "prompt-editor-context-clear",
      "close",
      "close-tab",
      "tab.close",
      "warp",
      "workspace",
      "workspace.set",
      "workspace-set",
      "project.open",
      "project-open",
      "project.update",
      "project-update",
      "project-next",
      "project.next",
      "project-previous",
      "project.previous",
      "project-prev",
      "workspace-new",
      "workspace.new",
      "worktree.create",
      "worktree-create",
      "workspace-toggle",
      "workspace.toggle",
      "project.list",
      "project-list",
      "project.current",
      "project-current",
      "workspace-list",
      "workspace.list",
      "worktree-list",
      "worktree.list",
      "workspace-remove",
      "workspace.remove",
      "worktree-remove",
      "worktree.remove",
      "workspace-reset",
      "workspace.reset",
      "worktree-reset",
      "worktree.reset",
      "undo",
      "session.undo",
      "session.revert",
      "redo",
      "session.redo",
      "session.unrevert",
      "interrupt",
      "stop",
      "cancel",
      "session.interrupt",
      "session.abort",
      "exit",
      "quit",
      "q",
      "app.exit",
      "app-exit",
      "help",
      "help.show",
      "help-show",
      "sessions",
      "session",
      "session.list",
      "session.get",
      "session-list",
      "v2.session.list",
      "v2-session-list",
      "history",
      "prompt-history",
      "histories",
      "history-use",
      "history-pop",
      "prompt-history-use",
      "prompt.history.previous",
      "prompt-history-previous",
      "prompt.history.next",
      "prompt-history-next",
      "prompt-clear",
      "prompt.clear",
      "clear-prompt",
      "prompt-paste",
      "prompt.paste",
      "prompt-submit",
      "prompt.submit",
      "input-actions",
      "stash",
      "prompt-stash",
      "prompt.stash",
      "stashes",
      "stash-list",
      "prompt-stash-list",
      "prompt.stash.list",
      "stash-pop",
      "prompt-stash-pop",
      "prompt.stash.pop",
      "stash-delete",
      "stash-remove",
      "prompt-stash-delete",
      "stash.delete",
      "commands",
      "project-commands",
      "command.list",
      "command-list",
      "references",
      "refs",
      "project-references",
      "format",
      "project-format",
      "formatter.run",
      "formatters",
      "project-formatters",
      "formatter.status",
      "formatter-status",
      "lsp",
      "lsps",
      "language-servers",
      "debug.lsp",
      "debug-lsp",
      "lsp.status",
      "lsp-status",
      "debug.lsp.diagnostics",
      "debug-lsp-diagnostics",
      "debug.lsp.symbols",
      "debug-lsp-symbols",
      "debug.lsp.document-symbols",
      "debug-lsp-document-symbols",
      "permissions",
      "project-permissions",
      "approvals",
      "approval-list",
      "permission-list",
      "permission.list",
      "permissions-pending",
      "permission.prompt.fullscreen",
      "permission-fullscreen",
      "approve",
      "approval-approve",
      "permission-approve",
      "permission.reply",
      "permission.respond",
      "deny",
      "reject",
      "approval-deny",
      "permission-deny",
      "questions",
      "question-list",
      "question.list",
      "user-inputs",
      "user-input-list",
      "answer",
      "question-reply",
      "question.reply",
      "user-input-answer",
      "reject-question",
      "question-reject",
      "question.reject",
      "user-input-reject",
      "todos",
      "todo",
      "tasks",
      "session.todo",
      "session-status",
      "session.status",
      "status.session",
      "thread-status",
      "vcs",
      "vcs.status",
      "vcs-status",
      "vcs.get",
      "vcs.diff",
      "vcs-diff",
      "vcs.diff.raw",
      "vcs-diff-raw",
      "vcs-apply",
      "vcs.apply",
      "find",
      "find.text",
      "find-text",
      "find.file",
      "find-file",
      "find.files",
      "find-files",
      "find.symbol",
      "find-symbol",
      "find.symbols",
      "find-symbols",
      "betterc0de",
      "betterc0de-config",
      "project-config",
      "debug.config",
      "debug-config",
      "config.get",
      "config-get",
      "config.update",
      "config-update",
      "global.config.get",
      "global-config-get",
      "global.config.update",
      "global-config-update",
      "compat-config",
      "betterc0de-audit",
      "betterc0de.parity",
      "betterc0de-parity",
      "compat",
      "compat-audit",
      "parity",
      "betterc0de-cli",
      "betterc0de.commands",
      "betterc0de-commands",
      "betterc0de.entrypoints",
      "betterc0de-entrypoints",
      "betterc0de-api",
      "betterc0de.api",
      "betterc0de-http",
      "betterc0de.http",
      "openapi",
      "openapi.operations",
      "betterc0de-gaps",
      "betterc0de.missing",
      "betterc0de-missing",
      "betterc0de.todo",
      "betterc0de-todo",
      "betterc0de-sync",
      "betterc0de.sync",
      "sync",
      "sync.history.list",
      "sync-history",
      "sync.replay",
      "sync-replay",
      "sync.start",
      "sync-start",
      "sync.steal",
      "sync-steal",
      "betterc0de-workspace",
      "betterc0de.workspace",
      "experimental.workspace.syncList",
      "experimental-workspace-sync-list",
      "experimental.workspace.warp",
      "experimental-workspace-warp",
      "betterc0de-lifecycle",
      "betterc0de.lifecycle",
      "global.dispose",
      "global-dispose",
      "instance.dispose",
      "instance-dispose",
      "tui-control",
      "tui.control.next",
      "tui-control-next",
      "tui.control.response",
      "tui-control-response",
      "auth.set",
      "auth-set",
      "auth.remove",
      "auth-remove",
      "betterc0de-internal",
      "betterc0de.internal",
      "tui",
      "tui-config",
      "keybinds",
      "keybindings",
      "which-key",
      "which-key.toggle",
      "which-key.layout.toggle",
      "which-key.pending.toggle",
      "which-key.group.previous",
      "which-key.group.next",
      "which-key.scroll.up",
      "which-key.scroll.down",
      "which-key.page.up",
      "which-key.page.down",
      "which-key.home",
      "which-key.end",
      "tips",
      "tips.toggle",
      "betterc0de-tips",
      "tips-toggle",
      "attachments",
      "attachment",
      "image-attachments",
      "betterc0de-attachments",
      "tool-output",
      "tool-output-limits",
      "betterc0de-tool-output",
      "compaction",
      "context-compaction",
      "betterc0de-compaction",
      "betterc0de-runtime",
      "betterc0de.server",
      "betterc0de-app",
      "runtime-config",
      "betterc0de-server",
      "betterc0de-tui",
      "betterc0de.thread",
      "betterc0de-thread",
      "betterc0de.ui",
      "betterc0de-ui",
      "betterc0de-run",
      "betterc0de.run",
      "betterc0de-cli-run",
      "betterc0de-serve",
      "betterc0de.serve",
      "betterc0de-server-start",
      "betterc0de-attach",
      "betterc0de.attach",
      "betterc0de-server-switch",
      "attach",
      "attach-server",
      "server.switch",
      "server-switch",
      "betterc0de-web",
      "betterc0de.web",
      "betterc0de-web-ui",
      "betterc0de-acp",
      "betterc0de.acp",
      "acp",
      "betterc0de-upgrade",
      "betterc0de.upgrade",
      "betterc0de-update",
      "betterc0de-uninstall",
      "betterc0de.uninstall",
      "betterc0de-generate",
      "betterc0de.generate",
      "betterc0de-openapi",
      "betterc0de-completion",
      "betterc0de.completion",
      "completion",
      "betterc0de-db",
      "betterc0de.db",
      "betterc0de-db-path",
      "betterc0de-db-migrate",
      "betterc0de-db-query",
      "betterc0de.db.query",
      "db",
      "db.migrate",
      "db.query",
      "db-query",
      "betterc0de-session",
      "betterc0de.session",
      "betterc0de-session-list",
      "betterc0de.session.list",
      "betterc0de-session-delete",
      "betterc0de.session.delete",
      "session-cli",
      "session.cli",
      "project-providers",
      "provider-config",
      "betterc0de-providers",
      "config.providers",
      "config-providers",
      "v2.provider.list",
      "v2-provider-list",
      "v2.provider.get",
      "v2-provider-get",
      "project-plugins",
      "betterc0de-plugins",
      "project-tools",
      "betterc0de-tools",
      "tool.list",
      "tool-list",
      "tool.ids",
      "tool-ids",
      "mcp-resources",
      "mcp.resources",
      "mcp-resource-list",
      "resources",
      "experimental.resource.list",
      "experimental-resource-list",
      "mcp-auth",
      "mcp.auth",
      "mcp.auth.list",
      "mcp.auth.ls",
      "mcp.auth.start",
      "mcp.auth.callback",
      "mcp.auth.authenticate",
      "mcp-auth-list",
      "mcp-auth-ls",
      "mcp-add",
      "mcp.add",
      "mcp-install",
      "mcp.install",
      "mcp-logout",
      "mcp.logout",
      "mcp.auth.remove",
      "mcp-auth-logout",
      "mcp-debug",
      "mcp.debug",
      "mcp-inspect",
      "mcps",
      "mcp",
      "mcp.list",
      "mcp.ls",
      "mcp.status",
      "mcp-ls",
      "mcp-toggle",
      "toggle-mcp",
      "mcp.toggle",
      "mcp.connect",
      "mcp.disconnect",
      "dialog.mcp.toggle",
      "dialog-mcp-toggle",
      "mcp-enable",
      "mcp-disable",
      "skills",
      "prompt.skills",
      "prompt-skills",
      "debug.skill",
      "debug-skill",
      "app.skills",
      "agents",
      "agent.list",
      "agent-list",
      "debug.agent",
      "debug-agent",
      "app.agents",
      "agent-create",
      "agent.create",
      "agents.create",
      "create-agent",
      "instructions",
      "project-rules",
      "status",
      "betterc0de.status",
      "betterc0de-status",
      "global.health",
      "debug-info",
      "debug.info",
      "betterc0de.debug.info",
      "betterc0de-debug-info",
      "debug-paths",
      "debug.paths",
      "betterc0de.debug.paths",
      "betterc0de-debug-paths",
      "db.path",
      "db-path",
      "paths",
      "path.get",
      "path-get",
      "debug-rg",
      "debug.rg",
      "debug.rg.files",
      "debug.rg.search",
      "debug.file",
      "debug.file.read",
      "debug-file-read",
      "debug.file.list",
      "debug-file-list",
      "debug.file.status",
      "debug-file-status",
      "debug.file.search",
      "debug.file.tree",
      "file",
      "file.read",
      "file-read",
      "file.list",
      "file-list",
      "file.status",
      "file-status",
      "debug-snapshot",
      "debug.snapshot",
      "debug.snapshot.track",
      "debug.snapshot.patch",
      "debug.snapshot.diff",
      "debug-snapshot-track",
      "debug-snapshot-patch",
      "debug-snapshot-diff",
      "debug-utility",
      "debug.startup",
      "debug-startup",
      "debug.scrap",
      "debug-scrap",
      "debug.v2",
      "debug-v2",
      "debug.wait",
      "debug-wait",
      "stats",
      "usage",
      "token-usage",
      "session.stats",
      "session-stats",
      "github",
      "github-agent",
      "github.install",
      "github-install",
      "github.run",
      "github-run",
      "docs",
      "documentation",
      "docs.open",
      "docs-open",
      "org",
      "organization",
      "orgs",
      "switch-org",
      "console.orgs",
      "console-orgs",
      "console.switch",
      "console-switch",
      "console.org.switch",
      "console-org-switch",
      "account.orgs",
      "account.switch",
      "plugin-install",
      "plugin",
      "plug",
      "plugin.install",
      "plugins.install",
      "plugins-install",
      "dialog.plugins.install",
      "dialog-plugins-install",
      "plugin-toggle",
      "plugins.toggle",
      "plugins-toggle",
      "auth",
      "remote",
      "remote-access",
      "console",
      "app.console",
      "app-console",
      "app.debug",
      "app-debug",
      "app.log",
      "app-log",
      "heap-snapshot",
      "app.heap_snapshot",
      "app-heap-snapshot",
      "review-toggle",
      "review.toggle",
      "review-panel-toggle",
      "terminal-title",
      "terminal.title.toggle",
      "terminal-title-toggle",
      "pty.update",
      "terminal",
      "terminal.toggle",
      "terminal.suspend",
      "pty",
      "pty.list",
      "pty-list",
      "pty.shells",
      "pty-shells",
      "pty.get",
      "pty-get",
      "pty.connect",
      "pty-connect",
      "pty.connectToken",
      "pty.connect-token",
      "pty.remove",
      "pty-remove",
      "terminal-new",
      "terminal.new",
      "new-terminal",
      "pty.create",
      "pty-create",
      "file-tree-toggle",
      "filetree.toggle",
      "filetree-toggle",
      "file-tree.toggle",
      "file-tree",
      "files",
      "files.toggle",
      "sidebar",
      "toggle-sidebar",
      "sidebar.toggle",
      "session.sidebar.toggle",
      "input-focus",
      "input.focus",
      "focus-input",
      "composer-focus",
      "animations",
      "app.toggle.animations",
      "app-toggle-animations",
      "file-context",
      "app.toggle.file_context",
      "app-toggle-file-context",
      "paste-summary",
      "app.toggle.paste_summary",
      "app-toggle-paste-summary",
      "session-directory-filter",
      "app.toggle.session_directory_filter",
      "app-toggle-session-directory-filter",
      "connect",
      "provider.connect",
      "provider-connect",
      "providers.login",
      "provider.login",
      "auth.login",
      "auth.connect",
      "console.login",
      "console.open",
      "account.login",
      "account.open",
      "auth.list",
      "auth.ls",
      "auth.get",
      "provider-auth",
      "provider.auth",
      "providers.list",
      "providers.ls",
      "provider.list",
      "provider.ls",
      "providers.logout",
      "provider.logout",
      "auth.logout",
      "console.logout",
      "account",
      "account.list",
      "account.logout",
      "theme-mode",
      "theme.switch_mode",
      "theme-switch-mode",
      "theme-mode-lock",
      "theme.mode.lock",
      "theme-lock",
      "themes",
      "theme",
      "theme.switch",
      "theme-switch",
      "theme.cycle",
      "theme-cycle",
      "theme.scheme.cycle",
      "theme-scheme-cycle",
      "language",
      "language.cycle",
      "language-cycle",
      "terminal-font",
      "font.terminal",
      "terminal.font",
      "appearance.terminal_font",
      "variants",
      "variant.list",
      "variant-list",
      "variant.cycle",
      "variant-cycle",
      "model.variant.cycle",
      "model-variant-cycle",
      "catalog",
      "model-catalog",
      "model-info",
      "models.list",
      "models-list",
      "catalog.model.list",
      "catalog.model.get",
      "v2.model.list",
      "v2-model-list",
      "timestamps",
      "toggle-timestamps",
      "toggle.timestamps",
      "session.toggle.timestamps",
      "thinking",
      "toggle-thinking",
      "toggle.thinking",
      "session.toggle.thinking",
      "reasoning-summaries",
      "reasoning-summary",
      "session.toggle.reasoning_summaries",
      "session-toggle-reasoning-summaries",
      "tool-details",
      "actions",
      "toggle-actions",
      "toggle.actions",
      "session.toggle.actions",
      "progress",
      "session-progress",
      "session.toggle.progress_bar",
      "session-toggle-progress-bar",
      "shell-expanded",
      "shell-tool-parts",
      "shell-tool-parts-expanded",
      "session.toggle.shell_tool_parts_expanded",
      "edit-expanded",
      "edit-tool-parts",
      "edit-tool-parts-expanded",
      "session.toggle.edit_tool_parts_expanded",
      "scrollbar",
      "toggle-scrollbar",
      "toggle.scrollbar",
      "session.toggle.scrollbar",
      "generic-tool-output",
      "generic-output",
      "toggle-generic-tool-output",
      "toggle.generic_tool_output",
      "session.toggle.generic_tool_output",
      "conceal",
      "toggle-conceal",
      "session.toggle.conceal",
      "autosave",
      "auto-save",
      "diffwrap",
      "wrap",
      "app.toggle.diffwrap",
      "app-toggle-diffwrap",
      "diff-style",
      "diff_style",
      "diff.style",
      "app.diff_style",
      "notifications",
      "notify",
      "notification",
      "confirmations",
      "confirm",
      "autoaccept",
      "auto-accept",
      "permissions.autoaccept",
      "compact",
      "summarize",
      "session.compact",
      "v2.session.compact",
      "v2-session-compact",
      "density",
      "compact-ui",
    ],
    run: (context: SlashRuntimeContext) => runSlashLadder(context),
  },
])

export async function runRegisteredSlashCommand(
  context: SlashRuntimeContext
): Promise<SlashRuntimeResult | null> {
  const dispatched = dispatchSlashCommand(
    context.cmd,
    context,
    SLASH_COMMAND_INDEX
  )
  if (dispatched) return await dispatched
  return runSlashLadder(context)
}

async function runSlashLadder(
  context: SlashRuntimeContext
): Promise<SlashRuntimeResult | null> {
  const {
    cmd,
    args,
    trimmedText,
    rawText,
    selectedProvider,
    selectedProviderId,
    selectedModel,
    providers = [],
    favoriteEntries = [],
    toggleFavorite,
    isFavorite,
    setSelectedProviderId,
    setSelectedModel,
    thinkingMode,
    chatMode,
    setChatMode,
    permissionLevel,
    contextWindow,
    openModelPicker,
    openCommandPalette,
    closeSlash,
    activeThread,
    effectiveChatMode,
  } = context
  const store = useChatStore.getState()
  let threadId = context.threadId
  let output = ""
  let outputMessageId: string | undefined
  let outputMessageCreatedAt: string | undefined
  let outputMessageCompactionGeneration: number | undefined
  let outputUserMessageId: string | undefined
  let outputUserMessageCreatedAt: string | undefined
  if (
    isSlashCommand(
      cmd,
      "model",
      "models",
      "model.choose",
      "model.list",
      "model-list",
      "model.dialog.provider",
      "model-dialog-provider"
    ) &&
    shouldOpenModelPickerForSlashCommand(cmd, args)
  ) {
    closeSlash()
    openModelPicker?.()
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "command-palette",
      "command.palette.show",
      "command-palette-show"
    )
  ) {
    closeSlash()
    openCommandPalette?.()
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (isSlashCommand(cmd, "mode-next", "chat-mode-next")) {
    const next = cycleChatMode(chatMode, 1)
    setChatMode(next)
    output = buildChatModeCycleOutput(next)
  }

  if (isSlashCommand(cmd, "mode-previous", "chat-mode-previous")) {
    const next = cycleChatMode(chatMode, -1)
    setChatMode(next)
    output = buildChatModeCycleOutput(next)
  }

  if (
    isSlashCommand(cmd, "agent", "agent-next", "agent.cycle") &&
    !betterC0deAgentSlashSubcommand(cmd, args)
  ) {
    output = applyModelAgentCycleCommand({
      threadId,
      provider: selectedProvider,
      selectedModel,
      direction: 1,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "agent-previous",
      "previous-agent",
      "agent.cycle.reverse"
    )
  ) {
    output = applyModelAgentCycleCommand({
      threadId,
      provider: selectedProvider,
      selectedModel,
      direction: -1,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "model-next",
      "next-model",
      "model-cycle",
      "model.cycle_recent"
    )
  ) {
    output = applyModelCycleCommand({
      items: buildModelCycleItems(providers),
      direction: 1,
      selectedProviderId: selectedProvider?.id ?? selectedProviderId,
      selectedModel,
      setSelectedProviderId,
      setSelectedModel,
      source: "model",
    })
  }

  if (
    isSlashCommand(
      cmd,
      "model-previous",
      "previous-model",
      "prev-model",
      "model.cycle_recent_reverse"
    )
  ) {
    output = applyModelCycleCommand({
      items: buildModelCycleItems(providers),
      direction: -1,
      selectedProviderId: selectedProvider?.id ?? selectedProviderId,
      selectedModel,
      setSelectedProviderId,
      setSelectedModel,
      source: "model",
    })
  }

  if (
    isSlashCommand(
      cmd,
      "favorite-next",
      "next-favorite",
      "favorite-model-next",
      "model.cycle_favorite"
    )
  ) {
    output = applyModelCycleCommand({
      items: buildFavoriteModelCycleItems(favoriteEntries),
      direction: 1,
      selectedProviderId: selectedProvider?.id ?? selectedProviderId,
      selectedModel,
      setSelectedProviderId,
      setSelectedModel,
      source: "favorite",
    })
  }

  if (
    isSlashCommand(
      cmd,
      "favorite-toggle",
      "model.dialog.favorite",
      "model-dialog-favorite"
    )
  ) {
    output = buildFavoriteToggleOutput({
      providerId: selectedProvider?.id ?? selectedProviderId ?? null,
      modelId: selectedModel,
      toggleFavorite,
      isFavorite,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "favorite-previous",
      "previous-favorite",
      "prev-favorite",
      "favorite-model-previous",
      "model.cycle_favorite_reverse"
    )
  ) {
    output = applyModelCycleCommand({
      items: buildFavoriteModelCycleItems(favoriteEntries),
      direction: -1,
      selectedProviderId: selectedProvider?.id ?? selectedProviderId,
      selectedModel,
      setSelectedProviderId,
      setSelectedModel,
      source: "favorite",
    })
  }

  if (
    isSlashCommand(
      cmd,
      "new",
      "clear",
      "session.new",
      "session.create",
      "session-new"
    )
  ) {
    store.createThread("New Chat", "BetterC0de")
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (isSlashCommand(cmd, "resume", "continue")) {
    const sessionThreads = filterThreadsForSessionDirectory(
      store.threads,
      threadId,
      useAppearanceStore.getState().sessionDirectoryFilterEnabled
    )
    const target = args.join(" ").trim().toLowerCase()
    if (target) {
      const match = sessionThreads.find((thread) => {
        const title = thread.title.toLowerCase()
        return (
          thread.id.toLowerCase().startsWith(target) || title.includes(target)
        )
      })
      if (match) {
        store.setActiveThread(match.id)
        return slashAbort({
          threadId,
          output,
          outputMessageId,
          outputMessageCreatedAt,
          outputMessageCompactionGeneration,
          outputUserMessageId,
          outputUserMessageCreatedAt,
        })
      }
    }
  }

  if (
    isSlashCommand(
      cmd,
      "session.next",
      "session-next",
      "session.next.unseen",
      "session-next-unseen"
    )
  ) {
    const target = resolveAdjacentSessionThread(
      filterThreadsForSessionDirectory(
        store.threads,
        threadId,
        useAppearanceStore.getState().sessionDirectoryFilterEnabled
      ),
      threadId,
      1
    )
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = "# Next Session\n\n> No other session is available."
  }

  if (
    isSlashCommand(
      cmd,
      "session.previous",
      "session-previous",
      "session.prev",
      "session-prev",
      "session.previous.unseen",
      "session-previous-unseen"
    )
  ) {
    const target = resolveAdjacentSessionThread(
      filterThreadsForSessionDirectory(
        store.threads,
        threadId,
        useAppearanceStore.getState().sessionDirectoryFilterEnabled
      ),
      threadId,
      -1
    )
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = "# Previous Session\n\n> No other session is available."
  }

  if (isSlashCommand(cmd, "fork", "session.fork")) {
    if (!threadId) {
      threadId = store.createThread("New Chat", "BetterC0de")
      store.addMessage(threadId, {
        id: crypto.randomUUID(),
        role: "user",
        content: rawText,
        createdAt: new Date().toISOString(),
      })
      store.addMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "# Fork Session\n\n> No existing chat history to fork yet.",
        createdAt: new Date().toISOString(),
      })
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    const forkedThreadId = await store.forkThread(threadId)
    if (forkedThreadId) {
      return slashAbort({
        threadId: forkedThreadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = "# Fork Session\n\n> The active chat could not be found."
  }

  if (isSlashCommand(cmd, "parent", "session-parent", "session.parent")) {
    const target = resolveParentThread(store.threads, threadId)
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = "# Parent Session\n\n> This chat has no linked parent session."
  }

  if (
    isSlashCommand(
      cmd,
      "child",
      "children",
      "session-child",
      "session.child",
      "session.children",
      "session.child.first"
    )
  ) {
    const target = resolveChildThread(store.threads, threadId, args.join(" "))
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = "# Child Session\n\n> This chat has no linked child fork yet."
  }

  if (isSlashCommand(cmd, "child-next", "next-child", "session.child.next")) {
    const target = resolveSiblingChildThread(store.threads, threadId, 1)
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output =
      "# Next Child Session\n\n> This chat is not inside a child-session branch with siblings."
  }

  if (
    isSlashCommand(
      cmd,
      "child-previous",
      "prev-child",
      "previous-child",
      "session.child.previous"
    )
  ) {
    const target = resolveSiblingChildThread(store.threads, threadId, -1)
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output =
      "# Previous Child Session\n\n> This chat is not inside a child-session branch with siblings."
  }

  const quickSwitchSlot = resolveQuickSwitchSlot(cmd, args[0])
  if (
    isSlashCommand(
      cmd,
      "pin",
      "pin-session",
      "session.pin",
      "session.pin.toggle"
    )
  ) {
    output = buildPinThreadOutput(store, threadId)
  }

  if (isSlashCommand(cmd, "pins", "pinned", "pinned-sessions")) {
    output = buildPinnedThreadsOutput(store.threads, store.pinnedThreadIds)
  }

  if (quickSwitchSlot !== null) {
    const target = resolvePinnedThreadSlot(
      store.threads,
      store.pinnedThreadIds,
      quickSwitchSlot
    )
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output = buildQuickSwitchThreadOutput(quickSwitchSlot)
  }

  if (isSlashCommand(cmd, "archive", "archive-session", "session.archive")) {
    output = await buildArchiveThreadOutput(
      store.threads,
      threadId,
      args.join(" ")
    )
  }

  if (
    isSlashCommand(cmd, "unarchive", "unarchive-session", "session.unarchive")
  ) {
    output = await buildUnarchiveThreadOutput(
      store.threads,
      threadId,
      args.join(" ")
    )
  }

  if (isSlashCommand(cmd, "archives", "archived", "archived-sessions")) {
    output = buildArchivedThreadsOutput(
      store.threads,
      useSettingsStore.getState().archivedThreadIds
    )
  }

  if (isSlashCommand(cmd, "delete-session", "delete", "session.delete")) {
    const deleteResult = buildDeleteThreadOutput(store.threads, threadId, args)
    if (deleteResult.threadId && deleteResult.confirmed) {
      const deletedActiveThread = deleteResult.threadId === threadId
      store.deleteThread(deleteResult.threadId)
      if (deletedActiveThread) {
        const replacementThreadId = store.createThread("New Chat", "BetterC0de")
        store.addMessage(replacementThreadId, {
          id: crypto.randomUUID(),
          role: "user",
          content: rawText,
          createdAt: new Date().toISOString(),
        })
        store.addMessage(replacementThreadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: deleteResult.output,
          createdAt: new Date().toISOString(),
        })
        return slashAbort({
          threadId,
          output,
          outputMessageId,
          outputMessageCreatedAt,
          outputMessageCompactionGeneration,
          outputUserMessageId,
          outputUserMessageCreatedAt,
        })
      }
    }
    output = deleteResult.output
  }

  if (isSlashCommand(cmd, "share", "session.share")) {
    output = await buildShareThreadOutput(threadId)
  }

  if (isSlashCommand(cmd, "unshare", "session.unshare")) {
    output = buildUnshareThreadOutput(threadId)
  }

  if (isSlashCommand(cmd, "copy", "session.copy")) {
    output = await buildCopyThreadOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "copy-last",
      "copy-assistant",
      "copy-message",
      "messages.copy"
    )
  ) {
    output = await buildCopyLastAssistantMessageOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "export",
      "session.export",
      "betterc0de-export",
      "betterc0de.export",
      "betterc0de-export",
      "betterc0de.export"
    )
  ) {
    const betterC0deExportMode = isSlashCommand(
      cmd,
      "session.export",
      "betterc0de-export",
      "betterc0de.export",
      "betterc0de-export",
      "betterc0de.export"
    )
    const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
      "export",
      args
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = await buildExportThreadOutput(threadId, args, {
      betterC0deMode: betterC0deExportMode,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "import",
      "session.import",
      "betterc0de-import",
      "betterc0de.import",
      "betterc0de-import",
      "betterc0de.import"
    )
  ) {
    const terminalCommand = buildBetterC0deSessionIoTerminalCommand(
      "import",
      args
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = await buildImportThreadOutput(args, activeThread)
  }

  if (isSlashCommand(cmd, "diff", "diffs", "session.diff")) {
    output = await buildDiffThreadOutput(threadId, args)
  }

  if (isSlashCommand(cmd, "session.update")) {
    output = await buildSessionUpdateThreadOutput(store.threads, threadId, args)
  }

  if (isSlashCommand(cmd, "rename", "title", "session.rename")) {
    output = buildRenameThreadOutput(threadId, args)
  }

  if (isSlashCommand(cmd, "timeline", "session.timeline")) {
    output = await buildTimelineThreadOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "events",
      "event.subscribe",
      "event-subscribe",
      "session.events"
    )
  ) {
    output = await buildEventsThreadOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "messages",
      "message-list",
      "message",
      "session.messages",
      "session.message",
      "session.message.list",
      "v2.session.messages",
      "v2-session-messages"
    )
  ) {
    output = await buildMessagesThreadOutput(threadId, args)
  }

  if (
    isSlashCommand(
      cmd,
      "context",
      "session.context",
      "context-list",
      "v2.session.context",
      "v2-session-context"
    )
  ) {
    output = await buildContextThreadOutput(threadId, {
      selectedProvider,
      selectedModel,
      chatMode: effectiveChatMode,
      permissionLevel,
      contextWindow,
      full: args.includes("--full"),
    })
  }

  if (
    isSlashCommand(
      cmd,
      "first",
      "first-message",
      "messages.first",
      "session.first"
    )
  ) {
    dispatchChatMessageScroll("first", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(cmd, "last", "last-message", "messages.last", "session.last")
  ) {
    dispatchChatMessageScroll("last", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "last-user",
      "last-user-message",
      "messages-last-user",
      "messages.last_user",
      "session.messages_last_user"
    )
  ) {
    dispatchChatMessageScroll("last-user", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "next-message",
      "message-next",
      "message.next",
      "messages.next",
      "session.message.next"
    )
  ) {
    dispatchChatMessageScroll("next", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "previous-message",
      "prev-message",
      "message-previous",
      "message.previous",
      "messages.previous",
      "session.message.previous"
    )
  ) {
    dispatchChatMessageScroll("previous", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "page-up",
      "pageup",
      "messages-page-up",
      "message.page_up",
      "messages.page_up",
      "session.page.up"
    )
  ) {
    dispatchChatMessageScroll("page-up", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "page-down",
      "pagedown",
      "messages-page-down",
      "message.page_down",
      "messages.page_down",
      "session.page.down"
    )
  ) {
    dispatchChatMessageScroll("page-down", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "line-up",
      "lineup",
      "messages-line-up",
      "message.line_up",
      "messages.line_up",
      "session.line.up"
    )
  ) {
    dispatchChatMessageScroll("line-up", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "line-down",
      "linedown",
      "messages-line-down",
      "message.line_down",
      "messages.line_down",
      "session.line.down"
    )
  ) {
    dispatchChatMessageScroll("line-down", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(cmd, "half-page-up", "halfpage-up", "session.half.page.up")
  ) {
    dispatchChatMessageScroll("half-page-up", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "half-page-down",
      "halfpage-down",
      "session.half.page.down"
    )
  ) {
    dispatchChatMessageScroll("half-page-down", threadId)
    return slashAbort({
      threadId,
      output,
      outputMessageId,
      outputMessageCreatedAt,
      outputMessageCompactionGeneration,
      outputUserMessageId,
      outputUserMessageCreatedAt,
    })
  }

  if (
    isSlashCommand(
      cmd,
      "open",
      "editor",
      "file.open",
      "prompt.editor",
      "prompt-editor"
    )
  ) {
    output = await buildOpenFileOutput(threadId, args)
  }

  if (
    isSlashCommand(
      cmd,
      "add-selection",
      "context.addselection",
      "context-add-selection",
      "selection-context"
    )
  ) {
    output = buildAddSelectionContextOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "editor-context-clear",
      "prompt.editor_context.clear",
      "prompt-editor-context-clear"
    )
  ) {
    output = buildClearEditorContextOutput()
  }

  if (isSlashCommand(cmd, "close", "close-tab", "tab.close")) {
    output = buildCloseEditorTabOutput()
  }

  if (
    isSlashCommand(
      cmd,
      "warp",
      "workspace",
      "workspace.set",
      "workspace-set",
      "project.open",
      "project-open",
      "project.update",
      "project-update"
    )
  ) {
    output = await buildWarpWorkspaceOutput(threadId, args)
  }

  if (isSlashCommand(cmd, "project-next", "project.next")) {
    const target = resolveAdjacentProjectThread(store.threads, threadId, 1)
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output =
      "# Next Project\n\n> No other project is represented by recent chats."
  }

  if (
    isSlashCommand(cmd, "project-previous", "project.previous", "project-prev")
  ) {
    const target = resolveAdjacentProjectThread(store.threads, threadId, -1)
    if (target) {
      store.setActiveThread(target.id)
      return slashAbort({
        threadId,
        output,
        outputMessageId,
        outputMessageCreatedAt,
        outputMessageCompactionGeneration,
        outputUserMessageId,
        outputUserMessageCreatedAt,
      })
    }
    output =
      "# Previous Project\n\n> No other project is represented by recent chats."
  }

  if (
    isSlashCommand(
      cmd,
      "workspace-new",
      "workspace.new",
      "worktree.create",
      "worktree-create"
    )
  ) {
    output = await buildWorkspaceNewOutput(threadId)
  }

  if (
    isSlashCommand(
      cmd,
      "workspace-toggle",
      "workspace.toggle",
      "project.list",
      "project-list",
      "project.current",
      "project-current"
    )
  ) {
    output = buildWorkspaceToggleOutput(activeThread)
  }

  if (
    isSlashCommand(
      cmd,
      "workspace-list",
      "workspace.list",
      "worktree-list",
      "worktree.list"
    )
  ) {
    output = await buildWorkspaceListOutput(activeThread)
  }

  if (
    isSlashCommand(
      cmd,
      "workspace-remove",
      "workspace.remove",
      "worktree-remove",
      "worktree.remove"
    )
  ) {
    output = await buildWorkspaceRemoveOutput(threadId, args)
  }

  if (
    isSlashCommand(
      cmd,
      "workspace-reset",
      "workspace.reset",
      "worktree-reset",
      "worktree.reset"
    )
  ) {
    output = await buildWorkspaceResetOutput(threadId, args)
  }

  let mcpList: RuntimeMcpServer[] = []
  let skillList: RuntimeSkill[] = []
  let subagentList: RuntimeSubagent[] = []
  let projectSubagentList: RuntimeSubagent[] = []
  let projectCommandList: WorkspaceProjectCommand[] = []
  let projectReferenceList: WorkspaceProjectReference[] = []
  let projectFormatterList: WorkspaceProjectFormatter[] = []
  let projectLspServerList: WorkspaceProjectLspServer[] = []
  let projectPermissionList: WorkspaceProjectPermissionRule[] = []
  let projectConfigList: WorkspaceProjectConfigSetting[] = []
  let projectProvidersSummary: WorkspaceProjectProvidersSummary | null = null
  let projectPluginList: WorkspaceProjectPlugin[] = []
  let projectToolList: WorkspaceProjectToolFlag[] = []
  try {
    const [mcps, skills, subagents] = await Promise.all([
      listRuntimeMcps(),
      listRuntimeSkills(),
      listRuntimeSubagents(),
    ])
    mcpList = mcps
    skillList = skills
    subagentList = subagents
  } catch {
    console.warn(
      "Failed to load runtime MCPs/skills/subagents for slash commands"
    )
  }
  const slashRuntimePath = resolveThreadRuntimePath(activeThread)
  if (slashRuntimePath) {
    try {
      const [
        commands,
        projectMcps,
        projectSkills,
        projectSubagents,
        projectReferences,
        projectFormatters,
        projectLspServers,
        projectPermissions,
        projectConfig,
        projectProviders,
        projectPlugins,
        projectTools,
      ] = await Promise.all([
        listProjectCommands(slashRuntimePath),
        listProjectRuntimeMcps(slashRuntimePath),
        listProjectRuntimeSkills(slashRuntimePath),
        listProjectRuntimeSubagents(slashRuntimePath),
        listProjectReferences(slashRuntimePath),
        listProjectFormatters(slashRuntimePath),
        listProjectLspServers(slashRuntimePath),
        listProjectPermissions(slashRuntimePath),
        listProjectConfigSettings(slashRuntimePath),
        listProjectProviders(slashRuntimePath),
        listProjectPlugins(slashRuntimePath),
        listProjectTools(slashRuntimePath),
      ])
      projectCommandList = commands
      projectSubagentList = projectSubagents
      projectReferenceList = projectReferences
      projectFormatterList = projectFormatters
      projectLspServerList = projectLspServers
      projectPermissionList = projectPermissions
      projectConfigList = projectConfig
      projectProvidersSummary = projectProviders
      projectPluginList = projectPlugins
      projectToolList = projectTools
      mcpList = mergeRuntimeMcps(mcpList, projectMcps)
      skillList = mergeRuntimeSkills(skillList, projectSkills)
      subagentList = mergeRuntimeSubagents(subagentList, projectSubagents)
    } catch {
      projectCommandList = []
      projectSubagentList = []
      projectReferenceList = []
      projectFormatterList = []
      projectLspServerList = []
      projectPermissionList = []
      projectConfigList = []
      projectProvidersSummary = null
      projectPluginList = []
      projectToolList = []
    }
  }

  if (isSlashCommand(cmd, "undo", "session.undo", "session.revert")) {
    output = await buildUndoCheckpointOutput(threadId, args[0])
  } else if (isSlashCommand(cmd, "redo", "session.redo", "session.unrevert")) {
    output = await buildRedoCheckpointOutput(threadId)
  } else if (
    isSlashCommand(
      cmd,
      "interrupt",
      "stop",
      "cancel",
      "session.interrupt",
      "session.abort"
    )
  ) {
    output = await buildInterruptThreadOutput(
      threadId,
      selectedProvider,
      selectedProviderId
    )
  } else if (isSlashCommand(cmd, "exit", "quit", "q", "app.exit", "app-exit")) {
    scheduleWindowCloseFromChat()
    output = "# Exit\n\nClosing BetterC0de window."
  } else if (isSlashCommand(cmd, "help", "help.show", "help-show")) {
    const sections: string[] = [
      "# BetterC0de Commands\n",
      "**Built-in**\n",
      "| Command | What it does |",
      "|:--------|:-------------|",
      "| `/plan [prompt]` | Switch this thread into plan mode |",
      "| `/ask [prompt]` | Switch this thread into read-only ask mode |",
      "| `/security [prompt]` | Switch this thread into security review mode |",
      "| `/debug [prompt]` | Switch this thread into debug mode |",
      "| `/default`, `/build`, `/agent-mode` | Return this thread to normal build mode |",
      "| `/agent`, `/agent.cycle` | Cycle the selected BetterC0de compatibility provider agent |",
      "| `/model`, `/models` | Open the model picker |",
      "| `/command-palette`, `/command.palette.show` | Open the command palette |",
      "| `/model-next`, `/model-previous`, `/favorite-next`, `/favorite-previous` | Cycle models without opening the picker |",
      "| `/favorite-toggle`, `/model.dialog.favorite` | Toggle the current model as favorite |",
      "| `/sessions`, `/session.list --format json`, `/resume`, `/continue` | List or resume recent chats |",
      "| `/session.next`, `/session.previous` | Navigate recent chats like BetterC0de app commands |",
      "| `/new`, `/clear` | Start a new chat session |",
      "| `/project.open`, `/project.next`, `/project.previous` | Open or navigate projects represented by chats |",
      "| `/workspace.new`, `/workspace.toggle`, `/workspace.list`, `/workspace.remove`, `/workspace.reset` | Create, inspect, list, remove, or reset isolated worktree workspace state |",
      "| `/init [focus]` | Create or update repo-local `AGENTS.md` instructions |",
      "| `/review [commit|branch|pr]`, `/pr <number>` | Review uncommitted changes, a commit, branch, or PR |",
      "| `/github`, `/github.install`, `/github.run` | Show BetterC0de GitHub agent setup and run guidance; `/github.install --workflow-only --provider <provider> --model <model>` writes the workflow file |",
      "| `/commands`, `/project-commands` | List repo-local command templates and config commands; add `--config-only` to write a config command |",
      "| `/references`, `/refs` | List configured BetterC0de project references; add `--config-only` to write an alias |",
      "| `/format <file> [formatter] [--dry-run|--terminal]` | Run or preview a BetterC0de project formatter |",
      "| `/formatters` | List BetterC0de project formatter config; add `--config-only` to write a formatter entry |",
      "| `/lsp`, `/lsps`, `/debug.lsp` | List BetterC0de project LSP server config; add `--config-only` to write an LSP entry |",
      "| `/lsp diagnostics <file> [--json]`, `/lsp symbols <query> [--json]`, `/lsp document-symbols <uri> [--json]` | Show BetterC0de LSP debug guidance and local JSON previews |",
      "| `/permissions` | List BetterC0de project permission rules; add `--config-only` to write explicit permission config |",
      "| `/approvals` | List pending provider/BetterC0de approval requests |",
      "| `/approve <#|id>`, `/deny <#|id>` | Reply to a pending approval request |",
      "| `/todos`, `/tasks`, `/session.todo` | Show the current BetterC0de session todo list |",
      "| `/betterc0de-config`, `/project-config`, `/debug.config` | Show BetterC0de project config summary |",
      "| `/betterc0de-audit`, `/betterc0de-parity` | Show BetterC0de feature-area compatibility coverage |",
      "| `/betterc0de-cli`, `/betterc0de.commands` | Show command-by-command BetterC0de compatibility coverage |",
      "| `/betterc0de-api`, `/betterc0de.api` | Show BetterC0de HTTP/API compatibility coverage |",
      "| `/betterc0de-gaps`, `/betterc0de.missing` | Show partial and display-only BetterC0de compatibility gaps |",
      "| `/betterc0de-sync`, `/sync.history.list` | Show BetterC0de sync compatibility and validation |",
      "| `/betterc0de-workspace`, `/experimental.workspace.warp` | Show BetterC0de workspace sync/warp compatibility |",
      "| `/betterc0de-lifecycle`, `/global.dispose` | Show BetterC0de lifecycle compatibility |",
      "| `/tui-control`, `/tui.control.next` | Show BetterC0de terminal control compatibility |",
      "| `/tui`, `/keybinds`, `/which-key` | Show BetterC0de terminal UI config, keybind overrides, and defaults; add `--config-only` to write safe `tui.json` settings |",
      "| `/tips` | Show BetterC0de workflow tips |",
      "| `/theme.cycle`, `/theme.scheme.cycle`, `/language.cycle` | BetterC0de app command compatibility |",
      "| `/attachments`, `/tool-output`, `/compaction` | Show BetterC0de runtime limits and context controls; add `--config-only` to write safe limit settings |",
      "| `/betterc0de-runtime` | Show BetterC0de shell, server, watcher, limits, share, enterprise, and app settings; add `--config-only` to write runtime config |",
      "| `/betterc0de-tui`, `/betterc0de-run`, `/betterc0de-serve`, `/betterc0de-web`, `/betterc0de-acp` | Show BetterC0de runtime compatibility entrypoint guidance; add `--terminal` to prefill the integrated terminal |",
      "| `/betterc0de-upgrade`, `/betterc0de-uninstall`, `/betterc0de-generate`, `/betterc0de-completion`, `/betterc0de-db`, `/db.query` | Show BetterC0de maintenance/database compatibility guidance; add `--terminal` to prefill the integrated terminal |",
      "| `/project-providers` | Show BetterC0de project provider, model, and auth config |",
      "| `/project-plugins` | Show BetterC0de project plugin specs |",
      "| `/project-tools` | Show BetterC0de project tool flags and custom tool modules; add `--config-only` to write legacy tool flags |",
      "| `/undo [turn]` | Restore the previous checkpoint, or a specific checkpoint turn |",
      "| `/redo` | Reapply the last checkpoint undo |",
      "| `/interrupt`, `/stop`, `/cancel` | Interrupt the active provider turn |",
      "| `/fork` | Fork this chat into an independent session |",
      "| `/parent`, `/child [id|title]`, `/child-next`, `/child-previous` | Navigate forked chat session branches |",
      "| `/pin`, `/pins`, `/quick-switch <1-9>` | Pin sessions and jump to BetterC0de-compatible pinned slots |",
      "| `/archive`, `/unarchive`, `/archives`, `/delete-session --yes` | Archive, restore, inspect, or permanently delete sessions |",
      ...shareCommandHelpRows(projectConfigList),
      "| `/copy` | Copy this chat transcript to the clipboard |",
      "| `/copy-last`, `/copy-assistant`, `/copy-message` | Copy the latest assistant message to the clipboard |",
      "| `/export [file.md]`, `/export --json [file.json]` | Export this chat transcript into the workspace; add `--terminal` for raw `betterc0de export` |",
      "| `/import <file.json|url>`, `/session.import <file.json|url>` | Import a BetterC0de JSON session or compatibility share data; add `--terminal` for raw `betterc0de import` |",
      "| `/diff [--full]`, `/session.diff` | Show the active chat session diff summary |",
      "| `/rename <title>`, `/title <title>` | Rename the active chat session |",
      "| `/timeline` | Show a compact timeline of this chat session |",
      "| `/messages [--limit 20] [--order asc|desc] [--cursor n]`, `/session.message.list` | Page through chat messages |",
      "| `/context [--full]`, `/session.context` | Inspect active chat context after the last compaction |",
      "| `/vcs`, `/vcs diff`, `/vcs raw`, `/vcs.apply [patch.diff]` | Show BetterC0de-compatible VCS status, diff, or patch-apply guidance |",
      "| `/history`, `/history-use [#|id]` | Show or restore BetterC0de-compatible prompt history |",
      "| `/prompt-clear`, `/prompt-paste`, `/prompt-submit` | BetterC0de prompt controls |",
      "| `/stash <prompt>` | Save prompt text to the BetterC0de-compatible prompt stash |",
      "| `/stashes`, `/stash-pop [#|id]`, `/stash-delete <#|id>` | List, restore, or delete stashed prompts |",
      "| `/first`, `/last`, `/last-user`, `/next-message`, `/previous-message` | Navigate chat messages without sending to the model |",
      "| `/page-up`, `/page-down`, `/half-page-up`, `/half-page-down`, `/line-up`, `/line-down` | Scroll the chat transcript without sending to the model |",
      "| `/open [path[:line[:column]]]`, `/editor` | Open Quick Open or a workspace file in Editor Mode |",
      "| `/add-selection`, `/context.addSelection` | Add the active editor selection to the composer context |",
      "| `/close`, `/close-tab` | Close the active editor tab |",
      "| `/warp [folder]`, `/workspace [folder]` | Change the workspace for this chat |",
      "| `/mode-next`, `/mode-previous` | Cycle between Agent, Plan, Ask, Security, and Debug modes |",
      "| `/exit`, `/quit`, `/q` | Close the BetterC0de window |",
      "| `/help` | Show this overview |",
      "| `/mcps`, `/mcp.list` | Show installed MCP servers with connection details |",
      "| `/mcp-resources`, `/experimental.resource.list` | Show BetterC0de-compatible MCP resource availability |",
      "| `/mcp-auth`, `/mcp.auth.list` | Show OAuth authentication status for MCP servers |",
      "| `/mcp-add`, `/mcp-logout`, `/mcp-debug <id>` | BetterC0de MCP add/logout/debug compatibility; add `--config-only` to write project MCP config |",
      "| `/mcp-toggle <id> [on|off]` | Enable or disable an installed MCP server; add `--config-only` to write a project override |",
      "| `/skills`, `/debug.skill` | Show installed skills and their content; add `--config-only` to add compatibility skill paths or URLs |",
      "| `/agents`, `/debug.agent` | Show configured subagents and BetterC0de-compatible details; add `--terminal` for `betterc0de agent list` / `betterc0de debug agent` |",
      "| `/agent-create`, `/agent.create` | Show BetterC0de agent create guidance; add `--terminal` to prefill raw `betterc0de agent create` |",
      "| `/instructions`, `/project-rules` | Show injected project rules and BetterC0de instructions; add `--config-only` to add instruction file globs |",
      "| `/status` | Show system status overview |",
      "| `/debug-info`, `/debug.info` | Show BetterC0de-compatible app, OS, and runtime diagnostics |",
      "| `/debug-paths`, `/debug.paths`, `/db.path` | Show BetterC0de data paths and SQLite database path |",
      "| `/debug-rg [files|read|search|tree]`, `/debug.file.[status|list|read|search|tree]`, `/file.[status|list|read]` | Run read-only BetterC0de-compatible workspace file/search diagnostics |",
      "| `/debug-snapshot [track|patch|diff]` | Show read-only BetterC0de-compatible snapshot/checkpoint diagnostics |",
      "| `/debug-startup`, `/debug-scrap`, `/debug-v2`, `/debug-wait` | Show BetterC0de debug guidance |",
      "| `/stats`, `/usage` | Show BetterC0de-compatible token, model, and tool usage statistics |",
      "| `/plugin-install <module>`, `/plugin <module>`, `/plug <module>` | Show BetterC0de plugin install guidance |",
      "| `/plugin-toggle <id> --enabled true --config-only` | Persist BetterC0de terminal UI `plugin_enabled` state |",
      "| `/compact` | Compact this chat into a thread summary |",
      "| `/docs` | Open BetterC0de documentation |",
      "| `/settings [tab]` | Open Settings (`general`, `providers`, `appearance`, `rules`, `skills`, `tools`, `hooks`, `plugins`, `betterc0de`, `docs`) |",
      "| `/org`, `/organization` | Open provider account and organization settings; add `--terminal` for `betterc0de console orgs/switch` |",
      "| `/console`, `/app.debug` | Toggle the console/debug panel |",
      "| `/app.log [level] <message>` | Write an BetterC0de-compatible local log entry |",
      "| `/heap-snapshot`, `/app.heap_snapshot` | Write a Node backend heap snapshot to the logs directory |",
      "| `/terminal`, `/terminal.suspend` | Toggle the terminal panel |",
      "| `/terminal-title`, `/terminal.title.toggle` | Toggle integrated terminal tab titles |",
      "| `/terminal-new`, `/terminal.new` | Open the terminal panel and create a new terminal session |",
      "| `/review.toggle` | Toggle the review/diff panel |",
      "| `/fileTree.toggle`, `/files` | Toggle the workspace file tree |",
      "| `/sidebar` | Toggle the main app sidebar |",
      "| `/input.focus` | Focus the chat input |",
      "| `/animations`, `/file-context`, `/session-directory-filter` | Toggle BetterC0de-compatible app behavior flags |",
      "| `/connect`, `/providers.login`, `/account.login`, `/console.login` | Show provider connection guidance; add `--terminal` to prefill the BetterC0de auth command |",
      "| `/auth`, `/auth.list`, `/account.logout`, `/providers.logout` | Show provider authentication and setup status; add `--terminal` for logout/list commands |",
      "| `/themes`, `/theme <dark|light>` | List or switch themes |",
      "| `/theme-mode`, `/theme.switch_mode`, `/theme-mode-lock` | Switch or lock the light/dark theme mode |",
      "| `/terminal-font [font|system]` | Show or set the integrated terminal font |",
      "| `/variants`, `/variant.list` | Show model variant support |",
      "| `/variant.cycle`, `/model.variant.cycle` | Cycle the current BetterC0de model variant |",
      "| `/catalog [model|provider]`, `/models <query> --verbose`, `/catalog.model.list` | Inspect provider model catalog metadata |",
      "| `/streaming [on|off]` | Toggle assistant response streaming |",
      "| `/timestamps [on|off]`, `/toggle-timestamps [on|off]` | Toggle chat message timestamps |",
      "| `/thinking [on|off]`, `/toggle-thinking [on|off]` | Toggle assistant thinking blocks |",
      "| `/reasoning-summaries [on|off]` | Toggle compact reasoning summary headings |",
      "| `/tool-details [on|off]`, `/actions [on|off]` | Toggle expanded tool details |",
      "| `/progress [on|off]`, `/session.toggle.progress_bar [on|off]` | Toggle BetterC0de-compatible session progress rows |",
      "| `/shell-expanded [on|off]`, `/edit-expanded [on|off]` | Toggle default expansion for shell and edit tool parts |",
      "| `/scrollbar [on|off]`, `/toggle-scrollbar [on|off]` | Toggle the main chat scrollbar |",
      "| `/generic-tool-output [on|off]` | Toggle raw output previews for generic tools |",
      "| `/conceal [on|off]`, `/session.toggle.conceal [on|off]` | Toggle concealed code block previews |",
      "| `/autosave [on|off]` | Toggle automatic conversation saving |",
      "| `/diffwrap [on|off]` | Toggle diff viewer word wrap |",
      "| `/diff-style [auto|stacked]` | Set BetterC0de-compatible diff layout |",
      "| `/notifications [request|on|off|agent|permissions|errors]` | Show or change native notification settings |",
      "| `/confirmations [on|off]` | Toggle archive and delete confirmations |",
      "| `/autoaccept [on|off]` | Toggle automatic tool approval for this chat |",
      "| `/density [on|off]`, `/compact-ui [on|off]` | Toggle compact chat spacing |",
    ]
    if (mcpList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**MCP Servers** - Type `/<name>` to reference\n"
      )
      for (const m of mcpList)
        sections.push(
          `- \`/${m.id}\` - **${m.name}** \`${m.command}\` ${m.enabled ? "" : "(disabled)"}`
        )
    }
    const providerSlashCommands = selectedProvider?.slashCommands ?? []
    if (providerSlashCommands.length > 0) {
      sections.push(
        "",
        "---",
        "",
        `**${selectedProvider?.name ?? "Provider"} Commands** - Type \`/<command>\` to send a provider-native slash command\n`
      )
      for (const command of providerSlashCommands) {
        const name = command.name.replace(/^\/+/, "")
        sections.push(
          `- \`/${name}\`${command.description ? ` - ${command.description}` : ""}`
        )
      }
    }
    const providerSkills = (selectedProvider?.skills ?? []).filter(
      (skill) => skill.enabled
    )
    if (providerSkills.length > 0) {
      sections.push(
        "",
        "---",
        "",
        `**${selectedProvider?.name ?? "Provider"} Skills** - Type \`/\` and choose **Skills**, or use \`$<skill>\` directly. Existing commands take precedence over a typed \`/<skill>\` alias.\n`
      )
      for (const skill of providerSkills) {
        const name = skill.name.replace(/^\$+/, "")
        sections.push(`- \`$${name}\` - **${skill.displayName ?? skill.name}**`)
      }
    }
    if (skillList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**BetterC0de Runtime Skills** - Use `/<skill-id>` to run a skill as an BetterC0de-compatible command, or `@<skill-id>` to inline one explicitly for non-native providers\n"
      )
      for (const s of skillList)
        sections.push(`- \`/${s.id}\` / \`@${s.id}\` - **${s.name}**`)
    }
    if (subagentList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Subagents** - Type `/<name>` to inspect or `@<subagent-id>` to inject into the prompt\n"
      )
      for (const agent of subagentList)
        sections.push(`- \`/${agent.id}\` - **${agent.name}**`)
    }
    if (projectCommandList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Project Commands** - Type `/<command>` to run repo-local `.betterc0de/command(s)` templates\n"
      )
      for (const command of projectCommandList) {
        sections.push(
          `- \`/${command.name}\` - **${command.description ?? command.sourcePath}**`
        )
      }
    }
    if (projectReferenceList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Project References** - Type `@<alias>` or `@<alias>/<path>` to point the agent at an BetterC0de reference\n"
      )
      for (const reference of projectReferenceList) {
        sections.push(
          `- \`@${reference.id}\` - **${reference.kind}** ${reference.repository ?? reference.relativePath ?? reference.message ?? reference.sourcePath}`
        )
      }
    }
    if (projectFormatterList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Project Formatters** - Type `/formatters` for command details\n"
      )
      for (const formatter of projectFormatterList) {
        sections.push(
          `- \`${formatter.id}\` - **${formatter.enabled ? "enabled" : "disabled"}** ${formatter.command || "built-in"}`
        )
      }
    }
    if (projectLspServerList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Project LSP Servers** - Type `/lsp` for command details\n"
      )
      for (const server of projectLspServerList) {
        sections.push(
          `- \`${server.id}\` - **${server.enabled ? "enabled" : "disabled"}** ${server.command || "built-in"}`
        )
      }
    }
    if (projectPermissionList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**Project Permissions** - Type `/permissions` for rules\n"
      )
      for (const rule of projectPermissionList) {
        sections.push(
          `- \`${rule.permission}\` \`${rule.pattern}\` - **${rule.action}**`
        )
      }
    }
    if (projectConfigList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**BetterC0de Project Config** - Type `/betterc0de` for the full summary\n"
      )
      for (const setting of projectConfigList.slice(0, 12)) {
        sections.push(`- \`${setting.key}\` - **${setting.value}**`)
      }
    }
    if (
      projectProvidersSummary &&
      (projectProvidersSummary.providers.length > 0 ||
        projectProvidersSummary.defaultModel ||
        projectProvidersSummary.enabledProviders.length > 0 ||
        projectProvidersSummary.disabledProviders.length > 0)
    ) {
      sections.push(
        "",
        "---",
        "",
        "**BetterC0de Project Providers** - Type `/project-providers` for provider and model details\n"
      )
      if (projectProvidersSummary.defaultModel) {
        sections.push(
          `- Default model: \`${projectProvidersSummary.defaultModel}\``
        )
      }
      for (const provider of projectProvidersSummary.providers) {
        sections.push(
          `- \`${provider.id}\` - **${provider.name ?? provider.id}** (${provider.models.length} model${provider.models.length === 1 ? "" : "s"})`
        )
      }
    }
    if (projectPluginList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**BetterC0de Project Plugins** - Type `/project-plugins` for plugin specs\n"
      )
      for (const plugin of projectPluginList) {
        sections.push(
          `- \`${plugin.spec}\` - **${plugin.kind}** ${plugin.message ?? ""}`
        )
      }
    }
    if (projectToolList.length > 0) {
      sections.push(
        "",
        "---",
        "",
        "**BetterC0de Project Tools** - Type `/project-tools` for tool flags and custom tool modules\n"
      )
      for (const tool of projectToolList) {
        sections.push(
          `- \`${tool.tool}\` - **${formatProjectToolState(tool)}**`
        )
      }
    }
    output = sections.join("\n")
  } else if (isBetterC0deSessionSlashSubcommand(cmd, args, "list")) {
    const sessionArgs = stripBetterC0deSessionSlashSubcommand(args)
    const terminalCommand = buildBetterC0deSessionCliTerminalCommand(
      "/betterc0de-session-list",
      sessionArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-list",
      sessionArgs,
      activeThread
    )
  } else if (isBetterC0deSessionSlashSubcommand(cmd, args, "delete")) {
    const sessionArgs = stripBetterC0deSessionSlashSubcommand(args)
    const terminalCommand = buildBetterC0deSessionCliTerminalCommand(
      "/betterc0de-session-delete",
      sessionArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildBetterC0deSessionCliOutput(
      "/betterc0de-session-delete",
      sessionArgs,
      activeThread
    )
  } else if (
    isSlashCommand(
      cmd,
      "sessions",
      "session",
      "resume",
      "continue",
      "session.list",
      "session.get",
      "session-list",
      "v2.session.list",
      "v2-session-list"
    )
  ) {
    output = buildSessionsOutput(
      filterThreadsForSessionDirectory(
        store.threads,
        threadId,
        useAppearanceStore.getState().sessionDirectoryFilterEnabled
      ),
      threadId,
      parseSessionListOptions(args)
    )
  } else if (isSlashCommand(cmd, "history", "prompt-history", "histories")) {
    output = buildPromptHistoryListOutput(
      usePreferencesStore.getState().promptHistoryEntries
    )
  } else if (
    isSlashCommand(
      cmd,
      "history-use",
      "history-pop",
      "prompt-history-use",
      "prompt.history.previous",
      "prompt-history-previous",
      "prompt.history.next",
      "prompt-history-next"
    )
  ) {
    if (!threadId) {
      threadId = store.createThread("New Chat", "BetterC0de")
    }
    output = buildPromptHistoryUseOutput(args[0], threadId)
  } else if (
    isSlashCommand(cmd, "prompt-clear", "prompt.clear", "clear-prompt")
  ) {
    if (!threadId) {
      threadId = store.createThread("New Chat", "BetterC0de")
    }
    output = buildPromptClearOutput(threadId)
  } else if (isSlashCommand(cmd, "prompt-paste", "prompt.paste")) {
    if (!threadId) {
      threadId = store.createThread("New Chat", "BetterC0de")
    }
    output = await buildPromptPasteOutput(threadId, args.join(" "))
  } else if (isSlashCommand(cmd, "prompt-submit", "prompt.submit")) {
    output = buildPromptSubmitOutput()
  } else if (
    isSlashCommand(cmd, "input-actions", ...BETTERC0DE_INPUT_ACTION_COMMANDS)
  ) {
    output = buildComposerInputActionsOutput(cmd)
  } else if (isSlashCommand(cmd, "stash", "prompt-stash", "prompt.stash")) {
    output = buildPromptStashPushOutput(args.join(" "), threadId, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "stashes",
      "stash-list",
      "prompt-stash-list",
      "prompt.stash.list"
    )
  ) {
    output = buildPromptStashListOutput(
      usePreferencesStore.getState().promptStashEntries
    )
  } else if (
    isSlashCommand(cmd, "stash-pop", "prompt-stash-pop", "prompt.stash.pop")
  ) {
    if (!threadId) {
      threadId = store.createThread("New Chat", "BetterC0de")
    }
    output = buildPromptStashPopOutput(args[0], threadId)
  } else if (
    isSlashCommand(
      cmd,
      "stash-delete",
      "stash-remove",
      "prompt-stash-delete",
      "stash.delete"
    )
  ) {
    output = buildPromptStashDeleteOutput(args[0])
  } else if (
    isSlashCommand(
      cmd,
      "commands",
      "project-commands",
      "command.list",
      "command-list"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectCommandConfigOutput(args, activeThread)
    } else {
      output = buildProjectCommandsOutput(
        projectCommandList,
        skillList,
        activeThread
      )
    }
  } else if (isSlashCommand(cmd, "references", "refs", "project-references")) {
    if (args.includes("--config-only")) {
      output = await buildProjectReferenceConfigOutput(args, activeThread)
    } else {
      output = buildProjectReferencesOutput(projectReferenceList, activeThread)
    }
  } else if (isSlashCommand(cmd, "format", "project-format", "formatter.run")) {
    const terminalCommand = buildProjectFormatTerminalCommand(
      args,
      projectFormatterList
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = await buildProjectFormatOutput(
      args,
      projectFormatterList,
      activeThread
    )
  } else if (
    isSlashCommand(
      cmd,
      "formatters",
      "project-formatters",
      "formatter.status",
      "formatter-status"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectFormatterConfigOutput(args, activeThread)
    } else {
      output = buildProjectFormattersOutput(projectFormatterList, activeThread)
    }
  } else if (
    isSlashCommand(
      cmd,
      "lsp",
      "lsps",
      "language-servers",
      "debug.lsp",
      "debug-lsp",
      "lsp.status",
      "lsp-status",
      "debug.lsp.diagnostics",
      "debug-lsp-diagnostics",
      "debug.lsp.symbols",
      "debug-lsp-symbols",
      "debug.lsp.document-symbols",
      "debug-lsp-document-symbols"
    )
  ) {
    const terminalCommand = buildProjectLspTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    if (args.includes("--config-only")) {
      output = await buildProjectLspConfigOutput(args, activeThread)
    } else {
      output = buildProjectLspServersOutput(
        projectLspServerList,
        activeThread,
        cmd,
        args
      )
    }
  } else if (isSlashCommand(cmd, "permissions", "project-permissions")) {
    if (args.includes("--config-only")) {
      output = await buildProjectPermissionsConfigOutput(args, activeThread)
    } else {
      output = buildProjectPermissionsOutput(
        projectPermissionList,
        activeThread,
        permissionLevel,
        projectSubagentList
      )
    }
  } else if (
    isSlashCommand(
      cmd,
      "approvals",
      "approval-list",
      "permission-list",
      "permission.list",
      "permissions-pending",
      "permission.prompt.fullscreen",
      "permission-fullscreen"
    )
  ) {
    output = await buildPendingApprovalsThreadOutput(threadId)
  } else if (
    isSlashCommand(
      cmd,
      "approve",
      "approval-approve",
      "permission-approve",
      "permission.reply",
      "permission.respond"
    )
  ) {
    output = await buildApprovalDecisionOutput(threadId, args[0], "approve")
  } else if (
    isSlashCommand(cmd, "deny", "reject", "approval-deny", "permission-deny")
  ) {
    output = await buildApprovalDecisionOutput(threadId, args[0], "deny")
  } else if (
    isSlashCommand(
      cmd,
      "questions",
      "question-list",
      "question.list",
      "user-inputs",
      "user-input-list"
    )
  ) {
    output = await buildPendingUserInputsThreadOutput(threadId)
  } else if (
    isSlashCommand(
      cmd,
      "answer",
      "question-reply",
      "question.reply",
      "user-input-answer"
    )
  ) {
    output = await buildUserInputAnswerOutput(threadId, args)
  } else if (
    isSlashCommand(
      cmd,
      "reject-question",
      "question-reject",
      "question.reject",
      "user-input-reject"
    )
  ) {
    output = await buildUserInputRejectOutput(threadId, args[0])
  } else if (isSlashCommand(cmd, "todos", "todo", "tasks", "session.todo")) {
    output = await buildThreadTodosOutput(threadId)
  } else if (
    isSlashCommand(
      cmd,
      "session-status",
      "session.status",
      "status.session",
      "thread-status"
    )
  ) {
    output = await buildSessionStatusOutput(threadId)
  } else if (
    isSlashCommand(
      cmd,
      "vcs",
      "vcs.status",
      "vcs-status",
      "vcs.get",
      "vcs.diff",
      "vcs-diff",
      "vcs.diff.raw",
      "vcs-diff-raw",
      "vcs-apply",
      "vcs.apply"
    )
  ) {
    const terminalCommand = isVcsApplyCommand(cmd, args)
      ? buildVcsApplyTerminalCommand(args)
      : { command: "", shouldOpen: false }
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = await buildVcsOutput(cmd, args, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "find",
      "find.text",
      "find-text",
      "find.file",
      "find-file",
      "find.files",
      "find-files",
      "find.symbol",
      "find-symbol",
      "find.symbols",
      "find-symbols"
    )
  ) {
    output = await buildFindOutput(cmd, args, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de",
      "betterc0de-config",
      "betterc0de",
      "project-config",
      "betterc0de-config",
      "debug.config",
      "debug-config",
      "config.get",
      "config-get",
      "config.update",
      "config-update",
      "global.config.get",
      "global-config-get",
      "global.config.update",
      "global-config-update",
      "betterc0de-config",
      "betterc0de",
      "compat-config"
    )
  ) {
    if (isSlashCommand(cmd, "debug.config", "debug-config")) {
      if (args.some(isBetterC0deRuntimeTerminalFlag)) {
        dispatchPrefilledTerminalCommand(
          activeThread,
          "betterc0de debug config"
        )
      }
      output = buildBetterC0deDebugConfigOutput(
        projectConfigList,
        activeThread,
        args
      )
    } else {
      output = buildProjectConfigOutput(projectConfigList, activeThread)
    }
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-audit",
      "betterc0de.parity",
      "betterc0de-parity",
      "compat",
      "compat-audit",
      "betterc0de-audit",
      "betterc0de.parity",
      "betterc0de-parity",
      "parity"
    )
  ) {
    output = buildBetterC0deParityMarkdown()
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-cli",
      "betterc0de.commands",
      "betterc0de-commands",
      "betterc0de.entrypoints",
      "betterc0de-entrypoints",
      "betterc0de-cli",
      "betterc0de.commands",
      "betterc0de-commands",
      "betterc0de.entrypoints",
      "betterc0de-entrypoints"
    )
  ) {
    output = buildBetterC0deCliParityMarkdown(args)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-api",
      "betterc0de.api",
      "betterc0de-http",
      "betterc0de.http",
      "betterc0de-http",
      "betterc0de.api",
      "betterc0de-api",
      "betterc0de.http",
      "openapi",
      "openapi.operations"
    )
  ) {
    output = buildBetterC0deHttpParityMarkdown(args)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-gaps",
      "betterc0de.missing",
      "betterc0de-missing",
      "betterc0de.todo",
      "betterc0de-todo",
      "betterc0de-gaps",
      "betterc0de.missing",
      "betterc0de-missing",
      "betterc0de.todo",
      "betterc0de-todo"
    )
  ) {
    output = buildBetterC0deGapMarkdown(args)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-sync",
      "betterc0de.sync",
      "betterc0de-sync",
      "sync",
      "sync.history.list",
      "sync-history",
      "sync.replay",
      "sync-replay",
      "sync.start",
      "sync-start",
      "sync.steal",
      "sync-steal"
    )
  ) {
    output = buildBetterC0deSyncRouteOutput(cmd, args, {
      threads: store.threads,
      activeThreadId: threadId,
      activitiesByThread: store.activitiesByThread,
      streamingByThread: store.streamingByThread,
      activeThread,
    })
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-workspace",
      "betterc0de.workspace",
      "betterc0de-workspace",
      "experimental.workspace.syncList",
      "experimental-workspace-sync-list",
      "experimental.workspace.warp",
      "experimental-workspace-warp"
    )
  ) {
    output = buildBetterC0deWorkspaceRouteOutput(cmd, args, {
      threads: store.threads,
      activeThreadId: threadId,
      activeThread,
    })
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-lifecycle",
      "betterc0de.lifecycle",
      "betterc0de-lifecycle",
      "global.dispose",
      "global-dispose",
      "instance.dispose",
      "instance-dispose"
    )
  ) {
    output = buildBetterC0deLifecycleRouteOutput(cmd, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "tui-control",
      "tui.control.next",
      "tui-control-next",
      "tui.control.response",
      "tui-control-response"
    )
  ) {
    output = buildBetterC0deTuiControlRouteOutput(cmd, args)
  } else if (
    isSlashCommand(cmd, "auth.set", "auth-set", "auth.remove", "auth-remove")
  ) {
    output = buildBetterC0deAuthControlOutput(cmd, args)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-internal",
      "betterc0de.internal",
      "betterc0de-internal"
    ) ||
    isBetterC0deInternalRouteCommand(cmd)
  ) {
    const terminalCommand = buildBetterC0deInternalRouteTerminalCommand(
      cmd,
      args
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildBetterC0deInternalRouteOutput(cmd, args)
  } else if (isSlashCommand(cmd, "tui", "tui-config")) {
    output = args.includes("--config-only")
      ? await buildProjectTuiConfigWriteOutput(args, activeThread)
      : buildProjectTuiConfigOutput(projectConfigList, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "keybinds",
      "keybindings",
      "which-key",
      "which-key.toggle",
      "which-key.layout.toggle",
      "which-key.pending.toggle",
      "which-key.group.previous",
      "which-key.group.next",
      "which-key.scroll.up",
      "which-key.scroll.down",
      "which-key.page.up",
      "which-key.page.down",
      "which-key.home",
      "which-key.end"
    )
  ) {
    output = args.includes("--config-only")
      ? await buildProjectTuiConfigWriteOutput(args, activeThread)
      : buildProjectKeybindsOutput(projectConfigList, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "tips",
      "tips.toggle",
      "betterc0de-tips",
      "betterc0de-tips",
      "tips-toggle"
    )
  ) {
    output = buildBetterC0deTipsMarkdown()
  } else if (
    isSlashCommand(
      cmd,
      "attachments",
      "attachment",
      "image-attachments",
      "betterc0de-attachments",
      "betterc0de-attachments"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildBetterC0deRuntimeConfigOutput(args, activeThread)
    } else {
      output = buildProjectConfigGroupOutput({
        activeThread,
        emptyTitle: "BetterC0de Attachments",
        emptyMessage:
          "No BetterC0de attachment config found. Defaults are auto resize on, max 2000x2000, and 5 MB base64 payload.",
        heading: "BetterC0de Attachments",
        match: isBetterC0deAttachmentConfigKey,
        settings: projectConfigList,
      })
    }
  } else if (
    isSlashCommand(
      cmd,
      "tool-output",
      "tool-output-limits",
      "betterc0de-tool-output",
      "betterc0de-tool-output"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildBetterC0deRuntimeConfigOutput(args, activeThread)
    } else {
      output = buildProjectConfigGroupOutput({
        activeThread,
        emptyTitle: "BetterC0de Tool Output",
        emptyMessage:
          "No BetterC0de tool_output config found. BetterC0de will use its runtime defaults.",
        heading: "BetterC0de Tool Output",
        match: isBetterC0deToolOutputConfigKey,
        settings: projectConfigList,
      })
    }
  } else if (
    isSlashCommand(
      cmd,
      "compaction",
      "context-compaction",
      "betterc0de-compaction",
      "betterc0de-compaction"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildBetterC0deRuntimeConfigOutput(args, activeThread)
    } else {
      output = buildProjectConfigGroupOutput({
        activeThread,
        emptyTitle: "BetterC0de Compaction",
        emptyMessage:
          "No BetterC0de compaction config found. BetterC0de will use its runtime defaults.",
        heading: "BetterC0de Compaction",
        match: isBetterC0deCompactionConfigKey,
        settings: projectConfigList,
      })
    }
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-runtime",
      "betterc0de-runtime",
      "betterc0de.server",
      "betterc0de-app",
      "runtime-config",
      "betterc0de-server",
      "betterc0de-app"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildBetterC0deRuntimeConfigOutput(args, activeThread)
    } else {
      output = buildProjectConfigGroupOutput({
        activeThread,
        emptyTitle: "BetterC0de Runtime Config",
        emptyMessage:
          "No BetterC0de compatibility runtime/app config found. BetterC0de will use its own app defaults.",
        heading: "BetterC0de Runtime Config",
        match: isBetterC0deRuntimeConfigKey,
        settings: projectConfigList,
      })
    }
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-tui",
      "betterc0de-tui",
      "betterc0de.thread",
      "betterc0de-thread",
      "betterc0de.ui",
      "betterc0de-ui",
      "betterc0de.thread",
      "betterc0de-thread",
      "betterc0de.ui",
      "betterc0de-ui",
      "betterc0de-run",
      "betterc0de-run",
      "betterc0de.run",
      "betterc0de-cli-run",
      "betterc0de.run",
      "betterc0de-cli-run",
      "betterc0de-serve",
      "betterc0de-serve",
      "betterc0de.serve",
      "betterc0de-server-start",
      "betterc0de.serve",
      "betterc0de-server-start",
      "betterc0de-attach",
      "betterc0de-attach",
      "betterc0de.attach",
      "betterc0de-server-switch",
      "betterc0de.attach",
      "attach",
      "attach-server",
      "server.switch",
      "server-switch",
      "betterc0de-web",
      "betterc0de-web",
      "betterc0de.web",
      "betterc0de-web-ui",
      "betterc0de.web",
      "betterc0de-web-ui",
      "betterc0de-acp",
      "betterc0de-acp",
      "betterc0de.acp",
      "betterc0de.acp",
      "acp"
    )
  ) {
    const terminalCommand = buildBetterC0deRuntimeTerminalCommand(cmd, args)
    const runtimePath = resolveThreadRuntimePath(activeThread)
    if (runtimePath && terminalCommand.shouldOpen && terminalCommand.command) {
      const prefs = usePreferencesStore.getState()
      prefs.set("terminalOpen", true)
      window.setTimeout(() => {
        dispatchTerminalNewSession({
          threadId,
          mode: prefs.appMode,
          cwd: runtimePath,
          initialCommand: terminalCommand.command,
        })
      }, 0)
    }
    output = buildBetterC0deRuntimeEntrypointOutput(cmd, args, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-upgrade",
      "betterc0de-upgrade",
      "betterc0de.upgrade",
      "betterc0de-update",
      "betterc0de.upgrade",
      "betterc0de-update",
      "betterc0de-uninstall",
      "betterc0de-uninstall",
      "betterc0de.uninstall",
      "betterc0de.uninstall",
      "betterc0de-generate",
      "betterc0de-generate",
      "betterc0de.generate",
      "betterc0de-openapi",
      "betterc0de.generate",
      "betterc0de-openapi",
      "betterc0de-completion",
      "betterc0de-completion",
      "betterc0de.completion",
      "betterc0de.completion",
      "completion",
      "betterc0de-db",
      "betterc0de-db",
      "betterc0de.db",
      "betterc0de-db-path",
      "betterc0de-db-migrate",
      "betterc0de-db-query",
      "betterc0de.db",
      "betterc0de-db-path",
      "betterc0de-db-migrate",
      "betterc0de-db-query",
      "betterc0de.db.query",
      "db",
      "db.migrate",
      "db.query",
      "db-query"
    )
  ) {
    const terminalCommand = buildBetterC0deMaintenanceTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      const prefs = usePreferencesStore.getState()
      prefs.set("terminalOpen", true)
      window.setTimeout(() => {
        dispatchTerminalNewSession({
          threadId,
          mode: prefs.appMode,
          cwd: resolveThreadRuntimePath(activeThread),
          initialCommand: terminalCommand.command,
        })
      }, 0)
    }
    const maintenanceCommandKey = cmd.replace(/^\//, "").toLowerCase()
    const isBetterC0deDbMaintenanceCommand =
      maintenanceCommandKey.includes("db") ||
      ["db", "db.migrate", "db.query", "db-query"].includes(
        maintenanceCommandKey
      )
    output =
      isBetterC0deDbMaintenanceCommand && betterC0deDbMode(cmd, args) === "path"
        ? buildBetterC0deDbPathOutput(await getRuntimeDebugInfo(), cmd, args)
        : buildBetterC0deMaintenanceOutput(cmd, args)
  } else if (
    isSlashCommand(
      cmd,
      "betterc0de-session",
      "betterc0de.session",
      "betterc0de-session-list",
      "betterc0de.session.list",
      "betterc0de-session-delete",
      "betterc0de.session.delete",
      "session-cli",
      "session.cli"
    )
  ) {
    const terminalCommand = buildBetterC0deSessionCliTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildBetterC0deSessionCliOutput(cmd, args, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "project-providers",
      "provider-config",
      "betterc0de-providers",
      "betterc0de-providers",
      "config.providers",
      "config-providers",
      "v2.provider.list",
      "v2-provider-list",
      "v2.provider.get",
      "v2-provider-get"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectProviderConfigOutput(args, activeThread)
    } else {
      output = buildProjectProvidersOutput(
        projectProvidersSummary,
        activeThread
      )
    }
  } else if (
    isSlashCommand(
      cmd,
      "project-plugins",
      "betterc0de-plugins",
      "betterc0de-plugins"
    )
  ) {
    output = buildProjectPluginsOutput(projectPluginList, activeThread, args)
  } else if (
    isSlashCommand(
      cmd,
      "project-tools",
      "betterc0de-tools",
      "betterc0de-tools",
      "tool.list",
      "tool-list",
      "tool.ids",
      "tool-ids"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectToolsConfigOutput(args, activeThread)
    } else {
      output = buildProjectToolsOutput(
        projectToolList,
        activeThread,
        permissionLevel
      )
    }
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "resources")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    if (mcpArgs.some(isBetterC0deRuntimeTerminalFlag)) {
      dispatchPrefilledTerminalCommand(activeThread, "betterc0de serve")
    }
    output = buildMcpResourcesOutput(mcpList, mcpArgs)
  } else if (
    isSlashCommand(
      cmd,
      "mcp-resources",
      "mcp.resources",
      "mcp-resource-list",
      "resources",
      "experimental.resource.list",
      "experimental-resource-list"
    )
  ) {
    if (args.some(isBetterC0deRuntimeTerminalFlag)) {
      dispatchPrefilledTerminalCommand(activeThread, "betterc0de serve")
    }
    output = buildMcpResourcesOutput(mcpList, args)
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "auth")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    const terminalCommand = buildBetterC0deMcpTerminalCommand(
      "/mcp-auth",
      mcpArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
    const listOnly =
      cleanArgs[0]?.toLowerCase() === "list" ||
      cleanArgs[0]?.toLowerCase() === "ls"
    if (cleanArgs[0] && !listOnly) {
      const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
      output = matchedMcp
        ? buildRuntimeMcpDetailOutput(matchedMcp)
        : buildMcpNotFoundOutput(cleanArgs[0], mcpList)
    } else {
      output = buildMcpAuthOutput(mcpList, mcpArgs)
    }
  } else if (
    isSlashCommand(
      cmd,
      "mcp-auth",
      "mcp.auth",
      "mcp.auth.list",
      "mcp.auth.ls",
      "mcp.auth.start",
      "mcp.auth.callback",
      "mcp.auth.authenticate",
      "mcp-auth-list",
      "mcp-auth-ls"
    )
  ) {
    const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
    if (cleanArgs[0]) {
      const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
      output = matchedMcp
        ? buildRuntimeMcpDetailOutput(matchedMcp)
        : buildMcpNotFoundOutput(cleanArgs[0], mcpList)
    } else {
      output = buildMcpAuthOutput(mcpList, args)
    }
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "add")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    if (mcpArgs.includes("--config-only")) {
      output = await buildProjectMcpConfigOutput(mcpArgs, activeThread)
    } else {
      const terminalCommand = buildBetterC0deMcpTerminalCommand(
        "/mcp-add",
        mcpArgs
      )
      if (terminalCommand.shouldOpen && terminalCommand.command) {
        dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
      }
      openSettingsTab("tools")
      output = buildMcpAddOutput(activeThread, mcpArgs)
    }
  } else if (
    isSlashCommand(cmd, "mcp-add", "mcp.add", "mcp-install", "mcp.install")
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectMcpConfigOutput(args, activeThread)
    } else {
      const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
      if (terminalCommand.shouldOpen && terminalCommand.command) {
        dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
      }
      openSettingsTab("tools")
      output = buildMcpAddOutput(activeThread, args)
    }
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "logout")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    const terminalCommand = buildBetterC0deMcpTerminalCommand(
      "/mcp-logout",
      mcpArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
    output = buildMcpLogoutOutput(mcpList, cleanArgs[0], mcpArgs)
  } else if (
    isSlashCommand(
      cmd,
      "mcp-logout",
      "mcp.logout",
      "mcp.auth.remove",
      "mcp-auth-logout"
    )
  ) {
    const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
    output = buildMcpLogoutOutput(mcpList, cleanArgs[0], args)
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "debug")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    const terminalCommand = buildBetterC0deMcpTerminalCommand(
      "/mcp-debug",
      mcpArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(mcpArgs)
    output = buildMcpDebugOutput(mcpList, cleanArgs[0], mcpArgs)
  } else if (isSlashCommand(cmd, "mcp-debug", "mcp.debug", "mcp-inspect")) {
    const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
    output = buildMcpDebugOutput(mcpList, cleanArgs[0], args)
  } else if (isBetterC0deMcpSlashSubcommand(cmd, args, "list")) {
    const mcpArgs = stripBetterC0deMcpSlashSubcommand(args)
    const terminalCommand = buildBetterC0deMcpTerminalCommand(
      "/mcp.list",
      mcpArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildMcpServersOutput(mcpList, mcpArgs)
  } else if (
    isSlashCommand(
      cmd,
      "mcps",
      "mcp",
      "mcp.list",
      "mcp.ls",
      "mcp.status",
      "mcp-ls"
    )
  ) {
    const terminalCommand = buildBetterC0deMcpTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
    if (cleanArgs[0]) {
      const matchedMcp = resolveRuntimeMcpServer(mcpList, cleanArgs[0])
      if (!matchedMcp) {
        output = buildMcpNotFoundOutput(cleanArgs[0], mcpList)
      } else if (cleanArgs[1]) {
        output = await buildRuntimeMcpToggleOutput(
          matchedMcp,
          resolveToggleArg(cleanArgs[1], matchedMcp.enabled)
        )
      } else {
        output = buildRuntimeMcpDetailOutput(matchedMcp)
      }
    } else {
      output = buildMcpServersOutput(mcpList, args)
    }
  } else if (
    isSlashCommand(
      cmd,
      "mcp-toggle",
      "toggle-mcp",
      "mcp.toggle",
      "mcp.connect",
      "mcp.disconnect",
      "dialog.mcp.toggle",
      "dialog-mcp-toggle",
      "mcp-enable",
      "mcp-disable"
    )
  ) {
    const forced = isSlashCommand(cmd, "mcp-enable")
      ? true
      : isSlashCommand(cmd, "mcp-disable")
        ? false
        : undefined
    if (args.includes("--config-only")) {
      const cleanArgs = args.filter(
        (arg) =>
          arg !== "--config-only" && !isBetterC0deRuntimeTerminalFlag(arg)
      )
      const target = cleanArgs[0]
      if (!target) {
        output =
          "# MCP Toggle\n\n> Usage: `/mcp-toggle <id> [on|off] --config-only`"
      } else {
        const matchedMcp = resolveRuntimeMcpServer(mcpList, target)
        const enabled =
          typeof forced === "boolean"
            ? forced
            : resolveToggleArg(cleanArgs[1], matchedMcp?.enabled ?? true)
        output = await buildProjectMcpConfigOutput(
          ["--config-only", target, "--enabled", String(enabled)],
          activeThread
        )
      }
    } else {
      const matchedMcp = args[0]
        ? resolveRuntimeMcpServer(mcpList, args[0])
        : null
      if (!args[0]) {
        output = "# MCP Toggle\n\n> Usage: `/mcp-toggle <id> [on|off]`"
      } else if (!matchedMcp) {
        output = buildMcpNotFoundOutput(args[0], mcpList)
      } else {
        output = await buildRuntimeMcpToggleOutput(
          matchedMcp,
          typeof forced === "boolean"
            ? forced
            : resolveToggleArg(args[1], matchedMcp.enabled)
        )
      }
    }
  } else if (
    isSlashCommand(
      cmd,
      "skills",
      "prompt.skills",
      "prompt-skills",
      "debug.skill",
      "debug-skill",
      "app.skills"
    )
  ) {
    if (args.includes("--config-only")) {
      output = await buildProjectSkillsConfigOutput(args, activeThread)
    } else {
      output = buildRuntimeSkillsOutput(
        skillList,
        isSlashCommand(cmd, "debug.skill", "debug-skill")
          ? [...args, "--json"]
          : args
      )
    }
  } else if (isBetterC0deAgentSlashSubcommand(cmd, args, "list")) {
    const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
    const terminalCommand = buildBetterC0deAgentTerminalCommand(
      "/agents",
      agentArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildRuntimeSubagentListOutput(
      subagentList,
      terminalCommand.shouldOpen ? terminalCommand.command : undefined
    )
  } else if (isBetterC0deAgentSlashSubcommand(cmd, args, "debug")) {
    const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
    const terminalCommand = buildBetterC0deAgentTerminalCommand(
      "/debug.agent",
      agentArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(agentArgs)
    if (cleanArgs[0]) {
      const matchedSubagent = resolveRuntimeSubagent(subagentList, cleanArgs[0])
      output = matchedSubagent
        ? buildRuntimeSubagentDebugOutput(
            matchedSubagent,
            cleanArgs,
            terminalCommand.command
          )
        : buildSubagentNotFoundOutput(cleanArgs[0], subagentList)
    } else {
      output = buildRuntimeSubagentListOutput(
        subagentList,
        terminalCommand.shouldOpen ? terminalCommand.command : undefined
      )
    }
  } else if (
    isSlashCommand(
      cmd,
      "agents",
      "agent.list",
      "agent-list",
      "debug.agent",
      "debug-agent",
      "app.agents"
    )
  ) {
    const terminalCommand = buildBetterC0deAgentTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
    if (isSlashCommand(cmd, "debug.agent", "debug-agent") && cleanArgs[0]) {
      const matchedSubagent = resolveRuntimeSubagent(subagentList, cleanArgs[0])
      output = matchedSubagent
        ? buildRuntimeSubagentDebugOutput(
            matchedSubagent,
            cleanArgs,
            terminalCommand.command
          )
        : buildSubagentNotFoundOutput(cleanArgs[0], subagentList)
    } else {
      output = buildRuntimeSubagentListOutput(
        subagentList,
        terminalCommand.shouldOpen ? terminalCommand.command : undefined
      )
    }
  } else if (isBetterC0deAgentSlashSubcommand(cmd, args, "create")) {
    const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
    const terminalCommand = buildBetterC0deAgentTerminalCommand(
      "/agent-create",
      agentArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    openSettingsTab("skills")
    output = await buildAgentCreateOutput(agentArgs, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "agent-create",
      "agent.create",
      "agents.create",
      "create-agent"
    )
  ) {
    const terminalCommand = buildBetterC0deAgentTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    openSettingsTab("skills")
    output = await buildAgentCreateOutput(args, activeThread)
  } else if (isSlashCommand(cmd, "instructions", "project-rules")) {
    if (args.includes("--config-only")) {
      output = await buildProjectInstructionsConfigOutput(args, activeThread)
    } else {
      output = await buildProjectInstructionsOutput(activeThread)
    }
  } else if (
    isSlashCommand(
      cmd,
      "status",
      "betterc0de.status",
      "betterc0de-status",
      "betterc0de.status",
      "betterc0de-status",
      "global.health"
    )
  ) {
    output = buildSystemStatusOutput({
      mcpList,
      skillList,
      subagentList,
      selectedProvider,
      selectedModel,
      chatMode: effectiveChatMode,
      permissionLevel,
      activeThread,
    })
  } else if (
    isSlashCommand(
      cmd,
      "debug-info",
      "debug.info",
      "betterc0de.debug.info",
      "betterc0de-debug-info",
      "betterc0de.debug.info",
      "betterc0de-debug-info"
    )
  ) {
    output = buildRuntimeDebugInfoOutput(await getRuntimeDebugInfo())
  } else if (
    isSlashCommand(
      cmd,
      "debug-paths",
      "debug.paths",
      "betterc0de.debug.paths",
      "betterc0de-debug-paths",
      "betterc0de.debug.paths",
      "betterc0de-debug-paths",
      "db.path",
      "db-path",
      "paths",
      "path.get",
      "path-get"
    )
  ) {
    output = buildRuntimeDebugPathsOutput(await getRuntimeDebugInfo())
  } else if (
    isSlashCommand(
      cmd,
      "debug-rg",
      "debug.rg",
      "debug.rg.files",
      "debug.rg.search",
      "debug.file",
      "debug.file.read",
      "debug-file-read",
      "debug.file.list",
      "debug-file-list",
      "debug.file.status",
      "debug-file-status",
      "debug.file.search",
      "debug.file.tree",
      "file",
      "file.read",
      "file-read",
      "file.list",
      "file-list",
      "file.status",
      "file-status"
    )
  ) {
    output = await buildDebugRgOutput(cmd, args, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "debug-snapshot",
      "debug.snapshot",
      "debug.snapshot.track",
      "debug.snapshot.patch",
      "debug.snapshot.diff",
      "debug-snapshot-track",
      "debug-snapshot-patch",
      "debug-snapshot-diff"
    )
  ) {
    output = await buildDebugSnapshotOutput(threadId, cmd, args)
  } else if (
    isSlashCommand(
      cmd,
      "debug-utility",
      "debug.startup",
      "debug-startup",
      "debug.scrap",
      "debug-scrap",
      "debug.v2",
      "debug-v2",
      "debug.wait",
      "debug-wait"
    )
  ) {
    const terminalCommand = buildBetterC0deDebugUtilityTerminalCommand(
      cmd,
      args
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildBetterC0deDebugUtilityOutput(cmd, args)
  } else if (isSlashCommand(cmd, "usage", "cli-usage")) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("betterc0de:open-usage"))
    }
    output = ""
  } else if (
    isSlashCommand(
      cmd,
      "stats",
      "token-usage",
      "session.stats",
      "session-stats"
    )
  ) {
    const statsOptions = parseStatsCommandOptions(args, activeThread)
    if (statsOptions.terminalCommand) {
      dispatchPrefilledTerminalCommand(
        activeThread,
        statsOptions.terminalCommand
      )
    }
    const stats =
      (statsOptions.validation?.length ?? 0) > 0
        ? emptyThreadUsageStats()
        : await loadThreadStats(statsOptions)
    output = buildThreadStatsOutput(stats, statsOptions)
  } else if (
    isSlashCommand(
      cmd,
      "github",
      "github-agent",
      "github.install",
      "github-install",
      "github.run",
      "github-run"
    )
  ) {
    const githubSubcommand = betterC0deGithubSlashSubcommand(cmd, args)
    const githubCommand =
      githubSubcommand === "run"
        ? "/github.run"
        : githubSubcommand === "install"
          ? "/github.install"
          : cmd
    const githubArgs = githubSubcommand
      ? stripBetterC0deGithubSlashSubcommand(args)
      : args
    const terminalCommand = buildBetterC0deGithubTerminalCommand(
      githubCommand,
      githubArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = await buildGithubAgentOutput(
      githubCommand,
      githubArgs,
      activeThread
    )
  } else if (
    isSlashCommand(cmd, "docs", "documentation", "docs.open", "docs-open")
  ) {
    const docsUrl = "https://github.com/BetterC0de/docs"
    const electronApi = window.electronAPI
    void (
      electronApi?.openExternal?.(docsUrl) ?? window.open(docsUrl, "_blank")
    )
    output = `# Docs\n\nOpened ${docsUrl}`
  } else if (
    isSlashCommand(
      cmd,
      "org",
      "organization",
      "orgs",
      "switch-org",
      "console.orgs",
      "console-orgs",
      "console.switch",
      "console-switch",
      "console.org.switch",
      "console-org-switch",
      "account.orgs",
      "account.switch"
    )
  ) {
    const terminalCommand = buildBetterC0deAccountTerminalCommand(cmd, args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    openSettingsTab("models")
    output = buildProviderOrganizationOutput(cmd, args)
  } else if (
    isSlashCommand(
      cmd,
      "plugin-install",
      "plugin",
      "plug",
      "plugin.install",
      "plugins.install",
      "plugins-install",
      "dialog.plugins.install",
      "dialog-plugins-install"
    )
  ) {
    const terminalCommand = buildBetterC0dePluginTerminalCommand(args)
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    openSettingsTab("plugins")
    output = await buildPluginInstallOutput(args, activeThread)
  } else if (
    isSlashCommand(cmd, "plugin-toggle", "plugins.toggle", "plugins-toggle")
  ) {
    openSettingsTab("plugins")
    output = await buildPluginToggleOutput(args, activeThread)
  } else if (isBetterC0deProviderSlashSubcommand(cmd, args, "login")) {
    const providerArgs = stripBetterC0deProviderSlashSubcommand(args)
    const providerMode = isSlashCommand(cmd, "auth")
      ? "/auth.login"
      : "/providers.login"
    const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
      providerMode,
      providerArgs,
      selectedProvider
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderConnectionOutput(
      selectedProvider,
      providerMode,
      providerArgs
    )
  } else if (
    isBetterC0deProviderSlashSubcommand(cmd, args, "list") ||
    isBetterC0deProviderSlashSubcommand(cmd, args, "logout")
  ) {
    const providerArgs = stripBetterC0deProviderSlashSubcommand(args)
    const authRoot = isSlashCommand(cmd, "auth")
    const providerMode = isBetterC0deProviderSlashSubcommand(
      cmd,
      args,
      "logout"
    )
      ? authRoot
        ? "/auth.logout"
        : "/providers.logout"
      : authRoot
        ? "/auth.list"
        : "/providers.list"
    const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
      providerMode,
      providerArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderAuthOutput(
      providers,
      selectedProvider,
      providerMode,
      providerArgs
    )
  } else if (
    isBetterC0deConsoleSlashSubcommand(cmd, args, "login") ||
    isBetterC0deConsoleSlashSubcommand(cmd, args, "open")
  ) {
    const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
    const consoleMode = isBetterC0deConsoleSlashSubcommand(cmd, args, "open")
      ? "/console.open"
      : "/console.login"
    const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
      consoleMode,
      consoleArgs,
      selectedProvider
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderConnectionOutput(
      selectedProvider,
      consoleMode,
      consoleArgs
    )
  } else if (isBetterC0deConsoleSlashSubcommand(cmd, args, "logout")) {
    const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
    const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
      "/console.logout",
      consoleArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderAuthOutput(
      providers,
      selectedProvider,
      "/console.logout",
      consoleArgs
    )
  } else if (
    isBetterC0deConsoleSlashSubcommand(cmd, args, "orgs") ||
    isBetterC0deConsoleSlashSubcommand(cmd, args, "switch")
  ) {
    const consoleArgs = stripBetterC0deConsoleSlashSubcommand(args)
    const consoleMode = isBetterC0deConsoleSlashSubcommand(cmd, args, "switch")
      ? "/console.switch"
      : "/console.orgs"
    const terminalCommand = buildBetterC0deAccountTerminalCommand(
      consoleMode,
      consoleArgs
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    openSettingsTab("models")
    output = buildProviderOrganizationOutput(consoleMode, consoleArgs)
  } else if (isSlashCommand(cmd, "remote", "remote-access")) {
    output = await executeRemoteAccessCommand(args)
  } else if (resolveSettingsTabCommand(cmd, args[0])) {
    const tab = resolveSettingsTabCommand(cmd, args[0]) ?? "general"
    openSettingsTab(tab)
    output = `# Settings\n\nOpened **${settingsTabLabel(tab)}**.`
  } else if (
    isSlashCommand(
      cmd,
      "console",
      "app.console",
      "app-console",
      "app.debug",
      "app-debug"
    )
  ) {
    const prefs = usePreferencesStore.getState()
    const next = !prefs.consolePanelOpen
    prefs.set("consolePanelOpen", next)
    output = buildToggleOutput("Console Panel", next)
  } else if (isSlashCommand(cmd, "app.log", "app-log")) {
    const parsed = parseAppLogCommandArgs(args)
    if (parsed.payload) {
      emitAppLog(parsed.payload)
      usePreferencesStore.getState().set("consolePanelOpen", true)
    }
    output = buildAppLogOutput(parsed)
  } else if (
    isSlashCommand(
      cmd,
      "heap-snapshot",
      "app.heap_snapshot",
      "app-heap-snapshot"
    )
  ) {
    output = buildRuntimeHeapSnapshotOutput(await writeRuntimeHeapSnapshot())
  } else if (
    isSlashCommand(cmd, "review-toggle", "review.toggle", "review-panel-toggle")
  ) {
    const next = toggleDiffView()
    output = buildToggleOutput("Review / Diff Panel", next)
  } else if (
    isSlashCommand(
      cmd,
      "terminal-title",
      "terminal.title.toggle",
      "terminal-title-toggle",
      "pty.update"
    )
  ) {
    const appearance = useAppearanceStore.getState()
    const next = resolveToggleArg(args[0], appearance.terminalTitleEnabled)
    appearance.set("terminalTitleEnabled", next)
    output = buildToggleOutput("Terminal Titles", next)
  } else if (
    isSlashCommand(
      cmd,
      "terminal",
      "terminal.toggle",
      "terminal.suspend",
      "pty",
      "pty.list",
      "pty-list",
      "pty.shells",
      "pty-shells",
      "pty.get",
      "pty-get",
      "pty.connect",
      "pty-connect",
      "pty.connectToken",
      "pty.connect-token",
      "pty.remove",
      "pty-remove"
    )
  ) {
    const prefs = usePreferencesStore.getState()
    const next = !prefs.terminalOpen
    prefs.set("terminalOpen", next)
    output = buildPtyTerminalOutput(cmd, next, activeThread)
  } else if (
    isSlashCommand(
      cmd,
      "terminal-new",
      "terminal.new",
      "new-terminal",
      "pty.create",
      "pty-create"
    )
  ) {
    const prefs = usePreferencesStore.getState()
    const wasOpen = prefs.terminalOpen
    prefs.set("terminalOpen", true)
    if (wasOpen) {
      window.setTimeout(() => {
        dispatchTerminalNewSession({
          threadId,
          mode: prefs.appMode,
          cwd: resolveThreadRuntimePath(activeThread),
        })
      }, 0)
    }
    output = [
      "# New Terminal\n",
      isSlashCommand(cmd, "pty.create", "pty-create")
        ? "Compatibility reference: `pty.create`.\n"
        : "",
      "Opened a new terminal session.",
    ]
      .filter(Boolean)
      .join("\n")
  } else if (
    isSlashCommand(
      cmd,
      "file-tree-toggle",
      "filetree.toggle",
      "filetree-toggle",
      "file-tree.toggle",
      "file-tree",
      "files",
      "files.toggle"
    )
  ) {
    const prefs = usePreferencesStore.getState()
    const active =
      prefs.appMode === "editor"
        ? prefs.sidebarOpen && prefs.editorSidebarView === "files"
        : prefs.rightSidebarOpen && prefs.workspaceTab === "files"
    const next = resolveToggleArg(args[0], active)
    if (prefs.appMode === "editor") {
      if (next) prefs.set("editorSidebarView", "files")
      prefs.set("sidebarOpen", next)
    } else if (next) {
      prefs.set("rightSidebarOpen", true)
      prefs.set("workspaceTab", "files")
    } else if (prefs.workspaceTab === "files") {
      prefs.set("workspaceTab", "plan")
    }
    output = buildToggleOutput("File Tree", next)
  } else if (
    isSlashCommand(
      cmd,
      "sidebar",
      "toggle-sidebar",
      "sidebar.toggle",
      "session.sidebar.toggle"
    )
  ) {
    const prefs = usePreferencesStore.getState()
    const next = resolveToggleArg(args[0], prefs.sidebarOpen)
    prefs.set("sidebarOpen", next)
    output = buildToggleOutput("File Tree / Sidebar", next)
  } else if (
    isSlashCommand(
      cmd,
      "input-focus",
      "input.focus",
      "focus-input",
      "composer-focus"
    )
  ) {
    focusChatComposerInput(threadId)
    output = "# Input Focus\n\nFocused the chat input."
  } else if (
    isSlashCommand(
      cmd,
      "animations",
      "app.toggle.animations",
      "app-toggle-animations"
    )
  ) {
    const appearance = useAppearanceStore.getState()
    const next = resolveToggleArg(args[0], appearance.animationsEnabled)
    appearance.set("animationsEnabled", next)
    output = buildToggleOutput("Animations", next)
  } else if (
    isSlashCommand(
      cmd,
      "file-context",
      "app.toggle.file_context",
      "app-toggle-file-context"
    )
  ) {
    const appearance = useAppearanceStore.getState()
    const next = resolveToggleArg(args[0], appearance.fileContextEnabled)
    appearance.set("fileContextEnabled", next)
    output = buildToggleOutput("File Context", next)
  } else if (
    isSlashCommand(
      cmd,
      "paste-summary",
      "app.toggle.paste_summary",
      "app-toggle-paste-summary"
    )
  ) {
    output =
      "Pasted text is always inserted directly and remains editable. Paste summaries have been removed."
  } else if (
    isSlashCommand(
      cmd,
      "session-directory-filter",
      "app.toggle.session_directory_filter",
      "app-toggle-session-directory-filter"
    )
  ) {
    const appearance = useAppearanceStore.getState()
    const next = resolveToggleArg(
      args[0],
      appearance.sessionDirectoryFilterEnabled
    )
    appearance.set("sessionDirectoryFilterEnabled", next)
    output = buildToggleOutput("Session Directory Filter", next)
  } else if (
    isSlashCommand(
      cmd,
      "connect",
      "provider.connect",
      "provider-connect",
      "providers.login",
      "provider.login",
      "auth.login",
      "auth.connect",
      "console.login",
      "console.open",
      "account.login",
      "account.open"
    )
  ) {
    const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
      cmd,
      args,
      selectedProvider
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderConnectionOutput(selectedProvider, cmd, args)
  } else if (
    isSlashCommand(
      cmd,
      "auth",
      "auth.list",
      "auth.ls",
      "auth.get",
      "provider-auth",
      "provider.auth",
      "providers.list",
      "providers.ls",
      "provider.list",
      "provider.ls",
      "providers.logout",
      "provider.logout",
      "auth.logout",
      "console.logout",
      "account",
      "account.list",
      "account.logout"
    )
  ) {
    const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
      cmd,
      args
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderAuthOutput(providers, selectedProvider, cmd, args)
  } else if (
    isSlashCommand(cmd, "theme-mode", "theme.switch_mode", "theme-switch-mode")
  ) {
    const appearance = useAppearanceStore.getState()
    const nextTemplate = nextThemeTemplateId(appearance.template)
    appearance.applyTemplate(nextTemplate)
    output = buildThemeModeOutput(
      useAppearanceStore.getState().template,
      appearance.themeModeLocked
    )
  } else if (
    isSlashCommand(cmd, "theme-mode-lock", "theme.mode.lock", "theme-lock")
  ) {
    const appearance = useAppearanceStore.getState()
    const next = resolveToggleArg(args[0], appearance.themeModeLocked)
    appearance.set("themeModeLocked", next)
    output = buildToggleOutput("Theme Mode Lock", next)
  } else if (
    isSlashCommand(
      cmd,
      "themes",
      "theme",
      "theme.switch",
      "theme-switch",
      "theme.cycle",
      "theme-cycle",
      "theme.scheme.cycle",
      "theme-scheme-cycle"
    )
  ) {
    const appearance = useAppearanceStore.getState()
    const cycleRequested = isSlashCommand(
      cmd,
      "theme.cycle",
      "theme-cycle",
      "theme.scheme.cycle",
      "theme-scheme-cycle"
    )
    const requestedTheme =
      cycleRequested && !args[0]
        ? nextThemeTemplateId(appearance.template)
        : args[0]?.toLowerCase()
    const nextTemplate = requestedTheme
      ? resolveThemeTemplateId(requestedTheme)
      : null
    if (nextTemplate) {
      appearance.applyTemplate(nextTemplate)
    }
    output = buildThemesOutput(
      nextTemplate
        ? useAppearanceStore.getState().template
        : appearance.template,
      Boolean(nextTemplate)
    )
  } else if (
    isSlashCommand(cmd, "language", "language.cycle", "language-cycle")
  ) {
    output = buildLanguageCompatibilityOutput()
  } else if (
    isSlashCommand(
      cmd,
      "terminal-font",
      "font.terminal",
      "terminal.font",
      "appearance.terminal_font"
    )
  ) {
    output = handleTerminalFontCommand(args)
  } else if (isSlashCommand(cmd, "variants", "variant.list", "variant-list")) {
    output = buildVariantsOutput(
      selectedProvider,
      selectedModel,
      readActiveProviderComposerSelection(selectedProvider?.id, threadId)
        ?.optionSelections
    )
  } else if (
    isSlashCommand(
      cmd,
      "variant.cycle",
      "variant-cycle",
      "model.variant.cycle",
      "model-variant-cycle"
    )
  ) {
    output = applyModelVariantCycleCommand({
      threadId,
      provider: selectedProvider,
      selectedModel,
      requestedOptionId: args[0],
    })
  } else if (
    isSlashCommand(
      cmd,
      "catalog",
      "model-catalog",
      "model-info",
      "models",
      "models.list",
      "models-list",
      "catalog.model.list",
      "catalog.model.get",
      "v2.model.list",
      "v2-model-list"
    )
  ) {
    const terminalCommand = buildBetterC0deModelsTerminalCommand(
      args,
      providers
    )
    if (terminalCommand.shouldOpen && terminalCommand.command) {
      dispatchPrefilledTerminalCommand(activeThread, terminalCommand.command)
    }
    output = buildProviderCatalogOutput(providers, args)
  } else if (cmd === "/streaming") {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.enableAssistantStreaming)
    await settings.update({ enable_assistant_streaming: next })
    output = buildToggleOutput("Assistant Streaming", next)
  } else if (
    isSlashCommand(
      cmd,
      "timestamps",
      "toggle-timestamps",
      "toggle.timestamps",
      "session.toggle.timestamps"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showMessageTimestamps)
    await settings.update({ show_message_timestamps: next })
    output = buildToggleOutput("Message Timestamps", next)
  } else if (
    isSlashCommand(
      cmd,
      "thinking",
      "toggle-thinking",
      "toggle.thinking",
      "session.toggle.thinking"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showThinkingBlocks)
    await settings.update({ show_thinking_blocks: next })
    output = buildToggleOutput("Thinking Blocks", next)
  } else if (
    isSlashCommand(
      cmd,
      "reasoning-summaries",
      "reasoning-summary",
      "session.toggle.reasoning_summaries",
      "session-toggle-reasoning-summaries"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showReasoningSummaries)
    await settings.update({ show_reasoning_summaries: next })
    output = buildToggleOutput("Reasoning Summaries", next)
  } else if (
    isSlashCommand(
      cmd,
      "tool-details",
      "actions",
      "toggle-actions",
      "toggle.actions",
      "session.toggle.actions"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showToolDetails)
    await settings.update({ show_tool_details: next })
    output = buildToggleOutput("Tool Details", next)
  } else if (
    isSlashCommand(
      cmd,
      "progress",
      "session-progress",
      "session.toggle.progress_bar",
      "session-toggle-progress-bar"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showSessionProgressBar)
    await settings.update({ show_session_progress_bar: next })
    output = buildToggleOutput("Session Progress", next)
  } else if (
    isSlashCommand(
      cmd,
      "shell-expanded",
      "shell-tool-parts",
      "shell-tool-parts-expanded",
      "session.toggle.shell_tool_parts_expanded"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.shellToolPartsExpanded)
    await settings.update({ shell_tool_parts_expanded: next })
    output = buildToggleOutput("Shell Tool Parts Expanded", next)
  } else if (
    isSlashCommand(
      cmd,
      "edit-expanded",
      "edit-tool-parts",
      "edit-tool-parts-expanded",
      "session.toggle.edit_tool_parts_expanded"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.editToolPartsExpanded)
    await settings.update({ edit_tool_parts_expanded: next })
    output = buildToggleOutput("Edit Tool Parts Expanded", next)
  } else if (
    isSlashCommand(
      cmd,
      "scrollbar",
      "toggle-scrollbar",
      "toggle.scrollbar",
      "session.toggle.scrollbar"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showChatScrollbar)
    await settings.update({ show_chat_scrollbar: next })
    output = buildToggleOutput("Chat Scrollbar", next)
  } else if (
    isSlashCommand(
      cmd,
      "generic-tool-output",
      "generic-output",
      "toggle-generic-tool-output",
      "toggle.generic_tool_output",
      "session.toggle.generic_tool_output"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.showGenericToolOutput)
    await settings.update({ show_generic_tool_output: next })
    output = buildToggleOutput("Generic Tool Output", next)
  } else if (
    isSlashCommand(cmd, "conceal", "toggle-conceal", "session.toggle.conceal")
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.concealCodeBlocks)
    await settings.update({ conceal_code_blocks: next })
    output = buildToggleOutput("Code Concealment", next)
  } else if (isSlashCommand(cmd, "autosave", "auto-save")) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.autoSaveConversations)
    await settings.update({ auto_save_conversations: next })
    output = buildToggleOutput("Auto-save Conversations", next)
  } else if (
    isSlashCommand(
      cmd,
      "diffwrap",
      "wrap",
      "app.toggle.diffwrap",
      "app-toggle-diffwrap"
    )
  ) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(args[0], settings.diffWordWrap)
    await settings.update({ diff_word_wrap: next })
    output = buildToggleOutput("Diff Word Wrap", next)
  } else if (
    isSlashCommand(
      cmd,
      "diff-style",
      "diff_style",
      "diff.style",
      "app.diff_style"
    )
  ) {
    output = await handleDiffStyleCommand(args)
  } else if (isSlashCommand(cmd, "notifications", "notify", "notification")) {
    output = await handleNotificationsCommand(args)
  } else if (isSlashCommand(cmd, "confirmations", "confirm")) {
    const settings = useSettingsStore.getState()
    const next = resolveToggleArg(
      args[0],
      settings.confirmArchive && settings.confirmDelete
    )
    await settings.update({
      confirm_archive: next,
      confirm_delete: next,
    })
    output = buildToggleOutput("Archive/Delete Confirmations", next)
  } else if (
    isSlashCommand(cmd, "autoaccept", "auto-accept", "permissions.autoaccept")
  ) {
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
    await applyPermissionModeLive(nextPermission, selectedProvider, threadId)
    output = buildToggleOutput("Auto Accept", next)
  } else if (
    isSlashCommand(
      cmd,
      "compact",
      "summarize",
      "session.compact",
      "v2.session.compact",
      "v2-session-compact"
    )
  ) {
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
    output = compaction.content
    outputMessageId = compaction.messageId
    outputMessageCreatedAt = compaction.createdAt
    outputMessageCompactionGeneration = compaction.generation
    outputUserMessageId = commandMessage.messageId
    outputUserMessageCreatedAt = commandMessage.createdAt
  } else if (isSlashCommand(cmd, "density", "compact-ui")) {
    const appearance = useAppearanceStore.getState()
    const arg = trimmedText.split(/\s+/)[1]?.toLowerCase()
    const next =
      arg === "on" || arg === "1" || arg === "true"
        ? true
        : arg === "off" || arg === "0" || arg === "false"
          ? false
          : !appearance.compactMode
    appearance.set("compactMode", next)
    output = `# Compact UI\n\n${next ? "Enabled" : "Disabled"}`
  }

  if (!output) {
    const matchedMcp = mcpList.find((m) => cmd === `/${m.id}`)
    if (matchedMcp) {
      output = buildRuntimeMcpDetailOutput(matchedMcp)
    }
    const matchedSkill = skillList.find((s) => cmd === `/${s.id}`)
    if (matchedSkill && !output) {
      output = [
        `# ${matchedSkill.name}\n`,
        "| | |",
        "|:--|:--|",
        "| **Type** | Skill |",
        `| **ID** | \`${matchedSkill.id}\` |`,
        `| **Status** | ${matchedSkill.enabled ? "Enabled" : "Disabled"} |`,
        "",
        matchedSkill.content ? `---\n\n${matchedSkill.content}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    }
    const matchedSubagent = subagentList.find((agent) => cmd === `/${agent.id}`)
    if (matchedSubagent && !output) {
      output = buildRuntimeSubagentDetailOutput(matchedSubagent)
    }
  }

  if (!output) return null
  return {
    handled: true,
    output,
    threadId,
    outputMessageId,
    outputMessageCreatedAt,
    outputMessageCompactionGeneration,
    outputUserMessageId,
    outputUserMessageCreatedAt,
  }
}

function isBetterC0deInternalRouteCommand(command: string): boolean {
  return BETTERC0DE_INTERNAL_ROUTE_COMMANDS.has(command.replace(/^\//, ""))
}

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

function shouldOpenModelPickerForSlashCommand(
  command: string,
  args: readonly string[]
): boolean {
  if (command === "/models" && args.length > 0) return false
  return true
}

export function cycleChatMode(
  currentMode: string | null | undefined,
  direction: 1 | -1
): string {
  const currentIndex = CHAT_MODE_CYCLE.findIndex((mode) => mode === currentMode)
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : CHAT_MODE_CYCLE.length - 1
      : (currentIndex + direction + CHAT_MODE_CYCLE.length) %
        CHAT_MODE_CYCLE.length
  return CHAT_MODE_CYCLE[nextIndex] ?? "agent"
}

function buildChatModeCycleOutput(mode: string): string {
  const label =
    mode === "agent" ? "Agent" : mode[0]!.toUpperCase() + mode.slice(1)
  return `# Chat Mode\n\n${label} mode is active.`
}

export function recordPromptHistory(
  input: string,
  threadId: string | null | undefined,
  activeThread: ActiveThreadRef
): void {
  const prompt = input.trim()
  if (!prompt) return
  const prefs = usePreferencesStore.getState()
  const entry = createPromptHistoryEntry(prompt, {
    projectPath: resolveThreadRuntimePath(activeThread),
    threadId,
  })
  prefs.set(
    "promptHistoryEntries",
    pushPromptHistoryEntry(prefs.promptHistoryEntries, entry)
  )
}

function buildPromptHistoryUseOutput(
  selector: string | undefined,
  threadId: string
): string {
  const resolved = resolvePromptHistoryEntry(
    usePreferencesStore.getState().promptHistoryEntries,
    selector
  )
  if (!resolved) {
    return [
      "# Prompt History",
      "",
      "> No matching prompt history entry found.",
      "",
      "Use `/history` to inspect recorded prompts.",
    ].join("\n")
  }
  dispatchComposerDraftRestoreAfterSubmit({
    text: resolved.entry.input,
    threadId,
  })
  return [
    "# Prompt History",
    "",
    `Restored prompt #${resolved.displayIndex} (\`${resolved.entry.id.slice(0, 8)}\`) into the composer.`,
    "",
    "> History entries are kept after restore; use Prompt Stash if you want pop/remove semantics.",
  ].join("\n")
}

function buildPromptClearOutput(threadId: string): string {
  useChatStore.getState().setDraft(threadId, "")
  dispatchComposerDraftRestoreAfterSubmit({ threadId, text: "" })
  return [
    "# Prompt Clear",
    "",
    "Compatibility reference: `prompt.clear`.",
    "",
    "Cleared the current composer draft.",
  ].join("\n")
}

async function buildPromptPasteOutput(
  threadId: string,
  fallbackText: string
): Promise<string> {
  const explicitText = fallbackText.trim()
  const clipboardText = explicitText || (await readClipboardTextSafely())
  if (!clipboardText) {
    return [
      "# Prompt Paste",
      "",
      "Compatibility reference: `prompt.paste`.",
      "",
      "> Clipboard text was not available. Use the native paste shortcut in the composer, or pass text after the command.",
    ].join("\n")
  }

  useChatStore.getState().setDraft(threadId, clipboardText)
  dispatchComposerDraftRestoreAfterSubmit({ threadId, text: clipboardText })
  return [
    "# Prompt Paste",
    "",
    "Compatibility reference: `prompt.paste`.",
    "",
    `Pasted ${clipboardText.length.toLocaleString()} character${clipboardText.length === 1 ? "" : "s"} into the composer draft.`,
  ].join("\n")
}

function buildPromptSubmitOutput(): string {
  return [
    "# Prompt Submit",
    "",
    "Compatibility reference: `prompt.submit`.",
    "",
    "BetterC0de submits the composer through the native Enter/Send button flow. This command is registered for compatibility command-map parity; put the prompt text in the composer and submit normally.",
  ].join("\n")
}

export function buildComposerInputActionsOutput(command: string): string {
  const normalized = command.replace(/^\//, "")
  const matched =
    normalized === "input-actions"
      ? null
      : findBetterC0deKeybindDefault(normalized)
  const rows =
    matched && matched.command.startsWith("input.")
      ? [matched]
      : BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS.filter((item) =>
          item.command.startsWith("input.")
        )

  return [
    "# Composer Input Actions",
    "",
    matched
      ? `Compatibility reference: \`${escapeInlineCode(matched.command)}\`.`
      : "BetterC0de input command-map actions handled by the BetterC0de composer.",
    "",
    "| Command | Default | BetterC0de Handling | Description |",
    "|:--------|:--------|:--------------------|:------------|",
    ...rows.map(
      (item) =>
        `| \`${escapeMarkdownTableCell(item.command)}\` | ${escapeMarkdownTableCell(item.binding)} | ${escapeMarkdownTableCell(item.handling ?? "Native textarea")} | ${escapeMarkdownTableCell(item.description)} |`
    ),
    "",
    "> These slash aliases are read-only references. To edit text, use the native keyboard shortcut inside the composer.",
  ].join("\n")
}

async function readClipboardTextSafely(): Promise<string | null> {
  if (typeof navigator === "undefined") return null
  if (!navigator.clipboard?.readText) return null
  try {
    const text = await navigator.clipboard.readText()
    return text.trim() ? text : null
  } catch {
    return null
  }
}

function buildPromptStashPushOutput(
  input: string,
  threadId: string | null | undefined,
  activeThread: ActiveThreadRef
): string {
  const prompt = input.trim()
  if (!prompt) {
    return [
      "# Prompt Stash",
      "",
      "> No prompt text provided.",
      "",
      "Use `/stash <prompt>` to save text, `/stashes` to list saved prompts, and `/stash-pop` to restore the latest one into the composer.",
    ].join("\n")
  }
  const prefs = usePreferencesStore.getState()
  const entry = createPromptStashEntry(prompt, {
    projectPath: resolveThreadRuntimePath(activeThread),
    threadId,
  })
  prefs.set(
    "promptStashEntries",
    pushPromptStashEntry(prefs.promptStashEntries, entry)
  )
  return [
    "# Prompt Stash",
    "",
    `Saved prompt \`${entry.id.slice(0, 8)}\`.`,
    "",
    "> Use `/stash-pop` to restore the newest stashed prompt.",
  ].join("\n")
}

function resolveQuickSwitchSlot(
  command: string,
  argument?: string
): number | null {
  const commandMatch = /^\/session\.quick_switch\.([1-9])$/.exec(command)
  if (commandMatch?.[1]) return Number(commandMatch[1])
  if (!isSlashCommand(command, "quick-switch")) return null
  const slot = Number(argument)
  return Number.isInteger(slot) && slot >= 1 && slot <= 9 ? slot : null
}

type ChatMessageScrollTarget =
  | "first"
  | "last"
  | "last-user"
  | "next"
  | "previous"
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "line-up"
  | "line-down"

function dispatchChatMessageScroll(
  target: ChatMessageScrollTarget,
  threadId: string | null
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent("betterc0de:chat-scroll-message", {
      detail: { target, threadId },
    })
  )
}

function focusChatComposerInput(threadId: string | null): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const input = findComposerTextarea(threadId)
  window.setTimeout(() => {
    if (input?.isConnected) input.focus()
  }, 0)
}

export function buildBetterC0dePrTerminalCommand(text: string): {
  command: string
  shouldOpen: boolean
} {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return { command: "", shouldOpen: false }
  const command = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ""
  if (
    !isSlashCommand(
      command,
      "pr",
      "pull-request",
      "gh-pr",
      "github.pr",
      "github-pr"
    )
  ) {
    return { command: "", shouldOpen: false }
  }
  const args = trimmed.slice(command.length).trim().split(/\s+/).filter(Boolean)
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const prNumber = extractBetterC0dePrNumber(cleanArgs)
  return {
    command: [
      "betterc0de pr",
      stringifyCliArgs(prNumber ? [prNumber] : cleanArgs),
    ]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function extractBetterC0dePrNumber(args: ReadonlyArray<string>): string | null {
  const target = args.find((arg) => arg && !arg.startsWith("-")) ?? ""
  if (!target) return null
  const urlMatch = /\/pull\/(\d+)(?:[/?#]|$)/i.exec(target)
  if (urlMatch?.[1]) return urlMatch[1]
  const hashMatch = /^#?(\d+)$/.exec(target.trim())
  return hashMatch?.[1] ?? null
}

export async function listProjectReferencesSafe(
  runtimePath?: string | null
): Promise<WorkspaceProjectReference[]> {
  if (!runtimePath) return []
  try {
    return await listProjectReferences(runtimePath)
  } catch {
    return []
  }
}

function mergeRuntimeMcps(
  primary: ReadonlyArray<RuntimeMcpServer>,
  additions: ReadonlyArray<RuntimeMcpServer>
): RuntimeMcpServer[] {
  if (additions.length === 0) return [...primary]
  const mergedById = new Map(primary.map((mcp) => [mcp.id, mcp]))
  for (const mcp of additions) {
    mergedById.set(mcp.id, mcp)
  }
  return Array.from(mergedById.values())
}

function shareCommandHelpRows(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>
): string[] {
  if (betterC0deShareModeFromProjectSettings(settings) === "disabled") return []
  return [
    "| `/share` | Copy a local markdown export of this chat |",
    "| `/unshare` | Remove this chat's local share marker |",
  ]
}

function buildUnshareThreadOutput(threadId: string | null): string {
  if (!threadId) {
    return "# Unshare Session\n\n> No active chat to unshare."
  }
  const existing = getThreadShare(threadId)
  if (!existing) {
    return "# Unshare Session\n\n> This chat has no local share marker."
  }
  clearThreadShare(threadId)
  return [
    "# Unshare Session\n",
    "Removed this chat's local share marker.",
    "",
    `Previous export fingerprint: \`${existing.transcriptFingerprint}\``,
  ].join("\n")
}

const SETTINGS_TAB_BY_COMMAND = new Map<string, SettingsTabId>([
  ["/settings", "general"],
  ["/preferences", "general"],
  ["/settings.open", "general"],
  ["/settings-open", "general"],
  ["/providers", "models"],
  ["/appearance", "appearance"],
  ["/rules", "rules"],
  ["/skills-settings", "skills"],
  ["/tools", "tools"],
  ["/mcp-settings", "tools"],
  ["/hooks", "hooks"],
  ["/plugins", "plugins"],
  ["/plugins.list", "plugins"],
  ["/plugins-list", "plugins"],
  ["/betterc0de-settings", "betterc0de"],
  ["/betterc0de-settings", "betterc0de"],
])

const SETTINGS_TAB_BY_ARG = new Map<string, SettingsTabId>([
  ["general", "general"],
  ["appearance", "appearance"],
  ["providers", "models"],
  ["provider", "models"],
  ["models", "models"],
  ["plugins", "plugins"],
  ["rules", "rules"],
  ["skills", "skills"],
  ["agents", "skills"],
  ["subagents", "skills"],
  ["tools", "tools"],
  ["mcp", "tools"],
  ["mcps", "tools"],
  ["hooks", "hooks"],
  ["remote", "remote"],
  ["remote-access", "remote"],
  ["betterc0de", "betterc0de"],
  ["betterc0de", "betterc0de"],
  ["project", "betterc0de"],
  ["project-config", "betterc0de"],
  ["docs", "docs"],
  ["help", "docs"],
])

function resolveSettingsTabCommand(
  command: string,
  arg?: string
): SettingsTabId | null {
  const direct = SETTINGS_TAB_BY_COMMAND.get(command)
  if (!direct) return null
  if (command === "/settings" || command === "/preferences") {
    return SETTINGS_TAB_BY_ARG.get(arg?.toLowerCase() ?? "") ?? direct
  }
  return direct
}

function settingsTabLabel(tab: SettingsTabId): string {
  switch (tab) {
    case "models":
      return "Providers"
    case "tools":
      return "Tools & MCP"
    case "skills":
      return "Skills & Subagents"
    case "betterc0de":
      return "Compatibility"
    case "remote":
      return "Remote Access"
    default:
      return tab.charAt(0).toUpperCase() + tab.slice(1)
  }
}

export function stripModeSlashPrompt(
  text: string,
  mode: string | null
): string {
  if (mode === "plan") return text.replace(/^\/plan\b\s*/i, "").trim()
  if (mode === "ask") return text.replace(/^\/ask\b\s*/i, "").trim()
  if (mode === "security") {
    return text.replace(/^\/security\b\s*/i, "").trim()
  }
  if (mode === "debug") return text.replace(/^\/debug\b\s*/i, "").trim()
  return text
}

export function defaultPromptForMode(mode: string | null): string {
  if (mode === "plan") {
    return "Create an actionable implementation plan for this task."
  }
  if (mode === "ask") {
    return "Answer the user's question using read-only analysis. Do not edit files or run mutating commands."
  }
  if (mode === "security") {
    return "Review the current workspace for security-relevant risks and ask before any mutating or executable action."
  }
  if (mode === "debug") {
    return "Debug the current issue with focused investigation, evidence, minimal changes, and verification."
  }
  return ""
}

function buildToggleOutput(label: string, enabled: boolean): string {
  return `# ${label}\n\n${enabled ? "Enabled" : "Disabled"}`
}

type BetterC0deMcpSlashSubcommand =
  | "add"
  | "auth"
  | "logout"
  | "debug"
  | "list"
  | "resources"

function betterC0deMcpSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deMcpSlashSubcommand | null {
  if (!isSlashCommand(command, "mcp")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "add":
    case "install":
      return "add"
    case "auth":
    case "authenticate":
      return "auth"
    case "logout":
    case "remove":
      return "logout"
    case "debug":
    case "inspect":
      return "debug"
    case "list":
    case "ls":
    case "status":
      return "list"
    case "resource":
    case "resources":
      return "resources"
    default:
      return null
  }
}

function isBetterC0deMcpSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deMcpSlashSubcommand
): boolean {
  return betterC0deMcpSlashSubcommand(command, args) === mode
}

function scheduleWindowCloseFromChat(): void {
  if (typeof window === "undefined") return
  window.setTimeout(() => {
    void window.electronAPI?.windowClose?.()
  }, 100)
}

export function parseSessionListOptions(
  args: readonly string[]
): SessionListOptions {
  const options: SessionListOptions = { format: "table" }
  const nextValue = (index: number): string | undefined => {
    const value = args[index + 1]
    return value && !value.startsWith("-") ? value.trim() : undefined
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]?.trim()
    if (!arg) continue
    const normalized = arg.toLowerCase()
    if (normalized === "--json") {
      options.format = "json"
      continue
    }
    if (normalized === "--format" && args[index + 1]) {
      const format = args[index + 1].trim().toLowerCase()
      if (format === "json" || format === "table") options.format = format
      index += 1
      continue
    }
    if (normalized.startsWith("--format=")) {
      const format = normalized.slice("--format=".length)
      if (format === "json" || format === "table") options.format = format
      continue
    }
    if (normalized === "--order" && args[index + 1]) {
      const order = args[index + 1].trim().toLowerCase()
      if (order === "asc" || order === "desc") options.order = order
      index += 1
      continue
    }
    if (normalized.startsWith("--order=")) {
      const order = normalized.slice("--order=".length)
      if (order === "asc" || order === "desc") options.order = order
      continue
    }
    if (normalized === "--search" || normalized === "--query") {
      const value = nextValue(index)
      if (value) {
        options.search = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--search=")) {
      options.search = arg.slice("--search=".length).trim()
      continue
    }
    if (normalized.startsWith("--query=")) {
      options.search = arg.slice("--query=".length).trim()
      continue
    }
    if (normalized === "--path" || normalized === "--directory") {
      const value = nextValue(index)
      if (value) {
        options.path = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--path=")) {
      options.path = arg.slice("--path=".length).trim()
      continue
    }
    if (normalized.startsWith("--directory=")) {
      options.path = arg.slice("--directory=".length).trim()
      continue
    }
    if (normalized === "--roots") {
      const value = nextValue(index)
      if (value && ["true", "false"].includes(value.toLowerCase())) {
        options.roots = value.toLowerCase() === "true"
        index += 1
      } else {
        options.roots = true
      }
      continue
    }
    if (normalized.startsWith("--roots=")) {
      const value = normalized.slice("--roots=".length)
      if (value === "true" || value === "false")
        options.roots = value === "true"
      continue
    }
    if (normalized === "--start") {
      const value = nextValue(index)
      const parsed = value ? Number(value) : NaN
      if (Number.isFinite(parsed)) {
        options.start = parsed
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--start=")) {
      const parsed = Number(normalized.slice("--start=".length))
      if (Number.isFinite(parsed)) options.start = parsed
      continue
    }
    if (normalized === "--cursor" && args[index + 1]) {
      options.cursor = args[index + 1].trim()
      index += 1
      continue
    }
    if (normalized.startsWith("--cursor=")) {
      options.cursor = arg.slice("--cursor=".length).trim()
      continue
    }
    if (
      (normalized === "--max-count" ||
        normalized === "--limit" ||
        normalized === "-n") &&
      args[index + 1]
    ) {
      const parsed = Number(args[index + 1])
      if (Number.isFinite(parsed)) {
        options.maxCount = Math.max(1, Math.min(500, Math.round(parsed)))
      }
      index += 1
      continue
    }
    if (
      normalized.startsWith("--max-count=") ||
      normalized.startsWith("--limit=")
    ) {
      const [, rawValue] = normalized.split("=", 2)
      const parsed = Number(rawValue)
      if (Number.isFinite(parsed)) {
        options.maxCount = Math.max(1, Math.min(500, Math.round(parsed)))
      }
    }
  }
  return options
}

export async function buildProjectFormatOutput(
  args: string[],
  formatters: ReadonlyArray<WorkspaceProjectFormatter>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Format File\n\n> No workspace folder is open."
  }
  if (args.length === 0) {
    return [
      "# Format File\n",
      "> Usage: `/format <relative-file> [formatter] [--dry-run|--terminal]`",
      "",
      "Run `/formatters` to see configured BetterC0de formatter IDs.",
    ].join("\n")
  }

  const requestedFlags = parseProjectFormatFlags(args)
  const { relativePath, formatterId } = parseProjectFormatArgs(
    requestedFlags.args,
    formatters
  )
  if (!relativePath) {
    return [
      "# Format File\n",
      "> Usage: `/format <relative-file> [formatter] [--dry-run|--terminal]`",
    ].join("\n")
  }
  if (requestedFlags.dryRun || requestedFlags.terminal) {
    return buildProjectFormatPreviewOutput({
      formatters,
      formatterId,
      relativePath,
      runtimePath,
      terminal: requestedFlags.terminal,
    })
  }

  try {
    const result = await formatProjectFile(
      runtimePath,
      relativePath,
      formatterId
    )
    return buildProjectFormatResultOutput(result, runtimePath)
  } catch (error) {
    return [
      "# Format File\n",
      `> Failed to run formatter for \`${escapeInlineCode(relativePath)}\`.`,
      "",
      error instanceof Error ? error.message : String(error),
    ].join("\n")
  }
}

function buildProjectFormatResultOutput(
  result: WorkspaceProjectFormatResult,
  runtimePath: string
): string {
  if (result.results.length === 0) {
    return [
      "# Format File\n",
      `**${escapeMarkdownTableCell(result.file)}** in \`${escapeInlineCode(runtimePath)}\``,
      "",
      `> ${result.skippedReason ?? "No formatter was run."}`,
    ].join("\n")
  }

  return [
    "# Format File\n",
    `**${escapeMarkdownTableCell(result.file)}** in \`${escapeInlineCode(runtimePath)}\``,
    "",
    "| Formatter | Command | Status | Output |",
    "|:----------|:--------|:-------|:-------|",
    ...result.results.map((run) => {
      const status = run.skippedReason
        ? "Skipped"
        : run.success
          ? "Formatted"
          : run.timedOut
            ? "Timed out"
            : `Failed (${run.exitCode ?? "spawn"})`
      const output =
        run.skippedReason ??
        firstNonEmptyLine(run.stderr) ??
        firstNonEmptyLine(run.stdout) ??
        "-"
      return `| **${escapeMarkdownTableCell(run.name)}** | \`${escapeMarkdownTableCell(formatCommand(run.command, run.args, false))}\` | ${escapeMarkdownTableCell(status)} | ${escapeMarkdownTableCell(output)} |`
    }),
  ].join("\n")
}

function buildProjectFormattersOutput(
  formatters: ReadonlyArray<WorkspaceProjectFormatter>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Formatters\n\n> No workspace folder is open."
  }
  if (formatters.length === 0) {
    return [
      "# Project Formatters\n",
      "> No BetterC0de formatter config found.",
      "",
      "Add a `formatter` object to `betterc0de.json` or `betterc0de.jsonc` to document project formatters.",
      'Use `/formatters --config-only <id> --command "prettier --write $FILE" --ext .ts,.tsx` to write one from chat.',
    ].join("\n")
  }

  return [
    "# Project Formatters\n",
    `${formatters.length} formatter${formatters.length > 1 ? "s" : ""} configured in \`${runtimePath}\`\n`,
    "| Formatter | Extensions | Command | Source | Status |",
    "|:----------|:-----------|:--------|:-------|:-------|",
    ...formatters.map(
      (formatter) =>
        `| **${escapeMarkdownTableCell(formatter.name)}** | ${escapeMarkdownTableCell(formatList(formatter.extensions))} | \`${escapeMarkdownTableCell(formatCommand(formatter.command, formatter.args, formatter.builtin))}\` | \`${escapeMarkdownTableCell(formatter.sourcePath)}\` | ${escapeMarkdownTableCell(formatProjectFormatterStatus(formatter))} |`
    ),
    "",
    "> Use `/format <relative-file> [formatter]` to run a configured formatter explicitly, or add `--dry-run` / `--terminal` to preview the resolved command without changing files. Add `/formatters --config-only ...` to write a formatter entry.",
  ].join("\n")
}

function formatProjectFormatterStatus(
  formatter: WorkspaceProjectFormatter
): string {
  if (!formatter.enabled) return "Disabled"
  if (formatter.available === false) return "Unavailable"
  if (formatter.available === true) return "Available"
  return "Enabled"
}

export function buildProjectLspServersOutput(
  servers: ReadonlyArray<WorkspaceProjectLspServer>,
  activeThread: ActiveThreadRef,
  command = "/lsp",
  args: ReadonlyArray<string> = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const debugIntent = resolveProjectLspDebugIntent(
    command,
    stripBetterC0deRuntimeUiFlags(args)
  )
  if (debugIntent) {
    return buildProjectLspDebugOutput(servers, activeThread, {
      ...debugIntent,
      terminalRequested: args.some(isBetterC0deRuntimeTerminalFlag),
    })
  }
  if (!runtimePath) {
    return "# Project LSP Servers\n\n> No workspace folder is open."
  }
  if (servers.length === 0) {
    return [
      "# Project LSP Servers\n",
      "> No BetterC0de LSP config found.",
      "",
      "Add an `lsp` object to `betterc0de.json` or `betterc0de.jsonc` to document project language servers.",
      'Use `/lsp --config-only <id> --command "typescript-language-server --stdio" --ext .ts,.tsx` to write one from chat.',
    ].join("\n")
  }

  return [
    "# Project LSP Servers\n",
    `${servers.length} server${servers.length > 1 ? "s" : ""} configured in \`${runtimePath}\`\n`,
    "| Server | Extensions | Command | Init | Source | Status |",
    "|:-------|:-----------|:--------|:-----|:-------|:-------|",
    ...servers.map(
      (server) =>
        `| **${escapeMarkdownTableCell(server.name)}** | ${escapeMarkdownTableCell(formatList(server.extensions))} | \`${escapeMarkdownTableCell(formatCommand(server.command, server.args, server.builtin))}\` | ${escapeMarkdownTableCell(formatObjectKeys(server.initialization))} | \`${escapeMarkdownTableCell(server.sourcePath)}\` | ${server.enabled ? "Enabled" : "Disabled"} |`
    ),
    "",
    "> This is BetterC0de compatibility project metadata. Use `/lsp diagnostics <file> [--json]`, `/lsp symbols <query> [--json]`, or `/lsp document-symbols <uri> [--json]` for BetterC0de debug guidance and local JSON previews. Add `/lsp --config-only ...` to write an LSP entry.",
  ].join("\n")
}

function buildProjectLspTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const intent = resolveProjectLspDebugIntent(
    command,
    stripBetterC0deRuntimeUiFlags(args)
  )
  if (!intent) return { command: "", shouldOpen: false }
  const placeholder =
    intent.kind === "diagnostics"
      ? "<file>"
      : intent.kind === "symbols"
        ? "<query>"
        : "<uri>"
  const target = intent.target || placeholder
  return {
    command: `betterc0de debug lsp ${intent.kind} ${stringifyCliArgs([target])}`,
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function resolveProjectLspDebugIntent(
  command: string,
  args: ReadonlyArray<string>
): ProjectLspDebugIntent | null {
  const normalizedCommand = command.replace(/^\//, "")
  const commandKind = lspDebugKindFromToken(normalizedCommand)
  const parsedArgs = parseProjectLspDebugArgs(args)
  if (commandKind) {
    return {
      kind: commandKind,
      target: parsedArgs.args.join(" ").trim() || undefined,
      outputJson: parsedArgs.outputJson,
    }
  }

  const [head, ...rest] = parsedArgs.args
  const argsKind = lspDebugKindFromToken(head ?? "")
  if (!argsKind) return null
  return {
    kind: argsKind,
    target: rest.join(" ").trim() || undefined,
    outputJson: parsedArgs.outputJson,
  }
}

function parseProjectLspDebugArgs(args: ReadonlyArray<string>): {
  args: string[]
  outputJson: boolean
} {
  const cleanArgs: string[] = []
  let outputJson = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    const normalized = arg.trim().toLowerCase()
    if (normalized === "--json" || normalized === "--format=json") {
      outputJson = true
      continue
    }
    if (normalized === "--format" && args[index + 1]) {
      const format = args[index + 1]!.trim().toLowerCase()
      if (format === "json") {
        outputJson = true
        index += 1
        continue
      }
    }
    cleanArgs.push(arg)
  }
  return { args: cleanArgs, outputJson }
}

function lspDebugKindFromToken(value: string): ProjectLspDebugKind | null {
  const normalized = value.toLowerCase().replace(/_/g, "-")
  if (
    normalized === "diagnostics" ||
    normalized === "debug.lsp.diagnostics" ||
    normalized === "debug-lsp-diagnostics"
  ) {
    return "diagnostics"
  }
  if (
    normalized === "symbols" ||
    normalized === "debug.lsp.symbols" ||
    normalized === "debug-lsp-symbols"
  ) {
    return "symbols"
  }
  if (
    normalized === "document-symbols" ||
    normalized === "documentsymbols" ||
    normalized === "debug.lsp.document-symbols" ||
    normalized === "debug-lsp-document-symbols"
  ) {
    return "document-symbols"
  }
  return null
}

function buildProjectConfigGroupOutput(input: {
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>
  activeThread: ActiveThreadRef
  heading: string
  emptyTitle: string
  emptyMessage: string
  match: (key: string) => boolean
}): string {
  const runtimePath = resolveThreadRuntimePath(input.activeThread)
  if (!runtimePath) {
    return `# ${input.emptyTitle}\n\n> No workspace folder is open.`
  }
  const rows = input.settings.filter((setting) => input.match(setting.key))
  if (rows.length === 0) {
    return [`# ${input.emptyTitle}\n`, `> ${input.emptyMessage}`].join("\n")
  }

  return [
    `# ${input.heading}\n`,
    `${rows.length} setting${rows.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`.\n`,
    "| Setting | Kind | Value | Source |",
    "|:--------|:-----|:------|:-------|",
    ...rows.map(
      (setting) =>
        `| **${escapeMarkdownTableCell(setting.label)}** (\`${escapeMarkdownTableCell(setting.key)}\`) | ${setting.kind} | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
    ),
  ].join("\n")
}

export function buildProviderOrganizationOutput(
  command = "/org",
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deAccountTerminalCommand(command, args)
  const validation = buildBetterC0deAccountValidationMessages(command, args)
  return [
    "# Organization\n",
    "Opened provider settings. BetterC0de keeps OAuth account, CLI auth, and provider organization controls with each provider.",
    "",
    "## Compatibility references",
    "",
    "| Compatibility CLI | BetterC0de |",
    "|:---------|:-----------|",
    "| `betterc0de console orgs` | `/console.orgs`, `/account.orgs`, or `/orgs` |",
    "| `betterc0de console switch` | `/console.switch`, `/console.org.switch`, or `/switch-org` |",
    "| `console.org.switch` TUI action | `/console.org.switch` |",
    "",
    validation.length > 0
      ? [
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
          "",
        ].join("\n")
      : "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this command prefilled.",
        ].join("\n")
      : "> Add `--terminal` to prefill `betterc0de console orgs` or `betterc0de console switch` in the integrated terminal.",
    "",
    "> Console org data is surfaced through provider settings and uses metadata-only display; BetterC0de does not print account tokens or credential values into chat.",
  ].join("\n")
}

type BetterC0deProviderSlashSubcommand = "login" | "list" | "logout"

function betterC0deProviderSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deProviderSlashSubcommand | null {
  if (!isSlashCommand(command, "providers", "auth")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "login":
    case "connect":
      return "login"
    case "list":
    case "ls":
      return "list"
    case "logout":
    case "remove":
      return "logout"
    default:
      return null
  }
}

function isBetterC0deProviderSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deProviderSlashSubcommand
): boolean {
  return betterC0deProviderSlashSubcommand(command, args) === mode
}

export function stripBetterC0deProviderSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    !["login", "connect", "list", "ls", "logout", "remove"].includes(
      first ?? ""
    )
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deConsoleSlashSubcommand =
  | "login"
  | "logout"
  | "switch"
  | "orgs"
  | "open"

function betterC0deConsoleSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deConsoleSlashSubcommand | null {
  if (!isSlashCommand(command, "console", "account")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "login":
      return "login"
    case "logout":
      return "logout"
    case "switch":
    case "org.switch":
    case "org-switch":
      return "switch"
    case "org":
    case "orgs":
    case "organizations":
      return "orgs"
    case "open":
      return "open"
    default:
      return null
  }
}

function isBetterC0deConsoleSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deConsoleSlashSubcommand
): boolean {
  return betterC0deConsoleSlashSubcommand(command, args) === mode
}

export function stripBetterC0deConsoleSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    ![
      "login",
      "logout",
      "switch",
      "org.switch",
      "org-switch",
      "org",
      "orgs",
      "organizations",
      "open",
    ].includes(first ?? "")
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

function buildBetterC0deAccountTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("switch") || normalized.includes("org.switch")
      ? "switch"
      : normalized.includes("open")
        ? "open"
        : "orgs"
  return {
    command: ["betterc0de console", mode].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deAccountValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  if (cleanArgs.length === 0) return []
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("switch") || normalized.includes("org.switch")
      ? "switch"
      : normalized.includes("open")
        ? "open"
        : "orgs"
  return [
    `Compatibility console ${mode} does not accept arguments; it uses the active account state.`,
  ]
}

function buildSystemStatusOutput(input: {
  mcpList: RuntimeMcpServer[]
  skillList: RuntimeSkill[]
  subagentList: RuntimeSubagent[]
  selectedProvider: UiProvider | undefined
  selectedModel: string
  chatMode: string
  permissionLevel: string
  activeThread: ActiveThreadRef
}): string {
  const settings = useSettingsStore.getState()
  const appearance = useAppearanceStore.getState()
  const provider = input.selectedProvider
  const providerStatus =
    provider?.configured === false
      ? "Needs setup"
      : provider?.status === "ready" || provider?.configured === true
        ? "Ready"
        : "Unknown"

  return [
    "# System Status\n",
    "| Runtime | Value |",
    "|:--------|:------|",
    `| **Mode** | \`${input.chatMode}\` |`,
    `| **Permission** | \`${input.permissionLevel}\` |`,
    `| **Provider** | ${provider ? escapeMarkdownTableCell(provider.name) : "None"} |`,
    `| **Provider Status** | ${providerStatus} |`,
    `| **Model** | \`${input.selectedModel}\` |`,
    `| **Project** | ${escapeMarkdownTableCell(input.activeThread?.projectPath || input.activeThread?.worktreePath || "No folder")} |`,
    "",
    "| Component | Installed | Active |",
    "|:----------|----------:|-------:|",
    `| **MCP Servers** | ${input.mcpList.length} | ${input.mcpList.filter((m) => m.enabled).length} |`,
    `| **Skills** | ${input.skillList.length} | ${input.skillList.filter((s) => s.enabled).length} |`,
    `| **Subagents** | ${input.subagentList.length} | ${input.subagentList.filter((agent) => agent.enabled).length} |`,
    "",
    "| Behavior | State |",
    "|:---------|:------|",
    `| **Assistant Streaming** | ${settings.enableAssistantStreaming ? "On" : "Off"} |`,
    `| **Session Progress** | ${settings.showSessionProgressBar ? "On" : "Off"} |`,
    `| **Reasoning Summaries** | ${settings.showReasoningSummaries ? "On" : "Off"} |`,
    `| **Shell Tool Parts Expanded** | ${settings.shellToolPartsExpanded ? "On" : "Off"} |`,
    `| **Edit Tool Parts Expanded** | ${settings.editToolPartsExpanded ? "On" : "Off"} |`,
    `| **Auto-save Conversations** | ${settings.autoSaveConversations ? "On" : "Off"} |`,
    `| **Diff Word Wrap** | ${settings.diffWordWrap ? "On" : "Off"} |`,
    `| **Diff Style** | \`${settings.diffStyle}\` |`,
    `| **Notifications** | Agent ${settings.notificationAgent ? "On" : "Off"}, Permissions ${settings.notificationPermissions ? "On" : "Off"}, Errors ${settings.notificationErrors ? "On" : "Off"} |`,
    `| **Compact Chat** | ${appearance.compactMode ? "On" : "Off"} |`,
    `| **Theme Mode Lock** | ${appearance.themeModeLocked ? "On" : "Off"} |`,
    `| **Animations** | ${appearance.animationsEnabled ? "On" : "Off"} |`,
    `| **File Context** | ${appearance.fileContextEnabled ? "On" : "Off"} |`,
    `| **Session Directory Filter** | ${appearance.sessionDirectoryFilterEnabled ? "On" : "Off"} |`,
    `| **Terminal Titles** | ${appearance.terminalTitleEnabled ? "On" : "Off"} |`,
    "",
    "> Use `/mcps`, `/skills`, `/agents`, `/connect`, or `/settings providers` for details.",
  ].join("\n")
}

type BetterC0deGithubSlashSubcommand = "install" | "run"

function betterC0deGithubSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deGithubSlashSubcommand | null {
  if (!isSlashCommand(command, "github", "github-agent")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "install":
      return "install"
    case "run":
      return "run"
    default:
      return null
  }
}

export function stripBetterC0deGithubSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (!["install", "run"].includes(first ?? "")) return [...args]
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deAgentSlashSubcommand = "list" | "create" | "debug"

function betterC0deAgentSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deAgentSlashSubcommand | null {
  if (!isSlashCommand(command, "agent")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "list":
    case "ls":
      return "list"
    case "create":
    case "new":
      return "create"
    case "debug":
    case "inspect":
      return "debug"
    default:
      return null
  }
}

function isBetterC0deAgentSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deAgentSlashSubcommand
): boolean {
  return betterC0deAgentSlashSubcommand(command, args) === mode
}

export function stripBetterC0deAgentSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    !["list", "ls", "create", "new", "debug", "inspect"].includes(first ?? "")
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

export function buildRuntimeSubagentListOutput(
  subagents: ReadonlyArray<RuntimeSubagent>,
  terminalCommand?: string
): string {
  const body =
    subagents.length === 0
      ? [
          "# Subagents",
          "",
          "> No subagents configured yet.",
          ">",
          "> Open **Settings > Skills & Subagents** to create or import one.",
        ].join("\n")
      : [
          "# Subagents\n",
          `${subagents.length} subagent${subagents.length > 1 ? "s" : ""} configured\n`,
          "| # | Subagent | Command | Source | Mode | Model | Status |",
          "|:--|:---------|:--------|:-------|:-----|:------|:-------|",
          ...subagents.map(
            (agent, i) =>
              `| ${i + 1} | **${escapeMarkdownTableCell(agent.name)}** | \`/${escapeMarkdownTableCell(agent.id)}\` | ${escapeMarkdownTableCell(agent.sourcePath || agent.source || "local")} | ${escapeMarkdownTableCell(agent.mode ?? "-")} | ${escapeMarkdownTableCell(agent.model ?? "-")} | ${formatSubagentStatus(agent)} |`
          ),
          "",
          "> Type `/<subagent-id>` for details, `/debug.agent <subagent-id>` for BetterC0de-compatible details, or `@<subagent-id>` to inject the subagent prompt into your message.",
        ].join("\n")

  return [
    body,
    terminalCommand
      ? [
          "",
          buildMcpTerminalSection(terminalCommand),
          "",
          "> Opened the terminal panel with this BetterC0de agent command prefilled.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function resolveRuntimeSubagent(
  subagents: ReadonlyArray<RuntimeSubagent>,
  query: string
): RuntimeSubagent | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null
  return (
    subagents.find(
      (agent) =>
        agent.id.toLowerCase() === normalized ||
        agent.name.toLowerCase() === normalized
    ) ??
    subagents.find(
      (agent) =>
        agent.id.toLowerCase().includes(normalized) ||
        agent.name.toLowerCase().includes(normalized)
    ) ??
    null
  )
}

function buildSubagentNotFoundOutput(
  query: string,
  subagents: ReadonlyArray<RuntimeSubagent>
): string {
  const known = subagents.map((agent) => `\`${agent.id}\``).join(", ")
  return [
    "# Subagents",
    "",
    `> No subagent matched \`${escapeInlineCode(query)}\`.`,
    known ? `\nKnown subagent IDs: ${known}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deRuntimeTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("attach") || normalized === "attach"
      ? "attach"
      : normalized.includes("serve")
        ? "serve"
        : normalized.includes("web")
          ? "web"
          : normalized.includes("acp") || normalized === "acp"
            ? "acp"
            : normalized.includes("tui") ||
                normalized.includes("thread") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui")
              ? ""
              : "run"
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  return {
    command: ["betterc0de", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function isPositiveIntegerString(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
}

function buildBetterC0deMaintenanceTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode = normalized.includes("uninstall")
    ? "uninstall"
    : normalized.includes("completion")
      ? "completion"
      : normalized.includes("generate") || normalized.includes("openapi")
        ? "generate"
        : normalized.includes("db")
          ? "db"
          : "upgrade"
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  return {
    command: ["betterc0de", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function betterC0deSessionCliMode(
  command: string,
  args: ReadonlyArray<string>
): "delete" | "list" {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const first = args.find((arg) => !arg.startsWith("-"))?.toLowerCase()
  if (normalized.includes("delete") || first === "delete") return "delete"
  return "list"
}

function buildBetterC0deSessionCliArgs(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const first = cleanArgs.find((arg) => !arg.startsWith("-"))?.toLowerCase()
  const mode = betterC0deSessionCliMode(command, cleanArgs)
  if (first === "list" || first === "delete") return cleanArgs
  return [mode, ...cleanArgs]
}

function buildBetterC0deSessionCliTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const cliArgs = stringifyCliArgs(buildBetterC0deSessionCliArgs(command, args))
  return {
    command: ["betterc0de session", cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

type BetterC0deSessionSlashSubcommand = "list" | "delete"

function betterC0deSessionSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deSessionSlashSubcommand | null {
  if (!isSlashCommand(command, "session")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "list":
    case "ls":
      return "list"
    case "delete":
    case "remove":
    case "rm":
      return "delete"
    default:
      return null
  }
}

function isBetterC0deSessionSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deSessionSlashSubcommand
): boolean {
  return betterC0deSessionSlashSubcommand(command, args) === mode
}

export function stripBetterC0deSessionSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (!["list", "ls", "delete", "remove", "rm"].includes(first ?? "")) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

function buildBetterC0deSessionCliValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const mode = betterC0deSessionCliMode(command, cleanArgs)
  const messages = maintenanceMissingValueMessages(cleanArgs, [
    "--format",
    "--max-count",
    "-n",
  ])

  if (mode === "delete") {
    if (!firstBetterC0deSessionDeleteId(command, cleanArgs)) {
      messages.push("BetterC0de session delete requires a session ID.")
    }
    return messages
  }

  const format = betterC0deSessionCliOptionValue(cleanArgs, "--format")
  if (format !== undefined) {
    if (!format.trim()) {
      pushUnique(messages, "--format requires a value.")
    } else if (!["table", "json"].includes(format.toLowerCase())) {
      messages.push("`--format` must be `table` or `json`.")
    }
  }

  const maxCount = betterC0deSessionCliOptionValue(
    cleanArgs,
    "--max-count",
    "-n"
  )
  if (maxCount !== undefined) {
    if (!maxCount.trim()) {
      pushUnique(messages, "--max-count requires a value.")
    } else if (!isPositiveIntegerString(maxCount)) {
      messages.push("`--max-count` must be a positive integer.")
    }
  }

  return messages
}

function betterC0deSessionCliOptionValue(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") break
    if (names.includes(arg)) {
      const value = args[index + 1]
      return value && !value.startsWith("-") ? value : ""
    }
    for (const name of names) {
      const prefix = `${name}=`
      if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    }
  }
  return undefined
}

function firstBetterC0deSessionDeleteId(
  command: string,
  args: ReadonlyArray<string>
): string | undefined {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const commandImpliesDelete = normalized.includes("delete")
  const optionsWithValues = new Set(["--format", "--max-count", "-n"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") {
      return args.slice(index + 1).find((item) => item.trim().length > 0)
    }
    if (arg === "delete" && !commandImpliesDelete) continue
    if (
      Array.from(optionsWithValues).some((option) =>
        arg.startsWith(`${option}=`)
      )
    ) {
      continue
    }
    if (optionsWithValues.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith("-")) continue
    if (arg.trim().length > 0) return arg
  }
  return undefined
}

function pushUnique(messages: string[], message: string): void {
  if (!messages.includes(message)) messages.push(message)
}

export function buildBetterC0deSessionCliOutput(
  command: string,
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): string {
  const mode = betterC0deSessionCliMode(command, args)
  const cliArgs = stringifyCliArgs(buildBetterC0deSessionCliArgs(command, args))
  const cliCommand = ["betterc0de session", cliArgs].filter(Boolean).join(" ")
  const workspace = resolveThreadRuntimePath(activeThread)
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const validation = buildBetterC0deSessionCliValidationMessages(command, args)
  const heading =
    mode === "delete" ? "BetterC0de Session Delete" : "BetterC0de Session List"
  const details =
    mode === "delete"
      ? [
          "Deletes an BetterC0de session by session ID from the compatibility CLI's own session storage.",
          "BetterC0de's local chat storage is separate; use `/delete-session --yes` for BetterC0de threads.",
          "This flow is terminal-only because BetterC0de owns the backing database and deletion side effects.",
        ]
      : [
          "Lists BetterC0de sessions from the compatibility CLI's own session storage.",
          "Supports `--max-count`/`-n` and `--format table|json`, matching BetterC0de compatibility CLI.",
          "Use `/sessions` for BetterC0de's native chat sessions.",
        ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`betterc0de session ${mode}\`.`,
    "",
    `Workspace: ${workspace ? formatDebugPathCell(workspace) : "No folder open"}`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    ...(validation.length > 0
      ? ["", "## Validation", "", ...validation.map((item) => `- ${item}`)]
      : []),
    "",
    shouldOpenTerminal
      ? workspace
        ? "> Opened the terminal panel with this BetterC0de session command prefilled. Press Enter there to run it intentionally."
        : "> Open a workspace first, then run this command with `--terminal` to prefill the integrated terminal."
      : "> Add `--terminal` to open the integrated terminal with this compatibility command prefilled.",
  ].join("\n")
}

export function buildBetterC0deDebugUtilityOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const mode = betterC0deDebugUtilityMode(command)
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  const cliCommand = ["betterc0de debug", mode, cliArgs]
    .filter(Boolean)
    .join(" ")
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const heading =
    mode === "scrap"
      ? "BetterC0de Debug Scrap"
      : mode === "v2"
        ? "BetterC0de Debug V2"
        : mode === "wait"
          ? "BetterC0de Debug Wait"
          : "BetterC0de Debug Startup"
  const details =
    mode === "scrap"
      ? [
          "Lists all known BetterC0de compatibility projects as JSON.",
          "In BetterC0de, use the project/sidebar views and `/sessions` for local project/session navigation.",
        ]
      : mode === "v2"
        ? [
            "Dumps BetterC0de v2 catalog/provider/default-model diagnostics.",
            "In BetterC0de, use `/catalog`, `/providers`, `/models <query> --verbose`, and Settings > Compatibility.",
          ]
        : mode === "wait"
          ? [
              "Sleeps indefinitely for debugger attachment.",
              "BetterC0de intentionally does not start an endless wait process from chat.",
            ]
          : [
              "Prints BetterC0de startup timing based on `performance.now()`.",
              `Current renderer uptime marker: ${Math.round(performance.now()).toLocaleString()}ms.`,
            ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`betterc0de debug ${mode}\`.`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with this BetterC0de debug command prefilled. Press Enter there to run it intentionally."
      : "> This BetterC0de command is read-only guidance. Add `--terminal` when you need byte-for-byte compatibility CLI output in the integrated terminal.",
  ].join("\n")
}

function buildBetterC0deDebugUtilityTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const mode = betterC0deDebugUtilityMode(command)
  const cliArgs = stringifyCliArgs([...stripBetterC0deRuntimeUiFlags(args)])
  return {
    command: ["betterc0de debug", mode, cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function betterC0deDebugUtilityMode(
  command: string
): "startup" | "scrap" | "v2" | "wait" {
  const normalized = command.replace(/^\//, "").toLowerCase()
  if (normalized.includes("scrap")) return "scrap"
  if (normalized.includes("v2")) return "v2"
  if (normalized.includes("wait")) return "wait"
  return "startup"
}

export function buildRuntimeDebugInfoOutput(info: RuntimeDebugInfo): string {
  const compat = info.betterc0de
  return [
    "# Debug Info",
    "",
    "Compatibility reference: `betterc0de debug info`.",
    "",
    "| Runtime | Value |",
    "|:--------|:------|",
    `| App | ${escapeMarkdownTableCell(info.app.name)} |`,
    `| Version | \`${escapeInlineCode(info.app.version || "unknown")}\` |`,
    `| Backend | \`${escapeInlineCode(info.app.backend)}\` |`,
    `| Uptime | ${formatDebugDuration(info.app.uptimeSeconds)} |`,
    `| OS | ${escapeMarkdownTableCell(`${info.system.type} ${info.system.release}`)} |`,
    `| Platform | \`${escapeInlineCode(info.system.platform)}-${escapeInlineCode(info.system.arch)}\` |`,
    `| Node | \`${escapeInlineCode(info.process.node)}\` |`,
    `| V8 | \`${escapeInlineCode(info.process.versions.v8 ?? "-")}\` |`,
    `| libuv | \`${escapeInlineCode(info.process.versions.uv ?? "-")}\` |`,
    `| NODE_MODULE_VERSION | \`${escapeInlineCode(info.process.versions.modules ?? "-")}\` |`,
    `| PID | ${info.process.pid.toLocaleString()} |`,
    `| CWD | ${formatDebugPathCell(info.process.cwd)} |`,
    "",
    "| Terminal | Value |",
    "|:---------|:------|",
    `| TERM | \`${escapeInlineCode(info.terminal.term ?? "-")}\` |`,
    `| Program | \`${escapeInlineCode(info.terminal.program ?? "-")}\` |`,
    `| Shell | ${formatDebugPathCell(info.terminal.shell)} |`,
    ...(compat
      ? [
          "",
          "| Compatibility plugins | State |",
          "|:-----------------|:------|",
          `| External plugins | ${formatBetterC0deExternalPluginsState(compat)} |`,
          `| Default plugins | ${formatBetterC0deDefaultPluginsState(compat)} |`,
          `| Plugin metadata | ${formatDebugPathCell(compat.pluginMetaPath)} |`,
        ]
      : []),
    "",
    "| Environment override | State |",
    "|:---------------------|:------|",
    `| BETTERC0DE_HOME | ${info.envOverrides.betterc0deHome} |`,
    `| BETTERC0DE_DATA_DIR | ${info.envOverrides.betterc0deDataDir} |`,
    "",
    "> Use `/debug-paths` or `/db.path` for local data and database paths. Secrets and environment values are not printed.",
  ].join("\n")
}

function formatBetterC0deExternalPluginsState(
  compat: NonNullable<RuntimeDebugInfo["betterc0de"]>
): string {
  if (compat.pureMode || compat.externalPlugins === "disabled-by-pure") {
    return "external plugins disabled (--pure)"
  }
  return "enabled"
}

function formatBetterC0deDefaultPluginsState(
  compat: NonNullable<RuntimeDebugInfo["betterc0de"]>
): string {
  if (
    compat.defaultPluginsDisabled ||
    compat.defaultPlugins === "disabled-by-env"
  ) {
    return "disabled (BETTERC0DE_DISABLE_DEFAULT_PLUGINS)"
  }
  return "enabled"
}

export function buildRuntimeDebugPathsOutput(info: RuntimeDebugInfo): string {
  const compat = info.betterc0de
  return [
    "# Debug Paths",
    "",
    "Compatibility reference: `betterc0de debug paths` / `betterc0de db path`.",
    "",
    "| Path | Value |",
    "|:-----|:------|",
    `| Data dir | ${formatDebugPathCell(info.paths.dataDir)} |`,
    `| SQLite database | ${formatDebugPathCell(info.database.path)} |`,
    `| BetterC0de compatibility config dir | ${formatDebugPathCell(compat?.configDir)} |`,
    `| BetterC0de compatibility config source | \`${compat?.configDirSource ?? "default"}\` |`,
    `| Compatibility data dir | ${formatDebugPathCell(compat?.dataDir)} |`,
    `| Compatibility state dir | ${formatDebugPathCell(compat?.stateDir)} |`,
    `| Compatibility cache dir | ${formatDebugPathCell(compat?.cacheDir)} |`,
    `| Compatibility bin dir | ${formatDebugPathCell(compat?.binDir)} |`,
    `| Compatibility log dir | ${formatDebugPathCell(compat?.logDir)} |`,
    `| Compatibility repos dir | ${formatDebugPathCell(compat?.reposDir)} |`,
    `| BetterC0de compatibility database | ${formatDebugPathCell(compat?.dbPath)} |`,
    `| BetterC0de compatibility database source | \`${compat?.dbPathSource ?? "default"}\` |`,
    `| Compatibility auth file | ${formatDebugPathCell(compat?.authPath)} |`,
    `| BetterC0de MCP auth file | ${formatDebugPathCell(compat?.mcpAuthPath)} |`,
    `| Compatibility plugin metadata | ${formatDebugPathCell(compat?.pluginMetaPath)} |`,
    `| Settings file | ${formatDebugPathCell(info.paths.settingsPath)} |`,
    `| Auth file | ${formatDebugPathCell(info.paths.authPath)} |`,
    `| Logs dir | ${formatDebugPathCell(info.paths.logsDir)} |`,
    `| Provider logs dir | ${formatDebugPathCell(info.paths.providerLogsDir)} |`,
    `| Provider event log | ${formatDebugPathCell(info.paths.providerEventLogPath)} |`,
    `| Process cwd | ${formatDebugPathCell(info.process.cwd)} |`,
    "",
    "> Paths are read-only diagnostics. Auth contents and other secrets are not displayed.",
  ].join("\n")
}

export function buildBetterC0deDbPathOutput(
  info: RuntimeDebugInfo,
  command = "/betterc0de-db-path",
  args: ReadonlyArray<string> = []
): string {
  const compat = info.betterc0de
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  const cliCommand = ["betterc0de", "db", cliArgs].filter(Boolean).join(" ")
  const validation = buildBetterC0deMaintenanceValidationMessages(
    command,
    "db",
    args
  )
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)

  return [
    "# BetterC0de DB Path",
    "",
    "Compatibility reference: `betterc0de db path`.",
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| BetterC0de compatibility database | ${formatDebugPathCell(compat?.dbPath)} |`,
    `| BetterC0de compatibility database source | \`${compat?.dbPathSource ?? "default"}\` |`,
    `| Compatibility data dir | ${formatDebugPathCell(compat?.dataDir)} |`,
    `| BetterC0de database | ${formatDebugPathCell(info.database.path)} |`,
    validation.length > 0
      ? [
          "",
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
        ].join("\n")
      : "",
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with this command prefilled. The table above is BetterC0de's read-only local path lookup."
      : "> Read-only path lookup. Use `/debug-paths` for all local paths; add `--terminal` for the raw compatibility CLI handoff.",
  ].join("\n")
}

export function buildRuntimeHeapSnapshotOutput(result: {
  path: string
  bytes: number
}): string {
  return [
    "# Heap Snapshot",
    "",
    "Compatibility reference: `app.heap_snapshot`.",
    "",
    "Node backend heap snapshot written.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Path | ${formatDebugPathCell(result.path)} |`,
    `| Size | ${formatBytes(result.bytes)} |`,
    "",
    "> Keep heap snapshots local. They can contain runtime object data.",
  ].join("\n")
}

function formatDebugDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s"
  const whole = Math.floor(seconds)
  const days = Math.floor(whole / 86_400)
  const hours = Math.floor((whole % 86_400) / 3_600)
  const minutes = Math.floor((whole % 3_600) / 60)
  const remaining = whole % 60
  return [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    remaining > 0 || (days === 0 && hours === 0 && minutes === 0)
      ? `${remaining}s`
      : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export function parseStatsCommandOptions(
  args: readonly string[],
  activeThread: ActiveThreadRef
): StatsCommandOptions {
  const terminalCommand = buildBetterC0deStatsTerminalCommand(args)
  const options: StatsCommandOptions = {
    validation: [],
    ...(terminalCommand.shouldOpen
      ? { terminalCommand: terminalCommand.command }
      : {}),
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) {
      continue
    }
    if (arg === "--today") {
      options.days = 0
      continue
    }
    if (arg === "--current-project" || arg === "--current") {
      options.projectPath = resolveThreadRuntimePath(activeThread)
      continue
    }
    if (arg === "--days") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        options.validation!.push("--days requires a value.")
      } else {
        const parsed = parseStatsNonNegativeInteger(value, "--days", options)
        if (parsed !== undefined) options.days = parsed
        index += 1
      }
      continue
    }
    if (arg.startsWith("--days=")) {
      const parsed = parseStatsNonNegativeInteger(
        arg.slice("--days=".length),
        "--days",
        options
      )
      if (parsed !== undefined) options.days = parsed
      continue
    }
    if (arg === "--project") {
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith("-")) {
        options.projectPath = parseStatsProjectFilter(value, activeThread)
        index += 1
      } else {
        options.validation!.push(
          "--project requires a value. Use `--project=` for the current project."
        )
      }
      continue
    }
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length)
      options.projectPath = parseStatsProjectFilter(value, activeThread)
      continue
    }
    if (arg === "--project-current") {
      options.projectPath = resolveThreadRuntimePath(activeThread)
      continue
    }
    if (arg === "--project-path") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        options.projectPath = value
        index += 1
      } else {
        options.validation!.push("--project-path requires a value.")
      }
      continue
    }
    if (arg.startsWith("--project-path=")) {
      options.projectPath = arg.slice("--project-path=".length)
      continue
    }
    if (arg === "--tools") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        const parsed = parseStatsNonNegativeInteger(value, "--tools", options)
        if (parsed !== undefined) options.toolLimit = parsed
        index += 1
      } else {
        options.toolLimit = Infinity
      }
      continue
    }
    if (arg.startsWith("--tools=")) {
      const parsed = parseStatsNonNegativeInteger(
        arg.slice("--tools=".length),
        "--tools",
        options
      )
      if (parsed !== undefined) options.toolLimit = parsed
      continue
    }
    if (arg === "--models") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        const parsed = parseStatsNonNegativeInteger(value, "--models", options)
        if (parsed !== undefined) options.modelLimit = parsed
        index += 1
      } else {
        options.modelLimit = Infinity
      }
      continue
    }
    if (arg.startsWith("--models=")) {
      const value = arg.slice("--models=".length)
      if (value.trim().length === 0) {
        options.modelLimit = Infinity
      } else {
        const parsed = parseStatsNonNegativeInteger(value, "--models", options)
        if (parsed !== undefined) options.modelLimit = parsed
      }
      continue
    }
    if (arg === "--no-models") {
      options.modelLimit = 0
    }
  }
  return options
}

function parseStatsNonNegativeInteger(
  value: string,
  label: string,
  options: StatsCommandOptions
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) {
    options.validation!.push(`${label} requires a value.`)
    return undefined
  }
  if (!/^\d+$/.test(trimmed)) {
    options.validation!.push(`${label} must be a non-negative integer.`)
    return undefined
  }
  return Number.parseInt(trimmed, 10)
}

function buildBetterC0deStatsTerminalCommand(args: readonly string[]): {
  command: string
  shouldOpen: boolean
} {
  const cliArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--today") {
      cliArgs.push("--days", "0")
      continue
    }
    if (
      arg === "--current-project" ||
      arg === "--current" ||
      arg === "--project-current"
    ) {
      cliArgs.push("--project=")
      continue
    }
    if (arg === "--project-path") {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) {
        cliArgs.push("--project", value)
        index += 1
      }
      continue
    }
    if (arg.startsWith("--project-path=")) {
      cliArgs.push(`--project=${arg.slice("--project-path=".length)}`)
      continue
    }
    cliArgs.push(arg)
  }

  return {
    command: ["betterc0de stats", stringifyCliArgs(cliArgs)]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function parseStatsProjectFilter(
  value: string,
  activeThread: ActiveThreadRef
): string | null {
  const trimmed = value.trim()
  if (
    trimmed === "" ||
    trimmed === "''" ||
    trimmed === '""' ||
    trimmed === "current"
  ) {
    return resolveThreadRuntimePath(activeThread)
  }
  return value
}

function emptyThreadUsageStats(): ThreadUsageStats {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: { earliest: null, latest: null },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }
}

function buildThemesOutput(currentTemplate: string, switched: boolean): string {
  const rows = SELECTABLE_THEME_TEMPLATES.map((template) => {
    const current = template.id === currentTemplate ? "Active" : ""
    return `| \`${template.mode}\` | ${template.name} | \`${template.id}\` | ${current} |`
  })
  // Imported VS Code / Cursor themes are switchable by id or name too.
  const imported = Object.values(readCustomThemes()).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (const theme of imported) {
    const current =
      customTemplateId(theme.id) === currentTemplate ? "Active" : ""
    rows.push(
      `| \`${theme.mode}\` | ${escapeMarkdownTableCell(theme.name)} | \`${theme.id}\` | ${current} |`
    )
  }
  return [
    "# Themes\n",
    switched
      ? "Theme updated.\n"
      : imported.length > 0
        ? "Use `/theme <id>` with one of the ids below, or `/theme dark` / `/theme light`. Import more under **Settings → Appearance → Imported themes**.\n"
        : "Use `/theme dark` or `/theme light`. Import VS Code or Cursor themes under **Settings → Appearance → Imported themes**.\n",
    "| Mode | Name | ID | |",
    "|:-----|:-----|:---|:--|",
    ...rows,
  ].join("\n")
}

function buildThemeModeOutput(
  currentTemplate: string,
  locked: boolean
): string {
  const template = SELECTABLE_THEME_TEMPLATES.find(
    (entry) => entry.id === currentTemplate
  )
  const importedName =
    readCustomThemes()[customThemeIdOf(currentTemplate) ?? ""]?.name
  return [
    "# Theme Mode\n",
    `Switched to **${(templateMode(currentTemplate) ?? template?.mode) === "light" ? "Light" : "Dark"}** mode.`,
    "",
    `Theme: **${escapeMarkdownTableCell(template?.name ?? importedName ?? currentTemplate)}**`,
    `Mode lock: **${locked ? "On" : "Off"}**`,
    "",
    "> Use `/theme-mode-lock on|off` to pin or unpin the current mode.",
  ].join("\n")
}

function resolveThemeTemplateId(value: string): string | null {
  if (value === "dark" || value === "default-dark") return "default-dark"
  if (value === "light" || value === "white") return "white"
  const builtIn = SELECTABLE_THEME_TEMPLATES.find(
    (template) =>
      template.id.toLowerCase() === value ||
      template.name.toLowerCase() === value
  )
  if (builtIn) return builtIn.id
  const wanted = value.replace(/^custom:/, "")
  const imported = Object.values(readCustomThemes()).find(
    (theme) =>
      theme.id.toLowerCase() === wanted || theme.name.toLowerCase() === wanted
  )
  return imported ? customTemplateId(imported.id) : null
}

function nextThemeTemplateId(currentTemplate: string): string {
  return currentTemplate === "white" ? "default-dark" : "white"
}

function buildLanguageCompatibilityOutput(): string {
  return [
    "# Language\n",
    "Compatibility reference: `language.cycle` / `language.set.<locale>`.",
    "",
    "BetterC0de currently exposes a single UI language. The command is reserved for BetterC0de compatibility so project docs, keybind references, and command searches do not fall through to the provider.",
  ].join("\n")
}

function emitAppLog(payload: AppLogPayload): void {
  const message = `[${payload.service}] ${payload.message}`
  const args = payload.extra ? [message, payload.extra] : [message]
  if (payload.level === "error") {
    console.error(...args)
  } else if (payload.level === "warn") {
    console.warn(...args)
  } else if (payload.level === "debug") {
    console.debug(...args)
  } else {
    console.info(...args)
  }
}

export function buildAppLogOutput(parsed: ParsedAppLogCommand): string {
  if (!parsed.payload) {
    return [
      "# App Log",
      "",
      "Compatibility reference: `app.log` / `POST /log`.",
      "",
      `> ${parsed.error}`,
    ].join("\n")
  }

  const payload = parsed.payload
  return [
    "# App Log",
    "",
    "Compatibility reference: `app.log` / `POST /log`.",
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Service | \`${escapeMarkdownTableCell(payload.service)}\` |`,
    `| Level | \`${payload.level}\` |`,
    `| Message | ${escapeMarkdownTableCell(payload.message)} |`,
    payload.extra
      ? `| Extra | \`${escapeMarkdownTableCell(JSON.stringify(payload.extra))}\` |`
      : "",
    "",
    "> Wrote the entry to BetterC0de's local console panel. Compatibility writes this payload to the server log endpoint.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildBetterC0deInternalRouteOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const route = command.replace(/^\//, "")
  if (route === "project.initGit") {
    return buildBetterC0deProjectInitGitOutput(args)
  }
  if (route === "tui.publish") {
    return buildBetterC0deTuiPublishOutput(args)
  }
  const guidance = betterC0deInternalRouteGuidance(route, args)
  return [
    "# BetterC0de Internal Route\n",
    `Route: \`${escapeInlineCode(route)}\``,
    "",
    `BetterC0de equivalent: ${guidance.equivalent}`,
    guidance.reason ? `Reason: ${guidance.reason}` : "",
    args.length > 0 ? `Arguments: \`${escapeInlineCode(args.join(" "))}\`` : "",
    "",
    "> This route is reserved for compatibility identifiers. BetterC0de only executes the safe local equivalent; provider credentials, raw websocket sync, message-part mutation, and internal terminal UI events are not run from chat.",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deInternalRouteTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const route = command.replace(/^\//, "")
  if (route !== "project.initGit") {
    return { command: "", shouldOpen: false }
  }
  return {
    command: "git init",
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deProjectInitGitOutput(
  args: ReadonlyArray<string>
): string {
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  return [
    "# BetterC0de Project Git Init",
    "",
    "Compatibility reference: `project.initGit` / `POST /project/git/init`.",
    "",
    "```sh",
    "git init",
    "```",
    "",
    "BetterC0de equivalent: the integrated terminal in the active workspace.",
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with `git init` prefilled. Press Enter there to initialize Git intentionally."
      : "> Git initialization is a filesystem mutation. Add `--terminal` to open the integrated terminal with `git init` prefilled.",
  ].join("\n")
}

type BetterC0deTuiPublishEvent = {
  type: string
  properties: Record<string, unknown>
}

function buildBetterC0deTuiPublishOutput(args: ReadonlyArray<string>): string {
  const parsed = parseBetterC0deTuiPublishEvent(args)
  const validation = parsed.event
    ? validateBetterC0deTuiPublishEvent(parsed.event)
    : parsed.validation
  const event = parsed.event
  const equivalent = event
    ? betterC0deTuiPublishEquivalent(event)
    : "Provide a `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, or `tui.session.select` payload."

  return [
    "# BetterC0de Terminal Event Publish",
    "",
    "Compatibility reference: `tui.publish` / `POST /tui/publish`.",
    "",
    event
      ? [
          "| Field | Value |",
          "|:------|:------|",
          `| Event | \`${escapeMarkdownTableCell(event.type)}\` |`,
          `| Properties | \`${escapeMarkdownTableCell(JSON.stringify(event.properties))}\` |`,
          `| BetterC0de equivalent | ${equivalent} |`,
        ].join("\n")
      : `BetterC0de equivalent: ${equivalent}`,
    validation.length > 0 ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length > 0 ? "" : "",
    '> Accepted forms: `/tui.publish {"type":"tui.command.execute","properties":{"command":"session.list"}}`, `/tui.publish tui.command.execute session.list`, `/tui.publish --type=tui.prompt.append --text "hello"`, `/tui.publish --message Saved --variant success`, or `/tui.publish tui.session.select ses_...`.',
  ]
    .filter(Boolean)
    .join("\n")
}

function parseBetterC0deTuiPublishEvent(args: ReadonlyArray<string>): {
  event: BetterC0deTuiPublishEvent | null
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (!raw) {
    return {
      event: null,
      validation: ["Missing TUI publish event payload."],
    }
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isBetterC0deTuiPublishEvent(parsed)) {
        return { event: parsed, validation: [] }
      }
      return {
        event: null,
        validation: [
          "JSON payload must include a string `type` and object `properties`.",
        ],
      }
    } catch (error) {
      return {
        event: null,
        validation: [
          `Invalid JSON payload: ${error instanceof Error ? error.message : "parse failed"}.`,
        ],
      }
    }
  }

  const type =
    readBetterC0deTuiPublishOption(args, "type", "event") ??
    inferBetterC0deTuiPublishType(args)
  const properties = parseBetterC0deTuiPublishProperties(type, args)
  if (!type) {
    return {
      event: null,
      validation: ["Missing TUI publish event type."],
    }
  }
  return { event: { type, properties }, validation: [] }
}

function isBetterC0deTuiPublishEvent(
  value: unknown
): value is BetterC0deTuiPublishEvent {
  if (!value || typeof value !== "object") return false
  const event = value as { type?: unknown; properties?: unknown }
  return (
    typeof event.type === "string" &&
    !!event.properties &&
    typeof event.properties === "object" &&
    !Array.isArray(event.properties)
  )
}

function inferBetterC0deTuiPublishType(args: ReadonlyArray<string>): string {
  const positional = betterC0deTuiPublishPositionals(args)
  const explicit = positional.find((arg) => arg.startsWith("tui."))
  if (explicit) return explicit
  if (readBetterC0deTuiPublishOption(args, "command")) {
    return "tui.command.execute"
  }
  if (readBetterC0deTuiPublishOption(args, "text")) {
    return "tui.prompt.append"
  }
  if (
    readBetterC0deTuiPublishOption(args, "sessionID", "session-id", "session")
  ) {
    return "tui.session.select"
  }
  if (
    readBetterC0deTuiPublishOption(args, "message") ||
    readBetterC0deTuiPublishOption(args, "variant")
  ) {
    return "tui.toast.show"
  }
  return ""
}

function parseBetterC0deTuiPublishProperties(
  type: string,
  args: ReadonlyArray<string>
): Record<string, unknown> {
  const positional = betterC0deTuiPublishPositionals(args)
  const afterType =
    positional[0] === type
      ? positional.slice(1)
      : positional.filter((arg) => arg !== type)

  if (type === "tui.command.execute") {
    return {
      command:
        readBetterC0deTuiPublishOption(args, "command", "id", "name") ??
        afterType[0] ??
        "",
    }
  }
  if (type === "tui.prompt.append") {
    return {
      text:
        readBetterC0deTuiPublishOption(args, "text") ??
        afterType.join(" ").trim(),
    }
  }
  if (type === "tui.session.select") {
    return {
      sessionID:
        readBetterC0deTuiPublishOption(
          args,
          "sessionID",
          "session-id",
          "session"
        ) ??
        afterType[0] ??
        "",
    }
  }
  if (type === "tui.toast.show") {
    const duration = readBetterC0deTuiPublishOption(args, "duration")
    return {
      title: readBetterC0deTuiPublishOption(args, "title") ?? "",
      message:
        readBetterC0deTuiPublishOption(args, "message") ??
        afterType.join(" ").trim(),
      variant: readBetterC0deTuiPublishOption(args, "variant") ?? "info",
      ...(duration ? { duration: Number(duration) } : {}),
    }
  }
  return Object.fromEntries(
    afterType.map((value, index) => [`arg${index + 1}`, value])
  )
}

function readBetterC0deTuiPublishOption(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | null {
  const normalizedNames = new Set(names.map((name) => `--${name}`))
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    for (const name of normalizedNames) {
      if (arg === name) return args[index + 1]?.trim() || null
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1).trim() || null
      }
    }
  }
  return null
}

function betterC0deTuiPublishPositionals(
  args: ReadonlyArray<string>
): string[] {
  const valueFlags = new Set([
    "--type",
    "--event",
    "--command",
    "--id",
    "--name",
    "--text",
    "--sessionID",
    "--session-id",
    "--session",
    "--title",
    "--message",
    "--variant",
    "--duration",
  ])
  return args.filter((arg, index) => {
    if (!arg || arg.startsWith("--")) return false
    const previous = args[index - 1]
    return !previous || !valueFlags.has(previous)
  })
}

function validateBetterC0deTuiPublishEvent(
  event: BetterC0deTuiPublishEvent
): string[] {
  const validation: string[] = []
  if (
    ![
      "tui.prompt.append",
      "tui.command.execute",
      "tui.toast.show",
      "tui.session.select",
    ].includes(event.type)
  ) {
    validation.push(
      "Unsupported TUI publish event type. BetterC0de maps `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, and `tui.session.select`."
    )
  }
  if (
    event.type === "tui.command.execute" &&
    typeof event.properties.command !== "string"
  ) {
    validation.push("`tui.command.execute` requires `properties.command`.")
  }
  if (
    event.type === "tui.prompt.append" &&
    typeof event.properties.text !== "string"
  ) {
    validation.push("`tui.prompt.append` requires `properties.text`.")
  }
  if (
    event.type === "tui.session.select" &&
    typeof event.properties.sessionID !== "string"
  ) {
    validation.push("`tui.session.select` requires `properties.sessionID`.")
  }
  if (event.type === "tui.toast.show") {
    if (typeof event.properties.message !== "string") {
      validation.push("`tui.toast.show` requires `properties.message`.")
    }
    if (
      !["info", "success", "warning", "error"].includes(
        String(event.properties.variant ?? "")
      )
    ) {
      validation.push(
        "`tui.toast.show` requires `properties.variant` to be info, success, warning, or error."
      )
    }
  }
  return validation
}

function betterC0deTuiPublishEquivalent(
  event: BetterC0deTuiPublishEvent
): string {
  if (event.type === "tui.command.execute") {
    return betterC0deTuiCommandEquivalent([
      String(event.properties.command ?? ""),
    ])
  }
  if (event.type === "tui.prompt.append") {
    const text = String(event.properties.text ?? "").trim()
    return text
      ? `\`/prompt-paste ${escapeInlineCode(text)}\` or type directly in the composer`
      : "`/prompt-paste <text>` or type directly in the composer"
  }
  if (event.type === "tui.session.select") {
    const sessionId = String(event.properties.sessionID ?? "").trim()
    return sessionId
      ? `\`/resume ${escapeInlineCode(sessionId)}\``
      : "`/sessions`"
  }
  if (event.type === "tui.toast.show") {
    return "the local notification/toast UI"
  }
  return "`/betterc0de-api tui.publish`"
}

export function buildBetterC0deAuthControlOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const route = command.replace(/^\//, "").replace(/-/g, ".")
  const operation = route === "auth.remove" ? "remove" : "set"
  const providerId = resolveAuthControlProviderId(args)
  const equivalent =
    operation === "remove"
      ? "`/providers.logout`, `/auth`, or Settings > Providers"
      : "`/connect`, `/auth`, or Settings > Providers"
  const terminal =
    operation === "remove"
      ? "betterc0de providers logout"
      : "betterc0de providers login --provider <id>"

  return [
    "# BetterC0de Auth Control",
    "",
    `Compatibility reference: \`${route}\` / \`${operation === "remove" ? "DELETE" : "PUT"} /auth/:providerID\`.`,
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Operation | \`${operation}\` |`,
    `| Provider | ${providerId ? `\`${escapeMarkdownTableCell(providerId)}\`` : "_not specified_"} |`,
    `| BetterC0de equivalent | ${equivalent} |`,
    `| Terminal flow | \`${terminal}\` |`,
    "",
    operation === "remove"
      ? "> BetterC0de does not delete provider credentials from this chat route. Use provider settings or the explicit provider logout flow so credential changes stay auditable."
      : "> BetterC0de never accepts raw provider credentials in chat. Use provider settings, OAuth/CLI setup, or the terminal login flow for secrets.",
  ].join("\n")
}

export interface BetterC0deSyncRouteSnapshot {
  threads: ReadonlyArray<ChatThread>
  activeThreadId: string | null
  activitiesByThread?: Record<string, ReadonlyArray<ThreadActivity>>
  streamingByThread?: Record<string, ThreadStreamState>
  activeThread?: {
    projectPath?: string | null
    worktreePath?: string | null
    envMode?: string | null
  } | null
}

export function buildBetterC0deSyncRouteOutput(
  command: string,
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const parsed = parseBetterC0deSyncRouteCommand(command, args)
  const route = parsed.route
  const routeArgs = parsed.args
  if (route === "sync.history.list") {
    return buildBetterC0deSyncHistoryOutput(routeArgs, snapshot)
  }
  if (route === "sync.start") {
    return buildBetterC0deSyncStartOutput(snapshot)
  }
  if (route === "sync.replay") {
    return buildBetterC0deSyncReplayOutput(routeArgs)
  }
  if (route === "sync.steal") {
    return buildBetterC0deSyncStealOutput(routeArgs, snapshot)
  }
  return [
    "# BetterC0de Sync",
    "",
    "Compatibility references: `sync.history.list`, `sync.start`, `sync.replay`, `sync.steal`.",
    "",
    "> Usage: `/betterc0de-sync history`, `/betterc0de-sync start`, `/betterc0de-sync replay { ... }`, or `/betterc0de-sync steal <sessionID>`.",
  ].join("\n")
}

export interface BetterC0deWorkspaceRouteSnapshot {
  threads: ReadonlyArray<ChatThread>
  activeThreadId: string | null
  activeThread?: {
    projectPath?: string | null
    worktreePath?: string | null
    envMode?: string | null
  } | null
}

export function buildBetterC0deWorkspaceRouteOutput(
  command: string,
  args: ReadonlyArray<string>,
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const route = resolveBetterC0deWorkspaceRoute(command, args)
  if (route === "experimental.workspace.warp") {
    return buildBetterC0deWorkspaceWarpOutput(args, snapshot)
  }
  return buildBetterC0deWorkspaceSyncListOutput(snapshot)
}

export function buildBetterC0deLifecycleRouteOutput(
  command: string,
  activeThread: ActiveThreadRef
): string {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  const route =
    normalized === "instance.dispose" ? "instance.dispose" : "global.dispose"
  const runtimePath = resolveThreadRuntimePath(activeThread)
  return [
    "# BetterC0de Lifecycle",
    "",
    `Compatibility reference: \`${route}\` / \`POST /${route === "global.dispose" ? "global/dispose" : "instance/dispose"}\`.`,
    "",
    `Scope: **${route === "global.dispose" ? "all BetterC0de compatibility instances" : "current BetterC0de compatibility instance"}**`,
    `Active workspace: ${runtimePath ? `\`${escapeMarkdownTableCell(runtimePath)}\`` : "_none_"}`,
    "",
    "> BetterC0de does not dispose Electron/provider processes from this compatibility route. Use `/exit`, close the app window, restart the selected provider, or stop the active turn explicitly.",
  ].join("\n")
}

export function buildBetterC0deTuiControlRouteOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  const route =
    normalized === "tui.control.response"
      ? "tui.control.response"
      : "tui.control.next"
  const payload = parseBetterC0deTuiControlPayload(args)
  const payloadError = payload.ok ? null : payload.error
  return [
    "# BetterC0de Terminal Control",
    "",
    `Compatibility reference: \`${route}\` / \`${route === "tui.control.next" ? "GET /tui/control/next" : "POST /tui/control/response"}\`.`,
    "",
    route === "tui.control.next"
      ? "Queue status: **BetterC0de has no external TUI request queue pending in chat.**"
      : payload.ok
        ? `Response payload: \`${escapeMarkdownTableCell(JSON.stringify(payload.value))}\``
        : "Response payload: _invalid_",
    payloadError ? "\n## Validation\n" : "",
    payloadError ? `- ${payloadError}` : "",
    "",
    "> These compatibility routes model an external terminal-controller queue. BetterC0de handles the same actions through normal UI controls, slash commands, and `/tui.publish` event mapping.",
  ]
    .filter(Boolean)
    .join("\n")
}

type BetterC0deSyncRoute =
  | "sync.history.list"
  | "sync.start"
  | "sync.replay"
  | "sync.steal"
  | "sync"

function parseBetterC0deSyncRouteCommand(
  command: string,
  args: ReadonlyArray<string>
): { route: BetterC0deSyncRoute; args: string[] } {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  if (
    normalized === "sync.history.list" ||
    normalized === "sync.start" ||
    normalized === "sync.replay" ||
    normalized === "sync.steal"
  ) {
    return { route: normalized, args: [...args] }
  }

  const firstIndex = args.findIndex((arg) => arg && !arg.startsWith("--"))
  const first = firstIndex >= 0 ? args[firstIndex]!.toLowerCase() : ""
  const rest =
    firstIndex >= 0
      ? args.filter((_, index) => index !== firstIndex)
      : [...args]
  if (["history", "history.list", "list"].includes(first)) {
    return { route: "sync.history.list", args: rest }
  }
  if (first === "start") return { route: "sync.start", args: rest }
  if (first === "replay") return { route: "sync.replay", args: rest }
  if (first === "steal") return { route: "sync.steal", args: rest }
  return { route: "sync", args: [...args] }
}

function buildBetterC0deSyncHistoryOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const json =
    cleanArgs.includes("--json") || cleanArgs.includes("--format=json")
  const cursor = parseBetterC0deSyncHistoryCursor(cleanArgs)
  const validation = cursor.error ? [cursor.error] : []
  const events = filterBetterC0deSyncEventsByCursor(
    localBetterC0deSyncEvents(snapshot),
    cursor.value
  ).slice(-80)

  if (json) {
    return [
      "# BetterC0de Sync History",
      "",
      "Compatibility reference: `sync.history.list` / `POST /sync/history`.",
      validation.length ? "\n## Validation\n" : "",
      ...validation.map((item) => `- ${item}`),
      "",
      "```json",
      JSON.stringify(events, null, 2),
      "```",
      "",
      "> BetterC0de returns a local compatibility snapshot built from thread metadata and thread activities. No external runtime process is required.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  return [
    "# BetterC0de Sync History",
    "",
    "Compatibility reference: `sync.history.list` / `POST /sync/history`.",
    validation.length ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length ? "" : "",
    cursor.value
      ? `Cursor aggregates: ${Object.keys(cursor.value).length.toLocaleString()}`
      : "Cursor aggregates: none",
    "",
    events.length === 0
      ? "> No local BetterC0de sync-compatible events matched this cursor."
      : "| # | Aggregate | Seq | Type | Data |",
    events.length === 0 ? "" : "|:--|:----------|:----|:-----|:-----|",
    ...events.map(
      (event, index) =>
        `| ${index + 1} | \`${escapeMarkdownTableCell(event.aggregate_id)}\` | ${event.seq} | \`${escapeMarkdownTableCell(event.type)}\` | \`${escapeMarkdownTableCell(JSON.stringify(event.data))}\` |`
    ),
    events.length === 0 ? "" : "",
    "> Use `/events` for the active thread event view, `/sessions --json` for local session metadata, or `/export` for a portable thread snapshot.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function buildBetterC0deSyncStartOutput(
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const activeDirectory = resolveBetterC0deSyncActiveDirectory(snapshot)
  const workspaceThreads = activeDirectory
    ? snapshot.threads.filter(
        (thread) =>
          thread.worktreePath === activeDirectory ||
          thread.projectPath === activeDirectory
      )
    : snapshot.threads
  const active = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )

  return [
    "# BetterC0de Sync Start",
    "",
    "Compatibility reference: `sync.start` / `POST /sync/start`.",
    "",
    `Active directory: ${activeDirectory ? `\`${escapeMarkdownTableCell(activeDirectory)}\`` : "_none_"}`,
    `Active session: ${active ? `\`${escapeMarkdownTableCell(active.id)}\` ${escapeMarkdownTableCell(active.title || "Untitled")}` : "_none_"}`,
    `Workspace sessions: ${workspaceThreads.length.toLocaleString()}`,
    "",
    "> BetterC0de keeps thread state in its local store/backend and does not need to start external websocket sync loops from chat. Use `/sessions`, `/events`, `/export`, and `/import` for the safe equivalents.",
  ].join("\n")
}

function buildBetterC0deSyncReplayOutput(args: ReadonlyArray<string>): string {
  const parsed = parseBetterC0deSyncReplayPayload(args)
  const validation = parsed.validation
  const payload = parsed.payload
  return [
    "# BetterC0de Sync Replay",
    "",
    "Compatibility reference: `sync.replay` / `POST /sync/replay`.",
    "",
    payload
      ? `Directory: \`${escapeMarkdownTableCell(payload.directory)}\`\nEvents: ${payload.events.length.toLocaleString()}`
      : "Payload: _not provided_",
    validation.length ? "\n## Validation\n" : "",
    ...validation.map((item) => `- ${item}`),
    validation.length ? "" : "",
    "> BetterC0de does not replay raw compatibility events directly into chat state. Export the replay data to a file and use `/import <file>` when you want an auditable import path.",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildBetterC0deSyncStealOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deSyncRouteSnapshot
): string {
  const sessionID = parseBetterC0deSyncSessionId(args)
  const matched = sessionID
    ? snapshot.threads.find(
        (thread) =>
          thread.id === sessionID ||
          thread.codexThreadId === sessionID ||
          thread.id.startsWith(sessionID)
      )
    : null

  return [
    "# BetterC0de Sync Steal",
    "",
    "Compatibility reference: `sync.steal` / `POST /sync/steal`.",
    "",
    `Requested session: ${sessionID ? `\`${escapeMarkdownTableCell(sessionID)}\`` : "_missing_"}`,
    matched
      ? `Matched BetterC0de thread: \`${escapeMarkdownTableCell(matched.id)}\` ${escapeMarkdownTableCell(matched.title || "Untitled")}`
      : "",
    "",
    !sessionID ? "## Validation\n\n- Missing `sessionID`." : "",
    sessionID && !matched
      ? "> No local BetterC0de thread matched this session id. Use `/sessions` to inspect local ids."
      : "",
    matched
      ? "> BetterC0de does not silently reassign a session to the current workspace from this compatibility route. Use `/resume`, `/workspace-new`, or explicit import/export flows so workspace moves stay auditable."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

type LocalBetterC0deSyncEvent = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

function localBetterC0deSyncEvents(
  snapshot: BetterC0deSyncRouteSnapshot
): LocalBetterC0deSyncEvent[] {
  const events: LocalBetterC0deSyncEvent[] = []
  for (const thread of [...snapshot.threads].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt)
  )) {
    const aggregate = thread.id
    events.push({
      id: `thread:${thread.id}:meta`,
      aggregate_id: aggregate,
      seq: 1,
      type: "session.updated",
      data: {
        title: thread.title,
        directory: thread.worktreePath || thread.projectPath || null,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount ?? thread.messages.length,
      },
    })
    const activities = snapshot.activitiesByThread?.[thread.id] ?? []
    for (const [index, activity] of [...activities]
      .sort(compareThreadActivities)
      .entries()) {
      events.push({
        id: activity.id,
        aggregate_id: aggregate,
        seq: index + 2,
        type: `activity.${activity.kind}`,
        data: {
          tone: activity.tone,
          summary: activity.summary,
          createdAt: activity.createdAt,
        },
      })
    }
    const stream = snapshot.streamingByThread?.[thread.id]
    if (stream?.isStreaming) {
      events.push({
        id: `thread:${thread.id}:stream`,
        aggregate_id: aggregate,
        seq: activities.length + 2,
        type: "session.status",
        data: {
          status: "streaming",
          model: stream.streamingModelId,
        },
      })
    }
  }
  return events
}

function filterBetterC0deSyncEventsByCursor(
  events: ReadonlyArray<LocalBetterC0deSyncEvent>,
  cursor: Record<string, number> | null
): LocalBetterC0deSyncEvent[] {
  if (!cursor) return [...events]
  return events.filter((event) => event.seq > (cursor[event.aggregate_id] ?? 0))
}

function parseBetterC0deSyncHistoryCursor(args: ReadonlyArray<string>): {
  value: Record<string, number> | null
  error?: string
} {
  const raw = args.join(" ").trim()
  if (!raw || !raw.startsWith("{")) return { value: null }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        value: null,
        error: "Sync history cursor must be a JSON object.",
      }
    }
    const value: Record<string, number> = {}
    for (const [key, rawValue] of Object.entries(parsed)) {
      const numeric = Number(rawValue)
      if (!Number.isInteger(numeric) || numeric < 0) {
        return {
          value: null,
          error: "Sync history cursor values must be non-negative integers.",
        }
      }
      value[key] = numeric
    }
    return { value }
  } catch (error) {
    return {
      value: null,
      error: `Invalid sync history cursor JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
    }
  }
}

function parseBetterC0deSyncReplayPayload(args: ReadonlyArray<string>): {
  payload: { directory: string; events: unknown[] } | null
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (!raw || !raw.startsWith("{")) {
    return {
      payload: null,
      validation: ["Provide the BetterC0de replay payload as JSON."],
    }
  }
  try {
    const parsed = JSON.parse(raw) as {
      directory?: unknown
      events?: unknown
    }
    const validation: string[] = []
    if (typeof parsed.directory !== "string" || !parsed.directory.trim()) {
      validation.push("Replay payload requires a non-empty `directory` string.")
    }
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      validation.push("Replay payload requires a non-empty `events` array.")
    }
    return {
      payload:
        validation.length === 0
          ? {
              directory: parsed.directory as string,
              events: parsed.events as unknown[],
            }
          : null,
      validation,
    }
  } catch (error) {
    return {
      payload: null,
      validation: [
        `Invalid replay JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
      ],
    }
  }
}

function parseBetterC0deSyncSessionId(
  args: ReadonlyArray<string>
): string | null {
  const raw = args.join(" ").trim()
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { sessionID?: unknown }
      return typeof parsed.sessionID === "string" && parsed.sessionID.trim()
        ? parsed.sessionID.trim()
        : null
    } catch {
      return null
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (
      arg === "--sessionID" ||
      arg === "--session-id" ||
      arg === "--session"
    ) {
      return args[index + 1]?.trim() || null
    }
    if (arg.startsWith("--sessionID=")) {
      return arg.slice("--sessionID=".length).trim() || null
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length).trim() || null
    }
    if (!arg.startsWith("-")) return arg.trim() || null
  }
  return null
}

function resolveBetterC0deSyncActiveDirectory(
  snapshot: BetterC0deSyncRouteSnapshot
): string | null {
  const activeThread = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )
  return (
    snapshot.activeThread?.worktreePath ||
    snapshot.activeThread?.projectPath ||
    activeThread?.worktreePath ||
    activeThread?.projectPath ||
    null
  )
}

function resolveBetterC0deWorkspaceRoute(
  command: string,
  args: ReadonlyArray<string>
): "experimental.workspace.syncList" | "experimental.workspace.warp" {
  const normalized = command.replace(/^\//, "").replace(/-/g, ".")
  if (normalized === "experimental.workspace.warp") {
    return "experimental.workspace.warp"
  }
  const first = args.find((arg) => arg && !arg.startsWith("--"))?.toLowerCase()
  if (first === "warp") return "experimental.workspace.warp"
  return "experimental.workspace.syncList"
}

function buildBetterC0deWorkspaceSyncListOutput(
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const activeDirectory = resolveBetterC0deWorkspaceActiveDirectory(snapshot)
  const workspaceMap = new Map<
    string,
    { path: string; project: string; threadCount: number; active: boolean }
  >()
  for (const thread of snapshot.threads) {
    const path = thread.worktreePath || thread.projectPath
    if (!path) continue
    const existing = workspaceMap.get(path)
    if (existing) {
      existing.threadCount += 1
      existing.active = existing.active || path === activeDirectory
      continue
    }
    workspaceMap.set(path, {
      path,
      project: thread.projectName || path.split("/").pop() || "Workspace",
      threadCount: 1,
      active: path === activeDirectory,
    })
  }
  const workspaceRows = [...workspaceMap.values()]

  return [
    "# BetterC0de Workspace Sync List",
    "",
    "Compatibility reference: `experimental.workspace.syncList` / `POST /experimental/workspace/sync-list`.",
    "",
    workspaceRows.length === 0
      ? "> No local BetterC0de workspaces are represented by recent chats."
      : "| Active | Project | Path | Threads |",
    workspaceRows.length === 0 ? "" : "|:-------|:--------|:-----|:--------|",
    ...workspaceRows.map(
      (row) =>
        `| ${row.active ? "Yes" : ""} | ${escapeMarkdownTableCell(row.project)} | \`${escapeMarkdownTableCell(row.path)}\` | ${row.threadCount} |`
    ),
    workspaceRows.length === 0 ? "" : "",
    "> BetterC0de tracks workspaces through thread context, worktrees, and `/workspace-list`; this view only mirrors compatibility sync-list semantics.",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function buildBetterC0deWorkspaceWarpOutput(
  args: ReadonlyArray<string>,
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string {
  const request = parseBetterC0deWorkspaceWarpRequest(args)
  const sessionID = request.sessionID
  const matched = sessionID
    ? snapshot.threads.find(
        (thread) =>
          thread.id === sessionID ||
          thread.codexThreadId === sessionID ||
          thread.id.startsWith(sessionID)
      )
    : null

  return [
    "# BetterC0de Workspace Warp",
    "",
    "Compatibility reference: `experimental.workspace.warp` / `POST /experimental/workspace/warp`.",
    "",
    `Workspace id: ${request.id === null ? "`null` (detach to local project)" : request.id ? `\`${escapeMarkdownTableCell(request.id)}\`` : "_missing_"}`,
    `Session id: ${request.sessionID ? `\`${escapeMarkdownTableCell(request.sessionID)}\`` : "_missing_"}`,
    `Copy changes: ${typeof request.copyChanges === "boolean" ? String(request.copyChanges) : "_not specified_"}`,
    matched
      ? `Matched BetterC0de thread: \`${escapeMarkdownTableCell(matched.id)}\` ${escapeMarkdownTableCell(matched.title || "Untitled")}`
      : "",
    request.validation.length ? "\n## Validation\n" : "",
    ...request.validation.map((item) => `- ${item}`),
    request.validation.length ? "" : "",
    "> BetterC0de does not silently move sync history between workspaces from this route. Use `/warp <folder>` to change the active folder, `/workspace-new` for an isolated worktree, or `/resume <thread>` to switch sessions.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseBetterC0deWorkspaceWarpRequest(args: ReadonlyArray<string>): {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
  validation: string[]
} {
  const raw = args.join(" ").trim()
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        id?: unknown
        sessionID?: unknown
        copyChanges?: unknown
      }
      return validateBetterC0deWorkspaceWarpRequest({
        id:
          typeof parsed.id === "string" || parsed.id === null
            ? parsed.id
            : undefined,
        sessionID:
          typeof parsed.sessionID === "string" ? parsed.sessionID : undefined,
        copyChanges:
          typeof parsed.copyChanges === "boolean"
            ? parsed.copyChanges
            : undefined,
      })
    } catch (error) {
      return {
        validation: [
          `Invalid workspace warp JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
        ],
      }
    }
  }

  return validateBetterC0deWorkspaceWarpRequest({
    id: readBetterC0deRouteOption(args, "id", "workspace", "workspace-id"),
    sessionID:
      readBetterC0deRouteOption(args, "sessionID", "session-id", "session") ??
      args.find((arg) => arg && !arg.startsWith("--")),
    copyChanges: readBetterC0deRouteBoolean(
      args,
      "copyChanges",
      "copy-changes"
    ),
  })
}

function validateBetterC0deWorkspaceWarpRequest(input: {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
}): {
  id?: string | null
  sessionID?: string
  copyChanges?: boolean
  validation: string[]
} {
  const validation: string[] = []
  if (input.id !== null && (!input.id || !input.id.trim())) {
    validation.push("Workspace warp requires `id` or explicit `id: null`.")
  }
  if (!input.sessionID?.trim()) {
    validation.push("Workspace warp requires `sessionID`.")
  }
  return { ...input, validation }
}

function parseBetterC0deTuiControlPayload(
  args: ReadonlyArray<string>
): { ok: true; value: unknown } | { ok: false; value: null; error?: string } {
  const raw = args.join(" ").trim()
  if (!raw) return { ok: true, value: {} }
  if (!raw.startsWith("{")) {
    return {
      ok: false,
      value: null,
      error: "TUI control response payload must be JSON when provided.",
    }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: `Invalid TUI control response JSON: ${error instanceof Error ? error.message : "parse failed"}.`,
    }
  }
}

function resolveBetterC0deWorkspaceActiveDirectory(
  snapshot: BetterC0deWorkspaceRouteSnapshot
): string | null {
  const activeThread = snapshot.threads.find(
    (thread) => thread.id === snapshot.activeThreadId
  )
  return (
    snapshot.activeThread?.worktreePath ||
    snapshot.activeThread?.projectPath ||
    activeThread?.worktreePath ||
    activeThread?.projectPath ||
    null
  )
}

function readBetterC0deRouteOption(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | null {
  const flags = new Set(names.map((name) => `--${name}`))
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    for (const flag of flags) {
      if (arg === flag) return args[index + 1]?.trim() || null
      if (arg.startsWith(`${flag}=`)) {
        return arg.slice(flag.length + 1).trim() || null
      }
    }
  }
  return null
}

function readBetterC0deRouteBoolean(
  args: ReadonlyArray<string>,
  ...names: string[]
): boolean | undefined {
  const raw = readBetterC0deRouteOption(args, ...names)
  if (!raw) return undefined
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") {
    return true
  }
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") {
    return false
  }
  return undefined
}

function resolveAuthControlProviderId(
  args: ReadonlyArray<string>
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--provider" || arg === "--provider-id") {
      return args[index + 1]?.trim() || null
    }
    if (arg.startsWith("--provider=")) {
      return arg.slice("--provider=".length).trim() || null
    }
    if (arg.startsWith("--provider-id=")) {
      return arg.slice("--provider-id=".length).trim() || null
    }
    if (!arg.startsWith("-")) return arg.trim() || null
  }
  return null
}

function buildPtyTerminalOutput(
  command: string,
  open: boolean,
  activeThread: ActiveThreadRef
): string {
  const equivalent = ptyEquivalentForCommand(command)
  const cwd = resolveThreadRuntimePath(activeThread)
  return [
    "# Terminal PTY\n",
    `Compatibility reference: \`${equivalent}\`.`,
    "",
    `Terminal panel: **${open ? "Open" : "Closed"}**`,
    cwd ? `Workspace: \`${escapeMarkdownTableCell(cwd)}\`` : "Workspace: -",
    "",
    "BetterC0de uses its integrated terminal PTY UI for interactive terminal sessions. Create a new PTY with `/terminal-new` or `/pty.create`; close/remove sessions from the terminal tab controls.",
  ].join("\n")
}

function ptyEquivalentForCommand(command: string): string {
  const normalized = command.replace(/^\//, "")
  if (normalized === "pty" || normalized === "terminal") return "pty.list"
  if (normalized === "pty-list") return "pty.list"
  if (normalized === "pty-shells") return "pty.shells"
  if (normalized === "pty-get") return "pty.get"
  if (normalized === "pty-connect") return "pty.connect"
  if (normalized === "pty.connect-token") return "pty.connectToken"
  if (normalized === "pty-remove") return "pty.remove"
  return normalized
}

function handleTerminalFontCommand(args: string[]): string {
  const appearance = useAppearanceStore.getState()
  const requested = normalizeTerminalFontCommandValue(args.join(" "))
  if (requested !== null) {
    appearance.set("terminalFontFamily", requested)
  }
  return buildTerminalFontOutput(
    useAppearanceStore.getState().terminalFontFamily,
    requested !== null
  )
}

export function normalizeTerminalFontCommandValue(
  value: string
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const unquoted = trimmed.replace(/^["']|["']$/g, "").trim()
  const normalized = unquoted.toLowerCase()
  if (
    normalized === "system" ||
    normalized === "default" ||
    normalized === "reset" ||
    normalized === "off"
  ) {
    return ""
  }
  return unquoted
}

export function buildTerminalFontOutput(
  font: string,
  changed: boolean
): string {
  return [
    "# Terminal Font\n",
    changed
      ? "Terminal font updated.\n"
      : "Use `/terminal-font JetBrains Mono` or `/terminal-font system`.\n",
    `Current: **${escapeMarkdownTableCell(font || "Terminal default")}**`,
  ].join("\n")
}

function buildVariantsOutput(
  provider: UiProvider | undefined,
  selectedModel: string,
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
): string {
  const model = provider?.models.find((entry) => entry.id === selectedModel)
  const descriptors = model?.capabilities?.optionDescriptors ?? []
  const variantDescriptors = descriptors.filter(
    (descriptor) => descriptor.type === "select"
  )
  if (!provider || !model || variantDescriptors.length === 0) {
    return [
      "# Model Variants\n",
      "> This provider/model does not expose native variant controls yet.",
      "",
      provider
        ? `Selected: **${provider.name}** / \`${selectedModel}\``
        : "No provider selected.",
    ].join("\n")
  }
  const rows = variantDescriptors.flatMap((descriptor) =>
    descriptor.options.map((option) => {
      const current = selectedOptionValue(
        optionSelections,
        descriptor.id,
        descriptor.options.map((entry) => entry.id)
      )
      const fallback = getProviderOptionCurrentValue(descriptor)
      const currentValue =
        current ?? (typeof fallback === "string" ? fallback : undefined)
      return `| ${descriptor.label ?? descriptor.id} | \`${option.id}\` | ${option.label} | ${option.id === currentValue ? "Yes" : "-"} |`
    })
  )
  return [
    "# Model Variants\n",
    `Selected: **${provider.name}** / \`${model.name}\``,
    "",
    "| Option | Value | Label | Current |",
    "|:-------|:------|:------|:--------|",
    ...rows,
  ].join("\n")
}

function firstNonEmptyLine(value: string): string | null {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  return line ?? null
}

function formatObjectKeys(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  return keys.length > 0 ? keys.map((key) => `\`${key}\``).join(", ") : "-"
}

export {
  archivedThreadIdsAfterAction,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
} from "@/hooks/chat-submit/thread-navigation"
export { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
