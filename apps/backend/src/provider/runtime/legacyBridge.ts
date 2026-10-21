import { asRecord } from "@betterc0de/schema"
import type { ProviderRuntimeEvent } from "./contracts"
import type { LegacyProviderEvent } from "../types"
import { providerKindFromDriver } from "./providerKindAliases"

// The legacy shape has one definition (provider/types.ts); this re-export
// keeps the `provider/runtime` import path that callers already use.
export type { LegacyProviderEvent }

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function legacyProviderFields(
  event: ProviderRuntimeEvent
): Record<string, unknown> {
  const payload = asRecord("payload" in event ? event.payload : undefined)
  const provider = asString("provider" in event ? event.provider : undefined)
  const providerKind =
    providerKindFromDriver(
      asString("providerKind" in event ? event.providerKind : undefined)
    ) ?? providerKindFromDriver(provider)
  const correlation = {
    sessionId:
      asString(event.sessionId) ??
      asString(payload.sessionId) ??
      asString(payload.session_id),
    taskId:
      asString(event.taskId) ??
      asString(payload.taskId) ??
      asString(payload.task_id),
    parentTaskId:
      asString(event.parentTaskId) ??
      asString(payload.parentTaskId) ??
      asString(payload.parent_task_id),
    agentId:
      asString(event.agentId) ??
      asString(payload.agentId) ??
      asString(payload.agent_id),
    parentAgentId:
      asString(event.parentAgentId) ??
      asString(payload.parentAgentId) ??
      asString(payload.parent_agent_id),
    parentEventId:
      asString(event.parentEventId) ??
      asString(payload.parentEventId) ??
      asString(payload.parent_event_id),
    parentToolId:
      asString(event.parentToolId) ??
      asString(payload.parentToolId) ??
      asString(payload.parent_tool_id),
  }
  return {
    ...(provider ? { provider } : {}),
    ...(providerKind ? { providerKind } : {}),
    ...(event.providerInstanceId
      ? { providerInstanceId: event.providerInstanceId }
      : {}),
    ...Object.fromEntries(
      Object.entries(correlation).filter(([, value]) => value !== undefined)
    ),
  }
}

function isCanonicalToolLifecycleItemType(value: string | undefined): boolean {
  switch ((value ?? "").toLowerCase()) {
    case "command_execution":
    case "file_change":
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
    case "web_search":
    case "image_view":
      return true
    default:
      return false
  }
}

function itemPayload(event: ProviderRuntimeEvent): Record<string, unknown> {
  return asRecord("payload" in event ? event.payload : undefined)
}

function rawItemPayload(event: ProviderRuntimeEvent): unknown {
  return "payload" in event ? event.payload : undefined
}

function itemPayloadData(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return asRecord(payload.data)
}

function itemKind(event: ProviderRuntimeEvent): string | undefined {
  const payload = itemPayload(event)
  return (
    asString("kind" in event ? event.kind : undefined) ??
    asString(payload.itemType)
  )
}

function itemId(event: ProviderRuntimeEvent): string {
  return (
    asString("itemId" in event ? event.itemId : undefined) ??
    asString(event.eventId) ??
    "item"
  )
}

function itemToolName(
  kind: string | undefined,
  payload: Record<string, unknown>
): string {
  if (kind?.startsWith("tool:")) return kind.slice("tool:".length)
  const data = itemPayloadData(payload)
  return (
    asString(data.toolName) ??
    asString(data.tool_name) ??
    asString(data.name) ??
    asString(payload.title) ??
    asString(payload.itemType) ??
    "tool"
  )
}

function itemInput(
  payload: Record<string, unknown>,
  raw?: unknown,
  options?: { detailFallback?: boolean; emptyFallback?: boolean }
): unknown {
  const data = itemPayloadData(payload)
  if (payload.input !== undefined) return payload.input
  if (data.input !== undefined) return data.input
  if (data.rawInput !== undefined) return data.rawInput
  if (data.raw_input !== undefined) return data.raw_input
  if (payload.data !== undefined) return payload.data
  if (
    options?.detailFallback !== false &&
    payload.itemType === "command_execution" &&
    typeof payload.detail === "string"
  ) {
    return { command: payload.detail }
  }
  if (
    payload.itemType === undefined &&
    raw !== undefined &&
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw)
  ) {
    return raw
  }
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) return raw
  if (options?.emptyFallback === false) return undefined
  return {}
}

function itemOutput(payload: Record<string, unknown>, raw?: unknown): unknown {
  const data = itemPayloadData(payload)
  if (payload.output !== undefined) return payload.output
  if (payload.result !== undefined) return payload.result
  if (data.output !== undefined) return data.output
  if (data.result !== undefined) return data.result
  if (data.rawOutput !== undefined) return data.rawOutput
  if (data.raw_output !== undefined) return data.raw_output
  if (payload.data !== undefined) return payload.data
  if (payload.detail !== undefined) return payload.detail
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) return raw
  return payload
}

function isToolItem(
  kind: string | undefined,
  payload: Record<string, unknown>
): boolean {
  return (
    kind?.startsWith("tool:") === true ||
    isCanonicalToolLifecycleItemType(asString(payload.itemType))
  )
}

function eventPayloadRecord(
  event: ProviderRuntimeEvent
): Record<string, unknown> {
  return asRecord("payload" in event ? event.payload : undefined)
}

function eventStreamKind(event: ProviderRuntimeEvent): string | undefined {
  const payload = eventPayloadRecord(event)
  return (
    asString("streamKind" in event ? event.streamKind : undefined) ??
    asString(payload.streamKind)
  )
}

function eventDelta(event: ProviderRuntimeEvent): string {
  const payload = eventPayloadRecord(event)
  return (
    asString("delta" in event ? event.delta : undefined) ??
    asString(payload.delta) ??
    ""
  )
}

function eventText(event: ProviderRuntimeEvent): string {
  const payload = eventPayloadRecord(event)
  return (
    asString("text" in event ? event.text : undefined) ??
    asString(payload.text) ??
    ""
  )
}

function eventToolId(event: ProviderRuntimeEvent): string {
  const payload = eventPayloadRecord(event)
  return (
    asString("toolId" in event ? event.toolId : undefined) ??
    asString(payload.toolId) ??
    asString(payload.tool_id) ??
    event.eventId
  )
}

function eventToolName(event: ProviderRuntimeEvent): string {
  const payload = eventPayloadRecord(event)
  return (
    asString("toolName" in event ? event.toolName : undefined) ??
    asString(payload.toolName) ??
    asString(payload.tool_name) ??
    asString("title" in event ? event.title : undefined) ??
    asString(payload.title) ??
    asString("toolKind" in event ? event.toolKind : undefined) ??
    asString(payload.toolKind) ??
    "tool"
  )
}

function eventToolDetail(event: ProviderRuntimeEvent): string | undefined {
  const payload = eventPayloadRecord(event)
  return (
    asString("detail" in event ? event.detail : undefined) ??
    asString(payload.detail)
  )
}

function eventToolPayloadValue(
  event: ProviderRuntimeEvent,
  key: "input" | "output"
): unknown {
  const payload = eventPayloadRecord(event)
  const record = event as unknown as Record<string, unknown>
  if (record[key] !== undefined) return record[key]
  if (payload[key] !== undefined) return payload[key]
  const detail = eventToolDetail(event)
  return detail ? { detail } : {}
}

function eventTurnStatus(event: ProviderRuntimeEvent): string {
  const payload = eventPayloadRecord(event)
  return (
    asString("status" in event ? event.status : undefined) ??
    asString(payload.state) ??
    "completed"
  )
}

function eventTurnError(event: ProviderRuntimeEvent): string | undefined {
  const payload = eventPayloadRecord(event)
  return (
    asString("error" in event ? event.error : undefined) ??
    asString(payload.errorMessage) ??
    asString(payload.error)
  )
}

export function canonicalToLegacy(
  event: ProviderRuntimeEvent
): LegacyProviderEvent | null {
  const threadId = event.threadId
  const providerFields = legacyProviderFields(event)
  switch (event.type) {
    case "message.delta":
    case "content.delta": {
      const streamKind =
        event.type === "message.delta"
          ? (eventStreamKind(event) ?? "assistant_text")
          : eventStreamKind(event)
      const delta = eventDelta(event)
      if (streamKind === "assistant_text") {
        return {
          event_type: "content_delta",
          thread_id: threadId,
          payload: {
            ...providerFields,
            delta,
            streamKind,
            turn_id: event.turnId,
          },
        }
      }
      if (
        streamKind === "command_output" ||
        streamKind === "file_change_output" ||
        streamKind === "plan_delta" ||
        streamKind === "plan_text" ||
        streamKind === "unknown"
      ) {
        return {
          event_type: "content_delta",
          thread_id: threadId,
          payload: {
            ...providerFields,
            delta,
            streamKind,
            turn_id: event.turnId,
          },
        }
      }
      if (
        streamKind === "reasoning_text" ||
        streamKind === "reasoning_summary_text"
      ) {
        return {
          event_type: "reasoning_delta",
          thread_id: threadId,
          payload: {
            ...providerFields,
            delta,
            streamKind,
            turn_id: event.turnId,
          },
        }
      }
      return null
    }
    case "content.replace": {
      const streamKind = eventStreamKind(event)
      const text = eventText(event)
      if (!streamKind || streamKind === "assistant_text") {
        return {
          event_type: "content_replace",
          thread_id: threadId,
          payload: {
            ...providerFields,
            text,
            turn_id: event.turnId,
          },
        }
      }
      if (
        streamKind === "reasoning_text" ||
        streamKind === "reasoning_summary_text"
      ) {
        return {
          event_type: "reasoning_replace",
          thread_id: threadId,
          payload: {
            ...providerFields,
            text,
            streamKind,
            turn_id: event.turnId,
          },
        }
      }
      return null
    }
    case "reasoning.delta":
      return {
        event_type: "reasoning_delta",
        thread_id: threadId,
        payload: {
          ...providerFields,
          delta: eventDelta(event),
          streamKind: eventStreamKind(event),
          turn_id: event.turnId,
        },
      }
    case "reasoning.replace":
      return {
        event_type: "reasoning_replace",
        thread_id: threadId,
        payload: {
          ...providerFields,
          text: eventText(event),
          streamKind: eventStreamKind(event),
          turn_id: event.turnId,
        },
      }
    case "turn.started":
      return {
        event_type: "turn_started",
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...eventPayloadRecord(event),
          turn_id: event.turnId,
        },
      }
    case "turn.completed": {
      const status = eventTurnStatus(event)
      const payload = eventPayloadRecord(event)
      if (status === "completed") {
        return {
          event_type: "turn_completed",
          thread_id: threadId,
          payload: {
            ...providerFields,
            ...payload,
            status,
            turn_id: event.turnId,
          },
        }
      }
      if (status === "interrupted" || status === "cancelled") {
        return {
          event_type: "turn_interrupted",
          thread_id: threadId,
          payload: {
            ...providerFields,
            ...payload,
            status,
            turn_id: event.turnId,
          },
        }
      }
      if (status === "failed") {
        return {
          event_type: "turn_error",
          thread_id: threadId,
          payload: {
            ...providerFields,
            ...payload,
            status,
            error: eventTurnError(event) ?? "Turn failed",
            turn_id: event.turnId,
          },
        }
      }
      return {
        event_type: "turn_completed",
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...payload,
          status,
          turn_id: event.turnId,
        },
      }
    }
    case "token.usage":
      return {
        event_type: "token_usage",
        thread_id: threadId,
        payload: {
          ...providerFields,
          turn_id: event.turnId,
          usage: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            usedTokens: event.usage.totalTokens,
            ...(event.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: event.usage.cachedInputTokens }
              : {}),
            ...(event.usage.cacheReadTokens !== undefined
              ? { cacheReadTokens: event.usage.cacheReadTokens }
              : {}),
            ...(event.usage.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: event.usage.cacheCreationTokens }
              : {}),
            ...(event.usage.reasoningOutputTokens !== undefined
              ? {
                  reasoningOutputTokens: event.usage.reasoningOutputTokens,
                }
              : {}),
            ...(event.usage.toolUses !== undefined
              ? { toolUses: event.usage.toolUses }
              : {}),
            ...(event.usage.durationMs !== undefined
              ? { durationMs: event.usage.durationMs }
              : {}),
            ...(event.usage.totalCostUsd !== undefined
              ? { totalCostUsd: event.usage.totalCostUsd }
              : {}),
            ...(event.usage.compactsAutomatically !== undefined
              ? {
                  compactsAutomatically: event.usage.compactsAutomatically,
                }
              : {}),
          },
        },
      }
    case "request.opened":
      if (event.kind === "plan_approval") {
        const requestId = event.requestId ?? event.eventId
        return {
          event_type: "plan_approval_requested",
          thread_id: threadId,
          payload: {
            ...providerFields,
            requestId,
            planMarkdown: event.planMarkdown ?? "",
            event_id: event.eventId,
            turn_id: event.turnId,
          },
        }
      }
      if (event.kind === "tool_approval") {
        const requestId = event.requestId ?? event.eventId
        return {
          event_type: "tool_approval_requested",
          thread_id: threadId,
          payload: {
            ...providerFields,
            requestId,
            tool: event.tool ?? "",
            input: event.input ?? {},
            ...(event.title ? { title: event.title } : {}),
            ...(event.description ? { description: event.description } : {}),
            ...(event.decisionReason
              ? { decisionReason: event.decisionReason }
              : {}),
            ...(event.blockedPath ? { blockedPath: event.blockedPath } : {}),
            ...(event.suggestions ? { suggestions: event.suggestions } : {}),
            event_id: event.eventId,
            turn_id: event.turnId,
          },
        }
      }
      if (event.kind === "user_input") {
        const requestId = event.requestId ?? event.eventId
        return {
          event_type: "user_input_requested",
          thread_id: threadId,
          payload: {
            ...providerFields,
            requestId,
            questions: event.questions ?? [],
            event_id: event.eventId,
            turn_id: event.turnId,
          },
        }
      }
      if (event.payload?.requestType === "tool_user_input") return null
      if (event.payload?.requestType) {
        const requestId = event.requestId ?? event.eventId
        return {
          event_type: "tool_approval_requested",
          thread_id: threadId,
          payload: {
            ...providerFields,
            requestId,
            requestType: event.payload.requestType,
            tool:
              event.tool ?? event.payload.detail ?? event.payload.requestType,
            input: event.input ?? event.payload.args ?? {},
            event_id: event.eventId,
            turn_id: event.turnId,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
        }
      }
      return {
        event_type: "user_input_requested",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId: event.requestId ?? event.eventId,
          questions: event.questions ?? [],
          event_id: event.eventId,
          turn_id: event.turnId,
        },
      }
    case "approval.requested": {
      const payload = eventPayloadRecord(event)
      const requestId = event.requestId ?? event.eventId
      const requestKind =
        asString("requestKind" in event ? event.requestKind : undefined) ??
        asString(payload.requestKind) ??
        asString(payload.requestType) ??
        "approval"
      const detail =
        asString("detail" in event ? event.detail : undefined) ??
        asString(payload.detail)
      return {
        event_type: "tool_approval_requested",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId,
          requestType: requestKind,
          tool:
            asString("tool" in event ? event.tool : undefined) ??
            asString(payload.tool) ??
            detail ??
            requestKind,
          input:
            "input" in event && event.input !== undefined
              ? event.input
              : (payload.input ?? payload.args ?? {}),
          event_id: event.eventId,
          turn_id: event.turnId,
          ...(detail ? { detail } : {}),
        },
      }
    }
    case "approval.resolved": {
      const payload = eventPayloadRecord(event)
      const decision =
        asString("decision" in event ? event.decision : undefined) ??
        asString(payload.decision) ??
        "resolved"
      return {
        event_type: "tool_approval_resolved",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId: event.requestId ?? event.eventId,
          decision,
          event_id: event.eventId,
          turn_id: event.turnId,
        },
      }
    }
    case "request.resolved": {
      const requestId = event.requestId ?? event.eventId
      const decision = event.decision ?? event.payload?.decision ?? "resolved"
      if (event.payload?.requestType === "tool_user_input") return null
      if (event.requestKind === "plan_approval") {
        return {
          event_type: "plan_approval_resolved",
          thread_id: threadId,
          payload: {
            ...providerFields,
            requestId,
            decision,
            requestKind: "plan_approval",
            ...(event.permissionMode
              ? { permissionMode: event.permissionMode }
              : {}),
            ...(event.message ? { message: event.message } : {}),
            event_id: event.eventId,
            turn_id: event.turnId,
          },
        }
      }
      return {
        event_type:
          decision === "answer"
            ? "user_input_resolved"
            : "tool_approval_resolved",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId,
          decision,
          event_id: event.eventId,
          turn_id: event.turnId,
          ...(event.payload?.requestType
            ? { requestType: event.payload.requestType }
            : {}),
          ...(event.payload?.resolution !== undefined
            ? { resolution: event.payload.resolution }
            : {}),
        },
      }
    }
    case "user-input.requested":
      return {
        event_type: "user_input_requested",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId: event.requestId,
          questions: event.payload.questions,
          turn_id: event.turnId,
        },
      }
    case "user-input.resolved":
      return {
        event_type: "user_input_resolved",
        thread_id: threadId,
        payload: {
          ...providerFields,
          requestId: event.requestId,
          decision: "answer",
          answers: event.payload.answers,
          turn_id: event.turnId,
        },
      }
    case "session.started": {
      const payload = eventPayloadRecord(event)
      const message = asString("message" in event ? event.message : undefined)
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...payload,
          ...(message ? { message } : {}),
          ...("resume" in event && event.resume !== undefined
            ? { resume: event.resume }
            : {}),
          turn_id: event.turnId,
        },
      }
    }
    case "session.configured":
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...eventPayloadRecord(event),
          turn_id: event.turnId,
        },
      }
    case "session.exited": {
      const payload = eventPayloadRecord(event)
      const reason = asString("reason" in event ? event.reason : undefined)
      const exitKind = asString(
        "exitKind" in event ? event.exitKind : undefined
      )
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...payload,
          ...(reason ? { reason } : {}),
          ...("recoverable" in event && typeof event.recoverable === "boolean"
            ? { recoverable: event.recoverable }
            : {}),
          ...(exitKind ? { exitKind } : {}),
          turn_id: event.turnId,
        },
      }
    }
    case "session.state.changed": {
      const payload: Record<string, unknown> =
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
          ? event.payload
          : {}
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...payload,
          ...("reason" in event && typeof event.reason === "string"
            ? { reason: event.reason }
            : {}),
          ...("detail" in event && event.detail !== undefined
            ? { detail: event.detail }
            : {}),
          ...(event.status ? { status: event.status } : {}),
          state:
            typeof payload.state === "string"
              ? payload.state
              : "state" in event && typeof event.state === "string"
                ? event.state
                : (event.status ?? "ready"),
          turn_id: event.turnId,
        },
      }
    }
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "hook.started":
    case "hook.progress":
    case "hook.completed":
    case "pipeline.run.started":
    case "pipeline.step.started":
    case "pipeline.step.completed":
    case "pipeline.run.paused":
    case "pipeline.run.resumed":
    case "pipeline.run.completed":
    case "tool.summary":
    case "auth.status":
    case "account.updated":
    case "account.rate-limits.updated":
    case "mcp.status.updated":
    case "mcp.oauth.completed":
    case "model.rerouted":
    case "config.warning":
    case "provider.metadata.changed":
    case "deprecation.notice":
    case "files.persisted":
    case "thread.started":
    case "thread.state.changed":
    case "thread.metadata.updated":
    case "thread.token-usage.updated":
    case "thread.realtime.started":
    case "thread.realtime.item-added":
    case "thread.realtime.audio.delta":
    case "thread.realtime.error":
    case "thread.realtime.closed":
    case "turn.aborted":
    case "turn.plan.updated":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
    case "turn.diff.updated":
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...event.payload,
          ...(event.itemId
            ? { itemId: event.itemId, item_id: event.itemId }
            : {}),
          ...(event.type === "turn.diff.updated" ||
          event.type === "turn.proposed.delta" ||
          event.type === "turn.proposed.completed"
            ? { event_id: event.eventId }
            : {}),
          turn_id: event.turnId,
        },
      }
    case "item.updated": {
      const kind = itemKind(event)
      const payload = itemPayload(event)
      const raw = rawItemPayload(event)
      if (isToolItem(kind, payload)) {
        // An item update is a snapshot, never a chunk: ACP mirrors the whole
        // `detail` so far, and Codex's `patchUpdated` puts the whole patch in
        // `output`. Marking it lets consumers replace instead of append
        // without comparing strings (the `detail === output_delta` rule
        // stays for older journal rows).
        const outputSnapshot = asString(payload.output)
        return {
          event_type: "tool_call_delta",
          thread_id: threadId,
          payload: {
            ...providerFields,
            tool_id: itemId(event),
            tool_name: itemToolName(kind, payload),
            output_delta: outputSnapshot ?? payload.detail,
            ...(outputSnapshot !== undefined ? { cumulative: true } : {}),
            input: itemInput(payload, raw, {
              detailFallback: false,
              emptyFallback: false,
            }),
            ...(payload.itemType ? { itemType: payload.itemType } : {}),
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.detail ? { detail: payload.detail } : {}),
            ...(payload.data !== undefined ? { data: payload.data } : {}),
            // The item is already flattened above; nesting it again under
            // `item` doubled every progress frame on the wire (and in the
            // journal). Clients fall back to the flat payload when absent.
            turn_id: event.turnId,
          },
        }
      }
      return {
        event_type: "item.updated",
        thread_id: threadId,
        payload: {
          ...providerFields,
          itemId: itemId(event),
          ...(kind ? { kind } : {}),
          ...payload,
          turn_id: event.turnId,
        },
      }
    }
    case "tool.progress":
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...event.payload,
          tool_id: event.payload.toolUseId,
          tool_name: event.payload.toolName,
          output_delta: event.payload.summary,
          turn_id: event.turnId,
        },
      }
    case "tool.started": {
      const title =
        asString("title" in event ? event.title : undefined) ??
        asString(eventPayloadRecord(event).title)
      const detail = eventToolDetail(event)
      return {
        event_type: "tool_call",
        thread_id: threadId,
        payload: {
          ...providerFields,
          tool_id: eventToolId(event),
          tool_name: eventToolName(event),
          input: eventToolPayloadValue(event, "input"),
          ...(title ? { title } : {}),
          ...(detail ? { detail } : {}),
          started_at: event.at,
          turn_id: event.turnId,
        },
      }
    }
    case "tool.delta":
      return {
        event_type: "tool_call_delta",
        thread_id: threadId,
        payload: {
          ...providerFields,
          tool_id: event.toolId,
          tool_name: event.toolName,
          output_delta: event.delta,
          streamKind: event.streamKind,
          turn_id: event.turnId,
        },
      }
    case "tool.completed": {
      const title =
        asString("title" in event ? event.title : undefined) ??
        asString(eventPayloadRecord(event).title)
      const detail = eventToolDetail(event)
      return {
        event_type: "tool_result",
        thread_id: threadId,
        payload: {
          ...providerFields,
          tool_id: eventToolId(event),
          tool_name: eventToolName(event),
          output: eventToolPayloadValue(event, "output"),
          ...(title ? { title } : {}),
          ...(detail ? { detail } : {}),
          completed_at: event.at,
          turn_id: event.turnId,
        },
      }
    }
    case "tool.failed":
      return {
        event_type: "tool_result",
        thread_id: threadId,
        payload: {
          ...providerFields,
          tool_id: event.toolId,
          tool_name: event.toolName,
          output: event.output ?? event.error,
          error: event.error,
          completed_at: event.at,
          turn_id: event.turnId,
        },
      }
    case "tool.denied":
      return {
        event_type: event.type,
        thread_id: threadId,
        payload: {
          ...providerFields,
          ...event.payload,
          ...(event.payload.toolUseId
            ? { tool_id: event.payload.toolUseId }
            : {}),
          tool_name: event.payload.toolName,
          event_id: event.eventId,
          ...(event.createdAt ? { created_at: event.createdAt } : {}),
          ...(event.payload.reason ? { detail: event.payload.reason } : {}),
          turn_id: event.turnId,
        },
      }
    case "item.started": {
      const kind = itemKind(event)
      const payload = itemPayload(event)
      const raw = rawItemPayload(event)
      if (isToolItem(kind, payload)) {
        return {
          event_type: "tool_call",
          thread_id: threadId,
          payload: {
            ...providerFields,
            tool_id: itemId(event),
            tool_name: itemToolName(kind, payload),
            input: itemInput(payload, raw),
            ...(payload.itemType ? { itemType: payload.itemType } : {}),
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.detail ? { detail: payload.detail } : {}),
            ...(payload.data !== undefined ? { data: payload.data } : {}),
            item: event.payload,
            started_at: event.at,
            turn_id: event.turnId,
          },
        }
      }
      return null
    }
    case "item.completed": {
      const kind = itemKind(event)
      const payload = itemPayload(event)
      const raw = rawItemPayload(event)
      if (isToolItem(kind, payload)) {
        return {
          event_type: "tool_result",
          thread_id: threadId,
          payload: {
            ...providerFields,
            tool_id: itemId(event),
            tool_name: itemToolName(kind, payload),
            output: itemOutput(payload, raw),
            ...(payload.itemType ? { itemType: payload.itemType } : {}),
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.detail ? { detail: payload.detail } : {}),
            ...(payload.data !== undefined ? { data: payload.data } : {}),
            item: event.payload,
            completed_at: event.at,
            turn_id: event.turnId,
          },
        }
      }
      // Keep the existing envelope for non-tool items so any future
      // renderer handler can opt-in without another bridge edit.
      return {
        event_type: "item.completed",
        thread_id: threadId,
        payload: {
          ...providerFields,
          itemId: itemId(event),
          ...(kind ? { kind } : {}),
          ...payload,
          item: event.payload,
          turn_id: event.turnId,
        },
      }
    }
    case "runtime.warning": {
      const payload = itemPayload(event)
      const message =
        asString("message" in event ? event.message : undefined) ??
        asString(payload.message) ??
        "Provider runtime warning"
      const detail =
        "detail" in event && event.detail !== undefined
          ? event.detail
          : payload.detail
      return {
        event_type: "turn_warning",
        thread_id: threadId,
        payload: {
          ...providerFields,
          error: message,
          willRetry: event.willRetry,
          event_id: event.eventId,
          ...(detail !== undefined ? { detail } : {}),
          turn_id: event.turnId,
        },
      }
    }
    case "runtime.error": {
      const payload = itemPayload(event)
      const message =
        asString("message" in event ? event.message : undefined) ??
        asString(payload.message) ??
        "Provider runtime error"
      const errorClass =
        asString("class" in event ? event.class : undefined) ??
        asString(payload.class)
      const detail =
        "detail" in event && event.detail !== undefined
          ? event.detail
          : payload.detail
      return {
        event_type: "turn_error",
        thread_id: threadId,
        payload: {
          ...providerFields,
          error: message,
          ...(errorClass ? { class: errorClass } : {}),
          event_id: event.eventId,
          ...(detail !== undefined ? { detail } : {}),
          turn_id: event.turnId,
        },
      }
    }
    default:
      return null
  }
}
