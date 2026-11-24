/** Applies BetterC0de permission policy before a direct API tool can run. */

import {
  classifyTool,
  describeBlock,
  evaluatePermission,
  requestToolApproval,
  type PermissionLevel,
} from "../permissions"
import { evaluateConfiguredAgentToolPermission } from "../agent-permission-runtime"
import {
  evaluateProjectPermissionRules,
  type ProjectPermissionRule,
} from "../project-permission-rules"
import {
  projectPermissionForTool,
  projectPermissionPattern,
} from "../project-tool-policy"
import { normalizeChatMode } from "../shared/chat-mode-tools"

export type GateEmit = (event: {
  event_type: string
  thread_id: string
  payload: Record<string, unknown>
}) => void

export interface GateDecision {
  allow: boolean
  reason?: string
}

export async function gateToolCall(args: {
  emit: GateEmit
  providerKind: string
  threadId: string
  level: PermissionLevel
  /** Chat mode — `security` forces ask-on-edit semantics even on bypass. */
  mode: string | null
  toolName: string
  input: unknown
  signal?: AbortSignal
  /**
   * Repository rules for this turn. A deny applies even at bypass. An allow
   * cannot widen the mode ceiling. Omitted when the turn has no project.
   */
  projectPermissionRules?: readonly ProjectPermissionRule[]
}): Promise<GateDecision> {
  const { emit, providerKind, threadId, level, toolName, input, signal } = args
  if (signal?.aborted) return { allow: false, reason: "Turn cancelled." }
  const mode = normalizeChatMode(args.mode)
  // Advertised tools are only a hint to the model: enforce mode ceilings even
  // when a provider returns a tool that was not in its request's tool list.
  const gateLevel: PermissionLevel =
    mode === "plan" || mode === "ask" || mode === "restricted"
      ? "read-only"
      : mode === "security"
        ? "ask-on-edit"
        : level
  const cls = classifyTool(toolName, input)
  const ceilingDecision = evaluatePermission(gateLevel, cls)
  const durableDecision = evaluateConfiguredAgentToolPermission({
    threadId,
    toolName,
    toolInput: input,
  })
  const projectPermission = projectPermissionForTool(toolName)
  const projectPattern = projectPermissionPattern(toolName, input)
  const projectRule = evaluateProjectPermissionRules(
    args.projectPermissionRules ?? [],
    { permission: projectPermission, pattern: projectPattern }
  )
  const projectAction = projectRule?.action ?? null

  // Durable policy may narrow any native mode. An explicit allow can satisfy
  // an approval request, but it cannot widen read-only or chat-mode ceilings.
  // Project rules narrow the same way and never widen it.
  const allowMayAutoApprove = gateLevel !== "read-only" && mode !== "security"
  const durableExplicit = Boolean(
    durableDecision && durableDecision.source !== "default"
  )
  let decision: "allow" | "ask" | "deny" = ceilingDecision
  if (durableExplicit && durableDecision) {
    decision =
      durableDecision.decision === "allow" && !allowMayAutoApprove
        ? ceilingDecision
        : durableDecision.decision
  }
  if (projectAction === "deny") decision = "deny"
  else if (projectAction === "ask" && decision !== "deny") decision = "ask"

  if (decision === "allow") return { allow: true }
  if (decision === "deny") {
    const durableDenied =
      durableDecision?.decision === "deny" &&
      durableDecision.source !== "default"
    return {
      allow: false,
      reason:
        durableDenied && durableDecision
          ? durableDecision.reason
          : projectAction === "deny"
            ? `BetterC0de project permission denied ${projectPermission}:${projectPattern}.`
            : describeBlock(gateLevel, toolName),
    }
  }

  const answer = await requestToolApproval(threadId, (requestId) => {
    emit({
      event_type: "tool_approval_requested",
      thread_id: threadId,
      payload: { providerKind, requestId, tool: toolName, input },
    })
  })
  if (signal?.aborted) return { allow: false, reason: "Turn cancelled." }
  return answer === "approve"
    ? { allow: true }
    : {
        allow: false,
        reason: `${describeBlock(gateLevel, toolName)} (user denied)`,
      }
}
