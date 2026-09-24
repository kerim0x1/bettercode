import { z } from "zod"

const MAX_PATH_LEN = 2048
const MAX_QUERY_LEN = 256
const MAX_SEARCH_PATTERN_LEN = 1024
// 50MB write cap. Enough for any source file or document; stops a bad
// caller from asking the backend to materialize an arbitrarily large buffer.
const MAX_WRITE_BYTES = 50 * 1024 * 1024

export const workspaceSearchSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  query: z.string().max(MAX_QUERY_LEN).default(""),
})
export type WorkspaceSearchBody = z.infer<typeof workspaceSearchSchema>

export const workspaceContentSearchSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  query: z.string().trim().min(1).max(MAX_QUERY_LEN),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  regex: z.boolean().default(false),
  include: z.string().max(MAX_SEARCH_PATTERN_LEN).default(""),
  exclude: z.string().max(MAX_SEARCH_PATTERN_LEN).default(""),
})
export type WorkspaceContentSearchBody = z.infer<
  typeof workspaceContentSearchSchema
>

export const workspaceQuickOpenSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  query: z.string().max(MAX_QUERY_LEN).default(""),
  limit: z.coerce.number().int().min(1).max(200).default(80),
  include: z.string().max(MAX_SEARCH_PATTERN_LEN).default(""),
})
export type WorkspaceQuickOpenBody = z.infer<typeof workspaceQuickOpenSchema>

export const workspaceMapSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  maxFiles: z.coerce.number().int().min(100).max(20_000).default(5_000),
})
export type WorkspaceMapBody = z.infer<typeof workspaceMapSchema>

export const workspaceProjectCommandsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectCommandsBody = z.infer<
  typeof workspaceProjectCommandsSchema
>

export const workspaceProjectAgentsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectAgentsBody = z.infer<
  typeof workspaceProjectAgentsSchema
>

export const workspaceProjectSkillsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectSkillsBody = z.infer<
  typeof workspaceProjectSkillsSchema
>

export const workspaceProjectMcpServersSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectMcpServersBody = z.infer<
  typeof workspaceProjectMcpServersSchema
>

export const workspaceProjectInstructionsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectInstructionsBody = z.infer<
  typeof workspaceProjectInstructionsSchema
>

export const workspaceEffectiveRulesSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  targetPath: z.string().max(MAX_PATH_LEN).default("."),
})
export type WorkspaceEffectiveRulesBody = z.infer<
  typeof workspaceEffectiveRulesSchema
>

export const workspaceEffectiveRuleSourceKindSchema = z.enum([
  "global-file",
  "global-setting",
  "project-file",
  "directory-file",
  "configured-file",
  "remote-file",
  "target-file",
])
export type WorkspaceEffectiveRuleSourceKind = z.infer<
  typeof workspaceEffectiveRuleSourceKindSchema
>

export const workspaceEffectiveRuleScopeSchema = z.enum([
  "global",
  "project",
  "directory",
  "target",
])
export type WorkspaceEffectiveRuleScope = z.infer<
  typeof workspaceEffectiveRuleScopeSchema
>

export const workspaceEffectiveRuleSourceSchema = z.object({
  id: z.string().min(1).max(128),
  sourcePath: z.string().min(1).max(MAX_PATH_LEN),
  sourceKind: workspaceEffectiveRuleSourceKindSchema,
  scope: workspaceEffectiveRuleScopeSchema,
  scopePath: z.string().max(MAX_PATH_LEN).nullable(),
  targetGlobs: z.array(z.string().min(1).max(MAX_SEARCH_PATTERN_LEN)).max(64),
  precedence: z.number().int().nonnegative(),
  applied: z.boolean(),
  reason: z.string().min(1).max(2_048),
  content: z.string(),
  truncated: z.boolean(),
})
export type WorkspaceEffectiveRuleSource = z.infer<
  typeof workspaceEffectiveRuleSourceSchema
>

export const workspaceEffectiveRulesResultSchema = z.object({
  workspaceRoot: z.string().max(MAX_PATH_LEN).nullable(),
  targetPath: z.string().max(MAX_PATH_LEN),
  content: z.string(),
  sources: z.array(workspaceEffectiveRuleSourceSchema).max(256),
  explanation: z.object({
    mergeOrder: z.literal("low-to-high"),
    summary: z.string().min(1).max(4_096),
    precedence: z.array(z.string().min(1).max(1_024)).max(16),
  }),
})
export type WorkspaceEffectiveRulesResult = z.infer<
  typeof workspaceEffectiveRulesResultSchema
>

export const workspaceContextArtifactSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  targetPath: z.string().max(MAX_PATH_LEN).default("."),
  threadId: z.string().trim().min(1).max(256).optional(),
  pendingMessageCharacters: z
    .number()
    .int()
    .nonnegative()
    .max(1_000_000)
    .default(0),
  pendingAttachments: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(1_024),
        mediaType: z.string().max(256).nullable().default(null),
        sizeBytes: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_WRITE_BYTES)
          .nullable()
          .default(null),
      })
    )
    .max(64)
    .default([]),
})
export type WorkspaceContextArtifactBody = z.infer<
  typeof workspaceContextArtifactSchema
>

export const workspaceContextSourceKindSchema = z.enum([
  "system",
  "rules",
  "rule",
  "history",
  "message",
  "tool",
  "attachment",
  "prompt",
  "compaction",
])
export type WorkspaceContextSourceKind = z.infer<
  typeof workspaceContextSourceKindSchema
>

export const workspaceContextSourceSchema = z.object({
  id: z.string().min(1).max(256),
  parentId: z.string().min(1).max(256).nullable(),
  kind: workspaceContextSourceKindSchema,
  label: z.string().min(1).max(1_024),
  detail: z.string().max(4_096).nullable(),
  sourcePath: z.string().max(MAX_PATH_LEN).nullable(),
  estimatedTokens: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  included: z.boolean(),
  reason: z.string().min(1).max(2_048),
  truncated: z.boolean(),
})
export type WorkspaceContextSource = z.infer<
  typeof workspaceContextSourceSchema
>

export const workspaceContextArtifactResultSchema = z.object({
  workspaceRoot: z.string().max(MAX_PATH_LEN),
  targetPath: z.string().max(MAX_PATH_LEN),
  threadId: z.string().max(256).nullable(),
  usedTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive().nullable(),
  remainingTokens: z.number().int().nonnegative().nullable(),
  compactsAutomatically: z.boolean().nullable(),
  compaction: z.object({
    generation: z.number().int().nonnegative(),
    boundaryMessageId: z.string().max(256).nullable(),
    excludedMessageCount: z.number().int().nonnegative(),
  }),
  sources: z.array(workspaceContextSourceSchema).max(2_048),
})
export type WorkspaceContextArtifactResult = z.infer<
  typeof workspaceContextArtifactResultSchema
>

export const workspaceProjectReferencesSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectReferencesBody = z.infer<
  typeof workspaceProjectReferencesSchema
>

export const workspaceProjectFormattersSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectFormattersBody = z.infer<
  typeof workspaceProjectFormattersSchema
>

export const workspaceProjectFormatSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  relativePath: z.string().min(1).max(MAX_PATH_LEN),
  formatterId: z.string().trim().min(1).max(128).optional(),
})
export type WorkspaceProjectFormatBody = z.infer<
  typeof workspaceProjectFormatSchema
>

export const workspaceProjectLspServersSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectLspServersBody = z.infer<
  typeof workspaceProjectLspServersSchema
>

export const workspaceProjectPermissionsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectPermissionsBody = z.infer<
  typeof workspaceProjectPermissionsSchema
>

export const workspaceProjectConfigSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectConfigBody = z.infer<
  typeof workspaceProjectConfigSchema
>

export const workspaceProjectProvidersSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectProvidersBody = z.infer<
  typeof workspaceProjectProvidersSchema
>

export const workspaceProjectPluginsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectPluginsBody = z.infer<
  typeof workspaceProjectPluginsSchema
>

export const workspaceProjectToolsSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceProjectToolsBody = z.infer<
  typeof workspaceProjectToolsSchema
>

export const workspaceReadSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  relativePath: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceReadBody = z.infer<typeof workspaceReadSchema>

export const workspaceWriteSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  relativePath: z.string().min(1).max(MAX_PATH_LEN),
  contents: z.string().max(MAX_WRITE_BYTES),
})
export type WorkspaceWriteBody = z.infer<typeof workspaceWriteSchema>

export const workspaceMkdirSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  relativePath: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceMkdirBody = z.infer<typeof workspaceMkdirSchema>

/**
 * Moves whatever a project-less chat built in its scratch workspace into the
 * repository it is being forked into.
 */
export const workspaceAdoptScratchSchema = z.object({
  threadId: z.string().min(1).max(128),
  destination: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceAdoptScratchBody = z.infer<
  typeof workspaceAdoptScratchSchema
>

export const workspaceMoveSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  fromRelativePath: z.string().min(1).max(MAX_PATH_LEN),
  toRelativePath: z.string().min(1).max(MAX_PATH_LEN),
})
export type WorkspaceMoveBody = z.infer<typeof workspaceMoveSchema>

export const workspaceDeleteSchema = z.object({
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  relativePath: z.string().min(1).max(MAX_PATH_LEN),
  recursive: z.boolean().default(false),
})
export type WorkspaceDeleteBody = z.infer<typeof workspaceDeleteSchema>
