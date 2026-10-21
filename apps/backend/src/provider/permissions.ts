/**
 * Provider-agnostic permission policy.
 *
 * Translates the renderer's four preset levels (`read-only`, `ask-on-edit`,
 * `allow-edits`, `bypass`) into a single `allow | ask | deny` decision that
 * every adapter consults before emitting a `tool_call`. Codex still gets its
 * native sandbox/approvalPolicy mapping in `codexCliPolicies.ts`; this module
 * is the cross-provider source of truth for Claude (API + Agent SDK),
 * OpenAI, Grok, OpenRouter, LM Studio, and Google.
 */

export type PermissionLevel =
  | "read-only"
  | "ask-on-edit"
  | "allow-edits"
  | "bypass"

export type ToolClass = "read" | "egress" | "write" | "execute" | "unknown"

export type PermissionDecision = "allow" | "ask" | "deny"

const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "read",
  "grep",
  "glob",
  "fs_read",
  "file_read",
  "list_files",
  "workspace.read",
  "workspace_read",
  "list_directory",
])

/**
 * Tools that send data off the machine.
 *
 * These used to sit in READ_TOOLS, which meant they were auto-allowed at every
 * level — including `read-only` and Plan mode. Those modes restrict *mutation*;
 * they were leaving a full outbound channel open, which is the second half of
 * the standard prompt-injection chain (read a secret with the always-allowed
 * `Read`, then post it to an attacker-controlled URL). Reading a file and
 * publishing it are different powers and now classify differently.
 */
const EGRESS_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "web_fetch",
  "web_search",
  "webfetch",
  "websearch",
  "fetch_url",
  "http_request",
])

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
  "MultiEdit",
  "write",
  "edit",
  "fs_write",
  "file_write",
  "file_edit",
  "create_file",
  "apply_patch",
  "workspace.write",
  "workspace_write",
])

const EXECUTE_TOOLS = new Set([
  "Bash",
  "bash",
  "shell",
  "shell.run",
  "shell_run",
  "run_command",
  "execute_command",
  "exec",
  "Agent",
  "Task",
])

/**
 * Classify a tool name (and optionally its arguments) into a coarse class.
 * Unknown names fall back to `"unknown"` which the decision matrix treats as
 * `write` — conservative default so a provider that invents its own tool name
 * can't sneak writes through a read-only session.
 */
export function classifyTool(
  toolName: string,
  _toolInput?: unknown
): ToolClass {
  const name = (toolName ?? "").trim()
  if (!name) return "unknown"

  const folded = name.toLowerCase()
  if (READ_TOOLS.has(name) || READ_TOOLS.has(folded)) return "read"
  if (EGRESS_TOOLS.has(name) || EGRESS_TOOLS.has(folded)) return "egress"
  if (WRITE_TOOLS.has(name) || WRITE_TOOLS.has(folded)) return "write"
  // A command string cannot be proven read-only by prefix inspection. Common
  // "read" commands have write flags, hooks, aliases and platform-specific
  // escape hatches, so every shell invocation remains executable work.
  if (EXECUTE_TOOLS.has(name) || EXECUTE_TOOLS.has(folded)) return "execute"
  return "unknown"
}

/**
 * Decision matrix:
 *
 * ```
 * level / class       read      egress    write     execute   unknown
 * bypass              allow     allow     allow     allow     allow
 * allow-edits         allow     ask       allow     ask       ask
 * ask-on-edit         allow     ask       ask       ask       ask
 * read-only           allow     ask       deny      deny      deny
 * ```
 *
 * Note: `allow-edits` does NOT auto-approve `execute` — shell and agent tools
 * always require explicit approval unless the user opts in to `bypass`.
 * Prevents single-paste prompt-injection from reaching RCE via an LLM tool
 * call on a user who simply enabled write-without-asking.
 *
 * `egress` asks rather than denying under `read-only`: fetching a URL is a
 * legitimate part of reading about a problem, and denying outright would make
 * Plan mode useless for research. Asking keeps the user in the loop on the one
 * action that can carry workspace contents off the machine. The approval card
 * shows the URL, so the decision is informed.
 */
export function evaluatePermission(
  level: PermissionLevel | string | null | undefined,
  cls: ToolClass
): PermissionDecision {
  const normalized = normalizeLevel(level)
  if (normalized === "bypass") return "allow"
  if (cls === "read") return "allow"
  if (cls === "egress") return "ask"
  if (normalized === "read-only") return "deny"
  if (normalized === "allow-edits" && cls === "write") return "allow"
  // ask-on-edit / allow-edits-with-execute / unknown → require approval.
  return "ask"
}

/**
 * The four presets plus `default` — "the provider's own permission engine
 * decides, we add no second gate". `default` has no equivalent among the
 * presets, so {@link normalizeLevel} cannot express it, which is why adapters
 * that support it need this wider union.
 */
export type GatePermissionLevel = PermissionLevel | "default"

/**
 * Single canonicalizer for every permission-level spelling that reaches an
 * adapter gate.
 *
 * Adapter gates used to compare `permissionLevel` against raw string literals
 * while every other enforcement point (`/shell/run`, `tool-gate`, the hub
 * ceiling, `sessionPermissions`) called `normalizeLevel` first. That meant a
 * turn sent as `"read"` — which `normalizeLevel` maps to `read-only`, and which
 * `/shell/run` correctly denies — was an unrecognized string to the adapter and
 * fell through to "ask". It failed safe only because of which aliases happen to
 * exist today; the next alias added to `normalizeLevel` would not have been.
 *
 * Everything delegates to `normalizeLevel` except the two adapter-native
 * spellings for the auto-approve presets, which are mapped here so there is
 * exactly one place that knows the full set.
 */
export function normalizeGatePermissionLevel(
  level: string | null | undefined
): GatePermissionLevel {
  const key = (level ?? "").toString().toLowerCase().trim()
  if (key === "default") return "default"
  if (key === "auto-accept-edits") return "allow-edits"
  return normalizeLevel(key)
}

export function normalizeLevel(
  level: PermissionLevel | string | null | undefined
): PermissionLevel {
  switch ((level ?? "").toString().toLowerCase().trim()) {
    case "bypass":
      return "bypass"
    case "allow-edits":
    case "full":
    case "full-access":
      return "allow-edits"
    case "read-only":
    case "read":
      return "read-only"
    case "ask-on-edit":
    case "ask":
      return "ask-on-edit"
    default:
      // Fail-closed on unknown/missing levels — users who want auto-execute
      // must explicitly pick "bypass" or "allow-edits".
      return "ask-on-edit"
  }
}

/**
 * Human-readable reason for a deny/ask decision — surfaces inline to the
 * user when a tool is blocked so they understand the action wasn't just
 * dropped silently.
 */
export function describeBlock(
  level: PermissionLevel,
  toolName: string
): string {
  switch (level) {
    case "read-only":
      return `Permission policy blocked \`${toolName}\` (Read-Only mode — no writes or executions).`
    case "ask-on-edit":
      return `Permission policy requires approval for \`${toolName}\` (Ask-on-Edit mode).`
    default:
      return `Permission policy blocked \`${toolName}\`.`
  }
}

// ─── Session permission map ─────────────────────────────────────────────────
// In-memory mirror of the most recently chosen permission_level per thread,
// so HTTP backstops (shell.ts / workspace.ts) can consult the current policy
// without threading it through every provider adapter.
//
// Populated by the /chat/send route on every turn; consumers read but never
// mutate it directly. A simple Map is enough — this state is ephemeral per
// IDE session, and threads are short-lived.

export const sessionPermissions = new Map<string, PermissionLevel>()

export function setSessionPermission(
  threadId: string,
  level: PermissionLevel | string | null | undefined
): void {
  sessionPermissions.set(threadId, normalizeLevel(level))
}

export function getSessionPermission(threadId: string): PermissionLevel {
  return sessionPermissions.get(threadId) ?? "ask-on-edit"
}

// ─── Pending approvals ──────────────────────────────────────────────────────
// The `ask-on-edit` path emits `tool_approval_requested` and waits for the
// renderer to POST `/chat/approval` — the HTTP route routes the decision
// back here via `resolveApproval`, which resolves the promise handed out by
// `awaitApproval`. Adapters then inspect the decision to decide whether to
// proceed with the tool call.

type ApprovalDecision = "approve" | "deny"
type ApprovalResolver = (decision: ApprovalDecision) => void

interface PendingApproval {
  readonly resolve: ApprovalResolver
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000
const pendingApprovals = new Map<string, PendingApproval>()

function approvalKey(threadId: string, requestId: string): string {
  return `${threadId}::${requestId}`
}

export function generateApprovalRequestId(): string {
  // M8: switch from `Date.now() + 8 random chars` (collision-prone in the
  // same millisecond under load) to crypto.randomUUID — already used
  // throughout the codebase, no extra dep.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto")
  return `perm-${randomUUID()}`
}

export function awaitApproval(
  threadId: string,
  requestId: string,
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const key = approvalKey(threadId, requestId)
    const previous = pendingApprovals.get(key)
    if (previous) {
      clearTimeout(previous.timer)
      previous.resolve("deny")
    }
    const timer = setTimeout(
      () => {
        const current = pendingApprovals.get(key)
        if (!current || current.resolve !== resolve) return
        pendingApprovals.delete(key)
        resolve("deny")
      },
      Math.max(1, timeoutMs)
    )
    timer.unref?.()
    pendingApprovals.set(key, { resolve, timer })
  })
}

export function resolveApproval(
  threadId: string,
  requestId: string,
  decision: ApprovalDecision
): boolean {
  const key = approvalKey(threadId, requestId)
  const pending = pendingApprovals.get(key)
  if (!pending) return false
  pendingApprovals.delete(key)
  clearTimeout(pending.timer)
  pending.resolve(decision)
  return true
}

/** Reject every pending approval for a thread — used when the user interrupts
 *  the turn so no awaiting adapter hangs forever. */
export function cancelPendingApprovals(threadId: string): number {
  let count = 0
  for (const [key, pending] of pendingApprovals) {
    if (key.startsWith(`${threadId}::`)) {
      pendingApprovals.delete(key)
      clearTimeout(pending.timer)
      pending.resolve("deny")
      count += 1
    }
  }
  return count
}
