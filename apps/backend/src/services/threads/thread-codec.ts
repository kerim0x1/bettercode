import { isRecord } from "@betterc0de/schema"
import type { ThreadSaveMessage } from "./types"

export function serializeMessage(message: ThreadSaveMessage): string {
  return JSON.stringify({ text: message.content, extra: message.extra })
}

export function hydrateMessageRow(row: {
  message_id: string
  turn_id?: string | null
  role: string
  content_json: string
  created_at: string
}): Record<string, unknown> {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(row.content_json)
    if (isRecord(value)) parsed = value
  } catch {
    // Malformed row — render as empty content so the UI still lists it.
  }

  const extra = isRecord(parsed.extra) ? parsed.extra : {}
  const message: Record<string, unknown> = {
    id: row.message_id,
    role: row.role,
    content: typeof parsed.text === "string" ? parsed.text : "",
    createdAt: row.created_at,
  }

  if (typeof row.turn_id === "string" && row.turn_id)
    message.turnId = row.turn_id
  if (typeof extra.reasoning === "string" && extra.reasoning)
    message.reasoning = extra.reasoning
  if (
    typeof extra.reasoningDurationMs === "number" &&
    Number.isFinite(extra.reasoningDurationMs) &&
    extra.reasoningDurationMs >= 0
  ) {
    message.reasoningDurationMs = extra.reasoningDurationMs
  }
  if (extra.toolCalls != null) message.toolCalls = extra.toolCalls
  if (extra.questions != null) message.questions = extra.questions
  if (extra.answeredQuestions != null)
    message.answeredQuestions = extra.answeredQuestions
  if (extra.diffs != null) message.diffs = extra.diffs
  if (Array.isArray(extra.attachments) && extra.attachments.length > 0)
    message.attachments = extra.attachments
  if (extra.usage != null) message.usage = extra.usage
  if (typeof extra.modelId === "string" && extra.modelId)
    message.modelId = extra.modelId
  if (
    typeof extra.systemInstructionCharacters === "number" &&
    Number.isInteger(extra.systemInstructionCharacters) &&
    extra.systemInstructionCharacters >= 0
  ) {
    message.systemInstructionCharacters = extra.systemInstructionCharacters
  }
  if (extra.compactedContext === true) message.compactedContext = true
  if (extra.internalContext === "provider-handoff")
    message.internalContext = "provider-handoff"
  // A message the backend sent by itself to resume the chat (resume-scheduler.ts).
  if (extra.automatic === "usage-limit" || extra.automatic === "restart")
    message.automatic = extra.automatic
  if (extra.transcriptTruncated === true) message.transcriptTruncated = true
  if (
    extra.dispatchStatus === "pending" ||
    extra.dispatchStatus === "accepted" ||
    extra.dispatchStatus === "completed" ||
    extra.dispatchStatus === "failed" ||
    extra.dispatchStatus === "uncertain" ||
    extra.dispatchStatus === "reverted"
  ) {
    message.dispatchStatus = extra.dispatchStatus
  }
  if (extra.dispatchFailed === true) message.dispatchFailed = true
  if (
    typeof extra.compactionGeneration === "number" &&
    Number.isInteger(extra.compactionGeneration) &&
    extra.compactionGeneration >= 0
  ) {
    message.compactionGeneration = extra.compactionGeneration
  }

  return message
}
