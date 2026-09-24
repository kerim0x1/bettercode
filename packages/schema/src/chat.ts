import { z } from "zod"
import { pick } from "./_helpers"
import { modelSelectionSchema } from "./model-selection"
import { sourceProposedPlanReferenceSchema } from "./proposed-plan"
import { chatOrchestrationSchema } from "./orchestrator"
import { designBriefSchema } from "./design"
import { permissionUpdateSchema } from "./provider-runtime"
import {
  CHAT_ATTACHMENTS_MAX_COUNT,
  CHAT_MESSAGE_MAX_CHARS,
  chatAttachmentsSchema,
} from "./chat-attachment"

export {
  ATTACHMENTS_ONLY_MESSAGE,
  CHAT_ATTACHMENTS_MAX_COUNT,
  chatAttachmentSchema,
  chatAttachmentsSchema,
  type ChatAttachment,
} from "./chat-attachment"

export const CHAT_HISTORY_MAX_BYTES = 512 * 1024
const CHAT_HISTORY_MAX_MESSAGES = 320
const CHAT_HISTORY_MAX_TOOL_CALLS_PER_MESSAGE = 128
const CHAT_SYSTEM_INSTRUCTION_MAX_CHARS = 256 * 1024
const CHAT_SUMMARY_MAX_CHARS = 256 * 1024
const CHAT_POLICY_INSTRUCTION_MAX_CHARS = 64 * 1024
const CHAT_PATH_MAX_CHARS = 8 * 1024
const CHAT_IDENTIFIER_MAX_CHARS = 512
const utf8Encoder = new TextEncoder()

/**
 * App modes. `design` is the persisted and wire value of what the UI calls
 * **Canvas mode** (renamed 2026-09-17 when the canvas grew backend cards);
 * saved threads, window params and mobile all carry the old spelling.
 */
export const chatAppModeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["agent", "editor", "design"])
)

const historyMessageSchema = z
  .object({
    role: z.string().min(1).max(64),
    content: z.string().max(256 * 1024),
    // Durable tool-call history (in-house agent loop): assistant turns carry
    // `tool_calls`, and `role:"tool"` messages carry `tool_call_id`.
    tool_calls: z
      .array(
        z.object({
          id: z.string().min(1).max(CHAT_IDENTIFIER_MAX_CHARS),
          name: z.string().min(1).max(1_024),
          input: z.unknown(),
        })
      )
      .max(CHAT_HISTORY_MAX_TOOL_CALLS_PER_MESSAGE)
      .optional(),
    tool_call_id: z.string().max(CHAT_IDENTIFIER_MAX_CHARS).optional(),
  })
  .strict()

const chatHistorySchema = z
  .array(historyMessageSchema)
  .max(CHAT_HISTORY_MAX_MESSAGES)
  .superRefine((history, context) => {
    let serialized: string
    try {
      serialized = JSON.stringify(history)
    } catch {
      context.addIssue({
        code: "custom",
        message: "history must be JSON serializable",
      })
      return
    }
    if (utf8Encoder.encode(serialized).byteLength <= CHAT_HISTORY_MAX_BYTES) {
      return
    }
    context.addIssue({
      code: "custom",
      message: `history exceeds ${CHAT_HISTORY_MAX_BYTES} UTF-8 bytes`,
    })
  })

const nonBlankString = (message: string, maxChars = CHAT_MESSAGE_MAX_CHARS) =>
  z
    .string({ error: message })
    .max(maxChars)
    .refine((value) => value.trim().length > 0, message)

const autoCompactionUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative().max(16_000_000).optional(),
    maxTokens: z.number().int().positive().max(16_000_000).optional(),
    compactsAutomatically: z.boolean().optional(),
  })
  .strict()

const autoCompactionModelLimitsSchema = z
  .object({
    contextTokens: z.number().int().positive().max(16_000_000).optional(),
    inputTokens: z.number().int().positive().max(16_000_000).optional(),
    outputTokens: z.number().int().positive().max(16_000_000).optional(),
  })
  .strict()

/**
 * Raw body schema for `/chat/send`. The renderer sends camelCase but the
 * internal `ProviderSendTurnInput` uses snake_case. The pipeline accepts both
 * via `.passthrough()` + `.transform()` so the route gets a clean snake_case
 * `ProviderSendTurnInput`-shaped object.
 */
export const chatSendSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const modelSelection =
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null
    const rawModelId =
      pick<unknown>(raw, "modelId", "model_id") ?? modelSelection?.model

    return {
      provider_kind: z.coerce
        .string()
        .trim()
        .min(1, "providerKind is required")
        .max(128)
        .default("openai")
        .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
      provider_instance_id:
        z
          .string()
          .max(CHAT_IDENTIFIER_MAX_CHARS)
          .nullish()
          .parse(
            pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
          ) ?? null,
      thread_id: nonBlankString(
        "threadId is required",
        CHAT_IDENTIFIER_MAX_CHARS
      ).parse(pick<unknown>(raw, "threadId", "thread_id")),
      user_message_id:
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .nullish()
          .parse(pick<unknown>(raw, "userMessageId", "user_message_id")) ??
        null,
      user_message_content:
        z
          .string()
          .max(CHAT_MESSAGE_MAX_CHARS)
          .nullish()
          .parse(
            pick<unknown>(raw, "userMessageContent", "user_message_content")
          ) ?? null,
      user_message_created_at:
        z
          .string()
          .datetime()
          .nullish()
          .parse(
            pick<unknown>(
              raw,
              "userMessageCreatedAt",
              "user_message_created_at"
            )
          ) ?? null,
      thread_title:
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .nullish()
          .parse(pick<unknown>(raw, "threadTitle", "thread_title")) ?? null,
      thread_project_name:
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .nullish()
          .parse(
            pick<unknown>(raw, "threadProjectName", "thread_project_name")
          ) ?? null,
      thread_created_at:
        z
          .string()
          .datetime()
          .nullish()
          .parse(pick<unknown>(raw, "threadCreatedAt", "thread_created_at")) ??
        null,
      message: nonBlankString(
        "message is required",
        CHAT_MESSAGE_MAX_CHARS
      ).parse(pick<unknown>(raw, "message", "message")),
      model_id: nonBlankString(
        "modelId is required",
        CHAT_IDENTIFIER_MAX_CHARS
      ).parse(rawModelId),
      model_selection: modelSelection,
      reasoning_effort:
        z
          .string()
          .max(128)
          .nullish()
          .parse(pick<unknown>(raw, "reasoningEffort", "reasoning_effort")) ??
        null,
      chat_mode:
        z
          .string()
          .max(128)
          .nullish()
          .parse(pick<unknown>(raw, "chatMode", "chat_mode")) ?? null,
      app_mode:
        chatAppModeSchema
          .nullish()
          .parse(pick<unknown>(raw, "appMode", "app_mode")) ?? "agent",
      design_context:
        designBriefSchema
          .nullish()
          .parse(pick<unknown>(raw, "designContext", "design_context")) ?? null,
      project_path:
        z
          .string()
          .max(CHAT_PATH_MAX_CHARS)
          .nullish()
          .parse(pick<unknown>(raw, "projectPath", "project_path")) ?? null,
      rule_target_path:
        z
          .string()
          .max(CHAT_PATH_MAX_CHARS)
          .nullish()
          .parse(pick<unknown>(raw, "ruleTargetPath", "rule_target_path")) ??
        null,
      history: chatHistorySchema
        .default([])
        .parse(pick<unknown>(raw, "history", "history")),
      attachments: chatAttachmentsSchema
        .default([])
        .parse(pick<unknown>(raw, "attachments", "attachment_metadata")),
      system_instruction:
        z
          .string()
          .max(CHAT_SYSTEM_INSTRUCTION_MAX_CHARS)
          .nullish()
          .parse(
            pick<unknown>(raw, "systemInstruction", "system_instruction")
          ) ?? null,
      // Set by a client that does not prepare its turns itself (the phone
      // app): the backend runs the user's "on message send" hooks and
      // builds the system instruction the desktop would have sent.
      prepare_turn:
        z
          .boolean()
          .nullish()
          .parse(pick<unknown>(raw, "prepareTurn", "prepare_turn")) ?? false,
      permission_level:
        z
          .string()
          .max(64)
          .nullish()
          .parse(pick<unknown>(raw, "permissionLevel", "permission_level")) ??
        null,
      openai_transport:
        z
          .string()
          .max(64)
          .nullish()
          .parse(pick<unknown>(raw, "openaiTransport", "openai_transport")) ??
        null,
      sandbox:
        z
          .enum([
            "never",
            "workspaceRead",
            "workspaceWrite",
            "dangerFullAccess",
          ])
          .nullish()
          .parse(pick<unknown>(raw, "sandbox", "sandbox")) ?? null,
      approvalPolicy:
        z
          .enum(["never", "onRequest", "always"])
          .nullish()
          .parse(pick<unknown>(raw, "approvalPolicy", "approval_policy")) ??
        null,
      personality:
        z
          .enum(["friendly", "pragmatic", "none"])
          .nullish()
          .parse(pick<unknown>(raw, "personality", "personality")) ?? null,
      serviceTier:
        z
          .enum(["auto", "pro", "business"])
          .nullish()
          .parse(pick<unknown>(raw, "serviceTier", "service_tier")) ?? null,
      effort:
        z
          .enum(["balanced", "deep"])
          .nullish()
          .parse(pick<unknown>(raw, "effort", "effort")) ?? null,
      collaborationMode:
        z
          .unknown()
          .optional()
          .parse(
            pick<unknown>(raw, "collaborationMode", "collaboration_mode")
          ) ?? null,
      // Codex Fast Mode (priority compute, OpenAI's serviceTier: "fast").
      // Boolean toggle on the BetterC0de model selection;
      // adapter decides per-model whether to forward to wire.
      fast_mode:
        z
          .boolean()
          .nullish()
          .parse(pick<unknown>(raw, "fastMode", "fast_mode")) ?? null,
      source_proposed_plan:
        sourceProposedPlanReferenceSchema
          .nullish()
          .parse(
            pick<unknown>(raw, "sourceProposedPlan", "source_proposed_plan")
          ) ?? null,
      orchestration: chatOrchestrationSchema
        .optional()
        .parse(raw.orchestration),
      auto_compaction_usage:
        autoCompactionUsageSchema
          .nullish()
          .parse(
            pick<unknown>(raw, "autoCompactionUsage", "auto_compaction_usage")
          ) ?? null,
      auto_compaction_model_limits:
        autoCompactionModelLimitsSchema
          .nullish()
          .parse(
            pick<unknown>(
              raw,
              "autoCompactionModelLimits",
              "auto_compaction_model_limits"
            )
          ) ?? null,
    }
  })

export type ChatSendBody = z.infer<typeof chatSendSchema>

export const chatInterruptSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("openai")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z.coerce
      .string()
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .default("default")
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
  }))
export type ChatInterruptBody = z.infer<typeof chatInterruptSchema>

export const chatRotateSessionSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    threadId: nonBlankString(
      "threadId is required",
      CHAT_IDENTIFIER_MAX_CHARS
    ).parse(pick<unknown>(raw, "threadId", "thread_id")),
    checkpointMessageId: nonBlankString("checkpointMessageId is required")
      .max(512)
      .parse(
        pick<unknown>(raw, "checkpointMessageId", "checkpoint_message_id")
      ),
    checkpointContent: nonBlankString("checkpointContent is required")
      .max(CHAT_MESSAGE_MAX_CHARS)
      .parse(pick<unknown>(raw, "checkpointContent", "checkpoint_content")),
    checkpointCreatedAt: z
      .string()
      .datetime()
      .parse(
        pick<unknown>(raw, "checkpointCreatedAt", "checkpoint_created_at")
      ),
    commandMessageId: nonBlankString("commandMessageId is required")
      .max(512)
      .parse(pick<unknown>(raw, "commandMessageId", "command_message_id")),
    commandContent: nonBlankString("commandContent is required")
      .max(64 * 1024)
      .parse(pick<unknown>(raw, "commandContent", "command_content")),
    commandCreatedAt: z
      .string()
      .datetime()
      .parse(pick<unknown>(raw, "commandCreatedAt", "command_created_at")),
    autoCompactionPrecondition:
      z
        .object({
          compactionGeneration: z.number().int().nonnegative(),
          lastMessageId: z.string().min(1).max(512).nullable(),
        })
        .strict()
        .nullish()
        .parse(
          pick<unknown>(
            raw,
            "autoCompactionPrecondition",
            "auto_compaction_precondition"
          )
        ) ?? null,
  }))
export type ChatRotateSessionBody = z.infer<typeof chatRotateSessionSchema>

/**
 * Read-only pre-turn policy request. The backend resolves durable history,
 * project config precedence, active-turn ownership, and provider usage before
 * deciding whether the renderer may invoke the existing compaction flow.
 */
export const chatAutoCompactionDecisionSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    threadId: nonBlankString(
      "threadId is required",
      CHAT_IDENTIFIER_MAX_CHARS
    ).parse(pick<unknown>(raw, "threadId", "thread_id")),
    cwd:
      z
        .string()
        .trim()
        .min(1)
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath") ?? raw.project_path) ??
      null,
    incomingContent: z
      .string()
      .max(CHAT_MESSAGE_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "incomingContent", "incoming_content")),
    usage: autoCompactionUsageSchema.nullish().parse(raw.usage) ?? null,
    modelLimits:
      autoCompactionModelLimitsSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelLimits", "model_limits")) ?? null,
  }))
export type ChatAutoCompactionDecisionBody = z.infer<
  typeof chatAutoCompactionDecisionSchema
>

export const chatAutoCompactionDecisionReasonSchema = z.enum([
  "threshold-reached",
  "disabled",
  "provider-native",
  "turn-active",
  "context-window-unknown",
  "invalid-budget",
  "below-threshold",
  "insufficient-history",
  "preserve-budget",
  "config-unavailable",
])

export const chatAutoCompactionDecisionResultSchema = z.object({
  shouldCompact: z.boolean(),
  reason: chatAutoCompactionDecisionReasonSchema,
  enabled: z.boolean(),
  compactsAutomatically: z.boolean(),
  usedTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  incomingTokens: z.number().int().nonnegative(),
  projectedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
  thresholdTokens: z.number().int().nonnegative().nullable(),
  reservedTokens: z.number().int().nonnegative(),
  preserveRecentTokens: z.number().int().nonnegative(),
  tailTurns: z.number().int().nonnegative(),
  completedTurns: z.number().int().nonnegative(),
  compactableTokens: z.number().int().nonnegative(),
  compactionGeneration: z.number().int().nonnegative(),
  precondition: z.object({
    compactionGeneration: z.number().int().nonnegative(),
    lastMessageId: z.string().min(1).max(512).nullable(),
  }),
  configSources: z.object({
    enabled: z.string().max(CHAT_PATH_MAX_CHARS).nullable(),
    reservedTokens: z.string().max(CHAT_PATH_MAX_CHARS).nullable(),
    preserveRecentTokens: z.string().max(CHAT_PATH_MAX_CHARS).nullable(),
    tailTurns: z.string().max(CHAT_PATH_MAX_CHARS).nullable(),
  }),
})
export type ChatAutoCompactionDecisionResult = z.infer<
  typeof chatAutoCompactionDecisionResultSchema
>

export const chatTitleSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    userMessage: z.coerce
      .string()
      .max(CHAT_SUMMARY_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "userMessage", "user_message")),
  }))
export type ChatTitleBody = z.infer<typeof chatTitleSchema>

export const chatQuestionsSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    text: z.coerce
      .string()
      .max(CHAT_SUMMARY_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "assistantText", "text")),
  }))
export type ChatQuestionsBody = z.infer<typeof chatQuestionsSchema>

const textGenerationAttachmentSchema = z
  .object({
    type: z.string().max(64).optional(),
    id: z.string().max(CHAT_IDENTIFIER_MAX_CHARS).optional(),
    name: z.coerce.string().max(1_024),
    mimeType: z.coerce.string().max(256),
    sizeBytes: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
  })
  .strict()

const textGenerationPolicySchema = z.object({
  kind: z.enum([
    "default",
    "conventional_commits",
    "repo_conventions",
    "custom",
  ]),
  commitInstructions: z
    .string()
    .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
    .optional(),
  changeRequestInstructions: z
    .string()
    .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
    .optional(),
  branchInstructions: z
    .string()
    .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
    .optional(),
  threadTitleInstructions: z
    .string()
    .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
    .optional(),
  inferRepositoryConventions: z.boolean().default(false),
})

const userInputAnswersSchema = z
  .record(z.string().min(1).max(CHAT_IDENTIFIER_MAX_CHARS), z.unknown())
  .superRefine((answers, context) => {
    if (Object.keys(answers).length > 128) {
      context.addIssue({
        code: "custom",
        message: "answers is limited to 128 entries",
      })
    }
    try {
      if (
        utf8Encoder.encode(JSON.stringify(answers)).byteLength >
        CHAT_SUMMARY_MAX_CHARS
      ) {
        context.addIssue({
          code: "custom",
          message: "answers exceeds 256 KiB",
        })
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "answers must be JSON serializable",
      })
    }
  })

export const chatGenerateCommitMessageSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath")) ?? null,
    branch:
      z
        .string()
        .max(1_024)
        .nullish()
        .parse(pick<unknown>(raw, "branch", "branch_name")) ?? null,
    stagedSummary: z.coerce
      .string()
      .max(CHAT_SUMMARY_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "stagedSummary", "staged_summary")),
    stagedPatch: z.coerce
      .string()
      .max(CHAT_MESSAGE_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "stagedPatch", "staged_patch")),
    includeBranch: z
      .boolean()
      .default(false)
      .parse(pick<unknown>(raw, "includeBranch", "include_branch")),
    policy:
      textGenerationPolicySchema
        .nullish()
        .parse(pick<unknown>(raw, "policy", "textGenerationPolicy")) ??
      undefined,
    modelSelection:
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null,
  }))
export type ChatGenerateCommitMessageBody = z.infer<
  typeof chatGenerateCommitMessageSchema
>

export const chatGeneratePrContentSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath")) ?? null,
    baseBranch: z.coerce
      .string()
      .min(1, "baseBranch is required")
      .max(1_024)
      .parse(pick<unknown>(raw, "baseBranch", "base_branch")),
    headBranch: z.coerce
      .string()
      .min(1, "headBranch is required")
      .max(1_024)
      .parse(pick<unknown>(raw, "headBranch", "head_branch")),
    commitSummary: z.coerce
      .string()
      .max(CHAT_SUMMARY_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "commitSummary", "commit_summary")),
    diffSummary: z.coerce
      .string()
      .max(CHAT_SUMMARY_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "diffSummary", "diff_summary")),
    diffPatch: z.coerce
      .string()
      .max(CHAT_MESSAGE_MAX_CHARS)
      .default("")
      .parse(pick<unknown>(raw, "diffPatch", "diff_patch")),
    policy:
      textGenerationPolicySchema
        .nullish()
        .parse(pick<unknown>(raw, "policy", "textGenerationPolicy")) ??
      undefined,
    modelSelection:
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null,
  }))
export type ChatGeneratePrContentBody = z.infer<
  typeof chatGeneratePrContentSchema
>

export const chatGenerateBranchNameSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath")) ?? null,
    message: nonBlankString(
      "message is required",
      CHAT_MESSAGE_MAX_CHARS
    ).parse(
      pick<unknown>(raw, "message", "userMessage") ??
        (raw.user_message as unknown)
    ),
    attachments: z
      .array(textGenerationAttachmentSchema)
      .max(CHAT_ATTACHMENTS_MAX_COUNT)
      .default([])
      .parse(pick<unknown>(raw, "attachments", "attachment_metadata")),
    policy:
      textGenerationPolicySchema
        .nullish()
        .parse(pick<unknown>(raw, "policy", "textGenerationPolicy")) ??
      undefined,
    modelSelection:
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null,
  }))
export type ChatGenerateBranchNameBody = z.infer<
  typeof chatGenerateBranchNameSchema
>

export const chatGenerateThreadContextSummarySchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath")) ?? null,
    threadTitle:
      z
        .string()
        .max(512)
        .nullish()
        .parse(pick<unknown>(raw, "threadTitle", "thread_title")) ?? null,
    projectPath:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "projectPath", "project_path")) ?? null,
    transcript: nonBlankString(
      "transcript is required",
      CHAT_MESSAGE_MAX_CHARS
    ).parse(
      pick<unknown>(raw, "transcript", "history") ??
        (raw.compactTranscript as unknown)
    ),
    modelSelection:
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null,
  }))
export type ChatGenerateThreadContextSummaryBody = z.infer<
  typeof chatGenerateThreadContextSummarySchema
>

export const chatGenerateSkillContentSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    name: nonBlankString("name is required", 1_024).parse(
      pick<unknown>(raw, "name", "skillName")
    ),
    requirements: nonBlankString(
      "requirements are required",
      CHAT_MESSAGE_MAX_CHARS
    ).parse(pick<unknown>(raw, "requirements", "prompt")),
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "projectPath")) ?? null,
    modelSelection:
      modelSelectionSchema
        .nullish()
        .parse(pick<unknown>(raw, "modelSelection", "model_selection")) ?? null,
  }))
export type ChatGenerateSkillContentBody = z.infer<
  typeof chatGenerateSkillContentSchema
>

export const chatApprovalSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("anthropic")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z
      .string()
      .min(1, "threadId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
    requestId: z
      .string()
      .min(1, "requestId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "requestId", "request_id")),
    decision: z.coerce
      .string()
      .max(64)
      .default("deny")
      .parse(pick<unknown>(raw, "decision", "decision")),
    message:
      z
        .string()
        .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "message", "message")) ?? null,
    updatedPermissions:
      z
        .array(permissionUpdateSchema)
        .max(128)
        .nullish()
        .parse(
          pick<unknown>(raw, "updatedPermissions", "updated_permissions")
        ) ?? null,
  }))
export type ChatApprovalBody = z.infer<typeof chatApprovalSchema>

/** Body for POST /chat/plan-approval — resolves a pending plan_approval. */
export const chatPlanApprovalSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("claude")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z
      .string()
      .min(1, "threadId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
    requestId: z
      .string()
      .min(1, "requestId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "requestId", "request_id")),
    decision: z
      .enum(["approve", "deny"])
      .parse(pick<unknown>(raw, "decision", "decision")),
    permissionMode:
      z
        .enum(["acceptEdits", "default"])
        .nullish()
        .parse(pick<unknown>(raw, "permissionMode", "permission_mode")) ?? null,
    message:
      z
        .string()
        .max(CHAT_POLICY_INSTRUCTION_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "message", "message")) ?? null,
  }))
export type ChatPlanApprovalBody = z.infer<typeof chatPlanApprovalSchema>

/** Body for POST /chat/permission-mode — mid-session permission switching. */
export const chatPermissionModeSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("claude")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z
      .string()
      .min(1, "threadId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
    permissionLevel: z
      .string()
      .min(1, "permissionLevel is required")
      .max(64)
      .parse(pick<unknown>(raw, "permissionLevel", "permission_level")),
  }))
export type ChatPermissionModeBody = z.infer<typeof chatPermissionModeSchema>

/** Body for POST /permissions/claude-rules/list and session-rules/list. */
export const permissionRulesListSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "project_path")) ?? null,
    threadId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "threadId", "thread_id")) ?? null,
  }))
export type PermissionRulesListBody = z.infer<typeof permissionRulesListSchema>

/** Body for POST /permissions/claude-rules/delete. */
export const permissionRuleDeleteSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    source: z
      .enum(["userSettings", "projectSettings", "localSettings", "session"])
      .parse(pick<unknown>(raw, "source", "source")),
    behavior: z
      .enum(["allow", "deny", "ask"])
      .parse(pick<unknown>(raw, "behavior", "behavior")),
    rule: z
      .string()
      .min(1, "rule is required")
      .max(8 * 1024)
      .parse(pick<unknown>(raw, "rule", "rule")),
    cwd:
      z
        .string()
        .max(CHAT_PATH_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "cwd", "project_path")) ?? null,
    threadId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(pick<unknown>(raw, "threadId", "thread_id")) ?? null,
  }))
export type PermissionRuleDeleteBody = z.infer<
  typeof permissionRuleDeleteSchema
>

export const chatUserInputSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("anthropic")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z
      .string()
      .min(1, "threadId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
    requestId: z
      .string()
      .min(1, "requestId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "requestId", "request_id")),
    answers: userInputAnswersSchema
      .default({})
      .parse(pick<unknown>(raw, "answers", "answers")),
  }))
export type ChatUserInputBody = z.infer<typeof chatUserInputSchema>

export const chatUserInputRejectSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => ({
    providerKind: z.coerce
      .string()
      .max(128)
      .default("anthropic")
      .parse(pick<unknown>(raw, "providerKind", "provider_kind")),
    providerInstanceId:
      z
        .string()
        .max(CHAT_IDENTIFIER_MAX_CHARS)
        .nullish()
        .parse(
          pick<unknown>(raw, "providerInstanceId", "provider_instance_id")
        ) ?? null,
    threadId: z
      .string()
      .min(1, "threadId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "threadId", "thread_id")),
    requestId: z
      .string()
      .min(1, "requestId is required")
      .max(CHAT_IDENTIFIER_MAX_CHARS)
      .parse(pick<unknown>(raw, "requestId", "request_id")),
  }))
export type ChatUserInputRejectBody = z.infer<typeof chatUserInputRejectSchema>
