import { z } from "zod"
import { chatAttachmentSchema } from "./chat"

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
