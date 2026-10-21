import { asRecord, readTrimmed } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import {
  waitForUserInputAnswers,
  type AcpExtensionContext,
  type UserInputQuestion,
} from "../acp/AcpAdapterBase"
import type { AcpPlanUpdate, AcpRuntime } from "../acp/AcpRuntimeBase"

/**
 * Cursor's vendor extensions on top of plain ACP. Cursor asks the user
 * questions (`cursor/ask_question`), hands over a finished plan
 * (`cursor/create_plan`) and streams its todo list (`cursor/update_todos`)
 * through JSON-RPC methods no other ACP agent speaks. Everything here is
 * projected through the adapter's `raw.source: "acp.cursor.extension"` so
 * the journal can tell a vendor event from a protocol one.
 */

export type { UserInputQuestion }
export { waitForUserInputAnswers }

const CURSOR_EXTENSION_SOURCE = "acp.cursor.extension" as const

export function registerCursorExtensions(
  runtime: AcpRuntime,
  ctx: AcpExtensionContext
): void {
  runtime.onExtRequest("cursor/ask_question", async (params) => {
    if (!ctx.isActive()) return { answers: {} }
    ctx.logNative("cursor/ask_question", params, CURSOR_EXTENSION_SOURCE)
    const requestId = randomUUID()
    const questions = extractAskQuestions(params)
    const turnId = ctx.activeTurnId()
    const answersPromise = waitForUserInputAnswers(
      ctx.pendingUserInputs,
      requestId,
      questions
    )
    try {
      ctx.emitEvent({
        ...ctx.eventBase(),
        turnId,
        requestId,
        raw: {
          source: CURSOR_EXTENSION_SOURCE,
          method: "cursor/ask_question",
          payload: params,
        },
        type: "user-input.requested",
        payload: { questions: [...questions] },
      })
    } catch (error) {
      ctx.pendingUserInputs.get(requestId)?.resolve({})
      throw error
    }
    const answers = await answersPromise
    if (!ctx.isActive()) return { answers: {} }
    ctx.emitEvent({
      ...ctx.eventBase(),
      turnId,
      requestId,
      type: "user-input.resolved",
      payload: { answers },
    })
    return { answers }
  })
  runtime.onExtRequest("cursor/create_plan", async (params) => {
    if (!ctx.isActive()) return { accepted: true }
    ctx.logNative("cursor/create_plan", params, CURSOR_EXTENSION_SOURCE)
    ctx.emitEvent({
      ...ctx.eventBase(),
      turnId: ctx.activeTurnId(),
      raw: {
        source: CURSOR_EXTENSION_SOURCE,
        method: "cursor/create_plan",
        payload: params,
      },
      type: "turn.proposed.completed",
      payload: { planMarkdown: extractPlanMarkdown(params) },
    })
    return { accepted: true }
  })
  runtime.onExtNotification("cursor/update_todos", async (params) => {
    if (!ctx.isActive()) return
    ctx.logNative("cursor/update_todos", params, CURSOR_EXTENSION_SOURCE)
    ctx.emitPlanUpdate(
      extractTodosAsPlan(params),
      params,
      CURSOR_EXTENSION_SOURCE,
      "cursor/update_todos"
    )
  })
}

export function extractAskQuestions(params: unknown): UserInputQuestion[] {
  const rawQuestions = asRecord(params).questions
  const questions: unknown[] = Array.isArray(rawQuestions) ? rawQuestions : []
  return questions.map((entry, index) => {
    const question = asRecord(entry)
    const id = readTrimmed(question, "id") ?? `question-${index + 1}`
    const prompt = readTrimmed(question, "prompt") ?? "Continue?"
    const rawOptions = question.options
    const options = Array.isArray(rawOptions)
      ? rawOptions.map((rawOption) => {
          const option = asRecord(rawOption)
          const label = readTrimmed(option, "label") ?? "OK"
          return { label, description: label }
        })
      : [{ label: "OK", description: "Continue" }]
    return {
      id,
      header: "Question",
      question: prompt,
      options,
      ...(question.allowMultiple === true ? { multiSelect: true } : {}),
    }
  })
}

export function extractPlanMarkdown(params: unknown): string {
  return (
    readTrimmed(asRecord(params), "plan") ??
    "# Plan\n\n(Cursor did not supply plan text.)"
  )
}

export function extractTodosAsPlan(params: unknown): AcpPlanUpdate {
  const rawTodos = asRecord(params).todos
  const todos: unknown[] = Array.isArray(rawTodos) ? rawTodos : []
  const plan = todos.flatMap((todo) => {
    const record = asRecord(todo)
    const step = readTrimmed(record, "content") ?? readTrimmed(record, "title")
    if (!step) return []
    return [
      {
        step,
        status:
          record.status === "completed"
            ? "completed"
            : record.status === "in_progress" || record.status === "inProgress"
              ? "inProgress"
              : "pending",
      } as const,
    ]
  })
  return { plan }
}
