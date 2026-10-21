import { AsyncLocalStorage } from "node:async_hooks"
import type {
  AgentPermissionGrant,
  WorkspaceTrustRecord,
} from "@betterc0de/schema"
import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyDecision,
} from "./agent-permission-policy"
import { evaluateSessionRules } from "./session-permission-rules"
import { normalizeLevel } from "./permissions"
import type { ProviderEventBus } from "./events"
import type { LegacyProviderEvent } from "./types"

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

export type AgentPermissionRuntimePolicy = Pick<
  AgentPermissionPolicy,
  "evaluateTool" | "listGrants"
> &
  Partial<Pick<AgentPermissionPolicy, "getWorkspaceTrust">>

export interface AgentPermissionRuntimeOptions {
  /**
   * The durable grants and workspace trust decisions are read from. Bootstrap
   * attaches it later with {@link AgentPermissionRuntime.setPolicy}, once the
   * database is open; without one the runtime is unconfigured.
   */
  readonly policy?: AgentPermissionRuntimePolicy | null
  /**
   * Where notices about configured decisions go: the backend's event bus
   * (bootstrap passes `BootRoot.eventBus`).
   */
  readonly events?: Pick<ProviderEventBus, "emitEvent"> | null
}

const CLAUDE_TRUSTED_SETTING_SOURCES = ["user", "project", "local"] as const
const CLAUDE_USER_SETTING_SOURCES = ["user"] as const

/**
 * The durable agent permission policy as provider callbacks see it, together
 * with the permission context of each running turn and the event bus notices
 * about configured decisions go to.
 *
 * Each backend owns one: `createBootRoot` constructs it with the backend's
 * event bus (`BootRoot.agentPermissionRuntime`), and the persistence phase
 * attaches the policy and installs it as the default
 * ({@link setDefaultAgentPermissionRuntime}). Provider SDK permission
 * callbacks and the adapters cannot take dependency injection, so they reach
 * the installed runtime through the free functions below. A test builds its
 * own and installs it, or calls its methods directly.
 */
export class AgentPermissionRuntime {
  private readonly contextStorage =
    new AsyncLocalStorage<AgentPermissionRuntimeContext>()
  private readonly contextsByThread = new Map<
    string,
    BoundAgentPermissionRuntimeContext
  >()
  private policy: AgentPermissionRuntimePolicy | null
  private readonly events: Pick<ProviderEventBus, "emitEvent"> | null

  constructor(options: AgentPermissionRuntimeOptions = {}) {
    this.policy = options.policy ?? null
    this.events = options.events ?? null
  }

  /**
   * Attaches the policy decisions are read from. Null releases it (and the
   * database it reads) and forgets every bound thread context; notices about
   * configured decisions go nowhere until a policy is attached again.
   */
  setPolicy(policy: AgentPermissionRuntimePolicy | null): void {
    this.policy = policy
    if (!policy) this.contextsByThread.clear()
  }

  /**
   * Claude loads repository hooks (commands it runs) from project and local
   * settings, so those sources need the same consent as repo-declared MCP
   * servers and formatters: an *explicit* trusted record for the workspace.
   * The compatibility default (`trusted` with no stored record), an
   * untrusted workspace, a turn with no workspace, and a runtime that cannot
   * report trust all stay on user settings.
   */
  claudeSettingSourcesForCwd(
    cwd: string | null | undefined
  ): ReadonlyArray<"user" | "project" | "local"> {
    const trimmed = cwd?.trim() ?? ""
    if (!trimmed) return CLAUDE_USER_SETTING_SOURCES
    const policy = this.policy
    if (!policy?.getWorkspaceTrust) return CLAUDE_USER_SETTING_SOURCES
    let trust: WorkspaceTrustRecord
    try {
      trust = policy.getWorkspaceTrust(trimmed)
    } catch {
      return CLAUDE_USER_SETTING_SOURCES
    }
    return trust.state === "trusted" && trust.explicit
      ? CLAUDE_TRUSTED_SETTING_SOURCES
      : CLAUDE_USER_SETTING_SOURCES
  }

  /**
   * Publishes a notice about a configured decision (a durable deny's
   * `tool.denied`) on the event bus, while a policy is attached; without a
   * bus or a policy it goes nowhere.
   */
  publishEvent(event: LegacyProviderEvent): void {
    if (!this.policy) return
    this.events?.emitEvent(event)
  }

  bindContext(context: AgentPermissionRuntimeContext): symbol {
    const token = Symbol(context.threadId)
    this.contextsByThread.set(context.threadId, { token, context })
    return token
  }

  clearContext(threadId: string, token?: symbol): void {
    const current = this.contextsByThread.get(threadId)
    if (!current) return
    if (token && current.token !== token) return
    this.contextsByThread.delete(threadId)
  }

  runWithContext<T>(
    context: AgentPermissionRuntimeContext,
    operation: () => T
  ): T {
    return this.contextStorage.run(context, operation)
  }

  currentContext(
    threadId?: string | null
  ): AgentPermissionRuntimeContext | null {
    if (threadId?.trim()) {
      return this.contextsByThread.get(threadId)?.context ?? null
    }
    const context = this.contextStorage.getStore()
    return (
      (context && this.contextsByThread.get(context.threadId)?.context) ??
      context ??
      null
    )
  }

  /** Preserve the turn's ownership token and chat-mode ceiling during a live switch. */
  updateLevel(
    threadId: string,
    permissionLevel: string
  ): AgentPermissionRuntimeContext | null {
    const bound = this.contextsByThread.get(threadId)
    if (!bound) return null
    const context = { ...bound.context, permissionLevel }
    this.contextsByThread.set(threadId, { ...bound, context })
    return context
  }

  /**
   * Evaluates a persisted grant using the current provider turn's
   * workspace. `null` means no policy is attached or the turn has no
   * workspace, so the provider's native policy remains authoritative.
   *
   * This deliberately does NOT branch on `appMode`. It used to return `null`
   * for anything other than `agent`, which made every durable grant —
   * including an explicit `deny` the user configured for a path like `.env`
   * — silently inert in Editor and Canvas mode, even though those modes
   * dispatch ordinary tool-using turns. Grants are scoped to a workspace and
   * a tool, not to a UI tab.
   */
  evaluateToolPermission(
    input: ConfiguredAgentToolPermissionInput
  ): AgentPermissionPolicyDecision | null {
    const policy = this.policy
    const context = this.currentContext(input.threadId)
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
      // Session approvals can replace the default prompt, but never a
      // durable restriction, workspace trust decision, or path-confinement
      // denial.
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
   * An allow grant may satisfy a provider approval, but never bypass
   * immutable read-only, planning, ask-only, or Security-mode ceilings.
   */
  allowMayAutoApprove(threadId?: string | null): boolean {
    const context = this.currentContext(threadId)
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

  listGrants(threadId?: string | null): ReadonlyArray<AgentPermissionGrant> {
    const policy = this.policy
    const context = this.currentContext(threadId)
    if (!policy || !context?.workspacePath?.trim()) return []
    return policy.listGrants({ workspacePath: context.workspacePath })
  }
}

/**
 * The runtime the free functions below use. Bootstrap installs each
 * backend's own at startup (`openPersistence`, once its policy is attached)
 * and uninstalls it when the backend stops
 * ({@link releaseAgentPermissionRuntime}); the provider callbacks and
 * adapters that consult it cannot take dependency injection, and threading
 * it through every adapter was not worth the churn.
 *
 * Code that runs outside a backend (tests, tooling) and installed nothing
 * gets an unconfigured runtime created on first use, never at import.
 */
let defaultRuntime: AgentPermissionRuntime | null = null

/**
 * Installs `runtime` as the one the free functions use; null forgets the
 * installed one.
 */
export function setDefaultAgentPermissionRuntime(
  runtime: AgentPermissionRuntime | null
): void {
  defaultRuntime = runtime
}

/** The installed runtime, or an unconfigured one created now when none is. */
export function defaultAgentPermissionRuntime(): AgentPermissionRuntime {
  defaultRuntime ??= new AgentPermissionRuntime()
  return defaultRuntime
}

/**
 * Releases `runtime`'s policy and thread contexts and, while it is the
 * installed default, uninstalls it. The startup unwind and the graceful
 * shutdown run this after every provider callback has settled; a backend
 * that stops after another one replaced it leaves the newer one alone.
 */
export function releaseAgentPermissionRuntime(
  runtime: AgentPermissionRuntime
): void {
  runtime.setPolicy(null)
  if (defaultRuntime === runtime) defaultRuntime = null
}

/** {@link AgentPermissionRuntime.claudeSettingSourcesForCwd} on the installed runtime. */
export function claudeSettingSourcesForCwd(
  cwd: string | null | undefined
): ReadonlyArray<"user" | "project" | "local"> {
  return defaultAgentPermissionRuntime().claudeSettingSourcesForCwd(cwd)
}

/** {@link AgentPermissionRuntime.publishEvent} on the installed runtime. */
export function publishAgentPermissionEvent(event: LegacyProviderEvent): void {
  defaultAgentPermissionRuntime().publishEvent(event)
}

export function bindAgentPermissionRuntimeContext(
  context: AgentPermissionRuntimeContext
): symbol {
  return defaultAgentPermissionRuntime().bindContext(context)
}

export function clearAgentPermissionRuntimeContext(
  threadId: string,
  token?: symbol
): void {
  defaultAgentPermissionRuntime().clearContext(threadId, token)
}

export function runWithAgentPermissionRuntimeContext<T>(
  context: AgentPermissionRuntimeContext,
  operation: () => T
): T {
  return defaultAgentPermissionRuntime().runWithContext(context, operation)
}

export function currentAgentPermissionRuntimeContext(
  threadId?: string | null
): AgentPermissionRuntimeContext | null {
  return defaultAgentPermissionRuntime().currentContext(threadId)
}

/** {@link AgentPermissionRuntime.updateLevel} on the installed runtime. */
export function updateAgentPermissionRuntimeLevel(
  threadId: string,
  permissionLevel: string
): AgentPermissionRuntimeContext | null {
  return defaultAgentPermissionRuntime().updateLevel(threadId, permissionLevel)
}

/** {@link AgentPermissionRuntime.evaluateToolPermission} on the installed runtime. */
export function evaluateConfiguredAgentToolPermission(
  input: ConfiguredAgentToolPermissionInput
): AgentPermissionPolicyDecision | null {
  return defaultAgentPermissionRuntime().evaluateToolPermission(input)
}

/** {@link AgentPermissionRuntime.allowMayAutoApprove} on the installed runtime. */
export function configuredAgentAllowMayAutoApprove(
  threadId?: string | null
): boolean {
  return defaultAgentPermissionRuntime().allowMayAutoApprove(threadId)
}

/** {@link AgentPermissionRuntime.listGrants} on the installed runtime. */
export function listConfiguredAgentPermissionGrants(
  threadId?: string | null
): ReadonlyArray<AgentPermissionGrant> {
  return defaultAgentPermissionRuntime().listGrants(threadId)
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
