/**
 * What goes into a turn's system instruction besides the fixed text
 * (system-instruction.ts): the skills, MCP servers and subagents the user
 * configured, and the project's own. The desktop gathers them before each
 * turn it sends; its backend gathers the same for turns from the phone app.
 * Both select and merge them with these functions.
 */

export type PromptSkill = { name: string; content: string }

export type RuntimePromptSkill = PromptSkill & {
  providerKinds?: string[]
  providerInstanceIds?: string[]
  source?: string
  sourcePath?: string
}

export type PromptMcp = { name: string; command: string; args?: string[] }

/** A project-local tool permission rule (`/workspace/project-permissions`). */
export interface PromptPermissionRule {
  permission: string
  pattern: string
  action: "ask" | "allow" | "deny"
  sourcePath: string
}

export type PromptSubagent = {
  name: string
  description?: string
  prompt?: string
  mode?: string
  model?: string
  source?: string
  sourcePath?: string
  tools?: Record<string, boolean>
  permissions?: PromptPermissionRule[]
}

/**
 * A project agent as `/workspace/project-agents` lists it. The fields the
 * prompt does not use are optional here.
 */
export interface PromptProjectAgent {
  id: string
  name: string
  description?: string
  enabled: boolean
  hidden?: boolean
  mode?: string
  model?: string
  variant?: string
  temperature?: number
  topP?: number
  color?: string
  steps?: number
  tools: Record<string, boolean>
  optionKeys?: string[]
  permissions: PromptPermissionRule[]
  sourcePath: string
  prompt: string
}

export type RuntimePromptContext = {
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

/** A provider kind folded onto the name its skills and options are keyed by. */
export function canonicalProviderKind(
  value: string | null | undefined
): string {
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
  rules: readonly PromptPermissionRule[]
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

export function mergePromptSkills(
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

export function mergePromptMcps(
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
  agents: ReadonlyArray<PromptProjectAgent>
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
