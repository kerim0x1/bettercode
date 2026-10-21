import { z } from "zod"
import { chatAttachmentSchema } from "./chat"
import { providerOptionSelectionSchema } from "./model-selection"
import { chatOrchestrationSchema } from "./orchestrator"

export const threadSaveMessageSchema = z.object({
  id: z.string().trim().min(1, "message.id is required").max(256),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z
    .string()
    .max(4 * 1024 * 1024)
    .default(""),
  createdAt: z
    .string()
    .min(1, "message.createdAt is required")
    .max(64)
    .refine(
      (value) => Number.isFinite(Date.parse(value)),
      "Invalid message timestamp"
    ),
  turnId: z.string().trim().min(1).max(256).nullish(),
  reasoning: z.unknown().optional(),
  reasoningDurationMs: z.number().nonnegative().optional(),
  toolCalls: z.unknown().optional(),
  questions: z.unknown().optional(),
  answeredQuestions: z.unknown().optional(),
  diffs: z.unknown().optional(),
  attachments: z.array(chatAttachmentSchema).max(100).default([]),
  usage: z.unknown().optional(),
  modelId: z.unknown().optional(),
  compactedContext: z.boolean().optional(),
  internalContext: z.literal("provider-handoff").optional(),
  compactionGeneration: z.number().int().nonnegative().optional(),
})

export const threadSaveSchema = z
  .object({
    id: z.string().trim().min(1, "thread.id is required").max(256),
    title: z.string().max(1_024).default("New Chat"),
    projectName: z.string().trim().min(1).max(1_024).default("default"),
    projectPath: z.string().max(32_768).default(""),
    envMode: z.string().nullish(),
    branch: z.string().nullish(),
    worktreePath: z.string().nullish(),
    baseBranch: z.string().nullish(),
    worktreeState: z.string().nullish(),
    parentThreadId: z.string().nullish(),
    createdAt: z
      .string()
      .min(1, "thread.createdAt is required")
      .max(64)
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "Invalid thread timestamp"
      ),
    updatedAt: z
      .string()
      .min(1, "thread.updatedAt is required")
      .max(64)
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "Invalid thread timestamp"
      ),
    codexThreadId: z.string().nullish(),
    messages: z.array(threadSaveMessageSchema).max(10_000).default([]),
  })
  .superRefine((thread, context) => {
    const seen = new Set<string>()
    thread.messages.forEach((message, index) => {
      if (seen.has(message.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate message id '${message.id}'`,
          path: ["messages", index, "id"],
        })
      }
      seen.add(message.id)
    })
  })

export type ThreadSaveBody = z.infer<typeof threadSaveSchema>
export type ThreadSaveMessage = z.infer<typeof threadSaveMessageSchema>

/**
 * Body for POST /threads/:id/title: renames a chat and changes nothing else.
 * A full-metadata PATCH from a client with an older copy would also write
 * back whatever else that copy got wrong.
 */
export const threadRenameSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(1_024),
})

export type ThreadRenameBody = z.infer<typeof threadRenameSchema>

export const threadMetaSchema = z.object({
  title: z.string().max(1_024).default("New Chat"),
  projectName: z.string().trim().min(1).max(1_024).default("default"),
  projectPath: z.string().max(32_768).default(""),
  envMode: z.string().nullish(),
  branch: z.string().nullish(),
  worktreePath: z.string().nullish(),
  baseBranch: z.string().nullish(),
  worktreeState: z.string().nullish(),
  parentThreadId: z.string().nullish(),
  createdAt: z.string().min(1, "thread.createdAt is required"),
  updatedAt: z.string().min(1, "thread.updatedAt is required"),
  codexThreadId: z.string().nullish(),
})

export type ThreadMetaBody = z.infer<typeof threadMetaSchema>

const THREAD_SETTINGS_ID_MAX_CHARS = 512
const THREAD_SETTINGS_MAX_PROVIDERS = 64

/** One provider's composer choices in a chat: model, thinking, context window, options. */
export const threadProviderModelSettingsSchema = z.object({
  selectedModel: z.string().max(THREAD_SETTINGS_ID_MAX_CHARS).optional(),
  thinkingMode: z.string().max(128).nullable().optional(),
  contextWindow: z.string().max(32).optional(),
  fastMode: z.boolean().optional(),
  optionSelections: z.array(providerOptionSelectionSchema).max(128).optional(),
})

/**
 * A chat's own settings, kept with the chat in the backend: its permission
 * level, its model selection, its orchestration and the comparison it was
 * started in. Each is absent until a client sets it for this chat; the chat
 * then follows the client's defaults. (A chat's goal is kept with the chat
 * too, as `goal`.)
 */
export const threadSettingsSchema = z.object({
  permissionLevel: z.string().trim().min(1).max(64).optional(),
  selectedProviderId: z.string().max(THREAD_SETTINGS_ID_MAX_CHARS).optional(),
  selectedModel: z.string().max(THREAD_SETTINGS_ID_MAX_CHARS).optional(),
  modelSelectionByProvider: z
    .record(
      z.string().min(1).max(THREAD_SETTINGS_ID_MAX_CHARS),
      threadProviderModelSettingsSchema
    )
    .refine(
      (value) => Object.keys(value).length <= THREAD_SETTINGS_MAX_PROVIDERS,
      `modelSelectionByProvider is limited to ${THREAD_SETTINGS_MAX_PROVIDERS} providers`
    )
    .optional(),
  orchestration: chatOrchestrationSchema.optional(),
  /**
   * Shared by the chats one prompt started with several models at once
   * (Compare), so clients can show them as a group.
   */
  compareGroupId: z.string().trim().min(1).max(128).optional(),
  /**
   * Wake the chat when its branch's pull request gets a failed check, a
   * review or a merge conflict. Turned on only from the desktop; the backend
   * clears it once the pull request is merged or closed.
   */
  pullRequestWake: z.boolean().optional(),
})

export type ThreadSettings = z.infer<typeof threadSettingsSchema>

/** The keys `threadSettingsSchema` keeps, in one place for clients that copy them. */
export const THREAD_SETTINGS_KEYS = [
  "permissionLevel",
  "selectedProviderId",
  "selectedModel",
  "modelSelectionByProvider",
  "orchestration",
  "compareGroupId",
  "pullRequestWake",
] as const satisfies ReadonlyArray<keyof ThreadSettings>

/**
 * A change to a chat's settings: a key with a value replaces it, a key with
 * `null` clears it, and a key left out keeps its value.
 */
export const threadSettingsPatchSchema = z
  .object({
    permissionLevel: threadSettingsSchema.shape.permissionLevel.nullable(),
    selectedProviderId:
      threadSettingsSchema.shape.selectedProviderId.nullable(),
    selectedModel: threadSettingsSchema.shape.selectedModel.nullable(),
    modelSelectionByProvider:
      threadSettingsSchema.shape.modelSelectionByProvider.nullable(),
    orchestration: threadSettingsSchema.shape.orchestration.nullable(),
    compareGroupId: threadSettingsSchema.shape.compareGroupId.nullable(),
    pullRequestWake: threadSettingsSchema.shape.pullRequestWake.nullable(),
  })
  .strict()

export type ThreadSettingsPatch = z.infer<typeof threadSettingsPatchSchema>

/**
 * Body for PATCH /threads/:id. Either the chat's metadata, as before (the
 * whole set: title, project, workspace; a `settings` key in it is ignored),
 * or `{ settings }` alone, which changes only the chat's settings.
 */
export const threadUpdateSchema = z.union([
  threadMetaSchema,
  z.object({ settings: threadSettingsPatchSchema }).strict(),
])

export type ThreadUpdateBody = z.infer<typeof threadUpdateSchema>

export const threadMessageSchema = threadSaveMessageSchema.extend({
  id: z.string().min(1, "message.id is required"),
  createdAt: z.string().min(1, "message.createdAt is required"),
})

export type ThreadMessageBody = z.infer<typeof threadMessageSchema>

export const threadModelSwitchActivitySchema = z
  .object({
    activityId: z.string().trim().min(1).max(256),
    fromModelId: z.string().trim().min(1).max(1_024),
    toModelId: z.string().trim().min(1).max(1_024),
    createdAt: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "Invalid activity timestamp"
      ),
  })
  .strict()
  .refine((value) => value.fromModelId !== value.toModelId, {
    message: "Model switch requires two different model ids",
  })

export type ThreadModelSwitchActivityBody = z.infer<
  typeof threadModelSwitchActivitySchema
>

export const threadTruncateSchema = z.object({
  messageId: z.string().min(1, "messageId is required"),
  updatedAt: z.string().min(1, "updatedAt is required").optional(),
})

export type ThreadTruncateBody = z.infer<typeof threadTruncateSchema>

export const threadCheckpointRevertSchema = z.object({
  turnCount: z.coerce.number().int().nonnegative(),
  updatedAt: z.string().min(1, "updatedAt is required").optional(),
  preserveFuture: z.boolean().optional().default(false),
})

export type ThreadCheckpointRevertBody = z.infer<
  typeof threadCheckpointRevertSchema
>

export const threadCheckpointRecoveryResolveSchema = z.object({
  acknowledgeDataRisk: z.literal(true),
})

export type ThreadCheckpointRecoveryResolveBody = z.infer<
  typeof threadCheckpointRecoveryResolveSchema
>

export const threadWorktreeCreateSchema = z.object({
  baseRepoPath: z.string().min(1, "baseRepoPath is required"),
  baseBranch: z.string().min(1).optional(),
  firstMessage: z.string().optional().nullable(),
})

export type ThreadWorktreeCreateBody = z.infer<
  typeof threadWorktreeCreateSchema
>

export const threadWorktreeRemoveSchema = z.object({
  deleteBranch: z.boolean().optional().default(false),
  force: z.boolean().optional().default(true),
})

export type ThreadWorktreeRemoveBody = z.infer<
  typeof threadWorktreeRemoveSchema
>

export const threadWorktreeResetSchema = z.object({
  clean: z.boolean().optional().default(true),
  updateSubmodules: z.boolean().optional().default(true),
})

export type ThreadWorktreeResetBody = z.infer<typeof threadWorktreeResetSchema>
