import { useChatStore } from "@/lib/chat-store"
import type { ModelCycleFavoriteEntry } from "@/lib/model-cycle"
import type { UiProvider } from "@/lib/provider-types"
import type {
  RuntimeMcpServer,
  RuntimeSkill,
  RuntimeSubagent,
} from "@/lib/runtime-config"
import type {
  WorkspaceProjectCommand,
  WorkspaceProjectConfigSetting,
  WorkspaceProjectFormatter,
  WorkspaceProjectLspServer,
  WorkspaceProjectPermissionRule,
  WorkspaceProjectPlugin,
  WorkspaceProjectProvidersSummary,
  WorkspaceProjectReference,
  WorkspaceProjectToolFlag,
} from "@/services/backend/workspaceApi"
import type { ActiveThreadRef } from "./provider-config"
import type { SlashCommandSpec } from "./slash-registry"

export interface SlashRuntimeContext {
  cmd: string
  args: string[]
  trimmedText: string
  rawText: string
  threadId: string | null
  selectedProvider: UiProvider | undefined
  selectedProviderId?: string
  selectedModel: string
  providers?: UiProvider[]
  favoriteEntries?: ModelCycleFavoriteEntry[]
  toggleFavorite?: (providerId: string, modelId: string) => void
  isFavorite?: (providerId: string, modelId: string) => boolean
  setSelectedProviderId?: (id: string) => void
  setSelectedModel?: (id: string, providerId?: string) => void
  thinkingMode: string | null
  chatMode: string
  setChatMode: (mode: string) => void
  specialMode: string | null
  permissionLevel: string
  contextWindow: string
  fastMode: boolean
  appMode: "agent" | "editor" | "design"
  openModelPicker?: () => void
  openCommandPalette?: () => void
  closeSlash: () => void
  activeThread: ActiveThreadRef
  effectiveChatMode: string
}

export interface SlashRuntimeResult {
  handled: boolean
  output: string
  threadId?: string | null
  outputMessageId?: string
  outputMessageCreatedAt?: string
  outputMessageCompactionGeneration?: number
  outputUserMessageId?: string
  outputUserMessageCreatedAt?: string
}

/**
 * One slash command invocation as the command specs see it: the submitted
 * context, the chat store read when the command started, and the output the
 * specs build up. `threadId` starts as the invoking chat and a spec may
 * replace it, for example when it has to create a chat first.
 */
export interface SlashCommandRun extends Omit<
  SlashRuntimeContext,
  "providers" | "favoriteEntries"
> {
  providers: UiProvider[]
  favoriteEntries: ModelCycleFavoriteEntry[]
  store: ReturnType<typeof useChatStore.getState>
  output: string
  outputMessageId: string | undefined
  outputMessageCreatedAt: string | undefined
  outputMessageCompactionGeneration: number | undefined
  outputUserMessageId: string | undefined
  outputUserMessageCreatedAt: string | undefined
}

/**
 * Runtime MCPs, skills and subagents plus the workspace project config,
 * loaded once before the runtime-phase specs run.
 */
export interface SlashCommandRuntimeLists {
  mcpList: RuntimeMcpServer[]
  skillList: RuntimeSkill[]
  subagentList: RuntimeSubagent[]
  projectSubagentList: RuntimeSubagent[]
  projectCommandList: WorkspaceProjectCommand[]
  projectReferenceList: WorkspaceProjectReference[]
  projectFormatterList: WorkspaceProjectFormatter[]
  projectLspServerList: WorkspaceProjectLspServer[]
  projectPermissionList: WorkspaceProjectPermissionRule[]
  projectConfigList: WorkspaceProjectConfigSetting[]
  projectProvidersSummary: WorkspaceProjectProvidersSummary | null
  projectPluginList: WorkspaceProjectPlugin[]
  projectToolList: WorkspaceProjectToolFlag[]
}

export type SlashCommandRuntimeRun = SlashCommandRun & SlashCommandRuntimeLists

/**
 * What a spec returns: a result ends the command at once; nothing lets the
 * run continue with the output the spec set.
 */
export type SlashCommandStepResult = SlashRuntimeResult | void

export type SlashCommandRunSpec<TRun extends SlashCommandRun> =
  SlashCommandSpec<
    TRun,
    SlashCommandStepResult | Promise<SlashCommandStepResult>
  >

export function createSlashCommandRun(
  context: SlashRuntimeContext
): SlashCommandRun {
  return {
    ...context,
    providers: context.providers ?? [],
    favoriteEntries: context.favoriteEntries ?? [],
    store: useChatStore.getState(),
    output: "",
    outputMessageId: undefined,
    outputMessageCreatedAt: undefined,
    outputMessageCompactionGeneration: undefined,
    outputUserMessageId: undefined,
    outputUserMessageCreatedAt: undefined,
  }
}

export function slashAbort(
  result: Omit<SlashRuntimeResult, "handled">
): SlashRuntimeResult {
  return { handled: true, ...result }
}

/** Ends the command as handled with the run's current state. */
export function abortSlashRun(
  run: SlashCommandRun,
  overrides: Partial<Omit<SlashRuntimeResult, "handled">> = {}
): SlashRuntimeResult {
  return slashAbort({
    threadId: run.threadId,
    output: run.output,
    outputMessageId: run.outputMessageId,
    outputMessageCreatedAt: run.outputMessageCreatedAt,
    outputMessageCompactionGeneration: run.outputMessageCompactionGeneration,
    outputUserMessageId: run.outputUserMessageId,
    outputUserMessageCreatedAt: run.outputUserMessageCreatedAt,
    ...overrides,
  })
}
