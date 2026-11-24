import type { ProviderRuntimeEvent } from "../../contracts"
import type { CodexNativeEvent } from "../CodexSessionRuntime"
import {
  base,
  normalizeUserInputQuestions,
  normalizeMcpElicitationQuestions,
  readTurnId,
} from "./shared"

/**
 * Child-process level events: stderr, exit, spawn failures and the server
 * requests Codex raises before any notification method exists.
 *
 * Returns the translated events, or null when the notification is not one
 * of this family's.
 */
export function translateProcessEvents(
  threadId: string,
  native: CodexNativeEvent
): ProviderRuntimeEvent[] | null {
  const out: ProviderRuntimeEvent[] = []

  if (native.kind === "stderr") {
    const s = native.stderr!
    if (s.fatal) {
      out.push({
        ...base(threadId),
        type: "runtime.error",
        message: "Codex provider transport failed.",
        class: "transport_error",
      })
    } else if (s.level === "error" || s.level === "warn") {
      out.push({
        ...base(threadId),
        type: "runtime.warning",
        message: "Codex provider reported a process warning.",
        willRetry: false,
      })
    }
    return out
  }
  if (native.kind === "child-exit") {
    out.push({
      ...base(threadId),
      type: "session.state.changed",
      status: native.exit?.code === 0 ? "closed" : "error",
    })
    return out
  }
  if (native.kind === "spawn-error") {
    out.push({
      ...base(threadId),
      type: "runtime.error",
      message: "Codex provider process could not be started.",
      class: "transport_error",
    })
    return out
  }
  if (native.kind === "child-error") {
    out.push({
      ...base(threadId),
      type: "runtime.error",
      // The runtime already picked a user-safe message (a refused approval
      // reply says so explicitly); only a missing one falls back to generic.
      message: native.error || "Codex provider connection lost.",
      class: "transport_error",
    })
    return out
  }
  if (native.kind === "server-request") {
    const method = native.method!
    const params = (native.params ?? {}) as Record<string, unknown>
    const requestId = native.requestId ?? ""
    const turnId = readTurnId(params)
    const request = { ...base(threadId), ...(turnId ? { turnId } : {}) }
    if (method === "item/commandExecution/requestApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "shell",
        input: { command: params.command, cwd: params.cwd },
      })
    } else if (method === "item/fileChange/requestApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "file_edit",
        input: { changes: params.changes },
      })
    } else if (method === "item/fileRead/requestApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "file_read",
        input: { path: params.path },
      })
    } else if (method === "item/permissions/requestApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "permissions",
        input: {
          cwd: params.cwd,
          permissions: params.permissions,
          reason: params.reason,
        },
      })
    } else if (method === "applyPatchApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "apply_patch",
        input: params,
      })
    } else if (method === "execCommandApproval") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "tool_approval",
        tool: "shell",
        input: params,
      })
    } else if (
      method === "tool/requestUserInput" ||
      method === "item/tool/requestUserInput"
    ) {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "user_input",
        questions: normalizeUserInputQuestions(params.questions),
      })
    } else if (method === "mcpServer/elicitation/request") {
      out.push({
        ...request,
        type: "request.opened",
        requestId,
        kind: "user_input",
        questions: normalizeMcpElicitationQuestions(params),
      })
    }
    return out
  }

  return null
}
