import { AsyncLocalStorage } from "node:async_hooks"
import type { AgentPermissionGrant } from "@betterc0de/schema"
import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyDecision,
} from "./agent-permission-policy"
import { evaluateSessionRules } from "./session-permission-rules"
import { normalizeLevel } from "./permissions"

export interface AgentPermissionRuntimeContext {
  readonly threadId: string
  readonly workspacePath?: string | null
  readonly appMode?: string | null
  readonly chatMode?: string | null
  readonly permissionLevel?: string | null
}

interface BoundAgentPermissionRuntimeContext {
  readonly token: symbol
  readonly context: AgentPermissionRuntimeContext
}

export interface ConfiguredAgentToolPermissionInput {
  readonly threadId?: string | null
  readonly toolName: string
  readonly toolInput?: unknown
  readonly path?: string | null
}

const contextStorage = new AsyncLocalStorage<AgentPermissionRuntimeContext>()
const contextsByThread = new Map<string, BoundAgentPermissionRuntimeContext>()
export type AgentPermissionRuntimePolicy = Pick<
  AgentPermissionPolicy,
  "evaluateTool" | "listGrants"
> &
  Partial<Pick<AgentPermissionPolicy, "getWorkspaceTrust">>
let configuredPolicy: AgentPermissionRuntimePolicy | null = null

const CLAUDE_TRUSTED_SETTING_SOURCES = ["user", "project", "local"] as const
const CLAUDE_USER_SETTING_SOURCES = ["user"] as const

/**
 * Claude loads repository hooks from project and local settings. An explicit
 * untrusted workspace, or a turn with no workspace, stays on user settings.
 * Tests that install a partial policy keep the historical three sources.
 */
export function claudeSettingSourcesForCwd(
  cwd: string | null | undefined
): ReadonlyArray<"user" | "project" | "local"> {
  const trimmed = cwd?.trim() ?? ""
  if (!trimmed) return CLAUDE_USER_SETTING_SOURCES
  const policy = configuredPolicy
  if (!policy?.getWorkspaceTrust) return CLAUDE_TRUSTED_SETTING_SOURCES
  return policy.getWorkspaceTrust(trimmed).state === "trusted"
    ? CLAUDE_TRUSTED_SETTING_SOURCES
    : CLAUDE_USER_SETTING_SOURCES
}

/**
 * Installs the process-local policy used by provider callbacks that cannot
 * accept dependency injection (notably provider SDK permission callbacks).
 */
export function configureAgentPermissionRuntime(
  policy: AgentPermissionRuntimePolicy | null
): void {
  configuredPolicy = policy
  if (!policy) contextsByThread.clear()
}

export function bindAgentPermissionRuntimeContext(
  context: AgentPermissionRuntimeContext
): symbol {
  const token = Symbol(context.threadId)
  contextsByThread.set(context.threadId, { token, context })
  return token
}

export function clearAgentPermissionRuntimeContext(
  threadId: string,
  token?: symbol
): void {
  const current = contextsByThread.get(threadId)
  if (!current) return
  if (token && current.token !== token) return
  contextsByThread.delete(threadId)
}

export function runWithAgentPermissionRuntimeContext<T>(
  context: AgentPermissionRuntimeContext,
  operation: () => T
): T {
  return contextStorage.run(context, operation)
}

export function currentAgentPermissionRuntimeContext(
  threadId?: string | null
): AgentPermissionRuntimeContext | null {
  if (threadId?.trim()) {
    return contextsByThread.get(threadId)?.context ?? null
  }
  const context = contextStorage.getStore()
  return (
    (context && contextsByThread.get(context.threadId)?.context) ??
    context ??
    null
  )
}

/** Preserve the turn's ownership token and chat-mode ceiling during a live switch. */
export function updateAgentPermissionRuntimeLevel(
  threadId: string,
  permissionLevel: string
): AgentPermissionRuntimeContext | null {
  const bound = contextsByThread.get(threadId)
  if (!bound) return null
  const context = { ...bound.context, permissionLevel }
  contextsByThread.set(threadId, { ...bound, context })
  return context
}

/**
 * Evaluates a persisted grant using the current provider turn's workspace.
 * `null` means the shared runtime is not configured or the turn has no
 * workspace, so the provider's native policy remains authoritative.
 *
 * This deliberately does NOT branch on `appMode`. It used to return `null` for
 * anything other than `agent`, which made every durable grant — including an
 * explicit `deny` the user configured for a path like `.env` — silently inert
 * in Editor and Canvas mode, even though those modes dispatch ordinary
 * tool-using turns. Grants are scoped to a workspace and a tool, not to a UI
 * tab.
 */
export function evaluateConfiguredAgentToolPermission(
  input: ConfiguredAgentToolPermissionInput
): AgentPermissionPolicyDecision | null {
  const policy = configuredPolicy
  const context = currentAgentPermissionRuntimeContext(input.threadId)
  if (!policy || !context?.workspacePath?.trim()) return null

  const sessionDecision = evaluateSessionRules(
    context.threadId,
    input.toolName,
    input.toolInput
  )
  const explicitPath = input.path?.trim()
  const paths = explicitPath
    ? [explicitPath]
    : extractAgentToolPaths(input.toolInput)
  const decisions = (paths.length > 0 ? paths : [undefined]).map(
    (candidatePath) =>
      policy.evaluateTool({
        workspacePath: context.workspacePath!,
        toolName: input.toolName,
        path: candidatePath,
      })
  )
  if (sessionDecision) {
    // Session approvals can replace the default prompt, but never a durable
    // restriction, workspace trust decision, or path-confinement denial.
    const restrictions = decisions.filter(
      (decision) => decision.source !== "default"
    )
    restrictions.push({
      decision: sessionDecision,
      source: "session",
      reason: `Matched session ${sessionDecision} rule.`,
      normalizedPath: null,
      grant: null,
    })
    return restrictions.sort(compareToolDecisions)[0] ?? null
  }
  return decisions.sort(compareToolDecisions)[0] ?? null
}

/**
 * An allow grant may satisfy a provider approval, but never bypass immutable
 * read-only, planning, ask-only, or Security-mode ceilings.
 */
export function configuredAgentAllowMayAutoApprove(
  threadId?: string | null
): boolean {
  const context = currentAgentPermissionRuntimeContext(threadId)
  const rawMode = context?.chatMode
  const chatMode = rawMode == null ? "agent" : rawMode.trim().toLowerCase()
  const knownMode =
    chatMode === "agent" ||
    chatMode === "debug" ||
    chatMode === "plan" ||
    chatMode === "ask" ||
    chatMode === "security"
  if (
    !knownMode ||
    chatMode === "plan" ||
    chatMode === "ask" ||
    chatMode === "security"
  ) {
    return false
  }
  return normalizeLevel(context?.permissionLevel) !== "read-only"
}

export function listConfiguredAgentPermissionGrants(
  threadId?: string | null
): ReadonlyArray<AgentPermissionGrant> {
  const policy = configuredPolicy
  const context = currentAgentPermissionRuntimeContext(threadId)
  if (!policy || !context?.workspacePath?.trim()) return []
  return policy.listGrants({ workspacePath: context.workspacePath })
}

export function extractAgentToolPaths(toolInput: unknown): string[] {
  const discovered: string[] = []
  const visited = new Set<object>()

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || !value || typeof value !== "object") return
    if (visited.has(value)) return
    visited.add(value)

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }

    const record = value as Record<string, unknown>
    for (const [key, candidate] of Object.entries(record)) {
      if (PATH_FIELD_KEYS.has(normalizeFieldKey(key))) {
        collectPathValue(candidate, discovered)
      }
      if (
        NESTED_TOOL_INPUT_KEYS.has(normalizeFieldKey(key)) ||
        (candidate !== null && typeof candidate === "object")
      ) {
        visit(candidate, depth + 1)
      }
    }
  }

  visit(toolInput, 0)
  return [...new Set(discovered)]
}

function collectPathValue(value: unknown, target: string[]): void {
  if (typeof value === "string" && value.trim()) {
    target.push(value.trim())
    return
  }
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === "string" && item.trim()) target.push(item.trim())
  }
}

function normalizeFieldKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "")
}

const PATH_FIELD_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "notebookpath",
  "cwd",
  "directory",
  "directories",
  "parentdir",
  "workdir",
  "workingdirectory",
])

const NESTED_TOOL_INPUT_KEYS = new Set([
  "args",
  "arguments",
  "input",
  "inputs",
  "params",
  "parameters",
  "raw",
  "changes",
  "files",
])

function compareToolDecisions(
  left: AgentPermissionPolicyDecision,
  right: AgentPermissionPolicyDecision
): number {
  const rank = { deny: 3, ask: 2, allow: 1 } as const
  return rank[right.decision] - rank[left.decision]
}
