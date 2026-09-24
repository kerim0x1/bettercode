import { z } from "zod"
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
  chatApprovalSchema,
  chatAttachmentSchema,
  chatGenerateCommitMessageSchema,
  chatInterruptSchema,
  chatPermissionModeSchema,
  chatPlanApprovalSchema,
  chatSendSchema,
  chatUserInputRejectSchema,
  chatUserInputSchema,
} from "./chat"
import type { ChatMessage, ChatThread, ThreadActivity } from "./domain"
import { publicSettingsSchema } from "./public-settings"
import { settingsPatchSchema } from "./settings"
import { threadMetadataUpdateSchema } from "./thread-metadata"

// Its own module, so a client can read the frame without every contract.
export {
  threadMetadataUpdateSchema,
  type ThreadMetadataUpdate,
} from "./thread-metadata"
import {
  gitCheckoutSchema,
  gitCommitSchema,
  gitCwdSchema,
  gitDiscardSchema,
  gitHunkActionSchema,
  gitLogSchema,
  gitPathsSchema,
  gitPushSchema,
} from "./git"
import {
  threadCheckpointRevertSchema,
  threadMessageSchema,
  threadMetaSchema,
  threadRenameSchema,
  threadSaveSchema,
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
          })
          .passthrough()
      )
      .optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
    usage: usageSchema.optional(),
    modelId: text.optional(),
    systemInstructionCharacters: count.optional(),
    compactedContext: z.boolean().optional(),
    internalContext: z.literal("provider-handoff").optional(),
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
  })
  .passthrough()
export const chatThreadResponseSchema: z.ZodType<ChatThread> = z
  .object({
    goal: threadGoalSchema.nullable().optional(),
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
export const threadActivityResponseSchema: z.ZodType<ThreadActivity> = z
  .object({
    id: text,
    threadId: text,
    turnId: text.nullish(),
    providerInstanceId: text.nullish(),
    kind: text,
    tone: z.enum(["thinking", "tool", "info", "approval", "error"]),
    summary: text,
    payload: z.unknown(),
    sequence: count.nullish(),
    createdAt: text,
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

export const commitMessageResponseSchema = z
  .object({ subject: text, body: text, branch: text.optional() })
  .passthrough()

/** A chat's own git worktree, on a new branch from `baseBranch`. */
export const threadWorktreeCreateResponseSchema = z
  .object({
    worktreeId: text,
    threadId: text,
    worktreePath: text,
    branch: text,
    baseBranch: text,
    headSha: text.nullable(),
  })
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

type HttpContractMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

function endpoint<I extends z.ZodType, O extends z.ZodType>(
  method: HttpContractMethod,
  path: string,
  request: I,
  response: O
) {
  return { method, path, request, response }
}
const noBody = z.undefined()
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
    z.object({ persisted: z.boolean() })
  ),
  chatInterrupt: endpoint(
    "POST",
    "/chat/interrupt",
    chatInterruptSchema,
    z.object({ status: z.literal("interrupted") })
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
  listActivities: endpoint(
    "GET",
    "/threads/:id/activities",
    noBody,
    z.array(threadActivityResponseSchema)
  ),
  saveThread: endpoint("POST", "/threads", threadSaveSchema, z.void()),
  updateThread: endpoint("PATCH", "/threads/:id", threadMetaSchema, z.void()),
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
  options: { body?: HttpContractRequest<K>; id?: string; query?: string } = {}
): Promise<HttpContractResponse<K>> {
  const contract = httpContracts[name]
  if (contract.path.includes(":id") && !options.id)
    throw new Error("Missing thread id")
  const path =
    contract.path.replace(":id", encodeURIComponent(options.id ?? "")) +
    (options.query ?? "")
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
