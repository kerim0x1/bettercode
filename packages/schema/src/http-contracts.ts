import { z } from "zod"
import { endpoint, noBody, type HttpContractMethod } from "./http-endpoint"
import { providerHttpContracts } from "./provider-contracts"
import { shellHttpContracts } from "./shell-contracts"
import { chatHttpContracts } from "./chat-contracts"
import { threadHttpContracts } from "./thread-contracts"
import { threadRewindHttpContracts } from "./thread-rewind-contracts"
import { runtimeHttpContracts } from "./runtime-contracts"
import { remoteHttpContracts } from "./remote-contracts"
import { automationHttpContracts } from "./automation-contracts"
import { githubHttpContracts } from "./github-contracts"

// The provider routes' request schemas and read models.
export {
  providerRefreshModelsSchema,
  providerValidateKeySchema,
  type CliStatus,
  type CliStatusResponse,
  type OpenRouterLiveModel,
  type ProviderInstanceSnapshotFields,
  type ProviderStatus,
} from "./provider-contracts"

// The shell and terminal routes' read models.
export {
  shellClientReleaseSchema,
  type ShellCommandResult,
  type ShellInfo,
  type TerminalPtyEvent,
  type TerminalPtySnapshot,
} from "./shell-contracts"

// The chat helper and permission-policy routes' read models.
export type {
  AgentPermissionEvaluation,
  ChatSessionRotateResult,
  ClaudePermissionRuleEntry,
  PermissionChangeResult,
  SessionPermissionRuleEntry,
} from "./chat-contracts"

// The remaining thread routes' and the usage reports' read models.
export type {
  ProviderUsageReport,
  ThreadActivityFullOutput,
  ThreadCheckpointDiff,
  ThreadCheckpointSummary,
  ThreadDiffsPage,
  ThreadMessageSearchHit,
  ThreadMessageSearchResult,
  ThreadTokenTotals,
  ThreadTurnDiff,
  ThreadUsageBucket,
  ThreadUsageStats,
  UsageDailyPoint,
  UsageEntry,
  UsageInsight,
  UsageLimit,
  UsageList,
  UsagePricing,
  UsageProviderId,
  UsageStatus,
  UsageSummary,
} from "./thread-contracts"

// Edit and resend: the rewind plan and result.
export {
  THREAD_REWIND_MAX_LISTED_FILES,
  type ThreadRewindFileRevertBlocker,
  type ThreadRewindPlan,
  type ThreadRewindResult,
} from "./thread-rewind-contracts"

// The GitHub pull request routes' read models.
export type {
  GitHubAccessStatus,
  GitHubBranchComparison,
  GitHubChangedFile,
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubCheckSummary,
  GitHubConversationItem,
  GitHubMergeMethods,
  GitHubPullRequestActionResult,
  GitHubPullRequestCreateResult,
  GitHubPullRequestDetail,
  GitHubPullRequestDiff,
  GitHubPullRequestLink,
  GitHubPullRequestOverview,
  GitHubPullRequestState,
  GitHubPullRequestSummary,
  GitHubPullRequestWatch,
  GitHubPullRequestWatchList,
  GitHubPullRequestWatchState,
  GitHubPullRequestWorkResult,
  GitHubRepositoryInfo,
  GitHubRepositoryPullRequests,
  GitHubReviewDecision,
  GitHubReviewState,
  GitHubWakeNotice,
} from "./github-contracts"

// The backend runtime routes' read models.
export type {
  DeepgramAccessToken,
  RuntimeCompatDebugInfo,
  RuntimeDebugInfo,
  RuntimeHeapSnapshotResult,
  RuntimeMetricSample,
} from "./runtime-contracts"
import {
  orchestratorSessionSchema,
  orchestratorStartSchema,
  orchestratorThreadSchema,
  orchestratorContextGrantSchema,
  orchestratorContextSchema,
  orchestratorContextKeySchema,
} from "./orchestrator"
import { threadGoalSchema } from "./thread-goal"
import {
  chatAutonomyResponseSchema,
  chatAutonomyResumeSchema,
  chatAutonomyStartSchema,
  chatAutonomyTaskSchema,
  chatAutonomyThreadSchema,
  threadAutonomySchema,
} from "./thread-autonomy"
import { automaticMessageKindSchema, threadResumeSchema } from "./thread-resume"
import {
  chatApprovalSchema,
  chatMessageAttachmentSchema,
  chatGenerateCommitMessageSchema,
  chatInterruptSchema,
  chatPermissionModeSchema,
  chatPlanApprovalSchema,
  chatSendSchema,
  chatSteerSchema,
  chatUserInputRejectSchema,
  chatUserInputSchema,
} from "./chat"
import type { ChatMessage, ChatThread } from "./domain"
import {
  threadActivityResponseSchema,
  threadWorktreeCreateResponseSchema,
} from "./thread-records"

// Shared with the realtime channel; see thread-records.ts.
export {
  threadActivityResponseSchema,
  threadWorktreeCreateResponseSchema,
} from "./thread-records"
import { publicSettingsSchema } from "./public-settings"
import {
  addApiKeySchema,
  apiKeyPoolViewSchema,
  reorderApiKeysSchema,
  updateApiKeySchema,
} from "./api-keys"
import type { ImportedTheme, ImportedThemeSummary } from "./vscode-theme"
import { settingsPatchSchema } from "./settings"
import {
  desktopConfigDirectoryEntryResultSchema,
  desktopConfigDirectoryListSchema,
  desktopConfigDirectoryWriteResultSchema,
  desktopConfigDirectoryWriteSchema,
  desktopConfigHooksDocumentSchema,
  desktopConfigHooksWriteSchema,
  desktopConfigMcpDocumentSchema,
  desktopConfigMcpWriteSchema,
  desktopConfigRemoveResultSchema,
  desktopConfigRulesSchema,
  desktopConfigRulesWriteSchema,
} from "./desktop-config"

// The backend-owned desktop configuration (`/config/*`, desktop-only).
export {
  DESKTOP_CONFIG_LIMITS,
  DESKTOP_SHELL_CAPABILITY_HEADER,
  desktopConfigEntryIdSchema,
  type DesktopConfigDirectoryEntry,
  type DesktopConfigHooksDocument,
  type DesktopConfigMcpDocument,
  type DesktopConfigRules,
} from "./desktop-config"
import {
  conversationImportListSchema,
  conversationImportProviderSchema,
  conversationImportRequestSchema,
  threadImportSourceSchema,
} from "./conversation-import"

// Importing earlier Claude Code and Codex sessions (desktop-only).
export type {
  ConversationImportCandidate,
  ConversationImportList,
  ConversationImportProvider,
  ConversationImportRequest,
  ConversationImportSourceStatus,
  ThreadImportSource,
} from "./conversation-import"
import { threadMetadataUpdateSchema } from "./thread-metadata"

// Its own module, so a client can read the frame without every contract.
export {
  threadMetadataUpdateSchema,
  type ThreadMetadataUpdate,
} from "./thread-metadata"
import {
  gitBranchRenameSchema,
  gitCheckoutSchema,
  gitCheckpointDeleteSchema,
  gitCheckpointDiffSchema,
  gitCheckpointSchema,
  gitCommitSchema,
  gitCwdSchema,
  gitDiscardSchema,
  gitHunkActionSchema,
  gitLogSchema,
  gitOpenEditorSchema,
  gitPathsSchema,
  gitProfileSchema,
  gitPushSchema,
  gitRemoteAddSchema,
  gitStashSchema,
  gitWorktreeCreateSchema,
  gitWorktreeRemoveSchema,
} from "./git"
import {
  workspaceAdoptScratchSchema,
  workspaceContentSearchSchema,
  workspaceContextArtifactResultSchema,
  workspaceContextArtifactSchema,
  workspaceDeleteSchema,
  workspaceEffectiveRulesResultSchema,
  workspaceEffectiveRulesSchema,
  workspaceMapSchema,
  workspaceMkdirSchema,
  workspaceMoveSchema,
  workspaceProjectAgentsSchema,
  workspaceProjectCommandsSchema,
  workspaceProjectConfigSchema,
  workspaceProjectFormatSchema,
  workspaceProjectFormattersSchema,
  workspaceProjectInstructionsSchema,
  workspaceProjectLspServersSchema,
  workspaceProjectMcpServersSchema,
  workspaceProjectPermissionsSchema,
  workspaceProjectPluginsSchema,
  workspaceProjectProvidersSchema,
  workspaceProjectReferencesSchema,
  workspaceProjectSkillsSchema,
  workspaceProjectToolsSchema,
  workspaceQuickOpenSchema,
  workspaceReadSchema,
  workspaceSearchSchema,
  workspaceWriteSchema,
} from "./workspace"
import { workspaceTrustGetSchema } from "./agent-permissions"
import {
  filesystemDrivesResultSchema,
  filesystemListResultSchema,
  filesystemListSchema,
  filesystemSearchResultSchema,
  filesystemSearchSchema,
} from "./filesystem"
import {
  workspaceBinaryFileSchema,
  workspaceFileContentSchema,
  workspaceMapOverviewSchema,
  workspaceOpenResultSchema,
  workspaceProjectAgentSchema,
  workspaceProjectCommandSchema,
  workspaceProjectConfigSettingSchema,
  workspaceProjectFormatResultSchema,
  workspaceProjectFormatterSchema,
  workspaceProjectInstructionSchema,
  workspaceProjectLspServerSchema,
  workspaceProjectMcpServerSchema,
  workspaceProjectPermissionRuleSchema,
  workspaceProjectPluginSchema,
  workspaceProjectProvidersSummarySchema,
  workspaceProjectReferenceSchema,
  workspaceProjectSkillSchema,
  workspaceProjectToolFlagSchema,
  workspaceQuickOpenFileSchema,
  workspaceScratchAdoptResultSchema,
  workspaceSearchEntriesResultSchema,
} from "./workspace-records"

// The workspace read models, for clients that only need their types.
export type {
  WorkspaceBinaryFile,
  WorkspaceFileContent,
  WorkspaceMapDirectory,
  WorkspaceMapExtension,
  WorkspaceMapFile,
  WorkspaceMapFileKind,
  WorkspaceMapOverview,
  WorkspaceOpenResult,
  WorkspaceProjectAgent,
  WorkspaceProjectCommand,
  WorkspaceProjectConfigSetting,
  WorkspaceProjectFormatResult,
  WorkspaceProjectFormatRun,
  WorkspaceProjectFormatter,
  WorkspaceProjectInstruction,
  WorkspaceProjectLspServer,
  WorkspaceProjectMcpServer,
  WorkspaceProjectPermissionRule,
  WorkspaceProjectPlugin,
  WorkspaceProjectProvider,
  WorkspaceProjectProviderAuth,
  WorkspaceProjectProviderModel,
  WorkspaceProjectProvidersSummary,
  WorkspaceProjectReference,
  WorkspaceProjectSkill,
  WorkspaceProjectToolFlag,
  WorkspaceQuickOpenFile,
  WorkspaceScratchAdoptResult,
  WorkspaceSearchEntriesResult,
  WorkspaceSearchEntriesTruncationReason,
  WorkspaceSearchEntry,
} from "./workspace-records"
import {
  threadCheckpointRevertSchema,
  threadMessageSchema,
  threadRenameSchema,
  threadSaveSchema,
  threadSettingsSchema,
  threadUpdateSchema,
  threadWorktreeCreateSchema,
} from "./threads"

const text = z.string()
const count = z.number().nonnegative()
const usageSchema = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    cacheReadTokens: count.optional(),
    cacheCreationTokens: count.optional(),
    cachedInputTokens: count.optional(),
    reasoningOutputTokens: count.optional(),
    totalTokens: count.optional(),
    usedTokens: count.optional(),
    totalProcessedTokens: count.optional(),
    maxTokens: count.optional(),
    toolUses: count.optional(),
    durationMs: count.optional(),
    totalCostUsd: count.optional(),
    compactsAutomatically: z.boolean().optional(),
  })
  .passthrough()
const toolCallSchema = z
  .object({
    id: text,
    name: text,
    input: z.unknown(),
    output: z.unknown().optional(),
    // Older persisted tool calls predate the explicit renderer state.
    state: z
      .enum(["input-available", "output-available", "output-error"])
      .optional(),
    providerKind: text.optional(),
    providerInstanceId: text.optional(),
    turnId: text.optional(),
    sessionId: text.optional(),
    taskId: text.optional(),
    parentTaskId: text.optional(),
    agentId: text.optional(),
    parentAgentId: text.optional(),
    parentToolId: text.optional(),
    startedAt: text.optional(),
    completedAt: text.optional(),
    durationMs: count.optional(),
    error: text.optional(),
    outputPreview: text.optional(),
    outputTruncated: z.boolean().optional(),
    outputBytes: count.optional(),
    outputLineCount: count.optional(),
  })
  .passthrough()
  .transform((call) => ({
    ...call,
    state:
      call.state ??
      (call.error
        ? ("output-error" as const)
        : call.output !== undefined
          ? ("output-available" as const)
          : ("input-available" as const)),
  }))
const questionSchema = z
  .object({
    id: text,
    text,
    options: z.array(z.object({ label: text, description: text.optional() })),
    answer: text.optional(),
    answeredAt: text.optional(),
  })
  .passthrough()

/** Rich read model; write schemas intentionally retain legacy free-form fields. */
export const chatMessageResponseSchema: z.ZodType<ChatMessage> = z
  .object({
    id: text,
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: text,
    createdAt: text,
    turnId: text.nullish(),
    reasoning: text.optional(),
    reasoningDurationMs: count.optional(),
    toolCalls: z.array(toolCallSchema).optional(),
    questions: z.array(questionSchema).optional(),
    answeredQuestions: z
      .array(z.object({ question: text, answer: text }))
      .optional(),
    diffs: z
      .array(
        z
          .object({
            path: text,
            additions: count,
            deletions: count,
            oldText: text,
            newText: text,
            isNew: z.boolean(),
            textOmitted: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
    attachments: z.array(chatMessageAttachmentSchema).optional(),
    usage: usageSchema.optional(),
    modelId: text.optional(),
    systemInstructionCharacters: count.optional(),
    compactedContext: z.boolean().optional(),
    internalContext: z.literal("provider-handoff").optional(),
    automatic: automaticMessageKindSchema.optional(),
    compactionGeneration: count.optional(),
    transcriptTruncated: z.boolean().optional(),
    dispatchStatus: z
      .enum([
        "pending",
        "accepted",
        "completed",
        "failed",
        "uncertain",
        "reverted",
      ])
      .optional(),
    dispatchFailed: z.boolean().optional(),
    sequence: count.optional(),
  })
  .passthrough()
export const chatThreadResponseSchema: z.ZodType<ChatThread> = z
  .object({
    goal: threadGoalSchema.nullable().optional(),
    autonomy: threadAutonomySchema.nullable().optional(),
    resume: threadResumeSchema.nullable().optional(),
    settings: threadSettingsSchema.nullable().optional(),
    importedFrom: threadImportSourceSchema.nullish(),
    id: text,
    title: text,
    projectName: text,
    projectPath: text,
    messages: z.array(chatMessageResponseSchema),
    createdAt: text,
    updatedAt: text,
    envMode: text.nullish(),
    branch: text.nullish(),
    worktreePath: text.nullish(),
    baseBranch: text.nullish(),
    worktreeState: text.nullish(),
    parentThreadId: text.nullish(),
    codexThreadId: text.nullish(),
    messageCount: count.optional(),
    lastModelId: text.nullish(),
    usage: usageSchema.optional(),
    session: z
      .object({
        providerKind: text.nullish(),
        providerInstanceId: text.nullish(),
        providerThreadId: text.nullish(),
        resumeCursor: z.unknown().optional(),
        continuationKey: text.nullish(),
        status: text.nullish(),
        activeTurnId: text.nullish(),
        lastError: text.nullish(),
        runtimeMode: text.nullish(),
        updatedAt: text.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()
const contextCheckpointResponseFields = {
  commandMessageId: text,
  commandContent: text,
  commandCreatedAt: text,
  checkpointMessageId: text,
  checkpointContent: text,
  checkpointCreatedAt: text,
  generation: count,
}

/** The repository's local branches, and the checked-out one ("" when detached). */
export const gitBranchesResponseSchema = z
  .object({ branches: z.array(text), current: text })
  .passthrough()

/** A GitHub pull request, matched to a chat by its head branch. */
export const gitPullRequestSchema = z
  .object({
    number: count,
    title: text,
    url: text,
    /** `open`, `draft`, `merged` or `closed`; read unknown values as closed. */
    state: text,
    branch: text,
    updatedAt: text.nullable(),
  })
  .passthrough()

/**
 * The repository's recent pull requests through the GitHub CLI. `available`
 * is false without a GitHub remote, or when `gh` is missing or signed out.
 */
export const gitPullRequestsResponseSchema = z
  .object({
    available: z.boolean(),
    pullRequests: z.array(gitPullRequestSchema),
  })
  .passthrough()

/** The checked-out branch, its upstream, and the changed files by state. */
export const gitStatusResponseSchema = z
  .object({
    branch: text,
    is_clean: z.boolean(),
    staged: z.array(text),
    modified: z.array(text),
    untracked: z.array(text),
    ahead: count,
    behind: count,
    upstream: text.nullable(),
  })
  .passthrough()

/** A diff to show, cut on a line boundary when it is larger than the desktop sends. */
export const gitDisplayDiffResponseSchema = z
  .object({ diff: text, truncated: z.boolean(), totalBytes: count })
  .passthrough()

export const gitOkResponseSchema = z
  .object({ ok: z.literal(true) })
  .passthrough()

/** What git printed (commit, push, pull). */
export const gitOutputResponseSchema = z.object({ output: text }).passthrough()

export const gitFetchResponseSchema = z
  .object({ status: gitStatusResponseSchema })
  .passthrough()

/** The latest commits, newest first. */
export const gitLogResponseSchema = z
  .object({
    commits: z.array(
      z
        .object({
          hash: text,
          message: text.optional(),
          author: text.optional(),
          date: text.optional(),
        })
        .passthrough()
    ),
  })
  .passthrough()

/** The user's git identity for commit attribution; `null` where unset. */
export interface GitUserProfile {
  name: string | null
  email: string | null
  githubUser: string | null
}

export const gitProfileResponseSchema: z.ZodType<
  GitUserProfile,
  GitUserProfile
> = z
  .object({
    name: text.nullable(),
    email: text.nullable(),
    githubUser: text.nullable(),
  })
  .passthrough()

/** An external tool the desktop can open a folder in ("Open in" menu). */
export interface OpenTarget {
  id: string
  label: string
  group: "editor" | "tool" | "system"
  available: boolean
}

const openTargetSchema: z.ZodType<OpenTarget, OpenTarget> = z
  .object({
    id: text,
    label: text,
    group: z.enum(["editor", "tool", "system"]),
    available: z.boolean(),
  })
  .passthrough()

/** Every tool the desktop probed for; `available` when it is installed. */
export const gitOpenTargetsResponseSchema = z
  .object({ targets: z.array(openTargetSchema) })
  .passthrough()

/** `git rev-parse --is-inside-work-tree` for the folder. */
export const gitIsRepoResponseSchema = z
  .object({ is_repo: z.boolean() })
  .passthrough()

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  prunable: boolean
}

const gitWorktreeInfoSchema: z.ZodType<GitWorktreeInfo, GitWorktreeInfo> = z
  .object({
    path: text,
    head: text.nullable(),
    branch: text.nullable(),
    bare: z.boolean(),
    detached: z.boolean(),
    prunable: z.boolean(),
  })
  .passthrough()

/** A worktree created on a new branch from `base`. */
export interface GitWorktreeCreateResult {
  path: string
  branch: string
  base: string
}

export const gitWorktreeCreateResponseSchema: z.ZodType<
  GitWorktreeCreateResult,
  GitWorktreeCreateResult
> = z.object({ path: text, branch: text, base: text }).passthrough()

export const gitCheckpointHasResponseSchema = z
  .object({ exists: z.boolean() })
  .passthrough()

/**
 * Raw checkpoint captures, restores and deletions are refused (410): the
 * provider turn lifecycle and the thread checkpoint workflows own them.
 */
const refusedResponseSchema = z.never()

/** A hunk staged, discarded or unstaged; `replayed` when it was already done. */
export const gitHunkActionResponseSchema = z
  .object({
    ok: z.literal(true),
    action: z.enum(["accept", "reject", "unstage"]),
    patchId: text,
    applied: z.boolean(),
    replayed: z.boolean().optional(),
  })
  .passthrough()

/**
 * A content search, file by file, with each match's line and a preview.
 * `truncated` when a limit (results, files, bytes, time) cut it short.
 */
export const workspaceContentSearchResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          path: text,
          name: text,
          matches: z.array(
            z
              .object({
                line: count,
                column: count,
                length: count,
                previewColumn: count,
                previewLength: count,
                preview: text,
              })
              .passthrough()
          ),
        })
        .passthrough()
    ),
    truncated: z.boolean(),
    // A string, not an enum: a desktop may add a reason.
    truncatedReason: text.optional(),
  })
  .passthrough()

/**
 * A project the desktop knows (`GET /projects`): one opened as a workspace,
 * or, from older data, one its chats name. Older entries have only a name
 * and a path.
 */
export interface ProjectSummary {
  id?: string
  name: string
  path: string
  createdAt?: string
  updatedAt?: string
}

const projectSummarySchema: z.ZodType<ProjectSummary, ProjectSummary> = z
  .object({
    id: text.optional(),
    name: text,
    path: text,
    createdAt: text.optional(),
    updatedAt: text.optional(),
  })
  .passthrough()

const importedThemeSourceSchema = z
  .object({
    kind: z.enum(["vscode", "cursor", "file", "paste"]),
    label: text,
  })
  .passthrough()

/** An imported color theme with its color tables (`GET /themes/:id`). */
export const importedThemeSchema: z.ZodType<ImportedTheme, ImportedTheme> = z
  .object({
    id: text,
    name: text,
    mode: z.enum(["dark", "light"]),
    source: importedThemeSourceSchema,
    colors: z.record(text, text),
    tokenColors: z.array(
      z
        .object({
          name: text.optional(),
          scope: z.array(text),
          settings: z
            .object({
              foreground: text.optional(),
              background: text.optional(),
              fontStyle: text.optional(),
            })
            .passthrough(),
        })
        .passthrough()
    ),
    semanticTokenColors: z.record(text, z.unknown()),
    semanticHighlighting: z.boolean(),
    importedAt: text,
  })
  .passthrough()

const importedThemeSummarySchema: z.ZodType<
  ImportedThemeSummary,
  ImportedThemeSummary
> = z
  .object({
    id: text,
    name: text,
    mode: z.enum(["dark", "light"]),
    source: importedThemeSourceSchema,
    importedAt: text,
    preview: z.object({ bg: text, sidebar: text, accent: text }).passthrough(),
  })
  .passthrough()

/** A color theme an installed VS Code or Cursor offers (desktop only). */
export interface InstalledThemeInfo {
  id: string
  label: string
  app: "vscode" | "cursor"
  extensionId: string
  extensionName: string
  uiTheme: string | null
}

const installedThemeInfoSchema: z.ZodType<
  InstalledThemeInfo,
  InstalledThemeInfo
> = z
  .object({
    id: text,
    label: text,
    app: z.enum(["vscode", "cursor"]),
    extensionId: text,
    extensionName: text,
    uiTheme: text.nullable(),
  })
  .passthrough()

/**
 * What `POST /themes/import` takes: an installed theme by id, or theme JSON
 * from a file or the clipboard. The route checks the content itself and
 * answers with its own reasons (empty, too large, not a theme).
 */
export const themeImportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installed"), id: text }).passthrough(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string(),
      name: text.optional(),
      source: z.enum(["file", "paste"]).optional(),
      label: text.optional(),
    })
    .passthrough(),
])

export const commitMessageResponseSchema = z
  .object({ subject: text, body: text, branch: text.optional() })
  .passthrough()

/** A checkpoint restore: `reverted: false` comes with the reason. */
export const threadCheckpointRevertResponseSchema = z
  .object({
    reverted: z.boolean(),
    rolledBackTurns: count,
    deletedMessages: count,
    boundaryMessageId: text.nullable(),
    reason: text.optional(),
  })
  .passthrough()

export const chatSendResponseSchema = z
  .object({
    status: z.enum(["streaming", "completed"]),
    turnId: text.min(1),
    replayed: z.literal(true).optional(),
    automaticCompaction: z
      .object({
        reason: z.literal("threshold-reached"),
        ...contextCheckpointResponseFields,
      })
      .optional(),
    providerHandoff: z
      .object({
        reason: z.literal("provider-switch"),
        sourceProvider: text.min(1),
        targetProvider: text.min(1),
        sourceModel: text.min(1),
        ...contextCheckpointResponseFields,
      })
      .optional(),
  })
  .passthrough()
export const approvalResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("acknowledged"),
      applied: z.enum(["live", "queued", "unsupported"]).optional(),
    })
    .passthrough(),
  z.object({ status: z.literal("failed"), error: text.min(1) }).passthrough(),
])
export type ChatSendResponse = z.infer<typeof chatSendResponseSchema>
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>

/**
 * `POST /conversation-imports`: one result per requested session, in order.
 * An imported chat comes with its list row (`thread`), so a client can show
 * it without reloading the chat list.
 */
export const conversationImportRunResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          provider: conversationImportProviderSchema,
          sessionId: text,
          status: z.enum(["imported", "skipped", "failed"]),
          threadId: text.nullable(),
          /** Why it failed, in plain words; never the session's content. */
          error: text.optional(),
          thread: chatThreadResponseSchema.optional(),
        })
        .passthrough()
    ),
  })
  .passthrough()
export type ConversationImportRunResult = z.infer<
  typeof conversationImportRunResponseSchema
>

export const httpContracts = {
  orchestratorStart: endpoint(
    "POST",
    "/orchestrator/start",
    orchestratorStartSchema,
    orchestratorSessionSchema
  ),
  orchestratorStatus: endpoint(
    "POST",
    "/orchestrator/status",
    orchestratorThreadSchema,
    orchestratorSessionSchema.nullable()
  ),
  orchestratorStop: endpoint(
    "POST",
    "/orchestrator/stop",
    orchestratorThreadSchema,
    orchestratorSessionSchema
  ),
  orchestratorContextGrant: endpoint(
    "POST",
    "/orchestrator/context/grant",
    orchestratorContextGrantSchema,
    orchestratorContextSchema
  ),
  orchestratorContextRead: endpoint(
    "POST",
    "/orchestrator/context/read",
    orchestratorContextKeySchema,
    orchestratorContextSchema
  ),
  orchestratorContextRemove: endpoint(
    "POST",
    "/orchestrator/context/remove",
    orchestratorContextKeySchema,
    z.object({ removed: z.literal(true) })
  ),
  chatGoal: endpoint(
    "POST",
    "/chat/goal",
    chatSendSchema,
    z.object({ goal: threadGoalSchema.nullable() })
  ),
  // Autonomous Work (thread-autonomy.ts): start sends the run's opening
  // message as `/chat/send` does and answers with its turn and the run
  // (`null` if it was stopped while the message was admitted).
  chatAutonomyStart: endpoint(
    "POST",
    "/chat/autonomy/start",
    chatAutonomyStartSchema,
    z.object({
      autonomy: threadAutonomySchema.nullable(),
      turn: chatSendResponseSchema,
    })
  ),
  chatAutonomyResume: endpoint(
    "POST",
    "/chat/autonomy/resume",
    chatAutonomyResumeSchema,
    chatAutonomyResponseSchema
  ),
  chatAutonomyPause: endpoint(
    "POST",
    "/chat/autonomy/pause",
    chatAutonomyThreadSchema,
    chatAutonomyResponseSchema
  ),
  chatAutonomyStop: endpoint(
    "POST",
    "/chat/autonomy/stop",
    chatAutonomyThreadSchema,
    chatAutonomyResponseSchema
  ),
  chatAutonomyTask: endpoint(
    "POST",
    "/chat/autonomy/task",
    chatAutonomyTaskSchema,
    chatAutonomyResponseSchema
  ),
  chatSend: endpoint(
    "POST",
    "/chat/send",
    chatSendSchema,
    chatSendResponseSchema
  ),
  chatPersistUser: endpoint(
    "POST",
    "/chat/persist-user",
    chatSendSchema,
    z.object({
      persisted: z.boolean(),
      // With `prepareTurn` (the desktop's provider plugins): the turn's
      // system instruction, built as for `/chat/send`.
      systemInstruction: z.string().nullable().optional(),
      // With `prepareTurn` and a message id: the hooks ran for this
      // message. A `/chat/send` of the same message (the desktop's fallback
      // when the plugin fails) passes it back as `preparedTurnToken`, and
      // they do not run again. Single use, valid for a few minutes.
      preparedTurnToken: z.string().optional(),
    })
  ),
  chatInterrupt: endpoint(
    "POST",
    "/chat/interrupt",
    chatInterruptSchema,
    z.object({ status: z.literal("interrupted") })
  ),
  // A message for the running turn ("steering"). `steered`: the provider
  // took it into the turn and the message is stored. Otherwise nothing was
  // sent or stored: `unsupported` (this provider cannot take input mid-turn;
  // the desktop stops the turn and sends the message next), `not_running`
  // (no turn to add it to) or `not_steerable` (the running step, such as a
  // compaction, takes no input; the message waits for the next turn).
  chatSteer: endpoint(
    "POST",
    "/chat/steer",
    chatSteerSchema,
    z.object({
      status: z.enum([
        "steered",
        "unsupported",
        "not_running",
        "not_steerable",
      ]),
    })
  ),
  chatApproval: endpoint(
    "POST",
    "/chat/approval",
    chatApprovalSchema,
    approvalResponseSchema
  ),
  chatPlanApproval: endpoint(
    "POST",
    "/chat/plan-approval",
    chatPlanApprovalSchema,
    approvalResponseSchema
  ),
  chatPermissionMode: endpoint(
    "POST",
    "/chat/permission-mode",
    chatPermissionModeSchema,
    approvalResponseSchema
  ),
  chatUserInput: endpoint(
    "POST",
    "/chat/user-input",
    chatUserInputSchema,
    approvalResponseSchema
  ),
  chatUserInputReject: endpoint(
    "POST",
    "/chat/user-input/reject",
    chatUserInputRejectSchema,
    approvalResponseSchema
  ),
  listThreads: endpoint(
    "GET",
    "/threads",
    noBody,
    z.array(chatThreadResponseSchema)
  ),
  getThread: endpoint("GET", "/threads/:id", noBody, chatThreadResponseSchema),
  listMessages: endpoint(
    "GET",
    "/threads/:id/messages",
    noBody,
    z.array(chatMessageResponseSchema)
  ),
  // One message with every field, for a renderer that loaded the transcript
  // light (`?light=1`) and now shows a diff or an inline attachment.
  getMessage: endpoint(
    "GET",
    "/threads/:id/messages/:messageId",
    noBody,
    chatMessageResponseSchema
  ),
  listActivities: endpoint(
    "GET",
    "/threads/:id/activities",
    noBody,
    z.array(threadActivityResponseSchema)
  ),
  saveThread: endpoint("POST", "/threads", threadSaveSchema, z.void()),
  updateThread: endpoint("PATCH", "/threads/:id", threadUpdateSchema, z.void()),
  renameThread: endpoint(
    "POST",
    "/threads/:id/title",
    threadRenameSchema,
    threadMetadataUpdateSchema
  ),
  deleteThread: endpoint("DELETE", "/threads/:id", noBody, z.void()),
  createThreadWorktree: endpoint(
    "POST",
    "/threads/:id/worktree",
    threadWorktreeCreateSchema,
    threadWorktreeCreateResponseSchema
  ),
  revertThreadCheckpoint: endpoint(
    "POST",
    "/threads/:id/checkpoint/revert",
    threadCheckpointRevertSchema,
    threadCheckpointRevertResponseSchema
  ),
  gitBranches: endpoint(
    "POST",
    "/git/branches",
    gitCwdSchema,
    gitBranchesResponseSchema
  ),
  gitStatus: endpoint(
    "POST",
    "/git/status",
    gitCwdSchema,
    gitStatusResponseSchema
  ),
  gitDiff: endpoint(
    "POST",
    "/git/diff",
    gitCwdSchema,
    gitDisplayDiffResponseSchema
  ),
  gitDiffStaged: endpoint(
    "POST",
    "/git/diff-staged",
    gitCwdSchema,
    gitDisplayDiffResponseSchema
  ),
  gitStage: endpoint("POST", "/git/stage", gitPathsSchema, gitOkResponseSchema),
  gitUnstage: endpoint(
    "POST",
    "/git/unstage",
    gitPathsSchema,
    gitOkResponseSchema
  ),
  gitStageAll: endpoint(
    "POST",
    "/git/stage-all",
    gitCwdSchema,
    gitOkResponseSchema
  ),
  gitUnstageAll: endpoint(
    "POST",
    "/git/unstage-all",
    gitCwdSchema,
    gitOkResponseSchema
  ),
  gitDiscard: endpoint(
    "POST",
    "/git/discard",
    gitDiscardSchema,
    gitOkResponseSchema
  ),
  gitHunkApply: endpoint(
    "POST",
    "/git/hunks/apply",
    gitHunkActionSchema,
    gitHunkActionResponseSchema
  ),
  gitCommit: endpoint(
    "POST",
    "/git/commit",
    gitCommitSchema,
    gitOutputResponseSchema
  ),
  gitPush: endpoint(
    "POST",
    "/git/push",
    gitPushSchema,
    gitOutputResponseSchema
  ),
  gitPull: endpoint("POST", "/git/pull", gitCwdSchema, gitOutputResponseSchema),
  gitFetch: endpoint(
    "POST",
    "/git/fetch",
    gitCwdSchema,
    gitFetchResponseSchema
  ),
  gitCheckout: endpoint(
    "POST",
    "/git/checkout",
    gitCheckoutSchema,
    gitOkResponseSchema
  ),
  gitLog: endpoint("POST", "/git/log", gitLogSchema, gitLogResponseSchema),
  gitProfile: endpoint(
    "POST",
    "/git/profile",
    gitProfileSchema,
    gitProfileResponseSchema
  ),
  // `?refresh=true` probes again instead of answering from the cache.
  gitOpenTargets: endpoint(
    "GET",
    "/git/open-targets",
    noBody,
    gitOpenTargetsResponseSchema
  ),
  gitOpenEditor: endpoint(
    "POST",
    "/git/open-editor",
    gitOpenEditorSchema,
    gitOkResponseSchema
  ),
  gitInit: endpoint("POST", "/git/init", gitCwdSchema, gitOutputResponseSchema),
  gitIsRepo: endpoint(
    "POST",
    "/git/is-repo",
    gitCwdSchema,
    gitIsRepoResponseSchema
  ),
  gitRemotes: endpoint("POST", "/git/remotes", gitCwdSchema, z.array(text)),
  gitPullRequests: endpoint(
    "POST",
    "/git/pull-requests",
    gitCwdSchema,
    gitPullRequestsResponseSchema
  ),
  gitRemoteAdd: endpoint(
    "POST",
    "/git/remotes/add",
    gitRemoteAddSchema,
    gitOkResponseSchema
  ),
  gitBranchRename: endpoint(
    "POST",
    "/git/branch/rename",
    gitBranchRenameSchema,
    gitOkResponseSchema
  ),
  gitStash: endpoint("POST", "/git/stash", gitStashSchema, gitOkResponseSchema),
  gitStashPop: endpoint(
    "POST",
    "/git/stash-pop",
    gitCwdSchema,
    gitOkResponseSchema
  ),
  gitWorktrees: endpoint(
    "POST",
    "/git/worktrees",
    gitCwdSchema,
    z.array(gitWorktreeInfoSchema)
  ),
  gitWorktreeCreate: endpoint(
    "POST",
    "/git/worktrees/create",
    gitWorktreeCreateSchema,
    gitWorktreeCreateResponseSchema
  ),
  gitWorktreeRemove: endpoint(
    "POST",
    "/git/worktrees/remove",
    gitWorktreeRemoveSchema,
    gitOkResponseSchema
  ),
  gitWorktreePrune: endpoint(
    "POST",
    "/git/worktrees/prune",
    gitCwdSchema,
    gitOkResponseSchema
  ),
  gitCheckpointCapture: endpoint(
    "POST",
    "/git/checkpoints/capture",
    gitCheckpointSchema,
    refusedResponseSchema
  ),
  gitCheckpointHas: endpoint(
    "POST",
    "/git/checkpoints/has",
    gitCheckpointSchema,
    gitCheckpointHasResponseSchema
  ),
  gitCheckpointRestore: endpoint(
    "POST",
    "/git/checkpoints/restore",
    gitCheckpointSchema,
    refusedResponseSchema
  ),
  gitCheckpointDiff: endpoint(
    "POST",
    "/git/checkpoints/diff",
    gitCheckpointDiffSchema,
    gitDisplayDiffResponseSchema
  ),
  gitCheckpointDelete: endpoint(
    "POST",
    "/git/checkpoints/delete",
    gitCheckpointDeleteSchema,
    refusedResponseSchema
  ),
  workspaceWrite: endpoint(
    "POST",
    "/workspace/write",
    workspaceWriteSchema,
    z.void()
  ),
  workspaceMkdir: endpoint(
    "POST",
    "/workspace/mkdir",
    workspaceMkdirSchema,
    z.void()
  ),
  workspaceMove: endpoint(
    "POST",
    "/workspace/move",
    workspaceMoveSchema,
    z.void()
  ),
  workspaceDelete: endpoint(
    "POST",
    "/workspace/delete",
    workspaceDeleteSchema,
    z.void()
  ),
  workspaceSearchContent: endpoint(
    "POST",
    "/workspace/search-content",
    workspaceContentSearchSchema,
    workspaceContentSearchResponseSchema
  ),
  // Registers a folder the user chose; later requests may name it as `cwd`.
  workspaceOpen: endpoint(
    "POST",
    "/workspace/open",
    workspaceTrustGetSchema,
    workspaceOpenResultSchema
  ),
  workspaceSearch: endpoint(
    "POST",
    "/workspace/search",
    workspaceSearchSchema,
    workspaceSearchEntriesResultSchema
  ),
  workspaceQuickOpen: endpoint(
    "POST",
    "/workspace/quick-open",
    workspaceQuickOpenSchema,
    z.array(workspaceQuickOpenFileSchema)
  ),
  workspaceMap: endpoint(
    "POST",
    "/workspace/map",
    workspaceMapSchema,
    workspaceMapOverviewSchema
  ),
  workspaceProjectCommands: endpoint(
    "POST",
    "/workspace/project-commands",
    workspaceProjectCommandsSchema,
    z.array(workspaceProjectCommandSchema)
  ),
  workspaceProjectAgents: endpoint(
    "POST",
    "/workspace/project-agents",
    workspaceProjectAgentsSchema,
    z.array(workspaceProjectAgentSchema)
  ),
  workspaceProjectSkills: endpoint(
    "POST",
    "/workspace/project-skills",
    workspaceProjectSkillsSchema,
    z.array(workspaceProjectSkillSchema)
  ),
  workspaceProjectMcpServers: endpoint(
    "POST",
    "/workspace/project-mcp-servers",
    workspaceProjectMcpServersSchema,
    z.array(workspaceProjectMcpServerSchema)
  ),
  workspaceProjectInstructions: endpoint(
    "POST",
    "/workspace/project-instructions",
    workspaceProjectInstructionsSchema,
    z.array(workspaceProjectInstructionSchema)
  ),
  workspaceEffectiveRules: endpoint(
    "POST",
    "/workspace/effective-rules",
    workspaceEffectiveRulesSchema,
    workspaceEffectiveRulesResultSchema
  ),
  workspaceContextArtifact: endpoint(
    "POST",
    "/workspace/context-artifact",
    workspaceContextArtifactSchema,
    workspaceContextArtifactResultSchema
  ),
  workspaceProjectReferences: endpoint(
    "POST",
    "/workspace/project-references",
    workspaceProjectReferencesSchema,
    z.array(workspaceProjectReferenceSchema)
  ),
  workspaceProjectFormatters: endpoint(
    "POST",
    "/workspace/project-formatters",
    workspaceProjectFormattersSchema,
    z.array(workspaceProjectFormatterSchema)
  ),
  workspaceProjectFormat: endpoint(
    "POST",
    "/workspace/project-format",
    workspaceProjectFormatSchema,
    workspaceProjectFormatResultSchema
  ),
  workspaceProjectLspServers: endpoint(
    "POST",
    "/workspace/project-lsp-servers",
    workspaceProjectLspServersSchema,
    z.array(workspaceProjectLspServerSchema)
  ),
  workspaceProjectPermissions: endpoint(
    "POST",
    "/workspace/project-permissions",
    workspaceProjectPermissionsSchema,
    z.array(workspaceProjectPermissionRuleSchema)
  ),
  workspaceProjectConfig: endpoint(
    "POST",
    "/workspace/project-config",
    workspaceProjectConfigSchema,
    z.array(workspaceProjectConfigSettingSchema)
  ),
  workspaceProjectProviders: endpoint(
    "POST",
    "/workspace/project-providers",
    workspaceProjectProvidersSchema,
    workspaceProjectProvidersSummarySchema
  ),
  workspaceProjectPlugins: endpoint(
    "POST",
    "/workspace/project-plugins",
    workspaceProjectPluginsSchema,
    z.array(workspaceProjectPluginSchema)
  ),
  workspaceProjectTools: endpoint(
    "POST",
    "/workspace/project-tools",
    workspaceProjectToolsSchema,
    z.array(workspaceProjectToolFlagSchema)
  ),
  workspaceRead: endpoint(
    "POST",
    "/workspace/read",
    workspaceReadSchema,
    workspaceFileContentSchema
  ),
  workspaceReadBinary: endpoint(
    "POST",
    "/workspace/read-binary",
    workspaceReadSchema,
    workspaceBinaryFileSchema
  ),
  workspaceScratchAdopt: endpoint(
    "POST",
    "/workspace/scratch/adopt",
    workspaceAdoptScratchSchema,
    workspaceScratchAdoptResultSchema
  ),
  // Any folder on the desktop; a paired device only inside registered roots.
  filesystemList: endpoint(
    "POST",
    "/filesystem/list",
    filesystemListSchema,
    filesystemListResultSchema
  ),
  filesystemSearch: endpoint(
    "POST",
    "/filesystem/search",
    filesystemSearchSchema,
    filesystemSearchResultSchema
  ),
  filesystemDrives: endpoint(
    "GET",
    "/filesystem/drives",
    noBody,
    filesystemDrivesResultSchema
  ),
  listProjects: endpoint(
    "GET",
    "/projects",
    noBody,
    z.array(projectSummarySchema)
  ),
  listThemes: endpoint(
    "GET",
    "/themes",
    noBody,
    z.object({ themes: z.array(importedThemeSummarySchema) }).passthrough()
  ),
  // Desktop only: what the installed editors offer.
  listInstalledThemes: endpoint(
    "GET",
    "/themes/installed",
    noBody,
    z.object({ themes: z.array(installedThemeInfoSchema) }).passthrough()
  ),
  getTheme: endpoint("GET", "/themes/:id", noBody, importedThemeSchema),
  importTheme: endpoint(
    "POST",
    "/themes/import",
    themeImportSchema,
    importedThemeSchema
  ),
  deleteTheme: endpoint(
    "DELETE",
    "/themes/:id",
    noBody,
    z.object({ deleted: z.boolean() }).passthrough()
  ),
  // The desktop owner's API keys for one provider (`:provider`); every
  // change answers with the provider's whole key list.
  apiKeysList: endpoint(
    "GET",
    "/providers/api-keys/:provider",
    noBody,
    apiKeyPoolViewSchema
  ),
  // Back to the provider's own key (environment or CLI configuration).
  apiKeysUseExternal: endpoint(
    "DELETE",
    "/providers/api-keys/:provider",
    noBody,
    apiKeyPoolViewSchema
  ),
  apiKeysAdd: endpoint(
    "POST",
    "/providers/api-keys/:provider",
    addApiKeySchema,
    apiKeyPoolViewSchema
  ),
  apiKeysReorder: endpoint(
    "PUT",
    "/providers/api-keys/:provider/order",
    reorderApiKeysSchema,
    apiKeyPoolViewSchema
  ),
  apiKeysUpdate: endpoint(
    "PATCH",
    "/providers/api-keys/:provider/:id",
    updateApiKeySchema,
    apiKeyPoolViewSchema
  ),
  apiKeysRemove: endpoint(
    "DELETE",
    "/providers/api-keys/:provider/:id",
    noBody,
    apiKeyPoolViewSchema
  ),
  apiKeysRetry: endpoint(
    "POST",
    "/providers/api-keys/:provider/:id/retry",
    noBody,
    apiKeyPoolViewSchema
  ),
  apiKeysTest: endpoint(
    "POST",
    "/providers/api-keys/:provider/:id/test",
    noBody,
    apiKeyPoolViewSchema
  ),
  generateCommitMessage: endpoint(
    "POST",
    "/chat/text-generation/commit-message",
    chatGenerateCommitMessageSchema,
    commitMessageResponseSchema
  ),
  saveMessage: endpoint(
    "POST",
    "/threads/:id/messages",
    threadMessageSchema,
    z.void()
  ),
  getSettings: endpoint("GET", "/settings", noBody, publicSettingsSchema),
  updateSettings: endpoint(
    "PATCH",
    "/settings",
    settingsPatchSchema,
    publicSettingsSchema
  ),
  // The user's rules (`rules.md`), to read. The desktop app edits them
  // through `/config/rules`; a paired browser on a full session shows them
  // from here. A read-only session is refused (`remote_read_only`).
  getUserRules: endpoint(
    "GET",
    "/settings/rules",
    noBody,
    z.object({ content: z.string() }).passthrough()
  ),
  // The desktop configuration the backend owns (desktop-config.ts). Only the
  // desktop's main process may call these; paired devices get a 403.
  desktopConfigMcpGet: endpoint(
    "GET",
    "/config/mcp",
    noBody,
    desktopConfigMcpDocumentSchema
  ),
  desktopConfigMcpPut: endpoint(
    "PUT",
    "/config/mcp",
    desktopConfigMcpWriteSchema,
    desktopConfigMcpDocumentSchema
  ),
  desktopConfigHooksGet: endpoint(
    "GET",
    "/config/hooks",
    noBody,
    desktopConfigHooksDocumentSchema
  ),
  desktopConfigHooksPut: endpoint(
    "PUT",
    "/config/hooks",
    desktopConfigHooksWriteSchema,
    desktopConfigHooksDocumentSchema
  ),
  desktopConfigRulesGet: endpoint(
    "GET",
    "/config/rules",
    noBody,
    desktopConfigRulesSchema
  ),
  desktopConfigRulesPut: endpoint(
    "PUT",
    "/config/rules",
    desktopConfigRulesWriteSchema,
    desktopConfigRulesSchema
  ),
  desktopConfigSkillsList: endpoint(
    "GET",
    "/config/skills",
    noBody,
    desktopConfigDirectoryListSchema
  ),
  desktopConfigSkillGet: endpoint(
    "GET",
    "/config/skills/:id",
    noBody,
    desktopConfigDirectoryEntryResultSchema
  ),
  desktopConfigSkillPut: endpoint(
    "PUT",
    "/config/skills/:id",
    desktopConfigDirectoryWriteSchema,
    desktopConfigDirectoryWriteResultSchema
  ),
  desktopConfigSkillDelete: endpoint(
    "DELETE",
    "/config/skills/:id",
    noBody,
    desktopConfigRemoveResultSchema
  ),
  desktopConfigSubagentsList: endpoint(
    "GET",
    "/config/subagents",
    noBody,
    desktopConfigDirectoryListSchema
  ),
  desktopConfigSubagentGet: endpoint(
    "GET",
    "/config/subagents/:id",
    noBody,
    desktopConfigDirectoryEntryResultSchema
  ),
  desktopConfigSubagentPut: endpoint(
    "PUT",
    "/config/subagents/:id",
    desktopConfigDirectoryWriteSchema,
    desktopConfigDirectoryWriteResultSchema
  ),
  desktopConfigSubagentDelete: endpoint(
    "DELETE",
    "/config/subagents/:id",
    noBody,
    desktopConfigRemoveResultSchema
  ),
  // Earlier Claude Code and Codex sessions on this computer (desktop-only).
  // `?provider=claude|codex`, `?project=<folder>` and `?refresh=1` narrow
  // or redo the scan.
  conversationImportList: endpoint(
    "GET",
    "/conversation-imports",
    noBody,
    conversationImportListSchema
  ),
  conversationImportRun: endpoint(
    "POST",
    "/conversation-imports",
    conversationImportRequestSchema,
    conversationImportRunResponseSchema
  ),
  // Route groups that declare their contracts in a module of their own.
  ...providerHttpContracts,
  ...shellHttpContracts,
  ...chatHttpContracts,
  ...threadHttpContracts,
  ...threadRewindHttpContracts,
  ...runtimeHttpContracts,
  ...remoteHttpContracts,
  ...automationHttpContracts,
  ...githubHttpContracts,
} as const
export type HttpContractName = keyof typeof httpContracts
export type HttpContractResponse<K extends HttpContractName> = z.output<
  (typeof httpContracts)[K]["response"]
>
export type HttpContractRequest<K extends HttpContractName> = z.input<
  (typeof httpContracts)[K]["request"]
>

export interface ContractTransportInput {
  path: string
  method: HttpContractMethod
  body?: unknown
}

/** Never retry here: a failed response may follow an already committed dispatch. */
export async function requestHttpContract<K extends HttpContractName>(
  name: K,
  transport: (input: ContractTransportInput) => Promise<unknown>,
  options: {
    body?: HttpContractRequest<K>
    id?: string
    /** Values for path parameters other than `:id` (`:messageId`). */
    params?: Readonly<Record<string, string>>
    query?: string
  } = {}
): Promise<HttpContractResponse<K>> {
  const contract = httpContracts[name]
  if (contract.path.includes(":id") && !options.id)
    throw new Error("Missing thread id")
  const path =
    contract.path
      .replace(":id", encodeURIComponent(options.id ?? ""))
      .replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, param: string) => {
        const value = options.params?.[param]
        if (!value) throw new Error(`Missing path parameter ${param}`)
        return encodeURIComponent(value)
      }) + (options.query ?? "")
  // Validate without normalizing the wire twice. The server applies aliases and defaults.
  contract.request.parse(options.body)
  const payload = await transport({
    path,
    method: contract.method,
    body: options.body,
  })
  try {
    return contract.response.parse(payload) as HttpContractResponse<K>
  } catch {
    // Never include the payload (settings and message contents are private).
    throw new Error(
      `Invalid backend response for ${contract.method} ${contract.path}`
    )
  }
}
