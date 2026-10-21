import { isReservedBuiltinSlashCommandName } from "@/lib/slash-command-catalog"
import { type EditorSelectionContext } from "@/lib/editor-store"
import type { UiProvider } from "@/lib/provider-types"
import {
  listRuntimeSkills,
  listRuntimeSubagents,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import {
  listProjectAgents,
  listProjectCommands,
  listProjectSkills,
  runShellCommandDetailed,
  type WorkspaceProjectAgent,
  type WorkspaceProjectCommand,
  type WorkspaceProjectReference,
  type WorkspaceProjectSkill,
} from "@/services/backend/workspaceApi"
import { type ChatAttachment } from "@betterc0de/schema"

export function isProviderNativeSlashCommand(
  text: string,
  selectedProvider: Pick<UiProvider, "slashCommands"> | undefined
): boolean {
  const command = text.trim().split(/\s+/)[0]?.replace(/^\/+/, "").toLowerCase()
  if (!command) return false
  if (isReservedBuiltinSlashCommandName(command)) return false
  return (selectedProvider?.slashCommands ?? []).some((entry) => {
    const name = entry.name.trim().replace(/^\/+/, "").toLowerCase()
    return name.length > 0 && name === command
  })
}

/** A typed skill alias uses the same native token as a picker selection. */
export function providerSkillSlashPrompt(
  text: string,
  selectedProvider: Pick<UiProvider, "skills" | "slashCommands"> | undefined
): string | null {
  const match = /^\s*\/([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/.exec(text)
  if (!match) return null
  const name = match[1].toLowerCase()
  if (
    isReservedBuiltinSlashCommandName(name) ||
    isProviderNativeSlashCommand(text, selectedProvider)
  )
    return null
  const skill = selectedProvider?.skills?.find(
    (entry) =>
      entry.enabled &&
      entry.name.trim().replace(/^\$+/, "").toLowerCase() === name
  )
  if (!skill) return null
  return `$${skill.name.trim().replace(/^\$+/, "")}${text.slice(match[0].length)}`
}

const BETTERC0DE_MENTION_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

export function extractBetterC0deMentions(text: string): string[] {
  return Array.from(text.matchAll(BETTERC0DE_MENTION_REGEX))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
}

export function normalizeChatAttachments(files: unknown[]): ChatAttachment[] {
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return []
    const record = file as Record<string, unknown>
    const url = typeof record.url === "string" ? record.url : ""
    if (!url) return []
    const filename =
      typeof record.filename === "string"
        ? record.filename
        : typeof record.name === "string"
          ? record.name
          : null
    const mediaType =
      typeof record.mediaType === "string"
        ? record.mediaType
        : typeof record.mimeType === "string"
          ? record.mimeType
          : null
    return [
      {
        filename,
        mediaType,
        type: typeof record.type === "string" ? record.type : "file",
        url,
      },
    ]
  })
}

type ProjectCommandPrompt = {
  command: WorkspaceProjectCommand
  prompt: string
  chatModeOverride?: string
}

type ProjectSkillCommandPrompt = {
  skill: RuntimeSkill
  prompt: string
  chatModeOverride?: string
}

const PROJECT_COMMAND_CHAT_MODE_AGENTS = new Set([
  "plan",
  "ask",
  "security",
  "debug",
])

export async function buildProjectCommandPrompt(
  text: string,
  runtimePath?: string | null,
  permissionLevel?: string | null
): Promise<ProjectCommandPrompt | null> {
  if (!runtimePath) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  const token = trimmed.split(/\s+/)[0] ?? ""
  const commandName = token.replace(/^\/+/, "").toLowerCase()
  if (!commandName) return null

  let commands: WorkspaceProjectCommand[] = []
  try {
    commands = await listProjectCommands(runtimePath)
  } catch {
    return null
  }
  const command = commands.find(
    (candidate) => candidate.name.toLowerCase() === commandName
  )
  if (!command) return null

  const argumentsText = trimmed.slice(token.length).trim()
  const hydratedTemplate = hydrateProjectCommandTemplate(
    command.template,
    argumentsText
  )
  const prompt = await hydrateProjectCommandShellBlocks(
    hydratedTemplate,
    runtimePath,
    permissionLevel
  )
  const chatModeOverride = projectCommandChatModeOverride(command)
  const commandAgent = command.agent
    ? await resolveProjectCommandAgent(command.agent, runtimePath)
    : null
  return {
    command,
    prompt: [
      `Run project command \`/${command.name}\`.`,
      "",
      `Source: \`${command.sourcePath}\``,
      command.description ? `Description: ${command.description}` : "",
      command.agent ? `Requested agent: \`${command.agent}\`` : "",
      command.model ? `Requested model: \`${command.model}\`` : "",
      typeof command.subtask === "boolean"
        ? `Subtask: ${command.subtask ? "enabled" : "disabled"}`
        : "",
      `Arguments: ${argumentsText || "(none)"}`,
      "",
      "---",
      "",
      commandAgent
        ? `${buildProjectCommandAgentInstructions(commandAgent)}\n\n---\n`
        : "",
      prompt,
    ]
      .filter(Boolean)
      .join("\n"),
    ...(chatModeOverride ? { chatModeOverride } : {}),
  }
}

export function buildProjectCommandAgentInstructions(
  agent: RuntimeSubagent
): string {
  const rows = [
    `ID: ${agent.id}`,
    agent.sourcePath ? `Source: ${agent.sourcePath}` : "",
    agent.mode ? `Mode: ${agent.mode}` : "",
    agent.model ? `Model: ${agent.model}` : "",
    agent.variant ? `Variant: ${agent.variant}` : "",
    agent.temperature !== undefined ? `Temperature: ${agent.temperature}` : "",
    agent.topP !== undefined ? `Top P: ${agent.topP}` : "",
    agent.steps !== undefined ? `Steps: ${agent.steps}` : "",
    agent.tools && Object.keys(agent.tools).length > 0
      ? `Tools: ${formatBooleanMap(agent.tools)}`
      : "",
    agent.permissions?.length
      ? `Permissions: ${formatPermissionRules(agent.permissions)}`
      : "",
    agent.optionKeys?.length
      ? `Options: ${formatListPlain(agent.optionKeys)}`
      : "",
  ].filter(Boolean)

  return [
    "Use the following BetterC0de-compatible command agent instructions.",
    "Treat the metadata as constraints for this command turn; do not use tools that the agent disables or permissions deny.",
    "",
    `[Subagent: ${agent.name || agent.id}]`,
    ...rows,
    "",
    "```",
    agent.prompt,
    "```",
  ].join("\n")
}

export async function resolveProjectCommandAgent(
  agentId: string,
  runtimePath: string,
  options: { includePrimaryBuild?: boolean } = {}
): Promise<RuntimeSubagent | null> {
  const normalized = agentId.trim().toLowerCase()
  if (!normalized) return null
  if (PROJECT_COMMAND_CHAT_MODE_AGENTS.has(normalized)) {
    return null
  }
  if (!options.includePrimaryBuild && normalized === "build") {
    return null
  }
  try {
    const [runtimeAgents, projectAgents] = await Promise.all([
      listRuntimeSubagents(),
      listProjectRuntimeSubagents(runtimePath),
    ])
    const agents = mergeRuntimeSubagents(runtimeAgents, projectAgents)
    return (
      agents.find(
        (agent) =>
          agent.enabled &&
          !agent.hidden &&
          (agent.id.toLowerCase() === normalized ||
            agent.name.toLowerCase() === normalized)
      ) ?? null
    )
  } catch {
    return null
  }
}

export async function buildProjectSkillCommandPrompt(
  text: string,
  runtimePath?: string | null
): Promise<ProjectSkillCommandPrompt | null> {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  const token = trimmed.split(/\s+/)[0] ?? ""
  const skillName = token.replace(/^\/+/, "").toLowerCase()
  if (!skillName || isReservedBuiltinSlashCommandName(skillName)) return null

  let skills: RuntimeSkill[] = []
  try {
    const runtimeSkills = await listRuntimeSkills()
    const projectSkills = runtimePath
      ? await listProjectRuntimeSkills(runtimePath)
      : []
    skills = mergeRuntimeSkills(runtimeSkills, projectSkills)
  } catch {
    return null
  }
  const skill = skills.find(
    (candidate) => candidate.id.toLowerCase() === skillName
  )
  if (!skill) return null

  const argumentsText = trimmed.slice(token.length).trim()
  return {
    skill,
    prompt: [
      `Run project skill \`/${skill.id}\`.`,
      "",
      `Source: \`${skill.sourcePath || skill.sourceUrl || "project"}\``,
      skill.description ? `Description: ${skill.description}` : "",
      `Arguments: ${argumentsText || "(none)"}`,
      "",
      "---",
      "",
      "Use the following BetterC0de-compatible project skill instructions for this request:",
      "",
      `[Skill: ${skill.name || skill.id}]`,
      "```",
      skill.content,
      "```",
      "",
      argumentsText
        ? ["User request / arguments:", argumentsText].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

export function projectCommandChatModeOverride(
  command: Pick<WorkspaceProjectCommand, "agent">
): string | undefined {
  const agent = command.agent?.trim().toLowerCase()
  return agent && PROJECT_COMMAND_CHAT_MODE_AGENTS.has(agent)
    ? agent
    : undefined
}

export function resolveProjectCommandModelOverride(
  model: string | null | undefined,
  selectedProvider: UiProvider | undefined,
  providers: ReadonlyArray<UiProvider>
): { provider: UiProvider; modelId: string } | null {
  const modelId = model?.trim()
  if (!modelId) return null

  if (
    selectedProvider &&
    providerCanRunProjectCommandModel(selectedProvider, modelId)
  ) {
    return { provider: selectedProvider, modelId }
  }

  const betterC0deProvider = providers.find((provider) =>
    isBetterC0deProvider(provider)
  )
  if (betterC0deProvider) return { provider: betterC0deProvider, modelId }

  const directProvider = providers.find((provider) =>
    provider.models.some((entry) => entry.id === modelId)
  )
  return directProvider ? { provider: directProvider, modelId } : null
}

function providerCanRunProjectCommandModel(
  provider: UiProvider,
  modelId: string
): boolean {
  if (isBetterC0deProvider(provider)) return true
  return provider.models.some((entry) => entry.id === modelId)
}

function isBetterC0deProvider(provider: UiProvider): boolean {
  return (
    provider.id === "betterc0de" ||
    provider.providerKind === "betterc0de" ||
    provider.providerInstanceId === "betterc0de" ||
    provider.id === "betterc0de" ||
    provider.providerKind === "betterc0de" ||
    provider.providerInstanceId === "betterc0de"
  )
}

export function hydrateProjectCommandTemplate(
  template: string,
  argumentsText: string
): string {
  const args = parseCommandArguments(argumentsText)
  const placeholders = Array.from(template.matchAll(/\$(\d+)/g))
  const lastPlaceholder = placeholders.reduce((last, match) => {
    const position = Number(match[1])
    return Number.isInteger(position) && position > last ? position : last
  }, 0)
  return template
    .replace(/\$(\d+)/g, (_match, indexText: string) => {
      const index = Number(indexText)
      if (!Number.isInteger(index) || index <= 0) return ""
      const argIndex = index - 1
      if (argIndex >= args.length) return ""
      return index === lastPlaceholder
        ? args.slice(argIndex).join(" ")
        : (args[argIndex] ?? "")
    })
    .replace(/\$ARGUMENTS\b/g, argumentsText)
    .trim()
}

type ProjectCommandShellRunner = (
  command: string,
  cwd: string,
  permissionLevel?: string | null
) => Promise<string>

const PROJECT_COMMAND_SHELL_BLOCK_REGEX = /!`([^`]+)`/g

export async function hydrateProjectCommandShellBlocks(
  template: string,
  runtimePath?: string | null,
  permissionLevel?: string | null,
  runner: ProjectCommandShellRunner = runProjectCommandShellBlock
): Promise<string> {
  if (!runtimePath) return template.trim()
  const matches = Array.from(
    template.matchAll(PROJECT_COMMAND_SHELL_BLOCK_REGEX)
  )
  if (matches.length === 0) return template.trim()

  const outputs = await Promise.all(
    matches.map(async (match) => {
      const command = (match[1] ?? "").trim()
      if (!command) return ""
      try {
        return await runner(command, runtimePath, permissionLevel)
      } catch (err) {
        return [
          `[Shell command not executed: ${errorMessage(err)}]`,
          "BetterC0de keeps compatibility command shell blocks behind the active permission level and project permission rules.",
        ].join("\n")
      }
    })
  )
  let index = 0
  return template
    .replace(PROJECT_COMMAND_SHELL_BLOCK_REGEX, () => outputs[index++] ?? "")
    .trim()
}

async function runProjectCommandShellBlock(
  command: string,
  cwd: string,
  permissionLevel?: string | null
): Promise<string> {
  const result = await runShellCommandDetailed(
    command,
    cwd,
    undefined,
    undefined,
    {
      humanOrigin: false,
      permissionLevel: permissionLevel ?? undefined,
    }
  )
  return result.combined.trimEnd()
}

function parseCommandArguments(input: string): string[] {
  const args: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    const quoted = match[1] ?? match[2]
    const raw = quoted ?? match[3] ?? ""
    args.push(raw.replace(/\\(["'\\])/g, "$1"))
  }
  return args
}

export function buildProjectReferenceMentionContext(
  references: ReadonlyArray<WorkspaceProjectReference>,
  mentionName: string
): string | null {
  const normalizedMention = mentionName.replace(/\\/g, "/")
  const slashIndex = normalizedMention.indexOf("/")
  const id =
    slashIndex >= 0 ? normalizedMention.slice(0, slashIndex) : normalizedMention
  if (!id) return null

  const reference = references.find((item) => item.id === id)
  if (!reference) return null

  const target =
    slashIndex >= 0 ? normalizedMention.slice(slashIndex + 1) : undefined
  const targetProblem =
    target && isUnsafeReferenceTarget(target)
      ? "Reference target must stay inside the configured reference root."
      : null
  const targetPath =
    target && !targetProblem && reference.path
      ? joinReferencePath(reference.path, target)
      : null
  const label = target ? `@${reference.id}/${target}` : `@${reference.id}`
  const isExternalLocalReference =
    reference.kind === "local" &&
    Boolean(reference.path) &&
    !reference.relativePath

  return [
    `[Reference: ${label}]`,
    `Kind: ${reference.kind}`,
    reference.repository ? `Repository: ${reference.repository}` : "",
    reference.branch ? `Branch/ref: ${reference.branch}` : "",
    reference.path ? `Reference root: ${reference.path}` : "",
    targetPath ? `Resolved path: ${targetPath}` : "",
    reference.sourcePath ? `Configured in: ${reference.sourcePath}` : "",
    targetProblem ? `Problem: ${targetProblem}` : "",
    reference.message ? `Problem: ${reference.message}` : "",
    !targetProblem && !reference.message
      ? isExternalLocalReference
        ? "This reference points outside the active workspace; inspect the absolute path only with tools that are allowed to access it."
        : "Use workspace read, glob, and grep tools to inspect the reference path before relying on it."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function isUnsafeReferenceTarget(target: string): boolean {
  if (!target.trim()) return false
  const normalized = target.replace(/\\/g, "/")
  return (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  )
}

function joinReferencePath(rootPath: string, target: string): string {
  const cleanRoot = rootPath.replace(/[/\\]+$/, "")
  const cleanTarget = target.replace(/^[/\\]+/, "")
  return `${cleanRoot}/${cleanTarget}`
}

export async function listProjectRuntimeSkills(
  runtimePath?: string | null
): Promise<RuntimeSkill[]> {
  if (!runtimePath) return []
  try {
    const projectSkills = await listProjectSkills(runtimePath)
    return projectSkills.map(projectSkillToRuntimeSkill)
  } catch {
    return []
  }
}

function projectSkillToRuntimeSkill(
  skill: WorkspaceProjectSkill
): RuntimeSkill {
  return {
    id: skill.id,
    name: skill.name || skill.id,
    version: "project",
    public: false,
    enabled: true,
    description: skill.description,
    content: skill.content,
    source: "betterc0de",
    sourcePath: skill.sourcePath,
    sourceUrl: skill.sourceUrl,
  }
}

export function mergeRuntimeSkills(
  primary: ReadonlyArray<RuntimeSkill>,
  additions: ReadonlyArray<RuntimeSkill>
): RuntimeSkill[] {
  if (additions.length === 0) return [...primary]
  const mergedById = new Map(primary.map((skill) => [skill.id, skill]))
  for (const skill of additions) {
    mergedById.set(skill.id, skill)
  }
  return Array.from(mergedById.values())
}

export async function listProjectRuntimeSubagents(
  runtimePath?: string | null
): Promise<RuntimeSubagent[]> {
  if (!runtimePath) return []
  try {
    const projectAgents = await listProjectAgents(runtimePath)
    return projectAgents.map(projectAgentToRuntimeSubagent)
  } catch {
    return []
  }
}

function projectAgentToRuntimeSubagent(
  agent: WorkspaceProjectAgent
): RuntimeSubagent {
  return {
    id: agent.id,
    name: agent.name || agent.id,
    description:
      agent.description ||
      [
        agent.mode
          ? `BetterC0de ${agent.mode}`
          : "BetterC0de compatibility project agent",
        agent.model ? `model ${agent.model}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    prompt: agent.prompt,
    enabled: agent.enabled !== false,
    hidden: agent.hidden,
    mode: agent.mode,
    model: agent.model,
    variant: agent.variant,
    temperature: agent.temperature,
    topP: agent.topP,
    color: agent.color,
    steps: agent.steps,
    tools: agent.tools,
    optionKeys: agent.optionKeys,
    permissions: agent.permissions,
    source: "betterc0de",
    sourcePath: agent.sourcePath,
  }
}

export function mergeRuntimeSubagents(
  primary: ReadonlyArray<RuntimeSubagent>,
  additions: ReadonlyArray<RuntimeSubagent>
): RuntimeSubagent[] {
  if (additions.length === 0) return [...primary]
  const seen = new Set(primary.map((agent) => agent.id))
  const merged = [...primary]
  for (const agent of additions) {
    if (seen.has(agent.id)) continue
    seen.add(agent.id)
    merged.push(agent)
  }
  return merged
}

export interface EditorSelectionContextDraftInput {
  currentDraft: string
  relativePath: string
  language: string
  selection: EditorSelectionContext
}

export function buildEditorSelectionContextDraft(
  input: EditorSelectionContextDraftInput
): string {
  const lineLabel =
    input.selection.startLine === input.selection.endLine
      ? `L${input.selection.startLine}`
      : `L${input.selection.startLine}-L${input.selection.endLine}`
  const fence = markdownFenceForText(input.selection.text)
  const language = markdownFenceLanguage(input.language)
  const context = [
    `[Selected file context: ${input.relativePath}:${lineLabel}]`,
    `${fence}${language}`,
    input.selection.text,
    fence,
  ].join("\n")
  const current = input.currentDraft.trimEnd()
  return current.trim().length > 0 ? `${current}\n\n${context}` : context
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "Unknown error")
}

export function markdownFenceForText(value: string): string {
  const longest = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
  )
  return "`".repeat(longest + 1)
}

export function markdownFenceLanguage(value: string): string {
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9_+-]+$/u.test(normalized) ? normalized : "text"
}

export function formatListPlain(values: ReadonlyArray<string>): string {
  return values.length > 0 ? values.join(", ") : "-"
}

export function formatBooleanMap(values: Record<string, boolean>): string {
  const entries = Object.entries(values)
  return entries.length > 0
    ? entries
        .map(([key, enabled]) => `${key}: ${enabled ? "enabled" : "disabled"}`)
        .join(", ")
    : "-"
}

export function formatPermissionRules(
  rules: NonNullable<RuntimeSubagent["permissions"]>
): string {
  return rules.length > 0
    ? rules
        .map((rule) => `${rule.permission}:${rule.pattern}=${rule.action}`)
        .join(", ")
    : "-"
}
