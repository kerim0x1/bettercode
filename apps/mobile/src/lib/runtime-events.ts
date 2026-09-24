import {
  permissionUpdateSchema,
  type PermissionUpdate,
} from "@betterc0de/schema"
import {
  threadActivityResponseSchema,
  threadMetadataUpdateSchema,
  type ThreadMetadataUpdate,
} from "@betterc0de/schema/http-contracts"
import { isRecord } from "@betterc0de/schema/json-read"
import type { PendingRequest, ThreadActivity } from "@/types/remote"

export interface DecodedRuntimeEvent {
  threadId: string
  type: string
  payload: Record<string, unknown>
  /** `null` when the event does not say; never guessed, so Stop cannot reach the wrong agent. */
  providerKind: string | null
  providerInstanceId: string | null
  turnId: string | null
  requestId: string | null
}

/**
 * A `thread.activity` frame: an activity the desktop just recorded, such as
 * an approval answered on the desktop. Unlike runtime events, these are not
 * replayed after a reconnect.
 */
export function decodeActivityFrame(frame: unknown): ThreadActivity | null {
  if (!isRecord(frame) || frame.channel !== "thread.activity") return null
  const parsed = threadActivityResponseSchema.safeParse(frame.data)
  return parsed.success ? parsed.data : null
}

/** A chat renamed on the desktop or another client (`thread.metadata`). */
export function decodeThreadMetadataFrame(
  frame: unknown
): ThreadMetadataUpdate | null {
  if (!isRecord(frame) || frame.channel !== "thread.metadata") return null
  const parsed = threadMetadataUpdateSchema.safeParse(frame.data)
  return parsed.success ? parsed.data : null
}

export function isReplayGapFrame(frame: unknown): boolean {
  return isRecord(frame) && frame.type === "provider_replay_gap"
}

export function decodeRuntimeFrame(frame: unknown): DecodedRuntimeEvent | null {
  if (!isRecord(frame) || frame.channel !== "provider.runtimeEvent") return null
  const data = isRecord(frame.data) ? frame.data : null
  if (!data) return null
  const type = stringValue(data.event_type) ?? stringValue(data.type)
  const threadId = stringValue(data.thread_id) ?? stringValue(data.threadId)
  if (!type || !threadId) return null
  const payload = isRecord(data.payload) ? { ...data, ...data.payload } : data
  return {
    threadId,
    type,
    payload,
    providerKind:
      stringValue(payload.providerKind) ??
      stringValue(payload.provider_kind) ??
      stringValue(data.providerKind) ??
      stringValue(data.provider) ??
      null,
    providerInstanceId:
      stringValue(payload.providerInstanceId) ??
      stringValue(payload.provider_instance_id) ??
      stringValue(data.providerInstanceId) ??
      null,
    turnId: stringValue(payload.turn_id) ?? stringValue(data.turnId) ?? null,
    requestId:
      stringValue(payload.requestId) ??
      stringValue(payload.request_id) ??
      stringValue(data.requestId) ??
      null,
  }
}

export function eventDelta(event: DecodedRuntimeEvent): string | null {
  if (
    !["content_delta", "content.delta", "message.delta"].includes(event.type)
  ) {
    return null
  }
  const streamKind = stringValue(event.payload.streamKind)
  if (streamKind?.startsWith("reasoning")) return null
  return typeof event.payload.delta === "string" ? event.payload.delta : null
}

export function reasoningDelta(event: DecodedRuntimeEvent): string | null {
  const streamKind = stringValue(event.payload.streamKind)
  if (
    event.type !== "reasoning_delta" &&
    event.type !== "reasoning.delta" &&
    !streamKind?.startsWith("reasoning")
  ) {
    return null
  }
  return typeof event.payload.delta === "string" ? event.payload.delta : null
}

/** Tools may first arrive as an ACP snapshot rather than a start event. */
export function runtimeToolId(event: DecodedRuntimeEvent): string | null {
  const itemType =
    stringValue(event.payload.itemType) ??
    stringValue(event.payload.item_type) ??
    ""
  const isTool =
    /^(?:tool[._](?:started|delta|completed|failed)|tool_call(?:_delta)?|tool_result)$/.test(
      event.type
    ) ||
    (/^item[._](?:started|updated|completed)$/.test(event.type) &&
      /command|tool|file|search|read|write|patch/i.test(itemType))
  if (!isTool) return null
  return (
    stringValue(event.payload.toolId) ??
    stringValue(event.payload.tool_id) ??
    stringValue(event.payload.itemId) ??
    stringValue(event.payload.item_id)
  )
}

export function replacementText(event: DecodedRuntimeEvent): {
  kind: "content" | "reasoning"
  text: string
} | null {
  if (
    ![
      "content.replace",
      "content_replace",
      "reasoning.replace",
      "reasoning_replace",
    ].includes(event.type)
  ) {
    return null
  }
  const text = event.payload.text
  if (typeof text !== "string") return null
  return {
    kind: event.type.startsWith("reasoning") ? "reasoning" : "content",
    text,
  }
}

export function isTurnStarted(type: string): boolean {
  return type === "turn_started" || type === "turn.started"
}

export function isTurnTerminal(type: string): boolean {
  return [
    "turn_completed",
    "turn.completed",
    "turn_interrupted",
    "turn.aborted",
    "turn_error",
    "runtime.error",
  ].includes(type)
}

export function terminalError(event: DecodedRuntimeEvent): string | null {
  if (!["turn_error", "runtime.error"].includes(event.type)) return null
  return (
    stringValue(event.payload.error) ??
    stringValue(event.payload.errorMessage) ??
    stringValue(event.payload.message) ??
    "Provider error"
  )
}

export function pendingRequestFromEvent(
  event: DecodedRuntimeEvent
): PendingRequest | null {
  const requestId = event.requestId
  if (!requestId) return null
  const requestType = stringValue(event.payload.requestType) ?? ""
  const requestKind =
    stringValue(event.payload.requestKind) ??
    stringValue(event.payload.kind) ??
    ""
  // The canonical lane opens every request as `request.opened` and tells
  // the kinds apart by `kind`, the same way the desktop routes them.
  const isUserInput =
    ["user_input_requested", "user-input.requested"].includes(event.type) ||
    (event.type === "request.opened" && requestKind === "user_input")
  const isPlan =
    event.type === "plan_approval_requested" ||
    requestType.includes("plan") ||
    requestKind.includes("plan")
  const isApproval =
    [
      "tool_approval_requested",
      "request.opened",
      "approval.requested",
    ].includes(event.type) && !isPlan
  if (!isUserInput && !isPlan && !isApproval) return null

  const detail =
    stringValue(event.payload.description) ??
    stringValue(event.payload.detail) ??
    stringValue(event.payload.decisionReason) ??
    stringValue(event.payload.blockedPath) ??
    undefined
  const planMarkdown =
    stringValue(event.payload.planMarkdown) ??
    stringValue(event.payload.plan_markdown) ??
    undefined
  const normalizedQuestions = isUserInput
    ? normalizeQuestions(event.payload.questions)
    : undefined
  const questions =
    isUserInput && normalizedQuestions?.length === 0
      ? [
          {
            id: requestId,
            question: detail ?? "Enter answer",
            options: [],
          },
        ]
      : normalizedQuestions
  return {
    id: requestId,
    threadId: event.threadId,
    kind: isUserInput ? "user-input" : isPlan ? "plan" : "approval",
    // Answering needs the provider; an event without one gets an empty kind,
    // which the desktop refuses, instead of a guessed provider.
    providerKind: event.providerKind ?? "",
    providerInstanceId: event.providerInstanceId,
    title: isUserInput
      ? "Input required"
      : isPlan
        ? "Approve plan"
        : (stringValue(event.payload.title) ??
          stringValue(event.payload.tool) ??
          stringValue(event.payload.toolName) ??
          stringValue(event.payload.detail) ??
          "Approve action"),
    detail: isPlan ? (planMarkdown ?? detail) : detail,
    input: isPlan ? undefined : (event.payload.input ?? event.payload.args),
    ...(isApproval
      ? {
          toolName:
            stringValue(event.payload.toolName) ??
            stringValue(event.payload.tool_name) ??
            stringValue(event.payload.tool) ??
            undefined,
          suggestions: permissionSuggestions(event.payload.suggestions),
        }
      : {}),
    questions,
  }
}

/**
 * The provider's "Always allow" suggestions that are well-formed. They are
 * only ever offered after `alwaysAllowRules` checked that each is scoped.
 */
function permissionSuggestions(value: unknown): PermissionUpdate[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value.flatMap((item) => {
    const parsed = permissionUpdateSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  return valid.length > 0 ? valid : undefined
}

export function resolvedRequestId(event: DecodedRuntimeEvent): string | null {
  if (
    [
      "tool_approval_resolved",
      "approval.resolved",
      "request.resolved",
      "user_input_resolved",
      "user-input.resolved",
      "plan_approval_resolved",
    ].includes(event.type)
  ) {
    return event.requestId
  }
  return null
}

function normalizeQuestions(value: unknown): PendingRequest["questions"] {
  if (!Array.isArray(value)) return []
  return value.map((raw, index) => {
    const question = isRecord(raw) ? raw : {}
    const rawOptions = Array.isArray(question.options) ? question.options : []
    return {
      id: stringValue(question.id) ?? `question-${index + 1}`,
      header: stringValue(question.header) ?? undefined,
      question:
        stringValue(question.question) ??
        stringValue(question.text) ??
        `Question ${index + 1}`,
      options: rawOptions.map((option) =>
        typeof option === "string"
          ? { label: option }
          : {
              label:
                stringValue(isRecord(option) ? option.label : null) ?? "Option",
              description:
                stringValue(isRecord(option) ? option.description : null) ??
                undefined,
            }
      ),
      multiSelect: question.multiSelect === true || question.multiple === true,
    }
  })
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}
