import os from "node:os"
import fsSync from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type {
  AgentPermissionBehavior,
  AgentPermissionDestination,
  AgentPermissionGrant,
  WorkspaceTrustRecord,
  WorkspaceTrustState,
} from "@betterc0de/schema"
import type { Db } from "../persistence/db"

interface AgentPermissionGrantRow {
  id: string
  destination: AgentPermissionDestination
  workspace_path: string
  tool_name: string
  path_scope: string
  behavior: AgentPermissionBehavior
  created_at: string
  updated_at: string
}

interface WorkspaceTrustRow {
  workspace_path: string
  state: WorkspaceTrustState
  created_at: string
  updated_at: string
}

export type AgentPermissionPolicySource =
  | "grant"
  | "session"
  | "default"
  | "path_confinement"
  | "workspace_trust"

export interface AgentPermissionPolicyDecision {
  readonly decision: AgentPermissionBehavior
  readonly source: AgentPermissionPolicySource
  readonly reason: string
  readonly normalizedPath: string | null
  readonly grant: AgentPermissionGrant | null
}

export type AgentTurnTrustDecision =
  | {
      readonly decision: "allow"
      readonly source: "default"
    }
  | {
      readonly decision: "deny"
      readonly source: "workspace_trust" | "path_confinement"
      readonly reason: string
      readonly toolName: string
    }

export type EffectiveAgentAppMode = "agent" | "editor" | "design"

export class AgentPermissionInputError extends Error {
  readonly statusCode = 400
  readonly code = "invalid_agent_permission"

  constructor(message: string) {
    super(message)
    this.name = "AgentPermissionInputError"
  }
}

export class AgentWorkspaceUntrustedError extends Error {
  readonly statusCode = 403
  readonly code = "workspace_untrusted"
  readonly workspacePath: string
  readonly operation: string

  constructor(input: {
    readonly workspacePath: string
    readonly operation: string
  }) {
    const operation = input.operation.trim() || "perform this operation"
    super(`The workspace is untrusted and cannot ${operation}.`)
    this.name = "AgentWorkspaceUntrustedError"
    this.workspacePath = input.workspacePath
    this.operation = operation
  }
}

export interface AgentPermissionPolicyOptions {
  readonly now?: () => Date
  readonly createId?: () => string
  /**
   * Read live so a settings change takes effect without rebuilding the policy.
   * When true, the first Agent turn in a workspace the user opened records
   * trust instead of failing the turn. An explicit `untrusted` record still
   * wins, so the kill switch keeps working.
   */
  readonly autoTrustWorkspaces?: () => boolean
  /**
   * Directories the agent CLIs own themselves (`~/.claude`, `~/.codex`, …).
   * A tool call there is not a workspace escape: the CLI process reads and
   * writes these files anyway, and Claude Code keeps its auto-memory under
   * `~/.claude/projects/<slug>/memory`. Defaults to `defaultAgentConfigRoots`.
   */
  readonly agentConfigRoots?: () => readonly string[]
}

/**
 * The agent CLIs' own home directories, honouring the override variables
 * each CLI reads (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
 */
export function defaultAgentConfigRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string[] {
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude")
  const codex = env.CODEX_HOME?.trim() || path.join(home, ".codex")
  return [claude, codex, path.join(home, ".cursor"), path.join(home, ".grok")]
}

/**
 * Whether `candidate` is inside one of the agent config roots. Only absolute
 * candidates qualify: a relative path is workspace-relative by definition.
 */
export function isAgentConfigPath(
  candidate: string,
  roots: readonly string[]
): boolean {
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.includes("\0") || !path.isAbsolute(trimmed))
    return false
  const absolute = path.resolve(trimmed.replace(/[\\/]+/g, path.sep))
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root)
    const relative = path.relative(normalizedRoot, absolute)
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    )
  })
}

/**
 * Durable, provider-neutral permission and workspace-trust policy.
 *
 * Grant paths are directory/file prefixes relative to the selected workspace.
 * A root scope (`.`) matches every path, while `src` matches `src` and all of
 * its descendants. Explicit deny wins over ask, which wins over allow.
 */
export class AgentPermissionPolicy {
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly autoTrustWorkspaces: () => boolean
  private readonly agentConfigRoots: () => readonly string[]
  // Prepared once: evaluateTool/getWorkspaceTrust run on every tool call of
  // every turn, and better-sqlite3 re-plans SQL on each db.prepare.
  private readonly listAllGrantsStmt
  private readonly listGrantsByDestinationStmt
  private readonly listWorkspaceGrantsStmt
  private readonly upsertGrantStmt
  private readonly findGrantByIdentityStmt
  private readonly deleteGrantStmt
  private readonly findWorkspaceTrustStmt
  private readonly upsertWorkspaceTrustStmt

  constructor(db: Db, options: AgentPermissionPolicyOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.autoTrustWorkspaces = options.autoTrustWorkspaces ?? (() => false)
    this.agentConfigRoots = options.agentConfigRoots ?? defaultAgentConfigRoots
    // 'user' < 'workspace', so concatenating the two per-destination reads
    // reproduces this ORDER BY without a temp b-tree.
    const grantColumns = `
      SELECT id, destination, workspace_path, tool_name, path_scope,
             behavior, created_at, updated_at
      FROM agent_permission_grants
    `
    const grantOrder = `
      ORDER BY destination, workspace_path, tool_name, path_scope, id
    `
    this.listAllGrantsStmt = db.prepare(`${grantColumns} ${grantOrder}`)
    this.listGrantsByDestinationStmt = db.prepare(`
      ${grantColumns}
      WHERE destination = ?
      ${grantOrder}
    `)
    this.listWorkspaceGrantsStmt = db.prepare(`
      ${grantColumns}
      WHERE destination = 'workspace' AND workspace_path = ?
      ${grantOrder}
    `)
    this.upsertGrantStmt = db.prepare(`
      INSERT INTO agent_permission_grants
        (id, destination, workspace_path, tool_name, path_scope, behavior,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination, workspace_path, tool_name, path_scope)
      DO UPDATE SET
        behavior = excluded.behavior,
        updated_at = excluded.updated_at
    `)
    this.findGrantByIdentityStmt = db.prepare(`
      ${grantColumns}
      WHERE destination = ?
        AND workspace_path = ?
        AND tool_name = ?
        AND path_scope = ?
    `)
    this.deleteGrantStmt = db.prepare(
      "DELETE FROM agent_permission_grants WHERE id = ?"
    )
    this.findWorkspaceTrustStmt = db.prepare(`
      SELECT workspace_path, state, created_at, updated_at
      FROM agent_workspace_trust
      WHERE workspace_path = ?
    `)
    this.upsertWorkspaceTrustStmt = db.prepare(`
      INSERT INTO agent_workspace_trust
        (workspace_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_path)
      DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
    `)
  }

  listGrants(
    input: {
      readonly workspacePath?: string | null
      readonly destination?: AgentPermissionDestination
      readonly includeUser?: boolean
    } = {}
  ): AgentPermissionGrant[] {
    const workspacePath = input.workspacePath
      ? normalizeWorkspaceRoot(input.workspacePath)
      : null
    const includeUser = input.includeUser !== false
    let rows: AgentPermissionGrantRow[]
    if (workspacePath) {
      rows = []
      if (includeUser && input.destination !== "workspace") {
        rows.push(
          ...(this.listGrantsByDestinationStmt.all(
            "user"
          ) as AgentPermissionGrantRow[])
        )
      }
      if (input.destination !== "user") {
        rows.push(
          ...(this.listWorkspaceGrantsStmt.all(
            workspacePath
          ) as AgentPermissionGrantRow[])
        )
      }
    } else if (input.destination) {
      rows = this.listGrantsByDestinationStmt.all(
        input.destination
      ) as AgentPermissionGrantRow[]
    } else {
      rows = this.listAllGrantsStmt.all() as AgentPermissionGrantRow[]
    }
    return rows.map(toGrant)
  }

  upsertGrant(input: {
    readonly destination: AgentPermissionDestination
    readonly workspacePath?: string | null
    readonly toolName: string
    readonly pathScope?: string
    readonly behavior: AgentPermissionBehavior
  }): AgentPermissionGrant {
    const workspacePath =
      input.destination === "workspace"
        ? normalizeWorkspaceRoot(
            requireWorkspacePath(input.workspacePath, "workspace grant")
          )
        : ""
    if (input.destination === "user" && input.workspacePath) {
      throw new AgentPermissionInputError(
        "User grants cannot carry a workspace path."
      )
    }
    const toolName = normalizeAgentPermissionToolName(input.toolName)
    if (input.behavior === "allow") {
      const rawScope = input.pathScope?.trim() ?? ""
      if (!rawScope || rawScope === "." || rawScope === "*") {
        throw new AgentPermissionInputError(
          "Durable allow grants require a concrete path scope and cannot use a wildcard tool name."
        )
      }
      if (toolName === "*") {
        throw new AgentPermissionInputError(
          "Durable allow grants require a concrete path scope and cannot use a wildcard tool name."
        )
      }
    }
    const pathScope = normalizeGrantPathScope(
      input.pathScope ?? (input.behavior === "allow" ? "" : ".")
    )
    if (input.behavior === "allow" && pathScope === ".") {
      throw new AgentPermissionInputError(
        "Durable allow grants require a concrete path scope and cannot use a wildcard tool name."
      )
    }
    const now = this.now().toISOString()
    const id = this.createId()

    this.upsertGrantStmt.run(
      id,
      input.destination,
      workspacePath,
      toolName,
      pathScope,
      input.behavior,
      now,
      now
    )

    const row = this.findGrantByIdentityStmt.get(
      input.destination,
      workspacePath,
      toolName,
      pathScope
    ) as AgentPermissionGrantRow | undefined
    if (!row) throw new Error("Persisted permission grant could not be read.")
    return toGrant(row)
  }

  deleteGrant(id: string): boolean {
    const normalizedId = id.trim()
    if (!normalizedId) {
      throw new AgentPermissionInputError("Grant id is required.")
    }
    return this.deleteGrantStmt.run(normalizedId).changes > 0
  }

  getWorkspaceTrust(workspacePath: string): WorkspaceTrustRecord {
    const normalizedWorkspace = normalizeWorkspaceRoot(workspacePath)
    // Nearest explicit decision wins: a record on the path itself, else the
    // closest ancestor's. Callers may pass a directory deeper than the
    // project root (resolveApprovedWorkspaceRoot approves subdirectories of
    // registered roots by containment), and an explicitly untrusted project
    // must govern its whole subtree — otherwise a deeper cwd would bypass
    // the fail-closed decision.
    let candidate: string | null = normalizedWorkspace
    while (candidate) {
      const row = this.findWorkspaceTrustStmt.get(candidate) as
        | WorkspaceTrustRow
        | undefined
      if (row) {
        return {
          workspacePath: row.workspace_path,
          state: row.state,
          explicit: true,
          updatedAt: row.updated_at,
        }
      }
      const parent = path.dirname(candidate)
      candidate = parent && parent !== candidate ? parent : null
    }

    // Compatibility default: upgrades must not brick existing Claude turns.
    // Security-sensitive callers can require an explicit record via
    // `explicit`, and an explicit untrusted record always fails closed.
    return {
      workspacePath: normalizedWorkspace,
      state: "trusted",
      explicit: false,
      updatedAt: null,
    }
  }

  setWorkspaceTrust(input: {
    readonly workspacePath: string
    readonly state: WorkspaceTrustState
  }): WorkspaceTrustRecord {
    const workspacePath = normalizeWorkspaceRoot(input.workspacePath)
    const now = this.now().toISOString()
    this.upsertWorkspaceTrustStmt.run(workspacePath, input.state, now, now)
    return this.getWorkspaceTrust(workspacePath)
  }

  /**
   * Route/service-friendly trust boundary for workspace mutations that happen
   * outside a provider turn. Compatibility-trusted workspaces pass, while an
   * explicit untrusted record always fails closed.
   */
  assertWorkspaceTrusted(input: {
    readonly workspacePath: string
    readonly operation: string
  }): WorkspaceTrustRecord {
    const trust = this.getWorkspaceTrust(input.workspacePath)
    if (trust.state === "untrusted") {
      throw new AgentWorkspaceUntrustedError({
        workspacePath: trust.workspacePath,
        operation: input.operation,
      })
    }
    return trust
  }

  /**
   * Returns true when any durable user or workspace grant can require an
   * approval or deny a tool. Providers running in an auto-approve/full-access
   * mode must be lowered before session recovery so they cannot bypass these
   * grants by executing a tool without emitting an approval event.
   */
  hasRestrictiveGrants(workspacePath: string): boolean {
    return this.listGrants({ workspacePath, includeUser: true }).some(
      (grant) => grant.behavior === "ask" || grant.behavior === "deny"
    )
  }

  evaluateTool(input: {
    readonly workspacePath: string
    readonly toolName: string
    readonly path?: string | null
  }): AgentPermissionPolicyDecision {
    let workspacePath: string
    let toolName: string
    let normalizedPath: string | null = null
    try {
      workspacePath = normalizeWorkspaceRoot(input.workspacePath)
      toolName = normalizeAgentPermissionToolName(input.toolName)
      if (
        input.path &&
        isAgentConfigPath(input.path, this.agentConfigRoots())
      ) {
        // The CLI's own home is not a workspace escape. No workspace grant
        // can match an absolute path here, so the caller's level ceiling
        // (read-only, ask, allow-edits, bypass) decides, as it does for an
        // in-workspace path without a grant.
        const trust = this.getWorkspaceTrust(workspacePath)
        if (trust.state === "untrusted") {
          return {
            decision: "deny",
            source: "workspace_trust",
            reason: "Agent Mode is disabled for this untrusted workspace.",
            normalizedPath: null,
            grant: null,
          }
        }
        return {
          decision: "ask",
          source: "default",
          reason: "The path is inside the agent's own configuration directory.",
          normalizedPath: null,
          grant: null,
        }
      }
      normalizedPath = input.path
        ? normalizeWorkspaceRelativePath(workspacePath, input.path)
        : null
    } catch {
      return {
        decision: "deny",
        source: "path_confinement",
        reason: "The requested path is outside the selected workspace.",
        normalizedPath: null,
        grant: null,
      }
    }

    const trust = this.getWorkspaceTrust(workspacePath)
    if (trust.state === "untrusted") {
      return {
        decision: "deny",
        source: "workspace_trust",
        reason: "Agent Mode is disabled for this untrusted workspace.",
        normalizedPath,
        grant: null,
      }
    }

    const candidates = this.listGrants({ workspacePath }).filter((grant) => {
      if (grant.toolName !== "*" && grant.toolName !== toolName) return false
      return grantPathMatches(grant.pathScope, normalizedPath)
    })
    candidates.sort(compareGrantPrecedence)
    const grant = candidates[0] ?? null
    if (!grant) {
      return {
        decision: "ask",
        source: "default",
        reason: "No persisted permission grant matches this tool call.",
        normalizedPath,
        grant: null,
      }
    }
    return {
      decision: grant.behavior,
      source: "grant",
      reason: `Matched ${grant.destination} ${grant.behavior} grant.`,
      normalizedPath,
      grant,
    }
  }

  /**
   * Turn-level trust boundary.
   *
   * Workspace trust is a property of the WORKSPACE, not of the UI mode. This
   * used to return `allow` outright whenever `appMode` was anything other than
   * `agent`, which meant marking a workspace untrusted only stopped turns in
   * one of the three modes — Editor and Design turns still dispatched with the
   * full tool set, because the tool list keys off `chatMode`, not `appMode`.
   * `appMode` is a plain client-supplied field, so the strongest safety control
   * in the app was one tab away from being off.
   *
   * The only thing that legitimately varies by mode is whether a workspace is
   * *required*: Agent Mode is workspace-bound, while an Editor or Design chat
   * may run with no project attached. Once a workspace IS attached, its trust
   * state is binding in every mode.
   */
  evaluateTurnTrust(input: {
    readonly workspacePath?: string | null
    readonly appMode?: string | null
  }): AgentTurnTrustDecision {
    const isAgentMode =
      normalizeEffectiveAgentAppMode(input.appMode) === "agent"
    if (!input.workspacePath?.trim()) {
      if (!isAgentMode) return { decision: "allow", source: "default" }
      return {
        decision: "deny",
        source: "path_confinement",
        toolName: "AgentMode",
        // Surfaced verbatim to the user in the chat transcript, so it must name
        // the actual remedy rather than the internal "registered workspace"
        // concept — switch to Editor/Canvas mode or open a project folder.
        reason:
          "Agent Mode needs an open project folder. Open a folder, or switch to Editor or Canvas mode to continue.",
      }
    }

    let trust: WorkspaceTrustRecord
    try {
      trust = this.getWorkspaceTrust(input.workspacePath)
    } catch {
      return {
        decision: "deny",
        source: "path_confinement",
        toolName: "AgentMode",
        reason: "This turn requires a valid absolute workspace path.",
      }
    }
    if (trust.state === "untrusted") {
      return {
        decision: "deny",
        source: "workspace_trust",
        toolName: "AgentMode",
        reason: "This workspace is marked untrusted; agent turns are disabled.",
      }
    }
    if (isAgentMode && !trust.explicit) {
      if (this.autoTrustWorkspaces()) {
        // Recording the grant (rather than just allowing the turn) is what
        // makes repo-declared MCP servers and formatter commands work too —
        // those gates require an explicit record, not merely a passing turn.
        this.setWorkspaceTrust({
          workspacePath: trust.workspacePath,
          state: "trusted",
        })
        return { decision: "allow", source: "default" }
      }
      return {
        decision: "deny",
        source: "workspace_trust",
        toolName: "AgentMode",
        reason:
          "This workspace has not been trusted. Open Settings → Permissions → Trust project to enable Agent Mode here, or turn on “Trust opened workspaces automatically”.",
      }
    }
    return { decision: "allow", source: "default" }
  }

  /**
   * Applies the automatic-trust setting when opening a workspace. Registration
   * alone grants no explicit trust when disabled. Explicit decisions survive.
   */
  ensureWorkspaceTrusted(workspacePath: string): WorkspaceTrustRecord {
    const trust = this.getWorkspaceTrust(workspacePath)
    if (trust.explicit || !this.autoTrustWorkspaces()) return trust
    return this.setWorkspaceTrust({
      workspacePath: trust.workspacePath,
      state: "trusted",
    })
  }
}

/**
 * Agent is the compatibility and security default. Only an explicit,
 * normalized Editor or Design value opts out of Agent Mode policy.
 */
export function normalizeEffectiveAgentAppMode(
  appMode: string | null | undefined
): EffectiveAgentAppMode {
  switch ((appMode ?? "").trim().toLowerCase()) {
    case "editor":
      return "editor"
    case "design":
      return "design"
    case "agent":
    default:
      return "agent"
  }
}

export function normalizeWorkspaceRoot(workspacePath: string): string {
  const trimmed = workspacePath.trim()
  if (!trimmed || trimmed.includes("\0")) {
    throw new AgentPermissionInputError(
      "Workspace path must be a non-empty absolute path."
    )
  }
  if (!path.isAbsolute(trimmed)) {
    throw new AgentPermissionInputError("Workspace path must be absolute.")
  }
  const resolved = path.resolve(trimmed)
  // Windows can expose the same directory through a long path and its 8.3
  // short alias. Canonicalize existing roots before using them as persistence
  // keys so an opened folder and a later request address the same workspace.
  const canonical =
    process.platform === "win32"
      ? (() => {
          try {
            return fsSync.realpathSync.native(resolved)
          } catch {
            return resolved
          }
        })()
      : resolved
  const root = path.parse(canonical).root
  const withoutTrailingSeparators =
    canonical.length > root.length
      ? canonical.replace(/[\\/]+$/, "")
      : canonical
  return process.platform === "win32"
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators
}

export function normalizeGrantPathScope(pathScope: string): string {
  const trimmed = pathScope.trim()
  if (!trimmed || trimmed.includes("\0")) {
    throw new AgentPermissionInputError(
      "Grant path scope must be workspace-relative."
    )
  }
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    throw new AgentPermissionInputError(
      "Grant path scope must be workspace-relative."
    )
  }
  const segments = trimmed
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.some((segment) => segment === "..")) {
    throw new AgentPermissionInputError(
      "Grant path scope must stay inside the workspace."
    )
  }
  return segments.join("/") || "."
}

export function normalizeWorkspaceRelativePath(
  workspacePath: string,
  candidatePath: string
): string {
  const root = normalizeWorkspaceRoot(workspacePath)
  const trimmed = candidatePath.trim()
  if (!trimmed || trimmed.includes("\0")) {
    throw new AgentPermissionInputError("Tool path is invalid.")
  }

  const nativeAbsolute = path.isAbsolute(trimmed)
  const foreignAbsolute =
    path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)
  if (foreignAbsolute && !nativeAbsolute) {
    throw new AgentPermissionInputError(
      "Tool path uses an unsupported absolute path format."
    )
  }
  if (
    !nativeAbsolute &&
    trimmed
      .replaceAll("\\", "/")
      .split("/")
      .some((segment) => segment === "..")
  ) {
    throw new AgentPermissionInputError(
      "Tool path must stay inside the workspace."
    )
  }

  const nativePath = trimmed.replace(/[\\/]+/g, path.sep)
  const absolute = nativeAbsolute
    ? path.resolve(nativePath)
    : path.resolve(root, nativePath)
  const relative = path.relative(root, absolute)
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AgentPermissionInputError(
      "Tool path must stay inside the workspace."
    )
  }
  return relative ? relative.split(path.sep).join("/") : "."
}

export function normalizeAgentPermissionToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase()
  if (!normalized || normalized.length > 256 || normalized.includes("\0")) {
    throw new AgentPermissionInputError("Tool name is invalid.")
  }
  if (normalized === "*") return normalized
  const key = normalized.replace(/[\s_.:/-]+/g, "")
  if (
    [
      "bash",
      "shell",
      "terminal",
      "exec",
      "command",
      "commandexecutionapproval",
      "execcommandapproval",
    ].includes(key)
  ) {
    return "bash"
  }
  if (
    [
      "edit",
      "write",
      "patch",
      "applypatch",
      "multiedit",
      "notebookedit",
      "fileedit",
      "filechange",
      "filechangeapproval",
      "applypatchapproval",
    ].includes(key)
  ) {
    return "edit"
  }
  if (["read", "fileread", "filereadapproval"].includes(key)) return "read"
  if (["list", "ls", "directorylist"].includes(key)) return "list"
  return normalized
}

function requireWorkspacePath(
  workspacePath: string | null | undefined,
  subject: string
): string {
  if (!workspacePath?.trim()) {
    throw new AgentPermissionInputError(
      `Workspace path is required for ${subject}.`
    )
  }
  return workspacePath
}

function toGrant(row: AgentPermissionGrantRow): AgentPermissionGrant {
  return {
    id: row.id,
    destination: row.destination,
    workspacePath: row.destination === "workspace" ? row.workspace_path : null,
    toolName: row.tool_name,
    pathScope: row.path_scope,
    behavior: row.behavior,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function grantPathMatches(
  pathScope: string,
  normalizedPath: string | null
): boolean {
  if (pathScope === ".") return true
  if (!normalizedPath) return false
  if (process.platform === "win32") {
    pathScope = pathScope.toLowerCase()
    normalizedPath = normalizedPath.toLowerCase()
  }
  return (
    normalizedPath === pathScope || normalizedPath.startsWith(`${pathScope}/`)
  )
}

function compareGrantPrecedence(
  left: AgentPermissionGrant,
  right: AgentPermissionGrant
): number {
  const behaviorRank: Record<AgentPermissionBehavior, number> = {
    deny: 3,
    ask: 2,
    allow: 1,
  }
  const byBehavior = behaviorRank[right.behavior] - behaviorRank[left.behavior]
  if (byBehavior !== 0) return byBehavior

  const byDestination =
    Number(right.destination === "workspace") -
    Number(left.destination === "workspace")
  if (byDestination !== 0) return byDestination

  const byTool = Number(right.toolName !== "*") - Number(left.toolName !== "*")
  if (byTool !== 0) return byTool

  const leftDepth =
    left.pathScope === "." ? 0 : left.pathScope.split("/").length
  const rightDepth =
    right.pathScope === "." ? 0 : right.pathScope.split("/").length
  if (rightDepth !== leftDepth) return rightDepth - leftDepth

  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt)
  if (byUpdatedAt !== 0) return byUpdatedAt
  return left.id.localeCompare(right.id)
}
