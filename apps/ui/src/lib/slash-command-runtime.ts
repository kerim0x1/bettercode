import {
  PRE_RUNTIME_SLASH_INDEX,
  RUNTIME_SLASH_INDEX,
} from "@/lib/chat-commands/builtin-slash-specs"
import { dispatchSlashCommand } from "@/lib/chat-commands/slash-registry"
import {
  type SlashCommandRun,
  type SlashCommandRuntimeRun,
  type SlashRuntimeContext,
  type SlashRuntimeResult,
  createSlashCommandRun,
} from "@/lib/chat-commands/slash-run"
import { stringifyCliArgs } from "@/lib/cli-parse"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  createPromptHistoryEntry,
  pushPromptHistoryEntry,
} from "@/lib/prompt-history"
import {
  type RuntimeMcpServer,
  type RuntimeSkill,
  type RuntimeSubagent,
  listRuntimeMcps,
  listRuntimeSkills,
  listRuntimeSubagents,
} from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  type WorkspaceProjectCommand,
  type WorkspaceProjectConfigSetting,
  type WorkspaceProjectFormatter,
  type WorkspaceProjectLspServer,
  type WorkspaceProjectPermissionRule,
  type WorkspaceProjectPlugin,
  type WorkspaceProjectProvidersSummary,
  type WorkspaceProjectReference,
  type WorkspaceProjectToolFlag,
  listProjectCommands,
  listProjectConfigSettings,
  listProjectFormatters,
  listProjectLspServers,
  listProjectPermissions,
  listProjectPlugins,
  listProjectProviders,
  listProjectReferences,
  listProjectTools,
} from "@/services/backend/workspaceApi"
import { buildRuntimeSubagentDetailOutput } from "./chat-commands/agent-commands"
import {
  listProjectRuntimeSkills,
  listProjectRuntimeSubagents,
  mergeRuntimeSkills,
  mergeRuntimeSubagents,
} from "./chat-commands/input-context"
import {
  buildRuntimeMcpDetailOutput,
  listProjectRuntimeMcps,
} from "./chat-commands/mcp-actions"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./chat-commands/mcp-commands"
import { isSlashCommand } from "./chat-commands/prompt-commands"
import type { ActiveThreadRef } from "./chat-commands/provider-config"
export {
  buildAgentCreateOutput,
  buildRuntimeSubagentDebugOutput,
  buildRuntimeSubagentDetailOutput,
} from "./chat-commands/agent-commands"
export { buildProjectFormatterConfigOutput } from "./chat-commands/formatter-commands"
export { buildGithubAgentOutput } from "./chat-commands/github-commands"
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
} from "./chat-commands/input-context"
export { buildProjectLspConfigOutput } from "./chat-commands/lsp-commands"
export {
  buildMcpAddOutput,
  buildMcpAuthOutput,
  buildMcpDebugOutput,
  buildMcpServersOutput,
  buildRuntimeMcpDetailOutput,
  stripBetterC0deMcpSlashSubcommand,
} from "./chat-commands/mcp-actions"
export {
  buildMcpLogoutOutput,
  buildMcpResourcesOutput,
  buildProjectMcpConfigOutput,
  resolveRuntimeMcpServer,
} from "./chat-commands/mcp-commands"
export {
  cycleProviderModelAgentSelection,
  cycleProviderModelVariantSelection,
  readActiveProviderComposerSelection,
} from "./chat-commands/model-actions"
export {
  buildPendingApprovalsOutput,
  buildProjectPermissionsConfigOutput,
  buildProjectPermissionsOutput,
  buildUserInputAnswerPayload,
  resolvePendingApprovalReference,
} from "./chat-commands/permission-commands"
export {
  buildPluginInstallOutput,
  buildPluginToggleOutput,
} from "./chat-commands/plugin-commands"
export {
  buildProjectCommandConfigOutput,
  buildProjectReferenceConfigOutput,
  buildRuntimeSkillsOutput,
  projectCommandSubtaskLabel,
} from "./chat-commands/project-commands"
export {
  buildBetterC0deDebugConfigOutput,
  buildProjectInstructionsConfigOutput,
  buildProjectKeybindsOutput,
  buildProjectPluginsOutput,
  buildProjectSkillsConfigOutput,
  buildProjectToolsConfigOutput,
} from "./chat-commands/project-config-commands"
export {
  buildBetterC0deDefaultAgentContext,
  buildBetterC0deDefaultCommandPrompt,
  buildBetterC0dePrTerminalOutput,
} from "./chat-commands/prompt-commands"
export {
  buildProviderAuthOutput,
  buildProviderCatalogOutput,
  buildProviderConnectionOutput,
  cycleModelVariantValue,
  resolveModelVariantValue,
  type ModelVariantCycleResult,
} from "./chat-commands/provider-commands"
export {
  buildProjectProviderConfigOutput,
  buildProjectProvidersOutput,
  type ActiveThreadRef,
} from "./chat-commands/provider-config"
export {
  buildPendingUserInputsOutput,
  buildThreadTodosOutputFromItems,
  resolvePendingUserInputReference,
} from "./chat-commands/request-actions"
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
} from "./chat-commands/runtime-commands"
export { buildBetterC0deRuntimeConfigOutput } from "./chat-commands/runtime-config"
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
} from "./chat-commands/session-commands"
export {
  buildDiffStyleOutput,
  buildNativeNotificationsOutput,
  executeRemoteAccessCommand,
  resolveDiffStyleArg,
} from "./chat-commands/settings-actions"
export {
  lastAssistantMessageText,
  resolveInterruptProviderKind,
  sanitizeThreadRenameTitle,
} from "./chat-commands/thread-actions"
export {
  betterC0deImportUrlCandidates,
  buildDebugSnapshotMarkdown,
  buildExportThreadOutput,
  buildImportThreadOutput,
  buildThreadDiffMarkdown,
  buildThreadImportDraftFromJsonPayload,
  buildThreadJsonExportPayload,
  type ThreadImportDraft,
} from "./chat-commands/thread-export"
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
} from "./chat-commands/thread-inspection"
export { buildProjectTuiConfigWriteOutput } from "./chat-commands/tui-commands"
export {
  buildFindFilesOutput,
  buildFindTextOutput,
  buildVcsApplyOutput,
  buildVcsDiffOutput,
  buildVcsOutput,
  buildVcsStatusOutput,
} from "./chat-commands/vcs-commands"
export {
  archivedThreadIdsAfterAction,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
} from "@/lib/chat-commands/thread-navigation"
export { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
export { buildProviderOrganizationOutput } from "@/lib/chat-commands/account-commands"
export { buildRuntimeSubagentListOutput } from "@/lib/chat-commands/agent-slash-specs"
export { buildAppLogOutput } from "@/lib/chat-commands/app-slash-specs"
export {
  buildTerminalFontOutput,
  normalizeTerminalFontCommandValue,
} from "@/lib/chat-commands/appearance-slash-specs"
export {
  buildBetterC0deAuthControlOutput,
  buildBetterC0deInternalRouteOutput,
  buildBetterC0deLifecycleRouteOutput,
  buildBetterC0deTuiControlRouteOutput,
} from "@/lib/chat-commands/compat-route-commands"
export {
  buildBetterC0deSyncRouteOutput,
  buildBetterC0deWorkspaceRouteOutput,
} from "@/lib/chat-commands/compat-sync-commands"
export type {
  BetterC0deSyncRouteSnapshot,
  BetterC0deWorkspaceRouteSnapshot,
} from "@/lib/chat-commands/compat-sync-commands"
export { cycleChatMode } from "@/lib/chat-commands/composer-slash-specs"
export {
  buildBetterC0deDbPathOutput,
  buildRuntimeDebugInfoOutput,
  buildRuntimeDebugPathsOutput,
  buildRuntimeHeapSnapshotOutput,
} from "@/lib/chat-commands/debug-info-commands"
export {
  buildBetterC0deDebugUtilityOutput,
  parseStatsCommandOptions,
} from "@/lib/chat-commands/debug-slash-specs"
export {
  buildProjectFormatOutput,
  buildProjectLspServersOutput,
} from "@/lib/chat-commands/project-slash-specs"
export { buildComposerInputActionsOutput } from "@/lib/chat-commands/prompt-slash-specs"
export { buildBetterC0deSessionCliOutput } from "@/lib/chat-commands/session-cli-commands"
export { parseSessionListOptions } from "@/lib/chat-commands/session-list-slash-specs"
export { dispatchPrefilledTerminalCommand } from "@/lib/chat-commands/slash-command-actions"
export {
  stripBetterC0deAgentSlashSubcommand,
  stripBetterC0deConsoleSlashSubcommand,
  stripBetterC0deGithubSlashSubcommand,
  stripBetterC0deProviderSlashSubcommand,
  stripBetterC0deSessionSlashSubcommand,
} from "@/lib/chat-commands/slash-subcommands"
export type { ChatSubmitPayload } from "@/lib/chat/types"
export type {
  SlashRuntimeContext,
  SlashRuntimeResult,
} from "@/lib/chat-commands/slash-run"

// Built-in slash command dispatch. Each command family is a `{ names, run }`
// spec next to its builders in lib/chat-commands (*-slash-specs.ts); the
// ordered spec lists live in builtin-slash-specs.ts. The submit hook imports
// this runtime on demand, so command implementation is not startup work. The
// re-exports above keep existing import sites working.

export async function runRegisteredSlashCommand(
  context: SlashRuntimeContext
): Promise<SlashRuntimeResult | null> {
  const run = createSlashCommandRun(context)
  const preRuntimeResult = await dispatchSlashCommand(
    run.cmd,
    run,
    PRE_RUNTIME_SLASH_INDEX
  )
  if (preRuntimeResult) return preRuntimeResult
  const runtimeRun = await loadSlashCommandRuntime(run)
  const runtimeResult = await dispatchSlashCommand(
    runtimeRun.cmd,
    runtimeRun,
    RUNTIME_SLASH_INDEX
  )
  if (runtimeResult) return runtimeResult
  return finishSlashCommandRun(runtimeRun)
}

/**
 * Loads the runtime MCPs, skills and subagents and the workspace project
 * config once for the runtime-phase specs. It runs for every command that no
 * pre-runtime spec ended, as the command ladder did.
 */
async function loadSlashCommandRuntime(
  run: SlashCommandRun
): Promise<SlashCommandRuntimeRun> {
  const { activeThread } = run
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
  return Object.assign(run, {
    mcpList,
    skillList,
    subagentList,
    projectSubagentList,
    projectCommandList,
    projectReferenceList,
    projectFormatterList,
    projectLspServerList,
    projectPermissionList,
    projectConfigList,
    projectProvidersSummary,
    projectPluginList,
    projectToolList,
  })
}

/**
 * A command no spec produced output for can still name a runtime MCP, skill
 * or subagent; without output it is left to the submit flow.
 */
function finishSlashCommandRun(
  run: SlashCommandRuntimeRun
): SlashRuntimeResult | null {
  const { cmd, mcpList, skillList, subagentList } = run
  if (!run.output) {
    const matchedMcp = mcpList.find((m) => cmd === `/${m.id}`)
    if (matchedMcp) {
      run.output = buildRuntimeMcpDetailOutput(matchedMcp)
    }
    const matchedSkill = skillList.find((s) => cmd === `/${s.id}`)
    if (matchedSkill && !run.output) {
      run.output = [
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
    if (matchedSubagent && !run.output) {
      run.output = buildRuntimeSubagentDetailOutput(matchedSubagent)
    }
  }
  if (!run.output) return null
  return {
    handled: true,
    output: run.output,
    threadId: run.threadId,
    outputMessageId: run.outputMessageId,
    outputMessageCreatedAt: run.outputMessageCreatedAt,
    outputMessageCompactionGeneration: run.outputMessageCompactionGeneration,
    outputUserMessageId: run.outputUserMessageId,
    outputUserMessageCreatedAt: run.outputUserMessageCreatedAt,
  }
}

// Prompt helpers the submit hook loads together with this runtime.

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
