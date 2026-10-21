import { normalizeLevel } from "../permissions"

/**
 * Shared chat-mode → available-tool mapping.
 *
 * Both the legacy `ClaudeAgentAdapter` (provider_kind `anthropic_cli`) and
 * the runtime `ClaudeAdapter` (provider_kind `claude`) need to honour the
 * same Plan/Agent/Ask/Security/Debug semantics. Without a shared source of truth
 * they drift — pre-extraction the legacy adapter ignored chat_mode entirely
 * and shipped the full toolset in Plan mode.
 */

export const AGENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "WebSearch",
  "WebFetch",
  "NotebookEdit",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
]

export const PLAN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "AskUserQuestion",
  "ExitPlanMode",
]

export const ASK_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
]

export const SECURITY_TOOLS = [
  "Read",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
]

export const NO_TOOLS: string[] = []

/**
 * `null` is the agent default. A known mode matches after trim and case
 * folding. Every other spelling is restricted, so `"Plan"` cannot advertise
 * the full toolset.
 */
export function normalizeChatMode(
  mode: string | null | undefined
): "agent" | "debug" | "plan" | "ask" | "security" | "restricted" {
  if (mode == null) return "agent"
  const key = mode.trim().toLowerCase()
  if (
    key === "agent" ||
    key === "debug" ||
    key === "plan" ||
    key === "ask" ||
    key === "security"
  ) {
    return key
  }
  return "restricted"
}

export function getToolsForMode(mode: string | null | undefined): string[] {
  switch (normalizeChatMode(mode)) {
    case "plan":
    case "restricted":
      return PLAN_TOOLS
    case "ask":
      return ASK_TOOLS
    case "security":
      return SECURITY_TOOLS
    case "debug":
    case "agent":
      return AGENT_TOOLS
  }
}

/**
 * BetterC0de's in-process MCP image-generation tool (Codex-CLI-backed).
 * Full MCP name (`mcp__<server>__<tool>`) because
 * that is the full MCP name exposed by the SDK. NOT part of AGENT_TOOLS —
 * the SDK `tools` option is builtins-only; MCP tools ride alongside.
 */
export const IMAGEGEN_TOOL_NAME = "mcp__betterc0de__generate_image"

export const BETTERC0DE_TOOL_POLICY_REASON =
  "BetterC0de evaluates every tool through its application permission policy."

/**
 * Native Claude settings may contain allow rules that would otherwise skip
 * `canUseTool`. Returning `ask` from PreToolUse forces every available tool
 * through BetterC0de's callback, where mode, project, session, and human
 * approval rules are evaluated.
 */
export function createClaudePreToolUseApprovalHook() {
  return async () => ({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "ask" as const,
      permissionDecisionReason: BETTERC0DE_TOOL_POLICY_REASON,
    },
  })
}

/**
 * Whether the imagegen gate may auto-allow after hard mode, session, and
 * project-policy checks. The MCP tool itself must not enter SDK
 * `allowedTools`, because that would skip `canUseTool` entirely.
 */
export function isImagegenAutoAllowed(
  mode: string | null | undefined,
  permissionLevel: string | null | undefined
): boolean {
  const chatMode = normalizeChatMode(mode)
  if (
    chatMode === "plan" ||
    chatMode === "ask" ||
    chatMode === "security" ||
    chatMode === "restricted"
  ) {
    return false
  }
  const normalized = normalizeLevel(permissionLevel)
  return normalized === "allow-edits" || normalized === "bypass"
}

/**
 * Tools known to be side-effect free. Membership is exact.
 *
 * This used to be a substring match ("does the name contain 'read'?"), which
 * made the classification forgeable by naming: any MCP tool advertised as
 * `mcp__server__read_and_apply_ab12` contained "read" and was therefore treated
 * as read-only — and this classifier is the *hard* Plan/Ask/read-only gate, so
 * such a tool executed with no prompt at all. Tool names come from MCP servers,
 * which are configurable per project, so the name is attacker-influenced input
 * and cannot describe capability. Anything not listed here is `unknown`, and
 * every caller treats `!== "read"` as "not allowed without approval".
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "askuserquestion",
  "ask_user_question",
  "exitplanmode",
  "exit_plan_mode",
])

/** Builtins known to mutate. Kept exact for the same reason as the read set. */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "applypatch",
  "apply_patch",
  "bash",
  "bashoutput",
  "killshell",
  "agent",
  "task",
  "todowrite",
  "todo_write",
])

export function classifyToolPermission(
  toolName: string
): "read" | "mutate" | "unknown" {
  const n = (toolName ?? "").trim().toLowerCase()
  if (!n) return "unknown"
  if (n === IMAGEGEN_TOOL_NAME.toLowerCase()) return "mutate"
  if (READ_ONLY_TOOLS.has(n)) return "read"
  if (MUTATING_TOOLS.has(n)) return "mutate"
  return "unknown"
}

/**
 * Mode-specific turn caps. Plan mode wraps up quickly (the model just needs
 * to propose a plan, not iterate). Ask mode is even tighter — Q&A only.
 */
export function getMaxTurnsForMode(mode: string | null | undefined): number {
  if (mode === "ask") return 10
  if (mode === "plan") return 20
  return 50
}

export function maxTurnsExhaustedMessage(maxTurns: number): string {
  return `Agent stopped after reaching the ${maxTurns}-turn safety limit without a final response.`
}

/**
 * Plan-mode rejection message used by `canUseTool` gates when the model
 * still tries to call a mutating tool despite the system-prompt
 * instruction. Same wording in both adapters so logs are searchable.
 */
export const PLAN_MODE_DENY_MESSAGE =
  "Plan mode — no file creation, code edits, shell commands, installs, migrations, or git writes. Only read-only planning tools are allowed (Read, Glob, Grep, WebSearch, AskUserQuestion, ExitPlanMode)."

export const ASK_MODE_DENY_MESSAGE =
  "Ask mode — no file creation, code edits, shell commands, installs, migrations, or git writes. Only read/search/question tools are allowed."
