import { isClaudeOpusOrSonnet } from "@/lib/anthropic-model"
import {
  BROWSER_ELEMENT_ATTACHMENT_TYPE,
  withBrowserElementContext,
  parseGoalCommand,
  orchestrationForMain,
} from "@betterc0de/schema"
import { activeContextMessages } from "@/lib/chat-context"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import type { SourceProposedPlanReference } from "@/lib/plan-modal"
import { thinkingModeToEffort } from "@/lib/thinking-mode"
import type {
  AgentPermissionBehavior,
  AgentPermissionDestination,
  AgentPermissionGrant,
  ChatAttachment,
  ChatOrchestration,
  ChatAutoCompactionDecisionResult,
  DesignBrief,
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
  ThreadActivity,
  WorkspaceTrustRecord,
  WorkspaceTrustState,
} from "@betterc0de/schema"
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  normalizeModelSlug,
  resolvePromptInjectedEffort,
} from "@betterc0de/schema/model-selection"
import { invokeContract } from "./contracts"
import { invoke } from "./runtime"
import type {
  WorkspaceProjectAgent,
  WorkspaceProjectPermissionRule,
} from "./workspaceApi"
export type {
  AgentPermissionGrant,
  WorkspaceTrustRecord,
} from "@betterc0de/schema"

type PromptSkill = { name: string; content: string }
type RuntimePromptSkill = PromptSkill & {
  providerKinds?: string[]
  providerInstanceIds?: string[]
  source?: string
  sourcePath?: string
}
type PromptMcp = { name: string; command: string; args?: string[] }
type PromptSubagent = {
  name: string
  description?: string
  prompt?: string
  mode?: string
  model?: string
  source?: string
  sourcePath?: string
  tools?: Record<string, boolean>
  permissions?: WorkspaceProjectPermissionRule[]
}
type RuntimePromptContext = {
  customRules: string
  skills: RuntimePromptSkill[]
  mcps: PromptMcp[]
  subagents: PromptSubagent[]
}

function providerScopeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

function canonicalProviderKind(value: string | null | undefined): string {
  const key = providerScopeKey(value)
  const compactKey = key.replace(/-/g, "")
  if (["codex-cli", "openai-cli"].includes(key)) return "codex"
  if (
    ["claude-cli", "claude-agent", "anthropic-cli"].includes(key) ||
    compactKey === "claudeagent"
  ) {
    return "claude"
  }
  if (["openai-api", "openai-oauth", "openaiapi", "openaioauth"].includes(key))
    return "openai"
  // NOT "grok" — the hub CLI provider is distinct from the xAI API adapter.
  // (providerScopeKey already folds "grok_cli" to "grok-cli".)
  if (key === "grok-cli" || compactKey === "grokcli") return "grok-cli"
  return key
}

function providerUsesNativeSkills(providerKind: string): boolean {
  return ["codex", "claude"].includes(canonicalProviderKind(providerKind))
}

function isProjectPromptSkill(skill: RuntimePromptSkill): boolean {
  if (
    skill.source === "betterc0de" ||
    skill.source === "BetterC0de" ||
    skill.source === "project"
  ) {
    return true
  }
  const path = providerScopeKey(skill.sourcePath)
  return (
    path.includes("/.betterc0de/") ||
    path.startsWith(".betterc0de/") ||
    path.includes("/.BetterC0de/") ||
    path.startsWith(".BetterC0de/") ||
    path.includes("/.agents/skills/") ||
    path.startsWith(".agents/skills/") ||
    path.includes("/.claude/skills/") ||
    path.startsWith(".claude/skills/")
  )
}

function runtimeSkillAppliesToProvider(
  skill: RuntimePromptSkill,
  input: { providerKind: string; providerInstanceId?: string | null }
): boolean {
  const instanceScopes = (skill.providerInstanceIds ?? [])
    .map(providerScopeKey)
    .filter(Boolean)
  if (instanceScopes.length > 0) {
    const targetInstance = providerScopeKey(input.providerInstanceId)
    return Boolean(targetInstance && instanceScopes.includes(targetInstance))
  }

  const kindScopes = (skill.providerKinds ?? [])
    .map(canonicalProviderKind)
    .filter(Boolean)
  if (kindScopes.length > 0) {
    return kindScopes.includes(canonicalProviderKind(input.providerKind))
  }

  return true
}

export function selectPromptSkillsForProvider(
  skills: ReadonlyArray<RuntimePromptSkill>,
  input: { providerKind: string; providerInstanceId?: string | null }
): PromptSkill[] {
  if (providerUsesNativeSkills(input.providerKind)) {
    return skills
      .filter(isProjectPromptSkill)
      .map((skill) => ({ name: skill.name, content: skill.content }))
  }
  return skills
    .filter((skill) => runtimeSkillAppliesToProvider(skill, input))
    .map((skill) => ({ name: skill.name, content: skill.content }))
}

export function formatBetterC0deProjectPermissionRulesForPrompt(
  rules: readonly WorkspaceProjectPermissionRule[]
): string | null {
  if (rules.length === 0) return null
  return [
    "## BetterC0de Project Permission Rules",
    "Apply these project-local tool permission rules as additional restrictions. They never override BetterC0de's current permission mode to allow a more dangerous action.",
    "",
    "| Permission | Pattern | Action | Source |",
    "|:-----------|:--------|:-------|:-------|",
    ...rules.map(
      (rule) =>
        `| \`${escapePromptTableCell(rule.permission)}\` | \`${escapePromptTableCell(rule.pattern)}\` | **${rule.action}** | \`${escapePromptTableCell(rule.sourcePath)}\` |`
    ),
  ].join("\n")
}

function escapePromptTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ")
}

function mergePromptSkills(
  primary: ReadonlyArray<RuntimePromptSkill>,
  additions: ReadonlyArray<RuntimePromptSkill>
): RuntimePromptSkill[] {
  if (additions.length === 0) return [...primary]
  const mergedByName = new Map(primary.map((skill) => [skill.name, skill]))
  for (const skill of additions) {
    mergedByName.set(skill.name, skill)
  }
  return Array.from(mergedByName.values())
}

function mergePromptMcps(
  primary: ReadonlyArray<PromptMcp>,
  additions: ReadonlyArray<PromptMcp>
): PromptMcp[] {
  if (additions.length === 0) return [...primary]
  const mergedByName = new Map(primary.map((mcp) => [mcp.name, mcp]))
  for (const mcp of additions) {
    mergedByName.set(mcp.name, mcp)
  }
  return Array.from(mergedByName.values())
}

export function projectAgentsToPromptSubagents(
  agents: ReadonlyArray<WorkspaceProjectAgent>
): PromptSubagent[] {
  return agents
    .filter((agent) => agent.enabled !== false && agent.hidden !== true)
    .map((agent) => ({
      name: agent.name || agent.id,
      description:
        agent.description ||
        [
          agent.mode ? `BetterC0de ${agent.mode}` : "BetterC0de project agent",
          agent.model ? `model ${agent.model}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      prompt: agent.prompt,
      mode: agent.mode,
      model: agent.model,
      source: "betterc0de",
      sourcePath: agent.sourcePath,
      tools: agent.tools,
      permissions: agent.permissions,
    }))
}

export function mergePromptSubagents(
  primary: ReadonlyArray<PromptSubagent>,
  additions: ReadonlyArray<PromptSubagent>
): PromptSubagent[] {
  if (additions.length === 0) return [...primary]
  const mergedByName = new Map(
    primary.map((subagent) => [subagent.name, subagent])
  )
  for (const subagent of additions) {
    mergedByName.set(subagent.name, subagent)
  }
  return Array.from(mergedByName.values())
}

function defaultModelSelectionInstanceId(providerKind: string): string {
  return canonicalProviderKind(providerKind) || "codex"
}

function effortOptionIdForProvider(providerKind: string): string {
  const provider = canonicalProviderKind(providerKind)
  if (provider === "codex") {
    return "reasoningEffort"
  }
  if (provider === "cursor") return "reasoning"
  return "effort"
}

function thinkingModeToProviderEffort(
  providerKind: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (!reasoningEffort) return null
  const normalizedProvider = canonicalProviderKind(providerKind)
  const normalizedEffort = reasoningEffort
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (
    normalizedProvider === "claude" ||
    normalizedProvider === "anthropic" ||
    normalizedProvider === "anthropic_cli" ||
    normalizedProvider === "anthropic-cli" ||
    normalizedProvider === "claude_cli" ||
    normalizedProvider === "claude-cli"
  ) {
    if (normalizedEffort === "ultrathink") return "ultrathink"
    if (normalizedEffort === "max") return "max"
    if (normalizedEffort === "xhigh" || normalizedEffort === "extrahigh") {
      return "max"
    }
  }
  if (normalizedEffort === "extrahigh") return "xhigh"
  return thinkingModeToEffort(reasoningEffort)
}

function supportsFastModeProvider(providerKind: string): boolean {
  return ["codex", "claude", "cursor"].includes(
    canonicalProviderKind(providerKind)
  )
}

function supportsContextWindowProvider(providerKind: string): boolean {
  return ["claude", "anthropic", "cursor"].includes(
    canonicalProviderKind(providerKind)
  )
}

export function buildModelSelection(input: {
  modelId: string
  providerKind: string
  providerInstanceId?: string | null
  reasoningEffort?: string | null
  fastMode?: boolean | null
  contextWindow?: string | null
  capabilities?: ModelCapabilities | null
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
}): ModelSelection {
  const modelId =
    normalizeModelSlug(input.modelId, input.providerKind) ?? input.modelId
  const options: ProviderOptionSelection[] = []
  const effort = thinkingModeToProviderEffort(
    input.providerKind,
    input.reasoningEffort
  )
  if (effort) {
    options.push({
      id: effortOptionIdForProvider(input.providerKind),
      value: effort,
    })
  }
  if (
    typeof input.fastMode === "boolean" &&
    supportsFastModeProvider(input.providerKind)
  ) {
    options.push({ id: "fastMode", value: input.fastMode })
  }
  if (
    supportsContextWindowProvider(input.providerKind) &&
    (canonicalProviderKind(input.providerKind) === "cursor" ||
      isClaudeOpusOrSonnet(modelId)) &&
    (input.contextWindow === "200k" || input.contextWindow === "1m")
  ) {
    options.push({ id: "contextWindow", value: input.contextWindow })
  }
  const selectedOptions = mergeProviderOptionSelections(
    options,
    input.optionSelections
  )
  const descriptorOptions = input.capabilities
    ? buildProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: input.capabilities,
          selections: selectedOptions,
        })
      )
    : undefined
  const modelOptions =
    descriptorOptions ??
    (selectedOptions.length > 0 ? selectedOptions : undefined)
  return {
    instanceId:
      input.providerInstanceId ??
      defaultModelSelectionInstanceId(input.providerKind),
    model: modelId,
    ...(modelOptions ? { options: modelOptions } : {}),
  }
}

function mergeProviderOptionSelections(
  primary: ReadonlyArray<ProviderOptionSelection>,
  override: ReadonlyArray<ProviderOptionSelection> | null | undefined
): ProviderOptionSelection[] {
  if (!override || override.length === 0) return [...primary]
  const byId = new Map<string, ProviderOptionSelection>()
  for (const option of primary) byId.set(option.id, option)
  for (const option of override) byId.set(option.id, option)
  return Array.from(byId.values())
}

export function buildProviderPrompt(input: {
  message: string
  providerKind: string
  reasoningEffort?: string | null
  capabilities?: ModelCapabilities | null
}): string {
  const effort = thinkingModeToProviderEffort(
    input.providerKind,
    input.reasoningEffort
  )
  const promptInjectedEffort = resolvePromptInjectedEffort(
    input.capabilities,
    effort
  )
  return applyClaudePromptEffortPrefix(input.message, promptInjectedEffort)
}

/**
 * Legacy alias normalization for kebab/snake variants of OpenAI provider
 * IDs. Pre-codex_cli-adapter, the renderer routed every OpenAI flavor —
 * direct API, OAuth, and CLI — through the same `openai` provider kind
 * with a transport hint. The CLI flavor now lives on its own backend
 * adapter (`codex_cli`), so we MUST NOT map back to `openai` for it —
 * doing so dispatches to OpenAiCompatAdapter which has no API key and
 * throws "OpenAI is not configured". The `codex_cli` family stays
 * untouched and flows directly to the dedicated CLI adapter.
 */
function normalizeOpenAiTarget(
  providerKind: string,
  openaiTransport?: string | null
): { providerKind: string; openaiTransport: string | null } {
  const normalizedKind = providerKind.trim().toLowerCase()
  const explicitTransport = openaiTransport?.trim().toLowerCase() || null
  if (explicitTransport) {
    return { providerKind, openaiTransport: explicitTransport }
  }

  if (["openai-api", "openai_api", "openaiapi"].includes(normalizedKind)) {
    return { providerKind: "openai", openaiTransport: "api" }
  }
  if (
    ["openai-oauth", "openai_oauth", "openaioauth"].includes(normalizedKind)
  ) {
    return { providerKind: "openai", openaiTransport: "oauth" }
  }
  return { providerKind, openaiTransport: explicitTransport }
}

export function workspaceRuleTargetPath(
  workspaceRoot: string,
  filePath: string
): string | null {
  const normalizedRoot = workspaceRoot.trim().replace(/\\/g, "/")
  const normalizedFile = filePath.trim().replace(/\\/g, "/")
  if (!normalizedRoot || !normalizedFile) return null

  const fileIsAbsolute =
    normalizedFile.startsWith("/") ||
    normalizedFile.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalizedFile)
  if (!fileIsAbsolute) {
    const relative = normalizedFile.replace(/^\.\/+/, "")
    return relative &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !relative.includes("/../")
      ? relative
      : null
  }

  const root =
    normalizedRoot === "/" ? normalizedRoot : normalizedRoot.replace(/\/+$/, "")
  const prefix = root.endsWith("/") ? root : `${root}/`
  const caseInsensitive =
    /^[A-Za-z]:/.test(root) || normalizedRoot.startsWith("//")
  const rootKey = caseInsensitive ? root.toLowerCase() : root
  const prefixKey = caseInsensitive ? prefix.toLowerCase() : prefix
  const fileKey = caseInsensitive
    ? normalizedFile.toLowerCase()
    : normalizedFile
  if (fileKey === rootKey) return "."
  return fileKey.startsWith(prefixKey)
    ? normalizedFile.slice(prefix.length)
    : null
}

async function resolveRendererRuleTargetPath(
  workspaceRoot: string | null | undefined,
  explicitTarget: string | null | undefined
): Promise<string> {
  const explicit = explicitTarget?.trim()
  if (explicit) return explicit
  if (!workspaceRoot) return "."
  try {
    const { useEditorStore } = await import("@/lib/editor-store")
    const editor = useEditorStore.getState()
    const activeTab = editor.tabs.find((tab) => tab.id === editor.activeTabId)
    return (
      workspaceRuleTargetPath(workspaceRoot, activeTab?.filePath ?? "") ?? "."
    )
  } catch {
    return "."
  }
}

export interface DispatchUserMessage {
  id: string
  content: string
  createdAt: string
}

type ChatSendContextCheckpoint = NonNullable<
  import("@betterc0de/schema/http-contracts").ChatSendResponse[
    | "automaticCompaction"
    | "providerHandoff"]
>

function automaticCompactionUsage(
  usage:
    | {
        usedTokens?: number
        totalTokens?: number
        inputTokens?: number
        maxTokens?: number
        compactsAutomatically?: boolean
      }
    | null
    | undefined
): {
  usedTokens?: number
  maxTokens?: number
  compactsAutomatically?: boolean
} | null {
  if (!usage) return null
  const usedTokens = [usage.usedTokens, usage.totalTokens, usage.inputTokens]
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    )
    .reduce<
      number | undefined
    >((largest, value) => (largest === undefined ? value : Math.max(largest, value)), undefined)
  const maxTokens =
    typeof usage.maxTokens === "number" &&
    Number.isSafeInteger(usage.maxTokens) &&
    usage.maxTokens > 0
      ? usage.maxTokens
      : undefined
  const compactsAutomatically =
    typeof usage.compactsAutomatically === "boolean"
      ? usage.compactsAutomatically
      : undefined
  if (
    usedTokens === undefined &&
    maxTokens === undefined &&
    compactsAutomatically === undefined
  ) {
    return null
  }
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
  }
}

function automaticCompactionModelLimits(
  contextWindow: string | null | undefined
): { contextTokens: number } | null {
  const normalized = (contextWindow ?? "")
    .trim()
    .replaceAll(",", "")
    .replaceAll("_", "")
    .toUpperCase()
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMG])?$/)
  if (!match) return null
  const amount = Number(match[1])
  const multiplier =
    match[2] === "G"
      ? 1_000_000_000
      : match[2] === "M"
        ? 1_000_000
        : match[2] === "K"
          ? 1_000
          : 1
  const contextTokens = Math.floor(amount * multiplier)
  return Number.isSafeInteger(contextTokens) &&
    contextTokens > 0 &&
    contextTokens <= 16_000_000
    ? { contextTokens }
    : null
}

function projectContextCheckpoint(
  chatStore: typeof import("@/lib/chat-store"),
  threadId: string,
  compaction: ChatSendContextCheckpoint | undefined
): void {
  if (!compaction) return
  const store = chatStore.useChatStore.getState()
  const existingIds = new Set(
    store.threads
      .find((thread) => thread.id === threadId)
      ?.messages.map((message) => message.id) ?? []
  )
  if (!existingIds.has(compaction.commandMessageId)) {
    store.addMessage(
      threadId,
      {
        id: compaction.commandMessageId,
        role: "user",
        content: compaction.commandContent,
        ...(compaction.reason === "provider-switch"
          ? { internalContext: "provider-handoff" as const }
          : {}),
        createdAt: compaction.commandCreatedAt,
      },
      { persist: false }
    )
  }
  if (!existingIds.has(compaction.checkpointMessageId)) {
    store.addMessage(
      threadId,
      {
        id: compaction.checkpointMessageId,
        role: "assistant",
        content: compaction.checkpointContent,
        compactedContext: true,
        ...(compaction.reason === "provider-switch"
          ? { internalContext: "provider-handoff" as const }
          : {}),
        compactionGeneration: compaction.generation,
        createdAt: compaction.checkpointCreatedAt,
      },
      { persist: false }
    )
  }
}

export async function sendGoalControl(
  threadId: string,
  message: string,
  modelId: string
): Promise<void> {
  const { useChatStore } = await import("@/lib/chat-store")
  const revision = useChatStore
    .getState()
    .getThreadSettings(threadId).goalRevision
  const result = await invokeContract("chatGoal", {
    body: { threadId, message, modelId },
  })
  if (
    useChatStore.getState().getThreadSettings(threadId).goalRevision ===
    revision
  ) {
    useChatStore.getState().setThreadSetting(threadId, "goal", result.goal)
  }
  if (!result.goal && parseGoalCommand(message)?.action === "status") {
    const { toast } = await import("sonner")
    toast.info("No goal in this chat. Use /goal followed by your objective.")
  }
}

export const sendChatMessage = async (
  threadId: string,
  message: string,
  modelId: string,
  providerKind: string,
  reasoningEffort?: string | null,
  chatMode?: string | null,
  projectPath?: string | null,
  specialMode?: string | null,
  permissionLevel?: string | null,
  openaiTransport?: string | null,
  /** Codex Fast Mode (priority compute, OpenAI's `serviceTier: "fast"`).
   *  Boolean, orthogonal to reasoningEffort. Ignored on non-Codex providers. */
  fastMode?: boolean | null,
  providerInstanceId?: string | null,
  contextWindow?: string | null,
  capabilities?: ModelCapabilities | null,
  optimisticMessageContent?: string | DispatchUserMessage | null,
  sourceProposedPlan?: SourceProposedPlanReference | null,
  appMode?: "agent" | "editor" | "design" | null,
  designContext?: DesignBrief | null,
  attachments?: ChatAttachment[],
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null,
  ruleTargetPath?: string | null,
  orchestrationSelection?: ChatOrchestration
) => {
  const explicitDispatchMessage =
    optimisticMessageContent && typeof optimisticMessageContent === "object"
      ? optimisticMessageContent
      : null
  const optimisticContent =
    typeof optimisticMessageContent === "string"
      ? optimisticMessageContent
      : null
  const visibleUserContent =
    explicitDispatchMessage?.content ?? optimisticContent ?? message
  const dispatchUserMessage: DispatchUserMessage = explicitDispatchMessage ?? {
    id: crypto.randomUUID(),
    content: visibleUserContent,
    createdAt: new Date().toISOString(),
  }
  const openAiTarget = normalizeOpenAiTarget(providerKind, openaiTransport)
  const [
    { buildSystemInstruction },
    runtimeConfig,
    hookRuntime,
    projectRulesMod,
    chatStoreMod,
    settingsStoreMod,
  ] = await Promise.all([
    import("@/lib/mode-instructions"),
    import("@/lib/runtime-config"),
    import("@/lib/runtime-hooks"),
    import("@/lib/project-rules"),
    import("@/lib/chat-store"),
    import("@/lib/settings-store"),
  ])

  // Design context self-heals: an explicit argument wins (the composer passes
  // brief-or-null depending on app mode), while continuation senders (question
  // answers, autonomous-loop turns, plan handoffs) pass `undefined` and derive
  // the thread's saved brief here — so the design overlay survives mid-thread
  // turns instead of silently dropping after the first message.
  const resolvedDesignContext =
    designContext !== undefined
      ? designContext
      : (chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
          .designBrief ?? null)
  const designDefaults =
    settingsStoreMod.useSettingsStore.getState().designDefaults
  const orchestration = settingsStoreMod.useSettingsStore.getState()
    .orchestratorEnabled
    ? orchestrationForMain(
        orchestrationSelection ??
          chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
            .orchestration ?? { enabled: false },
        openAiTarget.providerKind
      )
    : { enabled: false as const }

  await hookRuntime.runBlockingMessageSendHooks({
    threadId,
    message,
    modelId,
    providerKind: openAiTarget.providerKind,
    projectPath,
  })

  const envContext = {
    os: navigator.platform.includes("Win")
      ? "windows"
      : navigator.platform.includes("Mac")
        ? "macos"
        : "linux",
    shell: "bash",
    projectPath: projectPath || undefined,
    projectName: projectPath
      ? projectPath.replace(/\\/g, "/").split("/").pop()
      : undefined,
  }

  let skills: PromptSkill[] = []
  let mcps: PromptMcp[] = []
  let customRules = ""
  let subagents: PromptSubagent[] = []
  let projectPermissionRules: WorkspaceProjectPermissionRule[] = []
  try {
    const promptContext =
      (await runtimeConfig.getRuntimePromptContext()) as RuntimePromptContext
    let runtimeSkills = promptContext.skills
    let runtimeMcps = promptContext.mcps
    let runtimeSubagents = promptContext.subagents
    if (projectPath) {
      try {
        const {
          listProjectAgents,
          listProjectMcpServers,
          listProjectPermissions,
          listProjectSkills,
        } = await import("@/services/backend/workspaceApi")
        const [projectMcps, projectSkills, projectAgents, permissions] =
          await Promise.all([
            listProjectMcpServers(projectPath),
            listProjectSkills(projectPath),
            listProjectAgents(projectPath),
            listProjectPermissions(projectPath),
          ])
        projectPermissionRules = permissions
        runtimeMcps = mergePromptMcps(
          runtimeMcps,
          projectMcps.map((mcp) => ({
            name: mcp.name,
            command: mcp.command,
            args: mcp.args,
          }))
        )
        runtimeSkills = mergePromptSkills(
          runtimeSkills,
          projectSkills.map((skill) => ({
            name: skill.name,
            content: skill.content,
            source: "betterc0de",
            sourcePath: skill.sourcePath,
            ...(skill.description ? { description: skill.description } : {}),
          }))
        )
        runtimeSubagents = mergePromptSubagents(
          runtimeSubagents,
          projectAgentsToPromptSubagents(projectAgents)
        )
      } catch {
        // Project-local BetterC0de metadata is optional workspace context.
      }
    }
    customRules = promptContext.customRules
    skills = selectPromptSkillsForProvider(runtimeSkills, {
      providerKind: openAiTarget.providerKind,
      providerInstanceId,
    })
    mcps = runtimeMcps.map((mcp) => ({
      name: mcp.name,
      command: mcp.command,
      args: mcp.args,
    }))
    subagents = runtimeSubagents.map((subagent) => ({
      name: subagent.name,
      description: subagent.description,
      prompt: subagent.prompt,
      mode: subagent.mode,
      model: subagent.model,
      source: subagent.source,
      sourcePath: subagent.sourcePath,
      tools: subagent.tools,
      permissions: subagent.permissions,
    }))
  } catch {
    // keep default prompt context
  }

  const resolvedRuleTargetPath = await resolveRendererRuleTargetPath(
    projectPath,
    ruleTargetPath
  )

  // The backend owns rule discovery and precedence. Keep the historical
  // renderer reader only as a compatibility fallback for an older or
  // temporarily unavailable backend.
  let effectiveRules: string | null = null
  let effectiveRulesLoaded = false
  let projectRulesFallback: string | null = null
  if (projectPath) {
    try {
      const { getEffectiveRules } =
        await import("@/services/backend/workspaceApi")
      const resolution = await getEffectiveRules(
        projectPath,
        resolvedRuleTargetPath
      )
      effectiveRules = resolution.content || null
      effectiveRulesLoaded = true
    } catch {
      try {
        projectRulesFallback =
          await projectRulesMod.getProjectRules(projectPath)
      } catch {
        projectRulesFallback = null
      }
    }
  }
  const projectPermissionRulesText =
    formatBetterC0deProjectPermissionRulesForPrompt(projectPermissionRules)
  const combinedProjectRules = [
    effectiveRules ?? projectRulesFallback,
    projectPermissionRulesText,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n")

  const systemInstruction = buildSystemInstruction(
    chatMode || "agent",
    specialMode,
    permissionLevel,
    envContext,
    skills,
    mcps,
    effectiveRulesLoaded ? "" : customRules,
    subagents,
    combinedProjectRules || null,
    appMode,
    resolvedDesignContext,
    designDefaults
  )
  const modelSelection = buildModelSelection({
    modelId,
    providerKind: openAiTarget.providerKind,
    providerInstanceId,
    reasoningEffort,
    fastMode,
    contextWindow,
    capabilities,
    optionSelections,
  })
  const providerMessage = buildProviderPrompt({
    message,
    providerKind: openAiTarget.providerKind,
    reasoningEffort,
    capabilities,
  })
  const dispatchThread = chatStoreMod.useChatStore
    .getState()
    .threads.find((thread) => thread.id === threadId)
  const autoCompactionUsage = automaticCompactionUsage(dispatchThread?.usage)
  const autoCompactionModelLimits =
    automaticCompactionModelLimits(contextWindow)
  const userMessageMetadata = {
    userMessageId: dispatchUserMessage.id,
    userMessageContent: dispatchUserMessage.content,
    userMessageCreatedAt: dispatchUserMessage.createdAt,
    ...(dispatchThread?.title ? { threadTitle: dispatchThread.title } : {}),
    ...(dispatchThread?.projectName
      ? { threadProjectName: dispatchThread.projectName }
      : {}),
    ...(dispatchThread?.createdAt
      ? { threadCreatedAt: dispatchThread.createdAt }
      : {}),
  }

  if (parseGoalCommand(message)) {
    const { upsertThreadMeta } = await import("./coreApi")
    if (dispatchThread) await upsertThreadMeta(dispatchThread)
    const goalRevision = chatStoreMod.useChatStore
      .getState()
      .getThreadSettings(threadId).goalRevision
    const result = await invokeContract("chatGoal", {
      body: {
        threadId,
        message,
        modelId,
        modelSelection,
        providerKind: openAiTarget.providerKind,
        providerInstanceId,
        reasoningEffort,
        chatMode,
        projectPath,
        systemInstruction,
        permissionLevel,
        openaiTransport: openAiTarget.openaiTransport,
        fastMode,
        collaborationMode: specialMode ?? null,
        appMode,
        designContext: resolvedDesignContext,
        ruleTargetPath: resolvedRuleTargetPath,
        ...userMessageMetadata,
      },
    })
    if (
      chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
        .goalRevision === goalRevision
    ) {
      chatStoreMod.useChatStore
        .getState()
        .setThreadSetting(threadId, "goal", result.goal)
    }
    if (!result.goal && parseGoalCommand(message)?.action === "status") {
      const { toast } = await import("sonner")
      toast.info("No goal in this chat. Use /goal followed by your objective.")
    }
    return
  }

  if (window.electronAPI?.pluginSend) {
    try {
      const { usePluginStore } = await import("@/lib/plugin-store")
      const plugins = usePluginStore
        .getState()
        .plugins.filter(
          (plugin) => plugin.enabled && plugin.manifest.type === "provider"
        )
      const providerKey = providerKind.trim().toLowerCase()
      const directPlugin = plugins.find(
        (plugin) =>
          plugin.manifest.id === providerKind ||
          plugin.manifest.id === providerKey
      )
      const builtinProviderKinds = new Set([
        "openai",
        "openai-api",
        "openai_api",
        "openai-oauth",
        "openai_oauth",
        "openai-cli",
        "openai_cli",
        "codexcli",
        "codex-cli",
        "anthropic",
        "claude",
        "anthropic_cli",
        "google",
        "grok",
        "grok_cli",
        "grok-cli",
        "grokcli",
        "openrouter",
        "lmstudio",
      ])
      const fallbackByModel = !builtinProviderKinds.has(providerKey)
        ? plugins.find((plugin) =>
            plugin.manifest.models.some((model) => model.id === modelId)
          )
        : undefined
      const plugin = directPlugin ?? fallbackByModel
      if (plugin) {
        const history = await buildThreadHistory(
          threadId,
          providerMessage,
          visibleUserContent,
          { maxMessages: 20, maxContentChars: 3000 }
        )

        await invokeContract("chatPersistUser", {
          args: {
            threadId,
            message: providerMessage,
            modelId,
            providerKind: openAiTarget.providerKind,
            projectPath,
            attachments,
            ...userMessageMetadata,
          },
          method: "POST",
          body: {
            threadId,
            message: providerMessage,
            modelId,
            providerKind: openAiTarget.providerKind,
            projectPath,
            attachments,
            ...userMessageMetadata,
          },
        })

        await window.electronAPI.pluginSend(plugin.manifest.id, "sendMessage", {
          threadId,
          message: providerMessage,
          modelId,
          modelSelection,
          config: plugin.config,
          mode: chatMode || "agent",
          permissionLevel,
          systemInstruction,
          projectPath,
          ruleTargetPath: resolvedRuleTargetPath,
          appMode,
          designContext: resolvedDesignContext,
          thinkingMode: reasoningEffort,
          openaiTransport: openAiTarget.openaiTransport,
          sourceProposedPlan,
          history,
          attachments: attachments?.filter(
            (attachment) => attachment.type !== BROWSER_ELEMENT_ATTACHMENT_TYPE
          ),
        })
        return
      }
    } catch {
      // fall through to backend
    }
  }

  // "Claude API" (id: "anthropic") and "Claude CLI" (id: "claude") are both
  // native backend builtins now. Anthropic routes via claudeApi.ts (direct
  // REST), Claude CLI routes via runtime/claude/ClaudeAdapter.ts (Agent SDK
  // → local `claude` binary). Both fall through to the standard /chat/send
  // path below. The legacy CLI-bridge electronAPI.claudeSend fallback that
  // used to short-circuit the anthropic provider was removed in 4a33dfa;
  // the bundled "anthropic-claude" plugin was retired and replaced by the
  // claude builtin in this commit's series.

  // Focus modes are still separate from chat modes. Codex derives its native
  // plan/default collaboration object in the backend from `chatMode` so it can
  // send the same BetterC0de developer instructions every turn.
  const collaborationMode = specialMode ?? null

  const history = await buildThreadHistory(
    threadId,
    providerMessage,
    visibleUserContent
  )

  const result = await invokeContract("chatSend", {
    // Native handoff/compaction may need up to 180s before admitting the turn.
    timeoutMs: 210_000,
    args: {
      threadId,
      message: providerMessage,
      modelId,
      modelSelection,
      providerKind: openAiTarget.providerKind,
      reasoningEffort,
      chatMode,
      projectPath,
      ruleTargetPath: resolvedRuleTargetPath,
      systemInstruction,
      permissionLevel,
      openaiTransport: openAiTarget.openaiTransport,
      collaborationMode,
      fastMode,
      providerInstanceId,
      appMode,
      designContext: resolvedDesignContext,
      sourceProposedPlan,
      history,
      attachments,
      autoCompactionUsage,
      autoCompactionModelLimits,
      orchestration,
      ...userMessageMetadata,
    },
    method: "POST",
    body: {
      threadId,
      message: providerMessage,
      orchestration,
      modelId,
      modelSelection,
      providerKind: openAiTarget.providerKind,
      reasoningEffort,
      chatMode,
      projectPath,
      ruleTargetPath: resolvedRuleTargetPath,
      systemInstruction,
      permissionLevel,
      openaiTransport: openAiTarget.openaiTransport,
      collaborationMode,
      // Codex Fast Mode — priority compute (`serviceTier: "fast"`).
      // Boolean toggle on the BetterC0de model selection.
      fastMode,
      providerInstanceId,
      appMode,
      designContext: resolvedDesignContext,
      sourceProposedPlan,
      history,
      attachments,
      autoCompactionUsage,
      autoCompactionModelLimits,
      ...userMessageMetadata,
    },
  })
  projectContextCheckpoint(chatStoreMod, threadId, result.automaticCompaction)
  projectContextCheckpoint(chatStoreMod, threadId, result.providerHandoff)
  return result
}

/**
 * Build the conversation history to send alongside the current turn.
 *
 * The optimistic-UI pattern used by every caller (see `use-chat-submit`,
 * `use-autonomous-loop`, `multi-agent-store`, etc.) adds the new user
 * message to the thread BEFORE calling `sendChatMessage`. The provider
 * prompt can then be transformed (for example Claude "Ultrathink:" prefix
 * or hidden plan implementation prompts), so we strip either the provider
 * prompt or the visible optimistic text. Sending both would make the latest
 * user turn appear twice to the provider.
 *
 * Cap: keep the newest complete suffix of up to 80 messages with a per-message
 * 10k-char ceiling and a 512 KiB serialized UTF-8 ceiling. Anthropic prompt
 * caching in the backend (see
 * `claudeApi.ts`) reuses this prefix across turns so a full 80-message
 * window is cheap after the first call; the cap exists to bound the
 * worst case (brand-new cache, pasted 500k-char file or large tool payload)
 * and leave room below Node/Electron's default 1 MB request body parse limit.
 */
export function stripOptimisticUserEcho<
  T extends { role: string; content: string },
>(
  messages: T[],
  currentMessage: string,
  optimisticMessageContent?: string | null
): T[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return messages
  const echoContents = new Set(
    [currentMessage, optimisticMessageContent]
      .filter((value): value is string => typeof value === "string")
      .filter((value) => value.length > 0)
  )
  return echoContents.has(last.content) ? messages.slice(0, -1) : messages
}

type WireHistoryMessage = {
  role: string
  content: string
  tool_calls?: Array<{ id: string; name: string; input: unknown }>
  tool_call_id?: string
}

type HistorySourceMessage = {
  role: string
  content: string
  attachments?: ChatAttachment[]
  compactedContext?: boolean
  toolCalls?: ReadonlyArray<{
    id: string
    name: string
    input: unknown
    output?: unknown
    outputPreview?: string
    error?: string
    startedAt?: string
  }>
}

type ThreadHistoryOptions = {
  maxMessages?: number
  maxContentChars?: number
  maxBytes?: number
}

const DEFAULT_HISTORY_MAX_BYTES = 512 * 1024
const utf8Encoder = new TextEncoder()

/** The text fed back to the model for a tool result — prefer the raw output,
 *  fall back to the stored preview / a JSON stringification / the error. */
function toolResultText(tc: {
  output?: unknown
  outputPreview?: string
  error?: string
}): string {
  if (typeof tc.output === "string") return tc.output
  if (typeof tc.outputPreview === "string") return tc.outputPreview
  if (tc.output != null) {
    try {
      return JSON.stringify(tc.output)
    } catch {
      return String(tc.output)
    }
  }
  return tc.error ?? ""
}

async function buildThreadHistory(
  threadId: string,
  currentMessage: string,
  optimisticMessageContent?: string | null,
  options?: ThreadHistoryOptions
): Promise<WireHistoryMessage[]> {
  const { useChatStore } = await import("@/lib/chat-store")
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId)

  const all = thread?.messages ?? []
  if (all.length === 0) return []

  return buildWireHistory(
    all,
    currentMessage,
    optimisticMessageContent,
    options
  )
}

export function buildWireHistory(
  messages: ReadonlyArray<HistorySourceMessage>,
  currentMessage: string,
  optimisticMessageContent?: string | null,
  options?: ThreadHistoryOptions
): WireHistoryMessage[] {
  const maxMessages = Math.max(0, Math.floor(options?.maxMessages ?? 80))
  const maxContentChars = Math.max(
    0,
    Math.floor(options?.maxContentChars ?? 10_000)
  )
  const maxBytes = Math.max(
    2,
    Math.floor(options?.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES)
  )

  const slice = stripOptimisticUserEcho(
    activeContextMessages(messages).messages,
    currentMessage,
    optimisticMessageContent
  )

  const clip = (text: string): string =>
    text.length > maxContentChars
      ? `${text.slice(0, maxContentChars)}\n\n[…truncated for transport…]`
      : text

  const groups: WireHistoryMessage[][] = []
  const recentMessages = maxMessages === 0 ? [] : slice.slice(-maxMessages)
  for (const m of recentMessages) {
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.length > 0) {
        groups.push([
          {
            role: "user",
            content: clip(withBrowserElementContext(m.content, m.attachments)),
          },
        ])
      }
      continue
    }
    if (m.role !== "assistant") continue

    const toolCalls = m.toolCalls ?? []
    if (toolCalls.length === 0) {
      if (typeof m.content === "string" && m.content.length > 0) {
        groups.push([{ role: "assistant", content: clip(m.content) }])
      }
      continue
    }

    // Assistant turn that called tools: emit the assistant message carrying the
    // tool_calls, then one tool-result message per call (ordered as issued) so
    // the in-house agent loop can replay the exact tool I/O. Tool-only turns
    // (empty content) are kept — they were previously dropped by the length
    // filter, which broke cross-turn tool continuity.
    const ordered = [...toolCalls].sort((a, b) =>
      (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
    )
    const group: WireHistoryMessage[] = [
      {
        role: "assistant",
        content: clip(m.content ?? ""),
        tool_calls: ordered.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: serializableToolInput(tc.input, maxContentChars),
        })),
      },
    ]
    for (const tc of ordered) {
      group.push({
        role: "tool",
        tool_call_id: tc.id,
        content: clip(toolResultText(tc)),
      })
    }
    groups.push(group)
  }

  return newestGroupsWithinByteBudget(groups, maxBytes)
}

function serializableToolInput(
  input: unknown,
  maxContentChars: number
): unknown {
  try {
    const serialized = JSON.stringify(input)
    if (serialized === undefined) return null
    return serialized.length > maxContentChars
      ? `${serialized.slice(0, maxContentChars)}\n\n[…truncated tool input for transport…]`
      : JSON.parse(serialized)
  } catch {
    try {
      const fallback = String(input)
      return fallback.length > maxContentChars
        ? `${fallback.slice(0, maxContentChars)}\n\n[…truncated tool input for transport…]`
        : fallback
    } catch {
      return "[unserializable tool input]"
    }
  }
}

function newestGroupsWithinByteBudget(
  groups: ReadonlyArray<ReadonlyArray<WireHistoryMessage>>,
  maxBytes: number
): WireHistoryMessage[] {
  const selected: WireHistoryMessage[][] = []
  let selectedMessages = 0
  let serializedBytes = 2 // JSON array brackets

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (!group || group.length === 0) continue
    const groupBytes = group.reduce(
      (total, message, messageIndex) =>
        total +
        (messageIndex > 0 ? 1 : 0) +
        utf8Encoder.encode(JSON.stringify(message)).byteLength,
      0
    )
    const separatorBytes = selectedMessages > 0 ? 1 : 0
    if (serializedBytes + separatorBytes + groupBytes > maxBytes) break

    selected.unshift([...group])
    selectedMessages += group.length
    serializedBytes += separatorBytes + groupBytes
  }

  return selected.flat()
}

export const interruptTurn = async (
  threadId: string,
  providerKind: string,
  providerInstanceId?: string | null
) => {
  // All stop entry points (composer, shortcuts and slash commands) pause
  // follow-ups before their stream can settle and trigger the next send.
  try {
    useMessageQueueStore.getState().pause(threadId)
  } catch {
    /* Already paused in memory. */
  }
  if (window.electronAPI?.pluginSend) {
    try {
      const { usePluginStore } = await import("@/lib/plugin-store")
      const plugin = usePluginStore
        .getState()
        .plugins.find(
          (item) => item.enabled && item.manifest.id === providerKind
        )
      if (plugin) {
        await window.electronAPI.pluginSend(plugin.manifest.id, "interrupt", {
          threadId,
        })
        return
      }
    } catch {
      // fall through to backend
    }
  }

  // "Claude (Anthropic)" interrupts go through the standard backend route,
  // matching its send path. The Electron claudeInterrupt IPC was the
  // companion to the removed claudeSend short-circuit above.

  return invokeContract("chatInterrupt", {
    args: { threadId, providerKind, providerInstanceId },
    method: "POST",
    body: { threadId, providerKind, providerInstanceId },
  })
}

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
) =>
  invoke<{ rotated: boolean; generation: number | null; messageId: string }>(
    "/chat/session/rotate",
    {
      args: {
        threadId,
        checkpointMessageId: checkpoint.messageId,
        checkpointContent: checkpoint.content,
        checkpointCreatedAt: checkpoint.createdAt,
        commandMessageId: checkpoint.commandMessageId,
        commandContent: checkpoint.commandContent,
        commandCreatedAt: checkpoint.commandCreatedAt,
        autoCompactionPrecondition:
          checkpoint.autoCompactionPrecondition ?? null,
      },
      method: "POST",
      body: {
        threadId,
        checkpointMessageId: checkpoint.messageId,
        checkpointContent: checkpoint.content,
        checkpointCreatedAt: checkpoint.createdAt,
        commandMessageId: checkpoint.commandMessageId,
        commandContent: checkpoint.commandContent,
        commandCreatedAt: checkpoint.commandCreatedAt,
        autoCompactionPrecondition:
          checkpoint.autoCompactionPrecondition ?? null,
      },
    }
  )

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
}) =>
  invoke<ChatAutoCompactionDecisionResult>("/chat/compaction/decision", {
    args: input,
    method: "POST",
    body: input,
  })

export const generateTitle = (userMessage: string) =>
  invoke<string>("/chat/title", {
    args: { userMessage },
    method: "POST",
    body: { userMessage },
  })

export const extractQuestions = (assistantText: string) =>
  invoke<{ text: string; options: string[] }[]>("/chat/questions", {
    args: { assistantText },
    method: "POST",
    body: { assistantText },
  })

export const generateCommitMessage = (input: {
  cwd?: string | null
  branch?: string | null
  stagedSummary: string
  stagedPatch: string
  includeBranch?: boolean
  modelSelection?: ModelSelection | null
}) =>
  invoke<{ subject: string; body: string; branch?: string }>(
    "/chat/text-generation/commit-message",
    {
      // Native generation allows 180s, followed by two 30s helper attempts.
      timeoutMs: 250_000,
      args: input,
      method: "POST",
      body: input,
    }
  )

export const generatePrContent = (input: {
  cwd?: string | null
  baseBranch: string
  headBranch: string
  commitSummary: string
  diffSummary: string
  diffPatch: string
  modelSelection?: ModelSelection | null
}) =>
  invoke<{ title: string; body: string }>("/chat/text-generation/pr-content", {
    args: input,
    method: "POST",
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
}) =>
  invoke<{ branch: string }>("/chat/text-generation/branch-name", {
    args: input,
    method: "POST",
    body: input,
  })

export const generateThreadContextSummary = (input: {
  cwd?: string | null
  threadTitle?: string | null
  projectPath?: string | null
  transcript: string
  modelSelection?: ModelSelection | null
}) =>
  invoke<{ summary: string }>("/chat/text-generation/thread-context-summary", {
    args: input,
    method: "POST",
    body: input,
  })

export const generateSkillContent = (input: {
  name: string
  requirements: string
  cwd?: string | null
  modelSelection?: ModelSelection | null
}) =>
  invoke<{ content: string }>("/chat/text-generation/skill-content", {
    args: input,
    method: "POST",
    body: input,
  })

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

export interface ClaudePermissionRuleEntry {
  source: "userSettings" | "projectSettings" | "localSettings"
  behavior: "allow" | "deny" | "ask"
  rule: string
  filePath: string
}

export const listClaudePermissionRules = (cwd?: string | null) =>
  invoke<{ rules: ClaudePermissionRuleEntry[] }>(
    "/permissions/claude-rules/list",
    { args: { cwd }, method: "POST", body: { cwd } }
  )

export const deleteClaudePermissionRule = (input: {
  source: "userSettings" | "projectSettings" | "localSettings"
  behavior: "allow" | "deny" | "ask"
  rule: string
  cwd?: string | null
}) =>
  invoke<{ status: "acknowledged" | "failed"; error?: string }>(
    "/permissions/claude-rules/delete",
    { args: input, method: "POST", body: input }
  )

export interface SessionPermissionRuleEntry {
  threadId: string
  behavior: "allow" | "deny"
  toolName: string
  ruleContent?: string
}

export const listSessionPermissionRules = (threadId?: string | null) =>
  invoke<{ rules: SessionPermissionRuleEntry[] }>(
    "/permissions/session-rules/list",
    { args: { threadId }, method: "POST", body: { threadId } }
  )

export const deleteSessionPermissionRule = (input: {
  threadId: string
  behavior: "allow" | "deny"
  rule: string
}) =>
  invoke<{ status: "acknowledged" | "failed"; error?: string }>(
    "/permissions/session-rules/delete",
    { args: input, method: "POST", body: input }
  )

export const listAgentPermissionGrants = (input: {
  workspacePath?: string | null
  destination?: AgentPermissionDestination
  includeUser?: boolean
}) =>
  invoke<{ grants: AgentPermissionGrant[] }>("/permissions/grants/list", {
    args: input,
    method: "POST",
    body: input,
  })

export const upsertAgentPermissionGrant = (input: {
  destination: AgentPermissionDestination
  workspacePath?: string | null
  toolName: string
  pathScope?: string
  behavior: AgentPermissionBehavior
}) =>
  invoke<{ grant: AgentPermissionGrant }>("/permissions/grants/upsert", {
    args: input,
    method: "POST",
    body: input,
  })

export const deleteAgentPermissionGrant = (id: string) =>
  invoke<{ status: "acknowledged" | "failed"; error?: string }>(
    "/permissions/grants/delete",
    {
      args: { id },
      method: "POST",
      body: { id },
    }
  )

export const getAgentWorkspaceTrust = (workspacePath: string) =>
  invoke<{ trust: WorkspaceTrustRecord }>("/permissions/workspace-trust/get", {
    args: { workspacePath },
    method: "POST",
    body: { workspacePath },
  })

export const setAgentWorkspaceTrust = (
  workspacePath: string,
  state: WorkspaceTrustState
) =>
  invoke<{ trust: WorkspaceTrustRecord }>("/permissions/workspace-trust/set", {
    args: { workspacePath, state },
    method: "POST",
    body: { workspacePath, state },
  })

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
) =>
  invoke<ThreadActivity>(
    `/threads/${encodeURIComponent(threadId)}/activities/model-switch`,
    {
      args: { threadId, ...input },
      method: "POST",
      body: input,
    }
  )
