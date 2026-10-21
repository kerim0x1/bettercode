import { z } from "zod"
import { normalizeThinkingModeValue } from "./model-capabilities"
import {
  modelCapabilitiesSchema,
  type ModelCapabilities,
} from "./model-selection"

export const orchestratorProviderSchema = z.enum([
  "claude",
  "codex",
  "grok_cli",
])
export const orchestratorModelSchema = z
  .object({
    providerKind: orchestratorProviderSchema,
    providerInstanceId: z.string().trim().min(1).max(256),
    modelId: z.string().trim().min(1).max(256),
  })
  .strict()
export type OrchestratorModel = z.infer<typeof orchestratorModelSchema>

export const orchestratorModelKey = (model: OrchestratorModel): string =>
  JSON.stringify([model.providerKind, model.providerInstanceId, model.modelId])

export const orchestratorSelectedModelSchema = orchestratorModelSchema.extend({
  // Omitted or null means the provider's default, never "disable thinking".
  reasoningEffort: z.string().trim().min(1).max(128).nullable().optional(),
})
export type OrchestratorSelectedModel = z.infer<
  typeof orchestratorSelectedModelSchema
>

/**
 * Ultracode is a Claude Code prompt mode that starts its own multi-agent run.
 * A worker must not delegate further, so it is never a worker effort, even
 * though the main chat offers it for the same model.
 */
export function isOrchestratorExcludedEffort(
  effort: string | null | undefined
): boolean {
  return (
    typeof effort === "string" &&
    normalizeThinkingModeValue(effort) === "ultracode"
  )
}

/** Only advertised values are selectable; no guessed effort ladder for workers. */
export function orchestratorReasoningDescriptor(
  capabilities?: ModelCapabilities | null
) {
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.id === "reasoningEffort" || option.id === "effort")
  )
  if (descriptor?.type !== "select") return undefined
  const options = descriptor.options.filter(
    (option) => !isOrchestratorExcludedEffort(option.id)
  )
  if (!options.length) return undefined
  const { currentValue, ...rest } = descriptor
  const promptInjectedValues = rest.promptInjectedValues?.filter(
    (value) => !isOrchestratorExcludedEffort(value)
  )
  return {
    ...rest,
    options,
    ...(currentValue && !isOrchestratorExcludedEffort(currentValue)
      ? { currentValue }
      : {}),
    ...(promptInjectedValues ? { promptInjectedValues } : {}),
  }
}

/** A saved worker effort that is no longer allowed falls back to Auto. */
export function withoutExcludedOrchestratorEffort<
  T extends { reasoningEffort?: string | null },
>(model: T): T {
  return isOrchestratorExcludedEffort(model.reasoningEffort)
    ? { ...model, reasoningEffort: null }
    : model
}

const selectedModelsSchema = z
  .array(orchestratorSelectedModelSchema)
  .min(1)
  .max(128)
export const chatOrchestrationSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      providers: z
        .array(orchestratorProviderSchema)
        .min(1)
        .max(3)
        .refine(
          (values) => new Set(values).size === values.length,
          "Duplicate provider"
        ),
      // Omitted only by older saved chats: all available models of their providers.
      // An explicit list freezes exact account/model grants; it never means "all".
      models: selectedModelsSchema.optional(),
    })
    .strict()
    .superRefine((selection, context) => {
      if (!selection.models) return
      if (
        new Set(selection.models.map(orchestratorModelKey)).size !==
        selection.models.length
      )
        context.addIssue({
          code: "custom",
          path: ["models"],
          message: "Duplicate model",
        })
      if (
        selection.models.some(
          (model) => !selection.providers.includes(model.providerKind)
        ) ||
        selection.providers.some(
          (provider) =>
            !selection.models?.some((model) => model.providerKind === provider)
        )
      )
        context.addIssue({
          code: "custom",
          path: ["models"],
          message:
            "Select at least one model for each enabled provider and none outside that pool",
        })
    }),
])
export type ChatOrchestration = z.infer<typeof chatOrchestrationSchema>
export type OrchestratorProvider = z.infer<typeof orchestratorProviderSchema>

export const ORCHESTRATOR_PROVIDER_LABELS = {
  claude: "Claude",
  codex: "OpenAI",
  grok_cli: "Grok",
} satisfies Record<OrchestratorProvider, string>

/** The normal model picker owns the main provider. It is never a worker option.
 * Keep saved preferences intact when switching main providers; execution and UI
 * both derive the eligible pool. No remaining workers means ordinary chat.
 */
export function orchestrationForMain(
  selection: ChatOrchestration,
  mainProvider: string | null | undefined
): ChatOrchestration {
  if (!selection.enabled) return selection
  const providers = selection.providers.filter(
    (provider) => provider !== mainProvider
  )
  return providers.length
    ? {
        ...selection,
        providers,
        ...(selection.models
          ? {
              models: selection.models.filter(
                (model) => model.providerKind !== mainProvider
              ),
            }
          : {}),
      }
    : { enabled: false }
}

export const ORCHESTRATOR_CONTEXT_CHARS = 12_000
export const ORCHESTRATOR_CONTEXT_ITEMS = 64
const contextId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const orchestratorRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("team") }).strict(),
  z.object({ kind: z.literal("main") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      threadId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("member"), memberId: contextId }).strict(),
])
export const orchestratorContextAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("main"), threadId: z.string() }),
  z.object({
    kind: z.literal("member"),
    memberId: contextId,
    threadId: z.string(),
  }),
])
const noteSchema = z
  .object({
    kind: z.literal("note"),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(ORCHESTRATOR_CONTEXT_CHARS),
  })
  .strict()
const referenceSchema = z
  .object({
    kind: z.enum(["thread", "plan"]),
    threadId: z.string().trim().min(1).max(256),
  })
  .strict()
const forwardSchema = z
  .object({ kind: z.literal("forward"), contextId })
  .strict()
export const orchestratorContextShareSchema = z
  .object({
    requestId: contextId,
    recipient: orchestratorRecipientSchema,
    content: z.discriminatedUnion("kind", [noteSchema, forwardSchema]),
  })
  .strict()
export const orchestratorContextGrantSchema = z
  .object({
    threadId: z.string().trim().min(1).max(256),
    requestId: contextId,
    recipient: orchestratorRecipientSchema,
    content: z.discriminatedUnion("kind", [noteSchema, referenceSchema]),
  })
  .strict()
export const orchestratorContextKeySchema = z
  .object({
    threadId: z.string().trim().min(1).max(256),
    contextId,
  })
  .strict()
export const orchestratorContextSchema = z.object({
  id: contextId,
  requestId: contextId,
  requestHash: z.string().length(64),
  originId: contextId,
  author: orchestratorContextAuthorSchema,
  recipient: orchestratorRecipientSchema,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("note") }),
    referenceSchema,
  ]),
  title: z.string().max(160),
  body: z.string().max(ORCHESTRATOR_CONTEXT_CHARS),
  truncated: z.boolean(),
  createdAt: z.string(),
  readBy: z.array(z.object({ threadId: z.string(), at: z.string() })).max(64),
})
export const orchestratorContextPreviewSchema = orchestratorContextSchema.omit({
  body: true,
  requestHash: true,
  requestId: true,
})
export type OrchestratorRecipient = z.infer<typeof orchestratorRecipientSchema>
export type OrchestratorContext = z.infer<typeof orchestratorContextSchema>
export type OrchestratorContextPreview = z.infer<
  typeof orchestratorContextPreviewSchema
>
export type OrchestratorContextAuthor = z.infer<
  typeof orchestratorContextAuthorSchema
>
export type OrchestratorContextGrant = z.infer<
  typeof orchestratorContextGrantSchema
>
export type OrchestratorContextShare = z.infer<
  typeof orchestratorContextShareSchema
>

export const orchestratorMemberSchema = orchestratorSelectedModelSchema.extend({
  // Snapshot from the backend's trusted model catalog, not the chat payload.
  capabilities: modelCapabilitiesSchema.nullable().optional(),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(2000),
})
export const orchestratorTeamSchema = z
  .object({
    main: orchestratorModelSchema,
    members: z.array(orchestratorMemberSchema).min(1).max(160),
    maxConcurrent: z.number().int().min(1).max(4).default(2),
    maxTasks: z.number().int().min(1).max(32).default(12),
  })
  .strict()
  .refine(
    (team) =>
      new Set(team.members.map((member) => member.id)).size ===
      team.members.length,
    "Team member IDs must be unique"
  )
export const orchestratorJobSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  threadId: z.string(),
  task: z.string(),
  name: z.string().max(80).default(""),
  role: z.string().max(2000).default(""),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  output: z.string().max(24000),
  truncated: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
})
export const orchestratorSessionSchema = z.object({
  threadId: z.string(),
  projectPath: z.string(),
  team: orchestratorTeamSchema,
  mode: z.enum(["team", "chat"]).default("team"),
  allowedProviders: z.array(orchestratorProviderSchema).max(2).default([]),
  availableMemberIds: z.array(z.string()).max(128).default([]),
  selectedModels: selectedModelsSchema.optional(),
  currentTaskCount: z.number().int().nonnegative().max(32).default(0),
  status: z.enum(["ready", "stopped"]),
  permissionLevel: z.enum(["read-only", "ask-on-edit"]).nullable(),
  jobs: z.array(orchestratorJobSchema).max(32),
  context: z
    .array(orchestratorContextSchema)
    .max(ORCHESTRATOR_CONTEXT_ITEMS)
    .default([]),
  createdAt: z.string(),
})
export const orchestratorStartSchema = z
  .object({ projectPath: z.string().trim().min(1).max(32768) })
  .strict()
export const orchestratorThreadSchema = z
  .object({ threadId: z.string().trim().min(1).max(256) })
  .strict()
export type OrchestratorTeam = z.infer<typeof orchestratorTeamSchema>
export type OrchestratorMember = z.infer<typeof orchestratorMemberSchema>
export type OrchestratorJob = z.infer<typeof orchestratorJobSchema>
export type OrchestratorSession = z.infer<typeof orchestratorSessionSchema>
