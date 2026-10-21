import {
  evaluateProjectPermissionRules,
  type ProjectPermissionAction,
  type ProjectPermissionRule,
} from "./project-permission-rules"
import {
  currentAgentPermissionRuntimeContext,
  evaluateConfiguredAgentToolPermission,
  publishAgentPermissionEvent,
} from "./agent-permission-runtime"

export interface ProjectToolFlag {
  readonly tool: string
  readonly enabled: boolean
  readonly kind?: "flag" | "custom"
}

export interface ProjectToolPermissionEvaluation {
  readonly permission: string
  readonly pattern: string
  readonly action: ProjectPermissionAction
  readonly rule: ProjectPermissionRule
}

export function filterToolsForBetterC0deProjectPolicy(
  tools: readonly string[],
  input: {
    readonly toolFlags?: readonly ProjectToolFlag[]
    readonly permissionRules?: readonly ProjectPermissionRule[]
  }
): string[] {
  const disabledToolKeys = disabledToolFlagKeys(input.toolFlags ?? [])
  const filteredByToolFlags = tools.filter(
    (toolName) =>
      !toolPolicyKeysForTool(toolName).some((key) => disabledToolKeys.has(key))
  )
  const disabledPermissionKeys = disabledPermissionRuleKeys(
    input.permissionRules ?? []
  )
  return filteredByToolFlags.filter(
    (toolName) =>
      !toolPolicyKeysForTool(toolName).some((key) =>
        disabledPermissionKeys.has(key)
      )
  )
}

export function evaluateBetterC0deProjectToolPermission(
  rules: readonly ProjectPermissionRule[],
  input: {
    readonly toolName: string
    readonly toolInput: unknown
  }
): ProjectToolPermissionEvaluation | null {
  const permission = projectPermissionForTool(input.toolName)
  const pattern = projectPermissionPattern(input.toolName, input.toolInput)
  const rule = evaluateProjectPermissionRules(rules, { permission, pattern })
  const projectEvaluation = rule
    ? { permission, pattern, action: rule.action, rule }
    : null
  const durable = evaluateConfiguredAgentToolPermission({
    toolName: input.toolName,
    toolInput: input.toolInput,
  })
  if (!durable || durable.source === "default") return projectEvaluation

  const durableRule: ProjectPermissionRule = {
    permission,
    pattern: durable.normalizedPath ?? pattern,
    action: durable.decision,
  }
  const durableEvaluation: ProjectToolPermissionEvaluation = {
    permission,
    pattern: durableRule.pattern,
    action: durableRule.action,
    rule: durableRule,
  }

  const selected =
    !projectEvaluation ||
    permissionActionRank(durableEvaluation.action) >=
      permissionActionRank(projectEvaluation.action)
      ? durableEvaluation
      : projectEvaluation
  if (selected === durableEvaluation && durable.decision === "deny") {
    const context = currentAgentPermissionRuntimeContext()
    if (context) {
      publishAgentPermissionEvent({
        event_type: "tool.denied",
        thread_id: context.threadId,
        payload: {
          providerKind: "anthropic_cli",
          toolName: input.toolName,
          reason: durable.reason,
        },
      })
    }
  }
  return selected
}

function permissionActionRank(action: ProjectPermissionAction): number {
  return { allow: 1, ask: 2, deny: 3 }[action]
}

export function projectPermissionForTool(toolName: string): string {
  const normalized = normalizePolicyKey(toolName)
  if (["bash", "shell", "terminal", "exec", "command"].includes(normalized)) {
    return "bash"
  }
  if (
    [
      "edit",
      "write",
      "patch",
      "multiedit",
      "applypatch",
      "notebookedit",
    ].includes(normalized)
  ) {
    return "edit"
  }
  if (["read"].includes(normalized)) return "read"
  if (["glob"].includes(normalized)) return "glob"
  if (["grep"].includes(normalized)) return "grep"
  if (["list", "ls"].includes(normalized)) return "list"
  if (["webfetch", "fetch"].includes(normalized)) return "webfetch"
  if (["websearch", "search"].includes(normalized)) return "websearch"
  if (["agent", "task"].includes(normalized)) return "task"
  if (["todowrite", "todo"].includes(normalized)) {
    return "todowrite"
  }
  if (["askuserquestion", "question"].includes(normalized)) {
    return "question"
  }
  if (["exitplanmode", "planexit"].includes(normalized)) {
    return "plan_exit"
  }
  if (["externaldirectory", "externaldir"].includes(normalized)) {
    return "external_directory"
  }
  if (["repoclone"].includes(normalized)) return "repo_clone"
  if (["repooverview"].includes(normalized)) return "repo_overview"
  if (["taskstatus"].includes(normalized)) return "task_status"
  if (["doomloop"].includes(normalized)) return "doom_loop"
  return normalized
}

export function projectPermissionPattern(
  toolName: string,
  toolInput: unknown
): string {
  const permission = projectPermissionForTool(toolName)
  const record = asRecord(toolInput)
  if (!record) return "*"

  if (permission === "bash") {
    return stringField(record, ["command", "cmd", "script", "input"]) ?? "*"
  }
  if (permission === "edit") {
    return (
      stringField(record, [
        "file_path",
        "filePath",
        "path",
        "notebook_path",
        "notebookPath",
        "filename",
      ]) ?? "*"
    )
  }
  if (permission === "read" || permission === "list") {
    return stringField(record, ["file_path", "filePath", "path"]) ?? "*"
  }
  if (permission === "glob") {
    return stringField(record, ["pattern", "path"]) ?? "*"
  }
  if (permission === "grep") {
    return stringField(record, ["pattern", "query", "path"]) ?? "*"
  }
  if (permission === "webfetch" || permission === "websearch") {
    return stringField(record, ["url", "query"]) ?? "*"
  }
  if (permission === "repo_clone") {
    return stringField(record, ["repository", "repo", "remote", "url"]) ?? "*"
  }
  if (permission === "repo_overview") {
    return (
      stringField(record, ["repository", "repo", "path", "directory"]) ?? "*"
    )
  }
  if (permission === "external_directory") {
    return (
      stringField(record, ["filepath", "parentDir", "path", "directory"]) ?? "*"
    )
  }
  if (permission === "task_status") {
    return stringField(record, ["task_id", "taskId", "id"]) ?? "*"
  }
  return "*"
}

function disabledToolFlagKeys(
  toolFlags: readonly ProjectToolFlag[]
): Set<string> {
  const keys = new Set<string>()
  for (const flag of toolFlags) {
    if (flag.kind === "custom") continue
    if (flag.enabled) continue
    for (const key of toolPolicyAliases(flag.tool)) keys.add(key)
  }
  return keys
}

function disabledPermissionRuleKeys(
  permissionRules: readonly ProjectPermissionRule[]
): Set<string> {
  const keys = new Set<string>()
  for (const rule of permissionRules) {
    if (rule.action !== "deny" || rule.pattern !== "*") continue
    for (const key of toolPolicyAliases(rule.permission)) keys.add(key)
  }
  return keys
}

function toolPolicyKeysForTool(toolName: string): string[] {
  return toolPolicyAliases(projectPermissionForTool(toolName))
}

function toolPolicyAliases(raw: string): string[] {
  const canonical = projectPermissionForTool(raw)
  const normalized = normalizePolicyKey(canonical)
  const aliases = new Set<string>([canonical, normalized])
  if (canonical === "edit") {
    aliases.add("write")
    aliases.add("patch")
    aliases.add("multiedit")
    aliases.add("applypatch")
    aliases.add("notebookedit")
  }
  if (canonical === "bash") {
    aliases.add("shell")
    aliases.add("terminal")
    aliases.add("exec")
  }
  if (canonical === "webfetch") {
    aliases.add("web-fetch")
    aliases.add("fetch")
  }
  if (canonical === "websearch") {
    aliases.add("web-search")
    aliases.add("search")
  }
  if (canonical === "task") aliases.add("agent")
  if (canonical === "question") aliases.add("askuserquestion")
  if (canonical === "repo_clone") aliases.add("repoclone")
  if (canonical === "repo_overview") aliases.add("repooverview")
  if (canonical === "external_directory") aliases.add("externaldirectory")
  if (canonical === "task_status") aliases.add("taskstatus")
  if (canonical === "doom_loop") aliases.add("doomloop")
  if (canonical === "plan_exit") {
    aliases.add("plan-exit")
    aliases.add("plan.exit")
    aliases.add("exitplanmode")
    aliases.add("planexit")
  }
  return [...aliases]
}

function normalizePolicyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}
