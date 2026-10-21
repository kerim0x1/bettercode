/**
 * Chat transport: one function per `/chat/*`, `/permissions/*` and thread
 * activity endpoint, nothing else. Turn orchestration (stores, hooks, system
 * instruction, plugin dispatch) lives in `@/lib/chat/send-message`; request
 * shaping in `@/lib/chat/request-builders`. Keep store and hook imports out of
 * this module (eslint `@typescript-eslint/no-restricted-imports`).
 */
import type {
  AgentPermissionBehavior,
  AgentPermissionDestination,
  AgentPermissionGrant,
  ChatAutoCompactionDecisionResult,
  ModelSelection,
  ThreadActivity,
  WorkspaceTrustRecord,
  WorkspaceTrustState,
} from "@betterc0de/schema"
import type {
  ChatSessionRotateResult,
  ClaudePermissionRuleEntry,
  PermissionChangeResult,
  SessionPermissionRuleEntry,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"
export type {
  AgentPermissionGrant,
  WorkspaceTrustRecord,
} from "@betterc0de/schema"
export type {
  ClaudePermissionRuleEntry,
  SessionPermissionRuleEntry,
} from "@betterc0de/schema/http-contracts"

// Every call goes through its shared contract
// (`@betterc0de/schema/http-contracts`): the request is checked before it is
// sent and the response validated before a caller sees it.

/**
 * Body of `/chat/send`, `/chat/goal` and `/chat/persist-user`. All three
 * share `chatSendSchema`, which `invokeContract` validates before sending.
 */
export type ChatDispatchBody = Readonly<Record<string, unknown>>

/** `/chat/send`. Native handoff/compaction may need up to 180s before the
 *  backend admits the turn, hence the long timeout. */
export const postChatSend = (body: ChatDispatchBody) =>
  invokeContract("chatSend", { timeoutMs: 210_000, method: "POST", body })

/** `/chat/goal`: `/goal` commands and goal controls (pause, resume, clear). */
export const postChatGoal = (body: ChatDispatchBody) =>
  invokeContract("chatGoal", { body })

/** `/chat/persist-user`: stores the user message of a plugin-provider turn. */
export const postChatPersistUser = (body: ChatDispatchBody) =>
  invokeContract("chatPersistUser", { method: "POST", body })

/** `/chat/interrupt`. Callers go through `interruptTurn`, which also pauses
 *  queued follow-ups and routes plugin providers. */
export const postChatInterrupt = (body: {
  threadId: string
  providerKind: string
  providerInstanceId?: string | null
}) => invokeContract("chatInterrupt", { method: "POST", body })

/** `/chat/steer`: a message for the running turn. Callers go through
 *  `steerQueuedMessage`, which keeps the message queued until it lands. */
export const postChatSteer = (body: {
  threadId: string
  providerKind: string
  providerInstanceId?: string | null
  message: string
  userMessageId: string
  userMessageContent: string
  userMessageCreatedAt: string
  modelId?: string | null
  attachments: ReadonlyArray<{
    type: string
    filename?: string | null
    mediaType?: string | null
    url: string
  }>
}) => invokeContract("chatSteer", { method: "POST", body })

export const rotateProviderSession = (
  threadId: string,
  checkpoint: {
    messageId: string
    content: string
    createdAt: string
    commandMessageId: string
    commandContent: string
    commandCreatedAt: string
    autoCompactionPrecondition?: {
      compactionGeneration: number
      lastMessageId: string | null
    } | null
  }
): Promise<ChatSessionRotateResult> =>
  invokeContract("chatSessionRotate", {
    body: {
      threadId,
      checkpointMessageId: checkpoint.messageId,
      checkpointContent: checkpoint.content,
      checkpointCreatedAt: checkpoint.createdAt,
      commandMessageId: checkpoint.commandMessageId,
      commandContent: checkpoint.commandContent,
      commandCreatedAt: checkpoint.commandCreatedAt,
      autoCompactionPrecondition: checkpoint.autoCompactionPrecondition ?? null,
    },
  })

export const getAutoCompactionDecision = (input: {
  threadId: string
  cwd?: string | null
  incomingContent: string
  usage?: {
    usedTokens?: number
    maxTokens?: number
    compactsAutomatically?: boolean
  } | null
  modelLimits?: {
    contextTokens?: number
    inputTokens?: number
    outputTokens?: number
  } | null
}): Promise<ChatAutoCompactionDecisionResult> =>
  invokeContract("chatCompactionDecision", { body: input })

export const generateTitle = (userMessage: string): Promise<string> =>
  invokeContract("chatTitle", { body: { userMessage } })

export const extractQuestions = (
  assistantText: string
): Promise<{ text: string; options: string[] }[]> =>
  invokeContract("chatQuestions", { body: { assistantText } })

export const generateCommitMessage = (input: {
  cwd?: string | null
  branch?: string | null
  stagedSummary: string
  stagedPatch: string
  includeBranch?: boolean
  modelSelection?: ModelSelection | null
}): Promise<{ subject: string; body: string; branch?: string }> =>
  invokeContract("generateCommitMessage", {
    // Native generation allows 180s, followed by two 30s helper attempts.
    timeoutMs: 250_000,
    body: input,
  })

export const generatePrContent = (input: {
  cwd?: string | null
  baseBranch: string
  headBranch: string
  commitSummary: string
  diffSummary: string
  diffPatch: string
  modelSelection?: ModelSelection | null
}): Promise<{ title: string; body: string }> =>
  invokeContract("generatePrContent", {
    // The same allowance as a commit message: native generation can take
    // up to 180s before the helper attempts.
    timeoutMs: 250_000,
    body: input,
  })

export const generateBranchName = (input: {
  cwd?: string | null
  message: string
  attachments?: Array<{
    type?: string
    id?: string
    name: string
    mimeType: string
    sizeBytes: number
  }>
  modelSelection?: ModelSelection | null
}): Promise<{ branch: string }> =>
  invokeContract("generateBranchName", { body: input })

export const generateThreadContextSummary = (input: {
  cwd?: string | null
  threadTitle?: string | null
  projectPath?: string | null
  transcript: string
  modelSelection?: ModelSelection | null
}): Promise<{ summary: string }> =>
  invokeContract("generateThreadContextSummary", { body: input })

export const generateSkillContent = (input: {
  name: string
  requirements: string
  cwd?: string | null
  modelSelection?: ModelSelection | null
}): Promise<{ content: string }> =>
  invokeContract("generateSkillContent", { body: input })

export const respondToApproval = (
  threadId: string,
  providerKind: string,
  requestId: string,
  decision: "approve" | "deny",
  providerInstanceId?: string | null,
  options?: {
    /** Deny feedback forwarded to the model verbatim. */
    message?: string
    /** "Always allow" PermissionUpdates echoed into the SDK result. */
    updatedPermissions?: unknown[]
  }
) => {
  const body = {
    threadId,
    providerKind,
    requestId,
    decision,
    providerInstanceId,
    ...(options?.message ? { message: options.message } : {}),
    ...(options?.updatedPermissions && options.updatedPermissions.length > 0
      ? { updatedPermissions: options.updatedPermissions }
      : {}),
  }
  return invokeContract("chatApproval", { args: body, method: "POST", body })
}

export const respondToPlanApproval = (
  threadId: string,
  providerKind: string,
  requestId: string,
  decision: "approve" | "deny",
  providerInstanceId?: string | null,
  options?: {
    /** approve+acceptEdits = auto-accept edits; approve+default = manual approvals. */
    permissionMode?: "acceptEdits" | "default"
    /** Keep-planning feedback for the model. */
    message?: string
  }
) => {
  const body = {
    threadId,
    providerKind,
    requestId,
    decision,
    providerInstanceId,
    ...(options?.permissionMode
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(options?.message ? { message: options.message } : {}),
  }
  return invokeContract("chatPlanApproval", {
    args: body,
    method: "POST",
    body,
  })
}

export const setChatPermissionMode = (
  threadId: string,
  providerKind: string,
  permissionLevel: string,
  providerInstanceId?: string | null
) => {
  const body = { threadId, providerKind, permissionLevel, providerInstanceId }
  return invokeContract("chatPermissionMode", {
    args: body,
    method: "POST",
    body,
  })
}

export const listClaudePermissionRules = (
  cwd?: string | null
): Promise<{ rules: ClaudePermissionRuleEntry[] }> =>
  invokeContract("permissionClaudeRulesList", { body: { cwd } })

export const deleteClaudePermissionRule = (input: {
  source: "userSettings" | "projectSettings" | "localSettings"
  behavior: "allow" | "deny" | "ask"
  rule: string
  cwd?: string | null
}): Promise<PermissionChangeResult> =>
  invokeContract("permissionClaudeRuleDelete", { body: input })

export const listSessionPermissionRules = (
  threadId?: string | null
): Promise<{ rules: SessionPermissionRuleEntry[] }> =>
  invokeContract("permissionSessionRulesList", { body: { threadId } })

export const deleteSessionPermissionRule = (input: {
  threadId: string
  behavior: "allow" | "deny" | "ask"
  rule: string
}): Promise<PermissionChangeResult> =>
  invokeContract("permissionSessionRuleDelete", { body: input })

export const listAgentPermissionGrants = (input: {
  workspacePath?: string | null
  destination?: AgentPermissionDestination
  includeUser?: boolean
}): Promise<{ grants: AgentPermissionGrant[] }> =>
  invokeContract("permissionGrantsList", { body: input })

export const upsertAgentPermissionGrant = (input: {
  destination: AgentPermissionDestination
  workspacePath?: string | null
  toolName: string
  pathScope?: string
  behavior: AgentPermissionBehavior
}): Promise<{ grant: AgentPermissionGrant }> =>
  invokeContract("permissionGrantUpsert", { body: input })

export const deleteAgentPermissionGrant = (
  id: string
): Promise<PermissionChangeResult> =>
  invokeContract("permissionGrantDelete", { body: { id } })

export const getAgentWorkspaceTrust = (
  workspacePath: string
): Promise<{ trust: WorkspaceTrustRecord }> =>
  invokeContract("workspaceTrustGet", { body: { workspacePath } })

export const setAgentWorkspaceTrust = (
  workspacePath: string,
  state: WorkspaceTrustState
): Promise<{ trust: WorkspaceTrustRecord }> =>
  invokeContract("workspaceTrustSet", { body: { workspacePath, state } })

export const respondToUserInput = (
  threadId: string,
  providerKind: string,
  requestId: string,
  answers: Record<string, unknown>,
  providerInstanceId?: string | null
) =>
  invokeContract("chatUserInput", {
    args: { threadId, providerKind, requestId, answers, providerInstanceId },
    method: "POST",
    body: { threadId, providerKind, requestId, answers, providerInstanceId },
  })

export const rejectUserInput = (
  threadId: string,
  providerKind: string,
  requestId: string,
  providerInstanceId?: string | null
) =>
  invokeContract("chatUserInputReject", {
    args: { threadId, providerKind, requestId, providerInstanceId },
    method: "POST",
    body: { threadId, providerKind, requestId, providerInstanceId },
  })

export const loadThreadActivities = (threadId: string) =>
  invokeContract("listActivities", { id: threadId })

export const saveThreadModelSwitchActivity = (
  threadId: string,
  input: {
    activityId: string
    fromModelId: string
    toModelId: string
    createdAt: string
  }
): Promise<ThreadActivity> =>
  invokeContract("saveModelSwitchActivity", { id: threadId, body: input })
