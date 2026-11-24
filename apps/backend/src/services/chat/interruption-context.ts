import { asRecord, readString } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { providerAssistantMessageId } from "../../provider/runtime/ProviderRuntimeIngestion"
import type { HistoryMessage, LegacyProviderEvent } from "../../provider/types"
import { autoSaveConversationsEnabled } from "./automatic-compaction"

const MAX_REMEMBERED_INTERRUPTED_CHATS = 1024
const MAX_CONTEXT_TEXT = 4_000
const MAX_CONTEXT_TOOLS = 12
const liveInterruptions = new WeakMap<AppState, Set<string>>()

function isInterrupted(
  eventType: string,
  payload: Record<string, unknown>
): boolean {
  const status = readString(payload, "status", "state")?.toLowerCase()
  return (
    status === "interrupted" ||
    status === "cancelled" ||
    status === "canceled" ||
    (eventType === "turn_interrupted" && status === undefined) ||
    (eventType === "turn.aborted" &&
      status === undefined &&
      payload.reason === "Interrupted by user.")
  )
}

/** Conversation state for live turns when saving is disabled. */
export function observeChatInterruption(
  state: AppState,
  event: LegacyProviderEvent
): void {
  if (
    event.event_type !== "turn_interrupted" &&
    event.event_type !== "turn.aborted" &&
    event.event_type !== "session.exited" &&
    event.event_type !== "turn_completed"
  )
    return
  let remembered = liveInterruptions.get(state)
  const interrupted = isInterrupted(event.event_type, event.payload)
  if (!interrupted && event.event_type === "session.exited") return
  if (!remembered) {
    if (!interrupted) return
    remembered = new Set()
    liveInterruptions.set(state, remembered)
  }
  remembered.delete(event.thread_id)
  if (!interrupted) return
  remembered.add(event.thread_id)
  if (remembered.size > MAX_REMEMBERED_INTERRUPTED_CHATS) {
    const oldest = remembered.values().next().value
    if (oldest !== undefined) remembered.delete(oldest)
  }
}

/** Bounded context for the next send, also read by providers that keep their own history. */
export function previousTurnInterruptionContext(
  state: AppState,
  threadId: string,
  history: ReadonlyArray<HistoryMessage>
): string | null {
  if (!autoSaveConversationsEnabled(state)) {
    if (!liveInterruptions.get(state)?.has(threadId)) return null
    let lastUser = history.length - 1
    while (lastUser >= 0 && history[lastUser]?.role !== "user") lastUser -= 1
    const assistant = history
      .slice(lastUser + 1)
      .reverse()
      .find((message) => message.role === "assistant")
    return formatContext({
      previousUserMessage: clipText(history[lastUser]?.content),
      partialAssistantResponse: clipText(assistant?.content),
    })
  }

  const interrupted =
    state.threadActivities.latestProviderTurnBoundary(threadId)
  if (!interrupted) return null
  const payload = asRecord(interrupted.payload)
  if (
    !isInterrupted(
      readString(payload, "eventType") ?? interrupted.kind,
      payload
    )
  )
    return null

  const dispatchTurnId =
    readString(payload, "dispatchTurnId", "dispatch_turn_id") ??
    interrupted.turn_id
  const dispatch = dispatchTurnId
    ? state.chatDispatches.getByProviderTurn(
        threadId,
        interrupted.provider_instance_id ?? null,
        dispatchTurnId
      )
    : null
  if (dispatch?.status === "reverted") return null
  const request = dispatch
    ? state.threads.getMessage(threadId, dispatch.messageId)
    : null
  const response = interrupted.turn_id
    ? state.threads.getMessage(
        threadId,
        providerAssistantMessageId(threadId, interrupted.turn_id)
      )
    : null

  return formatContext({
    previousUserMessage: clipText(
      dispatch
        ? request?.content
        : [...history].reverse().find((message) => message.role === "user")
            ?.content
    ),
    partialAssistantResponse: clipText(response?.content),
    tools: toolContext(response?.extra?.toolCalls),
  })
}

function clipText(text: string | undefined): string | undefined {
  if (!text) return undefined
  if (text.length <= MAX_CONTEXT_TEXT) return text
  return `${text.slice(0, MAX_CONTEXT_TEXT)}\n[Context truncated]`
}

function toolContext(
  rawCalls: unknown
): Array<{ name: string; status: string }> | undefined {
  if (!Array.isArray(rawCalls)) return undefined
  const tools = rawCalls.slice(-MAX_CONTEXT_TOOLS).flatMap((raw) => {
    const call = asRecord(raw)
    const name = readString(call, "name")?.slice(0, 120)
    if (!name) return []
    const status =
      call.state === "output-available"
        ? "completed"
        : call.state === "output-error"
          ? "failed"
          : "no confirmed outcome"
    return [{ name, status }]
  })
  return tools.length > 0 ? tools : undefined
}

function formatContext(context: {
  previousUserMessage?: string
  partialAssistantResponse?: string
  tools?: ReturnType<typeof toolContext>
}): string {
  const data = JSON.stringify(context)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
  return [
    "<betterc0de_interrupted_turn>",
    "The previous provider turn was interrupted. The JSON below is prior conversation data and may be partial. Follow the current user message. Verify the current state before repeating tool actions or assuming the previous task finished.",
    data,
    "</betterc0de_interrupted_turn>",
  ].join("\n")
}
