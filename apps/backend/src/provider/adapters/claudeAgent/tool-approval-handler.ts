import {
  classifyTool,
  describeBlock,
  evaluatePermission,
  normalizeLevel,
  requestToolApproval,
} from "../../permissions"
import {
  classifyToolPermission,
  ASK_MODE_DENY_MESSAGE,
  PLAN_MODE_DENY_MESSAGE,
  normalizeChatMode,
} from "../../shared/chat-mode-tools"
import { evaluateBetterC0deProjectToolPermission } from "../../project-tool-policy"
import type { ProjectPermissionRule } from "../../project-permission-rules"

type EmitFn = (event: {
  event_type: string
  thread_id: string
  payload: Record<string, unknown>
}) => void

export type CanUseTool = (
  toolName: string,
  toolInput: unknown
) => Promise<{ behavior: "allow" | "deny"; input?: unknown; reason?: string }>

/**
 * Build a SDK `canUseTool` callback for the given permission level + chat mode.
 *
 * Plan mode is a hard gate: any non-read tool is denied with
 * `PLAN_MODE_DENY_MESSAGE` regardless of the user's permission level. This is
 * defence-in-depth — the adapter also restricts the SDK `tools` list in Plan
 * mode and supplies a "you are in plan mode" system prompt, but the model
 * occasionally tries `Bash`/`Edit` anyway. Without this gate the SDK falls
 * back to the user's permission level and may allow it.
 *
 * For non-plan modes the existing behaviour is unchanged:
 *   - `allow-edits` is explicitly allowed by this callback.
 *   - `read-only` denies anything that isn't a read.
 *   - `ask-on-edit` prompts the renderer for non-read tools.
 *   - `bypass` allows everything.
 */
export function buildCanUseTool(
  threadId: string,
  level: ReturnType<typeof normalizeLevel>,
  emit: EmitFn,
  chatMode: string | null | undefined,
  options: {
    readonly projectPermissionRules?: readonly ProjectPermissionRule[]
    readonly signal?: AbortSignal
  } = {}
): CanUseTool {
  const normalizedMode = normalizeChatMode(chatMode)
  const isPlanMode = normalizedMode === "plan"
  const isAskMode = normalizedMode === "ask" || normalizedMode === "restricted"
  const isSecurityMode = normalizedMode === "security"
  const projectPermissionRules = options.projectPermissionRules ?? []

  return async (toolName, toolInput) => {
    if (options.signal?.aborted)
      return { behavior: "deny", reason: "Turn cancelled." }
    if (isPlanMode) {
      const permissionClass = classifyToolPermission(toolName)
      if (permissionClass !== "read") {
        emit({
          event_type: "content_delta",
          thread_id: threadId,
          payload: { delta: `\n\n> ${PLAN_MODE_DENY_MESSAGE}\n\n` },
        })
        return { behavior: "deny" as const, reason: PLAN_MODE_DENY_MESSAGE }
      }
    }

    if (isAskMode) {
      const permissionClass = classifyToolPermission(toolName)
      if (permissionClass !== "read") {
        emit({
          event_type: "content_delta",
          thread_id: threadId,
          payload: { delta: `\n\n> ${ASK_MODE_DENY_MESSAGE}\n\n` },
        })
        return { behavior: "deny" as const, reason: ASK_MODE_DENY_MESSAGE }
      }
    }

    const projectRule = evaluateBetterC0deProjectToolPermission(
      projectPermissionRules,
      { toolName, toolInput }
    )
    if (projectRule?.action === "deny") {
      const reason = `BetterC0de project permission denied ${projectRule.permission}:${projectRule.pattern}.`
      emit({
        event_type: "content_delta",
        thread_id: threadId,
        payload: { delta: `\n\n> ${reason}\n\n` },
      })
      return { behavior: "deny" as const, reason }
    }

    const cls = classifyTool(toolName, toolInput)
    // Plan/Ask tools still pass project and durable policy. Safe question/plan
    // builtins are classified by the hard gate above, while network tools keep
    // the read-only policy's explicit egress approval.
    const ceilingDecision =
      (isPlanMode || isAskMode) && cls !== "egress"
        ? "allow"
        : evaluatePermission(
            isPlanMode || isAskMode
              ? "read-only"
              : isSecurityMode
                ? "ask-on-edit"
                : level,
            cls
          )
    // Repository policy may narrow a session (deny/ask), but must never
    // widen its immutable user/security ceiling. In particular, an `allow`
    // rule cannot turn read-only or Security mode into write/execute access.
    const decision =
      ceilingDecision === "deny"
        ? "deny"
        : projectRule?.action === "ask"
          ? "ask"
          : projectRule?.action === "allow" && ceilingDecision === "allow"
            ? "allow"
            : ceilingDecision

    if (decision === "allow") {
      return { behavior: "allow" as const }
    }

    if (decision === "deny") {
      const reason = describeBlock(level, toolName)
      emit({
        event_type: "content_delta",
        thread_id: threadId,
        payload: { delta: `\n\n> ${reason}\n\n` },
      })
      return { behavior: "deny" as const, reason }
    }

    // ask-on-edit: surface an approval request and wait on the renderer.
    const answer = await requestToolApproval(threadId, (requestId) => {
      emit({
        event_type: "tool_approval_requested",
        thread_id: threadId,
        payload: {
          providerKind: "anthropic_cli",
          requestId,
          tool: toolName,
          input: toolInput ?? {},
        },
      })
    })
    if (options.signal?.aborted)
      return { behavior: "deny", reason: "Turn cancelled." }
    if (answer === "approve") return { behavior: "allow" as const }
    const reason = describeBlock(level, toolName)
    emit({
      event_type: "content_delta",
      thread_id: threadId,
      payload: { delta: `\n\n> ${reason} (user denied)\n\n` },
    })
    return { behavior: "deny" as const, reason }
  }
}
