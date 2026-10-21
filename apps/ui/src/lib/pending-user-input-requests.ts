import { nonEmptyString } from "@betterc0de/schema/json-read"
import { asRecord } from "@betterc0de/schema"
import {
  derivePendingRequests,
  type PendingProviderRequest,
} from "@betterc0de/schema/pending-requests"
import type { ThreadActivity } from "@/lib/chat-store"

/**
 * Pending provider `user_input` requests (AskUserQuestion) of a thread, for
 * the questions panel and the attention system — keeping the question
 * `header` (chip label). Which requests are open is derived by
 * `derivePendingRequests`, shared with the phone; this module only maps
 * them to the panel's questions.
 */

export type PanelQuestion = {
  id: string
  text: string
  /** Short chip label from AskUserQuestion (e.g. "Auth method"). */
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export type PendingProviderUserInput = {
  requestId: string
  providerKind: string
  providerInstanceId?: string
  questions: PanelQuestion[]
  createdAt: string
}

function normalizeQuestionOptions(raw: unknown): PanelQuestion["options"] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((option) => {
      if (typeof option === "string") return { label: option }
      const record = asRecord(option)
      const label = nonEmptyString(record.label)
      if (!label) return null
      const description = nonEmptyString(record.description)
      return description ? { label, description } : { label }
    })
    .filter(
      (option): option is { label: string; description?: string } =>
        option !== null
    )
}

export function normalizeProviderQuestion(
  raw: unknown,
  index: number
): PanelQuestion | null {
  const record = asRecord(raw)
  const header = nonEmptyString(record.header)
  const text =
    nonEmptyString(record.question) ??
    nonEmptyString(record.text) ??
    header ??
    `Question ${index + 1}`
  const id =
    nonEmptyString(record.id) ?? nonEmptyString(record.question) ?? text
  return {
    id,
    text,
    ...(header ? { header } : {}),
    options: normalizeQuestionOptions(record.options),
    ...(typeof record.multiSelect === "boolean"
      ? { multiSelect: record.multiSelect }
      : {}),
  }
}

/**
 * The request's questions. A request that carries none still waits for an
 * answer, so it asks for one free-text answer keyed by the request id, as
 * the phone does.
 */
function panelQuestions(request: PendingProviderRequest): PanelQuestion[] {
  const { payload } = request
  const questions = Array.isArray(payload.questions)
    ? payload.questions
        .map((question, index) => normalizeProviderQuestion(question, index))
        .filter((question): question is PanelQuestion => question !== null)
    : []
  if (questions.length > 0) return questions
  return [
    {
      id: request.requestId,
      text:
        nonEmptyString(payload.description) ??
        nonEmptyString(payload.detail) ??
        nonEmptyString(request.activity.summary) ??
        "Enter answer",
      options: [],
    },
  ]
}

export function derivePendingProviderUserInputs(
  activities: ThreadActivity[]
): PendingProviderUserInput[] {
  return derivePendingRequests(activities, { kinds: ["user-input"] }).map(
    (request) => ({
      requestId: request.requestId,
      providerKind: request.providerKind ?? "claude",
      providerInstanceId: request.providerInstanceId,
      questions: panelQuestions(request),
      createdAt: request.createdAt,
    })
  )
}
