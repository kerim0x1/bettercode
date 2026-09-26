import { z } from "zod"
import {
  modelSelectionSchema,
  type ModelCapabilities,
  type ModelSelection,
} from "./model-selection"
import { sourceProposedPlanReferenceSchema } from "./proposed-plan"
import { chatAttachmentSchema, type ChatAttachment } from "./chat-attachment"
import { designBriefSchema } from "./design"
import { turnDiffFileSummarySchema } from "./checkpointing"
import type {
  ProviderAgent,
  ProviderCatalogEntry,
  ProviderModelCatalog,
  ProviderSkill,
  ProviderSlashCommand,
  ProviderTool,
} from "./provider-instance"

export type ThreadId = string & { readonly __brand: "ThreadId" }
export type TurnId = string & { readonly __brand: "TurnId" }
export type EventId = string & { readonly __brand: "EventId" }
export type ApprovalRequestId = string & {
  readonly __brand: "ApprovalRequestId"
}
export type RuntimeItemId = string & { readonly __brand: "RuntimeItemId" }

export const threadId = (s: string): ThreadId => s as ThreadId
export const turnId = (s: string): TurnId => s as TurnId
export const eventId = (s: string): EventId => s as EventId
export const approvalRequestId = (s: string): ApprovalRequestId =>
  s as ApprovalRequestId
export const runtimeItemId = (s: string): RuntimeItemId => s as RuntimeItemId

export const providerKindSchema = z.enum([
  "codex",
  "codex_cli",
  "claude",
  "claudeAgent",
  "anthropic_cli",
  "cursor",
  "betterc0de",
  "BetterC0de",
  // The local `opencode` binary's headless server (v1 + v2 HTTP surfaces).
  "opencode_cli",
  "openai",
  "anthropic",
  "openrouter",
  "grok",
  // xAI's Grok Build CLI (`grok agent stdio`, ACP). Distinct from "grok",
  // which is the legacy xAI API-key adapter.
  "grok_cli",
  "google",
  "lmstudio",
])
export type ProviderKind = z.infer<typeof providerKindSchema>

export const streamKindSchema = z.enum([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "command_output",
  "file_change_output",
  "plan_text",
  "plan_delta",
  "unknown",
])
export type StreamKind = z.infer<typeof streamKindSchema>

export const requestKindSchema = z.enum([
  "tool_approval",
  "user_input",
  "plan_approval",
])
export type RequestKind = z.infer<typeof requestKindSchema>

export const runtimeEventRawSourceSchema = z.union([
  z.enum([
    "codex.app-server.notification",
    "codex.app-server.request",
    "codex.eventmsg",
    "claude.sdk.message",
    "claude.sdk.permission",
    "codex.sdk.thread-event",
    "betterc0de.sdk.event",
    "BetterC0de.sdk.event",
    "opencode.sdk.event",
    "acp.jsonrpc",
  ]),
  z.string().regex(/^acp\..*\.extension$/),
])
export type RuntimeEventRawSource = z.infer<typeof runtimeEventRawSourceSchema>

const trimmedNonEmptyStringSchema = z.string().trim().min(1)

export const runtimeEventRawSchema = z
  .object({
    source: runtimeEventRawSourceSchema,
    method: trimmedNonEmptyStringSchema.optional(),
    messageType: trimmedNonEmptyStringSchema.optional(),
    payload: z.unknown(),
  })
  .superRefine((value, ctx) => {
    // Zod 4 treats a missing `z.unknown()` object key like `undefined`.
    // Raw provider envelopes must still carry the payload field.
    if (!Object.prototype.hasOwnProperty.call(value, "payload")) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "payload is required",
      })
    }
  })
export type RuntimeEventRaw = z.infer<typeof runtimeEventRawSchema>

export const providerRefsSchema = z.object({
  providerTurnId: trimmedNonEmptyStringSchema.optional(),
  providerItemId: trimmedNonEmptyStringSchema.optional(),
  providerRequestId: trimmedNonEmptyStringSchema.optional(),
})
export type ProviderRefs = z.infer<typeof providerRefsSchema>

const canonicalRequestTypeSchema = z
  .enum([
    "command_execution_approval",
    "file_read_approval",
    "file_change_approval",
    "apply_patch_approval",
    "exec_command_approval",
    "tool_user_input",
    "dynamic_tool_call",
    "auth_tokens_refresh",
    "unknown",
  ])
  .or(z.string())

const canonicalItemTypeSchema = z
  .enum([
    "user_message",
    "assistant_message",
    "reasoning",
    "plan",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "dynamic_tool_call",
    "collab_agent_tool_call",
    "web_search",
    "image_view",
    "review_entered",
    "review_exited",
    "context_compaction",
    "error",
    "unknown",
  ])
  .or(z.string())

const runtimeItemStatusSchema = z
  .enum(["pending", "running", "completed", "failed", "cancelled"])
  .or(z.string())

const itemLifecyclePayloadSchema = z.object({
  itemType: canonicalItemTypeSchema,
  status: runtimeItemStatusSchema.optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  data: z.unknown().optional(),
})

const contentDeltaPayloadSchema = z.object({
  streamKind: streamKindSchema,
  delta: z.string(),
  contentIndex: z.number().int().optional(),
  summaryIndex: z.number().int().optional(),
})

const messageDeltaPayloadSchema = z.object({
  streamKind: streamKindSchema.optional(),
  delta: z.string(),
  contentIndex: z.number().int().optional(),
  summaryIndex: z.number().int().optional(),
})

const contentReplacePayloadSchema = z.object({
  streamKind: streamKindSchema.optional(),
  text: z.string(),
  contentIndex: z.number().int().optional(),
  summaryIndex: z.number().int().optional(),
})

const reasoningDeltaPayloadSchema = z.object({
  streamKind: z.enum(["reasoning_text", "reasoning_summary_text"]).optional(),
  delta: z.string(),
  contentIndex: z.number().int().optional(),
  summaryIndex: z.number().int().optional(),
})

const reasoningReplacePayloadSchema = z.object({
  streamKind: z.enum(["reasoning_text", "reasoning_summary_text"]).optional(),
  text: z.string(),
  contentIndex: z.number().int().optional(),
  summaryIndex: z.number().int().optional(),
})

export const userInputQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
})
export const userInputQuestionSchema = z.object({
  id: z.string().optional(),
  header: z.string().optional(),
  question: z.string().optional(),
  text: z.string().optional(),
  options: z
    .array(z.union([z.string(), userInputQuestionOptionSchema]))
    .optional(),
  multiSelect: z.boolean().optional(),
})
export type UserInputQuestion = z.infer<typeof userInputQuestionSchema>

// ── Permission updates (mirror of the Claude Agent SDK `PermissionUpdate`) ──
// Carried on tool-approval requests as `suggestions` and echoed back on
// approval decisions as `updatedPermissions` ("always allow" persistence).
export const permissionRuleValueSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
})
export type PermissionRuleValue = z.infer<typeof permissionRuleValueSchema>

export const permissionBehaviorSchema = z.enum(["allow", "deny", "ask"])
export type PermissionBehavior = z.infer<typeof permissionBehaviorSchema>

export const permissionUpdateDestinationSchema = z.enum([
  "userSettings",
  "projectSettings",
  "localSettings",
  "session",
  "cliArg",
])
export type PermissionUpdateDestination = z.infer<
  typeof permissionUpdateDestinationSchema
>

export const sdkPermissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
])
export type SdkPermissionModeValue = z.infer<typeof sdkPermissionModeSchema>

export const permissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addRules"),
    rules: z.array(permissionRuleValueSchema),
    behavior: permissionBehaviorSchema,
    destination: permissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("replaceRules"),
    rules: z.array(permissionRuleValueSchema),
    behavior: permissionBehaviorSchema,
    destination: permissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("removeRules"),
    rules: z.array(permissionRuleValueSchema),
    behavior: permissionBehaviorSchema,
    destination: permissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("setMode"),
    mode: sdkPermissionModeSchema,
    destination: permissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(z.string()),
    destination: permissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("removeDirectories"),
    directories: z.array(z.string()),
    destination: permissionUpdateDestinationSchema,
  }),
])
export type PermissionUpdate = z.infer<typeof permissionUpdateSchema>

const userInputRequestedPayloadSchema = z.object({
  questions: z.array(userInputQuestionSchema),
})

const userInputResolvedPayloadSchema = z.object({
  answers: z.record(z.string(), z.unknown()).default({}),
})

const requestOpenedPayloadSchema = z.object({
  requestType: canonicalRequestTypeSchema,
  detail: z.string().optional(),
  args: z.unknown().optional(),
})

const requestResolvedPayloadSchema = z.object({
  requestType: canonicalRequestTypeSchema,
  decision: z.string().optional(),
  resolution: z.unknown().optional(),
})

const taskStartedPayloadSchema = z.object({
  taskId: z.string(),
  description: z.string().optional(),
  taskType: z.string().optional(),
})

const taskProgressPayloadSchema = z.object({
  taskId: z.string(),
  description: z.string(),
  summary: z.string().optional(),
  usage: z.unknown().optional(),
  lastToolName: z.string().optional(),
})

const taskCompletedPayloadSchema = z.object({
  taskId: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string().optional(),
  usage: z.unknown().optional(),
})

const hookStartedPayloadSchema = z.object({
  hookId: z.string(),
  hookName: z.string(),
  hookEvent: z.string(),
  // Guardrail extensions (in-process agent guard rules; all optional so
  // provider-native hook events keep validating unchanged):
  ruleId: z.string().optional(),
  ruleName: z.string().optional(),
  ruleAction: z.string().optional(),
  tool: z.string().optional(),
  matchedPattern: z.string().optional(),
  source: z.enum(["guardrail", "provider"]).optional(),
})

const hookProgressPayloadSchema = z.object({
  hookId: z.string(),
  output: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  ruleId: z.string().optional(),
  ruleName: z.string().optional(),
  source: z.enum(["guardrail", "provider"]).optional(),
})

const hookCompletedPayloadSchema = z.object({
  hookId: z.string(),
  outcome: z.enum(["success", "error", "cancelled"]),
  output: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
  ruleId: z.string().optional(),
  ruleName: z.string().optional(),
  ruleAction: z.string().optional(),
  tool: z.string().optional(),
  decision: z.enum(["deny", "allow", "ask", "none"]).optional(),
  source: z.enum(["guardrail", "provider"]).optional(),
})

// ── Pipeline events (BetterC0de PipelineRunner; providerKind "betterc0de") ──
const pipelineRunStartedPayloadSchema = z.object({
  runId: z.string(),
  pipelineId: z.string(),
  pipelineName: z.string(),
  totalSteps: z.number().int().positive(),
  userGoal: z.string().optional(),
})

const pipelineStepStartedPayloadSchema = z.object({
  runId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepId: z.string(),
  stepName: z.string(),
  totalSteps: z.number().int().positive(),
  chatMode: z.string().optional(),
  model: z.string().optional(),
  permissionLevel: z.string().optional(),
  promptPreview: z.string().optional(),
})

const pipelineStepCompletedPayloadSchema = z.object({
  runId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepId: z.string(),
  stepName: z.string(),
  status: z.enum(["completed", "failed", "skipped", "cancelled"]),
  turnId: z.string().optional(),
  outputPreview: z.string().optional(),
  error: z.string().optional(),
})

const pipelineRunPausedPayloadSchema = z.object({
  runId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  reason: z.enum(["stop_point", "user", "restart", "step_failed"]),
})

const pipelineRunResumedPayloadSchema = z.object({
  runId: z.string(),
  stepIndex: z.number().int().nonnegative(),
})

const pipelineRunCompletedPayloadSchema = z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  error: z.string().optional(),
})

const toolProgressPayloadSchema = z.object({
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
  summary: z.string().optional(),
  elapsedSeconds: z.number().optional(),
})

const toolSummaryPayloadSchema = z.object({
  summary: z.string(),
  precedingToolUseIds: z.array(z.string()).optional(),
})

const authStatusPayloadSchema = z.object({
  isAuthenticating: z.boolean().optional(),
  output: z.array(z.string()).optional(),
  error: z.string().optional(),
})

const accountUpdatedPayloadSchema = z.object({
  account: z.unknown(),
})

const accountRateLimitsUpdatedPayloadSchema = z.object({
  rateLimits: z.unknown(),
})

const mcpStatusUpdatedPayloadSchema = z.object({
  status: z.unknown(),
})

const mcpOauthCompletedPayloadSchema = z.object({
  success: z.boolean(),
  name: z.string().optional(),
  error: z.string().optional(),
})

const modelReroutedPayloadSchema = z.object({
  fromModel: z.string(),
  toModel: z.string(),
  reason: z.string(),
})

const configWarningPayloadSchema = z.object({
  summary: z.string(),
  details: z.string().optional(),
  path: z.string().optional(),
  range: z.unknown().optional(),
})

const providerMetadataChangedPayloadSchema = z.object({
  metadataKind: z
    .enum(["skills", "slashCommands", "agents", "tools", "models", "all"])
    .or(z.string())
    .default("all"),
  providerKind: providerKindSchema.optional(),
  providerInstanceId: z.string().trim().min(1).optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  cwd: z.string().nullable().optional(),
  range: z.unknown().optional(),
})

const deprecationNoticePayloadSchema = z.object({
  summary: z.string(),
  details: z.string().optional(),
})

const filesPersistedPayloadSchema = z.object({
  files: z.array(
    z.object({
      filename: z.string(),
      fileId: z.string(),
    })
  ),
  failed: z
    .array(
      z.object({
        filename: z.string(),
        error: z.string(),
      })
    )
    .optional(),
})

export const toolDeniedPayloadSchema = z.object({
  toolName: trimmedNonEmptyStringSchema,
  toolUseId: trimmedNonEmptyStringSchema.optional(),
  reason: trimmedNonEmptyStringSchema.optional(),
  agentId: trimmedNonEmptyStringSchema.optional(),
})
export type ToolDeniedPayload = z.infer<typeof toolDeniedPayloadSchema>

const sessionStartedPayloadSchema = z.object({
  message: z.string().optional(),
  resume: z.unknown().optional(),
})

const sessionConfiguredPayloadSchema = z.object({
  config: z.record(z.string(), z.unknown()),
})

const sessionStateSchema = z
  .enum([
    "starting",
    "ready",
    "running",
    "waiting",
    "closing",
    "closed",
    "stopped",
    "error",
  ])
  .or(z.string())

const sessionStateChangedPayloadSchema = z.object({
  state: sessionStateSchema,
  reason: z.string().optional(),
  detail: z.unknown().optional(),
})

const sessionExitedPayloadSchema = z.object({
  reason: z.string().optional(),
  recoverable: z.boolean().optional(),
  exitKind: z.enum(["graceful", "error"]).or(z.string()).optional(),
})

const threadStartedPayloadSchema = z.object({
  providerThreadId: z.string().optional(),
})

const threadStateChangedPayloadSchema = z.object({
  state: z
    .enum(["active", "archived", "closed", "compacted", "error"])
    .or(z.string()),
  detail: z.unknown().optional(),
})

const threadMetadataUpdatedPayloadSchema = z.object({
  name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const threadTokenUsageSnapshotSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  totalProcessedTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  lastUsedTokens: z.number().int().nonnegative().optional(),
  lastInputTokens: z.number().int().nonnegative().optional(),
  lastCachedInputTokens: z.number().int().nonnegative().optional(),
  lastOutputTokens: z.number().int().nonnegative().optional(),
  lastReasoningOutputTokens: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  totalCostUsd: z.number().finite().nonnegative().optional(),
  compactsAutomatically: z.boolean().optional(),
})

const threadTokenUsageUpdatedPayloadSchema = z.object({
  usage: threadTokenUsageSnapshotSchema,
})

const threadRealtimeStartedPayloadSchema = z.object({
  realtimeSessionId: z.string().optional(),
})

const threadRealtimeItemAddedPayloadSchema = z.object({
  item: z.unknown(),
})

const threadRealtimeAudioDeltaPayloadSchema = z.object({
  audio: z.unknown(),
})

const threadRealtimeErrorPayloadSchema = z.object({
  message: z.string(),
})

const threadRealtimeClosedPayloadSchema = z.object({
  reason: z.string().optional(),
})

const turnStartedPayloadSchema = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  dispatchTurnId: z.string().optional(),
})

const runtimeTurnStateSchema = z
  .enum(["completed", "failed", "interrupted", "cancelled"])
  .or(z.string())

const turnCompletedPayloadSchema = z.object({
  state: runtimeTurnStateSchema,
  stopReason: z.string().nullable().optional(),
  usage: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  totalCostUsd: z.number().optional(),
  errorMessage: z.string().optional(),
  dispatchTurnId: z.string().optional(),
})

const turnAbortedPayloadSchema = z.object({
  reason: z.string(),
  status: z.enum(["interrupted", "cancelled", "timed_out"]).optional(),
  dispatchTurnId: z.string().optional(),
})

const planStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "inProgress",
  "completed",
])
const turnPlanStepSchema = z.object({
  step: z.string(),
  status: planStepStatusSchema.or(z.string()),
})

const turnPlanUpdatedPayloadSchema = z.object({
  explanation: z.string().nullable().optional(),
  plan: z.array(turnPlanStepSchema),
})

const turnProposedDeltaPayloadSchema = z.object({
  delta: z.string(),
})

const turnProposedCompletedPayloadSchema = z.object({
  planMarkdown: z.string(),
})

const turnDiffEditSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(["write", "edit"]),
  preimageHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  patchComplete: z.boolean(),
})

const turnDiffUpdatedPayloadSchema = z.object({
  unifiedDiff: z.string(),
  files: z.array(turnDiffFileSummarySchema).optional(),
  edits: z.array(turnDiffEditSchema).optional(),
  diffTruncated: z.boolean().optional(),
  diffTruncationReason: z.literal("output_limit").optional(),
  diffFileCount: z.number().int().nonnegative().optional(),
  diffFilesTruncated: z.boolean().optional(),
  checkpointRef: z.string().optional(),
  checkpoint_ref: z.string().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  turn_index: z.number().int().nonnegative().optional(),
  checkpointTurnCount: z.number().int().nonnegative().optional(),
  checkpoint_turn_count: z.number().int().nonnegative().optional(),
})

export const runtimeErrorClassSchema = z.enum([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
  "auth_error",
  "rate_limit",
  "internal",
])
export type RuntimeErrorClass = z.infer<typeof runtimeErrorClassSchema>

const runtimeWarningPayloadSchema = z.object({
  message: z.string(),
  detail: z.unknown().optional(),
})

const runtimeErrorPayloadSchema = z.object({
  message: z.string(),
  class: runtimeErrorClassSchema.optional(),
  detail: z.unknown().optional(),
})

const baseEvent = z.object({
  threadId: z.string(),
  provider: z.string().optional(),
  providerKind: providerKindSchema.optional(),
  providerInstanceId: z.string().optional(),
  eventId: z.string(),
  createdAt: z.string().optional(),
  at: z.number().int().nonnegative().optional().default(0),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  parentTaskId: z.string().optional(),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  parentEventId: z.string().optional(),
  parentToolId: z.string().optional(),
  providerRefs: providerRefsSchema.optional(),
  raw: runtimeEventRawSchema.optional(),
})

export const providerRuntimeEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({
    type: z.literal("message.delta"),
    delta: z.string().optional(),
    streamKind: streamKindSchema.optional(),
    payload: messageDeltaPayloadSchema.optional(),
    itemId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("content.delta"),
    streamKind: streamKindSchema.optional(),
    delta: z.string().optional(),
    payload: contentDeltaPayloadSchema.optional(),
    itemId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("content.replace"),
    streamKind: streamKindSchema.optional(),
    text: z.string().optional(),
    payload: contentReplacePayloadSchema.optional(),
    itemId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("reasoning.delta"),
    streamKind: z.enum(["reasoning_text", "reasoning_summary_text"]).optional(),
    delta: z.string().optional(),
    payload: reasoningDeltaPayloadSchema.optional(),
    itemId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("reasoning.replace"),
    streamKind: z.enum(["reasoning_text", "reasoning_summary_text"]).optional(),
    text: z.string().optional(),
    payload: reasoningReplacePayloadSchema.optional(),
    itemId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("item.started"),
    itemId: z.string().optional(),
    kind: z.string().optional(),
    turnId: z.string().optional(),
    payload: itemLifecyclePayloadSchema.or(z.unknown()).optional(),
  }),
  baseEvent.extend({
    type: z.literal("item.completed"),
    itemId: z.string().optional(),
    kind: z.string().optional(),
    turnId: z.string().optional(),
    payload: itemLifecyclePayloadSchema.or(z.unknown()).optional(),
  }),
  baseEvent.extend({
    type: z.literal("item.updated"),
    itemId: z.string().optional(),
    kind: z.string().optional(),
    turnId: z.string().optional(),
    payload: itemLifecyclePayloadSchema.or(z.unknown()).optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool.started"),
    toolId: z.string().optional(),
    toolName: z.string().optional(),
    toolKind: z.string().optional(),
    turnId: z.string().optional(),
    input: z.unknown().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool.delta"),
    toolId: z.string(),
    toolName: z.string().optional(),
    turnId: z.string().optional(),
    delta: z.string(),
    streamKind: streamKindSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool.completed"),
    toolId: z.string().optional(),
    toolName: z.string().optional(),
    toolKind: z.string().optional(),
    turnId: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    output: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool.failed"),
    toolId: z.string(),
    toolName: z.string(),
    turnId: z.string().optional(),
    error: z.string(),
    output: z.unknown().optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool.denied"),
    payload: toolDeniedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("request.opened"),
    requestId: z.string().optional(),
    kind: requestKindSchema.optional(),
    tool: z.string().optional(),
    input: z.unknown().optional(),
    questions: z.array(userInputQuestionSchema).optional(),
    // Rich tool-approval context (Claude Agent SDK canUseTool options):
    title: z.string().optional(),
    description: z.string().optional(),
    decisionReason: z.string().optional(),
    blockedPath: z.string().optional(),
    suggestions: z.array(permissionUpdateSchema).optional(),
    // Plan-approval context (kind === "plan_approval"):
    planMarkdown: z.string().optional(),
    turnId: z.string().optional(),
    payload: requestOpenedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("request.resolved"),
    requestId: z.string().optional(),
    // Enum stays approve|deny|answer for backward compat; plan approvals
    // carry their extra context in the optional fields below.
    decision: z.enum(["approve", "deny", "answer"]).optional(),
    requestKind: requestKindSchema.optional(),
    permissionMode: z.string().optional(),
    message: z.string().optional(),
    payload: requestResolvedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("approval.requested"),
    requestId: z.string().optional(),
    requestKind: z.string().optional(),
    detail: z.string().optional(),
    tool: z.string().optional(),
    input: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("approval.resolved"),
    requestId: z.string().optional(),
    decision: z.enum(["approve", "deny", "accept", "reject"]).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    turnId: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("user-input.requested"),
    requestId: z.string(),
    payload: userInputRequestedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("user-input.resolved"),
    requestId: z.string(),
    payload: userInputResolvedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("task.started"),
    turnId: z.string().optional(),
    payload: taskStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("task.progress"),
    turnId: z.string().optional(),
    payload: taskProgressPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("task.completed"),
    payload: taskCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("hook.started"),
    payload: hookStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("hook.progress"),
    payload: hookProgressPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("hook.completed"),
    payload: hookCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.run.started"),
    payload: pipelineRunStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.step.started"),
    payload: pipelineStepStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.step.completed"),
    payload: pipelineStepCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.run.paused"),
    payload: pipelineRunPausedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.run.resumed"),
    payload: pipelineRunResumedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("pipeline.run.completed"),
    payload: pipelineRunCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("tool.progress"),
    payload: toolProgressPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("tool.summary"),
    payload: toolSummaryPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("auth.status"),
    payload: authStatusPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("account.updated"),
    payload: accountUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("account.rate-limits.updated"),
    payload: accountRateLimitsUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("mcp.status.updated"),
    payload: mcpStatusUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("mcp.oauth.completed"),
    payload: mcpOauthCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("model.rerouted"),
    payload: modelReroutedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("config.warning"),
    payload: configWarningPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("provider.metadata.changed"),
    payload: providerMetadataChangedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("deprecation.notice"),
    payload: deprecationNoticePayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("files.persisted"),
    payload: filesPersistedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.started"),
    payload: threadStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.state.changed"),
    payload: threadStateChangedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.metadata.updated"),
    payload: threadMetadataUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.token-usage.updated"),
    payload: threadTokenUsageUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.realtime.started"),
    payload: threadRealtimeStartedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.realtime.item-added"),
    payload: threadRealtimeItemAddedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.realtime.audio.delta"),
    payload: threadRealtimeAudioDeltaPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.realtime.error"),
    payload: threadRealtimeErrorPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("thread.realtime.closed"),
    payload: threadRealtimeClosedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("turn.started"),
    turnId: z.string().optional(),
    payload: turnStartedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("turn.completed"),
    turnId: z.string().optional(),
    status: z.enum(["completed", "failed", "interrupted"]).optional(),
    error: z.string().optional(),
    payload: turnCompletedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("turn.aborted"),
    payload: turnAbortedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("turn.plan.updated"),
    payload: turnPlanUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("turn.proposed.delta"),
    payload: turnProposedDeltaPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("turn.proposed.completed"),
    payload: turnProposedCompletedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("turn.diff.updated"),
    itemId: z.string().optional(),
    payload: turnDiffUpdatedPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("session.started"),
    message: z.string().optional(),
    resume: z.unknown().optional(),
    payload: sessionStartedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("session.configured"),
    payload: sessionConfiguredPayloadSchema,
  }),
  baseEvent.extend({
    type: z.literal("session.exited"),
    reason: z.string().optional(),
    recoverable: z.boolean().optional(),
    exitKind: z.enum(["graceful", "error"]).or(z.string()).optional(),
    payload: sessionExitedPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("token.usage"),
    turnId: z.string().optional(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      totalTokens: z.number().int().nonnegative().default(0),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheCreationTokens: z.number().int().nonnegative().optional(),
      reasoningOutputTokens: z.number().int().nonnegative().optional(),
      toolUses: z.number().int().nonnegative().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      totalCostUsd: z.number().finite().nonnegative().optional(),
      compactsAutomatically: z.boolean().optional(),
    }),
  }),
  baseEvent.extend({
    type: z.literal("runtime.warning"),
    message: z.string().optional(),
    willRetry: z.boolean().default(false),
    detail: z.unknown().optional(),
    payload: runtimeWarningPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("runtime.error"),
    message: z.string().optional(),
    class: runtimeErrorClassSchema.optional(),
    detail: z.unknown().optional(),
    payload: runtimeErrorPayloadSchema.optional(),
  }),
  baseEvent.extend({
    type: z.literal("session.state.changed"),
    state: sessionStateSchema.optional(),
    status: sessionStateSchema.optional(),
    reason: z.string().optional(),
    detail: z.unknown().optional(),
    payload: sessionStateChangedPayloadSchema.optional(),
  }),
])
export type ProviderRuntimeEvent = z.infer<typeof providerRuntimeEventSchema>

export const providerApprovalDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_approval"),
    decision: z.enum(["approve", "deny"]),
    // Optional deny feedback forwarded to the model verbatim.
    message: z.string().optional(),
    // "Always allow" rules echoed into the SDK PermissionResult.
    updatedPermissions: z.array(permissionUpdateSchema).optional(),
  }),
  z.object({
    kind: z.literal("user_input"),
    answers: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("user_input_reject"),
  }),
  z.object({
    kind: z.literal("plan_approval"),
    decision: z.enum(["approve", "deny"]),
    // approve + acceptEdits = "Approve & implement (auto-accept edits)";
    // approve + default = "Approve (manual approvals)".
    permissionMode: z.enum(["acceptEdits", "default"]).optional(),
    // deny feedback: what the user wants changed about the plan.
    message: z.string().optional(),
  }),
])
export type ProviderApprovalDecision = z.infer<
  typeof providerApprovalDecisionSchema
>

export const providerSessionSchema = z.object({
  threadId: z.string(),
  providerInstanceId: z.string().nullable().optional(),
  providerThreadId: z.string().nullable(),
  resumeCursor: z.unknown().nullable().optional(),
  continuationKey: z.string().nullable().optional(),
  status: z.enum([
    "starting",
    "ready",
    "running",
    "closing",
    "closed",
    "interrupted",
    "stopped",
    "error",
  ]),
  cwd: z.string().nullable(),
  activeTurnId: z.string().nullable(),
  runtimeMode: z.string().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type ProviderSession = z.infer<typeof providerSessionSchema>

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId
  readonly turns: ReadonlyArray<{
    readonly id: TurnId
    readonly items: ReadonlyArray<unknown>
  }>
}

export const historyMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  // Durable tool-call history (in-house agent loop): assistant turns carry
  // `tool_calls`, and `role:"tool"` messages carry `tool_call_id`.
  tool_calls: z
    .array(z.object({ id: z.string(), name: z.string(), input: z.unknown() }))
    .optional(),
  tool_call_id: z.string().optional(),
})
export type HistoryMessage = z.infer<typeof historyMessageSchema>

export const providerSendTurnInputSchema = z.object({
  providerInstanceId: z.string().optional(),
  /** Hub-generated admission identity used to reject delayed lifecycle events
   * from an older turn on the same provider session. */
  dispatchTurnId: z.string().optional(),
  threadId: z
    .string({ error: "threadId is required" })
    .min(1, "threadId is required"),
  message: z
    .string({ error: "message is required" })
    .min(1, "message is required"),
  modelId: z
    .string({ error: "modelId is required" })
    .min(1, "modelId is required"),
  modelSelection: modelSelectionSchema.optional(),
  history: z.array(historyMessageSchema).default([]),
  attachments: z.array(chatAttachmentSchema).optional(),
  projectPath: z.string().nullable().optional(),
  systemInstruction: z.string().nullable().optional(),
  permissionLevel: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  chatMode: z.string().nullable().optional(),
  appMode: z.enum(["agent", "editor", "design"]).nullable().optional(),
  designContext: designBriefSchema.nullable().optional(),
  collaborationMode: z.unknown().optional(),
  fastMode: z.boolean().nullable().optional(),
  sourceProposedPlan: sourceProposedPlanReferenceSchema.nullable().optional(),
  // "interactive" (default): ExitPlanMode opens a plan_approval request and
  // waits for the user. "capture": legacy capture-and-deny behavior — used by
  // pipeline-driven turns where the stop point is the human gate instead.
  planApprovalMode: z.enum(["interactive", "capture"]).nullable().optional(),
})
export type ProviderSendTurnInput = Omit<
  z.infer<typeof providerSendTurnInputSchema>,
  "attachments"
> & {
  attachments?: ChatAttachment[]
}

export const providerRollbackConversationSchema = z.object({
  threadId: z
    .string({ error: "threadId is required" })
    .min(1, "threadId is required"),
  numTurns: z.number().int().nonnegative(),
  providerKind: providerKindSchema.optional(),
  providerInstanceId: z.string().nullable().optional(),
})
export type ProviderRollbackConversationInput = z.infer<
  typeof providerRollbackConversationSchema
>

export const providerCapabilitiesSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsTools: z.boolean(),
  supportsApprovals: z.boolean(),
  supportsResume: z.boolean(),
  managesOwnLifecycle: z.boolean(),
})
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>

export interface ProviderModel {
  readonly slug: string
  readonly name: string
  readonly shortName?: string
  readonly subProvider?: string
  readonly isCustom?: boolean
  readonly capabilities?: ModelCapabilities | null
  readonly context?: string
  readonly tier?: string
  readonly catalog?: ProviderModelCatalog
}

export interface ProviderAdapterShape {
  readonly provider: ProviderKind
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  isConfigured(): boolean
  availableModels(input?: {
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderModel>>
  availableSkills?(input?: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderSkill>>
  availableSlashCommands?(input?: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderSlashCommand>>
  availableAgents?(input?: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderAgent>>
  availableTools?(input?: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderTool>>
  availableProviderCatalog?(input?: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderCatalogEntry>>
  invalidateMetadata?(input?: { readonly cwd?: string | null }): void
  /** Checked under turn admission. True restarts the idle runtime with its resume cursor before sending. */
  needsSessionConfigurationRefresh?(input: { readonly threadId: ThreadId; readonly cwd?: string | null }): Promise<boolean>
  startSession(input: {
    threadId: ThreadId
    cwd?: string | null
    modelSelection?: ModelSelection | null
    resumeCursor?: unknown | null
    runtimeMode?: string | null
  }): Promise<ProviderSession>
  listSessions?(): Promise<ReadonlyArray<ProviderSession>>
  sendTurn(input: ProviderSendTurnInput): Promise<void>
  interruptTurn(threadId: ThreadId): Promise<void>
  /**
   * Switch the provider-native permission mode. Applies live to a running
   * turn when the provider supports mid-stream control, otherwise queued
   * for the next turn.
   */
  setPermissionMode?(
    threadId: ThreadId,
    mode: SdkPermissionModeValue
  ): Promise<{ applied: "live" | "queued" }>
  readThread?(threadId: ThreadId): Promise<ProviderThreadSnapshot>
  respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision
  ): Promise<void>
  rollbackThread?(
    threadId: ThreadId,
    numTurns: number
  ): Promise<ProviderThreadSnapshot | void>
  stopSession(threadId: ThreadId): Promise<void>
  hasSession(threadId: ThreadId): boolean
  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void
  stopAll(): Promise<void>
}
