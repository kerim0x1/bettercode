import { z } from "zod"
import {
  agentPermissionEvaluateSchema,
  agentPermissionGrantDeleteSchema,
  agentPermissionGrantListSchema,
  agentPermissionGrantUpsertSchema,
  workspaceTrustGetSchema,
  workspaceTrustSetSchema,
  type AgentPermissionGrant,
  type WorkspaceTrustRecord,
} from "./agent-permissions"
import {
  chatAutoCompactionDecisionReasonSchema,
  chatAutoCompactionDecisionSchema,
  chatGenerateBranchNameSchema,
  chatGeneratePrContentSchema,
  chatGenerateSkillContentSchema,
  chatGenerateThreadContextSummarySchema,
  chatQuestionsSchema,
  chatRotateSessionSchema,
  chatTitleSchema,
  permissionRuleDeleteSchema,
  permissionRulesListSchema,
  type ChatAutoCompactionDecisionResult,
} from "./chat"
import { endpoint, type RecordSchema } from "./http-endpoint"
import {
  chatResumeControlSchema,
  chatResumeResponseSchema,
} from "./thread-resume"

/**
 * The chat helper routes (compaction, session rotation, text generation) and
 * the permission-policy routes (`apps/backend/src/http/routes/chat.ts`,
 * `permissions.ts`). The requests are the schemas the routes always parsed;
 * the responses are checked here without the bounds the backend applies when
 * it computes them, so a value it may legitimately send is never refused.
 */

const text = z.string()
const bool = z.boolean()
const num = z.number()

// ── Compaction and session rotation ─────────────────────────────────────

/** Whether to compact before the next turn, and the numbers behind it. */
const chatAutoCompactionDecisionResponseSchema: RecordSchema<ChatAutoCompactionDecisionResult> =
  z
    .object({
      shouldCompact: bool,
      reason: chatAutoCompactionDecisionReasonSchema,
      enabled: bool,
      compactsAutomatically: bool,
      usedTokens: num,
      estimatedTokens: num,
      incomingTokens: num,
      projectedTokens: num,
      maxTokens: num.nullable(),
      thresholdTokens: num.nullable(),
      reservedTokens: num,
      preserveRecentTokens: num,
      tailTurns: num,
      completedTurns: num,
      compactableTokens: num,
      compactionGeneration: num,
      precondition: z
        .object({ compactionGeneration: num, lastMessageId: text.nullable() })
        .passthrough(),
      configSources: z
        .object({
          enabled: text.nullable(),
          reservedTokens: text.nullable(),
          preserveRecentTokens: text.nullable(),
          tailTurns: text.nullable(),
        })
        .passthrough(),
    })
    .passthrough()

/** A committed compaction: the checkpoint and the generation it starts. */
export interface ChatSessionRotateResult {
  /** Whether a provider session was running and has been stopped. */
  rotated: boolean
  generation: number | null
  messageId: string
}

const chatSessionRotateResultSchema: RecordSchema<ChatSessionRotateResult> = z
  .object({ rotated: bool, generation: num.nullable(), messageId: text })
  .passthrough()

// ── Permission policy ───────────────────────────────────────────────────

const permissionBehavior = z.enum(["allow", "deny", "ask"])

/** An "Always allow/deny/ask" rule in one of the Claude settings files. */
export interface ClaudePermissionRuleEntry {
  source: "userSettings" | "projectSettings" | "localSettings"
  behavior: "allow" | "deny" | "ask"
  rule: string
  filePath: string
}

const claudePermissionRuleSchema: RecordSchema<ClaudePermissionRuleEntry> = z
  .object({
    source: z.enum(["userSettings", "projectSettings", "localSettings"]),
    behavior: permissionBehavior,
    rule: text,
    filePath: text,
  })
  .passthrough()

/** A rule a chat's provider session holds until the chat is deleted. */
export interface SessionPermissionRuleEntry {
  threadId: string
  behavior: "allow" | "deny" | "ask"
  toolName: string
  ruleContent?: string
}

const sessionPermissionRuleSchema: RecordSchema<SessionPermissionRuleEntry> = z
  .object({
    threadId: text,
    behavior: permissionBehavior,
    toolName: text,
    ruleContent: text.optional(),
  })
  .passthrough()

/** The answer of a rule or grant deletion: `failed` comes with the reason. */
export interface PermissionChangeResult {
  status: "acknowledged" | "failed"
  error?: string
}

const permissionChangeResultSchema: RecordSchema<PermissionChangeResult> = z
  .object({
    status: z.enum(["acknowledged", "failed"]),
    error: text.optional(),
  })
  .passthrough()

const agentPermissionGrantResponseSchema: RecordSchema<AgentPermissionGrant> = z
  .object({
    id: text,
    destination: z.enum(["user", "workspace"]),
    workspacePath: text.nullable(),
    toolName: text,
    pathScope: text,
    behavior: permissionBehavior,
    createdAt: text,
    updatedAt: text,
  })
  .passthrough()

const workspaceTrustRecordResponseSchema: RecordSchema<WorkspaceTrustRecord> = z
  .object({
    workspacePath: text,
    state: z.enum(["trusted", "untrusted"]),
    explicit: bool,
    updatedAt: text.nullable(),
  })
  .passthrough()

/** How the policy decides one tool call (`/permissions/grants/evaluate`). */
export interface AgentPermissionEvaluation {
  decision: "allow" | "deny" | "ask"
  /** What decided: a grant, workspace trust, path confinement, the default. */
  source: string
  reason: string
  normalizedPath: string | null
  grant: AgentPermissionGrant | null
}

const agentPermissionEvaluationSchema: RecordSchema<AgentPermissionEvaluation> =
  z
    .object({
      decision: permissionBehavior,
      source: text,
      reason: text,
      normalizedPath: text.nullable(),
      grant: agentPermissionGrantResponseSchema.nullable(),
    })
    .passthrough()

const workspaceTrustResponseSchema = z
  .object({ trust: workspaceTrustRecordResponseSchema })
  .passthrough()

export const chatHttpContracts = {
  // Read-only: whether the next turn should compact first.
  chatCompactionDecision: endpoint(
    "POST",
    "/chat/compaction/decision",
    chatAutoCompactionDecisionSchema,
    chatAutoCompactionDecisionResponseSchema
  ),
  chatSessionRotate: endpoint(
    "POST",
    "/chat/session/rotate",
    chatRotateSessionSchema,
    chatSessionRotateResultSchema
  ),
  // A chat a usage limit or a restart stopped (thread-resume.ts): resume it
  // when the limit resets, at once, or not at all.
  chatResume: endpoint(
    "POST",
    "/chat/resume",
    chatResumeControlSchema,
    chatResumeResponseSchema
  ),
  // The generated title itself, as a JSON string.
  chatTitle: endpoint("POST", "/chat/title", chatTitleSchema, text),
  chatQuestions: endpoint(
    "POST",
    "/chat/questions",
    chatQuestionsSchema,
    z.array(z.object({ text, options: z.array(text) }).passthrough())
  ),
  generatePrContent: endpoint(
    "POST",
    "/chat/text-generation/pr-content",
    chatGeneratePrContentSchema,
    z.object({ title: text, body: text }).passthrough()
  ),
  generateBranchName: endpoint(
    "POST",
    "/chat/text-generation/branch-name",
    chatGenerateBranchNameSchema,
    z.object({ branch: text }).passthrough()
  ),
  generateThreadContextSummary: endpoint(
    "POST",
    "/chat/text-generation/thread-context-summary",
    chatGenerateThreadContextSummarySchema,
    z.object({ summary: text }).passthrough()
  ),
  generateSkillContent: endpoint(
    "POST",
    "/chat/text-generation/skill-content",
    chatGenerateSkillContentSchema,
    z.object({ content: text }).passthrough()
  ),
  // Reads (lists, evaluate, trust get) are open to paired devices; every
  // other permission route is the desktop owner's.
  permissionClaudeRulesList: endpoint(
    "POST",
    "/permissions/claude-rules/list",
    permissionRulesListSchema,
    z.object({ rules: z.array(claudePermissionRuleSchema) }).passthrough()
  ),
  permissionClaudeRuleDelete: endpoint(
    "POST",
    "/permissions/claude-rules/delete",
    permissionRuleDeleteSchema,
    permissionChangeResultSchema
  ),
  permissionSessionRulesList: endpoint(
    "POST",
    "/permissions/session-rules/list",
    permissionRulesListSchema,
    z.object({ rules: z.array(sessionPermissionRuleSchema) }).passthrough()
  ),
  permissionSessionRuleDelete: endpoint(
    "POST",
    "/permissions/session-rules/delete",
    permissionRuleDeleteSchema,
    permissionChangeResultSchema
  ),
  permissionGrantsList: endpoint(
    "POST",
    "/permissions/grants/list",
    agentPermissionGrantListSchema,
    z
      .object({ grants: z.array(agentPermissionGrantResponseSchema) })
      .passthrough()
  ),
  permissionGrantUpsert: endpoint(
    "POST",
    "/permissions/grants/upsert",
    agentPermissionGrantUpsertSchema,
    z.object({ grant: agentPermissionGrantResponseSchema }).passthrough()
  ),
  permissionGrantDelete: endpoint(
    "POST",
    "/permissions/grants/delete",
    agentPermissionGrantDeleteSchema,
    permissionChangeResultSchema
  ),
  permissionGrantEvaluate: endpoint(
    "POST",
    "/permissions/grants/evaluate",
    agentPermissionEvaluateSchema,
    z.object({ evaluation: agentPermissionEvaluationSchema }).passthrough()
  ),
  workspaceTrustGet: endpoint(
    "POST",
    "/permissions/workspace-trust/get",
    workspaceTrustGetSchema,
    workspaceTrustResponseSchema
  ),
  workspaceTrustSet: endpoint(
    "POST",
    "/permissions/workspace-trust/set",
    workspaceTrustSetSchema,
    workspaceTrustResponseSchema
  ),
  // When the user opens a folder: never overrides an explicit decision.
  workspaceTrustEnsure: endpoint(
    "POST",
    "/permissions/workspace-trust/ensure",
    workspaceTrustGetSchema,
    workspaceTrustResponseSchema
  ),
} as const
