import { useChatStore } from "@/lib/chat-store"
import { formatProviderActivityLabel } from "@/lib/provider-label"
import { rejectUserInput, respondToUserInput } from "@/services/backend/chatApi"
import {
  buildPendingApprovalsOutput,
  buildUserInputAnswerPayload,
  pendingApprovalsForThread,
} from "./permission-commands"
import { escapeInlineCode, escapeMarkdownTableCell } from "./provider-config"
import {
  buildSessionStatusOutputFromSnapshot,
  deriveChatPendingUserInputs,
  deriveChatTodosFromActivities,
  formatTodoStatus,
  shortApprovalId,
  todoItemsFromStreamingTasks,
  type ChatPendingUserInput,
  type ChatTodoItem,
} from "./session-commands"

export async function buildPendingApprovalsThreadOutput(
  threadId: string | null
): Promise<string> {
  const approvals = await pendingApprovalsForThread(threadId)
  return buildPendingApprovalsOutput(approvals ?? [], {
    hasActiveThread: Boolean(threadId),
  })
}

export function resolvePendingUserInputReference(
  reference: string | undefined,
  inputs: ReadonlyArray<ChatPendingUserInput>
): ChatPendingUserInput | null {
  const value = reference?.trim()
  if (!value) return inputs.length === 1 ? inputs[0]! : null

  const indexValue = value.replace(/^#/, "")
  const index = Number(indexValue)
  if (Number.isInteger(index) && index >= 1 && index <= inputs.length) {
    return inputs[index - 1]!
  }

  const normalized = value.toLowerCase()
  const exact = inputs.find(
    (input) => input.requestId.toLowerCase() === normalized
  )
  if (exact) return exact

  const prefixMatches = inputs.filter((input) =>
    input.requestId.toLowerCase().startsWith(normalized)
  )
  return prefixMatches.length === 1 ? prefixMatches[0]! : null
}

export function buildPendingUserInputsOutput(
  inputs: ReadonlyArray<ChatPendingUserInput>,
  options: { hasActiveThread?: boolean } = {}
): string {
  if (options.hasActiveThread === false) {
    return "# Pending Questions\n\n> No active chat is open."
  }
  if (inputs.length === 0) {
    return "# Pending Questions\n\n> No pending provider questions for this chat."
  }

  return [
    "# Pending Questions\n",
    `${inputs.length} request${inputs.length === 1 ? "" : "s"} waiting for answers.\n`,
    "| # | Provider | Questions | Request ID |",
    "|:--|:---------|:----------|:-----------|",
    ...inputs.map((input, index) => {
      const provider = formatProviderActivityLabel(input, "Provider")
      const questions = input.questions
        .map((question, questionIndex) => {
          const suffix = question.multiSelect ? " (multi)" : ""
          return `${questionIndex + 1}. ${question.text}${suffix}`
        })
        .join("<br>")
      return `| ${index + 1} | ${escapeMarkdownTableCell(provider)} | ${escapeMarkdownTableCell(questions)} | \`${escapeMarkdownTableCell(shortApprovalId(input.requestId))}\` |`
    }),
    "",
    ...inputs.flatMap((input, inputIndex) => [
      `## ${inputIndex + 1}. ${formatProviderActivityLabel(input, "Provider")} \`${input.requestId}\``,
      ...input.questions.map((question) => {
        const optionsText = question.options.length
          ? ` Options: ${question.options
              .map((option) => `\`${escapeInlineCode(option.label)}\``)
              .join(", ")}.`
          : ""
        const multi = question.multiSelect
          ? " Multi-select accepts comma-separated values."
          : ""
        return `- \`${escapeInlineCode(question.id)}\`: ${question.text}.${optionsText}${multi}`
      }),
      "",
    ]),
    "> Reply with `/answer <#|request-id> <answer>` for a single-question request, `/answer <#|request-id> question-id=value other-id=value` for multiple questions, or `/reject-question <#|request-id>` to reject.",
  ].join("\n")
}

export async function buildPendingUserInputsThreadOutput(
  threadId: string | null
): Promise<string> {
  const inputs = await pendingUserInputsForThread(threadId)
  return buildPendingUserInputsOutput(inputs ?? [], {
    hasActiveThread: Boolean(threadId),
  })
}

export async function buildUserInputAnswerOutput(
  threadId: string | null,
  args: ReadonlyArray<string>
): Promise<string> {
  if (!threadId) return "# Answer Question\n\n> No active chat is open."

  const inputs = await pendingUserInputsForThread(threadId)
  const parsed = resolveUserInputAnswerCommand(args, inputs ?? [])
  if (!parsed.input) {
    return [
      "# Answer Question\n",
      "> Could not resolve a pending provider question request.",
      "",
      buildPendingUserInputsOutput(inputs ?? [], { hasActiveThread: true }),
    ].join("\n")
  }
  if (!parsed.answer.ok) {
    return [
      "# Answer Question\n",
      `> ${parsed.answer.error}`,
      "",
      buildPendingUserInputsOutput([parsed.input], { hasActiveThread: true }),
    ].join("\n")
  }

  try {
    const response = await respondToUserInput(
      threadId,
      parsed.input.providerKind,
      parsed.input.requestId,
      parsed.answer.answers,
      parsed.input.providerInstanceId ?? null
    )
    if (response.status === "failed") {
      upsertUserInputFailureActivity(
        threadId,
        parsed.input,
        response.error ?? "Provider user-input response failed"
      )
      return buildUserInputAnswerFailedOutput(parsed.input, response.error)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    upsertUserInputFailureActivity(threadId, parsed.input, detail)
    return buildUserInputAnswerFailedOutput(parsed.input, detail)
  }

  upsertUserInputResolvedActivity(threadId, parsed.input, parsed.answer.answers)
  return [
    "# Answer Submitted\n",
    `- Provider: ${formatProviderActivityLabel(parsed.input, "Provider")}`,
    `- Request: \`${parsed.input.requestId}\``,
    `- Answers: ${formatUserInputAnswerKeys(parsed.answer.answers)}`,
  ].join("\n")
}

export async function buildUserInputRejectOutput(
  threadId: string | null,
  reference: string | undefined
): Promise<string> {
  if (!threadId) return "# Reject Question\n\n> No active chat is open."

  const inputs = await pendingUserInputsForThread(threadId)
  const input = resolvePendingUserInputReference(reference, inputs ?? [])
  if (!input) {
    return [
      "# Reject Question\n",
      "> Could not resolve a pending provider question request.",
      "",
      buildPendingUserInputsOutput(inputs ?? [], { hasActiveThread: true }),
    ].join("\n")
  }

  try {
    const response = await rejectUserInput(
      threadId,
      input.providerKind,
      input.requestId,
      input.providerInstanceId ?? null
    )
    if (response.status === "failed") {
      upsertUserInputFailureActivity(
        threadId,
        input,
        response.error ?? "Provider user-input rejection failed"
      )
      return buildUserInputRejectFailedOutput(input, response.error)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    upsertUserInputFailureActivity(threadId, input, detail)
    return buildUserInputRejectFailedOutput(input, detail)
  }

  upsertUserInputResolvedActivity(threadId, input, {}, "reject")
  return [
    "# Question Rejected\n",
    `- Provider: ${formatProviderActivityLabel(input, "Provider")}`,
    `- Request: \`${input.requestId}\``,
    "- Compatibility reference: `question.reject`",
  ].join("\n")
}

function resolveUserInputAnswerCommand(
  args: ReadonlyArray<string>,
  inputs: ReadonlyArray<ChatPendingUserInput>
): {
  input: ChatPendingUserInput | null
  answer:
    | { ok: true; answers: Record<string, unknown> }
    | { ok: false; error: string }
} {
  const first = args[0]
  const explicit = resolvePendingUserInputReference(first, inputs)
  const useExplicitReference =
    Boolean(explicit) &&
    (inputs.length > 1 || args.length > 1 || first?.startsWith("#"))
  const input = useExplicitReference
    ? explicit
    : resolvePendingUserInputReference(undefined, inputs)
  if (!input) {
    return {
      input: null,
      answer: { ok: false, error: "No pending provider question was found." },
    }
  }
  const answerArgs = useExplicitReference ? args.slice(1) : args
  return { input, answer: buildUserInputAnswerPayload(input, answerArgs) }
}

async function pendingUserInputsForThread(
  threadId: string | null
): Promise<ChatPendingUserInput[] | null> {
  if (!threadId) return null
  const store = useChatStore.getState()
  if (!store.activitiesLoadedByThread[threadId]) {
    await store.hydrateThreadActivities(threadId).catch(() => undefined)
  }
  return deriveChatPendingUserInputs(
    useChatStore.getState().activitiesByThread[threadId] ?? []
  )
}

function upsertUserInputResolvedActivity(
  threadId: string,
  input: ChatPendingUserInput,
  answers: Record<string, unknown>,
  decision: "answer" | "reject" = "answer"
): void {
  useChatStore.getState().upsertThreadActivity(threadId, {
    id: `${threadId}::user-input.resolved::${input.requestId}`,
    threadId,
    kind: "user-input.resolved",
    tone: decision === "reject" ? "error" : "info",
    summary: decision === "reject" ? "Question rejected" : "Question answered",
    payload: {
      requestId: input.requestId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      decision,
      answers,
    },
    sequence: Date.now() * 1000,
    createdAt: new Date().toISOString(),
  })
}

function upsertUserInputFailureActivity(
  threadId: string,
  input: ChatPendingUserInput,
  detail: string
): void {
  useChatStore.getState().upsertThreadActivity(threadId, {
    id: `${threadId}::provider.user-input.respond.failed::${input.requestId}`,
    threadId,
    kind: "provider.user-input.respond.failed",
    tone: "error",
    summary: "Provider user-input response failed",
    payload: {
      requestId: input.requestId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      detail,
    },
    sequence: Date.now() * 1000,
    createdAt: new Date().toISOString(),
  })
}

function buildUserInputAnswerFailedOutput(
  input: ChatPendingUserInput,
  detail: string | undefined
): string {
  return [
    "# Answer Question\n",
    "> Provider did not accept the question response.",
    "",
    `- Provider: ${formatProviderActivityLabel(input, "Provider")}`,
    `- Request: \`${input.requestId}\``,
    `- Error: ${detail ?? "Provider user-input response failed"}`,
  ].join("\n")
}

function buildUserInputRejectFailedOutput(
  input: ChatPendingUserInput,
  detail: string | undefined
): string {
  return [
    "# Reject Question\n",
    "> Provider did not accept the question rejection.",
    "",
    `- Provider: ${formatProviderActivityLabel(input, "Provider")}`,
    `- Request: \`${input.requestId}\``,
    `- Error: ${detail ?? "Provider user-input rejection failed"}`,
  ].join("\n")
}

function formatUserInputAnswerKeys(answers: Record<string, unknown>): string {
  const keys = Object.keys(answers)
  return keys.length > 0 ? keys.map((key) => `\`${key}\``).join(", ") : "-"
}

export function buildThreadTodosOutputFromItems(
  todos: ReadonlyArray<ChatTodoItem>,
  options: { hasActiveThread?: boolean } = {}
): string {
  if (options.hasActiveThread === false) {
    return "# Session Todos\n\n> No active chat is open."
  }
  if (todos.length === 0) {
    return [
      "# Session Todos\n",
      "> No BetterC0de-compatible todo list is available for this chat yet.",
      "",
      "TodoWrite and BetterC0de `todo.updated` events will show up here once a provider emits them.",
    ].join("\n")
  }

  return [
    "# Session Todos\n",
    `${todos.length} item${todos.length === 1 ? "" : "s"} in the latest task list.\n`,
    "| # | Status | Task |",
    "|:--|:-------|:-----|",
    ...todos.map(
      (todo, index) =>
        `| ${index + 1} | ${formatTodoStatus(todo.status)} | ${escapeMarkdownTableCell(todo.text)} |`
    ),
  ].join("\n")
}

export async function buildThreadTodosOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) {
    return buildThreadTodosOutputFromItems([], { hasActiveThread: false })
  }
  const store = useChatStore.getState()
  if (!store.activitiesLoadedByThread[threadId]) {
    await store.hydrateThreadActivities(threadId).catch(() => undefined)
  }
  const streamTodos = todoItemsFromStreamingTasks(
    useChatStore.getState().streamingByThread[threadId]?.streamingTasks
  )
  const todos =
    streamTodos.length > 0
      ? streamTodos
      : deriveChatTodosFromActivities(
          useChatStore.getState().activitiesByThread[threadId] ?? []
        )
  return buildThreadTodosOutputFromItems(todos, { hasActiveThread: true })
}

export async function buildSessionStatusOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) return buildSessionStatusOutputFromSnapshot({ thread: null })

  const store = useChatStore.getState()
  // Status counts every message, not only the pages on screen. It reads no
  // diff text or attachment data, so the rows are enough.
  await store
    .ensureFullThreadMessages(threadId, { payloads: false })
    .catch(() => undefined)
  if (!store.activitiesLoadedByThread[threadId]) {
    await store.hydrateThreadActivities(threadId).catch(() => undefined)
  }

  const current = useChatStore.getState()
  const thread = current.threads.find((item) => item.id === threadId) ?? null
  if (!thread) {
    return [
      "# Session Status\n",
      "Compatibility reference: `session.status`.",
      "",
      `> Active chat \`${escapeInlineCode(threadId)}\` could not be found.`,
    ].join("\n")
  }

  return buildSessionStatusOutputFromSnapshot({
    thread,
    activities: current.activitiesByThread[threadId] ?? [],
    stream: current.streamingByThread[threadId] ?? null,
  })
}
